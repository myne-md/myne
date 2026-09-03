// `backfillDeliberateFolders`: register an EXISTING vault's folders once, on
// the first load after unlock (myne-md/myne#613 task 6). The mobile twin of
// `src/notes/folderBackfill.ts`.
//
// Same rule, same four properties, and the twin's header is the long form of
// why each one is there. The reasons this is a separate file rather than shared
// code: mobile carries a note's folder in its BODY (there is no `TitleRecord`
// here), and the boot path is a different component in a different tree. What is
// shared is the thing that has to be: the ADD-verb payload and the byte budget,
// both of which live in the core.
//
// The four properties, restated because a reader of this file will not have the
// other one open:
//
//   1. It writes only `vault.prefs`. No `.myn` byte is written for it.
//   2. A vault whose folders are already registered writes NOTHING. The caller
//      passes the registered set and the diff is taken here, so a second unlock
//      issues no IPC rather than a write whose effect is empty (an empty-effect
//      write still re-encrypts the blob and bumps the nonce).
//   3. Idempotence is keyed on the data, not on a module-scope latch that would
//      have to be reset on lock and on vault switch.
//   4. A back-filled folder never undoes a deletion: the write states
//      `addUnlessRemoved`, so the core skips an entry that is absent from the
//      stored set AND carries a removal clock. This walks LIVE notes, which is a
//      state a peer's deletion has not reached yet (notes and prefs travel
//      separately), so without that verb this device could back-fill a folder A
//      already deleted and hand it a NEWER clock, putting it back on every
//      device permanently. Running on the unlock path only was claimed to bound
//      that; it does not, it only narrows the window. Once per session is still
//      right for the write cost, but it is not the guard.

import { folderKey } from "../dialect/folderPath";
import { isLiveNote, readNoteFlags, readNoteFolder } from "./note-organize";
import { mutateDeliberateFolders } from "./prefs";

/**
 * Every folder the LIVE notes in `bodies` prove that `registered` does not
 * already hold, deduplicated, in first-seen order.
 *
 * "Live" is `isLiveNote`, the same predicate the folder tree is built from, so
 * this registers exactly the folders the user can currently see. A folder whose
 * notes are all in Trash is NOT registered: the user emptied it, the tree does
 * not show it, and registering it here would resurrect a folder as a side effect
 * of unlocking. Archived notes fall out the same way and for the same reason.
 *
 * The comparison is by canonical folder KEY, the identity the core stores under,
 * so a vault holding `Projects/` is not asked to add `projects/` on every unlock
 * for the rest of its life.
 */
export function foldersToBackfill(
  bodies: Iterable<string>,
  registered: readonly string[],
): string[] {
  const held = new Set(registered.map(folderKey));
  const out: string[] = [];
  for (const body of bodies) {
    const folder = readNoteFolder(body);
    if (folder === null) continue;
    if (!isLiveNote(readNoteFlags(body))) continue;
    const key = folderKey(folder);
    if (held.has(key)) continue;
    held.add(key);
    out.push(folder);
  }
  return out;
}

/**
 * Register the folders `bodies` prove and `registered` does not hold yet.
 *
 * Returns how many additions the reserved byte budget refused, which is zero in
 * every ordinary case and zero when there was nothing to do. Never rejects: a
 * vault whose folders could not be registered behaves as it did before this
 * feature, which is strictly better than an unlock that fails, and the next
 * unlock retries since nothing records that this ran.
 */
export async function backfillDeliberateFolders(
  bodies: Iterable<string>,
  registered: readonly string[],
): Promise<number> {
  const folders = foldersToBackfill(bodies, registered);
  if (folders.length === 0) return 0;
  try {
    // `addUnlessRemoved`, not `add`: this is a REPAIR of a registration the
    // old at-fill rule never made, not a user filing a note. The core skips
    // any entry whose removal is on record, so a peer's folder delete is
    // never undone by this device happening to still hold the notes.
    return await mutateDeliberateFolders({ addUnlessRemoved: folders });
  } catch {
    // The vault stays usable and the next unlock tries again. A partial write is
    // not possible: the core applies the whole mutation under the prefs write
    // mutex, so this either landed or did not.
    return 0;
  }
}
