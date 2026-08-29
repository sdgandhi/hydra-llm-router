const scoreModels = [
  "lmstudio/liquid/lfm2.5-1.2b",
  "lmstudio/google/gemma-4-26b-a4b-qat",
  "gpt-5.6-sol",
];

export default async function moneySaver(context) {
  const requestContext = {
    latestUserMessage: context.messages?.latestUser ?? null,
    nonSystemPromptTokens: context.features?.nonSystemPromptTokens ?? 0,
    previousUserMessages: context.features?.previousUserMessages ?? 0,
    previousAgentMessages: context.features?.previousAgentMessages ?? 0,
  };
  const prompt = [
    "Choose the lowest-numbered model that can reliably complete the latest user request.",
    "Use 1 for basic questions, arithmetic, short constrained replies, formatting, casual prompts, and small edits. " +
      "Use 2 for substantial analysis, coding, or multi-step work. Use 3 for frontier-level ambiguity, high-risk reasoning, " +
      "or large multi-system work. Classify the task instead of solving it. Context length and prior message counts are " +
      "supporting evidence and should not make a simple latest request complex by themselves.",
    scoreModels.map((slug, index) => `${index + 1} = ${slug}`).join("\n"),
    "Return only the required structured selection.",
    JSON.stringify(requestContext),
  ].join("\n\n");
  const content = await globalThis.__hydraCallSelectorModel({
    prompt,
    selectionSlugs: scoreModels,
    contextSummary: {
      latestUserChars: JSON.stringify(requestContext.latestUserMessage).length,
      nonSystemPromptTokens: requestContext.nonSystemPromptTokens,
      previousUserMessages: requestContext.previousUserMessages,
      previousAgentMessages: requestContext.previousAgentMessages,
    },
  });
  let result;
  try {
    result = JSON.parse(content);
  } catch {
    throw selectorError("HYDRA_MONEY_SAVER_SCORE");
  }
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.keys(result).length !== 1 ||
    ![1, 2, 3].includes(result.selection)
  ) {
    throw selectorError("HYDRA_MONEY_SAVER_SCORE");
  }
  return result.selection;
}

function selectorError(code) {
  const error = new Error("Money Saver selection failed");
  error.code = code;
  return error;
}
