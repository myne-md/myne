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

use std::collections::BTreeSet;

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

/// [`canonical_folder`] for a path that came from USER INPUT rather than from a
/// note's own frontmatter: surrounding whitespace is trimmed first.
///
/// The trim belongs here and not in [`canonical_folder`], and the difference is
/// not stylistic: a vault may hold a folder genuinely named ` My Notes` (leading
/// space), and canonicalizing record folders with a trim would fold it onto
/// `My Notes` and make two folders one key. A path pasted or typed into a
/// Settings field, on the other hand, never has meaningful padding, and keeping
/// it would store an exclusion that matches nothing.
pub fn canonical_input_folder(folder: &str) -> String {
    canonical_folder(folder.trim())
}

/// Whether an ALREADY-canonicalized DENY set takes a canonical folder key out:
/// equality with an entry, or inside a NON-EMPTY entry.
///
/// This is not [`folder_matches_excluded`], and the difference is the empty
/// entry. There an empty string is ignored as far more likely to be an accident
/// than an instruction; here the ROOT is a folder the user can select on the
/// approval screen, so `""` must take notes sitting at the vault root and
/// nothing else. The root is therefore equality-only, never a prefix over the
/// whole vault.
///
/// One home for the rule because three callers mean exactly it: the external MCP
/// read scope (`plugins/mcp/scope.rs`), the write scope's subset check
/// (`plugins/mcp/write_scope.rs`), and the writer that refuses to store a write
/// grant outside the read scope (`plugins/prefs/commands.rs`). A second copy is
/// how one of them ends up reading the root as a prefix.
pub fn exclusions_cover(excluded: &BTreeSet<String>, key: &str) -> bool {
    if excluded.contains(key) {
        return true;
    }
    if key.is_empty() {
        return false;
    }
    excluded
        .iter()
        .any(|ex| !ex.is_empty() && key.starts_with(ex.as_str()))
}

/// Re-root one canonical folder key under a folder that was renamed.
///
/// `from` and `to` are canonical keys (trailing slash, or empty for the root). An
/// entry equal to `from` becomes `to`; an entry under `from` keeps its suffix; the
/// ROOT is equality-only for the same reason [`exclusions_cover`] makes it so. An
/// entry the rename does not touch is returned unchanged, so a caller can compare
/// and write only when something moved.
pub fn reroot(key: &str, from: &str, to: &str) -> String {
    if key == from {
        return to.to_string();
    }
    if from.is_empty() || key.is_empty() {
        return key.to_string();
    }
    match key.strip_prefix(from) {
        Some(suffix) => format!("{to}{suffix}"),
        None => key.to_string(),
    }
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

    #[test]
    fn reroot_moves_the_folder_and_its_subtree_but_not_a_sibling() {
        assert_eq!(reroot("private/", "private/", "journal/"), "journal/");
        assert_eq!(
            reroot("private/2026/", "private/", "journal/"),
            "journal/2026/"
        );
        assert_eq!(
            reroot("privatestuff/", "private/", "journal/"),
            "privatestuff/"
        );
        // The root is one folder, never a prefix over the vault.
        assert_eq!(reroot("", "", "journal/"), "journal/");
        assert_eq!(reroot("notes/", "", "journal/"), "notes/");
        // A rename INTO the root drops the prefix rather than keeping a `/`.
        assert_eq!(reroot("notes/2026/", "notes/", ""), "2026/");
    }
}
