#!/usr/bin/env node
// Stale-translation audit — the i18n defect class no other check can see.
//
// # The failure
//
// A translation goes STALE when its English source is REWRITTEN after the
// translation was written. Nothing in the repo notices: the key exists, the
// value is non-empty, the plural forms are complete, the {{placeholders}}
// match. Only the MEANING is old — and it is old in a way that reads perfectly
// well, so review does not catch it either.
//
// It is not cosmetic. The instance that motivated this script:
// `settings.storage.importHelper` grew from "import your Obsidian vault" to
// "import from Obsidian, Notion, Evernote, HTML files or a CSV", and all 23
// translations kept the old sentence — so for a year every non-English user was
// told Myne imports from exactly one app, while four more had shipped.
//
// # Why the repo has to own this
//
// Weblate DOES detect it (it hashes the source string and marks the translation
// "needs editing"). That is the correct home for the check — but the signal only
// exists for catalogs Weblate actually owns the history of, and this repo's
// catalogs have been filled in-repo (`decisions.md` 2026-08-03). Until the
// Weblate flow is live with translators in it, this script is the detector.
//
// # Method, and why not the cheap version
//
// Per KEY, compare the commit at which English last changed against the commit
// at which that locale's value last changed. If English is newer, the
// translation predates the text it is supposed to translate.
//
// The cheap version — "was the locale file touched after the English file?" —
// is worthless: a commit that adds forty keys to a catalog touches the file
// without re-syncing any of the other 2,900, which is exactly how the instance
// above hid. The check has to be per key, so it walks each catalog's own
// history and diffs value-by-value.
//
// # Reading the output
//
// A hit means "the English moved; this translation has not been re-checked" —
// NOT "this translation is wrong". A short label often survives its source
// being reworded (`Blue` → `Mavi` is still correct if the English key was
// merely recased). Confirm before rewriting; the value here is that the list is
// SHORT and complete, so confirming it is an afternoon rather than a project.
//
// Hand-run, like `check-web-no-ip-logging.sh` and `check-macos-dmg.mjs`: it
// walks the full history of 32 files and takes minutes, which is not a
// pre-commit budget. Run it when English copy has been churning, and before a
// release that claims translation completeness.
//
//   node scripts/check-i18n-stale.mjs            # human-readable report
//   node scripts/check-i18n-stale.mjs --json     # machine-readable
//   node scripts/check-i18n-stale.mjs --locale de --locale tr
//
// Exit code is 0 even with hits: this is an advisory audit, not a gate. A gate
// would have to block every English copy edit, which is the wrong trade.

import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runTool } from "./lib/run-tool.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const EN = "locales/en/common.json";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const only = argv.reduce((acc, a, i) => (a === "--locale" ? [...acc, argv[i + 1]] : acc), []);

// FATAL shell-out (myne#528): a `git` that cannot run must fail this script
// loudly, not walk a zero-revision history and report "nothing stale". The
// bare catch below is NOT this — it covers the JSON/`git show` of ONE revision
// and tolerates only the absent-or-unparsable file, with the reason stated.
const git = (...a) =>
  runTool(["git", ...a], { cwd: REPO, onToolFailure: "fatal", maxBuffer: 1 << 28 }).stdout;

function flat(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flat(v, key, out);
    else out[key] = v;
  }
  return out;
}

// One global commit ordering, so indices taken from different files compare.
const order = new Map();
git("log", "--format=%H", "--reverse")
  .trim()
  .split("\n")
  .forEach((sha, i) => order.set(sha, i));

/** { key → global commit index at which this file's value for it last changed }. */
function lastChangedAt(path) {
  const out = new Map();
  let prev = {};
  const revs = git("log", "--format=%H", "--reverse", "--", path).trim().split("\n").filter(Boolean);
  for (const sha of revs) {
    let cur;
    try {
      cur = flat(JSON.parse(git("show", `${sha}:${path}`)));
    } catch {
      continue; // absent or unparsable at this revision — not this script's problem
    }
    const idx = order.get(sha) ?? -1;
    for (const [k, v] of Object.entries(cur)) if (prev[k] !== v) out.set(k, idx);
    prev = cur;
  }
  return out;
}

const enAt = lastChangedAt(EN);
const enNow = flat(JSON.parse(git("show", `HEAD:${EN}`)));

const locales = readdirSync(join(REPO, "locales"))
  .filter((l) => l !== "en")
  .filter((l) => only.length === 0 || only.includes(l))
  .sort();

const stale = new Map(); // key → locales[]
for (const loc of locales) {
  const path = `locales/${loc}/common.json`;
  let now;
  try {
    now = flat(JSON.parse(git("show", `HEAD:${path}`)));
  } catch {
    continue;
  }
  for (const [k, when] of lastChangedAt(path)) {
    const enWhen = enAt.get(k);
    if (enWhen === undefined || !(k in enNow)) continue; // key no longer in English
    if (typeof now[k] !== "string" || now[k].trim() === "") continue; // empty falls back to English, which is fine
    if (enWhen > when) {
      if (!stale.has(k)) stale.set(k, []);
      stale.get(k).push(loc);
    }
  }
}

const rows = [...stale.entries()].sort((a, b) => b[1].length - a[1].length);
const pairs = rows.reduce((a, [, l]) => a + l.length, 0);

if (asJson) {
  console.log(JSON.stringify({ keys: rows.length, pairs, stale: Object.fromEntries(rows) }, null, 2));
  process.exit(0);
}

if (rows.length === 0) {
  console.log(`✓ i18n staleness: no translation predates its English source (${locales.length} locale(s) checked).`);
  process.exit(0);
}

console.log(
  `i18n staleness: ${rows.length} key(s) whose English changed after the translation was written ` +
    `— ${pairs} (key, locale) pair(s) to re-check.\n`,
);
for (const [key, locs] of rows) {
  console.log(`  ${key}  [${locs.length}] ${locs.join(",")}`);
  console.log(`     EN now: ${String(enNow[key]).replace(/\s+/g, " ").slice(0, 120)}`);
}
console.log(
  `\n  A hit is "re-check this", not "this is wrong" — a short label can survive its\n` +
    `  source being reworded. Confirm each, then retranslate from the CURRENT English.`,
);
