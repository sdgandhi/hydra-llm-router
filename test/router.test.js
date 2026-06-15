import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { connect as connectNet } from "node:net";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

test("rejects /responses websocket upgrades so Codex falls back to HTTP routing", async () => {
  const handler = createHydraHandler({
    paths: {},
    ollamaBaseUrl: "http://127.0.0.1:11434",
    openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
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
  assert.match(response.toString("utf8"), /^HTTP\/1\.1 426 Upgrade Required/);

  client.destroy();
  hydra.close();
  await Promise.allSettled([once(hydra, "close")]);
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

test("routes local app tool calls through the App Server bridge", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "hydra-router-test-"));
  const routesPath = join(tempDir, "routes.json");
  await writeFile(
    routesPath,
    JSON.stringify({
      "ollama/tool-model": {
        provider: "ollama",
        upstreamModel: "tool-model",
        capabilities: { tools: true },
      },
    }),
  );

  const appTool = {
    type: "function",
    function: {
      name: "gmail_search_emails",
      description: "Search Gmail",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    },
    _hydraAppTool: { server: "codex_apps" },
  };
  const bridgeCalls = [];
  const appServerBridge = {
    async getTools() {
      return [appTool];
    },
    async callTool(call) {
      bridgeCalls.push(call);
      return JSON.stringify({ messages: [{ subject: "Latest email" }] });
    },
  };
  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  let hydra = null;
  globalThis.fetch = async (url, options) => {
    fetchCalls.push(JSON.parse(options.body));
    const body =
      fetchCalls.length === 1
        ? ndjsonStream([
            {
              message: {
                tool_calls: [
                  {
                    function: {
                      name: "gmail_search_emails",
                      arguments: { query: "-in:spam -in:trash", max_results: 3 },
                    },
                  },
                ],
              },
              done: true,
            },
          ])
        : ndjsonStream([{ message: { content: "Latest email" }, done: true }]);
    return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
  };

  try {
    const handler = createHydraHandler({
      paths: { routesPath },
      ollamaBaseUrl: "http://127.0.0.1:11434",
      openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
      appServerBridge,
    });
    hydra = createHttpServer(handler);
    hydra.listen(0, "127.0.0.1");
    await once(hydra, "listening");

    const response = await originalFetch(`http://127.0.0.1:${hydra.address().port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "ollama/tool-model",
        stream: true,
        input: "latest emails",
        tools: [{ type: "tool_search" }],
      }),
    });
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(text, /Latest email/);
    assert.equal(fetchCalls[0].tools.some((tool) => tool.function.name === "gmail_search_emails"), true);
    assert.deepEqual(bridgeCalls, [
      {
        name: "gmail_search_emails",
        argumentsText: JSON.stringify({ query: "-in:spam -in:trash", max_results: 3 }),
      },
    ]);
    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[1].messages.at(-1).role, "tool");
  } finally {
    if (hydra?.listening) {
      hydra.close();
      await Promise.allSettled([once(hydra, "close")]);
    }
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("routes non-streaming local app tool calls back through Ollama", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "hydra-router-test-"));
  const routesPath = join(tempDir, "routes.json");
  await writeFile(
    routesPath,
    JSON.stringify({
      "ollama/tool-model": {
        provider: "ollama",
        upstreamModel: "tool-model",
        capabilities: { tools: true },
      },
    }),
  );

  const appServerBridge = {
    async getTools() {
      return [
        {
          type: "function",
          function: {
            name: "gmail_search_emails",
            description: "Search Gmail",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
          _hydraAppTool: { server: "codex_apps" },
        },
      ];
    },
    async callTool() {
      return JSON.stringify({ messages: [{ subject: "Latest email" }] });
    },
  };
  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  let hydra = null;
  globalThis.fetch = async (url, options) => {
    fetchCalls.push(JSON.parse(options.body));
    const body =
      fetchCalls.length === 1
        ? {
            message: {
              tool_calls: [
                {
                  function: {
                    name: "gmail_search_emails",
                    arguments: { query: "newer_than:1d" },
                  },
                },
              ],
            },
          }
        : { message: { content: "Latest email" }, prompt_eval_count: 1, eval_count: 2 };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };

  try {
    const handler = createHydraHandler({
      paths: { routesPath },
      ollamaBaseUrl: "http://127.0.0.1:11434",
      openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
      appServerBridge,
    });
    hydra = createHttpServer(handler);
    hydra.listen(0, "127.0.0.1");
    await once(hydra, "listening");

    const response = await originalFetch(`http://127.0.0.1:${hydra.address().port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "ollama/tool-model",
        stream: false,
        input: "latest emails",
      }),
    });
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[1].messages.at(-1).role, "tool");
    assert.equal(json.output[0].content[0].text, "Latest email");
  } finally {
    if (hydra?.listening) {
      hydra.close();
      await Promise.allSettled([once(hydra, "close")]);
    }
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
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

function ndjsonStream(events) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      controller.close();
    },
  });
}
