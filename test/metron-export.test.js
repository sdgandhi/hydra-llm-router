import test from "node:test";
import assert from "node:assert/strict";
import { pseudonymizeMetronEvents, serializeMetronExport } from "../src/metron/export.js";

const event = {
  schema_version: 1,
  event_id: "event-secret",
  source: "codex",
  type: "turn.completed",
  occurred_at: "2026-09-03T00:00:00.000Z",
  observed_at: "2026-09-03T00:00:00.000Z",
  session_id: "session-secret",
  turn_id: "turn-secret",
  generation_id: null,
  completeness: "reconciled",
  data: { status: "completed" },
};

test("pseudonymizes correlation identifiers consistently", () => {
  const [first, second] = pseudonymizeMetronEvents([event, event], { salt: "bundle" });
  assert.equal(first.session_id, second.session_id);
  assert.notEqual(first.session_id, event.session_id);
  assert.doesNotMatch(JSON.stringify(first), /session-secret|turn-secret|event-secret/);
});

test("serializes JSONL, CSV, and standalone HTML exports", () => {
  assert.match(serializeMetronExport([event], "jsonl", { salt: "bundle" }), /"turn.completed"/);
  assert.match(serializeMetronExport([event], "csv", { salt: "bundle" }), /^schema_version,event_id,/);
  assert.match(serializeMetronExport([event], "html", { salt: "bundle" }), /<!doctype html>/);
  assert.throws(() => serializeMetronExport([], "pdf"), /Unsupported/);
});
