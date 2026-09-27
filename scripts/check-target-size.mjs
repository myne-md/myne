#!/usr/bin/env node
// Guard: the WCAG 2.2 AA pointer-target floor (SC 2.5.8), statically
// (myne-md/myne#775, epic #772 lane 2e).
//
// The criterion is 24x24 CSS pixels for anything a pointer must hit.
// myne-md/myne#728 did the remediation — `--target-min` in the canon,
// `MIN_TARGET` as the one spreadable style, nine controls raised — and this is
// what stops it regrowing.
//
// WHY A SECOND MEASUREMENT EXISTS. `target-size` is a real axe rule and the E2E
// lane already runs it. But axe needs LAYOUT, so it is disabled in the jsdom
// tier (`LAYOUT_ONLY_RULES` — jsdom reports every box as zero by zero) and in
// the E2E tier it can only see a surface a scenario actually visits. The axe
// gate reaches eleven surfaces of thirty-odd. A control declared 18 pixels tall
// on a screen no scenario opens is invisible to both, forever, and this file
// reads the declaration rather than the rendered box.
//
// The audit that came with it found ONE candidate in the whole tree and it was
// compliant: a 20px checkbox wrapped in a `<label>`, whose effective target is
// the label row. So this lands as a hard gate rather than a ratchet — there is
// no debt to grandfather, and a gate is what keeps it that way.
//
// WHAT IT DOES NOT FLAG, because each is the criterion's own text rather than a
// convenience:
//
//   - a control inside a `<label>`, whose effective target is the label;
//   - anything spreading `MIN_TARGET`, which IS the floor;
//   - an INLINE target (a link in a sentence), exempt under SC 2.5.8 because
//     enlarging it would break the line it sits in;
//   - a control whose function is duplicated by a larger one on the same
//     screen, also exempt — recorded per site with its reason, since that is a
//     judgement about a specific screen and not something a scanner can see.
//
// VERIFYING THIS GUARD MEANS BREAKING IT — `tests/scripts/targetSize.test.ts`.
//
// Run by hand:   node scripts/check-target-size.mjs
// Wired into:    lefthook `pre-commit`, CI `pnpm-build`.

import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { presentSharedRoots } from "./lib/shared-roots.mjs";

const ROOT =
  process.env.MYNE_GUARD_ROOT !== undefined
    ? `${process.env.MYNE_GUARD_ROOT}/`
    : new URL("..", import.meta.url).pathname;

/** SC 2.5.8's floor, in CSS pixels. Mirrors `--target-min` in the canon. */
const FLOOR_PX = 24;

const INTERACTIVE = ["button", "a", "input", "select", "textarea"];

/**
 * Sites below the floor that the criterion itself exempts, with the reason.
 * Compared both ways — an entry whose site is gone fails as stale.
 */
const EXEMPT = new Map();

function scrub(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

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
    else if (e.name.endsWith(".tsx") && !/\.(test|spec)\.tsx$/.test(e.name)) out.push(full);
  }
  return out;
}

/** Brace-aware attribute slice for each interactive opening tag. */
function interactiveTags(src) {
  const out = [];
  const re = new RegExp(`<(${INTERACTIVE.join("|")})(\\s)`, "g");
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

/**
 * Whether the tag at `index` sits inside a `<label>`.
 *
 * Counts `<label` openings against `</label>` closings before the element: a
 * positive balance means one is still open around it, so the effective pointer
 * target is the label row rather than the control's own box. That is the
 * criterion's text, not a loophole — the target is what activates the control.
 */
function insideLabel(src, index) {
  const before = src.slice(0, index);
  const opens = (before.match(/<label\b/g) ?? []).length;
  const closes = (before.match(/<\/label>/g) ?? []).length;
  return opens > closes;
}

const findings = [];
const usedExempt = new Set();

const { present, missing } = presentSharedRoots(ROOT);
if (missing.length > 0) {
  console.error(`target-size: shared root(s) absent: ${missing.join(", ")}`);
  process.exit(1);
}

for (const root of present) {
  for (const file of await walk(join(ROOT, root), [])) {
    const rel = relative(ROOT, file);
    const raw = readOrSkip(file);
    if (raw === null) continue;
    const src = scrub(raw);
    for (const { tag, attrs, index } of interactiveTags(src)) {
      if (attrs.includes("MIN_TARGET")) continue;
      // An inline link is exempt by the criterion; detected as an `<a>` with an
      // `href` and no explicit box, which is how a sentence link is written.
      if (tag === "a" && !/\b(width|height)\s*:/.test(attrs)) continue;
      for (const prop of ["width", "height"]) {
        const m = new RegExp(`\\b${prop}:\\s*(\\d+)\\b`).exec(attrs);
        if (m === null) continue;
        const px = Number(m[1]);
        if (px >= FLOOR_PX) continue;
        if (insideLabel(src, index)) continue;
        const key = `${rel}:${tag}.${prop}`;
        if (EXEMPT.has(key)) {
          usedExempt.add(key);
          continue;
        }
        findings.push({
          rel,
          line: src.slice(0, index).split("\n").length,
          detail:
            `<${tag}> declares ${prop}: ${px}, under the ${FLOOR_PX}px pointer-target floor ` +
            `(WCAG 2.2 AA SC 2.5.8, which PRODUCT.md commits to). Spread ` +
            `\`MIN_TARGET\` from \`primitives/targetSize\` — it is a MINIMUM, so a ` +
            `control that is already larger keeps its size and a small one grows ` +
            `without its neighbours being re-laid out. If the control is genuinely ` +
            `exempt (it sits in a <label>, it is an inline link, or a larger control ` +
            `on the same screen does the same job), record it in EXEMPT with which.`,
        });
      }
    }
  }
}

for (const [key, reason] of EXEMPT) {
  if (!usedExempt.has(key)) {
    findings.push({
      rel: "scripts/check-target-size.mjs",
      line: 0,
      detail: `EXEMPT excuses \`${key}\`, which no longer exists. Remove it. (${reason})`,
    });
  }
}

if (findings.length > 0) {
  console.error("target-size: controls below the WCAG 2.2 AA pointer floor.\n");
  for (const f of findings) {
    console.error(`  ${f.rel}:${f.line}`);
    console.error(`      ${f.detail}\n`);
  }
  process.exit(1);
}

console.error(
  `target-size: ok (${present.length} shared tree(s); floor ${FLOOR_PX}px, ` +
    `${EXEMPT.size} reasoned exemption(s))`,
);
