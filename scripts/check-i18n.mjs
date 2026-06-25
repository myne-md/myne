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
// Load-bearing copy is intentionally NOT in the catalog (it renders from
// constants), so it is out of scope here.
//
// Exits non-zero with actionable guidance on any failure.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const EN = join(REPO, "locales/en/common.json");
const SRC = join(REPO, "src");
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
for (const f of walkFiles(SRC)) {
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

if (problems.length) fail(problems.join("\n\n"));

console.log(
  `✓ i18n: ${used.size} keys used, none missing; no empty English values.`,
);
