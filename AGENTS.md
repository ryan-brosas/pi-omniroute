| `scripts/check.ts` | Offline validation gate (`bun scripts/check.ts`) |
| `tests/probe.ts` | Behavioral probes against a fake gateway + fake pi API (`bun tests/probe.ts`) |
| `CONTRIBUTING.md` | Contributor rules: data curation, PR hygiene, `bun verify` |
| `SECURITY.md` | Reporting + scope. Keyless mode must never send a placeholder key |
| `CHANGELOG.md` | Keep a Changelog; user-visible changes get an entry under `[Unreleased]` |
| `.github/` | quality.yml gates (check/test/typecheck + required job), release.yml (stable `v*` + per-push continuous GitHub Releases + npm publish on `v*` tags), npm-publish.yml (on-demand npm publish, workflow_dispatch), pr-quality.yml anti-slop gate, dependabot (actions + npm), PR/issue templates |
| `README.md` | User docs. Keep the quickstart and env-var table in sync with code defaults |# AGENTS.md

## Project purpose

`pi-omniroute` is a pi extension that registers the self-hosted OmniRoute AI
gateway as an OpenAI-compatible provider via `pi.registerProvider("omniroute", …)`.

## File map

| File | Role |
| --- | --- |
| `index.ts` | Extension factory. Stale-while-revalidate catalog: disk cache, live fetch (`/v1/models`), tombstone reconciliation, registration. |
| `models.ts` | Pure model pipeline (heuristics, transform, merge, patch/custom/tombstone layers) — offline-testable, no pi runtime or fs. |
| `models.json` | **Curated fallback** floor for when the gateway is unreachable and no cache exists. Hand-maintained — add entries only for real, verified ids. |
| `patch.json` | Per-model corrections (reasoning / vision / names / limits / cost) applied on top of the live catalog. Never creates ids. |
| `custom-models.json` | Complete records for ids the gateway does not advertise; replaces same-id base entries wholesale. |
| `scripts/check.ts` | Offline validation gate (`bun scripts/check.ts`). |
| `README.md` | User docs. Keep the quickstart and env-var table in sync with code defaults. |

## Ground rules

- **Never break keyless mode.** `auto` must resolve without `OMNIROUTE_API_KEY`. pi requires a configured `apiKey` to keep models visible, so a local placeholder is used — but `before_provider_headers` strips it from outgoing requests: real keys (`OMNIROUTE_API_KEY` or `/login`) pass through, keyless sends no credentials at all.
- **Discovery is best-effort.** Catalog fetches must never throw out of the factory; always fall back to the curated list.
- **Metadata stays honest.** Vision/thinking for unknown ids comes only from `VISION_HINTS` / `REASONING_HINTS`. Prefer `supportsReasoningEffort: true` (OpenAI-style) over exotic `thinkingFormat` values — the gateway is an OpenAI-compatible front.
- **Curated merge is field-level.** Live catalog wins for existence; curated wins per-field for reasoning / vision / names / output limits.
- **Curated ids are verified, tag** `models.json` carries only real, upstream-verified ids — including the built-in `auto/*` routes (`auto/best-coding`, `auto/reasoning:pro`, …) from OmniRoute's `open-sse/services/autoCombo/builtinCatalog.ts`. Never add an aspirational id; the `auto/*` set is already the full upstream catalog.
- **Catalog lifecycle is platform-native.** The provider implements `ProviderConfig.refreshModels` (pi-owned store / publish / offline phases); index.ts keeps no catalog cache on disk — only the tombstone sidecar (OMNIROUTE_CACHE_DIR) survives between sessions.
- **PR gates exist.** `pr-quality.yml` runs the pinned anti-slop action; keep PRs scoped, evidence-backed, and free of AI slop filler. Hand edits go to `patch.json` (corrections, wins over everything per-field) and `custom-models.json` (extra ids); `models.json` is the offline floor. Tombstones keep recently-delisted ids alive for 14 days (cache file, runtime-written).
- **Right-size the catalog.** The registered catalog is capped at 1000 (`MAX_REGISTERED_MODELS` in `models.ts`, priority: auto → customs → live → tombstones); the live fetch is additionally trimmed by `MAX_LIVE_CATALOG_ENTRIES`. The disk cache is keyed to the configured base URL — switching `OMNIROUTE_BASE_URL` starts a fresh catalog.

## Verification

```bash
bun run verify           # check + probe + typecheck in one shot
# or individually:
bun scripts/check.ts      # shape + export smoke gate
bun tests/probe.ts        # behavioral probes (fake gateway + fake pi API)
bunx tsc --noEmit         # typecheck against pi types (needs bun install once)
```

End-to-end: run the gateway (`npm i -g omniroute && omniroute`), then `pi -e .`
→ `/model` → expect `auto` plus the live catalog.

## Reference

- pi custom-provider doc (in pi docs) for `ProviderConfig` / registration
- pi types: `@earendil-works/pi-coding-agent` exports `ExtensionAPI`, `ProviderConfig`, `ProviderModelConfig`
- OmniRoute: <https://github.com/diegosouzapw/OmniRoute> — endpoint `http://localhost:20128/v1`, keys from the dashboard
