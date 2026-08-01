// Property parser for the frontmatter Properties widget.
//
// `parseSimpleProperties` walks the YAML body (between the line-1-anchored `---`
// delimiters) and extracts each SCALAR line of shape `^([key]):[ \t]*(value)$`,
// with the byte ranges the widget's in-place value/key rewrites need. Multi-line
// values, nested objects, anchors are skipped here.
//
// `parseProperties` layers list handling on top: a top-level key whose YAML
// value is a SEQUENCE (block `key:\n  - a` or flow `key: [a, b]`) is surfaced as
// a `sequence` row — the Properties widget renders its items as removable chips
// plus an add-item field — instead of the empty text input the scalar walk would
// (wrongly) show for it. Nested-map / block-scalar / anchor values still skip.
// (The old "sequences are skipped, text-only" grill addendum is superseded for
// top-level list keys; scalar rows remain plain text inputs.)

import type { FrontmatterRange } from "@myne/dialect/lezer/frontmatter";
import { readFrontmatterSequences } from "@myne/dialect/frontmatterSequence";

export type SimpleProperty = {
  key: string;
  value: string;
  /** Absolute position of the line's first byte. */
  lineFrom: number;
  /** Absolute position immediately after the line's last byte (excludes `\n`). */
  lineTo: number;
  /** Absolute position of the value's first byte (after `key:` + whitespace). */
  valueFrom: number;
  /** Absolute position immediately after the value's last byte. */
  valueTo: number;
};

const PROPERTY_LINE_RE = /^([a-zA-Z0-9_-]+):([ \t]*)(.*)$/;

export function parseSimpleProperties(
  source: string,
  range: FrontmatterRange,
): SimpleProperty[] {
  const out: SimpleProperty[] = [];
  let cursor = range.bodyStart;
  while (cursor < range.bodyEnd) {
    const nlIdx = source.indexOf("\n", cursor);
    const lineEnd =
      nlIdx === -1 ? range.bodyEnd : Math.min(nlIdx, range.bodyEnd);
    if (lineEnd <= cursor) {
      cursor = lineEnd + 1;
      continue;
    }
    const line = source.substring(cursor, lineEnd);
    const m = PROPERTY_LINE_RE.exec(line);
    if (m !== null) {
      const key = m[1]!;
      const gap = m[2]!;
      const value = m[3]!;
      const valueOffset = key.length + 1 + gap.length;
      out.push({
        key,
        value,
        lineFrom: cursor,
        lineTo: lineEnd,
        valueFrom: cursor + valueOffset,
        valueTo: cursor + valueOffset + value.length,
      });
    }
    cursor = lineEnd + 1;
  }
  return out;
}

/** A top-level frontmatter key whose value is a YAML sequence (block or flow).
 *  The Properties widget renders `items` as removable chips + an add-item field
 *  rather than a scalar text input. `items` are the decoded (quote-stripped)
 *  display values, in document order. */
export interface SequenceProperty {
  key: string;
  items: string[];
  /** Absolute position of the key line's first byte (for in-place rename). */
  lineFrom: number;
}

/** One rendered Properties row: a scalar (editable key + value text input) or a
 *  sequence (editable key + chip list). Discriminated by `kind`. */
export type PropertyRow =
  | ({ kind: "scalar" } & SimpleProperty)
  | ({ kind: "sequence" } & SequenceProperty);

/**
 * Ordered rows for the Properties widget. Scalar keys keep their byte ranges
 * (for in-place value rewrites); a top-level key whose YAML value is an array is
 * upgraded to a `sequence` row carrying its decoded items. Source order is the
 * scalar walk's order (a block sequence's `- item` lines don't produce their own
 * rows — they don't match the scalar line regex — so the key appears once).
 */
export function parseProperties(
  source: string,
  range: FrontmatterRange,
): PropertyRow[] {
  const scalars = parseSimpleProperties(source, range);
  const sequences = readFrontmatterSequences(source);
  return scalars.map((p) => {
    const items = sequences?.get(p.key);
    if (items !== undefined) {
      return { kind: "sequence", key: p.key, items, lineFrom: p.lineFrom };
    }
    return { kind: "scalar", ...p };
  });
}
