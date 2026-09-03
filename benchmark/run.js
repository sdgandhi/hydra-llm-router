#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const BENCHMARK_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(BENCHMARK_ROOT);

function expandHome(value) {
  if (value === "~") return process.env.HOME;
  if (value?.startsWith("~/")) return path.join(process.env.HOME, value.slice(2));
  return value;
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value;
}

export function validateBenchmarkConfig(config) {
  if (config?.schema_version !== 1) throw new Error("benchmark config schema_version must be 1");
  if (!Array.isArray(config.routes) || !config.routes.length) throw new Error("benchmark config routes must be non-empty");
  for (const [index, route] of config.routes.entries()) requiredString(route?.slug, `routes[${index}].slug`);
  requiredString(config.tasks, "tasks");
  requiredString(config.executor?.codex_bin, "executor.codex_bin");
  requiredString(config.executor?.codex_home, "executor.codex_home");
  requiredString(config.executor?.hydra_url, "executor.hydra_url");
  requiredString(config.executor?.catalog_path, "executor.catalog_path");
  if (!Number.isInteger(config.repetitions) || config.repetitions < 1) throw new Error("repetitions must be a positive integer");
  if (!Number.isInteger(config.timeout_ms) || config.timeout_ms < 1) throw new Error("timeout_ms must be a positive integer");
  if (config.concurrency !== 1) throw new Error("v1 benchmark requires concurrency = 1 for comparable runs");
  return config;
}

function normalizedText(value) {
  return String(value ?? "").trim().replace(/^```[^\n]*\n?|\n?```$/g, "").trim();
}

export async function evaluateTask(task, output, workspace) {
  const evaluation = task.evaluation;
  if (evaluation.type === "exact") {
    const actual = normalizedText(output);
    return { success: actual === evaluation.expected, method: "exact", expected: evaluation.expected, actual };
  }
  if (evaluation.type === "contains_all") {
    const actual = normalizedText(output).toLowerCase();
    const missing = evaluation.values.filter((value) => !actual.includes(value.toLowerCase()));
    return { success: missing.length === 0, method: "contains_all", missing };
  }
  if (evaluation.type === "regex") {
    const success = new RegExp(evaluation.pattern, evaluation.flags ?? "").test(normalizedText(output));
    return { success, method: "regex", pattern: evaluation.pattern };
  }
  if (evaluation.type === "file_equals") {
    let actual = null;
    try {
      actual = await readFile(path.join(workspace, evaluation.path), "utf8");
    } catch {
      // Missing output files are an ordinary benchmark failure.
    }
    return { success: actual === evaluation.expected, method: "file_equals", path: evaluation.path, actual };
  }
  throw new Error(`Unsupported evaluation type: ${evaluation.type}`);
}

async function nextRunId(runsDir, clock) {
  const date = clock().toISOString().slice(0, 10);
  let entries = [];
  try {
    entries = await readdir(runsDir);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const versions = entries
    .map((name) => name.match(new RegExp(`^${date}-v(\\d+)$`)))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  return `${date}-v${Math.max(0, ...versions) + 1}`;
}

async function writeWorkspaceFiles(workspace, files = {}) {
  for (const [name, contents] of Object.entries(files)) {
    if (path.isAbsolute(name) || name.split(/[\\/]/).includes("..")) throw new Error(`Unsafe fixture path: ${name}`);
    const target = path.join(workspace, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

function runProcess(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr, timedOut, error: error.message });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, error: null });
    });
  });
}

function parseCodexEvents(text) {
  const events = [];
  let output = "";
  let usage = null;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      events.push(event);
      if (event.type === "item.completed" && event.item?.type === "agent_message") output = event.item.text ?? output;
      if (event.type === "turn.completed" && event.usage) usage = event.usage;
    } catch {
      // Non-JSON diagnostics stay in stderr/stdout metadata, not normalized event records.
    }
  }
  return { events, output, usage };
}

function codexArgs(config, route, task, workspace) {
  const executor = config.executor;
  return [
    "exec",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox",
    task.sandbox ?? "read-only",
    "-C",
    workspace,
    "-c",
    'approval_policy="never"',
    "-c",
    `model_catalog_json=${JSON.stringify(expandHome(executor.catalog_path))}`,
    "-c",
    `openai_base_url=${JSON.stringify(executor.hydra_url)}`,
    "-m",
    route.slug,
    "-c",
    `model_reasoning_effort=${JSON.stringify(route.reasoning ?? executor.reasoning ?? "low")}`,
    "--json",
    task.prompt,
  ];
}

async function runCase({ config, route, task, repetition, runId, artifactsDir }) {
  const workspace = await mkdtemp(path.join(tmpdir(), `metron-${task.id}-`));
  await writeWorkspaceFiles(workspace, task.files);
  const startedAt = new Date();
  const result = await runProcess(
    path.resolve(REPO_ROOT, config.executor.codex_bin),
    codexArgs(config, route, task, workspace),
    {
      cwd: workspace,
      timeoutMs: config.timeout_ms,
      env: {
        ...process.env,
        CODEX_HOME: expandHome(config.executor.codex_home),
        CODEX_SQLITE_HOME: path.join(expandHome(config.executor.codex_home), "sqlite"),
      },
    },
  );
  const completedAt = new Date();
  const parsed = parseCodexEvents(result.stdout);
  let evaluation;
  try {
    evaluation = await evaluateTask(task, parsed.output, workspace);
  } catch (error) {
    evaluation = { success: false, method: "evaluator_error", error: error.message };
  }

  for (const event of parsed.events) {
    await appendFile(path.join(artifactsDir, "events.jsonl"), `${JSON.stringify({
      run_id: runId,
      task_id: task.id,
      route: route.slug,
      repetition,
      event,
    })}\n`);
  }
  const record = {
    schema_version: 1,
    run_id: runId,
    task_id: task.id,
    category: task.category,
    route: route.slug,
    repetition,
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    duration_ms: completedAt.valueOf() - startedAt.valueOf(),
    process: {
      exit_code: result.code,
      signal: result.signal,
      timed_out: result.timedOut,
      error: result.error,
      stderr: result.stderr.slice(-4000),
    },
    prompt: task.prompt,
    output: parsed.output,
    usage: parsed.usage,
    evaluation,
  };
  await appendFile(path.join(artifactsDir, "results.jsonl"), `${JSON.stringify(record)}\n`);
  await rm(workspace, { recursive: true, force: true });
  return record;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function summarizeResults(results, config) {
  return {
    schema_version: 1,
    completed_at: new Date().toISOString(),
    total_cases: results.length,
    successful_cases: results.filter((result) => result.evaluation.success).length,
    timed_out_cases: results.filter((result) => result.process.timed_out).length,
    routes: Object.fromEntries(config.routes.map((route) => {
      const selected = results.filter((result) => result.route === route.slug);
      return [route.slug, {
        cases: selected.length,
        successful: selected.filter((result) => result.evaluation.success).length,
        success_rate: selected.length ? selected.filter((result) => result.evaluation.success).length / selected.length : null,
        mean_duration_ms: mean(selected.map((result) => result.duration_ms)),
      }];
    })),
  };
}

export async function runBenchmark(configPath, { clock = () => new Date(), logger = console } = {}) {
  const absoluteConfigPath = path.resolve(configPath);
  const configText = await readFile(absoluteConfigPath, "utf8");
  const config = validateBenchmarkConfig(JSON.parse(configText));
  const tasksPath = path.resolve(path.dirname(absoluteConfigPath), config.tasks);
  const tasks = JSON.parse(await readFile(tasksPath, "utf8"));
  if (!Array.isArray(tasks) || tasks.length !== config.expected_task_count) {
    throw new Error(`Expected ${config.expected_task_count} tasks, found ${Array.isArray(tasks) ? tasks.length : "invalid data"}`);
  }
  const runsDir = path.resolve(REPO_ROOT, config.output_dir ?? "benchmark/runs");
  await mkdir(runsDir, { recursive: true });
  const runId = await nextRunId(runsDir, clock);
  const partialDir = path.join(runsDir, `.${runId}.in-progress`);
  const artifactsDir = path.join(runsDir, runId);
  await mkdir(partialDir, { recursive: false });
  await writeFile(path.join(partialDir, "config.json"), `${JSON.stringify({ ...config, source: path.relative(REPO_ROOT, absoluteConfigPath) }, null, 2)}\n`);
  await writeFile(path.join(partialDir, "environment.json"), `${JSON.stringify({
    schema_version: 1,
    run_id: runId,
    started_at: clock().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    config_sha256: createHash("sha256").update(configText).digest("hex"),
    machine_hour_usd: config.machine_hour_usd,
  }, null, 2)}\n`);
  await writeFile(path.join(partialDir, "events.jsonl"), "");
  await writeFile(path.join(partialDir, "results.jsonl"), "");

  const results = [];
  const total = config.routes.length * tasks.length * config.repetitions;
  for (const route of config.routes) {
    for (const task of tasks) {
      for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
        logger.log(`[${results.length + 1}/${total}] ${route.slug} · ${task.id}`);
        results.push(await runCase({ config, route, task, repetition, runId, artifactsDir: partialDir }));
      }
    }
  }
  const summary = summarizeResults(results, config);
  await writeFile(path.join(partialDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  await rename(partialDir, artifactsDir);
  logger.log(`Benchmark complete: ${artifactsDir}`);
  return { runId, artifactsDir, summary };
}

function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--config") throw new Error("Usage: node benchmark/run.js --config <path>");
  return argv[1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runBenchmark(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
