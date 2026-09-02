/**
 * Offline sanity check for pi-omniroute (no pi runtime required).
 *
 *   bun scripts/check.ts
 *
 * Verifies:
 *   1. package.json pi.extensions points at an existing entry file
 *   2. models.json is a valid curated model list with the required shape
 *   3. index.ts exports the extension factory and its pure helpers load
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const root = new URL("..", import.meta.url);

const REQUIRED_KEYS = ["id", "name", "reasoning", "input", "cost", "contextWindow", "maxTokens"] as const;

function fail(message: string): never {
  throw new Error(`check failed: ${message}`);
}

const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8")) as {
  pi?: { extensions?: string[] };
};
const models = JSON.parse(await readFile(new URL("models.json", root), "utf8")) as unknown[];

if (!pkg.pi?.extensions?.length) fail("package.json pi.extensions is missing");
for (const entry of pkg.pi.extensions) {
  if (!entry.startsWith("./") || !existsSync(new URL(entry, root)))
    fail(`extension entry not found: ${entry}`);
}
if (models.length === 0) fail("models.json has no models");

for (const raw of models) {
  const model = raw as Record<string, unknown>;
  for (const key of REQUIRED_KEYS) {
    if (!(key in model)) fail(`model "${String(model.id)}" missing key "${key}"`);
  }
  if (typeof model.id !== "string") fail("model id must be a string");
  if (!Array.isArray(model.input) || model.input.length === 0) fail(`model "${String(model.id)}" needs input types`);
  if (typeof model.contextWindow !== "number" || model.contextWindow <= 0)
    fail(`model "${String(model.id)}" needs a positive contextWindow`);
  if (typeof model.maxTokens !== "number" || model.maxTokens <= 0)
    fail(`model "${String(model.id)}" needs a positive maxTokens`);
  const cost = model.cost as Record<string, unknown> | undefined;
  if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number")
    fail(`model "${String(model.id)}" needs numeric cost.input/output`);
}

const mod = await import("../index.ts");
if (typeof mod.default !== "function")
  fail("index.ts must export the extension factory as its default export");
for (const fn of ["inferMetadata", "transformCatalogModel", "mergeCatalogs"]) {
  if (typeof (mod as Record<string, unknown>)[fn] !== "function")
    fail(`index.ts should export ${fn}()`);
}

const mergeCatalog = (mod as { mergeCatalogs(l: unknown[], c: unknown[]): { id: string }[] }).mergeCatalogs;
const auto = mergeCatalog(
  [
    { id: "google/gemini-3-pro", name: "gemini-3-pro", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16384 },
    { id: "cc/claude-sonnet-4-6", name: "cc/claude-sonnet-4-6", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16384 },
  ],
  models,
);
const ids = auto.map((m) => m.id);
if (ids[0] !== "auto") fail("expected 'auto' as the first merged model");

console.log(
  `check ok: ${models.length} curated models, ${pkg.pi?.extensions?.length} extension entry, exports OK, merge(${ids.join(", ")}) OK`,
);
