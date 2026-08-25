import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

const controller = new AbortController();
parentPort.on("message", (message) => {
  if (message?.type === "abort" && !controller.signal.aborted) {
    controller.abort(new DOMException(message.reason ?? "Selector cancelled", "AbortError"));
  }
});

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
