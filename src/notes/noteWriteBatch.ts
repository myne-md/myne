// IPC primitive for the `note_write_batch_transactional` Tauri command —
// the §8.3 / WL-7 all-or-nothing multi-note rewrite that backs wikilink
// rename auto-update (MYND-85).
//
// **Internal — the caller is the rename orchestrator (`./renameInbound.ts`),
// not autosave.** Each entry's `plaintext` is the FULL rewritten body (title
// swap on the renamed note, form-preserving inbound `[[…]]` rewrites on the
// others), already surgery-complete — this primitive does no `patch*` surgery
// and never coalesces. The Rust command re-encrypts every body and commits
// them through the two-phase `.rename-journal` transaction: any per-note
// failure aborts the WHOLE batch with the vault left pre-rename.

import { invoke } from "@tauri-apps/api/core";

/** One note in a transactional batch rewrite: id + the full new body. Mirrors
 *  the Rust `NoteBatchUpdate { note_id, plaintext }` (camelCase over the wire). */
export interface NoteBatchEntry {
  readonly noteId: string;
  readonly plaintext: string;
}

/**
 * Re-encrypt and atomically rewrite every entry all-or-nothing. The renamed
 * note's own body conventionally comes FIRST, followed by each inbound note;
 * order is not load-bearing (the transaction is atomic over the whole set).
 *
 * Rejects with a `NoteBatchError` (see `src/types/note-batch-error.ts`); on
 * any rejection the vault is unchanged.
 */
export async function noteWriteBatchTransactional(
  notes: readonly NoteBatchEntry[],
): Promise<void> {
  await invoke<void>("plugin:notes|note_write_batch_transactional", { notes });
}
