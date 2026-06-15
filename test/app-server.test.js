import test from "node:test";
import assert from "node:assert/strict";
import {
  appToolSourceFromOllamaTool,
  formatMcpToolResult,
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

test("formats MCP structured content before raw text", () => {
  assert.equal(formatMcpToolResult({ structuredContent: { ok: true } }), '{"ok":true}');
  assert.equal(formatMcpToolResult({ content: [{ type: "text", text: "hello" }] }), "hello");
});
