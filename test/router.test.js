import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer, connect as connectNet } from "node:net";
import { once } from "node:events";
import { zstdCompressSync } from "node:zlib";
import {
  buildOllamaChatBody,
  createHydraHandler,
  decodeBody,
  emulatedToolStatuses,
  normalizeOllamaTools,
  normalizeResponsesInput,
  upstreamResponsesUrl,
} from "../src/router.js";

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

test("rejects websocket upgrades for unknown paths", () => {
  const writes = [];
  const socket = {
    write(chunk) {
      writes.push(chunk);
    },
    destroy() {
      this.destroyed = true;
    },
  };
  const handler = createHydraHandler({
    paths: {},
    ollamaBaseUrl: "http://127.0.0.1:11434",
    openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
  });

  handler.handleUpgrade({ method: "GET", url: "/unknown", headers: {} }, socket);

  assert.equal(writes.join(""), "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
  assert.equal(socket.destroyed, true);
});

test("proxies websocket upgrades for /responses to the cloud upstream", async () => {
  let upstreamRequest = "";
  const upstream = createNetServer((socket) => {
    socket.on("data", (chunk) => {
      upstreamRequest += chunk.toString("utf8");
      if (upstreamRequest.includes("\r\n\r\n")) {
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n" +
            "Connection: Upgrade\r\n" +
            "Upgrade: websocket\r\n" +
            "\r\n",
        );
      }
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamPort = upstream.address().port;

  const handler = createHydraHandler({
    paths: {},
    ollamaBaseUrl: "http://127.0.0.1:11434",
    openaiBaseUrl: `http://127.0.0.1:${upstreamPort}/backend-api/codex`,
    apiKey: "test-key",
  });
  const hydra = createHttpServer(handler);
  hydra.on("upgrade", handler.handleUpgrade);
  hydra.listen(0, "127.0.0.1");
  await once(hydra, "listening");
  const hydraPort = hydra.address().port;

  const client = connectNet({ host: "127.0.0.1", port: hydraPort });
  await once(client, "connect");
  client.write(
    "GET /responses HTTP/1.1\r\n" +
      `Host: 127.0.0.1:${hydraPort}\r\n` +
      "Connection: Upgrade\r\n" +
      "Upgrade: websocket\r\n" +
      "Sec-WebSocket-Key: dGVzdGtleQ==\r\n" +
      "Sec-WebSocket-Version: 13\r\n" +
      "OpenAI-Beta: responses_websockets=2026-02-06\r\n" +
      "\r\n",
  );

  const [response] = await once(client, "data");
  assert.match(response.toString("utf8"), /^HTTP\/1\.1 101 Switching Protocols/);
  assert.match(upstreamRequest, /^GET \/backend-api\/codex\/responses HTTP\/1\.1\r\n/);
  assert.match(upstreamRequest, new RegExp(`host: 127\\.0\\.0\\.1:${upstreamPort}`, "i"));
  assert.match(upstreamRequest, /authorization: Bearer test-key/i);
  assert.match(upstreamRequest, /openai-beta: responses_websockets=2026-02-06/i);
  assert.match(upstreamRequest, /sec-websocket-key: dGVzdGtleQ==/i);

  client.destroy();
  hydra.close();
  upstream.close();
  await Promise.allSettled([once(hydra, "close"), once(upstream, "close")]);
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

test("converts base64 Responses image inputs to Ollama images", () => {
  assert.deepEqual(
    normalizeResponsesInput(
      [
        {
          role: "user",
          content: [
            { type: "input_text", text: "describe this" },
            { type: "input_image", image_url: "data:image/png;base64,abc123" },
          ],
        },
      ],
      { allowImages: true },
    ),
    [{ role: "user", content: "describe this", images: ["abc123"] }],
  );
});

test("rejects image inputs when Ollama route does not support vision", () => {
  assert.throws(
    () =>
      normalizeResponsesInput(
        [
          {
            role: "user",
            content: [{ type: "input_image", image_url: "data:image/png;base64,abc123" }],
          },
        ],
        { allowImages: false },
      ),
    /does not advertise vision support/,
  );
});

test("rejects unsupported image references instead of dropping them", () => {
  assert.throws(
    () =>
      normalizeResponsesInput(
        [
          {
            role: "user",
            content: [{ type: "input_image", file_id: "file_123" }],
          },
        ],
        { allowImages: true },
      ),
    /expected a base64 string or data URL image/,
  );
});

test("maps non-none reasoning effort to Ollama think for thinking routes", () => {
  const body = buildOllamaChatBody({
    body: {
      model: "ollama/thinking",
      input: "think briefly",
      reasoning: { effort: "medium" },
    },
    route: { upstreamModel: "thinking", capabilities: { thinking: true, tools: true } },
    stream: false,
  });

  assert.equal(body.think, true);
});

test("does not send Ollama think for none reasoning effort", () => {
  const body = buildOllamaChatBody({
    body: {
      model: "ollama/thinking",
      input: "answer directly",
      reasoning: { effort: "none" },
    },
    route: { upstreamModel: "thinking", capabilities: { thinking: true, tools: true } },
    stream: false,
  });

  assert.equal("think" in body, false);
});

test("omits Ollama tools when route capabilities do not support tools", () => {
  const body = buildOllamaChatBody({
    body: {
      model: "ollama/plain",
      input: "hello",
      tools: [{ type: "web_search" }],
    },
    route: { upstreamModel: "plain", capabilities: { tools: false } },
    stream: false,
  });

  assert.equal("tools" in body, false);
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
