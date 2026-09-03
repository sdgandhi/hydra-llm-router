import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  defaultPaths,
  hydraConfigPatch,
  insertHydraConfig,
  isHydraInstalled,
  removeManagedHydraConfig,
} from "../src/config.js";

test("stores default Hydra state independently of Codex home", () => {
  const paths = defaultPaths({ codexHome: "/tmp/custom-codex-home" });
  assert.equal(paths.codexHome, "/tmp/custom-codex-home");
  assert.equal(paths.hydraDir, path.join(homedir(), ".hydra"));
  assert.equal(paths.hydraConfigPath, path.join(homedir(), ".hydra", "config.toml"));
  assert.equal(paths.metronEventsDir, path.join(homedir(), ".hydra", "metron", "events"));
  assert.equal(paths.metronCursorsPath, path.join(homedir(), ".hydra", "metron", "cursors.json"));
});

test("removes managed hydra provider config without disturbing other sections", () => {
  const input = `model = "gpt-5.5"
model_provider = "hydra"
model_catalog_json = "/tmp/hydra.json"
openai_base_url = "http://127.0.0.1:3847"

[projects."/tmp/example"]
trust_level = "trusted"

[model_providers.hydra]
name = "Hydra"
base_url = "http://127.0.0.1:3847"
wire_api = "responses"

[features]
js_repl = false
`;

  const output = removeManagedHydraConfig(input);
  assert.match(output, /model = "gpt-5.5"/);
  assert.match(output, /\[projects\."\/tmp\/example"\]/);
  assert.match(output, /\[features\]/);
  assert.doesNotMatch(output, /model_provider = "hydra"/);
  assert.doesNotMatch(output, /model_catalog_json/);
  assert.doesNotMatch(output, /openai_base_url/);
  assert.doesNotMatch(output, /\[model_providers\.hydra\]/);
});

test("preserves non-hydra provider and table-scoped matching keys", () => {
  const input = `model_provider = "openai"

[projects."/tmp/example"]
model_provider = "hydra"
model_catalog_json = "/project/catalog.json"
openai_base_url = "http://project.example"
`;

  const output = removeManagedHydraConfig(input);
  assert.match(output, /model_provider = "openai"/);
  assert.match(output, /\[projects\."\/tmp\/example"\]/);
  assert.match(output, /model_provider = "hydra"/);
  assert.match(output, /model_catalog_json = "\/project\/catalog\.json"/);
  assert.match(output, /openai_base_url = "http:\/\/project\.example"/);
});

test("emits the single provider desktop config patch", () => {
  const patch = hydraConfigPatch({
    port: 3847,
    paths: { catalogPath: "/tmp/hydra-models.json" },
  });
  assert.match(patch, /model_catalog_json = "\/tmp\/hydra-models\.json"/);
  assert.match(patch, /openai_base_url = "http:\/\/127\.0\.0\.1:3847"/);
  assert.doesNotMatch(patch, /model_provider/);
  assert.doesNotMatch(patch, /\[model_providers\.hydra\]/);
});

test("inserts top-level hydra config before the first TOML table", () => {
  const output = insertHydraConfig(
    `model = "gpt-5.5"

[projects."/tmp/example"]
trust_level = "trusted"
`,
    { port: 3847, paths: { catalogPath: "/tmp/hydra-models.json" } },
  );
  const catalogIndex = output.indexOf('model_catalog_json = "/tmp/hydra-models.json"');
  const firstTableIndex = output.indexOf('[projects."/tmp/example"]');
  assert.ok(catalogIndex > 0);
  assert.ok(catalogIndex < firstTableIndex);
  assert.doesNotMatch(output, /\[model_providers\.hydra\]/);
});

test("detects whether Codex is routed through this Hydra instance", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hydra-config-test-"));
  const codexConfigPath = path.join(dir, "config.toml");
  const config = {
    port: 3847,
    paths: {
      codexConfigPath,
      catalogPath: path.join(dir, "hydra-models.json"),
    },
  };
  try {
    await writeFile(codexConfigPath, insertHydraConfig('model = "gpt-5.5"\n', config));
    assert.equal(await isHydraInstalled(config), true);
    await writeFile(codexConfigPath, 'model = "gpt-5.5"\n');
    assert.equal(await isHydraInstalled(config), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
