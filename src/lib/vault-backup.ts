// IPC wrappers for the `backup` Tauri plugin (MYND-32 export / MYND-218
// restore; epic MYND-217). Signatures hand-mirror
// `src-tauri/src/plugins/backup/{commands,restore}.rs` — no codegen canary
// yet (see src/CLAUDE.md "Tauri command bindings").

import { invoke } from "../platform/core";
import { listen, type UnlistenFn } from "../platform/event";
import {
  BACKUP_PROGRESS_EVENT,
  type BackupProgress,
  type ExportSummary,
  type RestoreOptions,
  type RestoreOutcome,
} from "../types/backup-export-error";

/** `backup:vault_export_backup` — write a verified `.myne-backup`. */
export function exportBackup(
  destination: string,
  vaultId?: string,
): Promise<ExportSummary> {
  return invoke<ExportSummary>("plugin:backup|vault_export_backup", {
    vaultId: vaultId ?? null,
    destination,
  });
}

/** `backup:vault_restore_backup` — recreate a vault from a backup file. */
export function restoreBackup(
  source: string,
  options?: RestoreOptions,
): Promise<RestoreOutcome> {
  return invoke<RestoreOutcome>("plugin:backup|vault_restore_backup", {
    source,
    options: options ?? null,
  });
}

/**
 * `backup:backup_default_filename` — the engine-owned naming rule
 * (`Myne backup <YYYY-MM-DD HHMM>.myne-backup`; never the vault label).
 * The WebView supplies its local clock components.
 */
export function backupDefaultFilename(now: Date = new Date()): Promise<string> {
  return invoke<string>("plugin:backup|backup_default_filename", {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
    hour: now.getHours(),
    minute: now.getMinutes(),
  });
}

/** `backup:backup_cancel` — cooperative cancel; partial output discarded. */
export function backupCancel(): Promise<void> {
  return invoke<void>("plugin:backup|backup_cancel");
}

/** Subscribe to `backup://progress` (counts-only payloads, SYNC-7). */
export function onBackupProgress(
  handler: (progress: BackupProgress) => void,
): Promise<UnlistenFn> {
  return listen<BackupProgress>(BACKUP_PROGRESS_EVENT, (event) =>
    handler(event.payload),
  );
}
