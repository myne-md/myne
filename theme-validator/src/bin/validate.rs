// SPDX-License-Identifier: AGPL-3.0
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

    // Two gates, in order: the value-shape allowlist (is this SAFE?) and then the
    // WCAG floors (is this READABLE?). The second used to live in the
    // marketplace's own JS lint and so covered published themes only; running it
    // here means the repo and the client answer with the same code, and a theme
    // cannot pass CI and then be refused on install (myne#394).
    match theme_validator::validate_theme_for_import(&json) {
        Ok(mut theme) => {
            // Ornament values this build does not know are a WARNING, never a
            // failure: a submission may legitimately target a newer client, and
            // the older one degrades to plain rather than breaking. Saying so on
            // stderr means a reviewer sees an intentional forward-looking value
            // instead of wondering why nothing renders (myne#394).
            let dropped = theme_validator::drop_unknown_ornament_values(&mut theme);
            for key in &dropped {
                eprintln!("warning: unrecognized ornament value for {key} (renders plain)");
            }
            // …and the sibling case, which had no signal at all: a key naming a
            // real role and a real primitive that this role does not accept.
            // Stored and ignored is the right behaviour (it is indistinguishable
            // from a future vocabulary), but an author who wrote `--chrome-fold`
            // deserves to hear that it draws nothing rather than discover it on
            // a gallery card.
            for key in theme_validator::refused_ornament_keys(&theme) {
                eprintln!(
                    "warning: {key} is not a role/primitive pair this vocabulary accepts \
                     (stored and ignored, renders plain)"
                );
            }
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
