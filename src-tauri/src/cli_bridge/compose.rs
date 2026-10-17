// SPDX-License-Identifier: AGPL-3.0
//! Plaintext composition for `myne new` (cli-thin-client task 8; MYND-490).
//!
//! `note_create` is dialect-blind (`src/notes/duplicateNote.ts`'s own doc
//! comment) — whatever plaintext this hands it is exactly what gets AEAD-
//! sealed and written. The UI's own writer path
//! (`dialect/src/folderPath.ts::normalizeFolderPath` +
//! `src/dialect/surgery.ts::patchFolderField`) lives TS-side and is
//! unreachable from this socket-only Rust dispatch path, so this module is a
//! narrow, CLI-specific Rust re-implementation of exactly the two pieces
//! `new` needs: structural folder-path normalization (mirrors
//! `normalizeFolderPath` byte-for-byte — split on `/`, drop empty segments,
//! rejoin with a single trailing slash; empty/`"/"` → root) and frontmatter
//! injection in the exact shape
//! `core/src/plugins/notes/title_extract.rs`'s scanner reads back
//! (`"---\n"` opener line-1-anchored, closer a line that is exactly
//! `"---"`).
//!
//! Deliberately does NOT reimplement the REST of `isLegalSegment`'s grammar
//! rejection — task 8's own scope is refusing an EXCLUDED destination, not
//! validating folder-name grammar; an illegal-but-valid-UTF8 segment lands
//! exactly where a manually-edited note carrying the same frontmatter would.
//! [`folder_arg_has_control_char`] is the ONE piece of that grammar this
//! module does enforce, and the reason is structural rather than aesthetic —
//! see its own doc comment.

/// Structural-only normalization of a raw `--folder` value to the canonical
/// trailing-slash form, or `None` for root. Mirrors
/// `dialect/src/folderPath.ts::normalizeFolderPath` exactly: split on `/`,
/// drop empty segments (collapses duplicate/leading/trailing slashes),
/// rejoin with `/` and a trailing slash. Empty input or `"/"` alone → root.
///
/// **Structural only** — it splits on `/` and nothing else, so a control
/// character survives it intact. Callers on the WRITE path must reject one
/// first via [`folder_arg_has_control_char`]; the read-side callers
/// (`daily.rs`'s per-note folder normalization) want the raw structural rule
/// and no rejection at all, which is why the two stayed separate functions.
pub fn normalize_folder_path(raw: &str) -> Option<String> {
    let segments: Vec<&str> = raw.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        None
    } else {
        Some(format!("{}/", segments.join("/")))
    }
}

/// Whether a raw `--folder` argument carries a control character, in which
/// case the write must be REFUSED rather than normalized.
///
/// A newline is not "an odd character inside a segment" the way the module
/// doc's provenance argument covers — it is the frontmatter LINE SEPARATOR,
/// and [`compose_plaintext`] interpolates the folder value into a
/// frontmatter block. `--folder $'Private\nx'` normalizes to `"Private\nx/"`,
/// which no longer has the excluded prefix shape (so the scope check passes)
/// and then composes to two frontmatter lines, of which the first is
/// `folder: Private` — the excluded destination the check just allowed. The
/// same mechanism sets any OTHER managed field the CLI was never given a
/// surface for (`--folder $'Notes/\ntrashed: 2026-01-01T00:00:00Z'` births a
/// note in the trash).
///
/// `markdown-dialect.md` §3.6.2 forbids C0 controls in a segment for exactly
/// this class of reason; `char::is_control` (Unicode `Cc`) is that set plus
/// DEL and C1, which are equally not segment characters.
pub fn folder_arg_has_control_char(raw: &str) -> bool {
    raw.chars().any(char::is_control)
}

/// Compose the plaintext [`myne_core::plugins::notes::commands::note_create_from_host`]
/// receives: `body` verbatim when `folder` is `None` (a root note — no
/// frontmatter, matching a blank/no-folder UI create), or `body` prefixed
/// with a minimal `folder:` frontmatter block when `Some` — the exact shape
/// `title_extract::extract_title_slices` reads back.
pub fn compose_plaintext(body: &str, folder: Option<&str>) -> String {
    match folder {
        Some(folder) => format!("---\nfolder: {folder}\n---\n{body}"),
        None => body.to_string(),
    }
}

/// Compose the plaintext for a newly-created daily note (`myne daily`/
/// `daily:append`'s create path, task 9): `title:` (ALWAYS quoted) + an
/// optional `folder:` (as [`compose_plaintext`]) + `body` verbatim.
///
/// The title is always a [`myne_core::plugins::notes::daily_match::format_daily_date`]
/// output — a date-shaped string — so it is always quoted rather than
/// conditionally, mirroring the *effect* of
/// `dialect/src/surgery.ts::formatYamlTitleScalar`'s date-guard ("a
/// date-shaped title inserted unquoted reads back as a YAML timestamp →
/// 'Untitled', breaking the folder+title daily-note match rule") without
/// porting that function's general `js-yaml`-backed re-typing detector: this
/// caller's title is never anything BUT a date-shaped string, so "always
/// quote" is exactly as safe and needs no YAML parser.
pub fn compose_daily_plaintext(body: &str, title: &str, folder: Option<&str>) -> String {
    let escaped = title.replace('\\', "\\\\").replace('"', "\\\"");
    match folder {
        Some(folder) => format!("---\ntitle: \"{escaped}\"\nfolder: {folder}\n---\n{body}"),
        None => format!("---\ntitle: \"{escaped}\"\n---\n{body}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_inputs_normalize_to_none() {
        assert_eq!(normalize_folder_path(""), None);
        assert_eq!(normalize_folder_path("/"), None);
        assert_eq!(normalize_folder_path("//"), None);
    }

    #[test]
    fn a_bare_segment_gets_a_trailing_slash() {
        assert_eq!(
            normalize_folder_path("Private"),
            Some("Private/".to_string())
        );
    }

    #[test]
    fn an_already_trailing_slash_segment_is_unchanged() {
        assert_eq!(
            normalize_folder_path("Private/"),
            Some("Private/".to_string())
        );
    }

    #[test]
    fn nested_segments_join_with_single_slashes() {
        assert_eq!(
            normalize_folder_path("Private//Journal/"),
            Some("Private/Journal/".to_string())
        );
    }

    #[test]
    fn leading_slash_is_dropped() {
        assert_eq!(
            normalize_folder_path("/Private/"),
            Some("Private/".to_string())
        );
    }

    #[test]
    fn a_newline_in_the_folder_argument_is_rejected_not_normalized() {
        // The injection this guard exists for: structural normalization
        // splits on `/` only, so the newline survives into a "normalized"
        // folder string whose prefix shape no longer matches the excluded
        // entry — and then composes into a SECOND frontmatter line.
        assert!(folder_arg_has_control_char("Private\nx"));
        // Left un-refused, this is what would reach the vault.
        let normalized = normalize_folder_path("Private\nx").expect("structurally non-root");
        assert_eq!(normalized, "Private\nx/");
        let smuggled = compose_plaintext("body", Some(&normalized));
        assert_eq!(smuggled, "---\nfolder: Private\nx/\n---\nbody");
        assert_eq!(
            myne_core::plugins::notes::title_extract::extract_title_slices(smuggled.as_bytes())
                .frontmatter_bytes
                .and_then(myne_core::plugins::notes::title_extract::fm_folder),
            Some("Private".to_string()),
            "the note would land in `Private/` — the destination the scope \
             check was asked about was `Private\\nx/`"
        );
    }

    #[test]
    fn every_control_character_class_is_rejected() {
        for raw in [
            "a\nb",
            "a\rb",
            "a\tb",
            "a\u{0000}b",
            "a\u{007F}b",
            "a\u{0085}b",
        ] {
            assert!(
                folder_arg_has_control_char(raw),
                "{raw:?} must be refused before composition"
            );
        }
    }

    #[test]
    fn an_ordinary_folder_argument_is_not_rejected() {
        // The guard is narrow on purpose — spaces, punctuation, non-ASCII
        // letters and emoji are all legal folder-name characters
        // (`isLegalSegment`'s Obsidian permissiveness), and this module
        // deliberately does not reimplement the rest of that grammar.
        for raw in ["Private/", "My Notes/2026", "Café/", "notes 🗒/", ""] {
            assert!(!folder_arg_has_control_char(raw), "{raw:?} must be allowed");
        }
    }

    #[test]
    fn compose_with_no_folder_is_the_body_verbatim() {
        assert_eq!(compose_plaintext("hello", None), "hello");
    }

    #[test]
    fn compose_with_a_folder_injects_frontmatter_the_scanner_reads_back() {
        use myne_core::plugins::notes::title_extract::{extract_title_slices, fm_folder};

        let plaintext = compose_plaintext("hello", Some("Private/"));
        assert_eq!(plaintext, "---\nfolder: Private/\n---\nhello");
        let slices = extract_title_slices(plaintext.as_bytes());
        assert_eq!(
            slices.frontmatter_bytes.and_then(fm_folder),
            Some("Private/".to_string())
        );
    }

    #[test]
    fn compose_daily_plaintext_always_quotes_the_title() {
        assert_eq!(
            compose_daily_plaintext("body", "2026-07-30", None),
            "---\ntitle: \"2026-07-30\"\n---\nbody"
        );
    }

    #[test]
    fn compose_daily_plaintext_includes_folder_when_present() {
        assert_eq!(
            compose_daily_plaintext("body", "2026-07-30", Some("Daily/")),
            "---\ntitle: \"2026-07-30\"\nfolder: Daily/\n---\nbody"
        );
    }

    #[test]
    fn compose_daily_plaintext_round_trips_through_the_value_strict_reader() {
        use myne_core::plugins::notes::daily_match::fm_title_value_strict;
        use myne_core::plugins::notes::title_extract::extract_title_slices;

        let plaintext = compose_daily_plaintext("body", "2026-07-30", Some("Daily/"));
        let slices = extract_title_slices(plaintext.as_bytes());
        assert_eq!(
            slices.frontmatter_bytes.and_then(fm_title_value_strict),
            Some("2026-07-30".to_string())
        );
    }

    #[test]
    fn compose_daily_plaintext_escapes_backslash_and_quote_in_the_title() {
        // The title is always a machine-generated date string in practice,
        // but the escape must still be correct if `daily_date_format` ever
        // produces something containing these characters.
        let plaintext = compose_daily_plaintext("body", "a\"b\\c", None);
        assert_eq!(plaintext, "---\ntitle: \"a\\\"b\\\\c\"\n---\nbody");
    }
}
