import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function shouldStartMenuBar({ platform = process.platform, noMenuBar = false } = {}) {
  return platform === "darwin" && !noMenuBar;
}

export function startMenuBar(config, { onQuit, spawnImpl = spawn } = {}) {
  if (!shouldStartMenuBar({ noMenuBar: config.noMenuBar })) return null;

  const helperPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "menubar.swift");
  const child = spawnImpl("/usr/bin/swift", [helperPath, JSON.stringify(menuBarPayload(config))], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      handleHelperLine(line, onQuit);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    for (const line of chunk.split("\n")) {
      if (line.trim()) console.error(`hydra menubar: ${line}`);
    }
  });

  child.on("error", (error) => {
    console.error(`hydra menubar failed to start: ${error.message}`);
  });

  return {
    stop() {
      if (!child.killed) child.kill("SIGTERM");
    },
  };
}

export function menuBarStatusItems(config) {
  const items = [
    { kind: "info", title: "Hydra Running" },
    { kind: "separator" },
    { kind: "info", title: `Router: http://127.0.0.1:${config.port}` },
    { kind: "info", title: `Cloud: ${config.openaiBaseUrl}` },
    { kind: "info", title: `Ollama: ${config.ollamaBaseUrl}` },
    { kind: "info", title: `Emulated tools: ${emulatedToolsLabel(config.emulatedToolStatuses ?? [])}` },
  ];

  items.push(
    { kind: "info", title: config.debugAuth ? `Debug log: ${config.paths.logPath}` : "Debug logging: off" },
    { kind: "info", title: `Codex config: ${config.paths.codexConfigPath}` },
  );
  return items;
}

function emulatedToolsLabel(statuses) {
  if (!statuses.length) return "unknown";
  return statuses
    .map((tool) => {
      const detail = tool.detail ? ` (${tool.detail})` : "";
      return `${tool.name}: ${tool.status}${detail}`;
    })
    .join(", ");
}

function handleHelperLine(line, onQuit) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message?.type === "quit") onQuit?.();
}

function menuBarPayload(config) {
  return {
    title: "Hydra",
    iconPath: path.join(path.dirname(fileURLToPath(import.meta.url)), "hydra-menubar.png"),
    statusItems: menuBarStatusItems(config),
  };
}
