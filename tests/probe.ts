/**
 * Behavioral probe: loads the real extension factory against a simulated
 * OmniRoute gateway and a fake pi ExtensionAPI, then asserts registration,
 * auth handling, merge semantics, heuristics, the session refresh, and the
 * offline fallback path.
 *
 *   bun tests/probe.ts
 */
import { createServer, type IncomingMessage, type Server } from "node:http";

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

// ── Simulated gateway: /v1/models over a mutable catalog ────────────────────
interface CatalogEntry {
  id: string;
  object?: string;
  name?: string;
  context_length?: number;
  max_tokens?: number;
}
let catalog: CatalogEntry[] = [
  { id: "auto", object: "model" },
  { id: "cc/claude-sonnet-4-6", object: "model", name: "cc/claude-sonnet-4-6" },
  { id: "google/gemini-3-pro", object: "model", name: "Gemini 3 Pro", max_tokens: 16384 },
  { id: "google/gemini-2.5-pro", object: "model", context_length: 1_048_576 },
  { id: "a-random/unknown-model-1b", object: "model" },
];
let receivedAuth: string | undefined;

async function withGateway(fn: (port: number) => Promise<void>): Promise<void> {
  const server: Server = createServer((req: IncomingMessage, res) => {
    receivedAuth = req.headers.authorization;
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ object: "list", data: catalog }));
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

// ── Probes ────────────────────────────────────────────────────────────────────
async function probeLive(): Promise<void> {
  await withGateway(async (port) => {
    process.env.OMNIROUTE_BASE_URL = baseUrlFor(port);
    process.env.OMNIROUTE_API_KEY = "secret-key-123";
    registrations.length = 0;

    const mod = await import(`../index.ts?probe=live`);
    await mod.default(fakePi);

    assert(registrations.length === 1, "exactly one provider registered");
    const { name, config } = registrations[0];
    assert(name === "omniroute", `provider id, got ${name}`);
    assert(config.baseUrl === baseUrlFor(port), "baseUrl points at gateway");
    assert(config.api === "openai-completions", "api is openai-completions");
    assert(config.apiKey === "$OMNIROUTE_API_KEY", "apiKey env-ref set");
    assert(receivedAuth === "Bearer secret-key-123", "catalog fetch authorized");

    const models = config.models as Array<Record<string, unknown>>;
    assert(models[0].id === "auto", "auto first");
    assert(models.length === 5, `live catalog size ${models.length}`);

    // Curated extras must NOT be appended while the live catalog is present:
    // only the injected "auto" entry survives an empty live list.
    const { mergeCatalogs } = mod as { mergeCatalogs(l: unknown[], c: unknown[]): Array<{ id: string }> };
    const mergedEmptyLive = mergeCatalogs([], catalog as unknown[]);
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
    console.log("probe 1 OK — registration, auth header, merge, heuristics");
  });
}

async function probeRefresh(): Promise<void> {
  await withGateway(async (port) => {
    process.env.OMNIROUTE_BASE_URL = baseUrlFor(port);
    registrations.length = 0;
    const mod = await import(`../index.ts?probe=refresh`);
    await mod.default(fakePi);
    const before = (registrations[0].config.models as unknown[]).length;

    catalog = [...catalog, { id: "provider/fresh-model-2", object: "model" }];
    const sessionHandler = handlers.get("session_start");
    assert(typeof sessionHandler === "function", "session_start handler registered");
    await sessionHandler({}, {});

    const after = registrations[registrations.length - 1].config.models as Array<{ id: string }>;
    assert(after.some((m) => m.id === "provider/fresh-model-2"), "refresh adds new catalog entry");
    assert(after.length === before + 1, `refresh size ${after.length} vs ${before}`);
    console.log("probe 2 OK — session_start refresh re-fetches the catalog");
  });
}

async function probeOffline(): Promise<void> {
  delete process.env.OMNIROUTE_API_KEY;
  process.env.OMNIROUTE_BASE_URL = "http://127.0.0.1:1/v1"; // port 1 → connection refused
  registrations.length = 0;
  const mod = await import(`../index.ts?probe=offline`);
  await mod.default(fakePi);

  assert(registrations.length === 1, "still registers provider offline");
  const models = registrations[0].config.models as unknown[];
  assert(models.length === 6, `offline fallback = curated list, got ${models.length}`);
  assert((models[0] as { id: string }).id === "auto", "auto first offline");
  console.log("probe 3 OK — unreachable gateway → curated fallback");
}

async function probeKeyless(): Promise<void> {
  await withGateway(async (port) => {
    delete process.env.OMNIROUTE_API_KEY;
    process.env.OMNIROUTE_BASE_URL = baseUrlFor(port);
    registrations.length = 0;
    const mod = await import(`../index.ts?probe=keyless`);
    await mod.default(fakePi);
    assert(receivedAuth === undefined, "no Authorization header when keyless");
    const models = registrations[0].config.models as Array<{ id: string }>;
    assert(models[0].id === "auto", "keyless registration works");
    console.log("probe 4 OK — keyless: Authorization header omitted, registration fine");
  });
}

await probeLive();
await probeRefresh();
await probeOffline();
await probeKeyless();
console.log("ALL PROBES PASSED");
