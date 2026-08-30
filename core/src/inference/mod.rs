// SPDX-License-Identifier: AGPL-3.0
//! The inference seam: the [`engine::Engine`] trait, the backend registry that
//! decides which backend answers a request, and the remote-provider arm.
//!
//! **Why this lives in `myne-core` rather than in the desktop crate.** The
//! remote arm was always independent of local inference: [`provider_registry`]
//! depends on the [`engine::Engine`] *trait* rather than on any Candle
//! implementation, [`provider_transport`] builds on this crate's own
//! [`crate::http::codec`], and [`provider_gate`] reads nothing but a
//! [`protocol::PrefsView`]. Copying it into the mobile tree instead would have
//! created a second drift source for a layer that is already portable, and
//! `scripts/check-twin-drift.mjs` only warns.
//!
//! **What moved and what did not.** The Candle engine, the Ollama loopback
//! engine, retrieval and the vector store stay in the desktop crate: those are
//! the local half. What is here is the trait every backend implements, the
//! error type, the ChatML sanitizer, the cancellable-IO wrapper the streaming
//! reads poll through, the remote registry, its transport, its consent gate,
//! and [`state`], which holds the backend registry.
//!
//! **[`state`] is here for a reason that is not tidiness.** It owns the rule
//! that an [`state::RequestClass::Ambient`] request is refused a
//! [`state::BackendClass::Remote`] backend. That is a security decision about
//! unmetered billing and silent background egress, and leaving each client to
//! re-implement its own backend selection would have put it in two places that
//! only a warning-level guard compares. One copy, called by both clients.
//!
//! **The whole module is behind the default-off `remote-ai` cargo feature**,
//! and that gate is load-bearing rather than hygienic. The desktop auditable
//! build is `cargo build -p myne-desktop --no-default-features`, which drops
//! the `local-inference` feature and with it every line of remote-provider
//! code, because that code used to live inside the desktop plugin. `myne-core`
//! compiles unconditionally, so an ungated move would have put the remote arm
//! back into the audit build and widened the baseline the AI-delta check in
//! `src-tauri/scripts/ai-no-network-check.sh` diffs against, silently. The
//! desktop `local-inference` feature therefore implies `myne-core/remote-ai`.
//!
//! One caveat that belongs next to the gate rather than in a commit message:
//! cargo unifies features across a workspace, so a workspace-wide build or test
//! run always compiles this on. The feature only drops in an isolated
//! single-package `--no-default-features` build, which is exactly how the audit
//! build runs, and it protects nothing anywhere else.

/// How an agent run reaches a backend. Shared rather than per-client since
/// myne-md/myne#456; see the module doc for why this half moved and the
/// host-coupled half did not.
pub mod agent_adapter;
pub mod cancellable_io;
pub mod chatml;
pub mod engine;
pub mod error;
/// The Tauri-host adapters both clients share: note reads, the restore point,
/// and the approved batch write. `ScopeSearcher` is deliberately NOT here; see
/// the module doc.
pub mod provider_gate;
pub mod provider_registry;
pub mod provider_transport;
pub mod state;

pub use self::engine::{Engine, StubEngine};
pub use self::error::EngineError;
