// Third-party origins that appear in a built client because a VENDORED library
// carries them as string constants, each with the reason. This is the UNION
// across the clients, and the two guards below do NOT both read it whole: see
// `WEB_VENDORED_ORIGINS` for why.
//
// Every entry here is inert at runtime: a documentation link, an XML namespace
// URI, an embed allowlist the app never surfaces, or a placeholder in example
// copy. Neither client can fetch one (the web client's CSP names only 'self' and
// its sync origin; the catalogue makes no network call and pins
// `connect-src 'none'`). The list exists so a NEW origin is read by a person
// rather than shipped silently.

export const VENDORED_ORIGINS = new Map([
  // pdf.js
  ["http://ns.adobe.com", "pdf.js: XMP metadata NAMESPACE identifier, an XML namespace URI, never fetched"],
  ["http://www.apache.org", "pdf.js: Apache-2.0 licence header text"],
  ["http://www.xfa.org", "pdf.js: XFA form namespace identifier, an XML namespace URI, never fetched"],
  ["http://example.com", "placeholder in library docs"],
  ["https://foo.bar", "placeholder in library docs"],
  // Excalidraw (the drawing-notes canvas)
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
  // Excalidraw embed allowlists (recognised hosts for a pasted embeddable link)
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
  ["https://discord.gg", "excalidraw: help-dialog social link (inert <a href>)"],
  // Mermaid and its parser stack
  ["https://mermaid.js.org", "mermaid: documentation links"],
  ["https://chevrotain.io", "mermaid: parser library doc links"],
  ["https://langium.org", "mermaid: parser library doc links"],
  ["https://esm.sh", "mermaid: upstream CDN reference in a comment"],
  ["https://huggingface.co", "excalidraw/mermaid: doc links"],
  // Toolchain and standards references in vendored code
  ["http://www.w3.org", "SVG/XML namespace URIs, not network addresses"],
  ["https://react.dev", "react: error-message documentation links"],
  ["https://rolldown.rs", "bundler banner"],
  ["https://en.wikipedia.org", "vendored doc link"],
  ["https://docs.rs", "rust: a doc link in a panic/error string compiled into the wasm"],
  // Myne's own
  ["https://ollama.com", "myne AI panel: the local-runtime link the user's own browser opens (never fetched)"],
  ["http://127.0.0.1", "loopback: the local sync-server development target"],
  ["https://your-server.example", "placeholder in Myne's own copy"],
  [
    "https://sync.example",
    "placeholder in Myne's own COPY, not in a vendored library: the sync-server address the identity home's register stories show in a configured-endpoint fixture. `.example` is reserved by RFC 2606, so it can never resolve, and the catalogue makes no network call. Story-only, hence WEB_EXCLUDED.",
  ],
  ["https://sync.example.com", "placeholder in Myne's own copy"],
  ["https://myne.md", "Myne's own site"],
  ["https://sync.myne.md", "the documented production sync origin, a placeholder in Myne's own copy"],
  [
    "https://app.myne.md",
    "Myne's own web-client origin: a link the catalogue's Welcome page offers. Never fetched: the Welcome page LINKS out and the catalogue makes no request. The deploy is recommended to pin `connect-src 'none'` (`stories/README.md`), and the served bundle cannot carry the origin, hence WEB_EXCLUDED.",
  ],
  [
    "https://status.myne.md",
    "Myne's own service-status page: a link the catalogue's Welcome page offers. Never fetched, and the served bundle cannot carry it, hence WEB_EXCLUDED.",
  ],
  ["http://scripts.sil.org", "SIL OFL licence text in a bundled font's metadata"],
  ["https://scripts.sil.org", "SIL OFL licence text in a bundled font's metadata"],
  ["https://raw.githubusercontent.com", "vendored doc links"],
  [
    "https://dequeuniversity.com",
    "axe-core: the rule documentation links it carries as string constants. Present only where axe is bundled (the story catalogue); inert, and the catalogue makes no network call.",
  ],
]);

/**
 * The origins the WEB bundle can legitimately carry, which is what
 * `check-web-third-party.mjs` reads.
 *
 * Reading the union whole was a regression: an origin only the story catalogue
 * or a desktop-only artefact carries was then "recorded" for the web bundle, so
 * the next genuinely new web origin matching one of them would ship with no
 * human reading it — the exact review that guard exists to force. The web set is
 * the union minus the origins that cannot reach the served bundle: the SIL OFL
 * font licence text lives in `public/fonts/LICENSE.txt`, and the web scan does
 * not read `.txt` (the catalogue's does). A superset is safe here in one
 * direction only: an origin the web bundle DOES carry and this set omits would
 * fail the guard's unknown-origin arm, so membership is checked in a test.
 */
const WEB_EXCLUDED = new Set([
  "http://scripts.sil.org",
  "https://scripts.sil.org",
  // A story fixture's placeholder endpoint. It is in `stories/src/stories/`, so
  // it cannot reach the served bundle; leaving it in the web set would
  // pre-approve a genuinely new web origin that happened to match it.
  "https://sync.example",
  // Offered by the catalogue's Welcome page only; the app's web bundle has no
  // link to either.
  "https://app.myne.md",
  "https://status.myne.md",
  // axe-core's rule-documentation links. `axe-core` is a devDependency imported
  // only by `stories/` and the test lanes, so it cannot reach the served bundle;
  // leaving it in the web set would pre-approve an origin the web bundle cannot
  // carry, which is the regression this set exists to prevent.
  "https://dequeuniversity.com",
]);
export const WEB_VENDORED_ORIGINS = new Map(
  [...VENDORED_ORIGINS].filter(([origin]) => !WEB_EXCLUDED.has(origin)),
);

/** The origins the story catalogue can legitimately carry; it reads the union. */
export const STORIES_VENDORED_ORIGINS = VENDORED_ORIGINS;
