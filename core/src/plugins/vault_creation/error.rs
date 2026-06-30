//! Tauri-layer error type bubbling up to the frontend.
//!
//! Mirrors `protocol::ProtocolError` in spirit (no `String` field
//! anywhere reaches the frontend) and adds the Tauri-specific
//! variants — session lookups, concurrency caps, IO failures.
//! Underlying detail (full `argon2::Error`, `std::io::Error` message)
//! is intentionally not surfaced.
//!
//! The `Io` variant carries a bounded [`IoErrorKind`] enum rather
//! than a `String` so OS error messages (which can include vault
//! paths) cannot leak into screenshots, crash reports, or future
//! Sentry feeds. Backend-side diagnostic logging (e.g. via `tracing`)
//! is a future hardening pass; until then, the underlying error
//! detail is dropped at the `From::from` boundary.

use serde::Serialize;
use thiserror::Error;

/// Single error type returned across the IPC boundary by the
/// vault-creation plugin's commands.
///
/// Serialization shape (with `tag = "kind", content = "detail"`):
///
/// | Variant                      | JSON                                                         |
/// |------------------------------|--------------------------------------------------------------|
/// | `Protocol(ProtocolError)`    | `{"kind":"Protocol","detail":{"kind":"AeadFailure"}}`        |
/// | `SessionNotFound`            | `{"kind":"SessionNotFound"}`                                 |
/// | `SessionExpired`             | `{"kind":"SessionExpired"}`                                  |
/// | `TooManyConcurrentSessions`  | `{"kind":"TooManyConcurrentSessions"}`                       |
/// | `JoinFailure`                | `{"kind":"JoinFailure"}`                                     |
/// | `Io { kind }`                | `{"kind":"Io","detail":{"kind":"PermissionDenied"}}`         |
/// | `VaultArtifactsPresent`      | `{"kind":"VaultArtifactsPresent"}`                           |
/// | `VaultBusyAuth`              | `{"kind":"VaultBusyAuth"}`                                   |
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum AppError {
    /// Protocol-layer failure bubbled from the `protocol` crate.
    #[error("protocol error")]
    Protocol(protocol::ProtocolError),

    /// Session token not present in the state map (already committed,
    /// already cancelled, never existed, or evicted by TTL — caller
    /// cannot tell which).
    #[error("session not found")]
    SessionNotFound,

    /// Session existed but exceeded its 10-minute TTL before commit.
    /// Returned by `commit` after the eviction task has run; cleaner
    /// frontend UX than `SessionNotFound` for the timeout case.
    #[error("session expired")]
    SessionExpired,

    /// Concurrent session cap (`MAX_CONCURRENT_SESSIONS`) reached.
    /// Frontend should surface "wait for an in-flight vault to
    /// complete or cancel".
    #[error("too many concurrent sessions")]
    TooManyConcurrentSessions,

    /// `tokio::task::spawn_blocking` join handle returned an error
    /// (panic in the blocking task, runtime shutdown, etc.).
    #[error("blocking task join failure")]
    JoinFailure,

    /// File-system error while writing/reading the vault. The bounded
    /// [`IoErrorKind`] keeps OS error messages (which can leak the
    /// vault path) off the wire.
    #[error("io error")]
    Io { kind: IoErrorKind },

    /// Defensive belt+suspenders guard: a recognized vault artefact is
    /// already present at the target path. Recognized artefacts are
    /// `vault.meta`, `vault.meta.tmp` (mid-write crash leftover from
    /// `atomic_write`), or a `notes/` directory containing one or more
    /// `*.myn` files (orphan blobs from a partial-fail `vault_delete`).
    /// **Expected to NEVER trigger in normal flow.**
    ///
    /// The frontend `vault_status` startup probe + state machine
    /// routing should prevent any path that re-enters create-vault when
    /// a vault is already present. If this surfaces, either (a) a
    /// frontend routing regression has bypassed those guards — the
    /// alternative (silent `atomic_write` overwrite) would destroy the
    /// prior vault's `root_key`, recovery phrase, and sealed `.myn`
    /// blobs irrecoverably; or (b) a prior `vault_delete` partial-fail
    /// left orphan artefacts that the user must manually clean (or, in
    /// v0.2, in-app via `vault_repair`, Plane MYND-159).
    ///
    /// Renamed from `VaultAlreadyExists` on 2026-05-26 per
    /// `decisions.md` "vault_create defensive guard extension". See
    /// `app-state-machine` grilling Q12 (original variant) +
    /// MYND-105 grill Q7 T2 (semantic broadening).
    #[error("vault artefacts present")]
    VaultArtifactsPresent,

    /// Backend min-length floor (`protocol::password_policy::MIN_PASSWORD_LEN`,
    /// currently 12 Unicode chars) rejected the new password. The
    /// frontend `PasswordForm` already gates this at submit time; the
    /// backend is a structural belt+suspenders defense against a
    /// frontend bypass (DevTools, hand-crafted IPC payload, future UI
    /// regression) per `decisions.md` 2026-05-06 "Auth-pipeline backend
    /// MIN_PASSWORD_LEN floor; project-wide retroactive". **Not** an
    /// entropy guarantee — zxcvbn-style entropy gating remains
    /// frontend-only.
    ///
    /// Cross-plugin shared variant name with
    /// `VaultRecoveryError::WeakNewPassword` (and the future
    /// `VaultPasswordChangeError::WeakNewPassword`) per the
    /// "naming-discipline > scenario-optimization" rule (Q6 of MYND-22
    /// grilling). Distinct Rust types, identical JSON wire encoding
    /// `{"kind":"WeakNewPassword"}`.
    #[error("weak new password")]
    WeakNewPassword,

    /// Another vault.meta-lifecycle operation holds the `auth_permits`
    /// capacity-1 semaphore. As of MYND-159 (`vault_repair`), `commit` is
    /// pulled into the same single-permit mutex that already serializes
    /// `vault_unlock` / `vault_recover_*` / `vault_change_password` /
    /// `vault_delete` — generalizing `auth_permits` from an Argon2id
    /// throttle into a **vault.meta-lifecycle mutex** so a concurrent
    /// `vault_repair` sweep can never race a fresh `commit` (TOCTOU). The
    /// command uses `try_acquire` (reject, never queue); the permit is
    /// released **before** `commit` returns so the frontend's subsequent
    /// auto-unlock `vault_unlock` acquires cleanly (no self-deadlock).
    /// Normally unreachable in the create flow — at creation time there is
    /// no vault to unlock / change / delete, so nothing else holds the
    /// permit; it fires only against a racing `vault_repair`.
    ///
    /// Cross-plugin shared variant name with
    /// `VaultDeleteError::VaultBusyAuth` per the "naming-discipline >
    /// scenario-optimization" rule (MYND-22 grill Q6). Distinct Rust type,
    /// identical JSON wire encoding `{"kind":"VaultBusyAuth"}`.
    #[error("vault busy with auth operation")]
    VaultBusyAuth,
}

/// Bounded categorization of IO failures surfaced from `std::io::Error`.
///
/// Frontend i18n maps each variant to a user-facing message. There is
/// no `String` payload anywhere — OS error messages are dropped at the
/// `From::from` boundary so vault paths cannot leak across IPC.
#[derive(Debug, Serialize)]
pub enum IoErrorKind {
    /// `std::io::ErrorKind::PermissionDenied`.
    PermissionDenied,
    /// `std::io::ErrorKind::StorageFull` / `WriteZero` for a write that
    /// reported full storage.
    NoSpace,
    /// `std::io::ErrorKind::NotFound` (e.g. vault directory missing
    /// during commit, which should be auto-created by `vault_dir`).
    NotFound,
    /// Catch-all for any other `std::io::ErrorKind`. The specific
    /// `std::io::ErrorKind` is discarded.
    Other,
}

impl From<protocol::ProtocolError> for AppError {
    fn from(e: protocol::ProtocolError) -> Self {
        AppError::Protocol(e)
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        let kind = match e.kind() {
            std::io::ErrorKind::PermissionDenied => IoErrorKind::PermissionDenied,
            std::io::ErrorKind::StorageFull | std::io::ErrorKind::WriteZero => IoErrorKind::NoSpace,
            std::io::ErrorKind::NotFound => IoErrorKind::NotFound,
            _ => IoErrorKind::Other,
        };
        AppError::Io { kind }
    }
}
