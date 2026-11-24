#!/usr/bin/env node
// No store frame may carry an identifier that is not pinned.
//
//   node scripts/check-store-frame-identifiers.mjs
//
// WHY THIS EXISTS
// Every frame in the set shows an account number, and one shows a recovery-phrase
// specimen. A store listing is permanent and public, so an identifier that reached
// one could never be retracted. This repository already treats the class as real
// and says why: `scripts/check-web-testids.mjs` exists partly on the reasoning
// that the account number is one keystroke from the DOM, and that screenshots and
// CI artefacts are among the places it can land. A published image is the most
// public such place.
//
// THE MECHANISM, and it is deliberately a source check rather than an OCR pass: it
// reads the screens the story renders and asserts that every account-number-shaped
// string in them is the ONE pinned value. A second value appearing anywhere in
// those files fails by name, whether it is a real number somebody pasted or a
// plausible-looking one a future author invented. OCR over the rendered PNGs would
// catch the same thing and would also be a lie about its own reliability, so it is
// not what this does.
//
// TWO IDENTIFIERS, TWO CROSS-CHECKS, against the literals the screen renders. The
// account-number half is held to `mobile/src/screens/members/index.tsx` in the unit
// spec. The phrase half is held HERE, against the `PINNED_PHRASE_FRAGMENT` literal
// the same screen renders: `PINNED_PHRASE_WORDS` compared only with its own length
// was a constant checked against itself, so lengthening the rendered specimen toward
// a fillable phrase left the guard and every test green. A phrase fragment that does
// not match the words this guard pins now fails by name.
//
// WHAT IT DELIBERATELY DOES NOT DO, because the alternative is worse: it does not
// re-derive the Damm-32 check character. The quasigroup table is a frozen literal
// in `docs/spec/account-number.md` §4.2, its single other copy is gated by the
// `damm32-table-drift` guard, and a third copy here would be exactly the
// duplication that guard exists to stop. The pinned value's check character was
// verified against the Rust implementation (`protocol/src/account_number.rs`) once,
// and this guard holds its FORMAT. The edge is named here rather than papered
// over, per AGENTS.md: "a guard that overstates its reach is worse than one that
// names its edge".

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STORY } from "./lib/store-shots/story.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * THE PINNED IDENTIFIERS. These are the only values a frame may show.
 *
 * Kept in step with `mobile/src/screens/members/index.tsx` by this guard: that
 * file is the one place the story's screens put them, and a change there without a
 * change here fails.
 */
export const PINNED_ACCOUNT_NUMBER = "MY-4H7Q-2M9T-8XKB-3R6W-P4N6";
export const PINNED_PHRASE_WORDS = ["harbor", "lantern"];

/**
 * The canonical placeholder shape, which is not an identifier.
 *
 * `mobile/src/lib/account-number-format.ts` names it in the format's own
 * documentation and `SyncSettingsPanels.tsx` uses it as an input hint. Compared
 * as an EXACT string rather than as a pattern, so a second placeholder shape, or
 * a real value wearing an X or two, still fails.
 */
const PLACEHOLDER_ACCOUNT_NUMBER = "MY-XXXX-XXXX-XXXX-XXXX-XXXX";

/**
 * The caption data, whose text is DRAWN ONTO the frame.
 *
 * Exported so a test can name it: the non-vacuity property is "this exact file is
 * in the scan", not "the scan read at least N files", because one screen source
 * swapped for the caption file keeps a count and loses the file whose strings are
 * the most certainly in the finished image.
 */
export const CAPTION_SOURCE = join(REPO_ROOT, "scripts/lib/store-shots/captions.en.json");

/** Crockford base32, minus I, L, O and U. */
const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]+$/;

/** `MY-` then five dash-separated groups of four (account-number.md §2). */
export function isDisplayForm(value) {
  if (!/^MY(-[0-9A-HJKMNP-TV-Z]{4}){5}$/.test(value)) return false;
  const body = value.slice(3).replace(/-/g, "");
  return body.length === 20 && CROCKFORD.test(body);
}

/** Every account-number-shaped run in a source file. */
export function accountNumbersIn(source) {
  // The board renders this string with U+2011 non-breaking hyphens, which
  // `mobile/src/styles/tokens.css` mandates for it. Matching ASCII "-" alone read
  // ZERO values out of a screen that carries one, so a second account number could
  // have reached a published frame with the guard printing ok. Normalise every dash
  // this repository writes before matching.
  const normalised = source.replace(/[\u2010\u2011\u2012\u2013]/g, "-");
  return [...new Set(normalised.match(/MY-[0-9A-Z]{4}(?:-[0-9A-Z]{4}){4}/g) ?? [])];
}

/**
 * The alphabetic words inside a screen's `PINNED_PHRASE_FRAGMENT` literal, or null.
 *
 * The specimen interleaves Crockford index digits with the BIP-39 words it shows
 * (`["01", "harbor", "03", "lantern"]`); only the words are the phrase, so the
 * numeric slots are dropped and the remaining words are what the guard pins.
 */
export function phraseWordsIn(source) {
  const literal = source.match(/PINNED_PHRASE_FRAGMENT\s*=\s*\[([^\]]*)\]/);
  if (!literal) return null;
  return [...literal[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]).filter((w) => /^[a-z]/i.test(w));
}

/**
 * The module that HOLDS the account-number specimen every board screen renders.
 *
 * Named here as well as reached through the import closure, because a named
 * absence is the only shape that survives the withdrawal it guards against: the
 * screens stopped carrying literals when they started importing this constant,
 * and a scan of the screens alone then reported ok over the one file that can
 * introduce a second value. Removing the constant, or moving it, fails by name.
 */
export const SPECIMEN_SOURCE = join(REPO_ROOT, "mobile/src/components/misc.tsx");

/** Resolve one relative import from a file to the module it names, or null. */
function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [`${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Every module a story screen imports, transitively.
 *
 * This is the denominator the first version got wrong: it read the screens and
 * not what they render THROUGH. `ACCOUNT_NUMBER_SPECIMEN` moved out of the
 * screen literals into `mobile/src/components/misc.tsx`, so a screen-only scan
 * could no longer see the one value that reaches every published frame, and the
 * guard kept printing that the only reachable account number was the pinned one.
 * The closure follows relative imports only, which is what keeps a third-party
 * module from dragging the tree in, and it stops at files that exist.
 */
function importClosure(roots) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(/from\s+"([^"]+)"/g)) {
      const next = resolveImport(file, match[1]);
      if (next) queue.push(next);
    }
  }
  return [...seen];
}

/**
 * Screen ids map to modules by their section prefix, read off the board's
 * registry rather than guessed: a new prefix means a new entry here, which is
 * the moment somebody should look at the file anyway.
 */
const SCREEN_PREFIX_TO_DIR = {
  "05": "notes",
  "08": "workspace",
  "09": "workspace",
  "10": "workspace",
  "11": "workspace",
  "ST-": "settings",
  "SY-": "sync",
  "AG-": "agent",
  "MB-": "members",
  "PT-": "portable",
  "WS-": "ipad",
  "ED-": "ipad",
  "SC-": "ipad",
};

/**
 * Story screen ids this guard cannot map to a module.
 *
 * A new section prefix that nobody added above would otherwise SHRINK the scan
 * while the guard still printed ok, which is the roster-drift shape the empty
 * denominator check cannot see: `scanned` stays above zero because the other
 * sections are still read. Failing by name is what makes a new section a
 * deliberate edit here rather than a silent omission.
 */
export function unresolvedStoryScreens(story = STORY) {
  const ids = new Set();
  for (const frame of story) {
    for (const id of [frame.screens.phone, frame.screens.tablet]) if (id) ids.add(id);
  }
  return [...ids].filter(
    (id) => !Object.keys(SCREEN_PREFIX_TO_DIR).some((p) => id === p || id.startsWith(p)),
  );
}

/** The screen modules the story renders, deduplicated. */
function storySourceFiles() {
  const ids = new Set();
  for (const frame of STORY) {
    for (const id of [frame.screens.phone, frame.screens.tablet]) if (id) ids.add(id);
  }
  const files = new Set();
  for (const id of ids) {
    for (const [prefix, dir] of Object.entries(SCREEN_PREFIX_TO_DIR)) {
      if (id === prefix || id.startsWith(prefix)) {
        // The tablet family lives at `mobile/src/ipad/`, NOT under
        // `screens/`: it was renamed out of the phone tree, and assuming the
        // shared path threw ENOENT on the first run rather than reporting ok
        // over a file it never read.
        if (dir === "ipad") {
          files.add(join(REPO_ROOT, "mobile/src/ipad/index.tsx"));
          files.add(join(REPO_ROOT, "mobile/src/ipad/editor.tsx"));
          files.add(join(REPO_ROOT, "mobile/src/ipad/commands.tsx"));
        } else {
          files.add(join(REPO_ROOT, "mobile/src/screens", dir, "index.tsx"));
        }
      }
    }
  }
  return [...new Set([...importClosure(files), SPECIMEN_SOURCE])];
}

/**
 * The check, with its inputs injectable so a test can drive it.
 *
 * `sources` maps a path to its text. `pinned` is the allowlist. Nothing here reads
 * the tree when both are supplied.
 */
/**
 * The parameter is typed as an index signature ON PURPOSE. `allowJs` infers a
 * parameter's type from its destructured defaults, so `sources = null` made TS
 * read every caller's object as `null` and the test tree's typecheck ratchet
 * counted 6 errors that were about THIS module's inference rather than about the
 * tests. `@param {{ [key: string]: any }}` says "an options object" and leaves the
 * runtime validation where it is.
 *
 * @param {{ [key: string]: any }} [options]
 */
export function check({
  sources = null,
  pinned = PINNED_ACCOUNT_NUMBER,
  pinnedPhrase = PINNED_PHRASE_WORDS,
} = {}) {
  const errors = [];

  if (!isDisplayForm(pinned)) {
    errors.push(`the pinned account number "${pinned}" is not a valid display form`);
  }
  if (pinnedPhrase.length !== 2) {
    errors.push(`the pinned phrase specimen must be two words, got ${pinnedPhrase.length}`);
  }

  const resolved =
    sources ??
    Object.fromEntries([
      ...storySourceFiles().map((f) => [f, readFileSync(f, "utf8")]),
      // THE CAPTION DATA, which is not a screen and is therefore easy to forget.
      // It was forgotten in the first version: the guards and all 87 tests stayed
      // green with `MY-9Z8Y-...` sitting in a card's text, and card text is DRAWN
      // ONTO THE FRAME. A screen-source-only scan misses the one file whose strings
      // are even more certainly in the finished image. That it is present is checked
      // by NAME below, not by a file count.
      [CAPTION_SOURCE, readFileSync(CAPTION_SOURCE, "utf8")],
    ]);

  // NAMED-ABSENCE rather than a count floor. A future screen added while the
  // caption file is dropped would keep a `scanned >= N` count and lose the one file
  // whose text is most certainly in the finished image, so the property has to name
  // the path.
  if (sources === null && !(CAPTION_SOURCE in resolved)) {
    errors.push(
      "the caption file scripts/lib/store-shots/captions.en.json was not read, so the strings drawn onto the frames were not checked",
    );
  }
  if (sources === null) {
    for (const id of unresolvedStoryScreens()) {
      errors.push(
        `the story names screen "${id}", which maps to no source module: add its section prefix to SCREEN_PREFIX_TO_DIR, or the scan silently covers less than it claims`,
      );
    }
  }
  if (sources === null && !(SPECIMEN_SOURCE in resolved)) {
    errors.push(
      "the module that declares the account-number specimen (mobile/src/components/misc.tsx) was not read, so the value every board screen renders was not checked",
    );
  }

  let scanned = 0;
  for (const [path, text] of Object.entries(resolved)) {
    scanned += 1;
    for (const value of accountNumbersIn(text)) {
      if (value === PLACEHOLDER_ACCOUNT_NUMBER) continue;
      if (value !== pinned) {
        errors.push(
          `${path.replace(REPO_ROOT + "/", "")} carries an account number that is not the pinned one: "${value}". A frame may show only ${pinned}.`,
        );
      }
    }
    // The phrase half, cross-checked against the literal the screen renders. The
    // guard's two words compared with their own length is a constant checked
    // against itself; this compares them with what a frame actually draws.
    const words = phraseWordsIn(text);
    if (words && words.join("\u0000") !== pinnedPhrase.join("\u0000")) {
      errors.push(
        `${path.replace(REPO_ROOT + "/", "")} renders the phrase specimen ${JSON.stringify(words)} but the guard pins ${JSON.stringify(pinnedPhrase)}. A frame may show only the pinned specimen.`,
      );
    }
  }

  if (scanned === 0) {
    errors.push("no screen source was read, so this check compared nothing");
  }

  return { errors, scanned, paths: Object.keys(resolved) };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { errors, scanned } = check();
  if (errors.length > 0) {
    console.error("store-frame-identifiers: a frame could carry an identifier that is not pinned\n");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(
    `store-frame-identifiers: ok (${scanned} story screen source(s); the only account number reachable by a frame is the pinned one)`,
  );
}
