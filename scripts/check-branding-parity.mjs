#!/usr/bin/env node
// Cross-repo token bindings: the app's token sheet is the source, and three
// companion projections of it must not drift from it (audit 2026-10-18 B5+B6+B7).
//
// The failure this prevents, one arm per projection:
//
//   B5 `myne-branding/color/palette.json` + `typography/type-scale.json`.
//      A handoff repo that re-declares the palette and the type scale as a
//      derived export. Its own `EXPORTING.md` says drift is caught "at export
//      time by the provenance header … not by a cross-repo CI gate", and no
//      guard scanned it, so a value retuned in the app would leave the handoff
//      copy quietly advertising the old brand. Measured 2026-10-19: every
//      value AGREES with `client-core/src/tokens.css`; the gap is that nothing
//      would say so if one stopped. Only the OVERLAP is compared — the tonal
//      ramps, the brand names and the semantic sets are a differently-shaped
//      artefact and are NOT locked to the app's token names.
//
//   B6 `myne-clipper/src/lib/tokens.css` is a "CONTRACT COPY" of the published
//      token source, hand-updated and never wired across repos. Its header
//      claimed the values were re-declared from the canon "exactly", and its
//      `--danger` was #b54034 (light) / #d98b80 (dark) — matching neither the
//      app's #8a2a23 / #d99086 nor any recorded reason. `STATE_INK.locked` in
//      `src/lib/icon-svg.ts` carried the same invented #b54034, its own comment
//      saying it mirrors `./tokens.css` "where one exists". Both aligned in
//      `design-notes/ui/0706` and both pinned here.
//
//   B7 `myne-website/src/lib/themeBuilder/tokens.mjs` is the theme builder's
//      authorable roster. It modelled 5 of the app's 13 `--highlight*` tokens,
//      so `serialize.mjs` DROPPED eight of them on export and its dark
//      `--highlight` default was a stale #4a3f1e against the app's #4f4422.
//      A token the app declares that the builder cannot serialize is now a
//      named failure.
//
// # The companion is absent in a fresh clone and in CI, so absence REPORTS
//
// Same posture as `check-clipper-identifiers.mjs` and
// `check-selfhost-bundle-drift.mjs`: a guard that silently skipped its
// cross-repo half would print `ok` while checking less than its name claims.
// Each absent companion prints what could NOT be checked, and
// `--require-companion` turns that into a failure.
//
// Zero dependencies, hand-runnable:
//   node scripts/check-branding-parity.mjs
//   node scripts/check-branding-parity.mjs --require-companion
//   MYNE_BRANDING_DIR=… MYNE_CLIPPER_DIR=… MYNE_WEBSITE_DIR=… node scripts/check-branding-parity.mjs

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { grammarFor, stripComments } from "./check-twin-inventory.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_SHEET_REL = "client-core/src/tokens.css";

/**
 * Where a `workspace/setup.sh` clone puts a companion.
 *
 * Resolved from the repo root (the guard's own location), so the same path
 * works from the ordinary checkout and from a worktree under
 * `.opencode/worktrees/<name>`. Each `MYNE_*_DIR` override exists so the
 * companion-ABSENT branch — the branch CI and a fresh clone take — stays
 * exercisable on a machine that HAS the companion; `tests/scripts/brandingParity.test.ts`
 * uses them.
 */
function companion(envName, dirName, marker) {
  const fromEnv = process.env[envName];
  if (fromEnv) return resolve(fromEnv);
  const candidates = [resolve(repoRoot, dirName), resolve(repoRoot, "..", "..", "..", dirName)];
  return candidates.find((c) => existsSync(join(c, marker))) ?? candidates[0];
}

const BRANDING = companion("MYNE_BRANDING_DIR", "myne-branding", join("color", "palette.json"));
const CLIPPER = companion("MYNE_CLIPPER_DIR", "myne-clipper", join("src", "lib", "tokens.css"));
const WEBSITE = companion(
  "MYNE_WEBSITE_DIR",
  "myne-website",
  join("src", "lib", "themeBuilder", "tokens.mjs"),
);

// ── value normalisation ─────────────────────────────────────────────────────
//
// Two projection copies may be written with different cosmetic whitespace (the
// clipper's `rgba(11, 11, 9, 0.06)` against the sheet's `rgba(11,11,9,0.06)`,
// or `cubic-bezier(0.2, 0, 0, 1)` against `cubic-bezier(0.2, 0.0, 0.0, 1.0)`).
// Normalise the way a browser reads it rather than the way it was typed: hex
// case-folded, numbers canonicalised (`0.0` → `0`, `1.0` → `1`), whitespace
// around `(),%` dropped, remaining runs collapsed. Hex is masked out first so
// the number pass cannot eat a digit out of `#0b0b09`.
export function normalizeValue(value) {
  const hexes = [];
  const masked = String(value)
    .toLowerCase()
    .replace(/#[0-9a-f]{3,8}/g, (h) => {
      hexes.push(h);
      return `\u0000${hexes.length - 1}\u0000`;
    });
  const normalized = masked
    .replace(/-?(?:\d+\.?\d*|\.\d+)/g, (n) => String(Number(n)))
    .replace(/\s*([(),%])\s*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.replace(/\u0000(\d+)\u0000/g, (_, i) => hexes[Number(i)]);
}

/**
 * Every `{ … }` block in a stylesheet, at every nesting level, as
 * `{ selector, body, start, end }`.
 *
 * `selector` is the text between the previous `{`/`}` and this `{`, which is
 * what a nested block needs: the inner block of
 * `@media (prefers-color-scheme: dark) { .myne-overlay … { … } }` carries its
 * own selector cleanly, and the outer block carries the media query.
 */
export function blocks(source) {
  const out = [];
  const stack = [];
  let segStart = 0;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") {
      stack.push({ selector: source.slice(segStart, i).trim(), start: i + 1 });
      segStart = i + 1;
    } else if (ch === "}") {
      const top = stack.pop();
      if (top) out.push({ selector: top.selector, body: source.slice(top.start, i), start: top.start, end: i });
      segStart = i + 1;
    }
  }
  return out;
}

/** `--token: value` pairs in a declaration body, first declaration wins. */
function declarations(body) {
  const map = new Map();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) {
    if (!map.has(m[1])) map.set(m[1], m[2].trim());
  }
  return map;
}

/** Resolve `var(--x)` / `var(--x, fallback)` chains to a fixpoint. */
function resolveVars(map) {
  const out = new Map(map);
  for (let pass = 0; pass < 16; pass += 1) {
    let changed = false;
    for (const [key, value] of out) {
      if (!value.includes("var(")) continue;
      const next = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_, name, fallback) => {
        if (out.has(name)) return out.get(name);
        return fallback === undefined ? "" : fallback.trim();
      });
      if (next !== value) {
        out.set(key, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return out;
}

/**
 * The app sheet's RESOLVED token maps. `light` is the first `:root` block;
 * `dark` is that block with the `:root[data-theme="dark"]` assignments merged
 * over it, so an alias (`--bg-2: var(--paper-2)`) resolves to its dark value
 * without the dark block repeating it.
 */
export function parseAppSheet(source) {
  const clean = stripComments(source, grammarFor(APP_SHEET_REL));
  const all = blocks(clean);
  const rootBlock = all.find((b) => b.selector === ":root");
  const darkBlock = all.find((b) => b.selector === ':root[data-theme="dark"]');
  if (!rootBlock) return null;
  // Resolve light and dark from the RAW declarations, never from the resolved
  // light map: `--bg-2: var(--paper-2)` must still be a `var()` when the dark
  // override merges, or the alias is already frozen to its light value.
  const rawLight = declarations(rootBlock.body);
  const rawDark = new Map([...rawLight, ...(darkBlock ? declarations(darkBlock.body) : [])]);
  return { light: resolveVars(rawLight), dark: resolveVars(rawDark) };
}

function readIfPresent(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// ── B5, the branding export ─────────────────────────────────────────────────
//
// The overlay only: brand canonical colours, the two semantic sets, and the
// type scale's values. The ramps, the brand NAMES and the prose roles are a
// differently-shaped artefact and are deliberately NOT compared — see the
// header. Each row is a claim that the two names are the same value.
const BRANDING_PALETTE_MAP = [
  ["brand.iron-blue.canonical", "--accent"],
  ["brand.warm-paper.canonical", "--paper"],
  ["brand.warm-black-ink.canonical", "--ink-1"],
  ["brand.brick-red.canonical", "--danger"],
  ["brand.ochre.canonical", "--warning"],
  ["brand.forest-green.canonical", "--success"],
];
const BRANDING_LIGHT_MAP = [
  ["bg", "--paper"],
  ["bg-recessed", "--paper-2"],
  ["bg-hover", "--paper-3"],
  ["line", "--line-1"],
  ["line-strong", "--line-2"],
  ["ink-primary", "--ink-1"],
  ["ink-secondary", "--ink-2"],
  ["ink-tertiary", "--ink-3"],
  ["accent", "--accent"],
  ["accent-hover", "--accent-hover"],
  ["accent-press", "--accent-press"],
  ["accent-soft", "--accent-soft"],
  ["accent-on", "--accent-on"],
  ["danger", "--danger"],
  ["warning", "--warning"],
  ["success", "--success"],
];
const BRANDING_DARK_MAP = [
  ["bg", "--_paper-dark"],
  ["bg-recessed", "--_paper-2-dark"],
  ["bg-hover", "--_paper-3-dark"],
  ["line", "--_line-1-dark"],
  ["line-strong", "--_line-2-dark"],
  ["ink-primary", "--_ink-1-dark"],
  ["ink-secondary", "--_ink-2-dark"],
  ["ink-tertiary", "--_ink-3-dark"],
  ["accent", "--_accent-dark"],
  ["accent-hover", "--_accent-hover-dark"],
  ["accent-press", "--_accent-press-dark"],
  ["accent-soft", "--_accent-soft-dark"],
  ["accent-on", "--_accent-on-dark"],
  ["danger", "--_danger-dark"],
  ["warning", "--_warning-dark"],
  ["success", "--_success-dark"],
];
const BRANDING_TYPE_MAP = [
  ["scale.xs", "--text-xs"],
  ["scale.sm", "--text-sm"],
  ["scale.base", "--text-base"],
  ["scale.md", "--text-md"],
  ["scale.lg", "--text-lg"],
  ["scale.xl", "--text-xl"],
  ["scale.2xl", "--text-2xl"],
  ["scale.3xl", "--text-3xl"],
  ["scale.4xl", "--text-4xl"],
  ["lineHeights.tight", "--leading-tight"],
  ["lineHeights.snug", "--leading-snug"],
  ["lineHeights.normal", "--leading-normal"],
  ["lineHeights.relaxed", "--leading-relaxed"],
  ["lineHeights.mono", "--leading-mono"],
  ["weights.regular", "--weight-regular"],
  ["weights.medium", "--weight-medium"],
  ["weights.semibold", "--weight-semibold"],
  ["weights.bold", "--weight-bold"],
  ["letterSpacing.tight", "--tracking-tight"],
  ["letterSpacing.normal", "--tracking-normal"],
  ["letterSpacing.wide", "--tracking-wide"],
  ["letterSpacing.caps", "--tracking-caps"],
  ["families.sans.stack", "--font-sans"],
  ["families.mono.stack", "--font-mono"],
];

function pathGet(obj, path) {
  return path.split(".").reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

// ── B6, the clipper contract copy ───────────────────────────────────────────
const CLIPPER_LIGHT_MAP = [
  ["--font-sans", "--font-sans"],
  ["--text-sm", "--text-sm"],
  ["--bg-2", "--bg-2"],
  ["--line-1", "--line-1"],
  ["--accent", "--accent"],
  ["--success", "--success"],
  ["--danger", "--danger"],
  ["--shadow-2", "--shadow-2"],
  ["--radius-2", "--radius-2"],
  ["--ease-standard", "--ease-standard"],
  ["--duration-base", "--duration-base"],
];
const CLIPPER_DARK_MAP = [
  ["--bg-2", "--bg-2"],
  ["--line-1", "--line-1"],
  ["--accent", "--accent"],
  ["--success", "--success"],
  ["--danger", "--danger"],
  ["--shadow-2", "--shadow-2"],
];

// ── B7, the theme-builder roster ────────────────────────────────────────────
//
// The optional families the builder models. `--highlight` is matched as a base
// PLUS its siblings; the other two are prefixes.
const BUILDER_FAMILIES = [
  { name: "syntax", match: (t) => t.startsWith("--syntax-") },
  { name: "label", match: (t) => t.startsWith("--label-") },
  { name: "highlight", match: (t) => /^--highlight(-|$)/.test(t) },
];

/** `export const NAME = [ … ];` → the `--token` string members. */
function tokenArray(source, name) {
  const m = source.match(new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
  if (!m) return null;
  return [...m[1].matchAll(/"(--[\w-]+)"/g)].map((x) => x[1]);
}

/** `export const NAME = { … };` → the `"--token": "value"` pairs. */
function tokenObject(source, name) {
  const m = source.match(new RegExp(`export const ${name}\\s*=\\s*\\{([\\s\\S]*?)\\n\\};`));
  if (!m) return null;
  return new Map([...m[1].matchAll(/"(--[\w-]+)"\s*:\s*"([^"]*)"/g)].map((x) => [x[1], x[2]]));
}

/** `{ token: "--x", … }` entries in a manifest GROUPS array. */
function manifestTokens(source) {
  return [...source.matchAll(/token:\s*"(--[\w-]+)"/g)].map((x) => x[1]);
}

// ── the run ─────────────────────────────────────────────────────────────────
export function main() {
const failures = [];
const notes = [];
const fail = (message) => failures.push(message);
const requireCompanion = process.argv.includes("--require-companion");
const checked = [];

function absent(label, dir, envName, what) {
  const message =
    `the ${label} companion is not checked out at ${dir}, so ${what} was NOT ` +
    `checked. Clone it with ./workspace/setup.sh, set ${envName}, or pass ` +
    `--require-companion to make this a failure.`;
  if (requireCompanion) fail(message);
  else notes.push(message);
}

const appSource = readIfPresent(join(repoRoot, APP_SHEET_REL));
if (appSource === null) {
  console.error(
    `branding-parity: the app token sheet is missing: ${APP_SHEET_REL}\n` +
      "  It is the source everything here is compared against. Restore it.\n",
  );
  process.exit(1);
}
const app = parseAppSheet(appSource);
if (app === null) {
  console.error(
    `branding-parity: could not find the \`:root\` block in ${APP_SHEET_REL}.\n` +
      "  A renamed/removed block is this guard reporting ok on an input it could\n" +
      "  not read. Fix the parse rather than the tree.\n",
  );
  process.exit(1);
}

/** Compare one projection value against the app's, naming the pair on mismatch. */
function compareValue(where, token, appValue, projValue) {
  if (appValue === undefined) {
    fail(`${where}: compares against ${token}, which ${APP_SHEET_REL} does not declare.`);
    return;
  }
  if (projValue === undefined) {
    fail(`${where}: ${token} is missing — a mapped anchor that cannot be read is this guard reporting ok on less than it claims.`);
    return;
  }
  if (normalizeValue(appValue) !== normalizeValue(projValue)) {
    fail(
      `${where}: ${token} is "${projValue}" but the app sheet resolves it to ` +
        `"${appValue}". A companion projection that re-declares an app token must ` +
        `carry the app's value, or the two disagree silently.`,
    );
  }
}

// ── B5 ──────────────────────────────────────────────────────────────────────
const brandingPalette = readIfPresent(join(BRANDING, "color", "palette.json"));
const brandingType = readIfPresent(join(BRANDING, "typography", "type-scale.json"));
// Presence is keyed on EITHER file, not on both: a companion whose export was
// half-deleted is PRESENT-and-broken and must fail by name. Keying on "both, or
// absent" would report a deleted `type-scale.json` as "not checked out" and go
// green on a file it never read — the silent-skip failure this guard's header
// records about `check-embed-layout-drift.mjs`.
if (brandingPalette === null && brandingType === null) {
  absent("myne-branding", BRANDING, "MYNE_BRANDING_DIR", "the palette + type-scale export's parity with the app sheet");
} else {
  checked.push("branding");
  let palette;
  let type;
  if (brandingPalette === null) {
    fail("myne-branding/color/palette.json is missing from a companion that IS checked out, so its parity with the app sheet was NOT checked.");
  }
  if (brandingType === null) {
    fail("myne-branding/typography/type-scale.json is missing from a companion that IS checked out, so its parity with the app sheet was NOT checked.");
  }
  try {
    palette = brandingPalette === null ? undefined : JSON.parse(brandingPalette);
    type = brandingType === null ? undefined : JSON.parse(brandingType);
  } catch (e) {
    fail(`myne-branding: palette.json or type-scale.json is not valid JSON (${String(e)}).`);
  }
  if (palette !== undefined && type !== undefined) {
    for (const [path, token] of BRANDING_PALETTE_MAP) {
      compareValue("myne-branding/color/palette.json", token, app.light.get(token), pathGet(palette, path));
    }
    for (const [key, token] of BRANDING_LIGHT_MAP) {
      compareValue("myne-branding/color/palette.json semanticLight", token, app.light.get(token), palette.semanticLight?.[key]);
    }
    for (const [key, token] of BRANDING_DARK_MAP) {
      // The dark map names `--_*-dark` SOURCE tokens, which are declared in the
      // light `:root` block; compare against the resolved light map for them so
      // an alias is not compared to itself.
      const appValue = app.light.get(token) ?? app.dark.get(token);
      compareValue("myne-branding/color/palette.json semanticDark", token, appValue, palette.semanticDark?.[key]);
    }
    for (const [path, token] of BRANDING_TYPE_MAP) {
      const raw = pathGet(type, path);
      compareValue("myne-branding/typography/type-scale.json", token, app.light.get(token), raw === undefined ? undefined : String(raw));
    }
  }
}

// ── B6 ──────────────────────────────────────────────────────────────────────
const clipperSource = readIfPresent(join(CLIPPER, "src", "lib", "tokens.css"));
const clipperInkSource = readIfPresent(join(CLIPPER, "src", "lib", "icon-svg.ts"));
if (clipperSource === null && clipperInkSource === null) {
  absent("myne-clipper", CLIPPER, "MYNE_CLIPPER_DIR", "the overlay's contract copy of the app tokens");
} else {
  checked.push("clipper");
  if (clipperSource === null) {
    fail("myne-clipper/src/lib/tokens.css is missing from a companion that IS checked out, so the overlay's contract copy was NOT checked.");
  }
  if (clipperSource !== null) {
    const clean = stripComments(clipperSource, grammarFor("tokens.css"));
    const lightBlock = blocks(clean).find((b) => b.selector === ".myne-overlay");
    if (!lightBlock) {
      fail(
        `myne-clipper/src/lib/tokens.css: could not find the \`.myne-overlay\` block. A ` +
          "renamed selector is this guard reporting ok on a file it could not read.",
      );
    } else {
      const lightDecls = declarations(lightBlock.body);
      // Every remaining declaration in the file is a dark one: the file's layout
      // is the light `.myne-overlay` block, then the explicit dark block and the
      // `prefers-color-scheme: dark` block, and the reduced-motion block declares
      // no `--token` at all.
      const darkDecls = new Map();
      for (const m of clean.slice(lightBlock.end).matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) {
        if (!darkDecls.has(m[1])) darkDecls.set(m[1], []);
        darkDecls.get(m[1]).push(m[2].trim());
      }
      for (const [token, appToken] of CLIPPER_LIGHT_MAP) {
        compareValue("myne-clipper light", token, app.light.get(appToken), lightDecls.get(token));
      }
      for (const [token, appToken] of CLIPPER_DARK_MAP) {
        const values = darkDecls.get(token) ?? [];
        if (values.length === 0) {
          fail(`myne-clipper dark: ${token} is missing — a mapped anchor that cannot be read is this guard reporting ok on less than it claims.`);
          continue;
        }
        for (const value of values) {
          compareValue(`myne-clipper dark (${token}=${value})`, appToken, app.dark.get(appToken), value);
        }
      }
      // The overlay's `color:` literals are the ink token written out by hand
      // (`--ink-1` light, `--_ink-1-dark` dark), not via `var()`.
      const lightInk = /(?:^|[;{])\s*color\s*:\s*([^;}]+)/.exec(lightBlock.body);
      compareValue("myne-clipper light `color:`", "--ink-1", app.light.get("--ink-1"), lightInk ? lightInk[1].trim() : undefined);
      const darkInks = [...clean.slice(lightBlock.end).matchAll(/(?:^|[;{])\s*color\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
      if (darkInks.length === 0) {
        fail("myne-clipper dark: the overlay's `color:` literal is missing — a mapped anchor that cannot be read is this guard reporting ok on less than it claims.");
      }
      for (const value of darkInks) {
        compareValue(`myne-clipper dark \`color:\` (${value})`, "--ink-1", app.dark.get("--ink-1"), value);
      }
    }
  }

  // `STATE_INK` in `src/lib/icon-svg.ts` is a SECOND hand-written copy of two
  // token values (the toolbar icon ink cannot `var()`), and its own comment says
  // it mirrors `./tokens.css` "where one exists". `saved` is the light
  // `--success`; `locked` was the same invented `#b54034` the token declared, so
  // it is the same drift one file over. Checked OUTSIDE the `.myne-overlay`
  // branch so a renamed token block cannot also hide this copy.
  if (clipperInkSource === null) {
    fail("myne-clipper/src/lib/icon-svg.ts is missing from a companion that IS checked out, so `STATE_INK` — the toolbar icon's copy of the success/danger values — was NOT read.");
  } else {
    for (const [state, appToken] of [["saved", "--success"], ["locked", "--danger"]]) {
      const m = new RegExp(`${state}\\s*:\\s*"([^"]+)"`).exec(clipperInkSource);
      compareValue(
        `myne-clipper STATE_INK.${state}`,
        appToken,
        app.light.get(appToken),
        m ? m[1] : undefined,
      );
    }
  }
}

// ── B7 ──────────────────────────────────────────────────────────────────────
const builderTokensSource = readIfPresent(join(WEBSITE, "src", "lib", "themeBuilder", "tokens.mjs"));
const builderManifestSource = readIfPresent(join(WEBSITE, "src", "lib", "themeBuilder", "manifest.mjs"));
if (builderTokensSource === null && builderManifestSource === null) {
  absent("myne-website", WEBSITE, "MYNE_WEBSITE_DIR", "the theme builder's authorable roster against the app sheet");
} else {
  checked.push("website");
  if (builderTokensSource === null) {
    fail("myne-website/src/lib/themeBuilder/tokens.mjs is missing from a companion that IS checked out, so the authorable roster was NOT checked.");
  }
  if (builderManifestSource === null) {
    fail("myne-website/src/lib/themeBuilder/manifest.mjs is missing from a companion that IS checked out, so the manifest roster was NOT checked.");
  }
  const required = builderTokensSource === null ? null : tokenArray(builderTokensSource, "REQUIRED_TOKENS");
  const syntax = builderTokensSource === null ? null : tokenArray(builderTokensSource, "SYNTAX_TOKENS");
  const label = builderTokensSource === null ? null : tokenArray(builderTokensSource, "LABEL_TOKENS");
  const highlight = builderTokensSource === null ? null : tokenArray(builderTokensSource, "HIGHLIGHT_TOKENS");
  const lightDefaults = builderTokensSource === null ? null : tokenObject(builderTokensSource, "LIGHT_DEFAULTS");
  const darkDefaults = builderTokensSource === null ? null : tokenObject(builderTokensSource, "DARK_DEFAULTS");
  const manifest = builderManifestSource === null ? [] : manifestTokens(builderManifestSource);
  const named = { REQUIRED_TOKENS: required, SYNTAX_TOKENS: syntax, LABEL_TOKENS: label, HIGHLIGHT_TOKENS: highlight };
  for (const [name, list] of Object.entries(named)) {
    if (list === null) {
      fail(`myne-website/…/tokens.mjs: could not read \`${name}\` — a renamed export is this guard reporting ok on a file it could not parse.`);
    }
  }
  if (lightDefaults === null || darkDefaults === null) {
    fail("myne-website/…/tokens.mjs: could not read LIGHT_DEFAULTS / DARK_DEFAULTS — a renamed export is this guard reporting ok on a file it could not parse.");
  }
  const builderTokens = [...(required ?? []), ...(syntax ?? []), ...(label ?? []), ...(highlight ?? [])];
  const builderSet = new Set(builderTokens);
  const appLightTokens = new Set(app.light.keys());

  // 1. The builder models these families, so it must model ALL of each: a token
  //    the app declares and the builder cannot serialize is the B7 drop.
  for (const family of BUILDER_FAMILIES) {
    const appFamily = [...appLightTokens].filter(family.match).sort();
    const builderFamily = builderTokens.filter(family.match).sort();
    for (const token of appFamily) {
      if (!builderSet.has(token)) {
        fail(
          `the app declares ${token} but the theme builder cannot serialize it: ` +
            `it is absent from the \`${family.name}\` roster in ` +
            `myne-website/src/lib/themeBuilder/tokens.mjs, so \`serialize.mjs\` ` +
            `drops it on export.`,
        );
      }
    }
    for (const token of builderFamily) {
      if (!appLightTokens.has(token)) {
        fail(`the theme builder's \`${family.name}\` roster carries ${token}, which ${APP_SHEET_REL} does not declare.`);
      }
    }
  }

  // 2. The manifest roster and the model roster are two lists of the same set;
  //    the website's own tests compare them, but the website has no CI, so the
  //    guard holds it too.
  if (manifest.length > 0) {
    const manifestSet = new Set(manifest);
    for (const token of builderSet) {
      if (!manifestSet.has(token)) fail(`the theme builder models ${token} but manifest.mjs does not expose it, so no control can author it.`);
    }
    for (const token of manifestSet) {
      if (!builderSet.has(token)) fail(`manifest.mjs exposes ${token} but the token model does not carry it, so the export would drop it.`);
    }
  } else {
    fail("myne-website/…/manifest.mjs: could not read any `token:` entry — a renamed shape is this guard reporting ok on a file it could not parse.");
  }

  // 3. The builder's light/dark SEED values are the app's, or a builder export
  //    starts the user from a value the app never ships.
  if (lightDefaults !== null) {
    for (const [token, value] of lightDefaults) {
      compareValue("myne-website LIGHT_DEFAULTS", token, app.light.get(token), value);
    }
  }
  if (darkDefaults !== null) {
    for (const [token, value] of darkDefaults) {
      compareValue("myne-website DARK_DEFAULTS", token, app.dark.get(token), value);
    }
  }
}

// ── verdict ─────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error("branding-parity: FAILED");
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
for (const note of notes) console.warn(`branding-parity: NOT CHECKED — ${note}`);
if (checked.length === 0) {
  console.log("branding-parity: ok: NOTHING COMPARED (no companion checkout present)");
} else {
  console.log(
    `branding-parity: ok (checked against ${APP_SHEET_REL}: ${checked.join(", ")}); ` +
      `${notes.length} companion(s) NOT checked`,
  );
}
}

// Direct-execution check that survives macOS's `/var` → `/private/var` symlink:
// `process.argv[1]` is the path as typed, `import.meta.url` is already the
// realpath, so compare resolved realpaths rather than strings.
const invokedDirectly = (() => {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) main();
