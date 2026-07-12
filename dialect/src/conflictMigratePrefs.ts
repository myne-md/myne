// Prefs uuid-migration for the "take theirs" conflict action (MYND-452).
//
// When a note conflict is resolved by "Use this version" (take theirs), the
// remote conflict copy is promoted to the surviving note and the local original
// is sent to trash. The surviving note carries the copy's UUID, so any uuid-keyed
// prefs membership the original held — its `favorites` star and its manual
// `item_order` position — would otherwise be left pointing at the now-trashed
// original. These pure helpers move that membership from the original's UUID onto
// the copy's, preserving position; the caller (`applyConflictVersion`) persists
// the result via `setFavorites` / `setItemOrder`.
//
// `item_order` is heterogeneous (note UUIDs interleaved with trailing-slash
// folder paths); only note-UUID entries ever match, so folder paths pass through
// untouched.

/** A single uuid-keyed sequence with a note UUID swapped from→to, preserving the
 *  original's slot. A pre-existing `to` entry is dropped so the result never
 *  duplicates the target. Returns the input order verbatim (copied) when `from`
 *  is absent — the no-op case. */
function swapInSequence(
  list: readonly string[],
  from: string,
  to: string,
): { list: string[]; changed: boolean } {
  if (!list.includes(from)) return { list: [...list], changed: false };
  const out: string[] = [];
  for (const el of list) {
    if (el === from) out.push(to); // migrated slot holds the target
    else if (el === to) continue; // drop any pre-existing target (no duplicate)
    else out.push(el);
  }
  return { list: out, changed: true };
}

/** The favorites set + item_order sequence to migrate. */
export interface MigratablePrefs {
  favorites: readonly string[];
  itemOrder: readonly string[];
}

/** The migrated prefs plus whether anything actually changed (so the caller can
 *  skip the disk write entirely on a no-op). */
export interface PrefsMigrationResult {
  favorites: string[];
  itemOrder: string[];
  changed: boolean;
}

/**
 * Move a note's uuid-keyed prefs membership from `fromUuid` to `toUuid` — used by
 * take-theirs to carry the original note's favorite status and manual sidebar
 * position onto the promoted conflict copy. Position-preserving; no-op (and
 * `changed: false`) when `fromUuid` appears in neither list.
 */
export function migrateNoteUuidInPrefs(
  prefs: MigratablePrefs,
  fromUuid: string,
  toUuid: string,
): PrefsMigrationResult {
  const fav = swapInSequence(prefs.favorites, fromUuid, toUuid);
  const ord = swapInSequence(prefs.itemOrder, fromUuid, toUuid);
  return {
    favorites: fav.list,
    itemOrder: ord.list,
    changed: fav.changed || ord.changed,
  };
}
