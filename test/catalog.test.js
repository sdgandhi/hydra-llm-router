import test from "node:test";
import assert from "node:assert/strict";
import { buildCatalog, normalizeOllamaSlug } from "../src/catalog.js";

test("normalizes Ollama model names under a collision-free namespace", () => {
  assert.equal(normalizeOllamaSlug("llama3.2:latest"), "ollama/llama3.2:latest");
});

test("builds a merged catalog and route table", async () => {
  const sourceCatalog = {
    client_version: "test",
    models: [
      {
        slug: "gpt-test",
        display_name: "GPT Test",
        visibility: "list",
        supported_in_api: true,
        priority: 1,
        context_window: 1000,
        max_context_window: 1000,
      },
    ],
  };
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      models: [{ name: "llama3.2:latest", details: { parameter_size: "3B" } }],
    }),
  });

  const result = await buildCatalog({
    sourceCatalog,
    ollamaBaseUrl: "http://127.0.0.1:11434",
    fetchImpl,
  });

  assert.deepEqual(
    result.catalog.models.map((model) => model.slug),
    ["gpt-test", "ollama/llama3.2:latest"],
  );
  assert.equal(result.routes["gpt-test"].provider, "openai");
  assert.equal(result.routes["ollama/llama3.2:latest"].provider, "ollama");
  assert.equal(result.routes["ollama/llama3.2:latest"].upstreamModel, "llama3.2:latest");
  assert.equal(result.catalog.models[1].supports_search_tool, false);
  assert.equal(result.catalog.models[1].web_search_tool_type, "text");
  assert.equal(result.catalog.models[1].supports_reasoning_summaries, true);
  assert.equal(result.catalog.models[1].use_responses_lite, false);
});

test("keeps cloud catalog usable if Ollama is unavailable", async () => {
  const sourceCatalog = {
    models: [{ slug: "gpt-test", display_name: "GPT Test", visibility: "list" }],
  };
  const fetchImpl = async () => {
    throw new Error("offline");
  };

  const result = await buildCatalog({
    sourceCatalog,
    ollamaBaseUrl: "http://127.0.0.1:11434",
    fetchImpl,
  });

  assert.deepEqual(
    result.catalog.models.map((model) => model.slug),
    ["gpt-test"],
  );
});
