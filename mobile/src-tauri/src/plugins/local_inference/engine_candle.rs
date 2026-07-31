//! Candle-backed Whisper transcription engine — the mobile port of the desktop
//! local_inference engine (MYND-563), **transcription ONLY**. The desktop engine
//! also carries generation (Qwen2) and embedding (Bert) roles; those are out of
//! scope on mobile, so `infer`/`embed` return `NotReady` and only the Whisper
//! path is real. CPU device (Metal-on-iOS is a later optimization). The heavy
//! lifting — the mel front end + the decode loop — lives in [`super::whisper`];
//! this file is model load + lazy-cache + the [`Engine`] impl.
//!
//! DENY-list logging (`src-tauri/CLAUDE.md`, normative for mobile too): the PCM
//! (AS1 decrypted audio) and the transcript (note-class) are NEVER logged, nor is
//! the model path; a candle error `Display` can embed the path, so it goes to
//! DEBUG only. Success logs `elapsed_ms` / `out_chars` (a count) — no content.

#![cfg_attr(not(test), allow(dead_code))]

use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use candle_core::Device;
use candle_transformers::models::whisper::{
    quantized_model::{VarBuilder as WhisperVarBuilder, Whisper},
    Config as WhisperConfig,
};
use tokenizers::Tokenizer;

use super::engine::Engine;
use super::error::EngineError;
use super::model_store::{selected_model, ModelRole};
use super::whisper::{self, WhisperTokens};

/// A loaded Whisper model + its tokenizer, config, computed mel filterbank, and
/// resolved control tokens. Lazy-loaded once behind the `transcription` mutex;
/// the `&mut` decode borrows the model.
struct LoadedTranscription {
    model: Whisper,
    tokenizer: Tokenizer,
    config: WhisperConfig,
    /// `librosa`-slaney mel filterbank for `config.num_mel_bins` — computed, not
    /// shipped (see [`super::whisper::mel_filters`]).
    mel_filters: Vec<f32>,
    tokens: WhisperTokens,
    device: Device,
}

/// Mobile is CPU-only. (Desktop tries Metal on macOS; on iOS/Android the desktop
/// engine already falls back to CPU, and this port keeps it explicit — no Metal
/// bring-up in scope.)
fn select_device() -> Device {
    tracing::info!(target: "myne::ai", device = "cpu", "AI compute device selected");
    Device::Cpu
}

/// Candle-backed engine. `base` is the `app_data_dir` the `model_store` markers
/// live under; the model loads lazily.
pub struct CandleEngine {
    base: PathBuf,
    /// The bundled default whisper-tiny model shipped as a Tauri resource
    /// (MYND-563), resolved once at construction — `None` when none ships
    /// (`--no-default-features`, or an unfetched LFS blob). Used when the user set
    /// no override so transcription works out of the box.
    bundled_transcription: Option<PathBuf>,
    device: Device,
    /// Serializes all compute (CPU here — no correctness need, but keeps the
    /// desktop discipline so a future Metal path is a one-line device swap).
    compute: Mutex<()>,
    transcription: Mutex<Option<LoadedTranscription>>,
}

impl CandleEngine {
    pub fn new(base: PathBuf) -> Self {
        Self {
            base,
            bundled_transcription: None,
            device: select_device(),
            compute: Mutex::new(()),
            transcription: Mutex::new(None),
        }
    }

    /// Set the bundled-default model path resolved from the Tauri resource dir.
    pub fn with_bundled_transcription(mut self, path: Option<PathBuf>) -> Self {
        self.bundled_transcription = path;
        self
    }

    /// A sibling file next to the model (`config.json` / `tokenizer.json`).
    fn sibling(model_path: &Path, name: &str) -> PathBuf {
        model_path
            .parent()
            .map(|d| d.join(name))
            .unwrap_or_else(|| PathBuf::from(name))
    }

    /// Override-else-bundled resolution + load. `NotReady` only when neither an
    /// override nor a bundled model is present. Mel filterbank computed from
    /// `config.num_mel_bins` (no data blob). DENY-safe logging only.
    fn load_transcription(&self) -> Result<LoadedTranscription, EngineError> {
        let started = Instant::now();
        let model_path = match selected_model(&self.base, ModelRole::Transcription) {
            Ok(Some(p)) => p,
            Ok(None) => match &self.bundled_transcription {
                Some(p) => p.clone(),
                None => {
                    tracing::warn!(
                        target: "myne::ai",
                        stage = "load_transcription",
                        "no transcription model — no override picked and no bundled default present"
                    );
                    return Err(EngineError::NotReady);
                }
            },
            Err(e) => {
                tracing::error!(
                    target: "myne::ai",
                    stage = "load_transcription.resolve",
                    error_kind = e.kind(),
                    "could not resolve the transcription model path"
                );
                return Err(EngineError::NotReady);
            }
        };
        tracing::info!(target: "myne::ai", stage = "load_transcription", "loading transcription model (first use)…");
        let config_path = Self::sibling(&model_path, "config.json");
        let tok_path = Self::sibling(&model_path, "tokenizer.json");
        let config_json = std::fs::read_to_string(&config_path)
            .map_err(|e| io_stage_fail("load_transcription.read_config", &e, EngineError::NotReady))?;
        let config: WhisperConfig = serde_json::from_str(&config_json).map_err(|e| {
            fmt_stage_fail("load_transcription.parse_config", e, EngineError::TranscriptionFailed)
        })?;
        let vb = WhisperVarBuilder::from_gguf(&model_path, &self.device).map_err(|e| {
            fmt_stage_fail("load_transcription.from_gguf", e, EngineError::TranscriptionFailed)
        })?;
        let model = Whisper::load(&vb, config.clone()).map_err(|e| {
            fmt_stage_fail("load_transcription.build_model", e, EngineError::TranscriptionFailed)
        })?;
        let tokenizer = Tokenizer::from_file(&tok_path).map_err(|e| {
            fmt_stage_fail("load_transcription.tokenizer", e, EngineError::TranscriptionFailed)
        })?;
        let tokens = WhisperTokens::resolve(&tokenizer)?;
        let mel_filters = whisper::mel_filters(config.num_mel_bins);
        tracing::info!(
            target: "myne::ai",
            stage = "load_transcription",
            elapsed_ms = started.elapsed().as_millis() as u64,
            "transcription model loaded"
        );
        Ok(LoadedTranscription {
            model,
            tokenizer,
            config,
            mel_filters,
            tokens,
            device: self.device.clone(),
        })
    }
}

/// Log a FORMAT/parse-stage failure (candle / tokenizer / serde) and map to a
/// bounded [`EngineError`]. A candle error `Display` CAN embed the model path
/// (`Error::WithPath`), which is DENY-listed — so only the bounded `stage` is at
/// ERROR; the fuller detail is DEBUG behind `RUST_LOG=myne::ai=debug`.
pub(super) fn fmt_stage_fail(
    stage: &'static str,
    e: impl std::fmt::Display,
    kind: EngineError,
) -> EngineError {
    tracing::error!(target: "myne::ai", stage, "AI engine stage failed");
    tracing::debug!(target: "myne::ai", stage, detail = %e, "AI engine stage failure detail");
    kind
}

/// Log an IO-stage failure via the bounded `crate::io_failure_kind` enum — NEVER
/// the raw `io::Error` / path (DENY-list) — and map to a bounded [`EngineError`].
fn io_stage_fail(stage: &'static str, e: &std::io::Error, kind: EngineError) -> EngineError {
    let io_failure_kind = crate::io_failure_kind::from_io_error_kind(e.kind());
    tracing::error!(target: "myne::ai", stage, ?io_failure_kind, "AI engine IO stage failed");
    kind
}

/// Decode `pcm` (16 kHz mono f32) to a transcript, streaming each 30 s window's
/// text; `Break` stops early. Shared by blocking + streaming so the decode
/// discipline lives in one place.
fn run_transcribe(
    loaded: &mut LoadedTranscription,
    pcm: &[f32],
    on_segment: &mut dyn FnMut(&str) -> ControlFlow<()>,
) -> Result<String, EngineError> {
    let device = loaded.device.clone();
    whisper::transcribe_pcm(
        &mut loaded.model,
        &loaded.tokenizer,
        &loaded.tokens,
        &loaded.config,
        &loaded.mel_filters,
        &device,
        pcm,
        on_segment,
    )
}

impl Engine for CandleEngine {
    fn infer(&self, _prompt: &str) -> Result<String, EngineError> {
        // Generation (Qwen2) is out of scope on mobile — transcription-only port.
        Err(EngineError::NotReady)
    }

    fn embed(&self, _text: &str) -> Result<Vec<f32>, EngineError> {
        // Embedding (Bert) is out of scope on mobile.
        Err(EngineError::NotReady)
    }

    fn transcribe(&self, pcm: &[f32]) -> Result<String, EngineError> {
        // Blocking — a no-op segment sink; the transcript is the return value.
        self.transcribe_streaming(pcm, &mut |_seg| ControlFlow::Continue(()))
    }

    fn transcribe_streaming(
        &self,
        pcm: &[f32],
        on_segment: &mut dyn FnMut(&str) -> ControlFlow<()>,
    ) -> Result<String, EngineError> {
        // Serialize compute + lazy-load the model under its own mutex.
        let _compute = self.compute.lock().unwrap_or_else(|p| p.into_inner());
        let mut guard = self.transcription.lock().unwrap_or_else(|p| p.into_inner());
        if guard.is_none() {
            *guard = Some(self.load_transcription()?);
        }
        let loaded = guard.as_mut().expect("just loaded");
        let started = Instant::now();
        let out = run_transcribe(loaded, pcm, on_segment);
        match &out {
            Ok(s) => tracing::info!(
                target: "myne::ai",
                op = "transcribe",
                elapsed_ms = started.elapsed().as_millis() as u64,
                out_chars = s.chars().count(),
                "transcription complete"
            ),
            Err(e) => tracing::error!(
                target: "myne::ai",
                op = "transcribe",
                error_kind = e.kind(),
                "transcription failed"
            ),
        }
        out
    }

    fn invalidate_models(&self) {
        // Drop the cached model under the compute lock so a model swap takes
        // effect without an app restart.
        let _compute = self.compute.lock().unwrap_or_else(|p| p.into_inner());
        *self.transcription.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}
