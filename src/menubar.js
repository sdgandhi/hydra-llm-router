import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { catalogModelTitles } from "./catalog.js";

export function shouldStartMenuBar({ platform = process.platform, noMenuBar = false } = {}) {
  return platform === "darwin" && !noMenuBar;
}

export function startMenuBar(
  config,
  { onQuit, onRefresh, onInstall, onRestore, onCreateSynthetic, spawnImpl = spawn } = {},
) {
  if (!shouldStartMenuBar({ noMenuBar: config.noMenuBar })) return null;

  const helperPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "menubar.swift");
  const helperBin = process.env.HYDRA_MENUBAR_BIN;
  const command = helperBin || "/usr/bin/swift";
  const args = helperBin
    ? [JSON.stringify(menuBarPayload(config))]
    : [helperPath, JSON.stringify(menuBarPayload(config))];
  const child = spawnImpl(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuffer = "";
  const send = (message) => {
    if (!child.killed && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      handleHelperLine(line, {
        onQuit,
        onRefresh,
        onInstall,
        onRestore,
        onCreateSynthetic: async (input, requestId) => {
          try {
            const result = await onCreateSynthetic?.(input);
            send({ type: "create_synthetic_result", requestId, ok: true, ...result });
          } catch (error) {
            send({
              type: "create_synthetic_result",
              requestId,
              ok: false,
              error: error?.message ?? "Could not create synthetic model",
            });
          }
        },
      });
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
    update(nextConfig) {
      send({ type: "update", info: menuBarPayload(nextConfig) });
    },
    stop() {
      if (!child.killed) child.kill("SIGTERM");
    },
  };
}

export function menuBarStatusItems(config) {
  const modelTitles = catalogModelTitles(config.catalog);
  const items = [
    { kind: "info", title: "Hydra Running" },
    { kind: "info", title: `Version: ${config.version ?? "development"}` },
    { kind: "info", title: `Codex routing: ${config.installed ? "installed" : "not installed"}` },
    { kind: "action", id: "install", title: "Install Hydra in Codex" },
    { kind: "action", id: "restore", title: "Restore Codex Config" },
    { kind: "action", id: "refresh", title: "Refresh" },
    { kind: "action", id: "open_config", title: "Open Hydra Config" },
    { kind: "separator" },
    {
      kind: "submenu",
      title: `Models (${modelTitles.length})`,
      items: modelTitles.length
        ? modelTitles.map((title) => ({ kind: "info", title }))
        : [{ kind: "info", title: "No models detected" }],
    },
    syntheticModelsMenu(config),
    { kind: "separator" },
    { kind: "info", title: `Router: http://127.0.0.1:${config.port}` },
    { kind: "info", title: `Cloud: ${config.openaiBaseUrl}` },
    { kind: "info", title: `Ollama: ${config.ollamaBaseUrl}` },
    { kind: "info", title: `LM Studio: ${config.lmStudioBaseUrl}` },
    { kind: "info", title: `OMLX: ${config.omlxBaseUrl}` },
    { kind: "info", title: `Emulated tools: ${emulatedToolsLabel(config.emulatedToolStatuses ?? [])}` },
    { kind: "info", title: `App tools: ${appToolsLabel(config.appToolStatus)}` },
  ];

  items.push(
    { kind: "info", title: config.debugAuth ? `Debug log: ${config.paths.logPath}` : "Debug logging: off" },
    { kind: "info", title: `Codex config: ${config.paths.codexConfigPath}` },
    ...(config.menuNotice ? [{ kind: "info", title: config.menuNotice }] : []),
  );
  return items;
}

function syntheticModelsMenu(config) {
  const definitions = config.syntheticConfig?.definitions ?? [];
  const lastSelections = config.syntheticState?.lastSelections;
  const children = definitions.map((definition) => {
    const last = lastSelections?.get?.(definition.slug);
    return {
      kind: "submenu",
      title: definition.slug,
      items: [
        { kind: "info", title: definition.displayName },
        { kind: "reveal", title: `Selector: ${definition.selector}`, path: definition.selectorPath },
        { kind: "info", title: `Candidates: ${definition.candidates.join(", ")}` },
        { kind: "info", title: `Fallback: ${definition.fallbackModel}` },
        { kind: "info", title: `Selector type: ${definition.selectorType}` },
        { kind: "info", title: `Selector model: ${definition.selectorModel ?? "none"}` },
        { kind: "info", title: `Scope: ${definition.routingScope}` },
        { kind: "info", title: definition.selectorType === "prompt"
          ? "Selector input: latest user + counts"
          : "Selector input: full normalized context" },
        { kind: "info", title: `Sticky tools: ${definition.stickyToolContinuations ? "on" : "off"}` },
        { kind: "info", title: `Routing commentary: ${definition.showRoutingCommentary === false ? "off" : "on"}` },
        { kind: "info", title: `Timeout: ${definition.selectorTimeoutMs || "off"}` },
        { kind: "info", title: `Retries: ${definition.retryCount} × ${definition.retryDelayMs}ms` },
        { kind: "info", title: last ? `Last: ${last.ultimate}` : "Last: none" },
      ],
    };
  });
  return {
    kind: "submenu",
    title: `Synthetic Models (${definitions.length})`,
    items: [
      { kind: "action", id: "new_synthetic", title: "New…" },
      { kind: "separator" },
      ...(children.length ? children : [{ kind: "info", title: "No synthetic models" }]),
    ],
  };
}

export function menuModelOptions(catalog) {
  return (catalog?.models ?? [])
    .filter((model) => typeof model?.slug === "string" && !model.slug.startsWith("hydra/"))
    .map((model) => ({
      slug: model.slug,
      title: model.display_name && model.display_name !== model.slug
        ? `${model.display_name} (${model.slug})`
        : model.slug,
    }))
    .sort((left, right) => left.title.localeCompare(right.title));
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

function appToolsLabel(status) {
  if (!status) return "unknown";
  if (status.status === "disabled") return "disabled";
  const servers = Array.isArray(status.servers) && status.servers.length ? status.servers.join(",") : "unknown";
  if (status.status === "ready") return `${servers}: ${status.toolCount} ready`;
  const detail = status.detail ? ` (${status.detail})` : "";
  return `${servers}: ${status.status}${detail}`;
}

export function handleHelperLine(line, { onQuit, onRefresh, onInstall, onRestore, onCreateSynthetic }) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message?.type === "quit") onQuit?.();
  if (message?.type === "action" && message.id === "install") onInstall?.();
  if (message?.type === "action" && message.id === "restore") onRestore?.();
  if (message?.type === "action" && message.id === "refresh") onRefresh?.();
  if (message?.type === "create_synthetic") onCreateSynthetic?.(message.model, message.requestId);
}

function menuBarPayload(config) {
  return {
    title: "Hydra",
    iconPath: path.join(path.dirname(fileURLToPath(import.meta.url)), "hydra-menubar.png"),
    configPath: config.paths.hydraConfigPath,
    availableModels: menuModelOptions(config.catalog),
    existingSyntheticSlugs: (config.syntheticConfig?.definitions ?? []).map((definition) => definition.slug),
    statusItems: menuBarStatusItems(config),
  };
}
