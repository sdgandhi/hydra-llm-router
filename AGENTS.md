# Agent Notes for Hydra

This project is a local Codex Desktop model router. Keep changes small and validate against the live Desktop behavior when touching config or auth paths.

## Working Architecture

- Hydra must preserve Codex Desktop's built-in OpenAI provider identity.
- `install` should set top-level `model_catalog_json` and `openai_base_url` only.
- Do not reintroduce `model_provider = "hydra"` or `[model_providers.hydra]`; that caused existing chats to disappear from Codex Desktop.
- Cloud model routes use provider `openai` and keep the original Codex catalog slugs.
- Local Ollama model routes use provider `ollama` and slugs prefixed with `ollama/`.
- Local LM Studio model routes use provider `lmstudio` and slugs prefixed with `lmstudio/`.
- Keep local prefixes collision-free; route slugs are the source of truth in `~/.codex/hydra/routes.json`.

## Important Desktop Behaviors

- Codex Desktop uses OAuth/session auth for cloud requests.
- The correct default cloud upstream for Desktop OAuth is `https://chatgpt.com/backend-api/codex`.
- Forwarding Desktop OAuth tokens to `https://api.openai.com/v1` returns `401`; only use that upstream with `OPENAI_API_KEY`.
- Desktop sends `POST /responses` for the working request path.
- Desktop may first attempt a WebSocket upgrade to `/responses` with `openai-beta: responses_websockets=2026-02-06`; Hydra currently rejects upgrades with `426` so Desktop falls back to HTTP `POST /responses`.
- Desktop compresses request bodies with `content-encoding: zstd`; always decode before JSON parsing.
- Forward cloud requests transparently enough to keep Codex-specific headers such as `chatgpt-account-id`, `session-id`, `x-codex-*`, `openai-beta`, and `authorization`.
- Strip hop-by-hop and stale body headers before HTTP upstream forwarding: `host`, `connection`, `content-length`, `content-encoding`, `transfer-encoding`, `upgrade`, and WebSocket headers.

## Catalog Notes

- Build the cloud catalog from Codex's existing `~/.codex/models_cache.json`.
- Local Ollama and LM Studio catalog entries are cloned from a visible cloud model template, then adjusted for local capabilities.
- Ollama discovery uses `/api/tags`, with per-model capability/context metadata from `/api/show`.
- LM Studio discovery prefers `/api/v1/models` and falls back to the OpenAI-compatible `/v1/models` endpoint. Only `llm` models from the native endpoint are included.
- Local catalog entries advertise text, vision, reasoning, and tool support from provider metadata; local web search is only advertised for Ollama when the emulation is ready.
- LM Studio requests use `/v1/chat/completions`; Ollama requests use `/api/chat`. Both are translated to/from Codex Responses-shaped requests.
- `web_search_tool_type` must be a supported value such as `text`; using `unsupported` made Codex Desktop fail to parse the catalog.
- Offline providers or providers with no chat models contribute no entries; cloud catalog generation must still succeed.

## Debugging Notes

- Use `node src/cli.js serve --debug-auth` for live Desktop captures.
- Logs go to `~/.codex/hydra/hydra.log`.
- Do not log prompt text or raw bodies. Keep the current summarized body logging style.
- Sensitive headers should stay redacted.
- Debug logging must not depend on stderr being open. The Desktop/agent terminal pipe can close and cause `EPIPE`.
- If the server appears stopped, check both `~/.codex/hydra/hydra.pid` and the actual listener with `lsof -nP -iTCP:3847 -sTCP:LISTEN`; stale pid files can happen after interrupted tests.
- Never log prompt text, raw request bodies, or local model output; keep request logging summarized by route, shape, sizes, and capability/tool counts.

## Verification

Run:

```sh
npm test
node --check src/router.js
node --check src/cli.js
node --check src/debug.js
```

For live Desktop verification:

1. `node src/cli.js install`
2. `node src/cli.js serve --debug-auth`
3. Open or restart Codex Desktop.
4. Select a cloud model and send a tiny prompt.
5. Confirm `~/.codex/hydra/hydra.log` shows upstream `status: 200` against `https://chatgpt.com/backend-api/codex/responses`.
6. Select an `ollama/...` model and confirm it routes to Ollama.
7. Select an `lmstudio/...` model and confirm it routes to LM Studio's `/v1/chat/completions` endpoint.
8. If app tools are enabled, select a tool-capable Ollama model and verify an app-server tool call; verify `--app-tools off` disables the bridge.
9. Restart without debug logging for normal use.

## Safety Constraints

- Never overwrite unrelated user edits in `~/.codex/config.toml`.
- Preserve the backup/restore behavior.
- Keep generated files under `~/.codex/hydra/`.
- Avoid adding heavy dependencies unless they solve a real Desktop compatibility issue.
- Preserve support for `Hydra.command` finding both ChatGPT.app and Codex.app bundled CLIs, as well as `HYDRA_CODEX_BIN` overrides.
