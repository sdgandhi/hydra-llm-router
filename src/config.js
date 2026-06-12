import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { buildCatalog } from "./catalog.js";

export function expandHome(value) {
  if (!value || value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

export function defaultPaths(codexHome = process.env.CODEX_HOME ?? "~/.codex") {
  const home = expandHome(codexHome);
  const hydraDir = path.join(home, "hydra");
  return {
    codexHome: home,
    hydraDir,
    codexConfigPath: path.join(home, "config.toml"),
    codexModelCachePath: path.join(home, "models_cache.json"),
    catalogPath: path.join(hydraDir, "hydra-models.json"),
    routesPath: path.join(hydraDir, "routes.json"),
    backupPath: path.join(hydraDir, "config.backup.toml"),
    settingsPath: path.join(hydraDir, "settings.json"),
    pidPath: path.join(hydraDir, "hydra.pid"),
    logPath: path.join(hydraDir, "hydra.log"),
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

export async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tempPath, filePath);
}

export async function refreshCatalog(config) {
  const sourceCatalog = await readJson(config.paths.codexModelCachePath);
  const catalog = await buildCatalog({
    sourceCatalog,
    ollamaBaseUrl: config.ollamaBaseUrl,
    fetchImpl: globalThis.fetch,
  });
  await writeJsonAtomic(config.paths.catalogPath, catalog.catalog);
  await writeJsonAtomic(config.paths.routesPath, catalog.routes);
  await writeJsonAtomic(config.paths.settingsPath, {
    port: config.port,
    ollamaBaseUrl: config.ollamaBaseUrl,
    openaiBaseUrl: config.openaiBaseUrl,
    updatedAt: new Date().toISOString(),
  });
  return catalog;
}

export async function loadHydraConfig(paths) {
  return readJson(paths.settingsPath, {});
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
  const withoutTopLevel = toml
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("model_catalog_json =") && !trimmed.startsWith("openai_base_url =");
    })
    .join("\n");

  return withoutTopLevel.replace(/\n?\[model_providers\.hydra\]\n(?:[^\n[]+\n?)*/g, "\n");
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
