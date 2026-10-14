//! Deterministic device-enrollment orchestration (MYND-425 task 3).
//!
//! Drives the SCRAM-SHA-256-PLUS handshake against the server auth surface
//! (`myne-server/internal/authapi`) to obtain a per-device token — no key
//! transport, fully deterministic given the inputs:
//!
//! 1. `POST /auth/scram/init` {account_hash, username, client_nonce} → server
//!    returns {handshake_id, combined_nonce, salt, iterations}.
//! 2. `protocol::scram_client_proof(secret, salt, iterations, …)` → client proof
//!    + the server-signature the client verifies (mutual auth).
//! 3. `POST /auth/scram/final` {handshake_id, client_final, device_id, path} →
//!    {approved, token?, server_signature}.
//!
//! The SCRAM `username` is **derived in this module** as the hex-encoded 16-byte
//! account hash — never accepted from a caller — so the raw account number
//! (bearer-token semantics, threat-model AS9) structurally cannot reach the wire
//! or the server's persisted auth state (`account-number.md` §7, revised
//! 2026-07-13).
//!
//! The `secret` is the server-auth subkey (`DeriveSubkey(root_key, ServerAuth)`),
//! derived upstream from {account# + password} OR {account# + 24-word phrase}
//! after the vault.meta unwrap — both paths converge on the same `root_key`, so
//! both enroll identically (the `path` only selects the server's approval gate:
//! recovery self-approves, a new password device is pending).
//!
//! `device_id` is **client-CSPRNG** (`getrandom`), generated here and distinct
//! from the server-issued token (SYNC-2: revoking the token never touches it).
//!
//! Transport: the shared `SyncTransport` (the rustls layer in production,
//! `FakeTransport` in tests). cbind is empty over loopback http; the live
//! `-PLUS` exporter feed is the R3-pending wiring (mirrors the SCRAM client).

use super::devices::SyncDeviceError;
use super::token_store::TokenStore as _;
use super::transport::{HttpMethod, SyncTransport, TransportError};
use protocol::{
    aad_password_wrap, aad_password_wrap_v0_2, aad_recovery_wrap, aad_recovery_wrap_v0_2,
    aead_open_ctx, derive_password_wrap_key, derive_password_wrap_key_v0_2,
    derive_recovery_wrap_key_from_normalized, derive_recovery_wrap_key_from_normalized_v0_2,
    derive_subkey, meta_version_of, normalize_user_phrase, parse_account_number,
    parse_vault_meta_any, validate_kdf_params, KdfParams, MetaVersion, SubkeyRole, AEAD_KEY_LEN,
};
use protocol::{scram_client_final_message, scram_client_proof, SCRAM_CBIND_NAME};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

/// RFC 9266 TLS keying-material exporter label — FROZEN, must match the Go server's
/// `scram.ExporterLabel` byte-for-byte, or the channel binding diverges and every
/// `-PLUS` handshake fails. Verified byte-identical Go↔rustls under TLS 1.3 (F5).
const TLS_EXPORTER_LABEL: &[u8] = b"EXPORTER-Channel-Binding";
/// Frozen tls-exporter output length (RFC 9266 uses 32); matches `scram.ExporterLen`.
const TLS_EXPORTER_LEN: usize = 32;

/// The account-ownership path, selecting the server's approval gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnrollPath {
    /// {account# + password}: a new device is pending until an existing device approves.
    Password,
    /// {account# + 24-word phrase}: self-approves (bootstrap exception).
    Recovery,
}

impl EnrollPath {
    fn wire(self) -> &'static str {
        match self {
            EnrollPath::Password => "password",
            EnrollPath::Recovery => "recovery",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
struct ScramInitReq<'a> {
    account_hash_hex: &'a str,
    username: &'a str,
    client_nonce: &'a str,
}

#[derive(Debug, Clone, Deserialize)]
struct ScramInitResp {
    handshake_id: String,
    combined_nonce: String,
    salt_hex: String,
    iterations: u32,
    /// F5: `"tls-exporter"` when the server terminates TLS 1.3 and expects a real
    /// RFC 9266 channel binding in client-final; absent/empty behind a proxy or on
    /// loopback http, where the server binds to empty. Absent on an old server →
    /// empty cbind (the pre-F5 behavior), so this is backward-compatible.
    #[serde(default)]
    cbind: String,
}

#[derive(Debug, Clone, Serialize)]
struct ScramFinalReq<'a> {
    handshake_id: &'a str,
    client_final: &'a str,
    device_id_hex: &'a str,
    path: &'a str,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct ScramFinalResp {
    approved: bool,
    #[serde(default)]
    token_hex: String,
    #[serde(default)]
    server_signature_b64: String,
}

/// The outcome of an enrollment attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnrollOutcome {
    /// True when the device was approved and a token issued.
    pub approved: bool,
    /// The per-device token (empty when pending). Hex-decoded from the wire.
    pub token: Vec<u8>,
    /// The client-generated device_id used for this enrollment (CSPRNG).
    pub device_id: [u8; 16],
}

/// Enrollment failures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnrollError {
    /// Account/username unknown or the proof was rejected (server 401).
    Unauthenticated,
    /// The account is FROZEN (server 403 `frozen`, MYND-506).
    ///
    /// A distinct variant because the remedy is distinct and the credential
    /// message is actively wrong: the user's account number, password and
    /// phrase are all correct, and no amount of re-typing them will help. It
    /// used to flatten into `Unauthenticated`, so the app told the user their
    /// credentials were incorrect while the server had said exactly why.
    Frozen,
    /// The account is at its device cap (server 403 `device_limit`, MYND-506).
    /// Same reasoning as `Frozen`: correct credentials, different remedy —
    /// remove a device.
    DeviceLimit,
    /// The device is registered but still awaiting approval (server 403
    /// `pending_approval`).
    PendingApproval,
    /// The server gates new accounts behind an invite code and none was sent
    /// (server 403 `invite_code_required`). Distinct because the remedy is: the
    /// user must type the code the operator gave them, and re-typing their
    /// password will not help.
    InviteCodeRequired,
    /// The invite code sent did not match the server's (server 403
    /// `invite_code_invalid`). Distinct from `InviteCodeRequired` so the UI can
    /// say "that code is wrong" rather than "a code is needed".
    InviteCodeInvalid,
    /// The server's signature did not match — possible MITM; abort (mutual auth).
    ServerSignatureMismatch,
    /// A malformed / unparseable server response.
    BadResponse,
    /// Transport-level failure.
    Transport(TransportError),
}

/// A server error body (mirrors the Go `errBody`), for the 403 codes above.
#[derive(Debug, Clone, Deserialize)]
struct EnrollErrBodyWire {
    #[serde(default)]
    error_code: String,
}

/// Map a 403 body's `error_code` to the variant that names the remedy.
///
/// An unparseable or unrecognised body degrades to `Unauthenticated`, which is
/// what the whole 403 family used to be — no worse than before, and no guessing.
fn forbidden_reason(body: &[u8]) -> EnrollError {
    let code = serde_json::from_slice::<EnrollErrBodyWire>(body)
        .map(|e| e.error_code)
        .unwrap_or_default();
    match code.as_str() {
        "frozen" => EnrollError::Frozen,
        "device_limit" => EnrollError::DeviceLimit,
        "pending_approval" => EnrollError::PendingApproval,
        "invite_code_required" => EnrollError::InviteCodeRequired,
        "invite_code_invalid" => EnrollError::InviteCodeInvalid,
        _ => EnrollError::Unauthenticated,
    }
}

impl From<TransportError> for EnrollError {
    fn from(e: TransportError) -> Self {
        EnrollError::Transport(e)
    }
}

use super::to_hex as hex_encode;

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// Generate a fresh client-CSPRNG device_id (distinct from any server token).
pub fn generate_device_id() -> [u8; 16] {
    let mut id = [0u8; 16];
    getrandom::getrandom(&mut id).expect("OS CSPRNG available for device_id");
    id
}

/// The `POST /auth/register` request (mirrors the Go `registerReq`).
#[derive(Debug, Clone, Serialize)]
struct RegisterReq<'a> {
    account_hash_hex: &'a str,
    username: &'a str,
    salt_hex: &'a str,
    iterations: u32,
    stored_key_hex: &'a str,
    server_key_hex: &'a str,
    /// Present only for a gated server; omitted otherwise so an open server
    /// receives exactly the pre-gate request body.
    #[serde(skip_serializing_if = "Option::is_none")]
    invite_code: Option<&'a str>,
}

/// PBKDF2 iteration count for the SCRAM verifier. The real password-stretching
/// is the Argon2id that produced `root_key`; `secret` here is already a derived
/// subkey, so a modest count suffices (the server stores it and echoes it back
/// on every `/auth/scram/init`).
pub const SCRAM_REGISTER_ITERATIONS: u32 = 4096;

/// Upload the account's SCRAM verifier (`POST /auth/register`, first-write only).
/// **Idempotent:** a 409 `already_registered` is treated as success — another
/// device registered first, and its stored salt is what every later handshake
/// fetches from `/auth/scram/init`. The salt is freshly CSPRNG-generated; only
/// the first writer's salt is stored. `stored_key`/`server_key` are functions of
/// `(secret, salt, iterations)` ONLY (independent of the SCRAM nonces), so empty
/// nonces are passed to `scram_client_proof` here.
pub fn register_verifier(
    transport: &dyn SyncTransport,
    account_hash: &[u8; 16],
    secret: &[u8],
) -> Result<(), EnrollError> {
    register_verifier_with_code(transport, account_hash, secret, None)
}

/// [`register_verifier`] with the shared invite code a gated server requires for
/// a NEW account. `None` sends no field, which is correct for an open server and
/// for a device joining an account that already exists (the server answers 409
/// before it consults the gate, so a later device needs no code).
pub fn register_verifier_with_code(
    transport: &dyn SyncTransport,
    account_hash: &[u8; 16],
    secret: &[u8],
    invite_code: Option<&str>,
) -> Result<(), EnrollError> {
    // AS9 username (see module doc): hex(account_hash), used for both wire fields.
    let account_hash_hex = hex_encode(account_hash);
    let mut salt = [0u8; 16];
    getrandom::getrandom(&mut salt).map_err(|_| EnrollError::BadResponse)?;
    let iterations = SCRAM_REGISTER_ITERATIONS;
    let v = scram_client_proof(secret, &salt, iterations, &account_hash_hex, "", "", &[]);
    let invite_code = invite_code.filter(|c| !c.is_empty());
    let body = serde_json::to_vec(&RegisterReq {
        account_hash_hex: &account_hash_hex,
        username: &account_hash_hex,
        salt_hex: &hex_encode(&salt),
        iterations,
        stored_key_hex: &hex_encode(&v.stored_key),
        server_key_hex: &hex_encode(&v.server_key),
        invite_code,
    })
    .map_err(|_| EnrollError::BadResponse)?;
    let resp = transport.request(HttpMethod::Post, "/auth/register", &body, None)?;
    match resp.status {
        200 | 409 => Ok(()), // 409 already_registered → idempotent success
        401 => Err(EnrollError::Unauthenticated),
        403 => Err(forbidden_reason(&resp.body)),
        _ => Err(EnrollError::BadResponse),
    }
}

/// Replace the account's SCRAM verifier (`POST /auth/verifier`, **authed**).
///
/// A whole-vault re-key (`protocol.md` §10.4) mints a new `root_key`, so
/// `derive_subkey(root_key, ServerAuth)` — the SCRAM secret — changes with it.
/// [`register_verifier`] cannot carry that: it is first-write-only by design and
/// answers 409 for an account that already has one, which is exactly the
/// property that keeps an unauthenticated caller from overwriting a credential.
///
/// So the replace is authed, and the server takes the account from the bearer
/// token rather than from the body — a device can only replace the verifier of
/// the account it already authenticated against (myne-md/myne#429).
///
/// **Called while the CURRENT token is still valid**, i.e. right after the
/// migration, not lazily. The failure this avoids is delayed and total: an
/// enrolled device presents a stored token and keeps working, so nothing looks
/// wrong until that token expires or a new device enrols — and then every
/// handshake fails 401 with no way to fix it from the client side.
pub fn replace_verifier(
    transport: &dyn SyncTransport,
    token: &str,
    account_hash: &[u8; 16],
    secret: &[u8],
) -> Result<(), EnrollError> {
    let account_hash_hex = hex_encode(account_hash);
    let mut salt = [0u8; 16];
    getrandom::getrandom(&mut salt).map_err(|_| EnrollError::BadResponse)?;
    let iterations = SCRAM_REGISTER_ITERATIONS;
    let v = scram_client_proof(secret, &salt, iterations, &account_hash_hex, "", "", &[]);
    // No `account_hash_hex` field: the server reads the account from the session.
    // Sending one would invite a reader to think it is the authority.
    let body = serde_json::json!({
        "username": account_hash_hex,
        "salt_hex": hex_encode(&salt),
        "iterations": iterations,
        "stored_key_hex": hex_encode(&v.stored_key),
        "server_key_hex": hex_encode(&v.server_key),
    });
    let body = serde_json::to_vec(&body).map_err(|_| EnrollError::BadResponse)?;
    let resp = transport.request(HttpMethod::Post, "/auth/verifier", &body, Some(token))?;
    match resp.status {
        200 => Ok(()),
        401 => Err(EnrollError::Unauthenticated),
        _ => Err(EnrollError::BadResponse),
    }
}

/// Seed the account's `vault.meta` on the server (`PUT /vault.meta`, authed) so a
/// new device can fetch it pre-auth at enrollment. The body is the raw
/// (AEAD-protected, credential-gated) meta bytes — opaque to the blind server.
pub fn put_vault_meta(
    transport: &dyn SyncTransport,
    token: &str,
    meta_bytes: &[u8],
) -> Result<(), EnrollError> {
    let resp = transport.request(HttpMethod::Put, "/vault.meta", meta_bytes, Some(token))?;
    match resp.status {
        200 => Ok(()),
        401 => Err(EnrollError::Unauthenticated),
        _ => Err(EnrollError::BadResponse),
    }
}

/// Run the SCRAM enrollment handshake for a freshly-generated `device_id`.
/// `secret` is the server-auth subkey; `client_nonce` SHOULD be CSPRNG (the
/// caller supplies it so the flow stays deterministic + testable).
pub fn enroll(
    transport: &dyn SyncTransport,
    account_hash: &[u8; 16],
    secret: &[u8],
    path: EnrollPath,
    client_nonce: &str,
    device_id: [u8; 16],
) -> Result<EnrollOutcome, EnrollError> {
    let account_hash_hex = hex_encode(account_hash);
    // AS9 username (see module doc): hex(account_hash), derived here.
    let username: &str = &account_hash_hex;

    // 1. client-first → server-first.
    let init_body = serde_json::to_vec(&ScramInitReq {
        account_hash_hex: &account_hash_hex,
        username,
        client_nonce,
    })
    .map_err(|_| EnrollError::BadResponse)?;
    let init_resp = transport.request(HttpMethod::Post, "/auth/scram/init", &init_body, None)?;
    if init_resp.status == 401 {
        return Err(EnrollError::Unauthenticated);
    }
    if init_resp.status != 200 {
        return Err(EnrollError::BadResponse);
    }
    let init: ScramInitResp =
        serde_json::from_slice(&init_resp.body).map_err(|_| EnrollError::BadResponse)?;
    let salt = hex_decode(&init.salt_hex).ok_or(EnrollError::BadResponse)?;

    // 2+3. Build client-final bound to the connection's tls-exporter and send it on
    // that same connection (F5). `build_final(cbind)` computes the proof + client-
    // final for a given channel binding: the real exporter when the server signalled
    // `-PLUS` (`cbind == "tls-exporter"`), else an empty cbind — the pre-F5 path, and
    // what a proxy-terminated / old server binds to as well.
    let device_id_hex = hex_encode(&device_id);
    // The expected server signature depends on the cbind the closure actually used
    // (it is part of the auth message), and the closure runs inside the transport —
    // so capture it here for the post-response mutual-auth check.
    let expected_server_sig = std::cell::RefCell::new(Vec::new());
    let build_final = |cbind: &[u8]| -> Vec<u8> {
        let out = scram_client_proof(
            secret,
            &salt,
            init.iterations,
            username,
            client_nonce,
            &init.combined_nonce,
            cbind,
        );
        *expected_server_sig.borrow_mut() = out.server_signature.to_vec();
        let client_final =
            scram_client_final_message(&init.combined_nonce, cbind, &out.client_proof);
        serde_json::to_vec(&ScramFinalReq {
            handshake_id: &init.handshake_id,
            client_final: &client_final,
            device_id_hex: &device_id_hex,
            path: path.wire(),
        })
        .unwrap_or_default()
    };
    let final_resp = if init.cbind == SCRAM_CBIND_NAME {
        transport.request_bound_to_exporter(
            HttpMethod::Post,
            "/auth/scram/final",
            None,
            TLS_EXPORTER_LABEL,
            TLS_EXPORTER_LEN,
            &build_final,
        )?
    } else {
        transport.request(
            HttpMethod::Post,
            "/auth/scram/final",
            &build_final(&[]),
            None,
        )?
    };
    if final_resp.status == 401 {
        return Err(EnrollError::Unauthenticated);
    }
    // #268: the server says WHY it refused, in the body, and this used to throw
    // that away — every 403 became `BadResponse` and then, one layer up, the
    // non-distinguishing "Account number, password, or recovery phrase is
    // incorrect" banner. For a frozen account or a hit device cap the
    // credentials are correct and re-typing them can never work.
    if final_resp.status == 403 {
        return Err(forbidden_reason(&final_resp.body));
    }
    if final_resp.status != 200 {
        return Err(EnrollError::BadResponse);
    }
    let fr: ScramFinalResp =
        serde_json::from_slice(&final_resp.body).map_err(|_| EnrollError::BadResponse)?;

    // Mutual auth: the server's signature MUST match what we computed.
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;
    let server_sig = B64
        .decode(fr.server_signature_b64.as_bytes())
        .map_err(|_| EnrollError::BadResponse)?;
    // Constant-time (`protocol.md` §5.4): this is a MAC compare and it is the
    // client's ONLY proof that the peer holds the account's `server-auth`-
    // derived `ServerKey` — unlike the AEAD-tag case in `change_password`,
    // nothing else re-checks it, so a short-circuiting `!=` would be the sole
    // gate against a rogue sync server. `ConstantTimeEq for [u8]` already
    // yields `Choice(0)` on a length mismatch, so no separate length guard is
    // needed; a non-decodable signature stays `BadResponse` above so the error
    // taxonomy keeps "malformed" and "wrong" apart.
    {
        use subtle::ConstantTimeEq as _;
        if !bool::from(server_sig.ct_eq(expected_server_sig.borrow().as_slice())) {
            return Err(EnrollError::ServerSignatureMismatch);
        }
    }

    let token = if fr.token_hex.is_empty() {
        Vec::new()
    } else {
        hex_decode(&fr.token_hex).ok_or(EnrollError::BadResponse)?
    };

    Ok(EnrollOutcome {
        approved: fr.approved,
        token,
        device_id,
    })
}

#[cfg(test)]
mod bootstrap_meta_tests {
    //! The idempotence half of task 85, tested without a server.
    //!
    //! `join_account_from_host` is a network fetch, then this, then an unlock
    //! and a SCRAM handshake. Everything ELSE needs a live server; this does
    //! not — and this is where the three acceptance criteria about re-running
    //! actually live, so it is where they get asserted rather than argued.

    use super::{validate_fetched_meta, write_bootstrap_meta};
    use crate::plugins::sync::devices::SyncDeviceError;
    use crate::plugins::vault_creation::commands::{build_and_serialize_vault_meta, build_session};
    use crate::test_support::{ScopedTempDir, FAST_TEST_KDF};
    use crate::vault_io::{StdVaultIo, VaultIo};
    use protocol::{meta_version_of, parse_vault_meta_any, MetaVersion};

    const IO: StdVaultIo = StdVaultIo;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    /// A real `vault.meta` and the `account_number_hash` it binds.
    fn a_meta(password: &str) -> (Vec<u8>, [u8; 16]) {
        let session = build_session(crate::vault_id::VaultId::mint(), password, FAST_TEST_KDF)
            .expect("build_session");
        let bytes = build_and_serialize_vault_meta(&session).expect("serialize vault.meta");
        let hash = parse_vault_meta_any(&bytes)
            .expect("parse")
            .account_number_hash;
        (bytes.to_vec(), hash)
    }

    #[test]
    fn a_first_run_writes_the_fetched_meta_byte_for_byte() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("join-first-run").unwrap();
            let path = tmp.path().join("vault.meta");
            let (bytes, hash) = a_meta("CanaryPass-9-animals!");

            write_bootstrap_meta(&IO, &path, &bytes, &hash)
                .await
                .expect("first run writes");

            // Byte-identical to what the server sent — the criterion says
            // byte-identical, so this compares BYTES rather than re-parsing and
            // comparing fields, which would pass on a re-serialisation.
            assert_eq!(IO.read(&path).await.unwrap(), bytes);
            // And the KDF parameters are readable from it, which is what makes
            // "never hardcoded" checkable at all.
            let parsed = parse_vault_meta_any(&bytes).unwrap();
            assert_eq!(parsed.kdf_params, FAST_TEST_KDF);
        });
    }

    #[test]
    fn a_re_run_for_the_same_account_succeeds_and_leaves_the_local_meta_untouched() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("join-rerun").unwrap();
            let path = tmp.path().join("vault.meta");
            let (bytes, hash) = a_meta("CanaryPass-9-animals!");
            write_bootstrap_meta(&IO, &path, &bytes, &hash)
                .await
                .unwrap();

            // The server's copy has moved on — a password change on another
            // device rewrites `vault.meta`, so this is an ordinary situation and
            // NOT a signal to overwrite. The local copy may be the newer of the
            // two; the sync meta phase reconciles them.
            let (newer_server_bytes, _) = a_meta("AnotherPass-9-animals!");
            let mut server_bytes = newer_server_bytes;
            server_bytes[6..22].copy_from_slice(&hash); // same account, new wraps

            write_bootstrap_meta(&IO, &path, &server_bytes, &hash)
                .await
                .expect("a second run must re-authenticate, not fail");

            assert_eq!(
                IO.read(&path).await.unwrap(),
                bytes,
                "the local meta must survive a re-run untouched"
            );
        });
    }

    #[test]
    fn a_container_holding_a_different_account_is_refused_with_its_own_error() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("join-mismatch").unwrap();
            let path = tmp.path().join("vault.meta");
            let (mine, my_hash) = a_meta("CanaryPass-9-animals!");
            write_bootstrap_meta(&IO, &path, &mine, &my_hash)
                .await
                .unwrap();

            // Someone else's account, fetched into the same browser container.
            let (theirs, _) = a_meta("TheirPass-9-animals!");
            let their_hash = [0x5au8; 16];

            let err = write_bootstrap_meta(&IO, &path, &theirs, &their_hash)
                .await
                .expect_err("a different account must be refused");
            // Its OWN variant, not `BadRequest`: nothing the user retypes fixes
            // this, so copy that says "check your password" would send them
            // round a loop with no exit.
            assert_eq!(err, SyncDeviceError::AccountMismatch);
            assert_eq!(
                IO.read(&path).await.unwrap(),
                mine,
                "a refused join must not have touched the resident vault"
            );
        });
    }

    /// The loop this arm exists to break. Boot routing sends a web `Corrupted`
    /// straight back here (`initialStageFromProbe`, task 85), because on a client
    /// whose vault lives on the server a corrupt local container is a
    /// re-bootstrap rather than data loss. A bootstrap that refused to replace
    /// unparseable rubble would return the user to the screen that sent them,
    /// forever — which is exactly the dead end task 22's fourth criterion names.
    #[test]
    fn an_unparseable_local_meta_is_replaced_rather_than_refused() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("join-rubble").unwrap();
            let path = tmp.path().join("vault.meta");
            IO.write(&path, b"neither buffer verified", Default::default())
                .await
                .unwrap();
            let (server_bytes, hash) = a_meta("CanaryPass-9-animals!");

            write_bootstrap_meta(&IO, &path, &server_bytes, &hash)
                .await
                .expect("rubble must not dead-end the bootstrap");

            assert_eq!(
                IO.read(&path).await.unwrap(),
                server_bytes,
                "the server's meta must have replaced the unparseable local one"
            );
        });
    }

    #[test]
    fn a_genuine_write_failure_is_not_mistaken_for_an_existing_container() {
        rt().block_on(async {
            // No parent directory: the write fails and NOTHING is there, which
            // is the case the `exists` probe exists to separate from "already
            // bootstrapped". Reporting `AccountMismatch` here would tell the
            // user to erase a container that does not exist.
            let tmp = ScopedTempDir::new("join-io-fail").unwrap();
            let path = tmp.path().join("missing-dir").join("vault.meta");
            let (bytes, hash) = a_meta("CanaryPass-9-animals!");

            let err = write_bootstrap_meta(&IO, &path, &bytes, &hash)
                .await
                .expect_err("an unwritable path must fail");
            assert_eq!(err, SyncDeviceError::Internal);
        });
    }
    // ── myne#297: nothing is written before it is validated ─────────────────

    /// Build a `vault.meta` whose KDF parameters are out of policy, the way a
    /// hostile or broken server can. Structurally valid — `parse_vault_meta`
    /// accepts it, because the protocol defers range checks to the derivation
    /// site — which is exactly what made it reach the disk.
    fn a_meta_with_out_of_policy_kdf() -> (Vec<u8>, [u8; 16]) {
        let (bytes, hash) = a_meta("correct horse battery staple");
        let mut bad = bytes.clone();
        // `m_kib` sits in the 11-byte canonical KDF param block; drive it to 1,
        // far below MIN_KDF_M_KIB, by rewriting the parsed value back out.
        let meta = parse_vault_meta_any(&bad).expect("parse");
        let mut params = meta.kdf_params;
        params.m_kib = 1;
        // Re-serialize by patching the same offsets the parser read from, so the
        // rest of the record (magic, version, account hash, wraps) is untouched
        // — INCLUDING the generation. Re-stamping a v0.2 meta as `MYV1` would
        // make this fixture reject for the wrong reason and stop testing the
        // KDF-policy gate at all.
        let rebuilt = protocol::VaultMeta {
            kdf_params: params,
            ..meta
        };
        let patched = match meta_version_of(&bad).expect("known generation") {
            MetaVersion::V0_2 => protocol::serialize_vault_meta_v0_2(&rebuilt),
            MetaVersion::V0_1 => protocol::serialize_vault_meta(&rebuilt).to_vec(),
        };
        bad.copy_from_slice(&patched);
        (bad, hash)
    }

    #[test]
    fn an_out_of_policy_kdf_is_refused_before_any_write() {
        let (bad, hash) = a_meta_with_out_of_policy_kdf();
        assert_eq!(
            validate_fetched_meta(&bad, &hash).unwrap_err(),
            SyncDeviceError::BadRequest,
            "a server-supplied meta the unlock would refuse must never reach disk"
        );
    }

    #[test]
    fn a_meta_for_another_account_is_refused() {
        // The check has to live at the fetch site: `write_bootstrap_meta`'s own
        // account-hash arm never executes in the browser, because the container
        // write ignores `replace: false`.
        let (bytes, _hash) = a_meta("correct horse battery staple");
        assert_eq!(
            validate_fetched_meta(&bytes, &[0xAB; 16]).unwrap_err(),
            SyncDeviceError::BadRequest,
        );
    }

    #[test]
    fn an_honest_meta_for_the_typed_account_passes() {
        let (bytes, hash) = a_meta("correct horse battery staple");
        assert!(validate_fetched_meta(&bytes, &hash).is_ok());
    }

    #[test]
    fn garbage_is_refused_as_internal_not_as_a_bad_request() {
        // A non-meta is not "your credentials are wrong" — keeping the two
        // distinguishable is what stops the SYNC-8 banner sending the user round
        // a loop that cannot terminate.
        assert_eq!(
            validate_fetched_meta(b"not a vault meta", &[0u8; 16]).unwrap_err(),
            SyncDeviceError::Internal,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::sync::transport::FakeTransport;
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;

    const SECRET: &[u8] = &[0xab; 32];
    const ACCOUNT: [u8; 16] = [0x42; 16];
    const SALT: &[u8] = &[0x11; 16];

    // Build the canned init + final responses a correct server would send, so the
    // enroll flow's proof + mutual-auth check exercise the real crypto.
    fn wire_server(t: &FakeTransport, device_id: &[u8; 16], approved: bool, token_hex: &str) {
        let client_nonce = "cn";
        let combined = "cnsn";
        let init = format!(
            "{{\"handshake_id\":\"hid\",\"combined_nonce\":\"{combined}\",\"salt_hex\":\"{}\",\"iterations\":1}}",
            hex_encode(SALT)
        );
        t.on(HttpMethod::Post, "/auth/scram/init", 200, init.into_bytes());

        // The server signature the client will verify (same crypto). The SCRAM
        // username the client derives is hex(ACCOUNT) — mirror it here.
        let out = scram_client_proof(
            SECRET,
            SALT,
            1,
            &hex_encode(&ACCOUNT),
            client_nonce,
            combined,
            &[],
        );
        let final_json = format!(
            "{{\"approved\":{approved},\"token_hex\":\"{token_hex}\",\"server_signature_b64\":\"{}\"}}",
            B64.encode(out.server_signature)
        );
        let _ = device_id;
        t.on(
            HttpMethod::Post,
            "/auth/scram/final",
            200,
            final_json.into_bytes(),
        );
    }

    #[test]
    fn enroll_approved_returns_token_and_distinct_device_id() {
        let t = FakeTransport::new();
        let dev = [0x07u8; 16];
        wire_server(&t, &dev, true, "deadbeef");
        let out = enroll(&t, &ACCOUNT, SECRET, EnrollPath::Recovery, "cn", dev).unwrap();
        assert!(out.approved);
        assert_eq!(out.token, vec![0xde, 0xad, 0xbe, 0xef]);
        assert_eq!(out.device_id, dev);
        // device_id is not the token (SYNC-2).
        assert_ne!(out.token.as_slice(), &out.device_id[..]);
    }

    #[test]
    fn enroll_pending_returns_no_token() {
        let t = FakeTransport::new();
        let dev = [0x08u8; 16];
        wire_server(&t, &dev, false, "");
        let out = enroll(&t, &ACCOUNT, SECRET, EnrollPath::Password, "cn", dev).unwrap();
        assert!(!out.approved);
        assert!(out.token.is_empty());
    }

    // The declared path is what the server's approval gate reads, so the string
    // that goes on the wire is load-bearing and not an implementation detail: a
    // person device that declares the wrong one lands pending with no releaser
    // (server-protocol §3.1a). The sibling tests above drive the same canned
    // server, but their responses hardcode `approved` and never look at the
    // request, so all of them stay green if `EnrollPath::wire` returns one
    // constant. This is the case that fails when it does.
    #[test]
    fn the_declared_path_is_what_reaches_the_final_body() {
        for (path, wire) in [
            (EnrollPath::Password, "password"),
            (EnrollPath::Recovery, "recovery"),
        ] {
            let t = FakeTransport::new();
            let dev = [0x0bu8; 16];
            wire_server(&t, &dev, true, "aa");
            enroll(&t, &ACCOUNT, SECRET, path, "cn", dev).expect("handshake");

            let final_req = t
                .requests()
                .into_iter()
                .find(|r| r.1 == "/auth/scram/final")
                .unwrap_or_else(|| panic!("no /auth/scram/final request for {path:?}"));
            let body: serde_json::Value = serde_json::from_slice(&final_req.2).expect("final json");
            assert_eq!(body["path"], wire, "{path:?} declared the wrong gate");
        }
    }

    #[test]
    fn put_vault_meta_authed_puts_raw_bytes() {
        // F1: the credential-change push PUTs the raw vault.meta bytes under the
        // device token. The blind server stores them verbatim (opaque ciphertext).
        let t = FakeTransport::new();
        t.on(HttpMethod::Put, "/vault.meta", 200, Vec::new());
        let meta = b"opaque-meta-ciphertext-stand-in";
        put_vault_meta(&t, "deadbeef", meta).unwrap();

        let reqs = t.requests();
        let put = reqs
            .iter()
            .find(|(m, p, _, _, _)| *m == HttpMethod::Put && p == "/vault.meta")
            .expect("PUT /vault.meta recorded");
        assert_eq!(
            put.2.as_slice(),
            meta,
            "body is the raw meta bytes, unmodified"
        );
        assert_eq!(
            put.3.as_deref(),
            Some("deadbeef"),
            "PUT is authed with the device token"
        );
    }

    #[test]
    fn put_vault_meta_maps_401_to_unauthenticated() {
        let t = FakeTransport::new();
        t.on(HttpMethod::Put, "/vault.meta", 401, Vec::new());
        assert!(matches!(
            put_vault_meta(&t, "tok", b"x"),
            Err(EnrollError::Unauthenticated)
        ));
    }

    #[test]
    fn enroll_rejects_wrong_server_signature() {
        let t = FakeTransport::new();
        let init = format!(
            "{{\"handshake_id\":\"hid\",\"combined_nonce\":\"cnsn\",\"salt_hex\":\"{}\",\"iterations\":1}}",
            hex_encode(SALT)
        );
        t.on(HttpMethod::Post, "/auth/scram/init", 200, init.into_bytes());
        // A wrong/forged server signature → mutual-auth abort.
        let bad = format!(
            "{{\"approved\":true,\"token_hex\":\"aa\",\"server_signature_b64\":\"{}\"}}",
            B64.encode([0x00u8; 32])
        );
        t.on(HttpMethod::Post, "/auth/scram/final", 200, bad.into_bytes());
        assert_eq!(
            enroll(&t, &ACCOUNT, SECRET, EnrollPath::Recovery, "cn", [0x09; 16]).unwrap_err(),
            EnrollError::ServerSignatureMismatch
        );
    }

    #[test]
    fn enroll_unauthenticated_on_401() {
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Post,
            "/auth/scram/init",
            401,
            b"{\"error_code\":\"unauthenticated\"}".to_vec(),
        );
        assert_eq!(
            enroll(&t, &ACCOUNT, SECRET, EnrollPath::Password, "cn", [0x0a; 16]).unwrap_err(),
            EnrollError::Unauthenticated
        );
    }

    #[test]
    fn generated_device_ids_are_distinct() {
        assert_ne!(generate_device_id(), generate_device_id());
    }

    #[test]
    fn register_sends_hash_hex_username_never_display() {
        // AS9: the SCRAM username IS the 16-byte account hash, hex-encoded —
        // the raw account number (display form) never crosses the wire.
        let t = FakeTransport::new();
        t.on(HttpMethod::Post, "/auth/register", 200, Vec::new());
        register_verifier(&t, &ACCOUNT, SECRET).unwrap();
        let reqs = t.requests();
        let req = reqs
            .iter()
            .find(|(m, p, _, _, _)| *m == HttpMethod::Post && p == "/auth/register")
            .expect("register recorded");
        let body = std::str::from_utf8(&req.2).unwrap();
        assert!(
            body.contains(&format!("\"username\":\"{}\"", hex_encode(&ACCOUNT))),
            "username must be the account-hash hex: {body}"
        );
        assert!(
            !body.contains("MY-"),
            "no display-form account number on the wire: {body}"
        );
    }

    fn register_body(t: &FakeTransport) -> String {
        let reqs = t.requests();
        let req = reqs
            .iter()
            .find(|(m, p, _, _, _)| *m == HttpMethod::Post && p == "/auth/register")
            .expect("register recorded");
        std::str::from_utf8(&req.2).unwrap().to_string()
    }

    #[test]
    fn register_sends_invite_code_only_when_configured() {
        let t = FakeTransport::new();
        t.on(HttpMethod::Post, "/auth/register", 200, Vec::new());
        register_verifier_with_code(&t, &ACCOUNT, SECRET, Some("beta-code-0001")).unwrap();
        assert!(
            register_body(&t).contains("\"invite_code\":\"beta-code-0001\""),
            "a configured code must be on the wire"
        );

        let t2 = FakeTransport::new();
        t2.on(HttpMethod::Post, "/auth/register", 200, Vec::new());
        register_verifier(&t2, &ACCOUNT, SECRET).unwrap();
        assert!(
            !register_body(&t2).contains("invite_code"),
            "an open server must receive the pre-gate body"
        );

        // An empty string is no code, not a zero-length secret.
        let t3 = FakeTransport::new();
        t3.on(HttpMethod::Post, "/auth/register", 200, Vec::new());
        register_verifier_with_code(&t3, &ACCOUNT, SECRET, Some("")).unwrap();
        assert!(!register_body(&t3).contains("invite_code"));
    }

    #[test]
    fn register_maps_invite_code_refusals_to_distinct_variants() {
        let required = FakeTransport::new();
        required.on(
            HttpMethod::Post,
            "/auth/register",
            403,
            b"{\"error_code\":\"invite_code_required\"}".to_vec(),
        );
        assert_eq!(
            register_verifier_with_code(&required, &ACCOUNT, SECRET, None).unwrap_err(),
            EnrollError::InviteCodeRequired
        );

        let invalid = FakeTransport::new();
        invalid.on(
            HttpMethod::Post,
            "/auth/register",
            403,
            b"{\"error_code\":\"invite_code_invalid\"}".to_vec(),
        );
        assert_eq!(
            register_verifier_with_code(&invalid, &ACCOUNT, SECRET, Some("wrong")).unwrap_err(),
            EnrollError::InviteCodeInvalid
        );
    }

    #[test]
    fn enroll_init_sends_hash_hex_username() {
        let t = FakeTransport::new();
        let dev = [0x07u8; 16];
        wire_server(&t, &dev, true, "deadbeef");
        enroll(&t, &ACCOUNT, SECRET, EnrollPath::Recovery, "cn", dev).unwrap();
        let reqs = t.requests();
        let req = reqs
            .iter()
            .find(|(m, p, _, _, _)| *m == HttpMethod::Post && p == "/auth/scram/init")
            .expect("init recorded");
        let body = std::str::from_utf8(&req.2).unwrap();
        assert!(
            body.contains(&format!("\"username\":\"{}\"", hex_encode(&ACCOUNT))),
            "init username must be the account-hash hex: {body}"
        );
    }
}

/// Which credential the enrolling device proves account ownership with.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnrollCredential {
    Password,
    Recovery,
}

/// What the blocking enrollment/join closure hands back: `(approved, device_id_hex)`.
/// Named rather than written inline so the `spawn_blocking` signature stays under
/// rustfmt's width — spelling the tuple out re-indents both closure bodies.
/// `(approved, device_id_hex, token_to_store, vault_dir)`.
///
/// The last two exist because the token WRITE left the blocking closure with
/// phase3-web-client task 86: `TokenStore` is async now (a browser-backed store
/// has no synchronous implementation), so the closure hands the token out and the
/// async caller persists it. The network work — the handshake and the `vault.meta`
/// seed, both of which need the moved-in `transport` — stays on the pool.
pub(crate) type EnrollmentOutcome = (bool, String, Option<Vec<u8>>, std::path::PathBuf);

/// Outcome of an enrollment attempt surfaced to the UI.
#[derive(Debug, Clone, Serialize)]
pub struct EnrollResult {
    /// True when the device was approved + a token issued (false = pending approval).
    pub approved: bool,
    /// The freshly generated `device_id` (hex) this enrollment registered
    /// (MYND-548) — the create returns the id it minted. The caller needs it to
    /// name THIS device once its first authed cycle has run, and has no other way
    /// to learn it: a PENDING device holds no token, so it cannot read the roster
    /// to discover which row is itself. Not a secret — this is the VV actor
    /// identifier, deliberately distinct from the revocable per-device token
    /// (`sync-protocol.md` §4).
    pub device_id_hex: String,
}

// ── the enrolment FLOW, lifted out of the host-gated `commands.rs` ──────────
//
// phase3-web-client task 84. Everything above is the SCRAM wire — pure over a
// transport, and already target-independent. What was not was the flow around
// it: resolving the vault dir, reading the endpoint config, deriving
// `root_key` from the credential, and persisting the identity + token
// afterwards. None of that was host-shaped either; it merely lived behind an
// `AppHandle`.

/// Refuse a KDF cost this host cannot service, **before** anything allocates it.
///
/// The twin of the ceiling check in
/// [`crate::plugins::vault_unlock::commands::unlock_with_path`], and the same
/// question it asks: `protocol::validate_kdf_params` answers whether the
/// parameters are *legal* (up to `MAX_KDF_M_KIB` = 4 GiB), which is a different
/// question from whether this client can afford them. A vault created with
/// high-but-legal parameters passes validation and is still unopenable in a
/// browser, and on `wasm32` an over-large Argon2id block is not a catchable
/// allocation failure but an **abort** — the Worker dies and the user sees no
/// cause. So the refusal has to happen before the allocation, not around it.
///
/// `ceiling_kib` is [`crate::host::HostCtx::max_kdf_memory_kib`] read out as a
/// value. `None` — desktop and mobile — accepts everything the protocol does:
/// their ceiling is the machine's, which the allocator already reports honestly.
///
/// This does NOT relax protocol validation and must not: `validate_kdf_params`
/// still runs on this path, `MAX_KDF_M_KIB` is unchanged, and the v0.1 256 MiB
/// baseline is unchanged. The parameters are AAD-bound and read from
/// `vault.meta` (`protocol.md` §4.2) — they can be neither lowered nor
/// renegotiated per client. This is strictly an "and can this host service it"
/// question layered on top (`protocol.md` §11.2: a client that refuses to derive
/// because the running browser cannot afford 256 MiB is a **client behaviour**,
/// not a parameter profile).
///
/// The variant is [`SyncDeviceError::KdfTooLargeForHost`] rather than a
/// `BadRequest`, because the remedy is different in kind: the credentials are
/// correct and re-typing them cannot help — the vault has to be opened where
/// its KDF is affordable. Flattened into `BadRequest` it would land on the
/// SYNC-8 non-distinguishing credential banner, sending the user round a loop
/// that cannot terminate.
fn check_kdf_host_capability(
    params: &KdfParams,
    ceiling_kib: Option<u32>,
) -> Result<(), SyncDeviceError> {
    let Some(ceiling_kib) = ceiling_kib else {
        return Ok(());
    };
    let required_kib = params.m_kib;
    if required_kib <= ceiling_kib {
        return Ok(());
    }
    // Public figures only — both come from the unencrypted KDF block and from
    // the client build — so this log carries no credential-adjacent value.
    tracing::error!(
        stage = "kdf_capability",
        error_kind = "KdfTooLargeForHost",
        required_kib,
        ceiling_kib,
        "vault KDF memory cost exceeds what this host can service"
    );
    Err(SyncDeviceError::KdfTooLargeForHost)
}

#[cfg(test)]
mod enrol_root_key_tests {
    //! The credential→`root_key` half of enrolment, tested without a server.
    //!
    //! Both generations are built BY HAND here rather than through
    //! `build_and_serialize_vault_meta`, and each case asserts the magic of the
    //! bytes it just built. That is deliberate: the creation path's generation
    //! is exactly what the birth-format flip changes, so a fixture borrowed from
    //! it would silently stop testing the generation its test name claims.

    use super::{unwrap_root_key_for_enrol, EnrollPath};
    use crate::plugins::sync::devices::SyncDeviceError;
    use crate::test_support::FAST_TEST_KDF;
    use protocol::{
        aad_password_wrap, aad_recovery_wrap, aead_seal_ctx, derive_password_wrap_key,
        derive_recovery_wrap_key_from_normalized, encode_vault_meta_v0_2_raw, meta_version_of,
        normalize_user_phrase, parse_vault_meta_any, serialize_vault_meta, MetaVersion, VaultMeta,
    };

    const ROOT_KEY: [u8; 32] = [0x5c; 32];
    const ITEMS_KEY: [u8; 32] = [0xa1; 32];
    const ACCOUNT_HASH: [u8; 16] = [0x2b; 16];
    const PASSWORD: &str = "correct horse battery staple";
    const PHRASE: &str = "abandon ability able about above absent absorb abstract absurd abuse access accident acoustic acquire across act action actor actress actual";

    /// A v0.1 (`MYV1`) meta wrapping [`ROOT_KEY`] under both credentials.
    fn a_v0_1_meta() -> VaultMeta {
        let salt_pw = [0x11u8; 16];
        let salt_rec = [0x22u8; 16];
        let pw_key =
            derive_password_wrap_key(PASSWORD, &salt_pw, &ACCOUNT_HASH, &FAST_TEST_KDF).unwrap();
        let enc_pw = aead_seal_ctx(
            &pw_key,
            &[0x31u8; 24],
            &ROOT_KEY,
            &aad_password_wrap(&FAST_TEST_KDF),
        )
        .unwrap();
        let normalized = normalize_user_phrase(PHRASE);
        let rec_key = derive_recovery_wrap_key_from_normalized(
            normalized.as_str(),
            &salt_rec,
            &ACCOUNT_HASH,
            &FAST_TEST_KDF,
        )
        .unwrap();
        let enc_rec = aead_seal_ctx(
            &rec_key,
            &[0x41u8; 24],
            &ROOT_KEY,
            &aad_recovery_wrap(&FAST_TEST_KDF),
        )
        .unwrap();
        let mut enc_root_key_password = [0u8; 64];
        enc_root_key_password.copy_from_slice(&enc_pw);
        let mut enc_root_key_recovery = [0u8; 64];
        enc_root_key_recovery.copy_from_slice(&enc_rec);
        VaultMeta {
            account_number_hash: ACCOUNT_HASH,
            kdf_params: FAST_TEST_KDF,
            random_salt_password: salt_pw,
            random_salt_recovery: salt_rec,
            nonce_password_wrap: [0x31u8; 24],
            enc_root_key_password,
            nonce_recovery_wrap: [0x41u8; 24],
            enc_root_key_recovery,
            items_key_id: [0x07u8; 16],
            items_key_nonce: [0x51u8; 24],
            enc_items_key: [0u8; 64],
            membership: None,
            person_binding: None,
        }
    }

    /// The v0.2 (`NTV5`) twin — same `ROOT_KEY`, same credentials, v0.2 salt
    /// domains and AADs throughout.
    fn a_v0_2_meta() -> VaultMeta {
        let normalized = normalize_user_phrase(PHRASE);
        let bytes = encode_vault_meta_v0_2_raw(
            &ROOT_KEY,
            &ITEMS_KEY,
            &[0x07u8; 16],
            PASSWORD,
            normalized.as_str(),
            &ACCOUNT_HASH,
            &FAST_TEST_KDF,
            &[0x11u8; 16],
            &[0x22u8; 16],
            &[0x31u8; 24],
            &[0x41u8; 24],
            &[0x51u8; 24],
        )
        .expect("encode NTV5 meta");
        assert_eq!(
            meta_version_of(&bytes),
            Some(MetaVersion::V0_2),
            "fixture must really be NTV5"
        );
        parse_vault_meta_any(&bytes).expect("parse NTV5 meta")
    }

    #[test]
    fn a_v0_1_vault_enrols_on_either_credential() {
        let meta = a_v0_1_meta();
        assert_eq!(
            meta_version_of(&serialize_vault_meta(&meta)),
            Some(MetaVersion::V0_1),
            "fixture must really be MYV1"
        );
        for path in [EnrollPath::Password, EnrollPath::Recovery] {
            let credential = match path {
                EnrollPath::Password => PASSWORD,
                EnrollPath::Recovery => PHRASE,
            };
            let rk = unwrap_root_key_for_enrol(MetaVersion::V0_1, &meta, path, credential)
                .expect("v0.1 enrol unwrap");
            assert_eq!(rk.as_slice(), &ROOT_KEY, "{path:?}");
        }
    }

    /// The defect: enrolment derived under v0.1 unconditionally, so a MIGRATED
    /// vault could not enrol a device on either credential — and the error it
    /// returned, `BadRequest`, is the same one a genuinely wrong password gets.
    #[test]
    fn a_migrated_vault_enrols_on_either_credential() {
        let meta = a_v0_2_meta();
        for path in [EnrollPath::Password, EnrollPath::Recovery] {
            let credential = match path {
                EnrollPath::Password => PASSWORD,
                EnrollPath::Recovery => PHRASE,
            };
            let rk = unwrap_root_key_for_enrol(MetaVersion::V0_2, &meta, path, credential)
                .expect("v0.2 enrol unwrap");
            assert_eq!(rk.as_slice(), &ROOT_KEY, "{path:?}");
        }
    }

    /// The generations really are separate domains — the same password against
    /// the wrong generation is refused, which is what makes the routing
    /// load-bearing rather than cosmetic.
    #[test]
    fn the_wrong_generation_refuses_a_correct_credential() {
        let v0_1 = a_v0_1_meta();
        let v0_2 = a_v0_2_meta();
        assert!(matches!(
            unwrap_root_key_for_enrol(MetaVersion::V0_2, &v0_1, EnrollPath::Password, PASSWORD),
            Err(SyncDeviceError::BadRequest)
        ));
        assert!(matches!(
            unwrap_root_key_for_enrol(MetaVersion::V0_1, &v0_2, EnrollPath::Password, PASSWORD),
            Err(SyncDeviceError::BadRequest)
        ));
    }
}

#[cfg(test)]
mod kdf_ceiling_tests {
    //! The host-capability half of the enroll gate, tested without a server.
    //!
    //! Everything around it in `enroll_device_from_host` — the pre-auth fetch,
    //! the derive, the SCRAM handshake — needs a live server. The comparison
    //! does not, and it is the whole of what this gate decides, so it is
    //! asserted here rather than argued.

    use super::check_kdf_host_capability;
    use crate::host::test_host::TestHost;
    use crate::host::HostCtx as _;
    use crate::plugins::sync::devices::SyncDeviceError;
    use protocol::{validate_kdf_params, KdfParams, DEFAULT_V0_1_KDF_PARAMS, MAX_KDF_M_KIB};

    /// A browser host's ceiling — the same 1 GiB `web/wasm`'s
    /// `MAX_KDF_MEMORY_KIB` declares, restated here because `core` cannot see
    /// that crate. In KiB, the unit `KdfParams::m_kib` and the seam both use, so
    /// the comparison reads without a conversion in the middle.
    const WEB_CEILING_KIB: u32 = 1024 * 1024;

    fn params(m_kib: u32) -> KdfParams {
        KdfParams {
            m_kib,
            ..DEFAULT_V0_1_KDF_PARAMS
        }
    }

    #[test]
    fn a_legal_cost_the_host_cannot_service_is_refused() {
        // The interval this gate exists for. `MAX_KDF_M_KIB` (4 GiB) is what a
        // hostile server may declare in the `vault.meta` it serves pre-auth, and
        // the protocol accepts it — so every other check on this path passes and
        // the derive is reached. On `wasm32` that derive is an abort rather than
        // an `Err`, which is why the refusal has to come from here.
        let p = params(MAX_KDF_M_KIB);
        validate_kdf_params(&p).expect("the protocol accepts this — that is the point");

        let host = TestHost::new("kdf-ceiling").with_kdf_ceiling_kib(WEB_CEILING_KIB);
        assert_eq!(
            check_kdf_host_capability(&p, host.max_kdf_memory_kib()),
            Err(SyncDeviceError::KdfTooLargeForHost)
        );
    }

    #[test]
    fn a_cost_exactly_at_the_ceiling_is_serviceable() {
        // `>` and not `>=`: a host that declares it can afford N must accept N,
        // or the ceiling refuses the very cost it advertises.
        let host = TestHost::new("kdf-at-ceiling").with_kdf_ceiling_kib(WEB_CEILING_KIB);
        assert_eq!(
            check_kdf_host_capability(&params(WEB_CEILING_KIB), host.max_kdf_memory_kib()),
            Ok(())
        );
    }

    #[test]
    fn the_v0_1_baseline_still_enrolls_under_a_browser_ceiling() {
        // 256 MiB, measured at 321 MiB of wasm linear memory (`protocol.md`
        // §4.1). The gate must never be what stops an ordinary vault.
        let host = TestHost::new("kdf-baseline").with_kdf_ceiling_kib(WEB_CEILING_KIB);
        assert_eq!(
            check_kdf_host_capability(&DEFAULT_V0_1_KDF_PARAMS, host.max_kdf_memory_kib()),
            Ok(())
        );
    }

    #[test]
    fn a_host_with_no_ceiling_defers_entirely_to_the_protocol() {
        // Desktop and mobile. `None` by default on the seam, and this gate must
        // add nothing there: their ceiling is the machine's, which the allocator
        // already reports honestly.
        let host = TestHost::new("kdf-no-ceiling");
        assert_eq!(host.max_kdf_memory_kib(), None);
        assert_eq!(
            check_kdf_host_capability(&params(MAX_KDF_M_KIB), host.max_kdf_memory_kib()),
            Ok(())
        );
    }
}

/// Unwrap the vault's `root_key` from `meta` under `credential`, in the
/// generation `version` names — the enrol path's crypto core.
///
/// **Split out of [`enroll_device_from_host`] so it can be asserted at all.**
/// The rest of that path needs a live server (`kdf_ceiling_tests` says so in as
/// many words), and this step did not — it simply had no seam, so the one part
/// of enrolment testable offline went untested. It was also wrong: it derived
/// under v0.1 unconditionally, so a migrated (`NTV5`) vault could not enrol a
/// device at all. The failure surfaced as `BadRequest`, i.e. "wrong password"
/// for a password that was right (myne-md/myne#442 follow-up).
fn unwrap_root_key_for_enrol(
    version: MetaVersion,
    meta: &protocol::VaultMeta,
    path: EnrollPath,
    credential: &str,
) -> Result<Zeroizing<[u8; AEAD_KEY_LEN]>, SyncDeviceError> {
    let v0_2 = version == MetaVersion::V0_2;
    let (wrap, nonce, sealed, aad) = match path {
        EnrollPath::Password => {
            let wrap = if v0_2 {
                derive_password_wrap_key_v0_2(
                    credential,
                    &meta.random_salt_password,
                    &meta.account_number_hash,
                    &meta.kdf_params,
                )
            } else {
                derive_password_wrap_key(
                    credential,
                    &meta.random_salt_password,
                    &meta.account_number_hash,
                    &meta.kdf_params,
                )
            }
            .map_err(|_| SyncDeviceError::BadRequest)?;
            let aad = if v0_2 {
                aad_password_wrap_v0_2(&meta.kdf_params)
            } else {
                aad_password_wrap(&meta.kdf_params)
            };
            (
                wrap,
                &meta.nonce_password_wrap,
                &meta.enc_root_key_password,
                aad,
            )
        }
        EnrollPath::Recovery => {
            let normalized = normalize_user_phrase(credential);
            let wrap = if v0_2 {
                derive_recovery_wrap_key_from_normalized_v0_2(
                    normalized.as_str(),
                    &meta.random_salt_recovery,
                    &meta.account_number_hash,
                    &meta.kdf_params,
                )
            } else {
                derive_recovery_wrap_key_from_normalized(
                    normalized.as_str(),
                    &meta.random_salt_recovery,
                    &meta.account_number_hash,
                    &meta.kdf_params,
                )
            }
            .map_err(|_| SyncDeviceError::BadRequest)?;
            let aad = if v0_2 {
                aad_recovery_wrap_v0_2(&meta.kdf_params)
            } else {
                aad_recovery_wrap(&meta.kdf_params)
            };
            (
                wrap,
                &meta.nonce_recovery_wrap,
                &meta.enc_root_key_recovery,
                aad,
            )
        }
    };
    let opened =
        aead_open_ctx(&wrap, nonce, sealed, &aad).map_err(|_| SyncDeviceError::BadRequest)?;
    if opened.len() != AEAD_KEY_LEN {
        return Err(SyncDeviceError::Internal);
    }
    let mut rk = Zeroizing::new([0u8; AEAD_KEY_LEN]);
    rk.copy_from_slice(&opened);
    Ok(rk)
}

/// Enroll this device against the configured server using {account# + credential}.
///
/// **The first extracted core that carries key material across the seam**
/// (phase3-web-client task 84), and the discipline is unchanged rather than
/// re-derived: `credential` is wrapped in `Zeroizing` on the first non-doc
/// statement, moves into the blocking closure, and dies with it; `root_key` and
/// the derived `ServerAuth` secret never leave that closure at all. What comes
/// back out is `(approved, device_id_hex, token, dir)` — an identity and a
/// revocable token, never a key.
///
/// Returns `approved` so the CALLER can fire its own "local change" signal: the
/// desktop bumps a `Manager::try_state` counter, the browser calls its
/// scheduler. That side effect is the one host-shaped thing left, and it stayed
/// outside.
///
/// The credential→`root_key` step lives in [`unwrap_root_key_for_enrol`] rather
/// than inline, so it can be asserted without a server.
pub async fn enroll_device_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
    account_number: String,
    credential: String,
    credential_kind: EnrollCredential,
) -> Result<EnrollResult, SyncDeviceError> {
    let credential = Zeroizing::new(credential);

    // Resolve the vault dir (token storage) + the endpoint transport.
    let dir = crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)
        .map_err(|_| SyncDeviceError::Internal)?;
    let cfg_path = super::config::config_path_from_host(host, io)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let cfg = super::config::read_config(io, &cfg_path)
        .await
        .map_err(|_| SyncDeviceError::NotConfigured)?;
    // The gated-server admission code, read before `endpoint_url` moves out of
    // `cfg`, and moved into the blocking closure that registers the verifier.
    let invite_code = cfg.invite_code.clone();
    let url = cfg.endpoint_url.ok_or(SyncDeviceError::NotConfigured)?;

    let account =
        parse_account_number(account_number.trim()).map_err(|_| SyncDeviceError::BadRequest)?;
    let path = match credential_kind {
        EnrollCredential::Password => EnrollPath::Password,
        EnrollCredential::Recovery => EnrollPath::Recovery,
    };
    // The FIRST device's fallback `vault.meta`, read here rather than inside the
    // closure (task 84). It used to be a `std::fs::read` on the blocking pool —
    // which compiles for wasm32 and fails at runtime, and would have failed on
    // exactly the path a first device takes. `None` is fine: it only matters when
    // the server answers 404, and a device with no local meta and no server copy
    // has nothing to enrol against either way.
    let local_meta: Option<Vec<u8>> = io.read(&dir.join("vault.meta")).await.ok();
    // The host's Argon2id memory ceiling, read out here as a plain `Option<u32>`
    // so it can MOVE into the closure. The `host` trait object cannot: it is a
    // non-`'static` borrow and `run_blocking` requires `F: 'static`. Nor can the
    // comparison be hoisted the way `unlock_with_path` hoists its own — the
    // `vault.meta` it compares against is fetched from the server INSIDE the
    // closure, so out here there is nothing to compare. Moving the VALUE is
    // enough: the contract is "before the allocation", not "outside the
    // closure", and on `wasm32` `run_blocking` is inline anyway.
    let kdf_ceiling_kib = host.max_kdf_memory_kib();

    // The SCRAM username is derived inside `enroll` as the account-hash hex —
    // the display-form account number never crosses the wire (AS9).
    let outcome =
        crate::task::run_blocking(move || -> Result<EnrollmentOutcome, SyncDeviceError> {
            let transport = super::http_transport::build_transport(&url)
                .map_err(|_| SyncDeviceError::Transport)?;

            // 1. Obtain vault.meta. A returning device fetches it pre-auth from the
            //    server; the FIRST device (the owner enabling sync) has no server
            //    copy yet (404) and falls back to its local vault.meta — which it
            //    seeds to the server after enrolling (step 6).
            let acct_hex = {
                let mut s = String::with_capacity(32);
                for b in &account.hash {
                    s.push_str(&format!("{b:02x}"));
                }
                s
            };
            let meta_resp = transport
                .request(
                    super::transport::HttpMethod::Get,
                    &format!("/vault.meta?account={acct_hex}"),
                    &[],
                    None,
                )
                .map_err(|_| SyncDeviceError::Transport)?;
            let meta_bytes: Vec<u8> = match meta_resp.status {
                200 => meta_resp.body,
                404 => local_meta.ok_or(SyncDeviceError::Transport)?,
                _ => return Err(SyncDeviceError::Transport),
            };
            let meta = parse_vault_meta_any(&meta_bytes).map_err(|_| SyncDeviceError::Internal)?;
            // Bind the meta to the account the user actually typed, on BOTH arms.
            //
            // The 404 arm falls back to this device's OWN `vault.meta`, and
            // without this check nothing tied that file to `account.hash`: a
            // well-formed, Damm-valid account number that is neither this
            // vault's nor registered on the server would derive successfully
            // (own vault + own password), register a fresh server account under
            // the typed hash, upload this vault's meta there, and report
            // success — while `sync-state.json` kept the typed hash as the AAD
            // input for `vault.prefs` / `vault.attachments` / `vault.themes`,
            // so those three families would decode as empty for the life of the
            // device. The 200 arm matches by construction (the server stores
            // the meta under the typed hash), and checking it anyway hardens
            // against a server serving a foreign account's meta.
            //
            // `AccountMismatch` rather than `BadRequest`: nothing the user
            // retypes about their password fixes it, which is the same reason
            // the web bootstrap path uses that variant.
            if meta.account_number_hash != account.hash {
                return Err(SyncDeviceError::AccountMismatch);
            }
            // The `vault.meta` came from the (untrusted, TB5) sync server, so its
            // `kdf_params` are attacker-controlled. Validate the Argon2id memory/time
            // floor+ceiling BEFORE deriving — otherwise a hostile server could pin an
            // absurd `m_kib` (e.g. multi-TiB) and force a pre-auth OOM/DoS. Every
            // other derive site (unlock / recover / change-password / quick-unlock)
            // already gates on this; the sync enroll path was the one gap.
            validate_kdf_params(&meta.kdf_params).map_err(|_| SyncDeviceError::BadRequest)?;
            // …and separately, whether THIS host can afford what it declares.
            // Passing `validate_kdf_params` is not the same as being affordable:
            // it accepts up to 4 GiB, so anything in (host ceiling, 4 GiB]
            // satisfies every other check on this path and reaches Argon2id —
            // precisely the interval the ceiling exists to refuse.
            check_kdf_host_capability(&meta.kdf_params, kdf_ceiling_kib)?;

            // 2. Derive root_key from the credential + the meta salts — under the
            //    generation the meta declares.
            //
            //    `parse_vault_meta_any` above accepts a migrated `NTV5` meta, but
            //    the parse is where the generation stops: a `VaultMeta` has no
            //    field for it. Deriving under v0.1 against a v0.2 meta produces a
            //    wrap key that opens nothing, and this path maps that to
            //    `BadRequest` — so a migrated vault reported "wrong password" for
            //    a correct password and could not enrol a device at all
            //    (myne-md/myne#442 follow-up).
            let version = meta_version_of(&meta_bytes).ok_or(SyncDeviceError::Internal)?;
            let root_key = unwrap_root_key_for_enrol(version, &meta, path, &credential)?;

            // 3. ServerAuth secret.
            let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);

            // 4. Register the SCRAM verifier (idempotent — a 409 already_registered
            //    is success; the first device's stored salt is what every later
            //    handshake reuses). Keyed on the canonical `account.hash` (the same
            //    value the server namespaces on), so register + enroll agree.
            register_verifier_with_code(
                transport.as_ref(),
                &account.hash,
                secret.as_slice(),
                invite_code.as_deref(),
            )
            .map_err(SyncDeviceError::from)?;

            // 5. SCRAM enroll.
            let device_id = generate_device_id();
            let mut nonce_bytes = [0u8; 16];
            getrandom::getrandom(&mut nonce_bytes).map_err(|_| SyncDeviceError::Internal)?;
            let mut client_nonce = String::with_capacity(32);
            for b in &nonce_bytes {
                client_nonce.push_str(&format!("{b:02x}"));
            }

            let out = enroll(
                transport.as_ref(),
                &account.hash,
                secret.as_slice(),
                path,
                &client_nonce,
                device_id,
            )
            // #268: preserve the server's reason instead of flattening every
            // refusal into "credentials incorrect".
            .map_err(SyncDeviceError::from)?;

            // 6. On approval: store the token, seed vault.meta to the server (so the
            //    next device can fetch it), and persist the account/device identity
            //    sync_now needs to author heads.
            // Persist the device identity ALWAYS (even when pending), so a pending
            // device can later claim its token by re-running the handshake under the
            // unlocked root_key once an existing device approves it.
            // The sync-state read-modify-write is deferred to the async caller
            // (phase3-web-client task 86), for the same reason as the token
            // write below: `state.rs` is on the storage seam now and the seam is
            // async, while this closure runs on the blocking pool. Only the
            // `dev_hex` derivation — pure formatting — stays here, because the
            // network work below needs it.
            let mut dev_hex = String::with_capacity(32);
            for b in &device_id {
                dev_hex.push_str(&format!("{b:02x}"));
            }

            // The token WRITE is deferred to the caller (phase3-web-client task
            // 86): `TokenStore` is async now, because a browser-backed store has
            // no synchronous implementation to write, and this closure is on the
            // blocking pool. What stays here is the NETWORK work — the meta seed
            // needs `transport`, which was moved in.
            //
            // Deferring reorders the two: the meta is seeded before the token is
            // stored, where it used to be after. Both orders are crash-safe and
            // recoverable by re-running the handshake — a crash now leaves a
            // seeded meta and no token (re-enrol claims one), where before it
            // left a token and an unseeded meta (the next cycle seeds it).
            let stored_token = if out.approved && !out.token.is_empty() {
                let mut token_hex = String::with_capacity(out.token.len() * 2);
                for b in &out.token {
                    token_hex.push_str(&format!("{b:02x}"));
                }
                // Best-effort seed (a returning device's meta already matches).
                let _ = put_vault_meta(transport.as_ref(), &token_hex, &meta_bytes);
                Some(out.token)
            } else {
                None
            };
            Ok((out.approved, dev_hex, stored_token, dir))
        })
        .await
        .map_err(|_| SyncDeviceError::Internal)??;
    let (outcome, device_id_hex, stored_token, token_dir) = outcome;

    // The deferred sync-state read-modify-write (task 86). Persist the device
    // identity ALWAYS — even when pending — so a pending device can later claim
    // its token by re-running the handshake under the unlocked `root_key` once
    // an existing device approves it.
    //
    // NOT `unwrap_or_default()`. This is a read-modify-WRITE, so defaulting on a
    // failed read would persist a blank state over a real one: cursor, VV log,
    // per-blob CAS baselines and `meta_baseline_hex` gone in a single step — the
    // device re-enrols as brand new AND the meta phase reads the absent baseline
    // as "only the server changed" and overwrites a locally-newer `vault.meta`.
    // An ABSENT file still defaults (that is `read_sync_state`'s own `Ok`); what
    // must not be swallowed is a file that exists and did not parse.
    let mut st = super::state::read_sync_state(io, &token_dir)
        .await
        .map_err(|_| {
            tracing::error!(
                stage = "read_sync_state",
                error_kind = "Internal",
                "sync-state.json unreadable; refusing to overwrite it with a fresh identity"
            );
            SyncDeviceError::Internal
        })?;
    st.account_hash_hex = Some({
        // Pure formatting over `account.hash`, re-derived here rather than
        // threaded out of the closure: it is four lines and no state.
        let mut h = String::with_capacity(32);
        for b in &account.hash {
            h.push_str(&format!("{b:02x}"));
        }
        h
    });
    st.device_id_hex = Some(device_id_hex.clone());
    // #267: PROPAGATE, and before the token write.
    //
    // Discarding this failure produced a device that held a valid token and no
    // identity — and every downstream gate reads as fine: the cycle's `NotReady`
    // check is quiet, `status_from` maps (token, enrolled) → `Idle`, and the
    // UI's enrol-gate treats `idle` as "already enrolled" and hides the way
    // back. So enrolment reported SUCCESS and the device then refused to sync
    // forever, with no surface offering a retry.
    //
    // Ordered before the token write so a device that cannot persist identity
    // never holds a token — the reverse order is exactly the state that cannot
    // recover itself.
    super::state::write_sync_state(io, &token_dir, &st)
        .await
        .map_err(|_| {
            tracing::warn!(
                stage = "write_sync_state",
                error_kind = "Internal",
                "device identity could not be persisted; failing enrolment rather than \
                 leaving a token with no identity"
            );
            SyncDeviceError::Internal
        })?;

    // The deferred token write (task 86) — see the closure for why it moved.
    if let Some(token) = stored_token {
        super::token_store::default_store()
            .store(io, &token_dir, &token)
            .await
            .map_err(|_| SyncDeviceError::Internal)?;
    }

    // Bootstrap upload (MYND-424): an approved device that just enrolled with an
    // existing, populated vault must push it WITHOUT waiting for a note edit.
    // `sync_enroll` itself does not author a head; the background loop only pushes
    // once a local change is signalled. Reuse that same coalesced-push trigger
    // (the SyncLocalChange counter note_create / note_update bump) so the loop's
    // next tick opens the coalescing window and runs an allow_push cycle. Safe re:
    // the resolution-blur side-channel — a one-shot bootstrap, not edit timing. A
    // pending (not-yet-approved) device is skipped: it cannot push and, as a
    // joining device, has no local vault to upload.
    // (The bootstrap-push signal itself is the caller's — see the doc.)

    Ok(EnrollResult {
        approved: outcome,
        device_id_hex,
    })
}

/// The ONE first-connect policy: validate the URL against the A4/TB5 rules,
/// then complete a CA-verified handshake through the same `RustlsTransport` and
/// the same Tor route every later request takes. Nothing is written on refusal.
///
/// It is here rather than inlined at each call site because there are two, and
/// they used to be two implementations: `sync_set_endpoint` walked the same
/// three steps in the opposite shape and mapped the identical server fault to
/// `SyncConfigError::Unreachable` where this one says `TlsFailure`, so a user
/// setting an endpoint in Settings and a user joining from a QR learned
/// different things from the same untrusted certificate. The error TYPE stays
/// each caller's, because the two commands' error enums are separate IPC
/// contracts; the POLICY and the transport are shared.
///
/// Native only. A browser's `fetch` verifies the chain itself and has no rustls
/// arm to ask, so the wasm arm refuses rather than pretending to probe, a
/// browser must not be treated as a client that skips verification.
#[cfg(not(target_arch = "wasm32"))]
pub async fn verify_join_tls(url: &str) -> Result<(), TransportError> {
    super::config::validate_endpoint_url(url).map_err(|_| TransportError::BadRequest)?;
    let Some((scheme, host, port)) = super::http_transport::parse_endpoint(url) else {
        return Err(TransportError::BadRequest);
    };
    if scheme != "https" {
        return Ok(()); // loopback http: no TLS
    }
    let probe = super::rustls_transport::RustlsTransport::new(host, port);
    // A join error is a transport error here, not a SyncDeviceError: the two
    // commands that probe share this policy and each maps it to its own enum.
    crate::task::run_blocking(move || probe.verify_endpoint())
        .await
        .map_err(|_| TransportError::Network)?
}

/// A join never reaches its own transport, so the probe is a bare refusal here.
#[cfg(target_arch = "wasm32")]
pub async fn verify_join_tls(_url: &str) -> Result<(), TransportError> {
    Err(TransportError::Network)
}

/// [`verify_join_tls`]'s outcome projected onto the join command's error enum.
/// The one place that mapping exists, for the reason the shared policy gives.
///
/// Target-INDEPENDENT on purpose, and the reason is the wasm build rather than
/// taste: [`verify_join_tls`] has an arm for each target but
/// `join_account_from_host` is not gated, so a `#[cfg]` on this helper alone
/// compiles for wasm and fails there with `cannot find value` — the exact
/// shape `core/AGENTS.md` records for a native-only item reaching a shared
/// caller. The wasm arm of the policy only ever answers `Network`, so the
/// mapping below simply carries that through.
fn join_tls_error(e: TransportError) -> SyncDeviceError {
    match e {
        TransportError::Tls => SyncDeviceError::TlsFailure,
        _ => SyncDeviceError::Transport,
    }
}

/// The two answers a CLIENT brings to the bootstrap — grouped rather than passed
/// loose, because they are one idea ("what kind of client is doing this") and
/// because they are the only two things that differ between the desktop and the
/// browser on this whole flow.
#[derive(Debug, Clone, Copy)]
pub struct JoinClient {
    /// The container to bootstrap into. Desktop MINTS one (a disk scan for
    /// collision-freedom, because it holds many vaults); the browser passes the
    /// constant `paths::web_single_vault_id()`, which is the registry collapse
    /// made explicit and what makes a re-run idempotent by construction.
    pub vault_id: crate::vault_id::VaultId,
    /// Whether this client must complete the CA-verified handshake itself
    /// before the join is allowed to persist the endpoint. True on native, false
    /// in a browser, where `fetch` performs the same verification and there is
    /// no rustls arm to ask.
    ///
    /// The field was `can_pin`, which asserted the opposite of what the flag
    /// does: both arms verify a certificate, they verify it with different
    /// stores. A reader of the old name would conclude the browser verifies
    /// nothing.
    pub native_tls: bool,
}

/// What the USER brings to the bootstrap — the counterpart to [`JoinClient`],
/// which carries what the *client* brings.
///
/// Grouped rather than passed loose because they are one idea ("which account,
/// on which server, proved how"), and because the fourth field arrived with
/// MYND-650 task 5 and would otherwise have pushed the join past the argument
/// count where a reader stops being able to tell which `String` is which.
pub struct JoinRequest {
    /// The sync server to join through. Validated against the A4/TB5 policy
    /// before anything reaches out.
    pub server_url: String,
    /// The account number, in either display or canonical form.
    pub account_number: String,
    /// The credential — the account password, or the 24-word recovery phrase
    /// when `credential_kind` is [`EnrollCredential::Recovery`]. Wrapped in
    /// `Zeroizing` on arrival either way. The field keeps its historical name
    /// because both wire callers send it as `password`.
    pub password: String,
    /// Which credential `password` carries (myne-md/myne#468, task 7).
    ///
    /// `Recovery` is the door for a user who has lost every device: nothing is
    /// left to approve a password join, so it would wait forever. The phrase is
    /// full account takeover in the server's own assessment
    /// (`internal/auth/enroll.go` self-approves `PathRecovery`), and that is the
    /// whole argument for letting it skip the approval gate. The variant, its
    /// `wire()` mapping and the server side all existed before this field; no
    /// production call site sent anything but `Password`.
    pub credential_kind: EnrollCredential,
    /// The retired out-of-band fingerprint argument, kept so the three clients'
    /// command signatures do not have to move. Always ignored: the join no
    /// longer accepts anything the user could paste here, and a value that used
    /// to be mandatory in Tor mode is now simply not consulted.
    pub confirmed_fingerprint: Option<String>,
}

/// Outcome of joining an existing account on a fresh device.
#[derive(Debug, Clone, Serialize)]
pub struct JoinResult {
    /// The new local vault's id — the frontend routes to its unlocked editor.
    pub vault_id: String,
    /// True when the device is pending approval by an existing device (the
    /// common password-path case); false if it was approved immediately.
    pub pending: bool,
    /// The retired cert-fingerprint IPC field. Always `None`.
    pub fingerprint: Option<String>,
    /// The freshly generated `device_id` (hex) this join registered (MYND-548) —
    /// same contract as [`EnrollResult::device_id_hex`]: the joining device is
    /// pending, so it cannot read the roster to learn which row is itself, and it
    /// needs the id to name itself in its own `vault.prefs`.
    pub device_id_hex: String,
    /// True when the join used the recovery phrase (myne-md/myne#468). The vault
    /// is then `Slot::Recovering`, not `Unlocked`, and the caller must route into
    /// the mandatory chained password reset (`recovery-flow.md` §4.1) — the same
    /// step a phrase recovery on an existing device ends in, for the same reason:
    /// a user who needed the phrase may not know the password.
    pub needs_password_reset: bool,
}

/// **Add this device to an existing account.** On a fresh device, bootstrap the
/// whole local vault from the server: verify the endpoint, fetch the account's
/// `vault.meta` pre-auth, derive `root_key` from `{account# + password}`, write
/// the meta to a NEW local vault + unlock it, then SCRAM-enroll (password →
/// **pending** until an existing device approves). No 24-word recovery. After
/// approval the background loop claims the token + pulls the account's notes.
///
/// `vault_id` is supplied by the CALLER, and that is where the two clients
/// genuinely differ (phase3-web-client task 85).
///
/// Desktop mints a fresh one through `vault_registry::mint_unique_vault_id`,
/// which is a disk scan for collision-freedom because a desktop holds many
/// vaults. A browser holds exactly one per origin, so it passes the constant
/// `paths::web_single_vault_id()` — the registry collapse made explicit rather
/// than letting that scan run over OPFS, where it would be both slower and
/// meaningless. Making it a parameter keeps this flow free of a capability flag:
/// the RULE (fetch, write, unlock, enrol) is shared; the choice of container is
/// the client's.
///
/// Because the browser's id is a constant, re-running this is idempotent by
/// construction — "never mints a second container" holds without a check.
/// Write the fetched `vault.meta` into a first-run container, or decide what an
/// existing one means (phase3-web-client task 85).
///
/// Split out of [`join_account_from_host`] because it is the whole of the
/// idempotence criterion and it is the only part of the join that can be tested
/// without a server: everything above it is a network fetch and everything below
/// is an unlock plus a SCRAM handshake.
///
/// # The three outcomes
///
/// * **Nothing there** → write it. The ordinary first run.
/// * **A meta for the SAME account** → leave it alone and return `Ok`, so the
///   caller falls through to unlock + enrol. On the browser's constant vault id
///   this is the ordinary SECOND run — a reload, a re-auth after the token
///   expired, a user re-entering their number — and failing it would make
///   signing in again impossible. Note the local copy is deliberately preferred
///   even when it differs byte-wise from the server's: a password change on
///   another device rewrites `vault.meta`, so the local one may legitimately be
///   the newer, and the sync meta phase is what reconciles them. A bootstrap
///   must not adjudicate that by overwriting.
/// * **A meta for a DIFFERENT account** → [`SyncDeviceError::AccountMismatch`].
///   Proceeding would unlock (or fail to unlock) someone else's vault while the
///   user believes they signed into theirs, and the remedy is not a retype: the
///   container has to be erased first.
///
/// The create-only write is what makes the first two safe — the decision below
/// is reached only after the write has already declined to clobber anything.
/// "Already there" is separated from a genuine IO failure by asking (`exists`)
/// rather than by widening the closed `IoFailureKind` enum, the same shape
/// `note_create` uses for its create-new refusal.
pub(crate) async fn write_bootstrap_meta(
    io: &dyn crate::vault_io::VaultIo,
    meta_path: &std::path::Path,
    meta_bytes: &[u8],
    account_hash: &[u8; 16],
) -> Result<(), SyncDeviceError> {
    let Err(kind) = io
        .write(
            meta_path,
            meta_bytes,
            crate::vault_io::WriteOpts {
                replace: false,
                ..Default::default()
            },
        )
        .await
    else {
        return Ok(());
    };
    if !io.exists(meta_path).await.unwrap_or(false) {
        tracing::error!(
            stage = "meta_write",
            io_failure_kind = ?kind,
            "join_account: vault.meta write failed"
        );
        return Err(SyncDeviceError::Internal);
    }
    let local = io
        .read(meta_path)
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let Ok(local_meta) = parse_vault_meta_any(&local) else {
        // Rubble, not "a newer local meta". On a double-buffered store the seam
        // has already fallen back to the older copy, so reaching here means BOTH
        // are unusable — and there is nothing in that worth preserving.
        //
        // This arm is what stops a loop, and the loop is reachable: boot routing
        // sends a web `Corrupted` here (`initialStageFromProbe`, task 85),
        // because a corrupt local container on a client whose vault lives on the
        // server is a re-bootstrap rather than data loss. Refusing would send
        // the user back to the same screen that sent them, forever.
        //
        // Native clients never take this arm — a desktop join mints a fresh
        // vault id and so never meets an existing meta at all. It exists for the
        // one client that pins a container to a constant id.
        tracing::warn!(
            stage = "meta_write",
            event = "replacing_unparseable_meta",
            "join_account: the local vault.meta does not parse; replacing it with the server's"
        );
        io.write(
            meta_path,
            meta_bytes,
            crate::vault_io::WriteOpts::default(), // replace: true
        )
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
        return Ok(());
    };
    if &local_meta.account_number_hash != account_hash {
        tracing::warn!(
            stage = "meta_write",
            event = "account_mismatch",
            "join_account refused: this container already holds a different account"
        );
        return Err(SyncDeviceError::AccountMismatch);
    }
    tracing::info!(
        stage = "meta_write",
        event = "already_bootstrapped",
        "join_account: container exists for this account; re-authenticating"
    );
    Ok(())
}

/// Everything that must be true of a server-supplied `vault.meta` BEFORE a byte
/// of it is written (myne#297).
///
/// `parse_vault_meta` deliberately does not range-check `kdf_params` — the
/// protocol defers that to the derivation site. So a structurally valid meta
/// with out-of-policy parameters parsed fine, was persisted, and only then met
/// `validate_kdf_params` inside the unlock, which refused it.
///
/// On the web that is durable and self-trapping. The container reports `Exists`
/// on presence alone, so after any reload the client routes to Unlock rather
/// than back to the join screen; the unlock returns `InvalidVaultMeta`, the
/// corrupted surface renders, and its only CTA is a reload that lands on the
/// same screen. The join flow that would overwrite the poisoned copy is no
/// longer reachable — even once the server behaves. Desktop is milder but not
/// clean: it mints a fresh id per attempt, so each failed join leaves an orphan
/// container the picker lists as a normal vault and that can never open.
///
/// **The write ORDER is the whole protection here**, because
/// `write_bootstrap_meta`'s create-only guard and its account-hash arm are both
/// inert in the browser: the container write ignores `replace: false`. So the
/// account check lives here rather than only there — without it a second
/// account's meta silently overwrites the resident one, beside the FIRST
/// account's `notes/`.
///
/// The sibling enrol path already validates immediately after parsing and says
/// why ("a hostile server could pin an absurd `m_kib` … the sync enroll path was
/// the one gap"); this is the other half of that gap.
fn validate_fetched_meta(
    meta_bytes: &[u8],
    account_hash: &[u8; 16],
) -> Result<(), SyncDeviceError> {
    let meta = parse_vault_meta_any(meta_bytes).map_err(|_| SyncDeviceError::Internal)?;
    validate_kdf_params(&meta.kdf_params).map_err(|_| SyncDeviceError::BadRequest)?;
    if &meta.account_number_hash != account_hash {
        return Err(SyncDeviceError::BadRequest);
    }
    Ok(())
}

pub async fn join_account_from_host(
    host: &dyn crate::host::HostCtx,
    io: &'static dyn crate::vault_io::VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
    client: JoinClient,
    request: JoinRequest,
) -> Result<JoinResult, SyncDeviceError> {
    let JoinClient {
        vault_id,
        native_tls,
    } = client;
    let JoinRequest {
        server_url,
        account_number,
        password,
        confirmed_fingerprint: _,
        credential_kind,
    } = request;
    let password = Zeroizing::new(password);

    // 1. Verify the endpoint's certificate before anything persists it.
    //
    // The probe is the same `RustlsTransport` and the same Tor route every later
    // sync request takes, so a join cannot succeed against an endpoint this
    // device would then refuse to talk to. A browser has no rustls arm and its
    // `fetch` verifies on its own, so it skips the probe rather than being
    // treated as a client that skips verification.
    if native_tls {
        verify_join_tls(&server_url).await.map_err(join_tls_error)?;
    }
    // `None`, read from the retired wire field: `set_endpoint` hardcodes it, so
    // binding the value directly says so rather than chaining a read that can
    // only produce one thing.
    let fingerprint: Option<String> = None;
    // The join path targets an account that already exists, so no invite code is
    // involved: the gate is consulted only on new-account registration.
    super::config::set_endpoint(host, io, Some(server_url), None, None)
        .await
        .map_err(|_| SyncDeviceError::NotConfigured)?;
    let cfg = super::config::read_config(
        io,
        &super::config::config_path_from_host(host, io)
            .await
            .map_err(|_| SyncDeviceError::Internal)?,
    )
    .await
    .map_err(|_| SyncDeviceError::NotConfigured)?;
    let url = cfg.endpoint_url.ok_or(SyncDeviceError::NotConfigured)?;

    let account =
        parse_account_number(account_number.trim()).map_err(|_| SyncDeviceError::BadRequest)?;
    let account_hash = account.hash;
    let acct_hex = {
        let mut s = String::with_capacity(32);
        for b in &account_hash {
            s.push_str(&format!("{b:02x}"));
        }
        s
    };

    // 2. Fetch the account's vault.meta pre-auth (AEAD-protected — useless
    //    without the credential, the accepted A4-equivalent exposure).
    let url_fetch = url.clone();
    let acct_q = acct_hex.clone();
    let meta_bytes: Vec<u8> =
        crate::task::run_blocking(move || -> Result<Vec<u8>, SyncDeviceError> {
            let transport = super::http_transport::build_transport(&url_fetch)
                .map_err(|_| SyncDeviceError::Transport)?;
            let resp = transport
                .request(
                    super::transport::HttpMethod::Get,
                    &format!("/vault.meta?account={acct_q}"),
                    &[],
                    None,
                )
                .map_err(|_| SyncDeviceError::Transport)?;
            if resp.status != 200 {
                return Err(SyncDeviceError::DeviceNotFound); // no such account seeded
            }
            Ok(resp.body)
        })
        .await
        .map_err(|_| SyncDeviceError::Internal)??;
    // Validate BEFORE anything is written (myne#297).
    //
    // `parse_vault_meta` deliberately does not range-check `kdf_params` — the
    // protocol defers that to the derivation site. So a structurally valid meta
    // with out-of-policy parameters parsed fine here, was PERSISTED on the next
    // few lines, and only then met `validate_kdf_params` inside the unlock,
    // which refused it.
    //
    // On the web that is durable and self-trapping. The container reports
    // `Exists` on presence alone, so after any reload the client routes to
    // Unlock rather than back to the join screen; the unlock returns
    // `InvalidVaultMeta`, the corrupted surface renders, and its only CTA is a
    // reload that lands on the same screen. The join flow that would overwrite
    // the poisoned copy is no longer reachable, even once the server behaves.
    // The write-order IS the protection: `write_bootstrap_meta`'s create-only
    // guard and its account-hash arm are inert in the browser, because the
    // container write ignores `replace: false` — so nothing between the fetch
    // and the write inspects the bytes at all. Desktop is milder but not clean:
    // it mints a fresh id per attempt, so each failed join leaves an orphan
    // container the picker lists as a normal vault and that can never open.
    //
    // The sibling enrol path already does exactly this and says why ("a hostile
    // server could pin an absurd `m_kib` … the sync enroll path was the one
    // gap"). This is the other half of that gap.
    validate_fetched_meta(&meta_bytes, &account_hash)?;

    // 3. Mint a fresh local vault, write the fetched meta, and UNLOCK it (the
    //    normal password-unlock path derives root_key + items_key).
    let vault_dir = crate::paths::vault_dir_for_id_from_host_io(host, io, Some(vault_id))
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    let meta_path = vault_dir.join("vault.meta");
    // Through the SEAM, which on a browser means through the double-buffered
    // container — `vault.meta` is in `DOUBLE_BUFFERED`, so task 85's "written
    // through the double-buffered path, byte-identical to the server copy"
    // criterion is satisfied by routing rather than by a second write path.
    //
    // `replace: false` keeps the create-only guard: a bootstrap that finds a
    // meta already there must not overwrite it. On the browser's constant vault
    // id that is what makes a re-run idempotent — a second run cannot clobber
    // the container the first one made, and cannot mint a second one either
    // (there is only one id).
    //
    // What a create-only refusal means, and why it is not an error: on the
    // browser's constant id, "a meta is already here" is the ORDINARY second
    // run — a reload, a re-auth after the token expired, a user re-entering
    // their number. Task 85 asks for a re-run that "re-authenticates, never
    // mints a second container or overwrites a newer local meta", so the refusal
    // has to fall through to the unlock + enrol below rather than fail the join.
    //
    // The one case that must NOT fall through is a DIFFERENT account. The local
    // meta binds `account_number_hash`; if it is not the account just typed,
    // this browser is holding someone else's vault, and proceeding would unlock
    // (or fail to unlock) the wrong one while the user believes they signed into
    // theirs. That gets its own refusal, because the remedy is different: erase
    // this browser's copy first (task 72), not "try your password again".
    //
    // A meta for the SAME account that differs byte-wise is fine and is left
    // alone — a password change on another device rewrites `vault.meta`, and the
    // local copy may legitimately be the newer of the two. The sync meta phase
    // reconciles them; a bootstrap must not adjudicate it by overwriting.
    write_bootstrap_meta(io, &meta_path, &meta_bytes, &account_hash).await?;
    let opened = open_joined_vault(
        credential_kind,
        (*password).clone(),
        vault_id,
        &meta_path,
        state,
        host,
        io,
    )
    .await?;
    let JoinedVault {
        root_key,
        path: enroll_path,
        needs_password_reset,
    } = opened;

    // 4. Register the verifier + SCRAM enroll. The SCRAM secret is re-derived
    //    from the root_key the credential opened (no credential reuse); only the
    //    wire PATH differs, and it is what decides approval server-side.
    let approved =
        crate::task::run_blocking(move || -> Result<EnrollmentOutcome, SyncDeviceError> {
            let transport = super::http_transport::build_transport(&url)
                .map_err(|_| SyncDeviceError::Transport)?;
            let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
            register_verifier(transport.as_ref(), &account_hash, secret.as_slice())
                .map_err(|_| SyncDeviceError::Transport)?;
            let device_id = generate_device_id();
            let mut nonce = [0u8; 16];
            getrandom::getrandom(&mut nonce).map_err(|_| SyncDeviceError::Internal)?;
            let mut client_nonce = String::with_capacity(32);
            for b in &nonce {
                client_nonce.push_str(&format!("{b:02x}"));
            }
            let out = enroll(
                transport.as_ref(),
                &account_hash,
                secret.as_slice(),
                enroll_path,
                &client_nonce,
                device_id,
            )
            // #268: preserve the server's reason instead of flattening every
            // refusal into "credentials incorrect".
            .map_err(SyncDeviceError::from)?;

            // Identity persistence is deferred to the async caller (task 86) —
            // `state.rs` is on the storage seam and the seam is async, while
            // this closure runs on the blocking pool. Only the `dev_hex`
            // formatting stays.
            let mut dev_hex = String::with_capacity(32);
            for b in &device_id {
                dev_hex.push_str(&format!("{b:02x}"));
            }
            // Token write deferred too (task 86) — see `EnrollmentOutcome`.
            let stored_token = if out.approved && !out.token.is_empty() {
                Some(out.token)
            } else {
                None
            };
            Ok((out.approved, dev_hex, stored_token, vault_dir))
        })
        .await
        .map_err(|_| SyncDeviceError::Internal)??;

    let (approved, device_id_hex, stored_token, token_dir) = approved;

    // The deferred identity persistence. Written ALWAYS — even when pending —
    // so the loop can claim the token once an existing device approves.
    // Same rule as the enrolment path: a read-modify-write must not default over
    // an unreadable file, or it erases the cursor, the CAS baselines and
    // `meta_baseline_hex` in one step (task 86).
    let mut st = super::state::read_sync_state(io, &token_dir)
        .await
        .map_err(|_| {
            tracing::error!(
                stage = "read_sync_state",
                error_kind = "Internal",
                "sync-state.json unreadable; refusing to overwrite it with a fresh identity"
            );
            SyncDeviceError::Internal
        })?;
    st.account_hash_hex = Some(acct_hex);
    st.device_id_hex = Some(device_id_hex.clone());
    // #267 — the join path's byte-identical twin of the discard above. Same
    // ordering, same reason: identity first, token only if it landed.
    super::state::write_sync_state(io, &token_dir, &st)
        .await
        .map_err(|_| {
            tracing::warn!(
                stage = "write_sync_state",
                error_kind = "Internal",
                "device identity could not be persisted; failing the join rather than \
                 leaving a token with no identity"
            );
            SyncDeviceError::Internal
        })?;

    if let Some(token) = stored_token {
        super::token_store::default_store()
            .store(io, &token_dir, &token)
            .await
            .map_err(|_| SyncDeviceError::Internal)?;
    }

    Ok(JoinResult {
        vault_id: vault_id.to_string(),
        pending: !approved,
        fingerprint,
        device_id_hex,
        needs_password_reset,
    })
}

/// What opening the freshly bootstrapped vault produced.
pub(crate) struct JoinedVault {
    /// The key the SCRAM secret derives from. The same `root_key` whichever
    /// credential opened it — `vault.meta` wraps one key twice.
    pub root_key: Zeroizing<[u8; protocol::AEAD_KEY_LEN]>,
    /// The wire path the enrolment sends, and the thing the server approves on.
    pub path: EnrollPath,
    /// True when the vault is `Slot::Recovering` and the chained password reset
    /// is owed before it can be used.
    pub needs_password_reset: bool,
}

/// Open the bootstrapped vault with the credential the user gave, and pick the
/// enrolment path that credential earns (myne-md/myne#468, task 7).
///
/// Split out of [`join_account_from_host`] so the call-site decision — which
/// wire path a join sends — is testable without a server. The join itself is a
/// network fetch; this half is not, and it is the half a regression would hit:
/// every production caller sent `EnrollPath::Password` until this existed, so a
/// "recovery" join that quietly fell back to it would sit pending forever on
/// exactly the device that has nobody to approve it.
///
/// - `Password` → the ordinary unlock; `Slot::Unlocked`; path `Password`, which
///   the server holds pending until an existing device approves.
/// - `Recovery` → the SAME code the recovery flow runs
///   (`recover_with_phrase_with_path`), so the phrase is normalised, derived and
///   checked exactly as it is there; `Slot::Recovering`; path `Recovery`, which
///   the server self-approves. The password reset that follows is the recovery
///   flow's own mandatory chained step, reached by the caller's reprobe.
///
/// Every credential failure maps to `BadRequest`, the join's single
/// non-distinguishing refusal: a wrong account number, a wrong password and a
/// wrong phrase must read the same.
pub(crate) async fn open_joined_vault(
    kind: EnrollCredential,
    credential: String,
    vault_id: crate::vault_id::VaultId,
    meta_path: &std::path::Path,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<JoinedVault, SyncDeviceError> {
    match kind {
        EnrollCredential::Password => {
            crate::plugins::vault_unlock::commands::unlock_with_path(
                credential,
                Some(vault_id),
                meta_path,
                state,
                io,
                host,
            )
            .await
            .map_err(|_| SyncDeviceError::BadRequest)?;
            let root_key = state
                .peek_unlocked_root_key_clone()
                .await
                .ok_or(SyncDeviceError::Internal)?;
            Ok(JoinedVault {
                root_key,
                path: EnrollPath::Password,
                needs_password_reset: false,
            })
        }
        EnrollCredential::Recovery => {
            crate::plugins::vault_recover::commands::recover_with_phrase_with_path(
                credential,
                Some(vault_id),
                meta_path,
                state,
                host,
                io,
            )
            .await
            .map_err(|_| SyncDeviceError::BadRequest)?;
            let root_key = state
                .peek_recovering_root_key_clone()
                .await
                .ok_or(SyncDeviceError::Internal)?;
            Ok(JoinedVault {
                root_key,
                path: EnrollPath::Recovery,
                needs_password_reset: true,
            })
        }
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tls_enrollment_tests {
    use super::super::rustls_transport::tests::spawn_tls_server;
    use super::super::transport::TransportError;
    use super::{join_tls_error, verify_join_tls};

    /// A private test CA is not a public CA. The join must stop before it writes
    /// an endpoint, even on the first connection.
    #[test]
    fn first_connection_refuses_an_untrusted_certificate() {
        let port = spawn_tls_server(1);
        let url = format!("https://localhost:{port}");
        let out = crate::test_support::block_on(verify_join_tls(&url));
        // Asserted through the projection each caller uses, so the test fails if
        // the shared policy ever stops distinguishing a certificate refusal from
        // a network fault, the distinction the whole native join rests on.
        assert!(matches!(
            join_tls_error(TransportError::Tls),
            super::SyncDeviceError::TlsFailure
        ));
        assert_eq!(out, Err(TransportError::Tls));
    }

    #[test]
    fn a_loopback_http_endpoint_needs_no_tls_handshake() {
        let out = crate::test_support::block_on(verify_join_tls("http://127.0.0.1:8080"));
        assert_eq!(out, Ok(()));
    }
}

/// The exporter parameters, asserted against the published cross-implementation
/// vector rather than against the comment in the other repository.
///
/// `TLS_EXPORTER_LABEL` and `TLS_EXPORTER_LEN` are one half of a pair whose
/// other half is the Go server's `scram.ExporterLabel` / `ExporterLen`. Both
/// were commented FROZEN and both said the other must match byte-for-byte,
/// with nothing checking either — and a third copy of the literal had already
/// appeared in a transport test that only asserts an `Err`, so it would not
/// have noticed a drifted value. A divergence is not a degraded handshake:
/// each side derives different channel-binding data, the client proof fails,
/// and no `-PLUS` handshake completes.
///
/// Skip-if-missing: the companion repo is cloned separately.
#[cfg(test)]
mod tls_exporter_vectors {
    use super::{TLS_EXPORTER_LABEL, TLS_EXPORTER_LEN};

    #[test]
    fn exporter_parameters_match_the_published_vector() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../myne-test-vectors/vectors/tls-exporter/v0.1/cases.json");
        let Ok(raw) = std::fs::read_to_string(&path) else {
            eprintln!("[skip] tls-exporter vectors absent at {}", path.display());
            return;
        };

        // Hand-parsed rather than serde-derived: this crate has no test-only
        // JSON model for the companion, and the case shape is two fields.
        let label_hex = field(&raw, "expected_label_utf8_hex");
        let length = field(&raw, "expected_length");

        let want_label: Vec<u8> = (0..label_hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&label_hex[i..i + 2], 16).expect("vector carries hex"))
            .collect();

        // Compared as BYTES, which is how the TLS stack compares the label and
        // why the vector carries hex rather than a bare string.
        assert_eq!(
            TLS_EXPORTER_LABEL,
            &want_label[..],
            "TLS_EXPORTER_LABEL has drifted from the published vector"
        );
        assert_eq!(
            TLS_EXPORTER_LEN,
            length.parse::<usize>().expect("vector carries an integer"),
            "TLS_EXPORTER_LEN has drifted from the published vector"
        );
    }

    /// Pull one JSON scalar out of the single-case document by key. Deliberately
    /// blunt — it panics rather than returning an Option, because a shape change
    /// in the companion must fail the test loudly, not skip it.
    fn field<'a>(doc: &'a str, key: &str) -> &'a str {
        let needle = alloc_key(key);
        let start = doc.find(&needle).expect("vector is missing a required key") + needle.len();
        let rest = doc[start..].trim_start();
        let rest = rest
            .strip_prefix(':')
            .expect("malformed vector")
            .trim_start();
        if let Some(inner) = rest.strip_prefix('"') {
            let end = inner.find('"').expect("unterminated string");
            &inner[..end]
        } else {
            let end = rest.find([',', '\n', '}']).expect("unterminated number");
            rest[..end].trim()
        }
    }

    fn alloc_key(key: &str) -> String {
        let mut s = String::with_capacity(key.len() + 2);
        s.push('"');
        s.push_str(key);
        s.push('"');
        s
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod join_credential_tests {
    //! Which enrolment path a JOIN sends (myne-md/myne#468, task 7).
    //!
    //! Every production join sent `EnrollPath::Password` until this change, so
    //! the regression worth fearing is a phrase join that quietly falls back to
    //! it: that device then sits pending forever, and it is exactly the device
    //! with nobody left to approve it. The server decides approval on the wire
    //! path alone, so the wire value is what these assert.

    use super::{open_joined_vault, EnrollCredential, SyncDeviceError};
    use crate::plugins::vault_creation::commands::{build_and_serialize_vault_meta, build_session};
    use crate::plugins::vault_unlock::state::{SlotKind, VaultRuntimeState};
    use crate::test_support::{block_on, ScratchVault, FAST_TEST_KDF};

    const PASSWORD: &str = "join-test-password";

    /// A real `vault.meta` on disk, plus the root key and phrase it wraps.
    fn seeded() -> (ScratchVault, crate::vault_id::VaultId, [u8; 32], String) {
        let id = crate::vault_id::VaultId::mint();
        let session = build_session(id, PASSWORD, FAST_TEST_KDF).expect("build_session");
        let root: [u8; 32] = *session.root_key;
        let phrase = (*session.phrase.join_normalized()).to_string();
        let bytes = build_and_serialize_vault_meta(&session).expect("serialize");
        let scratch = ScratchVault::new("join_credential");
        scratch.write_meta(&bytes);
        (scratch, id, root, phrase)
    }

    #[test]
    fn a_password_join_sends_the_password_path_and_unlocks() {
        let (scratch, id, root, _phrase) = seeded();
        let state = VaultRuntimeState::default();
        let out = block_on(open_joined_vault(
            EnrollCredential::Password,
            PASSWORD.to_string(),
            id,
            scratch.path(),
            &state,
            &crate::host::NoopHost,
            &crate::vault_io::StdVaultIo,
        ))
        .unwrap_or_else(|_| panic!("password join failed"));
        assert_eq!(out.path.wire(), "password");
        assert!(!out.needs_password_reset);
        assert_eq!(*out.root_key, root);
        assert_eq!(block_on(state.slot_kind(id)), SlotKind::Unlocked);
    }

    #[test]
    fn a_phrase_join_sends_the_recovery_path_and_owes_a_password_reset() {
        let (scratch, id, root, phrase) = seeded();
        let state = VaultRuntimeState::default();
        let out = block_on(open_joined_vault(
            EnrollCredential::Recovery,
            phrase,
            id,
            scratch.path(),
            &state,
            &crate::host::NoopHost,
            &crate::vault_io::StdVaultIo,
        ))
        .unwrap_or_else(|_| panic!("phrase join failed"));
        // THE assertion: the server self-approves on this string and nothing
        // else, so a phrase join sending "password" would wait forever.
        assert_eq!(
            out.path.wire(),
            "recovery",
            "a phrase join sent the password path"
        );
        assert!(
            out.needs_password_reset,
            "a phrase join skipped the password reset"
        );
        // Same key either way — `vault.meta` wraps one `root_key` twice — so the
        // SCRAM secret matches the one the account registered.
        assert_eq!(*out.root_key, root);
        // Recovering, not Unlocked: the chained reset (`recovery-flow.md` §4.1)
        // is what the caller routes into next.
        assert_eq!(block_on(state.slot_kind(id)), SlotKind::Recovering);
    }

    #[test]
    fn a_wrong_phrase_is_the_same_refusal_as_a_wrong_password() {
        let (scratch, id, _root, _phrase) = seeded();
        let (_other, _oid, _oroot, other_phrase) = seeded();
        for (kind, credential) in [
            (EnrollCredential::Recovery, other_phrase),
            (EnrollCredential::Password, "not-the-password".to_string()),
        ] {
            let state = VaultRuntimeState::default();
            let err = block_on(open_joined_vault(
                kind,
                credential,
                id,
                scratch.path(),
                &state,
                &crate::host::NoopHost,
                &crate::vault_io::StdVaultIo,
            ))
            .err()
            .expect("a wrong credential opened the vault");
            assert!(
                matches!(err, SyncDeviceError::BadRequest),
                "the join's refusal must not distinguish which credential was wrong"
            );
            assert_eq!(block_on(state.slot_kind(id)), SlotKind::Empty);
        }
    }
}
