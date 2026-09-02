# 🔀 pi-omniroute

[![quality](https://github.com/ryan-brosas/pi-omniroute/actions/workflows/quality.yml/badge.svg)](https://github.com/ryan-brosas/pi-omniroute/actions/workflows/quality.yml)

**OmniRoute as an LLM provider for [pi](https://github.com/earendil-works/pi-coding-agent).**

A pi extension that registers the self-hosted [OmniRoute](https://github.com/diegosouzapw/OmniRoute) AI gateway as a native provider. One local endpoint routes pi requests across **350+ upstream providers** (Claude, GPT, Gemini, Kimi, GLM, DeepSeek, MiniMax, …) with quota-aware auto-fallback across subscription → API-key → cheap → free tiers and optional RTK + Caveman token compression.

- ⚡ **Zero-config** — works keyless out of the box via the pre-wired free tiers (`auto` model)
- 🧭 **Live model discovery** — the `/v1/models` catalog is fetched on startup and refreshed on later sessions
- 🔑 **API-key or keyless** — set `OMNIROUTE_API_KEY` (or store via `/login omniroute`) for paid-tier routing
- 📦 **OpenAI-compatible** — streams over `/v1/chat/completions` with tools, vision, and `reasoning_effort`

## Quickstart

### 1. Run the OmniRoute gateway

```bash
npm i -g omniroute
omniroute                # boots gateway + dashboard on http://localhost:20128
```

Docker, source, pnpm installs: see [OmniRoute docs](https://github.com/diegosouzapw/OmniRoute).

### 2. Add this extension to pi

```bash
pi -e /path/to/pi-omniroute
```

or in `~/.pi/agent/pi.json` (or a project config):

```json
{
  "extensions": ["/absolute/path/to/pi-omniroute"]
}
```

### 3. Pick a model

Open the model picker (`/model`) and choose an OmniRoute model:

| Model | Notes |
|-------|-------|
| `auto` | Smart router — auto-picks provider/fallback across tiers (keyless-ready) |
| `claude/claude-sonnet-4-6`, `cc/claude-sonnet-4-6` | Claude Sonnet 4.6 via gateway |
| `cc/claude-opus-4-6` | Claude Opus 4.6 via the gateway |
| `glm/glm-5.2` | GLM 5.2 |
| `cheaperinference/claude-sonnet-4-6` | Cheaper Inference budget route |
| *(hundreds more)* | Added automatically from the gateway’s `/v1/models` when it is reachable |

> Model ids use the OmniRoute canonical **`<provider>/<model>`** form (e.g. `google/gemini-3-pro`). The full catalog comes from the live gateway; the entries above are only the curated fallback for when the gateway is unreachable.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMNIROUTE_BASE_URL` | `http://localhost:20128/v1` | Gateway origin (remote host, custom port, https) |
| `OMNIROUTE_API_KEY` | *(none — keyless)* | Dashboard → Endpoints → API key |

Keyless mode: pick `auto` — OmniRoute answers from the pre-wired free tiers; no token needed. For paid tiers, either export `OMNIROUTE_API_KEY` or run pi’s `/login` and enter the key for the `omniroute` provider (stored in `~/.pi/agent/auth.json`).

## How it works

1. On startup the extension fetches `{OMNIROUTE_BASE_URL}/models`.
2. Each live entry gets metadata (reasoning / vision / context limits) via id heuristics, then curated `models.json` fields win per id.
3. `auto` is always listed first; the gateway’s (trimmed) catalog is registered with pi.
4. If the gateway is down, the curated fallback keeps the provider registered; `session_start` re-fetches so new models appear on later sessions without a pi restart.

Catalog errors are non-fatal — a failing fetch never blocks pi startup.

## Development

```bash
bun scripts/check.ts      # shape + export gate (no deps needed)
bun tests/probe.ts        # behavioral probes against a simulated gateway
bun install               # once, for dev typechecking
bunx tsc --noEmit         # typecheck against pi's ExtensionAPI surface
```

## License

MIT — see [LICENSE](./LICENSE). OmniRoute itself is MIT ([diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute)).

[//]: # (ci probe)
