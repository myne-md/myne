// SYNC-1 (heading-list-folding / MYND-300): the ONE canonical "heading list
// with positions" surface. The wikilink-deep-links feature (MYND-305) imports
// THIS for anchor resolution + `[[#` autocomplete, so neither feature forks a
// second heading model and neither spins up a second parser (single-parser
// rule). It is built on the shared lezer tree via `extractHeadings`.
//
// Per heading we expose `{ level, text, from, sectionTo }`:
//   - `level`     — 1..6 (ATX or Setext, inherited from `HeadingRef`).
//   - `text`      — the heading's inline text (markers/links stripped).
//   - `from`      — the heading LINE start byte offset.
//   - `sectionTo` — the END of the heading's section: the `from` of the next
//                   same-or-higher heading, or the document length when there is
//                   none. This is the "fold a heading subsumes its subtree"
//                   boundary (a higher-level heading's section spans every deeper
//                   heading beneath it).

import type { Tree } from "@lezer/common";
import { extractHeadings } from "./headings";
import type { HeadingLevel } from "../types";

export type HeadingSection = {
  level: HeadingLevel;
  text: string;
  /** Byte offset of the heading line start. */
  from: number;
  /** Byte offset where this heading's section ends (exclusive). */
  sectionTo: number;
};

/**
 * Enumerate the document's headings with their section spans. Reads the shared
 * lezer tree (pass a pre-parsed `tree` to reuse an existing parse; omit it and
 * `extractHeadings` parses once with the canonical parser).
 *
 * `sectionTo` for heading `i` is the `from` of the first SUBSEQUENT heading with
 * level ≤ heading `i`'s level (a same-or-higher heading), else the document
 * length. So an `# H1` section subsumes every `##`/`###`/… beneath it until the
 * next `# H1` (or document end) — the boundary folding collapses.
 */
export function headingSections(source: string, tree?: Tree): HeadingSection[] {
  const refs = extractHeadings(source, tree);
  return refs.map((ref, i) => {
    let sectionTo = source.length;
    for (let j = i + 1; j < refs.length; j++) {
      if (refs[j]!.level <= ref.level) {
        sectionTo = refs[j]!.byteRange.start;
        break;
      }
    }
    return {
      level: ref.level,
      text: ref.text,
      from: ref.byteRange.start,
      sectionTo,
    };
  });
}
