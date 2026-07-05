// Simple-property parser for the frontmatter Properties widget.
//
// Walks the YAML body (between the line-1-anchored `---` delimiters) and
// extracts each line of shape `^([key]):[ \t]*(value)$`. Multi-line values,
// nested objects, sequences, anchors — all skipped: those land in the
// "raw YAML" escape hatch, not the Properties widget.
//
// Per the v1 grill addendum, the Properties UI ships **text-only** —
// every value is rendered as a plain text input, no date picker / list
// editor / link picker. The UI displays the key + its current literal
// value; commit on blur or Enter rewrites the value range in the source.

import type { FrontmatterRange } from "@myne/dialect/lezer/frontmatter";

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
