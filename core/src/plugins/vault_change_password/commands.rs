//! Tauri commands for the `vault-change-password` plugin.
//!
//! [`change_password`] is the standalone password-rotation flow: user
//! knows their current password, sets a new one. The post-recovery
//! password reset (where the user proves identity via recovery phrase
//! instead) lives in `vault_recover::complete_recovery` — different
//! signature, different command.
//!
//! Design history: PRD + MYND-22 grilling Q1–Q9 in `myne-agents/`.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

use super::super::vault_unlock::state::VaultRuntimeState;
use super::error::VaultChangePasswordError;
use crate::host::HostCtx;
use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use crate::protocol_error_kind::protocol_error_kind;
use protocol::{AEAD_NONCE_LEN, ARGON2_SALT_LEN};
use std::path::{Path, PathBuf};
use std::time::Instant;
// Tauri types serve only the cfg-gated IPC wrappers (task 79, Option B). The
// `Manager` import went with them: its only use here was `app.path()`, which
// `HostCtx::app_data_dir` now provides.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use crate::host::tauri_host::TauriHost;
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use tauri::{AppHandle, Runtime, State};
use zeroize::Zeroizing;

/// Resolve `<active-vault-root>/vault.meta`. Local rather than imported from
/// sibling plugins because the return type is `VaultChangePasswordError`.
/// `active_id` is read from the runtime state by [`change_password`]
/// (`state.active_vault_id().await`) — the only place with `.await` access to
/// the slot map. SYNC-6: a password change always rotates the unlocked vault's
/// wrap, so resolving via the active id (not the transitional sole-vault disk
/// heuristic) keeps the rewrite targeting the correct `vault.meta` once two or
/// more exist.
fn vault_meta_path(
    host: &dyn HostCtx,
    active_id: Option<crate::vault_id::VaultId>,
) -> Result<PathBuf, VaultChangePasswordError> {
    let base = host
        .app_data_dir()
        .map_err(|_| VaultChangePasswordError::IoError {
            io_error_kind: IoFailureKind::Other,
        })?;
    Ok(crate::paths::active_vault_root_from_base(&base, active_id).join("vault.meta"))
}

/// Tauri command name `change_password` (NOT `commit`) — chosen to
/// avoid `#[tauri::command]` macro symbol collision with
/// `vault_creation::commands::commit`. Both macros generate a hidden
/// `__cmd__<fn-name>` symbol in the global namespace; identical
/// short names across plugins collide at link-time.
pub async fn change_password_from_host(
    current_password: String,
    new_password: String,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    host: &dyn HostCtx,
) -> Result<(), VaultChangePasswordError> {
    let vault_path = vault_meta_path(host, state.active_vault_id().await)?;

    // MYND-351 Direction 2: a user-initiated change-password preempts an
    // in-flight scheduled backup (which holds the shared auth permit) so the
    // pipeline's `try_acquire` below is not rejected by the invisible job.
    hooks.preempt_inflight_backup(state).await;

    let result =
        change_password_with_path(current_password, new_password, &vault_path, state, hooks).await;

    // MYND-29: wipe the plaintext-derived RAM surfaces on the force-relock
    // outcomes — they drop `Slot::Unlocked` to `Empty` and zeroize the keys
    // (`force_relock_on_invalid_vault_meta` / `force_relock_on_cas_mismatch` /
    // the post-Argon2id `HashMismatch` inside `commit_unlocked_rewrite`), so
    // everything plaintext-derived (as sensitive as the keys) must wipe on the
    // SAME path — upholding `spec/protocol.md` §9.6.5 "nothing search-derived
    // survives a lock" and §9.8.5 / §9.17.5, which name the credential-rotation
    // force-relock as one of the slot-drop sites their zeroize-on-every-drop
    // residency clause covers. The list below is the manual-lock list
    // (`vault_unlock::commands::lock_from_host`) — a hook added to one and not
    // the other is the drift these two spec clauses forbid.
    //
    // A SUCCESS leaves the slot Unlocked (`root_key` unchanged — only its wrap
    // rotated), so the indices are preserved; `IoError`/`JoinFailure` also
    // leave the slot Unlocked → must NOT wipe. `VaultLockedDuringChange` means
    // a concurrent `vault_lock` already dropped + wiped, so it is not this
    // command's drop to clean up.
    if matches!(
        &result,
        Err(VaultChangePasswordError::InvalidVaultMeta)
            | Err(VaultChangePasswordError::VaultMetaChangedExternally)
    ) {
        // myne-md/myne#464: drop every `Slot::ImportSource` on the same path.
        // A source vault's `root_key` and `items_key` are a SECOND vault's key
        // material held in RAM, so they belong on every list that answers
        // "what must not outlive this vault leaving". `threat-model.md` A6's
        // amendment for this feature bounds the window as "the length of the
        // import, and no longer than the target vault's own session", and a
        // teardown site that skips this call is precisely where that sentence
        // stops being true. `close_all` rather than a keyed drop: whichever
        // vault just went away, an import across it cannot continue.
        crate::plugins::vault_unlock::import_source::close_all(state).await;
        hooks.zeroize_search_index();
        // MYND-262/266: wipe the spell engine + personal/ignore sets (each add
        // already persisted, so nothing to flush — only RAM to zeroize).
        hooks.zeroize_spell();
        // MYND-166: wipe the staged editor-workspace descriptor on this
        // force-relock path too.
        hooks.clear_staged_descriptor();
        // MYND-255: destroy the hidden pdf-export render window (a
        // plaintext-bearing second WebView) and wipe its stashed HTML
        // payload on the same force-relock path — locking means locked
        // for every plaintext surface, not just "main".
        hooks.pdf_export_teardown_on_lock();
        hooks.agent_teardown_on_lock();
        // myne#679: destroy every open detached (pop-out) note window on the
        // force-relock path too: locking means locked for every plaintext
        // surface, not just "main".
        hooks.detached_windows_teardown_on_lock();
        // MYND-31: wipe the plaintext-derived VaultIndices — note titles,
        // folders, tags, wikilink targets and typed property values
        // (`spec/protocol.md` §9.8.5) — and, on a `local-inference` desktop
        // build, the AI embedding vectors the same hook carries (§9.17.5).
        hooks.zeroize_vault_indices();
        // MYND-169: wipe the plaintext-derived attachment reference graph —
        // its note-ids / attachment-ids are correlation tags (AS3). On the web
        // client this same hook also revokes the object URLs that would
        // otherwise pin decrypted attachment bytes for the life of the page.
        hooks.zeroize_attachment_refs();
        // MYND-259: abort any in-progress voice recording so the mic + RAM
        // PCM buffer never survive the force-relock.
        hooks.abort_active_recording();
        // Deliberately NOT `apply_screen_capture(true, "lock_reset")`: that
        // call belongs to the manual-lock path alone (`decisions.md`
        // 2026-05-27), and the next unlock re-applies the vault's persisted
        // `vault.prefs` choice via the post-unlock pipeline.
    }

    // F1: on SUCCESS the on-disk `vault.meta` had its password-side wrap rotated
    // (root_key unchanged). Best-effort push it to the server now so a joining or
    // second device derives root_key against the NEW wrap, not the stale one —
    // otherwise the new password fails to unlock elsewhere. Non-blocking and
    // failure-tolerant: offline just leaves the `vault.meta-dirty` marker for the
    // sync loop's meta phase. Only on Ok — the force-relock / IO error paths must
    // not push a possibly-inconsistent meta. Shared core → covers desktop + mobile.
    if result.is_ok() {
        // Host-only: the post-change `vault.meta` push rides the raw-TLS sync
        // transport, which does not exist on wasm — the browser's transport is
        // `fetch` + `EventSource` (phase3-web-client task 84). Deliberately NOT
        // no-opped on the wasm arm: task 88 requires `change_password` on web to
        // be gated behind a **server-acknowledged** push, so silently skipping it
        // here would build exactly the failure that task exists to prevent.
        #[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
        let _ = crate::plugins::sync::commands::push_vault_meta_now_from_host(host, state).await;
    }
    result
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn change_password<R: Runtime>(
    current_password: String,
    new_password: String,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    app: AppHandle<R>,
) -> Result<(), VaultChangePasswordError> {
    change_password_from_host(
        current_password,
        new_password,
        state.inner(),
        hooks.inner(),
        &TauriHost::new(app),
    )
    .await
}

/// Testable core of [`change_password`]. The Tauri-command wrapper
/// resolves the platform-specific `vault.meta` path and delegates here
/// so tests do not need an [`AppHandle`].
pub(crate) async fn change_password_with_path(
    current_password: String,
    new_password: String,
    vault_path: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
) -> Result<(), VaultChangePasswordError> {
    // Wrap immediately so any early-return path drops the wrapper and
    // zeroes the bytes. Both passwords are wrapped on the FIRST non-
    // doc statement of the function body per `src-tauri/CLAUDE.md`
    // "Secret-handling logging discipline" (Zeroizing wrap +
    // spawn_blocking move idiom). Plain `String` would drop without
    // zeroize.
    let current_password = Zeroizing::new(current_password);
    let new_password = Zeroizing::new(new_password);
    let started = Instant::now();

    // (0a) Same-password reject (MYND-22 grilling Q7-α).
    //      Pre-Argon2id, pre-slot-peek, pre-permit-acquire — a same-
    //      password input must NOT consume a slot read-lock OR an
    //      auth_permits slot OR pay 2× Argon2id cost. Plain UTF-8
    //      bytes compare; Phase 1 A7 side-channel out of scope per
    //      `threat-model.md`. Saves the 2× Argon2id round-trip.
    //
    //      Ordered BEFORE the weak-pw gate so a "I copy-pasted my
    //      current into new" mistake surfaces with the more specific
    //      "Yeni parola mevcut parolayla aynı." UX message.
    if current_password.as_bytes() == new_password.as_bytes() {
        tracing::error!(
            stage = "same_password_check",
            error_kind = "SamePasswordRejected",
            "change_password rejected: new password identical to current"
        );
        return Err(VaultChangePasswordError::SamePasswordRejected);
    }

    // (0b) Weak new-password reject (MYND-22 grilling Q7-β).
    //      Backend `MIN_PASSWORD_LEN` floor — structural belt+suspenders
    //      against frontend bypass per `decisions.md` 2026-05-06
    //      "Auth-pipeline backend MIN_PASSWORD_LEN floor; project-wide
    //      retroactive". Cross-plugin shared variant name with
    //      `AppError::WeakNewPassword` and
    //      `VaultRecoveryError::WeakNewPassword`. Mapped explicitly
    //      via `if .is_err()` (not `?`-propagation) — there is no
    //      `From<ProtocolError> for VaultChangePasswordError` impl,
    //      so explicit mapping is the single-path discipline that
    //      avoids any future dual-path drift.
    if protocol::password_policy::validate_min_length(&new_password).is_err() {
        tracing::error!(
            stage = "weak_new_password",
            error_kind = "WeakNewPassword",
            "change_password rejected: new password below MIN_PASSWORD_LEN"
        );
        return Err(VaultChangePasswordError::WeakNewPassword);
    }

    // (1) Slot peek + snapshot — must be Unlocked. Slot stays
    //     Unlocked across the spawn_blocking work; the post-Argon2id
    //     re-peek (step 4) catches a mid-flight `vault_lock`.
    let (root_key_for_seal, snapshot_meta_hash) =
        match state.peek_unlocked_root_key_and_hash_clone().await {
            Some(pair) => pair,
            None => {
                tracing::error!(
                    stage = "slot_check",
                    error_kind = "VaultNotUnlocked",
                    "change_password rejected: slot is not Unlocked"
                );
                return Err(VaultChangePasswordError::VaultNotUnlocked);
            }
        };

    // (2) Acquire shared auth permit (RAII guard). Reject, never queue —
    //     `decisions.md` 2026-05-02 generalizes the "single in-flight"
    //     posture across all auth-pipeline plugins.
    let _permit = match state.auth_permits().try_acquire() {
        Ok(p) => p,
        Err(_) => {
            tracing::error!(
                stage = "permit_acquire",
                error_kind = "ChangePasswordInProgress",
                "change_password rejected: another auth op in flight"
            );
            return Err(VaultChangePasswordError::ChangePasswordInProgress);
        }
    };

    let vault_path_for_pipeline = vault_path.to_path_buf();
    let vault_path_for_write = vault_path_for_pipeline.clone();

    // (3) Run the Argon2id-bound derivation pipeline in spawn_blocking.
    //     Returns the freshly-built `new_bytes` WITHOUT writing them
    //     to disk — atomic_write is conditional on the post-Argon2id
    //     slot peek (option p, MYND-22 grilling Q4) in step (4).
    //     This split mirrors vault_recover's Task 4 restructure: if
    //     `vault_lock` fires during the Argon2id window, we bail
    //     WITHOUT touching `vault.meta`.
    let derive_outcome = crate::task::run_blocking(
        move || -> Result<[u8; protocol::VAULT_META_LEN], VaultChangePasswordError> {
            // (a) Read existing vault.meta.
            let bytes = std::fs::read(&vault_path_for_pipeline).map_err(|e| {
                let io_kind = from_io_error_kind(e.kind());
                tracing::error!(
                    stage = "read_meta",
                    error_kind = "IoError",
                    io_failure_kind = ?io_kind,
                    "vault.meta read failed during change_password"
                );
                VaultChangePasswordError::IoError {
                    io_error_kind: io_kind,
                }
            })?;

            // (a.5) Disk-level CAS check. Mismatch ⇒ vault.meta was
            //       externally mutated between unlock and this
            //       rewrite (parallel instance, disk tampering); bail
            //       and let the post-await caller force-relock.
            //       Placed BEFORE Argon2id so a mutation is detected
            //       in µs rather than after a ~1-3 s derivation.
            let disk_hash = crate::vault_meta_hash::vault_meta_sha256(&bytes);
            if disk_hash != snapshot_meta_hash {
                tracing::warn!(
                    stage = "disk_cas_check",
                    error_kind = "VaultMetaChangedExternally",
                    "disk vault.meta SHA-256 differs from slot-held snapshot — external mutation detected"
                );
                return Err(VaultChangePasswordError::VaultMetaChangedExternally);
            }

            // (b) Parse — accept a v0.1 (`MYV1`) OR a migrated v0.2 (`NTV5`)
            //     vault.meta. `version` selects the KDF salt domain, AAD prefix,
            //     `itemsKey`-wrap subkey context, and meta framing for every
            //     crypto step below so a migrated vault can change its password
            //     without leaving the v0.2 hierarchy (§10.4.1, #420). Carry the
            //     `MetaVersion` itself — the versioned protocol helpers take it
            //     directly, so nothing here reconstructs it from a bool.
            let version =
                protocol::meta_version_of(&bytes).unwrap_or(protocol::MetaVersion::V0_1);
            let existing = protocol::parse_vault_meta_any(&bytes).map_err(|e| {
                tracing::error!(
                    stage = "parse_meta",
                    error_kind = "InvalidVaultMeta",
                    protocol_error_kind = protocol_error_kind(&e),
                    "vault.meta parse failed during change_password"
                );
                VaultChangePasswordError::InvalidVaultMeta
            })?;

            // (c) Current-password verify via AEAD-tag-verify success
            //     (MYND-22 grilling Q2 — `decisions.md` 2026-05-06
            //     entry "Naming-discipline > scenario-optimization").
            //     Re-derive `password_wrap_key` under the existing
            //     salt + KDF params, then `aead_open_ctx` against
            //     `enc_root_key_password`. The AEAD-tag check is the
            //     proof; the decrypted bytes are dropped immediately
            //     (slot.root_key is the truth). `Err(AeadFailure)`
            //     → `InvalidCredentialOrVault` per the cross-plugin
            //     shared-name discipline; any other ProtocolError
            //     surfaces as `InvalidVaultMeta`.
            protocol::validate_kdf_params(&existing.kdf_params).map_err(|e| {
                tracing::error!(
                    stage = "kdf_params_range",
                    error_kind = "InvalidVaultMeta",
                    protocol_error_kind = protocol_error_kind(&e),
                    "kdf params outside accepted range"
                );
                VaultChangePasswordError::InvalidVaultMeta
            })?;

            let current_wrap_key = if version == protocol::MetaVersion::V0_2 {
                protocol::derive_password_wrap_key_v0_2(
                    &current_password,
                    &existing.random_salt_password,
                    &existing.account_number_hash,
                    &existing.kdf_params,
                )
            } else {
                protocol::derive_password_wrap_key(
                    &current_password,
                    &existing.random_salt_password,
                    &existing.account_number_hash,
                    &existing.kdf_params,
                )
            }
            .map_err(|e| {
                tracing::error!(
                    stage = "current_password_verify",
                    error_kind = "InvalidVaultMeta",
                    protocol_error_kind = protocol_error_kind(&e),
                    "current-password Argon2id derivation failed"
                );
                VaultChangePasswordError::InvalidVaultMeta
            })?;
            let aad = if version == protocol::MetaVersion::V0_2 {
                protocol::aad_password_wrap_v0_2(&existing.kdf_params)
            } else {
                protocol::aad_password_wrap(&existing.kdf_params)
            };
            let opened = protocol::aead_open_ctx(
                &current_wrap_key,
                &existing.nonce_password_wrap,
                &existing.enc_root_key_password,
                &aad,
            )
            .map_err(|e| match e {
                protocol::ProtocolError::AeadFailure => {
                    tracing::error!(
                        stage = "current_password_verify",
                        error_kind = "InvalidCredentialOrVault",
                        "current-password AEAD-open failed (wrong pw OR tampered password section)"
                    );
                    VaultChangePasswordError::InvalidCredentialOrVault
                }
                other => {
                    tracing::error!(
                        stage = "current_password_verify",
                        error_kind = "InvalidVaultMeta",
                        protocol_error_kind = protocol_error_kind(&other),
                        "current-password AEAD-open returned non-AEAD ProtocolError"
                    );
                    VaultChangePasswordError::InvalidVaultMeta
                }
            })?;
            // The opened bytes are not the truth — slot.root_key is.
            // Drop the decrypted output explicitly (Zeroize wipes).
            drop(opened);

            // (c.5) Items_key wrap verify — POST-derivation
            //       structural-integrity check. After the current-
            //       password wrap-key has AEAD-verified, also verify
            //       that the singleton `enc_items_key` blob in
            //       vault.meta decrypts cleanly under the
            //       `items_key_wrap_key = derive_subkey(root_key,
            //       ItemsKeyWrap)`. A failure here means the items_key
            //       wrap section is corrupt or tampered EVEN THOUGH
            //       the password section is intact — surfaces as
            //       `InvalidVaultMeta`, NOT `InvalidCredentialOrVault`
            //       (which would falsely accuse the password). Single
            //       user-facing CTA "vault file is unreadable" per
            //       MYND-22 grilling Q6(b) + `decisions.md` 2026-05-02
            //       "Phase 1 unlock error discipline" (post-derivation
            //       items_key wrap failure → InvalidVaultMeta), now
            //       extended to vault_change_password.
            //
            //       The decrypted items_key bytes are dropped
            //       immediately — slot.items_key is the truth (the
            //       cloned root_key + slot's items_key are both held
            //       in memory; this verify only confirms vault.meta's
            //       wrap is consistent with our memory state).
            let items_key_wrap_key = protocol::derive_subkey_versioned(
                version,
                &root_key_for_seal,
                protocol::SubkeyRole::ItemsKeyWrap,
            );
            let aad_items = if version == protocol::MetaVersion::V0_2 {
                protocol::aad_vault_items_key_wrap_v0_2(&existing.items_key_id)
            } else {
                protocol::aad_vault_items_key_wrap(&existing.items_key_id)
            };
            let items_opened = protocol::aead_open_ctx(
                &items_key_wrap_key,
                &existing.items_key_nonce,
                &existing.enc_items_key,
                &aad_items,
            )
            .map_err(|e| {
                tracing::error!(
                    stage = "items_key_wrap_verify",
                    error_kind = "InvalidVaultMeta",
                    protocol_error_kind = protocol_error_kind(&e),
                    "items_key wrap AEAD-open failed POST current-password verify"
                );
                VaultChangePasswordError::InvalidVaultMeta
            })?;
            drop(items_opened);

            // (d) Sample fresh CSPRNG salt + nonce for the new
            //     password-side wrap.
            let mut fresh_salt = [0u8; ARGON2_SALT_LEN];
            getrandom::getrandom(&mut fresh_salt).map_err(|_| {
                tracing::error!(
                    stage = "csprng_salt_nonce",
                    error_kind = "IoError",
                    "OS CSPRNG failed for fresh password salt"
                );
                VaultChangePasswordError::IoError {
                    io_error_kind: IoFailureKind::Other,
                }
            })?;
            let mut fresh_nonce = [0u8; AEAD_NONCE_LEN];
            getrandom::getrandom(&mut fresh_nonce).map_err(|_| {
                tracing::error!(
                    stage = "csprng_salt_nonce",
                    error_kind = "IoError",
                    "OS CSPRNG failed for fresh password nonce"
                );
                VaultChangePasswordError::IoError {
                    io_error_kind: IoFailureKind::Other,
                }
            })?;

            // (e) Build new vault.meta bytes via the protocol-crate
            //     primitive. Recovery-side + items_key wrap byte-
            //     preserved per `recovery-flow.md` §4.4 — the helper
            //     enforces the invariant internally.
            let new_bytes = protocol::rewrite_vault_meta_password_side_versioned(
                version,
                &existing,
                &root_key_for_seal,
                &new_password,
                &fresh_salt,
                &fresh_nonce,
            )
            .map_err(|e| {
                tracing::error!(
                    stage = "vault_meta_rewrite",
                    error_kind = "InvalidVaultMeta",
                    protocol_error_kind = protocol_error_kind(&e),
                    "vault.meta rewrite failed during change_password"
                );
                VaultChangePasswordError::InvalidVaultMeta
            })?;

            // Atomic write + SHA-256 are deferred to spawn_blocking 2
            // (after the post-Argon2id slot peek). If `vault_lock`
            // fired during the Argon2id window above, the slot is now
            // `Empty` and we bail with `VaultLockedDuringChange`
            // WITHOUT touching `vault.meta` — the (p) checkpoint per
            // MYND-22 grilling Q4.
            Ok(new_bytes)
        },
    )
    .await;

    // The Zeroizing<String> wrappers + the cloned root_key were moved
    // into spawn_blocking 1; on closure exit (success or error) the
    // bytes wipe via Drop.

    let new_bytes = match derive_outcome {
        Ok(Ok(b)) => b,
        Ok(Err(VaultChangePasswordError::InvalidVaultMeta)) => {
            // Force-relock per MYND-22 grilling Q6(b) +
            // `decisions.md` 2026-05-06 entry "InvalidVaultMeta posture".
            // TRANSITIONAL (sub-feature 2): drop the active vault entry.
            if let Some(id) = state.active_vault_or_recovering_for_probe().await {
                // MYND-205: drop the per-session decrypted label + icon on the
                // SAME force-relock path as the slot, exactly as
                // `lock_with_state` does — a relocked vault must stop
                // surfacing its real name / glyph in the switcher (SYNC-3).
                // It has to happen HERE rather than beside the teardown hooks
                // in `change_password_from_host`: once `take` has run the slot
                // is `Empty`, `active_vault_or_recovering_for_probe` returns
                // `None`, and the id is no longer recoverable.
                state.evict_cached_label(id).await;
                state.evict_cached_icon(id).await;
                let _prior = state.take(id).await;
            }
            tracing::warn!(
                stage = "force_relock_on_invalid_vault_meta",
                error_kind = "InvalidVaultMeta",
                "vault.meta integrity failure during change_password; slot dropped to Empty"
            );
            return Err(VaultChangePasswordError::InvalidVaultMeta);
        }
        Ok(Err(VaultChangePasswordError::VaultMetaChangedExternally)) => {
            // Force-relock per MYND-22 grilling Q3 + `decisions.md`
            // 2026-05-06 entry "CAS mismatch posture: force-relock".
            // TRANSITIONAL (sub-feature 2): drop the active vault entry.
            if let Some(id) = state.active_vault_or_recovering_for_probe().await {
                // MYND-205: same label + icon eviction as the
                // `InvalidVaultMeta` arm above, and for the same reason —
                // before the `take`, while the id is still resolvable.
                state.evict_cached_label(id).await;
                state.evict_cached_icon(id).await;
                let _prior = state.take(id).await;
            }
            tracing::warn!(
                stage = "force_relock_on_cas_mismatch",
                error_kind = "VaultMetaChangedExternally",
                "disk CAS mismatch during change_password; slot dropped to Empty"
            );
            return Err(VaultChangePasswordError::VaultMetaChangedExternally);
        }
        Ok(Err(inner)) => return Err(inner),
        Err(_) => {
            tracing::error!(
                stage = "spawn_blocking_join",
                error_kind = "JoinFailure",
                "blocking derivation task join failed during change_password"
            );
            return Err(VaultChangePasswordError::JoinFailure);
        }
    };

    // (4) Post-Argon2id commit under a single write-lock critical
    //     section: verify slot is still `Slot::Unlocked` with the
    //     snapshot hash, run atomic_write + sha256 in spawn_blocking
    //     (lock held across the .await), then update slot's hash
    //     anchor — all atomic vs `vault_lock`. This closes the µs
    //     gap that an earlier "release lock → spawn_blocking →
    //     re-lock" pattern left open. See `decisions.md` 2026-05-06
    //     "post-Argon2id slot peek (option p)" + the C1 fix entry.
    use super::super::vault_unlock::state::CommitRewriteError;
    match state
        .commit_unlocked_rewrite(snapshot_meta_hash, move || {
            crate::atomic_write::atomic_write(&vault_path_for_write, &new_bytes, true).map_err(
                |e| {
                    let io_kind = from_io_error_kind(e.kind());
                    tracing::error!(
                        stage = "atomic_write",
                        error_kind = "IoError",
                        io_failure_kind = ?io_kind,
                        "atomic write of new vault.meta failed during change_password"
                    );
                    VaultChangePasswordError::IoError {
                        io_error_kind: io_kind,
                    }
                },
            )?;
            Ok(crate::vault_meta_hash::vault_meta_sha256(&new_bytes))
        })
        .await
    {
        Ok(()) => {}
        Err(CommitRewriteError::HashMismatch) => {
            // Helper already dropped the slot to Empty.
            tracing::warn!(
                stage = "post_argon2id_slot_peek",
                error_kind = "VaultMetaChangedExternally",
                "slot hash drift detected post-Argon2id (defensive bail)"
            );
            return Err(VaultChangePasswordError::VaultMetaChangedExternally);
        }
        Err(CommitRewriteError::SlotDropped) => {
            // Slot was Empty/Recovering at the post-Argon2id check;
            // closure did NOT run, vault.meta untouched. Slot stays
            // as it was.
            tracing::warn!(
                stage = "post_argon2id_slot_peek",
                error_kind = "VaultLockedDuringChange",
                "vault_lock fired mid-Argon2id during change_password; bailed without disk write"
            );
            return Err(VaultChangePasswordError::VaultLockedDuringChange);
        }
        Err(CommitRewriteError::Rewrite(inner)) => return Err(inner),
        Err(CommitRewriteError::Join) => {
            tracing::error!(
                stage = "spawn_blocking_join",
                error_kind = "JoinFailure",
                "blocking write task join failed during change_password"
            );
            return Err(VaultChangePasswordError::JoinFailure);
        }
    };

    // Success event. Coarse `duration_ms` only — no account
    // identifier, no path, no key material. Per ALLOW-list in
    // `src-tauri/CLAUDE.md` "Secret-handling logging discipline".
    // `duration_ms` rounded down to 10ms granularity per
    // `decisions.md` 2026-05-06 "Tracing event-name pattern" entry —
    // future-ready timing-channel resistance (Phase 1 A7 side-channel
    // out of scope, but the discipline costs ~zero today).
    // Event name `vault_password_changed` follows the project-wide
    // `vault_<verb_past>` discipline alongside vault_unlocked,
    // vault_locked, vault_recovered_with_phrase, vault_recovery_completed.
    let now = Instant::now();
    tracing::info!(
        event = "vault_password_changed",
        duration_ms = (now.duration_since(started).as_millis() / 10 * 10) as u64,
        "vault password rotated successfully (root_key unchanged; only its wrap rotated)"
    );

    // MYND-329 task 8: a password change invalidates any quick-unlock credential
    // for this vault (defense-in-depth — a password change signals "reset my
    // access", User Story 8). Best-effort; absence of a credential is a no-op.
    if let Some(vault_dir) = vault_path.parent() {
        hooks.invalidate_quick_unlock(vault_dir);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::test_host::TestHost;
    use crate::plugins::vault_creation::commands::{build_and_serialize_vault_meta, build_session};
    use crate::plugins::vault_recover::commands::recover_with_phrase_with_path;
    use crate::plugins::vault_unlock::commands::unlock_with_path;
    use crate::plugins::vault_unlock::state::{test_vault_id, SlotKind};
    use crate::test_support::{RecordingHooks, ScopedTempDir, ScratchVault, FAST_TEST_KDF};

    /// No-op lifecycle hooks for the `_with_path` core tests — the
    /// quick-unlock-invalidation side-effect (desktop-only) is exercised by the
    /// desktop `quick_unlock` plugin's own tests, not asserted here.
    fn noop_hooks() -> crate::hooks::Hooks {
        std::sync::Arc::new(crate::hooks::NoopHooks)
    }

    /// Same per-test runtime pattern as the sibling plugins. Builds a
    /// current-thread tokio runtime each test (no `#[tokio::test]` —
    /// the `tokio = ["macros"]` feature is intentionally NOT enabled
    /// per workspace TB9 audit-anchor discipline; tests build the
    /// runtime manually via `block_on`).
    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    fn scratch_vault() -> ScratchVault {
        ScratchVault::new("change_password_test")
    }

    /// Build a real vault.meta via `vault_creation::build_session`,
    /// write it to the scratch path, run `vault_unlock_with_path` to
    /// populate `Slot::Unlocked`, and return all the artefacts the
    /// downstream tests need: state, scratch, original password,
    /// recovery phrase (for the recovery-still-works test), original
    /// vault.meta bytes (for byte-equal pre/post diffs).
    async fn seed_unlocked_state(
        password: &str,
    ) -> (
        VaultRuntimeState,
        ScratchVault,
        String,
        String,
        [u8; protocol::VAULT_META_LEN],
    ) {
        let scratch = scratch_vault();
        let session = build_session(crate::vault_id::VaultId::mint(), password, FAST_TEST_KDF)
            .expect("build_session");
        let phrase_string: String = (*session.phrase.join_normalized()).to_string();
        let meta_bytes = build_and_serialize_vault_meta(&session).expect("serialize vault.meta");
        scratch.write_meta(&meta_bytes);

        let state = VaultRuntimeState::default();
        unlock_with_path(
            password.to_string(),
            None,
            scratch.path(),
            &state,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("seed: vault_unlock must succeed against the seeded vault");
        assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Unlocked);

        (
            state,
            scratch,
            password.to_string(),
            phrase_string,
            meta_bytes,
        )
    }

    /// Seed an unlocked vault laid out the way [`change_password_from_host`]
    /// resolves it — `<app-data>/vaults/<id>/vault.meta` — instead of at the
    /// bare [`ScratchVault`] path the `_with_path` tests use. The teardown-hook
    /// block lives in `change_password_from_host`, which resolves its own path,
    /// so a test that observes those hooks cannot go through
    /// `change_password_with_path`.
    ///
    /// Returns the scratch base (the caller must keep it alive — its `Drop`
    /// removes the tree), the host, the state, the vault id and the resolved
    /// `vault.meta` path.
    async fn seed_unlocked_state_under_host(
        password: &str,
    ) -> (
        ScopedTempDir,
        TestHost,
        VaultRuntimeState,
        crate::vault_id::VaultId,
        PathBuf,
    ) {
        let base = ScopedTempDir::new("change_password_hooks").expect("scratch base");
        let host = TestHost::new(base.path());
        let id = crate::vault_id::VaultId::mint();
        let root = crate::paths::vault_root_for_id_from_base(
            &host.app_data_dir().expect("test host app_data_dir"),
            id,
        );
        std::fs::create_dir_all(&root).expect("create vault root");

        let session = build_session(id, password, FAST_TEST_KDF).expect("build_session");
        let meta_bytes = build_and_serialize_vault_meta(&session).expect("serialize vault.meta");
        let meta_path = root.join("vault.meta");
        std::fs::write(&meta_path, meta_bytes).expect("write vault.meta");

        let state = VaultRuntimeState::default();
        unlock_with_path(
            password.to_string(),
            Some(id),
            &meta_path,
            &state,
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("seed: vault_unlock must succeed against the seeded vault");
        assert_eq!(state.slot_kind(id).await, SlotKind::Unlocked);

        (base, host, state, id, meta_path)
    }

    use crate::vault_meta_hash::vault_meta_sha256 as sha256;

    /// The sibling of `vault_recover`'s
    /// `complete_recovery_invalidates_the_quick_unlock_credential`.
    ///
    /// This wiring has shipped since MYND-329 and nothing asserted it: the
    /// `_with_path` tests pass `noop_hooks()`, and `RecordingHooks` leaves
    /// `invalidate_quick_unlock` an unrecorded no-op — so deleting the call
    /// would have kept the suite green. `protocol.md` §9.14.4 makes the
    /// deletion mandatory on every credential rotation, and "mandatory" needs
    /// a test on each rotation path, not on one.
    #[test]
    fn change_password_invalidates_the_quick_unlock_credential() {
        rt().block_on(async {
            let (state, scratch, _orig_pw, _phrase, _orig_bytes) =
                seed_unlocked_state("orig-password-12").await;
            let counter = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
            let watch = std::sync::Arc::new(crate::hooks::test_hooks::CountingHooks::new(
                counter.clone(),
            ));
            let hooks: crate::hooks::Hooks = watch.clone();

            change_password_with_path(
                "orig-password-12".to_string(),
                "new-password-12".to_string(),
                scratch.path(),
                &state,
                &hooks,
            )
            .await
            .expect("change_password happy path");

            let seen = watch.quick_unlock_invalidations();
            assert_eq!(seen.len(), 1, "a rotation must invalidate exactly once");
            assert_eq!(
                seen[0],
                scratch.path().parent().expect("vault dir"),
                "the hook receives the vault ROOT, not the vault.meta path"
            );
        });
    }

    /// A rejected rotation must not destroy a working credential.
    #[test]
    fn a_rejected_change_password_leaves_the_quick_unlock_credential_alone() {
        rt().block_on(async {
            let (state, scratch, _orig_pw, _phrase, _orig_bytes) =
                seed_unlocked_state("orig-password-12").await;
            let counter = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
            let watch = std::sync::Arc::new(crate::hooks::test_hooks::CountingHooks::new(
                counter.clone(),
            ));
            let hooks: crate::hooks::Hooks = watch.clone();

            let result = change_password_with_path(
                "wrong-current-pw".to_string(),
                "new-password-12".to_string(),
                scratch.path(),
                &state,
                &hooks,
            )
            .await;

            assert!(result.is_err(), "the current password is wrong");
            assert!(
                watch.quick_unlock_invalidations().is_empty(),
                "a refused rotation must not touch the credential"
            );
        });
    }

    /// Q2 + Q1 happy path: unlock with A → change_password(A→B) →
    /// vault_lock → unlock(A) returns InvalidCredentialOrVault;
    /// unlock(B) returns Ok.
    #[test]
    fn change_password_happy_path() {
        rt().block_on(async {
            let (state, scratch, _orig_pw, _phrase, _orig_bytes) =
                seed_unlocked_state("orig-password-12").await;

            // Sanity: slot is Unlocked with a populated meta hash.
            let initial_hash = state
                .peek_unlocked_root_key_and_hash_clone()
                .await
                .expect("seed left slot Unlocked")
                .1;
            assert_ne!(initial_hash, [0u8; 32]);

            change_password_with_path(
                "orig-password-12".to_string(),
                "new-password-12".to_string(),
                scratch.path(),
                &state,
                &noop_hooks(),
            )
            .await
            .expect("change_password happy path");

            // Slot stays Unlocked (root_key NOT rotated; only the wrap
            // is rotated). Verify by re-peeking.
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Unlocked);
            let post_hash = state
                .peek_unlocked_root_key_and_hash_clone()
                .await
                .expect("slot still Unlocked")
                .1;
            // Slot's hash anchor was updated to match the new disk state.
            let new_disk_bytes = std::fs::read(scratch.path()).expect("vault.meta exists");
            assert_eq!(
                post_hash,
                sha256(&new_disk_bytes),
                "slot.vault_meta_bytes_hash must equal SHA-256 of the rewritten vault.meta"
            );
            // And it MUST NOT equal the pre-change hash.
            assert_ne!(
                post_hash, initial_hash,
                "slot hash must reflect the post-rewrite disk state"
            );

            // Lock and re-unlock with old + new passwords.
            let _ = state.take(test_vault_id()).await; // simulate vault_lock
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);

            // Old password no longer unlocks.
            let result_old = unlock_with_path(
                "orig-password-12".to_string(),
                None,
                scratch.path(),
                &state,
            &crate::vault_io::StdVaultIo, &crate::host::NoopHost,)
            .await;
            assert!(
                matches!(
                    result_old,
                    Err(crate::plugins::vault_unlock::error::VaultUnlockError::InvalidCredentialOrVault)
                ),
                "old password must NOT unlock after change; got {result_old:?}"
            );

            // New password unlocks.
            unlock_with_path("new-password-12".to_string(), None, scratch.path(), &state, &crate::vault_io::StdVaultIo, &crate::host::NoopHost)
                .await
                .expect("new password must unlock the rewritten vault");
        });
    }

    /// Recovery phrase must still recover the vault after change_password
    /// (Q1 + recovery-flow.md §4.4 — recovery-side byte-preserved
    /// across the rewrite).
    #[test]
    fn change_password_recovery_phrase_still_works() {
        rt().block_on(async {
            let (state, scratch, _orig_pw, phrase, _orig_bytes) =
                seed_unlocked_state("orig-password-12").await;

            change_password_with_path(
                "orig-password-12".to_string(),
                "new-password-12".to_string(),
                scratch.path(),
                &state,
                &noop_hooks(),
            )
            .await
            .expect("change_password");

            // Lock and recover via phrase.
            let _ = state.take(test_vault_id()).await;
            recover_with_phrase_with_path(
                phrase,
                None,
                scratch.path(),
                &state,
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            )
            .await
            .expect("recovery phrase must still work after change_password");
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Recovering);
        });
    }

    /// Recovery-side fields and items_key wrap byte-equal pre/post
    /// the change_password rewrite (recovery-flow §4.4 invariant).
    /// Spec § 9.3 offsets:
    ///   49..65    random_salt_recovery (16 bytes)
    ///   153..177  nonce_recovery_wrap (24 bytes)
    ///   177..241  enc_root_key_recovery (64 bytes)
    ///   241..345  items_key_id + items_key_nonce + enc_items_key (104 bytes)
    #[test]
    fn change_password_preserves_recovery_side_byte_byte() {
        rt().block_on(async {
            let (state, scratch, _orig_pw, _phrase, orig_bytes) =
                seed_unlocked_state("orig-password-12").await;

            change_password_with_path(
                "orig-password-12".to_string(),
                "new-password-12".to_string(),
                scratch.path(),
                &state,
                &noop_hooks(),
            )
            .await
            .expect("change_password");

            let new_bytes = std::fs::read(scratch.path()).expect("vault.meta exists");
            assert_eq!(
                new_bytes.len(),
                protocol::VAULT_META_LEN,
                "rewritten vault.meta must be the canonical 345 bytes"
            );
            assert_eq!(
                &new_bytes[49..65],
                &orig_bytes[49..65],
                "random_salt_recovery @ 49..65 must byte-equal original"
            );
            assert_eq!(
                &new_bytes[153..177],
                &orig_bytes[153..177],
                "nonce_recovery_wrap @ 153..177 must byte-equal original"
            );
            assert_eq!(
                &new_bytes[177..241],
                &orig_bytes[177..241],
                "enc_root_key_recovery @ 177..241 must byte-equal original"
            );
            assert_eq!(
                &new_bytes[241..345],
                &orig_bytes[241..345],
                "items_key_id + items_key_nonce + enc_items_key @ 241..345 must byte-equal original"
            );

            // The two identity/parameter fields task 88 adds to this invariant.
            // They are not "recovery-side", which is why they were not covered
            // above — and they are exactly the fields whose silent drift would
            // be worst:
            //
            //   * `account_number_hash` is bound into the password-wrap AAD, so
            //     rewriting it would make the vault un-openable by the very
            //     password the user just set, with no error until next unlock.
            //   * `kdf_params` govern how expensive that unlock is. A rewrite
            //     that "helpfully" normalised them to the current default would
            //     silently re-parameterise an existing vault — a cross-version
            //     change wearing a password change's clothes.
            //
            // Both must survive a rotation byte-for-byte.
            assert_eq!(
                &new_bytes[6..22],
                &orig_bytes[6..22],
                "account_number_hash @ 6..22 must byte-equal original"
            );
            assert_eq!(
                &new_bytes[22..33],
                &orig_bytes[22..33],
                "kdf_params_canonical @ 22..33 must byte-equal original"
            );
            // And the bytes that are not struct fields at all: magic, protocol
            // version, reserved. A rotation is not a format event.
            assert_eq!(
                &new_bytes[0..6],
                &orig_bytes[0..6],
                "magic + protocol_version + reserved @ 0..6 must byte-equal original"
            );

            // Password-side fields MUST differ (fresh CSPRNG).
            assert_ne!(
                &new_bytes[33..49],
                &orig_bytes[33..49],
                "random_salt_password @ 33..49 must change"
            );
            assert_ne!(
                &new_bytes[65..89],
                &orig_bytes[65..89],
                "nonce_password_wrap @ 65..89 must change"
            );
            assert_ne!(
                &new_bytes[89..153],
                &orig_bytes[89..153],
                "enc_root_key_password @ 89..153 must change"
            );

            // Stated as a partition rather than a list of ranges, so a future
            // field added anywhere in the 345 bytes lands in one side or the
            // other rather than in neither. The preserved set is everything
            // except the password-side window [33..49) ∪ [65..153).
            let preserved_differs: Vec<usize> = (0..protocol::VAULT_META_LEN)
                .filter(|&i| !((33..49).contains(&i) || (65..153).contains(&i)))
                .filter(|&i| new_bytes[i] != orig_bytes[i])
                .collect();
            assert!(
                preserved_differs.is_empty(),
                "a password rotation touched bytes outside the password-side \
                 window: {preserved_differs:?}"
            );
        });
    }

    /// Wrong current password → InvalidCredentialOrVault. Slot stays
    /// Unlocked (Task 8 has no force-relock yet — Task 11 will add
    /// force-relock on CAS mismatch); disk untouched.
    #[test]
    fn change_password_wrong_current_password() {
        rt().block_on(async {
            let (state, scratch, _orig_pw, _phrase, orig_bytes) =
                seed_unlocked_state("orig-password-12").await;

            let result = change_password_with_path(
                "WRONG-pw-1234".to_string(),
                "new-password-12".to_string(),
                scratch.path(),
                &state,
                &noop_hooks(),
            )
            .await;

            assert!(
                matches!(
                    result,
                    Err(VaultChangePasswordError::InvalidCredentialOrVault)
                ),
                "expected InvalidCredentialOrVault, got {result:?}"
            );

            // Disk untouched.
            let after_bytes = std::fs::read(scratch.path()).expect("vault.meta exists");
            assert_eq!(
                &after_bytes[..],
                &orig_bytes[..],
                "vault.meta must be unchanged on InvalidCredentialOrVault"
            );

            // Slot still Unlocked (Task 8 scope; Task 11 introduces
            // force-relock on CAS mismatch — different failure class).
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Unlocked);

            // Permit released.
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }

    /// Slot is Empty → VaultNotUnlocked (router-bug guard).
    #[test]
    fn change_password_rejects_when_slot_empty() {
        rt().block_on(async {
            let scratch = scratch_vault();
            let state = VaultRuntimeState::default();
            // No unlock call — slot is Empty.
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);

            let result = change_password_with_path(
                "orig-password-12".to_string(),
                "new-password-12".to_string(),
                scratch.path(),
                &state,
                &noop_hooks(),
            )
            .await;
            assert!(
                matches!(result, Err(VaultChangePasswordError::VaultNotUnlocked)),
                "expected VaultNotUnlocked, got {result:?}"
            );
            // Permit released.
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }

    /// Slot is Recovering → VaultNotUnlocked (only Slot::Unlocked
    /// permits change_password per the PRD).
    #[test]
    fn change_password_rejects_when_slot_recovering() {
        use crate::plugins::vault_unlock::state::fixture_recovering_with_keys;
        rt().block_on(async {
            let scratch = scratch_vault();
            let state = VaultRuntimeState::default();
            state
                .set_recovering(
                    test_vault_id(),
                    fixture_recovering_with_keys(0xAA, 0xBB, 0xCC),
                )
                .await;
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Recovering);

            let result = change_password_with_path(
                "orig-password-12".to_string(),
                "new-password-12".to_string(),
                scratch.path(),
                &state,
                &noop_hooks(),
            )
            .await;
            assert!(
                matches!(result, Err(VaultChangePasswordError::VaultNotUnlocked)),
                "expected VaultNotUnlocked, got {result:?}"
            );
            // Slot still Recovering (rejection is non-mutative).
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Recovering);
        });
    }

    /// Q7-α: same-password input rejected pre-Argon2id, pre-permit-
    /// acquire, pre-slot-peek. Disk untouched; runtime proves
    /// Argon2id NOT invoked.
    #[test]
    fn change_password_same_password_rejected() {
        rt().block_on(async {
            let (state, scratch, _orig_pw, _phrase, orig_bytes) =
                seed_unlocked_state("orig-password-12").await;

            let started = std::time::Instant::now();
            let result = change_password_with_path(
                "orig-password-12".to_string(),
                "orig-password-12".to_string(),
                scratch.path(),
                &state,
                &noop_hooks(),
            )
            .await;
            let elapsed = started.elapsed();

            assert!(
                matches!(result, Err(VaultChangePasswordError::SamePasswordRejected)),
                "expected SamePasswordRejected, got {result:?}"
            );

            // Disk byte-equal to the original — atomic_write never fired.
            let after_bytes = std::fs::read(scratch.path()).expect("vault.meta exists");
            assert_eq!(
                &after_bytes[..],
                &orig_bytes[..],
                "vault.meta must be unchanged on SamePasswordRejected"
            );

            // Slot still Unlocked — gate fires before slot-mutating paths.
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Unlocked);

            // Permit released — gate fires before permit acquire.
            assert_eq!(state.auth_permits().available_permits(), 1);

            // Sanity: rejection is fast — proves Argon2id was NOT invoked.
            // Even with FAST_TEST_KDF, Argon2id × 2 + IO would push the
            // happy path well above this threshold.
            assert!(
                elapsed.as_millis() < 200,
                "same-password reject must be sub-Argon2id fast; got {}ms",
                elapsed.as_millis()
            );
        });
    }

    /// Q7-β: weak-new-password input rejected pre-Argon2id, pre-permit-
    /// acquire, pre-slot-peek. Sub-`MIN_PASSWORD_LEN` (12 chars) inputs
    /// surface as `WeakNewPassword`. Disk untouched; runtime proves
    /// Argon2id NOT invoked.
    #[test]
    fn change_password_weak_new_password_rejected() {
        rt().block_on(async {
            let (state, scratch, _orig_pw, _phrase, orig_bytes) =
                seed_unlocked_state("orig-password-12").await;

            // 11 chars — below MIN_PASSWORD_LEN of 12.
            let weak_new = "a".repeat(11);
            let started = std::time::Instant::now();
            let result = change_password_with_path(
                "orig-password-12".to_string(),
                weak_new,
                scratch.path(),
                &state,
                &noop_hooks(),
            )
            .await;
            let elapsed = started.elapsed();

            assert!(
                matches!(result, Err(VaultChangePasswordError::WeakNewPassword)),
                "expected WeakNewPassword, got {result:?}"
            );

            // Disk byte-equal to the original.
            let after_bytes = std::fs::read(scratch.path()).expect("vault.meta exists");
            assert_eq!(
                &after_bytes[..],
                &orig_bytes[..],
                "vault.meta must be unchanged on WeakNewPassword"
            );

            // Slot still Unlocked.
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Unlocked);

            // Permit released.
            assert_eq!(state.auth_permits().available_permits(), 1);

            // Sanity: rejection is fast.
            assert!(
                elapsed.as_millis() < 200,
                "weak-new-password reject must be sub-Argon2id fast; got {}ms",
                elapsed.as_millis()
            );
        });
    }

    /// Q1 — External mutation to `vault.meta` (in this case a magic-
    /// byte flip) is detected by the disk-level CAS check (Task 11)
    /// BEFORE the crypto pipeline runs. Surfaces as
    /// `VaultMetaChangedExternally` and force-relocks the slot.
    ///
    /// **Note**: Pre-Task-11 this test was named
    /// `change_password_invalid_vault_meta_pre_derivation` and
    /// expected `InvalidVaultMeta` (parse failure). With Task 11's
    /// CAS in place, external mutation is caught at the CAS layer
    /// FIRST — the parse path is now structurally unreachable for
    /// this scenario (and similarly for the items_key wrap path
    /// below). The InvalidVaultMeta variant remains in the code
    /// (defense in depth, runs inside spawn_blocking after CAS) but
    /// integration coverage via external mutation is now subsumed
    /// by VaultMetaChangedExternally — a more specific + more
    /// useful classification.
    #[test]
    fn change_password_external_magic_byte_corruption_caught_by_cas() {
        rt().block_on(async {
            let (state, scratch, _orig_pw, _phrase, _orig_bytes) =
                seed_unlocked_state("orig-password-12").await;

            // Corrupt the magic bytes (offset 0..4 = "MYV1").
            let mut corrupted_bytes =
                std::fs::read(scratch.path()).expect("vault.meta exists for corruption");
            corrupted_bytes[0] = corrupted_bytes[0].wrapping_add(1);
            std::fs::write(scratch.path(), &corrupted_bytes).expect("write corrupted vault.meta");

            let result = change_password_with_path(
                "orig-password-12".to_string(),
                "new-password-12".to_string(),
                scratch.path(),
                &state,
                &noop_hooks(),
            )
            .await;

            // CAS catches the byte difference BEFORE parse runs.
            assert!(
                matches!(
                    result,
                    Err(VaultChangePasswordError::VaultMetaChangedExternally)
                ),
                "expected VaultMetaChangedExternally (CAS catches external mutation pre-parse), got {result:?}"
            );

            // Force-relock: slot dropped to Empty.
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);
            assert_eq!(state.auth_permits().available_permits(), 1);

            // Disk untouched (atomic_write never fired).
            let after_bytes = std::fs::read(scratch.path()).expect("vault.meta exists");
            assert_eq!(after_bytes[0], corrupted_bytes[0]);
        });
    }

    /// Q1 — External mutation to the items_key wrap section is
    /// caught by the disk-level CAS check (Task 11) before the
    /// items_key wrap verify runs. Same Task-11 semantic as the
    /// magic-byte test above.
    #[test]
    fn change_password_external_items_key_nonce_corruption_caught_by_cas() {
        rt().block_on(async {
            let (state, scratch, _orig_pw, _phrase, _orig_bytes) =
                seed_unlocked_state("orig-password-12").await;

            let mut corrupted_bytes =
                std::fs::read(scratch.path()).expect("vault.meta exists for corruption");
            corrupted_bytes[260] = corrupted_bytes[260].wrapping_add(1);
            std::fs::write(scratch.path(), &corrupted_bytes).expect("write corrupted vault.meta");

            let result = change_password_with_path(
                "orig-password-12".to_string(),
                "new-password-12".to_string(),
                scratch.path(),
                &state,
                &noop_hooks(),
            )
            .await;

            assert!(
                matches!(
                    result,
                    Err(VaultChangePasswordError::VaultMetaChangedExternally)
                ),
                "expected VaultMetaChangedExternally (CAS catches external mutation), got {result:?}"
            );
            // Crucially NOT InvalidCredentialOrVault — the password
            // wasn't even attempted; CAS fired first.
            assert!(!matches!(
                result,
                Err(VaultChangePasswordError::InvalidCredentialOrVault)
            ));

            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);

            let after_bytes = std::fs::read(scratch.path()).expect("vault.meta exists");
            assert_eq!(after_bytes[260], corrupted_bytes[260]);
        });
    }

    /// Q1 — Disk-level CAS catches external mutation. This test
    /// uses a SEPARATE valid vault (different password's salts/
    /// nonces) overwriting the seeded vault.meta. CAS fires at the
    /// disk-hash mismatch level — even though the replacement is
    /// itself a structurally valid vault.meta. Force-relocks.
    #[test]
    fn change_password_cas_mismatch_external_mutate() {
        rt().block_on(async {
            let (state, scratch, _orig_pw, _phrase, _orig_bytes) =
                seed_unlocked_state("orig-password-12").await;

            // Build a SECOND, different valid vault.meta and overwrite
            // the disk. The disk now holds a parseable vault.meta but
            // its bytes (and SHA-256) differ from the slot's snapshot.
            // This simulates a parallel app instance committing a
            // competing rewrite while our session was idle.
            let other_session = build_session(
                crate::vault_id::VaultId::mint(),
                "different-password",
                FAST_TEST_KDF,
            )
            .expect("build_session");
            let other_bytes =
                build_and_serialize_vault_meta(&other_session).expect("serialize alt vault.meta");
            std::fs::write(scratch.path(), other_bytes).expect("overwrite vault.meta");

            let result = change_password_with_path(
                "orig-password-12".to_string(),
                "new-password-12".to_string(),
                scratch.path(),
                &state,
                &noop_hooks(),
            )
            .await;

            assert!(
                matches!(
                    result,
                    Err(VaultChangePasswordError::VaultMetaChangedExternally)
                ),
                "expected VaultMetaChangedExternally, got {result:?}"
            );

            // Force-relock per Q3.
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);

            // Permit released.
            assert_eq!(state.auth_permits().available_permits(), 1);

            // Disk byte-equal to the OTHER vault.meta (NOT the new
            // wrap that change_password would have produced — atomic_
            // write never fired).
            let after_bytes = std::fs::read(scratch.path()).expect("vault.meta exists");
            assert_eq!(
                after_bytes.len(),
                protocol::VAULT_META_LEN,
                "disk holds the externally-mutated vault.meta, not the rewrite"
            );
        });
    }

    /// The credential-rotation force-relock drops `Slot::Unlocked` to `Empty`,
    /// so it owes the SAME teardown as the manual lock: `spec/protocol.md`
    /// §9.8.5 (`vault.indices`) and §9.17.5 (`vault.embeddings`) both say the
    /// decrypted material is zeroized at **every** slot-drop site and both name
    /// the credential-rotation force-relock among them. Asserts the recorded
    /// call vector equals `lock_from_host`'s teardown list, in its order — a
    /// hook added to one path and not the other fails here rather than leaving
    /// plaintext-derived RAM resident until the next unlock overwrites it.
    ///
    /// Every other test in this module builds `NoopHooks`, which cannot observe
    /// a hook at all; this is the only test that can say which ones fired.
    ///
    /// The mutation is a whole competing `vault.meta` rather than a flipped
    /// byte because that is the ordinary way this path is reached: the sync
    /// meta phase rewrites `vault.meta` while the vault is unlocked without
    /// refreshing the slot's hash anchor, so a subsequent change-password in
    /// the same session takes the force-relock branch deterministically.
    #[test]
    fn force_relock_runs_the_full_lock_teardown() {
        rt().block_on(async {
            let (_base, host, state, id, meta_path) =
                seed_unlocked_state_under_host("orig-password-12").await;

            // The per-session decrypted label + icon a relock must stop
            // surfacing in the switcher (SYNC-3).
            state
                .set_cached_label(id, Some("Personal".to_string()))
                .await;
            state.set_cached_icon(id, Some("book".to_string())).await;

            // A structurally valid but DIFFERENT vault.meta lands on disk, as
            // a sync meta adopt/merge leaves it.
            let other_session = build_session(
                crate::vault_id::VaultId::mint(),
                "different-password",
                FAST_TEST_KDF,
            )
            .expect("build_session");
            let other_bytes =
                build_and_serialize_vault_meta(&other_session).expect("serialize alt vault.meta");
            std::fs::write(&meta_path, other_bytes).expect("overwrite vault.meta");

            let recorder = RecordingHooks::new();
            let hooks: crate::hooks::Hooks = recorder.clone();
            let result = change_password_from_host(
                "orig-password-12".to_string(),
                "new-password-12".to_string(),
                &state,
                &hooks,
                &host,
            )
            .await;

            assert!(
                matches!(
                    result,
                    Err(VaultChangePasswordError::VaultMetaChangedExternally)
                ),
                "expected VaultMetaChangedExternally, got {result:?}"
            );
            assert_eq!(state.slot_kind(id).await, SlotKind::Empty);

            assert_eq!(
                recorder.calls(),
                vec![
                    "zeroize_search_index",
                    "zeroize_spell",
                    "clear_staged_descriptor",
                    "pdf_export_teardown_on_lock",
                    "agent_teardown_on_lock",
                    "detached_windows_teardown_on_lock",
                    "zeroize_vault_indices",
                    "zeroize_attachment_refs",
                    "abort_active_recording",
                ],
                "force-relock must run the manual-lock teardown list — and only \
                 that list: `persist_search_index` has no root_key left to seal \
                 with, and `apply_screen_capture` belongs to the manual-lock \
                 path alone"
            );

            // The label/icon eviction half, which cannot ride the hook block:
            // by the time it runs the slot is `Empty` and the id is gone, so
            // the force-relock arms evict inline before their `take`.
            assert!(
                state.cached_label(id).await.is_none(),
                "force-relock must evict the vault's cached decrypted label"
            );
            assert!(
                state.cached_icon(id).await.is_none(),
                "force-relock must evict the vault's cached decrypted icon"
            );
        });
    }

    /// Q1 — In-session idempotency: A→B→C in the SAME session works
    /// because Task 8's `update_unlocked_meta_hash` correctly
    /// propagates the slot hash post-rewrite, so the second
    /// change_password's CAS check sees a coherent snapshot.
    #[test]
    fn change_password_idempotent_in_session() {
        rt().block_on(async {
            let (state, scratch, _orig_pw, _phrase, _orig_bytes) =
                seed_unlocked_state("orig-password-12").await;

            // First change: A → B.
            change_password_with_path(
                "orig-password-12".to_string(),
                "intermediate-pw".to_string(),
                scratch.path(),
                &state,
                &noop_hooks(),
            )
            .await
            .expect("first change_password (A→B) must succeed");

            // Slot must still be Unlocked with a freshly-pinned hash
            // (no force-relock; Task 8's update_unlocked_meta_hash
            // ran successfully).
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Unlocked);

            // Second change: B → C, in the SAME session. CAS must
            // pass because the slot's hash was updated to match the
            // post-A→B disk state.
            change_password_with_path(
                "intermediate-pw".to_string(),
                "final-password-12".to_string(),
                scratch.path(),
                &state,
                &noop_hooks(),
            )
            .await
            .expect("second change_password (B→C) must succeed via propagated CAS anchor");

            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Unlocked);

            // Verify the final disk state by locking + unlocking with
            // the final password.
            let _ = state.take(test_vault_id()).await;
            unlock_with_path(
                "final-password-12".to_string(),
                None,
                scratch.path(),
                &state,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("final password must unlock the post-B→C rewritten vault");
        });
    }

    /// Q4 (p) C1 fix — atomic post-Argon2id commit under a single
    /// write lock. Pure-function unit test on
    /// `commit_unlocked_rewrite`'s match arms; covers the four cases
    /// (Unlocked + matching hash → run rewrite; Unlocked + mismatched
    /// hash → HashMismatch + drop slot; Empty → SlotDropped without
    /// running rewrite; Recovering → SlotDropped without running
    /// rewrite).
    ///
    /// Deterministically pins the C1-fix invariant: the closure is
    /// invoked iff the slot was Unlocked-with-matching-hash at the
    /// commit point. The race itself (`vault_lock` firing in the
    /// post-await µs gap that pre-fix existed) is now structurally
    /// impossible because the helper holds the write lock through
    /// the rewrite — `vault_lock`'s own write-lock acquire blocks
    /// until the helper returns.
    #[test]
    fn commit_unlocked_rewrite_runs_closure_only_on_matching_hash() {
        use crate::plugins::vault_unlock::state::fixture_recovering_with_keys;
        use crate::plugins::vault_unlock::state::fixture_unlocked_with_keys;
        use crate::plugins::vault_unlock::state::CommitRewriteError;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        rt().block_on(async {
            let snapshot_hash = [0xDE; 32];

            // Case 1: Slot::Empty → SlotDropped, closure NOT invoked.
            {
                let state = VaultRuntimeState::default();
                let calls = Arc::new(AtomicUsize::new(0));
                let calls_c = calls.clone();
                let result: Result<(), CommitRewriteError<()>> = state
                    .commit_unlocked_rewrite(snapshot_hash, move || {
                        calls_c.fetch_add(1, Ordering::SeqCst);
                        Ok([0xAA; 32])
                    })
                    .await;
                assert!(matches!(result, Err(CommitRewriteError::SlotDropped)));
                assert_eq!(calls.load(Ordering::SeqCst), 0, "closure must NOT run");
            }

            // Case 2: Slot::Recovering → SlotDropped, closure NOT invoked.
            {
                let state = VaultRuntimeState::default();
                state
                    .set_recovering(
                        test_vault_id(),
                        fixture_recovering_with_keys(0xAA, 0xBB, 0xCC),
                    )
                    .await;
                let calls = Arc::new(AtomicUsize::new(0));
                let calls_c = calls.clone();
                let result: Result<(), CommitRewriteError<()>> = state
                    .commit_unlocked_rewrite(snapshot_hash, move || {
                        calls_c.fetch_add(1, Ordering::SeqCst);
                        Ok([0xAA; 32])
                    })
                    .await;
                assert!(matches!(result, Err(CommitRewriteError::SlotDropped)));
                assert_eq!(calls.load(Ordering::SeqCst), 0, "closure must NOT run");
                // Slot still Recovering — helper does not touch a
                // non-Unlocked slot on SlotDropped.
                assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Recovering);
            }

            // Case 3: Slot::Unlocked + MISMATCHED hash → HashMismatch,
            //         closure NOT invoked, slot dropped to Empty.
            {
                let state = VaultRuntimeState::default();
                let mut uv = fixture_unlocked_with_keys(0x42, 0x13, 0x99);
                uv.vault_meta_bytes_hash = [0xAB; 32]; // != snapshot_hash
                state.set_unlocked(test_vault_id(), uv).await;
                let calls = Arc::new(AtomicUsize::new(0));
                let calls_c = calls.clone();
                let result: Result<(), CommitRewriteError<()>> = state
                    .commit_unlocked_rewrite(snapshot_hash, move || {
                        calls_c.fetch_add(1, Ordering::SeqCst);
                        Ok([0xAA; 32])
                    })
                    .await;
                assert!(matches!(result, Err(CommitRewriteError::HashMismatch)));
                assert_eq!(calls.load(Ordering::SeqCst), 0, "closure must NOT run");
                // Slot dropped to Empty (force-relock).
                assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Empty);
            }

            // Case 4: Slot::Unlocked + MATCHING hash → closure runs,
            //         slot's hash anchor updated to closure's return
            //         value.
            {
                let state = VaultRuntimeState::default();
                let mut uv = fixture_unlocked_with_keys(0x42, 0x13, 0x99);
                uv.vault_meta_bytes_hash = snapshot_hash;
                state.set_unlocked(test_vault_id(), uv).await;
                let calls = Arc::new(AtomicUsize::new(0));
                let calls_c = calls.clone();
                let new_hash = [0xCD; 32];
                let result: Result<(), CommitRewriteError<()>> = state
                    .commit_unlocked_rewrite(snapshot_hash, move || {
                        calls_c.fetch_add(1, Ordering::SeqCst);
                        Ok(new_hash)
                    })
                    .await;
                assert!(result.is_ok());
                assert_eq!(
                    calls.load(Ordering::SeqCst),
                    1,
                    "closure must run exactly once"
                );
                // Slot still Unlocked, hash anchor pinned to closure's return.
                let post = state
                    .peek_unlocked_root_key_and_hash_clone()
                    .await
                    .expect("slot still Unlocked");
                assert_eq!(post.1, new_hash);
            }
        });
    }

    /// Q4 — `ChangePasswordInProgress` rejection when the shared
    /// `auth_permits` semaphore is held. Deterministic: manually
    /// acquire the permit before calling change_password; the call
    /// must fast-fail with the in-progress variant. (Different from
    /// the (p) post-Argon2id race, which is inspection-only per
    /// grilling Q9.)
    #[test]
    fn change_password_returns_in_progress_when_permit_held() {
        rt().block_on(async {
            let (state, scratch, _orig_pw, _phrase, _orig_bytes) =
                seed_unlocked_state("orig-password-12").await;

            // Manually acquire the shared permit so the change_password
            // call hits the `try_acquire` failure branch.
            let _held = state
                .auth_permits()
                .try_acquire()
                .expect("permit should be available pre-call");

            let result = change_password_with_path(
                "orig-password-12".to_string(),
                "new-password-12".to_string(),
                scratch.path(),
                &state,
                &noop_hooks(),
            )
            .await;

            assert!(
                matches!(
                    result,
                    Err(VaultChangePasswordError::ChangePasswordInProgress)
                ),
                "expected ChangePasswordInProgress, got {result:?}"
            );

            // Slot stays Unlocked (rejection is non-mutative — fires
            // before any state-changing code runs).
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Unlocked);

            // Held permit still held (the test's own _held).
            assert_eq!(state.auth_permits().available_permits(), 0);
        });
    }

    /// Q8 — DENY-list grep: scan the production source of
    /// `vault_change_password::commands` for any `tracing::*!`
    /// argument that references DENY-listed secret material
    /// (password, wrap_key, root_key, items_key, item_key, salt,
    /// nonce, account_hash, meta_bytes). Per `src-tauri/CLAUDE.md`
    /// "Secret-handling logging discipline" + `decisions.md`
    /// 2026-05-02 "manual grep is the live discipline check" — the
    /// pattern is reviewer-enforced; this test is the automated
    /// canary that fails the build if the discipline regresses.
    ///
    /// Patterns: any `tracing::*` macro call (info!/warn!/error!/
    /// debug!/trace!) whose argument list contains a DENY-listed
    /// identifier reference (e.g. `password`, `?password`,
    /// `%password`, `password = ...`, `%password.len()`). Excludes
    /// stage-tag string literals (e.g. `stage = "weak_new_password"`)
    /// since those are bare static strings carrying no secret bytes
    /// — the discriminator is whether the identifier appears in a
    /// formatter-position rather than a literal-string-value position.
    #[test]
    fn tracing_emits_have_no_deny_listed_secrets() {
        // Read this very source file and scan for tracing::* macro
        // calls + verify no DENY-listed identifier appears in a
        // formatter slot.
        let source = include_str!("commands.rs");

        // Strip the test module so the grep doesn't false-positive
        // on fixture passwords. Use the explicit bottom-of-file
        // sentinel `#[cfg(test)]\nmod tests {` rather than the bare
        // `#[cfg(test)]` token — the latter would also strip any
        // future `#[cfg(test)]`-gated production helper module above
        // the test block, silently shrinking the deny scan's reach.
        let test_marker = "#[cfg(test)]\nmod tests {";
        let production = source.split(test_marker).next().expect(
            "source must contain `#[cfg(test)]\\nmod tests {` sentinel \
             at the bottom of the file (do NOT add other `#[cfg(test)]` \
             markers above it without updating this test)",
        );

        // Catalogue of forbidden patterns. Stage-tag string literals
        // (e.g. `stage = "weak_new_password"`) are EXCLUDED — they
        // are bare static strings carrying no secret bytes.
        // Identifier-references in formatter slots are caught by the
        // patterns below; both `key = value` (structured field) and
        // `{value}` (positional formatter inside the message string)
        // shapes are covered.
        let deny_patterns: &[&str] = &[
            // Structured-field formatter bindings.
            "= current_password",
            "= new_password",
            "= password.",
            "?current_password",
            "?new_password",
            "%current_password",
            "%new_password",
            "= root_key",
            "?root_key",
            "%root_key",
            "= items_key",
            "?items_key",
            "%items_key",
            "= item_key",
            "?item_key",
            "%item_key",
            "= wrap_key",
            "?wrap_key",
            "%wrap_key",
            "= current_wrap_key",
            "?current_wrap_key",
            "= items_key_wrap_key",
            "?items_key_wrap_key",
            "= fresh_salt",
            "?fresh_salt",
            "= fresh_nonce",
            "?fresh_nonce",
            "= account_number_hash",
            "?account_number_hash",
            "= bytes",
            "?bytes",
            "= new_bytes",
            "?new_bytes",
            "= opened",
            "?opened",
            "= items_opened",
            "?items_opened",
            // Positional formatters inside the message string —
            // `tracing::info!("len: {}", password.len())` style.
            // `{name}` named-formatter shape catches both implicit
            // capture and `:?`/`:%` modifiers.
            "{password",
            "{current_password",
            "{new_password",
            "{root_key",
            "{items_key",
            "{item_key",
            "{wrap_key",
            "{current_wrap_key",
            "{items_key_wrap_key",
            "{fresh_salt",
            "{fresh_nonce",
            "{account_number_hash",
            "{opened",
            "{items_opened",
        ];

        // Walk every line that contains a `tracing::` macro call and
        // check no deny pattern appears within the macro's argument
        // span. A multi-line `tracing::*!(...)` block is captured by
        // checking each line that follows the macro invocation up to
        // the closing paren.
        let mut violations: Vec<(usize, String, String)> = Vec::new();
        let lines: Vec<&str> = production.lines().collect();
        let mut i = 0;
        while i < lines.len() {
            let line = lines[i];
            let is_tracing_start = line.contains("tracing::info!")
                || line.contains("tracing::warn!")
                || line.contains("tracing::error!")
                || line.contains("tracing::debug!")
                || line.contains("tracing::trace!");
            if is_tracing_start {
                // Capture the macro invocation span: from this line
                // until we see the closing `);`.
                let start = i;
                while i < lines.len() && !lines[i].contains(");") {
                    i += 1;
                }
                let span = lines[start..=i.min(lines.len() - 1)].join("\n");
                for pat in deny_patterns {
                    if span.contains(pat) {
                        violations.push((start + 1, pat.to_string(), span.clone()));
                    }
                }
            }
            i += 1;
        }

        assert!(
            violations.is_empty(),
            "DENY-list violations in tracing emits ({} found):\n{}",
            violations.len(),
            violations
                .iter()
                .map(|(ln, pat, span)| format!(
                    "  line {ln}: pattern `{pat}` in:\n    {}",
                    span.lines().collect::<Vec<_>>().join("\n    ")
                ))
                .collect::<Vec<_>>()
                .join("\n")
        );
    }

    /// Q4 (p) — Pure-function unit test on the post-Argon2id slot
    /// peek's variant-match logic. Exercises the three cases that
    /// the production code's `match peek_unlocked_root_key_and_hash_clone()`
    /// arm covers: `Some` with matching hash → proceed (None error),
    /// `Some` with mismatched hash → VaultMetaChangedExternally,
    /// `None` (Empty/Recovering) → VaultLockedDuringChange.
    ///
    /// **Note**: The actual race (vault_lock fires DURING Argon2id)
    /// is inspection-only per MYND-22 grilling Q9 — Argon2id at
    /// production parameters cannot be deterministically raced
    /// without `argon2_mock_with_yield_points` (Phase 2 retrofit
    /// anchor). This test exercises the variant-match arm directly
    /// by manipulating the slot to each state and observing what
    /// `peek_unlocked_root_key_and_hash_clone` returns.
    #[test]
    fn post_argon2id_slot_peek_variant_match_logic() {
        rt().block_on(async {
            let state = VaultRuntimeState::default();
            let snapshot_hash = [0xDE; 32];

            // Case 1: Slot::Empty → None → VaultLockedDuringChange
            //         path in production code.
            assert!(
                state
                    .peek_unlocked_root_key_and_hash_clone()
                    .await
                    .is_none(),
                "Empty slot must return None (would route to VaultLockedDuringChange)"
            );

            // Case 2: Slot::Recovering → None → VaultLockedDuringChange
            //         path in production code.
            use crate::plugins::vault_unlock::state::fixture_recovering_with_keys;
            state
                .set_recovering(
                    test_vault_id(),
                    fixture_recovering_with_keys(0xAA, 0xBB, 0xCC),
                )
                .await;
            assert!(
                state
                    .peek_unlocked_root_key_and_hash_clone()
                    .await
                    .is_none(),
                "Recovering slot must return None (would route to VaultLockedDuringChange)"
            );
            let _ = state.take(test_vault_id()).await; // reset

            // Case 3: Slot::Unlocked with MATCHING hash → Some(_,
            //         matching) → proceed path.
            use crate::plugins::vault_unlock::state::fixture_unlocked_with_keys;
            let mut uv = fixture_unlocked_with_keys(0x42, 0x13, 0x99);
            uv.vault_meta_bytes_hash = snapshot_hash;
            state.set_unlocked(test_vault_id(), uv).await;
            let peek = state.peek_unlocked_root_key_and_hash_clone().await;
            assert!(
                matches!(peek, Some((_, h)) if h == snapshot_hash),
                "Unlocked + matching hash must return Some with snapshot_hash"
            );
            let _ = state.take(test_vault_id()).await; // reset

            // Case 4: Slot::Unlocked with DIFFERENT hash → Some(_,
            //         different) → VaultMetaChangedExternally path
            //         (defensive; unreachable under auth_permits).
            let mut uv2 = fixture_unlocked_with_keys(0x42, 0x13, 0x99);
            uv2.vault_meta_bytes_hash = [0xAB; 32]; // != snapshot_hash
            state.set_unlocked(test_vault_id(), uv2).await;
            let peek2 = state.peek_unlocked_root_key_and_hash_clone().await;
            assert!(
                matches!(peek2, Some((_, h)) if h != snapshot_hash),
                "Unlocked + different hash must return Some with non-snapshot hash"
            );
        });
    }

    /// Same-password reject takes priority over weak-new-password
    /// reject when BOTH conditions fire (user typed same password as
    /// current AND it's also below the floor). The same-pw error is
    /// the more diagnostic message ("you copy-pasted current into
    /// new") so it surfaces first.
    #[test]
    fn change_password_same_password_takes_priority_over_weak() {
        rt().block_on(async {
            // Setup: seed with a sub-floor password (bypasses the
            // creation-side gate via build_session test entry). Then
            // change_password(weak, weak) — both gates would fire.
            let (state, scratch, _orig_pw, _phrase, _) = seed_unlocked_state("short-pw").await;

            let result = change_password_with_path(
                "short-pw".to_string(),
                "short-pw".to_string(),
                scratch.path(),
                &state,
                &noop_hooks(),
            )
            .await;

            // Same-password reject fires FIRST (ordered before the
            // weak-pw gate in the function body).
            assert!(
                matches!(result, Err(VaultChangePasswordError::SamePasswordRejected)),
                "expected SamePasswordRejected (priority over WeakNewPassword), got {result:?}"
            );
        });
    }
}
