import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { buildCatalog } from "./catalog.js";
import { emulatedToolStatuses } from "./router.js";
import { loadSyntheticConfig } from "./synthetic-config.js";

export function expandHome(value) {
  if (!value || value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

export function defaultPaths({ codexHome = "~/.codex", configPath = null, dataDir = null } = {}) {
  const home = path.resolve(expandHome(codexHome));
  const hydraConfigPath = path.resolve(expandHome(configPath ?? "~/.hydra/config.toml"));
  const configDir = path.dirname(hydraConfigPath);
  const hydraDir = path.resolve(expandHome(dataDir ?? configDir));
  return {
    codexHome: home,
    hydraDir,
    codexConfigPath: path.join(home, "config.toml"),
    codexModelCachePath: path.join(home, "models_cache.json"),
    hydraConfigPath,
    selectorsDir: path.join(configDir, "selectors"),
    moneySaverSelectorPath: path.join(configDir, "selectors", "money-saver.js"),
    catalogPath: path.join(hydraDir, "hydra-models.json"),
    routesPath: path.join(hydraDir, "routes.json"),
    backupPath: path.join(hydraDir, "config.backup.toml"),
    pidPath: path.join(hydraDir, "hydra.pid"),
    logPath: path.join(hydraDir, "hydra.log"),
    metronDir: path.join(hydraDir, "metron"),
    metronEventsDir: path.join(hydraDir, "metron", "events"),
    metronCursorsPath: path.join(hydraDir, "metron", "cursors.json"),
  };
}

export async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (fallback !== null && error.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function loadCatalog(paths) {
  return readJson(paths.catalogPath, { models: [] });
}

export async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tempPath, filePath);
}

export async function refreshCatalog(config) {
  const sourceCatalog = await readJson(config.paths.codexModelCachePath);
  const syntheticConfig = await loadSyntheticConfig(config.paths);
  const toolStatuses = await emulatedToolStatuses(config.webSearchCommands);
  const catalog = await buildCatalog({
    sourceCatalog,
    ollamaBaseUrl: config.ollamaBaseUrl,
    lmStudioBaseUrl: config.lmStudioBaseUrl,
    omlxBaseUrl: config.omlxBaseUrl,
    omlxApiKey: config.omlxApiKey,
    fetchImpl: globalThis.fetch,
    webSearchReady: toolStatuses.some((tool) => tool.name === "web_search" && tool.status === "ready"),
    syntheticDefinitions: syntheticConfig.definitions,
    ollamaContextWindow: config.ollamaContextWindow,
    lmStudioContextWindow: config.lmStudioContextWindow,
    omlxContextWindow: config.omlxContextWindow,
  });
  await writeJsonAtomic(config.paths.catalogPath, catalog.catalog);
  await writeJsonAtomic(config.paths.routesPath, catalog.routes);
  return { ...catalog, syntheticConfig };
}

export async function isHydraInstalled(config) {
  try {
    const toml = await readFile(config.paths.codexConfigPath, "utf8");
    return (
      toml.includes(`model_catalog_json = ${JSON.stringify(config.paths.catalogPath)}`) &&
      toml.includes(`openai_base_url = "http://127.0.0.1:${config.port}"`)
    );
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export function hydraConfigPatch(config) {
  return [
    `model_catalog_json = ${JSON.stringify(config.paths.catalogPath)}`,
    `openai_base_url = "http://127.0.0.1:${config.port}"`,
    "",
  ].join("\n");
}

export function insertHydraConfig(toml, config) {
  const topLevelPatch = [
    `model_catalog_json = ${JSON.stringify(config.paths.catalogPath)}`,
    `openai_base_url = "http://127.0.0.1:${config.port}"`,
    "",
  ].join("\n");
  const firstTable = toml.search(/^\[/m);
  if (firstTable === -1) return `${toml.replace(/\s+$/g, "")}\n${topLevelPatch}`;
  const beforeTables = toml.slice(0, firstTable).replace(/\s+$/g, "");
  const tables = toml.slice(firstTable).replace(/\s+$/g, "");
  return `${beforeTables}\n${topLevelPatch}\n${tables}`;
}

export function removeManagedHydraConfig(toml) {
  const firstTable = toml.search(/^\[/m);
  const topLevel = firstTable === -1 ? toml : toml.slice(0, firstTable);
  const tables = firstTable === -1 ? "" : toml.slice(firstTable);
  const cleanedTopLevel = topLevel
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return (
        !trimmed.startsWith("model_catalog_json =") &&
        !trimmed.startsWith("openai_base_url =") &&
        !/^model_provider\s*=\s*(['"])hydra\1(?:\s*(?:#.*)?)?$/.test(trimmed)
      );
    })
    .join("\n");

  return `${cleanedTopLevel}${tables}`.replace(/\n?\[model_providers\.hydra\]\n(?:[^\n[]+\n?)*/g, "\n");
}

export async function installHydraConfig(config) {
  const catalog = await refreshCatalog(config);
  await mkdir(config.paths.hydraDir, { recursive: true });
  const currentConfig = await readFile(config.paths.codexConfigPath, "utf8");
  try {
    await readFile(config.paths.backupPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(config.paths.backupPath, currentConfig);
  }

  const cleaned = removeManagedHydraConfig(currentConfig);
  const nextConfig = insertHydraConfig(cleaned, config);
  await writeFile(config.paths.codexConfigPath, nextConfig);
  return { ...catalog, backupPath: config.paths.backupPath };
}

export async function restoreConfig(paths) {
  const backup = await readFile(paths.backupPath, "utf8");
  await writeFile(paths.codexConfigPath, backup);
  return { backupPath: paths.backupPath };
}

export async function writePidFile(paths, pid) {
  await mkdir(paths.hydraDir, { recursive: true });
  await writeFile(paths.pidPath, `${pid}\n`);
}

export async function removePidFile(paths, expectedPid = null) {
  try {
    if (expectedPid != null) {
      const currentPid = Number((await readFile(paths.pidPath, "utf8")).trim());
      if (currentPid !== expectedPid) return false;
    }
    await unlink(paths.pidPath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function stopServer(paths) {
  const pid = Number((await readFile(paths.pidPath, "utf8")).trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`Invalid pid file: ${paths.pidPath}`);
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  await removePidFile(paths, pid);
  return { pid };
}
