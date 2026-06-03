// Pure order-computation + dual-write orchestration for the unified
// `item_order` sidebar sequence (MYND-183). No React, no IPC — injected deps
// keep both halves unit-testable.
//
// `item_order` is a flat, heterogeneous, sibling-local sequence: note UUIDs +
// canonical trailing-slash folder paths. Reordering is sibling-local — a
// container's children are removed from the global list and the new sibling
// sequence re-appended, so other containers' relative order is untouched (each
// container reads only its own children's indices).

import { foldSegment, normalizeFolderPath } from "../../dialect/folderPath";

/** Where a reorder drop lands relative to the hovered row (matches
 *  `useFolderManagement`'s `ReorderPlace`; inlined to avoid a circular import). */
type ReorderPlace = "above" | "below";

/**
 * Order-key identity for an `item_order` entry: a folder entry (trailing `/`)
 * folds to its `FolderNode.key`; a note entry (UUID) is itself. Mirrors
 * `buildItemRankMap` so display-form folder-path variants collapse on compare.
 */
export function itemOrderKey(entry: string): string {
  if (entry.endsWith("/")) {
    const norm = normalizeFolderPath(entry);
    return norm === null ? entry : foldSegment(norm);
  }
  return entry;
}

/**
 * Compute the next global `item_order` after dropping `draggedKey` adjacent to
 * `targetKey` within a container. `containerChildKeys` is the container's
 * children in current display order, EXCLUDING the dragged entry. The container's
 * children are stripped from the global list and the new sibling sequence is
 * re-appended; an unlisted target (`targetKey` absent) appends to the end.
 */
export function computeItemOrderAfterReorder(params: {
  itemOrder: readonly string[];
  containerChildKeys: readonly string[];
  draggedKey: string;
  targetKey: string;
  place: ReorderPlace;
}): string[] {
  const { itemOrder, containerChildKeys, draggedKey, targetKey, place } = params;
  const targetFold = itemOrderKey(targetKey);
  const targetIdx = containerChildKeys.findIndex(
    (k) => itemOrderKey(k) === targetFold,
  );
  const insertAt =
    targetIdx === -1
      ? containerChildKeys.length
      : place === "above"
        ? targetIdx
        : targetIdx + 1;
  const newSeq = [
    ...containerChildKeys.slice(0, insertAt),
    draggedKey,
    ...containerChildKeys.slice(insertAt),
  ];
  const inContainer = new Set(newSeq.map(itemOrderKey));
  const rest = itemOrder.filter((e) => !inContainer.has(itemOrderKey(e)));
  return [...rest, ...newSeq];
}

/** Outcome of a reorder write — surfaced for tests + telemetry. */
export type ReorderOutcome = "aborted" | "positioned" | "moved-recency";

/**
 * Orchestrate the dual-write contract for a reorder drop. `folder:` (via
 * `moveFirst`) is the atomic source of truth for a note's container; the
 * `item_order` position is best-effort.
 *
 * - `moveFirst` (cross-container only; `null` for same-container reorder) runs
 *   FIRST. Its failure ABORTS the whole op — no optimistic update, no prefs
 *   write — so the note stays exactly where it was.
 * - On success, the new order is computed (`computeNext`, read AFTER the move so
 *   it sees the note's new container), applied optimistically (`setOrder`), then
 *   persisted. A persist failure REVERTS the optimistic order to `prevOrder`, so
 *   the moved note falls back to the recency sort — position is soft, never data
 *   loss. The 64 KiB `vault.prefs` cap surfaces here as a persist rejection, so
 *   an over-cap reorder degrades the same way.
 */
export async function applyReorderWrite(opts: {
  moveFirst: (() => Promise<void>) | null;
  computeNext: () => string[];
  prevOrder: readonly string[];
  setOrder: (order: string[]) => void;
  persist: (order: string[]) => Promise<void>;
}): Promise<ReorderOutcome> {
  if (opts.moveFirst !== null) {
    try {
      await opts.moveFirst();
    } catch {
      return "aborted";
    }
  }
  const next = opts.computeNext();
  opts.setOrder(next);
  try {
    await opts.persist(next);
    return "positioned";
  } catch {
    opts.setOrder([...opts.prevOrder]);
    return "moved-recency";
  }
}
