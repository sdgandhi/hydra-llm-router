import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { connect as connectNet } from "node:net";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zstdCompressSync } from "node:zlib";
import {
  buildOllamaChatBody,
  buildLMStudioChatBody,
  createLocalControlMarkerFilter,
  createHydraHandler,
  decodeBody,
  emulatedToolStatuses,
  normalizeOllamaTools,
  normalizeResponsesInput,
  stripLocalControlMarkers,
  upstreamResponsesUrl,
} from "../src/router.js";
import { configureDebugLog } from "../src/debug.js";
import { createHydraTelemetry } from "../src/metron/hydra.js";

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

test("rejects upstream state references on local routes", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "hydra-state-local-"));
  const routesPath = join(tempDir, "routes.json");
  await writeFile(routesPath, JSON.stringify({
    "ollama/tiny": { provider: "ollama", upstreamModel: "tiny", capabilities: {} },
  }));
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    throw new Error("local state request must not reach upstream");
  };
  let hydra;
  try {
    const handler = createHydraHandler({
      paths: { routesPath },
      ollamaBaseUrl: "http://127.0.0.1:11434",
      lmStudioBaseUrl: "http://127.0.0.1:11239",
      openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
    });
    hydra = createHttpServer(handler);
    hydra.listen(0, "127.0.0.1");
    await once(hydra, "listening");
    const endpoint = `http://127.0.0.1:${hydra.address().port}/responses`;

    for (const state of [{ previous_response_id: "resp_cloud" }, { conversation: "conv_cloud" }]) {
      const response = await originalFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "ollama/tiny", input: "continue", ...state }),
      });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(body.error.code, "unsupported_state_reference");
      assert.match(body.error.message, /complete history in input/);
    }
    assert.equal(upstreamCalls, 0);
  } finally {
    if (hydra?.listening) {
      hydra.close();
      await Promise.allSettled([once(hydra, "close")]);
    }
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("accepts Codex-style stateless follow-ups containing complete history", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "hydra-stateless-history-"));
  const routesPath = join(tempDir, "routes.json");
  await writeFile(routesPath, JSON.stringify({
    "lmstudio/tiny": { provider: "lmstudio", upstreamModel: "tiny", capabilities: {} },
  }));
  const originalFetch = globalThis.fetch;
  let upstreamBody;
  globalThis.fetch = async (_url, options) => {
    upstreamBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "four" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  let hydra;
  try {
    const handler = createHydraHandler({
      paths: { routesPath },
      ollamaBaseUrl: "http://127.0.0.1:11434",
      lmStudioBaseUrl: "http://127.0.0.1:11239",
      openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
    });
    hydra = createHttpServer(handler);
    hydra.listen(0, "127.0.0.1");
    await once(hydra, "listening");
    const input = [
      { role: "user", content: "What is two plus two?" },
      { role: "assistant", content: "It is 4." },
      { role: "user", content: "Spell that number." },
    ];
    const response = await originalFetch(`http://127.0.0.1:${hydra.address().port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "session-id": "stateless-codex-session" },
      body: JSON.stringify({ model: "lmstudio/tiny", input, stream: false }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(upstreamBody.messages, input);
    assert.equal("previous_response_id" in upstreamBody, false);
    assert.equal("conversation" in upstreamBody, false);
  } finally {
    if (hydra?.listening) {
      hydra.close();
      await Promise.allSettled([once(hydra, "close")]);
    }
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("emits privacy-safe Metron events for a direct Hydra response", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "hydra-metron-direct-"));
  const routesPath = join(tempDir, "routes.json");
  await writeFile(routesPath, JSON.stringify({
    "lmstudio/tiny": { provider: "lmstudio", upstreamModel: "tiny", capabilities: {} },
  }));
  const events = [];
  const telemetry = createHydraTelemetry({
    store: { async emit(event) { events.push(event); } },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{ message: { content: "private answer" } }],
    usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 },
  }), { status: 200, headers: { "content-type": "application/json" } });
  let hydra;
  try {
    const handler = createHydraHandler({
      paths: { routesPath },
      ollamaBaseUrl: "http://127.0.0.1:11434",
      lmStudioBaseUrl: "http://127.0.0.1:11239",
      openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
      telemetry,
    });
    hydra = createHttpServer(handler);
    hydra.listen(0, "127.0.0.1");
    await once(hydra, "listening");
    const response = await originalFetch(`http://127.0.0.1:${hydra.address().port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "session-id": "metron-session" },
      body: JSON.stringify({ model: "lmstudio/tiny", input: "private prompt", stream: false }),
    });
    assert.equal(response.status, 200);
    await telemetry.flush();
    assert.deepEqual(events.map((event) => event.type), ["generation.started", "generation.completed"]);
    assert.equal(events[1].data.usage.total_tokens, 9);
    assert.doesNotMatch(JSON.stringify(events), /private prompt|private answer/);
  } finally {
    if (hydra?.listening) {
      hydra.close();
      await Promise.allSettled([once(hydra, "close")]);
    }
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("strips local-model channel control markers", () => {
  assert.equal(stripLocalControlMarkers("<|channel>thought\n<channel|>Hello"), "Hello");
  assert.equal(stripLocalControlMarkers("Before <|channel|>analysis<|message|>after"), "Before after");
});

test("strips local-model control markers split across streaming chunks", () => {
  const filter = createLocalControlMarkerFilter();
  const output = ["prefix ", "<|chan", "nel>thought\n<chan", "nel|>", "suffix"]
    .map((chunk) => filter.push(chunk))
    .join("") + filter.finish();

  assert.equal(output, "prefix suffix");
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

test("flattens Codex namespace tools for local providers", () => {
  assert.deepEqual(
    normalizeOllamaTools([
      {
        type: "namespace",
        name: "functions",
        tools: [
          {
            name: "exec_command",
            description: "Run a command",
            parameters: {
              type: "object",
              properties: { cmd: { type: "string" } },
              required: ["cmd"],
            },
          },
        ],
      },
    ]),
    [
      {
        type: "function",
        function: {
          name: "exec_command",
          description: "Run a command",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string" } },
            required: ["cmd"],
          },
        },
      },
    ],
  );
});

test("wraps Responses custom tools for local function calling", () => {
  assert.deepEqual(
    normalizeOllamaTools([
      {
        type: "custom",
        name: "apply_patch",
        description: "Apply a patch",
        format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
      },
    ]),
    [
      {
        type: "function",
        function: {
          name: "apply_patch",
          description: "Apply a patch",
          parameters: {
            type: "object",
            properties: { input: { type: "string", description: "Free-form input for this tool." } },
            required: ["input"],
          },
        },
        _hydraResponseTool: { type: "custom" },
      },
    ],
  );
});

test("does not advertise request_user_input to local models in Default mode", () => {
  const body = {
    input: [
      {
        role: "developer",
        content: [
          {
            type: "input_text",
            text: "<collaboration_mode>\n# Collaboration Mode: Default\n</collaboration_mode>",
          },
        ],
      },
    ],
    tools: [
      { type: "function", name: "request_user_input" },
      { type: "function", name: "exec_command" },
    ],
  };

  const lmStudio = buildLMStudioChatBody({ body, route: { upstreamModel: "gemma" }, stream: true });
  const ollama = buildOllamaChatBody({ body, route: { upstreamModel: "gemma" }, stream: true });

  assert.deepEqual(lmStudio.tools.map((tool) => tool.function.name), ["exec_command"]);
  assert.deepEqual(ollama.tools.map((tool) => tool.function.name), ["exec_command"]);
});

test("does not advertise request_user_input when collaboration mode is omitted", () => {
  const body = {
    input: [{ role: "user", content: "Run a command" }],
    tools: [
      { type: "function", name: "request_user_input" },
      { type: "function", name: "exec_command" },
    ],
  };

  const lmStudio = buildLMStudioChatBody({ body, route: { upstreamModel: "gemma" }, stream: true });
  const ollama = buildOllamaChatBody({ body, route: { upstreamModel: "gemma" }, stream: true });

  assert.deepEqual(lmStudio.tools.map((tool) => tool.function.name), ["exec_command"]);
  assert.deepEqual(ollama.tools.map((tool) => tool.function.name), ["exec_command"]);
});

test("preserves request_user_input for local models in Plan mode", () => {
  const body = {
    input: [
      {
        role: "developer",
        content: [
          {
            type: "input_text",
            text: "<collaboration_mode>\n# Collaboration Mode: Plan\n</collaboration_mode>",
          },
        ],
      },
    ],
    tools: [{ type: "function", name: "request_user_input" }],
  };

  const request = buildLMStudioChatBody({ body, route: { upstreamModel: "gemma" }, stream: true });

  assert.deepEqual(request.tools.map((tool) => tool.function.name), ["request_user_input"]);
});

test("does not advertise unsupported search tools to LM Studio", () => {
  const body = {
    tools: [
      { type: "function", name: "exec_command" },
      { type: "web_search" },
      { type: "web_search_preview" },
      { type: "tool_search" },
    ],
  };

  const request = buildLMStudioChatBody({ body, route: { upstreamModel: "gemma" }, stream: true });

  assert.deepEqual(request.tools.map((tool) => tool.function.name), ["exec_command"]);
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

test("converts Responses requests to LM Studio chat completions", () => {
  assert.deepEqual(
    buildLMStudioChatBody({
      body: {
        model: "lmstudio/qwen3-4b",
        input: "hello",
        instructions: "Be concise.",
        max_output_tokens: 100,
        tools: [{ type: "function", name: "get_weather", parameters: { type: "object" } }],
      },
      route: { upstreamModel: "qwen3-4b", capabilities: { tools: true } },
      stream: true,
    }),
    {
      model: "qwen3-4b",
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: "hello" },
      ],
      stream: true,
      temperature: undefined,
      top_p: undefined,
      max_tokens: 100,
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "",
            parameters: { type: "object" },
          },
        },
      ],
    },
  );
});

test("disables LM Studio chat-template thinking for all supported none reasoning inputs", () => {
  for (const reasoning of [
    { reasoning: { effort: "none" } },
    { reasoning_effort: "NONE" },
    { reasoning_level: " none " },
  ]) {
    const request = buildLMStudioChatBody({
      body: { input: "answer directly", ...reasoning },
      route: { upstreamModel: "gemma", capabilities: { thinking: true } },
      stream: true,
    });
    assert.deepEqual(request.chat_template_kwargs, { enable_thinking: false });
    assert.equal(request.reasoning_effort, "none");
  }
});

test("maps the Desktop-visible LM Studio low effort to thinking off", () => {
  const request = buildLMStudioChatBody({
    body: { input: "answer directly", reasoning: { effort: "low" } },
    route: { upstreamModel: "gemma", capabilities: { thinking: false } },
    stream: false,
  });

  assert.deepEqual(request.chat_template_kwargs, { enable_thinking: false });
  assert.equal(request.reasoning_effort, "none");
});

test("enables LM Studio chat-template thinking for non-none effort on thinking routes", () => {
  const request = buildLMStudioChatBody({
    body: { input: "reason", reasoning_effort: "medium" },
    route: { upstreamModel: "gemma", capabilities: { thinking: true } },
    stream: false,
  });

  assert.deepEqual(request.chat_template_kwargs, { enable_thinking: true });
  assert.equal(request.reasoning_effort, "medium");
});

test("omits LM Studio thinking configuration when reasoning is omitted", () => {
  const request = buildLMStudioChatBody({
    body: { input: "hello" },
    route: { upstreamModel: "gemma", capabilities: { thinking: true } },
    stream: false,
  });

  assert.equal("chat_template_kwargs" in request, false);
});

test("does not enable LM Studio thinking on routes without thinking capability", () => {
  const request = buildLMStudioChatBody({
    body: { input: "hello", reasoning_level: "high" },
    route: { upstreamModel: "plain", capabilities: { thinking: false } },
    stream: false,
  });

  assert.equal("chat_template_kwargs" in request, false);
});

test("converts Responses function-call history for LM Studio follow-up turns", () => {
  const request = buildLMStudioChatBody({
    body: {
      input: [
        { type: "function_call", call_id: "call_1", name: "get_weather", arguments: '{"city":"Boston"}' },
        { type: "function_call_output", call_id: "call_1", output: "Sunny" },
      ],
    },
    route: { upstreamModel: "qwen3-4b", capabilities: { tools: true } },
    stream: false,
  });

  assert.deepEqual(request.messages, [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Boston"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_1", content: "Sunny" },
  ]);
});

test("routes streaming LM Studio chat completions as Responses events", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "hydra-router-test-"));
  const routesPath = join(tempDir, "routes.json");
  await writeFile(
    routesPath,
    JSON.stringify({
      "lmstudio/qwen3-4b": {
        provider: "lmstudio",
        upstreamModel: "qwen3-4b",
        capabilities: { tools: true, vision: false },
      },
    }),
  );
  const originalFetch = globalThis.fetch;
  let upstreamRequest;
  let hydra;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "http://127.0.0.1:11239/v1/chat/completions");
    upstreamRequest = JSON.parse(options.body);
    return new Response(
      'data: {"choices":[{"delta":{"content":"hello "}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"locally"},"finish_reason":"stop"}]}\n\n' +
        "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };

  try {
    const handler = createHydraHandler({
      paths: { routesPath },
      ollamaBaseUrl: "http://127.0.0.1:11434",
      lmStudioBaseUrl: "http://127.0.0.1:11239",
      openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
    });
    hydra = createHttpServer(handler);
    hydra.listen(0, "127.0.0.1");
    await once(hydra, "listening");

    const response = await originalFetch(`http://127.0.0.1:${hydra.address().port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "lmstudio/qwen3-4b", input: "hello", stream: true }),
    });
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.equal(upstreamRequest.model, "qwen3-4b");
    assert.equal(upstreamRequest.stream, true);
    assert.match(text, /hello /);
    assert.match(text, /locally/);
    assert.match(text, /response\.completed/);
  } finally {
    if (hydra?.listening) {
      hydra.close();
      await Promise.allSettled([once(hydra, "close")]);
    }
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("routes authenticated OMLX chat completions as Responses responses", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "hydra-omlx-router-test-"));
  const routesPath = join(tempDir, "routes.json");
  await writeFile(routesPath, JSON.stringify({
    "omlx/gemma": {
      provider: "omlx",
      upstreamModel: "gemma",
      capabilities: { tools: true, vision: true },
    },
  }));
  const originalFetch = globalThis.fetch;
  let upstreamRequest;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "http://127.0.0.1:8000/v1/chat/completions");
    assert.equal(options.headers.authorization, "Bearer omlx-secret");
    upstreamRequest = JSON.parse(options.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: "hello from omlx" } }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  let hydra;
  try {
    const handler = createHydraHandler({
      paths: { routesPath },
      ollamaBaseUrl: "http://127.0.0.1:11434",
      lmStudioBaseUrl: "http://127.0.0.1:11239",
      omlxBaseUrl: "http://127.0.0.1:8000",
      omlxApiKey: "omlx-secret",
      openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
    });
    hydra = createHttpServer(handler);
    hydra.listen(0, "127.0.0.1");
    await once(hydra, "listening");

    const response = await originalFetch(`http://127.0.0.1:${hydra.address().port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "omlx/gemma", input: "hello", stream: false }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(upstreamRequest.model, "gemma");
    assert.equal("request_id" in upstreamRequest, false);
    assert.equal(body.output[0].content[0].text, "hello from omlx");
    assert.deepEqual(body.usage, { input_tokens: 2, output_tokens: 3, total_tokens: 5 });
  } finally {
    if (hydra?.listening) {
      hydra.close();
      await Promise.allSettled([once(hydra, "close")]);
    }
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("emits the first LM Studio text delta before the upstream stream completes", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "hydra-router-test-"));
  const routesPath = join(tempDir, "routes.json");
  await writeFile(
    routesPath,
    JSON.stringify({
      "lmstudio/gemma": {
        provider: "lmstudio",
        upstreamModel: "gemma",
        capabilities: { thinking: true },
      },
    }),
  );
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  let finishUpstream;
  let upstreamFinished = false;
  globalThis.fetch = async (_url, options) => {
    assert.equal(JSON.parse(options.body).stream, true);
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"first"}}]}\n\n'));
          finishUpstream = () => {
            upstreamFinished = true;
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" second"}}]}\n\n'));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          };
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  let hydra;
  try {
    const handler = createHydraHandler({
      paths: { routesPath },
      ollamaBaseUrl: "http://127.0.0.1:11434",
      lmStudioBaseUrl: "http://127.0.0.1:11239",
      openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
    });
    hydra = createHttpServer(handler);
    hydra.listen(0, "127.0.0.1");
    await once(hydra, "listening");

    const response = await originalFetch(`http://127.0.0.1:${hydra.address().port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "lmstudio/gemma", input: "hi", stream: true }),
    });
    const reader = response.body.getReader();
    let received = "";
    while (!received.includes("response.output_text.delta")) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      received += new TextDecoder().decode(value);
    }
    assert.equal(upstreamFinished, false);
    assert.match(received, /first/);

    finishUpstream();
    while (!(await reader.read()).done) {}
  } finally {
    if (hydra?.listening) {
      hydra.close();
      await Promise.allSettled([once(hydra, "close")]);
    }
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reasoning none suppresses LM Studio reasoning events while preserving completion", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "hydra-router-test-"));
  const routesPath = join(tempDir, "routes.json");
  await writeFile(
    routesPath,
    JSON.stringify({
      "lmstudio/gemma": { provider: "lmstudio", upstreamModel: "gemma", capabilities: { thinking: true } },
    }),
  );
  const originalFetch = globalThis.fetch;
  let upstreamRequest;
  let hydra;
  globalThis.fetch = async (_url, options) => {
    upstreamRequest = JSON.parse(options.body);
    return new Response(
      'data: {"choices":[{"delta":{"reasoning_content":"hidden"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n' +
        "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  try {
    const handler = createHydraHandler({
      paths: { routesPath },
      ollamaBaseUrl: "http://127.0.0.1:11434",
      lmStudioBaseUrl: "http://127.0.0.1:11239",
      openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
    });
    hydra = createHttpServer(handler);
    hydra.listen(0, "127.0.0.1");
    await once(hydra, "listening");
    const response = await originalFetch(`http://127.0.0.1:${hydra.address().port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "lmstudio/gemma",
        input: "hi",
        stream: true,
        reasoning: { effort: "none" },
      }),
    });
    const text = await response.text();
    assert.deepEqual(upstreamRequest.chat_template_kwargs, { enable_thinking: false });
    assert.doesNotMatch(text, /reasoning_summary/);
    assert.match(text, /response\.output_text\.delta/);
    assert.match(text, /response\.completed/);
    assert.match(text, /data: \[DONE\]/);
  } finally {
    if (hydra?.listening) {
      hydra.close();
      await Promise.allSettled([once(hydra, "close")]);
    }
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("disconnecting a streaming client aborts LM Studio without attempting a 500 response", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "hydra-router-test-"));
  const routesPath = join(tempDir, "routes.json");
  await writeFile(
    routesPath,
    JSON.stringify({
      "lmstudio/gemma": { provider: "lmstudio", upstreamModel: "gemma", capabilities: { thinking: true } },
    }),
  );
  const originalFetch = globalThis.fetch;
  const statuses = [];
  let upstreamSignal;
  let upstreamRequest;
  let upstreamAborted = false;
  let resolveUpstreamAbort;
  const upstreamAbort = new Promise((resolve) => {
    resolveUpstreamAbort = resolve;
  });
  let hydra;
  globalThis.fetch = async (_url, options) => {
    upstreamSignal = options.signal;
    upstreamRequest = JSON.parse(options.body);
    return new Response(
      new ReadableStream({
        start(controller) {
          options.signal.addEventListener(
            "abort",
            () => {
              upstreamAborted = true;
              resolveUpstreamAbort();
              controller.error(options.signal.reason);
            },
            { once: true },
          );
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  try {
    const handler = createHydraHandler({
      paths: { routesPath },
      ollamaBaseUrl: "http://127.0.0.1:11434",
      lmStudioBaseUrl: "http://127.0.0.1:11239",
      openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
    });
    hydra = createHttpServer((req, res) => {
      const writeHead = res.writeHead;
      res.writeHead = function recordStatus(status, ...args) {
        statuses.push(status);
        return writeHead.call(this, status, ...args);
      };
      return handler(req, res);
    });
    hydra.listen(0, "127.0.0.1");
    await once(hydra, "listening");

    await new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port: hydra.address().port,
          path: "/responses",
          method: "POST",
          headers: { "content-type": "application/json" },
        },
        (response) => {
          response.once("data", () => {
            response.destroy();
            request.destroy();
            resolve();
          });
        },
      );
      request.once("error", (error) => {
        if (error.code === "ECONNRESET") resolve();
        else reject(error);
      });
      request.end(JSON.stringify({ model: "lmstudio/gemma", input: "hi", stream: true }));
    });
    await Promise.race([
      upstreamAbort,
      new Promise((_, reject) => setTimeout(() => reject(new Error("upstream abort timed out")), 1000)),
    ]);

    assert.equal(upstreamSignal instanceof AbortSignal, true);
    assert.equal(upstreamSignal.aborted, true);
    assert.equal(upstreamAborted, true);
    assert.match(upstreamRequest.request_id, /^hydra-[0-9a-f-]{36}$/);
    assert.deepEqual(statuses, [200]);
  } finally {
    if (hydra?.listening) {
      hydra.close();
      await Promise.allSettled([once(hydra, "close")]);
    }
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("normal completion leaves the request-scoped upstream signal un-aborted", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "hydra-router-test-"));
  const routesPath = join(tempDir, "routes.json");
  await writeFile(
    routesPath,
    JSON.stringify({
      "lmstudio/gemma": { provider: "lmstudio", upstreamModel: "gemma", capabilities: {} },
    }),
  );
  const originalFetch = globalThis.fetch;
  let upstreamSignal;
  let hydra;
  globalThis.fetch = async (_url, options) => {
    upstreamSignal = options.signal;
    return new Response(
      'data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };
  try {
    const handler = createHydraHandler({
      paths: { routesPath },
      ollamaBaseUrl: "http://127.0.0.1:11434",
      lmStudioBaseUrl: "http://127.0.0.1:11239",
      openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
    });
    hydra = createHttpServer(handler);
    hydra.listen(0, "127.0.0.1");
    await once(hydra, "listening");
    const response = await originalFetch(`http://127.0.0.1:${hydra.address().port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "lmstudio/gemma", input: "hi", stream: true }),
    });
    await response.text();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(upstreamSignal.aborted, false);
  } finally {
    if (hydra?.listening) {
      hydra.close();
      await Promise.allSettled([once(hydra, "close")]);
    }
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("Ollama and OpenAI forwarding receive request-scoped abort signals", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "hydra-router-test-"));
  const routesPath = join(tempDir, "routes.json");
  await writeFile(
    routesPath,
    JSON.stringify({
      "ollama/plain": { provider: "ollama", upstreamModel: "plain", capabilities: {} },
      "gpt-cloud": { provider: "openai", upstreamModel: "gpt-cloud" },
    }),
  );
  const originalFetch = globalThis.fetch;
  const signals = [];
  let hydra;
  globalThis.fetch = async (url, options) => {
    signals.push({ url: String(url), signal: options.signal });
    if (String(url).endsWith("/api/chat")) {
      return new Response(JSON.stringify({ message: { content: "local" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ id: "resp_cloud", status: "completed", output: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const handler = createHydraHandler({
      paths: { routesPath },
      ollamaBaseUrl: "http://127.0.0.1:11434",
      lmStudioBaseUrl: "http://127.0.0.1:11239",
      openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
    });
    hydra = createHttpServer(handler);
    hydra.listen(0, "127.0.0.1");
    await once(hydra, "listening");

    for (const model of ["ollama/plain", "gpt-cloud"]) {
      const response = await originalFetch(`http://127.0.0.1:${hydra.address().port}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: "hi", stream: false }),
      });
      assert.equal(response.status, 200);
      await response.text();
    }
    assert.equal(signals.length, 2);
    assert.equal(signals.every(({ signal }) => signal instanceof AbortSignal && !signal.aborted), true);
  } finally {
    if (hydra?.listening) {
      hydra.close();
      await Promise.allSettled([once(hydra, "close")]);
    }
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
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
    const body = fetchCalls.length === 1
      ? ndjsonStream([{
          message: {
            tool_calls: [{ function: { name: "tool_search", arguments: { query: "gmail search emails" } } }],
          },
          done: true,
        }])
      : fetchCalls.length === 2
        ? ndjsonStream([{
            message: {
              tool_calls: [{
                function: {
                  name: "gmail_search_emails",
                  arguments: { query: "-in:spam -in:trash", max_results: 3 },
                },
              }],
            },
            done: true,
          }])
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
    assert.equal(fetchCalls[0].tools.some((tool) => tool.function.name === "tool_search"), true);
    assert.equal(fetchCalls[0].tools.some((tool) => tool.function.name === "gmail_search_emails"), false);
    assert.equal(fetchCalls[1].tools.some((tool) => tool.function.name === "gmail_search_emails"), true);
    assert.deepEqual(bridgeCalls, [
      {
        name: "gmail_search_emails",
        argumentsText: JSON.stringify({ query: "-in:spam -in:trash", max_results: 3 }),
      },
    ]);
    assert.equal(fetchCalls.length, 3);
    assert.equal(fetchCalls[2].messages.at(-1).role, "tool");
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

test("routes streaming LM Studio plugin calls through the App Server bridge", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "hydra-router-test-"));
  const routesPath = join(tempDir, "routes.json");
  await writeFile(
    routesPath,
    JSON.stringify({
      "lmstudio/tool-model": {
        provider: "lmstudio",
        upstreamModel: "tool-model",
        capabilities: { tools: true },
      },
    }),
  );

  const bridgeCalls = [];
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
    async callTool(call) {
      bridgeCalls.push(call);
      return JSON.stringify({ messages: [{ subject: "Latest email" }] });
    },
  };
  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  let hydra;
  globalThis.fetch = async (_url, options) => {
    fetchCalls.push(JSON.parse(options.body));
    const responseBody = fetchCalls.length === 1
      ? 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_search_1","function":{"name":"tool_search","arguments":"{\\"query\\":\\"gmail search emails\\"}"}}]}}]}\n\n' +
        "data: [DONE]\n\n"
      : fetchCalls.length === 2
        ? 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_lm_1","function":{"name":"gmail_search_emails","arguments":"{\\"query\\":\\"newer_than:1d\\"}"}}]}}]}\n\n' +
          "data: [DONE]\n\n"
        : 'data: {"choices":[{"delta":{"content":"Latest email"}}]}\n\n' +
          "data: [DONE]\n\n";
    return new Response(responseBody, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  try {
    const handler = createHydraHandler({
      paths: { routesPath },
      ollamaBaseUrl: "http://127.0.0.1:11434",
      lmStudioBaseUrl: "http://127.0.0.1:11239",
      openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
      appServerBridge,
    });
    hydra = createHttpServer(handler);
    hydra.listen(0, "127.0.0.1");
    await once(hydra, "listening");

    const response = await originalFetch(`http://127.0.0.1:${hydra.address().port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "lmstudio/tool-model", input: "latest emails", stream: true }),
    });
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(text, /Latest email/);
    assert.equal(fetchCalls.length, 3);
    assert.equal(fetchCalls[0].tools.some((tool) => tool.function.name === "tool_search"), true);
    assert.equal(fetchCalls[0].tools.some((tool) => tool.function.name === "gmail_search_emails"), false);
    assert.equal(fetchCalls[1].tools.some((tool) => tool.function.name === "gmail_search_emails"), true);
    assert.equal(fetchCalls[2].messages.at(-2).tool_calls[0].id, "call_lm_1");
    assert.equal(fetchCalls[2].messages.at(-1).tool_call_id, "call_lm_1");
    assert.equal(bridgeCalls[0].name, "gmail_search_emails");
    assert.equal(bridgeCalls[0].argumentsText, '{"query":"newer_than:1d"}');
  } finally {
    if (hydra?.listening) {
      hydra.close();
      await Promise.allSettled([once(hydra, "close")]);
    }
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("returns LM Studio custom-tool calls in the Responses custom call shape", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "hydra-router-test-"));
  const routesPath = join(tempDir, "routes.json");
  await writeFile(
    routesPath,
    JSON.stringify({
      "lmstudio/tool-model": {
        provider: "lmstudio",
        upstreamModel: "tool-model",
        capabilities: { tools: true },
      },
    }),
  );

  const originalFetch = globalThis.fetch;
  let upstreamRequest;
  let hydra;
  globalThis.fetch = async (_url, options) => {
    upstreamRequest = JSON.parse(options.body);
    return new Response(
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"apply_patch","arguments":"{\\"input\\":\\"*** Begin Patch\\n*** End Patch\\"}"}}]}}]}\n\n' +
        "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };

  try {
    const handler = createHydraHandler({
      paths: { routesPath },
      ollamaBaseUrl: "http://127.0.0.1:11434",
      lmStudioBaseUrl: "http://127.0.0.1:11239",
      openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
    });
    hydra = createHttpServer(handler);
    hydra.listen(0, "127.0.0.1");
    await once(hydra, "listening");

    const response = await originalFetch(`http://127.0.0.1:${hydra.address().port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "lmstudio/tool-model",
        input: "patch it",
        stream: true,
        tools: [{ type: "custom", name: "apply_patch", description: "Apply a patch" }],
      }),
    });
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.equal(upstreamRequest.tools[0].function.name, "apply_patch");
    assert.equal(upstreamRequest.tools[0].function.parameters.required[0], "input");
    assert.match(text, /response\.custom_tool_call_input\.done/);
    assert.match(text, /"type":"custom_tool_call"/);
    assert.match(text, /\*\*\* Begin Patch/);
    assert.doesNotMatch(text, /"type":"function_call"/);
  } finally {
    if (hydra?.listening) {
      hydra.close();
      await Promise.allSettled([once(hydra, "close")]);
    }
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("wraps LM Studio exec command arguments as JavaScript custom-tool input", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "hydra-router-test-"));
  const routesPath = join(tempDir, "routes.json");
  await writeFile(
    routesPath,
    JSON.stringify({
      "lmstudio/tool-model": {
        provider: "lmstudio",
        upstreamModel: "tool-model",
        capabilities: { tools: true },
      },
    }),
  );

  const originalFetch = globalThis.fetch;
  let hydra;
  globalThis.fetch = async () => new Response(
    'data: {"choices":[{"delta":{"tool_calls":[' +
      '{"index":0,"function":{"name":"exec","arguments":"{\\"cmd\\":\\"ls -a\\",\\"workdir\\":\\"/tmp\\"}"}},' +
      '{"index":1,"function":{"name":"exec","arguments":"{\\"namespace\\":\\"functions.exec\\",\\"args\\":{\\"cmd\\":\\"pwd\\",\\"workdir\\":\\"/var/tmp\\"}}"}}' +
      ']}}]}\n\n' +
      "data: [DONE]\n\n",
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

  try {
    const handler = createHydraHandler({
      paths: { routesPath },
      ollamaBaseUrl: "http://127.0.0.1:11434",
      lmStudioBaseUrl: "http://127.0.0.1:11239",
      openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
    });
    hydra = createHttpServer(handler);
    hydra.listen(0, "127.0.0.1");
    await once(hydra, "listening");

    const response = await originalFetch(`http://127.0.0.1:${hydra.address().port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "lmstudio/tool-model",
        input: "list files",
        stream: true,
        tools: [{ type: "custom", name: "exec", description: "Run JavaScript" }],
      }),
    });
    const text = await response.text();
    const inputs = text
      .split("\n")
      .filter((line) => (
        line.startsWith("data: ") && line.includes('"type":"response.custom_tool_call_input.done"')
      ))
      .map((line) => JSON.parse(line.slice("data: ".length)).input);

    assert.equal(response.status, 200);
    assert.deepEqual(inputs, [
      'const r = await tools.exec_command({"cmd":"ls -a","workdir":"/tmp"}); text(r.output);',
      'const r = await tools.exec_command({"cmd":"pwd","workdir":"/var/tmp"}); text(r.output);',
    ]);
  } finally {
    if (hydra?.listening) {
      hydra.close();
      await Promise.allSettled([once(hydra, "close")]);
    }
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("emulates hosted web search inside non-streaming LM Studio turns", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "hydra-router-test-"));
  const routesPath = join(tempDir, "routes.json");
  await writeFile(
    routesPath,
    JSON.stringify({
      "lmstudio/tool-model": {
        provider: "lmstudio",
        upstreamModel: "tool-model",
        capabilities: { tools: true },
      },
    }),
  );

  const originalFetch = globalThis.fetch;
  const fetchCalls = [];
  let hydra;
  globalThis.fetch = async (_url, options) => {
    fetchCalls.push(JSON.parse(options.body));
    const responseBody = fetchCalls.length === 1
      ? {
          choices: [{
            message: {
              tool_calls: [{
                id: "call_search_1",
                type: "function",
                function: { name: "web_search", arguments: '{"query":"hydra router"}' },
              }],
            },
          }],
        }
      : { choices: [{ message: { content: "Search complete" } }] };
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const handler = createHydraHandler({
      paths: { routesPath },
      ollamaBaseUrl: "http://127.0.0.1:11434",
      lmStudioBaseUrl: "http://127.0.0.1:11239",
      openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
      webSearchCommands: [["/bin/echo", "HYDRA_SEARCH_RESULT"]],
    });
    hydra = createHttpServer(handler);
    hydra.listen(0, "127.0.0.1");
    await once(hydra, "listening");

    const response = await originalFetch(`http://127.0.0.1:${hydra.address().port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "lmstudio/tool-model",
        input: "search",
        stream: false,
        tools: [{ type: "web_search" }],
      }),
    });
    const json = await response.json();

    assert.equal(response.status, 200);
    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[0].tools.some((tool) => tool.function.name === "web_search"), true);
    assert.match(fetchCalls[1].messages.at(-1).content, /HYDRA_SEARCH_RESULT hydra router/);
    assert.equal(json.output[0].content[0].text, "Search complete");
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
  assert.deepEqual(await emulatedToolStatuses([["/bin/echo", "--fake-search"]]), [
    { name: "web_search", status: "ready", detail: undefined },
    { name: "tool_search", status: "ready" },
  ]);
});

test("reports emulated web search as unavailable when command is missing", async () => {
  assert.deepEqual(await emulatedToolStatuses([["/definitely/missing/hydra-search"]]), [
    { name: "web_search", status: "unavailable", detail: "no executable search command found" },
    { name: "tool_search", status: "ready" },
  ]);
});

test("retries a selected synthetic target then uses its concrete fallback", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "hydra-synthetic-router-"));
  const routesPath = join(tempDir, "routes.json");
  const selectorPath = join(tempDir, "selector.js");
  const selectorSource = "export default () => 1;\n";
  await writeFile(selectorPath, selectorSource);
  await writeFile(
    routesPath,
    JSON.stringify({
      "ollama/tiny": {
        provider: "ollama",
        upstreamModel: "tiny",
        capabilities: { tools: true, vision: false, thinking: false },
        contextWindow: 4096,
      },
      "gpt-test": {
        provider: "openai",
        upstreamModel: "gpt-test",
        capabilities: { tools: true, vision: true, thinking: true },
        contextWindow: 100000,
      },
      "hydra/smart": {
        provider: "synthetic",
        definition: {
          slug: "hydra/smart",
          selectorType: "custom",
          selectorPath,
          selectorHash: createHash("sha256").update(selectorSource).digest("hex"),
          candidates: ["ollama/tiny"],
          fallbackModel: "gpt-test",
          effectiveCandidates: ["ollama/tiny", "gpt-test"],
          routingScope: "user_turn",
          stickyToolContinuations: true,
          showRoutingCommentary: false,
          selectorTimeoutMs: 1000,
          retryCount: 1,
          retryDelayMs: 1,
        },
      },
    }),
  );
  const originalFetch = globalThis.fetch;
  let ollamaAttempts = 0;
  let cloudAttempts = 0;
  const metronEvents = [];
  const telemetry = createHydraTelemetry({ store: { async emit(event) { metronEvents.push(event); } } });
  let hydra;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/chat")) {
      ollamaAttempts += 1;
      return new Response("offline", { status: 503 });
    }
    cloudAttempts += 1;
    return new Response(JSON.stringify({ id: "resp_cloud", status: "completed", output: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const handler = createHydraHandler({
      paths: { routesPath },
      ollamaBaseUrl: "http://127.0.0.1:11434",
      lmStudioBaseUrl: "http://127.0.0.1:11239",
      openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
      syntheticContextOptions: syntheticContextFixture(),
      telemetry,
    });
    hydra = createHttpServer(handler);
    hydra.listen(0, "127.0.0.1");
    await once(hydra, "listening");
    const response = await originalFetch(`http://127.0.0.1:${hydra.address().port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "session-id": "fallback-session" },
      body: JSON.stringify({ model: "hydra/smart", input: "hello", stream: false }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.id, "resp_cloud");
    assert.deepEqual(body.output, []);
    assert.equal(ollamaAttempts, 2);
    assert.equal(cloudAttempts, 1);
    assert.equal(handler.syntheticState.lastSelections.get("hydra/smart").ultimate, "gpt-test");
    await telemetry.flush();
    assert.equal(metronEvents.filter((event) => event.type === "route.decision").length, 1);
    assert.deepEqual(
      metronEvents
        .filter((event) => event.type === "generation.completed")
        .map((event) => [event.data.target_model, event.data.phase, event.data.status]),
      [
        ["ollama/tiny", "selected", "failed"],
        ["ollama/tiny", "selected", "failed"],
        ["gpt-test", "fallback", "completed"],
      ],
    );
  } finally {
    if (hydra?.listening) {
      hydra.close();
      await Promise.allSettled([once(hydra, "close")]);
    }
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("lets a prompt selector call a configured direct classifier model", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "hydra-selector-model-router-"));
  const logPath = join(tempDir, "hydra.log");
  configureDebugLog(logPath);
  const routesPath = join(tempDir, "routes.json");
  const selectorPath = join(tempDir, "selector.js");
  const selectorSource = `export default async () => {
    const result = await globalThis.__hydraCallSelectorModel({
      prompt: "choose",
      selectionSlugs: ["ollama/tiny", "gpt-test"],
      contextSummary: {
        latestUserChars: 7,
        nonSystemPromptTokens: 10,
        previousUserMessages: 2,
        previousAgentMessages: 1,
      },
    });
    return JSON.parse(result).selection;
  };\n`;
  await writeFile(selectorPath, selectorSource);
  await writeFile(routesPath, JSON.stringify({
    "lmstudio/classifier": {
      provider: "lmstudio",
      upstreamModel: "classifier",
      capabilities: { tools: false, vision: false, thinking: false },
      contextWindow: 4096,
    },
    "ollama/tiny": {
      provider: "ollama",
      upstreamModel: "tiny",
      capabilities: { tools: true, vision: false, thinking: false },
      contextWindow: 4096,
    },
    "gpt-test": {
      provider: "openai",
      upstreamModel: "gpt-test",
      capabilities: { tools: true, vision: true, thinking: true },
      contextWindow: 100000,
    },
    "hydra/prompt-router": {
      provider: "synthetic",
      definition: {
        slug: "hydra/prompt-router",
        selectorPath,
        selectorHash: createHash("sha256").update(selectorSource).digest("hex"),
        candidates: ["ollama/tiny"],
        fallbackModel: "gpt-test",
        effectiveCandidates: ["ollama/tiny", "gpt-test"],
        selectorType: "prompt",
        selectorModel: "lmstudio/classifier",
        selectorContextParts: ["latest_user", "metadata"],
        routingScope: "user_turn",
        stickyToolContinuations: true,
        selectorTimeoutMs: 1000,
        retryCount: 0,
        retryDelayMs: 0,
      },
    },
  }));
  const originalFetch = globalThis.fetch;
  const calls = [];
  let hydra;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    if (String(url).endsWith("/v1/chat/completions")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"selection":1}' } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (String(url).endsWith("/api/chat")) {
      return new Response(JSON.stringify({ message: { content: "routed locally" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected upstream: ${url}`);
  };
  try {
    const handler = createHydraHandler({
      paths: { routesPath },
      ollamaBaseUrl: "http://127.0.0.1:11434",
      lmStudioBaseUrl: "http://127.0.0.1:11239",
      openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
      syntheticContextOptions: syntheticContextFixture(),
      debugAuth: false,
    });
    hydra = createHttpServer(handler);
    hydra.listen(0, "127.0.0.1");
    await once(hydra, "listening");
    const response = await originalFetch(`http://127.0.0.1:${hydra.address().port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "session-id": "classifier-session" },
      body: JSON.stringify({ model: "hydra/prompt-router", input: "hello", stream: false }),
    });
    assert.equal(response.status, 200);
    const routed = await response.json();
    assert.equal(routed.output[0].content[0].text, "Hydra routed this turn to ollama/tiny.");
    assert.equal(routed.output[0].phase, "commentary");
    assert.equal(routed.output[1].content[0].text, "routed locally");
    assert.equal(calls[0].body.model, "classifier");
    assert.equal(calls[0].body.temperature, 0);
    assert.equal(calls[0].body.max_tokens, 32);
    assert.equal(calls[0].body.chat_template_kwargs.enable_thinking, false);
    assert.deepEqual(
      calls[0].body.response_format.json_schema.schema.properties.selection.enum,
      [1, 2],
    );
    assert.equal(calls[1].body.model, "tiny");
    const log = await readFile(logPath, "utf8");
    assert.match(log, /hydra-synthetic-selector-model-response/);
    assert.match(log, /"output":"\{\\"selection\\":1\}"/);
    assert.match(log, /"selectionMapping":\[\{"selection":1,"slug":"ollama\/tiny"/);
    assert.match(log, /"nonSystemPromptTokens":10/);
    assert.match(log, /"thinkingEnabled":false/);
    assert.match(log, /"selectorResult":1/);
    assert.match(log, /"selectorContext":\{"system":/);
    assert.match(log, /"selectorConfiguration":\{"selectorType":"prompt","selectorModel":"lmstudio\/classifier"/);
  } finally {
    configureDebugLog(null);
    if (hydra?.listening) {
      hydra.close();
      await Promise.allSettled([once(hydra, "close")]);
    }
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("calls an OpenAI selector model with a streaming Responses request", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "hydra-cloud-selector-model-router-"));
  const routesPath = join(tempDir, "routes.json");
  const selectorPath = join(tempDir, "selector.js");
  const selectorSource = `export default async () => {
    const result = await globalThis.__hydraCallSelectorModel({
      prompt: "choose",
      selectionSlugs: ["ollama/tiny", "gpt-test"],
    });
    return JSON.parse(result).selection;
  };\n`;
  await writeFile(selectorPath, selectorSource);
  await writeFile(routesPath, JSON.stringify({
    "gpt-classifier": {
      provider: "openai",
      upstreamModel: "gpt-classifier",
      capabilities: { tools: true, vision: true, thinking: true },
      contextWindow: 100000,
    },
    "ollama/tiny": {
      provider: "ollama",
      upstreamModel: "tiny",
      capabilities: { tools: true, vision: false, thinking: false },
      contextWindow: 4096,
    },
    "gpt-test": {
      provider: "openai",
      upstreamModel: "gpt-test",
      capabilities: { tools: true, vision: true, thinking: true },
      contextWindow: 100000,
    },
    "hydra/prompt-router": {
      provider: "synthetic",
      definition: {
        slug: "hydra/prompt-router",
        selectorPath,
        selectorHash: createHash("sha256").update(selectorSource).digest("hex"),
        selectorType: "prompt",
        selectorModel: "gpt-classifier",
        candidates: ["ollama/tiny"],
        fallbackModel: "gpt-test",
        effectiveCandidates: ["ollama/tiny", "gpt-test"],
        routingScope: "user_turn",
        stickyToolContinuations: true,
        selectorTimeoutMs: 1000,
        retryCount: 0,
        retryDelayMs: 0,
      },
    },
  }));
  const originalFetch = globalThis.fetch;
  const calls = [];
  let hydra;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url: String(url), headers: options.headers, body });
    if (body.model === "gpt-classifier") {
      return new Response([
        'data: {"type":"response.output_text.delta","delta":"{\\\"selection\\\":"}',
        'data: {"type":"response.output_text.delta","delta":"1}"}',
        'data: {"type":"response.output_text.done","text":"{\\\"selection\\\":1}"}',
        "data: [DONE]",
        "",
      ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (String(url).endsWith("/api/chat")) {
      return new Response(JSON.stringify({ message: { content: "routed locally" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected upstream: ${url}`);
  };
  try {
    const handler = createHydraHandler({
      paths: { routesPath },
      ollamaBaseUrl: "http://127.0.0.1:11434",
      lmStudioBaseUrl: "http://127.0.0.1:11239",
      openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
      syntheticContextOptions: syntheticContextFixture(),
    });
    hydra = createHttpServer(handler);
    hydra.listen(0, "127.0.0.1");
    await once(hydra, "listening");
    const response = await originalFetch(`http://127.0.0.1:${hydra.address().port}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", "session-id": "cloud-classifier-session" },
      body: JSON.stringify({ model: "hydra/prompt-router", input: "hello", stream: false }),
    });
    assert.equal(response.status, 200);
    const routed = await response.json();
    assert.equal(routed.output[0].content[0].text, "Hydra routed this turn to ollama/tiny.");
    assert.equal(routed.output[0].phase, "commentary");
    assert.equal(routed.output[1].content[0].text, "routed locally");
    assert.equal(calls[0].body.model, "gpt-classifier");
    assert.equal(calls[0].body.stream, true);
    assert.equal(calls[0].body.temperature, 0);
    assert.equal(calls[0].body.max_output_tokens, 32);
    assert.equal(calls[0].body.reasoning.effort, "none");
    assert.deepEqual(calls[0].body.text.format.schema.properties.selection.enum, [1, 2]);
    assert.deepEqual(calls[0].body.input, [{ role: "user", content: "choose" }]);
    assert.equal(calls[0].headers.accept, "text/event-stream");
    assert.equal(calls[1].body.model, "tiny");
  } finally {
    if (hydra?.listening) {
      hydra.close();
      await Promise.allSettled([once(hydra, "close")]);
    }
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("pins a synthetic Codex session to the OpenAI route that owns previous response state", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "hydra-synthetic-state-"));
  const routesPath = join(tempDir, "routes.json");
  const selectorPath = join(tempDir, "selector.js");
  const selectorSource = `export default (context) =>
    context.messages.latestUser?.content.includes("first") ? 1 : 2;\n`;
  await writeFile(selectorPath, selectorSource);
  await writeFile(routesPath, JSON.stringify({
    "gpt-a": {
      provider: "openai",
      upstreamModel: "gpt-a-upstream",
      capabilities: { tools: true, vision: true, thinking: true },
      contextWindow: 100000,
    },
    "gpt-b": {
      provider: "openai",
      upstreamModel: "gpt-b-upstream",
      capabilities: { tools: true, vision: true, thinking: true },
      contextWindow: 100000,
    },
    "hydra/stateful": {
      provider: "synthetic",
      definition: {
        slug: "hydra/stateful",
        selectorType: "custom",
        selectorPath,
        selectorHash: createHash("sha256").update(selectorSource).digest("hex"),
        candidates: ["gpt-a", "gpt-b"],
        fallbackModel: "gpt-b",
        effectiveCandidates: ["gpt-a", "gpt-b"],
        routingScope: "user_turn",
        stickyToolContinuations: false,
        selectorTimeoutMs: 1000,
        retryCount: 0,
        retryDelayMs: 0,
      },
    },
  }));
  const originalFetch = globalThis.fetch;
  const upstreamRequests = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    upstreamRequests.push(body);
    const id = `resp_${body.model}_${upstreamRequests.length}`;
    return new Response([
      "event: response.created",
      `data: ${JSON.stringify({ type: "response.created", response: { id, status: "in_progress" } })}`,
      "",
      "event: response.completed",
      `data: ${JSON.stringify({ type: "response.completed", response: { id, status: "completed", output: [] } })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n"), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  let hydra;
  try {
    const handler = createHydraHandler({
      paths: { routesPath },
      ollamaBaseUrl: "http://127.0.0.1:11434",
      lmStudioBaseUrl: "http://127.0.0.1:11239",
      openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
      syntheticContextOptions: syntheticContextFixture(),
    });
    hydra = createHttpServer(handler);
    hydra.listen(0, "127.0.0.1");
    await once(hydra, "listening");
    const endpoint = `http://127.0.0.1:${hydra.address().port}/responses`;
    const request = (input, extra = {}, sessionId = "stateful-session") => originalFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "session-id": sessionId },
      body: JSON.stringify({ model: "hydra/stateful", input, stream: true, ...extra }),
    });

    let response = await request("first request");
    assert.equal(response.status, 200);
    const firstText = await response.text();
    assert.match(firstText, /Hydra routed this turn to gpt-a\./);
    assert.match(firstText, /"phase":"commentary"/);
    assert.match(firstText, /"agent_name":"hydra-router"/);
    assert.match(firstText, /"type":"response.output_item.added","output_index":0/);
    const firstResponseId = "resp_gpt-a-upstream_1";

    response = await request("select b if this were stateless", { previous_response_id: firstResponseId });
    assert.equal(response.status, 200);
    await response.text();

    response = await request("still select b if this were stateless");
    assert.equal(response.status, 200);
    await response.text();

    const unknown = await request("unknown state", { previous_response_id: "resp_unknown" }, "other-session");
    assert.equal(unknown.status, 400);
    assert.equal((await unknown.json()).error.code, "unsupported_state_reference");

    assert.deepEqual(upstreamRequests.map((body) => body.model), [
      "gpt-a-upstream",
      "gpt-a-upstream",
      "gpt-a-upstream",
    ]);
    assert.equal(upstreamRequests[1].previous_response_id, firstResponseId);
  } finally {
    if (hydra?.listening) {
      hydra.close();
      await Promise.allSettled([once(hydra, "close")]);
    }
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("pins a synthetic session to a known OpenAI conversation owner", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "hydra-synthetic-conversation-state-"));
  const routesPath = join(tempDir, "routes.json");
  const selectorPath = join(tempDir, "selector.js");
  const selectorSource = "export default () => 2;\n";
  await writeFile(selectorPath, selectorSource);
  await writeFile(routesPath, JSON.stringify({
    "gpt-a": { provider: "openai", upstreamModel: "gpt-a-upstream", capabilities: {}, contextWindow: 100000 },
    "gpt-b": { provider: "openai", upstreamModel: "gpt-b-upstream", capabilities: {}, contextWindow: 100000 },
    "hydra/conversation-state": {
      provider: "synthetic",
      definition: {
        slug: "hydra/conversation-state",
        selectorType: "custom",
        selectorPath,
        selectorHash: createHash("sha256").update(selectorSource).digest("hex"),
        candidates: ["gpt-a", "gpt-b"],
        fallbackModel: "gpt-b",
        effectiveCandidates: ["gpt-a", "gpt-b"],
        routingScope: "user_turn",
        stickyToolContinuations: false,
        selectorTimeoutMs: 1000,
        retryCount: 0,
        retryDelayMs: 0,
      },
    },
  }));
  const originalFetch = globalThis.fetch;
  const models = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    models.push(body.model);
    return new Response(JSON.stringify({ id: `resp_${models.length}`, status: "completed", output: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  let hydra;
  try {
    const handler = createHydraHandler({
      paths: { routesPath },
      ollamaBaseUrl: "http://127.0.0.1:11434",
      lmStudioBaseUrl: "http://127.0.0.1:11239",
      openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
      syntheticContextOptions: syntheticContextFixture(),
    });
    hydra = createHttpServer(handler);
    hydra.listen(0, "127.0.0.1");
    await once(hydra, "listening");
    const endpoint = `http://127.0.0.1:${hydra.address().port}/responses`;
    let response = await originalFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-a", input: "seed", conversation: "conv_known", stream: false }),
    });
    assert.equal(response.status, 200);
    await response.text();

    response = await originalFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "session-id": "conversation-session" },
      body: JSON.stringify({
        model: "hydra/conversation-state",
        input: "continue",
        conversation: "conv_known",
        stream: false,
      }),
    });
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual(models, ["gpt-a-upstream", "gpt-a-upstream"]);
  } finally {
    if (hydra?.listening) {
      hydra.close();
      await Promise.allSettled([once(hydra, "close")]);
    }
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("locks conversation-scoped synthetic routes to the first successful model", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "hydra-synthetic-session-"));
  const routesPath = join(tempDir, "routes.json");
  const selectorPath = join(tempDir, "selector.js");
  const selectorSource = `export default (context) =>
    context.messages.latestUser?.content.includes("local") ? 1 : 2;\n`;
  await writeFile(selectorPath, selectorSource);
  await writeFile(
    routesPath,
    JSON.stringify({
      "ollama/tiny": {
        provider: "ollama",
        upstreamModel: "tiny",
        capabilities: { tools: true, vision: false, thinking: false },
        contextWindow: 4096,
      },
      "gpt-test": {
        provider: "openai",
        upstreamModel: "gpt-test",
        capabilities: { tools: true, vision: true, thinking: true },
        contextWindow: 100000,
      },
      "hydra/session": {
        provider: "synthetic",
        definition: {
          slug: "hydra/session",
          selectorType: "custom",
          selectorPath,
          selectorHash: createHash("sha256").update(selectorSource).digest("hex"),
          candidates: ["ollama/tiny"],
          fallbackModel: "gpt-test",
          effectiveCandidates: ["ollama/tiny", "gpt-test"],
          routingScope: "conversation",
          stickyToolContinuations: false,
          selectorTimeoutMs: 1000,
          retryCount: 0,
          retryDelayMs: 0,
        },
      },
    }),
  );
  const originalFetch = globalThis.fetch;
  const targets = [];
  let hydra;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/chat")) {
      targets.push("ollama/tiny");
      return new Response(JSON.stringify({ message: { content: "local" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    targets.push("gpt-test");
    return new Response(JSON.stringify({ id: "resp_cloud", status: "completed", output: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const handler = createHydraHandler({
      paths: { routesPath },
      ollamaBaseUrl: "http://127.0.0.1:11434",
      lmStudioBaseUrl: "http://127.0.0.1:11239",
      openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
      syntheticContextOptions: syntheticContextFixture(),
    });
    hydra = createHttpServer(handler);
    hydra.listen(0, "127.0.0.1");
    await once(hydra, "listening");
    const endpoint = `http://127.0.0.1:${hydra.address().port}/responses`;
    for (const input of ["use local", "use cloud now"]) {
      const response = await originalFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "session-id": "same-session" },
        body: JSON.stringify({ model: "hydra/session", input, stream: false }),
      });
      assert.equal(response.status, 200);
      await response.text();
    }
    const otherSession = await originalFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "session-id": "other-session" },
      body: JSON.stringify({ model: "hydra/session", input: "use cloud", stream: false }),
    });
    assert.equal(otherSession.status, 200);
    await otherSession.text();
    assert.deepEqual(targets, ["ollama/tiny", "ollama/tiny", "gpt-test"]);
  } finally {
    if (hydra?.listening) {
      hydra.close();
      await Promise.allSettled([once(hydra, "close")]);
    }
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("keeps tool continuations on the selected user-turn model", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "hydra-synthetic-tool-turn-"));
  const routesPath = join(tempDir, "routes.json");
  const selectorPath = join(tempDir, "selector.js");
  const selectorSource = `export default (context) =>
    context.messages.latestUser?.content.includes("local") ? 1 : 2;\n`;
  await writeFile(selectorPath, selectorSource);
  await writeFile(
    routesPath,
    JSON.stringify({
      "ollama/tiny": {
        provider: "ollama",
        upstreamModel: "tiny",
        capabilities: { tools: true, vision: false, thinking: false },
        contextWindow: 4096,
      },
      "gpt-test": {
        provider: "openai",
        upstreamModel: "gpt-test",
        capabilities: { tools: true, vision: true, thinking: true },
        contextWindow: 100000,
      },
      "hydra/turns": {
        provider: "synthetic",
        definition: {
          slug: "hydra/turns",
          selectorType: "custom",
          selectorPath,
          selectorHash: createHash("sha256").update(selectorSource).digest("hex"),
          candidates: ["ollama/tiny"],
          fallbackModel: "gpt-test",
          effectiveCandidates: ["ollama/tiny", "gpt-test"],
          routingScope: "user_turn",
          stickyToolContinuations: true,
          selectorTimeoutMs: 1000,
          retryCount: 0,
          retryDelayMs: 0,
        },
      },
    }),
  );
  const originalFetch = globalThis.fetch;
  const targets = [];
  let hydra;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/api/chat")) {
      targets.push("ollama/tiny");
      return new Response(JSON.stringify({ message: { content: "local" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    targets.push("gpt-test");
    return new Response(JSON.stringify({ id: "resp_cloud", status: "completed", output: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const handler = createHydraHandler({
      paths: { routesPath },
      ollamaBaseUrl: "http://127.0.0.1:11434",
      lmStudioBaseUrl: "http://127.0.0.1:11239",
      openaiBaseUrl: "https://chatgpt.com/backend-api/codex",
      syntheticContextOptions: syntheticContextFixture(),
    });
    hydra = createHttpServer(handler);
    hydra.listen(0, "127.0.0.1");
    await once(hydra, "listening");
    const endpoint = `http://127.0.0.1:${hydra.address().port}/responses`;
    const request = (input) => originalFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "session-id": "tool-session" },
      body: JSON.stringify({ model: "hydra/turns", input, stream: false }),
    });

    let response = await request("use local");
    assert.equal(response.status, 200);
    let body = await response.json();
    assert.equal(body.output[0].phase, "commentary");
    response = await request([{ type: "function_call_output", call_id: "call-1", output: "tool result" }]);
    assert.equal(response.status, 200);
    body = await response.json();
    assert.equal(body.output.some((item) => item.phase === "commentary"), false);
    response = await request("use cloud now");
    assert.equal(response.status, 200);
    await response.text();
    response = await request([
      { type: "function_call_output", call_id: "call-2", output: "old tool result" },
      { role: "user", content: "use local again" },
    ]);
    assert.equal(response.status, 200);
    await response.text();

    assert.deepEqual(targets, ["ollama/tiny", "ollama/tiny", "gpt-test", "ollama/tiny"]);
  } finally {
    if (hydra?.listening) {
      hydra.close();
      await Promise.allSettled([once(hydra, "close")]);
    }
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  }
});

function syntheticContextFixture() {
  return {
    telemetryImpl: async () => ({ memory: {}, battery: {}, gpu: {} }),
    providerStatusImpl: async () => ({
      openai: { status: "unknown", models: {} },
      ollama: { status: "available", models: { tiny: { status: "available" } } },
      lmstudio: { status: "available", models: {} },
    }),
  };
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
