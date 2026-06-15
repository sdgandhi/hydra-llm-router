import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

const DEFAULT_CLIENT_INFO = {
  name: "hydra",
  title: "Hydra",
  version: "0.1.0",
};
const DEFAULT_APP_TOOL_SERVERS = ["codex_apps"];
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_TOOL_CACHE_MS = 60000;
const CODEX_BIN_CANDIDATES = [
  "/Applications/Codex.app/Contents/Resources/codex",
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
];

export function parseAppToolServers(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value ?? DEFAULT_APP_TOOL_SERVERS.join(","))
    .split(",")
    .map((server) => server.trim())
    .filter(Boolean);
}

export function resolveCodexBin(codexBin = "codex", { env = process.env } = {}) {
  if (codexBin.includes("/") || isAbsolute(codexBin)) return codexBin;

  for (const dir of String(env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)) {
    const candidate = join(dir, codexBin);
    if (existsSync(candidate)) return candidate;
  }

  if (codexBin === "codex") {
    for (const candidate of CODEX_BIN_CANDIDATES) {
      if (existsSync(candidate)) return candidate;
    }
  }

  return codexBin;
}

export function mcpToolToOllamaTool({ server, tool }) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters:
        tool.inputSchema && typeof tool.inputSchema === "object"
          ? tool.inputSchema
          : { type: "object", properties: {} },
    },
    _hydraAppTool: {
      server,
      title: tool.title ?? null,
      annotations: tool.annotations ?? null,
      meta: tool._meta ?? null,
    },
  };
}

export function appToolSourceFromOllamaTool(tool) {
  const source = tool?.function ?? tool ?? {};
  return {
    type: "function",
    name: source.name,
    description: source.description ?? "",
    parameters: source.parameters ?? { type: "object", properties: {} },
  };
}

export function formatMcpToolResult(result) {
  if (result?.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .map((item) => {
      if (typeof item?.text === "string") return item.text;
      if (item == null) return "";
      return JSON.stringify(item);
    })
    .filter(Boolean)
    .join("\n");
  if (text) return text;
  return JSON.stringify(result ?? {});
}

export class AppServerBridge {
  constructor({
    enabled = true,
    codexBin = "codex",
    toolServers = DEFAULT_APP_TOOL_SERVERS,
    cwd,
    model,
    spawnImpl = spawn,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    toolCacheMs = DEFAULT_TOOL_CACHE_MS,
    clientInfo = DEFAULT_CLIENT_INFO,
  } = {}) {
    this.enabled = enabled;
    this.codexBin = resolveCodexBin(codexBin);
    this.toolServers = parseAppToolServers(toolServers);
    this.cwd = cwd;
    this.model = model;
    this.spawnImpl = spawnImpl;
    this.requestTimeoutMs = requestTimeoutMs;
    this.toolCacheMs = toolCacheMs;
    this.clientInfo = clientInfo;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.started = null;
    this.threadId = null;
    this.toolCache = null;
  }

  async status() {
    if (!this.enabled) {
      return { enabled: false, status: "disabled", toolCount: 0, servers: this.toolServers };
    }
    try {
      const tools = await this.getTools();
      return { enabled: true, status: "ready", toolCount: tools.length, servers: this.toolServers };
    } catch (error) {
      return {
        enabled: true,
        status: "unavailable",
        toolCount: 0,
        servers: this.toolServers,
        detail: error.message,
      };
    }
  }

  async getTools({ force = false } = {}) {
    if (!this.enabled) return [];
    const now = Date.now();
    if (!force && this.toolCache && now - this.toolCache.loadedAt < this.toolCacheMs) {
      return this.toolCache.tools;
    }

    await this.start();
    const response = await this.request("mcpServerStatus/list", {
      limit: 100,
      toolsAndAuthOnly: true,
    });
    const toolServers = new Set(this.toolServers);
    const tools = [];
    for (const server of response?.data ?? []) {
      if (!toolServers.has(server.name)) continue;
      for (const tool of Object.values(server.tools ?? {})) {
        if (!tool?.name) continue;
        tools.push(mcpToolToOllamaTool({ server: server.name, tool }));
      }
    }
    this.toolCache = { loadedAt: now, tools };
    return tools;
  }

  async callTool({ name, argumentsText }) {
    const tools = await this.getTools();
    const tool = tools.find((candidate) => candidate.function?.name === name);
    if (!tool) throw new Error(`Unknown App Server tool: ${name}`);
    const threadId = await this.ensureThread();
    const result = await this.request("mcpServer/tool/call", {
      threadId,
      server: tool._hydraAppTool.server,
      tool: name,
      arguments: parseArguments(argumentsText),
    });
    return formatMcpToolResult(result);
  }

  async ensureThread() {
    if (this.threadId) return this.threadId;
    await this.start();
    const params = {};
    if (this.cwd) params.cwd = this.cwd;
    if (this.model) params.model = this.model;
    const response = await this.request("thread/start", params);
    const threadId = response?.thread?.id;
    if (!threadId) throw new Error("App Server did not return a bridge thread id");
    this.threadId = threadId;
    return threadId;
  }

  async start() {
    if (!this.enabled) throw new Error("App Server tools are disabled");
    if (this.started) return this.started;
    this.started = this.startProcess();
    return this.started;
  }

  async startProcess() {
    this.proc = this.spawnImpl(this.codexBin, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", () => {});
    this.proc.once("exit", () => {
      const error = new Error("Codex app-server exited");
      for (const { reject, timeout } of this.pending.values()) {
        clearTimeout(timeout);
        reject(error);
      }
      this.pending.clear();
      this.proc = null;
      this.started = null;
      this.threadId = null;
      this.toolCache = null;
    });
    this.proc.once("error", (error) => {
      for (const { reject, timeout } of this.pending.values()) {
        clearTimeout(timeout);
        reject(error);
      }
      this.pending.clear();
      this.proc = null;
      this.started = null;
      this.threadId = null;
      this.toolCache = null;
    });

    await this.request("initialize", {
      clientInfo: this.clientInfo,
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
  }

  request(method, params = {}) {
    if (!this.proc?.stdin?.writable) throw new Error("Codex app-server process is not running");
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for App Server method: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.proc.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    if (!this.proc?.stdin?.writable) return;
    this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!message.id || !this.pending.has(message.id)) continue;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  close() {
    if (!this.proc) return;
    this.proc.kill("SIGTERM");
  }
}

export function createAppServerBridge(options = {}) {
  return new AppServerBridge(options);
}

function parseArguments(argumentsText) {
  if (!argumentsText) return {};
  if (typeof argumentsText !== "string") return argumentsText;
  try {
    return JSON.parse(argumentsText);
  } catch {
    return { input: argumentsText };
  }
}
