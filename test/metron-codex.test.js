import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCodexFileContext, createCodexTailer, normalizeCodexRecord } from "../src/metron/codex.js";
import { createMetronStore } from "../src/metron/store.js";

test("normalizes Codex lifecycle, usage, and tool metadata without content", () => {
  const context = createCodexFileContext();
  normalizeCodexRecord({
    type: "session_meta",
    payload: { id: "thread-1", cli_version: "0.1", cwd: "/tmp/private-project" },
  }, context);
  normalizeCodexRecord({
    type: "turn_context",
    payload: { turn_id: "turn-1", model: "gpt-5.6-sol" },
  }, context);
  const [started] = normalizeCodexRecord({
    type: "event_msg",
    payload: { type: "task_started", turn_id: "turn-1", model_context_window: 1000 },
  }, context, { observedAt: "2026-09-03T12:00:00.000Z", eventId: "a" });
  const [usage] = normalizeCodexRecord({
    type: "event_msg",
    payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10, output_tokens: 5 } } },
  }, context, { observedAt: "2026-09-03T12:00:01.000Z", eventId: "b" });
  const [tool] = normalizeCodexRecord({
    type: "event_msg",
    payload: { type: "item_completed", item: { type: "CommandExecution", command: "secret", stdout: "secret", status: "completed", exit_code: 0, duration: 12 } },
  }, context, { observedAt: "2026-09-03T12:00:02.000Z", eventId: "c" });

  assert.equal(started.data.project, "private-project");
  assert.equal(started.data.model, "gpt-5.6-sol");
  assert.equal(usage.data.input_tokens, 10);
  assert.deepEqual(tool.data, {
    model: "gpt-5.6-sol",
    project: "private-project",
    cli_version: "0.1",
    status: "completed",
    duration_ms: 12,
    tool_type: "command_execution",
    exit_code: 0,
  });
  assert.equal(JSON.stringify(tool).includes("secret"), false);
});

test("tails complete appended records and resumes without duplicates", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "metron-codex-"));
  const sessions = path.join(root, "codex", "sessions", "2026", "09", "03");
  const eventsDir = path.join(root, "events");
  const cursorPath = path.join(root, "cursors.json");
  const rollout = path.join(sessions, "rollout.jsonl");
  try {
    await mkdir(sessions, { recursive: true });
    await writeFile(rollout, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-1", cwd: "/tmp/project" } }),
      JSON.stringify({ type: "turn_context", payload: { turn_id: "turn-1", model: "test-model" } }),
      "",
    ].join("\n"));
    const store = createMetronStore({ eventsDir });
    const tailer = createCodexTailer({
      codexHome: path.join(root, "codex"),
      cursorPath,
      store,
      startAtEnd: false,
    });
    await tailer.scan();
    await appendFile(rollout, `${JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1", duration_ms: 42 } })}\n`);
    await tailer.scan();
    await tailer.scan();
    const events = await store.read();
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "turn.completed");
    assert.equal(events[0].data.duration_ms, 42);
    assert.equal(events[0].session_id, "thread-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
