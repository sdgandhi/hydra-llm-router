import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
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

function envBoolean(value, fallback) {
  if (value == null || value === "") return fallback;
  return !new Set(["0", "false", "off", "no"]).has(String(value).toLowerCase());
}

function envInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function legacyValues({ legacy = {}, env = {} } = {}) {
  return {
    port: Number(legacy.port ?? env.HYDRA_PORT) || HYDRA_CONFIG_DEFAULTS.port,
    debug: envBoolean(env.HYDRA_DEBUG ?? env.HYDRA_DEBUG_AUTH, HYDRA_CONFIG_DEFAULTS.debug),
    menubar: HYDRA_CONFIG_DEFAULTS.menubar,
    codexHome: HYDRA_CONFIG_DEFAULTS.codexHome,
    codexBin: legacy.codexBin ?? env.HYDRA_CODEX_BIN ?? HYDRA_CONFIG_DEFAULTS.codexBin,
    openaiBaseUrl:
      legacy.openaiBaseUrl ?? env.HYDRA_OPENAI_BASE_URL ?? HYDRA_CONFIG_DEFAULTS.openaiBaseUrl,
    openaiApiKey: env.OPENAI_API_KEY || null,
    ollamaBaseUrl: legacy.ollamaBaseUrl ?? env.OLLAMA_BASE_URL ?? HYDRA_CONFIG_DEFAULTS.ollamaBaseUrl,
    ollamaContextWindow: envInteger(env.HYDRA_OLLAMA_CONTEXT_WINDOW),
    lmStudioBaseUrl:
      legacy.lmStudioBaseUrl ?? env.LMSTUDIO_BASE_URL ?? HYDRA_CONFIG_DEFAULTS.lmStudioBaseUrl,
    lmStudioContextWindow: envInteger(env.HYDRA_LMSTUDIO_CONTEXT_WINDOW),
    appTools: legacy.appTools ?? env.HYDRA_APP_TOOLS ?? HYDRA_CONFIG_DEFAULTS.appTools,
    appToolServers:
      legacy.appToolServers ??
      String(env.HYDRA_APP_TOOL_SERVERS ?? HYDRA_CONFIG_DEFAULTS.appToolServers.join(","))
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    webSearchCommands: env.HYDRA_WEB_SEARCH_COMMAND
      ? [String(env.HYDRA_WEB_SEARCH_COMMAND).split(/\s+/).filter(Boolean)]
      : HYDRA_CONFIG_DEFAULTS.webSearchCommands,
  };
}

function quote(value) {
  return JSON.stringify(String(value));
}

function settingsSections(parsed, values) {
  const sections = [];
  if (!parsed.hydra) {
    sections.push(`[hydra]\nport = ${values.port}\ndebug = ${values.debug}\nmenubar = ${values.menubar}\ndata_dir = "."`);
  }
  if (!parsed.codex) sections.push(`[codex]\nhome = ${quote(values.codexHome)}\nbinary = ${quote(values.codexBin)}`);
  if (!parsed.providers?.openai) {
    const apiKey = values.openaiApiKey ? `\napi_key = ${quote(values.openaiApiKey)}` : "";
    sections.push(`[providers.openai]\nbase_url = ${quote(values.openaiBaseUrl)}${apiKey}`);
  }
  if (!parsed.providers?.ollama) {
    const context = values.ollamaContextWindow ? `\ncontext_window = ${values.ollamaContextWindow}` : "";
    sections.push(`[providers.ollama]\nbase_url = ${quote(values.ollamaBaseUrl)}${context}`);
  }
  if (!parsed.providers?.lmstudio) {
    const context = values.lmStudioContextWindow ? `\ncontext_window = ${values.lmStudioContextWindow}` : "";
    sections.push(`[providers.lmstudio]\nbase_url = ${quote(values.lmStudioBaseUrl)}${context}`);
  }
  if (!parsed.app_tools) {
    sections.push(`[app_tools]\nmode = ${quote(values.appTools)}\nservers = ${JSON.stringify(values.appToolServers)}`);
  }
  if (!parsed.tools) {
    sections.push(`[tools]\nweb_search_commands = ${JSON.stringify(values.webSearchCommands)}`);
  }
  return sections;
}

export async function ensureHydraSettings(
  configPath,
  { legacySettingsPath = null, env = process.env } = {},
) {
  let text = "";
  let created = false;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    created = true;
  }
  let parsed = {};
  if (text.trim()) {
    try {
      parsed = parse(text);
    } catch (error) {
      throw new Error(`Invalid Hydra TOML at ${configPath}: ${error.message}`);
    }
  }
  let legacy = {};
  if (legacySettingsPath) {
    try {
      legacy = JSON.parse(await readFile(legacySettingsPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const sections = settingsSections(parsed, legacyValues({ legacy, env }));
  if (sections.length) {
    await mkdir(path.dirname(configPath), { recursive: true });
    const prefix = sections.join("\n\n");
    const suffix = text.trim() ? `\n\n${text.trim()}\n` : "\n";
    await writeFile(configPath, `${prefix}${suffix}`, { mode: 0o600 });
  }
  await chmod(configPath, 0o600);
  if (legacySettingsPath) {
    try {
      await unlink(legacySettingsPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return { created, migratedSections: sections.length };
}

export async function loadHydraSettings(configPath) {
  return parseHydraSettings(await readFile(configPath, "utf8"), { configPath });
}
