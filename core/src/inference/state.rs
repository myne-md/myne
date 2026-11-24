// SPDX-License-Identifier: AGPL-3.0-only
//! Plugin state: the backend registry and the active [`Engine`].
//!
//! Each engine is held as `Arc<dyn Engine>` so it can back concurrent
//! `infer` commands across the async runtime — the trait is
//! `Send + Sync`, so this is too. (The header used to describe a "task-1 stub"
//! with no mutable model state; Candle shipped, and it keeps its own lock.)
//!
//! A backend is *described* rather than anonymous: it carries an identity, a
//! [`BackendClass`], and the implementation. The class is what the provider
//! epic's policies are written against (`decisions.md` 2026-08-09), so it must
//! be readable without knowing which concrete engine is behind the trait.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, RwLock};

use super::engine::{Engine, StubEngine};
use super::error::EngineError;

/// The preference facts a selection depends on, and the vault they came from.
#[derive(Clone)]
pub struct PrefsSnapshot {
    /// The preferences the selection reads.
    pub prefs: protocol::PrefsView,
    // A `developer_mode: bool` rode here until myne-md/myne#456, carried purely
    // so the gate's signature stated SYNC-18 out loud. The gate stopped taking
    // it when per-provider consent replaced it, and the field went with it in
    // the same change rather than being left as a value nothing decides on:
    // a snapshot that still carried it would read, to the next person, as
    // though the selection still weighed it.
    /// **The vault these preferences were read from** (myne-md/myne#437).
    ///
    /// Without it the cell is a process-global authorization with no owner, and
    /// that is exactly what it was: nothing invalidated it on lock or unlock, so
    /// vault A's provider and API key answered for vault B — even with the AI
    /// beta switched off in B. Stamping the id turns "remember to invalidate at
    /// every teardown site" into "a snapshot cannot be used outside the vault it
    /// came from", which is a property rather than a discipline.
    ///
    /// `None` means the reader could not name a vault, which resolves the same
    /// way a mismatch does: the local arm.
    pub vault_id: Option<crate::vault_id::VaultId>,
}

/// How the seam obtains those facts. Async because `vault.prefs` is encrypted
/// vault content — reading it decrypts a blob with the unlocked `root_key`, and
/// there is no synchronous way to do that. Erased behind a closure so
/// `state.rs` keeps knowing nothing about Tauri.
/// The shared snapshot cell. A type alias because three modules name it and a
/// nested `Arc<RwLock<Option<…>>>` spelled out at each is a rename waiting to
/// go half-done.
pub type PrefsCell = Arc<RwLock<Option<PrefsSnapshot>>>;

/// A synchronous read of the currently-unlocked vault id.
pub type ActiveVaultReader = Arc<dyn Fn() -> Option<crate::vault_id::VaultId> + Send + Sync>;

pub type PrefsReader =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Option<PrefsSnapshot>> + Send>> + Send + Sync>;

/// How a backend reaches its model.
///
/// **This is the load-bearing field, not the backend's name.** Every policy in
/// the provider epic is stated against the class — "ambient surfaces never
/// reach a remote backend", "only a
/// user-named provider may open a socket" (`decisions.md` 2026-08-09). A rule
/// written against a *list of names* is a rule the next backend forgets to
/// join; a rule written against the class covers a backend nobody has added
/// yet, which is the only kind of coverage that survives.
///
/// `LoopbackLocal` and `Remote` have no constructor yet — #189 and #415 add
/// them. They are declared here rather than with their backends so the policy
/// sites written in tasks 6 and 8 can be exhaustive over the real set from the
/// start; a `match` that grows an arm later is a policy that silently did not
/// cover the new case in between.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub enum BackendClass {
    /// Weights loaded into this process — the Candle engine, and the E2E stub.
    /// Note this is the class with the *worst* isolation (it shares the address
    /// space holding `root_key`) and the *best* egress story (no socket at all).
    InProcessLocal,
    /// A separate program on this machine, reached over loopback: nothing
    /// leaves the device, but the far side is unsigned and unaudited (TB12).
    /// Reserved for #189; nothing registers one yet.
    LoopbackLocal,
    /// A service off this device (TB13). Reserved for #415; nothing registers
    /// one yet.
    Remote,
}

impl BackendClass {
    /// Wire form for the capability report. A closed set of literals so the
    /// frontend can switch on it without importing Rust.
    pub fn as_str(self) -> &'static str {
        match self {
            BackendClass::InProcessLocal => "in_process_local",
            BackendClass::LoopbackLocal => "loopback_local",
            BackendClass::Remote => "remote",
        }
    }
}

/// Why a request is being made — the half of SYNC-14 the *caller* supplies.
///
/// **Set as a constant in the command body, never read from the IPC payload.**
/// That is the entire difference between a structural bar and a convention: a
/// payload flag is something a caller supplies, and "the caller behaved" is not
/// a property of the seam.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestClass {
    /// Fires without the user asking — ghost text as you type, the auto-tag
    /// pass on save. Barred from a remote backend.
    Ambient,
    /// The user asked for this, now: chat, summarize, rewrite, transcribe.
    UserInitiated,
}

/// A registered backend: a stable identity, its [`BackendClass`], and the
/// implementation behind the [`Engine`] trait.
pub struct Backend {
    id: &'static str,
    class: BackendClass,
    engine: Arc<dyn Engine>,
    serializes_compute: bool,
}

impl Backend {
    pub fn new(id: &'static str, class: BackendClass, engine: Arc<dyn Engine>) -> Self {
        Self {
            id,
            class,
            engine,
            serializes_compute: false,
        }
    }

    /// Declare that this backend runs **all** model work behind one lock, so a
    /// second request must wait — which is what makes
    /// [`super::error::EngineError::Deferred`] reachable for it.
    ///
    /// Candle declares it, and for a reason that is not performance: concurrent
    /// `MetalDevice` command-buffer submission crashes the AGX driver, so the
    /// mutex is a **crash-safety invariant**. A backend that serializes out of
    /// process has no such lock and never defers.
    ///
    /// Unused in the `local-inference-stub` build: the E2E stub answers
    /// instantly and holds no lock, so it correctly declares nothing.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn serializing_compute(mut self) -> Self {
        self.serializes_compute = true;
        self
    }

    /// Whether this backend can ever answer `Deferred`. Declared, not inferred
    /// from the class — "in-process" does not imply "serialized", and a future
    /// in-process backend with its own scheduler would be a silent exception to
    /// a rule guessed from the class.
    ///
    /// No production reader yet: today every registered backend serializes, so
    /// nothing has to branch on it. The first reader is the backend that does
    /// not (#189 / #415), and declaring it now is what stops that backend from
    /// inheriting `Deferred`-shaped assumptions silently.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn serializes_compute(&self) -> bool {
        self.serializes_compute
    }

    pub fn id(&self) -> &'static str {
        self.id
    }

    /// The class, readable **without downcasting** to a concrete engine. The
    /// alternative — asking "is this a `CandleEngine`?" — would make every
    /// policy site depend on the set of implementations, which is exactly the
    /// coupling the `Engine` trait exists to prevent.
    ///
    /// First production consumer is the capability report (task 8).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn class(&self) -> BackendClass {
        self.class
    }

    pub fn engine(&self) -> Arc<dyn Engine> {
        Arc::clone(&self.engine)
    }
}

/// App-managed singleton holding the registered backends and which one is
/// active. Registered via `app.manage(...)` in [`super::init`].
///
/// Resolution is a **runtime** lookup over the registry — it used to be a
/// `#[cfg]` fork inside the plugin's `.setup()` closure. What is still
/// compile-time is *which backends get registered*: the E2E [`StubEngine`] is
/// a **build** variant and a production bundle must not be able to reach it, so
/// only the `local-inference-stub` feature ever puts it in the registry.
pub struct LocalInferenceState {
    backends: Vec<Backend>,
    /// The backend that answers when no remote provider is authorized: the
    /// in-process engine, or the device-local Ollama when one is configured.
    /// Resolved once at startup from values that cannot change at runtime.
    local: usize,
    /// The registered remote arm, when this build has one. Never *active* by
    /// registration alone — [`Self::active`] asks the preferences.
    remote: Option<usize>,
    /// The last preference snapshot [`Self::refresh`] read. `None` ≡ the vault
    /// is locked or nobody has asked yet, and both resolve to the local arm.
    snapshot: PrefsCell,
    reader: Option<PrefsReader>,
    /// A synchronous, best-effort reader for the CURRENTLY unlocked vault id
    /// (myne-md/myne#437). Erased behind a closure for the same reason
    /// [`PrefsReader`] is: the seam must not depend on an `AppHandle`, and the
    /// tests that drive it have none. Absent ⇒ no remote arm is ever selected,
    /// which is the correct default for a state that cannot tell which vault it
    /// is looking at.
    active_vault_now: Option<ActiveVaultReader>,
}

impl Default for LocalInferenceState {
    fn default() -> Self {
        Self::new(Arc::new(StubEngine))
    }
}

impl LocalInferenceState {
    /// Construct with a single in-process backend. Kept as the narrow
    /// constructor for tests and for the one-backend world that shipped before
    /// the registry; [`Self::with_backends`] is the general form.
    pub fn new(engine: Arc<dyn Engine>) -> Self {
        Self::with_backends(
            vec![Backend::new(
                "default",
                BackendClass::InProcessLocal,
                engine,
            )],
            "default",
        )
    }

    /// Construct from a registry, with `active_id` naming the resolved backend.
    ///
    /// Panics if `active_id` is not registered. That is deliberate: it is a
    /// programming error at startup, and the alternative — silently falling
    /// back to the first entry — would let a typo select a different backend
    /// than the one the code says it selected, which on this seam means a
    /// different egress class.
    pub fn with_backends(backends: Vec<Backend>, active_id: &str) -> Self {
        let local = backends
            .iter()
            .position(|b| b.id == active_id)
            .unwrap_or_else(|| panic!("active backend {active_id:?} is not registered"));
        let remote = backends
            .iter()
            .position(|b| b.class == BackendClass::Remote);
        Self {
            backends,
            local,
            remote,
            snapshot: Arc::new(RwLock::new(None)),
            reader: None,
            active_vault_now: None,
        }
    }

    /// Adopt an externally-created snapshot cell.
    ///
    /// Needed because the remote backend is built BEFORE the state that owns
    /// the cell — it has to read the same one, and a backend reading a second
    /// cell would let the engine and the seam disagree about what the
    /// preferences say, which is precisely the split the single `active()`
    /// exists to prevent.
    pub fn with_snapshot_cell(mut self, cell: PrefsCell) -> Self {
        self.snapshot = cell;
        self
    }

    /// Install the preference reader. Separate from the constructor because the
    /// reader needs an `AppHandle` and the constructor is reached from tests
    /// that have none; a state with no reader simply never selects the remote
    /// arm, which is the fail-closed direction.
    pub fn with_active_vault_reader(mut self, reader: ActiveVaultReader) -> Self {
        self.active_vault_now = Some(reader);
        self
    }

    pub fn with_prefs_reader(mut self, reader: PrefsReader) -> Self {
        self.reader = Some(reader);
        self
    }

    /// Re-read the preferences that decide the selection.
    ///
    /// **Called at the top of every request that can route remote**, not cached
    /// at startup: `ai_provider` lives in `vault.prefs`, behind the vault lock,
    /// and a user can revoke a key or switch provider mid-session. Task 9 made
    /// the same argument one layer down for the consent gate; this is the
    /// selection above it.
    /// Drop the cached authorization (myne-md/myne#437).
    ///
    /// Called from the vault-lock teardown, beside the `root_key` wipe, the
    /// search index, the spell dictionary and the AI vectors — the cell used to
    /// be the one vault-derived secret that survived all of them. The
    /// vault-stamped snapshot already makes a stale cell unusable; this makes it
    /// absent, so the plaintext API key does not outlive the lock.
    pub fn invalidate(&self) {
        if let Ok(mut slot) = self.snapshot.write() {
            *slot = None;
        }
    }

    pub async fn refresh(&self) {
        let Some(reader) = self.reader.clone() else {
            return;
        };
        let next = reader().await;
        if let Ok(mut slot) = self.snapshot.write() {
            *slot = next;
        }
    }

    /// The snapshot cell, for a backend that needs the same facts the selection
    /// used. Handing out the CELL rather than a copy is what keeps
    /// `RemoteEngine`'s "there is no field here that could go stale" true: it
    /// reads whatever the last [`Self::refresh`] wrote, not a value captured
    /// when it was built.
    /// Test-only rather than an `allow(dead_code)`: production builds the cell
    /// in `init` and hands it to BOTH the remote backend and
    /// [`Self::with_snapshot_cell`], so it never needs to ask the state for one.
    /// A bare allow would let this rot into a second way of reaching the cell.
    ///
    /// The gate is `any(test, feature = "test-support")` rather than the bare
    /// `#[cfg(test)]` it carried while this file lived in the desktop crate
    /// (myne-md/myne#456). `#[cfg(test)]` is per-CRATE, so after the move it was
    /// true only while testing `myne-core`, and the desktop plugin's own tests
    /// that build a remote-selecting fixture lost their way to the cell. Widened
    /// to the crate's established mechanism for exactly this, which the desktop
    /// crate already opts into through its `myne-core` dev-dependency. The
    /// property the comment above cares about is unchanged: no production build
    /// of any client reaches this.
    #[cfg(any(test, feature = "test-support"))]
    pub fn snapshot_cell(&self) -> PrefsCell {
        Arc::clone(&self.snapshot)
    }

    /// Which backend answers **right now**.
    ///
    /// The remote arm is selected only when the preferences authorize it — all
    /// FOUR of the gate's preconditions (the beta flag, a recognized provider,
    /// a consent naming that same provider, and a stored key), evaluated by the same
    /// [`authorize_remote`](super::provider_gate::authorize_remote) the request
    /// path uses, plus a chosen model without which there is nothing to ask
    /// (SYNC-24). Any of them missing resolves to the local arm, so an
    /// unconfigured, half-configured or locked vault answers locally rather
    /// than failing.
    ///
    /// It is deliberately **one function**: the SYNC-14 ambient bar and the
    /// local-only door (`local_engine`) both key on this value, and two
    /// independent
    /// notions of "is remote active" is how a bar comes to report as enforced
    /// while requests route past it.
    fn active(&self) -> usize {
        let Some(remote) = self.remote else {
            return self.local;
        };
        let Ok(slot) = self.snapshot.read() else {
            return self.local;
        };
        let Some(snapshot) = slot.as_ref() else {
            return self.local;
        };
        // The authorization must belong to the vault that is unlocked RIGHT NOW
        // (myne-md/myne#437). Anything else — a different vault, or a vault the
        // seam cannot name because the slot lock is contended — resolves to the
        // local arm. Fail-safe in the only direction that matters: the failure
        // mode is in-process inference, never another vault's provider.
        match (
            self.active_vault_now.as_ref().and_then(|f| f()),
            snapshot.vault_id,
        ) {
            (Some(active), Some(read_from)) if active == read_from => {}
            _ => return self.local,
        }
        if super::provider_gate::authorize_remote(&snapshot.prefs).is_err() {
            return self.local;
        }
        // A provider with no model chosen cannot be asked anything. Selecting it
        // anyway would turn every AI surface into `NotReady` — including the
        // ambient ones, which would then report as BARRED rather than as
        // working locally, which is a worse answer than the truth.
        if snapshot
            .prefs
            .ai_provider_model
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .is_none()
        {
            return self.local;
        }
        remote
    }

    /// **Why a NAMED provider is not the arm that answers**, or `None` when the
    /// question does not apply: no remote arm in this build, no provider named,
    /// or the remote arm IS the active one.
    ///
    /// `active()` above consults [`super::provider_gate::authorize_remote`] for
    /// its boolean and throws the gate's own refusal away, so the capability
    /// report had nothing to say about a named-but-inactive provider beyond the
    /// LOCAL arm's `NoModel`. That is how consent-missing, no-credential,
    /// no-model-chosen and "no provider at all" all reached the chat header as
    /// one sentence, "No provider", on a vault whose provider was named
    /// (myne-md/myne#867).
    ///
    /// Returns the gate's refusal verbatim rather than a new vocabulary: it is
    /// already the closed `EngineError` set the report promises to speak.
    ///
    /// Two edges deliberately return `None` and fall to the local reading: the
    /// slot lock being contended, and the authorization belonging to a different
    /// vault than the one unlocked. Both are the fail-safe direction `active()`
    /// documents, and neither has a cause in the taxonomy that would describe it
    /// better than the local arm's own state does. **The vault edge is checked
    /// here the same way `active()` checks it**, and the first version of this
    /// function documented the edge without implementing it, so a reviewer read
    /// a bound the code did not have.
    pub fn remote_refusal(&self) -> Option<EngineError> {
        self.remote?;
        let snapshot = self.snapshot.read().ok()?;
        let snapshot = snapshot.as_ref()?;
        let named = |v: Option<&str>| v.map(str::trim).filter(|s| !s.is_empty()).is_some();
        if !named(snapshot.prefs.ai_provider.as_deref()) {
            return None;
        }
        // Another vault's authorization is not this vault's refusal to report,
        // exactly as `active()` refuses to select on it.
        match (
            self.active_vault_now.as_ref().and_then(|f| f()),
            snapshot.vault_id,
        ) {
            (Some(active), Some(read_from)) if active == read_from => {}
            _ => return None,
        }
        if let Err(cause) = super::provider_gate::authorize_remote(&snapshot.prefs) {
            return Some(cause);
        }
        // Authorized, and still not answering: `active()` refuses a provider with
        // no model chosen, because it cannot be asked anything.
        //
        // **`NoModel`, not `NotReady`, and the first version of this function had
        // it wrong** (myne-md/myne#867). `NotReady` is the cause whose chip label
        // is "No provider", which is the sentence this whole change exists to
        // stop printing over a vault that HAS a provider named; the local arm's
        // own no-model case is `NoModel`, and a named provider with no model
        // chosen is the same fact from the reader's side. `engine-error.ts`
        // documented this as `no_model` while the code answered `NotReady`, so
        // the two halves of one change disagreed and the bug the issue was filed
        // about survived in the one sub-case the test did not reach.
        if !named(snapshot.prefs.ai_provider_model.as_deref()) {
            return Some(EngineError::NoModel);
        }
        None
    }

    /// The active backend's class, without touching a concrete engine type.
    /// Consumed by the ambient bar (task 6) and the capability report (task 8).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn active_class(&self) -> BackendClass {
        self.backends[self.active()].class
    }

    /// Whether the active backend serializes compute, i.e. whether
    /// [`super::error::EngineError::Deferred`] is reachable at all.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn active_serializes_compute(&self) -> bool {
        self.backends[self.active()].serializes_compute
    }

    /// The active backend's stable identity. Consumed by the capability report
    /// (task 8); `init` also reads it to name the resolved default.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn active_id(&self) -> &'static str {
        self.backends[self.active()].id
    }

    /// Every registered backend as `(id, class)`. The shape the capability
    /// report (task 8) reads; no consumer yet, so it stays crate-visible.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn registered(&self) -> impl Iterator<Item = (&'static str, BackendClass)> + '_ {
        self.backends.iter().map(|b| (b.id, b.class))
    }

    /// The active engine for a classified request, applying the SYNC-14 bar.
    ///
    /// An [`RequestClass::Ambient`] request is refused a
    /// [`BackendClass::Remote`] backend — the rule lives here, in the seam, so
    /// no caller can opt out of it and no setting can turn it off.
    /// The name to attribute an answer from `class` to (myne-md/myne#440).
    ///
    /// `None` for the in-process arm — that is Myne itself and needs no name.
    /// The other two arms DO have one, and the frontend used to derive both from
    /// the remote provider's wire value, which a loopback answer does not carry
    /// — so a local-runtime answer rendered "Answered by " with nothing after
    /// it.
    pub fn served_by_name(&self, class: BackendClass) -> Option<String> {
        match class {
            BackendClass::InProcessLocal => None,
            // The provider the user named, read from the same snapshot the
            // authorization came from.
            BackendClass::Remote => self
                .snapshot
                .read()
                .ok()?
                .as_ref()?
                .prefs
                .ai_provider
                .clone(),
            // The loopback runtime names itself by the backend id, which is the
            // only stable thing here that does not cost a round trip.
            BackendClass::LoopbackLocal => Some(
                self.backends
                    .iter()
                    .find(|b| b.class == BackendClass::LoopbackLocal)
                    .map(|b| b.id)
                    .unwrap_or("ollama")
                    .to_string(),
            ),
        }
    }

    /// Drop every registered backend's cached model (myne-md/myne#440).
    ///
    /// A model-path change is a fact about the LOCALLY side-loaded weights, and
    /// the command that records it used to invalidate `engine_unclassified()` —
    /// the ACTIVE arm. With a provider active that is `RemoteEngine`, whose
    /// `invalidate_models` is the trait no-op, so the in-process arm went on
    /// serving the previously-loaded weights while the user believed the new
    /// model was in effect.
    ///
    /// Every arm rather than "the local one": a no-op on a remote backend costs
    /// nothing, and picking a target would put a second copy of "which arms
    /// cache models" beside the trait method that already answers it.
    pub fn invalidate_all_models(&self) {
        for b in &self.backends {
            b.engine().invalidate_models();
        }
    }

    /// The BACKEND CLASS that [`Self::engine_for`] would resolve for `class`.
    ///
    /// Exists because the capability report has to ask "does the engine that
    /// will actually serve this need a side-loaded model file?", and the answer
    /// is a property of the arm rather than of the state's ACTIVE arm — an
    /// ambient request can be barred onto the local arm while the active one is
    /// remote (myne-md/myne#438). Deriving it from `active_class()` would
    /// therefore be right for one row and wrong for another, which is precisely
    /// the bug this closes.
    pub fn class_for(&self, class: RequestClass) -> Result<BackendClass, EngineError> {
        if class == RequestClass::Ambient && self.active_class() == BackendClass::Remote {
            return self
                .backends
                .iter()
                .find(|b| b.class != BackendClass::Remote)
                .map(|b| b.class)
                .ok_or(EngineError::RemoteBarred);
        }
        Ok(self.backends[self.active()].class)
    }

    pub fn engine_for(&self, class: RequestClass) -> Result<Arc<dyn Engine>, EngineError> {
        if class == RequestClass::Ambient && self.active_class() == BackendClass::Remote {
            return self.non_remote_engine();
        }
        Ok(self.backends[self.active()].engine())
    }

    /// The registered arm that is **not** remote, or [`EngineError::RemoteBarred`]
    /// when this registry has none.
    ///
    /// This is what "barred from the remote arm" means once the remote arm can
    /// actually be active. SYNC-14 bars these surfaces from *the
    /// remote arm* — not from working. Refusing outright looked equivalent
    /// while nothing could ever select remote, and it is not: it would mean
    /// that naming a provider for chat silently disables ghost text, auto-tag
    /// and speech-to-text,
    /// on a vault whose local model is sitting right there. The reason
    /// a bar exists at all — an uncapped metered bill against a metered API —
    /// is satisfied exactly by staying local.
    ///
    /// The refusal survives for the case that really has nowhere to go: a
    /// registry whose only backend is remote. That is not reachable in a
    /// shipped build (the in-process arm is always registered) and it is
    /// reachable in a test, which is where the bar gets proven.
    fn non_remote_engine(&self) -> Result<Arc<dyn Engine>, EngineError> {
        self.backends
            .iter()
            .find(|b| b.class != BackendClass::Remote)
            .map(|b| b.engine())
            .ok_or(EngineError::RemoteBarred)
    }

    /// The active engine for a **local-only** request. Refuses a remote backend
    /// unconditionally.
    ///
    /// This is the door the transcription path (`transcribe`) and the capability
    /// report's transcription row use: the ASR model is bundled and local, so a
    /// named text-generation provider neither serves it nor should be asked to.
    /// (It was named `embedding_engine` and carried the SYNC-16 bar an embedding
    /// request needed — "an embedding request must never be served by a remote
    /// provider, because that is background egress". The embedding family is
    /// retired with `MYR1`, and the one remaining consumer is transcription,
    /// which needs the same local-only door and supplies its own reason for it.)
    pub fn local_engine(&self) -> Result<Arc<dyn Engine>, EngineError> {
        if self.active_class() == BackendClass::Remote {
            return self.non_remote_engine();
        }
        Ok(self.backends[self.active()].engine())
    }

    /// The active engine for work that is **not inference** — reading whether a
    /// tag model exists, invalidating cached model handles. No class applies
    /// because nothing is sent anywhere.
    pub fn engine_unclassified(&self) -> Arc<dyn Engine> {
        self.backends[self.active()].engine()
    }

    /// Deprecated in favour of the classified accessors; retained for tests.
    #[cfg(test)]
    pub fn engine(&self) -> Arc<dyn Engine> {
        self.backends[self.active()].engine()
    }
}

/// The local arm of a client that has no on-device inference.
///
/// **Mobile has one of these and desktop does not** (myne-md/myne#456). The
/// backend registry needs a non-remote arm to fall back to: the
/// ambient-versus-remote refusal is written as "an ambient request is served by
/// the first non-remote backend", and a registry with no such backend has
/// nowhere to send one. On a phone, running Candle is out of scope by decision,
/// so the honest answer to "what serves an ambient request here" is *nothing
/// does*.
///
/// It answers [`EngineError::NoModel`], which is what the trait's own defaults
/// answer for a capability a backend does not have. That matters more than it
/// looks: the alternative of registering `StubEngine` would have a phone
/// FABRICATING answers to ambient requests, and the alternative of registering
/// the remote engine as the local arm would route them off-device, which is the
/// exact thing the refusal exists to stop.
pub struct NoLocalEngine;

impl Engine for NoLocalEngine {
    fn infer(&self, _prompt: &str) -> Result<String, EngineError> {
        Err(EngineError::NoModel)
    }
}

/// The remote arm, as a registered backend.
///
/// **Registration is not selection.** This is always in the registry: it costs
/// nothing to carry, it opens no socket by existing, and it cannot be reached
/// unless the selection finds all four of the gate's preconditions plus a chosen
/// model in the preferences. Building it lazily on the first authorized request
/// would mean the registry did not describe what the app can do, which is the
/// one thing a registry is for, and the capability report reads that registry.
///
/// It reads the SAME snapshot cell the selection consults, so the engine and the
/// seam cannot disagree about what the preferences say.
///
/// Not `.serializing_compute()`: the work happens on someone else's hardware,
/// and holding a local compute lock across an internet round trip would block
/// local inference on a network wait.
///
/// Shared by both Tauri clients since myne-md/myne#456. It was desktop's, and
/// nothing in it is desktop-specific.
pub fn remote_backend(cell: PrefsCell, cancelled: super::cancellable_io::CancelledFn) -> Backend {
    Backend::new(
        "remote",
        BackendClass::Remote,
        Arc::new(remote_engine(cell, cancelled)),
    )
}

/// The engine [`remote_backend`] registers, built apart so the wiring is
/// testable WITHOUT opening a socket (myne-md/myne#894).
///
/// The claim worth pinning is that the source handed to `remote_backend` is the
/// one the engine's own arms (`infer`, `chat_streaming`) actually pass to the
/// transport. That is only observable on the type that stores it, and the
/// previous home of this test — driving `infer` from `myne-desktop` and counting
/// polls — was the shape `provider_transport.rs` warns against in its own words:
/// "a poll count of zero means 'this machine is offline', not 'the wrong
/// predicate was wired'". On an offline runner it fails permanently while
/// proving nothing, which it did.
fn remote_engine(
    cell: PrefsCell,
    cancelled: super::cancellable_io::CancelledFn,
) -> super::provider_registry::RemoteEngine {
    super::provider_registry::RemoteEngine::new(
        Box::new(move || {
            cell.read()
                .ok()
                .and_then(|s| s.as_ref().map(|s| s.prefs.clone()))
        }),
        cancelled,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inference::error::EngineError;

    /// A minimal engine that is distinguishable from `StubEngine` by output, so
    /// `new()` can be told apart from `default()` through the trait alone —
    /// which is the only surface callers have.
    struct MarkerEngine;

    impl Engine for MarkerEngine {
        fn infer(&self, _prompt: &str) -> Result<String, EngineError> {
            Ok("marker".to_string())
        }
    }

    fn infer(engine: &dyn Engine) -> String {
        engine.infer("x").expect("test engine always answers")
    }

    #[test]
    fn default_installs_the_stub_engine() {
        let state = LocalInferenceState::default();
        assert!(
            infer(state.engine().as_ref()).starts_with("stub-infer:"),
            "default() must install StubEngine"
        );
    }

    /// **The WIRING, not the primitive** (myne-md/myne#440).
    ///
    /// `cancel::any_cancelled` has its own test, and `provider_registry`'s
    /// `the_transport_polls_this_requests_predicate_not_the_construction_one`
    /// covers the per-request hand-off, and BOTH stay green if `remote_backend`
    /// dropped this source and installed `|| false` — that regression compiles
    /// cleanly and no type checks it, which is how the original defect shipped:
    /// a request that Stop cannot stop and, on a metered API, that keeps
    /// billing.
    ///
    /// **Asserted without a socket, deliberately** (myne-md/myne#894). This
    /// claim lived in `myne-desktop`, driving `infer` and counting polls, which
    /// `provider_transport.rs` warns against in its own words: "a poll count of
    /// zero means 'this machine is offline', not 'the wrong predicate was
    /// wired'". `remote_engine` is split out of `remote_backend` so the source
    /// can be read from the engine that stores it.
    #[test]
    fn remote_backend_threads_its_cancel_source_into_the_engine() {
        let given: super::super::cancellable_io::CancelledFn = Arc::new(|| true);
        let cell: PrefsCell = Arc::new(std::sync::RwLock::new(Some(PrefsSnapshot {
            prefs: protocol::PrefsView::default(),
            vault_id: None,
        })));
        let engine = remote_engine(cell, Arc::clone(&given));
        assert!(
            Arc::ptr_eq(engine.construction_cancel_source(), &given),
            "remote_backend must hand the engine the source it was given; a \
             dropped or replaced source is the fleet-wide `|| false` that makes \
             Stop do nothing"
        );
    }

    #[test]
    fn new_installs_the_given_engine() {
        let state = LocalInferenceState::new(Arc::new(MarkerEngine));
        assert_eq!(infer(state.engine().as_ref()), "marker");
    }

    /// `engine()` hands back a clone of the same `Arc`, not a new instance:
    /// repeated calls must observe one underlying engine. A registry that
    /// silently reconstructed per call would still pass a behavioural test —
    /// this pins identity by pointer, which is the property that matters when
    /// the engine owns a model handle and a compute lock.
    #[test]
    fn engine_returns_the_same_underlying_instance_every_time() {
        let state = LocalInferenceState::new(Arc::new(MarkerEngine));
        let a = state.engine();
        let b = state.engine();
        assert!(Arc::ptr_eq(&a, &b), "engine() must not reconstruct");
    }

    /// The state holds the engine alive on its own: dropping a handed-out
    /// handle must not affect the next caller.
    #[test]
    fn dropping_a_handle_leaves_the_state_usable() {
        let state = LocalInferenceState::new(Arc::new(MarkerEngine));
        drop(state.engine());
        assert_eq!(infer(state.engine().as_ref()), "marker");
    }

    #[test]
    fn registry_resolves_the_named_default_across_classes() {
        let state = LocalInferenceState::with_backends(
            vec![
                Backend::new(
                    "in-process",
                    BackendClass::InProcessLocal,
                    Arc::new(MarkerEngine),
                ),
                Backend::new(
                    "loopback",
                    BackendClass::LoopbackLocal,
                    Arc::new(StubEngine),
                ),
            ],
            "in-process",
        );
        assert_eq!(state.active_id(), "in-process");
        assert_eq!(state.active_class(), BackendClass::InProcessLocal);
        assert_eq!(infer(state.engine().as_ref()), "marker");
    }

    /// The class must be readable off a registered backend without asking what
    /// concrete engine is behind it — the property every policy rule leans on.
    #[test]
    fn class_is_readable_without_downcasting() {
        let state = LocalInferenceState::with_backends(
            vec![
                Backend::new("a", BackendClass::InProcessLocal, Arc::new(MarkerEngine)),
                Backend::new("b", BackendClass::Remote, Arc::new(MarkerEngine)),
            ],
            "b",
        );
        // Straight off a `Backend`, with no state involved and no downcast.
        let probe = Backend::new("probe", BackendClass::LoopbackLocal, Arc::new(MarkerEngine));
        assert_eq!(probe.class(), BackendClass::LoopbackLocal);
        assert_eq!(probe.id(), "probe");

        let classes: Vec<_> = state.registered().collect();
        assert_eq!(
            classes,
            vec![
                ("a", BackendClass::InProcessLocal),
                ("b", BackendClass::Remote)
            ]
        );
        assert_eq!(state.active_class(), BackendClass::Remote);
    }

    #[test]
    #[should_panic(expected = "is not registered")]
    fn an_unregistered_active_id_is_a_startup_error_not_a_silent_fallback() {
        let _ = LocalInferenceState::with_backends(
            vec![Backend::new(
                "a",
                BackendClass::InProcessLocal,
                Arc::new(MarkerEngine),
            )],
            "typo",
        );
    }

    /// A backend that merely *declares* the remote class. No socket, no
    /// network — the bar is a routing decision, so proving it needs a
    /// descriptor, not a server.
    fn fake_remote() -> LocalInferenceState {
        LocalInferenceState::with_backends(
            vec![Backend::new(
                "fake-remote",
                BackendClass::Remote,
                Arc::new(MarkerEngine),
            )],
            "fake-remote",
        )
    }

    /// SYNC-14, adversarially: an ambient request must be REFUSED a remote
    /// backend, by name, rather than quietly served.
    #[test]
    fn ambient_requests_are_refused_a_remote_backend() {
        let state = fake_remote();
        // `.err()` rather than `expect_err`: the Ok type is `Arc<dyn Engine>`,
        // which is deliberately not `Debug`.
        let err = state.engine_for(RequestClass::Ambient).err();
        assert_eq!(err, Some(EngineError::RemoteBarred));
        assert_eq!(err.unwrap().kind(), "remote_barred");
    }

    /// The local-only door (`local_engine`) refuses a remote backend
    /// unconditionally — there is no request class that unlocks it, which is
    /// what the transcription path needs.
    #[test]
    fn the_local_only_door_is_refused_a_remote_backend_unconditionally() {
        let state = fake_remote();
        assert_eq!(
            state.local_engine().err(),
            Some(EngineError::RemoteBarred),
            "a local-only request must never reach a remote backend"
        );
    }

    /// The control arm. Without it, a bar that refused *everything* would pass
    /// the two tests above and be indistinguishable from a correct one.
    #[test]
    fn user_initiated_requests_do_route_to_a_remote_backend() {
        let state = fake_remote();
        let Ok(engine) = state.engine_for(RequestClass::UserInitiated) else {
            panic!("user-initiated work may use a remote backend");
        };
        assert_eq!(infer(engine.as_ref()), "marker");
    }

    /// A local backend refuses nothing — the bar keys off the backend's class,
    /// not off the request class alone.
    #[test]
    fn a_local_backend_serves_every_class_including_the_local_only_door() {
        let state = LocalInferenceState::new(Arc::new(MarkerEngine));
        assert!(state.engine_for(RequestClass::Ambient).is_ok());
        assert!(state.engine_for(RequestClass::UserInitiated).is_ok());
        assert!(state.local_engine().is_ok());
    }

    /// Compute serialization is **declared**, not inferred from the class — an
    /// in-process backend with its own scheduler would be a silent exception to
    /// a rule guessed from the class, and `Deferred`'s reachability is what
    /// hangs off it.
    #[test]
    fn compute_serialization_is_declared_per_backend() {
        let serial = Backend::new(
            "candle-like",
            BackendClass::InProcessLocal,
            Arc::new(MarkerEngine),
        )
        .serializing_compute();
        assert!(serial.serializes_compute());

        // Same class, different answer — which is the point.
        let concurrent = Backend::new(
            "out-of-process",
            BackendClass::InProcessLocal,
            Arc::new(MarkerEngine),
        );
        assert!(!concurrent.serializes_compute());

        let state = LocalInferenceState::with_backends(vec![serial], "candle-like");
        assert!(state.active_serializes_compute());
    }
}

#[cfg(test)]
mod remote_bar_proof {
    //! The SYNC-14 / SYNC-16 bar, proved rather than asserted
    //! (ai-remote-providers task 8).
    //!
    //! The mechanism is #188's — a request class the COMMAND sets as a
    //! constant, never reads from the IPC payload. What this module adds is the
    //! property the return value alone cannot show: that a barred request opens
    //! **no socket**. An `Err(RemoteBarred)` is compatible with "we connected,
    //! sent the note, and then decided not to" — which is not the guarantee.

    use super::*;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// An engine that connects to a counting listener the instant it is asked
    /// to do anything. If the bar leaks, the counter moves.
    struct ConnectingEngine {
        port: u16,
    }

    impl ConnectingEngine {
        fn touch(&self) {
            let _ = std::net::TcpStream::connect(("127.0.0.1", self.port));
        }
    }

    impl Engine for ConnectingEngine {
        fn infer(&self, _p: &str) -> Result<String, EngineError> {
            self.touch();
            Ok(String::from("reached the engine"))
        }
    }

    /// Wait for the accept counter to move. A bare read straight after
    /// `connect` is a RACE — the client's connect returns as soon as the
    /// kernel queues it, and the listener thread increments later. Written as
    /// an immediate read first, it passed alone and failed once the suite grew;
    /// a flaky control arm is worse than none, because it teaches people to
    /// re-run.
    fn wait_for_accept(accepts: &Arc<AtomicUsize>) -> bool {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if accepts.load(Ordering::SeqCst) > 0 {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        false
    }

    fn counting_listener() -> (u16, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let accepts = Arc::new(AtomicUsize::new(0));
        let a2 = Arc::clone(&accepts);
        std::thread::spawn(move || {
            for _ in listener.incoming() {
                a2.fetch_add(1, Ordering::SeqCst);
            }
        });
        (port, accepts)
    }

    fn remote_state(port: u16) -> LocalInferenceState {
        LocalInferenceState::with_backends(
            vec![Backend::new(
                "test-remote",
                BackendClass::Remote,
                Arc::new(ConnectingEngine { port }),
            )],
            "test-remote",
        )
    }

    /// An ambient request against a remote backend reaches **nothing**. The
    /// control arm at the end is what makes the zero meaningful — a probe that
    /// can never observe a connection is not a probe.
    #[test]
    fn an_ambient_request_opens_no_socket_and_a_user_initiated_one_does() {
        let (port, accepts) = counting_listener();
        let state = remote_state(port);

        // Barred: refused in the seam, before the engine is handed over.
        let barred = state.engine_for(RequestClass::Ambient);
        assert_eq!(barred.err(), Some(EngineError::RemoteBarred));
        assert_eq!(
            accepts.load(Ordering::SeqCst),
            0,
            "an ambient request must not reach the network at all"
        );

        // CONTROL: the same payload, declared user-initiated, does connect.
        let allowed = state
            .engine_for(RequestClass::UserInitiated)
            .expect("chat / summarize / rewrite are served");
        assert_eq!(allowed.infer("prompt").unwrap(), "reached the engine");
        assert!(
            wait_for_accept(&accepts),
            "the probe must be able to see a connection, or the zero proves nothing"
        );
    }

    /// A LOOPBACK-class backend is not barred: nothing leaves the device, so
    /// SYNC-14's reasoning does not apply to it. Without this, the bar could be
    /// "refuse everything that is not in-process" and every test above would
    /// still pass — while the local Ollama arm silently lost ghost text.
    #[test]
    fn the_bar_is_about_remote_not_about_being_out_of_process() {
        let (port, accepts) = counting_listener();
        let state = LocalInferenceState::with_backends(
            vec![Backend::new(
                "test-loopback",
                BackendClass::LoopbackLocal,
                Arc::new(ConnectingEngine { port }),
            )],
            "test-loopback",
        );
        assert!(state.engine_for(RequestClass::Ambient).is_ok());
        assert!(state.local_engine().is_ok());
        let _ = state.local_engine().unwrap().infer("x");
        assert!(wait_for_accept(&accepts));
    }

    /// **No setting relaxes the bar.** SYNC-14 rejects a setting by name, so
    /// the absence is asserted structurally.
    ///
    /// **Rewritten in task 18, and the rewrite is the interesting part.** The
    /// original banned the strings `prefs` / `PrefsView` anywhere in the
    /// production half of this file. That was a sound proxy while nothing could
    /// select the remote arm — the seam had no reason to read a preference at
    /// all — and it became wrong the moment the selection itself had to ask
    /// "has the user named a provider", which is a preference by construction.
    /// Deleting the guard would have been the easy move and the wrong one, so
    /// it is narrowed instead: preferences may decide **which backend is
    /// active**, and may never appear in **the bar**.
    #[test]
    fn no_setting_or_override_can_relax_the_bar() {
        let src = include_str!("state.rs");
        // Sliced at the first test MODULE, not the first `#[cfg(test)]`: the
        // attribute also appears on a test-only accessor inside the production
        // impl block, and slicing there truncated the "production" half above
        // the very functions this guard exists to inspect — which it reported
        // as a missing signature rather than as a bad slice.
        let production = &src[..src.find("#[cfg(test)]\nmod ").expect("test module")];
        // No escape hatch exists anywhere, under any of its usual names.
        for escape in [
            "allow_remote",
            "force_remote",
            "override",
            "bypass",
            "disable_bar",
            "skip_bar",
        ] {
            assert!(
                !production.contains(escape),
                "the seam must not carry {escape:?} — SYNC-14 bars a setting by name"
            );
        }
        // The doors' signatures carry no bypass parameter.
        assert!(production.contains("pub fn engine_for(&self, class: RequestClass)"));
        assert!(production
            .contains("pub fn local_engine(&self) -> Result<Arc<dyn Engine>, EngineError>"));

        // And the doors themselves consult NO preference. Sliced by body rather
        // than asserted over the whole file, because `active()` legitimately
        // reads one and a file-wide ban can no longer tell the two apart.
        for door in [
            "pub fn engine_for(&self, class: RequestClass)",
            "pub fn local_engine(&self) -> Result<Arc<dyn Engine>, EngineError>",
            "fn non_remote_engine(&self)",
        ] {
            let start = production.find(door).expect(door);
            let body = &production[start..];
            let end = body.find("\n    }").expect("body end") + 6;
            let body = &body[..end];
            for banned in ["prefs", "PrefsView", "snapshot", "ai_provider"] {
                assert!(
                    !body.contains(banned),
                    "{door} must not consult {banned:?} — the SELECTION may read \
                     preferences, the BAR may not"
                );
            }
        }
    }
}

/// The SELECTION, proved with the same accept-counting probe the bar uses
/// (ai-remote-providers task 18).
///
/// Task 10's `default_off_proof` asks the gate directly, with a hand-built
/// mirror of what a request would do. This module asks the **wired** seam: a
/// registry with a real local arm and a Remote-class arm that opens a socket
/// when reached, driven through `engine_for` / `local_engine` exactly as a
/// command drives them. A zero here means the selection did not route there,
/// which is a stronger claim than "the gate returned Err".
#[cfg(test)]
mod selection_proof {
    use super::*;
    use protocol::PrefsView;
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, Instant};

    struct ConnectingEngine {
        port: u16,
    }

    impl Engine for ConnectingEngine {
        fn infer(&self, _p: &str) -> Result<String, EngineError> {
            let _ = std::net::TcpStream::connect(("127.0.0.1", self.port));
            Ok(String::from("remote answered"))
        }
    }

    struct LocalEngine;
    impl Engine for LocalEngine {
        fn infer(&self, _p: &str) -> Result<String, EngineError> {
            Ok(String::from("local answered"))
        }
    }

    fn counting_listener() -> (u16, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let accepts = Arc::new(AtomicUsize::new(0));
        let a2 = Arc::clone(&accepts);
        std::thread::spawn(move || {
            for _ in listener.incoming() {
                a2.fetch_add(1, Ordering::SeqCst);
            }
        });
        (port, accepts)
    }

    fn wait_for_accept(accepts: &Arc<AtomicUsize>) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if accepts.load(Ordering::SeqCst) > 0 {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }

    /// A local arm and a remote arm, both registered — the production shape.
    fn wired(port: u16) -> LocalInferenceState {
        LocalInferenceState::with_backends(
            vec![
                Backend::new(
                    "in-process",
                    BackendClass::InProcessLocal,
                    Arc::new(LocalEngine),
                ),
                Backend::new(
                    "remote",
                    BackendClass::Remote,
                    Arc::new(ConnectingEngine { port }),
                ),
            ],
            "in-process",
        )
        // The vault gate (myne-md/myne#437): a state with no active-vault reader
        // never selects remote, so every test that expects the remote arm has to
        // say which vault it is in — which is the property, not a nuisance.
        .with_active_vault_reader(Arc::new(|| Some(test_vault())))
    }

    /// The vault `wired()` claims to be unlocked, and the one `snap()` stamps.
    fn test_vault() -> crate::vault_id::VaultId {
        crate::vault_id::VaultId::parse("018f0000-0000-7000-8000-000000000001").expect("id")
    }

    /// A second, DIFFERENT vault — the cross-vault case.
    fn other_vault() -> crate::vault_id::VaultId {
        crate::vault_id::VaultId::parse("018f0000-0000-7000-8000-000000000002").expect("id")
    }

    fn snap(prefs: PrefsView) -> PrefsSnapshot {
        PrefsSnapshot {
            prefs,
            vault_id: Some(test_vault()),
        }
    }

    fn put(state: &LocalInferenceState, snapshot: Option<PrefsSnapshot>) {
        *state.snapshot_cell().write().expect("cell") = snapshot;
    }

    fn configured() -> PrefsView {
        PrefsView {
            ai_enabled: true,
            ai_provider: Some("openrouter".into()),
            ai_provider_consent: Some("openrouter@device".into()),
            ai_provider_key: Some(zeroize::Zeroizing::new("sk-test".into())),
            ai_provider_model: Some("some/model".into()),
            ..PrefsView::default()
        }
    }

    /// Registration is not selection, and every incomplete state routes local.
    #[test]
    fn the_remote_arm_is_registered_and_reached_only_when_the_preferences_say_so() {
        let (port, accepts) = counting_listener();
        let state = wired(port);

        let unconfigured: Vec<(&str, Option<PrefsSnapshot>)> = vec![
            ("vault locked — no snapshot at all", None),
            ("nothing configured", Some(snap(PrefsView::default()))),
            (
                "AI beta off",
                Some(snap(PrefsView {
                    ai_enabled: false,
                    ..configured()
                })),
            ),
            (
                "no provider named",
                Some(snap(PrefsView {
                    ai_provider: None,
                    ..configured()
                })),
            ),
            (
                "consent for a DIFFERENT provider",
                Some(snap(PrefsView {
                    ai_provider_consent: Some("ollama-cloud@device".into()),
                    ..configured()
                })),
            ),
            (
                "no key",
                Some(snap(PrefsView {
                    ai_provider_key: None,
                    ..configured()
                })),
            ),
            (
                "no model chosen (SYNC-24 ships no default)",
                Some(snap(PrefsView {
                    ai_provider_model: None,
                    ..configured()
                })),
            ),
        ];

        for (what, snapshot) in unconfigured {
            put(&state, snapshot);
            assert_eq!(state.active_class(), BackendClass::InProcessLocal, "{what}");
            assert_eq!(state.active_id(), "in-process", "{what}");
            let answer = state
                .engine_for(RequestClass::UserInitiated)
                .expect("local answers")
                .infer("x")
                .expect("local infers");
            assert_eq!(answer, "local answered", "{what}");
        }
        assert_eq!(
            accepts.load(Ordering::SeqCst),
            0,
            "an unconfigured vault must reach the provider ZERO times",
        );

        // The control arm. Without it every zero above is compatible with a
        // remote arm that could never be reached under any configuration.
        put(&state, Some(snap(configured())));
        assert_eq!(state.active_class(), BackendClass::Remote);
        assert_eq!(state.active_id(), "remote");
        let answer = state
            .engine_for(RequestClass::UserInitiated)
            .expect("remote answers")
            .infer("x")
            .expect("remote infers");
        assert_eq!(answer, "remote answered");
        assert!(wait_for_accept(&accepts), "the control arm must connect");
    }

    /// **What a NAMED provider is refusing over, one cause per state**
    /// (myne-md/myne#867).
    ///
    /// This table exists because the function it covers was a unit no test could
    /// fail: injected to return `None` unconditionally it left the whole
    /// `local_inference` suite green, while the chat surface reads it to decide
    /// which sentence to print. The row that earns its keep is the no-model one,
    /// and it is a REGRESSION row rather than a coverage row: the first version
    /// answered `NotReady` there, whose chip label is "No provider", which is the
    /// exact sentence the issue was filed about, for a vault that HAS a provider
    /// named.
    #[test]
    fn remote_refusal_names_the_reason_or_nothing_at_all() {
        let (port, _accepts) = counting_listener();
        let state = wired(port);
        let local_only = LocalInferenceState::with_backends(
            vec![Backend::new(
                "in-process",
                BackendClass::InProcessLocal,
                Arc::new(LocalEngine),
            )],
            "in-process",
        );

        // A build with no remote arm at all has nothing to refuse over.
        put(&local_only, Some(snap(configured())));
        assert_eq!(local_only.remote_refusal(), None, "no remote arm");

        let cases: Vec<(&str, Option<PrefsSnapshot>, Option<EngineError>)> = vec![
            ("vault locked, no snapshot", None, None),
            (
                "nothing configured",
                Some(snap(PrefsView::default())),
                // `None` rather than `FeatureOff`: the provider-name guard runs
                // FIRST, so a vault that has never named a provider has no refusal
                // to report at all. This row is why the table is worth having:
                // the first version asserted the GATE's order and was wrong.
                None,
            ),
            (
                "AI beta off",
                Some(snap(PrefsView {
                    ai_enabled: false,
                    ..configured()
                })),
                Some(EngineError::FeatureOff),
            ),
            (
                "no provider named",
                Some(snap(PrefsView {
                    ai_provider: None,
                    ..configured()
                })),
                None,
            ),
            (
                "a provider this build cannot reach",
                Some(snap(PrefsView {
                    ai_provider: Some("some-future-provider".into()),
                    ai_provider_consent: Some("some-future-provider@device".into()),
                    ..configured()
                })),
                Some(EngineError::NotReady),
            ),
            (
                "consent missing for the named provider",
                Some(snap(PrefsView {
                    ai_provider_consent: None,
                    ..configured()
                })),
                Some(EngineError::ConsentMissing),
            ),
            (
                "consent recorded for a DIFFERENT provider",
                Some(snap(PrefsView {
                    ai_provider_consent: Some("ollama-cloud@device".into()),
                    ..configured()
                })),
                Some(EngineError::ConsentMissing),
            ),
            (
                "no key",
                Some(snap(PrefsView {
                    ai_provider_key: None,
                    ..configured()
                })),
                Some(EngineError::NoCredential),
            ),
            // **The regression row.** `NoModel`, so the chip reads "No model"
            // rather than "No provider".
            (
                "no model chosen (SYNC-24 ships no default)",
                Some(snap(PrefsView {
                    ai_provider_model: None,
                    ..configured()
                })),
                Some(EngineError::NoModel),
            ),
            // Another vault's authorization is not this vault's answer, exactly
            // as `active()` refuses to select on it.
            (
                "the snapshot belongs to a different vault",
                Some(PrefsSnapshot {
                    prefs: configured(),
                    vault_id: Some(other_vault()),
                }),
                None,
            ),
            // The control arm: a fully configured provider has nothing to refuse
            // over, so every cause above is the state's and not the function's.
            ("fully configured", Some(snap(configured())), None),
        ];

        for (what, snapshot, expected) in cases {
            put(&state, snapshot);
            assert_eq!(state.remote_refusal(), expected, "{what}");
        }
    }

    /// A model swap invalidates the LOCAL arm even while a provider is active
    /// (myne-md/myne#440).
    ///
    /// `set_model_path` used to invalidate `engine_unclassified()` — the ACTIVE
    /// arm — and with a provider named that is the remote one, whose
    /// `invalidate_models` is the trait no-op. So the in-process arm went on
    /// serving the previously-loaded weights while the user believed the new
    /// model was in effect.
    #[test]
    fn a_model_swap_invalidates_every_arm_not_just_the_active_one() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        struct Counting(Arc<AtomicUsize>);
        impl Engine for Counting {
            fn infer(&self, _p: &str) -> Result<String, EngineError> {
                Ok(String::new())
            }
            fn invalidate_models(&self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }

        let local_hits = Arc::new(AtomicUsize::new(0));
        let state = LocalInferenceState::with_backends(
            vec![
                Backend::new(
                    "in-process",
                    BackendClass::InProcessLocal,
                    Arc::new(Counting(Arc::clone(&local_hits))),
                ),
                Backend::new("remote", BackendClass::Remote, Arc::new(LocalEngine)),
            ],
            "in-process",
        )
        .with_active_vault_reader(Arc::new(|| Some(test_vault())));

        // A provider IS active — without this the local arm would be the active
        // one and the assertion would hold for the wrong reason.
        put(&state, Some(snap(configured())));
        assert_eq!(state.active_class(), BackendClass::Remote);

        state.invalidate_all_models();
        assert_eq!(
            local_hits.load(Ordering::SeqCst),
            1,
            "the in-process arm caches the side-loaded weights and must be told, \
             whichever arm happens to be active"
        );
    }

    /// A snapshot read from ANOTHER vault never authorizes a provider
    /// (myne-md/myne#437).
    ///
    /// This is the consent violation, not a caching nit. The cell is
    /// process-global and nothing invalidated it on lock or unlock, so:
    /// configure a provider in vault A, lock A, unlock vault B, trigger an AI
    /// rewrite — and B's note text went to a provider B never named, under A's
    /// API key, even with the AI beta switched off in B.
    ///
    /// The fix is a property rather than a discipline: a snapshot carries the
    /// vault it was read from, and a mismatch resolves to the local arm. The
    /// third case is the one a discipline-shaped fix would miss — an
    /// unnameable vault (a contended slot lock) must be treated as a mismatch,
    /// because "cannot confirm" and "confirmed different" have to have the same
    /// consequence when the alternative is sending a note off the device.
    #[test]
    fn a_snapshot_from_another_vault_never_authorizes_a_provider() {
        let state = wired(1);

        // The control arm FIRST: without it every refusal below is compatible
        // with a remote arm that could never be selected under any conditions.
        put(&state, Some(snap(configured())));
        assert_eq!(
            state.active_class(),
            BackendClass::Remote,
            "the same vault's configured snapshot must select remote"
        );

        // Same preferences, different vault → local.
        put(
            &state,
            Some(PrefsSnapshot {
                prefs: configured(),
                vault_id: Some(other_vault()),
            }),
        );
        assert_eq!(
            state.active_class(),
            BackendClass::InProcessLocal,
            "another vault's authorization must not select remote"
        );

        // Same preferences, unnameable vault → local, for the same reason.
        put(
            &state,
            Some(PrefsSnapshot {
                prefs: configured(),
                vault_id: None,
            }),
        );
        assert_eq!(
            state.active_class(),
            BackendClass::InProcessLocal,
            "an unnameable vault must be treated as a mismatch, not waved through"
        );
    }

    /// The lock teardown drops the cached authorization, so the plaintext API
    /// key does not outlive the vault it belongs to (myne-md/myne#437).
    #[test]
    fn invalidate_drops_the_cached_authorization() {
        let state = wired(1);
        put(&state, Some(snap(configured())));
        assert_eq!(state.active_class(), BackendClass::Remote);

        state.invalidate();
        assert!(
            state.snapshot_cell().read().expect("cell").is_none(),
            "the cell must be empty, not merely unusable — it held the API key"
        );
        assert_eq!(state.active_class(), BackendClass::InProcessLocal);
    }

    /// With the remote arm ACTIVE, the two barred surfaces answer **locally**
    /// and open no socket. Barred from the remote arm, not barred from working
    /// — the distinction only becomes observable once the arm can be active,
    /// which is why it could not be tested before this task.
    #[test]
    fn ambient_and_local_only_requests_fall_back_to_the_local_arm_rather_than_failing() {
        let (port, accepts) = counting_listener();
        let state = wired(port);
        put(&state, Some(snap(configured())));
        assert_eq!(state.active_class(), BackendClass::Remote);

        let ghost = state
            .engine_for(RequestClass::Ambient)
            .expect("ambient still works")
            .infer("x")
            .expect("locally");
        assert_eq!(ghost, "local answered");

        let local = state
            .local_engine()
            .expect("the local-only door still works")
            .infer("x")
            .expect("locally");
        assert_eq!(local, "local answered");

        assert_eq!(
            accepts.load(Ordering::SeqCst),
            0,
            "a barred surface must not reach the provider, not even once",
        );
    }

    /// Withdrawing any one precondition mid-session routes the NEXT request
    /// back to the local arm. The selection is re-read per request precisely so
    /// this holds without a restart.
    #[test]
    fn revoking_mid_session_routes_the_next_request_locally() {
        let (port, accepts) = counting_listener();
        let state = wired(port);
        put(&state, Some(snap(configured())));
        assert_eq!(state.active_class(), BackendClass::Remote);

        put(
            &state,
            Some(snap(PrefsView {
                ai_provider_key: None,
                ai_provider_consent: None,
                ai_provider: None,
                ai_provider_model: None,
                ..configured()
            })),
        );
        assert_eq!(state.active_class(), BackendClass::InProcessLocal);
        let answer = state
            .engine_for(RequestClass::UserInitiated)
            .expect("local")
            .infer("x")
            .expect("local");
        assert_eq!(answer, "local answered");
        assert_eq!(accepts.load(Ordering::SeqCst), 0);
    }

    /// An impossible selection still fails loudly, as it did before the
    /// selection became dynamic — a typo naming a backend that is not
    /// registered chooses a different egress class, silently, if it is allowed
    /// to fall through.
    #[test]
    #[should_panic(expected = "is not registered")]
    fn an_unregistered_local_arm_is_still_a_startup_panic() {
        let _ = LocalInferenceState::with_backends(
            vec![Backend::new(
                "in-process",
                BackendClass::InProcessLocal,
                Arc::new(LocalEngine),
            )],
            "typo",
        );
    }
}
