import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { configureDebugLog, sanitizeHeaders, summarizeBody, writeDebugLine } from "../src/debug.js";

test("redacts sensitive auth headers while preserving diagnostic header names", () => {
  const headers = sanitizeHeaders({
    authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
    cookie: "session=abcdef",
    "chatgpt-account-id": "account-abcdefghijklmnop",
    "x-codex-turn-metadata": '{"session_id":"secret"}',
    "x-codex-window-id": "window-abcdefghijklmnop",
    "user-agent": "Codex Desktop",
    "content-type": "application/json",
    host: "127.0.0.1",
  });

  assert.equal(headers.authorization, "<redacted:33:sha256-unavailable>");
  assert.equal(headers.cookie, "<redacted:14:sha256-unavailable>");
  assert.equal(headers["chatgpt-account-id"], "<redacted:24:sha256-unavailable>");
  assert.equal(headers["x-codex-turn-metadata"], "<redacted:23:sha256-unavailable>");
  assert.equal(headers["x-codex-window-id"], "<redacted:23:sha256-unavailable>");
  assert.equal(headers["user-agent"], "Codex Desktop");
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers.host, undefined);
});

test("summarizes request body without retaining prompt content", () => {
  const summary = summarizeBody({
    model: "gpt-test",
    stream: true,
    input: [{ role: "user", content: "secret prompt" }],
    tools: [{ type: "function", name: "x" }],
  });

  assert.deepEqual(summary, {
    model: "gpt-test",
    stream: true,
    inputType: "array",
    inputItems: 1,
    hasTools: true,
    toolCount: 1,
    functionToolCount: 1,
    toolTypes: ["function"],
    keys: ["input", "model", "stream", "tools"],
  });
});

test("caps the debug log at the configured byte limit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hydra-debug-log-"));
  const logPath = path.join(root, "hydra.log");
  try {
    configureDebugLog(logPath, { maxBytes: 1_000 });
    writeDebugLine("first", { value: "a".repeat(700) });
    writeDebugLine("second", { value: "b".repeat(700) });

    assert.ok((await stat(logPath)).size <= 1_000);
    assert.doesNotMatch(await readFile(logPath, "utf8"), /\[first\]/);
    assert.match(await readFile(logPath, "utf8"), /\[second\]/);
  } finally {
    configureDebugLog(null);
    await rm(root, { recursive: true, force: true });
  }
});
