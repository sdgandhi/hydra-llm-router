import test from "node:test";
import assert from "node:assert/strict";
import {
  appToolSourceFromOllamaTool,
  formatMcpToolResult,
  isEnabledAppServerTool,
  mcpToolToOllamaTool,
  parseAppToolServers,
  resolveCodexBin,
} from "../src/app-server.js";

test("parses app tool server lists", () => {
  assert.deepEqual(parseAppToolServers("codex_apps, node_repl"), ["codex_apps", "node_repl"]);
  assert.deepEqual(parseAppToolServers(["codex_apps"]), ["codex_apps"]);
});

test("keeps explicit Codex binary paths", () => {
  assert.equal(resolveCodexBin("/tmp/codex", { env: { PATH: "" } }), "/tmp/codex");
});

test("finds the Codex helper bundled with ChatGPT Desktop", () => {
  const chatGptCodex = "/Applications/ChatGPT.app/Contents/Resources/codex";
  assert.equal(
    resolveCodexBin("codex", {
      env: { PATH: "" },
      candidates: [chatGptCodex, "/Applications/Codex.app/Contents/Resources/codex"],
      existsImpl: (candidate) => candidate === chatGptCodex,
    }),
    chatGptCodex,
  );
});

test("prefers a Codex helper found on PATH", () => {
  assert.equal(
    resolveCodexBin("codex", {
      env: { PATH: "/custom/bin" },
      candidates: ["/Applications/ChatGPT.app/Contents/Resources/codex"],
      existsImpl: (candidate) => candidate === "/custom/bin/codex",
    }),
    "/custom/bin/codex",
  );
});

test("converts MCP tools to Ollama functions", () => {
  const tool = mcpToolToOllamaTool({
    server: "codex_apps",
    tool: {
      name: "gmail_search_emails",
      description: "Search Gmail",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
      annotations: { readOnlyHint: true },
    },
  });

  assert.deepEqual(tool, {
    type: "function",
    function: {
      name: "gmail_search_emails",
      description: "Search Gmail",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    },
    _hydraAppTool: {
      server: "codex_apps",
      title: null,
      annotations: { readOnlyHint: true },
      meta: null,
    },
  });
  assert.deepEqual(appToolSourceFromOllamaTool(tool), {
    type: "function",
    name: "gmail_search_emails",
    description: "Search Gmail",
    parameters: { type: "object", properties: { query: { type: "string" } } },
  });
});

test("keeps only linked and enabled Codex app tools", () => {
  const server = { name: "codex_apps" };
  assert.equal(
    isEnabledAppServerTool({
      server,
      tool: {
        name: "gmail.search",
        _meta: {
          connector_id: "gmail",
          link_id: "linked-account",
          _codex_apps: { resource_uri: "/gmail/linked-account/search" },
        },
      },
    }),
    true,
  );
  assert.equal(
    isEnabledAppServerTool({
      server,
      tool: {
        name: "uninstalled.search",
        _meta: { connector_id: "uninstalled", _codex_apps: { resource_uri: "/catalog/search" } },
      },
    }),
    false,
  );
  assert.equal(
    isEnabledAppServerTool({ server: { name: "node_repl" }, tool: { name: "js_eval" } }),
    true,
  );
});

test("formats MCP structured content before raw text", () => {
  assert.equal(formatMcpToolResult({ structuredContent: { ok: true } }), '{"ok":true}');
  assert.equal(formatMcpToolResult({ content: [{ type: "text", text: "hello" }] }), "hello");
});
