import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  developmentEnvironment,
  developmentPaths,
  hydraDevelopmentArgs,
} from "../scripts/dev-context.js";

test("uses an isolated Codex home, SQLite root, and non-Desktop port", () => {
  const paths = developmentPaths({
    HYDRA_DEV_CODEX_HOME: "/tmp/hydra-dev-codex",
    HYDRA_SOURCE_CODEX_HOME: "/tmp/desktop-codex",
    HYDRA_DEV_PORT: "4857",
  });
  assert.equal(paths.codexHome, "/tmp/hydra-dev-codex");
  assert.equal(paths.sqliteHome, "/tmp/hydra-dev-codex/sqlite");
  assert.equal(paths.sourceCodexHome, "/tmp/desktop-codex");
  assert.equal(paths.port, 4857);
  assert.equal(paths.hydraConfigPath, "/tmp/hydra-dev-codex/hydra/config.toml");
  assert.equal(paths.codexBin, path.resolve("scripts/dev-codex"));
  assert.equal(paths.upstreamCodexBin, path.resolve("node_modules/.bin/codex"));
});

test("rejects the Desktop Hydra port for development", () => {
  assert.throws(
    () => developmentPaths({ HYDRA_DEV_CODEX_HOME: "/tmp/hydra-dev-codex", HYDRA_DEV_PORT: "3847" }),
    /must not use the Desktop Hydra port/,
  );
});

test("isolates Codex state and removes direct API overrides", () => {
  const paths = developmentPaths({ HYDRA_DEV_CODEX_HOME: "/tmp/hydra-dev-codex" });
  const environment = developmentEnvironment(paths, {
    PATH: "/usr/bin",
    CODEX_API_KEY: "codex-secret",
    CODEX_ACCESS_TOKEN: "access-token",
    OPENAI_API_KEY: "openai-secret",
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    OPENAI_IDENTITY_TOKEN_FILE: "/tmp/identity-token",
    OPENAI_WORKLOAD_IDENTITY_CONTEXT: "workload-context",
  });
  assert.equal(environment.CODEX_HOME, "/tmp/hydra-dev-codex");
  assert.equal(environment.CODEX_SQLITE_HOME, "/tmp/hydra-dev-codex/sqlite");
  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.CODEX_API_KEY, undefined);
  assert.equal(environment.CODEX_ACCESS_TOKEN, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.OPENAI_BASE_URL, undefined);
  assert.equal(environment.OPENAI_IDENTITY_TOKEN_FILE, undefined);
  assert.equal(environment.OPENAI_WORKLOAD_IDENTITY_CONTEXT, undefined);
});

test("pins Hydra development commands to isolated paths and the shell Codex shim", () => {
  const paths = developmentPaths({ HYDRA_DEV_CODEX_HOME: "/tmp/hydra-dev-codex" });
  const args = hydraDevelopmentArgs(paths, "prompt", ["--model", "gpt-test"]);
  assert.deepEqual(args.slice(0, 2), [paths.hydraCli, "prompt"]);
  assert.ok(args.includes(paths.hydraConfigPath));
  assert.ok(args.includes(paths.codexHome));
  assert.ok(args.includes(paths.codexBin));
  assert.ok(args.includes(String(paths.port)));
  assert.deepEqual(args.slice(-2), ["--model", "gpt-test"]);
});
