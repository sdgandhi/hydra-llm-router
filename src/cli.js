#!/usr/bin/env node
import { createServer } from "node:http";
import process from "node:process";
import {
  defaultPaths,
  installHydraConfig,
  loadHydraConfig,
  refreshCatalog,
  restoreConfig,
  stopServer,
  writePidFile,
  removePidFile,
} from "./config.js";
import { configureDebugLog, writeDebugLine } from "./debug.js";
import { createHydraHandler } from "./router.js";

const commands = new Set(["serve", "stop", "refresh", "install", "restore", "status"]);

function usage() {
  return `Usage: hydra <command> [options]

Commands:
  serve       Start the local router
  stop        Stop a router started by serve
  refresh     Rebuild the merged model catalog
  install     Back up Codex config, refresh catalog, and point Codex at Hydra
  restore     Restore the saved Codex config backup
  status      Print configured paths and router settings

Options:
  --port <n>               Router port (default: 3847)
  --codex-home <path>      Codex home (default: ~/.codex)
  --ollama-url <url>       Ollama base URL (default: http://127.0.0.1:11434)
  --openai-base-url <url>  Cloud upstream URL (default: https://chatgpt.com/backend-api/codex)
  --debug-auth            Log redacted request auth/header diagnostics
`;
}

function parseArgs(argv) {
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
    if (key === "--debug-auth") {
      options.debug_auth = true;
      continue;
    }
    if (value == null || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    options[key.slice(2).replaceAll("-", "_")] = value;
    i += 1;
  }

  return { command, options };
}

function buildConfig(options = {}) {
  const paths = defaultPaths(options.codex_home);
  return {
    paths,
    port: Number(options.port ?? process.env.HYDRA_PORT ?? 3847),
    ollamaBaseUrl: options.ollama_url ?? process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    openaiBaseUrl:
      options.openai_base_url ??
      process.env.HYDRA_OPENAI_BASE_URL ??
      "https://chatgpt.com/backend-api/codex",
    debugAuth: Boolean(options.debug_auth ?? process.env.HYDRA_DEBUG_AUTH),
  };
}

async function main() {
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

  if (parsed.command === "refresh") {
    const result = await refreshCatalog(config);
    console.log(`Wrote ${result.catalog.models.length} models to ${config.paths.catalogPath}`);
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

  const handler = createHydraHandler({
    paths: config.paths,
    ollamaBaseUrl: config.ollamaBaseUrl,
    openaiBaseUrl: config.openaiBaseUrl,
    apiKey: process.env.OPENAI_API_KEY,
    debugAuth: config.debugAuth,
  });

  if (config.debugAuth) {
    configureDebugLog(config.paths.logPath);
    writeDebugLine("hydra-start", {
      at: new Date().toISOString(),
      pid: process.pid,
      port: config.port,
      logPath: config.paths.logPath,
    });
  }

  const server = createServer(handler);
  server.on("upgrade", handler.handleUpgrade);
  server.on("error", async (error) => {
    logProcessError("server_error", error);
    await removePidFile(config.paths, process.pid);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });

  const shutdown = async (signal) => {
    if (config.debugAuth) {
      writeDebugLine("hydra-stop", { at: new Date().toISOString(), pid: process.pid, signal });
    }
    server.close(async () => {
      await removePidFile(config.paths, process.pid);
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", async (error) => {
    logProcessError("uncaught_exception", error);
    await removePidFile(config.paths, process.pid);
    process.exit(1);
  });
  process.on("unhandledRejection", async (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logProcessError("unhandled_rejection", error);
    await removePidFile(config.paths, process.pid);
    process.exit(1);
  });

  await writePidFile(config.paths, process.pid);
  server.listen(config.port, "127.0.0.1", () => {
    console.log(`hydra listening on http://127.0.0.1:${config.port}`);
    if (config.debugAuth) {
      console.log(`hydra debug log: ${config.paths.logPath}`);
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

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
