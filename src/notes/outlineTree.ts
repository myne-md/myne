// Outline tree shape helpers (outline collapsible nodes). The Outline tab renders
// a FLAT, document-order list of headings whose only hierarchy signal is the
// per-heading `level` (1..6). Folding a heading hides every DEEPER heading that
// follows it until the next same-or-higher heading — the same "a section subsumes
// its subtree" boundary the dialect's `headingSections.sectionTo` encodes.
//
// This module is the PURE derivation of that structure (no React, no DOM) so the
// visibility + parent math is unit-testable in isolation and the component stays
// a thin renderer.

/** Per-row derived metadata for one heading in document order. */
export interface OutlineRowMeta {
  /** True when the NEXT heading is deeper — i.e. this heading can be folded. */
  readonly hasChildren: boolean;
  /** True when a collapsed ancestor is hiding this row. */
  readonly hidden: boolean;
  /**
   * Index of the nearest collapsed ancestor hiding this row, or -1 when visible.
   * Lets a consumer redirect (e.g. the active-heading highlight) onto the visible
   * collapsed parent when the real target is folded away.
   */
  readonly collapsedUnder: number;
}

/**
 * Derive {@link OutlineRowMeta} for each heading from the flat `levels` list and
 * the set of collapsed row indices. Single forward pass, O(n):
 *
 * - `hasChildren` — the next heading is deeper.
 * - a collapsed PARENT stays visible; every deeper heading in its section is
 *   `hidden` until a same-or-higher heading ends the section. Nesting works
 *   because the outermost collapse's floor persists across any inner collapsed
 *   (already-hidden) parents.
 */
export function computeOutlineMeta(
  levels: readonly number[],
  collapsed: ReadonlySet<number>,
): OutlineRowMeta[] {
  const meta: OutlineRowMeta[] = [];
  let hiding = false;
  let hidingLevel = 0;
  let hidingRoot = -1;
  for (let i = 0; i < levels.length; i++) {
    const level = levels[i]!;
    const hasChildren = i + 1 < levels.length && levels[i + 1]! > level;
    let hidden = false;
    let collapsedUnder = -1;
    if (hiding) {
      if (level > hidingLevel) {
        hidden = true;
        collapsedUnder = hidingRoot;
      } else {
        // A same-or-higher heading ends the collapsed section.
        hiding = false;
      }
    }
    if (!hidden && hasChildren && collapsed.has(i)) {
      hiding = true;
      hidingLevel = level;
      hidingRoot = i;
    }
    meta.push({ hasChildren, hidden, collapsedUnder });
  }
  return meta;
}
