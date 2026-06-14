const DEFAULT_LOCAL_CONTEXT_WINDOW = 32768;
const THINKING_REASONING_LEVEL = {
  effort: "medium",
  description: "Use Ollama thinking mode when supported by the local model.",
};

export function normalizeOllamaSlug(name) {
  return `ollama/${name}`;
}

function localDisplayName(name) {
  return `Ollama: ${name}`;
}

function cloneWithoutNux(model) {
  const copy = structuredClone(model);
  delete copy.availability_nux;
  delete copy.upgrade;
  delete copy.service_tiers;
  delete copy.additional_speed_tiers;
  return copy;
}

function capabilitySet(modelInfo) {
  return new Set(Array.isArray(modelInfo?.capabilities) ? modelInfo.capabilities : []);
}

function ollamaContextWindow(ollamaModel, modelInfo) {
  const configured = Number(process.env.HYDRA_OLLAMA_CONTEXT_WINDOW);
  if (Number.isFinite(configured) && configured > 0) return configured;

  const detailsContext = Number(ollamaModel.details?.context_length);
  if (Number.isFinite(detailsContext) && detailsContext > 0) return detailsContext;

  for (const [key, value] of Object.entries(modelInfo?.model_info ?? {})) {
    if (!key.endsWith(".context_length")) continue;
    const context = Number(value);
    if (Number.isFinite(context) && context > 0) return context;
  }

  return DEFAULT_LOCAL_CONTEXT_WINDOW;
}

function routeCapabilities(modelInfo, webSearchReady) {
  const capabilities = capabilitySet(modelInfo);
  const tools = capabilities.has("tools");
  return {
    thinking: capabilities.has("thinking"),
    tools,
    vision: capabilities.has("vision"),
    webSearch: tools && Boolean(webSearchReady),
  };
}

export function localModelFromTemplate(template, ollamaModel, priority, { modelInfo = null, webSearchReady = false } = {}) {
  const name = ollamaModel.name || ollamaModel.model;
  const capabilities = routeCapabilities(modelInfo, webSearchReady);
  const model = cloneWithoutNux(template);
  model.slug = normalizeOllamaSlug(name);
  model.display_name = localDisplayName(name);
  model.description = `Local Ollama model (${ollamaModel.details?.parameter_size ?? "unknown size"}).`;
  model.visibility = "list";
  model.supported_in_api = true;
  model.priority = priority;
  model.context_window = ollamaContextWindow(ollamaModel, modelInfo);
  model.max_context_window = model.context_window;
  model.default_reasoning_level = capabilities.thinking ? THINKING_REASONING_LEVEL.effort : "none";
  model.supported_reasoning_levels = capabilities.thinking ? [THINKING_REASONING_LEVEL] : [];
  model.supports_reasoning_summaries = true;
  model.support_verbosity = false;
  model.default_verbosity = "low";
  model.supports_search_tool = capabilities.webSearch;
  model.input_modalities = capabilities.vision ? ["text", "image"] : ["text"];
  model.web_search_tool_type = "text";
  model.use_responses_lite = false;
  model.shell_type = "shell_command";
  model.supports_parallel_tool_calls = capabilities.tools;
  return model;
}

export async function fetchOllamaModels({ ollamaBaseUrl, fetchImpl }) {
  const response = await fetchImpl(new URL("/api/tags", ollamaBaseUrl));
  if (!response.ok) {
    throw new Error(`Ollama model query failed: HTTP ${response.status}`);
  }
  const body = await response.json();
  return Array.isArray(body.models) ? body.models : [];
}

export async function fetchOllamaModelInfo({ ollamaBaseUrl, model, fetchImpl }) {
  const response = await fetchImpl(new URL("/api/show", ollamaBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
  });
  if (!response.ok) {
    throw new Error(`Ollama model info query failed for ${model}: HTTP ${response.status}`);
  }
  return response.json();
}

async function fetchOllamaModelInfoMap({ ollamaBaseUrl, ollamaModels, fetchImpl }) {
  const entries = await Promise.all(
    ollamaModels.map(async (model) => {
      const name = model.name || model.model;
      try {
        return [name, await fetchOllamaModelInfo({ ollamaBaseUrl, model: name, fetchImpl })];
      } catch {
        return [name, null];
      }
    }),
  );
  return new Map(entries);
}

export async function buildCatalog({ sourceCatalog, ollamaBaseUrl, fetchImpl, webSearchReady = false }) {
  if (!sourceCatalog?.models?.length) {
    throw new Error("Codex source catalog must contain at least one model");
  }

  const cloudModels = structuredClone(sourceCatalog.models);
  const template = cloudModels.find((model) => model.visibility === "list") ?? cloudModels[0];
  let ollamaModels = [];
  try {
    ollamaModels = await fetchOllamaModels({ ollamaBaseUrl, fetchImpl });
  } catch (error) {
    ollamaModels = [];
  }
  const ollamaModelInfo = await fetchOllamaModelInfoMap({ ollamaBaseUrl, ollamaModels, fetchImpl });

  const localModels = ollamaModels.map((model, index) =>
    localModelFromTemplate(template, model, 1000 + index, {
      modelInfo: ollamaModelInfo.get(model.name || model.model),
      webSearchReady,
    }),
  );
  const routes = {};
  for (const model of cloudModels) routes[model.slug] = { provider: "openai", upstreamModel: model.slug };
  for (const model of ollamaModels) {
    const name = model.name || model.model;
    const modelInfo = ollamaModelInfo.get(name);
    routes[normalizeOllamaSlug(name)] = {
      provider: "ollama",
      upstreamModel: name,
      capabilities: routeCapabilities(modelInfo, webSearchReady),
    };
  }

  return {
    catalog: {
      fetched_at: new Date().toISOString(),
      etag: `hydra-${Date.now()}`,
      client_version: sourceCatalog.client_version ?? "hydra",
      models: [...cloudModels, ...localModels],
    },
    routes,
  };
}
