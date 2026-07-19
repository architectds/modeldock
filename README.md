# ModelDock

ModelDock is a local provider and model workbench for Codex. The first version is intentionally small: it edits Codex configuration files, creates backups, restores backups, and runs a few local Codex smoke tests.

## Run

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

The preset list includes OpenRouter, DeepSeek, Kimi / Moonshot, Anthropic, Ollama, LM Studio, and Custom.
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
- DeepSeek: `https://api.deepseek.com`
- Kimi / Moonshot: `https://api.moonshot.ai/v1`
- Anthropic: `https://api.anthropic.com`

Anthropic uses `x-api-key` and `/v1/models` for model discovery. DeepSeek and Kimi use OpenAI-compatible bearer auth for model discovery.

## Smoke Tests

The test panel runs:

- `codex doctor --summary --ascii --no-color`
- `codex debug models`
- `codex exec --ask-for-approval never --sandbox read-only`

The small exec test may call the selected model provider and can incur provider-side cost.

## Current Scope

This is not a full TOML IDE yet. It safely changes the key Codex model/provider fields and rewrites the selected custom provider block. It preserves unrelated config sections.
