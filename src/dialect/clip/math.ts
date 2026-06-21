// Canonical-D1 math emission for the clip serializer (capture-extraction
// task 5; §3.2 inline `$`-disambiguation + §5 "faithful … math").
//
// Two shapes, two seams:
//
//   - INLINE `$…$` is the `InlineMath` Lezer node (src/dialect/lezer/math.ts).
//     A parsed InlineMath has tokenizer-legal endpoints by construction, but
//     the clip serializer is DEFENSIVE: it re-checks the §3.2 rules on the
//     mark-to-mark content before re-emitting `$content$`, and SAFE-DEGRADES to
//     inert literal text (escaped `$`) when the content cannot be emitted as a
//     legal span — never a half-open `$` the reader would mis-parse as math.
//
//   - BLOCK `$$…$$` is NOT a parser node (it is a decoration range in the
//     editor; math.ts). It is detected here with the SAME regex + code-range
//     exclusion `emitNoteHtml.ts::findBlockMath` uses, and re-emitted as the
//     canonical multi-line `$$\n<latex>\n$$` block. The code ranges that gate
//     the scan are the task-4 code constructs (InlineCode / CodeBlock /
//     FencedCode) — a `$$` inside a code zone is content, not block math.
//
// The §3.2 inline rules (the correctness contract — Myne's own tokenizer must
// parse the emit back identically):
//   - the opening `$` must NOT be followed by whitespace or a digit,
//   - the closing `$` must NOT be preceded by whitespace,
//   - a `$…$` run must NOT cross a line break,
//   - and (by construction of `$content$`) the content must not contain a bare
//     line-terminating `$` that closes early — a lone interior `$` would.

import type { SyntaxNode } from "@lezer/common";

// === Byte ranges (code-zone exclusion) =====================================

export interface ByteRange {
  readonly from: number;
  readonly to: number;
}

/**
 * Walk the tree for the task-4 code constructs and collect their byte ranges,
 * mirroring `emitNoteHtml.ts::scanTree`'s `codeRanges`. A `$$…$$` run whose
 * delimiters fall inside one of these ranges is code content, not block math,
 * and is excluded from the block-math scan.
 */
export function collectCodeRanges(top: SyntaxNode): ByteRange[] {
  const ranges: ByteRange[] = [];
  top.cursor().iterate((node) => {
    switch (node.name) {
      case "InlineCode":
      case "CodeBlock":
      case "FencedCode":
        ranges.push({ from: node.from, to: node.to });
        return false;
      default:
        return undefined;
    }
  });
  return ranges;
}

function inAnyRange(ranges: readonly ByteRange[], pos: number): boolean {
  return ranges.some((r) => pos >= r.from && pos < r.to);
}

// === Block `$$…$$` detection (findBlockMath parity) ========================

export interface BlockMathRange extends ByteRange {
  readonly latex: string;
}

// Block `$$…$$` is a decoration in the editor, not a parser node (math.ts) —
// the SAME regex `emitNoteHtml.ts::findBlockMath` uses, with code ranges
// excluded so a `$$` inside a fence/span is never treated as block math.
const BLOCK_MATH_RE = /\$\$([\s\S]*?)\$\$/g;

/**
 * Find every `$$…$$` block-math range in `src`, excluding ones whose delimiters
 * sit inside a code range. Byte-for-byte the `findBlockMath` approach the HTML
 * emitter pins (REUSED, not re-derived) — same regex, same code-exclusion.
 */
export function findBlockMath(
  src: string,
  codeRanges: readonly ByteRange[],
): BlockMathRange[] {
  const out: BlockMathRange[] = [];
  BLOCK_MATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_MATH_RE.exec(src)) !== null) {
    const from = m.index;
    const to = m.index + m[0].length;
    if (inAnyRange(codeRanges, from) || inAnyRange(codeRanges, to - 1)) {
      continue;
    }
    out.push({ from, to, latex: m[1] ?? "" });
  }
  return out;
}

/**
 * The block-math range a block node is ENTIRELY (modulo surrounding
 * whitespace) — used to decide a paragraph is a standalone block-math block
 * the serializer re-emits as canonical `$$\n…\n$$`. A paragraph that merely
 * CONTAINS a `$$` run alongside prose is left to the normal inline walk (the
 * `$$` survives as literal bytes since it is not a parser node).
 */
export function standaloneBlockMath(
  src: string,
  node: SyntaxNode,
  blockMath: readonly BlockMathRange[],
): BlockMathRange | null {
  for (const range of blockMath) {
    const before = src.slice(node.from, Math.max(node.from, range.from));
    const after = src.slice(Math.min(node.to, range.to), node.to);
    if (
      range.from >= node.from &&
      range.to <= node.to &&
      before.trim() === "" &&
      after.trim() === ""
    ) {
      return range;
    }
  }
  return null;
}

/** Emit a block-math range as the canonical multi-line `$$\n<latex>\n$$` form.
 *  The LaTeX is trimmed of its surrounding whitespace (the `$$ … $$` padding /
 *  newlines) so the canonical block is stable under a second pass. */
export function emitBlockMath(range: BlockMathRange): string {
  const latex = range.latex.trim();
  return latex === "" ? "$$\n$$" : `$$\n${latex}\n$$`;
}

// === Inline `$…$` legality + emit ==========================================

function isWhitespace(ch: string): boolean {
  return /\s/u.test(ch);
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

/**
 * Is `content` emittable as a tokenizer-legal `$content$` inline span? Enforces
 * the §3.2 rules against the emit so Myne's own `$`-tokenizer re-parses it to
 * an identical `InlineMath`:
 *   - non-empty,
 *   - first char neither whitespace nor a digit (opener not currency/space),
 *   - last char not whitespace (closer not space-preceded),
 *   - no line break (single-line only),
 *   - no interior bare `$` (which would close the span early or open a `$$`).
 */
export function isLegalInlineMath(content: string): boolean {
  if (content.length === 0) return false;
  if (isWhitespace(content[0]!) || isDigit(content[0]!)) return false;
  if (isWhitespace(content[content.length - 1]!)) return false;
  if (/[\n\r]/u.test(content)) return false;
  if (content.includes("$")) return false;
  return true;
}

/**
 * Emit an `InlineMath` node's content as canonical D1 inline math, or
 * safe-degrade to inert literal text when it cannot be made tokenizer-legal.
 *
 * The legal path emits `$content$` (verbatim LaTeX — a math zone, never
 * whitespace-collapsed or escaped). The degrade path emits the content as
 * literal text with every `$` backslash-escaped, so the bytes re-parse as text
 * (Escape nodes) and NEVER as a `$…$` span Myne's reader would mis-render.
 */
export function emitInlineMath(content: string): string {
  if (isLegalInlineMath(content)) return `$${content}$`;
  return escapeAsLiteral(content);
}

/** Render `content` as inert literal text: escape every `$` so no opening or
 *  closing math delimiter survives in the emitted bytes. */
function escapeAsLiteral(content: string): string {
  return content.replace(/\$/gu, "\\$");
}
