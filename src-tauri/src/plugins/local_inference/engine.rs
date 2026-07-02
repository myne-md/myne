//! The [`Engine`] trait — the single seam every AI capability sibling reaches
//! inference through (SYNC-3/7). Two methods, `infer` and `embed`; the impl
//! (a stub now, Candle then a sandboxed sidecar later) is hidden so the
//! in-host-vs-sidecar process boundary and any future engine swap stay
//! invisible to callers.
//!
//! The trait is **synchronous** by design: model inference is CPU-bound and
//! blocking, so the async / `spawn_blocking` seam belongs at the command
//! layer (tasks 3/6), not in the trait. It is `Send + Sync` so one engine
//! instance can back concurrent commands behind `Arc`.

use super::error::EngineError;

/// Length of the **stub** embedding vector. The real embedding model
/// (all-MiniLM-L6-v2, 384-dim, SYNC-1) lands in task 4; the stub returns a
/// short deterministic zero vector purely to exercise the trait shape.
pub const STUB_EMBED_DIM: usize = 8;

/// On-device inference surface (SYNC-7): a blocking `infer(prompt) -> result`
/// and `embed(text) -> vector`. No streaming (SYNC-7). Implementors must be
/// `Send + Sync` so a single engine instance can back concurrent commands
/// behind `Arc`.
pub trait Engine: Send + Sync {
    /// One-shot text completion for `prompt`. Blocking; returns the full
    /// result — no token stream (SYNC-7).
    fn infer(&self, prompt: &str) -> Result<String, EngineError>;

    /// Embedding vector for `text`. Real models return a fixed dimensionality
    /// (task 4: 384); the stub returns [`STUB_EMBED_DIM`] zeros.
    fn embed(&self, text: &str) -> Result<Vec<f32>, EngineError>;

    /// Drop any lazily-cached loaded model so the next `infer`/`embed` re-reads
    /// from disk. Called after the user picks a new model file
    /// (`set_model_path`) so a swap takes effect without an app restart —
    /// otherwise the process keeps serving the previously-loaded weights while a
    /// freshly persisted embeddings index is (correctly) labeled with the NEW
    /// model identity, silently poisoning retrieval (§9.17.2/§9.17.4). Default
    /// no-op — the stub holds no cache.
    fn invalidate_models(&self) {}
}

/// Trivial in-memory engine used before any model lands (the task-1 tracer).
///
/// `infer` echoes the prompt behind a fixed marker; `embed` returns a
/// [`STUB_EMBED_DIM`]-length zero vector. Deterministic, allocation-only — no
/// model, no network, no file I/O — so it proves the trait shape and the
/// feature isolation compile and round-trip.
#[derive(Debug, Default, Clone, Copy)]
pub struct StubEngine;

impl Engine for StubEngine {
    fn infer(&self, prompt: &str) -> Result<String, EngineError> {
        // Echo, not a model. The marker lets a test assert the value came
        // through the trait against the stub (not a real completion).
        Ok(format!("stub-infer: {prompt}"))
    }

    fn embed(&self, _text: &str) -> Result<Vec<f32>, EngineError> {
        Ok(vec![0.0; STUB_EMBED_DIM])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stub_infer_returns_non_empty_through_trait() {
        let engine: &dyn Engine = &StubEngine;
        let out = engine.infer("hello").expect("stub infer never fails");
        assert!(!out.is_empty());
        assert!(out.contains("hello"));
    }

    #[test]
    fn stub_embed_returns_fixed_dim_through_trait() {
        let engine: &dyn Engine = &StubEngine;
        let v = engine.embed("hello").expect("stub embed never fails");
        assert_eq!(v.len(), STUB_EMBED_DIM);
    }
}
