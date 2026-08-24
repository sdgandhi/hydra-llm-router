import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { connect as connectNet } from "node:net";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
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
  let upstreamAborted = false;
  let resolveUpstreamAbort;
  const upstreamAbort = new Promise((resolve) => {
    resolveUpstreamAbort = resolve;
  });
  let hydra;
  globalThis.fetch = async (_url, options) => {
    upstreamSignal = options.signal;
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

  const originalCommand = process.env.HYDRA_WEB_SEARCH_COMMAND;
  process.env.HYDRA_WEB_SEARCH_COMMAND = "/bin/echo HYDRA_SEARCH_RESULT";
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
    restoreEnv("HYDRA_WEB_SEARCH_COMMAND", originalCommand);
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
