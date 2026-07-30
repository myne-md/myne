// SPDX-License-Identifier: AGPL-3.0
//! Value-strict frontmatter readers + the daily-note "which note is today's
//! note?" match rule (cli-thin-client task 9; MYND-490).
//!
//! Rust port of `dialect/src/surgery.ts`'s value-strict field readers
//! (`readTitleFromFmBody` / `readTrashedFromFmBody` / `readDeletedFromFmBody`
//! / `readTemplateFromFmBody`) and `src/notes/dailyNote.ts`'s
//! `resolveTodayNote` match rule / `formatDailyDate` — needed CLI-side
//! because `cli_bridge` is a raw socket with no WebView to run the TS
//! dialect module. Pure; no IO, no clock read — the caller supplies both the
//! decrypted frontmatter bytes and the calendar date (see
//! `src-tauri/src/cli_bridge/daily.rs` for the host-side glue that reads
//! `vault.prefs` and the OS-local clock).
//!
//! Deliberately a fresh, independent copy of the TS grammar rather than a
//! byte-for-byte transliteration of every YAML edge case (no `js-yaml`
//! quoted-scalar backtracking, no `Date.parse` full calendar-range
//! validation) — the values these fields ever actually hold are
//! Myne-written (a real RFC 3339 timestamp, the literal `true`, a
//! date-format title), so exact parity on adversarial/hand-edited input is
//! not the bar this module is held to. Matches the "structural port, not
//! full grammar fidelity" precedent `cli_bridge::compose::normalize_folder_path`
//! already set.

use unicode_normalization::UnicodeNormalization;

/// Canonical default daily folder when `daily_folder` is unset (`None` ≡
/// default) — mirrors `dailyNote.ts::DEFAULT_DAILY_FOLDER`.
pub const DEFAULT_DAILY_FOLDER: &str = "Daily/";
/// Canonical default daily date format when `daily_date_format` is unset —
/// mirrors `dailyNote.ts::DEFAULT_DAILY_DATE_FORMAT`.
pub const DEFAULT_DAILY_DATE_FORMAT: &str = "YYYY-MM-DD";

/// Case-fold + NFC identity key for a single path segment or title — mirrors
/// `dialect/src/folderPath.ts::foldSegment` exactly (NFC then lowercase).
pub fn fold(s: &str) -> String {
    s.nfc().collect::<String>().to_lowercase()
}

/// Format a `(year, 1-based month, 1-based day)` tuple into a daily
/// date-title, matching `dailyNote.ts::formatDailyDate`'s token grammar:
/// `YYYY`/`MM`/`DD` replaced left-to-right (`YYYY` first), zero-padded
/// month/day, every other character passes through literally.
pub fn format_daily_date(ymd: (i32, u32, u32), format: &str) -> String {
    let (year, month, day) = ymd;
    format
        .replace("YYYY", &year.to_string())
        .replace("MM", &format!("{month:02}"))
        .replace("DD", &format!("{day:02}"))
}

/// Match a single frontmatter line against `^[ \t]*<key>[ \t]*:[ \t]*(.*)$`,
/// returning the raw value portion (group 2) — mirrors the TS `*_KEY_RE`
/// family (`TITLE_KEY_RE`/`TRASHED_KEY_RE`/`DELETED_KEY_RE`/`TEMPLATE_KEY_RE`).
fn match_key_line<'a>(line: &'a str, key: &str) -> Option<&'a str> {
    let s = line.trim_start_matches([' ', '\t']);
    let s = s.strip_prefix(key)?;
    let s = s.trim_start_matches([' ', '\t']);
    let s = s.strip_prefix(':')?;
    Some(s.trim_start_matches([' ', '\t']))
}

/// The FIRST top-level `<key>:` line in a frontmatter body decides — a later
/// duplicate never rescues an unusable first value (matches every TS
/// `read*FromFmBody`'s single-pass-then-return shape).
fn find_key_line<'a>(fm_body: &'a str, key: &str) -> Option<&'a str> {
    fm_body.lines().find_map(|line| match_key_line(line, key))
}

/// Strip a trailing `[ \t]+#…` YAML comment — mirrors the TS
/// `/^([^#]*?)([ \t]+#.*)$/` value-strict comment strip (the same rule
/// `drawing_text.rs::strip_inline_comment` already applies to `kind:`).
fn strip_inline_comment(value: &str) -> &str {
    let b = value.as_bytes();
    for i in 0..b.len().saturating_sub(1) {
        if (b[i] == b' ' || b[i] == b'\t') && b[i + 1] == b'#' {
            return &value[..i];
        }
    }
    value
}

/// Shared value-scalar extraction for `title:`/`trashed:`/`deleted:` —
/// mirrors `extractTitleScalar`/`extractTrashedScalar` (identical bodies in
/// the TS source): a block-scalar (`|`/`>`) or empty value declines; a
/// quoted value is unwrapped at its first matching close-quote (no escape
/// handling — Myne never writes an escaped quote into these fields, see
/// module doc); an unquoted value has its trailing `# comment` stripped,
/// then trimmed.
fn extract_value_scalar(value_portion: &str) -> Option<String> {
    let trimmed = value_portion.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with('|') || trimmed.starts_with('>') {
        return None;
    }
    let quoted = trimmed
        .strip_prefix('"')
        .map(|rest| ('"', rest))
        .or_else(|| trimmed.strip_prefix('\'').map(|rest| ('\'', rest)));
    if let Some((quote_char, rest)) = quoted {
        if let Some(close) = rest.find(quote_char) {
            let inner = &rest[..close];
            let after = rest[close + 1..].trim_start_matches([' ', '\t']);
            if after.is_empty() || after.starts_with('#') {
                return Some(inner.to_string());
            }
        }
        // No clean quoted match (e.g. an unbalanced quote) — falls through
        // to the unquoted comment-strip path below, mirroring the TS regex
        // simply failing to match and the caller trying the next branch.
    }
    let raw = strip_inline_comment(value_portion).trim();
    if raw.is_empty() {
        None
    } else {
        Some(raw.to_string())
    }
}

/// Read the FM `title:` scalar value-strict — mirrors `readTitleFromFmBody`.
/// This is the identity half of the daily-note match rule, distinct from
/// [`super::title_extract::fm_title`] (a looser search-index fallback
/// reader with no comment-stripping — see that module's own doc comment for
/// why the two must not be conflated).
pub fn fm_title_value_strict(frontmatter: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(frontmatter);
    let value = find_key_line(&text, "title")?;
    extract_value_scalar(value)
}

fn fm_timestamp_value_strict(frontmatter: &[u8], key: &str) -> Option<String> {
    let text = String::from_utf8_lossy(frontmatter);
    let value = find_key_line(&text, key)?;
    let scalar = extract_value_scalar(value)?;
    is_plausible_rfc3339(&scalar).then_some(scalar)
}

/// Read the `trashed:` marker value-strict — mirrors `readTrashedFromFmBody`:
/// `Some(rfc3339)` iff the field carries a valid-shaped RFC 3339 value, else
/// `None` (live). A user's own non-timestamp `trashed:` (e.g. `trashed:
/// true`) leaves the note live.
pub fn fm_trashed_value_strict(frontmatter: &[u8]) -> Option<String> {
    fm_timestamp_value_strict(frontmatter, "trashed")
}

/// Read the `deleted:` sync tombstone marker value-strict — mirrors
/// `readDeletedFromFmBody`, the exact value-strict twin of
/// [`fm_trashed_value_strict`].
pub fn fm_deleted_value_strict(frontmatter: &[u8]) -> Option<String> {
    fm_timestamp_value_strict(frontmatter, "deleted")
}

/// Read the `template:` marker value-strict — mirrors
/// `readTemplateFromFmBody`: `true` iff the field carries the literal,
/// unquoted `true` (a trailing comment stripped first); everything else —
/// `template: "true"` / `template: 1` / `template: True` / an absent field —
/// is `false`.
pub fn fm_template_value_strict(frontmatter: &[u8]) -> bool {
    let text = String::from_utf8_lossy(frontmatter);
    let Some(value) = find_key_line(&text, "template") else {
        return false;
    };
    strip_inline_comment(value).trim() == "true"
}

/// Structural RFC 3339 shape + digit-range plausibility check — mirrors the
/// TS `RFC3339_RE` shape test plus its `Date.parse` range follow-on, minus
/// full calendar validation (`2026-02-30` passes) — see module doc for why
/// that gap is acceptable here.
fn is_plausible_rfc3339(value: &str) -> bool {
    let b = value.as_bytes();
    if b.len() < 20 || !value.is_char_boundary(19) {
        return false;
    }
    let digit = |i: usize| b[i].is_ascii_digit();
    let digits_n = |start: usize, n: usize| (start..start + n).all(digit);
    if !(digits_n(0, 4)
        && b[4] == b'-'
        && digits_n(5, 2)
        && b[7] == b'-'
        && digits_n(8, 2)
        && matches!(b[10], b'T' | b't')
        && digits_n(11, 2)
        && b[13] == b':'
        && digits_n(14, 2)
        && b[16] == b':'
        && digits_n(17, 2))
    {
        return false;
    }
    let month: u32 = value[5..7].parse().unwrap_or(0);
    let day: u32 = value[8..10].parse().unwrap_or(0);
    let hour: u32 = value[11..13].parse().unwrap_or(99);
    let minute: u32 = value[14..16].parse().unwrap_or(99);
    let second: u32 = value[17..19].parse().unwrap_or(99);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return false;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return false;
    }

    let mut cursor = 19;
    if cursor < b.len() && b[cursor] == b'.' {
        cursor += 1;
        let start = cursor;
        while cursor < b.len() && b[cursor].is_ascii_digit() {
            cursor += 1;
        }
        if cursor == start {
            return false; // `.` with no following digit
        }
    }
    if cursor >= b.len() {
        return false;
    }
    match b[cursor] {
        b'Z' | b'z' => cursor + 1 == b.len(),
        b'+' | b'-' => {
            let rest = &value.as_bytes()[cursor + 1..];
            rest.len() == 5
                && rest[0].is_ascii_digit()
                && rest[1].is_ascii_digit()
                && rest[2] == b':'
                && rest[3].is_ascii_digit()
                && rest[4].is_ascii_digit()
        }
        _ => false,
    }
}

/// Whether a decrypted note's frontmatter matches today's daily-note
/// identity: not trashed/deleted/template, and its folder + title fold to
/// the caller-supplied want-keys — mirrors `resolveTodayNote`'s per-note
/// loop body exactly.
///
/// **Caller contract**, mirroring the TS side's own split of labour: `folder`
/// is the note's `folder:` value AFTER structural path normalization — the
/// `normalizeFolderPath` that `loadNoteBatch.ts` applies when it builds
/// `TitleRecord.folder` (drop empty segments, one trailing slash; `None` =
/// root) — and `want_folder_key` / `want_title_key` are already folded by the
/// caller via [`fold`]. This function does the per-candidate comparison only.
/// Handing it a raw `title_extract::fm_folder` value instead makes a
/// hand-edited `folder: Daily` note fail to match a canonical `Daily/`
/// want-key, so the CLI would create a second note for today that the app
/// itself would have reused.
pub fn note_matches_daily(
    frontmatter: Option<&[u8]>,
    folder: Option<&str>,
    want_folder_key: &str,
    want_title_key: &str,
) -> bool {
    let Some(fm) = frontmatter else {
        return false;
    };
    if fm_trashed_value_strict(fm).is_some() {
        return false;
    }
    if fm_deleted_value_strict(fm).is_some() {
        return false;
    }
    if fm_template_value_strict(fm) {
        return false;
    }
    let folder_key = folder.map(fold).unwrap_or_default();
    if folder_key != want_folder_key {
        return false;
    }
    let Some(title) = fm_title_value_strict(fm) else {
        return false;
    };
    fold(&title) == want_title_key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_daily_date_default_format() {
        assert_eq!(
            format_daily_date((2026, 7, 30), DEFAULT_DAILY_DATE_FORMAT),
            "2026-07-30"
        );
    }

    #[test]
    fn format_daily_date_pads_single_digit_month_and_day() {
        assert_eq!(format_daily_date((2026, 1, 5), "YYYY-MM-DD"), "2026-01-05");
    }

    #[test]
    fn format_daily_date_supports_separator_variants() {
        assert_eq!(format_daily_date((2026, 7, 30), "YYYY/MM/DD"), "2026/07/30");
        assert_eq!(format_daily_date((2026, 7, 30), "DD.MM.YYYY"), "30.07.2026");
    }

    #[test]
    fn fold_is_nfc_then_lowercase() {
        assert_eq!(fold("Private"), "private");
        assert_eq!(fold("Caf\u{00E9}"), fold("Cafe\u{0301}"));
    }

    #[test]
    fn fm_title_value_strict_reads_bare_scalar() {
        assert_eq!(
            fm_title_value_strict(b"title: 2026-07-30\nfolder: Daily/\n"),
            Some("2026-07-30".to_string())
        );
    }

    #[test]
    fn fm_title_value_strict_reads_quoted_scalar_and_strips_comment() {
        assert_eq!(
            fm_title_value_strict(b"title: \"2026-07-30\" # a comment\n"),
            Some("2026-07-30".to_string())
        );
        assert_eq!(
            fm_title_value_strict(b"title: 2026-07-30 # a comment\n"),
            Some("2026-07-30".to_string())
        );
    }

    #[test]
    fn fm_title_value_strict_declines_block_scalar_and_empty() {
        assert_eq!(fm_title_value_strict(b"title: |\n  x\n"), None);
        assert_eq!(fm_title_value_strict(b"title:\n"), None);
        assert_eq!(fm_title_value_strict(b"folder: x\n"), None);
    }

    #[test]
    fn fm_trashed_value_strict_requires_a_valid_timestamp() {
        assert_eq!(
            fm_trashed_value_strict(b"trashed: 2026-07-30T12:00:00Z\n"),
            Some("2026-07-30T12:00:00Z".to_string())
        );
        // A non-timestamp value leaves the note live (unprefixed-field
        // collision mitigation — matches `readTrashedFromFmBody`).
        assert_eq!(fm_trashed_value_strict(b"trashed: true\n"), None);
        assert_eq!(fm_trashed_value_strict(b"folder: x\n"), None);
    }

    #[test]
    fn fm_trashed_value_strict_accepts_fractional_seconds_and_offset() {
        assert_eq!(
            fm_trashed_value_strict(b"trashed: 2026-07-30T12:00:00.123+02:00\n"),
            Some("2026-07-30T12:00:00.123+02:00".to_string())
        );
    }

    #[test]
    fn fm_trashed_value_strict_rejects_out_of_range_calendar_fields() {
        assert_eq!(
            fm_trashed_value_strict(b"trashed: 2026-13-01T00:00:00Z\n"),
            None
        );
        assert_eq!(
            fm_trashed_value_strict(b"trashed: 2026-01-01T25:00:00Z\n"),
            None
        );
    }

    #[test]
    fn fm_deleted_value_strict_is_the_same_shape_as_trashed() {
        assert_eq!(
            fm_deleted_value_strict(b"deleted: 2026-07-30T12:00:00Z\n"),
            Some("2026-07-30T12:00:00Z".to_string())
        );
        assert_eq!(fm_deleted_value_strict(b"deleted: nope\n"), None);
    }

    #[test]
    fn fm_template_value_strict_is_value_strict() {
        assert!(fm_template_value_strict(b"template: true\n"));
        assert!(fm_template_value_strict(b"template: true # note\n"));
        assert!(!fm_template_value_strict(b"template: \"true\"\n"));
        assert!(!fm_template_value_strict(b"template: 1\n"));
        assert!(!fm_template_value_strict(b"template: True\n"));
        assert!(!fm_template_value_strict(b"folder: x\n"));
    }

    #[test]
    fn note_matches_daily_requires_folder_and_title_fold_match() {
        let fm = b"title: 2026-07-30\nfolder: Daily/\n";
        assert!(note_matches_daily(
            Some(fm),
            Some("Daily/"),
            &fold("Daily/"),
            &fold("2026-07-30")
        ));
        // Case/NFC-differing folder still matches.
        assert!(note_matches_daily(
            Some(fm),
            Some("DAILY/"),
            &fold("Daily/"),
            &fold("2026-07-30")
        ));
        // Wrong folder does not match.
        assert!(!note_matches_daily(
            Some(fm),
            Some("Other/"),
            &fold("Daily/"),
            &fold("2026-07-30")
        ));
        // Wrong title does not match.
        assert!(!note_matches_daily(
            Some(fm),
            Some("Daily/"),
            &fold("Daily/"),
            &fold("2026-07-31")
        ));
    }

    #[test]
    fn note_matches_daily_excludes_trashed_deleted_and_template() {
        let want_folder = fold("Daily/");
        let want_title = fold("2026-07-30");
        assert!(!note_matches_daily(
            Some(b"title: 2026-07-30\nfolder: Daily/\ntrashed: 2026-07-29T00:00:00Z\n"),
            Some("Daily/"),
            &want_folder,
            &want_title
        ));
        assert!(!note_matches_daily(
            Some(b"title: 2026-07-30\nfolder: Daily/\ndeleted: 2026-07-29T00:00:00Z\n"),
            Some("Daily/"),
            &want_folder,
            &want_title
        ));
        assert!(!note_matches_daily(
            Some(b"title: 2026-07-30\nfolder: Daily/\ntemplate: true\n"),
            Some("Daily/"),
            &want_folder,
            &want_title
        ));
    }

    #[test]
    fn note_matches_daily_with_no_frontmatter_never_matches() {
        assert!(!note_matches_daily(None, None, "", &fold("2026-07-30")));
    }

    #[test]
    fn note_matches_daily_root_folder_is_the_empty_key() {
        let fm = b"title: 2026-07-30\n";
        assert!(note_matches_daily(Some(fm), None, "", &fold("2026-07-30")));
    }
}
