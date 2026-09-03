import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMetronEnvelope, createMetronStore, readMetronEvents } from "../src/metron/store.js";

test("creates versioned privacy-safe Metron envelopes", () => {
  const event = createMetronEnvelope(
    {
      source: "hydra",
      type: "generation.completed",
      occurredAt: "2026-09-03T12:00:00.000Z",
      data: {
        model: "gpt-5.6-sol",
        input_tokens: 12,
        output_tokens: 4,
        prompt: "secret",
        nested: { command: "danger", status: "completed" },
      },
    },
    { idFactory: () => "event-1", clock: () => new Date("2026-09-03T12:00:01.000Z") },
  );
  assert.equal(event.schema_version, 1);
  assert.equal(event.event_id, "event-1");
  assert.equal(event.data.input_tokens, 12);
  assert.equal(event.data.output_tokens, 4);
  assert.equal(event.data.prompt, undefined);
  assert.deepEqual(event.data.nested, { status: "completed" });
});

test("appends daily JSONL and ignores malformed or duplicate records while reading", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "metron-store-"));
  try {
    const store = createMetronStore({
      eventsDir: root,
      idFactory: () => "stable",
      clock: () => new Date("2026-09-03T12:00:00.000Z"),
    });
    await store.emit({ source: "codex", type: "turn.started" });
    await store.emit({ source: "codex", type: "turn.started" });
    const file = path.join(root, "2026-09-03.jsonl");
    assert.equal((await readFile(file, "utf8")).trim().split("\n").length, 2);
    const events = await readMetronEvents(root);
    assert.equal(events.length, 1);
    assert.equal(events[0].event_id, "stable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
