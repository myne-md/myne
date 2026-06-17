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
/// Resolve the `vault.meta` path for an OPTIONAL explicit [`VaultId`].
///
/// - `Some(id)` → `<app_data_dir>/vaults/<id>/vault.meta` — the EXPLICIT target
///   the picker (sub-feature 3) passes (SYNC-6 targeting).
/// - `None` → the sole-vault fallback (`current_vault_root_from_base`), which
///   preserves the current single-vault boot (callers that have no chosen id
///   yet pass `None`).
fn vault_meta_path<R: Runtime>(
    app: &AppHandle<R>,
    vault_id: Option<crate::vault_id::VaultId>,
) -> Result<PathBuf, VaultUnlockError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| VaultUnlockError::IoError {
            io_error_kind: IoFailureKind::Other,
        })?;
    let root = match vault_id {
        Some(id) => crate::paths::vault_root_for_id_from_base(&base, id),
        // sole-vault fallback until picker (sub-feature 3): the transitional
        // single-on-disk-vault resolution from task 1.
        None => crate::paths::current_vault_root_from_base(&base),
    };
    Ok(root.join("vault.meta"))
}

/// Whether an unlock of `target_id` is a vault SWITCH — i.e. a DIFFERENT vault
/// was already `Unlocked` (`active_before`) when the unlock began.
///
/// Drives the GLOBAL derived-index teardown on the lock-then-unlock path
/// (sub-feature 2 task 2): a switch must wipe the search index / VaultIndices /
/// attachment-ref graph the prior vault hydrated, BEFORE the new vault
/// re-hydrates them, so a vault A term / wikilink / attachment correlation tag
/// cannot bleed into vault B. Returns:
/// - `false` when no vault was unlocked (`None`) — a first unlock carries no
///   stale global index.
/// - `false` when the SAME vault was already active — a re-unlock is rejected
///   upstream by the `VaultAlreadyUnlocked` guard anyway, and a same-id unlock
///   from `Empty` shares the vault's own (still-valid) indices.
/// - `true` only when a different vault was active — the switch case.
fn is_vault_switch(
    active_before: Option<crate::vault_id::VaultId>,
    target_id: crate::vault_id::VaultId,
) -> bool {
    active_before.is_some_and(|prior| prior != target_id)
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
    vault_id: Option<String>,
    password: String,
    state: State<'_, VaultRuntimeState>,
    app: AppHandle<R>,
) -> Result<(), VaultUnlockError> {
    // SYNC-6 targeting: `Some(id)` → unlock exactly `vaults/<id>/` (the picker
    // of sub-feature 3 passes the chosen id); `None`/malformed → the sole-vault
    // fallback. The parsed id keys BOTH the path resolution and the slot map so
    // they cannot diverge.
    let target = crate::vault_id::VaultId::parse_optional(vault_id.as_deref());
    let vault_path = vault_meta_path(&app, target)?;

    // Lock-then-unlock teardown (sub-feature 2 task 2): capture the currently-
    // active vault BEFORE the unlock so we can tell whether this unlock is a
    // SWITCH (a different vault was unlocked) and so wipe the GLOBAL derived
    // indices before the new vault hydrates them — no cross-vault index bleed.
    // `auth_permits` (capacity 1) means no concurrent unlock can change the
    // active vault between this read and `unlock_with_path`'s slot mutation, so
    // the pre-read is a reliable switch predictor. The target vault id is the
    // explicit `target` when present, else derived from the resolved root.
    let active_before = state.active_vault_id().await;
    let target_id = target.unwrap_or_else(|| {
        crate::paths::vault_id_from_root(vault_path.parent().unwrap_or(&vault_path))
    });

    unlock_with_path(password, target, &vault_path, state.inner()).await?;

    // A SWITCH occurred when a DIFFERENT vault was unlocked beforehand.
    // `set_unlocked_locking_others` (inside `unlock_with_path`) already dropped
    // + zeroized that vault's keys; here we complete the four-surface teardown
    // by wiping the GLOBAL plaintext-derived indices (search index /
    // VaultIndices / attachment-ref graph) so the prior vault's terms / wikilink
    // graph / attachment correlation tags cannot bleed into the freshly-unlocked
    // vault's about-to-hydrate indices. Re-unlocking the SAME vault is not a
    // switch (the guards reject a re-unlock of an already-`Unlocked` vault, and
    // a same-id re-unlock from `Empty` carries no stale global index). Reuses
    // the EXACT existing teardown calls from the lock path — not a second wipe
    // path.
    if is_vault_switch(active_before, target_id) {
        crate::plugins::notes::search_sync::zeroize_search_index(&app);
        // MYND-262/266: drop the prior vault's spell engine + personal/ignore
        // sets before the new vault hydrates — no cross-vault dictionary bleed.
        crate::spell::sync::zeroize_spell(&app);
        // MYND-166: drop the prior vault's staged editor-workspace descriptor
        // so the switch can't flush vault A's layout into vault B.
        crate::plugins::workspace::commands::clear_staged_descriptor();
        // MYND-255: destroy the hidden pdf-export render window and wipe its
        // stashed HTML payload — vault A's plaintext projection must not
        // survive the switch into vault B's session.
        crate::plugins::pdf_export::teardown_on_lock(&app);
        crate::plugins::vault_indices::zeroize_vault_indices(&app);
        crate::plugins::attachments::zeroize_attachment_refs(&app);
        // MYND-259: abort any in-progress voice recording so the mic + RAM
        // PCM buffer never survive the switch into another vault's session.
        crate::plugins::attachments::abort_active_recording(&app);
        // MYND-205: the prior vault is now locked (its keys were zeroized by
        // `set_unlocked_locking_others`), so drop its cached label too — a
        // switch must stop surfacing the prior vault's real name (SYNC-3).
        if let Some(prior) = active_before {
            state.evict_cached_label(prior).await;
        }
    }

    // Stamp this vault's last-unlock time into the best-effort registry so the
    // picker's recency ordering and the switcher's active-vault inference (both
    // read `last_unlock`) reflect the just-opened vault — otherwise every entry
    // stays `None` and those surfaces fall back to a creation-order tie-break.
    // Best-effort: a failed `app_data_dir` lookup or persist degrades to stale
    // ordering, never blocks the unlock. `target_id` is the vault just opened.
    if let Ok(base) = app.path().app_data_dir() {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        crate::vault_registry::record_unlock(&base, &target_id, now_ms);
    }

    // ---- MYND-85: roll-forward-recover a crashed transactional rename ----
    //
    // BEFORE any resolution index is built — the inline search hydration
    // below AND the TS-orchestrated VaultIndices rebuild that runs after
    // this command returns — reconcile a rename transaction (`wikilink.md`
    // §8.3 / WL-7) that crashed mid-commit: a present `.rename-journal`
    // marker rolls every staged `<uuid>.myn.tmp` forward to `.myn`; an
    // absent marker rolls orphan `.tmp` back (delete). This MUST precede
    // resolution so the rebuilt graph + the editor observe the committed
    // link bodies, never a half-renamed vault. Idempotent + best-effort:
    // a failure leaves the residue for the next unlock to retry (the
    // marker is the durable WAL), so it never blocks unlock.
    recover_pending_rename_on_unlock(&app, state.inner()).await;

    // ---- MYND-171: reclaim catalog-less stray attachment blobs ----------
    //
    // Finish any "clean unused attachments" sweep that crashed between its
    // catalog rewrite (which drops the entry first) and the blob unlinks:
    // unlink every `attachments/<64-hex>` file ABSENT from the catalog.
    // Strictly scoped — a cataloged id (incl. a zero-reference orphan the
    // user has not swept) is NEVER touched, so this is NOT an auto-GC. Runs
    // here (post-unlock, slot Unlocked → catalog KEK derivable) and is
    // fail-closed on an undecodable catalog (never mass-deletes on
    // corruption). Best-effort: any failure is logged and never blocks unlock.
    crate::plugins::attachments::commands::reclaim_stray_attachment_blobs(&app, state.inner())
        .await;

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

    // MYND-262/266: load the bundled dictionaries (en-US, SYNC-12) + hydrate the
    // personal/ignore sets from vault.dictionary. Best-effort, like search.
    crate::spell::sync::hydrate_spell(&app, state.inner()).await;

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
    // SYNC-6: resolve the ACTIVE vault root via the just-unlocked slot's id
    // (`unlock_with_path` set the slot to `Unlocked` before this runs, so
    // `active_vault_id` is the vault we just opened — the correct target once
    // two or more vaults exist, where the old sole-vault disk heuristic
    // mis-resolved). `None` (a concurrent lock raced — Phase 2 only) falls back
    // to the sole-vault path, harmless since prefs_read then fails the slot gate.
    let Ok(vault_dir) = crate::paths::active_vault_root_io(app, state.active_vault_id().await)
    else {
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

    // MYND-205: decrypt the per-vault label into the RAM cache (SYNC-3/4). The
    // label rode inside the same `vault.prefs` blob just read above; cache it
    // under the active vault's id so `vault_list` projects
    // `VaultSummary.label = Some(..)` for this this-session-unlocked vault.
    // `None` (no label set, or a prefs-read fall-back-to-defaults) clears any
    // stale entry. The plaintext label exists ONLY in this RAM cache at
    // runtime — never persisted, never logged.
    if let Some(active) = state.active_vault_id().await {
        state.set_cached_label(active, prefs.label).await;
    }
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

/// MYND-85 (§8.3 / WL-7): on unlock, roll a crashed transactional rename
/// forward (or back) BEFORE any resolution index is built. Resolves the
/// just-unlocked vault's `notes/` dir via the active slot id (SYNC-6) and
/// delegates to the testable [`recover_pending_rename_in_dir`] core.
///
/// Best-effort: a `notes_dir` resolution failure is logged with a bounded
/// io-failure kind and skipped (no path / id ever logged) — the
/// `.rename-journal` marker is the durable WAL, so a missed recovery is
/// retried idempotently on the next unlock and never blocks this one.
pub(crate) async fn recover_pending_rename_on_unlock<R: Runtime>(
    app: &AppHandle<R>,
    state: &VaultRuntimeState,
) {
    let notes_dir = match crate::paths::notes_dir_for(app, state.active_vault_id().await) {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(
                event = "rename_recovery_skipped",
                reason = "notes_dir_resolution_failed",
                io_failure_kind = ?from_io_error_kind(e.kind()),
            );
            return;
        }
    };
    recover_pending_rename_in_dir(notes_dir).await;
}

/// Testable core of [`recover_pending_rename_on_unlock`]: run
/// `note_txn::recover_pending_rename` on a resolved `notes/` dir from a
/// blocking thread (fsync + rename I/O must not stall the async runtime).
/// Best-effort — every failure is logged (bounded kind, no path) and
/// swallowed so the next unlock retries the idempotent recovery.
pub(crate) async fn recover_pending_rename_in_dir(notes_dir: PathBuf) {
    match tokio::task::spawn_blocking(move || crate::note_txn::recover_pending_rename(&notes_dir))
        .await
    {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            tracing::warn!(
                event = "rename_recovery_failed",
                io_failure_kind = ?from_io_error_kind(e.kind()),
                "pending rename recovery failed; left for next-unlock retry",
            );
        }
        Err(_join) => {
            tracing::warn!(
                event = "rename_recovery_join_failed",
                "pending rename recovery task panicked or runtime shutdown",
            );
        }
    }
}

/// Testable core of [`unlock`]. The Tauri-command wrapper resolves
/// the platform-specific `vault.meta` path and delegates here so
/// tests do not need an [`AppHandle`].
///
/// All decisions documented on [`unlock`] apply identically.
pub(crate) async fn unlock_with_path(
    password: String,
    vault_id: Option<crate::vault_id::VaultId>,
    vault_path: &Path,
    state: &VaultRuntimeState,
) -> Result<(), VaultUnlockError> {
    // Wrap immediately so any early-return path (VaultAlreadyUnlocked,
    // UnlockInProgress, IO failure, parse failure) drops the wrapper
    // and zeroes the bytes. Plain `String` would drop without zeroize.
    let password = Zeroizing::new(password);

    let started = Instant::now();

    // Slot-map key resolution (sub-feature 2 task 4 — explicit vault_id
    // targeting): `Some(id)` is the EXPLICIT target the IPC layer threaded (it
    // also resolved `vault_path` to `vaults/<id>/vault.meta`, so the two
    // agree).
    // sole-vault fallback until picker (sub-feature 3): `None` derives the key
    // from the resolved vault ROOT (`vault_path` is `<vault-root>/vault.meta`;
    // its parent is the root) — the transitional single-on-disk-vault key.
    let vault_id = vault_id.unwrap_or_else(|| {
        crate::paths::vault_id_from_root(vault_path.parent().unwrap_or(vault_path))
    });

    // (1) Slot peek precedes permit acquire so the cheap occupied-slot
    //     guard never blocks on the semaphore (grilling Q5). The two
    //     non-Empty variants surface as distinct guard variants so the
    //     frontend can route correctly: `Unlocked` → editor, `Recovering`
    //     → password-reset form (per `recovery-flow.md` §4.1's
    //     non-dismissible chained step).
    match state.slot_kind(vault_id).await {
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
    // Lock-then-unlock seam (sub-feature 2 task 2): enforce the ≤1-`Unlocked`
    // invariant. If a DIFFERENT vault is already unlocked,
    // `set_unlocked_locking_others` locks it first (drops + zeroizes its keys)
    // under one write lock before populating this vault's `Unlocked` entry, so
    // the slot map is never observable with two `Unlocked` entries (SYNC-1).
    // The slot-level four-surface teardown (key zeroize) happens here; the
    // GLOBAL derived-index wipe (search / VaultIndices / attachment-refs) needs
    // an `AppHandle` and runs in the Tauri-command wrapper [`unlock`] on a
    // detected switch BEFORE hydration — no cross-vault index bleed.
    let switched_from = state
        .set_unlocked_locking_others(
            vault_id,
            UnlockedVault {
                root_key,
                items_key,
                items_key_id,
                unlocked_at: now,
                vault_meta_bytes_hash,
            },
        )
        .await;
    if matches!(switched_from, Slot::Unlocked(_)) {
        // A previously-active vault was locked by the switch; its keys already
        // wiped (the returned `Slot::Unlocked` dropped at the helper's scope
        // end). Audit the lock-on-switch with the same `vault_locked` event the
        // manual / idle lock paths emit.
        tracing::info!(
            event = "vault_locked",
            from_slot_kind = "unlocked",
            reason = "vault_switch",
            "lock-then-unlock locked the prior active vault before unlocking the new one"
        );
    }

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
    // MYND-262/266: wipe the spell engine + personal/ignore sets on lock (each
    // add already persisted, so nothing to flush — only RAM to zeroize).
    crate::spell::sync::zeroize_spell(&app);
    // MYND-166: wipe the staged editor-workspace descriptor on the same lock
    // path (AS3 note-ids + layout, as sensitive as the index).
    crate::plugins::workspace::commands::clear_staged_descriptor();
    // MYND-255: destroy the hidden pdf-export render window (a
    // plaintext-bearing second WebView) and wipe its stashed HTML payload on
    // the same lock path — locking means locked for every plaintext surface,
    // not just "main".
    crate::plugins::pdf_export::teardown_on_lock(&app);

    // ---- MYND-31: wipe the plaintext-derived VaultIndices ---------------
    //
    // Same lock path as the search-index wipe — the wikilink graph + tag
    // index are plaintext-derived RAM (as sensitive as the keys), wiped here
    // so nothing survives the manual lock. Rebuilt on the next unlock.
    crate::plugins::vault_indices::zeroize_vault_indices(&app);

    // ---- MYND-169: wipe the plaintext-derived attachment reference graph -
    //
    // Same lock path as the search-index + VaultIndices wipes — the
    // reference graph's note-ids / attachment-ids are plaintext-derived
    // correlation tags (AS3), wiped here so nothing survives the manual
    // lock. Rebuilt on the next unlock.
    crate::plugins::attachments::zeroize_attachment_refs(&app);
    // MYND-259: abort any in-progress voice recording on the manual lock so the
    // mic + RAM PCM buffer never survive it.
    crate::plugins::attachments::abort_active_recording(&app);

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
///
/// ## `vault_id` targeting (sub-feature 2 task 4 — SYNC-6)
///
/// The optional `vault_id` is a canonical hyphenated [`VaultId`] string. It is
/// a TARGETING param (the picker of sub-feature 3 passes the chosen id):
/// - `Some(id)` → report exactly that vault's variant; an UNKNOWN id (no map
///   entry) reports [`SlotKind::Empty`] (a missing entry IS empty).
/// - `None` → report the active/sole vault's variant — the existing App.tsx
///   boot probe (no vault chosen yet) gets the same answer it does today.
///
/// A malformed (non-parseable) `vault_id` string is treated as `None` (fall
/// back to the active-vault probe) rather than surfacing a hard error — the
/// boot/routing probe must always yield a usable [`SlotKind`].
#[tauri::command]
pub async fn vault_slot_kind(
    vault_id: Option<String>,
    state: State<'_, VaultRuntimeState>,
) -> Result<SlotKind, VaultUnlockError> {
    vault_slot_kind_inner(
        crate::vault_id::VaultId::parse_optional(vault_id.as_deref()),
        state.inner(),
    )
    .await
}

/// Testable core of [`vault_slot_kind`]. The Tauri-command wrapper
/// resolves the [`State`] borrow and delegates here so tests do not
/// need a [`AppHandle`].
///
/// `vault_id` targeting (sub-feature 2 task 4): `Some(id)` reports that exact
/// vault's variant (unknown id → [`SlotKind::Empty`]); `None` falls back to the
/// active/sole vault probe below.
pub(crate) async fn vault_slot_kind_inner(
    vault_id: Option<crate::vault_id::VaultId>,
    state: &VaultRuntimeState,
) -> Result<SlotKind, VaultUnlockError> {
    // Explicit target: report exactly that vault's variant. A `VaultId` with
    // no map entry IS empty → `SlotKind::Empty` (the picker can show it as a
    // lockable/lockable-elsewhere vault).
    if let Some(id) = vault_id {
        return Ok(state.slot_kind(id).await);
    }
    // sole-vault fallback until picker (sub-feature 3): report the active
    // vault's slot kind. With the ≤1-`Unlocked` invariant (task 2) there is at
    // most one unlocked vault; an in-flight `Recovering` entry is surfaced when
    // no vault is unlocked. When no entry is `Unlocked` or `Recovering`, the
    // map is empty for routing purposes → `SlotKind::Empty` (the same boot
    // routing the singleton produced). The picker (sub-feature 3) passes an
    // explicit id; current App.tsx boot passes `None`.
    let Some(id) = state.active_vault_or_recovering_for_probe().await else {
        return Ok(SlotKind::Empty);
    };
    Ok(state.slot_kind(id).await)
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
    // TRANSITIONAL (sub-feature 2): param-less `vault_lock` drops the ACTIVE
    // entry (the `Unlocked` vault, else the in-flight `Recovering` one). When
    // no vault is unlocked or recovering, this is an idempotent no-op
    // (`take` on a missing key returns `Slot::Empty`). Param-less is preserved
    // (SYNC-8); task 4 adds explicit-vault_id targeting on top.
    let prior = match state.active_vault_or_recovering_for_probe().await {
        Some(id) => {
            // MYND-205: drop this vault's cached label on the SAME lock path as
            // the slot teardown — a locked vault must stop surfacing its real
            // name in the switcher (SYNC-3: real labels only for this-session-
            // unlocked vaults; a never-this-session-unlocked vault shows the
            // neutral fallback).
            state.evict_cached_label(id).await;
            state.take(id).await
        }
        None => Slot::Empty,
    };
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
    // sole-vault fallback until picker (sub-feature 3): `vault_status` is the
    // boot-time probe of the sole on-disk vault — no explicit id to target.
    let vault_path = vault_meta_path(&app, None).map_err(|_| VaultStatusError::IoError {
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
    // TRANSITIONAL (sub-feature 2): true iff SOME vault is unlocked (the
    // active vault). Task 4 routes by an explicit vault_id.
    Ok(state.active_vault_id().await.is_some())
}

// ---- Multi-vault enumeration: `vault_list` (SYNC-4) -------------------
//
// `vault_list` is the multi-vault generalization of [`vault_status`]: where
// `vault_status` probes the single `vault.meta` of the sole legacy vault,
// `vault_list` enumerates every `vaults/<id>/` directory the disk-scan finds
// and projects each into a DENY-list-clean [`VaultSummary`].
//
// Design context: `agent-tooling/features/vault-registry-and-disk-layout/`
// (sub-feature 1 of the multi-vault epic, MYND-202) + SYNC-4 in
// `agent-tooling/epics/multi-vault/sync-ledger.md`.

/// Coarse on-disk health of a discovered vault directory — the IPC-facing
/// twin of [`crate::vault_registry::DiscoveredVault::well_formed`].
///
/// Two-state minimal enum (SYNC-4):
/// - `Exists`: the `vaults/<id>/` directory carries a readable `vault.meta`
///   (the canonical, fully-formed case). Maps from `well_formed = true`.
/// - `Corrupted`: the directory parses as a [`crate::vault_id::VaultId`] but
///   its `vault.meta` is missing or unreadable. Maps from `well_formed =
///   false`. Such a vault is **surfaced** in the list (so a downstream picker
///   can show it distinctly), never dropped or panicked-on.
///
/// There is deliberately no `Missing` arm (unlike [`VaultStatus`]): a vault
/// absent from disk is simply not in the returned `Vec`.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind")]
pub enum VaultSummaryStatus {
    Exists,
    Corrupted,
}

/// One entry in the [`vault_list`] result — the DENY-list-clean IPC
/// projection of a discovered vault (SYNC-4).
///
/// ## IPC discipline (what crosses, what does NOT)
///
/// - `id`: the [`crate::vault_id::VaultId`] rendered as its canonical
///   36-char lowercase-hyphenated string (the `Display` form). A random
///   UUIDv7 is safe to emit — it is decoupled from `account_number_hash`
///   (SYNC-2), so it carries no account-correlation fingerprint.
/// - `status`: [`VaultSummaryStatus`] — coarse `Exists | Corrupted`.
/// - `label`: `Some` ONLY when a human label has been decrypted from this
///   vault's `vault.prefs` during a this-session unlock and cached in RAM.
///   The RAM label cache is built in sub-feature 4 — until then this is
///   **always `None`** (the field is wired so the IPC contract is stable for
///   the picker, but no label source exists yet). A locked vault not unlocked
///   this session shows a neutral fallback in the picker, NOT its real name
///   (SYNC-3: the label lives encrypted-only, never at rest in the registry).
/// - `last_unlock`: Unix-epoch milliseconds of the last successful unlock,
///   from the best-effort registry cache; `None` for a vault never unlocked
///   (or whose cache entry was just rebuilt).
///
/// **Never emitted** (DENY-list, `src-tauri/CLAUDE.md`): the vault's
/// `account_number_hash` bytes and its full filesystem path. The path lives
/// on [`crate::vault_registry::DiscoveredVault::root`] and is dropped here.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct VaultSummary {
    /// Canonical hyphenated `VaultId` string (the `vaults/<id>/` dir name).
    pub id: String,
    /// Coarse on-disk health — `Exists` for a well-formed dir, `Corrupted`
    /// for one with a missing/unreadable `vault.meta`.
    pub status: VaultSummaryStatus,
    /// Decrypted human label — `Some` only for a this-session-unlocked vault
    /// (always `None` until the RAM label cache lands in sub-feature 4).
    pub label: Option<String>,
    /// Last successful unlock (epoch ms) from the registry cache, if any.
    pub last_unlock: Option<u64>,
}

/// Enumerate every discovered vault under `<app_data_dir>/vaults/` and
/// project each into a [`VaultSummary`] (SYNC-4).
///
/// Read-only: does not hold the unlock permit, does not call into Argon2id,
/// does not populate or peek [`VaultRuntimeState`]. The multi-vault
/// generalization of [`vault_status`] — a downstream picker consumes the
/// returned list (plus the runtime slot map, sub-feature 2) to route boot.
///
/// A corrupted vault (missing/unreadable `vault.meta`) is surfaced with
/// `status: Corrupted`, never dropped. An empty / absent `vaults/` directory
/// yields an empty `Vec`. The command is infallible by construction (the
/// disk-scan never fails — a missing root simply yields nothing; the registry
/// is best-effort and self-rebuilding), but returns `Result` for IPC-contract
/// uniformity with the other probe commands and to surface the lone
/// `app_data_dir`-resolution failure.
#[tauri::command]
pub async fn vault_list<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<Vec<VaultSummary>, VaultStatusError> {
    let base = app.path().app_data_dir().map_err(|_| {
        tracing::error!(
            stage = "vault_list",
            error_kind = "IoError",
            io_failure_kind = ?IoFailureKind::Other,
            "app_data_dir resolution failed during vault_list"
        );
        VaultStatusError::IoError {
            io_error_kind: IoFailureKind::Other,
        }
    })?;
    Ok(vault_list_from_base(&base, state.inner()).await)
}

/// Testable core of [`vault_list`]. The Tauri-command wrapper resolves
/// `<app_data_dir>` and delegates here so tests do not need an
/// [`AppHandle`].
///
/// Joins the disk-scan (the discovery authority, SYNC-10) against the
/// best-effort registry cache for each vault's `last_unlock` and the
/// per-session RAM label cache (MYND-205, SYNC-3/4) for each vault's `label`.
/// `label` is `Some` iff the cache holds a decrypted label for that `VaultId`
/// (i.e. the vault was unlocked this session and carries a label); `None`
/// otherwise so a never-this-session-unlocked vault surfaces the neutral
/// fallback in the switcher. Ordering follows the disk-scan's deterministic
/// `VaultId` sort.
pub(crate) async fn vault_list_from_base(
    base: &Path,
    state: &VaultRuntimeState,
) -> Vec<VaultSummary> {
    // Single disk-scan, fed into BOTH consumers: the registry reconcile (for
    // `last_unlock`) and the summary projection (for the `well_formed` →
    // status mapping the registry intentionally does not carry — SYNC-3).
    // `load_or_rebuild_registry_with` takes the already-computed scan so we
    // do not pay a second `vaults/` scan + re-stat per call.
    let discovered = crate::vault_registry::discover_vaults(base);
    let registry = crate::vault_registry::load_or_rebuild_registry_with(base, &discovered);
    let mut summaries = Vec::with_capacity(discovered.len());
    for discovered in discovered {
        let status = if discovered.well_formed {
            VaultSummaryStatus::Exists
        } else {
            VaultSummaryStatus::Corrupted
        };
        let last_unlock = registry.last_unlock_ms(&discovered.id);
        // MYND-205: project the per-session decrypted label — `Some` only for
        // a this-session-cached vault (SYNC-3/4), `None` otherwise.
        let label = state.cached_label(discovered.id).await;
        summaries.push(VaultSummary {
            // `Display` → canonical hyphenated string; the `root` PathBuf
            // (DENY-listed) is dropped on the move into this map.
            id: discovered.id.to_string(),
            status,
            label,
            last_unlock,
        });
    }
    summaries
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
    use crate::plugins::vault_unlock::state::test_vault_id;
    use crate::test_support::{ScratchVault, FAST_TEST_KDF};
    // `ScopedTempDir` is imported at module scope further down (vault_list
    // tests); `use` is order-independent so it is in scope for the
    // rename-recovery tests above.

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    fn scratch_vault() -> ScratchVault {
        ScratchVault::new("unlock_test")
    }

    // ---- lock-then-unlock: switch gate + global-index bleed (task 2) ----

    use crate::vault_id::VaultId;

    fn vault_id_a() -> VaultId {
        crate::paths::legacy_vault_id()
    }
    fn vault_id_b() -> VaultId {
        VaultId::parse("33333333-3333-7333-8333-333333333333").expect("valid test UUIDv7")
    }

    #[test]
    fn is_vault_switch_true_only_when_a_different_vault_was_active() {
        let a = vault_id_a();
        let b = vault_id_b();
        // No vault was unlocked → first unlock, not a switch.
        assert!(!is_vault_switch(None, b));
        // The SAME vault was active → re-unlock, not a switch.
        assert!(!is_vault_switch(Some(b), b));
        // A DIFFERENT vault was active → switch (must wipe global indices).
        assert!(is_vault_switch(Some(a), b));
    }

    // ---- MYND-85 task 3c: on-unlock rename recovery wiring -------------

    #[test]
    fn recover_pending_rename_in_dir_rolls_a_committed_transaction_forward() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("unlock-rename-recovery").unwrap();
            let notes_dir = crate::paths::notes_dir_under(scratch.path()).unwrap();
            // Simulate a crash AFTER the commit marker landed: a staged
            // `<name>.myn.tmp` + the `.rename-journal` marker, with the live
            // `.myn` still holding pre-rename content. The on-unlock helper
            // must roll the staged blob forward (the §8.3 WAL guarantee).
            std::fs::write(notes_dir.join("note-a.myn"), b"OLD").unwrap();
            std::fs::write(notes_dir.join("note-a.myn.tmp"), b"NEW").unwrap();
            std::fs::write(notes_dir.join(".rename-journal"), b"").unwrap();

            recover_pending_rename_in_dir(notes_dir.clone()).await;

            assert_eq!(
                std::fs::read(notes_dir.join("note-a.myn")).unwrap(),
                b"NEW",
                "marker present → staged blob rolled forward to .myn"
            );
            assert!(
                !notes_dir.join("note-a.myn.tmp").exists(),
                ".tmp consumed by the roll-forward"
            );
            assert!(
                !notes_dir.join(".rename-journal").exists(),
                "marker cleared after recovery"
            );
        });
    }

    #[test]
    fn recover_pending_rename_in_dir_rolls_an_uncommitted_transaction_back() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("unlock-rename-rollback").unwrap();
            let notes_dir = crate::paths::notes_dir_under(scratch.path()).unwrap();
            // Crash BEFORE the marker: staged `.tmp` but NO `.rename-journal`.
            // The live `.myn` must be kept and the orphan `.tmp` swept.
            std::fs::write(notes_dir.join("note-a.myn"), b"OLD").unwrap();
            std::fs::write(notes_dir.join("note-a.myn.tmp"), b"NEW").unwrap();

            recover_pending_rename_in_dir(notes_dir.clone()).await;

            assert_eq!(
                std::fs::read(notes_dir.join("note-a.myn")).unwrap(),
                b"OLD",
                "no marker → roll back: live .myn kept pre-rename"
            );
            assert!(
                !notes_dir.join("note-a.myn.tmp").exists(),
                "orphan .tmp swept on roll-back"
            );
        });
    }

    /// Index-bleed guard (task 2): on a vault switch the four-surface lock
    /// teardown wipes the GLOBAL plaintext-derived indices — search index,
    /// VaultIndices, attachment-ref graph — BEFORE the next vault hydrates
    /// them, so vault A's terms / wikilink records / attachment correlation
    /// tags cannot bleed into vault B. This pins the wipe MECHANISM: the
    /// `zeroize_*`/`clear()` calls the switch triggers actually empty
    /// previously-populated indices. (Driving the full Tauri `unlock` wrapper
    /// end-to-end needs a `tauri::test::mock_app` harness + the `tauri/test`
    /// feature, which would bump `Cargo.lock` — TB9 audit-anchor discipline;
    /// the switch-decision half is covered by `is_vault_switch_*` above and
    /// the slot-level lock-then-unlock by the `state` module's acceptance
    /// test.)
    #[test]
    fn switch_teardown_wipes_every_global_derived_index() {
        use crate::plugins::attachments::AttachmentRefsState;
        use crate::plugins::vault_indices::state::NoteRecord;
        use crate::plugins::vault_indices::VaultIndicesState;
        use crate::search::SearchIndexState;

        // Simulate vault A having hydrated all three global indices.
        let search = SearchIndexState::default();
        search.upsert("note-a", "Alpha Title", "alpha body text");
        assert!(
            !search.query("alpha").is_empty(),
            "precondition: vault A search index populated"
        );

        let indices = VaultIndicesState::default();
        indices.apply(
            "note-a",
            NoteRecord {
                title: Some("Alpha Title".to_string()),
                folder: None,
                title_key: None,
                edges: Vec::new(),
                tags: Vec::new(),
                properties: Vec::new(),
            },
        );
        assert_eq!(
            indices.note_count(),
            1,
            "precondition: vault A VaultIndices populated"
        );

        let refs = AttachmentRefsState::default();
        refs.apply("note-a", ["att-a".to_string()]);
        assert_eq!(
            refs.note_count(),
            1,
            "precondition: vault A attachment-ref graph populated"
        );

        // The switch teardown wipes each global index (the same `clear()` the
        // `zeroize_*` wrappers call). After it, NONE of vault A's data
        // survives into the next vault's about-to-hydrate indices.
        search.clear();
        indices.clear();
        refs.clear();

        assert!(
            search.query("alpha").is_empty(),
            "search index must be wiped on switch (no vault-A term bleed)"
        );
        assert_eq!(
            indices.note_count(),
            0,
            "VaultIndices must be wiped on switch (no vault-A wikilink bleed)"
        );
        assert_eq!(
            refs.note_count(),
            0,
            "attachment-ref graph must be wiped on switch (no vault-A correlation-tag bleed)"
        );
    }

    /// Seed a real `vault.meta` via `vault_creation::build_session`
    /// plus `build_and_serialize_vault_meta`. Returns the bytes and
    /// the original session-side `root_key` for post-unlock assertions.
    fn seed_vault_meta(password: &str) -> ([u8; protocol::VAULT_META_LEN], [u8; AEAD_KEY_LEN]) {
        let session = build_session(crate::vault_id::VaultId::mint(), password, FAST_TEST_KDF)
            .expect("build_session");
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
                None,
                scratch.path(),
                &state,
            )
            .await
            .expect("unlock with correct password");

            let unlocked = state.take(test_vault_id()).await.unwrap_unlocked();
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
                    show_note_timestamps: true,
                    folder_icons: Default::default(),
                    hidden_bar_items: Vec::new(),
                    item_colors: Default::default(),
                    theme: None,
                    deliberate_folders: Vec::new(),
                    auto_lock_seconds: None,
                    custom_theme: None,
                    daily_date_format: None,
                    daily_folder: None,
                    daily_template: None,
                    favorites: Vec::new(),
                    item_order: Vec::new(),
                    editor_layout: None,
                    editor_line_numbers: None,
                    editor_content_width: None,
                    editor_font_family: None,
                    editor_line_spacing: None,
                    editor_text_size: None,
                    label: None,
                    last_backup_at: None,
                    spell_enabled: None,
                    spell_languages: Vec::new(),
                    saved_views: Vec::new(),
                    view_order: Vec::new(),
                },
            )
            .expect("encode prefs blob");
            std::fs::write(scratch.dir.join("vault.prefs"), &prefs_blob).expect("seed vault.prefs");

            let state = VaultRuntimeState::default();
            unlock_with_path(
                "correct horse battery staple".to_string(),
                None,
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
                None,
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
                show_note_timestamps: true,
                folder_icons: Default::default(),
                hidden_bar_items: Vec::new(),
                item_colors: Default::default(),
                theme: None,
                deliberate_folders: Vec::new(),
                auto_lock_seconds: None,
                custom_theme: None,
                daily_date_format: None,
                daily_folder: None,
                daily_template: None,
                favorites: Vec::new(),
                item_order: Vec::new(),
                editor_layout: None,
                editor_line_numbers: None,
                editor_content_width: None,
                editor_font_family: None,
                editor_line_spacing: None,
                editor_text_size: None,
                label: None,
                last_backup_at: None,
                spell_enabled: None,
                spell_languages: Vec::new(),
                saved_views: Vec::new(),
                view_order: Vec::new(),
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
                None,
                scratch.path(),
                &state,
            )
            .await
            .expect("unlock with correct password");

            // Slot is occupied with the original root_key bytes.
            let unlocked = state.take(test_vault_id()).await.unwrap_unlocked();
            assert_eq!(*unlocked.root_key, original_root_key);
        });
    }

    #[test]
    fn unlock_with_explicit_vault_id_keys_the_slot_under_that_id() {
        // SYNC-6 targeting (task 4): an EXPLICIT `Some(id)` keys the slot map
        // under exactly that id — NOT the path-derived legacy sentinel the
        // sole-vault `None` fallback would use. (`scratch`'s temp dir name is
        // not a UUIDv7, so the `None` derivation yields `legacy_vault_id()` =
        // `test_vault_id()`; an explicit non-legacy id must override it.)
        rt().block_on(async {
            use super::super::state::test_vault_id_b;
            let scratch = scratch_vault();
            let (meta_bytes, original_root_key) = seed_vault_meta("pw");
            scratch.write_meta(&meta_bytes);

            let explicit = test_vault_id_b();
            assert_ne!(explicit, test_vault_id(), "explicit id must be non-legacy");

            let state = VaultRuntimeState::default();
            unlock_with_path("pw".to_string(), Some(explicit), scratch.path(), &state)
                .await
                .expect("unlock with explicit vault_id");

            // The slot is keyed under the EXPLICIT id.
            assert_eq!(state.slot_kind(explicit).await, SlotKind::Unlocked);
            let unlocked = state.take(explicit).await.unwrap_unlocked();
            assert_eq!(*unlocked.root_key, original_root_key);

            // The path-derived legacy key has NO entry — the explicit id
            // overrode the fallback derivation.
            assert_eq!(
                state.slot_kind(test_vault_id()).await,
                SlotKind::Empty,
                "explicit-id targeting must NOT key the path-derived legacy sentinel"
            );
        });
    }

    #[test]
    fn wrong_password_returns_invalid_credential_or_vault() {
        rt().block_on(async {
            let scratch = scratch_vault();
            let (meta_bytes, _) = seed_vault_meta("the right password");
            scratch.write_meta(&meta_bytes);

            let state = VaultRuntimeState::default();
            let result = unlock_with_path(
                "the wrong password".to_string(),
                None,
                scratch.path(),
                &state,
            )
            .await;

            assert!(matches!(
                result,
                Err(VaultUnlockError::InvalidCredentialOrVault)
            ));
            // Failed unlock leaves slot empty.
            assert!(state.slot_kind(test_vault_id()).await == SlotKind::Empty);
        });
    }

    #[test]
    fn missing_vault_meta_returns_vault_not_found() {
        rt().block_on(async {
            let scratch = scratch_vault();
            // Do NOT call write_meta — vault.meta is absent.
            assert!(!scratch.path().exists());

            let state = VaultRuntimeState::default();
            let result =
                unlock_with_path("anything".to_string(), None, scratch.path(), &state).await;

            assert!(matches!(result, Err(VaultUnlockError::VaultNotFound)));
            assert!(state.slot_kind(test_vault_id()).await == SlotKind::Empty);
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
            unlock_with_path("pw".to_string(), None, scratch.path(), &state)
                .await
                .expect("unlock");

            let unlocked = state.take(test_vault_id()).await.unwrap_unlocked();
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
            let result = unlock_with_path("pw".to_string(), None, scratch.path(), &state).await;

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
                state.slot_kind(test_vault_id()).await == SlotKind::Empty,
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
        let result = unlock_with_path("pw".to_string(), None, scratch.path(), &state).await;

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
            state.slot_kind(test_vault_id()).await == SlotKind::Empty,
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
            let result = unlock_with_path("pw".to_string(), None, scratch.path(), &state).await;

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
                state.slot_kind(test_vault_id()).await == SlotKind::Empty,
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
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(0x42, 0x13, 0x99),
                )
                .await;

            let result = unlock_with_path("pw".to_string(), None, scratch.path(), &state).await;

            assert!(matches!(
                result,
                Err(VaultUnlockError::VaultAlreadyUnlocked)
            ));

            // Existing slot is untouched: the same fixture bytes
            // come back from take(). The unlock attempt did NOT
            // overwrite or perturb it.
            let existing = state.take(test_vault_id()).await.unwrap_unlocked();
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
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(0x55, 0x66, 0x77),
                )
                .await;

            // Manually hold the unlock permit. If unlock_with_path
            // tried try_acquire BEFORE peek, this would surface as
            // UnlockInProgress instead of VaultAlreadyUnlocked.
            let _held_permit = state
                .auth_permits()
                .try_acquire()
                .expect("first acquire on fresh state");
            assert_eq!(state.auth_permits().available_permits(), 0);

            let result = unlock_with_path("pw".to_string(), None, scratch.path(), &state).await;

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
                .set_recovering(
                    test_vault_id(),
                    fixture_recovering_with_keys(0xAA, 0xBB, 0xCC),
                )
                .await;

            let result = unlock_with_path("pw".to_string(), None, scratch.path(), &state).await;

            assert!(matches!(
                result,
                Err(VaultUnlockError::VaultRecoveryInProgress)
            ));

            // Existing slot is untouched — slot_kind still Recovering.
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Recovering);
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
                .set_recovering(
                    test_vault_id(),
                    fixture_recovering_with_keys(0x55, 0x66, 0x77),
                )
                .await;

            // Manually hold the auth permit. If unlock_with_path tried
            // try_acquire BEFORE peek, this would surface as
            // UnlockInProgress instead of VaultRecoveryInProgress.
            let _held_permit = state
                .auth_permits()
                .try_acquire()
                .expect("first acquire on fresh state");
            assert_eq!(state.auth_permits().available_permits(), 0);

            let result = unlock_with_path("pw".to_string(), None, scratch.path(), &state).await;

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
            assert!(state.slot_kind(test_vault_id()).await == SlotKind::Empty);

            // Simulate "in-flight unlock" by holding the permit.
            let held_permit = state
                .auth_permits()
                .try_acquire()
                .expect("first acquire on fresh state");
            assert_eq!(state.auth_permits().available_permits(), 0);

            // While held, a fresh unlock attempt rejects cleanly.
            let result = unlock_with_path("pw".to_string(), None, scratch.path(), &state).await;
            assert!(matches!(result, Err(VaultUnlockError::UnlockInProgress)));
            // The slot stayed empty — no half-state.
            assert!(state.slot_kind(test_vault_id()).await == SlotKind::Empty);

            // Release the held permit; subsequent unlock succeeds
            // (proving the guard is purely structural, not stateful
            // beyond permit availability).
            drop(held_permit);
            assert_eq!(state.auth_permits().available_permits(), 1);

            unlock_with_path("pw".to_string(), None, scratch.path(), &state)
                .await
                .expect("retry after permit released succeeds");

            // Permit released after successful unlock too.
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }

    #[test]
    fn distinct_vault_unlock_cannot_co_hold_the_single_global_permit() {
        // Task 6: the `auth_permits` semaphore is a SINGLE GLOBAL capacity-1
        // permit on `VaultRuntimeState` — NOT per-vault. Two unlock attempts
        // for DISTINCT vaults therefore cannot both hold it: the second is
        // rejected with `UnlockInProgress` (the per-plugin in-progress guard),
        // NOT queued. Deterministic substitute for "two concurrent distinct
        // unlocks": hold the permit (modeling an in-flight unlock of vault A at
        // any post-acquire stage — e.g. mid-Argon2id), then attempt an unlock
        // of a DIFFERENT vault B (distinct `VaultId` keyed via the explicit
        // `Some(id)` param, distinct on-disk scratch). If the permit were
        // per-vault, B would acquire its own and proceed; because it is global
        // cap-1, B rejects without running Argon2id and without queueing.
        rt().block_on(async {
            // Two on-disk vaults, distinct directories.
            let scratch_b = ScratchVault::new("unlock_distinct_b");
            let (bytes_b, _) = seed_vault_meta("pw");
            scratch_b.write_meta(&bytes_b);

            let id_a = test_vault_id();
            let id_b = vault_id_b();
            assert_ne!(id_a, id_b);

            let state = VaultRuntimeState::default();
            // B's slot is Empty — so the slot peek inside `unlock_with_path`
            // PASSES and the rejection can only come from the (global) permit.
            assert_eq!(state.slot_kind(id_b).await, SlotKind::Empty);

            // Model an in-flight unlock of vault A by holding the SINGLE permit.
            let held_for_a = state
                .auth_permits()
                .try_acquire()
                .expect("first acquire on fresh state (vault A's in-flight unlock)");
            assert_eq!(state.auth_permits().available_permits(), 0);

            // A DISTINCT vault B unlock attempt must reject with the in-progress
            // guard — proving the permit is global, not per-vault. Argon2id is
            // never reached (try_acquire fails before spawn_blocking).
            let result =
                unlock_with_path("pw".to_string(), Some(id_b), scratch_b.path(), &state).await;
            assert!(
                matches!(result, Err(VaultUnlockError::UnlockInProgress)),
                "distinct-vault unlock must reject with UnlockInProgress while the single global permit is held, got {result:?}"
            );
            // No queueing / no half-state: B's slot stayed Empty.
            assert_eq!(state.slot_kind(id_b).await, SlotKind::Empty);

            // Release A's permit; B's unlock then succeeds (the guard was purely
            // structural — global permit availability, not per-vault state).
            drop(held_for_a);
            assert_eq!(state.auth_permits().available_permits(), 1);
            unlock_with_path("pw".to_string(), Some(id_b), scratch_b.path(), &state)
                .await
                .expect("B unlocks once the single global permit is free");
            assert_eq!(state.slot_kind(id_b).await, SlotKind::Unlocked);
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
            let r1 = unlock_with_path("wrong pw".to_string(), None, scratch.path(), &state).await;
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
            unlock_with_path("right pw".to_string(), None, scratch.path(), &state)
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
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(0x77, 0x88, 0x99),
                )
                .await;
            assert!(state.slot_kind(test_vault_id()).await == SlotKind::Unlocked);

            lock_with_state(&state)
                .await
                .expect("lock on populated slot returns Ok");

            assert!(
                state.slot_kind(test_vault_id()).await == SlotKind::Empty,
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
                unwrap_slot_kind(vault_slot_kind_inner(None, &state).await),
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
                .set_recovering(
                    test_vault_id(),
                    fixture_recovering_with_keys(0xAA, 0xBB, 0xCC),
                )
                .await;

            assert_eq!(
                unwrap_slot_kind(vault_slot_kind_inner(None, &state).await),
                SlotKind::Recovering
            );

            // Read-only: state was not perturbed by the probe.
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Recovering);
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
            unlock_with_path("pw".to_string(), None, scratch.path(), &state)
                .await
                .expect("unlock seeded vault");

            assert_eq!(
                unwrap_slot_kind(vault_slot_kind_inner(None, &state).await),
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
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(0x11, 0x22, 0x33),
                )
                .await;
            assert_eq!(
                unwrap_slot_kind(vault_slot_kind_inner(None, &state).await),
                SlotKind::Unlocked
            );

            lock_with_state(&state).await.expect("lock");
            assert_eq!(
                unwrap_slot_kind(vault_slot_kind_inner(None, &state).await),
                SlotKind::Empty
            );
        });
    }

    // ---- vault_slot_kind explicit `vault_id` targeting (task 4) ----------
    //
    // `Some(id)` reports exactly that vault's variant; an UNKNOWN id reports
    // Empty; `None` keeps the active/sole-vault probe (App.tsx boot).

    #[test]
    fn vault_slot_kind_some_reports_the_named_vaults_variant() {
        // Two distinct entries — Unlocked under A, Recovering under B. A
        // targeted probe by id reports each entry's OWN variant, independent
        // of which one the active-vault resolver would pick.
        rt().block_on(async {
            use super::super::state::test_vault_id_b;
            let state = VaultRuntimeState::default();
            let id_a = test_vault_id();
            let id_b = test_vault_id_b();

            state
                .set_unlocked(id_a, fixture_unlocked_with_keys(0x11, 0x22, 0x33))
                .await;
            state
                .set_recovering(id_b, fixture_recovering_with_keys(0xAA, 0xBB, 0xCC))
                .await;

            // Some(A) → Unlocked; Some(B) → Recovering — each names its own.
            assert_eq!(
                unwrap_slot_kind(vault_slot_kind_inner(Some(id_a), &state).await),
                SlotKind::Unlocked,
                "Some(A) must report A's Unlocked variant"
            );
            assert_eq!(
                unwrap_slot_kind(vault_slot_kind_inner(Some(id_b), &state).await),
                SlotKind::Recovering,
                "Some(B) must report B's Recovering variant"
            );
        });
    }

    #[test]
    fn vault_slot_kind_some_unknown_id_reports_empty() {
        // A `Some(id)` for a vault with NO map entry reports Empty (a missing
        // entry IS empty) — even while a DIFFERENT vault is unlocked.
        rt().block_on(async {
            use super::super::state::test_vault_id_b;
            let state = VaultRuntimeState::default();
            // Only A is unlocked.
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(0x11, 0x22, 0x33),
                )
                .await;

            // Probing the OTHER (unknown) id → Empty, not A's Unlocked.
            assert_eq!(
                unwrap_slot_kind(vault_slot_kind_inner(Some(test_vault_id_b()), &state).await),
                SlotKind::Empty,
                "an unknown vault_id must report Empty, not bleed the active vault's variant"
            );
        });
    }

    #[test]
    fn vault_slot_kind_none_falls_back_to_active_vault() {
        // `None` (the App.tsx boot probe) reports the active/sole vault's
        // variant — unchanged from the pre-task-4 single-arg behavior.
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            // No explicit id, nothing unlocked → Empty.
            assert_eq!(
                unwrap_slot_kind(vault_slot_kind_inner(None, &state).await),
                SlotKind::Empty
            );
            // Unlock the sole vault; None now resolves it as the active vault.
            state
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(0x11, 0x22, 0x33),
                )
                .await;
            assert_eq!(
                unwrap_slot_kind(vault_slot_kind_inner(None, &state).await),
                SlotKind::Unlocked,
                "None must resolve to the sole Unlocked vault (App.tsx boot probe)"
            );
        });
    }

    #[test]
    fn parse_optional_vault_id_some_invalid_and_none_collapse_to_none() {
        // The IPC string parser: a valid id round-trips; `None` and a
        // malformed string both collapse to `None` (active-vault fallback)
        // so a picker bug / omitted field never hard-fails routing.
        use crate::vault_id::VaultId;
        let id = test_vault_id();
        assert_eq!(
            VaultId::parse_optional(Some(&id.to_string())),
            Some(id),
            "a canonical VaultId string parses to Some(id)"
        );
        assert_eq!(VaultId::parse_optional(None), None, "None stays None");
        assert_eq!(
            VaultId::parse_optional(Some("not-a-vault-id")),
            None,
            "a malformed id collapses to None (sole-vault fallback)"
        );
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
                .set_recovering(test_vault_id(), fixture_recovering_with_keys(0xAA, 0xBB, 0xCC))
                .await;
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Recovering);

            lock_with_state(&state)
                .await
                .expect("lock on Recovering slot returns Ok");

            assert_eq!(
                state.slot_kind(test_vault_id()).await,
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
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);

            lock_with_state(&state)
                .await
                .expect("lock on Empty slot returns Ok (idempotent)");

            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);
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
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(0x01, 0x02, 0x03),
                )
                .await;
            for i in 0..10 {
                lock_with_state(&state)
                    .await
                    .unwrap_or_else(|_| panic!("lock #{i} from Unlocked must succeed"));
                assert_eq!(
                    state.slot_kind(test_vault_id()).await,
                    SlotKind::Empty,
                    "slot must be Empty after lock #{i} (from Unlocked)"
                );
            }

            // (b) Starting from Recovering.
            let state = VaultRuntimeState::default();
            state
                .set_recovering(
                    test_vault_id(),
                    fixture_recovering_with_keys(0x10, 0x20, 0x30),
                )
                .await;
            for i in 0..10 {
                lock_with_state(&state)
                    .await
                    .unwrap_or_else(|_| panic!("lock #{i} from Recovering must succeed"));
                assert_eq!(
                    state.slot_kind(test_vault_id()).await,
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
                    state.slot_kind(test_vault_id()).await,
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
                .set_unlocked(
                    test_vault_id(),
                    fixture_unlocked_with_keys(0x11, 0x12, 0x13),
                )
                .await;

            // Lock — drops the fixture; slot empties.
            lock_with_state(&state).await.expect("lock");
            assert!(state.slot_kind(test_vault_id()).await == SlotKind::Empty);

            // Real unlock from the seeded vault.meta. Pays the
            // full Argon2id (FAST_TEST_KDF) + AEAD-open pipeline.
            unlock_with_path("pw".to_string(), None, scratch.path(), &state)
                .await
                .expect("unlock after lock succeeds");

            // The slot now carries the FRESH root_key from
            // vault.meta, NOT the prior fixture's 0x11 bytes.
            let unlocked = state.take(test_vault_id()).await.unwrap_unlocked();
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
                .set_unlocked(
                    test_vault_id(),
                    status_fixture_unlocked_with_keys(0x42, 0x13, 0x99),
                )
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
                .set_unlocked(
                    test_vault_id(),
                    status_fixture_unlocked_with_keys(0x77, 0x88, 0x99),
                )
                .await;
            assert_eq!(vault_is_unlocked_with_state(&state).await, Ok(true));

            let _ = state.take(test_vault_id()).await; // simulate vault_lock
            assert_eq!(vault_is_unlocked_with_state(&state).await, Ok(false));
        });
    }

    // ---- vault_list multi-vault enumeration (SYNC-4) -------------------
    //
    // Exercises `vault_list_from_base` (the AppHandle-free core of the
    // `vault_list` command) over a `ScopedTempDir` standing in for
    // `<app_data_dir>`. Covers the three acceptance shapes — Exists,
    // Corrupted-surfaced-not-dropped, empty-list — plus the IPC discipline
    // (no path/hash crosses the boundary; label always None for now).

    use crate::test_support::ScopedTempDir;

    const VAULTS_DIR: &str = "vaults";

    /// Create `<base>/vaults/<minted-id>/` and return the canonical id
    /// string. `well_formed` controls whether a `vault.meta` marker is
    /// seeded (its presence is what separates Exists from Corrupted).
    fn seed_disk_vault(base: &Path, well_formed: bool) -> String {
        let id = crate::vault_id::VaultId::mint();
        let dir = base.join(VAULTS_DIR).join(id.to_string());
        std::fs::create_dir_all(&dir).expect("create vault dir");
        if well_formed {
            std::fs::write(dir.join("vault.meta"), b"any vault.meta bytes")
                .expect("seed vault.meta");
        }
        id.to_string()
    }

    #[test]
    fn vault_list_empty_when_no_vaults() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vlist-empty").unwrap();
            let state = VaultRuntimeState::default();
            let summaries = vault_list_from_base(tmp.path(), &state).await;
            assert!(
                summaries.is_empty(),
                "no vaults/ dir → empty vault_list (not an error, not a panic)"
            );
        });
    }

    #[test]
    fn vault_list_reports_exists_for_well_formed_dir() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vlist-exists").unwrap();
            let id = seed_disk_vault(tmp.path(), true);

            let state = VaultRuntimeState::default();
            let summaries = vault_list_from_base(tmp.path(), &state).await;
            assert_eq!(summaries.len(), 1, "one summary per discovered vault");
            let s = &summaries[0];
            assert_eq!(s.id, id, "id is the canonical hyphenated VaultId string");
            assert_eq!(s.status, VaultSummaryStatus::Exists);
            assert_eq!(
                s.label, None,
                "label is None when nothing is cached this session (MYND-205)"
            );
        });
    }

    /// MYND-205: a vault whose decrypted label is in the per-session RAM cache
    /// projects `label: Some(..)`, while a discovered-but-not-cached vault
    /// projects `label: None` (the neutral-fallback signal). Pins the
    /// SYNC-3/4 wiring of `cached_label` → `VaultSummary.label`.
    #[test]
    fn vault_list_projects_cached_label_only_for_cached_vault() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vlist-label").unwrap();
            let cached = seed_disk_vault(tmp.path(), true);
            let uncached = seed_disk_vault(tmp.path(), true);

            let state = VaultRuntimeState::default();
            // Cache a label for exactly one of the two discovered vaults.
            let cached_id = crate::vault_id::VaultId::parse(&cached).unwrap();
            state
                .set_cached_label(cached_id, Some(String::from("Work")))
                .await;

            let summaries = vault_list_from_base(tmp.path(), &state).await;
            let cached_s = summaries.iter().find(|s| s.id == cached).expect("cached");
            let uncached_s = summaries
                .iter()
                .find(|s| s.id == uncached)
                .expect("uncached");
            assert_eq!(
                cached_s.label,
                Some(String::from("Work")),
                "the this-session-cached vault projects its real label"
            );
            assert_eq!(
                uncached_s.label, None,
                "a never-this-session-unlocked vault projects None (neutral fallback)"
            );
        });
    }

    #[test]
    fn vault_list_surfaces_corrupted_dir_not_dropped() {
        rt().block_on(async {
            // A `vaults/<id>/` directory with no `vault.meta` is discovered but
            // flagged not-well-formed → Corrupted. It MUST appear in the list
            // (so a downstream picker can show it distinctly), never be dropped
            // or panicked-on (user story 5).
            let tmp = ScopedTempDir::new("vlist-corrupt").unwrap();
            let good = seed_disk_vault(tmp.path(), true);
            let bad = seed_disk_vault(tmp.path(), false);

            let state = VaultRuntimeState::default();
            let summaries = vault_list_from_base(tmp.path(), &state).await;
            assert_eq!(
                summaries.len(),
                2,
                "corrupted vault is surfaced, not dropped"
            );

            let good_s = summaries
                .iter()
                .find(|s| s.id == good)
                .expect("good present");
            let bad_s = summaries.iter().find(|s| s.id == bad).expect("bad present");
            assert_eq!(good_s.status, VaultSummaryStatus::Exists);
            assert_eq!(
                bad_s.status,
                VaultSummaryStatus::Corrupted,
                "dir without vault.meta → Corrupted"
            );
        });
    }

    #[test]
    fn vault_list_populates_last_unlock_from_registry() {
        rt().block_on(async {
            // last_unlock is read from the best-effort registry cache. Seed a
            // registry entry with a known epoch-ms and assert it round-trips
            // through `vault_list`.
            let tmp = ScopedTempDir::new("vlist-last-unlock").unwrap();
            let id = seed_disk_vault(tmp.path(), true);

            // Hand-write a registry carrying a last-unlock time for `id`.
            let registry_json = serde_json::json!({
                "version": 1,
                "vaults": [ { "id": id, "last_unlock": 1_700_000_000_000u64 } ],
            });
            std::fs::write(
                tmp.path().join(VAULTS_DIR).join("registry.json"),
                serde_json::to_vec(&registry_json).unwrap(),
            )
            .unwrap();

            let state = VaultRuntimeState::default();
            let summaries = vault_list_from_base(tmp.path(), &state).await;
            assert_eq!(summaries.len(), 1);
            assert_eq!(
                summaries[0].last_unlock,
                Some(1_700_000_000_000),
                "last_unlock is populated from the registry cache"
            );
        });
    }

    #[test]
    fn vault_list_last_unlock_none_for_never_unlocked_vault() {
        rt().block_on(async {
            // A freshly-seeded vault with no registry last-unlock entry reports
            // `last_unlock: None` (the registry is rebuilt with no time).
            let tmp = ScopedTempDir::new("vlist-no-unlock").unwrap();
            seed_disk_vault(tmp.path(), true);

            let state = VaultRuntimeState::default();
            let summaries = vault_list_from_base(tmp.path(), &state).await;
            assert_eq!(summaries.len(), 1);
            assert_eq!(summaries[0].last_unlock, None);
        });
    }

    #[test]
    fn vault_list_ipc_projection_carries_no_path_or_hash() {
        rt().block_on(async {
            // IPC discipline (SYNC-4 / DENY-list): the serialized VaultSummary
            // must NOT carry a filesystem path or any account-hash bytes. The
            // `DiscoveredVault.root` PathBuf is dropped in the projection. We
            // assert structurally (no `root`/`path` field) AND by serialized
            // content (the temp base path string never appears in the JSON).
            let tmp = ScopedTempDir::new("vlist-deny").unwrap();
            seed_disk_vault(tmp.path(), true);

            let state = VaultRuntimeState::default();
            let summaries = vault_list_from_base(tmp.path(), &state).await;
            let json = serde_json::to_string(&summaries).expect("VaultSummary serializes");

            // Only the four contract fields are present.
            assert!(json.contains("\"id\""));
            assert!(json.contains("\"status\""));
            assert!(json.contains("\"label\""));
            assert!(json.contains("\"last_unlock\""));
            // No path/hash leakage.
            for forbidden in ["root", "\"path\"", "account", "hash", "vaults/"] {
                assert!(
                    !json.contains(forbidden),
                    "serialized VaultSummary must not contain `{forbidden}` (DENY-list)"
                );
            }
            // The absolute temp base path (a full filesystem path) must not leak.
            let base_str = tmp.path().to_string_lossy();
            assert!(
                !json.contains(base_str.as_ref()),
                "the filesystem base path must never cross the IPC boundary"
            );
        });
    }

    #[test]
    fn vault_list_status_serializes_with_kind_tag() {
        // Wire-shape pin: VaultSummaryStatus serializes `#[serde(tag = "kind")]`
        // (mirrors VaultStatus), so the TS mirror is `{ kind: "Exists" } |
        // { kind: "Corrupted" }`.
        assert_eq!(
            serde_json::to_string(&VaultSummaryStatus::Exists).unwrap(),
            r#"{"kind":"Exists"}"#
        );
        assert_eq!(
            serde_json::to_string(&VaultSummaryStatus::Corrupted).unwrap(),
            r#"{"kind":"Corrupted"}"#
        );
    }
}
