# 🔀 pi-omniroute

[![quality](https://github.com/ryan-brosas/pi-omniroute/actions/workflows/quality.yml/badge.svg)](https://github.com/ryan-brosas/pi-omniroute/actions/workflows/quality.yml)  [![release](https://github.com/ryan-brosas/pi-omniroute/actions/workflows/release.yml/badge.svg)](https://github.com/ryan-brosas/pi-omniroute/actions/workflows/release.yml)

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

### 2. Install the pi-omniroute package

```bash
pi install npm:pi-omniroute@latest
```

or as a one-off without installing:

```bash
pi -e npm:pi-omniroute
```

Prefer the npm package; for local development, `pi -e /path/to/pi-omniroute` works too.
Install from source instead of npm:

```json
{
  "packages": ["npm:pi-omniroute@latest"],
  "extensions": ["/absolute/path/to/pi-omniroute"]
}
```

### 3. Pick a model

Open the model picker (`/model`) and choose an OmniRoute model:

| Model | Notes |
|-------|-------|
| `auto` | Smart router — auto-picks provider/fallback across tiers (keyless-ready) |
| *(live catalog, e.g. `auto/best-coding`, `google/gemini-3-pro`)* | With the gateway running, `/model` lists the ids it reports on `/v1/models`; whether a given upstream actually serves depends on the credentials configured on your OmniRoute instance |
| *(offline fallback: 37 curated models — `auto` + all built-in `auto/*` routes (`auto/best-coding`, `auto/reasoning:pro`, `auto/vision`, …) + `claude/claude-sonnet-4-6`, `cc/claude-opus-4-6`, `glm/glm-5.2`, …)* | Registered only when the gateway is unreachable, so the `omniroute` provider still exists in `/model` |

> Model ids use the OmniRoute canonical **`<provider>/<model>`** form (e.g. `google/gemini-3-pro`). `auto/*` are OmniRoute's built-in router routes that resolve on demand; the curated fallback ships the full upstream set (verified against the builtin catalog), so the offline picker still offers them. The live catalog replaces the curated fallback whenever the gateway answers; a paid id also needs that upstream's credentials on the gateway side. Non-chat entries (image, embedding, audio, video, …) in the catalog are filtered out — pi only drives chat completions.

## Releases

Release automation lives in the [`release` workflow](.github/workflows/release.yml):

- **Every push to `main`** runs the full gate (`bun run verify`), packs the npm tarball, and
  publishes a `continuous-*` **pre-release** on [GitHub Releases](/releases) — an installable
  artifact always exists for the latest commit.
- **Every `v*` tag** (`v0.3.0`, …) produces a **stable release** on the Releases page with
  generated release notes and the same tarball attached.
- **Publish to npm** — Actions → **npm publish** → Run workflow (or `gh workflow run
  npm-publish.yml`): runs the full gate, optionally takes a `version` input (empty =
  `package.json` version), fails fast when the version already exists on npm, publishes with
  [provenance](https://docs.npmjs.com/generating-provenance-statements) — authenticated via
  [npm trusted publishing](https://docs.npmjs.com/trusted-publishers), no token or GitHub secret —
  and cuts the matching GitHub Release unless the tag release already exists. Manual `npm publish`
  still runs the full gate via `prepublishOnly`.

**One-time npm setup (on npm's website):** on npmjs.com, register trusted publishing for
`ryan-brosas/pi-omniroute` — one entry per publishing workflow: `npm-publish.yml` (on-demand)
and `release.yml` (`v*` tags). Publishing then authenticates with GitHub's OIDC token
(`id-token: write`) — there is no `NPM_TOKEN` and no repository secret anywhere.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OMNIROUTE_BASE_URL` | `http://localhost:20128/v1` | Gateway origin (remote host, custom port, https) |
| `OMNIROUTE_API_KEY` | *(none — keyless)* | Dashboard → Endpoints → API key |
| `OMNIROUTE_CACHE_DIR` | `<agent dir>/cache` | Where the delisted-model tombstone store is kept (the model catalog itself is cached by pi). Keyed to the configured gateway — changing `OMNIROUTE_BASE_URL` starts a fresh tombstone history |

Keyless mode: pick `auto` — OmniRoute answers from the pre-wired free tiers; no token needed, and requests are sent **without** an `Authorization` header. For paid tiers, either export `OMNIROUTE_API_KEY` or run pi’s `/login` and enter the key for the `omniroute` provider (stored in `~/.pi/agent/auth.json`).

## How it works

1. **Zero-latency startup** — the provider registers immediately from the curated `models.json` plus tombstone grace; registration never awaits the network. pi re-resolves the persisted catalog through `refreshModels` on its own cadence.
2. **Platform-native refresh** — the extension implements `ProviderConfig.refreshModels`: pi owns the cadence, the persisted catalog store (`publish({persist})`), and offline/cache-only phases (`allowNetwork`). Each refresh layers live `/v1/models` → curated fields → `patch.json` → `custom-models.json` → tombstoned ids (14-day grace) and hot-swaps the registration. Live discovery runs on interactive sessions (session start and `/model`); headless `pi -p` sessions serve the stored or curated catalog without network.
3. **Fallback** — with no cache and an unreachable gateway, the curated fallback keeps the provider registered.

Each live entry gets metadata (reasoning / vision / context limits) via id heuristics; curated `models.json` fields win per id, and `auto` is always listed first. Catalog errors are non-fatal — a failing fetch never blocks pi startup.

### Model metadata overrides

| File | Role |
| --- | --- |
| `models.json` | Curated offline fallback (hand-maintained) |
| `patch.json` | Per-model corrections applied on top of the live catalog — never creates ids |
| `custom-models.json` | Complete model records for ids the gateway does not advertise; replaces same-id entries wholesale |

## Development

Package manager: **Bun** — the repo ships `bun.lock` and CI runs `oven-sh/setup-bun`. npm can drive the same gates (`npm run verify`), but the check/test scripts execute on the Bun runtime, so `bun` stays a requirement (`tsc` resolves from `node_modules/.bin`, no `bunx` involved). pnpm is not supported: its auto-install blocks unapproved build scripts and rewrites `node_modules`. Only the Bun lockfile is committed.

```bash
bun install --frozen-lockfile   # devDependencies for typechecking
bun run verify                  # check gate + probes + typecheck, one shot
```

- Contributing rules, data curation, and PR conventions: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Changelog: [CHANGELOG.md](./CHANGELOG.md)
- New pull requests are screened by the anti-slop gate ([peakoss/anti-slop](https://github.com/peakoss/anti-slop))

## License

MIT — see [LICENSE](./LICENSE). OmniRoute itself is MIT ([diegosouzapw/OmniRoute](https://github.com/diegosouzapw/OmniRoute)).
