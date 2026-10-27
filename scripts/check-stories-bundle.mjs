#!/usr/bin/env node
// check-stories-bundle.mjs: the catalogue's served bundle carries no secret and
// no unrecorded global (myne-md/myne#832).
//
// The catalogue will be served (probably at design.myne.md). It is dev tooling,
// but a served static page is a served static page, and a hand-authored fixture
// is exactly how a recovery phrase or a real account number would reach one.
// This guard reads the ARTEFACT, not the source: source can be tree-shaken or
// not, reachable or not, and a test would pass either way.
//
// It checks four things:
//   1. every origin in the bundle is a recorded, explained string constant;
//   2. the BIP-39 word list is absent, so no phrase can be shown or typed;
//   3. no account-number-shaped string appears outside a recorded allowlist;
//   4. every runtime global is the host's, and only the host's.
//
// Run after `pnpm stories:build`; a missing `stories/dist` is a failure, not a
// skip, because a guard that skips its input reads as a pass.

import { readFileSync, existsSync } from "node:fs";
import { relative } from "node:path";
import {
  partitionAssets,
  unknownExtensionMessage,
} from "./lib/scanned-assets.mjs";
import { STORIES_VENDORED_ORIGINS } from "./lib/vendored-origins.mjs";

// ── pinned origins ───────────────────────────────────────────────────────────
//
// The catalogue now mounts real screens, so it pulls in the same vendored
// libraries the web bundle does (Excalidraw, Mermaid, pdf.js), AND it scans the
// font licence text the web scan ignores. It reads the shared union from
// `lib/vendored-origins.mjs`; the web guard reads the narrower
// `WEB_VENDORED_ORIGINS` from the same file, so the reasons have one home and
// only the membership differs.
export const KNOWN_ORIGINS = STORIES_VENDORED_ORIGINS;

// ── the BIP-39 word list ─────────────────────────────────────────────────────
//
// The strongest phrase-surface check available on an artefact, and the cleanest:
// no phrase can be DISPLAYED or ENTERED without the word list, so its absence
// from the served bundle is a real guarantee rather than a routing claim. The
// markers are BIP-39's first word and a few of its later, low-frequency words; a
// bundled list carries all of them, prose carries none. Matched in their quoted
// forms so `zoom` cannot match `zoo`.
export const WORDLIST_MARKERS = ["abandon", "walnut", "zebra", "cactus", "zoo"];

// A SPACE-JOINED list is one string (`"abandon ability able about …"`), so it
// carries the markers but not their QUOTED forms and the per-word check above
// misses it. The list's opening three words, in order, are the tell; matching
// them across whitespace and separators catches a joined list, a JSON array
// flattened to one line, and a newline-broken dump alike.
export const WORDLIST_SEQUENCE = /\babandon\b[\s,"'`]+ability\b[\s,"'`]+able\b/;

// ── account-number shapes ────────────────────────────────────────────────────
//
// A `MY-XXXX-XXXX-XXXX-XXXX-XXXX` shaped string. This list requires REVIEW, not
// validity: the demo value in the Input primitive story is a syntactically
// shaped placeholder that no Damm-32 check would accept, and that shape is the
// point (a real account number is the thing the guard exists to catch). A new
// string of this shape has to be added here with its reason.
export const ACCOUNT_SHAPE = /MY-[A-Z0-9]{4}(?:-[A-Z0-9]{4}){4}/g;
export const ALLOWED_ACCOUNT_STRINGS = new Map([
  [
    "MY-ABCD-EFGH-JKMN-PQRS-TVWX",
    "synthetic placeholder in the Input primitive story; deliberately not a valid account number",
  ],
  [
    "MY-XXXX-XXXX-XXXX-XXXX-XXXX",
    "the schema's own illustrative placeholder (`account-number.md` §2). Shipped by the app's parser/help text, not a real number.",
  ],
  [
    "MY-M2Y5-3CAD-5SJ6-0H8A-J8JM",
    "the account number the `components/identityhome/enrolled` story renders, a prop the story hands its own fixture. Synthetic: it belongs to no person, no Damm-32 issuer minted it, and the story's identity code beside it is likewise made up.",
  ],
]);

// ── runtime globals ──────────────────────────────────────────────────────────
//
// A global a scenario can call is a global any script on the page can call, so
// the catalogue may ship only Tauri's OWN runtime keys, which the mounted
// `@tauri-apps/api` reads and which the fake host answers. Any `__myne*` test
// hook fails here, the same posture `check-web-no-test-hooks.mjs` takes for the
// web bundle.
export const GLOBAL_SHAPE = /__(?:TAURI[A-Z0-9_]*__|myne[A-Za-z0-9_]*)/g;
export const ALLOWED_GLOBALS = new Set([
  "__TAURI_INTERNALS__",
  "__TAURI_TO_IPC_KEY__",
  "__TAURI_EVENT_PLUGIN_INTERNALS__",
]);

/**
 * The pure classification of one file's text, so the spec can drive it without
 * a real bundle on disk.
 */
export function classifyText(text) {
  const origins = new Set();
  for (const m of text.matchAll(new RegExp(ORIGIN_SOURCE, "g"))) origins.add(m[0]);

  const wordlist = [];
  for (const marker of WORDLIST_MARKERS) {
    if (
      text.includes(`"${marker}"`) ||
      text.includes(`'${marker}'`) ||
      text.includes(`\`${marker}\``)
    ) {
      wordlist.push(marker);
    }
  }
  if (WORDLIST_SEQUENCE.test(text)) wordlist.push("abandon ability able (joined list)");

  const accounts = new Set();
  for (const m of text.matchAll(new RegExp(ACCOUNT_SHAPE.source, "g"))) accounts.add(m[0]);

  const globals = new Set();
  for (const m of text.matchAll(new RegExp(GLOBAL_SHAPE.source, "g"))) globals.add(m[0]);

  return {
    origins: [...origins],
    wordlist,
    accounts: [...accounts],
    globals: [...globals],
  };
}

const ORIGIN_SOURCE = /https?:\/\/[a-zA-Z0-9.-]+/;

/**
 * The comparison, as a pure function over already-read file texts.
 * `files` is an array of `{ path, text }`.
 */
export function findBundleProblems({ files }) {
  const problems = [];
  const origins = new Map();
  const accounts = new Map();
  const wordlist = new Set();
  const globals = new Map();

  for (const file of files) {
    const found = classifyText(file.text);
    for (const o of found.origins) if (!origins.has(o)) origins.set(o, file.path);
    for (const a of found.accounts) if (!accounts.has(a)) accounts.set(a, file.path);
    for (const w of found.wordlist) wordlist.add(w);
    for (const g of found.globals) if (!globals.has(g)) globals.set(g, file.path);
  }

  for (const [origin, file] of origins) {
    if (!KNOWN_ORIGINS.has(origin)) {
      problems.push(
        `bundle carries an UNRECORDED origin ${origin} (first seen in ${file}). Record it in KNOWN_ORIGINS with its reason, or remove the code that put it there.`,
      );
    }
  }

  for (const marker of wordlist) {
    problems.push(
      `bundle contains the BIP-39 word-list marker "${marker}". The catalogue must not be able to display or accept a recovery phrase. Remove the import path that pulls the word list in.`,
    );
  }

  for (const [value, file] of accounts) {
    if (!ALLOWED_ACCOUNT_STRINGS.has(value)) {
      problems.push(
        `bundle contains an account-number-shaped string "${value}" (${file}). If it is a synthetic placeholder, add it to ALLOWED_ACCOUNT_STRINGS with its reason; if it is real, remove it and rotate the account.`,
      );
    }
  }

  for (const [global, file] of globals) {
    if (!ALLOWED_GLOBALS.has(global)) {
      problems.push(
        `bundle carries the runtime global "${global}" (${file}), which is not the host's. A global a scenario can call is a global any script on the page can call.`,
      );
    }
  }

  return problems;
}

const DIST = process.argv[2] ?? "stories/dist";

function main() {
  if (!existsSync(DIST)) {
    console.error(
      `stories bundle check: no bundle at ${DIST}. Run \`pnpm stories:build\` first.`,
    );
    process.exit(2);
  }

  // #273 posture: name what is ignored, fail closed on anything unrecognised.
  const { scan, unknown: unclassified } = partitionAssets(DIST);
  if (unclassified.length > 0) {
    console.error(unknownExtensionMessage(unclassified));
    process.exit(1);
  }
  if (scan.length === 0) {
    console.error(`stories bundle check: no scannable files under ${DIST}, so the scan is broken.`);
    process.exit(1);
  }
  if (!existsSync(`${DIST}/index.html`)) {
    console.error(`stories bundle check: ${DIST}/index.html is missing, so this is not a serveable static build.`);
    process.exit(1);
  }

  // `latin1` so a binary asset (`.wasm`) still yields its ASCII runs; the origin
  // regex is ASCII either way.
  const files = scan.map((file) => ({
    path: relative(DIST, file),
    text: readFileSync(file, "latin1"),
  }));

  const problems = findBundleProblems({ files });

  if (problems.length > 0) {
    console.error("check-stories-bundle: FAIL");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  const total = files.reduce((n, f) => n + classifyText(f.text).origins.length, 0);
  console.log(
    `check-stories-bundle: ok (${files.length} file(s), ${KNOWN_ORIGINS.size} recorded origin(s), BIP-39 word list absent, ${ALLOWED_ACCOUNT_STRINGS.size} recorded account placeholder(s), ${ALLOWED_GLOBALS.size} allowed global(s); ${total} origin reference(s) seen).`,
  );
}

const invokedDirectly =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (invokedDirectly) main();
