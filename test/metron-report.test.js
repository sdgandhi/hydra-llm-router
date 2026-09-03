import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateGenerationCost,
  metronTurnRows,
  percentile,
  summarizeMetron,
} from "../src/metron/report.js";

function generation(data) {
  return { type: "generation.completed", data };
}

test("calculates nearest-rank percentiles and preserves empty values as unknown", () => {
  assert.equal(percentile([10, 30, 20, null], 0.5), 20);
  assert.equal(percentile([10, 30, 20], 0.95), 30);
  assert.equal(percentile([], 0.5), null);
});

test("estimates cloud list-price equivalent and local machine time independently", () => {
  const cloud = estimateGenerationCost(generation({
    provider: "openai",
    target_model: "gpt-5.6-sol",
    usage: { input_tokens: 1_000_000, cached_input_tokens: 100_000, output_tokens: 100_000 },
  }));
  assert.equal(cloud.completeness, "estimated");
  assert.equal(cloud.usd, 5.64);

  const local = estimateGenerationCost(generation({ provider: "lmstudio", duration_ms: 3_600_000 }), {
    machineHourUsd: 0,
  });
  assert.deepEqual(local, { usd: 0, completeness: "estimated" });
});

test("keeps unavailable cost inputs unknown instead of coercing them to zero", () => {
  assert.deepEqual(
    estimateGenerationCost(generation({ provider: "openai", target_model: "unpriced", usage: {} })),
    { usd: null, completeness: "unknown" },
  );
  const summary = summarizeMetron([generation({ provider: "openai", target_model: "unpriced", duration_ms: 5 })]);
  assert.equal(summary.estimated_cost_usd, null);
  assert.equal(summary.tokens.total, null);
  assert.equal(summary.cost_completeness, "unknown");
});

test("reconciles Codex turn lifecycle rows", () => {
  const events = [
    { type: "turn.started", turn_id: "turn-1", session_id: "session-1", occurred_at: "2026-09-03T00:00:00Z", completeness: "reconciled", data: { model: "gpt", project: "repo" } },
    { type: "tool.completed", turn_id: "turn-1", session_id: "session-1", occurred_at: "2026-09-03T00:00:01Z", completeness: "reconciled", data: {} },
    { type: "turn.usage", turn_id: "turn-1", session_id: "session-1", occurred_at: "2026-09-03T00:00:02Z", completeness: "reconciled", data: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } },
    { type: "turn.completed", turn_id: "turn-1", session_id: "session-1", occurred_at: "2026-09-03T00:00:03Z", completeness: "reconciled", data: { status: "completed", duration_ms: 3000 } },
  ];
  assert.deepEqual(metronTurnRows(events), [{
    turn_id: "turn-1",
    session_id: "session-1",
    started_at: "2026-09-03T00:00:00Z",
    completed_at: "2026-09-03T00:00:03Z",
    status: "completed",
    duration_ms: 3000,
    time_to_first_output_ms: null,
    model: "gpt",
    project: "repo",
    input_tokens: 4,
    output_tokens: 2,
    total_tokens: 6,
    tool_count: 1,
    completeness: "reconciled",
  }]);
});
