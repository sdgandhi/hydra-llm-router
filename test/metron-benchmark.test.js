import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { evaluateTask, summarizeResults, validateBenchmarkConfig } from "../benchmark/run.js";
import { materializeHydraConfig } from "../benchmark/hydra.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const config = {
  schema_version: 1,
  routes: [{ slug: "one" }, { slug: "two" }],
  tasks: "tasks.json",
  expected_task_count: 50,
  repetitions: 1,
  concurrency: 1,
  timeout_ms: 1000,
  machine_hour_usd: 0,
  executor: { codex_bin: "codex", codex_home: "home", hydra_url: "http://127.0.0.1:3857", catalog_path: "catalog" }
};

test("validates selectable benchmark configuration", () => {
  assert.equal(validateBenchmarkConfig(config), config);
  assert.throws(() => validateBenchmarkConfig({ ...config, concurrency: 2 }), /concurrency = 1/);
  assert.throws(() => validateBenchmarkConfig({ ...config, routes: [] }), /routes/);
});

test("committed v1 corpus contains ten tasks in each requested category", async () => {
  const tasks = JSON.parse(await readFile(new URL("../benchmark/tasks/v1.json", import.meta.url), "utf8"));
  assert.equal(tasks.length, 50);
  for (const category of ["simple-coding", "repository-navigation", "editing", "tool-use", "ambiguous-reasoning"]) {
    assert.equal(tasks.filter((task) => task.category === category).length, 10);
  }
});

test("evaluates deterministic results without receiving a route identity", async () => {
  assert.equal((await evaluateTask({ evaluation: { type: "exact", expected: "42" } }, "42\n", "/tmp")).success, true);
  assert.equal((await evaluateTask({ evaluation: { type: "contains_all", values: ["alpha", "beta"] } }, "Beta then ALPHA", "/tmp")).success, true);
});

test("summarizes one result set per configured route", () => {
  const summary = summarizeResults([
    { route: "one", duration_ms: 10, process: { timed_out: false }, evaluation: { success: true } },
    { route: "two", duration_ms: 20, process: { timed_out: true }, evaluation: { success: false } }
  ], config);
  assert.equal(summary.total_cases, 2);
  assert.equal(summary.routes.one.success_rate, 1);
  assert.equal(summary.routes.two.success_rate, 0);
});

test("materializes the committed Hydra template outside the source tree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "metron-hydra-config-"));
  try {
    const target = path.join(root, "config.toml");
    await materializeHydraConfig({ runtimeConfig: target });
    const text = await readFile(target, "utf8");
    assert.doesNotMatch(text, /__REPO_ROOT__/);
    assert.match(text, /port = 3857/);
    assert.match(text, /machine_hour_usd = 0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
