// SPDX-License-Identifier: AGPL-3.0-only
//! Single concrete error enum for the protocol crate.
//!
//! All variants are unit — there are no `String` payloads, by design.
//! The frontend localizes user-facing messages from the variant tag; any
//! backend detail (Argon2 underlying error, OS error message, vault path)
//! lives in `tracing::error!` logs, never in the serialized payload. This
//! prevents path leakage, parameter leakage, and i18n ambiguity at the
//! type level rather than relying on reviewer attention.
//!
//! Implements `docs/spec/protocol.md` § 7.3 (AEAD failure indistinguishability)
//! and the no-`String`-in-errors discipline from the
//! `backend-vault-creation` PRD § Implementation Decisions.

use serde::Serialize;
use thiserror::Error;

/// Failure modes produced by the `protocol` crate.
///
/// Frontend code discriminates on the serialized `kind` tag, e.g.
/// `{"kind":"AeadFailure"}`. **Adding a variant with a payload field is
/// forbidden** — see the `all_variants_are_unit` test in this module,
/// which fails to compile if any variant grows fields.
#[derive(Debug, Error, Serialize, PartialEq, Eq)]
#[serde(tag = "kind")]
pub enum ProtocolError {
    /// Master password rejected by the wrap-key derivation path.
    #[error("invalid password")]
    InvalidPassword,

    /// Master password failed the length policy at signup time.
    #[error("password too short")]
    PasswordTooShort,

    /// Argon2id derivation failed. The underlying `argon2` error detail is
    /// logged via `tracing::error!` at the call site; nothing about the
    /// failure (params, salt, password) is surfaced to the frontend.
    #[error("kdf failure")]
    KdfFailure,

    /// AEAD verification failed.
    ///
    /// **By design this single variant does NOT distinguish** "wrong
    /// password/phrase" from "tampered vault" — see
    /// `docs/spec/protocol.md` § 7.3:
    ///
    /// > Tag-verification failure means either the phrase was entered
    /// > wrong or the `vault.meta` was tampered. The client MUST NOT
    /// > distinguish these two cases to the user beyond "phrase or vault
    /// > is invalid".
    #[error("aead failure")]
    AeadFailure,

    /// `vault.meta` rejected by the parser (wrong magic, wrong version,
    /// non-zero reserved byte, short slice, internal field violation).
    #[error("invalid vault.meta")]
    InvalidVaultMeta,

    /// Account number rejected by `parse_account_number` — wrong length,
    /// invalid alphabet character, or Damm-32 check failure. Spec
    /// `account-number.md` § 5 mandates a single user-facing message; this
    /// variant carries no granularity for the same reason.
    #[error("invalid account number")]
    AccountNumberInvalid,

    /// OS CSPRNG (`getrandom`) failed. Treated as fatal; not
    /// user-correctable, surfaces as an unrecoverable error.
    #[error("csprng failure")]
    Csprng,

    /// Note plaintext exceeds the per-note ciphertext_len cap pinned at
    /// `MAX_PLAINTEXT_LEN = 16 MiB` (see `crate::MAX_PLAINTEXT_LEN` and
    /// `decisions.md` 2026-05-06 entry). Returned by the encoder
    /// boundary check before any allocation; symmetric with the
    /// decoder's parse-level reject of `ciphertext_len > MAX + 32`.
    /// Larger payloads belong to the §11 attachment subsystem
    /// (Phase 1.5+).
    #[error("plaintext too large")]
    PlaintextTooLarge,
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use alloc::string::{String, ToString};

    /// Compile-time enforcement of the "no payload fields" discipline.
    ///
    /// If any variant of `ProtocolError` grows a field, the unit-pattern
    /// arm below stops matching and **this test fails to compile** —
    /// which is the entire point. Treat a compile failure here as a
    /// design red flag, not a test bug. See module doc comment for why.
    #[test]
    fn all_variants_are_unit() {
        fn assert_unit(e: &ProtocolError) {
            match e {
                ProtocolError::InvalidPassword => {}
                ProtocolError::PasswordTooShort => {}
                ProtocolError::KdfFailure => {}
                ProtocolError::AeadFailure => {}
                ProtocolError::InvalidVaultMeta => {}
                ProtocolError::AccountNumberInvalid => {}
                ProtocolError::Csprng => {}
                ProtocolError::PlaintextTooLarge => {}
            }
        }
        assert_unit(&ProtocolError::AeadFailure);
    }

    fn serialize(e: ProtocolError) -> String {
        serde_json::to_string(&e).expect("ProtocolError must serialize cleanly")
    }

    #[test]
    fn invalid_password_serializes_with_kind_tag() {
        assert_eq!(
            serialize(ProtocolError::InvalidPassword),
            r#"{"kind":"InvalidPassword"}"#
        );
    }

    #[test]
    fn password_too_short_serializes_with_kind_tag() {
        assert_eq!(
            serialize(ProtocolError::PasswordTooShort),
            r#"{"kind":"PasswordTooShort"}"#
        );
    }

    #[test]
    fn kdf_failure_serializes_with_kind_tag() {
        assert_eq!(
            serialize(ProtocolError::KdfFailure),
            r#"{"kind":"KdfFailure"}"#
        );
    }

    #[test]
    fn aead_failure_serializes_with_kind_tag() {
        assert_eq!(
            serialize(ProtocolError::AeadFailure),
            r#"{"kind":"AeadFailure"}"#
        );
    }

    #[test]
    fn invalid_vault_meta_serializes_with_kind_tag() {
        assert_eq!(
            serialize(ProtocolError::InvalidVaultMeta),
            r#"{"kind":"InvalidVaultMeta"}"#
        );
    }

    #[test]
    fn account_number_invalid_serializes_with_kind_tag() {
        assert_eq!(
            serialize(ProtocolError::AccountNumberInvalid),
            r#"{"kind":"AccountNumberInvalid"}"#
        );
    }

    #[test]
    fn csprng_serializes_with_kind_tag() {
        assert_eq!(serialize(ProtocolError::Csprng), r#"{"kind":"Csprng"}"#);
    }

    #[test]
    fn plaintext_too_large_serializes_with_kind_tag() {
        assert_eq!(
            serialize(ProtocolError::PlaintextTooLarge),
            r#"{"kind":"PlaintextTooLarge"}"#
        );
    }

    #[test]
    fn aead_failure_display_matches_thiserror_attribute() {
        // Spot-check that the `#[error("...")]` Display impl works in no_std.
        assert_eq!(ProtocolError::AeadFailure.to_string(), "aead failure");
    }
}
