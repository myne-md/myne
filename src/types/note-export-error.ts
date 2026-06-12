// TODO(Phase-1-end): Replace this hand-written file with a `ts-rs`
// auto-generated artifact + a CI drift check. The Rust types live in:
//   - src-tauri/src/io_failure_kind.rs                  (IoFailureKind)
//   - src-tauri/src/plugins/notes/error.rs              (NoteExportError)

import type { IoFailureKind } from "./vault-unlock-error";

/**
 * Single error type returned across the IPC boundary by the `notes`
 * Tauri plugin's `note_export_as_markdown` command (MYND-115).
 *
 * Wire shape: `#[serde(tag = "kind", content = "detail")]` — payload-
 * carrying variants nest as `{"kind": "<Outer>", "detail": <inner>}`.
 * Unit variants serialize as `{"kind": "<VariantName>"}` only.
 *
 * Variant set is closed; adding a variant is an IPC contract change
 * that requires updating both the Rust enum and this mirror in the
 * same change.
 */
export type NoteExportError =
  /**
   * Slot is `Empty` or `Recovering`. Frontend routes the user to the
   * lock screen via `vault_status` / `vault_slot_kind`; if this
   * surfaces from an export action, a router bug.
   */
  | { kind: "VaultNotUnlocked" }
  /**
   * The `note_id` argument failed strict parse — checked strictly
   * BEFORE any path use, so a malformed id never touches the
   * filesystem. Backend always returns canonical lowercase-hyphenated
   * 36-char v7 UUID strings; anything else is a UI regression
   * (bug-canary). Internal sub-cause stays Rust-side in `tracing`.
   */
  | { kind: "InvalidNoteId" }
  /**
   * `<vault>/notes/<note_id>.myn` does not exist. UI: "Bu not silinmiş
   * olabilir." — a normal user-flow outcome (note deleted between the
   * context-menu open and the dialog confirm).
   */
  | { kind: "NoteNotFound" }
  /**
   * AEAD-tag failure on `decode_note`. **By design this single tag
   * does NOT distinguish** parse-level failure, `items_key_id`
   * mismatch, outer-AEAD failure, or inner-AEAD failure — see
   * `docs/spec/protocol.md` § 6.4. UI: "Bu not okunamadı." —
   * deterministic fail; no "try again" CTA.
   */
  | { kind: "CannotDecrypt" }
  /**
   * AEAD authenticity passed but the recovered plaintext bytes are not
   * valid UTF-8 — mirror of `NoteReadError::InvalidPlaintextEncoding`
   * (structural corruption / foreign-writer suspicion). The export
   * wrote NOTHING: corruption is surfaced, never exported as a file of
   * garbage bytes. UI: "Not içeriği bozuk olabilir, backup'tan restore
   * et."
   */
  | { kind: "InvalidPlaintextEncoding" }
  /**
   * The chosen destination is not usable: its parent directory does
   * not exist or is not a directory (backup precedent —
   * `BackupExportError::InvalidDestination`). The OS save dialog
   * normally guarantees a valid parent; this fires when the directory
   * vanished between dialog confirm and the write.
   */
  | { kind: "InvalidDestination" }
  /**
   * `overwrite=false` and a file already exists at the target path.
   * The existing file is untouched (the check fires before the temp
   * sibling is created). Re-invoke with `overwrite=true` only with the
   * user's explicit "Replace" consent from the OS save dialog.
   */
  | { kind: "TargetAlreadyExists" }
  /**
   * File-system IO failure during the blob read or the destination
   * write. `NotFound` is special-cased upstream as `NoteNotFound`;
   * `AlreadyExists` on the write as `TargetAlreadyExists`; only
   * `PermissionDenied` / `NoSpace` / `Other` surface here.
   */
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  /**
   * `tokio::task::spawn_blocking` join handle returned an error.
   * User-facing CTA is "try again".
   */
  | { kind: "JoinFailure" };

/**
 * Type-narrowing helper for the `Io` variant.
 *
 * ```ts
 * if (isExportIoError(e)) {
 *   switch (e.detail.io_error_kind) { ... }
 * }
 * ```
 */
export function isExportIoError(
  e: NoteExportError,
): e is { kind: "Io"; detail: { io_error_kind: IoFailureKind } } {
  return e.kind === "Io";
}

/**
 * Single error type returned across the IPC boundary by the `notes`
 * plugin's `note_export_attachments` command (MYND-115 task 4) — the
 * opt-in attachments-included export sibling. Rust source:
 * `src-tauri/src/plugins/notes/error.rs::NoteExportAttachmentsError`.
 *
 * Same wire shape as `NoteExportError` (`tag = "kind"`,
 * `content = "detail"`); variant set is closed — adding a variant is an
 * IPC contract change requiring both sides in the same change.
 *
 * All-or-nothing contract: every referenced attachment is catalog-
 * resolved AND decrypted in memory before the first byte lands at the
 * destination, so `AttachmentMissing` / `AttachmentCorrupt` (and every
 * pre-write variant) leave the destination untouched.
 */
export type NoteExportAttachmentsError =
  /** Slot is `Empty` or `Recovering` — route to the lock screen. */
  | { kind: "VaultNotUnlocked" }
  /** Strict `note_id` parse failed before any path use (bug-canary). */
  | { kind: "InvalidNoteId" }
  /**
   * `noteFilename` is not a bare, legal filename (empty, `.`/`..`, or
   * contains a path separator / control char). Bug-canary: the UI must
   * pass the OS save dialog's final path component verbatim.
   */
  | { kind: "InvalidNoteFilename" }
  /** `<vault>/notes/<note_id>.myn` does not exist. */
  | { kind: "NoteNotFound" }
  /**
   * AEAD-tag failure decrypting the NOTE blob (non-distinguishing per
   * `protocol.md` §6.4). Attachment-blob decrypt failures surface as
   * `AttachmentCorrupt` instead.
   */
  | { kind: "CannotDecrypt" }
  /** Note AEAD passed but the plaintext is not UTF-8 — nothing written. */
  | { kind: "InvalidPlaintextEncoding" }
  /**
   * `vault.meta` exists but does not parse, so the attachments catalog
   * cannot be opened. Only reachable when the note references at least
   * one attachment.
   */
  | { kind: "InvalidVaultMeta" }
  /** `targetDir` does not exist or is not a directory. */
  | { kind: "InvalidDestination" }
  /**
   * `overwrite=false` and `<targetDir>/<noteFilename>` already exists —
   * the NOTE file's consent gate (SYNC-2); rejected before any write.
   * Attachment files never overwrite anything regardless (suffix-dedup).
   */
  | { kind: "TargetAlreadyExists" }
  /**
   * A referenced attachment id has no catalog entry, or its blob file
   * is gone. Detected pre-write — nothing was written.
   */
  | { kind: "AttachmentMissing" }
  /**
   * A referenced attachment blob exists but fails to decrypt
   * (corruption / tampering). Detected pre-write — nothing was written.
   */
  | { kind: "AttachmentCorrupt" }
  /** Residual file-system IO failure (vault reads / destination writes). */
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  /** spawn_blocking join failure — "try again". */
  | { kind: "JoinFailure" };

/** Type-narrowing helper for the `Io` variant (attachments sibling). */
export function isExportAttachmentsIoError(
  e: NoteExportAttachmentsError,
): e is { kind: "Io"; detail: { io_error_kind: IoFailureKind } } {
  return e.kind === "Io";
}
