# Agent Notes for Hydra

This project is a local Codex Desktop model router. Keep changes small and validate against the live Desktop behavior when touching config or auth paths.

## Working Architecture

- Hydra must preserve Codex Desktop's built-in OpenAI provider identity.
- `install` should set top-level `model_catalog_json` and `openai_base_url` only.
- Do not reintroduce `model_provider = "hydra"` or `[model_providers.hydra]`; that caused existing chats to disappear from Codex Desktop.
- Cloud model routes use provider `openai` and keep the original Codex catalog slugs.
- Local Ollama model routes use provider `ollama` and slugs prefixed with `ollama/`.

## Important Desktop Behaviors

- Codex Desktop uses OAuth/session auth for cloud requests.
- The correct default cloud upstream for Desktop OAuth is `https://chatgpt.com/backend-api/codex`.
- Forwarding Desktop OAuth tokens to `https://api.openai.com/v1` returns `401`; only use that upstream with `OPENAI_API_KEY`.
- Desktop sends `POST /responses` for the working request path.
- Desktop may first attempt a WebSocket upgrade to `/responses` with `openai-beta: responses_websockets=2026-02-06`; proxy cloud upgrades to the configured OpenAI upstream.
- Desktop compresses request bodies with `content-encoding: zstd`; always decode before JSON parsing.
- Forward cloud requests transparently enough to keep Codex-specific headers such as `chatgpt-account-id`, `session-id`, `x-codex-*`, `openai-beta`, and `authorization`.
- Strip hop-by-hop and stale body headers before HTTP upstream forwarding: `host`, `connection`, `content-length`, `content-encoding`, `transfer-encoding`, `upgrade`, and WebSocket headers. For WebSocket upgrades, preserve upgrade headers and replace only stale request framing such as `host` and body length/encoding headers.

## Catalog Notes

- Build the cloud catalog from Codex's existing `~/.codex/models_cache.json`.
- Local Ollama catalog entries are cloned from a visible cloud model template, then adjusted.
- `web_search_tool_type` must be a supported value such as `text`; using `unsupported` made Codex Desktop fail to parse the catalog.
- Keep local model slugs collision-free with the `ollama/` prefix.

## Debugging Notes

- Use `node src/cli.js serve --debug-auth` for live Desktop captures.
- Logs go to `~/.codex/hydra/hydra.log`.
- Do not log prompt text or raw bodies. Keep the current summarized body logging style.
- Sensitive headers should stay redacted.
- Debug logging must not depend on stderr being open. The Desktop/agent terminal pipe can close and cause `EPIPE`.
- If the server appears stopped, check both `~/.codex/hydra/hydra.pid` and the actual listener with `lsof -nP -iTCP:3847 -sTCP:LISTEN`; stale pid files can happen after interrupted tests.

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
7. Restart without debug logging for normal use.

## Safety Constraints

- Never overwrite unrelated user edits in `~/.codex/config.toml`.
- Preserve the backup/restore behavior.
- Keep generated files under `~/.codex/hydra/`.
- Avoid adding heavy dependencies unless they solve a real Desktop compatibility issue.
