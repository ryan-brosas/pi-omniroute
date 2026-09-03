/**
 * OmniRoute provider extension for pi
 *
 * Registers the self-hosted OmniRoute AI gateway (github.com/diegosouzapw/OmniRoute)
 * as a pi provider over its OpenAI-compatible API ( /v1/chat/completions ).
 *
 * The gateway exposes one endpoint that routes to 350+ upstream providers
 * (Claude, GPT, Gemini, Kimi, GLM, DeepSeek, MiniMax, …) with quota-aware
 * auto-fallback across subscription / API-key / cheap / free tiers, plus
 * optional RTK + Caveman token compression. It works keyless out of the box
 * through the pre-wired free tiers when you call the "auto" model.
 *
 *   Base URL    http://localhost:20128/v1   (override with OMNIROUTE_BASE_URL)
 *   Auth        Authorization: Bearer <dashboard key>   (optional, keyless "auto")
 *   Models      stale-while-revalidate catalog (see below)
 *
 * Model discovery (stale-while-revalidate, best-effort, never fatal):
 *   1. Startup  – register immediately from the disk cache ∪ curated
 *                 models.json. Zero latency: registration never awaits the
 *                 network, so the model picker is ready instantly.
 *   2. Refresh  – session_start re-fetches {base}/models in the background
 *                 and hot-swaps the registration. The merged catalog is
 *                 layered live → curated fields → patch.json →
 *                 custom-models.json → tombstoned ids (14-day grace), then
 *                 written to the disk cache for the next session.
 *   3. Fallback – with no cache and an unreachable gateway, the curated
 *                 fallback list keeps the provider registered.
 *
 * Usage:
 *   npm i -g omniroute && omniroute        # run the gateway (port 20128)
 *   export OMNIROUTE_API_KEY=…             # optional; or store via /login
 *   pi -e /path/to/pi-omniroute
 *   /model → "auto" or e.g. "claude/claude-sonnet-4-6"
 */
import {
  getAgentDir,
  type ExtensionAPI,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import fallbackModelsData from "./models.json" with { type: "json" };
import customModelsData from "./custom-models.json" with { type: "json" };
import patchData from "./patch.json" with { type: "json" };
import {
  asModelRecord,
  buildModels,
  mergeCatalogs,
  transformCatalogModel,
  type CatalogEntry,
  type ModelRecord,
  type PatchData,
  type Tombstones,
} from "./models.ts";

// Public pipeline surface (used by scripts/check.ts and tests/probe.ts).
export { inferMetadata, transformCatalogModel, mergeCatalogs } from "./models.ts";

const PROVIDER_ID = "omniroute";
const PROVIDER_NAME = "OmniRoute";
const DEFAULT_BASE_URL = "http://localhost:20128/v1";
const FETCH_TIMEOUT_MS = 8000;
const MAX_LIVE_CATALOG_ENTRIES = 1000;
// pi hides models without configured auth. OmniRoute accepts this placeholder
// for keyless routes; a stored /login credential still takes precedence.
const KEYLESS_API_KEY = "keyless";

function envValue(name: string): string {
  return typeof process !== "undefined" ? (process.env[name] ?? "") : "";
}

/** Gateway origin, normalized without a trailing slash. */
const baseUrl = (envValue("OMNIROUTE_BASE_URL") || DEFAULT_BASE_URL).replace(/\/+$/, "");

// ─── Hand-edit layers ─────────────────────────────────────────────────────────

const curated = fallbackModelsData as ModelRecord[];
const custom = (customModelsData as ModelRecord[]).filter((m) => !!m?.id);
const patch = patchData as PatchData;

// ─── Disk cache (stale-while-revalidate) ──────────────────────────────────────

interface CacheFile {
  /** Last successfully merged live catalog (without customs/tombstoned extras). */
  models: ModelRecord[];
  /** Ids the gateway dropped, kept for a grace window with their last record. */
  tombstones: Tombstones;
}

const CACHE_DIR =
  envValue("OMNIROUTE_CACHE_DIR").trim() || path.join(getAgentDir(), "cache");
const CACHE_PATH = path.join(CACHE_DIR, "omniroute-models.json");

function sanitizeTombstones(value: unknown): Tombstones {
  const out: Tombstones = {};
  if (!value || typeof value !== "object") return out;
  for (const [id, tombstone] of Object.entries(value as Record<string, unknown>)) {
    if (!id || !tombstone || typeof tombstone !== "object") continue;
    const t = tombstone as { deprecatedAt?: unknown; model?: unknown };
    if (typeof t.deprecatedAt !== "string") continue;
    const model = asModelRecord(t.model);
    if (model) out[id] = { deprecatedAt: t.deprecatedAt, model };
  }
  return out;
}

function loadCache(): CacheFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const raw = parsed as { models?: unknown; tombstones?: unknown };
    const models = Array.isArray(raw.models)
      ? raw.models.map(asModelRecord).filter((m): m is ModelRecord => m !== null)
      : [];
    const tombstones = sanitizeTombstones(raw.tombstones);
    if (models.length === 0 && Object.keys(tombstones).length === 0) return null;
    return { models, tombstones };
  } catch {
    return null; // missing/corrupt cache — degrade to the curated fallback
  }
}

function saveCache(models: ModelRecord[], tombstones: Tombstones): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify({ models, tombstones }, null, 2) + "\n");
  } catch {
    /* non-fatal: an unwritable cache only costs next-session freshness */
  }
}

/** Cache ∪ curated — a stale cache must not hide newly curated models. */
function loadStaleModels(cache: CacheFile | null): ModelRecord[] {
  if (!cache) return [...curated];
  const merged = new Map(cache.models.map((m) => [m.id, m]));
  for (const model of curated) {
    if (!merged.has(model.id)) merged.set(model.id, model);
  }
  return [...merged.values()];
}

// ─── Model metadata heuristics ────────────────────────────────────────────────
// (moved to models.ts; inferMetadata/transformCatalogModel/mergeCatalogs are
// re-exported above for scripts/check.ts and tests/probe.ts)

// ── Fetching the live catalog ─────────────────────────────────────────────────

async function fetchLiveCatalog(
  apiKey: string | undefined,
  signal?: AbortSignal
): Promise<ModelRecord[] | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const response = await fetch(`${baseUrl}/models`, {
        headers,
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as { data?: unknown } | unknown[] | null;
      const entries = Array.isArray(payload)
        ? payload
        : (payload as { data?: unknown } | null)?.data;
      if (!Array.isArray(entries) || entries.length === 0) return null;

      const seen = new Set<string>();
      const models: ModelRecord[] = [];
      for (const raw of entries) {
        const entry = raw as CatalogEntry;
        const id = typeof entry?.id === "string" ? entry.id : "";
        if (!id || seen.has(id)) continue;
        const model = transformCatalogModel(entry);
        if (!model) continue;
        seen.add(id);
        models.push(model);
        if (models.length >= MAX_LIVE_CATALOG_ENTRIES) break;
      }
      return models.length > 0 ? models : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null; // unreachable gateway, 401 keyless, or timeout — all non-fatal
  }
}

// ─── Tombstone reconciliation ─────────────────────────────────────────────────

/**
 * Tombstone ids the live catalog dropped; resurrect ids it brought back.
 * The deprecatedAt clock never resets while a model stays delisted.
 */
function reconcileTombstones(prev: CacheFile | null, merged: ModelRecord[], now: number): Tombstones {
  const live = new Set(merged.map((m) => m.id));
  const next: Tombstones = {};
  for (const [id, tombstone] of Object.entries(prev?.tombstones ?? {})) {
    if (!live.has(id)) next[id] = tombstone;
  }
  for (const model of prev?.models ?? []) {
    if (!live.has(model.id) && !next[model.id]) {
      next[model.id] = { deprecatedAt: new Date(now).toISOString(), model };
    }
  }
  return next;
}

// ─── Registration ─────────────────────────────────────────────────────────────

function resolveApiKey(): string | undefined {
  const key = envValue("OMNIROUTE_API_KEY").trim();
  return key || undefined;
}

// One config factory so the streaming config and the model list never desync.
function makeProviderConfig(models: ModelRecord[]): ProviderConfig {
  return {
    name: PROVIDER_NAME,
    baseUrl,
    apiKey: resolveApiKey() ? "$OMNIROUTE_API_KEY" : KEYLESS_API_KEY,
    api: "openai-completions",
    models,
  };
}

/** Register base ∪ custom ∪ patch ∪ tombstones. */
function registerCatalog(pi: ExtensionAPI, base: ModelRecord[], tombstones: Tombstones): void {
  pi.registerProvider(PROVIDER_ID, makeProviderConfig(buildModels(base, custom, patch, tombstones)));
}

interface Revalidated {
  base: ModelRecord[];
  tombstones: Tombstones;
}

async function revalidate(
  signal: AbortSignal,
  prev: CacheFile | null,
  now = Date.now(),
): Promise<Revalidated | null> {
  const live = await fetchLiveCatalog(resolveApiKey(), signal);
  if (!live || live.length === 0) return null;
  const base = mergeCatalogs(live, curated);
  const tombstones = reconcileTombstones(prev, base, now);
  saveCache(base, tombstones);
  return { base, tombstones };
}

export default function (pi: ExtensionAPI): void {
  const cache = loadCache();

  // 1. Zero-latency startup — serve stale (cache ∪ curated) immediately;
  //    registration never awaits the network.
  registerCatalog(pi, loadStaleModels(cache), cache?.tombstones ?? {});

  // 2. Refresh on session start (gateway may have come online, added models,
  //    or had its catalog regenerated between sessions).
  let refreshAbort: AbortController | null = null;
  pi.on("session_start", async () => {
    refreshAbort?.abort();
    const controller = new AbortController();
    refreshAbort = controller;
    try {
      const fresh = await revalidate(controller.signal, loadCache());
      if (fresh && !controller.signal.aborted) {
        registerCatalog(pi, fresh.base, fresh.tombstones);
      }
    } catch {
      // non-fatal: a failing refresh never blocks a session
    }
  });
}
