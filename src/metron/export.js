import { createHash, randomUUID } from "node:crypto";
import { summarizeMetron } from "./report.js";

function pseudonym(value, salt) {
  if (value == null) return null;
  return createHash("sha256").update(salt).update(":").update(String(value)).digest("hex").slice(0, 16);
}

export function pseudonymizeMetronEvents(events, { salt = randomUUID() } = {}) {
  return events.map((event) => ({
    ...event,
    event_id: pseudonym(event.event_id, salt),
    session_id: pseudonym(event.session_id, salt),
    turn_id: pseudonym(event.turn_id, salt),
    generation_id: pseudonym(event.generation_id, salt),
  }));
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function serializeMetronExport(events, format, options = {}) {
  const exported = pseudonymizeMetronEvents(events, options);
  if (format === "jsonl") return `${exported.map((event) => JSON.stringify(event)).join("\n")}${exported.length ? "\n" : ""}`;
  if (format === "csv") {
    const columns = ["schema_version", "event_id", "source", "type", "occurred_at", "observed_at", "session_id", "turn_id", "generation_id", "completeness", "data"];
    return `${columns.join(",")}\n${exported.map((event) => columns.map((column) => csvCell(column === "data" ? JSON.stringify(event.data) : event[column])).join(",")).join("\n")}${exported.length ? "\n" : ""}`;
  }
  if (format === "html") {
    const summary = summarizeMetron(exported, options);
    const rows = exported.map((event) => `<tr><td>${escapeHtml(event.occurred_at)}</td><td>${escapeHtml(event.source)}</td><td>${escapeHtml(event.type)}</td><td>${escapeHtml(event.completeness)}</td></tr>`).join("");
    return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Metron export</title><style>body{font:14px system-ui;margin:40px;max-width:1000px}table{border-collapse:collapse;width:100%}th,td{padding:8px;border-bottom:1px solid #ddd;text-align:left}pre{white-space:pre-wrap}</style><h1>Metron export</h1><pre>${escapeHtml(JSON.stringify(summary, null, 2))}</pre><table><thead><tr><th>Time</th><th>Source</th><th>Type</th><th>Completeness</th></tr></thead><tbody>${rows}</tbody></table></html>\n`;
  }
  throw new Error(`Unsupported Metron export format: ${format}`);
}
