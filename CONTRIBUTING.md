# Contributing to pi-omniroute

Thanks for considering a contribution. This is a small, focused extension — the review bar is
kept deliberately high so the diff stays readable and the data stays honest.

## Ground rules (non-negotiable)

1. **Keyless mode must never break.** `auto` resolves without `OMNIROUTE_API_KEY`; the
   `Authorization` header is only ever added when a real key exists.
2. **Discovery is best-effort.** Catalog fetches must never throw out of the extension
   factory; a dead gateway = curated fallback, never a crash.
3. **Metadata is honest.** Reasoning/vision claims for unknown ids come only from
   `VISION_HINTS` / `REASONING_HINTS`; curated `models.json` entries are real, verified ids
   only — no placeholders, no aspirational model ids.
4. **Curated merge is field-level.** The live catalog wins for existence; curated wins
   per-field for reasoning / vision / names / output limits.

Details live in [AGENTS.md](./AGENTS.md) — read it before touching index.ts, models.ts,
or any of the JSON data files.

## Package manager

The repository is **Bun-native** ([`bun.lock`](./bun.lock), CI uses `oven-sh/setup-bun`).
The scripts are plain TypeScript, so npm/pnpm can run them too, but please don't commit an
extra lockfile (`package-lock.json`, `pnpm-lock.yaml`) — Bun's lockfile is canonical.

## Setting up

```bash
bun install            # dev deps for typechecking
bun run verify         # check + probe + typecheck (the full offline gate)
```

End-to-end (optional, needs the gateway):

```bash
npm i -g omniroute && omniroute   # or: bun i -g omniroute
bun run verify
pi -e .   # then /model → expect "auto" plus the live catalog
```

## Making a change

1. Create a branch off `main` (`fix/…`, `feat/…`, `chore/…`, `refactor/…`, `docs/…`, `ci/…`).
2. Prefer small diffs with a single responsibility. A change that renames a symbol and fixes a
   bug in the same shape gets split up.
3. Keep tests/probe.ts your proof: the probe exercises the factory against a fake gateway
   and fake pi API. When you touch catalog merge / metadata / auth behavior, extend the
   probes — a pre-fix probe must fail, and post-fix it must pass (catch-first).
4. Run `bun run verify` before pushing. Every gate must be green.
5. Commit with a conventional message (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `ci:`,
   `chore:`). Reference the issue when one exists.
6. User-visible changes get a CHANGELOG.md entry under `[Unreleased]`.
7. Open a PR filling the template. The anti-slop gate (`PR quality`) flags low-quality /
   slop PRs automatically; a clear, scoped, evidence-backed PR sails through.

## Releasing

Releases are CI-driven (`.github/workflows/release.yml`) — the only step is pushing a tag:

1. Make sure `package.json` version and the `[Unreleased]` CHANGELOG entry are ready and merged.
2. `git tag vX.Y.Z && git push origin vX.Y.Z` — CI verifies (`bun run verify`), packs the npm
   tarball, and opens a stable GitHub Release with label-driven release notes.
3. Every push to `main` also auto-publishes a `continuous-*` pre-release, so an installable
   artifact always exists for the current build.

Publishing the tarball to npm stays a manual maintainer step (`npm publish` — the
`prepublishOnly` gate runs `bun run verify` first).

## Review expectations

- Bug fixes get a regression probe.
- Metadata changes cite the upstream source the id was verified against
  (OmniRoute `builtinCatalog.ts` for `auto/*` ids, the gateway catalog for the rest).
- The README's env-var table and the code's defaults never drift.
