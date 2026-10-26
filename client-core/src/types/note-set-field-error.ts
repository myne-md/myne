// TODO(Phase-1-end): Replace this hand-written file with a `ts-rs`
// auto-generated artifact + a CI drift check. The Rust type lives in:
//   - core/src/plugins/notes/error.rs                (NoteSetFieldError)
//   - core/src/io_failure_kind.rs                    (IoFailureKind)

import type { IoFailureKind } from "./vault-unlock-error";

/**
 * The refusal surface of `note_set_field` — the host-owned, view-scoped field
 * write.
 *
 * Wire shape: `#[serde(tag = "kind", content = "detail")]`, so a payload-carrying
 * variant nests as `{"kind": "<Outer>", "detail": <inner>}` and a unit variant is
 * `{"kind": "<VariantName>"}`.
 *
 * **A refusal is not a failure.** Every variant says exactly why nothing was
 * written and which condition the caller can show a person, which is what a bulk
 * operation needs to report one line per note instead of a single success flag.
 * The set is closed; adding a variant is an IPC contract change that updates
 * both the Rust enum and this mirror in the same change.
 */
export type NoteSetFieldError =
  /** The vault is locked. Nothing was read. */
  | { kind: "VaultLocked" }
  /** The note id is not a canonical v7 UUID. A UI bug-canary. */
  | { kind: "InvalidNoteId" }
  /** The note's `.myn` file is gone; the delete-vs-write race signal. */
  | { kind: "NoteNotFound" }
  /** AEAD failure on the note blob. Non-distinguishing per `protocol.md` §6.4. */
  | { kind: "CannotDecrypt" }
  /**
   * This device has not approved the view, or has approved a DIFFERENT version
   * of it. Approval is an equality against the definition's current `version`,
   * so a version bump revokes it with nothing to clear. An id that names no
   * stored view reads the same way.
   */
  | { kind: "NotApproved" }
  /** The field is not in the approved view's `write_fields`. */
  | { kind: "FieldNotDeclared" }
  /**
   * The field is `archived` / `trashed` / `deleted`. Refused even when the view
   * declares it: a property write must never be able to take a note out of the
   * live tree.
   */
  | { kind: "FieldReserved" }
  /**
   * The field's value on disk is not the one the caller expected, so something
   * else changed it since the caller looked. Nothing was written and the note on
   * disk is untouched. The comparison is on the scalar's text after NFC folding,
   * with a quoted and an unquoted occurrence of the same characters equal, so
   * this means the VALUE changed and never that the quoting did.
   */
  | { kind: "FieldChanged" }
  /** The field name is not a plain YAML key, so no writer could find it again. */
  | { kind: "InvalidField" }
  /** The value would push the note past the plaintext cap. */
  | { kind: "ValueTooLarge" }
  /** A live co-editing session owns this note (`SYNC-33`). */
  | { kind: "LiveSessionOpen" }
  /** The device-local approval map could not be read at all. */
  | { kind: "PrefsUnreadable" }
  /** Residual filesystem failure on the blob read or the atomic write. */
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  /** The blocking task panicked or the runtime shut down. */
  | { kind: "JoinFailure" };
