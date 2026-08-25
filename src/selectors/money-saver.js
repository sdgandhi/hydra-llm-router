const SCORE_MODELS = {
  1: "lmstudio/liquid/lfm2.5-1.2b",
  2: "lmstudio/google/gemma-4-26b-a4b-qat",
  3: "gpt-5.6-sol",
};

export default async function moneySaver(context) {
  const lmStudio = context.providers?.lmstudio;
  if (!lmStudio?.baseUrl) throw new Error("LM Studio is unavailable for Money Saver classification");
  const response = await fetch(new URL("/v1/chat/completions", lmStudio.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: context.signal,
    body: JSON.stringify({
      model: "liquid/lfm2.5-1.2b",
      stream: false,
      temperature: 0,
      max_tokens: 4,
      reasoning_effort: "none",
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        {
          role: "system",
          content:
            "Score the task's required model intelligence from 1 to 3. " +
            "1 is simple and suitable for a tiny local model. " +
            "2 needs a strong local model. 3 needs the strongest cloud model. " +
            "Consider all supplied instructions, conversation content, tools, files, images, context size, " +
            "requested reasoning, candidate capabilities, candidate availability, and machine state. " +
            "Return exactly one character: 1, 2, or 3.",
        },
        {
          role: "user",
          content: JSON.stringify({
            messages: context.messages,
            features: context.features,
            candidates: context.candidates,
            machine: context.machine,
            providers: context.providers,
          }),
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Money Saver classifier failed with HTTP ${response.status}`);
  const body = await response.json();
  const score = body.choices?.[0]?.message?.content?.trim();
  if (!/^[123]$/.test(score ?? "")) throw new Error("Money Saver classifier returned an invalid score");
  return SCORE_MODELS[score];
}
