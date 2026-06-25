// Backup/restore closed-enum → user-facing copy mappings (MYND-56;
// vault-creation-errors.ts is the convention precedent).
//
// Honest copy discipline: strings stay inside threat-model §7 — "verified"
// is allowed, "tamper-proof"/"safe forever" never. Both enums are closed on
// the Rust side (`src-tauri/src/plugins/backup/error.rs`); the exhaustive
// switches make a new variant a compile error here, and
// `tests/backup/backup-ui.test.ts` pins non-empty copy per variant at
// runtime.

import i18n from "../i18n";
import type {
  BackupExportError,
  BackupRestoreError,
} from "../types/backup-export-error";

/** `vault_export_backup` failure → copy (BackupExportModal renders it). */
export function exportErrorMessage(e: BackupExportError): string {
  switch (e.kind) {
    case "VaultNotFound":
      return i18n.t("backup.errors.export.vaultNotFound");
    case "InvalidDestination":
      return i18n.t("backup.errors.export.invalidDestination");
    case "MemberTooLarge":
      return i18n.t("backup.errors.export.memberTooLarge");
    case "VerifyFailed":
      return i18n.t("backup.errors.export.verifyFailed");
    case "AuthOperationInProgress":
      return i18n.t("backup.errors.export.authOperationInProgress");
    case "Cancelled":
      return i18n.t("backup.errors.export.cancelled");
    case "Io":
      return e.detail.io_error_kind === "NoSpace"
        ? i18n.t("backup.errors.export.ioNoSpace")
        : e.detail.io_error_kind === "PermissionDenied"
          ? i18n.t("backup.errors.export.ioPermissionDenied")
          : i18n.t("backup.errors.export.ioGeneric");
    case "JoinFailure":
      return i18n.t("backup.errors.export.joinFailure");
  }
}

/** `vault_restore_backup` failure → copy (the RestoreBackup Stage screen
 *  renders it; collision/damaged get their own steps before this fires). */
export function restoreErrorMessage(e: BackupRestoreError): string {
  switch (e.kind) {
    case "NotABackupFile":
      return i18n.t("backup.errors.restore.notABackupFile");
    case "FutureVersionBackup":
      return i18n.t("backup.errors.restore.futureVersionBackup");
    case "DamagedBackup":
      return i18n.t("backup.errors.restore.damagedBackup");
    case "MissingVaultMeta":
      return i18n.t("backup.errors.restore.missingVaultMeta");
    case "InvalidVaultMeta":
      return i18n.t("backup.errors.restore.invalidVaultMeta");
    case "VaultAlreadyExists":
      return i18n.t("backup.errors.restore.vaultAlreadyExists");
    case "AuthOperationInProgress":
      return i18n.t("backup.errors.restore.authOperationInProgress");
    case "Cancelled":
      return i18n.t("backup.errors.restore.cancelled");
    case "Io":
      return e.detail.io_error_kind === "PermissionDenied"
        ? i18n.t("backup.errors.restore.ioPermissionDenied")
        : i18n.t("backup.errors.restore.ioGeneric");
    case "JoinFailure":
      return i18n.t("backup.errors.restore.joinFailure");
  }
}
