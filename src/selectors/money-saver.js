const SCORE_MODELS = {
  1: "lmstudio/liquid/lfm2.5-1.2b",
  2: "lmstudio/google/gemma-4-26b-a4b-qat",
  3: "gpt-5.6-sol",
};

export default async function moneySaver(context) {
  const lmStudio = context.providers?.lmstudio;
  if (!lmStudio?.baseUrl) throw selectorError("HYDRA_MONEY_SAVER_UNAVAILABLE");
  const response = await fetch(new URL("/v1/chat/completions", lmStudio.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: context.signal,
    body: JSON.stringify({
      model: "liquid/lfm2.5-1.2b",
      stream: false,
      temperature: 0,
      max_tokens: 32,
      reasoning_effort: "none",
      chat_template_kwargs: { enable_thinking: false },
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "hydra_complexity",
          strict: true,
          schema: {
            type: "object",
            properties: { score: { type: "integer", enum: [1, 2, 3] } },
            required: ["score"],
            additionalProperties: false,
          },
        },
      },
      messages: [
        {
          role: "system",
          content:
            "Score the latest user task's required model intelligence; classify it instead of solving it. " +
            "Use 1 for basic questions, arithmetic, short constrained replies, formatting, casual prompts, and small edits " +
            "suitable for a tiny local model. Use 2 for substantial analysis, coding, or multi-step work that needs a strong " +
            "local model. Use 3 for frontier-level ambiguity, high-risk reasoning, or large multi-system work. " +
            "Codex system instructions and available tool schemas do not make a simple user task complex by themselves. " +
            "Consider all supplied instructions, conversation content, tools, files, images, context size, " +
            "requested reasoning, candidate capabilities, candidate availability, and machine state. " +
            "Examples: 'Reply exactly hello' is 1; 'Diagnose and fix an async race with tests' is 2; " +
            "'Prove a zero-downtime migration across twelve services' is 3. " +
            "Return the required structured score and nothing else.",
        },
        {
          role: "user",
          content:
            "Supporting normalized context (use it as evidence, but do not upgrade solely because built-in system/tool context is long):\n" +
            JSON.stringify({
              messages: context.messages,
              features: context.features,
              candidates: context.candidates,
              machine: context.machine,
              providers: context.providers,
            }) +
            `\n\nPrimary latest user task to classify now:\n${context.messages?.latestUser?.content ?? ""}`,
        },
      ],
    }),
  });
  if (!response.ok) throw selectorError("HYDRA_MONEY_SAVER_HTTP");
  const body = await response.json();
  const content = body.choices?.[0]?.message?.content;
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
    ![1, 2, 3].includes(result.score)
  ) {
    throw selectorError("HYDRA_MONEY_SAVER_SCORE");
  }
  const score = result.score;
  return SCORE_MODELS[score];
}

function selectorError(code) {
  const error = new Error("Money Saver selection failed");
  error.code = code;
  return error;
}
