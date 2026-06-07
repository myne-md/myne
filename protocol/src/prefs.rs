// SPDX-License-Identifier: AGPL-3.0-or-later

//! `vault.prefs` 34-byte-header encrypted-prefs codec — see
//! `docs/spec/protocol.md` § 9.5.
//!
//! `vault.prefs` is a vault-level singleton artifact holding
//! user-configurable preferences (v0.1: the screen-capture-protection
//! toggle from MYND-55 / MYND-160). It lives next to `vault.meta` at
//! `<vault-root>/vault.prefs` and is AEAD-encrypted under
//! `prefs_key = DeriveSubkey(root_key, SubkeyRole::PrefsKey)`.
//!
//! ## On-disk layout (spec § 9.5.1)
//!
//! ```text
//! Offset  Size  Field             Notes
//! ------  ----  ----------------  --------------------------------------
//! 0       4     magic             ASCII "MYP1"
//! 4       1     protocol_version  0x01
//! 5       1     reserved          0x00 (MUST)
//! 6       24    prefs_nonce       XChaCha20-Poly1305 nonce
//! 30      4     ciphertext_len    big-endian uint32, plaintext_len + 32
//! 34      M     ciphertext        AEAD ciphertext + 32-byte CTX tag T'
//! ```
//!
//! Total = 34 + M bytes. No public `prefs_key_id`, no public
//! `account_number_hash` — both bind cryptographically via key
//! derivation and AAD (§ 9.5.3) without consuming header bytes.
//!
//! ## Inner plaintext (spec § 9.5.2)
//!
//! Canonical JSON of a `PrefsView`. v0.1 ships a single field:
//!
//! ```text
//! {"screen_capture_protection":true}
//! ```
//!
//! Canonical encoding rules (load-bearing for cross-implementation
//! byte-stability + the future `myne-test-vectors/vectors/vault-prefs/`
//! KAT vectors):
//!
//! - Object keys lexicographically sorted (deterministic by
//!   construction — v0.1 has a single key, but the hand-rolled encoder
//!   below sorts at emit-time to keep the discipline visible).
//! - No insignificant whitespace (no spaces around `:` or `,`).
//! - Integer values without trailing `.0`.
//! - Floating-point values FORBIDDEN at the type level — the
//!   [`PrefsView`] struct has no float fields and never will in v0.1.
//! - UTF-8 NFC for string fields — applied per-element to string array
//!   fields (`deliberate_folders`, `favorites`, `item_order`) before
//!   encoding.
//! - String ARRAY element order: a `set`-semantics array
//!   (`deliberate_folders`) is sorted + exact-deduped; a `sequence`-
//!   semantics array (`favorites`, `item_order` — the manual sidebar
//!   order) is preserved VERBATIM (order is the payload), so it is
//!   neither sorted nor deduped. Both stay deterministic given the same
//!   logical value, which is all canonical byte-stability requires.
//!
//! ## Schema evolution (spec § 9.5.2)
//!
//! Additive within v0.1 — new boolean / integer / string / string-array
//! / nested-object fields can be appended in any v0.1.x minor revision
//! (v0.1.x has grown `deliberate_folders`, `auto_lock_seconds`,
//! `editor_layout`, then the unified `item_order` + `favorites` — the
//! latter pair replacing the earlier `note_order` / `folder_order`, a
//! pre-release redefinition legal only because v0.1 is not yet frozen;
//! see spec § 9.5.2 + `decisions.md` 2026-06-02). Older clients reading
//! newer plaintexts MUST treat
//! unknown fields as unknown-and-ignored (the parser below uses a
//! tolerant value-by-value decoder keyed on canonical key order, not a
//! strict struct-match, for forward-compat). Field removal, type changes,
//! and structural restructuring are MAJOR-version events (MYP5).
//!
//! ## Migration-less semantic (spec § 9.5.5)
//!
//! The caller-side `read_or_default` discipline (Tauri plugin layer,
//! not this crate) collapses absent-file / truncated / AEAD-fail /
//! parse-fail to `PrefsView::default()`. This module emits **honest
//! errors** for each failure mode — the caller decides whether to
//! collapse them to defaults. Discipline parity with `blob.rs`:
//! decoder reports failures, callers apply fall-back-to-defaults at
//! the appropriate boundary.

use crate::aead::{
    aad_prefs_blob, aead_open_ctx, aead_seal_ctx, AEAD_KEY_LEN, AEAD_NONCE_LEN,
    CTX_COMMITMENT_TAG_LEN,
};
use crate::error::ProtocolError;
use alloc::string::String;
use alloc::vec::Vec;
use getrandom::getrandom;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use unicode_normalization::UnicodeNormalization;
use zeroize::{Zeroize, Zeroizing};

/// Magic bytes at offset 0 — ASCII `"MYP1"` (Myne Prefs v1).
pub const PREFS_BLOB_MAGIC: [u8; 4] = *b"MYP1";

/// `protocol_version` byte at offset 4 — `0x01` for v0.1.
pub const PREFS_BLOB_PROTOCOL_VERSION: u8 = 0x01;

/// `reserved` byte at offset 5 — MUST be `0x00`.
pub const PREFS_BLOB_RESERVED: u8 = 0x00;

/// Length of the 16-byte `account_number_hash` field bound into
/// `AAD_prefs_blob` (spec § 9.5.3 + § 9.3 offset 6).
pub const PREFS_BLOB_ACCOUNT_HASH_LEN: usize = 16;

/// Length of the outer envelope's fixed-offset header (offsets 0..34).
/// Magic (4) + protocol_version (1) + reserved (1) + prefs_nonce (24)
/// + ciphertext_len (4) = 34 bytes.
pub const PREFS_BLOB_HEADER_LEN: usize = 34;

/// Maximum inner-plaintext length, inclusive (64 KiB).
///
/// The `ciphertext_len` field at header offset 30 carries
/// `plaintext_len + 32` (the trailing 32 = CTX commitment tag). The
/// decoder rejects `ciphertext_len > MAX_PREFS_PLAINTEXT_LEN + 32` at
/// the parse layer **before** any AEAD-bound allocation.
///
/// 64 KiB is ~13× headroom over any realistic v0.1 preference set
/// (v0.1's screen_capture_protection bool encodes to ~36 bytes JSON;
/// 100 future fields ≈ 5 KiB worst case). Parallel to the
/// [`crate::MAX_PLAINTEXT_LEN`] cap on `.myn` blobs. See spec § 9.5.4.
pub const MAX_PREFS_PLAINTEXT_LEN: usize = 64 * 1024;

/// User theme preference (MYND-110). Persisted as a JSON string under
/// the `theme` key of [`PrefsView`]. **`None` ≡ system** — this enum has
/// no `System` variant; absence of the field is the canonical encoding of
/// "follow the OS `prefers-color-scheme`". That gives a fresh vault the
/// "fallback system" default for free and keeps a vault that never chose
/// an explicit theme byte-identical to a pre-MYND-110 `vault.prefs`. A
/// **non-load-bearing** cosmetic preference (a tampered / replayed
/// `vault.prefs` can at worst surface the wrong color), so unlike
/// `auto_lock_seconds` it carries no protective-envelope clamp. Serialized
/// lowercase (`"light"` / `"dark"`) on both the canonical-JSON disk path
/// and the IPC `serde` path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeChoice {
    /// Explicit light theme — the client sets `<html data-theme="light">`,
    /// overriding the OS preference.
    Light,
    /// Explicit dark theme — the client sets `<html data-theme="dark">`,
    /// overriding the OS preference.
    Dark,
}

/// Editor three-pane layout state — sidebar widths + collapsed flags
/// (MYND-137). Persisted as a nested JSON object under the
/// `editor_layout` key of [`PrefsView`]. Present **only** when the user
/// has customized the layout (resized or collapsed a pane); a pristine
/// layout omits the whole field so a vault that never touched the
/// sidebars is byte-identical to a pre-MYND-137 `vault.prefs` (existing
/// golden vectors unaffected).
///
/// `*_width` are integer pixels (no floats per spec § 9.5.2; the `u32`
/// type enforces this on encode and the decoder rejects a fractional
/// value). The widths carry the **last non-collapsed** width so a
/// re-expand restores it; the collapse policy + min/max clamps live in
/// the client (the UI layer), NOT here — this codec faithfully persists
/// whatever the client wrote, exactly like `auto_lock_seconds`. These
/// are AS3-low-sensitivity (window-layout metadata) and ride inside the
/// AEAD-encrypted blob like every other field. Conflict semantics for
/// Phase 2 sync are deferred (last-writer-wins on the whole object is
/// the likely shape).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct EditorLayout {
    /// Left (notes) sidebar width in integer pixels — the last
    /// non-collapsed width.
    pub left_width: u32,
    /// Right (backlinks) sidebar width in integer pixels — the last
    /// non-collapsed width.
    pub right_width: u32,
    /// Whether the left sidebar is currently collapsed (hidden).
    pub left_collapsed: bool,
    /// Whether the right sidebar is currently collapsed (hidden).
    pub right_collapsed: bool,
}

/// In-memory representation of the v0.1 `vault.prefs` plaintext.
///
/// v0.1 has a single field. Future v0.1.x minor revisions append
/// optional fields here (boolean / integer / string / nested-object —
/// no floats per spec § 9.5.2). The `Default` impl supplies the
/// fall-back-to-defaults value the caller uses on read failure
/// (spec § 9.5.5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrefsView {
    /// User toggle for the screen-capture-protection layer
    /// (`threat-model.md` § 6 + `decisions.md` 2026-05-27 entries).
    /// Default `true` matches MYND-78's structural default-ON.
    pub screen_capture_protection: bool,

    /// Deliberately-created folder paths (canonical trailing-slash display
    /// form) that persist independently of whether any note carries them —
    /// the carrier for empty folders in the virtual-folder model (MYND-144 /
    /// grill 2026-05-29). Default empty. Conflict semantics (Phase 2) =
    /// union + add-wins. Encoded as a canonical JSON string array
    /// (NFC-normalized, lexicographically sorted, exact-deduped, and **omitted
    /// entirely when empty** so a vault with no deliberate folders is
    /// byte-identical to a v0.1.0 `vault.prefs`).
    #[serde(default)]
    pub deliberate_folders: Vec<alloc::string::String>,

    /// User-chosen auto-lock-on-idle timeout in **integer seconds**
    /// (MYND-121). `None` = unset → the caller's protective-envelope
    /// default applies (spec § 9.5.5 fall-back-to-defaults). The
    /// always-on flag and the `AUTO_LOCK_CEILING` clamp live in the
    /// Tauri layer, NOT here — this codec only persists the raw choice.
    /// Omitted entirely from the canonical JSON when `None`, so a vault
    /// that never set it is byte-identical to a pre-MYND-121
    /// `vault.prefs`. Integer-only — floats are FORBIDDEN (spec § 9.5.2);
    /// the `u32` type enforces this structurally on the encode side, and
    /// the decoder rejects a fractional value.
    #[serde(default)]
    pub auto_lock_seconds: Option<u32>,

    /// Daily-notes date-format string (MYND-191) — e.g. `YYYY-MM-DD`. `None` ≡
    /// the canonical default `YYYY-MM-DD`, which the host applies at read time
    /// (blank-when-default). Omitted entirely from the canonical JSON when
    /// `None`, so a vault that never customized the daily format is
    /// byte-identical to a pre-MYND-191 `vault.prefs`. A **non-load-bearing**
    /// cold/derivable preference — a tampered/replayed value can at worst format
    /// the daily note's title differently, so no protective-envelope clamp.
    #[serde(default)]
    pub daily_date_format: Option<alloc::string::String>,

    /// Daily-notes folder path (MYND-191) — canonical trailing-slash form, e.g.
    /// `Daily/`. `None` ≡ the canonical default `Daily/`, applied host-side
    /// (blank-when-default). Designating a daily folder also registers it as a
    /// deliberate folder (host-side, not here) so it survives empty. Omitted
    /// when `None`. Non-load-bearing (cold/derivable) — no clamp.
    #[serde(default)]
    pub daily_folder: Option<alloc::string::String>,

    /// Daily-notes template pointer (MYND-191) — the UUIDv7 of a template note
    /// to instantiate today's note from. `None` ≡ the canonical "blank daily
    /// note" state (created blank with only the date as its title). Omitted when
    /// `None`, so a vault that never set a daily template is byte-identical to a
    /// pre-MYND-191 `vault.prefs`. Non-load-bearing (cold/derivable) — no clamp.
    #[serde(default)]
    pub daily_template: Option<alloc::string::String>,

    /// Favorited notes — an ordered list of note UUIDs surfaced in the
    /// sidebar's Favorites section, in display order (MYND-183). A
    /// **sequence** (order is the payload): the canonical encoder preserves
    /// element order verbatim (NFC-normalized, but NOT sorted and NOT
    /// deduped), exactly like [`PrefsView::item_order`]. UUIDs only — folders
    /// are not favoritable, so the list stays homogeneous. A favorited note
    /// ALSO keeps its normal tree position (favoriting is a shortcut, not a
    /// move); a favorite UUID with no live note is ignored by the client at
    /// render time and pruned on the next write (no codec-level GC). Default
    /// empty; omitted entirely from the canonical JSON when empty, so a vault
    /// with no favorites is byte-identical to one without the key. Conflict
    /// semantics (Phase 2) deferred = last-writer-wins on the whole sequence.
    #[serde(default)]
    pub favorites: Vec<alloc::string::String>,

    /// Unified manual sidebar order across the single interleaved file-tree
    /// (MYND-183, superseding the earlier `note_order` + `folder_order`
    /// pair). A flat, heterogeneous, sibling-local **sequence** whose elements
    /// are either note UUIDs or canonical trailing-slash folder display paths,
    /// discriminated by the trailing `/`. Container membership is *structural*
    /// (a note's container is its `folder:`; a folder's is its parent path);
    /// this list supplies only a global rank, and each container sorts its own
    /// children (sub-folders + notes together, freely interleaved) by their
    /// index here, with unlisted children falling back to recency (notes) /
    /// folded name (folders). Because the comparison is sibling-local, a single
    /// flat list expresses recursive interleaving at every level. Order is
    /// MEANINGFUL, so the canonical encoder preserves element order verbatim
    /// (NFC-normalized, but NOT sorted and NOT deduped). Default empty; omitted
    /// entirely from the canonical JSON when empty, so a vault that never
    /// reordered is byte-identical to one without the key.
    #[serde(default)]
    pub item_order: Vec<alloc::string::String>,

    /// Editor three-pane layout (sidebar widths + collapsed flags,
    /// MYND-137). `None` = the user never customized the layout → the
    /// field is omitted entirely from the canonical JSON, so a vault
    /// that never touched the sidebars is byte-identical to a
    /// pre-MYND-137 `vault.prefs`. When `Some`, encoded as a nested
    /// object whose four keys are emitted in canonical (lexicographic)
    /// order: `left_collapsed`, `left_width`, `right_collapsed`,
    /// `right_width`. See [`EditorLayout`].
    #[serde(default)]
    pub editor_layout: Option<EditorLayout>,

    /// User theme preference (MYND-110). `None` ≡ **system** (follow the OS
    /// `prefers-color-scheme`) and is the canonical encoding of "no explicit
    /// choice" — the field is omitted entirely from the canonical JSON when
    /// `None`, so a vault that never picked a theme is byte-identical to a
    /// pre-MYND-110 `vault.prefs` (existing golden vectors unaffected). When
    /// `Some`, encoded as a JSON string `"light"` / `"dark"` under the
    /// canonical key `theme` (lexicographically LAST — `t` > `s`). See
    /// [`ThemeChoice`].
    #[serde(default)]
    pub theme: Option<ThemeChoice>,
}

impl Default for PrefsView {
    /// Spec § 9.5.5 fall-back-to-defaults: `screen_capture_protection`
    /// defaults to `true` so that a missing or corrupt `vault.prefs`
    /// degrades to the safer state (protection on) rather than the
    /// permissive one. `deliberate_folders` defaults empty;
    /// `auto_lock_seconds` defaults `None` (unset — the Tauri-layer
    /// protective-envelope default applies).
    fn default() -> Self {
        Self {
            screen_capture_protection: true,
            theme: None,
            favorites: Vec::new(),
            item_order: Vec::new(),
            deliberate_folders: Vec::new(),
            auto_lock_seconds: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            editor_layout: None,
        }
    }
}

/// Closed-enum failure surface for `vault.prefs` encode / decode.
///
/// Parallel to `blob::DecryptError` from `blob.rs` but emits distinct
/// variants for each structural failure mode at the parse layer
/// (callers MAY collapse them per spec § 9.5.5 fall-back-to-defaults,
/// but this module reports them honestly so test code + observability
/// can distinguish).
///
/// The single `CannotDecrypt` variant for AEAD failure follows the
/// `protocol.md` § 6.4 non-distinguishing rule: any of "wrong key /
/// wrong AAD / tampered ciphertext / tampered CTX tag" collapses to a
/// single user-facing failure that does NOT leak which arm failed.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum PrefsBlobError {
    /// Input shorter than [`PREFS_BLOB_HEADER_LEN`] bytes — not a
    /// valid `vault.prefs` envelope at all.
    #[error("vault.prefs blob too short to parse a header")]
    HeaderTooShort,
    /// First 4 bytes are not `MYP1`. Either a foreign file, a
    /// different artifact type, or a v005 (`MYP5`) blob the v0.1
    /// parser refuses (§ 10.1 forward-incompatible-by-design).
    #[error("vault.prefs blob magic mismatch (expected MYP1)")]
    MagicMismatch,
    /// `protocol_version` byte at offset 4 is not `0x01`.
    #[error("vault.prefs blob protocol_version mismatch (expected 0x01)")]
    ProtocolVersionMismatch,
    /// `reserved` byte at offset 5 is not `0x00`. Spec § 9.5.1 makes
    /// non-zero an unconditional parse rejection — reserved bytes are
    /// flag carriers for future v0.1.x minor revisions and a v0.1.0
    /// client cannot honor unknown flags.
    #[error("vault.prefs blob reserved byte must be 0x00")]
    ReservedByteNonZero,
    /// `ciphertext_len` exceeds [`MAX_PREFS_PLAINTEXT_LEN`] + 32. The
    /// cap exists to bound the parser's pre-AEAD allocation footprint
    /// (DoS-allocation defense, spec § 9.5.4).
    #[error("vault.prefs ciphertext_len exceeds 64 KiB + 32 cap")]
    CiphertextLenOverflow,
    /// Header advertised `ciphertext_len` bytes but the blob is shorter
    /// than `PREFS_BLOB_HEADER_LEN + ciphertext_len`.
    #[error("vault.prefs blob truncated relative to advertised ciphertext_len")]
    CiphertextTruncated,
    /// AEAD verification failure — wrong key, wrong AAD (cross-vault),
    /// tampered ciphertext, or tampered CTX commitment tag. Spec § 6.4
    /// non-distinguishing rule: the caller MUST NOT distinguish which
    /// arm failed beyond "this blob cannot be decrypted under the
    /// current key".
    #[error("vault.prefs AEAD verification failed")]
    CannotDecrypt,
    /// AEAD succeeded but the inner plaintext did not parse as the
    /// expected canonical JSON shape (truncated, wrong field name,
    /// wrong field type, malformed structure). Distinct from
    /// [`PrefsBlobError::CannotDecrypt`] because the AEAD tag check
    /// already proved the bytes were produced by a holder of the
    /// `prefs_key` — corruption past that point is structural rather
    /// than adversarial.
    #[error("vault.prefs inner plaintext failed to parse as canonical JSON")]
    PlaintextParseFailed,

    /// OS CSPRNG (`getrandom`) is unavailable — the encode path could
    /// not source a fresh `prefs_nonce`. Distinct from
    /// [`PrefsBlobError::CannotDecrypt`] because this is a
    /// randomness-availability failure on the ENCODE side, not an
    /// AEAD verification failure on the decode side; conflating them
    /// would corrupt the closed-enum log category for support flows
    /// (an early-boot embedded `/dev/urandom` exhaustion would surface
    /// as a tampered-blob event in observability).
    #[error("OS CSPRNG unavailable for prefs nonce generation")]
    RandomnessUnavailable,
}

impl From<ProtocolError> for PrefsBlobError {
    fn from(e: ProtocolError) -> Self {
        // Explicit exhaustive match (no `_ =>` wildcard) is
        // drift-detecting: a new `ProtocolError` variant landed in a
        // future protocol-crate change forces a compile-fail here,
        // surfacing the new failure mode to a reviewer who has to
        // decide whether the prefs codec should still collapse it to
        // CannotDecrypt (preserving spec § 6.4 non-distinguishing
        // discipline at the prefs surface) or surface it as its own
        // PrefsBlobError variant.
        //
        // Today, only `aead_seal_ctx`/`aead_open_ctx` are reachable
        // from the prefs codec; both produce `AeadFailure` only.
        // The other variants are listed but unreachable — kept here
        // so the match stays exhaustive at compile time.
        match e {
            ProtocolError::AeadFailure => PrefsBlobError::CannotDecrypt,
            ProtocolError::InvalidPassword
            | ProtocolError::PasswordTooShort
            | ProtocolError::KdfFailure
            | ProtocolError::InvalidVaultMeta
            | ProtocolError::AccountNumberInvalid
            | ProtocolError::Csprng
            | ProtocolError::PlaintextTooLarge => PrefsBlobError::CannotDecrypt,
        }
    }
}

// ---- canonical JSON encoder / decoder ---------------------------------
//
// v0.1 ships a single-field schema (`screen_capture_protection: bool`).
// Hand-rolled for two reasons:
//
// 1. **Dependency surface.** Adding `serde_json` as a main dep (it's
//    currently dev-dep only) triggers `dependency-policy.md` review.
//    A 50-line hand-rolled encoder/decoder for a fixed single-field
//    schema avoids the review without losing audit clarity — the
//    canonical encoding rules from spec § 9.5.2 are visible inline.
// 2. **Canonical-encoding discipline.** `serde_json` requires careful
//    configuration (BTreeMap for sorted keys, no whitespace presets,
//    explicit float rejection) to satisfy the spec § 9.5.2 rules.
//    The hand-rolled version enforces all four by construction.
//
// When a future v0.1.x minor revision adds a second field, this
// encoder grows by one match arm — the discipline scales linearly
// until ~5-10 fields, at which point migrating to `serde_json` +
// `BTreeMap` becomes the right call (separate decision, separate
// `dependency-policy.md` PR review).

fn canonical_json_encode(prefs: &PrefsView) -> Vec<u8> {
    // Keys lexicographically sorted (spec § 9.5.2): "deliberate_folders" (d)
    // precedes "screen_capture_protection" (s). The deliberate_folders array is
    // OMITTED entirely when empty, so a vault with no deliberate folders is
    // byte-identical to a v0.1.0 vault.prefs (preserves existing KAT vectors).
    let mut out = Vec::with_capacity(64);
    out.push(b'{');

    // auto_lock_seconds (canonically FIRST — 'a' < 'd' < 's'); omitted
    // entirely when None so an unset vault is byte-identical to a
    // pre-MYND-121 vault.prefs (preserves existing KAT vectors).
    if let Some(secs) = prefs.auto_lock_seconds {
        out.extend_from_slice(b"\"auto_lock_seconds\":");
        push_json_uint(&mut out, secs);
        out.push(b',');
    }

    // daily-notes fields (MYND-191), canonical key order:
    // daily_date_format < daily_folder < daily_template (all 'dai…' sort before
    // 'del…' = deliberate_folders). Each omitted when None, so a vault that
    // never set a daily preference is byte-identical to a pre-MYND-191
    // vault.prefs.
    if let Some(ref fmt) = prefs.daily_date_format {
        out.extend_from_slice(b"\"daily_date_format\":");
        push_json_string(&mut out, &fmt.nfc().collect::<String>());
        out.push(b',');
    }
    if let Some(ref folder) = prefs.daily_folder {
        out.extend_from_slice(b"\"daily_folder\":");
        push_json_string(&mut out, &folder.nfc().collect::<String>());
        out.push(b',');
    }
    if let Some(ref tmpl) = prefs.daily_template {
        out.extend_from_slice(b"\"daily_template\":");
        push_json_string(&mut out, &tmpl.nfc().collect::<String>());
        out.push(b',');
    }

    let folders = canonical_folder_list(&prefs.deliberate_folders);
    if !folders.is_empty() {
        out.extend_from_slice(b"\"deliberate_folders\":[");
        for (i, f) in folders.iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            push_json_string(&mut out, f);
        }
        out.extend_from_slice(b"],");
    }

    // editor_layout (canonical key 'e' — after 'd', before 'f'/'n'/'s').
    // A nested object; omitted entirely when None so a vault that never
    // customized the sidebar layout stays byte-identical to a pre-MYND-137
    // vault.prefs. The four nested keys are emitted in canonical
    // (lexicographic) order: left_collapsed < left_width < right_collapsed
    // < right_width.
    if let Some(layout) = prefs.editor_layout {
        out.extend_from_slice(b"\"editor_layout\":{\"left_collapsed\":");
        out.extend_from_slice(if layout.left_collapsed {
            b"true"
        } else {
            b"false"
        });
        out.extend_from_slice(b",\"left_width\":");
        push_json_uint(&mut out, layout.left_width);
        out.extend_from_slice(b",\"right_collapsed\":");
        out.extend_from_slice(if layout.right_collapsed {
            b"true"
        } else {
            b"false"
        });
        out.extend_from_slice(b",\"right_width\":");
        push_json_uint(&mut out, layout.right_width);
        out.extend_from_slice(b"},");
    }

    // favorites (canonical key 'f' — after 'e', before 'i'/'s'). Order
    // is MEANINGFUL (the favorites display sequence), so the array is
    // preserved verbatim — NOT sorted, NOT deduped — unlike
    // deliberate_folders. Omitted when empty so a vault with no favorites
    // stays byte-identical to one without the key.
    if !prefs.favorites.is_empty() {
        out.extend_from_slice(b"\"favorites\":");
        push_ordered_string_array(&mut out, &prefs.favorites);
        out.push(b',');
    }

    // item_order (canonical key 'i' — after 'f', before 's'). The unified
    // sidebar order: a heterogeneous sequence of note UUIDs + folder paths.
    // Same order-preserving discipline as favorites.
    if !prefs.item_order.is_empty() {
        out.extend_from_slice(b"\"item_order\":");
        push_ordered_string_array(&mut out, &prefs.item_order);
        out.push(b',');
    }

    out.extend_from_slice(b"\"screen_capture_protection\":");
    out.extend_from_slice(if prefs.screen_capture_protection {
        b"true"
    } else {
        b"false"
    });

    // theme (canonical key 't' — LAST, after 's'). Omitted entirely when
    // None so an unset vault (≡ system) is byte-identical to a pre-MYND-110
    // vault.prefs (preserves existing KAT vectors). When Some, a JSON string
    // value "light"/"dark".
    if let Some(theme) = prefs.theme {
        out.extend_from_slice(b",\"theme\":\"");
        let value: &[u8] = match theme {
            ThemeChoice::Light => b"light",
            ThemeChoice::Dark => b"dark",
        };
        out.extend_from_slice(value);
        out.push(b'"');
    }

    out.push(b'}');
    out
}

/// NFC-normalize, lexicographically sort, and exact-dedupe a folder list so the
/// canonical encoding is deterministic regardless of caller insertion order or
/// pre-normalization byte form (spec § 9.5.2 UTF-8 NFC + sorted-keys
/// discipline, extended per-element to the array). Folded-identity dedup
/// (case-insensitivity) is the set-management layer's job, NOT the codec's —
/// the codec preserves distinct display forms and only collapses exact dupes.
fn canonical_folder_list(folders: &[String]) -> Vec<String> {
    let mut v: Vec<String> = folders
        .iter()
        .map(|s| s.nfc().collect::<String>())
        .collect();
    v.sort();
    v.dedup();
    v
}

/// Append an ORDER-PRESERVING canonical JSON string array (surrounding
/// `[` / `]`, comma-joined, each element a `push_json_string` literal).
/// Unlike [`canonical_folder_list`] (which sorts + dedupes for `set`
/// semantics), the `item_order` / `favorites` arrays carry a
/// meaningful SEQUENCE, so element order is preserved verbatim. Each
/// element is NFC-normalized for cross-implementation byte-stability
/// (spec § 9.5.2), but the list is neither sorted nor deduped —
/// reordering is the whole point of the field, and the output stays
/// deterministic given the same logical value (which is all canonical
/// byte-stability requires).
fn push_ordered_string_array(out: &mut Vec<u8>, items: &[String]) {
    out.push(b'[');
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        let nfc = item.nfc().collect::<String>();
        push_json_string(out, &nfc);
    }
    out.push(b']');
}

/// Append `s` as a JSON string literal (with surrounding quotes), escaping `"`,
/// `\`, and C0 control chars per RFC 8259. `/` is left unescaped (canonical).
/// Non-control characters pass through as UTF-8.
fn push_json_string(out: &mut Vec<u8>, s: &str) {
    out.push(b'"');
    for ch in s.chars() {
        match ch {
            '"' => out.extend_from_slice(b"\\\""),
            '\\' => out.extend_from_slice(b"\\\\"),
            '\u{08}' => out.extend_from_slice(b"\\b"),
            '\u{0c}' => out.extend_from_slice(b"\\f"),
            '\n' => out.extend_from_slice(b"\\n"),
            '\r' => out.extend_from_slice(b"\\r"),
            '\t' => out.extend_from_slice(b"\\t"),
            c if (c as u32) < 0x20 => {
                let code = c as u32;
                out.extend_from_slice(b"\\u00");
                out.push(hex_nibble((code >> 4) as u8));
                out.push(hex_nibble((code & 0xF) as u8));
            }
            c => {
                let mut buf = [0u8; 4];
                out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            }
        }
    }
    out.push(b'"');
}

fn hex_nibble(n: u8) -> u8 {
    match n {
        0..=9 => b'0' + n,
        _ => b'a' + (n - 10),
    }
}

/// Append `n` as a canonical decimal integer (no leading zeros, no
/// trailing `.0` — spec § 9.5.2). `n == 0` emits `"0"`.
fn push_json_uint(out: &mut Vec<u8>, n: u32) {
    // u32::MAX is 10 digits; a fixed buffer avoids any alloc churn and
    // keeps the encoder hand-rolled/audit-clear like the rest of § 9.5.
    let mut buf = [0u8; 10];
    let mut i = buf.len();
    let mut v = n;
    loop {
        i -= 1;
        buf[i] = b'0' + (v % 10) as u8;
        v /= 10;
        if v == 0 {
            break;
        }
    }
    out.extend_from_slice(&buf[i..]);
}

/// Parse the v0.1 canonical-JSON `vault.prefs` plaintext.
///
/// Tolerant against future v0.1.x minor revisions that append fields:
/// if the input matches the v0.1.0 single-field shape exactly, return
/// the parsed `PrefsView`; if the input is a v0.1.1+ multi-field
/// object that still carries `screen_capture_protection`, the unknown
/// fields are silently ignored (per spec § 9.5.2 forward-compat
/// "older clients SHOULD NOT reject unknown fields").
///
/// Returns [`PrefsBlobError::PlaintextParseFailed`] for any structural
/// malformation (missing `{...}` wrapper, missing
/// `screen_capture_protection` key, wrong value type, truncated).
fn canonical_json_decode(plaintext: &[u8]) -> Result<PrefsView, PrefsBlobError> {
    // Substring-located fields within the wrapping object. Handles v0.1.0
    // (single field), the v0.1.x deliberate_folders addition, and future
    // additive fields (ignored per spec § 9.5.2 forward-compat). The decoder
    // runs only AFTER AEAD verification, so any field-content confusion (a
    // folder name literally containing a key marker) is self-inflicted by the
    // prefs_key holder and collapses to fall-back-to-defaults — not adversarial.
    //
    // Acceptable shape: starts with `{`, ends with `}`. `screen_capture_protection`
    // is required (`true`/`false`, strict suffix). `deliberate_folders` is
    // optional (absent → empty); when present its value must be a well-formed
    // JSON string array.
    let stripped = plaintext
        .strip_prefix(b"{")
        .and_then(|p| p.strip_suffix(b"}"))
        .ok_or(PrefsBlobError::PlaintextParseFailed)?;

    // ---- auto_lock_seconds (optional, canonically FIRST) ----
    // Canonical key order is auto_lock_seconds < deliberate_folders <
    // screen_capture_protection, so when present this field is a literal
    // PREFIX of the stripped object — matched by `strip_prefix` rather
    // than `find_subslice`, so a later folder name containing a
    // `"auto_lock_seconds":`-looking substring cannot fool it.
    let auto_marker = b"\"auto_lock_seconds\":";
    let (auto_lock_seconds, rest) = match stripped.strip_prefix(auto_marker) {
        Some(after) => {
            let (val, consumed) = parse_json_uint(after)?;
            // The integer MUST be followed by `,` — screen_capture_protection
            // is mandatory and canonically last, so a further field always
            // follows. A trailing `.` (float, FORBIDDEN per spec § 9.5.2) or
            // any other non-`,` byte therefore rejects here.
            let rest = after[consumed..]
                .strip_prefix(b",")
                .ok_or(PrefsBlobError::PlaintextParseFailed)?;
            (Some(val), rest)
        }
        None => (None, stripped),
    };

    // ---- optional string-array fields (canonical key order) ----
    // deliberate_folders (d) → editor_layout (e) → favorites (f) →
    // item_order (i). Each is located from a MONOTONIC cursor that only
    // advances past already-parsed spans, so a later field's key marker is
    // never matched inside a prior field's array content (JSON `"`-escaping
    // already prevents a marker from appearing inside a string value, but the
    // cursor keeps the canonical key-order discipline visible + robust).
    let mut cursor = 0usize;
    // daily-notes string fields (MYND-191), canonical key order:
    // daily_date_format (dai…) < daily_folder < daily_template, all before
    // deliberate_folders (del…). Optional → None when the key is absent.
    let daily_date_format =
        parse_optional_string_field(rest, &mut cursor, b"\"daily_date_format\":")?;
    let daily_folder = parse_optional_string_field(rest, &mut cursor, b"\"daily_folder\":")?;
    let daily_template = parse_optional_string_field(rest, &mut cursor, b"\"daily_template\":")?;
    let deliberate_folders =
        parse_optional_array_field(rest, &mut cursor, b"\"deliberate_folders\":")?;
    // editor_layout (canonical key 'e') sits between deliberate_folders (d)
    // and favorites (f); parsed from the same monotonic cursor so a later
    // field's key marker is never matched inside the nested object.
    let editor_layout = parse_optional_editor_layout(rest, &mut cursor, b"\"editor_layout\":")?;
    let favorites = parse_optional_array_field(rest, &mut cursor, b"\"favorites\":")?;
    let item_order = parse_optional_array_field(rest, &mut cursor, b"\"item_order\":")?;

    // ---- screen_capture_protection (required) ----
    let region = &rest[cursor..];
    let key_marker = b"\"screen_capture_protection\":";
    let idx = find_subslice(region, key_marker).ok_or(PrefsBlobError::PlaintextParseFailed)?;
    let after_key = &region[idx + key_marker.len()..];

    // Strict suffix: value is exactly `true`/`false` followed by end-of-object
    // (no further field → empty) or `,` (a further field — e.g. theme, or a
    // future v0.1.x field). `starts_with` alone would accept `truefoo` →
    // silent data-integrity bug on tampered-but-AEAD-OK input.
    let screen_capture_protection = if after_key == b"true" || after_key.starts_with(b"true,") {
        true
    } else if after_key == b"false" || after_key.starts_with(b"false,") {
        false
    } else {
        return Err(PrefsBlobError::PlaintextParseFailed);
    };

    // ---- theme (optional, canonically LAST — key 't' > 's') ----
    // Tolerant: an absent key OR an unrecognized value decodes to `None`
    // (≡ system), treated like an unknown field per spec § 9.5.2
    // forward-compat rather than failing the whole parse — `theme` is a
    // non-load-bearing cosmetic preference, so a future "sepia" value read
    // by a v0.1 client must not strand the other (load-bearing) fields.
    // Located by marker in the region after screen_capture_protection's
    // boolean, so a future field sorting between `s` and `t` cannot hide it.
    let theme = parse_optional_theme(after_key);

    Ok(PrefsView {
        screen_capture_protection,
        deliberate_folders,
        auto_lock_seconds,
        daily_date_format,
        daily_folder,
        daily_template,
        favorites,
        item_order,
        editor_layout,
        theme,
    })
}

/// Parse an OPTIONAL canonical JSON string-valued field whose key marker is
/// `marker`, searching `rest` from `*cursor` onward. On a hit, advances
/// `*cursor` past the closing `"` and returns `Some(value)`; on a miss returns
/// `None` and leaves `*cursor` unchanged. Mirrors
/// [`parse_optional_array_field`] for a single-string value (the daily-notes
/// fields, MYND-191), keeping the same monotonic-cursor canonical-key-order
/// discipline.
fn parse_optional_string_field(
    rest: &[u8],
    cursor: &mut usize,
    marker: &[u8],
) -> Result<Option<String>, PrefsBlobError> {
    match find_subslice(&rest[*cursor..], marker) {
        Some(rel_idx) => {
            let val_start = *cursor + rel_idx + marker.len();
            let (value, consumed) = parse_json_string(&rest[val_start..])
                .ok_or(PrefsBlobError::PlaintextParseFailed)?;
            *cursor = val_start + consumed;
            Ok(Some(value))
        }
        None => Ok(None),
    }
}

/// Parse the OPTIONAL `theme` field from `region` (the bytes from
/// screen_capture_protection's value to the end of the object). Tolerant:
/// returns `None` when the key is absent OR when the value is a JSON string
/// other than `"light"` / `"dark"`. An unrecognized value is treated as an
/// unknown field (forward-compat, spec § 9.5.2) rather than a parse
/// failure, because `theme` is a non-load-bearing cosmetic preference and
/// `None` ≡ follow-the-OS. Located by `find_subslice` on the key marker so
/// a future field sorting between `screen_capture_protection` and `theme`
/// does not hide it.
fn parse_optional_theme(region: &[u8]) -> Option<ThemeChoice> {
    let marker = b"\"theme\":";
    let idx = find_subslice(region, marker)?;
    let after = &region[idx + marker.len()..];
    let (value, _consumed) = parse_json_string(after)?;
    match value.as_str() {
        "light" => Some(ThemeChoice::Light),
        "dark" => Some(ThemeChoice::Dark),
        _ => None,
    }
}

/// Parse the OPTIONAL `editor_layout` nested object, searching `rest`
/// from `*cursor` onward (canonical key order: it follows
/// `deliberate_folders` and precedes `favorites`). On a hit, advances
/// `*cursor` past the closing `}` and returns `Some(EditorLayout)`; on a
/// miss returns `None` and leaves `*cursor` unchanged. The nested object
/// has a fixed canonical shape (four keys in lexicographic order); any
/// structural deviation rejects with [`PrefsBlobError::PlaintextParseFailed`]
/// (the caller collapses to defaults per spec § 9.5.5).
fn parse_optional_editor_layout(
    rest: &[u8],
    cursor: &mut usize,
    marker: &[u8],
) -> Result<Option<EditorLayout>, PrefsBlobError> {
    match find_subslice(&rest[*cursor..], marker) {
        Some(rel_idx) => {
            let obj_start = *cursor + rel_idx + marker.len();
            let (layout, consumed) = parse_editor_layout_object(&rest[obj_start..])
                .ok_or(PrefsBlobError::PlaintextParseFailed)?;
            *cursor = obj_start + consumed;
            Ok(Some(layout))
        }
        None => Ok(None),
    }
}

/// Parse the fixed-shape `editor_layout` nested object starting at
/// `bytes[0] == '{'`. Expects exactly the canonical key order
/// `{"left_collapsed":<bool>,"left_width":<uint>,"right_collapsed":<bool>,"right_width":<uint>}`.
/// Returns the decoded [`EditorLayout`] + bytes consumed (through the
/// closing `}`), or `None` on any malformation. A fractional width (e.g.
/// `260.5`) parses the integer part then fails the required `,`/`}`
/// terminator — enforcing the spec § 9.5.2 float ban structurally.
fn parse_editor_layout_object(bytes: &[u8]) -> Option<(EditorLayout, usize)> {
    let rest = bytes.strip_prefix(b"{\"left_collapsed\":")?;
    let (left_collapsed, rest) = parse_json_bool(rest)?;
    let rest = rest.strip_prefix(b",\"left_width\":")?;
    let (left_width, n) = parse_json_uint(rest).ok()?;
    let rest = &rest[n..];
    let rest = rest.strip_prefix(b",\"right_collapsed\":")?;
    let (right_collapsed, rest) = parse_json_bool(rest)?;
    let rest = rest.strip_prefix(b",\"right_width\":")?;
    let (right_width, n) = parse_json_uint(rest).ok()?;
    let rest = &rest[n..];
    let rest = rest.strip_prefix(b"}")?;
    let consumed = bytes.len() - rest.len();
    Some((
        EditorLayout {
            left_width,
            right_width,
            left_collapsed,
            right_collapsed,
        },
        consumed,
    ))
}

/// Parse a leading `true` / `false` literal, returning `(value, remaining)`.
/// Strict — any other byte sequence is `None`.
fn parse_json_bool(bytes: &[u8]) -> Option<(bool, &[u8])> {
    if let Some(r) = bytes.strip_prefix(b"true") {
        Some((true, r))
    } else if let Some(r) = bytes.strip_prefix(b"false") {
        Some((false, r))
    } else {
        None
    }
}

/// Parse an OPTIONAL canonical string-array field whose key marker is
/// `marker`, searching `rest` from `*cursor` onward. On a hit, advances
/// `*cursor` past the closing `]` and returns the decoded list; on a miss
/// returns an empty list and leaves `*cursor` unchanged. Searching from a
/// monotonically-advancing cursor (rather than from 0) keeps the canonical
/// key-order discipline load-bearing — a later field's key marker is only
/// matched after the prior field's array span.
fn parse_optional_array_field(
    rest: &[u8],
    cursor: &mut usize,
    marker: &[u8],
) -> Result<Vec<String>, PrefsBlobError> {
    match find_subslice(&rest[*cursor..], marker) {
        Some(rel_idx) => {
            let array_start = *cursor + rel_idx + marker.len();
            let (list, consumed) = parse_json_string_array(&rest[array_start..])
                .ok_or(PrefsBlobError::PlaintextParseFailed)?;
            *cursor = array_start + consumed;
            Ok(list)
        }
        None => Ok(Vec::new()),
    }
}

/// Parse a leading run of ASCII decimal digits into a `u32`, returning
/// `(value, digits_consumed)`. Rejects an empty run (no digit present)
/// and overflow. It consumes ONLY digit bytes, so a fractional literal
/// like `300.5` parses `300` and leaves the `.` for the caller's
/// terminator check to reject — enforcing the spec § 9.5.2 float ban.
fn parse_json_uint(bytes: &[u8]) -> Result<(u32, usize), PrefsBlobError> {
    let mut i = 0;
    let mut val: u32 = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        let d = (bytes[i] - b'0') as u32;
        val = val
            .checked_mul(10)
            .and_then(|v| v.checked_add(d))
            .ok_or(PrefsBlobError::PlaintextParseFailed)?;
        i += 1;
    }
    if i == 0 {
        return Err(PrefsBlobError::PlaintextParseFailed);
    }
    Ok((val, i))
}

/// Parse a JSON array of strings starting at `bytes[0] == '['`. Returns the
/// decoded strings + bytes consumed (through the closing `]`), or `None` on
/// any malformation. No nesting beyond strings (the only array v0.1 uses).
fn parse_json_string_array(bytes: &[u8]) -> Option<(Vec<String>, usize)> {
    if bytes.first() != Some(&b'[') {
        return None;
    }
    let mut i = 1;
    let mut out: Vec<String> = Vec::new();
    if bytes.get(i) == Some(&b']') {
        return Some((out, i + 1));
    }
    loop {
        if bytes.get(i) != Some(&b'"') {
            return None;
        }
        let (s, consumed) = parse_json_string(&bytes[i..])?;
        out.push(s);
        i += consumed;
        match bytes.get(i) {
            Some(&b',') => {
                i += 1;
                continue;
            }
            Some(&b']') => return Some((out, i + 1)),
            _ => return None,
        }
    }
}

/// Parse a JSON string literal starting at `bytes[0] == '"'`. Returns the
/// decoded `String` + bytes consumed (through the closing `"`), or `None`.
/// Unescaped bytes are copied verbatim (multi-byte UTF-8 preserved) and the
/// accumulated buffer is UTF-8-validated at the close.
fn parse_json_string(bytes: &[u8]) -> Option<(String, usize)> {
    if bytes.first() != Some(&b'"') {
        return None;
    }
    let mut buf: Vec<u8> = Vec::new();
    let mut i = 1;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => return String::from_utf8(buf).ok().map(|s| (s, i + 1)),
            b'\\' => {
                i += 1;
                match *bytes.get(i)? {
                    b'"' => buf.push(b'"'),
                    b'\\' => buf.push(b'\\'),
                    b'/' => buf.push(b'/'),
                    b'b' => buf.push(0x08),
                    b'f' => buf.push(0x0c),
                    b'n' => buf.push(b'\n'),
                    b'r' => buf.push(b'\r'),
                    b't' => buf.push(b'\t'),
                    b'u' => {
                        let cp = parse_hex4(bytes.get(i + 1..i + 5)?)?;
                        let ch = char::from_u32(cp)?;
                        let mut cb = [0u8; 4];
                        buf.extend_from_slice(ch.encode_utf8(&mut cb).as_bytes());
                        i += 4;
                    }
                    _ => return None,
                }
                i += 1;
            }
            b => {
                buf.push(b);
                i += 1;
            }
        }
    }
    None
}

/// Parse exactly 4 lowercase/uppercase hex digits into a `u32` code point.
fn parse_hex4(h: &[u8]) -> Option<u32> {
    if h.len() != 4 {
        return None;
    }
    let mut v = 0u32;
    for &b in h {
        let d = match b {
            b'0'..=b'9' => (b - b'0') as u32,
            b'a'..=b'f' => (b - b'a' + 10) as u32,
            b'A'..=b'F' => (b - b'A' + 10) as u32,
            _ => return None,
        };
        v = v * 16 + d;
    }
    Some(v)
}

/// Naive substring search — `slice::windows().position()` equivalent
/// without depending on `[u8]::contains_slice` (unstable as of Rust
/// 1.90). v0.1 plaintexts are bounded at 64 KiB; the O(n×m) cost is
/// negligible for the single short key we look up.
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

// ---- encode / decode primitives ---------------------------------------

/// Encode a `vault.prefs` blob with caller-supplied randomness
/// (`_raw` per `protocol/CLAUDE.md` randomness-injection convention).
///
/// Returns the 34-byte header followed by `ciphertext || T'` per spec
/// § 9.5.1. Reject inputs that would exceed [`MAX_PREFS_PLAINTEXT_LEN`]
/// at the canonical JSON encoding stage — v0.1's single-bool schema
/// is always well under the cap, but the bound is enforced symmetric
/// with the decoder so encoder + decoder round-trip stays well-defined
/// at the boundary.
///
/// `_raw` callers source `prefs_nonce` from a CSPRNG-grade source —
/// nonce reuse under the same `prefs_key` is catastrophic per the
/// XChaCha20-Poly1305 contract. Production callers SHOULD use
/// [`encode_prefs_blob`], which pulls randomness from `getrandom`.
pub fn encode_prefs_blob_raw(
    prefs_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; PREFS_BLOB_ACCOUNT_HASH_LEN],
    prefs: &PrefsView,
    prefs_nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, PrefsBlobError> {
    let plaintext = Zeroizing::new(canonical_json_encode(prefs));

    if plaintext.len() > MAX_PREFS_PLAINTEXT_LEN {
        // Defensive — v0.1 schema cannot reach this, but a future field
        // mix could; encoder enforces symmetric to the decoder.
        return Err(PrefsBlobError::CiphertextLenOverflow);
    }

    let aad = aad_prefs_blob(account_number_hash);
    let sealed = aead_seal_ctx(prefs_key, prefs_nonce, &plaintext, &aad)?;

    // sealed = ciphertext || T' where T' is the 32-byte CTX tag.
    // ciphertext_len in the header = sealed.len() = plaintext.len() + 32.
    let ciphertext_len = sealed.len();
    debug_assert_eq!(
        ciphertext_len,
        plaintext.len() + CTX_COMMITMENT_TAG_LEN,
        "aead_seal_ctx invariant: output is ciphertext || CTX tag",
    );

    let mut out = Vec::with_capacity(PREFS_BLOB_HEADER_LEN + ciphertext_len);
    out.extend_from_slice(&PREFS_BLOB_MAGIC);
    out.push(PREFS_BLOB_PROTOCOL_VERSION);
    out.push(PREFS_BLOB_RESERVED);
    out.extend_from_slice(prefs_nonce);
    out.extend_from_slice(&(ciphertext_len as u32).to_be_bytes());
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Encode a `vault.prefs` blob, pulling the 24-byte nonce from the OS
/// CSPRNG via `getrandom`. Production callers SHOULD use this rather
/// than [`encode_prefs_blob_raw`] — it shifts the "do not reuse a
/// nonce under the same key" contract from the caller to the OS
/// CSPRNG, which is the correct boundary.
pub fn encode_prefs_blob(
    prefs_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; PREFS_BLOB_ACCOUNT_HASH_LEN],
    prefs: &PrefsView,
) -> Result<Vec<u8>, PrefsBlobError> {
    let mut prefs_nonce = [0u8; AEAD_NONCE_LEN];
    getrandom(&mut prefs_nonce).map_err(|_| PrefsBlobError::RandomnessUnavailable)?;
    let result = encode_prefs_blob_raw(prefs_key, account_number_hash, prefs, &prefs_nonce);
    prefs_nonce.zeroize();
    result
}

/// Decode a `vault.prefs` blob into a `PrefsView`.
///
/// Returns the parsed preferences on success. Failure modes are
/// reported as distinct `PrefsBlobError` variants for observability;
/// per spec § 9.5.5 the caller (Tauri plugin layer) collapses all of
/// them to `PrefsView::default()` before surfacing to the user.
pub fn decode_prefs_blob(
    prefs_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; PREFS_BLOB_ACCOUNT_HASH_LEN],
    blob: &[u8],
) -> Result<PrefsView, PrefsBlobError> {
    // ---- parse the 34-byte header --------------------------------------
    if blob.len() < PREFS_BLOB_HEADER_LEN {
        return Err(PrefsBlobError::HeaderTooShort);
    }
    if blob[0..4] != PREFS_BLOB_MAGIC {
        return Err(PrefsBlobError::MagicMismatch);
    }
    if blob[4] != PREFS_BLOB_PROTOCOL_VERSION {
        return Err(PrefsBlobError::ProtocolVersionMismatch);
    }
    if blob[5] != PREFS_BLOB_RESERVED {
        return Err(PrefsBlobError::ReservedByteNonZero);
    }

    let mut prefs_nonce = [0u8; AEAD_NONCE_LEN];
    prefs_nonce.copy_from_slice(&blob[6..30]);

    let ciphertext_len = u32::from_be_bytes([blob[30], blob[31], blob[32], blob[33]]) as usize;

    // Reject oversize BEFORE indexing into the blob — otherwise a
    // hostile `ciphertext_len = 0xFFFFFFFF` blob causes a panicking
    // slice-index instead of a clean error.
    if ciphertext_len > MAX_PREFS_PLAINTEXT_LEN + CTX_COMMITMENT_TAG_LEN {
        return Err(PrefsBlobError::CiphertextLenOverflow);
    }
    let ciphertext_end = PREFS_BLOB_HEADER_LEN + ciphertext_len;
    if blob.len() < ciphertext_end {
        return Err(PrefsBlobError::CiphertextTruncated);
    }

    // ---- AEAD-decrypt --------------------------------------------------
    let aad = aad_prefs_blob(account_number_hash);
    let plaintext_zeroizing = aead_open_ctx(
        prefs_key,
        &prefs_nonce,
        &blob[PREFS_BLOB_HEADER_LEN..ciphertext_end],
        &aad,
    )?;

    // ---- parse the inner canonical JSON --------------------------------
    canonical_json_decode(&plaintext_zeroizing)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subkey::{derive_subkey, SubkeyRole};

    // Fixed root_key + account_number_hash so KAT-style tests are
    // deterministic. Real-world callers source these from `getrandom`
    // and `vault.meta` respectively.
    fn fixed_root_key() -> [u8; 32] {
        [0x42; 32]
    }
    fn fixed_account_number_hash() -> [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] {
        [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN]
    }
    fn fixed_prefs_nonce() -> [u8; AEAD_NONCE_LEN] {
        [0x77; AEAD_NONCE_LEN]
    }

    // ---- canonical JSON encoder ----------------------------------------

    #[test]
    fn canonical_json_encodes_true_to_expected_bytes() {
        let prefs = PrefsView {
            screen_capture_protection: true,
            theme: None,
            item_order: Vec::new(),
            favorites: Vec::new(),
            deliberate_folders: Vec::new(),
            auto_lock_seconds: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            editor_layout: None,
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
    }

    #[test]
    fn canonical_json_encodes_false_to_expected_bytes() {
        let prefs = PrefsView {
            screen_capture_protection: false,
            theme: None,
            item_order: Vec::new(),
            favorites: Vec::new(),
            deliberate_folders: Vec::new(),
            auto_lock_seconds: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            editor_layout: None,
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"screen_capture_protection":false}"#
        );
    }

    #[test]
    fn canonical_json_encoding_has_no_whitespace() {
        // Spec § 9.5.2: no insignificant whitespace. Verify byte-exact.
        let encoded = canonical_json_encode(&PrefsView::default());
        assert!(!encoded.contains(&b' '));
        assert!(!encoded.contains(&b'\n'));
        assert!(!encoded.contains(&b'\t'));
        assert!(!encoded.contains(&b'\r'));
    }

    #[test]
    fn canonical_json_encoding_is_deterministic() {
        // Same input → same output, every call.
        let prefs = PrefsView::default();
        let a = canonical_json_encode(&prefs);
        let b = canonical_json_encode(&prefs);
        assert_eq!(a, b);
    }

    // ---- canonical JSON decoder ----------------------------------------

    #[test]
    fn canonical_json_decodes_true() {
        let parsed = canonical_json_decode(br#"{"screen_capture_protection":true}"#).unwrap();
        assert_eq!(
            parsed,
            PrefsView {
                screen_capture_protection: true,
                theme: None,
                item_order: Vec::new(),
                favorites: Vec::new(),
                deliberate_folders: Vec::new(),
                auto_lock_seconds: None,
                daily_date_format: None,
                daily_folder: None,
                daily_template: None,
                editor_layout: None,
            }
        );
    }

    #[test]
    fn canonical_json_decodes_false() {
        let parsed = canonical_json_decode(br#"{"screen_capture_protection":false}"#).unwrap();
        assert_eq!(
            parsed,
            PrefsView {
                screen_capture_protection: false,
                theme: None,
                item_order: Vec::new(),
                favorites: Vec::new(),
                deliberate_folders: Vec::new(),
                auto_lock_seconds: None,
                daily_date_format: None,
                daily_folder: None,
                daily_template: None,
                editor_layout: None,
            }
        );
    }

    #[test]
    fn canonical_json_decoder_tolerates_future_unknown_fields() {
        // Spec § 9.5.2 forward-compat: a v0.1.0 client reading a
        // v0.1.1+ plaintext with extra fields must still recover the
        // known fields rather than rejecting. `theme` is now KNOWN (so it
        // parses), while `zoom_level` (sorting after `theme`) is a genuinely
        // unknown future field that must be ignored.
        let parsed = canonical_json_decode(
            br#"{"screen_capture_protection":true,"theme":"dark","zoom_level":2}"#,
        )
        .unwrap();
        assert!(parsed.screen_capture_protection);
        assert_eq!(parsed.theme, Some(ThemeChoice::Dark));
    }

    #[test]
    fn canonical_json_decoder_rejects_missing_wrapper() {
        let err = canonical_json_decode(br#""screen_capture_protection":true"#).unwrap_err();
        assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
    }

    #[test]
    fn canonical_json_decoder_rejects_missing_key() {
        let err = canonical_json_decode(br#"{"other_field":true}"#).unwrap_err();
        assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
    }

    #[test]
    fn canonical_json_decoder_rejects_non_bool_value() {
        let err = canonical_json_decode(br#"{"screen_capture_protection":42}"#).unwrap_err();
        assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
    }

    #[test]
    fn canonical_json_decoder_rejects_truncated_after_key() {
        let err = canonical_json_decode(br#"{"screen_capture_protection":}"#).unwrap_err();
        assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
    }

    #[test]
    fn canonical_json_decoder_rejects_trailing_garbage_after_true() {
        // Strict-suffix discipline: `truefoo` MUST NOT be accepted as
        // `true`. Catches tampered-but-AEAD-OK plaintexts that try to
        // sneak past via prefix matching.
        let err = canonical_json_decode(br#"{"screen_capture_protection":truefoo}"#).unwrap_err();
        assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
    }

    #[test]
    fn canonical_json_decoder_rejects_trailing_garbage_after_false() {
        let err = canonical_json_decode(br#"{"screen_capture_protection":falseyyy}"#).unwrap_err();
        assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
    }

    // ---- theme canonical field (MYND-110) -----------------------------

    #[test]
    fn encode_omits_theme_when_none() {
        // None ≡ system → byte-identical to a pre-MYND-110 vault.prefs
        // (preserves existing KAT vectors + existing vaults).
        let encoded = canonical_json_encode(&PrefsView {
            theme: None,
            ..PrefsView::default()
        });
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
    }

    #[test]
    fn encode_emits_theme_last_light() {
        // Canonical key order: theme (t) is LAST, after screen_capture_protection (s).
        let encoded = canonical_json_encode(&PrefsView {
            theme: Some(ThemeChoice::Light),
            ..PrefsView::default()
        });
        assert_eq!(
            encoded.as_slice(),
            br#"{"screen_capture_protection":true,"theme":"light"}"#,
        );
    }

    #[test]
    fn encode_emits_theme_last_dark_with_scp_false() {
        let encoded = canonical_json_encode(&PrefsView {
            screen_capture_protection: false,
            theme: Some(ThemeChoice::Dark),
            ..PrefsView::default()
        });
        assert_eq!(
            encoded.as_slice(),
            br#"{"screen_capture_protection":false,"theme":"dark"}"#,
        );
    }

    #[test]
    fn encode_emits_theme_after_all_other_fields() {
        // Full field-mix: a < d < e < f < i < s < t. theme sits last.
        let prefs = PrefsView {
            screen_capture_protection: true,
            deliberate_folders: alloc::vec![alloc::string::String::from("Archive/")],
            auto_lock_seconds: Some(300),
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            favorites: alloc::vec![alloc::string::String::from("f1")],
            item_order: alloc::vec![alloc::string::String::from("n1")],
            editor_layout: Some(EditorLayout {
                left_width: 312,
                right_width: 288,
                left_collapsed: false,
                right_collapsed: true,
            }),
            theme: Some(ThemeChoice::Dark),
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"auto_lock_seconds":300,"deliberate_folders":["Archive/"],"editor_layout":{"left_collapsed":false,"left_width":312,"right_collapsed":true,"right_width":288},"favorites":["f1"],"item_order":["n1"],"screen_capture_protection":true,"theme":"dark"}"#,
        );
    }

    #[test]
    fn decode_round_trips_theme_dark() {
        let parsed =
            canonical_json_decode(br#"{"screen_capture_protection":true,"theme":"dark"}"#).unwrap();
        assert_eq!(parsed.theme, Some(ThemeChoice::Dark));
        assert!(parsed.screen_capture_protection);
    }

    #[test]
    fn decode_round_trips_theme_light_with_scp_false() {
        let parsed =
            canonical_json_decode(br#"{"screen_capture_protection":false,"theme":"light"}"#)
                .unwrap();
        assert_eq!(parsed.theme, Some(ThemeChoice::Light));
        assert!(!parsed.screen_capture_protection);
    }

    #[test]
    fn decode_absent_theme_is_none() {
        let parsed = canonical_json_decode(br#"{"screen_capture_protection":true}"#).unwrap();
        assert_eq!(parsed.theme, None);
    }

    #[test]
    fn decode_unknown_theme_value_is_none_tolerant() {
        // A future / unrecognized theme value decodes to None (≡ system),
        // treated as an unknown field per forward-compat — NOT a parse
        // failure that would strand the load-bearing screen_capture_protection.
        let parsed =
            canonical_json_decode(br#"{"screen_capture_protection":true,"theme":"sepia"}"#)
                .unwrap();
        assert_eq!(parsed.theme, None);
        assert!(parsed.screen_capture_protection);
    }

    #[test]
    fn full_blob_round_trip_with_theme() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let account_hash = fixed_account_number_hash();
        let original = PrefsView {
            theme: Some(ThemeChoice::Dark),
            ..PrefsView::default()
        };
        let blob =
            encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce())
                .unwrap();
        let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
        assert_eq!(original, decoded);
        assert_eq!(decoded.theme, Some(ThemeChoice::Dark));
    }

    #[test]
    fn theme_none_round_trips_through_full_blob() {
        // Default (None ≡ system) survives a full encode/decode unchanged
        // and stays byte-identical to a pre-MYND-110 blob (omit-when-None).
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let account_hash = fixed_account_number_hash();
        let original = PrefsView::default();
        let blob =
            encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce())
                .unwrap();
        let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
        assert_eq!(decoded.theme, None);
        assert_eq!(original, decoded);
    }

    // ---- deliberate_folders canonical array (MYND-144) -----------------

    #[test]
    fn encode_omits_deliberate_folders_when_empty() {
        // Byte-identical to the v0.1.0 single-field shape → existing vaults +
        // KAT vectors unchanged.
        let encoded = canonical_json_encode(&PrefsView::default());
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
    }

    #[test]
    fn encode_emits_sorted_keys_with_nonempty_folders() {
        // Keys sorted: deliberate_folders (d) before screen_capture_protection (s).
        let prefs = PrefsView {
            screen_capture_protection: true,
            theme: None,
            item_order: Vec::new(),
            favorites: Vec::new(),
            deliberate_folders: alloc::vec![
                alloc::string::String::from("Projects/"),
                alloc::string::String::from("Archive/"),
            ],
            auto_lock_seconds: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            editor_layout: None,
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"deliberate_folders":["Archive/","Projects/"],"screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn encode_sorts_and_dedupes_folder_elements() {
        let prefs = PrefsView {
            screen_capture_protection: false,
            theme: None,
            item_order: Vec::new(),
            favorites: Vec::new(),
            deliberate_folders: alloc::vec![
                alloc::string::String::from("b/"),
                alloc::string::String::from("a/"),
                alloc::string::String::from("b/"),
            ],
            auto_lock_seconds: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            editor_layout: None,
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"deliberate_folders":["a/","b/"],"screen_capture_protection":false}"#,
        );
    }

    #[test]
    fn encode_escapes_quote_in_folder_name() {
        // `"` is allowed in a folder segment (Q5 forbidden set excludes it),
        // so JSON escaping is load-bearing.
        let prefs = PrefsView {
            screen_capture_protection: true,
            theme: None,
            item_order: Vec::new(),
            favorites: Vec::new(),
            deliberate_folders: alloc::vec![alloc::string::String::from("a\"b/")],
            auto_lock_seconds: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            editor_layout: None,
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"deliberate_folders":["a\"b/"],"screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn encode_nfc_normalizes_folder_elements() {
        // Decomposed "é" (e + U+0301) → NFC precomposed (U+00E9) at encode.
        let prefs = PrefsView {
            screen_capture_protection: true,
            theme: None,
            item_order: Vec::new(),
            favorites: Vec::new(),
            deliberate_folders: alloc::vec![alloc::string::String::from("Cafe\u{0301}/")],
            auto_lock_seconds: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            editor_layout: None,
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            "{\"deliberate_folders\":[\"Caf\u{00e9}/\"],\"screen_capture_protection\":true}"
                .as_bytes(),
        );
    }

    #[test]
    fn decode_backward_compat_absent_folders_is_empty() {
        // A v0.1.0 blob with no deliberate_folders decodes to an empty list.
        let parsed = canonical_json_decode(br#"{"screen_capture_protection":true}"#).unwrap();
        assert_eq!(
            parsed.deliberate_folders,
            Vec::<alloc::string::String>::new()
        );
        assert!(parsed.screen_capture_protection);
    }

    #[test]
    fn decode_round_trips_nonempty_folders() {
        let parsed = canonical_json_decode(
            br#"{"deliberate_folders":["Archive/","Projects/"],"screen_capture_protection":false}"#,
        )
        .unwrap();
        assert_eq!(
            parsed.deliberate_folders,
            alloc::vec![
                alloc::string::String::from("Archive/"),
                alloc::string::String::from("Projects/"),
            ],
        );
        assert!(!parsed.screen_capture_protection);
    }

    #[test]
    fn decode_unescapes_quote_in_folder_name() {
        let parsed = canonical_json_decode(
            br#"{"deliberate_folders":["a\"b/"],"screen_capture_protection":true}"#,
        )
        .unwrap();
        assert_eq!(
            parsed.deliberate_folders,
            alloc::vec![alloc::string::String::from("a\"b/")],
        );
    }

    #[test]
    fn decode_handles_empty_array() {
        let parsed =
            canonical_json_decode(br#"{"deliberate_folders":[],"screen_capture_protection":true}"#)
                .unwrap();
        assert!(parsed.deliberate_folders.is_empty());
    }

    #[test]
    fn decode_rejects_malformed_folder_array() {
        // Unterminated array → parse failure (caller collapses to defaults).
        let err = canonical_json_decode(
            br#"{"deliberate_folders":["a/","screen_capture_protection":true}"#,
        )
        .unwrap_err();
        assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
    }

    #[test]
    fn full_blob_round_trip_with_deliberate_folders() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let account_hash = fixed_account_number_hash();
        let original = PrefsView {
            screen_capture_protection: false,
            theme: None,
            item_order: Vec::new(),
            favorites: Vec::new(),
            deliberate_folders: alloc::vec![
                alloc::string::String::from("Projects/Myne/"),
                alloc::string::String::from("Archive/2025/"),
            ],
            auto_lock_seconds: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            editor_layout: None,
        };
        let blob =
            encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce())
                .unwrap();
        let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
        // Decoded list is canonical (sorted) — compare against the sorted form.
        assert_eq!(
            decoded.deliberate_folders,
            alloc::vec![
                alloc::string::String::from("Archive/2025/"),
                alloc::string::String::from("Projects/Myne/"),
            ],
        );
        assert!(!decoded.screen_capture_protection);
    }

    // ---- item_order / favorites canonical arrays (MYND-183) -----------

    #[test]
    fn encode_omits_order_fields_when_empty() {
        // Empty order lists → byte-identical to the pre-reorder shape.
        let encoded = canonical_json_encode(&PrefsView::default());
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
    }

    #[test]
    fn encode_emits_favorites_and_item_order_in_canonical_key_position() {
        // Canonical key order: d < f < i < s. With deliberate_folders,
        // favorites, item_order, and screen_capture_protection all present,
        // favorites sits after deliberate_folders, item_order after
        // favorites, screen_capture_protection last. item_order is
        // HETEROGENEOUS — a folder path interleaved between note UUIDs.
        let prefs = PrefsView {
            screen_capture_protection: true,
            theme: None,
            deliberate_folders: alloc::vec![alloc::string::String::from("Archive/")],
            auto_lock_seconds: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            favorites: alloc::vec![
                alloc::string::String::from("f2"),
                alloc::string::String::from("f1"),
            ],
            item_order: alloc::vec![
                alloc::string::String::from("n1"),
                alloc::string::String::from("Zebra/"),
                alloc::string::String::from("n2"),
            ],
            editor_layout: None,
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"deliberate_folders":["Archive/"],"favorites":["f2","f1"],"item_order":["n1","Zebra/","n2"],"screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn encode_preserves_order_does_not_sort_or_dedupe() {
        // item_order is a SEQUENCE: element order is the payload, so the
        // encoder must NOT sort and NOT dedupe (contrast canonical_folder_list
        // which does both). The duplicate "zzz" must survive verbatim.
        let prefs = PrefsView {
            screen_capture_protection: true,
            theme: None,
            deliberate_folders: Vec::new(),
            auto_lock_seconds: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            favorites: Vec::new(),
            item_order: alloc::vec![
                alloc::string::String::from("zzz"),
                alloc::string::String::from("aaa"),
                alloc::string::String::from("mmm"),
                alloc::string::String::from("zzz"),
            ],
            editor_layout: None,
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"item_order":["zzz","aaa","mmm","zzz"],"screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn decode_round_trips_favorites_and_item_order_preserving_sequence() {
        let parsed = canonical_json_decode(
            br#"{"favorites":["f2","f1"],"item_order":["n1","Zebra/","n2"],"screen_capture_protection":true}"#,
        )
        .unwrap();
        assert_eq!(
            parsed.favorites,
            alloc::vec![
                alloc::string::String::from("f2"),
                alloc::string::String::from("f1"),
            ],
        );
        assert_eq!(
            parsed.item_order,
            alloc::vec![
                alloc::string::String::from("n1"),
                alloc::string::String::from("Zebra/"),
                alloc::string::String::from("n2"),
            ],
        );
        assert!(parsed.screen_capture_protection);
    }

    #[test]
    fn decode_absent_order_fields_are_empty() {
        let parsed = canonical_json_decode(br#"{"screen_capture_protection":true}"#).unwrap();
        assert!(parsed.item_order.is_empty());
        assert!(parsed.favorites.is_empty());
    }

    #[test]
    fn full_blob_round_trip_with_all_fields() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let account_hash = fixed_account_number_hash();
        let original = PrefsView {
            screen_capture_protection: false,
            theme: None,
            deliberate_folders: alloc::vec![alloc::string::String::from("Projects/")],
            auto_lock_seconds: Some(900),
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            favorites: alloc::vec![alloc::string::String::from(
                "0190a000-0000-7000-8000-000000000002",
            )],
            item_order: alloc::vec![
                alloc::string::String::from("0190a000-0000-7000-8000-000000000002"),
                alloc::string::String::from("Projects/"),
                alloc::string::String::from("0190a000-0000-7000-8000-000000000001"),
            ],
            editor_layout: None,
        };
        let blob =
            encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce())
                .unwrap();
        let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
        // Sequence fields round-trip VERBATIM; deliberate_folders is canonicalized.
        assert_eq!(original.favorites, decoded.favorites);
        assert_eq!(original.item_order, decoded.item_order);
        assert_eq!(decoded.auto_lock_seconds, Some(900));
        assert!(!decoded.screen_capture_protection);
    }

    // ---- auto_lock_seconds canonical field (MYND-121) -----------------

    #[test]
    fn encode_omits_auto_lock_seconds_when_none() {
        // None → byte-identical to a pre-MYND-121 vault.prefs (preserves
        // existing KAT vectors + existing vaults).
        let encoded = canonical_json_encode(&PrefsView::default());
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
    }

    #[test]
    fn encode_emits_auto_lock_seconds_first_in_canonical_order() {
        // Canonical key order: auto_lock_seconds (a) < screen_capture_protection (s).
        let prefs = PrefsView {
            screen_capture_protection: true,
            theme: None,
            item_order: Vec::new(),
            favorites: Vec::new(),
            deliberate_folders: Vec::new(),
            auto_lock_seconds: Some(300),
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            editor_layout: None,
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"auto_lock_seconds":300,"screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn encode_emits_all_three_fields_in_canonical_order() {
        // a < d < s: auto_lock_seconds, deliberate_folders, screen_capture_protection.
        let prefs = PrefsView {
            screen_capture_protection: false,
            theme: None,
            item_order: Vec::new(),
            favorites: Vec::new(),
            deliberate_folders: alloc::vec![alloc::string::String::from("Archive/")],
            auto_lock_seconds: Some(900),
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            editor_layout: None,
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"auto_lock_seconds":900,"deliberate_folders":["Archive/"],"screen_capture_protection":false}"#,
        );
    }

    #[test]
    fn encode_auto_lock_seconds_zero_has_no_leading_zeros() {
        // Sentinel-shaped 0 encodes as the canonical "0" (no leading zeros,
        // no trailing ".0"). The clamp/always-on policy lives in the Tauri
        // layer; the codec faithfully persists whatever integer it is given.
        let prefs = PrefsView {
            screen_capture_protection: true,
            theme: None,
            item_order: Vec::new(),
            favorites: Vec::new(),
            deliberate_folders: Vec::new(),
            auto_lock_seconds: Some(0),
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            editor_layout: None,
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"auto_lock_seconds":0,"screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn decode_round_trips_auto_lock_seconds() {
        let parsed = canonical_json_decode(
            br#"{"auto_lock_seconds":900,"screen_capture_protection":false}"#,
        )
        .unwrap();
        assert_eq!(parsed.auto_lock_seconds, Some(900));
        assert!(!parsed.screen_capture_protection);
    }

    #[test]
    fn decode_absent_auto_lock_seconds_is_none() {
        // Acceptance: absent key decodes to "no value" (not an error).
        let parsed = canonical_json_decode(br#"{"screen_capture_protection":true}"#).unwrap();
        assert_eq!(parsed.auto_lock_seconds, None);
    }

    #[test]
    fn decode_auto_lock_seconds_with_folders_and_scp() {
        let parsed = canonical_json_decode(
            br#"{"auto_lock_seconds":1800,"deliberate_folders":["Archive/"],"screen_capture_protection":true}"#,
        )
        .unwrap();
        assert_eq!(parsed.auto_lock_seconds, Some(1800));
        assert_eq!(
            parsed.deliberate_folders,
            alloc::vec![alloc::string::String::from("Archive/")]
        );
        assert!(parsed.screen_capture_protection);
    }

    #[test]
    fn decode_rejects_float_auto_lock_seconds() {
        // Spec § 9.5.2: floats FORBIDDEN. `300.5` parses `300` then hits `.`
        // instead of the required `,` → reject.
        let err = canonical_json_decode(
            br#"{"auto_lock_seconds":300.5,"screen_capture_protection":true}"#,
        )
        .unwrap_err();
        assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
    }

    #[test]
    fn decode_rejects_non_numeric_auto_lock_seconds() {
        let err =
            canonical_json_decode(br#"{"auto_lock_seconds":abc,"screen_capture_protection":true}"#)
                .unwrap_err();
        assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
    }

    #[test]
    fn decode_rejects_empty_auto_lock_seconds() {
        let err =
            canonical_json_decode(br#"{"auto_lock_seconds":,"screen_capture_protection":true}"#)
                .unwrap_err();
        assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
    }

    #[test]
    fn decode_rejects_overflow_auto_lock_seconds() {
        // 99999999999 > u32::MAX → checked_mul/add overflow → reject.
        let err = canonical_json_decode(
            br#"{"auto_lock_seconds":99999999999,"screen_capture_protection":true}"#,
        )
        .unwrap_err();
        assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
    }

    #[test]
    fn full_blob_round_trip_with_auto_lock_seconds() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let account_hash = fixed_account_number_hash();
        let original = PrefsView {
            screen_capture_protection: true,
            theme: None,
            item_order: Vec::new(),
            favorites: Vec::new(),
            deliberate_folders: alloc::vec![alloc::string::String::from("Projects/")],
            auto_lock_seconds: Some(1800),
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            editor_layout: None,
        };
        let blob =
            encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce())
                .unwrap();
        let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
        assert_eq!(decoded.auto_lock_seconds, Some(1800));
        assert!(decoded.screen_capture_protection);
        assert_eq!(
            decoded.deliberate_folders,
            alloc::vec![alloc::string::String::from("Projects/")]
        );
    }

    #[test]
    fn auto_lock_seconds_none_round_trips_through_full_blob() {
        // Default (None) survives a full encode/decode unchanged.
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let account_hash = fixed_account_number_hash();
        let original = PrefsView::default();
        let blob =
            encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce())
                .unwrap();
        let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
        assert_eq!(decoded.auto_lock_seconds, None);
        assert_eq!(original, decoded);
    }

    // ---- editor_layout nested object (MYND-137) ------------------------

    fn sample_layout() -> EditorLayout {
        EditorLayout {
            left_width: 312,
            right_width: 288,
            left_collapsed: false,
            right_collapsed: true,
        }
    }

    #[test]
    fn encode_omits_editor_layout_when_none() {
        // None → byte-identical to the pre-MYND-137 shape (preserves
        // existing vaults + KAT vectors).
        let encoded = canonical_json_encode(&PrefsView::default());
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
    }

    #[test]
    fn encode_emits_editor_layout_in_canonical_key_position() {
        // Canonical top-level key order: d < e < f < i < s. With
        // deliberate_folders, editor_layout, favorites, item_order, and
        // screen_capture_protection all present, editor_layout sits between
        // deliberate_folders and favorites. Nested keys are themselves in
        // canonical order: left_collapsed < left_width < right_collapsed <
        // right_width.
        let prefs = PrefsView {
            screen_capture_protection: true,
            theme: None,
            deliberate_folders: alloc::vec![alloc::string::String::from("Archive/")],
            auto_lock_seconds: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            favorites: alloc::vec![alloc::string::String::from("f1")],
            item_order: alloc::vec![alloc::string::String::from("n1")],
            editor_layout: Some(sample_layout()),
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"deliberate_folders":["Archive/"],"editor_layout":{"left_collapsed":false,"left_width":312,"right_collapsed":true,"right_width":288},"favorites":["f1"],"item_order":["n1"],"screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn encode_editor_layout_alone_with_scp() {
        let prefs = PrefsView {
            editor_layout: Some(EditorLayout {
                left_width: 260,
                right_width: 280,
                left_collapsed: false,
                right_collapsed: false,
            }),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"editor_layout":{"left_collapsed":false,"left_width":260,"right_collapsed":false,"right_width":280},"screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn decode_round_trips_editor_layout() {
        let parsed = canonical_json_decode(
            br#"{"editor_layout":{"left_collapsed":true,"left_width":200,"right_collapsed":false,"right_width":460},"screen_capture_protection":true}"#,
        )
        .unwrap();
        assert_eq!(
            parsed.editor_layout,
            Some(EditorLayout {
                left_width: 200,
                right_width: 460,
                left_collapsed: true,
                right_collapsed: false,
            })
        );
    }

    #[test]
    fn decode_absent_editor_layout_is_none() {
        let parsed = canonical_json_decode(br#"{"screen_capture_protection":true}"#).unwrap();
        assert_eq!(parsed.editor_layout, None);
    }

    #[test]
    fn decode_rejects_float_editor_layout_width() {
        // Spec § 9.5.2: floats FORBIDDEN. `left_width":260.5` parses 260 then
        // hits `.` instead of the required `,` → reject.
        let err = canonical_json_decode(
            br#"{"editor_layout":{"left_collapsed":false,"left_width":260.5,"right_collapsed":false,"right_width":280},"screen_capture_protection":true}"#,
        )
        .unwrap_err();
        assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
    }

    #[test]
    fn decode_rejects_editor_layout_with_wrong_key_order() {
        // Non-canonical nested key order rejects (the writer is always
        // canonical; a deviation is corruption → fall-back-to-defaults).
        let err = canonical_json_decode(
            br#"{"editor_layout":{"left_width":260,"left_collapsed":false,"right_collapsed":false,"right_width":280},"screen_capture_protection":true}"#,
        )
        .unwrap_err();
        assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
    }

    #[test]
    fn decode_rejects_editor_layout_missing_field() {
        let err = canonical_json_decode(
            br#"{"editor_layout":{"left_collapsed":false,"left_width":260,"right_collapsed":false},"screen_capture_protection":true}"#,
        )
        .unwrap_err();
        assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
    }

    #[test]
    fn full_blob_round_trip_with_editor_layout() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let account_hash = fixed_account_number_hash();
        let original = PrefsView {
            editor_layout: Some(sample_layout()),
            ..PrefsView::default()
        };
        let blob =
            encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce())
                .unwrap();
        let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
        assert_eq!(original, decoded);
        assert_eq!(decoded.editor_layout, Some(sample_layout()));
    }

    #[test]
    fn editor_layout_none_round_trips_through_full_blob() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let account_hash = fixed_account_number_hash();
        let original = PrefsView::default();
        let blob =
            encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce())
                .unwrap();
        let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
        assert_eq!(decoded.editor_layout, None);
        assert_eq!(original, decoded);
    }

    #[test]
    fn decode_editor_layout_coexists_with_all_other_fields() {
        // Full field-mix smoke: a < d < e < f < i < s all present, parsed
        // through the monotonic cursor without cross-field marker confusion.
        let parsed = canonical_json_decode(
            br#"{"auto_lock_seconds":900,"deliberate_folders":["Archive/"],"editor_layout":{"left_collapsed":false,"left_width":320,"right_collapsed":true,"right_width":300},"favorites":["f1"],"item_order":["n2","n1"],"screen_capture_protection":false}"#,
        )
        .unwrap();
        assert_eq!(parsed.auto_lock_seconds, Some(900));
        assert_eq!(
            parsed.deliberate_folders,
            alloc::vec![alloc::string::String::from("Archive/")]
        );
        assert_eq!(
            parsed.editor_layout,
            Some(EditorLayout {
                left_width: 320,
                right_width: 300,
                left_collapsed: false,
                right_collapsed: true,
            })
        );
        assert_eq!(
            parsed.favorites,
            alloc::vec![alloc::string::String::from("f1")]
        );
        assert_eq!(
            parsed.item_order,
            alloc::vec![
                alloc::string::String::from("n2"),
                alloc::string::String::from("n1"),
            ]
        );
        assert!(!parsed.screen_capture_protection);
    }

    // ---- outer envelope structural tests -------------------------------

    #[test]
    fn encode_emits_myp1_magic_at_offset_0() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let blob = encode_prefs_blob_raw(
            &prefs_key,
            &fixed_account_number_hash(),
            &PrefsView::default(),
            &fixed_prefs_nonce(),
        )
        .unwrap();
        assert_eq!(&blob[0..4], b"MYP1");
    }

    #[test]
    fn encode_emits_protocol_version_0x01_at_offset_4() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let blob = encode_prefs_blob_raw(
            &prefs_key,
            &fixed_account_number_hash(),
            &PrefsView::default(),
            &fixed_prefs_nonce(),
        )
        .unwrap();
        assert_eq!(blob[4], 0x01);
    }

    #[test]
    fn encode_emits_reserved_0x00_at_offset_5() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let blob = encode_prefs_blob_raw(
            &prefs_key,
            &fixed_account_number_hash(),
            &PrefsView::default(),
            &fixed_prefs_nonce(),
        )
        .unwrap();
        assert_eq!(blob[5], 0x00);
    }

    #[test]
    fn encode_emits_prefs_nonce_at_offset_6() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let nonce = fixed_prefs_nonce();
        let blob = encode_prefs_blob_raw(
            &prefs_key,
            &fixed_account_number_hash(),
            &PrefsView::default(),
            &nonce,
        )
        .unwrap();
        assert_eq!(&blob[6..30], &nonce[..]);
    }

    #[test]
    fn encode_emits_ciphertext_len_big_endian_at_offset_30() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let blob = encode_prefs_blob_raw(
            &prefs_key,
            &fixed_account_number_hash(),
            &PrefsView::default(),
            &fixed_prefs_nonce(),
        )
        .unwrap();
        let len_bytes = [blob[30], blob[31], blob[32], blob[33]];
        let ciphertext_len = u32::from_be_bytes(len_bytes) as usize;
        // Default plaintext: {"screen_capture_protection":true} = 34 bytes;
        // ciphertext_len = 34 + 32 (CTX tag) = 66.
        assert_eq!(ciphertext_len, 34 + CTX_COMMITMENT_TAG_LEN);
        assert_eq!(blob.len(), PREFS_BLOB_HEADER_LEN + ciphertext_len);
    }

    // ---- round-trip ----------------------------------------------------

    #[test]
    fn round_trip_default_prefs() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let account_hash = fixed_account_number_hash();
        let original = PrefsView::default();
        let blob =
            encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce())
                .unwrap();
        let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
        assert_eq!(original, decoded);
    }

    #[test]
    fn round_trip_toggled_off() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let account_hash = fixed_account_number_hash();
        let original = PrefsView {
            screen_capture_protection: false,
            theme: None,
            item_order: Vec::new(),
            favorites: Vec::new(),
            deliberate_folders: Vec::new(),
            auto_lock_seconds: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            editor_layout: None,
        };
        let blob =
            encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce())
                .unwrap();
        let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
        assert_eq!(original, decoded);
    }

    #[test]
    fn round_trip_via_getrandom_convenience() {
        // `encode_prefs_blob` pulls a random nonce; round-trip still
        // holds because the decoder reads the nonce from the header.
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let account_hash = fixed_account_number_hash();
        let original = PrefsView {
            screen_capture_protection: false,
            theme: None,
            item_order: Vec::new(),
            favorites: Vec::new(),
            deliberate_folders: Vec::new(),
            auto_lock_seconds: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            editor_layout: None,
        };
        let blob = encode_prefs_blob(&prefs_key, &account_hash, &original).unwrap();
        let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
        assert_eq!(original, decoded);
    }

    // ---- structural rejection ------------------------------------------

    #[test]
    fn decode_rejects_short_blob_with_header_too_short() {
        let prefs_key = [0u8; AEAD_KEY_LEN];
        let err =
            decode_prefs_blob(&prefs_key, &fixed_account_number_hash(), &[0u8; 33]).unwrap_err();
        assert_eq!(err, PrefsBlobError::HeaderTooShort);
    }

    #[test]
    fn decode_rejects_wrong_magic() {
        let mut blob = [0u8; PREFS_BLOB_HEADER_LEN];
        blob[..4].copy_from_slice(b"MY01"); // .myn magic, not MYP1
        blob[4] = 0x01;
        blob[5] = 0x00;
        let prefs_key = [0u8; AEAD_KEY_LEN];
        let err = decode_prefs_blob(&prefs_key, &fixed_account_number_hash(), &blob).unwrap_err();
        assert_eq!(err, PrefsBlobError::MagicMismatch);
    }

    #[test]
    fn decode_rejects_wrong_protocol_version() {
        let mut blob = [0u8; PREFS_BLOB_HEADER_LEN];
        blob[..4].copy_from_slice(&PREFS_BLOB_MAGIC);
        blob[4] = 0x02; // bogus protocol_version
        blob[5] = 0x00;
        let prefs_key = [0u8; AEAD_KEY_LEN];
        let err = decode_prefs_blob(&prefs_key, &fixed_account_number_hash(), &blob).unwrap_err();
        assert_eq!(err, PrefsBlobError::ProtocolVersionMismatch);
    }

    #[test]
    fn decode_rejects_nonzero_reserved_byte() {
        let mut blob = [0u8; PREFS_BLOB_HEADER_LEN];
        blob[..4].copy_from_slice(&PREFS_BLOB_MAGIC);
        blob[4] = 0x01;
        blob[5] = 0x01; // reserved byte non-zero
        let prefs_key = [0u8; AEAD_KEY_LEN];
        let err = decode_prefs_blob(&prefs_key, &fixed_account_number_hash(), &blob).unwrap_err();
        assert_eq!(err, PrefsBlobError::ReservedByteNonZero);
    }

    #[test]
    fn decode_rejects_oversize_ciphertext_len() {
        let mut blob = [0u8; PREFS_BLOB_HEADER_LEN];
        blob[..4].copy_from_slice(&PREFS_BLOB_MAGIC);
        blob[4] = 0x01;
        blob[5] = 0x00;
        // Set ciphertext_len to 0xFFFFFFFF (4 GiB)
        blob[30..34].copy_from_slice(&u32::MAX.to_be_bytes());
        let prefs_key = [0u8; AEAD_KEY_LEN];
        let err = decode_prefs_blob(&prefs_key, &fixed_account_number_hash(), &blob).unwrap_err();
        assert_eq!(err, PrefsBlobError::CiphertextLenOverflow);
    }

    #[test]
    fn decode_rejects_truncated_blob_with_ciphertext_len_present_but_bytes_missing() {
        let mut blob = [0u8; PREFS_BLOB_HEADER_LEN];
        blob[..4].copy_from_slice(&PREFS_BLOB_MAGIC);
        blob[4] = 0x01;
        blob[5] = 0x00;
        // Advertise 100 bytes of ciphertext but provide none
        blob[30..34].copy_from_slice(&100u32.to_be_bytes());
        let prefs_key = [0u8; AEAD_KEY_LEN];
        let err = decode_prefs_blob(&prefs_key, &fixed_account_number_hash(), &blob).unwrap_err();
        assert_eq!(err, PrefsBlobError::CiphertextTruncated);
    }

    // ---- AEAD non-distinguishing failure (spec § 6.4 + § 9.5.5) -------

    #[test]
    fn decode_rejects_with_wrong_key_as_cannot_decrypt() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let account_hash = fixed_account_number_hash();
        let blob = encode_prefs_blob_raw(
            &prefs_key,
            &account_hash,
            &PrefsView::default(),
            &fixed_prefs_nonce(),
        )
        .unwrap();

        // Wrong root_key → wrong prefs_key
        let mut wrong_root = [0u8; 32];
        wrong_root[0] = 1;
        let wrong_prefs_key = derive_subkey(&wrong_root, SubkeyRole::PrefsKey);

        let err = decode_prefs_blob(&wrong_prefs_key, &account_hash, &blob).unwrap_err();
        assert_eq!(err, PrefsBlobError::CannotDecrypt);
    }

    #[test]
    fn decode_rejects_with_wrong_account_number_hash_as_cannot_decrypt() {
        // Cross-vault scenario: vault A's blob + vault B's
        // account_number_hash → AAD mismatch → AEAD fails.
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let blob = encode_prefs_blob_raw(
            &prefs_key,
            &fixed_account_number_hash(),
            &PrefsView::default(),
            &fixed_prefs_nonce(),
        )
        .unwrap();

        let mut wrong_account_hash = fixed_account_number_hash();
        wrong_account_hash[0] = wrong_account_hash[0].wrapping_add(1);

        let err = decode_prefs_blob(&prefs_key, &wrong_account_hash, &blob).unwrap_err();
        assert_eq!(err, PrefsBlobError::CannotDecrypt);
    }

    #[test]
    fn decode_rejects_with_tampered_ciphertext_as_cannot_decrypt() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let account_hash = fixed_account_number_hash();
        let mut blob = encode_prefs_blob_raw(
            &prefs_key,
            &account_hash,
            &PrefsView::default(),
            &fixed_prefs_nonce(),
        )
        .unwrap();

        // Flip one byte in the ciphertext region (header is 34 bytes;
        // ciphertext starts at offset 34).
        blob[40] ^= 0xFF;

        let err = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap_err();
        assert_eq!(err, PrefsBlobError::CannotDecrypt);
    }

    #[test]
    fn decode_rejects_with_tampered_ctx_tag_as_cannot_decrypt() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let account_hash = fixed_account_number_hash();
        let mut blob = encode_prefs_blob_raw(
            &prefs_key,
            &account_hash,
            &PrefsView::default(),
            &fixed_prefs_nonce(),
        )
        .unwrap();

        // Flip a byte in the trailing CTX commitment tag (last 32 bytes).
        let last = blob.len() - 1;
        blob[last] ^= 0xFF;

        let err = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap_err();
        assert_eq!(err, PrefsBlobError::CannotDecrypt);
    }

    // ---- PrefsView default semantic (spec § 9.5.5) --------------------

    #[test]
    fn default_prefs_view_has_screen_capture_protection_on() {
        // Spec § 9.5.5 fall-back-to-defaults: defaults to the safer
        // state (protection on) for missing / corrupt vault.prefs.
        assert!(PrefsView::default().screen_capture_protection);
    }

    // ---- KAT vector regenerator (companion repo) ----------------------

    /// Emits hex dumps for the 5 KAT cases consumed by
    /// `myne-test-vectors/vectors/vault-prefs/v0.1/cases.json`. Output
    /// is written to `/tmp/myne_vault_prefs_vectors.txt`, ready for
    /// paste into the companion repo's JSON file.
    ///
    /// `#[ignore]` because regenerating vectors should be a deliberate
    /// act, not a side effect of `cargo test`. Run with:
    /// `cargo test -p protocol --lib emit_prefs_vectors_for_paste -- --ignored`
    ///
    /// The 6 cases pin (per MYND-160 grill Q6.2 + MYND-183):
    /// - `encrypt-default`: PrefsView { screen_capture_protection: true } → expected blob bytes
    /// - `encrypt-toggled`: PrefsView { screen_capture_protection: false } → expected blob bytes
    /// - `decrypt-default`: golden blob → expected plaintext + struct (round-trip with encrypt-default)
    /// - `decrypt-cross-vault`: vault-A blob + vault-B root_key → expected AeadFail
    /// - `decrypt-tampered`: vault-A blob with one ciphertext byte flipped → expected AeadFail
    /// - `encrypt-populated` (MYND-183): all fields incl. heterogeneous
    ///   `item_order` (note UUIDs + folder paths interleaved) + `favorites` →
    ///   expected blob bytes; canonical plaintext computed to self-validate key order
    #[test]
    #[ignore]
    fn emit_prefs_vectors_for_paste() {
        extern crate std;

        // Vault A — canonical case.
        let root_a: [u8; 32] = [0x42; 32];
        let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
        let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);
        let nonce_default: [u8; AEAD_NONCE_LEN] = [0x77; AEAD_NONCE_LEN];
        let nonce_toggled: [u8; AEAD_NONCE_LEN] = [0x88; AEAD_NONCE_LEN];

        // Vault B — used for cross-vault decrypt failure.
        let root_b: [u8; 32] = [0xAB; 32];
        let prefs_key_b = derive_subkey(&root_b, SubkeyRole::PrefsKey);
        let account_hash_b: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0xCD; PREFS_BLOB_ACCOUNT_HASH_LEN];

        let blob_default = encode_prefs_blob_raw(
            &prefs_key_a,
            &account_hash_a,
            &PrefsView {
                screen_capture_protection: true,
                theme: None,
                item_order: Vec::new(),
                favorites: Vec::new(),
                deliberate_folders: Vec::new(),
                auto_lock_seconds: None,
                daily_date_format: None,
                daily_folder: None,
                daily_template: None,
                editor_layout: None,
            },
            &nonce_default,
        )
        .expect("encode default");

        let blob_toggled = encode_prefs_blob_raw(
            &prefs_key_a,
            &account_hash_a,
            &PrefsView {
                screen_capture_protection: false,
                theme: None,
                item_order: Vec::new(),
                favorites: Vec::new(),
                deliberate_folders: Vec::new(),
                auto_lock_seconds: None,
                daily_date_format: None,
                daily_folder: None,
                daily_template: None,
                editor_layout: None,
            },
            &nonce_toggled,
        )
        .expect("encode toggled");

        // Fully-populated case (MYND-183): heterogeneous item_order (note UUIDs
        // + folder paths interleaved) + favorites + every other field, matching
        // the spec § 9.5.2 worked example. The canonical plaintext is COMPUTED
        // (not hardcoded) so the generator self-validates the canonical key
        // order + sequence discipline before emitting.
        let prefs_populated = PrefsView {
            screen_capture_protection: true,
            theme: None,
            deliberate_folders: alloc::vec![
                alloc::string::String::from("Archive/2025/"),
                alloc::string::String::from("Projects/Myne/"),
            ],
            auto_lock_seconds: Some(300),
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            favorites: alloc::vec![alloc::string::String::from(
                "0190a000-0000-7000-8000-000000000002",
            )],
            item_order: alloc::vec![
                alloc::string::String::from("0190a000-0000-7000-8000-000000000002"),
                alloc::string::String::from("Projects/Myne/"),
                alloc::string::String::from("0190a000-0000-7000-8000-000000000001"),
                alloc::string::String::from("Archive/2025/"),
            ],
            editor_layout: Some(EditorLayout {
                left_width: 312,
                right_width: 288,
                left_collapsed: false,
                right_collapsed: true,
            }),
        };
        let nonce_populated: [u8; AEAD_NONCE_LEN] = [0x99; AEAD_NONCE_LEN];
        let canonical_populated = canonical_json_encode(&prefs_populated);
        let blob_populated = encode_prefs_blob_raw(
            &prefs_key_a,
            &account_hash_a,
            &prefs_populated,
            &nonce_populated,
        )
        .expect("encode populated");

        // Themed case (MYND-110): screen_capture_protection=true + an explicit
        // theme=dark. Distinct nonce (0xAA×24). theme is canonical key LAST.
        let prefs_themed = PrefsView {
            theme: Some(ThemeChoice::Dark),
            ..PrefsView::default()
        };
        let nonce_themed: [u8; AEAD_NONCE_LEN] = [0xAA; AEAD_NONCE_LEN];
        let canonical_themed = canonical_json_encode(&prefs_themed);
        let blob_themed =
            encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs_themed, &nonce_themed)
                .expect("encode themed");

        // Tampered blob: flip one byte in the ciphertext region (header
        // is 34 bytes; ciphertext starts at offset 34).
        let mut blob_tampered = blob_default.clone();
        blob_tampered[40] ^= 0xFF;

        let canonical_default = b"{\"screen_capture_protection\":true}";
        let canonical_toggled = b"{\"screen_capture_protection\":false}";

        let mut dump = alloc::string::String::new();
        dump.push_str("---begin prefs vectors---\n\n");

        dump.push_str("# case 1/5: encrypt-default (toggle=true)\n");
        dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
        dump.push_str(&alloc::format!(
            "prefs_key_hex (informational): {}\n",
            hex_lower(&*prefs_key_a)
        ));
        dump.push_str(&alloc::format!(
            "account_number_hash_hex: {}\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str(&alloc::format!(
            "plaintext_canonical_utf8_hex: {}\n",
            hex_lower(canonical_default)
        ));
        dump.push_str(&alloc::format!(
            "prefs_nonce_hex: {}\n",
            hex_lower(&nonce_default)
        ));
        dump.push_str(&alloc::format!(
            "expected_prefs_blob_hex: {}\n\n",
            hex_lower(&blob_default)
        ));

        dump.push_str("# case 2/5: encrypt-toggled (toggle=false)\n");
        dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
        dump.push_str(&alloc::format!(
            "account_number_hash_hex: {}\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str(&alloc::format!(
            "plaintext_canonical_utf8_hex: {}\n",
            hex_lower(canonical_toggled)
        ));
        dump.push_str(&alloc::format!(
            "prefs_nonce_hex: {}\n",
            hex_lower(&nonce_toggled)
        ));
        dump.push_str(&alloc::format!(
            "expected_prefs_blob_hex: {}\n\n",
            hex_lower(&blob_toggled)
        ));

        dump.push_str("# case 3/5: decrypt-default (round-trip with case 1)\n");
        dump.push_str(&alloc::format!(
            "input_blob_hex: {}\n",
            hex_lower(&blob_default)
        ));
        dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
        dump.push_str(&alloc::format!(
            "account_number_hash_hex: {}\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str("expected_kind: ok\n");
        dump.push_str(&alloc::format!(
            "expected_plaintext_utf8_hex: {}\n",
            hex_lower(canonical_default)
        ));
        dump.push_str("expected_prefs_view: { \"screen_capture_protection\": true }\n\n");

        dump.push_str("# case 4/5: decrypt-cross-vault (vault A blob + vault B key)\n");
        dump.push_str(&alloc::format!(
            "input_blob_hex: {}\n",
            hex_lower(&blob_default)
        ));
        dump.push_str(&alloc::format!(
            "wrong_root_key_hex: {}\n",
            hex_lower(&root_b)
        ));
        dump.push_str(&alloc::format!(
            "wrong_prefs_key_hex (informational): {}\n",
            hex_lower(&*prefs_key_b)
        ));
        dump.push_str(&alloc::format!(
            "wrong_account_number_hash_hex: {}\n",
            hex_lower(&account_hash_b)
        ));
        dump.push_str("expected_kind: aead_fail\n\n");

        dump.push_str("# case 5/5: decrypt-tampered (vault A blob, ciphertext byte flipped)\n");
        dump.push_str(&alloc::format!(
            "input_blob_hex (tampered): {}\n",
            hex_lower(&blob_tampered)
        ));
        dump.push_str("tamper_offset: 40 (one byte of ciphertext flipped via XOR 0xFF)\n");
        dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
        dump.push_str(&alloc::format!(
            "account_number_hash_hex: {}\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str("expected_kind: aead_fail\n\n");

        dump.push_str(
            "# case 6/6: encrypt-populated (heterogeneous item_order + favorites + all fields)\n",
        );
        dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
        dump.push_str(&alloc::format!(
            "account_number_hash_hex: {}\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str(&alloc::format!(
            "plaintext_canonical_utf8_hex: {}\n",
            hex_lower(&canonical_populated)
        ));
        dump.push_str(&alloc::format!(
            "plaintext_canonical_utf8: {}\n",
            core::str::from_utf8(&canonical_populated).unwrap_or("<non-utf8>")
        ));
        dump.push_str(&alloc::format!(
            "prefs_nonce_hex: {}\n",
            hex_lower(&nonce_populated)
        ));
        dump.push_str(&alloc::format!(
            "expected_prefs_blob_hex: {}\n\n",
            hex_lower(&blob_populated)
        ));

        dump.push_str("# case 7/8: encrypt-themed-dark (theme=dark, MYND-110)\n");
        dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
        dump.push_str(&alloc::format!(
            "account_number_hash_hex: {}\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str(&alloc::format!(
            "plaintext_canonical_utf8_hex: {}\n",
            hex_lower(&canonical_themed)
        ));
        dump.push_str(&alloc::format!(
            "plaintext_canonical_utf8: {}\n",
            core::str::from_utf8(&canonical_themed).unwrap_or("<non-utf8>")
        ));
        dump.push_str(&alloc::format!(
            "prefs_nonce_hex: {}\n",
            hex_lower(&nonce_themed)
        ));
        dump.push_str(&alloc::format!(
            "expected_prefs_blob_hex: {}\n\n",
            hex_lower(&blob_themed)
        ));

        dump.push_str("# case 8/8: decrypt-themed-dark (round-trip with case 7)\n");
        dump.push_str(&alloc::format!(
            "input_blob_hex: {}\n",
            hex_lower(&blob_themed)
        ));
        dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
        dump.push_str(&alloc::format!(
            "account_number_hash_hex: {}\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str("expected_kind: ok\n");
        dump.push_str(
            "expected_prefs_view: { \"screen_capture_protection\": true, \"theme\": \"dark\" }\n\n",
        );

        dump.push_str("---end prefs vectors---\n");
        std::fs::write("/tmp/myne_vault_prefs_vectors.txt", dump.as_bytes())
            .expect("write prefs vectors dump");
    }

    fn hex_lower(bytes: &[u8]) -> alloc::string::String {
        let mut s = alloc::string::String::with_capacity(bytes.len() * 2);
        for b in bytes {
            s.push_str(&alloc::format!("{:02x}", b));
        }
        s
    }

    // ---- daily-notes fields (MYND-191) ---------------------------------

    #[test]
    fn daily_fields_omitted_when_default_are_byte_stable() {
        // A vault with all-default (None) daily fields encodes byte-identical to
        // one that never had them — preserving pre-MYND-191 golden vectors.
        let encoded = canonical_json_encode(&PrefsView::default());
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
    }

    #[test]
    fn daily_fields_encode_in_canonical_key_order() {
        // daily_date_format < daily_folder < daily_template < deliberate_folders
        // < screen_capture_protection.
        let prefs = PrefsView {
            daily_date_format: Some("YYYY-MM-DD".into()),
            daily_folder: Some("Journal/".into()),
            daily_template: Some("0190-aaaa".into()),
            deliberate_folders: alloc::vec!["Journal/".into()],
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"daily_date_format":"YYYY-MM-DD","daily_folder":"Journal/","daily_template":"0190-aaaa","deliberate_folders":["Journal/"],"screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn daily_fields_round_trip_through_encode_decode() {
        let prefs = PrefsView {
            daily_date_format: Some("YYYY-MM-DD".into()),
            daily_folder: Some("Daily/".into()),
            daily_template: Some("0190-tmpl-uuid".into()),
            ..PrefsView::default()
        };
        let prefs_key = derive_subkey(&fixed_root_key(), SubkeyRole::PrefsKey);
        let hash = fixed_account_number_hash();
        let blob = encode_prefs_blob_raw(&prefs_key, &hash, &prefs, &fixed_prefs_nonce()).unwrap();
        let decoded = decode_prefs_blob(&prefs_key, &hash, &blob).unwrap();
        assert_eq!(decoded, prefs);
    }

    #[test]
    fn daily_template_absent_decodes_to_none() {
        // The canonical "blank daily note" state — no daily_template key.
        let parsed =
            canonical_json_decode(br#"{"daily_folder":"Daily/","screen_capture_protection":true}"#)
                .unwrap();
        assert_eq!(parsed.daily_folder, Some("Daily/".into()));
        assert_eq!(parsed.daily_template, None);
        assert_eq!(parsed.daily_date_format, None);
    }

    #[test]
    fn daily_fields_compose_with_other_prefs() {
        // Round-trip alongside auto_lock_seconds (before) + theme (after) to pin
        // the cursor discipline across the full canonical key range.
        let prefs = PrefsView {
            auto_lock_seconds: Some(300),
            daily_folder: Some("Journal/".into()),
            theme: Some(ThemeChoice::Dark),
            ..PrefsView::default()
        };
        let prefs_key = derive_subkey(&fixed_root_key(), SubkeyRole::PrefsKey);
        let hash = fixed_account_number_hash();
        let blob = encode_prefs_blob_raw(&prefs_key, &hash, &prefs, &fixed_prefs_nonce()).unwrap();
        assert_eq!(decode_prefs_blob(&prefs_key, &hash, &blob).unwrap(), prefs);
    }
}
