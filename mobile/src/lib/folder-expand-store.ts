// The sidebar folder-expand set (MYND-561) — a module-level store, not React
// state in `EditorFlow`.
//
// WHY a store rather than `useState`: desktop's MYND-455 replaced exactly that
// shape (a local mirror synced by two effects and two mount-order refs) because
// it carried two bugs — a toggle that never marked the blob dirty (so the flush
// wrote a stale set), and a toggle racing the async restore, which silently
// destroyed the persisted set. Making ONE value the single owner turns both into
// structural impossibilities: the restore just replaces the value, the toggle
// just edits it, and the flush reads the same value both wrote. There is no
// initial empty local set that can clobber a restore, and no mount ordering to
// get right.
//
// Semantics are desktop's, deliberately (`workspaceState.ts` `expandedFolders`):
// the set holds the OPEN folders, keyed by FOLDED folder identity (`folderKey`,
// the MYND-562 cross-client key) — so a folder is expanded iff its key is
// present, and an absent/empty set means every folder is collapsed. Mobile
// previously tracked the complement (`collapsedFolders`, empty = all expanded),
// which cannot round-trip through the shared container: the container omits the
// field when empty, so "user collapsed everything" and "nothing persisted yet"
// would be the same bytes and the collapse-all would be lost on every restart.
// Matching desktop's polarity removes that ambiguity instead of encoding around
// it — at the cost of a fresh vault now opening collapsed on mobile too, which
// is the same first-run behaviour desktop has always had.

import { useSyncExternalStore } from "react";

/** Folded folder keys (`folderKey(path)`) whose subtree is OPEN. */
let expanded: ReadonlySet<string> = new Set();
/** True once a toggle has changed the set since the last successful flush —
 *  the flush's gate, so a session that never touched a folder never rewrites
 *  `vault.workspace` (and so never churns its mtime). */
let dirty = false;

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React binding — re-renders the tree on every set change. The snapshot is the
 *  live `Set` REFERENCE (replaced, never mutated in place), so identity
 *  comparison is a correct change signal. */
export function useExpandedFolders(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => expanded);
}

/** Imperative read — for the flush path, which must never see a stale snapshot. */
export function peekExpandedFolders(): ReadonlySet<string> {
  return expanded;
}

export function isExpandDirty(): boolean {
  return dirty;
}

/** Toggle one folder open/closed. Marks the set dirty. */
export function toggleFolderExpanded(key: string): void {
  const next = new Set(expanded);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expanded = next;
  dirty = true;
  emit();
}

/**
 * Seed the set from a restored descriptor. NOT dirty — a restore reflects what
 * is already on disk, so it must not by itself schedule a write back.
 *
 * Unlike desktop there is no "did the user toggle first?" guard here, and none is
 * needed: hydration happens once per unlock session and a toggle before it lands
 * would simply be overwritten by disk truth, which is the same outcome as a
 * cold start. The set is the single owner either way.
 */
export function hydrateExpandedFolders(keys: readonly string[]): void {
  expanded = new Set(keys);
  dirty = false;
  emit();
}

/** Mark the current set as committed (called after a successful flush). */
export function markExpandFlushed(): void {
  dirty = false;
}

/**
 * Drop the set on vault lock / auto-lock / vault switch. Vault A's open folders
 * must never seed vault B's sidebar — the AS3 no-cross-vault-leak rule the
 * graph-layout cache follows for the same reason. Clears `dirty` too, so a
 * post-lock flush can never write A's set into B's `vault.workspace`.
 */
export function resetExpandedFoldersOnLock(): void {
  expanded = new Set();
  dirty = false;
  emit();
}
