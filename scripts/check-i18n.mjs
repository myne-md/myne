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
import { presentSharedRoots } from "./lib/shared-roots.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const EN = join(REPO, "locales/en/common.json");

// Every shared tree, from the ONE roster (#273).
//
// This listed `src` and `myne-mobile/src` and nothing else — it predates the
// `editor/`, `dialect/` and `copy/` packages, and never learned about them.
// `editor/src` alone holds 226 live `i18n.t()` keys the catalog check had never
// seen, and `i18next.config.js` shared the blind spot, so a developer following
// the documented add-a-string procedure exactly could still ship a raw dotted
// key. Scanning `src/` alone was the earlier version of the same gap: three
// keys used only by the mobile client were absent from English for months
// (`decisions.md` 2026-08-03).
//
// The mobile tree used to be a separately-cloned companion, so its absence was
// normal and skipped — which meant that on the runner, where it was ALWAYS
// absent, this check never saw a mobile key at all. It is in-repo now and always
// scanned; `missing` is kept only because a broken checkout should still say so
// rather than quietly narrow the scan.
const { present: SHARED_PRESENT, missing: SHARED_MISSING } = presentSharedRoots(REPO);
const TREES = SHARED_PRESENT.map((rel) => join(REPO, rel));
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
// And the SAME keys when they sit inside an EXPRESSION rather than directly
// after `t(`, which is the half this scan used to miss.
//
// The failure it left open, measured: `AiChatTab.tsx` labelled its honesty
// chevron with `t(honestyOpen ? "…aiChat.honestyCollapse" : "…aiChat.honestyExpand")`.
// The catalog carries both names one level deeper (`…aiChat.agentTurn.…`), so the
// control rendered the RAW KEY PATH as its label and tooltip in every locale, and
// this guard — whose whole job is "a t() key used in src/ exists in the catalog" —
// reported ok, because `t(` is followed by an identifier rather than a quote. The
// key was also invisible to `pnpm i18n:extract` for the same reason, so nothing in
// the documented add-a-string procedure could have caught it either.
//
// The widening is scoped rather than loose: it takes the BALANCED argument list of
// each `t(` / `i18n.t(` call and looks for dotted-key literals inside it, so a key
// reached through a ternary, a `??`, a `&&` or an array index is covered while an
// arbitrary string elsewhere in the file is not.
const CALL_RE = /(?<![\w.])(?:i18n\.)?t\s*\(/g;
const LITERAL_KEY_RE = /["'`]([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+)["'`]/g;

/** The source text of the call's argument list, parens balanced and string
 *  literals skipped, or `null` when the call is unterminated. */
function callArguments(src, openParen) {
  let depth = 0;
  for (let i = openParen; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") i += 1;
        i += 1;
      }
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return src.slice(openParen + 1, i);
    }
  }
  return null;
}

const used = new Set();

/** Comments out, with the repository's own idiom (`tests/a11y/accessibleAuth`):
 *  a block comment first, then line comments, and the `(^|[^:])` guard so an
 *  `https://` inside a string literal is not mistaken for one.
 *
 *  This is load-bearing for the expression scan and was measured, not assumed:
 *  without it the paren balancer walks into an apostrophe inside a comment
 *  ("the catalog's path") and treats it as an unterminated string literal, after
 *  which the balance is nonsense and the keys it exists to find are skipped. The
 *  first version of this widening had exactly that bug and reported ok over the
 *  very key it was written for. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

for (const f of TREES.flatMap((t) => walkFiles(t))) {
  const txt = readFileSync(f, "utf8");
  let m;
  while ((m = KEY_RE.exec(txt)) !== null) used.add(m[1]);
  const code = stripComments(txt);
  CALL_RE.lastIndex = 0;
  while ((m = CALL_RE.exec(code)) !== null) {
    const args = callArguments(code, m.index + m[0].length - 1);
    if (args === null) continue;
    let k;
    LITERAL_KEY_RE.lastIndex = 0;
    while ((k = LITERAL_KEY_RE.exec(args)) !== null) used.add(k[1]);
  }
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
