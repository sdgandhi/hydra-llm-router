const selectorModel = __HYDRA_SELECTOR_MODEL__;
const selectorPrompt = __HYDRA_SELECTOR_PROMPT__;
const scoreModels = __HYDRA_SELECTOR_SCORE_MODELS__;
const selectionValues = scoreModels.map((_, index) => index + 1);

export default async function select(context) {
  const requestContext = {
    latestUserMessage: context.messages?.latestUser ?? null,
    nonSystemPromptTokens: context.features?.nonSystemPromptTokens ?? 0,
    previousUserMessages: context.features?.previousUserMessages ?? 0,
    previousAgentMessages: context.features?.previousAgentMessages ?? 0,
  };
  const scoreMapping = scoreModels.map((slug, index) => `${index + 1} = ${slug}`).join("\n");
  const prompt = [
    selectorPrompt,
    "Choose exactly one routing number from the authoritative mapping below.",
    scoreMapping,
    "Return only the required structured selection. Do not solve the request or add an explanation.",
    "Request to classify:",
    JSON.stringify(requestContext),
  ].join("\n\n");
  const result = await globalThis.__hydraCallSelectorModel({
    model: selectorModel,
    prompt,
    selectionSlugs: scoreModels,
    contextSummary: {
      latestUserChars: JSON.stringify(requestContext.latestUserMessage).length,
      nonSystemPromptTokens: requestContext.nonSystemPromptTokens,
      previousUserMessages: requestContext.previousUserMessages,
      previousAgentMessages: requestContext.previousAgentMessages,
    },
  });
  if (typeof result !== "string" || !result.trim()) {
    const error = new Error("Selector model returned no target");
    error.code = "HYDRA_SELECTOR_MODEL_OUTPUT";
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(result);
  } catch {
    const error = new Error("Selector model returned an invalid selection");
    error.code = "HYDRA_SELECTOR_MODEL_OUTPUT";
    throw error;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 1 ||
    !selectionValues.includes(parsed.selection)
  ) {
    const error = new Error("Selector model returned an invalid selection");
    error.code = "HYDRA_SELECTOR_MODEL_OUTPUT";
    throw error;
  }
  return scoreModels[parsed.selection - 1];
}
