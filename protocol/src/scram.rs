// SPDX-License-Identifier: AGPL-3.0-or-later
//! SCRAM-SHA-256-PLUS **client** proof (MYND-425; RFC 5802 / 7677 / 9266).
//!
//! The deterministic client-side crypto of the device-authentication handshake:
//! given the handshake parameters (secret, salt, iterations, nonces, and the
//! `tls-exporter` channel-binding data, RFC 9266), compute the SCRAM
//! `client_proof` + the `server_signature` the client checks for mutual auth.
//! Byte-for-byte identical to the Go server's reference (`internal/auth/scram`),
//! pinned by the shared `scram-auth` golden vectors.
//!
//! **Closed-stack:** the only KDF is `pbkdf2` (RFC-mandated; RustCrypto crate, no
//! hand-rolling); every HMAC-SHA-256 is `Hkdf::<Sha256>::extract` (RFC 5869 §2.2,
//! the same construction as `compute_vault_head_mac`) — no `hmac`-crate surface
//! beyond what `pbkdf2` pulls. SHA-256 from `sha2`.
//!
//! **R3 (READ THIS):** the channel-binding assembly + the live `tls-exporter`
//! wiring are R3-gated — this module is the deterministic math (vector-verified);
//! the live handshake over the rustls layer (`src-tauri`) + the exporter feed
//! still owe a primitive-level review + live interop test before production trust
//! (mirrors the Go server's `review-r3-scram-tls-exporter.md`). Fallback if
//! `-PLUS` slips: plain SCRAM (empty `cbind_data`, gs2 `n,,`) — not wired here.

use alloc::string::String;
use alloc::vec::Vec;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use hkdf::Hkdf;
use sha2::{Digest, Sha256};

/// The SCRAM-SHA-256-PLUS channel-binding name (RFC 9266). The GS2 header is
/// `"p=tls-exporter,,"`. Load-bearing — must match the server byte-for-byte.
pub const SCRAM_CBIND_NAME: &str = "tls-exporter";

/// The deterministic client-side SCRAM outputs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScramClientOutput {
    /// `SHA-256(ClientKey)` — the server-stored verifier half.
    pub stored_key: [u8; 32],
    /// `HMAC(SaltedPassword, "Server Key")` — the mutual-auth verifier half.
    pub server_key: [u8; 32],
    /// `ClientKey XOR ClientSignature` — sent in the client-final message.
    pub client_proof: [u8; 32],
    /// `HMAC(ServerKey, AuthMessage)` — the client checks this on server-final.
    pub server_signature: [u8; 32],
}

/// HMAC-SHA-256(key, msg) via `Hkdf::extract` (RFC 5869 §2.2).
fn hmac(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let (prk, _hkdf) = Hkdf::<Sha256>::extract(Some(key), msg);
    let mut out = [0u8; 32];
    out.copy_from_slice(&prk);
    out
}

fn sha256(msg: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(msg);
    let mut out = [0u8; 32];
    out.copy_from_slice(&h.finalize());
    out
}

/// The GS2 header + channel-binding input, base64'd for the `c=` attribute.
fn cbind_input_b64(cbind_data: &[u8]) -> String {
    let mut buf = Vec::with_capacity(SCRAM_CBIND_NAME.len() + 4 + cbind_data.len());
    buf.extend_from_slice(b"p=");
    buf.extend_from_slice(SCRAM_CBIND_NAME.as_bytes());
    buf.extend_from_slice(b",,"); // gs2-cbind-flag "p=tls-exporter" + authzid empty
    buf.extend_from_slice(cbind_data);
    B64.encode(&buf)
}

/// Build the SCRAM `AuthMessage` (client-first-bare ‖ "," ‖ server-first ‖ ","
/// ‖ client-final-without-proof), exactly as the Go server assembles it.
fn auth_message(
    username: &str,
    client_nonce: &str,
    combined_nonce: &str,
    salt: &[u8],
    iterations: u32,
    cbind_data: &[u8],
) -> String {
    let mut s = String::new();
    // client-first-bare
    s.push_str("n=");
    s.push_str(username);
    s.push_str(",r=");
    s.push_str(client_nonce);
    // server-first
    s.push_str(",r=");
    s.push_str(combined_nonce);
    s.push_str(",s=");
    s.push_str(&B64.encode(salt));
    s.push_str(",i=");
    s.push_str(&itoa(iterations));
    // client-final-without-proof
    s.push_str(",c=");
    s.push_str(&cbind_input_b64(cbind_data));
    s.push_str(",r=");
    s.push_str(combined_nonce);
    s
}

/// Minimal no_std u32→decimal (avoids pulling a formatting dep into the path).
fn itoa(mut n: u32) -> String {
    if n == 0 {
        return String::from("0");
    }
    let mut buf = [0u8; 10];
    let mut i = buf.len();
    while n > 0 {
        i -= 1;
        buf[i] = b'0' + (n % 10) as u8;
        n /= 10;
    }
    String::from_utf8_lossy(&buf[i..]).into_owned()
}

/// Compute the SCRAM-SHA-256-PLUS client proof + the server signature for the
/// given handshake parameters. `iterations` MUST be ≥ 1.
pub fn scram_client_proof(
    secret: &[u8],
    salt: &[u8],
    iterations: u32,
    username: &str,
    client_nonce: &str,
    combined_nonce: &str,
    cbind_data: &[u8],
) -> ScramClientOutput {
    // SaltedPassword = PBKDF2-HMAC-SHA256(secret, salt, iterations).
    let salted = pbkdf2::pbkdf2_hmac_array::<Sha256, 32>(secret, salt, iterations);

    let client_key = hmac(&salted, b"Client Key");
    let stored_key = sha256(&client_key);
    let server_key = hmac(&salted, b"Server Key");

    let am = auth_message(
        username,
        client_nonce,
        combined_nonce,
        salt,
        iterations,
        cbind_data,
    );
    let client_sig = hmac(&stored_key, am.as_bytes());
    let server_signature = hmac(&server_key, am.as_bytes());

    let mut client_proof = [0u8; 32];
    for i in 0..32 {
        client_proof[i] = client_key[i] ^ client_sig[i];
    }

    ScramClientOutput {
        stored_key,
        server_key,
        client_proof,
        server_signature,
    }
}

/// Assemble the SCRAM wire client-final message
/// (`c=<b64(gs2||cbind)>,r=<combined_nonce>,p=<b64(proof)>`) the client POSTs to
/// `/auth/scram/final`. Mirrors the Go server's `ClientFinalMessage`.
pub fn scram_client_final_message(
    combined_nonce: &str,
    cbind_data: &[u8],
    proof: &[u8; 32],
) -> String {
    let mut s = String::new();
    s.push_str("c=");
    s.push_str(&cbind_input_b64(cbind_data));
    s.push_str(",r=");
    s.push_str(combined_nonce);
    s.push_str(",p=");
    s.push_str(&B64.encode(proof));
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn itoa_matches_decimal() {
        assert_eq!(itoa(0), "0");
        assert_eq!(itoa(1), "1");
        assert_eq!(itoa(4096), "4096");
        assert_eq!(itoa(u32::MAX), "4294967295");
    }

    #[test]
    fn cbind_input_is_gs2_plus_data() {
        // "p=tls-exporter,," || 0xCB.. → base64. Spot-check the prefix decodes.
        let b64 = cbind_input_b64(&[0xcb; 4]);
        let raw = B64.decode(b64.as_bytes()).unwrap();
        assert_eq!(&raw[..16], b"p=tls-exporter,,");
        assert_eq!(&raw[16..], &[0xcb; 4]);
    }

    #[test]
    fn proof_is_deterministic() {
        let a = scram_client_proof(b"secret", b"salt", 2, "MY-X", "cn", "cnsn", &[0xcb; 4]);
        let b = scram_client_proof(b"secret", b"salt", 2, "MY-X", "cn", "cnsn", &[0xcb; 4]);
        assert_eq!(a, b);
    }
}
