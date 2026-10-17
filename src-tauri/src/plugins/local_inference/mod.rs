// SPDX-License-Identifier: AGPL-3.0
//! `local-inference` plugin — on-device LLM engine behind an
//! [`Engine`] trait (local-ai epic, MYND-406).
//!
//! **The `local-inference` cargo feature is in `default` (`decisions.md`
//! 2026-07-02).** This module used to say the opposite — that the default
//! auditable binary carries zero AI symbols — and that has been false since
//! that entry: CI compiles the whole AI tree with no `--features` flag. The
//! AI-free auditable binary is now the **`--no-default-features`** build, and
//! even that one still contains the OCR extractor (`decisions.md` 2026-07-31,
//! MYND-441). The `#[cfg]` gates in this tree are correct; only the prose was
//! wrong, and a refactor that rewrote these files would have copied it forward.
//!
//! Shape: the plugin skeleton (`mod`/`commands`/`state`/`error`, the canonical
//! `vault_creation` shape); the [`Engine`] trait — **fourteen methods**, not the
//! two the header used to claim; the Candle engine, which
//! shipped; a [`StubEngine`] for the E2E build variant; the model side-load
//! path (`model_store`); the `#[tauri::command]` surface + the scoped runtime
//! capability; and, since ai-provider-seam, a **backend registry** with a
//! declared class per backend. The keyless sandboxed sidecar is still the one
//! deferred piece (`threat-model.md` §7).
//!
//! Logging: DENY-list clean (`src-tauri/AGENTS.md`) — the engine seam never
//! logs a prompt or note body.
//!
//! **The SYNC-14 ambient bar, and what it does not defend against.** Ambient
//! requests — ghost text, the auto-tag pass — are refused a remote-class backend
//! by [`state::LocalInferenceState`], in the
//! seam rather than behind a setting. Be precise about the residual: a
//! compromised or dev-tools-driven WebView can invoke the *user-initiated*
//! commands directly with arbitrary note text, so this bar is **not** a TB6
//! defence and is not offered as one. It constrains **Myne's own code** from
//! routing traffic remotely that the user never asked to send. The two reasons
//! it exists (`sync-ledger` SYNC-14) are the distance between "I enabled AI"
//! and "every sentence I type goes to a broker", and cost — a per-keystroke
//! surface against a metered API is an uncapped bill before it is a privacy
//! question.

pub mod audio;
pub mod cancel;
pub mod commands;
pub mod compute_priority;
/// Threaded proof of the compute-lock priority policy (MYND-651 task 11). Its
/// own module rather than more `#[cfg(test)]` in `commands.rs`, because it needs
/// two runtimes and a real vault on disk — nothing the unit tests around it do.
#[cfg(test)]
mod compute_priority_integration;
/// On-demand model downloads (myne-md/myne#805): the compiled-in artefact
/// table, staging/verify/register orchestration and the per-download cancel
/// registry. The socket itself lives in `myne_core::inference::model_download`.
pub mod download;
pub mod endpoint_config;
pub mod engine_candle;
pub mod engine_ollama;
pub mod model_store;
pub mod whisper;

// The inference seam moved to `myne-core` (myne-md/myne#456): the `Engine`
// trait, the error type, the ChatML sanitizer, the cancellable-IO wrapper, the
// backend registry with its ambient-versus-remote refusal, and the whole
// remote-provider arm. What stays above is the LOCAL half, the Candle engine,
// the Ollama loopback engine, the model store:
// plus this plugin's Tauri surface.
//
// Re-exported as modules rather than as a flat list of items so every existing
// `super::engine::…` / `super::state::…` path in this tree keeps resolving. The
// alternative, rewriting several hundred call sites to `myne_core::inference::`,
// would have buried the actual move in noise and made the diff unreviewable for
// the one property this change has to demonstrate: that desktop behaviour is
// unchanged.
//
// These are behind `myne-core/remote-ai`, which this crate's `local-inference`
// feature turns on, so the whole set is absent from the auditable
// `--no-default-features` build exactly as it was when the files lived here.
// `provider_gate` is re-exported with no in-crate reader today: the gate is
// called from `myne-core`'s own command half now, and this crate names only the
// registry and the transport. Kept because callers in this tree have
// historically reached for the whole set together, and a re-export list that
// tracks today's call sites is a list that churns.
#[allow(unused_imports)]
pub use myne_core::inference::{
    cancellable_io, chatml, engine, error, provider_gate, provider_registry, provider_transport,
    state,
};

// Sibling-facing API (AI capability features, tasks 3–7): the stable
// `local_inference::{Engine, StubEngine, EngineError}` path — siblings reach
// inference ONLY through the `Engine` trait. Not yet consumed in-crate; the
// first sibling to import inference removes this allow.
#[allow(unused_imports)]
pub use self::{
    engine::{Engine, StubEngine},
    error::EngineError,
};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Manager, Runtime};

/// The scoped capability granted to the main window, added at RUNTIME (task 6).
///
/// It is NOT a static `capabilities/*.json` entry on purpose: the whole plugin
/// is behind the default-off `local-inference` feature, and a static entry
/// referencing `local-inference:default` would make the feature-OFF build fail
/// on an unresolved permission. Adding it at runtime — only when this
/// feature-gated plugin is registered — keeps the default build clean. Grants
/// ONLY `local-inference:default` (infer); no core/fs/dialog/clipboard
/// and no network *capability*. Since `decisions.md` 2026-08-09 that is a fact
/// about this ACL entry, not about the AI path — a user-named provider reaches
/// the network through `std::net`, which no Tauri capability governs.
///
/// The `allow-infer` command permission is auto-generated by the `CARGO_FEATURE_LOCAL_INFERENCE`-gated `InlinedPlugin`
/// in `build.rs`; referencing them directly (rather than a toml-defined
/// `default` set) means there is NO `permissions/local-inference/` directory to
/// be scanned + dangle in the feature-OFF build.
const LOCAL_INFERENCE_CAPABILITY: &str = r#"{
  "identifier": "local-inference",
  "description": "On-device AI inference commands (infer) for the main window; no core/fs/dialog/clipboard. This grant confers no network capability, but that is a property of the ACL entry, not of the AI path: since decisions.md 2026-08-09 the path may open a socket to a user-named provider, and since myne-md/myne#805 it may also fetch a model on explicit user action from the compiled-in origin downloads.myne.md (no note content, digest-verified before registration; decisions/ai/0627, threat-model TB14).",
  "windows": ["main"],
  "permissions": ["local-inference:allow-infer", "local-inference:allow-infer-ambient", "local-inference:allow-infer-batch", "local-inference:allow-chat-stop", "local-inference:allow-transcribe", "local-inference:allow-read-transcript", "local-inference:allow-suggest-tags", "local-inference:allow-tag-model-available", "local-inference:allow-set-model-path", "local-inference:allow-get-model-path", "local-inference:allow-ai-capability-report", "local-inference:allow-get-ai-endpoint", "local-inference:allow-set-ai-endpoint", "local-inference:allow-list-provider-models", "local-inference:allow-download-model", "local-inference:allow-cancel-model-download", "local-inference:allow-remove-model"]
}"#;

/// Best-effort teardown of the plugin's vault-derived RAM state on lock
/// (semantic-search-qa task 2). Aborts every in-flight request — the chat
/// transcript is RAM-only and dropped on lock (the frontend `clearChat` wipe),
/// so no generation may keep emitting into a torn-down transcript — and
/// invalidates the cached provider authorization, which holds the plaintext API
/// key (myne-md/myne#437). Wired into every slot-drop site so neither a
/// plaintext-derived buffer nor the cached credential outlives the slot: manual
/// `vault_lock`, idle auto-lock, `vault_delete`, and credential-rotation relock.
/// Sync and infallible; a missing managed state is a silent no-op.
pub fn teardown_on_lock<R: Runtime>(app: &tauri::AppHandle<R>) {
    // Abort any in-flight streaming chat generation first (conversational-ai-chat
    // task 4/12): the chat transcript is RAM-only and dropped on lock (the
    // frontend `clearChat` wipe), so a generation must not keep running — holding
    // the compute lock — or emitting into a torn-down transcript after the vault
    // locks. The publish-guarded `guarded_on_token` sees the flag and breaks.
    if let Some(cancel) = app.try_state::<cancel::CancelRegistry>() {
        // EVERY in-flight request, not the newest: chat history is RAM-only and
        // dropped on lock, so no generation may keep emitting into a torn-down
        // transcript. This is the one abort path that must be total.
        cancel.cancel_all();
    }
    // The cached provider authorization is vault content too — it holds the
    // plaintext API key (myne-md/myne#437). It used to be the one vault-derived
    // secret that survived a teardown which wipes `root_key`, the search index
    // and the spell dictionary.
    if let Some(state) = app.try_state::<state::LocalInferenceState>() {
        state.invalidate();
    }
}

/// Construct the `local-inference` plugin.
///
/// Manages the [`state::LocalInferenceState`] engine singleton, binds the
/// `infer` `#[tauri::command]`s, and adds the scoped
/// [`LOCAL_INFERENCE_CAPABILITY`] at runtime. Only reachable when the
/// `local-inference` feature is enabled.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("local-inference")
        .invoke_handler(tauri::generate_handler![
            commands::infer,
            commands::infer_ambient,
            commands::infer_batch,
            commands::chat_stop,
            commands::transcribe,
            commands::read_transcript,
            commands::suggest_tags,
            commands::tag_model_available,
            commands::set_model_path,
            commands::get_model_path,
            commands::ai_capability_report,
            commands::get_ai_endpoint,
            commands::set_ai_endpoint,
            commands::list_provider_models,
            commands::download_model,
            commands::cancel_model_download,
            commands::remove_model
        ])
        .setup(|app, _api| {
            // Path resolution only — the engine decision itself lives in
            // `resolve_engine` so a test can reach it (this closure cannot be
            // called without a Tauri runtime, which is why the fork had zero
            // tests before SYNC-9).
            let base =
                crate::paths::app_data_dir(app).unwrap_or_else(|_| std::path::PathBuf::from("."));
            let resource_dir = app.path().resource_dir().ok();
            // The device-local endpoint config. `Err` (no config dir at all)
            // resolves to "no endpoint", i.e. the in-process arm — fail-closed
            // in the direction that sends nothing anywhere.
            let endpoint_path = app
                .path()
                .app_config_dir()
                .ok()
                .map(|d| endpoint_config::endpoint_path_in(&d));
            let (mut backends, active) = resolve_backends(
                base,
                resource_dir.as_deref(),
                endpoint_path.as_deref(),
                cancel_source(app.clone()),
            );
            // The remote arm is always REGISTERED and never active by
            // registration alone (see `remote_backend`). It shares the state's
            // snapshot cell, so the engine's authorization and the seam's
            // selection read one set of facts.
            let cell: state::PrefsCell = std::sync::Arc::new(std::sync::RwLock::new(None));
            // A real abort source for the provider transport (myne-md/myne#440).
            // It reaches the registry through the AppHandle rather than holding
            // an `Arc` of it, because the registry stays managed AS
            // `CancelRegistry` — managing an `Arc<CancelRegistry>` instead would
            // compile fine and then make every `State<'_, CancelRegistry>`
            // command fail to resolve at runtime.
            backends.push(remote_backend(
                std::sync::Arc::clone(&cell),
                cancel_source(app.clone()),
            ));
            app.manage(
                state::LocalInferenceState::with_backends(backends, active)
                    .with_snapshot_cell(cell)
                    .with_prefs_reader(prefs_reader(app.clone()))
                    .with_active_vault_reader(active_vault_reader(app.clone())),
            );
            // Per-request cancel tokens (task 4/5). Every command that carries a
            // prompt to a backend takes one for the duration and hands the
            // engine a predicate reading ONLY its own token (#445); `chat_stop`
            // cancels the newest request that has a Stop button, and the
            // vault-lock teardown (task 12) cancels every one of them.
            app.manage(cancel::CancelRegistry::default());
            // Compute-lock priority register (auto-tag, MYND-651 task 4): the
            // user-initiated commands register here for the length of their
            // call, and the background tag pass stands down while any of them
            // is pending. The single `compute` mutex cannot express an ordering
            // on its own — this is that ordering.
            app.manage(compute_priority::ComputePriority::default());
            // Per-download cancel tokens (myne-md/myne#805): the download
            // command registers here for the length of its fetch, and
            // `cancel_model_download` cancels one by the id the surface minted.
            app.manage(download::DownloadCancels::default());
            app.add_capability(LOCAL_INFERENCE_CAPABILITY)?;
            Ok(())
        })
        .build()
}

/// Decide which [`engine::Engine`] this build runs, from **values** rather than
/// an `AppHandle`.
///
/// Engine selection is still a COMPILE-TIME choice, not a runtime hook:
///   - production (`--features local-inference`) → the Candle engine,
///     lazy-loading the user's side-loaded models; no model set → `NotReady`
///     per call (the UI shows the error state).
///   - E2E (`--features local-inference-stub`) → the deterministic
///     `StubEngine`, so the tauri-driver flow-suite gets stable output
///     (`stub-infer: …`) without shipping a model into the
///     repo. A feature-flagged E2E *build* variant — the audited production
///     bundle never enables it.
///
/// Extracting it out of `init`'s `.setup()` closure is a behaviour-preserving
/// move (SYNC-9). The point is testability: the closure needs a Tauri runtime,
/// so the fork inside it could not be characterized, which is what made "the
/// provider-registry refactor changed nothing" an unfalsifiable claim.
/// Kept **for the characterization tests only**. Task 4's contract is that
/// task 1's tests pass *unmodified* across the registry refactor, and they call
/// this shape; production now goes through [`resolve_backend`], which carries
/// the class as well.
#[cfg(test)]
pub(crate) fn resolve_engine(
    base: std::path::PathBuf,
    resource_dir: Option<&std::path::Path>,
) -> std::sync::Arc<dyn engine::Engine> {
    resolve_backend(base, resource_dir).engine()
}

/// The same decision as [`resolve_engine`], carrying the backend's identity and
/// [`state::BackendClass`] alongside the implementation.
///
/// Which backends exist is still compile-time — the E2E stub is a **build**
/// variant and a production bundle must not be able to reach it. What became
/// runtime is the *resolution*: the registry is looked up by id at startup
/// rather than selected by a `#[cfg]` inside the plugin's setup closure.
pub(crate) fn resolve_backend(
    base: std::path::PathBuf,
    resource_dir: Option<&std::path::Path>,
) -> state::Backend {
    #[cfg(feature = "local-inference-stub")]
    {
        let _ = (base, resource_dir);
        state::Backend::new(
            "stub",
            state::BackendClass::InProcessLocal,
            std::sync::Arc::new(engine::StubEngine),
        )
    }
    #[cfg(not(feature = "local-inference-stub"))]
    {
        // The bundled default transcription model (voice-to-text, MYND-270),
        // resolved from the Tauri resource dir — `None` when none ships (an
        // AI-free `--no-default-features` build, or a checkout whose LFS model
        // blob was not fetched), leaving STT side-load-only.
        let bundled_transcription = resource_dir.and_then(model_store::bundled_transcription_model);
        // The auto-tag task-model: the downloaded or side-loaded override
        // (`tag.path`) if set, else the bundled default (MYND-651; override
        // added with myne-md/myne#805, `decisions/ai/0627`). `None` from both
        // arms means this build simply has no auto-tag.
        let bundled_tag = resource_dir.and_then(model_store::bundled_tag_model);
        state::Backend::new(
            "candle",
            state::BackendClass::InProcessLocal,
            std::sync::Arc::new(
                engine_candle::CandleEngine::new(base)
                    .with_bundled_transcription(bundled_transcription)
                    // The bundled default only. `load_tag` re-resolves the
                    // stored `tag.path` override lazily at each call, so a model
                    // downloaded at runtime takes effect without a restart
                    // (myne-md/myne#805).
                    .with_bundled_tag_model(bundled_tag),
            ),
        )
        // One `compute` mutex serializes every model call — a Metal
        // crash-safety invariant, not a perf knob. This is what makes
        // `Deferred` reachable.
        .serializing_compute()
    }
}

/// The registry as `init` installs it: every backend this build can reach, plus
/// which one is active.
///
/// **Which backends exist stays compile-time**; what became runtime is which is
/// *selected*. The in-process arm is always registered — it is what a user with
/// no endpoint gets, and what the ambient surface falls back to
/// being barred against. The `ollama` arm is registered only when the
/// device-local config names both a validated loopback URL **and** a model
/// (SYNC-24), and when it is, it is the active one: a user who named a runtime
/// asked for it.
///
/// The default state is the load-bearing half (`decisions.md` 2026-08-09): with
/// nothing configured, the remote-capable arm is **not in the registry at all**,
/// so it is unreachable rather than merely unselected.
///
/// Class is `LoopbackLocal`, not `Remote`: the validator admits only the three
/// literal loopback names for plain `http`, so the bytes do not leave the
/// device — a runtime on this machine is a different trust boundary (TB12,
/// not TB13).
pub(crate) fn resolve_backends(
    base: std::path::PathBuf,
    resource_dir: Option<&std::path::Path>,
    endpoint_path: Option<&std::path::Path>,
    // The loopback arm's abort source (myne-md/myne#440). Taken rather than
    // defaulted so a caller has to supply one or say `|| false` deliberately.
    cancelled: cancellable_io::CancelledFn,
) -> (Vec<state::Backend>, &'static str) {
    let in_process = resolve_backend(base, resource_dir);
    let in_process_id = in_process.id();

    let configured = endpoint_path.is_some_and(|p| {
        endpoint_config::read_endpoint(p)
            .ok()
            .flatten()
            .is_some_and(|e| e.usable())
    });
    if !configured {
        return (vec![in_process], in_process_id);
    }

    let path = endpoint_path.expect("checked above").to_path_buf();
    let ollama = state::Backend::new(
        "ollama",
        state::BackendClass::LoopbackLocal,
        std::sync::Arc::new(engine_ollama::ConfiguredOllamaEngine::new(path, cancelled)),
    );
    // Deliberately NOT `.serializing_compute()`: the work happens in another
    // process with its own scheduler, so there is no Myne-side lock and
    // `Deferred` is not reachable for this arm. Declaring it would make the
    // capability report promise a queue that does not exist.
    (vec![in_process, ollama], "ollama")
}

/// Read the preference facts the selection depends on, from the running app.
///
/// Async, and it has to be: `vault.prefs` is encrypted vault content, so
/// answering "has the user named a provider" means decrypting a blob with the
/// unlocked `root_key`. That is why the seam refreshes rather than caching at
/// startup — `resolve_backends` runs before any vault exists.
///
/// Every failure resolves to `None`, which the seam reads as the local arm:
/// no active vault, no vault directory, a locked slot, an unreadable blob. The
/// fail-closed direction here is "answer locally", never "assume configured".
/// The **fallback** abort source baked into every engine at plugin setup
/// (myne-md/myne#440), for the calls that name no request.
///
/// Since #445 the four prompt-bearing commands hand their engine a predicate
/// reading their own token instead, so this no longer decides whether a chat
/// turn or a rewrite can be stopped. What still rides it: the provider model
/// list — a short call with no `CancelGuard` of its own. It stays fleet-wide and
/// therefore coarse in both directions, which is stated on
/// [`cancel::CancelRegistry::any_cancelled`] rather than left to be discovered.
///
/// `false` until the registry exists — during plugin setup the engines are built
/// before `app.manage`, and "not yet cancellable" is the correct answer for a
/// request that cannot have started.
fn cancel_source<R: Runtime>(app: tauri::AppHandle<R>) -> cancellable_io::CancelledFn {
    std::sync::Arc::new(move || {
        app.try_state::<cancel::CancelRegistry>()
            .map(|r| r.any_cancelled())
            .unwrap_or(false)
    })
}

/// The synchronous half of the #437 gate: which vault is unlocked right now.
///
/// Best-effort by construction — `active_vault_id_now` answers `None` when the
/// slot lock is contended, and the seam treats that as "cannot confirm", which
/// resolves to the local arm. The gate's failure mode is in-process inference,
/// never another vault's provider.
fn active_vault_reader<R: Runtime>(app: tauri::AppHandle<R>) -> state::ActiveVaultReader {
    std::sync::Arc::new(move || {
        app.try_state::<crate::plugins::vault_unlock::state::VaultRuntimeState>()?
            .active_vault_id_now()
    })
}

fn prefs_reader<R: Runtime>(app: tauri::AppHandle<R>) -> state::PrefsReader {
    std::sync::Arc::new(move || {
        let app = app.clone();
        Box::pin(async move {
            let vault =
                app.try_state::<crate::plugins::vault_unlock::state::VaultRuntimeState>()?;
            let dir =
                crate::paths::active_vault_root_io(&app, vault.active_vault_id().await).ok()?;
            let prefs = myne_core::plugins::prefs::commands::prefs_read_with_dir(
                &dir,
                &vault,
                &myne_core::vault_io::StdVaultIo,
            )
            .await
            .ok()?;
            // Stamp the vault this was read from (myne-md/myne#437) — the seam
            // refuses to route remote unless it still matches the unlocked one.
            Some(state::PrefsSnapshot {
                prefs,
                vault_id: vault.active_vault_id().await,
            })
        })
    })
}

// `remote_backend` moved to `myne-core` with the inference seam
// (myne-md/myne#456): nothing in it was desktop-specific, and mobile registers
// the same arm. Re-exported so the call site in `init` and any reader who comes
// looking for it here still find it.
pub use myne_core::inference::state::remote_backend;

#[cfg(test)]
mod resolve_engine_tests {
    use super::*;

    /// Characterization, stub build: the resolver must still pick `StubEngine`,
    /// and it is recognized by its behaviour rather than its type — the whole
    /// point of the seam is that callers only ever see `dyn Engine`.
    #[cfg(feature = "local-inference-stub")]
    #[test]
    fn stub_build_resolves_the_stub_engine() {
        let engine = resolve_engine(std::env::temp_dir(), None);
        let out = engine.infer("hello").expect("stub infers");
        assert!(
            out.starts_with("stub-infer:"),
            "stub build must resolve StubEngine, got: {out}"
        );
        // The stub reports a tag model as present so the tag surface is
        // exercisable in E2E. Pinned because #191's unavailable-path coverage
        // depends on knowing this is the stub's answer, not the product's.
        assert!(engine.tag_model_available());
    }

    /// Characterization, production build: constructing the Candle engine must
    /// not panic with an empty base dir and no resource dir, and a build with
    /// no bundled tag blob must report the tag model absent rather than fail.
    #[cfg(not(feature = "local-inference-stub"))]
    #[test]
    fn production_build_constructs_without_models_and_reports_tag_absent() {
        let engine = resolve_engine(std::env::temp_dir(), None);
        assert!(
            !engine.tag_model_available(),
            "no resource dir means no bundled tag model"
        );
    }

    /// A resource dir that exists but holds no model blob resolves to `None`
    /// rather than failing construction — the case a checkout with unfetched
    /// LFS blobs actually hits.
    #[cfg(not(feature = "local-inference-stub"))]
    #[test]
    fn missing_bundled_blob_resolves_to_none_not_an_error() {
        // `temp_dir()` exists and demonstrably holds no `models/tag/model.gguf`
        // — the shape a checkout with unfetched LFS blobs presents.
        let resources = std::env::temp_dir();
        let engine = resolve_engine(std::env::temp_dir(), Some(resources.as_path()));
        assert!(!engine.tag_model_available());
    }

    /// The three-way ACL wiring check.
    ///
    /// `src-tauri/AGENTS.md` states the gap this closes: *"An ACL entry does
    /// not wire a command — and nothing checks that it does."* A command can
    /// have its `build.rs` declaration and its capability permission, be
    /// missing from `generate_handler!`, and still compile, pass clippy, render
    /// its UI and be dead at runtime. MYND-441 shipped exactly that once and it
    /// was caught in review rather than by a tool.
    ///
    /// So: read all three lists out of the sources and compare them **both
    /// ways**. A command in one list and not another fails, and so does a
    /// permission for a command that no longer exists.
    #[test]
    fn build_rs_capability_json_and_generate_handler_agree() {
        fn kebab(s: &str) -> String {
            s.replace('_', "-")
        }

        // 1. build.rs — the InlinedPlugin command list.
        let build_rs = include_str!("../../../build.rs");
        // Anchor on the plugin NAME first: build.rs declares many plugins, and
        // searching for the InlinedPlugin literal alone finds whichever one is
        // declared earliest. The self-guard below caught exactly that.
        let anchor = build_rs
            .find("\"local-inference\",")
            .expect("the local-inference plugin must be declared in build.rs");
        let start = anchor
            + build_rs[anchor..]
                .find("InlinedPlugin::new().commands(&[")
                .expect("the local-inference InlinedPlugin block must exist");
        let block = &build_rs[start..start + build_rs[start..].find("])").unwrap()];
        let mut declared: Vec<String> = block
            .split('"')
            .filter(|t| !t.is_empty() && t.chars().all(|c| c.is_ascii_lowercase() || c == '_'))
            .map(str::to_string)
            .collect();
        declared.sort();
        declared.dedup();

        // 2. The runtime capability JSON's permissions.
        let mut permitted: Vec<String> = LOCAL_INFERENCE_CAPABILITY
            .split('"')
            .filter_map(|t| t.strip_prefix("local-inference:allow-"))
            .map(str::to_string)
            .collect();
        permitted.sort();

        // 3. generate_handler! — the registration nothing else checks.
        let this_file = include_str!("mod.rs");
        let h_start = this_file
            .find("tauri::generate_handler![")
            .expect("generate_handler! must exist");
        let handler = &this_file[h_start..h_start + this_file[h_start..].find(']').unwrap()];
        let mut registered: Vec<String> = handler
            .split("commands::")
            .skip(1)
            .map(|t| {
                t.trim_matches(|c: char| !(c.is_ascii_lowercase() || c == '_'))
                    .to_string()
            })
            .collect();
        registered.sort();

        assert!(
            declared.len() >= 12,
            "parsed only {} commands out of build.rs — the parse broke, and a \
             guard that reads nothing passes everything",
            declared.len()
        );
        assert_eq!(
            registered, declared,
            "generate_handler! and build.rs disagree. A command declared but not \
             registered compiles, passes clippy, renders its UI and is DEAD at \
             runtime (src-tauri/AGENTS.md)."
        );
        let expected_permissions: Vec<String> = declared.iter().map(|c| kebab(c)).collect();
        assert_eq!(
            permitted, expected_permissions,
            "the runtime capability JSON's permissions and the command list \
             disagree. The ACL is fail-closed, so a missing permission is a \
             rejected invoke; a stale one is a widened surface nobody asked for."
        );
    }

    /// SYNC-14, at the command layer: ghost text's own entry point declares the
    /// ambient class, and `infer` does not. Asserted against the constants the
    /// command bodies actually use — a test that re-stated the classification
    /// would only prove the copy agrees with itself.
    #[test]
    fn ghost_text_is_ambient_and_infer_is_not() {
        use commands::{INFER_AMBIENT_CLASS, INFER_CLASS};
        use state::{BackendClass, LocalInferenceState, RequestClass};

        assert_eq!(INFER_AMBIENT_CLASS, RequestClass::Ambient);
        assert_eq!(INFER_CLASS, RequestClass::UserInitiated);

        // Adversarial: with a remote-class backend active, the ghost-text class
        // is refused and the user-initiated one is not. No socket — the fake
        // backend only declares its class.
        let remote = LocalInferenceState::with_backends(
            vec![state::Backend::new(
                "fake-remote",
                BackendClass::Remote,
                std::sync::Arc::new(engine::StubEngine),
            )],
            "fake-remote",
        );
        assert_eq!(
            remote.engine_for(INFER_AMBIENT_CLASS).err(),
            Some(error::EngineError::RemoteBarred),
            "ghost text must not reach a remote backend"
        );
        assert!(
            remote.engine_for(INFER_CLASS).is_ok(),
            "user-initiated writing may reach a remote backend — without this \
             arm a bar that refused everything would look correct"
        );
    }

    /// The capability report is built from the seam's own policy decisions, not
    /// from a second copy of them. Asserted adversarially: with a remote-class
    /// backend active, the two barred features must report the **named** cause
    /// from the `EngineError` taxonomy, and the user-initiated ones must not.
    #[test]
    fn capability_report_reuses_the_engine_error_taxonomy_for_its_causes() {
        use commands::capability_report_from;
        use state::{Backend, BackendClass, LocalInferenceState};

        let remote = LocalInferenceState::with_backends(
            vec![Backend::new(
                "fake-remote",
                BackendClass::Remote,
                std::sync::Arc::new(engine::StubEngine),
            )],
            "fake-remote",
        );
        // Every model claimed present, so the only thing that can block a
        // feature here is the SYNC-14/16 bar itself.
        let report = capability_report_from(&remote, true, true);

        assert!(report.compiled);
        assert_eq!(report.backend_class, "remote");
        // A registry whose ONLY backend is remote has nowhere to fall back to,
        // so the barred surfaces really are unavailable — and they name the bar
        // rather than a generic failure.
        assert_eq!(report.auto_tag.cause, Some("remote_barred"));
        assert_eq!(report.transcription.cause, Some("remote_barred"));
        // Control arm: without it, a report that marked everything unavailable
        // would pass the assertions above.
        assert!(report.generation.available);

        // The PRODUCTION shape, which the fixture above is not: both arms
        // registered, the remote one selected. Now the bar means what it says —
        // barred from the REMOTE arm, not barred from working. Naming a
        // provider for chat must not take auto-tag and speech-to-text away from
        // a vault whose local model is right there (task 18).
        let both = LocalInferenceState::with_backends(
            vec![
                Backend::new(
                    "in-process",
                    BackendClass::InProcessLocal,
                    std::sync::Arc::new(engine::StubEngine),
                ),
                Backend::new(
                    "fake-remote",
                    BackendClass::Remote,
                    std::sync::Arc::new(engine::StubEngine),
                ),
            ],
            "in-process",
        );
        let report = capability_report_from(&both, true, true);
        // Nothing has authorized the remote arm, so the local one answers.
        assert_eq!(report.backend_class, "in_process_local");
        assert!(report.auto_tag.available);
        assert!(report.transcription.available);
        assert!(report.generation.available);
    }

    /// With a provider ACTIVE, the report must describe the arms that actually
    /// answer — not one unclassified engine for every row (myne-md/myne#438).
    ///
    /// Two rows were wrong in exactly the configuration the provider epic added,
    /// and both told a user whose AI demonstrably works that it is unavailable:
    ///
    /// - `auto_tag` gated on `engine_for(Ambient)` — correctly the LOCAL arm —
    ///   and then asked the ACTIVE (remote) engine whether it had a tag model.
    ///   `RemoteEngine` does not override that, so it took the trait default
    ///   `false` while `suggest_tags` ran happily on the local arm.
    /// - `generation` gated on a locally side-loaded GGUF with no arm for "the
    ///   active backend brings its own model", which is the entire point of
    ///   naming a provider.
    ///
    /// The fixture is the production shape — both arms registered, remote
    /// active — with NO local model file, so the two rows can only be right for
    /// the right reason.
    #[test]
    fn a_configured_provider_reports_generation_and_auto_tag_as_available() {
        use commands::capability_report_from;
        use state::{Backend, BackendClass, LocalInferenceState, PrefsSnapshot};

        /// A local arm that HAS a tag model — the shape `CandleEngine` reports
        /// once its blob is attached.
        struct TaggingLocal;
        impl engine::Engine for TaggingLocal {
            fn infer(&self, _p: &str) -> Result<String, error::EngineError> {
                Ok("local".into())
            }
            fn tag_model_available(&self) -> bool {
                true
            }
        }

        /// A remote arm that does NOT override `tag_model_available`, i.e. the
        /// real `RemoteEngine`'s shape — it takes the trait default `false`.
        ///
        /// This matters more than it looks. The obvious fixture is `StubEngine`
        /// on both arms, and `StubEngine` overrides that method to `true` for
        /// the E2E build — so the two arms agree, and the auto-tag assertion
        /// becomes unfalsifiable. Re-injecting the defect against that fixture
        /// passed; against this one it fails.
        struct PlainRemote;
        impl engine::Engine for PlainRemote {
            fn infer(&self, _p: &str) -> Result<String, error::EngineError> {
                Ok("remote".into())
            }
        }

        let vault = myne_core::vault_id::VaultId::parse("018f0000-0000-7000-8000-0000000000aa")
            .expect("id");
        let state = LocalInferenceState::with_backends(
            vec![
                Backend::new(
                    "in-process",
                    BackendClass::InProcessLocal,
                    std::sync::Arc::new(TaggingLocal),
                ),
                Backend::new(
                    "fake-remote",
                    BackendClass::Remote,
                    std::sync::Arc::new(PlainRemote),
                ),
            ],
            "in-process",
        )
        .with_active_vault_reader(std::sync::Arc::new(move || Some(vault)));

        let mut prefs = protocol::PrefsView {
            ai_enabled: true,
            ai_provider: Some("openrouter".into()),
            ai_provider_consent: Some("openrouter@device".into()),
            ai_provider_key: Some(zeroize::Zeroizing::new("sk-test".into())),
            ai_provider_model: Some("some/model".into()),
            ..protocol::PrefsView::default()
        };
        prefs.ai_provider_model = Some("some/model".into());
        *state.snapshot_cell().write().expect("cell") = Some(PrefsSnapshot {
            prefs,
            vault_id: Some(vault),
        });
        assert_eq!(
            state.active_class(),
            BackendClass::Remote,
            "the fixture must actually select the remote arm, or it proves nothing"
        );

        // NO local generation model: `false` for every model flag.
        let report = capability_report_from(&state, false, false);

        assert!(
            report.generation.available,
            "a provider brings its own model; a missing local GGUF must not block it (cause: {:?})",
            report.generation.cause
        );
        assert!(
            report.auto_tag.available,
            "auto-tag runs on the LOCAL arm, which has a tag model (cause: {:?})",
            report.auto_tag.cause
        );
    }

    /// A working local engine with a half-configured provider must report
    /// generation as AVAILABLE, because it is (myne-md/myne#867 review).
    ///
    /// `remote_refusal` answers "why is the named provider not the arm that
    /// answers", and `active()` falls back to the LOCAL arm for every one of its
    /// causes. Taking the refusal first therefore reported `available: false`
    /// for a vault whose generation demonstrably works, which is a report
    /// contradicting the routing it reports on. The refusal is the better CAUSE
    /// only where the local arm cannot serve either, which the next test pins.
    #[test]
    fn a_working_local_engine_keeps_generation_available_under_a_half_configured_provider() {
        use commands::capability_report_from;
        use state::{Backend, BackendClass, LocalInferenceState, PrefsSnapshot};

        let vault = myne_core::vault_id::VaultId::parse("018f0000-0000-7000-8000-0000000000bb")
            .expect("id");
        let state = LocalInferenceState::with_backends(
            vec![
                Backend::new(
                    "in-process",
                    BackendClass::InProcessLocal,
                    std::sync::Arc::new(engine::StubEngine),
                ),
                Backend::new(
                    "fake-remote",
                    BackendClass::Remote,
                    std::sync::Arc::new(engine::StubEngine),
                ),
            ],
            "in-process",
        )
        .with_active_vault_reader(std::sync::Arc::new(move || Some(vault)));

        // A provider IS named with a model chosen, and the one thing missing is
        // consent. So `remote_refusal` is `Some(ConsentMissing)` while the local
        // arm is the one that answers.
        let prefs = protocol::PrefsView {
            ai_enabled: true,
            ai_provider: Some("openrouter".into()),
            ai_provider_model: Some("some/model".into()),
            ..protocol::PrefsView::default()
        };
        *state.snapshot_cell().write().expect("cell") = Some(PrefsSnapshot {
            prefs,
            vault_id: Some(vault),
        });
        assert_eq!(
            state.remote_refusal(),
            Some(error::EngineError::ConsentMissing),
            "the fixture must actually reach the refusal, or it proves nothing"
        );
        assert_eq!(
            state.active_class(),
            BackendClass::InProcessLocal,
            "the refusal must fall back to the local arm, or the case is not this one"
        );

        // No local model FILE, and the stub carries its own weights, so the local
        // arm can serve: generation works.
        let report = capability_report_from(&state, false, false);
        assert!(
            report.generation.available,
            "a working local arm must keep generation available (cause: {:?})",
            report.generation.cause
        );
    }

    /// And where the local arm CANNOT serve either, the provider's refusal is the
    /// cause to report: it names what the user can act on (accept the consent)
    /// rather than the local arm's `no_model`, which is not why they cannot send.
    #[test]
    fn an_unserved_local_arm_reports_the_provider_refusal_as_the_cause() {
        use commands::capability_report_from;
        use state::{Backend, BackendClass, LocalInferenceState, PrefsSnapshot};

        /// The `CandleEngine` shape: no weights of its own, so the disk decides.
        struct DiskBacked;
        impl engine::Engine for DiskBacked {
            fn infer(&self, _p: &str) -> Result<String, error::EngineError> {
                Ok("local".into())
            }
            fn tag_model_available(&self) -> bool {
                true
            }
        }

        let vault = myne_core::vault_id::VaultId::parse("018f0000-0000-7000-8000-0000000000cc")
            .expect("id");
        let state = LocalInferenceState::with_backends(
            vec![
                Backend::new(
                    "in-process",
                    BackendClass::InProcessLocal,
                    std::sync::Arc::new(DiskBacked),
                ),
                Backend::new(
                    "fake-remote",
                    BackendClass::Remote,
                    std::sync::Arc::new(engine::StubEngine),
                ),
            ],
            "in-process",
        )
        .with_active_vault_reader(std::sync::Arc::new(move || Some(vault)));

        let prefs = protocol::PrefsView {
            ai_enabled: true,
            ai_provider: Some("openrouter".into()),
            ai_provider_model: Some("some/model".into()),
            ..protocol::PrefsView::default()
        };
        *state.snapshot_cell().write().expect("cell") = Some(PrefsSnapshot {
            prefs,
            vault_id: Some(vault),
        });

        let report = capability_report_from(&state, false, false);
        assert!(!report.generation.available);
        assert_eq!(
            report.generation.cause,
            Some("consent_missing"),
            "the cause must name the provider's missing consent, not the local arm"
        );
    }

    /// A missing model is `no_model`, not a bar — the two reasons a feature is
    /// unavailable must stay distinguishable, which is the whole reason the
    /// report carries a cause rather than a boolean.
    ///
    /// The fixture is a DISK-BACKED in-process engine, not `StubEngine`, and the
    /// difference is the point: the stub carries its own weights
    /// (`Engine::carries_own_models`), so against it "no model file" is not the
    /// absence of a model and these rows are legitimately available. Written
    /// against the stub, this test asserted the very defect that left every AI
    /// E2E scenario driving an empty surface — and passed while doing it.
    #[test]
    fn a_missing_model_reports_no_model_rather_than_a_bar() {
        use commands::capability_report_from;
        use state::LocalInferenceState;

        /// The `CandleEngine` shape: weights come from a file the user picks or
        /// the bundle ships, so every model flag below is the disk's answer.
        struct DiskBacked;
        impl engine::Engine for DiskBacked {
            fn infer(&self, _p: &str) -> Result<String, error::EngineError> {
                Ok("local".into())
            }
            fn tag_model_available(&self) -> bool {
                true
            }
        }

        let local = LocalInferenceState::new(std::sync::Arc::new(DiskBacked));
        let report = capability_report_from(&local, false, false);

        assert_eq!(report.generation.cause, Some("no_model"));
        assert_eq!(report.transcription.cause, Some("no_model"));
        assert_eq!(report.backend_class, "in_process_local");
        // The fixture declares a tag model, so auto-tag is the control here.
        assert!(report.auto_tag.available);
    }

    /// An engine that carries its own models is reported as serving every local
    /// role, with no model file anywhere.
    ///
    /// This is the `local-inference-stub` E2E build, and the row it fixes: the
    /// report resolved generation and transcription from the DISK, so
    /// the AI-feature binary — whose stub answers both from code —
    /// advertised `no_model` on both, the chat surface settled on its
    /// `no-provider` empty state, and seven AI scenarios drove a UI that had
    /// drawn no AI affordances at all. `auto_tag` already asked the engine
    /// (`Engine::tag_model_available`) and was the one row that worked.
    #[test]
    fn an_engine_that_carries_its_own_models_serves_every_local_role() {
        use commands::capability_report_from;
        use state::LocalInferenceState;

        let stub = LocalInferenceState::new(std::sync::Arc::new(engine::StubEngine));
        // No selected GGUF, no bundled transcription blob — the E2E build's
        // actual on-disk situation.
        let report = capability_report_from(&stub, false, false);

        assert!(
            report.generation.available,
            "the stub answers generation from code (cause: {:?})",
            report.generation.cause
        );
        assert!(
            report.transcription.available,
            "the stub answers transcription from code (cause: {:?})",
            report.transcription.cause
        );
        assert!(report.auto_tag.available);
        assert_eq!(report.backend_class, "in_process_local");
    }

    /// The production Candle backend must keep declaring that it serializes
    /// compute: the mutex behind that claim is a Metal crash-safety invariant
    /// (`engine_candle.rs` — concurrent `MetalDevice` submission crashes the AGX
    /// driver), so a silent flip here would be a crash, not a slowdown.
    #[cfg(not(feature = "local-inference-stub"))]
    #[test]
    fn the_candle_backend_declares_that_it_serializes_compute() {
        let backend = resolve_backend(std::env::temp_dir(), None);
        assert_eq!(backend.id(), "candle");
        assert!(
            backend.serializes_compute(),
            "Candle must declare serialization — the mutex is crash safety, not perf"
        );
    }
}

#[cfg(test)]
mod resolve_backends_tests {
    use super::*;

    fn cfg_path(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("myne-resolve-backends-{tag}"));
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("ai-endpoint.json");
        let _ = std::fs::remove_file(&p);
        p
    }

    /// The DEFAULT STATE, and the load-bearing half of `decisions.md`
    /// 2026-08-09: with nothing configured, the remote-capable arm is not in
    /// the registry at all. Unreachable, not merely unselected — there is no
    /// setting and no caller that can select what was never registered.
    #[test]
    fn no_endpoint_registers_only_the_in_process_arm() {
        let (backends, active) = resolve_backends(
            std::env::temp_dir(),
            None,
            None,
            std::sync::Arc::new(|| false),
        );
        assert_eq!(backends.len(), 1);
        assert_ne!(active, "ollama");
        assert!(
            !backends.iter().any(|b| b.id() == "ollama"),
            "an unconfigured install must not carry the runtime arm"
        );
    }

    /// A URL with no model is stored, and is still not a backend (SYNC-24).
    /// Without this, "I typed an address" would silently become "send my notes
    /// to whatever model that runtime defaults to".
    #[test]
    fn a_url_without_a_model_does_not_register_the_runtime_arm() {
        let p = cfg_path("urlonly");
        endpoint_config::write_endpoint(&p, "http://127.0.0.1:11434", "").expect("write");
        let (backends, active) = resolve_backends(
            std::env::temp_dir(),
            None,
            Some(&p),
            std::sync::Arc::new(|| false),
        );
        assert_eq!(backends.len(), 1);
        assert_ne!(active, "ollama");
    }

    /// A refused URL cannot reach the config through the setter, but a
    /// hand-edited file can. The read re-validates, so it must land on the
    /// in-process arm rather than on an engine pointed off-device.
    #[test]
    fn a_hand_edited_remote_url_does_not_register_the_runtime_arm() {
        let p = cfg_path("handedit");
        std::fs::write(&p, r#"{"url":"http://evil.example:11434","model":"m"}"#).expect("write");
        let (backends, active) = resolve_backends(
            std::env::temp_dir(),
            None,
            Some(&p),
            std::sync::Arc::new(|| false),
        );
        assert_eq!(backends.len(), 1);
        assert_ne!(active, "ollama");
    }

    /// The `https` twin of the test above, which is the one that was missing.
    ///
    /// `validate_endpoint_url` accepts `https` to any host — right for the sync
    /// endpoint, wrong here — and the reader discards the scheme, so this URL
    /// used to register as a `LoopbackLocal` backend and become active. Every
    /// ambient surface then ran against it: ghost text POSTs the surrounding text
    /// on a keystroke, and it does not pass the remote-provider consent gate,
    /// because that gate is keyed on `BackendClass::Remote`. The engine speaks
    /// no TLS, so all of it went out in cleartext.
    #[test]
    fn a_hand_edited_https_url_does_not_register_the_runtime_arm_either() {
        let p = cfg_path("handedit-https");
        std::fs::write(&p, r#"{"url":"https://evil.example","model":"m"}"#).expect("write");
        let (backends, active) = resolve_backends(
            std::env::temp_dir(),
            None,
            Some(&p),
            std::sync::Arc::new(|| false),
        );
        assert_eq!(backends.len(), 1, "a remote https host registered an arm");
        assert_ne!(active, "ollama");
    }

    /// Both named → the arm is registered AND active: a user who named a
    /// runtime asked for it.
    #[test]
    fn a_configured_endpoint_registers_the_runtime_arm_and_makes_it_active() {
        let p = cfg_path("configured");
        endpoint_config::write_endpoint(&p, "http://127.0.0.1:11434", "nomic-embed-text")
            .expect("write");
        let (backends, active) = resolve_backends(
            std::env::temp_dir(),
            None,
            Some(&p),
            std::sync::Arc::new(|| false),
        );
        assert_eq!(active, "ollama");
        let ollama = backends
            .iter()
            .find(|b| b.id() == "ollama")
            .expect("the runtime arm is registered");
        // LoopbackLocal, not Remote: `endpoint_config::validate` admits only the
        // three literal loopback names, under EVERY scheme, so nothing leaves the
        // device.
        assert_eq!(ollama.class(), state::BackendClass::LoopbackLocal);
        // The work happens in another process with its own scheduler, so there
        // is no Myne-side lock and `Deferred` must not be advertised.
        assert!(!ollama.serializes_compute());
        // The in-process arm stays registered — it is what the capability
        // report enumerates and what a later live switch would return to.
        assert_eq!(backends.len(), 2);
    }

    /// A registered runtime arm answers `NotReady` — never a guess — once the
    /// config it reads per call goes away. Verified by removing the file after
    /// registration, which is exactly what "the user cleared the setting" does.
    #[test]
    fn the_runtime_arm_reports_not_ready_when_its_config_disappears() {
        let p = cfg_path("vanishes");
        endpoint_config::write_endpoint(&p, "http://127.0.0.1:11434", "some-model").expect("write");
        let (backends, _) = resolve_backends(
            std::env::temp_dir(),
            None,
            Some(&p),
            std::sync::Arc::new(|| false),
        );
        let engine = backends
            .iter()
            .find(|b| b.id() == "ollama")
            .expect("registered")
            .engine();
        std::fs::remove_file(&p).expect("clear the setting");
        assert_eq!(engine.infer("x").err(), Some(error::EngineError::NotReady));
    }

    #[cfg(test)]
    mod cancel_wiring_tests {
        use super::*;
        use std::sync::atomic::{AtomicUsize, Ordering};

        /// The WIRING, not the primitive (myne-md/myne#440).
        ///
        /// `cancel::any_cancelled` has its own test, and it would stay green if
        /// someone re-hardcoded the engines' source back to `|| false` — that
        /// regression compiles cleanly and no type checks it, which is how the
        /// original defect shipped. So this drives the engine that `remote_backend`
        /// builds and asserts the source it was handed is actually consulted.
        #[test]
        fn the_remote_backend_consults_the_cancel_source_it_was_given() {
            let polls = std::sync::Arc::new(AtomicUsize::new(0));
            let counted = {
                let polls = std::sync::Arc::clone(&polls);
                let f: cancellable_io::CancelledFn = std::sync::Arc::new(move || {
                    polls.fetch_add(1, Ordering::SeqCst);
                    true
                });
                f
            };

            // A fully-authorized snapshot, so the engine gets past the gate and
            // reaches its transport — without it the call would refuse for an
            // unrelated reason and the poll count would prove nothing.
            let cell: state::PrefsCell =
                std::sync::Arc::new(std::sync::RwLock::new(Some(state::PrefsSnapshot {
                    prefs: protocol::PrefsView {
                        ai_enabled: true,
                        ai_provider: Some("openrouter".into()),
                        ai_provider_consent: Some("openrouter@device".into()),
                        ai_provider_key: Some(zeroize::Zeroizing::new("sk-test".into())),
                        ai_provider_model: Some("some/model".into()),
                        ..protocol::PrefsView::default()
                    },
                    vault_id: None,
                })));

            let backend = remote_backend(cell, counted);
            // The call fails — there is no provider to reach — and that is fine.
            // What is asserted is that the cancel source was CONSULTED on the way.
            let _ = backend.engine().infer("hello");
            assert!(
                polls.load(Ordering::SeqCst) > 0,
                "the remote engine must poll the cancel source it was constructed \
             with; a source that is never asked is the inert wiring this fixes"
            );
        }
    }
}
