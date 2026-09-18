// check-i18n-duplicates.mjs — one product fact, one string (myne-md/myne#649).
//
// What it prevents: two i18n keys carrying the same English sentence, translated
// twice and drifting apart unobserved. #649 was five transcription-failure causes
// told in two key families (`attachments.library.transcribe*` and
// `editor.attachment.widget.transcribe.cause.*`); four pairs were byte-identical
// in English and 21 of 31 catalogs had already diverged on one of them. Neither
// `check-i18n.mjs` (key exists) nor `check-i18n-coverage.mjs` (presence, plurals,
// placeholders per key) compares two keys' English with each other, so the drift
// was invisible from both sides and grew with every copy edit.
//
// Scope is deliberately a floor, not every duplicate. Short labels ("Cancel",
// "Save", "Close") are shared across dozens of surfaces by design; gating them
// would mean a roster of thousands. The #649 class is full sentences, so this
// guard only looks at English values of MIN_LEN characters or more. Calibration:
// the shortest #649 sentence was 30 chars ("Unlock your vault to transcribe."),
// MIN_LEN 25 keeps a margin below it. Plural siblings (`_one`/`_other`/…) of one
// stem collapse to the stem first, or every plural group would report itself.
//
// Compared BOTH ways over scripts/i18n-duplicate-groups.json, the recorded
// roster of value -> key-set + reason:
//
//   1. an actual duplicate group with no record fails naming the value and keys
//      (the #649 shape: a second telling nobody approved);
//   2. a recorded value no longer duplicated fails as stale (a rewording exits
//      the roster by editing the record, not by silence);
//   3. a changed key set fails naming the added/removed keys (a new caller
//      joining a shared sentence is a decision, not an accident);
//   4. a missing, short, or placeholder reason fails. `--record` seeds fresh
//      entries with the string REASON REQUIRED and the checker rejects that
//      exact string, so a re-baseline cannot come back green on its own:
//      a re-baseline that passes without a human reason is a re-baseline that
//      licensed everything it found.
//
// Verifying this guard means breaking it, not running it: inject a second key
// with an existing sentence and watch it name both keys, then restore. Both
// directions: also delete one side of a recorded pair and watch it fail stale.
// `tests/scripts/i18nDuplicates.test.ts` drives each failure direction through
// injected catalogs.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

export const EN_CATALOG_PATH = join(ROOT, "locales", "en", "common.json");
export const RECORD_PATH = join(HERE, "i18n-duplicate-groups.json");

// Shortest #649 sentence was 30 chars; 25 keeps a margin while short UI labels
// ("Cancel", "Save") stay out of the roster entirely.
export const MIN_LEN = 25;
export const MIN_REASON_LEN = 20;
export const PLACEHOLDER = "REASON REQUIRED";

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

function stem(key) {
  return key.replace(PLURAL_SUFFIX, "");
}

function flatten(obj, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object") flatten(v, key, out);
    else out.push([key, v]);
  }
  return out;
}

// Duplicate groups over a parsed catalog object: Map<english value, sorted stems>.
export function duplicateGroups(catalog) {
  const byValue = new Map();
  for (const [key, value] of flatten(catalog, "", [])) {
    if (typeof value !== "string") continue;
    if (value.trim().length === 0) continue;
    if (value.length < MIN_LEN) continue;
    const s = stem(key);
    if (!byValue.has(value)) byValue.set(value, new Set());
    byValue.get(value).add(s);
  }
  const groups = new Map();
  for (const [value, stems] of byValue) {
    if (stems.size > 1) groups.set(value, [...stems].sort());
  }
  return groups;
}

export function loadCatalog(path = EN_CATALOG_PATH) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function loadRecord(path = RECORD_PATH) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

// Returns a list of failure strings; empty means the tree matches the record.
export function checkGroups(actual, record) {
  const failures = [];
  const recorded = new Map(record.map((e) => [e.value, e]));

  for (const [value, keys] of actual) {
    const entry = recorded.get(value);
    if (!entry) {
      failures.push(
        `unrecorded duplicate English (${value.length} chars): ${JSON.stringify(value.slice(0, 80))} shared by ${keys.join(", ")}. ` +
          `If the sharing is intentional, \`node scripts/check-i18n-duplicates.mjs --record\` then write the reason; if not, reword one side.`,
      );
      continue;
    }
    const missing = keys.filter((k) => !entry.keys.includes(k));
    const extra = entry.keys.filter((k) => !keys.includes(k));
    if (missing.length > 0 || extra.length > 0) {
      failures.push(
        `duplicate group changed for ${JSON.stringify(value.slice(0, 80))}: ` +
          (missing.length > 0 ? `joined by ${missing.join(", ")}` : "") +
          (missing.length > 0 && extra.length > 0 ? "; " : "") +
          (extra.length > 0 ? `left by ${extra.join(", ")}` : "") +
          `. Update the roster if intentional, reword if not.`,
      );
    }
    const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
    if (reason === PLACEHOLDER) {
      failures.push(
        `duplicate group ${JSON.stringify(value.slice(0, 80))} still carries the --record placeholder reason. Write why these keys share one sentence.`,
      );
    } else if (reason.length < MIN_REASON_LEN) {
      failures.push(
        `duplicate group ${JSON.stringify(value.slice(0, 80))} has no usable reason (${reason.length} chars, need ${MIN_REASON_LEN}). Say why the sharing is intentional.`,
      );
    }
  }

  for (const entry of record) {
    if (!actual.has(entry.value)) {
      failures.push(
        `stale duplicate-group record: ${JSON.stringify(String(entry.value).slice(0, 80))} is no longer shared English. Remove the entry in the same change that reworded a side.`,
      );
    }
  }

  return failures;
}

// --record MERGES: entries whose value and key set still match keep their
// human reason; everything new arrives with the placeholder the checker
// rejects, so the command the failure message suggests cannot silence it.
export function buildRecord(actual, previous) {
  const prev = new Map((previous ?? []).map((e) => [e.value, e]));
  return [...actual.entries()].map(([value, keys]) => {
    const old = prev.get(value);
    const keep =
      old &&
      Array.isArray(old.keys) &&
      old.keys.length === keys.length &&
      old.keys.every((k, i) => k === keys[i]) &&
      typeof old.reason === "string" &&
      old.reason.trim() !== "" &&
      old.reason.trim() !== PLACEHOLDER;
    return { value, keys, reason: keep ? old.reason : PLACEHOLDER };
  });
}

const mode = process.argv[2];
if (mode === "--record") {
  let previous = [];
  try {
    previous = loadRecord();
  } catch {
    previous = [];
  }
  const actual = duplicateGroups(loadCatalog());
  const next = buildRecord(actual, previous);
  writeFileSync(RECORD_PATH, JSON.stringify(next, null, 2) + "\n");
  const pending = next.filter((e) => e.reason === PLACEHOLDER).length;
  console.log(
    `i18n duplicates: record written (${next.length} groups, ${pending} need a human reason). --check fails until every reason is written.`,
  );
} else {
  // Default and --check: compare the tree against the record.
  const actual = duplicateGroups(loadCatalog());
  const failures = checkGroups(actual, loadRecord());
  if (failures.length > 0) {
    console.log("i18n duplicates: FAILED");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log(`i18n duplicates: ok (${actual.size} recorded groups, none unrecorded).`);
}
