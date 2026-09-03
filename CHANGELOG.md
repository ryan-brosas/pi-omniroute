# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-09-03

Release 0.4.0 ships the publishing pipeline: tokenless npm publishing from GitHub Actions via trusted publishing, plus the workflow and docs fixes below.

## [Unreleased]

### Fixed

- npm publishing is single-pathed: npm allows one trusted publisher per package, and GitHub's OIDC token for a reusable-workflow call carries the calling workflow's file — which cannot match a registration on `npm-publish.yml`. The tag-triggered publish job was removed from `release.yml`; `npm-publish.yml` (Actions → npm publish, or `gh workflow run npm-publish.yml`) is the one publish path. README updated to match.

### Added

- `release.yml` release CI — every push to `main` packs the npm tarball after a full
  `bun run verify` and publishes a `continuous-*` pre-release to GitHub Releases; every
  `v*` tag produces a stable release with label-driven release notes and publishes the
  verified tarball to npm with provenance via npm trusted publishing (no token or GitHub
  secret) — an installable artifact always exists after a push.
- `npm-publish.yml` workflow — an on-demand **Run workflow** button that verifies, packs, and
  publishes the package straight to npm (optional `version` input, provenance-attested, fails
  fast on an already-published version).

### Fixed

- `release.yml` artifact hand-off: `actions/download-artifact@v4` extracts a named
  artifact into the workspace root, so both release jobs globbed a
  `pi-omniroute-tarball/` directory that never existed — the workflow had never
  completed. Download steps now extract into `pi-omniroute-tarball/`.

### Changed

- `typecheck` runs `tsc` from `node_modules/.bin` instead of `bunx tsc`: no network
  resolution or lockfile side effects, and the script now behaves identically when
  npm is used as the runner. README no longer claims pnpm support (its auto-install
  blocks unapproved build scripts and rewrites `node_modules`).

## [0.3.0] - 2026-09-03

Release 0.3.0 ships the first npm package (pi-omniroute) plus the catalog-lifecycle and curation work below.

### Changed

- Catalog lifecycle now uses pi's `ProviderConfig.refreshModels` hook: pi owns the cadence, the persisted catalog store (`publish`), and offline/cache-only phases (`allowNetwork`). The extension's own disk cache was dropped; only the gateway-keyed tombstone store remains on disk (`OMNIROUTE_CACHE_DIR`). Test suite rewritten around the hook.
- `tests/probe.ts` derives the offline-fallback size from `models.json` instead of a
  hard-coded count, so curated additions no longer break the probe.
- Package version 0.3.0 (npm publish: tarball ships index.ts, models.ts, curated data, README, LICENSE, CHANGELOG; `pi-package` keyword; peer deps on pi core packages; `prepublishOnly` runs the full gate).

### Added

- `auto/*` built-in router ids to the curated fallback (`models.json`): the full
  upstream-verified `AUTO_TEMPLATE_VARIANTS` + `AUTO_SUFFIX_VARIANTS` set
  (`auto/best-coding`, `auto/reasoning:pro`, `auto/vision`, …), so the offline
  model picker still offers the OmniRoute routes that /v1/models advertises.
- `bun verify` script — runs the shape gate, the behavioral probe, and the typecheck
  in one shot.
- Repository hygiene: `CONTRIBUTING.md`, `SECURITY.md`, PR/issue templates,
  `.editorconfig`, `.gitattributes`.
- `pr-quality.yml` workflow — the [peakoss/anti-slop](https://github.com/peakoss/anti-slop)
  action (pinned v0.3.0) flags low-quality / AI-slop pull requests.
- Dependabot now also tracks `package.json` (`npm` ecosystem, Bun lockfile),
  grouped into a single `js` PR.

## [0.1.0] - 2026-09-02

Initial public release.

### Added

- OmniRoute provider registration (`omniroute`), keyless `auto` model, curated fallback.
- Stale-while-revalidate catalog: zero-latency registration, session_start refresh,
  per-url disk cache, tombstone grace window for delisted models, right-size cap.
- Metadata heuristics (reasoning / vision / context limits) + curated merge layers
  (`models.json`, `patch.json`, `custom-models.json`).
- Quality gate CI (check / test / typecheck) with a required-merge job,
  dependabot for GitHub Actions, MIT license.
