import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const DEV_PORT = 3857;
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

function developmentPort(value) {
  const port = Number(value ?? DEV_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("HYDRA_DEV_PORT must be a valid port");
  }
  if (port === 3847) throw new Error("HYDRA_DEV_PORT must not use the Desktop Hydra port 3847");
  return port;
}

export function developmentPaths(environment = process.env) {
  const codexHome = path.resolve(expandHome(environment.HYDRA_DEV_CODEX_HOME ?? "~/.codex-hydra-dev"));
  const hydraHome = path.resolve(expandHome(environment.HYDRA_DEV_HOME ?? "~/.hydra-dev"));
  const sourceCodexHome = path.resolve(expandHome(environment.HYDRA_SOURCE_CODEX_HOME ?? "~/.codex"));
  const sourceHydraHome = path.resolve(expandHome(environment.HYDRA_SOURCE_HOME ?? "~/.hydra"));
  return {
    codexHome,
    sqliteHome: path.join(codexHome, "sqlite"),
    hydraHome,
    sourceCodexHome,
    sourceHydraHome,
    hydraConfigPath: path.join(hydraHome, "config.toml"),
    catalogPath: path.join(hydraHome, "hydra-models.json"),
    codexConfigPath: path.join(codexHome, "config.toml"),
    codexBin: path.join(REPO_ROOT, "scripts", "dev-codex"),
    upstreamCodexBin: path.join(REPO_ROOT, "node_modules", ".bin", "codex"),
    hydraCli: path.join(REPO_ROOT, "src", "cli.js"),
    port: developmentPort(environment.HYDRA_DEV_PORT),
  };
}

export function developmentEnvironment(paths, environment = process.env) {
  const result = {
    ...environment,
    CODEX_HOME: paths.codexHome,
    CODEX_SQLITE_HOME: paths.sqliteHome,
  };
  delete result.CODEX_API_KEY;
  delete result.CODEX_ACCESS_TOKEN;
  delete result.OPENAI_API_KEY;
  delete result.OPENAI_BASE_URL;
  delete result.OPENAI_IDENTITY_TOKEN_FILE;
  delete result.OPENAI_WORKLOAD_IDENTITY_CONTEXT;
  return result;
}

export function hydraDevelopmentArgs(paths, command, args = []) {
  return [
    paths.hydraCli,
    command,
    "--config",
    paths.hydraConfigPath,
    "--codex-home",
    paths.codexHome,
    "--codex-bin",
    paths.codexBin,
    "--port",
    String(paths.port),
    ...args,
  ];
}

export async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function spawnAndWait(command, args, { cwd = REPO_ROOT, env, stdio = "inherit" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve({ code, signal });
      else reject(new Error(`${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}

export async function ensureLocalCodex(paths) {
  if (!(await exists(paths.upstreamCodexBin))) {
    throw new Error("The development Codex CLI is missing. Run npm install first.");
  }
}

export async function requireDevelopmentSetup(paths) {
  await ensureLocalCodex(paths);
  for (const filePath of [paths.codexConfigPath, paths.hydraConfigPath, paths.catalogPath]) {
    if (!(await exists(filePath))) throw new Error(`Development environment is not set up: missing ${filePath}`);
  }
  const config = await readFile(paths.codexConfigPath, "utf8");
  const expectedBase = `openai_base_url = ${JSON.stringify(`http://127.0.0.1:${paths.port}`)}`;
  const expectedCatalog = `model_catalog_json = ${JSON.stringify(paths.catalogPath)}`;
  if (!config.includes(expectedBase) || !config.includes(expectedCatalog)) {
    throw new Error("Development Codex config is not pinned to the development Hydra instance; rerun npm run dev:setup");
  }
  if (/^\s*model_provider\s*=/m.test(config) || /^\s*\[model_providers(?:\.|\])/m.test(config)) {
    throw new Error("Development Codex config contains a provider override; remove it or rerun npm run dev:setup");
  }
}
