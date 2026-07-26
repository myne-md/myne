// Importer — untrusted markup parsing (importer-breadth epic, MYND-580).
//
// ============================ INVARIANT ============================
// The documents and fragments produced here are DETACHED and are NEVER
// ATTACHED TO THE LIVE DOM. They exist only to be walked into markdown and
// discarded. Do not `append`, `insertBefore`, `replaceWith`, or otherwise
// adopt any node from here into `document`. `tests/notes/import/
// html-to-markdown.test.ts` asserts this.
// ===================================================================
//
// WHY `DOMParser` — XXE-safety is structural here, not a rule to remember.
//
// Every Evernote export legitimately opens with an EXTERNAL-DTD doctype:
//
//   <!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export3.dtd">
//
// An XML parser that resolved external entities against that would:
//   (a) FETCH A REMOTE URL — a direct violation of the no-remote-fetch
//       anti-feature, from a code path whose whole premise is that the importer
//       never reaches the network; and
//   (b) accept `<!ENTITY x SYSTEM "file:///etc/passwd">`, reading local files
//       into note content (classic XXE).
//
// Browser `DOMParser` does none of that: it does not load external DTDs, does not
// resolve external entities, does not execute scripts, and fetches no subresources
// for a document with no browsing context. So the doctype above is inert and the
// anti-feature holds BY CONSTRUCTION rather than by a check someone could forget.
// This is the reason the grill (2026-07-25 Q8) chose `DOMParser` over a hand-rolled
// extractor or a host-side XML parser.

/** Which parser mode to use. ENML and Notion/HTML exports differ in strictness. */
export type MarkupKind = "html" | "xml";

const MIME: Record<MarkupKind, DOMParserSupportedType> = {
  html: "text/html",
  xml: "text/xml",
};

/** Raised when `text/xml` input is not well-formed. HTML parsing never throws. */
export class MarkupParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarkupParseError";
  }
}

/**
 * Parse untrusted markup into a DETACHED document.
 *
 * `html` is lenient (the HTML spec's error recovery handles the malformed real-world
 * markup that Notion and arbitrary web exports contain). `xml` is strict and
 * surfaces a well-formedness failure as {@link MarkupParseError} so a corrupt
 * `.enex` fails loudly rather than importing as a single garbage note.
 */
export function parseMarkup(raw: string, kind: MarkupKind): Document {
  const doc = new DOMParser().parseFromString(raw, MIME[kind]);
  if (kind === "xml") {
    // `text/xml` reports failure in-band as a `<parsererror>` element rather than
    // by throwing — there is no exception to catch.
    const err = doc.querySelector("parsererror");
    if (err !== null) {
      throw new MarkupParseError(err.textContent?.trim() ?? "malformed XML");
    }
  }
  return doc;
}
