//! The `MyneBackend` seam (cli-thin-client task 4; MYND-490).
//!
//! **Load-bearing from the first commit**: the command/output layer above
//! (`main.rs`, `output.rs`, `exit.rs`) never talks to a socket directly — it
//! calls a `MyneBackend`. This task implements exactly one backend,
//! [`ipc::IpcBackend`], which talks to the running desktop's command
//! socket. Phase 2 (MYND-491+) adds a `CoreBackend` BESIDE it (opens the
//! vault directly when the desktop isn't running) — this trait must never
//! grow an IPC-specific concept (a frame, a socket path, a JSON wire shape)
//! in its signature, or that addition breaks. Same provider-seam pattern as
//! `TokenStore` / `VaultLifecycleHooks` / `QuickUnlockProvider`
//! (`src-tauri/AGENTS.md`, `core/AGENTS.md`).
//!
//! **Behaviour-parity rule** (PRD "Implementation Decisions"): a method
//! here is defined against the CORE's behaviour — for `list`, exactly
//! `myne_core::plugins::notes::commands::note_list_from_host`'s own
//! documented contract (every note id in scope, ascending UUIDv7; no
//! title, no folder — that function is explicit it does no AEAD and
//! carries no metadata beyond the id) — never as "whatever the desktop
//! happens to do". Phase 2's `CoreBackend` must reproduce the identical
//! result for the identical vault state; violating this is the single
//! named trap of the whole two-phase plan.

pub mod ipc;

pub use ipc::IpcBackend;

/// One request to the backend, independent of transport.
pub trait MyneBackend {
    /// List every note id in scope, ascending — see the behaviour-parity
    /// rule above for the exact contract this must reproduce.
    fn list(&self) -> Result<Vec<String>, BackendError>;

    /// One note's markdown body verbatim (task 6) — corresponds to
    /// `myne_core::plugins::notes::commands::note_read_from_host`'s own
    /// contract, scope-filtered the same way `list` is. An unknown id and
    /// an excluded id both surface as [`BackendError::NotFound`] — see
    /// that variant's doc comment for why they must stay indistinguishable.
    fn show(&self, id: &str) -> Result<String, BackendError>;

    /// One period's note (myne#177): `daily`, `weekly` or `monthly`, on the
    /// same open-or-create contract `daily` has. The second element says whether the
    /// host resolved the period on the DEVICE clock while a display-timezone
    /// override was set, so the CLI can say why it and the app might disagree
    /// about which note is the current one. A flag rather than the host's
    /// sentence: `output::DEVICE_CLOCK_NOTE` owns the wording, so no
    /// host-supplied bytes can reach this crate's stderr.
    fn period(&self, period: &str) -> Result<(String, bool), BackendError>;

    /// Append a line to one period's note, creating it first if needed.
    /// Returns the same device-clock flag as [`MyneBackend::period`].
    fn period_append(&self, period: &str, line: &str) -> Result<bool, BackendError>;

    /// Full-text search over notes in scope (task 7). Ranked hits, best
    /// match first. **An excluded hit is never distinguishable from a
    /// genuine no-match** — both are simply absent from the returned
    /// vector, with no count or flag anywhere that would let a caller infer
    /// an excluded folder's contents by varying the query (the single
    /// defect this feature is most exposed on; see the desktop-side
    /// `cli_bridge::scope::search_in_scope` doc comment for the full
    /// rationale).
    fn search(&self, query: &str) -> Result<Vec<SearchHit>, BackendError>;

    /// Create a note from `body`, optionally filed under `folder` (task 8) —
    /// corresponds to
    /// `myne_core::plugins::notes::commands::note_create_from_host`'s own
    /// contract: the SAME core create path the app uses, so folder
    /// placement, title derivation and snapshot hooks behave identically
    /// (the behaviour-parity rule above). An explicit `folder` that is
    /// excluded is refused via [`BackendError::FolderExcluded`] BEFORE
    /// anything is written — never silently redirected to root. Returns the
    /// new note's id.
    fn create(&self, body: &str, folder: Option<&str>) -> Result<String, BackendError>;

    /// Open a local markdown file in the running app's plain-file surface
    /// (myne-md/myne#788, task 11). This crate never opens the file: the
    /// desktop resolves the path through its gate-checked ingest and the tab
    /// appears in the app. `Ok(())` means a handle was minted there; the
    /// refusal classes this crate can distinguish are [`BackendError::PlainFileOff`]
    /// (the device-local gate is off) and [`BackendError::Io`] (an unsupported
    /// type, a missing file, an oversized file — each with the desktop's
    /// bounded sentence).
    fn open(&self, path: &str) -> Result<(), BackendError>;
}

/// One ranked search hit — an id + its title, nothing else (no score, no
/// snippet: the desktop's `SearchHitWire` carries nothing else either).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub id: String,
    pub title: String,
}

/// Closed failure taxonomy a [`MyneBackend`] may return. Every variant maps
/// to exactly one exit code (`crate::exit::from_backend_error`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackendError {
    /// No desktop process is reachable at all — no command socket, no
    /// status marker to say otherwise.
    AppNotRunning,
    /// The desktop is running with CLI access enabled, but the vault is
    /// locked. The CLI must NEVER prompt for a password in response to
    /// this (PRD story 13) — unlocking happens in the app, not the
    /// terminal.
    VaultLocked,
    /// The desktop is running and unlocked, but CLI access is off in
    /// Settings (PRD story 14).
    CliDisabled,
    /// The requested resource does not exist — or is excluded (task 5
    /// makes the two indistinguishable by design, PRD story 18). First
    /// reachable via `show` (task 6); `list` has no single-resource lookup
    /// to miss.
    NotFound,
    /// The requested destination folder (or one of its ancestors) is in
    /// `cli_excluded_folders` — refused before anything was written (task 8,
    /// PRD story 19: "excluded" means one thing, not two).
    FolderExcluded,
    /// The command socket's rate limit refused this request (task 10). It
    /// is a **slowdown against a runaway script, not a protection** — the
    /// door has no identity gatekeeper to begin with — and the user can
    /// turn it off in Settings. Retrying in a moment is the correct
    /// response, which is why it gets a code of its own rather than
    /// collapsing into [`BackendError::Io`].
    RateLimited,
    /// The device-local plain-file editor is off, so `open` refused before
    /// anything was read (myne-md/myne#788). Its own code because enabling
    /// it is a different user action from every other failure here — and
    /// because the gate lives in Settings, not in the vault, this is NOT
    /// [`BackendError::CliDisabled`]: the CLI door can be open while the
    /// file editor is not.
    PlainFileOff,
    /// Any other failure: a malformed reply, a framing error, a connection
    /// failure not explained by the door being shut, an unrecognized wire
    /// error kind. Carries a human-readable message (no secret/DENY-listed
    /// content ever flows through this path — see `wire.rs`).
    Io(String),
}
