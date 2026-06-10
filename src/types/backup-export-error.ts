// TODO(Phase-1-end): Replace this hand-written file with a `ts-rs`
// auto-generated artifact + a CI drift check. The Rust types live in:
//   - src-tauri/src/io_failure_kind.rs                  (IoFailureKind)
//   - src-tauri/src/plugins/backup/error.rs             (BackupExportError,
//     BackupRestoreError)
//   - src-tauri/src/plugins/backup/commands.rs          (ExportSummary,
//     BackupProgressPayload)
//   - src-tauri/src/plugins/backup/restore.rs           (RestoreOutcome,
//     RestoreOptions, CollisionIntent)

import type { IoFailureKind } from "./vault-unlock-error";

/**
 * Single error type returned across the IPC boundary by the `backup`
 * Tauri plugin's export command (MYND-32; spec §9.11, epic MYND-217).
 *
 * Wire shape: `#[serde(tag = "kind", content = "detail")]` — payload-carrying
 * variants nest as `{"kind": "<Outer>", "detail": <inner>}`; unit variants are
 * `{"kind": "<VariantName>"}`. Closed set — adding a variant is an IPC contract
 * change requiring the Rust enum + this mirror to move together.
 */
export type BackupExportError =
  /** No vault exists at the resolved root (no `vault.meta`). */
  | { kind: "VaultNotFound" }
  /** The destination path is unusable (empty / parent missing). */
  | { kind: "InvalidDestination" }
  /** A vault member exceeds its §9.11 family cap — nothing was written. */
  | { kind: "MemberTooLarge" }
  /**
   * SYNC-4 read-back verification failed — the bytes did not verify
   * (typically a lying/corrupting destination medium; rarely a source
   * mutated mid-export). No file was left behind; retrying — on different
   * media if it repeats — is the honest CTA.
   */
  | { kind: "VerifyFailed" }
  /**
   * Another credential/lifecycle operation (unlock, recover,
   * change-password, delete — or another export) is in flight.
   * Reject-never-queue (SYNC-6).
   */
  | { kind: "AuthOperationInProgress" }
  /** The user cancelled; the partial output was discarded (SYNC-7). */
  | { kind: "Cancelled" }
  /** Residual filesystem failure, reduced to a closed kind. */
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  /** `spawn_blocking` panic / runtime shutdown. */
  | { kind: "JoinFailure" };

/**
 * Post-export summary (the SYNC-3 manifest counts the UI renders).
 * Field names mirror the Rust `ExportSummary` serde shape (snake_case).
 */
export interface ExportSummary {
  /** Total members written. */
  members: number;
  /** Total member bytes (container `members_total_len`). */
  bytes: number;
  /** `notes/*.myn` count. */
  notes: number;
  /** `snapshots/*.myn` count. */
  snapshots: number;
  /** `attachments/*` blob count. */
  attachments: number;
  /** Whether `vault.prefs` was present and included. */
  prefs_included: boolean;
}

/** Event name for backup progress (counts-only payload, SYNC-7). */
export const BACKUP_PROGRESS_EVENT = "backup://progress";

/**
 * Payload of `backup://progress` — counts and a phase tag only (DENY-list:
 * no paths, no vault ids ever cross this event).
 */
export interface BackupProgress {
  /** Members completed in the current phase. */
  done: number;
  /** Total members in the current phase. */
  total: number;
  /**
   * Export: `"copy"` (small members, under writer quiescence) → `"blobs"`
   * (immutable attachment blobs) → `"verify"` (SYNC-4 read-back).
   * Restore: `"verify"` (pre-placement) → `"restore"` (staging extraction).
   */
  phase: "copy" | "blobs" | "verify" | "restore";
}

/**
 * Single error type returned by `backup:vault_restore_backup` (MYND-218).
 * Same wire shape as `BackupExportError`.
 */
export type BackupRestoreError =
  /** Bad magic / not ours — the file is not a `.myne-backup`. */
  | { kind: "NotABackupFile" }
  /** `MYB5` future-version container — explicit migration prompt (§10.4). */
  | { kind: "FutureVersionBackup" }
  /** Structural/integrity verification failed; default posture rejects all. */
  | { kind: "DamagedBackup" }
  /** No `vault.meta` member — nothing restored could ever unlock. */
  | { kind: "MissingVaultMeta" }
  /** Embedded `vault.meta` fails the §9.3 structural parse. */
  | { kind: "InvalidVaultMeta" }
  /**
   * Same-identity vault already on this device and no `CollisionIntent`
   * was supplied — ask the user ("İkisini de tut" / "Mevcutla değiştir")
   * and re-invoke with the choice. `vault_id` is the opaque directory id.
   */
  | { kind: "VaultAlreadyExists"; detail: { vault_id: string } }
  /** Another lifecycle operation in flight (reject-never-queue). */
  | { kind: "AuthOperationInProgress" }
  /** Cancelled; staged state discarded. */
  | { kind: "Cancelled" }
  /** Residual filesystem failure, reduced to a closed kind. */
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  /** `spawn_blocking` panic / runtime shutdown. */
  | { kind: "JoinFailure" };

/** Caller intent on identity collision (serde kebab-case). */
export type CollisionIntent = "keep-both" | "replace-existing";

/** Optional second argument of `backup:vault_restore_backup`. */
export interface RestoreOptions {
  on_collision?: CollisionIntent;
  /** Explicit salvage opt-in — NEVER default; result is labeled partial. */
  salvage?: boolean;
}

/** Result of a successful restore (snake_case mirrors serde). */
export interface RestoreOutcome {
  /** Freshly-minted vault directory id (canonical hyphenated UUID). */
  vault_id: string;
  members: number;
  bytes: number;
  notes: number;
  snapshots: number;
  attachments: number;
  /** Matched existing vault when the caller proceeded through a collision. */
  collided_vault_id: string | null;
  /** Salvage only: damaged members that were skipped. Non-empty ⇒ partial. */
  skipped: string[];
}
