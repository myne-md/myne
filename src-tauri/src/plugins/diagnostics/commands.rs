//! IPC surface of the `diagnostics` plugin (myne-md/myne#860).
//!
//! Desktop-only. Every command resolves `app_config_dir` and delegates to a
//! pure `*_in` helper in `flag.rs` that takes its path directly, so the tests
//! need no Tauri runtime (`src-tauri/AGENTS.md` plugin pattern).
//!
//! SEVEN commands ship in total: the switch pair, the crash record pair, the
//! reveal action, the manifest and the report writer. This file deliberately
//! carries NO count in prose: it said "two commands today" and stayed that way
//! while four more landed, which is the drift a number in prose always has. The
//! roster that has to agree is `build.rs` and
//! `permissions/diagnostics/default.toml`, and nothing verifies that they do.

use super::flag::{self, DiagnosticLogFlagError};
use super::report::{self, ReportManifest};
use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use crate::logging::crash::{self, CrashState};
use crate::logging::sink::LogSink;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_opener::OpenerExt;

/// The plugin's one error surface.
///
/// One closed arm today, because the switch has exactly one way to fail: a
/// filesystem error on the flag file or on resolving its directory. It is a
/// separate type from [`DiagnosticLogFlagError`] so the command signatures stay
/// uniform across the commands later tasks add, without the flag module having
/// to grow arms that are not its business.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, thiserror::Error)]
#[serde(tag = "kind", content = "detail")]
pub enum DiagnosticLogError {
    /// Filesystem error on the flag file or on resolving its directory.
    #[error("filesystem error on the diagnostic-log flag")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },
}

fn flag_to_diagnostic(error: DiagnosticLogFlagError) -> DiagnosticLogError {
    match error {
        DiagnosticLogFlagError::Io { io_error_kind } => DiagnosticLogError::Io { io_error_kind },
    }
}

fn config_dir<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, DiagnosticLogError> {
    app.path()
        .app_config_dir()
        .map_err(|_| DiagnosticLogError::Io {
            io_error_kind: IoFailureKind::Other,
        })
}

/// Whether this device writes a diagnostic log.
///
/// Answers `false` when the flag file is absent, and `false` when it is
/// present but untrusted; see `flag::read_flag`. A caller never has to
/// distinguish "off" from "unreadable", because both mean no log is written.
///
/// This is the remote-control baseline: it is what is true **on disk**. While
/// the process is running the sink holds its own copy, so a caller that wants
/// the live state reads the sink's flag rather than re-reading the file.
#[tauri::command]
pub async fn diagnostic_log_enabled_get<R: Runtime>(
    app: AppHandle<R>,
) -> Result<bool, DiagnosticLogError> {
    let path = flag::flag_path_in(&config_dir(&app)?);
    Ok(flag::read_flag(&path))
}

/// Turn the diagnostic log on or off for this device.
///
/// Persists the choice atomically, then applies it to the running sink so the
/// switch takes effect without a restart. Turning it **off** is also the erase
/// action: the sink drops its handle and the log files go in the same call,
/// because a deferred erase loses to a kill.
///
/// **The flag is written first, and the order is deliberate.** If the erase then
/// fails, the outcome is "off, with a residue the surface reports as an error",
/// which fails toward the privacy-relevant direction. Erasing first would leave
/// the toggle ON after a failed erase, which fails the other way.
///
/// The crash record is deliberately not erased; see `crate::logging::crash`.
///
/// Device-local and never synced: the file is not a `vault.prefs` field, so no
/// other device hears about this choice and no vault needs to be unlocked to
/// make it.
#[tauri::command]
pub async fn diagnostic_log_enabled_set<R: Runtime>(
    app: AppHandle<R>,
    sink: State<'_, Arc<LogSink>>,
    enabled: bool,
) -> Result<(), DiagnosticLogError> {
    let path = flag::flag_path_in(&config_dir(&app)?);
    flag::write_flag(&path, enabled).map_err(flag_to_diagnostic)?;
    sink.set_enabled(enabled);
    if !enabled {
        sink.erase_log_files().map_err(|e| DiagnosticLogError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        })?;
    }
    Ok(())
}

/// The crash record's presence and date, or `None` when there is none.
///
/// Read from the process-wide sink's directory rather than a freshly resolved
/// one, so the surface and the writer can never disagree about where the record
/// lives.
#[tauri::command]
pub async fn crash_record_state(
    sink: State<'_, Arc<LogSink>>,
) -> Result<Option<CrashState>, DiagnosticLogError> {
    Ok(crash::read_state(sink.dir()))
}

/// Delete the crash record. Absent is success, because the caller's intent is
/// "no record".
///
/// Offered because privacy requires a no-consent artefact's existence to be
/// visible and its lifetime bounded; the report bundle clears it too, once a
/// report that included it has been written.
#[tauri::command]
pub async fn crash_record_clear(sink: State<'_, Arc<LogSink>>) -> Result<(), DiagnosticLogError> {
    crash::clear(sink.dir()).map_err(|e| DiagnosticLogError::Io {
        io_error_kind: from_io_error_kind(e.kind()),
    })
}

/// Open the log directory in the platform's file manager.
///
/// **The path is resolved host-side and never crosses IPC.** That is why the
/// command takes no argument at all, and why `opener:allow-open-path`'s scope
/// list is left exactly as it is: that grant takes its path from page context, so
/// widening it would hand the WebView the choice of what to open. Here the
/// WebView chooses only *whether*.
///
/// The directory is created first, because the honest answer to "reveal the
/// logs" on a machine that has not written one yet is an empty folder rather than
/// an error.
#[tauri::command]
pub async fn reveal_logs_folder<R: Runtime>(
    app: AppHandle<R>,
    sink: State<'_, Arc<LogSink>>,
) -> Result<(), DiagnosticLogError> {
    let dir = sink.dir().to_path_buf();
    crate::logging::sink::prepare_dir(&dir).map_err(|e| DiagnosticLogError::Io {
        io_error_kind: from_io_error_kind(e.kind()),
    })?;
    app.opener()
        .reveal_item_in_dir(&dir)
        .map_err(|_| DiagnosticLogError::Io {
            io_error_kind: IoFailureKind::Other,
        })
}

/// What a saved report would contain, so the surface can say so first.
#[tauri::command]
pub async fn report_manifest(
    sink: State<'_, Arc<LogSink>>,
) -> Result<ReportManifest, DiagnosticLogError> {
    Ok(report::manifest(&sink))
}

/// Write the report bundle to a destination the user chose in the OS dialog.
///
/// `block` is the nine-field block as the surface renders it. It travels inbound
/// because the host does not hold those fields (three of them are Vite defines
/// compiled into the WebView bundle), and it is the block the user can already
/// read on screen, so nothing leaves that they have not seen.
///
/// This is TB3's user-initiated plaintext-egress exception, the same one the
/// export commands use. On success it clears the crash record if the bundle
/// included one, which is the bounded lifetime privacy asks of a no-consent
/// artefact; a save that found no record clears nothing.
#[tauri::command]
pub async fn save_report(
    sink: State<'_, Arc<LogSink>>,
    block: String,
    destination: String,
) -> Result<(), DiagnosticLogError> {
    let io = |e: std::io::Error| DiagnosticLogError::Io {
        io_error_kind: from_io_error_kind(e.kind()),
    };
    let included_crash =
        report::write_bundle(&block, &sink, &PathBuf::from(destination)).map_err(io)?;
    if included_crash {
        crash::clear(sink.dir()).map_err(io)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use myne_core::test_support::ScopedTempDir;

    #[test]
    fn the_command_pair_delegates_to_the_pure_flag_helpers() {
        // The commands themselves need a Tauri runtime, which a unit test has
        // not got; what a test CAN pin is that the two command bodies are thin
        // wrappers over the pure helpers, by exercising those helpers through
        // the same path shape the commands resolve. The Tauri half is covered
        // by the E2E scenario, where a real invoke crosses the ACL.
        let dir = ScopedTempDir::new("diagnostics-commands-thin").expect("tempdir");
        let path = flag::flag_path_in(dir.path());

        assert!(!flag::read_flag(&path), "off before anything is written");
        flag::write_flag(&path, true).expect("set on");
        assert!(flag::read_flag(&path), "on after the setter");
    }

    #[test]
    fn the_error_mapping_keeps_the_closed_enum() {
        // The fold exists so the command signatures stay uniform across later
        // tasks. Pinning it here keeps a future second arm from being dropped
        // silently by a `match` that grew an unreachable branch.
        let mapped = flag_to_diagnostic(DiagnosticLogFlagError::Io {
            io_error_kind: IoFailureKind::PermissionDenied,
        });
        assert_eq!(
            mapped,
            DiagnosticLogError::Io {
                io_error_kind: IoFailureKind::PermissionDenied
            }
        );
    }
}
