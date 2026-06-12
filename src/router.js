import { readFile } from "node:fs/promises";
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { debugLogAccess, debugLogError, debugLogRequest, debugLogUpgrade, debugLogUpstream } from "./debug.js";

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

function normalizeResponsesInput(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [{ role: "user", content: JSON.stringify(input ?? "") }];

  return input.map((item) => {
    const role = item.role ?? "user";
    const content = Array.isArray(item.content)
      ? item.content
          .map((part) => part.text ?? part.input_text ?? part.output_text ?? "")
          .filter(Boolean)
          .join("\n")
      : item.content ?? "";
    return { role, content: String(content) };
  });
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

function stripThinkingText(text) {
  return String(text ?? "").replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "").trimStart();
}

function createThinkingFilter() {
  let inThinkingTag = false;
  let pending = "";
  let strippedChars = 0;

  function holdPartialOpenTag(text) {
    const marker = "<think";
    const lower = text.toLowerCase();
    for (let length = Math.min(marker.length - 1, text.length); length > 0; length -= 1) {
      if (marker.startsWith(lower.slice(-length))) {
        pending = text.slice(-length);
        return text.slice(0, -length);
      }
    }
    pending = "";
    return text;
  }

  return {
    push(delta) {
      let text = pending + String(delta ?? "");
      pending = "";
      let visible = "";

      while (text) {
        if (inThinkingTag) {
          const closeIndex = text.toLowerCase().indexOf("</think>");
          if (closeIndex === -1) {
            strippedChars += text.length;
            return visible;
          }
          strippedChars += closeIndex + "</think>".length;
          text = text.slice(closeIndex + "</think>".length);
          inThinkingTag = false;
          continue;
        }

        const openIndex = text.toLowerCase().indexOf("<think");
        if (openIndex === -1) {
          visible += holdPartialOpenTag(text);
          return visible;
        }

        visible += text.slice(0, openIndex);
        const tagEnd = text.indexOf(">", openIndex);
        if (tagEnd === -1) {
          strippedChars += text.length - openIndex;
          inThinkingTag = true;
          return visible;
        }
        strippedChars += tagEnd - openIndex + 1;
        text = text.slice(tagEnd + 1);
        inThinkingTag = true;
      }

      return visible;
    },
    finish() {
      const visible = inThinkingTag ? "" : pending;
      if (inThinkingTag) strippedChars += pending.length;
      pending = "";
      return visible;
    },
    get strippedChars() {
      return strippedChars;
    },
  };
}

function writeResponseStreamStart(res, { id, model }) {
  const response = responseEnvelope({ id, model });
  const item = messageItem({ id });
  writeSse(res, "response.created", { type: "response.created", response });
  writeSse(res, "response.in_progress", { type: "response.in_progress", response });
  writeSse(res, "response.output_item.added", {
    type: "response.output_item.added",
    output_index: 0,
    item,
  });
  writeSse(res, "response.content_part.added", {
    type: "response.content_part.added",
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "" },
  });
}

function writeResponseStreamDone(res, { id, model, text }) {
  const item = messageItem({ id, status: "completed", text });
  writeSse(res, "response.output_text.done", {
    type: "response.output_text.done",
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    text,
  });
  writeSse(res, "response.content_part.done", {
    type: "response.content_part.done",
    item_id: item.id,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text },
  });
  writeSse(res, "response.output_item.done", {
    type: "response.output_item.done",
    output_index: 0,
    item,
  });
  writeSse(res, "response.completed", {
    type: "response.completed",
    response: responseEnvelope({ id, model, status: "completed", output: [item] }),
  });
}

async function callOllama({ req, body, route, ollamaBaseUrl, res, debugAuth }) {
  const stream = body.stream !== false;
  const id = responseId();
  const ollamaBody = {
    model: route.upstreamModel,
    messages: normalizeResponsesInput(body.input),
    stream,
    options: {
      temperature: body.temperature,
      top_p: body.top_p,
      num_predict: body.max_output_tokens,
    },
  };
  const url = new URL("/api/chat", ollamaBaseUrl);

  debugLogUpstream({
    enabled: debugAuth,
    req,
    route,
    upstream: {
      provider: "ollama",
      url: url.toString(),
      requestBytes: Buffer.byteLength(JSON.stringify(ollamaBody)),
      stream,
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
    const text = stripThinkingText(data.message?.content ?? "");
    const output = messageItem({ id, status: "completed", text });
    jsonResponse(
      req,
      res,
      200,
      {
        ...responseEnvelope({ id, model: body.model, status: "completed", output: [output] }),
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
  const thinkingFilter = createThinkingFilter();
  let buffer = "";
  let fullText = "";
  let contentDeltas = 0;
  let thinkingDeltas = 0;
  let doneReason;

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.message?.thinking) thinkingDeltas += 1;
      const delta = thinkingFilter.push(event.message?.content ?? "");
      if (delta) {
        fullText += delta;
        contentDeltas += 1;
        writeSse(res, "response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: `${id}_msg`,
          output_index: 0,
          content_index: 0,
          delta,
        });
      }
      if (event.done) {
        doneReason = event.done_reason;
        const finalDelta = thinkingFilter.finish();
        if (finalDelta) {
          fullText += finalDelta;
          contentDeltas += 1;
          writeSse(res, "response.output_text.delta", {
            type: "response.output_text.delta",
            item_id: `${id}_msg`,
            output_index: 0,
            content_index: 0,
            delta: finalDelta,
          });
        }
        writeResponseStreamDone(res, { id, model: body.model, text: fullText });
      }
    }
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
      strippedThinkChars: thinkingFilter.strippedChars,
      outputChars: fullText.length,
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
