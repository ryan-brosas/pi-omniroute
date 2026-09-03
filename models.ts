/**
 * Pure model-catalog pipeline for the OmniRoute provider extension.
 *
 * No pi runtime and no fs access here — everything is offline-testable;
 * index.ts owns IO (live fetch, disk cache) and registration. Precedence
 * (highest wins, applied last):
 *
 *   live /v1/models    ─┐
 *   models.json         ├─ mergeCatalogs() ─► base   live wins existence,
 *   (curated fallback) ─┘                            curated wins fields
 *   custom-models.json ─► replaces same-id base entries wholesale / adds ids
 *   patch.json         ─► per-field overrides on top (never creates ids)
 *   tombstones         ─► recently-delisted ids kept for a grace window
 */
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export type ModelRecord = ProviderModelConfig;

// ─── Gateway /v1/models payload ───────────────────────────────────────────────

export interface CatalogEntry {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
  max_output_tokens?: unknown;
  type?: unknown;              // "image" etc. — gateway catalogs mix in non-chat entries
  output_modalities?: unknown; // e.g. ["image"] for Stable-Diffusion-style ids
}

// pi only drives chat completions: any entry typed as one of these is dropped,
// not just image generators (embedding/audio/video models would register and
// then fail at request time).
const NON_CHAT_TYPES = new Set(["image", "embedding", "audio", "video", "rerank", "moderation"]);

// ─── Model metadata heuristics ────────────────────────────────────────────────
// The gateway's /v1/models does not reliably report reasoning or vision for
// every entry; providers expose ids both bare ("gemini-2.5-pro") and prefixed
// ("google/gemini-3-pro"). These lists classify the *stem* of the id.

const REASONING_HINTS = [
  "claude-opus", "claude-sonnet", "claude-haiku", "claude-3-7",
  "gpt-5", "o1-", "o3-", "o4-",
  "gemini-3-pro", "gemini-2.5-pro", "gemini-2.5-flash-thinking",
  "deepseek-r1", "qwq", "kimi-k3", "grok-4", "grok-3",
];
const VISION_HINTS = [
  "claude-3", "claude-opus", "claude-sonnet", "claude-haiku",
  "gpt-4o", "chatgpt-4o", "gpt-4.1", "gpt-4-turbo", "gpt-5", "o3", "o4-",
  "gemini-",
  "qwen3-vl", "qwen-2.5-vl", "qwen2.5-vl",
  "glm-4.5v", "glm-4.6v", "glm-5v",
  "pixtral", "llama-4", "grok-2-vision", "grok-vision", "minimax-vl",
];
const REASONING_ROUTE_STEMS = new Set(["reasoning", "reasoning:pro", "best-reasoning", "pro-reasoning"]);
const VISION_ROUTE_STEMS = new Set(["vision", "best-vision", "pro-vision", "multimodal"]);

function idStem(id: string): string {
  return (id.split("/").pop() ?? id).toLowerCase();
}

/**
 * Heuristic metadata for a catalog model not present in the curated fallback.
 * Kept deliberately conservative: reasoning is only claimed for ids whose
 * family is known to support it; vision only for known vision families.
 */
export function inferMetadata(
  id: string,
): Pick<ModelRecord, "reasoning" | "input" | "contextWindow" | "maxTokens"> {
  const stem = idStem(id);
  const reasoning = REASONING_ROUTE_STEMS.has(stem) || REASONING_HINTS.some((hint) => stem.includes(hint));
  const vision = VISION_ROUTE_STEMS.has(stem) || VISION_HINTS.some((hint) => stem.includes(hint));
  const gemini = stem.includes("gemini-2.5") || stem.includes("gemini-3");
  return {
    reasoning,
    input: vision ? ["text", "image"] : ["text"],
    // Conservative default for unknown ids; the gateway's own context_length
    // wins when it reports one (applyCatalogLimits).
    contextWindow: gemini ? 1_000_000 : 128_000,
    maxTokens: reasoning ? 64_000 : 32_768,
  };
}

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Keep catalog-provided context/max tokens when present. */
function applyCatalogLimits(model: ModelRecord, entry: CatalogEntry): ModelRecord {
  if (
    entry.context_length === undefined && entry.max_tokens === undefined &&
    entry.max_completion_tokens === undefined && entry.max_output_tokens === undefined
  ) return model;
  return {
    ...model,
    contextWindow: asNumber(entry.context_length, model.contextWindow),
    maxTokens: asNumber(entry.max_tokens ?? entry.max_completion_tokens ?? entry.max_output_tokens, model.maxTokens),
  };
}

/** Transform one entry of the gateway /v1/models response. */
export function transformCatalogModel(entry: CatalogEntry): ModelRecord | null {
  if (typeof entry?.id !== "string" || !entry.id) return null;
  // pi can only drive chat completions; skip non-chat entries the gateway
  // advertises (aihorde/* SD models, embedding indexes, and friends).
  if (typeof entry.type === "string" && NON_CHAT_TYPES.has(entry.type)) return null;
  if (Array.isArray(entry.output_modalities) && !entry.output_modalities.includes("text")) return null;
  const id = entry.id;
  const metadata = inferMetadata(id);
  const name = typeof entry?.name === "string" && entry.name.trim() ? entry.name : id;
  return applyCatalogLimits(
    {
      id,
      name,
      ...metadata,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: metadata.reasoning
        ? { supportsReasoningEffort: true } // OpenAI-style reasoning_effort; gateway translates per backend
        : undefined,
    },
    entry,
  );
}

// ─── Curated merge ────────────────────────────────────────────────────────────

function applyCurated(model: ModelRecord, curated: ModelRecord): ModelRecord {
  return {
    ...model,
    name: curated.name ?? model.name,
    reasoning: curated.reasoning ?? model.reasoning,
    input: curated.input ?? model.input,
    contextWindow: curated.contextWindow ?? model.contextWindow,
    maxTokens: curated.maxTokens ?? model.maxTokens,
    cost: curated.cost ?? model.cost,
    compat: curated.compat ?? model.compat,
  };
}

function autoFirstCompare(a: { id: string }, b: { id: string }): number {
  return a.id === "auto" ? -1 : b.id === "auto" ? 1 : 0;
}

/** Live catalog is authoritative; curated metadata wins field-by-field; "auto" first. */
export function mergeCatalogs(
  live: ModelRecord[],
  curated: ModelRecord[],
): ModelRecord[] {
  const byId = new Map<string, ModelRecord>();
  for (const model of live) {
    const curatedById = curated.find((m) => m.id === model.id);
    byId.set(model.id, curatedById ? applyCurated(model, curatedById) : model);
  }
  // The live gateway is authoritative for which models exist. Only the
  // "auto" router entry is guaranteed when live omits it.
  const auto = curated.find((m) => m.id === "auto");
  if (auto && !byId.has("auto")) byId.set("auto", auto);
  return [...byId.values()].sort(autoFirstCompare);
}

// ─── Hand-edit layers (patch.json / custom-models.json) ───────────────────────

export interface PatchEntry {
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: Partial<ModelRecord["cost"]>;
  compat?: Record<string, unknown>;
}
export type PatchData = Record<string, PatchEntry>;

/** One delisted model kept alive for a grace window. */
export interface Tombstone {
  deprecatedAt: string;
  model: ModelRecord;
}
export type Tombstones = Record<string, Tombstone>;

/** Grace window for models the gateway delisted before they stop being served. */
export const DEPRECATED_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// compat keys that only make sense on reasoning models
const REASONING_COMPAT_KEYS = ["supportsReasoningEffort", "thinkingFormat", "thinkingLevelMap"] as const;

/** Non-reasoning models must never carry reasoning/thinking compat fields. */
function sanitizeCompat(model: ModelRecord): ModelRecord {
  if (model.reasoning || !model.compat) return model;
  const compat = { ...(model.compat as unknown as Record<string, unknown>) };
  for (const key of REASONING_COMPAT_KEYS) delete compat[key];
  const out = { ...model };
  if (Object.keys(compat).length === 0) delete out.compat;
  else out.compat = compat as ModelRecord["compat"];
  return out;
}

/** Apply one patch entry onto a model: per-field overrides, deep compat merge. */
export function applyPatch(model: ModelRecord, patch: PatchEntry): ModelRecord {
  const result: ModelRecord = { ...model };
  if (patch.name !== undefined) result.name = patch.name;
  if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
  if (patch.input !== undefined) result.input = [...patch.input];
  if (patch.contextWindow !== undefined) result.contextWindow = patch.contextWindow;
  if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;
  if (patch.cost) result.cost = { ...result.cost, ...patch.cost };
  if (patch.compat) {
    result.compat = { ...(result.compat ?? {}), ...patch.compat } as ModelRecord["compat"];
  }
  return sanitizeCompat(result);
}

/** Append tombstoned models that are still inside the grace window. */
export function withTombstones(
  models: ModelRecord[],
  tombstones: Tombstones,
  now = Date.now(),
): ModelRecord[] {
  const seen = new Set(models.map((m) => m.id));
  const extras: ModelRecord[] = [];
  for (const [id, tombstone] of Object.entries(tombstones)) {
    if (!tombstone || seen.has(id)) continue;
    const at = Date.parse(tombstone.deprecatedAt ?? "");
    if (Number.isNaN(at) || now - at > DEPRECATED_TTL_MS) continue;
    if (tombstone.model) extras.push({ ...tombstone.model, id });
  }
  return extras.length ? [...models, ...extras] : models;
}

/** Registered-catalog ceiling. Priority under the cap: auto → customs → live → tombstones. */
export const MAX_REGISTERED_MODELS = 1000;

/**
 * Full merge pipeline: base → custom (replaces same-id wholesale / adds) →
 * patch (per-field, never creates ids). "auto" is always sorted first.
 * The registered catalog is capped at `max` with deterministic priority —
 * a full live-catalog turnover cannot double the registration via tombstones.
 */
export function buildModels(
  base: ModelRecord[],
  custom: ModelRecord[],
  patch: PatchData,
  tombstones: Tombstones = {},
  now = Date.now(),
  max = MAX_REGISTERED_MODELS,
): ModelRecord[] {
  const modelMap = new Map<string, ModelRecord>();
  for (const model of withTombstones(base, tombstones, now)) {
    if (model?.id) modelMap.set(model.id, model);
  }
  for (const model of custom) {
    if (model?.id) modelMap.set(model.id, model);
  }
  for (const [id, entry] of Object.entries(patch)) {
    const existing = modelMap.get(id);
    if (existing) modelMap.set(id, applyPatch(existing, entry));
  }
  const all = [...modelMap.values()].sort(autoFirstCompare);
  if (all.length <= max) return all;

  // Over the cap: auto always survives; customs outrank live entries; live
  // entries outrank tombstoned grace models.
  const keep = new Set<string>(["auto"]);
  for (const model of custom) {
    if (model?.id && keep.size < max) keep.add(model.id);
  }
  for (const model of base) {
    if (model?.id && keep.size < max) keep.add(model.id);
  }
  const baseIds = new Set(base.map((m) => m?.id).filter(Boolean) as string[]);
  for (const id of Object.keys(tombstones)) {
    if (keep.size >= max) break;
    if (!baseIds.has(id)) keep.add(id);
  }
  return all.filter((m) => keep.has(m.id));
}

/** Shape-guard for cache records: one bad entry must not nuke the whole cache. */
export function asModelRecord(value: unknown): ModelRecord | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !v.id) return null;
  if (typeof v.reasoning !== "boolean" || !Array.isArray(v.input)) return null;
  return value as ModelRecord;
}
