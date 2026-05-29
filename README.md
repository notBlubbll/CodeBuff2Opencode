# Codebuff2OpenCode Proxy

OpenAI- and Anthropic-compatible proxy server for [Codebuff](https://codebuff.com), providing access to multiple LLM models through a unified API powered by your Codebuff subscription.

## Features

- **OpenAI-Compatible API** — Standard `/v1/chat/completions` and `/v1/models` endpoints
- **Anthropic API Support** — `/v1/messages` and `/v1/messages/count_tokens` with automatic format conversion
- **Streaming Support** — SSE streaming for both OpenAI and Anthropic endpoints
- **Single API Key Auth** — Uses your Codebuff API key (`cb-pat-*`) — no token rotation or session management needed
- **Tool Schema Normalization** — Resolves `$ref` and `definitions` in tool schemas before forwarding
- **Dashboard UI** — Liquid glass effects, Bing wallpaper, API key status display
- **Auto-Config** — Automatically configures opencode provider on startup with all available models

## Available Models

Codebuff provides access to these models through your subscription:

| Model | Description |
|-------|-------------|
| `anthropic/claude-sonnet-4.5` | Claude Sonnet 4.5 — balanced performance |
| `anthropic/claude-opus-4.7` | Claude Opus 4.7 — highest quality |
| `openai/gpt-5.1` | GPT-5.1 — OpenAI flagship |
| `openai/gpt-5-nano` | GPT-5 Nano — fast and efficient |
| `google/gemini-3.1-flash-lite` | Gemini 3.1 Flash Lite — Google's lightweight model |
| `kimi/kimi-k2.6` | Kimi K2.6 — Moonshot AI |
| `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro — advanced reasoning |
| `deepseek/deepseek-v4-flash` | DeepSeek V4 Flash — fast inference |

## Authentication

The proxy requires a Codebuff API key. Get one from [codebuff.com/api-keys](https://www.codebuff.com/api-keys).

### Configuration

Add your API key to `.config/config.json`:

```json
{
  "API_KEY": "cb-pat-your-api-key-here"
}
```

Or set the environment variable:

```bash
set CODEBUFF_API_KEY=cb-pat-your-api-key-here
node proxy.js
```

## Installation

```bash
cd CODEBUFF-PROXY
npm install
node proxy.js
```

Or with Bun:
```bash
bun run proxy.js
```

Or use the Windows launchers:
```bash
start.cmd          # Auto-detects Bun, falls back to Node.js
start-node.cmd     # Forces Node.js
```

## Configuration

Edit `.config/config.json` or set environment variables:

| Key | Description | Default |
|-----|-------------|---------|
| `LISTEN_ADDR` | Proxy listen address | `:8080` |
| `UPSTREAM_BASE_URL` | Codebuff backend URL | `https://www.codebuff.com` |
| `API_KEY` | Codebuff API key (`cb-pat-*`) | — |
| `REQUEST_TIMEOUT` | Upstream request timeout | `15m` |
| `API_KEYS` | Client API keys for proxy auth | `[]` (open access) |

### Setting Up Proxy API Keys

By default the proxy is open access — any client can connect. To restrict access, set `API_KEYS` in `.config/config.json`:

```json
{
  "API_KEYS": ["my-secret-key-1", "my-secret-key-2"]
}
```

Or via environment variable (comma-separated):

```bash
set API_KEYS=my-secret-key-1,my-secret-key-2
node proxy.js
```

Clients must then include the key in requests:

```bash
# Using x-api-key header
curl -H "x-api-key: my-secret-key-1" http://localhost:8080/v1/models

# Using Authorization header
curl -H "Authorization: Bearer my-secret-key-1" http://localhost:8080/v1/models
```

## Usage

### OpenAI-Compatible Clients

Point your client to `http://localhost:8080/v1`:

```javascript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:8080/v1',
  apiKey: 'not-needed'
});

const response = await client.chat.completions.create({
  model: 'anthropic/claude-sonnet-4.5',
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

### Anthropic-Compatible Clients

```javascript
const response = await fetch('http://localhost:8080/v1/messages', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'deepseek/deepseek-v4-pro',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Hello!' }]
  })
});
```

### opencode Integration

The proxy automatically configures opencode on startup. Your `opencode.json` (at `~/.opencode/opencode.json`) will include:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "codebuff": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Codebuff Proxy",
      "options": {
        "baseURL": "http://localhost:8080/v1"
      }
    }
  }
}
```

Restart opencode after starting the proxy.

## Dashboard

Access the dashboard at `http://localhost:8080`:

- **API Key Status** — Shows connection status and authenticated user email
- **Liquid Glass Effects** — SVG displacement maps with canvas-generated refraction profiles
- **Bing Wallpaper** — Daily rotating backgrounds via peapix.com
- **Model List** — View all available models
- **SS Mode** — Blur tokens for screenshots
- **Configuration Forms** — Edit listen address, upstream URL, timeouts

## API Endpoints

### Core API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/healthz` | Health check with API key and user status |
| `GET` | `/v1/models` | OpenAI models list |
| `POST` | `/v1/chat/completions` | OpenAI chat completions (streaming supported) |
| `POST` | `/v1/messages` | Anthropic messages (auto-converted to OpenAI) |
| `POST` | `/v1/messages/count_tokens` | Anthropic token counting |

### Management API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/config` | Get current configuration |
| `POST` | `/api/config` | Update configuration |
| `GET` | `/api/validate` | Validate API key |
| `GET` | `/api/models` | List available models |
| `GET` | `/api/bg` | Get Bing wallpaper URL |

## Architecture

```
proxy.js
├── Config System        — JSON + env vars + API key validation
├── UpstreamClient       — HTTP client for Codebuff backend
├── Run Chain Helpers    — Agent run lifecycle
├── Tool Schema Norm.    — $ref resolution and schema normalization
├── HTTP Handlers        — OpenAI + Anthropic + management endpoints
├── Opencode Config      — Auto-configures opencode provider
└── Server Startup       — Validation, config write

dashboard.html
├── Liquid Glass Engine  — Canvas-based displacement/specular maps
├── API Key Status       — Connection and user display
├── Wallpaper Toggle     — Bing daily backgrounds
└── Configuration UI     — Settings forms
```

## Startup Flow

1. `loadConfig()` — Load `.config/config.json` + env vars
2. `UpstreamClient` — Initialize HTTP client with API key
3. `validateApiKey()` — Verify API key via `/api/v1/me`
4. `setupOpencodeConfig()` — Write/update opencode provider config
5. `http.createServer()` — Start HTTP server

## Codebuff Plans

Codebuff offers subscription-based access. See [codebuff.com/pricing](https://www.codebuff.com/pricing) for current plans and pricing.

## Dependencies

No external dependencies — uses Node.js built-in modules only.

Plus Node.js built-ins: `fs`, `path`, `os`, `http`, `https`, `url`, `crypto`.

## License

MIT
