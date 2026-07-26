// Importer — HTML→markdown entry point (importer-breadth epic, MYND-580).
//
// The one function the three HTML-ish adapters call (Evernote ENML, generic HTML,
// Notion HTML): parse → sanitize → walk. Each stage is in its own module so the
// security boundary (`sanitize.ts`) and the XXE-safety rationale (`parse.ts`) are
// reviewable independently of the emit logic (`toMarkdown.ts`).
//
// Nothing here is ever attached to the live DOM — see the invariant banner in
// `parse.ts`.

import { parseMarkup, type MarkupKind } from "./parse";
import { sanitizeImportedHtml } from "./sanitize";
import { domToMarkdown, type MarkdownResult } from "./toMarkdown";

export { parseMarkup, MarkupParseError, type MarkupKind } from "./parse";
export { type MarkdownResult } from "./toMarkdown";

/**
 * Convert one untrusted HTML/ENML document to Myne-dialect markdown.
 *
 * `kind` selects parser strictness: `"html"` for arbitrary web/Notion exports
 * (lenient, HTML error recovery), `"xml"` for ENML bodies that should be
 * well-formed (throws `MarkupParseError` if not).
 *
 * Returns the markdown plus the names of constructs that had no dialect target, for
 * the per-note lossy flag the import report consumes.
 */
export async function htmlToMarkdown(
  raw: string,
  kind: MarkupKind = "html",
): Promise<MarkdownResult> {
  // Exactly ONE parse of the attacker-influenced bytes on the HTML path: DOMPurify
  // parses leniently itself and (with `WHOLE_DOCUMENT: false`) takes the body, so a
  // `DOMParser` pre-pass here would only serialize a tree for DOMPurify to re-parse.
  // XML is the exception — it needs the pre-pass purely for the well-formedness
  // check, so a corrupt `.enex` fails loudly instead of importing as one garbage note.
  const source = kind === "xml" ? parseMarkup(raw, "xml").documentElement.innerHTML : raw;
  const fragment = await sanitizeImportedHtml(source);
  return domToMarkdown(fragment);
}
