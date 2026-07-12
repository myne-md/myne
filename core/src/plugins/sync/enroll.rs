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

use super::transport::{HttpMethod, SyncTransport, TransportError};
use protocol::{scram_client_final_message, scram_client_proof};
use serde::{Deserialize, Serialize};

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
    /// The server's signature did not match — possible MITM; abort (mutual auth).
    ServerSignatureMismatch,
    /// A malformed / unparseable server response.
    BadResponse,
    /// Transport-level failure.
    Transport(TransportError),
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
    username: &str,
    secret: &[u8],
) -> Result<(), EnrollError> {
    let mut salt = [0u8; 16];
    getrandom::getrandom(&mut salt).map_err(|_| EnrollError::BadResponse)?;
    let iterations = SCRAM_REGISTER_ITERATIONS;
    let v = scram_client_proof(secret, &salt, iterations, username, "", "", &[]);
    let body = serde_json::to_vec(&RegisterReq {
        account_hash_hex: &hex_encode(account_hash),
        username,
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
    username: &str,
    secret: &[u8],
    path: EnrollPath,
    client_nonce: &str,
    device_id: [u8; 16],
) -> Result<EnrollOutcome, EnrollError> {
    let account_hash_hex = hex_encode(account_hash);

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

    // 2. compute the proof (cbind empty over http; live -PLUS exporter = R3).
    let cbind: &[u8] = &[];
    let out = scram_client_proof(
        secret,
        &salt,
        init.iterations,
        username,
        client_nonce,
        &init.combined_nonce,
        cbind,
    );
    let client_final = scram_client_final_message(&init.combined_nonce, cbind, &out.client_proof);

    // 3. client-final → token (or pending).
    let final_body = serde_json::to_vec(&ScramFinalReq {
        handshake_id: &init.handshake_id,
        client_final: &client_final,
        device_id_hex: &hex_encode(&device_id),
        path: path.wire(),
    })
    .map_err(|_| EnrollError::BadResponse)?;
    let final_resp = transport.request(HttpMethod::Post, "/auth/scram/final", &final_body, None)?;
    if final_resp.status == 401 {
        return Err(EnrollError::Unauthenticated);
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
    if server_sig != out.server_signature {
        return Err(EnrollError::ServerSignatureMismatch);
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
mod tests {
    use super::*;
    use crate::plugins::sync::transport::FakeTransport;
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;

    const SECRET: &[u8] = &[0xab; 32];
    const ACCOUNT: [u8; 16] = [0x42; 16];
    const SALT: &[u8] = &[0x11; 16];
    const USER: &str = "MY-TEST";

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

        // The server signature the client will verify (same crypto).
        let out = scram_client_proof(SECRET, SALT, 1, USER, client_nonce, combined, &[]);
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
        let out = enroll(&t, &ACCOUNT, USER, SECRET, EnrollPath::Recovery, "cn", dev).unwrap();
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
        let out = enroll(&t, &ACCOUNT, USER, SECRET, EnrollPath::Password, "cn", dev).unwrap();
        assert!(!out.approved);
        assert!(out.token.is_empty());
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
            enroll(
                &t,
                &ACCOUNT,
                USER,
                SECRET,
                EnrollPath::Recovery,
                "cn",
                [0x09; 16]
            )
            .unwrap_err(),
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
            enroll(
                &t,
                &ACCOUNT,
                USER,
                SECRET,
                EnrollPath::Password,
                "cn",
                [0x0a; 16]
            )
            .unwrap_err(),
            EnrollError::Unauthenticated
        );
    }

    #[test]
    fn generated_device_ids_are_distinct() {
        assert_ne!(generate_device_id(), generate_device_id());
    }
}
