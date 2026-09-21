// SPDX-License-Identifier: AGPL-3.0
//! The mobile agent's backend registry (myne-md/myne#456).
//!
//! **A phone's registry has no local model in it**, and that is the decision
//! rather than a gap. Running Candle on a phone is a separate call with its own
//! thermal, battery and model-size trade-offs, and myne-md/myne#456 explicitly
//! does not take it. So this registry holds two backends: the remote arm, and a
//! local arm that answers `NoModel`.
//!
//! **Why a local arm exists at all when there is no local model.** The registry
//! owns the rule that an ambient, background-class request is refused a
//! remote-class backend, a security decision about unmetered billing and silent
//! background egress: and that rule is written as "an ambient request is served
//! by the first non-remote backend". A registry with no such backend has nowhere
//! to send one. [`NoLocalEngine`] is the honest occupant of that slot: it says
//! there is no model here.
//!
//! The two alternatives are both worse and both plausible enough to name.
//! Registering `StubEngine` would have a shipped phone fabricating answers to
//! ambient requests. Registering the remote engine as the local arm would route
//! them off-device, which is the exact thing the refusal exists to stop.
//!
//! See: src-tauri/AGENTS.md "Secret-handling logging discipline".

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use myne_core::inference::agent_adapter::EngineAdapter;
use myne_core::inference::cancellable_io::CancelledFn;
use myne_core::inference::state::{
    remote_backend, ActiveVaultReader, Backend, BackendClass, LocalInferenceState, NoLocalEngine,
    PrefsCell, PrefsReader,
};

/// The app-managed registry the agent commands resolve.
///
/// A newtype over core's registry rather than a type alias, so this client's
/// `State<'_, …>` cannot be confused with a differently-populated one, and so
/// the "no local model here" fact has somewhere to be written down.
pub struct AgentInferenceState {
    inner: LocalInferenceState,
}

impl AgentInferenceState {
    /// Build the registry: a local arm that refuses, and the remote arm.
    ///
    /// `cell` is the shared preferences snapshot, and it is the SAME cell the
    /// selection consults, so the engine and the seam cannot disagree about what
    /// the preferences say.
    ///
    /// `cancelled` is the run's cancel source. It is taken here rather than
    /// defaulted to `|| false`, because a transport with no cancel source is a
    /// provider request that neither Stop nor the vault-lock teardown can
    /// interrupt.
    /// `prefs` and `active_vault` are the two readers the SELECTION needs, and
    /// without them the remote arm is unreachable no matter how the phone is
    /// configured.
    ///
    /// **This is not defensive plumbing.** `LocalInferenceState::active()`
    /// returns the local id on two independent short-circuits: an empty
    /// snapshot cell, which only `refresh()` fills and which `refresh()` leaves
    /// alone without a `PrefsReader`; and a snapshot whose `vault_id` does not
    /// equal the vault that is unlocked NOW, which without an
    /// `ActiveVaultReader` is never equal to anything. Built without them, every
    /// `agent_start` on a phone resolved `NoLocalEngine`, which answers
    /// `NoModel`, which `agent_error_of` reports as `EditFormatUnsupported`. The
    /// whole surface was inert while the settings panel, the model chooser and
    /// the consent screen all worked, because `agent_list_provider_models` reads
    /// the preferences directly and never goes through the registry.
    ///
    /// Desktop wires both at the same call site. Caught in review because the
    /// two tests below assert only the NEGATIVE direction, so they passed for
    /// the wrong reason; `a_configured_phone_selects_the_remote_arm` is the
    /// control arm that makes them mean something.
    pub fn new(
        cell: PrefsCell,
        cancelled: CancelledFn,
        prefs: PrefsReader,
        active_vault: ActiveVaultReader,
    ) -> Self {
        let inner = LocalInferenceState::with_backends(
            vec![
                Backend::new(
                    "no-local",
                    BackendClass::InProcessLocal,
                    Arc::new(NoLocalEngine),
                ),
                remote_backend(Arc::clone(&cell), cancelled),
            ],
            "no-local",
        )
        .with_snapshot_cell(cell)
        .with_prefs_reader(prefs)
        .with_active_vault_reader(active_vault);
        Self { inner }
    }

    /// Re-read the preferences into the snapshot cell.
    ///
    /// Called at the top of every command that can reach a provider, the way
    /// desktop does it: the selection is a function of preferences that the user
    /// may have changed since the last call, and a stale snapshot is how a
    /// revoked provider keeps answering.
    pub async fn refresh(&self) {
        self.inner.refresh().await;
    }

    /// Drop the cached preferences snapshot.
    ///
    /// **The snapshot is vault content and it holds the plaintext API key.**
    /// `prefs_reader` fills the cell with a whole `PrefsView`, whose
    /// `ai_provider_key` is a plaintext `Zeroizing<String>`. Desktop wipes
    /// exactly this on lock, and its call site names myne-md/myne#437 as the
    /// reason: the cached provider authorization used to be the one
    /// vault-derived secret that survived a teardown which wipes `root_key`,
    /// the search index, the spell dictionary and the vectors.
    ///
    /// Mobile had no way to say it. `AgentInferenceState` exposed only
    /// `registry()` and `engine_adapter()`, so `teardown_on_lock` cleared the
    /// run table and the session table and left the third piece of state this
    /// plugin manages untouched. `check-lock-teardown.mjs` could not see it
    /// either: its roster is keyed on named state types and had no row for this
    /// one, so the guard was green over a client that kept a plaintext API key
    /// resident past a lock.
    pub fn invalidate(&self) {
        self.inner.invalidate();
    }

    /// The registry, for the selection and the capability report.
    ///
    /// `cfg(test)` rather than an `allow(dead_code)`: production reaches the
    /// registry through [`Self::engine_adapter`], which is the only shape a run
    /// needs, and a second public door onto the same state is how a caller
    /// eventually bypasses the per-run cancel binding. The tests below need the
    /// registry directly to assert what the selection does, which is a question
    /// no adapter can answer.
    #[cfg(test)]
    pub fn registry(&self) -> &LocalInferenceState {
        &self.inner
    }

    /// The engine seam an agent run drives, bound to that run's cancel flag.
    ///
    /// Built per run rather than stored, because the cancel flag is the run's:
    /// a shared adapter would carry one run's Stop into the next.
    pub fn engine_adapter(&self, cancel: Arc<AtomicBool>) -> EngineAdapter<'_> {
        EngineAdapter {
            state: &self.inner,
            cancel,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use myne_core::inference::state::RequestClass;
    use std::sync::RwLock;

    fn state() -> AgentInferenceState {
        state_with(None, None)
    }

    /// The registry as this client builds it, over a given snapshot.
    ///
    /// `vault` is what the active-vault reader answers, and it has to MATCH the
    /// snapshot's own `vault_id` for the remote arm to be reachable: prefs are
    /// per vault, so a snapshot read from another one must not let this vault
    /// inherit its provider.
    fn state_with(
        snapshot: Option<myne_core::inference::state::PrefsSnapshot>,
        vault: Option<myne_core::vault_id::VaultId>,
    ) -> AgentInferenceState {
        let cell: PrefsCell = Arc::new(RwLock::new(snapshot));
        AgentInferenceState::new(
            cell,
            Arc::new(|| false),
            // No reader: every test here seeds the cell directly, which is the
            // state `refresh()` would have produced.
            Arc::new(|| Box::pin(async { None })),
            Arc::new(move || vault),
        )
    }

    fn configured(
        vault: myne_core::vault_id::VaultId,
    ) -> myne_core::inference::state::PrefsSnapshot {
        let prefs = protocol::PrefsView {
            ai_enabled: true,
            ai_provider: Some("openrouter".into()),
            ai_provider_consent: Some("openrouter@device".into()),
            ai_provider_key: Some(zeroize::Zeroizing::new("sk-test".to_string())),
            ai_provider_model: Some("a/model".into()),
            ..Default::default()
        };
        myne_core::inference::state::PrefsSnapshot {
            prefs,
            vault_id: Some(vault),
        }
    }

    /// **The control arm, and without it the two tests below hold for the wrong
    /// reason.**
    ///
    /// They assert that an unconfigured phone does not reach a provider, which
    /// was true of the shipped registry for a reason that had nothing to do
    /// with configuration: `new` wired neither the prefs reader nor the
    /// active-vault reader, so `active()` short-circuited to the local arm
    /// unconditionally and EVERY run on a phone answered `NoModel`. Both
    /// negative tests passed over a surface that could not work at all. Caught
    /// in review; this is the assertion that makes them mean something.
    #[test]
    fn a_configured_phone_selects_the_remote_arm() {
        let vault = myne_core::vault_id::VaultId::mint();
        let s = state_with(Some(configured(vault)), Some(vault));
        assert_eq!(
            s.registry().active_class(),
            BackendClass::Remote,
            "a phone with the provider, the consent, the key and the model named must reach it"
        );
    }

    /// The cached snapshot is DROPPED on invalidate, which is what the lock path
    /// calls.
    ///
    /// The snapshot holds `ai_provider_key` as a plaintext `Zeroizing<String>`,
    /// so this is the assertion behind the teardown rather than a coverage
    /// gesture: a phone that keeps selecting the remote arm after a lock is a
    /// phone still holding that key.
    #[test]
    fn invalidating_drops_the_cached_snapshot_and_with_it_the_provider_key() {
        let vault = myne_core::vault_id::VaultId::mint();
        let s = state_with(Some(configured(vault)), Some(vault));
        assert_eq!(
            s.registry().active_class(),
            BackendClass::Remote,
            "precondition: the fixture must reach the remote arm, or this asserts nothing"
        );

        s.invalidate();

        assert_eq!(
            s.registry().active_class(),
            BackendClass::InProcessLocal,
            "after invalidate the snapshot is gone, so the selection cannot reach a provider"
        );
    }

    /// `teardown_on_lock` CALLS it, asserted at the source.
    ///
    /// The behavioural test above proves `invalidate` works and says nothing
    /// about whether the lock path reaches it, which is the half that was
    /// missing: the hook cleared two of its three states and shipped.
    /// `scripts/check-lock-teardown.mjs` cannot close that, and its header now
    /// says why: its only assertion on an implemented hook is non-emptiness, so
    /// on a hook with three holders, losing one clear leaves the body non-empty
    /// and the guard green. A per-holder text check was written and reverted,
    /// because these hooks are thin wrappers that delegate and requiring the body
    /// to name its type reported ten false findings on a correct tree.
    ///
    /// What is a call-graph question in general is a text question in THIS file,
    /// so it is asked here. Driven at the source, the way
    /// `cli_bridge::socket`'s accept-loop test is, because constructing a real
    /// `AppHandle` in a unit test is not available.
    #[test]
    fn the_lock_teardown_reaches_the_inference_state() {
        let src = include_str!("mod.rs");
        let at = src
            .find("pub fn teardown_on_lock")
            .expect("teardown_on_lock must exist");
        let end = src[at..]
            .find("\n}\n")
            .map(|i| at + i)
            .expect("its body must end");
        let body = &src[at..end];

        for state in ["AgentRunState", "AgentSessionState", "AgentInferenceState"] {
            assert!(
                body.contains(state),
                "teardown_on_lock no longer clears {state}; all three are plaintext-derived \
                 and the third holds the provider key"
            );
        }
    }

    /// And the snapshot's vault has to be the one that is open.
    ///
    /// Asserted separately because it is the half a single positive test hides:
    /// wiring only the prefs reader would pass the test above and still let a
    /// vault the user never configured for AI inherit another vault's provider.
    #[test]
    fn a_snapshot_from_another_vault_does_not_select_the_remote_arm() {
        let read_from = myne_core::vault_id::VaultId::mint();
        let open_now = myne_core::vault_id::VaultId::mint();
        let s = state_with(Some(configured(read_from)), Some(open_now));
        assert_eq!(
            s.registry().active_class(),
            BackendClass::InProcessLocal,
            "preferences read from a different vault may not select a provider for this one"
        );
    }

    /// A phone answers an ambient request with "there is no model", never by
    /// reaching a provider.
    ///
    /// This is the mobile face of the registry's ambient-versus-remote refusal,
    /// and it is worth asserting HERE rather than trusting the shared rule: the
    /// rule routes an ambient request to the first non-remote backend, and what
    /// occupies that slot is this client's choice. A `StubEngine` there would
    /// pass the shared rule's own tests while having a shipped phone fabricate
    /// answers.
    #[test]
    fn an_ambient_request_finds_no_model_rather_than_a_provider() {
        let s = state();
        let engine = s
            .registry()
            .engine_for(RequestClass::Ambient)
            .expect("the local arm resolves");
        assert!(
            engine.infer("anything").is_err(),
            "a phone has no local model, and the local arm must say so"
        );
    }

    /// With nothing configured, a user-initiated request is served locally too,
    /// which on this client means refused.
    ///
    /// The point is the ABSENCE of a socket: an unconfigured phone must not
    /// select the remote arm, and the gate's own accept-counting proof covers
    /// the general rule. This asserts the registry this client actually builds
    /// is subject to it.
    #[test]
    fn an_unconfigured_phone_does_not_select_the_remote_arm() {
        let s = state();
        assert_eq!(
            s.registry().active_class(),
            BackendClass::InProcessLocal,
            "with no provider named, nothing may select the remote arm"
        );
    }
}
