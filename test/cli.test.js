import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, shutdownHydra } from "../src/cli.js";
import { menuBarStatusItems } from "../src/menubar.js";

test("parses --no-menubar as a serve flag", () => {
  assert.deepEqual(parseArgs(["serve", "--no-menubar"]), {
    command: "serve",
    options: { no_menubar: true },
  });
});

test("serve status items match the menubar dropdown content", () => {
  assert.deepEqual(
    menuBarStatusItems({
      port: 3847,
      openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
      ollamaBaseUrl: "http://127.0.0.1:11434",
      debugAuth: true,
      emulatedToolStatuses: [
        { name: "web_search", status: "unavailable", detail: "no executable search command found" },
        { name: "tool_search", status: "ready" },
      ],
      paths: {
        logPath: "/tmp/hydra.log",
        codexConfigPath: "/tmp/config.toml",
      },
    }),
    [
      { kind: "info", title: "Hydra Running" },
      { kind: "separator" },
      { kind: "info", title: "Router: http://127.0.0.1:3847" },
      { kind: "info", title: "Cloud: https://chatgpt.com/backend-api/codex" },
      { kind: "info", title: "Ollama: http://127.0.0.1:11434" },
      {
        kind: "info",
        title: "Emulated tools: web_search: unavailable (no executable search command found), tool_search: ready",
      },
      { kind: "info", title: "Debug log: /tmp/hydra.log" },
      { kind: "info", title: "Codex config: /tmp/config.toml" },
    ],
  );
});

test("menu quit restores config, closes the server, removes pid, and stops helper", async () => {
  const calls = [];
  const server = {
    close(callback) {
      calls.push("close");
      callback();
    },
  };
  const menuBar = {
    stop() {
      calls.push("menubar-stop");
    },
  };

  const result = await shutdownHydra({
    config: testConfig(),
    server,
    menuBar,
    signal: "menubar",
    restoreOnQuit: true,
    restoreImpl: async () => {
      calls.push("restore");
      return { backupPath: "/tmp/codex/hydra/config.backup.toml" };
    },
    removePidFileImpl: async () => {
      calls.push("remove-pid");
    },
    exitImpl: (code) => {
      calls.push(`exit:${code}`);
    },
    logger: quietLogger(),
  });

  assert.equal(result.restoreStatus, "restored");
  assert.deepEqual(calls, ["restore", "close", "remove-pid", "menubar-stop", "exit:0"]);
});

test("menu quit still stops Hydra when there is no config backup", async () => {
  const calls = [];
  const missingBackup = new Error("missing backup");
  missingBackup.code = "ENOENT";

  const result = await shutdownHydra({
    config: testConfig(),
    server: {
      close(callback) {
        calls.push("close");
        callback();
      },
    },
    menuBar: {
      stop() {
        calls.push("menubar-stop");
      },
    },
    signal: "menubar",
    restoreOnQuit: true,
    restoreImpl: async () => {
      calls.push("restore");
      throw missingBackup;
    },
    removePidFileImpl: async () => {
      calls.push("remove-pid");
    },
    exitImpl: (code) => {
      calls.push(`exit:${code}`);
    },
    logger: quietLogger(),
  });

  assert.equal(result.restoreStatus, "missing_backup");
  assert.deepEqual(calls, ["restore", "close", "remove-pid", "menubar-stop", "exit:0"]);
});

function testConfig() {
  return {
    debugAuth: false,
    paths: {
      backupPath: "/tmp/codex/hydra/config.backup.toml",
    },
  };
}

function quietLogger() {
  return {
    log() {},
    warn() {},
    error() {},
  };
}
