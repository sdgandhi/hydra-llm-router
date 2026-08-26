const DEFAULT_LOCAL_CONTEXT_WINDOW = 32768;
const THINKING_REASONING_LEVEL = {
  effort: "medium",
  description: "Use Ollama thinking mode when supported by the local model.",
};
const LMSTUDIO_REASONING_LEVELS = {
  low: {
    effort: "low",
    description: "Disable LM Studio reasoning for this chat.",
  },
  medium: {
    effort: "medium",
    description: "Use LM Studio reasoning when supported by the local model.",
  },
  high: {
    effort: "high",
    description: "Use a high amount of LM Studio reasoning.",
  },
};
const SYNTHETIC_REASONING_LEVELS = [
  { effort: "low", description: "Use light reasoning." },
  { effort: "medium", description: "Use medium reasoning." },
  { effort: "high", description: "Use high reasoning." },
];

export function normalizeOllamaSlug(name) {
  return `ollama/${name}`;
}

export function normalizeLMStudioSlug(name) {
  return `lmstudio/${name}`;
}

function localDisplayName(name) {
  return `Ollama: ${name}`;
}

function lmStudioDisplayName(name) {
  return `LM Studio: ${name}`;
}

function cloneWithoutNux(model) {
  const copy = structuredClone(model);
  delete copy.availability_nux;
  delete copy.upgrade;
  delete copy.service_tiers;
  delete copy.additional_speed_tiers;
  return copy;
}

function catalogCapabilities(model) {
  const modalities = Array.isArray(model?.input_modalities) ? model.input_modalities : ["text"];
  return {
    thinking:
      model?.default_reasoning_level !== "none" ||
      (Array.isArray(model?.supported_reasoning_levels) && model.supported_reasoning_levels.length > 0),
    tools: model?.supports_parallel_tool_calls !== false,
    vision: modalities.includes("image"),
    webSearch: Boolean(model?.supports_search_tool),
  };
}

function syntheticCapabilities(definition, routes) {
  const candidateRoutes = definition.effectiveCandidates.map((slug) => routes[slug]);
  const capability = (name) => candidateRoutes.every((route) => Boolean(route?.capabilities?.[name]));
  return {
    thinking: capability("thinking"),
    tools: capability("tools"),
    vision: capability("vision"),
    webSearch: capability("webSearch"),
  };
}

function syntheticModelFromTemplate(template, definition, priority, routes) {
  const model = cloneWithoutNux(template);
  const capabilities = syntheticCapabilities(definition, routes);
  const windows = definition.effectiveCandidates
    .map((slug) => Number(routes[slug]?.contextWindow))
    .filter((value) => Number.isFinite(value) && value > 0);
  const contextWindow = windows.length ? Math.max(...windows) : DEFAULT_LOCAL_CONTEXT_WINDOW;
  model.slug = definition.slug;
  model.display_name = definition.displayName;
  model.description = definition.description;
  model.visibility = "list";
  model.supported_in_api = true;
  model.priority = priority;
  model.context_window = contextWindow;
  model.max_context_window = contextWindow;
  model.default_reasoning_level = "medium";
  model.supported_reasoning_levels = SYNTHETIC_REASONING_LEVELS;
  model.supports_reasoning_summaries = capabilities.thinking;
  model.supports_search_tool = capabilities.webSearch;
  model.input_modalities = capabilities.vision ? ["text", "image"] : ["text"];
  model.web_search_tool_type = "text";
  model.use_responses_lite = false;
  model.shell_type = "shell_command";
  model.supports_parallel_tool_calls = capabilities.tools;
  return { model, capabilities, contextWindow };
}

function capabilitySet(modelInfo) {
  return new Set(Array.isArray(modelInfo?.capabilities) ? modelInfo.capabilities : []);
}

function ollamaContextWindow(ollamaModel, modelInfo, configuredContextWindow = null) {
  const configured = Number(configuredContextWindow);
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

function lmStudioContextWindow(model, configuredContextWindow = null) {
  const configured = Number(configuredContextWindow);
  if (Number.isFinite(configured) && configured > 0) return configured;

  for (const value of [
    model.loaded_instances?.[0]?.config?.context_length,
    model.max_context_length,
    model.context_length,
    model.max_tokens,
  ]) {
    const context = Number(value);
    if (Number.isFinite(context) && context > 0) return context;
  }
  return DEFAULT_LOCAL_CONTEXT_WINDOW;
}

function lmStudioReasoningLevels(model) {
  const reasoning = model.capabilities?.reasoning;
  if (!reasoning) {
    return {
      defaultLevel: "medium",
      supportedLevels: Object.values(LMSTUDIO_REASONING_LEVELS),
    };
  }

  const advertised = Array.isArray(reasoning.allowed_options) ? reasoning.allowed_options : [];
  const normalized = advertised.map((option) => (option === "off" ? "low" : option === "on" ? "medium" : option));
  const efforts = ["low", "medium", "high", ...normalized].filter(
    (effort, index, values) => LMSTUDIO_REASONING_LEVELS[effort] && values.indexOf(effort) === index,
  );

  return {
    defaultLevel: "medium",
    supportedLevels: efforts.map((effort) => LMSTUDIO_REASONING_LEVELS[effort]),
  };
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

export function catalogModelTitle(model) {
  return model?.slug ?? model?.display_name ?? "(unknown model)";
}

export function catalogModelTitles(catalog) {
  return Array.isArray(catalog?.models) ? catalog.models.map(catalogModelTitle) : [];
}

export function localModelFromTemplate(
  template,
  ollamaModel,
  priority,
  { modelInfo = null, webSearchReady = false, contextWindow = null } = {},
) {
  const name = ollamaModel.name || ollamaModel.model;
  const capabilities = routeCapabilities(modelInfo, webSearchReady);
  const model = cloneWithoutNux(template);
  model.slug = normalizeOllamaSlug(name);
  model.display_name = localDisplayName(name);
  model.description = `Local Ollama model (${ollamaModel.details?.parameter_size ?? "unknown size"}).`;
  model.visibility = "list";
  model.supported_in_api = true;
  model.priority = priority;
  model.context_window = ollamaContextWindow(ollamaModel, modelInfo, contextWindow);
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

export function lmStudioModelFromTemplate(
  template,
  lmStudioModel,
  priority,
  { webSearchReady = false, contextWindow = null } = {},
) {
  const name = lmStudioModel.id;
  const capabilities = lmStudioRouteCapabilities(lmStudioModel, webSearchReady);
  const reasoningLevels = lmStudioReasoningLevels(lmStudioModel);
  const model = cloneWithoutNux(template);
  model.slug = normalizeLMStudioSlug(name);
  model.display_name = lmStudioDisplayName(name);
  model.description = `Local LM Studio model (${lmStudioModel.params_string ?? "unknown size"}).`;
  model.visibility = "list";
  model.supported_in_api = true;
  model.priority = priority;
  model.context_window = lmStudioContextWindow(lmStudioModel, contextWindow);
  model.max_context_window = model.context_window;
  model.default_reasoning_level = reasoningLevels.defaultLevel;
  model.supported_reasoning_levels = reasoningLevels.supportedLevels;
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

export async function fetchLMStudioModels({ lmStudioBaseUrl, fetchImpl }) {
  const nativeResponse = await fetchImpl(new URL("/api/v1/models", lmStudioBaseUrl));
  if (nativeResponse.ok) {
    const body = await nativeResponse.json();
    return Array.isArray(body.models)
      ? body.models
          .filter((model) => model?.type === "llm" && typeof model.key === "string" && model.key)
          .map((model) => ({ ...model, id: model.key }))
      : [];
  }

  const compatibleResponse = await fetchImpl(new URL("/v1/models", lmStudioBaseUrl));
  if (!compatibleResponse.ok) {
    throw new Error(`LM Studio model query failed: HTTP ${compatibleResponse.status}`);
  }
  const body = await compatibleResponse.json();
  return Array.isArray(body.data) ? body.data.filter((model) => typeof model?.id === "string" && model.id) : [];
}

function lmStudioRouteCapabilities(model, webSearchReady = false) {
  const advertised = model.capabilities;
  const tools = advertised ? Boolean(advertised.trained_for_tool_use) : true;
  return {
    thinking: Boolean(advertised?.reasoning),
    tools,
    vision: Boolean(advertised?.vision),
    webSearch: tools && Boolean(webSearchReady),
  };
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

export async function buildCatalog({
  sourceCatalog,
  ollamaBaseUrl,
  lmStudioBaseUrl,
  fetchImpl,
  webSearchReady = false,
  syntheticDefinitions = [],
  ollamaContextWindow: configuredOllamaContextWindow = null,
  lmStudioContextWindow: configuredLMStudioContextWindow = null,
}) {
  if (!sourceCatalog?.models?.length) {
    throw new Error("Codex source catalog must contain at least one model");
  }

  const cloudModels = structuredClone(sourceCatalog.models);
  const template = cloudModels.find((model) => model.visibility === "list") ?? cloudModels[0];
  let ollamaModels = [];
  try {
    ollamaModels = await fetchOllamaModels({ ollamaBaseUrl, fetchImpl });
  } catch {
    ollamaModels = [];
  }
  let lmStudioModels = [];
  try {
    lmStudioModels = await fetchLMStudioModels({ lmStudioBaseUrl, fetchImpl });
  } catch {
    lmStudioModels = [];
  }
  const ollamaModelInfo = await fetchOllamaModelInfoMap({ ollamaBaseUrl, ollamaModels, fetchImpl });

  const ollamaCatalogModels = ollamaModels.map((model, index) =>
    localModelFromTemplate(template, model, 1000 + index, {
      modelInfo: ollamaModelInfo.get(model.name || model.model),
      webSearchReady,
      contextWindow: configuredOllamaContextWindow,
    }),
  );
  const lmStudioCatalogModels = lmStudioModels.map((model, index) =>
    lmStudioModelFromTemplate(template, model, 2000 + index, {
      webSearchReady,
      contextWindow: configuredLMStudioContextWindow,
    }),
  );
  const routes = {};
  for (const model of cloudModels) {
    routes[model.slug] = {
      provider: "openai",
      upstreamModel: model.slug,
      capabilities: catalogCapabilities(model),
      contextWindow: model.context_window ?? model.max_context_window,
    };
  }
  for (const model of ollamaModels) {
    const name = model.name || model.model;
    const modelInfo = ollamaModelInfo.get(name);
    routes[normalizeOllamaSlug(name)] = {
      provider: "ollama",
      upstreamModel: name,
      capabilities: routeCapabilities(modelInfo, webSearchReady),
      contextWindow: ollamaContextWindow(model, modelInfo, configuredOllamaContextWindow),
    };
  }
  for (const model of lmStudioModels) {
    routes[normalizeLMStudioSlug(model.id)] = {
      provider: "lmstudio",
      upstreamModel: model.id,
      capabilities: lmStudioRouteCapabilities(model, webSearchReady),
      contextWindow: lmStudioContextWindow(model, configuredLMStudioContextWindow),
    };
  }

  const syntheticCatalogModels = [];
  for (const [index, definition] of syntheticDefinitions.entries()) {
    const synthetic = syntheticModelFromTemplate(template, definition, 3000 + index, routes);
    syntheticCatalogModels.push(synthetic.model);
    routes[definition.slug] = {
      provider: "synthetic",
      capabilities: synthetic.capabilities,
      contextWindow: synthetic.contextWindow,
      definition,
    };
  }

  return {
    catalog: {
      fetched_at: new Date().toISOString(),
      etag: `hydra-${Date.now()}`,
      client_version: sourceCatalog.client_version ?? "hydra",
      models: [...cloudModels, ...ollamaCatalogModels, ...lmStudioCatalogModels, ...syntheticCatalogModels],
    },
    routes,
  };
}
