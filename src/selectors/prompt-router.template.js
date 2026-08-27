const selectorModel = __HYDRA_SELECTOR_MODEL__;
const selectorPrompt = __HYDRA_SELECTOR_PROMPT__;

export default async function select(context) {
  const candidates = context.candidates.map((candidate) => ({
    slug: candidate.slug,
    fallback: candidate.fallback,
    status: candidate.status,
    contextWindow: candidate.contextWindow,
    capabilities: candidate.capabilities,
  }));
  const prompt = [
    selectorPrompt,
    "Return exactly one model slug from the allowed generation models. Return no explanation or formatting.",
    `Allowed generation models: ${candidates.map((candidate) => candidate.slug).join(", ")}`,
    "Hydra request context:",
    JSON.stringify({
      messages: context.messages,
      features: context.features,
      candidates,
      machine: context.machine,
      providers: context.providers,
    }),
  ].join("\n\n");
  const result = await globalThis.__hydraCallSelectorModel({ model: selectorModel, prompt });
  if (typeof result !== "string" || !result.trim()) {
    const error = new Error("Selector model returned no target");
    error.code = "HYDRA_SELECTOR_MODEL_OUTPUT";
    throw error;
  }
  return result.trim();
}
