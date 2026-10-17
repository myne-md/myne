// SPDX-License-Identifier: AGPL-3.0
//! `VaultId` — host-side UUIDv7 wrapper naming a vault's on-disk directory.
//!
//! SYNC-2 (ratified, grill vault-registry-and-disk-layout Q1, 2026-06-08):
//! a `VaultId` is a random **UUIDv7**. It is both the `vaults/<id>/`
//! directory name and (in sub-feature 2) the `HashMap<VaultId, Slot>`
//! runtime key. It is **decoupled from `account_number_hash`** — there is
//! deliberately no filesystem-visible account fingerprint (a DENY-list
//! concern: the dir name must not leak which account a vault belongs to).
//!
//! ## Why a newtype (mirrors `notes::note_id::NoteId`)
//!
//! The string form of a `VaultId` becomes a path component (`vaults/<id>/`).
//! Routing an unvalidated UI- or disk-supplied string straight into a path
//! join is a traversal / case-folding hazard. [`VaultId::parse`] gates every
//! string that becomes a directory name through the same strict five-step
//! contract `NoteId::parse` uses, so the only shape that ever names a vault
//! directory is the canonical lowercase-hyphenated 36-char v7 form.
//!
//! ## Strict parse contract
//!
//! [`VaultId::parse`] enforces, in order:
//!
//! 1. exactly 36 chars → [`InvalidVaultIdCause::WrongLength`]
//! 2. every byte is lowercase ASCII letter, ASCII digit, or hyphen →
//!    [`InvalidVaultIdCause::InvalidChar`]
//! 3. hyphens at fixed positions 8, 13, 18, 23 →
//!    [`InvalidVaultIdCause::WrongHyphenPosition`]
//! 4. [`uuid::Uuid::parse_str`] succeeds → [`InvalidVaultIdCause::ParseFailed`]
//! 5. `uuid.get_version_num() == 7` → [`InvalidVaultIdCause::WrongVersion`]
//!
//! `Display` emits the canonical lowercase-hyphenated 36-char form — the
//! exact shape `parse` accepts — so `vaults/<vault_id>/` round-trips.

use uuid::Uuid;

/// Host-side per-vault identifier — UUIDv7 wrapper.
///
/// Construct via [`VaultId::mint`] (fresh random v7, the production path
/// for a brand-new vault) or [`VaultId::parse`] (validating a directory
/// name read back from `<app_data_dir>/vaults/`). Never construct directly
/// from a `Uuid` outside this module: the type's purpose is to gate every
/// `Uuid` that becomes a `vaults/<id>/` path component through the strict
/// parse contract above.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct VaultId(Uuid);

impl VaultId {
    /// Mint a fresh random UUIDv7 `VaultId`. The production constructor for
    /// a new vault directory (and for the boot migration that renames the
    /// legacy `vault/` into `vaults/<minted-id>/`, sub-feature task 4).
    ///
    /// Exercised by this module's round-trip tests; the production callers
    /// (vault-create targeting + boot migration) land in sub-features 2/4,
    /// so it is dead in the non-test build until then.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn mint() -> Self {
        VaultId(Uuid::now_v7())
    }

    /// Strict parse — see the module-level docs for the five rejection
    /// branches. Used when a directory name read off disk is turned back
    /// into a `VaultId` (sub-feature 2 discovery scan).
    pub fn parse(s: &str) -> Result<Self, InvalidVaultIdCause> {
        if s.len() != 36 {
            return Err(InvalidVaultIdCause::WrongLength);
        }
        // Charset filter: lowercase letter, digit, or hyphen. Catches
        // uppercase, special chars, non-ASCII. Lowercase letters `g-z`
        // pass this filter and are caught by the `Uuid::parse_str` step
        // below (`ParseFailed`).
        if !s
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return Err(InvalidVaultIdCause::InvalidChar);
        }
        for &i in &[8usize, 13, 18, 23] {
            if s.as_bytes()[i] != b'-' {
                return Err(InvalidVaultIdCause::WrongHyphenPosition);
            }
        }
        let uuid = Uuid::parse_str(s).map_err(|_| InvalidVaultIdCause::ParseFailed)?;
        if uuid.get_version_num() != 7 {
            return Err(InvalidVaultIdCause::WrongVersion);
        }
        Ok(VaultId(uuid))
    }

    /// Borrow the underlying [`Uuid`]. Consumed by sub-feature 2's
    /// `HashMap<VaultId, Slot>` keying and registry serialization; dead in
    /// the non-test build until then (tests use it for the v7-version
    /// assertion).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn as_uuid(&self) -> &Uuid {
        &self.0
    }

    /// Parse an OPTIONAL canonical `VaultId` string into `Option<VaultId>`.
    ///
    /// `None`/`Some(invalid)` both collapse to `None` (the sole-vault
    /// fallback): the multi-vault TARGETING commands (`unlock` / `recover` /
    /// `complete_recovery` / `create.commit` / `vault_slot_kind`) accept a
    /// malformed id as "no explicit target" rather than erroring, so the
    /// transitional single-vault callers that pass `undefined`/omit the field
    /// keep their current behavior, and a future picker bug that passes garbage
    /// degrades to the active-vault path instead of hard-failing routing. The
    /// single shared parser for every `Option<String>`-IPC targeting site
    /// (sub-feature 2 task 4, SYNC-6).
    pub fn parse_optional(s: Option<&str>) -> Option<Self> {
        s.and_then(|s| Self::parse(s).ok())
    }
}

impl core::fmt::Display for VaultId {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        // Canonical lowercase-hyphenated 36-char form — the shape `parse`
        // accepts and the literal `vaults/<id>/` directory name. Round-trip
        // safe by construction.
        write!(f, "{}", self.0.hyphenated())
    }
}

/// Why a [`VaultId::parse`] call rejected its input. `pub(crate)` — never
/// crosses the IPC boundary; consumers collapse all five to one public
/// error if they surface anything at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub enum InvalidVaultIdCause {
    WrongLength,
    InvalidChar,
    WrongHyphenPosition,
    ParseFailed,
    WrongVersion,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mint_produces_v7_uuid() {
        let id = VaultId::mint();
        assert_eq!(id.as_uuid().get_version_num(), 7);
    }

    #[test]
    fn render_parse_round_trips() {
        let id = VaultId::mint();
        let rendered = id.to_string();
        let reparsed = VaultId::parse(&rendered).expect("minted id must re-parse");
        assert_eq!(id, reparsed);
        assert_eq!(rendered, reparsed.to_string());
    }

    #[test]
    fn display_is_canonical_lowercase_hyphenated_36_chars() {
        let id = VaultId::mint();
        let s = id.to_string();
        assert_eq!(s.len(), 36);
        assert!(s
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'));
        for &i in &[8usize, 13, 18, 23] {
            assert_eq!(s.as_bytes()[i], b'-');
        }
    }

    #[test]
    fn parse_rejects_wrong_length() {
        assert_eq!(
            VaultId::parse("too-short"),
            Err(InvalidVaultIdCause::WrongLength)
        );
    }

    #[test]
    fn parse_rejects_uppercase() {
        // Canonical v7 string with one uppercase hex digit.
        let id = VaultId::mint().to_string().to_uppercase();
        assert_eq!(VaultId::parse(&id), Err(InvalidVaultIdCause::InvalidChar));
    }

    #[test]
    fn parse_rejects_wrong_hyphen_position() {
        // 36 chars, lowercase/digits, but hyphens in the wrong spots.
        let s = "0123456789abcdef0123456789abcdef0123";
        assert_eq!(s.len(), 36);
        assert_eq!(
            VaultId::parse(s),
            Err(InvalidVaultIdCause::WrongHyphenPosition)
        );
    }

    #[test]
    fn parse_rejects_v4_uuid_as_wrong_version() {
        // A v4 UUID passes steps 1-4 but fails the v7 check.
        let v4 = Uuid::new_v4().hyphenated().to_string();
        assert_eq!(VaultId::parse(&v4), Err(InvalidVaultIdCause::WrongVersion));
    }

    #[test]
    fn parse_rejects_non_hex_lowercase_letters() {
        // `g-z` pass the charset filter (step 2) and hyphen positions
        // (step 3) but are not valid hex → ParseFailed.
        let s = "gggggggg-gggg-gggg-gggg-gggggggggggg";
        assert_eq!(s.len(), 36);
        assert_eq!(VaultId::parse(s), Err(InvalidVaultIdCause::ParseFailed));
    }
}
