//! On-device speech-to-text (Whisper) — the mobile port of the desktop
//! `local_inference` engine, **transcription-only** (MYND-563).
//!
//! Feature-gated by `local-inference` (default-on). The engine modules + real
//! `init()` compile only when the feature is on, so a `--no-default-features`
//! build carries no candle/whisper code and grants no capability. The module is
//! declared unconditionally with a no-op `init()` for the feature-off build, so
//! the single registration in `lib.rs` stays a plain (uncfg'd) chain link.
//!
//! The engine files mirror `src-tauri/src/plugins/local_inference/`
//! (`audio`/`whisper`/`engine`/`engine_candle`/`model_store`/`cancel`/`error`),
//! with the desktop engine's generation (Qwen2) role dropped
//! — mobile transcribes only. DENY-list logging is normative here
//! (`src-tauri/AGENTS.md`): audio, PCM, transcript, and model paths are never
//! logged.

#[cfg(feature = "local-inference")]
mod audio;
#[cfg(feature = "local-inference")]
mod cancel;
#[cfg(feature = "local-inference")]
mod commands;
#[cfg(feature = "local-inference")]
mod engine;
#[cfg(feature = "local-inference")]
mod engine_candle;
#[cfg(feature = "local-inference")]
mod error;
#[cfg(feature = "local-inference")]
mod model_store;
#[cfg(feature = "local-inference")]
mod state;
#[cfg(feature = "local-inference")]
mod whisper;

use tauri::plugin::TauriPlugin;
use tauri::Runtime;

#[cfg(feature = "local-inference")]
mod plugin {
    use std::path::PathBuf;
    use std::sync::Arc;

    use tauri::plugin::{Builder, TauriPlugin};
    use tauri::{Manager, Runtime};

    use super::{cancel, commands, engine, engine_candle, model_store, state};

    /// Runtime capability granting the two transcription commands to the main
    /// window. Added in [`init`] rather than a static `capabilities/*.json` entry
    /// so a feature-off build — which registers only a no-op plugin — carries no
    /// capability referencing absent commands (mirrors desktop `local_inference`).
    const LOCAL_INFERENCE_CAPABILITY: &str = r#"{
  "identifier": "local-inference",
  "description": "On-device speech-to-text (transcribe/read_transcript) for the main window; no core/fs/dialog/clipboard/network.",
  "windows": ["main"],
  "permissions": ["local-inference:allow-transcribe", "local-inference:allow-read-transcript"]
}"#;

    /// The real `local-inference` plugin (mobile) — transcription only. The two
    /// commands are reachable only with the `local-inference` feature and the
    /// scoped capability added at runtime here.
    pub fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::<R>::new("local-inference")
            .invoke_handler(tauri::generate_handler![
                commands::transcribe,
                commands::read_transcript
            ])
            .setup(|app, _api| {
                // Engine selection is a COMPILE-TIME choice:
                //   production (`local-inference`) → the Candle whisper engine,
                //     resolving the bundled whisper-tiny model (else a side-load
                //     override); no model → `NotReady` per call.
                //   E2E (`local-inference-stub`) → the deterministic StubEngine.
                #[cfg(feature = "local-inference-stub")]
                let engine: Arc<dyn engine::Engine> = Arc::new(engine::StubEngine);
                #[cfg(not(feature = "local-inference-stub"))]
                let engine: Arc<dyn engine::Engine> = {
                    let base =
                        crate::paths::app_data_dir(app).unwrap_or_else(|_| PathBuf::from("."));
                    let bundled_transcription = app
                        .path()
                        .resource_dir()
                        .ok()
                        .and_then(|rd| model_store::bundled_transcription_model(&rd));
                    Arc::new(
                        engine_candle::CandleEngine::new(base)
                            .with_bundled_transcription(bundled_transcription),
                    )
                };
                app.manage(state::LocalInferenceState::new(engine));
                app.manage(cancel::CancelToken::default());
                app.add_capability(LOCAL_INFERENCE_CAPABILITY)?;
                Ok(())
            })
            .build()
    }
}

/// Construct the `local-inference` plugin. With the `local-inference` feature it
/// is the real transcription plugin; without it, a no-op plugin (no commands, no
/// capability) so the `lib.rs` registration is unconditional.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    #[cfg(feature = "local-inference")]
    {
        plugin::init::<R>()
    }
    #[cfg(not(feature = "local-inference"))]
    {
        tauri::plugin::Builder::<R>::new("local-inference").build()
    }
}
