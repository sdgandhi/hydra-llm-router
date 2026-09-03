import test from "node:test";
import assert from "node:assert/strict";
import { createMetronDashboard } from "../src/metron/dashboard.js";

function responseRecorder() {
  return {
    status: null,
    headers: null,
    body: "",
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(value = "") { this.body += Buffer.isBuffer(value) ? value.toString("utf8") : value; },
  };
}

test("serves summary data only for loopback hosts", async () => {
  const dashboard = createMetronDashboard({
    store: { async read() { return []; } },
    machineHourUsd: 0,
  });
  const allowed = responseRecorder();
  assert.equal(await dashboard.handle({ method: "GET", url: "/metron/api/v1/summary", headers: { host: "127.0.0.1:3847" } }, allowed), true);
  assert.equal(allowed.status, 200);
  assert.equal(JSON.parse(allowed.body).generation_count, 0);
  assert.match(allowed.headers["content-security-policy"], /default-src 'self'/);

  const denied = responseRecorder();
  await dashboard.handle({ method: "GET", url: "/metron/api/v1/summary", headers: { host: "example.com" } }, denied);
  assert.equal(denied.status, 403);
});

test("declines non-Metron routes and reports no benchmark runs when none exist", async () => {
  const dashboard = createMetronDashboard({ store: { async read() { return []; } } });
  assert.equal(await dashboard.handle({ method: "GET", url: "/healthz", headers: {} }, responseRecorder()), false);
  const response = responseRecorder();
  await dashboard.handle({ method: "GET", url: "/metron/api/v1/benchmarks", headers: { host: "localhost" } }, response);
  assert.deepEqual(JSON.parse(response.body), { runs: [] });
});
