// Backup/restore closed-enum → user-facing copy mappings (MYND-56;
// vault-creation-errors.ts is the convention precedent).
//
// Honest copy discipline: strings stay inside threat-model §7 — "verified"
// is allowed, "tamper-proof"/"safe forever" never. Both enums are closed on
// the Rust side (`src-tauri/src/plugins/backup/error.rs`); the exhaustive
// switches make a new variant a compile error here, and
// `tests/backup/backup-ui.test.ts` pins non-empty copy per variant at
// runtime.

import type {
  BackupExportError,
  BackupRestoreError,
} from "../types/backup-export-error";

/** `vault_export_backup` failure → copy (BackupExportModal renders it). */
export function exportErrorMessage(e: BackupExportError): string {
  switch (e.kind) {
    case "VaultNotFound":
      return "No vault found to back up.";
    case "InvalidDestination":
      return "That destination folder is not usable.";
    case "MemberTooLarge":
      return "A file in this vault is larger than the backup format allows.";
    case "VerifyFailed":
      return "The written backup did not verify, so it was discarded. Try again — on different media if it repeats.";
    case "AuthOperationInProgress":
      return "Another vault operation is in progress. Wait for it to finish, then try again.";
    case "Cancelled":
      return "Backup cancelled. No file was left behind.";
    case "Io":
      return e.detail.io_error_kind === "NoSpace"
        ? "Not enough space at the destination."
        : e.detail.io_error_kind === "PermissionDenied"
          ? "No permission to write at the destination."
          : "Could not write the backup file.";
    case "JoinFailure":
      return "Backup failed unexpectedly. No file was left behind.";
  }
}

/** `vault_restore_backup` failure → copy (the RestoreBackup Stage screen
 *  renders it; collision/damaged get their own steps before this fires). */
export function restoreErrorMessage(e: BackupRestoreError): string {
  switch (e.kind) {
    case "NotABackupFile":
      return "This file is not a Myne backup.";
    case "FutureVersionBackup":
      return "This backup was made by a newer version of Myne. Update Myne, then restore it.";
    case "DamagedBackup":
      return "The backup file is damaged.";
    case "MissingVaultMeta":
      return "This backup is missing its vault metadata and cannot be restored.";
    case "InvalidVaultMeta":
      return "This backup's vault metadata is unreadable, so restoring it could not produce a working vault.";
    case "VaultAlreadyExists":
      return "A vault from this backup already exists on this device.";
    case "AuthOperationInProgress":
      return "Another vault operation is in progress. Wait for it to finish, then try again.";
    case "Cancelled":
      return "Restore cancelled. Nothing was changed.";
    case "Io":
      return e.detail.io_error_kind === "PermissionDenied"
        ? "No permission to read the backup file."
        : "Could not read the backup file.";
    case "JoinFailure":
      return "Restore failed unexpectedly. Nothing was changed.";
  }
}
