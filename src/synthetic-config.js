import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { ensureHydraConfig } from "./hydra-config.js";

export const SYNTHETIC_REASONING_LEVELS = [
  { effort: "low", description: "Use light reasoning." },
  { effort: "medium", description: "Use medium reasoning." },
  { effort: "high", description: "Use high reasoning." },
];

export const SELECTOR_CONTEXT_PARTS = ["system", "history", "latest_user", "tools", "metadata"];

export const MONEY_SAVER_DEFINITION = `[synthetic_models.money-saver]
display_name = "Hydra: Money Saver"
description = "Routes requests by estimated task complexity."
selector = "selectors/money-saver.js"
selector_type = "custom"
selector_model = "lmstudio/liquid/lfm2.5-1.2b"
selector_context = ["latest_user", "metadata"]
candidates = [
  "lmstudio/liquid/lfm2.5-1.2b",
  "lmstudio/google/gemma-4-26b-a4b-qat",
]
fallback_model = "gpt-5.6-sol"
routing_scope = "user_turn"
sticky_tool_continuations = true
show_routing_commentary = true
selector_timeout_ms = 0
retry_count = 2
retry_delay_ms = 1000
`;

const ALLOWED_DEFINITION_KEYS = new Set([
  "display_name",
  "description",
  "selector",
  "selector_type",
  "selector_context",
  "selector_model",
  "candidates",
  "fallback_model",
  "routing_scope",
  "sticky_tool_continuations",
  "show_routing_commentary",
  "selector_timeout_ms",
  "retry_count",
  "retry_delay_ms",
]);

const PROMPT_SELECTOR_TEMPLATE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "selectors",
  "prompt-router.template.js",
);

export function normalizeSyntheticSlug(value) {
  const text = String(value ?? "").trim();
  const name = text.startsWith("hydra/") ? text.slice("hydra/".length) : text;
  if (!name || name.includes("/") || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(`Invalid synthetic model slug: ${text || "<empty>"}`);
  }
  return `hydra/${name}`;
}

function directModelSlug(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty model slug`);
  const slug = value.trim();
  if (slug.startsWith("hydra/")) throw new Error(`${field} cannot reference a synthetic model: ${slug}`);
  return slug;
}

function nonnegativeInteger(value, field, fallback) {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < 0) throw new Error(`${field} must be a nonnegative integer`);
  return value;
}

function requiredBoolean(value, field) {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean`);
  return value;
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function selectorContextParts(value, field) {
  if (value == null) return [...SELECTOR_CONTEXT_PARTS];
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty array`);
  const parts = [...new Set(value.map((part) => requiredString(part, `${field}[]`)))];
  const unknown = parts.find((part) => !SELECTOR_CONTEXT_PARTS.includes(part));
  if (unknown) throw new Error(`${field} contains unsupported context part: ${unknown}`);
  return parts;
}

async function selectorSnapshot(selectorPath) {
  try {
    await access(selectorPath, fsConstants.R_OK);
    const source = await readFile(selectorPath);
    return {
      selectorPath,
      selectorHash: createHash("sha256").update(source).digest("hex"),
    };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EACCES") return null;
    throw error;
  }
}

export async function parseSyntheticConfig(text, { configPath }) {
  let parsed;
  try {
    parsed = parse(text);
  } catch (error) {
    throw new Error(`Invalid Hydra TOML at ${configPath}: ${error.message}`);
  }

  const topLevelKeys = Object.keys(parsed);
  const allowedTopLevel = new Set(["hydra", "codex", "providers", "app_tools", "tools", "metron", "synthetic_models"]);
  const unknownTopLevel = topLevelKeys.filter((key) => !allowedTopLevel.has(key));
  if (unknownTopLevel.length) throw new Error(`Unknown Hydra config key: ${unknownTopLevel[0]}`);

  const definitionsTable = parsed.synthetic_models ?? {};
  if (!definitionsTable || typeof definitionsTable !== "object" || Array.isArray(definitionsTable)) {
    throw new Error("synthetic_models must be a TOML table");
  }

  const definitions = [];
  const omitted = [];
  const seen = new Set();
  for (const [name, value] of Object.entries(definitionsTable)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`synthetic_models.${name} must be a TOML table`);
    }
    const unknown = Object.keys(value).find((key) => !ALLOWED_DEFINITION_KEYS.has(key));
    if (unknown) throw new Error(`Unknown key synthetic_models.${name}.${unknown}`);

    const slug = normalizeSyntheticSlug(name);
    if (seen.has(slug)) throw new Error(`Duplicate synthetic model slug: ${slug}`);
    seen.add(slug);

    if (!Array.isArray(value.candidates) || value.candidates.length === 0) {
      throw new Error(`synthetic_models.${name}.candidates must be a non-empty array`);
    }
    const candidates = value.candidates.map((candidate, index) =>
      directModelSlug(candidate, `synthetic_models.${name}.candidates[${index}]`),
    );
    const fallbackModel = directModelSlug(value.fallback_model, `synthetic_models.${name}.fallback_model`);
    const effectiveCandidates = [...new Set([...candidates, fallbackModel])];
    const routingScope = requiredString(value.routing_scope, `synthetic_models.${name}.routing_scope`);
    if (!new Set(["user_turn", "conversation"]).has(routingScope)) {
      throw new Error(`synthetic_models.${name}.routing_scope must be user_turn or conversation`);
    }
    const selector = requiredString(value.selector, `synthetic_models.${name}.selector`);
    const selectorType = requiredString(value.selector_type, `synthetic_models.${name}.selector_type`);
    if (!new Set(["prompt", "custom"]).has(selectorType)) {
      throw new Error(`synthetic_models.${name}.selector_type must be prompt or custom`);
    }
    const selectorModel = value.selector_model == null
      ? null
      : directModelSlug(value.selector_model, `synthetic_models.${name}.selector_model`);
    if (selectorType === "prompt" && !selectorModel) {
      throw new Error(`synthetic_models.${name}.selector_model is required for prompt selectors`);
    }
    const selectorPath = path.resolve(path.dirname(configPath), selector);
    const snapshot = await selectorSnapshot(selectorPath);
    const definition = {
      slug,
      displayName: typeof value.display_name === "string" && value.display_name.trim()
        ? value.display_name.trim()
        : `Hydra: ${slug.slice("hydra/".length)}`,
      description: typeof value.description === "string" ? value.description : "Hydra synthetic model.",
      selector,
      selectorPath,
      selectorHash: snapshot?.selectorHash,
      selectorType,
      selectorModel,
      selectorContextParts: selectorContextParts(
        value.selector_context,
        `synthetic_models.${name}.selector_context`,
      ),
      candidates,
      fallbackModel,
      effectiveCandidates,
      routingScope,
      stickyToolContinuations: requiredBoolean(
        value.sticky_tool_continuations,
        `synthetic_models.${name}.sticky_tool_continuations`,
      ),
      showRoutingCommentary: value.show_routing_commentary == null
        ? true
        : requiredBoolean(
            value.show_routing_commentary,
            `synthetic_models.${name}.show_routing_commentary`,
          ),
      selectorTimeoutMs: nonnegativeInteger(
        value.selector_timeout_ms,
        `synthetic_models.${name}.selector_timeout_ms`,
        0,
      ),
      retryCount: nonnegativeInteger(value.retry_count, `synthetic_models.${name}.retry_count`, 2),
      retryDelayMs: nonnegativeInteger(value.retry_delay_ms, `synthetic_models.${name}.retry_delay_ms`, 1000),
    };
    if (!snapshot) omitted.push({ slug, selectorPath, reason: "selector_unavailable" });
    else definitions.push(definition);
  }
  return { definitions, omitted };
}

export async function loadSyntheticConfig(paths, { allowMissing = true } = {}) {
  let text;
  try {
    text = await readFile(paths.hydraConfigPath, "utf8");
  } catch (error) {
    if (allowMissing && error.code === "ENOENT") return { definitions: [], omitted: [] };
    throw error;
  }
  return parseSyntheticConfig(text, { configPath: paths.hydraConfigPath });
}

export async function loadSyntheticConfigWithDefaults(paths) {
  await ensureHydraConfig(paths.hydraConfigPath);
  await ensureSyntheticDefaults(paths);
  return loadSyntheticConfig(paths, { allowMissing: false });
}

export async function ensureSyntheticDefaults(paths) {
  await mkdir(paths.selectorsDir, { recursive: true });
  const bundledSelector = path.join(path.dirname(fileURLToPath(import.meta.url)), "selectors", "money-saver.js");
  try {
    await access(paths.moneySaverSelectorPath, fsConstants.F_OK);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await copyFile(bundledSelector, paths.moneySaverSelectorPath);
  }

  let existing;
  try {
    existing = await readFile(paths.hydraConfigPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(paths.hydraConfigPath, `${MONEY_SAVER_DEFINITION}\n`);
    return { created: true, addedMoneySaver: true };
  }

  const parsed = await parseSyntheticConfig(existing, { configPath: paths.hydraConfigPath });
  if (parsed.definitions.some((definition) => definition.slug === "hydra/money-saver")) {
    return { created: false, addedMoneySaver: false };
  }
  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  await writeFile(paths.hydraConfigPath, `${existing}${separator}${MONEY_SAVER_DEFINITION}\n`);
  return { created: false, addedMoneySaver: true };
}

function generatedSyntheticSlug(name) {
  const enteredName = requiredString(name, "Name");
  const displayName = enteredName.startsWith("hydra/") ? enteredName.slice("hydra/".length) : enteredName;
  const raw = displayName;
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
  return { displayName, slug: normalizeSyntheticSlug(normalized) };
}

function availableDirectModel(value, field, availableModels) {
  const slug = directModelSlug(value, field);
  if (!availableModels.has(slug)) throw new Error(`${field} is not an available model: ${slug}`);
  return slug;
}

function tomlString(value) {
  return JSON.stringify(value);
}

function generatedDefinition({
  slug,
  displayName,
  selector,
  candidates,
  fallbackModel,
  selectorModel,
  selectorContextParts,
  routingScope,
  selectorTimeoutMs,
  retryCount,
  retryDelayMs,
}) {
  const name = slug.slice("hydra/".length);
  return `[synthetic_models.${tomlString(name)}]
display_name = ${tomlString(`Hydra: ${displayName}`)}
description = ${tomlString(`Prompt-routed using ${selectorModel}.`)}
selector = ${tomlString(selector)}
selector_type = "prompt"
selector_model = ${tomlString(selectorModel)}
selector_context = ${JSON.stringify(selectorContextParts)}
candidates = ${JSON.stringify(candidates)}
fallback_model = ${tomlString(fallbackModel)}
routing_scope = ${tomlString(routingScope)}
sticky_tool_continuations = true
show_routing_commentary = true
selector_timeout_ms = ${selectorTimeoutMs}
retry_count = ${retryCount}
retry_delay_ms = ${retryDelayMs}
`;
}

/**
 * Create a prompt-routed synthetic model from the bundled selector template.
 * Selector JavaScript is fully trusted and intentionally has the same access as Hydra.
 */
export async function createPromptSyntheticModel(paths, input, { availableModels = [] } = {}) {
  const available = new Set(availableModels.map((model) => directModelSlug(model, "availableModels[]")));
  const { displayName, slug } = generatedSyntheticSlug(input?.name);
  const candidatesInput = input?.candidates;
  if (!Array.isArray(candidatesInput) || candidatesInput.length === 0) {
    throw new Error("Candidate models must include at least one model");
  }
  const candidates = [...new Set(candidatesInput.map((candidate, index) =>
    availableDirectModel(candidate, `Candidate models[${index}]`, available),
  ))];
  const fallbackModel = availableDirectModel(input?.fallbackModel, "Fallback model", available);
  const selectorModel = availableDirectModel(input?.selectorModel, "Selector model", available);
  const selectorPrompt = requiredString(input?.selectorPrompt, "Selector prompt");
  const selectedContextParts = ["latest_user", "metadata"];
  const scoreModels = [...new Set([...candidates, fallbackModel])];
  const routingScope = input?.routingScope ?? "user_turn";
  if (!new Set(["user_turn", "conversation"]).has(routingScope)) {
    throw new Error("Scope must be user_turn or conversation");
  }
  const timeoutSeconds = Number(input?.timeoutSeconds ?? 0);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
    throw new Error("Timeout must be a nonnegative number of seconds");
  }
  const selectorTimeoutMs = Math.round(timeoutSeconds * 1000);
  const retryCount = nonnegativeInteger(Number(input?.retryCount ?? 2), "Retries", 2);
  const retryDelayMs = nonnegativeInteger(Number(input?.retryDelayMs ?? 1000), "Retry delay", 1000);

  let existing;
  try {
    existing = await readFile(paths.hydraConfigPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    existing = "";
  }
  let parsed;
  try {
    parsed = existing.trim() ? parse(existing) : {};
  } catch (error) {
    throw new Error(`Invalid Hydra TOML at ${paths.hydraConfigPath}: ${error.message}`);
  }
  const configuredSlugs = new Set(
    Object.keys(parsed.synthetic_models ?? {}).map((name) => normalizeSyntheticSlug(name)),
  );
  if (configuredSlugs.has(slug)) throw new Error(`Synthetic model already exists: ${slug}`);

  await mkdir(paths.selectorsDir, { recursive: true });
  const selectorFilename = `${slug.slice("hydra/".length)}.js`;
  const selectorPath = path.join(paths.selectorsDir, selectorFilename);
  const selector = path.relative(path.dirname(paths.hydraConfigPath), selectorPath);
  const template = await readFile(PROMPT_SELECTOR_TEMPLATE, "utf8");
  const selectorSource = template
    .replace("__HYDRA_SELECTOR_PROMPT__", JSON.stringify(selectorPrompt))
    .replace("__HYDRA_SELECTOR_SCORE_MODELS__", JSON.stringify(scoreModels));
  const definition = generatedDefinition({
    slug,
    displayName,
    selector,
    candidates,
    fallbackModel,
    selectorModel,
    selectorContextParts: selectedContextParts,
    routingScope,
    selectorTimeoutMs,
    retryCount,
    retryDelayMs,
  });
  const separator = !existing ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  const nextConfig = `${existing}${separator}${definition}\n`;
  const temporaryConfig = `${paths.hydraConfigPath}.${process.pid}.${Date.now()}.tmp`;
  let selectorCreated = false;
  try {
    await writeFile(selectorPath, selectorSource, { flag: "wx", mode: 0o600 });
    selectorCreated = true;
    await parseSyntheticConfig(nextConfig, { configPath: paths.hydraConfigPath });
    await writeFile(temporaryConfig, nextConfig, { flag: "wx", mode: 0o600 });
    await rename(temporaryConfig, paths.hydraConfigPath);
  } catch (error) {
    await unlink(temporaryConfig).catch(() => {});
    if (selectorCreated) await unlink(selectorPath).catch(() => {});
    if (error.code === "EEXIST") throw new Error(`Synthetic model already exists: ${slug}`);
    throw error;
  }
  return { slug, selectorPath };
}
