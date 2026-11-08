// TODO(Phase-1-end): Replace this hand-written file with a `ts-rs`
// auto-generated artifact + a CI drift check. The Rust types live in:
//   - core/src/io_failure_kind.rs                  (IoFailureKind)
//   - core/src/plugins/notes/error.rs              (NoteReadError)

import type { IoFailureKind } from "./vault-unlock-error";

/**
 * Single error type returned across the IPC boundary by the `notes`
 * Tauri plugin's `note_read` command.
 *
 * Wire shape: `#[serde(tag = "kind", content = "detail")]`, payload-
 * carrying variants nest as `{"kind": "<Outer>", "detail": <inner>}`.
 * Unit variants serialize as `{"kind": "<VariantName>"}` only.
 *
 * Variant set is closed; adding a variant is an IPC contract change
 * that requires updating both the Rust enum and this mirror in the
 * same change.
 */
export type NoteReadError =
  /**
   * `<vault>/notes/<note_id>.myn` does not exist. UI: "Bu not silinmiş
   * olabilir." Distinct from `InvalidNoteId` because that is a UI-bug
   * canary while this is a normal user-flow outcome (note opened, then
   * deleted in another window, etc.).
   */
  | { kind: "NoteNotFound" }
  /**
   * The `note_id` argument failed strict parse. Backend always returns
   * canonical lowercase-hyphenated 36-char v7 UUID strings via
   * `note_create`; anything else is a UI regression. Internal sub-cause
   * (`WrongLength`, `InvalidChar`, `WrongHyphenPosition`, `ParseFailed`,
   * `WrongVersion`) is emitted to Rust-side `tracing::debug!` and does
   * NOT cross the IPC boundary as a distinguisher, bug-canary.
   */
  | { kind: "InvalidNoteId" }
  /**
   * Slot is `Empty` or `Recovering`. Same shape as
   * `NoteCreateError::VaultNotUnlocked`; reproduced as a separate
   * per-enum variant so the read and create error surfaces stay
   * independent.
   */
  | { kind: "VaultNotUnlocked" }
  /**
   * AEAD-tag failure on `decode_note`. **By design this single tag
   * does NOT distinguish** parse-level failure (magic / version /
   * reserved / `enc_item_key_len` / 16 MiB cap), `items_key_id`
   * mismatch, outer-AEAD failure (`enc_item_key` wrap), or inner-AEAD
   * failure (content), see `myne-agents/docs/spec/protocol.md` § 6.4. The codec's
   * internal sub-cause is emitted to Rust-side `tracing::debug!` from
   * inside `decode_note` and does NOT cross the IPC boundary.
   *
   * UI: "Bu not okunamadı.", deterministic fail; no "try again" CTA.
   */
  | { kind: "CannotDecrypt" }
  /**
   * AEAD authenticity passed but the recovered plaintext bytes are
   * not valid UTF-8. **Distinct from `CannotDecrypt`** because § 6.4's
   * non-distinguishing rule covers AEAD-tag failure (which would leak
   * credential validity); UTF-8 invalid post-AEAD-success is the
   * not-reading kin of `InvalidVaultMeta`, structural corruption /
   * foreign-writer suspicion.
   *
   * UI: "Not içeriği bozuk olabilir, backup'tan restore et.", distinct
   * affordance from `CannotDecrypt` because the recovery path is
   * different (restore-from-backup vs. retry-or-give-up).
   */
  | { kind: "InvalidPlaintextEncoding" }
  /**
   * `<vault>/notes` exists as a regular file rather than a directory,
   * defensive bug-canary parallel to `NoteCreateError`,
   * `NoteUpdateError`, `NoteDeleteError`. UI: render
   * `<FailClosedError reason="invalid-state" />`.
   */
  | { kind: "NotesDirNotADirectory" }
  /**
   * File-system IO failure during `notes_dir` resolution or the blob
   * read. `NotFound` is special-cased upstream as `NoteNotFound`;
   * `NotADirectory` / `AlreadyExists` are special-cased as
   * `NotesDirNotADirectory`; only `PermissionDenied` / `NoSpace` /
   * `Other` surface here.
   */
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  /**
   * `tokio::task::spawn_blocking` join handle returned an error.
   * User-facing CTA is "try again".
   */
  | { kind: "JoinFailure" };
