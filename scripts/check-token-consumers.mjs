#!/usr/bin/env node
// check-token-consumers.mjs, a motion or type token is USED somewhere
// (myne-md/myne#847 tasks 12 and 13).
//
// The failure this prevents: the sheet declares a duration, an easing or a size
// token, the catalogue renders a specimen for it, and NOTHING in the tree reads
// it. A token nobody reads looks authoritative, is documented, is reviewed, and
// does nothing: changing it changes no pixel anywhere. That is the same shape as
// `check-token-adoption.mjs`'s hardcoded literal, seen from the other side.
//
// The two families are here rather than in a general "every token is used" rule
// because they are the two the catalogue can only DISPLAY: a colour has a swatch
// and a spacing step has a bar, so their absence is visible, while a duration and
// a size are numbers a reader has to take on trust. Those are exactly the tokens
// whose unusedness is invisible.
//
// It is a reference-level check on purpose. A behavioural one (mount a surface,
// read the computed transition) is the honest version and it is per surface, so
// it is either narrow or expensive; the guard's job here is to catch the token
// nothing mentions at all, which is the common case and the cheap one.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { walkFiles } from "./lib/surface-files.mjs";
import { presentSharedRoots } from "./lib/shared-roots.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const SHEET = join(ROOT, "client-core/src/tokens.css");

/** The families a catalogue can only display, and why each is here. */
export const FAMILIES = Object.freeze({
  duration: /^--duration-/,
  ease: /^--ease-/,
  text: /^--text-/,
});

/**
 * Every declared token name in the sheet, once.
 * @param {string} css
 * @returns {Set<string>}
 */
export function declaredTokens(css) {
  const out = new Set();
  const re = /(--[A-Za-z0-9-]+)\s*:/g;
  let match;
  while ((match = re.exec(css)) !== null) out.add(match[1]);
  return out;
}

/**
 * Token names in the guarded families.
 * @param {string} css
 * @returns {Set<string>}
 */
export function familyTokens(css) {
  const out = new Set();
  for (const name of declaredTokens(css)) {
    for (const pattern of Object.values(FAMILIES)) {
      if (pattern.test(name)) {
        out.add(name);
        break;
      }
    }
  }
  return out;
}

/**
 * The token names read somewhere outside the sheet, as `var(--name)`.
 *
 * The sheet itself is excluded, because a declaration is not a use: a token whose
 * only mention is its own definition is exactly the token this guard exists for.
 * @param {Iterable<string>} files
 * @param {(path: string) => string} [read]
 * @returns {Set<string>}
 */
export function consumedTokens(files, read = (p) => readFileSync(p, "utf8")) {
  const out = new Set();
  for (const file of files) {
    const source = read(file);
    for (const match of source.matchAll(/var\(\s*(--[A-Za-z0-9-]+)\s*[,)]/g)) out.add(match[1]);
  }
  return out;
}

/**
 * Tokens declared for THEME AUTHORS rather than for a shipped rule, each with
 * its reason. Compared both ways: an entry whose token has gained a consumer
 * fails as stale, so the list cannot quietly outlive the fact it describes.
 *
 * This carve-out is why the rule is not "a token must be used": the sheet is a
 * PUBLISHED surface, and a custom theme may reference any token it declares. So
 * the guard reports what no shipped rule reads, which is a fact worth knowing,
 * rather than calling it dead.
 */
export const THEME_ONLY = Object.freeze({
  "--duration-slower":
    "the longest step, same reason; the shipped UI tops out at --duration-base",
});

/**
 * The guarded-family tokens that nothing outside the sheet reads, and the
 * recorded exemptions that have gone stale.
 *
 * Pure and exported, so the spec drives BOTH arms rather than only the good
 * path: the guard's own central decision was the one thing no test exercised
 * (myne-md/myne#847 review).
 * @param {Iterable<string>} families
 * @param {Set<string>} used
 * @param {Record<string, string>} [themeOnly]
 * @returns {string[]}
 */
export function unusedTokens(families, used, themeOnly = THEME_ONLY) {
  return [...families].filter((name) => !used.has(name) && !(name in themeOnly)).sort();
}

/**
 * The recorded exemptions whose token HAS a consumer: the record went stale.
 * @param {Set<string>} used
 * @param {Record<string, string>} [themeOnly]
 * @returns {string[]}
 */
export function staleExemptions(used, themeOnly = THEME_ONLY) {
  return Object.keys(themeOnly).filter((name) => used.has(name));
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop());

if (invokedDirectly) {
  if (!existsSync(SHEET)) {
    console.error(`check-token-consumers: FAIL: token sheet not found at ${SHEET}`);
    process.exit(1);
  }
  const css = readFileSync(SHEET, "utf8");
  const families = familyTokens(css);
  if (families.size === 0) {
    console.error(
      "check-token-consumers: FAIL: no duration, ease or text token was read from the sheet; the scan is broken",
    );
    process.exit(1);
  }

  const roots = presentSharedRoots().present.map((root) => join(ROOT, root));
  const files = walkFiles(roots, { relativeTo: ROOT, extensions: /\.(ts|tsx|css)$/, missingIsNull: true });
  if (files === null) {
    console.error("check-token-consumers: FAIL: a shared tree vanished mid-walk.");
    process.exit(1);
  }
  // The sheet is a declaration, not a use.
  const consumers = files.filter((file) => !file.endsWith("client-core/src/tokens.css"));
  if (consumers.length === 0) {
    console.error(
      "check-token-consumers: FAIL: zero consumer files were read; a scan that covers nothing reports ok about nothing",
    );
    process.exit(1);
  }

  const used = consumedTokens(consumers);

  // An exemption whose token HAS a consumer is stale: the record has stopped
  // describing anything.
  const stale = staleExemptions(used);
  if (stale.length > 0) {
    console.error("check-token-consumers: recorded exemption(s) whose token is now read:");
    for (const name of stale) console.error(`  ${name}`);
    console.error("\n  Remove the entry: it no longer describes the tree.");
    process.exit(1);
  }

  const unused = unusedTokens(families, used);

  if (unused.length > 0) {
    console.error(
      `check-token-consumers: ${unused.length} duration/ease/text token(s) that nothing outside the sheet reads`,
    );
    for (const name of unused) console.error(`  ${name}`);
    console.error(
      "\n  A token nothing reads is documented, reviewed and inert: changing it changes no pixel.\n" +
        "  Use it, or delete it from the sheet.",
    );
    process.exit(1);
  }

  console.log(
    `check-token-consumers: ok (${families.size} duration/ease/text token(s) accounted for, ` +
      `${Object.keys(THEME_ONLY).length} recorded as theme-only, across ${consumers.length} consumer file(s))`,
  );
}
