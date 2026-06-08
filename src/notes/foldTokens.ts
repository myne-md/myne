// Shared folded-word tokenizer for the unlinked-mentions linking family
// (knowledge-graph-ux #2). ONE Unicode word-boundary tokenizer + fold so the
// matcher (`unlinkedMentions.ts`) and the inserter (`linkMention.ts`) agree on
// exactly what a "word" is — any divergence would let a mention be detected but
// then not found for linking (or vice-versa). §3.7.8 fold.

import { foldSegment } from "../dialect/folderPath";

const WORD_RE = /[\p{L}\p{N}]+/gu;

export type TokenSpan = { fold: string; start: number; end: number };

/**
 * Folded word tokens (Unicode letters + numbers) with their raw `[start, end)`
 * offsets in `s`. The canonical tokenizer; {@link foldedWords} is the offset-
 * free wrapper. Pure.
 */
export function foldedTokenSpans(s: string): TokenSpan[] {
  const out: TokenSpan[] = [];
  // The module-level /g regex is stateful — reset before each scan.
  WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_RE.exec(s)) !== null) {
    out.push({
      fold: foldSegment(m[0]),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

/** Folded word tokens only (offsets discarded). Pure. */
export function foldedWords(s: string): string[] {
  return foldedTokenSpans(s).map((t) => t.fold);
}
