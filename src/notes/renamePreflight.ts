// Pre-flight open-dirty gate for rename auto-update (WL-8, SYNC-15). Before a
// title-rename stages any inbound-note rewrite, the inbound set is partitioned:
// a note that is open AND dirty in a pane must be flushed / buffer-written
// first (writing it to disk would clobber the unsaved edits — the silent
// data-loss SYNC-15 forbids); a closed-or-clean note is safe to disk-rewrite.
// The partition runs BEFORE the transaction stages anything, preserving §8.3's
// "all-or-nothing, vault left pre-rename" promise. Pure — open/dirty state is
// queried from the workspace/autosave layer and passed in.

export interface InboundNote {
  readonly noteId: string;
  readonly isOpen: boolean;
  readonly isDirty: boolean;
}

export interface InboundPartition {
  /** Safe to disk-rewrite (closed, or open but clean). */
  readonly closed: InboundNote[];
  /** Open AND dirty — must be flushed / buffer-written before staging. */
  readonly openDirty: InboundNote[];
}

/** Partition the inbound set; order preserved within each bucket. */
export function partitionInbound(
  inbound: readonly InboundNote[],
): InboundPartition {
  const closed: InboundNote[] = [];
  const openDirty: InboundNote[] = [];
  for (const n of inbound) {
    if (n.isOpen && n.isDirty) openDirty.push(n);
    else closed.push(n);
  }
  return { closed, openDirty };
}
