import test from "node:test";
import assert from "node:assert/strict";
import { zstdCompressSync } from "node:zlib";
import { decodeBody, emulatedToolStatuses, normalizeOllamaTools, upstreamResponsesUrl } from "../src/router.js";

test("forwards /responses under an OpenAI-compatible /v1 base path", () => {
  assert.equal(
    upstreamResponsesUrl("/responses", "https://api.openai.com/v1").toString(),
    "https://api.openai.com/v1/responses",
  );
});

test("does not duplicate /v1 when desktop sends /v1/responses", () => {
  assert.equal(
    upstreamResponsesUrl("/v1/responses", "https://api.openai.com/v1").toString(),
    "https://api.openai.com/v1/responses",
  );
});

test("forwards /responses under the Codex ChatGPT backend base path", () => {
  assert.equal(
    upstreamResponsesUrl("/responses", "https://chatgpt.com/backend-api/codex").toString(),
    "https://chatgpt.com/backend-api/codex/responses",
  );
});

test("decodes zstd-compressed request bodies from Codex Desktop", () => {
  const payload = Buffer.from(JSON.stringify({ model: "gpt-5.1-codex", input: "ping" }));
  const compressed = zstdCompressSync(payload);

  assert.equal(decodeBody(compressed, "zstd").toString("utf8"), payload.toString("utf8"));
});

test("converts Responses function tools to Ollama tools", () => {
  assert.deepEqual(
    normalizeOllamaTools([
      {
        type: "function",
        name: "get_weather",
        description: "Fetch weather",
        parameters: {
          type: "object",
          properties: {
            location: { type: "string" },
          },
          required: ["location"],
        },
      },
    ]),
    [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Fetch weather",
          parameters: {
            type: "object",
            properties: {
              location: { type: "string" },
            },
            required: ["location"],
          },
        },
      },
    ],
  );
});

test("converts nested function tools to Ollama tools", () => {
  assert.deepEqual(
    normalizeOllamaTools([
      {
        type: "function",
        function: {
          name: "read_file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
          },
        },
      },
    ]),
    [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" },
            },
          },
        },
      },
    ],
  );
});

test("converts hosted search tools to emulated Ollama tools", () => {
  assert.deepEqual(
    normalizeOllamaTools([
      { type: "web_search" },
      { type: "tool_search" },
      { type: "web_search_preview" },
    ]).map((tool) => tool.function.name),
    ["web_search", "tool_search"],
  );
});

test("reports emulated web search as ready when command exists", async () => {
  const original = process.env.HYDRA_WEB_SEARCH_COMMAND;
  process.env.HYDRA_WEB_SEARCH_COMMAND = "/bin/echo --fake-search";
  try {
    assert.deepEqual(await emulatedToolStatuses(), [
      { name: "web_search", status: "ready", detail: undefined },
      { name: "tool_search", status: "ready" },
    ]);
  } finally {
    restoreEnv("HYDRA_WEB_SEARCH_COMMAND", original);
  }
});

test("reports emulated web search as unavailable when command is missing", async () => {
  const original = process.env.HYDRA_WEB_SEARCH_COMMAND;
  process.env.HYDRA_WEB_SEARCH_COMMAND = "/definitely/missing/hydra-search";
  try {
    assert.deepEqual(await emulatedToolStatuses(), [
      { name: "web_search", status: "unavailable", detail: "no executable search command found" },
      { name: "tool_search", status: "ready" },
    ]);
  } finally {
    restoreEnv("HYDRA_WEB_SEARCH_COMMAND", original);
  }
});

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
