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
/// | `VaultAlreadyExists`         | `{"kind":"VaultAlreadyExists"}`                              |
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

    /// Defensive belt+suspenders guard: `vault.meta` already exists at
    /// the target path. **Expected to NEVER trigger in normal flow.**
    /// The frontend `vault_status` startup probe + state machine
    /// routing should prevent any path that re-enters create-vault when
    /// a vault is already present. If this surfaces, a frontend routing
    /// regression has bypassed those guards — the alternative (silent
    /// `atomic_write` overwrite) would destroy the prior vault's
    /// `root_key`, recovery phrase, and sealed `.myn` blobs
    /// irrecoverably. See `app-state-machine` grilling Q12 + PRD.
    #[error("vault already exists")]
    VaultAlreadyExists,

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
