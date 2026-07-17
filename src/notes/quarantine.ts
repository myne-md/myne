// IPC bindings for the sync plugin's recovered-notes quarantine surface —
// the device-local `quarantine/` dir where the reconcile drop-leg parks a
// previously-synced note whose server record was deleted + reclaimed
// remotely (never destroyed, never re-uploaded). Thin wrappers over the four
// `plugin:sync|sync_*_quarantine` commands; validation, decrypt, and the
// restore-as-new-note pipeline are all backend-side.
//
// All reject with a `SyncDeviceError`-shaped `{ kind: ... }` payload (the
// sync plugin's shared error enum).

import { invoke } from "@tauri-apps/api/core";

/** One quarantined note blob, as returned by `sync_list_quarantine`. */
export interface QuarantineEntry {
  /** Exact file name under `quarantine/` — the read/restore/delete key.
   *  Duplicates of a re-created id carry a `-<n>` suffix. */
  file_name: string;
  /** Suffix-stripped base note uuid (36-char lowercase hyphenated) —
   *  display only. */
  note_id_hex: string;
  /** Encrypted blob size in bytes. */
  size: number;
  /** Device-local mtime (ms since epoch), or null when unavailable. */
  modified_epoch_ms: number | null;
}

/** List the quarantined note blobs, sorted by file name. Decrypt-free. */
export async function quarantineList(): Promise<QuarantineEntry[]> {
  return await invoke<QuarantineEntry[]>("plugin:sync|sync_list_quarantine");
}

/**
 * Decrypt one quarantined blob to its plaintext body for the preview modal.
 * Requires the unlocked vault; rejects on a malformed file name.
 */
export async function quarantineRead(fileName: string): Promise<string> {
  return await invoke<string>("plugin:sync|sync_read_quarantine", {
    fileName,
  });
}

/**
 * Restore a quarantined blob as a NEW note (fresh backend-minted id — the
 * reclaimed original id is never re-pushed) and remove the quarantine source
 * on success. Resolves to the new note's 36-char id.
 */
export async function quarantineRestore(fileName: string): Promise<string> {
  return await invoke<string>("plugin:sync|sync_restore_quarantine", {
    fileName,
  });
}

/**
 * Permanently delete one quarantined blob. The only path that destroys
 * quarantine evidence — callers confirm with the user first.
 */
export async function quarantineDelete(fileName: string): Promise<void> {
  await invoke<void>("plugin:sync|sync_delete_quarantine", { fileName });
}
