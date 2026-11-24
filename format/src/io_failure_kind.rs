// SPDX-License-Identifier: AGPL-3.0-only
//! Repo-wide canonical IO error categorization for Tauri-layer error
//! types.
//!
//! Used so that `std::io::Error::Display` (which on some kernels
//! includes path strings) never crosses the IPC boundary —
//! [`from_io_error_kind`] maps `std::io::ErrorKind` to the closed
//! [`IoFailureKind`] enum and the underlying `io::Error` is dropped at
//! that boundary.
//!
//! Future plugins (`vault_unlock`, `vault_change_password`,
//! `vault_backup`) re-use this enum so the DENY-list discipline
//! applies repo-wide. The existing `vault_creation::IoErrorKind`
//! pre-dates this helper and remains in place for now; migration is
//! a follow-on and not required by Task 1 of vault-unlock-password.
//!
//! Logging discipline: `Display` of a raw `io::Error` is **never**
//! emitted via tracing. Always reduce to `IoFailureKind` first. See
//! `src-tauri/AGENTS.md` "Secret-handling logging discipline".

use serde::Serialize;

/// Closed categorization of `std::io::ErrorKind` for IPC surfaces.
///
/// No `String` payload: OS error messages (kernel-dependent, may
/// contain paths) are dropped at the [`from_io_error_kind`] boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum IoFailureKind {
    /// `std::io::ErrorKind::PermissionDenied`.
    PermissionDenied,
    /// `std::io::ErrorKind::NotFound` — file or directory absent.
    NotFound,
    /// `std::io::ErrorKind::StorageFull` / `WriteZero` — disk full
    /// during a write that would otherwise have succeeded.
    NoSpace,
    /// Catch-all for any other `std::io::ErrorKind`. The specific
    /// kind is intentionally discarded.
    Other,
}

/// Bare variant name. Safe under the DENY-list discipline **by construction**:
/// this is a unit-only enum, so there is no payload that could carry a path or
/// an OS message — unlike `std::io::Error`'s `Display`, which is the exact thing
/// this type exists to keep off the wire.
///
/// Added with the `VaultIo` seam (phase3-web-client task 17), which returns this
/// type as its error directly; `Display` + [`std::error::Error`] are what let a
/// call site use `?` into a plugin error type.
impl core::fmt::Display for IoFailureKind {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(match self {
            IoFailureKind::PermissionDenied => "PermissionDenied",
            IoFailureKind::NotFound => "NotFound",
            IoFailureKind::NoSpace => "NoSpace",
            IoFailureKind::Other => "Other",
        })
    }
}

impl std::error::Error for IoFailureKind {}

/// Map a `std::io::ErrorKind` to the closed [`IoFailureKind`] enum.
///
/// `WriteZero` and `StorageFull` collapse into `NoSpace` because both
/// indicate the underlying medium ran out of writable bytes — frontend
/// CTA is identical ("free up disk space and retry").
pub fn from_io_error_kind(kind: std::io::ErrorKind) -> IoFailureKind {
    match kind {
        std::io::ErrorKind::PermissionDenied => IoFailureKind::PermissionDenied,
        std::io::ErrorKind::NotFound => IoFailureKind::NotFound,
        std::io::ErrorKind::StorageFull | std::io::ErrorKind::WriteZero => IoFailureKind::NoSpace,
        _ => IoFailureKind::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_denied_maps_to_permission_denied() {
        assert_eq!(
            from_io_error_kind(std::io::ErrorKind::PermissionDenied),
            IoFailureKind::PermissionDenied
        );
    }

    #[test]
    fn not_found_maps_to_not_found() {
        assert_eq!(
            from_io_error_kind(std::io::ErrorKind::NotFound),
            IoFailureKind::NotFound
        );
    }

    #[test]
    fn storage_full_maps_to_no_space() {
        assert_eq!(
            from_io_error_kind(std::io::ErrorKind::StorageFull),
            IoFailureKind::NoSpace
        );
    }

    #[test]
    fn write_zero_maps_to_no_space() {
        assert_eq!(
            from_io_error_kind(std::io::ErrorKind::WriteZero),
            IoFailureKind::NoSpace
        );
    }

    #[test]
    fn already_exists_maps_to_other() {
        assert_eq!(
            from_io_error_kind(std::io::ErrorKind::AlreadyExists),
            IoFailureKind::Other
        );
    }

    #[test]
    fn timed_out_maps_to_other() {
        assert_eq!(
            from_io_error_kind(std::io::ErrorKind::TimedOut),
            IoFailureKind::Other
        );
    }

    #[test]
    fn invalid_data_maps_to_other() {
        assert_eq!(
            from_io_error_kind(std::io::ErrorKind::InvalidData),
            IoFailureKind::Other
        );
    }

    #[test]
    fn serializes_as_bare_variant_name() {
        // No payload — externally tagged serialization yields the
        // bare variant name, matching the spec for unit-only enums.
        assert_eq!(
            serde_json::to_string(&IoFailureKind::PermissionDenied).unwrap(),
            r#""PermissionDenied""#
        );
        assert_eq!(
            serde_json::to_string(&IoFailureKind::NotFound).unwrap(),
            r#""NotFound""#
        );
        assert_eq!(
            serde_json::to_string(&IoFailureKind::NoSpace).unwrap(),
            r#""NoSpace""#
        );
        assert_eq!(
            serde_json::to_string(&IoFailureKind::Other).unwrap(),
            r#""Other""#
        );
    }
}
