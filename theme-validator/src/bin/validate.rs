//! `validate` — the CI entry point for the Myne theme-value allowlist.
//!
//! The `myne-themes` marketplace CI runs THIS binary against every submitted
//! `theme.json`, guaranteeing the repo can never host a theme the desktop client
//! would reject (both sides call the same `theme_validator::validate_theme`).
//!
//! Usage:
//!   validate <path/to/theme.json>   # validate a file
//!   validate -                      # validate JSON piped on stdin
//!   validate                        # (no arg) also reads stdin
//!
//! Exit codes:
//!   0 — valid (prints `ok: <n> tokens` on stdout)
//!   1 — invalid (prints the rich `ThemeError` JSON on stderr)
//!   2 — usage / IO error (could not read the input)

use std::io::Read;
use std::process::ExitCode;

use theme_validator::validate_theme;

fn main() -> ExitCode {
    let arg = std::env::args().nth(1);
    let json = match arg.as_deref() {
        Some("-") | None => {
            let mut buf = String::new();
            if std::io::stdin().read_to_string(&mut buf).is_err() {
                eprintln!("error: failed to read theme JSON from stdin");
                return ExitCode::from(2);
            }
            buf
        }
        Some(path) => match std::fs::read_to_string(path) {
            Ok(contents) => contents,
            Err(e) => {
                eprintln!("error: cannot read {path}: {}", e.kind());
                return ExitCode::from(2);
            }
        },
    };

    match validate_theme(&json) {
        Ok(theme) => {
            println!("ok: {} tokens", theme.vars.len());
            ExitCode::SUCCESS
        }
        Err(err) => {
            // The rich {kind, key?, line?} reason, machine-readable for CI logs.
            match serde_json::to_string(&err) {
                Ok(s) => eprintln!("{s}"),
                Err(_) => eprintln!("{{\"kind\":\"InvalidValue\"}}"),
            }
            ExitCode::from(1)
        }
    }
}
