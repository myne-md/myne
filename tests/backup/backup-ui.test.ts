// MYND-56 task 9: the backup-reminder predicate's truth table and the
// exhaustiveness of both closed-enum → copy mappings. Pure logic only —
// no Tauri, no DOM.

import { describe, expect, it } from "vitest";
import {
  BACKUP_REMINDER_DAYS,
  shouldShowBackupReminder,
} from "../../src/lib/vault-backup";
import {
  exportErrorMessage,
  restoreErrorMessage,
} from "../../src/lib/backup-errors";
import type {
  BackupExportError,
  BackupRestoreError,
} from "../../src/types/backup-export-error";

const DAY = 24 * 60 * 60;
const NOW = 1_765_432_100;

describe("shouldShowBackupReminder (SYNC-9, 30-day banner)", () => {
  const base = {
    vaultNonEmpty: true,
    lastBackupAt: null as number | null,
    nowSeconds: NOW,
    dismissedThisSession: false,
  };

  it("shows for a never-backed-up, non-empty vault", () => {
    expect(shouldShowBackupReminder(base)).toBe(true);
  });

  it("never shows for an empty vault (fresh create)", () => {
    expect(shouldShowBackupReminder({ ...base, vaultNonEmpty: false })).toBe(
      false,
    );
  });

  it("hides while the backup is fresh, shows once past the threshold", () => {
    expect(
      shouldShowBackupReminder({ ...base, lastBackupAt: NOW - DAY }),
    ).toBe(false);
    expect(
      shouldShowBackupReminder({
        ...base,
        lastBackupAt: NOW - BACKUP_REMINDER_DAYS * DAY,
      }),
    ).toBe(false); // exactly at the boundary: not yet "older than"
    expect(
      shouldShowBackupReminder({
        ...base,
        lastBackupAt: NOW - (BACKUP_REMINDER_DAYS * DAY + 1),
      }),
    ).toBe(true);
  });

  it("session dismissal wins over every other condition", () => {
    expect(
      shouldShowBackupReminder({ ...base, dismissedThisSession: true }),
    ).toBe(false);
  });
});

describe("closed-enum error copy maps", () => {
  it("covers every BackupExportError variant with non-empty copy", () => {
    const variants: BackupExportError[] = [
      { kind: "VaultNotFound" },
      { kind: "InvalidDestination" },
      { kind: "MemberTooLarge" },
      { kind: "VerifyFailed" },
      { kind: "AuthOperationInProgress" },
      { kind: "Cancelled" },
      { kind: "Io", detail: { io_error_kind: "NoSpace" } },
      { kind: "Io", detail: { io_error_kind: "PermissionDenied" } },
      { kind: "Io", detail: { io_error_kind: "NotFound" } },
      { kind: "Io", detail: { io_error_kind: "Other" } },
      { kind: "JoinFailure" },
    ];
    for (const v of variants) {
      expect(exportErrorMessage(v).length).toBeGreaterThan(0);
    }
  });

  it("covers every BackupRestoreError variant with non-empty copy", () => {
    const variants: BackupRestoreError[] = [
      { kind: "NotABackupFile" },
      { kind: "FutureVersionBackup" },
      { kind: "DamagedBackup" },
      { kind: "MissingVaultMeta" },
      { kind: "InvalidVaultMeta" },
      { kind: "VaultAlreadyExists", detail: { vault_id: "x" } },
      { kind: "AuthOperationInProgress" },
      { kind: "Cancelled" },
      { kind: "Io", detail: { io_error_kind: "NoSpace" } },
      { kind: "Io", detail: { io_error_kind: "PermissionDenied" } },
      { kind: "Io", detail: { io_error_kind: "NotFound" } },
      { kind: "Io", detail: { io_error_kind: "Other" } },
      { kind: "JoinFailure" },
    ];
    for (const v of variants) {
      expect(restoreErrorMessage(v).length).toBeGreaterThan(0);
    }
  });

  it("v005 backups get the explicit update-then-restore prompt (§10.4)", () => {
    expect(restoreErrorMessage({ kind: "FutureVersionBackup" })).toContain(
      "newer version",
    );
  });
});
