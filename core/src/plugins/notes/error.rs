//! Tauri-layer error types for the `notes` plugin.
//!
//! Mirrors the `vault_unlock::error::VaultUnlockError` discipline (no
//! `String` field anywhere reaches the frontend) but specialized to
//! the per-note CRUD domain. Two closed enums are exported — one per
//! command — so the frontend's discriminated-union mirrors stay tight
//! and an `Err` from `note_create` cannot accidentally type-narrow to
//! `NoteReadError`.
//!
//! Spec touchpoints:
//!
//! - `protocol.md` §6.4 — `NoteReadError::CannotDecrypt` is the single
//!   non-distinguishing tag for AEAD-tag failure on `decode_note`.
//!   The codec's internal `pub(crate) DecryptCause` is routed to
//!   `tracing::debug!` inside the codec; this enum never carries it.
//! - `protocol.md` §6.2 + `decisions.md` 2026-05-07 (Note UUIDv7
//!   backend-gen) — `NoteCreateError::NoteAlreadyExists` is a defensive
//!   canary: backend-generated UUIDv7 is unique by construction;
//!   `src-tauri/CLAUDE.md` "Defensive guards" makes the exists-check
//!   mandatory anyway. Production never reaches this variant in normal
//!   flow.
//! - `decisions.md` 2026-04-26 unlock-error-discipline — the single
//!   non-distinguishing public tag + internal stage-tag-via-tracing
//!   pattern this enum mirrors.
//! - `decisions.md` 2026-05-07 (atomic_write durability + replace:bool)
//!   — `replace=false` returns `io::ErrorKind::AlreadyExists` from the
//!   helper layer; `note_create` maps that to `NoteAlreadyExists`.
//! - Q4 grilling decision — `InvalidPlaintextEncoding` is **distinct**
//!   from `CannotDecrypt`: §6.4 covers AEAD failure (which leaks
//!   credential validity); UTF-8 invalid post-AEAD-success is a
//!   structural-corruption / foreign-writer-suspicion category, the
//!   not-reading kin of `InvalidVaultMeta`.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use serde::Serialize;
use thiserror::Error;

/// Single error type returned across the IPC boundary by
/// [`super::commands::note_create`].
///
/// Hand-mirrored on the TS side at `src/types/note-create-error.ts`.
/// Variant set is closed; adding a variant is an IPC contract change
/// that requires updating both sides.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum NoteCreateError {
    /// Slot is `Empty` or `Recovering`. Frontend routes the user to
    /// the lock screen via `vault_status` / `vault_slot_kind`; if this
    /// surfaces from `note_create`, a router bug.
    #[error("vault not unlocked")]
    VaultNotUnlocked,

    /// `<vault>/notes/<note_id>.myn` already exists. Backend-generated
    /// UUIDv7 makes a real collision astronomically improbable; this
    /// variant is the canary the `atomic_write(replace=false)` helper
    /// guarantees per `src-tauri/CLAUDE.md` "Defensive guards".
    /// **Not user-facing in normal flow.**
    #[error("note already exists")]
    NoteAlreadyExists,

    /// Plaintext exceeds `protocol::MAX_PLAINTEXT_LEN` (16 MiB). UI
    /// surfaces "16 MiB sınırını aşıyor" with an attachment-Phase 1.5+
    /// affordance (PRD U11 / task 5).
    #[error("plaintext too large")]
    PlaintextTooLarge,

    /// `<vault>/notes` exists as a regular file rather than a
    /// directory — defensive edge case for OS-level user manipulation
    /// of the vault directory. UI surfaces "Vault directory'nizde
    /// 'notes' adlı bir dosya var. Lütfen kaldırın veya vault'u
    /// taşıyın."
    #[error("vault notes path is not a directory")]
    NotesDirNotADirectory,

    /// File-system IO failure during `notes_dir` resolution or
    /// `atomic_write`. The bounded [`IoFailureKind`] keeps OS error
    /// messages off the wire.
    #[error("io error")]
    Io { io_error_kind: IoFailureKind },

    /// `tokio::task::spawn_blocking` join handle returned an error
    /// (panic in the blocking task, runtime shutdown). Includes the
    /// `unreachable!` panic path for `encode_new_note` AEAD seal
    /// failure (impossible under v0.1 fixed parameters; if it ever
    /// fires, it's caught here). User-facing CTA is "try again".
    #[error("blocking task join failure")]
    JoinFailure,
}

impl From<std::io::Error> for NoteCreateError {
    fn from(e: std::io::Error) -> Self {
        // `AlreadyExists` and `NotADirectory` are special-cased by the
        // calling command (mapped to the structural variants
        // `NoteAlreadyExists` / `NotesDirNotADirectory`). This `From`
        // handles the residual cases where an `io::Error` bubbles up
        // unclassified.
        NoteCreateError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

/// Single error type returned across the IPC boundary by
/// [`super::commands::note_read`].
///
/// Hand-mirrored on the TS side at `src/types/note-read-error.ts`.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum NoteReadError {
    /// `<vault>/notes/<note_id>.myn` does not exist. UI: "Bu not
    /// silinmiş olabilir." Distinct from `InvalidNoteId` because that
    /// is a UI-bug-canary while this is a normal user-flow outcome.
    #[error("note not found")]
    NoteNotFound,

    /// `note_id` failed strict parse via `super::note_id::NoteId::parse`.
    /// The internal sub-cause (`WrongLength`, `InvalidChar`,
    /// `WrongHyphenPosition`, `ParseFailed`, `WrongVersion`) is
    /// emitted via `tracing::debug!(stage = ?cause)` for ops debugging
    /// and **does not** cross the IPC boundary as a distinguisher.
    /// Bug-canary: backend always returns canonical `note_id` strings,
    /// so anything else is a UI regression.
    #[error("invalid note id")]
    InvalidNoteId,

    /// Slot is `Empty` or `Recovering` — same shape as
    /// [`NoteCreateError::VaultNotUnlocked`]; reproduced as a separate
    /// per-enum variant so the read and create error surfaces stay
    /// independent.
    #[error("vault not unlocked")]
    VaultNotUnlocked,

    /// AEAD-tag failure on `decode_note`. **By design this single tag
    /// does NOT distinguish** parse-level failure (magic / version /
    /// reserved / `enc_item_key_len` / cap), `items_key_id` mismatch,
    /// outer-AEAD failure (`enc_item_key` wrap), or inner-AEAD failure
    /// (content) — see `protocol.md` §6.4. The codec's internal
    /// `pub(crate) DecryptCause` flows through its own
    /// `tracing::debug!(stage = ?cause)` inside `decode_note`; the
    /// host plugin emits an additional `outcome = "cannot_decrypt"`
    /// stage but does not re-introduce the distinguisher at the IPC
    /// boundary.
    #[error("note cannot be decrypted")]
    CannotDecrypt,

    /// AEAD authenticity passed but the recovered plaintext bytes are
    /// not valid UTF-8. Distinct from [`Self::CannotDecrypt`] because
    /// `protocol.md` §6.4's non-distinguishing rule covers AEAD-tag
    /// failure (which leaks credential validity); UTF-8 invalid
    /// post-AEAD-success is the not-reading kin of `InvalidVaultMeta`
    /// (structural corruption / foreign-writer suspicion). UI: "Not
    /// içeriği bozuk olabilir, backup'tan restore et."
    #[error("plaintext is not valid utf-8")]
    InvalidPlaintextEncoding,

    /// `<vault>/notes` exists as a regular file rather than a
    /// directory — defensive bug-canary parallel to
    /// [`NoteCreateError::NotesDirNotADirectory`] /
    /// [`NoteUpdateError::NotesDirNotADirectory`] /
    /// [`NoteDeleteError::NotesDirNotADirectory`]. Fires for dev-tools
    /// manipulation, disk corruption, or cross-process race edge cases.
    #[error("vault notes path is not a directory")]
    NotesDirNotADirectory,

    /// File-system IO failure during `notes_dir` resolution or the
    /// blob read. `NotFound` is special-cased upstream as
    /// [`Self::NoteNotFound`]; `NotADirectory` / `AlreadyExists` are
    /// special-cased as [`Self::NotesDirNotADirectory`]; only
    /// `PermissionDenied` / `NoSpace` / `Other` surface here.
    #[error("io error")]
    Io { io_error_kind: IoFailureKind },

    /// `tokio::task::spawn_blocking` join handle returned an error.
    /// User-facing CTA is "try again".
    #[error("blocking task join failure")]
    JoinFailure,
}

impl From<std::io::Error> for NoteReadError {
    fn from(e: std::io::Error) -> Self {
        // `NotFound` is special-cased by the calling command (mapped
        // to `NoteNotFound` for the distinct user message). This
        // `From` handles the residual cases.
        NoteReadError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

/// Single error type returned across the IPC boundary by
/// [`super::commands::note_update`].
///
/// Hand-mirrored on the TS side at `src/types/note-update-error.ts`.
/// Variant set is closed; adding a variant is an IPC contract change
/// that requires updating both sides.
///
/// Asymmetry vs [`NoteCreateError`] is intentional and pinned by
/// `decisions.md` 2026-05-07 "`note_update` error surface: 8 variant,
/// p1 + q1, drift-free MYND-26 mirror" (now 9 with [`Self::BaseMismatch`]
/// — the expected-base guard closing the pull-write↔reload ms race):
///
/// - ⊕ `NoteNotFound` — file missing. Distinct from `CannotDecrypt`
///   (q1 decision): the §6.4 non-distinguishing rule covers credential-
///   validity leak (wrong-password vs wrong-vault Argon2id partition
///   oracle); update path runs after vault unlocked + items_key in hand
///   + password verified, so "file missing" leaks no credential-validity
///     information. Surfaces the autosave-after-delete race signal which
///     the UI session-aware-folds to "kullanıcı sildi, autosave yetişemedi" —
///     clean affordance that `CannotDecrypt` would muddle with sahte data-loss
///     alarm.
/// - ⊕ `CannotDecrypt` — existing blob fails AEAD. §6.4 non-
///   distinguishing applies; the codec emits its sub-cause via
///   `tracing::debug!`, host adds `outcome = "cannot_decrypt"` without
///   re-introducing the distinguisher.
/// - ⊖ `NoteAlreadyExists` removed — `atomic_write(replace=true)`
///   semantic; create-only canary not applicable to update.
/// - ⊖ `InvalidPlaintextEncoding` removed — update flow never converts
///   old plaintext bytes to UTF-8 (codec content_type-agnostic per
///   `decisions.md` 2026-05-07 "Plaintext IPC: String both directions";
///   bytes discarded inside spawn_blocking; new plaintext arrives as
///   `String` at IPC boundary → UTF-8 guaranteed by Tauri serde).
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum NoteUpdateError {
    /// Slot is `Empty` or `Recovering`. Frontend routes the user to the
    /// lock screen via `vault_status` / `vault_slot_kind`; if this
    /// surfaces from `note_update`, a router bug.
    #[error("vault not unlocked")]
    VaultNotUnlocked,

    /// `note_id` failed strict parse via `super::note_id::NoteId::parse`.
    /// The internal sub-cause is emitted via `tracing::debug!(stage = ?cause)`
    /// for ops debugging and **does not** cross the IPC boundary as a
    /// distinguisher. Bug-canary: backend always returns canonical
    /// `note_id` strings, so anything else is a UI regression.
    #[error("invalid note id")]
    InvalidNoteId,

    /// `<vault>/notes/<note_id>.myn` does not exist. UI: "Bu not silinmiş
    /// olabilir." Distinct from `CannotDecrypt` per the q1 decision (see
    /// type-level rationale).
    #[error("note not found")]
    NoteNotFound,

    /// Plaintext exceeds `protocol::MAX_PLAINTEXT_LEN` (16 MiB cap).
    /// Mapped from `protocol::ProtocolError::PlaintextTooLarge` returned
    /// by `encode_update`; **no host-side pre-check** — protocol crate
    /// is the sole canonical enforcement point per `decisions.md`
    /// 2026-05-06 "Per-note ciphertext_len cap at 16 MiB" + 2026-05-07
    /// "`note_update` error surface" rationale.
    #[error("plaintext too large")]
    PlaintextTooLarge,

    /// AEAD-tag failure on `decode_note` of the existing `.myn` blob.
    /// **By design this single tag does NOT distinguish** parse-level
    /// failure (magic / version / reserved / `enc_item_key_len` / cap),
    /// `items_key_id` mismatch, outer-AEAD failure (`enc_item_key`
    /// wrap), or inner-AEAD failure (content) — see `protocol.md` §6.4.
    /// The codec's internal `pub(crate) DecryptCause` flows through its
    /// own `tracing::debug!(stage = ?cause)` inside `decode_note`; the
    /// host plugin emits a parallel `outcome = "cannot_decrypt"` event
    /// without re-introducing the distinguisher at the IPC boundary.
    #[error("note cannot be decrypted")]
    CannotDecrypt,

    /// `<vault>/notes` exists as a regular file rather than a directory.
    /// Defensive bug-canary parallel to
    /// [`NoteCreateError::NotesDirNotADirectory`] — fires for dev-tools
    /// manipulation, disk corruption, or cross-process race edge cases.
    /// UI surfaces a `<FailClosedError reason="invalid-state" />` for
    /// "vault yapısı bozuk, uygulamayı yeniden başlat".
    #[error("vault notes path is not a directory")]
    NotesDirNotADirectory,

    /// File-system IO failure during `notes_dir` resolution, blob read,
    /// or `atomic_write`. The bounded [`IoFailureKind`] keeps OS error
    /// messages off the wire.
    #[error("io error")]
    Io { io_error_kind: IoFailureKind },

    /// `tokio::task::spawn_blocking` join handle returned an error
    /// (panic in the blocking task, runtime shutdown). User-facing CTA
    /// is "try again".
    #[error("blocking task join failure")]
    JoinFailure,

    /// The on-disk plaintext no longer matches the caller-declared base
    /// (`expected_base_hash_hex`): a sync pull-apply landed between the
    /// editor's last save/reload and this save. **Nothing was written** —
    /// the caller preserves its buffer via the local keep-both path
    /// (conflict copy + reload). Only the desktop autosave opts in; every
    /// other caller (and mobile) omits the base and keeps legacy
    /// last-write-wins. No §6.4 concern: fires post-unlock and leaks no
    /// credential-validity information; distinct from `CannotDecrypt` /
    /// `NoteNotFound` because the UI affordance differs (keep-both vs
    /// deleted-note fold).
    #[error("expected base mismatch")]
    BaseMismatch,
}

impl From<std::io::Error> for NoteUpdateError {
    fn from(e: std::io::Error) -> Self {
        // `NotFound` is special-cased by the calling command (mapped to
        // `NoteNotFound` for the autosave-after-delete race fold).
        // `NotADirectory` / `AlreadyExists` are mapped to
        // `NotesDirNotADirectory` upstream. This `From` handles the
        // residual cases where an `io::Error` bubbles up unclassified.
        NoteUpdateError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

/// Single error type returned across the IPC boundary by
/// [`super::commands::note_write_batch_transactional`] — the §8.3
/// all-or-nothing multi-note rewrite that backs wikilink rename
/// auto-update (MYND-85 / WL-7).
///
/// Hand-mirrored on the TS side at `src/types/note-batch-error.ts`.
/// Variant set is closed; adding a variant is an IPC contract change
/// that requires updating both sides.
///
/// The variant set is **identical to [`NoteUpdateError`]** by design:
/// the batch is N parallel `note_update` AEAD pipelines committed under
/// one transaction, so every per-note failure mode (`NoteNotFound`,
/// `CannotDecrypt`, `PlaintextTooLarge`, `InvalidNoteId`) and every
/// structural / IO / join failure is reachable here too. A failure on
/// **any** note aborts the **whole** batch with the vault left
/// pre-rename (`note_txn::write_batch_transactional`); there is no
/// per-item partial-success surface — that is the §8.3 guarantee. The
/// failure tag never names *which* note failed (no `note_id` crosses
/// the boundary as a distinguisher; `src-tauri/CLAUDE.md`
/// secret-handling discipline).
///
/// The one variant that is **not** "the vault is unchanged" is
/// [`NoteBatchError::CommittedPendingPublish`], and it carries that meaning
/// precisely so callers stop having to assume (myne#300). §8.3 is a
/// crash-atomicity guarantee: past the commit marker the batch completes on the
/// next open, so an error there says "not yet finished", not "did not happen".
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum NoteBatchError {
    /// Slot is `Empty` or `Recovering`. Frontend routes the user to the
    /// lock screen; if this surfaces from a rename auto-update, a router
    /// bug (rename runs only while unlocked).
    #[error("vault not unlocked")]
    VaultNotUnlocked,

    /// One of the batch's `note_id` strings failed strict parse via
    /// `super::note_id::NoteId::parse` — checked for every entry BEFORE
    /// any filesystem touch, so a malformed id never reaches a path. The
    /// internal sub-cause is emitted via `tracing::debug!(stage = ?cause)`
    /// and does **not** cross the IPC boundary as a distinguisher.
    /// Bug-canary: the orchestrator only ever passes canonical ids.
    #[error("invalid note id")]
    InvalidNoteId,

    /// A `<vault>/notes/<note_id>.myn` in the batch does not exist —
    /// e.g. an inbound note was deleted between the rewrite plan and the
    /// commit. The whole batch aborts untouched (nothing staged).
    #[error("note not found")]
    NoteNotFound,

    /// A rewritten body exceeds `protocol::MAX_PLAINTEXT_LEN` (16 MiB).
    /// Mapped from `protocol::ProtocolError::PlaintextTooLarge`; the
    /// protocol crate is the sole enforcement point (no host pre-check).
    #[error("plaintext too large")]
    PlaintextTooLarge,

    /// AEAD-tag failure decoding an existing `.myn` blob in the batch.
    /// Non-distinguishing per `protocol.md` §6.4 — same boundary policy
    /// as [`NoteUpdateError::CannotDecrypt`].
    #[error("note cannot be decrypted")]
    CannotDecrypt,

    /// `<vault>/notes` exists as a regular file rather than a directory —
    /// defensive bug-canary parallel to the matching variant on the
    /// other notes-error enums.
    #[error("vault notes path is not a directory")]
    NotesDirNotADirectory,

    /// File-system IO failure during `notes_dir` resolution, a blob read,
    /// or the transactional **stage** phase. The vault is unchanged: nothing
    /// was staged past the failure, every staged temp was swept, and no commit
    /// marker survives. The bounded [`IoFailureKind`] keeps OS error messages
    /// off the wire.
    ///
    /// Post-commit IO failures do **not** land here — see
    /// [`NoteBatchError::CommittedPendingPublish`].
    #[error("io error")]
    Io { io_error_kind: IoFailureKind },

    /// The batch **committed**, and publishing it to its final `.myn` paths
    /// did not finish (myne#300).
    ///
    /// This is not "the write failed". The `.rename-journal` marker is durable
    /// and deliberately left on disk, so `note_txn::recover_pending_rename`
    /// publishes every still-staged blob at the next vault open — the rewrite
    /// completes whether or not the caller does anything. What is temporarily
    /// true is that the vault reads inconsistently until then: some notes carry
    /// the new title while an inbound one may still say `[[Old Title]]`.
    ///
    /// **Callers must not roll back on this.** Folding it into
    /// [`NoteBatchError::Io`] — which every caller reads as "the vault is
    /// unchanged" — is what made a rename the user was told had failed reappear
    /// after the next unlock, with the sidebar showing the old title in between.
    #[error("batch committed, publish incomplete")]
    CommittedPendingPublish { io_error_kind: IoFailureKind },

    /// `tokio::task::spawn_blocking` join handle returned an error
    /// (panic in the blocking task, runtime shutdown). Also the landing
    /// site for the `unreachable!` v0.1 AEAD-seal-failure path. CTA:
    /// "try again".
    #[error("blocking task join failure")]
    JoinFailure,
}

impl From<std::io::Error> for NoteBatchError {
    fn from(e: std::io::Error) -> Self {
        // `NotFound` (blob read) is special-cased at the call site
        // (mapped to `NoteNotFound`). This `From` handles the residual
        // cases where an `io::Error` bubbles up unclassified.
        NoteBatchError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

/// Single error type returned across the IPC boundary by
/// [`super::commands::note_delete`].
///
/// Hand-mirrored on the TS side at `src/types/note-delete-error.ts`.
///
/// Asymmetry vs [`NoteUpdateError`] is intentional and pinned by
/// `decisions.md` 2026-05-07 "`note_delete` durability: Unix parent-dir
/// `sync_all` only; Windows s1 best-effort":
///
/// - ⊖ `PlaintextTooLarge` removed — delete carries no plaintext.
/// - ⊖ `CannotDecrypt` removed — delete does no AEAD; cryptographic
///   erase is structural via the v0.1 key hierarchy per `decisions.md`
///   2026-05-07 "Note delete cryptographic erase: structural property"
///   (`unlink` removes both ciphertext and the only on-disk copy of the
///   wrapped item_key in one operation; without `itemsKey` in RAM the
///   bytes remain indistinguishable from random).
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum NoteDeleteError {
    /// Slot is `Empty` or `Recovering`.
    #[error("vault not unlocked")]
    VaultNotUnlocked,

    /// `note_id` failed strict parse via `NoteId::parse`. UI-bug-canary;
    /// internal cause emitted via `tracing::debug!(stage = ?cause)`.
    #[error("invalid note id")]
    InvalidNoteId,

    /// `<vault>/notes/<note_id>.myn` does not exist. **Strict at IPC,
    /// idempotent at UI** per `decisions.md` 2026-05-07 "Note delete UX:
    /// hard-delete in v0.1, vault-internal soft-trash deferred to v0.2"
    /// — the second `note_delete` invoke for the same `note_id` returns
    /// this variant, but the UI folds it to a "note already gone" toast
    /// (autosave-after-delete race + double-click idempotency).
    #[error("note not found")]
    NoteNotFound,

    /// `<vault>/notes` exists as a regular file rather than a directory.
    /// Defensive bug-canary parallel to
    /// [`NoteCreateError::NotesDirNotADirectory`] and
    /// [`NoteUpdateError::NotesDirNotADirectory`].
    #[error("vault notes path is not a directory")]
    NotesDirNotADirectory,

    /// File-system IO failure during `notes_dir` resolution or
    /// `remove_file` / parent-dir `sync_all`. `NotFound` is special-
    /// cased upstream as [`Self::NoteNotFound`].
    #[error("io error")]
    Io { io_error_kind: IoFailureKind },

    /// `tokio::task::spawn_blocking` join handle returned an error.
    /// User-facing CTA is "try again". Uniform with the other three
    /// notes-plugin commands per `decisions.md` 2026-05-07 "Note AEAD
    /// ops: clone-out items_key + always spawn_blocking" — `note_delete`
    /// touches no AEAD but follows the same `spawn_blocking` shape so
    /// `parent_dir.sync_all()` (Unix) cannot block the tokio runtime
    /// under ext4 journal commit / NFS / FUSE / AV-overlay scanner
    /// worst cases.
    #[error("blocking task join failure")]
    JoinFailure,
}

impl From<std::io::Error> for NoteDeleteError {
    fn from(e: std::io::Error) -> Self {
        // `NotFound` is special-cased by the calling command (mapped to
        // `NoteNotFound`). `NotADirectory` / `AlreadyExists` are mapped
        // to `NotesDirNotADirectory` upstream. This `From` handles the
        // residual cases.
        NoteDeleteError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

/// Single error type returned across the IPC boundary by
/// [`super::commands::note_list`].
///
/// Hand-mirrored on the TS side at `src/types/note-list-error.ts` (Task
/// 5 of `agent-tooling/features/mynd-28-note-list/tasks.md` — lock-step
/// with the structural plumbing changes; intentionally NOT in this task).
///
/// Asymmetry vs the other four notes-error enums: list operates on **no
/// specific note** and performs **no decryption**. The variants
/// `NoteNotFound`, `CannotDecrypt`, `InvalidNoteId`, `PlaintextTooLarge`,
/// `NoteAlreadyExists`, `InvalidPlaintextEncoding` are therefore not
/// applicable. The remaining 4 variants mirror the matching variants in
/// the other four enums byte-for-byte (review-fatigue unification per
/// `decisions.md` 2026-05-06 "Naming-discipline > scenario-optimization").
///
/// Spec touchpoints:
///
/// - `decisions.md` 2026-05-02 — slot state machine (the
///   `Slot::Unlocked` guard `VaultNotUnlocked` rejects).
/// - `decisions.md` 2026-05-07 "Note AEAD ops: clone-out items_key +
///   always spawn_blocking" — uniform `spawn_blocking` pattern that
///   feeds `JoinFailure`. `note_list` joins the pattern even though it
///   does no AEAD (Q4e of the MYND-28 grilling: NFS / FUSE / AV-overlay
///   topology violates the laboratuvar "`read_dir` ucuz" assumption).
/// - `agent-tooling/sessions/grill/2026-05-07-mynd-28-note-list.md` Q4d —
///   variant set rationale + naming mirror.
///
/// See: ../../CLAUDE.md "Secret-handling logging discipline".
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum NoteListError {
    /// Slot is `Empty` or `Recovering`. Frontend routes the user to the
    /// lock screen via `vault_status` / `vault_slot_kind`; if this
    /// surfaces from `note_list`, a router bug.
    #[error("vault not unlocked")]
    VaultNotUnlocked,

    /// `<vault>/notes` exists as a regular file rather than a directory.
    /// Defensive bug-canary parallel to the matching variant in the
    /// other four notes-error enums — fires for dev-tools manipulation,
    /// disk corruption, or cross-process race edge cases.
    #[error("vault notes path is not a directory")]
    NotesDirNotADirectory,

    /// File-system IO failure during `notes_dir` resolution or per-entry
    /// `read_dir` enumeration. The bounded [`IoFailureKind`] keeps OS
    /// error messages off the wire. `NotADirectory` / `AlreadyExists`
    /// are special-cased upstream as [`Self::NotesDirNotADirectory`];
    /// only `PermissionDenied` / `NoSpace` / `Other` surface here.
    #[error("io error")]
    Io { io_error_kind: IoFailureKind },

    /// `tokio::task::spawn_blocking` join handle returned an error
    /// (panic in the blocking task, runtime shutdown). User-facing CTA
    /// is "try again". Uniform with the other four notes-plugin
    /// commands.
    #[error("blocking task join failure")]
    JoinFailure,
}

impl From<std::io::Error> for NoteListError {
    fn from(e: std::io::Error) -> Self {
        // `NotADirectory` / `AlreadyExists` are special-cased by the
        // calling command (mapped to `NotesDirNotADirectory` upstream).
        // This `From` handles the residual cases where an `io::Error`
        // bubbles up unclassified.
        NoteListError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

/// Per-item error returned by [`super::commands::note_titles_batch`] for
/// a single ID inside the batch. The batch outer Result carries
/// [`NoteTitleBatchError`] for preconditions that abort the whole call;
/// individual notes that fail decrypt or are race-deleted surface here
/// without aborting peers (per the 2026-05-15 MYND-82 grill Q4 per-item
/// Result decision).
///
/// Hand-mirrored on the TS side at `src/types/note-title-error.ts`.
/// Variant set is closed — adding a variant requires updating both
/// sides of the IPC.
///
/// Note: `InvalidNoteId` is **not** a per-item variant. The implementation
/// maps a malformed `note_id` string to `NoteNotFound` — the canonical ID
/// set is produced by `note_list`, so anything else is a UI bug AND the
/// file doesn't exist on disk under the parsed path; surfacing
/// `NoteNotFound` keeps the user experience honest (the row drops out of
/// the sidebar).
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum NoteTitleError {
    /// AEAD-tag failure on `decode_note` for this note. The same
    /// `protocol.md` §6.4 non-distinguishing rule applies as in
    /// [`NoteReadError::CannotDecrypt`] — the codec's internal sub-cause
    /// flows through `tracing::debug!` without reaching the IPC layer.
    /// In `note_titles_batch`, this surfaces as a per-item canary that
    /// the UI renders inline (italic error icon next to the row's
    /// "Untitled" placeholder, tooltip "Couldn't load this note").
    #[error("note cannot be decrypted")]
    CannotDecrypt,

    /// `<vault>/notes/<note_id>.myn` does not exist. Surfaces the race
    /// between `note_list` (returning a UUID set) and `note_titles_batch`
    /// (decrypting them) — a `note_delete` landing in between drops the
    /// file. UI optimistic-removes the row when this surfaces.
    #[error("note not found")]
    NoteNotFound,

    /// Per-file IO failure during the blob read or directory traversal
    /// for this single note. `NotFound` is special-cased upstream as
    /// [`Self::NoteNotFound`].
    #[error("io error")]
    Io { io_error_kind: IoFailureKind },

    /// `tokio::task::spawn_blocking` join handle returned an error for
    /// this single item's decrypt task. Other items in the batch
    /// proceed independently (per-item Result semantic).
    #[error("blocking task join failure")]
    JoinFailure,
}

impl From<std::io::Error> for NoteTitleError {
    fn from(e: std::io::Error) -> Self {
        // `NotFound` is special-cased by the calling command (mapped to
        // `NoteNotFound`). This `From` handles the residual cases.
        NoteTitleError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

/// Single error type returned across the IPC boundary by
/// [`super::commands::note_titles_batch`] when a precondition fails and
/// the whole call aborts before per-item decryption begins. Per-item
/// failures use [`NoteTitleError`] (inner Result).
///
/// Hand-mirrored on the TS side at `src/types/note-title-batch-error.ts`.
///
/// Spec touchpoints:
///
/// - `decisions.md` 2026-05-15 "Note title write target" (companion
///   entry; this batch command serves the read side of the same FM
///   `title:` ↳ first `# H1` ↳ None precedence chain).
/// - `agent-tooling/sessions/grill/2026-05-15-mynd-82-sidebar-autosave.md`
///   Q4 (per-item Result vs fail-whole-batch decision) + Q5 (hard cap
///   100 to prevent Tokio blocking-pool saturation).
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum NoteTitleBatchError {
    /// Slot is `Empty` or `Recovering`. Frontend routes the user to
    /// the lock screen via `vault_status`; if this surfaces from
    /// `note_titles_batch`, a router bug.
    #[error("vault not unlocked")]
    VaultNotUnlocked,

    /// `<vault>/notes` exists as a regular file rather than a
    /// directory — defensive bug-canary parallel to the matching
    /// variant on the other notes-error enums.
    #[error("vault notes path is not a directory")]
    NotesDirNotADirectory,

    /// Input `ids.len()` exceeded the per-call cap (100 per the 2026-
    /// 05-15 MYND-82 grill Q5 decision). UI is expected to chunk inputs
    /// at `cap` and fire chunks via `Promise.all`; this variant fires
    /// only when a caller bypasses the chunking convention or a UI bug
    /// passes the full `note_list` output unchunked. The cap value is
    /// carried in the payload so callers can introspect it without
    /// hard-coding.
    #[error("batch too large")]
    BatchTooLarge { cap: usize },

    /// File-system IO failure during `notes_dir` resolution. Per-item
    /// reads route their IO failures through [`NoteTitleError::Io`]
    /// instead.
    #[error("io error")]
    Io { io_error_kind: IoFailureKind },

    /// `tokio::task::spawn_blocking` join handle returned an error at
    /// the batch-coordination level (e.g., panic in the outer
    /// dispatcher). Per-item join failures route through
    /// [`NoteTitleError::JoinFailure`] instead.
    ///
    /// `#[allow(dead_code)]`: reserved for forward-compat — the current
    /// implementation collapses outer-dispatcher panics into the per-item
    /// `NoteTitleError::JoinFailure` path. If a future refactor introduces
    /// a non-per-item batch coordinator (e.g., bounded-parallel semaphore
    /// wrapping the dispatch), this variant becomes its surface.
    #[allow(dead_code)]
    #[error("blocking task join failure")]
    JoinFailure,
}

impl From<std::io::Error> for NoteTitleBatchError {
    fn from(e: std::io::Error) -> Self {
        NoteTitleBatchError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

/// Single error type returned across the IPC boundary by
/// [`super::commands::note_export_as_markdown`].
///
/// Hand-mirrored on the TS side at `src/types/note-export-error.ts`.
/// Variant set is closed; adding a variant is an IPC contract change
/// that requires updating both sides.
///
/// Asymmetry vs [`NoteReadError`] is intentional (MYND-115, export-suite
/// PRD "Error enum" decision):
///
/// - ⊕ `InvalidDestination` — the user-chosen `target_path` has no
///   existing parent directory (backup precedent:
///   `BackupExportError::InvalidDestination`).
/// - ⊕ `TargetAlreadyExists` — `overwrite=false` collision with an
///   existing file at `target_path`; consent travels explicitly (the OS
///   save dialog is the consent source), so the backend never silently
///   clobbers (`decisions.md` 2026-06-11 export-suite overwrite-consent
///   rule).
/// - ⊖ `NotesDirNotADirectory` removed — the export read path treats a
///   corrupt `<vault>/notes` shape as a residual `Io` failure; the CRUD
///   commands own the structural bug-canary.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum NoteExportError {
    /// Slot is `Empty` or `Recovering`. Frontend routes the user to the
    /// lock screen via `vault_status` / `vault_slot_kind`; if this
    /// surfaces from `note_export_as_markdown`, a router bug.
    #[error("vault not unlocked")]
    VaultNotUnlocked,

    /// `note_id` failed strict parse via `super::note_id::NoteId::parse`
    /// — checked strictly BEFORE any path use, so a malformed id never
    /// touches the filesystem. The internal sub-cause is emitted via
    /// `tracing::debug!(stage = ?cause)` and does **not** cross the IPC
    /// boundary as a distinguisher. Bug-canary: backend always returns
    /// canonical `note_id` strings, so anything else is a UI regression.
    #[error("invalid note id")]
    InvalidNoteId,

    /// `<vault>/notes/<note_id>.myn` does not exist. UI: "Bu not
    /// silinmiş olabilir." A normal user-flow outcome (note deleted
    /// between the context-menu open and the dialog confirm).
    #[error("note not found")]
    NoteNotFound,

    /// AEAD-tag failure on `decode_note`. **By design this single tag
    /// does NOT distinguish** parse-level failure, `items_key_id`
    /// mismatch, outer-AEAD failure, or inner-AEAD failure — see
    /// `protocol.md` §6.4. The codec's internal sub-cause flows through
    /// its own `tracing::debug!` inside `decode_note`.
    #[error("note cannot be decrypted")]
    CannotDecrypt,

    /// AEAD authenticity passed but the recovered plaintext bytes are
    /// not valid UTF-8 — mirror of
    /// [`NoteReadError::InvalidPlaintextEncoding`] (structural
    /// corruption / foreign-writer suspicion). The export never writes
    /// the garbage bytes: corruption is surfaced, not exported.
    #[error("plaintext is not valid utf-8")]
    InvalidPlaintextEncoding,

    /// The user-chosen `target_path` is not usable: its parent directory
    /// does not exist or is not a directory (backup precedent —
    /// `BackupExportError::InvalidDestination`). The OS save dialog
    /// normally guarantees a valid parent; this fires when the directory
    /// vanished between dialog confirm and the write.
    #[error("destination is invalid")]
    InvalidDestination,

    /// `overwrite=false` and a file already exists at `target_path`.
    /// Mapped from the `atomic_write(replace=false)` pre-rename
    /// `AlreadyExists` check, which fires before the temp sibling is
    /// created — the existing target is untouched. The caller decides
    /// whether to re-invoke with `overwrite=true` (the OS dialog's
    /// "Replace" consent).
    #[error("target file already exists")]
    TargetAlreadyExists,

    /// File-system IO failure during `notes_dir` resolution, the blob
    /// read, or the destination write. The bounded [`IoFailureKind`]
    /// keeps OS error messages off the wire. `NotFound` on the blob read
    /// is special-cased upstream as [`Self::NoteNotFound`];
    /// `AlreadyExists` on the write as [`Self::TargetAlreadyExists`].
    #[error("io error")]
    Io { io_error_kind: IoFailureKind },

    /// `tokio::task::spawn_blocking` join handle returned an error
    /// (panic in the blocking task, runtime shutdown). User-facing CTA
    /// is "try again".
    #[error("blocking task join failure")]
    JoinFailure,
}

impl From<std::io::Error> for NoteExportError {
    fn from(e: std::io::Error) -> Self {
        // `NotFound` (blob read) and `AlreadyExists` (destination write)
        // are special-cased by the calling command (mapped to
        // `NoteNotFound` / `TargetAlreadyExists`). This `From` handles
        // the residual cases where an `io::Error` bubbles up
        // unclassified.
        NoteExportError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

/// Single error type returned across the IPC boundary by
/// [`super::commands::note_export_attachments`] — the opt-in
/// attachments-included export sibling (MYND-115 task 4).
///
/// Hand-mirrored on the TS side at `src/types/note-export-error.ts`.
/// Variant set is closed; adding a variant is an IPC contract change
/// that requires updating both sides.
///
/// A SEPARATE enum from [`NoteExportError`] (not an extension): the
/// sibling command has its own failure surface (note-filename
/// bug-canary, `vault.meta`/catalog access, per-attachment outcomes)
/// and folding those into the verbatim path's enum would force its TS
/// consumers to handle variants that path can never produce.
///
/// **All-or-nothing contract:** every referenced attachment is catalog-
/// resolved AND decrypted in memory BEFORE the first byte lands at the
/// destination, so [`Self::AttachmentMissing`] /
/// [`Self::AttachmentCorrupt`] (and every pre-write variant) leave the
/// destination untouched. A residual write-phase IO failure rolls back
/// the files this invocation created (best-effort), never pre-existing
/// ones.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum NoteExportAttachmentsError {
    /// Slot is `Empty` or `Recovering` — same routing as
    /// [`NoteExportError::VaultNotUnlocked`].
    #[error("vault not unlocked")]
    VaultNotUnlocked,

    /// `note_id` failed strict parse — checked BEFORE any path use;
    /// mirror of [`NoteExportError::InvalidNoteId`].
    #[error("invalid note id")]
    InvalidNoteId,

    /// `note_filename` is not a bare, legal filename (empty, `.`/`..`,
    /// or contains a path separator). Bug-canary: the UI derives the
    /// name from the OS save dialog's final path component, so anything
    /// else is a frontend regression — never sanitized host-side.
    #[error("invalid note filename")]
    InvalidNoteFilename,

    /// `<vault>/notes/<note_id>.myn` does not exist.
    #[error("note not found")]
    NoteNotFound,

    /// AEAD-tag failure decrypting the NOTE blob (non-distinguishing
    /// per `protocol.md` §6.4) — mirror of
    /// [`NoteExportError::CannotDecrypt`]. Attachment-blob decrypt
    /// failures surface as [`Self::AttachmentCorrupt`] instead.
    #[error("note cannot be decrypted")]
    CannotDecrypt,

    /// Note AEAD passed but the plaintext is not valid UTF-8 — the
    /// export writes nothing (corruption surfaced, not exported).
    #[error("plaintext is not valid utf-8")]
    InvalidPlaintextEncoding,

    /// `vault.meta` exists but does not parse — the attachments-catalog
    /// AAD identity (`account_number_hash`) cannot be read, so no
    /// referenced attachment can be resolved. Only reachable when the
    /// note references at least one attachment (the no-embeds path
    /// never touches `vault.meta`).
    #[error("vault metadata is invalid")]
    InvalidVaultMeta,

    /// The user-chosen `target_dir` does not exist or is not a
    /// directory (backup precedent — the OS dialog normally guarantees
    /// it; this fires when it vanished between confirm and write).
    #[error("destination is invalid")]
    InvalidDestination,

    /// `overwrite=false` and a file already exists at
    /// `<target_dir>/<note_filename>` — the NOTE file's overwrite
    /// consent (SYNC-2); checked BEFORE any attachment write so the
    /// rejection leaves the destination untouched. Attachment files are
    /// NEVER overwritten regardless of this flag (they suffix-dedup).
    #[error("note target file already exists")]
    TargetAlreadyExists,

    /// A referenced attachment is missing: its id has no
    /// `vault.attachments` catalog entry, or the catalog entry exists
    /// but the `attachments/<id>` blob file is gone. Detected during
    /// the pre-write validation pass — nothing was written.
    #[error("referenced attachment is missing")]
    AttachmentMissing,

    /// A referenced attachment's blob exists but fails to decrypt
    /// (AEAD-tag failure — corruption / tampering). Detected during the
    /// pre-write validation pass — nothing was written.
    #[error("referenced attachment cannot be decrypted")]
    AttachmentCorrupt,

    /// Residual file-system IO failure (vault reads or destination
    /// writes). `NotFound` on the note read is special-cased upstream
    /// as [`Self::NoteNotFound`]; on a blob read as
    /// [`Self::AttachmentMissing`].
    #[error("io error")]
    Io { io_error_kind: IoFailureKind },

    /// `tokio::task::spawn_blocking` join handle returned an error.
    #[error("blocking task join failure")]
    JoinFailure,
}

impl From<std::io::Error> for NoteExportAttachmentsError {
    fn from(e: std::io::Error) -> Self {
        // `NotFound` / `AlreadyExists` are special-cased at the call
        // sites; this `From` handles the residual unclassified cases.
        NoteExportAttachmentsError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn serialize_create(e: &NoteCreateError) -> String {
        serde_json::to_string(e).expect("NoteCreateError must serialize cleanly")
    }
    fn serialize_read(e: &NoteReadError) -> String {
        serde_json::to_string(e).expect("NoteReadError must serialize cleanly")
    }

    // ---- NoteCreateError serde shape ------------------------------------

    #[test]
    fn create_vault_not_unlocked_serializes_with_kind_tag() {
        assert_eq!(
            serialize_create(&NoteCreateError::VaultNotUnlocked),
            r#"{"kind":"VaultNotUnlocked"}"#
        );
    }

    #[test]
    fn create_note_already_exists_serializes_with_kind_tag() {
        assert_eq!(
            serialize_create(&NoteCreateError::NoteAlreadyExists),
            r#"{"kind":"NoteAlreadyExists"}"#
        );
    }

    #[test]
    fn create_plaintext_too_large_serializes_with_kind_tag() {
        assert_eq!(
            serialize_create(&NoteCreateError::PlaintextTooLarge),
            r#"{"kind":"PlaintextTooLarge"}"#
        );
    }

    #[test]
    fn create_notes_dir_not_a_directory_serializes_with_kind_tag() {
        assert_eq!(
            serialize_create(&NoteCreateError::NotesDirNotADirectory),
            r#"{"kind":"NotesDirNotADirectory"}"#
        );
    }

    #[test]
    fn create_io_serializes_with_io_failure_kind_payload() {
        let e = NoteCreateError::Io {
            io_error_kind: IoFailureKind::PermissionDenied,
        };
        assert_eq!(
            serialize_create(&e),
            r#"{"kind":"Io","detail":{"io_error_kind":"PermissionDenied"}}"#
        );
    }

    #[test]
    fn create_join_failure_serializes_with_kind_tag() {
        assert_eq!(
            serialize_create(&NoteCreateError::JoinFailure),
            r#"{"kind":"JoinFailure"}"#
        );
    }

    // ---- NoteReadError serde shape -------------------------------------

    #[test]
    fn read_note_not_found_serializes_with_kind_tag() {
        assert_eq!(
            serialize_read(&NoteReadError::NoteNotFound),
            r#"{"kind":"NoteNotFound"}"#
        );
    }

    #[test]
    fn read_invalid_note_id_serializes_with_kind_tag() {
        assert_eq!(
            serialize_read(&NoteReadError::InvalidNoteId),
            r#"{"kind":"InvalidNoteId"}"#
        );
    }

    #[test]
    fn read_vault_not_unlocked_serializes_with_kind_tag() {
        assert_eq!(
            serialize_read(&NoteReadError::VaultNotUnlocked),
            r#"{"kind":"VaultNotUnlocked"}"#
        );
    }

    #[test]
    fn read_cannot_decrypt_serializes_with_kind_tag() {
        assert_eq!(
            serialize_read(&NoteReadError::CannotDecrypt),
            r#"{"kind":"CannotDecrypt"}"#
        );
    }

    #[test]
    fn read_invalid_plaintext_encoding_serializes_with_kind_tag() {
        assert_eq!(
            serialize_read(&NoteReadError::InvalidPlaintextEncoding),
            r#"{"kind":"InvalidPlaintextEncoding"}"#
        );
    }

    #[test]
    fn read_notes_dir_not_a_directory_serializes_with_kind_tag() {
        assert_eq!(
            serialize_read(&NoteReadError::NotesDirNotADirectory),
            r#"{"kind":"NotesDirNotADirectory"}"#
        );
    }

    #[test]
    fn read_io_serializes_with_io_failure_kind_payload() {
        let e = NoteReadError::Io {
            io_error_kind: IoFailureKind::Other,
        };
        assert_eq!(
            serialize_read(&e),
            r#"{"kind":"Io","detail":{"io_error_kind":"Other"}}"#
        );
    }

    #[test]
    fn read_join_failure_serializes_with_kind_tag() {
        assert_eq!(
            serialize_read(&NoteReadError::JoinFailure),
            r#"{"kind":"JoinFailure"}"#
        );
    }

    // ---- Closed-payload exhaustiveness pin ------------------------------
    //
    // Mirror of `vault_unlock::error::tests::all_variants_have_closed_
    // payloads_only`. If a future variant is added to either enum, the
    // exhaustive match below stops compiling; the reviewer must add the
    // new arm AND verify the new variant's payload is closed (no
    // `String`, no unbounded-shape data crossing the IPC boundary).

    #[test]
    fn create_all_variants_have_closed_payloads_only() {
        fn assert_closed(e: &NoteCreateError) {
            match e {
                NoteCreateError::VaultNotUnlocked => {}
                NoteCreateError::NoteAlreadyExists => {}
                NoteCreateError::PlaintextTooLarge => {}
                NoteCreateError::NotesDirNotADirectory => {}
                NoteCreateError::Io { io_error_kind: _ } => {}
                NoteCreateError::JoinFailure => {}
            }
        }
        assert_closed(&NoteCreateError::VaultNotUnlocked);
    }

    #[test]
    fn read_all_variants_have_closed_payloads_only() {
        fn assert_closed(e: &NoteReadError) {
            match e {
                NoteReadError::NoteNotFound => {}
                NoteReadError::InvalidNoteId => {}
                NoteReadError::VaultNotUnlocked => {}
                NoteReadError::CannotDecrypt => {}
                NoteReadError::InvalidPlaintextEncoding => {}
                NoteReadError::NotesDirNotADirectory => {}
                NoteReadError::Io { io_error_kind: _ } => {}
                NoteReadError::JoinFailure => {}
            }
        }
        assert_closed(&NoteReadError::NoteNotFound);
    }

    // ---- From<std::io::Error> mapping ----------------------------------

    #[test]
    fn create_from_io_error_routes_via_closed_enum_for_permission_denied() {
        let raw = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let mapped: NoteCreateError = raw.into();
        match mapped {
            NoteCreateError::Io { io_error_kind } => {
                assert_eq!(io_error_kind, IoFailureKind::PermissionDenied);
            }
            other => panic!("expected Io variant, got {other:?}"),
        }
    }

    #[test]
    fn create_from_io_error_unknown_kind_collapses_to_other() {
        let raw = std::io::Error::from(std::io::ErrorKind::AlreadyExists);
        let mapped: NoteCreateError = raw.into();
        match mapped {
            NoteCreateError::Io { io_error_kind } => {
                assert_eq!(io_error_kind, IoFailureKind::Other);
            }
            other => panic!("expected Io variant, got {other:?}"),
        }
    }

    #[test]
    fn read_from_io_error_routes_via_closed_enum_for_permission_denied() {
        let raw = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let mapped: NoteReadError = raw.into();
        match mapped {
            NoteReadError::Io { io_error_kind } => {
                assert_eq!(io_error_kind, IoFailureKind::PermissionDenied);
            }
            other => panic!("expected Io variant, got {other:?}"),
        }
    }

    #[test]
    fn read_from_io_error_no_space_collapses_to_no_space() {
        let raw = std::io::Error::from(std::io::ErrorKind::StorageFull);
        let mapped: NoteReadError = raw.into();
        match mapped {
            NoteReadError::Io { io_error_kind } => {
                assert_eq!(io_error_kind, IoFailureKind::NoSpace);
            }
            other => panic!("expected Io variant, got {other:?}"),
        }
    }

    // =====================================================================
    // NoteUpdateError
    // =====================================================================

    fn serialize_update(e: &NoteUpdateError) -> String {
        serde_json::to_string(e).expect("NoteUpdateError must serialize cleanly")
    }

    // ---- NoteUpdateError serde shape -----------------------------------

    #[test]
    fn update_vault_not_unlocked_serializes_with_kind_tag() {
        assert_eq!(
            serialize_update(&NoteUpdateError::VaultNotUnlocked),
            r#"{"kind":"VaultNotUnlocked"}"#
        );
    }

    #[test]
    fn update_invalid_note_id_serializes_with_kind_tag() {
        assert_eq!(
            serialize_update(&NoteUpdateError::InvalidNoteId),
            r#"{"kind":"InvalidNoteId"}"#
        );
    }

    #[test]
    fn update_note_not_found_serializes_with_kind_tag() {
        assert_eq!(
            serialize_update(&NoteUpdateError::NoteNotFound),
            r#"{"kind":"NoteNotFound"}"#
        );
    }

    #[test]
    fn update_plaintext_too_large_serializes_with_kind_tag() {
        assert_eq!(
            serialize_update(&NoteUpdateError::PlaintextTooLarge),
            r#"{"kind":"PlaintextTooLarge"}"#
        );
    }

    #[test]
    fn update_cannot_decrypt_serializes_with_kind_tag() {
        assert_eq!(
            serialize_update(&NoteUpdateError::CannotDecrypt),
            r#"{"kind":"CannotDecrypt"}"#
        );
    }

    #[test]
    fn update_notes_dir_not_a_directory_serializes_with_kind_tag() {
        assert_eq!(
            serialize_update(&NoteUpdateError::NotesDirNotADirectory),
            r#"{"kind":"NotesDirNotADirectory"}"#
        );
    }

    #[test]
    fn update_io_serializes_with_io_failure_kind_payload() {
        let e = NoteUpdateError::Io {
            io_error_kind: IoFailureKind::PermissionDenied,
        };
        assert_eq!(
            serialize_update(&e),
            r#"{"kind":"Io","detail":{"io_error_kind":"PermissionDenied"}}"#
        );
    }

    #[test]
    fn update_join_failure_serializes_with_kind_tag() {
        assert_eq!(
            serialize_update(&NoteUpdateError::JoinFailure),
            r#"{"kind":"JoinFailure"}"#
        );
    }

    // ---- Closed-payload exhaustiveness pin -----------------------------
    //
    // Mirror of `create_all_variants_have_closed_payloads_only` /
    // `read_all_variants_have_closed_payloads_only`. If a future variant
    // is added to `NoteUpdateError`, the exhaustive match below stops
    // compiling; the reviewer must add the new arm AND verify the new
    // variant's payload is closed (no `String`, no unbounded-shape data
    // crossing the IPC boundary).

    #[test]
    fn update_all_variants_have_closed_payloads_only() {
        fn assert_closed(e: &NoteUpdateError) {
            match e {
                NoteUpdateError::VaultNotUnlocked => {}
                NoteUpdateError::InvalidNoteId => {}
                NoteUpdateError::NoteNotFound => {}
                NoteUpdateError::PlaintextTooLarge => {}
                NoteUpdateError::CannotDecrypt => {}
                NoteUpdateError::NotesDirNotADirectory => {}
                NoteUpdateError::Io { io_error_kind: _ } => {}
                NoteUpdateError::JoinFailure => {}
                NoteUpdateError::BaseMismatch => {}
            }
        }
        assert_closed(&NoteUpdateError::VaultNotUnlocked);
    }

    // ---- From<std::io::Error> mapping ----------------------------------

    #[test]
    fn update_from_io_error_routes_via_closed_enum_for_permission_denied() {
        let raw = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let mapped: NoteUpdateError = raw.into();
        match mapped {
            NoteUpdateError::Io { io_error_kind } => {
                assert_eq!(io_error_kind, IoFailureKind::PermissionDenied);
            }
            other => panic!("expected Io variant, got {other:?}"),
        }
    }

    #[test]
    fn update_from_io_error_unknown_kind_collapses_to_other() {
        // `AlreadyExists` is special-cased by the calling command upstream
        // (routed to `NotesDirNotADirectory` per the `paths::notes_dir`
        // accept-list). The bare `From<io::Error>` impl falls through to
        // `Other`; this pins the residual-case behavior.
        let raw = std::io::Error::from(std::io::ErrorKind::AlreadyExists);
        let mapped: NoteUpdateError = raw.into();
        match mapped {
            NoteUpdateError::Io { io_error_kind } => {
                assert_eq!(io_error_kind, IoFailureKind::Other);
            }
            other => panic!("expected Io variant, got {other:?}"),
        }
    }

    // =====================================================================
    // NoteBatchError
    // =====================================================================

    fn serialize_batch(e: &NoteBatchError) -> String {
        serde_json::to_string(e).expect("NoteBatchError must serialize cleanly")
    }

    // ---- NoteBatchError serde shape ------------------------------------

    #[test]
    fn batch_vault_not_unlocked_serializes_with_kind_tag() {
        assert_eq!(
            serialize_batch(&NoteBatchError::VaultNotUnlocked),
            r#"{"kind":"VaultNotUnlocked"}"#
        );
    }

    #[test]
    fn batch_invalid_note_id_serializes_with_kind_tag() {
        assert_eq!(
            serialize_batch(&NoteBatchError::InvalidNoteId),
            r#"{"kind":"InvalidNoteId"}"#
        );
    }

    #[test]
    fn batch_note_not_found_serializes_with_kind_tag() {
        assert_eq!(
            serialize_batch(&NoteBatchError::NoteNotFound),
            r#"{"kind":"NoteNotFound"}"#
        );
    }

    #[test]
    fn batch_plaintext_too_large_serializes_with_kind_tag() {
        assert_eq!(
            serialize_batch(&NoteBatchError::PlaintextTooLarge),
            r#"{"kind":"PlaintextTooLarge"}"#
        );
    }

    #[test]
    fn batch_cannot_decrypt_serializes_with_kind_tag() {
        assert_eq!(
            serialize_batch(&NoteBatchError::CannotDecrypt),
            r#"{"kind":"CannotDecrypt"}"#
        );
    }

    #[test]
    fn batch_notes_dir_not_a_directory_serializes_with_kind_tag() {
        assert_eq!(
            serialize_batch(&NoteBatchError::NotesDirNotADirectory),
            r#"{"kind":"NotesDirNotADirectory"}"#
        );
    }

    #[test]
    fn batch_io_serializes_with_io_failure_kind_payload() {
        let e = NoteBatchError::Io {
            io_error_kind: IoFailureKind::NoSpace,
        };
        assert_eq!(
            serialize_batch(&e),
            r#"{"kind":"Io","detail":{"io_error_kind":"NoSpace"}}"#
        );
    }

    #[test]
    fn batch_join_failure_serializes_with_kind_tag() {
        assert_eq!(
            serialize_batch(&NoteBatchError::JoinFailure),
            r#"{"kind":"JoinFailure"}"#
        );
    }

    // ---- Closed-payload exhaustiveness pin -----------------------------
    //
    // Mirror of `update_all_variants_have_closed_payloads_only`. If a
    // future variant is added to `NoteBatchError`, the exhaustive match
    // stops compiling; the reviewer must add the arm AND verify the new
    // variant's payload is closed (no `String`, no `note_id`, no
    // unbounded-shape data crossing the IPC boundary).

    #[test]
    fn batch_all_variants_have_closed_payloads_only() {
        fn assert_closed(e: &NoteBatchError) {
            match e {
                NoteBatchError::VaultNotUnlocked => {}
                NoteBatchError::InvalidNoteId => {}
                NoteBatchError::NoteNotFound => {}
                NoteBatchError::PlaintextTooLarge => {}
                NoteBatchError::CannotDecrypt => {}
                NoteBatchError::NotesDirNotADirectory => {}
                NoteBatchError::Io { io_error_kind: _ } => {}
                NoteBatchError::CommittedPendingPublish { io_error_kind: _ } => {}
                NoteBatchError::JoinFailure => {}
            }
        }
        assert_closed(&NoteBatchError::VaultNotUnlocked);
    }

    /// The post-commit variant's wire shape, pinned like every other: the TS
    /// mirror narrows on `kind`, and a caller that does not recognize the tag
    /// falls back to "the vault is unchanged" — the exact wrong answer here
    /// (myne#300).
    #[test]
    fn batch_committed_pending_publish_serializes_with_kind_tag() {
        let e = NoteBatchError::CommittedPendingPublish {
            io_error_kind: IoFailureKind::NoSpace,
        };
        assert_eq!(
            serialize_batch(&e),
            r#"{"kind":"CommittedPendingPublish","detail":{"io_error_kind":"NoSpace"}}"#
        );
    }

    // ---- From<std::io::Error> mapping ----------------------------------

    #[test]
    fn batch_from_io_error_routes_via_closed_enum_for_permission_denied() {
        let raw = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let mapped: NoteBatchError = raw.into();
        match mapped {
            NoteBatchError::Io { io_error_kind } => {
                assert_eq!(io_error_kind, IoFailureKind::PermissionDenied);
            }
            other => panic!("expected Io variant, got {other:?}"),
        }
    }

    #[test]
    fn batch_from_io_error_no_space_collapses_to_no_space() {
        let raw = std::io::Error::from(std::io::ErrorKind::StorageFull);
        let mapped: NoteBatchError = raw.into();
        match mapped {
            NoteBatchError::Io { io_error_kind } => {
                assert_eq!(io_error_kind, IoFailureKind::NoSpace);
            }
            other => panic!("expected Io variant, got {other:?}"),
        }
    }

    // =====================================================================
    // NoteDeleteError
    // =====================================================================

    fn serialize_delete(e: &NoteDeleteError) -> String {
        serde_json::to_string(e).expect("NoteDeleteError must serialize cleanly")
    }

    // ---- NoteDeleteError serde shape -----------------------------------

    #[test]
    fn delete_vault_not_unlocked_serializes_with_kind_tag() {
        assert_eq!(
            serialize_delete(&NoteDeleteError::VaultNotUnlocked),
            r#"{"kind":"VaultNotUnlocked"}"#
        );
    }

    #[test]
    fn delete_invalid_note_id_serializes_with_kind_tag() {
        assert_eq!(
            serialize_delete(&NoteDeleteError::InvalidNoteId),
            r#"{"kind":"InvalidNoteId"}"#
        );
    }

    #[test]
    fn delete_note_not_found_serializes_with_kind_tag() {
        assert_eq!(
            serialize_delete(&NoteDeleteError::NoteNotFound),
            r#"{"kind":"NoteNotFound"}"#
        );
    }

    #[test]
    fn delete_notes_dir_not_a_directory_serializes_with_kind_tag() {
        assert_eq!(
            serialize_delete(&NoteDeleteError::NotesDirNotADirectory),
            r#"{"kind":"NotesDirNotADirectory"}"#
        );
    }

    #[test]
    fn delete_io_serializes_with_io_failure_kind_payload() {
        let e = NoteDeleteError::Io {
            io_error_kind: IoFailureKind::Other,
        };
        assert_eq!(
            serialize_delete(&e),
            r#"{"kind":"Io","detail":{"io_error_kind":"Other"}}"#
        );
    }

    #[test]
    fn delete_join_failure_serializes_with_kind_tag() {
        assert_eq!(
            serialize_delete(&NoteDeleteError::JoinFailure),
            r#"{"kind":"JoinFailure"}"#
        );
    }

    // ---- Closed-payload exhaustiveness pin -----------------------------

    #[test]
    fn delete_all_variants_have_closed_payloads_only() {
        fn assert_closed(e: &NoteDeleteError) {
            match e {
                NoteDeleteError::VaultNotUnlocked => {}
                NoteDeleteError::InvalidNoteId => {}
                NoteDeleteError::NoteNotFound => {}
                NoteDeleteError::NotesDirNotADirectory => {}
                NoteDeleteError::Io { io_error_kind: _ } => {}
                NoteDeleteError::JoinFailure => {}
            }
        }
        assert_closed(&NoteDeleteError::VaultNotUnlocked);
    }

    // ---- From<std::io::Error> mapping ----------------------------------

    #[test]
    fn delete_from_io_error_routes_via_closed_enum_for_permission_denied() {
        let raw = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let mapped: NoteDeleteError = raw.into();
        match mapped {
            NoteDeleteError::Io { io_error_kind } => {
                assert_eq!(io_error_kind, IoFailureKind::PermissionDenied);
            }
            other => panic!("expected Io variant, got {other:?}"),
        }
    }

    #[test]
    fn delete_from_io_error_no_space_collapses_to_no_space() {
        let raw = std::io::Error::from(std::io::ErrorKind::StorageFull);
        let mapped: NoteDeleteError = raw.into();
        match mapped {
            NoteDeleteError::Io { io_error_kind } => {
                assert_eq!(io_error_kind, IoFailureKind::NoSpace);
            }
            other => panic!("expected Io variant, got {other:?}"),
        }
    }

    // =====================================================================
    // NoteListError
    // =====================================================================

    fn serialize_list(e: &NoteListError) -> String {
        serde_json::to_string(e).expect("NoteListError must serialize cleanly")
    }

    // ---- NoteListError serde shape -------------------------------------

    #[test]
    fn list_vault_not_unlocked_serializes_with_kind_tag() {
        assert_eq!(
            serialize_list(&NoteListError::VaultNotUnlocked),
            r#"{"kind":"VaultNotUnlocked"}"#
        );
    }

    #[test]
    fn list_notes_dir_not_a_directory_serializes_with_kind_tag() {
        assert_eq!(
            serialize_list(&NoteListError::NotesDirNotADirectory),
            r#"{"kind":"NotesDirNotADirectory"}"#
        );
    }

    #[test]
    fn list_io_serializes_with_io_failure_kind_payload() {
        let e = NoteListError::Io {
            io_error_kind: IoFailureKind::PermissionDenied,
        };
        assert_eq!(
            serialize_list(&e),
            r#"{"kind":"Io","detail":{"io_error_kind":"PermissionDenied"}}"#
        );
    }

    #[test]
    fn list_join_failure_serializes_with_kind_tag() {
        assert_eq!(
            serialize_list(&NoteListError::JoinFailure),
            r#"{"kind":"JoinFailure"}"#
        );
    }

    // ---- Closed-payload exhaustiveness pin -----------------------------

    #[test]
    fn list_all_variants_have_closed_payloads_only() {
        fn assert_closed(e: &NoteListError) {
            match e {
                NoteListError::VaultNotUnlocked => {}
                NoteListError::NotesDirNotADirectory => {}
                NoteListError::Io { io_error_kind: _ } => {}
                NoteListError::JoinFailure => {}
            }
        }
        assert_closed(&NoteListError::VaultNotUnlocked);
    }

    // ---- From<std::io::Error> mapping ----------------------------------

    #[test]
    fn list_from_io_error_routes_via_closed_enum_for_permission_denied() {
        let raw = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let mapped: NoteListError = raw.into();
        match mapped {
            NoteListError::Io { io_error_kind } => {
                assert_eq!(io_error_kind, IoFailureKind::PermissionDenied);
            }
            other => panic!("expected Io variant, got {other:?}"),
        }
    }

    #[test]
    fn list_from_io_error_no_space_collapses_to_no_space() {
        let raw = std::io::Error::from(std::io::ErrorKind::StorageFull);
        let mapped: NoteListError = raw.into();
        match mapped {
            NoteListError::Io { io_error_kind } => {
                assert_eq!(io_error_kind, IoFailureKind::NoSpace);
            }
            other => panic!("expected Io variant, got {other:?}"),
        }
    }

    // =====================================================================
    // NoteTitleError (per-item)
    // =====================================================================

    fn serialize_title(e: &NoteTitleError) -> String {
        serde_json::to_string(e).expect("NoteTitleError must serialize cleanly")
    }

    #[test]
    fn title_cannot_decrypt_serializes_with_kind_tag() {
        assert_eq!(
            serialize_title(&NoteTitleError::CannotDecrypt),
            r#"{"kind":"CannotDecrypt"}"#
        );
    }

    #[test]
    fn title_note_not_found_serializes_with_kind_tag() {
        assert_eq!(
            serialize_title(&NoteTitleError::NoteNotFound),
            r#"{"kind":"NoteNotFound"}"#
        );
    }

    #[test]
    fn title_io_serializes_with_io_failure_kind_payload() {
        let e = NoteTitleError::Io {
            io_error_kind: IoFailureKind::PermissionDenied,
        };
        assert_eq!(
            serialize_title(&e),
            r#"{"kind":"Io","detail":{"io_error_kind":"PermissionDenied"}}"#
        );
    }

    #[test]
    fn title_join_failure_serializes_with_kind_tag() {
        assert_eq!(
            serialize_title(&NoteTitleError::JoinFailure),
            r#"{"kind":"JoinFailure"}"#
        );
    }

    #[test]
    fn title_all_variants_have_closed_payloads_only() {
        fn assert_closed(e: &NoteTitleError) {
            match e {
                NoteTitleError::CannotDecrypt => {}
                NoteTitleError::NoteNotFound => {}
                NoteTitleError::Io { io_error_kind: _ } => {}
                NoteTitleError::JoinFailure => {}
            }
        }
        assert_closed(&NoteTitleError::CannotDecrypt);
    }

    #[test]
    fn title_from_io_error_routes_via_closed_enum_for_permission_denied() {
        let raw = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let mapped: NoteTitleError = raw.into();
        match mapped {
            NoteTitleError::Io { io_error_kind } => {
                assert_eq!(io_error_kind, IoFailureKind::PermissionDenied);
            }
            other => panic!("expected Io variant, got {other:?}"),
        }
    }

    // =====================================================================
    // NoteTitleBatchError (batch-level)
    // =====================================================================

    fn serialize_title_batch(e: &NoteTitleBatchError) -> String {
        serde_json::to_string(e).expect("NoteTitleBatchError must serialize cleanly")
    }

    #[test]
    fn title_batch_vault_not_unlocked_serializes_with_kind_tag() {
        assert_eq!(
            serialize_title_batch(&NoteTitleBatchError::VaultNotUnlocked),
            r#"{"kind":"VaultNotUnlocked"}"#
        );
    }

    #[test]
    fn title_batch_notes_dir_not_a_directory_serializes_with_kind_tag() {
        assert_eq!(
            serialize_title_batch(&NoteTitleBatchError::NotesDirNotADirectory),
            r#"{"kind":"NotesDirNotADirectory"}"#
        );
    }

    #[test]
    fn title_batch_too_large_serializes_with_cap_payload() {
        assert_eq!(
            serialize_title_batch(&NoteTitleBatchError::BatchTooLarge { cap: 100 }),
            r#"{"kind":"BatchTooLarge","detail":{"cap":100}}"#
        );
    }

    #[test]
    fn title_batch_io_serializes_with_io_failure_kind_payload() {
        let e = NoteTitleBatchError::Io {
            io_error_kind: IoFailureKind::Other,
        };
        assert_eq!(
            serialize_title_batch(&e),
            r#"{"kind":"Io","detail":{"io_error_kind":"Other"}}"#
        );
    }

    #[test]
    fn title_batch_join_failure_serializes_with_kind_tag() {
        assert_eq!(
            serialize_title_batch(&NoteTitleBatchError::JoinFailure),
            r#"{"kind":"JoinFailure"}"#
        );
    }

    #[test]
    fn title_batch_all_variants_have_closed_payloads_only() {
        fn assert_closed(e: &NoteTitleBatchError) {
            match e {
                NoteTitleBatchError::VaultNotUnlocked => {}
                NoteTitleBatchError::NotesDirNotADirectory => {}
                NoteTitleBatchError::BatchTooLarge { cap: _ } => {}
                NoteTitleBatchError::Io { io_error_kind: _ } => {}
                NoteTitleBatchError::JoinFailure => {}
            }
        }
        assert_closed(&NoteTitleBatchError::VaultNotUnlocked);
    }

    #[test]
    fn title_batch_from_io_error_routes_via_closed_enum_for_permission_denied() {
        let raw = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let mapped: NoteTitleBatchError = raw.into();
        match mapped {
            NoteTitleBatchError::Io { io_error_kind } => {
                assert_eq!(io_error_kind, IoFailureKind::PermissionDenied);
            }
            other => panic!("expected Io variant, got {other:?}"),
        }
    }

    // =====================================================================
    // NoteExportError
    // =====================================================================

    fn serialize_export(e: &NoteExportError) -> String {
        serde_json::to_string(e).expect("NoteExportError must serialize cleanly")
    }

    // ---- NoteExportError serde shape -----------------------------------

    #[test]
    fn export_vault_not_unlocked_serializes_with_kind_tag() {
        assert_eq!(
            serialize_export(&NoteExportError::VaultNotUnlocked),
            r#"{"kind":"VaultNotUnlocked"}"#
        );
    }

    #[test]
    fn export_invalid_note_id_serializes_with_kind_tag() {
        assert_eq!(
            serialize_export(&NoteExportError::InvalidNoteId),
            r#"{"kind":"InvalidNoteId"}"#
        );
    }

    #[test]
    fn export_note_not_found_serializes_with_kind_tag() {
        assert_eq!(
            serialize_export(&NoteExportError::NoteNotFound),
            r#"{"kind":"NoteNotFound"}"#
        );
    }

    #[test]
    fn export_cannot_decrypt_serializes_with_kind_tag() {
        assert_eq!(
            serialize_export(&NoteExportError::CannotDecrypt),
            r#"{"kind":"CannotDecrypt"}"#
        );
    }

    #[test]
    fn export_invalid_plaintext_encoding_serializes_with_kind_tag() {
        assert_eq!(
            serialize_export(&NoteExportError::InvalidPlaintextEncoding),
            r#"{"kind":"InvalidPlaintextEncoding"}"#
        );
    }

    #[test]
    fn export_invalid_destination_serializes_with_kind_tag() {
        assert_eq!(
            serialize_export(&NoteExportError::InvalidDestination),
            r#"{"kind":"InvalidDestination"}"#
        );
    }

    #[test]
    fn export_target_already_exists_serializes_with_kind_tag() {
        assert_eq!(
            serialize_export(&NoteExportError::TargetAlreadyExists),
            r#"{"kind":"TargetAlreadyExists"}"#
        );
    }

    #[test]
    fn export_io_serializes_with_io_failure_kind_payload() {
        let e = NoteExportError::Io {
            io_error_kind: IoFailureKind::PermissionDenied,
        };
        assert_eq!(
            serialize_export(&e),
            r#"{"kind":"Io","detail":{"io_error_kind":"PermissionDenied"}}"#
        );
    }

    #[test]
    fn export_join_failure_serializes_with_kind_tag() {
        assert_eq!(
            serialize_export(&NoteExportError::JoinFailure),
            r#"{"kind":"JoinFailure"}"#
        );
    }

    // ---- Closed-payload exhaustiveness pin -----------------------------

    #[test]
    fn export_all_variants_have_closed_payloads_only() {
        fn assert_closed(e: &NoteExportError) {
            match e {
                NoteExportError::VaultNotUnlocked => {}
                NoteExportError::InvalidNoteId => {}
                NoteExportError::NoteNotFound => {}
                NoteExportError::CannotDecrypt => {}
                NoteExportError::InvalidPlaintextEncoding => {}
                NoteExportError::InvalidDestination => {}
                NoteExportError::TargetAlreadyExists => {}
                NoteExportError::Io { io_error_kind: _ } => {}
                NoteExportError::JoinFailure => {}
            }
        }
        assert_closed(&NoteExportError::VaultNotUnlocked);
    }

    // ---- From<std::io::Error> mapping ----------------------------------

    #[test]
    fn export_from_io_error_routes_via_closed_enum_for_permission_denied() {
        let raw = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let mapped: NoteExportError = raw.into();
        match mapped {
            NoteExportError::Io { io_error_kind } => {
                assert_eq!(io_error_kind, IoFailureKind::PermissionDenied);
            }
            other => panic!("expected Io variant, got {other:?}"),
        }
    }

    #[test]
    fn export_from_io_error_no_space_collapses_to_no_space() {
        let raw = std::io::Error::from(std::io::ErrorKind::StorageFull);
        let mapped: NoteExportError = raw.into();
        match mapped {
            NoteExportError::Io { io_error_kind } => {
                assert_eq!(io_error_kind, IoFailureKind::NoSpace);
            }
            other => panic!("expected Io variant, got {other:?}"),
        }
    }

    // =====================================================================
    // NoteExportAttachmentsError
    // =====================================================================

    fn serialize_export_attachments(e: &NoteExportAttachmentsError) -> String {
        serde_json::to_string(e).expect("NoteExportAttachmentsError must serialize cleanly")
    }

    // ---- NoteExportAttachmentsError serde shape -------------------------

    #[test]
    fn export_attachments_unit_variants_serialize_with_kind_tag() {
        for (e, expected) in [
            (
                NoteExportAttachmentsError::VaultNotUnlocked,
                r#"{"kind":"VaultNotUnlocked"}"#,
            ),
            (
                NoteExportAttachmentsError::InvalidNoteId,
                r#"{"kind":"InvalidNoteId"}"#,
            ),
            (
                NoteExportAttachmentsError::InvalidNoteFilename,
                r#"{"kind":"InvalidNoteFilename"}"#,
            ),
            (
                NoteExportAttachmentsError::NoteNotFound,
                r#"{"kind":"NoteNotFound"}"#,
            ),
            (
                NoteExportAttachmentsError::CannotDecrypt,
                r#"{"kind":"CannotDecrypt"}"#,
            ),
            (
                NoteExportAttachmentsError::InvalidPlaintextEncoding,
                r#"{"kind":"InvalidPlaintextEncoding"}"#,
            ),
            (
                NoteExportAttachmentsError::InvalidVaultMeta,
                r#"{"kind":"InvalidVaultMeta"}"#,
            ),
            (
                NoteExportAttachmentsError::InvalidDestination,
                r#"{"kind":"InvalidDestination"}"#,
            ),
            (
                NoteExportAttachmentsError::TargetAlreadyExists,
                r#"{"kind":"TargetAlreadyExists"}"#,
            ),
            (
                NoteExportAttachmentsError::AttachmentMissing,
                r#"{"kind":"AttachmentMissing"}"#,
            ),
            (
                NoteExportAttachmentsError::AttachmentCorrupt,
                r#"{"kind":"AttachmentCorrupt"}"#,
            ),
            (
                NoteExportAttachmentsError::JoinFailure,
                r#"{"kind":"JoinFailure"}"#,
            ),
        ] {
            assert_eq!(serialize_export_attachments(&e), expected);
        }
    }

    #[test]
    fn export_attachments_io_serializes_with_io_failure_kind_payload() {
        let e = NoteExportAttachmentsError::Io {
            io_error_kind: IoFailureKind::NoSpace,
        };
        assert_eq!(
            serialize_export_attachments(&e),
            r#"{"kind":"Io","detail":{"io_error_kind":"NoSpace"}}"#
        );
    }

    // ---- Closed-payload exhaustiveness pin -----------------------------

    #[test]
    fn export_attachments_all_variants_have_closed_payloads_only() {
        fn assert_closed(e: &NoteExportAttachmentsError) {
            match e {
                NoteExportAttachmentsError::VaultNotUnlocked => {}
                NoteExportAttachmentsError::InvalidNoteId => {}
                NoteExportAttachmentsError::InvalidNoteFilename => {}
                NoteExportAttachmentsError::NoteNotFound => {}
                NoteExportAttachmentsError::CannotDecrypt => {}
                NoteExportAttachmentsError::InvalidPlaintextEncoding => {}
                NoteExportAttachmentsError::InvalidVaultMeta => {}
                NoteExportAttachmentsError::InvalidDestination => {}
                NoteExportAttachmentsError::TargetAlreadyExists => {}
                NoteExportAttachmentsError::AttachmentMissing => {}
                NoteExportAttachmentsError::AttachmentCorrupt => {}
                NoteExportAttachmentsError::Io { io_error_kind: _ } => {}
                NoteExportAttachmentsError::JoinFailure => {}
            }
        }
        assert_closed(&NoteExportAttachmentsError::VaultNotUnlocked);
    }

    // ---- From<std::io::Error> mapping ----------------------------------

    #[test]
    fn export_attachments_from_io_error_routes_via_closed_enum() {
        let raw = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let mapped: NoteExportAttachmentsError = raw.into();
        match mapped {
            NoteExportAttachmentsError::Io { io_error_kind } => {
                assert_eq!(io_error_kind, IoFailureKind::PermissionDenied);
            }
            other => panic!("expected Io variant, got {other:?}"),
        }
    }
}
