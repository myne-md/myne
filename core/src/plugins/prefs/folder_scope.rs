// SPDX-License-Identifier: AGPL-3.0
//! Folder-scope predicate for `cli_excluded_folders` (cli-thin-client task 5;
//! MYND-490) — the single canonicalization rule every CLI-bridge enforcement
//! point (`src-tauri/src/cli_bridge/scope.rs`) matches against.
//!
//! Deliberately a **fresh, independent copy** of the canonicalization the
//! `ai_excluded_folders` store already applies
//! (`src-tauri/src/plugins/local_inference/vector_store.rs::canonical_folder`
//! / `folder_matches_excluded`), not a shared dependency on it: that module
//! lives behind the `local-inference` cargo feature (default-on, but a
//! `--no-default-features` build compiles it out entirely — see
//! `src-tauri/CLAUDE.md` "Cryptographically load-bearing identifiers" /
//! `design-notes.md` 2026-07-02), and the CLI door must keep working in
//! that build. Both copies apply the SAME rule (structural path
//! normalization + NFC-normalize + lowercase, equal-or-nested
//! trailing-slash prefix match, empty entries ignored) so the two
//! independently-evolving exclusion features stay behaviourally identical
//! without a compile-time link between them.
//!
//! Pure and allocation-light; no IO, no `VaultRuntimeState`. Every enforcement
//! point (today: `cli_bridge::scope::filter_note_ids_by_scope` for `list`;
//! future: `show`/`search`/`new`/`daily`'s read AND write paths) calls this
//! one function, so "central enforcement" means "one predicate", not "one
//! call site" — there will be several call sites, one per command, but all of
//! them defer to this same canonicalization rather than reimplementing it.

use unicode_normalization::UnicodeNormalization;

/// Structurally normalize + NFC-normalize + lowercase a folder path into the
/// comparison key both sides of [`folder_is_excluded`] are measured in. The
/// exact Rust twin of `dialect/src/folderPath.ts::folderKey`
/// (`foldSegment(normalizeFolderPath(folder))`): split on `/`, drop empty
/// segments (which collapses leading, duplicate and missing trailing
/// slashes), rejoin with a single trailing slash, then NFC + lowercase.
/// Root — empty, `"/"`, `"//"` — canonicalizes to `""`.
///
/// **The structural half is security-load-bearing, not cosmetic.**
/// `markdown-dialect.md` §3.6.2 says reads TOLERATE a missing trailing slash
/// and leading/duplicate slashes, and `normalizeFolderPath` is what makes the
/// app display a `folder: Private` note inside `Private/`. Comparing the raw
/// frontmatter value instead would leave exactly that note — reachable via
/// the Obsidian importer, which preserves a pre-existing `folder:` verbatim,
/// or via hand-edited frontmatter — outside an exclusion the user believes
/// covers it. Case/diacritic folding is the second half: an excluded
/// `Private/` also excludes `private/` and any differently-normalized Unicode
/// form of the same name.
pub fn canonical_folder(folder: &str) -> String {
    let segments: Vec<&str> = folder.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return String::new();
    }
    let mut key: String = segments.join("/").nfc().collect::<String>().to_lowercase();
    key.push('/');
    key
}

/// Whether `folder` (raw, un-canonicalized; `None` or empty = vault root)
/// falls under any entry in `excluded` (raw; canonicalized here). BOTH sides
/// go through [`canonical_folder`], so a note whose frontmatter carries a
/// non-canonical `folder:` value is measured against the same key as one
/// written by the app itself.
///
/// A folder is excluded when it EQUALS an excluded entry or is NESTED beneath
/// one. Canonicalization guarantees every non-empty key ends in `/`, which is
/// what makes the single `starts_with` prefix test cover both cases at once
/// and never false-match a sibling (`privatestuff/` does not start with
/// `private/`). An empty entry is ignored (a degenerate value that would
/// otherwise exclude the whole vault) — which also means a note with no
/// folder (root) is never excluded by any real entry.
pub fn folder_is_excluded(folder: Option<&str>, excluded: &[String]) -> bool {
    let folder = canonical_folder(folder.unwrap_or_default());
    excluded.iter().any(|raw| {
        let ex = canonical_folder(raw);
        !ex.is_empty() && folder.starts_with(ex.as_str())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn excl(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn exact_match_is_excluded() {
        assert!(folder_is_excluded(Some("Private/"), &excl(&["Private/"])));
    }

    #[test]
    fn subfolder_is_excluded() {
        assert!(folder_is_excluded(
            Some("Private/Journal/"),
            &excl(&["Private/"])
        ));
        assert!(folder_is_excluded(
            Some("Work/Secret/2026/"),
            &excl(&["Work/Secret/"])
        ));
    }

    #[test]
    fn sibling_is_not_excluded() {
        // `PrivateStuff/` is NOT nested under `Private/` — the entry's
        // trailing slash must be part of the matched prefix.
        assert!(!folder_is_excluded(
            Some("PrivateStuff/"),
            &excl(&["Private/"])
        ));
    }

    #[test]
    fn nfc_differing_forms_still_match() {
        // "Café/" as NFC (single U+00E9) vs NFD (e + combining acute) must
        // canonicalize to the same excluded entry.
        let nfc = "Caf\u{00E9}/";
        let nfd = "Cafe\u{0301}/";
        assert!(folder_is_excluded(Some(nfd), &excl(&[nfc])));
        assert!(folder_is_excluded(Some(nfc), &excl(&[nfd])));
    }

    #[test]
    fn case_differing_forms_still_match() {
        assert!(folder_is_excluded(Some("private/"), &excl(&["Private/"])));
        assert!(folder_is_excluded(
            Some("PRIVATE/Sub/"),
            &excl(&["private/"])
        ));
    }

    #[test]
    fn a_non_canonical_note_folder_is_still_excluded() {
        // The defect this predicate's canonicalization exists to close:
        // `markdown-dialect.md` §3.6.2 tolerates a missing trailing slash and
        // leading/duplicate slashes on READ, and the app displays such a note
        // inside `Private/`. Comparing the raw value would serve it past the
        // user's own exclusion — via the Obsidian importer (which preserves a
        // pre-existing `folder:` verbatim), via hand-edited frontmatter, or
        // via a note the CLI itself wrote.
        for raw in ["Private", "/Private/", "//Private//", "/Private"] {
            assert!(
                folder_is_excluded(Some(raw), &excl(&["Private/"])),
                "a note filed under {raw:?} must not escape a `Private/` exclusion"
            );
        }
        assert!(folder_is_excluded(
            Some("Private/Journal"),
            &excl(&["Private/"])
        ));
    }

    #[test]
    fn a_non_canonical_excluded_entry_still_excludes() {
        // The entry side gets the same treatment, for the same reason: the
        // `cli_excluded_folders` codec (protocol.md §9.5.2) NFC-normalizes,
        // sorts and dedupes but does NOT structurally normalize, so a client
        // (or a hand-edited blob) can store `Private` without the slash. An
        // entry the user believes covers a folder must cover it.
        for raw in ["Private", "/Private/", "//Private//"] {
            assert!(
                folder_is_excluded(Some("Private/"), &excl(&[raw])),
                "an entry stored as {raw:?} must still exclude `Private/`"
            );
        }
    }

    #[test]
    fn canonicalization_never_widens_an_entry_into_a_sibling_wildcard() {
        // The one thing the structural normalization must NOT do: turn a
        // slash-less entry into a bare prefix wildcard. Canonicalization
        // APPENDS the trailing slash rather than dropping it, so the `/` is
        // still part of the matched prefix and a sibling whose name merely
        // starts with the same letters stays in scope.
        assert!(!folder_is_excluded(
            Some("PrivateStuff/"),
            &excl(&["Private"])
        ));
        assert!(!folder_is_excluded(
            Some("Privateer/"),
            &excl(&["Private/"])
        ));
    }

    #[test]
    fn canonical_folder_matches_the_typescript_folder_key() {
        // `dialect/src/folderPath.ts::folderKey` is the twin this must not
        // drift from — `foldSegment(normalizeFolderPath(folder))`, i.e. root
        // for every all-empty-segment input and a lowercase NFC
        // trailing-slash path otherwise.
        assert_eq!(canonical_folder(""), "");
        assert_eq!(canonical_folder("/"), "");
        assert_eq!(canonical_folder("//"), "");
        assert_eq!(canonical_folder("Private"), "private/");
        assert_eq!(canonical_folder("/Private/"), "private/");
        assert_eq!(canonical_folder("A//B/"), "a/b/");
        assert_eq!(canonical_folder("Cafe\u{0301}/"), "caf\u{00E9}/");
    }

    #[test]
    fn empty_exclusion_list_excludes_nothing() {
        assert!(!folder_is_excluded(Some("Private/"), &[]));
        assert!(!folder_is_excluded(None, &[]));
    }

    #[test]
    fn empty_entry_is_ignored_not_treated_as_vault_wide() {
        let excluded = excl(&["", "Private/"]);
        assert!(!folder_is_excluded(Some("Other/"), &excluded));
        assert!(folder_is_excluded(Some("Private/"), &excluded));
    }

    #[test]
    fn note_with_no_folder_is_not_excluded_by_a_real_entry() {
        assert!(!folder_is_excluded(None, &excl(&["Private/"])));
        assert!(!folder_is_excluded(Some(""), &excl(&["Private/"])));
    }

    #[test]
    fn root_note_excluded_only_if_root_itself_were_a_real_entry() {
        // A note with no folder is root; an excluded root entry never occurs
        // in practice (the codec never emits an empty string), but the
        // predicate must not special-case it either way — verify the empty
        // canonicalized entry (which the `!ex.is_empty()` guard drops) does
        // NOT exclude root.
        assert!(!folder_is_excluded(None, &excl(&[""])));
    }
}
