// Unlinked-mentions matching engine (knowledge-graph-ux #2 / MYND-196,
// build-phase v1.1). Finds notes that MENTION the open note's title in prose
// without `[[wikilink]]`-ing it. Rides the existing encrypted `vault.search`
// (MYND-29) BM25 index as a CANDIDATE filter (no new at-rest artefact, SYNC-14),
// then verifies each candidate with a `foldSegment` word-boundary match on the
// decrypted body (SYNC-2 — the search tokenizer is candidate-recall only, NOT
// the identity authority). The pure matcher + floor are unit-testable.

import { foldSegment } from "../dialect/folderPath";
import { extractFullText } from "../dialect/visitors/fullText";
import { foldedWords } from "./foldTokens";
import { noteRead } from "./readNote";
import type { ResolverNote } from "./resolveWikilink";
import { backlinks } from "./vaultIndices";
import { searchNotes } from "./searchNotes";
import type { NoteSearchResult } from "../types/note-search-result";

/** A note that mentions the open note's title without linking it. */
export type UnlinkedMention = { noteId: string; title: string };

/**
 * Corpus-relative phrase document-frequency ceiling — a title appearing in more
 * than this fraction of the vault is almost certainly a common word ("Note",
 * "Index") and is suppressed. A TUNABLE CODE CONSTANT, NOT spec (deliberate
 * contrast with the frozen Damm table); calibrate against real vaults.
 */
export const MENTION_DF_CEILING = 0.15;

/**
 * Minimum corpus size for the df ceiling to apply. Below this, document-
 * frequency is statistical noise: each note is `1/N` of the vault, so any title
 * mentioned even once has `df ≥ 1/N` — at N=3 that's already 0.33 > the ceiling,
 * which would blind every new/small vault entirely (the df filter is a LARGE-
 * vault common-word suppressor, not a small-vault gate). Below this threshold
 * the word-boundary + min-length guards carry the floor alone. Tunable code
 * constant.
 */
export const MENTION_DF_MIN_CORPUS = 20;

/** ≤2 folded-char titles are suppressed outright (the seatbelt under the
 *  frequency signal for degenerate short titles). So a title needs ≥ 3. */
export const MIN_TITLE_FOLDED_CHARS = 3;

/**
 * Word-boundary, fold-identity match: does `fullText` contain `title` as a
 * contiguous whole-word phrase (folded)? Token-based, so "Index" does NOT match
 * inside "Reindex" (no substring false positives). Pure.
 */
export function foldedTitleMatches(fullText: string, title: string): boolean {
  const tw = foldedWords(title);
  if (tw.length === 0) return false;
  const fw = foldedWords(fullText);
  outer: for (let i = 0; i + tw.length <= fw.length; i += 1) {
    for (let j = 0; j < tw.length; j += 1) {
      if (fw[i + j] !== tw[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * The false-positive floor: a title shows unlinked mentions only when it is
 * ≥ {@link MIN_TITLE_FOLDED_CHARS} folded chars AND — once the corpus is large
 * enough for df to be meaningful ({@link MENTION_DF_MIN_CORPUS}) — its corpus
 * phrase-df (candidates / total notes) is ≤ {@link MENTION_DF_CEILING}. In a
 * small vault the df clause is skipped (it would suppress every legitimate
 * specific title). Pure.
 */
export function passesMentionFloor(
  title: string,
  candidateCount: number,
  totalNotes: number,
): boolean {
  if (foldSegment(title).length < MIN_TITLE_FOLDED_CHARS) return false;
  if (
    totalNotes >= MENTION_DF_MIN_CORPUS &&
    candidateCount / totalNotes > MENTION_DF_CEILING
  ) {
    return false;
  }
  return true;
}

/**
 * Stable signature of a candidate set (the SYNC-14 two-tier "did the candidates
 * change?" key). Sorted so recall order can't spuriously flip the signal. Pure.
 */
export function mentionCandidateSignature(
  candidates: ReadonlyArray<NoteSearchResult>,
): string {
  return candidates
    .map((c) => c.note_id)
    .sort()
    .join(",");
}

/**
 * The EXPENSIVE half: decrypt-verify pre-fetched candidates. Applies the floor,
 * excludes notes that already wikilink the open note (`backlinks()` sources) +
 * the open note itself, then decrypts each surviving candidate body and keeps
 * the word-boundary fold matches. Split out so the two-tier host can run ONE
 * `searchNotes` and reuse its result for both the signature and the verify (no
 * double recall). NOTE: `extractFullText` is frontmatter+decoration-excluded but
 * CODE-BLOCK-INCLUDED — a fenced-code mention is a residual false positive until
 * a code-excluded projection lands (flagged; v1.x).
 */
export async function verifyMentionCandidates(
  openNoteId: string,
  openTitle: string,
  notes: ReadonlyArray<ResolverNote>,
  candidates: ReadonlyArray<NoteSearchResult>,
): Promise<UnlinkedMention[]> {
  if (foldSegment(openTitle).length < MIN_TITLE_FOLDED_CHARS) return [];

  // Exclude notes that already wikilink the open note + the open note itself —
  // BEFORE both the floor AND the decrypt: so the corpus-frequency signal
  // reflects the notes that actually have an UNLINKED mention (not the open note
  // or notes that already link it — which inflate the BM25 recall and over-
  // suppress), and excluded candidates never pay a read. `backlinks()` is the
  // in-RAM index (no decrypt).
  const linked = new Set(
    (await backlinks(openNoteId, notes)).map((g) => g.sourceUuid),
  );
  linked.add(openNoteId);
  const targets = candidates.filter((c) => !linked.has(c.note_id));

  if (!passesMentionFloor(openTitle, targets.length, notes.length)) return [];

  // Decrypt-verify the survivors concurrently (the set is BM25 top-N capped;
  // each read is fast symmetric crypto, not the unlock KDF). `Promise.all`
  // preserves BM25 rank order; a transient read failure drops just that one.
  const verified = await Promise.all(
    targets.map(async (c) => {
      try {
        const body = await noteRead(c.note_id);
        return foldedTitleMatches(extractFullText(body), openTitle)
          ? { noteId: c.note_id, title: c.title }
          : null;
      } catch {
        return null;
      }
    }),
  );
  return verified.filter((m): m is UnlinkedMention => m !== null);
}

/**
 * Find the open note's unlinked mentions: candidate-recall via `vault.search`,
 * then {@link verifyMentionCandidates}. Async (decrypts only the candidate
 * bodies). The one-shot convenience composition; the two-tier host calls
 * `searchNotes` + `verifyMentionCandidates` directly to share the recall.
 */
export async function findUnlinkedMentions(
  openNoteId: string,
  openTitle: string | null,
  notes: ReadonlyArray<ResolverNote>,
): Promise<UnlinkedMention[]> {
  if (openTitle === null) return [];
  if (foldSegment(openTitle).length < MIN_TITLE_FOLDED_CHARS) return [];
  const candidates = await searchNotes(openTitle);
  return verifyMentionCandidates(openNoteId, openTitle, notes, candidates);
}
