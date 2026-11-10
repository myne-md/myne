// Backup/restore closed-enum → user-facing copy mappings (MYND-56;
// vault-creation-errors.ts is the convention precedent).
//
// Honest copy discipline: strings stay inside threat-model §7 — "verified"
// is allowed, "tamper-proof"/"safe forever" never. Both enums are closed on
// the Rust side (`src-tauri/src/plugins/backup/error.rs`); the exhaustive
// switches make a new variant a compile error here, and
// `tests/backup/backup-ui.test.ts` pins non-empty copy per variant at
// runtime.
//
// # Why the exhaustive switches are not the exported entry points (myne#662)
//
// A `switch` over a closed union with no `default` is the right shape for a
// value that IS one of those variants: a new Rust variant becomes a compile
// error here rather than a silent miss. It is the wrong shape for a value that
// merely CAME from IPC, because a thrown value outside the union falls through
// every case and the function returns `undefined`, which React renders as
// nothing. That shipped: the backup modal's error state rendered an empty body
// with a Close button, so a failed backup was visible and unattributable.
//
// The call sites cast (`raw as BackupExportError`) rather than checking, so
// anything outside the enum lands in the switch: an IPC-layer failure, a
// missing or renamed command, a capability-ACL denial, a serialization
// mismatch, a plain `Error` from the seam, a promise rejected with a string.
//
// So the switches stay exhaustive, and `exportFailureMessage` /
// `restoreFailureMessage` are what catch blocks call: they take `unknown`,
// narrow, and fall back. The per-variant test cannot catch this class by
// construction. The failing input is not a variant, so iterating the variants
// compares the roster against itself, which is why `backup-ui.test.ts` now
// injects non-variant throws as well.

import i18n from "../i18n";
import type {
  BackupExportError,
  BackupRestoreError,
} from "../types/backup-export-error";

/**
 * The two closed kind rosters, keyed so the compiler can count.
 *
 * `Readonly<Record<K, true>>` rather than a `readonly K[]`, and the repo has
 * already paid for learning the difference: `src/platform/capabilities.ts`
 * carries the post-mortem. An array checks that every element IS a member of the
 * union and nothing checks that every member is an element, so two capabilities
 * were silently absent on desktop under a comment promising that could not
 * happen. A record gets both directions from one construct, a missing key is a
 * TS2739 naming the key, an extra one is an excess-property error, which is
 * exactly what these rosters need. A kind missing here makes the guard reject a
 * real error and show the fallback copy: a genuine failure wearing the wrong
 * message. A kind here that the union no longer carries makes the guard accept a
 * value the switch cannot answer, which is myne#662 back again one layer down.
 */
const EXPORT_ERROR_KINDS: Readonly<Record<BackupExportError["kind"], true>> =
  Object.freeze({
    VaultNotFound: true,
    InvalidDestination: true,
    MemberTooLarge: true,
    VerifyFailed: true,
    AuthOperationInProgress: true,
    Cancelled: true,
    Io: true,
    JoinFailure: true,
  });

const RESTORE_ERROR_KINDS: Readonly<Record<BackupRestoreError["kind"], true>> =
  Object.freeze({
    NotABackupFile: true,
    FutureVersionBackup: true,
    DamagedBackup: true,
    MissingVaultMeta: true,
    InvalidVaultMeta: true,
    VaultAlreadyExists: true,
    AuthOperationInProgress: true,
    Cancelled: true,
    Io: true,
    JoinFailure: true,
  });

/**
 * The payload each roster kind must carry.
 *
 * Narrowing on the serde TAG alone is half a guard. `#[serde(tag = "kind",
 * content = "detail")]` puts unit variants on the wire as `{"kind":
 * "Cancelled"}` and payload-carrying ones as `{"kind": "Io", "detail": {…}}`, so
 * a tag-only check accepts `{kind: "Io"}` with no `detail`. The switch then
 * reads `e.detail.io_error_kind` and throws a TypeError INSIDE the catch block,
 * which is worse than the empty modal this module exists to fix: no `setState`
 * runs at all, so the export modal sits on its spinner and the restore screen
 * sits on `step: "working"` after the operation has already failed.
 *
 * It is also the drift this file is most exposed to.
 * `src/types/backup-export-error.ts` is a hand-written mirror of three Rust
 * files carrying a `TODO(Phase-1-end)` and, by its own admission, no CI drift
 * check, so a variant gaining or losing a payload arrives unannounced.
 */
type PayloadCheck = (detail: unknown) => boolean;

const hasStringField =
  (field: string): PayloadCheck =>
  (detail) =>
    typeof detail === "object" &&
    detail !== null &&
    typeof (detail as Record<string, unknown>)[field] === "string";

const EXPORT_PAYLOADS: Readonly<Record<string, PayloadCheck>> = Object.freeze({
  Io: hasStringField("io_error_kind"),
});

const RESTORE_PAYLOADS: Readonly<Record<string, PayloadCheck>> = Object.freeze({
  Io: hasStringField("io_error_kind"),
  VaultAlreadyExists: hasStringField("vault_id"),
});

/** Does this thrown value carry a `kind` the roster names, WITH its payload? */
function hasKindIn(
  raw: unknown,
  kinds: Readonly<Record<string, true>>,
  payloads: Readonly<Record<string, PayloadCheck>>,
): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  // No `"kind" in raw` clause: the `typeof` below is already false for an
  // absent property, so it only read as extra safety.
  const kind = (raw as { kind: unknown }).kind;
  if (typeof kind !== "string") return false;
  // `Object.prototype.hasOwnProperty.call`, not `Object.hasOwn`: the tree's
  // `lib` target predates it. Not `kinds[k] === true` either, which would ask
  // the prototype chain, so `{ kind: "constructor" }` would narrow.
  if (!Object.prototype.hasOwnProperty.call(kinds, kind)) return false;
  if (!Object.prototype.hasOwnProperty.call(payloads, kind)) return true;
  return payloads[kind]!((raw as { detail?: unknown }).detail);
}

/** True when `raw` really is the closed export enum, not merely thrown at us. */
export function isBackupExportError(raw: unknown): raw is BackupExportError {
  return hasKindIn(raw, EXPORT_ERROR_KINDS, EXPORT_PAYLOADS);
}

/** True when `raw` really is the closed restore enum. */
export function isBackupRestoreError(raw: unknown): raw is BackupRestoreError {
  return hasKindIn(raw, RESTORE_ERROR_KINDS, RESTORE_PAYLOADS);
}

/**
 * The export entry point every catch block uses: takes whatever was thrown and
 * always answers with copy the user can act on.
 *
 * The fallback claims nothing about the destination, deliberately. On a
 * recognised failure the copy may say no file was left behind, because the Rust
 * side guarantees it. On an unrecognised one nothing is known about what
 * reached the disk, so the honest line tells the user not to trust it.
 */
export function exportFailureMessage(raw: unknown): string {
  return isBackupExportError(raw)
    ? exportErrorMessage(raw)
    : i18n.t("backup.errors.export.unknown");
}

/** The restore entry point every catch block uses. Same contract. */
export function restoreFailureMessage(raw: unknown): string {
  return isBackupRestoreError(raw) ? restoreErrorMessage(raw) : unknownRestoreMessage();
}

/**
 * The unrecognised-restore-failure copy on its own, for a caller that has
 * ALREADY narrowed and taken the negative branch (`RestoreBackup.tsx`, which
 * must inspect `kind` for its collision and damaged steps). Handing that caller
 * `restoreFailureMessage` would re-run the guard it just answered.
 */
export function unknownRestoreMessage(): string {
  return i18n.t("backup.errors.restore.unknown");
}

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
      return i18n.t("common.anothervaultoperationisinprogresswaitforittofinishthentryagain");
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
      return i18n.t("common.anothervaultoperationisinprogresswaitforittofinishthentryagain");
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
