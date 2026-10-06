#!/usr/bin/env node
// Guard: the tooltip convention (epic myne-md/myne#772 lane 2c, myne-md/myne#775).
//
// The failure it prevents is the interface being unreadable to anyone who has
// not memorised it, and the mechanism is a browser default nobody chose.
//
// `src/components/primitives/Tooltip.tsx` exists and its own header says why:
// the native `title=` tooltip appears after a ~1 second delay, renders as an
// unstyled white OS chip that ignores the app's theme entirely, clips at the
// window edge, and never appears on keyboard focus. It was used by 3 files
// against 262 native `title=` attributes when this landed — so the component
// written to replace the browser default had lost to it almost everywhere.
//
// TWO RULES:
//
//   1. `title=` on an INTERACTIVE element is a finding. It is the wrong
//      affordance, and on an icon-only control it is the only affordance.
//      A RATCHET rather than a gate: 262 sites cannot convert in one change,
//      and a guard that is red from the day it lands teaches people to ignore
//      red. Counts may shrink, never grow.
//
//   2. An ICON-ONLY control with neither `aria-label` nor `aria-labelledby` is
//      a hard failure, not a ratchet. That is not a polish question: a button
//      whose only content is a glyph and which carries no accessible name is
//      announced as "button" and nothing else. `PRODUCT.md` commits to WCAG 2.2
//      AA, and this is 4.1.2 at its most basic.
//
// `title` on a NON-interactive element is untouched. Truncated text whose full
// value belongs in a native hover is the one thing the attribute is still good
// for, and rule 1 is scoped to interactivity precisely so that use survives.
//
// VERIFYING THIS GUARD MEANS BREAKING IT — `tests/scripts/tooltipConvention.test.ts`
// injects each shape.
//
// Run by hand:   node scripts/check-tooltip-convention.mjs
//                node scripts/check-tooltip-convention.mjs --record
// Wired into:    lefthook `pre-commit`, CI `pnpm-build`.

import { readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { presentSharedRoots } from "./lib/shared-roots.mjs";

/**
 * The tree to scan. Defaults to the repository; `MYNE_GUARD_ROOT` overrides it.
 *
 * TEST-ONLY, and it earns its keep. A guard spec has to put a defective file
 * somewhere the guard will read it, and the obvious place — the real `src/` —
 * means the spec MUTATES the shared tree while every other spec that scans it
 * runs in a parallel worker. That is not theoretical: it produced intermittent
 * failures in `webScreens.test.ts` and `compileTimeDefines.test.ts`, neither of
 * which has anything to do with this guard, roughly one run in six.
 *
 * With this, a spec builds a scratch tree and points the guard at it, so
 * fixtures are invisible to everything else. Production never sets it.
 */
const ROOT =
  process.env.MYNE_GUARD_ROOT !== undefined
    ? `${process.env.MYNE_GUARD_ROOT}/`
    : new URL("..", import.meta.url).pathname;
const RECORD = join(new URL("..", import.meta.url).pathname, "scripts/tooltip-adoption.json");

/** Elements a pointer or a keyboard can act on. */
const INTERACTIVE = ["button", "a", "input", "select", "textarea", "summary"];

/**
 * Files allowed to keep a native `title=` on an interactive element, with the
 * reason. Compared both ways, so an entry whose file is gone fails as stale.
 */
const EXEMPT = new Map([
  [
    "src/components/primitives/IconButton.tsx",
    "Mirrors its own `label` to `title` as a deliberate belt-and-braces while the " +
      "conversion is in flight; it always carries `aria-label`, so the accessible " +
      "name never depends on it. Converting the primitive is its own change, because " +
      "wrapping every IconButton in a Tooltip changes the layout of every call site.",
  ],
]);

const SCAN_EXT = new Set([".tsx"]);

/** Strip comments, preserving line count, so prose never trips a rule. */
function scrub(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Read a file that may vanish between the walk and the read.
 *
 * The walk collects paths and the reads happen afterwards, so anything that
 * writes or deletes in the tree meanwhile — a build, a formatter, another
 * process — can make `readFileSync` throw ENOENT and take the whole guard down
 * with a stack trace instead of a verdict. A guard that crashes is worse than
 * one that fails: the failure at least says what is wrong.
 *
 * Found by this guard's own spec, which writes fixtures into the real tree
 * while a sibling spec does the same in a parallel worker.
 */
function readOrSkip(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
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

/**
 * Every JSX opening tag in `src`, as `{ tag, attrs, index }`.
 *
 * Brace-aware: a `title={cond ? "a" : "b"}` contains `>` inside an expression,
 * and stopping at the first `>` would truncate the attribute list and miss
 * whatever followed. That is not hypothetical — it is most of how this codebase
 * writes a conditional label.
 */
function openingTags(src) {
  const out = [];
  const re = /<([a-zA-Z][\w.]*)(\s)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length;
    let depth = 0;
    let quote = null;
    while (i < src.length) {
      const c = src[i];
      if (quote !== null) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === "`") {
        quote = c;
      } else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
      i++;
    }
    out.push({ tag: m[1], attrs: src.slice(m.index, i), index: m.index });
  }
  return out;
}

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

const counts = {};
const hardFailures = [];
const usedExempt = new Set();

const { present, missing } = presentSharedRoots(ROOT);
if (missing.length > 0) {
  console.error(
    `tooltip-convention: shared root(s) on the roster but absent: ${missing.join(", ")}`,
  );
  process.exit(1);
}

for (const root of present) {
  for (const file of await walk(join(ROOT, root), [])) {
    const rel = relative(ROOT, file);
    const raw = readOrSkip(file);
    if (raw === null) continue;
    const src = scrub(raw);
    let n = 0;
    for (const { tag, attrs, index } of openingTags(src)) {
      const interactive =
        INTERACTIVE.includes(tag) || /\brole\s*=\s*"(button|link|menuitem|tab)"/.test(attrs);
      if (!interactive) continue;

      if (/\btitle\s*=/.test(attrs)) {
        if (EXEMPT.has(rel)) usedExempt.add(rel);
        else n++;
      }

      // Rule 2. An icon-only control is one whose children are a glyph: there
      // is no text node for a screen reader to read, so the accessible name has
      // to be stated. Detected as an `<Icon` immediately inside the element
      // with no adjacent text, which is how this tree writes one.
      if (tag === "button" || /\brole\s*=\s*"button"/.test(attrs)) {
        const close = src.indexOf(`</${tag}>`, index);
        const body = close === -1 ? "" : src.slice(index + attrs.length + 1, close);
        const iconOnly =
          /<Icon\b/.test(body) && body.replace(/<[^>]*>/g, "").trim() === "";
        const named =
          /\baria-label\s*=/.test(attrs) || /\baria-labelledby\s*=/.test(attrs);
        if (iconOnly && !named) {
          hardFailures.push({
            rel,
            line: lineOf(src, index),
            detail:
              "an icon-only control with no `aria-label` or `aria-labelledby`. It is " +
              "announced as \"button\" and nothing else. This is WCAG 2.2 AA 4.1.2, " +
              "which PRODUCT.md commits to, so it is a failure rather than a ratchet.",
          });
        }
      }
    }
    if (n > 0) counts[rel] = n;
  }
}

for (const [rel, reason] of EXEMPT) {
  if (!usedExempt.has(rel)) {
    hardFailures.push({
      rel: "scripts/check-tooltip-convention.mjs",
      line: 0,
      detail:
        `EXEMPT excuses \`${rel}\`, which no longer puts \`title=\` on an interactive ` +
        `element (or no longer exists). Remove the entry. (Reason on file: ${reason})`,
    });
  }
}

const recorded = JSON.parse(readFileSync(RECORD, "utf8"));

if (process.argv.includes("--record")) {
  writeFileSync(RECORD, `${JSON.stringify(counts, null, 2)}\n`);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.error(
    `tooltip-convention: recorded ${Object.keys(counts).length} file(s), ${total} native title(s)`,
  );
  process.exit(hardFailures.length > 0 ? 1 : 0);
}

const grew = [];
for (const [rel, n] of Object.entries(counts)) {
  const was = recorded[rel] ?? 0;
  if (n > was) grew.push(`${rel}: ${was} -> ${n}`);
}
const stale = Object.keys(recorded).filter((rel) => counts[rel] === undefined);

if (hardFailures.length > 0 || grew.length > 0) {
  console.error("tooltip-convention: the convention is not being kept.\n");
  for (const f of hardFailures) {
    console.error(`  ${f.rel}:${f.line}  [no-accessible-name]`);
    console.error(`      ${f.detail}\n`);
  }
  if (grew.length > 0) {
    console.error("  native `title=` on interactive elements grew:\n");
    for (const g of grew) console.error(`    ${g}`);
    console.error(
      "\n  Use `<Tooltip label=… kbd=…>` instead, and keep the trigger's own\n" +
        "  `aria-label`: the tooltip is a VISUAL affordance, never the accessible\n" +
        "  name. The native attribute waits ~1s, ignores the theme, clips at the\n" +
        "  window edge and never shows on keyboard focus.\n",
    );
  }
  process.exit(1);
}

const total = Object.values(counts).reduce((a, b) => a + b, 0);
const before = Object.values(recorded).reduce((a, b) => a + b, 0);
console.error(
  `tooltip-convention: ok (${total} native title(s) across ${Object.keys(counts).length} file(s)` +
    `${total < before ? `; ${before - total} fewer than recorded — re-record to lock it in` : ""}` +
    `${stale.length > 0 ? `; ${stale.length} file(s) fully converted` : ""})`,
);
