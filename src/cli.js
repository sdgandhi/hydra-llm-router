#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  defaultPaths,
  installHydraConfig,
  loadCatalog,
  loadHydraConfig,
  refreshCatalog,
  restoreConfig,
  stopServer,
  writePidFile,
  removePidFile,
} from "./config.js";
import { catalogModelTitles } from "./catalog.js";
import { createAppServerBridge, parseAppToolServers, resolveCodexBin } from "./app-server.js";
import { configureDebugLog, writeDebugLine } from "./debug.js";
import { menuBarStatusItems, startMenuBar } from "./menubar.js";
import { createHydraHandler, emulatedToolStatuses } from "./router.js";
import { loadSyntheticConfig } from "./synthetic-config.js";

const commands = new Set(["serve", "stop", "refresh", "install", "restore", "status", "models", "route", "prompt", "session"]);
const booleanOptions = new Set(["--debug", "--no-menubar", "--json"]);
const repeatableOptions = new Set(["--input", "--file", "--image"]);

function usage() {
  return `Usage: hydra <command> [options]

Commands:
  serve       Start the local router
  stop        Stop a router started by serve
  refresh     Rebuild the merged model catalog
  install     Back up Codex config, refresh catalog, and point Codex at Hydra
  restore     Restore the saved Codex config backup
  status      Print configured paths and router settings
  models      Print detected catalog models
  route       Run a synthetic selector and print the target model
  prompt      Run one complete prompt through Hydra via Codex CLI
  session     Run multiple prompts in one Codex CLI session through Hydra

Options:
  --port <n>               Router port (default: 3847)
  --codex-home <path>      Codex home (default: ~/.codex)
  --ollama-url <url>       Ollama base URL (default: http://127.0.0.1:11434)
  --lmstudio-url <url>     LM Studio base URL (default: http://127.0.0.1:11239)
  --openai-base-url <url>  Cloud upstream URL (default: https://chatgpt.com/backend-api/codex)
  --app-tools <auto|off>   Expose Codex app-server tools to local models (default: auto)
  --app-tool-servers <csv> App-server MCP servers to expose (default: codex_apps)
  --codex-bin <path>       Codex CLI binary for app-server tools (default: codex)
  --model <slug>           Model for route, prompt, or session
  --input <text>           Prompt text; repeat for session turns
  --file <path>            Append a text file to the prompt; repeatable
  --image <path>           Attach an image; repeatable
  --reasoning <effort>     Requested reasoning effort
  --session-id <id>        Resume an existing Codex CLI session
  --json                   Preserve Codex CLI JSONL output for prompt
  --debug                  Log redacted request and synthetic routing diagnostics
  --no-menubar            Do not show the macOS menu bar item while serving
`;
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!commands.has(command)) {
    throw new Error(command ? `Unknown command: ${command}` : "Missing command");
  }

  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key.startsWith("--")) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    if (booleanOptions.has(key)) {
      options[key.slice(2).replaceAll("-", "_")] = true;
      continue;
    }
    if (value == null || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    const optionName = key.slice(2).replaceAll("-", "_");
    if (repeatableOptions.has(key)) {
      const values = options[optionName] ?? [];
      values.push(value);
      options[optionName] = values;
    } else {
      options[optionName] = value;
    }
    i += 1;
  }

  return { command, options };
}

export function buildConfig(options = {}) {
  const paths = defaultPaths(options.codex_home);
  return {
    paths,
    port: Number(options.port ?? process.env.HYDRA_PORT ?? 3847),
    ollamaBaseUrl: options.ollama_url ?? process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    lmStudioBaseUrl:
      options.lmstudio_url ?? process.env.LMSTUDIO_BASE_URL ?? "http://127.0.0.1:11239",
    openaiBaseUrl:
      options.openai_base_url ??
      process.env.HYDRA_OPENAI_BASE_URL ??
      "https://chatgpt.com/backend-api/codex",
    appTools: options.app_tools ?? process.env.HYDRA_APP_TOOLS ?? "auto",
    appToolServers: parseAppToolServers(options.app_tool_servers ?? process.env.HYDRA_APP_TOOL_SERVERS),
    codexBin: options.codex_bin ?? process.env.HYDRA_CODEX_BIN ?? "codex",
    debugAuth: Boolean(options.debug ?? process.env.HYDRA_DEBUG ?? process.env.HYDRA_DEBUG_AUTH),
    noMenuBar: Boolean(options.no_menubar),
  };
}

export async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  const config = buildConfig(parsed.options);

  if (parsed.command === "route") {
    await runRouteCommand(config, parsed.options);
    return;
  }

  if (parsed.command === "prompt") {
    await runPromptCommand(config, parsed.options);
    return;
  }

  if (parsed.command === "session") {
    await runSessionCommand(config, parsed.options);
    return;
  }

  if (parsed.command === "refresh") {
    const result = await refreshCatalog(config);
    console.log(`Wrote ${result.catalog.models.length} models to ${config.paths.catalogPath}`);
    await notifyRunningHydra(config);
    return;
  }

  if (parsed.command === "install") {
    const result = await installHydraConfig(config);
    console.log(`Backed up Codex config to ${result.backupPath}`);
    console.log(`Wrote ${result.catalog.models.length} models to ${config.paths.catalogPath}`);
    console.log(`Codex OpenAI provider routed through Hydra on http://127.0.0.1:${config.port}`);
    return;
  }

  if (parsed.command === "restore") {
    const result = await restoreConfig(config.paths);
    console.log(`Restored Codex config from ${result.backupPath}`);
    return;
  }

  if (parsed.command === "stop") {
    const result = await stopServer(config.paths);
    console.log(`Stopped Hydra server process ${result.pid}`);
    return;
  }

  if (parsed.command === "status") {
    const saved = await loadHydraConfig(config.paths);
    console.log(
      JSON.stringify(
        {
          ...config,
          paths: config.paths,
          saved,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (parsed.command === "models") {
    const catalog = await loadCatalog(config.paths);
    const modelTitles = catalogModelTitles(catalog);
    if (!modelTitles.length) {
      console.log(`No models detected in ${config.paths.catalogPath}`);
      return;
    }

    console.log(`Detected ${modelTitles.length} models in ${config.paths.catalogPath}:`);
    for (const title of modelTitles) {
      console.log(`- ${title}`);
    }
    return;
  }

  config.syntheticConfig = await loadSyntheticConfig(config.paths);
  let menuBar = null;
  const reloadRuntimeView = async () => {
    config.catalog = await loadCatalog(config.paths);
    config.syntheticConfig = await loadSyntheticConfig(config.paths);
    menuBar?.update(config);
  };

  const appServerBridge = createAppServerBridge({
    enabled: config.appTools !== "off",
    codexBin: config.codexBin,
    toolServers: config.appToolServers,
    cwd: process.cwd(),
  });
  const handler = createHydraHandler({
    paths: config.paths,
    ollamaBaseUrl: config.ollamaBaseUrl,
    lmStudioBaseUrl: config.lmStudioBaseUrl,
    openaiBaseUrl: config.openaiBaseUrl,
    apiKey: process.env.OPENAI_API_KEY,
    debugAuth: config.debugAuth,
    appServerBridge,
    onSyntheticSelection: () => menuBar?.update(config),
    onReload: reloadRuntimeView,
  });
  config.syntheticState = handler.syntheticState;
  config.emulatedToolStatuses = await emulatedToolStatuses();
  config.appToolStatus = await appServerBridge.status();

  if (config.debugAuth) {
    configureDebugLog(config.paths.logPath);
    writeDebugLine("hydra-start", {
      at: new Date().toISOString(),
      pid: process.pid,
      port: config.port,
      logPath: config.paths.logPath,
    });
  }

  config.catalog = await loadCatalog(config.paths);

  const server = createServer(handler);
  let shuttingDown = false;

  const shutdown = async ({ signal, restoreOnQuit = false }) => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdownHydra({
      config,
      server,
      menuBar,
      appServerBridge,
      signal,
      restoreOnQuit,
    });
  };

  server.on("upgrade", handler.handleUpgrade);
  server.on("error", async (error) => {
    logProcessError("server_error", error);
    appServerBridge.close();
    menuBar?.stop();
    await removePidFile(config.paths, process.pid);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });

  process.on("SIGINT", () => shutdown({ signal: "SIGINT" }));
  process.on("SIGTERM", () => shutdown({ signal: "SIGTERM" }));
  process.on("uncaughtException", async (error) => {
    logProcessError("uncaught_exception", error);
    appServerBridge.close();
    menuBar?.stop();
    await removePidFile(config.paths, process.pid);
    process.exit(1);
  });
  process.on("unhandledRejection", async (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logProcessError("unhandled_rejection", error);
    appServerBridge.close();
    menuBar?.stop();
    await removePidFile(config.paths, process.pid);
    process.exit(1);
  });

  menuBar = startMenuBar(config, {
    onQuit: () => shutdown({ signal: "menubar", restoreOnQuit: true }),
    onRefresh: async () => {
      try {
        await refreshCatalog(config);
        handler.syntheticState.clear();
        await reloadRuntimeView();
        console.log("Hydra catalog refreshed");
      } catch (error) {
        console.error(`Hydra refresh failed: ${error.message}`);
      }
    },
    onOpenConfig: () => {
      const child = spawn("/usr/bin/open", [config.paths.hydraConfigPath], { stdio: "ignore" });
      child.unref();
    },
  });

  await writePidFile(config.paths, process.pid);
  server.listen(config.port, "127.0.0.1", () => {
    for (const item of menuBarStatusItems(config)) {
      if (item.kind !== "separator") console.log(item.title);
    }
  });

  function logProcessError(stage, error) {
    if (config.debugAuth) {
      writeDebugLine("hydra-process-error", {
        at: new Date().toISOString(),
        pid: process.pid,
        stage,
        error: {
          name: error?.name,
          message: error?.message,
          code: error?.code,
          stack: error?.stack,
        },
      });
    }
  }
}

async function notifyRunningHydra(config) {
  try {
    await fetch(`http://127.0.0.1:${config.port}/hydra/reload`, { method: "POST" });
  } catch {
    // Refresh is also valid while the server is stopped.
  }
}

function optionValues(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

async function promptText(options, { allowStdin = true } = {}) {
  const parts = [...optionValues(options.input)];
  for (const filePath of optionValues(options.file)) {
    parts.push(`<file path=${JSON.stringify(filePath)}>\n${await readFile(filePath, "utf8")}\n</file>`);
  }
  if (!parts.length && allowStdin && !process.stdin.isTTY) {
    const stdin = await readFile(0, "utf8");
    if (stdin.trim()) parts.push(stdin);
  }
  return parts.join("\n\n");
}

function requireModel(options) {
  if (!options.model) throw new Error("Missing --model <slug>");
  return options.model;
}

export function codexConfigArgs(config, options) {
  const args = [
    "-c",
    `model_catalog_json=${JSON.stringify(config.paths.catalogPath)}`,
    "-c",
    `openai_base_url=${JSON.stringify(`http://127.0.0.1:${config.port}`)}`,
    "-m",
    requireModel(options),
  ];
  if (options.reasoning) args.push("-c", `model_reasoning_effort=${JSON.stringify(options.reasoning)}`);
  for (const imagePath of optionValues(options.image)) args.push("-i", imagePath);
  return args;
}

export async function runRouteCommand(config, options, { fetchImpl = globalThis.fetch, logger = console } = {}) {
  const model = requireModel(options);
  const text = await promptText(options);
  const content = [{ type: "input_text", text }];
  for (const imagePath of optionValues(options.image)) content.push({ type: "input_image", image_url: imagePath });
  const body = {
    model,
    input: [{ role: "user", content }],
    stream: false,
    reasoning: { effort: options.reasoning ?? "medium" },
  };
  const response = await fetchImpl(`http://127.0.0.1:${config.port}/hydra/route`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "hydra-cli" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? `Hydra route failed with HTTP ${response.status}`);
  logger.log(result.target);
  return result;
}

function spawnAndWait(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve({ code, signal });
      else reject(new Error(`${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}

export async function runPromptCommand(config, options) {
  const prompt = await promptText(options);
  if (!prompt && !optionValues(options.image).length) throw new Error("Prompt input is empty");
  const codexBin = resolveCodexBin(config.codexBin);
  const args = [
    "exec",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox",
    "read-only",
    "-c",
    'approval_policy="never"',
    ...codexConfigArgs(config, options),
  ];
  if (options.json) args.push("--json");
  args.push(prompt || "Describe the attached image.");
  return spawnAndWait(codexBin, args, { cwd: process.cwd(), stdio: ["ignore", "inherit", "inherit"] });
}

export function parseCodexJsonEvent(event, output = process.stdout) {
  const threadId = event?.thread_id ?? event?.thread?.id;
  const item = event?.item;
  if (event?.type === "item.completed" && item?.type === "agent_message" && item.text) {
    output.write(`${item.text}\n`);
  }
  if (event?.type === "turn.failed") {
    output.write(`Hydra session turn failed: ${event.error?.message ?? "unknown error"}\n`);
  }
  return threadId;
}

async function runCodexJson(codexBin, args, { output = process.stdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBin, args, { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] });
    let buffer = "";
    let threadId;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          threadId = parseCodexJsonEvent(JSON.parse(line), output) ?? threadId;
        } catch {
          output.write(`${line}\n`);
        }
      }
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (buffer.trim()) output.write(`${buffer}\n`);
      if (code === 0) resolve({ threadId });
      else reject(new Error(`${codexBin} exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}

async function sessionInputs(options) {
  const configured = optionValues(options.input);
  if (configured.length) {
    const [first, ...rest] = configured;
    return [await promptText({ ...options, input: [first] }, { allowStdin: false }), ...rest];
  }
  if (optionValues(options.file).length) {
    return [await promptText({ ...options, input: [] }, { allowStdin: false })];
  }
  if (!process.stdin.isTTY) {
    return (await readFile(0, "utf8")).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
  return null;
}

export async function runSessionCommand(config, options) {
  requireModel(options);
  const codexBin = resolveCodexBin(config.codexBin);
  let threadId = options.session_id;
  const runTurn = async (text) => {
    const configArgs = [
      "--ignore-user-config",
      "--skip-git-repo-check",
      "-c",
      'approval_policy="never"',
      ...codexConfigArgs(config, options),
      "--json",
    ];
    const args = threadId
      ? ["exec", "resume", ...configArgs, threadId, text]
      : [
          "exec",
          "--sandbox",
          "read-only",
          ...configArgs,
          text,
        ];
    const result = await runCodexJson(codexBin, args);
    threadId = result.threadId ?? threadId;
    if (!threadId) throw new Error("Codex CLI did not report a session id");
    return threadId;
  };

  const inputs = await sessionInputs(options);
  if (inputs) {
    if (!inputs.length) throw new Error("Session input is empty");
    for (const input of inputs) await runTurn(input);
    console.log(`Session: ${threadId}`);
    return { threadId };
  }

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const input = (await readline.question("hydra> ")).trim();
      if (!input || input === "/exit" || input === "/quit") break;
      await runTurn(input);
    }
  } finally {
    readline.close();
  }
  console.log(`Session: ${threadId ?? "not started"}`);
  return { threadId };
}

export async function shutdownHydra({
  config,
  server,
  menuBar,
  appServerBridge = null,
  signal,
  restoreOnQuit = false,
  restoreImpl = restoreConfig,
  removePidFileImpl = removePidFile,
  exitImpl = process.exit,
  logger = console,
}) {
  if (config.debugAuth) {
    writeDebugLine("hydra-stop", { at: new Date().toISOString(), pid: process.pid, signal });
  }

  let restoreStatus = "not_requested";
  if (restoreOnQuit) {
    try {
      const result = await restoreImpl(config.paths);
      restoreStatus = "restored";
      logger.log(`Restored Codex config from ${result.backupPath}`);
    } catch (error) {
      if (error.code === "ENOENT") {
        restoreStatus = "missing_backup";
        logger.warn(`Hydra config restore skipped; no backup found at ${config.paths.backupPath}`);
      } else {
        restoreStatus = "failed";
        logger.error(`Hydra config restore failed: ${error.stack || error.message}`);
      }
    }
  }

  await closeServer(server);
  await removePidFileImpl(config.paths, process.pid);
  appServerBridge?.close();
  menuBar?.stop();
  exitImpl(0);
  return { restoreStatus };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") reject(error);
      else resolve();
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
