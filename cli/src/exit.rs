//! Exit-code map (cli-thin-client task 4; PRD story 12 — "a script can
//! branch on 'vault locked' vs 'not found' vs 'access disabled' without
//! parsing text"). This mapping is as load-bearing as the `--json` envelope
//! shape (`output.rs`) — a script depends on it, so changing a code is a
//! compatibility break, not a refactor.

use crate::backend::BackendError;

pub const OK: i32 = 0;
/// A framing/connection/reply failure not covered by a more specific code
/// below — the CLI equivalent of "an internal error occurred".
pub const IO: i32 = 1;
/// Bad arguments — the conventional Unix "usage error" code.
pub const USAGE: i32 = 2;
pub const APP_NOT_RUNNING: i32 = 3;
pub const VAULT_LOCKED: i32 = 4;
pub const CLI_DISABLED: i32 = 5;
pub const NOT_FOUND: i32 = 6;
/// A write into an excluded folder was refused (task 8) — distinct from
/// `NOT_FOUND` because nothing was ever missing, a destination was closed.
pub const FOLDER_EXCLUDED: i32 = 7;
/// The command socket's rate limit refused this request (task 10). Its own
/// code so a bulk script can tell "slow down and retry" apart from every
/// failure where retrying is pointless — and so it never has to guess from
/// a hang, which is the outcome this replaces.
pub const RATE_LIMITED: i32 = 8;
/// The device-local plain-file editor is off, so `open` refused (myne-md/myne#788).
/// Distinct from `CLI_DISABLED`: the CLI door can be open while the file
/// editor is not, and the switch that fixes it lives in Settings.
pub const PLAIN_FILE_OFF: i32 = 9;

/// Map a [`BackendError`] to its exit code. One arm per variant — a new
/// `BackendError` variant added without a matching arm here fails to
/// compile, which is the point (no silent fallthrough to a wrong code).
pub fn from_backend_error(err: &BackendError) -> i32 {
    match err {
        BackendError::AppNotRunning => APP_NOT_RUNNING,
        BackendError::VaultLocked => VAULT_LOCKED,
        BackendError::CliDisabled => CLI_DISABLED,
        BackendError::NotFound => NOT_FOUND,
        BackendError::FolderExcluded => FOLDER_EXCLUDED,
        BackendError::RateLimited => RATE_LIMITED,
        BackendError::PlainFileOff => PLAIN_FILE_OFF,
        BackendError::Io(_) => IO,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_backend_error_maps_to_a_distinct_code() {
        let cases = [
            (BackendError::AppNotRunning, APP_NOT_RUNNING),
            (BackendError::VaultLocked, VAULT_LOCKED),
            (BackendError::CliDisabled, CLI_DISABLED),
            (BackendError::NotFound, NOT_FOUND),
            (BackendError::FolderExcluded, FOLDER_EXCLUDED),
            (BackendError::RateLimited, RATE_LIMITED),
            (BackendError::PlainFileOff, PLAIN_FILE_OFF),
            (BackendError::Io("x".into()), IO),
        ];
        let mut seen = std::collections::HashSet::new();
        for (err, expected) in cases {
            assert_eq!(from_backend_error(&err), expected);
            assert!(seen.insert(expected), "exit code {expected} used twice");
        }
        assert!(!seen.contains(&OK), "no BackendError may map to OK");
        assert!(!seen.contains(&USAGE), "USAGE is a CLI-arg-parse-only code");
    }
}
