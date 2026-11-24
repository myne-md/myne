// SPDX-License-Identifier: AGPL-3.0-only
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

/// Days since 1970-01-01 for a proleptic-Gregorian civil date (Howard
/// Hinnant's `days_from_civil`). Integer arithmetic on purpose: this crate
/// compiles for `wasm32` and a calendar crate here would be a dependency
/// decision for one week number.
pub(crate) fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = i64::from(if m <= 2 { y - 1 } else { y });
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = i64::from((m + 9) % 12); // March = 0
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146097 + doe - 719468
}

/// The inverse of [`days_from_civil`], returning `(year, month, day)`.
pub(crate) fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32; // [1, 12]
    ((if m <= 2 { y + 1 } else { y }) as i32, m, d)
}

/// ISO 8601 week identity for a civil date: `(week_year, 1-based week)`.
/// Weeks start Monday and week 1 holds the year's first Thursday, so
/// 2027-01-01 is 2026-W53. The WEEK-YEAR is the load-bearing half: pairing a
/// calendar year with a week number splits one week across two titles at the
/// boundary, and the match rule below keys on folder + title, so that is one
/// week with two notes. Mirrors `dailyNote.ts::isoWeek` exactly.
pub fn iso_week(ymd: (i32, u32, u32)) -> (i32, u32) {
    let z = days_from_civil(ymd.0, ymd.1, ymd.2);
    // 1970-01-01 was a Thursday, i.e. Monday-index 3.
    let thursday = z - (z + 3).rem_euclid(7) + 3;
    let week_year = civil_from_days(thursday).0;
    // January 4th is in week 1 by definition, so its Thursday is week 1's.
    let jan4 = days_from_civil(week_year, 1, 4);
    let first_thursday = jan4 - (jan4 + 3).rem_euclid(7) + 3;
    let week = ((thursday - first_thursday) / 7 + 1) as u32;
    (week_year, week)
}

/// The periods with first-class support (myne#177). Mirrors
/// `src/notes/dailyNote.ts::PERIODS`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Period {
    Daily,
    Weekly,
    Monthly,
}

impl Period {
    /// Parse the wire spelling. Returns `None` for anything else, so an older
    /// host answers a period it does not know with a refusal rather than
    /// silently doing daily.
    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "daily" => Some(Self::Daily),
            "weekly" => Some(Self::Weekly),
            "monthly" => Some(Self::Monthly),
            _ => None,
        }
    }

    /// The `<period>` half of a `periodic_notes` key, and the wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Daily => "daily",
            Self::Weekly => "weekly",
            Self::Monthly => "monthly",
        }
    }

    /// Canonical default folder + title format, mirroring
    /// `src/notes/dailyNote.ts::PERIOD_DEFAULTS` exactly. A divergence here
    /// files the same period in two folders across two clients of one vault.
    pub fn defaults(self) -> (&'static str, &'static str) {
        match self {
            Self::Daily => (DEFAULT_DAILY_FOLDER, DEFAULT_DAILY_DATE_FORMAT),
            Self::Weekly => ("Weekly/", "gggg-[W]ww"),
            Self::Monthly => ("Monthly/", "YYYY-MM"),
        }
    }
}

/// A civil date as `(year, 1-based month, 1-based day)`.
pub type CivilDate = (i32, u32, u32);

/// A period's inclusive day range plus the anchor its title is formatted from,
/// as `(anchor, start, end)` civil dates. The anchor is the range's FIRST day
/// for every period, which is what makes "open this period" idempotent from any
/// day inside it. Weeks start Monday (ISO 8601). Mirrors
/// `src/notes/dailyNote.ts::periodRange`.
pub fn period_range(ymd: CivilDate, period: Period) -> (CivilDate, CivilDate, CivilDate) {
    match period {
        Period::Daily => (ymd, ymd, ymd),
        Period::Weekly => {
            let z = days_from_civil(ymd.0, ymd.1, ymd.2);
            // 1970-01-01 was a Thursday, i.e. Monday-index 3.
            let monday = z - (z + 3).rem_euclid(7);
            let start = civil_from_days(monday);
            (start, start, civil_from_days(monday + 6))
        }
        Period::Monthly => {
            let start = (ymd.0, ymd.1, 1);
            // The day before the 1st of the NEXT month is the last day of this
            // one, February and leap years included, with no table.
            let (ny, nm) = if ymd.1 == 12 {
                (ymd.0 + 1, 1)
            } else {
                (ymd.0, ymd.1 + 1)
            };
            let end = civil_from_days(days_from_civil(ny, nm, 1) - 1);
            (start, start, end)
        }
    }
}

/// One period's `(folder, format, template)`, each `None` when unset so the
/// caller applies [`Period::defaults`] host-side.
pub type PeriodSettings<'a> = (Option<&'a str>, Option<&'a str>, Option<&'a str>);

/// Resolve one period's `(folder, format, template)` out of a decoded
/// `PrefsView`-shaped pair: the three legacy `daily_*` fields and the
/// `periodic_notes` map. Daily reads the flat fields and the others read the
/// map; a `daily.*` entry in the map is IGNORED, so a client that writes one
/// cannot give a single setting two homes. Mirrors
/// `src/notes/dailyNote.ts::periodSettings`.
pub fn period_settings<'a>(
    period: Period,
    daily: PeriodSettings<'a>,
    periodic_notes: &'a std::collections::BTreeMap<String, String>,
) -> PeriodSettings<'a> {
    if period == Period::Daily {
        return daily;
    }
    let read = |setting: &str| -> Option<&'a str> {
        periodic_notes
            .get(&format!("{}.{}", period.as_str(), setting))
            .map(String::as_str)
    };
    (read("folder"), read("format"), read("template"))
}

/// Format a `(year, 1-based month, 1-based day)` tuple into a period
/// date-title, matching `dailyNote.ts::formatDailyDate`'s token grammar.
/// Tokens, longest first: `YYYY` (calendar year), `gggg` (ISO week-year),
/// `MM`, `DD`, `ww` (ISO week). A `[...]` run is literal text with the
/// brackets stripped, so `gggg-[W]ww` renders `2026-W35`; an unterminated `[`
/// is itself literal. Every other character passes through.
///
/// One left-to-right pass rather than successive `str::replace`, and the
/// escape is what forces it: every week format wants a literal `W` beside the
/// `ww` token, and under successive replaces `W` + `ww` and `ww` + `W` are the
/// same string with neither reading more correct (myne#177).
pub fn format_daily_date(ymd: (i32, u32, u32), format: &str) -> String {
    let (year, month, day) = ymd;
    let mut out = String::with_capacity(format.len() + 8);
    let bytes = format.as_bytes();
    let mut i = 0usize;

    while i < format.len() {
        if bytes[i] == b'[' {
            if let Some(rel) = format[i + 1..].find(']') {
                out.push_str(&format[i + 1..i + 1 + rel]);
                i += rel + 2;
                continue;
            }
            // Unterminated: the bracket is ordinary text, so fall through.
        }

        let rest = &format[i..];
        if let Some(len) = match rest {
            _ if rest.starts_with("YYYY") => {
                out.push_str(&year.to_string());
                Some(4)
            }
            _ if rest.starts_with("gggg") => {
                out.push_str(&iso_week(ymd).0.to_string());
                Some(4)
            }
            _ if rest.starts_with("MM") => {
                out.push_str(&format!("{month:02}"));
                Some(2)
            }
            _ if rest.starts_with("DD") => {
                out.push_str(&format!("{day:02}"));
                Some(2)
            }
            _ if rest.starts_with("ww") => {
                out.push_str(&format!("{:02}", iso_week(ymd).1));
                Some(2)
            }
            _ => None,
        } {
            i += len;
            continue;
        }

        // `i` is a char boundary here, so this cannot split a code point.
        let ch = rest.chars().next().expect("non-empty remainder");
        out.push(ch);
        i += ch.len_utf8();
    }
    out
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

/// Read the `updated:` stamp value-strict (the `collab-editor-bridge` task 7
/// MAX-OBSERVED rule). A free-text `updated:` is not a value here, exactly as for
/// the other timestamp markers.
pub fn fm_updated_value_strict(frontmatter: &[u8]) -> Option<String> {
    fm_timestamp_value_strict(frontmatter, "updated")
}

/// Read the `archived:` marker value-strict — mirrors
/// `readArchivedFromFmBody`, the exact value-strict twin of
/// [`fm_trashed_value_strict`].
pub fn fm_archived_value_strict(frontmatter: &[u8]) -> Option<String> {
    fm_timestamp_value_strict(frontmatter, "archived")
}

/// Read the `conflict:` keep-both marker value-strict — mirrors
/// `readConflictFromFmBody`: `true` iff the field carries the literal,
/// unquoted `true`. The boolean twin of [`fm_template_value_strict`], not of
/// [`fm_trashed_value_strict`].
pub fn fm_conflict_value_strict(frontmatter: &[u8]) -> bool {
    fm_literal_true_value_strict(frontmatter, "conflict")
}

/// Read the `template:` marker value-strict — mirrors
/// `readTemplateFromFmBody`: `true` iff the field carries the literal,
/// unquoted `true` (a trailing comment stripped first); everything else —
/// `template: "true"` / `template: 1` / `template: True` / an absent field —
/// is `false`.
pub fn fm_template_value_strict(frontmatter: &[u8]) -> bool {
    fm_literal_true_value_strict(frontmatter, "template")
}

/// The boolean counterpart of [`fm_timestamp_value_strict`]: `true` iff the
/// field carries the literal, unquoted `true` with any trailing comment
/// stripped. Shared so the two boolean markers cannot drift into different
/// notions of strictness, the way a hand copy would.
fn fm_literal_true_value_strict(frontmatter: &[u8], key: &str) -> bool {
    let text = String::from_utf8_lossy(frontmatter);
    let Some(value) = find_key_line(&text, key) else {
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
    fn format_daily_date_pads_single_digit_month_and_day() {
        assert_eq!(format_daily_date((2026, 1, 5), "YYYY-MM-DD"), "2026-01-05");
    }

    #[test]
    fn format_daily_date_supports_separator_variants() {
        assert_eq!(format_daily_date((2026, 7, 30), "YYYY/MM/DD"), "2026/07/30");
        assert_eq!(format_daily_date((2026, 7, 30), "DD.MM.YYYY"), "30.07.2026");
    }

    // Period token grammar (myne#177). The same case table runs in the two
    // TypeScript copies of this formatter (tests/notes/dailyNote.test.ts and
    // mobile/tests/daily.test.ts). Three implementations that agree only by
    // review are three implementations that will drift, so the cases are
    // deliberately the same cases.

    // The period model (myne#177). Same cases as the two TypeScript copies.

    #[test]
    fn period_range_anchors_a_week_on_its_monday() {
        // 2026-08-26 is a Wednesday.
        let (anchor, start, end) = period_range((2026, 8, 26), Period::Weekly);
        assert_eq!(start, (2026, 8, 24));
        assert_eq!(end, (2026, 8, 30));
        assert_eq!(anchor, start);
    }

    #[test]
    fn period_range_treats_sunday_as_the_end_of_its_week() {
        // Sunday is the case an off-by-one gets wrong: it belongs to the week
        // that STARTED six days earlier, not the next one.
        let (_, start, end) = period_range((2026, 8, 30), Period::Weekly);
        assert_eq!(start, (2026, 8, 24));
        assert_eq!(end, (2026, 8, 30));
    }

    #[test]
    fn period_range_ends_a_month_on_its_real_last_day() {
        assert_eq!(
            period_range((2026, 8, 26), Period::Monthly).2,
            (2026, 8, 31)
        );
        assert_eq!(
            period_range((2026, 2, 10), Period::Monthly).2,
            (2026, 2, 28)
        );
        assert_eq!(
            period_range((2028, 2, 10), Period::Monthly).2,
            (2028, 2, 29)
        );
        // December has to roll the YEAR, not just the month.
        assert_eq!(
            period_range((2026, 12, 5), Period::Monthly).2,
            (2026, 12, 31)
        );
    }

    #[test]
    fn period_range_keeps_a_week_whole_across_a_month_boundary() {
        // 2026-09-02 is a Wednesday; its week starts in August.
        let (_, start, end) = period_range((2026, 9, 2), Period::Weekly);
        assert_eq!(start, (2026, 8, 31));
        assert_eq!(end, (2026, 9, 6));
    }

    /// Render `core/src/plugins/notes/period-title-cases.json` (myne#177).
    ///
    /// That file is the ONE table all three implementations of this grammar are
    /// checked against: this one, `src/notes/dailyNote.ts` and
    /// `mobile/src/lib/daily.ts`. Before it, the three were pinned only by
    /// hand-copied values in three test files and a comment saying they
    /// agreed, which is a claim rather than a check.
    ///
    /// It lives in this repo rather than in `myne-test-vectors` because every
    /// implementation of the grammar is in this repo, there is no out-of-repo
    /// port to bind, and the companion's runners skip when the fixture is
    /// absent while `vector-verification` is commented out in CI. Here it runs
    /// under `cargo test`, `pnpm test` and `pnpm mobile:test`.
    fn render_period_title_cases() -> String {
        // (id, y, m, d, period, format-or-empty-for-the-period-default)
        let cases: &[(&str, i32, u32, u32, Period, &str)] = &[
            ("daily-default", 2026, 8, 26, Period::Daily, ""),
            ("weekly-default", 2026, 8, 26, Period::Weekly, ""),
            ("monthly-default", 2026, 8, 26, Period::Monthly, ""),
            // The anchor is the period's FIRST day, so a title is stable across
            // the period. A Wednesday must title the same as its Monday.
            (
                "weekly-anchor-is-the-monday",
                2026,
                8,
                26,
                Period::Weekly,
                "YYYY-MM-DD",
            ),
            (
                "weekly-from-the-monday-itself",
                2026,
                8,
                24,
                Period::Weekly,
                "YYYY-MM-DD",
            ),
            (
                "monthly-anchor-is-the-first",
                2026,
                8,
                26,
                Period::Monthly,
                "YYYY-MM-DD",
            ),
            // The week-year, which is the whole reason `gggg` exists: a calendar
            // year here would title one week twice and split it into two notes.
            ("week-year-new-years-day", 2027, 1, 1, Period::Weekly, ""),
            ("week-year-late-december", 2026, 12, 28, Period::Weekly, ""),
            (
                "week-year-first-thursday-rule",
                2024,
                1,
                1,
                Period::Weekly,
                "",
            ),
            // Zero padding on a single-digit week, which a naive `to_string`
            // would get wrong and which sorts wrong in a folder listing.
            ("week-number-is-zero-padded", 2026, 2, 3, Period::Weekly, ""),
            // A week whole across a month boundary.
            (
                "weekly-across-a-month-boundary",
                2026,
                9,
                2,
                Period::Weekly,
                "YYYY-MM-DD",
            ),
            // The escape.
            (
                "escape-literal-run",
                2026,
                8,
                24,
                Period::Daily,
                "[Journal] YYYY-MM-DD",
            ),
            ("escape-empty-pair", 2026, 8, 24, Period::Weekly, "gggg[]ww"),
            (
                "escape-unterminated-bracket",
                2026,
                8,
                24,
                Period::Daily,
                "YYYY-[MM",
            ),
            (
                "escape-swallows-a-token-name",
                2026,
                8,
                24,
                Period::Daily,
                "[YYYY]-MM",
            ),
            // Longest-first: `YYYY` must not be read as two unknown pairs, and
            // `gggg` must not be read as `gg` twice.
            ("longest-token-wins", 2026, 8, 24, Period::Daily, "YYYYMMDD"),
            // Unknown characters are literal, and the walk steps by code point.
            (
                "multibyte-literals-survive",
                2026,
                8,
                24,
                Period::Daily,
                "YYYY\u{5e74}MM\u{6708}DD\u{65e5}",
            ),
            (
                "unknown-letters-pass-through",
                2026,
                8,
                24,
                Period::Daily,
                "DDD",
            ),
        ];

        let mut out = String::new();
        out.push_str("{\n  \"schema\": \"period-title-format/v1\",\n");
        out.push_str("  \"note\": \"GENERATED. The one table the three period-title implementations are checked against (myne#177): core/src/plugins/notes/daily_match.rs, src/notes/dailyNote.ts, mobile/src/lib/daily.ts. Each case formats periodRange(date, period).anchor with format and must produce title. Regenerate with: cargo test -p myne-core --lib emit_period_title_cases -- --ignored --nocapture\",\n");
        // Emitted from `Period::defaults` itself. Both halves: the FOLDER is the
        // one this table used to omit, and it is the half whose divergence
        // files one period in two folders across two clients of one vault,
        // which is what `Period::defaults`' own doc comment says it exists to
        // prevent.
        out.push_str("  \"defaults\": {\n");
        for (n, period) in [Period::Daily, Period::Weekly, Period::Monthly]
            .iter()
            .enumerate()
        {
            let (folder, format) = period.defaults();
            out.push_str(&format!(
                "    \"{}\": {{ \"folder\": \"{}\", \"format\": \"{}\" }}{}\n",
                period.as_str(),
                folder,
                format,
                if n == 2 { "" } else { "," },
            ));
        }
        out.push_str("  },\n");
        out.push_str("  \"cases\": [\n");
        for (n, (id, y, m, d, period, fmt)) in cases.iter().enumerate() {
            let format = if fmt.is_empty() {
                period.defaults().1
            } else {
                *fmt
            };
            let (anchor, start, end) = period_range((*y, *m, *d), *period);
            let title = format_daily_date(anchor, format);
            let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
            out.push_str(&format!(
                "    {{ \"id\": \"{}\", \"date\": [{}, {}, {}], \"period\": \"{}\", \"format\": \"{}\", \"anchor\": [{}, {}, {}], \"start\": [{}, {}, {}], \"end\": [{}, {}, {}], \"title\": \"{}\" }}{}\n",
                id, y, m, d, period.as_str(), esc(format),
                anchor.0, anchor.1, anchor.2,
                start.0, start.1, start.2,
                end.0, end.1, end.2,
                esc(&title),
                if n + 1 == cases.len() { "" } else { "," },
            ));
        }
        out.push_str("  ]\n}\n");
        out
    }

    /// Mint the table. Run with `--ignored --nocapture` and redirect; there is
    /// no formatter to run over it, since the renderer emits final bytes.
    #[test]
    #[ignore = "generator: emits the case table, run with --nocapture"]
    fn emit_period_title_cases() {
        print!("{}", render_period_title_cases());
    }

    /// The committed table is what this implementation produces, byte for byte.
    /// Without this the JSON is a file somebody could edit into agreement with
    /// a broken formatter, which is the failure the table exists to prevent.
    #[test]
    fn the_committed_period_title_cases_are_what_this_implementation_produces() {
        assert_eq!(
            include_str!("period-title-cases.json"),
            render_period_title_cases(),
            "regenerate with: cargo test -p myne-core --lib emit_period_title_cases \
             -- --ignored --nocapture"
        );
    }

    #[test]
    fn period_from_wire_refuses_a_period_it_does_not_know() {
        assert_eq!(Period::from_wire("weekly"), Some(Period::Weekly));
        // A refusal rather than a silent fall-back to daily: an older host
        // answering "unknown" is recoverable, one quietly writing the wrong
        // note is not.
        assert_eq!(Period::from_wire("quarterly"), None);
        assert_eq!(Period::from_wire("Weekly"), None);
    }

    #[test]
    fn period_settings_reads_daily_flat_and_the_others_from_the_map() {
        let mut map = std::collections::BTreeMap::new();
        map.insert("weekly.folder".to_string(), "Weekly/".to_string());
        map.insert("daily.folder".to_string(), "Wrong/".to_string());
        let daily = (Some("Journal/"), Some("YYYY/MM/DD"), Some("tmpl"));

        // A `daily.*` entry in the map is ignored: daily lives in the flat
        // fields, and honouring it would give one setting two homes.
        assert_eq!(
            period_settings(Period::Daily, daily, &map),
            (Some("Journal/"), Some("YYYY/MM/DD"), Some("tmpl"))
        );
        assert_eq!(
            period_settings(Period::Weekly, daily, &map),
            (Some("Weekly/"), None, None)
        );
    }

    #[test]
    fn iso_week_numbers_a_mid_year_monday() {
        // 2026-08-24 is a Monday; its Thursday is 2026-08-27, 34 weeks after
        // the first Thursday of 2026 (2026-01-01), so it is week 35.
        assert_eq!(iso_week((2026, 8, 24)), (2026, 35));
    }

    #[test]
    fn iso_week_keeps_a_week_whole_across_the_year_boundary() {
        // Both days are in the same ISO week. A calendar year would title them
        // 2026-W53 and 2027-W53: one week, two notes.
        assert_eq!(iso_week((2026, 12, 28)), (2026, 53));
        assert_eq!(iso_week((2027, 1, 1)), (2026, 53));
    }

    #[test]
    fn iso_week_puts_early_january_in_the_previous_week_year() {
        // 2021-01-01 is a Friday, so it belongs to 2020-W53.
        assert_eq!(iso_week((2021, 1, 1)), (2020, 53));
    }

    #[test]
    fn iso_week_starts_week_one_on_the_first_thursdays_monday() {
        assert_eq!(iso_week((2024, 1, 1)), (2024, 1));
    }

    #[test]
    fn format_daily_date_expands_week_tokens_with_the_week_year() {
        assert_eq!(format_daily_date((2026, 8, 24), "gggg-[W]ww"), "2026-W35");
        assert_eq!(format_daily_date((2027, 1, 1), "gggg-[W]ww"), "2026-W53");
        assert_eq!(format_daily_date((2026, 12, 28), "gggg-[W]ww"), "2026-W53");
    }

    #[test]
    fn format_daily_date_zero_pads_the_week_number() {
        assert_eq!(format_daily_date((2026, 1, 29), "gggg-[W]ww"), "2026-W05");
    }

    #[test]
    fn format_daily_date_treats_a_bracketed_run_as_literal() {
        assert_eq!(format_daily_date((2026, 8, 24), "[Week ]ww"), "Week 35");
        assert_eq!(format_daily_date((2026, 8, 24), "[YYYY]"), "YYYY");
        assert_eq!(format_daily_date((2026, 8, 24), "[gggg-ww]"), "gggg-ww");
    }

    #[test]
    fn format_daily_date_re_reads_a_stored_format_that_used_the_new_tokens_as_literals() {
        // The one-time compatibility break myne#177 accepts, pinned so it is a
        // recorded behaviour rather than a surprise. `[`, `ww` and `gggg` were
        // ordinary characters under the pre-myne#177 grammar and are grammar
        // now, so a `daily_date_format` already on disk containing one of them
        // renders a different title. `protocol.md` 9.5.2 and decision 0539 say
        // why there is no migration: existing notes keep their titles, the next
        // open makes one under the new title, nothing is lost.
        assert_eq!(
            format_daily_date((2026, 8, 24), "YYYY-MM-DD [journal]"),
            "2026-08-24 journal",
            "was `2026-08-24 [journal]` before myne#177"
        );
        assert_eq!(
            format_daily_date((2026, 8, 24), "gggg"),
            "2026",
            "was the literal `gggg` before myne#177"
        );
        assert_eq!(
            format_daily_date((2026, 8, 24), "ww"),
            "35",
            "was the literal `ww` before myne#177"
        );
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
