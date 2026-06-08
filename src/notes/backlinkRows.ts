// Backlinks-panel view-model: shape the raw `backlinks()` groups into the
// display rows the right-sidebar panel renders. Pure (no React, no IPC) so the
// ordering / self-link / count logic is unit-testable (knowledge-graph-ux #1).

import type { NoteId } from "./sidebarState";
import type { BacklinkGroup } from "./vaultIndices";

/** One backlinks-panel row: a source note + how many times it links here. */
export type BacklinkRow = {
  sourceUuid: string;
  sourceTitle: string | null;
  count: number;
};

/**
 * Shape `backlinks()` groups into display rows:
 * - drop the open note's self-link (self-links are query-inclusive by contract;
 *   the panel hides them — Obsidian default),
 * - carry the occurrence count,
 * - sort alphabetically by source title, untitled (null) sources last.
 */
export function backlinkRows(
  groups: ReadonlyArray<BacklinkGroup>,
  openNoteId: NoteId | null,
): BacklinkRow[] {
  return groups
    .filter((g) => g.sourceUuid !== openNoteId)
    .map((g) => ({
      sourceUuid: g.sourceUuid,
      sourceTitle: g.sourceTitle,
      count: g.occurrences.length,
    }))
    .sort(compareRows);
}

function compareRows(a: BacklinkRow, b: BacklinkRow): number {
  if (a.sourceTitle === null && b.sourceTitle === null) return 0;
  if (a.sourceTitle === null) return 1; // untitled last
  if (b.sourceTitle === null) return -1;
  return a.sourceTitle.localeCompare(b.sourceTitle);
}

/**
 * Value-equality of two row lists, in order. The backlinks panel keeps the
 * previous reference when this holds so a re-query that produced an unchanged
 * result bails the React render (SYNC-5 condition 2).
 */
export function backlinkRowsEqual(
  a: ReadonlyArray<BacklinkRow>,
  b: ReadonlyArray<BacklinkRow>,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.sourceUuid !== y.sourceUuid ||
      x.sourceTitle !== y.sourceTitle ||
      x.count !== y.count
    ) {
      return false;
    }
  }
  return true;
}
