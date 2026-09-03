/**
 * OmniRoute provider extension for pi.
 *
 * Registers the self-hosted OmniRoute AI gateway (github.com/diegosouzapw/OmniRoute)
 * as a pi provider over its OpenAI-compatible API (/v1/chat/completions).
 *
 * The gateway routes to 350+ upstream providers (Claude, GPT, Gemini, Kimi, GLM,
 * DeepSeek, MiniMax, ...) with quota-aware auto-fallback across subscription /
 * API-key / cheap / free tiers, plus optional RTK + Caveman token compression.
 * It works keyless out of the box via the pre-wired free tiers on the "auto" model.
 *
 *   Base URL   http://localhost:20128/v1   (override with OMNIROUTE_BASE_URL)
 *   Auth       Authorization: Bearer <dashboard key>   (optional; keyless "auto")
 *   Models     pi-owned catalog (ProviderConfig.refreshModels)
 *
 * Model lifecycle (pi-native, best-effort, never fatal):
   1. Startup -- register immediately with the curated seed + tombstone grace.
   2. Refresh -- refreshModels() hook; pi owns cadence and persisted catalog
      (context.stored / publish({persist})). Offline (allowNetwork false) serves
      the stored catalog without fetching; otherwise /v1/models is merged
      live -> curated fields -> patch.json -> custom-models.json -> tombstones
      (14-day grace), then published and hot-swapped.
   3. Fallback -- no stored catalog + unreachable gateway = curated fallback.
 */
import {
  getAgentDir,
  type ExtensionAPI,
  type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import type { ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
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
// pi hides models without a configured apiKey; the gateway accepts this
// placeholder for keyless routes. A stored /login credential still wins.
const KEYLESS_API_KEY = "keyless";

function envValue(name: string): string {
  return typeof process !== "undefined" ? (process.env[name] ?? "") : "";
}

/** Gateway origin, normalized without a trailing slash. */
const baseUrl = (envValue("OMNIROUTE_BASE_URL") || DEFAULT_BASE_URL).replace(/\/+$/, "");

// ---- Hand-edit layers -------------------------------------------------------

const curated = fallbackModelsData as ModelRecord[];
const custom = (customModelsData as ModelRecord[]).filter((m) => !!m?.id);
const patch = patchData as PatchData;

// ---- Tombstone store (the only thing kept on disk) ------------------------
// The catalog itself is owned by pi (publish({ persist })); this dir holds
// only the gateway-keyed tombstone grace for recently-delisted models.

const CACHE_DIR = envValue("OMNIROUTE_CACHE_DIR").trim() || path.join(getAgentDir(), "cache");

/**
 * Tombstone file keyed to the configured gateway: switching OMNIROUTE_BASE_URL
 * never imports another gateway delist history. Legacy unscoped
 * omniroute-models.json files (pre-refreshModels versions) are ignored.
 */
export function tombstonesFilePathFor(origin: string): string {
  let hash = 5381;
  for (let i = 0; i < origin.length; i++) {
    hash = ((hash << 5) + hash + origin.charCodeAt(i)) >>> 0;
  }
  return path.join(CACHE_DIR, `omniroute-tombstones-${hash.toString(16)}.json`);
}

const TOMBSTONES_PATH = tombstonesFilePathFor(baseUrl);

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

function loadTombstones(): Tombstones {
  try {
    const parsed = JSON.parse(fs.readFileSync(TOMBSTONES_PATH, "utf8")) as unknown;
    return sanitizeTombstones(parsed);
  } catch {
    return {}; // missing/corrupt store removes grace, never fatal
  }
}

function saveTombstones(tombstones: Tombstones): void {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(TOMBSTONES_PATH, JSON.stringify(tombstones, null, 2) + "\n");
  } catch {
    /* non-fatal: an unwritable store only costs the grace window */
  }
}

/** Models persisted by a previous pi session, read back from the store. */
function readStoredModels(stored: unknown): ModelRecord[] {
  if (!stored || typeof stored !== "object") return [];
  const raw = (stored as { models?: unknown }).models;
  return Array.isArray(raw)
    ? raw.map(asModelRecord).filter((m): m is ModelRecord => m !== null)
    : [];
}

// ---- Fetching the live catalog -------------------------------------------

async function fetchLiveCatalog(
  apiKey: string | undefined,
  signal?: AbortSignal,
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
    return null; // unreachable gateway, auth failure, timeout -- non-fatal
  }
}

// ---- Tombstone reconciliation --------------------------------------------

/**
 * Tombstone ids the live catalog dropped; resurrect ids it brought back.
 * The deprecatedAt clock never resets while a model stays delisted.
 */
function reconcileTombstones(
  prevModels: ModelRecord[],
  prevTombstones: Tombstones,
  live: ModelRecord[],
  now: number,
): Tombstones {
  const liveIds = new Set(live.map((m) => m.id));
  const next: Tombstones = {};
  for (const [id, tombstone] of Object.entries(prevTombstones)) {
    if (!liveIds.has(id)) next[id] = tombstone;
  }
  for (const model of prevModels) {
    if (!liveIds.has(model.id) && !next[model.id]) {
      next[model.id] = { deprecatedAt: new Date(now).toISOString(), model };
    }
  }
  return next;
}

// ---- Registration ---------------------------------------------------------

function resolveApiKey(): string | undefined {
  const key = envValue("OMNIROUTE_API_KEY").trim();
  return key || undefined;
}

/** Register base + custom + patch, with tombstoned grace models appended. */
function registerModels(pi: ExtensionAPI, models: ModelRecord[]): void {
  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl,
    apiKey: resolveApiKey() ? "$OMNIROUTE_API_KEY" : KEYLESS_API_KEY,
    api: "openai-completions",
    models,
    refreshModels: (context) => refreshFor(pi, context),
  });
}

/** Startup seed: curated core, no network. Tombstones keep grace from disk. */
function seedModels(now = Date.now()): ModelRecord[] {
  return buildModels(curated, custom, patch, loadTombstones(), now);
}

/**
 * pi-owned refresh: fetch -> merge -> tombstone reconcile -> publish -> swap.
 * Never throws: every failure degrades to stored or curated models.
 */
async function refreshFor(
  pi: ExtensionAPI,
  context: RefreshModelsContext,
): Promise<ProviderModelConfig[]> {
  const apiKey = resolveApiKey();
  const stored = readStoredModels(context.stored);
  if (!context.allowNetwork) {
    // Cache-only phase: serve the persisted catalog without any fetch.
    return buildModels(stored.length > 0 ? stored : curated, custom, patch, loadTombstones());
  }
  const now = Date.now();
  const live = await fetchLiveCatalog(apiKey, context.signal);
  if (live && live.length > 0) {
    const base = mergeCatalogs(live, curated);
    const tombstones = reconcileTombstones(stored, loadTombstones(), base, now);
    saveTombstones(tombstones);
    const models = buildModels(base, custom, patch, tombstones, now);
    const entry = { models: base, checkedAt: now } as unknown as ModelsStoreEntry;
    await context.publish({
      persist: entry,
      update: () => registerModels(pi, models),
    });
    return models;
  }
  // Gateway unreachable / empty: keep the current catalog, no store mutation.
  const fallback = stored.length > 0 ? stored : curated;
  const models = buildModels(fallback, custom, patch, loadTombstones(), now);
  registerModels(pi, models);
  return models;
}

export default function (pi: ExtensionAPI): void {
  // 1. Zero-latency startup: register the curated seed immediately;
  //    registration never awaits the network. pi re-resolves the catalog
  //    through refreshModels on its own cadence.
  registerModels(pi, seedModels());

  // Keyless requests carry no credentials. pi requires a configured apiKey to
  // keep models visible in the picker, so the placeholder is local only: strip
  // it from outgoing requests; real credentials pass through untouched.
  const placeholderAuth = `bearer ${KEYLESS_API_KEY}`;
  pi.on("before_provider_headers", (event, ctx) => {
    if (ctx.model?.provider !== PROVIDER_ID) return;
    const auth = event.headers["authorization"] ?? event.headers["Authorization"];
    if (auth && auth.toLowerCase() === placeholderAuth) {
      event.headers["authorization"] = null;
    }
  });
}
