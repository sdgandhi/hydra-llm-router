import { appendFileSync } from "node:fs";

const SENSITIVE_HEADER_RE = /authorization|cookie|token|key|secret|session|csrf|jwt|credential/i;
const INTERESTING_HEADER_RE =
  /authorization|cookie|token|key|secret|session|csrf|jwt|credential|openai|chatgpt|codex|organization|project|account|user-agent|content-type|content-length|content-encoding|transfer-encoding|accept/i;

function redactValue(value) {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value == null) return value;
  const text = String(value);
  if (!text) return text;
  if (text.length <= 12) return "<redacted>";
  return `<redacted:${text.length}:sha256-unavailable>`;
}

export function sanitizeHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!INTERESTING_HEADER_RE.test(key)) continue;
    result[key] = SENSITIVE_HEADER_RE.test(key) ? redactValue(value) : value;
  }
  return result;
}

export function summarizeBody(body) {
  if (!body || typeof body !== "object") return { type: typeof body };
  return {
    model: body.model,
    stream: body.stream,
    inputType: Array.isArray(body.input) ? "array" : typeof body.input,
    inputItems: Array.isArray(body.input) ? body.input.length : undefined,
    hasTools: Array.isArray(body.tools) ? body.tools.length > 0 : Boolean(body.tools),
    toolCount: Array.isArray(body.tools) ? body.tools.length : undefined,
    keys: Object.keys(body).sort(),
  };
}

export function debugLogRequest({ enabled, req, body, route }) {
  if (!enabled) return;
  const payload = {
    at: new Date().toISOString(),
    method: req.method,
    url: req.url,
    headers: sanitizeHeaders(req.headers),
    body: summarizeBody(body),
    route,
  };
  writeDebugLine("hydra-debug", payload);
}

export function debugLogAccess({ enabled, req, status, route, upstream }) {
  if (!enabled) return;
  const payload = {
    at: new Date().toISOString(),
    method: req.method,
    url: req.url,
    status,
    headers: sanitizeHeaders(req.headers),
    route,
    upstream,
  };
  writeDebugLine("hydra-access", payload);
}

export function debugLogUpstream({ enabled, req, route, upstream, stage }) {
  if (!enabled) return;
  const payload = {
    at: new Date().toISOString(),
    method: req.method,
    url: req.url,
    stage,
    headers: sanitizeHeaders(req.headers),
    route,
    upstream,
  };
  writeDebugLine("hydra-upstream", payload);
}

export function debugLogUpgrade({ enabled, req }) {
  if (!enabled) return;
  const payload = {
    at: new Date().toISOString(),
    method: req.method,
    url: req.url,
    headers: sanitizeHeaders(req.headers),
  };
  writeDebugLine("hydra-upgrade", payload);
}

export function debugLogError({ enabled, req, error, stage }) {
  if (!enabled) return;
  const payload = {
    at: new Date().toISOString(),
    method: req?.method,
    url: req?.url,
    stage,
    headers: req ? sanitizeHeaders(req.headers) : undefined,
    error: {
      name: error?.name,
      message: error?.message,
      code: error?.code,
    },
  };
  writeDebugLine("hydra-error", payload);
}

export function configureDebugLog(filePath) {
  globalThis.__HYDRA_DEBUG_LOG_PATH = filePath;
}

export function writeDebugLine(label, payload) {
  const line = `[${label}] ${JSON.stringify(payload)}\n`;
  if (globalThis.__HYDRA_DEBUG_LOG_PATH) {
    appendFileSync(globalThis.__HYDRA_DEBUG_LOG_PATH, line, "utf8");
    return;
  }
  try {
    process.stderr.write(line);
  } catch {
    // Logging must never crash the router.
  }
}
