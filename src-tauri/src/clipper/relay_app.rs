//! App-process wiring for the host↔app relay (TB10, task 6).
//!
//! [`relay`](super::relay) owns the transport + the keyed re-validation; this
//! module is the thin glue that backs the relay's two seams with the running
//! app's REAL state:
//!
//! - [`AppVaultStatus`] implements [`VaultStatusSource`] over the live
//!   `VaultRuntimeState` `Slot` — `is-unlocked-status` is answered from the
//!   actual lock state, NOT a static stub.
//! - [`AppNoteWriter`] implements [`super::ingest::NoteWriter`] by calling the
//!   **existing `note_create` pipeline** (`notes::note_create_with_dir`,
//!   signature `plaintext: String`) — the composed clip lands as an ordinary
//!   `.myn` note at the vault root. NO new `clip_ingest` command.
//!
//! [`spawn_relay_listener`] binds the owner-only (0600) Unix-domain-socket
//! listener under the app-data dir and serves connections on a dedicated
//! background thread for the app's lifetime. The host-mode process connects to
//! the SAME socket and forwards frames; every forwarded frame is re-validated
//! app-side as untrusted input (see [`super::ingest`]).
//!
//! ## Why a background std thread + `block_on`
//!
//! The relay listener is blocking IO (`accept` / `read_frame`), so it runs on a
//! dedicated std thread (not a tokio worker) — the same shape as the app's
//! other long-lived timers. The note-write and the slot-status read are async
//! (they touch `VaultRuntimeState`'s `tokio::sync::RwLock`), so the adapters
//! bridge to the Tauri async runtime via `tauri::async_runtime::block_on`.
//! Because the call site is a std thread, `block_on` does not stall a tokio
//! worker.
//!
//! ## No network fetch (SYNC-12)
//!
//! Nothing here fetches a URL. The write path is `compose → note_create`; the
//! status path is a `Slot` read. There is no HTTP client, no socket dial beyond
//! the LOCAL Unix socket, no URL dereference anywhere on the ingest path.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

#[cfg(desktop)]
use tauri::{AppHandle, Manager, Runtime};

use super::envelope::{vault_status_from_slot_kind, VaultStatus, VaultStatusSource};
use super::ingest::NoteWriter;

/// [`VaultStatusSource`] backed by the running app's real `Slot`.
///
/// Answers `is-unlocked-status` from the live `VaultRuntimeState` slot via the
/// canonical [`vault_status_from_slot_kind`] projection (only `Slot::Unlocked`
/// → `Unlocked`; `Empty`/`Recovering` → `Locked`, fail-secure).
#[cfg(desktop)]
pub struct AppVaultStatus<R: Runtime> {
    app: AppHandle<R>,
}

#[cfg(desktop)]
impl<R: Runtime> AppVaultStatus<R> {
    /// Bind the status source to the running app.
    pub fn new(app: AppHandle<R>) -> Self {
        AppVaultStatus { app }
    }
}

#[cfg(desktop)]
impl<R: Runtime> VaultStatusSource for AppVaultStatus<R> {
    fn vault_status(&self) -> VaultStatus {
        let Some(state) = self
            .app
            .try_state::<crate::plugins::vault_unlock::state::VaultRuntimeState>()
        else {
            // No vault-runtime state managed yet → fail-secure Locked.
            return VaultStatus::Locked;
        };
        let kind = tauri::async_runtime::block_on(state.slot_kind_active());
        vault_status_from_slot_kind(kind)
    }
}

/// [`NoteWriter`] backed by the existing `note_create` pipeline.
///
/// Resolves `<active-vault>/notes/` and calls
/// `notes::note_create_with_dir(notes_dir, state, plaintext)` — the SAME
/// pipeline the WebView `note_create` command drives (mint UUIDv7 → AEAD seal →
/// atomic create-only write). The clip therefore lands as an ordinary `.myn`
/// note at the vault root (`folder: null`, SYNC-15). A failure is reduced to a
/// closed `&'static str` label (DENY-list-clean) for the reply.
#[cfg(desktop)]
pub struct AppNoteWriter<R: Runtime> {
    app: AppHandle<R>,
}

#[cfg(desktop)]
impl<R: Runtime> AppNoteWriter<R> {
    /// Bind the note writer to the running app.
    pub fn new(app: AppHandle<R>) -> Self {
        AppNoteWriter { app }
    }
}

#[cfg(desktop)]
impl<R: Runtime> NoteWriter for AppNoteWriter<R> {
    fn write_clip_note(&self, plaintext: String) -> Result<String, &'static str> {
        let Some(state) = self
            .app
            .try_state::<crate::plugins::vault_unlock::state::VaultRuntimeState>()
        else {
            return Err("vault_not_unlocked");
        };
        let app = self.app.clone();
        tauri::async_runtime::block_on(async move {
            // Resolve the active vault's notes dir (lazy create). A resolution
            // failure is a closed label — no path bytes cross the boundary.
            let notes_dir = match crate::paths::notes_dir_for(&app, state.active_vault_id().await) {
                Ok(d) => d,
                Err(_) => return Err("notes_dir"),
            };
            // The EXISTING note_create pipeline — signature unchanged.
            match crate::plugins::notes::commands::note_create_with_dir(
                notes_dir,
                state.inner(),
                plaintext,
            )
            .await
            {
                Ok(id) => Ok(id),
                Err(e) => Err(note_create_error_label(&e)),
            }
        })
    }
}

/// Closed `&'static str` label for a [`crate::plugins::notes::error::NoteCreateError`]
/// (DENY-list-clean; a new variant compile-fails this match). Mirrors the
/// private `note_create_error_kind` in the notes plugin so the relay reply
/// carries only a bounded label, never a path or body.
#[cfg(desktop)]
fn note_create_error_label(e: &crate::plugins::notes::error::NoteCreateError) -> &'static str {
    use crate::plugins::notes::error::NoteCreateError;
    match e {
        // The author-facing label for the over-cap case (story 17). The ingest
        // path already caps the composed body before calling note_create, so
        // this is a belt-and-suspenders mapping.
        NoteCreateError::PlaintextTooLarge => "note_body_oversized",
        NoteCreateError::VaultNotUnlocked => "vault_not_unlocked",
        NoteCreateError::NoteAlreadyExists => "note_already_exists",
        NoteCreateError::NotesDirNotADirectory => "notes_dir",
        NoteCreateError::Io { .. } => "io",
        NoteCreateError::JoinFailure => "join_failure",
    }
}

/// Spawn the app-side relay listener on a dedicated background thread.
///
/// Binds the owner-only (0600) Unix-domain-socket listener under the app-data
/// dir and serves each incoming connection through the keyed re-validation path
/// ([`super::relay::serve_connection`]) backed by the app's REAL registry,
/// vault status, and `note_create`. Runs for the app's lifetime.
///
/// Best-effort: if the app-data dir cannot be resolved or the socket cannot be
/// bound, the relay is simply not available (a clip then fails honestly with
/// "open Myne to clip" — task 8 — rather than the app refusing to start). The
/// failure is logged with a closed label, never a path.
///
/// The authoritative [`TokenRegistry`] lives in the WebView-owned
/// [`crate::plugins::clipper_pairing::state::PairingState`]; the listener reads
/// a fresh snapshot per connection so a token minted / revoked in the dialog
/// takes effect on the next clip (revocation is desktop-authoritative — task 7
/// persists the registry; here it is the live in-memory one).
///
/// [`TokenRegistry`]: super::token::TokenRegistry
#[cfg(all(desktop, unix))]
pub fn spawn_relay_listener<R: Runtime>(app: AppHandle<R>) {
    let app_data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => {
            tracing::error!(
                stage = "clip_relay_listen",
                error = "app_data_dir_unresolved",
                "clipper relay not started: could not resolve app_data_dir"
            );
            return;
        }
    };
    // Ensure the app-data dir exists (the socket lives directly in it).
    let _ = std::fs::create_dir_all(&app_data_dir);
    let socket = super::relay::socket_path(&app_data_dir);

    std::thread::Builder::new()
        .name("clipper-relay".into())
        .spawn(move || {
            let listener = match super::relay::bind_listener(&socket) {
                Ok(l) => l,
                Err(e) => {
                    let kind = crate::io_failure_kind::from_io_error_kind(e.kind());
                    tracing::error!(
                        stage = "clip_relay_bind",
                        io_failure_kind = ?kind,
                        "clipper relay listener could not bind; relay unavailable"
                    );
                    return;
                }
            };
            tracing::debug!(stage = "clip_relay_listen", event = "listening");

            let status = AppVaultStatus::new(app.clone());
            let note_writer = AppNoteWriter::new(app.clone());

            for incoming in listener.incoming() {
                let mut stream = match incoming {
                    Ok(s) => s,
                    Err(e) => {
                        let kind = crate::io_failure_kind::from_io_error_kind(e.kind());
                        tracing::debug!(stage = "clip_relay_accept", io_failure_kind = ?kind);
                        continue;
                    }
                };
                // A fresh registry snapshot per connection so a just-minted /
                // just-revoked token is honoured on the next clip.
                let registry =
                    match app.try_state::<crate::plugins::clipper_pairing::state::PairingState>() {
                        Some(s) => s.registry_snapshot(),
                        None => super::token::TokenRegistry::new(), // empty ⇒ silent
                    };
                // A per-connection rate limiter (the connection is the unit a
                // single extension uses for a clip; the app-side limiter is the
                // authoritative one — a compromised host cannot bypass it).
                let mut limiter = super::rate_limit::RateLimiter::default();

                let read_half = match stream.try_clone() {
                    Ok(r) => r,
                    Err(e) => {
                        let kind = crate::io_failure_kind::from_io_error_kind(e.kind());
                        tracing::debug!(stage = "clip_relay_clone", io_failure_kind = ?kind);
                        continue;
                    }
                };
                let mut read_half = read_half;
                if let Err(e) = super::relay::serve_connection(
                    &mut read_half,
                    &mut stream,
                    &registry,
                    &status,
                    &mut limiter,
                    &note_writer,
                ) {
                    let kind = crate::io_failure_kind::from_io_error_kind(e.kind());
                    tracing::debug!(stage = "clip_relay_serve", io_failure_kind = ?kind);
                }
            }
        })
        .ok();
}
