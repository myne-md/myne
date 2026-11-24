// SPDX-License-Identifier: AGPL-3.0-only
//! Strict lowercase-hyphenated UUID shape check for on-disk filenames.
//!
//! Lives in its own ungated module rather than inside [`backup_container`] so
//! both the MYB1 container allowlist (native) and the import reader's `notes/`
//! listing filter (compiled for wasm32 too) share ONE definition. A native-only
//! home would make the wasm build fail with `E0433` the moment the import
//! reader reached for it (myne-md/myne#456).
//!
//! [`backup_container`]: crate::backup_container

/// Strict lowercase-hyphenated UUID check (36 chars, hyphens at 8/13/18/23,
/// lowercase hex elsewhere) — the on-disk filename form for notes and
/// snapshots. Deliberately stricter than `uuid::Uuid::parse_str` (which
/// tolerates uppercase/braced forms that never appear on disk) and
/// deliberately NOT `NoteId::parse` (v7-strict — §9.11.3's grammar carries
/// no version constraint; reusing the v7 validator would silently shrink
/// backup membership).
///
/// Shared by the container allowlist and the import reader's `notes/` listing
/// filter (myne-md/myne#827): a stricter filter there would extract a member the
/// allowlist accepted and then silently drop it from the listing. One
/// definition, two callers, no drift.
pub fn is_disk_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    b.iter().enumerate().all(|(i, &c)| match i {
        8 | 13 | 18 | 23 => c == b'-',
        _ => c.is_ascii_digit() || (b'a'..=b'f').contains(&c),
    })
}

#[cfg(test)]
mod tests {
    use super::is_disk_uuid;

    #[test]
    fn accepts_lowercase_uuid_shape() {
        assert!(is_disk_uuid("0190a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b"));
    }

    #[test]
    fn rejects_uppercase_braced_and_wrong_length() {
        assert!(!is_disk_uuid("0190A1B2-3C4D-7E5F-8A9B-0C1D2E3F4A5B"));
        assert!(!is_disk_uuid("{0190a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b}"));
        assert!(!is_disk_uuid("0190a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5"));
    }

    #[test]
    fn rejects_non_hex_and_misplaced_hyphens() {
        assert!(!is_disk_uuid("0190a1b2_3c4d-7e5f-8a9b-0c1d2e3f4a5b"));
        assert!(!is_disk_uuid("0190a1b23-c4d-7e5f-8a9b-0c1d2e3f4a5b"));
        assert!(!is_disk_uuid("g190a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b"));
    }
}
