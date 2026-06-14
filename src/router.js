import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { debugLogAccess, debugLogError, debugLogRequest, debugLogUpgrade, debugLogUpstream } from "./debug.js";

const execFileAsync = promisify(execFile);
const EMULATED_TOOL_NAMES = new Set(["web_search", "tool_search"]);
const MAX_EMULATED_TOOL_ROUNDS = 4;
const MAX_TOOL_RESULT_CHARS = 6000;
const HYDRA_DDGR_PATH = `${homedir()}/.codex/hydra/bin/ddgr`;

function webSearchCommands() {
  return process.env.HYDRA_WEB_SEARCH_COMMAND
    ? [process.env.HYDRA_WEB_SEARCH_COMMAND]
    : [HYDRA_DDGR_PATH, "ddgr", "search", "duckduckgo"];
}

async function isExecutable(command) {
  const [bin] = String(command ?? "").split(/\s+/).filter(Boolean);
  if (!bin) return false;
  const candidates =
    isAbsolute(bin) || bin.includes("/")
      ? [bin]
      : String(process.env.PATH ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((dir) => join(dir, bin));

  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return true;
    } catch {
      // Try the next candidate.
    }
  }
  return false;
}

export async function emulatedToolStatuses() {
  const commands = webSearchCommands();
  const webSearchReady = (await Promise.all(commands.map((command) => isExecutable(command)))).some(Boolean);
  return [
    {
      name: "web_search",
      status: webSearchReady ? "ready" : "unavailable",
      detail: webSearchReady ? undefined : "no executable search command found",
    },
    { name: "tool_search", status: "ready" },
  ];
}

function jsonResponse(req, res, status, body, debugAuth = false, extra = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
  debugLogAccess({ enabled: debugAuth, req, status, ...extra });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return null;
  const rawBuffer = decodeBody(Buffer.concat(chunks), req.headers["content-encoding"]);
  const raw = rawBuffer.toString("utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    error.message = `${error.message} while parsing ${rawBuffer.length} byte request body`;
    throw error;
  }
}

export function decodeBody(buffer, contentEncoding) {
  const encoding = String(contentEncoding ?? "identity").toLowerCase().trim();
  if (!encoding || encoding === "identity") return buffer;
  if (encoding === "zstd") return zstdDecompressSync(buffer);
  if (encoding === "gzip" || encoding === "x-gzip") return gunzipSync(buffer);
  if (encoding === "deflate") return inflateSync(buffer);
  if (encoding === "br") return brotliDecompressSync(buffer);

  throw new Error(`Unsupported request content-encoding: ${encoding}`);
}

async function loadRoutes(paths) {
  return JSON.parse(await readFile(paths.routesPath, "utf8"));
}

function imageDataFromPart(part) {
  const source =
    part.image_url?.url ??
    part.image_url ??
    part.url ??
    part.data ??
    part.b64_json ??
    part.image_base64 ??
    part.base64;
  if (typeof source !== "string" || !source) {
    throw new Error("Unsupported image input for Ollama: expected a base64 string or data URL image.");
  }
  const dataUrlMatch = source.match(/^data:[^;,]+;base64,(.+)$/i);
  return dataUrlMatch ? dataUrlMatch[1] : source;
}

function isImagePart(part) {
  return (
    part?.type === "input_image" ||
    part?.type === "image" ||
    part?.type === "image_url" ||
    part?.image_url != null ||
    part?.b64_json != null ||
    part?.image_base64 != null
  );
}

export function normalizeResponsesInput(input, { allowImages = false } = {}) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [{ role: "user", content: JSON.stringify(input ?? "") }];

  return input.map((item) => {
    const role = item.role ?? "user";
    if (!Array.isArray(item.content)) return { role, content: String(item.content ?? "") };

    const images = [];
    const content = item.content
      .map((part) => {
        if (isImagePart(part)) {
          if (!allowImages) {
            throw new Error("Ollama model does not advertise vision support for image inputs.");
          }
          images.push(imageDataFromPart(part));
          return "";
        }
        return part.text ?? part.input_text ?? part.output_text ?? "";
      })
      .filter(Boolean)
      .join("\n");
    const message = { role, content: String(content) };
    if (images.length) message.images = images;
    return message;
  });
}

function requestedThinking(body) {
  const effort = body?.reasoning?.effort ?? body?.reasoning_effort ?? body?.reasoning_level;
  return typeof effort === "string" && effort.toLowerCase() !== "none";
}

export function buildOllamaChatBody({ body, route, stream, messages = null }) {
  const capabilities = route.capabilities ?? {};
  const normalizedMessages = messages ?? normalizeResponsesInput(body.input, { allowImages: Boolean(capabilities.vision) });
  const tools = normalizeOllamaTools(body.tools);
  const ollamaBody = {
    model: route.upstreamModel,
    messages: normalizedMessages,
    stream,
    options: {
      temperature: body.temperature,
      top_p: body.top_p,
      num_predict: body.max_output_tokens,
    },
  };
  if (tools.length && capabilities.tools !== false) ollamaBody.tools = tools;
  if (capabilities.thinking && requestedThinking(body)) ollamaBody.think = true;
  return ollamaBody;
}

function sseHeaders(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function responseId() {
  return `resp_hydra_${Date.now().toString(36)}`;
}

function responseEnvelope({ id, model, status = "in_progress", output = [] }) {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
  };
}

function messageItem({ id, status = "in_progress", text }) {
  const item = {
    id: `${id}_msg`,
    type: "message",
    role: "assistant",
    status,
    content: [],
  };
  if (text !== undefined) item.content = [{ type: "output_text", text }];
  return item;
}

function functionCallItem({ id, index, status = "completed", name, argumentsText = "" }) {
  return {
    id: `${id}_fc_${index}`,
    type: "function_call",
    status,
    call_id: `call_${id}_${index}`,
    name,
    arguments: argumentsText,
  };
}

function reasoningItem({ id, status = "in_progress", text }) {
  const item = {
    id: `${id}_rs`,
    type: "reasoning",
    status,
    summary: [],
  };
  if (text !== undefined) item.summary = [{ type: "summary_text", text }];
  return item;
}

export function normalizeOllamaTools(tools) {
  if (!Array.isArray(tools)) return [];
  const normalized = [];
  const names = new Set();

  for (const tool of tools) {
    let candidate = null;
    if (tool?.type === "function") {
      const source = tool.function ?? tool;
      if (!source.name) continue;
      candidate = {
        type: "function",
        function: {
          name: source.name,
          description: source.description ?? "",
          parameters: source.parameters ?? { type: "object", properties: {} },
        },
      };
    } else if (tool?.type === "web_search" || tool?.type === "web_search_preview") {
      candidate = {
        type: "function",
        function: {
          name: "web_search",
          description: "Search the web and return concise text results.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "The web search query." },
              max_results: { type: "integer", description: "Maximum number of results to return." },
            },
            required: ["query"],
          },
        },
      };
    } else if (tool?.type === "tool_search") {
      candidate = {
        type: "function",
        function: {
          name: "tool_search",
          description: "Search the currently available Codex tools by name, type, and description.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "The tool search query." },
              limit: { type: "integer", description: "Maximum number of matching tools to return." },
            },
            required: ["query"],
          },
        },
      };
    }
    if (!candidate || names.has(candidate.function.name)) continue;
    names.add(candidate.function.name);
    normalized.push(candidate);
  }

  return normalized;
}

function normalizeOllamaToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];

  return toolCalls
    .map((toolCall) => {
      const source = toolCall.function ?? toolCall;
      if (!source?.name) return null;
      const args = source.arguments ?? {};
      return {
        name: source.name,
        argumentsText: typeof args === "string" ? args : JSON.stringify(args),
      };
    })
    .filter(Boolean);
}

function parseToolArguments(argumentsText) {
  if (!argumentsText) return {};
  if (typeof argumentsText !== "string") return argumentsText;
  try {
    return JSON.parse(argumentsText);
  } catch {
    return { query: argumentsText };
  }
}

function summarizeToolForSearch(tool) {
  const source = tool?.function ?? tool ?? {};
  return {
    type: tool?.type ?? "unknown",
    name: source.name ?? tool?.name ?? tool?.type ?? "unknown",
    description: source.description ?? tool?.description ?? "",
  };
}

function scoreToolMatch(tool, terms) {
  const haystack = `${tool.type} ${tool.name} ${tool.description}`.toLowerCase();
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function emulateToolSearch({ tools, query, limit = 8 }) {
  const terms = String(query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const summaries = (Array.isArray(tools) ? tools : []).map(summarizeToolForSearch);
  const matches = summaries
    .map((tool) => ({ tool, score: terms.length ? scoreToolMatch(tool, terms) : 1 }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, Math.max(1, Math.min(Number(limit) || 8, 20)))
    .map((entry) => entry.tool);
  return JSON.stringify({ query, tools: matches }, null, 2);
}

async function runSearch({ query, maxResults = 5 }) {
  const commands = webSearchCommands();
  const limitedResults = Math.max(1, Math.min(Number(maxResults) || 5, 10));
  const failures = [];

  for (const command of commands) {
    const [bin, ...prefixArgs] = command.split(/\s+/).filter(Boolean);
    if (!bin) continue;
    const args = [...prefixArgs];
    if (bin.endsWith("ddgr")) args.push("--np", "-n", String(limitedResults));
    args.push(String(query ?? ""));
    try {
      const { stdout, stderr } = await execFileAsync(bin, args, {
        timeout: 15000,
        maxBuffer: 1024 * 512,
      });
      const text = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
      if (text) return text.slice(0, MAX_TOOL_RESULT_CHARS);
    } catch (error) {
      failures.push(`${bin}: ${error.code ?? error.message}`);
    }
  }

  return `Search command failed. Tried: ${commands.join(", ")}. ${failures.join("; ")}`;
}

async function executeEmulatedTool({ name, argumentsText, requestTools }) {
  const args = parseToolArguments(argumentsText);
  if (name === "tool_search") {
    return emulateToolSearch({ tools: requestTools, query: args.query ?? args.q ?? "", limit: args.limit });
  }
  if (name === "web_search") {
    return await runSearch({ query: args.query ?? args.q ?? "", maxResults: args.max_results ?? args.limit });
  }
  return `Unsupported emulated tool: ${name}`;
}

function writeResponseStreamStart(res, { id, model }) {
  writeSse(res, "response.created", { type: "response.created", response: responseEnvelope({ id, model }) });
  writeSse(res, "response.in_progress", {
    type: "response.in_progress",
    response: responseEnvelope({ id, model }),
  });
}

function writeFunctionCall(res, { id, outputIndex, callIndex, name, argumentsText }) {
  const addedItem = functionCallItem({ id, index: callIndex, status: "in_progress", name, argumentsText: "" });
  const doneItem = functionCallItem({ id, index: callIndex, status: "completed", name, argumentsText });
  writeSse(res, "response.output_item.added", {
    type: "response.output_item.added",
    output_index: outputIndex,
    item: addedItem,
  });
  writeSse(res, "response.function_call_arguments.delta", {
    type: "response.function_call_arguments.delta",
    item_id: addedItem.id,
    output_index: outputIndex,
    delta: argumentsText,
  });
  writeSse(res, "response.function_call_arguments.done", {
    type: "response.function_call_arguments.done",
    item_id: addedItem.id,
    output_index: outputIndex,
    arguments: argumentsText,
  });
  writeSse(res, "response.output_item.done", {
    type: "response.output_item.done",
    output_index: outputIndex,
    item: doneItem,
  });
}

function writeReasoningStart(res, { id, outputIndex }) {
  const item = reasoningItem({ id });
  writeSse(res, "response.output_item.added", {
    type: "response.output_item.added",
    output_index: outputIndex,
    item,
  });
  writeSse(res, "response.reasoning_summary_part.added", {
    type: "response.reasoning_summary_part.added",
    item_id: item.id,
    output_index: outputIndex,
    summary_index: 0,
    part: { type: "summary_text", text: "" },
  });
}

function writeReasoningDelta(res, { id, outputIndex, delta }) {
  writeSse(res, "response.reasoning_summary_text.delta", {
    type: "response.reasoning_summary_text.delta",
    item_id: `${id}_rs`,
    output_index: outputIndex,
    summary_index: 0,
    delta,
  });
}

function writeReasoningDone(res, { id, outputIndex, text }) {
  const item = reasoningItem({ id, status: "completed", text });
  writeSse(res, "response.reasoning_summary_text.done", {
    type: "response.reasoning_summary_text.done",
    item_id: item.id,
    output_index: outputIndex,
    summary_index: 0,
    text,
  });
  writeSse(res, "response.reasoning_summary_part.done", {
    type: "response.reasoning_summary_part.done",
    item_id: item.id,
    output_index: outputIndex,
    summary_index: 0,
    part: { type: "summary_text", text },
  });
  writeSse(res, "response.output_item.done", {
    type: "response.output_item.done",
    output_index: outputIndex,
    item,
  });
}

function writeMessageStart(res, { id, outputIndex }) {
  const item = messageItem({ id });
  writeSse(res, "response.output_item.added", {
    type: "response.output_item.added",
    output_index: outputIndex,
    item,
  });
  writeSse(res, "response.content_part.added", {
    type: "response.content_part.added",
    item_id: item.id,
    output_index: outputIndex,
    content_index: 0,
    part: { type: "output_text", text: "" },
  });
}

function writeMessageDone(res, { id, outputIndex, text }) {
  const item = messageItem({ id, status: "completed", text });
  writeSse(res, "response.output_text.done", {
    type: "response.output_text.done",
    item_id: item.id,
    output_index: outputIndex,
    content_index: 0,
    text,
  });
  writeSse(res, "response.content_part.done", {
    type: "response.content_part.done",
    item_id: item.id,
    output_index: outputIndex,
    content_index: 0,
    part: { type: "output_text", text },
  });
  writeSse(res, "response.output_item.done", {
    type: "response.output_item.done",
    output_index: outputIndex,
    item,
  });
}

function writeResponseStreamDone(res, { id, model, output }) {
  writeSse(res, "response.completed", {
    type: "response.completed",
    response: responseEnvelope({ id, model, status: "completed", output }),
  });
}

async function callOllama({ req, body, route, ollamaBaseUrl, res, debugAuth }) {
  const stream = body.stream !== false;
  const id = responseId();
  const url = new URL("/api/chat", ollamaBaseUrl);
  let messages;
  try {
    messages = normalizeResponsesInput(body.input, { allowImages: Boolean(route.capabilities?.vision) });
  } catch (error) {
    if (error.message.startsWith("Unsupported image input") || error.message.startsWith("Ollama model does not")) {
      jsonResponse(req, res, 400, { error: { message: error.message } }, debugAuth, { route });
      return;
    }
    throw error;
  }

  async function fetchOllama({ stream }) {
    const ollamaBody = buildOllamaChatBody({ body, route, stream, messages });

    debugLogUpstream({
      enabled: debugAuth,
      req,
      route,
      upstream: {
        provider: "ollama",
        url: url.toString(),
        requestBytes: Buffer.byteLength(JSON.stringify(ollamaBody)),
        stream,
        toolCount: Array.isArray(ollamaBody.tools) ? ollamaBody.tools.length : 0,
        images: ollamaBody.messages.reduce((count, message) => count + (message.images?.length ?? 0), 0),
        think: Boolean(ollamaBody.think),
      },
      stage: "request",
    });

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ollamaBody),
    });
    debugLogUpstream({
      enabled: debugAuth,
      req,
      route,
      upstream: {
        provider: "ollama",
        url: url.toString(),
        status: response.status,
        contentType: response.headers.get("content-type"),
      },
      stage: "response",
    });
    return response;
  }

  let response;
  try {
    response = await fetchOllama({ stream });
  } catch (error) {
    if (error.message.startsWith("Unsupported image input") || error.message.startsWith("Ollama model does not")) {
      jsonResponse(req, res, 400, { error: { message: error.message } }, debugAuth, { route });
      return;
    }
    throw error;
  }

  if (!response.ok) {
    const text = await response.text();
    jsonResponse(
      req,
      res,
      response.status,
      { error: { message: text || response.statusText } },
      debugAuth,
      { route, upstream: { provider: "ollama", status: response.status } },
    );
    return;
  }

  if (!stream) {
    const data = await response.json();
    const thinking = data.message?.thinking ?? "";
    const content = data.message?.content ?? "";
    const toolCalls = normalizeOllamaToolCalls(data.message?.tool_calls);
    const output = [];
    if (thinking) output.push(reasoningItem({ id, status: "completed", text: thinking }));
    if (content || !toolCalls.length) output.push(messageItem({ id, status: "completed", text: content }));
    toolCalls.forEach((toolCall, index) => {
      output.push(functionCallItem({ id, index, ...toolCall }));
    });
    jsonResponse(
      req,
      res,
      200,
      {
        ...responseEnvelope({ id, model: body.model, status: "completed", output }),
        usage: {
          input_tokens: data.prompt_eval_count ?? 0,
          output_tokens: data.eval_count ?? 0,
          total_tokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
        },
      },
      debugAuth,
      { route, upstream: { provider: "ollama", status: response.status } },
    );
    return;
  }

  sseHeaders(res);
  writeResponseStreamStart(res, { id, model: body.model });
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let contentDeltas = 0;
  let thinkingDeltas = 0;
  let thinkingChars = 0;
  let contentChars = 0;
  let emittedThinking = false;
  let emittedContent = false;
  let completedThinking = false;
  let totalToolCalls = 0;
  let emulatedToolCalls = 0;
  let doneReason;
  let rounds = 0;
  let completedResponse = false;

  while (rounds < MAX_EMULATED_TOOL_ROUNDS) {
    rounds += 1;
    const turnToolCalls = [];
    let turnContent = "";
    buffer = "";

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        const thinking = event.message?.thinking ?? "";
        const content = event.message?.content ?? "";
        turnToolCalls.push(...normalizeOllamaToolCalls(event.message?.tool_calls));
        if (thinking) {
          if (!emittedThinking) writeReasoningStart(res, { id, outputIndex: 0 });
          writeReasoningDelta(res, { id, outputIndex: 0, delta: thinking });
          fullText += thinking;
          thinkingDeltas += 1;
          thinkingChars += thinking.length;
          emittedThinking = true;
        }
        if (content) {
          if (emittedThinking && !completedThinking) {
            writeReasoningDone(res, { id, outputIndex: 0, text: fullText });
            completedThinking = true;
          }
          if (!emittedContent) writeMessageStart(res, { id, outputIndex: emittedThinking ? 1 : 0 });
          writeSse(res, "response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: `${id}_msg`,
            output_index: emittedThinking ? 1 : 0,
            content_index: 0,
            delta: content,
          });
          fullText += content;
          turnContent += content;
          contentDeltas += 1;
          contentChars += content.length;
          emittedContent = true;
        }
        if (event.done) {
          doneReason = event.done_reason;
        }
      }
    }

    totalToolCalls += turnToolCalls.length;
    const emulatedCalls = turnToolCalls.filter((toolCall) => EMULATED_TOOL_NAMES.has(toolCall.name));
    const externalCalls = turnToolCalls.filter((toolCall) => !EMULATED_TOOL_NAMES.has(toolCall.name));
    if (emulatedCalls.length && !externalCalls.length) {
      emulatedToolCalls += emulatedCalls.length;
      messages.push({
        role: "assistant",
        content: turnContent,
        tool_calls: emulatedCalls.map((toolCall) => ({
          function: {
            name: toolCall.name,
            arguments: parseToolArguments(toolCall.argumentsText),
          },
        })),
      });
      messages.push(
        ...(
          await Promise.all(
            emulatedCalls.map(async (toolCall) => ({
              role: "tool",
              content: (
                await executeEmulatedTool({
                  name: toolCall.name,
                  argumentsText: toolCall.argumentsText,
                  requestTools: body.tools,
                })
              ).slice(0, MAX_TOOL_RESULT_CHARS),
            })),
          )
        ),
      );
      response = await fetchOllama({ stream: true });
      if (!response.ok) {
        const text = await response.text();
        writeMessageStart(res, { id, outputIndex: emittedThinking ? 1 : 0 });
        writeSse(res, "response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: `${id}_msg`,
          output_index: emittedThinking ? 1 : 0,
          content_index: 0,
          delta: text || response.statusText,
        });
        fullText += text || response.statusText;
        contentChars += (text || response.statusText).length;
        emittedContent = true;
        break;
      }
      continue;
    }

    if (emittedThinking && !completedThinking) {
      writeReasoningDone(res, { id, outputIndex: 0, text: fullText });
      completedThinking = true;
    }
    const output = [];
    if (emittedThinking) output.push(reasoningItem({ id, status: "completed", text: fullText.slice(0, thinkingChars) }));
    if (emittedContent || !turnToolCalls.length) {
      const messageIndex = emittedThinking ? 1 : 0;
      if (!emittedContent) writeMessageStart(res, { id, outputIndex: messageIndex });
      writeMessageDone(res, {
        id,
        outputIndex: messageIndex,
        text: contentChars ? fullText.slice(thinkingChars) : "",
      });
      output.push(messageItem({ id, status: "completed", text: contentChars ? fullText.slice(thinkingChars) : "" }));
    }
    let outputIndex = output.length;
    externalCalls.forEach((toolCall, index) => {
      writeFunctionCall(res, { id, outputIndex, callIndex: index, ...toolCall });
      output.push(functionCallItem({ id, index, ...toolCall }));
      outputIndex += 1;
    });
    writeResponseStreamDone(res, { id, model: body.model, output });
    completedResponse = true;
    break;
  }
  if (!completedResponse) {
    if (emittedThinking && !completedThinking) {
      writeReasoningDone(res, { id, outputIndex: 0, text: fullText });
      completedThinking = true;
    }
    const messageIndex = emittedThinking ? 1 : 0;
    if (!emittedContent) {
      writeMessageStart(res, { id, outputIndex: messageIndex });
      const fallbackMessage = "Stopped after repeated emulated tool calls without a final answer.";
      writeSse(res, "response.output_text.delta", {
        type: "response.output_text.delta",
        item_id: `${id}_msg`,
        output_index: messageIndex,
        content_index: 0,
        delta: fallbackMessage,
      });
      fullText += fallbackMessage;
      contentChars += fallbackMessage.length;
      emittedContent = true;
    }
    const answerText = contentChars ? fullText.slice(thinkingChars) : "";
    writeMessageDone(res, { id, outputIndex: messageIndex, text: answerText });
    const output = [];
    if (emittedThinking) output.push(reasoningItem({ id, status: "completed", text: fullText.slice(0, thinkingChars) }));
    output.push(messageItem({ id, status: "completed", text: answerText }));
    writeResponseStreamDone(res, { id, model: body.model, output });
  }
  res.write("data: [DONE]\n\n");
  res.end();
  debugLogAccess({
    enabled: debugAuth,
    req,
    status: 200,
    route,
    upstream: {
      provider: "ollama",
      status: response.status,
      stream: true,
      contentDeltas,
      thinkingDeltas,
      thinkingChars,
      contentChars,
      outputChars: fullText.length,
      toolCalls: totalToolCalls,
      emulatedToolCalls,
      doneReason,
    },
  });
}

async function forwardOpenAI({ req, body, openaiBaseUrl, apiKey, res, route, debugAuth }) {
  const url = upstreamResponsesUrl(req.url, openaiBaseUrl);
  const headers = forwardedHeaders(req.headers);
  headers["content-type"] = "application/json";
  headers.accept = req.headers.accept ?? "application/json";
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  else if (req.headers.authorization) headers.authorization = req.headers.authorization;

  const upstreamBody = JSON.stringify({ ...body, model: route.upstreamModel });
  debugLogUpstream({
    enabled: debugAuth,
    req,
    route,
    upstream: { provider: "openai", url: url.toString(), requestBytes: Buffer.byteLength(upstreamBody) },
    stage: "request",
  });

  let upstream;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers,
      body: upstreamBody,
      signal: controller.signal,
    });
  } catch (error) {
    debugLogError({ enabled: debugAuth, req, error, stage: "openai_fetch" });
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const upstreamHeaders = Object.fromEntries(upstream.headers.entries());
  debugLogUpstream({
    enabled: debugAuth,
    req,
    route,
    upstream: {
      provider: "openai",
      url: url.toString(),
      status: upstream.status,
      contentType: upstreamHeaders["content-type"],
    },
    stage: "response",
  });

  const responseHeaders = { ...upstreamHeaders };
  delete responseHeaders["content-encoding"];
  delete responseHeaders["content-length"];
  delete responseHeaders["transfer-encoding"];
  res.writeHead(upstream.status, responseHeaders);
  try {
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        if (!res.write(chunk)) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
    }
    res.end();
  } catch (error) {
    debugLogError({ enabled: debugAuth, req, error, stage: "openai_stream" });
    if (!res.destroyed) res.destroy(error);
    return;
  }

  debugLogAccess({
    enabled: debugAuth,
    req,
    status: upstream.status,
    route,
    upstream: { provider: "openai", url: url.toString(), status: upstream.status },
  });
}

function forwardedHeaders(sourceHeaders) {
  const headers = {};
  for (const [key, value] of Object.entries(sourceHeaders)) {
    const normalized = key.toLowerCase();
    if (
      normalized === "host" ||
      normalized === "connection" ||
      normalized === "content-length" ||
      normalized === "content-encoding" ||
      normalized === "transfer-encoding" ||
      normalized === "upgrade" ||
      normalized.startsWith("sec-websocket-")
    ) {
      continue;
    }
    if (value == null) continue;
    headers[key] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return headers;
}

export function upstreamResponsesUrl(requestPath, openaiBaseUrl) {
  const base = new URL(openaiBaseUrl);
  const basePath = base.pathname.replace(/\/+$/g, "");
  const requestSuffix = requestPath === "/v1/responses" ? "/responses" : requestPath;
  base.pathname = `${basePath}${requestSuffix}`;
  base.search = "";
  return base;
}

export function createHydraHandler({ paths, ollamaBaseUrl, openaiBaseUrl, apiKey, debugAuth = false }) {
  async function hydraHandler(req, res) {
    try {
      if (req.method === "GET" && req.url === "/healthz") {
        jsonResponse(req, res, 200, { ok: true }, debugAuth);
        return;
      }

      if (req.method === "GET" && req.url === "/v1/models") {
        const routes = await loadRoutes(paths);
        jsonResponse(
          req,
          res,
          200,
          {
            object: "list",
            data: Object.keys(routes).map((id) => ({ id, object: "model", owned_by: routes[id].provider })),
          },
          debugAuth,
        );
        return;
      }

      if (req.method !== "POST" || !["/responses", "/v1/responses"].includes(req.url)) {
        jsonResponse(req, res, 404, { error: { message: "Not found" } }, debugAuth);
        return;
      }

      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        debugLogError({ enabled: debugAuth, req, error, stage: "read_body" });
        throw error;
      }
      const routes = await loadRoutes(paths);
      const route = routes[body?.model];
      debugLogRequest({ enabled: debugAuth, req, body, route });
      if (!route) {
        jsonResponse(
          req,
          res,
          400,
          { error: { message: `Unknown model: ${body?.model ?? "<missing>"}` } },
          debugAuth,
        );
        return;
      }

      if (route.provider === "ollama") {
        await callOllama({ req, body, route, ollamaBaseUrl, res, debugAuth });
        return;
      }

      await forwardOpenAI({ req, body, openaiBaseUrl, apiKey, res, route, debugAuth });
    } catch (error) {
      debugLogError({ enabled: debugAuth, req, error, stage: "handler" });
      jsonResponse(req, res, 500, { error: { message: error.message } }, debugAuth);
    }
  }

  hydraHandler.handleUpgrade = (req, socket) => {
    debugLogUpgrade({ enabled: debugAuth, req });
    socket.write("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n");
    socket.destroy();
  };

  return hydraHandler;
}
