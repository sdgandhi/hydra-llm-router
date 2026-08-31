import { randomUUID } from "node:crypto";

const INJECTED_EVENT_COUNT = 6;

function sseEvent(type, data) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function commentaryItems(id, text) {
  const common = {
    id,
    type: "message",
    role: "assistant",
    agent: { agent_name: "hydra-router" },
    phase: "commentary",
  };
  return {
    added: { ...common, status: "in_progress", content: [] },
    completed: {
      ...common,
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    },
  };
}

function prependCommentary(response, item) {
  if (!response || typeof response !== "object" || !Array.isArray(response.output)) return false;
  response.output.unshift(item);
  return true;
}

function ssePayload(block) {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function isFirstOutputEvent(type) {
  return typeof type === "string" && (
    type.startsWith("response.output_") ||
    type.startsWith("response.content_part.") ||
    type.startsWith("response.reasoning_") ||
    type.startsWith("response.function_call_") ||
    type.startsWith("response.custom_tool_call_")
  );
}

export class ResponsesCommentaryTransform {
  constructor(text) {
    this.text = text;
    this.mode = "passthrough";
    this.decoder = new TextDecoder();
    this.buffer = "";
    this.injected = false;
    this.lastSequenceNumber = null;
    this.items = commentaryItems(`msg_hydra_route_${randomUUID().replaceAll("-", "")}`, text);
  }

  headers(headers) {
    const next = { ...headers };
    const contentType = String(next["content-type"] ?? next["Content-Type"] ?? "").toLowerCase();
    if (contentType.includes("text/event-stream")) this.mode = "sse";
    else if (contentType.includes("application/json")) this.mode = "json";
    if (this.mode !== "passthrough") {
      delete next["content-length"];
      delete next["Content-Length"];
    }
    return next;
  }

  injectedEvents() {
    const { added, completed } = this.items;
    const content = completed.content[0];
    let sequenceNumber = Number.isInteger(this.lastSequenceNumber) ? this.lastSequenceNumber : null;
    const event = (type, data) => {
      if (sequenceNumber != null) data.sequence_number = ++sequenceNumber;
      return sseEvent(type, data);
    };
    this.injected = true;
    return [
      event("response.output_item.added", {
        type: "response.output_item.added",
        output_index: 0,
        item: added,
      }),
      event("response.content_part.added", {
        type: "response.content_part.added",
        item_id: completed.id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      }),
      event("response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: completed.id,
        output_index: 0,
        content_index: 0,
        delta: this.text,
      }),
      event("response.output_text.done", {
        type: "response.output_text.done",
        item_id: completed.id,
        output_index: 0,
        content_index: 0,
        text: this.text,
      }),
      event("response.content_part.done", {
        type: "response.content_part.done",
        item_id: completed.id,
        output_index: 0,
        content_index: 0,
        part: content,
      }),
      event("response.output_item.done", {
        type: "response.output_item.done",
        output_index: 0,
        item: completed,
      }),
    ].join("");
  }

  transformEvent(event) {
    if (!event || typeof event !== "object") return event;
    if (this.injected) {
      if (Number.isInteger(event.output_index)) event.output_index += 1;
      if (Number.isInteger(event.sequence_number)) event.sequence_number += INJECTED_EVENT_COUNT;
    }
    if (event.type === "response.completed") prependCommentary(event.response, this.items.completed);
    if (Number.isInteger(event.sequence_number)) this.lastSequenceNumber = event.sequence_number;
    return event;
  }

  processSseBlock(block, delimiter) {
    const event = ssePayload(block);
    if (!event) return `${block}${delimiter}`;

    if (Number.isInteger(event.sequence_number)) this.lastSequenceNumber = event.sequence_number;
    if (!this.injected && event.type === "response.in_progress") {
      return `${block}${delimiter}${this.injectedEvents()}`;
    }
    if (!this.injected && (isFirstOutputEvent(event.type) || event.type === "response.completed")) {
      if (Number.isInteger(event.sequence_number)) this.lastSequenceNumber = event.sequence_number - 1;
      const injected = this.injectedEvents();
      return `${injected}${sseEvent(event.type, this.transformEvent(event))}`;
    }
    if (!this.injected) return `${block}${delimiter}`;
    return sseEvent(event.type, this.transformEvent(event));
  }

  write(chunk) {
    if (this.mode === "passthrough") return [chunk];
    this.buffer += this.decoder.decode(chunk, { stream: true });
    if (this.mode === "json") return [];

    const output = [];
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) break;
      const block = this.buffer.slice(0, match.index);
      const delimiter = match[0];
      this.buffer = this.buffer.slice(match.index + delimiter.length);
      output.push(this.processSseBlock(block, delimiter));
    }
    return output;
  }

  end() {
    if (this.mode === "passthrough") return [];
    this.buffer += this.decoder.decode();
    if (this.mode === "json") {
      const raw = this.buffer;
      this.buffer = "";
      try {
        const response = JSON.parse(raw);
        prependCommentary(response, this.items.completed);
        return [JSON.stringify(response)];
      } catch {
        return [raw];
      }
    }
    const tail = this.buffer;
    this.buffer = "";
    return tail ? [tail] : [];
  }
}
