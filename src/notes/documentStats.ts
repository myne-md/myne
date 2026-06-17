// Live document statistics (MYND-339) — characters, words, spaces, paragraphs.
//
// `computeDocStats` runs over the dialect-stripped, frontmatter-excluded body
// (`extractBodyText`, whitespace PRESERVED) so the prose — not the markup — is
// measured, consistent with the word count (SYNC-1: stats exclude what the
// dialect hides; `%%` comments join that exclusion once they land). The pure
// `statsOfPlain` is reused for the selection path, fed the RAW selected text
// (what the user literally highlighted) rather than a re-stripped substring.

import { extractBodyText } from "../dialect";

export type DocStats = {
  /** Characters including spaces (code points of the trimmed text; internal
   *  whitespace and line breaks count). */
  characters: number;
  /** Whitespace-separated token count — equal to `countBodyWords` over the
   *  same source. */
  words: number;
  /** Literal space characters (U+0020). */
  spaces: number;
  /** Blank-line-delimited non-empty paragraph runs. */
  paragraphs: number;
};

const EMPTY: DocStats = { characters: 0, words: 0, spaces: 0, paragraphs: 0 };

/** Pure statistic formulas over an already-plain string. */
export function statsOfPlain(text: string): DocStats {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ...EMPTY };
  // Single pass for characters (code points) + spaces (U+0020) — avoids
  // materializing a code-point array (`[...trimmed]`) and a regex match array
  // just to read their lengths, on the debounced typing path.
  let characters = 0;
  let spaces = 0;
  for (const ch of trimmed) {
    characters++;
    if (ch === " ") spaces++;
  }
  return {
    characters,
    words: trimmed.split(/\s+/u).length,
    spaces,
    paragraphs: trimmed.split(/\n[ \t]*\n/u).filter((p) => p.trim().length > 0).length,
  };
}

/** Whole-note statistics over the dialect-stripped body. */
export function computeDocStats(content: string): DocStats {
  return statsOfPlain(extractBodyText(content));
}
