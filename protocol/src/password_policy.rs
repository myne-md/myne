// SPDX-License-Identifier: AGPL-3.0

//! Project-wide password length floor for the auth pipeline.
//!
//! Single source of truth for the minimum number of Unicode characters a
//! master password must contain before any Argon2id-bound auth plugin
//! (`vault_creation`, `vault_recover`, `vault_change_password`) accepts
//! it. Pinned by `docs/decisions.md` 2026-05-06 entry "Auth-pipeline
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
#[cfg_attr(coverage_nightly, coverage(off))]
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

    /// Vector generator for the `password-policy` companion category.
    /// `#[ignore]`-gated — emits ready-to-copy JSON to
    /// `/tmp/myne_password_policy_vectors.json`. Drives
    /// [`validate_min_length`] over accept/reject fixtures, recording the
    /// USV count vs UTF-8 byte length so the cross-impl "count scalar
    /// values, not bytes" contract is auditable by independent ports.
    /// See `myne-test-vectors/vectors/password-policy/`.
    #[test]
    #[ignore = "vector generator — run explicitly to refresh password-policy cases.json"]
    fn emit_password_policy_vectors_for_paste() {
        extern crate std;
        use alloc::string::String;

        fn hex_lower(bytes: &[u8]) -> String {
            let mut s = String::with_capacity(bytes.len() * 2);
            for b in bytes {
                s.push_str(&alloc::format!("{:02x}", b));
            }
            s
        }

        fn json_escape(input: &str) -> String {
            let mut out = String::with_capacity(input.len() + 2);
            for c in input.chars() {
                match c {
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    c if (c as u32) < 0x20 => out.push_str(&alloc::format!("\\u{:04x}", c as u32)),
                    c => out.push(c),
                }
            }
            out
        }

        let mut dump = String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"password-policy\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str(
            "  \"spec_section\": \"decisions.md 2026-05-06 (MIN_PASSWORD_LEN floor)\",\n",
        );
        dump.push_str(&alloc::format!(
            "  \"description\": \"{}\",\n",
            json_escape(&alloc::format!(
                "Pins protocol::validate_min_length — the master-password minimum-length floor (MIN_PASSWORD_LEN = {}) enforced backend-side before any Argon2id work. Counts Unicode scalar values (str::chars().count()), NOT UTF-8 byte length. Boolean accept/reject conformance category — an independent client that gates on byte length diverges on the multibyte cases. Cases generated by `cargo test -p protocol --lib emit_password_policy_vectors_for_paste -- --ignored` (in protocol/src/password_policy.rs).",
                MIN_PASSWORD_LEN
            ))
        ));
        dump.push_str("  \"cases\": [\n");

        // (slug, description, password). Multibyte literals use explicit
        // \u escapes so the fixture is unambiguous regardless of how the
        // source file is normalized on disk.
        let cases: [(&str, &str, String); 7] = [
            (
                "accept-12-ascii",
                "Twelve ASCII 'a' — exactly at the floor; smallest accepted ASCII password.",
                "a".repeat(12),
            ),
            (
                "accept-13-ascii",
                "Thirteen ASCII 'a' — one above the floor.",
                "a".repeat(13),
            ),
            (
                "reject-11-ascii",
                "Eleven ASCII 'a' — one below the floor; rejected with PasswordTooShort.",
                "a".repeat(11),
            ),
            (
                "reject-empty",
                "Empty password — zero USVs, rejected.",
                String::new(),
            ),
            (
                "accept-12-precomposed-a-acute",
                "Twelve precomposed 'á' (U+00E1): 12 USVs (accept) but 24 UTF-8 bytes. The USV-vs-byte discriminator — a port gating on byte length mis-handles this class.",
                "\u{00E1}".repeat(12),
            ),
            (
                "reject-11-precomposed-a-acute",
                "Eleven precomposed 'á' (U+00E1): 11 USVs (reject) but 22 UTF-8 bytes. A byte-length gate would wrongly accept (22 >= 12).",
                "\u{00E1}".repeat(11),
            ),
            (
                "accept-13-mixed-script",
                "Mixed Latin + Cyrillic + emoji at 13 USVs (above floor): USV counting across scripts plus a 4-byte astral scalar (U+1F510), independent of UTF-8 byte length.",
                String::from("\u{015F}ifre_\u{0442}\u{0435}\u{0441}\u{0442}\u{1F510}ab"),
            ),
        ];

        let last = cases.len() - 1;
        for (i, (slug, description, password)) in cases.iter().enumerate() {
            let bytes = password.as_bytes();
            let usv = password.chars().count();
            let byte_len = bytes.len();
            let expected_kind = if validate_min_length(password).is_ok() {
                "accept"
            } else {
                "reject_too_short"
            };
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"password-policy/v0.1/{}\",\n",
                slug
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(description)
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_kind\": \"{}\",\n",
                expected_kind
            ));
            dump.push_str(&alloc::format!(
                "      \"input_password_utf8_hex\": \"{}\",\n",
                hex_lower(bytes)
            ));
            dump.push_str(&alloc::format!(
                "      \"informational_usv_count\": {},\n",
                usv
            ));
            dump.push_str(&alloc::format!(
                "      \"informational_byte_len\": {}\n",
                byte_len
            ));
            dump.push_str(if i == last { "    }\n" } else { "    },\n" });
        }

        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write("/tmp/myne_password_policy_vectors.json", dump.as_bytes())
            .expect("write password-policy vectors dump");
    }
}
