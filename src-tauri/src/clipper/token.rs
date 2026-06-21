//! Pairing challenge + scoped revocable token registry (TB10, task 4).
//!
//! This is the desktop side of the browser-extension **pairing handshake**
//! (`ext-foundation-handoff`, story 1/2/3/5/8/20). It fills the seam task 3
//! left in [`super::host`] — the [`super::host::PairingGate`] trait — with a
//! real token-registry-backed gate, plus the two primitives the WebView
//! pairing dialog drives:
//!
//! 1. **[`PairingChallenge`]** — a short, unpredictable numeric code drawn
//!    from the **core's existing CSPRNG** (`getrandom`, the OS CSPRNG the
//!    whole codebase already uses for nonces / salts / account numbers; NOT
//!    new crypto — see Open Q3). The same code is surfaced in the in-app
//!    dialog AND to the extension so the user compares them before
//!    accepting. It is a human-comparison nonce, never a key, never an AEAD
//!    input.
//! 2. **[`PairingToken`]** — a scoped, revocable, **append-only** capability
//!    bound to the **exact extension ID**. Its scope ceiling is
//!    **[`TokenScope::CreateClip`] + [`TokenScope::IsUnlockedStatus`]
//!    only** — the [`TokenScope`] enum *structurally cannot* express
//!    read / modify / delete / list, so a token can never authorize them
//!    (A14: a compromised build holds only this token, never a key). The
//!    token is **not a key**: it carries no vault material, derives nothing,
//!    and is meaningless without the desktop's authoritative registry.
//! 3. **[`TokenRegistry`]** — the desktop's authoritative record of issued /
//!    revoked tokens. `issue` appends, `revoke` flips a flag (history is
//!    never rewritten — append-only), and `validate` answers
//!    valid / invalid / revoked / missing. [`RegistryGate`] adapts a
//!    `(extension_id, token)` claim + a registry snapshot into the host's
//!    [`super::host::PairingGate`], so the host accepts a valid token and
//!    stays **silent** to an invalid / revoked / missing one.
//!
//! ## In-memory now; durable in task 7 (clean seam)
//!
//! The registry is held **in memory** here. Task 7 makes it durable
//! (encrypted at rest in the prefs-family blob, root_key-derived) so pairing
//! survives a desktop restart and revocation stays durable. The seam: the
//! registry is a plain serializable value ([`TokenRegistry`] derives
//! `Serialize`/`Deserialize`) with no I/O of its own — task 7 wires the
//! load-at-boot / persist-on-change without touching this model. The host
//! process and the WebView app process observe the same registry through
//! that persisted blob (they are separate OS processes — the host is the
//! browser-launched stdio binary, the dialog runs in the Tauri app); until
//! task 7's at-rest representation lands, a fresh pairing per process is the
//! in-memory behaviour.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline" — a token value
//! and an extension ID are vault-stable correlation tags (the `salts,
//! nonces` / `note_id` class); never logged. Only bounded outcome labels are
//! emitted.
//!
//! ## "Consumed later" surface (`allow(dead_code)` in non-test builds)
//!
//! The token MODEL lands here in full (mint / validate / revoke / the host
//! [`RegistryGate`]), exercised end-to-end by this module's unit tests, but
//! several pieces are not yet referenced by the non-test library:
//! - the host process does not yet READ a connection's claimed
//!   `(extension_id, token)` to build a [`RegistryGate`] — that wiring is the
//!   host's envelope-decode seam (**task 5**), which threads the token field
//!   off the frame before validating;
//! - the registry's at-rest persistence (load/snapshot) is **task 7**.
//!
//! Rather than gate each item, the module carries one
//! `#![cfg_attr(not(test), allow(dead_code))]` with this justification —
//! exactly the seam discipline `manifest.rs` uses for its not-yet-installed
//! generator. The plugin side (`plugins::clipper_pairing`) DOES consume the
//! mint/registry surface today, so the model is not dead — only its
//! host-side reader is pending.
#![cfg_attr(not(test), allow(dead_code))]

use serde::{Deserialize, Serialize};
use subtle::ConstantTimeEq;

use super::host::PairingGate;

/// Constant-time equality for the bearer token VALUE (32-byte CSPRNG secret, hex).
///
/// The `extension_id` is non-secret and is compared ordinarily; only the token
/// value is a guessable secret, so its comparison must not leak a byte-by-byte
/// timing oracle — the codebase's crypto discipline (`subtle::ConstantTimeEq`,
/// as used for AEAD tag verification in `protocol::aead`). A length mismatch
/// short-circuits to `false` (the length is not the secret; both legitimate
/// values are 64 hex chars).
fn token_value_ct_eq(a: &str, b: &str) -> bool {
    a.as_bytes().ct_eq(b.as_bytes()).into()
}

/// Number of decimal digits in a [`PairingChallenge`].
///
/// Six digits (000000–999999) is the Anytype / Joplin pairing-code length:
/// short enough to read aloud / compare at a glance, with 10^6 possibilities
/// so a blind guess during the brief pairing window is ~1-in-a-million. The
/// challenge is a **human-comparison nonce**, not a secret that gates
/// long-lived access (the token does that) — its only job is to let the user
/// confirm the extension showing code X is the one the desktop is pairing
/// with. The bound that matters for that job is unpredictability + a value
/// space too large to shoulder-surf or brute-force in the dialog's lifetime.
pub const CHALLENGE_DIGITS: usize = 6;

/// Number of random bytes in a [`PairingToken`] value: **32** (256 bits).
///
/// The token is an unguessable bearer capability — 256 bits of CSPRNG
/// entropy puts forging one out of reach, matching the entropy class of the
/// codebase's key material widths (it is NOT a key, but it shares the
/// "unguessable random bytes from `getrandom`" provenance).
pub const TOKEN_BYTES: usize = 32;

/// The capability scope of a [`PairingToken`] — the **append-only ceiling**.
///
/// This enum is the structural guarantee behind the A14 / TB10 claim that a
/// compromised extension can only ever **create** clips and **ask** whether
/// the vault is unlocked. There is deliberately **no** `Read`, `Modify`,
/// `Delete`, `List`, or any-CRUD variant — the type system makes a
/// read/modify/delete authorization **inexpressible**, not merely unchecked.
/// Adding such a variant would be a TB10-boundary change, not a refactor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum TokenScope {
    /// Authorizes a single keyless clip handoff (the host composes the note
    /// and calls the existing `note_create`; task 6). Append-only: it can
    /// add a note, never read / modify / delete an existing one.
    CreateClip,
    /// Authorizes asking whether the vault is currently unlocked (drives the
    /// extension's "Unlock Myne" affordance; task 5). A pure status read of
    /// the `Slot::Unlocked` / `Slot::Locked` runtime state — it exposes no
    /// vault content, no structure (AS3/AS5), nothing but the boolean.
    IsUnlockedStatus,
}

impl TokenScope {
    /// The full append-only ceiling: exactly `create-clip` +
    /// `is-unlocked-status`. This is the ONLY scope set [`PairingToken::mint`]
    /// grants — there is no API to grant a narrower or wider set, so every
    /// minted token carries precisely these two capabilities and nothing
    /// else.
    pub const CEILING: [TokenScope; 2] = [TokenScope::CreateClip, TokenScope::IsUnlockedStatus];
}

/// A short, unpredictable numeric pairing challenge.
///
/// Drawn from the core CSPRNG ([`PairingChallenge::generate`] → `getrandom`).
/// Surfaced identically in the in-app dialog and to the extension; the user
/// compares the two before accepting. Display form is the zero-padded
/// [`CHALLENGE_DIGITS`]-digit decimal string ([`PairingChallenge::display`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairingChallenge {
    /// The numeric value in `0..10^CHALLENGE_DIGITS`.
    value: u32,
}

impl PairingChallenge {
    /// The exclusive upper bound on the challenge value (`10^CHALLENGE_DIGITS`).
    const MODULUS: u32 = 1_000_000; // 10^6 — keep in step with CHALLENGE_DIGITS.

    /// Generate a fresh challenge from the **core CSPRNG** (`getrandom`).
    ///
    /// Pulls 4 random bytes from the OS CSPRNG (the same `getrandom` source
    /// every nonce / salt / account number in the codebase uses) and reduces
    /// them into `0..MODULUS`. The modulo bias across a `u32` folded into
    /// 10^6 is ~10^6 / 2^32 ≈ 0.0002 — utterly negligible for a
    /// human-comparison nonce (it is not key material). Returns
    /// [`ChallengeError::CsprngUnavailable`] only if the OS CSPRNG itself
    /// fails, which the codebase treats as fatal (`ProtocolError::Csprng`).
    pub fn generate() -> Result<Self, ChallengeError> {
        let mut buf = [0u8; 4];
        getrandom::getrandom(&mut buf).map_err(|_| ChallengeError::CsprngUnavailable)?;
        let raw = u32::from_le_bytes(buf);
        Ok(PairingChallenge {
            value: raw % Self::MODULUS,
        })
    }

    /// Construct a challenge from an explicit value (tests + deserialization
    /// of a persisted pending session). Reduces into range defensively.
    pub fn from_value(value: u32) -> Self {
        PairingChallenge {
            value: value % Self::MODULUS,
        }
    }

    /// The raw numeric value (`0..10^CHALLENGE_DIGITS`).
    pub fn value(&self) -> u32 {
        self.value
    }

    /// The zero-padded [`CHALLENGE_DIGITS`]-digit decimal string the user
    /// compares (e.g. `42` → `"000042"`). The extension renders the same
    /// form so the two strings match character-for-character.
    pub fn display(&self) -> String {
        format!("{:0width$}", self.value, width = CHALLENGE_DIGITS)
    }
}

/// Why generating a [`PairingChallenge`] failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ChallengeError {
    /// The OS CSPRNG (`getrandom`) was unavailable. Fatal, like
    /// `protocol::ProtocolError::Csprng`.
    CsprngUnavailable,
}

impl ChallengeError {
    /// Stable `&'static str` label for tracing / serialization.
    pub fn label(&self) -> &'static str {
        match self {
            ChallengeError::CsprngUnavailable => "csprng_unavailable",
        }
    }
}

/// A scoped, revocable pairing token bound to one exact extension ID.
///
/// Minted on **Accept** ([`PairingToken::mint`]). The `value` is 32 CSPRNG
/// bytes (hex-encoded for the wire / `chrome.storage`); `extension_id` is the
/// exact ID the manifest allowlists, and the token is meaningless against any
/// other ID (binding is checked in [`TokenRegistry::validate`]). The scope is
/// always the full [`TokenScope::CEILING`] — there is no API to mint a
/// broader one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairingToken {
    /// The opaque bearer value (hex of 32 CSPRNG bytes). The extension stores
    /// this and presents it on every handoff.
    value: String,
    /// The EXACT extension ID this token is bound to. A token presented for
    /// any other ID is invalid (binding mismatch).
    extension_id: String,
    /// The granted capabilities — always [`TokenScope::CEILING`].
    scope: Vec<TokenScope>,
}

impl PairingToken {
    /// Mint a fresh token bound to `extension_id`, scoped to the full
    /// append-only ceiling (`create-clip` + `is-unlocked-status`).
    ///
    /// The value is 32 bytes from the core CSPRNG (`getrandom`), hex-encoded.
    /// Returns [`ChallengeError::CsprngUnavailable`] if the OS CSPRNG fails.
    pub fn mint(extension_id: impl Into<String>) -> Result<Self, ChallengeError> {
        let mut buf = [0u8; TOKEN_BYTES];
        getrandom::getrandom(&mut buf).map_err(|_| ChallengeError::CsprngUnavailable)?;
        Ok(PairingToken {
            value: hex_lower(&buf),
            extension_id: extension_id.into(),
            scope: TokenScope::CEILING.to_vec(),
        })
    }

    /// The opaque bearer value (hex string).
    pub fn value(&self) -> &str {
        &self.value
    }

    /// The exact extension ID this token is bound to.
    pub fn extension_id(&self) -> &str {
        &self.extension_id
    }

    /// The granted scope set (always the ceiling).
    pub fn scope(&self) -> &[TokenScope] {
        &self.scope
    }

    /// Whether this token authorizes `scope`. True only for the two ceiling
    /// capabilities; structurally false for anything else (the enum has no
    /// other variants, so this is exhaustive by construction).
    pub fn authorizes(&self, scope: TokenScope) -> bool {
        self.scope.contains(&scope)
    }

    /// Reconstruct a token from its two persisted scalars (the bearer `value`
    /// and the bound `extension_id`), re-applying the full append-only scope
    /// ceiling.
    ///
    /// Used by [`TokenRegistry::from_paired_extensions`] to hydrate the registry
    /// from the decrypted `vault.prefs` blob (`ext-foundation-handoff` task 7,
    /// MYND-443). The scope is **never** read from disk — it is structurally
    /// fixed here, so a tampered/replayed record can never carry a wider grant
    /// (`threat-model.md` § 7 local-prefs-replay): the on-disk form has no place
    /// to express read/modify/delete, and this constructor only ever grants the
    /// ceiling.
    pub fn from_parts(extension_id: impl Into<String>, value: impl Into<String>) -> Self {
        PairingToken {
            value: value.into(),
            extension_id: extension_id.into(),
            scope: TokenScope::CEILING.to_vec(),
        }
    }
}

/// One row in the [`TokenRegistry`]: an issued token plus its revocation
/// flag. Append-only — a revoke flips `revoked`, it never deletes the row, so
/// the registry is a faithful history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct TokenRecord {
    token: PairingToken,
    revoked: bool,
    /// Unix seconds when this token was issued (the in-app Accept time), or
    /// `None` for a record hydrated from a pre-feature persisted form. Display
    /// metadata for the Connected-extensions list; never part of validation.
    #[serde(default)]
    paired_at: Option<u64>,
}

/// Current Unix time in whole seconds, or `None` if the clock predates the epoch
/// (never in practice). The pairing timestamp is user-meaningful display
/// metadata, so coarse second granularity is intentional.
fn now_unix_secs() -> Option<u64> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

/// The desktop's authoritative record of issued / revoked pairing tokens.
///
/// **Append-only:** [`TokenRegistry::issue`] pushes a new record;
/// [`TokenRegistry::revoke`] flips the `revoked` flag on matching records but
/// never removes them. A previously-revoked extension can **re-pair** —
/// `issue` appends a fresh, non-revoked record, and [`TokenRegistry::validate`]
/// only honours the live (non-revoked) token, so the old revoked one stays
/// dead while the new one works.
///
/// In-memory here; task 7 persists it (encrypted, prefs-family blob). The
/// type derives `Serialize`/`Deserialize` precisely so task 7 can round-trip
/// it through that blob without changing this model.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenRegistry {
    records: Vec<TokenRecord>,
}

/// The outcome of validating a `(extension_id, token_value)` claim against
/// the registry. The host maps everything that is NOT [`Valid`] to silence
/// (no write, no reply) — an invalid / revoked / missing claim is
/// indistinguishable to the caller, which is the silent-to-unpaired contract.
///
/// [`Valid`]: TokenValidation::Valid
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenValidation {
    /// A live (issued, non-revoked) token whose value AND bound extension ID
    /// both match. The host accepts the handoff.
    Valid,
    /// The token value matches a record but that record is revoked. Treated
    /// exactly like `Missing` by the host (silent) — surfaced distinctly only
    /// for tests / internal reasoning.
    Revoked,
    /// No issued token matches the presented `(extension_id, value)` pair
    /// (never issued, value mismatch, or bound to a different extension ID).
    Missing,
}

impl TokenRegistry {
    /// An empty registry (no tokens issued yet).
    pub fn new() -> Self {
        TokenRegistry::default()
    }

    /// Mint a token for `extension_id` and append it (Accept path).
    ///
    /// Returns the minted [`PairingToken`] (its value is handed to the
    /// extension over the wire). Re-pairing a previously-revoked extension is
    /// just another `issue` — the old revoked record stays, a fresh live one
    /// is appended.
    pub fn issue(
        &mut self,
        extension_id: impl Into<String>,
    ) -> Result<PairingToken, ChallengeError> {
        let token = PairingToken::mint(extension_id)?;
        self.records.push(TokenRecord {
            token: token.clone(),
            revoked: false,
            paired_at: now_unix_secs(),
        });
        Ok(token)
    }

    /// Append an already-minted token (used when the mint happened elsewhere,
    /// e.g. the pending-session flow mints then commits). Append-only.
    pub fn insert(&mut self, token: PairingToken) {
        self.records.push(TokenRecord {
            token,
            revoked: false,
            paired_at: now_unix_secs(),
        });
    }

    /// Revoke every live token bound to `extension_id` (immediate,
    /// desktop-authoritative; task 7's Revoke action calls this). Flips the
    /// `revoked` flag; never deletes. Returns the number of records revoked
    /// (0 if the extension had no live token).
    pub fn revoke_extension(&mut self, extension_id: &str) -> usize {
        let mut n = 0;
        for rec in &mut self.records {
            if rec.token.extension_id() == extension_id && !rec.revoked {
                rec.revoked = true;
                n += 1;
            }
        }
        n
    }

    /// Revoke the single token whose value matches `value` (if any). Flips
    /// the flag; never deletes. Returns whether a live record was revoked.
    pub fn revoke_value(&mut self, value: &str) -> bool {
        for rec in &mut self.records {
            if rec.token.value() == value && !rec.revoked {
                rec.revoked = true;
                return true;
            }
        }
        false
    }

    /// Validate a `(extension_id, token_value)` claim from a handoff.
    ///
    /// Returns [`TokenValidation::Valid`] only if there is a **live**
    /// (non-revoked) record whose value AND bound extension ID both match the
    /// claim. A value that matches only a revoked record →
    /// [`TokenValidation::Revoked`]; anything else (never issued, value
    /// mismatch, ID mismatch) → [`TokenValidation::Missing`]. The host
    /// collapses everything but `Valid` to silence.
    pub fn validate(&self, extension_id: &str, token_value: &str) -> TokenValidation {
        // A live, fully-matching record wins outright. The non-secret
        // extension_id is matched first (ordinary ==); the secret token value is
        // compared in constant time.
        if self.records.iter().any(|r| {
            !r.revoked
                && r.token.extension_id() == extension_id
                && token_value_ct_eq(r.token.value(), token_value)
        }) {
            return TokenValidation::Valid;
        }
        // A value that matches a revoked record (same binding) is explicitly
        // Revoked — distinct from never-issued, though the host treats both
        // as silence.
        if self.records.iter().any(|r| {
            r.revoked
                && r.token.extension_id() == extension_id
                && token_value_ct_eq(r.token.value(), token_value)
        }) {
            return TokenValidation::Revoked;
        }
        TokenValidation::Missing
    }

    /// Whether `extension_id` currently has at least one live token (used by
    /// the Settings "Connected extensions" list in task 7).
    pub fn has_live_token(&self, extension_id: &str) -> bool {
        self.records
            .iter()
            .any(|r| !r.revoked && r.token.extension_id() == extension_id)
    }

    /// The DISTINCT extension ids that currently have at least one live
    /// (issued, non-revoked) token — the Settings "Connected extensions" list
    /// (task 7, MYND-443). De-duplicated (a re-pair appends a fresh record, so
    /// an extension can hold more than one live token) and sorted for a stable
    /// UI order. Extension ids are AS-low correlation tags but **not** the token
    /// value — safe to surface to the WebView list command.
    pub fn live_extension_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .records
            .iter()
            .filter(|r| !r.revoked)
            .map(|r| r.token.extension_id().to_string())
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }

    /// The live (non-revoked) extensions paired with this vault, each with its
    /// issue time (`None` for a pre-feature record). Sorted + deduped by
    /// extension id — there is at most one live record per extension (a re-pair
    /// revokes the old and appends a new live one), so the dedup is defensive.
    /// Drives the Connected-extensions list (extension id + "connected when").
    pub fn live_paired(&self) -> Vec<(String, Option<u64>)> {
        let mut out: Vec<(String, Option<u64>)> = self
            .records
            .iter()
            .filter(|r| !r.revoked)
            .map(|r| (r.token.extension_id().to_string(), r.paired_at))
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out.dedup_by(|a, b| a.0 == b.0);
        out
    }

    /// Project the registry to its on-disk record form — the
    /// [`protocol::PairedExtension`] array the `vault.prefs` `paired_extensions`
    /// field carries (task-7 persist seam, MYND-443). Lossless against
    /// [`Self::from_paired_extensions`]: the three persisted scalars
    /// (`extension_id`, `token_value`, `revoked`) fully determine an equal
    /// registry, because every token's scope is the structural ceiling and is
    /// re-applied on load. The scope is deliberately NOT exported (it cannot be
    /// anything other than the ceiling).
    pub fn to_paired_extensions(&self) -> Vec<protocol::PairedExtension> {
        self.records
            .iter()
            .map(|r| protocol::PairedExtension {
                extension_id: r.token.extension_id().to_string(),
                token_value: r.token.value().to_string(),
                revoked: r.revoked,
                paired_at: r.paired_at,
            })
            .collect()
    }

    /// Hydrate a registry from its on-disk record form (task-7 load seam,
    /// MYND-443) — the inverse of [`Self::to_paired_extensions`]. Each record's
    /// token is reconstructed via [`PairingToken::from_parts`], which re-applies
    /// the full append-only scope ceiling; the on-disk form never carries a
    /// scope, so a tampered/replayed blob can never widen a grant.
    pub fn from_paired_extensions(records: &[protocol::PairedExtension]) -> Self {
        TokenRegistry {
            records: records
                .iter()
                .map(|r| TokenRecord {
                    token: PairingToken::from_parts(r.extension_id.clone(), r.token_value.clone()),
                    revoked: r.revoked,
                    paired_at: r.paired_at,
                })
                .collect(),
        }
    }
}

/// A [`PairingGate`] backed by the [`TokenRegistry`] and the claim presented
/// on the connection.
///
/// This is what task 4 swaps in for task 3's `UnpairedGate`: the host
/// constructs a `RegistryGate` from the connecting extension's claimed
/// `(extension_id, token_value)` plus the current registry snapshot, and
/// [`PairingGate::is_paired`] is `true` only when the claim validates to
/// [`TokenValidation::Valid`]. A missing / invalid / revoked claim →
/// `is_paired() == false` → the host writes nothing (the silent-to-unpaired
/// contract from task 3, now driven by real tokens).
pub struct RegistryGate<'a> {
    registry: &'a TokenRegistry,
    extension_id: String,
    token_value: String,
}

impl<'a> RegistryGate<'a> {
    /// Build a gate for a connection presenting `(extension_id, token_value)`.
    pub fn new(
        registry: &'a TokenRegistry,
        extension_id: impl Into<String>,
        token_value: impl Into<String>,
    ) -> Self {
        RegistryGate {
            registry,
            extension_id: extension_id.into(),
            token_value: token_value.into(),
        }
    }

    /// The closed validation outcome (exposed for callers that want to
    /// distinguish revoked from missing for logging; the host only needs the
    /// boolean from [`PairingGate::is_paired`]).
    pub fn validation(&self) -> TokenValidation {
        self.registry
            .validate(&self.extension_id, &self.token_value)
    }
}

impl PairingGate for RegistryGate<'_> {
    fn is_paired(&self) -> bool {
        matches!(self.validation(), TokenValidation::Valid)
    }
}

/// Lowercase hex of a byte slice (no `hex` crate dependency — a tiny local
/// helper, the same posture the codebase takes for small encodings).
fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    const EXT_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const EXT_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    // ---- challenge: CSPRNG source + unpredictability + length ----------

    #[test]
    fn challenge_error_label_is_stable() {
        assert_eq!(
            ChallengeError::CsprngUnavailable.label(),
            "csprng_unavailable"
        );
    }

    #[test]
    fn challenge_display_is_zero_padded_to_challenge_digits() {
        assert_eq!(PairingChallenge::from_value(42).display(), "000042");
        assert_eq!(PairingChallenge::from_value(0).display(), "000000");
        assert_eq!(PairingChallenge::from_value(999_999).display(), "999999");
        assert_eq!(
            PairingChallenge::from_value(42).display().len(),
            CHALLENGE_DIGITS
        );
    }

    #[test]
    fn challenge_value_is_always_within_range() {
        // from_value reduces defensively; an out-of-range input wraps in.
        assert!(PairingChallenge::from_value(1_000_000).value() < 1_000_000);
        assert!(PairingChallenge::from_value(u32::MAX).value() < 1_000_000);
    }

    #[test]
    fn generated_challenge_draws_from_csprng_and_is_in_range() {
        // Exercises the real getrandom path (the core CSPRNG). Every
        // generated value must land in 0..10^6 and the display is always
        // CHALLENGE_DIGITS chars.
        for _ in 0..256 {
            let c = PairingChallenge::generate().expect("core CSPRNG available");
            assert!(
                c.value() < 1_000_000,
                "challenge out of range: {}",
                c.value()
            );
            assert_eq!(c.display().len(), CHALLENGE_DIGITS);
        }
    }

    #[test]
    fn generated_challenges_are_unpredictable_not_constant() {
        // A weak source (constant / counter) would collapse the set. 256
        // draws from a 10^6 space should yield many distinct values; assert
        // a generous lower bound so the test is not flaky on the birthday
        // paradox yet still fails a constant source dead.
        let mut seen = HashSet::new();
        for _ in 0..256 {
            seen.insert(PairingChallenge::generate().unwrap().value());
        }
        assert!(
            seen.len() > 200,
            "challenges look non-random: only {} distinct of 256",
            seen.len()
        );
    }

    // ---- token: binding + scope ceiling (append-only) ------------------

    #[test]
    fn minted_token_is_bound_to_the_exact_extension_id() {
        let t = PairingToken::mint(EXT_A).unwrap();
        assert_eq!(t.extension_id(), EXT_A);
        assert_ne!(t.extension_id(), EXT_B);
    }

    #[test]
    fn minted_token_value_is_unguessable_and_distinct_per_mint() {
        let t1 = PairingToken::mint(EXT_A).unwrap();
        let t2 = PairingToken::mint(EXT_A).unwrap();
        // 32 bytes → 64 hex chars; two mints never collide.
        assert_eq!(t1.value().len(), TOKEN_BYTES * 2);
        assert!(t1.value().bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(t1.value(), t2.value());
    }

    #[test]
    fn token_scope_is_exactly_create_clip_plus_is_unlocked_status() {
        let t = PairingToken::mint(EXT_A).unwrap();
        assert!(t.authorizes(TokenScope::CreateClip));
        assert!(t.authorizes(TokenScope::IsUnlockedStatus));
        // The ceiling is EXACTLY these two — no more, no fewer.
        assert_eq!(t.scope().len(), 2);
        let set: HashSet<_> = t.scope().iter().copied().collect();
        assert_eq!(
            set,
            HashSet::from([TokenScope::CreateClip, TokenScope::IsUnlockedStatus])
        );
    }

    #[test]
    fn token_cannot_authorize_read_modify_or_delete_by_construction() {
        // The structural guarantee: TokenScope has NO read/modify/delete/list
        // variant, so a token cannot even *name* such an authorization. This
        // test pins the enum's exhaustive shape — adding a CRUD variant
        // (a TB10-boundary change) would force this match to be updated and
        // make the regression loud.
        let t = PairingToken::mint(EXT_A).unwrap();
        for scope in t.scope() {
            match scope {
                TokenScope::CreateClip | TokenScope::IsUnlockedStatus => {}
            }
        }
        // The full ceiling constant is also exactly these two.
        assert_eq!(
            TokenScope::CEILING,
            [TokenScope::CreateClip, TokenScope::IsUnlockedStatus]
        );
    }

    // ---- registry: issue / validate / revoke / re-pair -----------------

    #[test]
    fn issued_token_validates_for_its_exact_extension_id() {
        let mut reg = TokenRegistry::new();
        let t = reg.issue(EXT_A).unwrap();
        assert_eq!(reg.validate(EXT_A, t.value()), TokenValidation::Valid);
    }

    #[test]
    fn token_does_not_validate_for_a_different_extension_id() {
        // Binding to the EXACT ID: the right value but the wrong ID is
        // Missing (a stolen token replayed under another ID never validates).
        let mut reg = TokenRegistry::new();
        let t = reg.issue(EXT_A).unwrap();
        assert_eq!(reg.validate(EXT_B, t.value()), TokenValidation::Missing);
    }

    #[test]
    fn unknown_or_garbage_token_value_is_missing() {
        let mut reg = TokenRegistry::new();
        let _ = reg.issue(EXT_A).unwrap();
        assert_eq!(
            reg.validate(EXT_A, "not-a-real-token"),
            TokenValidation::Missing
        );
        assert_eq!(reg.validate(EXT_A, ""), TokenValidation::Missing);
    }

    #[test]
    fn empty_registry_validates_nothing() {
        let reg = TokenRegistry::new();
        assert_eq!(reg.validate(EXT_A, "anything"), TokenValidation::Missing);
        assert!(!reg.has_live_token(EXT_A));
    }

    #[test]
    fn revoked_token_no_longer_validates() {
        let mut reg = TokenRegistry::new();
        let t = reg.issue(EXT_A).unwrap();
        assert_eq!(reg.validate(EXT_A, t.value()), TokenValidation::Valid);
        let n = reg.revoke_extension(EXT_A);
        assert_eq!(n, 1);
        assert_eq!(reg.validate(EXT_A, t.value()), TokenValidation::Revoked);
        assert!(!reg.has_live_token(EXT_A));
    }

    #[test]
    fn revoke_is_append_only_history_is_preserved() {
        // Revoke flips a flag, never removes the row — the record count only
        // grows. (Task 7 persists this faithful history.)
        let mut reg = TokenRegistry::new();
        let _t = reg.issue(EXT_A).unwrap();
        let before = reg.records.len();
        reg.revoke_extension(EXT_A);
        assert_eq!(
            reg.records.len(),
            before,
            "revoke must not delete the record"
        );
    }

    #[test]
    fn revoked_extension_can_re_pair_through_a_fresh_issue() {
        // Story 8: a previously-revoked extension pairs again via the same
        // flow. The old revoked token stays dead; the new one is live.
        let mut reg = TokenRegistry::new();
        let old = reg.issue(EXT_A).unwrap();
        reg.revoke_extension(EXT_A);
        assert_eq!(reg.validate(EXT_A, old.value()), TokenValidation::Revoked);

        let fresh = reg.issue(EXT_A).unwrap();
        assert_ne!(fresh.value(), old.value());
        // The fresh token works; the old one is still dead.
        assert_eq!(reg.validate(EXT_A, fresh.value()), TokenValidation::Valid);
        assert_eq!(reg.validate(EXT_A, old.value()), TokenValidation::Revoked);
        assert!(reg.has_live_token(EXT_A));
    }

    #[test]
    fn revoke_value_targets_one_token() {
        let mut reg = TokenRegistry::new();
        let t1 = reg.issue(EXT_A).unwrap();
        let t2 = reg.issue(EXT_A).unwrap();
        assert!(reg.revoke_value(t1.value()));
        assert_eq!(reg.validate(EXT_A, t1.value()), TokenValidation::Revoked);
        // The sibling token is untouched.
        assert_eq!(reg.validate(EXT_A, t2.value()), TokenValidation::Valid);
        // Revoking an unknown value is a no-op false.
        assert!(!reg.revoke_value("nope"));
    }

    // ---- RegistryGate ⇒ host PairingGate --------------------------------

    #[test]
    fn registry_gate_is_paired_only_for_a_valid_claim() {
        let mut reg = TokenRegistry::new();
        let t = reg.issue(EXT_A).unwrap();

        let valid = RegistryGate::new(&reg, EXT_A, t.value());
        assert!(valid.is_paired());
        assert_eq!(valid.validation(), TokenValidation::Valid);
    }

    #[test]
    fn registry_gate_is_silent_on_missing_invalid_and_revoked() {
        let mut reg = TokenRegistry::new();
        let t = reg.issue(EXT_A).unwrap();

        // Missing value.
        assert!(!RegistryGate::new(&reg, EXT_A, "garbage").is_paired());
        // Wrong extension id (binding mismatch).
        assert!(!RegistryGate::new(&reg, EXT_B, t.value()).is_paired());
        // Empty claim.
        assert!(!RegistryGate::new(&reg, "", "").is_paired());

        // Revoked.
        reg.revoke_extension(EXT_A);
        let revoked_gate = RegistryGate::new(&reg, EXT_A, t.value());
        assert!(!revoked_gate.is_paired());
        assert_eq!(revoked_gate.validation(), TokenValidation::Revoked);
    }

    // ---- on-disk PairedExtension projection (task-7 persistence seam) ---

    #[test]
    fn paired_extensions_round_trip_preserves_valid_and_revoked() {
        // The exact persistence path: issue → snapshot to PairedExtension →
        // hydrate a fresh registry → token still valid; a revoked record stays
        // revoked across the round-trip.
        let mut reg = TokenRegistry::new();
        let live = reg.issue(EXT_A).unwrap();
        let dead = reg.issue(EXT_B).unwrap();
        reg.revoke_extension(EXT_B);

        let records = reg.to_paired_extensions();
        let restored = TokenRegistry::from_paired_extensions(&records);

        // The restored registry is byte-for-byte the same logical registry.
        assert_eq!(restored, reg);
        // A live token still validates; the revoked one stays dead.
        assert_eq!(
            restored.validate(EXT_A, live.value()),
            TokenValidation::Valid
        );
        assert_eq!(
            restored.validate(EXT_B, dead.value()),
            TokenValidation::Revoked
        );
        assert!(restored.has_live_token(EXT_A));
        assert!(!restored.has_live_token(EXT_B));
    }

    #[test]
    fn paired_extensions_round_trip_via_registry_gate_rejects_revoked() {
        // The gate (the host's authority) must reject a revoked token after a
        // persist+load cycle — the durable-revocation acceptance criterion.
        let mut reg = TokenRegistry::new();
        let t = reg.issue(EXT_A).unwrap();
        reg.revoke_extension(EXT_A);

        let restored = TokenRegistry::from_paired_extensions(&reg.to_paired_extensions());
        let gate = RegistryGate::new(&restored, EXT_A, t.value());
        assert!(!gate.is_paired());
        assert_eq!(gate.validation(), TokenValidation::Revoked);
    }

    #[test]
    fn restored_token_carries_the_full_scope_ceiling() {
        // The scope is never persisted — from_parts re-applies the ceiling, so a
        // restored token authorizes exactly create-clip + is-unlocked-status and
        // nothing wider (the structural append-only guarantee survives a reload).
        let mut reg = TokenRegistry::new();
        reg.issue(EXT_A).unwrap();
        let restored = TokenRegistry::from_paired_extensions(&reg.to_paired_extensions());
        let rec = &restored.records[0];
        assert!(rec.token.authorizes(TokenScope::CreateClip));
        assert!(rec.token.authorizes(TokenScope::IsUnlockedStatus));
        assert_eq!(rec.token.scope().len(), 2);
    }

    #[test]
    fn live_extension_ids_are_distinct_and_sorted() {
        let mut reg = TokenRegistry::new();
        reg.issue(EXT_B).unwrap();
        reg.issue(EXT_A).unwrap();
        reg.issue(EXT_A).unwrap(); // a re-pair: a second live token for EXT_A
        let revoked = reg.issue("cccccccccccccccccccccccccccccccc").unwrap();
        reg.revoke_value(revoked.value());

        let ids = reg.live_extension_ids();
        // Sorted, de-duplicated, and the fully-revoked extension is excluded.
        assert_eq!(ids, vec![EXT_A.to_string(), EXT_B.to_string()]);
    }

    // ---- registry is round-trippable (task-7 persistence seam) ---------

    #[test]
    fn registry_round_trips_through_serde_for_task_7_persistence() {
        let mut reg = TokenRegistry::new();
        let t = reg.issue(EXT_A).unwrap();
        reg.issue(EXT_B).unwrap();
        reg.revoke_extension(EXT_B);

        let json = serde_json::to_string(&reg).expect("serialize registry");
        let back: TokenRegistry = serde_json::from_str(&json).expect("deserialize registry");
        assert_eq!(back, reg);
        // Behaviour survives the round-trip: A still valid, B still revoked.
        assert_eq!(back.validate(EXT_A, t.value()), TokenValidation::Valid);
        assert!(back.has_live_token(EXT_A));
        assert!(!back.has_live_token(EXT_B));
    }
}
