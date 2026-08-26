import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCatalog,
  catalogModelTitles,
  normalizeLMStudioSlug,
  normalizeOllamaSlug,
} from "../src/catalog.js";

test("normalizes Ollama model names under a collision-free namespace", () => {
  assert.equal(normalizeOllamaSlug("llama3.2:latest"), "ollama/llama3.2:latest");
});

test("normalizes LM Studio model names under a collision-free namespace", () => {
  assert.equal(normalizeLMStudioSlug("qwen3-4b"), "lmstudio/qwen3-4b");
});

test("extracts catalog model slugs in display order", () => {
  assert.deepEqual(
    catalogModelTitles({
      models: [{ slug: "gpt-5.5" }, { slug: "ollama/llama3.2:latest" }],
    }),
    ["gpt-5.5", "ollama/llama3.2:latest"],
  );
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

test("uses the configured Ollama context window before provider metadata", async () => {
  const result = await buildCatalog({
      sourceCatalog: { models: [{ slug: "gpt-test", display_name: "GPT Test", visibility: "list" }] },
      ollamaBaseUrl: "http://127.0.0.1:11434",
      ollamaContextWindow: 12345,
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

test("adds models advertised by LM Studio", async () => {
  const sourceCatalog = {
    models: [{ slug: "gpt-test", display_name: "GPT Test", visibility: "list", context_window: 1000 }],
  };
  const fetchImpl = async (url) => {
    if (url.port === "11434") throw new Error("Ollama offline");
    assert.equal(url.toString(), "http://127.0.0.1:11239/api/v1/models");
    return {
      ok: true,
      json: async () => ({
        models: [
          {
            type: "llm",
            key: "qwen3-4b",
            max_context_length: 65536,
            params_string: "4B",
            capabilities: { vision: true, trained_for_tool_use: true, reasoning: { default: "on" } },
          },
          { type: "embedding", key: "embed-model", max_context_length: 2048 },
        ],
      }),
    };
  };

  const result = await buildCatalog({
    sourceCatalog,
    ollamaBaseUrl: "http://127.0.0.1:11434",
    lmStudioBaseUrl: "http://127.0.0.1:11239",
    fetchImpl,
    webSearchReady: true,
  });

  assert.deepEqual(
    result.catalog.models.map((model) => model.slug),
    ["gpt-test", "lmstudio/qwen3-4b"],
  );
  assert.equal(result.catalog.models[1].display_name, "LM Studio: qwen3-4b");
  assert.equal(result.catalog.models[1].context_window, 65536);
  assert.deepEqual(result.catalog.models[1].input_modalities, ["text", "image"]);
  assert.equal(result.catalog.models[1].default_reasoning_level, "medium");
  assert.equal(result.catalog.models[1].supports_search_tool, true);
  assert.deepEqual(result.catalog.models[1].supported_reasoning_levels, [
    { effort: "low", description: "Disable LM Studio reasoning for this chat." },
    { effort: "medium", description: "Use LM Studio reasoning when supported by the local model." },
    { effort: "high", description: "Use a high amount of LM Studio reasoning." },
  ]);
  assert.deepEqual(result.routes["lmstudio/qwen3-4b"], {
    provider: "lmstudio",
    upstreamModel: "qwen3-4b",
    capabilities: { thinking: true, tools: true, vision: true, webSearch: true },
    contextWindow: 65536,
  });
});

test("adds synthetic models with conservative capabilities and maximum context", async () => {
  const sourceCatalog = {
    models: [
      {
        slug: "gpt-test",
        display_name: "GPT Test",
        visibility: "list",
        context_window: 100000,
        input_modalities: ["text", "image"],
        supports_parallel_tool_calls: true,
        supports_search_tool: true,
        supported_reasoning_levels: [{ effort: "high" }],
      },
    ],
  };
  const result = await buildCatalog({
    sourceCatalog,
    ollamaBaseUrl: "http://127.0.0.1:11434",
    lmStudioBaseUrl: "http://127.0.0.1:11239",
    fetchImpl: async (url) => {
      if (url.pathname === "/api/tags") {
        return { ok: true, json: async () => ({ models: [{ name: "tiny", details: { context_length: 4096 } }] }) };
      }
      if (url.pathname === "/api/show") {
        return { ok: true, json: async () => ({ capabilities: [] }) };
      }
      return { ok: true, json: async () => ({ models: [] }) };
    },
    syntheticDefinitions: [
      {
        slug: "hydra/smart",
        displayName: "Hydra: Smart",
        description: "Synthetic test model.",
        candidates: ["ollama/tiny"],
        fallbackModel: "gpt-test",
        effectiveCandidates: ["ollama/tiny", "gpt-test"],
      },
    ],
  });

  const synthetic = result.catalog.models.at(-1);
  assert.equal(synthetic.slug, "hydra/smart");
  assert.equal(synthetic.context_window, 100000);
  assert.deepEqual(synthetic.input_modalities, ["text"]);
  assert.equal(synthetic.supports_parallel_tool_calls, false);
  assert.deepEqual(
    synthetic.supported_reasoning_levels.map(({ effort }) => effort),
    ["low", "medium", "high"],
  );
  assert.equal(result.routes["hydra/smart"].provider, "synthetic");
  assert.equal(result.routes["hydra/smart"].definition.fallbackModel, "gpt-test");
});

test("advertises LM Studio effort levels and default from native metadata", async () => {
  const result = await buildCatalog({
    sourceCatalog: { models: [{ slug: "gpt-test", display_name: "GPT Test", visibility: "list" }] },
    ollamaBaseUrl: "http://127.0.0.1:11434",
    lmStudioBaseUrl: "http://127.0.0.1:11239",
    fetchImpl: async (url) => {
      if (url.port === "11434") throw new Error("Ollama offline");
      return {
        ok: true,
        json: async () => ({
          models: [
            {
              type: "llm",
              key: "gpt-oss",
              capabilities: {
                reasoning: { allowed_options: ["low", "medium", "high"], default: "low" },
              },
            },
          ],
        }),
      };
    },
  });

  const local = result.catalog.models[1];
  assert.equal(local.default_reasoning_level, "medium");
  assert.deepEqual(
    local.supported_reasoning_levels.map(({ effort }) => effort),
    ["low", "medium", "high"],
  );
});

test("advertises Desktop-supported effort options when LM Studio omits reasoning metadata", async () => {
  const result = await buildCatalog({
    sourceCatalog: { models: [{ slug: "gpt-test", display_name: "GPT Test", visibility: "list" }] },
    ollamaBaseUrl: "http://127.0.0.1:11434",
    lmStudioBaseUrl: "http://127.0.0.1:11239",
    fetchImpl: async (url) => {
      if (url.port === "11434") throw new Error("Ollama offline");
      return {
        ok: true,
        json: async () => ({
          models: [{ type: "llm", key: "gemma-4-12b-it-mlx", capabilities: { vision: true } }],
        }),
      };
    },
  });

  const local = result.catalog.models[1];
  assert.equal(local.default_reasoning_level, "medium");
  assert.deepEqual(
    local.supported_reasoning_levels.map(({ effort }) => effort),
    ["low", "medium", "high"],
  );
  assert.equal(result.routes["lmstudio/gemma-4-12b-it-mlx"].capabilities.thinking, false);
});

test("omits local providers that advertise no models", async () => {
  const result = await buildCatalog({
    sourceCatalog: { models: [{ slug: "gpt-test", display_name: "GPT Test", visibility: "list" }] },
    ollamaBaseUrl: "http://127.0.0.1:11434",
    lmStudioBaseUrl: "http://127.0.0.1:11239",
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => (url.pathname === "/api/tags" ? { models: [] } : { data: [] }),
    }),
  });

  assert.deepEqual(result.catalog.models.map((model) => model.slug), ["gpt-test"]);
  assert.deepEqual(Object.keys(result.routes), ["gpt-test"]);
});
