#!/usr/bin/env node
// Guard: the ornament vocabulary the app DRAWS must equal the one the host ACCEPTS.
//
// Three lists describe this vocabulary and none can be derived from the others at
// build time — `theme-validator/src/ornament.rs` decides what a theme may legally
// say, `ornaments/src/roles.ts` decides what the client reflects, and
// `ornaments/src/ornaments.css` decides what is actually drawn. Two of the three
// live in different languages, so codegen is off the table under the
// minimal-dependency rule; what is not off the table is checking that they agree.
//
// The failure this prevents is silent in both directions. A value only Rust knows
// validates and syncs and then draws nothing. A value only the stylesheet knows
// is a rule no theme can ever trigger. Neither shows up in a compiler, a lint, or
// any test that reads one list and asserts against a copy of itself.
//
// A companion guard exists in `myne-website` for the builder's own list; it is
// manual (that repo's CI has no node step) and covers a different pair. This one
// covers the pair that renders, and it runs.
//
// Run by hand: node scripts/check-ornament-vocabulary.mjs
// Wired into:  lefthook `pre-commit`, CI `pnpm-build`.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const rust = readFileSync(join(ROOT, "theme-validator/src/ornament.rs"), "utf8");
const roles = readFileSync(join(ROOT, "ornaments/src/roles.ts"), "utf8");
const css = readFileSync(join(ROOT, "ornaments/src/ornaments.css"), "utf8");

/** `Primitive { name: "frame", values: &["none", …] }` -> Map(name -> Set(values)) */
function rustPrimitives() {
  const out = new Map();
  const block = rust.slice(rust.indexOf("pub const PRIMITIVES"), rust.indexOf("pub const TINT_KEYS"));
  for (const m of block.matchAll(/name:\s*"([a-z-]+)",\s*values:\s*&\[([^\]]*)\]/g)) {
    out.set(m[1], new Set([...m[2].matchAll(/"([a-z]+)"/g)].map((v) => v[1])));
  }
  return out;
}

/** `frame: ["none", …],` inside ORNAMENT_PRIMITIVES -> Map(name -> Set(values)) */
function tsPrimitives() {
  const out = new Map();
  const start = roles.indexOf("export const ORNAMENT_PRIMITIVES");
  const block = roles.slice(start, roles.indexOf("};", start));
  for (const m of block.matchAll(/^\s*"?([a-z-]+)"?:\s*\[([^\]]*)\]/gm)) {
    out.set(m[1], new Set([...m[2].matchAll(/"([a-z]+)"/g)].map((v) => v[1])));
  }
  return out;
}

/**
 * `"<role>-<primitive>" -> Set(value)` from the stylesheet's own selectors.
 *
 * **Keyed by the CELL, not by the primitive.** An earlier version captured the
 * primitive and threw the role away, which made every question it answered
 * role-agnostic: a value drawn for any ONE role satisfied the check for all
 * three. That is how six refused cells survived in the stylesheet after the
 * vocabulary narrowed to eighteen, and how `frame=none` counted as reset for
 * three roles on the strength of a single rule. The gallery renderer derives
 * what it reflects from these selectors, so a dead cell here is a gallery card
 * drawing ornament the app refuses on install.
 */
function cssCells() {
  const out = new Map();
  for (const m of css.matchAll(/\[data-o-([a-z]+)-([a-z-]+)="([a-z]+)"\]/g)) {
    const cell = `${m[1]}-${m[2]}`;
    if (!out.has(cell)) out.set(cell, new Set());
    out.get(cell).add(m[3]);
  }
  return out;
}

/** `TINT_KEYS` / `TINT_KEYS` — the non-enumerated pair, in each language. */
function tintKeys(source, marker) {
  const at = source.indexOf(marker);
  if (at === -1) return [];
  const block = source.slice(at, source.indexOf(";", at));
  return [...block.matchAll(/"(--[a-z-]+)"/g)].map((m) => m[1]);
}

const r = rustPrimitives();
const t = tsPrimitives();
const problems = [];

// The tint wash is not a role-scoped primitive, so the PRIMITIVES slice above
// cannot see it — and it was the one primitive that shipped unbounded partly
// because every guard was scoped to what it could see. Check it explicitly.
const rustTint = tintKeys(rust, "pub const TINT_KEYS");
const tsTint = tintKeys(roles, "export const TINT_KEYS");
if (rustTint.length === 0) problems.push("TINT_KEYS: not found in theme-validator");
for (const k of rustTint) {
  if (!tsTint.includes(k)) problems.push(`${k}: in theme-validator's TINT_KEYS, absent from roles.ts`);
  if (!css.includes(`var(${k}`)) problems.push(`${k}: in the vocabulary, read by no rule in ornaments.css`);
}
for (const k of tsTint) {
  if (!rustTint.includes(k)) problems.push(`${k}: in roles.ts's TINT_KEYS, unknown to theme-validator`);
}

/** `("surface", &["frame", …]),` inside ROLE_PRIMITIVES -> Map(role -> Set(prims)) */
function rustRolePrimitives() {
  const out = new Map();
  const start = rust.indexOf("pub const ROLE_PRIMITIVES");
  if (start < 0) return out;
  const block = rust.slice(start, rust.indexOf("pub fn role_accepts"));
  for (const m of block.matchAll(/\(\s*"([a-z]+)"\s*,\s*&\[([^\]]*)\]/g)) {
    out.set(m[1], new Set([...m[2].matchAll(/"([a-z]+)"/g)].map((x) => x[1])));
  }
  return out;
}

/** `surface: ["frame", …],` inside ROLE_PRIMITIVES -> Map(role -> Set(prims)) */
function tsRolePrimitives(source, marker) {
  const out = new Map();
  const start = source.indexOf(marker);
  if (start < 0) return out;
  const block = source.slice(start, source.indexOf("};", start));
  for (const m of block.matchAll(/([a-z]+):\s*\[([^\]]*)\]/g)) {
    out.set(m[1], new Set([...m[2].matchAll(/"([a-z]+)"/g)].map((x) => x[1])));
  }
  return out;
}

// The role × primitive matrix is SPARSE, and the three sides have to agree on
// WHICH cells exist as well as on which values each primitive takes. A role that
// accepts a primitive on one side and not another produces a builder control
// whose key the app stores and ignores — the same "validates, then does nothing"
// failure this guard exists for, one level up.
const rustRoles = rustRolePrimitives();
const tsRoles = tsRolePrimitives(roles, "export const ROLE_PRIMITIVES");
if (rustRoles.size === 0) problems.push("ROLE_PRIMITIVES: not found in theme-validator");
if (tsRoles.size === 0) problems.push("ROLE_PRIMITIVES: not found in ornaments/src/roles.ts");
for (const [role, prims] of rustRoles) {
  const ts = tsRoles.get(role);
  if (!ts) {
    problems.push(`role ${role}: in theme-validator's ROLE_PRIMITIVES, absent from roles.ts`);
    continue;
  }
  for (const p of prims) if (!ts.has(p)) problems.push(`${role} accepts ${p} in Rust, not in roles.ts`);
  for (const p of ts) if (!prims.has(p)) problems.push(`${role} accepts ${p} in roles.ts, not in Rust`);
}
for (const role of tsRoles.keys()) {
  if (!rustRoles.has(role)) problems.push(`role ${role}: in roles.ts, unknown to theme-validator`);
}

// …and the STYLESHEET, which is the side the gallery renderer reads.
//
// BOTH directions, and the second one is the half that was missing. CSS→Rust
// catches a cell the stylesheet draws and the vocabulary refuses — a gallery
// card showing ornament the app drops on install. Rust→CSS catches a cell the
// vocabulary accepts and nothing draws — a setting that validates, stores and
// syncs, then does nothing, which is the exact failure this guard's error text
// says it exists to prevent. Only the first was checked, so the guard's promise
// held in one direction and its success line claimed both.
const cssMatrix = cssCells();
for (const [cell, drawnValues] of cssMatrix) {
  const [role, ...rest] = cell.split("-");
  const primitive = rest.join("-");
  if (!rustRoles.has(role)) {
    problems.push(`role ${role}: drawn by ornaments.css, unknown role`);
    continue;
  }
  if (!rustRoles.get(role).has(primitive)) {
    problems.push(`${cell}: drawn by ornaments.css, refused by the vocabulary`);
    continue;
  }
  // …and the VALUES, which this walk used to capture and then ignore. A rule
  // for a value no theme may write is a rule nothing can ever trigger — the
  // guard's own error text names that failure, and it was checked in one
  // direction only while the success line claimed the values agreed across all
  // three sources.
  const known = r.get(primitive);
  for (const v of drawnValues) {
    if (!known?.has(v)) {
      problems.push(`${cell}="${v}": drawn by ornaments.css, not a value the vocabulary allows`);
    }
  }
}

if (r.size === 0 || t.size === 0) {
  console.error("ornament-vocabulary: parsed 0 primitives — the source shape changed, fix this guard");
  process.exit(1);
}

for (const [name, values] of r) {
  const ts = t.get(name);
  if (!ts) {
    problems.push(`${name}: in theme-validator, absent from ornaments/src/roles.ts`);
    continue;
  }
  for (const v of values) if (!ts.has(v)) problems.push(`${name}=${v}: known to Rust, not offered by roles.ts`);
  for (const v of ts) if (!values.has(v)) problems.push(`${name}=${v}: offered by roles.ts, rejected by Rust`);
}
for (const name of t.keys()) {
  if (!r.has(name)) problems.push(`${name}: in roles.ts, unknown to theme-validator`);
}

// The stylesheet must draw every non-no-op value OF EVERY ACCEPTED CELL, or the
// setting does nothing. Per cell, not per primitive: `--chrome-texture: grain`
// is its own setting and a rule that draws `surface-texture="grain"` says
// nothing about it.
//
// `none` / `plain` are excused for the primitives that draw on
// `::before`/`::after`: a pseudo-element is not an ancestor, nothing inherits,
// and an unselected slot already paints nothing.
//
// They are NOT excused for `frame` and `shadow`. Those two write their slots on
// the HOST element and custom properties inherit, so a box nested inside a
// framed surface inherits that frame — and only an explicit `="none"` rule can
// put the slot back to neutral. The blanket excuse is exactly how the documented
// opt-out shipped unimplemented: the stylesheet's own header promised it,
// `applyOrnamentAttributes` reflected it, and no rule selected it, so
// `--box-frame: none` could not stop a surface's frame reaching every settings
// row inside it. Each role owes its own reset — a single `surface-frame="none"`
// rule used to satisfy all three.
const INHERITS = new Set(["frame", "shadow"]);
for (const [role, prims] of rustRoles) {
  for (const primitive of prims) {
    const values = r.get(primitive);
    if (!values) continue; // already reported by the primitive comparison above
    const drawn = cssMatrix.get(`${role}-${primitive}`) ?? new Set();
    for (const v of values) {
      if ((v === "none" || v === "plain") && !INHERITS.has(primitive)) continue;
      if (drawn.has(v)) continue;
      problems.push(
        v === "none" || v === "plain"
          ? `${role}-${primitive}=${v}: ${primitive} inherits, so ${role}'s no-op needs its own reset rule in ornaments.css`
          : `${role}-${primitive}=${v}: in the vocabulary, drawn by no rule in ornaments.css`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error("ornament-vocabulary: the vocabulary and the stylesheet disagree:\n");
  for (const p of problems) console.error(`    ${p}`);
  console.error("\n  A value must exist in all three: theme-validator (may a theme say it),");
  console.error("  ornaments/src/roles.ts (does the client reflect it), and ornaments.css");
  console.error("  (does anything draw it). A value missing from the third validates, syncs,");
  console.error("  and then silently does nothing.");
  process.exit(1);
}

const values = [...r.values()].reduce((n, s) => n + s.size, 0);
const cells = [...rustRoles.values()].reduce((n, set) => n + set.size, 0);
// Every number in this line is now something the run above actually compared,
// in both directions and per cell. The previous version printed the same
// sentence while checking Rust\u2194TS only and discarding the role from the CSS
// side \u2014 a success line that was itself the overstatement class this feature
// kept shipping.
console.log(
  `ornament-vocabulary: ok (${r.size} primitives, ${values} values, ${cells} role\u00d7primitive cells agree across Rust, TS and CSS)`,
);
