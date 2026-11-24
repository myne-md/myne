// SPDX-License-Identifier: AGPL-3.0-only
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
//!
//! **Memory hygiene.** `secret` is `DeriveSubkey(root_key, ServerAuth)`, so
//! `SaltedPassword`, `ClientKey` and every value below them are `root_key`-
//! descended key material and follow this crate's `zeroize` discipline
//! (`protocol/AGENTS.md`, "Memory hygiene"): the intermediates are `Zeroizing`
//! and [`ScramClientOutput`] is `ZeroizeOnDrop` with a redacted [`Debug`].
//! **Best-effort, not a guarantee** — `Zeroizing::new(f(…))` wipes the slot it
//! is moved into, not the by-value return slot the callee wrote; the `pbkdf2`
//! and `hkdf` crates' own internal state is unreachable from here; and LLVM
//! register/stack spills are outside any wrapper. That is the same posture the
//! rest of the crate has, and `docs/threat-model.md` §7 defers forensic-grade
//! (freed-page / swap / hibernation) scrubbing outright.

use alloc::string::String;
use alloc::vec::Vec;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

/// The SCRAM-SHA-256-PLUS channel-binding name (RFC 9266). The GS2 header is
/// `"p=tls-exporter,,"`. Load-bearing — must match the server byte-for-byte.
pub const SCRAM_CBIND_NAME: &str = "tls-exporter";

/// The deterministic client-side SCRAM outputs.
///
/// All four fields are `root_key`-descended: `ClientKey` is recoverable from
/// `stored_key` + `client_proof` once the `AuthMessage` is reconstructed, so the
/// struct wipes itself on drop rather than leaving four bare 32-byte arrays in a
/// freed stack frame. `Clone` is kept (each clone wipes itself in turn);
/// `PartialEq`/`Eq` are a variable-time compare, used only by the determinism
/// test below and never as a production oracle.
#[derive(Clone, PartialEq, Eq, Zeroize, ZeroizeOnDrop)]
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

/// Redacted [`Debug`] impl, following the `blob.rs` `DecryptedNote` precedent in
/// this crate. `Debug` is KEPT rather than dropped because the module's
/// `proof_is_deterministic` test asserts with `assert_eq!`, which requires it —
/// but the derive would print all
/// four secret fields verbatim, a leak channel through `tracing::debug!`, panic
/// messages, or test-failure output (the `src-tauri/AGENTS.md` secret-handling
/// DENY list forbids exactly this). Nothing formats the type today; this is the
/// latent channel closed, not an active leak fixed.
///
/// Consequence to know: an `assert_eq!` failure on this type reports only the
/// redaction markers. Assert on the individual hex-encoded fields (as
/// `protocol/tests/vectors.rs` does) when you need to see which one moved.
impl core::fmt::Debug for ScramClientOutput {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("ScramClientOutput")
            .field("stored_key", &"<[u8; 32] redacted>")
            .field("server_key", &"<[u8; 32] redacted>")
            .field("client_proof", &"<[u8; 32] redacted>")
            .field("server_signature", &"<[u8; 32] redacted>")
            .finish()
    }
}

/// HMAC-SHA-256(key, msg) via `Hkdf::extract` (RFC 5869 §2.2).
///
/// Returns `Zeroizing` because every call site here produces key material:
/// `ClientKey` and `ServerKey` are `SaltedPassword`-descended, and the client
/// signature is XORed with `ClientKey`. The `hkdf` PRK the value is copied out
/// of is wiped explicitly — it is the same 32 bytes. The `Hkdf` handle's own
/// internal HMAC state is not reachable from here (see the module doc's
/// best-effort note).
fn hmac(key: &[u8], msg: &[u8]) -> Zeroizing<[u8; 32]> {
    let (mut prk, _hkdf) = Hkdf::<Sha256>::extract(Some(key), msg);
    let mut out = Zeroizing::new([0u8; 32]);
    out.copy_from_slice(&prk);
    prk.as_mut_slice().zeroize();
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
    // Wrapped on receipt: `secret` is `DeriveSubkey(root_key, ServerAuth)`, so
    // this and everything below it is `root_key`-descended. (Best-effort — the
    // by-value return slot `pbkdf2_hmac_array` wrote is not the slot moved into
    // here; see the module doc.)
    let salted = Zeroizing::new(pbkdf2::pbkdf2_hmac_array::<Sha256, 32>(
        secret, salt, iterations,
    ));

    let client_key = hmac(salted.as_slice(), b"Client Key");
    let stored_key = Zeroizing::new(sha256(client_key.as_slice()));
    let server_key = hmac(salted.as_slice(), b"Server Key");

    let am = auth_message(
        username,
        client_nonce,
        combined_nonce,
        salt,
        iterations,
        cbind_data,
    );
    let client_sig = hmac(stored_key.as_slice(), am.as_bytes());
    let server_signature = hmac(server_key.as_slice(), am.as_bytes());

    let mut client_proof = Zeroizing::new([0u8; 32]);
    for i in 0..32 {
        client_proof[i] = client_key[i] ^ client_sig[i];
    }

    // Each `*x` copies out of a `Zeroizing` whose own slot is wiped when it
    // drops at the end of this function; the destination struct is
    // `ZeroizeOnDrop`, so the bytes stay inside a wrapper end to end.
    ScramClientOutput {
        stored_key: *stored_key,
        server_key: *server_key,
        client_proof: *client_proof,
        server_signature: *server_signature,
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

    /// The derive would print all four secret fields; the hand-written impl must
    /// print none of them. Guards the latent `tracing::debug!(?out)` channel —
    /// a future `#[derive(Debug)]` restored here fails this test rather than
    /// shipping the leak.
    #[test]
    fn debug_output_redacts_every_secret_field() {
        let out = ScramClientOutput {
            stored_key: [0xab; 32],
            server_key: [0xcd; 32],
            client_proof: [0xef; 32],
            server_signature: [0x01; 32],
        };
        let s = alloc::format!("{out:?}");

        // `Debug` for `[u8; 32]` renders decimal byte lists; none may appear.
        for byte in ["171", "205", "239"] {
            assert!(!s.contains(byte), "debug leaked a secret byte: {s}");
        }
        // Field names stay (they are not secret) and each carries the marker.
        for field in [
            "stored_key",
            "server_key",
            "client_proof",
            "server_signature",
        ] {
            assert!(s.contains(field), "debug dropped the field name {field}");
        }
        assert_eq!(
            s.matches("redacted").count(),
            4,
            "one marker per field: {s}"
        );
    }
}
