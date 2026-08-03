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
    aad_password_wrap, aad_recovery_wrap, aead_open_ctx, derive_password_wrap_key,
    derive_recovery_wrap_key_from_normalized, derive_subkey, normalize_user_phrase,
    parse_account_number, parse_vault_meta, validate_kdf_params, SubkeyRole, AEAD_KEY_LEN,
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
    // AS9 username (see module doc): hex(account_hash), used for both wire fields.
    let account_hash_hex = hex_encode(account_hash);
    let mut salt = [0u8; 16];
    getrandom::getrandom(&mut salt).map_err(|_| EnrollError::BadResponse)?;
    let iterations = SCRAM_REGISTER_ITERATIONS;
    let v = scram_client_proof(secret, &salt, iterations, &account_hash_hex, "", "", &[]);
    let body = serde_json::to_vec(&RegisterReq {
        account_hash_hex: &account_hash_hex,
        username: &account_hash_hex,
        salt_hex: &hex_encode(&salt),
        iterations,
        stored_key_hex: &hex_encode(&v.stored_key),
        server_key_hex: &hex_encode(&v.server_key),
    })
    .map_err(|_| EnrollError::BadResponse)?;
    let resp = transport.request(HttpMethod::Post, "/auth/register", &body, None)?;
    match resp.status {
        200 | 409 => Ok(()), // 409 already_registered → idempotent success
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

    use super::write_bootstrap_meta;
    use crate::plugins::sync::devices::SyncDeviceError;
    use crate::plugins::vault_creation::commands::{build_and_serialize_vault_meta, build_session};
    use crate::test_support::{ScopedTempDir, FAST_TEST_KDF};
    use crate::vault_io::{StdVaultIo, VaultIo};
    use protocol::parse_vault_meta;

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
        let hash = parse_vault_meta(&bytes).expect("parse").account_number_hash;
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
            let parsed = parse_vault_meta(&bytes).unwrap();
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
    let pins = super::config::config_pins(&cfg);
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

    // The SCRAM username is derived inside `enroll` as the account-hash hex —
    // the display-form account number never crosses the wire (AS9).
    let outcome =
        crate::task::run_blocking(move || -> Result<EnrollmentOutcome, SyncDeviceError> {
            let transport = super::http_transport::build_transport(&url, pins)
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
            let meta = parse_vault_meta(&meta_bytes).map_err(|_| SyncDeviceError::Internal)?;
            // The `vault.meta` came from the (untrusted, TB5) sync server, so its
            // `kdf_params` are attacker-controlled. Validate the Argon2id memory/time
            // floor+ceiling BEFORE deriving — otherwise a hostile server could pin an
            // absurd `m_kib` (e.g. multi-TiB) and force a pre-auth OOM/DoS. Every
            // other derive site (unlock / recover / change-password / quick-unlock)
            // already gates on this; the sync enroll path was the one gap.
            validate_kdf_params(&meta.kdf_params).map_err(|_| SyncDeviceError::BadRequest)?;

            // 2. Derive root_key from the credential + the meta salts.
            let root_key: Zeroizing<[u8; AEAD_KEY_LEN]> = match path {
                EnrollPath::Password => {
                    let wrap = derive_password_wrap_key(
                        &credential,
                        &meta.random_salt_password,
                        &meta.account_number_hash,
                        &meta.kdf_params,
                    )
                    .map_err(|_| SyncDeviceError::BadRequest)?;
                    let opened = aead_open_ctx(
                        &wrap,
                        &meta.nonce_password_wrap,
                        &meta.enc_root_key_password,
                        &aad_password_wrap(&meta.kdf_params),
                    )
                    .map_err(|_| SyncDeviceError::BadRequest)?;
                    let mut rk = Zeroizing::new([0u8; AEAD_KEY_LEN]);
                    if opened.len() != AEAD_KEY_LEN {
                        return Err(SyncDeviceError::Internal);
                    }
                    rk.copy_from_slice(&opened);
                    rk
                }
                EnrollPath::Recovery => {
                    let normalized = normalize_user_phrase(&credential);
                    let wrap = derive_recovery_wrap_key_from_normalized(
                        normalized.as_str(),
                        &meta.random_salt_recovery,
                        &meta.account_number_hash,
                        &meta.kdf_params,
                    )
                    .map_err(|_| SyncDeviceError::BadRequest)?;
                    let opened = aead_open_ctx(
                        &wrap,
                        &meta.nonce_recovery_wrap,
                        &meta.enc_root_key_recovery,
                        &aad_recovery_wrap(&meta.kdf_params),
                    )
                    .map_err(|_| SyncDeviceError::BadRequest)?;
                    let mut rk = Zeroizing::new([0u8; AEAD_KEY_LEN]);
                    if opened.len() != AEAD_KEY_LEN {
                        return Err(SyncDeviceError::Internal);
                    }
                    rk.copy_from_slice(&opened);
                    rk
                }
            };

            // 3. ServerAuth secret.
            let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);

            // 4. Register the SCRAM verifier (idempotent — a 409 already_registered
            //    is success; the first device's stored salt is what every later
            //    handshake reuses). Keyed on the canonical `account.hash` (the same
            //    value the server namespaces on), so register + enroll agree.
            register_verifier(transport.as_ref(), &account.hash, secret.as_slice())
                .map_err(|_| SyncDeviceError::Transport)?;

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

/// Acquire a TOFU pin for an `https` endpoint by reaching the server once.
///
/// Host-only by nature: it completes a TLS handshake over the raw-TLS transport
/// and reads the leaf certificate. A page never sees one, which is why the
/// browser arm passes `can_pin: false` and gets `None` here without calling it.
///
/// Goes through [`super::pin_confirm::capture_pin`] rather than reaching for
/// `tofu_fetch_pin` itself (MYND-650 task 5): in Tor mode the handshake travels
/// through an exit node, and an exit node can serve its own certificate to a
/// client that has agreed to accept any. `confirmed_fingerprint` is the value
/// the user obtained out-of-band; it is required there and optional on the
/// clearnet.
#[cfg(not(target_arch = "wasm32"))]
async fn acquire_tofu_pin(
    url: &str,
    confirmed_fingerprint: Option<&str>,
) -> Result<Option<String>, SyncDeviceError> {
    super::config::validate_endpoint_url(url).map_err(|_| SyncDeviceError::NotConfigured)?;
    let Some((scheme, host, port)) = super::http_transport::parse_endpoint(url) else {
        return Err(SyncDeviceError::NotConfigured);
    };
    if scheme != "https" {
        return Ok(None); // loopback http: no TLS, nothing to pin
    }
    let pin = super::pin_confirm::capture_pin(host, port, confirmed_fingerprint)
        .await
        .map_err(SyncDeviceError::from)?;
    Ok(Some(pin))
}

/// The `wasm32` arm exists only so the `can_pin: true` branch has a body to
/// compile against; it is unreachable, because the browser always passes
/// `can_pin: false`. It refuses rather than returning `None` so a future caller
/// that flipped the flag would fail loudly instead of silently unpinned.
#[cfg(target_arch = "wasm32")]
async fn acquire_tofu_pin(
    _url: &str,
    _confirmed_fingerprint: Option<&str>,
) -> Result<Option<String>, SyncDeviceError> {
    Err(SyncDeviceError::Transport)
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
    /// Whether this client can TOFU-pin the server's certificate. False in a
    /// browser: a page never sees the leaf cert, so the result reports
    /// `PinSource::PlatformTrustStore` instead of an empty pin.
    pub can_pin: bool,
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
    /// The account password — wrapped in `Zeroizing` on arrival.
    pub password: String,
    /// The server-certificate fingerprint the user obtained **out-of-band**,
    /// or `None`.
    ///
    /// Optional on the clearnet (the shipped TOFU bargain: first connect on
    /// faith, eye-compare after) and **mandatory in Tor mode**, where the
    /// accept-any-certificate first handshake travels through an exit node
    /// that can serve its own — see [`super::pin_confirm`]. A value that does
    /// not match what the server serves aborts the join with nothing written.
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
    /// The server cert fingerprint (https) for eye-compare, or `null` (loopback).
    pub fingerprint: Option<String>,
    /// The freshly generated `device_id` (hex) this join registered (MYND-548) —
    /// same contract as [`EnrollResult::device_id_hex`]: the joining device is
    /// pending, so it cannot read the roster to learn which row is itself, and it
    /// needs the id to name itself in its own `vault.prefs`.
    pub device_id_hex: String,
}

/// **Add this device to an existing account.** On a fresh device, bootstrap the
/// whole local vault from the server: TOFU-pin the endpoint, fetch the account's
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
async fn write_bootstrap_meta(
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
    let Ok(local_meta) = parse_vault_meta(&local) else {
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

pub async fn join_account_from_host(
    host: &dyn crate::host::HostCtx,
    io: &'static dyn crate::vault_io::VaultIo,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
    client: JoinClient,
    request: JoinRequest,
) -> Result<JoinResult, SyncDeviceError> {
    let JoinClient { vault_id, can_pin } = client;
    let JoinRequest {
        server_url,
        account_number,
        password,
        confirmed_fingerprint,
    } = request;
    let password = Zeroizing::new(password);

    // 1. Set + TOFU-pin the endpoint (https) before any transport use.
    //
    // The pin itself is the caller's to acquire — it needs a TLS handshake and
    // the leaf certificate, which a browser cannot see. `can_pin` decides what
    // the RESULT reports, so a browser's `fingerprint` is `None` with
    // `PinSource::PlatformTrustStore` rather than an empty pin that reads as
    // unverified. Task 85's criterion asks for exactly that typed answer.
    let cert_pin_hex = if can_pin {
        acquire_tofu_pin(&server_url, confirmed_fingerprint.as_deref()).await?
    } else {
        None
    };
    let fingerprint =
        super::config::set_endpoint(host, io, Some(server_url), cert_pin_hex, can_pin)
            .await
            .map_err(|_| SyncDeviceError::NotConfigured)?
            .fingerprint;
    let cfg = super::config::read_config(
        io,
        &super::config::config_path_from_host(host, io)
            .await
            .map_err(|_| SyncDeviceError::Internal)?,
    )
    .await
    .map_err(|_| SyncDeviceError::NotConfigured)?;
    let pins = super::config::config_pins(&cfg);
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
    let pins_fetch = pins.clone();
    let acct_q = acct_hex.clone();
    let meta_bytes: Vec<u8> =
        crate::task::run_blocking(move || -> Result<Vec<u8>, SyncDeviceError> {
            let transport = super::http_transport::build_transport(&url_fetch, pins_fetch)
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
    parse_vault_meta(&meta_bytes).map_err(|_| SyncDeviceError::Internal)?; // must be real meta

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
    crate::plugins::vault_unlock::commands::unlock_with_path(
        (*password).clone(),
        Some(vault_id),
        &meta_path,
        state,
        io,
        host,
    )
    .await
    .map_err(|_| SyncDeviceError::BadRequest)?; // wrong account# / password

    // 4. Register the verifier + SCRAM enroll (password → pending). The SCRAM
    //    secret is re-derived from the now-unlocked root_key (no credential reuse).
    let root_key = state
        .peek_unlocked_root_key_clone()
        .await
        .ok_or(SyncDeviceError::Internal)?;
    let approved =
        crate::task::run_blocking(move || -> Result<EnrollmentOutcome, SyncDeviceError> {
            let transport = super::http_transport::build_transport(&url, pins)
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
                EnrollPath::Password,
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
    })
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod pin_confirmation_tests {
    //! The enrollment half of MYND-650 task 5: the join's pin acquisition
    //! honours the out-of-band compare.
    //!
    //! Testing it at [`super::acquire_tofu_pin`] rather than through
    //! `join_account_from_host` is deliberate and is not a shortcut around the
    //! criterion. The join is a network fetch, a bootstrap, an unlock and a
    //! SCRAM handshake, all of which need a live server — but the pin
    //! acquisition is its **first** step, and it propagates its error with `?`
    //! before `config::set_endpoint` is reached. So "the fingerprint did not
    //! match" is, structurally, "nothing was written": no endpoint URL, no
    //! pin, no vault container. What these tests pin down is the half that
    //! could actually regress — whether the acquisition compares at all, and
    //! what it does when the comparison fails.

    use super::super::rustls_transport::cert_pin;
    use super::super::rustls_transport::tests::{spawn_tls_server, TEST_CERT_DER};
    use super::super::to_hex;
    use super::{acquire_tofu_pin, SyncDeviceError};

    /// A confirmed fingerprint that is not what the server serves aborts the
    /// acquisition — and therefore the join — with nothing pinned.
    #[test]
    fn a_mismatched_confirmed_fingerprint_aborts_the_join() {
        let port = spawn_tls_server(1);
        let url = format!("https://localhost:{port}");

        let out = crate::test_support::block_on(acquire_tofu_pin(&url, Some(&"0".repeat(64))));
        assert_eq!(out, Err(SyncDeviceError::FingerprintMismatch));
    }

    /// The matching case still returns the pin, in the canonical lowercase-hex
    /// form the endpoint config stores — i.e. the compare is a gate on the
    /// existing flow, not a replacement for it.
    #[test]
    fn a_matching_confirmed_fingerprint_yields_the_pin() {
        let port = spawn_tls_server(1);
        let url = format!("https://localhost:{port}");
        let expected = to_hex(&cert_pin(TEST_CERT_DER));

        let out = crate::test_support::block_on(acquire_tofu_pin(&url, Some(&expected)));
        assert_eq!(out, Ok(Some(expected)));
    }

    /// A loopback `http` endpoint has no certificate, so there is nothing to
    /// confirm and the confirmation policy never fires. The E2E harness and a
    /// developer's local server keep working unchanged.
    #[test]
    fn a_loopback_http_endpoint_needs_no_confirmation() {
        let out = crate::test_support::block_on(acquire_tofu_pin("http://127.0.0.1:8080", None));
        assert_eq!(out, Ok(None));
    }
}
