# AGENTS.md

## Project purpose

`pi-omniroute` is a pi extension that registers the self-hosted OmniRoute AI
gateway as an OpenAI-compatible provider via `pi.registerProvider("omniroute", …)`.

## File map

| File | Role |
| --- | --- |
| `index.ts` | Extension factory. Live catalog fetch (`/v1/models`), heuristic metadata (`inferMetadata`), curated merge (`mergeCatalogs`), registration. |
| `models.json` | **Curated fallback** list used when the gateway is unreachable. Hand-maintained — add entries only for real, verified ids. |
| `scripts/check.ts` | Offline validation gate (`bun scripts/check.ts`). |
| `README.md` | User docs. Keep the quickstart and env-var table in sync with code defaults. |

## Ground rules

- **Never break keyless mode.** `auto` must resolve without `OMNIROUTE_API_KEY`; the auth header is only added when a key exists.
- **Discovery is best-effort.** Catalog fetches must never throw out of the factory; always fall back to the curated list.
- **Metadata stays honest.** Vision/thinking for unknown ids comes only from `VISION_HINTS` / `REASONING_HINTS`. Prefer `supportsReasoningEffort: true` (OpenAI-style) over exotic `thinkingFormat` values — the gateway is an OpenAI-compatible front.
- **Curated merge is field-level.** Live catalog wins for existence; curated wins per-field for reasoning / vision / names / output limits.
- **Right-size the catalog.** `MAX_LIVE_CATALOG_ENTRIES` caps registered models at 1000.

## Verification

```bash
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
