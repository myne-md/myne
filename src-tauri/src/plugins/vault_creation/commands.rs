//! Tauri commands for the vault-creation flow.
//!
//! - [`begin`]  → session creation (Task 12).
//! - [`commit`] → write `vault.meta` to disk (Task 13).
//! - [`cancel`] → drop a session (Task 14).

use super::error::AppError;
use super::state::{
    SessionLookup, VaultCreationSession, VaultCreationState, MAX_CONCURRENT_SESSIONS,
};
use protocol::{
    KdfParams, AEAD_KEY_LEN, AEAD_NONCE_LEN, ARGON2_SALT_LEN, DEFAULT_V0_1_KDF_PARAMS,
    VAULT_META_ITEMS_KEY_ID_LEN, VAULT_META_WRAPPED_ITEMS_KEY_LEN, VAULT_META_WRAPPED_ROOT_KEY_LEN,
};
use serde::Serialize;
use std::time::Instant;
use tauri::{Runtime, State};
use uuid::Uuid;

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
/// Fast-rejects with [`AppError::TooManyConcurrentSessions`] if the
/// session map is already at [`MAX_CONCURRENT_SESSIONS`]. Otherwise
/// dispatches the expensive work (Argon2id × 2 at v0.1 baseline,
/// ~2–3 seconds total) to a `tokio::task::spawn_blocking` worker so
/// the async runtime's threads stay free for other Tauri IPC traffic.
///
/// On success: inserts the session under a fresh UUID and returns the
/// 24-word phrase (cloned), the account number's display form, and
/// the session token. `root_key` and the wrap keys remain in the
/// session — they NEVER cross the IPC boundary.
#[tauri::command]
pub async fn begin(
    password: String,
    state: State<'_, VaultCreationState>,
) -> Result<BeginResult, AppError> {
    // Fast-path cap check before kicking off ~2 seconds of Argon2id
    // work. The authoritative re-check happens inside `try_insert`
    // under the lock; this only avoids wasting CPU on a doomed call.
    if state.count() >= MAX_CONCURRENT_SESSIONS {
        return Err(AppError::TooManyConcurrentSessions);
    }

    // Heavy work off the runtime worker pool.
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

    // Authoritative cap check + insert under one lock.
    state.try_insert(token, session)?;

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
/// 2. `state.take(token)` consumes the session (`SessionNotFound` /
///    `SessionExpired` on absent / TTL-evicted).
/// 3. Resolve `vault_dir` and ensure it exists.
/// 4. In a `spawn_blocking` worker: AEAD-wrap `root_key` twice, derive
///    `itemsKey_wrap_key` via `derive_subkey`, generate `itemsKey` +
///    its UUIDv7, AEAD-wrap `itemsKey`, build [`protocol::VaultMeta`],
///    serialize 345 bytes, atomic-write.
/// 5. Drop the session — every Zeroizing field wipes.
#[tauri::command]
pub async fn commit<R: Runtime>(
    session_token: String,
    state: State<'_, VaultCreationState>,
    app: tauri::AppHandle<R>,
) -> Result<(), AppError> {
    let token = Uuid::parse_str(&session_token).map_err(|_| AppError::SessionNotFound)?;
    let session: VaultCreationSession = match state.take(token) {
        SessionLookup::Found(boxed) => *boxed,
        SessionLookup::Expired => return Err(AppError::SessionExpired),
        SessionLookup::NotFound => return Err(AppError::SessionNotFound),
    };

    let vault_path = crate::paths::vault_dir(&app)?.join("vault.meta");

    tokio::task::spawn_blocking(move || -> Result<(), AppError> {
        let bytes = build_and_serialize_vault_meta(session)?;
        crate::atomic_write::atomic_write(&vault_path, &bytes)?;
        Ok(())
    })
    .await
    .map_err(|_| AppError::JoinFailure)??;

    Ok(())
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
pub(crate) fn build_and_serialize_vault_meta(
    session: VaultCreationSession,
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
    let aad_items = protocol::aad_items_key_wrap(&items_key_id);
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
    fn random_bytes_produces_distinct_output_on_repeated_calls() {
        // Sanity that the helper actually consults the CSPRNG.
        let a: [u8; 16] = random_bytes().unwrap();
        let b: [u8; 16] = random_bytes().unwrap();
        assert_ne!(a, b);
    }
}
