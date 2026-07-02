//! Real on-device [`Engine`] backed by Candle (local-ai epic, MYND-406 tasks
//! 3/4). `infer` runs a **quantized Qwen2 GGUF** generation model; `embed` runs
//! an **all-MiniLM-L6-v2 BERT** embedding model. Both are **side-loaded** from
//! the user's disk via `model_store` (SYNC-1) — never downloaded (SYNC-2; the
//! `hf-hub`/`http` crate families are kept out of the tree by
//! `default-features = false`, verified by the no-egress gate).
//!
//! Lazy-loaded on first use behind a `Mutex` (the `Engine` trait is `Send +
//! Sync`; a single instance backs concurrent commands under `Arc`). CPU device
//! only (`Device::Cpu`) — no GPU/network. No model set → [`EngineError::NotReady`].
//!
//! Side-load layout (the user picks the primary file; siblings live next to it):
//! - generation: `<model>.gguf` + `tokenizer.json` in the same directory.
//! - embedding: `model.safetensors` + `config.json` + `tokenizer.json` in the
//!   same directory.
//!
//! Secret-handling: a prompt / note text / embedding is never logged (DENY-list)
//! — only the closed [`EngineError`] kind escapes.

// Under the E2E `local-inference-stub` variant the production `CandleEngine`
// path is compiled out (the setup uses `StubEngine`), so this module's items are
// unused there — silence dead_code for THAT build only. Production
// (`local-inference`) uses the engine, so the lint stays strict there.
#![cfg_attr(feature = "local-inference-stub", allow(dead_code))]

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Instant;

use candle_core::quantized::gguf_file;
use candle_core::{Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::generation::{LogitsProcessor, Sampling};
use candle_transformers::models::bert::{BertModel, Config as BertConfig, DTYPE};
use candle_transformers::models::quantized_qwen2::ModelWeights as Qwen2;
use tokenizers::Tokenizer;

use super::engine::Engine;
use super::error::EngineError;
use super::model_store::{selected_model, ModelRole};

/// Cap on generated tokens per `infer` — a bound so a runaway generation can't
/// hang the blocking command.
const MAX_NEW_TOKENS: usize = 512;
/// Deterministic sampling seed (reproducible generations).
const SAMPLE_SEED: u64 = 299_792_458;
/// Generation temperature (mild — coherent, lightly varied).
const TEMPERATURE: f64 = 0.7;

/// A loaded generation model + its tokenizer.
struct LoadedGen {
    model: Qwen2,
    tokenizer: Tokenizer,
    /// The end-of-turn token id, if the tokenizer exposes one — stops decoding.
    eos: Option<u32>,
    /// The device the model + its inference tensors live on (Metal GPU or CPU).
    device: Device,
}

/// A loaded embedding model + its tokenizer.
struct LoadedEmbed {
    model: BertModel,
    tokenizer: Tokenizer,
    /// The device the model + its inference tensors live on (Metal GPU or CPU).
    device: Device,
    /// The model's positional-embedding limit (`config.max_position_embeddings`,
    /// 512 for MiniLM). A chunk that tokenizes longer than this is truncated
    /// before the forward pass — feeding a BERT more positions than it has
    /// embeddings for is an out-of-bounds index (panic / wrong output), and note
    /// content is attacker-influenceable (a synced note could be a giant CJK /
    /// base64 blob), so this bound is load-bearing, not just a nicety.
    max_tokens: usize,
}

/// Pick the compute device: the Apple GPU (Metal) on macOS when available, else
/// the CPU (which uses the `accelerate` BLAS backend). Metal creation can fail
/// (no GPU / headless / driver issue) → CPU fallback keeps the engine working.
/// Logged once so a slow run is diagnosable ("am I on GPU or CPU?").
#[cfg(target_os = "macos")]
fn select_device() -> Device {
    // Escape hatch / benchmark knob: `MYNE_AI_DEVICE=cpu` forces the CPU path
    // (skips Metal) — useful if a Metal driver issue ever surfaces, or to compare
    // GPU vs CPU. Any other value (or unset) → try Metal, fall back to CPU.
    if std::env::var("MYNE_AI_DEVICE").as_deref() == Ok("cpu") {
        tracing::info!(target: "myne::ai", device = "cpu", "AI compute device forced to CPU (MYNE_AI_DEVICE=cpu)");
        return Device::Cpu;
    }
    match Device::new_metal(0) {
        Ok(dev) => {
            tracing::info!(target: "myne::ai", device = "metal", "AI compute device selected");
            dev
        }
        Err(e) => {
            tracing::warn!(
                target: "myne::ai",
                device = "cpu",
                error = %e,
                "Metal unavailable — falling back to CPU"
            );
            Device::Cpu
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn select_device() -> Device {
    tracing::info!(target: "myne::ai", device = "cpu", "AI compute device selected");
    Device::Cpu
}

/// Candle-backed engine. `base` is the `app_data_dir` the `model_store` markers
/// live under; the models load lazily from the user's side-load paths.
pub struct CandleEngine {
    base: PathBuf,
    /// Compute device chosen once at construction (Metal GPU on macOS, else CPU).
    device: Device,
    /// Serializes ALL GPU/compute work across `infer` + `embed`. The `gen` and
    /// `embed` models sit behind SEPARATE locks (for independent lazy-load), so
    /// without this a summarize (`infer`) and the background embed-walk (`embed`)
    /// run on the Metal device from two threads at once — candle's `MetalDevice`
    /// is not safe for concurrent command-buffer submission, and the AGX driver
    /// crashes (`AGXG14XFamilyCommandBuffer …`). Held for the duration of each
    /// call, so operations interleave at call boundaries (each embed is ~ms) but
    /// never overlap on the GPU. Cheap on CPU (just serializes; no correctness
    /// need there).
    compute: Mutex<()>,
    gen: Mutex<Option<LoadedGen>>,
    embed: Mutex<Option<LoadedEmbed>>,
}

impl CandleEngine {
    /// Construct with the `model_store` base dir (`app_data_dir`). Nothing loads
    /// until the first `infer`/`embed`; the compute device is picked now.
    pub fn new(base: PathBuf) -> Self {
        Self {
            base,
            device: select_device(),
            compute: Mutex::new(()),
            gen: Mutex::new(None),
            embed: Mutex::new(None),
        }
    }

    fn sibling(model_path: &Path, name: &str) -> PathBuf {
        model_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(name)
    }

    fn load_gen(&self) -> Result<LoadedGen, EngineError> {
        let started = Instant::now();
        let model_path = match selected_model(&self.base, ModelRole::Generation) {
            Ok(Some(p)) => p,
            Ok(None) => {
                tracing::warn!(
                    target: "myne::ai",
                    stage = "load_gen",
                    "no generation (text) model selected — pick a .gguf in Settings → AI"
                );
                return Err(EngineError::NotReady);
            }
            Err(e) => {
                tracing::error!(
                    target: "myne::ai",
                    stage = "load_gen.resolve",
                    error_kind = e.kind(),
                    "could not resolve the generation model path"
                );
                return Err(EngineError::NotReady);
            }
        };
        tracing::info!(
            target: "myne::ai",
            stage = "load_gen",
            "loading generation model (first use)…"
        );
        let tok_path = Self::sibling(&model_path, "tokenizer.json");
        let mut file = std::fs::File::open(&model_path)
            .map_err(|e| io_stage_fail("load_gen.open_gguf", &e, EngineError::NotReady))?;
        let content = gguf_file::Content::read(&mut file)
            .map_err(|e| fmt_stage_fail("load_gen.read_gguf", e, EngineError::InferenceFailed))?;
        let model = Qwen2::from_gguf(content, &mut file, &self.device)
            .map_err(|e| fmt_stage_fail("load_gen.from_gguf", e, EngineError::InferenceFailed))?;
        let tokenizer = Tokenizer::from_file(&tok_path)
            .map_err(|e| fmt_stage_fail("load_gen.tokenizer", e, EngineError::InferenceFailed))?;
        let eos = tokenizer
            .token_to_id("<|im_end|>")
            .or_else(|| tokenizer.token_to_id("<|endoftext|>"));
        tracing::info!(
            target: "myne::ai",
            stage = "load_gen",
            elapsed_ms = started.elapsed().as_millis() as u64,
            "generation model loaded"
        );
        Ok(LoadedGen {
            model,
            tokenizer,
            eos,
            device: self.device.clone(),
        })
    }

    fn load_embed(&self) -> Result<LoadedEmbed, EngineError> {
        let started = Instant::now();
        let model_path = match selected_model(&self.base, ModelRole::Embedding) {
            Ok(Some(p)) => p,
            Ok(None) => {
                tracing::warn!(
                    target: "myne::ai",
                    stage = "load_embed",
                    "no embedding (search) model selected — pick a .safetensors in Settings → AI"
                );
                return Err(EngineError::NotReady);
            }
            Err(e) => {
                tracing::error!(
                    target: "myne::ai",
                    stage = "load_embed.resolve",
                    error_kind = e.kind(),
                    "could not resolve the embedding model path"
                );
                return Err(EngineError::NotReady);
            }
        };
        tracing::info!(
            target: "myne::ai",
            stage = "load_embed",
            "loading embedding model (first use)…"
        );
        let config_path = Self::sibling(&model_path, "config.json");
        let tok_path = Self::sibling(&model_path, "tokenizer.json");
        let config_json = std::fs::read_to_string(&config_path)
            .map_err(|e| io_stage_fail("load_embed.read_config", &e, EngineError::NotReady))?;
        let config: BertConfig = serde_json::from_str(&config_json).map_err(|e| {
            fmt_stage_fail("load_embed.parse_config", e, EngineError::EmbeddingFailed)
        })?;
        let tokenizer = Tokenizer::from_file(&tok_path)
            .map_err(|e| fmt_stage_fail("load_embed.tokenizer", e, EngineError::EmbeddingFailed))?;
        // SAFETY: mmap of a user-side-loaded safetensors file; candle's own API.
        let vb = unsafe {
            VarBuilder::from_mmaped_safetensors(&[model_path], DTYPE, &self.device).map_err(
                |e| fmt_stage_fail("load_embed.safetensors", e, EngineError::EmbeddingFailed),
            )?
        };
        let model = BertModel::load(vb, &config).map_err(|e| {
            fmt_stage_fail("load_embed.build_model", e, EngineError::EmbeddingFailed)
        })?;
        tracing::info!(
            target: "myne::ai",
            stage = "load_embed",
            elapsed_ms = started.elapsed().as_millis() as u64,
            "embedding model loaded"
        );
        Ok(LoadedEmbed {
            model,
            tokenizer,
            device: self.device.clone(),
            max_tokens: config.max_position_embeddings.max(1),
        })
    }
}

/// Log a FORMAT/parse-stage failure (candle / tokenizer / serde) and map to a
/// bounded [`EngineError`]. The candle error `Display` CAN embed the model file
/// path (candle's `Error::WithPath` wraps IO failures), which is DENY-listed
/// (full filesystem path leakage, `src-tauri/CLAUDE.md`). So the ERROR-level line
/// carries only the bounded `stage` string; the fuller message — the load-bearing
/// format diagnostic (e.g. a Qwen2.5-vs-Qwen2 tensor mismatch), which may include
/// the path — is emitted at DEBUG, opt-in behind `RUST_LOG=myne::ai=debug`.
fn fmt_stage_fail(
    stage: &'static str,
    e: impl std::fmt::Display,
    kind: EngineError,
) -> EngineError {
    tracing::error!(target: "myne::ai", stage, "AI engine stage failed");
    tracing::debug!(target: "myne::ai", stage, detail = %e, "AI engine stage failure detail");
    kind
}

/// Log an IO-stage failure via the bounded [`crate::io_failure_kind`] enum — NEVER
/// the raw `io::Error` / path (DENY-list, `src-tauri/CLAUDE.md`) — and map to a
/// bounded [`EngineError`].
fn io_stage_fail(stage: &'static str, e: &std::io::Error, kind: EngineError) -> EngineError {
    let io_failure_kind = crate::io_failure_kind::from_io_error_kind(e.kind());
    tracing::error!(target: "myne::ai", stage, ?io_failure_kind, "AI engine IO stage failed");
    kind
}

/// Neutralize ChatML control markers in untrusted content so it cannot break out
/// of its conversation turn (prompt-injection defense). Qwen's special tokens are
/// the only escape vectors for the template in [`run_infer`]; removing their
/// literal forms means the content tokenizes as ordinary text.
fn sanitize_chatml(s: &str) -> String {
    s.replace("<|im_start|>", "")
        .replace("<|im_end|>", "")
        .replace("<|endoftext|>", "")
}

/// Blocking Qwen2 generation loop: encode the prompt, then greedily/temperature-
/// sample one token at a time until EOS or the token cap.
fn run_infer(loaded: &mut LoadedGen, prompt: &str) -> Result<String, EngineError> {
    let device = loaded.device.clone();
    // Qwen2.5-Instruct is a CHAT model: fed a bare prompt it cannot separate the
    // instruction from the content (it replies "no note provided") and never
    // emits the `<|im_end|>` turn-end token, so it rambles/repeats to the token
    // cap. Wrap the caller's prompt as one ChatML user turn — the `<|im_end|>`
    // EOS detected in `load_gen` then stops generation cleanly. (The engine is
    // already Qwen-coupled via `Qwen2::from_gguf`, so this template lives here.)
    // Note content is UNTRUSTED (a synced note from another device is
    // attacker-chosen). Strip the ChatML control markers from it first, so
    // embedded `<|im_end|><|im_start|>system…` cannot close the user turn and
    // impersonate the system/assistant role (prompt-injection turn escape). The
    // markers are removed rather than escaped — they carry no legitimate meaning
    // inside a user's note body.
    let safe_prompt = sanitize_chatml(prompt);
    let templated = format!(
        "<|im_start|>system\nYou are a helpful assistant.<|im_end|>\n\
         <|im_start|>user\n{safe_prompt}<|im_end|>\n\
         <|im_start|>assistant\n"
    );
    let encoding = loaded
        .tokenizer
        .encode(templated, true)
        .map_err(|e| fmt_stage_fail("infer.encode", e, EngineError::InferenceFailed))?;
    let mut tokens: Vec<u32> = encoding.get_ids().to_vec();
    if tokens.is_empty() {
        return Ok(String::new());
    }

    let mut logits_processor = LogitsProcessor::from_sampling(
        SAMPLE_SEED,
        Sampling::All {
            temperature: TEMPERATURE,
        },
    );
    let mut generated: Vec<u32> = Vec::new();

    // Prompt pass (position 0), then one token at a time.
    let mut pos = 0usize;
    let mut input_tokens: Vec<u32> = tokens.clone();
    for _ in 0..MAX_NEW_TOKENS {
        let input = Tensor::new(input_tokens.as_slice(), &device)
            .map_err(|_| EngineError::InferenceFailed)?
            .unsqueeze(0)
            .map_err(|_| EngineError::InferenceFailed)?;
        let logits = loaded
            .model
            .forward(&input, pos)
            .map_err(|e| fmt_stage_fail("infer.forward", e, EngineError::InferenceFailed))?;
        let logits = logits
            .squeeze(0)
            .map_err(|_| EngineError::InferenceFailed)?;
        let next = logits_processor
            .sample(&logits)
            .map_err(|_| EngineError::InferenceFailed)?;
        pos += input_tokens.len();
        tokens.push(next);
        generated.push(next);
        if Some(next) == loaded.eos {
            break;
        }
        input_tokens = vec![next];
    }

    loaded
        .tokenizer
        .decode(&generated, true)
        .map_err(|_| EngineError::InferenceFailed)
}

/// Mean-pool + L2-normalize a BERT last-hidden-state into a sentence embedding.
fn run_embed(loaded: &LoadedEmbed, text: &str) -> Result<Vec<f32>, EngineError> {
    let device = loaded.device.clone();
    let encoding = loaded
        .tokenizer
        .encode(text, true)
        .map_err(|e| fmt_stage_fail("embed.encode", e, EngineError::EmbeddingFailed))?;
    // Truncate to the model's positional-embedding limit BEFORE the forward
    // pass: a longer sequence indexes past the position table (panic / garbage),
    // and note text is attacker-influenceable. Mean-pooling over the first
    // `max_tokens` is a standard, safe degradation for an over-long chunk.
    let all_ids = encoding.get_ids();
    let ids = &all_ids[..all_ids.len().min(loaded.max_tokens)];
    let input_ids = Tensor::new(ids, &device)
        .map_err(|_| EngineError::EmbeddingFailed)?
        .unsqueeze(0)
        .map_err(|_| EngineError::EmbeddingFailed)?;
    let token_type_ids = input_ids
        .zeros_like()
        .map_err(|_| EngineError::EmbeddingFailed)?;
    let embeddings = loaded
        .model
        .forward(&input_ids, &token_type_ids, None)
        .map_err(|e| fmt_stage_fail("embed.forward", e, EngineError::EmbeddingFailed))?;
    // [1, seq, hidden] → mean over seq → [1, hidden] → [hidden].
    let (_b, n_tokens, _h) = embeddings
        .dims3()
        .map_err(|_| EngineError::EmbeddingFailed)?;
    let pooled = (embeddings
        .sum(1)
        .map_err(|_| EngineError::EmbeddingFailed)?
        / (n_tokens as f64))
        .map_err(|_| EngineError::EmbeddingFailed)?;
    let pooled = pooled
        .squeeze(0)
        .map_err(|_| EngineError::EmbeddingFailed)?;
    // L2 normalize.
    let norm = pooled
        .sqr()
        .map_err(|_| EngineError::EmbeddingFailed)?
        .sum_all()
        .map_err(|_| EngineError::EmbeddingFailed)?
        .sqrt()
        .map_err(|_| EngineError::EmbeddingFailed)?;
    let normalized = pooled
        .broadcast_div(&norm)
        .map_err(|_| EngineError::EmbeddingFailed)?;
    normalized
        .to_vec1()
        .map_err(|_| EngineError::EmbeddingFailed)
}

impl Engine for CandleEngine {
    fn infer(&self, prompt: &str) -> Result<String, EngineError> {
        // Serialize all GPU work (see `compute`): a concurrent embed on the same
        // Metal device crashes the AGX driver. Held for the whole call.
        let _compute = self.compute.lock().unwrap_or_else(|p| p.into_inner());
        let mut guard = self.gen.lock().unwrap_or_else(|p| p.into_inner());
        if guard.is_none() {
            *guard = Some(self.load_gen()?);
        }
        let loaded = guard.as_mut().expect("just loaded");
        let started = Instant::now();
        let out = run_infer(loaded, prompt);
        match &out {
            Ok(s) => tracing::info!(
                target: "myne::ai",
                op = "infer",
                elapsed_ms = started.elapsed().as_millis() as u64,
                out_chars = s.chars().count(),
                "inference complete"
            ),
            Err(e) => tracing::error!(
                target: "myne::ai",
                op = "infer",
                error_kind = e.kind(),
                "inference failed"
            ),
        }
        out
    }

    fn invalidate_models(&self) {
        // Drop both cached models under the compute lock so an in-flight
        // infer/embed finishes first and the next call reloads the freshly
        // selected weights (model-swap-without-restart correctness, §9.17.2).
        let _compute = self.compute.lock().unwrap_or_else(|p| p.into_inner());
        *self.gen.lock().unwrap_or_else(|p| p.into_inner()) = None;
        *self.embed.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }

    fn embed(&self, text: &str) -> Result<Vec<f32>, EngineError> {
        // Serialize all GPU work (see `compute`): a concurrent infer on the same
        // Metal device crashes the AGX driver. Held for the whole call.
        let _compute = self.compute.lock().unwrap_or_else(|p| p.into_inner());
        let mut guard = self.embed.lock().unwrap_or_else(|p| p.into_inner());
        if guard.is_none() {
            *guard = Some(self.load_embed()?);
        }
        let loaded = guard.as_ref().expect("just loaded");
        let started = Instant::now();
        let out = run_embed(loaded, text);
        match &out {
            Ok(v) => tracing::debug!(
                target: "myne::ai",
                op = "embed",
                elapsed_ms = started.elapsed().as_millis() as u64,
                dims = v.len(),
                "embedding complete"
            ),
            Err(e) => tracing::error!(
                target: "myne::ai",
                op = "embed",
                error_kind = e.kind(),
                "embedding failed"
            ),
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::local_inference::model_store::{set_selected_model, ModelRole};
    use crate::test_support::ScopedTempDir;
    use std::path::Path;

    // Model-loading + real inference/embedding are verified only with a model
    // present (side-loaded) — those are `#[ignore]`d, driven by env vars so any
    // dev who has side-loaded a model can smoke-test the real engine:
    //   MYNE_TEST_GEN_MODEL=<qwen2.gguf>       (sibling tokenizer.json)
    //   MYNE_TEST_EMBED_MODEL=<minilm.safetensors> (sibling config.json + tokenizer.json)
    //   cargo test -p myne-desktop --features local-inference --lib \
    //     engine_candle -- --ignored --nocapture
    // What IS verifiable model-free: the no-model path returns `NotReady` (never
    // panics, never fabricates output).

    #[test]
    fn infer_without_a_model_is_not_ready() {
        let tmp = ScopedTempDir::new("candle-engine-noinfer").expect("tempdir");
        let engine = CandleEngine::new(tmp.path().to_path_buf());
        assert_eq!(engine.infer("hello"), Err(EngineError::NotReady));
    }

    #[test]
    fn embed_without_a_model_is_not_ready() {
        let tmp = ScopedTempDir::new("candle-engine-noembed").expect("tempdir");
        let engine = CandleEngine::new(tmp.path().to_path_buf());
        assert_eq!(engine.embed("hello"), Err(EngineError::NotReady));
    }

    #[test]
    #[ignore = "needs a side-loaded Qwen2 GGUF — set MYNE_TEST_GEN_MODEL=<path>.gguf (sibling tokenizer.json)"]
    fn infer_with_a_real_model_generates_text() {
        let Ok(model) = std::env::var("MYNE_TEST_GEN_MODEL") else {
            eprintln!(
                "skip: set MYNE_TEST_GEN_MODEL to a Qwen2 GGUF (with a sibling tokenizer.json)"
            );
            return;
        };
        let tmp = ScopedTempDir::new("candle-real-infer").expect("tempdir");
        set_selected_model(tmp.path(), ModelRole::Generation, Path::new(&model))
            .expect("record generation model");
        eprintln!("\n=== COMPUTE DEVICE: {:?} ===\n", select_device());
        let engine = CandleEngine::new(tmp.path().to_path_buf());

        let prompt = "Summarize the following note concisely, in a few sentences:\n\n\
            The mitochondria is the powerhouse of the cell. It generates most of \
            the cell's supply of ATP through cellular respiration.";
        // Cold = first call (lazy model load + generation); warm = second call
        // (model cached → pure generation speed, the repeated-use metric).
        let t_cold = std::time::Instant::now();
        let out = engine
            .infer(prompt)
            .expect("infer should succeed with a real model");
        let cold_ms = t_cold.elapsed().as_millis();
        let t_warm = std::time::Instant::now();
        let _ = engine.infer(prompt).expect("second infer");
        let warm_ms = t_warm.elapsed().as_millis();
        eprintln!("\n=== TIMING: cold(load+gen)={cold_ms}ms  warm(gen only)={warm_ms}ms ===\n");
        eprintln!("=== REAL INFER OUTPUT ===\n{out}\n=========================\n");

        assert!(!out.trim().is_empty(), "expected non-empty generated text");
        // The ChatML template makes the model emit `<|im_end|>` and STOP — a
        // bounded answer, not the 512-token repeat-loop a bare prompt produced.
        assert!(
            out.chars().count() < 2000,
            "output should be bounded (stopped at <|im_end|>), got {} chars",
            out.chars().count()
        );
        // A real summary of THIS note mentions its subject; the bare-prompt bug
        // produced "please provide the note" instead.
        let low = out.to_lowercase();
        assert!(
            low.contains("mitochond") || low.contains("atp") || low.contains("cell"),
            "summary should reference the note's content, got: {out}"
        );
    }

    #[test]
    #[ignore = "needs a side-loaded MiniLM safetensors — set MYNE_TEST_EMBED_MODEL=<path>.safetensors (siblings config.json + tokenizer.json)"]
    fn embed_with_a_real_model_returns_a_384_vector() {
        let Ok(model) = std::env::var("MYNE_TEST_EMBED_MODEL") else {
            eprintln!("skip: set MYNE_TEST_EMBED_MODEL to a MiniLM safetensors (with siblings config.json + tokenizer.json)");
            return;
        };
        let tmp = ScopedTempDir::new("candle-real-embed").expect("tempdir");
        set_selected_model(tmp.path(), ModelRole::Embedding, Path::new(&model))
            .expect("record embedding model");
        let engine = CandleEngine::new(tmp.path().to_path_buf());

        let anchor = engine
            .embed("The mitochondria is the powerhouse of the cell.")
            .expect("embed should succeed with a real model");
        assert_eq!(anchor.len(), 384, "MiniLM-L6 produces 384-dim embeddings");
        // L2-normalized → unit length.
        let norm: f32 = anchor.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!(
            (norm - 1.0).abs() < 1e-3,
            "expected L2-normalized (norm≈1), got {norm}"
        );

        // Cosine sanity: related text is closer than unrelated.
        let cos = |a: &[f32], b: &[f32]| a.iter().zip(b).map(|(x, y)| x * y).sum::<f32>();
        let close = engine
            .embed("Cells generate energy inside mitochondria.")
            .expect("embed");
        let far = engine
            .embed("The stock market fell sharply this afternoon.")
            .expect("embed");
        let sim_close = cos(&anchor, &close);
        let sim_far = cos(&anchor, &far);
        eprintln!("\n=== REAL EMBED cosine: related={sim_close:.3}  unrelated={sim_far:.3} ===\n");
        assert!(
            sim_close > sim_far,
            "related text ({sim_close:.3}) should be more similar than unrelated ({sim_far:.3})"
        );
    }
}
