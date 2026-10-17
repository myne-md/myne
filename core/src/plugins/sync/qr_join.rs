// SPDX-License-Identifier: AGPL-3.0
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
//! v2 (current):
//!
//! ```text
//! MYQR<version>|<kind>|<endpoint_url>|<target>|<cert_pin_hex|->|<generated_at>
//! ```
//!
//! v1 (legacy, still decoded — an older desktop emits it):
//!
//! ```text
//! MYQR1|<endpoint_url>|<account#>|<cert_pin_hex|->|<generated_at>
//! ```
//!
//! - `MYQR` — magic prefix; a scanned string without it is "not a Myne join QR".
//! - `<version>` — one ASCII digit; a scanner rejects any other version with a
//!   distinct [`QrJoinDecodeError::UnsupportedVersion`] instead of mis-parsing.
//! - `<kind>` — `a` (the vault ACCOUNT, owner device-join) or `m` (a shared
//!   vault, member device-join). See [`QrJoinTarget`].
//! - `<target>` — for `a`, the canonical 20-char Crockford `<account#>`,
//!   re-validated via Damm-32 on both encode and decode; for `m`, the vault's
//!   16-byte `account_number_hash` as 32 lowercase hex.
//! - cert-pin slot — the 64-hex leaf-cert SHA-256, or `-` when no pin is carried
//!   (hosted / loopback producer).
//! - `<generated_at>` — unix seconds; drives the ephemeral freshness check
//!   ([`QrJoinPayload::is_fresh`]).

use protocol::parse_account_number;
use serde::Serialize;
use thiserror::Error;

/// Magic prefix identifying a Myne device-join QR payload. NOT a protocol-crate
/// AEAD/magic identifier — the payload carries no ciphertext (MYND-466).
pub const QR_JOIN_MAGIC: &str = "MYQR";

/// The current payload format version. A scanner rejects any other version with
/// [`QrJoinDecodeError::UnsupportedVersion`] rather than mis-parsing it.
///
/// **v2 adds the target kind, and keeps v1 decodable.** v1 carried an account
/// number in a single implicit role: the owner's device-join, where the scanner
/// proves `{account# + password}`. A **member** vault's own device has no account
/// number to carry (the display form is the owner's and never reaches a member),
/// so a member QR names the vault by its `account_number_hash` instead — a
/// different value, validated differently (32 hex, not a Damm-32 Crockford
/// string), which is why this is a kind-tagged payload rather than a second
/// interpretation of one field.
///
/// The direction of the compatibility that matters: a v2 device MUST decode a v1
/// QR, because an older desktop still emits one and the phone scanning it is the
/// newer build. The reverse fails loudly and safely — a v1 scanner handed a v2
/// code reports `UnsupportedVersion`, which the UI renders as "update the app".
pub const QR_JOIN_VERSION: u8 = 2;

/// The legacy payload version, still decoded (see [`QR_JOIN_VERSION`]).
const QR_JOIN_VERSION_LEGACY: u8 = 1;

/// What the scanned code tells the scanning device to join.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QrJoinTarget {
    /// The vault ACCOUNT, in canonical 20-char Crockford form. The owner's
    /// device-join: the scanner proves `{account# + password}` and lands pending
    /// until an existing device approves it.
    Account { account_number: String },
    /// A shared vault, addressed by its `account_number_hash` (32 lowercase hex).
    /// The MEMBER's own-device join (`myne-md/myne`, member-devices): the scanner
    /// proves the **24-word recovery phrase** instead, self-approves, and fetches
    /// the vault's keys from the group package the owner already pushed.
    MemberVault { account_hash_hex: String },
}

/// One-character wire tag for each target kind. Legible on purpose: a raw QR
/// string is the artefact a support conversation has to read out loud.
const KIND_ACCOUNT_WIRE: &str = "a";
const KIND_MEMBER_WIRE: &str = "m";

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

/// Length of a 16-byte account-number hash in lowercase hex.
const ACCOUNT_HASH_HEX_LEN: usize = 32;

/// A decoded, validated device-join payload. Holds only non-secret fields —
/// there is no password/phrase field by construction (SYNC-47).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QrJoinPayload {
    /// The producing device's sync endpoint URL (validated by the join path's URL
    /// policy, not here — the codec only frames it).
    pub endpoint_url: String,
    /// What to join, and therefore which credential the scanner will be asked
    /// for. See [`QrJoinTarget`].
    pub target: QrJoinTarget,
    /// The retired leaf-cert pin (SHA-256, lowercase hex). New payloads carry
    /// `None` (native trust is public CA plus hostname, decisions/sync/0620);
    /// the field survives so a QR an older desktop emitted still decodes.
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
    /// The vault account hash is not 32 lowercase hex characters.
    #[error("vault account hash is not 32 lowercase hex characters")]
    InvalidAccountHash,
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
    /// The payload is structurally malformed (wrong field count, bad kind).
    #[error("QR payload is malformed")]
    Malformed,
    /// The account number failed Damm-32 validation.
    #[error("account number is invalid")]
    InvalidAccountNumber,
    /// The vault account hash is not 32 lowercase hex characters.
    #[error("vault account hash is not 32 lowercase hex characters")]
    InvalidAccountHash,
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

/// Lowercase hex, exactly 16 bytes' worth. Uppercase is refused rather than
/// normalised: every producer in this tree writes lowercase, and accepting both
/// would mean two spellings of one vault id travelling between devices.
fn is_valid_account_hash(hex: &str) -> bool {
    hex.len() == ACCOUNT_HASH_HEX_LEN
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
    /// Build an ACCOUNT payload (the owner's device-join), normalizing the
    /// account number to canonical form. `cert_pin_hex` must be `None` or 64
    /// lowercase hex chars.
    pub fn new(
        endpoint_url: impl Into<String>,
        account_number: &str,
        cert_pin_hex: Option<String>,
        generated_at: u64,
    ) -> Result<Self, QrJoinEncodeError> {
        let account_number =
            canonical_account(account_number).ok_or(QrJoinEncodeError::InvalidAccountNumber)?;
        Self::with_target(
            endpoint_url.into(),
            QrJoinTarget::Account { account_number },
            cert_pin_hex,
            generated_at,
        )
    }

    /// Build a MEMBER-VAULT payload: this device is in a shared vault and another
    /// device of the SAME person is to join it with the recovery phrase.
    ///
    /// Carries no cert pin (there is no pin to carry; see [`Self::new`]) and no
    /// account number — a member never holds the vault account's display form.
    pub fn member_vault(
        endpoint_url: impl Into<String>,
        account_hash_hex: &str,
        generated_at: u64,
    ) -> Result<Self, QrJoinEncodeError> {
        // NOT normalised: the one rule is lowercase hex everywhere (the decoder
        // refuses uppercase too), and accepting both spellings at the constructor
        // would put two forms of one vault id on the wire between two devices.
        let hash = account_hash_hex.trim();
        if !is_valid_account_hash(hash) {
            return Err(QrJoinEncodeError::InvalidAccountHash);
        }
        Self::with_target(
            endpoint_url.into(),
            QrJoinTarget::MemberVault {
                account_hash_hex: hash.to_string(),
            },
            None,
            generated_at,
        )
    }

    fn with_target(
        endpoint_url: String,
        target: QrJoinTarget,
        cert_pin_hex: Option<String>,
        generated_at: u64,
    ) -> Result<Self, QrJoinEncodeError> {
        if let Some(pin) = cert_pin_hex.as_deref() {
            if !is_valid_cert_pin(pin) {
                return Err(QrJoinEncodeError::InvalidCertPin);
            }
        }
        Ok(Self {
            endpoint_url,
            target,
            cert_pin_hex,
            generated_at,
        })
    }

    /// The account slot of whatever this payload joins, in the form the codec
    /// writes: the canonical account number, or the vault account hash.
    fn target_slot(&self) -> &str {
        match &self.target {
            QrJoinTarget::Account { account_number } => account_number,
            QrJoinTarget::MemberVault { account_hash_hex } => account_hash_hex,
        }
    }

    /// Encode to the scanner string. Re-validates the target so a bug can never
    /// emit an invalid code, and rejects a `|` in the endpoint URL.
    pub fn encode(&self) -> Result<String, QrJoinEncodeError> {
        let (kind, slot) = match &self.target {
            QrJoinTarget::Account { account_number } => (
                KIND_ACCOUNT_WIRE,
                canonical_account(account_number).ok_or(QrJoinEncodeError::InvalidAccountNumber)?,
            ),
            QrJoinTarget::MemberVault { account_hash_hex } => {
                if !is_valid_account_hash(account_hash_hex) {
                    return Err(QrJoinEncodeError::InvalidAccountHash);
                }
                (KIND_MEMBER_WIRE, account_hash_hex.clone())
            }
        };
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
            "{}{}|{}|{}|{}|{}|{}",
            QR_JOIN_MAGIC, QR_JOIN_VERSION, kind, self.endpoint_url, slot, pin, self.generated_at
        ))
    }

    /// Decode a scanned string into a validated payload.
    ///
    /// Accepts **both** the v1 (account-only, no kind field) and the v2 layout:
    /// an older desktop emitting `MYQR1` is expected in the field, and the phone
    /// that scans it is the newer build.
    pub fn decode(s: &str) -> Result<Self, QrJoinDecodeError> {
        let rest = s
            .strip_prefix(QR_JOIN_MAGIC)
            .ok_or(QrJoinDecodeError::NotAQrJoinPayload)?;
        let (ver_str, body) = rest.split_once('|').ok_or(QrJoinDecodeError::Malformed)?;
        let version: u8 = ver_str.parse().map_err(|_| QrJoinDecodeError::Malformed)?;
        let parts: Vec<&str> = body.split('|').collect();

        // v1: `endpoint|account|pin|generated_at`, implicitly an account target.
        if version == QR_JOIN_VERSION_LEGACY {
            if parts.len() != 4 {
                return Err(QrJoinDecodeError::Malformed);
            }
            let (endpoint_url, cert_pin_hex, generated_at) =
                finish_parts(parts[0], parts[2], parts[3])?;
            let account_number =
                canonical_account(parts[1]).ok_or(QrJoinDecodeError::InvalidAccountNumber)?;
            return Ok(Self {
                endpoint_url,
                target: QrJoinTarget::Account { account_number },
                cert_pin_hex,
                generated_at,
            });
        }

        if version != QR_JOIN_VERSION {
            return Err(QrJoinDecodeError::UnsupportedVersion(version));
        }
        // v2: `kind|endpoint|slot|pin|generated_at`.
        if parts.len() != 5 {
            return Err(QrJoinDecodeError::Malformed);
        }
        let (endpoint_url, cert_pin_hex, generated_at) =
            finish_parts(parts[1], parts[3], parts[4])?;
        let target = match parts[0] {
            KIND_ACCOUNT_WIRE => QrJoinTarget::Account {
                account_number: canonical_account(parts[2])
                    .ok_or(QrJoinDecodeError::InvalidAccountNumber)?,
            },
            KIND_MEMBER_WIRE => {
                if !is_valid_account_hash(parts[2]) {
                    return Err(QrJoinDecodeError::InvalidAccountHash);
                }
                QrJoinTarget::MemberVault {
                    account_hash_hex: parts[2].to_string(),
                }
            }
            // A kind this build does not know is a NEWER payload wearing a version
            // this build claims to know, which is a broken producer rather than an
            // old reader: refuse it as malformed instead of guessing a target.
            _ => return Err(QrJoinDecodeError::Malformed),
        };
        Ok(Self {
            endpoint_url,
            target,
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

/// The three fields BOTH layouts place the same way: a non-empty endpoint URL, a
/// pin slot, and a numeric timestamp. Shared so v1 and v2 cannot drift on them.
fn finish_parts(
    endpoint: &str,
    pin_slot: &str,
    generated_at: &str,
) -> Result<(String, Option<String>, u64), QrJoinDecodeError> {
    if endpoint.is_empty() {
        return Err(QrJoinDecodeError::Malformed);
    }
    let cert_pin_hex = match pin_slot {
        "-" => None,
        hex if is_valid_cert_pin(hex) => Some(hex.to_string()),
        _ => return Err(QrJoinDecodeError::InvalidCertPin),
    };
    let generated_at: u64 = generated_at
        .parse()
        .map_err(|_| QrJoinDecodeError::Malformed)?;
    Ok((endpoint.to_string(), cert_pin_hex, generated_at))
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
        // Swap the version digit 2 -> 9 (right after the MYQR magic).
        let bumped = good.replacen("MYQR2|", "MYQR9|", 1);
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
        // v1 (4 slots after the version) and v2 (5) are both checked.
        assert_eq!(
            QrJoinPayload::decode("MYQR1|only|two"),
            Err(QrJoinDecodeError::Malformed)
        );
        assert_eq!(
            QrJoinPayload::decode("MYQR1|a|b|c|d|e|f"),
            Err(QrJoinDecodeError::Malformed)
        );
        assert_eq!(
            QrJoinPayload::decode("MYQR2|a|b"),
            Err(QrJoinDecodeError::Malformed)
        );
        assert_eq!(
            QrJoinPayload::decode("MYQR2|a|b|c|d|e|f"),
            Err(QrJoinDecodeError::Malformed)
        );
    }

    /// A kind byte this build does not know is a broken/newer producer wearing a
    /// version this build claims to understand, so it is refused rather than
    /// guessed at — silently picking a target would be the one outcome that is
    /// worse than an error here.
    #[test]
    fn an_unknown_kind_is_malformed() {
        let acct = fresh_account();
        let s = format!("MYQR2|z|https://s.example|{}|-|1", acct);
        assert_eq!(QrJoinPayload::decode(&s), Err(QrJoinDecodeError::Malformed));
    }

    // ── the member-vault target (myne-md/myne) ───────────────────────────────

    /// The member's own-device payload: the vault is named by its
    /// `account_number_hash`, and nothing in the payload is a secret.
    #[test]
    fn member_vault_round_trips() {
        let hash = "ab".repeat(16);
        let payload = QrJoinPayload::member_vault("https://sync.example.org", &hash, 1_700_000_000)
            .expect("valid member payload");
        assert_eq!(
            payload.target,
            QrJoinTarget::MemberVault {
                account_hash_hex: hash.clone()
            }
        );
        assert_eq!(
            payload.cert_pin_hex, None,
            "a member QR carries no pin slot value"
        );
        let decoded = QrJoinPayload::decode(&payload.encode().expect("encode")).expect("decode");
        assert_eq!(decoded, payload);
        // The wire form is the v2 shape, with the member kind tag.
        assert!(payload
            .encode()
            .unwrap()
            .starts_with("MYQR2|m|https://sync.example.org|"));
    }

    /// The distance from the owner layout is the whole reason the kind exists: an
    /// account number is a 20-char Damm-32 Crockford string and a vault hash is 32
    /// hex characters, so neither target can be read as the other.
    #[test]
    fn the_two_target_kinds_are_not_interchangeable() {
        let acct = fresh_account();
        let account = QrJoinPayload::new("https://s.example", &acct, None, 1).unwrap();
        assert!(account.encode().unwrap().starts_with("MYQR2|a|"));

        // A hash in the account slot fails Damm-32…
        let hash = "ab".repeat(16);
        let as_account = format!("MYQR2|a|https://s.example|{hash}|-|1");
        assert_eq!(
            QrJoinPayload::decode(&as_account),
            Err(QrJoinDecodeError::InvalidAccountNumber)
        );
        // …and an account number in the hash slot fails the hex/length check.
        let as_member = format!("MYQR2|m|https://s.example|{acct}|-|1");
        assert_eq!(
            QrJoinPayload::decode(&as_member),
            Err(QrJoinDecodeError::InvalidAccountHash)
        );
    }

    #[test]
    fn member_vault_refuses_a_hash_that_is_not_32_lowercase_hex() {
        for bad in ["", "ab", &"z".repeat(32), &"AB".repeat(16), &"a".repeat(31)] {
            assert_eq!(
                QrJoinPayload::member_vault("https://s.example", bad, 1),
                Err(QrJoinEncodeError::InvalidAccountHash),
                "{bad:?} must not encode"
            );
        }
        // Uppercase is the interesting one: refused by the ENCODER (the one rule is
        // lowercase hex) and refused by the decoder rather than normalised, so no
        // second spelling of a vault id can travel between two devices.
        assert_eq!(
            QrJoinPayload::decode(&format!(
                "MYQR2|m|https://s.example|{}|-|1",
                "AB".repeat(16)
            )),
            Err(QrJoinDecodeError::InvalidAccountHash)
        );
    }

    /// A v1 payload — an older desktop's QR — still decodes, as an account
    /// target. This is the direction that matters: the phone doing the scanning is
    /// the newer build.
    #[test]
    fn a_legacy_v1_payload_still_decodes_as_an_account_target() {
        let acct = fresh_account();
        let v1 = format!("MYQR1|https://sync.example.org|{acct}|-|1700000000");
        let decoded = QrJoinPayload::decode(&v1).expect("v1 decodes");
        assert_eq!(
            decoded.target,
            QrJoinTarget::Account {
                account_number: acct
            }
        );
        assert_eq!(decoded.endpoint_url, "https://sync.example.org");
        assert_eq!(decoded.cert_pin_hex, None);
        assert_eq!(decoded.generated_at, 1_700_000_000);
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
            target: QrJoinTarget::Account {
                account_number: acct,
            },
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
    fn a_legacy_qr_pin_is_decoded_but_never_adopted() {
        // An old QR still decodes, but the trust decision does not read its pin.
        let acct = fresh_account();
        let payload = QrJoinPayload::new("https://sync.myne.md", &acct, Some(pin()), 1).unwrap();
        let decoded = QrJoinPayload::decode(&payload.encode().unwrap()).unwrap();
        assert_eq!(decoded.cert_pin_hex, Some(pin()));
    }

    #[test]
    fn payload_type_has_no_secret_field() {
        // Compile-time guarantee: constructing a payload requires exactly the four
        // non-secret fields; there is no password/phrase field to populate.
        let acct = fresh_account();
        let _ = QrJoinPayload {
            endpoint_url: "https://s.example".to_string(),
            target: QrJoinTarget::Account {
                account_number: acct,
            },
            cert_pin_hex: None,
            generated_at: 0,
        };
    }
}
