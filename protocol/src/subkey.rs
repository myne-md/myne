//! Single canonical HKDF helper — see `docs/spec/protocol.md` § 3.2, § 3.4.
//!
//! Every subkey derivation in the v0.1 protocol MUST go through
//! [`derive_subkey`]. Direct calls to `hkdf::Hkdf::expand` from outside
//! this module are forbidden by the CLAUDE.md "subkey derivation
//! discipline" rule; the rule is enforced structurally by keeping the
//! `hkdf` crate `pub(crate)`-only inside `protocol/` (no `pub use`
//! anywhere in `lib.rs`) and routing every primitive call through this
//! module's `derive_with_context`. External callers see only
//! [`derive_subkey`] + [`SubkeyRole`].
//!
//! ## Construction (spec § 3.2)
//!
//! ```text
//! salt   = zero_32  (32 zero bytes)
//! PRK    = HKDF-Extract(salt, root_key) = HMAC-SHA256(zero_32, root_key)
//! info   = "myne.v0.1 " || role         (no separator, no length prefix)
//! subkey = HKDF-Expand(PRK, info, 32)
//! ```
//!
//! `salt = zero_32` makes the Extract step deterministic on `root_key`.
//! Spec § 3.2 permits caching the PRK across multiple Expand calls in a
//! single vault session; this helper does not cache (Extract is a
//! single HMAC-SHA256 pass — under 1 µs on a 2024 desktop). Caller-side
//! caching is a Task-9 concern when the unlock path derives multiple
//! subkeys from the same `root_key` in tight succession.
//!
//! ## Role registry (spec § 3.4)
//!
//! v0.1 registers a single role:
//!
//! | Variant                    | Registered string  |
//! |----------------------------|--------------------|
//! | [`SubkeyRole::ItemsKeyWrap`] | `itemsKey-wrap`  |
//!
//! Future v0.1.x revisions may register additional roles by appending
//! variants to [`SubkeyRole`]. The `#[non_exhaustive]` attribute
//! prevents downstream code (companion repos, future feature branches)
//! from match-exhausting a stale list.

use alloc::vec::Vec;
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

/// Domain-separation prefix for every Myne v0.1 HKDF context string.
///
/// Spec § 1.2 + § 3.2.2 mandate this exact 10-byte sequence,
/// **including the trailing space** — it is part of the `info`
/// parameter that gets bound into every derived subkey. Any drift
/// here silently invalidates every existing vault.
const HKDF_PREFIX_V0_1: &[u8] = b"myne.v0.1 ";

/// Registered role string for the singleton v0.1 `itemsKey` wrap.
const ROLE_STR_ITEMS_KEY_WRAP: &[u8] = b"itemsKey-wrap";

/// Identifies which subkey is being derived from `root_key`.
///
/// Spec § 3.4: every public subkey role appears here as a variant.
/// Future revisions append variants. Construction-time misuse is
/// caught at compile time — unregistered roles cannot be expressed in
/// the type system, eliminating the historical HKDF foot-gun of
/// passing a malformed or empty `info` parameter.
#[non_exhaustive]
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum SubkeyRole {
    /// Wraps the singleton v0.1 `itemsKey`
    /// (spec § 3.3 key hierarchy, § 9.3 offset 281).
    ItemsKeyWrap,
}

impl SubkeyRole {
    /// Registered role string (the part appended after the
    /// `"myne.v0.1 "` prefix). Crate-internal so only
    /// [`derive_subkey`] / [`derive_with_context`] read it.
    pub(crate) fn role_str(self) -> &'static [u8] {
        match self {
            SubkeyRole::ItemsKeyWrap => ROLE_STR_ITEMS_KEY_WRAP,
        }
    }
}

/// Derive a 32-byte subkey from `root_key` for the given role.
///
/// This is the **only** public path through which any subkey is
/// derived in the Myne v0.1 protocol. Construction follows spec § 3.2
/// verbatim: HKDF-Extract over `root_key` with `salt = zero_32`, then
/// HKDF-Expand with `info = "myne.v0.1 " || role.role_str()` to a
/// 32-byte output.
///
/// The output is wrapped in [`Zeroizing`] so the bytes are
/// best-effort wiped when the returned value is dropped.
pub fn derive_subkey(root_key: &[u8; 32], role: SubkeyRole) -> Zeroizing<[u8; 32]> {
    let role_bytes = role.role_str();
    let mut info = Vec::with_capacity(HKDF_PREFIX_V0_1.len() + role_bytes.len());
    info.extend_from_slice(HKDF_PREFIX_V0_1);
    info.extend_from_slice(role_bytes);
    derive_with_context(root_key, &info)
}

/// HKDF-SHA-256 (Extract + Expand) over `root_key` with `salt =
/// zero_32` and an arbitrary `info` byte slice.
///
/// Stays `pub(crate)` — outside callers MUST go through
/// [`derive_subkey`] so the `info` bytes always come from the
/// registered role table. The function exists separately so the test
/// suite can verify spec § 3.2.2 properties (different `info` ⇒
/// different output) without exposing arbitrary-info derivation to
/// the public API.
pub(crate) fn derive_with_context(root_key: &[u8; 32], info: &[u8]) -> Zeroizing<[u8; 32]> {
    let zero_salt = [0u8; 32];
    let hk = Hkdf::<Sha256>::new(Some(&zero_salt), root_key);
    let mut okm = Zeroizing::new([0u8; 32]);
    hk.expand(info, &mut okm[..])
        .expect("HKDF-Expand for 32 bytes is well within the SHA-256 8160-byte limit");
    okm
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hkdf_prefix_is_exactly_myne_v0_1_with_trailing_space() {
        // Spec § 1.2 + § 3.2.2 lock this verbatim. The trailing space is
        // load-bearing — it is part of the bytes hashed into every
        // subkey. If this constant ever drifts, every vault on disk
        // becomes unreadable.
        assert_eq!(HKDF_PREFIX_V0_1, b"myne.v0.1 ");
        assert_eq!(HKDF_PREFIX_V0_1.len(), 10);
        // Final byte is space (0x20), not null or some other separator.
        assert_eq!(HKDF_PREFIX_V0_1[9], b' ');
    }

    #[test]
    fn items_key_wrap_role_string_matches_spec_registry() {
        // Spec § 3.3 key hierarchy + § 3.4 role table.
        assert_eq!(SubkeyRole::ItemsKeyWrap.role_str(), b"itemsKey-wrap");
    }

    #[test]
    fn derive_subkey_concatenates_prefix_and_role_string() {
        // The `info` parameter passed to HKDF-Expand must be exactly
        // `prefix || role`, with no separator, no length prefix, no
        // trailing null (spec § 3.2.2). We verify by replicating the
        // derivation manually with explicit bytes and checking the
        // outputs match.
        let root = [0u8; 32];
        let manual_info = b"myne.v0.1 itemsKey-wrap";
        let manual = derive_with_context(&root, manual_info);
        let helper = derive_subkey(&root, SubkeyRole::ItemsKeyWrap);
        assert_eq!(*manual, *helper);
    }

    #[test]
    fn different_roles_produce_different_subkeys() {
        // Spec § 3.2.2: different `info` strings MUST produce different
        // output bytes (this is the reason for the registered-context
        // discipline). v0.1 has only one registered role, so we
        // construct a second context manually via the crate-internal
        // helper to verify the property on the underlying primitive.
        let root = [0u8; 32];
        let items_wrap = derive_with_context(&root, b"myne.v0.1 itemsKey-wrap");
        let other = derive_with_context(&root, b"myne.v0.1 someOtherRole");
        assert_ne!(*items_wrap, *other);
    }

    #[test]
    fn different_root_keys_produce_different_subkeys_for_same_role() {
        // Sanity: HKDF actually depends on `root_key`. Catches a
        // hypothetical bug where the function returns a constant.
        let root_a = [0u8; 32];
        let mut root_b = [0u8; 32];
        root_b[0] = 1;
        let a = derive_subkey(&root_a, SubkeyRole::ItemsKeyWrap);
        let b = derive_subkey(&root_b, SubkeyRole::ItemsKeyWrap);
        assert_ne!(*a, *b);
    }

    #[test]
    fn derive_subkey_is_deterministic() {
        // Same root + same role → same output bytes, every call.
        let root = [0xA5u8; 32];
        let first = derive_subkey(&root, SubkeyRole::ItemsKeyWrap);
        let second = derive_subkey(&root, SubkeyRole::ItemsKeyWrap);
        assert_eq!(*first, *second);
    }

    #[test]
    fn derive_subkey_zero_root_items_key_wrap_golden() {
        // Regression catcher pinned against a fresh run of:
        //   HKDF-SHA-256(
        //     salt = [0u8; 32],
        //     ikm  = [0u8; 32],
        //     info = b"myne.v0.1 itemsKey-wrap",
        //     L    = 32,
        //   )
        //
        // If anyone changes the algorithm, prefix, role string, or
        // output length, this constant must be regenerated. To
        // regenerate, run this test, copy the actual bytes from the
        // panic message, paste back, and update the corresponding
        // entry in `myne-test-vectors/` if it exists.
        let derived = derive_subkey(&[0u8; 32], SubkeyRole::ItemsKeyWrap);
        let expected: [u8; 32] = [
            0xA6, 0x6C, 0xA9, 0x2D, 0x9D, 0x6B, 0xA7, 0xF8, 0x91, 0x63, 0x5B, 0xCF, 0x9D, 0xFD,
            0x0A, 0x46, 0x29, 0x60, 0x0F, 0xF5, 0x89, 0xFA, 0xBD, 0x4F, 0xEE, 0x3F, 0xAE, 0xE6,
            0xB7, 0x7A, 0x4F, 0xB6,
        ];
        assert_eq!(*derived, expected, "HKDF golden mismatch — regenerate");
    }
}
