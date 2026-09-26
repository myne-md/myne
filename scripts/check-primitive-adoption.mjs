#!/usr/bin/env node
// Guard: interactive elements go through the primitives (myne-md/myne#774,
// epic #772 lane 1).
//
// The failure it prevents is the one a user reports as "the buttons don't match".
// `src/components/primitives/` holds `Button`, `IconButton`, `Segmented`,
// `Select`, `Switch` and `Input`, and when this landed 95 files rendered a raw
// `<button>` against 58 that imported the primitive. Every one of those 95 had
// re-derived padding, radius, hover, press and focus by hand, so the app has as
// many button designs as it has authors.
//
// Nothing else reports this. It compiles, it renders, it passes every test, and
// a reviewer sees one file at a time — which is exactly the shape the design
// system was supposed to solve and the shape that regrows the moment nobody is
// counting.
//
// A RATCHET, like `check-token-adoption.mjs` and for the same reason: 95 files
// cannot convert in one change, and a gate that is red on the day it lands
// teaches people to ignore red. A file's count may fall and may never rise; a
// NEW file starts at zero, so new code is held to the standard the tree is
// moving toward rather than to its current average.
//
// WHAT IT DOES NOT COUNT, because each is a legitimate raw element and counting
// them would make the number meaningless:
//
//   - the primitives themselves — they ARE the raw element;
//   - a `<button>` inside an editor widget built from DOM rather than JSX
//     (CodeMirror widgets have no React to hand);
//   - `<input>` of a type no primitive covers (`checkbox`, `radio`, `range`,
//     `color`, `file`), where `Input` would be the wrong component;
//   - anything already carrying a `myne-` class, which is the migration in
//     progress rather than a bypass.
//
// VERIFYING THIS GUARD MEANS BREAKING IT — `tests/scripts/primitiveAdoption.test.ts`.
//
// Run by hand:   node scripts/check-primitive-adoption.mjs
//                node scripts/check-primitive-adoption.mjs --record
// Wired into:    lefthook `pre-commit`, CI `pnpm-build`.

import { readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { presentSharedRoots } from "./lib/shared-roots.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const RECORD = join(ROOT, "scripts/primitive-adoption.json");

/** Directories whose files ARE the primitives. */
const PRIMITIVE_DIRS = [
  "src/components/primitives/",
  "mobile/src/components/",
];

/** `<input type="...">` values no primitive covers. */
const UNCOVERED_INPUT_TYPES = new Set([
  "checkbox", "radio", "range", "color", "file", "hidden",
]);

const SCAN_EXT = new Set([".tsx"]);

function scrub(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Brace-aware opening tags — `style={{...}}` contains `>` inside expressions. */
function openingTags(src, names) {
  const out = [];
  const re = new RegExp(`<(${names.join("|")})(\\s|>)`, "g");
  let m;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length;
    let depth = 0;
    let quote = null;
    while (i < src.length) {
      const c = src[i];
      if (quote !== null) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
      i++;
    }
    out.push({ tag: m[1], attrs: src.slice(m.index, i), index: m.index });
  }
  return out;
}

async function walk(dir, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (SCAN_EXT.has(e.name.slice(e.name.lastIndexOf(".")))) {
      if (/\.(test|spec)\.tsx?$/.test(e.name)) continue;
      out.push(full);
    }
  }
  return out;
}

const counts = {};
const { present, missing } = presentSharedRoots(ROOT);
if (missing.length > 0) {
  console.error(`primitive-adoption: shared root(s) absent: ${missing.join(", ")}`);
  process.exit(1);
}

for (const root of present) {
  for (const file of await walk(join(ROOT, root), [])) {
    const rel = relative(ROOT, file);
    if (PRIMITIVE_DIRS.some((d) => rel.startsWith(d))) continue;
    const src = scrub(readFileSync(file, "utf8"));
    let n = 0;
    for (const { tag, attrs } of openingTags(src, ["button", "input", "select"])) {
      // Already migrating: a `myne-` class means it renders from the shared
      // sheet, which is the destination rather than a bypass of it.
      if (/className\s*=\s*["'`][^"'`]*myne-/.test(attrs)) continue;
      if (tag === "input") {
        const t = /\btype\s*=\s*["']([a-z]+)["']/.exec(attrs);
        if (t !== null && UNCOVERED_INPUT_TYPES.has(t[1])) continue;
      }
      n++;
    }
    if (n > 0) counts[rel] = n;
  }
}

const recorded = JSON.parse(readFileSync(RECORD, "utf8"));

if (process.argv.includes("--record")) {
  writeFileSync(RECORD, `${JSON.stringify(counts, null, 2)}\n`);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.error(
    `primitive-adoption: recorded ${Object.keys(counts).length} file(s), ${total} raw control(s)`,
  );
  process.exit(0);
}

const grew = [];
for (const [rel, n] of Object.entries(counts)) {
  const was = recorded[rel] ?? 0;
  if (n > was) grew.push(`${rel}: ${was} -> ${n}`);
}

if (grew.length > 0) {
  console.error("primitive-adoption: raw interactive elements grew:\n");
  for (const g of grew) console.error(`    ${g}`);
  console.error(
    "\n  Use the primitive (`<Button>`, `<IconButton>`, `<Select>`, `<Switch>`,\n" +
      "  `<Input>`, `<Segmented>`) instead of re-deriving padding, radius, hover,\n" +
      "  press and focus by hand. Every hand-rolled control is one more button\n" +
      "  design in an app that is supposed to have one.\n\n" +
      "  If the element genuinely is not a primitive — an editor DOM widget, an\n" +
      "  input type no primitive covers — say so in a comment at the call site,\n" +
      "  and re-record with --record.\n",
  );
  process.exit(1);
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);
const before = Object.values(recorded).reduce((a, b) => a + b, 0);
console.error(
  `primitive-adoption: ok (${total} raw control(s) across ${Object.keys(counts).length} file(s)` +
    `${total < before ? `; ${before - total} fewer than recorded — re-record to lock it in` : ""})`,
);
