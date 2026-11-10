// check-copy-budget.mjs — a duplicated word stays duplicated, and a surface's
// visible copy does not grow, unless a human records that it should.
//
// What it prevents, two directions of the same failure:
//
//   1. `common.*` owns a value and a second key starts carrying it again. This is
//      what the 2026-11 copy campaign removed (myne-md/myne#23): 12 words and 49
//      phrases were told once per surface, `Cancel` under 47 call sites and
//      `Untitled` under 19. Nothing stopped them coming back, because
//      `check-i18n-duplicates.mjs` deliberately starts at MIN_LEN 25, where the
//      #649 class of full sentences lives: short labels were never compared.
//   2. A settings surface grows a paragraph. Long copy is not wrong, but a surface
//      that grows one panel at a time has nobody measuring the whole; this half
//      records the English character total each panel renders and lets it only go
//      down, the same ratchet `check-token-adoption.mjs` uses for literals.
//
// Both halves read one map: which keys a file references, and how long each
// value is. The key reference is `t("…")` plus the two indirections this tree
// uses (`labelKey:` and `confirmKey:`), because a value reached through one of
// those is as visible as a call site and the campaign had to repoint both.
//
// The record is `scripts/copy-budget.json`:
//
//   aliases:  value-owner -> the keys allowed to carry the same value anyway,
//             each with a reason. `--record` seeds a NEW alias with the string
//             REASON REQUIRED and the checker rejects that exact string, so a
//             re-baseline can never come back green on its own: a ratchet that
//             licenses whatever it finds on the day it is run is not a ratchet.
//   surfaces: file -> English character total, re-recorded only downward.
//
// What this cannot see, stated so nobody reads the green tick as more than it is:
// a key reached through an interpolated prefix (`editor.taskField.title.${kind}`)
// is invisible here, and so is any copy built at runtime rather than in the
// catalogue. Those are the two shapes that broke the mechanical sweep in #23;
// they are handled by the copy specs that name the keys, not by this guard.
//
// Verifying this guard means breaking it, not running it: add a second key with a
// value `common.*` already owns and watch it name both keys, then lengthen one
// settings helper and watch it name the surface and the delta. Then run
// `--record` on that dirty tree and confirm it now FAILS on the placeholder
// reason, which is the half nobody checks.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

export const EN_CATALOG_PATH = join(ROOT, "locales", "en", "common.json");
export const RECORD_PATH = join(HERE, "copy-budget.json");

/** Shortest reason that says anything. Same floor the duplicate roster uses. */
export const MIN_REASON_LEN = 20;
export const PLACEHOLDER = "REASON REQUIRED";

/** The keys' own concept, read from both client trees that render settings. */
const SURFACE_ROOTS = ["src/components/settings", "mobile/src/components/settings"];

/** How a value reaches the screen without a `t("…")` at the site. */
const KEY_REF = /(?:\bt\(\s*|\blabelKey:\s*|\bconfirmKey:\s*|\btitleKey:\s*)["']([A-Za-z0-9_.]+)["']/g;

function walk(node, prefix = []) {
  const out = [];
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === "object") out.push(...walk(v, [...prefix, k]));
    else out.push([[...prefix, k].join("."), String(v)]);
  }
  return out;
}

export function loadCatalog() {
  return new Map(walk(JSON.parse(readFileSync(EN_CATALOG_PATH, "utf8"))));
}

/** The value each `common.*` key owns, and the key that owns it. */
export function owners(catalog) {
  const byValue = new Map();
  for (const [key, value] of catalog) {
    if (!key.startsWith("common.")) continue;
    if (!byValue.has(value)) byValue.set(value, key);
  }
  return byValue;
}

/**
 * Every (file, key) pair under the surface roots. A key counts once per file even
 * when the file names it twice, because the budget is about what a panel says.
 */
export function surfaceKeys() {
  const found = new Map();
  for (const root of SURFACE_ROOTS) {
    const abs = join(ROOT, root);
    if (!existsSync(abs)) continue;
    for (const file of globSync("**/*.{ts,tsx}", { cwd: abs })) {
      const path = join(abs, file);
      const source = readFileSync(path, "utf8");
      const keys = new Set();
      for (const m of source.matchAll(KEY_REF)) keys.add(m[1]);
      if (keys.size > 0) found.set(relative(ROOT, path), keys);
    }
  }
  return found;
}

/** Non-`common.*` keys that carry a value a `common.*` key already owns. */
export function aliases(catalog) {
  const byValue = owners(catalog);
  const out = new Map();
  for (const [key, value] of catalog) {
    if (key.startsWith("common.")) continue;
    const owner = byValue.get(value);
    if (owner) out.set(key, { owner, value });
  }
  return out;
}

export function surfaces(catalog, keysByFile) {
  const out = new Map();
  for (const [file, keys] of keysByFile) {
    let chars = 0;
    const counted = [];
    for (const key of keys) {
      const value = catalog.get(key);
      if (value === undefined) continue;
      chars += value.length;
      counted.push([key, value.length]);
    }
    counted.sort((a, b) => b[1] - a[1]);
    out.set(file, { chars, counted });
  }
  return out;
}

function readRecord() {
  if (!existsSync(RECORD_PATH)) return { aliases: {}, surfaces: {} };
  const raw = JSON.parse(readFileSync(RECORD_PATH, "utf8"));
  return { aliases: raw.aliases ?? {}, surfaces: raw.surfaces ?? {} };
}

/** Checks, returning the failures as strings. Empty means clean. */
export function check({ catalog = loadCatalog(), record = readRecord(), keysByFile = surfaceKeys() } = {}) {
  const problems = [];
  const found = aliases(catalog);

  for (const [key, { owner, value }] of found) {
    const entry = record.aliases[key];
    if (!entry) {
      problems.push(
        `"${key}" carries ${JSON.stringify(value)}, which ${owner} already owns. Point it at ${owner}, ` +
          `or record the alias with a reason in scripts/copy-budget.json.`,
      );
      continue;
    }
    if (entry.owner !== owner) {
      problems.push(
        `"${key}" is recorded against ${entry.owner} but ${owner} owns that value now. ` +
          `Update the record or point the key at its owner.`,
      );
    }
    if (!entry.reason || entry.reason.length < MIN_REASON_LEN || entry.reason === PLACEHOLDER) {
      problems.push(
        `the alias "${key}" carries no usable reason ("${entry.reason ?? ""}"). ` +
          `Say why these two keys share one sentence.`,
      );
    }
  }

  for (const key of Object.keys(record.aliases)) {
    if (!found.has(key)) {
      problems.push(
        `"${key}" is recorded as an alias but no longer shares a value with its owner. ` +
          `Drop the entry: the record exits by editing it, not by silence.`,
      );
    }
  }

  const totals = surfaces(catalog, keysByFile);
  for (const [file, { chars, counted }] of totals) {
    const recorded = record.surfaces[file];
    if (recorded === undefined) {
      problems.push(
        `${file} renders ${chars} characters of English copy and is not recorded. ` +
          `Run --record to take its current size as the ceiling.`,
      );
      continue;
    }
    if (chars > recorded) {
      const grown = counted.slice(0, 3).map(([k, n]) => `${k} (${n})`).join(", ");
      problems.push(
        `${file} grew ${chars - recorded} character(s) of visible copy, ${recorded} to ${chars}. ` +
          `Say each fact once, or re-record with a reason. Largest keys: ${grown}.`,
      );
    }
  }

  for (const [file, chars] of Object.entries(record.surfaces)) {
    if (!totals.has(file)) {
      problems.push(`${file} is recorded with ${chars} character(s) but renders no copy now. Drop the entry.`);
    }
  }

  return problems;
}

export function record({ catalog = loadCatalog(), keysByFile = surfaceKeys(), previous = readRecord() } = {}) {
  const aliases = {};
  for (const [key, { owner }] of aliases0(catalog)) {
    // Keep a reason a human already wrote; a new alias starts at the placeholder
    // the checker refuses, so `--record` cannot license it silently.
    aliases[key] = { owner, reason: previous.aliases[key]?.reason ?? PLACEHOLDER };
  }
  const surfaceRecord = {};
  for (const [file, { chars }] of surfaces(catalog, keysByFile)) surfaceRecord[file] = chars;
  return { aliases, surfaces: surfaceRecord };
}

function aliases0(catalog) {
  return [...aliases(catalog).entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function main(argv) {
  const catalog = loadCatalog();
  const keysByFile = surfaceKeys();
  const writing = argv.includes("--record");

  if (writing) {
    const next = record({ catalog, keysByFile });
    writeFileSync(RECORD_PATH, `${JSON.stringify(next, null, 2)}\n`);
    const needReason = Object.values(next.aliases).filter((a) => a.reason === PLACEHOLDER).length;
    console.log(
      `copy-budget: record written (${Object.keys(next.aliases).length} alias(es), ` +
        `${Object.keys(next.surfaces).length} surface(s), ${needReason} need a human reason). ` +
        `--check fails until every reason is written.`,
    );
    return 0;
  }

  const problems = check({ catalog, record: readRecord(), keysByFile });
  if (problems.length === 0) {
    const total = [...surfaces(catalog, keysByFile).values()].reduce((n, s) => n + s.chars, 0);
    console.log(
      `copy-budget: ok (${keysByFile.size} surface(s), ${total} character(s) of visible settings copy; ` +
        `${Object.keys(readRecord().aliases).length} recorded alias(es)). This number must only go down.`,
    );
    return 0;
  }
  console.error("copy-budget: FAILED");
  for (const p of problems) console.error(`  - ${p}`);
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv.slice(2)));
