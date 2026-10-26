// SPDX-License-Identifier: AGPL-3.0
//! Credential entry for `myne-decrypt`.
//!
//! The master password (or recovery phrase) enters the tool through a TTY
//! prompt with echo off, or via a stdin pipe for scripting. There is
//! deliberately no `--password` flag and no `MYNE_PASSWORD` env var: a flag
//! lands the credential in `ps`, the shell history file and the terminal
//! record simultaneously, and an env var is readable through
//! `/proc/<pid>/environ` by the same user and is inherited by children.
//!
//! In recovery mode the BIP-39 checksum is validated BEFORE the Argon2id KDF
//! runs, so a mistyped word is caught in milliseconds rather than after a
//! 1-3 s derivation that then returns the §6.4 non-distinguishing failure.

use bip39::{Language, Mnemonic};
use zeroize::Zeroizing;

/// The credential the unlock path consumes. The password and the normalized
/// phrase are both `Zeroizing` so the bytes wipe on drop.
///
/// `Debug` is redacted on purpose: `Zeroizing<String>`'s derived `Debug` would
/// print the secret, so this type carries a manual impl that never does.
pub enum Credential {
    Password(Zeroizing<String>),
    RecoveryPhrase(Zeroizing<String>),
    /// The person identity's 24 words, which open an `NTV7` vault
    /// (myne-md/myne#911). A different secret from a vault recovery phrase, with
    /// the same BIP-39 shape, so it goes through the same validation.
    IdentityPhrase(Zeroizing<String>),
}

impl core::fmt::Debug for Credential {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Credential::Password(_) => f.write_str("Credential::Password([REDACTED])"),
            Credential::RecoveryPhrase(_) => f.write_str("Credential::RecoveryPhrase([REDACTED])"),
            Credential::IdentityPhrase(_) => f.write_str("Credential::IdentityPhrase([REDACTED])"),
        }
    }
}

/// Read the credential from the TTY (echo off) or from stdin (piped).
///
/// `recovery` selects the recovery phrase; otherwise the master password is
/// read. In recovery mode the phrase is normalized (NFKD + lowercase + trim +
/// whitespace coalesce, `protocol.md` §7.4) and its BIP-39 checksum is
/// validated before returning.
pub fn read_credential(recovery: bool, identity: bool) -> Result<Credential, String> {
    let phrase_mode = recovery || identity;
    let raw = read_secret(phrase_mode)?;
    if phrase_mode {
        let normalized = protocol::phrase::normalize_user_phrase(&raw);
        validate_bip39(&normalized)?;
        return Ok(if identity {
            Credential::IdentityPhrase(normalized)
        } else {
            Credential::RecoveryPhrase(normalized)
        });
    }
    Ok(Credential::Password(raw))
}

/// Read a secret line from the TTY with echo off, or from stdin when stdin is
/// not a TTY (scripting). A trailing newline is stripped.
fn read_secret(phrase_mode: bool) -> Result<Zeroizing<String>, String> {
    let prompt = if phrase_mode {
        "Recovery phrase: "
    } else {
        "Master password: "
    };

    // `rpassword::read_password` reads from the TTY with echo off. When stdin
    // is piped (not a TTY), it falls back to reading stdin, which is the
    // scripting path. The prompt goes to stderr so a piped stdout stays clean.
    if atty_stdin() {
        eprint!("{prompt}");
        let line = rpassword::read_password().map_err(|e| format!("read credential: {e}"))?;
        Ok(Zeroizing::new(line))
    } else {
        use std::io::Read;
        let mut buf = String::new();
        std::io::stdin()
            .read_to_string(&mut buf)
            .map_err(|e| format!("read credential from stdin: {e}"))?;
        // Strip one trailing newline (and a possible CRLF).
        let trimmed = buf.trim_end_matches(['\n', '\r']);
        Ok(Zeroizing::new(trimmed.to_string()))
    }
}

/// Whether stdin is a TTY. `rpassword` handles the TTY case itself; this probe
/// decides between the prompt path and the pipe path.
fn atty_stdin() -> bool {
    // `std::io::IsTerminal` (Rust 1.70+) is the std-only probe; no extra dep.
    use std::io::IsTerminal;
    std::io::stdin().is_terminal()
}

/// Validate the BIP-39 checksum of a normalized phrase, returning a clear
/// error on a typo. This is the pre-KDF gate: a wrong word is caught here in
/// milliseconds rather than after a 1-3 s Argon2id run.
fn validate_bip39(normalized: &str) -> Result<(), String> {
    Mnemonic::parse_in(Language::English, normalized)
        .map(|_| ())
        .map_err(|_| {
            "recovery phrase is not a valid 24-word BIP-39 phrase (check for a typo)".to_string()
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_typo_fails_the_checksum_gate() {
        // A real phrase with one word swapped is not a valid BIP-39 checksum.
        let phrase = protocol::generate_recovery_phrase().expect("getrandom");
        let mut words: Vec<String> = phrase.words().to_vec();
        let original = words[0].clone();
        for candidate in Language::English.word_list() {
            if *candidate == original {
                continue;
            }
            words[0] = (*candidate).to_string();
            if validate_bip39(&words.join(" ")).is_err() {
                break;
            }
        }
        assert_ne!(words[0], original);
        assert!(validate_bip39(&words.join(" ")).is_err());
    }

    #[test]
    fn normalization_folds_whitespace_and_case_before_validation() {
        let phrase = protocol::generate_recovery_phrase().expect("getrandom");
        let joined = phrase.join_normalized();
        // Uppercase + extra whitespace still normalizes to a valid phrase.
        let messy = joined.to_uppercase().replace(' ', "  ");
        let normalized = protocol::phrase::normalize_user_phrase(&messy);
        assert!(validate_bip39(&normalized).is_ok());
    }
}
