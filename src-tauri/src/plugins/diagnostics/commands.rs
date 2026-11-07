// SPDX-License-Identifier: AGPL-3.0
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
use super::measures::{self, VaultUsage};
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
/// One closed arm today, because every command here fails exactly one way: a
/// filesystem error on the flag file, on resolving its directory, on the
/// executable it hashes or on the vault directory it measures. It is a
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
    /// The report destination is unusable, or resolves inside one of the stores
    /// this feature owns: the app data directory (which holds `vaults/`), the
    /// log directory and the config directory.
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
    let destination = PathBuf::from(destination);
    if let Err(refusal) = validate_report_destination(&destination, &guarded_stores(&app)) {
        // The refusal is the load-bearing half of this path and the one failure a
        // page that skipped the save dialog runs into, so it is the one worth a
        // record. `kind` is the closed error enum: no path and no OS message.
        tracing::warn!(event = "diagnostic_report_refused", kind = ?refusal);
        return Err(refusal);
    }
    let captured = match report::write_bundle(&block, &sink, &destination) {
        Ok(captured) => captured,
        Err(e) => {
            // The report file that could not be written is the case where the
            // artefact the user wanted to send is itself the evidence, so this line
            // is the only trace the failure leaves that is not on their screen.
            let error = io(e);
            tracing::warn!(event = "diagnostic_report_failed", stage = "write", kind = ?error);
            return Err(error);
        }
    };
    // Whether a crash record rode along is the difference between "no crash" and
    // "the capture act lost it", which is the distinction the boolean this carries
    // was introduced for.
    let crash_record_included = captured.is_some();
    if let Some(captured) = captured {
        // Clear only when the record on disk is STILL the one whose bytes went
        // into the bundle. A panic landing between the read and this line would
        // otherwise be deleted having never been captured, which is the same
        // "the capture act must not be the deletion act" rule the boolean this
        // replaced was introduced for (myne#860 review).
        let still_the_captured_one =
            std::fs::read_to_string(sink.dir().join(crash::CRASH_FILE_NAME))
                .map(|now| now.as_bytes() == captured.as_slice())
                .unwrap_or(false);
        if still_the_captured_one {
            if let Err(e) = crash::clear(sink.dir()) {
                let error = io(e);
                tracing::warn!(
                    event = "diagnostic_report_failed",
                    stage = "clear_crash_record",
                    kind = ?error
                );
                return Err(error);
            }
        }
    }
    tracing::info!(event = "diagnostic_report_written", crash_record_included);
    Ok(())
}

/// The digest of the running build artefact (myne-md/myne#991).
///
/// The page cannot supply this: a bundle cannot contain the hash of its own
/// bytes, and the desktop client has no served bundle to fetch one from, so
/// `src/platform/build-info.ts` answers `null` there by construction. Hashing the
/// running executable is the reading that exists.
///
/// **What this value does not match.** An installer artefact (`.dmg`, `.deb`,
/// `AppImage`, `.msi`) hashes differently from the executable inside it, so this
/// digest is not the published one. It answers "same build as that other
/// report" and "did this binary change under an unchanged version string", which
/// is what the block is read for; the installer's own identity is the `version`
/// and `commit` lines beside it.
///
/// Cached for the life of the process. The read is a 64 KiB-at-a-time pass over
/// a file of tens of megabytes, the value cannot change while the executable is
/// the one running, and the panel is opened more than once: without the cache a
/// second visit to Settings pays the whole cost again. A failure is cached too,
/// so a build whose executable cannot be read does not re-read it per mount.
#[tauri::command]
pub async fn build_digest() -> Result<String, DiagnosticLogError> {
    // CPU/IO-bound over the whole bundle → off the async worker (the
    // attachments pattern): `crate::plugins::attachments::blocking_reads` states
    // the rule for reads that must be synchronous by construction, and this one
    // is not, so it belongs on a blocking worker rather than in the command.
    tokio::task::spawn_blocking(cached_digest)
        .await
        .map_err(|_| DiagnosticLogError::Io {
            io_error_kind: IoFailureKind::Other,
        })?
        .map_err(|e| DiagnosticLogError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        })
}

/// [`build_digest`]'s body, with the process-wide cache and the one trace line.
fn cached_digest() -> std::io::Result<String> {
    use std::sync::OnceLock;
    // `None` means "already failed", which is what stops a second attempt: the
    // reason is in the log line written when the first one ran.
    static CACHED: OnceLock<Option<String>> = OnceLock::new();
    let cached = CACHED.get_or_init(|| {
        std::env::current_exe()
            .and_then(|exe| measures::digest_of_file(&exe))
            .inspect_err(|e| {
                // `kind` is the closed enum: no path and no OS message, the same
                // rule every diagnostic line follows.
                tracing::warn!(event = "build_digest_failed", io_error_kind = ?e.kind());
            })
            .ok()
    });
    cached
        .clone()
        .ok_or_else(|| std::io::Error::other("the running executable could not be hashed"))
}

/// The active vault's on-disk footprint (myne-md/myne#991).
///
/// `navigator.storage.estimate()` answers about the WebView's own origin store,
/// which on desktop holds none of the vault: the notes live under
/// `<app_data_dir>/vaults/<id>/` as `.myn` files. So the page's own figure is a
/// true statement about the wrong thing, which is worse in a pasted block than no
/// line at all.
///
/// **A pure read, so it takes no auth permit and needs no unlocked vault.** The
/// block is built on the fail-closed screen as well as in Settings, and the
/// directory can be measured in both: what it reports is the size of sealed
/// blobs, never their content.
#[tauri::command]
pub async fn vault_usage<R: Runtime>(app: AppHandle<R>) -> Result<VaultUsage, DiagnosticLogError> {
    let dir = crate::paths::vault_dir_path(&app).map_err(|_| DiagnosticLogError::Io {
        io_error_kind: IoFailureKind::Other,
    })?;
    tokio::task::spawn_blocking(move || measures::usage_of_dir(&dir))
        .await
        .map_err(|_| DiagnosticLogError::Io {
            io_error_kind: IoFailureKind::Other,
        })
}

/// The host-resolved stores a report may never be written into.
///
/// **A named roster rather than an inline vector**, because the list is what
/// decides the refusal and an earlier revision built it at the call site, where
/// nothing tied it to anything: dropping one entry kept every test green
/// (myne#860 review). The log directory is a separate tree on EVERY platform, so
/// a destination inside it would overwrite the live log or the crash record; the
/// config directory is a separate tree from the data directory on Linux and the
/// SAME one on macOS and Windows, so it is the entry that guards the switch file
/// on Linux and is harmless elsewhere.
///
/// The same shape `ExportDir` uses on mobile and for the same reason: `resolve`
/// is an exhaustive match, so a variant cannot lack a resolver (E0004), and
/// [`GuardedStore::ALL`] is the hand-written roster a test can hold, which a type
/// cannot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GuardedStore {
    AppData,
    Log,
    Config,
}

impl GuardedStore {
    /// The roster, and the order the refusal walks it in.
    const ALL: [GuardedStore; 3] = [Self::AppData, Self::Log, Self::Config];

    /// The directory, or `Err` when the host cannot resolve it. An unresolved
    /// store is a refusal at the caller, never a skipped comparison.
    fn resolve<R: Runtime>(self, app: &AppHandle<R>) -> Result<PathBuf, ()> {
        let resolved = match self {
            Self::AppData => app.path().app_data_dir(),
            Self::Log => app.path().app_log_dir(),
            Self::Config => app.path().app_config_dir(),
        };
        resolved.map_err(|_| ())
    }
}

/// Every guarded store, in roster order.
fn guarded_stores<R: Runtime>(app: &AppHandle<R>) -> Vec<Result<PathBuf, ()>> {
    GuardedStore::ALL
        .iter()
        .map(|store| store.resolve(app))
        .collect()
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
/// against a path that does not exist cannot prove anything. The one exemption
/// is a root that does not exist YET (`NotFound`), stated where it is
/// implemented, in `myne-core`'s re-export of this predicate.
///
/// The predicate itself is `myne_format::dest_guard::containment_refused`,
/// reached here through `myne_core::paths` so this is no longer a third copy
/// with its own opinion about the failure arms.
///
/// Pure and testable with temp roots, so the refusal is pinned by a test rather
/// than by the dialog's good behaviour.
fn validate_report_destination(
    destination: &Path,
    guarded_roots: &[Result<PathBuf, ()>],
) -> Result<(), DiagnosticLogError> {
    myne_core::paths::containment_refused(destination, guarded_roots)
        .map_err(|_| DiagnosticLogError::InvalidDestination)
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
    fn the_digest_command_body_reads_the_running_executable_and_caches_it() {
        // The command wrapper needs a Tauri runtime, which a unit test has not got;
        // its body does not, so the half worth pinning — that hashing THIS
        // process's executable resolves and answers a well-formed digest — runs
        // here. Without it the only evidence that `current_exe()` works on a given
        // platform is a user reporting a missing `bundleHash` line.
        let digest = cached_digest().expect("the test executable can be hashed");
        assert!(
            digest.starts_with(crate::plugins::diagnostics::measures::DIGEST_PREFIX),
            "digest is not prefixed: {digest}"
        );
        assert_eq!(
            digest.len(),
            crate::plugins::diagnostics::measures::DIGEST_PREFIX.len() + 64
        );
        // Second call serves the cached value rather than re-hashing 20 MB: the same
        // string is what the panel sees on every later mount.
        assert_eq!(cached_digest().expect("cached digest"), digest);
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
    fn the_guarded_roster_names_every_store_this_feature_writes() {
        // The roster is what decides the refusal, and a dropped entry is a real
        // gap that nothing else in the repository notices: the log directory is a
        // separate tree on every platform, and the config directory is the only
        // thing guarding the switch file on Linux. `resolve` above is an
        // exhaustive match, so a variant cannot lack a resolver; this asserts the
        // ROSTER, which a type cannot hold (myne#860 review).
        assert_eq!(GuardedStore::ALL.len(), 3);
        assert!(GuardedStore::ALL.contains(&GuardedStore::Log));
        assert!(GuardedStore::ALL.contains(&GuardedStore::Config));
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
        // vault-only check misses. The log directory is a separate tree on every
        // platform, so a destination of `<log dir>/crash.log` used to pass the
        // check and then overwrite the crash record; the config directory is
        // separate from the data directory on Linux and the same one on macOS and
        // Windows, so `<config dir>/diagnostic-log.json` overwrote the switch on
        // the platform where the two differ (myne#860 review).
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
    fn a_guarded_root_that_does_not_exist_yet_is_skipped() {
        // The fresh-install case, and the reason a missing root is SKIPPED rather
        // than refused. The log directory is created lazily, by the first log
        // write, so on a default profile with logging off it does not exist. A
        // root that does not exist cannot be a component prefix of a parent that
        // did canonicalize, so refusing here bought no protection and broke the
        // feature outright: every save was refused in the DEFAULT configuration
        // (myne#860 review).
        let user_dir = ScopedTempDir::new("diagnostics-accept-missing-root").expect("tempdir");
        let missing_root = user_dir.path().join("not-created");
        let output_dir = ScopedTempDir::new("diagnostics-accept-missing-out").expect("tempdir");

        assert_eq!(
            validate_report_destination(
                &output_dir.path().join("myne-report.txt"),
                &[Ok(missing_root)]
            ),
            Ok(()),
            "a root that does not exist yet must not refuse the write"
        );

        // And an EXISTING root is still compared. A canonicalize failure that is
        // not `NotFound` (a permission error, an I/O error) refuses, which is the
        // direction the test above cannot construct portably; what IS constructible
        // is the resolved-and-present case, so it is asserted here so the loop is
        // not vacuous.
        let present_root = ScopedTempDir::new("diagnostics-refuse-present").expect("tempdir");
        let inside = present_root.path().join("myne-report.txt");
        assert_eq!(
            validate_report_destination(&inside, &[Ok(present_root.path().to_path_buf())]),
            Err(DiagnosticLogError::InvalidDestination),
            "a root that IS there must still be compared"
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
