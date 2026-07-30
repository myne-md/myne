// Backlinks-panel view-model: shape the raw `backlinks()` groups into the
// display rows the right-sidebar panel renders. Pure (no React, no IPC) so the
// ordering / self-link / count logic is unit-testable (knowledge-graph-ux #1).

import type { ResolverNote } from "./resolveWikilink";
import type { NoteId } from "./sidebarState";
import type { BacklinkGroup, ForwardLink } from "./vaultIndices";

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

/** One outgoing-links-panel row: a target note + how many occurrences in the
 *  open note resolve to it (the Links tab's outgoing half, MYND-635 task 1). */
export type OutgoingLinkRow = {
  targetUuid: string;
  targetTitle: string | null;
  count: number;
};

/**
 * Shape `forward()` links into display rows — the outgoing-section twin of
 * {@link backlinkRows}: drop unresolved (broken) targets (nothing to open),
 * drop the open note's self-link, collapse multiple occurrences of the same
 * target into one weighted row, and sort alphabetically (untitled last).
 */
export function outgoingLinkRows(
  links: ReadonlyArray<ForwardLink>,
  notes: ReadonlyArray<ResolverNote>,
  openNoteId: NoteId | null,
): OutgoingLinkRow[] {
  const byTarget = new Map<string, OutgoingLinkRow>();
  for (const link of links) {
    if (link.resolution.status !== "resolved") continue;
    const targetUuid = link.resolution.noteUuid;
    if (targetUuid === openNoteId) continue; // self-link hidden, same as backlinkRows
    const existing = byTarget.get(targetUuid);
    if (existing) {
      existing.count += 1;
      continue;
    }
    const targetNote = notes.find((n) => n.noteUuid === targetUuid);
    byTarget.set(targetUuid, {
      targetUuid,
      targetTitle: targetNote?.title ?? null,
      count: 1,
    });
  }
  return [...byTarget.values()].sort((a, b) =>
    compareRows(
      { sourceUuid: a.targetUuid, sourceTitle: a.targetTitle, count: a.count },
      { sourceUuid: b.targetUuid, sourceTitle: b.targetTitle, count: b.count },
    ),
  );
}

/** Value-equality of two outgoing-row lists, in order — the outgoing twin of
 *  {@link backlinkRowsEqual} (SYNC-5 reference-equal bail). */
export function outgoingLinkRowsEqual(
  a: ReadonlyArray<OutgoingLinkRow>,
  b: ReadonlyArray<OutgoingLinkRow>,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.targetUuid !== y.targetUuid ||
      x.targetTitle !== y.targetTitle ||
      x.count !== y.count
    ) {
      return false;
    }
  }
  return true;
}
