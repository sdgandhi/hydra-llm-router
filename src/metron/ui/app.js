const $ = (selector) => document.querySelector(selector);

function value(number, suffix = "") {
  return number == null ? "Unknown" : `${new Intl.NumberFormat().format(Math.round(number * 100) / 100)}${suffix}`;
}

function card(label, content) {
  const element = document.createElement("div");
  element.className = "card";
  const name = document.createElement("span");
  name.className = "label";
  name.textContent = label;
  const metric = document.createElement("strong");
  metric.className = "value";
  metric.textContent = content;
  element.append(name, metric);
  return element;
}

function cell(text, className = "") {
  const td = document.createElement("td");
  td.textContent = text;
  td.className = className;
  return td;
}

async function load() {
  $("#error").textContent = "";
  try {
    const [summaryResponse, turnsResponse, benchmarksResponse] = await Promise.all([
      fetch("/metron/api/v1/summary"),
      fetch("/metron/api/v1/turns"),
      fetch("/metron/api/v1/benchmarks"),
    ]);
    if (![summaryResponse, turnsResponse, benchmarksResponse].every((response) => response.ok)) throw new Error("Metron data is unavailable");
    const [summary, turnsData, benchmarkData] = await Promise.all([
      summaryResponse.json(), turnsResponse.json(), benchmarksResponse.json(),
    ]);

    const cards = $("#cards");
    cards.replaceChildren(
      card("Turns", value(summary.turn_count)),
      card("Generations", value(summary.generation_count)),
      card("P50 duration", value(summary.duration_ms.p50, " ms")),
      card("P95 first output", value(summary.time_to_first_output_ms.p95, " ms")),
      card("Tokens", value(summary.tokens.total)),
      card("API equivalent cost", summary.estimated_cost_usd == null ? "Unknown" : `$${summary.estimated_cost_usd.toFixed(4)}`),
    );
    $("#updated").textContent = new Date(summary.generated_at).toLocaleString();

    const turns = $("#turns");
    turns.replaceChildren();
    if (!turnsData.turns.length) {
      const row = document.createElement("tr");
      const empty = cell("No completed Codex turns observed yet.");
      empty.colSpan = 6;
      row.append(empty);
      turns.append(row);
    }
    for (const turn of turnsData.turns.slice(0, 50)) {
      const row = document.createElement("tr");
      row.append(
        cell(turn.status, `status-${turn.status}`),
        cell(turn.model ?? "Unknown"),
        cell(turn.project ?? "Unknown"),
        cell(value(turn.duration_ms, " ms")),
        cell(value(turn.total_tokens)),
        cell(value(turn.tool_count)),
      );
      turns.append(row);
    }

    const benchmarkSection = $("#benchmarks-section");
    const benchmarks = $("#benchmarks");
    benchmarks.replaceChildren();
    benchmarkSection.classList.toggle("hidden", benchmarkData.runs.length === 0);
    for (const run of benchmarkData.runs) {
      const item = document.createElement("div");
      item.className = "run";
      const title = document.createElement("strong");
      title.textContent = run.id;
      const link = document.createElement("a");
      link.href = `/metron/api/v1/benchmarks/${encodeURIComponent(run.id)}/summary.json`;
      link.textContent = "Summary JSON";
      item.append(title, link);
      benchmarks.append(item);
    }
  } catch (error) {
    $("#error").textContent = error.message;
  }
}

$("#refresh").addEventListener("click", load);
load();
