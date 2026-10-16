//! The one crash record the desktop leaves behind (myne-md/myne#860).
//!
//! # Why this exists while the log toggle is off
//!
//! The feature's rule is "the file sink is inert while the toggle is off", and
//! this is its one admitted exception. The panic hook is **host code, not a
//! `tracing` call site**, so no emitted event can reach this file, and its
//! payload is a closed set of scalars. That is what makes the exception
//! checkable by reading one function instead of being an argument from value: a
//! panic that leaves no trace is the case where a report is most needed, and
//! every other candidate for the exception fails the "not a call site" test.
//!
//! # What is deliberately absent
//!
//! **No panic message and no payload.** A panic message is arbitrary text from
//! arbitrary code, so an `expect("failed to decode note {id}")` carries a note
//! id and an `unwrap` on a parse can carry the bytes that failed to parse. Both
//! are on the DENY list in `src-tauri/AGENTS.md`, and the surface this record
//! reaches is one the user is invited to send on. The location is a
//! **compiled-in source path** (`core/src/...`), which cannot contain the user's
//! directory layout, and it is what a maintainer can act on. Same reasoning, and
//! the same shape, as `design-notes/ops/0366`'s panic hook for the web build.
//!
//! # Bounded, visible, and cleared when its purpose is served
//!
//! One file maximum, truncated by the next crash rather than appended to, so it
//! never grows into a history. Privacy does not require deleting a no-consent
//! artefact whose content is a defect fingerprint, but it does require that its
//! existence is not hidden and that its lifetime is bounded, so the surface
//! always shows the record's date and offers Delete. A successful report that
//! included it clears it (the bundle task owns that call), because its purpose
//! is then served.
//!
//! # It must never panic
//!
//! A panic inside a panic hook is a loop. Every failure here is swallowed.

use std::path::{Path, PathBuf};
use std::sync::Once;
use std::time::{SystemTime, UNIX_EPOCH};

/// The crash record's file name inside the log directory.
pub const CRASH_FILE_NAME: &str = "crash.log";

/// The record as the surface reads it: when, and nothing else it can act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct CrashState {
    /// When the record was written, in whole seconds since the Unix epoch.
    ///
    /// One timestamp per crash, not a usage series: the surface needs to say
    /// "a crash record from \<date\>", and nothing here is finer than a crash.
    pub at_epoch_seconds: u64,
}

/// The record's bytes, for a given panic location.
///
/// Pure, so a test can assert the payload discipline without staging a real
/// panic: this is the function that decides nothing sensitive is in the file.
pub fn record_bytes(location: &str) -> Vec<u8> {
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!(
        "# myne crash record\n\
         # version: {}\n\
         # platform: {}\n\
         # at_epoch_seconds: {at}\n\
         # location: {location}\n",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
    )
    .into_bytes()
}

/// Install the panic hook, capturing the log directory.
///
/// Idempotent: a second call is a no-op, so a test harness or a host that
/// initialises the app twice cannot chain two hooks. The previous hook is
/// preserved and still runs, so a panic keeps printing its message to the
/// terminal exactly as it did before.
pub fn install(log_dir: PathBuf) {
    static INSTALLED: Once = Once::new();
    INSTALLED.call_once(move || {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            // The location is `file:line:col`, a compiled-in source path. A
            // panic with no location still writes a record: "something crashed
            // and nothing could say where" is more useful than a silent disk.
            let location = match info.location() {
                Some(location) => workspace_relative(location.file(), location.line()),
                None => "unknown".to_string(),
            };
            let _ = write_record(&log_dir, &location);
            previous(info);
        }));
    });
}

/// `file:line`, cut back to the workspace-relative tail.
///
/// `Location::file()` is the path rustc recorded, which for a panic inside a
/// DEPENDENCY is the build machine's absolute registry path
/// (`/Users/<builder>/.cargo/registry/src/…`). That is not the user's own path,
/// so it is not the DENY list's "full filesystem path", but it is an at-rest
/// disclosure this record has no reason to make and the user is invited to
/// publish the file.
///
/// The workspace root is `CARGO_MANIFEST_DIR`'s parent, compiled in, so a
/// first-party path strips to the shape a maintainer greps
/// (`core/src/plugins/notes/commands.rs:412`) without any guess about where the
/// repository sits on the build machine. A path outside it is a dependency, and
/// the registry prefix is dropped at `/.cargo/`.
fn workspace_relative(file: &str, line: u32) -> String {
    let root = workspace_root();
    let root = root.trim_end_matches(['/', '\\']);
    if !root.is_empty() {
        // The separator is part of the prefix, so a path under a SIBLING
        // directory whose name begins with the root's name cannot strip to a
        // location that does not exist: `/Users/x/agent-tooling/…` against root
        // `/Users/x/myne` used to come back as `-agents/…`, and this record's
        // whole purpose is to name a greppable location (myne#860 review).
        for separator in ['/', '\\'] {
            let prefix = format!("{root}{separator}");
            if let Some(tail) = file.strip_prefix(&prefix) {
                if !tail.is_empty() {
                    return format!("{tail}:{line}");
                }
            }
        }
    }
    let trimmed = file
        .rfind("/.cargo/")
        .map(|at| &file[at + "/.cargo/".len()..])
        .unwrap_or(file);
    format!("{trimmed}:{line}")
}

/// The repository root, as compiled into this binary.
///
/// `<this crate's manifest dir>/..`, which is the worktree the binary was built
/// in. It is the same string on any machine the binary runs on, because it is
/// baked in at compile time, so stripping it is deterministic rather than a
/// guess at where the user keeps things.
fn workspace_root() -> &'static str {
    static ROOT: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    ROOT.get_or_init(|| {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    })
}

/// Write the record, truncating the previous one. Best effort.
fn write_record(log_dir: &Path, location: &str) -> std::io::Result<()> {
    crate::logging::sink::prepare_dir(log_dir)?;
    // `truncate(true)` is the "one file maximum" rule: the next crash replaces
    // this one rather than appending to it. The mode is set at CREATE for the
    // same reason the log file's is: `0600` carries no group or other bits for
    // umask to strip, and a chmod afterwards leaves a window.
    let mut options = std::fs::OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(log_dir.join(CRASH_FILE_NAME))?;
    std::io::Write::write_all(&mut file, &record_bytes(location))
}

/// The record's state, or `None` when there is no record.
///
/// A malformed record reads as present with an unknown date rather than as
/// absent: saying "there was a crash and the file is unreadable" is the honest
/// answer, and hiding it would make the surface lie about the residue.
pub fn read_state(log_dir: &Path) -> Option<CrashState> {
    let raw = match std::fs::read_to_string(log_dir.join(CRASH_FILE_NAME)) {
        Ok(raw) => raw,
        // ABSENT is the only "no record" answer. A present-but-unreadable file
        // is reported as present with an unknown date, which is the sentence
        // above taken literally and is why `at_epoch_seconds` may be `0`. Folding
        // it into `None` would hide a no-consent artefact from the surface AND
        // from the report that would otherwise clear it, so its lifetime would
        // be unbounded, which is the one thing a no-consent record may not be.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(_) => {
            return Some(CrashState {
                at_epoch_seconds: 0,
            })
        }
    };
    let at_epoch_seconds = raw
        .lines()
        .find_map(|line| line.strip_prefix("# at_epoch_seconds: "))
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(0);
    Some(CrashState { at_epoch_seconds })
}

/// Delete the record. Absent is success: the caller's intent is "no record".
pub fn clear(log_dir: &Path) -> std::io::Result<()> {
    let path = log_dir.join(CRASH_FILE_NAME);
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use myne_core::test_support::ScopedTempDir;

    #[test]
    fn a_real_panic_writes_the_record_even_with_logging_off() {
        // The feature's one admitted exception, end to end: the hook is host
        // code, so it writes whether or not the sink is enabled. The sink is not
        // even constructed here, which is the point: nothing about this path
        // consults the flag.
        //
        // `install` is process-global and once-guarded, so this is the single
        // installer for the test binary; later tests in this module that panic
        // would land in the same directory, which is harmless.
        let dir = ScopedTempDir::new("crash-record-hook").expect("tempdir");
        install(dir.path().to_path_buf());

        let handle = std::thread::spawn(|| {
            panic!("a test panic whose message must not reach the record");
        });
        // The panic is expected; swallow it so the hook is what is under test.
        assert!(handle.join().is_err());

        let raw = std::fs::read_to_string(dir.path().join(CRASH_FILE_NAME))
            .expect("the hook wrote a record");
        assert!(
            raw.contains("# location: "),
            "a record names where the panic happened: {raw:?}"
        );
        assert!(
            !raw.contains("a test panic whose message must not reach the record"),
            "the panic MESSAGE must never be written: it is arbitrary text that can \
             carry a note id or a note body"
        );
    }

    #[test]
    fn a_dependency_panic_cannot_carry_the_build_machines_path_into_the_record() {
        // A panic inside a dependency records a REGISTRY path, and the surface
        // invites the user to attach this file to a public issue. The tail is
        // kept because it is what a maintainer acts on.
        let built = workspace_relative(
            "/Users/somebody/.cargo/registry/src/index.crates.io-6f17d22bba15001f/tokio-1.44.0/src/runtime/task.rs",
            91,
        );
        assert_eq!(
            built,
            "registry/src/index.crates.io-6f17d22bba15001f/tokio-1.44.0/src/runtime/task.rs:91"
        );
        assert!(!built.contains("/Users/somebody"));

        // A first-party panic keeps its workspace-relative shape, which is what
        // the module doc has always claimed the payload holds. Built from the
        // REAL compiled-in root, so this exercises the stripping rather than a
        // fixture that happens to look like it.
        let first_party = format!(
            "{}/core/src/plugins/notes/commands.rs",
            workspace_root().trim_end_matches('/')
        );
        assert_eq!(
            workspace_relative(&first_party, 412),
            "core/src/plugins/notes/commands.rs:412"
        );
        // A path with neither marker is passed through rather than mangled.
        assert_eq!(workspace_relative("main.rs", 1), "main.rs:1");
    }

    #[test]
    fn the_record_carries_the_location_the_version_and_the_platform_and_no_message() {
        let raw = String::from_utf8(record_bytes("core/src/plugins/notes/commands.rs:412"))
            .expect("utf8");
        assert!(raw.contains("# location: core/src/plugins/notes/commands.rs:412\n"));
        assert!(raw.contains(&format!("# version: {}\n", env!("CARGO_PKG_VERSION"))));
        assert!(raw.contains(&format!("# platform: {}\n", std::env::consts::OS)));
        // The payload discipline, asserted as an absence: no field here can
        // hold a panic message, so none is written.
        assert!(
            !raw.contains("message"),
            "a panic message can carry a note id or a note body; none is written"
        );
    }

    #[test]
    fn the_record_round_trips_and_reports_its_date() {
        let dir = ScopedTempDir::new("crash-record-roundtrip").expect("tempdir");
        assert!(read_state(dir.path()).is_none(), "no record yet");

        write_record(dir.path(), "src-tauri/src/lib.rs:1").expect("write");

        let state = read_state(dir.path()).expect("a record now exists");
        assert!(
            state.at_epoch_seconds > 1_600_000_000,
            "the date is a real wall-clock second, not a placeholder zero"
        );
    }

    #[test]
    fn a_second_crash_replaces_the_first_rather_than_appending() {
        let dir = ScopedTempDir::new("crash-record-bounded").expect("tempdir");
        write_record(dir.path(), "first.rs:1").expect("first");
        write_record(dir.path(), "second.rs:2").expect("second");

        let raw = std::fs::read_to_string(dir.path().join(CRASH_FILE_NAME)).expect("read");
        assert!(raw.contains("second.rs:2"));
        assert!(
            !raw.contains("first.rs:1"),
            "one file maximum: the next crash overwrites, it does not accumulate a history"
        );
        assert_eq!(raw.matches("# myne crash record").count(), 1);
    }

    #[test]
    fn clearing_is_idempotent() {
        let dir = ScopedTempDir::new("crash-record-clear").expect("tempdir");
        write_record(dir.path(), "a.rs:1").expect("write");
        clear(dir.path()).expect("clear");
        assert!(read_state(dir.path()).is_none());
        clear(dir.path()).expect("clearing an absent record is success, not an error");
    }

    #[test]
    fn a_malformed_record_reads_as_present_with_an_unknown_date() {
        // Hiding it would make the surface claim there is no residue when there
        // is one; a zero date says "present, unreadable".
        let dir = ScopedTempDir::new("crash-record-malformed").expect("tempdir");
        std::fs::write(dir.path().join(CRASH_FILE_NAME), b"not a record").expect("seed");

        let state = read_state(dir.path()).expect("present");
        assert_eq!(state.at_epoch_seconds, 0);
    }
}
