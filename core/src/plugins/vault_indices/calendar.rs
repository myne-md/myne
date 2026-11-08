// SPDX-License-Identifier: AGPL-3.0
//! The calendar's range read (myne-md/myne#1037).
//!
//! One query answers "what happens between these two instants", and every surface
//! reads it rather than inventing its own interpretation: the desktop and web
//! calendar pane, the mobile screen, the reminder pass and the fifth agent tool.
//!
//! # Why this lives in Rust and in the index plugin
//!
//! An event is a NOTE, so its record is already in the `MYI1` index as typed
//! frontmatter properties (`markdown-dialect.md` §3.10). This module reads those
//! rows and nothing else: **no new index row type, no `index_format_version`
//! bump, no snapshot schema change**.
//!
//! The fifth agent tool runs in the host process and cannot call TypeScript, so
//! the event grammar is read here as well as in `@myne/dialect`. Those two
//! readers are held together by ONE committed fixture
//! (`core/tests/fixtures/calendar/recurrence_projection.json`) that both test
//! suites read, so a change to either side's answer fails the other. That is the
//! same device the property-coercion vectors use across clients (§3.6.4), and it
//! is what makes a duplicated grammar a pinned one rather than a second opinion.
//!
//! # What this module deliberately is not
//!
//! No free-slot engine, no working-hours policy, no buffer, no timezone
//! arithmetic. Overlap is a FACT and is returned as one `conflicts` flag per row;
//! a policy stated as a fact is the most visible way a calendar can lie. Times are
//! wall clock (`§3.10.2`), and the civil-date arithmetic is the integer Hinnant
//! pair the daily-note matcher already carries, so no date crate enters the tree.

use super::state::{NoteRecord, VaultIndicesState};
use crate::plugins::notes::daily_match::{civil_from_days, days_from_civil};
use serde::{Deserialize, Serialize};

/// The widest window one call may ask for. The user's own pane is unbounded; this
/// is the bound a CALLER that hands rows to a model carries, and it lives here so
/// the tool cannot forget it.
pub const MAX_WINDOW_DAYS: i64 = 366;

/// The most rows one bounded call may return.
pub const MAX_ROWS: usize = 500;

/// How many occurrences one series may project before the walk gives up. A daily
/// series started 10 000 days ago is 27 years; beyond that the walk stops and says
/// so rather than spinning over a hand-edited `start`.
const MAX_OCCURRENCES_PER_SERIES: usize = 10_000;

/// The `kind:` value that marks a calendar event (`markdown-dialect.md` §3.6.1).
const EVENT_KIND: &str = "event";

/// One calendar point: a civil date plus an optional wall-clock time.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct EventInstant {
    /// Days since 1970-01-01 in the proleptic Gregorian calendar.
    days: i64,
    /// Minutes since local midnight; `None` for an all-day point.
    minutes: Option<u32>,
}

impl EventInstant {
    /// Minutes on one continuous wall-clock scale, so an interval is two integers.
    /// An all-day point starts at its own midnight.
    fn scale(self) -> i64 {
        self.days * 1440 + i64::from(self.minutes.unwrap_or(0))
    }

    /// The emitted form (`§3.10.2`): `YYYY-MM-DD`, or `YYYY-MM-DD HH:MM[:SS]` with
    /// a single space. One separator only, so a round trip cannot produce two
    /// spellings of one note.
    pub fn to_canonical(self) -> String {
        let (y, m, d) = civil_from_days(self.days);
        let date = format!("{y:04}-{m:02}-{d:02}");
        match self.minutes {
            None => date,
            Some(total) => {
                let hours = total / 60;
                let minutes = total % 60;
                format!("{date} {hours:02}:{minutes:02}")
            }
        }
    }

    /// Whole days from `earlier` to this instant, used to measure a query window.
    pub fn span_days(self, earlier: Self) -> i64 {
        self.days - earlier.days
    }

    /// Parse an event instant. Refuses rather than repairs, exactly as the dialect
    /// reader does: a non-existent date and an offset-bearing timestamp both fail.
    pub fn parse(value: &str) -> Option<Self> {
        let trimmed = value.trim();
        // `get(..10)` rather than `&trimmed[..10]`: a byte slice at a fixed index
        // panics when that index falls inside a multi-byte character, and this
        // string is CALLER-SUPPLIED on one path (the IPC window) and FILE-SUPPLIED
        // on the other (`start:` on any `kind: event` note), so one hand-typed
        // `start: 123456789ü` took the range read down for the whole vault. On
        // wasm32 that panic is a trap, which is the Worker the web client runs in.
        let head = trimmed.get(..10)?;
        let (y, m, d) = parse_date(head)?;
        let rest = &trimmed[10..];
        let days = days_from_civil(y, m, d);
        if rest.is_empty() {
            return Some(Self {
                days,
                minutes: None,
            });
        }
        let mut chars = rest.chars();
        let sep = chars.next()?;
        if sep != ' ' && sep != 'T' {
            return None;
        }
        let minutes = parse_time(chars.as_str())?;
        Some(Self {
            days,
            minutes: Some(minutes),
        })
    }
}

/// An instant read back from a minute on the continuous wall-clock scale.
///
/// `has_time` is the ALL-DAY flag, not a property of the scale: an all-day point
/// sits at its own midnight and must stay all-day after a projection, because a
/// reader that turned it into `00:00` would render a timed event the user never
/// made.
fn instant_from_scale(scale: i64, has_time: bool) -> EventInstant {
    let days = scale.div_euclid(1440);
    let minutes = (scale.rem_euclid(1440)) as u32;
    EventInstant {
        days,
        minutes: has_time.then_some(minutes),
    }
}

fn parse_date(text: &str) -> Option<(i32, u32, u32)> {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let y: i32 = text[0..4].parse().ok()?;
    let m: u32 = text[5..7].parse().ok()?;
    let d: u32 = text[8..10].parse().ok()?;
    if !(1..=12).contains(&m) || d < 1 || d > days_in_month(y, m) {
        return None;
    }
    Some((y, m, d))
}

fn parse_time(text: &str) -> Option<u32> {
    let bytes = text.as_bytes();
    if bytes.len() != 5 && bytes.len() != 8 {
        return None;
    }
    if bytes[2] != b':' {
        return None;
    }
    if bytes.len() == 8 && bytes[5] != b':' {
        return None;
    }
    let hours: u32 = text[0..2].parse().ok()?;
    let minutes: u32 = text[3..5].parse().ok()?;
    if hours > 23 || minutes > 59 {
        return None;
    }
    if bytes.len() == 8 {
        let seconds: u32 = text[6..8].parse().ok()?;
        if seconds > 59 {
            return None;
        }
        // Seconds are accepted and folded away: the pane never draws them, and
        // keeping them would give one instant two spellings on disk.
    }
    Some(hours * 60 + minutes)
}

fn is_leap(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn clamp_day(year: i32, month: u32, day: u32) -> u32 {
    day.min(days_in_month(year, month))
}

/// `0` is Monday, matching `markdown-dialect.md` §3.8.7's Monday-first weekday
/// vocabulary.
fn weekday_of(days: i64) -> u32 {
    // 1970-01-01 was a Thursday.
    (days.rem_euclid(7) as u32 + 3) % 7
}

fn add_months(days: i64, months: i64) -> i64 {
    let (y, m, d) = civil_from_days(days);
    let total = i64::from(y) * 12 + i64::from(m) - 1 + months;
    let year = i32::try_from(total.div_euclid(12)).unwrap_or(y);
    let month = u32::try_from(total.rem_euclid(12) + 1).unwrap_or(m);
    days_from_civil(year, month, clamp_day(year, month, d))
}

// === the recurrence vocabulary (§3.8.7, reused, never redefined) ============

const WEEKDAYS: [&str; 7] = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
];

const ORDINALS: [&str; 5] = ["first", "second", "third", "fourth", "last"];

/// One parsed §3.8.7 rule. The anchoring suffix (` when done`) is accepted and
/// recorded, but it changes nothing here: an event has no completion to anchor to,
/// so a completion-anchored rule advances from its own previous date, which is what
/// a user asking for one gets as soon as the event is edited rather than ticked.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecurrenceRule {
    /// `every day`, `every 3 weeks`, `every month`, `every 2 years`.
    Interval { unit: IntervalUnit, count: u32 },
    /// `every monday`, `every tuesday and thursday`.
    Weekdays { days: Vec<u32> },
    /// `first monday of every month`, `last friday of every month`.
    Ordinal { ordinal: usize, weekday: u32 },
    /// `day 31 of every month`, or `last day of every month`.
    DayOfMonth { day: Option<u32> },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum IntervalUnit {
    Day,
    Week,
    Month,
    Year,
}

/// Parse a rule expression. `None` means UNRECOGNIZED, which the caller preserves
/// and surfaces rather than defaulting: a rule nothing can read must look unread
/// (§3.8.7's load-bearing clause).
pub fn parse_rule(raw: &str) -> Option<RecurrenceRule> {
    let mut text = raw.trim().to_lowercase();
    if let Some(stripped) = text.strip_suffix(" when done") {
        text = stripped.trim_end().to_string();
    }
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return None;
    }

    // Tier 3a: `last day of every month` FIRST, because it also matches the
    // ordinal shape below and `day` is not a weekday.
    if text == "last day of every month" {
        return Some(RecurrenceRule::DayOfMonth { day: None });
    }
    if let Some(rest) = text.strip_suffix(" of every month") {
        // `day <n>` or `<ordinal> <weekday>`.
        if let Some(num) = rest.strip_prefix("day ") {
            let day: u32 = num.parse().ok()?;
            return (1..=31)
                .contains(&day)
                .then_some(RecurrenceRule::DayOfMonth { day: Some(day) });
        }
        let mut parts = rest.split_whitespace();
        let ordinal_word = parts.next()?;
        let weekday_word = parts.next()?;
        if parts.next().is_some() {
            return None;
        }
        let ordinal = ORDINALS.iter().position(|o| *o == ordinal_word)?;
        let weekday = weekday_index(weekday_word)?;
        return Some(RecurrenceRule::Ordinal { ordinal, weekday });
    }

    let rest = text.strip_prefix("every ")?;

    // Tier 1: `every <unit>` / `every <n> <unit>s`.
    let words: Vec<&str> = rest.split_whitespace().collect();
    match words.as_slice() {
        [unit] => {
            // Falls THROUGH on a word that is not a unit rather than returning
            // `None`: `every tuesday` reaches here as one word, and the `?` that
            // used to sit on `interval_unit` ended the parse instead of trying
            // tier 2. The dialect writes `every tuesday` for a single-weekday rule
            // (`formatRecurrenceRule`), so the host read a weekly series as a
            // one-off and every future occurrence vanished from the pane.
            if let Some(unit) = interval_unit(unit) {
                return Some(RecurrenceRule::Interval { unit, count: 1 });
            }
        }
        [count, unit] => {
            if let Ok(n) = count.parse::<u32>() {
                let unit = interval_unit(unit)?;
                return (1..=999)
                    .contains(&n)
                    .then_some(RecurrenceRule::Interval { unit, count: n });
            }
        }
        _ => {}
    }

    // Tier 2: a weekday set, joined by `and` and/or commas.
    let mut days = Vec::new();
    for word in rest
        .split([' ', ','])
        .filter(|w| !w.is_empty() && *w != "and")
    {
        days.push(weekday_index(word)?);
    }
    if days.is_empty() {
        return None;
    }
    days.sort_unstable();
    days.dedup();
    Some(RecurrenceRule::Weekdays { days })
}

fn interval_unit(word: &str) -> Option<IntervalUnit> {
    match word {
        "day" | "days" => Some(IntervalUnit::Day),
        "week" | "weeks" => Some(IntervalUnit::Week),
        "month" | "months" => Some(IntervalUnit::Month),
        "year" | "years" => Some(IntervalUnit::Year),
        _ => None,
    }
}

fn weekday_index(word: &str) -> Option<u32> {
    WEEKDAYS.iter().position(|w| *w == word).map(|i| i as u32)
}

/// How many cancelled dates one note's `skip:` field may contribute.
///
/// The same number the dialect's `MAX_SKIP_DATES` carries: a reader must not honour
/// a longer list than the writer will produce, or two clients disagree about what
/// the file says.
pub const MAX_SKIP_DATES: usize = 366;

/// How many retimed occurrences one note's `override:` field may contribute.
///
/// The dialect's `MAX_OVERRIDES` carries the same number: a reader must not honour
/// a longer list than a writer will produce.
pub const MAX_OVERRIDES: usize = 120;

/// Read `override:` into `(day, minutes)` pairs, dropping what does not parse.
///
/// An entry is `<date> <time>`; a bare date is dropped, because the field exists to
/// change a time and one without a time changes nothing.
fn parse_overrides(raw: Option<&str>) -> Vec<(i64, u32)> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    let mut out: Vec<(i64, u32)> = Vec::new();
    for entry in raw.split(',') {
        let Some(space) = entry.rfind(' ') else {
            continue;
        };
        let (date_text, time_text) = entry.split_at(space);
        let Some((y, m, d)) = parse_date(date_text.trim()) else {
            continue;
        };
        let Some(minutes) = parse_time(time_text.trim()) else {
            continue;
        };
        let day = days_from_civil(y, m, d);
        if let Some(slot) = out.iter_mut().find(|(seen, _)| *seen == day) {
            slot.1 = minutes;
        } else {
            out.push((day, minutes));
        }
        if out.len() >= MAX_OVERRIDES {
            break;
        }
    }
    out
}

/// The occurrence dates strictly after `from` (inclusive of `from` itself when the
/// rule places one there), walked to `until` inclusive.
///
/// The walk is bounded by [`MAX_OCCURRENCES_PER_SERIES`]; hitting the bound returns
/// what it has rather than looping, which is the failure mode a hand-edited
/// `start: 1900-01-01` with `repeat: every day` would otherwise cause.
fn occurrences_from(start: i64, rule: &RecurrenceRule, until: i64) -> Vec<i64> {
    let mut out = Vec::new();
    let mut cursor = start;
    let mut steps = 0usize;
    loop {
        if cursor > until {
            break;
        }
        out.push(cursor);
        if steps >= MAX_OCCURRENCES_PER_SERIES {
            break;
        }
        steps += 1;
        let next = advance(cursor, start, rule);
        if next <= cursor {
            // Defensive: a rule that cannot advance must not spin.
            break;
        }
        cursor = next;
    }
    out
}

/// The next occurrence after `cursor` for `rule`, anchored at `start` (the series'
/// own origin, which is what makes a weekday set and a month position stable).
fn advance(cursor: i64, start: i64, rule: &RecurrenceRule) -> i64 {
    match rule {
        RecurrenceRule::Interval { unit, count } => {
            let n = i64::from(*count);
            match unit {
                IntervalUnit::Day => cursor + n,
                IntervalUnit::Week => cursor + 7 * n,
                IntervalUnit::Month => add_months(cursor, n),
                IntervalUnit::Year => add_months(cursor, 12 * n),
            }
        }
        RecurrenceRule::Weekdays { days } => {
            for step in 1i64..=7 {
                let candidate = cursor + step;
                if days.contains(&weekday_of(candidate)) {
                    return candidate;
                }
            }
            cursor + 7
        }
        RecurrenceRule::Ordinal { ordinal, weekday } => {
            let (y, m, _) = civil_from_days(cursor);
            let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
            let found = ordinal_weekday_of(ny, nm, *ordinal, *weekday);
            let _ = start;
            days_from_civil(ny, nm, found)
        }
        RecurrenceRule::DayOfMonth { day } => {
            let (y, m, _) = civil_from_days(cursor);
            let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
            let target = match day {
                None => days_in_month(ny, nm),
                // Clamps into a short month for THAT occurrence only, then
                // returns to the nominal day: the §3.8.7 calendar family, which
                // does not drift.
                Some(d) => clamp_day(ny, nm, *d),
            };
            days_from_civil(ny, nm, target)
        }
    }
}

/// The day-of-month of the nth (or last) `weekday` in a month.
///
/// A month holding only four of a weekday, addressed as `fourth`, clamps BACK to
/// the last one in that month rather than spilling into the next (`§3.8.7`), so the
/// walk is expressed as "find the last, then step back" rather than as arithmetic
/// that can leave the month.
fn ordinal_weekday_of(year: i32, month: u32, ordinal: usize, weekday: u32) -> u32 {
    let total = days_in_month(year, month);
    let first_weekday = weekday_of(days_from_civil(year, month, 1));
    // `+ 7` before the modulo: a bare `weekday - first` underflows in u32 whenever
    // the target weekday falls earlier in the week than the 1st.
    let first = 1 + (weekday + 7 - first_weekday) % 7;
    let last = {
        let mut day = first;
        while day + 7 <= total {
            day += 7;
        }
        day
    };
    if ordinal == 4 {
        return last;
    }
    let target = first + 7 * ordinal as u32;
    if target > total {
        last
    } else {
        target
    }
}

// === the event record =======================================================

/// Why a note that claims to be an event cannot be shown as one. The same
/// vocabulary the dialect reader reports (`§3.10.4`), so one note reads the same
/// way on the pane, on a phone and in the tool's result.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UnreadableReason {
    StartMissing,
    StartUnreadable,
    EndUnreadable,
    EndBeforeStart,
    EndTimeWithoutStartTime,
    CalendarUnreadable,
}

/// A note that claims to be an event and does not parse. Surfaced, never dropped.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnreadableEvent {
    pub note_id: String,
    pub title: Option<String>,
    pub reason: UnreadableReason,
}

/// One row of the answer. A series contributes one row per occurrence inside the
/// window, each naming its series, so a write always targets the note.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarRow {
    pub note_id: String,
    pub title: Option<String>,
    pub folder: Option<String>,
    pub calendar: Option<String>,
    /// The emitted form of this occurrence's start (`§3.10.2`).
    pub start: String,
    pub end: Option<String>,
    pub all_day: bool,
    /// Set on a projected occurrence: the note id of the series it belongs to.
    pub occurrence_of: Option<String>,
    /// Set on a projected occurrence: the occurrence's date, `YYYY-MM-DD`.
    pub occurrence_date: Option<String>,
    /// Whether this row overlaps another row in the same answer. Computed here
    /// because a model must not be asked to do interval arithmetic.
    pub conflicts: bool,
    /// The raw rule expression, preserved verbatim; absent for a one-off.
    pub repeat: Option<String>,
    /// The raw reminder lead (`§3.10.3`), preserved verbatim; absent when the note
    /// carries none. Returned as the FILE holds it, because the horizon it must fit
    /// inside is the caller's policy (`§3.10.4`) and not this reader's.
    #[serde(default)]
    pub remind: Option<String>,
    /// True when the rule expression is outside the closed vocabulary. Such a row
    /// is still returned, because the event exists; what it cannot do is advance.
    pub repeat_unrecognized: bool,
    /// The note's `uid:`, when it has one. The importer's match key, and the reason
    /// it is on the row: see `ParsedEvent::uid`.
    #[serde(default)]
    pub uid: Option<String>,
}

/// The whole answer.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarRange {
    pub rows: Vec<CalendarRow>,
    pub unreadable: Vec<UnreadableEvent>,
}

/// A caller's own bound, applied to rows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bound {
    pub max_rows: Option<usize>,
}

impl Bound {
    /// The agent tool's bound: at most [`MAX_ROWS`] rows.
    pub const fn agent() -> Self {
        Self {
            max_rows: Some(MAX_ROWS),
        }
    }

    /// The user's own surfaces: no bound.
    pub const fn unbounded() -> Self {
        Self { max_rows: None }
    }
}

/// Why a query window was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowRefusal {
    /// The window does not parse, or its end precedes its start.
    Unreadable,
    /// The caller asked for a bound and the window is wider than it allows.
    TooWide { max_days: i64 },
}

/// Decide a caller's bound for a window.
///
/// Extracted so the one security-relevant decision in the command (how wide a
/// model may look) is a pure function with its own tests, rather than three lines
/// inside a `#[tauri::command]` that no test can reach.
pub fn bound_for_window(
    start: EventInstant,
    end: EventInstant,
    bounded: bool,
) -> Result<Bound, WindowRefusal> {
    if end < start {
        return Err(WindowRefusal::Unreadable);
    }
    if !bounded {
        return Ok(Bound::unbounded());
    }
    if end.span_days(start) > MAX_WINDOW_DAYS {
        return Err(WindowRefusal::TooWide {
            max_days: MAX_WINDOW_DAYS,
        });
    }
    Ok(Bound::agent())
}

struct ParsedEvent {
    start: EventInstant,
    end: Option<EventInstant>,
    calendar: Option<String>,
    repeat_raw: Option<String>,
    rule: Option<RecurrenceRule>,
    repeat_unrecognized: bool,
    remind: Option<String>,
    /// The note's own `uid:`, when it carries one (`§3.10`).
    ///
    /// An `.ics` file has its own `UID`, and the importer writes it into the note
    /// so a re-import can MATCH instead of duplicating (myne-md/myne#1037). The
    /// row carries it for the same reason: the importer needs the set of uids this
    /// vault already holds, and the alternative is a second index over events,
    /// which is the second store `decisions/storage/0792` refuses.
    uid: Option<String>,
    /// The dates this series does not occur on (`skip:`), as day numbers.
    ///
    /// A field on the note rather than an exception table, which is what
    /// `decisions/storage/0795` settles: a cancellation belongs to the series note,
    /// so it syncs with it, dies with it, and needs no second store to hold it.
    skip: Vec<i64>,
    /// The dates whose START TIME differs from the rule's, and that time in minutes.
    ///
    /// Bound to a date the rule already generates, and to a time only: the day and
    /// the duration stay, so an override cannot contradict the series about what
    /// happens (`decisions/storage/0796`).
    overrides: Vec<(i64, u32)>,
}

/// Read `skip:` into day numbers, dropping anything that does not parse.
///
/// Dropping rather than refusing is deliberate: a typo in a cancellation must not
/// hide the series from its owner. The list is bounded by [`MAX_SKIP_DATES`], so a
/// hand-edited note cannot make every range query walk a million dates.
fn parse_skip_dates(raw: Option<&str>) -> Vec<i64> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    let mut out: Vec<i64> = Vec::new();
    for token in raw.split(|c: char| c == ',' || c.is_whitespace()) {
        let token = token.trim();
        if token.is_empty() {
            continue;
        }
        let Some((y, m, d)) = parse_date(token) else {
            continue;
        };
        let day = days_from_civil(y, m, d);
        if !out.contains(&day) {
            out.push(day);
        }
        if out.len() >= MAX_SKIP_DATES {
            break;
        }
    }
    out
}

fn property<'a>(record: &'a NoteRecord, key: &str) -> Option<&'a str> {
    record
        .properties
        .iter()
        .find(|p| p.key == key)
        .and_then(|p| p.value.as_deref())
}

fn read_event(record: &NoteRecord) -> Option<Result<ParsedEvent, UnreadableReason>> {
    if property(record, "kind") != Some(EVENT_KIND) {
        return None;
    }
    let Some(start_raw) = property(record, "start") else {
        return Some(Err(UnreadableReason::StartMissing));
    };
    let Some(start) = EventInstant::parse(start_raw) else {
        return Some(Err(UnreadableReason::StartUnreadable));
    };
    let end = match property(record, "end") {
        None => None,
        Some(raw) => match EventInstant::parse(raw) {
            None => return Some(Err(UnreadableReason::EndUnreadable)),
            Some(end) => Some(end),
        },
    };
    if let Some(end) = end {
        if start.minutes.is_none() && end.minutes.is_some() {
            return Some(Err(UnreadableReason::EndTimeWithoutStartTime));
        }
        if end.scale() < start.scale() {
            return Some(Err(UnreadableReason::EndBeforeStart));
        }
    }
    let calendar = match property(record, "calendar") {
        None => None,
        Some(name) => {
            if !is_legal_calendar_name(name) {
                return Some(Err(UnreadableReason::CalendarUnreadable));
            }
            Some(name.to_string())
        }
    };
    let repeat_raw = property(record, "repeat").map(str::to_string);
    let rule = repeat_raw.as_deref().and_then(parse_rule);
    let repeat_unrecognized = repeat_raw.is_some() && rule.is_none();
    // Preserved rather than validated: a lead is refused by the CALLER's horizon
    // (§3.10.4), and a reader that dropped it would leave the reminder pass with
    // no way to say the event has one.
    let remind = property(record, "remind").map(str::to_string);
    // Not validated: a `uid` is an opaque identity the file or the user chose, and
    // refusing one shape would make an imported event unmatchable against the file
    // it came from. It is never rendered, so no injection surface rides on it.
    let uid = property(record, "uid").map(str::to_string);
    let skip = parse_skip_dates(property(record, "skip"));
    let overrides = parse_overrides(property(record, "override"));

    Some(Ok(ParsedEvent {
        start,
        end,
        calendar,
        repeat_raw,
        rule,
        repeat_unrecognized,
        remind,
        skip,
        overrides,
        uid,
    }))
}

/// One legal calendar segment: non-empty, no separator, no control character,
/// bounded like a folder segment (`§3.10.1`).
pub(crate) fn is_legal_calendar_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && name == name.trim()
        && !name.contains('/')
        && !name.chars().any(|c| c.is_control())
}

/// How long one occurrence occupies, in minutes. A timed point with no `end` lasts
/// a minute (long enough to overlap something at the same instant, short enough not
/// to swallow the hour after it); an all-day point with no `end` occupies its whole
/// day.
fn duration_minutes(start: EventInstant, end: Option<EventInstant>) -> i64 {
    match end {
        Some(end) => (end.scale() - start.scale()).max(1),
        None => {
            if start.minutes.is_none() {
                1440
            } else {
                1
            }
        }
    }
}

/// The rows whose interval intersects the window.
///
/// `window_start` / `window_end` are event instants in the same wall-clock scale.
/// `window_end` is inclusive for an occurrence's START, and an event that began
/// before the window and is still running inside it is returned: a partially
/// visible event is visible.
pub fn range(
    indices: &VaultIndicesState,
    window_start: EventInstant,
    window_end: EventInstant,
    bound: Bound,
) -> CalendarRange {
    let mut answer = CalendarRange::default();
    let window_minutes_start = window_start.scale();
    let window_minutes_end = window_end.scale();
    let last_day = window_end.days;

    let snapshot = indices.snapshot();
    for (note_id, record) in snapshot.iter() {
        // A note outside the WORKING SET is absent from every read, and the calendar
        // is a read: `search_vault` was corrected for exactly this in an earlier
        // round, and the pane, the phone and the agent tool all come through here, so
        // one trashed event would otherwise reach all three.
        if !record.live {
            continue;
        }
        let Some(parsed) = read_event(record) else {
            continue;
        };
        let event = match parsed {
            Ok(event) => event,
            Err(reason) => {
                answer.unreadable.push(UnreadableEvent {
                    note_id: note_id.clone(),
                    title: record.title.clone(),
                    reason,
                });
                continue;
            }
        };

        let duration = duration_minutes(event.start, event.end);
        let dates: Vec<i64> = match &event.rule {
            None => vec![event.start.days],
            Some(rule) => occurrences_from(event.start.days, rule, last_day),
        };

        for date in dates {
            // A cancelled occurrence is absent from the answer rather than marked:
            // the surface renders a list of what happens, and "happens on none of
            // these days" has nothing to render. The series note stays, which is
            // the difference between skipping a week and deleting the event.
            if event.skip.contains(&date) {
                continue;
            }
            let shift = (date - event.start.days) * 1440;
            // A retimed occurrence keeps its DAY and its DURATION: only the wall
            // clock moves, so the row is still this series' row on this series' day.
            let occurs_at = match event.overrides.iter().find(|(day, _)| *day == date) {
                Some((_, minutes)) => date * 1440 + i64::from(*minutes),
                None => event.start.scale() + shift,
            };
            let occurs_end = occurs_at + duration;
            // Intersection, half-open at the end: an event that ends exactly when
            // the window opens is not in it.
            if occurs_end <= window_minutes_start || occurs_at > window_minutes_end {
                continue;
            }
            // Built from the minute scale rather than from the series' own fields,
            // because a retimed occurrence moves BOTH ends: a 09:00-09:30 meeting
            // overridden to 14:00 is 14:00-14:30, not 14:00-09:30. Deriving both
            // from `occurs_at`/`occurs_end` is also what keeps a duration that
            // crosses midnight on one day from being reported on two.
            let start_instant = instant_from_scale(occurs_at, event.start.minutes.is_some());
            let end_instant = event
                .end
                .map(|_| instant_from_scale(occurs_end, event.start.minutes.is_some()));
            answer.rows.push(CalendarRow {
                note_id: note_id.clone(),
                title: record.title.clone(),
                folder: record.folder.clone(),
                calendar: event.calendar.clone(),
                start: start_instant.to_canonical(),
                end: end_instant.map(EventInstant::to_canonical),
                all_day: event.start.minutes.is_none(),
                occurrence_of: (event.rule.is_some()).then(|| note_id.clone()),
                occurrence_date: (event.rule.is_some()).then(|| start_instant.to_canonical_date()),
                conflicts: false,
                repeat: event.repeat_raw.clone(),
                remind: event.remind.clone(),
                repeat_unrecognized: event.repeat_unrecognized,
                uid: event.uid.clone(),
            });
        }
    }

    // Stable, so the pane and the tool agree on order: by start, then title, then
    // note id. Without it a BTreeMap iteration order decides what "the first row"
    // means, which is a difference nobody can see and everybody debugs.
    answer.rows.sort_by(|a, b| {
        a.start
            .cmp(&b.start)
            .then_with(|| a.title.cmp(&b.title))
            .then_with(|| a.note_id.cmp(&b.note_id))
    });

    if let Some(max) = bound.max_rows {
        // Truncate BEFORE the conflict pass. It is quadratic on purpose (a second
        // implementation of "overlap" would save nothing a person can measure), so it
        // may only run on the rows somebody will actually see: the export path used
        // to hand it a 300-year window of expanded series, which is tens of thousands
        // of rows and about a billion comparisons on the command's thread.
        answer.rows.truncate(max);
    }
    mark_conflicts(&mut answer.rows);
    // Deterministic for the same reason the rows are: the unreadable group is a
    // list a person reads, and BTreeMap iteration order is not a promise anybody
    // should have to know.
    answer.unreadable.sort_by(|a, b| a.note_id.cmp(&b.note_id));

    answer
}

impl EventInstant {
    fn to_canonical_date(self) -> String {
        let (y, m, d) = civil_from_days(self.days);
        format!("{y:04}-{m:02}-{d:02}")
    }
}

/// Mark every row that overlaps another. Quadratic on purpose: the answers this
/// runs on are bounded (the tool at [`MAX_ROWS`], the pane at what a person can
/// look at), and an interval tree would be a second implementation of "overlap"
/// for a saving nobody can measure.
fn mark_conflicts(rows: &mut [CalendarRow]) {
    let spans: Vec<(i64, i64)> = rows
        .iter()
        .map(|row| {
            let start = EventInstant::parse(&row.start)
                .map(EventInstant::scale)
                .unwrap_or(0);
            let end = row
                .end
                .as_deref()
                .and_then(EventInstant::parse)
                .map(EventInstant::scale)
                .unwrap_or(start + 1);
            (start, end)
        })
        .collect();
    for (i, (a_start, a_end)) in spans.iter().enumerate() {
        for (j, (b_start, b_end)) in spans.iter().enumerate() {
            if i == j {
                continue;
            }
            if a_start < b_end && b_start < a_end {
                rows[i].conflicts = true;
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn days(y: i32, m: u32, d: u32) -> i64 {
        days_from_civil(y, m, d)
    }

    fn instant(text: &str) -> EventInstant {
        EventInstant::parse(text).expect("fixture instant")
    }

    #[test]
    fn parses_the_event_instant_shape_and_refuses_the_rest() {
        assert_eq!(instant("2026-11-05").to_canonical(), "2026-11-05");
        assert_eq!(
            instant("2026-11-05T09:00").to_canonical(),
            "2026-11-05 09:00"
        );
        assert_eq!(
            instant("2026-11-05 09:00:30").to_canonical(),
            "2026-11-05 09:00"
        );
        for bad in [
            "2026-02-31",
            "2026-13-01",
            "2026-11-05T24:00",
            "2026-11-05T09:60",
            "2026-11-05T09:00:00Z",
            "2026-11-05T09:00:00+03:00",
            "2026-11-05 9:00",
            "05/11/2026",
        ] {
            assert!(EventInstant::parse(bad).is_none(), "{bad} should not parse");
        }
    }

    #[test]
    fn weekday_arithmetic_is_monday_first() {
        // 2026-11-05 is a Thursday.
        assert_eq!(weekday_of(days(2026, 11, 5)), 3);
        assert_eq!(weekday_of(days(2026, 11, 2)), 0);
        assert_eq!(weekday_of(days(1970, 1, 1)), 3);
    }

    #[test]
    fn parses_the_closed_recurrence_vocabulary() {
        assert_eq!(
            parse_rule("every day"),
            Some(RecurrenceRule::Interval {
                unit: IntervalUnit::Day,
                count: 1
            })
        );
        assert_eq!(
            parse_rule("every 3 weeks"),
            Some(RecurrenceRule::Interval {
                unit: IntervalUnit::Week,
                count: 3
            })
        );
        assert_eq!(
            parse_rule("every tuesday and thursday"),
            Some(RecurrenceRule::Weekdays { days: vec![1, 3] })
        );
        assert_eq!(
            parse_rule("every friday, monday"),
            Some(RecurrenceRule::Weekdays { days: vec![0, 4] })
        );
        assert_eq!(
            parse_rule("last day of every month"),
            Some(RecurrenceRule::DayOfMonth { day: None })
        );
        assert_eq!(
            parse_rule("day 31 of every month"),
            Some(RecurrenceRule::DayOfMonth { day: Some(31) })
        );
        assert_eq!(
            parse_rule("first monday of every month"),
            Some(RecurrenceRule::Ordinal {
                ordinal: 0,
                weekday: 0
            })
        );
        // The anchoring suffix is part of the expression and is accepted.
        assert_eq!(
            parse_rule("every day when done"),
            Some(RecurrenceRule::Interval {
                unit: IntervalUnit::Day,
                count: 1
            })
        );
        for bad in [
            "",
            "every other blue moon",
            "every 0 days",
            "every 1000 days",
            "weekly",
            "day 32 of every month",
        ] {
            assert!(parse_rule(bad).is_none(), "{bad} should be unrecognized");
        }
    }

    #[test]
    fn calendar_family_clamps_into_short_months_and_returns() {
        // §3.8.7: `day 31 of every month` from 31 January gives 28 February and
        // then 31 March. The interval family would drift; this one must not.
        let rule = parse_rule("day 31 of every month").unwrap();
        let start = days(2026, 1, 31);
        let dates = occurrences_from(start, &rule, days(2026, 4, 30));
        let rendered: Vec<String> = dates
            .iter()
            .map(|d| {
                let (y, m, day) = civil_from_days(*d);
                format!("{y:04}-{m:02}-{day:02}")
            })
            .collect();
        assert_eq!(
            rendered,
            vec!["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]
        );
    }

    #[test]
    fn interval_family_drifts_on_purpose() {
        // The other family: `every month` from 31 January gives 28 February and
        // then 28 March.
        let rule = parse_rule("every month").unwrap();
        let start = days(2026, 1, 31);
        let dates = occurrences_from(start, &rule, days(2026, 3, 31));
        let rendered: Vec<String> = dates
            .iter()
            .map(|d| {
                let (y, m, day) = civil_from_days(*d);
                format!("{y:04}-{m:02}-{day:02}")
            })
            .collect();
        assert_eq!(rendered, vec!["2026-01-31", "2026-02-28", "2026-03-28"]);
    }

    fn event_note(id: &str, props: &[(&str, &str)]) -> (String, NoteRecord) {
        use super::super::state::PropertyEntry;
        let record = NoteRecord {
            title: Some(format!("event {id}")),
            folder: Some("Calendar/".to_string()),
            properties: props
                .iter()
                .map(|(k, v)| PropertyEntry {
                    key: (*k).to_string(),
                    r#type: "string".to_string(),
                    value: Some((*v).to_string()),
                    elements: None,
                })
                .collect(),
            ..Default::default()
        };
        (id.to_string(), record)
    }

    fn state_with(notes: &[(&str, &[(&str, &str)])]) -> VaultIndicesState {
        let state = VaultIndicesState::default();
        for (id, props) in notes {
            let (id, record) = event_note(id, props);
            state.apply(&id, record);
        }
        state
    }

    fn render(answer: &CalendarRange) -> Vec<String> {
        answer
            .rows
            .iter()
            .map(|r| format!("{}@{}", r.title.clone().unwrap_or_default(), r.start))
            .collect()
    }

    #[test]
    fn the_row_carries_the_notes_own_uid() {
        // The importer's match key (myne-md/myne#1037). A note written by an `.ics`
        // import carries the file's `UID`; a hand-authored one carries none, and the
        // distinction has to survive the read or a re-import duplicates.
        let state = state_with(&[
            (
                "imported",
                &[
                    ("kind", "event"),
                    ("start", "2026-11-05 10:00"),
                    ("uid", "team-standup@example.com"),
                ],
            ),
            (
                "authored",
                &[("kind", "event"), ("start", "2026-11-05 11:00")],
            ),
        ]);
        let answer = range(
            &state,
            instant("2026-11-04"),
            instant("2026-11-10 23:59"),
            Bound::unbounded(),
        );
        let uids: Vec<Option<String>> = answer.rows.iter().map(|r| r.uid.clone()).collect();
        assert_eq!(
            uids,
            vec![Some("team-standup@example.com".to_string()), None,]
        );
    }

    #[test]
    fn returns_the_events_whose_interval_intersects_the_window() {
        let state = state_with(&[
            ("in", &[("kind", "event"), ("start", "2026-11-05 10:00")]),
            (
                "before",
                &[("kind", "event"), ("start", "2026-11-01 10:00")],
            ),
            ("after", &[("kind", "event"), ("start", "2026-11-20 10:00")]),
        ]);
        let answer = range(
            &state,
            instant("2026-11-04"),
            instant("2026-11-10 23:59"),
            Bound::unbounded(),
        );
        assert_eq!(render(&answer), vec!["event in@2026-11-05 10:00"]);
    }

    #[test]
    fn an_event_that_started_before_the_window_and_is_still_running_is_inside_it() {
        let state = state_with(&[(
            "trip",
            &[
                ("kind", "event"),
                ("start", "2026-11-01"),
                ("end", "2026-11-08"),
            ],
        )]);
        let answer = range(
            &state,
            instant("2026-11-04"),
            instant("2026-11-05 23:59"),
            Bound::unbounded(),
        );
        assert_eq!(render(&answer), vec!["event trip@2026-11-01"]);
        assert!(answer.rows[0].all_day);
        assert_eq!(answer.rows[0].end.as_deref(), Some("2026-11-08"));
    }

    #[test]
    fn the_reminder_lead_reaches_the_row_verbatim() {
        // The reminder pass reads events through THIS query, so a row that dropped
        // the lead would leave an event reminder unregisterable with nothing
        // failing. It is returned as the file holds it: whether the lead fits the
        // horizon is the caller's policy (§3.10.4), not this reader's.
        let state = state_with(&[
            (
                "dentist",
                &[
                    ("kind", "event"),
                    ("start", "2026-11-05 09:00"),
                    ("remind", "30m"),
                ],
            ),
            ("plain", &[("kind", "event"), ("start", "2026-11-05 10:00")]),
        ]);
        let answer = range(
            &state,
            instant("2026-11-05"),
            instant("2026-11-05 23:59"),
            Bound::unbounded(),
        );
        let with_lead = answer
            .rows
            .iter()
            .find(|row| row.remind.is_some())
            .expect("the lead survives");
        assert_eq!(with_lead.remind.as_deref(), Some("30m"));
        assert_eq!(with_lead.note_id, "dentist");
        assert!(
            answer.rows.iter().any(|row| row.remind.is_none()),
            "an event with no lead must carry none rather than an empty string"
        );
    }

    #[test]
    fn a_single_weekday_rule_reaches_tier_two_instead_of_being_read_as_a_one_off() {
        // Found by injection while adding `skip:`: `every tuesday` is what
        // `formatRecurrenceRule` writes for a one-day weekday rule, and tier 1's
        // `interval_unit(unit)?` returned `None` for the whole expression, so the
        // host read a weekly series as a single event. The dialect's own parse
        // accepted it the entire time, which is what made the two readers disagree
        // silently.
        let state = state_with(&[(
            "standup",
            &[
                ("kind", "event"),
                ("start", "2026-11-03 09:15"),
                ("repeat", "every tuesday"),
            ],
        )]);
        let answer = range(
            &state,
            instant("2026-11-01"),
            instant("2026-11-30"),
            Bound::unbounded(),
        );
        let starts: Vec<&str> = answer.rows.iter().map(|r| r.start.as_str()).collect();
        assert_eq!(
            starts,
            vec![
                "2026-11-03 09:15",
                "2026-11-10 09:15",
                "2026-11-17 09:15",
                "2026-11-24 09:15",
            ]
        );
    }

    #[test]
    fn an_overridden_date_keeps_its_day_and_duration_and_moves_only_its_clock() {
        let state = state_with(&[(
            "standup",
            &[
                ("kind", "event"),
                ("start", "2026-11-03 09:15"),
                ("end", "2026-11-03 09:45"),
                ("repeat", "every tuesday"),
                ("override", "2026-11-10 14:00"),
            ],
        )]);
        let answer = range(
            &state,
            instant("2026-11-01"),
            instant("2026-11-30"),
            Bound::unbounded(),
        );
        let starts: Vec<&str> = answer.rows.iter().map(|r| r.start.as_str()).collect();
        let ends: Vec<&str> = answer
            .rows
            .iter()
            .map(|r| r.end.as_deref().unwrap_or(""))
            .collect();
        assert_eq!(
            starts,
            vec![
                "2026-11-03 09:15",
                "2026-11-10 14:00",
                "2026-11-17 09:15",
                "2026-11-24 09:15",
            ],
            "one date retimed, every sibling untouched"
        );
        // The duration follows the retimed start: 14:00-14:30, never 14:00-09:45.
        assert_eq!(ends[1], "2026-11-10 14:30");
        assert_eq!(ends[0], "2026-11-03 09:45");
        // It is still this series' appearance, so it is skippable and retimeable again.
        assert_eq!(answer.rows[1].occurrence_of.as_deref(), Some("standup"));
        assert_eq!(
            answer.rows[1].occurrence_date.as_deref(),
            Some("2026-11-10")
        );
    }

    #[test]
    fn an_all_day_series_stays_all_day_after_a_projection() {
        // The ever-present risk of deriving rows from a minute scale: an all-day
        // point sits at midnight, and a reader that read it back as `00:00` would
        // turn every all-day event into a timed one.
        let state = state_with(&[(
            "holiday",
            &[
                ("kind", "event"),
                ("start", "2026-11-03"),
                ("repeat", "every week"),
            ],
        )]);
        let answer = range(
            &state,
            instant("2026-11-01"),
            instant("2026-11-30"),
            Bound::unbounded(),
        );
        assert!(!answer.rows.is_empty());
        for row in &answer.rows {
            assert!(row.all_day, "an all-day series must never gain a time");
        }
    }

    #[test]
    fn an_override_that_does_not_parse_leaves_the_series_alone() {
        let state = state_with(&[(
            "standup",
            &[
                ("kind", "event"),
                ("start", "2026-11-03 09:15"),
                ("repeat", "every tuesday"),
                ("override", "2026-11-10, not-a-time, 2026-11-17 25:00"),
            ],
        )]);
        let answer = range(
            &state,
            instant("2026-11-01"),
            instant("2026-11-30"),
            Bound::unbounded(),
        );
        let starts: Vec<&str> = answer.rows.iter().map(|r| r.start.as_str()).collect();
        assert_eq!(
            starts,
            vec![
                "2026-11-03 09:15",
                "2026-11-10 09:15",
                "2026-11-17 09:15",
                "2026-11-24 09:15"
            ],
            "a bare date and an impossible clock change nothing"
        );
    }

    #[test]
    fn a_skipped_date_is_absent_from_the_answer_and_the_series_survives() {
        // The whole point of `skip:` over an exception table: the cancellation is a
        // field on the series note, so one note answers for the schedule and the
        // rows it removes leave nothing behind to migrate later.
        let state = state_with(&[(
            "standup",
            &[
                ("kind", "event"),
                ("start", "2026-11-03 09:15"),
                ("repeat", "every tuesday and thursday"),
                ("skip", "2026-11-05, 2026-11-12"),
            ],
        )]);
        let answer = range(
            &state,
            instant("2026-11-01"),
            instant("2026-11-30"),
            Bound::unbounded(),
        );
        let starts: Vec<&str> = answer.rows.iter().map(|r| r.start.as_str()).collect();
        assert_eq!(
            starts,
            vec![
                "2026-11-03 09:15",
                "2026-11-10 09:15",
                "2026-11-17 09:15",
                "2026-11-19 09:15",
                "2026-11-24 09:15",
                "2026-11-26 09:15",
            ],
            "the two cancelled dates must be gone and every other occurrence kept"
        );
        assert!(
            answer
                .rows
                .iter()
                .all(|row| row.occurrence_of.as_deref() == Some("standup")),
            "the surviving rows still name the series, so it is skippable again"
        );
    }

    #[test]
    fn a_trashed_event_is_absent_from_the_answer() {
        // Found by review: a note outside the working set is absent from every read,
        // and `search_vault` was corrected for exactly this leak. The pane, the phone
        // and the agent tool all come through `range`, so one trashed event used to
        // reach all three - including the model.
        let (id, mut record) =
            event_note("gone", &[("kind", "event"), ("start", "2026-11-05 09:00")]);
        record.live = false;
        let state = VaultIndicesState::default();
        state.apply(&id, record);
        let answer = range(
            &state,
            instant("2026-11-01"),
            instant("2026-11-30"),
            Bound::unbounded(),
        );
        assert!(
            answer.rows.is_empty(),
            "a deleted event must not be on the calendar: {:?}",
            answer.rows
        );
    }

    #[test]
    fn a_start_whose_tenth_byte_is_inside_a_character_is_refused_not_fatal() {
        // Found by review. `&trimmed[..10]` panics when index 10 lands inside a
        // multi-byte character, and the string is FILE-SUPPLIED on this path: one
        // hand-typed `start: 123456789ü` took the range read down for the whole vault
        // (and on wasm32 a panic is a trap in the Worker the web client runs in).
        assert!(EventInstant::parse("123456789ü").is_none());
        assert!(EventInstant::parse("2026-11-0ü 09:00").is_none());
        assert!(EventInstant::parse("2026-11-05").is_some());
    }

    #[test]
    fn a_skip_entry_that_does_not_parse_does_not_hide_the_series() {
        // A typo in a cancellation is a typo, not a broken event: refusing the
        // event would hide the whole series from the person who mistyped one date.
        let state = state_with(&[(
            "standup",
            &[
                ("kind", "event"),
                ("start", "2026-11-03 09:15"),
                ("repeat", "every tuesday"),
                ("skip", "2026-13-45, not-a-date, 2026-11-10"),
            ],
        )]);
        let answer = range(
            &state,
            instant("2026-11-01"),
            instant("2026-11-30"),
            Bound::unbounded(),
        );
        let starts: Vec<&str> = answer.rows.iter().map(|r| r.start.as_str()).collect();
        assert_eq!(
            starts,
            vec!["2026-11-03 09:15", "2026-11-17 09:15", "2026-11-24 09:15"],
            "the readable date is honoured and the garbage changes nothing"
        );
        assert!(answer.unreadable.is_empty());
    }

    #[test]
    fn a_series_projects_one_row_per_occurrence_inside_the_window() {
        let state = state_with(&[(
            "standup",
            &[
                ("kind", "event"),
                ("start", "2026-11-03 09:15"),
                ("end", "2026-11-03 09:30"),
                ("repeat", "every tuesday and thursday"),
            ],
        )]);
        let answer = range(
            &state,
            instant("2026-11-01"),
            instant("2026-11-30"),
            Bound::unbounded(),
        );
        let starts: Vec<&str> = answer.rows.iter().map(|r| r.start.as_str()).collect();
        assert_eq!(
            starts,
            vec![
                "2026-11-03 09:15",
                "2026-11-05 09:15",
                "2026-11-10 09:15",
                "2026-11-12 09:15",
                "2026-11-17 09:15",
                "2026-11-19 09:15",
                "2026-11-24 09:15",
                "2026-11-26 09:15",
            ]
        );
        // Every row names its series, so a write targets the note.
        for row in &answer.rows {
            assert_eq!(row.occurrence_of.as_deref(), Some("standup"));
            assert!(row.occurrence_date.is_some());
            assert_eq!(row.end.as_deref(), Some(row.end.as_deref().unwrap()));
        }
        // The 15-minute duration is carried, not recomputed.
        assert_eq!(
            answer.rows[2].end.as_deref(),
            Some("2026-11-10 09:30"),
            "the series duration must survive projection"
        );
    }

    #[test]
    fn an_unrecognized_rule_is_returned_and_reported_rather_than_defaulted() {
        let state = state_with(&[(
            "weird",
            &[
                ("kind", "event"),
                ("start", "2026-11-05 10:00"),
                ("repeat", "every other blue moon"),
            ],
        )]);
        let answer = range(
            &state,
            instant("2026-11-01"),
            instant("2026-11-30"),
            Bound::unbounded(),
        );
        assert_eq!(answer.rows.len(), 1);
        assert!(answer.rows[0].repeat_unrecognized);
        assert_eq!(
            answer.rows[0].repeat.as_deref(),
            Some("every other blue moon")
        );
    }

    #[test]
    fn a_broken_event_is_surfaced_not_dropped() {
        let state = state_with(&[
            ("nostart", &[("kind", "event")]),
            ("badstart", &[("kind", "event"), ("start", "next tuesday")]),
            (
                "backwards",
                &[
                    ("kind", "event"),
                    ("start", "2026-11-05 14:00"),
                    ("end", "2026-11-05 09:00"),
                ],
            ),
            ("ordinary", &[("start", "2026-11-05 10:00")]),
        ]);
        let answer = range(
            &state,
            instant("2026-11-01"),
            instant("2026-11-30"),
            Bound::unbounded(),
        );
        assert!(answer.rows.is_empty());
        let reasons: Vec<(String, UnreadableReason)> = answer
            .unreadable
            .iter()
            .map(|u| (u.note_id.clone(), u.reason))
            .collect();
        assert_eq!(
            reasons,
            vec![
                ("backwards".to_string(), UnreadableReason::EndBeforeStart),
                ("badstart".to_string(), UnreadableReason::StartUnreadable),
                ("nostart".to_string(), UnreadableReason::StartMissing),
            ]
        );
        // A note with a `start` but no `kind: event` is not an event at all, so it
        // is neither a row nor unreadable: the property is just a property.
        assert!(!answer.unreadable.iter().any(|u| u.note_id == "ordinary"));
    }

    #[test]
    fn overlaps_are_flagged_by_the_host_not_by_the_caller() {
        let state = state_with(&[
            (
                "a",
                &[
                    ("kind", "event"),
                    ("start", "2026-11-05 09:00"),
                    ("end", "2026-11-05 10:00"),
                ],
            ),
            ("b", &[("kind", "event"), ("start", "2026-11-05 09:30")]),
            ("c", &[("kind", "event"), ("start", "2026-11-05 11:00")]),
        ]);
        let answer = range(
            &state,
            instant("2026-11-05"),
            instant("2026-11-05 23:59"),
            Bound::unbounded(),
        );
        let flags: Vec<bool> = answer.rows.iter().map(|r| r.conflicts).collect();
        assert_eq!(flags, vec![true, true, false]);

        // Two events that touch exactly at a boundary do not conflict: intervals
        // are half-open, which is what keeps a back-to-back schedule clean.
        let touching = state_with(&[
            (
                "x",
                &[
                    ("kind", "event"),
                    ("start", "2026-11-05 09:00"),
                    ("end", "2026-11-05 10:00"),
                ],
            ),
            (
                "y",
                &[
                    ("kind", "event"),
                    ("start", "2026-11-05 10:00"),
                    ("end", "2026-11-05 11:00"),
                ],
            ),
        ]);
        let answer = range(
            &touching,
            instant("2026-11-05"),
            instant("2026-11-05 23:59"),
            Bound::unbounded(),
        );
        assert!(answer.rows.iter().all(|r| !r.conflicts));
    }

    /// The shared verdict fixture: the SAME cases `@myne/dialect` runs through
    /// `nextOccurrence` in `tests/dialect/calendarRecurrenceFixture.test.ts`.
    ///
    /// This is the whole anti-drift argument for having the closed vocabulary
    /// parsed twice. A change to either side's advance fails here or there, and
    /// the file itself is hand-written from the spec's worked examples rather
    /// than generated from either implementation.
    #[test]
    fn agrees_with_the_shared_recurrence_fixture() {
        #[derive(serde::Deserialize)]
        struct Case {
            rule: String,
            start: String,
            until: String,
            occurrences: Option<Vec<String>>,
        }
        #[derive(serde::Deserialize)]
        struct Fixture {
            cases: Vec<Case>,
        }

        let raw = include_str!("../../../tests/fixtures/calendar/recurrence_projection.json");
        let fixture: Fixture = serde_json::from_str(raw).expect("fixture parses");

        for case in &fixture.cases {
            let Some(expected) = &case.occurrences else {
                assert!(
                    parse_rule(&case.rule).is_none(),
                    "{} must stay unrecognized",
                    case.rule
                );
                continue;
            };
            let rule =
                parse_rule(&case.rule).unwrap_or_else(|| panic!("{} should parse", case.rule));
            let start = EventInstant::parse(&case.start).expect("start").days;
            let until = EventInstant::parse(&case.until).expect("until").days;
            let got: Vec<String> = occurrences_from(start, &rule, until)
                .into_iter()
                .map(|d| {
                    let (y, m, day) = civil_from_days(d);
                    format!("{y:04}-{m:02}-{day:02}")
                })
                .collect();
            assert_eq!(&got, expected, "rule {}", case.rule);
        }
    }

    #[test]
    fn a_bounded_window_is_capped_at_366_days_and_an_unbounded_one_is_not() {
        let start = instant("2026-11-01");
        let inside = instant("2027-10-01");
        let outside = instant("2028-02-01");
        assert_eq!(
            bound_for_window(start, inside, true).map(|b| b.max_rows),
            Ok(Some(MAX_ROWS))
        );
        assert_eq!(
            bound_for_window(start, outside, true),
            Err(WindowRefusal::TooWide {
                max_days: MAX_WINDOW_DAYS
            })
        );
        // The user's own surfaces are never refused: the cap is a property of the
        // CALLER handing rows to a model, not of the query.
        assert_eq!(
            bound_for_window(start, outside, false).map(|b| b.max_rows),
            Ok(None)
        );
        assert_eq!(
            bound_for_window(inside, start, false),
            Err(WindowRefusal::Unreadable)
        );
    }

    #[test]
    fn the_bound_truncates_rows_and_keeps_the_earliest() {
        use super::super::state::PropertyEntry;
        let state = VaultIndicesState::default();
        for i in 0..10u32 {
            let (id, mut record) = event_note(&format!("n{i}"), &[]);
            record.properties = vec![
                PropertyEntry {
                    key: "kind".to_string(),
                    r#type: "string".to_string(),
                    value: Some("event".to_string()),
                    elements: None,
                },
                PropertyEntry {
                    key: "start".to_string(),
                    r#type: "string".to_string(),
                    value: Some(format!("2026-11-{:02} 10:00", i + 1)),
                    elements: None,
                },
            ];
            state.apply(&id, record);
        }
        let answer = range(
            &state,
            instant("2026-11-01"),
            instant("2026-11-30"),
            Bound { max_rows: Some(3) },
        );
        assert_eq!(
            answer
                .rows
                .iter()
                .map(|r| r.start.clone())
                .collect::<Vec<_>>(),
            vec!["2026-11-01 10:00", "2026-11-02 10:00", "2026-11-03 10:00"]
        );
    }

    #[test]
    fn ordinal_position_clamps_back_to_the_last_of_that_weekday() {
        // February 2026 holds four Mondays, so `fifth`-shaped positions clamp back;
        // `fourth monday` is 2026-02-23.
        let rule = parse_rule("fourth monday of every month").unwrap();
        let dates = occurrences_from(days(2026, 1, 26), &rule, days(2026, 3, 31));
        let feb = dates[1];
        assert_eq!(civil_from_days(feb), (2026, 2, 23));
    }
}
