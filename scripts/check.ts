/**
 * Offline sanity check for pi-omniroute (no pi runtime required).
 *
 *   bun scripts/check.ts
 *
 * Verifies:
 *   1. package.json pi.extensions points at an existing entry file
 *   2. models.json is a valid curated model list with the required shape
 *   3. patch.json entries only override known fields; custom-models.json
 *      entries are complete models with unique ids
 *   4. index.ts exports the extension factory and its pure helpers load
 *   5. the pipeline invariants hold: patches never create ids, "auto" sorts first
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const root = new URL("..", import.meta.url);

const REQUIRED_KEYS = ["id", "name", "reasoning", "input", "cost", "contextWindow", "maxTokens"] as const;

function fail(message: string): never {
  throw new Error(`check failed: ${message}`);
}

/** Validate one model record; returns its id. */
function validateModel(raw: unknown, file: string): string {
  if (!raw || typeof raw !== "object") fail(`${file} entries must be objects`);
  const model = raw as Record<string, unknown>;
  for (const key of REQUIRED_KEYS) {
    if (!(key in model)) fail(`${file} model "${String(model.id)}" missing key "${key}"`);
  }
  if (typeof model.id !== "string" || !model.id) fail(`${file} model id must be a non-empty string`);
  if (!Array.isArray(model.input) || model.input.length === 0) fail(`${file} model "${model.id}" needs input types`);
  if (typeof model.contextWindow !== "number" || model.contextWindow <= 0)
    fail(`${file} model "${model.id}" needs a positive contextWindow`);
  if (typeof model.maxTokens !== "number" || model.maxTokens <= 0)
    fail(`${file} model "${model.id}" needs a positive maxTokens`);
  const cost = model.cost as Record<string, unknown> | undefined;
  if (!cost || typeof cost.input !== "number" || typeof cost.output !== "number")
    fail(`${file} model "${model.id}" needs numeric cost.input/output`);
  return model.id;
}

const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8")) as {
  pi?: { extensions?: string[] };
};
const models = JSON.parse(await readFile(new URL("models.json", root), "utf8")) as unknown[];
const patch = JSON.parse(await readFile(new URL("patch.json", root), "utf8")) as unknown;
const custom = JSON.parse(await readFile(new URL("custom-models.json", root), "utf8")) as unknown;

if (!pkg.pi?.extensions?.length) fail("package.json pi.extensions is missing");
for (const entry of pkg.pi.extensions) {
  if (!entry.startsWith("./") || !existsSync(new URL(entry, root)))
    fail(`extension entry not found: ${entry}`);
}
if (!Array.isArray(models) || models.length === 0) fail("models.json has no models");

const curatedIds = new Set<string>();
for (const raw of models) {
  const id = validateModel(raw, "models.json");
  if (curatedIds.has(id)) fail(`models.json has duplicate id "${id}"`);
  curatedIds.add(id);
}

// patch.json — per-field overrides keyed by model id; must never create ids.
const PATCH_KEYS = new Set(["name", "reasoning", "input", "cost", "contextWindow", "maxTokens", "compat"]);
if (!patch || typeof patch !== "object" || Array.isArray(patch))
  fail("patch.json must be an object keyed by model id");
for (const [id, entry] of Object.entries(patch as Record<string, unknown>)) {
  if (!id.trim()) fail("patch.json model ids must be non-empty");
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    fail(`patch.json entry "${id}" must be an object`);
  for (const key of Object.keys(entry as Record<string, unknown>)) {
    if (!PATCH_KEYS.has(key)) fail(`patch.json entry "${id}" has unknown key "${key}"`);
  }
}

// custom-models.json — complete models not in the gateway catalog.
if (!Array.isArray(custom)) fail("custom-models.json must be an array");
const customIds = new Set<string>();
for (const raw of custom) {
  const id = validateModel(raw, "custom-models.json");
  if (customIds.has(id)) fail(`custom-models.json has duplicate id "${id}"`);
  customIds.add(id);
}

const mod = await import("../index.ts");
if (typeof mod.default !== "function")
  fail("index.ts must export the extension factory as its default export");
for (const fn of ["inferMetadata", "transformCatalogModel", "mergeCatalogs"]) {
  if (typeof (mod as Record<string, unknown>)[fn] !== "function")
    fail(`index.ts should export ${fn}()`);
}

const { buildModels } = (await import("../models.ts")) as {
  buildModels(base: unknown[], custom: unknown[], patch: Record<string, unknown>): Array<{ id: string }>;
};

// Patches never create ids.
const ghost = buildModels([], [], { "ghost/id": { name: "Ghost" } });
if (ghost.length !== 0) fail("patch entries must never create ids");

// mergeCatalogs smoke: auto always sorts first.
const mergeCatalogs = (mod as { mergeCatalogs(l: unknown[], c: unknown[]): { id: string }[] }).mergeCatalogs;
const auto = mergeCatalogs(
  [
    { id: "google/gemini-3-pro", name: "gemini-3-pro", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16384 },
    { id: "cc/claude-sonnet-4-6", name: "cc/claude-sonnet-4-6", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16384 },
  ],
  models,
);
const ids = auto.map((m) => m.id);
if (ids[0] !== "auto") fail("expected 'auto' as the first merged model");

console.log(
  `check ok: ${models.length} curated models, ${Object.keys(patch as object).length} patches, ${custom.length} custom models, ${pkg.pi?.extensions?.length} extension entry, exports OK, merge(${ids.join(", ")}) OK`,
);
