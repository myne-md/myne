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
const KNOWN = new Map([
  // — Newly VISIBLE with #273, not newly present: the scan used to read `.js`
  //   and `.css` only, so the bundle's 1.2 MB `pdf.worker.min-*.mjs` and 3.9 MB
  //   `myne_web_wasm_bg-*.wasm` were never read and these four sat unrecorded
  //   in the served tree while this script printed "all recorded". All four are
  //   string constants, and `web/csp.ts` pins `default-src 'none'`.
  ["http://ns.adobe.com", "pdf.js: XMP metadata NAMESPACE identifier — an XML namespace URI, never fetched"],
  ["http://www.apache.org", "pdf.js: Apache-2.0 licence header text"],
  ["http://www.xfa.org", "pdf.js: XFA form namespace identifier — an XML namespace URI, never fetched"],
  ["https://docs.rs", "rust: a doc link in a panic/error string compiled into the wasm"],
  // — Myne's own AI settings panel (#415/#189), not a vendored library. The AI
  //   panel names Ollama as the local model runtime and offers a link to it;
  //   `AiPanel.tsx` hands that URL to `openUrl`, an OS handoff into the USER's
  //   own browser through the platform seam. Nothing in the app fetches it, and
  //   the panel deliberately offers no "pull a model" affordance — which is what
  //   keeps "Myne never downloads models" true without an exception. CSP
  //   (`default-src 'none'`) blocks it at runtime regardless.
  ["https://ollama.com", "myne AI panel: the local-runtime link the user's own browser opens (openUrl, never fetched)"],
  // — Excalidraw's own services. Its collaboration, library-browser and AI
  //   features point at these. Myne uses none of them: drawing notes are local
  //   and the assets are self-hosted (`excalidraw-asset-path`). CSP-blocked.
  ["https://libraries.excalidraw.com", "excalidraw: library browser (unused; CSP-blocked)"],
  ["https://app.excalidraw.com", "excalidraw: upstream app links (doc text)"],
  ["https://plus.excalidraw.com", "excalidraw: upstream paid tier (doc text)"],
  ["https://docs.excalidraw.com", "excalidraw: documentation links"],
  ["http://docs.excalidraw.com", "excalidraw: documentation links"],
  ["https://json.excalidraw.com", "excalidraw: share-link backend (unused; CSP-blocked)"],
  ["https://oss-collab.excalidraw.com", "excalidraw: collaboration server (unused; CSP-blocked)"],
  ["https://oss-ai.excalidraw.com", "excalidraw: AI endpoint (unused; CSP-blocked)"],
  ["https://excalidraw-room-persistence.firebaseio.com", "excalidraw: collab persistence (unused; CSP-blocked)"],
  [
    "https://us-central1-excalidraw-room-persistence.cloudfunctions.net",
    "excalidraw: collab persistence (unused; CSP-blocked)",
  ],
  // — Embed allowlists. Excalidraw recognises these hosts when a user pastes an
  //   embeddable link. Myne surfaces no embed affordance; the constants ship
  //   with the library.
  ["https://player.vimeo.com", "excalidraw: embed host allowlist"],
  ["https://www.youtube.com", "excalidraw: embed host allowlist"],
  ["https://youtube.com", "excalidraw: embed host allowlist"],
  ["https://twitter.com", "excalidraw: embed host allowlist"],
  ["https://x.com", "excalidraw: embed host allowlist"],
  ["https://platform.twitter.com", "excalidraw: embed host allowlist"],
  ["https://reddit.com", "excalidraw: embed host allowlist"],
  ["https://embed.reddit.com", "excalidraw: embed host allowlist"],
  ["https://gist.github.com", "excalidraw: embed host allowlist"],
  ["https://github.com", "excalidraw: embed host allowlist / doc links"],
  ["https://giphy.com", "excalidraw: embed host allowlist"],
  ["https://www.figma.com", "excalidraw: embed host allowlist"],
  ["https://huggingface.co", "excalidraw/mermaid: doc links"],
  // — Mermaid and its parser stack: documentation links in errors and comments.
  ["https://mermaid.js.org", "mermaid: documentation links"],
  ["https://chevrotain.io", "mermaid: parser library doc links"],
  ["https://langium.org", "mermaid: parser library doc links"],
  ["https://esm.sh", "mermaid: upstream CDN reference in a comment"],
  // — Toolchain and standards references in vendored code.
  ["http://www.w3.org", "SVG/XML namespace URIs — not network addresses"],
  ["https://react.dev", "react: error-message documentation links"],
  ["https://rolldown.rs", "bundler banner"],
  ["https://en.wikipedia.org", "vendored doc link"],
  // Excalidraw's "follow us" / "report an issue" footer links, rendered as
  // `<a href>` in its help dialog. Inert markup, not a fetch — and Myne does
  // not surface that dialog. Verified by reading the call site.
  ["https://discord.gg", "excalidraw: help-dialog social link (inert <a href>)"],
  // — Placeholders in example/doc strings, not addresses.
  ["http://example.com", "placeholder in library docs"],
  ["https://foo.bar", "placeholder in library docs"],
  ["https://your-server.example", "placeholder in Myne's own copy"],
  ["https://sync.example.com", "placeholder in Myne's own copy"],
  ["http://127.0.0.1", "loopback — the local sync-server development target"],
  // — Myne's own.
  ["https://myne.md", "Myne's own site"],
]);

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
