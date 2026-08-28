const selectorModel = __HYDRA_SELECTOR_MODEL__;
const selectorPrompt = __HYDRA_SELECTOR_PROMPT__;
const selectorContextParts = new Set(__HYDRA_SELECTOR_CONTEXT_PARTS__);

export default async function select(context) {
  const candidates = context.candidates.map((candidate) => ({
    slug: candidate.slug,
    fallback: candidate.fallback,
    status: candidate.status,
    contextWindow: candidate.contextWindow,
    capabilities: candidate.capabilities,
  }));
  const messages = {};
  if (selectorContextParts.has("system")) {
    messages.system = context.messages.system;
    messages.developer = context.messages.developer;
  }
  if (selectorContextParts.has("history")) messages.history = context.messages.history;
  if (selectorContextParts.has("latest_user")) messages.latestUser = context.messages.latestUser;
  if (selectorContextParts.has("tools")) {
    messages.toolCalls = context.messages.toolCalls;
    messages.toolResults = context.messages.toolResults;
  }
  const requestContext = { messages };
  if (selectorContextParts.has("metadata")) {
    requestContext.features = context.features;
    requestContext.candidates = candidates;
    requestContext.machine = context.machine;
    requestContext.providers = context.providers;
  }
  const prompt = [
    selectorPrompt,
    "Return exactly one model slug from the allowed generation models. Return no explanation or formatting.",
    `Allowed generation models: ${candidates.map((candidate) => candidate.slug).join(", ")}`,
    "Hydra request context:",
    JSON.stringify(requestContext),
  ].join("\n\n");
  const result = await globalThis.__hydraCallSelectorModel({ model: selectorModel, prompt });
  if (typeof result !== "string" || !result.trim()) {
    const error = new Error("Selector model returned no target");
    error.code = "HYDRA_SELECTOR_MODEL_OUTPUT";
    throw error;
  }
  return result.trim();
}
