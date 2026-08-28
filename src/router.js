import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { appToolSourceFromOllamaTool } from "./app-server.js";
import {
  debugLogAccess,
  debugLogCancellation,
  debugLogError,
  debugLogRequest,
  debugLogUpgrade,
  debugLogUpstream,
  debugLogSynthetic,
} from "./debug.js";
import { ResponseGate } from "./response-gate.js";
import {
  buildSelectorContext,
  runSyntheticSelector,
  selectorFeatures,
  validateSelectorTarget,
} from "./synthetic.js";

const execFileAsync = promisify(execFile);
const EMULATED_TOOL_NAMES = new Set(["web_search", "tool_search"]);
const MAX_EMULATED_TOOL_ROUNDS = 4;
const MAX_TOOL_RESULT_CHARS = 6000;
async function isExecutable(command) {
  const [bin] = Array.isArray(command) ? command : [];
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

export async function emulatedToolStatuses(commands = []) {
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

function responsesStateReference(body) {
  const previousResponseId = body?.previous_response_id;
  const conversation = body?.conversation;
  const conversationId = typeof conversation === "string" ? conversation : conversation?.id;
  if (previousResponseId != null) return { field: "previous_response_id", id: previousResponseId };
  if (conversation != null) return { field: "conversation", id: conversationId };
  return null;
}

function stateReferenceError(message, field) {
  return {
    error: {
      message,
      type: "invalid_request_error",
      code: "unsupported_state_reference",
      param: field,
    },
  };
}

function responseMetadataCapture() {
  let prefix = "";
  let responseId;
  let conversationId;
  return {
    push(chunk) {
      if (responseId && conversationId) return;
      prefix += Buffer.from(chunk).toString("utf8");
      responseId ??= prefix.match(/"id"\s*:\s*"(resp_[^"]+)"/)?.[1];
      conversationId ??= prefix.match(/"conversation"\s*:\s*\{[^}]*"id"\s*:\s*"([^"]+)"/)?.[1];
      if (prefix.length > 65_536) prefix = prefix.slice(-4_096);
    },
    result() {
      return { responseId, conversationId };
    },
  };
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
    if (item?.type === "function_call" || item?.type === "custom_tool_call") {
      const argumentsText = item.type === "custom_tool_call"
        ? JSON.stringify({ input: item.input ?? "" })
        : item.arguments ?? "{}";
      return {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: item.call_id,
            function: { name: item.name, arguments: parseToolArguments(argumentsText) },
          },
        ],
      };
    }
    if (item?.type === "function_call_output" || item?.type === "custom_tool_call_output") {
      return {
        role: "tool",
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      };
    }
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

export function normalizeLMStudioInput(input, { allowImages = false } = {}) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [{ role: "user", content: JSON.stringify(input ?? "") }];

  return input.map((item) => {
    if (item?.type === "function_call" || item?.type === "custom_tool_call") {
      const argumentsText = item.type === "custom_tool_call"
        ? JSON.stringify({ input: item.input ?? "" })
        : item.arguments ?? "{}";
      return {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: item.call_id,
            type: "function",
            function: { name: item.name, arguments: argumentsText },
          },
        ],
      };
    }
    if (item?.type === "function_call_output" || item?.type === "custom_tool_call_output") {
      return {
        role: "tool",
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      };
    }
    const role = item.role ?? "user";
    if (!Array.isArray(item.content)) return { role, content: String(item.content ?? "") };
    const content = item.content.map((part) => {
      if (!isImagePart(part)) {
        return { type: "text", text: part.text ?? part.input_text ?? part.output_text ?? "" };
      }
      if (!allowImages) throw new Error("LM Studio model does not advertise vision support for image inputs.");
      const source = part.image_url?.url ?? part.image_url ?? part.url ?? part.data;
      if (typeof source !== "string" || !source) {
        throw new Error("Unsupported image input for LM Studio: expected an image URL or data URL.");
      }
      return { type: "image_url", image_url: { url: source } };
    });
    return { role, content };
  });
}

export function normalizedReasoningEffort(body) {
  const effort = body?.reasoning?.effort ?? body?.reasoning_effort ?? body?.reasoning_level;
  return typeof effort === "string" ? effort.trim().toLowerCase() : undefined;
}

function requestedThinking(body) {
  const effort = normalizedReasoningEffort(body);
  return effort !== undefined && effort !== "none";
}

function requestedNoTools(body) {
  return body?.tool_choice === "none" || body?.tool_choice?.type === "none";
}

const LOCAL_CONTROL_MARKERS = ["analysis", "commentary", "final", "thought"]
  .flatMap((channel) => [
    `<|channel>${channel}\r\n<channel|>`,
    `<|channel>${channel}\n<channel|>`,
    `<|channel>${channel}<channel|>`,
    `<|channel|>${channel}<|message|>`,
    `<|channel>${channel}<|message|>`,
  ])
  .concat(["<|channel|>", "<|channel>", "<channel|>", "<|message|>"])
  .sort((left, right) => right.length - left.length);

export function createLocalControlMarkerFilter() {
  let pending = "";

  const drain = (final) => {
    let output = "";
    while (pending) {
      const marker = LOCAL_CONTROL_MARKERS.find((candidate) => pending.startsWith(candidate));
      if (marker) {
        if (!final && LOCAL_CONTROL_MARKERS.some(
          (candidate) => candidate.length > pending.length && candidate.startsWith(pending),
        )) break;
        pending = pending.slice(marker.length);
        continue;
      }
      if (!final && LOCAL_CONTROL_MARKERS.some((candidate) => candidate.startsWith(pending))) break;
      output += pending[0];
      pending = pending.slice(1);
    }
    return output;
  };

  return {
    push(text) {
      pending += String(text ?? "");
      return drain(false);
    },
    finish() {
      return drain(true);
    },
  };
}

export function stripLocalControlMarkers(text) {
  const filter = createLocalControlMarkerFilter();
  return filter.push(text) + filter.finish();
}

function currentCollaborationMode(body) {
  const texts = [];
  if (typeof body?.instructions === "string") texts.push(body.instructions);
  for (const item of Array.isArray(body?.input) ? body.input : []) {
    if (typeof item?.content === "string") texts.push(item.content);
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      const text = part?.text ?? part?.input_text ?? part?.output_text;
      if (typeof text === "string") texts.push(text);
    }
  }

  let mode;
  const pattern = /<collaboration_mode>\s*# Collaboration Mode:\s*(Default|Plan)\b/gi;
  for (const text of texts) {
    for (const match of text.matchAll(pattern)) mode = match[1].toLowerCase();
  }
  return mode;
}

function localModelTools(body) {
  if (!Array.isArray(body?.tools)) return [];
  // Codex only has an executor for request_user_input while Plan mode is active.
  // Some harness clients omit the collaboration-mode block entirely, so treat
  // Plan as the opt-in case instead of assuming an unknown mode is safe.
  if (currentCollaborationMode(body) === "plan") return body.tools;
  return body.tools.filter((tool) => (tool?.function?.name ?? tool?.name) !== "request_user_input");
}

function lmStudioTools(body) {
  return localModelTools(body).filter((tool) => (
    tool?.type !== "web_search"
    && tool?.type !== "web_search_preview"
    && tool?.type !== "tool_search"
  ));
}

export function buildOllamaChatBody({ body, route, stream, messages = null, tools = null, appTools = [] }) {
  const capabilities = route.capabilities ?? {};
  const normalizedMessages = messages ?? normalizeResponsesInput(body.input, { allowImages: Boolean(capabilities.vision) });
  const normalizedTools = tools ?? mergeOllamaTools(normalizeOllamaTools(localModelTools(body)), appTools);
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
  if (normalizedTools.length && capabilities.tools !== false && !requestedNoTools(body)) ollamaBody.tools = normalizedTools;
  if (capabilities.thinking && requestedThinking(body)) ollamaBody.think = true;
  return ollamaBody;
}

export function buildLMStudioChatBody({ body, route, stream, messages = null, tools = null }) {
  const capabilities = route.capabilities ?? {};
  const normalizedTools = tools ?? normalizeOllamaTools(lmStudioTools(body));
  const normalizedMessages = messages ?? normalizeLMStudioInput(body.input, { allowImages: Boolean(capabilities.vision) });
  if (messages == null && body.instructions) normalizedMessages.unshift({ role: "system", content: String(body.instructions) });
  const lmStudioBody = {
    model: route.upstreamModel,
    messages: normalizedMessages,
    stream,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_output_tokens,
  };
  const reasoningEffort = normalizedReasoningEffort(body);
  if (reasoningEffort === "none" || reasoningEffort === "low") {
    lmStudioBody.chat_template_kwargs = { enable_thinking: false };
    lmStudioBody.reasoning_effort = "none";
  } else if (reasoningEffort !== undefined && capabilities.thinking) {
    lmStudioBody.chat_template_kwargs = { enable_thinking: true };
    lmStudioBody.reasoning_effort = reasoningEffort;
  }
  if (normalizedTools.length && capabilities.tools !== false && !requestedNoTools(body)) {
    lmStudioBody.tools = normalizedTools;
    if (body.tool_choice != null) {
      lmStudioBody.tool_choice =
        body.tool_choice?.type === "function" && body.tool_choice.name
          ? { type: "function", function: { name: body.tool_choice.name } }
          : body.tool_choice;
    }
  }
  return lmStudioBody;
}

function mergeOllamaTools(...toolLists) {
  const result = [];
  const names = new Set();
  for (const tools of toolLists) {
    for (const tool of tools ?? []) {
      const name = tool?.function?.name;
      if (!name || names.has(name)) continue;
      names.add(name);
      result.push(tool);
    }
  }
  return result;
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

function waitForDrain(res, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off("drain", onDrain);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    res.once("drain", onDrain);
    signal.addEventListener("abort", onAbort, { once: true });
  });
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

function execToolInput(parsed) {
  const args = parsed?.namespace === "functions.exec" && parsed.args && typeof parsed.args === "object"
    ? parsed.args
    : parsed;
  if (!args || typeof args !== "object" || typeof args.cmd !== "string") return null;
  return `const r = await tools.exec_command(${JSON.stringify(args)}); text(r.output);`;
}

function customToolInput(argumentsText, name) {
  const parsed = parseToolArguments(argumentsText);
  if (typeof parsed?.input === "string") return parsed.input;
  if (name === "exec") {
    const input = execToolInput(parsed);
    if (input) return input;
  }
  return String(argumentsText ?? "");
}

function customToolCallItem({ id, index, status = "completed", name, argumentsText = "" }) {
  return {
    id: `${id}_ctc_${index}`,
    type: "custom_tool_call",
    status,
    call_id: `call_${id}_${index}`,
    name,
    input: customToolInput(argumentsText, name),
  };
}

function responseToolCallItem({ id, index, responseToolType = "function", ...toolCall }) {
  return responseToolType === "custom"
    ? customToolCallItem({ id, index, ...toolCall })
    : functionCallItem({ id, index, ...toolCall });
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
  const queue = [...tools];

  while (queue.length) {
    const tool = queue.shift();
    if (tool?.type === "namespace") {
      const nested = Array.isArray(tool.tools)
        ? tool.tools
        : Array.isArray(tool.functions)
          ? tool.functions
          : tool.tools && typeof tool.tools === "object"
            ? Object.values(tool.tools)
            : tool.functions && typeof tool.functions === "object"
              ? Object.values(tool.functions)
              : [];
      queue.unshift(
        ...nested.map((candidate) => (
          candidate?.type ? candidate : { ...candidate, type: "function" }
        )),
      );
      continue;
    }
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
    } else if (tool?.type === "custom" && tool.name) {
      candidate = {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description ?? "",
          parameters: {
            type: "object",
            properties: {
              input: { type: "string", description: "Free-form input for this tool." },
            },
            required: ["input"],
          },
        },
        _hydraResponseTool: { type: "custom" },
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
      const normalized = {
        name: source.name,
        argumentsText: typeof args === "string" ? args : JSON.stringify(args),
      };
      if (toolCall.id) normalized.callId = toolCall.id;
      return normalized;
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

function matchingToolsForSearch({ tools, query, limit = 8 }) {
  const terms = String(query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const summaries = (Array.isArray(tools) ? tools : []).map(summarizeToolForSearch);
  return summaries
    .map((tool) => ({ tool, score: terms.length ? scoreToolMatch(tool, terms) : 1 }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, Math.max(1, Math.min(Number(limit) || 8, 20)))
    .map((entry) => entry.tool);
}

function emulateToolSearch({ tools, query, limit = 8 }) {
  const matches = matchingToolsForSearch({ tools, query, limit });
  return JSON.stringify({ query, tools: matches }, null, 2);
}

async function runSearch({ query, maxResults = 5, webSearchCommands = [] }) {
  const commands = webSearchCommands;
  const limitedResults = Math.max(1, Math.min(Number(maxResults) || 5, 10));
  const failures = [];

  for (const command of commands) {
    const [bin, ...prefixArgs] = command;
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

  return `Search command failed. Tried: ${commands.map((command) => command.join(" ")).join(", ")}. ${failures.join("; ")}`;
}

async function executeEmulatedTool({ name, argumentsText, requestTools, webSearchCommands }) {
  const args = parseToolArguments(argumentsText);
  if (name === "tool_search") {
    return emulateToolSearch({ tools: requestTools, query: args.query ?? args.q ?? "", limit: args.limit });
  }
  if (name === "web_search") {
    return await runSearch({
      query: args.query ?? args.q ?? "",
      maxResults: args.max_results ?? args.limit,
      webSearchCommands,
    });
  }
  return `Unsupported emulated tool: ${name}`;
}

function toolSourcesForSearch({ requestTools, appTools }) {
  return [
    ...(Array.isArray(requestTools) ? requestTools : []),
    ...(Array.isArray(appTools) ? appTools.map(appToolSourceFromOllamaTool) : []),
  ];
}

async function createLocalToolBroker({ req, body, appServerBridge, debugAuth, webSearchCommands }) {
  if (requestedNoTools(body)) {
    return {
      modelTools: [],
      appToolCount: 0,
      isHandled: () => false,
      isEmulated: () => false,
      isAppTool: () => false,
      externalize: (toolCall) => ({ ...toolCall, responseToolType: "function" }),
      async execute() {
        throw new Error("Tools are disabled for this request.");
      },
    };
  }

  let appTools = [];
  try {
    appTools = appServerBridge ? await appServerBridge.getTools() : [];
  } catch (error) {
    debugLogError({ enabled: debugAuth, req, error, stage: "app_tools_discovery" });
  }

  const statuses = await emulatedToolStatuses(webSearchCommands);
  const readyEmulatedNames = new Set(
    statuses.filter((status) => status.status === "ready").map((status) => status.name),
  );
  const requestTools = normalizeOllamaTools(localModelTools(body)).filter((tool) => {
    const name = tool.function?.name;
    return !EMULATED_TOOL_NAMES.has(name) || readyEmulatedNames.has(name);
  });
  const deferredToolSearch = appTools.length && readyEmulatedNames.has("tool_search")
    ? normalizeOllamaTools([{ type: "tool_search" }])
    : [];
  const modelTools = mergeOllamaTools(requestTools, deferredToolSearch);
  const responseToolTypes = new Map(
    modelTools
      .filter((tool) => tool._hydraResponseTool?.type)
      .map((tool) => [tool.function?.name, tool._hydraResponseTool.type]),
  );
  const requestToolNames = new Set(requestTools.map((tool) => tool.function?.name).filter(Boolean));
  const appToolNames = new Set(
    appTools
      .map((tool) => tool.function?.name)
      .filter((name) => name && !requestToolNames.has(name)),
  );
  const searchableTools = toolSourcesForSearch({ requestTools: body.tools, appTools });
  const isEmulated = (toolCall) => readyEmulatedNames.has(toolCall.name);
  const isAppTool = (toolCall) => appToolNames.has(toolCall.name);

  return {
    modelTools,
    appToolCount: appTools.length,
    isHandled(toolCall) {
      return isEmulated(toolCall) || isAppTool(toolCall);
    },
    isEmulated,
    isAppTool,
    externalize(toolCall) {
      return { ...toolCall, responseToolType: responseToolTypes.get(toolCall.name) ?? "function" };
    },
    async execute(toolCall) {
      try {
        let content;
        if (toolCall.name === "tool_search" && isEmulated(toolCall)) {
          const args = parseToolArguments(toolCall.argumentsText);
          const matches = matchingToolsForSearch({
            tools: searchableTools,
            query: args.query ?? args.q ?? "",
            limit: args.limit,
          });
          const matchedNames = new Set(matches.map((tool) => tool.name));
          const discoveredAppTools = appTools.filter((tool) => matchedNames.has(tool.function?.name));
          modelTools.splice(0, modelTools.length, ...mergeOllamaTools(modelTools, discoveredAppTools));
          content = JSON.stringify({ query: args.query ?? args.q ?? "", tools: matches }, null, 2);
        } else {
          content = isEmulated(toolCall)
            ? await executeEmulatedTool({
                name: toolCall.name,
                argumentsText: toolCall.argumentsText,
                requestTools: searchableTools,
                webSearchCommands,
              })
            : await appServerBridge.callTool(toolCall);
        }
        return String(content ?? "").slice(0, MAX_TOOL_RESULT_CHARS);
      } catch (error) {
        debugLogError({ enabled: debugAuth, req, error, stage: `local_tool_${toolCall.name}` });
        return `Tool ${toolCall.name} failed: ${error.message}`.slice(0, MAX_TOOL_RESULT_CHARS);
      }
    },
  };
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

function writeCustomToolCall(res, { id, outputIndex, callIndex, name, argumentsText }) {
  const input = customToolInput(argumentsText, name);
  const addedItem = customToolCallItem({ id, index: callIndex, status: "in_progress", name, argumentsText: "" });
  const doneItem = customToolCallItem({ id, index: callIndex, status: "completed", name, argumentsText });
  writeSse(res, "response.output_item.added", {
    type: "response.output_item.added",
    output_index: outputIndex,
    item: addedItem,
  });
  writeSse(res, "response.custom_tool_call_input.delta", {
    type: "response.custom_tool_call_input.delta",
    item_id: addedItem.id,
    output_index: outputIndex,
    delta: input,
  });
  writeSse(res, "response.custom_tool_call_input.done", {
    type: "response.custom_tool_call_input.done",
    item_id: addedItem.id,
    output_index: outputIndex,
    input,
  });
  writeSse(res, "response.output_item.done", {
    type: "response.output_item.done",
    output_index: outputIndex,
    item: doneItem,
  });
}

function writeResponseToolCall(res, { responseToolType = "function", ...toolCall }) {
  if (responseToolType === "custom") writeCustomToolCall(res, toolCall);
  else writeFunctionCall(res, toolCall);
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

async function callOllama({
  req,
  body,
  route,
  ollamaBaseUrl,
  res,
  debugAuth,
  appServerBridge,
  webSearchCommands,
  signal,
}) {
  const stream = body.stream !== false;
  const id = responseId();
  const url = new URL("/api/chat", ollamaBaseUrl);
  const toolBroker = await createLocalToolBroker({ req, body, appServerBridge, debugAuth, webSearchCommands });
  const isHandledToolCall = (toolCall) => toolBroker.isHandled(toolCall);
  const executeHandledToolCall = async (toolCall) => {
    return {
      role: "tool",
      content: await toolBroker.execute(toolCall),
    };
  };
  const appendHandledToolRound = async ({ turnContent, handledCalls }) => {
    messages.push({
      role: "assistant",
      content: turnContent,
      tool_calls: handledCalls.map((toolCall) => ({
        function: {
          name: toolCall.name,
          arguments: parseToolArguments(toolCall.argumentsText),
        },
      })),
    });
    messages.push(...(await Promise.all(handledCalls.map(executeHandledToolCall))));
  };
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
    const ollamaBody = buildOllamaChatBody({ body, route, stream, messages, tools: toolBroker.modelTools });

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
        appToolCount: toolBroker.appToolCount,
        images: ollamaBody.messages.reduce((count, message) => count + (message.images?.length ?? 0), 0),
        think: Boolean(ollamaBody.think),
      },
      stage: "request",
    });

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ollamaBody),
      signal,
    });
    signal.throwIfAborted();
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
    for (let rounds = 0; rounds < MAX_EMULATED_TOOL_ROUNDS; rounds += 1) {
      const data = await response.json();
      const thinking = stripLocalControlMarkers(data.message?.thinking ?? "");
      const content = stripLocalControlMarkers(data.message?.content ?? "");
      const toolCalls = normalizeOllamaToolCalls(data.message?.tool_calls);
      const handledCalls = toolCalls.filter(isHandledToolCall);
      const externalCalls = toolCalls.filter((toolCall) => !isHandledToolCall(toolCall));
      if (handledCalls.length && !externalCalls.length) {
        await appendHandledToolRound({ turnContent: content, handledCalls });
        response = await fetchOllama({ stream: false });
        if (!response.ok) break;
        continue;
      }
      const output = [];
      if (thinking) output.push(reasoningItem({ id, status: "completed", text: thinking }));
      if (content || !toolCalls.length) output.push(messageItem({ id, status: "completed", text: content }));
      externalCalls.forEach((toolCall, index) => {
        output.push(responseToolCallItem({ id, index, ...toolBroker.externalize(toolCall) }));
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
    const text = response.ok
      ? "Stopped after repeated emulated tool calls without a final answer."
      : await response.text();
    jsonResponse(
      req,
      res,
      response.ok ? 200 : response.status,
      response.ok
        ? {
            ...responseEnvelope({
              id,
              model: body.model,
              status: "completed",
              output: [messageItem({ id, status: "completed", text })],
            }),
          }
        : { error: { message: text || response.statusText } },
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
  let appToolCalls = 0;
  let doneReason;
  let rounds = 0;
  let completedResponse = false;
  const thinkingFilter = createLocalControlMarkerFilter();

  const emitThinkingDelta = (delta) => {
    if (!delta) return;
    if (!emittedThinking) writeReasoningStart(res, { id, outputIndex: 0 });
    writeReasoningDelta(res, { id, outputIndex: 0, delta });
    fullText += delta;
    thinkingDeltas += 1;
    thinkingChars += delta.length;
    emittedThinking = true;
  };

  const flushThinking = () => emitThinkingDelta(thinkingFilter.finish());

  const emitContentDelta = (delta) => {
    if (!delta) return;
    flushThinking();
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
      delta,
    });
    fullText += delta;
    contentDeltas += 1;
    contentChars += delta.length;
    emittedContent = true;
  };

  while (rounds < MAX_EMULATED_TOOL_ROUNDS) {
    rounds += 1;
    const turnToolCalls = [];
    let turnContent = "";
    const contentFilter = createLocalControlMarkerFilter();
    buffer = "";

    for await (const chunk of response.body) {
      signal.throwIfAborted();
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        const thinking = thinkingFilter.push(event.message?.thinking ?? "");
        const content = contentFilter.push(event.message?.content ?? "");
        turnToolCalls.push(...normalizeOllamaToolCalls(event.message?.tool_calls));
        emitThinkingDelta(thinking);
        if (content) {
          emitContentDelta(content);
          turnContent += content;
        }
        if (event.done) {
          doneReason = event.done_reason;
        }
      }
    }
    const contentTail = contentFilter.finish();
    if (contentTail) {
      emitContentDelta(contentTail);
      turnContent += contentTail;
    }

    totalToolCalls += turnToolCalls.length;
    const handledCalls = turnToolCalls.filter((toolCall) => toolBroker.isHandled(toolCall));
    const externalCalls = turnToolCalls.filter((toolCall) => !toolBroker.isHandled(toolCall));
    if (handledCalls.length && !externalCalls.length) {
      const emulatedCalls = handledCalls.filter((toolCall) => toolBroker.isEmulated(toolCall));
      const appCalls = handledCalls.filter((toolCall) => toolBroker.isAppTool(toolCall));
      emulatedToolCalls += emulatedCalls.length;
      appToolCalls += appCalls.length;
      messages.push({
        role: "assistant",
        content: turnContent,
        tool_calls: handledCalls.map((toolCall) => ({
          function: {
            name: toolCall.name,
            arguments: parseToolArguments(toolCall.argumentsText),
          },
        })),
      });
      messages.push(
        ...(
          await Promise.all(
            handledCalls.map(executeHandledToolCall),
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

    flushThinking();
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
      const externalCall = toolBroker.externalize(toolCall);
      writeResponseToolCall(res, { id, outputIndex, callIndex: index, ...externalCall });
      output.push(responseToolCallItem({ id, index, ...externalCall }));
      outputIndex += 1;
    });
    writeResponseStreamDone(res, { id, model: body.model, output });
    completedResponse = true;
    break;
  }
  if (!completedResponse) {
    flushThinking();
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
      appToolCalls,
      doneReason,
    },
  });
}

function lmStudioMessageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part?.text ?? "").join("");
}

function mergeLMStudioToolCallDeltas(target, deltas) {
  for (const delta of Array.isArray(deltas) ? deltas : []) {
    const index = Number.isInteger(delta.index) ? delta.index : target.length;
    const current = target[index] ?? { function: { name: "", arguments: "" } };
    if (delta.id) current.id = delta.id;
    if (delta.function?.name) current.function.name += delta.function.name;
    if (delta.function?.arguments) current.function.arguments += delta.function.arguments;
    target[index] = current;
  }
}

async function callLMStudio({
  req,
  body,
  route,
  lmStudioBaseUrl,
  res,
  debugAuth,
  appServerBridge,
  webSearchCommands,
  signal,
}) {
  const stream = body.stream !== false;
  const id = responseId();
  const url = new URL("/v1/chat/completions", lmStudioBaseUrl);
  const toolBroker = await createLocalToolBroker({ req, body, appServerBridge, debugAuth, webSearchCommands });
  let messages;
  try {
    messages = normalizeLMStudioInput(body.input, { allowImages: Boolean(route.capabilities?.vision) });
    if (body.instructions) messages.unshift({ role: "system", content: String(body.instructions) });
  } catch (error) {
    if (error.message.startsWith("Unsupported image input") || error.message.includes("vision support")) {
      jsonResponse(req, res, 400, { error: { message: error.message } }, debugAuth, {
        route,
      });
      return;
    }
    throw error;
  }

  async function fetchLMStudio({ stream }) {
    const upstreamBody = buildLMStudioChatBody({
      body,
      route,
      stream,
      messages,
      tools: toolBroker.modelTools,
    });
    // LM Studio needs a request ID to stop prompt processing when the HTTP
    // client disconnects. Without one, recent runtimes treat cancellation as
    // a deprecated no-op and continue evaluating the prompt.
    upstreamBody.request_id = `hydra-${randomUUID()}`;
    debugLogUpstream({
      enabled: debugAuth,
      req,
      route,
      upstream: {
        provider: "lmstudio",
        url: url.toString(),
        requestBytes: Buffer.byteLength(JSON.stringify(upstreamBody)),
        stream,
        toolCount: upstreamBody.tools?.length ?? 0,
        appToolCount: toolBroker.appToolCount,
      },
      stage: "request",
    });

    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(upstreamBody),
      signal,
    });
    signal.throwIfAborted();
    debugLogUpstream({
      enabled: debugAuth,
      req,
      route,
      upstream: {
        provider: "lmstudio",
        url: url.toString(),
        status: response.status,
        contentType: response.headers.get("content-type"),
      },
      stage: "response",
    });
    return { response, upstreamBody };
  }

  const appendHandledToolRound = async ({ turnContent, handledCalls, round }) => {
    const calls = handledCalls.map((toolCall, index) => ({
      ...toolCall,
      callId: toolCall.callId ?? `call_${id}_local_${round}_${index}`,
    }));
    messages.push({
      role: "assistant",
      content: turnContent,
      tool_calls: calls.map((toolCall) => ({
        id: toolCall.callId,
        type: "function",
        function: { name: toolCall.name, arguments: toolCall.argumentsText },
      })),
    });
    messages.push(
      ...(await Promise.all(
        calls.map(async (toolCall) => ({
          role: "tool",
          tool_call_id: toolCall.callId,
          content: await toolBroker.execute(toolCall),
        })),
      )),
    );
  };

  let { response, upstreamBody } = await fetchLMStudio({ stream });

  if (!response.ok) {
    const text = await response.text();
    jsonResponse(req, res, response.status, { error: { message: text || response.statusText } }, debugAuth, {
      route,
      upstream: { provider: "lmstudio", status: response.status },
    });
    return;
  }

  if (!stream) {
    for (let round = 0; round < MAX_EMULATED_TOOL_ROUNDS; round += 1) {
      const data = await response.json();
      const message = data.choices?.[0]?.message ?? {};
      const thinkingEnabled = upstreamBody.chat_template_kwargs?.enable_thinking === true;
      const thinking = thinkingEnabled
        ? stripLocalControlMarkers(message.reasoning_content ?? message.reasoning ?? "")
        : "";
      const content = stripLocalControlMarkers(lmStudioMessageText(message.content));
      const toolCalls = normalizeOllamaToolCalls(message.tool_calls);
      const handledCalls = toolCalls.filter((toolCall) => toolBroker.isHandled(toolCall));
      const externalCalls = toolCalls.filter((toolCall) => !toolBroker.isHandled(toolCall));
      if (handledCalls.length && !externalCalls.length) {
        await appendHandledToolRound({ turnContent: content, handledCalls, round });
        ({ response, upstreamBody } = await fetchLMStudio({ stream: false }));
        if (!response.ok) break;
        continue;
      }

      const output = [];
      if (thinking) output.push(reasoningItem({ id, status: "completed", text: thinking }));
      if (content || !toolCalls.length) output.push(messageItem({ id, status: "completed", text: content }));
      externalCalls.forEach((toolCall, index) => {
        output.push(responseToolCallItem({ id, index, ...toolBroker.externalize(toolCall) }));
      });
      const usage = data.usage ?? {};
      jsonResponse(
        req,
        res,
        200,
        {
          ...responseEnvelope({ id, model: body.model, status: "completed", output }),
          usage: {
            input_tokens: usage.prompt_tokens ?? 0,
            output_tokens: usage.completion_tokens ?? 0,
            total_tokens: usage.total_tokens ?? 0,
          },
        },
        debugAuth,
        { route, upstream: { provider: "lmstudio", status: response.status } },
      );
      return;
    }

    const text = response.ok
      ? "Stopped after repeated emulated tool calls without a final answer."
      : await response.text();
    jsonResponse(
      req,
      res,
      response.ok ? 200 : response.status,
      response.ok
        ? {
            ...responseEnvelope({
              id,
              model: body.model,
              status: "completed",
              output: [messageItem({ id, status: "completed", text })],
            }),
          }
        : { error: { message: text || response.statusText } },
      debugAuth,
      { route, upstream: { provider: "lmstudio", status: response.status } },
    );
    return;
  }

  sseHeaders(res);
  writeResponseStreamStart(res, { id, model: body.model });
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let thinking = "";
  let emittedContent = false;
  let emittedThinking = false;
  let completedThinking = false;
  let totalToolCalls = 0;
  let emulatedToolCalls = 0;
  let appToolCalls = 0;
  let completedResponse = false;

  const emitThinkingDelta = (delta) => {
    if (!delta) return;
    if (!emittedThinking) writeReasoningStart(res, { id, outputIndex: 0 });
    writeReasoningDelta(res, { id, outputIndex: 0, delta });
    thinking += delta;
    emittedThinking = true;
  };

  const emitContentDelta = (delta) => {
    if (!delta) return;
    if (emittedThinking && !completedThinking) {
      writeReasoningDone(res, { id, outputIndex: 0, text: thinking });
      completedThinking = true;
    }
    if (!emittedContent) writeMessageStart(res, { id, outputIndex: emittedThinking ? 1 : 0 });
    writeSse(res, "response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: `${id}_msg`,
      output_index: emittedThinking ? 1 : 0,
      content_index: 0,
      delta,
    });
    content += delta;
    emittedContent = true;
  };

  for (let round = 0; round < MAX_EMULATED_TOOL_ROUNDS; round += 1) {
    const toolCallDeltas = [];
    const contentFilter = createLocalControlMarkerFilter();
    const thinkingFilter = createLocalControlMarkerFilter();
    const thinkingEnabled = upstreamBody.chat_template_kwargs?.enable_thinking === true;
    let turnContent = "";
    buffer = "";

    const flushRoundThinking = () => emitThinkingDelta(thinkingFilter.finish());
    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      const event = JSON.parse(payload);
      const delta = event.choices?.[0]?.delta ?? {};
      const reasoningDelta = thinkingEnabled
        ? thinkingFilter.push(delta.reasoning_content ?? delta.reasoning ?? "")
        : "";
      const contentDelta = contentFilter.push(lmStudioMessageText(delta.content));
      emitThinkingDelta(reasoningDelta);
      if (contentDelta) {
        flushRoundThinking();
        emitContentDelta(contentDelta);
        turnContent += contentDelta;
      }
      mergeLMStudioToolCallDeltas(toolCallDeltas, delta.tool_calls);
    };

    for await (const chunk of response.body) {
      signal.throwIfAborted();
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    }
    if (buffer.trim()) handleLine(buffer);
    flushRoundThinking();
    const contentTail = contentFilter.finish();
    if (contentTail) {
      emitContentDelta(contentTail);
      turnContent += contentTail;
    }

    const toolCalls = normalizeOllamaToolCalls(toolCallDeltas);
    totalToolCalls += toolCalls.length;
    const handledCalls = toolCalls.filter((toolCall) => toolBroker.isHandled(toolCall));
    const externalCalls = toolCalls.filter((toolCall) => !toolBroker.isHandled(toolCall));
    if (handledCalls.length && !externalCalls.length) {
      emulatedToolCalls += handledCalls.filter((toolCall) => toolBroker.isEmulated(toolCall)).length;
      appToolCalls += handledCalls.filter((toolCall) => toolBroker.isAppTool(toolCall)).length;
      await appendHandledToolRound({ turnContent, handledCalls, round });
      ({ response, upstreamBody } = await fetchLMStudio({ stream: true }));
      if (!response.ok) {
        emitContentDelta((await response.text()) || response.statusText);
        break;
      }
      continue;
    }

    if (emittedThinking && !completedThinking) {
      writeReasoningDone(res, { id, outputIndex: 0, text: thinking });
      completedThinking = true;
    }
    const output = [];
    if (emittedThinking) output.push(reasoningItem({ id, status: "completed", text: thinking }));
    if (emittedContent || !toolCalls.length) {
      const outputIndex = emittedThinking ? 1 : 0;
      if (!emittedContent) writeMessageStart(res, { id, outputIndex });
      writeMessageDone(res, { id, outputIndex, text: content });
      output.push(messageItem({ id, status: "completed", text: content }));
    }
    let outputIndex = output.length;
    externalCalls.forEach((toolCall, index) => {
      const externalCall = toolBroker.externalize(toolCall);
      writeResponseToolCall(res, { id, outputIndex, callIndex: index, ...externalCall });
      output.push(responseToolCallItem({ id, index, ...externalCall }));
      outputIndex += 1;
    });
    writeResponseStreamDone(res, { id, model: body.model, output });
    completedResponse = true;
    break;
  }

  if (!completedResponse) {
    if (emittedThinking && !completedThinking) {
      writeReasoningDone(res, { id, outputIndex: 0, text: thinking });
      completedThinking = true;
    }
    const outputIndex = emittedThinking ? 1 : 0;
    if (!emittedContent) writeMessageStart(res, { id, outputIndex });
    const fallback = content || "Stopped after repeated emulated tool calls without a final answer.";
    if (!content) emitContentDelta(fallback);
    writeMessageDone(res, { id, outputIndex, text: fallback });
    const output = [];
    if (emittedThinking) output.push(reasoningItem({ id, status: "completed", text: thinking }));
    output.push(messageItem({ id, status: "completed", text: fallback }));
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
      provider: "lmstudio",
      status: response.status,
      stream: true,
      contentChars: content.length,
      thinkingChars: thinking.length,
      toolCalls: totalToolCalls,
      emulatedToolCalls,
      appToolCalls,
    },
  });
}

async function forwardOpenAI({ req, body, openaiBaseUrl, apiKey, res, route, debugAuth, signal }) {
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
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers,
      body: upstreamBody,
      signal,
    });
    signal.throwIfAborted();
  } catch (error) {
    if (!signal.aborted) debugLogError({ enabled: debugAuth, req, error, stage: "openai_fetch" });
    throw error;
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
  const metadata = responseMetadataCapture();
  try {
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        signal.throwIfAborted();
        metadata.push(chunk);
        if (!res.write(chunk)) {
          await waitForDrain(res, signal);
        }
      }
    }
    res.end();
  } catch (error) {
    if (signal.aborted) throw error;
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
  return metadata.result();
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

function requestedReasoningEffort(body) {
  const effort = body?.reasoning?.effort ?? body?.reasoning_effort ?? body?.reasoning_level ?? "medium";
  return effort === "light" ? "low" : effort;
}

function effectiveReasoningEffort(route, requested) {
  if (requested === "none") return "none";
  if (route.capabilities?.thinking === false) return "none";
  return requested;
}

function bodyWithReasoningEffort(body, effort) {
  const copy = structuredClone(body);
  if (copy.reasoning && typeof copy.reasoning === "object") copy.reasoning.effort = effort;
  else copy.reasoning = { effort };
  if ("reasoning_effort" in copy) copy.reasoning_effort = effort;
  if ("reasoning_level" in copy) copy.reasoning_level = effort;
  return copy;
}

function isToolContinuationInput(body) {
  if (!Array.isArray(body?.input) || body.input.length === 0) return false;
  const latest = body.input.at(-1);
  return latest?.type === "function_call_output" || latest?.type === "custom_tool_call_output";
}

function syntheticSessionKey(req, definition) {
  const sessionId = req.headers["session-id"];
  if (!sessionId) return null;
  return `${definition.slug}:${Array.isArray(sessionId) ? sessionId[0] : sessionId}`;
}

function requestSource(req) {
  return /codex(?:[_\s-]?(?:cli|exec))/i.test(String(req.headers["user-agent"] ?? "")) ? "cli" : "codex";
}

function delayWithSignal(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new DOMException("Request cancelled", "AbortError"));
    };
    function finish() {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function dispatchDirectRoute({
  req,
  body,
  route,
  ollamaBaseUrl,
  lmStudioBaseUrl,
  openaiBaseUrl,
  apiKey,
  res,
  debugAuth,
  appServerBridge,
  webSearchCommands,
  signal,
}) {
  if (route.provider === "ollama") {
    return callOllama({
      req,
      body,
      route,
      ollamaBaseUrl,
      res,
      debugAuth,
      appServerBridge,
      webSearchCommands,
      signal,
    });
  }
  if (route.provider === "lmstudio") {
    return callLMStudio({
      req,
      body,
      route,
      lmStudioBaseUrl,
      res,
      debugAuth,
      appServerBridge,
      webSearchCommands,
      signal,
    });
  }
  return forwardOpenAI({ req, body, openaiBaseUrl, apiKey, res, route, debugAuth, signal });
}

function safeSyntheticError(error) {
  return {
    name: error?.name ?? "Error",
    code: error?.code,
    status: error?.status,
    stage: error?.hydraStage,
  };
}

function responseOutputText(data) {
  if (typeof data?.output_text === "string") return data.output_text;
  return (Array.isArray(data?.output) ? data.output : [])
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .map((part) => part?.text ?? part?.output_text ?? "")
    .join("");
}

function responseStreamOutputText(text) {
  const deltas = [];
  let completedText;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
      deltas.push(event.delta);
    } else if (event?.type === "response.output_text.done" && typeof event.text === "string") {
      completedText = event.text;
    } else if (event?.type === "response.completed") {
      completedText ??= responseOutputText(event.response);
    }
  }
  return completedText || deltas.join("");
}

async function callSelectorModel({
  model,
  prompt,
  req,
  routes,
  ollamaBaseUrl,
  lmStudioBaseUrl,
  openaiBaseUrl,
  apiKey,
  signal,
  debugAuth,
  source,
  syntheticModel,
}) {
  if (typeof model !== "string" || !model.trim() || typeof prompt !== "string" || !prompt) {
    const error = new Error("Invalid selector model call");
    error.code = "HYDRA_SELECTOR_MODEL_REQUEST";
    throw error;
  }
  const route = routes[model];
  if (!route || route.provider === "synthetic") {
    const error = new Error("Selector model is unavailable");
    error.code = "HYDRA_SELECTOR_MODEL_UNAVAILABLE";
    throw error;
  }

  let url;
  let headers = { "content-type": "application/json", accept: "application/json" };
  let upstreamBody;
  if (route.provider === "ollama") {
    url = new URL("/api/chat", ollamaBaseUrl);
    upstreamBody = {
      model: route.upstreamModel,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      think: false,
    };
  } else if (route.provider === "lmstudio") {
    url = new URL("/v1/chat/completions", lmStudioBaseUrl);
    upstreamBody = {
      model: route.upstreamModel,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      temperature: 0,
      max_tokens: 256,
      reasoning_effort: "none",
      chat_template_kwargs: { enable_thinking: false },
      request_id: `hydra-selector-${randomUUID()}`,
    };
  } else {
    url = upstreamResponsesUrl("/responses", openaiBaseUrl);
    headers = forwardedHeaders(req.headers);
    headers["content-type"] = "application/json";
    headers.accept = "text/event-stream";
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    else if (req.headers.authorization) headers.authorization = req.headers.authorization;
    upstreamBody = {
      model: route.upstreamModel,
      input: [{ role: "user", content: prompt }],
      stream: true,
      store: false,
    };
  }

  const requestText = JSON.stringify(upstreamBody);
  debugLogSynthetic({
    enabled: debugAuth,
    event: "selector-model-request",
    payload: {
      source,
      syntheticModel,
      selectorModel: model,
      provider: route.provider,
      promptChars: prompt.length,
      requestBytes: Buffer.byteLength(requestText),
    },
  });
  const response = await fetch(url, { method: "POST", headers, body: requestText, signal });
  signal.throwIfAborted();
  const responseText = await response.text();
  if (!response.ok) {
    const error = new Error("Selector model request failed");
    error.code = "HYDRA_SELECTOR_MODEL_UPSTREAM";
    error.status = response.status;
    throw error;
  }
  let data;
  if (route.provider !== "openai") {
    try {
      data = JSON.parse(responseText);
    } catch {
      const error = new Error("Selector model returned an invalid response");
      error.code = "HYDRA_SELECTOR_MODEL_RESPONSE";
      throw error;
    }
  }
  const output = route.provider === "ollama"
    ? data?.message?.content
    : route.provider === "lmstudio"
      ? lmStudioMessageText(data?.choices?.[0]?.message?.content)
      : responseStreamOutputText(responseText);
  if (typeof output !== "string" || !output.trim()) {
    const error = new Error("Selector model returned no output");
    error.code = "HYDRA_SELECTOR_MODEL_OUTPUT";
    throw error;
  }
  debugLogSynthetic({
    enabled: debugAuth,
    event: "selector-model-response",
    payload: {
      source,
      syntheticModel,
      selectorModel: model,
      provider: route.provider,
      status: response.status,
      outputChars: output.length,
    },
  });
  return stripLocalControlMarkers(output).trim();
}

async function runDirectAttempts({
  targetSlug,
  phase,
  definition,
  routes,
  res,
  signal,
  debugAuth,
  source,
  dispatchArgs,
}) {
  let lastError;
  for (let attempt = 0; attempt <= definition.retryCount; attempt += 1) {
    signal.throwIfAborted();
    const route = routes[targetSlug];
    const gate = new ResponseGate(res);
    debugLogSynthetic({
      enabled: debugAuth,
      event: "attempt",
      payload: {
        source,
        syntheticModel: definition.slug,
        target: targetSlug,
        phase,
        attempt: attempt + 1,
        retryDelayMs: attempt > 0 ? definition.retryDelayMs : 0,
      },
    });
    try {
      const metadata = await dispatchDirectRoute({ ...dispatchArgs, route, res: gate, signal });
      if (gate.committed) return { targetSlug, route, metadata };
      const error = gate.failureError ?? new Error(`Upstream returned HTTP ${gate.statusCode}`);
      error.status = gate.statusCode;
      throw error;
    } catch (error) {
      if (gate.committed || res.headersSent) {
        error.hydraPostCommit = true;
        throw error;
      }
      lastError = error;
      debugLogSynthetic({
        enabled: debugAuth,
        event: "attempt-failed",
        payload: {
          source,
          syntheticModel: definition.slug,
          target: targetSlug,
          phase,
          attempt: attempt + 1,
          error: safeSyntheticError(error),
        },
      });
      if (attempt < definition.retryCount) await delayWithSignal(definition.retryDelayMs, signal);
    }
  }
  throw lastError ?? new Error(`Model failed without a response: ${targetSlug}`);
}

function writePostCommitFailure(res, model) {
  if (res.destroyed || res.writableEnded) return;
  const id = responseId();
  writeSse(res, "response.failed", {
    type: "response.failed",
    response: {
      ...responseEnvelope({ id, model, status: "failed" }),
      error: { code: "hydra_upstream_failed", message: "The selected model failed after response output began." },
    },
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

async function handleSyntheticRequest({
  req,
  body,
  syntheticRoute,
  routes,
  state,
  res,
  signal,
  ollamaBaseUrl,
  lmStudioBaseUrl,
  openaiBaseUrl,
  apiKey,
  debugAuth,
  appServerBridge,
  webSearchCommands,
  source = "codex",
  inspectOnly = false,
  syntheticContextOptions = {},
  onSyntheticSelection,
  stateOwner,
}) {
  const definition = syntheticRoute.definition;
  const sessionKey = syntheticSessionKey(req, definition);
  const requestedEffort = requestedReasoningEffort(body);
  const conversationLock = sessionKey ? state.conversations.get(sessionKey) : null;
  const statefulLock = sessionKey ? state.statefulSessions.get(sessionKey) : null;
  const turnLock = sessionKey && isToolContinuationInput(body) && definition.stickyToolContinuations
    ? state.turns.get(sessionKey)
    : null;
  const lock = stateOwner ?? statefulLock ?? (definition.routingScope === "conversation" ? conversationLock : turnLock);
  const statePinned = Boolean(stateOwner || statefulLock);
  let context;
  let selectedSlug;
  let effectiveEffort;
  let selectionFallback = false;
  let selectionError;
  let selectorDurationMs = null;

  if (lock) {
    context = { features: selectorFeatures(body) };
    try {
      if (statePinned) {
        const pinnedRoute = routes[lock.targetSlug];
        if (!pinnedRoute || pinnedRoute.provider !== "openai" || !definition.effectiveCandidates.includes(lock.targetSlug)) {
          throw new Error(`State-owning route is no longer available to ${definition.slug}: ${lock.targetSlug}`);
        }
        selectedSlug = lock.targetSlug;
        effectiveEffort = effectiveReasoningEffort(pinnedRoute, requestedEffort);
      } else {
        const selected = validateSelectorTarget({ definition, target: lock.targetSlug, context, routes });
        selectedSlug = selected.slug;
        effectiveEffort = lock.reasoningEffort;
      }
    } catch (error) {
      if (statePinned) throw error;
      selectionFallback = true;
      selectionError = error;
      const fallback = validateSelectorTarget({ definition, target: definition.fallbackModel, context, routes });
      selectedSlug = fallback.slug;
      effectiveEffort = effectiveReasoningEffort(fallback.route, requestedEffort);
    }
  } else {
    context = await buildSelectorContext({
      definition,
      body,
      routes,
      ollamaBaseUrl,
      lmStudioBaseUrl,
      signal,
      source,
      ...syntheticContextOptions,
    });
    signal.throwIfAborted();
    const selectorStartedAt = performance.now();
    try {
      const result = await runSyntheticSelector({
        definition,
        context,
        signal,
        callModel: ({ model, prompt, signal: selectorSignal }) => callSelectorModel({
          model,
          prompt,
          req,
          routes,
          ollamaBaseUrl,
          lmStudioBaseUrl,
          openaiBaseUrl,
          apiKey,
          signal: selectorSignal,
          debugAuth,
          source,
          syntheticModel: definition.slug,
        }),
      });
      const selected = validateSelectorTarget({ definition, target: result, context, routes });
      selectedSlug = selected.slug;
      effectiveEffort = effectiveReasoningEffort(selected.route, requestedEffort);
    } catch (error) {
      selectionFallback = true;
      selectionError = error;
      const fallback = validateSelectorTarget({
        definition,
        target: definition.fallbackModel,
        context,
        routes,
      });
      selectedSlug = fallback.slug;
      effectiveEffort = effectiveReasoningEffort(fallback.route, requestedEffort);
    } finally {
      selectorDurationMs = Math.round((performance.now() - selectorStartedAt) * 1000) / 1000;
    }
  }

  debugLogSynthetic({
    enabled: debugAuth,
    event: "decision",
    payload: {
      source,
      syntheticModel: definition.slug,
      routingScope: definition.routingScope,
      stickyReuse: Boolean(lock),
      selector: definition.selector,
      selectorHash: definition.selectorHash,
      selectorTimeoutMs: definition.selectorTimeoutMs,
      selectorDurationMs,
      selected: selectedSlug,
      fallback: selectionFallback,
      requestedReasoningEffort: requestedEffort,
      effectiveReasoningEffort: effectiveEffort,
      features: context.features,
      candidates: context.candidates,
      providers: context.providers,
      machine: context.machine,
      error: selectionError ? safeSyntheticError(selectionError) : undefined,
    },
  });

  if (inspectOnly) return { target: selectedSlug, fallback: selectionFallback, reasoningEffort: effectiveEffort };

  if (statePinned && sessionKey) state.statefulSessions.set(sessionKey, { targetSlug: selectedSlug });

  const routedBody = bodyWithReasoningEffort(body, effectiveEffort);
  const dispatchArgs = {
    req,
    body: routedBody,
    ollamaBaseUrl,
    lmStudioBaseUrl,
    openaiBaseUrl,
    apiKey,
    debugAuth,
    appServerBridge,
    webSearchCommands,
  };
  let ultimate;
  try {
    try {
      ultimate = await runDirectAttempts({
        targetSlug: selectedSlug,
        phase: selectionFallback ? "fallback" : "selected",
        definition,
        routes,
        res,
        signal,
        debugAuth,
        source,
        dispatchArgs,
      });
    } catch (error) {
      if (error.hydraPostCommit || selectionFallback || statePinned) throw error;
      const fallback = validateSelectorTarget({ definition, target: definition.fallbackModel, context, routes });
      const fallbackEffort = effectiveReasoningEffort(fallback.route, requestedEffort);
      dispatchArgs.body = bodyWithReasoningEffort(body, fallbackEffort);
      effectiveEffort = fallbackEffort;
      ultimate = await runDirectAttempts({
        targetSlug: fallback.slug,
        phase: "fallback",
        definition,
        routes,
        res,
        signal,
        debugAuth,
        source,
        dispatchArgs,
      });
    }
  } catch (error) {
    if (error.hydraPostCommit) writePostCommitFailure(res, body.model);
    throw error;
  }

  if (sessionKey) {
    const locked = { targetSlug: ultimate.targetSlug, reasoningEffort: effectiveEffort };
    if (definition.routingScope === "conversation") state.conversations.set(sessionKey, locked);
    else if (definition.stickyToolContinuations) state.turns.set(sessionKey, locked);
  }
  if (ultimate.route.provider === "openai") {
    const owner = { targetSlug: ultimate.targetSlug };
    if (ultimate.metadata?.responseId) state.responseOwners.set(ultimate.metadata.responseId, owner);
    const conversation = typeof body.conversation === "string" ? body.conversation : body.conversation?.id;
    const conversationId = ultimate.metadata?.conversationId ?? conversation;
    if (conversationId) state.upstreamConversations.set(conversationId, owner);
  }
  state.lastSelections.set(definition.slug, {
    selected: selectedSlug,
    ultimate: ultimate.targetSlug,
    fallback: ultimate.targetSlug !== selectedSlug || selectionFallback,
    at: new Date().toISOString(),
  });
  onSyntheticSelection?.(state.lastSelections.get(definition.slug));
  debugLogSynthetic({
    enabled: debugAuth,
    event: "completed",
    payload: {
      source,
      syntheticModel: definition.slug,
      selected: selectedSlug,
      ultimate: ultimate.targetSlug,
      fallback: ultimate.targetSlug !== selectedSlug || selectionFallback,
      reasoningEffort: effectiveEffort,
    },
  });
  return { target: ultimate.targetSlug, fallback: ultimate.targetSlug !== selectedSlug || selectionFallback };
}

export function upstreamResponsesUrl(requestPath, openaiBaseUrl) {
  const base = new URL(openaiBaseUrl);
  const basePath = base.pathname.replace(/\/+$/g, "");
  const requestSuffix = requestPath === "/v1/responses" ? "/responses" : requestPath;
  base.pathname = `${basePath}${requestSuffix}`;
  base.search = "";
  return base;
}

function writeUpgradeRejection(socket, status, message) {
  if (socket.destroyed) return;
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function rejectUpgrade({ req, socket, debugAuth }) {
  debugLogUpgrade({ enabled: debugAuth, req });
  if (req.method !== "GET" || !["/responses", "/v1/responses"].includes(req.url)) {
    writeUpgradeRejection(socket, 404, "Not Found");
    return;
  }
  writeUpgradeRejection(socket, 426, "Upgrade Required");
}

export function createHydraHandler({
  paths,
  ollamaBaseUrl,
  lmStudioBaseUrl,
  openaiBaseUrl,
  apiKey,
  webSearchCommands = [],
  debugAuth = false,
  appServerBridge = null,
  syntheticContextOptions = {},
  onSyntheticSelection,
  onReload,
}) {
  const syntheticState = {
    conversations: new Map(),
    turns: new Map(),
    statefulSessions: new Map(),
    responseOwners: new Map(),
    upstreamConversations: new Map(),
    lastSelections: new Map(),
    clear() {
      this.conversations.clear();
      this.turns.clear();
      this.statefulSessions.clear();
      this.responseOwners.clear();
      this.upstreamConversations.clear();
      this.lastSelections.clear();
    },
  };

  async function hydraHandler(req, res) {
    let cancellation;
    let route;
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

      if (req.method === "POST" && req.url === "/hydra/reload") {
        syntheticState.clear();
        await onReload?.();
        jsonResponse(req, res, 200, { ok: true }, debugAuth);
        return;
      }

      const isResponsesRequest = req.method === "POST" && ["/responses", "/v1/responses"].includes(req.url);
      const isRouteInspection = req.method === "POST" && req.url === "/hydra/route";
      if (!isResponsesRequest && !isRouteInspection) {
        jsonResponse(req, res, 404, { error: { message: "Not found" } }, debugAuth);
        return;
      }

      const controller = new AbortController();
      let cancellationStage;
      const abortForClient = (stage) => {
        if (controller.signal.aborted || res.writableEnded) return;
        cancellationStage = stage;
        controller.abort(new DOMException("Responses client disconnected", "AbortError"));
      };
      const onAborted = () => abortForClient("request_aborted");
      const onResponseClose = () => abortForClient("response_closed");
      req.on("aborted", onAborted);
      res.on("close", onResponseClose);
      cancellation = {
        signal: controller.signal,
        get stage() {
          return cancellationStage;
        },
        cleanup() {
          req.off("aborted", onAborted);
          res.off("close", onResponseClose);
        },
      };

      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        debugLogError({ enabled: debugAuth, req, error, stage: "read_body" });
        throw error;
      }
      const routes = await loadRoutes(paths);
      route = routes[body?.model];
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

      const stateReference = isResponsesRequest ? responsesStateReference(body) : null;
      if (stateReference && route.provider !== "openai" && route.provider !== "synthetic") {
        jsonResponse(
          req,
          res,
          400,
          stateReferenceError(
            `Hydra local routes support only stateless Responses requests. Remove ${stateReference.field} and send complete history in input.`,
            stateReference.field,
          ),
          debugAuth,
          { route },
        );
        return;
      }

      let stateOwner;
      if (stateReference && route.provider === "synthetic") {
        const sessionKey = syntheticSessionKey(req, route.definition);
        stateOwner = stateReference.field === "previous_response_id"
          ? syntheticState.responseOwners.get(stateReference.id)
          : syntheticState.upstreamConversations.get(stateReference.id);
        if (!sessionKey || !stateOwner) {
          jsonResponse(
            req,
            res,
            400,
            stateReferenceError(
              `Hydra cannot prove which upstream owns ${stateReference.field}=${JSON.stringify(stateReference.id)}. Resume through the original direct OpenAI route, or send complete history in input without server state.`,
              stateReference.field,
            ),
            debugAuth,
            { route },
          );
          return;
        }
        const existingOwner = syntheticState.statefulSessions.get(sessionKey);
        if (existingOwner && existingOwner.targetSlug !== stateOwner.targetSlug) {
          jsonResponse(
            req,
            res,
            400,
            stateReferenceError(
              `The Codex session is pinned to ${existingOwner.targetSlug}, but ${stateReference.field} belongs to ${stateOwner.targetSlug}.`,
              stateReference.field,
            ),
            debugAuth,
            { route },
          );
          return;
        }
      }

      if (isRouteInspection) {
        if (route.provider !== "synthetic") {
          jsonResponse(req, res, 400, { error: { message: "Route inspection requires a synthetic model" } }, debugAuth);
          return;
        }
        const decision = await handleSyntheticRequest({
          req,
          body,
          syntheticRoute: route,
          routes,
          state: syntheticState,
          res,
          signal: cancellation.signal,
          ollamaBaseUrl,
          lmStudioBaseUrl,
          openaiBaseUrl,
          apiKey,
          debugAuth,
          appServerBridge,
          webSearchCommands,
          source: "cli",
          inspectOnly: true,
          syntheticContextOptions,
        });
        jsonResponse(req, res, 200, decision, debugAuth, { route });
        return;
      }

      if (route.provider === "synthetic") {
        await handleSyntheticRequest({
          req,
          body,
          syntheticRoute: route,
          routes,
          state: syntheticState,
          res,
          signal: cancellation.signal,
          ollamaBaseUrl,
          lmStudioBaseUrl,
          openaiBaseUrl,
          apiKey,
          debugAuth,
          appServerBridge,
          webSearchCommands,
          syntheticContextOptions,
          source: requestSource(req),
          onSyntheticSelection,
          stateOwner,
        });
        return;
      }
      const metadata = await dispatchDirectRoute({
        req,
        body,
        route,
        ollamaBaseUrl,
        lmStudioBaseUrl,
        openaiBaseUrl,
        apiKey,
        res,
        debugAuth,
        appServerBridge,
        webSearchCommands,
        signal: cancellation.signal,
      });
      if (route.provider === "openai") {
        const owner = { targetSlug: body.model };
        if (metadata?.responseId) syntheticState.responseOwners.set(metadata.responseId, owner);
        const conversation = typeof body.conversation === "string" ? body.conversation : body.conversation?.id;
        const conversationId = metadata?.conversationId ?? conversation;
        if (conversationId) syntheticState.upstreamConversations.set(conversationId, owner);
      }
    } catch (error) {
      if (cancellation?.stage) {
        debugLogCancellation({ enabled: debugAuth, req, route, stage: cancellation.stage });
        return;
      }
      debugLogError({ enabled: debugAuth, req, error, stage: "handler" });
      if (!res.headersSent && !res.destroyed && !res.writableEnded) {
        jsonResponse(req, res, 500, { error: { message: error.message } }, debugAuth);
      } else if (!res.destroyed && !res.writableEnded) {
        res.destroy(error);
      }
    } finally {
      cancellation?.cleanup();
    }
  }

  hydraHandler.handleUpgrade = (req, socket) => {
    rejectUpgrade({ req, socket, debugAuth });
  };
  hydraHandler.syntheticState = syntheticState;

  return hydraHandler;
}
