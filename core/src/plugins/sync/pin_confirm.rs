//! **Out-of-band fingerprint confirmation** for a TOFU pin captured over Tor
//! (MYND-650 task 5).
//!
//! Enrollment's first connection is the one handshake this client accepts
//! *any* certificate on: it has no pin yet, so it records whatever leaf it is
//! served and trusts it from then on (`self-host-policy.md` §6). On the
//! clearnet that is the ordinary TOFU bargain — the first connection is taken
//! on faith, and the operator's eye-compare across devices is what turns it
//! into something checked.
//!
//! **Tor changes who gets to be the man in the middle.** An exit node is an
//! arbitrary volunteer relay that terminates the circuit and sees the
//! destination in the clear; mounting a MitM on a first connection is not an
//! exotic capability there, it is the position an exit *occupies*. So routing
//! the accept-any-certificate handshake through a circuit — which task 5 must
//! do, because leaving it direct would leak the sync hostname and this device's
//! source IP at enrollment time, exactly when the user turned Tor on — makes
//! that handshake strictly more attackable than the one it replaces. The
//! tunnel only lands together with the compare that closes the hole.
//!
//! ## The shape, and why it is "type it in" rather than "does this look right?"
//!
//! The confirmation is an **input**, supplied before the pin is accepted, and
//! the client does the comparison. It is deliberately NOT "here is the
//! fingerprint we just captured, does it match yours?" — that dialog shows the
//! attacker's value first and asks a human to diff 64 hex characters against a
//! memory, which is the anchoring failure every fingerprint-compare UX study
//! finds. The captured fingerprint is therefore **never revealed on the
//! mismatch path** either: revealing it would let a user who cannot find their
//! real one copy the attacker's and retry, which converts the gate into a
//! speed bump.
//!
//! Consequences worth stating plainly:
//!
//! - A user who does not have their server's fingerprint cannot enroll over
//!   Tor. That is the intended answer, not a gap. They can obtain it from the
//!   server (`openssl x509 -noout -fingerprint -sha256`), from another already
//!   enrolled device, or enroll with Tor off — the last one being the honest
//!   trade the threat model already describes, not a shortcut this module
//!   grants silently.
//! - The comparison is not constant-time and does not need to be. Both sides
//!   are public values: the captured fingerprint is a hash of a certificate the
//!   server hands to anyone who connects, and the expected one is what the
//!   operator publishes. There is no secret here to leak through timing.
//!
//! ## Where this is enforced
//!
//! [`capture_pin`] is the **only** way the two enrollment paths acquire a TOFU
//! pin — `commands::sync_set_endpoint` (the endpoint surface) and
//! `enroll::acquire_tofu_pin` (the join flow). Neither calls
//! `rustls_transport::tofu_fetch_pin_via` directly any more, so the policy
//! cannot be bypassed by using the other entry point.

use super::proxy::{self, ProxyGate};

/// Why a TOFU pin was not accepted.
///
/// Both variants mean **nothing was stored**: no endpoint config was written,
/// no pin was persisted, and the caller's flow aborts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinConfirmError {
    /// Tor mode is on and no expected fingerprint was supplied. The caller must
    /// ask the user for the one they obtained out-of-band and retry.
    ConfirmationRequired,
    /// An expected fingerprint was supplied and it is not what the server
    /// served — either malformed, or a different certificate. Same variant for
    /// both, because "you typed it wrong" and "someone is between you and your
    /// server" are indistinguishable from here and the safe reading is the
    /// second one.
    FingerprintMismatch,
    /// The handshake itself failed (unreachable, TLS error, proxy refused).
    Transport,
}

/// Normalize a user-supplied fingerprint to the canonical lowercase-hex form,
/// or `None` if it is not 32 bytes of hex.
///
/// Operators copy fingerprints out of tools that format them differently —
/// `openssl` emits `AB:CD:…`, some dashboards use spaces, some people paste a
/// `sha256:` prefix. Rejecting those would send a user hunting for a formatting
/// rule at the exact moment the product is asking them to be careful, so the
/// separators are stripped rather than refused. What is NOT tolerated is a
/// wrong length or a non-hex character: those are a different string, not a
/// differently-formatted one.
pub fn normalize_fingerprint(input: &str) -> Option<String> {
    let trimmed = input.trim();
    let body = trimmed
        .strip_prefix("sha256:")
        .or_else(|| trimmed.strip_prefix("SHA256:"))
        .unwrap_or(trimmed);
    let mut out = String::with_capacity(64);
    for ch in body.chars() {
        match ch {
            ':' | ' ' | '-' | '\t' | '\n' | '\r' => continue,
            c if c.is_ascii_hexdigit() => out.push(c.to_ascii_lowercase()),
            _ => return None,
        }
    }
    (out.len() == 64).then_some(out)
}

/// Must a pin for `host` be confirmed out-of-band before it is accepted?
///
/// True exactly when Tor mode is on for that host. It reads the same gate the
/// transport routes by ([`proxy::installed_for`]), so the question "is this
/// handshake going through an exit node" is answered by the thing that decides
/// it, not by a second copy of the toggle. A loopback host gets a direct-only
/// gate and therefore never requires confirmation — there is no exit node on a
/// connection that does not leave the device, and a loopback `http` endpoint
/// has no certificate at all.
///
/// A **query**, for a caller that wants to know whether it must ask the user
/// for a fingerprint before it starts. [`capture_pin`] deliberately does not
/// use it: it needs the gate itself, and asking twice is the TOCTOU described
/// there.
pub fn confirmation_required(host: &str) -> bool {
    proxy::installed_for(host).is_enabled()
}

/// Acquire a TOFU pin under the confirmation policy — **the single enforcement
/// point** for both enrollment paths.
///
/// Order is load-bearing: the "confirmation required but absent" refusal
/// happens **before** the handshake. Capturing first and refusing after would
/// mean the client has the attacker's fingerprint in hand with a user standing
/// in front of it, which is the anchoring shape this module exists to avoid;
/// refusing first also means a Tor-mode enrollment attempt with no expected
/// fingerprint opens no circuit at all.
///
/// Returns the captured pin as lowercase hex on success. Every error path has
/// stored nothing.
///
/// The gate is read **once**, here, and the same value decides both the policy
/// and the route. Reading it twice — once for "is a confirmation required",
/// again inside the handshake — is a TOCTOU: a user who clicks Connect with Tor
/// off, hits a stalled handshake, and flips Tor on meanwhile would get the
/// accept-any-certificate handshake sent through an exit node under the
/// no-confirmation-needed decision made a moment earlier. Narrow and
/// user-initiated, but it defeats exactly the single-enforcement-point property
/// this module is for.
pub async fn capture_pin(
    host: String,
    port: u16,
    confirmed_fingerprint: Option<&str>,
) -> Result<String, PinConfirmError> {
    let gate = proxy::installed_for(&host);
    let required = gate.is_enabled();
    capture_pin_requiring(required, &gate, host, port, confirmed_fingerprint).await
}

/// [`capture_pin`] with the policy decision and the routing gate made INPUTS
/// rather than read from the process-global cell.
///
/// Production goes through [`capture_pin`], which derives the first from the
/// second; they are separate parameters here so a test can drive the Tor-mode
/// policy branch without installing a gate into the `OnceLock` the whole test
/// binary shares, and without forcing the handshake through a proxy it would
/// then have to stand up. Same split, and same reason, as
/// `RustlsTransport::with_proxy_gate`.
pub async fn capture_pin_requiring(
    confirmation_required: bool,
    gate: &ProxyGate,
    host: String,
    port: u16,
    confirmed_fingerprint: Option<&str>,
) -> Result<String, PinConfirmError> {
    let expected = match confirmed_fingerprint
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(raw) => {
            // A malformed expected fingerprint is a mismatch, not a bad
            // request: it certainly is not what the server served, and the
            // remedy — go get the real one — is the same.
            Some(normalize_fingerprint(raw).ok_or(PinConfirmError::FingerprintMismatch)?)
        }
        None if confirmation_required => return Err(PinConfirmError::ConfirmationRequired),
        None => None,
    };

    let handshake_host = host.clone();
    let handshake_gate = gate.clone();
    let captured = crate::task::run_blocking(move || {
        super::rustls_transport::tofu_fetch_pin_via(&handshake_gate, &handshake_host, port)
    })
    .await
    .map_err(|_| PinConfirmError::Transport)?
    .map_err(|_| PinConfirmError::Transport)?;
    let captured = super::to_hex(&captured);

    match expected {
        // The captured value is deliberately NOT returned or logged on this
        // path. See the module doc: handing it back is what would let a user
        // paste the attacker's fingerprint and retry.
        Some(exp) if exp != captured => {
            tracing::warn!(
                event = "sync_tofu_fingerprint_mismatch",
                "the certificate served does not match the expected fingerprint; \
                 refusing to pin"
            );
            Err(PinConfirmError::FingerprintMismatch)
        }
        _ => Ok(captured),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FP: &str = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";

    #[test]
    fn a_plain_lowercase_hex_fingerprint_normalizes_to_itself() {
        assert_eq!(normalize_fingerprint(FP).as_deref(), Some(FP));
    }

    /// The formats an operator actually pastes: `openssl`'s colon-separated
    /// uppercase, a space-separated variant, and a `sha256:` prefix.
    #[test]
    fn operator_formats_normalize_to_the_canonical_form() {
        let upper_colons = FP
            .to_uppercase()
            .as_bytes()
            .chunks(2)
            .map(|c| std::str::from_utf8(c).unwrap().to_string())
            .collect::<Vec<_>>()
            .join(":");
        assert_eq!(normalize_fingerprint(&upper_colons).as_deref(), Some(FP));
        assert_eq!(
            normalize_fingerprint(&upper_colons.replace(':', " ")).as_deref(),
            Some(FP)
        );
        assert_eq!(
            normalize_fingerprint(&format!("sha256:{FP}")).as_deref(),
            Some(FP)
        );
        assert_eq!(
            normalize_fingerprint(&format!("  {FP}  ")).as_deref(),
            Some(FP)
        );
    }

    /// A wrong length or a non-hex character is a DIFFERENT string, not a
    /// differently formatted one, and must not normalize to something.
    #[test]
    fn a_wrong_length_or_non_hex_fingerprint_is_rejected() {
        assert_eq!(normalize_fingerprint(""), None);
        assert_eq!(normalize_fingerprint(&FP[..63]), None);
        assert_eq!(normalize_fingerprint(&format!("{FP}ab")), None);
        assert_eq!(normalize_fingerprint(&FP.replace('a', "z")), None);
        // Not a separator we accept — dropping it would silently equate two
        // different strings.
        assert_eq!(normalize_fingerprint(&FP.replace('a', "/")), None);
    }

    /// No test in this crate installs a gate, so the read-back is the default
    /// (Tor mode off) — which is what keeps every existing enrollment test
    /// passing unchanged.
    #[test]
    fn confirmation_is_not_required_with_tor_mode_off() {
        assert!(!confirmation_required("sync.myne.md"));
        assert!(!confirmation_required("127.0.0.1"));
    }

    /// **The ordering assertion.** The host is an RFC 2606 `.invalid` name no
    /// resolver can answer, so a `capture_pin` that reached the handshake would
    /// come back `Transport`. Getting `ConfirmationRequired` instead is what
    /// proves the refusal happens before any socket — i.e. that a Tor-mode
    /// enrollment attempt with no expected fingerprint opens no circuit and
    /// captures nothing to anchor the user on.
    #[test]
    fn tor_mode_without_an_expected_fingerprint_refuses_before_the_handshake() {
        let err = crate::test_support::block_on(capture_pin_requiring(
            true,
            &ProxyGate::new(),
            "sync.unresolvable.invalid".to_string(),
            443,
            None,
        ));
        assert_eq!(err, Err(PinConfirmError::ConfirmationRequired));
    }

    /// An empty string is "the user has not answered yet", not "the user
    /// supplied an empty fingerprint" — a UI that sends the field's initial
    /// value must not be read as a confirmation.
    #[test]
    fn an_empty_expected_fingerprint_counts_as_unconfirmed() {
        for blank in ["", "   ", "\t"] {
            let err = crate::test_support::block_on(capture_pin_requiring(
                true,
                &ProxyGate::new(),
                "sync.unresolvable.invalid".to_string(),
                443,
                Some(blank),
            ));
            assert_eq!(err, Err(PinConfirmError::ConfirmationRequired), "{blank:?}");
        }
    }

    /// Malformed input is refused before the handshake too, and as a MISMATCH:
    /// whatever the server would have served, it is not that string.
    #[test]
    fn a_malformed_expected_fingerprint_is_a_mismatch_and_opens_no_socket() {
        for bad in ["not-a-fingerprint", "abc", FP.trim_end_matches('2')] {
            let err = crate::test_support::block_on(capture_pin_requiring(
                true,
                &ProxyGate::new(),
                "sync.unresolvable.invalid".to_string(),
                443,
                Some(bad),
            ));
            assert_eq!(err, Err(PinConfirmError::FingerprintMismatch), "{bad:?}");
        }
    }

    /// With Tor mode off and no expected fingerprint, the policy is inert and
    /// the call proceeds to the handshake — which fails here because the host
    /// does not resolve. `Transport`, not `ConfirmationRequired`: the clearnet
    /// TOFU flow is unchanged by this module.
    #[test]
    fn tor_mode_off_proceeds_to_the_handshake_unchanged() {
        let err = crate::test_support::block_on(capture_pin_requiring(
            false,
            &ProxyGate::new(),
            "sync.unresolvable.invalid".to_string(),
            443,
            None,
        ));
        assert_eq!(err, Err(PinConfirmError::Transport));
    }

    /// The captured pin is compared against a real server's real certificate —
    /// the accept arm and the reject arm of the same handshake.
    #[test]
    fn a_matching_fingerprint_pins_and_a_wrong_one_aborts() {
        // Borrowed from `rustls_transport`'s own test module rather than stood
        // up a second time: two hand-written TLS servers eventually disagree
        // about the certificate they are both serving, and the pin under test
        // IS that certificate's hash.
        use super::super::rustls_transport::tests::{spawn_tls_server, TEST_CERT_DER};
        // Two connections: one confirmed-correct, one confirmed-wrong. The
        // wrong one still handshakes (the capture happens; the comparison is
        // what refuses), so the server must serve both.
        let port = spawn_tls_server(2);
        let expected_hex =
            super::super::to_hex(&super::super::rustls_transport::cert_pin(TEST_CERT_DER));

        let ok = crate::test_support::block_on(capture_pin_requiring(
            true,
            &ProxyGate::new(),
            "localhost".to_string(),
            port,
            // Supplied in `openssl` shape to prove normalization is on the
            // production path, not only in the unit test above.
            Some(&expected_hex.to_uppercase()),
        ));
        assert_eq!(ok.as_deref(), Ok(expected_hex.as_str()));

        let wrong = crate::test_support::block_on(capture_pin_requiring(
            true,
            &ProxyGate::new(),
            "localhost".to_string(),
            port,
            Some(&"0".repeat(64)),
        ));
        assert_eq!(
            wrong,
            Err(PinConfirmError::FingerprintMismatch),
            "a certificate that is not the expected one must abort with nothing pinned"
        );
    }
}
