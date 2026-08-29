export const GENERATION_MODELS = {
  low: "lmstudio/liquid/lfm2.5-1.2b",
  medium: "lmstudio/google/gemma-4-26b-a4b-qat",
  high: "gpt-5.6-sol",
};

const liquid = "lmstudio/liquid/lfm2.5-1.2b";
const gemma = "lmstudio/google/gemma-4-26b-a4b-qat";

export const VARIANTS = [
  { id: "liquid-baseline-all-direct", selectorModel: liquid, context: "all", prompt: "baseline", output: "direct", temperature: 0 },
  { id: "liquid-latest-direct", selectorModel: liquid, context: "latest", prompt: "rubric", output: "direct", temperature: 0 },
  { id: "liquid-latest-metadata-direct", selectorModel: liquid, context: "latest_metadata", prompt: "rubric", output: "direct", temperature: 0 },
  { id: "liquid-latest-fewshot-direct", selectorModel: liquid, context: "latest", prompt: "fewshot", output: "direct", temperature: 0 },
  { id: "liquid-latest-model-json", selectorModel: liquid, context: "latest", prompt: "rubric", output: "model_json", temperature: 0 },
  { id: "liquid-latest-score-json", selectorModel: liquid, context: "latest", prompt: "rubric", output: "score_json", temperature: 0 },
  { id: "liquid-metadata-score-json", selectorModel: liquid, context: "latest_metadata", prompt: "rubric", output: "score_json", temperature: 0 },
  { id: "liquid-latest-number-json", selectorModel: liquid, context: "latest", prompt: "numeric", output: "number_json", temperature: 0 },
  { id: "liquid-all-score-json", selectorModel: liquid, context: "all", prompt: "rubric", output: "score_json", temperature: 0 },
  { id: "liquid-latest-fewshot-score-json", selectorModel: liquid, context: "latest", prompt: "fewshot", output: "score_json", temperature: 0 },
  { id: "liquid-latest-boundary-score-json", selectorModel: liquid, context: "latest", prompt: "boundary", output: "score_json", temperature: 0 },
  { id: "liquid-latest-boundary-examples-score-json", selectorModel: liquid, context: "latest", prompt: "boundary_examples", output: "score_json", temperature: 0 },
  { id: "liquid-task-first-boundary-score-json", selectorModel: liquid, context: "latest", prompt: "task_first_boundary", output: "score_json", temperature: 0 },
  { id: "liquid-system-user-boundary-score-json", selectorModel: liquid, context: "latest", prompt: "boundary_examples", output: "score_json", temperature: 0, messageLayout: "system_user" },
  { id: "liquid-latest-task-first-score-json", selectorModel: liquid, context: "latest", prompt: "task_first", output: "score_json", temperature: 0 },
  { id: "liquid-latest-rubric-binary-json", selectorModel: liquid, context: "latest", prompt: "rubric", output: "binary_json", temperature: 0 },
  { id: "liquid-latest-calibrated-score-json", selectorModel: liquid, context: "latest", prompt: "calibrated", output: "score_json", temperature: 0 },
  { id: "liquid-latest-calibrated-number-json", selectorModel: liquid, context: "latest", prompt: "calibrated", output: "number_json", temperature: 0 },
  { id: "liquid-latest-reason-score-json", selectorModel: liquid, context: "latest", prompt: "calibrated", output: "reason_score_json", temperature: 0 },
  { id: "liquid-latest-binary-json", selectorModel: liquid, context: "latest", prompt: "calibrated", output: "binary_json", temperature: 0 },
  { id: "gemma-baseline-all-direct", selectorModel: gemma, context: "all", prompt: "baseline", output: "direct", temperature: 0 },
  { id: "gemma-latest-direct", selectorModel: gemma, context: "latest", prompt: "rubric", output: "direct", temperature: 0 },
  { id: "gemma-latest-score-json", selectorModel: gemma, context: "latest", prompt: "rubric", output: "score_json", temperature: 0 },
  { id: "gemma-all-score-json", selectorModel: gemma, context: "all", prompt: "rubric", output: "score_json", temperature: 0 },
  { id: "gemma-latest-score-json-google-sampling", selectorModel: gemma, context: "latest", prompt: "rubric", output: "score_json", temperature: 1, topP: 0.95, topK: 64 }
];

export function variantBySyntheticSlug(slug) {
  const id = slug.replace(/^hydra\/bench-/, "");
  return VARIANTS.find((variant) => variant.id === id);
}
