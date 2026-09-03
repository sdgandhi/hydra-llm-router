import test from "node:test";
import assert from "node:assert/strict";
import {
  createHydraTelemetry,
  observeMetronJson,
  observeMetronSse,
} from "../src/metron/hydra.js";

function clock(...values) {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)]);
}

test("records structured Hydra generation timing and usage without response content", async () => {
  const events = [];
  const telemetry = createHydraTelemetry({
    store: { async emit(event) { events.push(event); } },
    clock: clock(
      "2026-09-03T12:00:00.000Z",
      "2026-09-03T12:00:00.125Z",
      "2026-09-03T12:00:01.000Z",
    ),
    idFactory: () => "generation-1",
  });
  const res = {};
  const generation = telemetry.beginGeneration({
    req: { headers: { "session-id": "session-1" } },
    res,
    requestedModel: "hydra/money-saver",
    targetModel: "gpt-5.6-sol",
    provider: "openai",
    syntheticModel: "hydra/money-saver",
  });

  observeMetronSse(res, "response.output_text.delta", { type: "response.output_text.delta", delta: "secret" });
  observeMetronSse(res, "response.completed", {
    response: {
      status: "completed",
      output: [{ content: [{ text: "secret" }] }],
      usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
    },
  });
  await generation.finish();

  assert.deepEqual(events.map((event) => event.type), [
    "generation.started",
    "generation.first_output",
    "generation.completed",
  ]);
  assert.equal(events[1].data.latency_ms, 125);
  assert.equal(events[2].data.duration_ms, 1000);
  assert.deepEqual(events[2].data.usage, {
    input_tokens: 10,
    cached_input_tokens: null,
    output_tokens: 4,
    reasoning_output_tokens: null,
    total_tokens: 14,
  });
  assert.doesNotMatch(JSON.stringify(events), /secret/);
});

test("captures non-streaming usage and keeps absent first-output timing unknown", async () => {
  const events = [];
  const telemetry = createHydraTelemetry({
    store: { async emit(event) { events.push(event); } },
    clock: clock("2026-09-03T12:00:00.000Z", "2026-09-03T12:00:00.250Z"),
    idFactory: () => "generation-2",
  });
  const res = {};
  const generation = telemetry.beginGeneration({
    req: { headers: {} },
    res,
    requestedModel: "lmstudio/model",
    provider: "lmstudio",
  });

  observeMetronJson(res, {
    status: "completed",
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  });
  await generation.finish();

  assert.equal(events.at(-1).data.time_to_first_output_ms, null);
  assert.equal(events.at(-1).data.usage.total_tokens, 5);
});

test("telemetry write failures do not reject request instrumentation", async () => {
  const failures = [];
  const telemetry = createHydraTelemetry({
    store: { async emit() { throw new Error("disk full"); } },
    onError: (error) => failures.push(error.message),
  });
  const generation = telemetry.beginGeneration({ requestedModel: "model", provider: "openai" });
  await generation.finish("failed", { error_code: "upstream" });
  assert.deepEqual(failures, ["disk full", "disk full"]);
});
