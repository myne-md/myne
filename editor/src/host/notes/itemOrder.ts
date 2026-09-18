// Shared rank + interleave + reorder for the unified sidebar order
// (`item_order`, MYND-183 + MYND-596). Consumed as SOURCE by both clients — no
// React, no IPC, no `@tauri-apps/*` (the platform-seam guard forbids it here).
//
// `item_order` is a **container-keyed map**: each key is a container — `""` for
// the tree root, or a folded folder key (`FolderNode.key`) — and each value is
// that container's children in manual order, an order-preserving heterogeneous
// sequence of note UUIDs + child folder display paths (trailing `/`). Each
// container is reordered and synced independently (MYND-596 per-container LWW),
// so a reorder in one folder never clobbers another's order.
//
// This module is the single home the desktop (`src/notes/components/*` shims)
// and mobile (`mobile/src/lib/folders.ts`) both import, replacing the two
// parallel copies (`buildItemRankMap`/`itemOrderRank`) that had begun to drift.

import { foldSegment, normalizeFolderPath } from "@myne/dialect/folderPath";
import type { FolderNode } from "./folderTree";

export type NoteId = string;

/**
 * Container-keyed manual sidebar order. Key: `""` (tree root) or a folded folder
 * key (`FolderNode.key`). Value: that container's children in manual order —
 * note UUIDs + child folder display paths, freely interleaved.
 */
export type ItemOrderMap = Readonly<Record<string, readonly string[]>>;

/**
 * UUIDv7 first-48-bit unix-ms decoder (moved here from `sidebarState` so both
 * clients share one copy). Per `protocol.md` §9.1 the file name IS the UUIDv7;
 * the leak of "approximate creation time" is already accepted, so deriving a
 * sort key + display fallback from it is free. Returns `null` for
 * non-UUIDv7-shaped input or epoch-zero results.
 */
export function uuidv7Ms(id: NoteId): number | null {
  if (id.length !== 36) return null;
  const hex = id.replace(/-/g, "");
  if (hex.length !== 32) return null;
  const ms = parseInt(hex.substring(0, 12), 16);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * First-occurrence-wins `key → index` rank builder (moved here from
 * `sidebarState`). Defensive against accidental duplicates in a sequence.
 */
export function buildRankMap<K extends string>(order: readonly K[]): Map<K, number> {
  const m = new Map<K, number>();
  for (let i = 0; i < order.length; i++) {
    const k = order[i]!;
    if (!m.has(k)) m.set(k, i);
  }
  return m;
}

/**
 * Order-key identity for an `item_order` entry: a folder entry (trailing `/`)
 * folds to its {@link FolderNode.key}; a note entry (a UUID) is kept verbatim.
 * A (rare) malformed folder path keyed by its raw form is harmless — it matches
 * no node. Folded folder paths and raw UUIDs never collide (a UUID carries no
 * trailing slash).
 */
export function itemOrderKey(entry: string): string {
  if (entry.endsWith("/")) {
    const norm = normalizeFolderPath(entry);
    return norm === null ? entry : foldSegment(norm);
  }
  return entry;
}

/**
 * The container key a container's children are ordered under in {@link
 * ItemOrderMap}: `""` for the tree root, else the container's folded folder key.
 * A `FolderNode.key` is already folded, so callers pass it straight through.
 */
export function containerKeyOf(folderKey: string | null): string {
  return folderKey ?? "";
}

/**
 * Build a single container's `key → index` rank map from its `item_order`
 * sequence (folder entries folded via {@link itemOrderKey}, note UUIDs verbatim).
 */
export function buildContainerRank(seq: readonly string[] = []): Map<string, number> {
  return buildRankMap(seq.map(itemOrderKey));
}

export type Child =
  | { kind: "folder"; node: FolderNode }
  | { kind: "note"; id: NoteId };

/**
 * The minimal note record the interleave needs — deliberately narrower than the
 * clients' `TitleRecord` so this shared module has no per-client cache
 * dependency. Only `updatedAt` is read (for the recency tiebreak).
 */
export type OrderedNoteRecord = { updatedAt?: Date | null };

/**
 * Merge a container's child folders and notes into one display-ordered list,
 * interleaved by `rank` (that container's own rank, from {@link
 * buildContainerRank}). A child present in `rank` sorts by its index; unlisted
 * children sort after all listed ones — folders before notes (by folded name),
 * then notes by recency (`updatedAt` desc, UUIDv7 fallback). Notes not in
 * `cache` are dropped (the windowing gate).
 *
 * `pinFirst` is the one key that sorts above all of that, the note the user
 * just created (myne#654). It is **transient session state, never persisted**,
 * and that is the whole design. A new note was already first among its
 * container's notes (recency desc), but "folders before notes" put it below
 * every folder, which in a vault with any structure reads as the bottom of the
 * tree. Two fixes were rejected before this one and the reasons are worth
 * keeping: writing the new note into `item_order` at index 0 makes every note
 * ever created a permanently hand-ordered entry, so that array grows without
 * bound inside the re-encrypted-on-every-write `vault.prefs` blob; and flipping
 * the folders-before-notes rule buries the folders under every loose note,
 * which is a worse version of the complaint. A single transient pin costs
 * nothing, changes no convention, and stops mattering the moment the next note
 * is created.
 *
 * **Required, not defaulted.** A default here is the arm that never fires
 * (`AGENTS.md`), and it cost something real before it was made required: the
 * drag-reorder baseline in `useFolderManagement.ts` reuses this comparator on
 * the promise that "the sidebar's render order IS the reorder baseline", and it
 * silently took the default, so a drag while a pin was live computed a sequence
 * against a list nobody was looking at. Requiring it turned that into a compile
 * error at the one site that had it wrong.
 */
export function orderContainerChildren(
  folders: readonly FolderNode[],
  noteIds: readonly NoteId[],
  cache: ReadonlyMap<NoteId, OrderedNoteRecord>,
  rank: ReadonlyMap<string, number>,
  pinFirst: string | null,
): Child[] {
  const children: Child[] = [
    ...folders.map((node) => ({ kind: "folder" as const, node })),
    ...noteIds
      .filter((id) => cache.has(id))
      .map((id) => ({ kind: "note" as const, id })),
  ];
  const MAX = Number.MAX_SAFE_INTEGER;
  const keyOf = (c: Child): string => (c.kind === "folder" ? c.node.key : c.id);
  const noteMs = (id: NoteId): number =>
    cache.get(id)?.updatedAt?.getTime() ?? uuidv7Ms(id) ?? 0;

  children.sort((a, b) => {
    // myne#654: the just-created note sorts above everything in its container,
    // folders included. It outranks the manual sequence too, deliberately ,
    // this is a transient "here is the thing you just made" pin, not an
    // ordering opinion, and it must not be silently outvoted by a container the
    // user had already arranged by hand.
    if (pinFirst !== null) {
      const pa = keyOf(a) === pinFirst;
      const pb = keyOf(b) === pinFirst;
      if (pa !== pb) return pa ? -1 : 1;
    }
    const ra = rank.get(keyOf(a)) ?? MAX;
    const rb = rank.get(keyOf(b)) ?? MAX;
    if (ra !== rb) return ra - rb;
    // Equal ranks ⇒ both unlisted (finite indices are unique per key).
    if (a.kind === "folder" && b.kind === "folder") {
      return foldSegment(a.node.name).localeCompare(foldSegment(b.node.name));
    }
    if (a.kind === "note" && b.kind === "note") {
      return noteMs(b.id) - noteMs(a.id); // recency desc
    }
    // Mixed kind, both unlisted: folders before notes.
    return a.kind === "folder" ? -1 : 1;
  });
  return children;
}

/** Where a reorder drop lands relative to the hovered row. */
export type ReorderPlace = "above" | "below";

/**
 * Compute the new order of ONE container after dropping `draggedKey` adjacent to
 * `targetKey`. `containerChildKeys` is the container's children in current
 * display order, EXCLUDING the dragged entry; an unlisted target (`targetKey`
 * absent) appends to the end. Pure and container-agnostic, so it serves BOTH the
 * flat `favorites` list and a single `item_order` container.
 */
export function reorderSequence(params: {
  containerChildKeys: readonly string[];
  draggedKey: string;
  targetKey: string;
  place: ReorderPlace;
}): string[] {
  const { containerChildKeys, draggedKey, targetKey, place } = params;
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
  return [
    ...containerChildKeys.slice(0, insertAt),
    draggedKey,
    ...containerChildKeys.slice(insertAt),
  ];
}

/**
 * Compute the next `item_order` MAP after reordering within `container`. Only
 * that container's sequence is rewritten (via {@link reorderSequence}); every
 * other container is copied through untouched, so the per-container LWW merge
 * (MYND-596) syncs this one reorder without clobbering a concurrent reorder of
 * another container on another device. An empty resulting sequence is dropped so
 * the map never carries a bare `container → []` entry.
 */
export function computeItemOrderAfterReorder(params: {
  itemOrder: ItemOrderMap;
  container: string;
  containerChildKeys: readonly string[];
  draggedKey: string;
  targetKey: string;
  place: ReorderPlace;
}): Record<string, string[]> {
  const { itemOrder, container, containerChildKeys, draggedKey, targetKey, place } =
    params;
  const newSeq = reorderSequence({
    containerChildKeys,
    draggedKey,
    targetKey,
    place,
  });
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(itemOrder)) {
    if (k !== container) out[k] = [...v];
  }
  if (newSeq.length > 0) out[container] = newSeq;
  return out;
}

/** Outcome of a reorder write — surfaced for tests + telemetry. */
export type ReorderOutcome = "aborted" | "positioned" | "moved-recency";

/**
 * Orchestrate the dual-write contract for a reorder drop, generic over the order
 * value `T` (the whole `item_order` map, or the flat `favorites` list). `folder:`
 * (via `moveFirst`) is the atomic source of truth for a note's container; the
 * order position is best-effort.
 *
 * - `moveFirst` (cross-container only; `null` for a same-container reorder) runs
 *   FIRST. Its failure ABORTS the whole op — no optimistic update, no persist —
 *   so the note stays exactly where it was.
 * - On success the next order is computed (`computeNext`, read AFTER the move so
 *   it sees the note's new container), applied optimistically (`setOrder`), then
 *   persisted. A persist failure REVERTS the optimistic order to `prevOrder`, so
 *   the moved note falls back to the recency sort — position is soft, never data
 *   loss. The 64 KiB `vault.prefs` cap surfaces here as a persist rejection.
 */
export async function applyReorderWrite<T>(opts: {
  moveFirst: (() => Promise<void>) | null;
  computeNext: () => T;
  prevOrder: T;
  setOrder: (order: T) => void;
  persist: (order: T) => Promise<void>;
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
    opts.setOrder(opts.prevOrder);
    return "moved-recency";
  }
}
