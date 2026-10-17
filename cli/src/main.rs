// SPDX-License-Identifier: AGPL-3.0
//! `myne` — the CLI thin client (cli-thin-client feature; MYND-490).
//!
//! Never opens the vault, never holds a key, never prompts for a password.
//! Connects to the already-running, already-unlocked desktop over its local
//! command socket through the [`backend::MyneBackend`] seam. See
//! `myne-agents/features/cli-thin-client/prd.md` for the full feature.

mod backend;
mod exit;
mod framing;
#[cfg(test)]
mod logging_discipline;
mod output;
mod paths;
mod status;
mod wire;

use std::io::Read;

use backend::{IpcBackend, MyneBackend};

const HELP: &str = "\
myne: talk to the running Myne desktop app from the terminal

USAGE:
    myne [--json] <command>

COMMANDS:
    list                     List every live note id in scope
    show <id>                Print one note's markdown to stdout
    search <query>           Full-text search over live notes in scope
    new [--folder <path>]    Create a note from stdin
    daily                    Print today's daily note, creating it if needed
    daily:append <text>      Append a line to today's daily note
    weekly                   Print this week's note, creating it if needed
    weekly:append <text>     Append a line to this week's note
    monthly                  Print this month's note, creating it if needed
    monthly:append <text>    Append a line to this month's note
    open <path>              Open a local .md file in the Myne window

Trashed notes and templates are not notes you are working with, so they
are absent from list, search and show: the same notes the app itself
leaves out of its own lists.

`open` edits a file that lives on disk, outside every vault: the app's
local-file editor must be enabled in Settings, and only .md and .markdown
files open there. This command never reads the file itself.

Some folders may be excluded from these results (see Settings). An
excluded note's id looks identical to an unknown one everywhere above, and
an excluded search hit is simply absent, with no count of what was hidden.
Writing into an excluded folder with `new --folder` is refused outright.
If a configured periodic-notes folder is excluded, that period's commands
both fail with a clear error rather than a silent no-op.

Myne must already be running, unlocked, and have CLI access enabled in
Settings; this command never prompts for a password.";

/// A command's successful result, unified so the terminal match below can
/// render + exit through one path regardless of which command ran.
enum CommandOutput {
    List(Vec<String>),
    Show(String),
    Search(Vec<backend::SearchHit>),
    New(String),
    /// A period note's body plus whether the host used the device clock in
    /// place of a display-timezone override (myne#177). The advisory that flag
    /// selects goes to stderr, so piping stdout is unaffected. `daily` produces
    /// this too: routing every period through one shape is what stops the
    /// advisory reaching `weekly` and `monthly` while the command where a
    /// one-day mismatch bites hardest says nothing.
    Period(String, bool),
    PeriodAppend(bool),
    /// `open` has no payload: the tab appearing in the app is the result.
    Open,
}

/// Parsed argv, split into the two flags this crate supports and the
/// remaining positional arguments — kept separate from `main`'s command
/// dispatch so a `--folder` value is never mistaken for a positional
/// argument (e.g. `myne new --folder Private` must not see `Private` as a
/// second `new` argument the way `myne show <id>` sees its id).
struct ParsedArgs {
    json: bool,
    folder: Option<String>,
    positional: Vec<String>,
}

fn parse_args(raw_args: Vec<String>) -> ParsedArgs {
    let mut json = false;
    let mut folder = None;
    let mut positional = Vec::new();
    let mut iter = raw_args.into_iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--json" => json = true,
            "--folder" => {
                let Some(value) = iter.next() else {
                    eprintln!("myne: --folder requires a value\n");
                    eprintln!("{HELP}");
                    std::process::exit(exit::USAGE);
                };
                // A control character is not a folder-path character
                // (`markdown-dialect.md` §3.6.2) — and a newline in
                // particular is the frontmatter LINE SEPARATOR, so a value
                // carrying one would compose into extra frontmatter rather
                // than a folder. The desktop refuses it too (that is the
                // enforcement point, since anything can drive the socket);
                // catching it here makes it a usage error with a usable
                // message instead of a generic wire failure.
                if value.chars().any(char::is_control) {
                    eprintln!("myne: --folder cannot contain a control character");
                    std::process::exit(exit::USAGE);
                }
                folder = Some(value);
            }
            _ => positional.push(arg),
        }
    }
    ParsedArgs {
        json,
        folder,
        positional,
    }
}

fn main() {
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    let ParsedArgs {
        json,
        folder,
        positional,
    } = parse_args(raw_args);
    let positional: Vec<&str> = positional.iter().map(String::as_str).collect();

    if matches!(positional.first(), Some(&"--help") | Some(&"-h")) {
        println!("{HELP}");
        std::process::exit(exit::OK);
    }

    let Some(&command) = positional.first() else {
        eprintln!("myne: missing command\n");
        eprintln!("{HELP}");
        std::process::exit(exit::USAGE);
    };

    let outcome: Result<CommandOutput, backend::BackendError> = match command {
        "list" => {
            if positional.len() > 1 {
                eprintln!("myne: 'list' takes no arguments");
                std::process::exit(exit::USAGE);
            }
            IpcBackend::new().list().map(CommandOutput::List)
        }
        "show" => {
            if positional.len() > 2 {
                eprintln!("myne: 'show' takes exactly one argument");
                std::process::exit(exit::USAGE);
            }
            let Some(&id) = positional.get(1) else {
                eprintln!("myne: 'show' requires a note id\n");
                eprintln!("{HELP}");
                std::process::exit(exit::USAGE);
            };
            IpcBackend::new().show(id).map(CommandOutput::Show)
        }
        "search" => {
            if positional.len() > 2 {
                eprintln!("myne: 'search' takes exactly one argument");
                std::process::exit(exit::USAGE);
            }
            let Some(&query) = positional.get(1) else {
                eprintln!("myne: 'search' requires a query\n");
                eprintln!("{HELP}");
                std::process::exit(exit::USAGE);
            };
            IpcBackend::new().search(query).map(CommandOutput::Search)
        }
        "new" => {
            if positional.len() > 1 {
                eprintln!("myne: 'new' takes no positional arguments (use --folder)");
                std::process::exit(exit::USAGE);
            }
            let mut body = String::new();
            if std::io::stdin().read_to_string(&mut body).is_err() {
                eprintln!("myne: could not read stdin (is it valid UTF-8?)");
                std::process::exit(exit::IO);
            }
            // Empty stdin is a usage error, never an empty note (task 8's
            // own acceptance criterion) — `echo` with nothing piped in
            // still writes a trailing newline, so trim before judging.
            if body.trim().is_empty() {
                eprintln!("myne: 'new' requires a non-empty note body on stdin\n");
                eprintln!("{HELP}");
                std::process::exit(exit::USAGE);
            }
            IpcBackend::new()
                .create(&body, folder.as_deref())
                .map(CommandOutput::New)
        }
        // myne#177: all three periods and their append variants, as ONE pair of
        // arms rather than six. `daily` routes through the same wire command as
        // the other two, which is what carries the timezone advisory to the
        // command where a one-day mismatch bites hardest; the host still accepts
        // the older `daily` shape for a `myne` binary older than the app.
        "daily" | "weekly" | "monthly" => {
            // A `&'static str` chosen by the match, never the raw word the user
            // typed: stderr is the diagnostic channel and uncontrolled input may
            // not reach it (`logging_discipline.rs`).
            let period: &'static str = match command {
                "weekly" => "weekly",
                "monthly" => "monthly",
                _ => "daily",
            };
            if positional.len() > 1 {
                eprintln!("myne: '{period}' takes no arguments");
                std::process::exit(exit::USAGE);
            }
            IpcBackend::new()
                .period(period)
                .map(|(body, used_device_clock)| CommandOutput::Period(body, used_device_clock))
        }
        "daily:append" | "weekly:append" | "monthly:append" => {
            let period: &'static str = match command {
                "weekly:append" => "weekly",
                "monthly:append" => "monthly",
                _ => "daily",
            };
            if positional.len() > 2 {
                eprintln!("myne: '{period}:append' takes exactly one argument");
                std::process::exit(exit::USAGE);
            }
            // A missing argument AND a blank one are the same usage error:
            // appending an empty line writes a note revision that looks like
            // nothing happened, the silent-no-op shape this command exists to
            // avoid. Same `trim()` judgement `new` applies to empty stdin.
            let line = positional.get(1).copied().unwrap_or("");
            if line.trim().is_empty() {
                eprintln!("myne: '{period}:append' requires a line of text\n");
                eprintln!("{HELP}");
                std::process::exit(exit::USAGE);
            }
            IpcBackend::new()
                .period_append(period, line)
                .map(CommandOutput::PeriodAppend)
        }
        // myne-md/myne#788 (plaintext-file-editor task 11). The file is
        // opened by the RUNNING app; this binary only names the path. It is
        // made absolute against THIS shell's working directory first, because
        // the desktop's cwd is wherever the app was launched from and a
        // relative path would silently name a different file there. Nothing
        // is read: `absolute` joins and normalises, it does not touch the
        // filesystem.
        "open" => {
            if positional.len() > 2 {
                eprintln!("myne: 'open' takes exactly one path");
                std::process::exit(exit::USAGE);
            }
            let Some(&raw) = positional.get(1) else {
                eprintln!("myne: 'open' requires a path\n");
                eprintln!("{HELP}");
                std::process::exit(exit::USAGE);
            };
            let absolute = std::path::absolute(raw)
                .ok()
                .and_then(|path| path.to_str().map(str::to_string));
            let Some(path) = absolute else {
                eprintln!("myne: 'open' needs a usable filesystem path");
                std::process::exit(exit::USAGE);
            };
            IpcBackend::new().open(&path).map(|()| CommandOutput::Open)
        }
        // The unrecognized word is deliberately NOT echoed back. `git`-style
        // "unknown command 'foo'" reads friendlier, but the word here is
        // uncontrolled input, and the commonest way to land in this arm is a
        // dropped verb — `myne <note-id>` instead of `myne show <note-id>`.
        // That would put a vault-stable correlation tag into stderr, which is
        // the channel that ends up in `2>` redirects, CI logs and pasted
        // support output (DENY list: note_id — src-tauri/AGENTS.md
        // "Secret-handling logging discipline"). The shell already shows the
        // user what they typed; `HELP` below shows what they could have.
        _ => {
            eprintln!("myne: unknown command\n");
            eprintln!("{HELP}");
            std::process::exit(exit::USAGE);
        }
    };

    match outcome {
        Ok(CommandOutput::List(notes)) => {
            output::print_list(&notes, json);
            std::process::exit(exit::OK);
        }
        Ok(CommandOutput::Show(body)) => {
            output::print_show(&body, json);
            std::process::exit(exit::OK);
        }
        Ok(CommandOutput::Search(hits)) => {
            output::print_search(&hits, json);
            std::process::exit(exit::OK);
        }
        Ok(CommandOutput::New(id)) => {
            output::print_new(&id, json);
            std::process::exit(exit::OK);
        }
        Ok(CommandOutput::Period(body, used_device_clock)) => {
            // The note goes to stderr, the body to stdout: `myne weekly > file`
            // must keep working, and a warning that lands in the file is a
            // warning that corrupts the thing it was warning about.
            output::print_device_clock_note(used_device_clock);
            output::print_show(&body, json);
            std::process::exit(exit::OK);
        }
        Ok(CommandOutput::PeriodAppend(used_device_clock)) => {
            output::print_device_clock_note(used_device_clock);
            output::print_daily_append(json);
            std::process::exit(exit::OK);
        }
        Ok(CommandOutput::Open) => {
            output::print_open(json);
            std::process::exit(exit::OK);
        }
        Err(err) => {
            output::print_error(&err, json);
            std::process::exit(exit::from_backend_error(&err));
        }
    }
}
