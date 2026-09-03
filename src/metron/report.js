export const BUNDLED_RATE_CARD = Object.freeze({
  id: "openai-api-2026-09-03",
  effective_date: "2026-09-03",
  currency: "USD",
  per_million_tokens: Object.freeze({
    "gpt-5.6-sol": Object.freeze({ input: 4, cached_input: 0.4, output: 20 }),
    "gpt-5.6": Object.freeze({ input: 4, cached_input: 0.4, output: 20 }),
    "gpt-5.6-terra": Object.freeze({ input: 2, cached_input: 0.2, output: 12 }),
    "gpt-5.6-luna": Object.freeze({ input: 0.2, cached_input: 0.02, output: 1.2 }),
  }),
});

function finite(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function percentile(values, fraction) {
  const sorted = values.filter((value) => finite(value) != null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index];
}

export function estimateGenerationCost(event, {
  machineHourUsd = 0,
  rateCard = BUNDLED_RATE_CARD,
} = {}) {
  if (event?.type !== "generation.completed") return { usd: null, completeness: "unknown" };
  const data = event.data ?? {};
  if (data.provider !== "openai") {
    const durationMs = finite(data.duration_ms);
    if (durationMs == null || finite(machineHourUsd) == null) return { usd: null, completeness: "unknown" };
    return { usd: (durationMs / 3_600_000) * machineHourUsd, completeness: "estimated" };
  }
  const prices = rateCard?.per_million_tokens?.[data.target_model];
  const usage = data.usage;
  const input = finite(usage?.input_tokens);
  const cached = finite(usage?.cached_input_tokens) ?? 0;
  const output = finite(usage?.output_tokens);
  if (!prices || input == null || output == null) return { usd: null, completeness: "unknown" };
  const uncached = Math.max(0, input - cached);
  return {
    usd: (uncached * prices.input + cached * prices.cached_input + output * prices.output) / 1_000_000,
    completeness: "estimated",
  };
}

function sumKnown(values) {
  const known = values.filter((value) => finite(value) != null);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
}

export function metronTurnRows(events) {
  const rows = new Map();
  for (const event of events) {
    if (!event.turn_id) continue;
    const row = rows.get(event.turn_id) ?? {
      turn_id: event.turn_id,
      session_id: event.session_id,
      started_at: null,
      completed_at: null,
      status: "unknown",
      duration_ms: null,
      time_to_first_output_ms: null,
      model: null,
      project: null,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      tool_count: 0,
      completeness: event.completeness,
    };
    if (event.type === "turn.started") {
      row.started_at = event.occurred_at;
      row.model = event.data?.model ?? row.model;
      row.project = event.data?.project ?? row.project;
    } else if (event.type === "turn.completed") {
      row.completed_at = event.occurred_at;
      row.status = event.data?.status ?? row.status;
      row.duration_ms = finite(event.data?.duration_ms);
      row.time_to_first_output_ms = finite(event.data?.time_to_first_output_ms);
    } else if (event.type === "turn.usage") {
      row.input_tokens = finite(event.data?.input_tokens);
      row.output_tokens = finite(event.data?.output_tokens);
      row.total_tokens = finite(event.data?.total_tokens);
    } else if (event.type === "tool.completed") {
      row.tool_count += 1;
    }
    rows.set(event.turn_id, row);
  }
  return [...rows.values()].sort((left, right) =>
    String(right.completed_at ?? right.started_at).localeCompare(String(left.completed_at ?? left.started_at))
  );
}

export function summarizeMetron(events, options = {}) {
  const generations = events.filter((event) => event.type === "generation.completed");
  const turns = metronTurnRows(events);
  const costs = generations.map((event) => estimateGenerationCost(event, options));
  const knownCosts = costs.map((cost) => cost.usd).filter((value) => value != null);
  const statuses = generations.map((event) => event.data?.status ?? "unknown");
  const inputTokens = generations.map((event) => event.data?.usage?.input_tokens);
  const outputTokens = generations.map((event) => event.data?.usage?.output_tokens);
  const totalTokens = generations.map((event) => event.data?.usage?.total_tokens);
  return {
    generated_at: new Date().toISOString(),
    event_count: events.length,
    turn_count: turns.length,
    generation_count: generations.length,
    completed_generations: statuses.filter((status) => status === "completed").length,
    failed_generations: statuses.filter((status) => status === "failed").length,
    cancelled_generations: statuses.filter((status) => status === "cancelled").length,
    duration_ms: {
      p50: percentile(generations.map((event) => event.data?.duration_ms), 0.5),
      p95: percentile(generations.map((event) => event.data?.duration_ms), 0.95),
    },
    time_to_first_output_ms: {
      p50: percentile(generations.map((event) => event.data?.time_to_first_output_ms), 0.5),
      p95: percentile(generations.map((event) => event.data?.time_to_first_output_ms), 0.95),
    },
    tokens: {
      input: sumKnown(inputTokens),
      output: sumKnown(outputTokens),
      total: sumKnown(totalTokens),
      generations_with_usage: totalTokens.filter((value) => finite(value) != null).length,
    },
    tool_count: events.filter((event) => event.type === "tool.completed").length,
    estimated_cost_usd: knownCosts.length ? knownCosts.reduce((sum, value) => sum + value, 0) : null,
    cost_completeness: generations.length > 0 && knownCosts.length === generations.length ? "estimated" : "unknown",
    rate_card: options.rateCard?.id ?? BUNDLED_RATE_CARD.id,
    machine_hour_usd: options.machineHourUsd ?? 0,
  };
}
