// Third-party origins that appear in a built client because a VENDORED library
// carries them as string constants, each with the reason. Shared by
// `check-web-third-party.mjs` and `check-stories-bundle.mjs` so the two lists
// cannot drift.
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
  ["https://sync.example.com", "placeholder in Myne's own copy"],
  ["https://myne.md", "Myne's own site"],
  ["https://sync.myne.md", "the documented production sync origin, a placeholder in Myne's own copy"],
  ["http://scripts.sil.org", "SIL OFL licence text in a bundled font's metadata"],
  ["https://scripts.sil.org", "SIL OFL licence text in a bundled font's metadata"],
  ["https://raw.githubusercontent.com", "vendored doc links"],
]);
