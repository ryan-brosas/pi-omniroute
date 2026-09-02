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
 *   Models      live catalog from {base}/models, merged with curated models.json
 *
 * Model discovery (best-effort, never fatal):
 *   1. Startup  – fetch the live catalog. On success, curated metadata from
 *                 models.json is merged on top (names / vision / reasoning /
 *                 output limits that the catalog does not reliably report).
 *   2. Fallback  – if the gateway is down or keyless /models is denied, register
 *                 the small curated fallback list so the provider still exists.
 *   3. Refresh   – session_start re-fetches the catalog so newly added models
 *                 appear on subsequent sessions without restarting pi.
 *
 * Usage:
 *   npm i -g omniroute && omniroute        # run the gateway (port 20128)
 *   export OMNIROUTE_API_KEY=…             # optional; or store via /login
 *   pi -e /path/to/pi-omniroute
 *   /model → "auto" or e.g. "claude/claude-sonnet-4-6"
 */
import {
  type ExtensionAPI,
  type ProviderConfig,
  type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import fallbackModelsData from "./models.json" with { type: "json" };

const PROVIDER_ID = "omniroute";
const PROVIDER_NAME = "OmniRoute";
const DEFAULT_BASE_URL = "http://localhost:20128/v1";
const FETCH_TIMEOUT_MS = 8000;
const MAX_LIVE_CATALOG_ENTRIES = 1000;

function envValue(name: string): string {
  return typeof process !== "undefined" ? (process.env[name] ?? "") : "";
}

/** Gateway origin, normalized without a trailing slash. */
const baseUrl = (envValue("OMNIROUTE_BASE_URL") || DEFAULT_BASE_URL).replace(/\/+$/, "");

// ─── Catalog / /v1/models payload types ───────────────────────────────────────

interface CatalogEntry {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  max_tokens?: unknown;
  max_completion_tokens?: unknown;
}

// ─── Model metadata heuristics ────────────────────────────────────────────────
// The gateway's /v1/models does not reliably report reasoning or vision for
// every entry; providers expose ids both bare ("gemini-2.5-pro") and prefixed
// ("google/gemini-3-pro"). These lists classify the *stem* of the id.

const REASONING_HINTS = [
  "claude-opus", "claude-sonnet", "claude-haiku", "claude-3-7", "claude-3-5",
  "gpt-5", "o1-", "o3-", "o4-",
  "gemini-3-pro", "gemini-2.5-pro", "gemini-2.5-flash-thinking",
  "deepseek-r1", "qwq", "kimi-k3", "glm-5", "grok-4", "grok-3",
];
const VISION_HINTS = [
  "claude-", "gpt-", "gemini-",
  "qwen3-vl", "qwen-2.5-vl", "qwen2.5-vl",
  "glm-4.5v", "glm-4.6v", "glm-5", "kimi-k", "kimi-k3", "grok-",
  "pixtral", "llama-3.2-", "llama-4", "minimax",
];

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
): Pick<ProviderModelConfig, "reasoning" | "input" | "contextWindow" | "maxTokens"> {
  const stem = idStem(id);
  const reasoning = REASONING_HINTS.some((hint) => stem.includes(hint));
  const vision = VISION_HINTS.some((hint) => stem.includes(hint));
  const gemini = stem.includes("gemini-2.5") || stem.includes("gemini-3");
  return {
    reasoning,
    input: vision ? ["text", "image"] : ["text"],
    contextWindow: gemini ? 1_000_000 : 200_000,
    maxTokens: reasoning ? 64_000 : 32_768,
  };
}

/** Transform one entry of the gateway /v1/models response. */
export function transformCatalogModel(entry: CatalogEntry): ProviderModelConfig | null {
  if (typeof entry?.id !== "string" || !entry.id) return null;
  const id = entry.id;
  const metadata = inferMetadata(id);
  const name = typeof entry?.name === "string" && entry.name.trim() ? entry.name : id;
  return {
    id,
    name,
    ...metadata,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: metadata.reasoning
      ? { supportsReasoningEffort: true } // OpenAI-style reasoning_effort; gateway translates per backend
      : undefined,
  };
}

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ── Fetching the live catalog ─────────────────────────────────────────────────

async function fetchLiveCatalog(
  apiKey: string | undefined,
  signal?: AbortSignal
): Promise<ProviderModelConfig[] | null> {
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
      const models: ProviderModelConfig[] = [];
      for (const raw of entries) {
        const entry = raw as CatalogEntry;
        const id = typeof entry?.id === "string" ? entry.id : "";
        if (!id || seen.has(id)) continue;
        const model = transformCatalogModel(entry);
        if (!model) continue;
        // Keep catalog-provided context/max tokens when present.
        if (entry.context_length !== undefined || entry.max_tokens !== undefined || entry.max_completion_tokens !== undefined) {
          model.contextWindow = asNumber(entry.context_length, model.contextWindow);
          model.maxTokens = asNumber(entry.max_tokens ?? entry.max_completion_tokens, model.maxTokens);
        }
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

// ── Merge curated fallback on top of the live catalog ─────────────────────────

function applyCurated(model: ProviderModelConfig, curated: ProviderModelConfig): ProviderModelConfig {
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

/** Live catalog is authoritative; curated metadata wins field-by-field; "auto" first. */
export function mergeCatalogs(
  live: ProviderModelConfig[],
  curated: ProviderModelConfig[],
): ProviderModelConfig[] {
  const byId = new Map<string, ProviderModelConfig>();
  for (const model of live) {
    const curatedById = curated.find((m) => m.id === model.id);
    byId.set(model.id, curatedById ? applyCurated(model, curatedById) : model);
  }
  // The live gateway is authoritative for which models exist. Only the
  // "auto" router entry is guaranteed when live omits it.
  const auto = curated.find((m) => m.id === "auto");
  if (auto && !byId.has("auto")) byId.set("auto", auto);
  const ids = [...byId.keys()].sort((a, b) => (a === "auto" ? -1 : b === "auto" ? 1 : 0));
  return ids.map((id) => byId.get(id)!);
}

// ── Registration ──────────────────────────────────────────────────────────────

function registerProvider(pi: ExtensionAPI, models: ProviderModelConfig[]): void {
  const config: ProviderConfig = {
    name: PROVIDER_NAME,
    baseUrl,
    apiKey: "$OMNIROUTE_API_KEY",
    api: "openai-completions",
    models,
  };
  pi.registerProvider(PROVIDER_ID, config);
}

function resolveApiKey(): string | undefined {
  const key = envValue("OMNIROUTE_API_KEY").trim();
  return key || undefined;
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const fallback = fallbackModelsData as ProviderModelConfig[];

  // 1. Startup discovery — pi waits for the factory, so the provider is ready
  //    for the model picker before the interactive session begins.
  const live = await fetchLiveCatalog(resolveApiKey());
  registerProvider(pi, live && live.length > 0 ? mergeCatalogs(live, fallback) : [...fallback]);

  // 2. Refresh on later sessions (gateway may have come online, added models,
  //    or had its catalog regenerated between sessions).
  let refreshAbort: AbortController | null = null;
  pi.on("session_start", async () => {
    refreshAbort?.abort();
    const controller = new AbortController();
    refreshAbort = controller;
    try {
      const fresh = await fetchLiveCatalog(resolveApiKey(), controller.signal);
      if (fresh && fresh.length > 0 && !controller.signal.aborted) {
        registerProvider(pi, mergeCatalogs(fresh, fallback));
      }
    } catch {
      // non-fatal
    }
  });
}
