import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { metronTurnRows, summarizeMetron } from "./report.js";

const UI_DIR = fileURLToPath(new URL("./ui/", import.meta.url));
const BENCHMARK_FILES = new Set(["config.json", "environment.json", "events.jsonl", "results.jsonl", "summary.json"]);

function loopbackHost(value) {
  return /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(value ?? "") || /^\[::1\](?::\d+)?$/.test(value ?? "");
}

function commonHeaders(contentType) {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
  };
}

function send(res, status, body, contentType = "application/json; charset=utf-8") {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { ...commonHeaders(contentType), "content-length": payload.length });
  res.end(payload);
}

function sendJson(res, status, value) {
  send(res, status, `${JSON.stringify(value)}\n`);
}

async function benchmarkRuns(runsDir) {
  if (!runsDir) return [];
  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const runs = [];
  for (const entry of entries.filter((item) => item.isDirectory() && /^\d{4}-\d{2}-\d{2}-v\d+$/.test(item.name))) {
    try {
      const summary = JSON.parse(await readFile(path.join(runsDir, entry.name, "summary.json"), "utf8"));
      runs.push({ id: entry.name, summary });
    } catch {
      // An incomplete run remains invisible until its summary is valid.
    }
  }
  return runs.sort((left, right) => right.id.localeCompare(left.id));
}

export function createMetronDashboard({ store, machineHourUsd = 0, benchmarkRunsDir = null } = {}) {
  if (!store) throw new Error("Metron dashboard requires an event store");

  return {
    async handle(req, res) {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== "/metron" && !url.pathname.startsWith("/metron/")) return false;
      if (!loopbackHost(req.headers.host)) {
        sendJson(res, 403, { error: { message: "Metron is available only through a loopback host." } });
        return true;
      }
      if (req.method !== "GET") {
        sendJson(res, 405, { error: { message: "Method not allowed" } });
        return true;
      }
      if (url.pathname === "/metron") {
        res.writeHead(302, { location: "/metron/", ...commonHeaders("text/plain; charset=utf-8") });
        res.end("Redirecting to Metron\n");
        return true;
      }
      if (url.pathname === "/metron/") {
        send(res, 200, await readFile(path.join(UI_DIR, "index.html")), "text/html; charset=utf-8");
        return true;
      }
      if (url.pathname === "/metron/app.css") {
        send(res, 200, await readFile(path.join(UI_DIR, "app.css")), "text/css; charset=utf-8");
        return true;
      }
      if (url.pathname === "/metron/app.js") {
        send(res, 200, await readFile(path.join(UI_DIR, "app.js")), "text/javascript; charset=utf-8");
        return true;
      }

      const events = await store.read({ from: url.searchParams.get("from"), to: url.searchParams.get("to") });
      if (url.pathname === "/metron/api/v1/summary") {
        sendJson(res, 200, summarizeMetron(events, { machineHourUsd }));
        return true;
      }
      if (url.pathname === "/metron/api/v1/turns") {
        sendJson(res, 200, { turns: metronTurnRows(events) });
        return true;
      }
      if (url.pathname === "/metron/api/v1/benchmarks") {
        sendJson(res, 200, { runs: await benchmarkRuns(benchmarkRunsDir) });
        return true;
      }
      const artifact = url.pathname.match(/^\/metron\/api\/v1\/benchmarks\/(\d{4}-\d{2}-\d{2}-v\d+)\/([^/]+)$/);
      if (artifact && benchmarkRunsDir && BENCHMARK_FILES.has(artifact[2])) {
        try {
          const contents = await readFile(path.join(benchmarkRunsDir, artifact[1], artifact[2]));
          const type = artifact[2].endsWith(".jsonl") ? "application/x-ndjson; charset=utf-8" : "application/json; charset=utf-8";
          send(res, 200, contents, type);
        } catch (error) {
          if (error.code === "ENOENT") sendJson(res, 404, { error: { message: "Artifact not found" } });
          else throw error;
        }
        return true;
      }
      sendJson(res, 404, { error: { message: "Not found" } });
      return true;
    },
  };
}
