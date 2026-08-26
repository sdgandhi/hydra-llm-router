import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "smol-toml";

export const HYDRA_CONFIG_DEFAULTS = Object.freeze({
  port: 3847,
  debug: false,
  menubar: true,
  codexHome: "~/.codex",
  codexBin: "codex",
  openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
  openaiApiKey: null,
  ollamaBaseUrl: "http://127.0.0.1:11434",
  ollamaContextWindow: null,
  lmStudioBaseUrl: "http://127.0.0.1:11239",
  lmStudioContextWindow: null,
  appTools: "auto",
  appToolServers: ["codex_apps"],
  webSearchCommands: [["./bin/ddgr"], ["ddgr"], ["search"], ["duckduckgo"]],
});

const TOP_LEVEL_KEYS = new Set(["hydra", "codex", "providers", "app_tools", "tools", "synthetic_models"]);
const TABLE_KEYS = {
  hydra: new Set(["port", "debug", "menubar", "data_dir"]),
  codex: new Set(["home", "binary"]),
  providers: new Set(["openai", "ollama", "lmstudio"]),
  openai: new Set(["base_url", "api_key"]),
  ollama: new Set(["base_url", "context_window"]),
  lmstudio: new Set(["base_url", "context_window"]),
  app_tools: new Set(["mode", "servers"]),
  tools: new Set(["web_search_commands"]),
};

function table(value, name) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be a TOML table`);
  return value;
}

function rejectUnknown(value, allowed, name) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`Unknown Hydra config key: ${name}.${unknown}`);
}

function optionalString(value, name, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function optionalBoolean(value, name, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function optionalInteger(value, name, fallback, { allowZero = false } = {}) {
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? "a nonnegative" : "a positive"} integer`);
  }
  return value || null;
}

function stringArray(value, name, fallback) {
  if (value == null) return [...fallback];
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${name} must be a non-empty array of strings`);
  }
  return value.map((item) => item.trim());
}

function commandArray(value, name, fallback) {
  if (value == null) return fallback.map((command) => [...command]);
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some(
      (command) =>
        !Array.isArray(command) ||
        !command.length ||
        command.some((part) => typeof part !== "string" || !part.trim()),
    )
  ) {
    throw new Error(`${name} must be a non-empty array of non-empty string arrays`);
  }
  return value.map((command) => command.map((part) => part.trim()));
}

function resolveFromConfig(value, configPath) {
  if (!value) return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  if (value === ".") return path.dirname(configPath);
  if (value.startsWith("./") || value.startsWith("../")) return path.resolve(path.dirname(configPath), value);
  return value;
}

function resolveCommands(commands, configPath) {
  return commands.map(([bin, ...args]) => [resolveFromConfig(bin, configPath), ...args]);
}

export function parseHydraSettings(text, { configPath }) {
  let parsed;
  try {
    parsed = parse(text);
  } catch (error) {
    throw new Error(`Invalid Hydra TOML at ${configPath}: ${error.message}`);
  }
  const unknownTop = Object.keys(parsed).find((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknownTop) throw new Error(`Unknown Hydra config key: ${unknownTop}`);

  const hydra = table(parsed.hydra, "hydra");
  const codex = table(parsed.codex, "codex");
  const providers = table(parsed.providers, "providers");
  const openai = table(providers.openai, "providers.openai");
  const ollama = table(providers.ollama, "providers.ollama");
  const lmstudio = table(providers.lmstudio, "providers.lmstudio");
  const appTools = table(parsed.app_tools, "app_tools");
  const tools = table(parsed.tools, "tools");
  rejectUnknown(hydra, TABLE_KEYS.hydra, "hydra");
  rejectUnknown(codex, TABLE_KEYS.codex, "codex");
  rejectUnknown(providers, TABLE_KEYS.providers, "providers");
  rejectUnknown(openai, TABLE_KEYS.openai, "providers.openai");
  rejectUnknown(ollama, TABLE_KEYS.ollama, "providers.ollama");
  rejectUnknown(lmstudio, TABLE_KEYS.lmstudio, "providers.lmstudio");
  rejectUnknown(appTools, TABLE_KEYS.app_tools, "app_tools");
  rejectUnknown(tools, TABLE_KEYS.tools, "tools");

  const mode = optionalString(appTools.mode, "app_tools.mode", HYDRA_CONFIG_DEFAULTS.appTools);
  if (!new Set(["auto", "off"]).has(mode)) throw new Error("app_tools.mode must be auto or off");
  const rawCommands = commandArray(
    tools.web_search_commands,
    "tools.web_search_commands",
    HYDRA_CONFIG_DEFAULTS.webSearchCommands,
  );
  return {
    configPath,
    dataDir: resolveFromConfig(optionalString(hydra.data_dir, "hydra.data_dir", "."), configPath),
    port: optionalInteger(hydra.port, "hydra.port", HYDRA_CONFIG_DEFAULTS.port),
    debug: optionalBoolean(hydra.debug, "hydra.debug", HYDRA_CONFIG_DEFAULTS.debug),
    menubar: optionalBoolean(hydra.menubar, "hydra.menubar", HYDRA_CONFIG_DEFAULTS.menubar),
    codexHome: resolveFromConfig(
      optionalString(codex.home, "codex.home", HYDRA_CONFIG_DEFAULTS.codexHome),
      configPath,
    ),
    codexBin: resolveFromConfig(
      optionalString(codex.binary, "codex.binary", HYDRA_CONFIG_DEFAULTS.codexBin),
      configPath,
    ),
    openaiBaseUrl: optionalString(
      openai.base_url,
      "providers.openai.base_url",
      HYDRA_CONFIG_DEFAULTS.openaiBaseUrl,
    ),
    openaiApiKey: optionalString(openai.api_key, "providers.openai.api_key", null),
    ollamaBaseUrl: optionalString(
      ollama.base_url,
      "providers.ollama.base_url",
      HYDRA_CONFIG_DEFAULTS.ollamaBaseUrl,
    ),
    ollamaContextWindow: optionalInteger(
      ollama.context_window,
      "providers.ollama.context_window",
      HYDRA_CONFIG_DEFAULTS.ollamaContextWindow,
      { allowZero: true },
    ),
    lmStudioBaseUrl: optionalString(
      lmstudio.base_url,
      "providers.lmstudio.base_url",
      HYDRA_CONFIG_DEFAULTS.lmStudioBaseUrl,
    ),
    lmStudioContextWindow: optionalInteger(
      lmstudio.context_window,
      "providers.lmstudio.context_window",
      HYDRA_CONFIG_DEFAULTS.lmStudioContextWindow,
      { allowZero: true },
    ),
    appTools: mode,
    appToolServers: stringArray(appTools.servers, "app_tools.servers", HYDRA_CONFIG_DEFAULTS.appToolServers),
    webSearchCommands: resolveCommands(rawCommands, configPath),
  };
}

function quote(value) {
  return JSON.stringify(String(value));
}

function defaultConfigText() {
  return `[hydra]
port = ${HYDRA_CONFIG_DEFAULTS.port}
debug = ${HYDRA_CONFIG_DEFAULTS.debug}
menubar = ${HYDRA_CONFIG_DEFAULTS.menubar}
data_dir = "."

[codex]
home = ${quote(HYDRA_CONFIG_DEFAULTS.codexHome)}
binary = ${quote(HYDRA_CONFIG_DEFAULTS.codexBin)}

[providers.openai]
base_url = ${quote(HYDRA_CONFIG_DEFAULTS.openaiBaseUrl)}

[providers.ollama]
base_url = ${quote(HYDRA_CONFIG_DEFAULTS.ollamaBaseUrl)}

[providers.lmstudio]
base_url = ${quote(HYDRA_CONFIG_DEFAULTS.lmStudioBaseUrl)}

[app_tools]
mode = ${quote(HYDRA_CONFIG_DEFAULTS.appTools)}
servers = ${JSON.stringify(HYDRA_CONFIG_DEFAULTS.appToolServers)}

[tools]
web_search_commands = ${JSON.stringify(HYDRA_CONFIG_DEFAULTS.webSearchCommands)}
`;
}

export async function ensureHydraConfig(configPath) {
  try {
    await readFile(configPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, defaultConfigText(), { mode: 0o600 });
    return { created: true };
  }
  await chmod(configPath, 0o600);
  return { created: false };
}

export async function loadHydraSettings(configPath) {
  return parseHydraSettings(await readFile(configPath, "utf8"), { configPath });
}
