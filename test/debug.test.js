import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeHeaders, summarizeBody } from "../src/debug.js";

test("redacts sensitive auth headers while preserving diagnostic header names", () => {
  const headers = sanitizeHeaders({
    authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
    cookie: "session=abcdef",
    "user-agent": "Codex Desktop",
    "content-type": "application/json",
    host: "127.0.0.1",
  });

  assert.equal(headers.authorization, "<redacted:33:sha256-unavailable>");
  assert.equal(headers.cookie, "<redacted:14:sha256-unavailable>");
  assert.equal(headers["user-agent"], "Codex Desktop");
  assert.equal(headers["content-type"], "application/json");
  assert.equal(headers.host, undefined);
});

test("summarizes request body without retaining prompt content", () => {
  const summary = summarizeBody({
    model: "gpt-test",
    stream: true,
    input: [{ role: "user", content: "secret prompt" }],
    tools: [{ type: "function", name: "x" }],
  });

  assert.deepEqual(summary, {
    model: "gpt-test",
    stream: true,
    inputType: "array",
    inputItems: 1,
    hasTools: true,
    toolCount: 1,
    keys: ["input", "model", "stream", "tools"],
  });
});
