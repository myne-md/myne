#!/usr/bin/env node
// Third-party-origin drift gate for the web bundle
// (phase3-web-client tasks 55 and 60).
//
// The commitment is "zero third-party origins" — it is what makes the bundle
// the whole attack surface, and it is what makes cross-origin isolation free
// rather than a trade. The RUNTIME guarantee is the Content-Security-Policy:
// `connect-src 'self' <sync-origin>` and `default-src 'none'` mean the browser
// refuses every other origin, no matter what a string in the bundle says.
//
// This check is about the **surface**, which is a different question and a
// weaker one: which external origins appear in the shipped JavaScript at all.
// Scanning bytes cannot prove reachability — a URL in a doc-link constant and a
// URL in a live `fetch()` look identical — so this does not try. It does what
// `src-tauri/scripts/ai-no-network-check.sh` does for the Rust side: pins the
// **known** set with a reason for each, and fails when a new one appears.
//
// A new origin showing up is not automatically wrong. It is automatically
// something a human has to look at, which is the entire point.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { relative } from "node:path";
import {
  partitionAssets,
  unknownExtensionMessage,
} from "./lib/scanned-assets.mjs";
import { join } from "node:path";
import { VENDORED_ORIGINS } from "./lib/vendored-origins.mjs";

const DIST = process.argv[2] ?? "web/dist";

// ── the pinned set ───────────────────────────────────────────────────────────
//
// Every entry is an origin that appears in the bundle today, with why. The
// dominant source is Excalidraw (the drawing-notes canvas) and Mermaid (diagram
// rendering) — both vendored libraries that carry documentation links, error
// text, and their own upstream service endpoints in string constants.
//
// **None of them is reachable at runtime**: the CSP names only `'self'` and the
// configured sync origin, so the browser blocks the request before it is made.
// That is the guarantee. This list exists so that the *next* one gets read by a
// person rather than shipped silently.
// The origins, with a reason each, in ONE place shared with
// `check-stories-bundle.mjs` (myne-md/myne#832) so the two lists cannot drift.
// `KNOWN` stays the local name the loops below read.
export const KNOWN = VENDORED_ORIGINS;

if (!existsSync(DIST)) {
  console.error(`web third-party check: no bundle at ${DIST} — run \`pnpm web:build\` first.`);
  process.exit(2);
}

const ORIGIN = /https?:\/\/[a-zA-Z0-9.-]+/g;
const found = new Map();

// #273: scan the WHOLE built tree, fail-closed on an extension nobody has
// classified. This listed the extensions it scanned (`.js`, `.css`) and read
// `assets/` non-recursively, so the bundle's 1.2 MB `pdf.worker.min-*.mjs` and
// 3.9 MB `myne_web_wasm_bg-*.wasm` were never read — and four unrecorded
// origins sat in the served tree while this printed "all recorded".
const { scan, unknown: unclassified } = partitionAssets(DIST);
if (unclassified.length > 0) {
  console.error(unknownExtensionMessage(unclassified));
  process.exit(1);
}
for (const file of scan) {
  // `latin1` rather than `utf8`: a `.wasm` is not valid UTF-8, and lossy
  // decoding would mangle exactly the ASCII runs an origin is made of.
  const text = readFileSync(file, "latin1");
  for (const m of text.matchAll(ORIGIN)) {
    if (!found.has(m[0])) found.set(m[0], relative(DIST, file));
  }
}

const unknown = [...found.keys()].filter((o) => !KNOWN.has(o)).sort();
const stale = [...KNOWN.keys()].filter((o) => !found.has(o)).sort();

if (unknown.length) {
  console.error("web bundle carries an UNRECORDED third-party origin:\n");
  for (const o of unknown) console.error(`  ${o}\n      first seen in assets/${found.get(o)}`);
  console.error(`
This is not automatically a failure — it is automatically something a person has
to look at. Decide which it is:

  * A string constant in a vendored library (a doc link, an error message, an
    embed allowlist). Add it to KNOWN in this script WITH THE REASON. The CSP
    blocks it at runtime regardless.

  * Something the app can actually reach. Then it is a real violation of the
    zero-third-party commitment (threat-model.md §6, TB9) and the dependency or
    the code path has to go — not the check.

Never add an entry without a reason; the reason is the whole value of the list.`);
  process.exit(1);
}

if (stale.length) {
  console.log(`web third-party check: ok (${found.size} origins, all recorded)`);
  console.log(`  note: ${stale.length} recorded origin(s) no longer present — safe to prune:`);
  for (const o of stale) console.log(`    ${o}`);
  process.exit(0);
}

console.log(`web third-party check: ok (${found.size} origins, all recorded)`);
