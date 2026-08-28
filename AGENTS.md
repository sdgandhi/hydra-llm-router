# Agent Notes for Hydra

This project is a local Codex Desktop model router. Keep changes small. Development and automated live verification must use the isolated Codex CLI environment described below; do not interrupt the Desktop router to test development code.

## Isolated Development Environment

- Never use Codex Desktop to develop or test Hydra. Never stop, replace, or bind to the Desktop Hydra listener on port `3847` during development.
- Never use the Codex binary bundled inside ChatGPT.app or Codex.app for development. Use the repository-pinned `@openai/codex` dev dependency through the npm commands below.
- All development Codex state lives under `HYDRA_DEV_CODEX_HOME`, which defaults to `~/.codex-hydra-dev`. `CODEX_HOME` and `CODEX_SQLITE_HOME` are both set by the wrapper, so development config, auth, logs, rollouts, history, sessions, skills, and SQLite state do not enter `~/.codex` or appear in Codex Desktop.
- Development Hydra listens on `HYDRA_DEV_PORT`, which defaults to `3857`. The wrapper rejects port `3847`.
- Development Codex uses the built-in OpenAI provider identity with top-level `model_catalog_json` and `openai_base_url` pinned to the development Hydra listener. The wrapper removes direct API-key, access-token, workload-identity, and base-URL overrides from child environments and rejects CLI flags that could bypass its config.
- Direct ChatGPT access is allowed only for `npm run dev:login`, so the isolated CLI can obtain and refresh OAuth credentials. API-key and access-token login modes are rejected. All model inference must go through development Hydra.
- `npm run dev:setup` rewrites the isolated, wrapper-owned Codex config and imports only the current model cache and Hydra configuration/selectors as initial development fixtures. It does not copy Desktop auth, session rollouts, history, logs, or SQLite databases. Run `npm run dev:login` once to authenticate the isolated home independently.
- Do not run `node src/cli.js install`, `serve`, `stop`, `prompt`, or `session` against the default `~/.codex` paths while developing. Use the `dev:*` commands.

Initial setup:

```sh
npm install
npm run dev:setup
npm run dev:login
```

Normal development and live testing:

```sh
npm run dev:serve
npm run dev:codex -- exec --ephemeral --sandbox read-only "<prompt>"
npm run dev:route -- --model <slug> --input "<prompt>"
npm run dev:prompt -- --model <slug> --input "<prompt>"
npm run dev:session -- --model <slug> --input "<turn-1>" --input "<turn-2>"
npm run dev:stop
```

Use `HYDRA_DEV_CODEX_HOME` and `HYDRA_DEV_PORT` only when a test needs another isolated home or listener. Keep the Desktop defaults untouched.
Use `scripts/dev-codex` directly when another development tool needs a Codex CLI binary path; it transparently forwards all Codex arguments inside the isolated home.

## Working Architecture

- Hydra must preserve Codex Desktop's built-in OpenAI provider identity.
- `install` should set top-level `model_catalog_json` and `openai_base_url` only.
- Do not reintroduce `model_provider = "hydra"` or `[model_providers.hydra]`; that caused existing chats to disappear from Codex Desktop.
- Cloud model routes use provider `openai` and keep the original Codex catalog slugs.
- Local Ollama model routes use provider `ollama` and slugs prefixed with `ollama/`.
- Local LM Studio model routes use provider `lmstudio` and slugs prefixed with `lmstudio/`.
- Local OMLX model routes use provider `omlx` and slugs prefixed with `omlx/`.
- Keep local prefixes collision-free; route slugs are the source of truth in `~/.codex/hydra/routes.json`.

## Important Desktop Behaviors

- Codex Desktop uses OAuth/session auth for cloud requests.
- The correct default cloud upstream for Desktop OAuth is `https://chatgpt.com/backend-api/codex`.
- Forwarding Desktop OAuth tokens to `https://api.openai.com/v1` returns `401`; only use that upstream with `OPENAI_API_KEY`.
- Desktop sends `POST /responses` for the working request path.
- Every Responses request owns an `AbortController`. Abort upstream LM Studio, OMLX, Ollama, and cloud fetches when the request is aborted or the downstream response closes before `res.writableEnded`; remove listeners when the request finishes.
- Client-driven `AbortError` is an expected cancellation outcome. Do not write a 500 after the downstream client is gone, and do not treat the normal close after `res.end()` as cancellation.
- Desktop may first attempt a WebSocket upgrade to `/responses` with `openai-beta: responses_websockets=2026-02-06`; Hydra currently rejects upgrades with `426` so Desktop falls back to HTTP `POST /responses`.
- Desktop compresses request bodies with `content-encoding: zstd`; always decode before JSON parsing.
- Forward cloud requests transparently enough to keep Codex-specific headers such as `chatgpt-account-id`, `session-id`, `x-codex-*`, `openai-beta`, and `authorization`.
- Strip hop-by-hop and stale body headers before HTTP upstream forwarding: `host`, `connection`, `content-length`, `content-encoding`, `transfer-encoding`, `upgrade`, and WebSocket headers.

## Catalog Notes

- Build the cloud catalog from Codex's existing `~/.codex/models_cache.json`.
- Local Ollama, LM Studio, and OMLX catalog entries are cloned from a visible cloud model template, then adjusted for local capabilities.
- Ollama discovery uses `/api/tags`, with per-model capability/context metadata from `/api/show`.
- LM Studio discovery prefers `/api/v1/models` and falls back to the OpenAI-compatible `/v1/models` endpoint. Only `llm` models from the native endpoint are included.
- OMLX discovery uses authenticated `/v1/models/status` and falls back to `/v1/models`; Hydra reads the local API key from `~/.omlx/settings.json` when the OMLX provider does not specify one.
- Local catalog entries advertise text, vision, reasoning, and tool support from provider metadata; local web search is advertised only when Hydra's emulation is ready.
- LM Studio and OMLX requests use `/v1/chat/completions`; Ollama requests use `/api/chat`. All are translated to/from Codex Responses-shaped requests.
- Normalize Responses reasoning from `reasoning.effort`, `reasoning_effort`, and `reasoning_level`. For LM Studio and OMLX, explicit `none` sets `chat_template_kwargs.enable_thinking` to `false` and forwards `reasoning_effort: "none"`; non-`none` sets thinking to `true` and forwards the normalized effort only when the route advertises thinking support.
- Streaming LM Studio and OMLX requests must remain incremental: forward `stream: true`, emit text deltas as `response.output_text.delta`, emit reasoning summaries only when thinking was enabled, then finish with `response.completed` and `data: [DONE]`.
- `web_search_tool_type` must be a supported value such as `text`; using `unsupported` made Codex Desktop fail to parse the catalog.
- Offline providers or providers with no chat models contribute no entries; cloud catalog generation must still succeed.

## Debugging Notes

- Use `node src/cli.js serve --debug` for live Desktop or CLI captures.
- Logs go to `~/.codex/hydra/hydra.log`.
- Do not log prompt text or raw bodies. Keep the current summarized body logging style.
- Sensitive headers should stay redacted.
- Debug logging must not depend on stderr being open. The Desktop/agent terminal pipe can close and cause `EPIPE`.
- If the server appears stopped, check both `~/.codex/hydra/hydra.pid` and the actual listener with `lsof -nP -iTCP:3847 -sTCP:LISTEN`; stale pid files can happen after interrupted tests.
- Never log prompt text, raw request bodies, or local model output; keep request logging summarized by route, shape, sizes, and capability/tool counts.

## Verification

Run:

```sh
npm run test:check
```

For live CLI verification:

1. Complete the isolated setup above once.
2. Start development Hydra with `npm run dev:serve`.
3. Use `npm run dev:route -- --model <slug> --input <text>` to exercise a selector without full Codex agent context or a generated answer.
4. Use `npm run dev:prompt -- --model <slug> --input <text>` for cloud, Ollama, LM Studio, and OMLX smoke tests.
5. Use repeated `--input` values with `npm run dev:session -- --model <slug> --input <text>` for full multi-turn verification.
6. Confirm `~/.codex-hydra-dev/hydra/hydra.log` shows upstream `status: 200` and the expected provider endpoint.
7. If app tools are enabled, select a tool-capable local model and verify an app-server tool call; verify `--app-tools off` disables the bridge.
8. Stop only the development listener with `npm run dev:stop`. Do not stop the Desktop listener.

## Change Delivery

- After completing and verifying repository work, commit all in-scope changes and push the current branch to its configured remote before handing the work back to the user.
- Do not include unrelated user changes in the commit.

## Safety Constraints

- Never overwrite unrelated user edits in `~/.codex/config.toml`.
- Preserve the backup/restore behavior.
- Keep generated files under `~/.codex/hydra/`.
- Avoid adding heavy dependencies unless they solve a real Desktop compatibility issue.
- Preserve support for `Hydra.command` finding both ChatGPT.app and Codex.app bundled CLIs, as well as `HYDRA_CODEX_BIN` overrides.
