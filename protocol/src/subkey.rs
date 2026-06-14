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
//! v0.1 registers these roles:
//!
//! | Variant                                | Registered string         |
//! |----------------------------------------|---------------------------|
//! | [`SubkeyRole::ItemsKeyWrap`]           | `itemsKey-wrap`           |
//! | [`SubkeyRole::PrefsKey`]               | `prefs-key`               |
//! | [`SubkeyRole::SearchIndexKey`]         | `search-index-key`        |
//! | [`SubkeyRole::AttachmentsCatalogKey`]  | `attachments-catalog-key` |
//! | [`SubkeyRole::AttachmentsIdHmac`]      | `attachments-id-hmac`     |
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

/// Registered role string for the v0.1 `vault.prefs` blob KEK
/// (spec § 3.4 + § 9.5).
const ROLE_STR_PREFS_KEY: &[u8] = b"prefs-key";

/// Registered role string for the v0.1 search-index blob KEK
/// (MYND-29; encrypts the `vault.search` index blob — `search_blob.rs`,
/// `protocol.md` § 9.6). Load-bearing: drift silently changes the KEK.
const ROLE_STR_SEARCH_INDEX_KEY: &[u8] = b"search-index-key";

/// Registered role string for the v0.1 attachments-catalog blob KEK
/// (`vault.attachments`, `MYC1` — `attachments_catalog.rs`,
/// `protocol.md` § 9.10 + § 3.4). Load-bearing: drift silently changes
/// the KEK.
const ROLE_STR_ATTACHMENTS_CATALOG_KEY: &[u8] = b"attachments-catalog-key";

/// Registered role string for the v0.1 content-addressed attachment-id
/// HMAC key (`protocol.md` § 9.9 + § 3.4). Keys
/// `HMAC-SHA-256(key, file_plaintext)` to derive the deterministic
/// per-vault attachment-id; NOT a blob KEK. DISTINCT from
/// `attachments-catalog-key` (§ 9.10.1 note) — the two are separate
/// subkeys so the catalog encryption and the id derivation are
/// domain-separated.
const ROLE_STR_ATTACHMENTS_ID_HMAC: &[u8] = b"attachments-id-hmac";

/// Registered role string for the v0.1 editor workspace-state blob KEK
/// (MYND-166; encrypts the `vault.workspace` blob — `workspace_blob.rs`,
/// `protocol.md` § 9.7). Load-bearing: drift silently changes the KEK.
/// `root_key`-derived (like prefs/search), so it is `itemsKey`-independent
/// and survives a v005 epoch rotation.
const ROLE_STR_SESSION_STATE_KEY: &[u8] = b"session-state-key";

/// Registered role string for the v0.1 personal-dictionary blob KEK
/// (MYND-266; encrypts the `vault.dictionary` blob — `dictionary_blob.rs`,
/// `protocol.md` § 9.12 + § 3.4). Load-bearing: drift silently changes the
/// KEK. `root_key`-derived (like prefs/search/workspace), so it is
/// `itemsKey`-independent and survives a v005 epoch rotation.
const ROLE_STR_PERSONAL_DICT_KEY: &[u8] = b"personal-dictionary-key";

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
    /// KEK for the v0.1 `vault.prefs` blob (spec § 9.5 + § 3.4).
    /// Encrypts the canonical-JSON inner plaintext of `vault.prefs`
    /// under XChaCha20-Poly1305 + CTX commitment.
    PrefsKey,
    /// KEK for the v0.1 search-index blob (`vault.search`, MYND-29).
    /// Encrypts the serialized full-text index under XChaCha20-Poly1305
    /// (CTX commitment outer). Distinct from `PrefsKey` so the two blobs
    /// are domain-separated.
    SearchIndexKey,
    /// KEK for the v0.1 attachments-catalog blob (`vault.attachments`,
    /// `MYC1`, spec § 9.10). Encrypts the canonical-JSON inner plaintext
    /// of the catalog under XChaCha20-Poly1305 + CTX commitment.
    AttachmentsCatalogKey,
    /// HMAC key for the v0.1 content-addressed attachment-id (spec
    /// § 9.9). Keys `HMAC-SHA-256(key, file_plaintext)` to derive the
    /// deterministic per-vault attachment-id. NOT a blob KEK — distinct
    /// from `AttachmentsCatalogKey` so id derivation and catalog
    /// encryption are domain-separated.
    AttachmentsIdHmac,
    /// KEK for the v0.1 editor workspace-state blob (`vault.workspace`,
    /// MYND-166). Encrypts the serialized open-tab/pane-layout descriptor
    /// under XChaCha20-Poly1305 (CTX commitment outer). Distinct from
    /// `PrefsKey`/`SearchIndexKey` so the three blobs are domain-separated.
    SessionStateKey,
    /// KEK for the v0.1 personal-dictionary blob (`vault.dictionary`,
    /// `MYD1`, MYND-266). Encrypts the user's added-words + vault-wide
    /// ignore set under XChaCha20-Poly1305 (CTX commitment outer). Distinct
    /// from the other `root_key`-derived blob KEKs so every blob family is
    /// cryptographically domain-separated.
    PersonalDictKey,
}

impl SubkeyRole {
    /// Registered role string (the part appended after the
    /// `"myne.v0.1 "` prefix). Crate-internal so only
    /// [`derive_subkey`] / [`derive_with_context`] read it.
    pub(crate) fn role_str(self) -> &'static [u8] {
        match self {
            SubkeyRole::ItemsKeyWrap => ROLE_STR_ITEMS_KEY_WRAP,
            SubkeyRole::PrefsKey => ROLE_STR_PREFS_KEY,
            SubkeyRole::SearchIndexKey => ROLE_STR_SEARCH_INDEX_KEY,
            SubkeyRole::AttachmentsCatalogKey => ROLE_STR_ATTACHMENTS_CATALOG_KEY,
            SubkeyRole::AttachmentsIdHmac => ROLE_STR_ATTACHMENTS_ID_HMAC,
            SubkeyRole::SessionStateKey => ROLE_STR_SESSION_STATE_KEY,
            SubkeyRole::PersonalDictKey => ROLE_STR_PERSONAL_DICT_KEY,
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
    fn prefs_key_role_string_matches_spec_registry() {
        // Spec § 3.4 registry entry "myne.v0.1 prefs-key" + § 9.5
        // vault.prefs blob KEK. The role byte string is the suffix
        // appended after the "myne.v0.1 " prefix.
        assert_eq!(SubkeyRole::PrefsKey.role_str(), b"prefs-key");
    }

    #[test]
    fn search_index_key_role_string_matches_spec_registry() {
        // MYND-29 registry entry "myne.v0.1 search-index-key" (§ 9.6).
        // Frozen + load-bearing: drift silently changes the search-blob KEK.
        assert_eq!(SubkeyRole::SearchIndexKey.role_str(), b"search-index-key");
    }

    #[test]
    fn attachments_catalog_key_role_string_matches_spec_registry() {
        // Spec § 3.4 registry entry "myne.v0.1 attachments-catalog-key"
        // (§ 9.10 MYC1 KEK). Load-bearing: drift silently changes the KEK.
        assert_eq!(
            SubkeyRole::AttachmentsCatalogKey.role_str(),
            b"attachments-catalog-key"
        );
    }

    #[test]
    fn attachments_id_hmac_role_string_matches_spec_registry() {
        // Spec § 3.4 registry entry "myne.v0.1 attachments-id-hmac"
        // (§ 9.9 content-addressed attachment-id HMAC key). DISTINCT
        // from attachments-catalog-key.
        assert_eq!(
            SubkeyRole::AttachmentsIdHmac.role_str(),
            b"attachments-id-hmac"
        );
    }

    #[test]
    fn personal_dict_key_role_string_matches_spec_registry() {
        // MYND-266 registry entry "myne.v0.1 personal-dictionary-key" (§ 9.12).
        // Frozen + load-bearing: drift silently changes the vault.dictionary KEK.
        assert_eq!(
            SubkeyRole::PersonalDictKey.role_str(),
            b"personal-dictionary-key"
        );
    }

    #[test]
    fn personal_dict_key_is_distinct_from_other_root_key_blobs() {
        // The dictionary KEK must differ from prefs/search/workspace KEKs so
        // the blob families are domain-separated (HKDF info-string property).
        let root = [0u8; 32];
        let dict = derive_subkey(&root, SubkeyRole::PersonalDictKey);
        assert_ne!(*dict, *derive_subkey(&root, SubkeyRole::PrefsKey));
        assert_ne!(*dict, *derive_subkey(&root, SubkeyRole::SearchIndexKey));
        assert_ne!(*dict, *derive_subkey(&root, SubkeyRole::SessionStateKey));
    }

    #[test]
    fn attachment_roles_are_distinct_subkeys() {
        // The catalog KEK and the id-HMAC key MUST be different subkeys
        // (spec § 9.10.1 note: "distinct subkeys").
        let root = [0u8; 32];
        let catalog = derive_subkey(&root, SubkeyRole::AttachmentsCatalogKey);
        let id_hmac = derive_subkey(&root, SubkeyRole::AttachmentsIdHmac);
        assert_ne!(*catalog, *id_hmac);
    }

    #[test]
    fn items_key_wrap_and_prefs_key_produce_different_subkeys() {
        // Spec § 3.2.2 + § 3.4: different registered roles MUST
        // produce different subkeys from the same root_key. This pins
        // the cryptographic independence between the per-note encryption
        // lineage (itemsKey-wrap) and the vault.prefs lineage (prefs-key)
        // — the HKDF security property that makes the "no items_key
        // coupling" decision (decisions.md 2026-05-27) load-bearing.
        let root = [0u8; 32];
        let items_wrap = derive_subkey(&root, SubkeyRole::ItemsKeyWrap);
        let prefs = derive_subkey(&root, SubkeyRole::PrefsKey);
        assert_ne!(*items_wrap, *prefs);
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
        //
        // This in-crate golden mirrors the first vector in
        // `myne-test-vectors/vectors/hkdf-sha256/v0.1/cases.json`
        // (`hkdf-sha256/v0.1/zero-root-items-key-wrap`); both must
        // pass against identical bytes — drift in either indicates
        // HKDF prefix / role-string corruption.
        let derived = derive_subkey(&[0u8; 32], SubkeyRole::ItemsKeyWrap);
        let expected: [u8; 32] = [
            0xA6, 0x6C, 0xA9, 0x2D, 0x9D, 0x6B, 0xA7, 0xF8, 0x91, 0x63, 0x5B, 0xCF, 0x9D, 0xFD,
            0x0A, 0x46, 0x29, 0x60, 0x0F, 0xF5, 0x89, 0xFA, 0xBD, 0x4F, 0xEE, 0x3F, 0xAE, 0xE6,
            0xB7, 0x7A, 0x4F, 0xB6,
        ];
        assert_eq!(*derived, expected, "HKDF golden mismatch — regenerate");
    }

    // ---- KAT vector regenerator (companion repo) ----------------------

    /// Emits the full `cases.json` for
    /// `myne-test-vectors/vectors/hkdf-sha256/v0.1/cases.json` as a
    /// pretty-printed JSON file at `/tmp/myne_hkdf_sha256_vectors.json`,
    /// ready to copy verbatim into the companion repo.
    ///
    /// `#[ignore]` because regenerating vectors should be a deliberate
    /// act, not a side effect of `cargo test`. Run with:
    /// `cargo test -p protocol --lib emit_subkey_vectors_for_paste -- --ignored`
    ///
    /// The 18 cases cover the v0.1 input space:
    /// - 4 baseline: `ItemsKeyWrap` + `PrefsKey` × {all-zero, all-0xFF} root
    /// - 6 pseudorandom-root: those two roles × 3 distinct SHA-256-derived
    ///   roots (alpha / beta / gamma seeds). The alpha pair carries
    ///   `informational_info_utf8_hex` for cross-implementation
    ///   reviewers — the other 8 omit it to keep the file compact.
    /// - 2 `SearchIndexKey` (MYND-29): all-zero root + the alpha
    ///   pseudorandom root (the latter carries `informational_info_utf8_hex`
    ///   so the third role's canonical `"myne.v0.1 search-index-key"` info
    ///   assembly is documented for porters).
    /// - 4 attachment roles (MYND-164): `AttachmentsCatalogKey` +
    ///   `AttachmentsIdHmac` × {all-zero, alpha} root — every registered
    ///   role is now pinned directly in this family, not only transitively
    ///   through the `attachment-blob` / `attachments-catalog` families.
    ///   The alpha pair carries `informational_info_utf8_hex`.
    /// - 2 `SessionStateKey` (MYND-254, §9.7): all-zero root + the alpha
    ///   pseudorandom root (the latter carries `informational_info_utf8_hex`
    ///   for the canonical `"myne.v0.1 session-state-key"` info assembly) —
    ///   the `vault.workspace` KEK, pinned in lockstep with the
    ///   `vault-workspace` family.
    ///
    /// Cross-role independence is implicit: every root appears with
    /// both roles; the integration runner asserts byte-equality for
    /// each independent vector. Determinism is implicit: cargo test
    /// runs deterministically, so re-running the integration test
    /// re-exercises every (root, role) → expected_subkey_hex assertion.
    /// Info-string tampering tests stay in-crate (`subkey.rs:174,188`)
    /// because the type-safe `SubkeyRole` enum makes tampered info
    /// inexpressible at the JSON layer.
    #[test]
    #[ignore]
    fn emit_subkey_vectors_for_paste() {
        extern crate std;
        use sha2::Digest;

        fn hex_lower(bytes: &[u8]) -> alloc::string::String {
            let mut s = alloc::string::String::with_capacity(bytes.len() * 2);
            for b in bytes {
                s.push_str(&alloc::format!("{:02x}", b));
            }
            s
        }

        fn json_escape(input: &str) -> alloc::string::String {
            let mut out = alloc::string::String::with_capacity(input.len() + 2);
            for c in input.chars() {
                match c {
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    c if (c as u32) < 0x20 => {
                        out.push_str(&alloc::format!("\\u{:04x}", c as u32));
                    }
                    c => out.push(c),
                }
            }
            out
        }

        fn pseudorandom_root(label: &[u8]) -> [u8; 32] {
            let digest = Sha256::digest(label);
            let mut out = [0u8; 32];
            out.copy_from_slice(&digest);
            out
        }

        fn role_str_json(role: SubkeyRole) -> &'static str {
            match role {
                SubkeyRole::ItemsKeyWrap => "itemsKey-wrap",
                SubkeyRole::PrefsKey => "prefs-key",
                SubkeyRole::SearchIndexKey => "search-index-key",
                SubkeyRole::AttachmentsCatalogKey => "attachments-catalog-key",
                SubkeyRole::AttachmentsIdHmac => "attachments-id-hmac",
                SubkeyRole::SessionStateKey => "session-state-key",
                SubkeyRole::PersonalDictKey => "personal-dictionary-key",
            }
        }

        let zero_root: [u8; 32] = [0u8; 32];
        let ff_root: [u8; 32] = [0xFFu8; 32];
        let alpha = pseudorandom_root(b"myne-test-vectors-seed-v0.1.alpha");
        let beta = pseudorandom_root(b"myne-test-vectors-seed-v0.1.beta");
        let gamma = pseudorandom_root(b"myne-test-vectors-seed-v0.1.gamma");

        type Case<'a> = (&'a str, &'a str, &'a [u8; 32], SubkeyRole, bool);
        let cases: [Case<'_>; 18] = [
            (
                "zero-root-items-key-wrap",
                "All-zero root_key with the ItemsKeyWrap role. Promotes the in-crate golden at protocol/src/subkey.rs:222 — same input, same expected bytes; drift in either the unit test or this integration assertion indicates HKDF prefix or role-string corruption.",
                &zero_root,
                SubkeyRole::ItemsKeyWrap,
                false,
            ),
            (
                "zero-root-prefs-key",
                "All-zero root_key with the PrefsKey role. Pair to the previous vector under the same trivial root; catches role-confusion bugs that collapse the two registered roles to the same info string.",
                &zero_root,
                SubkeyRole::PrefsKey,
                false,
            ),
            (
                "all-ff-root-items-key-wrap",
                "All-0xFF root_key with the ItemsKeyWrap role. Detects byte-swap or partial-zero bugs that pass against all-zero inputs (since the all-zero baseline cannot distinguish certain XOR / index-by-zero defects).",
                &ff_root,
                SubkeyRole::ItemsKeyWrap,
                false,
            ),
            (
                "all-ff-root-prefs-key",
                "All-0xFF root_key with the PrefsKey role. Role-differentiation pair to the previous vector under a non-trivial root.",
                &ff_root,
                SubkeyRole::PrefsKey,
                false,
            ),
            (
                "prn-alpha-items-key-wrap",
                "Pseudorandom root_key (SHA-256 of the ASCII string 'myne-test-vectors-seed-v0.1.alpha') with the ItemsKeyWrap role. The informational_info_utf8_hex field carries the canonical 23-byte HKDF info bytes ('myne.v0.1 itemsKey-wrap') so independent implementers verifying their port assemble the same info parameter can do so without re-parsing the spec.",
                &alpha,
                SubkeyRole::ItemsKeyWrap,
                true,
            ),
            (
                "prn-alpha-prefs-key",
                "Same pseudorandom alpha root as the previous vector, with the PrefsKey role. Pair documents both registered roles' canonical 19-byte info-string assembly ('myne.v0.1 prefs-key'). Cross-role independence under a pseudorandom root is implicit: the two vectors share an identical input_root_key_hex but produce byte-different expected_subkey_hex.",
                &alpha,
                SubkeyRole::PrefsKey,
                true,
            ),
            (
                "prn-beta-items-key-wrap",
                "Pseudorandom root_key (SHA-256 of the ASCII string 'myne-test-vectors-seed-v0.1.beta') with the ItemsKeyWrap role. Additional coverage of the (root, role) input space with a second distinct pseudorandom root.",
                &beta,
                SubkeyRole::ItemsKeyWrap,
                false,
            ),
            (
                "prn-beta-prefs-key",
                "Same beta root, PrefsKey role.",
                &beta,
                SubkeyRole::PrefsKey,
                false,
            ),
            (
                "prn-gamma-items-key-wrap",
                "Pseudorandom root_key (SHA-256 of the ASCII string 'myne-test-vectors-seed-v0.1.gamma') with the ItemsKeyWrap role. Third pseudorandom root expands coverage beyond the all-zero / all-0xFF / alpha / beta points.",
                &gamma,
                SubkeyRole::ItemsKeyWrap,
                false,
            ),
            (
                "prn-gamma-prefs-key",
                "Same gamma root, PrefsKey role.",
                &gamma,
                SubkeyRole::PrefsKey,
                false,
            ),
            (
                "zero-root-search-index-key",
                "All-zero root_key with the SearchIndexKey role (MYND-29, §9.6). KEK for the vault.search blob; role string 'search-index-key' (16 ASCII bytes). Pairs with the zero-root itemsKey/prefs vectors under the same trivial root — catches a role-confusion bug that would collapse the search-index lineage onto another role's info string.",
                &zero_root,
                SubkeyRole::SearchIndexKey,
                false,
            ),
            (
                "prn-alpha-search-index-key",
                "Pseudorandom alpha root with the SearchIndexKey role. The informational_info_utf8_hex field carries the canonical 26-byte HKDF info bytes ('myne.v0.1 search-index-key') so independent implementers can verify the third registered role's info assembly without re-parsing the spec. NOTE: the HKDF role string 'search-index-key' is DISTINCT from the AAD role string 'search-index-blob' (aad_search_index_blob, ctx-aead vectors) — they are different load-bearing constants.",
                &alpha,
                SubkeyRole::SearchIndexKey,
                true,
            ),
            (
                "zero-root-attachments-catalog-key",
                "All-zero root_key with the AttachmentsCatalogKey role (MYND-164, §9.10). KEK for the vault.attachments catalog blob; role string 'attachments-catalog-key' (23 ASCII bytes). Pairs with the other zero-root vectors under the same trivial root — catches a role-confusion bug that would collapse the catalog lineage onto another role's info string.",
                &zero_root,
                SubkeyRole::AttachmentsCatalogKey,
                false,
            ),
            (
                "prn-alpha-attachments-catalog-key",
                "Pseudorandom alpha root with the AttachmentsCatalogKey role. The informational_info_utf8_hex field carries the canonical 33-byte HKDF info bytes ('myne.v0.1 attachments-catalog-key'). §9.10.1 domain-separation pair: the same root also derives 'attachments-id-hmac' (next vector) — a catalog KEK and an id-HMAC key that must never coincide; the two vectors share input_root_key_hex but produce byte-different subkeys.",
                &alpha,
                SubkeyRole::AttachmentsCatalogKey,
                true,
            ),
            (
                "zero-root-attachments-id-hmac",
                "All-zero root_key with the AttachmentsIdHmac role (MYND-164, §9.9). Keys the HMAC-SHA-256 that derives deterministic attachment-ids — NOT a blob KEK; role string 'attachments-id-hmac' (19 ASCII bytes).",
                &zero_root,
                SubkeyRole::AttachmentsIdHmac,
                false,
            ),
            (
                "prn-alpha-attachments-id-hmac",
                "Pseudorandom alpha root with the AttachmentsIdHmac role. The informational_info_utf8_hex field carries the canonical 29-byte HKDF info bytes ('myne.v0.1 attachments-id-hmac'). Domain-separation pair with the alpha attachments-catalog-key vector above (§9.10.1).",
                &alpha,
                SubkeyRole::AttachmentsIdHmac,
                true,
            ),
            (
                "zero-root-session-state-key",
                "All-zero root_key with the SessionStateKey role (MYND-254, §9.7). KEK for the vault.workspace blob; role string 'session-state-key' (17 ASCII bytes). Pairs with the other zero-root vectors under the same trivial root — catches a role-confusion bug that would collapse the workspace lineage onto another role's info string.",
                &zero_root,
                SubkeyRole::SessionStateKey,
                false,
            ),
            (
                "prn-alpha-session-state-key",
                "Pseudorandom alpha root with the SessionStateKey role. The informational_info_utf8_hex field carries the canonical 27-byte HKDF info bytes ('myne.v0.1 session-state-key') so independent implementers can verify the sixth registered role's info assembly without re-parsing the spec. NOTE: the HKDF role string 'session-state-key' is DISTINCT from the AAD role string 'workspace-blob' (aad_workspace_blob, ctx-aead vectors) — they are different load-bearing constants.",
                &alpha,
                SubkeyRole::SessionStateKey,
                true,
            ),
        ];

        let mut dump = alloc::string::String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"hkdf-sha256\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §3.2 + §3.4\",\n");
        dump.push_str("  \"description\": \"Pins protocol::derive_subkey byte mapping for cross-implementation conformance. Each case fixes a (root_key, role) input pair under HKDF-SHA-256 with salt=zero_32 and info='myne.v0.1 '||role, and the 32-byte subkey the helper must produce. Role registry mirrors the type-safe Rust SubkeyRole enum (spec §3.4); v0.1 registers itemsKey-wrap + prefs-key + search-index-key + attachments-catalog-key + attachments-id-hmac + session-state-key. Vectors generated by `cargo test -p protocol --lib emit_subkey_vectors_for_paste -- --ignored` (in protocol/src/subkey.rs).\",\n");
        dump.push_str("  \"cases\": [\n");

        for (i, (slug, desc, root, role, include_info)) in cases.iter().enumerate() {
            let subkey = derive_subkey(root, *role);

            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"hkdf-sha256/v0.1/{}\",\n",
                slug
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(desc)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_root_key_hex\": \"{}\",\n",
                hex_lower(root.as_slice())
            ));
            dump.push_str(&alloc::format!(
                "      \"input_role\": \"{}\",\n",
                role_str_json(*role)
            ));
            if *include_info {
                let mut info = alloc::vec::Vec::new();
                info.extend_from_slice(HKDF_PREFIX_V0_1);
                info.extend_from_slice(role.role_str());
                dump.push_str(&alloc::format!(
                    "      \"informational_info_utf8_hex\": \"{}\",\n",
                    hex_lower(&info)
                ));
            }
            dump.push_str(&alloc::format!(
                "      \"expected_subkey_hex\": \"{}\"\n",
                hex_lower(&*subkey)
            ));
            if i + 1 < cases.len() {
                dump.push_str("    },\n");
            } else {
                dump.push_str("    }\n");
            }
        }

        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write("/tmp/myne_hkdf_sha256_vectors.json", dump.as_bytes())
            .expect("write hkdf vectors dump");
    }
}
