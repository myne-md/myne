//! The one report file the bug-report surface can save (myne-md/myne#860).
//!
//! # What it is, and why one file rather than an archive
//!
//! A user with a bug wants ONE artefact to attach to a thread that says which
//! build broke, what the app was doing, and whether it crashed. The nine-field
//! block answers the first, the log answers the second, and the crash record
//! answers the third, so the bundle is those three in one plain-text file. A zip
//! would need a dependency (this repository treats a new dependency as a
//! security decision) and would put the content behind a step a maintainer has
//! to take before reading it, which is the opposite of what a support artefact
//! needs.
//!
//! # This is a plaintext egress, and it is the user's own act
//!
//! `docs/threat-model.md` TB3 already carries the exception: a user-initiated
//! export to a destination the user chose. The bundle is exactly that, so it
//! goes through the OS save dialog and the unclobbered writer (a fixed
//! `<target>.tmp` name is only safe INSIDE the vault), and the surface shows
//! what the file will contain before it is written. Nothing is transmitted: the
//! file exists only where the user put it, and Myne makes no request.
//!
//! # The crash record is cleared when its purpose is served
//!
//! A successful save that INCLUDED the record clears it, which is the manual
//! `Delete`'s other half. A save that did not include it (there was none) clears
//! nothing. That is the bounded lifetime privacy asks of a no-consent artefact,
//! and it is why `write_bundle` reports which happened rather than returning
//! `()`.

use crate::logging::crash::CRASH_FILE_NAME;
use crate::logging::sink::{LogSink, LOG_FILE_NAME};
use std::path::Path;

/// What the surface tells the user the file will contain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct ReportManifest {
    /// How many log files are in the bundle, the active one included.
    pub log_files: usize,
    /// Their total size in bytes, so the surface can say how big the file is.
    pub total_bytes: u64,
    /// The crash record's date, or `None` when there is no record to include.
    pub crash_at_epoch_seconds: Option<u64>,
}

/// The log files present, newest first: the active one then its rotations.
pub fn log_files(sink: &LogSink) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let active = sink.dir().join(LOG_FILE_NAME);
    if active.exists() {
        out.push(active);
    }
    let mut index = 1;
    loop {
        let rotated = sink.dir().join(format!("{LOG_FILE_NAME}.{index}"));
        if !rotated.exists() {
            break;
        }
        out.push(rotated);
        index += 1;
    }
    out
}

/// The manifest the surface shows before anything is written.
pub fn manifest(sink: &LogSink) -> ReportManifest {
    let files = log_files(sink);
    let total_bytes = files
        .iter()
        .filter_map(|path| std::fs::metadata(path).ok())
        .map(|meta| meta.len())
        .sum();
    ReportManifest {
        log_files: files.len(),
        total_bytes,
        crash_at_epoch_seconds: crate::logging::crash::read_state(sink.dir())
            .map(|state| state.at_epoch_seconds),
    }
}

/// The bundle's bytes: header, block, every log file, then the crash record.
///
/// Pure over the sink's directory, so a test can assert the assembly without a
/// save dialog. Reading a log file can fail (it rotated between the manifest and
/// the save); a file that cannot be read is named as unreadable rather than
/// silently dropped, because a report that quietly omits half the log is worse
/// than one that says which half it lost.
pub fn build_bundle(block: &str, sink: &LogSink) -> (Vec<u8>, bool) {
    let mut out = String::new();
    out.push_str("# myne diagnostic report\n");
    out.push_str(&format!(
        "# version: {}\n# platform: {}\n",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
    ));
    out.push_str("\n## diagnostics block\n\n");
    out.push_str(block.trim_end());
    out.push('\n');

    let files = log_files(sink);
    if files.is_empty() {
        out.push_str("\n## log\n\n(no log was written: logging is off, or nothing was recorded)\n");
    }
    for path in &files {
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| LOG_FILE_NAME.to_string());
        out.push_str(&format!("\n## log: {name}\n\n"));
        match std::fs::read_to_string(path) {
            Ok(body) => out.push_str(&body),
            Err(_) => out.push_str("(this log file could not be read)\n"),
        }
    }

    let included_crash = crate::logging::crash::read_state(sink.dir()).is_some();
    out.push_str("\n## crash record\n\n");
    if included_crash {
        match std::fs::read_to_string(sink.dir().join(CRASH_FILE_NAME)) {
            Ok(body) => out.push_str(&body),
            Err(_) => out.push_str("(the crash record could not be read)\n"),
        }
    } else {
        out.push_str("(none)\n");
    }

    (out.into_bytes(), included_crash)
}

/// Write the bundle to `destination`, returning whether it included the record.
///
/// `atomic_write_unclobbered_private` rather than a plain write: the destination
/// is a user-chosen path, so the fixed `<target>.tmp` name of `atomic_write` is
/// unsafe there, and the report is plaintext diagnostics, so owner-only is the
/// right default until the user decides to send it.
pub fn write_bundle(block: &str, sink: &LogSink, destination: &Path) -> std::io::Result<bool> {
    let (bytes, included_crash) = build_bundle(block, sink);
    crate::atomic_write::atomic_write_unclobbered_private(destination, &bytes, true)?;
    Ok(included_crash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use myne_core::test_support::ScopedTempDir;

    fn sink_with_log_lines(dir: &Path) -> LogSink {
        let sink = LogSink::new(dir.to_path_buf(), true);
        sink.write_bytes(b"INFO myne_core: event=\"vault_unlocked\"\n");
        sink
    }

    #[test]
    fn the_manifest_counts_what_would_be_included() {
        let dir = ScopedTempDir::new("report-manifest").expect("tempdir");
        let sink = sink_with_log_lines(dir.path());

        let manifest = manifest(&sink);
        assert_eq!(manifest.log_files, 1);
        assert!(manifest.total_bytes > 0);
        assert_eq!(
            manifest.crash_at_epoch_seconds, None,
            "no record yet, and the surface must be able to say so"
        );
    }

    #[test]
    fn the_bundle_carries_the_block_every_log_file_and_the_absent_record_marker() {
        let dir = ScopedTempDir::new("report-bundle").expect("tempdir");
        let sink = sink_with_log_lines(dir.path());

        let (bytes, included_crash) = build_bundle("version: 0.10.0\nchannel: Stable", &sink);
        let bundle = String::from_utf8(bytes).expect("utf8");

        assert!(bundle.starts_with("# myne diagnostic report\n"));
        assert!(bundle.contains("## diagnostics block"));
        assert!(bundle.contains("version: 0.10.0"), "the block verbatim");
        assert!(bundle.contains("## log: myne.log"));
        assert!(
            bundle.contains("event=\"vault_unlocked\""),
            "the log's content"
        );
        assert!(bundle.contains("## crash record"));
        assert!(bundle.contains("(none)"));
        assert!(!included_crash, "nothing to clear when there was no record");
    }

    #[test]
    fn a_bundle_with_a_crash_record_reports_that_it_included_one() {
        let dir = ScopedTempDir::new("report-bundle-crash").expect("tempdir");
        let sink = sink_with_log_lines(dir.path());
        // Seeded through the real writer, so the bundle reads the shipped shape.
        crate::logging::crash::install(dir.path().to_path_buf());
        std::fs::write(
            dir.path().join(CRASH_FILE_NAME),
            crate::logging::crash::record_bytes("src-tauri/src/lib.rs:1"),
        )
        .expect("seed record");

        let (bytes, included_crash) = build_bundle("version: 0.10.0", &sink);
        let bundle = String::from_utf8(bytes).expect("utf8");

        assert!(
            included_crash,
            "the command clears the record on this answer"
        );
        assert!(bundle.contains("# location: src-tauri/src/lib.rs:1"));
    }

    #[test]
    fn the_bundle_says_no_log_was_written_rather_than_omitting_the_section() {
        let dir = ScopedTempDir::new("report-bundle-nolog").expect("tempdir");
        let sink = LogSink::new(dir.path().to_path_buf(), false);

        let (bytes, included_crash) = build_bundle("version: 0.10.0", &sink);
        let bundle = String::from_utf8(bytes).expect("utf8");

        assert!(bundle.contains("## log\n\n(no log was written"));
        assert!(!included_crash);
    }

    #[test]
    fn writing_the_bundle_lands_one_owner_only_file_at_the_destination() {
        let dir = ScopedTempDir::new("report-write").expect("tempdir");
        let sink = sink_with_log_lines(dir.path());
        let destination = dir.path().join("myne-report.txt");

        let included = write_bundle("version: 0.10.0", &sink, &destination).expect("write");

        assert!(!included);
        let body = std::fs::read_to_string(&destination).expect("read back");
        assert!(body.contains("## diagnostics block"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&destination)
                .expect("stat")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "plaintext diagnostics land owner-only");
        }
    }
}
