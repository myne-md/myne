//! Test-only: the CLI half of the door's logging discipline
//! (cli-thin-client task 13; MYND-490).
//!
//! See: src-tauri/AGENTS.md "Secret-handling logging discipline" — the same
//! DENY list governs both sides of this socket, and this crate's mirror of
//! the desktop's `cli_bridge::logging_discipline` audit is here.
//!
//! ## The channel rule this file enforces
//!
//! This binary has no logger — `tracing` is not a dependency and must not
//! become one. What it has instead is two streams, and they are **not** the
//! same channel:
//!
//! - **stdout is the content channel.** Note bodies, note ids and titles are
//!   what `show` / `list` / `search` exist to print; the DENY list does not
//!   apply there, because putting a note on stdout is the whole feature.
//! - **stderr is the diagnostic channel.** It is what lands in a `2>`
//!   redirect, a CI log, a pasted support transcript — the same places a
//!   `tracing` record ends up on the desktop side. Nothing DENY-class may
//!   reach it, and the audit below is what holds that line: an `eprintln!`
//!   may interpolate only from a small allowlist of bounded values.
//!
//! The `--json` envelope splits the same way: `notes` / `body` / `results` /
//! `id` carry payload by design, while `error.kind` and `error.message` are
//! diagnostic and stay bounded.
//!
//! End-to-end proof over the real binary — every command, every failure
//! class, real process, real stdout/stderr — lives in
//! `cli/tests/logging_discipline.rs`. This module is the source-level half
//! that also covers what a test cannot execute.

use crate::backend::BackendError;

/// Every source in this crate, for the audit below.
const SOURCES: &[(&str, &str)] = &[
    ("main.rs", include_str!("main.rs")),
    ("exit.rs", include_str!("exit.rs")),
    ("framing.rs", include_str!("framing.rs")),
    ("output.rs", include_str!("output.rs")),
    ("paths.rs", include_str!("paths.rs")),
    ("status.rs", include_str!("status.rs")),
    ("wire.rs", include_str!("wire.rs")),
    ("backend/mod.rs", include_str!("backend/mod.rs")),
    ("backend/ipc.rs", include_str!("backend/ipc.rs")),
];

/// The only bindings an `eprintln!` in this crate may interpolate.
///
/// **Adding a name here is a deliberate act.** `HELP` and the search
/// advisory are compile-time constants; `message` is the output of
/// `output::error_parts`, whose every arm is asserted bounded below;
/// `period` (myne#177) is a `&'static str` chosen by a two-armed match on an
/// already-matched literal, so it is one of `weekly` / `monthly` and can hold
/// nothing the user typed; `DEVICE_CLOCK_NOTE` (myne#177) is a `&'static str`
/// in `output.rs`. A name that resolves to a note id, a folder, a path or an
/// `io::Error` can never be added. That is the DENY list, and stderr is a
/// diagnostic channel.
///
/// One entry was removed rather than kept, and the removal is the interesting
/// half. `timezone_note` used to sit here and held a string DESERIALIZED OFF
/// THE SOCKET, which broke the property every other entry has: it was not
/// produced in this crate, so its boundedness rested on the host keeping its
/// own constant, which this guard cannot see. The wire now carries a bool and
/// the sentence is `output.rs`'s, so the claim is true by construction.
///
/// Note what this guard reads: the NAME, not the value. It refused `command`
/// (the raw verb the user typed) on exactly the right grounds, and the fix was
/// to stop interpolating it rather than to widen the list.
const ALLOWED_STDERR_INTERPOLATIONS: &[&str] = &[
    "HELP",
    "SEARCH_SCOPE_ADVISORY",
    "message",
    "period",
    "DEVICE_CLOCK_NOTE",
];

/// Remove `#[cfg(test)] mod … { … }` blocks, brace-matched — the same shape
/// (and the same reasoning) as the desktop-side audit's own helper: a plain
/// "truncate at the first `#[cfg(test)]`" silently exempts anything written
/// after a test module.
fn production_half(source: &str) -> String {
    let mut out = String::with_capacity(source.len());
    let mut rest = source;
    loop {
        let cut = ["#[cfg(test)]", "#[cfg(all(test"]
            .iter()
            .filter_map(|marker| rest.find(marker))
            .min();
        let Some(start) = cut else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        let semi = after.find(';');
        let brace = after.find('{');
        let Some(open) = brace else {
            match semi {
                Some(s) => {
                    rest = &after[s + 1..];
                    continue;
                }
                None => return out,
            }
        };
        if semi.is_some_and(|s| s < open) {
            rest = &after[semi.expect("checked") + 1..];
            continue;
        }
        let mut depth = 0usize;
        let mut end = None;
        for (i, c) in after[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(open + i + 1);
                        break;
                    }
                }
                _ => {}
            }
        }
        match end {
            Some(e) => rest = &after[e..],
            None => return out,
        }
    }
}

/// Argument text of every `<macro>(…)` invocation, balanced on parentheses
/// and blind to parentheses inside string literals — `eprintln!("… (use
/// --folder)")` balances by luck, `eprintln!("… :-)")` would not.
pub(crate) fn invocations(source: &str, name: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = source;
    while let Some(i) = rest.find(name) {
        let after = &rest[i + name.len()..];
        // A mention that is not a call — a doc-comment reference, a match
        // pattern's path prefix — has no argument list to audit.
        if !after.starts_with('(') {
            rest = after;
            continue;
        }
        let mut depth = 0usize;
        let mut in_string = false;
        let mut escaped = false;
        let mut end = None;
        for (j, c) in after.char_indices() {
            if escaped {
                escaped = false;
                continue;
            }
            match c {
                '\\' if in_string => escaped = true,
                '"' => in_string = !in_string,
                '(' if !in_string => depth += 1,
                ')' if !in_string => {
                    depth -= 1;
                    if depth == 0 {
                        end = Some(j);
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(end) = end else { break };
        out.push(after[1..end].to_string());
        rest = &after[end..];
    }
    out
}

/// The `{name}` placeholders in a format string, ignoring `{{` escapes.
fn placeholders(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == '{' {
            if bytes.get(i + 1) == Some(&'{') {
                i += 2;
                continue;
            }
            let mut j = i + 1;
            let mut name = String::new();
            while j < bytes.len() && bytes[j] != '}' {
                name.push(bytes[j]);
                j += 1;
            }
            out.push(name);
            i = j + 1;
            continue;
        }
        i += 1;
    }
    out
}

#[test]
fn this_crate_has_no_logger_and_must_not_grow_one() {
    // `tracing` is deliberately not a dependency: the CLI's diagnostics are
    // its own stderr, which the audit below bounds. A logger here would add
    // a third channel with none of that discipline attached to it — and
    // would put note ids into a file the user never asked for.
    for (name, source) in SOURCES {
        assert!(
            !source.contains("tracing::"),
            "{name}: this crate has no logger; diagnostics go to stderr under \
             the allowlist in this module"
        );
    }
    assert!(
        !include_str!("../Cargo.toml").contains("tracing"),
        "adding `tracing` to the CLI needs the DENY-list discipline wired first"
    );
}

#[test]
fn every_stderr_write_interpolates_only_bounded_values() {
    let mut seen = 0usize;
    for (name, source) in SOURCES {
        for invocation in invocations(&production_half(source), "eprintln!") {
            seen += 1;
            for placeholder in placeholders(&invocation) {
                // A format spec (`{x:?}`, `{x:02}`) is stripped to the name.
                let binding = placeholder.split(':').next().unwrap_or("").trim();
                assert!(
                    ALLOWED_STDERR_INTERPOLATIONS.contains(&binding),
                    "{name}: `eprintln!` interpolates `{binding}`, which is not on the \
                     stderr allowlist. stderr is the diagnostic channel — a note id, a \
                     folder name, a path or an io::Error may never reach it \
                     (src-tauri/AGENTS.md \"Secret-handling logging discipline\")."
                );
            }
            // A trailing positional argument would sidestep the placeholder
            // scan entirely (`eprintln!("{}", path)`).
            assert!(
                !invocation.trim_end().ends_with(',') && invocation.matches('"').count() <= 2,
                "{name}: `eprintln!` with more than one argument cannot be audited \
                 by name; inline the value as `{{binding}}` instead: {invocation:?}"
            );
        }
    }
    assert!(
        seen >= 10,
        "the stderr audit found only {seen} call sites; the extractor is broken"
    );
}

#[test]
fn stderr_writes_live_only_where_the_rendering_does() {
    // Keeping `eprintln!` inside the two rendering surfaces is what makes
    // the allowlist above a complete account of the diagnostic channel: a
    // write from `backend/` or `framing.rs` would be a diagnostic composed
    // where the io::Error still exists.
    for (name, source) in SOURCES {
        if *name == "main.rs" || *name == "output.rs" {
            continue;
        }
        let production = production_half(source);
        for forbidden in ["eprintln!", "println!", "print!", "dbg!"] {
            assert!(
                !production.contains(forbidden),
                "{name}: `{forbidden}` outside main.rs/output.rs — rendering belongs \
                 in output.rs, where the channel rule is enforced"
            );
        }
    }
}

#[test]
fn every_error_message_this_crate_originates_is_bounded() {
    // The messages `output::error_parts` renders (to stderr in human mode,
    // into `error.message` under `--json`) must read as labels, not as
    // diagnostics with a value pasted in.
    for err in [
        BackendError::AppNotRunning,
        BackendError::VaultLocked,
        BackendError::CliDisabled,
        BackendError::NotFound,
        BackendError::FolderExcluded,
        BackendError::RateLimited,
    ] {
        let message = crate::output::message_for(&err);
        assert!(
            !message.contains('/') && !message.contains('\\'),
            "message {message:?} is path-shaped"
        );
        assert!(
            !message.to_lowercase().contains("os error"),
            "message {message:?} looks like a raw io::Error Display"
        );
        assert!(
            message.len() < 200,
            "message {message:?} is long enough to be carrying a value"
        );
    }
}

#[test]
fn the_transport_never_puts_an_io_error_display_into_a_message() {
    // Every `BackendError::Io` this crate constructs must be a literal or a
    // closed `FrameError::label()` — never `{e}` on a `std::io::Error`,
    // whose Display includes kernel path strings on some platforms (that is
    // the exact reason `core/src/io_failure_kind.rs` exists on the other
    // side). The framing layer already reduces to `ErrorKind`, so the only
    // way to regress is to start formatting the error itself.
    let ipc = production_half(include_str!("backend/ipc.rs"));
    for invocation in invocations(&ipc, "BackendError::Io") {
        for placeholder in placeholders(&invocation) {
            let binding = placeholder.split(':').next().unwrap_or("").trim();
            assert!(
                binding.is_empty() || binding.ends_with(".label()"),
                "backend/ipc.rs: `BackendError::Io` interpolates `{binding}`; reduce it \
                 to a closed-enum label first: {invocation:?}"
            );
        }
    }
    assert!(
        !ipc.contains("e.kind()) )") && !ipc.contains("{e}"),
        "backend/ipc.rs: an io::Error must never be Display-formatted"
    );
}
