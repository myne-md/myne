#!/usr/bin/env node
// Guard: hardcoded visual values may shrink, never grow (myne#394).
//
// The failure this prevents: a custom theme sets a value and half the interface
// ignores it. Myne's UI is inline `style={{}}` + design tokens, and a literal
// written there is unreachable to a theme forever — inline style outranks any
// stylesheet, so there is no override, no `!important`, no escape.
//
// Read the checked-in `scripts/token-adoption.json` for the current baseline
// rather than a number in this comment — four separate measurement corrections
// have moved it, and a stale figure here would send the next conversion pass at
// the wrong files. The corrections, because each is a trap worth not re-walking:
// `var(--token, #fallback)` fallbacks are NOT unthemable (the fallback never runs
// when the token is defined); a file that DEFINES tokens must be exempt, not
// converted (`--paper-2: var(--paper-2)` is a self-reference that resolves to
// nothing); an issue reference in a comment (`#184`) is a valid three-digit hex;
// and a surface that PRESENTS colour (the accent picker's swatches) is offering
// it to the user, not styling a theme should repaint.
//
// The deep-customization plan pays that debt down surface by surface — and this
// guard is what stops it regrowing at the same rate, which is exactly what would
// otherwise happen: no compiler, lint or test reports a new hardcoded padding.
//
// A RATCHET, not a hard gate. A file's recorded count may fall (and re-recording
// is expected as each surface is converted); it may not rise. A NEW file starts
// at zero, which means new code is held to the standard the tree is still moving
// toward rather than to the tree's current average.
//
// Out of SCOPE (not scanned at all): `docs/design/colors_and_type.css`, which
// defines tokens rather than consuming them. (`ornaments/src/ornaments.css` used
// to be listed here too, but `ornaments/src` is on the shared-roots roster and
// so IS scanned — it is excused in EXEMPT below, where the reason can be read.)
// Test files are skipped
// by the walker: a fixture colour is not a themable surface.
//
// EXEMPT (scanned, then excused) is a different thing and is the list below.
//
// `AppearancePanel.tsx` used to sit in it and no longer does. Its swatches DO
// present colour rather than consume it — binding them to tokens would make
// every swatch show the same colour — but a whole-file excuse meant a future
// hardcoded `padding: 7` in that panel was uncounted forever, in the very panel
// `tasks.md` names as the irony to close. It is now a recorded baseline instead:
// the swatch residue is visible as a number, and anything ADDED to the file is
// caught (myne#394).
//
// Run by hand:   node scripts/check-token-adoption.mjs
//                node scripts/check-token-adoption.mjs --record   (re-baseline)
// Wired into:    lefthook `pre-commit`, CI `pnpm-build`.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { presentSharedRoots } from "./lib/shared-roots.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const RECORD = join(ROOT, "scripts/token-adoption.json");

/**
 * Trees whose inline styles a theme is expected to reach — the shared roster,
 * not a private copy.
 *
 * Keeping a private list is what `scripts/lib/shared-roots.mjs` exists to stop,
 * and it had already bitten: `web/src` is painted by the very same
 * `applyCustomTheme` and carried uncounted literals.
 *
 * `mobile/src` used to be dropped here — it was a companion repo, absent from CI
 * and from a fresh clone, so counting it would have meant one number locally and
 * a different one on the runner. It is in-repo now and it is painted by the same
 * `applyCustomTheme`, so it is in scope like every other shared root, with its
 * current per-file counts recorded as the starting debt in `token-adoption.json`.
 */
const SCAN_ROOTS = presentSharedRoots().present;

/**
 * Files that DEFINE token values rather than consuming them.
 *
 * A literal in one of these is the point, not the debt, and "converting" it to a
 * `var()` produces a self-reference that silently resolves to nothing. The PDF
 * stylesheet is the sharpest case: it styles a STANDALONE document with no app
 * stylesheet attached, so it embeds its own `:root` block — `var(--paper-2)`
 * there has nothing to resolve against.
 */
const EXEMPT = [
  "src/styles/tokens.css", // the token sheet itself
  // Mobile's token sheet, the same file one client over. Its absence here was
  // drift rather than a decision: the two are the same kind of file, and the
  // consequence is that a token DEFINITION added to mobile trips a guard whose
  // whole subject is consuming tokens rather than defining them. That is the
  // `check-prefs-nonce` shape the root CLAUDE.md records, where a roster kept a
  // client out and the success line still read ok (myne-md/myne#629).
  "mobile/src/styles/tokens.css",
  "src/dialect/html/print-stylesheet.ts", // standalone PDF doc; embeds its own :root
  "src/lib/themeMeasure.ts", // the token roster
  "src/lib/syntaxTheme.ts", // the built-in dark ramp it aliases to
  "src/lib/accentColor.ts", // derives the accent family from one chosen colour
  // The ornament layer's own artwork. Its numbers are pattern GEOMETRY — the
  // pitch of a serration, the radius of a punched hole, the offset of a crease —
  // not spacing or type a theme should repaint; binding them to the measure
  // scale would resize the drawings when the text scale moved. Its only "colours"
  // are `0 0 #0000` (the shadow that paints nothing, this composition's neutral
  // element) and `var(--ink-1, #000)`-style fallbacks, which the header above
  // already records as not-unthemable. This file was named as out-of-scope in
  // that header from the start; it silently came INTO scope when `ornaments/src`
  // joined the shared-roots roster, which is what an EXEMPT entry is for.
  "ornaments/src/ornaments.css",
];

const SCAN_EXT = new Set([".ts", ".tsx", ".css"]);

/**
 * The literal shapes that make a surface unthemable.
 *
 * Hex colours, and the numeric forms of the properties a measure token governs.
 * `0` is excluded throughout: zero is zero in every theme, and counting it would
 * bury the signal under `padding: 0`.
 */
const PATTERNS = [
  // `(?<!\w)` keeps an issue reference out of the count: `myne#394` is not a
  // colour, and counting it made a comment citing this very issue trip the guard.
  { name: "colour", re: /(?<!\w)#[0-9a-fA-F]{3,8}\b/g },
  { name: "radius", re: /\bborderRadius:\s*[1-9]/g },
  {
    name: "spacing",
    re: /\b(padding|margin|gap|rowGap|columnGap|paddingTop|paddingRight|paddingBottom|paddingLeft|marginTop|marginRight|marginBottom|marginLeft):\s*[1-9]/g,
  },
  { name: "type", re: /\bfontSize:\s*[1-9]/g },
  { name: "weight", re: /\bfontWeight:\s*["']?[1-9]/g },
  // `--tracking-*` is in the measure vocabulary, so a literal letter-spacing is
  // as unthemable as a literal padding. It had no pattern here until this was
  // noticed — the guard was protecting four of five families.
  { name: "tracking", re: /\bletterSpacing:\s*[-.\d]/g },
];

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      await walk(full, out);
    } else if (SCAN_EXT.has(entry.name.slice(entry.name.lastIndexOf(".")))) {
      if (entry.name.includes(".test.") || entry.name.includes(".spec.")) continue;
      out.push(full);
    }
  }
  return out;
}

/**
 * A `var(--token, #fallback)` fallback is NOT an unthemable literal: when the
 * theme defines the token the fallback is never used, so the surface is already
 * reachable. Counting them was the first version's mistake and it badly
 * overstated the debt — `editor/src/theme.ts` looked like 239 hardcoded colours
 * when almost all of them are fallbacks behind a live token. Strip every
 * `var(...)` call before counting so the number means what it claims to.
 */
/**
 * Strip comments before counting.
 *
 * A colour literal lives in code, never in prose — while an issue reference in
 * a comment (`#184`, `#250`) is a perfectly good three-digit hex as far as a
 * regex is concerned. Counting those put ~200 phantom "literals" in the
 * baseline, spread across files with no styling in them at all. This is the
 * third measurement defect this guard has had; each one inflated the debt, and
 * none of them was real work.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function stripVarFallbacks(source) {
  // Innermost-first, repeatedly, so nested `var(--a, var(--b, #hex))` collapses.
  let out = source;
  for (;;) {
    const next = out.replace(/var\(\s*--[A-Za-z0-9_-]+\s*(?:,[^()]*)?\)/g, "TOKEN");
    if (next === out) return out;
    out = next;
  }
}

function countLiterals(source) {
  const scrubbed = stripVarFallbacks(stripComments(source));
  let total = 0;
  for (const { re } of PATTERNS) {
    total += (scrubbed.match(re) ?? []).length;
  }
  return total;
}

async function scan() {
  const counts = {};
  for (const root of SCAN_ROOTS) {
    const dir = join(ROOT, root);
    if (!existsSync(dir)) continue;
    for (const file of await walk(dir)) {
      const rel = relative(ROOT, file);
      if (EXEMPT.includes(rel)) continue;
      const n = countLiterals(readFileSync(file, "utf8"));
      if (n > 0) counts[rel] = n;
    }
  }
  return counts;
}

// `--scan <dir>` points the walk at one directory instead of the shared roots.
// Exists so the guard's own test can inject a literal into a throwaway file
// rather than into `src/lib/theme.ts` — a crashed run used to leave a production
// source file mutated, and a parallel test worker could read it mid-write.
const scanFlag = process.argv.indexOf("--scan");
async function scanOne(dir) {
  const out = {};
  for (const file of await walk(dir)) {
    // EXEMPT applies here too, and it did not until myne-md/myne#629's review.
    // The exemption is the one branch a whole-file excuse turns on, so leaving
    // it out of the `--scan` path meant the guard's own tests could not reach
    // it: the entry that retires 105 recorded literals from `mobile/src/styles/
    // tokens.css` was unreachable from every test in `tests/scripts/`, and
    // `--scan mobile/src/styles` reported that file at 108 as though it were
    // still on the ratchet. Keyed on the REPO-relative path, the same key
    // `EXEMPT` holds, so a scan pointed at a directory inside the repo excuses
    // exactly what the full scan excuses.
    if (EXEMPT.includes(relative(ROOT, file))) continue;
    const n = countLiterals(readFileSync(file, "utf8"));
    if (n > 0) out[relative(dir, file)] = n;
  }
  return out;
}

const counts = scanFlag === -1 ? await scan() : await scanOne(process.argv[scanFlag + 1]);
const total = Object.values(counts).reduce((a, b) => a + b, 0);

if (process.argv.includes("--record")) {
  writeFileSync(RECORD, `${JSON.stringify(counts, null, 2)}\n`);
  console.log(
    `token-adoption: recorded ${Object.keys(counts).length} file(s), ${total} literal(s)`,
  );
  process.exit(0);
}

if (!existsSync(RECORD)) {
  console.error(
    "token-adoption: no baseline. Run `node scripts/check-token-adoption.mjs --record` once.",
  );
  process.exit(1);
}

const baseline = JSON.parse(readFileSync(RECORD, "utf8"));

// A roster that outlives the tree it describes is a permanent hole: a renamed or
// deleted file leaves an EXEMPT entry excusing nothing and a baseline entry
// allowing any count. `check-web-surfaces.mjs` fails on the same shape; so does
// this.
const stale = [
  ...EXEMPT.filter((f) => !existsSync(join(ROOT, f))).map((f) => `EXEMPT: ${f}`),
  ...Object.keys(baseline)
    .filter((f) => !existsSync(join(ROOT, f)))
    .map((f) => `baseline: ${f}`),
];
if (stale.length > 0) {
  console.error("token-adoption: the roster names files that no longer exist:\n");
  for (const s of stale) console.error(`    ${s}`);
  console.error("\n  Remove the entry, or restore the file. Re-record with --record.");
  process.exit(1);
}

const grown = [];
for (const [file, n] of Object.entries(counts)) {
  const was = baseline[file] ?? 0;
  if (n > was) grown.push({ file, was, now: n });
}

if (grown.length > 0) {
  console.error("token-adoption: hardcoded visual values grew:\n");
  for (const g of grown) {
    console.error(`    ${g.file}: ${g.was} -> ${g.now}`);
  }
  console.error(
    "\n  Use a design token (`var(--space-4)`, `var(--radius-2)`, `var(--text-base)`,",
  );
  console.error("  `var(--ink-1)`) instead of a literal. A literal written into an inline");
  console.error("  style is unreachable to every custom theme, permanently — inline style");
  console.error("  outranks any stylesheet, so there is no override to fall back on.");
  console.error("\n  If the growth is deliberate, re-record with --record and say why in");
  console.error("  the commit message.");
  process.exit(1);
}

const baselineTotal = Object.values(baseline).reduce((a, b) => a + b, 0);
const delta = baselineTotal - total;
console.log(
  `token-adoption: ok (${total} literal(s) across ${Object.keys(counts).length} file(s)` +
    (delta > 0 ? `; ${delta} fewer than recorded — re-record to lock it in)` : ")"),
);
