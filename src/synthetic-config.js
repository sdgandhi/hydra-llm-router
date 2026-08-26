import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { ensureHydraSettings } from "./hydra-config.js";

export const SYNTHETIC_REASONING_LEVELS = [
  { effort: "low", description: "Use light reasoning." },
  { effort: "medium", description: "Use medium reasoning." },
  { effort: "high", description: "Use high reasoning." },
];

export const MONEY_SAVER_DEFINITION = `[synthetic_models.money-saver]
display_name = "Hydra: Money Saver"
description = "Routes requests by estimated task complexity."
selector = "selectors/money-saver.js"
candidates = [
  "lmstudio/liquid/lfm2.5-1.2b",
  "lmstudio/google/gemma-4-26b-a4b-qat",
]
fallback_model = "gpt-5.6-sol"
routing_scope = "user_turn"
sticky_tool_continuations = true
selector_timeout_ms = 0
retry_count = 2
retry_delay_ms = 1000
`;

const ALLOWED_DEFINITION_KEYS = new Set([
  "display_name",
  "description",
  "selector",
  "candidates",
  "fallback_model",
  "routing_scope",
  "sticky_tool_continuations",
  "selector_timeout_ms",
  "retry_count",
  "retry_delay_ms",
]);

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
  const allowedTopLevel = new Set(["hydra", "codex", "providers", "app_tools", "tools", "synthetic_models"]);
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
      candidates,
      fallbackModel,
      effectiveCandidates,
      routingScope,
      stickyToolContinuations: requiredBoolean(
        value.sticky_tool_continuations,
        `synthetic_models.${name}.sticky_tool_continuations`,
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
  await ensureHydraSettings(paths.hydraConfigPath, { env: {} });
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
