// `backfillDeliberateFolders`: register an EXISTING vault's folders once, on
// the first sidebar load after unlock (myne-md/myne#613 task 6).
//
// At-fill registers a folder the moment a note LANDS in it. In a vault created
// before that rule, every folder already has its notes and nothing ever lands
// again, so a settled folder is never registered and still vanishes the moment
// it is emptied. That leaves the defect in place for exactly the folders a user
// has had longest, which is where the original report came from.
//
// Four properties this deliberately has:
//
//   1. **It writes only `vault.prefs`.** Not one `.myn` byte is read for it and
//      none is written. This is not the migration class that has lost data in
//      this repository before (`decisions.md` 2026-06-11), and it is not one
//      because it never touches note storage.
//   2. **A vault whose folders are already registered writes NOTHING.** The
//      caller passes the registered set and the diff is taken here, so the
//      second unlock issues no IPC at all rather than a write whose effect is
//      empty. An empty-effect write is not free: it re-encrypts the whole
//      `vault.prefs` blob and bumps the nonce, which every mounted `usePrefs`
//      then re-reads.
//   3. **Idempotence is keyed on the DATA, not on a session latch.** There is no
//      module-scope boolean to reset on lock or on a vault switch, which would
//      have been a store outliving the vault it belongs to: the class
//      `check-frontend-lock-teardown.mjs` exists to catch.
//   4. **A back-filled folder never undoes a deletion.** The write states
//      `addUnlessRemoved`, so the core skips any entry that is absent from the
//      stored set AND carries a removal clock. That matters because this walks
//      LIVE notes, which is a state a peer's deletion has not reached yet:
//      deletions of notes and of prefs travel separately, so device B can unlock
//      holding notes device A has already trashed, back-fill their folder, and
//      hand it a clock NEWER than A's removal.
//
//      This property USED to be claimed by "it runs on the unlock path only,
//      never on a sync refresh", which was said to bound the resurrection "to
//      the window before the notes arrive". It bounds nothing durable: whenever
//      that window is hit, the newer clock wins and the folder is back on every
//      device, permanently, with nobody having asked for it. Running once per
//      session is still right, for the write cost, but it is not the guard.
//      A genuine user act still wins, because at-fill uses the ordinary `add`.
//
// Ancestors are not registered, only leaves. `deriveFolderTree` materializes the
// ancestors of anything registered, so `Projects/` survives as the parent of a
// registered `Projects/Myne/` without an entry of its own, and adding one would
// spend budget on a folder that is already implied.

import { isLiveNote } from "@myne/editor/host/notes/selectors";
import { folderKey } from "../dialect/folderPath";
import { mutateDeliberateFolders } from "../lib/prefs";

/** The fields the back-fill reads. A `TitleRecord` satisfies this structurally. */
export interface BackfillRecord {
  folder: string | null;
  trashed: string | null;
  deleted: string | null;
  archived: string | null;
  template: boolean;
  conflict: boolean;
}

/**
 * Every folder the LIVE notes in `records` prove that `registered` does not
 * already hold, deduplicated, in first-seen order.
 *
 * "Live" is `isLiveNote`, which is the same predicate the sidebar tree is built
 * from, so this registers exactly the folders the user can currently see and no
 * others. A folder whose notes are all in Trash is therefore NOT registered: the
 * user emptied it, the tree does not show it, and registering it here would
 * resurrect a folder as a side effect of unlocking. Note-archive and
 * folder-archive fall out the same way and for the same reason.
 *
 * The comparison is by canonical folder KEY, the identity the core stores under,
 * so a vault holding `Projects/` is not asked to add `projects/` on every single
 * unlock for the rest of its life.
 */
export function foldersToBackfill(
  records: ReadonlyArray<BackfillRecord>,
  registered: ReadonlyArray<string>,
): string[] {
  const held = new Set(registered.map(folderKey));
  const out: string[] = [];
  for (const r of records) {
    if (r.folder === null || !isLiveNote(r)) continue;
    const key = folderKey(r.folder);
    if (held.has(key)) continue;
    held.add(key);
    out.push(r.folder);
  }
  return out;
}

/**
 * Register the folders `records` prove and `registered` does not hold yet.
 *
 * Returns how many additions the reserved byte budget refused, which is zero in
 * every ordinary case and zero when there was nothing to do. Never rejects: a
 * vault whose folders could not be registered is a vault that behaves as it did
 * before this feature, which is strictly better than an unlock that fails. The
 * next unlock retries, since nothing records that this ran.
 */
export async function backfillDeliberateFolders(
  records: ReadonlyArray<BackfillRecord>,
  registered: ReadonlyArray<string>,
): Promise<number> {
  const folders = foldersToBackfill(records, registered);
  if (folders.length === 0) return 0;
  try {
    // `addUnlessRemoved`, not `add`: this is a REPAIR of a registration the
    // old at-fill rule never made, not a user filing a note. The core skips
    // any entry whose removal is on record, so a peer's folder delete is
    // never undone by this device happening to still hold the notes.
    return await mutateDeliberateFolders({ addUnlessRemoved: folders });
  } catch {
    // The vault stays usable and the next unlock tries again. A partial write is
    // not possible here: the core applies the whole mutation under the prefs
    // write mutex, so this either landed or did not.
    return 0;
  }
}
