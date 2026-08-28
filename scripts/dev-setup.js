#!/usr/bin/env node
import { chmod, copyFile, cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  developmentEnvironment,
  developmentPaths,
  ensureLocalCodex,
  exists,
  hydraDevelopmentArgs,
  spawnAndWait,
} from "./dev-context.js";

function codexConfigText(paths) {
  return [
    'cli_auth_credentials_store = "file"',
    "check_for_update_on_startup = false",
    `sqlite_home = ${JSON.stringify(paths.sqliteHome)}`,
    `model_catalog_json = ${JSON.stringify(paths.catalogPath)}`,
    `openai_base_url = ${JSON.stringify(`http://127.0.0.1:${paths.port}`)}`,
    "",
  ].join("\n");
}

export async function setupDevelopmentHome(paths, { logger = console } = {}) {
  await ensureLocalCodex(paths);
  await mkdir(paths.codexHome, { recursive: true, mode: 0o700 });
  await mkdir(paths.sqliteHome, { recursive: true, mode: 0o700 });
  await mkdir(paths.hydraHome, { recursive: true, mode: 0o700 });
  await chmod(paths.codexHome, 0o700);
  await chmod(paths.sqliteHome, 0o700);
  await chmod(paths.hydraHome, 0o700);

  await writeFile(paths.codexConfigPath, codexConfigText(paths), { mode: 0o600 });

  const sourceModels = path.join(paths.sourceCodexHome, "models_cache.json");
  if (!(await exists(sourceModels))) throw new Error(`Missing source Codex catalog: ${sourceModels}`);
  const targetModels = path.join(paths.codexHome, "models_cache.json");
  await copyFile(sourceModels, targetModels);
  await chmod(targetModels, 0o600);

  const sourceHydraConfig = path.join(paths.sourceHydraHome, "config.toml");
  if (!(await exists(paths.hydraConfigPath)) && await exists(sourceHydraConfig)) {
    await copyFile(sourceHydraConfig, paths.hydraConfigPath);
    await chmod(paths.hydraConfigPath, 0o600);
  }
  const sourceSelectors = path.join(paths.sourceHydraHome, "selectors");
  const targetSelectors = path.join(paths.hydraHome, "selectors");
  if (!(await exists(targetSelectors)) && await exists(sourceSelectors)) {
    await cp(sourceSelectors, targetSelectors, { recursive: true, force: false });
  }

  const env = developmentEnvironment(paths);
  await spawnAndWait(process.execPath, hydraDevelopmentArgs(paths, "install"), { env });
  logger.log(`Development CODEX_HOME: ${paths.codexHome}`);
  logger.log(`Development SQLite state: ${paths.sqliteHome}`);
  logger.log(`Development Hydra state: ${paths.hydraHome}`);
  logger.log(`Development Hydra: http://127.0.0.1:${paths.port}`);
  logger.log("Authenticate once with: npm run dev:login");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setupDevelopmentHome(developmentPaths()).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
