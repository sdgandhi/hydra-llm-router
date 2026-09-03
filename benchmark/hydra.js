#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const BENCHMARK_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(BENCHMARK_ROOT);
const RUNTIME_DIR = "/tmp/metron-benchmark-hydra";
const RUNTIME_CONFIG = path.join(RUNTIME_DIR, "config.toml");

export async function materializeHydraConfig({ runtimeConfig = RUNTIME_CONFIG } = {}) {
  const source = await readFile(path.join(BENCHMARK_ROOT, "configs", "hydra-v1.toml"), "utf8");
  const rendered = source.replaceAll("__REPO_ROOT__", REPO_ROOT);
  await mkdir(path.dirname(runtimeConfig), { recursive: true, mode: 0o700 });
  await writeFile(runtimeConfig, rendered, { mode: 0o600 });
  return runtimeConfig;
}

export async function runHydra(command) {
  if (!new Set(["refresh", "serve", "stop"]).has(command)) {
    throw new Error("Usage: node benchmark/hydra.js <refresh|serve|stop>");
  }
  const configPath = await materializeHydraConfig();
  const args = [
    path.join(REPO_ROOT, "src", "cli.js"),
    command,
    "--config",
    configPath,
    "--port",
    "3857",
  ];
  if (command === "serve") args.push("--no-menubar");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Benchmark Hydra exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runHydra(process.argv[2]).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
