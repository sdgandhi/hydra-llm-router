import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export const METRON_SCHEMA_VERSION = 1;
export const METRON_COMPLETENESS = new Set(["exact", "reconciled", "estimated", "unknown"]);

const SENSITIVE_KEYS = new Set([
  "arguments",
  "command",
  "content",
  "cwd",
  "diff",
  "images",
  "input",
  "local_images",
  "message",
  "output",
  "path",
  "prompt",
  "query",
  "raw",
  "reasoning",
  "stderr",
  "stdout",
  "text",
]);

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function sanitizeMetronData(value) {
  if (Array.isArray(value)) return value.map(sanitizeMetronData);
  if (!isPlainObject(value)) {
    if (typeof value === "string") return value.slice(0, 256);
    return value;
  }
  const sanitized = {};
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase();
    if (SENSITIVE_KEYS.has(normalized) || normalized.endsWith("_path")) continue;
    sanitized[key] = sanitizeMetronData(child);
  }
  return sanitized;
}

function isoDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error(`Invalid Metron timestamp: ${value}`);
  return date.toISOString();
}

export function createMetronEnvelope(event, { clock = () => new Date(), idFactory = randomUUID } = {}) {
  if (!event || typeof event !== "object") throw new Error("Metron event must be an object");
  if (typeof event.source !== "string" || !event.source) throw new Error("Metron event source is required");
  if (typeof event.type !== "string" || !event.type) throw new Error("Metron event type is required");
  const completeness = event.completeness ?? "exact";
  if (!METRON_COMPLETENESS.has(completeness)) {
    throw new Error(`Invalid Metron completeness: ${completeness}`);
  }
  const observedAt = isoDate(event.observedAt ?? clock());
  return {
    schema_version: METRON_SCHEMA_VERSION,
    event_id: event.eventId ?? idFactory(),
    source: event.source,
    type: event.type,
    occurred_at: isoDate(event.occurredAt ?? observedAt),
    observed_at: observedAt,
    session_id: event.sessionId ?? null,
    turn_id: event.turnId ?? null,
    generation_id: event.generationId ?? null,
    completeness,
    data: sanitizeMetronData(event.data ?? {}),
  };
}

export function createMetronStore({ eventsDir, clock = () => new Date(), idFactory = randomUUID }) {
  if (!eventsDir) throw new Error("Metron events directory is required");
  let pending = Promise.resolve();

  return {
    async emit(event) {
      const envelope = createMetronEnvelope(event, { clock, idFactory });
      const partition = `${envelope.occurred_at.slice(0, 10)}.jsonl`;
      const target = path.join(eventsDir, partition);
      pending = pending.then(async () => {
        await mkdir(eventsDir, { recursive: true, mode: 0o700 });
        await appendFile(target, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600 });
      });
      await pending;
      return envelope;
    },

    async flush() {
      await pending;
    },

    async read(options = {}) {
      await pending;
      return readMetronEvents(eventsDir, options);
    },
  };
}

export async function readMetronEvents(eventsDir, { from = null, to = null } = {}) {
  let names;
  try {
    names = (await readdir(eventsDir)).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const fromMs = from == null ? Number.NEGATIVE_INFINITY : new Date(from).valueOf();
  const toMs = to == null ? Number.POSITIVE_INFINITY : new Date(to).valueOf();
  const events = [];
  const seen = new Set();
  for (const name of names) {
    const text = await readFile(path.join(eventsDir, name), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const timestamp = new Date(event.occurred_at).valueOf();
        if (timestamp < fromMs || timestamp > toMs || seen.has(event.event_id)) continue;
        seen.add(event.event_id);
        events.push(event);
      } catch {
        // A malformed line must not make the remaining telemetry unreadable.
      }
    }
  }
  return events.sort((left, right) => left.occurred_at.localeCompare(right.occurred_at));
}
