# Hydra LLM Router

Hydra lets Codex Desktop use one model selector for OpenAI cloud models plus local Ollama and LM Studio models.

![Codex Desktop model selector showing OpenAI and Ollama models side by side](docs/assets/codex-model-selector.png)

The important design choice is that Hydra does not add a new Codex model provider. It keeps Codex Desktop in its built-in OpenAI provider bucket and only changes:

- `model_catalog_json` to a merged Hydra catalog
- `openai_base_url` to `http://127.0.0.1:3847`

Keeping the provider identity as OpenAI preserves existing Codex Desktop chats and OAuth behavior.

## Commands

```sh
npm test
node src/cli.js refresh
node src/cli.js install
node src/cli.js serve
node src/cli.js stop
node src/cli.js restore
node src/cli.js status
node src/cli.js models
```

Use `--ollama-url`, `--lmstudio-url`, `--openai-base-url`, `--port`, and the app-tool flags to override the defaults for a run. The equivalent persistent environment variables are listed below.

`install` backs up `~/.codex/config.toml`, refreshes the merged catalog, and points Codex Desktop at Hydra. `restore` writes the saved backup back.

On macOS, `serve` shows a Hydra menu bar item with runtime details. Use `Quit Hydra` from that menu to restore the saved Codex config backup and stop the server. For terminal-only use:

```sh
node src/cli.js serve --no-menubar
```

The menu bar and `models` command both show the detected catalog entries Hydra has written. Local providers are queried during `refresh` or `install`; a provider that is offline or advertises no chat models contributes no catalog entries.

You can also double-click `Hydra.command` from Finder. It runs `install`, starts `serve` in the background, writes launcher output to `~/.codex/hydra/launcher.log`, and hides Terminal after startup.

After testing with debug mode, restart without debug logging:

```sh
node src/cli.js stop
node src/cli.js serve
```

## Model Routing

Cloud models keep their Codex catalog slugs, for example:

```text
gpt-5.5
```

Ollama models are exposed with an `ollama/` prefix, for example:

```text
ollama/llama3.2:latest
```

LM Studio models are exposed with an `lmstudio/` prefix, for example:

```text
lmstudio/qwen/qwen3.6-27b
```

The prefix avoids name collisions and lets Hydra choose the correct upstream deterministically.

## App Tools

By default, `serve` starts a local `codex app-server --listen stdio://` bridge and exposes tools from the `codex_apps` MCP server to Ollama routes. That is how Ollama models can discover and call connected apps such as Gmail through the same tool catalog Desktop uses. LM Studio routes currently receive only the tools supplied by the request; they do not use the app-server bridge.

Disable the bridge with:

```sh
node src/cli.js serve --app-tools off
```

Expose a different app-server MCP server list with:

```sh
node src/cli.js serve --app-tool-servers codex_apps,node_repl
```

Apps that already start their own app-server, such as `twilio-voice-agent`, can keep routing model traffic through Hydra. Hydra runs its own bridge process for local model tool calls and uses the shared `~/.codex` app auth/plugins, so connector access works without needing to reach into the caller's private stdio app-server. Exact caller-thread provenance would require the app to expose or proxy its app-server thread context to Hydra.

## Cloud Auth

Codex Desktop uses ChatGPT OAuth/session auth, not a public OpenAI API key. For normal Desktop use, Hydra forwards cloud model requests to:

```text
https://chatgpt.com/backend-api/codex
```

Do not forward Desktop OAuth tokens to `https://api.openai.com/v1`; that endpoint expects API keys and returns `401`.

To explicitly use public OpenAI API-key forwarding instead:

```sh
HYDRA_OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
node src/cli.js serve
```

## Configuration

Useful environment variables:

```sh
HYDRA_PORT=3847
OLLAMA_BASE_URL=http://127.0.0.1:11434
LMSTUDIO_BASE_URL=http://127.0.0.1:11239
HYDRA_OPENAI_BASE_URL=https://chatgpt.com/backend-api/codex
OPENAI_API_KEY=...
HYDRA_OLLAMA_CONTEXT_WINDOW=32768
HYDRA_LMSTUDIO_CONTEXT_WINDOW=32768
HYDRA_APP_TOOLS=auto
HYDRA_APP_TOOL_SERVERS=codex_apps
HYDRA_CODEX_BIN=codex
```

Generated files live under:

```text
~/.codex/hydra/
```

Key files:

- `hydra-models.json`: merged Codex + Ollama + LM Studio model catalog
- `routes.json`: model slug to upstream route table
- `settings.json`: last generated router settings
- `config.backup.toml`: saved Codex config for restore
- `hydra.pid`: running server pid
- `hydra.log`: debug log when `--debug-auth` is enabled

## Debugging

Run with redacted request diagnostics:

```sh
node src/cli.js serve --debug-auth
```

Stop it from another terminal:

```sh
node src/cli.js stop
```

Debug logs are written to:

```text
~/.codex/hydra/hydra.log
```

Prompt text is not logged. Request bodies are summarized by shape, model, and key names. Sensitive headers are redacted, but header names and value lengths are retained for diagnostics.

Codex Desktop currently sends Responses request bodies compressed with `content-encoding: zstd`. Hydra decodes compressed request bodies before parsing JSON.

## Current Scope

Hydra supports the core text Responses flow for:

- OpenAI cloud models through Codex Desktop's ChatGPT-login backend
- Ollama local chat models through `/api/chat`
- LM Studio local chat models through `/v1/chat/completions`
- Codex app-server tools for local Ollama models
- Emulated local web-search tools for Ollama models when Codex's web-search tool is available

Hydra currently rejects WebSocket upgrade attempts with `426 Upgrade Required`; Codex Desktop falls back to the HTTP `POST /responses` path.
