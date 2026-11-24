// SPDX-License-Identifier: AGPL-3.0-only
//! Export mtime fidelity (MYND-115 task 3, SYNC-13).
//!
//! After a successful export write, the exported file's modified time is
//! set from the note's Myne-managed frontmatter `updated:` field
//! (`markdown-dialect.md` §3.6.1 — RFC 3339 UTC string written by
//! autosave) so sort-by-modified in Obsidian or a file manager reflects
//! the user's real editing history.
//!
//! Discipline:
//!
//! - **Conservative parse.** The mtime is set only when the `updated:`
//!   value parses cleanly as RFC 3339. The accepted shape is the exact
//!   lockstep twin of the TS validator (`src/dialect/surgery.ts`
//!   `RFC3339_RE` + `Date.parse` field validation):
//!   `YYYY-MM-DD[Tt]HH:MM:SS(.fff…)?([Zz]|±HH:MM)` with calendar-valid
//!   fields. Absent field, block scalar, or any unparsable value →
//!   no-op (the file keeps the natural export time).
//! - **Non-fatal.** The export already succeeded when this runs; an
//!   mtime-set failure emits a stage-tagged `tracing::warn!` only
//!   (closed [`IoFailureKind`], DENY-list-safe — no path, no note_id,
//!   no plaintext) and never surfaces an error. This non-fatality is
//!   structural — [`apply_updated_mtime`] returns `()`.
//! - **No new dependency.** The RFC 3339 parser is a hand-rolled strict
//!   scanner (std-only, `File::set_modified` stable since Rust 1.75);
//!   no chrono/time crate joins the TB9 audit surface.

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::io_failure_kind::from_io_error_kind;

use super::title_extract::{extract_title_slices, fm_raw_value};

/// Set `target_path`'s modified time from the note plaintext's
/// frontmatter `updated:` field — best-effort, never fails the caller.
///
/// Absent / unparsable `updated:` → no-op (natural export time stays).
/// An IO failure setting the mtime emits a stage-tagged warning only:
/// the export itself already succeeded, and a wrong mtime is cosmetic.
pub fn apply_updated_mtime(target_path: &Path, plaintext: &[u8]) {
    apply_updated_mtime_from(target_path, fm_updated_system_time(plaintext));
}

/// [`apply_updated_mtime`] with the `updated:` value already parsed —
/// the parse-once seam for the whole-vault export loop, which extracts
/// the FM slices once per note and feeds the parsed timestamp through.
/// `None` → no-op (natural export time stays); same best-effort,
/// structurally non-fatal contract.
pub(crate) fn apply_updated_mtime_from(target_path: &Path, updated: Option<SystemTime>) {
    let Some(ts) = updated else {
        return;
    };
    let result = std::fs::File::options()
        .write(true)
        .open(target_path)
        .and_then(|f| f.set_modified(ts));
    if let Err(e) = result {
        let io_kind = from_io_error_kind(e.kind());
        tracing::warn!(
            stage = "export_mtime",
            io_failure_kind = ?io_kind,
            "export mtime set from frontmatter updated: failed (non-fatal; export already succeeded)"
        );
    }
}

/// Extract the frontmatter `updated:` value as a [`SystemTime`], or
/// `None` when the FM block / field is absent or the value does not
/// parse cleanly as RFC 3339.
///
/// Mirrors the TS read shape (`surgery.ts::readTrashedFromFmBody`): the
/// FIRST top-level `updated:` line decides — a later duplicate never
/// rescues an invalid first value.
pub(crate) fn fm_updated_system_time(plaintext: &[u8]) -> Option<SystemTime> {
    fm_rfc3339_field(plaintext, b"updated:")
}

/// Generalized value-strict RFC 3339 frontmatter reader: the first
/// top-level `<key>` line decides; the value must parse cleanly as
/// RFC 3339 or the field counts as absent. With `key = b"trashed:"`
/// this is the lockstep twin of the TS `readTrashedFromFmBody`
/// (`surgery.ts`) — a user's own non-timestamp `trashed:` (e.g.
/// `trashed: true`) leaves the note live (§3.6.1 collision mitigation).
/// `pub(crate)`: the whole-vault export engine (`plugins::export`,
/// MYND-211) uses it for trash exclusion.
pub(crate) fn fm_rfc3339_field(plaintext: &[u8], key: &[u8]) -> Option<SystemTime> {
    let fm = extract_title_slices(plaintext).frontmatter_bytes?;
    fm_rfc3339_field_in(fm, key)
}

/// [`fm_rfc3339_field`] on an already-extracted frontmatter block —
/// the parse-once seam for the whole-vault export loop. Line locating
/// delegates to the shared `title_extract::fm_raw_value`; the
/// value-parsing semantics here (comment stripping, strict RFC 3339)
/// stay this module's own, TS-lockstep deliberate.
pub(crate) fn fm_rfc3339_field_in(frontmatter: &[u8], key: &[u8]) -> Option<SystemTime> {
    let rest = fm_raw_value(frontmatter, key)?;
    let raw = std::str::from_utf8(rest).ok()?;
    parse_rfc3339(extract_scalar(raw)?)
}

/// Extract the logical scalar string from the raw value portion of a
/// frontmatter line (the bytes after `updated:`): trims, strips one
/// layer of matching quotes, drops a trailing ` # comment`, declines
/// block scalars. Lockstep twin of `surgery.ts::extractTrashedScalar`.
fn extract_scalar(raw: &str) -> Option<&str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with('|') || trimmed.starts_with('>') {
        return None;
    }
    let bytes = trimmed.as_bytes();
    if bytes[0] == b'"' || bytes[0] == b'\'' {
        // Quoted scalar: value runs to the FIRST closing quote; the
        // remainder may only be whitespace or a whitespace+`#` comment.
        let quote = bytes[0] as char;
        let close_rel = trimmed[1..].find(quote)?;
        let value = &trimmed[1..1 + close_rel];
        let after = trimmed[1 + close_rel + 1..].trim_start();
        if !(after.is_empty() || after.starts_with('#')) {
            return None;
        }
        return Some(value);
    }
    // Bare scalar: cut at the first ` #` / `\t#` (trailing comment).
    let cut = bytes
        .windows(2)
        .position(|w| (w[0] == b' ' || w[0] == b'\t') && w[1] == b'#')
        .map(|i| &trimmed[..i])
        .unwrap_or(trimmed)
        .trim();
    (!cut.is_empty()).then_some(cut)
}

/// Strict RFC 3339 → [`SystemTime`] parse. Accepts exactly
/// `YYYY-MM-DD[Tt]HH:MM:SS(.f+)?([Zz]|±HH:MM)` with calendar-valid
/// fields (leap years honored; second 60 rejected, matching the TS
/// `Date.parse` lockstep). Returns `None` for anything else, including
/// pre-1970 instants (conservative — `updated:` is always post-epoch).
fn parse_rfc3339(value: &str) -> Option<SystemTime> {
    let b = value.as_bytes();
    if b.len() < 20 {
        return None;
    }
    let year = parse_digits(b, 0, 4)?;
    let month = parse_digits(b, 5, 2)? as u32;
    let day = parse_digits(b, 8, 2)? as u32;
    if b[4] != b'-' || b[7] != b'-' || !(b[10] == b'T' || b[10] == b't') {
        return None;
    }
    let hour = parse_digits(b, 11, 2)?;
    let minute = parse_digits(b, 14, 2)?;
    let second = parse_digits(b, 17, 2)?;
    if b[13] != b':' || b[16] != b':' {
        return None;
    }
    if month == 0 || month > 12 || day == 0 || day > days_in_month(year, month) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }

    // Optional fractional seconds: `.` followed by one or more digits.
    let mut i = 19;
    let mut nanos: u32 = 0;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let frac_start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == frac_start {
            return None;
        }
        let mut mult: u32 = 100_000_000;
        for &d in &b[frac_start..(frac_start + 9).min(i)] {
            nanos += u32::from(d - b'0') * mult;
            mult /= 10;
        }
    }

    // Offset: `Z`/`z` or ±HH:MM, and it must end the string.
    let offset_secs: i64 = match b.get(i)? {
        b'Z' | b'z' => {
            if i + 1 != b.len() {
                return None;
            }
            0
        }
        sign @ (b'+' | b'-') => {
            if i + 6 != b.len() || b[i + 3] != b':' {
                return None;
            }
            let oh = parse_digits(b, i + 1, 2)?;
            let om = parse_digits(b, i + 4, 2)?;
            if oh > 23 || om > 59 {
                return None;
            }
            let secs = oh * 3600 + om * 60;
            if *sign == b'-' {
                -secs
            } else {
                secs
            }
        }
        _ => return None,
    };

    let secs = days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second
        - offset_secs;
    if secs < 0 {
        return None;
    }
    Some(UNIX_EPOCH + Duration::new(secs as u64, nanos))
}

/// Parse `len` ASCII digits at `b[at..at+len]` into an i64, or `None`
/// when out of bounds / non-digit.
fn parse_digits(b: &[u8], at: usize, len: usize) -> Option<i64> {
    let slice = b.get(at..at + len)?;
    let mut out: i64 = 0;
    for &d in slice {
        if !d.is_ascii_digit() {
            return None;
        }
        out = out * 10 + i64::from(d - b'0');
    }
    Some(out)
}

fn is_leap_year(y: i64) -> bool {
    y % 4 == 0 && (y % 100 != 0 || y % 400 == 0)
}

fn days_in_month(y: i64, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap_year(y) {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

/// Days since 1970-01-01 for a civil date (Howard Hinnant's
/// `days_from_civil` algorithm — exact for the proleptic Gregorian
/// calendar, no dependency).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * ((i64::from(m) + 9) % 12) + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    fn epoch_secs(ts: SystemTime) -> u64 {
        ts.duration_since(UNIX_EPOCH).unwrap().as_secs()
    }

    fn epoch_nanos(ts: SystemTime) -> u128 {
        ts.duration_since(UNIX_EPOCH).unwrap().as_nanos()
    }

    // ---- parse_rfc3339: accepted shapes ---------------------------------

    #[test]
    fn parses_canonical_utc_z() {
        // 2026-06-11T10:00:00Z == 1781172000 (independently computed).
        let ts = parse_rfc3339("2026-06-11T10:00:00Z").unwrap();
        assert_eq!(epoch_secs(ts), 1_781_172_000);
    }

    #[test]
    fn parses_unix_epoch_itself() {
        let ts = parse_rfc3339("1970-01-01T00:00:00Z").unwrap();
        assert_eq!(epoch_secs(ts), 0);
    }

    #[test]
    fn parses_to_iso_string_shape_with_millis() {
        // `new Date().toISOString()` — the exact bytes autosave writes.
        let ts = parse_rfc3339("2026-06-11T10:00:00.123Z").unwrap();
        assert_eq!(epoch_secs(ts), 1_781_172_000);
        assert_eq!(epoch_nanos(ts), 1_781_172_000_123_000_000);
    }

    #[test]
    fn parses_lowercase_t_and_z() {
        let ts = parse_rfc3339("2026-06-11t10:00:00z").unwrap();
        assert_eq!(epoch_secs(ts), 1_781_172_000);
    }

    #[test]
    fn parses_positive_and_negative_offsets() {
        // +03:00 is three hours EARLIER in UTC.
        let plus = parse_rfc3339("2026-06-11T13:00:00+03:00").unwrap();
        assert_eq!(epoch_secs(plus), 1_781_172_000);
        let minus = parse_rfc3339("2026-06-11T05:00:00-05:00").unwrap();
        assert_eq!(epoch_secs(minus), 1_781_172_000);
    }

    #[test]
    fn parses_leap_day_on_leap_year() {
        assert!(parse_rfc3339("2024-02-29T00:00:00Z").is_some());
    }

    #[test]
    fn truncates_fraction_beyond_nanoseconds() {
        let ts = parse_rfc3339("2026-06-11T10:00:00.1234567899Z").unwrap();
        assert_eq!(epoch_nanos(ts) % 1_000_000_000, 123_456_789);
    }

    // ---- parse_rfc3339: rejected shapes ----------------------------------

    #[test]
    fn rejects_calendar_invalid_fields() {
        assert!(parse_rfc3339("2026-13-01T00:00:00Z").is_none()); // month 13
        assert!(parse_rfc3339("2026-00-01T00:00:00Z").is_none()); // month 0
        assert!(parse_rfc3339("2026-04-31T00:00:00Z").is_none()); // Apr 31
        assert!(parse_rfc3339("2025-02-29T00:00:00Z").is_none()); // non-leap Feb 29
        assert!(parse_rfc3339("2026-06-11T24:00:00Z").is_none()); // hour 24
        assert!(parse_rfc3339("2026-06-11T10:60:00Z").is_none()); // minute 60
        assert!(parse_rfc3339("2026-06-11T10:00:60Z").is_none()); // leap second (TS lockstep)
    }

    #[test]
    fn rejects_structural_malformations() {
        assert!(parse_rfc3339("").is_none());
        assert!(parse_rfc3339("yesterday").is_none());
        assert!(parse_rfc3339("2026-06-11").is_none()); // date only
        assert!(parse_rfc3339("2026-06-11 10:00:00Z").is_none()); // space, not T
        assert!(parse_rfc3339("2026-06-11T10:00:00").is_none()); // no offset
        assert!(parse_rfc3339("2026-06-11T10:00:00Z ").is_none()); // trailing junk
        assert!(parse_rfc3339("2026-06-11T10:00:00.Z").is_none()); // empty fraction
        assert!(parse_rfc3339("2026-06-11T10:00:00+0300").is_none()); // no colon offset
        assert!(parse_rfc3339("2026-06-11T10:00:00+24:00").is_none()); // offset hour 24
        assert!(parse_rfc3339("2026-06-11T10:00:00Zabc").is_none());
    }

    #[test]
    fn rejects_pre_epoch_instants() {
        // Conservative: a pre-1970 `updated:` never comes from autosave.
        assert!(parse_rfc3339("1969-12-31T23:59:59Z").is_none());
    }

    // ---- fm_updated_system_time -----------------------------------------

    #[test]
    fn reads_updated_from_frontmatter() {
        let plaintext = b"---\ntitle: Note\nupdated: 2026-06-11T10:00:00Z\n---\n\nbody\n";
        let ts = fm_updated_system_time(plaintext).unwrap();
        assert_eq!(epoch_secs(ts), 1_781_172_000);
    }

    #[test]
    fn reads_quoted_updated_value() {
        let dq = b"---\nupdated: \"2026-06-11T10:00:00Z\"\n---\nbody";
        assert_eq!(
            epoch_secs(fm_updated_system_time(dq).unwrap()),
            1_781_172_000
        );
        let sq = b"---\nupdated: '2026-06-11T10:00:00Z'\n---\nbody";
        assert_eq!(
            epoch_secs(fm_updated_system_time(sq).unwrap()),
            1_781_172_000
        );
    }

    #[test]
    fn reads_updated_with_trailing_comment() {
        let plaintext = b"---\nupdated: 2026-06-11T10:00:00Z  # autosave\n---\nbody";
        assert_eq!(
            epoch_secs(fm_updated_system_time(plaintext).unwrap()),
            1_781_172_000
        );
    }

    #[test]
    fn absent_field_or_frontmatter_is_none() {
        assert!(fm_updated_system_time(b"no frontmatter at all").is_none());
        assert!(fm_updated_system_time(b"---\ntitle: x\n---\nbody").is_none());
        assert!(fm_updated_system_time(b"").is_none());
    }

    #[test]
    fn unparsable_value_is_none() {
        assert!(fm_updated_system_time(b"---\nupdated: yesterday\n---\nbody").is_none());
        assert!(fm_updated_system_time(b"---\nupdated:\n---\nbody").is_none());
        assert!(
            fm_updated_system_time(b"---\nupdated: |\n  2026-06-11T10:00:00Z\n---\n").is_none()
        );
    }

    #[test]
    fn nested_updated_key_is_not_top_level() {
        // Indented key = nested mapping, not the Myne-managed field.
        let plaintext = b"---\nmeta:\n  updated: 2026-06-11T10:00:00Z\n---\nbody";
        assert!(fm_updated_system_time(plaintext).is_none());
    }

    #[test]
    fn first_updated_line_decides_even_when_invalid() {
        // TS lockstep (readTrashedFromFmBody): the first matching line
        // returns; a later duplicate never rescues an invalid first.
        let plaintext = b"---\nupdated: not-a-date\nupdated: 2026-06-11T10:00:00Z\n---\nbody";
        assert!(fm_updated_system_time(plaintext).is_none());
    }

    #[test]
    fn updated_with_crlf_line_ending_parses() {
        // A CRLF inside the FM block leaves a trailing `\r` on the split
        // line; the scalar trim must absorb it.
        let plaintext = b"---\nupdated: 2026-06-11T10:00:00Z\r\ntitle: x\n---\nbody";
        assert_eq!(
            epoch_secs(fm_updated_system_time(plaintext).unwrap()),
            1_781_172_000
        );
    }

    // ---- apply_updated_mtime ---------------------------------------------

    #[test]
    fn apply_sets_file_mtime_from_updated() {
        let tmp = crate::test_support::ScopedTempDir::new("export-mtime-apply").unwrap();
        let path = tmp.path().join("note.md");
        std::fs::write(&path, b"x").unwrap();
        apply_updated_mtime(&path, b"---\nupdated: 2026-06-11T10:00:00Z\n---\nbody");
        let mtime = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(epoch_secs(mtime), 1_781_172_000);
    }

    #[test]
    fn apply_without_updated_leaves_natural_mtime() {
        let tmp = crate::test_support::ScopedTempDir::new("export-mtime-natural").unwrap();
        let path = tmp.path().join("note.md");
        std::fs::write(&path, b"x").unwrap();
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        apply_updated_mtime(&path, b"no frontmatter");
        let after = std::fs::metadata(&path).unwrap().modified().unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn apply_on_missing_file_is_a_nonfatal_noop() {
        // Non-fatality is structural: the fn returns () and only warns.
        let tmp = crate::test_support::ScopedTempDir::new("export-mtime-missing").unwrap();
        apply_updated_mtime(
            &tmp.path().join("never-written.md"),
            b"---\nupdated: 2026-06-11T10:00:00Z\n---\n",
        );
    }
}
