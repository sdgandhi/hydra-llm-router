const DEFAULT_LOCAL_CONTEXT_WINDOW = 32768;

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

export function localModelFromTemplate(template, ollamaModel, priority) {
  const name = ollamaModel.name || ollamaModel.model;
  const model = cloneWithoutNux(template);
  model.slug = normalizeOllamaSlug(name);
  model.display_name = localDisplayName(name);
  model.description = `Local Ollama model (${ollamaModel.details?.parameter_size ?? "unknown size"}).`;
  model.visibility = "list";
  model.supported_in_api = true;
  model.priority = priority;
  model.context_window = Number(process.env.HYDRA_OLLAMA_CONTEXT_WINDOW ?? DEFAULT_LOCAL_CONTEXT_WINDOW);
  model.max_context_window = model.context_window;
  model.default_reasoning_level = "none";
  model.supported_reasoning_levels = [];
  model.supports_reasoning_summaries = true;
  model.support_verbosity = false;
  model.default_verbosity = "low";
  model.supports_search_tool = false;
  model.input_modalities = ["text"];
  model.web_search_tool_type = "text";
  model.use_responses_lite = false;
  model.shell_type = "shell_command";
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

export async function buildCatalog({ sourceCatalog, ollamaBaseUrl, fetchImpl }) {
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

  const localModels = ollamaModels.map((model, index) =>
    localModelFromTemplate(template, model, 1000 + index),
  );
  const routes = {};
  for (const model of cloudModels) routes[model.slug] = { provider: "openai", upstreamModel: model.slug };
  for (const model of ollamaModels) {
    const name = model.name || model.model;
    routes[normalizeOllamaSlug(name)] = { provider: "ollama", upstreamModel: name };
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
