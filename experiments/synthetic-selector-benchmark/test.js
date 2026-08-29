import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATION_MODELS, VARIANTS, variantBySyntheticSlug } from "./variants.js";

const root = path.dirname(fileURLToPath(import.meta.url));

test("benchmark has ten distinct cases at each complexity", async () => {
  const cases = JSON.parse(await readFile(path.join(root, "cases.json"), "utf8"));
  assert.equal(cases.length, 30);
  for (const complexity of ["low", "medium", "high"]) {
    const selected = cases.filter((entry) => entry.complexity === complexity);
    assert.equal(selected.length, 10);
    assert.ok(selected.every((entry) => entry.expected === GENERATION_MODELS[complexity]));
  }
  assert.equal(new Set(cases.map(({ id }) => id)).size, cases.length);
});

test("variant slugs round-trip and cover both selector models", () => {
  assert.ok(VARIANTS.some(({ selectorModel }) => selectorModel.includes("liquid/")));
  assert.ok(VARIANTS.some(({ selectorModel }) => selectorModel.includes("gemma-4-26b")));
  for (const variant of VARIANTS) {
    assert.equal(variantBySyntheticSlug(`hydra/bench-${variant.id}`), variant);
  }
});
