//! The desktop diagnostic log's runtime (myne-md/myne#860).
//!
//! # The one subscriber, and why the switch cannot be a second `try_init`
//!
//! `tracing` allows exactly one global subscriber per process, so the toggle
//! cannot install and uninstall a sink. Instead this module installs ONE
//! subscriber at startup with two layers, and the file layer's writer holds a
//! runtime switch: turning the log off drops the open file and the next record
//! returns before touching the disk.
//!
//! # The two layers differ in exactly two ways, and both are deliberate
//!
//! - **stdout keeps honouring `RUST_LOG`**, defaulting to `info`, because that
//!   is a developer's console knob and always was.
//! - **the file layer has its own fixed `info` floor and ignores `RUST_LOG`
//!   entirely.** An environment variable must not decide what persists on a
//!   user's disk, and the one call site whose own doc comment admits its detail
//!   "may include the path" is precisely the `RUST_LOG`-gated one. Debug and
//!   trace are also where the records that name stages, counts and ids live
//!   (`docs/decisions/ops/0366`).
//!
//! # Startup ordering is the whole reason the flag is device-local
//!
//! This runs in `Builder::setup`, which is the earliest hook holding an
//! `AppHandle`, and that is BEFORE any vault is unlocked. The flag therefore has
//! to be readable then, which is why it is a plaintext file in the app config
//! directory rather than a `vault.prefs` field: a preference would be sealed
//! behind `root_key`, so the boot sequence, the picker, the unlock, Argon2id and
//! the migration would be unloggable even with the toggle on. Same call, and the
//! same reasoning, as `plugins::plain_file::gate`.
//!
//! # A failure here must not stop the app
//!
//! Logging is a diagnostic aid, so every error in this module degrades: an
//! unresolvable log directory leaves stdout only, and an unreadable flag leaves
//! the sink off. Neither is worth refusing to start over, and the degradation
//! direction is the safe one (`off` is the state in which nothing is written).

pub mod crash;
pub mod sink;

use crate::plugins::diagnostics::flag;
use sink::{LogSink, SinkMaker};
use std::sync::Arc;
use tauri::{AppHandle, Manager, Runtime};
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

/// Why the file layer could not be installed.
///
/// Closed, and carries no path: a path in an error message is a disclosure
/// (`src-tauri/AGENTS.md` DENY list). The one arm is a platform path resolver
/// that could not answer, which on every shipped platform means a misconfigured
/// bundle identity rather than anything the user did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogInitError {
    /// The platform log directory could not be resolved.
    LogDirUnresolved,
}

/// Install the subscriber and return the sink for `app.manage`.
///
/// Called once, from `Builder::setup`. On `Err`, a stdout-only subscriber is
/// still installed, so the warning below reaches a terminal; the caller only
/// has to decide whether to manage the sink (it should not, on `Err`).
pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<Arc<LogSink>, LogInitError> {
    // Fail closed on the flag: an unreadable or unresolvable config directory
    // answers "off", which is the state in which nothing is written.
    let enabled = app
        .path()
        .app_config_dir()
        .ok()
        .map(|config| flag::read_flag(&flag::flag_path_in(&config)))
        .unwrap_or(false);

    let dir = match app.path().app_log_dir() {
        Ok(dir) => dir,
        Err(_) => {
            install(None);
            tracing::warn!(
                event = "diagnostic_log_dir_unresolved",
                "the platform log directory could not be resolved; only stdout is active"
            );
            return Err(LogInitError::LogDirUnresolved);
        }
    };

    let sink = Arc::new(LogSink::new(dir, enabled));

    // The panic hook is installed here, once, with the same directory the sink
    // writes into. It is the feature's ONE admitted exception to "the sink is
    // inert while the toggle is off": it is host code rather than a `tracing`
    // call site, and its payload is a closed set of scalars. See `crash.rs`.
    crash::install(sink.dir().to_path_buf());

    install(Some(Arc::clone(&sink)));
    Ok(sink)
}

/// The `tracing` targets the file layer admits, and nothing else.
///
/// **The sink is process-global and `try_init` also installs `LogTracer`, so
/// without this list a dependency crate's `info`+ records would be written into a
/// file the user is invited to attach to a public issue.** That is the half
/// `scripts/check-tracing-discipline.mjs` cannot attest: it scans the
/// first-party crates, so its guarantee is the first-party crates' guarantee. An
/// earlier revision of the §7 bullet claimed the content rule was
/// "machine-checked" over a sink whose real reach was the whole process, and
/// review caught the gap. This list is what makes the claim true.
///
/// It is a `const` so the test below can ITERATE it: a prefix typo would silently
/// empty the log, which is the one failure worse than the leak it prevents, so
/// every entry is exercised rather than asserted.
pub const FILE_TARGETS: &[&str] = &[
    // The explicit `target:` overrides the tree writes by hand.
    "myne",          // `myne::ai`, `myne::agent`
    "vault_migrate", // src-tauri's eager boot migration
    // The crates, by the name rustc uses for their default target.
    "myne_core",        // `myne-core`
    "myne_desktop_lib", // `myne-desktop`'s lib, which keeps the `_lib` suffix
    "myne_format",      // `myne-format`
    "protocol",         // the protocol crate is named `protocol`
];

/// The file layer's filter: `info` and above, from the app's own targets only.
///
/// Deliberately NOT `EnvFilter` and deliberately NOT `RUST_LOG`: an environment
/// variable must not decide what persists on a user's disk, and the one call site
/// in the tree whose own doc comment admits its detail "may include the path" is
/// precisely the `RUST_LOG`-gated one.
fn file_filter() -> tracing_subscriber::filter::Targets {
    FILE_TARGETS.iter().fold(
        tracing_subscriber::filter::Targets::new()
            // Off for anything not named below, which is what excludes `hyper`,
            // `automerge`, `zbus`, `tauri`'s own crates and the rest of the
            // dependency closure.
            .with_default(LevelFilter::OFF),
        |targets, name| targets.with_target(*name, LevelFilter::INFO),
    )
}

/// The one subscriber: stdout with the env filter, then the file layer.
fn install(sink: Option<Arc<LogSink>>) {
    let stdout_layer = tracing_subscriber::fmt::layer()
        .with_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")));

    // `try_init` never panics when a subscriber is already set, which happens in
    // tests and in any host that installed one first.
    let _ = match sink {
        Some(sink) => {
            let file_layer = tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_target(true)
                .with_writer(SinkMaker::new(sink))
                .with_filter(file_filter());
            tracing_subscriber::registry()
                .with(stdout_layer)
                .with(file_layer)
                .try_init()
        }
        None => tracing_subscriber::registry().with(stdout_layer).try_init(),
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logging::sink::LOG_FILE_NAME;
    use myne_core::test_support::ScopedTempDir;

    /// The filter is TWO-DIRECTIONAL, and both directions are asserted because
    /// only one of them is obvious.
    ///
    /// The deny half is the finding this exists for: the sink is process-global,
    /// so a dependency crate's record used to land in a file the user is invited
    /// to publish. The admit half keeps the FIX honest: a prefix typo in
    /// `FILE_TARGETS` silently empties the log, which is worse than the leak, and
    /// nothing but a test would notice.
    ///
    /// The emissions below are UNROLLED because `tracing`'s `target:` meta field
    /// requires a CONSTANT expression (E0435), so a loop cannot drive it. The
    /// literals are therefore a second list, and `EMITTED` is asserted equal to
    /// `FILE_TARGETS` so the two cannot drift apart in silence.
    #[test]
    fn the_file_layer_admits_the_apps_own_targets_and_drops_everything_else() {
        const EMITTED: &[&str] = &[
            "myne",
            "vault_migrate",
            "myne_core",
            "myne_desktop_lib",
            "myne_format",
            "protocol",
        ];
        assert_eq!(
            EMITTED, FILE_TARGETS,
            "these literals must be the same set the filter admits, or this test \
             checks a list of its own"
        );

        let dir = ScopedTempDir::new("logging-target-filter").expect("tempdir");
        let sink = Arc::new(LogSink::new(dir.path().to_path_buf(), true));
        let subscriber = tracing_subscriber::registry().with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_target(true)
                .with_writer(SinkMaker::new(Arc::clone(&sink)))
                .with_filter(file_filter()),
        );

        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(target: "myne", "an admitted record");
            tracing::info!(target: "vault_migrate", "an admitted record");
            tracing::info!(target: "myne_core", "an admitted record");
            tracing::info!(target: "myne_desktop_lib", "an admitted record");
            tracing::info!(target: "myne_format", "an admitted record");
            tracing::info!(target: "protocol", "an admitted record");
            tracing::info!(target: "hyper::proto::h1", "dependency noise");
            tracing::info!(target: "automerge::sync::state", "dependency noise");
            tracing::info!(target: "zbus::connection", "dependency noise");
        });

        let body = std::fs::read_to_string(sink.dir().join(LOG_FILE_NAME)).expect("read log");
        for name in FILE_TARGETS {
            assert!(
                body.contains(&format!("{name}: an admitted record")),
                "target `{name}` is in FILE_TARGETS but the filter dropped it, so the log is \
                 silently empty for that crate: {body:?}"
            );
        }
        assert!(
            !body.contains("dependency noise"),
            "a dependency crate's record reached the file the user is invited to publish: {body:?}"
        );
    }
}
