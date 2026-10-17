// SPDX-License-Identifier: AGPL-3.0
//! Plugin state: the shared [`Engine`] instance.
//!
//! Held as `Arc<dyn Engine>` so the (single) engine can back concurrent
//! `infer` commands across the async runtime — the trait is
//! `Send + Sync`, so this is too. The real engine (tasks 3–5) may wrap mutable
//! model-load state in `tokio::sync::Mutex`; the task-1 stub is immutable and
//! needs none.

use std::sync::Arc;

use super::engine::{Engine, StubEngine};

/// App-managed singleton holding the active [`Engine`]. Registered via
/// `app.manage(LocalInferenceState::default())` in [`super::init`].
pub struct LocalInferenceState {
    engine: Arc<dyn Engine>,
}

impl Default for LocalInferenceState {
    fn default() -> Self {
        Self {
            engine: Arc::new(StubEngine),
        }
    }
}

impl LocalInferenceState {
    /// Construct with a specific engine — the production path installs the
    /// Candle-backed [`super::engine_candle::CandleEngine`]; `default()` keeps
    /// the [`StubEngine`] for tests + the model-less baseline.
    pub fn new(engine: Arc<dyn Engine>) -> Self {
        Self { engine }
    }

    /// Borrow the shared engine. Callers reach inference ONLY through the
    /// returned `Arc<dyn Engine>` (the trait), never a concrete impl.
    pub fn engine(&self) -> Arc<dyn Engine> {
        Arc::clone(&self.engine)
    }
}
