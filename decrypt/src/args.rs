// SPDX-License-Identifier: AGPL-3.0
//! Argument parsing for `myne-decrypt`.
//!
//! Deliberately hand-rolled rather than `clap`: the surface is four flags and
//! two positionals, and a hand parser keeps the dependency surface to the
//! already-locked `protocol` + `myne-format` + `bip39` + `zeroize` + `rpassword`
//! (the `cli/` sidecar makes the same call for the same reason).

/// Parsed command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Args {
    /// Print help and exit.
    pub help: bool,
    /// Unlock with the recovery phrase instead of the master password.
    pub recovery: bool,
    /// Also export note snapshots.
    pub history: bool,
    /// Skip the cloud-sync warning.
    pub yes: bool,
    /// The vault directory or `.myne-backup` container path.
    pub source: String,
    /// The output directory.
    pub out_dir: String,
}

/// Parse `raw` (argv without the program name). Returns a usage error message
/// on failure.
pub fn parse(raw: &[String]) -> Result<Args, String> {
    let mut help = false;
    let mut recovery = false;
    let mut history = false;
    let mut yes = false;
    let mut positional: Vec<String> = Vec::new();

    for arg in raw {
        match arg.as_str() {
            "--help" | "-h" => help = true,
            "--recovery" => recovery = true,
            "--history" => history = true,
            "--yes" => yes = true,
            s if s.starts_with("--") => {
                return Err(format!("unknown option {s:?}"));
            }
            s => positional.push(s.to_string()),
        }
    }

    if help {
        return Ok(Args {
            help,
            recovery,
            history,
            yes,
            source: String::new(),
            out_dir: String::new(),
        });
    }

    if positional.len() != 2 {
        return Err(format!(
            "expected <vault-or-backup> and <out-dir>, got {} argument(s)",
            positional.len()
        ));
    }

    let mut it = positional.into_iter();
    Ok(Args {
        help,
        recovery,
        history,
        yes,
        source: it.next().expect("len checked"),
        out_dir: it.next().expect("len checked"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn two_positionals_parse() {
        let a = parse(&v(&["/vault", "/out"])).expect("parse");
        assert_eq!(a.source, "/vault");
        assert_eq!(a.out_dir, "/out");
        assert!(!a.recovery && !a.history && !a.yes);
    }

    #[test]
    fn flags_parse_in_any_order() {
        let a = parse(&v(&["--recovery", "--history", "--yes", "v", "o"])).expect("parse");
        assert!(a.recovery && a.history && a.yes);
    }

    #[test]
    fn help_short_circuits_without_positionals() {
        let a = parse(&v(&["--help"])).expect("parse");
        assert!(a.help);
    }

    #[test]
    fn wrong_arity_is_a_usage_error() {
        assert!(parse(&v(&["only-one"])).is_err());
        assert!(parse(&v(&["a", "b", "c"])).is_err());
    }

    #[test]
    fn unknown_option_is_a_usage_error() {
        assert!(parse(&v(&["--password", "x", "v", "o"])).is_err());
    }
}
