import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildSelectorContext,
  normalizeSelectorMessages,
  runSyntheticSelector,
  selectorContextDiagnostics,
  selectorFeatures,
  validateSelectorSelection,
  validateSelectorTarget,
} from "../src/synthetic.js";

test("separates selector messages and overestimates request tokens", () => {
  const body = {
    instructions: "system rules",
    input: [
      { role: "developer", content: "developer rules" },
      { role: "user", content: "older question" },
      { role: "assistant", content: "older answer" },
      { type: "function_call", call_id: "1", name: "tool", arguments: "{}" },
      { type: "function_call_output", call_id: "1", output: "result" },
      {
        role: "user",
        content: [
          { type: "input_text", text: "latest question" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          { type: "input_file", filename: "notes.txt" },
        ],
      },
    ],
    tools: [{ type: "function", name: "tool" }],
    reasoning: { effort: "high" },
  };
  const messages = normalizeSelectorMessages(body);
  const features = selectorFeatures(body, messages);
  assert.equal(messages.system[0].content, "system rules");
  assert.equal(messages.developer[0].content, "developer rules");
  assert.equal(messages.latestUser.content, "latest question");
  assert.equal(messages.toolCalls.length, 1);
  assert.equal(messages.toolResults.length, 1);
  assert.equal(features.imageCount, 1);
  assert.equal(features.explicitFileCount, 1);
  assert.equal(features.toolCount, 1);
  assert.equal(features.requestedReasoningEffort, "high");
  assert.equal(features.previousUserMessages, 1);
  assert.equal(features.previousAgentMessages, 1);
  assert.ok(features.nonSystemPromptTokens > features.approximateTokens.latestUser);
  assert.ok(features.actualContextTokens > body.instructions.length / 4);
});

test("summarizes selected context sections without retaining their content", () => {
  const diagnostics = selectorContextDiagnostics({
    instructions: "secret system prompt",
    input: [
      { role: "user", content: "older secret" },
      { role: "assistant", content: "older answer" },
      { role: "user", content: "latest secret" },
      { type: "function_call", name: "tool", arguments: "{}" },
    ],
  }, ["latest_user", "tools"]);
  assert.equal(diagnostics.system.included, false);
  assert.equal(diagnostics.history.items, 2);
  assert.equal(diagnostics.latestUser.included, true);
  assert.equal(diagnostics.tools.included, true);
  assert.equal(diagnostics.tools.calls.items, 1);
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret/);
});

test("builds selector context with candidates grouped provider state", async () => {
  const definition = definitionFixture();
  const routes = {
    "ollama/tiny": {
      provider: "ollama",
      upstreamModel: "tiny",
      contextWindow: 4096,
      capabilities: { tools: false, vision: false },
    },
    "gpt-test": {
      provider: "openai",
      upstreamModel: "gpt-test",
      contextWindow: 100000,
      capabilities: { tools: true, vision: true },
    },
  };
  const context = await buildSelectorContext({
    definition,
    body: { model: "hydra/smart", input: "hello" },
    routes,
    ollamaBaseUrl: "http://127.0.0.1:11434",
    lmStudioBaseUrl: "http://127.0.0.1:11239",
    telemetryImpl: async () => ({ memory: {}, battery: {}, gpu: {} }),
    providerStatusImpl: async () => ({
      openai: { status: "unknown", models: {} },
      ollama: { status: "available", models: { tiny: { status: "available" } } },
      lmstudio: { status: "unavailable", models: {} },
    }),
  });
  assert.equal(context.syntheticModel, "hydra/smart");
  assert.equal(context.candidates[0].status, "available");
  assert.equal(context.candidates[1].fallback, true);
  assert.equal(context.providers.ollama.status, "available");
  assert.equal(context.raw.input, "hello");
});

test("runs selectors in a worker and rejects changed selector files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hydra-selector-worker-"));
  const selectorPath = path.join(dir, "selector.js");
  await writeFile(selectorPath, 'export default async (context) => context.raw.selection;\n');
  const source = await readFile(selectorPath);
  const definition = {
    ...definitionFixture(),
    selectorPath,
    selectorHash: createHash("sha256").update(source).digest("hex"),
    selectorTimeoutMs: 1000,
  };
  const result = await runSyntheticSelector({ definition, context: { raw: { selection: 2 } } });
  assert.equal(result, 2);

  await writeFile(selectorPath, "export default () => 1;\n");
  await assert.rejects(runSyntheticSelector({ definition, context: { raw: {} } }), /run hydra refresh/);
});

test("rejects selector definitions without an explicit type", async () => {
  await assert.rejects(
    runSyntheticSelector({
      definition: { ...definitionFixture(), selectorType: undefined },
      context: {},
    }),
    (error) => error?.code === "HYDRA_SELECTOR_TYPE",
  );
});

test("times out selectors and validates target capabilities", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hydra-selector-timeout-"));
  const selectorPath = path.join(dir, "selector.js");
  await writeFile(selectorPath, "export default async () => new Promise(() => {});\n");
  const source = await readFile(selectorPath);
  const definition = {
    ...definitionFixture(),
    selectorPath,
    selectorHash: createHash("sha256").update(source).digest("hex"),
    selectorTimeoutMs: 20,
  };
  await assert.rejects(runSyntheticSelector({ definition, context: {} }), /timed out/);

  const context = { features: { actualContextTokens: 100, hasImages: true, toolCount: 0 } };
  const routes = {
    "ollama/tiny": {
      provider: "ollama",
      contextWindow: 4096,
      capabilities: { vision: false, tools: false },
    },
  };
  assert.throws(
    () => validateSelectorTarget({ definition, target: "ollama/tiny", context, routes }),
    /lacks vision/,
  );
  assert.throws(
    () => validateSelectorTarget({ definition, target: "ollama/not-allowed", context, routes }),
    /outside its allowlist/,
  );
  assert.throws(
    () => validateSelectorSelection({ definition, selection: "ollama/tiny", context, routes }),
    /integer selection/,
  );
  assert.equal(
    validateSelectorSelection({ definition, selection: 1, context: { features: { actualContextTokens: 1 } }, routes }).slug,
    "ollama/tiny",
  );
});

test("aborts an in-flight selector model call when the selector times out", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hydra-selector-model-timeout-"));
  const selectorPath = path.join(dir, "selector.js");
  await writeFile(
    selectorPath,
    'export default () => globalThis.__hydraCallSelectorModel({ prompt: "choose", selectionSlugs: ["ollama/tiny", "gpt-test"] });\n',
  );
  const source = await readFile(selectorPath);
  const definition = {
    ...definitionFixture(),
    selectorPath,
    selectorHash: createHash("sha256").update(source).digest("hex"),
    selectorTimeoutMs: 20,
  };
  let aborted = false;
  await assert.rejects(
    runSyntheticSelector({
      definition,
      context: {},
      callModel: ({ signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true });
      }),
    }),
    /timed out/,
  );
  assert.equal(aborted, true);
});

test("rejects legacy selector-model calls without a numbered mapping", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hydra-selector-model-legacy-"));
  const selectorPath = path.join(dir, "selector.js");
  await writeFile(
    selectorPath,
    'export default () => globalThis.__hydraCallSelectorModel({ prompt: "choose" });\n',
  );
  const source = await readFile(selectorPath);
  const definition = {
    ...definitionFixture(),
    selectorPath,
    selectorHash: createHash("sha256").update(source).digest("hex"),
  };
  await assert.rejects(
    runSyntheticSelector({ definition, context: {}, callModel: async () => "ollama/tiny" }),
    /numbered selection mapping/,
  );
});

test("rejects legacy selectors that return model slugs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hydra-selector-legacy-output-"));
  const selectorPath = path.join(dir, "selector.js");
  await writeFile(selectorPath, 'export default () => "ollama/tiny";\n');
  const source = await readFile(selectorPath);
  const definition = {
    ...definitionFixture(),
    selectorPath,
    selectorHash: createHash("sha256").update(source).digest("hex"),
  };
  await assert.rejects(
    runSyntheticSelector({ definition, context: {} }),
    /integer selection/,
  );
});

function definitionFixture() {
  return {
    slug: "hydra/smart",
    selectorType: "custom",
    candidates: ["ollama/tiny"],
    fallbackModel: "gpt-test",
    effectiveCandidates: ["ollama/tiny", "gpt-test"],
    routingScope: "user_turn",
    stickyToolContinuations: true,
    selectorTimeoutMs: 0,
    retryCount: 2,
    retryDelayMs: 1000,
  };
}
