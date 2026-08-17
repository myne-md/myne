// SPDX-License-Identifier: AGPL-3.0
//! The one canonical folder key + the one equal-or-nested folder test.
//!
//! Both lived in the desktop AI plugin's `vector_store.rs`, which is where the
//! `ai_excluded_folders` (SYNC-14) test was first needed. The agent plugin core
//! needs exactly the same test on the same set, and it lives in this crate,
//! so the functions move here and the desktop re-exports them. A second copy
//! would be the failure this module exists to prevent: a note under `Private/`
//! passing one matcher while the other excluded it under a `private/` entry is
//! not a compile error on either side, and only one of the two paths is the one
//! a reviewer happens to read.
//!
//! Canonicalization is NFC + lowercase + a trailing slash. The trailing slash is
//! what makes a single prefix test cover both the equal and the nested case
//! without false-matching a sibling: `privatestuff/` does not start with
//! `private/`, while `private/sub/` does.

use unicode_normalization::UnicodeNormalization;

/// The canonical form of a folder path: NFC, lowercased, no empty segments, and
/// a trailing `/` on every non-empty result. The empty string is the vault root
/// and stays empty, which is what keeps it from matching (and therefore
/// excluding) everything.
pub fn canonical_folder(folder: &str) -> String {
    let segments: Vec<&str> = folder.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return String::new();
    }
    let mut key: String = segments.join("/").nfc().collect::<String>().to_lowercase();
    key.push('/');
    key
}

/// Whether a note's `folder` (RAW, un-canonicalized) is at or under any entry in
/// the ALREADY-canonicalized `excluded` set. An empty entry is ignored rather
/// than treated as the root, because the root would exclude the whole vault and
/// an empty string in that set is far more likely to be an accident than an
/// instruction.
pub fn folder_matches_excluded(folder: &str, excluded: &[String]) -> bool {
    let folder = canonical_folder(folder);
    excluded
        .iter()
        .any(|ex| !ex.is_empty() && folder.starts_with(ex.as_str()))
}

/// Canonicalize a whole excluded set once, so a caller testing many notes pays
/// the normalization per entry rather than per note.
pub fn canonical_excluded(excluded: &[String]) -> Vec<String> {
    excluded.iter().map(|e| canonical_folder(e)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_stays_empty_so_it_excludes_nothing() {
        assert_eq!(canonical_folder(""), "");
        assert_eq!(canonical_folder("/"), "");
        assert!(!folder_matches_excluded(
            "anything",
            &canonical_excluded(&["".into()])
        ));
    }

    #[test]
    fn canonical_form_is_nfc_lowercase_trailing_slash() {
        assert_eq!(canonical_folder("Projects"), "projects/");
        assert_eq!(canonical_folder("/Projects/Sub/"), "projects/sub/");
    }

    #[test]
    fn equal_and_nested_match_but_a_sibling_does_not() {
        let ex = canonical_excluded(&["Private".into()]);
        assert!(folder_matches_excluded("Private", &ex));
        assert!(folder_matches_excluded("Private/Deep", &ex));
        assert!(!folder_matches_excluded("PrivateStuff", &ex));
        assert!(!folder_matches_excluded("Projects", &ex));
    }

    #[test]
    fn case_and_diacritics_fold_the_same_on_both_sides() {
        let ex = canonical_excluded(&["Özel".into()]);
        assert!(folder_matches_excluded("özel/alt", &ex));
    }
}
