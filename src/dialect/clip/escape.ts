// Canonical-D1 plain-text escaping for the clip serializer (§5).
//
// A clip is AUTHORED canonical-D1 content (SYNC-7), so a plain text run is
// re-emitted with whatever escaping keeps it INERT — i.e. the emitted bytes
// must re-parse as the same plain text, never as an accidental construct.
//
// In this first slice the walker only emits PLAIN inline text (no emphasis /
// link / code construct arms yet — those are task 2+). The parser has already
// decided which bytes are plain text vs. a recognized construct; a text run
// that the parser left un-tokenized is, by definition, already inert in its
// original position, so re-emitting it verbatim within the same paragraph
// position round-trips. This module is the single seam where, as later slices
// add construct arms, plain-text-between-constructs escaping is applied — kept
// deliberately minimal here and extended construct-by-construct.

/**
 * Collapse a paragraph's internal whitespace to the canonical authored shape:
 * runs of spaces/tabs collapse to a single space and hard-wrapped soft line
 * breaks (a lone `\n` inside a paragraph) join to a single space. Leading and
 * trailing whitespace is trimmed. This is a normalization a clip is allowed to
 * make (authored content, not a C1 import) and it keeps the emitted paragraph a
 * single canonical line that re-parses to one `Paragraph` node.
 *
 * Inline-code spans (backtick-delimited, already canonicalized upstream) are a
 * code zone (§3.7.5) — their whitespace is CONTENT and must survive byte-exact.
 * They are carved out of the collapse: only the prose BETWEEN spans is
 * normalized, the spans themselves pass through verbatim. (The whole-string
 * leading/trailing trim still applies to the prose at the ends.)
 */
export function normalizeParagraphWhitespace(text: string): string {
  const parts = splitInlineCodeSpans(text);
  let out = "";
  for (const part of parts) {
    out += part.code ? part.text : part.text.replace(/\s+/gu, " ");
  }
  return out.trim();
}

interface Segment {
  readonly text: string;
  readonly code: boolean;
}

/**
 * Tokenize `text` into alternating prose / inline-code segments. An inline-code
 * span opens on a run of N backticks and closes on the next run of EXACTLY N
 * backticks (CommonMark rule); an unclosed run is treated as prose. Operates on
 * already-emitted canonical bytes — the serializer is the only producer, so the
 * delimiters are well-formed.
 */
function splitInlineCodeSpans(text: string): Segment[] {
  const segments: Segment[] = [];
  let prose = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "`") {
      prose += text[i];
      i++;
      continue;
    }
    // A backtick run: find its length, then the matching closing run.
    let open = i;
    while (open < text.length && text[open] === "`") open++;
    const runLen = open - i;
    const close = findClosingRun(text, open, runLen);
    if (close === -1) {
      // No matching closer — the run is literal prose, not a code delimiter.
      prose += text.slice(i, open);
      i = open;
      continue;
    }
    if (prose !== "") {
      segments.push({ text: prose, code: false });
      prose = "";
    }
    segments.push({ text: text.slice(i, close + runLen), code: true });
    i = close + runLen;
  }
  if (prose !== "") segments.push({ text: prose, code: false });
  return segments;
}

/** Index of a closing run of EXACTLY `runLen` backticks at or after `from`, or
 *  -1 if none exists. */
function findClosingRun(text: string, from: number, runLen: number): number {
  let i = from;
  while (i < text.length) {
    if (text[i] !== "`") {
      i++;
      continue;
    }
    let end = i;
    while (end < text.length && text[end] === "`") end++;
    if (end - i === runLen) return i;
    i = end;
  }
  return -1;
}
