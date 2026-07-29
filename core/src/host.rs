// SPDX-License-Identifier: AGPL-3.0
//! The process-host seam (`phase3-web-client` task 79).
//!
//! Everything a command core needs from its host that is **not already an
//! ordinary Rust value**. Deliberately four methods, and the shortness is the
//! design: `VaultRuntimeState`, `VaultIndicesState`, `AttachmentRefsState`,
//! `VaultCreationState` and [`crate::hooks::Hooks`] are all already
//! platform-free types, and they stay **ordinary `&T` parameters** — the shape
//! the 82 existing `*_with_dir` / `*_with_path` inner fns already use. Folding
//! them in here would build a god-object and force a host dependency onto the
//! 22 commands that take no `AppHandle` at all.
//!
//! Counted against `core/src` on 2026-07-26 (the numbers this design rests on;
//! `agent-tooling/features/phase3-web-client/core-tauri-inventory.json` carries
//! the per-command detail):
//!
//! | Fact | Value |
//! |---|---|
//! | `#[tauri::command]` fns in core | 146, across 18 plugins |
//! | …taking `AppHandle` at all | 124 |
//! | …taking **no** `AppHandle` | 22 |
//! | `app_data_dir()` reached by | 123 |
//! | `app_config_dir()` reached by | 10 (all `sync`) |
//! | `app.emit(...)` sites | 11 (10 `sync`, 1 `export`) |
//! | Window / dialog operations | **0** |
//!
//! That last row is why this trait has no window or dialog method: core does
//! not perform any. The seam is smaller than it looks from the outside.
//!
//! ## Why a trait behind `&dyn`, never a generic parameter
//!
//! `<R: Runtime>` currently infects 124 signatures and monomorphizes the whole
//! plugin surface per runtime. Swapping it for `<H: HostCtx>` would leave the
//! signatures exactly as viral. `&dyn HostCtx` keeps every ported fn
//! **non-generic**, which is also what lets the 22 host-free commands keep zero
//! host parameters.
//!
//! The precedent is one axis over: [`crate::hooks::VaultLifecycleHooks`] is
//! this trait for lifecycle side effects — object-safe, `Runtime`-free, with a
//! `NoopHooks`. This copies its shape and gets to be simpler, because every
//! method here is synchronous and needs no hand-rolled `BoxFuture`.
//!
//! ## Nothing calls this yet
//!
//! Step 0 of the migration lands the seam alone. The per-plugin moves come
//! after, one plugin at a time, each verifiable on its own.

use std::path::PathBuf;
use std::sync::Arc;

/// The managed handle. Mirrors [`crate::hooks::Hooks`].
pub type Host = Arc<dyn HostCtx>;

/// Opaque path-resolution failure.
///
/// Deliberately carries no detail. Every existing call site already collapses
/// an `app_data_dir()` failure to a single opaque variant — `AppError::Io {
/// io_error_kind: Other }` in `paths::app_data_dir`, and
/// `io::Error::other("vault root resolution failed")` in the `_io` variants —
/// so adding structure here would be a **behaviour change**, not a port. If a
/// caller ever needs to distinguish causes, that is a deliberate follow-up with
/// its own decision, not a side effect of this seam.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostPathError;

impl core::fmt::Display for HostPathError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("host path resolution failed")
    }
}

impl std::error::Error for HostPathError {}

/// The closed set of event payload shapes core emits.
///
/// Closed, not `serde_json::Value`, for two reasons. A generic
/// `emit<T: Serialize>` would break object safety outright. And a closed enum
/// means a reviewer can diff this list against the live `app.emit` call sites,
/// and a test can pin the serialized bytes — which matters because the UI
/// listens for these by name and shape.
///
/// Adding an event means adding a variant. With 11 emit sites in the whole
/// crate, that is the right trade; the escape hatch, if it ever binds, is a
/// `Json(serde_json::Value)` variant added **deliberately** rather than
/// pre-emptively.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(untagged)]
pub enum EventPayload {
    /// No payload — the shape of most current emits.
    Unit,
    /// A single count, e.g. how many records a sync cycle pulled.
    Count(u32),
    /// A single opaque identifier, e.g. the note id a snapshot write failed for.
    ///
    /// Never a title, never a path: an event payload crosses into the WebView
    /// and is not covered by the vault's AEAD, so it carries identifiers only.
    Text(String),
    /// Progress as counts plus a phase tag. Counts only — see `Text`.
    Progress {
        done: u32,
        total: u32,
        phase: &'static str,
    },
}

/// What a command core needs from whatever process is hosting it.
///
/// Implemented by a Tauri adapter on desktop and mobile, by a Worker adapter in
/// the browser, and by a test double in `core`'s own tests — which is the point
/// that is easy to undersell: today a core test cannot exercise a *command*
/// without standing up a Tauri mock app. After this, it can.
pub trait HostCtx: Send + Sync + 'static {
    /// `<app_data_dir>` — the base every vault path is resolved under.
    ///
    /// **Not** the vault root. Vault-root resolution stays in
    /// [`crate::paths`], whose `*_from_base` / `*_under` helpers are already
    /// pure and host-free; this method is the single missing input to them.
    /// Keeping the split means the path *arithmetic* has one implementation
    /// shared by every host, and only the *base lookup* varies.
    fn app_data_dir(&self) -> Result<PathBuf, HostPathError>;

    /// `<app_config_dir>` — device-scoped and vault-independent.
    ///
    /// A **different** directory from `app_data_dir`, not derivable from it,
    /// and read by the sync plugin's `sync-config.json`. It is called out
    /// because the original task text folded all path resolution into
    /// "vault-root resolution" and would have left these commands stranded
    /// mid-migration.
    fn app_config_dir(&self) -> Result<PathBuf, HostPathError>;

    /// Fire-and-forget notification to the UI.
    ///
    /// Never fails and never blocks, matching the `let _ = app.emit(..)`
    /// discipline every current call site uses: an event that could not be
    /// delivered is not a reason to fail the operation that produced it.
    fn emit(&self, event: &'static str, payload: EventPayload);

    /// Wall-clock seconds since the Unix epoch.
    ///
    /// **This is on the seam because it is the failure mode a compiler cannot
    /// catch.** `SystemTime::now()` *compiles* for `wasm32-unknown-unknown` and
    /// then **panics** at runtime — read out of std's own source at the pinned
    /// toolchain, not assumed: `library/std/src/sys/time/mod.rs` has no wasm32
    /// arm, so it falls to `_` → `unsupported.rs`, whose `now()` is
    /// `panic!("time not implemented on this platform")`. A clock left as a
    /// direct call would therefore pass every build gate and abort the instance
    /// the first time a note was written.
    ///
    /// (An earlier note here said it "returns a fixed value depending on the
    /// host". That was wrong for this target and is corrected above — it aborts,
    /// and on `panic = "abort"` wasm an abort is unrecoverable.)
    ///
    /// **Derived, not implemented.** [`Self::now_unix_millis`] is the primitive
    /// so an implementation supplies one clock and both granularities stay
    /// exact. Deriving the other way round — millis as `secs * 1000` — would
    /// silently coarsen the prefs LWW field clocks
    /// (`sync-protocol.md` §10.2) from millisecond to second resolution, making
    /// two edits inside the same second unorderable. That is a merge-behaviour
    /// change wearing a refactor's clothes.
    fn now_unix_secs(&self) -> u64 {
        self.now_unix_millis() / 1_000
    }

    /// Wall-clock **milliseconds** since the Unix epoch.
    ///
    /// The primitive of the two wall clocks. Millisecond resolution is
    /// load-bearing where it is used: the prefs last-write-wins field clocks
    /// (`sync-protocol.md` §10.2) and the vault registry's `last_unlock` both
    /// compare stamps across devices, and a coarser clock turns a resolvable
    /// ordering into a tie.
    ///
    /// Same seam rationale as [`Self::now_unix_secs`], and the same evidence:
    /// `SystemTime::now()` compiles for wasm32 and panics.
    fn now_unix_millis(&self) -> u64;

    /// Milliseconds from an arbitrary, host-chosen origin that only ever
    /// increases.
    ///
    /// The largest Argon2id memory cost (KiB) this host can actually service,
    /// or `None` when the host imposes no ceiling of its own.
    ///
    /// **This is a browser-capability refusal layered on top of protocol
    /// validation — it is NOT a second opinion about what the protocol allows**
    /// (phase3-web-client task 31). `protocol::validate_kdf_params` accepts up
    /// to `MAX_KDF_M_KIB` = 4 GiB, and that constant and the v0.1 256 MiB
    /// baseline are unchanged and must stay so: the parameters are AAD-bound and
    /// read from `vault.meta` (`protocol.md` §4.2), so they can be neither
    /// lowered nor renegotiated for a client.
    ///
    /// The problem this exists for is narrower and real: a vault created with
    /// high-but-legal parameters **passes validation and is still unopenable in
    /// a browser**, because `wasm32` has a 4 GiB address ceiling and a tab sits
    /// well below it. Without this the failure is an OOM *inside the
    /// allocation* — on wasm32 an abort, which kills the instance and presents
    /// as a dead Worker with no cause. With it, the client refuses before
    /// allocating and can say which client to open the vault on.
    ///
    /// Defaulted to `None` so desktop and mobile are untouched: their ceiling is
    /// the machine's, which the allocator already reports honestly.
    ///
    /// Measured headroom (`protocol.md` §4.1): the v0.1 baseline of 256 MiB
    /// settles at **321 MiB** of wasm linear memory — the block plus allocator
    /// overhead — with no OOM in Chrome, Safari or Firefox.
    fn max_kdf_memory_kib(&self) -> Option<u32> {
        None
    }

    /// The one vault this host can hold, when it holds exactly one **by
    /// construction** rather than by happening to have one on disk.
    ///
    /// This is the seam's answer to a resolution step that cannot work in a
    /// browser. [`crate::paths::current_vault_root_from_base`] disambiguates a
    /// `None` active-vault id with a `std::fs::read_dir` scan of `vaults/`,
    /// which on `wasm32` **always errors** — so the scan silently falls through
    /// to the legacy single-vault directory, and every pre-unlock read lands in
    /// a directory the web client never writes. That failure is invisible: the
    /// call succeeds, returns a plausible path, and reports the vault as absent.
    ///
    /// It bites specifically **before unlock**, because that is when
    /// `active_vault_id()` is `None` — which is exactly when boot routing needs
    /// an answer. A device awaiting sync approval read as `NotEnrolled` instead
    /// of `Pending` for this reason, and boot sent it to the unlock screen.
    ///
    /// Defaulted to `None` so desktop and mobile are untouched: they genuinely
    /// can hold several vaults, and the disk scan is the right disambiguation
    /// there. The web host overrides it with the fixed
    /// [`crate::paths::web_single_vault_id`] — the same constant its `vault_list`
    /// already resolves against, so the two cannot disagree about which
    /// directory is the vault.
    fn sole_vault_id(&self) -> Option<crate::vault_id::VaultId> {
        None
    }

    /// Separate from [`Self::now_unix_secs`] because they answer different
    /// questions and fail differently. Wall-clock time is what goes *inside* the
    /// encrypted blob and what the sync merge reconciles on; it can jump
    /// backwards (NTP, a user changing the clock) and that is tolerated because
    /// `sync-protocol.md` §11.4 already says convergence is the contract, not
    /// clock truth. **This** one is for measuring elapsed time — an unlock's
    /// duration, an idle timer — where a backwards jump is a bug: an auto-lock
    /// driven by a wall clock unlocks itself when the clock rewinds.
    ///
    /// On the seam for the same reason as the wall clock, and with the same
    /// evidence: `Instant::now()` resolves to the same `unsupported` backend on
    /// `wasm32-unknown-unknown` and panics identically. The origin is
    /// deliberately unspecified — only differences are meaningful, so no caller
    /// can come to depend on the absolute value.
    fn monotonic_millis(&self) -> u64;
}

/// A host that resolves nothing and emits nowhere.
///
/// Mirrors `hooks::NoopHooks`. For tests of code paths that take a `&dyn
/// HostCtx` without exercising it, and as the honest default for a host that
/// genuinely has no storage — never as a way to make a real host compile.
#[derive(Debug, Default)]
pub struct NoopHost;

impl HostCtx for NoopHost {
    fn app_data_dir(&self) -> Result<PathBuf, HostPathError> {
        Err(HostPathError)
    }
    fn app_config_dir(&self) -> Result<PathBuf, HostPathError> {
        Err(HostPathError)
    }
    fn emit(&self, _event: &'static str, _payload: EventPayload) {}
    fn now_unix_millis(&self) -> u64 {
        0
    }
    fn monotonic_millis(&self) -> u64 {
        0
    }
}

/// The Tauri adapter.
///
/// Lives in `core` rather than in each client crate because of the Option-B
/// decision (2026-07-26): the thin `#[tauri::command]` wrappers stay here,
/// cfg-gated, so both native hosts keep their `generate_handler!` lines
/// unchanged and there is no mobile companion PR. The wrappers need to
/// construct this, so it has to be reachable from here.
///
/// Compiled only when the `tauri-ipc` feature is on **and** the target is not
/// wasm32. A wasm build therefore never sees `tauri` in this file at all.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
pub mod tauri_host {
    use super::{EventPayload, HostCtx, HostPathError};
    use std::path::PathBuf;
    use tauri::{AppHandle, Emitter, Manager, Runtime};

    /// Wraps an `AppHandle`. Cheap to construct — `AppHandle` is `Clone` and
    /// the clone is a refcount bump — so a command wrapper builds one per call
    /// rather than threading a long-lived handle through.
    pub struct TauriHost<R: Runtime> {
        app: AppHandle<R>,
    }

    impl<R: Runtime> TauriHost<R> {
        pub fn new(app: AppHandle<R>) -> Self {
            Self { app }
        }
    }

    impl<R: Runtime> HostCtx for TauriHost<R> {
        fn app_data_dir(&self) -> Result<PathBuf, HostPathError> {
            self.app.path().app_data_dir().map_err(|_| HostPathError)
        }

        fn app_config_dir(&self) -> Result<PathBuf, HostPathError> {
            self.app.path().app_config_dir().map_err(|_| HostPathError)
        }

        fn emit(&self, event: &'static str, payload: EventPayload) {
            // `let _ =` matches every existing call site: a failed emit is not a
            // reason to fail the operation that produced it.
            let _ = self.app.emit(event, payload);
        }

        fn now_unix_millis(&self) -> u64 {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                // A clock before the epoch is a misconfigured machine, not a
                // condition to propagate; 0 is the same answer the existing
                // `unwrap_or_default()` call sites give.
                .unwrap_or_default()
        }

        fn monotonic_millis(&self) -> u64 {
            // `Instant` cannot be turned into a number, so the origin is a
            // process-lifetime baseline captured on first use. That satisfies
            // the contract exactly — the origin is unspecified and only
            // differences are meaningful — and keeps the underlying source
            // `Instant`, which is the platform's real monotonic clock.
            static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
            START
                .get_or_init(std::time::Instant::now)
                .elapsed()
                .as_millis() as u64
        }
    }
}

/// A host backed by two directories and an in-memory event log.
///
/// Lives in the crate (behind `test-support`, like `crate::test_support`) so a
/// plugin test can drive a command end to end — path resolution, IO, and the
/// events it emits — without a Tauri runtime. Asserting on `events()` is how a
/// port proves it did not drop an emit.
#[cfg(any(test, feature = "test-support"))]
pub mod test_host {
    use super::{EventPayload, HostCtx, HostPathError};
    use std::path::PathBuf;
    use std::sync::Mutex;

    #[derive(Debug)]
    pub struct TestHost {
        data_dir: PathBuf,
        config_dir: PathBuf,
        events: Mutex<Vec<(&'static str, EventPayload)>>,
        now: Mutex<u64>,
        kdf_ceiling_kib: Option<u32>,
    }

    impl TestHost {
        /// Both directories under one base, which is what a test usually wants.
        pub fn new(base: impl Into<PathBuf>) -> Self {
            let base: PathBuf = base.into();
            Self {
                data_dir: base.join("data"),
                config_dir: base.join("config"),
                events: Mutex::new(Vec::new()),
                // A fixed, obviously-synthetic epoch so a test that accidentally
                // depends on the wall clock fails loudly instead of passing
                // until midnight.
                now: Mutex::new(1_700_000_000),
                // `None` by default — the desktop and mobile answer. A test that
                // does not ask about the ceiling must not accidentally get one.
                kdf_ceiling_kib: None,
            }
        }

        /// Separate directories, for the sync-config paths that need them apart.
        pub fn with_dirs(data_dir: impl Into<PathBuf>, config_dir: impl Into<PathBuf>) -> Self {
            Self {
                data_dir: data_dir.into(),
                config_dir: config_dir.into(),
                events: Mutex::new(Vec::new()),
                now: Mutex::new(1_700_000_000),
                kdf_ceiling_kib: None,
            }
        }

        /// Declare an Argon2id memory ceiling, as a browser host does
        /// (phase3-web-client task 31).
        ///
        /// Takes KiB — the same unit as `KdfParams::m_kib` and as
        /// [`HostCtx::max_kdf_memory_kib`], deliberately, so a test reads against
        /// the vault's declared cost without a conversion in between. A ceiling
        /// in MiB here would put the one unit mismatch that matters inside the
        /// helper meant to make the comparison legible.
        pub fn with_kdf_ceiling_kib(mut self, kib: u32) -> Self {
            self.kdf_ceiling_kib = Some(kib);
            self
        }

        /// Everything emitted so far, oldest first.
        pub fn events(&self) -> Vec<(&'static str, EventPayload)> {
            self.events.lock().expect("test host mutex").clone()
        }

        /// Advance the fake clock.
        pub fn set_now(&self, secs: u64) {
            *self.now.lock().expect("test host mutex") = secs;
        }
    }

    impl HostCtx for TestHost {
        fn app_data_dir(&self) -> Result<PathBuf, HostPathError> {
            Ok(self.data_dir.clone())
        }
        fn app_config_dir(&self) -> Result<PathBuf, HostPathError> {
            Ok(self.config_dir.clone())
        }
        fn emit(&self, event: &'static str, payload: EventPayload) {
            self.events
                .lock()
                .expect("test host mutex")
                .push((event, payload));
        }
        fn now_unix_millis(&self) -> u64 {
            // `TestHost`'s settable clock is in SECONDS (its `set_now` takes
            // seconds and existing tests assert against them), so the millis
            // primitive scales up rather than the other way round.
            self.now
                .lock()
                .expect("test host mutex")
                .saturating_mul(1_000)
        }

        fn max_kdf_memory_kib(&self) -> Option<u32> {
            self.kdf_ceiling_kib
        }

        fn monotonic_millis(&self) -> u64 {
            // Derived from the same settable wall clock so a test that advances
            // time sees BOTH move together. Deliberately not a real `Instant`:
            // a test asserting on elapsed time must be able to control it, and
            // a second uncontrollable clock would make some tests unwritable.
            self.now_unix_millis()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_host::TestHost;
    use super::*;

    #[test]
    fn the_seam_is_object_safe() {
        // The load-bearing property: if this stops compiling, every ported
        // signature has to become generic again.
        let host: Host = Arc::new(NoopHost);
        assert!(host.app_data_dir().is_err());
        let _as_ref: &dyn HostCtx = host.as_ref();
    }

    #[test]
    fn test_host_resolves_both_directories_separately() {
        let h = TestHost::new("/base");
        assert_eq!(h.app_data_dir().unwrap(), PathBuf::from("/base/data"));
        assert_eq!(h.app_config_dir().unwrap(), PathBuf::from("/base/config"));
        // app_config_dir is NOT derivable from app_data_dir — the whole reason
        // it is a separate method.
        assert_ne!(h.app_data_dir().unwrap(), h.app_config_dir().unwrap());
    }

    #[test]
    fn test_host_records_events_in_order() {
        let h = TestHost::new("/base");
        h.emit("a", EventPayload::Unit);
        h.emit("b", EventPayload::Count(3));
        h.emit("c", EventPayload::Text("note-1".into()));
        assert_eq!(
            h.events(),
            vec![
                ("a", EventPayload::Unit),
                ("b", EventPayload::Count(3)),
                ("c", EventPayload::Text("note-1".into())),
            ]
        );
    }

    #[test]
    fn noop_host_refuses_paths_rather_than_inventing_one() {
        // A host with no storage must not resolve to some plausible-looking
        // directory: a port that accidentally kept NoopHost would then write
        // real vault bytes somewhere arbitrary instead of failing.
        let h = NoopHost;
        assert_eq!(h.app_data_dir(), Err(HostPathError));
        assert_eq!(h.app_config_dir(), Err(HostPathError));
    }

    #[test]
    fn event_payloads_serialize_untagged() {
        // Untagged so the wire shape is the payload itself, byte-identical to
        // what `app.emit` sends today. A tagged enum would silently change
        // every event's JSON and break the UI listeners.
        let j = |p: EventPayload| serde_json::to_string(&p).unwrap();
        assert_eq!(j(EventPayload::Unit), "null");
        assert_eq!(j(EventPayload::Count(7)), "7");
        assert_eq!(j(EventPayload::Text("n1".into())), "\"n1\"");
        assert_eq!(
            j(EventPayload::Progress {
                done: 2,
                total: 5,
                phase: "notes"
            }),
            r#"{"done":2,"total":5,"phase":"notes"}"#
        );
    }

    #[test]
    fn the_clock_is_injectable_so_a_test_never_depends_on_wall_time() {
        let h = TestHost::new("/base");
        assert_eq!(h.now_unix_secs(), 1_700_000_000);
        h.set_now(42);
        assert_eq!(h.now_unix_secs(), 42);
    }
}
