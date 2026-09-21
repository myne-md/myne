// Bundled self-hosted @font-face declarations for standalone HTML/PDF
// export documents (note-export MYND-340; extracted from the PDF capture
// template `src/pdf-export/main.ts` so the standalone-HTML assembler and
// the PDF hidden window serve the same faces from one source).
//
// The bundled self-hosted faces (public/fonts/ — see src/AGENTS.md "Design
// tokens"). PRINT_CSS references the family NAMES only (both the "…
// Variable" and plain forms, mirroring colors_and_type.css); a standalone
// document serves the faces itself via these rules. Both names map to the
// same variable-font file.
//
// `/fonts/…` is an absolute path under the app's WebView origin — it
// resolves inside the running app (the PDF hidden window, and a live HTML
// preview), but NOT in a `.html` file opened later from disk in an
// external browser. That degradation is acceptable: the system-font
// fallback stack in PRINT_CSS keeps the document readable. (A future
// option is to inline the woff2 as data-URIs; deferred — the families
// degrade gracefully today.)

export const FONT_FACE_CSS = `
@font-face {
  font-family: "Inter Variable";
  font-style: normal;
  font-weight: 100 900;
  font-display: block;
  src: url("/fonts/InterVariable.woff2") format("woff2");
}
@font-face {
  font-family: "Inter";
  font-style: normal;
  font-weight: 100 900;
  font-display: block;
  src: url("/fonts/InterVariable.woff2") format("woff2");
}
@font-face {
  font-family: "JetBrains Mono Variable";
  font-style: normal;
  font-weight: 100 800;
  font-display: block;
  src: url("/fonts/JetBrainsMono.woff2") format("woff2");
}
@font-face {
  font-family: "JetBrains Mono";
  font-style: normal;
  font-weight: 100 800;
  font-display: block;
  src: url("/fonts/JetBrainsMono.woff2") format("woff2");
}
`;
