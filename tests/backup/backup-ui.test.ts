// MYND-56 task 9: exhaustiveness of both closed-enum → copy mappings.
// Pure logic only — no Tauri, no DOM. (The 30-day reminder predicate that
// used to live here was removed with the banner, decisions.md 2026-06-11.)

import { describe, expect, it } from "vitest";
import {
  exportErrorMessage,
  exportFailureMessage,
  isBackupExportError,
  isBackupRestoreError,
  restoreErrorMessage,
  restoreFailureMessage,
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

// myne#662. The two suites above iterate the VARIANTS, which is the wrong
// denominator for the defect that shipped: the value that rendered an empty
// error modal was not a variant, so a test that walks the variants is comparing
// the roster against itself and passes while the modal shows nothing.
//
// These inject the inputs the call sites actually cast: what IPC, the seam and
// ordinary JS throw when the closed enum is not what came back.
describe("a throw that is not the closed enum still gets copy (myne#662)", () => {
  // Every shape a `catch (raw)` on this path can plausibly receive. The bare
  // `{}` and the `{ kind: … }` impostors matter most: they are the ones that
  // reach a `switch (e.kind)` and fall through every case.
  const nonVariants: readonly [string, unknown][] = [
    ["a plain Error", new Error("ipc transport failed")],
    ["a string", "plugin backup|vault_export_backup not allowed"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 500],
    ["an empty object", {}],
    ["an object with no kind", { message: "denied" }],
    ["a non-string kind", { kind: 7 }],
    ["an unknown kind", { kind: "CapabilityDenied" }],
    ["a kind from the OTHER enum", { kind: "NotABackupFile" }],
    // The residual half of the same defect, and the one the first version of
    // this table could not see: a roster tag with its PAYLOAD missing. The
    // guard used to narrow on `kind` alone, so these reached the switch and
    // `e.detail.io_error_kind` threw a TypeError inside the catch block, which
    // is worse than the empty modal: no `setState` runs at all, so the export
    // modal sits on its spinner and the restore screen on `step: "working"`
    // after the operation has already failed.
    ["a payload-carrying kind with no detail", { kind: "Io" }],
    ["a payload-carrying kind with a null detail", { kind: "Io", detail: null }],
    ["a payload-carrying kind with the wrong detail", { kind: "Io", detail: {} }],
    ["a restore payload kind with no detail", { kind: "VaultAlreadyExists" }],
  ];

  for (const [label, raw] of nonVariants) {
    it(`export: ${label} renders non-empty copy`, () => {
      const msg = exportFailureMessage(raw);
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
    });

    it(`restore: ${label} renders non-empty copy`, () => {
      const msg = restoreFailureMessage(raw);
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
    });
  }

  // The guards decide which branch runs, so assert them directly rather than
  // inferring from the copy, a fallback and a real message are both non-empty.
  it("the guards accept real variants and reject everything else", () => {
    expect(isBackupExportError({ kind: "VerifyFailed" })).toBe(true);
    expect(isBackupRestoreError({ kind: "DamagedBackup" })).toBe(true);
    // Each enum rejects the other's kinds, which is what keeps a restore error
    // from being answered with export copy.
    expect(isBackupExportError({ kind: "NotABackupFile" })).toBe(false);
    expect(isBackupRestoreError({ kind: "VerifyFailed" })).toBe(false);
    for (const [, raw] of nonVariants.filter(([l]) => l !== "a kind from the OTHER enum")) {
      expect(isBackupExportError(raw)).toBe(false);
    }
  });

  // Non-vacuity: a real variant must still get its OWN copy, not the fallback.
  // Without this the whole suite would pass if the entry points always returned
  // the unknown string.
  it("a real variant is not answered with the fallback copy", () => {
    const fallback = exportFailureMessage({ kind: "CapabilityDenied" });
    const real = exportFailureMessage({ kind: "VaultNotFound" });
    expect(real).not.toBe(fallback);
    expect(real).toBe(exportErrorMessage({ kind: "VaultNotFound" }));
  });
});
