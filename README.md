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
| *(live catalog, e.g. `auto/best-coding`, `google/gemini-3-pro`)* | With the gateway running, `/model` lists the ids it reports on `/v1/models`; whether a given upstream actually serves depends on the credentials configured on your OmniRoute instance |
| *(offline fallback: `claude/claude-sonnet-4-6`, `cc/claude-opus-4-6`, `glm/glm-5.2`, …)* | Registered only when the gateway is unreachable, so the `omniroute` provider still exists in `/model` |

> Model ids use the OmniRoute canonical **`<provider>/<model>`** form (e.g. `google/gemini-3-pro`). The live catalog replaces the curated fallback whenever the gateway answers; a paid id also needs that upstream's credentials on the gateway side. Non-chat image and video entries in the catalog are filtered out — pi only drives chat completions.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMNIROUTE_BASE_URL` | `http://localhost:20128/v1` | Gateway origin (remote host, custom port, https) |
| `OMNIROUTE_API_KEY` | *(none — keyless)* | Dashboard → Endpoints → API key |
| `OMNIROUTE_CACHE_DIR` | `<agent dir>/cache` | Where the merged catalog cache is written (useful for tests / sandboxed homes) |

Keyless mode: pick `auto` — OmniRoute answers from the pre-wired free tiers; no token needed. For paid tiers, either export `OMNIROUTE_API_KEY` or run pi’s `/login` and enter the key for the `omniroute` provider (stored in `~/.pi/agent/auth.json`).

## How it works

1. **Zero-latency startup** — the provider registers immediately from the disk cache ∪ the curated `models.json`; registration never awaits the network.
2. **Background revalidation** — on `session_start` the extension re-fetches `{OMNIROUTE_BASE_URL}/models`, layers the result (live entries → curated fields → `patch.json` overrides → `custom-models.json` additions → tombstoned ids on a 14-day grace), writes the merged catalog to the disk cache, and hot-swaps the registration — new models appear on later sessions without a pi restart.
3. **Fallback** — with no cache and an unreachable gateway, the curated fallback keeps the provider registered.

Each live entry gets metadata (reasoning / vision / context limits) via id heuristics; curated `models.json` fields win per id, and `auto` is always listed first. Catalog errors are non-fatal — a failing fetch never blocks pi startup.

### Model metadata overrides

| File | Role |
| --- | --- |
| `models.json` | Curated offline fallback (hand-maintained) |
| `patch.json` | Per-model corrections applied on top of the live catalog — never creates ids |
| `custom-models.json` | Complete model records for ids the gateway does not advertise; replaces same-id entries wholesale |

## Development

```bash
bun scripts/check.ts      # shape + export gate (no deps needed)
bun tests/probe.ts        # behavioral probes against a simulated gateway
bun install               # once, for dev typechecking
bunx tsc --noEmit         # typecheck against pi's ExtensionAPI surface
```

## License

MIT — see [LICENSE](./LICENSE). OmniRoute itself is MIT ([diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute)).
