// SPDX-License-Identifier: AGPL-3.0-or-later

//! Project-wide password length floor for the auth pipeline.
//!
//! Single source of truth for the minimum number of Unicode characters a
//! master password must contain before any Argon2id-bound auth plugin
//! (`vault_creation`, `vault_recover`, `vault_change_password`) accepts
//! it. Pinned by `design-notes.md` 2026-05-06 entry "Auth-pipeline
//! backend MIN_PASSWORD_LEN floor; project-wide retroactive".
//!
//! ## What this is and is not
//!
//! [`MIN_PASSWORD_LEN`] is a **structural floor against trivial bypass**,
//! not an entropy guarantee. zxcvbn-style entropy gating remains
//! frontend-only (`PasswordForm` component); adding zxcvbn-rs as a
//! direct dependency was rejected on dependency-policy grounds (see
//! grilling session log Q7-β: ~1-2 MB binary + transitive surface vs.
//! the only justifying threat being A6 + DevTools-IPC manipulation,
//! which is out of scope per `threat-model.md`).
//!
//! The frontend's minimum-length constant duplicates this value via a
//! TS hand-mirror; the canonical source is here. A CI drift-check is a
//! Phase 1 end task.
//!
//! ## Counting characters, not bytes
//!
//! [`validate_min_length`] counts Unicode scalar values via
//! `str::chars().count()`, not the UTF-8 byte length. A password like
//! `"á".repeat(12)` is 12 characters but 24 bytes — using `len()` would
//! falsely admit it under a 12-character floor that the user expected
//! to mean "12 graphemes." This is approximate (USVs ≠ graphemes when
//! combining marks are involved) but adequate for a structural floor;
//! anything deeper belongs in entropy-gating territory which is
//! deliberately frontend-only.

use crate::error::ProtocolError;

/// Minimum number of Unicode characters required in a master password.
///
/// Phase 1 value: `12`. Frontend `PasswordForm` mirrors this constant
/// via TS hand-mirror; both sides must move together if the floor is
/// ever raised.
///
/// **Not an entropy guarantee.** A 12-character all-`a` password
/// satisfies the floor and is still trivially weak; entropy gating is
/// the frontend's responsibility (zxcvbn). This constant is the
/// structural backstop against frontend bypass via DevTools or hand-
/// crafted IPC payloads.
pub const MIN_PASSWORD_LEN: usize = 12;

/// Reject a password whose Unicode-character count is below
/// [`MIN_PASSWORD_LEN`]. Counts USVs via `str::chars().count()`, not
/// UTF-8 byte length — see module doc.
///
/// Returns [`ProtocolError::PasswordTooShort`] on rejection. Intended
/// to be called at the top of every Argon2id-bound auth plugin's
/// command (`vault_creation::commit`, `vault_complete_recovery`,
/// `vault_change_password::commit`) **before** Argon2id work begins,
/// so a sub-floor input pays microseconds rather than ~1 s.
///
/// This is the canonical wrap for the existing
/// [`ProtocolError::PasswordTooShort`] variant — that variant has been
/// reserved in the error enum since the protocol crate was bootstrapped
/// (no producer until now). Plugins that previously skipped backend
/// length-gating will pick this up via the foundation hardening in
/// MYND-22's PR.
pub fn validate_min_length(password: &str) -> Result<(), ProtocolError> {
    if password.chars().count() < MIN_PASSWORD_LEN {
        return Err(ProtocolError::PasswordTooShort);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn min_password_len_is_twelve() {
        assert_eq!(MIN_PASSWORD_LEN, 12);
    }

    #[test]
    fn rejects_eleven_ascii_chars() {
        let pw = "a".repeat(11);
        assert_eq!(
            validate_min_length(&pw),
            Err(ProtocolError::PasswordTooShort)
        );
    }

    #[test]
    fn accepts_twelve_ascii_chars() {
        let pw = "a".repeat(12);
        assert_eq!(validate_min_length(&pw), Ok(()));
    }

    #[test]
    fn accepts_thirteen_ascii_chars() {
        let pw = "a".repeat(13);
        assert_eq!(validate_min_length(&pw), Ok(()));
    }

    #[test]
    fn accepts_twelve_unicode_multibyte_chars() {
        // "á" (precomposed, U+00E1) is 1 USV, 2 UTF-8 bytes. Twelve of
        // them is 12 USVs (passes) and 24 bytes (would fail under a
        // naive byte-length check — guarding against that drift here).
        let pw = "á".repeat(12);
        assert_eq!(pw.len(), 24, "fixture sanity: bytes != chars for á");
        assert_eq!(pw.chars().count(), 12, "fixture sanity: 12 USVs");
        assert_eq!(validate_min_length(&pw), Ok(()));
    }

    #[test]
    fn rejects_eleven_unicode_multibyte_chars() {
        // Same precomposed "á" — 11 USVs is below the floor regardless
        // of byte count.
        let pw = "á".repeat(11);
        assert_eq!(
            validate_min_length(&pw),
            Err(ProtocolError::PasswordTooShort)
        );
    }

    #[test]
    fn rejects_empty_password() {
        assert_eq!(
            validate_min_length(""),
            Err(ProtocolError::PasswordTooShort)
        );
    }

    #[test]
    fn accepts_mixed_script_above_floor() {
        // Mixed Latin + Cyrillic + emoji at 13 USVs (above the 12-floor).
        // Demonstrates that the validator counts USVs across scripts and
        // does not care about UTF-8 byte length.
        let pw = "şifre_тест🔐ab";
        assert_eq!(pw.chars().count(), 13);
        assert_eq!(validate_min_length(pw), Ok(()));
    }
}
