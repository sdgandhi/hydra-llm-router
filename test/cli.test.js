import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildConfig,
  codexConfigArgs,
  parseArgs,
  parseCodexJsonEvent,
  runRouteCommand,
  shutdownHydra,
} from "../src/cli.js";
import { handleHelperLine, menuBarStatusItems, menuModelOptions } from "../src/menubar.js";

test("parses --no-menubar as a serve flag", () => {
  assert.deepEqual(parseArgs(["serve", "--no-menubar"]), {
    command: "serve",
    options: { no_menubar: true },
  });
});

test("parses app tool bridge flags", async () => {
  assert.deepEqual(parseArgs(["serve", "--app-tools", "off", "--app-tool-servers", "codex_apps,node_repl"]), {
    command: "serve",
    options: { app_tools: "off", app_tool_servers: "codex_apps,node_repl" },
  });
  const root = await mkdtemp(path.join(tmpdir(), "hydra-cli-config-"));
  try {
    const config = await buildConfig({
      config: path.join(root, "config.toml"),
      app_tool_servers: "codex_apps,node_repl",
      codex_bin: "/tmp/codex",
    });
    assert.equal(config.codexBin, "/tmp/codex");
    assert.deepEqual(config.appToolServers, ["codex_apps", "node_repl"]);
    assert.equal(config.lmStudioBaseUrl, "http://127.0.0.1:1234");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parses an explicit config path for any subcommand", () => {
  assert.deepEqual(parseArgs(["status", "--config", "/tmp/hydra.toml"]), {
    command: "status",
    options: { config: "/tmp/hydra.toml" },
  });
});

test("uses CLI overrides before TOML", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hydra-cli-precedence-"));
  const configPath = path.join(root, "config.toml");
  try {
    await writeFile(
      configPath,
      `[hydra]
port = 4555
debug = false
menubar = false
data_dir = "."

[codex]
home = "./codex"
binary = "codex"

[providers.openai]
base_url = "https://config.example/v1"

[providers.ollama]
base_url = "http://config-ollama"

[providers.lmstudio]
base_url = "http://config-lmstudio"

[app_tools]
mode = "off"
servers = ["codex_apps"]

[tools]
web_search_commands = [["search"]]
`,
    );
    const config = await buildConfig({
      config: configPath,
      port: "4666",
      ollama_url: "http://flag-ollama",
    });

    assert.equal(config.port, 4666);
    assert.equal(config.ollamaBaseUrl, "http://flag-ollama");
    assert.equal(config.openaiBaseUrl, "https://config.example/v1");
    assert.equal(config.lmStudioBaseUrl, "http://config-lmstudio");
    assert.equal(config.noMenuBar, true);
    assert.equal(config.paths.hydraDir, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parses debug and repeatable prompt inputs", () => {
  assert.deepEqual(parseArgs(["session", "--model", "hydra/smart", "--input", "one", "--input", "two", "--debug"]), {
    command: "session",
    options: { model: "hydra/smart", input: ["one", "two"], debug: true },
  });
});

test("builds Codex CLI overrides that force requests through Hydra", () => {
  const args = codexConfigArgs(
    { port: 3847, paths: { catalogPath: "/tmp/hydra-models.json" } },
    { model: "hydra/money-saver", reasoning: "high", image: ["one.png"] },
  );
  assert.deepEqual(args, [
    "-c",
    'model_catalog_json="/tmp/hydra-models.json"',
    "-c",
    'openai_base_url="http://127.0.0.1:3847"',
    "-m",
    "hydra/money-saver",
    "-c",
    'model_reasoning_effort="high"',
    "-i",
    "one.png",
  ]);
});

test("route command invokes the running server and prints only its target", async () => {
  const logs = [];
  let request;
  const result = await runRouteCommand(
    { port: 3847 },
    { model: "hydra/money-saver", input: ["hello"], reasoning: "medium" },
    {
      fetchImpl: async (url, options) => {
        request = { url, body: JSON.parse(options.body) };
        return new Response(JSON.stringify({ target: "gpt-5.6-sol", fallback: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      logger: { log(value) { logs.push(value); } },
    },
  );
  assert.equal(request.url, "http://127.0.0.1:3847/hydra/route");
  assert.equal(request.body.model, "hydra/money-saver");
  assert.equal(request.body.input[0].content[0].text, "hello");
  assert.deepEqual(logs, ["gpt-5.6-sol"]);
  assert.equal(result.target, "gpt-5.6-sol");
});

test("renders Codex JSON session events and returns their thread id", () => {
  const chunks = [];
  const output = { write(chunk) { chunks.push(chunk); } };
  assert.equal(parseCodexJsonEvent({ type: "thread.started", thread_id: "thread-1" }, output), "thread-1");
  parseCodexJsonEvent({ type: "item.completed", item: { type: "agent_message", text: "hello" } }, output);
  assert.equal(chunks.join(""), "hello\n");
});

test("serve status items match the menubar dropdown content", () => {
  assert.deepEqual(
    menuBarStatusItems({
      version: "0.1.0",
      installed: false,
      port: 3847,
      openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
      ollamaBaseUrl: "http://127.0.0.1:11434",
      lmStudioBaseUrl: "http://127.0.0.1:11239",
      debugAuth: true,
      catalog: {
        models: [
          { slug: "gpt-5.5" },
          { slug: "ollama/llama3.2:latest" },
        ],
      },
      emulatedToolStatuses: [
        { name: "web_search", status: "unavailable", detail: "no executable search command found" },
        { name: "tool_search", status: "ready" },
      ],
      appToolStatus: {
        status: "ready",
        toolCount: 196,
        servers: ["codex_apps"],
      },
      paths: {
        logPath: "/tmp/hydra.log",
        codexConfigPath: "/tmp/config.toml",
      },
    }),
    [
      { kind: "info", title: "Hydra Running" },
      { kind: "info", title: "Version: 0.1.0" },
      { kind: "info", title: "Codex routing: not installed" },
      { kind: "action", id: "install", title: "Install Hydra in Codex" },
      { kind: "action", id: "restore", title: "Restore Codex Config" },
      { kind: "action", id: "refresh", title: "Refresh" },
      { kind: "action", id: "open_config", title: "Open Hydra Config" },
      { kind: "separator" },
      {
        kind: "submenu",
        title: "Models (2)",
        items: [
          { kind: "info", title: "gpt-5.5" },
          { kind: "info", title: "ollama/llama3.2:latest" },
        ],
      },
      {
        kind: "submenu",
        title: "Synthetic Models (0)",
        items: [
          { kind: "action", id: "new_synthetic", title: "New…" },
          { kind: "separator" },
          { kind: "info", title: "No synthetic models" },
        ],
      },
      { kind: "separator" },
      { kind: "info", title: "Router: http://127.0.0.1:3847" },
      { kind: "info", title: "Cloud: https://chatgpt.com/backend-api/codex" },
      { kind: "info", title: "Ollama: http://127.0.0.1:11434" },
      { kind: "info", title: "LM Studio: http://127.0.0.1:11239" },
      {
        kind: "info",
        title: "Emulated tools: web_search: unavailable (no executable search command found), tool_search: ready",
      },
      { kind: "info", title: "App tools: codex_apps: 196 ready" },
      { kind: "info", title: "Debug log: /tmp/hydra.log" },
      { kind: "info", title: "Codex config: /tmp/config.toml" },
    ],
  );
});

test("menubar shows synthetic config and last target", () => {
  const lastSelections = new Map([
    ["hydra/smart", { selected: "ollama/tiny", ultimate: "gpt-test" }],
  ]);
  const items = menuBarStatusItems({
    port: 3847,
    openaiBaseUrl: "cloud",
    ollamaBaseUrl: "ollama",
    lmStudioBaseUrl: "lmstudio",
    debugAuth: false,
    catalog: { models: [] },
    syntheticConfig: {
      definitions: [
        {
          slug: "hydra/smart",
          displayName: "Hydra: Smart",
          selector: "selectors/smart.js",
          selectorPath: "/tmp/hydra/selectors/smart.js",
          candidates: ["ollama/tiny"],
          fallbackModel: "gpt-test",
          routingScope: "user_turn",
          stickyToolContinuations: true,
          selectorTimeoutMs: 0,
          retryCount: 2,
          retryDelayMs: 1000,
        },
      ],
    },
    syntheticState: { lastSelections },
    paths: { logPath: "/tmp/log", codexConfigPath: "/tmp/codex", hydraConfigPath: "/tmp/hydra/config.toml" },
  });
  const synthetic = items.find((item) => item.title === "Synthetic Models (1)");
  assert.equal(synthetic.items[0].title, "New…");
  assert.equal(synthetic.items[2].title, "hydra/smart");
  assert.deepEqual(synthetic.items[2].items[1], {
    kind: "reveal",
    title: "Selector: selectors/smart.js",
    path: "/tmp/hydra/selectors/smart.js",
  });
  assert.equal(synthetic.items[2].items.at(-1).title, "Last: gpt-test");
});

test("menubar offers only direct models to the synthetic model form", () => {
  assert.deepEqual(menuModelOptions({
    models: [
      { slug: "hydra/money-saver", display_name: "Hydra: Money Saver" },
      { slug: "gpt-test", display_name: "GPT Test" },
      { slug: "ollama/tiny" },
    ],
  }), [
    { slug: "gpt-test", title: "GPT Test (gpt-test)" },
    { slug: "ollama/tiny", title: "ollama/tiny" },
  ]);
});

test("menubar dispatches install and restore actions", () => {
  const calls = [];
  const handlers = {
    onInstall: () => calls.push("install"),
    onRestore: () => calls.push("restore"),
  };
  handleHelperLine('{"type":"action","id":"install"}', handlers);
  handleHelperLine('{"type":"action","id":"restore"}', handlers);
  assert.deepEqual(calls, ["install", "restore"]);
});

test("menubar dispatches synthetic model creation payloads", () => {
  let received;
  handleHelperLine(
    '{"type":"create_synthetic","requestId":"request-1","model":{"name":"Smart"}}',
    { onCreateSynthetic: (model, requestId) => { received = { model, requestId }; } },
  );
  assert.deepEqual(received, { model: { name: "Smart" }, requestId: "request-1" });
});

test("menu quit restores config, closes the server, removes pid, and stops helper", async () => {
  const calls = [];
  const server = {
    close(callback) {
      calls.push("close");
      callback();
    },
  };
  const menuBar = {
    stop() {
      calls.push("menubar-stop");
    },
  };

  const result = await shutdownHydra({
    config: testConfig(),
    server,
    menuBar,
    signal: "menubar",
    restoreOnQuit: true,
    restoreImpl: async () => {
      calls.push("restore");
      return { backupPath: "/tmp/codex/hydra/config.backup.toml" };
    },
    removePidFileImpl: async () => {
      calls.push("remove-pid");
    },
    exitImpl: (code) => {
      calls.push(`exit:${code}`);
    },
    logger: quietLogger(),
  });

  assert.equal(result.restoreStatus, "restored");
  assert.deepEqual(calls, ["restore", "close", "remove-pid", "menubar-stop", "exit:0"]);
});

test("menu quit still stops Hydra when there is no config backup", async () => {
  const calls = [];
  const missingBackup = new Error("missing backup");
  missingBackup.code = "ENOENT";

  const result = await shutdownHydra({
    config: testConfig(),
    server: {
      close(callback) {
        calls.push("close");
        callback();
      },
    },
    menuBar: {
      stop() {
        calls.push("menubar-stop");
      },
    },
    signal: "menubar",
    restoreOnQuit: true,
    restoreImpl: async () => {
      calls.push("restore");
      throw missingBackup;
    },
    removePidFileImpl: async () => {
      calls.push("remove-pid");
    },
    exitImpl: (code) => {
      calls.push(`exit:${code}`);
    },
    logger: quietLogger(),
  });

  assert.equal(result.restoreStatus, "missing_backup");
  assert.deepEqual(calls, ["restore", "close", "remove-pid", "menubar-stop", "exit:0"]);
});

function testConfig() {
  return {
    debugAuth: false,
    paths: {
      backupPath: "/tmp/codex/hydra/config.backup.toml",
    },
  };
}

function quietLogger() {
  return {
    log() {},
    warn() {},
    error() {},
  };
}
