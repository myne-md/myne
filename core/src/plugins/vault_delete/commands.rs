// SPDX-License-Identifier: AGPL-3.0
//! `vault_delete` Tauri command — one-shot vault destruction.
//!
//! Feature `backend-vault-delete` (Plane MYND-105) shipped the initial
//! Unlocked/Recovering arms; MYND-108-bis (2026-05-26 `/plan` session,
//! consumed by `ui-vault-delete`) extended the IPC to also accept
//! `Slot::Empty` when `vault.meta` exists on disk (lost-credentials
//! cul-de-sac escape from the Unlock + Recovery phrase-entry surfaces).
//! See `design-notes.md` 2026-05-26 entry "MYND-108-bis vault_delete
//! extended to accept Slot::Empty + vault.meta-exists" for the
//! full rationale.
//!
//! - **Slot precondition matrix** — `VaultBusyAuth` (auth_permits
//!   taken), `Slot::Unlocked` / `Slot::Recovering` (zeroize-then-unlink
//!   happy path), `Slot::Empty + vault.meta-exists` (no-keys lost-
//!   credentials path per MYND-108-bis), `Slot::Empty + no vault.meta`
//!   (rejects `VaultNotFound`; no silent no-op). `VaultNotUnlocked`
//!   variant retained in wire format for cross-version-skew forward
//!   compat + defense-in-depth, but unreachable from current code
//!   paths.
//! - **Happy-path (Unlocked/Recovering):** [`VaultRuntimeState::take_and_run_blocking_for_id`]
//!   takes the slot for the targeted `VaultId` (zeroize via the moved-out variant's `Drop`)
//!   BEFORE any I/O, then runs the per-file unlink walk inside
//!   `spawn_blocking` with the slot write-lock held across the
//!   await. Both `Slot::Unlocked` and `Slot::Recovering` arms
//!   accept (D2 revise per MYND-105 grill Q5 — terminal destroy ≠
//!   navigate-away bail).
//! - **Happy-path (Empty + meta-exists, MYND-108-bis):**
//!   (a `Slot::ImportSource` for the targeted vault goes the same way, and
//!   every OTHER vault's import source is closed too: whichever vault was
//!   just erased, an import across it cannot continue)
//!   `delete_vault_files_no_zeroize` skips the slot.take() step
//!   (slot is already Empty; no keys to zeroize) and runs the same
//!   `unlink_walk` / `emit_per_unlink_failure_trace` /
//!   `try_parent_dir_sync` / `aggregate_unlink_results` pipeline
//!   directly via `spawn_blocking`. The cryptographic-erase claim is
//!   structurally inapplicable on this arm (no in-memory keys exist
//!   to zeroize); the user reaches this path having lost both
//!   credentials, so the on-disk Argon2id-wrapped keys are already
//!   computationally unrecoverable — recursive unlink converts
//!   computationally-unrecoverable bytes into no-bytes, strictly
//!   stronger.
//! - **Partial-fail surface:** the shared `crate::vault_sweep::sweep`
//!   pipeline runs a post-order recursive walk without short-circuit,
//!   emits `tracing::warn!(stage = "unlink_blob", io_failure_kind = ?kind)`
//!   per failure (DENY-list clean, no paths), and returns a neutral
//!   `SweepOutcome`; `sweep_outcome_to_delete_result` maps it to
//!   `Ok(())` or `Err(PartialDelete { remaining_count })`.
//! - **Durability:** Unix dir `sync_all()` journal-commit hint
//!   (best-effort, never propagates) inside `vault_sweep`; Windows
//!   `#[cfg(unix)]`-gated no-op (matches `note_delete` 2026-05-07
//!   asymmetry precedent).
//! - **Tracing taxonomy:** `event = "vault_deleted"` on success;
//!   `event = "vault_delete_partial"` with `remaining_count` on
//!   partial-fail; per-file `stage = "unlink_blob"`; durability
//!   `stage = "parent_dir_sync"`; rejection-arm `stage = "slot_check"
//!   | "auth_permits"`. All payloads DENY-list-clean (no paths,
//!   no note_ids, no kernel-error display strings).
//!
//! ### Design history
//!
//! - PRD: `agent-tooling/features/backend-vault-delete/prd.md`
//! - Grilling: `agent-tooling/sessions/grill/2026-05-26-mynd-105-vault-delete.md`
//!   Q1–Q9 (cryptographic-erase claim, slot precondition matrix,
//!   R3 escape, partial-fail posture, artefact taxonomy, plugin
//!   layout, test surface)
//! - decisions.md anchors: 2026-05-26 (a) cryptographic-erase
//!   claim, (b) Slot precondition matrix + R3 + VaultNotUnlocked
//!   bug-canary, (c) partial-fail posture + v0.2 vault_repair
//!   (Plane MYND-159), (d) VaultArtifactsPresent rename
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline".

use super::error::VaultDeleteError;
use crate::host::HostCtx;
use crate::plugins::quick_unlock::device_secret::{
    self, DeviceSecretKeychain, SecretDeleteFailure,
};
use crate::plugins::vault_unlock::state::{SlotKind, TakeAndRunError, VaultRuntimeState};
use crate::vault_id::VaultId;
use std::path::PathBuf;
// Tauri types serve only the cfg-gated IPC wrappers (task 79, Option B).
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use crate::host::tauri_host::TauriHost;
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use tauri::{AppHandle, Runtime, State};

/// One-shot vault destruction.
///
/// Zeroizes the in-memory `Slot` (root_key + items_key via the
/// moved-out `UnlockedVault` / `RecoveringMaterial` `Drop`) BEFORE
/// any filesystem operation, then recursively unlinks every entry
/// under `<app_data_dir>/vault/` (post-order, symlinks not
/// followed). Returns `Ok(())` on full success or
/// `Err(VaultDeleteError::PartialDelete { remaining_count })` if
/// some files could not be unlinked (e.g., antivirus / Spotlight /
/// OneDrive sync file locks). On rejection the slot is left intact;
/// on any acceptance path (happy or partial-fail) the slot is Empty.
///
/// # Frontend contract
///
/// **Caller MAY pre-[`crate::plugins::vault_unlock::commands::lock`]
/// (`vault_lock` IPC).** As of MYND-108-bis (`design-notes.md`
/// 2026-05-26 entry "MYND-108-bis vault_delete extended to accept
/// Slot::Empty + vault.meta-exists"), the IPC also accepts the
/// `Slot::Empty` arm when `vault.meta` exists on disk — so pre-locking
/// (which drops the slot to Empty while leaving `vault.meta` on disk)
/// falls through to the new no-keys path with the same end-to-end
/// cryptographic-erase property (`vault_lock`'s zeroize fires before
/// our recursive unlink, preserving the zeroize-before-IO ordering).
/// The MYND-105 era contract that read "MUST NOT pre-lock" is
/// **loosened** by this revision.
///
/// The canonical specification of the broader contract is the PRD at
/// `agent-tooling/features/backend-vault-delete/prd.md` §"Implementation
/// Decisions → Frontend contract surface" (initial shape); the
/// MYND-108-bis extension is canonical in `design-notes.md`
/// 2026-05-26 entry "MYND-108-bis vault_delete extended to accept
/// Slot::Empty + vault.meta-exists".
///
/// # Slot precondition matrix
///
/// | Slot state + disk                                | Behavior                                                                  |
/// |--------------------------------------------------|---------------------------------------------------------------------------|
/// | `Slot::Unlocked`                                 | take() + zeroize + recursive unlink (happy)                               |
/// | `Slot::Recovering`                               | take() + zeroize + recursive unlink (R3 escape, MYND-105 Q5)              |
/// | `Slot::Empty` + `vault.meta` on disk             | no-keys recursive unlink (lost-credentials path, MYND-108-bis)            |
/// | `Slot::Empty` + no `vault.meta`                  | reject `VaultNotFound` (no silent no-op success)                          |
/// | `auth_permits` taken (other auth op mid-Argon2id)| reject `VaultBusyAuth` (try_acquire, never queue)                         |
/// | (legacy) bug-canary defense-in-depth             | `VaultNotUnlocked` retained in wire format but unreachable from current code |
///
/// # See also
///
/// - `agent-tooling/features/backend-vault-delete/prd.md` — PRD
///   (canonical specification of all behavior on this command)
/// - `design-notes.md` 2026-05-26 entries (a)-(d) —
///   cryptographic-erase claim, Slot precondition matrix + R3,
///   partial-fail posture, VaultArtifactsPresent rename
/// - `docs/threat-model.md` A5 (lost or stolen device — locked,
///   Strong) — the load-bearing at-rest guarantee that the
///   "geri getirilemez" UX claim reaffirms post-unlink
pub async fn vault_delete_from_host(
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    host: &dyn HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    vault_id: String,
    keychain: &dyn crate::vault_label::key::LabelKeychain,
    secret_keychain: &dyn DeviceSecretKeychain,
) -> Result<(), VaultDeleteError> {
    // SYNC-6 explicit-id targeting (mirrors `unlock` / `recover`): the IPC layer
    // carries a canonical hyphenated `VaultId` string, and since #250 it is
    // REQUIRED. The id resolves to `vaults/<id>/` directly (NOT the sole-vault
    // `paths::vault_dir()` scan), so the erase hits exactly the chosen vault and
    // never a sibling. The slot-map key is the same `VaultId`, so the per-id slot
    // peek + keyed `take_and_run_blocking_for_id` zeroize only the targeted slot.
    //
    // The optional target is gone because the fallback WAS the bug: omitting the
    // id compiled, looked correct, and silently erased whichever vault a
    // best-effort cache happened to name — while `Unlock.tsx` and
    // `VaultRecover.tsx` omitted it with the id sitting in scope. A malformed id
    // is now `VaultNotFound` rather than "delete something else instead".
    let target = VaultId::parse(&vault_id).map_err(|_| VaultDeleteError::VaultNotFound)?;
    // Non-creating resolver (MYND-253): delete destroys an EXISTING vault;
    // a stale/forged id must resolve to a path the scan below turns into
    // VaultNotFound — never materialize an empty `vaults/<bogus-id>/`.
    let vault_dir = crate::paths::vault_root_for_id_optional_from_host(host, Some(target))
        .map_err(|_| VaultDeleteError::Io {
            io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
        })?;
    let vault_id = target;

    // MYND-351 Direction 2: a user-initiated delete preempts an in-flight
    // scheduled backup (which holds the shared auth permit) so the `try_acquire`
    // inside `vault_delete_with_dir` is not rejected by the invisible job.
    hooks.preempt_inflight_backup(state).await;

    // myne-md/myne#761: the per-vault keychain item's account component is
    // derived from `account_number_hash`, and the sweep below removes the only
    // at-rest copy of it. Read it BEFORE the erase. A `None` here is a vault
    // whose `vault.meta` could not be read or parsed; the delete still proceeds
    // (that is the existing contract), and the teardown logs the reason rather
    // than pretending the item was addressed.
    let account_number_hash = read_account_number_hash(io, &vault_dir).await;

    let result = vault_delete_with_dir(vault_dir.clone(), vault_id, state).await;
    run_post_delete_teardown(
        host,
        state,
        hooks,
        io,
        &vault_dir,
        vault_id,
        keychain,
        secret_keychain,
        account_number_hash,
        &result,
    )
    .await;
    result
}

/// The wasm/`VaultIo` twin of [`vault_delete_from_host`]
/// (`phase3-web-client` task 72).
///
/// Same resolution, same backup preemption, same post-delete teardown — the one
/// difference is which erase it drives ([`vault_delete_via_io`]). Sharing the
/// teardown through [`run_post_delete_teardown`] rather than copying it is the
/// point of the split: that list is what stops plaintext derived from the
/// deleted vault (the search index, the staged workspace descriptor, the
/// indices, the attachment graph) from outliving it, and two copies of it would
/// diverge silently on the client with the smaller test surface.
pub async fn vault_delete_via_io_from_host(
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    host: &dyn HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    vault_id: String,
    keychain: &dyn crate::vault_label::key::LabelKeychain,
    secret_keychain: &dyn DeviceSecretKeychain,
) -> Result<(), VaultDeleteError> {
    // Required target, same as the native twin (#250) — the browser reaches
    // this through the same TS wrapper, so an optional id here would reopen the
    // hole on the one client whose "vaults" are OPFS containers.
    let target = VaultId::parse(&vault_id).map_err(|_| VaultDeleteError::VaultNotFound)?;
    let vault_dir = crate::paths::vault_root_for_id_optional_from_host(host, Some(target))
        .map_err(|_| VaultDeleteError::Io {
            io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
        })?;
    let vault_id = target;

    hooks.preempt_inflight_backup(state).await;

    // Same pre-erase read as the native twin, through the storage seam so it
    // works on OPFS too. On web it is inert (no keychain), but the read is the
    // command's, not the platform's, so the two clients cannot drift.
    let account_number_hash = read_account_number_hash(io, &vault_dir).await;

    let result = vault_delete_via_io(io, vault_dir.clone(), vault_id, state).await;
    run_post_delete_teardown(
        host,
        state,
        hooks,
        io,
        &vault_dir,
        vault_id,
        keychain,
        secret_keychain,
        account_number_hash,
        &result,
    )
    .await;
    result
}

/// Read `account_number_hash` from `vault.meta`, for the erase.
///
/// Derived-then-discarded shape: the hash never leaves this function as
/// anything but its `[u8; 16]`, it never reaches a log line, and a `None` is
/// "could not address the item", not an error the delete has to propagate. The
/// MYND-108-bis lost-credentials arm relies on this reading a vault whose
/// password is gone, which is exactly the arm where erasing the device-local
/// fast-unlock secret matters most.
async fn read_account_number_hash(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &std::path::Path,
) -> Option<[u8; 16]> {
    let bytes = io.read(&vault_dir.join("vault.meta")).await.ok()?;
    // Either generation (`NTV5` / `NTV6`): a member vault's biometric item is
    // addressed by the same hash, so a reader taught only v0.1 would silently
    // skip exactly the second member of the class this change covers.
    protocol::parse_vault_meta_any(&bytes)
        .ok()
        .map(|meta| meta.account_number_hash)
}

/// Wipe every plaintext-derived artefact that must not outlive the vault.
///
/// Runs iff the delete actually PROCEEDED (full `Ok` or a `PartialDelete`) —
/// the slot was dropped on exactly those paths. A rejected delete
/// (`VaultBusyAuth` / `VaultNotFound`) left the slot untouched, so any live
/// index belongs to a still-unlocked session and MUST NOT be wiped.
///
/// That gate is why the sealed label erase (myne-md/myne#411) belongs on THIS
/// list rather than beside the unlink: the vault's cached name is one more
/// artefact that must not outlive it, and destroying its wrap key on a
/// **rejected** delete would leave a surviving vault's picker row falling back
/// until its next unlock. Everything above the erase is RAM; the erase is the
/// one durable member, and it goes last for that reason.
///
/// **And it is why the per-vault keychain secrets belong here too**
/// (myne-md/myne#761, `design-notes/security/0709`). `forget_label` destroys
/// the sealed-label wrap key; `erase_for_vault` destroys the item the owner
/// quick-unlock **and** member-vault biometric wrap keys share
/// (`plugins::quick_unlock::device_secret`), which nothing removed until this
/// change. Two ordering facts are load-bearing. First, both run AFTER the
/// directory removal (`vault_delete_with_dir` / `vault_delete_via_io` has
/// returned), which is exactly the case the warning in
/// `plugins::quick_unlock::apple` distinguishes from replacing a live one. The
/// two gated arms differ and the difference is stated rather than glossed: on
/// `Ok(())` the encrypted blob that consumes this key is gone, so the credential
/// is destroyed with its only consumer; on `PartialDelete` some files resisted
/// the unlink and `vault.quickunlock` may still be on disk, and the erase still
/// runs because the user asked for the vault to be destroyed, the user keeps the
/// password path, and a retry finishes the sweep. Second, both are gated on the
/// delete having proceeded, for the reason above.
///
/// **Neither erase may fail the command, and that is stated rather than
/// implied.** At this point the vault's files are gone; reporting `Err` would
/// tell the user the vault survived when it did not, and a retry would answer
/// `VaultNotFound`. So a keychain delete that failed is logged with its bounded
/// reason (`SecretDeleteFailure::Backend`) and the command still returns its
/// file-level result. What survives in that case is one random 32-byte secret
/// whose ciphertext was removed with the vault, which is the hygiene residue the
/// label path already accepts; it is visible in the diagnostic log rather than
/// silent.
#[allow(clippy::too_many_arguments)]
#[cfg_attr(target_arch = "wasm32", allow(unused_variables))]
async fn run_post_delete_teardown(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &std::path::Path,
    vault_id: VaultId,
    keychain: &dyn crate::vault_label::key::LabelKeychain,
    secret_keychain: &dyn DeviceSecretKeychain,
    account_number_hash: Option<[u8; 16]>,
    result: &Result<(), VaultDeleteError>,
) {
    if matches!(result, Ok(()) | Err(VaultDeleteError::PartialDelete { .. })) {
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
        // myne-md/myne#698: the backend-held B2B person identity is Critical-class
        // key material and dies with the vault on this path too (AS21 "every lock
        // path"); it lives outside the slot map, so nothing else reaches it here.
        let _ = state.clear_person_session().await;
        hooks.zeroize_search_index();
        // MYND-166: wipe the staged editor-workspace descriptor too.
        hooks.clear_staged_descriptor();
        // MYND-255: destroy the hidden pdf-export render window (a
        // plaintext-bearing second WebView) and wipe its stashed HTML
        // payload on the same delete-proceeded path — the deleted vault's
        // plaintext must not outlive the vault in a second window.
        hooks.pdf_export_teardown_on_lock();
        hooks.agent_teardown_on_lock();
        // myne#679: destroy the deleted vault's detached (pop-out) note windows
        // on the same delete-proceeded path: its plaintext must not outlive the
        // vault in a second window.
        hooks.detached_windows_teardown_on_lock();
        // live-collab: drop every open live co-editing session on the same
        // delete-proceeded path so a session's decrypted plaintext does not
        // outlive the deleted vault.
        hooks.live_session_teardown_on_lock();
        // MYND-31: wipe the plaintext-derived VaultIndices on the same
        // delete-proceeded path so it does not outlive the deleted vault.
        hooks.zeroize_vault_indices();
        // MYND-169: wipe the plaintext-derived attachment reference graph
        // on the same delete-proceeded path so it does not outlive the
        // deleted vault.
        hooks.zeroize_attachment_refs();
        // MYND-259: abort any in-progress voice recording so the mic + RAM
        // PCM buffer do not outlive the deleted vault.
        hooks.abort_active_recording();
        // myne-md/myne#411: destroy this vault's sealed-label wrap key, and
        // remove the `vault.label` file if the sweep above left one.
        //
        // `forget_label` rather than `remove_label`, and the difference is the
        // whole point: the recursive unlink already deleted the ciphertext from
        // the live filesystem, and deleted bytes stay recoverable from the
        // medium (`decisions.md` 2026-05-07 settled that when it rejected
        // platform-specific secure-delete). A surviving key over recoverable
        // ciphertext would weaken the per-`VaultId` cryptographic-erase
        // guarantee vault deletion carries today, in the one place a person
        // actually recognises: the vault's name. Destroying the key IS the
        // erase.
        crate::vault_label::writeback::forget_label(io, vault_dir, vault_id, keychain).await;
        // myne-md/myne#761: the other per-vault device-local secret. The owner
        // quick-unlock biometric wrap key and the member-vault biometric wrap
        // key share ONE keychain item (service `md.myne.quickunlock`, account
        // `hex(account_number_hash):vault_id`); `plugins::quick_unlock::
        // device_secret` is the single source of that address. Destroying it is
        // the same class rule `forget_label` follows one line up.
        match account_number_hash {
            Some(hash) => match device_secret::erase_for_vault(&hash, vault_id, secret_keychain) {
                Ok(()) => {}
                // No keychain on this target: nothing was ever created there,
                // so there is nothing to erase. The delete copy says so
                // (`settings.deleteVault.keychainNote`); this is not a failure
                // and logging it would cry wolf on Windows, Linux and Android.
                Err(SecretDeleteFailure::Unavailable) => {}
                // A real failure, and NOT silent: the item survived. The command
                // still returns its file-level result (see the doc comment), so
                // the diagnostic log is the only place this can surface.
                Err(failure) => tracing::warn!(
                    stage = "vault_delete_device_secret",
                    failure = ?failure,
                    "per-vault device-local secret outlived the vault it belongs to"
                ),
            },
            // `vault.meta` could not be read or parsed before the sweep, so the
            // item cannot be addressed. The delete itself still proceeds; say
            // so, because "we did not erase it" and "there was nothing to erase"
            // are different sentences.
            None => tracing::warn!(
                stage = "vault_delete_device_secret",
                reason = "account_number_hash_unavailable",
                "vault.meta yielded no account_number_hash, so the per-vault \
                 device-local secret could not be addressed"
            ),
        }
        // myne-md/myne#792: destroy this vault's device-local person-identity
        // carrier. Its KEK is this vault's `root_key`, so a deleted vault's
        // carrier is cryptographically inert, but it is still an at-rest copy of
        // the person keypair and the vault-delete path must not leave one behind.
        #[cfg(not(target_arch = "wasm32"))]
        crate::plugins::sync::person_vault_carrier::delete_person_vault_carrier(
            host,
            io,
            vault_id.as_uuid().as_bytes(),
        )
        .await;
    }
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn vault_delete<R: Runtime>(
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    app: AppHandle<R>,
    vault_id: String,
) -> Result<(), VaultDeleteError> {
    vault_delete_from_host(
        state.inner(),
        hooks.inner(),
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        vault_id,
        crate::vault_label::key::platform_keychain(),
        device_secret::quick_unlock_keychain(),
    )
    .await
}

/// Testable core of [`vault_delete`]. The Tauri-command wrapper
/// resolves the platform-specific vault directory and delegates here
/// so tests do not need an `tauri::AppHandle`.
///
/// Full pipeline (MYND-105 initial + MYND-108-bis Empty-arm extension):
///
/// 1. `auth_permits.try_acquire()` — RAII guard, reject-not-queue.
/// 2. `state.slot_kind()` peek — discriminate the Slot variant.
/// 3. `Slot::Empty` arm: delegate to [`dispatch_empty_arm`] which
///    checks `vault.meta` on disk and routes either to the no-keys
///    recursive-unlink path (`vault.meta` present → MYND-108-bis
///    lost-credentials accept) or `VaultNotFound` rejection
///    (`vault.meta` absent → no silent no-op success).
/// 4. `Slot::Unlocked` / `Slot::Recovering` arm: delegate to
///    [`VaultRuntimeState::take_and_run_blocking_for_id`] which holds the
///    slot write-lock across the spawn_blocking closure. The
///    closure runs the shared [`crate::vault_sweep::sweep`] pipeline
///    (post-order unlink walk + per-file DENY-list tracing + Unix
///    journal-commit) with [`crate::vault_sweep::RootDisposal::Remove`],
///    then maps the neutral `SweepOutcome` via
///    [`sweep_outcome_to_delete_result`]. Returns Ok(()) on full
///    success, `PartialDelete{remaining_count}` on any per-file failure.
/// 5. On `TakeAndRunError::SlotEmpty` (concurrent `vault_lock`
///    raced between our peek and the write-lock acquire) the unlink
///    did NOT run; the racing `vault_lock`'s `Drop` already zeroized
///    the keys, so we fall through to [`dispatch_empty_arm`] which
///    routes the same way the cold Empty arm would. This preserves
///    the user's delete intent rather than surfacing a silent
///    bug-canary rejection.
pub(crate) async fn vault_delete_with_dir(
    vault_dir: PathBuf,
    vault_id: VaultId,
    state: &VaultRuntimeState,
) -> Result<(), VaultDeleteError> {
    // (1) auth_permits gate — RAII guard; try_acquire, reject not queue.
    //     Bound by `decisions.md` 2026-05-02 "single in-flight" posture
    //     extended in MYND-105 grill Q3-D3 to vault_delete. The permit
    //     stays held until end of function via the `_permit` binding.
    let _permit = match state.auth_permits().try_acquire() {
        Ok(p) => p,
        Err(_) => {
            tracing::debug!(
                stage = "auth_permits",
                error_kind = "VaultBusyAuth",
                "vault_delete rejected: another auth-pipeline op in flight"
            );
            return Err(VaultDeleteError::VaultBusyAuth);
        }
    };

    // (2) Slot precondition matrix — cheap read-lock peek to
    //     discriminate the variant. The Unlocked/Recovering arm
    //     escalates to a write-lock for `take()` inside
    //     `take_and_run_blocking`; the Empty arm routes through
    //     `dispatch_empty_arm` which decides between the new
    //     no-keys accept path (MYND-108-bis) and `VaultNotFound`
    //     rejection.
    match state.slot_kind(vault_id).await {
        SlotKind::Empty => dispatch_empty_arm(vault_dir).await,
        SlotKind::Recovering | SlotKind::Unlocked | SlotKind::ImportSource => {
            // Happy path: take_and_run_blocking takes the slot
            // (zeroize via the moved-out variant's Drop fires BEFORE
            // any IO) then runs the unlink pipeline inside
            // spawn_blocking with the slot write-lock held across
            // the await — concurrent slot-touching ops (vault_lock,
            // vault_unlock, note_*) queue on the RwLock as
            // defense-in-depth alongside the auth_permits hold.
            // Pipeline: `unlink_walk` (enumerated post-order
            // recursive walk, no short-circuit on per-file failure)
            // → `emit_per_unlink_failure_trace` (DENY-list-clean
            // per-file tracing) → `try_parent_dir_sync` (Unix-only
            // best-effort journal commit) → `aggregate_unlink_results`
            // (Ok or `PartialDelete{remaining_count}`). See
            // `decisions.md` 2026-05-26 "vault_delete Slot
            // precondition matrix" + "vault_delete partial-fail
            // posture" + PRD §"Implementation Decisions".
            let vault_dir_for_blocking = vault_dir.clone();
            match state
                .take_and_run_blocking_for_id(vault_id, move || -> Result<(), VaultDeleteError> {
                    // Shared sweep pipeline (`crate::vault_sweep`): post-order
                    // unlink walk + DENY-list-clean per-file tracing +
                    // best-effort Unix journal commit. `RootDisposal::Remove`
                    // keeps vault_delete's "destroy the directory too"
                    // behavior. The neutral `SweepOutcome` is mapped into
                    // `VaultDeleteError` here.
                    let outcome = crate::vault_sweep::sweep(
                        &vault_dir_for_blocking,
                        crate::vault_sweep::RootDisposal::Remove,
                    );
                    sweep_outcome_to_delete_result(outcome)
                })
                .await
            {
                Ok(()) => {
                    tracing::info!(event = "vault_deleted", stage = "complete");
                    Ok(())
                }
                Err(TakeAndRunError::SlotEmpty) => {
                    // Race: a concurrent `vault_lock` IPC fired between
                    // our `slot_kind()` peek and the
                    // `take_and_run_blocking` write-lock acquire.
                    // `vault_lock` doesn't consume an auth_permit, so
                    // the permit we hold doesn't block it. The unlink
                    // did NOT run inside `take_and_run_blocking`, but
                    // the racing `vault_lock`'s Drop already zeroized
                    // the keys — so falling through to the same
                    // `dispatch_empty_arm` as the cold Empty arm
                    // completes the user's delete intent (MYND-108-bis).
                    // No silent bug-canary rejection from this branch.
                    tracing::debug!(
                        stage = "slot_race",
                        "vault_delete: slot raced to Empty during write-lock acquire (vault_lock?); falling through to dispatch_empty_arm"
                    );
                    dispatch_empty_arm(vault_dir).await
                }
                Err(TakeAndRunError::Closure(vd_err)) => {
                    // The closure returned a fully-typed
                    // VaultDeleteError. Currently only PartialDelete
                    // (from aggregate_unlink_results) reaches here.
                    // Emit the partial-fail summary event before
                    // surfacing — DENY-list clean (only count, no
                    // paths).
                    if let VaultDeleteError::PartialDelete { remaining_count } = &vd_err {
                        tracing::warn!(
                            event = "vault_delete_partial",
                            remaining_count = *remaining_count,
                            "vault_delete completed with partial-fail"
                        );
                    } else {
                        // Future-proof: log unexpected closure error.
                        let kind = vault_delete_error_kind(&vd_err);
                        tracing::warn!(
                            stage = "unlink_pipeline",
                            error_kind = kind,
                            "vault_delete unlink pipeline returned non-PartialDelete error"
                        );
                    }
                    Err(vd_err)
                }
                Err(TakeAndRunError::Join) => {
                    tracing::error!(
                        stage = "spawn_blocking_join",
                        error_kind = "Io",
                        "vault_delete spawn_blocking join failure"
                    );
                    Err(VaultDeleteError::Io {
                        io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
                    })
                }
            }
        }
    }
}

/// Dispatch the `Slot::Empty` arm based on `vault.meta` presence on
/// disk. Called from both the cold Empty arm in [`vault_delete_with_dir`]
/// and the `TakeAndRunError::SlotEmpty` race branch (concurrent
/// `vault_lock` raced through during our write-lock acquire). Routes
/// to [`delete_vault_files_no_zeroize`] when `vault.meta` is present
/// (MYND-108-bis lost-credentials accept path) or returns
/// `VaultNotFound` when nothing is on disk to delete (unchanged from
/// MYND-105's rejection semantics — no silent no-op success).
///
/// See `design-notes.md` 2026-05-26 entry "MYND-108-bis vault_delete
/// extended to accept Slot::Empty + vault.meta-exists" for the
/// rationale that the racing `vault_lock`'s `Drop` already zeroized
/// the keys, so the race branch falling through to this dispatcher
/// preserves the user's delete intent without weakening cryptographic-
/// erase ordering.
pub(crate) async fn dispatch_empty_arm(vault_dir: PathBuf) -> Result<(), VaultDeleteError> {
    if vault_dir.join("vault.meta").is_file() {
        delete_vault_files_no_zeroize(vault_dir).await
    } else {
        tracing::debug!(
            stage = "slot_check",
            error_kind = "VaultNotFound",
            "vault_delete rejected: slot empty and vault.meta absent"
        );
        Err(VaultDeleteError::VaultNotFound)
    }
}

/// MYND-108-bis no-keys recursive unlink path. Used when the slot is
/// `Slot::Empty` but `vault.meta` exists on disk — the user has
/// lost both password and recovery phrase, so there are no in-memory
/// keys to zeroize before unlink. Skips the `take_and_run_blocking`
/// step entirely and runs the same `unlink_walk` /
/// `emit_per_unlink_failure_trace` / `try_parent_dir_sync` /
/// `aggregate_unlink_results` pipeline directly via
/// `tokio::task::spawn_blocking`.
///
/// Tracing emission is identical to the Unlocked/Recovering arm:
/// `event="vault_deleted", stage="complete"` on full success;
/// `event="vault_delete_partial", remaining_count=N` on partial
/// failure (uniform observability for SRE). DENY-list clean — no
/// path, no error::Display, no account identifier in payload.
///
/// See module-level rustdoc for the cryptographic-erase claim's
/// structural inapplicability on this arm (the on-disk Argon2id-
/// wrapped keys are already computationally unrecoverable; recursive
/// unlink converts unrecoverable-bytes → no-bytes).
pub(crate) async fn delete_vault_files_no_zeroize(
    vault_dir: PathBuf,
) -> Result<(), VaultDeleteError> {
    tracing::debug!(
        stage = "slot_check",
        slot_arm = "empty_meta_exists",
        "vault_delete proceeding: slot empty, vault.meta present (MYND-108-bis no-keys lost-credentials path)"
    );
    let vault_dir_for_blocking = vault_dir.clone();
    let join_result = crate::task::run_blocking(move || -> Result<(), VaultDeleteError> {
        let outcome = crate::vault_sweep::sweep(
            &vault_dir_for_blocking,
            crate::vault_sweep::RootDisposal::Remove,
        );
        sweep_outcome_to_delete_result(outcome)
    })
    .await;
    match join_result {
        Ok(Ok(())) => {
            tracing::info!(event = "vault_deleted", stage = "complete");
            Ok(())
        }
        Ok(Err(vd_err)) => {
            if let VaultDeleteError::PartialDelete { remaining_count } = &vd_err {
                tracing::warn!(
                    event = "vault_delete_partial",
                    remaining_count = *remaining_count,
                    "vault_delete completed with partial-fail (no-keys path)"
                );
            } else {
                let kind = vault_delete_error_kind(&vd_err);
                tracing::warn!(
                    stage = "unlink_pipeline",
                    error_kind = kind,
                    "vault_delete unlink pipeline returned non-PartialDelete error (no-keys path)"
                );
            }
            Err(vd_err)
        }
        Err(_) => {
            tracing::error!(
                stage = "spawn_blocking_join",
                error_kind = "Io",
                "vault_delete spawn_blocking join failure (no-keys path)"
            );
            Err(VaultDeleteError::Io {
                io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
            })
        }
    }
}

// ── the storage-seam sibling (phase3-web-client task 72) ─────────────────────
//
// # What this is, and what it deliberately is not
//
// `vault_delete_with_dir` above reaches the filesystem through `std::fs`, twice
// removed: `vault_sweep::sweep` inside `crate::task::run_blocking`. On
// `wasm32-unknown-unknown` both halves are traps — `std::fs` fails at runtime
// and `run_blocking`'s wasm arm cannot host a future — so a browser needed a
// path that goes through [`crate::vault_io::VaultIo`] and awaits.
//
// It is a **sibling**, not a rewrite, for the same reason `sweep_via_io` is:
// converting the existing function would drag desktop's erase off tokio's
// blocking pool and onto the async executor, which is a real behaviour change to
// a destructive command, made for a target that is not the one being served.
//
// # What it means on this client, which is not what it means on desktop
//
// The web client's OPFS container is a CACHE of a sync-held vault
// (`decisions.md` 2026-07-26: sync is not optional here, it is the storage), so
// erasing it is a sign-out that takes this browser's copy with it — the account
// and everything already synced survive on the server. The command is the same
// command and the bytes it removes are the same bytes; what differs is what the
// user is told, and that lives in the UI (`localOnlyVault` in the capability
// descriptor, and the load-bearing disclosure it selects). Nothing here claims
// otherwise, and nothing here talks to the server: **no remote wipe, no
// account deletion, no device revocation.** A user who wants the account gone
// removes devices and deletes it from a client that can.
//
// # The two absences carried over from `sweep_via_io`
//
// No directory `fsync` (OPFS has no such primitive) and no symlink branch (the
// seam's `DirEntry` distinguishes only files from directories, because OPFS
// has nothing else to distinguish). Both are stated on `sweep_via_io` itself.

/// [`vault_delete_with_dir`]'s storage-seam sibling: same slot precondition
/// matrix, same partial-fail posture, same tracing taxonomy — awaiting
/// [`crate::vault_sweep::sweep_via_io`] instead of offloading
/// [`crate::vault_sweep::sweep`].
///
/// The zeroize-before-erase ordering is preserved by
/// [`VaultRuntimeState::take_and_run_async_for_id`], which drops the slot before
/// the erase future is constructed. That ordering is what the
/// cryptographic-erase claim rests on and it matters MORE here: an OPFS walk is
/// genuinely asynchronous, so keys left in the slot would outlive every await in
/// it.
pub async fn vault_delete_via_io(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: PathBuf,
    vault_id: VaultId,
    state: &VaultRuntimeState,
) -> Result<(), VaultDeleteError> {
    let _permit = match state.auth_permits().try_acquire() {
        Ok(p) => p,
        Err(_) => {
            tracing::debug!(
                stage = "auth_permits",
                error_kind = "VaultBusyAuth",
                "vault_delete rejected: another auth-pipeline op in flight"
            );
            return Err(VaultDeleteError::VaultBusyAuth);
        }
    };

    match state.slot_kind(vault_id).await {
        SlotKind::Empty => dispatch_empty_arm_via_io(io, vault_dir).await,
        SlotKind::Recovering | SlotKind::Unlocked | SlotKind::ImportSource => {
            let dir = vault_dir.clone();
            let taken = state
                .take_and_run_async_for_id(vault_id, || async {
                    let outcome = crate::vault_sweep::sweep_via_io(
                        io,
                        &dir,
                        crate::vault_sweep::RootDisposal::Remove,
                    )
                    .await;
                    sweep_outcome_to_delete_result(outcome)
                })
                .await;
            match taken {
                Ok(()) => {
                    tracing::info!(event = "vault_deleted", stage = "complete");
                    Ok(())
                }
                Err(TakeAndRunError::SlotEmpty) => {
                    // Same race, same answer as the native arm: a concurrent
                    // `lock` took the slot (and zeroized it) between our peek
                    // and the write-lock acquire, so the user's delete intent
                    // is completed through the no-keys path rather than
                    // rejected.
                    tracing::debug!(
                        stage = "slot_race",
                        "vault_delete: slot raced to Empty during write-lock acquire; falling through to dispatch_empty_arm"
                    );
                    dispatch_empty_arm_via_io(io, vault_dir).await
                }
                Err(TakeAndRunError::Closure(vd_err)) => {
                    report_delete_failure(&vd_err);
                    Err(vd_err)
                }
                Err(TakeAndRunError::Join) => {
                    // Unreachable on this arm — nothing is spawned. Routed
                    // rather than `unreachable!()`d: a panic in a Worker kills
                    // the instance, and the enum is shared with the arm that
                    // can produce it.
                    Err(VaultDeleteError::Io {
                        io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
                    })
                }
            }
        }
    }
}

/// [`dispatch_empty_arm`]'s storage-seam sibling.
///
/// The `vault.meta` probe is `io.exists`, and an IO failure asking the question
/// is treated as **absent** — the same verdict a desktop `is_file()` gives for
/// an unreadable path, so the two arms agree on the lost-credentials gate rather
/// than diverging on a rare error.
pub(crate) async fn dispatch_empty_arm_via_io(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: PathBuf,
) -> Result<(), VaultDeleteError> {
    if io
        .exists(&vault_dir.join("vault.meta"))
        .await
        .unwrap_or(false)
    {
        tracing::debug!(
            stage = "slot_check",
            slot_arm = "empty_meta_exists",
            "vault_delete proceeding: slot empty, vault.meta present (no-keys path)"
        );
        let outcome = crate::vault_sweep::sweep_via_io(
            io,
            &vault_dir,
            crate::vault_sweep::RootDisposal::Remove,
        )
        .await;
        match sweep_outcome_to_delete_result(outcome) {
            Ok(()) => {
                tracing::info!(event = "vault_deleted", stage = "complete");
                Ok(())
            }
            Err(vd_err) => {
                report_delete_failure(&vd_err);
                Err(vd_err)
            }
        }
    } else {
        tracing::debug!(
            stage = "slot_check",
            error_kind = "VaultNotFound",
            "vault_delete rejected: slot empty and vault.meta absent"
        );
        Err(VaultDeleteError::VaultNotFound)
    }
}

/// The partial-fail / unexpected-error tracing both `via_io` arms emit.
///
/// Extracted rather than duplicated a third and fourth time: the payload is
/// DENY-list-clean by construction (a count and a variant name, never a path),
/// and having one writer of it is what keeps that true as arms are added.
fn report_delete_failure(vd_err: &VaultDeleteError) {
    if let VaultDeleteError::PartialDelete { remaining_count } = vd_err {
        tracing::warn!(
            event = "vault_delete_partial",
            remaining_count = *remaining_count,
            "vault_delete completed with partial-fail"
        );
    } else {
        tracing::warn!(
            stage = "unlink_pipeline",
            error_kind = vault_delete_error_kind(vd_err),
            "vault_delete unlink pipeline returned non-PartialDelete error"
        );
    }
}

/// Map the neutral [`crate::vault_sweep::SweepOutcome`] returned by the
/// shared sweep pipeline into a [`VaultDeleteError`] verdict: `Ok(())`
/// when the sweep removed everything, else
/// `VaultDeleteError::PartialDelete { remaining_count }`.
///
/// This is the seam that keeps the shared `vault_sweep` layer
/// plugin-agnostic — the sweep never knows about `VaultDeleteError`; this
/// thin mapper is `vault_delete`'s view of the outcome. `vault_repair`
/// (MYND-159) has its own equivalent mapper into `VaultRepairError`.
pub(crate) fn sweep_outcome_to_delete_result(
    outcome: crate::vault_sweep::SweepOutcome,
) -> Result<(), VaultDeleteError> {
    if outcome.is_complete() {
        Ok(())
    } else {
        Err(VaultDeleteError::PartialDelete {
            remaining_count: outcome.remaining_count(),
        })
    }
}

/// Static-string label helper for every [`VaultDeleteError`] variant.
///
/// Used by `tracing::*!(error_kind = vault_delete_error_kind(&e), ...)`
/// call sites so the variant name (a `&'static str`) crosses the
/// tracing boundary instead of a `?e` Debug formatting that could
/// drag DENY-listed values (paths, io::Error::Display) into log
/// payloads. Same drift-detector discipline as `note_delete_error_kind`
/// — adding a new variant compile-fails this match (the reviewer
/// must update the helper + the wire test).
///
/// Production caller: the `take_and_run_blocking` non-PartialDelete
/// future-proof branch in `vault_delete_with_dir` (Task 7).
pub(crate) fn vault_delete_error_kind(e: &VaultDeleteError) -> &'static str {
    match e {
        VaultDeleteError::VaultBusyAuth => "VaultBusyAuth",
        VaultDeleteError::VaultNotUnlocked => "VaultNotUnlocked",
        VaultDeleteError::VaultNotFound => "VaultNotFound",
        VaultDeleteError::PartialDelete { .. } => "PartialDelete",
        VaultDeleteError::Io { .. } => "Io",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io_failure_kind::IoFailureKind;
    use crate::plugins::vault_unlock::state::{test_vault_id, VaultRuntimeState};
    use crate::test_support::ScopedTempDir;

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

    // ---- Slot precondition matrix — rejection arms (Task 5) --------------

    /// Test that `vault_delete` rejects with `VaultBusyAuth` when the
    /// auth_permits semaphore is already taken by another in-flight
    /// op (simulated by acquiring the permit elsewhere first).
    /// `try_acquire` MUST reject rather than queue per the
    /// `decisions.md` 2026-05-02 + MYND-105 Q3-D3 "single in-flight,
    /// reject-not-queue" posture.
    #[test]
    fn vault_delete_returns_busy_auth_when_permit_taken() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-busy-auth").unwrap();
            let state = VaultRuntimeState::default();
            // Pre-acquire the single auth_permit; the guard's drop at
            // function end releases.
            let _held = state.auth_permits().acquire().await.unwrap();
            let result =
                vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;
            assert!(
                matches!(result, Err(VaultDeleteError::VaultBusyAuth)),
                "expected VaultBusyAuth, got {result:?}"
            );
        });
    }

    /// Test that `vault_delete` rejects with `VaultNotFound` when
    /// Slot is Empty AND vault.meta is missing on disk. The
    /// "idempotent no-op success" path was explicitly rejected per
    /// `decisions.md` 2026-05-26 entry "vault_delete Slot precondition
    /// matrix" — silent success would mask UI bugs and capability-ACL
    /// fuzz attempts (Q3-D1). Orphan-artefact sweeping is the v0.2
    /// `vault_repair` feature's responsibility (Plane MYND-159).
    #[test]
    fn vault_delete_returns_not_found_when_empty_and_no_vault_meta() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-not-found").unwrap();
            // Empty tempdir — no vault.meta, no notes/, no artefacts.
            let state = VaultRuntimeState::default();
            let result =
                vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;
            assert!(
                matches!(result, Err(VaultDeleteError::VaultNotFound)),
                "expected VaultNotFound, got {result:?}"
            );
        });
    }

    /// MYND-108-bis: Slot::Empty + vault.meta on disk is now the
    /// **happy path** for the lost-credentials cul-de-sac escape
    /// (Unlock screen tertiary link and Recovery phrase-entry footer
    /// link). The cryptographic-erase claim is structurally
    /// inapplicable on this arm (no keys in memory to zeroize); the
    /// user has lost both password and recovery phrase, so the
    /// on-disk Argon2id-wrapped keys are already computationally
    /// unrecoverable. Recursive unlink converts unrecoverable-bytes
    /// into no-bytes, strictly stronger.
    ///
    /// Test asserts: Ok(()) returned, vault directory gone, slot
    /// remains Empty (no state change since slot was already Empty
    /// entering the call). Was previously the
    /// `vault_delete_returns_not_unlocked_when_empty_with_vault_meta`
    /// rejection test; repurposed for the MYND-108-bis accept path.
    #[test]
    fn vault_delete_from_empty_with_meta_exists_succeeds() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-empty-meta-exists").unwrap();
            // Seed vault.meta + one note + tmp orphan (mimic a real
            // post-creation vault directory without unlocking).
            std::fs::write(tmp.path().join("vault.meta"), b"placeholder vault.meta bytes")
                .expect("seed vault.meta");
            let notes = tmp.path().join("notes");
            std::fs::create_dir_all(&notes).expect("seed notes/");
            std::fs::write(
                notes.join("0193e8d3-1234-7890-abcd-ef0123456789.myn"),
                b"placeholder ciphertext",
            )
            .expect("seed .myn");
            // Slot stays Empty — no set_unlocked / set_recovering call.
            let state = VaultRuntimeState::default();
            let result = vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;
            assert!(
                result.is_ok(),
                "MYND-108-bis: Empty + vault.meta-exists is the no-keys accept path; expected Ok, got {result:?}"
            );
            assert!(
                !tmp.path().exists(),
                "vault_dir must be removed by the no-keys recursive-unlink path"
            );
            // Slot was Empty entering the call and stays Empty exiting.
            assert_eq!(
                state.slot_kind(test_vault_id()).await,
                crate::plugins::vault_unlock::state::SlotKind::Empty,
                "slot was Empty entering and stays Empty exiting (no state change)"
            );
        });
    }

    /// Order-of-operations test: auth_permits gate fires BEFORE the
    /// slot peek. When the permit is taken AND the slot would
    /// otherwise produce `VaultNotFound`, the function MUST return
    /// `VaultBusyAuth` (not VaultNotFound). This pins the matrix
    /// order from MYND-105 grill Q3-D3 + Q3-D1.
    #[test]
    fn vault_delete_busy_auth_wins_over_not_found_when_both_apply() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-precedence").unwrap();
            let state = VaultRuntimeState::default();
            // Empty tempdir + slot Empty would normally produce
            // VaultNotFound. But we also hold the permit, so
            // VaultBusyAuth must win.
            let _held = state.auth_permits().acquire().await.unwrap();
            let result =
                vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;
            assert!(
                matches!(result, Err(VaultDeleteError::VaultBusyAuth)),
                "auth_permits check must run before slot peek; got {result:?}"
            );
        });
    }

    // ---- Happy-path matrix arms (Task 6) ---------------------------------

    /// R3 recovery-escape happy-path test: from `Slot::Recovering`
    /// fixture + populated vault dir, fires vault_delete_with_dir
    /// and asserts the same post-state as the Unlocked path —
    /// slot Empty (RecoveringMaterial zeroize fired), vault_dir
    /// gone. Verifies user stories 4, 5 (R3 escape).
    #[test]
    fn vault_delete_recovering_removes_dir_and_zeroizes_slot() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-happy-recovering").unwrap();
            std::fs::write(tmp.path().join("vault.meta"), b"meta").unwrap();
            let notes = tmp.path().join("notes");
            std::fs::create_dir_all(&notes).unwrap();
            std::fs::write(notes.join("0193e8d3-1234-7890-abcd-ef0123456789.myn"), b"x").unwrap();

            let state = VaultRuntimeState::default();
            state
                .set_recovering(
                    test_vault_id(),
                    crate::plugins::vault_unlock::state::fixture_recovering_with_keys(
                        0xAA, 0xBB, 0xCC,
                    ),
                )
                .await;

            let result =
                vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;
            assert!(
                result.is_ok(),
                "R3 happy-path Slot::Recovering must succeed; got {result:?}"
            );
            assert_eq!(
                state.slot_kind(test_vault_id()).await,
                crate::plugins::vault_unlock::state::SlotKind::Empty,
                "slot must be Empty after vault_delete (RecoveringMaterial zeroize fired)"
            );
            assert!(!tmp.path().exists(), "vault_dir must be removed");
        });
    }

    /// Task 9 strict-count L3 cascade test: chmod 0o555 on `notes/`
    /// produces a deterministic cascade of exactly 3 failures —
    /// (1) `notes/<uuid>.myn` unlink fails (notes/ is read-only),
    /// (2) `remove_dir(notes/)` fails (notes/ is non-empty because
    /// the .myn couldn't be removed), (3) `remove_dir(vault_dir)`
    /// fails (vault_dir is non-empty because notes/ couldn't be
    /// removed). `vault.meta` (directly under vault_dir) is removed
    /// successfully because vault_dir is writable.
    ///
    /// PRD Task 9 originally asked for `remaining_count == 1` from
    /// chmod-on-file, which is structurally unachievable on POSIX
    /// (see `vault_delete_chmod_on_myn_file_still_succeeds_posix_unlink_semantic`).
    /// The realistic strict-count assertion is `== 3` for the
    /// cascade topology — tighter than Task 7's `>= 1` end-to-end
    /// test. Regression detector if the walker semantics change.
    #[cfg(unix)]
    #[test]
    fn vault_delete_partial_fail_cascade_remains_count_exactly_three() {
        use std::os::unix::fs::PermissionsExt;

        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-l3-cascade").unwrap();
            std::fs::write(tmp.path().join("vault.meta"), b"meta").unwrap();
            let notes = tmp.path().join("notes");
            std::fs::create_dir_all(&notes).unwrap();
            std::fs::write(
                notes.join("0193e8d3-1234-7890-abcd-ef0123456789.myn"),
                b"x",
            )
            .unwrap();
            // chmod 0o555 on notes/ — read+exec but not write.
            // .myn unlink fails. Cascades upward (notes/, vault_dir).
            let mut perms = std::fs::metadata(&notes).unwrap().permissions();
            perms.set_mode(0o555);
            std::fs::set_permissions(&notes, perms).unwrap();

            let state = VaultRuntimeState::default();
            state
                .set_unlocked(test_vault_id(),
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(1, 2, 3),
                )
                .await;

            let result = vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;

            // Restore notes/ permissions BEFORE assertions so the
            // tempdir teardown can succeed regardless of assertion
            // outcome.
            let mut restore = std::fs::metadata(&notes).unwrap().permissions();
            restore.set_mode(0o755);
            let _ = std::fs::set_permissions(&notes, restore);

            // Exact cascade count: .myn unlink + remove_dir(notes/) +
            // remove_dir(vault_dir) = 3 failures.
            match result {
                Err(VaultDeleteError::PartialDelete { remaining_count }) => {
                    assert_eq!(
                        remaining_count, 3,
                        "expected cascade of exactly 3 failures (.myn + notes/ + vault_dir), got {remaining_count}"
                    );
                }
                other => panic!("expected PartialDelete{{3}}, got {other:?}"),
            }
            // Slot zeroize fired before walk — slot must be Empty
            // despite the unlink cascade failure.
            assert_eq!(
                state.slot_kind(test_vault_id()).await,
                crate::plugins::vault_unlock::state::SlotKind::Empty,
                "key zeroize must precede unlink, regardless of unlink outcome"
            );
            // vault.meta was directly under vault_dir (writable) — it
            // should have been successfully removed before the
            // cascade started.
            assert!(
                !tmp.path().join("vault.meta").exists(),
                "vault.meta should be removed (vault_dir is writable; only notes/ is the read-only barrier)"
            );
        });
    }

    /// Task 9 L3 integration test: chmod 0o000 directly on the .myn
    /// file under a writable notes/ parent. Documents the empirical
    /// finding that POSIX `unlink(2)` requires write permission on
    /// the **parent directory**, not on the file itself — so chmod
    /// on the file alone does NOT block deletion. Result: vault is
    /// fully removed (Ok), `remaining_count` is 0, no PartialDelete.
    ///
    /// The PRD's Task 9 spec called for `PartialDelete{remaining_count: 1}`
    /// from this setup, but that's structurally unachievable on POSIX.
    /// Task 7's `vault_delete_partial_fail_emits_partial_event_and_returns_partial_delete`
    /// (chmod 0o555 on notes/ — parent-dir injection) provides the
    /// realistic L3 partial-fail coverage. This test exists as the
    /// codified empirical evidence and as a regression detector if
    /// the walk's unlink semantics ever change.
    #[cfg(unix)]
    #[test]
    fn vault_delete_chmod_on_myn_file_still_succeeds_posix_unlink_semantic() {
        use std::os::unix::fs::PermissionsExt;

        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-l3-file-chmod").unwrap();
            std::fs::write(tmp.path().join("vault.meta"), b"meta").unwrap();
            let notes = tmp.path().join("notes");
            std::fs::create_dir_all(&notes).unwrap();
            let myn = notes.join("0193e8d3-1234-7890-abcd-ef0123456789.myn");
            std::fs::write(&myn, b"x").unwrap();
            // chmod 0o000 on the .myn file — POSIX unlink does NOT
            // check this; it checks the parent dir's write perm.
            let mut perms = std::fs::metadata(&myn).unwrap().permissions();
            perms.set_mode(0o000);
            std::fs::set_permissions(&myn, perms).unwrap();

            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(1, 2, 3),
                )
                .await;

            let result =
                vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;

            // POSIX semantic: vault is fully removed despite file chmod.
            assert!(
                result.is_ok(),
                "POSIX unlink ignores file perms; expected full Ok, got {result:?}"
            );
            assert!(
                !tmp.path().exists(),
                "vault_dir must be removed (POSIX unlink succeeded despite chmod 0o000 on file)"
            );
        });
    }

    /// Partial-fail end-to-end test: synthetic chmod injection on
    /// the .myn file (Unix-only) produces a partial-fail outcome,
    /// `PartialDelete{remaining_count: 1}`, AND the `vault_delete_partial`
    /// summary event fires with the right count. This is an
    /// end-to-end smoke for Task 7 — Task 9 will land a more
    /// comprehensive Unix-only integration test.
    #[cfg(unix)]
    #[test]
    #[tracing_test::traced_test]
    fn vault_delete_partial_fail_emits_partial_event_and_returns_partial_delete() {
        use std::os::unix::fs::PermissionsExt;

        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-partial-event").unwrap();
            // Populate vault.meta + one .myn note.
            std::fs::write(tmp.path().join("vault.meta"), b"meta").unwrap();
            let notes = tmp.path().join("notes");
            std::fs::create_dir_all(&notes).unwrap();
            let myn = notes.join("0193e8d3-1234-7890-abcd-ef0123456789.myn");
            std::fs::write(&myn, b"x").unwrap();
            // Make notes/ read-only so remove_file on myn fails with
            // PermissionDenied. (The myn file itself stays writable —
            // we need the parent dir to be unwritable to block unlink.)
            let mut perms = std::fs::metadata(&notes).unwrap().permissions();
            perms.set_mode(0o555);
            std::fs::set_permissions(&notes, perms).unwrap();

            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(1, 2, 3),
                )
                .await;

            let result =
                vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;

            // Restore notes/ permissions so the test fixture's Drop
            // can clean up.
            let mut restore = std::fs::metadata(&notes).unwrap().permissions();
            restore.set_mode(0o755);
            let _ = std::fs::set_permissions(&notes, restore);

            // Expect PartialDelete; remaining_count depends on what
            // could and couldn't be unlinked (the .myn under
            // read-only notes/ is the at-least-one definite failure).
            match result {
                Err(VaultDeleteError::PartialDelete { remaining_count }) => {
                    assert!(remaining_count >= 1, "expected at least one failed file");
                }
                other => panic!("expected PartialDelete, got {other:?}"),
            }
            // Slot zeroize fired before the unlink — slot must be Empty.
            assert_eq!(
                state.slot_kind(test_vault_id()).await,
                crate::plugins::vault_unlock::state::SlotKind::Empty,
                "key zeroize must precede unlink failure"
            );
            assert!(
                logs_contain("event=\"vault_delete_partial\""),
                "expected vault_delete_partial summary event in tracing"
            );
            // NOTE: per-file `unlink_blob` events fire INSIDE the
            // spawn_blocking thread, outside this test's span scope.
            // `tracing_test::traced_test` only captures events emitted
            // from within the test's span — so the per-file emission
            // is verified by the L2 unit tests
            // (`emit_per_unlink_failure_trace_emits_*`) which call the
            // helper directly without spawning. The summary event is
            // captured because it fires post-await in the test's async
            // scope.
        });
    }

    /// MYND-108-bis no-keys partial-fail integration test: Slot::Empty
    /// + chmod 0o555 on notes/ produces the same 3-failure cascade
    /// as the Unlocked-path equivalent
    /// (`vault_delete_partial_fail_cascade_remains_count_exactly_three`),
    /// proving the shared `unlink_walk` pipeline is reused correctly
    /// from the no-keys path. PartialDelete + count assertion via
    /// `vault_delete_partial` summary event.
    #[cfg(unix)]
    #[test]
    #[tracing_test::traced_test]
    fn vault_delete_from_empty_partial_fail_returns_partial() {
        use std::os::unix::fs::PermissionsExt;

        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-empty-partial").unwrap();
            std::fs::write(tmp.path().join("vault.meta"), b"meta").unwrap();
            let notes = tmp.path().join("notes");
            std::fs::create_dir_all(&notes).unwrap();
            std::fs::write(notes.join("0193e8d3-1234-7890-abcd-ef0123456789.myn"), b"x").unwrap();
            let mut perms = std::fs::metadata(&notes).unwrap().permissions();
            perms.set_mode(0o555);
            std::fs::set_permissions(&notes, perms).unwrap();

            // Slot stays Empty entering the call — MYND-108-bis path.
            let state = VaultRuntimeState::default();
            let result =
                vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;

            // Restore notes/ permissions for tempdir teardown.
            let mut restore = std::fs::metadata(&notes).unwrap().permissions();
            restore.set_mode(0o755);
            let _ = std::fs::set_permissions(&notes, restore);

            match result {
                Err(VaultDeleteError::PartialDelete { remaining_count }) => {
                    assert!(
                        remaining_count >= 1,
                        "expected at least one failed file in the no-keys partial-fail cascade"
                    );
                }
                other => panic!("expected PartialDelete from no-keys path, got {other:?}"),
            }
            assert!(
                logs_contain("event=\"vault_delete_partial\""),
                "expected vault_delete_partial summary event from no-keys path"
            );
            // vault.meta was directly under vault_dir (writable) so
            // it should have been unlinked before the cascade.
            assert!(
                !tmp.path().join("vault.meta").exists(),
                "vault.meta should be removed (vault_dir writable; only notes/ is the barrier)"
            );
        });
    }

    /// Verify the `vault_deleted` tracing event is emitted on
    /// successful unlink, with no DENY-list payload (no path, no
    /// account identifier, no key material, no kernel error strings).
    #[test]
    #[tracing_test::traced_test]
    fn vault_delete_success_emits_vault_deleted_event() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-success-trace").unwrap();
            std::fs::write(tmp.path().join("vault.meta"), b"x").unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(1, 2, 3),
                )
                .await;
            let _ = vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;
            assert!(
                logs_contain("event=\"vault_deleted\""),
                "expected vault_deleted event in tracing on success"
            );
            assert!(
                logs_contain("stage=\"complete\""),
                "expected stage=complete in tracing on success"
            );
            // Path string must NOT appear (DENY-list discipline).
            let path_str = tmp.path().to_string_lossy().to_string();
            assert!(
                !logs_contain(&path_str),
                "vault_dir path leaked into tracing payload (DENY-list violation)"
            );
        });
    }

    /// MYND-160 Task 8 extension: `vault_delete` must remove
    /// `vault.prefs` + `vault.prefs.tmp` alongside the existing
    /// vault.meta / vault.meta.tmp / notes/*.myn artefact set. The
    /// recursive `walk_and_remove` walker is artefact-agnostic by
    /// design — this test pins the behavior so a future refactor that
    /// introduces a hard-coded artefact allow-list cannot silently
    /// orphan vault.prefs. Verifies user stories 9 (delete cleans up
    /// vault.prefs) and 10 (defensive guard catches orphan vault.prefs
    /// on next vault_create — coupled with the
    /// `vault_artifacts_present_returns_true_when_vault_prefs_present`
    /// test in the vault_creation suite).
    #[test]
    fn vault_delete_unlocked_removes_vault_prefs_and_vault_prefs_tmp() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-prefs").unwrap();
            // Populate the full v0.1 artefact set including MYND-160's
            // vault.prefs + vault.prefs.tmp.
            std::fs::write(tmp.path().join("vault.meta"), b"meta bytes").unwrap();
            std::fs::write(tmp.path().join("vault.prefs"), b"prefs bytes").unwrap();
            std::fs::write(
                tmp.path().join("vault.prefs.tmp"),
                b"mid-write prefs crash artefact",
            )
            .unwrap();

            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(11, 22, 1),
                )
                .await;

            let result =
                vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;

            assert!(
                result.is_ok(),
                "vault_delete must succeed with MYND-160 artefact set; got {result:?}"
            );
            assert!(
                !tmp.path().join("vault.prefs").exists(),
                "vault.prefs must be removed by vault_delete"
            );
            assert!(
                !tmp.path().join("vault.prefs.tmp").exists(),
                "vault.prefs.tmp must be removed by vault_delete"
            );
            assert!(
                !tmp.path().exists(),
                "vault_dir must be removed recursively (full MYND-160 artefact set + dir itself)"
            );
        });
    }

    /// MYND-169: `vault_delete` removes `vault.attachments` + the
    /// `attachments/` blob directory alongside the existing artefact set.
    /// The recursive `vault_sweep::sweep` walker is artefact-agnostic by
    /// design — this test pins the behaviour so a future refactor that
    /// introduces a hard-coded artefact allow-list cannot silently orphan
    /// the catalog or the blobs (the partner of the
    /// `vault_artifacts_present_returns_true_when_vault_attachments_present`
    /// guard test in the vault_creation suite).
    #[test]
    fn vault_delete_unlocked_removes_vault_attachments_and_blobs() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-attach").unwrap();
            std::fs::write(tmp.path().join("vault.meta"), b"meta bytes").unwrap();
            std::fs::write(tmp.path().join("vault.attachments"), b"catalog bytes").unwrap();
            let attach = tmp.path().join("attachments");
            std::fs::create_dir_all(&attach).unwrap();
            std::fs::write(attach.join("deadbeefcafef00d"), b"blob bytes").unwrap();

            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(11, 22, 1),
                )
                .await;

            let result =
                vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;
            assert!(
                result.is_ok(),
                "vault_delete must succeed with the MYND-169 artefact set; got {result:?}"
            );
            assert!(
                !tmp.path().join("vault.attachments").exists(),
                "vault.attachments must be removed by vault_delete"
            );
            assert!(
                !attach.exists(),
                "attachments/ dir + its blobs must be removed by vault_delete"
            );
            assert!(
                !tmp.path().exists(),
                "vault_dir must be removed recursively (full MYND-169 artefact set)"
            );
        });
    }

    /// Happy-path test: from `Slot::Unlocked` fixture + populated
    /// vault directory (vault.meta + notes/<uuid>.myn + vault.meta.tmp
    /// orphan from mid-write crash), fires `vault_delete_with_dir`
    /// and asserts: Ok(()), slot is now Empty, vault_dir gone.
    /// Verifies user stories 1, 2, 3, 12 (vault.meta.tmp removal).
    #[test]
    fn vault_delete_unlocked_removes_dir_and_zeroizes_slot() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-happy-unlocked").unwrap();
            // Populate a realistic vault directory.
            std::fs::write(tmp.path().join("vault.meta"), b"meta bytes").unwrap();
            std::fs::write(tmp.path().join("vault.meta.tmp"), b"mid-write crash artefact").unwrap();
            let notes = tmp.path().join("notes");
            std::fs::create_dir_all(&notes).unwrap();
            std::fs::write(notes.join("0193e8d3-1234-7890-abcd-ef0123456789.myn"), b"note").unwrap();

            let state = VaultRuntimeState::default();
            state
                .set_unlocked(test_vault_id(),
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(7, 9, 1),
                )
                .await;

            let result = vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;

            assert!(result.is_ok(), "happy-path Slot::Unlocked must succeed; got {result:?}");
            assert_eq!(
                state.slot_kind(test_vault_id()).await,
                crate::plugins::vault_unlock::state::SlotKind::Empty,
                "slot must be Empty after vault_delete (UnlockedVault zeroize-on-drop fired)"
            );
            assert!(
                !tmp.path().exists(),
                "vault_dir must be removed recursively (vault.meta + vault.meta.tmp + notes/*.myn + notes/ dir + vault_dir itself)"
            );
        });
    }

    // ---- the storage-seam sibling (phase3-web-client task 72) -------------
    //
    // Driven against the REAL native `VaultIo` rather than a double, for the
    // same reason `vault_sweep`'s via_io tests are: a double would agree with
    // whatever this arm does, and the property under test is that the two arms
    // agree with EACH OTHER. The web arm's `VaultIo` is a different
    // implementation of the same trait, so what these pin is the plugin logic
    // above the seam — the slot matrix, the empty-arm dispatch, the partial-fail
    // mapping — which is all of it that is not the seam's own job.

    const IO: crate::vault_io::StdVaultIo = crate::vault_io::StdVaultIo;

    /// Build a realistic vault directory: metadata, a note, and the mid-write
    /// `.tmp` orphan a crash leaves behind.
    fn seed_vault(dir: &std::path::Path) {
        std::fs::create_dir_all(dir.join("notes")).unwrap();
        std::fs::write(dir.join("vault.meta"), b"meta bytes").unwrap();
        std::fs::write(dir.join("vault.meta.tmp"), b"mid-write crash artefact").unwrap();
        std::fs::write(
            dir.join("notes")
                .join("0193e8d3-1234-7890-abcd-ef0123456789.myn"),
            b"note",
        )
        .unwrap();
    }

    #[test]
    fn via_io_removes_the_dir_and_zeroizes_the_slot() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-via-io-happy").unwrap();
            seed_vault(tmp.path());
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(7, 9, 1),
                )
                .await;

            let result =
                vault_delete_via_io(&IO, tmp.path().to_path_buf(), test_vault_id(), &state).await;

            assert!(result.is_ok(), "happy path must succeed; got {result:?}");
            assert_eq!(
                state.slot_kind(test_vault_id()).await,
                crate::plugins::vault_unlock::state::SlotKind::Empty,
                "the slot must be Empty — the zeroize fired before the erase"
            );
            assert!(!tmp.path().exists(), "the vault directory must be gone");
        });
    }

    /// phase3-web-client task 37: the erase clears this browser's **device
    /// identity**, not only its content.
    ///
    /// Task 37 splits two lifetimes deliberately — the bearer token never
    /// touches storage (`SessionTokenStore`), while `device_id` persists in
    /// `sync-state.json` so a reload does not mint a new pending device. That
    /// second half is a durable identifier on a machine that may not be the
    /// user's, and the thing that makes it acceptable is that "sign out and
    /// erase this browser's copy" (task 72) removes it. So the erase owes an
    /// assertion, not an inference from "the sweep is recursive".
    ///
    /// Seeded with the whole device-local sync bookkeeping set — both
    /// double-buffer copies of `sync-state.json` (task 18 writes `.a`/`.b`, and a
    /// sweep that removed only a bare `sync-state.json` would leave the identity
    /// sitting in a buffer file), the config, and the token file a NATIVE session
    /// leaves behind. That last one matters for a reason worth stating: the
    /// browser never writes `sync-token`, but a vault directory can be a desktop
    /// one, and an erase that spared it would be leaving a credential behind on
    /// the path whose whole promise is that it does not.
    #[test]
    fn via_io_erase_clears_the_device_identity_and_the_sync_bookkeeping() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-via-io-device-id").unwrap();
            seed_vault(tmp.path());
            // `device_id_hex` is the identifier task 37 decided to persist.
            for suffix in ["", ".a", ".b"] {
                std::fs::write(
                    tmp.path().join(format!("sync-state.json{suffix}")),
                    br#"{"device_id_hex":"0123456789abcdef0123456789abcdef"}"#,
                )
                .unwrap();
            }
            std::fs::write(tmp.path().join("sync-config.json"), b"{}").unwrap();
            std::fs::write(tmp.path().join("sync-token"), b"a native session's token").unwrap();

            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    test_vault_id(),
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(7, 9, 1),
                )
                .await;

            let result =
                vault_delete_via_io(&IO, tmp.path().to_path_buf(), test_vault_id(), &state).await;

            assert!(result.is_ok(), "erase must succeed; got {result:?}");
            // Named individually rather than resting on `!tmp.path().exists()`:
            // the failure this guards against is a future artefact allow-list,
            // and an allow-list failure shows up as a surviving FILE, which a
            // directory-level assertion reports as "the directory is still
            // there" without saying what is in it.
            for leftover in [
                "sync-state.json",
                "sync-state.json.a",
                "sync-state.json.b",
                "sync-config.json",
                "sync-token",
            ] {
                assert!(
                    !tmp.path().join(leftover).exists(),
                    "{leftover} must not survive the erase — task 37's device_id is only \
                     acceptable as a persisted identifier because this removes it"
                );
            }
            assert!(!tmp.path().exists(), "the vault directory must be gone");
        });
    }

    /// The MYND-108-bis lost-credentials arm, through the seam: no keys to
    /// zeroize, `vault.meta` on disk, so the erase proceeds.
    #[test]
    fn via_io_accepts_an_empty_slot_when_vault_meta_exists() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-via-io-empty-meta").unwrap();
            seed_vault(tmp.path());
            let state = VaultRuntimeState::default();

            let result =
                vault_delete_via_io(&IO, tmp.path().to_path_buf(), test_vault_id(), &state).await;

            assert!(
                result.is_ok(),
                "empty + meta-exists must accept; got {result:?}"
            );
            assert!(!tmp.path().exists());
        });
    }

    /// …and rejects when there is nothing on disk, rather than reporting a
    /// silent no-op success. On web this is the reachable case: a browser that
    /// was evicted has no container, and telling the user "erased" would be a
    /// lie about state they cannot see.
    #[test]
    fn via_io_rejects_an_empty_slot_with_nothing_on_disk() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-via-io-nothing").unwrap();
            std::fs::create_dir_all(tmp.path().join("notes")).unwrap();
            let state = VaultRuntimeState::default();

            let result =
                vault_delete_via_io(&IO, tmp.path().to_path_buf(), test_vault_id(), &state).await;

            assert!(matches!(result, Err(VaultDeleteError::VaultNotFound)));
            assert!(
                tmp.path().exists(),
                "a rejected delete must leave storage untouched"
            );
        });
    }

    #[test]
    fn via_io_rejects_when_another_auth_op_holds_the_permit() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-via-io-busy").unwrap();
            seed_vault(tmp.path());
            let state = VaultRuntimeState::default();
            let _held = state.auth_permits().try_acquire().expect("permit is free");

            let result =
                vault_delete_via_io(&IO, tmp.path().to_path_buf(), test_vault_id(), &state).await;

            assert!(matches!(result, Err(VaultDeleteError::VaultBusyAuth)));
            assert!(tmp.path().exists(), "a rejected delete touches nothing");
        });
    }

    /// The agreement test. Two identical vault trees, one deleted each way,
    /// must reach the same end state — which is the claim that lets the web
    /// client reuse this plugin instead of growing its own.
    #[test]
    fn via_io_agrees_with_the_blocking_arm_on_the_same_tree() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-via-io-agree").unwrap();
            let a = tmp.path().join("a");
            let b = tmp.path().join("b");
            seed_vault(&a);
            seed_vault(&b);

            let state_a = VaultRuntimeState::default();
            state_a
                .set_unlocked(
                    test_vault_id(),
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(7, 9, 1),
                )
                .await;
            let state_b = VaultRuntimeState::default();
            state_b
                .set_unlocked(
                    test_vault_id(),
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(7, 9, 1),
                )
                .await;

            let blocking = vault_delete_with_dir(a.clone(), test_vault_id(), &state_a).await;
            let via_io = vault_delete_via_io(&IO, b.clone(), test_vault_id(), &state_b).await;

            assert_eq!(
                format!("{blocking:?}"),
                format!("{via_io:?}"),
                "the two arms must return the same verdict on the same tree"
            );
            assert!(!a.exists() && !b.exists(), "both trees must be gone");
            assert_eq!(
                state_a.slot_kind(test_vault_id()).await,
                state_b.slot_kind(test_vault_id()).await,
            );
        });
    }

    // ---- MYND-205: VaultId-targeted erase leaves siblings untouched -------

    /// SYNC-6 explicit-id targeting: `vault_delete_with_dir` erases EXACTLY the
    /// resolved `vaults/<id>/` for the targeted `VaultId` and leaves any sibling
    /// `vaults/<other>/` directory completely untouched. Models the multi-vault
    /// danger-zone delete where vault A is the active (sole `Unlocked`) vault and
    /// vault B is a never-opened-this-session sibling that must survive. Two
    /// physically-separate vault roots under a shared `vaults/` parent stand in
    /// for the on-disk layout; the per-`VaultId` slot peek + the keyed
    /// `take_and_run_blocking_for_id` together guarantee only the targeted slot
    /// is zeroized and only the targeted directory is unlinked.
    #[test]
    fn vault_delete_targets_named_vault_and_leaves_sibling_untouched() {
        use crate::vault_id::VaultId;

        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-sibling-untouched").unwrap();
            let vaults = tmp.path().join("vaults");

            // Two well-formed vault roots side by side under `vaults/`.
            let id_a = VaultId::mint();
            let id_b = VaultId::mint();
            let dir_a = vaults.join(id_a.to_string());
            let dir_b = vaults.join(id_b.to_string());
            for dir in [&dir_a, &dir_b] {
                std::fs::create_dir_all(dir.join("notes")).unwrap();
                std::fs::write(dir.join("vault.meta"), b"meta bytes").unwrap();
                std::fs::write(
                    dir.join("notes")
                        .join("0193e8d3-1234-7890-abcd-ef0123456789.myn"),
                    b"ciphertext",
                )
                .unwrap();
            }

            // Vault A is the active (sole `Unlocked`) vault; vault B stays a
            // sibling with no runtime slot (locked / never opened this session).
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    id_a,
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(7, 9, 1),
                )
                .await;

            // Delete A by its explicit id, resolving to A's own root.
            let result = vault_delete_with_dir(dir_a.clone(), id_a, &state).await;
            assert!(
                result.is_ok(),
                "targeted delete of the active vault must succeed; got {result:?}"
            );

            // A's directory is gone; A's slot zeroized to Empty.
            assert!(
                !dir_a.exists(),
                "the targeted vaults/<id_a>/ must be removed"
            );
            assert_eq!(
                state.slot_kind(id_a).await,
                crate::plugins::vault_unlock::state::SlotKind::Empty,
                "the targeted vault's slot must be Empty (keys zeroized)"
            );

            // The sibling B is COMPLETELY untouched — directory, vault.meta, blob.
            assert!(dir_b.exists(), "the sibling vaults/<id_b>/ must remain");
            assert!(
                dir_b.join("vault.meta").is_file(),
                "the sibling's vault.meta must remain"
            );
            assert!(
                dir_b
                    .join("notes")
                    .join("0193e8d3-1234-7890-abcd-ef0123456789.myn")
                    .is_file(),
                "the sibling's note blob must remain"
            );
        });
    }

    // ---- myne-md/myne#411: the sealed label survives nothing --------------
    //
    // The recursive unlink above removes `vault.label` with the rest of the
    // tree, and that is NOT the erase. Deleted bytes stay recoverable from the
    // medium (`decisions.md` 2026-05-07, which rejected platform-specific
    // secure-delete for the project), so a surviving wrap key would leave the
    // deleted vault's name readable to anyone who can reach the disk. The name
    // is the one artefact of a vault a person actually recognises, so that
    // would weaken the per-`VaultId` cryptographic-erase guarantee in its most
    // visible place.

    /// A `<app_data_dir>/vaults/<id>/` a host-taking delete can resolve, with a
    /// `vault.meta` when `well_formed`.
    fn seeded_vault(
        base: &std::path::Path,
        id: crate::vault_id::VaultId,
        well_formed: bool,
    ) -> std::path::PathBuf {
        let dir = base.join("vaults").join(id.to_string());
        std::fs::create_dir_all(&dir).expect("vault root");
        if well_formed {
            std::fs::write(dir.join("vault.meta"), b"meta bytes").expect("seed vault.meta");
        }
        dir
    }

    #[test]
    fn deleting_a_vault_destroys_its_sealed_label_key_and_not_only_its_file() {
        use crate::vault_id::VaultId;
        use crate::vault_label::fake_keychain::FakeKeychain;
        use crate::vault_label::store::write_label;

        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-label-erase").unwrap();
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let base = host.app_data_dir().expect("test host data dir");
            let id = VaultId::mint();
            let dir = seeded_vault(&base, id, true);

            let keychain = FakeKeychain::empty();
            write_label(&crate::vault_io::StdVaultIo, &dir, id, "Work", &keychain)
                .await
                .expect("seed the cached name");
            assert!(keychain.read(&id.to_string()).is_some(), "key seeded");

            let hooks: crate::hooks::Hooks = std::sync::Arc::new(crate::hooks::NoopHooks);
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    id,
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(7, 9, 1),
                )
                .await;

            let secret_keychain = device_secret::fake::FakeDeviceSecretKeychain::empty();
            vault_delete_from_host(
                &state,
                &hooks,
                &host,
                &crate::vault_io::StdVaultIo,
                id.to_string(),
                &keychain,
                &secret_keychain,
            )
            .await
            .expect("delete");

            assert!(!dir.exists(), "the vault tree is gone");
            assert!(
                keychain.read(&id.to_string()).is_none(),
                "the sealed-label wrap key survived the delete. Removing the file \
                 alone is not an erase: the ciphertext stays recoverable from the \
                 medium, and a live key over it reads out the deleted vault's name."
            );
        });
    }

    #[test]
    fn deleting_one_vault_leaves_another_vaults_cached_name_readable() {
        use crate::vault_id::VaultId;
        use crate::vault_label::fake_keychain::FakeKeychain;
        use crate::vault_label::store::{read_label, write_label, LabelRead};

        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-label-erase-scoped").unwrap();
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let base = host.app_data_dir().expect("test host data dir");
            let id_a = VaultId::mint();
            let id_b = VaultId::mint();
            let dir_a = seeded_vault(&base, id_a, true);
            let dir_b = seeded_vault(&base, id_b, true);

            let keychain = FakeKeychain::empty();
            for (dir, id, name) in [(&dir_a, id_a, "Work"), (&dir_b, id_b, "Personal")] {
                write_label(&crate::vault_io::StdVaultIo, dir, id, name, &keychain)
                    .await
                    .expect("seed");
            }

            let hooks: crate::hooks::Hooks = std::sync::Arc::new(crate::hooks::NoopHooks);
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    id_a,
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(7, 9, 1),
                )
                .await;

            let secret_keychain = device_secret::fake::FakeDeviceSecretKeychain::empty();
            vault_delete_from_host(
                &state,
                &hooks,
                &host,
                &crate::vault_io::StdVaultIo,
                id_a.to_string(),
                &keychain,
                &secret_keychain,
            )
            .await
            .expect("delete A");

            assert!(keychain.read(&id_a.to_string()).is_none());
            assert_eq!(
                read_label(&crate::vault_io::StdVaultIo, &dir_b, id_b, &keychain)
                    .await
                    .expect("read B"),
                LabelRead::Label(String::from("Personal")),
                "deleting one vault must not make another's name unreadable"
            );
        });
    }

    // ---- myne-md/myne#761: the OTHER per-vault keychain secret --------------
    //
    // `forget_label` above destroys `md.myne.vaultlabel`'s item. The owner
    // quick-unlock biometric wrap key and the member-vault biometric wrap key
    // live at `md.myne.quickunlock` under `hex(account_number_hash):vault_id`,
    // and until this change nothing removed them: the recursive unlink takes the
    // `MYQ1` blob and the member-unlock store, and leaves the wrap key that
    // opens neither. `design-notes/security/0709` is the class rule.

    /// A `<app_data_dir>/vaults/<id>/` whose `vault.meta` is REAL and parses, so
    /// the teardown can derive the keychain account component. `seeded_vault`
    /// writes a placeholder that does not parse, which is the state in which the
    /// item genuinely cannot be addressed.
    fn seeded_vault_with_account(
        base: &std::path::Path,
        id: crate::vault_id::VaultId,
        account_number_hash: [u8; 16],
    ) -> std::path::PathBuf {
        let dir = base.join("vaults").join(id.to_string());
        std::fs::create_dir_all(&dir).expect("vault root");
        let meta = protocol::VaultMeta {
            account_number_hash,
            kdf_params: crate::test_support::FAST_TEST_KDF,
            random_salt_password: [1u8; 16],
            random_salt_recovery: [2u8; 16],
            nonce_password_wrap: [3u8; 24],
            enc_root_key_password: [4u8; 64],
            nonce_recovery_wrap: [5u8; 24],
            enc_root_key_recovery: [6u8; 64],
            items_key_id: [7u8; 16],
            items_key_nonce: [8u8; 24],
            enc_items_key: [9u8; 64],
            membership: None,
            person_binding: None,
        };
        std::fs::write(
            dir.join("vault.meta"),
            protocol::serialize_vault_meta(&meta),
        )
        .expect("seed a parseable vault.meta");
        dir
    }

    #[test]
    fn deleting_a_vault_destroys_its_quick_unlock_and_member_biometric_item() {
        use crate::vault_id::VaultId;
        use crate::vault_label::fake_keychain::FakeKeychain;

        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-device-secret-erase").unwrap();
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let base = host.app_data_dir().expect("test host data dir");
            let id = VaultId::mint();
            const HASH: [u8; 16] = [0xab; 16];
            let dir = seeded_vault_with_account(&base, id, HASH);

            // The one address both the owner quick-unlock and the member-vault
            // biometric wrap keys occupy; seeding either is seeding this.
            let account = device_secret::account_component(&HASH, id);
            let secret_keychain = device_secret::fake::FakeDeviceSecretKeychain::empty();
            secret_keychain.put(&account, &[0x5a; 32]);

            let keychain = FakeKeychain::empty();
            let hooks: crate::hooks::Hooks = std::sync::Arc::new(crate::hooks::NoopHooks);
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    id,
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(7, 9, 1),
                )
                .await;

            vault_delete_from_host(
                &state,
                &hooks,
                &host,
                &crate::vault_io::StdVaultIo,
                id.to_string(),
                &keychain,
                &secret_keychain,
            )
            .await
            .expect("delete");

            assert!(!dir.exists(), "the vault tree is gone");
            assert!(
                secret_keychain.read(&account).is_none(),
                "the per-vault quick-unlock / member-biometric wrap key survived \
                 the delete. The blob it wrapped is gone with the directory, but \
                 the secret is still in the keychain the erase path claims to \
                 have cleaned."
            );
        });
    }

    #[test]
    fn deleting_one_vault_leaves_another_vaults_quick_unlock_item() {
        // Per-vault scoping, asserted by reading the keychain back rather than
        // by trusting the call returned Ok: two vaults of ONE account, which is
        // the KeepBoth-restore shape the account component's vault half exists
        // for.
        use crate::vault_id::VaultId;
        use crate::vault_label::fake_keychain::FakeKeychain;

        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-device-secret-scoped").unwrap();
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let base = host.app_data_dir().expect("test host data dir");
            let id_a = VaultId::mint();
            let id_b = VaultId::mint();
            const HASH: [u8; 16] = [0xcd; 16];
            let dir_a = seeded_vault_with_account(&base, id_a, HASH);
            let dir_b = seeded_vault_with_account(&base, id_b, HASH);
            let account_a = device_secret::account_component(&HASH, id_a);
            let account_b = device_secret::account_component(&HASH, id_b);
            assert_ne!(account_a, account_b, "twin vaults, distinct items");
            let secret_keychain = device_secret::fake::FakeDeviceSecretKeychain::empty();
            secret_keychain.put(&account_a, &[0x5a; 32]);
            secret_keychain.put(&account_b, &[0x6b; 32]);

            let keychain = FakeKeychain::empty();
            let hooks: crate::hooks::Hooks = std::sync::Arc::new(crate::hooks::NoopHooks);
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    id_a,
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(7, 9, 1),
                )
                .await;

            vault_delete_from_host(
                &state,
                &hooks,
                &host,
                &crate::vault_io::StdVaultIo,
                id_a.to_string(),
                &keychain,
                &secret_keychain,
            )
            .await
            .expect("delete A");

            assert!(secret_keychain.read(&account_a).is_none());
            assert!(!dir_a.exists(), "A's directory is gone");
            assert_eq!(
                secret_keychain.read(&account_b),
                Some(vec![0x6b; 32]),
                "deleting one vault must not destroy another vault's fast-unlock key"
            );
            assert!(dir_b.exists(), "and B's directory is untouched");
        });
    }

    #[test]
    fn a_rejected_delete_does_not_destroy_the_quick_unlock_item() {
        // The `matches!(result, Ok | PartialDelete)` gate seen from this secret's
        // side: a delete refused because another auth op holds the permit left a
        // live vault standing, and destroying its fast-unlock key would strand
        // that vault's next quick-unlock on the password path for no reason.
        use crate::vault_id::VaultId;
        use crate::vault_label::fake_keychain::FakeKeychain;

        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-device-secret-rejected").unwrap();
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let base = host.app_data_dir().expect("test host data dir");
            let id = VaultId::mint();
            const HASH: [u8; 16] = [0xef; 16];
            let dir = seeded_vault_with_account(&base, id, HASH);

            let account = device_secret::account_component(&HASH, id);
            let secret_keychain = device_secret::fake::FakeDeviceSecretKeychain::empty();
            secret_keychain.put(&account, &[0x5a; 32]);

            let keychain = FakeKeychain::empty();
            let hooks: crate::hooks::Hooks = std::sync::Arc::new(crate::hooks::NoopHooks);
            let state = VaultRuntimeState::default();
            let _held = state.auth_permits().acquire().await.unwrap();

            assert!(
                matches!(
                    vault_delete_from_host(
                        &state,
                        &hooks,
                        &host,
                        &crate::vault_io::StdVaultIo,
                        id.to_string(),
                        &keychain,
                        &secret_keychain,
                    )
                    .await,
                    Err(VaultDeleteError::VaultBusyAuth)
                ),
                "the delete must be rejected for this test to mean anything"
            );

            assert!(dir.exists(), "the vault stands");
            assert_eq!(
                secret_keychain.read(&account),
                Some(vec![0x5a; 32]),
                "a rejected delete must not destroy a surviving vault's key"
            );
        });
    }

    #[test]
    #[tracing_test::traced_test]
    fn a_failed_device_secret_delete_is_logged_and_the_file_result_stands() {
        // The contract the doc comment states rather than implies: the vault's
        // files ARE gone by the time the keychain delete runs, so a keychain
        // failure is logged and does NOT turn the erase into an error a retry
        // would answer `VaultNotFound` to. What must not happen is silence: a
        // secret outliving the vault is the finding this change exists for.
        use crate::vault_id::VaultId;
        use crate::vault_label::fake_keychain::FakeKeychain;

        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-device-secret-failed").unwrap();
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let base = host.app_data_dir().expect("test host data dir");
            let id = VaultId::mint();
            const HASH: [u8; 16] = [0x11; 16];
            let dir = seeded_vault_with_account(&base, id, HASH);

            let account = device_secret::account_component(&HASH, id);
            let secret_keychain = device_secret::fake::FakeDeviceSecretKeychain::empty();
            secret_keychain.put(&account, &[0x5a; 32]);
            secret_keychain.fail_delete_for(&account);

            let keychain = FakeKeychain::empty();
            let hooks: crate::hooks::Hooks = std::sync::Arc::new(crate::hooks::NoopHooks);
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    id,
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(7, 9, 1),
                )
                .await;

            let result = vault_delete_from_host(
                &state,
                &hooks,
                &host,
                &crate::vault_io::StdVaultIo,
                id.to_string(),
                &keychain,
                &secret_keychain,
            )
            .await;

            assert!(
                result.is_ok(),
                "the erase itself succeeded; the keychain half is best-effort by \
                 contract, and reporting an error here would tell the user the \
                 vault survived when it did not. Got {result:?}"
            );
            assert!(!dir.exists(), "the vault tree is gone");
            assert!(
                secret_keychain.read(&account).is_some(),
                "the fixture must leave the item behind, or the log assertion below \
                 would be testing a delete that succeeded"
            );
            assert!(
                logs_contain("stage=\"vault_delete_device_secret\""),
                "a surviving per-vault secret must be visible in the diagnostic log"
            );
            assert!(
                logs_contain("per-vault device-local secret outlived the vault it belongs to"),
                "the log line must say what happened, not merely that something did"
            );
        });
    }

    #[test]
    #[tracing_test::traced_test]
    fn an_unaddressable_item_is_logged_as_not_addressed_rather_than_silently_skipped() {
        // The `None` arm of `read_account_number_hash`: `vault.meta` is
        // byte-present but does not parse, which is the state the delete gate
        // admits (it tests byte-presence, not parseability) and the state most of
        // this file's own fixtures are in. The item cannot be addressed, and the
        // difference between "we did not erase it" and "there was nothing to
        // erase" is the whole of the log line. Without this test, replacing the
        // arm's body with `None => {}` leaves every test in this file green.
        use crate::vault_id::VaultId;
        use crate::vault_label::fake_keychain::FakeKeychain;

        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-device-secret-unaddressed").unwrap();
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let base = host.app_data_dir().expect("test host data dir");
            let id = VaultId::mint();
            // `well_formed: true` writes `b"meta bytes"`, which is byte-present
            // and unparseable: the fixture the arm needs, not a missing file.
            let dir = seeded_vault(&base, id, true);

            let secret_keychain = device_secret::fake::FakeDeviceSecretKeychain::empty();
            let keychain = FakeKeychain::empty();
            let hooks: crate::hooks::Hooks = std::sync::Arc::new(crate::hooks::NoopHooks);
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    id,
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(7, 9, 1),
                )
                .await;

            let result = vault_delete_from_host(
                &state,
                &hooks,
                &host,
                &crate::vault_io::StdVaultIo,
                id.to_string(),
                &keychain,
                &secret_keychain,
            )
            .await;

            assert!(result.is_ok(), "the file-level erase still succeeds");
            assert!(!dir.exists(), "the vault tree is gone");
            assert!(
                secret_keychain.calls().is_empty(),
                "the erase must be SKIPPED rather than attempted against a guessed \
                 account, which is what makes the log line the only signal"
            );
            assert!(
                logs_contain("stage=\"vault_delete_device_secret\""),
                "an unaddressable per-vault secret must be visible in the diagnostic log"
            );
            assert!(
                logs_contain("account_number_hash_unavailable"),
                "the log must name WHY the item was not addressed, distinctly from \
                 'there was nothing to erase'"
            );
        });
    }

    /// Same fixture as [`seeded_vault_with_account`] but written in a given meta
    /// generation, so the version-aware read this change depends on can be
    /// pinned. v0.1 is the default in every other fixture here, which is exactly
    /// why `parse_vault_meta_any` could be swapped for the v0.1 reader without a
    /// single test going red.
    fn seeded_vault_with_account_versioned(
        base: &std::path::Path,
        id: crate::vault_id::VaultId,
        account_number_hash: [u8; 16],
        version: protocol::MetaVersion,
    ) -> std::path::PathBuf {
        let dir = base.join("vaults").join(id.to_string());
        std::fs::create_dir_all(&dir).expect("vault root");
        let meta = protocol::VaultMeta {
            account_number_hash,
            kdf_params: crate::test_support::FAST_TEST_KDF,
            random_salt_password: [1u8; 16],
            random_salt_recovery: [2u8; 16],
            nonce_password_wrap: [3u8; 24],
            enc_root_key_password: [4u8; 64],
            nonce_recovery_wrap: [5u8; 24],
            enc_root_key_recovery: [6u8; 64],
            items_key_id: [7u8; 16],
            items_key_nonce: [8u8; 24],
            enc_items_key: [9u8; 64],
            membership: None,
            person_binding: None,
        };
        std::fs::write(
            dir.join("vault.meta"),
            protocol::serialize_vault_meta_versioned(version, &meta),
        )
        .expect("seed a parseable vault.meta");
        dir
    }

    #[test]
    fn a_v0_2_vault_meta_still_addresses_the_item() {
        // myne-md/myne#638's shape, on this caller: a reader taught only v0.1
        // answers `None` for a migrated vault, the erase is skipped, and nothing
        // says so. `parse_vault_meta_any` is what makes the member-vault half of
        // the class reachable, so a v0.2 fixture has to prove it.
        use crate::vault_id::VaultId;
        use crate::vault_label::fake_keychain::FakeKeychain;

        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-device-secret-v02").unwrap();
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let base = host.app_data_dir().expect("test host data dir");
            let id = VaultId::mint();
            const HASH: [u8; 16] = [0x2c; 16];
            let dir =
                seeded_vault_with_account_versioned(&base, id, HASH, protocol::MetaVersion::V0_2);

            let account = device_secret::account_component(&HASH, id);
            let secret_keychain = device_secret::fake::FakeDeviceSecretKeychain::empty();
            secret_keychain.put(&account, &[0x6b; 32]);

            let keychain = FakeKeychain::empty();
            let hooks: crate::hooks::Hooks = std::sync::Arc::new(crate::hooks::NoopHooks);
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    id,
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(7, 9, 1),
                )
                .await;

            vault_delete_from_host(
                &state,
                &hooks,
                &host,
                &crate::vault_io::StdVaultIo,
                id.to_string(),
                &keychain,
                &secret_keychain,
            )
            .await
            .expect("delete");

            assert!(!dir.exists(), "the vault tree is gone");
            assert!(
                secret_keychain.read(&account).is_none(),
                "a v0.2 vault.meta must yield the address; skipping it is the \
                 silent-skip shape #638 records"
            );
        });
    }

    #[test]
    #[tracing_test::traced_test]
    fn a_platform_with_no_keychain_is_a_no_op_rather_than_a_false_survivor() {
        // The `Err(SecretDeleteFailure::Unavailable)` arm. Collapsing it into the
        // `Backend` arm (one match arm rewritten) leaves every test green while
        // Windows, Linux and Android log "outlived the vault it belongs to" on
        // every delete, in the log the user is invited to attach to a report. A
        // false line naming a surviving secret reads as a live security finding.
        use crate::vault_id::VaultId;
        use crate::vault_label::fake_keychain::FakeKeychain;

        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-device-secret-no-keychain").unwrap();
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let base = host.app_data_dir().expect("test host data dir");
            let id = VaultId::mint();
            const HASH: [u8; 16] = [0x3d; 16];
            let dir = seeded_vault_with_account(&base, id, HASH);

            let keychain = FakeKeychain::empty();
            let hooks: crate::hooks::Hooks = std::sync::Arc::new(crate::hooks::NoopHooks);
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(
                    id,
                    crate::plugins::vault_unlock::state::fixture_unlocked_with_keys(7, 9, 1),
                )
                .await;

            let result = vault_delete_from_host(
                &state,
                &hooks,
                &host,
                &crate::vault_io::StdVaultIo,
                id.to_string(),
                &keychain,
                &device_secret::NoSystemKeychain,
            )
            .await;

            assert!(result.is_ok(), "no keychain is not an erase failure");
            assert!(!dir.exists(), "the vault tree is gone");
            assert!(
                !logs_contain("outlived the vault it belongs to"),
                "a platform that never created the item must not report one \
                 surviving it"
            );
            assert!(
                !logs_contain("account_number_hash_unavailable"),
                "the address was available; only the platform was not"
            );
        });
    }

    #[test]
    fn a_rejected_delete_does_not_destroy_the_key() {
        // The `matches!(result, Ok | PartialDelete)` gate, which is why the
        // erase sits on the teardown list rather than beside the unlink. A
        // rejected delete left the vault standing, so destroying its key would
        // blank a surviving vault's picker row until its next unlock.
        use crate::vault_id::VaultId;
        use crate::vault_label::fake_keychain::FakeKeychain;
        use crate::vault_label::store::{label_path, write_label};

        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-label-rejected").unwrap();
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let base = host.app_data_dir().expect("test host data dir");
            let id = VaultId::mint();
            // No `vault.meta`, so the empty-slot arm rejects with VaultNotFound.
            let dir = seeded_vault(&base, id, false);

            let keychain = FakeKeychain::empty();
            write_label(&crate::vault_io::StdVaultIo, &dir, id, "Work", &keychain)
                .await
                .expect("seed");

            let hooks: crate::hooks::Hooks = std::sync::Arc::new(crate::hooks::NoopHooks);
            let state = VaultRuntimeState::default();
            let secret_keychain = device_secret::fake::FakeDeviceSecretKeychain::empty();

            assert!(
                matches!(
                    vault_delete_from_host(
                        &state,
                        &hooks,
                        &host,
                        &crate::vault_io::StdVaultIo,
                        id.to_string(),
                        &keychain,
                        &secret_keychain,
                    )
                    .await,
                    Err(VaultDeleteError::VaultNotFound)
                ),
                "the delete must be rejected for this test to mean anything"
            );

            assert!(keychain.read(&id.to_string()).is_some(), "the key survives");
            assert!(label_path(&dir).exists(), "and so does the sealed file");
        });
    }

    // ---- L2: tracing-test emission verification ---------------------------
    //
    // Each rejection arm emits a `tracing::debug!(stage = ..., error_kind = ...)`
    // event. These tests assert the right error_kind label crosses the
    // tracing boundary without DENY-list values (no paths, no kernel
    // error strings, no key material).

    #[test]
    #[tracing_test::traced_test]
    fn busy_auth_rejection_emits_static_error_kind() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-tr-busy").unwrap();
            let state = VaultRuntimeState::default();
            let _held = state.auth_permits().acquire().await.unwrap();
            let _ = vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;
            assert!(
                logs_contain("error_kind=\"VaultBusyAuth\""),
                "expected VaultBusyAuth error_kind label in tracing"
            );
            assert!(
                logs_contain("stage=\"auth_permits\""),
                "expected stage=auth_permits in tracing"
            );
        });
    }

    /// MYND-108-bis tracing test: Empty + vault.meta-exists emits the
    /// new `slot_arm = "empty_meta_exists"` discriminator at
    /// `stage = "slot_check"` (the dispatch decision), then the same
    /// uniform `event="vault_deleted", stage="complete"` event on
    /// success that the Unlocked/Recovering arms emit. Was previously
    /// the `not_unlocked_rejection_emits_static_error_kind` rejection
    /// test; repurposed for the MYND-108-bis happy path.
    #[test]
    #[tracing_test::traced_test]
    fn vault_delete_from_empty_with_meta_exists_emits_vault_deleted_event() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-empty-trace").unwrap();
            std::fs::write(tmp.path().join("vault.meta"), b"x").unwrap();
            let state = VaultRuntimeState::default();
            let result =
                vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;
            assert!(
                result.is_ok(),
                "Empty + vault.meta-exists must succeed; got {result:?}"
            );
            assert!(
                logs_contain("slot_arm=\"empty_meta_exists\""),
                "expected slot_arm=empty_meta_exists discriminator at slot_check stage"
            );
            assert!(
                logs_contain("event=\"vault_deleted\""),
                "expected vault_deleted event on success (uniform with Unlocked/Recovering arms)"
            );
            assert!(
                logs_contain("stage=\"complete\""),
                "expected stage=complete on success"
            );
            // DENY-list: path string must not appear.
            let path_str = tmp.path().to_string_lossy().to_string();
            assert!(
                !logs_contain(&path_str),
                "vault_dir path leaked into tracing payload (DENY-list violation)"
            );
        });
    }

    #[test]
    #[tracing_test::traced_test]
    fn not_found_rejection_emits_static_error_kind() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("vd-tr-not-found").unwrap();
            let state = VaultRuntimeState::default();
            let _ = vault_delete_with_dir(tmp.path().to_path_buf(), test_vault_id(), &state).await;
            assert!(
                logs_contain("error_kind=\"VaultNotFound\""),
                "expected VaultNotFound error_kind label in tracing"
            );
        });
    }

    // ---- JSON wire shape -------------------------------------------------
    //
    // IPC contract: each VaultDeleteError variant serializes to the
    // exact tag shape pinned by the PRD §"Implementation Decisions →
    // VaultDeleteError variant set". TS-side parser (lands with
    // MYND-108 frontend feature) consumes these.

    #[test]
    fn vault_busy_auth_serializes_with_kind_tag() {
        let json =
            serde_json::to_string(&VaultDeleteError::VaultBusyAuth).expect("serialize variant");
        assert_eq!(json, r#"{"kind":"VaultBusyAuth"}"#);
    }

    #[test]
    fn vault_not_unlocked_serializes_with_kind_tag() {
        let json =
            serde_json::to_string(&VaultDeleteError::VaultNotUnlocked).expect("serialize variant");
        assert_eq!(json, r#"{"kind":"VaultNotUnlocked"}"#);
    }

    #[test]
    fn vault_not_found_serializes_with_kind_tag() {
        let json =
            serde_json::to_string(&VaultDeleteError::VaultNotFound).expect("serialize variant");
        assert_eq!(json, r#"{"kind":"VaultNotFound"}"#);
    }

    #[test]
    fn partial_delete_serializes_with_kind_tag_and_remaining_count() {
        let json = serde_json::to_string(&VaultDeleteError::PartialDelete { remaining_count: 3 })
            .expect("serialize variant");
        assert_eq!(
            json,
            r#"{"kind":"PartialDelete","detail":{"remaining_count":3}}"#
        );
    }

    #[test]
    fn io_serializes_with_kind_tag_and_io_error_kind() {
        let json = serde_json::to_string(&VaultDeleteError::Io {
            io_error_kind: IoFailureKind::PermissionDenied,
        })
        .expect("serialize variant");
        assert_eq!(
            json,
            r#"{"kind":"Io","detail":{"io_error_kind":"PermissionDenied"}}"#
        );
    }

    // ---- Static-string label exhaustive-match drift test -----------------
    //
    // Compile-time exhaustiveness via the helper's match. Each variant
    // is asserted by the test; adding a new variant compile-fails the
    // helper, which compile-fails this test, which surfaces in code
    // review (the reviewer must update both helper and test in the
    // same PR). Same pattern as `note_delete_error_kind` drift test.

    #[test]
    fn vault_delete_error_kind_label_covers_every_variant() {
        assert_eq!(
            vault_delete_error_kind(&VaultDeleteError::VaultBusyAuth),
            "VaultBusyAuth"
        );
        assert_eq!(
            vault_delete_error_kind(&VaultDeleteError::VaultNotUnlocked),
            "VaultNotUnlocked"
        );
        assert_eq!(
            vault_delete_error_kind(&VaultDeleteError::VaultNotFound),
            "VaultNotFound"
        );
        assert_eq!(
            vault_delete_error_kind(&VaultDeleteError::PartialDelete { remaining_count: 1 }),
            "PartialDelete"
        );
        assert_eq!(
            vault_delete_error_kind(&VaultDeleteError::Io {
                io_error_kind: IoFailureKind::Other,
            }),
            "Io"
        );
    }

    // ---- io::Error From impl ---------------------------------------------

    #[test]
    fn from_io_error_maps_permission_denied_to_io_variant() {
        let e: VaultDeleteError = std::io::Error::from(std::io::ErrorKind::PermissionDenied).into();
        assert!(
            matches!(
                e,
                VaultDeleteError::Io {
                    io_error_kind: IoFailureKind::PermissionDenied
                }
            ),
            "PermissionDenied must map to Io{{PermissionDenied}}, got {e:?}"
        );
    }

    #[test]
    fn from_io_error_maps_not_found_to_io_variant() {
        let e: VaultDeleteError = std::io::Error::from(std::io::ErrorKind::NotFound).into();
        assert!(matches!(
            e,
            VaultDeleteError::Io {
                io_error_kind: IoFailureKind::NotFound
            }
        ));
    }
}
