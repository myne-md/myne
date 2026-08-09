// Where a line sits inside a multi-line ornament box (myne#394).
//
// THE PROBLEM THIS SOLVES
// A callout or a blockquote is one box to the reader and N sibling `<div>`s to
// CodeMirror — there is no element for the block itself, and there cannot be
// one without block-replacing the text (which would stop it being editable).
// So the ornament role lands on every line, and a theme selecting `frame: thick`
// used to draw a complete frame around EACH line: a three-line callout came out
// as three stacked cards with a seam between every line, which is not a subtle
// artefact but the first thing anyone notices.
//
// The fix is to tell the stylesheet where each line is, and let it draw the top
// edge once, the bottom edge once, and the sides on every line. That reassembles
// one box out of N line elements without changing a single line's geometry —
// which matters, because ornament may never affect layout or hit-testing (the
// paint-layer rule, `glossary.md`).
//
// A SINGLE-LINE BLOCK CARRIES NO ATTRIBUTE. That is deliberate: it is the plain
// whole-box case, it is the common one, and the stylesheet's unqualified rules
// are already correct for it. Adding `data-o-seg="solo"` would mean every
// existing rule needed an extra selector to keep working.

/** Where a line sits in its block. Absent (a lone line) means "the whole box". */
export type OrnamentSegment = "start" | "mid" | "end";

/**
 * The attributes a line of a multi-line ornament box carries.
 *
 * Returns the ornament role plus, when the block spans more than one line, the
 * segment. Callers spread this into a `Decoration.line`'s `attributes`.
 */
export function ornamentSegment(
  line: number,
  first: number,
  last: number,
): Record<string, string> {
  const attrs: Record<string, string> = { "data-ornament": "box" };
  if (first === last) return attrs; // one line — the whole box
  attrs["data-o-seg"] = line === first ? "start" : line === last ? "end" : "mid";
  return attrs;
}
