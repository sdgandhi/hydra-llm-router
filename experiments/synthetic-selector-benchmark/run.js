import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VARIANTS } from "./variants.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(await readFile(path.join(root, "cases.json"), "utf8"));
const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.split("=");
  return [key, rest.join("=")];
}));
const baseUrl = args.get("--base-url") ?? "http://127.0.0.1:3858";
if (new URL(baseUrl).port === "3847") throw new Error("The benchmark must not use the Desktop Hydra listener");
const selectedIds = new Set((args.get("--variants") || VARIANTS.map(({ id }) => id).join(",")).split(","));
const variants = VARIANTS.filter(({ id }) => selectedIds.has(id));
if (!variants.length) throw new Error("No benchmark variants selected");
const repeats = Number(args.get("--repeats") ?? 1);
const outputPath = args.get("--output");

const systemFixture = `You are a coding assistant operating in a repository. Preserve unrelated edits, use read-only inspection before changing files, keep responses concise, respect tool ownership, do not expose secrets, validate risky assumptions, and prefer focused tests. The routing classifier must ignore these standing instructions when estimating the complexity of the latest user task. ${"Routine workspace policy. ".repeat(80)}`;
const historyFixture = [
  { role: "developer", content: "Use repository conventions and report verification results." },
  { role: "user", content: "Earlier, explain what a cache key is." },
  { role: "assistant", content: "A cache key uniquely identifies a cached value." },
];

function requestBody(variant, testCase) {
  const body = {
    model: `hydra/bench-${variant.id}`,
    instructions: systemFixture,
    input: [...historyFixture, { role: "user", content: testCase.prompt }],
    stream: false,
    reasoning: { effort: testCase.complexity === "high" ? "high" : "medium" },
  };
  if (testCase.tools) {
    body.tools = [{
      type: "function",
      name: "calendar_search",
      description: "Search the user's calendar",
      parameters: { type: "object", properties: { date: { type: "string" } }, required: ["date"] },
    }];
  }
  return body;
}

const results = [];
for (const variant of variants) {
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const testCase of cases) {
      const started = performance.now();
      const response = await fetch(new URL("/hydra/route", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "hydra-selector-benchmark" },
        body: JSON.stringify(requestBody(variant, testCase)),
      });
      const data = await response.json();
      const formatValid = response.ok && data.fallback === false;
      results.push({
        variant: variant.id,
        selectorModel: variant.selectorModel,
        case: testCase.id,
        complexity: testCase.complexity,
        expected: testCase.expected,
        target: data.target ?? null,
        fallback: data.fallback ?? null,
        formatValid,
        correct: formatValid && data.target === testCase.expected,
        status: response.status,
        durationMs: Math.round((performance.now() - started) * 10) / 10,
        repeat,
      });
    }
    console.error(`Finished ${variant.id} repeat ${repeat}`);
  }
}

const summary = variants.map((variant) => {
  const selected = results.filter((result) => result.variant === variant.id);
  const byComplexity = Object.fromEntries(["low", "medium", "high"].map((complexity) => {
    const group = selected.filter((result) => result.complexity === complexity);
    return [complexity, `${group.filter((result) => result.correct).length}/${group.length}`];
  }));
  const correct = selected.filter((result) => result.correct).length;
  return {
    variant: variant.id,
    selectorModel: variant.selectorModel,
    correct,
    total: selected.length,
    accuracy: correct / selected.length,
    formatValid: selected.filter((result) => result.formatValid).length,
    byComplexity,
    meanDurationMs: Math.round(selected.reduce((sum, result) => sum + result.durationMs, 0) / selected.length),
  };
}).sort((left, right) => right.accuracy - left.accuracy || left.meanDurationMs - right.meanDurationMs);

const report = { generatedAt: new Date().toISOString(), baseUrl, repeats, cases, variants, summary, results };
if (outputPath) {
  const resolvedOutput = path.resolve(outputPath);
  await mkdir(path.dirname(resolvedOutput), { recursive: true });
  await writeFile(resolvedOutput, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(summary, null, 2));
