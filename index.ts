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

// ---- Model scope ------------------------------------------------------------
// Which catalog the provider registers. The live gateway advertises every
// routable id (500+), and /v1/models exposes no credential/availability info.
//   active (default) — live ids backed by an active gateway connection
//                      (dashboard /api/providers), unioned with the curated
//                      floor; falls back to the floor when the dashboard API
//                      is unavailable
//   curated          — the static verified floor only (fully offline)
//   routes           — only the auto router + auto/* routes
//   all              — the full live /v1/models catalog (previous behavior)
type ModelScope = "active" | "curated" | "routes" | "all";
const MODEL_SCOPE: ModelScope = (() => {
  const raw = envValue("OMNIROUTE_MODEL_SCOPE").trim().toLowerCase();
  return raw === "curated" || raw === "routes" || raw === "all" ? raw : "active";
})();

const isRouteId = (id: string) => id === "auto" || id.startsWith("auto/");
const prefixOf = (id: string) => id.split("/")[0] ?? id;

// Dashboard origin for the connections API: the gateway serves /v1 and the
// dashboard from the same origin.
const DASHBOARD_URL = baseUrl.replace(/\/v1$/, "");

/**
 * OmniRoute's canonical provider-to-catalog aliases: a standard connection
 * row whose `provider` field routes models under a different catalog prefix
 * (verified against the gateway catalog — a claude connection serves cc/*).
 */
const PROVIDER_CATALOG_ALIASES: Record<string, string> = { claude: "cc" };

/**
 * Prefixes with an enabled backing connection. The connections payload
 * carries masked keys — only isActive, provider, and
 * providerSpecificData.prefix are read, nothing is persisted. Returns null
 * when the dashboard API is unavailable (older gateway, auth-protected) or
 * no connection is enabled: callers then degrade to the curated floor
 * instead of guessing.
 */
async function fetchActivePrefixes(
  apiKey: string | undefined,
  signal?: AbortSignal,
): Promise<Set<string> | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const response = await fetch(`${DASHBOARD_URL}/api/providers`, {
        headers,
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as { connections?: unknown } | null;
      const connections = payload && Array.isArray(payload.connections) ? payload.connections : [];
      const prefixes = new Set<string>();
      for (const raw of connections) {
        if (!raw || typeof raw !== "object") continue;
        const connection = raw as {
          isActive?: unknown;
          provider?: unknown;
          providerSpecificData?: { prefix?: unknown } | null;
        };
        if (connection.isActive === false) continue; // disabled; transient backoff still counts
        // Compatible connections namespace their models under
        // providerSpecificData.prefix; standard API-key/OAuth rows identify
        // via the top-level provider field (mapped through the canonical
        // provider-to-catalog aliases, e.g. claude -> cc). Collect all.
        const psdPrefix = connection.providerSpecificData?.prefix;
        if (typeof psdPrefix === "string" && psdPrefix.trim()) prefixes.add(psdPrefix.trim());
        if (typeof connection.provider === "string" && connection.provider.trim()) {
          const provider = connection.provider.trim();
          prefixes.add(provider);
          const alias = PROVIDER_CATALOG_ALIASES[provider];
          if (alias) prefixes.add(alias);
        }
      }
      return prefixes.size > 0 ? prefixes : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null; // dashboard API unavailable -- degrade to the curated floor
  }
}

function scopedBuild(now = Date.now()): ModelRecord[] {
  // Static build: no live catalog, no store, no tombstones (those only exist
  // for live-delisted ids). Customs are hand-added, so they follow the scope.
  const base = MODEL_SCOPE === "routes" ? curated.filter((m) => isRouteId(m.id)) : curated;
  const customs = MODEL_SCOPE === "routes" ? custom.filter((m) => isRouteId(m.id)) : custom;
  return buildModels(base, customs, patch, {}, now);
}

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
    // Atomic write: a crash mid-write must not truncate the store (a corrupt
    // store silently costs the whole grace window on next load). The tmp file
    // is unique per write so concurrent sessions (each with their own pid)
    // cannot rename each other's unfinished write.
    const tmp = `${TOMBSTONES_PATH}.${process.pid}.${Date.now().toString(36)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(tombstones, null, 2) + "\n");
    fs.renameSync(tmp, TOMBSTONES_PATH);
  } catch {
    /* non-fatal: an unwritable store only costs the grace window */
  }
}

/**
 * Models persisted by a previous pi session, read back from the store.
 * The pi store is keyed only by provider id, so every publication carries the
 * gateway origin and snapshots from another OMNIROUTE_BASE_URL are rejected —
 * an offline session must never serve the previous gateway's catalog.
 */
function readStoredModels(stored: unknown): ModelRecord[] {
  if (!stored || typeof stored !== "object") return [];
  const entry = stored as { models?: unknown; url?: unknown; scope?: unknown };
  // Snapshots are gateway- AND scope-scoped: a catalog persisted under a
  // different scope must not leak across (e.g. an upgrade from a pre-scope
  // all-scope snapshot — no scope field — must not flood the new active
  // default). Mismatched snapshots degrade to the curated floor.
  if (entry.url !== baseUrl || entry.scope !== MODEL_SCOPE) return [];
  return Array.isArray(entry.models)
    ? entry.models.map(asModelRecord).filter((m): m is ModelRecord => m !== null)
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

/**
 * The key used for catalog discovery. Prefers pi's effective credential
 * (a stored /login key) over the env var, but never sends the keyless
 * placeholder when pi reports it as the resolved key.
 */
function effectiveApiKey(context: { credential?: unknown }): string | undefined {
  const credential = context.credential as { type?: unknown; key?: unknown } | undefined;
  if (credential && credential.type === "api_key" && typeof credential.key === "string") {
    if (credential.key.length > 0 && credential.key !== KEYLESS_API_KEY) return credential.key;
  }
  return resolveApiKey();
}

/** Register base + custom + patch, with tombstoned grace models appended. */
function registerModels(pi: ExtensionAPI, models: ModelRecord[]): void {
  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl,
    apiKey: resolveApiKey() ? "$OMNIROUTE_API_KEY" : KEYLESS_API_KEY,
    // Put the resolved key into pi's header pipeline (not just the OpenAI SDK's
    // own auth): the before_provider_headers hook can then strip the keyless
    // placeholder, and a nulled header deletes the SDK-added Authorization.
    authHeader: true,
    api: "openai-completions",
    models,
    refreshModels: (context) => refreshFor(pi, context),
  });
}

/** Startup seed: the auto router (active) / curated floor (all), no network. */
function seedModels(now = Date.now()): ModelRecord[] {
  if (MODEL_SCOPE === "all") return buildModels(curated, custom, patch, loadTombstones(), now);
  if (MODEL_SCOPE === "active") {
    // Keyless workhorse only: the bare auto router seeds the picker until the
    // first online refresh learns the active connection prefixes. The curated
    // floor's direct ids (claude/..., glm/...) are NOT registered here — the
    // active scope mirrors what the gateway connections actually back.
    const auto = curated.find((m) => m.id === "auto");
    return auto ? [auto] : [];
  }
  return scopedBuild(now);
}

/**
 * pi-owned refresh: fetch -> merge -> tombstone reconcile -> publish -> swap.
 * Never throws: every failure degrades to stored or curated models.
 */
async function refreshFor(
  pi: ExtensionAPI,
  context: RefreshModelsContext,
): Promise<ProviderModelConfig[]> {
  const now = Date.now();
  const tombstonesFor = () => (MODEL_SCOPE === "all" ? loadTombstones() : {});
  // Static scopes (curated / routes): no network, no store, and no
  // re-registration (pi's registration hook fires an offline refresh —
  // registering again here would loop). The returned list replaces the
  // extension models via the composed refresh wrapper.
  if (MODEL_SCOPE !== "active" && MODEL_SCOPE !== "all") return scopedBuild(now);
  const apiKey = effectiveApiKey(context);
  const stored = readStoredModels(context.stored);
  if (!context.allowNetwork) {
    // Cache-only phase: serve the persisted catalog without any fetch.
    return buildModels(stored.length > 0 ? stored : curated, custom, patch, tombstonesFor(), now);
  }
  const live = await fetchLiveCatalog(apiKey, context.signal);
  if (live && live.length > 0) {
    // Active scope: a visibility cut — keep the auto routes and ids whose
    // connection prefix is active (/api/providers). The gateway routes by
    // model name, so this is a picker cut, not a resolvability claim; ids
    // outside it still work via a custom model id. The curated floor is
    // always unioned in. Without a dashboard API, degrade to the floor.
    const prefixes = MODEL_SCOPE === "active" ? await fetchActivePrefixes(apiKey, context.signal) : null;
    // Active cut: the bare auto router plus ids whose connection prefix is
    // active. The auto/* variants and the curated floor's direct ids are not
    // registered here (they still resolve when typed as custom model ids —
    // the gateway routes by model name). No curated union: the picker
    // mirrors what the gateway connections actually back.
    const visible =
      MODEL_SCOPE === "active"
        ? live.filter((m) => m.id === "auto" || (prefixes?.has(prefixOf(m.id)) ?? false))
        : live;
    const base = mergeCatalogs(visible, curated);
    const tombstones = MODEL_SCOPE === "all" ? reconcileTombstones(stored, loadTombstones(), base, now) : {};
    if (MODEL_SCOPE === "all") saveTombstones(tombstones);
    const models = buildModels(base, custom, patch, tombstones, now);
    const entry = { models: base, checkedAt: now, url: baseUrl, scope: MODEL_SCOPE } as unknown as ModelsStoreEntry;
    try {
      await context.publish({
        persist: entry,
        update: () => registerModels(pi, models),
      });
    } catch {
      // pi refused the publication (store write failure, shutdown race): keep
      // the merged catalog hot-swapped for this session. refreshModels still
      // never throws.
      registerModels(pi, models);
    }
    return models;
  }
  // Gateway unreachable / empty: keep the current catalog, no store mutation.
  const fallback = stored.length > 0 ? stored : curated;
  const models = buildModels(fallback, custom, patch, tombstonesFor(), now);
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
