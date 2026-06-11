// MYND-56 task 9: exhaustiveness of both closed-enum → copy mappings.
// Pure logic only — no Tauri, no DOM. (The 30-day reminder predicate that
// used to live here was removed with the banner, decisions.md 2026-06-11.)

import { describe, expect, it } from "vitest";
import {
  exportErrorMessage,
  restoreErrorMessage,
} from "../../src/lib/backup-errors";
import type {
  BackupExportError,
  BackupRestoreError,
} from "../../src/types/backup-export-error";

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
