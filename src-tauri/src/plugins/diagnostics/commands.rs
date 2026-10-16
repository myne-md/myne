//! IPC surface of the `diagnostics` plugin (myne-md/myne#860).
//!
//! Desktop-only. Every command resolves `app_config_dir` and delegates to a
//! pure `*_in` helper in `flag.rs` that takes its path directly, so the tests
//! need no Tauri runtime (`src-tauri/AGENTS.md` plugin pattern).
//!
//! SEVEN commands ship in total: the switch pair, the crash record pair, the
//! reveal action, the manifest and the report writer.
//!
//! Prose carries no count and no tense here on purpose: this doc said "two
//! commands today" for as long as it took four more to land, which is the drift
//! a number in prose always has. The roster that has to agree is `build.rs`'s
//! `InlinedPlugin::commands` and `permissions/diagnostics/default.toml`, and
//! **nothing verifies that they do**: the mobile client's lockstep is checked by
//! `scripts/check-mobile-plugin-acl.mjs`, and the desktop equivalent is not
//! covered, which is stated here rather than implied by a green tick.

use super::flag::{self, DiagnosticLogFlagError};
use super::report::{self, ReportManifest};
use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use crate::logging::crash::{self, CrashState};
use crate::logging::sink::LogSink;
use std::path::Path;
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
    /// The report destination is unusable, or resolves inside the app data
    /// directory (which holds `vaults/`).
    ///
    /// Its own arm rather than `Io { Other }` because it is a REFUSAL, not a
    /// filesystem failure: the surface can say "that location is not allowed"
    /// instead of "the write failed", and the distinction is what a page that
    /// skipped the save dialog runs into.
    #[error("the report destination is not usable")]
    InvalidDestination,
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
/// the toggle ON after a failed erase, which fails the other way. The residue is
/// also what `crate::logging::init` reconciles on the next start, so a failure
/// here is retried rather than merely reported.
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
pub async fn save_report<R: Runtime>(
    app: AppHandle<R>,
    sink: State<'_, Arc<LogSink>>,
    block: String,
    destination: String,
) -> Result<(), DiagnosticLogError> {
    let io = |e: std::io::Error| DiagnosticLogError::Io {
        io_error_kind: from_io_error_kind(e.kind()),
    };
    // Every host-resolved store this feature owns, not only the vault tree:
    // `app_log_dir` and `app_config_dir` are different directories from
    // `app_data_dir` on macOS and Windows, so a destination inside the log
    // directory passes a vault-only check and then overwrites the live log or
    // the crash record, and one inside the config directory overwrites the flag
    // (myne#860 review).
    let guarded: Vec<Result<PathBuf, ()>> = vec![
        app.path().app_data_dir().map_err(|_| ()),
        app.path().app_log_dir().map_err(|_| ()),
        app.path().app_config_dir().map_err(|_| ()),
    ];
    let destination = PathBuf::from(destination);
    validate_report_destination(&destination, &guarded)?;
    let included_crash = report::write_bundle(&block, &sink, &destination).map_err(io)?;
    if included_crash {
        crash::clear(sink.dir()).map_err(io)?;
    }
    Ok(())
}

/// Reject a destination that is unusable, or that resolves inside any of the
/// host-resolved stores this feature writes to.
///
/// **The load-bearing half of the report write.** `destination` is
/// WebView-supplied and the writer renames over an existing path, so without
/// this check a page that skipped the save dialog could replace `vault.meta` or
/// a `.myn` blob, or overwrite the diagnostic log, the crash record or the
/// switch file itself. A caller with page authority is not evidence that the
/// user chose the path, which is the mistake the removed `fs` scope made and
/// that `secret_export::validate_secret_destination` and
/// `export::validate_destination` both re-validate against for this exact
/// reason.
///
/// **It fails CLOSED on an unresolved root**, like those two and unlike the
/// first version of this predicate: an `Err` from a path resolver means the
/// containment half cannot be evaluated, and a guard that disables itself in the
/// one state where it is still needed is not a guard. A root that is resolved
/// but cannot be canonicalized is treated the same way, because a comparison
/// against a path that does not exist cannot prove anything.
///
/// Pure and testable with temp roots, so the refusal is pinned by a test rather
/// than by the dialog's good behaviour.
fn validate_report_destination(
    destination: &Path,
    guarded_roots: &[Result<PathBuf, ()>],
) -> Result<(), DiagnosticLogError> {
    // Parent must exist and be a directory, which also excludes an
    // empty or filename-less path.
    if !myne_core::paths::parent_dir_ok(destination) {
        return Err(DiagnosticLogError::InvalidDestination);
    }
    // Canonicalize the parent (resolving symlinks and `..`) BEFORE the
    // containment test, or a path that reaches a guarded root through either
    // would pass a lexical comparison.
    let canon_parent = destination
        .parent()
        .and_then(|p| p.canonicalize().ok())
        .ok_or(DiagnosticLogError::InvalidDestination)?;
    for root in guarded_roots {
        let root = root
            .as_ref()
            .map_err(|_| DiagnosticLogError::InvalidDestination)?;
        let canon_root = root
            .canonicalize()
            .map_err(|_| DiagnosticLogError::InvalidDestination)?;
        if canon_parent.starts_with(&canon_root) {
            return Err(DiagnosticLogError::InvalidDestination);
        }
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

    #[test]
    fn a_destination_inside_the_app_data_vault_tree_is_refused() {
        // The arbitrary-write refusal. A page that skipped the save dialog can
        // still call `save_report`, and the writer renames over an existing
        // path, so this predicate is what stands between a compromised WebView
        // and the user's notes. Mirrors
        // `secret_export::rejects_a_destination_inside_the_app_data_vault_tree`.
        let app_data = ScopedTempDir::new("diagnostics-refuse-app-data").expect("tempdir");
        let vaults = app_data.path().join("vaults").join("abc");
        std::fs::create_dir_all(&vaults).expect("vault tree");
        let guarded = [Ok(app_data.path().to_path_buf())];

        let inside = vaults.join("vault.meta");
        assert_eq!(
            validate_report_destination(&inside, &guarded),
            Err(DiagnosticLogError::InvalidDestination),
            "a destination inside app_data must be refused"
        );

        // A traversal that REACHES app_data has to be refused too, which is the
        // half a lexical comparison misses. The parent is canonicalized first
        // for exactly this case.
        let through_dotdot = app_data
            .path()
            .join("..")
            .join(app_data.path().file_name().expect("tempdir has a name"));
        let reached = through_dotdot.join("vaults").join("abc").join("vault.meta");
        assert_eq!(
            validate_report_destination(&reached, &guarded),
            Err(DiagnosticLogError::InvalidDestination),
            "a destination that reaches app_data through `..` must be refused"
        );
    }

    #[test]
    fn a_destination_inside_the_log_or_config_directory_is_refused() {
        // The stores this feature OWNS are guarded too, and they are the half a
        // vault-only check misses: `app_log_dir` and `app_config_dir` are
        // different directories from `app_data_dir` on macOS and Windows, so a
        // destination of `<log dir>/crash.log` used to pass the check and then
        // overwrite the crash record, and one of
        // `<config dir>/diagnostic-log.json` overwrote the switch itself
        // (myne#860 review).
        let app_data = ScopedTempDir::new("diagnostics-refuse-app-data-2").expect("tempdir");
        let log_dir = ScopedTempDir::new("diagnostics-refuse-log-dir").expect("tempdir");
        let config_dir = ScopedTempDir::new("diagnostics-refuse-config-dir").expect("tempdir");
        let guarded = [
            Ok(app_data.path().to_path_buf()),
            Ok(log_dir.path().to_path_buf()),
            Ok(config_dir.path().to_path_buf()),
        ];

        for (root, name) in [
            (log_dir.path(), "crash.log"),
            (log_dir.path(), "myne.log"),
            (config_dir.path(), "diagnostic-log.json"),
        ] {
            assert_eq!(
                validate_report_destination(&root.join(name), &guarded),
                Err(DiagnosticLogError::InvalidDestination),
                "{name} lives in a guarded store and must be refused"
            );
        }
    }

    #[test]
    fn an_unresolved_root_refuses_rather_than_skipping_the_check() {
        // The fail-open half, and it is why the signature takes a Result rather
        // than an Option: a path resolver that could not answer means the
        // containment test cannot be evaluated, and the first version of this
        // predicate read that as "nothing to compare against" and let the write
        // through with only the parent-directory rule left. The twins
        // (`secret_export`, `export`) fail closed here, and this now does too.
        let user_dir = ScopedTempDir::new("diagnostics-refuse-unresolved").expect("tempdir");
        let destination = user_dir.path().join("myne-report.txt");

        assert_eq!(
            validate_report_destination(&destination, &[Err(())]),
            Err(DiagnosticLogError::InvalidDestination),
            "an unresolved guarded root must refuse, not skip"
        );
    }

    #[test]
    fn a_guarded_root_that_cannot_be_canonicalized_refuses() {
        // The same direction one step later: a root that does not exist cannot
        // be compared against, and a comparison that cannot be made must not
        // pass.
        let user_dir = ScopedTempDir::new("diagnostics-refuse-uncanonical").expect("tempdir");
        let missing_root = user_dir.path().join("not-created");
        let elsewhere = ScopedTempDir::new("diagnostics-refuse-uncanonical-out").expect("tempdir");

        assert_eq!(
            validate_report_destination(
                &elsewhere.path().join("myne-report.txt"),
                &[Ok(missing_root)]
            ),
            Err(DiagnosticLogError::InvalidDestination)
        );
    }

    #[test]
    fn an_ordinary_user_destination_is_accepted() {
        // The non-vacuity half: the refusals above have to be refusals of THAT
        // shape rather than of every path there is.
        let user_dir = ScopedTempDir::new("diagnostics-accept-user-dir").expect("tempdir");
        let elsewhere = ScopedTempDir::new("diagnostics-accept-app-data").expect("tempdir");
        let destination = user_dir.path().join("myne-report.txt");

        assert_eq!(
            validate_report_destination(&destination, &[Ok(elsewhere.path().to_path_buf())]),
            Ok(()),
            "a destination outside every guarded root is what the dialog hands us"
        );
    }

    #[test]
    fn a_destination_with_no_parent_directory_is_refused() {
        let dir = ScopedTempDir::new("diagnostics-refuse-no-parent").expect("tempdir");
        let missing = dir.path().join("gone").join("report.txt");

        assert_eq!(
            validate_report_destination(&missing, &[Ok(dir.path().to_path_buf())]),
            Err(DiagnosticLogError::InvalidDestination)
        );
    }
}
