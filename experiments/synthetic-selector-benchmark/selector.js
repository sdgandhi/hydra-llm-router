import { GENERATION_MODELS, variantBySyntheticSlug } from "./variants.js";

const allowed = Object.values(GENERATION_MODELS);
function selectionForModel(model) {
  const index = allowed.indexOf(model);
  if (index < 0) throw new Error(`Benchmark selector returned an unknown model: ${model}`);
  return index + 1;
}
const rubric = `Classify the generation task by the smallest model that can complete it reliably.
LOW: short, deterministic, single-step work such as arithmetic, extraction, translation, formatting, rewriting, or a brief definition. No consequential judgment.
MEDIUM: bounded multi-step analysis, ordinary coding/debugging, comparisons, test plans, or one straightforward tool workflow.
HIGH: high-stakes medical/legal/security judgment, deep formal reasoning, complex distributed systems, major migrations/refactors, or conflicting system-wide constraints.
Judge the task requested by the latest user, not isolated words such as "complex".`;

const fewshot = `${rubric}
Examples:
"Alphabetize three names" -> ${GENERATION_MODELS.low}
"Implement a bounded retry helper and tests" -> ${GENERATION_MODELS.medium}
"Threat-model a multi-tenant identity system" -> ${GENERATION_MODELS.high}`;

const calibratedRubric = `Choose the lowest sufficient complexity tier for the latest task.
LOW includes all short transformations: arithmetic, conversion, extraction, translation, formatting a few items, rewriting one sentence, sentiment classification, typo fixes, and brief beginner definitions. These remain LOW even when wording mentions formatting, explanation, or the word "complex".
MEDIUM includes normal bounded professional work: one function plus tests, a contained bug diagnosis and fix, a SQL query plus index, a comparison across several dimensions, a small API design, algorithm analysis, a focused test plan, a small multi-file refactor, multi-step trend calculations, or one straightforward tool workflow.
HIGH is reserved for consequential medical/legal/security judgment, formal proofs under subtle concurrency semantics, multi-region consistency, major production migrations or incidents, very large refactors, specialized GPU optimization, or system-wide conflicting requirements.
Do not choose HIGH merely because a task requests analysis. Prefer LOW over MEDIUM and MEDIUM over HIGH when the lower tier is explicitly covered.`;

const boundaryRubric = `${rubric}
Boundary reminders: formatting a short list, rewriting one sentence, a brief definition, and literal constrained output are LOW. A protocol comparison, small idempotent API design, or one calendar-tool workflow are MEDIUM. They are not HIGH. Reserve HIGH for consequential judgment or system-wide/deeply specialized work.`;

const boundaryExamplesRubric = `${boundaryRubric}
Boundary examples:
"Return exactly the word sophisticated" -> LOW, because literal output is trivial regardless of the word.
"Design one idempotent endpoint with validation and errors" -> MEDIUM.
"Use one named tool once, then summarize" -> MEDIUM.
"Compare two protocols across several dimensions" -> MEDIUM.`;

function instructionsFor(variant) {
  if (variant.prompt === "fewshot") return fewshot;
  if (variant.prompt === "calibrated") return calibratedRubric;
  if (variant.prompt === "boundary") return boundaryRubric;
  if (variant.prompt === "boundary_examples") return boundaryExamplesRubric;
  return rubric;
}

function contentText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return JSON.stringify(message.content ?? "");
}

function requestContext(context, mode) {
  const latestUser = contentText(context.messages.latestUser);
  if (mode === "latest") return { latestUser };
  if (mode === "latest_metadata") {
    return {
      latestUser,
      approximateTokens: context.features.approximateTokens,
      imageCount: context.features.imageCount,
      explicitFileCount: context.features.explicitFileCount,
      toolCount: context.features.toolCount,
      requestedReasoningEffort: context.features.requestedReasoningEffort,
    };
  }
  return {
    messages: context.messages,
    features: context.features,
    candidates: context.candidates,
    machine: context.machine,
    providers: context.providers,
  };
}

function schemaFor(output) {
  if (output === "model_json") {
    return {
      type: "json_schema",
      json_schema: {
        name: "model_selection",
        strict: true,
        schema: {
          type: "object",
          properties: { model: { type: "string", enum: allowed } },
          required: ["model"],
          additionalProperties: false,
        },
      },
    };
  }
  if (output === "score_json") {
    return {
      type: "json_schema",
      json_schema: {
        name: "complexity_selection",
        strict: true,
        schema: {
          type: "object",
          properties: { complexity: { type: "string", enum: ["low", "medium", "high"] } },
          required: ["complexity"],
          additionalProperties: false,
        },
      },
    };
  }
  if (output === "reason_score_json") {
    return {
      type: "json_schema",
      json_schema: {
        name: "reasoned_complexity_selection",
        strict: true,
        schema: {
          type: "object",
          properties: {
            reason: { type: "string" },
            complexity: { type: "string", enum: ["low", "medium", "high"] },
          },
          required: ["reason", "complexity"],
          additionalProperties: false,
        },
      },
    };
  }
  if (output === "number_json") {
    return {
      type: "json_schema",
      json_schema: {
        name: "complexity_score",
        strict: true,
        schema: {
          type: "object",
          properties: { score: { type: "integer", enum: [1, 2, 3] } },
          required: ["score"],
          additionalProperties: false,
        },
      },
    };
  }
  return undefined;
}

function selectorPrompt(variant, context) {
  const instructions = instructionsFor(variant);
  const outputInstruction = variant.output === "direct"
    ? `Return exactly one slug and nothing else: ${allowed.join(" | ")}`
    : variant.output === "model_json"
      ? "Return the selected model in the required JSON object."
      : variant.output === "number_json"
        ? "Return score 1 for LOW, 2 for MEDIUM, or 3 for HIGH in the required JSON object."
        : variant.output === "reason_score_json"
          ? "Briefly identify the decisive requirement, then return LOW, MEDIUM, or HIGH in the required JSON object."
          : "Return LOW, MEDIUM, or HIGH in the required JSON object.";
  if (variant.prompt === "baseline") {
    return [
      "Choose the smallest suitable generation model.",
      `Return exactly one model slug from: ${allowed.join(", ")}. Return no explanation or formatting.`,
      "Hydra request context:",
      JSON.stringify(requestContext(context, variant.context)),
    ].join("\n\n");
  }
  if (variant.prompt === "task_first") {
    return [JSON.stringify(requestContext(context, variant.context)), instructions, outputInstruction].join("\n\n");
  }
  if (variant.prompt === "task_first_boundary") {
    return [JSON.stringify(requestContext(context, variant.context)), boundaryExamplesRubric, outputInstruction].join("\n\n");
  }
  return [instructions, outputInstruction, JSON.stringify(requestContext(context, variant.context))].join("\n\n");
}

function responseText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part?.text ?? "").join("");
}

function parseSelection(output, mode) {
  if (mode === "direct") return output.trim();
  const parsed = JSON.parse(output);
  if (mode === "model_json") return parsed.model;
  if (mode === "number_json") return GENERATION_MODELS[{ 1: "low", 2: "medium", 3: "high" }[parsed.score]];
  return GENERATION_MODELS[parsed.complexity];
}

async function callLocalModel({ baseUrl, variant, prompt, messages, responseFormat, maxTokens = 64, signal }) {
  const body = {
    model: variant.selectorModel.replace(/^lmstudio\//, ""),
    messages: messages ?? [{ role: "user", content: prompt }],
    stream: false,
    temperature: variant.temperature,
    max_tokens: maxTokens,
    seed: 42,
    reasoning_effort: "none",
    chat_template_kwargs: { enable_thinking: false },
  };
  if (variant.topP != null) body.top_p = variant.topP;
  if (variant.topK != null) body.top_k = variant.topK;
  if (responseFormat) body.response_format = responseFormat;
  const response = await fetch(new URL("/v1/chat/completions", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new Error(`Benchmark selector failed with HTTP ${response.status}`);
  const data = await response.json();
  const output = responseText(data?.choices?.[0]?.message?.content);
  if (!output.trim()) throw new Error("Benchmark selector returned no output");
  return output;
}

async function binarySelection({ baseUrl, variant, context }) {
  const task = JSON.stringify(requestContext(context, "latest"));
  const binaryRubric = instructionsFor(variant);
  const booleanSchema = (name, property) => ({
    type: "json_schema",
    json_schema: {
      name,
      strict: true,
      schema: {
        type: "object",
        properties: { [property]: { type: "boolean" } },
        required: [property],
        additionalProperties: false,
      },
    },
  });
  const highOutput = await callLocalModel({
    baseUrl,
    variant,
    prompt: `${binaryRubric}\n\nIs this task HIGH?\n\n${task}`,
    responseFormat: booleanSchema("high_complexity", "high"),
    signal: context.signal,
  });
  if (JSON.parse(highOutput).high) return GENERATION_MODELS.high;
  const lowOutput = await callLocalModel({
    baseUrl,
    variant,
    prompt: `${binaryRubric}\n\nThis task is not HIGH. Is it LOW rather than MEDIUM?\n\n${task}`,
    responseFormat: booleanSchema("low_complexity", "low"),
    signal: context.signal,
  });
  return JSON.parse(lowOutput).low ? GENERATION_MODELS.low : GENERATION_MODELS.medium;
}

export default async function select(context) {
  const variant = variantBySyntheticSlug(context.syntheticModel);
  if (!variant) throw new Error(`Unknown benchmark variant: ${context.syntheticModel}`);
  const baseUrl = context.providers.lmstudio?.baseUrl;
  if (!baseUrl) throw new Error("LM Studio is unavailable to the benchmark selector");
  if (variant.output === "binary_json") {
    return selectionForModel(await binarySelection({ baseUrl, variant, context }));
  }
  const responseFormat = schemaFor(variant.output);
  const messages = variant.messageLayout === "system_user"
    ? [
        { role: "system", content: instructionsFor(variant) },
        {
          role: "user",
          content: `Return LOW, MEDIUM, or HIGH in the required JSON object.\n\n${JSON.stringify(requestContext(context, variant.context))}`,
        },
      ]
    : undefined;
  const output = await callLocalModel({
    baseUrl,
    variant,
    prompt: selectorPrompt(variant, context),
    messages,
    responseFormat,
    maxTokens: variant.output === "reason_score_json" ? 128 : 64,
    signal: context.signal,
  });
  return selectionForModel(parseSelection(output, variant.output));
}
