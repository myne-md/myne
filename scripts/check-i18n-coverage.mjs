#!/usr/bin/env node
// i18n translation-coverage guard, and the generated record behind it.
//
// # The gap this fills
//
// `check-i18n.mjs` gates the ENGLISH source only, and that is deliberate: a
// non-English value is allowed to be absent or empty, because Weblate is
// supposed to fill it and English is the per-key runtime fallback in the
// meantime. The cost of that design is that translation coverage can fall for
// weeks with every gate in the tree green. It did: myne-md/myne#589 found the
// same 215 keys missing from all 31 catalogs, while `PRODUCT.md` said the
// locale set was "all of them complete" and `docs/dev/i18n.md` said "All 31
// non-English catalogs are at 100%". Nothing contradicted either sentence,
// because nothing measured it.
//
// So this script does NOT gate coverage. A gate on a number that drops the
// moment an English string is authored would block every copy edit, which is
// the wrong trade and is exactly why `check-i18n.mjs` declines it too. Instead
// it PUBLISHES coverage into a generated document and gates THAT, the way
// `check-twin-inventory.mjs` does. Adding an English
// key therefore costs one `--emit`, and shows the author every locale row going
// down, in the diff, in the commit that caused it.
//
// # The three things it does gate
//
//   1. ROSTER PARITY, ACROSS ALL THREE PLACES THE LANGUAGE LIST LIVES.
//      `SUPPORTED_LANGUAGES` (`src/i18n/config.ts`) is what the picker offers,
//      `locales/<code>/common.json` is what the bundler can load, and
//      `i18next.config.js` is what `pnpm i18n:extract` writes new keys into.
//      `docs/dev/i18n.md` documents adding a language as an edit to all three,
//      by hand, and each omission fails silently in its own way: a picker entry
//      with no catalog renders a fully English UI (the glob loads by PATH, so
//      nothing throws); a catalog nobody offers is a chunk no user can reach;
//      and a language missing from the extractor config stops receiving new
//      keys altogether, so its coverage decays with every English string added
//      and nothing says why. That last one is #589's own shape, one file over.
//      Compared in every direction, and it fails BY NAME when a list cannot be
//      found rather than reporting ok on an input it never read.
//
//   2. NO PARTIAL PLURAL GROUP. Within one plural base a locale either carries
//      every category it uses, or the group is a defect. A missing category
//      does not degrade: i18next resolves it, finds nothing, and falls straight
//      through to ENGLISH, mid-sentence, inside an otherwise translated
//      screen, and only for the counts that select that category (`ru`'s `few`
//      is 2-4, so the bug stays invisible until someone has three of
//      something). A base the locale has NONE of is untranslated rather than
//      broken, and is counted by check 4 instead. That distinction is what
//      makes this gate-able: it stays green when English grows a new plural
//      key, which is the event a coverage gate would have died on.
//
//   3. PLACEHOLDER PARITY. The `{{token}}` set of a translation must equal that
//      of the English it translates. A dropped token renders a sentence with a
//      hole where the note count was; an added one renders literal braces. A
//      plural category English itself lacks (`_zero`, `_two`, `_few`, `_many`)
//      is compared against English's `_other`, which is the string it stands in
//      for. Both 2 and 3 landed EMPTY on the tree that introduced them, so
//      every future hit is a regression rather than inherited debt.
//
// The fourth dimension of catalog health is a translation whose English source
// was REWRITTEN after it, so the key exists, the value is non-empty, the
// placeholders match, and only the meaning is old. It is NOT here and cannot be:
// detecting it means walking the full git history of 32 files, which is minutes
// rather than a hook budget. That is `scripts/check-i18n-stale.mjs`, hand-run
// and advisory, and the generated record names it so the two halves are
// findable from each other.
//
// `analyse(io)` takes its whole world as an argument, so `tests/scripts/
// i18nCoverage.test.ts` injects each defect above as a synthetic file set
// rather than mutating the real tree: no `git restore`, no half-restored
// working copy, and the break tests run on every commit instead of living in a
// shell transcript nobody re-runs.
//
//   node scripts/check-i18n-coverage.mjs           # report; exits 1 if 1-3 fail
//   node scripts/check-i18n-coverage.mjs --emit    # regenerate the record
//   node scripts/check-i18n-coverage.mjs --check   # also fail when it is stale

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CONFIG_PATH = "src/i18n/config.ts";
export const EXTRACTOR_PATH = "i18next.config.js";
export const LOCALES_DIR = "locales";
export const RECORD_PATH = "docs/dev/i18n-coverage.md";
export const NAMESPACE = "common.json";
const SOURCE_LOCALE = "en";

const SUFFIX = /_(zero|one|two|few|many|other)$/;
const CATEGORY_ORDER = ["zero", "one", "two", "few", "many", "other"];
const byCategory = (a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b);
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)[^}]*\}\}/g;

const placeholders = (value) => new Set([...String(value).matchAll(PLACEHOLDER)].map((m) => m[1]));

// Percentages round DOWN, never to nearest. This document exists because two
// files asserted 100% while 215 keys were untranslated, and `toFixed(2)` prints
// exactly that sentence again: delete one key from one catalog and the headline
// still reads 100.00% while the line under it says 30 of 31 complete. A figure
// here may understate what shipped. It may never overstate it.
const pct = (part, whole) => (Math.floor((part / whole) * 10000) / 100).toFixed(2);

// Recurses into ONE accumulator rather than merging a fresh object per level.
// The reduce-and-Object.assign shape this replaces copied every leaf once per
// level of nesting: 62 ms of the script's 250 ms, plus the GC on the
// intermediates, for the 32 catalogs. Same output, measured byte-for-byte.
function flatten(obj, prefix = "", acc = {}) {
  for (const k in obj) {
    const v = obj[k];
    const key = prefix + k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, `${key}.`, acc);
    else acc[key] = v;
  }
  return acc;
}

/** `{ base -> Set<category> }` for every plural group in one flattened catalog. */
function pluralGroups(catalog) {
  const groups = new Map();
  for (const key of Object.keys(catalog)) {
    const m = key.match(SUFFIX);
    if (!m) continue;
    const base = key.replace(SUFFIX, "");
    if (!groups.has(base)) groups.set(base, new Set());
    groups.get(base).add(m[1]);
  }
  return groups;
}

/**
 * The plural categories `Intl.PluralRules` can actually SELECT for a locale,
 * which is the set i18next resolves against at runtime. Returns null when the
 * runtime cannot answer for this locale, so the caller fails by name instead of
 * requiring nothing.
 */
function cldrCategories(code) {
  let resolved;
  try {
    resolved = new Intl.PluralRules(code).resolvedOptions();
  } catch {
    return null;
  }
  // A well-formed tag the runtime has no data for does not throw: it falls back
  // to the default locale and hands back ENGLISH's categories, so `xx` would
  // quietly be required to carry one/other. Compare primary subtags to catch it.
  if (String(resolved.locale).split("-")[0] !== String(code).split("-")[0]) return null;
  const cats = [...resolved.pluralCategories];
  if (!cats.includes("other")) return null;
  return cats.sort(byCategory);
}

/**
 * @param io.readFile     (repoRelativePath) => string | null
 * @param io.localeDirs   () => string[]     directory names under locales/
 */
export function analyse(io) {
  const failures = [];
  const fail = (message) => failures.push(message);
  // One return shape on every path, including the early ones. The padding on a
  // halted run is unreachable in practice (every `stop` carries a failure, and
  // the CLI exits on that first), but a union return would make every caller
  // narrow before reading `rows`, and the narrowing is what gets skipped, so a
  // caller reading `rows` off a halted result reports "0 locales, all fine" for
  // a run that never got past its roster.
  const stop = (message) => {
    if (message) fail(message);
    return { failures, halted: true, rows: [], overall: "0.00", complete: 0, record: "" };
  };

  // ── the three language rosters ──────────────────────────────────────────
  // Each read from its own file. Comparing any one against a derivative of
  // itself would prove nothing, which is the whole point of check 1.
  const declared = declaredLanguages(io.readFile(CONFIG_PATH));
  if (typeof declared === "string") return stop(declared);
  const extracted = extractorLanguages(io.readFile(EXTRACTOR_PATH));
  if (typeof extracted === "string") return stop(extracted);
  const onDisk = [...io.localeDirs()].sort();

  // ── 1. roster parity, in every direction ────────────────────────────────
  const declaredSet = new Set(declared);
  const extractedSet = new Set(extracted);
  // `exists` rather than `readFile`, because this pass only asks whether the
  // catalog is there: reading it here read all 32 files (16.9 MiB) purely to
  // compare the result against null, and the main loop then read them again.
  // A synthetic `io` in a spec need not supply it; the fallback keeps working.
  const exists = io.exists ?? ((rel) => io.readFile(rel) !== null);
  const noCatalog = declared.filter((c) => !exists(`${LOCALES_DIR}/${c}/${NAMESPACE}`));
  const notOffered = onDisk.filter((c) => !declaredSet.has(c));
  const notExtracted = declared.filter((c) => !extractedSet.has(c));
  const extractedOnly = extracted.filter((c) => !declaredSet.has(c));
  if (noCatalog.length) {
    fail(
      `${noCatalog.length} language(s) offered by the picker with no catalog on disk: ` +
        `${noCatalog.join(", ")}. src/i18n/index.ts glob-loads catalogs BY PATH, so a missing one ` +
        `throws nothing: the user picks the language and the whole UI stays English.`,
    );
  }
  if (notOffered.length) {
    fail(
      `${notOffered.length} catalog(s) on disk that SUPPORTED_LANGUAGES does not offer: ` +
        `${notOffered.join(", ")}. Each compiles to its own chunk that no user can reach. ` +
        `Add it to ${CONFIG_PATH}, or delete the directory.`,
    );
  }
  if (notExtracted.length) {
    fail(
      `${notExtracted.length} language(s) in SUPPORTED_LANGUAGES that ${EXTRACTOR_PATH} does not list: ` +
        `${notExtracted.join(", ")}. \`pnpm i18n:extract\` writes new keys only into the locales it ` +
        `lists, so this catalog silently stops receiving them and its coverage decays with every ` +
        `English string added, with nothing saying why.`,
    );
  }
  if (extractedOnly.length) {
    fail(
      `${extractedOnly.length} language(s) in ${EXTRACTOR_PATH} that SUPPORTED_LANGUAGES does not ` +
        `offer: ${extractedOnly.join(", ")}. The extractor maintains a catalog no user can select.`,
    );
  }
  if (!declaredSet.has(SOURCE_LOCALE)) {
    fail(`SUPPORTED_LANGUAGES does not carry the source language (${SOURCE_LOCALE}), so there is no fallback locale.`);
  }
  if (failures.length) return stop(null);

  const readCatalog = (code) => {
    const raw = io.readFile(`${LOCALES_DIR}/${code}/${NAMESPACE}`);
    if (raw === null) return null;
    try {
      return flatten(JSON.parse(raw));
    } catch (e) {
      // Deliberately NOT `check-i18n.mjs`'s policy, which continues past an
      // unparseable catalog: skipping one here would read as "passed", which is
      // the failure mode this whole script exists to remove.
      fail(
        `${LOCALES_DIR}/${code}/${NAMESPACE} could not be parsed: ${e.message}. An unreadable catalog ` +
          `is not skippable here.`,
      );
      return null;
    }
  };

  const en = readCatalog(SOURCE_LOCALE);
  if (en === null) return stop(null);
  const enKeys = Object.keys(en);
  const enBases = new Set([...pluralGroups(en).keys()]);
  // English's placeholder sets, computed once. Inside the loop this was 31
  // re-scans of the same 3,278 strings for 3,278 distinct answers.
  const enPlaceholders = new Map(
    Object.entries(en).filter(([, v]) => typeof v === "string").map(([k, v]) => [k, placeholders(v)]),
  );
  /** The English a locale key translates: itself, or `_other` standing in for a category English lacks. */
  const sourceFor = (key) => enPlaceholders.get(key) ?? enPlaceholders.get(`${key.replace(SUFFIX, "")}_other`);

  const targets = declared.filter((c) => c !== SOURCE_LOCALE).sort();
  const rows = [];
  const partial = [];
  const mismatched = [];

  for (const code of targets) {
    const cat = readCatalog(code);
    if (cat === null) continue;

    // What a group is measured AGAINST is CLDR, not the catalog's own habit.
    //
    // The first version of this check used the modal suffix set across the
    // locale's own groups, and `tests/scripts/i18nCoverage.test.ts` broke it on
    // the first injection: strip `_few` from every Russian group and the
    // majority becomes one/many/other, so each broken group is compared against
    // a baseline the breakage itself defined. That is exactly how a check like
    // this passes for years and goes quiet on the day it matters.
    //
    // CLDR is immune to that, and it is also the RIGHT authority: i18next
    // selects a category through `Intl.PluralRules`, so a category Intl can
    // never select cannot produce the English fallthrough this check exists to
    // catch. Every shipped catalog's set is a superset of its CLDR set today,
    // so the floor lands clean.
    //
    // Deliberately NOT caught: a category BEYOND CLDR that some groups carry
    // and others do not. The six locales `id ja ko th vi zh` carry English's
    // `one` where CLDR gives them only `other` (docs/decisions/storage/0411).
    // That is dead weight rather than a defect, because `Intl.PluralRules("ja")`
    // never returns `one`, so no user reaches the missing slot.
    const required = cldrCategories(code);
    if (required === null) {
      fail(
        `Intl.PluralRules("${code}") did not yield a usable category set. Every language has \`other\`; ` +
          `a set without it means the runtime's ICU data does not know this locale, and the plural ` +
          `check would silently require nothing.`,
      );
      continue;
    }

    const groups = pluralGroups(cat);
    for (const [base, have] of groups) {
      if (!enBases.has(base)) continue; // a key English no longer has: not ours to complete
      const gaps = required.filter((c) => !have.has(c));
      if (gaps.length) partial.push(`${code}: ${base} → ${gaps.map((g) => `_${g}`).join(", ")}`);
    }

    for (const [key, value] of Object.entries(cat)) {
      const want = sourceFor(key);
      if (!want || typeof value !== "string") continue; // orphan key English no longer has
      const got = placeholders(value);
      if (want.size !== got.size || [...want].some((t) => !got.has(t))) {
        mismatched.push(`${code}: ${key} → en{${[...want].join(",")}} vs {${[...got].join(",")}}`);
      }
    }

    const translated = enKeys.filter((k) => typeof cat[k] === "string" && cat[k] !== "").length;
    rows.push({
      code,
      translated,
      missing: enKeys.length - translated,
      coverage: pct(translated, enKeys.length),
      // Two columns, because they are two different facts and conflating them
      // is what the first draft of the record did. `categories` is what this
      // catalog actually uses, as the UNION rather than the majority, so one
      // group carrying a stray extra category shows up instead of being
      // averaged away (a majority is also decided by JSON key order under a
      // tie, and this repo's own tooling reorders plural groups). `required` is
      // what the GATE holds it to.
      categories: [...new Set([...groups.values()].flatMap((s) => [...s]))].sort(byCategory).join("/") || "-",
      required: required.join("/"),
    });
  }

  if (partial.length) {
    fail(
      `${partial.length} partial plural group(s), a category missing from a group that is not empty: ` +
        `${partial.slice(0, 20).join("; ")}${partial.length > 20 ? `; and ${partial.length - 20} more` : ""}. ` +
        `A missing category does not degrade, it falls straight through to ENGLISH: mid-sentence, inside an ` +
        `otherwise translated screen, only for the counts that select it. Fill the category or delete the whole group.`,
    );
  }
  if (mismatched.length) {
    fail(
      `${mismatched.length} key(s) whose interpolation placeholders do not match English: ` +
        `${mismatched.slice(0, 20).join("; ")}${mismatched.length > 20 ? `; and ${mismatched.length - 20} more` : ""}. ` +
        `A dropped {{token}} renders a sentence with a hole in it; an added one renders the braces literally.`,
    );
  }

  const totalTranslated = rows.reduce((a, r) => a + r.translated, 0);
  const totalPossible = rows.length * enKeys.length;
  const summary = {
    rows,
    enKeyCount: enKeys.length,
    totalPossible,
    overall: totalPossible ? pct(totalTranslated, totalPossible) : "0.00",
    complete: rows.filter((r) => r.missing === 0).length,
  };

  return {
    failures,
    halted: false,
    rows,
    overall: summary.overall,
    complete: summary.complete,
    record: renderRecord(summary),
  };
}

/**
 * A BCP-47 language tag as this repository writes them: a primary subtag plus
 * any number of region or script subtags. `[a-z-]+` was the first draft and it
 * was blind by construction to `pt-BR`, `zh-Hant` and `sr-Latn`, which are the
 * three shapes a 32-locale roster is most likely to grow next. A code the
 * pattern could not see was silently dropped from BOTH rosters at once, so the
 * parity check compared two equally-truncated lists, agreed with itself, and
 * reported ok on a language nothing in this script had ever looked at.
 */
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/**
 * Every quoted string in a roster block, with anything that is not a language
 * tag reported BY NAME rather than skipped. Widening the pattern alone would
 * have traded one silent blindness for another: a quoted string the widened
 * pattern still cannot classify would go on being dropped without a word. This
 * is the `scanned-assets.mjs` discipline, which fails on an extension nobody
 * classified instead of walking past it.
 */
function rosterCodes(block, where) {
  const quoted = [...block.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  const bad = quoted.filter((q) => !LANGUAGE_TAG.test(q));
  if (bad.length > 0) {
    return (
      `${where} contains ${bad.length} quoted value(s) that are not language tags: ` +
      `${bad.map((b) => JSON.stringify(b)).join(", ")}. ` +
      `This check reads that block as a roster, so it will not silently ignore an entry it cannot classify.`
    );
  }
  return quoted;
}

/** `SUPPORTED_LANGUAGES` codes, or a failure message naming what could not be read. */
function declaredLanguages(source) {
  if (source === null) {
    return `${CONFIG_PATH} is missing. SUPPORTED_LANGUAGES is this script's input; if the module moved, fix the path here.`;
  }
  const block = source.match(/export const SUPPORTED_LANGUAGES\s*=\s*\[([\s\S]*?)\]\s*as const/);
  if (!block) {
    return (
      `SUPPORTED_LANGUAGES not found in ${CONFIG_PATH}. If it was renamed, rename it here too. ` +
      `reporting ok on an input this script never read is the one outcome that makes it worthless.`
    );
  }
  const entries = [...block[1].matchAll(/code:\s*("[^"]*")/g)].map((m) => m[1]).join(" ");
  const codes = rosterCodes(entries, `SUPPORTED_LANGUAGES in ${CONFIG_PATH}`);
  if (typeof codes === "string") return codes;
  if (codes.length < 2) {
    return `SUPPORTED_LANGUAGES parsed to ${codes.length} language(s). That is a parse failure, not a roster.`;
  }
  return codes;
}

/** `i18next.config.js`'s `locales:` array, or a failure message. */
function extractorLanguages(source) {
  if (source === null) {
    return `${EXTRACTOR_PATH} is missing. It decides which catalogs \`pnpm i18n:extract\` writes new keys into.`;
  }
  const block = source.match(/\blocales:\s*\[([\s\S]*?)\]/);
  if (!block) {
    return `No \`locales:\` array found in ${EXTRACTOR_PATH}. If the extractor config changed shape, teach this check the new one.`;
  }
  const codes = rosterCodes(block[1], `The \`locales:\` array in ${EXTRACTOR_PATH}`);
  if (typeof codes === "string") return codes;
  if (codes.length < 2) {
    return `${EXTRACTOR_PATH} parsed to ${codes.length} locale(s). That is a parse failure, not a roster.`;
  }
  return codes;
}

function renderRecord({ rows, enKeyCount, overall, complete, totalPossible }) {
  // Derived, not hand-listed: the record's whole point is that no roster in it
  // is maintained by a person. The first draft named the six locales in a
  // string literal, inside the one document that exists because a hand-kept
  // figure went on being read after it stopped being true.
  const beyondCldr = rows.filter((r) => r.categories !== r.required).map((r) => `\`${r.code}\``);
  return [
    "<!-- GENERATED by scripts/check-i18n-coverage.mjs --emit. Do not hand-edit. -->",
    "",
    "# Translation coverage",
    "",
    "How much of the English source each shipped catalog actually answers, measured",
    "rather than asserted. `PRODUCT.md` and `docs/dev/i18n.md` point here instead of",
    "carrying a figure of their own, because a number written into prose is a number",
    "that stops being true without anything reporting it (myne-md/myne#589).",
    "",
    `Source: \`locales/${SOURCE_LOCALE}/${NAMESPACE}\`, **${enKeyCount}** leaf keys.`,
    `Catalogs: **${rows.length}** target locales, **${complete}** of them complete.`,
    `Overall: **${overall}%** of ${totalPossible} (locale, key) pairs translated.`,
    "",
    "**Read that figure with its limit attached, which is half of what #589 was.**",
    "It counts keys that are PRESENT and non-empty. It says nothing about whether a",
    "translation still means what its English means: 209 of the roughly 424 keys that",
    "incident found had drifted were non-empty, placeholder-clean and simply old,",
    "and every one of them counts as translated here. That half is",
    "`scripts/check-i18n-stale.mjs`, hand-run before a release",
    "(`myne-ops/runbooks/release-checklist.md`), because detecting it means walking",
    "the git history of all 32 catalogs per key. A 100% row is not a claim that the",
    "locale is current.",
    "",
    "| Locale | Translated | Missing | Coverage | Plural categories | Required (CLDR) |",
    "|---|---:|---:|---:|---|---|",
    ...rows.map(
      (r) =>
        `| \`${r.code}\` | ${r.translated} | ${r.missing} | ${r.coverage}% | ${r.categories} | ${r.required} |`,
    ),
    "",
    "**Missing** means the key is absent or empty, so the UI renders English through",
    "the per-key fallback. That is a degraded screen rather than a broken one, which",
    "is why `scripts/check-i18n.mjs` allows it and why this record exists to keep it",
    "visible.",
    "",
    "**Plural categories** is what each catalog itself uses. **Required (CLDR)** is",
    "what the guard holds it to, and only that column is a gate: a group missing one",
    "of the categories `Intl.PluralRules` can select for its locale is a hard failure,",
    "because i18next resolves it, finds nothing, and falls through to English",
    "mid-sentence. A category beyond CLDR is carried but never required, since no",
    "count can select it" +
      (beyondCldr.length
        ? ` (${beyondCldr.join(" ")} carry English's \`one\` that way, the shipped convention recorded in \`docs/decisions/storage/0411\`).`
        : "."),
    "",
  ].join("\n");
}

function diskIo(repo) {
  return {
    readFile: (rel) => {
      const abs = join(repo, rel);
      return existsSync(abs) ? readFileSync(abs, "utf8") : null;
    },
    exists: (rel) => existsSync(join(repo, rel)),
    localeDirs: () =>
      readdirSync(join(repo, LOCALES_DIR)).filter((d) => statSync(join(repo, LOCALES_DIR, d)).isDirectory()),
  };
}

/**
 * The whole command, minus the two side effects. Returns the exit code, the
 * record to write (or null), and the lines to print, so a spec can inject both
 * directions of every flag.
 *
 * This is exported for the same reason `analyse` is, and the reason is not
 * symmetry. `--check` is the ONLY part of this file that `lefthook.yml` and the
 * CI step invoke, and while it lived inline in the direct-invocation block no
 * test could reach it: deleting the entire staleness comparison left all 28
 * cases passing, pre-commit printing ok and CI green, with the record free to
 * drift from the catalogs indefinitely. That is myne-md/myne#589 restored
 * inside the guard written to end it.
 *
 * @returns {{ exitCode: number, emit: string | null, out: string[], err: string[] }}
 */
export function gate(io, argv = []) {
  const result = analyse(io);
  const out = [];
  const err = [];
  let emit = null;

  // `--emit` produces its record BEFORE the gate exit, deliberately, and this
  // is the lesson `check-twin-inventory.mjs` already records. With the order
  // reversed, an author whose tree is red for any unrelated reason gets a
  // `--check` failure telling them to run `--emit`, and that command then
  // prints the failure and writes nothing. The advice a guard gives has to work
  // in the state that triggers it. A halted run is the exception: its roster
  // never parsed, so there is no record to write and the file is left standing.
  if (argv.includes("--emit") && !result.halted) {
    emit = result.record;
    out.push(
      `i18n coverage: ${RECORD_PATH} regenerated (${result.overall}%, ${result.complete}/${result.rows.length} complete)`,
    );
  }

  if (result.failures.length) {
    err.push("i18n coverage: FAILED");
    for (const message of result.failures) err.push(`  - ${message}`);
    return { exitCode: 1, emit, out, err };
  }

  if (argv.includes("--emit")) return { exitCode: 0, emit, out, err };

  if (argv.includes("--check") && io.readFile(RECORD_PATH) !== result.record) {
    err.push("i18n coverage: FAILED");
    err.push(
      `  - ${RECORD_PATH} is stale. Run \`node scripts/check-i18n-coverage.mjs --emit\` and commit the result. ` +
        `The file is a generated projection: adding one English string pulls every locale row down at once, ` +
        `and that commit's diff is exactly where that should be visible.`,
    );
    return { exitCode: 1, emit, out, err };
  }

  out.push(
    `i18n coverage: ok (${result.rows.length} locales, ${result.complete} complete, ${result.overall}% overall; ` +
      `no partial plural groups, no placeholder mismatches)`,
  );
  return { exitCode: 0, emit, out, err };
}

// ── Report ─────────────────────────────────────────────────────────────────
// Only when run directly, so importing this module for a spec has no side effect.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
  const { exitCode, emit, out, err } = gate(diskIo(repo), process.argv.slice(2));
  if (emit !== null) writeFileSync(join(repo, RECORD_PATH), emit);
  for (const line of out) console.log(line);
  for (const line of err) console.error(line);
  process.exit(exitCode);
}
