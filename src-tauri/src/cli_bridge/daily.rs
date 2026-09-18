//! `myne daily` / `myne daily:append` (cli-thin-client task 9; MYND-490).
//!
//! Resolves "today's daily note" through the SAME rules the app's own "open
//! today's note" flow uses — folder, template, naming — never a CLI-local
//! reimplementation (the PRD's behaviour-parity rule): the match predicate
//! and date-title formatting live in
//! [`myne_core::plugins::notes::daily_match`] (a Rust port of
//! `dailyNote.ts::resolveTodayNote`), and template rendering goes through
//! the SAME canonical `protocol::template::render` engine
//! `newNoteFromTemplate.ts::createNoteFromTemplate` calls (that TS function
//! is itself documented as "a pure mirror of the `#![no_std]` Rust engine" —
//! this module is the OTHER caller of the one real engine, not a second
//! mirror).
//!
//! One divergence from the TS flow, unavoidable here: `formatLocalWeekday`
//! reads the app-language locale via `Intl`, which `cli_bridge` has no
//! access to (no i18n catalog, no WebView). `{{weekday}}` therefore always
//! renders the English long name — a documented simplification, not a
//! silent one (see [`WEEKDAY_NAMES`]).
//!
//! See: src-tauri/AGENTS.md "Secret-handling logging discipline" — this
//! module touches no note content, id, folder name or path in any log line
//! (it has no `tracing` call sites at all; every failure collapses to the
//! same bounded [`DailyError`] the caller already logs, if it logs anything).

use myne_core::hooks::Hooks;
use myne_core::host::HostCtx;
use myne_core::plugins::notes::commands::{
    note_create_from_host, note_list_from_host, note_read_from_host, note_update_from_host,
};
use myne_core::plugins::notes::daily_match;
use myne_core::plugins::notes::error::{
    NoteCreateError, NoteListError, NoteReadError, NoteUpdateError,
};
use myne_core::plugins::notes::title_extract::{
    body_after_frontmatter, extract_title_slices, fm_folder,
};
use myne_core::plugins::prefs::commands::prefs_read_from_host;
use myne_core::plugins::prefs::error::PrefsReadError;
use myne_core::plugins::prefs::folder_scope::folder_is_excluded;
use myne_core::plugins::vault_unlock::state::VaultRuntimeState;
use myne_core::vault_io::VaultIo;

use super::compose::{compose_daily_plaintext, normalize_folder_path};

/// Closed outcome of a `daily` / `daily:append` request — the same three
/// wire-visible failure classes `scope.rs`'s helpers already use, so
/// `dispatch.rs` maps 1:1 without inventing a fourth vocabulary.
#[derive(Debug, PartialEq, Eq)]
pub enum DailyError {
    /// The resolved daily folder (or one of its ancestors) is in
    /// `cli_excluded_folders` — checked BEFORE any scan or write, so a
    /// refusal never touches an existing note or creates one (task 9's own
    /// text: "never a silent no-op").
    FolderExcluded,
    VaultLocked,
    Io,
}

/// English long weekday names, indexed by `struct tm`'s `tm_wday` (0 =
/// Sunday). See module doc — the app-language locale `formatLocalWeekday`
/// reads is not available to a raw socket dispatcher.
const WEEKDAY_NAMES: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

/// The OS-local calendar date + time-of-day + weekday for a Unix timestamp.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalNow {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    /// 0 = Sunday … 6 = Saturday (mirrors `struct tm::tm_wday`).
    pub weekday: u32,
}

/// Read the OS-local calendar date/time for `unix_secs` via `localtime_r`.
///
/// FFI, `#[cfg(unix)]` only (matches this whole module's production caller,
/// `dispatch.rs`'s `AppNoteLister`, which is itself `#[cfg(unix)]`-gated).
/// `localtime_r` is POSIX and thread-safe on glibc absent a concurrent
/// `setenv("TZ", …)`, which this codebase never does (see the `libc`
/// dependency comment in `src-tauri/Cargo.toml` for the fuller rationale
/// against `chrono`/`time`).
///
/// `None` when `localtime_r` fails (NULL return — `EOVERFLOW` on a timestamp
/// the platform's `struct tm` cannot represent). Unreachable for a current
/// clock reading, but this is the function that decides *which note*
/// `myne daily` opens: taking the zeroed `tm` on trust would silently answer
/// "1 January 1900" and create a note under that title.
#[cfg(unix)]
pub fn local_now(unix_secs: i64) -> Option<LocalNow> {
    // SAFETY: `tm` is fully zero-initialized before the call; `t` points at
    // a live local `time_t`; `localtime_r` writes every field it documents
    // before returning a non-NULL pointer, and the NULL case is rejected
    // below rather than read.
    unsafe {
        let t: libc::time_t = unix_secs as libc::time_t;
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&t, &mut tm).is_null() {
            return None;
        }
        Some(from_tm(&tm))
    }
}

/// Map a populated `struct tm` onto [`LocalNow`].
///
/// Split out of [`local_now`] so the mapping — the part with the two off-by-one
/// conversions that actually can be wrong — is testable **without touching the
/// process environment**. Its test used to force a known offset with
/// `std::env::set_var("TZ", "UTC")` under a SAFETY comment asserting a
/// *"single-threaded test process"*, which `cargo test` does not provide: other
/// threads sit inside `localtime_r` reading `TZ` while that `setenv` runs,
/// which is a data race and undefined behaviour. It surfaced as two unrelated
/// `daily_*` tests failing only in a full-suite run and passing in isolation —
/// the shape that gets called flake and bypassed with `--no-verify`.
#[cfg(unix)]
fn from_tm(tm: &libc::tm) -> LocalNow {
    LocalNow {
        year: tm.tm_year + 1900,
        month: (tm.tm_mon + 1) as u32,
        day: tm.tm_mday as u32,
        hour: tm.tm_hour as u32,
        minute: tm.tm_min as u32,
        weekday: tm.tm_wday as u32,
    }
}

/// Build the `{{date}}`/`{{time}}`/`{{datetime}}`/`{{title}}`/`{{weekday}}`
/// substitution context for `protocol::template::render`, matching
/// `newNoteFromTemplate.ts::buildRenderContext`'s field shapes exactly
/// (`YYYY-MM-DD` / `HH:mm` 24-hour / the two combined) — see module doc for
/// the one documented divergence (`weekday` is always English).
///
/// The period bounds are explicit (myne#177) rather than defaulted, so a caller
/// cannot forget them and silently render a weekly note whose
/// `{{period_start}}` is today. `{{date}}` still carries TODAY, not the period
/// start: the same template file can be a period template and something
/// instantiated by hand, so a token whose meaning depended on the call site
/// would make one file say two things.
pub fn render_context_for_period(
    local: LocalNow,
    title: &str,
    period_start: (i32, u32, u32),
    period_end: (i32, u32, u32),
) -> protocol::template::RenderContext {
    let date = daily_match::format_daily_date(
        (local.year, local.month, local.day),
        daily_match::DEFAULT_DAILY_DATE_FORMAT,
    );
    let time = format!("{:02}:{:02}", local.hour, local.minute);
    let datetime = format!("{date} {time}");
    let weekday = WEEKDAY_NAMES
        .get(local.weekday as usize)
        .copied()
        .unwrap_or("")
        .to_string();
    protocol::template::RenderContext {
        title: title.to_string(),
        period_start: daily_match::format_daily_date(
            period_start,
            daily_match::DEFAULT_DAILY_DATE_FORMAT,
        ),
        period_end: daily_match::format_daily_date(
            period_end,
            daily_match::DEFAULT_DAILY_DATE_FORMAT,
        ),
        date,
        time,
        datetime,
        weekday,
    }
}

/// Render a daily-template note's body against `ctx`, or an empty body when
/// no template is configured or the template note cannot be read (a
/// template that was deleted/became unreadable degrades to a blank daily
/// note rather than failing the whole command — documented, not silent: the
/// created note itself is still real and usable).
async fn render_daily_body(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    io: &dyn VaultIo,
    template_id: Option<&str>,
    ctx: &protocol::template::RenderContext,
) -> String {
    let Some(template_id) = template_id else {
        return String::new();
    };
    match note_read_from_host(host, state, template_id.to_string(), io).await {
        Ok(template_plaintext) => {
            let body_bytes = body_after_frontmatter(template_plaintext.as_bytes());
            let body_str = String::from_utf8_lossy(body_bytes);
            protocol::template::render(&body_str, ctx)
        }
        Err(_) => String::new(),
    }
}

/// Resolve today's daily note, creating it via the SAME rules the app's own
/// "open today's note" flow uses if no match exists, and return its id.
///
/// Refuses with [`DailyError::FolderExcluded`] up front when the configured
/// daily folder is in `cli_excluded_folders` — the daily-note match rule
/// requires an exact folder-key match, so no note the scan could find would
/// ever live outside that folder anyway; checking once, before the scan,
/// both satisfies "never a silent no-op" and avoids a pointless full-vault
/// decrypt pass when the answer is already known.
async fn resolve_or_create_period_id(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &Hooks,
    io: &dyn VaultIo,
    period: daily_match::Period,
) -> Result<(String, bool), DailyError> {
    let prefs = match prefs_read_from_host(host, state, io).await {
        Ok(view) => view,
        Err(PrefsReadError::SlotNotUnlocked) => return Err(DailyError::VaultLocked),
        Err(PrefsReadError::Io { .. }) | Err(PrefsReadError::InvalidVaultMeta) => {
            return Err(DailyError::Io)
        }
    };

    // myne#177: daily reads its three legacy top-level fields, the other
    // periods read the `periodic_notes` map. `period_settings` is the one place
    // that knows the difference, shared with the two TypeScript clients by
    // mirrored implementation rather than by a second rule written here.
    let (folder_pref, format_pref, template_pref) = daily_match::period_settings(
        period,
        (
            prefs.daily_folder.as_deref(),
            prefs.daily_date_format.as_deref(),
            prefs.daily_template.as_deref(),
        ),
        &prefs.periodic_notes,
    );
    let (default_folder, default_format) = period.defaults();
    let folder_norm = normalize_folder_path(folder_pref.unwrap_or(default_folder));
    // Against the exclusion list from the prefs read above, NOT a second
    // `folder_excluded_from_host` call — that helper exists for the callers
    // that do not already hold `vault.prefs`, and using it here would re-read
    // and re-decrypt the blob still in scope.
    if folder_is_excluded(folder_norm.as_deref(), &prefs.cli_excluded_folders) {
        return Err(DailyError::FolderExcluded);
    }

    // A clock the platform cannot break into a calendar date is not something
    // to guess past: `daily` would otherwise resolve against a year-1900 title.
    let Some(now) = local_now((host.now_unix_millis() / 1_000) as i64) else {
        return Err(DailyError::Io);
    };
    let format = format_pref.unwrap_or(default_format);
    // The anchor is the period's FIRST day, so the title is stable across the
    // whole period and the command is idempotent from any day inside it.
    let (anchor, period_start, period_end) =
        daily_match::period_range((now.year, now.month, now.day), period);
    let date_title = daily_match::format_daily_date(anchor, format);
    // myne#177: this side does NOT honour the `timezone` display override.
    // `src-tauri/Cargo.toml` argues `chrono`/`time` down for this module and
    // `localtime_r` has no way to answer for a named zone, so rather than
    // pretend, the reply carries a note naming the override it is not applying
    // and the client prints it. Silence here would let the GUI and the CLI open
    // different notes on the same evening with nothing saying why.
    // What crosses the socket is a FLAG, and the CLI owns the sentence. Two
    // reasons, and the second is the load-bearing one. The zone is never named:
    // an IANA identifier is a coarse geolocation datum, which is why
    // `protocol.md` §9.5 classes `timezone` device-local so it never merges
    // from a peer, and stderr is the channel that ends up in `2>` redirects, CI
    // logs and pasted output. And a string here would put host-supplied bytes
    // on the CLI's stderr, which is exactly what that crate's
    // `logging_discipline` allowlist exists to forbid: it checks NAMES, so a
    // later edit interpolating a folder or an `io::Error` into a wire string
    // would pass it green. A bool cannot carry any of that.
    let used_device_clock = prefs.timezone.as_deref().is_some_and(|z| !z.is_empty());
    let want_folder_key = folder_norm
        .as_deref()
        .map(daily_match::fold)
        .unwrap_or_default();
    let want_title_key = daily_match::fold(&date_title);

    let ids = match note_list_from_host(host, state, io).await {
        Ok(ids) => ids,
        Err(NoteListError::VaultNotUnlocked) => return Err(DailyError::VaultLocked),
        Err(_) => return Err(DailyError::Io),
    };
    for id in ids {
        let id = id.to_string();
        match note_read_from_host(host, state, id.clone(), io).await {
            Ok(body) => {
                let slices = extract_title_slices(body.as_bytes());
                // Structurally normalize the note's OWN `folder:` value before
                // handing it to the fold comparison — `loadNoteBatch.ts` does
                // exactly this (`TitleRecord.folder` is
                // `normalizeFolderPath(folderRaw)`) before `resolveTodayNote`
                // folds it via `folderKey`. Without it a hand-edited
                // `folder: Daily` note would fail to match the canonical
                // `Daily/` want-key and the CLI would create a SECOND note
                // for today that the app itself would have reused.
                let folder = slices
                    .frontmatter_bytes
                    .and_then(fm_folder)
                    .and_then(|raw| normalize_folder_path(&raw));
                if daily_match::note_matches_daily(
                    slices.frontmatter_bytes,
                    folder.as_deref(),
                    &want_folder_key,
                    &want_title_key,
                ) {
                    return Ok((id, used_device_clock));
                }
            }
            Err(NoteReadError::VaultNotUnlocked) => return Err(DailyError::VaultLocked),
            // Fail-closed scan discipline (matches `scope::filter_note_ids_by_scope`):
            // an unreadable note is simply skipped, never treated as a match.
            Err(_) => {}
        }
    }

    // No existing match — create, following the SAME template/blank rule
    // `newNoteFromTemplate.ts::createNoteFromTemplate`/`createBlankNamedNote`
    // use (behaviour-parity rule).
    let ctx = render_context_for_period(now, &date_title, period_start, period_end);
    let rendered_body = render_daily_body(host, state, io, template_pref, &ctx).await;
    let plaintext = compose_daily_plaintext(&rendered_body, &date_title, folder_norm.as_deref());
    match note_create_from_host(host, state, hooks, plaintext, io).await {
        Ok(id) => Ok((id, used_device_clock)),
        Err(NoteCreateError::VaultNotUnlocked) => Err(DailyError::VaultLocked),
        Err(_) => Err(DailyError::Io),
    }
}

/// `myne daily` / `myne weekly` / `myne monthly`: the period note's markdown,
/// open-or-create. The second element is the timezone note, present only when a
/// display-timezone override is set that this side does not apply (myne#177).
pub async fn period_show(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &Hooks,
    io: &dyn VaultIo,
    period: daily_match::Period,
) -> Result<(String, bool), DailyError> {
    let (id, used_device_clock) =
        resolve_or_create_period_id(host, state, hooks, io, period).await?;
    match note_read_from_host(host, state, id, io).await {
        Ok(body) => Ok((body, used_device_clock)),
        Err(NoteReadError::VaultNotUnlocked) => Err(DailyError::VaultLocked),
        Err(_) => Err(DailyError::Io),
    }
}

/// `myne daily:append`: resolve/create today's note exactly like
/// [`daily_show`], then append `line` — a newline is inserted before it iff
/// the current body is non-empty and doesn't already end in one, and the
/// result always ends in exactly one trailing newline.
pub async fn period_append(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &Hooks,
    io: &dyn VaultIo,
    period: daily_match::Period,
    line: &str,
) -> Result<bool, DailyError> {
    let (id, used_device_clock) =
        resolve_or_create_period_id(host, state, hooks, io, period).await?;
    let body = match note_read_from_host(host, state, id.clone(), io).await {
        Ok(b) => b,
        Err(NoteReadError::VaultNotUnlocked) => return Err(DailyError::VaultLocked),
        Err(_) => return Err(DailyError::Io),
    };
    let mut new_body = body;
    if !new_body.is_empty() && !new_body.ends_with('\n') {
        new_body.push('\n');
    }
    new_body.push_str(line);
    new_body.push('\n');
    match note_update_from_host(host, state, hooks, id, new_body, None, io).await {
        Ok(()) => Ok(used_device_clock),
        Err(NoteUpdateError::VaultNotUnlocked) => Err(DailyError::VaultLocked),
        Err(_) => Err(DailyError::Io),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use myne_core::host::test_host::TestHost;
    use myne_core::paths::vault_root_for_id_from_base;
    use myne_core::plugins::prefs::commands::{
        set_cli_excluded_folders_from_host, set_daily_date_format_from_host,
        set_daily_folder_from_host, set_daily_template_from_host,
    };
    use myne_core::plugins::vault_unlock::state::{fixture_unlocked_with_keys, test_vault_id};
    use myne_core::test_support::{seed_real_vault_meta, ScopedTempDir};

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    fn noop_hooks() -> Hooks {
        std::sync::Arc::new(myne_core::hooks::NoopHooks)
    }

    async fn make_temp_vault_with_unlocked_state(
        seed_account_hash: u8,
    ) -> (ScopedTempDir, TestHost, VaultRuntimeState) {
        let tmp = ScopedTempDir::new("cli-bridge-daily-it").expect("scoped tempdir");
        let vault_root = vault_root_for_id_from_base(tmp.path(), test_vault_id());
        std::fs::create_dir_all(&vault_root).expect("mkdir vault root");
        seed_real_vault_meta(&vault_root, seed_account_hash);
        let host = TestHost::with_dirs(tmp.path().to_path_buf(), tmp.path().join("config"));
        let state = VaultRuntimeState::default();
        state
            .set_unlocked(test_vault_id(), fixture_unlocked_with_keys(0x61, 0x62, 1))
            .await;
        (tmp, host, state)
    }

    #[test]
    fn local_now_reads_a_known_utc_instant_under_the_tz_environment() {
        // `gmtime_r`, not `set_var("TZ", …)` + `localtime_r`. The old shape
        // mutated the PROCESS environment mid-run under a SAFETY comment
        // claiming a "single-threaded test process" — `cargo test` is not one,
        // so that `setenv` raced every other thread sitting in `localtime_r`.
        // Undefined behaviour, and it showed up as two unrelated `daily_*`
        // tests failing only in a full-suite run.
        //
        // What is under test is the tm -> LocalNow mapping (two off-by-ones);
        // `gmtime_r` pins a known offset without an environment at all. The
        // choice of `localtime_r` inside `local_now` is one FFI line and stays
        // uncovered, deliberately.
        //
        // SAFETY: `tm` is zero-initialized; `t` points at a live `time_t`;
        // `gmtime_r` populates every field it documents. No environment is
        // read or written, so no cross-thread hazard exists.
        let now = unsafe {
            let t: libc::time_t = 1785414840; // 2026-07-30T12:34:00Z
            let mut tm: libc::tm = std::mem::zeroed();
            assert!(
                !libc::gmtime_r(&t, &mut tm).is_null(),
                "gmtime_r must resolve a representable instant"
            );
            from_tm(&tm)
        };
        assert_eq!(now.year, 2026);
        assert_eq!(now.month, 7);
        assert_eq!(now.day, 30);
        assert_eq!(now.hour, 12);
        assert_eq!(now.minute, 34);
    }

    #[test]
    fn an_unrepresentable_instant_is_none_rather_than_the_year_1900() {
        // `struct tm::tm_year` is an `int`, so a `time_t` beyond ±~2.1e9 years
        // overflows it and `localtime_r` returns NULL with `EOVERFLOW`. Before
        // the NULL check, the zeroed `tm` came back as a perfectly ordinary
        // 1900-01-00 and `myne daily` would have created a note under it.
        assert_eq!(local_now(i64::MAX), None);
    }

    #[test]
    fn render_context_formats_date_time_datetime_and_english_weekday() {
        let local = LocalNow {
            year: 2026,
            month: 7,
            day: 30,
            hour: 9,
            minute: 5,
            weekday: 4, // Thursday
        };
        let day = (2026, 7, 30);
        let ctx = render_context_for_period(local, "2026-07-30", day, day);
        assert_eq!(ctx.title, "2026-07-30");
        assert_eq!(ctx.date, "2026-07-30");
        assert_eq!(ctx.time, "09:05");
        assert_eq!(ctx.datetime, "2026-07-30 09:05");
        assert_eq!(ctx.weekday, "Thursday");
    }

    #[test]
    fn daily_show_creates_a_blank_note_when_none_exists_and_no_template() {
        rt().block_on(async {
            let (_tmp, host, state) = make_temp_vault_with_unlocked_state(0x81).await;
            let (body, _tz) = period_show(
                &host,
                &state,
                &noop_hooks(),
                &myne_core::vault_io::StdVaultIo,
                daily_match::Period::Daily,
            )
            .await
            .expect("daily_show must succeed");
            assert!(body.contains("folder: Daily/"));
        });
    }

    #[test]
    fn daily_show_is_idempotent_open_or_create() {
        rt().block_on(async {
            let (_tmp, host, state) = make_temp_vault_with_unlocked_state(0x82).await;
            let io = myne_core::vault_io::StdVaultIo;
            let (first, _) = period_show(
                &host,
                &state,
                &noop_hooks(),
                &io,
                daily_match::Period::Daily,
            )
            .await
            .expect("first daily_show must succeed");
            let ids_after_first = note_list_from_host(&host, &state, &io).await.expect("list");
            let (second, _) = period_show(
                &host,
                &state,
                &noop_hooks(),
                &io,
                daily_match::Period::Daily,
            )
            .await
            .expect("second daily_show must succeed");
            let ids_after_second = note_list_from_host(&host, &state, &io).await.expect("list");
            assert_eq!(first, second, "second call must open the SAME note");
            assert_eq!(
                ids_after_first.len(),
                ids_after_second.len(),
                "second call must not create a duplicate"
            );
        });
    }

    #[test]
    fn daily_show_renders_the_configured_template() {
        rt().block_on(async {
            let (_tmp, host, state) = make_temp_vault_with_unlocked_state(0x83).await;
            let io = myne_core::vault_io::StdVaultIo;
            let hooks = noop_hooks();
            let template_id = note_create_from_host(
                &host,
                &state,
                &hooks,
                "---\ntitle: My Template\n---\n## {{title}}\ncreated {{date}}".to_string(),
                &io,
            )
            .await
            .expect("template note create must succeed");
            set_daily_template_from_host(&host, &state, &hooks, Some(template_id), &io)
                .await
                .expect("set daily template must succeed");

            let (body, _tz) = period_show(&host, &state, &hooks, &io, daily_match::Period::Daily)
                .await
                .expect("daily_show must succeed");
            assert!(body.contains("## "), "the {{title}} token must be rendered");
            assert!(!body.contains("{{"), "no unrendered token should remain");
        });
    }

    #[test]
    fn daily_append_creates_then_appends_a_line() {
        rt().block_on(async {
            let (_tmp, host, state) = make_temp_vault_with_unlocked_state(0x84).await;
            let io = myne_core::vault_io::StdVaultIo;
            let hooks = noop_hooks();
            period_append(
                &host,
                &state,
                &hooks,
                &io,
                daily_match::Period::Daily,
                "first line",
            )
            .await
            .expect("first append must succeed");
            let (body, _tz) = period_show(&host, &state, &hooks, &io, daily_match::Period::Daily)
                .await
                .expect("daily_show must succeed");
            assert!(body.ends_with("first line\n"));

            period_append(
                &host,
                &state,
                &hooks,
                &io,
                daily_match::Period::Daily,
                "second line",
            )
            .await
            .expect("second append must succeed");
            let (body, _tz) = period_show(&host, &state, &hooks, &io, daily_match::Period::Daily)
                .await
                .expect("daily_show must succeed");
            assert!(body.ends_with("first line\nsecond line\n"));
            assert!(!body.contains("\n\nsecond line"), "no blank line inserted");
        });
    }

    #[test]
    fn excluded_daily_folder_refuses_both_commands_with_no_note_created() {
        rt().block_on(async {
            let (_tmp, host, state) = make_temp_vault_with_unlocked_state(0x85).await;
            let io = myne_core::vault_io::StdVaultIo;
            let hooks = noop_hooks();
            set_cli_excluded_folders_from_host(
                &host,
                &state,
                &hooks,
                myne_core::plugins::prefs::set_mutation::SetMutation::adding_all(vec![
                    "Daily/".to_string()
                ]),
                &io,
            )
            .await
            .expect("set exclusions must succeed");

            let show_result =
                period_show(&host, &state, &hooks, &io, daily_match::Period::Daily).await;
            assert_eq!(show_result, Err(DailyError::FolderExcluded));

            let append_result =
                period_append(&host, &state, &hooks, &io, daily_match::Period::Daily, "x").await;
            assert_eq!(append_result, Err(DailyError::FolderExcluded));

            let ids = note_list_from_host(&host, &state, &io)
                .await
                .expect("list must succeed");
            assert!(ids.is_empty(), "nothing may be created on a refusal");
        });
    }

    #[test]
    fn excluded_nested_daily_folder_also_refuses() {
        rt().block_on(async {
            let (_tmp, host, state) = make_temp_vault_with_unlocked_state(0x86).await;
            let io = myne_core::vault_io::StdVaultIo;
            let hooks = noop_hooks();
            set_daily_folder_from_host(&host, &state, &hooks, "Private/Daily/".to_string(), &io)
                .await
                .expect("set daily folder must succeed");
            set_cli_excluded_folders_from_host(
                &host,
                &state,
                &hooks,
                myne_core::plugins::prefs::set_mutation::SetMutation::adding_all(vec![
                    "Private/".to_string()
                ]),
                &io,
            )
            .await
            .expect("set exclusions must succeed");

            let result = period_show(&host, &state, &hooks, &io, daily_match::Period::Daily).await;
            assert_eq!(result, Err(DailyError::FolderExcluded));
        });
    }

    #[test]
    fn custom_daily_folder_and_format_are_respected() {
        rt().block_on(async {
            let (_tmp, host, state) = make_temp_vault_with_unlocked_state(0x87).await;
            let io = myne_core::vault_io::StdVaultIo;
            let hooks = noop_hooks();
            set_daily_folder_from_host(&host, &state, &hooks, "Journal/".to_string(), &io)
                .await
                .expect("set daily folder must succeed");
            set_daily_date_format_from_host(&host, &state, &hooks, "YYYY/MM/DD".to_string(), &io)
                .await
                .expect("set daily date format must succeed");

            let (body, _tz) = period_show(&host, &state, &hooks, &io, daily_match::Period::Daily)
                .await
                .expect("daily_show must succeed");
            assert!(body.contains("folder: Journal/"));
            assert!(body.contains('/'), "the custom date format must be honored");
        });
    }

    #[test]
    fn a_trashed_note_with_the_same_title_and_folder_does_not_match() {
        rt().block_on(async {
            let (_tmp, host, state) = make_temp_vault_with_unlocked_state(0x88).await;
            let io = myne_core::vault_io::StdVaultIo;
            let hooks = noop_hooks();
            let now = local_now((host.now_unix_millis() / 1_000) as i64)
                .expect("localtime_r must resolve the test clock");
            let date_title =
                daily_match::format_daily_date((now.year, now.month, now.day), "YYYY-MM-DD");
            let plaintext = format!(
                "---\ntitle: \"{date_title}\"\nfolder: Daily/\ntrashed: 2026-01-01T00:00:00Z\n---\nold"
            );
            note_create_from_host(&host, &state, &hooks, plaintext, &io)
                .await
                .expect("trashed note create must succeed");

            let ids_before = note_list_from_host(&host, &state, &io).await.expect("list");
            assert_eq!(ids_before.len(), 1);

            period_show(&host, &state, &hooks, &io, daily_match::Period::Daily)
                .await
                .expect("daily_show must succeed");

            let ids_after = note_list_from_host(&host, &state, &io).await.expect("list");
            assert_eq!(
                ids_after.len(),
                2,
                "a trashed same-title note must not be reused; a fresh note is created"
            );
        });
    }

    #[test]
    fn a_hand_edited_folder_without_a_trailing_slash_still_matches() {
        // `loadNoteBatch.ts` normalizes `TitleRecord.folder` before
        // `resolveTodayNote` folds it, so the APP reuses a note whose
        // hand-edited frontmatter says `folder: Daily` (no trailing slash).
        // The CLI must reach the same note rather than creating a duplicate
        // today-note — task 9's "creation-on-first-use matches app behaviour
        // exactly".
        rt().block_on(async {
            let (_tmp, host, state) = make_temp_vault_with_unlocked_state(0x8a).await;
            let io = myne_core::vault_io::StdVaultIo;
            let hooks = noop_hooks();
            let now = local_now((host.now_unix_millis() / 1_000) as i64)
                .expect("localtime_r must resolve the test clock");
            let date_title =
                daily_match::format_daily_date((now.year, now.month, now.day), "YYYY-MM-DD");
            let plaintext =
                format!("---\ntitle: \"{date_title}\"\nfolder: Daily\n---\nhand-written");
            note_create_from_host(&host, &state, &hooks, plaintext, &io)
                .await
                .expect("hand-written note create must succeed");

            let (body, _tz) = period_show(&host, &state, &hooks, &io, daily_match::Period::Daily)
                .await
                .expect("daily_show must succeed");
            assert!(
                body.contains("hand-written"),
                "the existing hand-edited note must be reused, not duplicated"
            );
            let ids = note_list_from_host(&host, &state, &io).await.expect("list");
            assert_eq!(ids.len(), 1, "no duplicate today-note may be created");
        });
    }

    #[test]
    fn vault_locked_surfaces_as_vault_locked() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("cli-bridge-daily-locked").expect("scoped tempdir");
            let vault_root = vault_root_for_id_from_base(tmp.path(), test_vault_id());
            std::fs::create_dir_all(&vault_root).expect("mkdir vault root");
            seed_real_vault_meta(&vault_root, 0x89);
            let host = TestHost::with_dirs(tmp.path().to_path_buf(), tmp.path().join("config"));
            let state = VaultRuntimeState::default(); // never unlocked

            let result = period_show(
                &host,
                &state,
                &noop_hooks(),
                &myne_core::vault_io::StdVaultIo,
                daily_match::Period::Daily,
            )
            .await
            .map(|(body, _tz)| body);
            assert_eq!(result, Err(DailyError::VaultLocked));
        });
    }
}
