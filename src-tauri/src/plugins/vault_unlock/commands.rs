//! Tauri commands for the vault-unlock plugin.
//!
//! - [`unlock`] — read `vault.meta`, derive `password_wrap_key`
//!   (Argon2id), AEAD-decrypt `enc_root_key_password`, eager-derive
//!   plus AEAD-decrypt the singleton `itemsKey`, populate the
//!   single-slot [`super::state::VaultRuntimeState`].
//! - [`lock`] — companion: drop the slot, zeroize the keys, return
//!   `Ok(())`. Param-less, idempotent.
//!
//! Design history: `agent-tooling/features/vault-unlock-password/`
//! (PRD + task log) and the grilling session referenced from
//! `super::mod.rs`.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

use super::error::{VaultStatusError, VaultUnlockError};
use super::state::{Slot, SlotKind, UnlockedVault, VaultRuntimeState};
use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use crate::protocol_error_kind::protocol_error_kind;
use protocol::{VaultMeta, AEAD_KEY_LEN, AEAD_NONCE_LEN};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::{AppHandle, Manager, Runtime, State};
use zeroize::Zeroizing;

/// Bundle returned by the spawn_blocking pipeline closure: both
/// derived keys (Zeroizing-wrapped; bytes wipe on drop, including
/// the early-return paths inside the closure when items_key
/// derivation fails) plus the `items_key_id` UUID parsed out of
/// `vault.meta` (not secret-bearing; copy is cheap) plus the
/// `vault_meta_bytes_hash` (`SHA-256(read bytes)`) which becomes the
/// `Slot::Unlocked` CAS anchor for `vault_change_password`'s in-place
/// rewrite per `decisions.md` 2026-05-06 entry.
struct DerivedKeys {
    root_key: Zeroizing<[u8; AEAD_KEY_LEN]>,
    items_key: Zeroizing<[u8; AEAD_KEY_LEN]>,
    items_key_id: [u8; 16],
    vault_meta_bytes_hash: [u8; 32],
}

/// Resolve `<app_data_dir>/vault/vault.meta` for the running app.
///
/// Distinct from `crate::paths::vault_dir` (which lives in the
/// `vault_creation` plugin's error-type universe). This helper returns
/// `VaultUnlockError` so callers in this plugin do not need a cross-
/// plugin error conversion.
///
/// Does NOT call `create_dir_all` — unlock is a read-only operation;
/// if the vault directory does not exist, the subsequent `fs::read`
/// will return `NotFound`, which the caller maps to
/// [`VaultUnlockError::VaultNotFound`].
fn vault_meta_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, VaultUnlockError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| VaultUnlockError::IoError {
            io_error_kind: IoFailureKind::Other,
        })?;
    Ok(base.join("vault").join("vault.meta"))
}

/// Open an existing vault with the user's master password.
///
/// On the first line, `password` is moved into a [`Zeroizing<String>`]
/// whose lifetime is bounded by the `spawn_blocking` closure: when the
/// closure ends (success or failure), the wrapper drops and the
/// password's bytes are wiped. The inner derivation helpers borrow
/// `&str` — no clone, no format-arg, no log of the password.
///
/// Internal sequence (permit-first per grilling Q5 +
/// `decisions.md` 2026-05-02 Phase 1 unlock UI semantics):
///
/// 1. Slot peek (cheap read-lock). If the vault is already unlocked,
///    return [`VaultUnlockError::VaultAlreadyUnlocked`] immediately —
///    fast-path observable, never blocks on the permit.
/// 2. `Semaphore::try_acquire` (capacity 1). If another unlock is in
///    flight, return [`VaultUnlockError::UnlockInProgress`] without
///    queueing (rejection posture per `recovery-flow.md` §3.3 — no
///    queue, no sleep-based throttle). The permit is held by an RAII
///    guard for the entire critical section; drops on any return path.
/// 3. Read `<app_data_dir>/vault/vault.meta`.
///    - Missing file → [`VaultUnlockError::VaultNotFound`].
///    - Other IO error → [`VaultUnlockError::IoError`] with
///      bounded [`IoFailureKind`].
/// 4. Parse the bytes via `protocol::parse_vault_meta`.
///    - Reject → [`VaultUnlockError::InvalidVaultMeta`].
/// 5. `tokio::task::spawn_blocking` runs the full key-derivation
///    pipeline (microseconds-fast steps colocated with the ~1 s
///    Argon2id step for code locality):
///    - (a) `derive_root_key` — Argon2id + AEAD-open password wrap.
///      AEAD-tag failure → `InvalidCredentialOrVault` (§7.3).
///    - (b) `derive_items_key` — HKDF subkey + AEAD-open items_key
///      blob. AEAD-tag failure → `InvalidVaultMeta` (per
///      `decisions.md` 2026-05-02 — Task 11). On failure the
///      `root_key` Zeroizing drops on early-return and the slot
///      stays empty (no half-state).
/// 6. Populate [`super::state::VaultRuntimeState`]'s slot with the
///    fully-verified [`UnlockedVault`]. Permit is still held; drops
///    when the function returns.
#[tauri::command]
pub async fn unlock<R: Runtime>(
    password: String,
    state: State<'_, VaultRuntimeState>,
    app: AppHandle<R>,
) -> Result<(), VaultUnlockError> {
    let vault_path = vault_meta_path(&app)?;
    unlock_with_path(password, &vault_path, state.inner()).await?;

    // ---- MYND-160 pipeline steps 4-6 (post-`set_unlocked` orchestration) ----
    //
    // The grill (Q5.1) frames these as part of the unlock "pipeline";
    // the physical implementation places them at the Tauri-wrapper
    // boundary so the testable core `unlock_with_path` stays a pure
    // crypto pipeline and existing tests need no signature churn. The
    // logical pipeline ordering ("by the time the user sees unlock
    // success, prefs are applied") is preserved — the slot transitions
    // to `Unlocked` inside `unlock_with_path` first, then steps 4-6
    // run before this command returns to the WebView. Phase 1
    // single-window guarantees no concurrent reader observes the
    // brief "slot=Unlocked but prefs not yet applied" window. See
    // `decisions.md` 2026-05-27 "Vault preferences blob".
    //
    // Best-effort end-to-end: any failure in prefs decrypt or native
    // apply degrades to defaults (PrefsView::default = protection ON),
    // logged via `tracing::warn!` inside `prefs::read_or_default`
    // and `screen_capture::apply`. **vault_unlock's `VaultUnlockError`
    // surface is unchanged** — the user's unlock succeeds regardless.
    apply_persisted_prefs(&app, state.inner()).await;

    // ---- MYND-29 Task 7: hydrate the search index ----------------------
    //
    // Load `vault.search` (fast path) + incrementally reconcile against the
    // notes dir's current `.myn` header nonces — re-indexing only changed
    // notes, full-rebuild on an absent / AEAD-fail blob. Best-effort and
    // INLINE (awaited before returning to the WebView, like
    // `apply_persisted_prefs`): a search-persistence failure never blocks
    // unlock, and running inline keeps it from racing a concurrent
    // `vault_lock` into repopulating a just-cleared index. A cold first
    // unlock (no blob) is a full rebuild — a known latency cost the Task 9
    // benchmark will quantify.
    crate::plugins::notes::search_sync::hydrate_search_index(&app, state.inner()).await;

    Ok(())
}

/// MYND-160 pipeline steps 4-6: derive `prefs_key` from the just-
/// unlocked `root_key`, read `vault.prefs` (falling back to defaults
/// on absence / AEAD-fail / parse-fail per spec § 9.5.5), then apply
/// the persisted `screen_capture_protection` toggle natively via
/// `screen_capture::apply`.
///
/// Best-effort: never returns an error, never panics. Slot
/// invariance — the Slot was just transitioned to `Unlocked` by
/// `unlock_with_path`, so the peek inside `prefs::commands::
/// prefs_read_with_dir` is expected to succeed. If a concurrent
/// `vault_lock` raced between `unlock_with_path` return and this
/// call (theoretically possible under Phase 2 multi-window or a
/// future spawn-after-unlock-callback pattern; impossible in Phase 1
/// single-window), `prefs_read_with_dir` returns
/// `PrefsReadError::SlotNotUnlocked`, which we collapse to defaults
/// (protection ON) — the lock-on-default-ON discipline from
/// `decisions.md` 2026-05-27 already applied `screen_capture::apply(true)`
/// inside `vault_lock`, so the additional `apply(true)` here is a
/// harmless no-op idempotent.
pub(crate) async fn apply_persisted_prefs<R: Runtime>(
    app: &AppHandle<R>,
    state: &VaultRuntimeState,
) {
    let Ok(vault_dir) = resolve_vault_dir(app) else {
        // app_data_dir lookup failure is structurally rare; if it
        // happens, fall back to the safer state (protection ON).
        tracing::warn!(
            event = "prefs_post_unlock_skipped",
            reason = "vault_dir_resolution_failed",
        );
        crate::screen_capture::apply(app, true, "runtime_apply");
        return;
    };

    let prefs = match crate::plugins::prefs::commands::prefs_read_with_dir(&vault_dir, state).await
    {
        Ok(view) => view,
        Err(e) => {
            // MYND-160 fix: log PrefsReadError before collapsing to
            // defaults so support flows can distinguish "user has no
            // persisted preference" (handled silently by read_or_default
            // inside prefs_read_with_dir) from "vault.meta read or parse
            // failed" (this branch) — both produce default-ON natively
            // but the latter is a structural problem worth a trace
            // entry. The vault_dir-resolution-failed branch above warns
            // similarly; this restores observability symmetry.
            tracing::warn!(
                event = "prefs_post_unlock_skipped",
                reason = "prefs_read_failed",
                error_kind = prefs_read_error_kind(&e),
            );
            crate::plugins::prefs::PrefsView::default()
        }
    };

    crate::screen_capture::apply(app, prefs.screen_capture_protection, "runtime_apply");

    // MYND-121: cache the effective auto-lock timeout for the idle timer.
    // prefs are not held in Slot::Unlocked (disk is canonical), so the timer
    // reads this lock-free atom rather than re-decrypting vault.prefs each
    // tick. The setter IPC (task 9) updates it on a live change.
    state.set_auto_lock_timeout_secs(crate::auto_lock::effective_auto_lock_secs(
        prefs.auto_lock_seconds,
    ));
}

/// Closed-enum mapping for `PrefsReadError` variants emitted from the
/// post-unlock prefs application path. Static-string only, no DENY-list
/// payload leakage (variants are unit-like or carry closed-enum
/// `IoFailureKind`). Mirrors `screen_capture_protection_error_kind`
/// and `prefs_blob_error_kind` discipline from `src-tauri/CLAUDE.md`.
fn prefs_read_error_kind(e: &crate::plugins::prefs::PrefsReadError) -> &'static str {
    use crate::plugins::prefs::PrefsReadError;
    match e {
        PrefsReadError::SlotNotUnlocked => "slot_not_unlocked",
        PrefsReadError::Io { .. } => "io_error",
        PrefsReadError::InvalidVaultMeta => "invalid_vault_meta",
    }
}

/// Local helper: resolve `<app_data_dir>/vault/`. Shaped identically
/// to the prefs plugin's `vault_dir` helper but kept local to avoid
/// a cross-plugin pub re-export; both are ~5-line wrappers around
/// `tauri::path::PathResolver::app_data_dir()`.
fn resolve_vault_dir<R: Runtime>(app: &AppHandle<R>) -> std::io::Result<PathBuf> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| std::io::Error::other("app_data_dir resolution failed"))?;
    Ok(base.join("vault"))
}

/// Testable core of [`unlock`]. The Tauri-command wrapper resolves
/// the platform-specific `vault.meta` path and delegates here so
/// tests do not need an [`AppHandle`].
///
/// All decisions documented on [`unlock`] apply identically.
pub(crate) async fn unlock_with_path(
    password: String,
    vault_path: &Path,
    state: &VaultRuntimeState,
) -> Result<(), VaultUnlockError> {
    // Wrap immediately so any early-return path (VaultAlreadyUnlocked,
    // UnlockInProgress, IO failure, parse failure) drops the wrapper
    // and zeroes the bytes. Plain `String` would drop without zeroize.
    let password = Zeroizing::new(password);

    let started = Instant::now();

    // (1) Slot peek precedes permit acquire so the cheap occupied-slot
    //     guard never blocks on the semaphore (grilling Q5). The two
    //     non-Empty variants surface as distinct guard variants so the
    //     frontend can route correctly: `Unlocked` → editor, `Recovering`
    //     → password-reset form (per `recovery-flow.md` §4.1's
    //     non-dismissible chained step).
    match state.slot_kind().await {
        SlotKind::Empty => {}
        SlotKind::Unlocked => {
            tracing::error!(
                stage = "slot_check",
                error_kind = "VaultAlreadyUnlocked",
                "unlock attempt rejected: slot already populated with Unlocked"
            );
            return Err(VaultUnlockError::VaultAlreadyUnlocked);
        }
        SlotKind::Recovering => {
            tracing::error!(
                stage = "slot_check",
                error_kind = "VaultRecoveryInProgress",
                "unlock attempt rejected: slot is Recovering (password-reset commit pending)"
            );
            return Err(VaultUnlockError::VaultRecoveryInProgress);
        }
    }

    // (2) Acquire the auth permit (Semaphore capacity 1). Reject,
    //     don't queue: `decisions.md` 2026-05-02 ("Slot state machine +
    //     auth_permits generalization") shares the permit across
    //     vault_unlock + vault_recover_with_phrase + vault_complete_recovery
    //     — at most one Argon2id-bound auth op in flight client-wide. The
    //     RAII guard releases the permit on every return path — success,
    //     every error variant, panic unwind. Held across the
    //     spawn_blocking await so a concurrent attempt sees the permit busy.
    let _permit = match state.auth_permits().try_acquire() {
        Ok(p) => p,
        Err(_) => {
            tracing::error!(
                stage = "permit_acquire",
                error_kind = "UnlockInProgress",
                "unlock attempt rejected: another auth op in flight"
            );
            return Err(VaultUnlockError::UnlockInProgress);
        }
    };

    // Own the path so it can move into spawn_blocking (the closure
    // captures by-value). Cheap one-allocation clone.
    let vault_path = vault_path.to_path_buf();

    let join_outcome =
        tokio::task::spawn_blocking(move || -> Result<DerivedKeys, VaultUnlockError> {
            // IO + parse + KDF + AEAD all run inside the blocking
            // task: this frees the runtime worker across the whole
            // pipeline (Windows / cold-disk / antivirus latency
            // doesn't stall the async runtime).
            let bytes = std::fs::read(&vault_path).map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    tracing::error!(
                        stage = "read_meta",
                        error_kind = "VaultNotFound",
                        "vault.meta does not exist (first-run UX routes to creation flow)"
                    );
                    VaultUnlockError::VaultNotFound
                } else {
                    let io_kind = from_io_error_kind(e.kind());
                    tracing::error!(
                        stage = "read_meta",
                        error_kind = "IoError",
                        io_failure_kind = ?io_kind,
                        "vault.meta read failed"
                    );
                    VaultUnlockError::IoError {
                        io_error_kind: io_kind,
                    }
                }
            })?;

            let meta = protocol::parse_vault_meta(&bytes).map_err(|e| {
                tracing::error!(
                    stage = "parse_meta",
                    error_kind = "InvalidVaultMeta",
                    protocol_error_kind = protocol_error_kind(&e),
                    "vault.meta parse rejected"
                );
                VaultUnlockError::InvalidVaultMeta
            })?;

            let items_key_id = meta.items_key_id;
            // SHA-256 of unlock-time vault.meta bytes — the CAS anchor
            // that `vault_change_password` will compare against before
            // rewriting in-place. Computed inside spawn_blocking so
            // sha2 runs on the blocking pool, not the runtime worker.
            let vault_meta_bytes_hash = crate::vault_meta_hash::vault_meta_sha256(&bytes);
            let root_key = derive_root_key(&password, &meta)?;
            // items_key derivation drops `root_key` on early-return;
            // the slot stays empty (no half-state).
            let items_key = derive_items_key(&root_key, &meta)?;
            Ok(DerivedKeys {
                root_key,
                items_key,
                items_key_id,
                vault_meta_bytes_hash,
            })
        })
        .await;

    let DerivedKeys {
        root_key,
        items_key,
        items_key_id,
        vault_meta_bytes_hash,
    } = match join_outcome {
        Ok(Ok(keys)) => keys,
        // Inner `Err` was already traced at its origin (read_meta /
        // parse_meta / password_kdf / root_unwrap / items_key_unwrap);
        // do not double-trace here.
        Ok(Err(inner)) => return Err(inner),
        Err(_) => {
            tracing::error!(
                stage = "spawn_blocking_join",
                error_kind = "JoinFailure",
                "blocking task join failed"
            );
            return Err(VaultUnlockError::JoinFailure);
        }
    };

    let now = Instant::now();
    state
        .set_unlocked(UnlockedVault {
            root_key,
            items_key,
            items_key_id,
            unlocked_at: now,
            vault_meta_bytes_hash,
        })
        .await;

    // Success event. Coarse `duration_ms` only — no account
    // identifier, no path, no key material. Per ALLOW-list in
    // `src-tauri/CLAUDE.md` "Secret-handling logging discipline".
    // `duration_ms` rounded down to 10ms granularity per
    // `decisions.md` 2026-05-06 "Tracing event-name pattern" entry —
    // future-ready timing-channel resistance (Phase 1 A7 side-channel
    // out of scope, but the discipline costs ~zero today).
    tracing::info!(
        event = "vault_unlocked",
        duration_ms = (now.duration_since(started).as_millis() / 10 * 10) as u64,
        "vault unlocked successfully"
    );

    Ok(())
}

/// Step (a) of the spawn_blocking pipeline: derive `password_wrap_key`
/// via Argon2id and AEAD-open `enc_root_key_password`. Borrows the
/// password as `&str`; no clone, no format-arg, no log.
///
/// `AeadFailure` from the AEAD-open is the §7.3 non-distinguishing
/// tag (`InvalidCredentialOrVault` — covers wrong password AND
/// tampered password section indistinguishably). `KdfFailure` and
/// any other `ProtocolError` precede AEAD verification or arise
/// from structural vault.meta corruption; both surface as
/// `InvalidVaultMeta`, leaking no password-conditional information.
fn derive_root_key(
    password: &str,
    meta: &VaultMeta,
) -> Result<Zeroizing<[u8; AEAD_KEY_LEN]>, VaultUnlockError> {
    let wrap_key = protocol::derive_password_wrap_key(
        password,
        &meta.random_salt_password,
        &meta.account_number_hash,
        &meta.kdf_params,
    )
    .map_err(|e| {
        tracing::error!(
            stage = "password_kdf",
            protocol_error_kind = protocol_error_kind(&e),
            "password wrap-key derivation failed"
        );
        password_or_meta(e)
    })?;

    let aad = protocol::aad_password_wrap(&meta.kdf_params);
    open_32_byte_secret(
        &wrap_key,
        &meta.nonce_password_wrap,
        &meta.enc_root_key_password,
        &aad,
        "root_unwrap",
        password_or_meta,
    )
}

/// Error mapping for the password-wrap pipeline (KDF + root_key
/// AEAD-open). `AeadFailure` is the §7.3 non-distinguishing tag
/// (`InvalidCredentialOrVault`); everything else is structural and
/// surfaces as `InvalidVaultMeta`.
fn password_or_meta(e: protocol::ProtocolError) -> VaultUnlockError {
    match e {
        protocol::ProtocolError::AeadFailure => VaultUnlockError::InvalidCredentialOrVault,
        _ => VaultUnlockError::InvalidVaultMeta,
    }
}

/// Step (b) of the spawn_blocking pipeline: derive
/// `itemsKey_wrap_key` via the canonical `derive_subkey` helper
/// (HKDF-SHA-256 with the registered `ItemsKeyWrap` role context
/// string per `protocol.md` §3.4) and AEAD-open `enc_items_key`.
///
/// **Error mapping is intentionally distinct from
/// [`derive_root_key`].** AEAD-tag failure here is mapped to
/// `InvalidVaultMeta`, NOT `InvalidCredentialOrVault`, because the
/// password wrap-key has already verified by the time this is
/// called — distinguishing items_key wrap failure leaks nothing
/// about credential validity (`decisions.md` 2026-05-02 "Phase 1
/// unlock error discipline"). User-facing CTA is uniform with parse
/// errors: "vault file unreadable, restore from a backup".
fn derive_items_key(
    root_key: &[u8; AEAD_KEY_LEN],
    meta: &VaultMeta,
) -> Result<Zeroizing<[u8; AEAD_KEY_LEN]>, VaultUnlockError> {
    let items_wrap_key = protocol::derive_subkey(root_key, protocol::SubkeyRole::ItemsKeyWrap);
    let aad = protocol::aad_vault_items_key_wrap(&meta.items_key_id);
    open_32_byte_secret(
        &items_wrap_key,
        &meta.items_key_nonce,
        &meta.enc_items_key,
        &aad,
        "items_key_unwrap",
        // AEAD failure here is post-password-verification, so it
        // does NOT collapse into `InvalidCredentialOrVault` — the
        // password wrap already verified, and distinguishing this
        // blob's failure leaks no credential information. Single
        // map to `InvalidVaultMeta` per `decisions.md` 2026-05-02.
        |_| VaultUnlockError::InvalidVaultMeta,
    )
}

/// AEAD-open a 32-byte secret blob under `wrap_key` + `nonce` + `aad`,
/// emit a stage-tagged tracing record on failure, and copy the
/// plaintext into a fresh `Zeroizing<[u8; AEAD_KEY_LEN]>`. Used by
/// both `derive_root_key` and `derive_items_key` — the AEAD-open +
/// length-check + copy pattern is the single shared shape for every
/// 32-byte unwrap on the unlock path.
fn open_32_byte_secret(
    wrap_key: &[u8; AEAD_KEY_LEN],
    nonce: &[u8; AEAD_NONCE_LEN],
    sealed: &[u8],
    aad: &[u8],
    stage: &'static str,
    map_err: impl FnOnce(protocol::ProtocolError) -> VaultUnlockError,
) -> Result<Zeroizing<[u8; AEAD_KEY_LEN]>, VaultUnlockError> {
    let plaintext = protocol::aead_open_ctx(wrap_key, nonce, sealed, aad).map_err(|e| {
        tracing::error!(
            stage,
            protocol_error_kind = protocol_error_kind(&e),
            "AEAD-open failed"
        );
        map_err(e)
    })?;
    debug_assert_eq!(plaintext.len(), AEAD_KEY_LEN);
    let mut buf = Zeroizing::new([0u8; AEAD_KEY_LEN]);
    buf.copy_from_slice(&plaintext);
    Ok(buf)
}

/// Close the vault — drops whichever [`Slot`] variant is held,
/// transitioning to [`Slot::Empty`].
///
/// Handles all three variants:
/// - `Slot::Unlocked` → `Zeroize` `root_key` + `items_key` (editor Lock).
/// - `Slot::Recovering` → `Zeroize` recovery-staged keys
///   (`recovery-flow.md` §4.3 within-session bail case).
/// - `Slot::Empty` → no-op `Ok(())` (idempotent).
///
/// The tracing event `vault_locked` carries a `from_slot_kind` static
/// tag (`"unlocked" | "recovering" | "empty"`).
///
/// ## §4.3 bail mechanism — no separate `vault_recover_cancel`
///
/// §4.3 requires that mid-recovery `root_key` be zeroized if the user
/// bails. Process exit handles itself (`Slot::Recovering`'s `Drop`).
/// Within-session bail (WebView reload, route-guard cleanup) calls
/// **this same command** — same mechanism, half the surface. The
/// alternative dedicated `vault_recover_cancel` IPC was rejected
/// (`decisions.md`): non-dismissible UI is the *primary* guard but
/// not load-bearing — Tauri 2's WebView reload bypasses Rust state.
///
/// Async despite read-only-ish: `tokio::sync::RwLock::write().await`
/// is microseconds; no spawn_blocking, no IO.
///
/// ## TOCTOU
///
/// Lock arriving while an unlock/recovery is mid-Argon2id finds the
/// slot still `Empty`; the in-flight op completes and populates the
/// slot afterward, so the lock intent is silently swallowed. Phase 1
/// mitigates this UI-side (Lock affordance hidden during
/// `decrypting`); a Rust-side "lock requested" signal that the
/// pipelines check before populating the slot is a Phase 2+ fix.
#[tauri::command]
pub async fn lock<R: Runtime>(
    state: State<'_, VaultRuntimeState>,
    app: AppHandle<R>,
) -> Result<(), VaultUnlockError> {
    // ---- MYND-29 Task 7: graceful-lock flush ----------------------------
    //
    // Persist the search index to its encrypted `vault.search` blob BEFORE
    // the slot drops — the persist peeks `root_key` from the still-Unlocked
    // slot, so it MUST run ahead of `lock_with_state`. Best-effort: a flush
    // failure must never block the lock (the next unlock reconciles the
    // delta). Idle auto-lock deliberately does NOT call this (Task 8) — it
    // skips persist to avoid blob-write latency on the fail-closed path.
    //
    // NOTE: dropping + zeroizing the plaintext-derived in-RAM index on the
    // lock path (manual + auto, on the same path as the slot drop) is
    // Task 8's job. Until then the index lingers post-lock, but `note_search`
    // gates on `Slot::Unlocked` (returns empty when locked), so there is no
    // IPC leak — only raw RAM retention that Task 8 zeroizes.
    crate::plugins::notes::search_sync::persist_search_index(&app, state.inner()).await;

    lock_with_state(state.inner()).await?;

    // ---- MYND-29 Task 8: wipe the plaintext-derived search index --------
    //
    // On the SAME lock path as the slot drop, immediately after the keys
    // zeroize in `lock_with_state` — the index is plaintext-derived RAM (as
    // sensitive as the keys), so it is overwritten + reset here so no terms
    // survive the manual lock. The persist above already flushed it to the
    // `vault.search` blob (persist-then-wipe); the next unlock reloads it.
    crate::plugins::notes::search_sync::zeroize_search_index(&app);

    // ---- MYND-31: wipe the plaintext-derived VaultIndices ---------------
    //
    // Same lock path as the search-index wipe — the wikilink graph + tag
    // index are plaintext-derived RAM (as sensitive as the keys), wiped here
    // so nothing survives the manual lock. Rebuilt on the next unlock.
    crate::plugins::vault_indices::zeroize_vault_indices(&app);

    // ---- MYND-160 Task 11: post-zeroize native default-ON ---------------
    //
    // Per `decisions.md` 2026-05-27 entry "Lock-on-default-ON: vault_lock
    // re-applies set_content_protected(true) regardless of in-session
    // user preference" — every vault_lock unconditionally restores
    // screen-capture protection to ON, regardless of the user's
    // persisted `vault.prefs` toggle. Post-lock Slot::Empty native
    // state equals pre-unlock Slot::Empty native state (symmetric
    // structural-privacy invariant). The persisted preference stays
    // on disk; the next `vault_unlock` re-reads vault.prefs and
    // re-applies the user's choice via the `apply_persisted_prefs`
    // Task 10 path.
    //
    // Best-effort: `screen_capture::apply` swallows native failures
    // via its own tracing::warn discipline; no error propagation. The
    // call sits AFTER lock_with_state's `Ok(())` early-return is
    // committed — a `vault_locked` event is already in the tracing
    // stream by this point.
    crate::screen_capture::apply(&app, true, "lock_reset");

    Ok(())
}

/// Report the current [`Slot`] variant via the [`SlotKind`]
/// discriminator. Used by frontend boot-time and post-WebView-reload
/// routing — Tauri's Rust state can outlive the WebView's JS state
/// across Cmd+R / hot-reload, so the frontend re-queries which screen
/// to render: `Empty` → unlock (or create), `Recovering` →
/// password-reset form, `Unlocked` → editor.
///
/// **NOT part of the post-recovery happy path.** On success
/// `vault_complete_recovery` returns `Ok(())` and the frontend
/// navigates directly to editor — defensive `vault_slot_kind`
/// round-trip would be paranoia (`decisions.md`: IPC contract pins
/// `Slot::Unlocked` as the success postcondition).
///
/// Wire shape: bare variant-name string (`"Empty" | "Recovering" |
/// "Unlocked"`) per the TS hand-mirror at `src/types/slot-kind.ts`.
///
/// Distinct from [`vault_status`], which probes `vault.meta` on disk
/// (Exists / Missing / Corrupted) for boot routing. `vault_slot_kind`
/// probes the in-memory [`VaultRuntimeState`] slot; the two together
/// cover the full boot decision tree (disk presence → runtime state).
///
/// `Err` arm is structurally unreachable; the `Result` return is for
/// IPC-contract uniformity with the rest of the plugin.
#[tauri::command]
pub async fn vault_slot_kind(
    state: State<'_, VaultRuntimeState>,
) -> Result<SlotKind, VaultUnlockError> {
    vault_slot_kind_inner(state.inner()).await
}

/// Testable core of [`vault_slot_kind`]. The Tauri-command wrapper
/// resolves the [`State`] borrow and delegates here so tests do not
/// need a [`AppHandle`].
pub(crate) async fn vault_slot_kind_inner(
    state: &VaultRuntimeState,
) -> Result<SlotKind, VaultUnlockError> {
    Ok(state.slot_kind().await)
}

/// Testable core of [`lock`]. The Tauri-command wrapper resolves
/// the [`State`] borrow and delegates here so tests do not need a
/// [`AppHandle`].
///
/// Emits a single tracing event `vault_locked` with the
/// `from_slot_kind` tag so ops can group lock events by the prior
/// slot variant. The taken [`Slot`] drops at the end of this
/// function; whichever variant it held has its `Zeroizing` fields
/// wiped in the process.
pub(crate) async fn lock_with_state(state: &VaultRuntimeState) -> Result<(), VaultUnlockError> {
    let prior = state.take().await;
    let from_slot_kind: &'static str = match &prior {
        Slot::Empty => "empty",
        Slot::Recovering { .. } => "recovering",
        Slot::Unlocked(_) => "unlocked",
    };
    tracing::info!(
        event = "vault_locked",
        from_slot_kind,
        "vault_lock dropped slot; Zeroizing fields wipe on the prior variant's Drop"
    );
    // Explicit drop for clarity — the prior `Slot` would drop at
    // end-of-scope anyway, but naming the moment helps grep/audit
    // reviewers see "this is where the keys wipe".
    drop(prior);
    Ok(())
}

// ---- Boot-time probe + unlocked-state probe (Task 1 of `app-state-machine`) ---
//
// `vault_status` is the read-only `vault.meta` probe used by App.tsx
// at boot to choose the initial Stage (welcome vs unlock vs corrupted).
// `vault_is_unlocked` exposes a boolean view of the runtime slot
// (`true` iff the slot is `Slot::Unlocked`) to the frontend so guarded
// stages (Editor) can do a Rust-side reality check at mount time. Both
// are read-only; neither holds the auth permit, neither performs
// Argon2id. The richer three-state view (`Empty | Recovering |
// Unlocked`) lives behind [`vault_slot_kind`] for the recovery-flow
// routing path.
//
// Design context: `agent-tooling/sessions/grill/2026-05-02-app-state-machine.md`
// Q9 (vault_status imzası) + PRD `agent-tooling/features/app-state-machine/prd.md`.

/// Result of [`vault_status`] — boot-time probe of `vault.meta`.
///
/// Three-state minimal enum (Q9 α=1 + β=i):
/// - `Exists`: `vault.meta` parses cleanly via [`protocol::parse_vault_meta`].
///   Frontend routes to the unlock stage.
/// - `Missing`: file does not exist (`std::io::ErrorKind::NotFound` on
///   read). Frontend routes to the welcome stage.
/// - `Corrupted`: the file exists but `parse_vault_meta` rejected the
///   bytes (magic / length / kdf_id / reserved-byte mismatch). IO
///   failures do **NOT** surface as `Corrupted` — they surface via
///   [`VaultStatusError::IoError`] (β=i: IO failure ≠ corruption; the
///   distinction matters for log triage, even though the frontend
///   fail-closed UI branches the same way).
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind")]
pub enum VaultStatus {
    Exists,
    Missing,
    Corrupted,
}

/// Probe `<app_data_dir>/vault/vault.meta` and classify it.
///
/// Read-only: does not hold the unlock permit, does not call into
/// Argon2id, does not populate or peek [`VaultRuntimeState`]. Safe to
/// invoke at boot before any unlock attempt.
///
/// Internal sequence (mirrors [`unlock_with_path`]'s read-and-parse
/// pipeline shape):
/// 1. Resolve `vault.meta` path. Path-resolution failures map to
///    `VaultStatusError::IoError { Other }`.
/// 2. `tokio::task::spawn_blocking` reads + parses (filesystem +
///    `parse_vault_meta` are both blocking work):
///    - Read `NotFound` → `Ok(VaultStatus::Missing)` (canonical
///      no-vault case; not an IO error).
///    - Read other `io::Error` → `Err(VaultStatusError::IoError)` with
///      bounded [`IoFailureKind`].
///    - `parse_vault_meta` Ok → `Ok(VaultStatus::Exists)`.
///    - `parse_vault_meta` Err → `Ok(VaultStatus::Corrupted)`.
/// 3. `JoinFailure` from the spawn_blocking handle → fold into
///    `IoError { Other }` (no separate variant — the boundary contract
///    only surfaces IO-class failures).
#[tauri::command]
pub async fn vault_status<R: Runtime>(app: AppHandle<R>) -> Result<VaultStatus, VaultStatusError> {
    let vault_path = vault_meta_path(&app).map_err(|_| VaultStatusError::IoError {
        io_error_kind: IoFailureKind::Other,
    })?;
    vault_status_with_path(&vault_path).await
}

/// Testable core of [`vault_status`]. The Tauri-command wrapper
/// resolves the platform-specific `vault.meta` path and delegates here
/// so tests do not need an [`AppHandle`].
///
/// All decisions documented on [`vault_status`] apply identically.
pub(crate) async fn vault_status_with_path(
    vault_path: &Path,
) -> Result<VaultStatus, VaultStatusError> {
    let vault_path = vault_path.to_path_buf();

    let join_outcome =
        tokio::task::spawn_blocking(move || -> Result<VaultStatus, VaultStatusError> {
            let bytes = match std::fs::read(&vault_path) {
                Ok(b) => b,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    // Canonical no-vault case — frontend routes to
                    // welcome (create flow). Not an IO error; do not
                    // log (this is the expected first-run path).
                    return Ok(VaultStatus::Missing);
                }
                Err(e) => {
                    let io_kind = from_io_error_kind(e.kind());
                    tracing::error!(
                        stage = "status_check",
                        error_kind = "IoError",
                        io_failure_kind = ?io_kind,
                        "vault.meta probe read failed"
                    );
                    return Err(VaultStatusError::IoError {
                        io_error_kind: io_kind,
                    });
                }
            };
            match protocol::parse_vault_meta(&bytes) {
                Ok(_) => Ok(VaultStatus::Exists),
                Err(e) => {
                    tracing::error!(
                        stage = "status_check",
                        result = "Corrupted",
                        protocol_error_kind = protocol_error_kind(&e),
                        "vault.meta probe rejected by parse_vault_meta"
                    );
                    Ok(VaultStatus::Corrupted)
                }
            }
        })
        .await;

    match join_outcome {
        Ok(inner) => inner,
        Err(_) => {
            tracing::error!(
                stage = "status_check",
                error_kind = "JoinFailure",
                "blocking task join failed during vault_status"
            );
            Err(VaultStatusError::IoError {
                io_error_kind: IoFailureKind::Other,
            })
        }
    }
}

/// Read-only probe of [`VaultRuntimeState`]'s slot.
///
/// Returns `true` when the slot is populated (an [`UnlockedVault`] is
/// present), `false` otherwise. Used by the frontend's Editor mount
/// guard (Q5β-1 belt+suspenders): when Stage = `editor` mounts but the
/// slot is empty, the React state ↔ Rust state disagreement is
/// detected here and the component renders `<FailClosedError reason="invalid-state" />`.
///
/// Cheap: a single read-lock peek; no IO, no Argon2id, no permit.
/// Idempotent: callable from any stage at any time without side effects.
///
/// Error type is [`VaultStatusError`] for type-mirror consistency with
/// [`vault_status`] — in practice this command cannot fail (the
/// [`tokio::sync::RwLock`] read is infallible). The `Result` shape is
/// retained so the Tauri IPC contract for the two probe commands is
/// uniform on the frontend side.
#[tauri::command]
pub async fn vault_is_unlocked(
    state: State<'_, VaultRuntimeState>,
) -> Result<bool, VaultStatusError> {
    vault_is_unlocked_with_state(state.inner()).await
}

/// Testable core of [`vault_is_unlocked`]. The Tauri-command wrapper
/// resolves the [`State`] borrow and delegates here so tests do not
/// need a [`AppHandle`].
///
/// Returns `true` only when the slot is [`Slot::Unlocked`]. A slot in
/// [`Slot::Recovering`] (post-A8d, pre-A8f) returns `false` — the
/// Editor mount guard requires the fully-Unlocked variant; the
/// recovery flow routes through [`vault_slot_kind`] to distinguish
/// the intermediate state.
pub(crate) async fn vault_is_unlocked_with_state(
    state: &VaultRuntimeState,
) -> Result<bool, VaultStatusError> {
    Ok(matches!(state.slot_kind().await, SlotKind::Unlocked))
}

/// Record user activity for the auto-lock-on-idle timer (MYND-121).
///
/// The frontend's debounced activity heartbeat (mousemove / keydown /
/// focus / visibilitychange — task 11) invokes this. It is a single
/// lock-free atomic store on [`VaultRuntimeState`]; it never touches the
/// slot `RwLock`, so it cannot serialise against note-save / unlock / lock
/// ops even at heartbeat frequency (`decisions.md` 2026-05-30). Sync +
/// infallible by construction — there is no failure mode to surface, and
/// no secret material is read or logged.
#[tauri::command]
pub fn report_user_activity(state: State<'_, VaultRuntimeState>) {
    state.report_activity();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::vault_creation::commands::{build_and_serialize_vault_meta, build_session};
    use crate::test_support::{ScratchVault, FAST_TEST_KDF};

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    fn scratch_vault() -> ScratchVault {
        ScratchVault::new("unlock_test")
    }

    /// Seed a real `vault.meta` via `vault_creation::build_session`
    /// plus `build_and_serialize_vault_meta`. Returns the bytes and
    /// the original session-side `root_key` for post-unlock assertions.
    fn seed_vault_meta(password: &str) -> ([u8; protocol::VAULT_META_LEN], [u8; AEAD_KEY_LEN]) {
        let session = build_session(password, FAST_TEST_KDF).expect("build_session");
        let original_root_key: [u8; AEAD_KEY_LEN] = *session.root_key;
        let bytes = build_and_serialize_vault_meta(&session).expect("serialize vault.meta");
        (bytes, original_root_key)
    }

    /// `Slot::Unlocked.vault_meta_bytes_hash` must equal SHA-256 of
    /// the on-disk vault.meta bytes after a successful unlock — the
    /// CAS anchor for `vault_change_password`'s in-place rewrite. See
    /// `decisions.md` 2026-05-06 entry "Slot::Unlocked anchor field
    /// for vault.meta CAS".
    #[test]
    fn unlock_populates_slot_meta_bytes_hash() {
        rt().block_on(async {
            let scratch = scratch_vault();
            let (meta_bytes, _) = seed_vault_meta("correct horse battery staple");
            scratch.write_meta(&meta_bytes);

            let state = VaultRuntimeState::default();
            unlock_with_path(
                "correct horse battery staple".to_string(),
                scratch.path(),
                &state,
            )
            .await
            .expect("unlock with correct password");

            let unlocked = state.take().await.unwrap_unlocked();
            let expected_hash = crate::vault_meta_hash::vault_meta_sha256(meta_bytes.as_slice());
            assert_eq!(
                unlocked.vault_meta_bytes_hash, expected_hash,
                "slot.vault_meta_bytes_hash must equal SHA-256 of the on-disk vault.meta bytes"
            );
            // Sentinel sanity: the populator-written hash is NOT the
            // fixture sentinel `[0xFF; 32]`.
            assert_ne!(
                unlocked.vault_meta_bytes_hash, [0xFF; 32],
                "populator hash should not collide with fixture sentinel",
            );
        });
    }

    /// MYND-160 Task 10 integration: after `unlock_with_path` succeeds,
    /// a subsequent `prefs::commands::prefs_read_with_dir` against the
    /// same vault directory returns the persisted `screen_capture_protection`
    /// value (toggled-off in this test). Pins the end-to-end disk →
    /// pipeline → slot → prefs-read path that the Tauri-wrapper
    /// `apply_persisted_prefs` calls in production. The native
    /// `screen_capture::apply` side-effect is not asserted here (no
    /// `WebviewWindow` in the test harness — its observability is
    /// covered by `screen_capture::tests::*` for the closed-enum
    /// helper and by the production logging events).
    ///
    /// Verifies user story 4 (after unlock, the "off" preference takes
    /// effect — the toggle value flows from disk to the screen_capture
    /// runtime).
    #[test]
    fn unlock_followed_by_prefs_read_returns_persisted_toggle() {
        rt().block_on(async {
            let scratch = scratch_vault();
            let (meta_bytes, original_root_key) = seed_vault_meta("correct horse battery staple");
            scratch.write_meta(&meta_bytes);

            // Seed vault.prefs encrypted under the SAME root_key the
            // unlock will recover, with the account_number_hash bound
            // into the AAD from the seeded vault.meta.
            let parsed_meta = protocol::parse_vault_meta(&meta_bytes).expect("parse meta");
            let prefs_key =
                protocol::derive_subkey(&original_root_key, protocol::SubkeyRole::PrefsKey);
            let prefs_blob = protocol::encode_prefs_blob(
                &prefs_key,
                &parsed_meta.account_number_hash,
                &protocol::PrefsView {
                    screen_capture_protection: false,
                    folder_icons: Default::default(),
                    item_colors: Default::default(),
                    theme: None,
                    deliberate_folders: Vec::new(),
                    auto_lock_seconds: None,
                    daily_date_format: None,
                    daily_folder: None,
                    daily_template: None,
                    favorites: Vec::new(),
                    item_order: Vec::new(),
                    editor_layout: None,
                },
            )
            .expect("encode prefs blob");
            std::fs::write(scratch.dir.join("vault.prefs"), &prefs_blob).expect("seed vault.prefs");

            let state = VaultRuntimeState::default();
            unlock_with_path(
                "correct horse battery staple".to_string(),
                scratch.path(),
                &state,
            )
            .await
            .expect("unlock with correct password");

            // Slot is now Unlocked; prefs_read_with_dir uses the same
            // slot-peek + AAD-bind path the Tauri-wrapper
            // `apply_persisted_prefs` takes.
            let prefs_view =
                crate::plugins::prefs::commands::prefs_read_with_dir(&scratch.dir, &state)
                    .await
                    .expect("prefs_read after unlock");
            assert!(
                !prefs_view.screen_capture_protection,
                "persisted toggle (false) must round-trip through unlock → prefs_read"
            );
        });
    }

    /// MYND-160 Task 10 integration: when `vault.prefs` is absent
    /// (the normal case for pre-MYND-160 vaults and the first unlock
    /// before any toggle interaction), unlock STILL succeeds and a
    /// subsequent prefs_read returns `PrefsView::default()` per spec
    /// § 9.5.5 fall-back-to-defaults. Pins user stories 7 (legacy
    /// vault opens) and 4 (pre-unlock-always-ON survives — default
    /// value has screen_capture_protection: true).
    #[test]
    fn unlock_succeeds_when_vault_prefs_absent_and_read_returns_defaults() {
        rt().block_on(async {
            let scratch = scratch_vault();
            let (meta_bytes, _) = seed_vault_meta("correct horse battery staple");
            scratch.write_meta(&meta_bytes);
            // Do NOT seed vault.prefs.

            let state = VaultRuntimeState::default();
            unlock_with_path(
                "correct horse battery staple".to_string(),
                scratch.path(),
                &state,
            )
            .await
            .expect("unlock must succeed even without vault.prefs");

            let prefs_view =
                crate::plugins::prefs::commands::prefs_read_with_dir(&scratch.dir, &state)
                    .await
                    .expect("prefs_read after unlock-without-prefs");
            assert!(
                prefs_view.screen_capture_protection,
                "absent vault.prefs falls back to defaults (protection ON) per spec § 9.5.5"
            );
        });
    }

    /// MYND-160 stories 11 + 12 — change-password / recovery preserve
    /// the persisted prefs because both flows preserve `root_key`
    /// (only the password_wrap_key or recovery_wrap_key change). This
    /// test pins the structural property: a vault.prefs encrypted under
    /// `prefs_key = DeriveSubkey(root_key, PrefsKey)` decrypts
    /// identically regardless of which credential (master password,
    /// recovery phrase, or any future hardware-backed unlock) unlocks
    /// the vault — `root_key` is the single source of truth. Full E2E
    /// tests across the `vault_change_password` + `vault_recover` +
    /// `vault_complete_recovery` pipelines (~200 lines of fixture
    /// scaffolding) are deferred as over-investment because the
    /// property is mathematically guaranteed by the spec (codec
    /// depends only on root_key + account_number_hash, neither of
    /// which change across credential rotation).
    #[test]
    fn prefs_decryption_depends_only_on_root_key_not_on_credential_path() {
        // Same root_key + same account_number_hash → same prefs_key →
        // identical decrypt regardless of the credential that
        // recovered them.
        let root_key = [0x42u8; 32];
        let account_hash = [0x33u8; 16];

        let prefs_key = protocol::derive_subkey(&root_key, protocol::SubkeyRole::PrefsKey);
        let blob = protocol::encode_prefs_blob(
            &prefs_key,
            &account_hash,
            &protocol::PrefsView {
                screen_capture_protection: false,
                folder_icons: Default::default(),
                item_colors: Default::default(),
                theme: None,
                deliberate_folders: Vec::new(),
                auto_lock_seconds: None,
                daily_date_format: None,
                daily_folder: None,
                daily_template: None,
                favorites: Vec::new(),
                item_order: Vec::new(),
                editor_layout: None,
            },
        )
        .expect("encode");

        // Re-derive prefs_key from the SAME root_key (simulating any
        // credential rotation that leaves root_key intact).
        let prefs_key_after_credential_rotation =
            protocol::derive_subkey(&root_key, protocol::SubkeyRole::PrefsKey);
        let decoded =
            protocol::decode_prefs_blob(&prefs_key_after_credential_rotation, &account_hash, &blob)
                .expect("decrypt after rotation");
        assert!(
            !decoded.screen_capture_protection,
            "credential rotation must preserve persisted prefs (stories 11 + 12)"
        );
    }

    #[test]
    fn round_trip_unlock_recovers_original_root_key() {
        rt().block_on(async {
            let scratch = scratch_vault();
            let (meta_bytes, original_root_key) = seed_vault_meta("correct horse battery staple");
            scratch.write_meta(&meta_bytes);

            let state = VaultRuntimeState::default();
            unlock_with_path(
                "correct horse battery staple".to_string(),
                scratch.path(),
                &state,
            )
            .await
            .expect("unlock with correct password");

            // Slot is occupied with the original root_key bytes.
            let unlocked = state.take().await.unwrap_unlocked();
            assert_eq!(*unlocked.root_key, original_root_key);
        });
    }

    #[test]
    fn wrong_password_returns_invalid_credential_or_vault() {
        rt().block_on(async {
            let scratch = scratch_vault();
            let (meta_bytes, _) = seed_vault_meta("the right password");
            scratch.write_meta(&meta_bytes);

            let state = VaultRuntimeState::default();
            let result =
                unlock_with_path("the wrong password".to_string(), scratch.path(), &state).await;

            assert!(matches!(
                result,
                Err(VaultUnlockError::InvalidCredentialOrVault)
            ));
            // Failed unlock leaves slot empty.
            assert!(state.slot_kind().await == SlotKind::Empty);
        });
    }

    #[test]
    fn missing_vault_meta_returns_vault_not_found() {
        rt().block_on(async {
            let scratch = scratch_vault();
            // Do NOT call write_meta — vault.meta is absent.
            assert!(!scratch.path().exists());

            let state = VaultRuntimeState::default();
            let result = unlock_with_path("anything".to_string(), scratch.path(), &state).await;

            assert!(matches!(result, Err(VaultUnlockError::VaultNotFound)));
            assert!(state.slot_kind().await == SlotKind::Empty);
        });
    }

    #[test]
    fn successful_unlock_populates_slot_with_unwrapped_items_key() {
        // Stronger than a non-zero check: the items_key the unlock
        // command parks in the slot must match what an independent
        // derivation from the same vault.meta + root_key produces.
        // If unlock's items_key path diverges from the protocol
        // crate's canonical primitives (wrong subkey role, wrong
        // AAD, wrong nonce field, wrong blob slice) this catches it.
        rt().block_on(async {
            let scratch = scratch_vault();
            let (meta_bytes, original_root_key) = seed_vault_meta("pw");
            scratch.write_meta(&meta_bytes);

            let parsed = protocol::parse_vault_meta(&meta_bytes).expect("parse seed");

            // Independent items_key derivation from the same root_key
            // using the same protocol primitives the unlock command
            // calls. Verifies the unlock command does not introduce
            // any spurious transformation in the items_key path.
            let items_wrap_key =
                protocol::derive_subkey(&original_root_key, protocol::SubkeyRole::ItemsKeyWrap);
            let aad = protocol::aad_vault_items_key_wrap(&parsed.items_key_id);
            let expected_items_key = protocol::aead_open_ctx(
                &items_wrap_key,
                &parsed.items_key_nonce,
                &parsed.enc_items_key,
                &aad,
            )
            .expect("independent items_key unwrap");

            let state = VaultRuntimeState::default();
            unlock_with_path("pw".to_string(), scratch.path(), &state)
                .await
                .expect("unlock");

            let unlocked = state.take().await.unwrap_unlocked();
            assert_eq!(unlocked.items_key_id, parsed.items_key_id);
            assert_eq!(
                unlocked.items_key.as_slice(),
                expected_items_key.as_slice(),
                "items_key in slot must match independent derivation"
            );
        });
    }

    #[test]
    fn items_key_tampering_returns_invalid_vault_meta_not_credential_error() {
        // Spec §9.3: enc_items_key occupies offsets 281..345 (64 B).
        // Mutating any byte invalidates the AEAD tag on the items_key
        // wrap. Because the password wrap-key has ALREADY verified by
        // the time this stage runs, the failure must NOT collapse
        // into `InvalidCredentialOrVault` — that would leak post-
        // password-verification information as if it were a
        // credential mismatch (see grilling Q4 + Task 11
        // decisions.md entry).
        rt().block_on(async {
            let scratch = scratch_vault();
            let (mut meta_bytes, _) = seed_vault_meta("pw");
            // Flip one bit in the first byte of enc_items_key.
            meta_bytes[281] ^= 0x01;
            scratch.write_meta(&meta_bytes);

            let state = VaultRuntimeState::default();
            let result = unlock_with_path("pw".to_string(), scratch.path(), &state).await;

            match result {
                Err(VaultUnlockError::InvalidVaultMeta) => {} // expected
                Err(VaultUnlockError::InvalidCredentialOrVault) => {
                    panic!(
                        "items_key tampering must NOT surface as InvalidCredentialOrVault — \
                         the password wrap-key has already verified at this stage; \
                         distinguishing items_key wrap failure does not leak credential validity"
                    );
                }
                other => panic!("expected InvalidVaultMeta, got {other:?}"),
            }

            // Slot stays empty: root_key was successfully unwrapped
            // inside spawn_blocking, then dropped on the items_key
            // failure early-return. No half-state.
            assert!(
                state.slot_kind().await == SlotKind::Empty,
                "items_key failure must leave slot empty (no half-state)"
            );
        });
    }

    // ---- Parse-error matrix (Task 4) -------------------------------
    //
    // Each test below targets one branch of `protocol::parse_vault_meta`
    // (spec §9.3). All branches must surface as `InvalidVaultMeta` —
    // the single user-facing category for structural vault.meta
    // corruption per `decisions.md` 2026-05-02 (Phase 1 unlock error
    // discipline, Task 11). None of these branches may collapse into
    // `InvalidCredentialOrVault`: they precede password derivation and
    // reveal nothing password-conditional.

    /// Run an unlock attempt against `tampered_bytes` and assert the
    /// failure mode is exactly `InvalidVaultMeta` with the slot empty.
    /// Used by the parse-error matrix tests below.
    async fn assert_invalid_vault_meta_on_bytes(tampered_bytes: &[u8]) {
        let scratch = scratch_vault();
        scratch.write_meta(tampered_bytes);

        let state = VaultRuntimeState::default();
        let result = unlock_with_path("pw".to_string(), scratch.path(), &state).await;

        match result {
            Err(VaultUnlockError::InvalidVaultMeta) => {} // expected
            Err(VaultUnlockError::InvalidCredentialOrVault) => {
                panic!(
                    "parse error must NOT surface as InvalidCredentialOrVault — \
                     it precedes password derivation and reveals no \
                     password-conditional information"
                );
            }
            other => panic!("expected InvalidVaultMeta, got {other:?}"),
        }
        assert!(
            state.slot_kind().await == SlotKind::Empty,
            "parse failure must leave slot empty"
        );
    }

    #[test]
    fn parse_fail_bad_magic_returns_invalid_vault_meta() {
        // Spec §9.3: bytes[0..4] = b"MYV1". Replace with arbitrary
        // non-magic bytes; parse_vault_meta rejects.
        rt().block_on(async {
            let (mut bytes, _) = seed_vault_meta("pw");
            bytes[0..4].copy_from_slice(b"XXXX");
            assert_invalid_vault_meta_on_bytes(&bytes).await;
        });
    }

    #[test]
    fn parse_fail_truncated_length_returns_invalid_vault_meta() {
        // Spec §9.3: vault.meta is exactly VAULT_META_LEN (345) bytes.
        // One short triggers the length check before any field is read.
        rt().block_on(async {
            let (bytes, _) = seed_vault_meta("pw");
            assert_eq!(bytes.len(), protocol::VAULT_META_LEN);
            // Slice off the trailing byte → 344 bytes.
            assert_invalid_vault_meta_on_bytes(&bytes[..protocol::VAULT_META_LEN - 1]).await;
        });
    }

    #[test]
    fn parse_fail_overlong_length_returns_invalid_vault_meta() {
        // Length-classification mirror of the truncation case: any
        // size != VAULT_META_LEN must reject. One byte too many.
        rt().block_on(async {
            let (bytes, _) = seed_vault_meta("pw");
            let mut overlong = bytes.to_vec();
            overlong.push(0u8);
            assert_invalid_vault_meta_on_bytes(&overlong).await;
        });
    }

    #[test]
    fn parse_fail_bad_protocol_version_returns_invalid_vault_meta() {
        // Spec §9.3 offset 4: protocol_version = 0x01 for v0.1.
        // Anything else is forward-incompatible-by-design (§10).
        rt().block_on(async {
            let (mut bytes, _) = seed_vault_meta("pw");
            bytes[4] = 0x02;
            assert_invalid_vault_meta_on_bytes(&bytes).await;
        });
    }

    #[test]
    fn parse_fail_nonzero_reserved_byte_returns_invalid_vault_meta() {
        // Spec §9.3 offset 5: reserved MUST be 0x00. Non-zero is a
        // forward-compat anchor for future minor revisions; v0.1
        // parsers reject non-zero by construction.
        rt().block_on(async {
            let (mut bytes, _) = seed_vault_meta("pw");
            bytes[5] = 0x01;
            assert_invalid_vault_meta_on_bytes(&bytes).await;
        });
    }

    #[test]
    fn parse_fail_invalid_kdf_block_returns_invalid_vault_meta() {
        // Spec §9.3 offset 22: kdf_id MUST be 0x01 (Argon2id, the
        // only value accepted in v0.1). 0xFF triggers the
        // parse_kdf_params branch inside parse_vault_meta.
        rt().block_on(async {
            let (mut bytes, _) = seed_vault_meta("pw");
            bytes[22] = 0xFF;
            assert_invalid_vault_meta_on_bytes(&bytes).await;
        });
    }

    // ---- IO error matrix (Task 4) ----------------------------------

    /// Permission-denied IO test (Unix-only).
    ///
    /// Windows has no portable equivalent: `fs::set_permissions` on
    /// a regular file is largely a no-op for permissions-blocking
    /// purposes there, and the test would not reliably trigger
    /// `ErrorKind::PermissionDenied`. The non-Unix coverage of
    /// `IoError` mapping is exercised by the From-impl unit test in
    /// `error.rs::tests::from_io_error_maps_via_closed_enum`, which
    /// synthesizes a permission-denied `io::Error` directly.
    ///
    /// Skipped automatically when running as root (mode-000 does not
    /// block reads for the superuser); CI runs unprivileged.
    #[cfg(unix)]
    #[test]
    fn permission_denied_returns_io_error_with_permission_denied_kind() {
        use std::os::unix::fs::PermissionsExt;

        rt().block_on(async {
            let scratch = scratch_vault();
            let (bytes, _) = seed_vault_meta("pw");
            scratch.write_meta(&bytes);

            // Strip all permissions on the file itself. Parent
            // directory keeps its w+x bits so `remove_dir_all` can
            // unlink the file at cleanup time without needing read.
            let mut perms = std::fs::metadata(scratch.path())
                .expect("stat scratch file")
                .permissions();
            perms.set_mode(0o000);
            std::fs::set_permissions(scratch.path(), perms).expect("chmod 000");

            let state = VaultRuntimeState::default();
            let result = unlock_with_path("pw".to_string(), scratch.path(), &state).await;

            // Restore readability for cleanup BEFORE asserting (so a
            // panicking assert still leaves the dir cleanable).
            let mut perms = std::fs::metadata(scratch.path())
                .expect("stat after unlock")
                .permissions();
            perms.set_mode(0o644);
            std::fs::set_permissions(scratch.path(), perms).expect("chmod 644 cleanup");

            match result {
                Err(VaultUnlockError::IoError {
                    io_error_kind: IoFailureKind::PermissionDenied,
                }) => {} // expected
                // Running as root or on a filesystem that ignores
                // mode bits (e.g. some FUSE mounts) — the read
                // succeeded so we got a `VaultUnlockError::Invalid…`
                // instead. Tolerate: the permission-denied branch
                // is also covered by the `error.rs` From-impl test.
                Ok(()) => eprintln!(
                    "permission_denied test ran with effective read access; \
                     skipping assertion (CI must run unprivileged)"
                ),
                other => panic!("expected IoError(PermissionDenied), got {other:?}"),
            }
            assert!(
                state.slot_kind().await == SlotKind::Empty,
                "IO failure must leave slot empty"
            );
        });
    }

    // ---- Concurrency guards (Task 5) -------------------------------
    //
    // VaultAlreadyUnlocked + UnlockInProgress are the two structural
    // guards on the `unlock_with_path` critical section. Order is
    // load-bearing: slot peek precedes permit acquire (grilling Q5)
    // so the cheap "already unlocked" path is fast-path observable
    // and never consumes a permit.

    use super::super::state::{fixture_recovering_with_keys, fixture_unlocked_with_keys};

    #[test]
    fn vault_already_unlocked_returns_guard_when_slot_occupied() {
        rt().block_on(async {
            let scratch = scratch_vault();
            let (bytes, _) = seed_vault_meta("pw");
            scratch.write_meta(&bytes);

            let state = VaultRuntimeState::default();
            // Simulate "already unlocked" by populating the slot
            // directly with a fixture distinguishable by byte pattern
            // (so we can assert the existing slot is unchanged).
            state
                .set_unlocked(fixture_unlocked_with_keys(0x42, 0x13, 0x99))
                .await;

            let result = unlock_with_path("pw".to_string(), scratch.path(), &state).await;

            assert!(matches!(
                result,
                Err(VaultUnlockError::VaultAlreadyUnlocked)
            ));

            // Existing slot is untouched: the same fixture bytes
            // come back from take(). The unlock attempt did NOT
            // overwrite or perturb it.
            let existing = state.take().await.unwrap_unlocked();
            assert_eq!(*existing.root_key, [0x42u8; AEAD_KEY_LEN]);
            assert_eq!(*existing.items_key, [0x13u8; AEAD_KEY_LEN]);
            assert_eq!(existing.items_key_id, [0x99u8; 16]);
        });
    }

    #[test]
    fn vault_already_unlocked_does_not_consume_permit() {
        // Tests the load-bearing ordering invariant: slot peek
        // precedes permit acquire. The fast-path return of
        // VaultAlreadyUnlocked must not touch the semaphore — even
        // when the permit is exhausted, the guard fires correctly
        // because we never reach try_acquire.
        rt().block_on(async {
            let scratch = scratch_vault();
            let (bytes, _) = seed_vault_meta("pw");
            scratch.write_meta(&bytes);

            let state = VaultRuntimeState::default();
            state
                .set_unlocked(fixture_unlocked_with_keys(0x55, 0x66, 0x77))
                .await;

            // Manually hold the unlock permit. If unlock_with_path
            // tried try_acquire BEFORE peek, this would surface as
            // UnlockInProgress instead of VaultAlreadyUnlocked.
            let _held_permit = state
                .auth_permits()
                .try_acquire()
                .expect("first acquire on fresh state");
            assert_eq!(state.auth_permits().available_permits(), 0);

            let result = unlock_with_path("pw".to_string(), scratch.path(), &state).await;

            // Peek catches it before try_acquire runs.
            assert!(matches!(
                result,
                Err(VaultUnlockError::VaultAlreadyUnlocked)
            ));
            // Permit count is still 0 — the held permit is exactly
            // one, and unlock_with_path did NOT consume an additional
            // one (which would've been impossible anyway, but the
            // test asserts the early-return path was taken).
            assert_eq!(state.auth_permits().available_permits(), 0);
        });
    }

    #[test]
    fn vault_recovery_in_progress_returns_guard_when_slot_is_recovering() {
        // Slot is `Slot::Recovering` — A8d succeeded but A8f has not
        // committed yet. `vault_unlock` MUST reject with the new
        // `VaultRecoveryInProgress` guard variant rather than
        // `VaultAlreadyUnlocked` (which would route the user to editor)
        // — the type-system realization of `recovery-flow.md` §4.1's
        // "non-dismissible mandatory chained step" rule.
        rt().block_on(async {
            let scratch = scratch_vault();
            let (bytes, _) = seed_vault_meta("pw");
            scratch.write_meta(&bytes);

            let state = VaultRuntimeState::default();
            // Populate slot directly with a Recovering fixture using a
            // distinguishable byte pattern so we can prove the existing
            // recovering material is NOT perturbed by the rejected
            // unlock attempt.
            state
                .set_recovering(fixture_recovering_with_keys(0xAA, 0xBB, 0xCC))
                .await;

            let result = unlock_with_path("pw".to_string(), scratch.path(), &state).await;

            assert!(matches!(
                result,
                Err(VaultUnlockError::VaultRecoveryInProgress)
            ));

            // Existing slot is untouched — slot_kind still Recovering.
            assert_eq!(state.slot_kind().await, SlotKind::Recovering);
        });
    }

    #[test]
    fn vault_recovery_in_progress_does_not_consume_permit() {
        // Mirrors the load-bearing ordering invariant tested for
        // `VaultAlreadyUnlocked`: slot peek precedes permit acquire,
        // so the fast-path `Recovering` rejection does not touch the
        // semaphore even when the permit is exhausted.
        rt().block_on(async {
            let scratch = scratch_vault();
            let (bytes, _) = seed_vault_meta("pw");
            scratch.write_meta(&bytes);

            let state = VaultRuntimeState::default();
            state
                .set_recovering(fixture_recovering_with_keys(0x55, 0x66, 0x77))
                .await;

            // Manually hold the auth permit. If unlock_with_path tried
            // try_acquire BEFORE peek, this would surface as
            // UnlockInProgress instead of VaultRecoveryInProgress.
            let _held_permit = state
                .auth_permits()
                .try_acquire()
                .expect("first acquire on fresh state");
            assert_eq!(state.auth_permits().available_permits(), 0);

            let result = unlock_with_path("pw".to_string(), scratch.path(), &state).await;

            // Peek catches it before try_acquire runs.
            assert!(matches!(
                result,
                Err(VaultUnlockError::VaultRecoveryInProgress)
            ));
            assert_eq!(state.auth_permits().available_permits(), 0);
        });
    }

    #[test]
    fn unlock_in_progress_returns_guard_when_permit_held() {
        // Deterministic substitute for "two concurrent unlocks": the
        // test holds the permit manually, simulating an in-flight
        // unlock at any of its post-acquire stages. A concurrent
        // unlock attempt must reject with UnlockInProgress without
        // queueing or sleeping. No tokio::time::sleep, no race —
        // pure structural verification of try_acquire's reject path.
        rt().block_on(async {
            let scratch = scratch_vault();
            let (bytes, _) = seed_vault_meta("pw");
            scratch.write_meta(&bytes);

            let state = VaultRuntimeState::default();
            assert!(state.slot_kind().await == SlotKind::Empty);

            // Simulate "in-flight unlock" by holding the permit.
            let held_permit = state
                .auth_permits()
                .try_acquire()
                .expect("first acquire on fresh state");
            assert_eq!(state.auth_permits().available_permits(), 0);

            // While held, a fresh unlock attempt rejects cleanly.
            let result = unlock_with_path("pw".to_string(), scratch.path(), &state).await;
            assert!(matches!(result, Err(VaultUnlockError::UnlockInProgress)));
            // The slot stayed empty — no half-state.
            assert!(state.slot_kind().await == SlotKind::Empty);

            // Release the held permit; subsequent unlock succeeds
            // (proving the guard is purely structural, not stateful
            // beyond permit availability).
            drop(held_permit);
            assert_eq!(state.auth_permits().available_permits(), 1);

            unlock_with_path("pw".to_string(), scratch.path(), &state)
                .await
                .expect("retry after permit released succeeds");

            // Permit released after successful unlock too.
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }

    #[test]
    fn failed_unlock_releases_permit_for_retry() {
        // Regression guard for the RAII drop semantics: a failed
        // unlock (any error path that consumed the permit) must
        // release the permit when the function returns, so the next
        // attempt is not stuck on UnlockInProgress.
        rt().block_on(async {
            let scratch = scratch_vault();
            let (bytes, _) = seed_vault_meta("right pw");
            scratch.write_meta(&bytes);

            let state = VaultRuntimeState::default();

            // Wrong-password attempt: consumes permit (try_acquire
            // succeeds) → Argon2id runs → AEAD-open fails →
            // InvalidCredentialOrVault → permit released by RAII
            // drop on function return.
            let r1 = unlock_with_path("wrong pw".to_string(), scratch.path(), &state).await;
            assert!(matches!(
                r1,
                Err(VaultUnlockError::InvalidCredentialOrVault)
            ));
            assert_eq!(
                state.auth_permits().available_permits(),
                1,
                "permit must be released after failed unlock — not stuck on UnlockInProgress"
            );

            // Retry with the right password — must succeed (would
            // hit UnlockInProgress if the permit had leaked).
            unlock_with_path("right pw".to_string(), scratch.path(), &state)
                .await
                .expect("retry after wrong-password failure works");

            // Permit released after successful unlock too.
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }

    // ---- vault_lock command (Task 6 — A8e bundle) -------------------
    //
    // `lock_with_state` is the testable inner of the `lock` Tauri
    // command. Param-less, idempotent, returns `Ok(())` on every
    // path — locked → no-op; unlocked → drop slot.

    // Note: "lock on already-locked is no-op" is covered by the
    // `lock_is_idempotent_across_repeated_calls` test below — its
    // first iteration starts with the slot already empty after the
    // initial drop.

    #[test]
    fn lock_when_unlocked_drops_slot() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            // Populate the slot directly with a fixture.
            state
                .set_unlocked(fixture_unlocked_with_keys(0x77, 0x88, 0x99))
                .await;
            assert!(state.slot_kind().await == SlotKind::Unlocked);

            lock_with_state(&state)
                .await
                .expect("lock on populated slot returns Ok");

            assert!(
                state.slot_kind().await == SlotKind::Empty,
                "lock must drop the slot — Zeroizing fields wipe on the taken UnlockedVault's drop"
            );
        });
    }

    // ---- vault_slot_kind -----------------------------------------------
    //
    // Read-only SlotKind probe. Thin wrapper over `state.slot_kind()`;
    // serde shape is verified by
    // `state::tests::slot_kind_serializes_as_bare_variant_name`.

    /// Unwrap `Result<SlotKind, VaultUnlockError>` to `SlotKind` for
    /// test assertions. `VaultUnlockError` does not derive
    /// `PartialEq` (closed-payload variants carrying `IoFailureKind`
    /// would force a manual impl that adds churn for no test wins),
    /// so we cannot use `assert_eq!(result, Ok(...))` directly.
    fn unwrap_slot_kind(r: Result<SlotKind, VaultUnlockError>) -> SlotKind {
        r.expect("vault_slot_kind_inner is structurally infallible")
    }

    #[test]
    fn vault_slot_kind_returns_empty_on_fresh_state() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            assert_eq!(
                unwrap_slot_kind(vault_slot_kind_inner(&state).await),
                SlotKind::Empty
            );
        });
    }

    #[test]
    fn vault_slot_kind_returns_recovering_after_set_recovering() {
        rt().block_on(async {
            use super::super::state::fixture_recovering_with_keys;

            let state = VaultRuntimeState::default();
            state
                .set_recovering(fixture_recovering_with_keys(0xAA, 0xBB, 0xCC))
                .await;

            assert_eq!(
                unwrap_slot_kind(vault_slot_kind_inner(&state).await),
                SlotKind::Recovering
            );

            // Read-only: state was not perturbed by the probe.
            assert_eq!(state.slot_kind().await, SlotKind::Recovering);
        });
    }

    #[test]
    fn vault_slot_kind_returns_unlocked_after_successful_unlock() {
        // End-to-end: seed vault.meta, unlock via the unlock_with_path
        // pipeline (full Argon2id at FAST_TEST_KDF), then verify
        // vault_slot_kind_inner reports Unlocked. Confirms the
        // `vault_slot_kind` surface integrates cleanly with the unlock
        // pipeline's slot population.
        rt().block_on(async {
            let scratch = scratch_vault();
            let (meta_bytes, _) = seed_vault_meta("pw");
            scratch.write_meta(&meta_bytes);

            let state = VaultRuntimeState::default();
            unlock_with_path("pw".to_string(), scratch.path(), &state)
                .await
                .expect("unlock seeded vault");

            assert_eq!(
                unwrap_slot_kind(vault_slot_kind_inner(&state).await),
                SlotKind::Unlocked
            );
        });
    }

    #[test]
    fn vault_slot_kind_after_lock_returns_empty() {
        // Cycle: populate Unlocked → probe reports Unlocked → lock
        // → probe reports Empty. Confirms `vault_slot_kind` reflects
        // the slot's transitions in real time (no caching, no stale
        // observation).
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(fixture_unlocked_with_keys(0x11, 0x22, 0x33))
                .await;
            assert_eq!(
                unwrap_slot_kind(vault_slot_kind_inner(&state).await),
                SlotKind::Unlocked
            );

            lock_with_state(&state).await.expect("lock");
            assert_eq!(
                unwrap_slot_kind(vault_slot_kind_inner(&state).await),
                SlotKind::Empty
            );
        });
    }

    #[test]
    fn lock_when_recovering_drops_slot() {
        // `lock_with_state` MUST drop a `Slot::Recovering` variant —
        // structural realization of `recovery-flow.md` § 4.3's
        // within-session bail mechanism (frontend route-guard cleanup
        // or boot-time `vault_slot_kind`-Recovering routing both call
        // this same command).
        rt().block_on(async {
            use super::super::state::fixture_recovering_with_keys;

            let state = VaultRuntimeState::default();
            state
                .set_recovering(fixture_recovering_with_keys(0xAA, 0xBB, 0xCC))
                .await;
            assert_eq!(state.slot_kind().await, SlotKind::Recovering);

            lock_with_state(&state)
                .await
                .expect("lock on Recovering slot returns Ok");

            assert_eq!(
                state.slot_kind().await,
                SlotKind::Empty,
                "lock must drop the Recovering slot — Zeroizing fields wipe on the taken material's drop"
            );
        });
    }

    #[test]
    fn lock_when_empty_is_no_op() {
        // Idempotent on Empty: lock returns Ok(()) without state
        // change. The `from_slot_kind = "empty"` tracing tag covers
        // the audit need without surfacing a user-facing error.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            assert_eq!(state.slot_kind().await, SlotKind::Empty);

            lock_with_state(&state)
                .await
                .expect("lock on Empty slot returns Ok (idempotent)");

            assert_eq!(state.slot_kind().await, SlotKind::Empty);
        });
    }

    #[test]
    fn lock_is_idempotent_across_repeated_calls() {
        // Idempotency property: 10 consecutive lock calls produce the
        // same final state (slot empty) regardless of the starting
        // variant — Unlocked, Recovering, or already Empty.
        rt().block_on(async {
            use super::super::state::fixture_recovering_with_keys;

            // (a) Starting from Unlocked.
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(fixture_unlocked_with_keys(0x01, 0x02, 0x03))
                .await;
            for i in 0..10 {
                lock_with_state(&state)
                    .await
                    .unwrap_or_else(|_| panic!("lock #{i} from Unlocked must succeed"));
                assert_eq!(
                    state.slot_kind().await,
                    SlotKind::Empty,
                    "slot must be Empty after lock #{i} (from Unlocked)"
                );
            }

            // (b) Starting from Recovering.
            let state = VaultRuntimeState::default();
            state
                .set_recovering(fixture_recovering_with_keys(0x10, 0x20, 0x30))
                .await;
            for i in 0..10 {
                lock_with_state(&state)
                    .await
                    .unwrap_or_else(|_| panic!("lock #{i} from Recovering must succeed"));
                assert_eq!(
                    state.slot_kind().await,
                    SlotKind::Empty,
                    "slot must be Empty after lock #{i} (from Recovering)"
                );
            }

            // (c) Starting from Empty.
            let state = VaultRuntimeState::default();
            for i in 0..10 {
                lock_with_state(&state)
                    .await
                    .unwrap_or_else(|_| panic!("lock #{i} from Empty must succeed"));
                assert_eq!(
                    state.slot_kind().await,
                    SlotKind::Empty,
                    "slot must be Empty after lock #{i} (from Empty)"
                );
            }
        });
    }

    #[test]
    fn lock_then_unlock_cycle_produces_fresh_unlocked_state() {
        // The lock-then-unlock cycle must NOT carry stale state
        // from the prior session into the new one. After lock, the
        // slot is empty; after a subsequent real unlock, the slot
        // is populated with the freshly-derived root_key from
        // vault.meta — distinct from any pre-existing fixture
        // bytes.
        rt().block_on(async {
            let scratch = scratch_vault();
            let (bytes, original_root_key) = seed_vault_meta("pw");
            scratch.write_meta(&bytes);

            let state = VaultRuntimeState::default();
            // Pre-existing "previous session" — distinguishable
            // bytes (0x11) so we can prove the next unlock
            // overwrites them with the real derived root_key.
            state
                .set_unlocked(fixture_unlocked_with_keys(0x11, 0x12, 0x13))
                .await;

            // Lock — drops the fixture; slot empties.
            lock_with_state(&state).await.expect("lock");
            assert!(state.slot_kind().await == SlotKind::Empty);

            // Real unlock from the seeded vault.meta. Pays the
            // full Argon2id (FAST_TEST_KDF) + AEAD-open pipeline.
            unlock_with_path("pw".to_string(), scratch.path(), &state)
                .await
                .expect("unlock after lock succeeds");

            // The slot now carries the FRESH root_key from
            // vault.meta, NOT the prior fixture's 0x11 bytes.
            let unlocked = state.take().await.unwrap_unlocked();
            assert_eq!(*unlocked.root_key, original_root_key);
            assert_ne!(
                *unlocked.root_key, [0x11u8; AEAD_KEY_LEN],
                "fresh unlock must overwrite the prior session's root_key"
            );
        });
    }

    // ---- vault_status command (Task 1 of `app-state-machine`) -------
    //
    // Three-state probe: Exists | Missing | Corrupted, plus IO failure
    // surface as `Err(VaultStatusError::IoError)`. Mirrors the existing
    // `parse_fail_*` matrix on the unlock command but at the read +
    // parse layer only — no Argon2id, no slot interaction.

    #[test]
    fn vault_status_returns_missing_when_vault_meta_absent() {
        // First-run UX path: file does not exist → Ok(Missing).
        // NotFound is special-cased; not surfaced as IoError.
        rt().block_on(async {
            let scratch = ScratchVault::new("vault_status_missing");
            assert!(!scratch.path().exists());

            let result = vault_status_with_path(scratch.path()).await;
            assert_eq!(result, Ok(VaultStatus::Missing));
        });
    }

    #[test]
    fn vault_status_returns_exists_for_valid_vault_meta() {
        // Round-trip: a vault.meta freshly produced by
        // `build_and_serialize_vault_meta` parses cleanly, so the
        // probe classifies it as Exists.
        rt().block_on(async {
            let scratch = ScratchVault::new("vault_status_exists");
            let (bytes, _) = seed_vault_meta("pw");
            scratch.write_meta(&bytes);

            let result = vault_status_with_path(scratch.path()).await;
            assert_eq!(result, Ok(VaultStatus::Exists));
        });
    }

    /// Run the probe against `tampered_bytes` and assert it surfaces
    /// as `Ok(VaultStatus::Corrupted)` — the canonical "file present
    /// but unparsable" classification. IO failure must NOT collapse
    /// into Corrupted; that path is exercised by
    /// `vault_status_returns_io_error_on_permission_denied` below.
    async fn assert_corrupted_on_bytes(tampered_bytes: &[u8]) {
        let scratch = ScratchVault::new("vault_status_corrupted");
        scratch.write_meta(tampered_bytes);

        let result = vault_status_with_path(scratch.path()).await;
        assert_eq!(
            result,
            Ok(VaultStatus::Corrupted),
            "tampered vault.meta must surface as Corrupted, got {result:?}"
        );
    }

    #[test]
    fn vault_status_corrupted_on_bad_magic() {
        // Spec §9.3: bytes[0..4] = b"MYV1". Replace with arbitrary
        // non-magic bytes; parse_vault_meta rejects.
        rt().block_on(async {
            let (mut bytes, _) = seed_vault_meta("pw");
            bytes[0..4].copy_from_slice(b"XXXX");
            assert_corrupted_on_bytes(&bytes).await;
        });
    }

    #[test]
    fn vault_status_corrupted_on_truncated_length() {
        // Spec §9.3: vault.meta is exactly VAULT_META_LEN (345) bytes.
        // One short triggers the length check before any field is read.
        rt().block_on(async {
            let (bytes, _) = seed_vault_meta("pw");
            assert_eq!(bytes.len(), protocol::VAULT_META_LEN);
            assert_corrupted_on_bytes(&bytes[..protocol::VAULT_META_LEN - 1]).await;
        });
    }

    #[test]
    fn vault_status_corrupted_on_overlong_length() {
        // Length-classification mirror of truncation: any size !=
        // VAULT_META_LEN must reject. One byte too many.
        rt().block_on(async {
            let (bytes, _) = seed_vault_meta("pw");
            let mut overlong = bytes.to_vec();
            overlong.push(0u8);
            assert_corrupted_on_bytes(&overlong).await;
        });
    }

    #[test]
    fn vault_status_corrupted_on_bad_protocol_version() {
        // Spec §9.3 offset 4: protocol_version = 0x01 for v0.1.
        // Anything else is forward-incompatible-by-design (§10).
        rt().block_on(async {
            let (mut bytes, _) = seed_vault_meta("pw");
            bytes[4] = 0x02;
            assert_corrupted_on_bytes(&bytes).await;
        });
    }

    #[test]
    fn vault_status_corrupted_on_nonzero_reserved_byte() {
        // Spec §9.3 offset 5: reserved MUST be 0x00. v0.1 parsers
        // reject non-zero by construction (forward-compat anchor).
        rt().block_on(async {
            let (mut bytes, _) = seed_vault_meta("pw");
            bytes[5] = 0x01;
            assert_corrupted_on_bytes(&bytes).await;
        });
    }

    #[test]
    fn vault_status_corrupted_on_invalid_kdf_block() {
        // Spec §9.3 offset 22: kdf_id MUST be 0x01 (Argon2id, the
        // only value accepted in v0.1). 0xFF triggers the
        // parse_kdf_params branch inside parse_vault_meta.
        rt().block_on(async {
            let (mut bytes, _) = seed_vault_meta("pw");
            bytes[22] = 0xFF;
            assert_corrupted_on_bytes(&bytes).await;
        });
    }

    /// Permission-denied IO test (Unix-only).
    ///
    /// Mirrors the unlock command's `permission_denied_returns_io_error_with_permission_denied_kind`
    /// test. Skipped automatically when running as root (mode-000 does
    /// not block reads for the superuser); CI runs unprivileged.
    #[cfg(unix)]
    #[test]
    fn vault_status_returns_io_error_on_permission_denied() {
        use std::os::unix::fs::PermissionsExt;

        rt().block_on(async {
            let scratch = ScratchVault::new("vault_status_perm_denied");
            let (bytes, _) = seed_vault_meta("pw");
            scratch.write_meta(&bytes);

            let mut perms = std::fs::metadata(scratch.path())
                .expect("stat scratch file")
                .permissions();
            perms.set_mode(0o000);
            std::fs::set_permissions(scratch.path(), perms).expect("chmod 000");

            let result = vault_status_with_path(scratch.path()).await;

            // Restore readability for cleanup BEFORE asserting (so a
            // panicking assert still leaves the dir cleanable).
            let mut perms = std::fs::metadata(scratch.path())
                .expect("stat after probe")
                .permissions();
            perms.set_mode(0o644);
            std::fs::set_permissions(scratch.path(), perms).expect("chmod 644 cleanup");

            match result {
                Err(VaultStatusError::IoError {
                    io_error_kind: IoFailureKind::PermissionDenied,
                }) => {} // expected
                Ok(VaultStatus::Exists) => eprintln!(
                    "permission_denied test ran with effective read access; \
                     skipping assertion (CI must run unprivileged)"
                ),
                other => panic!("expected IoError(PermissionDenied), got {other:?}"),
            }
        });
    }

    // ---- vault_is_unlocked command (Task 1 of `app-state-machine`) --
    //
    // Read-only peek of VaultRuntimeState's slot. Used by Editor mount
    // guard (Q5β-1 belt+suspenders).

    use super::super::state::fixture_unlocked_with_keys as status_fixture_unlocked_with_keys;

    #[test]
    fn vault_is_unlocked_returns_false_on_fresh_state() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let result = vault_is_unlocked_with_state(&state).await;
            assert_eq!(result, Ok(false));
        });
    }

    #[test]
    fn vault_is_unlocked_returns_true_when_slot_populated() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(status_fixture_unlocked_with_keys(0x42, 0x13, 0x99))
                .await;
            let result = vault_is_unlocked_with_state(&state).await;
            assert_eq!(result, Ok(true));
        });
    }

    #[test]
    fn vault_is_unlocked_returns_false_after_take() {
        // Lock cycle parity: after the slot is drained (vault_lock
        // semantics), the probe must immediately surface false.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(status_fixture_unlocked_with_keys(0x77, 0x88, 0x99))
                .await;
            assert_eq!(vault_is_unlocked_with_state(&state).await, Ok(true));

            let _ = state.take().await; // simulate vault_lock
            assert_eq!(vault_is_unlocked_with_state(&state).await, Ok(false));
        });
    }
}
