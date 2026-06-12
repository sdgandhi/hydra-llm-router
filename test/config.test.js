import test from "node:test";
import assert from "node:assert/strict";
import { hydraConfigPatch, insertHydraConfig, removeManagedHydraConfig } from "../src/config.js";

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
  assert.match(output, /model_provider = "hydra"/);
  assert.doesNotMatch(output, /model_catalog_json/);
  assert.doesNotMatch(output, /openai_base_url/);
  assert.doesNotMatch(output, /\[model_providers\.hydra\]/);
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
