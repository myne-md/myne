//! QR device-join payload codec (MYND-466).
//!
//! A **versioned, scanner-only** blob the trusted desktop renders into a QR and
//! the phone scans to prefill a device join. It carries ONLY non-secret identity
//! plus endpoint-trust material (`endpoint_url`, `account#` in canonical form,
//! `cert_pin_hex`, `generated_at`) — and NEVER a password or recovery phrase
//! (SYNC-47). The account number is an *identity, not a secret*; the cert pin is
//! public key material; the URL and timestamp are plainly non-secret.
//!
//! It is deliberately **outside the `protocol` crate**: it wraps no ciphertext,
//! so its `MYQR` magic is NOT a load-bearing AEAD/magic identifier and its
//! introduction is not a v0.1 major-version event (MYND-466 decisions.md /
//! PRD assumption). If a reviewer deems the magic load-bearing, that escalates
//! rather than being decided here.
//!
//! ## Format
//!
//! ```text
//! MYQR<version>|<endpoint_url>|<account#>|<cert_pin_hex|->|<generated_at>
//! ```
//!
//! - `MYQR` — magic prefix; a scanned string without it is "not a Myne join QR".
//! - `<version>` — one ASCII digit; a scanner rejects any other version with a
//!   distinct [`QrJoinDecodeError::UnsupportedVersion`] instead of mis-parsing.
//! - `<account#>` — canonical 20-char Crockford, re-validated via Damm-32 on both
//!   encode and decode.
//! - cert-pin slot — the 64-hex leaf-cert SHA-256, or `-` when no pin is carried
//!   (hosted / loopback producer).
//! - `<generated_at>` — unix seconds; drives the ephemeral freshness check
//!   ([`QrJoinPayload::is_fresh`]).

use super::config::hosted_static_pin;
use protocol::parse_account_number;
use serde::Serialize;
use thiserror::Error;

/// Magic prefix identifying a Myne device-join QR payload. NOT a protocol-crate
/// AEAD/magic identifier — the payload carries no ciphertext (MYND-466).
pub const QR_JOIN_MAGIC: &str = "MYQR";

/// The current payload format version. A scanner rejects any other version with
/// [`QrJoinDecodeError::UnsupportedVersion`] rather than mis-parsing it.
pub const QR_JOIN_VERSION: u8 = 1;

/// Ephemeral freshness window for a scanned payload (MYND-466 grill Q8).
///
/// This is **not** confidentiality — the payload carries no secret. It enforces
/// **live co-presence**: a QR photographed and forwarded later is stale, so the
/// scan can be treated as a trustworthy out-of-band channel from the trusted
/// device (the basis for replacing the self-host cert eye-compare, SYNC-26 /
/// grill Q2). Chosen at the short end of the grill's "order of minutes".
pub const QR_JOIN_TTL_SECS: u64 = 180;

/// Forward clock-skew the phone tolerates when judging freshness: a payload whose
/// `generated_at` is more than this far in the *future* (per the phone's clock) is
/// implausible and rejected. The freshness window is one-directional, so modest
/// desktop↔phone drift does not spuriously reject a fresh code.
pub const QR_JOIN_SKEW_SECS: u64 = 60;

/// Length of a leaf-cert pin in lowercase hex (SHA-256 of the DER → 32 bytes).
const CERT_PIN_HEX_LEN: usize = 64;

/// A decoded, validated device-join payload. Holds only non-secret fields —
/// there is no password/phrase field by construction (SYNC-47).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QrJoinPayload {
    /// The trusted device's sync endpoint URL (validated by the join path's URL
    /// policy, not here — the codec only frames it).
    pub endpoint_url: String,
    /// The account number in canonical 20-char Crockford form (Damm-32 valid).
    pub account_number: String,
    /// The trusted device's TOFU/self-host leaf-cert pin (SHA-256, lowercase hex),
    /// or `None` when the producer carried no pin (hosted / loopback endpoint).
    pub cert_pin_hex: Option<String>,
    /// Unix seconds when the producing device generated this payload.
    pub generated_at: u64,
}

/// Failure surface for [`QrJoinPayload::encode`].
#[derive(Debug, Clone, Error, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "detail")]
pub enum QrJoinEncodeError {
    /// The account number is not a valid canonical/display account number.
    #[error("account number is invalid")]
    InvalidAccountNumber,
    /// A field contains the reserved `|` delimiter (a malformed endpoint URL).
    #[error("field contains the reserved delimiter")]
    DelimiterInField,
    /// The cert pin is present but not 64 lowercase hex characters.
    #[error("cert pin is not 64 lowercase hex characters")]
    InvalidCertPin,
}

/// Failure surface for [`QrJoinPayload::decode`].
#[derive(Debug, Clone, Error, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "detail")]
pub enum QrJoinDecodeError {
    /// The scanned string is not a Myne device-join QR (missing `MYQR` magic).
    #[error("not a Myne device-join QR")]
    NotAQrJoinPayload,
    /// The magic matched but the version is one this build does not understand.
    /// Surfaced to the user as "update the app", never mis-parsed.
    #[error("unsupported QR version: {0}")]
    UnsupportedVersion(u8),
    /// The payload is structurally malformed (wrong field count, bad number).
    #[error("QR payload is malformed")]
    Malformed,
    /// The account number failed Damm-32 validation.
    #[error("account number is invalid")]
    InvalidAccountNumber,
    /// The cert pin is present but not 64 lowercase hex characters.
    #[error("cert pin is not 64 lowercase hex characters")]
    InvalidCertPin,
}

fn is_valid_cert_pin(hex: &str) -> bool {
    hex.len() == CERT_PIN_HEX_LEN
        && hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Canonicalize an account number string via the protocol crate's parser (accepts
/// canonical or display form, Damm-32-checked) and return its canonical 20-char form.
fn canonical_account(input: &str) -> Option<String> {
    let acct = parse_account_number(input).ok()?;
    // `canonical` is 20 ASCII uppercase Crockford bytes by construction.
    std::str::from_utf8(&acct.canonical).ok().map(str::to_owned)
}

impl QrJoinPayload {
    /// Build a payload, normalizing the account number to canonical form.
    /// `cert_pin_hex` must be `None` or 64 lowercase hex chars.
    pub fn new(
        endpoint_url: impl Into<String>,
        account_number: &str,
        cert_pin_hex: Option<String>,
        generated_at: u64,
    ) -> Result<Self, QrJoinEncodeError> {
        let account_number =
            canonical_account(account_number).ok_or(QrJoinEncodeError::InvalidAccountNumber)?;
        if let Some(pin) = cert_pin_hex.as_deref() {
            if !is_valid_cert_pin(pin) {
                return Err(QrJoinEncodeError::InvalidCertPin);
            }
        }
        Ok(Self {
            endpoint_url: endpoint_url.into(),
            account_number,
            cert_pin_hex,
            generated_at,
        })
    }

    /// Encode to the scanner string. Re-validates the account number so a bug can
    /// never emit an invalid code, and rejects a `|` in the endpoint URL.
    pub fn encode(&self) -> Result<String, QrJoinEncodeError> {
        let account = canonical_account(&self.account_number)
            .ok_or(QrJoinEncodeError::InvalidAccountNumber)?;
        if self.endpoint_url.contains('|') {
            return Err(QrJoinEncodeError::DelimiterInField);
        }
        if let Some(pin) = self.cert_pin_hex.as_deref() {
            if !is_valid_cert_pin(pin) {
                return Err(QrJoinEncodeError::InvalidCertPin);
            }
        }
        let pin = self.cert_pin_hex.as_deref().unwrap_or("-");
        Ok(format!(
            "{}{}|{}|{}|{}|{}",
            QR_JOIN_MAGIC, QR_JOIN_VERSION, self.endpoint_url, account, pin, self.generated_at
        ))
    }

    /// Decode a scanned string into a validated payload.
    pub fn decode(s: &str) -> Result<Self, QrJoinDecodeError> {
        let rest = s
            .strip_prefix(QR_JOIN_MAGIC)
            .ok_or(QrJoinDecodeError::NotAQrJoinPayload)?;
        let (ver_str, body) = rest.split_once('|').ok_or(QrJoinDecodeError::Malformed)?;
        let version: u8 = ver_str.parse().map_err(|_| QrJoinDecodeError::Malformed)?;
        if version != QR_JOIN_VERSION {
            return Err(QrJoinDecodeError::UnsupportedVersion(version));
        }
        let parts: Vec<&str> = body.split('|').collect();
        if parts.len() != 4 {
            return Err(QrJoinDecodeError::Malformed);
        }
        let endpoint_url = parts[0].to_string();
        if endpoint_url.is_empty() {
            return Err(QrJoinDecodeError::Malformed);
        }
        let account_number =
            canonical_account(parts[1]).ok_or(QrJoinDecodeError::InvalidAccountNumber)?;
        let cert_pin_hex = match parts[2] {
            "-" => None,
            hex if is_valid_cert_pin(hex) => Some(hex.to_string()),
            _ => return Err(QrJoinDecodeError::InvalidCertPin),
        };
        let generated_at: u64 = parts[3].parse().map_err(|_| QrJoinDecodeError::Malformed)?;
        Ok(Self {
            endpoint_url,
            account_number,
            cert_pin_hex,
            generated_at,
        })
    }

    /// True if `now_unix` is within `ttl_secs` of `generated_at` (fresh). Rejects a
    /// stale payload and an implausibly-future one (beyond [`QR_JOIN_SKEW_SECS`]).
    pub fn is_fresh(&self, now_unix: u64, ttl_secs: u64) -> bool {
        if self.generated_at > now_unix.saturating_add(QR_JOIN_SKEW_SECS) {
            return false;
        }
        now_unix.saturating_sub(self.generated_at) <= ttl_secs
    }
}

/// The trust decision for a scanned QR payload's cert pin (SYNC-43 + grill Q1/Q2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QrPinSelection {
    /// Hosted endpoint: trust the app's baked-in static pin. Any QR-carried pin is
    /// **ignored** (SYNC-43 — the hosted-TOFU door stays shut). `qr_pin_disagreed`
    /// is true when the ignored QR pin differed from the static pin (worth a warn).
    Hosted {
        static_pin: [u8; 32],
        qr_pin_disagreed: bool,
    },
    /// Self-host endpoint: adopt the QR-carried cert pin as the TOFU pin. The scan
    /// is the out-of-band channel replacing the SYNC-26 eye-compare (grill Q2).
    SelfHostAdoptQr { cert_pin_hex: String },
    /// Self-host endpoint with no QR pin: nothing to establish from the QR (fall
    /// back to the existing blind-TOFU-at-first-connect path).
    SelfHostNoPin,
}

/// Decide which pin to trust, given whether a hosted static pin applies and the
/// QR-carried pin. Pure and fully branch-testable without the hosted constant
/// (R2): pass `Some(pin)` to exercise the hosted branch even while
/// [`hosted_static_pin`] returns `None` in production.
pub fn decide_pin(
    hosted_static_pin: Option<[u8; 32]>,
    qr_cert_pin_hex: Option<&str>,
) -> QrPinSelection {
    match hosted_static_pin {
        Some(static_pin) => {
            let qr_pin_disagreed = qr_cert_pin_hex
                .map(|qr| qr != super::to_hex(&static_pin))
                .unwrap_or(false);
            QrPinSelection::Hosted {
                static_pin,
                qr_pin_disagreed,
            }
        }
        None => match qr_cert_pin_hex {
            Some(pin) => QrPinSelection::SelfHostAdoptQr {
                cert_pin_hex: pin.to_string(),
            },
            None => QrPinSelection::SelfHostNoPin,
        },
    }
}

/// Resolve the hosted static pin for the payload's endpoint (SYNC-43), then decide.
///
/// R2 (pre-existing SYNC-43 gap): [`hosted_static_pin`] returns `None` for every
/// URL until the hosted service launches, so today this always yields a self-host
/// decision. That is correct-for-when-the-constant-lands — the hosted branch keys
/// strictly off a *present* static pin, so hosted-TOFU is never silently
/// normalized. Do NOT add a URL-string allowlist here as a stand-in for the pin.
pub fn select_pin_for_qr_join(payload: &QrJoinPayload) -> QrPinSelection {
    decide_pin(
        hosted_static_pin(&payload.endpoint_url),
        payload.cert_pin_hex.as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::generate_account_number;

    fn fresh_account() -> String {
        let acct = generate_account_number().expect("generate account number");
        String::from_utf8(acct.canonical.to_vec()).expect("canonical ascii")
    }

    fn pin() -> String {
        "ab".repeat(32) // 64 lowercase hex chars
    }

    #[test]
    fn encode_decode_round_trips() {
        let acct = fresh_account();
        let payload = QrJoinPayload::new(
            "https://sync.example.org",
            &acct,
            Some(pin()),
            1_700_000_000,
        )
        .expect("valid payload");
        let encoded = payload.encode().expect("encode");
        let decoded = QrJoinPayload::decode(&encoded).expect("decode");
        assert_eq!(decoded, payload);
    }

    #[test]
    fn round_trips_without_a_cert_pin() {
        let acct = fresh_account();
        let payload =
            QrJoinPayload::new("http://127.0.0.1:8443", &acct, None, 42).expect("payload");
        let decoded = QrJoinPayload::decode(&payload.encode().unwrap()).unwrap();
        assert_eq!(decoded.cert_pin_hex, None);
        assert_eq!(decoded, payload);
    }

    #[test]
    fn missing_magic_is_not_a_join_qr() {
        assert_eq!(
            QrJoinPayload::decode("https://evil.example|X|Y|Z"),
            Err(QrJoinDecodeError::NotAQrJoinPayload)
        );
        assert_eq!(
            QrJoinPayload::decode("hello world"),
            Err(QrJoinDecodeError::NotAQrJoinPayload)
        );
    }

    #[test]
    fn unknown_version_is_a_distinct_error_not_a_misparse() {
        let acct = fresh_account();
        let good = QrJoinPayload::new("https://s.example", &acct, None, 1)
            .unwrap()
            .encode()
            .unwrap();
        // Swap the version digit 1 -> 9 (right after the MYQR magic).
        let bumped = good.replacen("MYQR1|", "MYQR9|", 1);
        assert_eq!(
            QrJoinPayload::decode(&bumped),
            Err(QrJoinDecodeError::UnsupportedVersion(9))
        );
    }

    #[test]
    fn tampered_account_number_fails_damm32() {
        let acct = fresh_account();
        let payload = QrJoinPayload::new("https://s.example", &acct, None, 1).unwrap();
        let encoded = payload.encode().unwrap();
        // Corrupt one entropy character of the account number (flip a Crockford digit).
        let bad_char = if acct.as_bytes()[0] == b'0' { '1' } else { '0' };
        let corrupted = encoded.replacen(&acct, &format!("{}{}", bad_char, &acct[1..]), 1);
        assert_eq!(
            QrJoinPayload::decode(&corrupted),
            Err(QrJoinDecodeError::InvalidAccountNumber)
        );
    }

    #[test]
    fn wrong_field_count_is_malformed() {
        assert_eq!(
            QrJoinPayload::decode("MYQR1|only|two"),
            Err(QrJoinDecodeError::Malformed)
        );
        assert_eq!(
            QrJoinPayload::decode("MYQR1|a|b|c|d|e|f"),
            Err(QrJoinDecodeError::Malformed)
        );
    }

    #[test]
    fn non_numeric_timestamp_is_malformed() {
        let acct = fresh_account();
        let s = format!("MYQR1|https://s.example|{}|-|notanumber", acct);
        assert_eq!(QrJoinPayload::decode(&s), Err(QrJoinDecodeError::Malformed));
    }

    #[test]
    fn malformed_cert_pin_is_rejected() {
        let acct = fresh_account();
        // 63 hex chars (too short) in the pin slot.
        let short = "a".repeat(63);
        let s = format!("MYQR1|https://s.example|{}|{}|1", acct, short);
        assert_eq!(
            QrJoinPayload::decode(&s),
            Err(QrJoinDecodeError::InvalidCertPin)
        );
    }

    #[test]
    fn encode_rejects_delimiter_in_endpoint() {
        let acct = fresh_account();
        let payload = QrJoinPayload {
            endpoint_url: "https://s.example/a|b".to_string(),
            account_number: acct,
            cert_pin_hex: None,
            generated_at: 1,
        };
        assert_eq!(payload.encode(), Err(QrJoinEncodeError::DelimiterInField));
    }

    #[test]
    fn freshness_accepts_within_ttl_rejects_stale() {
        let acct = fresh_account();
        let p = QrJoinPayload::new("https://s.example", &acct, None, 1_000).unwrap();
        assert!(p.is_fresh(1_000, QR_JOIN_TTL_SECS)); // same instant
        assert!(p.is_fresh(1_000 + QR_JOIN_TTL_SECS, QR_JOIN_TTL_SECS)); // edge
        assert!(!p.is_fresh(1_000 + QR_JOIN_TTL_SECS + 1, QR_JOIN_TTL_SECS)); // stale
    }

    #[test]
    fn freshness_rejects_implausible_future_timestamp() {
        let acct = fresh_account();
        let p = QrJoinPayload::new("https://s.example", &acct, None, 10_000).unwrap();
        // Phone clock far behind the generated_at, beyond skew tolerance.
        assert!(!p.is_fresh(10_000 - QR_JOIN_SKEW_SECS - 1, QR_JOIN_TTL_SECS));
        // Within skew: accepted.
        assert!(p.is_fresh(10_000 - QR_JOIN_SKEW_SECS, QR_JOIN_TTL_SECS));
    }

    #[test]
    fn hosted_static_pin_wins_and_ignores_disagreeing_qr_pin() {
        let static_pin = [0xABu8; 32];
        let d = decide_pin(Some(static_pin), Some(&"cd".repeat(32)));
        assert_eq!(
            d,
            QrPinSelection::Hosted {
                static_pin,
                qr_pin_disagreed: true
            }
        );
    }

    #[test]
    fn hosted_with_matching_qr_pin_flags_no_disagreement() {
        let static_pin = [0xABu8; 32]; // hex "ab" × 32
        let d = decide_pin(Some(static_pin), Some(&"ab".repeat(32)));
        assert_eq!(
            d,
            QrPinSelection::Hosted {
                static_pin,
                qr_pin_disagreed: false
            }
        );
    }

    #[test]
    fn self_host_adopts_the_qr_pin() {
        let d = decide_pin(None, Some(&"ef".repeat(32)));
        assert_eq!(
            d,
            QrPinSelection::SelfHostAdoptQr {
                cert_pin_hex: "ef".repeat(32)
            }
        );
    }

    #[test]
    fn self_host_without_qr_pin_establishes_nothing() {
        assert_eq!(decide_pin(None, None), QrPinSelection::SelfHostNoPin);
    }

    #[test]
    fn today_every_endpoint_resolves_to_self_host_tofu_r2_gap() {
        // R2: hosted_static_pin returns None for all URLs today, so even a
        // hosted-looking URL resolves to self-host TOFU — no silent hosted-TOFU
        // normalization, and no hosted branch until the static-pin constant lands.
        let acct = fresh_account();
        let payload = QrJoinPayload::new("https://sync.myne.md", &acct, Some(pin()), 1).unwrap();
        assert_eq!(
            select_pin_for_qr_join(&payload),
            QrPinSelection::SelfHostAdoptQr {
                cert_pin_hex: pin()
            }
        );
    }

    #[test]
    fn payload_type_has_no_secret_field() {
        // Compile-time guarantee: constructing a payload requires exactly the four
        // non-secret fields; there is no password/phrase field to populate.
        let acct = fresh_account();
        let _ = QrJoinPayload {
            endpoint_url: "https://s.example".to_string(),
            account_number: acct,
            cert_pin_hex: None,
            generated_at: 0,
        };
    }
}
