//! `prefs` plugin IPC error enums (MYND-160 Task 9).
//!
//! Two closed taxonomies — one for read, one for write — both
//! DENY-list clean per `src-tauri/CLAUDE.md` "Secret-handling logging
//! discipline" (no path strings, no key material, no kernel-error
//! display strings). Hand-mirrored on the TS side at
//! `src/types/prefs-error.ts` (Task 13).
//!
//! ## Read vs write asymmetry
//!
//! `prefs_read` returns `Ok(PrefsView::default())` on absent /
//! AEAD-fail / parse-fail per `docs/spec/protocol.md` § 9.5.5 — those
//! conditions do NOT surface as `PrefsReadError` variants. Only
//! Slot precondition violations (vault not unlocked) and unrecoverable
//! IO failures (e.g., permission denied on the vault dir entirely)
//! become read errors. This collapse is the MYND-160 grill Q3.4 +
//! Q6.3 fall-back-to-defaults discipline applied at the IPC boundary.
//!
//! `prefs_write` always surfaces real failures — a write that did not
//! commit cannot be silently masked because the frontend's optimistic-
//! rollback discipline (Task 13) depends on knowing the IPC outcome
//! to revert the toggle visually + show the error toast.

use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use serde::Serialize;
use thiserror::Error;

/// Failure surface for [`super::commands::prefs_read`].
///
/// Serialization shape (with `tag = "kind", content = "detail"`):
///
/// | Variant                              | JSON                                                                |
/// |--------------------------------------|---------------------------------------------------------------------|
/// | `SlotNotUnlocked`                    | `{"kind":"SlotNotUnlocked"}`                                        |
/// | `Io { io_error_kind }`               | `{"kind":"Io","detail":{"io_error_kind":"PermissionDenied"}}`       |
/// | `InvalidVaultMeta`                   | `{"kind":"InvalidVaultMeta"}`                                       |
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum PrefsReadError {
    /// `VaultRuntimeState`'s slot was not `Slot::Unlocked` when
    /// `prefs_read` ran. Frontend CTA: re-prompt for unlock. Bug-
    /// canary in the legitimate flow because the SettingsModal only
    /// mounts behind the unlock gate; routing regression or
    /// dev-tools injection are the only causes that should hit this
    /// in production.
    #[error("vault is not unlocked")]
    SlotNotUnlocked,

    /// Unrecoverable filesystem error reading `vault.meta` (we need
    /// `account_number_hash` from it to build the prefs AAD). The
    /// vault.prefs read itself NEVER surfaces an Io error — absent /
    /// truncated / AEAD-fail collapses to defaults per § 9.5.5.
    #[error("failed to read vault.meta for account_number_hash")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },

    /// `vault.meta` was read successfully but failed to parse
    /// (magic-byte mismatch, version mismatch, structural
    /// corruption). Distinct from `Io` because the file exists and
    /// is readable; the bytes themselves are wrong. Surfaces as a
    /// support-flow signal — "your vault.meta is corrupted" rather
    /// than "your prefs file is corrupted" (which is silently
    /// collapsed to defaults).
    #[error("vault.meta parse failed")]
    InvalidVaultMeta,
}

/// Failure surface for [`super::commands::set_screen_capture_protection`].
///
/// Serialization shape (with `tag = "kind", content = "detail"`):
///
/// | Variant                              | JSON                                                                |
/// |--------------------------------------|---------------------------------------------------------------------|
/// | `SlotNotUnlocked`                    | `{"kind":"SlotNotUnlocked"}`                                        |
/// | `Io { io_error_kind }`               | `{"kind":"Io","detail":{"io_error_kind":"NoSpace"}}`                |
/// | `InvalidVaultMeta`                   | `{"kind":"InvalidVaultMeta"}`                                       |
/// | `PrefsEncodeFailed`                  | `{"kind":"PrefsEncodeFailed"}`                                      |
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum PrefsWriteError {
    /// Same semantic as [`PrefsReadError::SlotNotUnlocked`] — caller
    /// invoked a write before unlock completed.
    #[error("vault is not unlocked")]
    SlotNotUnlocked,

    /// Filesystem error: reading `vault.meta` (for account_number_hash),
    /// reading `vault.prefs` (for the read-modify-write base), or
    /// writing `vault.prefs` via `atomic_write`. The closed-enum kind
    /// lets the frontend distinguish disk-full vs permission-denied
    /// vs structural for the error toast wording.
    #[error("filesystem error during prefs write")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },

    /// `vault.meta` parse failure during the account_number_hash
    /// extraction. Same surface as [`PrefsReadError::InvalidVaultMeta`].
    #[error("vault.meta parse failed")]
    InvalidVaultMeta,

    /// The write named a vault directory that is not the active (unlocked)
    /// vault (#250). The prefs key is derived from the unlocked slot's
    /// `root_key`, so writing it into another vault's directory produces a
    /// blob that vault can never read — and, through `read_or_default`'s
    /// degrade-to-defaults, quietly replaces its real settings. A caller
    /// seeing this passed a stale "which vault is active" answer; the fix is
    /// to thread the authoritative id, never to retry.
    #[error("prefs write targeted a vault that is not the active one")]
    VaultTargetMismatch,

    /// `protocol::encode_prefs_blob` returned an error — practically
    /// unreachable in v0.1 (PrefsView::default() and toggled-false
    /// both encode to ~35 bytes JSON, well under the 64 KiB cap), but
    /// preserved as a closed variant so future schema additions don't
    /// have a missing error surface.
    #[error("prefs blob encode failed")]
    PrefsEncodeFailed,

    /// The write carried a value outside the closed set this build accepts —
    /// today, an AI provider name that is not in `KNOWN_AI_PROVIDERS`
    /// (myne#415).
    ///
    /// Refusing rather than storing matters here: a stored value the code
    /// cannot honour would be a selection the user can see and the request
    /// path silently ignores, and a compromised WebView could park a name a
    /// FUTURE build would start honouring. Carries no echo of the rejected
    /// value — a settings field's contents reach logs and screenshots.
    #[error("prefs write carried a value outside the accepted set")]
    InvalidValue,

    /// The read-modify-write's READ degraded to defaults, so writing would
    /// persist those defaults over whatever is actually stored (test-audit
    /// #40).
    ///
    /// §9.5.5's "an absent or undecodable `vault.prefs` degrades to defaults,
    /// never fails" is a rule about READING — it keeps a vault openable. It is
    /// not a licence to WRITE those defaults back, and the difference is the
    /// whole of this variant: a read that degraded may be looking at a
    /// transiently unreadable blob (a full disk, an EIO, a torn copy on the
    /// web client's double buffer), and the user's real settings are still
    /// there. Persisting defaults over them turns a recoverable read failure
    /// into permanent loss — and because the SHARED prefs subset syncs, the
    /// defaults then propagate to every other device.
    ///
    /// `Absent` is deliberately NOT this. An absent file genuinely means "this
    /// vault has never written prefs", which is an answer rather than a
    /// failure, and is the normal state of every vault that has not opened
    /// Settings. The same distinction the attachment-import path already makes
    /// (`plugins/attachments/commands.rs`: it trusts `Absent`, refuses
    /// `Degraded`); this brings the write path in line with it.
    ///
    /// A caller seeing this should not retry blind: the vault's prefs could
    /// not be read, and the setting the user just changed was not saved.
    #[error("prefs write refused: the current prefs could not be read")]
    PrefsUnreadable,
}

impl From<std::io::Error> for PrefsReadError {
    fn from(e: std::io::Error) -> Self {
        PrefsReadError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

impl From<std::io::Error> for PrefsWriteError {
    fn from(e: std::io::Error) -> Self {
        PrefsWriteError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}
