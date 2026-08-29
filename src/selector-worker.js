import { randomUUID } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

const controller = new AbortController();
const modelCalls = new Map();
parentPort.on("message", (message) => {
  if (message?.type === "abort" && !controller.signal.aborted) {
    controller.abort(new DOMException(message.reason ?? "Selector cancelled", "AbortError"));
  }
  if (message?.type === "model_call_result") {
    const pending = modelCalls.get(message.id);
    if (!pending) return;
    modelCalls.delete(message.id);
    if (message.error) {
      const error = new Error(message.error.message ?? "Selector model call failed");
      error.code = message.error.code;
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
  }
});

globalThis.__hydraCallSelectorModel = ({ prompt, selectionSlugs, contextSummary }) => {
  if (!Array.isArray(selectionSlugs) || selectionSlugs.length === 0) {
    const error = new Error("Selector model calls require a numbered selection mapping");
    error.code = "HYDRA_SELECTOR_MODEL_REQUEST";
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    modelCalls.set(id, { resolve, reject });
    parentPort.postMessage({ type: "model_call", id, prompt, selectionSlugs, contextSummary });
  });
};

try {
  const moduleUrl = pathToFileURL(workerData.selectorPath);
  moduleUrl.searchParams.set("hydra_selector", workerData.nonce);
  const selectorModule = await import(moduleUrl.href);
  const selector = selectorModule.default;
  if (typeof selector !== "function") throw new Error("Selector module must export a default function");
  const result = await selector(Object.freeze({ ...workerData.context, signal: controller.signal }));
  parentPort.postMessage({ type: "result", result });
} catch (error) {
  parentPort.postMessage({
    type: "error",
    error: {
      name: error?.name ?? "Error",
      code: error?.code,
      message: error?.message ?? String(error),
    },
  });
}
