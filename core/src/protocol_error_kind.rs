//! Repo-wide canonical mapping from `protocol::ProtocolError` variants
//! to `'static` string tags for structured tracing.
//!
//! Used by every Tauri-layer plugin that surfaces a `ProtocolError` via
//! `tracing::error!(stage = "...", protocol_error_kind = ...)`. A new
//! variant in the protocol crate compile-fails the match here —
//! drift-detecting per `src-tauri/CLAUDE.md` "Closed-enum mapping rule".
//!
//! Pre-MYND-22 this mapping was duplicated verbatim across
//! `vault_unlock`, `vault_recover`, and `vault_change_password`
//! commands.rs files. Lifted to a shared module during the MYND-22
//! `/simplify` pass.

/// Map a `protocol::ProtocolError` variant to its `'static` string tag.
///
/// Suitable for `tracing::error!(protocol_error_kind = protocol_error_kind(&e), ...)`.
/// Never log the underlying `ProtocolError` value via `?` or `%` —
/// those formatters could expand to leak DENY-listed material if a
/// future variant grows a payload field. Use this helper exclusively.
pub fn protocol_error_kind(e: &protocol::ProtocolError) -> &'static str {
    match e {
        protocol::ProtocolError::InvalidPassword => "InvalidPassword",
        protocol::ProtocolError::PasswordTooShort => "PasswordTooShort",
        protocol::ProtocolError::KdfFailure => "KdfFailure",
        protocol::ProtocolError::AeadFailure => "AeadFailure",
        protocol::ProtocolError::InvalidVaultMeta => "InvalidVaultMeta",
        protocol::ProtocolError::AccountNumberInvalid => "AccountNumberInvalid",
        protocol::ProtocolError::Csprng => "Csprng",
        protocol::ProtocolError::PlaintextTooLarge => "PlaintextTooLarge",
    }
}
