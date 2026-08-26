import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureHydraConfig, loadHydraSettings, parseHydraSettings } from "../src/hydra-config.js";

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

test("creates a complete default config once", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hydra-config-default-"));
  const configPath = path.join(root, "config.toml");
  try {
    const result = await ensureHydraConfig(configPath);
    const config = await loadHydraSettings(configPath);
    const original = await readFile(configPath, "utf8");
    const second = await ensureHydraConfig(configPath);

    assert.equal(result.created, true);
    assert.equal(second.created, false);
    assert.equal(config.port, 3847);
    assert.equal(config.openaiBaseUrl, "https://chatgpt.com/backend-api/codex");
    assert.equal(config.ollamaBaseUrl, "http://127.0.0.1:11434");
    assert.equal(config.lmStudioBaseUrl, "http://127.0.0.1:11239");
    assert.equal(config.appTools, "auto");
    assert.deepEqual(config.appToolServers, ["codex_apps"]);
    assert.deepEqual(config.webSearchCommands.slice(1), [["ddgr"], ["search"], ["duckduckgo"]]);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.equal(await readFile(configPath, "utf8"), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not add missing sections to an existing config", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hydra-config-existing-"));
  const configPath = path.join(root, "config.toml");
  const existing = "[hydra]\nport = 4555\n";
  try {
    await writeFile(configPath, existing);
    assert.deepEqual(await ensureHydraConfig(configPath), { created: false });
    assert.equal(await readFile(configPath, "utf8"), existing);
    assert.equal((await loadHydraSettings(configPath)).port, 4555);
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
