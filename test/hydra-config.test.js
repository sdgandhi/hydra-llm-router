import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureHydraSettings, loadHydraSettings, parseHydraSettings } from "../src/hydra-config.js";

test("parses the unified TOML schema and resolves relative paths", () => {
  const configPath = "/tmp/hydra-profile/config.toml";
  const config = parseHydraSettings(
    `[hydra]
port = 4455
debug = true
menubar = false
data_dir = "./state"

[codex]
home = "./codex-home"
binary = "./bin/codex"

[providers.openai]
base_url = "https://api.openai.com/v1"
api_key = "secret"

[providers.ollama]
base_url = "http://ollama.test"
context_window = 8192

[providers.lmstudio]
base_url = "http://lmstudio.test"
context_window = 16384

[app_tools]
mode = "off"
servers = ["one", "two"]

[tools]
web_search_commands = [["./bin/search", "--json"], ["search"]]
`,
    { configPath },
  );

  assert.equal(config.port, 4455);
  assert.equal(config.debug, true);
  assert.equal(config.menubar, false);
  assert.equal(config.dataDir, "/tmp/hydra-profile/state");
  assert.equal(config.codexHome, "/tmp/hydra-profile/codex-home");
  assert.equal(config.codexBin, "/tmp/hydra-profile/bin/codex");
  assert.equal(config.openaiBaseUrl, "https://api.openai.com/v1");
  assert.equal(config.openaiApiKey, "secret");
  assert.equal(config.ollamaContextWindow, 8192);
  assert.equal(config.lmStudioContextWindow, 16384);
  assert.equal(config.appTools, "off");
  assert.deepEqual(config.appToolServers, ["one", "two"]);
  assert.deepEqual(config.webSearchCommands, [
    ["/tmp/hydra-profile/bin/search", "--json"],
    ["search"],
  ]);
});

test("migrates legacy settings and environment configuration into config.toml once", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hydra-config-migration-"));
  const configPath = path.join(root, "config.toml");
  const legacySettingsPath = path.join(root, "settings.json");
  try {
    await mkdir(path.join(root, "selectors"));
    await writeFile(
      configPath,
      `[synthetic_models.test]
display_name = "Test"
description = "Test"
selector = "selectors/test.js"
candidates = ["gpt-test"]
fallback_model = "gpt-test"
routing_scope = "user_turn"
sticky_tool_continuations = true
selector_timeout_ms = 0
retry_count = 0
retry_delay_ms = 0
`,
    );
    await writeFile(
      legacySettingsPath,
      JSON.stringify({
        port: 4555,
        ollamaBaseUrl: "http://legacy-ollama",
        lmStudioBaseUrl: "http://legacy-lmstudio",
        appTools: "off",
        appToolServers: ["legacy_apps"],
        codexBin: "/legacy/codex",
      }),
    );

    const result = await ensureHydraSettings(configPath, {
      legacySettingsPath,
      env: {
        HYDRA_OPENAI_BASE_URL: "https://api.openai.com/v1",
        OPENAI_API_KEY: "migrated-secret",
        HYDRA_OLLAMA_CONTEXT_WINDOW: "8192",
        HYDRA_LMSTUDIO_CONTEXT_WINDOW: "16384",
        HYDRA_WEB_SEARCH_COMMAND: "search --json",
      },
    });
    const config = await loadHydraSettings(configPath);

    assert.equal(result.created, false);
    assert.equal(config.port, 4555);
    assert.equal(config.openaiBaseUrl, "https://api.openai.com/v1");
    assert.equal(config.openaiApiKey, "migrated-secret");
    assert.equal(config.ollamaBaseUrl, "http://legacy-ollama");
    assert.equal(config.lmStudioBaseUrl, "http://legacy-lmstudio");
    assert.equal(config.ollamaContextWindow, 8192);
    assert.equal(config.lmStudioContextWindow, 16384);
    assert.equal(config.appTools, "off");
    assert.deepEqual(config.appToolServers, ["legacy_apps"]);
    assert.deepEqual(config.webSearchCommands, [["search", "--json"]]);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    await assert.rejects(readFile(legacySettingsPath), (error) => error.code === "ENOENT");
    assert.match(await readFile(configPath, "utf8"), /\[synthetic_models\.test\]/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects unknown settings instead of silently ignoring them", () => {
  assert.throws(
    () => parseHydraSettings("[hydra]\nporrt = 3847\n", { configPath: "/tmp/config.toml" }),
    /Unknown Hydra config key: hydra\.porrt/,
  );
});
