#!/usr/bin/env node
// i18n catalog guard — run by the lefthook pre-commit hook (and runnable
// by hand: `node scripts/check-i18n.mjs`). Two checks, both learned from the
// big i18n migration:
//
//   1. NO EMPTY English source values. `locales/en/common.json` is the source
//      of truth; an empty value means a key was extracted but its English was
//      never filled, so the UI would render the raw key. (Other locales ARE
//      allowed to be empty — Weblate fills them, English falls back.)
//
//   2. EVERY static `t("…")` / `i18n.t("…")` key used in src/ exists in the
//      catalog (plural-aware: a `foo` call resolves if `foo` OR `foo_one` /
//      `foo_other` / … exists). Catches a `t()` added without running
//      `pnpm i18n:extract`.
//
//   3. NO LOAD-BEARING LITERAL appears as a value in ANY locale file
//      (phase3-web-client task 98). These strings render from constants, in
//      every locale, because their exact wording IS a privacy or security
//      property — a non-distinguishing failure message that gains a second
//      variant leaks which half of a credential pair was wrong; an egress
//      sentence that gets softened stops being a disclosure.
//
//      The failure this catches is not a bad translation, it is a *good* one:
//      an implementer told to "add i18n keys for the pending-approval wait"
//      does exactly that, the key ships, 24 locales fill it, and the byte
//      identity `@myne/copy` exists to guarantee is gone — silently, with the
//      English still matching, and nothing else in the repo noticing. So the
//      check is on the VALUES, and it runs over every locale rather than just
//      English, because the drift starts in the translated ones.
//
// Exits non-zero with actionable guidance on any failure.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const EN = join(REPO, "locales/en/common.json");

// Both clients that share these catalogs, matching `i18next.config.js`'s
// `extract.input`. Scanning `src/` alone was a real blind spot: three keys used
// only by `myne-mobile` were absent from English for months, so an
// English-language mobile user saw the raw dotted key while every translated
// locale still carried the string (`decisions.md` 2026-08-03). `myne-mobile` is
// a separately-cloned companion, so its absence is normal and skipped — this
// tightens the check where the tree is present, it does not require it.
const TREES = [join(REPO, "src"), join(REPO, "myne-mobile/src")].filter((d) =>
  existsSync(d),
);
const PLURAL_SUFFIXES = ["_zero", "_one", "_two", "_few", "_many", "_other"];

function fail(msg) {
  console.error(`\n✗ i18n check failed:\n${msg}\n`);
  process.exit(1);
}

let en;
try {
  en = JSON.parse(readFileSync(EN, "utf8"));
} catch (e) {
  fail(`could not read/parse ${EN}: ${e.message}`);
}

// --- Check 1: no empty English values --------------------------------------
const empties = [];
(function walk(obj, prefix) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object") walk(v, key);
    else if (v === "") empties.push(key);
  }
})(en, "");

// --- Check 2: every static t() key exists (plural-aware) -------------------
function get(dotted) {
  return dotted
    .split(".")
    .reduce((c, k) => (c && typeof c === "object" ? c[k] : undefined), en);
}
function keyExists(k) {
  if (get(k) !== undefined) return true;
  return PLURAL_SUFFIXES.some((s) => get(k + s) !== undefined);
}

function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

// Match `t("a.b")` / `i18n.t('a.b')` — require a dotted key (all Myne keys are
// namespaced) and reject method calls like `.t(` / identifiers ending in `t`.
const KEY_RE = /(?<![\w.])(?:i18n\.)?t\(\s*["'`]([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)["'`]/g;
const used = new Set();
for (const f of TREES.flatMap((t) => walkFiles(t))) {
  const txt = readFileSync(f, "utf8");
  let m;
  while ((m = KEY_RE.exec(txt)) !== null) used.add(m[1]);
}
const missing = [...used].filter((k) => !keyExists(k)).sort();

// --- Report ----------------------------------------------------------------
const problems = [];
if (empties.length) {
  problems.push(
    `  ${empties.length} EMPTY English value(s) in locales/en/common.json:\n` +
      empties.slice(0, 40).map((k) => `    ∅ ${k}`).join("\n") +
      (empties.length > 40 ? `\n    … and ${empties.length - 40} more` : "") +
      `\n  → fill the English source text for these keys.`,
  );
}
if (missing.length) {
  problems.push(
    `  ${missing.length} t() key(s) used in src/ but MISSING from the catalog:\n` +
      missing.slice(0, 40).map((k) => `    ✗ ${k}`).join("\n") +
      (missing.length > 40 ? `\n    … and ${missing.length - 40} more` : "") +
      `\n  → run \`pnpm i18n:extract\`, then fill the English values.`,
  );
}

// --- 3. load-bearing literals must not enter any catalog ---------------------
//
// Sourced from `copy/src/index.ts` and `src/lib/load-bearing-copy.ts` by reading
// their exported string literals, rather than from a hand-kept list here: a list
// would be one more thing to update, and the one time it was not updated is
// exactly when a new literal quietly became translatable.
function exportedLiterals(file) {
  const txt = readFileSync(file, "utf8");
  const out = [];
  // `export const NAME =` followed by one or more adjacent string literals
  // (prettier wraps long copy across lines as `"…" +\n  "…"`).
  const re = /export const ([A-Z0-9_]+)\s*=\s*((?:\s*"(?:[^"\\]|\\.)*"\s*\+?)+);/g;
  let m;
  while ((m = re.exec(txt)) !== null) {
    const joined = [...m[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)]
      .map((s) => s[1])
      .join("");
    // Short constants are keys or labels, not prose; requiring some length
    // keeps the check from flagging an ordinary word that coincides.
    if (joined.length >= 24) out.push({ name: m[1], value: joined });
  }
  return out;
}

const literals = [
  ...exportedLiterals(join(REPO, "copy/src/index.ts")),
  ...exportedLiterals(join(REPO, "src/lib/load-bearing-copy.ts")),
];

function everyValue(node, acc = []) {
  if (typeof node === "string") acc.push(node);
  else if (node && typeof node === "object") for (const v of Object.values(node)) everyValue(v, acc);
  return acc;
}

const localesDir = join(REPO, "locales");
const leaked = [];
for (const lang of readdirSync(localesDir)) {
  const catalog = join(localesDir, lang, "common.json");
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(catalog, "utf8"));
  } catch {
    continue; // not a catalog dir, or a locale mid-edit — the other checks own that
  }
  const values = new Set(everyValue(parsed).map((v) => v.replace(/\s+/g, " ").trim()));
  for (const lit of literals) {
    if (values.has(lit.value.replace(/\s+/g, " ").trim())) {
      leaked.push(`${lang}: ${lit.name}`);
    }
  }
}
if (leaked.length) {
  problems.push(
    `  ${leaked.length} LOAD-BEARING literal(s) present as a catalog value:\n` +
      leaked.slice(0, 40).map((k) => `    ✗ ${k}`).join("\n") +
      `\n  → these render from their constant in EVERY locale. Their exact wording is` +
      `\n    the property (a non-distinguishing message that gains a second variant` +
      `\n    leaks; an egress sentence that gets softened stops disclosing). Delete the` +
      `\n    key and render the constant instead.`,
  );
}

if (problems.length) fail(problems.join("\n\n"));

console.log(
  `✓ i18n: ${used.size} keys used, none missing; no empty English values; ` +
    `${literals.length} load-bearing literal(s) absent from all catalogs.`,
);
