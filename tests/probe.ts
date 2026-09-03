/**
 * Behavioral probe: loads the real extension factory against a simulated
 * OmniRoute gateway and a fake pi ExtensionAPI, then asserts zero-latency
 * registration, non-blocking session refresh, auth handling (catalog fetch
 * and outgoing chat-completions headers), merge semantics, heuristics, the
 * SWR disk cache, tombstone grace, and the offline fallback paths.
 *
 *   bun tests/probe.ts
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fallbackModels from "../models.json" with { type: "json" };
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelRecord } from "../models.ts";

const CURATED_COUNT = (fallbackModels as unknown[]).length;

// ── Fake pi ExtensionAPI ─────────────────────────────────────────────────────
// Cache-busted dynamic imports: bun serves the query string as a fresh module
// instance per probe, but TS cannot resolve the specifier -- type the shapes here.
const importIndex = (spec: string): Promise<typeof import("../index.ts")> => import(spec);
const importModels = (spec: string): Promise<typeof import("../models.ts")> => import(spec);

interface Entry {
  name: string;
  config: Record<string, unknown>;
}
const registrations: Entry[] = [];
type Handler = (event: unknown, ctx: unknown) => unknown;
const handlers = new Map<string, Handler>();
const fakePi = {
  registerProvider: (name: string, config: Record<string, unknown>) => {
    registrations.push({ name, config });
  },
  on: (event: string, handler: Handler) => {
    handlers.set(event, handler);
  },
} as unknown as ExtensionAPI;

// Escape hatch from TS's literal narrowing of `registrations.length` after
// `registrations.length = 0` + one push (flags `=== 2` as impossible).
const regCount = (): number => registrations.length;

// Live-pipeline probes exercise the full catalog lifecycle (fetch, publish,
// tombstones, store): opt into the `all` scope globally; probeScope overrides
// per cache-busted import for the curated/routes static builds.
process.env.OMNIROUTE_MODEL_SCOPE = "all";

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`PROBE FAIL: ${message}`);
}

function modelsOf(entry: Entry | undefined): Array<Record<string, unknown>> {
  assert(entry !== undefined, "a provider registration exists");
  return entry.config.models as Array<Record<string, unknown>>;
}

async function waitFor(cond: () => boolean, message: string, timeoutMs = 5000, step = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, step));
  }
  throw new Error(`PROBE FAIL: waitFor timed out — ${message}`);
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
// Dashboard /api/providers body (JSON string); null = endpoint absent (404).
let fakeConnections: string | null = null;

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
    } else if (req.url === "/api/providers") {
      // Dashboard connections API. null = gateway without the endpoint (404).
      if (fakeConnections === null) {
        res.statusCode = 404;
        res.end("not found");
      } else {
        res.setHeader("content-type", "application/json");
        res.end(fakeConnections);
      }
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
    fakeConnections = null;
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

// ---- Store + refresh harness: mimics pi's catalog store and refresh hook -----
interface Stored { models?: unknown[]; checkedAt?: number; url?: string; scope?: unknown; }
let stored: Stored | undefined;

async function invokeRefresh(options: { allowNetwork?: boolean; publishFails?: boolean } = {}): Promise<Array<Record<string, unknown>>> {
  const entry = registrations[registrations.length - 1];
  const fn = entry.config.refreshModels as
    | ((ctx: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>)
    | undefined;
  assert(typeof fn === "function", "refreshModels registered on the provider config");
  const ctx = {
    stored,
    allowNetwork: options.allowNetwork ?? true,
    signal: new AbortController().signal,
    publish: async (publication: {
      persist?: { models?: unknown[]; checkedAt?: number; url?: string } | null;
      update?: () => void;
    }) => {
      if (options.publishFails) throw new Error("pi store unavailable");
      if (publication.persist === null) stored = undefined;
      else if (publication.persist) {
        stored = {
          models: publication.persist.models,
          checkedAt: publication.persist.checkedAt,
          url: (publication.persist as { url?: string }).url,
          scope: (publication.persist as { scope?: unknown }).scope,
        };
      }
      if (publication.update) publication.update();
      return true;
    },
  };
  return (await fn(ctx as never)) as Array<Record<string, unknown>>;
}

// ── Shared records for cache seeding / tombstone probes ──────────────────────
const AUTO_RECORD: ModelRecord = {
  id: "auto", name: "Auto", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16384,
};
const OLD_RECORD: ModelRecord = {
  id: "provider/old-model", name: "Old Model", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 32768,
};

// ── Probes ────────────────────────────────────────────────────────────────────
let warmCacheDir: string | undefined;
let warmPort: number | undefined;

async function probeLive(): Promise<void> {
  const cacheDir = freshCacheDir();
  await withGateway(async (port) => {
    process.env.OMNIROUTE_BASE_URL = baseUrlFor(port);
    process.env.OMNIROUTE_API_KEY = "secret-key-123";
    process.env.OMNIROUTE_CACHE_DIR = cacheDir;
    registrations.length = 0;

    const mod = await importIndex("../index.ts?probe=live");
    await mod.default(fakePi);

    // Zero-latency: the factory registered without touching the network.
    assert(regCount() === 1, "factory registers immediately");
    assert(receivedAuth === undefined, "factory did not fetch (zero-latency registration)");
    const { name, config } = registrations[0];
    assert(name === "omniroute", `provider id, got ${name}`);
    assert(config.baseUrl === baseUrlFor(port), "baseUrl points at gateway");
    assert(config.api === "openai-completions", "api is openai-completions");
    assert(config.apiKey === "$OMNIROUTE_API_KEY", "apiKey env-ref set");
    assert(config.authHeader === true, "authHeader routes the resolved key through pi's header pipeline — without it the before_provider_headers strip never sees the Authorization header and the keyless placeholder reaches the gateway (SDK adds its own Bearer after the hook)");
    const stale = modelsOf(registrations[0]);
    assert(stale.length === CURATED_COUNT, `seed registration = curated fallback, got ${stale.length}`);
    assert(stale[0].id === "auto", "auto first on seed");

    // Drive the pi refresh hook: fetch -> merge -> publish -> hot-swap.
    await invokeRefresh();
    assert(regCount() === 2, "refresh re-registers exactly once");
    assert(receivedAuth === "Bearer secret-key-123", "catalog fetch authorized");
    const models = modelsOf(registrations[1]);
    assert(models[0].id === "auto", "auto first");
    assert(models.length === 5, `live catalog size ${models.length}`);
    assert(!models.some((m) => String(m.id).startsWith("aihorde/")), "image-only catalog entries dropped");

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

    // publish({persist}) stored the merged core in the pi-owned store.
    assert(stored !== undefined && (stored.models?.length ?? 0) === 5, "refresh persisted the merged catalog");
    assert(
      (stored.models ?? []).some((m) => (m as { id?: string }).id === "google/gemini-3-pro"),
      "store keeps live-only ids",
    );
    // The tombstone store file exists (keyed to the gateway URL).
    const { tombstonesFilePathFor } = mod as { tombstonesFilePathFor(u: string): string };
    const tombPath = path.join(cacheDir, path.basename(tombstonesFilePathFor(baseUrlFor(port))));
    assert(fs.existsSync(tombPath), "tombstone store written");
    warmCacheDir = cacheDir;
    warmPort = port;
    console.log("probe 1 OK — zero-latency registration, SWR hot-swap, merge, heuristics, cache write");
  });
}

async function probeNonBlocking(): Promise<void> {
  await withGateway(async (port) => {
    process.env.OMNIROUTE_BASE_URL = baseUrlFor(port);
    process.env.OMNIROUTE_API_KEY = "secret-key-123";
    process.env.OMNIROUTE_CACHE_DIR = freshCacheDir();
    registrations.length = 0;

    const mod = await importIndex("../index.ts?probe=zero");
    // The gateway answers after 400ms; neither the factory nor session_start
    // may wait for it.
    const started = Date.now();
    await mod.default(fakePi);
    assert(Date.now() - started < 200, "factory returns without awaiting the gateway");
    assert(regCount() === 1, "registered before the gateway answered");

    const delayed = await invokeRefresh();
    assert(Date.now() - started > 350, "refresh waits out the delayed gateway");
    assert(regCount() === 2, "hot-swap after the delayed gateway");
    assert(delayed.length === 5, "hot-swap serves the live catalog");
    void mod;
    console.log("probe 2 OK — a delayed gateway delays neither registration nor session start");
  }, { delayMs: 400 });
}

async function probeRefresh(): Promise<void> {
  await withGateway(async (port) => {
    process.env.OMNIROUTE_BASE_URL = baseUrlFor(port);
    process.env.OMNIROUTE_CACHE_DIR = freshCacheDir();
    registrations.length = 0;
    const mod = await importIndex("../index.ts?probe=refresh");
    await mod.default(fakePi);

    catalog = [...catalog, { id: "provider/fresh-model-2", object: "model" }];
    const after = await invokeRefresh();
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
  stored = undefined;
  const mod = await importIndex("../index.ts?probe=offline");
  await mod.default(fakePi);

  assert(regCount() === 1, "still registers provider offline");
  const models = modelsOf(registrations[0]);
  assert(models.length === CURATED_COUNT, `offline fallback = curated list, got ${models.length}`);
  assert(models[0].id === "auto", "auto first offline");
  const offlinePhase = await invokeRefresh({ allowNetwork: false });
  assert(offlinePhase.length === CURATED_COUNT, "allowNetwork=false serves fallback without a fetch");
  const refused = await invokeRefresh();
  assert(refused.length === CURATED_COUNT, "network failure degrades to the curated fallback");
  void mod;
  console.log("probe 4 OK — unreachable gateway: seed + offline phases degrade safely");
}

async function probeOfflineWarm(): Promise<void> {
  delete process.env.OMNIROUTE_API_KEY;
  assert(warmCacheDir !== undefined && warmPort !== undefined, "warm store was populated by probe 1");
  // Simulate the persisted pi store from probe 1; the gateway is unreachable.
  stored = {
    models: [
      { ...AUTO_RECORD },
      { ...OLD_RECORD, id: "a-random/unknown-model-1b", maxTokens: 4096 },
    ],
  };
  process.env.OMNIROUTE_BASE_URL = "http://127.0.0.1:1/v1";
  process.env.OMNIROUTE_CACHE_DIR = freshCacheDir();
  stored = {
    url: "http://127.0.0.1:1/v1",
    scope: "all",
    models: [
      { ...AUTO_RECORD },
      { ...OLD_RECORD, id: "a-random/unknown-model-1b", maxTokens: 4096 },
    ],
  };
  registrations.length = 0;
  const mod = await importIndex("../index.ts?probe=warm");
  await mod.default(fakePi);

  assert(regCount() === 1, "registers offline with a warm store");
  const offline = await invokeRefresh({ allowNetwork: false });
  const unknown = offline.find((m) => m.id === "a-random/unknown-model-1b");
  assert(unknown !== undefined, "offline phase serves stored ids after the gateway dies");
  assert(unknown.maxTokens === 4096, "stored catalog values preserved");
  const after = await invokeRefresh();
  assert(after.some((m) => m.id === "a-random/unknown-model-1b"), "stored catalog outlives the dead gateway");
  void mod;
  console.log("probe 5 OK — stored catalog outlives the gateway");
}

async function probeTombstones(): Promise<void> {
  const cacheDir = freshCacheDir();
  await withGateway(async (port) => {
    const { tombstonesFilePathFor } = (await importIndex("../index.ts?probe=tomb-helpers")) as {
      tombstonesFilePathFor(u: string): string;
    };
    // The tombstone store filename is a pure function of the gateway URL.
    const tombPath = path.join(cacheDir, path.basename(tombstonesFilePathFor(baseUrlFor(port))));
    fs.writeFileSync(tombPath, JSON.stringify({}));
    // Legacy unscoped cache from an older version must be ignored.
    fs.writeFileSync(path.join(cacheDir, "omniroute-models.json"), JSON.stringify({ models: [{ ...OLD_RECORD, id: "provider/legacy-model" }], tombstones: {} }));

    delete process.env.OMNIROUTE_API_KEY;
    process.env.OMNIROUTE_BASE_URL = baseUrlFor(port);
    process.env.OMNIROUTE_CACHE_DIR = cacheDir;
    // The gateway no longer serves provider/old-model.
    catalog = [{ id: "auto", object: "model" }, { id: "google/gemini-3-pro", object: "model", name: "Gemini 3 Pro" }];
    // The pi store holds the soon-to-be-delisted record; the gateway dropped it.
    stored = { url: baseUrlFor(port), scope: "all", models: [AUTO_RECORD, OLD_RECORD] };
    registrations.length = 0;

    const mod = await importIndex("../index.ts?probe=tomb");
    await mod.default(fakePi);
    const seed = modelsOf(registrations[0]);
    assert(!seed.some((m) => m.id === "provider/legacy-model"), "legacy unscoped cache file is ignored");

    const models = await invokeRefresh();
    assert(models.some((m) => m.id === "provider/old-model"), "delisted model survives via tombstone grace");
    assert(models.some((m) => m.id === "google/gemini-3-pro"), "live catalog still applies");
    assert(models.length === 3, `auto + live entry + tombstoned entry, got ${models.length}`);
    assert(fs.existsSync(tombPath), `tombstone store written at ${tombPath}`);
    const tombstones = JSON.parse(fs.readFileSync(tombPath, "utf8")) as Record<string, { deprecatedAt: string }>;
    const tomb = tombstones["provider/old-model"];
    assert(tomb && !Number.isNaN(Date.parse(tomb.deprecatedAt)), "refresh tombstones the delisted id");

    // Expire the tombstone — the model must disappear on the next refresh.
    tombstones["provider/old-model"].deprecatedAt = new Date(Date.now() - 20 * 86_400_000).toISOString();
    fs.writeFileSync(tombPath, JSON.stringify(tombstones));
    const expired = await invokeRefresh();
    assert(!expired.some((m) => m.id === "provider/old-model"), "expired tombstone is dropped");
    assert(expired.some((m) => m.id === "google/gemini-3-pro"), "live ids still served");
    // The gateway brings the id back — resurrected via the live catalog.
    catalog = [{ id: "auto", object: "model" }, { id: "google/gemini-3-pro", object: "model" }, { id: "provider/old-model", object: "model" }];
    const reborn = await invokeRefresh();
    assert(reborn.some((m) => m.id === "provider/old-model"), "resurrected id comes back via live catalog");
    void mod;
    console.log("probe 6 OK — tombstone grace, reconcile, expiry, resurrection, legacy ignored");
  });
  catalog = defaultCatalog();
}

async function probeKeyless(): Promise<void> {
  await withGateway(async (port) => {
    delete process.env.OMNIROUTE_API_KEY;
    process.env.OMNIROUTE_BASE_URL = baseUrlFor(port);
    process.env.OMNIROUTE_CACHE_DIR = freshCacheDir();
    registrations.length = 0;
    stored = undefined;
    const mod = await importIndex("../index.ts?probe=keyless");
    await mod.default(fakePi);
    assert(registrations[0].config.apiKey === "keyless", "keyless placeholder keeps the models available in pi");

    const models = await invokeRefresh();
    assert(receivedAuth === undefined, "no Authorization header on the catalog fetch when keyless");
    assert(models[0].id === "auto", "keyless registration works");
    assert(models.length === 5, "keyless discovery serves the live catalog");
    void mod;
    console.log("probe 7 OK — keyless: Authorization header omitted, discovery works");
  });
}

async function probePipeline(): Promise<void> {
  const m = await importModels("../models.ts?probe=pure");
  const rec = (over: Partial<ModelRecord> & Pick<ModelRecord, "id">): ModelRecord => ({
    ...over,
    name: over.name ?? over.id,
    reasoning: over.reasoning ?? false,
    input: over.input ?? ["text"],
    cost: over.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: over.contextWindow ?? 200000,
    maxTokens: over.maxTokens ?? 32768,
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

async function probeGatewayScoping(): Promise<void> {
  // Session 1 refreshes against gateway A and publishes a catalog.
  await withGateway(async (portA) => {
    process.env.OMNIROUTE_API_KEY = "scope-key";
    process.env.OMNIROUTE_BASE_URL = baseUrlFor(portA);
    process.env.OMNIROUTE_CACHE_DIR = freshCacheDir();
    registrations.length = 0;
    stored = undefined;
    const mod = await importIndex("../index.ts?probe=scopeA");
    await mod.default(fakePi);
    const modelsA = await invokeRefresh();
    assert(modelsA.length === 5, "gateway A catalog refreshed");
    assert((stored as Stored | undefined)?.url === baseUrlFor(portA), "publication carries the gateway url");
  });
  // Session 2 (new process env): different gateway URL, offline store kept.
  delete process.env.OMNIROUTE_API_KEY;
  process.env.OMNIROUTE_BASE_URL = "http://127.0.0.1:1/v1";
  process.env.OMNIROUTE_CACHE_DIR = freshCacheDir();
  registrations.length = 0;
  const modB = await importIndex("../index.ts?probe-scopeB");
  await modB.default(fakePi);
  const offline = await invokeRefresh({ allowNetwork: false });
  assert(offline.length === CURATED_COUNT, "gateway B serves curated — A's catalog is not leaked offline");
  assert(!offline.some((m) => m.id === "google/gemini-3-pro"), "no gateway-A only ids leak into B");
  console.log("probe 11 OK — foreign stored snapshot rejected, curated fallback preserved");
}

async function probeHeaders(): Promise<void> {
  const harness = async (keyed: boolean) => {
    process.env.OMNIROUTE_BASE_URL = "http://127.0.0.1:1/v1";
    process.env.OMNIROUTE_CACHE_DIR = freshCacheDir();
    if (keyed) process.env.OMNIROUTE_API_KEY = "env-real-key-123";
    else delete process.env.OMNIROUTE_API_KEY;
    const mod = await importIndex(`../index.ts?probe=headers-${keyed ? "keyed" : "keyless"}`);
    const headerHandler = handlers.get("before_provider_headers");
    assert(typeof headerHandler === "function", "before_provider_headers handler registered");
    const run = (auth: string | undefined, provider: string): Record<string, string | null> => {
      const headers: Record<string, string | null> = { "x-keep": "1" };
      if (auth !== undefined) headers.authorization = auth;
      headerHandler({ type: "before_provider_headers", headers }, { model: { provider } });
      return headers;
    };
    return { mod, run };
  };

  // Keyless: the local placeholder must never reach the gateway.
  const keyless = await harness(false);
  const stripped = keyless.run("Bearer keyless", "omniroute");
  assert(stripped.authorization === null, "keyless: placeholder bearer stripped from outgoing request");
  assert(stripped["x-keep"] === "1", "unrelated headers untouched");
  const otherProvider = keyless.run("Bearer keyless", "anthropic");
  assert(otherProvider.authorization === "Bearer keyless", "other providers' requests untouched");
  const loginKey = keyless.run("Bearer stored-login-key", "omniroute");
  assert(loginKey.authorization === "Bearer stored-login-key", "stored /login credentials pass through");

  // Real credentials always pass through.
  const keyed = await harness(true);
  const real = keyed.run("Bearer env-real-key-123", "omniroute");
  assert(real.authorization === "Bearer env-real-key-123", "real credentials pass through");
  console.log("probe 9 OK — chat-completions headers: placeholder stripped, real keys untouched");
}

async function probeCap(): Promise<void> {
  const m = await importModels("../models.ts?probe=cap");
  const rec = (id: string): ModelRecord => ({
    id, name: id, reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 32768,
  });
  const now = Date.now();
  const tombstoneFor = (id: string) => ({ deprecatedAt: new Date(now - 86_400_000).toISOString(), model: rec(id) });
  const live = Array.from({ length: 1000 }, (_, i) => rec(`prov/live-${i}`));
  const customs = [rec("custom/a"), rec("custom/b"), rec("custom/c")];
  const tombstones = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`prov/old-${i}`, tombstoneFor(`prov/old-${i}`)]));

  const built = m.buildModels([rec("auto"), ...live], customs, {}, tombstones, now);
  assert(built.length === 1000, `registered catalog capped at 1000, got ${built.length}`);
  assert(built[0].id === "auto", "auto survives the cap");
  assert(customs.every((c) => built.some((b) => b.id === c.id)), "customs outrank live under the cap");
  assert(!built.some((b) => b.id.startsWith("prov/old-")), "tombstones dropped first under the cap");

  const uncapped = m.buildModels([rec("auto"), rec("prov/x")], customs, {}, tombstones, now);
  assert(uncapped.length === 10, `under the cap everything is served, got ${uncapped.length}`);
  console.log("probe 10 OK — layered catalog honors the 1000-model cap with deterministic priority");
}

async function probeScope(): Promise<void> {
  // Default (no env): active scope. Without a dashboard API the picker
  // degrades to the curated floor (auto routes + verified ids), still persisted.
  await withGateway(async (port) => {
    process.env.OMNIROUTE_BASE_URL = baseUrlFor(port);
    process.env.OMNIROUTE_CACHE_DIR = freshCacheDir();
    delete process.env.OMNIROUTE_API_KEY;
    delete process.env.OMNIROUTE_MODEL_SCOPE;
    registrations.length = 0;
    stored = undefined;
    const mod = await importIndex("../index.ts?probe=scope-default");
    await mod.default(fakePi);
    const models = modelsOf(registrations[0]);
    assert(models.length === 1 && models[0].id === "auto", `active seed is the bare auto router, got ${models.length}`);
    const refreshed = await invokeRefresh();
    assert(receivedAuth === undefined, "keyless discovery sends no credentials");
    assert(refreshed.length === 1 && refreshed[0].id === "auto", `no dashboard API: auto router only, got ${refreshed.length}`);
    assert((stored as Stored | undefined)?.url === baseUrlFor(port), "active scope persists its catalog");
    void mod;
    console.log("probe 13 OK — active scope, no dashboard API: auto router only");
  });

  // Active scope with connections: auto routes + ids whose prefix is backed
  // by an active connection, unioned with the curated floor. Disabled
  // connections drop their prefixes even when the catalog advertises them.
  await withGateway(async (port) => {
    process.env.OMNIROUTE_BASE_URL = baseUrlFor(port);
    process.env.OMNIROUTE_CACHE_DIR = freshCacheDir();
    process.env.OMNIROUTE_MODEL_SCOPE = "active";
    fakeConnections = JSON.stringify({
      connections: [
        { isActive: true, provider: "google" },
        { isActive: true, provider: "claude" },
        { isActive: false, providerSpecificData: { prefix: "a-random" } },
      ],
    });
    catalog = [...defaultCatalog(), { id: "cc/claude-fake-9", object: "model" }];
    registrations.length = 0;
    stored = undefined;
    const mod = await importIndex("../index.ts?probe=scope-active");
    await mod.default(fakePi);
    const refreshed = await invokeRefresh();
    const ids = refreshed.map((m) => String(m.id));
    assert(ids.includes("google/gemini-3-pro") && ids.includes("google/gemini-2.5-pro"), "standard rows: top-level provider field used as prefix");
    assert(ids.includes("cc/claude-fake-9"), "canonical alias (claude -> cc) keeps aliased catalog ids");
    assert(!ids.includes("a-random/unknown-model-1b"), "disabled-connection prefixes dropped");
    assert(!ids.includes("glm/glm-5.2"), "no curated union: unbacked floor ids absent from the active cut");
    assert(!ids.some((id) => String(id).startsWith("auto/")), "auto/* variants dropped from the active cut");
    assert(refreshed.length === 5, `connection-backed ids + the auto router, got ${refreshed.length}`);
    assert((stored as Stored | undefined)?.scope === "active", "published snapshot records its scope");
    catalog = defaultCatalog();
    delete process.env.OMNIROUTE_MODEL_SCOPE;
    void mod;
    console.log(`probe 14 OK — active scope: ${refreshed.length} ids (connections + auto router)`);
  });

  // curated: static floor — no network, no store.
  await withGateway(async (port) => {
    process.env.OMNIROUTE_BASE_URL = baseUrlFor(port);
    process.env.OMNIROUTE_CACHE_DIR = freshCacheDir();
    process.env.OMNIROUTE_MODEL_SCOPE = "curated";
    registrations.length = 0;
    stored = undefined;
    const mod = await importIndex("../index.ts?probe=scope-curated");
    await mod.default(fakePi);
    const models = modelsOf(registrations[0]);
    assert(models.length === CURATED_COUNT, `curated scope registers exactly the curated floor, got ${models.length}`);
    const refreshed = await invokeRefresh();
    assert(receivedAuth === undefined, "curated scope never fetches the live catalog");
    assert(refreshed.length === CURATED_COUNT, "refresh serves the curated floor");
    assert(stored === undefined, "curated scope persists no store snapshot");
    delete process.env.OMNIROUTE_MODEL_SCOPE;
    void mod;
    console.log(`probe 15 OK — curated scope: ${CURATED_COUNT} models, zero network`);
  });

  // routes: only the auto router + auto/* ids.
  await withGateway(async (port) => {
    process.env.OMNIROUTE_BASE_URL = baseUrlFor(port);
    process.env.OMNIROUTE_CACHE_DIR = freshCacheDir();
    process.env.OMNIROUTE_MODEL_SCOPE = "routes";
    registrations.length = 0;
    const mod = await importIndex("../index.ts?probe=scope-routes");
    await mod.default(fakePi);
    const models = modelsOf(registrations[0]);
    assert(models.every((m) => String(m.id) === "auto" || String(m.id).startsWith("auto/")), "routes scope registers only auto routes");
    assert(models.length < CURATED_COUNT, "routes scope is a subset of curated");
    delete process.env.OMNIROUTE_MODEL_SCOPE;
    void mod;
    console.log(`probe 16 OK — routes scope: ${models.length} auto routes only`);
  });

  // all: opt-in restores the live catalog (fetch happens).
  await withGateway(async (port) => {
    process.env.OMNIROUTE_BASE_URL = baseUrlFor(port);
    process.env.OMNIROUTE_CACHE_DIR = freshCacheDir();
    process.env.OMNIROUTE_API_KEY = "scope-all-key";
    process.env.OMNIROUTE_MODEL_SCOPE = "all";
    registrations.length = 0;
    stored = undefined;
    const mod = await importIndex("../index.ts?probe=scope-all");
    await mod.default(fakePi);
    const refreshed = await invokeRefresh();
    assert(receivedAuth === "Bearer scope-all-key", "all scope fetches the live catalog");
    assert(refreshed.length === 5, `all scope serves the live catalog, got ${refreshed.length}`);
    delete process.env.OMNIROUTE_MODEL_SCOPE;
    delete process.env.OMNIROUTE_API_KEY;
    void mod;
    console.log("probe 17 OK — all scope: live catalog opt-in");
  });
}

async function probeStoreScoping(): Promise<void> {
  // Unreachable gateway: only the offline phases run, so the assertions are
  // purely about which stored snapshots a scope accepts.
  process.env.OMNIROUTE_BASE_URL = "http://127.0.0.1:1/v1";
  process.env.OMNIROUTE_CACHE_DIR = freshCacheDir();
  process.env.OMNIROUTE_MODEL_SCOPE = "active";
  registrations.length = 0;
  const mod = await importIndex("../index.ts?probe=store-scope");
  await mod.default(fakePi);
  const url = baseUrlFor(1);
  // Foreign-scope snapshot (persisted under all): rejected offline.
  stored = { url, scope: "all", models: [OLD_RECORD] };
  let offline = await invokeRefresh({ allowNetwork: false });
  assert(offline.length === CURATED_COUNT, `foreign-scope snapshot rejected, curated floor served, got ${offline.length}`);
  assert(!offline.some((m) => String(m.id) === "provider/old-model"), "foreign-scope ids not leaked");
  // Legacy snapshot without a scope field (pre-scope upgrade): rejected too.
  stored = { url, models: [OLD_RECORD] };
  offline = await invokeRefresh({ allowNetwork: false });
  assert(offline.length === CURATED_COUNT, "legacy scope-less snapshot rejected");
  // Same-scope snapshot: served offline.
  stored = { url, scope: "active", models: [AUTO_RECORD, OLD_RECORD] };
  offline = await invokeRefresh({ allowNetwork: false });
  assert(offline.length === 2 && offline[0].id === "auto", "same-scope snapshot served offline");
  delete process.env.OMNIROUTE_MODEL_SCOPE;
  void mod;
  console.log("probe 18 OK — store snapshots are scope-aware");
}

async function probePublishRejects(): Promise<void> {
  await withGateway(async (port) => {
    process.env.OMNIROUTE_API_KEY = "reject-key";
    process.env.OMNIROUTE_BASE_URL = baseUrlFor(port);
    process.env.OMNIROUTE_CACHE_DIR = freshCacheDir();
    registrations.length = 0;
    stored = undefined;
    const mod = await importIndex("../index.ts?probe=publish-rejects");
    await mod.default(fakePi);
    // pi's store rejects the publication; the merged catalog must still be
    // registered for the session and returned to pi -- never thrown out.
    const models = await invokeRefresh({ publishFails: true });
    assert(models.length === 5, `merged catalog still served after rejection, got ${models.length}`);
    assert(models.some((m) => m.id === "google/gemini-3-pro"), "live ids present despite rejection");
    assert(regCount() === 2, "hot-swap registered despite the rejected publication");
    assert(stored === undefined, "rejected publication did not persist");
    void mod;
    console.log("probe 12 OK — a rejected publication degrades to a session-local hot-swap");
  });
}

// ── Run ───────────────────────────────────────────────────────────────────────
try {
  await probeLive();
  await probeNonBlocking();
  await probeRefresh();
  await probeOfflineCold();
  await probeOfflineWarm();
  await probeTombstones();
  await probeKeyless();
  await probePipeline();
  await probeHeaders();
  await probeCap();
  await probeGatewayScoping();
  await probePublishRejects();
  await probeScope();
  await probeStoreScoping();
  console.log("ALL PROBES PASSED");
} finally {
  for (const dir of cacheDirs) fs.rmSync(dir, { recursive: true, force: true });
}