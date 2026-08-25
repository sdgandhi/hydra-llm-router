import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WORKER_PATH = fileURLToPath(new URL("./selector-worker.js", import.meta.url));

function inputText(part) {
  return part?.text ?? part?.input_text ?? part?.output_text ?? "";
}

function isImagePart(part) {
  return part?.type === "input_image" || part?.type === "image" || part?.type === "image_url" || part?.image_url != null;
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map(inputText).filter(Boolean).join("\n");
}

export function normalizeSelectorMessages(body) {
  const system = [];
  const developer = [];
  const history = [];
  const users = [];
  const toolCalls = [];
  const toolResults = [];
  if (body?.instructions) system.push({ role: "system", content: textFromContent(body.instructions) });
  const input = Array.isArray(body?.input) ? body.input : [{ role: "user", content: body?.input ?? "" }];
  for (const item of input) {
    if (item?.type === "function_call" || item?.type === "custom_tool_call") {
      toolCalls.push(structuredClone(item));
      continue;
    }
    if (item?.type === "function_call_output" || item?.type === "custom_tool_call_output") {
      toolResults.push(structuredClone(item));
      continue;
    }
    const normalized = { role: item?.role ?? "user", content: textFromContent(item?.content) };
    if (normalized.role === "system") system.push(normalized);
    else if (normalized.role === "developer") developer.push(normalized);
    else if (normalized.role === "user") users.push(normalized);
    else history.push(normalized);
  }
  const latestUser = users.pop() ?? null;
  history.push(...users);
  return { system, developer, history, latestUser, toolCalls, toolResults };
}

function approximateValueTokens(value) {
  if (value == null) return 0;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil(text.length / 3) + 4;
}

function countStructuredInputs(value, predicate) {
  if (!value || typeof value !== "object") return 0;
  let count = predicate(value) ? 1 : 0;
  if (Array.isArray(value)) {
    for (const child of value) count += countStructuredInputs(child, predicate);
  } else {
    for (const child of Object.values(value)) count += countStructuredInputs(child, predicate);
  }
  return count;
}

export function selectorFeatures(body, messages = normalizeSelectorMessages(body)) {
  const tokenGroups = {
    system: approximateValueTokens(messages.system),
    developer: approximateValueTokens(messages.developer),
    history: approximateValueTokens(messages.history),
    latestUser: approximateValueTokens(messages.latestUser),
    tools: approximateValueTokens(body?.tools),
  };
  const imageCount = countStructuredInputs(body?.input, isImagePart);
  const explicitFileCount = countStructuredInputs(
    body?.input,
    (item) => item?.type === "input_file" || item?.file_id != null || item?.filename != null,
  );
  return {
    approximateTokens: { ...tokenGroups, total: Object.values(tokenGroups).reduce((sum, value) => sum + value, 0) },
    actualContextTokens: Object.values(tokenGroups).reduce((sum, value) => sum + value, 0),
    explicitFileCount,
    imageCount,
    hasImages: imageCount > 0,
    toolCount: Array.isArray(body?.tools) ? body.tools.length : 0,
    requestedReasoningEffort:
      body?.reasoning?.effort ?? body?.reasoning_effort ?? body?.reasoning_level ?? "medium",
  };
}

async function safeExec(command, args) {
  try {
    return (await execFileAsync(command, args, { timeout: 3000, maxBuffer: 1024 * 1024 })).stdout;
  } catch {
    return null;
  }
}

async function machineTelemetry() {
  const [batteryText, pressureText, gpuText] = await Promise.all([
    process.platform === "darwin" ? safeExec("/usr/bin/pmset", ["-g", "batt"]) : null,
    process.platform === "darwin" ? safeExec("/usr/bin/memory_pressure", []) : null,
    process.platform === "darwin" ? safeExec("/usr/sbin/system_profiler", ["SPDisplaysDataType", "-json"]) : null,
  ]);
  const batteryMatch = batteryText?.match(/(\d+)%/);
  const pressureMatch = pressureText?.match(/System-wide memory free percentage:\s*(\d+)%/i);
  let devices = [];
  if (gpuText) {
    try {
      const parsed = JSON.parse(gpuText);
      devices = (parsed.SPDisplaysDataType ?? []).map((device) => ({
        name: device.sppci_model ?? device._name ?? null,
        vendor: device.sppci_vendor ?? null,
        memory: device.spdisplays_vram ?? device.spdisplays_vram_shared ?? null,
      }));
    } catch {
      devices = [];
    }
  }
  return {
    memory: {
      totalBytes: os.totalmem(),
      availableBytes: os.freemem(),
      pressure: pressureMatch ? 100 - Number(pressureMatch[1]) : null,
    },
    battery: {
      percent: batteryMatch ? Number(batteryMatch[1]) : null,
      charging: batteryText ? /charging|charged/i.test(batteryText) : null,
    },
    gpu: { devices, totalMemoryBytes: null, availableMemoryBytes: null },
  };
}

async function providerStatus({ ollamaBaseUrl, lmStudioBaseUrl, fetchImpl, signal }) {
  const probe = async (provider, baseUrl, endpoint) => {
    try {
      const response = await fetchImpl(new URL(endpoint, baseUrl), { signal });
      if (!response.ok) return [provider, { status: "unavailable", models: {} }];
      const body = await response.json();
      const listed = body.models ?? body.data ?? [];
      const models = {};
      const loadedModels = [];
      for (const model of listed) {
        const slug = model.key ?? model.id ?? model.name ?? model.model;
        if (!slug) continue;
        models[slug] = { status: "available", loaded: Boolean(model.loaded_instances?.length) };
        if (model.loaded_instances?.length) loadedModels.push(slug);
      }
      return [provider, { status: "available", models, loadedModels, queueDepth: body.queue_depth ?? null, baseUrl }];
    } catch {
      return [provider, { status: "unavailable", models: {}, loadedModels: [], queueDepth: null, baseUrl }];
    }
  };
  const entries = await Promise.all([
    probe("ollama", ollamaBaseUrl, "/api/tags"),
    probe("lmstudio", lmStudioBaseUrl, "/api/v1/models"),
  ]);
  return {
    openai: { status: "unknown", models: {} },
    ...Object.fromEntries(entries),
  };
}

function candidateStatus(definition, routes, providers) {
  return definition.effectiveCandidates.map((slug) => {
    const route = routes[slug];
    const upstream = route?.upstreamModel;
    const providerState = route?.provider ? providers[route.provider] : null;
    const liveModel = upstream ? providerState?.models?.[upstream] : null;
    const status = route?.provider === "openai"
      ? "unknown"
      : liveModel?.status ?? (route ? providerState?.status ?? "unknown" : "unavailable");
    return {
      slug,
      fallback: slug === definition.fallbackModel,
      provider: route?.provider ?? null,
      status,
      contextWindow: route?.contextWindow ?? null,
      capabilities: route?.capabilities ?? {},
    };
  });
}

export async function buildSelectorContext({
  definition,
  body,
  routes,
  ollamaBaseUrl,
  lmStudioBaseUrl,
  fetchImpl = globalThis.fetch,
  signal,
  source = "codex",
  telemetryImpl = machineTelemetry,
  providerStatusImpl = providerStatus,
}) {
  const messages = normalizeSelectorMessages(body);
  const [machine, providers] = await Promise.all([
    telemetryImpl(),
    providerStatusImpl({ ollamaBaseUrl, lmStudioBaseUrl, fetchImpl, signal }),
  ]);
  return {
    version: 1,
    syntheticModel: definition.slug,
    source,
    raw: structuredClone(body),
    messages,
    features: selectorFeatures(body, messages),
    candidates: candidateStatus(definition, routes, providers),
    machine,
    providers,
  };
}

async function assertSelectorUnchanged(definition) {
  const source = await readFile(definition.selectorPath);
  const hash = createHash("sha256").update(source).digest("hex");
  if (hash !== definition.selectorHash) {
    const error = new Error("Selector changed after refresh; run hydra refresh before using it");
    error.code = "HYDRA_SELECTOR_CHANGED";
    throw error;
  }
}

export async function runSyntheticSelector({ definition, context, signal }) {
  await assertSelectorUnchanged(definition);
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, {
      workerData: { selectorPath: definition.selectorPath, nonce: randomUUID(), context },
    });
    let settled = false;
    let timeout;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      worker.terminate().catch(() => {});
      callback(value);
    };
    const onAbort = () => {
      worker.postMessage({ type: "abort", reason: "Request cancelled" });
      const error = signal?.reason instanceof Error ? signal.reason : new DOMException("Request cancelled", "AbortError");
      finish(reject, error);
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (definition.selectorTimeoutMs > 0) {
      timeout = setTimeout(() => {
        worker.postMessage({ type: "abort", reason: "Selector timed out" });
        const error = new Error(`Selector timed out after ${definition.selectorTimeoutMs}ms`);
        error.code = "HYDRA_SELECTOR_TIMEOUT";
        finish(reject, error);
      }, definition.selectorTimeoutMs);
    }
    worker.on("message", (message) => {
      if (message?.type === "result") finish(resolve, message.result);
      else if (message?.type === "error") {
        const error = new Error(message.error?.message ?? "Selector failed");
        error.name = message.error?.name ?? "Error";
        error.code = message.error?.code;
        finish(reject, error);
      }
    });
    worker.on("error", (error) => finish(reject, error));
    worker.on("exit", (code) => {
      if (!settled && code !== 0) finish(reject, new Error(`Selector worker exited with code ${code}`));
    });
  });
}

export function validateSelectorTarget({ definition, target, context, routes }) {
  if (typeof target !== "string" || !target.trim()) throw new Error("Selector must return a model slug string");
  const slug = target.trim();
  if (slug.startsWith("hydra/")) throw new Error("Synthetic selectors cannot return synthetic models");
  if (!definition.effectiveCandidates.includes(slug)) throw new Error(`Selector returned model outside its allowlist: ${slug}`);
  const route = routes[slug];
  if (!route || route.provider === "synthetic") throw new Error(`Selected model is unavailable: ${slug}`);
  const features = context.features;
  if (route.contextWindow && features.actualContextTokens > route.contextWindow) {
    throw new Error(`Selected model context window is too small: ${slug}`);
  }
  if (features.hasImages && route.capabilities?.vision === false) throw new Error(`Selected model lacks vision: ${slug}`);
  if (features.toolCount > 0 && route.capabilities?.tools === false) throw new Error(`Selected model lacks tools: ${slug}`);
  return { slug, route };
}
