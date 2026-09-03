/**
 * Behavioral probe: loads the real extension factory against a simulated
 * OmniRoute gateway and a fake pi ExtensionAPI, then asserts zero-latency
 * registration, auth handling, merge semantics, heuristics, the SWR disk
 * cache, tombstone grace, and the offline fallback paths.
 *
 *   bun tests/probe.ts
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Fake pi ExtensionAPI ─────────────────────────────────────────────────────
interface Entry {
  name: string;
  config: Record<string, unknown>;
}
const registrations: Entry[] = [];
const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void>>();
const fakePi = {
  registerProvider: (name: string, config: Record<string, unknown>) => {
    registrations.push({ name, config });
  },
  on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
    handlers.set(event, handler);
  },
};

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`PROBE FAIL: ${message}`);
}

function modelsOf(entry: Entry | undefined): Array<Record<string, unknown>> {
  assert(entry !== undefined, "a provider registration exists");
  return entry.config.models as Array<Record<string, unknown>>;
}

// ── Simulated gateway: /v1/models over a mutable catalog ────────────────────
interface CatalogEntry {
  id: string;
  object?: string;
  name?: string;
  context_length?: number;
  max_tokens?: number;
  max_output_tokens?: number;
  type?: string;
  output_modalities?: string[];
}
function defaultCatalog(): CatalogEntry[] {
  return [
    { id: "auto", object: "model" },
    { id: "cc/claude-sonnet-4-6", object: "model", name: "cc/claude-sonnet-4-6" },
    { id: "google/gemini-3-pro", object: "model", name: "Gemini 3 Pro", max_tokens: 16384 },
    { id: "google/gemini-2.5-pro", object: "model", context_length: 1_048_576 },
    { id: "a-random/unknown-model-1b", object: "model", max_output_tokens: 4096 },
    { id: "aihorde/sdxl-image", object: "model", type: "image", output_modalities: ["image"] },
  ];
}
let catalog = defaultCatalog();
let receivedAuth: string | undefined;

async function withGateway(
  fn: (port: number) => Promise<void>,
  opts: { delayMs?: number } = {},
): Promise<void> {
  const server: Server = createServer((req: IncomingMessage, res) => {
    receivedAuth = req.headers.authorization;
    if (req.url === "/v1/models") {
      const respond = () => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ object: "list", data: catalog }));
      };
      if (opts.delayMs) setTimeout(respond, opts.delayMs);
      else respond();
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  receivedAuth = undefined;
  try {
    await fn(port);
  } finally {
    server.close();
  }
}

function baseUrlFor(port: number): string {
  return `http://127.0.0.1:${port}/v1`;
}

// ── Cache-dir helpers (each phase gets a hermetic cache) ─────────────────────
const cacheDirs: string[] = [];
function freshCacheDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-probe-"));
  cacheDirs.push(dir);
  return dir;
}

async function sessionStart(): Promise<void> {
  const sessionHandler = handlers.get("session_start");
  assert(typeof sessionHandler === "function", "session_start handler registered");
  await sessionHandler({}, {});
}

// ── Shared records for cache seeding / tombstone probes ──────────────────────
const AUTO_RECORD = {
  id: "auto", name: "Auto", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16384,
};
const OLD_RECORD = {
  id: "provider/old-model", name: "Old Model", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 32768,
};

// ── Probes ────────────────────────────────────────────────────────────────────
let warmCacheDir: string | undefined;

async function probeLive(): Promise<void> {
  const cacheDir = freshCacheDir();
  await withGateway(async (port) => {
    process.env.OMNIROUTE_BASE_URL = baseUrlFor(port);
    process.env.OMNIROUTE_API_KEY = "secret-key-123";
    process.env.OMNIROUTE_CACHE_DIR = cacheDir;
    registrations.length = 0;

    const mod = await import("../index.ts?probe=live");
    await mod.default(fakePi);

    // Zero-latency: the factory registered without touching the network.
    assert(registrations.length === 1, "factory registers immediately");
    assert(receivedAuth === undefined, "factory did not fetch (zero-latency registration)");
    const { name, config } = registrations[0];
    assert(name === "omniroute", `provider id, got ${name}`);
    assert(config.baseUrl === baseUrlFor(port), "baseUrl points at gateway");
    assert(config.api === "openai-completions", "api is openai-completions");
    assert(config.apiKey === "$OMNIROUTE_API_KEY", "apiKey env-ref set");
    const stale = modelsOf(registrations[0]);
    assert(stale.length === 6, `stale registration = curated fallback, got ${stale.length}`);
    assert(stale[0].id === "auto", "auto first on stale registration");

    // session_start revalidates in the background and hot-swaps.
    await sessionStart();
    assert(registrations.length === 2, "revalidation re-registers");
    assert(receivedAuth === "Bearer secret-key-123", "catalog fetch authorized");
    const models = modelsOf(registrations[1]);
    assert(models[0].id === "auto", "auto first");
    assert(models.length === 5, `live catalog size ${models.length}`);
    assert(!models.some((m) => m.id.startsWith("aihorde/")), "image-only catalog entries dropped");

    // Curated extras must NOT be appended while the live catalog is present:
    // only the injected "auto" entry survives an empty live list.
    const { mergeCatalogs } = mod as { mergeCatalogs(l: unknown[], c: unknown[]): Array<{ id: string }> };
    const mergedEmptyLive = mergeCatalogs([], defaultCatalog());
    assert(mergedEmptyLive.length === 1 && mergedEmptyLive[0].id === "auto", "live-existence wins; auto injected");

    const sonnet = models.find((m) => m.id === "cc/claude-sonnet-4-6");
    assert(sonnet?.reasoning === true, "curated metadata overrides live reasoning");
    assert((sonnet?.input as string[]).includes("image"), "curated vision preserved");

    const gem3 = models.find((m) => m.id === "google/gemini-3-pro");
    assert(gem3?.reasoning === true, "heuristic: gemini-3-pro is reasoning");
    assert(gem3?.maxTokens === 16_384, "live max_tokens honored");

    const gem25 = models.find((m) => m.id === "google/gemini-2.5-pro");
    assert(gem25?.reasoning === true, "heuristic: gemini-2.5-pro is reasoning");
    assert(gem25?.contextWindow === 1_048_576, "live context_length honored");

    const plain = models.find((m) => m.id === "a-random/unknown-model-1b");
    assert(plain !== undefined && plain.reasoning === false, "unknown id stays non-reasoning");
    assert(plain?.maxTokens === 4096, "live max_output_tokens honored");

    const { inferMetadata } = mod as { inferMetadata(id: string): { reasoning: boolean; input: string[] } };
    assert(inferMetadata("auto/best-reasoning").reasoning, "auto reasoning route classified");
    assert(inferMetadata("auto/best-vision").input.includes("image"), "auto vision route classified");
    assert(inferMetadata("auto/multimodal").input.includes("image"), "auto multimodal route classified");

    // The revalidation wrote the merged catalog for the next session.
    const cached = JSON.parse(fs.readFileSync(path.join(cacheDir, "omniroute-models.json"), "utf8")) as {
      models: Array<{ id: string }>;
    };
    assert(cached.models.length === 5, "revalidate writes the merged catalog to disk");
    assert(cached.models.some((m) => m.id === "google/gemini-3-pro"), "cache holds live-only ids");
    warmCacheDir = cacheDir;
    console.log("probe 1 OK — zero-latency registration, SWR hot-swap, merge, heuristics, cache write");
  });
}

async function probeZeroLatency(): Promise<void> {
  await withGateway(async (port) => {
    process.env.OMNIROUTE_BASE_URL = baseUrlFor(port);
    process.env.OMNIROUTE_API_KEY = "secret-key-123";
    process.env.OMNIROUTE_CACHE_DIR = freshCacheDir();
    registrations.length = 0;

    const mod = await import("../index.ts?probe=zero");
    // The gateway answers after 400ms; the factory must not wait for it.
    const started = Date.now();
    await mod.default(fakePi);
    assert(Date.now() - started < 200, "factory returns without awaiting the gateway");
    assert(registrations.length === 1, "registered before the gateway answered");

    await sessionStart();
    assert(registrations.length === 2, "background revalidation lands after the gateway answers");
    assert(modelsOf(registrations[1]).length === 5, "hot-swap serves the live catalog");
    console.log("probe 2 OK — a delayed gateway cannot delay registration");
  }, { delayMs: 400 });
}

async function probeRefresh(): Promise<void> {
  await withGateway(async (port) => {
    process.env.OMNIROUTE_BASE_URL = baseUrlFor(port);
    process.env.OMNIROUTE_CACHE_DIR = freshCacheDir();
    registrations.length = 0;
    const mod = await import("../index.ts?probe=refresh");
    await mod.default(fakePi);

    catalog = [...catalog, { id: "provider/fresh-model-2", object: "model" }];
    await sessionStart();

    const after = modelsOf(registrations[registrations.length - 1]);
    assert(after.some((m) => m.id === "provider/fresh-model-2"), "refresh adds new catalog entry");
    assert(after.length === 6, `refresh size ${after.length} vs 6`);
    void mod;
    console.log("probe 3 OK — session_start refresh re-fetches the catalog");
  });
}

async function probeOfflineCold(): Promise<void> {
  delete process.env.OMNIROUTE_API_KEY;
  process.env.OMNIROUTE_BASE_URL = "http://127.0.0.1:1/v1"; // port 1 → connection refused
  process.env.OMNIROUTE_CACHE_DIR = freshCacheDir();
  registrations.length = 0;
  const mod = await import("../index.ts?probe=offline");
  await mod.default(fakePi);

  assert(registrations.length === 1, "still registers provider offline");
  const models = modelsOf(registrations[0]);
  assert(models.length === 6, `offline fallback = curated list, got ${models.length}`);
  assert(models[0].id === "auto", "auto first offline");
  void mod;
  console.log("probe 4 OK — unreachable gateway + no cache → curated fallback");
}

async function probeOfflineWarm(): Promise<void> {
  delete process.env.OMNIROUTE_API_KEY;
  process.env.OMNIROUTE_BASE_URL = "http://127.0.0.1:1/v1";
  assert(warmCacheDir !== undefined, "warm cache was populated by probe 1");
  process.env.OMNIROUTE_CACHE_DIR = warmCacheDir;
  registrations.length = 0;
  const mod = await import("../index.ts?probe=warm");
  await mod.default(fakePi);

  assert(registrations.length === 1, "registers offline with a warm cache");
  const models = modelsOf(registrations[0]);
  const unknown = models.find((m) => m.id === "a-random/unknown-model-1b");
  assert(unknown !== undefined, "warm cache serves live-only ids after the gateway dies");
  assert(unknown.maxTokens === 4096, "cached catalog values preserved");
  assert(models[0].id === "auto", "auto first on warm-cache registration");
  void mod;
  console.log("probe 5 OK — warm cache outlives the gateway");
}

async function probeTombstones(): Promise<void> {
  const cacheDir = freshCacheDir();
  fs.writeFileSync(
    path.join(cacheDir, "omniroute-models.json"),
    JSON.stringify({ models: [AUTO_RECORD, OLD_RECORD], tombstones: {} }),
  );
  await withGateway(async (port) => {
    delete process.env.OMNIROUTE_API_KEY;
    process.env.OMNIROUTE_BASE_URL = baseUrlFor(port);
    process.env.OMNIROUTE_CACHE_DIR = cacheDir;
    // The gateway no longer serves provider/old-model.
    catalog = [{ id: "auto", object: "model" }, { id: "google/gemini-3-pro", object: "model", name: "Gemini 3 Pro" }];
    registrations.length = 0;

    const mod = await import("../index.ts?probe=tomb");
    await mod.default(fakePi);
    assert(modelsOf(registrations[0]).some((m) => m.id === "provider/old-model"), "stale cache serves the soon-to-be-delisted model");

    await sessionStart();
    const models = modelsOf(registrations[registrations.length - 1]);
    assert(models.some((m) => m.id === "provider/old-model"), "delisted model survives via tombstone grace");
    assert(models.some((m) => m.id === "google/gemini-3-pro"), "live catalog still applies");
    assert(models.length === 3, `auto + live entry + tombstoned entry, got ${models.length}`);
    const cached = JSON.parse(fs.readFileSync(path.join(cacheDir, "omniroute-models.json"), "utf8")) as {
      models: unknown[];
      tombstones: Record<string, { deprecatedAt: string }>;
    };
    const tomb = cached.tombstones["provider/old-model"];
    assert(tomb && !Number.isNaN(Date.parse(tomb.deprecatedAt)), "revalidate tombstones the delisted id");
    assert(cached.models.length === 2, "cache models are the live-merged truth (no tombstoned extras)");

    // Expire the tombstone → the model must disappear on the next load.
    cached.tombstones["provider/old-model"].deprecatedAt = new Date(Date.now() - 20 * 86_400_000).toISOString();
    fs.writeFileSync(path.join(cacheDir, "omniroute-models.json"), JSON.stringify(cached));
    registrations.length = 0;
    const mod2 = await import("../index.ts?probe=tomb2");
    await mod2.default(fakePi);
    assert(!modelsOf(registrations[0]).some((m) => m.id === "provider/old-model"), "expired tombstone is dropped");
    assert(modelsOf(registrations[0]).some((m) => m.id === "google/gemini-3-pro"), "cache still serves live ids");
    void mod;
    void mod2;
    console.log("probe 6 OK — tombstone grace window, reconcile, expiry");
  });
  catalog = defaultCatalog();
}

async function probeKeyless(): Promise<void> {
  await withGateway(async (port) => {
    delete process.env.OMNIROUTE_API_KEY;
    process.env.OMNIROUTE_BASE_URL = baseUrlFor(port);
    process.env.OMNIROUTE_CACHE_DIR = freshCacheDir();
    registrations.length = 0;
    const mod = await import("../index.ts?probe=keyless");
    await mod.default(fakePi);
    assert(registrations[0].config.apiKey === "keyless", "keyless placeholder keeps the models available in pi");

    await sessionStart();
    assert(receivedAuth === undefined, "no Authorization header when keyless");
    const models = modelsOf(registrations[registrations.length - 1]);
    assert(models[0].id === "auto", "keyless registration works");
    assert(models.length === 5, "keyless discovery serves the live catalog");
    void mod;
    console.log("probe 7 OK — keyless: Authorization header omitted, discovery works");
  });
}

async function probePipeline(): Promise<void> {
  const m = await import("../models.ts?probe=pure");
  const rec = (over: Record<string, unknown>) => ({
    reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000, maxTokens: 32768, ...over,
  });

  // Patch applies per-field and sanitation strips reasoning compat from non-reasoning models.
  const patched = m.applyPatch(rec({ id: "a/b", name: "B", compat: { supportsReasoningEffort: true } }), {
    name: "Renamed", contextWindow: 999, reasoning: false,
  });
  assert(patched.name === "Renamed" && patched.contextWindow === 999, "patch overrides fields");
  assert(patched.compat === undefined, "sanitation strips reasoning compat from non-reasoning models");
  const reasoning = m.applyPatch(rec({ id: "c/d", reasoning: true, compat: { supportsReasoningEffort: true } }), {
    compat: { supportsDeveloperRole: true },
  });
  const compat = reasoning.compat as Record<string, unknown>;
  assert(compat.supportsReasoningEffort === true && compat.supportsDeveloperRole === true, "compat deep-merges on reasoning models");

  // Precedence: base → custom replaces wholesale → patch on top; patches never create.
  const built = m.buildModels(
    [rec({ id: "b/1", name: "Base", maxTokens: 1 }), { ...AUTO_RECORD }],
    [rec({ id: "b/1", name: "Custom", maxTokens: 2 })],
    { "b/1": { maxTokens: 777 } },
  );
  assert(built[0].id === "auto", "auto first after build");
  const b1 = built.find((x) => x.id === "b/1");
  assert(b1?.name === "Custom" && b1.maxTokens === 777, "custom replaces base, patch wins on top");
  assert(m.buildModels([], [], { "ghost/id": { name: "Ghost" } }).length === 0, "patches never create ids");

  // Tombstone grace window.
  const now = Date.now();
  const alive = m.withTombstones([], { "x/y": { deprecatedAt: new Date(now - 86_400_000).toISOString(), model: rec({ id: "x/y" }) } }, now);
  assert(alive.length === 1 && alive[0].id === "x/y", "fresh tombstone served");
  const expired = m.withTombstones([], { "x/y": { deprecatedAt: new Date(now - 20 * 86_400_000).toISOString(), model: rec({ id: "x/y" }) } }, now);
  assert(expired.length === 0, "expired tombstone dropped");
  console.log("probe 8 OK — patch/custom precedence, sanitation, tombstone TTL");
}

// ── Run ───────────────────────────────────────────────────────────────────────
try {
  await probeLive();
  await probeZeroLatency();
  await probeRefresh();
  await probeOfflineCold();
  await probeOfflineWarm();
  await probeTombstones();
  await probeKeyless();
  await probePipeline();
  console.log("ALL PROBES PASSED");
} finally {
  for (const dir of cacheDirs) fs.rmSync(dir, { recursive: true, force: true });
}