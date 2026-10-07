// Meeting AI: the transcript chunker (meeting-ai task 1).
//
// A long transcript is split for the map step. Two properties are deliberate.
// The chunks are LOSSLESS: each is a contiguous run of whole tokens and the
// concatenation with no overlap reconstructs the transcript exactly, so no
// character is dropped. And no chunk SPLITS A WORD: a cut mid-word would
// corrupt the summary of both chunks it straddles, so the splitter packs whole
// tokens (a word or a run of whitespace) and never breaks one, which also means
// a single over-budget token becomes its own chunk rather than being cut.
//
// `overlap` (default 0) repeats the trailing whole tokens of one chunk at the
// head of the next, so a thought spanning a boundary is present in both. It
// duplicates those tokens by design; coverage of every character is still
// guaranteed.

export interface ChunkOptions {
  /** Maximum code points per chunk. A single token larger than this is not cut. */
  budget: number;
  /** Whole tokens of overlap between consecutive chunks. Default 0. */
  overlap?: number;
}

export interface TranscriptChunk {
  text: string;
  /** Position in the ordered chunk list. */
  index: number;
}

interface Token {
  text: string;
  isSpace: boolean;
}

/** Split into maximal runs of whitespace and non-whitespace (whole words). */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let buf = "";
  let bufIsSpace = false;
  for (const ch of text) {
    const isSpace = /\s/.test(ch);
    if (buf.length === 0) {
      buf = ch;
      bufIsSpace = isSpace;
    } else if (isSpace === bufIsSpace) {
      buf += ch;
    } else {
      tokens.push({ text: buf, isSpace: bufIsSpace });
      buf = ch;
      bufIsSpace = isSpace;
    }
  }
  if (buf.length > 0) tokens.push({ text: buf, isSpace: bufIsSpace });
  return tokens;
}

/** Split `text` into ordered chunks at `opts.budget` code points. */
export function chunkTranscript(
  text: string,
  opts: ChunkOptions,
): TranscriptChunk[] {
  const budget = Math.max(1, Math.floor(opts.budget));
  // Cap the overlap below half the budget. An overlap at or above the budget
  // makes the next chunk start almost where the last one did, so the splitter
  // advances one token per iteration and emits O(tokens) near-duplicate chunks;
  // the production default (6000/200) never hits it, but a small test budget
  // with the default overlap did.
  const overlap = Math.min(
    Math.max(0, Math.floor(opts.overlap ?? 0)),
    Math.floor(budget / 2),
  );
  if (text.length === 0) return [];

  const tokens = tokenize(text);
  const chunks: TranscriptChunk[] = [];
  let i = 0;
  while (i < tokens.length) {
    const start = i;
    let end = i;
    let len = 0;
    // Always take at least one token, so an over-budget token is emitted whole.
    while (end < tokens.length) {
      const size = tokens[end]!.text.length;
      if (end > start && len + size > budget) break;
      len += size;
      end += 1;
    }
    chunks.push({
      text: tokens
        .slice(start, end)
        .map((t) => t.text)
        .join(""),
      index: chunks.length,
    });
    if (end >= tokens.length) break;

    // The next chunk starts at `end`, backed up by whole trailing tokens while
    // they fit in `overlap`, but never so far that no token advances.
    let next = end;
    if (overlap > 0) {
      let acc = 0;
      while (next > start + 1 && acc + tokens[next - 1]!.text.length <= overlap) {
        acc += tokens[next - 1]!.text.length;
        next -= 1;
      }
    }
    i = Math.max(next, start + 1);
  }
  return chunks;
}
