#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, chmod, copyFile, cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
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

function positivePort(value) {
  const port = Number(value ?? DEV_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("HYDRA_DEV_PORT must be a valid port");
  if (port === 3847) throw new Error("HYDRA_DEV_PORT must not use the Desktop Hydra port 3847");
  return port;
}

export function developmentPaths(environment = process.env) {
  const codexHome = path.resolve(expandHome(environment.HYDRA_DEV_CODEX_HOME ?? "~/.codex-hydra-dev"));
  const sourceCodexHome = path.resolve(expandHome(environment.HYDRA_SOURCE_CODEX_HOME ?? "~/.codex"));
  return {
    codexHome,
    sqliteHome: path.join(codexHome, "sqlite"),
    sourceCodexHome,
    hydraConfigPath: path.join(codexHome, "hydra", "config.toml"),
    hydraLogPath: path.join(codexHome, "hydra", "hydra.log"),
    catalogPath: path.join(codexHome, "hydra", "hydra-models.json"),
    codexConfigPath: path.join(codexHome, "config.toml"),
    codexBin: path.join(REPO_ROOT, "node_modules", ".bin", "codex"),
    hydraCli: path.join(REPO_ROOT, "src", "cli.js"),
    port: positivePort(environment.HYDRA_DEV_PORT),
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

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function spawnAndWait(command, args, { cwd = REPO_ROOT, env, stdio = "inherit" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve({ code, signal });
      else reject(new Error(`${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}

async function ensureLocalCodex(paths) {
  if (!(await exists(paths.codexBin))) {
    throw new Error("The development Codex CLI is missing. Run npm install first.");
  }
}

export async function setupDevelopmentHome(paths, { logger = console } = {}) {
  await ensureLocalCodex(paths);
  await mkdir(paths.codexHome, { recursive: true, mode: 0o700 });
  await mkdir(paths.sqliteHome, { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(paths.hydraConfigPath), { recursive: true, mode: 0o700 });
  await chmod(paths.codexHome, 0o700);
  await chmod(paths.sqliteHome, 0o700);

  await writeFile(paths.codexConfigPath, codexConfigText(paths), { mode: 0o600 });

  const sourceModels = path.join(paths.sourceCodexHome, "models_cache.json");
  if (!(await exists(sourceModels))) {
    throw new Error(`Missing source Codex catalog: ${sourceModels}`);
  }
  await copyFile(sourceModels, path.join(paths.codexHome, "models_cache.json"));
  await chmod(path.join(paths.codexHome, "models_cache.json"), 0o600);

  const sourceHydraConfig = path.join(paths.sourceCodexHome, "hydra", "config.toml");
  if (!(await exists(paths.hydraConfigPath)) && await exists(sourceHydraConfig)) {
    await copyFile(sourceHydraConfig, paths.hydraConfigPath);
    await chmod(paths.hydraConfigPath, 0o600);
  }
  const sourceSelectors = path.join(paths.sourceCodexHome, "hydra", "selectors");
  const targetSelectors = path.join(paths.codexHome, "hydra", "selectors");
  if (!(await exists(targetSelectors)) && await exists(sourceSelectors)) {
    await cp(sourceSelectors, targetSelectors, { recursive: true, force: false });
  }

  const env = developmentEnvironment(paths);
  await spawnAndWait(process.execPath, hydraDevelopmentArgs(paths, "install"), { env });
  logger.log(`Development CODEX_HOME: ${paths.codexHome}`);
  logger.log(`Development SQLite state: ${paths.sqliteHome}`);
  logger.log(`Development Hydra: http://127.0.0.1:${paths.port}`);
  logger.log(`Authenticate once with: npm run dev:login`);
}

export function rejectCodexBypassArgs(args) {
  const forbidden = new Set([
    "-c",
    "--config",
    "--ignore-user-config",
    "--oss",
    "--local-provider",
    "--profile",
    "-p",
    "--with-api-key",
    "--with-access-token",
  ]);
  const found = args.find((arg) => forbidden.has(arg));
  if (found) throw new Error(`${found} is not allowed by the Hydra-only development Codex wrapper`);
}

export function rejectLoginBypassArgs(args) {
  const forbidden = new Set(["-c", "--config", "--with-api-key", "--with-access-token"]);
  const found = args.find((arg) => forbidden.has(arg));
  if (found) throw new Error(`${found} is not allowed for the isolated ChatGPT OAuth login`);
}

async function requireSetup(paths) {
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

async function serverReady(paths) {
  try {
    const response = await fetch(`http://127.0.0.1:${paths.port}/v1/models`);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer(paths, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await serverReady(paths)) return;
    if (child.exitCode != null) throw new Error(`Development Hydra exited with code ${child.exitCode}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Development Hydra did not become ready on port ${paths.port}`);
}

function latestDecision(logText, syntheticModel) {
  const prefix = "[hydra-synthetic-decision] ";
  return logText
    .split(/\r?\n/)
    .filter((line) => line.startsWith(prefix))
    .map((line) => {
      try {
        return JSON.parse(line.slice(prefix.length));
      } catch {
        return null;
      }
    })
    .filter((entry) => entry?.syntheticModel === syntheticModel)
    .at(-1);
}

async function stopChild(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
}

async function codexRoutingDecision(paths, env, syntheticModel, prompt) {
  const offset = await stat(paths.hydraLogPath).then((value) => value.size).catch(() => 0);
  const args = [
    "exec",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "-c",
    'approval_policy="never"',
    "-c",
    `model_catalog_json=${JSON.stringify(paths.catalogPath)}`,
    "-c",
    `openai_base_url=${JSON.stringify(`http://127.0.0.1:${paths.port}`)}`,
    "-m",
    syntheticModel,
    "-c",
    'model_reasoning_effort="low"',
    prompt,
  ];
  const child = spawn(paths.codexBin, args, {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "ignore", "inherit"],
  });
  let spawnError;
  child.once("error", (error) => {
    spawnError = error;
  });

  try {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (spawnError) throw spawnError;
      const log = await readFile(paths.hydraLogPath, "utf8").catch(() => "");
      const decision = latestDecision(log.slice(offset), syntheticModel);
      if (decision) return decision;
      if (child.exitCode != null || child.signalCode != null) {
        throw new Error(`Codex exited before Hydra logged a routing decision`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for Hydra to log a Codex routing decision");
  } finally {
    await stopChild(child);
  }
}

async function verifyRouting(paths) {
  await requireSetup(paths);
  const env = developmentEnvironment(paths);
  let server;
  if (!(await serverReady(paths))) {
    server = spawn(process.execPath, hydraDevelopmentArgs(paths, "serve", ["--debug", "--no-menubar"]), {
      cwd: REPO_ROOT,
      env,
      stdio: "inherit",
    });
    try {
      await waitForServer(paths, server);
    } catch (error) {
      server.kill("SIGTERM");
      await new Promise((resolve) => server.once("exit", resolve));
      throw error;
    }
  }

  const syntheticModel = process.env.HYDRA_DEV_ROUTER_MODEL ?? "hydra/gpt-optimizer";
  const cases = [
    {
      level: "simple",
      expected: process.env.HYDRA_DEV_SIMPLE_MODEL ?? "gpt-5.4-mini",
      prompt: "What is 2 + 2? Reply with only the number.",
    },
    {
      level: "medium",
      expected: process.env.HYDRA_DEV_MEDIUM_MODEL ?? "gpt-5.6-terra",
      prompt: "Implement a moderately complex OAuth login feature in this existing Next.js app across middleware, session storage, callback routes, error handling, and focused tests. Keep the scope bounded to this one app.",
    },
    {
      level: "complex",
      expected: process.env.HYDRA_DEV_COMPLEX_MODEL ?? "gpt-5.6-sol",
      prompt: "Without changing files, design a production-grade multi-region payment platform migration for a large TypeScript monorepo, including architecture, threat model, zero-downtime data migration, idempotency, failure recovery, observability, rollout, and a detailed cross-service implementation plan.",
    },
  ];

  try {
    for (const testCase of cases) {
      const decision = await codexRoutingDecision(paths, env, syntheticModel, testCase.prompt);
      if (decision.fallback) throw new Error(`${testCase.level} selector used fallback ${decision.selected}`);
      if (decision.selected !== testCase.expected) {
        throw new Error(`${testCase.level} selector chose ${decision.selected}; expected ${testCase.expected}`);
      }
      console.log(`${testCase.level}: ${decision.selected}`);
    }
  } finally {
    if (server) {
      server.kill("SIGTERM");
      await new Promise((resolve) => server.once("exit", resolve));
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  const paths = developmentPaths();
  const env = developmentEnvironment(paths);
  if (command === "setup") return setupDevelopmentHome(paths);
  if (command === "login") {
    await mkdir(paths.codexHome, { recursive: true, mode: 0o700 });
    await ensureLocalCodex(paths);
    rejectLoginBypassArgs(args);
    return spawnAndWait(paths.codexBin, ["login", ...args], { env });
  }
  if (command === "verify-routing") return verifyRouting(paths);
  if (command === "codex") {
    await requireSetup(paths);
    rejectCodexBypassArgs(args);
    if (!(await serverReady(paths))) throw new Error(`Development Hydra is not running on port ${paths.port}`);
    return spawnAndWait(paths.codexBin, args, { env });
  }
  if (new Set(["serve", "stop", "refresh", "status", "models", "route", "prompt", "session"]).has(command)) {
    await requireSetup(paths);
    const extra = command === "serve" ? ["--debug", "--no-menubar", ...args] : args;
    return spawnAndWait(process.execPath, hydraDevelopmentArgs(paths, command, extra), { env });
  }
  throw new Error("Usage: dev-codex <setup|login|serve|stop|refresh|status|models|route|prompt|session|codex|verify-routing> [...args]");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
