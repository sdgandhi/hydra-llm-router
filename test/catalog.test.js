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
  const fetchImpl = async (url, options = {}) => {
    if (url.pathname === "/api/tags") {
      return {
        ok: true,
        json: async () => ({
          models: [{ name: "llama3.2:latest", details: { parameter_size: "3B" } }],
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        capabilities: [],
        model_info: { "llama.context_length": 4096 },
      }),
    };
  };

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
  assert.equal(result.catalog.models[1].context_window, 4096);
  assert.deepEqual(result.routes["ollama/llama3.2:latest"].capabilities, {
    thinking: false,
    tools: false,
    vision: false,
    webSearch: false,
  });
});

test("advertises Ollama capabilities from /api/show", async () => {
  const sourceCatalog = {
    models: [{ slug: "gpt-test", display_name: "GPT Test", visibility: "list" }],
  };
  const fetchImpl = async (url, options = {}) => {
    if (url.pathname === "/api/tags") {
      return {
        ok: true,
        json: async () => ({
          models: [{ name: "qwen3.5:2b", details: { parameter_size: "2B", context_length: 8192 } }],
        }),
      };
    }
    assert.equal(JSON.parse(options.body).model, "qwen3.5:2b");
    return {
      ok: true,
      json: async () => ({
        capabilities: ["completion", "thinking", "tools", "vision"],
        model_info: { "qwen.context_length": 16384 },
      }),
    };
  };

  const result = await buildCatalog({
    sourceCatalog,
    ollamaBaseUrl: "http://127.0.0.1:11434",
    fetchImpl,
    webSearchReady: true,
  });
  const local = result.catalog.models[1];

  assert.equal(local.default_reasoning_level, "medium");
  assert.deepEqual(local.supported_reasoning_levels, [
    {
      effort: "medium",
      description: "Use Ollama thinking mode when supported by the local model.",
    },
  ]);
  assert.deepEqual(local.input_modalities, ["text", "image"]);
  assert.equal(local.supports_parallel_tool_calls, true);
  assert.equal(local.supports_search_tool, true);
  assert.equal(local.context_window, 8192);
  assert.deepEqual(result.routes["ollama/qwen3.5:2b"].capabilities, {
    thinking: true,
    tools: true,
    vision: true,
    webSearch: true,
  });
});

test("does not advertise web search when local search is unavailable", async () => {
  const sourceCatalog = {
    models: [{ slug: "gpt-test", display_name: "GPT Test", visibility: "list" }],
  };
  const fetchImpl = async (url) => {
    if (url.pathname === "/api/tags") {
      return {
        ok: true,
        json: async () => ({ models: [{ name: "tool-model", details: {} }] }),
      };
    }
    return {
      ok: true,
      json: async () => ({ capabilities: ["tools"] }),
    };
  };

  const result = await buildCatalog({
    sourceCatalog,
    ollamaBaseUrl: "http://127.0.0.1:11434",
    fetchImpl,
    webSearchReady: false,
  });

  assert.equal(result.catalog.models[1].supports_parallel_tool_calls, true);
  assert.equal(result.catalog.models[1].supports_search_tool, false);
  assert.deepEqual(result.routes["ollama/tool-model"].capabilities, {
    thinking: false,
    tools: true,
    vision: false,
    webSearch: false,
  });
});

test("uses HYDRA_OLLAMA_CONTEXT_WINDOW before Ollama context metadata", async () => {
  const original = process.env.HYDRA_OLLAMA_CONTEXT_WINDOW;
  process.env.HYDRA_OLLAMA_CONTEXT_WINDOW = "12345";
  try {
    const result = await buildCatalog({
      sourceCatalog: { models: [{ slug: "gpt-test", display_name: "GPT Test", visibility: "list" }] },
      ollamaBaseUrl: "http://127.0.0.1:11434",
      fetchImpl: async (url) => {
        if (url.pathname === "/api/tags") {
          return {
            ok: true,
            json: async () => ({ models: [{ name: "context-model", details: { context_length: 8192 } }] }),
          };
        }
        return {
          ok: true,
          json: async () => ({ capabilities: [], model_info: { "model.context_length": 16384 } }),
        };
      },
    });

    assert.equal(result.catalog.models[1].context_window, 12345);
  } finally {
    if (original === undefined) delete process.env.HYDRA_OLLAMA_CONTEXT_WINDOW;
    else process.env.HYDRA_OLLAMA_CONTEXT_WINDOW = original;
  }
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
