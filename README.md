# ModelDock

ModelDock is a local provider and model workbench for Codex. The first version is intentionally small: it edits Codex configuration files, creates backups, restores backups, and runs a few local Codex smoke tests.

## Run

Recommended on Windows: install the runtime as an independent user startup process. This keeps the local proxy alive across Codex Desktop restarts.

```powershell
cd D:\projects\modeldock
powershell -NoProfile -ExecutionPolicy Bypass -File tools\runtime.ps1 install
```

Check it:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\runtime.ps1 status
```

Start or stop it manually:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\runtime.ps1 start
powershell -NoProfile -ExecutionPolicy Bypass -File tools\runtime.ps1 stop
```

The installer writes a startup launcher to `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\ModelDockRuntime.cmd`.
The runtime logs to `%LOCALAPPDATA%\ModelDock\runtime.log`.

Development-only foreground run:

```powershell
cd D:\projects\modeldock
node server.mjs
```

Open:

```text
http://127.0.0.1:8765
```

If another app uses the port:

```powershell
$env:MODELDOCK_PORT = "8766"
node server.mjs
```

## What It Edits

ModelDock reads the Codex home from `CODEX_HOME`, or falls back to `%USERPROFILE%\.codex`.
For testing, `MODELDOCK_CODEX_HOME` overrides both without changing your real Codex environment.

It can:

- Save a named profile file such as `$CODEX_HOME\openrouter.config.toml`.
- Apply the selected preset into `$CODEX_HOME\config.toml`.
- Back up `config.toml` before each apply or restore.
- Restore a previous backup.
- Fetch provider model ids from an OpenAI-compatible `/models` endpoint.

Codex Desktop should be restarted after provider/model changes.

## OpenRouter Flow

Set the API key in the same environment that starts ModelDock:

```powershell
$env:OPENROUTER_API_KEY = "..."
node server.mjs
```

Then choose the OpenRouter preset, click `Fetch Provider Models`, select a model, and then use `Apply to Codex` or `Save Profile`.

`Fetch Provider Models` only calls `/models`. It is a model-name picker, not a compatibility guarantee.

## Provider Presets

The preset list includes OpenRouter, DeepSeek, Kimi, Anthropic, Ollama, LM Studio, and Custom.
For hosted providers, set the API key in the environment that starts ModelDock:

```powershell
$env:OPENROUTER_API_KEY = "..."
$env:DEEPSEEK_API_KEY = "..."
$env:MOONSHOT_API_KEY = "..."
$env:ANTHROPIC_API_KEY = "..."
node server.mjs
```

Default base URLs:

- OpenRouter: `https://openrouter.ai/api/v1`
- DeepSeek: `http://127.0.0.1:8765/proxy/deepseek/v1`
- Kimi: `http://127.0.0.1:8765/proxy/kimi/v1`
- Anthropic: `https://api.anthropic.com`

Default Codex wire APIs:

- OpenAI: `responses` (`/responses`)
- OpenRouter: `responses` (`/responses`, OpenRouter beta Responses API)
- DeepSeek: `responses` through ModelDock Runtime
- Kimi: `responses` through ModelDock Runtime
- Ollama and LM Studio: `chat` (`/chat/completions`)

The Wire API field is locked in the UI because it determines the HTTP path Codex calls. A wrong value can make Codex call an endpoint that the provider does not implement, such as DeepSeek `/responses`.

Current Codex CLI builds reject `wire_api = "chat"`, so chat-only providers such as Ollama and LM Studio are blocked from Apply/Profile for now. DeepSeek and Kimi use the ModelDock Runtime automatically.

## ModelDock Chat Proxy

ModelDock routes DeepSeek and Kimi through local compatibility endpoints:

- DeepSeek: `http://127.0.0.1:8765/proxy/deepseek/v1`
- Kimi: `http://127.0.0.1:8765/proxy/kimi/v1`

These presets expose `wire_api = "responses"` to Codex, then ModelDock translates `POST /responses` into the provider's `POST /chat/completions` upstream call and wraps the result as Responses SSE events when Codex asks for streaming. The remote API key stays in the ModelDock process environment, so the generated Codex provider block does not need an `env_key`.

The proxy requires ModelDock to keep running while Codex uses that provider. It is text-first and intentionally conservative; direct chat providers still cannot be applied unless they go through this `/responses` adapter.

Anthropic uses `x-api-key` and `/v1/models` for model discovery. Direct Anthropic generation uses `/v1/messages`, which is not supported by ModelDock's Codex `responses`/`chat` wire setting yet, so direct Anthropic Apply/Profile actions are blocked for now. Use Anthropic through OpenRouter or another OpenAI-compatible gateway.

Codex reserves built-in provider IDs such as `openai`, `ollama`, `lmstudio`, and `amazon-bedrock`. Do not reuse those IDs for a custom endpoint. For example, use `deepseek` or `openai-custom`, not `openai`, when pointing at DeepSeek.

## Smoke Tests

The test panel runs:

- `codex doctor --summary --ascii --no-color`
- `codex debug models`
- `codex exec --ask-for-approval never --sandbox read-only`

The small exec test may call the selected model provider and can incur provider-side cost.

## Current Scope

This is not a full TOML IDE yet. It safely changes the key Codex model/provider fields and rewrites the selected custom provider block. It preserves unrelated config sections.
