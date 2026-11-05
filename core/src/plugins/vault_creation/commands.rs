// SPDX-License-Identifier: AGPL-3.0
//! Tauri commands for the vault-creation flow.
//!
//! - [`begin`]  → session creation (Task 12).
//! - [`commit`] → write `vault.meta` to disk (Task 13).
//! - [`cancel`] → drop a session (Task 14).

use super::error::AppError;
use super::state::{
    CreationPerson, CreationPersonRequest, SessionLookup, VaultCreationSession, VaultCreationState,
};
use crate::host::HostCtx;
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use crate::vault_id::VaultId;
use protocol::{
    KdfParams, MetaVersion, AEAD_KEY_LEN, AEAD_NONCE_LEN, ARGON2_SALT_LEN, DEFAULT_V0_1_KDF_PARAMS,
    VAULT_META_ITEMS_KEY_ID_LEN, VAULT_META_WRAPPED_ITEMS_KEY_LEN, VAULT_META_WRAPPED_ROOT_KEY_LEN,
};
use serde::Serialize;
use std::path::{Path, PathBuf};
// Tauri types serve only the cfg-gated IPC wrappers (task 79, Option B).
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use crate::host::tauri_host::TauriHost;
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use tauri::{Runtime, State};
use uuid::Uuid;
use zeroize::Zeroizing;

/// The generation a vault created **today** is born in.
///
/// Every write on the creation path derives and frames through this one constant
/// — the credential wrap keys, the `itemsKey` wrap, the three AADs, `vault.meta`
/// itself, and the two singletons seeded beside it. Reading it is how you tell
/// what a fresh vault is; changing it is the whole of the birth-format decision,
/// and it is a **major-version event for every client**: §10.5 makes a v0.1
/// client refuse an `NTV5` vault outright rather than half-open it, so a device
/// left on an older release cannot join an account created after the flip.
///
/// v0.1 stays fully READABLE — it is what the §10.4 migration reads from, what
/// `parse_vault_meta_any` accepts, and what every `*_versioned` helper's v0.1 arm
/// serves — but nothing in the product produces it any more. The fixtures that
/// still do are test-only and say so.
const BIRTH_GENERATION: MetaVersion = MetaVersion::V0_2;

/// Result returned by [`begin`].
///
/// `phrase` is a clone of the session's 24-word BIP-39 phrase so the
/// frontend can display it; the master copy stays in
/// [`VaultCreationSession`] (Zeroizing) for the recovery-wrap-key
/// computation in `commit`. It is `None` for a person-born vault: the vault
/// phrase is retired there, so there is neither a wrap to derive nor words to
/// show (myne-md/myne#911 task 5).
///
/// `account_number` is the display form (`MY-XXXX-XXXX-XXXX-XXXX-XXXX`).
/// For a person-born vault it is the PERSON's number, which is the same on
/// every vault that person creates.
///
/// `session_token` is an opaque UUID — not a secret. The frontend
/// holds it across the confirmation challenge and replays it to
/// `commit` / `cancel`.
#[derive(Serialize)]
pub struct BeginResult {
    pub phrase: Option<[String; 24]>,
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
///
/// SYNC-6 create targeting: `begin` mints a fresh, collision-free
/// [`VaultId`] (`vault_registry::mint_unique_vault_id`, scanned against the
/// live `vaults/` dir) and stores it on the session, so `commit` writes the
/// new vault to `vaults/<minted-id>/`. This makes the first vault (fresh
/// install) AND every "create another" vault land in a freshly-minted
/// `vaults/<id>/` — there is no longer a transitional fall-back to the legacy
/// `vault/` directory for a newly-created vault. The `AppHandle` is needed
/// only to resolve `<app_data_dir>` for the collision scan; minting is cheap
/// and runs before the slot reservation + Argon2id work.
pub async fn begin_from_host(
    person: CreationPersonRequest,
    password: String,
    state: &VaultCreationState,
    host: &dyn HostCtx,
) -> Result<BeginResult, AppError> {
    // Mint the fresh `VaultId` for this creation BEFORE reserving a slot or
    // kicking off Argon2id — it is a cheap UUIDv7 + a read-only `vaults/`
    // collision scan, and resolving `<app_data_dir>` here keeps the
    // `AppHandle` out of the `spawn_blocking` closure. `commit` resolves the
    // write destination to `vaults/<minted-id>/` from the session by default
    // (SYNC-6). An `app_data_dir` lookup failure fails fast without
    // consuming a session slot.
    let base = host.app_data_dir().map_err(|_| AppError::Io {
        kind: crate::plugins::vault_creation::error::IoErrorKind::Other,
    })?;
    let vault_id = crate::vault_registry::mint_unique_vault_id(&base);
    begin_with_vault_id(person, password, vault_id, state, host).await
}

/// [`begin_from_host`] with the destination [`VaultId`] supplied by the caller.
///
/// Split out for the web client (`decisions.md` 2026-08-15). Minting is the one
/// thing that does not transfer: a browser holds exactly ONE container per
/// origin at the constant `paths::web_single_vault_id()`, so there is nothing to
/// enumerate and nothing to avoid colliding with. Worse, the mint is not merely
/// unnecessary there — `mint_unique_vault_id` scans `vaults/` with
/// `std::fs::read_dir`, which on `wasm32-unknown-unknown` fails at runtime and
/// would hand back a random UUIDv7 instead of the constant, putting the
/// container somewhere the rest of this client cannot find it.
///
/// Everything after the id is identical on both platforms, which is the point:
/// the password floor, the slot reservation, the Argon2id derivation and the
/// session are one implementation, not two.
pub async fn begin_with_vault_id(
    person: CreationPersonRequest,
    password: String,
    vault_id: crate::vault_id::VaultId,
    state: &VaultCreationState,
    host: &dyn HostCtx,
) -> Result<BeginResult, AppError> {
    // A sealed-but-locked identity is refused BEFORE any work. The alternative the
    // legacy path would take is a second recovery phrase for a user the product
    // promises exactly one, which is why this is a refusal rather than a fallback
    // (myne-md/myne#911 task 5).
    //
    // This lives HERE rather than in `begin_from_host`, and that placement is the
    // guard rather than a tidy-up: `begin_with_vault_id` is the web client's entry
    // point (`web/wasm/src/dispatch.rs` calls it directly with the raw
    // `creation_person_from_host` answer), so a refusal only in `begin_from_host`
    // was enforced on one of three client paths. A browser whose identity exists
    // but whose session is not installed then silently minted an `NTV5` vault with
    // a brand-new 24-word phrase.
    //
    // Below the wrap below on purpose: the password is already in hand when this
    // guard fires, so an early return above it would drop a master password as an
    // un-zeroized `String`, which is the exception the wrap's own comment says the
    // pattern exists to avoid.
    // Wrap immediately so any early-return path (slot-cap rejection,
    // spawn_blocking join failure, build_session error) drops the
    // wrapper and zeroes the bytes. Plain `String` would drop without
    // zeroize. Retroactive memory-hygiene fix bundled with
    // `vault-unlock-password` Task 7 — same pattern Task 2 established
    // for the unlock command. `build_session` borrows `&str` (signature
    // unchanged); the deref chain `&Zeroizing<String>` → `&String` →
    // `&str` holds via standard deref coercion.
    let password = Zeroizing::new(password);

    if matches!(person, CreationPersonRequest::Locked) {
        tracing::error!(
            stage = "begin_person",
            error_kind = "PersonLocked",
            "vault creation refused: a person identity is sealed but its session is locked"
        );
        return Err(AppError::PersonLocked);
    }

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
    // captured wrapper drops in spawn_blocking's task pool. The minted
    // `vault_id` (Copy) moves into the closure and is stored on the session.
    let session = crate::task::run_blocking(move || match person {
        CreationPersonRequest::Unlocked(who) => {
            build_person_session(vault_id, &password, DEFAULT_V0_1_KDF_PARAMS, *who)
        }
        // `Absent` is the pre-change birth. `Locked` is refused at the top of this
        // function, so it cannot reach the match; reading it as `Absent` would mint
        // the second phrase the refusal exists to prevent.
        CreationPersonRequest::Absent => {
            build_session(vault_id, &password, DEFAULT_V0_1_KDF_PARAMS)
        }
        CreationPersonRequest::Locked => unreachable!("Locked is refused above"),
    })
    .await
    .map_err(|_| AppError::JoinFailure)??;

    // Take the visible parts out before moving the session into the
    // map. `phrase.words()` returns `&[String; 24]` from inside
    // `Zeroizing<...>`; we clone for the frontend response. The
    // master phrase stays Zeroized in the session. A person-born session
    // carries no phrase at all, and the response says so rather than
    // sending an empty twenty-four-word array the UI would have to
    // interpret.
    let phrase = session.phrase.as_ref().map(|p| p.words().clone());
    let account_number = session.account.display.clone();
    let token = Uuid::new_v4();

    // Materialize the reservation as a live session entry. The
    // reservation is consumed (its Drop is suppressed); the slot
    // stays accounted for until `commit` / `cancel` / TTL eviction
    // removes the session.
    //
    // The TTL clock reading comes from the host seam rather than
    // `Instant::now()`: that call compiles for `wasm32-unknown-unknown` and
    // panics there at runtime, which would trap the web client's wasm instance
    // on the first `begin` (`decisions.md` 2026-08-15 ships creation on web).
    state.commit_reservation(reservation, token, session, host.monotonic_millis());

    Ok(BeginResult {
        phrase,
        account_number,
        session_token: token.to_string(),
    })
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn begin<R: Runtime>(
    password: String,
    state: State<'_, VaultCreationState>,
    runtime_state: State<'_, VaultRuntimeState>,
    app: tauri::AppHandle<R>,
) -> Result<BeginResult, AppError> {
    let host = TauriHost::new(app);
    let person =
        creation_person_from_host(&host, &crate::vault_io::StdVaultIo, runtime_state.inner()).await;
    begin_from_host(person, password, state.inner(), &host).await
}

/// What the person plane says about a creation about to start.
///
/// Three answers, and the middle one is the load-bearing one. A device with a
/// SEALED identity is refused rather than handed the legacy birth, because the
/// legacy birth mints a second recovery phrase for a user the product promises
/// exactly one. Absence is genuinely different from lockedness: with no identity
/// at all the pre-change flow is the right answer, and it is what every client
/// whose identity-first first run has not shipped yet still gets.
///
/// `Locked` also covers the mismatch case (a session installed for a DIFFERENT
/// person than the credential names), which reads as locked on purpose: the one
/// thing that must not happen there is sealing a vault to the wrong owner.
/// Ungated, and taking an `io`, since myne-md/myne#911 task 13: the web client
/// creates vaults on the person path too, and its person credential lives behind
/// its own `VaultIo` (`web/wasm/src/person_io.rs`) rather than on a filesystem.
/// The desktop passes `&StdVaultIo`; the browser passes its session-scoped one.
pub async fn creation_person_from_host(
    host: &dyn HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    state: &VaultRuntimeState,
) -> CreationPersonRequest {
    let Ok(status) =
        crate::plugins::sync::person_account::person_status_from_host(host, io, state).await
    else {
        // A credential that cannot be read is not an identity we can seal to,
        // and it is not evidence of absence either. Refusing is the safe arm.
        return CreationPersonRequest::Locked;
    };
    if status.state.is_none() {
        // `state: None` means "no identity is loaded in this session", which is
        // NOT the same as "no identity exists here". On the web client the two
        // person files are session-only by design, so every reload produces
        // exactly this answer for a device whose identity is fine. Reading it as
        // ABSENCE hands the user the legacy `NTV5` birth, which mints a second
        // 24-word phrase and a vault the identity does not open (myne-md/myne#911
        // review). The durable marker is what separates the two cases, and the
        // remedy it points at is the phrase prompt, not a second identity.
        if crate::plugins::sync::person_account::identity_marker_present(host, io).await {
            return CreationPersonRequest::Locked;
        }
        return CreationPersonRequest::Absent;
    }
    if !status.identity_unlocked {
        return CreationPersonRequest::Locked;
    }
    let (Some(pair), Some(person_id_hex)) =
        (state.clone_person_identity().await, status.person_id_hex)
    else {
        return CreationPersonRequest::Locked;
    };
    let Some(person_id) = crate::plugins::sync::devices::hex16(&person_id_hex) else {
        return CreationPersonRequest::Locked;
    };
    CreationPersonRequest::Unlocked(Box::new(CreationPerson {
        pair,
        person_id,
        number: protocol::account_number_from_person_id(&person_id),
    }))
}

/// Pure-function helper — no Tauri runtime, no async — that builds a
/// fresh [`VaultCreationSession`] from a password and a pre-minted
/// [`VaultId`].
///
/// `vault_id` is the fresh, collision-free id minted by the caller
/// (`begin` mints it via `vault_registry::mint_unique_vault_id` against
/// the live `vaults/` dir; tests pass a bare `VaultId::mint()`). It is
/// stored on the session so `commit` resolves the write destination to
/// `vaults/<vault_id>/` by default (SYNC-6 create targeting).
///
/// Tests instantiate this directly with fast Argon2id parameters
/// (`m_kib=8, t=1, p=1`) so they don't need a Tauri runtime and don't
/// pay the 1–2 second default-parameter cost. Production calls through
/// `begin` always pass `DEFAULT_V0_1_KDF_PARAMS`. The chosen params
/// are stored on the returned session so `commit` rebuilds the AADs
/// and `vault.meta` under the same set.
pub fn build_session(
    vault_id: VaultId,
    password: &str,
    kdf_params: KdfParams,
) -> Result<VaultCreationSession, AppError> {
    let account = protocol::generate_account_number()?;
    let phrase = protocol::generate_recovery_phrase()?;
    let root_key = protocol::generate_root_key()?;

    let salt_password: [u8; ARGON2_SALT_LEN] = random_bytes()?;
    let salt_recovery: [u8; ARGON2_SALT_LEN] = random_bytes()?;

    // BIRTH FORMAT: v0.2. A vault created today is born `NTV5`/`NC05`, so both
    // wrap keys derive under the v0.2 salt domain (`myne.v0.2 argon2id-…|`).
    // v0.1 remains fully readable — it is what the §10.4 migration reads FROM —
    // but nothing produces it any more.
    //
    // The 16-byte binding in the salt is this vault's `account_number_hash`,
    // which is also what §9.3 offset 6 carries, so the legacy birth is
    // byte-identical to what it was before the person account existed.
    let vault_binding = account.hash;
    let password_wrap_key = protocol::derive_password_wrap_key_v0_2(
        password,
        &salt_password,
        &vault_binding,
        &kdf_params,
    )?;
    let recovery_wrap_key = protocol::derive_recovery_wrap_key_v0_2(
        &phrase,
        &salt_recovery,
        &vault_binding,
        &kdf_params,
    )?;

    Ok(VaultCreationSession {
        vault_id,
        vault_binding,
        account,
        phrase: Some(phrase),
        kdf_params,
        root_key,
        salt_password,
        salt_recovery,
        password_wrap_key,
        recovery_wrap_key: Some(recovery_wrap_key),
        person: None,
        // Stamped by `commit_reservation` when the session enters the map;
        // `build_session` is pure and holds no clock. See the field's docs.
        created_at: 0,
    })
}

/// Build a **person-born** creation session: the `NTV8` generation
/// (myne-md/myne#911 task 5, retargeted by myne-md/myne#938).
///
/// Three differences from [`build_session`], and each is a retirement rather
/// than an addition:
///
/// - **No vault phrase.** None is generated, so none is returned and none is
///   wrapped. The person's identity phrase is the single recovery credential and
///   it already exists on the device.
/// - **No recovery salt or wrap key.** Their three §9.3 fields are written as
///   zeros, which `NTV8`'s writer and parser both enforce structurally.
/// - **No person wrap either**, so the identity phrase does not open the vault:
///   the password is the only door (`decisions/protocol/0758`).
/// - **A random per-vault binding** replaces `account_number_hash` as the salt
///   input. The number is a property of the PERSON, so it can no longer
///   separate one vault of that person from another, and the generation keeps it
///   out of vault cryptography. The same 16 bytes are what §9.3 offset 6
///   carries, so the frame needs no new field.
pub fn build_person_session(
    vault_id: VaultId,
    password: &str,
    kdf_params: KdfParams,
    person: CreationPerson,
) -> Result<VaultCreationSession, AppError> {
    let root_key = protocol::generate_root_key()?;
    let vault_binding: [u8; 16] = random_bytes()?;
    let salt_password: [u8; ARGON2_SALT_LEN] = random_bytes()?;
    let password_wrap_key = protocol::derive_password_wrap_key_v0_2(
        password,
        &salt_password,
        &vault_binding,
        &kdf_params,
    )?;

    Ok(VaultCreationSession {
        vault_id,
        vault_binding,
        account: person.number.clone(),
        phrase: None,
        kdf_params,
        root_key,
        salt_password,
        // All zero: there is no recovery wrap in this generation, and `NTV8`
        // refuses to write a frame where they are anything else.
        salt_recovery: [0u8; ARGON2_SALT_LEN],
        password_wrap_key,
        recovery_wrap_key: None,
        person: Some(person),
        created_at: 0,
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
/// Returns the canonical string form of the `VaultId` the new vault was
/// written to (`Some` for the normal `vaults/<id>/` path; `None` only on the
/// legacy sole-vault fallback). The frontend threads this id straight into the
/// chained `vault_unlock` so the auto-unlock targets the just-created vault
/// rather than the ambiguous sole-vault fallback — which, once a second vault
/// exists, resolves to a non-existent legacy path (`VaultNotFound`).
// The doc above uses an `a.` / `b.` sub-outline under numbered step 3. Markdown
// recognises only digit-led ordered lists, so it reads those lines as
// continuations of step 3 and calls their indentation wrong. The prose has been
// correct and readable since it was written; what changed is only that moving it
// off a `#[tauri::command]` item made it visible to these lints for the first
// time (task 79). Scoped to this item, not the crate.
#[allow(clippy::doc_overindented_list_items, clippy::doc_lazy_continuation)]
/// Best-effort sealed membership for a vault under creation (myne-md/myne#684).
///
/// Adopts the not-yet-written vault into the recency-rule account via
/// [`crate::account::store::ensure_vault_membership`] and seals the id THAT
/// call returns, so the sealed field and the record derive from ONE write and
/// can never disagree (the review-round defect was sealing a recency/fresh id
/// here while unlock-time reconcile adopted the vault into the first account
/// and the stamp then skipped as already-present). `None` on ANY failure (no
/// keychain, no registry info, CSPRNG hiccup): the lazy unlock stamp heals the
/// field later, so creation never gates or fails on grouping. Every fallible
/// step maps to `None` rather than `AppError`, which is the one place in this
/// file that shape is correct: grouping is organisational chrome on a vault
/// that must exist either way.
///
/// A failed commit after a successful adoption leaves a ghost member; the next
/// reconcile prunes it (the vault never landed on disk), so the ghost is
/// self-healing rather than structural.
#[cfg(not(target_arch = "wasm32"))]
async fn eager_membership(
    host: &dyn HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    keychain: &dyn crate::vault_label::key::LabelKeychain,
    new_vault_id: crate::vault_id::VaultId,
    root_key: &[u8; protocol::AEAD_KEY_LEN],
    account_number_hash: &[u8; 16],
) -> Option<protocol::Membership> {
    let base = host.app_data_dir().ok()?;
    let config = host.app_config_dir().ok()?;
    let account_id =
        crate::account::store::ensure_vault_membership(io, &config, &base, keychain, new_vault_id)
            .await
            .ok()?;
    let nonce: [u8; protocol::AEAD_NONCE_LEN] = random_bytes().ok()?;
    protocol::seal_membership_raw(root_key, &account_id, account_number_hash, &nonce).ok()
}

// `keychain` is unused on wasm32 (no eager seal there); the allow keeps
// `-D warnings` green on that target without renaming a live param.
#[cfg_attr(target_arch = "wasm32", allow(unused_variables))]
pub async fn commit_from_host(
    vault_id: Option<String>,
    session_token: String,
    state: &VaultCreationState,
    runtime_state: &VaultRuntimeState,
    host: &dyn HostCtx,
    keychain: &dyn crate::vault_label::key::LabelKeychain,
) -> Result<Option<String>, AppError> {
    let token = Uuid::parse_str(&session_token).map_err(|_| AppError::SessionNotFound)?;
    // SYNC-6 create targeting. Resolution precedence for the write
    // destination, all without consuming the session yet:
    //   1. an explicit, well-formed `vault_id` IPC param overrides (kept as an
    //      escape hatch; the create flow does NOT pass one);
    //   2. otherwise the session's own freshly-minted `VaultId` (minted at
    //      `begin`) — the default path BOTH the first vault and every "create
    //      another" vault take, so a new vault always lands at a fresh
    //      `vaults/<id>/` rather than the legacy `vault/` fallback;
    //   3. only if neither is available (no param AND the session is
    //      absent/expired) do we fall through to the sole-vault `vault_dir`
    //      fallback — and in that case the `state.take` inside
    //      `commit_with_vault_path` immediately surfaces the precise
    //      SessionNotFound / SessionExpired, so the path is never written.
    // The session is peeked (not taken) so a path-resolution failure leaves it
    // intact in the live map for a future retry (mirrors the prior ordering).
    let target = crate::vault_id::VaultId::parse_optional(vault_id.as_deref())
        .or_else(|| state.peek_vault_id(token));
    // Resolve the path before consuming the session — if app_data_dir
    // lookup or create_dir_all on the vault subfolder fails, there's
    // nothing to restore yet (the session is still in the live map for
    // a future retry once the underlying condition is fixed).
    let vault_dir = crate::paths::vault_dir_for_id_from_host(host, target)?;
    let vault_path = vault_dir.join("vault.meta");
    // Seal the membership field while the session is still in the map: a
    // resolution failure here leaves the session intact for retry, and a
    // `None` (no keychain, no recency info, CSPRNG hiccup) degrades to the
    // lazy unlock stamp rather than failing creation.
    //
    // `StdVaultIo` does not exist on wasm32 (no `std::fs` behind the seam),
    // and the web client holds one vault per profile with no grouping
    // surface, so that target skips the eager seal by construction and the
    // lazy stamp heals the field on first unlock like every other path.
    #[cfg(not(target_arch = "wasm32"))]
    let membership = match (state.peek_seal_inputs(token), target) {
        (Some((root_key, hash)), Some(new_vault_id)) => {
            eager_membership(
                host,
                &crate::vault_io::StdVaultIo,
                keychain,
                new_vault_id,
                &root_key,
                &hash,
            )
            .await
        }
        _ => None,
    };
    #[cfg(target_arch = "wasm32")]
    let membership = None;
    let claim_inputs = commit_with_permit(
        token,
        vault_path,
        state,
        runtime_state.auth_permits(),
        membership,
    )
    .await?;
    // ---- myne-md/myne#1001: this device claims its binding AT CREATION ----
    //
    // The ceremony is the last moment the person key is in hand, and the only claim site
    // that does not depend on the user typing the phrase. `0774`'s rejected alternative
    // says it: "a `NTV5` single-user vault has no binding at all and never will, so the
    // creation path records the claim's outcome". That outcome is the structured line the
    // claim writes (`claim_completed` / `claim_stood_down`), and the surface that reports it
    // to a user is the sync indicator, which asks the authority resolver rather than
    // reading this return value, so `commit`'s IPC shape does not change for it.
    //
    // Best-effort and AFTER the permit, deliberately: a device that cannot record its
    // binding must still get its vault, and this is not a `vault.meta` lifecycle mutation,
    // so it neither blocks the creation nor extends the permit's scope. Web has no
    // member surface at all, hence the gate (its path is `commit_from_host_io`).
    #[cfg(not(target_arch = "wasm32"))]
    if let Some(inputs) = claim_inputs {
        crate::plugins::device_binding::commands::claim_own_binding_from_creation_best_effort(
            host,
            &crate::vault_io::StdVaultIo,
            &vault_dir,
            &inputs.group_key,
            &inputs.person.pair,
        )
        .await;
    }
    // Surface the written-to vault id so the frontend's chained auto-unlock can
    // target it explicitly (`target` is `Copy`, untouched by the path resolve).
    Ok(target.map(|id| id.to_string()))
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn commit<R: Runtime>(
    vault_id: Option<String>,
    session_token: String,
    state: State<'_, VaultCreationState>,
    runtime_state: State<'_, VaultRuntimeState>,
    app: tauri::AppHandle<R>,
) -> Result<Option<String>, AppError> {
    commit_from_host(
        vault_id,
        session_token,
        state.inner(),
        runtime_state.inner(),
        &TauriHost::new(app),
        crate::vault_label::key::platform_keychain(),
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
    membership: Option<protocol::Membership>,
) -> Result<Option<CreationClaimInputs>, AppError> {
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
    commit_with_vault_path(token, vault_path, state, membership).await
    // `_permit` drops here on every return path → released before the
    // frontend's subsequent auto-unlock `vault_unlock` acquires, and before the
    // creation-time device-binding claim, which is not a `vault.meta` mutation and
    // therefore owes this permit nothing (myne-md/myne#1001).
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
/// `snapshots/` directory contains at least one `*.myn` file (MYND-96:
/// orphan encrypted per-note snapshot blobs from a partial-fail
/// `vault_delete` — sealed under a prior `root_key`/`itemsKey` lineage,
/// same gate rationale as orphan `notes/*.myn`).
///
/// Future per-vault artefact families (Phase 1.5 FTS index, attachments)
/// extend this helper by adding a check in the same PR that introduces
/// the artefact — concrete maintenance discipline preserved by the dual
/// taxonomy with `vault_delete`'s recursive unlink (decisions.md
/// 2026-05-26 entry "vault_create defensive guard extension", T1a + T2b
/// sub-decisions; MYND-96 added the `snapshots/` check). The check
/// intentionally does NOT recognize arbitrary
/// files under `vault_dir` (e.g., `.DS_Store`, `Thumbs.db`,
/// OS-injected artefacts) — those are not vault state and must not
/// gate `vault_create`.
///
/// `pub(crate)` so the future `vault_repair` (v0.2, Plane MYND-159)
/// can re-use the same predicate without duplication.
///
/// **Per-vault-directory scoping (SYNC-9, MYND-202).** This predicate is a
/// pure function of the passed `vault_dir`: every probe is a
/// `vault_dir.join(...)`, and there is no hidden resolution of a global
/// `vault/` (or `vaults/`) location. Under the multi-vault `vaults/<id>/`
/// layout the create path mints a fresh empty `vaults/<new-id>/` and passes
/// *that* directory in, so the guard fires only on a genuine same-dir
/// overwrite — a fully-populated sibling `vaults/<other-id>/` elsewhere never
/// trips it. "Creating a vault never overwrites an existing `vault.meta`"
/// therefore holds **per-vault-dir**. SYNC-9 keeps the predicate verbatim;
/// the per-dir guarantee is a property of the call site (the freshly-minted
/// dir) plus this purity, not a code change to the guard.
pub fn vault_artifacts_present(vault_dir: &Path) -> std::io::Result<bool> {
    if !vault_dir.exists() {
        return Ok(false);
    }
    if vault_dir.join("vault.meta").is_file() {
        return Ok(true);
    }
    if vault_dir.join("vault.meta.tmp").is_file() {
        return Ok(true);
    }
    // A staged newer-generation meta (myne-md/myne#447). It only exists beside a
    // real `vault.meta`, so this arm is defence in depth rather than a reachable
    // state — but a directory holding one is unambiguously a vault, and a fresh
    // creation on top of it would leave a staged meta from a different account
    // for the new vault's unlock to try.
    if vault_dir
        .join(crate::plugins::vault_migrate::adopt::INCOMING_META_FILE)
        .is_file()
    {
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
    // MYND-169: `vault.attachments` (spec § 9.10, MYC1) is the v0.1
    // attachments-catalog blob. Recognized the same way `vault.prefs` is —
    // a stale catalog left by a partial-fail `vault_delete` was encrypted
    // under a prior `root_key` and would AEAD-fail (silently fall back to
    // empty) under a fresh vault's catalog KEK, defeating the
    // closed-invariant intent of the eager-write at vault_create.
    if vault_dir.join("vault.attachments").is_file() {
        return Ok(true);
    }
    if vault_dir.join("vault.attachments.tmp").is_file() {
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
    // MYND-169: orphan attachment blobs under `attachments/` (any regular
    // file) — partial-fail `vault_delete` leftovers, same class as orphan
    // `notes/*.myn`. The blobs are content-addressed hex filenames (no
    // extension), so recognize ANY regular file in the directory.
    let attachments = vault_dir.join("attachments");
    if attachments.is_dir() {
        for entry in std::fs::read_dir(&attachments)? {
            let entry = entry?;
            if entry.path().is_file() {
                return Ok(true);
            }
        }
    }
    // MYND-96: orphan snapshot blobs under `snapshots/` gate a fresh create the
    // same way orphan `notes/*.myn` do (a partial-fail `vault_delete` leftover
    // sealed under a prior key lineage).
    let snapshots = vault_dir.join("snapshots");
    if snapshots.is_dir() {
        for entry in std::fs::read_dir(&snapshots)? {
            let entry = entry?;
            if entry.path().extension().is_some_and(|e| e == "myn") {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

/// What a person-born birth hands to the device-binding claim (myne-md/myne#1001).
///
/// `None` on a legacy `NTV5` birth, and that is an answer rather than an omission: a
/// single-user vault carries no binding store and never will, so there is nothing to claim
/// and no group tier to seal a row under (`0774`, "Blocking vault creation when the claim
/// cannot run").
///
/// Both fields are already in the creation session. They leave this module only to reach the
/// claim, and the group key stays a `Zeroizing` for its whole life: it never crosses the IPC
/// boundary and it is not written anywhere the session did not already write it. There is
/// deliberately no `Debug`, like every type that carries the owner's person keypair.
///
/// The `allow` is the same pattern the two `commit_from_host` signatures carry and for the
/// same reason: the claim itself is native-only, so on `wasm32` these fields have no reader
/// and the browser lane's clippy (`-D warnings`) would fail the build on dead code that only
/// looks dead on one target.
#[cfg_attr(target_arch = "wasm32", allow(dead_code))]
pub(crate) struct CreationClaimInputs {
    pub group_key: Zeroizing<[u8; protocol::AEAD_KEY_LEN]>,
    pub person: crate::plugins::vault_creation::state::CreationPerson,
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
///
/// The return value is what the creation-time device-binding claim needs, and `None` means
/// "no claim applies" rather than "the claim failed". A failure is logged by the claim
/// itself and never reaches this signature, because a device that cannot record its binding
/// must still get its vault (myne-md/myne#1001).
pub(crate) async fn commit_with_vault_path(
    token: Uuid,
    vault_path: PathBuf,
    state: &VaultCreationState,
    membership: Option<protocol::Membership>,
) -> Result<Option<CreationClaimInputs>, AppError> {
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

    // The `VaultCreationSession` is returned by value in the Err arm so the
    // outer code can re-insert it under the same token for non-destructive
    // retry (see below). Box the tuple to keep the Err variant small —
    // clippy::result_large_err (new in Rust 1.96) otherwise flags the ~824-byte
    // payload moving on the stack; the box is on the rare error path only.
    let outcome: Result<Option<CreationClaimInputs>, Box<(AppError, VaultCreationSession)>> =
        crate::task::run_blocking(move || match serialize_meta(&session, &membership) {
            Err(e) => Err(Box::new((e, session))),
            Ok((bytes, group_key)) => match crate::atomic_write::atomic_write(&vault_path, &bytes, false) {
                Err(e) => Err(Box::new((AppError::from(e), session))),
                Ok(()) => {
                    // The tier the two eager singletons are sealed under. A
                    // person-born (`NTV7`) vault follows its roster, so they go
                    // under the GROUP key; every earlier generation derives them
                    // from `root_key`. Sealing an `NTV7` vault's prefs under the
                    // root tier would ship a blob the unlock path cannot open,
                    // which reads as "all preferences silently reset".
                    //
                    // `group_key` itself is kept unmoved beside this: it is what the
                    // creation-time binding claim needs when the birth carried a person
                    // (myne-md/myne#1001).
                    let group_tier = group_key
                        .as_ref()
                        .map(|g| protocol::GroupKey::new(**g));
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
                    let prefs_key = match group_tier {
                        Some(ref group) => {
                            protocol::derive_group_subkey_v0_2(group, protocol::GroupRole::PrefsKey)
                        }
                        None => protocol::derive_subkey_versioned(
                            BIRTH_GENERATION,
                            &session.root_key,
                            protocol::SubkeyRole::PrefsKey,
                        ),
                    };
                    let prefs_path = vault_path
                        .parent()
                        .expect("vault_path has a parent (vault dir)")
                        .join("vault.prefs");
                    match protocol::encode_prefs_blob_versioned(
                        BIRTH_GENERATION,
                        &prefs_key,
                        &session.vault_binding,
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

                    // MYND-169: eager-write the empty MYC1 attachments
                    // catalog so every fresh vault carries the closed
                    // invariant "vault.attachments exists immediately after
                    // vault_create completes" — mirrors the vault.prefs
                    // eager-write above. The catalog KEK derives from
                    // root_key (`AttachmentsCatalogKey`), bound to the
                    // account_number_hash AAD. Same partial-fail posture as
                    // vault.prefs: if this write fails the next catalog read
                    // falls back to empty per spec § 9.10.4 (read_or_empty),
                    // so the vault stays usable — no rollback of vault.meta.
                    let catalog_key = match group_tier {
                        Some(ref group) => protocol::derive_group_subkey_v0_2(
                            group,
                            protocol::GroupRole::AttachmentsCatalogKey,
                        ),
                        None => protocol::derive_subkey_versioned(
                            BIRTH_GENERATION,
                            &session.root_key,
                            protocol::SubkeyRole::AttachmentsCatalogKey,
                        ),
                    };
                    let catalog_path = vault_path
                        .parent()
                        .expect("vault_path has a parent (vault dir)")
                        .join("vault.attachments");
                    match protocol::encode_attachments_catalog_versioned(
                        BIRTH_GENERATION,
                        &catalog_key,
                        &session.vault_binding,
                        &protocol::AttachmentsCatalog::empty(),
                    ) {
                        Ok(catalog_bytes) => match crate::atomic_write::atomic_write(
                            &catalog_path,
                            &catalog_bytes,
                            false,
                        ) {
                            Ok(()) => tracing::info!(
                                event = "vault_attachments_eager_written",
                                "vault.attachments eager-write succeeded with empty catalog"
                            ),
                            Err(e) => tracing::warn!(
                                event = "vault_attachments_eager_write_failed",
                                io_failure_kind =
                                    ?crate::io_failure_kind::from_io_error_kind(e.kind()),
                                "vault.meta written but vault.attachments eager-write failed; vault remains usable via spec § 9.10.4 absence-fallback",
                            ),
                        },
                        Err(_e) => tracing::warn!(
                            event = "vault_attachments_eager_encode_failed",
                            "vault.attachments encode failed during eager-write; vault remains usable via spec § 9.10.4 absence-fallback",
                        ),
                    }
                    // The claim's inputs, taken out of the session BEFORE it is dropped
                    // (myne-md/myne#1001). This is the last moment the person key is in hand:
                    // an `NTV7`/`NTV8` vault's unlock can never install a person session
                    // (`person_vault_carrier::carrier_applies` excludes those generations,
                    // `0774` records it as DO NOT ROUTE), so without this a new vault reached
                    // its first lock unbound and sync asked for the phrase.
                    //
                    // A legacy birth carries no group key, so it answers `None` and no claim
                    // is attempted, because a `NTV5` vault has no binding store to write one into.
                    let claim_inputs = match (group_key, session.person) {
                        (Some(group_key), Some(person)) => Some(CreationClaimInputs {
                            group_key,
                            person,
                        }),
                        _ => None,
                    };
                    Ok(claim_inputs)
                }
            },
        })
        .await
        .map_err(|_| AppError::JoinFailure)?;

    match outcome {
        Ok(claim_inputs) => Ok(claim_inputs),
        Err(boxed) => {
            let (err, session) = *boxed;
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
pub fn cancel_from_state(
    session_token: String,
    state: &VaultCreationState,
) -> Result<(), AppError> {
    if let Ok(token) = Uuid::parse_str(&session_token) {
        // Drop runs on the removed session; Zeroizing fields wipe.
        let _ = state.take_ignore_status(token);
    }
    Ok(())
}

/// IPC wrapper. Needs no host — it only drops a creation session.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub fn cancel(session_token: String, state: State<'_, VaultCreationState>) -> Result<(), AppError> {
    cancel_from_state(session_token, state.inner())
}

/// Pure helper: from a [`VaultCreationSession`] (which carries its own
/// `kdf_params`) produce the 345-byte serialized `vault.meta`. Tests
/// instantiate this directly to verify the pipeline without going
/// through Tauri.
///
/// Borrows the session immutably so a failed `atomic_write` can
/// return the session to the caller for retry-on-failure.
pub fn build_and_serialize_vault_meta(
    session: &VaultCreationSession,
) -> Result<[u8; protocol::VAULT_META_LEN], AppError> {
    let meta = build_vault_meta(session, None)?;
    Ok(protocol::serialize_vault_meta_v0_2(&meta)
        .try_into()
        .expect("creation path always emits the 345-byte base layout (membership: None)"))
}

/// [`build_and_serialize_vault_meta`] with the sealed membership field stamped
/// in (the account/vault split, myne-md/myne#684). The vault is open at creation
/// time, so the field is sealed eagerly into the account the recency rule
/// selects. Returns a `Vec<u8>` because the field makes the blob 417 bytes.
pub fn build_and_serialize_vault_meta_with_membership(
    session: &VaultCreationSession,
    membership: protocol::Membership,
) -> Result<Vec<u8>, AppError> {
    let meta = build_vault_meta(session, Some(membership))?;
    Ok(protocol::serialize_vault_meta_v0_2(&meta))
}

/// [`build_and_serialize_vault_meta`] for a PERSON-BORN session: the `NTV8`
/// frame (myne-md/myne#911 task 5, retargeted by myne-md/myne#938).
///
/// Separate rather than folded into the function above because that one returns
/// a fixed 345-byte array, which is exactly what this generation is not
/// (`445 + roster_len`). Split on the session's own shape rather than on
/// a caller flag, so a caller cannot ask for a generation the session was not
/// built for.
pub fn build_and_serialize_person_vault_meta(
    session: &VaultCreationSession,
) -> Result<(Vec<u8>, Zeroizing<[u8; 32]>), AppError> {
    let person = session.person.as_ref().ok_or(AppError::Protocol(
        protocol::ProtocolError::InvalidVaultMeta,
    ))?;
    build_person_vault_meta(session, person)
}

/// What `serialize_meta` hands the writer: the bytes, plus the group key the
/// eager singleton writes need in a generation whose singletons follow the
/// roster (`None` for every pre-`NTV7` birth).
type SerializedMeta = (Vec<u8>, Option<Zeroizing<[u8; 32]>>);

/// Commit-time serializer: the eager membership when creation resolved one,
/// the base 345-byte layout otherwise. One return type (`Vec<u8>`) so both
/// commit paths share the write below.
///
/// A person-born session answers differently in two ways, and both are
/// structural rather than cosmetic. Its frame is `NTV8`, whose length is not a
/// constant (`445 + roster_len`). And it carries its membership through
/// the signed roster, not through the `NTV5` §9.3.1 field, so an eagerly sealed
/// membership is DROPPED here rather than passed through: this generation's
/// writer refuses a base carrying that field, and writing it anyway would shift
/// every offset past the base.
///
/// The group key comes back with the bytes because the caller's eager singleton
/// writes have to seal under the GROUP tier for this generation, exactly as the
/// `NTV6` migration re-seals them.
fn serialize_meta(
    session: &VaultCreationSession,
    membership: &Option<protocol::Membership>,
) -> Result<SerializedMeta, AppError> {
    if let Some(person) = session.person.as_ref() {
        let (bytes, group_key) = build_person_vault_meta(session, person)?;
        return Ok((bytes, Some(group_key)));
    }
    let bytes = match membership {
        Some(m) => build_and_serialize_vault_meta_with_membership(session, m.clone())?,
        None => build_and_serialize_vault_meta(session)?.to_vec(),
    };
    Ok((bytes, None))
}

/// Build the `NTV8` frame for a person-born session: the `NTV6` tail it keeps, a
/// zeroed phrase wrap, and no second credential of any kind (myne-md/myne#938,
/// `decisions/protocol/0758`).
///
/// The shape mirrors `vault_migrate::b2b`'s owner migration, deliberately: that
/// function is the worked example of "mint a group key, wrap it under the owner
/// subkey, seal `items_key` under the group tier, sign a one-row owner roster,
/// seal the roster". What is left of the `NTV7` shape is the roster, which is
/// signed by the person because a signature is identity work and needs no vault
/// credential. The person wrap is gone: `root_key` is sealed under the password
/// and nothing else, so the phrase cannot open this vault even with the identity
/// unlocked.
///
/// Returns the group key alongside the bytes because the caller's eager
/// `vault.prefs` / `vault.attachments` writes are sealed under the group tier in
/// this generation (the shared singletons follow the roster, not `root_key`).
fn build_person_vault_meta(
    session: &VaultCreationSession,
    person: &CreationPerson,
) -> Result<(Vec<u8>, Zeroizing<[u8; 32]>), AppError> {
    let aad_pw = protocol::aad_password_wrap_v0_2(&session.kdf_params);
    let (nonce_password_wrap, enc_root_key_password) =
        seal_32_byte_secret(&session.password_wrap_key, &session.root_key, &aad_pw)?;

    // The group tier the `NTV6` tail carries: epoch 1, the group key wrapped
    // under the owner subkey (`root_key` is the owner's), and the singleton
    // `itemsKey` sealed under the GROUP key rather than under `root_key`.
    let group_bytes = protocol::generate_root_key()?;
    let epoch = 1u64;
    let group_key_nonce: [u8; AEAD_NONCE_LEN] = random_bytes()?;
    let enc_group_key = protocol::aead_seal_ctx(
        &protocol::derive_owner_subkey_v0_2(
            &protocol::OwnerKey::new(*session.root_key),
            protocol::OwnerRole::GroupKeyWrap,
        ),
        &group_key_nonce,
        group_bytes.as_ref(),
        &protocol::aad_vault_group_key_wrap_v0_2(&session.vault_binding, epoch),
    )?;

    let items_uuid = Uuid::now_v7();
    let items_key_id: [u8; VAULT_META_ITEMS_KEY_ID_LEN] = *items_uuid.as_bytes();
    let items_key = protocol::generate_root_key()?;
    let items_key_nonce: [u8; AEAD_NONCE_LEN] = random_bytes()?;
    let enc_items_key = protocol::aead_seal_ctx(
        &protocol::derive_group_subkey_v0_2(
            &protocol::GroupKey::new(*group_bytes),
            protocol::GroupRole::ItemsKeyWrap,
        ),
        &items_key_nonce,
        items_key.as_ref(),
        &protocol::aad_vault_items_key_wrap_v0_2(&items_key_id),
    )?;

    // The owner's own row, signed and sealed like any other roster row. This is
    // why creation needs an UNLOCKED person session: the signature needs the
    // private half, and the wrap alone would not.
    let owner_public = person.pair.public_half();
    let owner_fingerprint = crate::account::person_identity::hex_lower(owner_public.fingerprint());
    let roster = protocol::person_invite::GroupRosterPayload {
        account_number_hash_hex: crate::account::person_identity::hex_lower(&session.vault_binding),
        group_key_epoch: epoch,
        owner_fingerprint_hex: owner_fingerprint.clone(),
        members: vec![protocol::person_invite::GroupRosterMember {
            fingerprint_hex: owner_fingerprint,
            person_id_hex: Some(crate::account::person_identity::hex_lower(
                &person.person_id,
            )),
            display_name: String::new(),
            role: protocol::person_invite::GroupRosterRole::Owner,
            state: protocol::person_invite::GroupMemberState::Live,
            wrapped_group_key_hex: None,
            member_kem_ek_hex: crate::account::person_identity::hex_lower(owner_public.kem_ek()),
            member_ed_pk_hex: crate::account::person_identity::hex_lower(owner_public.ed_pk()),
            member_mldsa_vk_hex: crate::account::person_identity::hex_lower(
                owner_public.mldsa_vk(),
            ),
            previous_fingerprint_hex: None,
            continuity: protocol::person_invite::GroupKeyContinuity::Current,
            transition_hex: None,
        }],
    };
    let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
    let signed_roster = protocol::person_invite::sign_group_roster(&person.pair, &roster, &mut rng)
        .map_err(|_| AppError::Protocol(protocol::ProtocolError::AeadFailure))?;
    let roster_nonce: [u8; AEAD_NONCE_LEN] = random_bytes()?;
    let signed_roster_envelope = protocol::person_invite::seal_group_roster(
        &group_bytes,
        &session.vault_binding,
        epoch,
        &roster_nonce,
        &signed_roster,
    )
    .ok_or(AppError::Protocol(protocol::ProtocolError::AeadFailure))?;

    let base = protocol::VaultMeta {
        // The vault's own random namespace id, NOT the person's number hash:
        // this generation keeps the number out of vault cryptography, and the
        // salts bind this same value (§3.1).
        account_number_hash: session.vault_binding,
        kdf_params: session.kdf_params,
        random_salt_password: session.salt_password,
        // Zeroed, and structurally enforced on both the write and the read
        // side by `serialize_vault_meta_ntv8` / `parse_vault_meta_ntv8`.
        random_salt_recovery: [0u8; ARGON2_SALT_LEN],
        nonce_password_wrap,
        enc_root_key_password,
        nonce_recovery_wrap: [0u8; AEAD_NONCE_LEN],
        enc_root_key_recovery: [0u8; VAULT_META_WRAPPED_ROOT_KEY_LEN],
        items_key_id,
        items_key_nonce,
        enc_items_key: enc_items_key
            .try_into()
            .expect("a 32-byte secret seals to 64 bytes"),
        // Carried by the roster in this generation (§9.3.1's field would shift
        // every offset past the base, which `NTV7`'s writer refuses).
        membership: None,
        person_binding: None,
    };
    let frame = protocol::PasswordOnlyVaultMeta {
        base,
        group_key_nonce,
        enc_group_key: enc_group_key
            .try_into()
            .expect("a 32-byte secret seals to 64 bytes"),
        group_key_epoch: epoch,
        signed_roster_envelope,
    };
    let bytes = protocol::serialize_vault_meta_ntv8(&frame)?;
    Ok((bytes, group_bytes))
}

/// Build the [`protocol::VaultMeta`] for a creation session, with an optional
/// sealed membership field. The shared body of the two serializers above.
fn build_vault_meta(
    session: &VaultCreationSession,
    membership: Option<protocol::Membership>,
) -> Result<protocol::VaultMeta, AppError> {
    // Wrap root_key under password_wrap_key.
    let aad_pw = protocol::aad_password_wrap_v0_2(&session.kdf_params);
    let (nonce_password_wrap, enc_root_key_password) =
        seal_32_byte_secret(&session.password_wrap_key, &session.root_key, &aad_pw)?;

    // Wrap root_key under recovery_wrap_key. A person-born session has no
    // recovery wrap at all, and never reaches this function (see
    // `serialize_meta`), so the `None` here is a structural impossibility
    // rather than a fallback.
    let recovery_wrap_key = session
        .recovery_wrap_key
        .as_ref()
        .ok_or(AppError::Protocol(
            protocol::ProtocolError::InvalidVaultMeta,
        ))?;
    let aad_rec = protocol::aad_recovery_wrap_v0_2(&session.kdf_params);
    let (nonce_recovery_wrap, enc_root_key_recovery) =
        seal_32_byte_secret(recovery_wrap_key, &session.root_key, &aad_rec)?;

    // Derive itemsKey_wrap_key, generate the singleton itemsKey + its
    // UUIDv7 identifier, and wrap.
    let items_wrap_key = protocol::derive_subkey_versioned(
        BIRTH_GENERATION,
        &session.root_key,
        protocol::SubkeyRole::ItemsKeyWrap,
    );
    let items_key = protocol::generate_root_key()?;
    let items_uuid = Uuid::now_v7();
    let items_key_id: [u8; VAULT_META_ITEMS_KEY_ID_LEN] = *items_uuid.as_bytes();
    let aad_items = protocol::aad_vault_items_key_wrap_v0_2(&items_key_id);
    let (items_key_nonce, enc_items_key) =
        seal_32_byte_secret(&items_wrap_key, &items_key, &aad_items)?;

    // The wrapped-itemsKey blob length matches the wrapped-root-key
    // blob length (both are 32-byte secrets sealed under the same
    // CTX-commitment AEAD shape). Compile-time guard:
    const _: () = assert!(VAULT_META_WRAPPED_ITEMS_KEY_LEN == VAULT_META_WRAPPED_ROOT_KEY_LEN);

    Ok(protocol::VaultMeta {
        // Byte-identical to what it was before the person account existed: a
        // legacy session's binding IS `account.hash`. A person-born session
        // never reaches here (its namespace id is written by
        // `build_person_vault_meta`).
        account_number_hash: session.vault_binding,
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
        membership,
        // The person binding is stamped by a later step once the vault is
        // bound to an identity (myne-md/myne#768); a vault created without one
        // omits the field, which is the absent-tolerant case the parser
        // accepts.
        person_binding: None,
    })
}

/// [`vault_artifacts_present`] over the IO seam (`decisions.md` 2026-08-15).
///
/// Same taxonomy, same answer, asked through [`crate::vault_io::VaultIo`] so a
/// browser can ask it of OPFS. The native version reaches `Path::is_file` and
/// `std::fs::read_dir` directly, both of which compile for
/// `wasm32-unknown-unknown` and fail at runtime, and failing here is the
/// dangerous direction: this guard is what stops a fresh creation landing on top
/// of an existing vault, destroying that vault's `root_key` wraps and orphaning
/// every `.myn` blob sealed under them.
///
/// Kept as a separate function rather than a generic over both worlds: the
/// native one is synchronous and is called from inside `run_blocking`, and
/// making it async would move that whole path onto the executor for no gain.
pub async fn vault_artifacts_present_io(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
) -> std::io::Result<bool> {
    let io_err = |_| std::io::Error::other("vault-io probe failed");
    if !io.exists(vault_dir).await.map_err(io_err)? {
        return Ok(false);
    }
    // Same recognized-artefact list as the native sibling, in the same order.
    // A file here is any of: the meta, its mid-write tempfile, a staged
    // newer-generation meta, the prefs blob and its tempfile, the attachments
    // catalog and its tempfile.
    for name in [
        "vault.meta",
        "vault.meta.tmp",
        crate::plugins::vault_migrate::adopt::INCOMING_META_FILE,
        "vault.prefs",
        "vault.prefs.tmp",
        "vault.attachments",
        "vault.attachments.tmp",
    ] {
        if io.exists(&vault_dir.join(name)).await.map_err(io_err)? {
            return Ok(true);
        }
    }
    // Orphan blobs: `notes/*.myn`, ANY regular file under `attachments/`
    // (content-addressed hex names carry no extension), `snapshots/*.myn`.
    for (dir, ext) in [
        ("notes", Some("myn")),
        ("attachments", None),
        ("snapshots", Some("myn")),
    ] {
        let path = vault_dir.join(dir);
        if !io.is_dir(&path).await.map_err(io_err)? {
            continue;
        }
        for entry in io.read_dir(&path).await.map_err(io_err)? {
            match ext {
                // `DirEntry` carries a NAME, not a path: OPFS has no path type
                // to hand back. Matching the extension off the name is the same
                // predicate the native sibling applies to `entry.path()`.
                Some(want) => {
                    if Path::new(&entry.name)
                        .extension()
                        .is_some_and(|e| e == want)
                    {
                        return Ok(true);
                    }
                }
                None => {
                    if !entry.is_dir {
                        return Ok(true);
                    }
                }
            }
        }
    }
    Ok(false)
}

/// [`commit_with_vault_path`] over the IO seam (`decisions.md` 2026-08-15).
///
/// Identical sequence and identical posture, with two mechanical differences and
/// no behavioural one:
///
/// * every write goes through [`crate::vault_io::VaultIo::write`] with
///   [`crate::vault_io::WriteOpts::create_new`], which is the seam's spelling of
///   the native `atomic_write(.., replace = false)`, so "creating a vault never
///   overwrites an existing `vault.meta`" holds on both;
/// * the AEAD work is not wrapped in `run_blocking`, because the seam's writes
///   are already async and the wasm arm has one thread anyway.
///
/// The eager-write posture is preserved deliberately, including its asymmetry:
/// a failed `vault.meta` write is the error, while a failed `vault.prefs` or
/// `vault.attachments` write is a warning, because both have an absence-fallback
/// in the spec (§ 9.5.5, § 9.10.4) and rolling back a written meta would cost
/// the user the whole Argon2id pipeline on a transient hiccup.
pub async fn commit_with_vault_path_io(
    token: Uuid,
    vault_path: PathBuf,
    state: &VaultCreationState,
    io: &dyn crate::vault_io::VaultIo,
    membership: Option<protocol::Membership>,
) -> Result<(), AppError> {
    let session = match state.take(token) {
        SessionLookup::Found(session) => *session,
        SessionLookup::Expired => return Err(AppError::SessionExpired),
        SessionLookup::NotFound => return Err(AppError::SessionNotFound),
    };

    let vault_dir = vault_path
        .parent()
        .expect("vault.meta path resolution always yields a parent directory")
        .to_path_buf();
    match vault_artifacts_present_io(io, &vault_dir).await {
        Ok(true) => {
            tracing::error!(
                stage = "commit_artifacts_check",
                error_kind = "VaultArtifactsPresent",
                "commit attempted on path with existing vault artefacts — frontend routing bypass or unclean partial-delete"
            );
            // Non-destructive: the session goes back so a retry is possible.
            let _ = state.try_insert(token, session);
            return Err(AppError::VaultArtifactsPresent);
        }
        Ok(false) => {}
        Err(e) => {
            let _ = state.try_insert(token, session);
            return Err(AppError::from(e));
        }
    }

    let (bytes, group_key) = match serialize_meta(&session, &membership) {
        Ok(serialized) => serialized,
        Err(e) => {
            let _ = state.try_insert(token, session);
            return Err(e);
        }
    };
    // Same tier rule as the native commit path: an `NTV7` vault's shared
    // singletons follow its roster and are sealed under the GROUP key.
    let group_key = group_key.as_ref().map(|g| protocol::GroupKey::new(**g));
    if let Err(e) = io
        .write(
            &vault_path,
            &bytes,
            crate::vault_io::WriteOpts::create_new(),
        )
        .await
    {
        let _ = state.try_insert(token, session);
        return Err(AppError::from(std::io::Error::other(format!(
            "vault.meta write failed: {e:?}"
        ))));
    }

    // From here the vault EXISTS. Both remaining writes are eager-write
    // invariants with a spec'd absence-fallback, so a failure warns and the
    // vault stays usable; the session is NOT restored, because restoring it
    // would invite a retry that the artefacts guard would now refuse.
    let prefs_key = match group_key {
        Some(ref group) => protocol::derive_group_subkey_v0_2(group, protocol::GroupRole::PrefsKey),
        None => protocol::derive_subkey_versioned(
            BIRTH_GENERATION,
            &session.root_key,
            protocol::SubkeyRole::PrefsKey,
        ),
    };
    match protocol::encode_prefs_blob_versioned(
        BIRTH_GENERATION,
        &prefs_key,
        &session.vault_binding,
        &protocol::PrefsView::default(),
    ) {
        Ok(prefs_bytes) => {
            match io
                .write(
                    &vault_dir.join("vault.prefs"),
                    &prefs_bytes,
                    crate::vault_io::WriteOpts::create_new(),
                )
                .await
            {
                Ok(()) => tracing::info!(
                    event = "vault_prefs_eager_written",
                    "vault.prefs eager-write succeeded with PrefsView::default()"
                ),
                Err(e) => tracing::warn!(
                    event = "vault_prefs_eager_write_failed",
                    seam_error = ?e,
                    "vault.meta written but vault.prefs eager-write failed; vault remains usable via spec § 9.5.5 absence-fallback",
                ),
            }
        }
        Err(_e) => tracing::warn!(
            event = "vault_prefs_eager_encode_failed",
            "vault.prefs encode failed during eager-write; vault remains usable via spec § 9.5.5 absence-fallback",
        ),
    }

    let catalog_key = match group_key {
        Some(ref group) => {
            protocol::derive_group_subkey_v0_2(group, protocol::GroupRole::AttachmentsCatalogKey)
        }
        None => protocol::derive_subkey_versioned(
            BIRTH_GENERATION,
            &session.root_key,
            protocol::SubkeyRole::AttachmentsCatalogKey,
        ),
    };
    match protocol::encode_attachments_catalog_versioned(
        BIRTH_GENERATION,
        &catalog_key,
        &session.vault_binding,
        &protocol::AttachmentsCatalog::empty(),
    ) {
        Ok(catalog_bytes) => {
            match io
                .write(
                    &vault_dir.join("vault.attachments"),
                    &catalog_bytes,
                    crate::vault_io::WriteOpts::create_new(),
                )
                .await
            {
                Ok(()) => tracing::info!(
                    event = "vault_attachments_eager_written",
                    "vault.attachments eager-write succeeded with empty catalog"
                ),
                Err(e) => tracing::warn!(
                    event = "vault_attachments_eager_write_failed",
                    seam_error = ?e,
                    "vault.meta written but vault.attachments eager-write failed; vault remains usable via spec § 9.10.4 absence-fallback",
                ),
            }
        }
        Err(_e) => tracing::warn!(
            event = "vault_attachments_eager_encode_failed",
            "vault.attachments encode failed during eager-write; vault remains usable via spec § 9.10.4 absence-fallback",
        ),
    }

    Ok(())
}

/// [`commit_from_host`] over the IO seam (`decisions.md` 2026-08-15).
///
/// The resolution precedence is the native one, minus the sole-vault fallback
/// that has no meaning here: a browser holds one container per origin, and its
/// id is a constant the caller passes explicitly. The directory is ensured
/// through [`crate::paths::vault_dir_for_id_from_host_io`], which is the seam's
/// `create_dir_all` (OPFS creates directories by acquiring handles, not by a
/// path call).
///
/// Deliberately NOT permit-gated. The native sibling takes the capacity-1
/// `auth_permits` lease that serialises every `vault.meta`-lifecycle command
/// against `vault_repair`; on this client `vault-repair` is a decided absence
/// and the wasm instance is single-threaded, so the lease would guard a race
/// that cannot occur. The concurrency bound that DOES apply is unchanged:
/// `MAX_CONCURRENT_SESSIONS`, enforced at `begin` by the slot reservation.
#[cfg_attr(target_arch = "wasm32", allow(unused_variables))]
pub async fn commit_from_host_io(
    vault_id: Option<String>,
    session_token: String,
    state: &VaultCreationState,
    host: &dyn HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    keychain: &dyn crate::vault_label::key::LabelKeychain,
) -> Result<Option<String>, AppError> {
    let token = Uuid::parse_str(&session_token).map_err(|_| AppError::SessionNotFound)?;
    let target = crate::vault_id::VaultId::parse_optional(vault_id.as_deref())
        .or_else(|| state.peek_vault_id(token));
    let vault_dir = crate::paths::vault_dir_for_id_from_host_io(host, io, target).await?;
    let vault_path = vault_dir.join("vault.meta");
    // wasm32 skips the eager seal like the native path does (see above): no
    // `std::fs` behind the seam, one vault per browser profile, no grouping
    // surface. The lazy stamp heals the field on first unlock.
    #[cfg(not(target_arch = "wasm32"))]
    let membership = match (state.peek_seal_inputs(token), target) {
        (Some((root_key, hash)), Some(new_vault_id)) => {
            eager_membership(host, io, keychain, new_vault_id, &root_key, &hash).await
        }
        _ => None,
    };
    #[cfg(target_arch = "wasm32")]
    let membership = None;
    // The browser has no member surface and therefore no binding store
    // (myne-md/myne#911 task 13 decided that absence), so there is no claim here.
    commit_with_vault_path_io(token, vault_path, state, io, membership).await?;
    Ok(target.map(|id| id.to_string()))
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

    /// Fast Argon2id parameters for tests, pinned to the
    /// `validate_kdf_params` memory floor so a vault created here still
    /// passes the unlock-path range gate. DEFAULT would add ~1–2 s per call.
    const FAST_TEST_KDF: KdfParams = KdfParams {
        m_kib: protocol::MIN_KDF_M_KIB,
        t: 1,
        p: 1,
        argon2_version: 0x13,
    };

    /// A deterministic person fixture: the phrase is the only input, because
    /// the identity keypair is derived from it (`decisions/protocol/0604`).
    fn person_fixture(phrase: &str) -> CreationPerson {
        let person_id = protocol::kdf::person_id_hash(phrase);
        let seed = protocol::kdf::derive_person_identity_seed(phrase, &person_id, &FAST_TEST_KDF)
            .expect("identity seed");
        let seeds = protocol::kdf::expand_person_identity_key_seeds(&seed);
        CreationPerson {
            pair: protocol::PersonKeyPair::generate_raw(&seeds.kem, &seeds.ed25519, &seeds.mldsa),
            person_id,
            number: protocol::account_number_from_person_id(&person_id),
        }
    }

    const PERSON_PHRASE: &str = "abandon ability able about above absent absorb abstract          absurd abuse access accident account accuse achieve acid acoustic acquire across act          action actor actress actual";

    #[test]
    fn person_session_carries_no_phrase_and_a_random_vault_binding() {
        let person = person_fixture(PERSON_PHRASE);
        let expected_number = person.number.clone();
        let a = build_person_session(VaultId::mint(), "person-born-pw", FAST_TEST_KDF, person)
            .expect("person session");
        assert!(a.phrase.is_none(), "the vault phrase is retired here");
        assert!(
            a.recovery_wrap_key.is_none(),
            "no key is derived for a wrap that does not exist"
        );
        assert_eq!(a.salt_recovery, [0u8; ARGON2_SALT_LEN]);
        assert_eq!(a.account.canonical, expected_number.canonical);
        // The binding is random and is NOT the person's number hash, which is
        // what keeps the number out of vault cryptography.
        assert_ne!(a.vault_binding, a.account.hash);
        assert_ne!(a.vault_binding, [0u8; 16]);

        let person = person_fixture(PERSON_PHRASE);
        let b = build_person_session(VaultId::mint(), "person-born-pw", FAST_TEST_KDF, person)
            .expect("second person session");
        assert_ne!(
            a.vault_binding, b.vault_binding,
            "two vaults of one person must not share a salt binding"
        );
    }

    #[test]
    fn person_born_meta_is_ntv8_with_a_zeroed_phrase_wrap() {
        let person = person_fixture(PERSON_PHRASE);
        let session =
            build_person_session(VaultId::mint(), "person-born-pw", FAST_TEST_KDF, person)
                .expect("person session");
        let (bytes, _group) =
            build_and_serialize_person_vault_meta(&session).expect("serialize NTV8");
        assert_eq!(&bytes[..4], &protocol::VAULT_META_NTV8_MAGIC);
        assert_eq!(
            protocol::vault_meta_generation(&bytes),
            protocol::VaultMetaGeneration::PersonNoWrap
        );
        let parsed = protocol::parse_vault_meta_ntv8(&bytes).expect("parse NTV8");
        // The three fields the retired phrase wrap owned, all zero.
        assert_eq!(parsed.base.random_salt_recovery, [0u8; ARGON2_SALT_LEN]);
        assert_eq!(parsed.base.nonce_recovery_wrap, [0u8; AEAD_NONCE_LEN]);
        assert_eq!(
            parsed.base.enc_root_key_recovery,
            [0u8; VAULT_META_WRAPPED_ROOT_KEY_LEN]
        );
        // The binding is what §9.3 offset 6 carries, so the frame needs no new
        // field and the salts bind the same value.
        assert_eq!(parsed.base.account_number_hash, session.vault_binding);
        assert_eq!(parsed.group_key_epoch, 1);

        // The structural proof that no person wrap exists: the frame is exactly
        // the fixed prefix plus the roster, and there is no block after it that a
        // later writer could fill in. A length is not a convention a writer can
        // relax the way it could relax a zero-filled field, which is why
        // `decisions/protocol/0758` chose truncation over zeroing.
        assert_eq!(
            bytes.len(),
            protocol::NTV8_FIXED_LEN + parsed.signed_roster_envelope.len(),
            "NTV8 is the fixed prefix plus the roster, and nothing else"
        );
        // And the two generations differ by exactly that block, which is what
        // makes the `NTV7` to `NTV8` upgrade a truncation rather than a re-wrap.
        assert_eq!(
            protocol::NTV7_FIXED_LEN,
            protocol::NTV8_FIXED_LEN + protocol::PERSON_WRAP_LEN,
            "the generations differ by exactly the person wrap"
        );
    }

    #[test]
    fn committing_a_person_born_vault_seals_its_singletons_under_the_group_tier() {
        // Two claims in one end-to-end run, because they are one chain: the
        // PASSWORD opens the `root_key`, that `root_key` unwraps the group key,
        // and the group key is what the eagerly written `vault.prefs` is sealed
        // under.
        //
        // The tier is load-bearing. Sealed under the ROOT tier instead, the
        // first unlock would fail to open `vault.prefs` and fall back to
        // defaults, which reaches the user as "all my settings were reset" with
        // no error anywhere.
        rt().block_on(async {
            let scratch = ScratchVault::new();
            let person = person_fixture(PERSON_PHRASE);
            let owner_pair = person.pair.clone();
            let session =
                build_person_session(VaultId::mint(), "person-born-pw", FAST_TEST_KDF, person)
                    .expect("person session");
            let session_root_key = *session.root_key;
            let state = VaultCreationState::default();
            let token = Uuid::new_v4();
            state
                .try_insert(token, session)
                .expect("scratch state has room");

            let claim_inputs = commit_with_vault_path(
                token,
                scratch.path().to_path_buf(),
                &state,
                None,
            )
            .await
            .expect("commit person-born vault")
            .expect(
                "a person-born birth must hand the device-binding claim its group key and the \
                 person who signs the row (myne-md/myne#1001)",
            );

            let vault_dir = scratch.path().parent().expect("vault dir");
            let meta = std::fs::read(scratch.path()).expect("vault.meta");
            assert_eq!(&meta[..4], &protocol::VAULT_META_NTV8_MAGIC);
            let parsed = protocol::parse_vault_meta_ntv8(&meta).expect("parse NTV8");

            // The inversion this generation exists for. On `NTV7` the owner's
            // own keypair opened the person wrap and reached `root_key` without
            // the password; here there is no person wrap to hand an opener, and
            // the frame's length is the proof rather than a convention: an
            // `NTV7` frame with this same tail would be exactly
            // `PERSON_WRAP_LEN` bytes longer, and those bytes are the ones that
            // used to open under the identity. The runtime half of the same
            // claim (a phrase presented to this file refuses) is
            // `vault_unlock::commands::tests::the_identity_phrase_does_not_open_a_password_only_vault`.
            assert_eq!(
                meta.len() + protocol::PERSON_WRAP_LEN,
                protocol::NTV7_FIXED_LEN + parsed.signed_roster_envelope.len(),
                "the bytes the owner's keypair used to open are not in this frame"
            );

            // `root_key` is reachable through the password and through nothing
            // else, which is what makes the password the only vault credential.
            let root_key = protocol::unlock_root_key_v0_2_password(
                &parsed.base,
                "person-born-pw",
                &parsed.base.account_number_hash,
            )
            .expect("the password opens the root key");
            assert_eq!(*root_key, session_root_key);

            // A second, weaker control: the identity keypair still exists and is
            // still what signs the roster, so "no person wrap" is not "no
            // person". A fixture that lost the pair would pass every assertion
            // above for the wrong reason.
            assert_ne!(*owner_pair.public_half().fingerprint(), [0u8; 32]);

            let owner_key = protocol::OwnerKey::new(*root_key);
            let group_bytes = protocol::unlock_group_key_ntv6(&parsed.as_ntv6_tail(), &owner_key)
                .expect("the owner subkey unwraps the group key");
            let group_key = protocol::GroupKey::new(*group_bytes);

            // The claim is handed the key the vault was BORN with, not a re-derivation
            // of it: a mismatch here would write the binding row under a keyspace no
            // later reader can open, and every reader collapses that to the empty map.
            assert_eq!(
                *claim_inputs.group_key, *group_bytes,
                "the claim's group key is the vault's own group key"
            );
            assert_eq!(
                claim_inputs.person.pair.public_half().fingerprint(),
                owner_pair.public_half().fingerprint(),
                "the row is signed by the person who signed this vault's roster"
            );

            let prefs = std::fs::read(vault_dir.join("vault.prefs")).expect("vault.prefs");
            let prefs_key =
                protocol::derive_group_subkey_v0_2(&group_key, protocol::GroupRole::PrefsKey);
            protocol::decode_prefs_blob_versioned(
                BIRTH_GENERATION,
                &prefs_key,
                &parsed.base.account_number_hash,
                &prefs,
            )
            .expect("vault.prefs opens under the GROUP tier");

            // The root tier must NOT open it: that is the defect this asserts
            // against, and the reason the tier is derived from the session
            // rather than hardcoded.
            let root_prefs_key = protocol::derive_subkey_versioned(
                BIRTH_GENERATION,
                &root_key,
                protocol::SubkeyRole::PrefsKey,
            );
            assert!(
                protocol::decode_prefs_blob_versioned(
                    BIRTH_GENERATION,
                    &root_prefs_key,
                    &parsed.base.account_number_hash,
                    &prefs,
                )
                .is_err(),
                "vault.prefs must not be readable through a root-tier key"
            );

            // The catalog follows the same rule.
            let catalog =
                std::fs::read(vault_dir.join("vault.attachments")).expect("vault.attachments");
            let catalog_key = protocol::derive_group_subkey_v0_2(
                &group_key,
                protocol::GroupRole::AttachmentsCatalogKey,
            );
            protocol::decode_attachments_catalog_versioned(
                BIRTH_GENERATION,
                &catalog_key,
                &parsed.base.account_number_hash,
                &catalog,
            )
            .expect("vault.attachments opens under the GROUP tier");
        });
    }

    /// The creation-time claim, END TO END (myne-md/myne#1001): after `commit_from_host`
    /// returns, a person-born vault already carries this device's binding row.
    ///
    /// This is the assertion the issue is about, and the one that cannot be made later: the
    /// ceremony is the last moment the owner's person key is in hand, because an
    /// `NTV7`/`NTV8` vault's unlock can never install a person session
    /// (`person_vault_carrier::carrier_applies` excludes those generations; `0774`, DO NOT
    /// ROUTE). Without this row the vault's first lock answered "unlock your identity to
    /// sync" and the phrase bought exactly one session.
    ///
    /// The row is opened through the vault's OWN group key, recovered from the password, so
    /// the claim cannot pass by writing the map under a keyspace no reader shares.
    #[test]
    fn commit_writes_the_device_binding_row_for_a_person_born_vault() {
        // The device-key slot is process-global, so this test serializes against the
        // device-key suite that installs and clears it.
        let _serialized = crate::test_support::device_key_slot_guard();
        rt().block_on(async {
            let base = crate::test_support::ScopedTempDir::new("commit-claim").expect("tempdir");
            let host = crate::host::test_host::TestHost::new(base.path());
            let io = crate::vault_io::StdVaultIo;
            let state = VaultCreationState::default();

            // The person credential is the ONLY record that names this device on a
            // person-born vault: it has no vault SCRAM account, so nothing ever wrote a
            // `device_id_hex` into the vault's own sync state.
            let person = person_fixture(PERSON_PHRASE);
            let device_id = [0x5Au8; 16];
            let owner_fingerprint = {
                let half = person.pair.public_half();
                *half.fingerprint()
            };
            // A fixture that lost its pair would satisfy the row assertions below for the
            // wrong reason.
            assert_ne!(owner_fingerprint, [0u8; 32]);
            let auth_path = crate::plugins::sync::person_auth::person_auth_path(&host, &io)
                .await
                .expect("person-auth path");
            crate::plugins::sync::person_auth::write_person_auth(
                &io,
                &auth_path,
                &crate::plugins::sync::person_auth::PersonAuth {
                    person_id_hex: crate::account::person_identity::hex_lower(&person.person_id),
                    device_id_hex: crate::account::person_identity::hex_lower(&device_id),
                    ..Default::default()
                },
            )
            .await
            .expect("seed person-auth");

            let vault_id = VaultId::mint();
            let session =
                build_person_session(vault_id, "creation-claim-pw", FAST_TEST_KDF, person)
                    .expect("person session");
            let token = Uuid::new_v4();
            state
                .try_insert(token, session)
                .expect("scratch state has room");

            // NO key store is installed, and that is the fixture (myne-md/myne#1027). This
            // test used to call `install_session_key` with the comment "a key at rest", which
            // is the bug written down as the setup: the claim's read-back consults the store
            // only now, so a session key proves nothing. The store itself is process-global and
            // a test binary cannot control it, so this test asserts the one thing that holds
            // either way — a row exists — and leaves the halves rule to the tests that own it.
            commit_from_host(
                None,
                token.to_string(),
                &state,
                &VaultRuntimeState::default(),
                &host,
                &crate::vault_label::fake_keychain::FakeKeychain::empty(),
            )
            .await
            .expect("commit person-born vault");

            let vault_dir =
                crate::paths::vault_dir_for_id_from_host(&host, Some(vault_id)).expect("vault dir");
            let meta = std::fs::read(vault_dir.join("vault.meta")).expect("vault.meta");
            assert_eq!(&meta[..4], &protocol::VAULT_META_NTV8_MAGIC);
            let parsed = protocol::parse_vault_meta_ntv8(&meta).expect("parse NTV8");
            let root_key = protocol::unlock_root_key_v0_2_password(
                &parsed.base,
                "creation-claim-pw",
                &parsed.base.account_number_hash,
            )
            .expect("the password opens the root key");
            let group_bytes = protocol::unlock_group_key_ntv6(
                &parsed.as_ntv6_tail(),
                &protocol::OwnerKey::new(*root_key),
            )
            .expect("the owner subkey unwraps the group key");
            let resolved = crate::plugins::device_binding::sync::resolve_bindings_from_group_key(
                &io,
                &group_bytes,
                &vault_dir,
            )
            .await
            .expect("the group key opens the binding keyspace");
            let map = crate::plugins::device_binding::store::read_device_bindings_in_dir(
                &io,
                &vault_dir,
                &resolved.borrow(),
            )
            .await
            .expect("read the binding store");

            let row = map
                .get(&crate::account::person_identity::hex_lower(&device_id))
                .expect(
                    "a vault created under an identity must already carry this device's \
                     binding row when commit returns (myne-md/myne#1001)",
                );
            assert!(!row.tombstone, "a fresh claim is a live row");
            // NO assertion about halves here, and that is the fix (myne-md/myne#1027). Whether
            // they are present depends on a store this test binary cannot control, which is why
            // the old fixture installed a SESSION key and called it "a key at rest" — the bug
            // written down as the setup. `a_row_publishes_only_halves_the_store_returns` owns
            // that rule, and `the_at_rest_read_ignores_a_session_key` owns the reader.
            // What this test owns is #1001: the ceremony leaves a row behind at all.
            assert_eq!(
                row.person_fingerprint,
                crate::account::person_identity::hex_lower(&owner_fingerprint),
                "the row names the person who signed this vault's roster"
            );
        });
    }

    /// The gate the creation claim cannot cross, asserted rather than assumed
    /// (myne-md/myne#1001): a RESERVED identity carries no device id, and a binding row is
    /// keyed by one.
    ///
    /// `person_create_identity_from_host` writes `device_id_hex` empty because the server
    /// issues it at enrolment, so a vault created before this device has ever registered is
    /// committed unbound. The claim stands down on `NoDeviceId` rather than inventing an id:
    /// an id drawn at claim time would bind a device the sync plane has never heard of
    /// (`device_actor::durable_device_id` states that rule).
    ///
    /// The id arrives at person registration, and `person_register_from_host` claims there,
    /// so this state is a delay rather than a hole.
    #[test]
    fn a_vault_created_before_this_device_has_an_id_is_committed_unbound() {
        rt().block_on(async {
            let base =
                crate::test_support::ScopedTempDir::new("commit-no-device-id").expect("tempdir");
            let host = crate::host::test_host::TestHost::new(base.path());
            let io = crate::vault_io::StdVaultIo;
            let state = VaultCreationState::default();

            let person = person_fixture(PERSON_PHRASE);
            let auth_path = crate::plugins::sync::person_auth::person_auth_path(&host, &io)
                .await
                .expect("person-auth path");
            crate::plugins::sync::person_auth::write_person_auth(
                &io,
                &auth_path,
                &crate::plugins::sync::person_auth::PersonAuth {
                    person_id_hex: crate::account::person_identity::hex_lower(&person.person_id),
                    // A reserved identity: the device id is issued at enrolment.
                    device_id_hex: String::new(),
                    ..Default::default()
                },
            )
            .await
            .expect("seed person-auth");

            let vault_id = VaultId::mint();
            let session = build_person_session(vault_id, "no-device-id-pw", FAST_TEST_KDF, person)
                .expect("person session");
            let token = Uuid::new_v4();
            state
                .try_insert(token, session)
                .expect("scratch state has room");

            commit_from_host(
                None,
                token.to_string(),
                &state,
                &VaultRuntimeState::default(),
                &host,
                &crate::vault_label::fake_keychain::FakeKeychain::empty(),
            )
            .await
            .expect("commit person-born vault");

            let vault_dir =
                crate::paths::vault_dir_for_id_from_host(&host, Some(vault_id)).expect("vault dir");
            assert!(
                !vault_dir.join("vault.device-bindings").exists(),
                "a device with no durable id must leave no binding row, rather than key one \
                 by an id it invented"
            );
        });
    }

    /// The other half of the creation claim: a legacy `NTV5` birth hands NOTHING
    /// (myne-md/myne#1001).
    ///
    /// A single-user vault carries no binding store and no group tier, so a claim attempt
    /// there would target a family the vault does not have. `0774`'s rejected alternative
    /// states the same rule from the product side: a `NTV5` vault "has no binding at all and
    /// never will", which is why creation records an outcome rather than blocking on one.
    #[test]
    fn a_legacy_birth_hands_the_claim_nothing() {
        rt().block_on(async {
            let scratch = ScratchVault::new();
            let state = VaultCreationState::default();
            let token = seed_session_into_state(&state);

            let claim_inputs =
                commit_with_vault_path(token, scratch.path().to_path_buf(), &state, None)
                    .await
                    .expect("commit legacy vault");

            assert!(
                claim_inputs.is_none(),
                "an NTV5 birth must not attempt a device-binding claim"
            );
            assert_eq!(
                &std::fs::read(scratch.path()).expect("vault.meta")[..4],
                &protocol::VAULT_META_V0_2_MAGIC
            );
        });
    }

    #[test]
    fn a_legacy_session_still_emits_ntv5_and_keeps_its_phrase() {
        // Acceptance 4 of task 5: a vault created before this change is
        // untouched. The legacy birth is asserted by MAGIC, not by "it did not
        // crash", because a silent flip to the new generation here would take
        // the vault phrase away from every client that has not yet shipped an
        // identity-first first run.
        let session =
            build_session(VaultId::mint(), "legacy-pw", FAST_TEST_KDF).expect("legacy session");
        assert!(session.phrase.is_some());
        assert!(session.recovery_wrap_key.is_some());
        assert_eq!(session.vault_binding, session.account.hash);
        let bytes = build_and_serialize_vault_meta(&session).expect("serialize NTV5");
        assert_eq!(&bytes[..4], &protocol::VAULT_META_V0_2_MAGIC);
    }

    #[test]
    fn build_session_populates_every_field() {
        let session = build_session(
            VaultId::mint(),
            "correct horse battery staple",
            FAST_TEST_KDF,
        )
        .expect("fast params");

        assert!(session.account.display.starts_with("MY-"));
        assert_eq!(session.account.canonical.len(), 20);
        assert_eq!(session.account.hash.len(), 16);
        assert_eq!(session.phrase.as_ref().expect("phrase").words().len(), 24);
        assert_eq!(session.root_key.len(), AEAD_KEY_LEN);
        assert_ne!(*session.root_key, [0u8; AEAD_KEY_LEN]);
        assert_ne!(*session.password_wrap_key, [0u8; AEAD_KEY_LEN]);
        assert_ne!(
            **session.recovery_wrap_key.as_ref().expect("recovery wrap"),
            [0u8; AEAD_KEY_LEN]
        );
        assert_ne!(session.salt_password, session.salt_recovery);
        assert_eq!(session.kdf_params, FAST_TEST_KDF);
    }

    #[test]
    fn build_session_stores_the_passed_vault_id() {
        // SYNC-6: the id `build_session` is handed (minted by `begin` in
        // production) is stored verbatim on the session — `commit` resolves
        // the write destination to `vaults/<vault_id>/` from it.
        let id = VaultId::mint();
        let session = build_session(id, "any password", FAST_TEST_KDF).unwrap();
        assert_eq!(
            session.vault_id, id,
            "session must carry the minted VaultId"
        );
    }

    #[test]
    fn build_session_password_and_recovery_wrap_keys_differ() {
        let session = build_session(VaultId::mint(), "any password", FAST_TEST_KDF).unwrap();
        assert_ne!(
            *session.password_wrap_key,
            **session.recovery_wrap_key.as_ref().expect("recovery wrap")
        );
    }

    #[test]
    fn build_session_is_non_deterministic() {
        let a = build_session(VaultId::mint(), "same password", FAST_TEST_KDF).unwrap();
        let b = build_session(VaultId::mint(), "same password", FAST_TEST_KDF).unwrap();
        assert_ne!(a.account.canonical, b.account.canonical);
        assert_ne!(
            a.phrase.as_ref().expect("phrase").words(),
            b.phrase.as_ref().expect("phrase").words()
        );
        assert_ne!(*a.root_key, *b.root_key);
        assert_ne!(a.salt_password, b.salt_password);
    }

    #[test]
    fn begin_result_serializes_with_expected_field_names() {
        let result = BeginResult {
            phrase: Some(core::array::from_fn(|i| format!("w{i}"))),
            account_number: "MY-XXXX-XXXX-XXXX-XXXX-XXXX".to_string(),
            // secret-scan:allow — test stub, not a credential
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
        let session = build_session(VaultId::mint(), "any password", FAST_TEST_KDF).unwrap();
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
        let session =
            build_session(VaultId::mint(), "commit-test-pw", FAST_TEST_KDF).expect("build_session");
        state
            .try_insert(token, session)
            .expect("scratch state has room");
        token
    }

    /// A `commit` result rendered for an assertion message.
    ///
    /// [`CreationClaimInputs`] deliberately has no `Debug`, because it carries the owner's
    /// person keypair and a secret must never reach a `{:?}`: that also means a `Result`
    /// carrying one cannot be printed whole, which is why the Ok side is described in words
    /// here and the error side is printed.
    fn commit_outcome(result: &Result<Option<CreationClaimInputs>, AppError>) -> String {
        match result {
            Ok(Some(_)) => "Ok(person-born claim inputs)".to_string(),
            Ok(None) => "Ok(legacy birth, no claim)".to_string(),
            Err(error) => format!("{error:?}"),
        }
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
                commit_with_vault_path(token, scratch.path().to_path_buf(), &state, None).await;

            let shown = commit_outcome(&result);
            assert!(
                matches!(result, Err(AppError::VaultArtifactsPresent)),
                "commit must reject when vault.meta exists, got {shown}"
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
                commit_with_vault_path(token, scratch.path().to_path_buf(), &state, None).await;
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

            let result =
                commit_with_vault_path(token, scratch.path().to_path_buf(), &state, None).await;

            // Either Ok (full happy path completed) or some non-
            // VaultArtifactsPresent error. The point is: guard did not
            // mis-fire on a clean directory.
            let shown = commit_outcome(&result);
            assert!(
                !matches!(result, Err(AppError::VaultArtifactsPresent)),
                "guard mis-fired on clean directory; got {shown}"
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
                commit_with_vault_path(unknown_token, scratch.path().to_path_buf(), &state, None)
                    .await;
            let shown = commit_outcome(&result);
            assert!(
                matches!(result, Err(AppError::SessionNotFound)),
                "expected SessionNotFound, got {shown}"
            );
        });
    }

    // ---- myne-md/myne#684: the eager membership path ----------------------

    /// `commit` seals the membership field when it resolved one: the committed
    /// blob is 417 bytes, parses, and opens under the v0.2 membership KEK to
    /// the sealed account id. This is the test that fails when the commit
    /// paths call the membership-None serializer (the helper with no caller).
    #[test]
    fn commit_with_membership_seals_the_field_eagerly() {
        rt().block_on(async {
            let scratch = ScratchVault::new();
            std::fs::create_dir_all(scratch.path()).expect("vault dir");
            let state = VaultCreationState::default();
            let session = build_session(VaultId::mint(), "any password", FAST_TEST_KDF).unwrap();
            let root_key = *session.root_key;
            let hash = session.account.hash;
            let account_id = [0xAB; 16];
            let membership = protocol::seal_membership_raw(
                &root_key,
                &account_id,
                &hash,
                &[0xCD; protocol::AEAD_NONCE_LEN],
            )
            .expect("seal");
            let token = Uuid::new_v4();
            state.try_insert(token, session).expect("insert");
            commit_with_vault_path(
                token,
                scratch.path().join("vault.meta"),
                &state,
                Some(membership),
            )
            .await
            .expect("commit");
            let bytes = std::fs::read(scratch.path().join("vault.meta")).expect("read");
            assert_eq!(
                bytes.len(),
                protocol::VAULT_META_V0_2_WITH_MEMBERSHIP_LEN,
                "eager commit must emit the 417-byte layout"
            );
            let meta = protocol::parse_vault_meta_any(&bytes).expect("parse");
            let sealed = meta.membership.expect("field present");
            let opened = protocol::unseal_membership(&root_key, &sealed, &hash).expect("unseal");
            assert_eq!(opened.as_slice(), account_id);
        });
    }

    /// The sealed field and the record agree: `commit_from_host` adopts the
    /// new vault into the record and seals the id THAT adoption returns, so no
    /// later reconcile can adopt it elsewhere while the stamp skips as
    /// already-present. Fails when the two halves derive from two writes.
    #[test]
    fn commit_from_host_seals_the_adopted_account() {
        use crate::host::test_host::TestHost;
        use crate::vault_label::fake_keychain::FakeKeychain;
        rt().block_on(async {
            let scratch =
                crate::test_support::ScopedTempDir::new("commit-eager-agree").expect("scratch");
            let host = TestHost::new(scratch.path());
            let keychain = FakeKeychain::empty();
            let creation = VaultCreationState::default();
            let runtime = VaultRuntimeState::default();
            let vault_id = VaultId::mint();
            let session = build_session(vault_id, "any password", FAST_TEST_KDF).expect("session");
            let root_key = *session.root_key;
            let hash = session.account.hash;
            // The vault directory must exist before commit writes into it, and
            // the config directory before the record adoption persists.
            std::fs::create_dir_all(
                scratch
                    .path()
                    .join("data")
                    .join("vaults")
                    .join(vault_id.to_string()),
            )
            .expect("vault dir");
            std::fs::create_dir_all(scratch.path().join("config")).expect("config dir");
            let token = Uuid::new_v4();
            creation.try_insert(token, session).expect("insert");

            let returned = commit_from_host(
                None,
                token.to_string(),
                &creation,
                &runtime,
                &host,
                &keychain,
            )
            .await
            .expect("commit");
            assert_eq!(returned, Some(vault_id.to_string()));

            let meta_path = scratch
                .path()
                .join("data")
                .join("vaults")
                .join(vault_id.to_string())
                .join("vault.meta");
            let bytes = std::fs::read(&meta_path).expect("meta written");
            let meta = protocol::parse_vault_meta_any(&bytes).expect("parse");
            let sealed = meta.membership.expect("eager field present");
            let sealed_id = protocol::unseal_membership(&root_key, &sealed, &hash).expect("unseal");

            let record = crate::account::store::load_account(
                &crate::vault_io::StdVaultIo,
                &scratch.path().join("config"),
                &scratch.path().join("data"),
                &keychain,
            )
            .await
            .expect("record loads");
            let owner = record
                .accounts
                .iter()
                .find(|a| a.vaults.contains(&vault_id))
                .expect("record adopted the new vault");
            assert_eq!(
                owner.account_id.as_slice(),
                sealed_id.as_slice(),
                "sealed field and record must name the same account"
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
                None,
            )
            .await;

            let shown = commit_outcome(&result);
            assert!(
                matches!(result, Err(AppError::VaultBusyAuth)),
                "expected VaultBusyAuth when permit held, got {shown}"
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
                None,
            )
            .await;
            let shown = commit_outcome(&result);
            assert!(
                matches!(result, Err(AppError::SessionNotFound)),
                "expected SessionNotFound terminal return, got {shown}"
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
    fn vault_artifacts_present_returns_true_when_snapshots_contains_myn_blob() {
        // MYND-96: an orphan snapshot blob gates a fresh create just like an
        // orphan note blob.
        let tmp = crate::test_support::ScopedTempDir::new("vap-snap").expect("scoped tempdir");
        let snapshots = tmp.path().join("snapshots");
        std::fs::create_dir_all(&snapshots).expect("mkdir snapshots/");
        std::fs::write(
            snapshots.join(
                "0193e8d3-1234-7890-abcd-ef0123456789__0193e8d4-5678-7000-8000-000000000000.myn",
            ),
            b"orphan snapshot bytes",
        )
        .expect("seed orphan snapshot .myn");
        assert!(
            vault_artifacts_present(tmp.path()).expect("scan ok"),
            "orphan snapshot .myn from partial-fail vault_delete is a recognized artefact"
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

    /// SYNC-9 / MYND-202 (sub-feature 5): per-vault-directory guard scoping
    /// under the multi-vault `vaults/<id>/` layout. A fully-populated SIBLING
    /// vault (`vaults/<other-id>/` carrying `vault.meta`, `vault.prefs`, a
    /// `notes/*.myn` blob, etc.) present *elsewhere* must NOT trip the guard
    /// when it is evaluated against a freshly-minted, empty `vaults/<new-id>/`.
    /// This is the load-bearing property that lets the create path (sub-feature
    /// 3) operate on a fresh dir while other vaults coexist: because
    /// `vault_artifacts_present` is a pure function of its `vault_dir` arg
    /// (no global `vault/`/`vaults/` resolution), the sibling's artefacts are
    /// invisible to a scan of the fresh dir.
    #[test]
    fn vault_artifacts_present_ignores_populated_sibling_vault() {
        let tmp = crate::test_support::ScopedTempDir::new("vap-sibling").expect("scoped tempdir");
        // Realistic multi-vault disk shape: `<base>/vaults/<id>/`.
        let vaults = tmp.path().join("vaults");

        // A fully-populated SIBLING vault under its own `vaults/<other-id>/`.
        let other_id = crate::vault_id::VaultId::mint();
        let sibling = vaults.join(other_id.to_string());
        std::fs::create_dir_all(sibling.join("notes")).expect("mkdir sibling notes/");
        std::fs::write(sibling.join("vault.meta"), b"sibling vault.meta bytes")
            .expect("seed sibling vault.meta");
        std::fs::write(sibling.join("vault.prefs"), b"sibling vault.prefs bytes")
            .expect("seed sibling vault.prefs");
        std::fs::write(
            sibling
                .join("notes")
                .join("0193e8d3-1234-7890-abcd-ef0123456789.myn"),
            b"sibling note blob",
        )
        .expect("seed sibling .myn");
        // Sanity: the sibling dir itself trips the guard (it is a real vault).
        assert!(
            vault_artifacts_present(&sibling).expect("scan sibling ok"),
            "a fully-populated vault dir must trip the guard when scanned directly"
        );

        // The FRESH, empty create target under a distinct `vaults/<new-id>/`.
        let new_id = crate::vault_id::VaultId::mint();
        let fresh = vaults.join(new_id.to_string());
        std::fs::create_dir_all(&fresh).expect("mkdir fresh vaults/<new-id>/");

        // The guard, evaluated against the fresh dir, must NOT see the
        // sibling's artefacts — per-vault-directory scoping (SYNC-9).
        assert!(
            !vault_artifacts_present(&fresh).expect("scan fresh ok"),
            "a populated sibling vaults/<other-id>/ must NOT trip the guard on a fresh empty vaults/<new-id>/"
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

            let result =
                commit_with_vault_path(token, scratch.path().to_path_buf(), &state, None).await;
            let shown = commit_outcome(&result);
            assert!(
                result.is_ok(),
                "commit happy-path must succeed; got {shown}"
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
            // MYND-169 closed invariant: vault.attachments is on disk too.
            assert!(
                scratch.dir.join("vault.attachments").exists(),
                "vault.attachments must exist after commit happy-path (MYND-169 eager-write)"
            );
        });
    }

    /// SYNC-6 create targeting (task 4): a commit aimed at a `vaults/<id>/`
    /// path (the shape `vault_dir_for_id(Some(id))` produces) writes the new
    /// `vault.meta` under exactly that directory — proving the inner
    /// `commit_with_vault_path` seam honors the threaded explicit-id path. The
    /// `commit` Tauri wrapper resolves `Some(id)` → this path; here we build it
    /// directly via the same `vault_root_for_id_from_base` resolver to avoid an
    /// `AppHandle` in the test.
    #[test]
    fn commit_targeting_an_explicit_vault_id_writes_under_that_vaults_child() {
        rt().block_on(async {
            let base = crate::test_support::ScopedTempDir::new("commit-target").unwrap();
            let id = crate::vault_id::VaultId::mint();
            // The explicit-id resolver's path (mirrors vault_dir_for_id(Some)).
            let vault_root = crate::paths::vault_root_for_id_from_base(base.path(), id);
            std::fs::create_dir_all(&vault_root).expect("create vaults/<id>/");
            let vault_path = vault_root.join("vault.meta");

            let state = VaultCreationState::default();
            let token = seed_session_into_state(&state);

            commit_with_vault_path(token, vault_path.clone(), &state, None)
                .await
                .expect("commit to the explicit vaults/<id>/ path must succeed");

            // vault.meta landed under exactly `vaults/<id>/`.
            assert!(
                vault_path.exists(),
                "vault.meta must be written under the targeted vaults/<id>/ directory"
            );
            // The targeted root names back to the explicit id (round-trip).
            assert_eq!(
                crate::paths::vault_id_from_root(&vault_root),
                id,
                "the targeted root must name back to the explicit VaultId"
            );
        });
    }

    /// SYNC-6 + SYNC-9 (this task — create the Nth vault): a `commit` aimed at
    /// a freshly-minted, empty `vaults/<new-id>/` SUCCEEDS even when a
    /// fully-populated SIBLING vault exists under another `vaults/<other-id>/`.
    /// This is the end-to-end create-flow property (the session-minted id of
    /// `begin` → `vaults/<id>/` write destination): the `VaultArtifactsPresent`
    /// guard is per-vault-dir, so a sibling's artefacts never gate creation of
    /// a distinct vault. Pairs with the pure-predicate
    /// `vault_artifacts_present_ignores_populated_sibling_vault` above — this one
    /// drives the actual write pipeline (guard → AEAD-wrap → atomic_write) to
    /// the fresh dir and asserts both that the new `vault.meta` lands AND that
    /// the sibling's `vault.meta` is left byte-for-byte untouched.
    #[test]
    fn commit_to_fresh_vaults_child_succeeds_with_populated_sibling_present() {
        rt().block_on(async {
            let base = crate::test_support::ScopedTempDir::new("commit-nth").unwrap();

            // A fully-populated SIBLING vault under `vaults/<other-id>/`.
            let other_id = crate::vault_id::VaultId::mint();
            let sibling_root = crate::paths::vault_root_for_id_from_base(base.path(), other_id);
            std::fs::create_dir_all(sibling_root.join("notes")).expect("mkdir sibling notes/");
            let sibling_meta = sibling_root.join("vault.meta");
            let sibling_meta_bytes = b"sibling vault.meta - MUST NOT be touched";
            std::fs::write(&sibling_meta, sibling_meta_bytes).expect("seed sibling vault.meta");
            std::fs::write(sibling_root.join("vault.prefs"), b"sibling prefs")
                .expect("seed sibling vault.prefs");
            std::fs::write(
                sibling_root
                    .join("notes")
                    .join("0193e8d3-1234-7890-abcd-ef0123456789.myn"),
                b"sibling note blob",
            )
            .expect("seed sibling .myn");

            // The fresh, empty create target under a DISTINCT `vaults/<new-id>/`
            // (the shape `vault_dir_for_id(Some(session.vault_id))` resolves to).
            let new_id = crate::vault_id::VaultId::mint();
            let fresh_root = crate::paths::vault_root_for_id_from_base(base.path(), new_id);
            std::fs::create_dir_all(&fresh_root).expect("mkdir fresh vaults/<new-id>/");
            let fresh_meta = fresh_root.join("vault.meta");

            let state = VaultCreationState::default();
            let token = seed_session_into_state(&state);

            // The guard must NOT fire (the sibling lives in a different dir),
            // and the full write pipeline must complete.
            commit_with_vault_path(token, fresh_meta.clone(), &state, None)
                .await
                .expect("creating the Nth vault with a populated sibling present must succeed");

            // The new vault landed under its own `vaults/<new-id>/`.
            assert!(
                fresh_meta.exists(),
                "the Nth vault's vault.meta must be written under its fresh vaults/<new-id>/"
            );
            // The sibling's vault.meta is byte-for-byte untouched — the guard's
            // per-vault-dir scoping means the create never reached the sibling.
            assert_eq!(
                std::fs::read(&sibling_meta).expect("sibling vault.meta still readable"),
                sibling_meta_bytes,
                "the populated sibling vault.meta must be left untouched"
            );
        });
    }

    /// MYND-169: the eager-written `vault.attachments` decrypts under the
    /// vault's own `root_key`-derived catalog KEK and the plaintext is the
    /// empty catalog (the documented base case for a fresh vault).
    #[test]
    fn commit_eager_written_vault_attachments_decrypts_to_empty() {
        rt().block_on(async {
            let scratch = ScratchVault::new();
            let state = VaultCreationState::default();
            let token = Uuid::new_v4();
            let session = build_session(VaultId::mint(), "commit-test-pw", FAST_TEST_KDF)
                .expect("build_session");
            let original_root_key: [u8; AEAD_KEY_LEN] = *session.root_key;
            let original_account_hash = session.account.hash;
            state
                .try_insert(token, session)
                .expect("scratch state has room");

            commit_with_vault_path(token, scratch.path().to_path_buf(), &state, None)
                .await
                .expect("commit happy-path");

            let catalog_bytes = std::fs::read(scratch.dir.join("vault.attachments"))
                .expect("vault.attachments must exist after eager-write");
            assert_eq!(
                &catalog_bytes[0..4],
                protocol::CATALOG_BLOB_V0_2_MAGIC.as_slice(),
                "a vault born v0.2 seeds an MYC5 catalog"
            );
            let catalog_key = protocol::derive_subkey_versioned(
                BIRTH_GENERATION,
                &original_root_key,
                protocol::SubkeyRole::AttachmentsCatalogKey,
            );
            let catalog = protocol::decode_attachments_catalog(
                &catalog_key,
                &original_account_hash,
                &catalog_bytes,
            )
            .expect("eager-written vault.attachments must decrypt under the vault's own root_key");
            assert_eq!(
                catalog,
                protocol::AttachmentsCatalog::empty(),
                "eager-written catalog must equal the empty catalog"
            );
        });
    }

    #[test]
    fn vault_artifacts_present_returns_true_when_vault_attachments_present() {
        // MYND-169 extension: `vault.attachments` (spec § 9.10) is a v0.1
        // vault artefact. A stale catalog left by a prior partial-fail
        // `vault_delete` must gate a fresh `vault_create` the same way
        // `vault.meta` / `vault.prefs` do.
        let tmp = crate::test_support::ScopedTempDir::new("vap-attach").expect("scoped tempdir");
        std::fs::write(tmp.path().join("vault.attachments"), b"stale catalog bytes")
            .expect("seed vault.attachments");
        assert!(
            vault_artifacts_present(tmp.path()).expect("scan ok"),
            "vault.attachments is a recognized v0.1 vault artefact (spec § 9.10)"
        );
    }

    #[test]
    fn vault_artifacts_present_returns_true_when_orphan_attachment_blob_present() {
        // MYND-169: an orphan attachment blob under attachments/ (a
        // content-addressed hex filename, no extension) from a partial-fail
        // vault_delete must gate a fresh vault_create — same class as an
        // orphan notes/*.myn.
        let tmp =
            crate::test_support::ScopedTempDir::new("vap-attach-blob").expect("scoped tempdir");
        let attach = tmp.path().join("attachments");
        std::fs::create_dir_all(&attach).expect("mkdir attachments/");
        std::fs::write(attach.join("aabbccdd"), b"orphan blob bytes").expect("seed orphan blob");
        assert!(
            vault_artifacts_present(tmp.path()).expect("scan ok"),
            "an orphan attachment blob is a recognized artefact"
        );
    }

    #[test]
    fn vault_artifacts_present_returns_false_when_attachments_dir_empty() {
        let tmp =
            crate::test_support::ScopedTempDir::new("vap-attach-empty").expect("scoped tempdir");
        std::fs::create_dir_all(tmp.path().join("attachments")).expect("mkdir attachments/");
        assert!(
            !vault_artifacts_present(tmp.path()).expect("scan ok"),
            "an empty attachments/ dir is not a recognized artefact"
        );
    }

    /// MYND-160 Task 12: the eager-written `vault.prefs` decrypts under
    /// the same `root_key` the just-created vault carries, and the
    /// THE BIRTH FORMAT, asserted on the bytes.
    ///
    /// Everything else about creation is generation-blind by construction —
    /// `parse_vault_meta_any` accepts either, the singleton decoders detect the
    /// magic, unlock branches — so a regression to v0.1 would break nothing
    /// visible and no other test here would notice. The four-byte magic is the
    /// only thing that says which generation a new user's vault actually is.
    #[test]
    fn a_freshly_created_vault_is_born_in_the_birth_generation() {
        rt().block_on(async {
            let scratch = ScratchVault::new();
            let state = VaultCreationState::default();
            let token = Uuid::new_v4();
            let session = build_session(VaultId::mint(), "birth-format-pw", FAST_TEST_KDF)
                .expect("build_session");
            state
                .try_insert(token, session)
                .expect("scratch state has room");

            commit_with_vault_path(token, scratch.path().to_path_buf(), &state, None)
                .await
                .expect("commit happy-path");

            let meta_bytes = std::fs::read(scratch.path()).expect("vault.meta");
            assert_eq!(
                protocol::meta_version_of(&meta_bytes),
                Some(BIRTH_GENERATION),
                "a new vault must be born in BIRTH_GENERATION"
            );
            assert_eq!(
                &meta_bytes[0..4],
                protocol::VAULT_META_V0_2_MAGIC.as_slice(),
                "and that generation is NTV5 on disk"
            );
        });
    }

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
            let session = build_session(VaultId::mint(), "commit-test-pw", FAST_TEST_KDF)
                .expect("build_session");
            let original_root_key: [u8; AEAD_KEY_LEN] = *session.root_key;
            let original_account_hash = session.account.hash;
            state
                .try_insert(token, session)
                .expect("scratch state has room");

            commit_with_vault_path(token, scratch.path().to_path_buf(), &state, None)
                .await
                .expect("commit happy-path");

            // Decrypt the eager-written vault.prefs using the original
            // root_key and account_number_hash.
            let prefs_bytes = std::fs::read(scratch.dir.join("vault.prefs"))
                .expect("vault.prefs must exist after eager-write");
            assert_eq!(
                &prefs_bytes[0..4],
                protocol::PREFS_BLOB_V0_2_MAGIC.as_slice(),
                "a vault born v0.2 seeds an MYP5 prefs blob"
            );
            let prefs_key = protocol::derive_subkey_versioned(
                BIRTH_GENERATION,
                &original_root_key,
                protocol::SubkeyRole::PrefsKey,
            );
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
                commit_with_vault_path(token, scratch.path().to_path_buf(), &state, None).await;

            let shown = commit_outcome(&result);
            assert!(
                matches!(result, Err(AppError::VaultArtifactsPresent)),
                "commit must reject orphan-myn-without-vault-meta state, got {shown}"
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
