// Shared hardened Excalidraw configuration (drawing-notes SF1, MYND-498; SYNC-5).
//
// This is the SINGLE place egress/UI hardening is specified. Every drawing
// surface — the SF2 live editor, the SF4 export renderer, the SF6 inline embed —
// imports this object and never re-specifies the hardening, mirroring the single
// `sanitize.ts` reused by embedded-HTML + mermaid.
//
// Egress posture (SYNC-5): Excalidraw renders shapes/text to `<canvas>`, not
// `innerHTML`, so the DOMPurify machinery mermaid/embedded-HTML need is not
// required here. The one HTML/iframe surface is the *embeddable* element type —
// rejected below. Collaboration, image-from-URL, and the library CDN are all
// external egress and are foreclosed by the CSP `connect-src`/`img-src` anyway;
// this object removes the affordances so they never surface in the UI.

/** Props spread into every `<Excalidraw>`; validated at the spread site. */
export const HARDENED_EXCALIDRAW_PROPS = {
  // Reject EVERY embeddable element (YouTube/Twitter/etc. iframes). This is the
  // one Excalidraw surface that would inject an <iframe> and demand widening
  // `frame-src` — a hard no. Returning false for every link rejects all.
  validateEmbeddable: (_link: string): boolean => false,
  // Do not advertise a "libraries.excalidraw.com" return URL — keep library
  // handling local-only (the CDN browse/import is CSP-blocked regardless).
  libraryReturnUrl: undefined as string | undefined,
  // English default; the mounting surface (SF2) wires theme + langCode from prefs.
  langCode: "en",
};
