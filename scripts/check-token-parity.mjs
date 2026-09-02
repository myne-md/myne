#!/usr/bin/env node
// Two rules over the design-token layer (myne-md/myne#478).
//
// **The failure this prevents.** A design token is a name in one file and a
// `var(--name)` in another, and NOTHING connects the two. Neither half fails to
// compile, neither throws, and the wrong output is a plausible-looking surface:
// a card with no background reads as a deliberate flat design, and a highlight
// that resolves to nothing reads as "no highlight applied". Both halves shipped:
//
//   1. `mobile/src/styles/tokens.css` was a hand copy of the desktop sheet
//      carrying "Kept in step with src/styles/tokens.css" as a promise, and it
//      was **105 token declarations behind** across its four palette blocks,
//      eight folder-group colours, eight text-highlight colours, `--danger-solid`
//      and `--selection-bg`, each missing from all four. Two of those families
//      are vault CONTENT: a folder-group colour rides `vault.prefs` as
//      `Shared(WholeValueLww)` (`core/src/plugins/sync/prefs_classification.rs`)
//      and a highlight rides the note body as `<mark class="hl-teal">`
//      (`dialect/src/visitors/headings.ts`). So they synced to a phone that could
//      not paint them, and `editor/src/toolbar/plugin.ts`, shared, mounted on
//      both clients, drew eight of its thirteen swatch squares with
//      `background-color: var(--highlight-teal)` and no fallback, i.e. blank.
//
//   2. `var(--paper-1)` at eight call sites, one of them in the shared
//      `@myne/editor` package so it reached all three clients. There is no
//      `--paper-1`: the surface ramp's light end is the bare `--paper`, and
//      `src/CLAUDE.md` says so in those words. It resolved to nothing at every
//      one of them, including the recovery-phrase entry cells. `--accent-1` was
//      the same mistake once, on mobile.
//
// The first is closed structurally, the tokens now live once, in
// `client-core/src/tokens.css`, and all three clients import it. This guard
// holds the two things that structure does not:
//
// **RULE 1, one token name, one declaration.** A client sheet declaring a name
// the shared sheet ALSO declares is overriding it; two client sheets declaring
// the same name are two clients answering one question independently. Either is
// how both halves of defect 1 happened, and either must be RECORDED in
// `OVERRIDES` with the reason the clients should differ. What the rule
// deliberately does not touch is a token only one client declares:
// `--toast-accent` is desktop chrome and `--m-touch` is a phone metric, and
// neither makes a claim about the other client. The first draft of this rule was
// "a client sheet may not declare a token the shared sheet lacks", which is
// wrong in both directions once the tokens have actually moved, it fires on
// every desktop toast variable, and scoped to the palette sheets it would have
// checked nothing at all, since after the extraction neither client sheet is a
// palette sheet any more.
//
// **RULE 2, a `var(--x)` with no fallback names a token something declares.**
// This is the half that catches `--paper-1`. Scoped to fallback-less references
// on purpose: `var(--x, #fff)` degrades to a stated value and is a choice, while
// `var(--x)` on an undeclared name is silence. Tokens supplied at RUNTIME by
// JavaScript are recorded in `RUNTIME_TOKENS` with the file that sets them.
//
// Both rules are checked in BOTH directions: a recorded override whose token is
// gone, and a recorded runtime token nothing references, each fail as stale. A
// record that outlives its subject stops describing anything, which is the
// failure `check-version-routing.mjs` reports for its own budget.
//
// Usage:
//   node scripts/check-token-parity.mjs
//   node scripts/check-token-parity.mjs --scan <dir>   (test seam; see below)

import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { grammarFor, stripComments } from "./check-twin-inventory.mjs";
import { presentSharedRoots } from "./lib/shared-roots.mjs";
import { walkFiles } from "./lib/surface-files.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The one sheet every client imports. */
const SHARED_SHEET = "client-core/src/tokens.css";

/**
 * Every per-client sheet, each loaded AFTER the shared one.
 *
 * A token DECLARED IN ONLY ONE of these is component-local and legitimate:
 * `--toast-accent` is desktop chrome, `--m-touch` and the `--glass-*` family are
 * phone metrics and phone chrome. Neither makes a claim about the other client.
 * What rule 1 catches is the opposite shape, spelled out at its own site below.
 */
const CLIENT_SHEETS = [
  "src/styles/tokens.css",
  "mobile/src/styles/tokens.css",
  "mobile/src/styles/mobile.css",
];

/**
 * Deliberate per-client overrides: `token -> reason`.
 *
 * An entry is a claim that the two clients SHOULD differ here, reviewed like any
 * other. The bar is a difference in layout or platform rather than in palette,
 * "this client's surfaces overlay rather than adjoin" qualifies, "this looked
 * nicer" does not.
 */
const OVERRIDES = {
  "--_paper-2-amoled":
    "mobile/src/styles/tokens.css. Desktop takes AMOLED's recessed surfaces to true black, arguing that its sidebar and right rail sit BESIDE the editor so a raised grey reads as a band next to it. On a phone the same surfaces are a drawer and a sheet that OVERLAY the page, so at #000 on #000 their edge disappears and there is no adjacent hairline to separate them. A layout difference, not a palette one.",
  "--_paper-3-amoled":
    "mobile/src/styles/tokens.css. The sibling of the entry above and for the same reason: the topmost interactive surface needs a lift the desktop layout gets from adjacency.",
};

/**
 * Tokens no stylesheet declares because a module sets them on an element at
 * runtime: `token -> the file that sets it`.
 *
 * Compared both ways. A stale entry means the setter is gone and every
 * `var()` on it now resolves to nothing, which is exactly rule 2's defect
 * wearing an exemption.
 */
const RUNTIME_TOKENS = {
  "--editor-font-family": "editor/src/typography.ts",
  "--editor-text-size": "editor/src/typography.ts",
  "--editor-line-spacing": "editor/src/typography.ts",
};

/**
 * Trees whose `var()` references rule 2 checks: every shared tree, IMPORTED
 * rather than listed.
 *
 * The first version hardcoded seven paths, which is `SHARED_ROOTS` minus
 * `copy/src` with no stated reason for the narrowing, and this same change
 * adds `client-core/src` to that roster, so the two lists would have had to
 * move together. `scripts/lib/shared-roots.mjs` exists because every guard
 * that kept a private copy of "which trees are shared" ended up checking a
 * different set than its success line claimed.
 *
 * A root on the roster but absent from the checkout is a failure here, not a
 * smaller walk.
 */
const { present: CONSUMER_TREES, missing: MISSING_ROOTS } = presentSharedRoots();

/**
 * Both token sets of one file, from ONE comment-stripping pass.
 *
 * `declared` is every `--token:`; `referenced` is every `var(--x)` with NO
 * fallback, plus the `cssVar: "--x"` form the editor toolbar holds a token name
 * in and builds a `var()` from later.
 *
 * Two things here are reuse rather than preference. The stripper is
 * `check-twin-inventory.mjs`'s `stripComments`, which walks characters and
 * knows a string literal from a comment; the private one this replaced dropped
 * whole lines beginning `//`, so it also ate `const u = "https://…"` and left a
 * trailing `x = 1; // var(--ghost)` in place. And the two sets come from one
 * strip: they used to be two exported functions each stripping the same source,
 * which ran the pass 2660 times for 1330 files (57.9 ms against 15.0 ms with
 * the `--` prefilter below).
 */
export function tokensIn(path, src) {
  const declared = new Set();
  const referenced = new Set();
  // Nothing without a `--` in it can declare or name a token, and only 412 of
  // the tree's 1330 files contain one. Checked before the strip because the
  // strip is the expensive half.
  if (!src.includes("--")) return { declared, referenced };
  const clean = stripComments(src, grammarFor(path));
  for (const m of clean.matchAll(/(--[\w-]+)\s*:/g)) declared.add(m[1]);
  for (const m of clean.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) referenced.add(m[1]);
  for (const m of clean.matchAll(/cssVar:\s*"(--[\w-]+)"/g)) referenced.add(m[1]);
  return { declared, referenced };
}

/**
 * The analysis, over an injectable file set, so the test can drive it against a
 * throwaway tree rather than against `src/`.
 *
 * `read(path) -> string | null`, `list() -> string[]` of consumer files.
 */
export function analyse({ sharedSheet, clientSheets, consumerFiles, read }) {
  const sharedSrc = read(sharedSheet);
  if (sharedSrc === null) {
    return { fatal: `the shared token sheet is missing: ${sharedSheet}` };
  }
  const shared = tokensIn(sharedSheet, sharedSrc).declared;

  // ONE read per client sheet, for all three things that need it. It used to be
  // three loops over the same roster, each calling `read()` again, which is
  // three places a future filter has to be added and only one of them feeds
  // rule 1.
  //
  // A sheet named in the roster but absent from the tree takes its tokens out of
  // every rule here without a word, which is the shape the roster exists to
  // prevent.
  const missingSheets = [];
  const declaredBy = new Map();
  for (const sheet of clientSheets) {
    const src = read(sheet);
    if (src === null) {
      missingSheets.push(sheet);
      continue;
    }
    for (const t of tokensIn(sheet, src).declared) {
      if (!declaredBy.has(t)) declaredBy.set(t, []);
      declaredBy.get(t).push(sheet);
    }
  }

  // RULE 1, ONE NAME, TWO INDEPENDENT DECLARATIONS.
  //
  // The rule is not "a client sheet may not declare a token", which would be
  // wrong twice over: after the extraction both client sheets are component
  // sheets, so that phrasing would either fire on every desktop toast token or,
  // scoped to the palette sheets that no longer exist, check nothing at all.
  //
  // The defect is a NAME declared in more than one place. That is what the
  // 105-token gap was (two hand-maintained palettes, one 105 behind) and what
  // the two AMOLED greys were (one name, two values, neither side aware). So a
  // client declaration fires when the shared sheet ALSO declares that name, the
  // client is overriding, or when a SECOND client sheet does, which is two
  // clients answering one question independently. A token only one client
  // declares makes no cross-client claim and is left alone.
  const contested = [...declaredBy].filter(([t, sheets]) => shared.has(t) || sheets.length > 1);
  const oneSided = contested
    .filter(([t]) => !(t in OVERRIDES))
    .map(([t, sheets]) => ({
      token: t,
      sheet: sheets.join(", ") + (shared.has(t) ? ", + the shared sheet" : ""),
    }));
  const seenOverrides = new Set(contested.map(([t]) => t).filter((t) => t in OVERRIDES));
  const staleOverrides = Object.keys(OVERRIDES).filter((t) => !seenOverrides.has(t));

  // RULE 2, a fallback-less reference to a token nothing declares.
  //
  // A token a consumer file declares ITSELF counts as declared: the PDF export
  // stylesheet holds its CSS as a string and declares `--callout-bar` two lines
  // above using it, which is a self-contained document rather than a reference
  // to the app's palette.
  const declared = new Set([...shared, ...declaredBy.keys()]);
  const references = new Map();
  for (const f of consumerFiles) {
    const src = read(f);
    if (src === null) continue;
    const { declared: d, referenced } = tokensIn(f, src);
    for (const t of d) declared.add(t);
    for (const t of referenced) {
      if (!references.has(t)) references.set(t, []);
      references.get(t).push(f);
    }
  }
  const undeclared = [...references.keys()]
    .filter((t) => !declared.has(t) && !(t in RUNTIME_TOKENS))
    .sort()
    .map((t) => ({ token: t, files: references.get(t) }));
  const staleRuntime = Object.keys(RUNTIME_TOKENS).filter((t) => !references.has(t));

  return { oneSided, staleOverrides, undeclared, staleRuntime, missingSheets };
}

function main() {
  const argv = process.argv.slice(2);
  const scanAt = argv.indexOf("--scan");
  const base = scanAt === -1 ? REPO : resolve(argv[scanAt + 1]);
  // One syscall, not three. `existsSync + statSync + readFileSync` over 1330
  // files is 3990 syscalls to answer what the walk already knows and the read
  // itself would tell us: 61.4 ms against 28.1 ms for the try/catch form, on a
  // guard that runs in `pre-commit`. Same null contract, same test seam.
  // `check-twin-inventory.mjs` records the identical fix for the identical
  // reason.
  const read = (p) => {
    try {
      return readFileSync(resolve(base, p), "utf8");
    } catch {
      return null;
    }
  };

  // A roster root absent from the checkout fails BEFORE the walk, which is what
  // the three sibling guards importing the same module do (check-prefs-nonce,
  // check-datetime-display-publisher, check-manual-test-roster). The first
  // version of this consumed only `.present` and relied on `missingIsNull`,
  // which cannot fire: every path handed to `walkFiles` had already been
  // `existsSync`-confirmed by `presentSharedRoots`. So the branch was inert and
  // the header's claim that a missing root is a failure here was false, on a
  // checkout where the success line would have printed `ok` about a smaller
  // walk. That is the `check-prefs-nonce.mjs` shape the root CLAUDE.md records.
  if (MISSING_ROOTS.length > 0) {
    console.error(
      "token-parity: shared root(s) named by scripts/lib/shared-roots.mjs are\n" +
        "  missing from this checkout:\n\n" +
        MISSING_ROOTS.map((r) => `    ${r}`).join("\n") +
        "\n\n  A smaller walk would report `ok` about less than the success line\n" +
        "  claims. Restore the tree, or say in that module why the root left.\n",
    );
    process.exit(1);
  }

  const consumerFiles = walkFiles(
    CONSUMER_TREES.map((t) => resolve(base, t)),
    // Still `missingIsNull`, as the backstop for a root that disappears between
    // the check above and the walk.
    { relativeTo: base, extensions: /\.(ts|tsx|css)$/, missingIsNull: true },
  );
  if (consumerFiles === null) {
    console.error("token-parity: a consumer tree vanished mid-walk.\n");
    process.exit(1);
  }

  const r = analyse({
    sharedSheet: SHARED_SHEET,
    clientSheets: CLIENT_SHEETS,
    consumerFiles,
    read,
  });

  if (r.fatal) {
    console.error(`token-parity: ${r.fatal}`);
    process.exit(1);
  }

  let failed = false;

  if (r.missingSheets.length > 0) {
    failed = true;
    console.error("token-parity: recorded sheet(s) that no longer exist:\n");
    for (const s of r.missingSheets) console.error(`    ${s}`);
    console.error(
      "\n  A sheet that went away takes its tokens out of every rule here without\n" +
        "  a word. Update the roster to say where they went.\n",
    );
  }

  if (r.oneSided.length > 0) {
    failed = true;
    console.error("token-parity: one token name, two independent declarations:\n");
    for (const { token, sheet } of r.oneSided) console.error(`    ${token}  (${sheet})`);
    console.error(
      "\n  Two declarations of one name is two places its value can drift, which is\n" +
        "  how mobile's palette fell 105 tokens behind and how the two AMOLED greys\n" +
        "  ended up different colours under one name. Delete the client copy and let\n" +
        "  `client-core/src/tokens.css` answer, or record it in `OVERRIDES` with the\n" +
        "  reason the clients SHOULD differ here.\n",
    );
  }

  if (r.staleOverrides.length > 0) {
    failed = true;
    console.error("token-parity: recorded override(s) whose token no longer exists:\n");
    for (const t of r.staleOverrides) console.error(`    ${t}`);
    console.error("\n  Remove the entry. A record that outlives its subject describes nothing.\n");
  }

  if (r.undeclared.length > 0) {
    failed = true;
    console.error("token-parity: `var(--x)` with no fallback on a token nothing declares:\n");
    for (const { token, files } of r.undeclared) {
      console.error(`    ${token}`);
      for (const f of files.slice(0, 4)) console.error(`        ${f}`);
      if (files.length > 4) console.error(`        … and ${files.length - 4} more`);
    }
    console.error(
      "\n  It resolves to nothing: the property is simply not applied, which looks\n" +
        "  like a deliberate flat surface rather than a bug. Check the spelling\n" +
        "  against `client-core/src/tokens.css` (there is no `--paper-1`; the ramp's\n" +
        "  light end is `--paper`), give it a fallback, or record it in\n" +
        "  `RUNTIME_TOKENS` naming the module that sets it.\n",
    );
  }

  if (r.staleRuntime.length > 0) {
    failed = true;
    console.error("token-parity: recorded runtime token(s) nothing references:\n");
    for (const t of r.staleRuntime) console.error(`    ${t}  (set by ${RUNTIME_TOKENS[t]})`);
    console.error("\n  Either the reference went away, or the exemption is stale. Remove it.\n");
  }

  if (failed) process.exit(1);

  console.log(
    `token-parity: ok (${consumerFiles.length} file(s) checked, ` +
      `${Object.keys(OVERRIDES).length} recorded override(s), ` +
      `${Object.keys(RUNTIME_TOKENS).length} runtime token(s))`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export { OVERRIDES, RUNTIME_TOKENS, SHARED_SHEET, CLIENT_SHEETS, CONSUMER_TREES };
