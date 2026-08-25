import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ensureSyntheticDefaults,
  normalizeSyntheticSlug,
  parseSyntheticConfig,
} from "../src/synthetic-config.js";

test("normalizes synthetic slugs under the Hydra namespace", () => {
  assert.equal(normalizeSyntheticSlug("money-saver"), "hydra/money-saver");
  assert.equal(normalizeSyntheticSlug("hydra/money-saver"), "hydra/money-saver");
  assert.throws(() => normalizeSyntheticSlug("ollama/model"), /Invalid synthetic model slug/);
});

test("loads validated synthetic definitions and treats fallback as an implicit candidate", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hydra-synthetic-config-"));
  const selectorPath = path.join(dir, "selector.js");
  await writeFile(selectorPath, 'export default () => "gpt-test";\n');
  const result = await parseSyntheticConfig(
    `[synthetic_models.smart]
selector = "selector.js"
candidates = ["ollama/tiny"]
fallback_model = "gpt-test"
routing_scope = "conversation"
sticky_tool_continuations = false
selector_timeout_ms = 20
retry_count = 3
retry_delay_ms = 50
`,
    { configPath: path.join(dir, "config.toml") },
  );

  assert.equal(result.definitions.length, 1);
  assert.deepEqual(result.definitions[0].effectiveCandidates, ["ollama/tiny", "gpt-test"]);
  assert.equal(result.definitions[0].slug, "hydra/smart");
  assert.equal(result.definitions[0].routingScope, "conversation");
  assert.equal(result.definitions[0].selectorTimeoutMs, 20);
  assert.match(result.definitions[0].selectorHash, /^[a-f0-9]{64}$/);
});

test("omits definitions whose selector module is missing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hydra-synthetic-missing-"));
  const result = await parseSyntheticConfig(
    `[synthetic_models.missing]
selector = "missing.js"
candidates = ["ollama/tiny"]
fallback_model = "gpt-test"
routing_scope = "user_turn"
sticky_tool_continuations = true
`,
    { configPath: path.join(dir, "config.toml") },
  );
  assert.deepEqual(result.definitions, []);
  assert.equal(result.omitted[0].slug, "hydra/missing");
});

test("rejects nesting and invalid definition fields", async () => {
  const configPath = path.join(tmpdir(), "hydra-invalid.toml");
  await assert.rejects(
    parseSyntheticConfig(
      `[synthetic_models.bad]
selector = "bad.js"
candidates = ["hydra/other"]
fallback_model = "gpt-test"
routing_scope = "user_turn"
sticky_tool_continuations = true
`,
      { configPath },
    ),
    /cannot reference a synthetic model/,
  );
});

test("installs Money Saver config and selector without overwriting them", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hydra-synthetic-install-"));
  const paths = {
    hydraConfigPath: path.join(root, "config.toml"),
    selectorsDir: path.join(root, "selectors"),
    moneySaverSelectorPath: path.join(root, "selectors", "money-saver.js"),
  };
  const first = await ensureSyntheticDefaults(paths);
  assert.deepEqual(first, { created: true, addedMoneySaver: true });
  assert.match(await readFile(paths.hydraConfigPath, "utf8"), /\[synthetic_models\.money-saver\]/);
  const selector = await readFile(paths.moneySaverSelectorPath, "utf8");
  assert.match(selector, /lmstudio\/liquid\/lfm2\.5-1\.2b/);

  const second = await ensureSyntheticDefaults(paths);
  assert.deepEqual(second, { created: false, addedMoneySaver: false });
  assert.equal(await readFile(paths.moneySaverSelectorPath, "utf8"), selector);
});
