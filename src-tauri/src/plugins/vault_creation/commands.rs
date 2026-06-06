//! Tauri commands for the vault-creation flow.
//!
//! - [`begin`]  → session creation (Task 12).
//! - [`commit`] → write `vault.meta` to disk (Task 13).
//! - [`cancel`] → drop a session (Task 14).

use super::error::AppError;
use super::state::{SessionLookup, VaultCreationSession, VaultCreationState};
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use protocol::{
    KdfParams, AEAD_KEY_LEN, AEAD_NONCE_LEN, ARGON2_SALT_LEN, DEFAULT_V0_1_KDF_PARAMS,
    VAULT_META_ITEMS_KEY_ID_LEN, VAULT_META_WRAPPED_ITEMS_KEY_LEN, VAULT_META_WRAPPED_ROOT_KEY_LEN,
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::{Runtime, State};
use uuid::Uuid;
use zeroize::Zeroizing;

/// Result returned by [`begin`].
///
/// `phrase` is a clone of the session's 24-word BIP-39 phrase so the
/// frontend can display it; the master copy stays in
/// [`VaultCreationSession`] (Zeroizing) for the recovery-wrap-key
/// computation in `commit`.
///
/// `account_number` is the display form (`MY-XXXX-XXXX-XXXX-XXXX-XXXX`).
///
/// `session_token` is an opaque UUID — not a secret. The frontend
/// holds it across the confirmation challenge and replays it to
/// `commit` / `cancel`.
#[derive(Serialize)]
pub struct BeginResult {
    pub phrase: [String; 24],
    pub account_number: String,
    pub session_token: String,
}

/// Begin a vault-creation session.
///
/// Reserves one of [`MAX_CONCURRENT_SESSIONS`] slots **before**
/// dispatching the expensive work (Argon2id × 2 at v0.1 baseline,
/// ~2–3 seconds total, ~256 MiB per derivation). The reservation is
/// an atomic CAS so concurrent burst-`begin` callers cannot all
/// observe "below cap" and all start derivations — exactly one
/// caller per slot wins, and the cap functions as a hard memory
/// guard rather than an advisory hint.
///
/// On success: materializes the reservation as a session entry under
/// a fresh UUID and returns the 24-word phrase (cloned), the account
/// number's display form, and the session token. `root_key` and the
/// wrap keys remain in the session — they NEVER cross the IPC
/// boundary.
///
/// On failure (Argon2id error, JoinFailure, panic): the
/// [`SlotReservation`]'s `Drop` releases the slot.
#[tauri::command]
pub async fn begin(
    password: String,
    state: State<'_, VaultCreationState>,
) -> Result<BeginResult, AppError> {
    // Wrap immediately so any early-return path (slot-cap rejection,
    // spawn_blocking join failure, build_session error) drops the
    // wrapper and zeroes the bytes. Plain `String` would drop without
    // zeroize. Retroactive memory-hygiene fix bundled with
    // `vault-unlock-password` Task 7 — same pattern Task 2 established
    // for the unlock command. `build_session` borrows `&str` (signature
    // unchanged); the deref chain `&Zeroizing<String>` → `&String` →
    // `&str` holds via standard deref coercion.
    let password = Zeroizing::new(password);

    // Backend min-length floor — structural belt+suspenders against
    // frontend bypass per `decisions.md` 2026-05-06 "Auth-pipeline
    // backend MIN_PASSWORD_LEN floor; project-wide retroactive". Fires
    // BEFORE slot reservation so a weak-password attempt does not
    // consume a concurrent-session slot. Mapped explicitly to
    // `AppError::WeakNewPassword` rather than `?`-propagated through
    // `From<ProtocolError> for AppError` (which would surface as
    // `AppError::Protocol(PasswordTooShort)`) — cross-plugin shared
    // variant name discipline (Q6 of MYND-22 grilling).
    if protocol::password_policy::validate_min_length(&password).is_err() {
        tracing::error!(
            stage = "weak_new_password",
            error_kind = "WeakNewPassword",
            "vault_creation::begin rejected: new password below MIN_PASSWORD_LEN"
        );
        return Err(AppError::WeakNewPassword);
    }

    // Reserve a slot atomically before kicking off ~2 seconds of
    // Argon2id work. If the cap is already saturated, fail fast
    // without consuming any memory.
    let reservation = state.try_reserve()?;

    // Heavy work off the runtime worker pool. The `move` consumes
    // the Zeroizing wrapper into the closure, so the password's
    // bytes wipe when the closure ends — success or failure. If
    // anything in here fails, the `?` early-exit drops `reservation`
    // (releasing the slot via SlotReservation::drop) and the closure-
    // captured wrapper drops in spawn_blocking's task pool.
    let session =
        tokio::task::spawn_blocking(move || build_session(&password, DEFAULT_V0_1_KDF_PARAMS))
            .await
            .map_err(|_| AppError::JoinFailure)??;

    // Take the visible parts out before moving the session into the
    // map. `phrase.words()` returns `&[String; 24]` from inside
    // `Zeroizing<...>`; we clone for the frontend response. The
    // master phrase stays Zeroized in the session.
    let phrase = session.phrase.words().clone();
    let account_number = session.account.display.clone();
    let token = Uuid::new_v4();

    // Materialize the reservation as a live session entry. The
    // reservation is consumed (its Drop is suppressed); the slot
    // stays accounted for until `commit` / `cancel` / TTL eviction
    // removes the session.
    state.commit_reservation(reservation, token, session);

    Ok(BeginResult {
        phrase,
        account_number,
        session_token: token.to_string(),
    })
}

/// Pure-function helper — no Tauri runtime, no async — that builds a
/// fresh [`VaultCreationSession`] from a password.
///
/// Tests instantiate this directly with fast Argon2id parameters
/// (`m_kib=8, t=1, p=1`) so they don't need a Tauri runtime and don't
/// pay the 1–2 second default-parameter cost. Production calls through
/// `begin` always pass `DEFAULT_V0_1_KDF_PARAMS`. The chosen params
/// are stored on the returned session so `commit` rebuilds the AADs
/// and `vault.meta` under the same set.
pub(crate) fn build_session(
    password: &str,
    kdf_params: KdfParams,
) -> Result<VaultCreationSession, AppError> {
    let account = protocol::generate_account_number()?;
    let phrase = protocol::generate_recovery_phrase()?;
    let root_key = protocol::generate_root_key()?;

    let salt_password: [u8; ARGON2_SALT_LEN] = random_bytes()?;
    let salt_recovery: [u8; ARGON2_SALT_LEN] = random_bytes()?;

    let password_wrap_key =
        protocol::derive_password_wrap_key(password, &salt_password, &account.hash, &kdf_params)?;
    let recovery_wrap_key =
        protocol::derive_recovery_wrap_key(&phrase, &salt_recovery, &account.hash, &kdf_params)?;

    Ok(VaultCreationSession {
        account,
        phrase,
        kdf_params,
        root_key,
        salt_password,
        salt_recovery,
        password_wrap_key,
        recovery_wrap_key,
        created_at: Instant::now(),
    })
}

/// Commit a vault-creation session: build `vault.meta` and atomically
/// write it to `<app_data_dir>/vault/vault.meta`.
///
/// Workflow:
/// 1. Parse `session_token` (`SessionNotFound` on parse error).
/// 2. Resolve `vault_dir` and ensure it exists. If this fails, the
///    session is left intact in the live map for a future retry —
///    the failure is recoverable (permissions can be fixed, disk
///    pressure can subside) and we have not consumed the session
///    yet, so no restore is needed.
/// 3. Delegate to [`commit_with_vault_path`], which:
///    a. `state.take(token)` consumes the session
///       (`SessionNotFound` / `SessionExpired` on absent / TTL-evicted).
///    b. Defensive `VaultArtifactsPresent` guard: if any recognized
///       vault artefact (vault.meta, vault.meta.tmp, vault.prefs,
///       vault.prefs.tmp, notes/*.myn) is already present at the
///       resolved path, restore the session and return
///       [`AppError::VaultArtifactsPresent`]. **Expected to NEVER
///       trigger in normal flow** — see grilling Q12 + MYND-105
///       grill Q7 (taxonomy broadening) + MYND-160 (vault.prefs
///       extension).
///    c. In a `spawn_blocking` worker: AEAD-wrap `root_key` twice,
///       derive `itemsKey_wrap_key` via `derive_subkey`, generate
///       `itemsKey` + its UUIDv7, AEAD-wrap `itemsKey`, build
///       [`protocol::VaultMeta`], serialize 345 bytes, atomic-write.
///       The worker takes the session by value but returns it back
///       inside the `Err` arm so the outer code can re-insert on a
///       recoverable failure (filesystem error, rare CSPRNG failure
///       during itemsKey generation, etc.).
///    d. On success: drop the session — every Zeroizing field wipes.
///       On worker failure: re-insert the session under the same
///       token so the next `commit` invocation with that token can
///       retry.
#[tauri::command]
pub async fn commit<R: Runtime>(
    session_token: String,
    state: State<'_, VaultCreationState>,
    runtime_state: State<'_, VaultRuntimeState>,
    app: tauri::AppHandle<R>,
) -> Result<(), AppError> {
    let token = Uuid::parse_str(&session_token).map_err(|_| AppError::SessionNotFound)?;
    // Resolve the path before consuming the session — if app_data_dir
    // lookup or create_dir_all on the vault subfolder fails, there's
    // nothing to restore yet (the session is still in the live map for
    // a future retry once the underlying condition is fixed).
    let vault_dir = crate::paths::vault_dir(&app)?;
    let vault_path = vault_dir.join("vault.meta");
    commit_with_permit(
        token,
        vault_path,
        state.inner(),
        runtime_state.auth_permits(),
    )
    .await
}

/// `auth_permits`-gated wrapper around [`commit_with_vault_path`].
///
/// MYND-159: `vault_create::commit` is pulled into the single capacity-1
/// `auth_permits` semaphore that already serializes every other
/// vault.meta-lifecycle command (`vault_unlock` / `vault_recover_*` /
/// `vault_change_password` / `vault_delete`). This generalizes the permit
/// from an Argon2id throttle into a **vault.meta-lifecycle mutex** and
/// closes the `vault_repair` ↔ `commit` TOCTOU: while `commit` holds the
/// permit a concurrent `vault_repair` sweep busy-rejects, and vice-versa.
///
/// `try_acquire` (reject, never queue) matches the family posture. The RAII
/// permit guard is scoped to this function, so it drops on **every** return
/// path — crucially **before** the frontend's auto-unlock chain
/// (`commit` → `vault_unlock`) fires, so the subsequent `vault_unlock`
/// acquires the permit cleanly rather than self-deadlocking into a
/// busy-reject.
///
/// Normally a no-op gate in the create flow (no concurrent peer exists at
/// creation time — there is no vault to unlock / change / delete); it only
/// bites the pathological `vault_repair`-race case.
pub(crate) async fn commit_with_permit(
    token: Uuid,
    vault_path: PathBuf,
    state: &VaultCreationState,
    auth_permits: &tokio::sync::Semaphore,
) -> Result<(), AppError> {
    let _permit = match auth_permits.try_acquire() {
        Ok(p) => p,
        Err(_) => {
            tracing::debug!(
                stage = "auth_permits",
                error_kind = "VaultBusyAuth",
                "vault_create commit rejected: another vault.meta-lifecycle op in flight"
            );
            return Err(AppError::VaultBusyAuth);
        }
    };
    commit_with_vault_path(token, vault_path, state).await
    // `_permit` drops here on every return path → released before the
    // frontend's subsequent auto-unlock `vault_unlock` acquires.
}

/// Recognized-artefact predicate consumed by the
/// [`commit_with_vault_path`] defensive guard.
///
/// Returns `Ok(true)` if any of the following exists under `vault_dir`:
/// - `vault.meta` (the canonical case — fully-formed vault present)
/// - `vault.meta.tmp` (mid-write crash leftover from
///   [`crate::atomic_write::atomic_write`]'s tempfile-rename path; same
///   class as `vault.meta` because either rename half-completed or the
///   process died between tempfile write and rename)
/// - `vault.prefs` (MYND-160: the v0.1 vault-prefs blob, spec § 9.5 —
///   encrypted under a prior `root_key`; a fresh vault under a new
///   `root_key` would AEAD-fail on read and silently return defaults,
///   which is observable but defeats the closed-invariant intent of
///   the eager-write at vault_create)
/// - `vault.prefs.tmp` (MYND-160: mid-write crash leftover for
///   vault.prefs — parallel to vault.meta.tmp)
/// - `notes/` directory contains at least one `*.myn` file (orphan
///   per-note blobs from a partial-fail `vault_delete` — Plane
///   MYND-105, `decisions.md` 2026-05-26 entry "vault_delete
///   partial-fail posture")
///
/// Returns `Ok(false)` when `vault_dir` itself does not exist (no
/// artefacts to find — caller should proceed with fresh creation).
/// Returns `Err(io::Error)` only on `read_dir` failure while scanning
/// `notes/` (e.g., permission denied); the `From<io::Error> for
/// AppError` impl maps this to [`AppError::Io`] at the call site.
///
/// Future per-vault artefact families (A14 encrypted per-note
/// snapshots, Phase 1.5 FTS index, attachments) extend this helper by
/// adding a check in the same PR that introduces the artefact —
/// concrete maintenance discipline preserved by the dual taxonomy
/// with `vault_delete`'s recursive unlink (decisions.md 2026-05-26
/// entry "vault_create defensive guard extension", T1a + T2b sub-
/// decisions). The check intentionally does NOT recognize arbitrary
/// files under `vault_dir` (e.g., `.DS_Store`, `Thumbs.db`,
/// OS-injected artefacts) — those are not vault state and must not
/// gate `vault_create`.
///
/// `pub(crate)` so the future `vault_repair` (v0.2, Plane MYND-159)
/// can re-use the same predicate without duplication.
pub(crate) fn vault_artifacts_present(vault_dir: &Path) -> std::io::Result<bool> {
    if !vault_dir.exists() {
        return Ok(false);
    }
    if vault_dir.join("vault.meta").is_file() {
        return Ok(true);
    }
    if vault_dir.join("vault.meta.tmp").is_file() {
        return Ok(true);
    }
    // MYND-160: `vault.prefs` (spec § 9.5) is the v0.1 vault-prefs blob.
    // Recognized the same way `vault.meta` is — a leftover from a
    // partial-fail `vault_delete` or manual cleanup must gate a fresh
    // `vault_create` because the stale blob was encrypted under a prior
    // `root_key` and would AEAD-fail under the new vault's key.
    if vault_dir.join("vault.prefs").is_file() {
        return Ok(true);
    }
    if vault_dir.join("vault.prefs.tmp").is_file() {
        return Ok(true);
    }
    let notes = vault_dir.join("notes");
    if notes.is_dir() {
        for entry in std::fs::read_dir(&notes)? {
            let entry = entry?;
            if entry.path().extension().is_some_and(|e| e == "myn") {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// Testable core of [`commit`]. The Tauri-command wrapper resolves the
/// platform-specific `vault.meta` path and delegates here so tests do
/// not need an [`tauri::AppHandle`].
///
/// Sequence:
/// 1. `state.take(token)` consumes the session
///    (`SessionNotFound` / `SessionExpired` on absent / TTL-evicted).
/// 2. **Defensive `VaultArtifactsPresent` guard** (`app-state-machine`
///    grill Q12 + MYND-105 grill Q7): if [`vault_artifacts_present`]
///    returns `true` for the parent directory of `vault_path`, restore
///    the session (so retry remains possible — non-destructive) and
///    return [`AppError::VaultArtifactsPresent`]. **Expected to NEVER
///    trigger in normal flow.** Trigger = (a) frontend routing
///    regression (`vault_status` probe + state machine should keep
///    the user out of create-vault when a vault is present), or (b)
///    a prior `vault_delete` partial-fail left orphan artefacts that
///    the user has not manually cleaned (v0.2 `vault_repair`
///    feature, Plane MYND-159, will handle this in-app).
/// 3. `tokio::task::spawn_blocking` runs the heavy `vault.meta`
///    build + atomic write (`build_and_serialize_vault_meta` +
///    `atomic_write::atomic_write`). On failure the worker returns
///    the session by-value so this caller can re-insert it under the
///    same token (retry-on-failure semantics preserved).
pub(crate) async fn commit_with_vault_path(
    token: Uuid,
    vault_path: PathBuf,
    state: &VaultCreationState,
) -> Result<(), AppError> {
    let session: VaultCreationSession = match state.take(token) {
        SessionLookup::Found(boxed) => *boxed,
        SessionLookup::Expired => return Err(AppError::SessionExpired),
        SessionLookup::NotFound => return Err(AppError::SessionNotFound),
    };

    // Defensive guard: any recognized vault artefact already present
    // under the vault directory. Recognized artefacts (per the
    // [`vault_artifacts_present`] taxonomy): `vault.meta`,
    // `vault.meta.tmp` (mid-write crash leftover from
    // [`crate::atomic_write::atomic_write`]'s tempfile-rename path),
    // `vault.prefs` + `vault.prefs.tmp` (MYND-160 extension — the
    // vault-prefs blob and its mid-write tempfile, spec § 9.5), or
    // `notes/` containing one or more `*.myn` files (orphan blobs
    // from a partial-fail `vault_delete`). The alternative — letting
    // the spawn_blocking pipeline reach `atomic_write` — would
    // silently overwrite a prior vault.meta (destroying its
    // `root_key`, recovery phrase derivation salts, and consequently
    // any sealed `.myn` blobs), co-mingle a fresh vault with
    // orphan blobs that surface as ghost notes after unlock, or leave
    // a vault.prefs encrypted under the prior root_key that the new
    // vault's prefs_key cannot decrypt (silent fall-back-to-defaults).
    // **Expected to NEVER trigger in normal flow**: `vault_status`
    // startup probe + frontend state machine should keep the user out
    // of create-vault when artefacts are present.
    //
    // See: `agent-tooling/sessions/grill/2026-05-02-app-state-machine.md`
    // Q12 (original variant) + `agent-tooling/features/app-state-machine/prd.md`
    // + `agent-tooling/sessions/grill/2026-05-26-mynd-105-vault-delete.md` Q7
    // (taxonomy broadening + rename) + `decisions.md` 2026-05-26
    // "vault_create defensive guard extension".
    let vault_dir = vault_path
        .parent()
        .expect("vault.meta path resolution always yields a parent directory");
    if vault_artifacts_present(vault_dir)? {
        tracing::error!(
            stage = "commit_artifacts_check",
            error_kind = "VaultArtifactsPresent",
            "commit attempted on path with existing vault artefacts — frontend routing bypass or unclean partial-delete"
        );
        // Restore the session so `commit_with_vault_path` is
        // structurally non-destructive: even when the guard fires, no
        // work or state is lost. `try_insert` cannot exceed the cap
        // here: the slot was just freed by `state.take` above.
        let _ = state.try_insert(token, session);
        return Err(AppError::VaultArtifactsPresent);
    }

    let outcome: Result<(), (AppError, VaultCreationSession)> =
        tokio::task::spawn_blocking(move || match build_and_serialize_vault_meta(&session) {
            Err(e) => Err((e, session)),
            Ok(bytes) => match crate::atomic_write::atomic_write(&vault_path, &bytes, false) {
                Err(e) => Err((AppError::from(e), session)),
                Ok(()) => {
                    // MYND-160 Task 12: eager-write the default vault.prefs
                    // blob so every post-MYND-160 vault carries the closed
                    // invariant "vault.prefs exists immediately after
                    // vault_create completes" (decisions.md 2026-05-27
                    // "Vault preferences blob"). vault.meta is already on
                    // disk at this point; if the prefs write fails, fall
                    // back to the spec § 9.5.5 absence-fallback semantic
                    // (next prefs_read returns PrefsView::default() and
                    // first toggle interaction creates the file lazily).
                    // No rollback of vault.meta — partial state is
                    // recoverable via the standard vault_delete + retry
                    // path. The cost of the rare partial-fail (~50ms
                    // second atomic_write after a ~2-3s Argon2id pipeline)
                    // is bounded; full atomic rollback would force the
                    // user to redo the entire Argon2id pipeline on every
                    // disk hiccup, which is the worse UX.
                    let prefs_key = protocol::derive_subkey(
                        &session.root_key,
                        protocol::SubkeyRole::PrefsKey,
                    );
                    let prefs_path = vault_path
                        .parent()
                        .expect("vault_path has a parent (vault dir)")
                        .join("vault.prefs");
                    match protocol::encode_prefs_blob(
                        &prefs_key,
                        &session.account.hash,
                        &protocol::PrefsView::default(),
                    ) {
                        Ok(prefs_bytes) => {
                            match crate::atomic_write::atomic_write(
                                &prefs_path,
                                &prefs_bytes,
                                false,
                            ) {
                                Ok(()) => tracing::info!(
                                    event = "vault_prefs_eager_written",
                                    "vault.prefs eager-write succeeded with PrefsView::default()"
                                ),
                                Err(e) => tracing::warn!(
                                    event = "vault_prefs_eager_write_failed",
                                    io_failure_kind =
                                        ?crate::io_failure_kind::from_io_error_kind(e.kind()),
                                    "vault.meta written but vault.prefs eager-write failed; vault remains usable via spec § 9.5.5 absence-fallback",
                                ),
                            }
                        }
                        Err(_e) => tracing::warn!(
                            event = "vault_prefs_eager_encode_failed",
                            "vault.prefs encode failed during eager-write; vault remains usable via spec § 9.5.5 absence-fallback",
                        ),
                    }
                    Ok(())
                }
            },
        })
        .await
        .map_err(|_| AppError::JoinFailure)?;

    match outcome {
        Ok(()) => Ok(()),
        Err((err, session)) => {
            // Re-insert under the same token so the frontend's retry
            // (sending the same token to a follow-up `commit` call)
            // works. `try_insert` cannot exceed the cap here: this
            // task was already accounted for and was just removed by
            // `state.take` above.
            let _ = state.try_insert(token, session);
            Err(err)
        }
    }
}

/// Cancel a vault-creation session.
///
/// Idempotent — `cancel(unknown_token)`, `cancel(expired_token)`, and
/// `cancel(malformed_token)` all return `Ok(())`. Removing the
/// session from the live map fires its `Drop` (Zeroizing fields wipe).
///
/// Sync (no `async`) because no work is dispatched: just a single
/// hashmap remove + a token-parse attempt.
#[tauri::command]
pub fn cancel(session_token: String, state: State<'_, VaultCreationState>) -> Result<(), AppError> {
    if let Ok(token) = Uuid::parse_str(&session_token) {
        // Drop runs on the removed session; Zeroizing fields wipe.
        let _ = state.take_ignore_status(token);
    }
    Ok(())
}

/// Pure helper: from a [`VaultCreationSession`] (which carries its own
/// `kdf_params`) produce the 345-byte serialized `vault.meta`. Tests
/// instantiate this directly to verify the pipeline without going
/// through Tauri.
///
/// Borrows the session immutably so a failed `atomic_write` can
/// return the session to the caller for retry-on-failure.
pub(crate) fn build_and_serialize_vault_meta(
    session: &VaultCreationSession,
) -> Result<[u8; protocol::VAULT_META_LEN], AppError> {
    // Wrap root_key under password_wrap_key.
    let aad_pw = protocol::aad_password_wrap(&session.kdf_params);
    let (nonce_password_wrap, enc_root_key_password) =
        seal_32_byte_secret(&session.password_wrap_key, &session.root_key, &aad_pw)?;

    // Wrap root_key under recovery_wrap_key.
    let aad_rec = protocol::aad_recovery_wrap(&session.kdf_params);
    let (nonce_recovery_wrap, enc_root_key_recovery) =
        seal_32_byte_secret(&session.recovery_wrap_key, &session.root_key, &aad_rec)?;

    // Derive itemsKey_wrap_key, generate the singleton itemsKey + its
    // UUIDv7 identifier, and wrap.
    let items_wrap_key =
        protocol::derive_subkey(&session.root_key, protocol::SubkeyRole::ItemsKeyWrap);
    let items_key = protocol::generate_root_key()?;
    let items_uuid = Uuid::now_v7();
    let items_key_id: [u8; VAULT_META_ITEMS_KEY_ID_LEN] = *items_uuid.as_bytes();
    let aad_items = protocol::aad_vault_items_key_wrap(&items_key_id);
    let (items_key_nonce, enc_items_key) =
        seal_32_byte_secret(&items_wrap_key, &items_key, &aad_items)?;

    let meta = protocol::VaultMeta {
        account_number_hash: session.account.hash,
        kdf_params: session.kdf_params,
        random_salt_password: session.salt_password,
        random_salt_recovery: session.salt_recovery,
        nonce_password_wrap,
        enc_root_key_password,
        nonce_recovery_wrap,
        enc_root_key_recovery,
        items_key_id,
        items_key_nonce,
        enc_items_key,
    };
    // The wrapped-itemsKey blob length matches the wrapped-root-key
    // blob length (both are 32-byte secrets sealed under the same
    // CTX-commitment AEAD shape). Compile-time guard:
    const _: () = assert!(VAULT_META_WRAPPED_ITEMS_KEY_LEN == VAULT_META_WRAPPED_ROOT_KEY_LEN);

    Ok(protocol::serialize_vault_meta(&meta))
}

/// Fill a fixed-size buffer from the OS CSPRNG, mapping any failure
/// to the protocol's `Csprng` variant. Centralizes the error-mapping
/// boilerplate that previously appeared at every call site.
fn random_bytes<const N: usize>() -> Result<[u8; N], AppError> {
    let mut buf = [0u8; N];
    getrandom::getrandom(&mut buf)
        .map_err(|_| AppError::Protocol(protocol::ProtocolError::Csprng))?;
    Ok(buf)
}

/// Seal a 32-byte secret (root_key or itemsKey) under `wrap_key` with a
/// fresh AEAD nonce and the supplied AAD, returning `(nonce, sealed_blob)`.
/// `sealed_blob` is `ciphertext || CTX_commitment` — fixed 64 bytes
/// because the input is fixed 32 bytes and the CTX tag is 32 bytes.
fn seal_32_byte_secret(
    wrap_key: &[u8; AEAD_KEY_LEN],
    plaintext: &[u8; AEAD_KEY_LEN],
    aad: &[u8],
) -> Result<([u8; AEAD_NONCE_LEN], [u8; VAULT_META_WRAPPED_ROOT_KEY_LEN]), AppError> {
    let nonce: [u8; AEAD_NONCE_LEN] = random_bytes()?;
    let sealed = protocol::aead_seal_ctx(wrap_key, &nonce, plaintext, aad)?;
    let blob: [u8; VAULT_META_WRAPPED_ROOT_KEY_LEN] = sealed
        .as_slice()
        .try_into()
        .expect("32-byte plaintext + 32-byte CTX tag = 64 bytes");
    Ok((nonce, blob))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fast Argon2id parameters for tests (mirrors
    /// `protocol::kdf::tests::FAST_TEST_KDF_PARAMS` shape — RFC 9106
    /// minimum). DEFAULT would add ~1–2 s per test call.
    const FAST_TEST_KDF: KdfParams = KdfParams {
        m_kib: 8,
        t: 1,
        p: 1,
        argon2_version: 0x13,
    };

    #[test]
    fn build_session_populates_every_field() {
        let session =
            build_session("correct horse battery staple", FAST_TEST_KDF).expect("fast params");

        assert!(session.account.display.starts_with("MY-"));
        assert_eq!(session.account.canonical.len(), 20);
        assert_eq!(session.account.hash.len(), 16);
        assert_eq!(session.phrase.words().len(), 24);
        assert_eq!(session.root_key.len(), AEAD_KEY_LEN);
        assert_ne!(*session.root_key, [0u8; AEAD_KEY_LEN]);
        assert_ne!(*session.password_wrap_key, [0u8; AEAD_KEY_LEN]);
        assert_ne!(*session.recovery_wrap_key, [0u8; AEAD_KEY_LEN]);
        assert_ne!(session.salt_password, session.salt_recovery);
        assert_eq!(session.kdf_params, FAST_TEST_KDF);
    }

    #[test]
    fn build_session_password_and_recovery_wrap_keys_differ() {
        let session = build_session("any password", FAST_TEST_KDF).unwrap();
        assert_ne!(*session.password_wrap_key, *session.recovery_wrap_key);
    }

    #[test]
    fn build_session_is_non_deterministic() {
        let a = build_session("same password", FAST_TEST_KDF).unwrap();
        let b = build_session("same password", FAST_TEST_KDF).unwrap();
        assert_ne!(a.account.canonical, b.account.canonical);
        assert_ne!(a.phrase.words(), b.phrase.words());
        assert_ne!(*a.root_key, *b.root_key);
        assert_ne!(a.salt_password, b.salt_password);
    }

    #[test]
    fn begin_result_serializes_with_expected_field_names() {
        let result = BeginResult {
            phrase: core::array::from_fn(|i| format!("w{i}")),
            account_number: "MY-XXXX-XXXX-XXXX-XXXX-XXXX".to_string(),
            session_token: "deadbeef-0000-0000-0000-000000000000".to_string(),
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"phrase\""));
        assert!(json.contains("\"account_number\""));
        assert!(json.contains("\"session_token\""));
    }

    #[test]
    fn build_and_serialize_does_not_consume_session() {
        // Regression: previously `build_and_serialize_vault_meta` took
        // the session by value, so a failed atomic_write could not be
        // retried with the same session. The borrow signature lets
        // commit re-insert the session under its token on failure.
        let session = build_session("any password", FAST_TEST_KDF).unwrap();
        let bytes_a = build_and_serialize_vault_meta(&session).expect("first call");
        let bytes_b = build_and_serialize_vault_meta(&session).expect("second call");
        assert_eq!(bytes_a.len(), bytes_b.len());
        // Different bytes per call: nonces and items_key_id come from
        // the CSPRNG inside the helper, not from the session.
        assert_ne!(bytes_a, bytes_b);
    }

    #[test]
    fn random_bytes_produces_distinct_output_on_repeated_calls() {
        // Sanity that the helper actually consults the CSPRNG.
        let a: [u8; 16] = random_bytes().unwrap();
        let b: [u8; 16] = random_bytes().unwrap();
        assert_ne!(a, b);
    }

    // ---- Defensive `VaultArtifactsPresent` guard (Task 2 of `app-state-machine`,
    //      broadened in MYND-105 to recognized-artefact taxonomy) ----
    //
    // Belt+suspenders Rust-side mirror of Q5β-1's transition fn +
    // component-mount peek check. If frontend routing bypasses
    // `vault_status` and re-enters create-vault on a path that has any
    // recognized vault artefact (vault.meta, vault.meta.tmp, or
    // notes/*.myn), this guard rejects the commit before
    // `atomic_write` would either silently overwrite (destroying the
    // prior vault's `root_key`, recovery phrase derivation salts, and
    // any sealed `.myn` blobs) or co-mingle a fresh vault with
    // partial-delete orphan blobs.
    //
    // **Bug-canary role:** if these tests stay green but production
    // sees vault overwrite reports, the bug is NOT in the guard
    // itself — it's either upstream (frontend routing) or downstream
    // (path resolution producing a different `vault.meta` location
    // than the probe checked).

    /// Minimal scratch directory for vault.meta path tests. Mirrors the
    /// `ScratchVault` pattern in `vault_unlock::commands::tests` but
    /// scoped to vault_creation's needs.
    struct ScratchVault {
        dir: std::path::PathBuf,
        meta_path: std::path::PathBuf,
    }

    impl ScratchVault {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("myne_create_test_{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("create scratch dir");
            let meta_path = dir.join("vault.meta");
            Self { dir, meta_path }
        }

        fn path(&self) -> &std::path::Path {
            &self.meta_path
        }

        fn pre_seed_vault_meta(&self, bytes: &[u8]) {
            std::fs::write(&self.meta_path, bytes).expect("pre-seed vault.meta");
        }
    }

    impl Drop for ScratchVault {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// Build a current-thread tokio runtime — same pattern used in
    /// `vault_unlock::commands::tests::rt`. The `tokio = ["macros"]`
    /// feature is intentionally NOT enabled (TB9 audit-anchor / locked
    /// `tokio 1.52.1`); tests build a runtime manually via `block_on`.
    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    /// Insert a session into the state map under a fresh token. Returns
    /// the token so tests can assert the session is restored on guard
    /// firing. Uses `try_insert` — bumps the in-flight counter, mirrors
    /// the exact path commit's retry-on-failure uses.
    fn seed_session_into_state(state: &VaultCreationState) -> Uuid {
        let token = Uuid::new_v4();
        let session = build_session("commit-test-pw", FAST_TEST_KDF).expect("build_session");
        state
            .try_insert(token, session)
            .expect("scratch state has room");
        token
    }

    #[test]
    fn commit_returns_artifacts_present_when_vault_meta_present() {
        // Pre-seed `vault.meta` at the target path with arbitrary
        // bytes (any non-empty content suffices — the guard is a pure
        // file-presence check, not a parse). The guard must reject
        // before `atomic_write` would touch the file.
        //
        // **If this test fails (production sees overwrite reports
        // despite this passing), the bug is NOT in this guard.** Look
        // upstream at frontend routing (`vault_status` probe) or
        // downstream at path resolution (`crate::paths::vault_dir`
        // producing a different file location than the probe sees).
        rt().block_on(async {
            let scratch = ScratchVault::new();
            let pre_existing = b"prior vault contents - DO NOT DESTROY";
            scratch.pre_seed_vault_meta(pre_existing);

            let state = VaultCreationState::default();
            let token = seed_session_into_state(&state);

            let result =
                commit_with_vault_path(token, scratch.path().to_path_buf(), &state).await;

            assert!(
                matches!(result, Err(AppError::VaultArtifactsPresent)),
                "commit must reject when vault.meta exists, got {result:?}"
            );

            // Pre-existing bytes are untouched — atomic_write was
            // never called. The guard fired before any write path.
            let on_disk = std::fs::read(scratch.path()).expect("vault.meta still readable");
            assert_eq!(
                on_disk.as_slice(),
                pre_existing,
                "guard must NOT touch the pre-existing vault.meta — overwrite is the exact bug we are guarding against"
            );
        });
    }

    #[test]
    fn commit_artifacts_present_guard_restores_session_for_retry() {
        // Non-destructive contract: when the guard fires, the session
        // must be re-inserted under the same token. This ensures
        // commit_with_vault_path is idempotent under guard-firing
        // retry — the user can free up the path (e.g. archive the
        // pre-existing vault.meta) and call commit again with the
        // same token.
        rt().block_on(async {
            let scratch = ScratchVault::new();
            scratch.pre_seed_vault_meta(b"existing");

            let state = VaultCreationState::default();
            let token = seed_session_into_state(&state);

            let result =
                commit_with_vault_path(token, scratch.path().to_path_buf(), &state).await;
            assert!(matches!(result, Err(AppError::VaultArtifactsPresent)));

            // Session must still be takeable under the same token.
            // If `take` returned `NotFound`/`Expired` here, the guard
            // dropped the session and broke retry semantics.
            match state.take(token) {
                SessionLookup::Found(_) => {} // expected
                SessionLookup::NotFound => panic!(
                    "guard dropped the session — non-destructive contract broken; retry with same token would now fail with SessionNotFound"
                ),
                SessionLookup::Expired => panic!(
                    "guard mis-routed the session through TTL eviction — should be a clean re-insert"
                ),
            }
        });
    }

    #[test]
    fn commit_artifacts_present_guard_does_not_fire_when_dir_empty() {
        // Negative control: with no pre-existing file, the guard must
        // not short-circuit. We can't easily run the full success
        // path here (it would do real Argon2id-derived AEAD writes
        // bound to FAST_TEST_KDF — feasible but heavy). What we
        // verify instead: the guard returns a *different* error
        // (the success or downstream-IO path), proving the exists-check
        // didn't mis-fire on a missing file.
        rt().block_on(async {
            let scratch = ScratchVault::new();
            assert!(!scratch.path().exists(), "scratch starts empty");

            let state = VaultCreationState::default();
            let token = seed_session_into_state(&state);

            let result = commit_with_vault_path(token, scratch.path().to_path_buf(), &state).await;

            // Either Ok (full happy path completed) or some non-
            // VaultArtifactsPresent error. The point is: guard did not
            // mis-fire on a clean directory.
            assert!(
                !matches!(result, Err(AppError::VaultArtifactsPresent)),
                "guard mis-fired on clean directory; got {result:?}"
            );
        });
    }

    #[test]
    fn commit_returns_session_not_found_for_unknown_token() {
        // Defensive: token never inserted → SessionNotFound. The
        // exists-check happens AFTER state.take, so missing-session
        // takes precedence over guard firing.
        rt().block_on(async {
            let scratch = ScratchVault::new();
            scratch.pre_seed_vault_meta(b"existing");
            // Both vault.meta exists AND token is not in state. The
            // function must return SessionNotFound (precedence: take
            // happens first, guard happens second).
            let state = VaultCreationState::default();
            let unknown_token = Uuid::new_v4();

            let result =
                commit_with_vault_path(unknown_token, scratch.path().to_path_buf(), &state).await;
            assert!(
                matches!(result, Err(AppError::SessionNotFound)),
                "expected SessionNotFound, got {result:?}"
            );
        });
    }

    // ---- MYND-159: commit pulled into auth_permits ----------------------

    /// `commit` is pulled into the `auth_permits` mutex (MYND-159). When the
    /// permit is already held (e.g. a racing `vault_repair` sweep), commit
    /// busy-rejects with `VaultBusyAuth` rather than queuing. The reject
    /// path fires before the session is consumed, so it is non-destructive.
    #[test]
    fn commit_with_permit_returns_busy_auth_when_permit_held() {
        rt().block_on(async {
            let runtime = VaultRuntimeState::default();
            let creation = VaultCreationState::default();
            let tmp =
                crate::test_support::ScopedTempDir::new("commit-busy").expect("scoped tempdir");
            // Hold the single permit, simulating a concurrent
            // vault.meta-lifecycle op (vault_repair / unlock / delete).
            let _held = runtime.auth_permits().acquire().await.unwrap();

            let result = commit_with_permit(
                Uuid::new_v4(),
                tmp.path().join("vault.meta"),
                &creation,
                runtime.auth_permits(),
            )
            .await;

            assert!(
                matches!(result, Err(AppError::VaultBusyAuth)),
                "expected VaultBusyAuth when permit held, got {result:?}"
            );
        });
    }

    /// MYND-159 self-deadlock regression. The frontend auto-unlock chain is
    /// `commit` → `vault_unlock`. commit's permit guard MUST be released on
    /// return so the subsequent `vault_unlock` can acquire — otherwise
    /// auto-unlock self-deadlocks into `VaultBusyAuth`. Drive commit to a
    /// fast terminal return (unknown token → `SessionNotFound`) and assert
    /// the permit is free afterward.
    #[test]
    fn commit_with_permit_releases_permit_before_return_for_autounlock() {
        rt().block_on(async {
            let runtime = VaultRuntimeState::default();
            let creation = VaultCreationState::default();
            let tmp =
                crate::test_support::ScopedTempDir::new("commit-release").expect("scoped tempdir");

            let result = commit_with_permit(
                Uuid::new_v4(),
                tmp.path().join("vault.meta"),
                &creation,
                runtime.auth_permits(),
            )
            .await;
            assert!(
                matches!(result, Err(AppError::SessionNotFound)),
                "expected SessionNotFound terminal return, got {result:?}"
            );

            // The permit MUST be free now — the auto-unlock `vault_unlock`
            // would otherwise self-deadlock into VaultBusyAuth.
            assert_eq!(
                runtime.auth_permits().available_permits(),
                1,
                "commit must release the permit before returning (auto-unlock self-deadlock guard)"
            );
            assert!(
                runtime.auth_permits().try_acquire().is_ok(),
                "subsequent vault_unlock must be able to acquire the permit"
            );
        });
    }

    /// IPC wire contract for the new variant: `{"kind":"VaultBusyAuth"}` —
    /// bare unit variant, externally tagged, matching
    /// `VaultDeleteError::VaultBusyAuth`'s encoding. Frontend
    /// `vault-creation-errors.ts` matches on this.
    #[test]
    fn vault_busy_auth_serializes_with_kind_tag() {
        let json = serde_json::to_string(&AppError::VaultBusyAuth).expect("serialize variant");
        assert_eq!(json, r#"{"kind":"VaultBusyAuth"}"#);
    }

    #[test]
    fn vault_artifacts_present_serializes_with_kind_tag() {
        // IPC contract: `{"kind":"VaultArtifactsPresent"}` — bare unit
        // variant, externally tagged. Frontend `vault-creation-errors.ts`
        // matches on this. Renamed from `VaultAlreadyExists` on
        // 2026-05-26 per `decisions.md` "vault_create defensive guard
        // extension"; the wire shape changes with the variant name.
        let json =
            serde_json::to_string(&AppError::VaultArtifactsPresent).expect("serialize variant");
        assert_eq!(json, r#"{"kind":"VaultArtifactsPresent"}"#);
    }

    // ---- `vault_artifacts_present` helper unit tests (MYND-105) ----
    //
    // Covers the taxonomy from `decisions.md` 2026-05-26 entry
    // "vault_create defensive guard extension": vault.meta exists OR
    // vault.meta.tmp exists OR notes/ contains a *.myn file. Negative
    // cases also exercised (empty dir, notes/ with non-myn files,
    // nonexistent vault_dir).

    #[test]
    fn vault_artifacts_present_returns_false_for_nonexistent_dir() {
        let tmp = crate::test_support::ScopedTempDir::new("vap-none").expect("scoped tempdir");
        let ghost = tmp.path().join("does-not-exist");
        assert!(
            !vault_artifacts_present(&ghost).expect("nonexistent dir is not an error"),
            "nonexistent vault_dir must report no artefacts"
        );
    }

    #[test]
    fn vault_artifacts_present_returns_false_for_empty_dir() {
        let tmp = crate::test_support::ScopedTempDir::new("vap-empty").expect("scoped tempdir");
        assert!(
            !vault_artifacts_present(tmp.path()).expect("empty dir scan ok"),
            "empty vault_dir must report no artefacts"
        );
    }

    #[test]
    fn vault_artifacts_present_returns_true_when_vault_meta_present() {
        let tmp = crate::test_support::ScopedTempDir::new("vap-meta").expect("scoped tempdir");
        std::fs::write(tmp.path().join("vault.meta"), b"any bytes").expect("seed vault.meta");
        assert!(vault_artifacts_present(tmp.path()).expect("scan ok"));
    }

    #[test]
    fn vault_artifacts_present_returns_true_when_vault_meta_tmp_present() {
        let tmp = crate::test_support::ScopedTempDir::new("vap-tmp").expect("scoped tempdir");
        std::fs::write(tmp.path().join("vault.meta.tmp"), b"interrupted write")
            .expect("seed vault.meta.tmp");
        assert!(
            vault_artifacts_present(tmp.path()).expect("scan ok"),
            "vault.meta.tmp is a recognized mid-write crash artefact"
        );
    }

    #[test]
    fn vault_artifacts_present_returns_true_when_notes_contains_myn_blob() {
        let tmp = crate::test_support::ScopedTempDir::new("vap-myn").expect("scoped tempdir");
        let notes = tmp.path().join("notes");
        std::fs::create_dir_all(&notes).expect("mkdir notes/");
        std::fs::write(
            notes.join("0193e8d3-1234-7890-abcd-ef0123456789.myn"),
            b"orphan blob bytes",
        )
        .expect("seed orphan .myn");
        assert!(
            vault_artifacts_present(tmp.path()).expect("scan ok"),
            "orphan .myn from partial-fail vault_delete is a recognized artefact"
        );
    }

    #[test]
    fn vault_artifacts_present_returns_false_when_notes_empty() {
        let tmp =
            crate::test_support::ScopedTempDir::new("vap-notes-empty").expect("scoped tempdir");
        std::fs::create_dir_all(tmp.path().join("notes")).expect("mkdir notes/");
        assert!(
            !vault_artifacts_present(tmp.path()).expect("scan ok"),
            "empty notes/ is not a recognized artefact"
        );
    }

    /// MYND-160 Task 12: a successful `commit_with_vault_path` produces
    /// BOTH `vault.meta` AND `vault.prefs` on disk. Closed invariant
    /// from `decisions.md` 2026-05-27 "Vault preferences blob" entry.
    /// Verifies user story 6 (fresh vault default-ON via the persisted
    /// `PrefsView::default()`) and story 7 (legacy / first-unlock-read
    /// returns defaults regardless — but eager-write makes the eager
    /// case the standard path).
    #[test]
    fn commit_eager_writes_vault_prefs_alongside_vault_meta() {
        rt().block_on(async {
            let scratch = ScratchVault::new();
            let state = VaultCreationState::default();
            let token = seed_session_into_state(&state);

            let result = commit_with_vault_path(token, scratch.path().to_path_buf(), &state).await;
            assert!(
                result.is_ok(),
                "commit happy-path must succeed; got {result:?}"
            );

            // vault.meta is on disk per the existing pipeline.
            assert!(
                scratch.path().exists(),
                "vault.meta must exist after commit happy-path"
            );
            // MYND-160 closed invariant: vault.prefs is on disk too.
            assert!(
                scratch.dir.join("vault.prefs").exists(),
                "vault.prefs must exist after commit happy-path (MYND-160 eager-write)"
            );
        });
    }

    /// MYND-160 Task 12: the eager-written `vault.prefs` decrypts under
    /// the same `root_key` the just-created vault carries, and the
    /// plaintext is `PrefsView::default()` (screen_capture_protection
    /// defaults to `true` per spec § 9.5.5 safer-state semantic).
    /// Pins the round-trip property: a fresh vault opened immediately
    /// after creation reads its prefs as the documented defaults — no
    /// AEAD-fail surprise, no garbage bytes.
    #[test]
    fn commit_eager_written_vault_prefs_decrypts_to_defaults() {
        rt().block_on(async {
            let scratch = ScratchVault::new();
            let state = VaultCreationState::default();

            // Build session OUT-OF-BAND so we hold the root_key for
            // the post-commit decryption assertion. (`seed_session_into_state`
            // moves the session into state.)
            let token = Uuid::new_v4();
            let session = build_session("commit-test-pw", FAST_TEST_KDF).expect("build_session");
            let original_root_key: [u8; AEAD_KEY_LEN] = *session.root_key;
            let original_account_hash = session.account.hash;
            state
                .try_insert(token, session)
                .expect("scratch state has room");

            commit_with_vault_path(token, scratch.path().to_path_buf(), &state)
                .await
                .expect("commit happy-path");

            // Decrypt the eager-written vault.prefs using the original
            // root_key and account_number_hash.
            let prefs_bytes = std::fs::read(scratch.dir.join("vault.prefs"))
                .expect("vault.prefs must exist after eager-write");
            let prefs_key =
                protocol::derive_subkey(&original_root_key, protocol::SubkeyRole::PrefsKey);
            let prefs_view =
                protocol::decode_prefs_blob(&prefs_key, &original_account_hash, &prefs_bytes)
                    .expect(
                        "eager-written vault.prefs must decrypt under the vault's own root_key",
                    );
            assert_eq!(
                prefs_view,
                protocol::PrefsView::default(),
                "eager-written prefs must equal PrefsView::default()"
            );
            assert!(
                prefs_view.screen_capture_protection,
                "default screen_capture_protection must be on (spec § 9.5.5 safer-state)"
            );
        });
    }

    #[test]
    fn vault_artifacts_present_returns_true_when_vault_prefs_present() {
        // MYND-160 extension: `vault.prefs` is a v0.1 vault artefact
        // (spec § 9.5). A stale vault.prefs left by a prior partial-fail
        // `vault_delete` or manual cleanup must gate a fresh
        // `vault_create` the same way `vault.meta` does — otherwise the
        // fresh vault co-mingles with a vault.prefs encrypted under a
        // different root_key (AEAD-fail on read; user sees defaults
        // instead of a clean fresh state).
        let tmp = crate::test_support::ScopedTempDir::new("vap-prefs").expect("scoped tempdir");
        std::fs::write(tmp.path().join("vault.prefs"), b"stale prefs bytes")
            .expect("seed vault.prefs");
        assert!(
            vault_artifacts_present(tmp.path()).expect("scan ok"),
            "vault.prefs is a recognized v0.1 vault artefact (spec § 9.5)"
        );
    }

    #[test]
    fn vault_artifacts_present_returns_true_when_vault_prefs_tmp_present() {
        // Mid-write crash artefact for vault.prefs (parallel to
        // vault.meta.tmp for vault.meta), produced by `atomic_write`'s
        // tempfile-rename path. Same defensive-guard rationale.
        let tmp = crate::test_support::ScopedTempDir::new("vap-prefs-tmp").expect("scoped tempdir");
        std::fs::write(
            tmp.path().join("vault.prefs.tmp"),
            b"interrupted prefs write",
        )
        .expect("seed vault.prefs.tmp");
        assert!(
            vault_artifacts_present(tmp.path()).expect("scan ok"),
            "vault.prefs.tmp is a recognized mid-write crash artefact"
        );
    }

    #[test]
    fn vault_artifacts_present_returns_false_when_notes_contains_only_non_myn() {
        let tmp =
            crate::test_support::ScopedTempDir::new("vap-notes-other").expect("scoped tempdir");
        let notes = tmp.path().join("notes");
        std::fs::create_dir_all(&notes).expect("mkdir notes/");
        std::fs::write(notes.join(".DS_Store"), b"x").expect("seed .DS_Store");
        std::fs::write(notes.join("readme.txt"), b"x").expect("seed readme.txt");
        assert!(
            !vault_artifacts_present(tmp.path()).expect("scan ok"),
            "non-myn files (OS artefacts, user notes) must not gate vault_create"
        );
    }

    // ---- Cross-plugin orphan-state guard test (MYND-105 Task 3) ----
    //
    // Asserts that `commit_with_vault_path` rejects with
    // `VaultArtifactsPresent` when the target path has orphan `.myn`
    // files (e.g., from a partial-fail `vault_delete`) even though
    // `vault.meta` itself is absent. This is the rationale for the
    // T2b semantic broadening: without the recognized-artefact check,
    // create-vault would proceed and the unlock side would surface
    // ghost notes from the previous partial-deletion state.

    #[test]
    fn commit_rejects_when_orphan_myn_present_without_vault_meta() {
        rt().block_on(async {
            let scratch = ScratchVault::new();
            // Construct orphan disk state: notes/<uuid>.myn but NO
            // vault.meta. Simulates a partial-fail vault_delete that
            // removed vault.meta first but failed on the .myn file.
            let notes = scratch.dir.join("notes");
            std::fs::create_dir_all(&notes).expect("mkdir notes/");
            std::fs::write(
                notes.join("0193e8d3-1234-7890-abcd-ef0123456789.myn"),
                b"orphan blob - cryptographically junk after root_key zeroize",
            )
            .expect("seed orphan .myn");
            assert!(
                !scratch.meta_path.exists(),
                "test premise: vault.meta absent (partial-fail simulation)"
            );

            let state = VaultCreationState::default();
            let token = seed_session_into_state(&state);

            let result =
                commit_with_vault_path(token, scratch.path().to_path_buf(), &state).await;

            assert!(
                matches!(result, Err(AppError::VaultArtifactsPresent)),
                "commit must reject orphan-myn-without-vault-meta state, got {result:?}"
            );

            // Non-destructive: session restored for retry after user
            // manually cleans (or in v0.2, via vault_repair MYND-159).
            match state.take(token) {
                SessionLookup::Found(_) => {}
                SessionLookup::NotFound => panic!(
                    "guard dropped the session - non-destructive contract broken; retry with same token would now fail with SessionNotFound"
                ),
                SessionLookup::Expired => panic!(
                    "guard mis-routed the session through TTL eviction - should be a clean re-insert"
                ),
            }
        });
    }

    #[test]
    fn weak_new_password_serializes_with_kind_tag() {
        // Cross-plugin shared variant name with
        // `VaultRecoveryError::WeakNewPassword` and the future
        // `VaultPasswordChangeError::WeakNewPassword` (Q6 of the
        // MYND-22 grilling). Wire shape MUST be identical:
        // `{"kind":"WeakNewPassword"}`.
        let json = serde_json::to_string(&AppError::WeakNewPassword).expect("serialize variant");
        assert_eq!(json, r#"{"kind":"WeakNewPassword"}"#);
    }
}
