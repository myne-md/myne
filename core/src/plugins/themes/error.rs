// SPDX-License-Identifier: AGPL-3.0
//! `themes` plugin IPC error enum (MYND-486).
//!
//! A single closed taxonomy for the read + write custom-theme commands, DENY-list
//! clean per `src-tauri/CLAUDE.md` "Secret-handling logging discipline" (no path
//! strings, no key material, no kernel-error display strings). The rich
//! [`theme_validator::ThemeError`] carried by [`ThemesError::Invalid`] surfaces
//! only the offending token name / source line — never a value, never a path.
//!
//! ## Read vs write asymmetry
//!
//! The read cores (`themes_list` / `themes_read` / `themes_export`) collapse
//! absent / AEAD-fail / parse-fail to the **empty theme store** per
//! `docs/spec/protocol.md` § 9.20.4 — those conditions do NOT surface here. Only
//! Slot precondition violations, unrecoverable `vault.meta` IO, and a
//! `themes_read`/`themes_export` on a name that is absent from the store
//! (`NotFound`) become read errors. The write cores (`themes_import` /
//! `themes_delete`) surface real failures (a write that did not commit cannot be
//! silently masked).

use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use serde::Serialize;
use theme_validator::ThemeError;
use thiserror::Error;

/// Failure surface for the `themes` custom-theme commands.
///
/// Serialization shape (with `tag = "kind", content = "detail"`):
///
/// | Variant                     | JSON                                                          |
/// |-----------------------------|---------------------------------------------------------------|
/// | `SlotNotUnlocked`           | `{"kind":"SlotNotUnlocked"}`                                  |
/// | `Io { io_error_kind }`      | `{"kind":"Io","detail":{"io_error_kind":"PermissionDenied"}}` |
/// | `InvalidVaultMeta`          | `{"kind":"InvalidVaultMeta"}`                                 |
/// | `NotFound`                  | `{"kind":"NotFound"}`                                         |
/// | `Encode`                    | `{"kind":"Encode"}`                                           |
/// | `Invalid { error }`         | `{"kind":"Invalid","detail":{"error":{...ThemeError...}}}`    |
#[derive(Debug, Error, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "detail")]
pub enum ThemesError {
    /// `VaultRuntimeState`'s slot was not `Slot::Unlocked` when the command ran.
    /// Frontend CTA: re-prompt for unlock. Bug-canary in the legitimate flow —
    /// the settings UI only mounts behind the unlock gate.
    #[error("vault is not unlocked")]
    SlotNotUnlocked,

    /// Unrecoverable filesystem error reading `vault.meta` (needed for the
    /// `account_number_hash` that binds the blob AAD) or writing `vault.themes`.
    /// The `vault.themes` READ itself never surfaces `Io` — absent / truncated /
    /// AEAD-fail collapses to the empty store per § 9.20.4.
    #[error("filesystem error during themes access")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },

    /// `vault.meta` was read but failed to parse (magic/version mismatch or
    /// structural corruption). Distinct from `Io` because the file exists and is
    /// readable; the bytes themselves are wrong.
    #[error("vault.meta parse failed")]
    InvalidVaultMeta,

    /// `themes_read` / `themes_export` for a name absent from the store.
    #[error("no custom theme with that name")]
    NotFound,

    /// `protocol::encode_themes_blob` returned an error — practically unreachable
    /// in v0.1 (palettes are small, well under the 4 MiB cap), but preserved as a
    /// closed variant so a future oversize store has a defined error surface.
    #[error("themes blob encode failed")]
    Encode,

    /// An imported palette failed the shared `theme_validator` value-shape
    /// allowlist (the security-load-bearing injection guard). Carries the rich
    /// `{ kind, key?, line? }` error so the UI can point at the exact token /
    /// source line at fault.
    #[error("theme validation failed")]
    Invalid {
        /// The rich validator error (token name + 1-based source line only).
        error: ThemeError,
    },
}

impl From<std::io::Error> for ThemesError {
    fn from(e: std::io::Error) -> Self {
        ThemesError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}
