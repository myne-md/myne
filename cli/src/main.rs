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

Trashed notes and templates are not notes you are working with, so they
are absent from list, search and show: the same notes the app itself
leaves out of its own lists.

Some folders may be excluded from these results (see Settings). An
excluded note's id looks identical to an unknown one everywhere above, and
an excluded search hit is simply absent, with no count of what was hidden.
Writing into an excluded folder with `new --folder` is refused outright.
If the configured daily-notes folder is excluded, `daily`/`daily:append`
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
    Daily(String),
    DailyAppend,
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
        "daily" => {
            if positional.len() > 1 {
                eprintln!("myne: 'daily' takes no arguments");
                std::process::exit(exit::USAGE);
            }
            IpcBackend::new().daily().map(CommandOutput::Daily)
        }
        "daily:append" => {
            if positional.len() > 2 {
                eprintln!("myne: 'daily:append' takes exactly one argument");
                std::process::exit(exit::USAGE);
            }
            // A missing argument AND a blank one are the same usage error:
            // appending an empty line writes a note revision that looks like
            // nothing happened, the silent-no-op shape task 9 exists to
            // avoid. Same `trim()` judgement `new` applies to empty stdin.
            let line = positional.get(1).copied().unwrap_or("");
            if line.trim().is_empty() {
                eprintln!("myne: 'daily:append' requires a line of text\n");
                eprintln!("{HELP}");
                std::process::exit(exit::USAGE);
            }
            IpcBackend::new()
                .daily_append(line)
                .map(|()| CommandOutput::DailyAppend)
        }
        // The unrecognized word is deliberately NOT echoed back. `git`-style
        // "unknown command 'foo'" reads friendlier, but the word here is
        // uncontrolled input, and the commonest way to land in this arm is a
        // dropped verb — `myne <note-id>` instead of `myne show <note-id>`.
        // That would put a vault-stable correlation tag into stderr, which is
        // the channel that ends up in `2>` redirects, CI logs and pasted
        // support output (DENY list: note_id — src-tauri/CLAUDE.md
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
        Ok(CommandOutput::Daily(body)) => {
            output::print_show(&body, json);
            std::process::exit(exit::OK);
        }
        Ok(CommandOutput::DailyAppend) => {
            output::print_daily_append(json);
            std::process::exit(exit::OK);
        }
        Err(err) => {
            output::print_error(&err, json);
            std::process::exit(exit::from_backend_error(&err));
        }
    }
}
