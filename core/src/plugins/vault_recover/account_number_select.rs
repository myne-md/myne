// SPDX-License-Identifier: AGPL-3.0
//! Account-number → vault selection (host-side, header-only, no decrypt).
//!
//! Multi-vault recovery lets the user OPTIONALLY type their account-number to
//! jump straight to the right vault (SYNC-12, `decisions.md` 2026-06-08
//! supersession of the 2026-05-01 "account-number role = none" entry). This
//! module is that optional selector — it is **never a gate** and the 24-word
//! phrase stays the sole recovery secret.
//!
//! ## What it does (selection only — NO cryptographic change)
//!
//! 1. Liberal-parse the user-supplied string through the EXISTING
//!    `protocol::parse_account_number` (`account-number.md` §5: NFKD, strip
//!    `MY-`, drop separators, uppercase, length + strict Crockford-alphabet +
//!    Damm-32 check). This re-uses the protocol crate verbatim — the parse is
//!    NOT re-implemented here.
//! 2. Take the parsed `account_number_hash = SHA-256(canonical)[:16]`
//!    (`account-number.md` §6) the protocol crate already computed.
//! 3. Scan the multi-vault disk discovery ([`crate::vault_registry::discover_vaults`])
//!    and, for each well-formed vault, read the PLAINTEXT `account_number_hash`
//!    field out of its `vault.meta` header (`protocol.md` §9.3 offset 6) — a
//!    header field, NO decrypt, NO unlock, NO Argon2id, NO `auth_permits`.
//! 4. Return the first [`VaultId`] whose header hash equals the typed
//!    account-number's hash, else `None`.
//!
//! `account_number_hash` already binds both Argon2id salts (`protocol.md`
//! §3.1) and the recovery pipeline already reads it from disk, so selecting a
//! vault by it just picks WHICH `vault.meta` the unchanged pipeline reads. No
//! load-bearing identifier is touched.
//!
//! ## Non-distinguishing contract (`account-number.md` §5)
//!
//! ALL failure modes collapse to a single `None`:
//! - a malformed account-number (bad length / non-Crockford char / failed
//!   Damm-32) → `None`,
//! - a syntactically-valid account-number matching no on-disk vault → `None`.
//!
//! The caller cannot tell "you typed it wrong" from "no vault here matches",
//! so the selector leaks neither vault count nor which vaults exist beyond
//! the boolean "a vault matched / nothing matched".
//!
//! ## Logging discipline
//!
//! `account_number_hash` bytes are DENY-listed (`src-tauri/AGENTS.md`
//! "Secret-handling logging discipline"). This module NEVER emits them — nor
//! the parsed canonical, nor any per-vault hash, nor the `VaultId`, nor a path
//! — via `tracing`/IPC/format. The only signal it could emit is a coarse
//! static stage string; it emits nothing, returning a bare `Option<VaultId>`.

use crate::vault_id::VaultId;
use protocol::VAULT_META_ACCOUNT_HASH_LEN;
use std::path::Path;

/// `account_number_hash` byte offset inside `vault.meta` (`protocol.md`
/// §9.3 — magic[0..4] || protocol_version[4] || reserved[5] ||
/// account_number_hash[6..22]). Read directly off the header bytes WITHOUT
/// a full `parse_vault_meta` (we only need this one plaintext field, and a
/// structurally-corrupt-but-header-intact vault should still be matchable —
/// though in practice the discovery scan only feeds us well-formed vaults).
const ACCOUNT_HASH_OFFSET: usize = 6;

/// The fully-parsed account-number-hash + its 16-byte length, extracted so the
/// header comparison is a fixed-width `[u8; 16]` equality. Internal-only; the
/// bytes are DENY-listed and never logged.
type AccountNumberHash = [u8; VAULT_META_ACCOUNT_HASH_LEN];

/// Resolve a user-supplied account-number string to the [`VaultId`] of the
/// on-disk vault whose `vault.meta` header `account_number_hash` matches.
///
/// `base` is `<app_data_dir>` (caller owns the Tauri lookup, keeping this a
/// pure, Tauri-free scan — symmetric with [`crate::vault_registry::discover_vaults`]).
///
/// Returns `Some(id)` for the first matching vault, `None` for EVERY failure
/// mode (malformed input OR no match) — the single non-distinguishing result
/// per `account-number.md` §5. Reads only plaintext headers: no decrypt, no
/// `auth_permits`, no Argon2id.
pub(crate) fn resolve_vault_by_account_number(
    base: &Path,
    account_number: &str,
) -> Option<VaultId> {
    // (1)+(2) Liberal-parse via the protocol crate (NOT re-implemented here).
    // Any parse failure (length / alphabet / Damm-32) collapses to `None` —
    // same result as a valid-but-no-match, so the caller cannot distinguish
    // "typo" from "no such vault" (§5 non-distinguishing).
    let target_hash: AccountNumberHash = match protocol::parse_account_number(account_number) {
        Ok(acct) => acct.hash,
        Err(_) => return None,
    };

    // (3)+(4) Scan discovery; match the target hash against each vault's
    // plaintext header `account_number_hash`. First match wins.
    let discovered = crate::vault_registry::discover_vaults(base);
    for vault in discovered {
        if let Some(header_hash) = read_account_number_hash_from_header(&vault.root) {
            if header_hash == target_hash {
                return Some(vault.id);
            }
        }
    }
    None
}

/// Read the plaintext `account_number_hash` (16 bytes at offset 6) out of a
/// vault's `vault.meta` header WITHOUT decrypting or fully parsing. Returns
/// `None` on any IO failure or if the file is too short to hold the header
/// field — such a vault simply does not match (still non-distinguishing).
///
/// We read only the first `ACCOUNT_HASH_OFFSET + 16` bytes' worth of the file
/// (via a full read then a bounded slice) and copy the fixed-width field. No
/// AEAD, no key, no allocation of secret material beyond this 16-byte field
/// (which is itself plaintext-on-disk and only ever compared, never logged).
/// `pub(crate)`: the backup restore engine's collision scan (MYND-218)
/// reuses this exact header read — one canonical "identity from header,
/// no parse, no magic gate" primitive (a structurally-damaged twin must
/// still be matchable; that IS restore's flagship repair case).
pub fn read_account_number_hash_from_header(vault_root: &Path) -> Option<AccountNumberHash> {
    let meta_path = vault_root.join("vault.meta");
    let bytes = std::fs::read(meta_path).ok()?;
    let end = ACCOUNT_HASH_OFFSET + VAULT_META_ACCOUNT_HASH_LEN;
    if bytes.len() < end {
        return None;
    }
    let mut out = [0u8; VAULT_META_ACCOUNT_HASH_LEN];
    out.copy_from_slice(&bytes[ACCOUNT_HASH_OFFSET..end]);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::VAULTS_DIR_NAME;
    use crate::plugins::vault_creation::commands::{build_and_serialize_vault_meta, build_session};
    use crate::test_support::{ScopedTempDir, FAST_TEST_KDF};

    /// Seed a real `vaults/<id>/vault.meta` under `base` for `account_number`,
    /// returning the minted `VaultId`. The session derives a genuine
    /// `account_number_hash` (the protocol crate computes it from the
    /// generated account-number) — but tests that need a KNOWN hash override
    /// the header bytes after serialization (see [`seed_vault_with_hash`]).
    fn seed_vault(base: &Path) -> VaultId {
        let id = VaultId::mint();
        let dir = base.join(VAULTS_DIR_NAME).join(id.to_string());
        std::fs::create_dir_all(&dir).expect("create vault dir");
        let session = build_session(id, "pw", FAST_TEST_KDF).expect("build_session");
        let bytes = build_and_serialize_vault_meta(&session).expect("serialize vault.meta");
        std::fs::write(dir.join("vault.meta"), bytes).expect("write vault.meta");
        id
    }

    /// Seed a `vaults/<id>/vault.meta` whose header `account_number_hash`
    /// (offset 6..22) is forced to `hash`, so a test can pin the exact bytes a
    /// known account-number parses to. Everything else is a real serialized
    /// `vault.meta` (so the header layout is authentic).
    fn seed_vault_with_hash(base: &Path, hash: &AccountNumberHash) -> VaultId {
        let id = VaultId::mint();
        let dir = base.join(VAULTS_DIR_NAME).join(id.to_string());
        std::fs::create_dir_all(&dir).expect("create vault dir");
        let session = build_session(id, "pw", FAST_TEST_KDF).expect("build_session");
        let mut bytes = build_and_serialize_vault_meta(&session).expect("serialize vault.meta");
        bytes[ACCOUNT_HASH_OFFSET..ACCOUNT_HASH_OFFSET + VAULT_META_ACCOUNT_HASH_LEN]
            .copy_from_slice(hash);
        std::fs::write(dir.join("vault.meta"), bytes).expect("write vault.meta");
        id
    }

    /// The fixed valid account-number used across these tests + the 16-byte
    /// hash the protocol crate parses it to.
    const VALID_ACCT_DISPLAY: &str = "MY-0123-4567-89AB-CDEF-GHJT";

    fn valid_acct_hash() -> AccountNumberHash {
        protocol::parse_account_number(VALID_ACCT_DISPLAY)
            .expect("fixture account-number must parse")
            .hash
    }

    #[test]
    fn match_found_returns_that_vault_id() {
        // A valid account-number whose hash equals one vault's header returns
        // that vault's VaultId.
        let tmp = ScopedTempDir::new("acct-match").unwrap();
        let target = seed_vault_with_hash(tmp.path(), &valid_acct_hash());
        // A second, non-matching vault to prove the scan disambiguates.
        let _other = seed_vault(tmp.path());

        let resolved = resolve_vault_by_account_number(tmp.path(), VALID_ACCT_DISPLAY);
        assert_eq!(
            resolved,
            Some(target),
            "must select the hash-matching vault"
        );
    }

    #[test]
    fn match_accepts_liberal_input_forms() {
        // The same account-number in a liberal form (no MY- prefix, lowercase,
        // no separators, surrounding whitespace) resolves identically — the
        // protocol crate's §5 normalization is reused verbatim.
        let tmp = ScopedTempDir::new("acct-liberal").unwrap();
        let target = seed_vault_with_hash(tmp.path(), &valid_acct_hash());

        for input in [
            "0123456789ABCDEFGHJT",
            "my-0123-4567-89ab-cdef-ghjt",
            "  MY-0123-4567-89AB-CDEF-GHJT  ",
        ] {
            assert_eq!(
                resolve_vault_by_account_number(tmp.path(), input),
                Some(target),
                "liberal form {input:?} must resolve to the same vault",
            );
        }
    }

    #[test]
    fn valid_but_no_match_returns_none() {
        // A syntactically valid account-number matching no on-disk vault
        // returns None — no leak of vault count / which vaults exist.
        let tmp = ScopedTempDir::new("acct-nomatch").unwrap();
        // Two vaults, neither carrying the fixture account-number's hash.
        let _a = seed_vault(tmp.path());
        let _b = seed_vault(tmp.path());

        let resolved = resolve_vault_by_account_number(tmp.path(), VALID_ACCT_DISPLAY);
        assert_eq!(resolved, None, "valid-but-no-match collapses to None");
    }

    #[test]
    fn malformed_input_returns_none_same_as_no_match() {
        // Malformed account-numbers (bad length / non-Crockford char / failed
        // Damm-32) all collapse to the SAME None as a valid-but-no-match
        // (§5 — every failure mode is indistinguishable). A matching vault is
        // present to prove malformed input never resolves it.
        let tmp = ScopedTempDir::new("acct-malformed").unwrap();
        let _present = seed_vault_with_hash(tmp.path(), &valid_acct_hash());

        for bad in [
            "",                             // empty
            "MY-0123-4567-89AB-CDEF-GHJ",   // too short
            "MY-0123-4567-89AB-CDEF-GHJTX", // too long
            "MY-IIII-IIII-IIII-IIII-IIII",  // excluded Crockford char 'I'
            "MY-OOOO-OOOO-OOOO-OOOO-OOOO",  // excluded Crockford char 'O'
            "MY-0123-4567-89AB-CDEF-GHJ0",  // valid alphabet but bad Damm-32 check
        ] {
            assert_eq!(
                resolve_vault_by_account_number(tmp.path(), bad),
                None,
                "malformed input {bad:?} must collapse to None (non-distinguishing)",
            );
        }
    }

    #[test]
    fn no_vaults_on_disk_returns_none() {
        // Empty discovery (no vaults/ dir) → None even for a valid number.
        let tmp = ScopedTempDir::new("acct-empty").unwrap();
        assert_eq!(
            resolve_vault_by_account_number(tmp.path(), VALID_ACCT_DISPLAY),
            None
        );
    }

    #[test]
    fn first_match_wins_when_two_vaults_share_a_hash() {
        // Defensive: if two vaults somehow carry the same account_number_hash
        // (same account, two vaults), the FIRST discovered match is returned.
        // discover_vaults sorts by VaultId, so the lexicographically-smaller
        // id wins — deterministic.
        let tmp = ScopedTempDir::new("acct-dup").unwrap();
        let h = valid_acct_hash();
        let a = seed_vault_with_hash(tmp.path(), &h);
        let b = seed_vault_with_hash(tmp.path(), &h);
        let expected = core::cmp::min(a, b);

        assert_eq!(
            resolve_vault_by_account_number(tmp.path(), VALID_ACCT_DISPLAY),
            Some(expected),
            "first (id-sorted) match wins on a shared hash",
        );
    }

    #[test]
    fn header_too_short_does_not_match_and_does_not_panic() {
        // A vault dir with a truncated vault.meta (shorter than the header
        // field) is simply skipped — no panic, no match.
        let tmp = ScopedTempDir::new("acct-short").unwrap();
        let id = VaultId::mint();
        let dir = tmp.path().join(VAULTS_DIR_NAME).join(id.to_string());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("vault.meta"), b"short").unwrap();

        assert_eq!(
            resolve_vault_by_account_number(tmp.path(), VALID_ACCT_DISPLAY),
            None,
            "a too-short header is skipped, never matched or panicked on",
        );
    }
}
