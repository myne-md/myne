// SPDX-License-Identifier: AGPL-3.0

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
    aad_prefs_blob, aad_singleton_blob_v0_2, aead_open_ctx, aead_seal_ctx, AEAD_KEY_LEN,
    AEAD_NONCE_LEN, CTX_COMMITMENT_TAG_LEN,
};
use crate::canonical_json::{push_json_string, push_json_uint, push_json_uint64};
use crate::error::ProtocolError;
use crate::types::MetaVersion;
use alloc::collections::BTreeMap;
use alloc::string::String;
use alloc::vec::Vec;
use getrandom::getrandom;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use unicode_normalization::UnicodeNormalization;
use zeroize::{Zeroize, Zeroizing};

/// Magic bytes at offset 0 — ASCII `"MYP1"` (Myne Prefs v1).
pub const PREFS_BLOB_MAGIC: [u8; 4] = *b"MYP1";

/// Magic bytes for the migrated v0.2 `vault.prefs` family — ASCII `"MYP5"`
/// (§10.3 registry). Same hand-rolled framing as `MYP1`; v0.2 differs only in
/// the magic + the v0.2 AAD prefix + the `derive_subkey_v0_2` KEK.
pub const PREFS_BLOB_V0_2_MAGIC: [u8; 4] = *b"MYP5";

/// AAD role string bound into the prefs AAD (matches [`aad_prefs_blob`] under the
/// generic [`aad_singleton_blob_v0_2`]).
const PREFS_BLOB_AAD_ROLE: &[u8] = b"prefs-blob";

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
/// lowercase (`"light"` / `"dark"` / `"amoled"`) on both the canonical-JSON
/// disk path and the IPC `serde` path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeChoice {
    /// Explicit light theme — the client sets `<html data-theme="light">`,
    /// overriding the OS preference.
    Light,
    /// Explicit dark theme — the client sets `<html data-theme="dark">`,
    /// overriding the OS preference.
    Dark,
    /// Explicit AMOLED (pure-black) dark theme — the client sets
    /// `<html data-theme="amoled">`, overriding the OS preference. A
    /// pure-black variant of [`ThemeChoice::Dark`] for OLED hardware; never
    /// selected implicitly by System mode (OS-dark resolves to `Dark`).
    Amoled,
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

/// serde-derive default for a `bool` field whose logical default is `true`
/// (e.g. [`PrefsView::show_note_timestamps`]). serde's bare `#[serde(default)]`
/// uses `bool::default()` (`false`), which would diverge from the hand-rolled
/// canonical codec's omit-when-`true` discipline — this keeps the two paths
/// consistent.
fn default_true() -> bool {
    true
}

/// serde-derive bridge for [`PrefsView::ai_provider_key`]'s `Zeroizing<String>`
/// (myne-md/myne#444).
///
/// Hand-rolled rather than reached for by enabling `zeroize/serde`, which
/// `src-tauri/CLAUDE.md` rejects by name: that feature wraps the `Deserialize`
/// impl with zeroize-on-drop semantics without touching serde's own parsing
/// intermediates, so it buys dependency surface (TB9 is an audit anchor) for a
/// property it does not actually deliver. Four lines here deliver the part that
/// is real — the value this struct HOLDS wipes when it drops.
///
/// It is near-unreachable in practice: the field is `skip_serializing`, so no
/// Myne-written JSON ever carries the key and a decode lands on `default`.
/// `PrefsView`'s `Deserialize` derive still needs the field to have one.
fn deserialize_optional_zeroizing_string<'de, D>(
    deserializer: D,
) -> Result<Option<Zeroizing<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::Deserialize as _;
    Ok(Option::<String>::deserialize(deserializer)?.map(Zeroizing::new))
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

    /// Show the per-note "last edited" timestamp under each note row in the
    /// sidebar (sidebar-note-timestamps feature). Default `true` (timestamps
    /// visible — the pre-feature behaviour). **Omitted entirely from the
    /// canonical JSON when `true`** (the default), so a vault that never touched
    /// this toggle is byte-identical to a pre-feature `vault.prefs` (existing
    /// golden vectors unaffected — a migration-less additive field on `MYP1`,
    /// the `item_colors` / `spell_enabled` precedent class). Only the non-default
    /// `false` is persisted. **Non-load-bearing** (a tampered / replayed value
    /// can at worst show or hide a date) — no protective-envelope clamp. NOTE the
    /// default polarity is INVERTED vs `spell_enabled`: this is a plain `bool`
    /// defaulting `true`, so the serde-derive path needs `default = "default_true"`
    /// (a bare `#[serde(default)]` would yield `false`). Canonical key
    /// `show_note_timestamps` — sorts after `screen_capture_protection`
    /// (`scr` < `sho`), before `spell_enabled` (`sho` < `spe`).
    #[serde(default = "default_true")]
    pub show_note_timestamps: bool,

    /// Whether THIS DEVICE shows task reminders (MYND-618). Default `true`.
    ///
    /// **Device-local**, and for the real reason rather than the assumed one:
    /// the discriminator is not "is it per-device" but "must it be readable
    /// while locked, or does it name a device-specific path". Neither applies,
    /// so it lives in the encrypted preferences rather than the plaintext
    /// device-local store — but it does not SYNC, because whether a given
    /// machine should be interrupted is a property of that machine.
    /// **Non-load-bearing** (a tampered value can at worst silence or enable a
    /// notification) — no protective-envelope clamp. Inverted default polarity
    /// like `show_note_timestamps`, so the serde-derive path needs
    /// `default = "default_true"`. Canonical key `reminders_enabled` — sorts
    /// after `reminder_horizon_days` (`_` 0x5F < `s` 0x73), before
    /// `right_panel_active_tab` (`re` < `ri`).
    #[serde(default = "default_true")]
    pub reminders_enabled: bool,

    /// How many days ahead this device registers reminders with the operating
    /// system (MYND-618). `None` means the client's built-in horizon.
    ///
    /// **Device-local** for the same reason as `reminders_enabled`. The horizon
    /// is a **privacy** bound before it is a resource one: pending reminder
    /// times leave the AEAD envelope and sit in OS-owned plaintext
    /// (`threat-model.md` §7), so a shorter horizon exposes less. Optional and
    /// omitted when unset, exactly like `auto_lock_seconds`, so a vault that
    /// never touched it stays byte-identical to a pre-MYND-618 `vault.prefs`.
    /// Canonical key `reminder_horizon_days` — sorts after `paired_extensions`
    /// (`p` < `r`), before `reminders_enabled`.
    pub reminder_horizon_days: Option<u32>,

    /// Whether the note-task marker is shown in the sidebar row and the tab
    /// (MYND-613). `true` (default) shows it. **Shared, not device-local**:
    /// device-local settings exist because devices genuinely differ in
    /// capability, and a marker's visibility is taste — a device-local value
    /// would mean re-choosing it on every new device. **Non-load-bearing** (a
    /// tampered value can at worst show or hide a glyph) — no protective-envelope
    /// clamp. Same inverted default polarity as `show_note_timestamps`: a plain
    /// `bool` defaulting `true`, so the serde-derive path needs
    /// `default = "default_true"`. Canonical key `show_task_marker` — sorts after
    /// `show_note_timestamps` (`show_n` < `show_t`), before `spell_enabled`
    /// (`sho` < `spe`).
    #[serde(default = "default_true")]
    pub show_task_marker: bool,

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

    /// Developer mode master switch (developer-mode feature, MYND-593).
    /// `false` ≡ off (the default). **Omitted entirely from the canonical
    /// JSON when `false`**, so a vault that never enabled it is
    /// byte-identical to a pre-feature `vault.prefs` (existing golden
    /// vectors unaffected — migration-less additive field on `MYP1`, the
    /// same emit-only-when-true convention as [`PrefsView::ai_enabled`]).
    /// Canonical key `developer_mode` — sorts after `deliberate_folders`
    /// (`deliberate_` < `developer_`, `l`=0x6C < `v`=0x76 at the 3rd byte),
    /// before `device_names` (`develope` < `device_n`, `e`=0x65 < `i`=0x69
    /// at the 4th byte). Classified **device-local** in
    /// `sync-protocol.md` §10.2: it gates a device-local model-path
    /// override, so a synced flag would read "on" on a device with no
    /// override behind it. **Non-load-bearing** — a tampered/replayed
    /// value can at worst reveal or hide the AI/local-model developer
    /// surface; no protective-envelope clamp.
    #[serde(default)]
    pub developer_mode: bool,

    /// Friendly device names (device-management, SYNC-41) — a map of
    /// `device_id` (hex) → user-chosen display name. **The single home** for
    /// device names so no client ships a second default-name heuristic; both
    /// clients read/write it and it rides the already-synced, AEAD'd `MYP1`
    /// prefs. A `BTreeMap` so the canonical encoder emits keys in lexicographic
    /// order (the `folder_icons` / `item_colors` precedent class). **Same
    /// canonical string→string map encoding as `folder_icons`** (NFC-normalized
    /// keys + values, lexicographic key order) and **omitted entirely from the
    /// canonical JSON when empty**, so a vault that never named a device is
    /// byte-identical to a pre-feature `vault.prefs` (existing golden vectors
    /// unaffected — a migration-less additive field on `MYP1`). Default empty.
    /// Canonical key `device_names` — sorts after `deliberate_folders`
    /// (`del` < `dev`), before the `editor_*` block (`d` < `e`).
    /// **Non-load-bearing** (a tampered/replayed value can at worst mislabel a
    /// device in the device list) — no protective-envelope clamp.
    #[serde(default)]
    pub device_names: BTreeMap<String, String>,

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

    /// The **remote AI provider** the user named, or `None` for the default —
    /// which is not "off" but **unreachable**: with no provider selected there
    /// is no remote code path to reach (`decisions.md` 2026-08-09). A closed
    /// value, stored as its wire string: `"ollama-cloud"` or `"openrouter"`.
    /// Kept as a `String` rather than an enum because this codec is `no_std`
    /// canonical JSON and an unknown value must decode to *something* a newer
    /// client wrote; the host validates it against its own registry and treats
    /// an unrecognized name as no provider.
    ///
    /// **The destination is NOT stored here.** Each provider's base URL is a
    /// compiled-in constant, so a tampered `vault.prefs` cannot redirect
    /// traffic to a host of the attacker's choosing.
    ///
    /// Canonical key `ai_provider` — sorts after `ai_excluded_folders`
    /// (`ai_e` < `ai_p`), before `ai_provider_consent` (a shorter string sorts
    /// before its own extension) and `archive_disabled` (`ai` < `ar`). Omitted
    /// entirely when `None`, so a vault that never named a provider is
    /// byte-identical to a pre-feature `vault.prefs`.
    #[serde(default)]
    pub ai_provider: Option<String>,

    /// **Which provider** the one-time consent was given for — the screen that
    /// states plainly that note text leaves the device, and names who receives
    /// it. `None` ≡ not given (the default).
    ///
    /// It records the provider rather than a bare `true` **because consent is
    /// per provider**: the screen names the recipient, so an approval for one
    /// cannot stand in for another. As a boolean, that invariant would depend
    /// on every future setter remembering to clear the flag when the selection
    /// changes — a rule maintained by memory. As a name, the request path
    /// simply compares it to the active selection, and a stale approval is
    /// unusable rather than merely discouraged.
    ///
    /// **Account-scoped, not device-scoped, and that is a known cost** (ledger
    /// SYNC-22): this field syncs, so a newly enrolled device inherits the
    /// approval and begins sending without anyone at *that* device seeing the
    /// screen. `threat-model.md` §5 and `glossary.md` say so in the same words;
    /// if you are reading this while adding a second provider, the residual is
    /// theirs to restate, not to rediscover.
    ///
    /// It is a **gate, not a display flag**: the request path checks it, so a
    /// UI that forgot to show the screen still cannot send. Canonical key
    /// `ai_provider_consent` — after `ai_provider`, before `ai_provider_key`
    /// (`c` < `k`). Omitted when `None`.
    #[serde(default)]
    pub ai_provider_consent: Option<String>,

    /// The API key for [`PrefsView::ai_provider`], or `None`.
    ///
    /// **`#[serde(skip_serializing)]` is load-bearing.** `prefs_read`
    /// serializes the *whole* `PrefsView` to the WebView, so without this the
    /// key would reach page context on every read — and from there a DOM
    /// snapshot, a devtools session, or any script running in the page. The
    /// exact in-tree precedent is `PairedExtension::token_value`, and it works
    /// for the same reason: on-disk persistence here is **hand-rolled byte
    /// emission**, not serde, so skipping the serde field does not touch the
    /// blob. The UI is given a `has_key` boolean instead.
    ///
    /// It is also DENY-listed for logging (`src-tauri/CLAUDE.md`).
    ///
    /// Canonical key `ai_provider_key` — after `ai_provider_consent`
    /// (`c` < `k`), before `ai_provider_model` (`k` < `m`). Omitted when
    /// `None`.
    #[serde(
        default,
        skip_serializing,
        deserialize_with = "deserialize_optional_zeroizing_string"
    )]
    pub ai_provider_key: Option<Zeroizing<String>>,

    /// **Which model** at [`PrefsView::ai_provider`] answers, or `None`.
    ///
    /// There is no default and Myne ships no per-provider fallback (SYNC-24):
    /// the user picks from the list the provider itself reports. A pinned
    /// model tag rots faster than the release that pinned it, and on a metered
    /// API a default nobody chose is a bill nobody chose. `None` therefore
    /// means *not yet chosen*, and the remote arm has nothing to ask with —
    /// which is a refusal, not a silent substitution.
    ///
    /// **Not `skip_serializing`, unlike the key.** The panel renders the
    /// current selection back to the user, so this value has to cross IPC; it
    /// is a model name the provider published, not a credential.
    ///
    /// Canonical key `ai_provider_model` — after `ai_provider_key`
    /// (`k` < `m`), before `archive_disabled` (`ai` < `ar`). Omitted when
    /// `None`, so a vault that never named a provider stays byte-identical to
    /// a pre-feature `vault.prefs`.
    #[serde(default)]
    pub ai_provider_model: Option<String>,

    /// Automatic on-device tag suggestion toggle (on-device-tag-suggestion,
    /// MYND-651). `false` ≡ off (the default). **Omitted entirely from the
    /// canonical JSON when `false`**, so a vault that never enabled it is
    /// byte-identical to a pre-feature `vault.prefs` (existing golden vectors
    /// unaffected — a migration-less additive field on `MYP1`, the same
    /// emit-only-when-`true` positive-opt-in convention as
    /// [`PrefsView::ai_enabled`] and `cli_enabled`). Canonical key
    /// `auto_tag_enabled` — sorts after `auto_lock_seconds` (`auto_l` <
    /// `auto_t`), before `bar_items_order` (`a` < `b`).
    ///
    /// It is the SECOND half of a two-key gate: the tag pass runs only when
    /// this AND `ai_enabled` are both on, and the host re-reads both before it
    /// touches the model, so a tampered or replayed value cannot start
    /// inference on a vault whose AI opt-in is off. **Non-load-bearing /
    /// AS-low** — no protective-envelope clamp.
    #[serde(default)]
    pub auto_tag_enabled: bool,

    /// Active **custom theme** selection (custom-themes epic, MYND-297) — the
    /// name of a user-authored palette, i.e. a key of the encrypted `vault.themes`
    /// store (`MYT1`, `protocol.md` §9.21). It named a plaintext file stem under
    /// `app_config_dir/themes/` until `decisions.md` 2026-07-16 promoted palettes
    /// to vault content; the blob holds the palettes, this field holds the pointer.
    /// `Some(name)` takes **precedence** over [`PrefsView::theme`] (the built-in
    /// Light/Dark/System choice): when set, the host applies the custom palette
    /// and ignores `theme`. Omitted entirely from the canonical JSON when `None`,
    /// so a vault with no custom theme is byte-identical to a pre-MYND-297
    /// `vault.prefs`. Canonical key `custom_theme` — sorts after `color_groups`
    /// (`col` < `cus`) and before the `daily_*` block (d). A
    /// **non-load-bearing** cosmetic preference (AS-low): a tampered/replayed
    /// value can at worst select a different or absent palette (a name with no
    /// live entry in the store falls back to the built-in `theme`, and an
    /// unreadable store reads as empty per §9.21.4), so no protective-envelope
    /// clamp. The name is `is_valid_theme_name`-constrained host-side; this codec
    /// stores it as a free NFC string.
    #[serde(default)]
    pub custom_theme: Option<alloc::string::String>,

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

    /// Display date format (myne#279) — a closed enum string chosen from
    /// `system` / `iso` / `dmy` / `mdy` / `dmmmy`. `None` ≡ `system` (follow the
    /// OS locale), applied host-side. Stored as a free `Option<String>` here:
    /// the enum interpretation + unknown→default fallback live on the client, no
    /// codec-level validation (the `editor_content_width` precedent class).
    ///
    /// **Display only.** It never enters a `.myn` file, a blob or the sync wire
    /// as a formatting instruction — `dialect/src/taskFields.ts` keeps the
    /// on-disk bytes zone-free and format-free, and this decides how they are
    /// printed, nothing else. Canonical key `date_format` — sorts after
    /// `daily_template` (`dai` < `dat`), before `deliberate_folders`
    /// (`da` < `de`). Omitted when `None`, so a vault that never chose a format
    /// is byte-identical to a pre-feature `vault.prefs`. **Non-load-bearing**
    /// cosmetic (AS-low) — no protective-envelope clamp.
    #[serde(default)]
    pub date_format: Option<alloc::string::String>,

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

    /// Per-field LWW clocks for the Phase 2 prefs sync (MYND-478;
    /// `sync-protocol.md` §10.2, spec §9.5.2). Maps a **shared** preference's
    /// field name — or a `device_names/<key>` per-entry name — to the
    /// epoch-**milliseconds** at which a setter last changed that field. The
    /// merge takes the newer clock per field; an ABSENT clock counts as 0 (so
    /// every pre-MYND-478 blob is "all clocks 0"); equal clocks tie-break
    /// byte-lexicographically toward the greater value (the §11.4 catalog
    /// `filename` precedent). Device-local fields (per the §10.2
    /// classification) are never stamped. A `BTreeMap` so the canonical
    /// encoder emits keys in lexicographic order (the `folder_icons`
    /// precedent class); values are bare non-negative integers (floats
    /// FORBIDDEN, §9.5.2). Default empty; **omitted entirely from the
    /// canonical JSON when empty**, so a vault whose shared fields were never
    /// clock-stamped is byte-identical to a pre-MYND-478 `vault.prefs`
    /// (existing golden vectors unaffected — a migration-less additive field
    /// on `MYP1`, the `label` precedent class). Canonical key `field_clocks`
    /// — sorts after `favorites` (`fa` < `fi`), before `folder_icons`
    /// (`fi` < `fo`). **Non-load-bearing** (a tampered/replayed clock can at
    /// worst make the other replica win a preference merge — the accepted
    /// singleton-rollback bound) — no protective-envelope clamp.
    #[serde(default)]
    pub field_clocks: BTreeMap<String, u64>,

    /// Unified manual sidebar order across the single interleaved file-tree
    /// (MYND-183; MYND-596 promoted the flat sequence to a **container-keyed
    /// map** so each sibling group merges independently — see
    /// `sync-protocol.md` §10.2). Each key is a container path (`""` ≡ the tree
    /// root, or a canonical trailing-slash folder display path like
    /// `"Projects/"`); each value is that container's children in manual order —
    /// an order-preserving **sequence** of note UUIDs and full-path child folder
    /// display paths, freely interleaved, discriminated by the trailing `/`.
    /// Container membership stays *structural* (a note's container is its
    /// `folder:`; a folder's is its parent path); this map supplies only the
    /// per-container rank, with unlisted children falling back to recency
    /// (notes) / folded name (folders). Keys are emitted in lexicographic order
    /// (`BTreeMap`) and NFC-normalized; each value sequence is MEANINGFUL, so the
    /// canonical encoder preserves element order verbatim (NFC-normalized, but
    /// NOT sorted and NOT deduped). Default empty; omitted entirely from the
    /// canonical JSON when empty, so a vault that never reordered is
    /// byte-identical to one without the key. Each container races on its own
    /// `item_order/<container>` field-clock (MYND-596), so a reorder in one
    /// folder never clobbers another's order.
    #[serde(default)]
    pub item_order: BTreeMap<alloc::string::String, Vec<alloc::string::String>>,

    /// Active workspace slot id (MYND-308) — the id of the workspace slot the
    /// editor should restore on unlock. `None` ≡ unset → the host applies its
    /// default (first / last-used) workspace policy. A free `Option<String>`
    /// stored verbatim (NFC-normalized at encode time); no codec-level value
    /// validation (the `daily_folder` precedent class — the client owns the
    /// slot-id interpretation + unknown→default fallback). Omitted entirely from
    /// the canonical JSON when `None`, so a vault that never set an active
    /// workspace is byte-identical to a pre-feature `vault.prefs` (existing
    /// golden vectors unaffected — migration-less additive field on `MYP1`).
    /// **Non-load-bearing** (a tampered / replayed value can at worst restore
    /// the wrong workspace) — no protective-envelope clamp. Canonical key
    /// `active_workspace` — sorts FIRST, before `auto_lock_seconds`
    /// (`ac` < `au`).
    #[serde(default)]
    pub active_workspace: Option<alloc::string::String>,

    /// AI opt-in toggle (local-ai epic, ai-ux-surface MYND-408, SYNC-12).
    /// `false` ≡ AI off (the default). **Omitted entirely from the canonical
    /// JSON when `false`**, so a vault that never enabled AI is byte-identical
    /// to a pre-feature `vault.prefs` (existing golden vectors unaffected —
    /// migration-less additive field on `MYP1`, the `archive_disabled`
    /// precedent class; per-vault + encrypted so the at-rest "uses AI"
    /// fingerprint never leaks). Canonical key `ai_enabled` — sorts after
    /// `active_workspace` (`ac` < `ai`), before `archive_disabled`
    /// (`ai` < `ar`). **Non-load-bearing / AS-low** — no protective-envelope
    /// clamp; the host treats a tampered/replayed value as a cosmetic toggle.
    #[serde(default)]
    pub ai_enabled: bool,

    /// Folders excluded from every AI read/index (local-ai epic, ai-ux-surface
    /// MYND-408, SYNC-14) — canonical trailing-slash display form. **Same
    /// canonical encoding as `deliberate_folders`** (NFC-normalized,
    /// lexicographically sorted, exact-deduped set) and **omitted entirely when
    /// empty**, so a vault with no exclusions is byte-identical to a pre-feature
    /// `vault.prefs`. Default empty (whole vault in scope; AI is already
    /// opt-in). Canonical key `ai_excluded_folders` — sorts after `ai_enabled`
    /// (`ai_en` < `ai_ex`), before `archive_disabled` (`ai` < `ar`).
    /// **Non-load-bearing** — a tampered value can at worst widen/narrow this
    /// device's AI read scope; no protective-envelope clamp.
    #[serde(default)]
    pub ai_excluded_folders: Vec<alloc::string::String>,

    /// User toggle that disables the note-archive feature (archive-disable,
    /// MYND-…). `None` ≡ unset → the host applies the default-OFF policy
    /// (archiving enabled — the pre-feature behaviour). Omitted entirely from
    /// the canonical JSON when `None`, so a vault that never touched the toggle
    /// is byte-identical to a pre-feature `vault.prefs` (existing golden vectors
    /// unaffected — migration-less additive field on `MYP1`, the
    /// `editor_line_numbers` precedent class). **Non-load-bearing** (a tampered /
    /// replayed value can at worst show or hide the archive entry points; the
    /// underlying `archived:` frontmatter surgery is untouched) — no
    /// protective-envelope clamp. Canonical key `archive_disabled` — sorts after
    /// `active_workspace` (`ac` < `ar`), before `auto_lock_seconds`
    /// (`ar` < `au`).
    #[serde(default)]
    pub archive_disabled: Option<bool>,

    /// Folders archived as a unit (folder-archive) — canonical trailing-slash
    /// display form. **Same canonical encoding as `deliberate_folders` /
    /// `ai_excluded_folders`** (NFC-normalized, lexicographically sorted,
    /// exact-deduped set) and **omitted entirely when empty**, so a vault with no
    /// archived folders is byte-identical to a pre-feature `vault.prefs` (existing
    /// golden vectors unaffected — migration-less additive field on `MYP1`, the
    /// `ai_excluded_folders` precedent class). Default empty. A folder in this set
    /// (and its subtree) drops out of the working-set sidebar/tree while its notes
    /// stay resolvable (backlink / graph / search) — the folder-level twin of the
    /// per-note `archived:` marker. Canonical key `archived_folders` — sorts after
    /// `archive_disabled` (`archive_` `_`=0x5F < `archived` `d`=0x64), before
    /// `auto_lock_seconds` (`ar` < `au`). **Non-load-bearing** — a tampered value
    /// can at worst show/hide a folder subtree; no protective-envelope clamp.
    #[serde(default)]
    pub archived_folders: Vec<alloc::string::String>,

    /// Whether an imported image attachment is downscaled + re-encoded at
    /// ingest time (ingest-image-compression). Canonical key
    /// `attachment_compression_enabled` — sorts after `archived_folders`
    /// (`archived_` < `attachment_c`), before `attachment_ocr_enabled`
    /// (`attachment_c` < `attachment_o`).
    ///
    /// **Default ON**, hence the explicit default function: a bare
    /// `#[serde(default)]` would yield `false` and silently disable the
    /// feature for every vault whose prefs blob predates this field — i.e.
    /// all of them.
    ///
    /// Unlike `attachment_ocr_enabled`, this switch's effect is **content-fidelity**,
    /// not compute-budget, and is classified **shared** rather than
    /// device-local in the sync merge (`docs/spec/sync-protocol.md` §10.2) —
    /// see that classification for the rationale. The codec here is
    /// classification-agnostic; it only carries the bit.
    #[serde(default = "default_true")]
    pub attachment_compression_enabled: bool,

    /// Whether attachment text extraction may read images and scanned PDFs
    /// (image OCR, MYND-441). Canonical key `attachment_ocr_enabled` — sorts
    /// after `attachment_compression_enabled` (`attachment_c` < `attachment_o`),
    /// before `auto_lock_seconds` (`att` < `aut`).
    ///
    /// **Default ON**, hence the explicit default function: a bare
    /// `#[serde(default)]` would yield `false` and silently disable the feature
    /// for every vault whose prefs blob predates this field — i.e. all of them.
    ///
    /// Turning it off stops the background extraction worker but never deletes
    /// cached results, so toggling costs the user nothing. **Non-load-bearing /
    /// AS-low** — no protective-envelope clamp; a tampered value can at worst
    /// pause or resume a background indexer.
    #[serde(default = "default_true")]
    pub attachment_ocr_enabled: bool,

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

    /// Editor line-number gutter toggle (editor-line-numbers, MYND-314). `None` ≡
    /// unset → the host applies the default-OFF policy (prose-first; the gutter is
    /// opt-in). Omitted entirely from the canonical JSON when `None`, so a vault
    /// that never touched the toggle is byte-identical to a pre-feature
    /// `vault.prefs` (existing golden vectors unaffected — migration-less additive
    /// field on `MYP1`, the `spell_enabled` precedent class). **Non-load-bearing**
    /// (a tampered / replayed value can at worst show or hide the line-number
    /// gutter) — no protective-envelope clamp. Canonical key `editor_line_numbers`
    /// — sorts after `editor_layout` (`editor_la` < `editor_li`), before
    /// `editor_line_spacing` (`editor_line_n` < `editor_line_s`).
    #[serde(default)]
    pub editor_line_numbers: Option<bool>,

    /// Slash-menu HIDDEN item set (MYND-336 editor-command customization).
    /// `sequence`-adjacent to `editor_slash_order`; a set field (sorted+deduped
    /// on encode, `canonical_folder_list`). Default empty (nothing hidden).
    /// Canonical key `editor_slash_hidden` — sorts after `editor_line_spacing`
    /// (`editor_li` < `editor_s`), before `editor_slash_order`
    /// (`editor_slash_h` < `editor_slash_o`). Existing golden vectors unaffected
    /// — a migration-less additive field on `MYP1`, the `hidden_bar_items`
    /// precedent class. Non-load-bearing (a tampered/absent value degrades to the
    /// default toolbar/slash layout, never a crypto or safety property).
    #[serde(default)]
    pub editor_slash_hidden: Vec<alloc::string::String>,

    /// Slash-menu ORDER (MYND-336). Reorder twin of `editor_slash_hidden`; a
    /// `sequence` field preserved VERBATIM (not sorted/deduped, like
    /// `bar_items_order`). Default empty (canonical order). Canonical key
    /// `editor_slash_order` — after `editor_slash_hidden`, before
    /// `editor_text_size` (`editor_s` < `editor_te`). Migration-less additive.
    #[serde(default)]
    pub editor_slash_order: Vec<alloc::string::String>,

    /// Toolbar HIDDEN item set (MYND-336). Set field (sorted+deduped). Default
    /// empty. Canonical key `editor_toolbar_hidden` — after `editor_text_size`
    /// (`editor_te` < `editor_to`), before `editor_toolbar_order`. Migration-less
    /// additive; non-load-bearing.
    #[serde(default)]
    pub editor_toolbar_hidden: Vec<alloc::string::String>,

    /// Toolbar ORDER (MYND-336). Reorder twin of `editor_toolbar_hidden`; a
    /// `sequence` field preserved VERBATIM. Default empty. Canonical key
    /// `editor_toolbar_order` — after `editor_toolbar_hidden`, before `favorites`
    /// (`editor_t` < `f`). Migration-less additive.
    #[serde(default)]
    pub editor_toolbar_order: Vec<alloc::string::String>,

    /// Editor content max-width preset (editor-typography). `None` ≡ the
    /// canonical default `normal`, applied host-side. A closed enum string
    /// (`narrow`/`normal`/`wide`/`full`); stored as a free `Option<String>`
    /// here — the enum interpretation + unknown→default fallback live on the
    /// client (no codec-level validation, the `daily_date_format` precedent
    /// class). Omitted entirely when `None`, so a vault that never customized
    /// the measure is byte-identical to a pre-feature `vault.prefs`.
    /// **Non-load-bearing** cosmetic (AS-low) — no protective-envelope clamp.
    /// Canonical key `editor_content_width` — sorts after `deliberate_folders`
    /// (`d` < `e`), before `editor_default_view_mode`
    /// (`editor_c` < `editor_d`).
    #[serde(default)]
    pub editor_content_width: Option<alloc::string::String>,

    /// Editor default view-mode preset (MYND-299) — the mode a note opens in:
    /// `live` / `reading` / `source`. `None` ≡ the canonical default applied
    /// host-side. A closed enum string stored as a free `Option<String>` — the
    /// enum interpretation + unknown→default fallback live on the client (no
    /// codec-level validation, the `editor_content_width` precedent class).
    /// Omitted entirely from the canonical JSON when `None`, so a vault that
    /// never customized the default view is byte-identical to a pre-feature
    /// `vault.prefs`. **Non-load-bearing** cosmetic — no protective-envelope
    /// clamp. Canonical key `editor_default_view_mode` — sorts after
    /// `editor_content_width` (`editor_c` < `editor_d`), before
    /// `editor_focus_dim_inactive` (`editor_d` < `editor_f`).
    #[serde(default)]
    pub editor_default_view_mode: Option<alloc::string::String>,

    /// Editor focus-mode dim-inactive toggle (MYND-348). `None` ≡ unset → the
    /// host applies its default focus-mode policy at read time. Omitted entirely
    /// from the canonical JSON when `None`, so a vault that never touched the
    /// toggle is byte-identical to a pre-feature `vault.prefs` (existing golden
    /// vectors unaffected — migration-less additive field on `MYP1`, the
    /// `editor_line_numbers` precedent class). **Non-load-bearing** (a tampered /
    /// replayed value can at worst dim or undim the inactive paragraphs) — no
    /// protective-envelope clamp. Canonical key `editor_focus_dim_inactive` —
    /// sorts after `editor_default_view_mode` (`editor_d` < `editor_f`), before
    /// `editor_focus_typewriter` (`editor_focus_d` < `editor_focus_t`).
    #[serde(default)]
    pub editor_focus_dim_inactive: Option<bool>,

    /// Editor focus-mode typewriter-scrolling toggle (MYND-348). `None` ≡ unset →
    /// the host applies its default focus-mode policy at read time. Omitted
    /// entirely from the canonical JSON when `None`, so a vault that never touched
    /// the toggle is byte-identical to a pre-feature `vault.prefs` (existing
    /// golden vectors unaffected — the `editor_line_numbers` precedent class).
    /// **Non-load-bearing** (a tampered / replayed value can at worst enable or
    /// disable typewriter scrolling) — no protective-envelope clamp. Canonical
    /// key `editor_focus_typewriter` — sorts after `editor_focus_dim_inactive`
    /// (`editor_focus_d` < `editor_focus_t`), before `editor_font_family`
    /// (`editor_focus` < `editor_font`: `c` < `n`).
    #[serde(default)]
    pub editor_focus_typewriter: Option<bool>,

    /// Editor font-family preset (editor-typography). `None` ≡ the canonical
    /// default `mono`. A closed enum string (`mono`/`sans`); same free-string
    /// storage + client-side validation discipline as
    /// [`PrefsView::editor_content_width`]. Omitted when `None`.
    /// Non-load-bearing. Canonical key `editor_font_family` — sorts after
    /// `editor_focus_typewriter` (`editor_focus` < `editor_font`), before
    /// `editor_layout` (`editor_f` < `editor_l`).
    #[serde(default)]
    pub editor_font_family: Option<alloc::string::String>,

    /// Editor line-spacing preset (editor-typography). `None` ≡ the canonical
    /// default `normal`. A closed enum string (`tight`/`normal`/`relaxed`) —
    /// stored as a free `Option<String>` to keep the codec float-free (spec
    /// § 9.5.2); the client maps the preset to a concrete line-height. Same
    /// validation discipline as [`PrefsView::editor_content_width`]. Omitted
    /// when `None`. Non-load-bearing. Canonical key `editor_line_spacing` —
    /// sorts after `editor_layout` (`editor_la` < `editor_li`), before
    /// `editor_text_size` (`editor_l` < `editor_t`).
    #[serde(default)]
    pub editor_line_spacing: Option<alloc::string::String>,

    /// Editor base text-size preset (editor-typography). `None` ≡ the canonical
    /// default `md`. A closed enum string (`sm`/`md`/`lg`/`xl`); the client maps
    /// it to a base font-size and the headings scale relative to it. Same
    /// free-string storage + client-side validation discipline as
    /// [`PrefsView::editor_content_width`]. Omitted when `None`.
    /// Non-load-bearing. Canonical key `editor_text_size` — sorts after
    /// `editor_line_spacing`, before `favorites` (`e` < `f`).
    #[serde(default)]
    pub editor_text_size: Option<alloc::string::String>,

    /// Vim keyboard-mode toggle (vim-keyboard-mode, MYND-313). `None` ≡ unset →
    /// the host applies the default-OFF policy (modal editing is opt-in). Omitted
    /// entirely from the canonical JSON when `None`, so a vault that never touched
    /// the toggle is byte-identical to a pre-feature `vault.prefs` (existing golden
    /// vectors unaffected — migration-less additive field on `MYP1`, the
    /// `editor_line_numbers` precedent class). **Non-load-bearing** (a tampered /
    /// replayed value can at worst turn modal editing on or off; it grants no
    /// capability and reaches no key material) — no protective-envelope clamp.
    /// Canonical key `editor_vim_mode` — sorts after `editor_toolbar_order`
    /// (`editor_to` < `editor_v`), before `favorites` (`e` < `f`).
    #[serde(default)]
    pub editor_vim_mode: Option<bool>,

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

    /// Whether speech-to-text may run on this vault's audio attachments
    /// (MYND-592). Canonical key `transcription_enabled` — sorts after `theme`
    /// (`the` < `tra`), before `view_order` (`t` < `v`).
    ///
    /// **Default ON**, hence the explicit default function — the same polarity
    /// as `attachment_ocr_enabled` and for the same two reasons: a bare
    /// `#[serde(default)]` would yield `false` and silently disable the feature
    /// for every vault whose blob predates the field, and emitting only the
    /// non-default `false` keeps such a vault byte-identical to a pre-feature
    /// `vault.prefs` (existing golden vectors unaffected).
    ///
    /// This field exists because transcription was previously gated on
    /// `ai_enabled` — the *embedding store's* opt-in, which it has nothing to
    /// do with. Speech-to-text ships a bundled model, runs entirely on-device
    /// and does one bounded, user-initiated thing, so it is a product feature
    /// rather than a lab experiment and carries its own switch.
    ///
    /// **Non-load-bearing / AS-low** — no protective-envelope clamp. A tampered
    /// value can at worst enable or disable a user-initiated local computation;
    /// it grants no read access the vault did not already have, and the host
    /// re-reads it rather than trusting the WebView.
    /// Display time format (myne#279) — a closed enum string chosen from
    /// `system` / `24h` / `12h`. `None` ≡ `system` (follow the OS locale),
    /// applied host-side. Same free-`Option<String>` + client-side validation
    /// discipline as [`PrefsView::date_format`]. Canonical key `time_format` —
    /// sorts after `theme` (`th` < `ti`), before `timezone` (`_` < `z`).
    /// Omitted when `None`. **Non-load-bearing** cosmetic — no clamp.
    #[serde(default)]
    pub time_format: Option<alloc::string::String>,

    /// Display timezone override (myne#279) — an IANA zone identifier, or `None`
    /// ≡ `system` (the host's own zone).
    ///
    /// **Display only, and that is load-bearing for a different reason than the
    /// two fields above.** It decides what the app considers "today" and how a
    /// stored wall-clock value is printed — it NEVER enters a `.myn` file, a
    /// blob or the sync wire. `dialect/src/taskFields.ts` states the rule this
    /// preserves: no timezone offset and no zone identifier is ever produced,
    /// times are local wall-clock, which is what a personal reminder means and
    /// which keeps a coarse geolocation datum out of a file that gets exported
    /// as plaintext. Storing the *display* choice in `vault.prefs` — encrypted
    /// at rest, never in note bytes — does not walk that back.
    ///
    /// Canonical key `timezone` — sorts after `time_format` (`_` < `z`), before
    /// `transcription_enabled` (`ti` < `tr`). Omitted when `None`.
    /// **Non-load-bearing** cosmetic — no clamp.
    #[serde(default)]
    pub timezone: Option<alloc::string::String>,

    #[serde(default = "default_true")]
    pub transcription_enabled: bool,

    /// Per-folder custom sidebar icon (MYND-185) — a map from a canonical
    /// trailing-slash folder path to an icon name drawn from the client's
    /// curated stroke-glyph set, replacing that folder's default glyph. A
    /// `BTreeMap` so the canonical encoder emits keys in lexicographic order
    /// for free; keys + values are NFC-normalized at encode time. Default
    /// empty; **omitted entirely from the canonical JSON when empty**, so a
    /// vault that assigned no folder icon is byte-identical to a pre-MYND-185
    /// `vault.prefs` (existing golden vectors unaffected). Folder-keyed, so a
    /// rename/move prefix-rewrite + a delete prune are the client's job (the
    /// `deliberate_folders` discipline); a stale/unknown-icon entry is ignored
    /// at render and pruned on the next write (no codec-level GC).
    /// **Non-load-bearing** (cosmetic, AS-low) — no protective-envelope clamp.
    /// Canonical key 'f' — sorts after `favorites`, before `hidden_bar_items`.
    #[serde(default)]
    pub folder_icons: BTreeMap<String, String>,

    /// Hidden bottom-bar item ids (MYND bottom-bar customization) — the
    /// **set** of `BottomBar` element ids the user chose to hide via the
    /// bar's right-click menu (e.g. `graph`, `tags`, `word-count`). A
    /// `set`-semantics array: NFC-normalized, lexicographically sorted,
    /// exact-deduped, and **omitted entirely when empty** so a vault whose
    /// bar is fully visible (the default) is byte-identical to a pre-feature
    /// `vault.prefs` (existing golden vectors unaffected — migration-less
    /// additive field on `MYP1`, the `spell_languages` precedent class). An
    /// unknown id is ignored at render and pruned on the next write (no
    /// codec-level GC). **Non-load-bearing** (a tampered / replayed value can
    /// at worst hide or reveal a bar affordance) — no protective-envelope
    /// clamp. Canonical key 'h' — sorts after `folder_icons` (`f` < `h`),
    /// before `item_colors` (`h` < `i`).
    #[serde(default)]
    pub hidden_bar_items: Vec<String>,

    /// User-chosen bottom-bar item display order (MYND bottom-bar
    /// customization, drag-to-reorder twin of [`PrefsView::hidden_bar_items`]).
    /// A `sequence`-semantics array of right-cluster `BottomBar` element ids
    /// (e.g. `view-mode`, `tags`, `graph`) in the order the user arranged them
    /// by dragging or via the bar's right-click "move left / move right"
    /// actions. Order is MEANINGFUL, so the array is preserved **verbatim** —
    /// NOT sorted, NOT deduped — exactly like [`PrefsView::favorites`] /
    /// [`PrefsView::item_order`] / [`PrefsView::view_order`]. NFC-normalized per
    /// element and **omitted entirely when empty** so a vault that never
    /// reordered its bar (the default) is byte-identical to a pre-feature
    /// `vault.prefs` (existing golden vectors unaffected — migration-less
    /// additive field on `MYP1`, the `view_order` precedent class). An id not in
    /// the host's known set is ignored at render and pruned on the next write
    /// (no codec-level GC); a known id absent from the array falls back to its
    /// canonical default position. **Non-load-bearing** (a tampered / replayed
    /// value can at worst reorder a bar affordance) — no protective-envelope
    /// clamp. Canonical key 'b' — sorts after `auto_lock_seconds` (`au` < `b`),
    /// before `custom_theme` (`b` < `c`).
    #[serde(default)]
    pub bar_items_order: Vec<String>,

    /// CLI terminal-access door toggle (myne-cli epic, MYND-490; `cli-thin-client`
    /// task 2). `false` ≡ the door is closed (the default) — the local socket the
    /// `myne` CLI dials is never created regardless of unlock state. **Omitted
    /// entirely from the canonical JSON when `false`**, so a vault that never
    /// enabled the CLI is byte-identical to a pre-feature `vault.prefs` (existing
    /// golden vectors unaffected — migration-less additive field on `MYP1`, the
    /// `ai_enabled` precedent class exactly). Class `DeviceLocal` (see
    /// `core/src/plugins/sync/prefs_classification.rs`): the CLI door is a
    /// per-machine decision, so this value never travels in a merge — a laptop
    /// and a desktop each carry their own. Rationale for the no-identity-gatekeeper
    /// design this toggle is one leg of: `design-notes.md` "CLI terminal access
    /// is a default-off, unlock-gated local socket with a folder exclusion list
    /// (MYND-490)" and `docs/threat-model.md` §7. **Non-load-bearing / AS-low** —
    /// no protective-envelope clamp; the host treats a tampered/replayed value as
    /// a cosmetic toggle, same as `ai_enabled`. Canonical key `cli_enabled` —
    /// sorts after `bar_items_order` (`b` < `c`), before `cli_excluded_folders`
    /// (`cli_en` < `cli_ex`) and `custom_theme` (`cli` < `cu`).
    #[serde(default)]
    pub cli_enabled: bool,

    /// Folders excluded from the CLI's reach (myne-cli epic, MYND-490;
    /// `cli-thin-client` task 2) — canonical trailing-slash display form.
    /// **Same canonical encoding as `deliberate_folders` / `ai_excluded_folders`**
    /// (NFC-normalized, lexicographically sorted, exact-deduped set) and
    /// **omitted entirely when empty**, so a vault with no CLI exclusions is
    /// byte-identical to a pre-feature `vault.prefs`. Default empty (whole vault
    /// in scope once the door is opened). Class `Shared(SetUnion)`: an exclusion
    /// added on one device must never be lost in a merge with a device that lacks
    /// it — union is the fail-safe discipline, exactly the `ai_excluded_folders`
    /// precedent. Enforcement of the exclusion (filtering `list`/`search`/writes)
    /// is out of scope for this field's codec — see `cli-thin-client` task 5;
    /// this field only stores and syncs the set. **Non-load-bearing** — a
    /// tampered value can at worst widen/narrow the CLI's reach; no
    /// protective-envelope clamp. Canonical key `cli_excluded_folders` — sorts
    /// after `cli_enabled` (`cli_en` < `cli_ex`), before `cli_rate_limit_disabled`
    /// (`cli_ex` < `cli_r`) and `custom_theme` (`cli` < `cu`).
    #[serde(default)]
    pub cli_excluded_folders: Vec<alloc::string::String>,

    /// CLI socket rate-limit opt-out (myne-cli epic, MYND-490; `cli-thin-client`
    /// task 2). **Shape decision, made by this field** (task 2's "What to build"
    /// flagged the rate-limit field's shape as an open question): modeled
    /// **exactly on the `archive_disabled` precedent** — `Option<bool>`, not a
    /// numeric requests-per-second value, because the control the user is given
    /// in Settings is a single on/off switch ("remove the default slowdown"), not
    /// a tunable rate. `None` ≡ unset → the default-ON rate limit applies (a
    /// runaway or hostile script cannot drain the vault at full speed).
    /// `Some(true)` ≡ the user explicitly disabled the limit in Settings (task 10
    /// reads this to skip rate-limiting the socket). `Some(false)` is a legal
    /// value — re-enabling the limit after disabling it — but the UI is not
    /// expected to ever produce it: omitting the field again (returning to
    /// `None`) has the identical effect, and which one a "re-enable" control
    /// writes is the client's choice, not something this codec cares about.
    /// Omitted entirely from the canonical JSON when `None`, so a vault that
    /// never touched the toggle is byte-identical to a pre-feature `vault.prefs`
    /// (existing golden vectors unaffected — migration-less additive field on
    /// `MYP1`). Class `DeviceLocal`: a machine-local performance knob — a laptop
    /// and a desktop may legitimately want different limits. **Non-load-bearing**
    /// (a tampered/replayed value can at worst speed up or slow down the CLI
    /// socket; it grants no capability the door does not already grant) — no
    /// protective-envelope clamp. Canonical key `cli_rate_limit_disabled` —
    /// sorts after `cli_excluded_folders` (`cli_ex` < `cli_r`), before
    /// `custom_theme` (`cli` < `cu`).
    #[serde(default)]
    pub cli_rate_limit_disabled: Option<bool>,
    /// Color-group rules (graph-connection-ux-polish, MYND-604) — the ordered
    /// list of user-authored `{id, name, color, enabled, filter}` rules the
    /// knowledge-graph pane paints matching notes with at render time. ONE
    /// structured field, not a field per rule (the `saved_views` precedent
    /// class). Order is MEANINGFUL and IS the rule precedence — first match
    /// wins — so unlike `saved_views` (sorted by id; its display order lives
    /// in the separate `view_order`) this array is preserved **verbatim**,
    /// never re-sorted (the `bar_items_order` / `favorites` sequence
    /// discipline, but classified whole-value LWW, not sequence-LWW — see
    /// `core::plugins::sync::prefs_classification`). A disabled rule stays in
    /// the list, evaluated as a no-match. Each element is a nested canonical
    /// [`crate::color_group::ColorGroup`] object; `filter` reuses the same
    /// `FilterNode` AST `saved_views` already persists. Default empty;
    /// **omitted entirely from the canonical JSON when empty**, so a vault
    /// that never opens the feature stays byte-identical to a pre-feature
    /// `vault.prefs` (no outer-envelope / magic change — migration-less
    /// additive field on `MYP1`). AS3-Sensitive (a rule's name / filter /
    /// referenced tag or folder) — rides the existing prefs AEAD envelope;
    /// **non-load-bearing** (no protective-envelope clamp — a tampered or
    /// replayed `vault.prefs` can at worst reset rules to empty or apply a
    /// stale rule set, never expose or corrupt note content). Canonical key
    /// `color_groups` — sorts after `bar_items_order` (`b` < `c`), before
    /// `custom_theme` (`col` < `cus`).
    #[serde(default)]
    pub color_groups: Vec<crate::color_group::ColorGroup>,

    /// Per-vault decorative icon (vault-icons) — the curated stroke-glyph name
    /// the in-app vault switcher shows beside this vault's name, replacing the
    /// default `M` wordmark. `None` ≡ no icon set → the switcher shows the
    /// neutral `M` fallback. Drawn from the client's curated glyph set (the same
    /// `FOLDER_ICON_PATHS` family as [`PrefsView::folder_icons`]); an unknown
    /// name is ignored at render (falls back to the wordmark). A
    /// **non-load-bearing** cosmetic preference (AS-low) — a tampered/replayed
    /// `vault.prefs` can at worst surface a different glyph — so no
    /// protective-envelope clamp. Like [`PrefsView::label`], the icon lives
    /// **encrypted-only** inside `vault.prefs` (SYNC-3): it decrypts into a
    /// per-session RAM cache on unlock and the switcher reads that cache (never
    /// re-derivable from disk without the `prefs_key`). NFC-normalized +
    /// **omitted entirely when `None`**, so a vault that never set an icon is
    /// byte-identical to a pre-feature `vault.prefs` (existing golden vectors
    /// unaffected — this rides the existing `MYP1` format as a migration-less
    /// additive field, exactly like `label`). Canonical key `icon` — sorts after
    /// `hidden_bar_items` (`h` < `i`), before `item_colors` (`ico` < `ite`).
    #[serde(default)]
    pub icon: Option<String>,

    /// Per-item color label (MYND-184) — a map from a sidebar item key to a
    /// color-slot name. Keys are heterogeneous: a note UUID **or** a canonical
    /// trailing-slash folder path, discriminated by the trailing `/` exactly as
    /// [`PrefsView::item_order`] discriminates its elements (notes + folders
    /// both take a color). A `BTreeMap` so the canonical encoder emits keys in
    /// lexicographic order for free; keys + values are NFC-normalized at encode
    /// time. Default empty; **omitted entirely from the canonical JSON when
    /// empty**, so a vault that assigned no color is byte-identical to a
    /// pre-MYND-184 `vault.prefs`. A note-keyed entry is UUID-stable across note
    /// rename/move; a folder-keyed entry rides the folder prefix-rewrite + prune
    /// (client-side). **Non-load-bearing** (cosmetic, AS-low).
    /// Canonical key 'i' — sorts after `hidden_bar_items`, before `item_order`.
    #[serde(default)]
    pub item_colors: BTreeMap<String, String>,

    /// User keybinding **overrides** (hotkeys epic, MYND-304/366) — a map from a
    /// command id (an existing frozen `COMMAND_ACTIONS` id, e.g. `graph.show`) to
    /// the set of canonical chord strings the user bound to it. **Overrides only,
    /// not the full keymap**: defaults live in code, so an entry exists here only
    /// when the user changed a command's binding. Three states drive resolution
    /// host-side (`effective = override ?? default`): key **absent** ≡ use the code
    /// default; a **non-empty** array ≡ override to those chords; an **empty** array
    /// (`[]`) ≡ the user explicitly removed all bindings (no shortcut) — a distinct,
    /// meaningful state that is NOT omitted. The whole field is omitted only when the
    /// MAP is empty, so a vault that never rebound a shortcut is byte-identical to a
    /// pre-MYND-304 `vault.prefs` (existing golden vectors unaffected — migration-less
    /// additive field on `MYP1`, the `item_colors` precedent class). A `BTreeMap` so
    /// the canonical encoder emits keys in lexicographic order for free; keys + chord
    /// values are NFC-normalized at encode time, and each command's chord array is
    /// `set`-canonical (sorted + exact-deduped) since binding order does not affect
    /// dispatch. Each chord is a Myne-canonical, CodeMirror-compatible string
    /// (`Mod-Shift-g`, logical key, unresolved cross-platform `Mod`; spec § 9.5.2 +
    /// the chord-grammar definition). An unknown command id or unparseable chord is
    /// ignored host-side (fall back to default), never a codec parse failure.
    /// **Non-load-bearing** (a tampered / replayed value can at worst rebind or drop a
    /// shortcut; every command stays reachable via the palette) — no protective-envelope
    /// clamp. Canonical key 'k' — sorts after `item_order` (`i` < `k`), before `label`
    /// (`k` < `l`).
    #[serde(default)]
    pub keymap: BTreeMap<String, Vec<String>>,

    /// Human-readable per-vault label (MYND-205) — the name the in-app vault
    /// switcher shows for this vault. `None` ≡ no label set → the switcher
    /// shows a neutral fallback (`Vault N`). A **non-load-bearing** cosmetic
    /// preference (AS-low) — a tampered/replayed `vault.prefs` can at worst
    /// surface the wrong display name — so no protective-envelope clamp. The
    /// label lives **encrypted-only** inside `vault.prefs` (SYNC-3): it never
    /// touches disk or crosses IPC in plaintext except as the user's own input
    /// to `vault_set_label`, and decrypts into a per-session RAM cache on
    /// unlock. NFC-normalized + **omitted entirely when `None`**, so a vault
    /// that never set a label is byte-identical to a pre-MYND-205 `vault.prefs`
    /// (existing golden vectors unaffected, no outer-envelope / magic change —
    /// this rides the existing `MYP1` format as a migration-less additive
    /// field, exactly like `auto_lock_seconds`). Canonical key 'l' — sorts
    /// after `item_order`, before `screen_capture_protection`.
    #[serde(default)]
    pub label: Option<String>,

    /// Last successful vault-backup export, in Unix epoch **seconds**
    /// (MYND-58, vault-backup-restore epic). `None` ≡ never backed up →
    /// the field is omitted entirely from the canonical JSON, so a vault
    /// that never exported a backup is byte-identical to a pre-MYND-58
    /// `vault.prefs` (existing golden vectors unaffected — migration-less
    /// additive field like `auto_lock_seconds`). Written by an export
    /// performed on an UNLOCKED vault; a locked export cannot update it
    /// (prefs writes need `root_key`) — accepted for a best-effort
    /// reminder (spec § 9.5.2). Drives the 30-day backup-reminder banner.
    /// `u64` (no year-2106 truncation); integer-only — floats FORBIDDEN
    /// (spec § 9.5.2), enforced by the strict `,` terminator on decode.
    /// **Non-load-bearing** (a tampered / replayed value can at worst
    /// suppress or force a reminder) — no protective-envelope clamp.
    /// Canonical key 'l' — sorts after `label` (`lab` < `las`), before
    /// `screen_capture_protection`.
    #[serde(default)]
    pub last_backup_at: Option<u64>,

    /// Default location for newly-created notes (MYND-462, "Files" settings
    /// panel) — the MODE: `root` (vault root), `current` (the active note's
    /// folder), or `specific` (the folder named by
    /// [`PrefsView::new_note_location_folder`]). `None` ≡ the canonical default
    /// `root`, applied host-side. A closed enum string stored as a free
    /// `Option<String>` — the enum interpretation + unknown→default fallback live
    /// on the client (the `editor_default_view_mode` precedent class, no
    /// codec-level validation). Omitted entirely from the canonical JSON when
    /// `None`, so a vault that never customized the new-note location is
    /// byte-identical to a pre-feature `vault.prefs` (existing golden vectors
    /// unaffected — migration-less additive field on `MYP1`). **Non-load-bearing**
    /// (a tampered / replayed value can at worst place a new note in the wrong
    /// folder) — no protective-envelope clamp. Canonical key `new_note_location` —
    /// sorts after `last_backup_at` (`l` < `n`), before `new_note_location_folder`
    /// (prefix) and `paired_extensions` (`n` < `p`).
    #[serde(default)]
    pub new_note_location: Option<alloc::string::String>,

    /// Target folder (canonical trailing-slash form) for new notes when
    /// [`PrefsView::new_note_location`] is `specific` (MYND-462). `None` otherwise
    /// (and `None` ≡ no target → the host falls back to root). Designating a
    /// folder here also registers it as a deliberate folder host-side (the
    /// `daily_folder` discipline) so it survives empty. Omitted entirely from the
    /// canonical JSON when `None`. **Non-load-bearing** — no clamp. Canonical key
    /// `new_note_location_folder` — sorts immediately after `new_note_location`
    /// (prefix extension), before `paired_extensions` (`n` < `p`).
    #[serde(default)]
    pub new_note_location_folder: Option<alloc::string::String>,

    /// Spell-check enabled toggle (MYND-267, spell-checker epic). `None` ≡
    /// unset → the host applies the default-ON policy (SYNC-15) at read time.
    /// Omitted entirely from the canonical JSON when `None`, so a vault that
    /// never touched spell-check is byte-identical to a pre-MYND-267
    /// `vault.prefs` (existing golden vectors unaffected). **Non-load-bearing**
    /// (a tampered / replayed value can at worst toggle squiggles) — no
    /// protective-envelope clamp. Canonical key `spell_enabled` — sorts after
    /// `screen_capture_protection` (`sc` < `sp`), before `spell_languages`
    /// (`spell_e` < `spell_l`) and `theme`.
    #[serde(default)]
    pub spell_enabled: Option<bool>,

    /// Active spell-check language BCP-47 tags (MYND-267 / SYNC-11 union). A
    /// `set`-semantics array: NFC-normalized, lexicographically sorted,
    /// exact-deduped, and **omitted entirely when empty** so a vault that never
    /// chose languages is byte-identical to a pre-MYND-267 `vault.prefs`. The
    /// host applies the default active set ({OS-locale-if-bundled} ∪ {en-US},
    /// SYNC-15) when this is empty. **Non-load-bearing** — no clamp. Canonical
    /// key `spell_languages` — sorts after `spell_enabled`, before `theme`.
    #[serde(default)]
    pub spell_languages: Vec<String>,

    /// Which file opens on app startup (MYND-462, "Files" settings panel) — the
    /// MODE: `last` (restore the last workspace layout — the pre-feature
    /// behaviour), `empty` (open a fresh empty editor), or `specific` (open the
    /// note named by [`PrefsView::startup_open_note`]). `None` ≡ the canonical
    /// default `last`, applied host-side. A closed enum string stored as a free
    /// `Option<String>` — the enum interpretation + unknown→default fallback live
    /// on the client (the `editor_default_view_mode` precedent class). Omitted
    /// entirely from the canonical JSON when `None`, so a vault that never changed
    /// the startup behaviour is byte-identical to a pre-feature `vault.prefs`.
    /// **Non-load-bearing** (a tampered / replayed value can at worst open the
    /// wrong note or an empty editor; the saved workspace is never destroyed) — no
    /// protective-envelope clamp. Canonical key `startup_open` — sorts after
    /// `spell_languages` (`spe` < `sta`), before `startup_open_note` (prefix) and
    /// `theme` (`sta` < `the`).
    #[serde(default)]
    pub startup_open: Option<alloc::string::String>,

    /// Target note UUID for startup when [`PrefsView::startup_open`] is `specific`
    /// (MYND-462). `None` otherwise. A stale / deleted UUID falls back to the
    /// empty editor host-side (the pref is never auto-cleared on a transient read
    /// miss). Omitted entirely from the canonical JSON when `None`.
    /// **Non-load-bearing** — no clamp. Canonical key `startup_open_note` — sorts
    /// immediately after `startup_open` (prefix extension), before `theme`
    /// (`sta` < `the`).
    #[serde(default)]
    pub startup_open_note: Option<alloc::string::String>,

    /// Browser-clipper paired-extension records (MYND-443,
    /// `ext-foundation-handoff` task 7) — the on-disk projection of the
    /// pairing-token registry (issued + revoked tokens, each bound to an exact
    /// extension ID). Persisted here as a nested array of canonical
    /// [`crate::paired_extension::PairedExtension`] objects so pairing survives a
    /// desktop restart and a revocation stays durable (`decisions.md` 2026-06-20
    /// "Browser-clipper pairing-token persistence: encrypted prefs-family blob").
    /// **Authored/declarative state**, not derived — it rides the existing prefs
    /// AEAD envelope (no new magic, no new KEK role, zero new crypto), the
    /// `saved_views` precedent class. Default empty; **omitted entirely from the
    /// canonical JSON when empty**, so a vault that never paired an extension is
    /// byte-identical to a pre-MYND-443 `vault.prefs` (existing golden vectors
    /// unaffected — migration-less additive field on `MYP1`). The array is encoded
    /// sorted by `(extension_id, token_value)` (set-canonical). A
    /// tampered/absent/replayed blob falls back to the empty registry → the
    /// extension must re-pair, never a partial/injected grant (the token's scope
    /// ceiling is structurally append-only host-side, so a replay can never widen
    /// a grant; `threat-model.md` § 7 local-prefs-replay). AS-low correlation tags
    /// (extension id + token value) — never logged. **Non-load-bearing** (no
    /// protective-envelope clamp). Canonical key `paired_extensions` — sorts after
    /// `last_backup_at` (`l` < `p`), before `saved_views` (`p` < `sav`).
    #[serde(default)]
    pub paired_extensions: Vec<crate::paired_extension::PairedExtension>,

    /// Active right-panel tab id (right-panel tabs) — the id of the right
    /// sidebar tab the editor should restore (e.g. `backlinks`, `unlinked`,
    /// `outline`). `None` ≡ unset → the host applies its default (the first
    /// visible tab in canonical order). A free `Option<String>` stored verbatim
    /// (NFC-normalized at encode time); no codec-level value validation (the
    /// `active_workspace` precedent class — the client owns the tab-id
    /// interpretation + unknown→default fallback). Omitted entirely from the
    /// canonical JSON when `None`, so a vault that never switched the right-panel
    /// tab is byte-identical to a pre-feature `vault.prefs` (existing golden
    /// vectors unaffected — migration-less additive field on `MYP1`).
    /// **Non-load-bearing** (a tampered / replayed value can at worst restore the
    /// wrong tab) — no protective-envelope clamp. Canonical key
    /// `right_panel_active_tab` — sorts after `paired_extensions` (`p` < `r`),
    /// before `right_panel_hidden_tabs`.
    #[serde(default)]
    pub right_panel_active_tab: Option<alloc::string::String>,

    /// Hidden right-panel tab ids (right-panel tabs) — the **set** of right
    /// sidebar tab ids the user chose to hide via the panel's right-click menu.
    /// A `set`-semantics array: NFC-normalized, lexicographically sorted,
    /// exact-deduped (`canonical_folder_list`, the `hidden_bar_items` precedent
    /// class), and **omitted entirely when empty** so a vault whose right panel
    /// shows every tab (the default) is byte-identical to a pre-feature
    /// `vault.prefs`. An unknown id is ignored at render and pruned on the next
    /// write (no codec-level GC). **Non-load-bearing** (a tampered / replayed
    /// value can at worst hide or reveal a tab) — no protective-envelope clamp.
    /// Canonical key `right_panel_hidden_tabs` — sorts after
    /// `right_panel_active_tab`, before `right_panel_tab_order`.
    #[serde(default)]
    pub right_panel_hidden_tabs: Vec<String>,

    /// User-chosen right-panel tab display order (right-panel tabs, drag-to-reorder
    /// twin of [`PrefsView::right_panel_hidden_tabs`]). A `sequence`-semantics
    /// array of right sidebar tab ids in the order the user arranged them by
    /// dragging or via the panel's "move left / move right" actions. Order is
    /// MEANINGFUL, so the array is preserved **verbatim** — NOT sorted, NOT
    /// deduped — exactly like [`PrefsView::bar_items_order`]. NFC-normalized per
    /// element and **omitted entirely when empty** so a vault that never reordered
    /// its right-panel tabs (the default) is byte-identical to a pre-feature
    /// `vault.prefs`. An id not in the host's known set is ignored at render and
    /// pruned on the next write (no codec-level GC); a known id absent from the
    /// array falls back to its canonical default position. **Non-load-bearing**
    /// (a tampered / replayed value can at worst reorder a tab) — no
    /// protective-envelope clamp. Canonical key `right_panel_tab_order` — sorts
    /// after `right_panel_hidden_tabs`, before `saved_views` (`r` < `sav`).
    #[serde(default)]
    pub right_panel_tab_order: Vec<String>,

    /// Saved-view definitions (MYND-273, Saved Views epic) — authored content
    /// (a hand-built filter / sort / group projection), persisted as a nested
    /// array of canonical [`crate::saved_view::SavedView`] objects. **Authored,
    /// not derived**: it must survive a property-index rebuild and a vault
    /// restore, which is why it lives here in `vault.prefs` (a backup + sync
    /// member) rather than in the rebuildable `MYI1` index (SYNC-6). Default
    /// empty; **omitted entirely from the canonical JSON when empty**, so a
    /// vault with no views is byte-identical to a pre-MYND-273 `vault.prefs`
    /// (existing golden vectors unaffected — migration-less additive field on
    /// `MYP1`, the `item_colors` precedent class). The array is encoded sorted
    /// by view id (set-canonical; display order is the separate
    /// [`PrefsView::view_order`] sequence). AS3-Sensitive (a view's name /
    /// filter / referenced property) — rides the existing prefs AEAD envelope;
    /// **non-load-bearing** (no protective-envelope clamp). The 64 KiB `MYP1`
    /// cap (§ 9.5.4) bounds total view count. Canonical key `saved_views` —
    /// sorts before `screen_capture_protection` (`sav` < `scr`).
    #[serde(default)]
    pub saved_views: Vec<crate::saved_view::SavedView>,

    /// Saved-view display order (MYND-273) — an ordered list of view ids in the
    /// views-list / sidebar Views section order (SYNC-10). A **sequence** (order
    /// is the payload): preserved verbatim — NFC-normalized, NOT sorted, NOT
    /// deduped — exactly like [`PrefsView::item_order`] / [`PrefsView::favorites`].
    /// A stale id (a deleted view) is ignored at render and pruned on the next
    /// write (no codec-level GC). Default empty; **omitted entirely when empty**,
    /// so a vault that never reordered its views is byte-identical to a
    /// pre-MYND-273 `vault.prefs`. Canonical key `view_order` — sorts after
    /// `theme` (`t` < `v`), i.e. LAST.
    #[serde(default)]
    pub view_order: Vec<String>,
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
            bar_items_order: Vec::new(),
            cli_enabled: false,
            cli_excluded_folders: Vec::new(),
            cli_rate_limit_disabled: None,
            color_groups: Vec::new(),
            show_note_timestamps: true,
            reminders_enabled: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            folder_icons: Default::default(),
            hidden_bar_items: Vec::new(),
            icon: None,
            item_colors: Default::default(),
            keymap: Default::default(),
            theme: None,
            favorites: Vec::new(),
            field_clocks: Default::default(),
            item_order: Default::default(),
            deliberate_folders: Vec::new(),
            developer_mode: false,
            device_names: Default::default(),
            attachment_compression_enabled: true,
            attachment_ocr_enabled: true,
            time_format: None,
            timezone: None,
            transcription_enabled: true,
            auto_lock_seconds: None,
            auto_tag_enabled: false,
            custom_theme: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            date_format: None,
            active_workspace: None,
            ai_enabled: false,
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            archive_disabled: None,
            archived_folders: Vec::new(),
            editor_layout: None,
            editor_line_numbers: None,
            editor_content_width: None,
            editor_default_view_mode: None,
            editor_focus_dim_inactive: None,
            editor_focus_typewriter: None,
            editor_font_family: None,
            editor_line_spacing: None,
            editor_text_size: None,
            editor_vim_mode: None,
            label: None,
            last_backup_at: None,
            new_note_location: None,
            new_note_location_folder: None,
            paired_extensions: Vec::new(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            startup_open: None,
            startup_open_note: None,
            saved_views: Vec::new(),
            view_order: Vec::new(),
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
    /// different artifact type, or a next-major (`MYP5`) blob the v0.1
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

    // active_workspace (canonically FIRST — 'ac' < 'au' = auto_lock_seconds,
    // MYND-308). A free enum string; omitted entirely when None so a vault
    // that never set an active workspace is byte-identical to a pre-feature
    // vault.prefs (preserves existing KAT vectors). NFC-normalized like the
    // daily_* / custom_theme string fields.
    if let Some(ref slot) = prefs.active_workspace {
        out.extend_from_slice(b"\"active_workspace\":");
        push_json_string(&mut out, &slot.nfc().collect::<String>());
        out.push(b',');
    }

    // ai_enabled (canonical key 'ai_enabled' — after active_workspace
    // ['ai' > 'ac'], before ai_excluded_folders ['ai_en' < 'ai_ex'] and
    // archive_disabled ['ai' < 'ar']). AI opt-in toggle (local-ai epic,
    // SYNC-12). Emitted ONLY when true; omitted entirely when false (the
    // default) so a vault that never enabled AI is byte-identical to a
    // pre-feature vault.prefs (preserves existing KAT vectors). Per-vault +
    // encrypted — no at-rest "uses AI" fingerprint.
    if prefs.ai_enabled {
        out.extend_from_slice(b"\"ai_enabled\":true,");
    }

    // ai_excluded_folders (canonical key 'ai_ex…' — after ai_enabled
    // ['ai_en' < 'ai_ex'], before archive_disabled ['ai' < 'ar']). Folders the
    // AI never reads/indexes (local-ai epic, SYNC-14). SAME canonical encoding
    // as deliberate_folders (NFC-normalized, sorted, exact-deduped set),
    // OMITTED entirely when empty so a vault with no exclusions is
    // byte-identical to a pre-feature vault.prefs (preserves existing KAT
    // vectors).
    let ai_folders = canonical_folder_list(&prefs.ai_excluded_folders);
    if !ai_folders.is_empty() {
        out.extend_from_slice(b"\"ai_excluded_folders\":[");
        for (i, f) in ai_folders.iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            push_json_string(&mut out, f);
        }
        out.extend_from_slice(b"],");
    }

    // ai_provider / ai_provider_consent / ai_provider_key (canonical keys
    // 'ai_provider…' — after ai_excluded_folders ['ai_ex' < 'ai_pr'], before
    // archive_disabled ['ai' < 'ar']; among themselves, the bare key sorts
    // before its own extensions and 'c' < 'k'). The remote-provider triple
    // (ai-remote-providers, SYNC-15/SYNC-22). Each omitted entirely when
    // unset/false, so a vault that never named a provider is byte-identical to
    // a pre-feature vault.prefs (preserves existing KAT vectors) — and, more to
    // the point, the DEFAULT STATE leaves no trace in the blob at all.
    if let Some(ref provider) = prefs.ai_provider {
        out.extend_from_slice(b"\"ai_provider\":");
        push_json_string(&mut out, &provider.nfc().collect::<String>());
        out.push(b',');
    }
    if let Some(ref granted_for) = prefs.ai_provider_consent {
        out.extend_from_slice(b"\"ai_provider_consent\":");
        push_json_string(&mut out, &granted_for.nfc().collect::<String>());
        out.push(b',');
    }
    // The key IS written to the blob — it is encrypted vault content. What it
    // must never do is cross IPC, which is the `#[serde(skip_serializing)]` on
    // the field, not anything here. NFC-normalized like every other string
    // value so the canonical form is stable; provider keys are ASCII in
    // practice, so this is a no-op that keeps the rule uniform.
    if let Some(ref key) = prefs.ai_provider_key {
        out.extend_from_slice(b"\"ai_provider_key\":");
        push_json_string(&mut out, &key.nfc().collect::<String>());
        out.push(b',');
    }
    // The chosen model (SYNC-24 — no shipped default; the user picks from the
    // provider's own list). A published model name, not a credential, so it is
    // the one member of the quartet that also crosses IPC.
    if let Some(ref model) = prefs.ai_provider_model {
        out.extend_from_slice(b"\"ai_provider_model\":");
        push_json_string(&mut out, &model.nfc().collect::<String>());
        out.push(b',');
    }

    // archive_disabled (canonical key 'a', AFTER active_workspace
    // ['ar' > 'ac'] and BEFORE auto_lock_seconds ['ar' < 'au']). A bool;
    // omitted entirely when None so a vault that never touched the archive
    // toggle is byte-identical to a pre-feature vault.prefs (preserves existing
    // KAT vectors).
    if let Some(on) = prefs.archive_disabled {
        out.extend_from_slice(b"\"archive_disabled\":");
        out.extend_from_slice(if on { b"true" } else { b"false" });
        out.push(b',');
    }

    // archived_folders (canonical key 'archived_folders' — after archive_disabled
    // ['archive_' '_'=0x5F < 'archived' 'd'=0x64], before auto_lock_seconds
    // ['ar' < 'au']). Folders archived as a unit (folder-archive). SAME canonical
    // encoding as deliberate_folders / ai_excluded_folders (NFC-normalized,
    // sorted, exact-deduped set), OMITTED entirely when empty so a vault with no
    // archived folders is byte-identical to a pre-feature vault.prefs (preserves
    // existing KAT vectors).
    let archived_folder_list = canonical_folder_list(&prefs.archived_folders);
    if !archived_folder_list.is_empty() {
        out.extend_from_slice(b"\"archived_folders\":[");
        for (i, f) in archived_folder_list.iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            push_json_string(&mut out, f);
        }
        out.extend_from_slice(b"],");
    }

    // attachment_compression_enabled (canonical key
    // 'attachment_compression_enabled' — after archived_folders
    // ['archived_' < 'attachment_c'], before attachment_ocr_enabled
    // ['attachment_c' < 'attachment_o']). Ingest-time image compression
    // opt-out (ingest-image-compression). Emitted ONLY when FALSE — same
    // inverse-of-`ai_enabled` rule as attachment_ocr_enabled, because this
    // one also defaults to TRUE. A vault that never touched the toggle is
    // therefore byte-identical to a pre-feature vault.prefs, which preserves
    // the existing KAT vectors.
    if !prefs.attachment_compression_enabled {
        out.extend_from_slice(b"\"attachment_compression_enabled\":false,");
    }

    // attachment_ocr_enabled (canonical key 'attachment_ocr_enabled' — after
    // attachment_compression_enabled ['attachment_c' < 'attachment_o'], before
    // auto_lock_seconds ['att' < 'aut']).
    // Image-OCR opt-out (MYND-441). Emitted ONLY when FALSE — the inverse of the
    // `ai_enabled` rule, because this one defaults to TRUE. A vault that never
    // touched the toggle is therefore byte-identical to a pre-feature
    // vault.prefs, which preserves the existing KAT vectors.
    if !prefs.attachment_ocr_enabled {
        out.extend_from_slice(b"\"attachment_ocr_enabled\":false,");
    }

    // auto_lock_seconds (canonically after active_workspace — 'au' > 'ac';
    // 'a' < 'd' < 's'); omitted entirely when None so an unset vault is
    // byte-identical to a pre-MYND-121 vault.prefs (preserves existing KAT
    // vectors).
    if let Some(secs) = prefs.auto_lock_seconds {
        out.extend_from_slice(b"\"auto_lock_seconds\":");
        push_json_uint(&mut out, secs);
        out.push(b',');
    }

    // auto_tag_enabled (canonical key 'auto_tag_enabled' — after
    // auto_lock_seconds ['auto_l' < 'auto_t'], before bar_items_order
    // ['a' < 'b']). Automatic on-device tag suggestion (MYND-651). Emitted
    // ONLY when true; omitted entirely when false (the default) so a vault
    // that never enabled it is byte-identical to a pre-feature vault.prefs
    // (preserves existing KAT vectors) — same discipline as ai_enabled.
    if prefs.auto_tag_enabled {
        out.extend_from_slice(b"\"auto_tag_enabled\":true,");
    }

    // bar_items_order (canonical key 'b' — after auto_lock_seconds [au < b],
    // before custom_theme [b < c]). The bottom-bar display sequence (MYND
    // bottom-bar customization); same order-preserving discipline as favorites /
    // item_order / view_order — preserved verbatim, NOT sorted/deduped. Trailing
    // comma (a pre-screen_capture_protection field); omitted entirely when empty
    // so a vault that never reordered its bar is byte-identical to a pre-feature
    // vault.prefs.
    if !prefs.bar_items_order.is_empty() {
        out.extend_from_slice(b"\"bar_items_order\":");
        push_ordered_string_array(&mut out, &prefs.bar_items_order);
        out.push(b',');
    }

    // cli_enabled (canonical key 'cli_enabled' — after bar_items_order ['b' <
    // 'c'], before cli_excluded_folders ['cli_en' < 'cli_ex'] and custom_theme
    // ['cli' < 'cu']). CLI terminal-access door toggle (myne-cli epic,
    // MYND-490). Emitted ONLY when true; omitted entirely when false (the
    // default) so a vault that never enabled the CLI is byte-identical to a
    // pre-feature vault.prefs (preserves existing KAT vectors) — same
    // discipline as ai_enabled.
    if prefs.cli_enabled {
        out.extend_from_slice(b"\"cli_enabled\":true,");
    }

    // cli_excluded_folders (canonical key 'cli_excluded_folders' — after
    // cli_enabled ['cli_en' < 'cli_ex'], before cli_rate_limit_disabled
    // ['cli_ex' < 'cli_r'] and custom_theme ['cli' < 'cu']). Folders the CLI
    // never reaches (myne-cli epic, MYND-490). SAME canonical encoding as
    // deliberate_folders / ai_excluded_folders (NFC-normalized, sorted,
    // exact-deduped set), OMITTED entirely when empty so a vault with no CLI
    // exclusions is byte-identical to a pre-feature vault.prefs (preserves
    // existing KAT vectors).
    let cli_folders = canonical_folder_list(&prefs.cli_excluded_folders);
    if !cli_folders.is_empty() {
        out.extend_from_slice(b"\"cli_excluded_folders\":[");
        for (i, f) in cli_folders.iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            push_json_string(&mut out, f);
        }
        out.extend_from_slice(b"],");
    }

    // cli_rate_limit_disabled (canonical key 'cli_rate_limit_disabled' — after
    // cli_excluded_folders ['cli_ex' < 'cli_r'], before custom_theme ['cli' <
    // 'cu']). CLI socket rate-limit opt-out (myne-cli epic, MYND-490); shape
    // decision recorded on the field's rustdoc — Option<bool>, the
    // archive_disabled precedent class. A bool; omitted entirely when None so
    // a vault that never touched the rate-limit toggle is byte-identical to a
    // pre-feature vault.prefs (preserves existing KAT vectors).
    if let Some(on) = prefs.cli_rate_limit_disabled {
        out.extend_from_slice(b"\"cli_rate_limit_disabled\":");
        out.extend_from_slice(if on { b"true" } else { b"false" });
        out.push(b',');
    }

    // custom_theme (canonical key 'c' — after auto_lock_seconds 'a', before the
    // daily_* block 'd'; the only 'c' key). The active custom-theme name; takes
    // color_groups (canonical key 'col' — after bar_items_order [b < c], before
    // custom_theme [col < cus], MYND-604 graph-connection-ux-polish). The
    // ordered color-group rule list; order IS rule precedence, so the array is
    // encoded via the canonical codec's OWN verbatim-order encoder (never
    // re-sorted — contrast `saved_views`, which the codec sorts by id).
    // Omitted entirely when empty so a vault that never opens the feature is
    // byte-identical to a pre-feature vault.prefs.
    if !prefs.color_groups.is_empty() {
        out.extend_from_slice(b"\"color_groups\":");
        out.extend_from_slice(&crate::color_group::canonical_encode_color_groups(
            &prefs.color_groups,
        ));
        out.push(b',');
    }

    // custom_theme (canonical key 'cus' — after color_groups 'col' [col < cus],
    // before the daily_* block 'd'). The active custom-theme name; takes
    // precedence over `theme` host-side. Omitted when None so a vault with no
    // custom theme is byte-identical to a pre-MYND-297 vault.prefs.
    if let Some(ref name) = prefs.custom_theme {
        out.extend_from_slice(b"\"custom_theme\":");
        push_json_string(&mut out, &name.nfc().collect::<String>());
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

    // date_format (myne#279) — canonical key 'dat…', after daily_template
    // (`dai` < `dat`) and before deliberate_folders (`da` < `de`). A free enum
    // string; the client validates + maps unknown→default. Omitted when None so
    // a vault that never chose a format is byte-identical to a pre-feature
    // vault.prefs.
    if let Some(ref v) = prefs.date_format {
        out.extend_from_slice(b"\"date_format\":");
        push_json_string(&mut out, &v.nfc().collect::<String>());
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

    // developer_mode (canonical key 'd' — after deliberate_folders
    // [`deliberate_` < `developer_`], before device_names [`develope` <
    // `device_n`]). Emitted only when `true` (the `ai_enabled` positive-opt-in
    // convention), so a vault that never enabled it is byte-identical to a
    // pre-feature vault.prefs.
    if prefs.developer_mode {
        out.extend_from_slice(b"\"developer_mode\":true,");
    }

    // device_names (canonical key 'd' — after deliberate_folders [`del` < `dev`],
    // before the editor_* block [`d` < `e`]). A device_id-hex → friendly-name
    // string→string object (SYNC-41, the single home for device names); omitted
    // entirely when empty so a vault that never named a device is byte-identical
    // to a pre-feature vault.prefs (existing KAT vectors unaffected —
    // migration-less additive field on MYP1, the folder_icons / item_colors
    // precedent class). Keys emitted in lexicographic order, NFC-normalized
    // (push_canonical_string_map).
    if !prefs.device_names.is_empty() {
        out.extend_from_slice(b"\"device_names\":");
        push_canonical_string_map(&mut out, &prefs.device_names);
        out.push(b',');
    }

    // editor-typography string presets (canonical key 'e'). content_width +
    // default_view_mode + font_family sort BEFORE editor_layout
    // (`editor_c`/`editor_d`/`editor_f` < `editor_l`), the focus bools + the
    // other typography presets AFTER it (below). Each omitted when None so a
    // vault that never customized typography is byte-identical to a pre-feature
    // vault.prefs. Free enum strings — the client validates + maps unknown→default.
    if let Some(ref v) = prefs.editor_content_width {
        out.extend_from_slice(b"\"editor_content_width\":");
        push_json_string(&mut out, &v.nfc().collect::<String>());
        out.push(b',');
    }
    // editor_default_view_mode (MYND-299) — after editor_content_width
    // (`editor_c` < `editor_d`), before editor_focus_dim_inactive
    // (`editor_d` < `editor_f`). A free enum string ("live"/"reading"/"source"),
    // NFC-normalized; omitted when None.
    if let Some(ref v) = prefs.editor_default_view_mode {
        out.extend_from_slice(b"\"editor_default_view_mode\":");
        push_json_string(&mut out, &v.nfc().collect::<String>());
        out.push(b',');
    }
    // editor_focus_* bools (MYND-348) — after editor_default_view_mode
    // (`editor_d` < `editor_f`), before editor_font_family (`editor_focus` <
    // `editor_font`: 'c' < 'n'). dim_inactive < typewriter
    // (`editor_focus_d` < `editor_focus_t`). Bare bools; omitted when None so a
    // vault that never touched focus mode is byte-identical to a pre-feature
    // vault.prefs.
    if let Some(on) = prefs.editor_focus_dim_inactive {
        out.extend_from_slice(b"\"editor_focus_dim_inactive\":");
        out.extend_from_slice(if on { b"true" } else { b"false" });
        out.push(b',');
    }
    if let Some(on) = prefs.editor_focus_typewriter {
        out.extend_from_slice(b"\"editor_focus_typewriter\":");
        out.extend_from_slice(if on { b"true" } else { b"false" });
        out.push(b',');
    }
    if let Some(ref v) = prefs.editor_font_family {
        out.extend_from_slice(b"\"editor_font_family\":");
        push_json_string(&mut out, &v.nfc().collect::<String>());
        out.push(b',');
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

    // editor_line_numbers (canonical key 'e', AFTER editor_layout
    // [`editor_li` > `editor_la`] and BEFORE editor_line_spacing
    // [`editor_line_n` < `editor_line_s`]). A bool; omitted entirely when None so
    // a vault that never touched the line-number gutter is byte-identical to a
    // pre-feature vault.prefs (preserves existing KAT vectors).
    if let Some(on) = prefs.editor_line_numbers {
        out.extend_from_slice(b"\"editor_line_numbers\":");
        out.extend_from_slice(if on { b"true" } else { b"false" });
        out.push(b',');
    }

    // editor_line_spacing + editor_text_size (canonical key 'e', AFTER
    // editor_layout: `editor_li`/`editor_t` > `editor_la`). Both before
    // favorites (`e` < `f`). Omitted when None; free enum strings.
    if let Some(ref v) = prefs.editor_line_spacing {
        out.extend_from_slice(b"\"editor_line_spacing\":");
        push_json_string(&mut out, &v.nfc().collect::<String>());
        out.push(b',');
    }
    // editor_slash_hidden (set — sorted+deduped, canonical_folder_list) then
    // editor_slash_order (sequence — verbatim). MYND-336. Both omitted when empty
    // so a vault that never customized the slash menu is byte-identical to a
    // pre-feature vault.prefs. Canonical: after editor_line_spacing, before
    // editor_text_size (editor_li < editor_s < editor_te).
    let editor_slash_hidden = canonical_folder_list(&prefs.editor_slash_hidden);
    if !editor_slash_hidden.is_empty() {
        out.extend_from_slice(b"\"editor_slash_hidden\":[");
        for (i, id) in editor_slash_hidden.iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            push_json_string(&mut out, id);
        }
        out.extend_from_slice(b"],");
    }
    if !prefs.editor_slash_order.is_empty() {
        out.extend_from_slice(b"\"editor_slash_order\":");
        push_ordered_string_array(&mut out, &prefs.editor_slash_order);
        out.push(b',');
    }
    if let Some(ref v) = prefs.editor_text_size {
        out.extend_from_slice(b"\"editor_text_size\":");
        push_json_string(&mut out, &v.nfc().collect::<String>());
        out.push(b',');
    }
    // editor_toolbar_hidden (set) then editor_toolbar_order (sequence). MYND-336.
    // Canonical: after editor_text_size, before favorites (editor_te < editor_to < f).
    let editor_toolbar_hidden = canonical_folder_list(&prefs.editor_toolbar_hidden);
    if !editor_toolbar_hidden.is_empty() {
        out.extend_from_slice(b"\"editor_toolbar_hidden\":[");
        for (i, id) in editor_toolbar_hidden.iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            push_json_string(&mut out, id);
        }
        out.extend_from_slice(b"],");
    }
    if !prefs.editor_toolbar_order.is_empty() {
        out.extend_from_slice(b"\"editor_toolbar_order\":");
        push_ordered_string_array(&mut out, &prefs.editor_toolbar_order);
        out.push(b',');
    }

    // editor_vim_mode (canonical key 'e', AFTER editor_toolbar_order
    // [`editor_to` < `editor_v`] and BEFORE favorites [`e` < `f`]). A bool;
    // omitted entirely when None so a vault that never touched the vim toggle is
    // byte-identical to a pre-feature vault.prefs (preserves existing KAT
    // vectors). vim-keyboard-mode, MYND-313.
    if let Some(on) = prefs.editor_vim_mode {
        out.extend_from_slice(b"\"editor_vim_mode\":");
        out.extend_from_slice(if on { b"true" } else { b"false" });
        out.push(b',');
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

    // field_clocks (canonical key 'fi' — after 'favorites' [fa < fi], before
    // 'folder_icons' [fi < fo]). The per-field LWW clock map for the Phase 2
    // prefs sync (MYND-478, sync-protocol.md §10.2): string key (shared field
    // name or device_names/<key>) → epoch-ms integer. Omitted entirely when
    // empty so a never-stamped vault is byte-identical to a pre-MYND-478
    // vault.prefs (existing KAT vectors unaffected).
    if !prefs.field_clocks.is_empty() {
        out.extend_from_slice(b"\"field_clocks\":");
        push_canonical_u64_map(&mut out, &prefs.field_clocks);
        out.push(b',');
    }

    // folder_icons (canonical key 'f' — after 'favorites' [fa < fo], before
    // 'item_colors'). A nested string→string object (folder path → icon name);
    // omitted entirely when empty so a vault with no custom folder icon stays
    // byte-identical to a pre-MYND-185 vault.prefs. Keys emitted in lexicographic
    // order, NFC-normalized (push_canonical_string_map).
    if !prefs.folder_icons.is_empty() {
        out.extend_from_slice(b"\"folder_icons\":");
        push_canonical_string_map(&mut out, &prefs.folder_icons);
        out.push(b',');
    }

    // hidden_bar_items (canonical key 'h' — after 'folder_icons' [f < h], before
    // 'item_colors' [h < i]). A set-semantics array: NFC-normalized, sorted,
    // exact-deduped (canonical_folder_list, shared with deliberate_folders /
    // spell_languages); omitted entirely when empty so a vault whose bottom bar
    // is fully visible (the default) is byte-identical to a pre-feature
    // vault.prefs.
    let hidden_bar = canonical_folder_list(&prefs.hidden_bar_items);
    if !hidden_bar.is_empty() {
        out.extend_from_slice(b"\"hidden_bar_items\":[");
        for (i, id) in hidden_bar.iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            push_json_string(&mut out, id);
        }
        out.extend_from_slice(b"],");
    }

    // icon (canonical key 'icon' — after 'hidden_bar_items' [h < i], before
    // 'item_colors' ['ico' < 'ite']). The per-vault switcher glyph name
    // (vault-icons); omitted entirely when None so a vault that never set an icon
    // is byte-identical to a pre-feature vault.prefs (existing KAT vectors
    // unaffected). NFC-normalized like label.
    if let Some(ref icon) = prefs.icon {
        out.extend_from_slice(b"\"icon\":");
        push_json_string(&mut out, &icon.nfc().collect::<String>());
        out.push(b',');
    }

    // item_colors (canonical key 'i' — after 'hidden_bar_items', before 'item_order'
    // ['item_c' < 'item_o']). A nested string→string object whose keys are
    // heterogeneous note UUIDs OR folder paths (color labels for notes + folders);
    // omitted entirely when empty so a vault with no color stays byte-identical to
    // a pre-MYND-184 vault.prefs.
    if !prefs.item_colors.is_empty() {
        out.extend_from_slice(b"\"item_colors\":");
        push_canonical_string_map(&mut out, &prefs.item_colors);
        out.push(b',');
    }

    // item_order (canonical key 'i' — after 'item_colors' ['item_c' < 'item_o'],
    // before 'keymap' [i < k]). The unified sidebar order (MYND-596): a
    // container-keyed map — keys are container paths (`""` root / trailing-slash
    // folder paths) in lexicographic order, each value a heterogeneous
    // order-preserving sequence of note UUIDs + child folder paths. Unlike
    // `keymap` the value arrays are NOT set-canonical (order is the payload);
    // omitted entirely when the map is empty so a vault that never reordered is
    // byte-identical to a pre-MYND-596 vault.prefs whose item_order was also
    // empty (the pre-alpha clean-redefinition, not an MYP5 event — MYND-183 pin
    // 4). A non-empty pre-MYND-596 flat array does NOT round-trip; v0.1 is
    // unfrozen so no shipped vault carries one.
    if !prefs.item_order.is_empty() {
        out.extend_from_slice(b"\"item_order\":");
        push_container_keyed_order_map(&mut out, &prefs.item_order);
        out.push(b',');
    }

    // keymap (canonical key 'k' — after 'item_order' [i < k], before 'label'
    // [k < l]). User keybinding overrides (MYND-304): a nested string→array-of-
    // strings object (command id → set of canonical chords). Keys + chords are
    // NFC-normalized and each command's chord array is sorted + exact-deduped
    // (set-canonical). An empty chord array (`[]`, explicit-unbind) is preserved
    // verbatim; the whole field is omitted only when the MAP is empty so a vault
    // that never rebound a shortcut is byte-identical to a pre-MYND-304
    // vault.prefs (existing golden vectors unaffected).
    if !prefs.keymap.is_empty() {
        out.extend_from_slice(b"\"keymap\":");
        push_canonical_keymap(&mut out, &prefs.keymap);
        out.push(b',');
    }

    // label (canonical key 'l' — after 'item_order' [i < l], before
    // 'screen_capture_protection' [l < s]). The per-vault display name (MYND-205);
    // omitted entirely when None so a vault that never set a label is
    // byte-identical to a pre-MYND-205 vault.prefs (existing KAT vectors
    // unaffected). NFC-normalized like the other string fields.
    if let Some(ref label) = prefs.label {
        out.extend_from_slice(b"\"label\":");
        push_json_string(&mut out, &label.nfc().collect::<String>());
        out.push(b',');
    }

    // last_backup_at (canonical key 'l' — after 'label' [lab < las], before
    // 'screen_capture_protection'). Omitted entirely when None so a vault
    // that never exported a backup is byte-identical to a pre-MYND-58
    // vault.prefs (preserves existing KAT vectors).
    if let Some(epoch) = prefs.last_backup_at {
        out.extend_from_slice(b"\"last_backup_at\":");
        push_json_uint64(&mut out, epoch);
        out.push(b',');
    }

    // new_note_location (canonical key 'n' — after last_backup_at [l < n], before
    // new_note_location_folder [prefix] and paired_extensions [n < p], MYND-462).
    // The new-note default-location MODE (root/current/specific); omitted entirely
    // when None so a vault that never set it is byte-identical to a pre-feature
    // vault.prefs (preserves existing KAT vectors). Trailing comma like
    // last_backup_at (screen_capture_protection is mandatory and canonically
    // later).
    if let Some(ref v) = prefs.new_note_location {
        out.extend_from_slice(b"\"new_note_location\":");
        push_json_string(&mut out, &v.nfc().collect::<String>());
        out.push(b',');
    }

    // new_note_location_folder (canonical key 'new_note_location_f…' — immediately
    // after new_note_location, before paired_extensions, MYND-462). The target
    // folder when new_note_location == "specific"; omitted entirely when None.
    if let Some(ref v) = prefs.new_note_location_folder {
        out.extend_from_slice(b"\"new_note_location_folder\":");
        push_json_string(&mut out, &v.nfc().collect::<String>());
        out.push(b',');
    }

    // paired_extensions (canonical key 'p' — after last_backup_at [l < p], before
    // saved_views [p < sav]). A nested array of canonical PairedExtension objects,
    // sorted by (extension_id, token_value) (MYND-443); omitted entirely when empty
    // so a vault that never paired an extension is byte-identical to a pre-MYND-443
    // vault.prefs (existing golden vectors unaffected).
    if !prefs.paired_extensions.is_empty() {
        out.extend_from_slice(b"\"paired_extensions\":");
        out.extend_from_slice(
            &crate::paired_extension::canonical_encode_paired_extensions(&prefs.paired_extensions),
        );
        out.push(b',');
    }

    // reminder_horizon_days (canonical key 'reminder_h' — after
    // paired_extensions ['p' < 'r'], before reminders_enabled ['_' 0x5F <
    // 's' 0x73], MYND-618). Omitted entirely when None so a vault that never
    // set a horizon is byte-identical to a pre-MYND-618 vault.prefs (preserves
    // existing KAT vectors).
    if let Some(days) = prefs.reminder_horizon_days {
        out.extend_from_slice(b"\"reminder_horizon_days\":");
        push_json_uint(&mut out, days);
        out.push(b',');
    }

    // reminders_enabled (canonical key 'reminders_e' — after
    // reminder_horizon_days, before right_panel_active_tab ['re' < 'ri'],
    // MYND-618). Default `true`, so only a `false` is written — an untouched
    // vault stays byte-identical.
    if !prefs.reminders_enabled {
        out.extend_from_slice(b"\"reminders_enabled\":false,");
    }

    // right_panel_active_tab (canonical key 'right_panel_a…' — after
    // paired_extensions ['p' < 'r'], before right_panel_hidden_tabs). A free
    // enum string; omitted entirely when None so a vault that never switched the
    // right-panel tab is byte-identical to a pre-feature vault.prefs (preserves
    // existing KAT vectors). NFC-normalized like active_workspace.
    if let Some(ref tab) = prefs.right_panel_active_tab {
        out.extend_from_slice(b"\"right_panel_active_tab\":");
        push_json_string(&mut out, &tab.nfc().collect::<String>());
        out.push(b',');
    }

    // right_panel_hidden_tabs (canonical key 'right_panel_h…' — after
    // right_panel_active_tab, before right_panel_tab_order ['h' < 't']). A
    // set-semantics array: NFC-normalized, sorted, exact-deduped
    // (canonical_folder_list, shared with hidden_bar_items); omitted entirely
    // when empty so a vault whose right panel shows every tab (the default) is
    // byte-identical to a pre-feature vault.prefs.
    let right_panel_hidden = canonical_folder_list(&prefs.right_panel_hidden_tabs);
    if !right_panel_hidden.is_empty() {
        out.extend_from_slice(b"\"right_panel_hidden_tabs\":[");
        for (i, id) in right_panel_hidden.iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            push_json_string(&mut out, id);
        }
        out.extend_from_slice(b"],");
    }

    // right_panel_tab_order (canonical key 'right_panel_t…' — after
    // right_panel_hidden_tabs, before saved_views ['r' < 'sav']). The
    // right-panel tab display sequence; same order-preserving discipline as
    // bar_items_order — preserved verbatim, NOT sorted/deduped. Omitted entirely
    // when empty so a vault that never reordered its right-panel tabs is
    // byte-identical to a pre-feature vault.prefs.
    if !prefs.right_panel_tab_order.is_empty() {
        out.extend_from_slice(b"\"right_panel_tab_order\":");
        push_ordered_string_array(&mut out, &prefs.right_panel_tab_order);
        out.push(b',');
    }

    // saved_views (canonical key 'sav' — after last_backup_at, before
    // screen_capture_protection ['sav' < 'scr']). A nested array of canonical
    // SavedView objects, sorted by id (MYND-273); omitted entirely when empty so
    // a vault with no views is byte-identical to a pre-MYND-273 vault.prefs.
    if !prefs.saved_views.is_empty() {
        out.extend_from_slice(b"\"saved_views\":");
        out.extend_from_slice(&crate::saved_view::canonical_encode_saved_views(
            &prefs.saved_views,
        ));
        out.push(b',');
    }

    out.extend_from_slice(b"\"screen_capture_protection\":");
    out.extend_from_slice(if prefs.screen_capture_protection {
        b"true"
    } else {
        b"false"
    });

    // show_note_timestamps (canonical key 'sho…' — after
    // screen_capture_protection [scr < sho], before spell_enabled [sho < spe]).
    // OMIT-WHEN-DEFAULT, inverted polarity vs spell_enabled: the default is
    // `true`, so ONLY the non-default `false` is emitted (prepending a comma like
    // spell_enabled). A vault that never touched the toggle stays byte-identical
    // to a pre-feature vault.prefs (preserves existing KAT vectors).
    if !prefs.show_note_timestamps {
        out.extend_from_slice(b",\"show_note_timestamps\":false");
    }

    // show_task_marker (canonical key 'show_t…' — after show_note_timestamps
    // [show_n < show_t], before spell_enabled [sho < spe]). OMIT-WHEN-DEFAULT
    // with the same inverted polarity: the default is `true`, so ONLY the
    // non-default `false` is emitted. A vault that never touched the toggle
    // stays byte-identical to a pre-MYND-613 vault.prefs (preserves existing
    // KAT vectors).
    if !prefs.show_task_marker {
        out.extend_from_slice(b",\"show_task_marker\":false");
    }

    // spell_enabled (canonical key 'spell_e…' — after screen_capture_protection
    // [sc < sp], before spell_languages + theme). Prepends a comma like theme;
    // omitted entirely when None so an unset vault is byte-identical to a
    // pre-MYND-267 vault.prefs (preserves existing KAT vectors).
    if let Some(enabled) = prefs.spell_enabled {
        out.extend_from_slice(b",\"spell_enabled\":");
        out.extend_from_slice(if enabled { b"true" } else { b"false" });
    }

    // spell_languages (canonical key 'spell_l…' — after spell_enabled, before
    // theme). A set-semantics array: NFC-normalized, sorted, exact-deduped
    // (canonical_folder_list, shared with deliberate_folders); omitted entirely
    // when empty so a vault that never chose languages is byte-identical to a
    // pre-MYND-267 vault.prefs.
    let spell_langs = canonical_folder_list(&prefs.spell_languages);
    if !spell_langs.is_empty() {
        out.extend_from_slice(b",\"spell_languages\":[");
        for (i, lang) in spell_langs.iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            push_json_string(&mut out, lang);
        }
        out.push(b']');
    }

    // startup_open (canonical key 'sta…' — after spell_languages [spl < sta],
    // before startup_open_note [prefix] and theme [sta < the], MYND-462). The
    // startup-open MODE (last/empty/specific); leading comma like theme. Omitted
    // entirely when None so a vault that never changed startup behaviour is
    // byte-identical to a pre-feature vault.prefs (preserves existing KAT vectors).
    if let Some(ref v) = prefs.startup_open {
        out.extend_from_slice(b",\"startup_open\":");
        push_json_string(&mut out, &v.nfc().collect::<String>());
    }

    // startup_open_note (canonical key 'startup_open_n…' — immediately after
    // startup_open, before theme, MYND-462). The target note UUID when
    // startup_open == "specific"; leading comma; omitted entirely when None.
    if let Some(ref v) = prefs.startup_open_note {
        out.extend_from_slice(b",\"startup_open_note\":");
        push_json_string(&mut out, &v.nfc().collect::<String>());
    }

    // theme (canonical key 't' — LAST, after 's'). Omitted entirely when
    // None so an unset vault (≡ system) is byte-identical to a pre-MYND-110
    // vault.prefs (preserves existing KAT vectors). When Some, a JSON string
    // value "light"/"dark"/"amoled".
    if let Some(theme) = prefs.theme {
        out.extend_from_slice(b",\"theme\":\"");
        let value: &[u8] = match theme {
            ThemeChoice::Light => b"light",
            ThemeChoice::Dark => b"dark",
            ThemeChoice::Amoled => b"amoled",
        };
        out.extend_from_slice(value);
        out.push(b'"');
    }

    // time_format + timezone (myne#279) — canonical keys 'ti…', between theme
    // ['th' < 'ti'] and transcription_enabled ['ti' < 'tr']. Leading comma like
    // theme, since this region is emitted after the last comma-terminated block.
    // Free enum / IANA strings; the client validates + maps unknown→default.
    // Each omitted when None so a vault that never chose one is byte-identical
    // to a pre-feature vault.prefs.
    if let Some(ref v) = prefs.time_format {
        out.extend_from_slice(b",\"time_format\":");
        push_json_string(&mut out, &v.nfc().collect::<String>());
    }
    if let Some(ref v) = prefs.timezone {
        out.extend_from_slice(b",\"timezone\":");
        push_json_string(&mut out, &v.nfc().collect::<String>());
    }

    // transcription_enabled (canonical key 'transcription_enabled' — after
    // theme ['the' < 'tra'], before view_order ['t' < 'v']). Speech-to-text
    // opt-OUT (MYND-592). Emitted ONLY when FALSE — the same inverse rule as
    // attachment_ocr_enabled, because this one defaults to TRUE. A vault that
    // never touched the toggle is therefore byte-identical to a pre-feature
    // vault.prefs, which preserves the existing KAT vectors.
    if !prefs.transcription_enabled {
        out.extend_from_slice(b",\"transcription_enabled\":false");
    }

    // view_order (canonical key 'v' — LAST, after theme ['t' < 'v']). The
    // saved-view display sequence (MYND-273); same order-preserving discipline
    // as item_order / favorites. Leading comma; omitted entirely when empty so a
    // vault that never reordered its views is byte-identical to a pre-MYND-273
    // vault.prefs.
    if !prefs.view_order.is_empty() {
        out.extend_from_slice(b",\"view_order\":");
        push_ordered_string_array(&mut out, &prefs.view_order);
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

/// Append a canonical JSON object of string→integer members (surrounding
/// `{` / `}`, comma-joined `"key":123` members) for the `field_clocks` LWW
/// clock map (MYND-478). Keys are NFC-normalized and emitted in lexicographic
/// KEY order (collecting into a fresh [`BTreeMap`] re-sorts by the normalized
/// key and collapses any post-NFC duplicate keys last-wins — canonical input
/// never produces them); values are bare non-negative decimal integers via
/// [`push_json_uint64`] (floats FORBIDDEN, §9.5.2). The caller omits the field
/// entirely when the map is empty, so this never emits `{}`.
fn push_canonical_u64_map(out: &mut Vec<u8>, map: &BTreeMap<String, u64>) {
    let normalized: BTreeMap<String, u64> = map
        .iter()
        .map(|(k, v)| (k.nfc().collect::<String>(), *v))
        .collect();
    out.push(b'{');
    for (i, (k, v)) in normalized.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        push_json_string(out, k);
        out.push(b':');
        push_json_uint64(out, *v);
    }
    out.push(b'}');
}

/// Append a canonical JSON object of string→string pairs (surrounding
/// `{` / `}`, comma-joined `"key":"value"` members) for the
/// decoration maps (`folder_icons`, `item_colors`). Keys + values are
/// NFC-normalized, and the members are emitted in lexicographic KEY
/// order per spec § 9.5.2. Collecting the NFC-normalized pairs into a
/// fresh [`BTreeMap`] both re-sorts by the normalized key (a key whose
/// pre-normalization byte form sorted differently is re-placed) and
/// collapses any post-NFC duplicate keys deterministically (last-wins),
/// keeping the output byte-stable given the same logical value — all the
/// canonical discipline requires. The caller omits the field entirely
/// when the map is empty, so this never emits `{}`.
fn push_canonical_string_map(out: &mut Vec<u8>, map: &BTreeMap<String, String>) {
    let normalized: BTreeMap<String, String> = map
        .iter()
        .map(|(k, v)| (k.nfc().collect::<String>(), v.nfc().collect::<String>()))
        .collect();
    out.push(b'{');
    for (i, (k, v)) in normalized.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        push_json_string(out, k);
        out.push(b':');
        push_json_string(out, v);
    }
    out.push(b'}');
}

/// Append a canonical JSON object of string→string-array members (surrounding
/// `{` / `}`, comma-joined `"key":["c1","c2"]` members) for the `keymap`
/// override map (MYND-304). Keys are NFC-normalized and emitted in lexicographic
/// KEY order (collecting into a fresh [`BTreeMap`] re-sorts by the normalized key
/// and collapses any post-NFC duplicate keys last-wins). Each value array is
/// `set`-canonical — its chord strings are NFC-normalized, sorted, and
/// exact-deduped (binding order does not affect dispatch), via the shared
/// [`canonical_folder_list`]. An EMPTY chord array is preserved as `[]`
/// (the explicit-unbind state, distinct from an absent key) — it is NOT dropped.
/// The caller omits the field entirely when the map is empty, so this never
/// emits `{}`.
fn push_canonical_keymap(out: &mut Vec<u8>, map: &BTreeMap<String, Vec<String>>) {
    let normalized: BTreeMap<String, Vec<String>> = map
        .iter()
        .map(|(k, chords)| (k.nfc().collect::<String>(), canonical_folder_list(chords)))
        .collect();
    out.push(b'{');
    for (i, (k, chords)) in normalized.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        push_json_string(out, k);
        out.push(b':');
        push_ordered_string_array(out, chords);
    }
    out.push(b'}');
}

/// Append a canonical JSON object of string→string-array members (surrounding
/// `{` / `}`, comma-joined `"key":["c1","c2"]` members) for the `item_order`
/// container-keyed map (MYND-596). Keys (container paths) are NFC-normalized and
/// emitted in lexicographic KEY order (collecting into a fresh [`BTreeMap`]
/// re-sorts by the normalized key and collapses any post-NFC duplicate keys
/// last-wins — canonical input never produces them). Each value array is a
/// per-container **sequence**: order is the payload, so — UNLIKE
/// [`push_canonical_keymap`]'s set-canonical chord arrays — the elements are
/// NFC-normalized only (via [`push_ordered_string_array`]), NOT sorted and NOT
/// deduped. An empty value array is preserved as `[]` verbatim (a container
/// whose children were all removed but whose clock is still live). The caller
/// omits the field entirely when the MAP is empty, so this never emits `{}`.
fn push_container_keyed_order_map(out: &mut Vec<u8>, map: &BTreeMap<String, Vec<String>>) {
    let normalized: BTreeMap<String, &Vec<String>> = map
        .iter()
        .map(|(k, seq)| (k.nfc().collect::<String>(), seq))
        .collect();
    out.push(b'{');
    for (i, (k, seq)) in normalized.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        push_json_string(out, k);
        out.push(b':');
        push_ordered_string_array(out, seq);
    }
    out.push(b'}');
}

// The canonical JSON string-escaper + decimal-integer encoders moved to the
// shared `crate::canonical_json` module (single-homed for cross-implementation
// byte-stability across the prefs + saved_view codecs). Imported at the top.

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

    // ---- active_workspace (optional, canonically FIRST — MYND-308) ----
    // Canonical key order is active_workspace < auto_lock_seconds <
    // deliberate_folders < … < screen_capture_protection, so when present this
    // field is a literal PREFIX of the stripped object — matched by
    // `strip_prefix` rather than `find_subslice`, so a later folder name
    // containing an `"active_workspace":`-looking substring cannot fool it. The
    // string value MUST be followed by `,` — screen_capture_protection is
    // mandatory and canonically last, so a further field always follows.
    let active_marker = b"\"active_workspace\":";
    let (active_workspace, post_active) = match stripped.strip_prefix(active_marker) {
        Some(after) => {
            let (val, consumed) =
                parse_json_string(after).ok_or(PrefsBlobError::PlaintextParseFailed)?;
            let rest = after[consumed..]
                .strip_prefix(b",")
                .ok_or(PrefsBlobError::PlaintextParseFailed)?;
            (Some(val), rest)
        }
        None => (None, stripped),
    };

    // ---- ai_enabled (optional, after active_workspace — SYNC-12) ----
    // Canonical key order active_workspace < ai_enabled < ai_excluded_folders <
    // archive_disabled, so when present this bool is a literal PREFIX of the
    // post-active_workspace bytes (strip_prefix, not find_subslice — a later
    // folder name containing an `"ai_enabled":`-looking substring cannot fool
    // it). Emitted only as `true` by the encoder; `false` is tolerated for
    // robustness. Absent → false (the default). MUST be followed by `,`.
    let ai_enabled_marker = b"\"ai_enabled\":";
    let (ai_enabled, post_ai_enabled) = match post_active.strip_prefix(ai_enabled_marker) {
        Some(after) => {
            let (val, after_val) = if let Some(r) = after.strip_prefix(b"true") {
                (true, r)
            } else if let Some(r) = after.strip_prefix(b"false") {
                (false, r)
            } else {
                return Err(PrefsBlobError::PlaintextParseFailed);
            };
            let rest = after_val
                .strip_prefix(b",")
                .ok_or(PrefsBlobError::PlaintextParseFailed)?;
            (val, rest)
        }
        None => (false, post_active),
    };

    // ---- ai_excluded_folders (optional, after ai_enabled — SYNC-14) ----
    // Canonical key order ai_enabled < ai_excluded_folders < archive_disabled,
    // so when present this string array is a literal PREFIX of the
    // post-ai_enabled bytes. Same canonical set encoding as deliberate_folders;
    // absent → empty. Value MUST be a well-formed JSON string array + `,`.
    let ai_excluded_marker = b"\"ai_excluded_folders\":";
    let (ai_excluded_folders, post_ai_excluded) =
        match post_ai_enabled.strip_prefix(ai_excluded_marker) {
            Some(after) => {
                let (list, consumed) =
                    parse_json_string_array(after).ok_or(PrefsBlobError::PlaintextParseFailed)?;
                let rest = after[consumed..]
                    .strip_prefix(b",")
                    .ok_or(PrefsBlobError::PlaintextParseFailed)?;
                (list, rest)
            }
            None => (Vec::new(), post_ai_enabled),
        };

    // ---- archive_disabled (optional, after active_workspace) ----
    // Canonical key order is active_workspace < archive_disabled <
    // auto_lock_seconds, so when present this field is a literal PREFIX of the
    // post-active_workspace bytes — matched by `strip_prefix` rather than
    // `find_subslice`, so a later folder name containing an
    // `"archive_disabled":`-looking substring cannot fool it. The bool value
    // MUST be followed by `,` — screen_capture_protection is mandatory and
    // canonically last, so a further field always follows.
    // ---- ai_provider / ai_provider_consent / ai_provider_key (optional) ----
    // Canonical key order ai_excluded_folders < ai_provider <
    // ai_provider_consent < ai_provider_key < archive_disabled, so each is a
    // literal PREFIX of what the previous one left — `strip_prefix`, not
    // `find_subslice`, so a folder name containing an `"ai_provider":`-looking
    // substring cannot fool it. Absent → unset/false, which is the default and
    // the unreachable state.
    let ai_provider_marker = b"\"ai_provider\":";
    let (ai_provider, post_ai_provider) = match post_ai_excluded.strip_prefix(ai_provider_marker) {
        Some(after) => {
            let (val, consumed) =
                parse_json_string(after).ok_or(PrefsBlobError::PlaintextParseFailed)?;
            let rest = after[consumed..]
                .strip_prefix(b",")
                .ok_or(PrefsBlobError::PlaintextParseFailed)?;
            (Some(val), rest)
        }
        None => (None, post_ai_excluded),
    };
    let ai_provider_consent_marker = b"\"ai_provider_consent\":";
    let (ai_provider_consent, post_ai_provider_consent) =
        match post_ai_provider.strip_prefix(ai_provider_consent_marker) {
            Some(after) => {
                let (val, consumed) =
                    parse_json_string(after).ok_or(PrefsBlobError::PlaintextParseFailed)?;
                let rest = after[consumed..]
                    .strip_prefix(b",")
                    .ok_or(PrefsBlobError::PlaintextParseFailed)?;
                (Some(val), rest)
            }
            None => (None, post_ai_provider),
        };
    let ai_provider_key_marker = b"\"ai_provider_key\":";
    let (ai_provider_key, post_ai_provider_key) =
        match post_ai_provider_consent.strip_prefix(ai_provider_key_marker) {
            Some(after) => {
                let (val, consumed) =
                    parse_json_string(after).ok_or(PrefsBlobError::PlaintextParseFailed)?;
                let rest = after[consumed..]
                    .strip_prefix(b",")
                    .ok_or(PrefsBlobError::PlaintextParseFailed)?;
                // Wrapped the moment it exists, so every path out of this
                // function — including the `?` on a LATER field's parse
                // failure — wipes the buffer on the way (myne-md/myne#444).
                (Some(Zeroizing::new(val)), rest)
            }
            None => (None, post_ai_provider_consent),
        };
    let ai_provider_model_marker = b"\"ai_provider_model\":";
    let (ai_provider_model, post_ai_provider_model) =
        match post_ai_provider_key.strip_prefix(ai_provider_model_marker) {
            Some(after) => {
                let (val, consumed) =
                    parse_json_string(after).ok_or(PrefsBlobError::PlaintextParseFailed)?;
                let rest = after[consumed..]
                    .strip_prefix(b",")
                    .ok_or(PrefsBlobError::PlaintextParseFailed)?;
                (Some(val), rest)
            }
            None => (None, post_ai_provider_key),
        };

    let archive_marker = b"\"archive_disabled\":";
    let (archive_disabled, post_archive) = match post_ai_provider_model.strip_prefix(archive_marker)
    {
        Some(after) => {
            let (val, after_val) = if let Some(r) = after.strip_prefix(b"true") {
                (true, r)
            } else if let Some(r) = after.strip_prefix(b"false") {
                (false, r)
            } else {
                return Err(PrefsBlobError::PlaintextParseFailed);
            };
            let rest = after_val
                .strip_prefix(b",")
                .ok_or(PrefsBlobError::PlaintextParseFailed)?;
            (Some(val), rest)
        }
        // Rewinds to the block's OWN predecessor, not one further back: every
        // field after this one is located by `strip_prefix`, so a cursor that
        // starts behind `ai_provider_model` makes all four of them miss.
        None => (None, post_ai_provider_model),
    };

    // ---- archived_folders (optional, after archive_disabled — folder-archive) ----
    // Canonical key order archive_disabled < archived_folders < auto_lock_seconds,
    // so when present this string array is a literal PREFIX of the
    // post-archive_disabled bytes. Same canonical set encoding as
    // deliberate_folders / ai_excluded_folders; absent → empty. Value MUST be a
    // well-formed JSON string array + `,`.
    let archived_folders_marker = b"\"archived_folders\":";
    let (archived_folders, post_archived_folders) =
        match post_archive.strip_prefix(archived_folders_marker) {
            Some(after) => {
                let (list, consumed) =
                    parse_json_string_array(after).ok_or(PrefsBlobError::PlaintextParseFailed)?;
                let rest = after[consumed..]
                    .strip_prefix(b",")
                    .ok_or(PrefsBlobError::PlaintextParseFailed)?;
                (list, rest)
            }
            None => (Vec::new(), post_archive),
        };

    // ---- attachment_compression_enabled (optional, after archived_folders) ----
    // Canonical key order archived_folders < attachment_compression_enabled <
    // attachment_ocr_enabled, so when present this bool is a literal PREFIX of
    // the post-archived_folders bytes (strip_prefix, not find_subslice — a
    // folder name containing an `"attachment_compression_enabled":`-looking
    // substring cannot fool it). The encoder emits it only as `false`; `true`
    // is tolerated for robustness. **Absent → TRUE**, the default, which is
    // what makes every pre-feature blob decode with the feature on. MUST be
    // followed by `,`.
    let attachment_compression_marker = b"\"attachment_compression_enabled\":";
    let (attachment_compression_enabled, post_attachment_compression) =
        match post_archived_folders.strip_prefix(attachment_compression_marker) {
            Some(after) => {
                let (val, after_val) =
                    parse_json_bool(after).ok_or(PrefsBlobError::PlaintextParseFailed)?;
                let rest = after_val
                    .strip_prefix(b",")
                    .ok_or(PrefsBlobError::PlaintextParseFailed)?;
                (val, rest)
            }
            None => (true, post_archived_folders),
        };

    // ---- attachment_ocr_enabled (optional, after attachment_compression_enabled) ----
    // Canonical key order attachment_compression_enabled < attachment_ocr_enabled <
    // auto_lock_seconds, so when present this bool is a literal PREFIX of the
    // post-attachment_compression_enabled bytes (strip_prefix, not
    // find_subslice — a folder name containing an
    // `"attachment_ocr_enabled":`-looking substring cannot fool it). The
    // encoder emits it only as `false`; `true` is tolerated for robustness.
    // **Absent → TRUE**, the default, which is what makes every pre-MYND-441
    // blob decode with the feature on. MUST be followed by `,`.
    let attachment_ocr_marker = b"\"attachment_ocr_enabled\":";
    let (attachment_ocr_enabled, post_attachment_ocr) =
        match post_attachment_compression.strip_prefix(attachment_ocr_marker) {
            Some(after) => {
                let (val, after_val) =
                    parse_json_bool(after).ok_or(PrefsBlobError::PlaintextParseFailed)?;
                let rest = after_val
                    .strip_prefix(b",")
                    .ok_or(PrefsBlobError::PlaintextParseFailed)?;
                (val, rest)
            }
            None => (true, post_attachment_compression),
        };

    // ---- auto_lock_seconds (optional, after archived_folders) ----
    // Canonical key order is auto_lock_seconds < deliberate_folders <
    // screen_capture_protection (and after archived_folders), so when present
    // this field is a literal PREFIX of the post-archived_folders bytes —
    // matched by `strip_prefix` rather than `find_subslice`, so a later folder
    // name containing a `"auto_lock_seconds":`-looking substring cannot fool it.
    let auto_marker = b"\"auto_lock_seconds\":";
    let (auto_lock_seconds, rest) = match post_attachment_ocr.strip_prefix(auto_marker) {
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
        None => (None, post_ai_excluded),
    };

    // ---- optional string-array fields (canonical key order) ----
    // deliberate_folders (d) → editor_layout (e) → favorites (f) →
    // item_order (i). Each is located from a MONOTONIC cursor that only
    // advances past already-parsed spans, so a later field's key marker is
    // never matched inside a prior field's array content (JSON `"`-escaping
    // already prevents a marker from appearing inside a string value, but the
    // cursor keeps the canonical key-order discipline visible + robust).
    let mut cursor = 0usize;
    // auto_tag_enabled (canonical key 'auto_tag_enabled' — after
    // auto_lock_seconds ['auto_l' < 'auto_t'], before bar_items_order
    // ['a' < 'b'], so it is the FIRST cursor-located field). Automatic
    // on-device tag suggestion (MYND-651). Emitted only as `true` by the
    // encoder; `false` is tolerated for robustness. Absent → false (the
    // default).
    let auto_tag_enabled =
        parse_optional_bool_field(rest, &mut cursor, b"\"auto_tag_enabled\":")?.unwrap_or(false);
    // bar_items_order (canonical key 'b' — after auto_tag_enabled [a < b],
    // before custom_theme [b < c]). A
    // sequence array parsed from the monotonic cursor so a later field's key
    // marker is never matched inside its content. Absent → empty; order
    // preserved verbatim (sort/dedup is encode-side and this field is a
    // sequence, so neither happens). Present-but-malformed → PlaintextParseFailed.
    let bar_items_order = parse_optional_array_field(rest, &mut cursor, b"\"bar_items_order\":")?;
    // cli_enabled (canonical key 'cli_enabled' — after bar_items_order ['b' <
    // 'c'], before cli_excluded_folders ['cli_en' < 'cli_ex']). CLI
    // terminal-access door toggle (myne-cli epic, MYND-490). Parsed from the
    // same monotonic cursor so a later field's key marker is never matched
    // inside a prior field's content. Emitted only as `true` by the encoder;
    // `false` is tolerated for robustness. Absent → false (the default).
    let cli_enabled =
        parse_optional_bool_field(rest, &mut cursor, b"\"cli_enabled\":")?.unwrap_or(false);
    // cli_excluded_folders (canonical key 'cli_excluded_folders' — after
    // cli_enabled ['cli_en' < 'cli_ex'], before cli_rate_limit_disabled
    // ['cli_ex' < 'cli_r']). Same canonical set encoding as
    // deliberate_folders / ai_excluded_folders; absent → empty.
    let cli_excluded_folders =
        parse_optional_array_field(rest, &mut cursor, b"\"cli_excluded_folders\":")?;
    // cli_rate_limit_disabled (canonical key 'cli_rate_limit_disabled' — after
    // cli_excluded_folders ['cli_ex' < 'cli_r'], before custom_theme ['cli' <
    // 'cu']). Option<bool>, the archive_disabled precedent class. Absent →
    // None (the default-ON rate limit applies).
    let cli_rate_limit_disabled =
        parse_optional_bool_field(rest, &mut cursor, b"\"cli_rate_limit_disabled\":")?;
    // color_groups (canonical key 'col' — after bar_items_order [b < c], before
    // custom_theme [col < cus], MYND-604). A nested array of canonical
    // ColorGroup objects parsed from the same monotonic cursor; absent → empty;
    // order preserved verbatim (it IS the rule precedence — never re-sorted).
    // Present-but-malformed → PlaintextParseFailed.
    let color_groups = parse_optional_color_groups_field(rest, &mut cursor, b"\"color_groups\":")?;
    // custom_theme (canonical key 'c' — before the daily_* block 'd'). The active
    // custom-theme name; takes precedence over `theme` host-side. Optional.
    let custom_theme = parse_optional_string_field(rest, &mut cursor, b"\"custom_theme\":")?;
    // daily-notes string fields (MYND-191), canonical key order:
    // daily_date_format (dai…) < daily_folder < daily_template, all before
    // deliberate_folders (del…). Optional → None when the key is absent.
    let daily_date_format =
        parse_optional_string_field(rest, &mut cursor, b"\"daily_date_format\":")?;
    let daily_folder = parse_optional_string_field(rest, &mut cursor, b"\"daily_folder\":")?;
    let daily_template = parse_optional_string_field(rest, &mut cursor, b"\"daily_template\":")?;
    // date_format (myne#279) sits between daily_template (`dai` < `dat`) and
    // deliberate_folders (`da` < `de`) — same monotonic cursor, so canonical key
    // order holds. Optional → None when the key is absent.
    let date_format = parse_optional_string_field(rest, &mut cursor, b"\"date_format\":")?;
    let deliberate_folders =
        parse_optional_array_field(rest, &mut cursor, b"\"deliberate_folders\":")?;
    // developer_mode (canonical key 'd' — after deliberate_folders
    // [`deliberate_` < `developer_`], before device_names [`develope` <
    // `device_n`]). Encoder emits it only as `true`; `false` is tolerated for
    // robustness. Absent → false (the default).
    let developer_mode =
        parse_optional_bool_field(rest, &mut cursor, b"\"developer_mode\":")?.unwrap_or(false);
    // device_names (canonical key 'd' — after deliberate_folders [del < dev],
    // before the editor_* block [d < e]). A string→string map (device_id-hex →
    // friendly name, SYNC-41); absent → empty (the folder_icons precedent).
    let device_names = parse_optional_string_map_field(rest, &mut cursor, b"\"device_names\":")?;
    // editor-typography string presets (canonical key 'e'). content_width +
    // font_family sort BEFORE editor_layout; line_spacing + text_size AFTER it.
    // All parsed from the same monotonic cursor so canonical key order holds.
    let editor_content_width =
        parse_optional_string_field(rest, &mut cursor, b"\"editor_content_width\":")?;
    // editor_default_view_mode (MYND-299) sits between editor_content_width
    // (`editor_c` < `editor_d`) and the editor_focus_* bools (`editor_d` <
    // `editor_f`); a free enum string parsed from the same monotonic cursor.
    let editor_default_view_mode =
        parse_optional_string_field(rest, &mut cursor, b"\"editor_default_view_mode\":")?;
    // editor_focus_* bools (MYND-348) sit between editor_default_view_mode
    // (`editor_d` < `editor_f`) and editor_font_family (`editor_focus` <
    // `editor_font`); dim_inactive < typewriter. Both parsed from the same
    // monotonic cursor so canonical key order holds.
    let editor_focus_dim_inactive =
        parse_optional_bool_field(rest, &mut cursor, b"\"editor_focus_dim_inactive\":")?;
    let editor_focus_typewriter =
        parse_optional_bool_field(rest, &mut cursor, b"\"editor_focus_typewriter\":")?;
    let editor_font_family =
        parse_optional_string_field(rest, &mut cursor, b"\"editor_font_family\":")?;
    // editor_layout (canonical key 'e') sits between deliberate_folders (d)
    // and favorites (f); parsed from the same monotonic cursor so a later
    // field's key marker is never matched inside the nested object.
    let editor_layout = parse_optional_editor_layout(rest, &mut cursor, b"\"editor_layout\":")?;
    // editor_line_numbers (key 'e') sits between editor_layout and
    // editor_line_spacing (`editor_line_n` < `editor_line_s`); a bool parsed from
    // the same monotonic cursor so canonical key order holds.
    let editor_line_numbers =
        parse_optional_bool_field(rest, &mut cursor, b"\"editor_line_numbers\":")?;
    let editor_line_spacing =
        parse_optional_string_field(rest, &mut cursor, b"\"editor_line_spacing\":")?;
    // MYND-336: editor_slash_hidden/order sit between editor_line_spacing and
    // editor_text_size in canonical key order.
    let editor_slash_hidden =
        parse_optional_array_field(rest, &mut cursor, b"\"editor_slash_hidden\":")?;
    let editor_slash_order =
        parse_optional_array_field(rest, &mut cursor, b"\"editor_slash_order\":")?;
    let editor_text_size =
        parse_optional_string_field(rest, &mut cursor, b"\"editor_text_size\":")?;
    // editor_toolbar_hidden/order sit between editor_text_size and favorites.
    let editor_toolbar_hidden =
        parse_optional_array_field(rest, &mut cursor, b"\"editor_toolbar_hidden\":")?;
    let editor_toolbar_order =
        parse_optional_array_field(rest, &mut cursor, b"\"editor_toolbar_order\":")?;
    // editor_vim_mode (key 'e') sits between editor_toolbar_order and favorites
    // (`editor_to` < `editor_v` < `f`); a bool parsed from the same monotonic
    // cursor so canonical key order holds. vim-keyboard-mode, MYND-313.
    let editor_vim_mode = parse_optional_bool_field(rest, &mut cursor, b"\"editor_vim_mode\":")?;
    let favorites = parse_optional_array_field(rest, &mut cursor, b"\"favorites\":")?;
    // field_clocks (key 'fi') sits between favorites (fa) and folder_icons (fo)
    // in canonical order (MYND-478) — the per-field LWW clock map for the
    // Phase 2 prefs sync; parsed from the same monotonic cursor. Absent →
    // empty map (= every clock 0 to the merge, sync-protocol.md §10.2).
    let field_clocks = parse_optional_u64_map_field(rest, &mut cursor, b"\"field_clocks\":")?;
    // folder_icons (key 'f') + item_colors (key 'i') — the decoration string
    // maps, sitting between favorites and item_order in canonical order. Parsed
    // from the same monotonic cursor so a later field's key marker is never
    // matched inside a prior field's object/array content.
    let folder_icons = parse_optional_string_map_field(rest, &mut cursor, b"\"folder_icons\":")?;
    // hidden_bar_items (key 'h') sits between folder_icons (f) and item_colors (i)
    // in canonical order. A set-semantics array parsed from the same monotonic
    // cursor so a later field's key marker is never matched inside its content
    // (`h` < `s`, so the cursor-based helper — not the post-SCP `_marker`
    // variant — is correct here).
    let hidden_bar_items = parse_optional_array_field(rest, &mut cursor, b"\"hidden_bar_items\":")?;
    // icon (key 'icon') sits between hidden_bar_items (h) and item_colors (i)
    // ['ico' < 'ite'] in canonical order. The per-vault switcher glyph name
    // (vault-icons), parsed from the same monotonic cursor so a later field's key
    // marker is never matched inside a prior field's content.
    let icon = parse_optional_string_field(rest, &mut cursor, b"\"icon\":")?;
    let item_colors = parse_optional_string_map_field(rest, &mut cursor, b"\"item_colors\":")?;
    // item_order (key 'i') — the unified sidebar order (MYND-596), a container-
    // keyed map (container path → child sequence). Shares the string→array-map
    // parser with `keymap`: decode is order-preserving either way (keymap's
    // set-canonical discipline lives only in ITS encoder), so no item_order-
    // specific parser is needed. Parsed from the same monotonic cursor so a
    // later field's key marker is never matched inside a value array.
    let item_order = parse_optional_string_array_map_field(rest, &mut cursor, b"\"item_order\":")?;
    // keymap (key 'k') — user keybinding overrides (MYND-304), sitting between
    // item_order (i) and label (l) in canonical order. A nested string→array-of-
    // strings object parsed from the same monotonic cursor so a later field's key
    // marker is never matched inside a chord value. Absent → empty map;
    // present-but-malformed → PlaintextParseFailed (matching the string-map fields).
    let keymap = parse_optional_string_array_map_field(rest, &mut cursor, b"\"keymap\":")?;
    // label (key 'l') — the per-vault display name (MYND-205), sitting between
    // item_order (i) and screen_capture_protection (s) in canonical order.
    // Parsed from the same monotonic cursor so a later field's key marker is
    // never matched inside a prior field's content.
    let label = parse_optional_string_field(rest, &mut cursor, b"\"label\":")?;
    // last_backup_at (key 'las' — after 'label' [lab < las], before
    // screen_capture_protection [l < s]). Parsed from the same monotonic
    // cursor; the strict `,` terminator inside the helper enforces the
    // spec § 9.5.2 float ban (screen_capture_protection is mandatory and
    // canonically later, so a comma always follows a well-formed value).
    let last_backup_at = parse_optional_uint64_field(rest, &mut cursor, b"\"last_backup_at\":")?;
    // new_note_location + new_note_location_folder (keys 'n' — after
    // last_backup_at [l < n], before paired_extensions [n < p], MYND-462). Parsed
    // from the same monotonic cursor so a later field's key marker is never
    // matched inside a folder path value.
    let new_note_location =
        parse_optional_string_field(rest, &mut cursor, b"\"new_note_location\":")?;
    let new_note_location_folder =
        parse_optional_string_field(rest, &mut cursor, b"\"new_note_location_folder\":")?;
    // paired_extensions (key 'p' — after last_backup_at [l < p], before
    // saved_views [p < sav], MYND-443). A nested array of canonical
    // PairedExtension objects; parsed from the same monotonic cursor so the
    // following saved_views / screen_capture_protection finds are never fooled by
    // a token value or extension id that literally contains a later marker text.
    let paired_extensions =
        parse_optional_paired_extensions_field(rest, &mut cursor, b"\"paired_extensions\":")?;
    // reminder_horizon_days + reminders_enabled (keys 'reminder' — after
    // paired_extensions ['p' < 'r'], before right_panel_* ['re' < 'ri'],
    // MYND-618). Parsed from the same monotonic cursor and in canonical order,
    // so neither can be matched inside a prior field's string content.
    let reminder_horizon_days =
        parse_optional_uint64_field(rest, &mut cursor, b"\"reminder_horizon_days\":")?
            .map(|v| u32::try_from(v).unwrap_or(u32::MAX));
    // Absent means the default `true`, mirroring the encoder's
    // omit-when-default rule, so a pre-MYND-618 blob parses unchanged.
    let reminders_enabled =
        parse_optional_bool_field(rest, &mut cursor, b"\"reminders_enabled\":")?.unwrap_or(true);
    // right_panel_* (keys 'r' — after paired_extensions ['p' < 'r'], before
    // saved_views ['r' < 'sav']). Parsed from the same monotonic cursor in
    // canonical order (active < hidden < tab_order) so the following saved_views /
    // screen_capture_protection finds are never fooled by a tab id that literally
    // contains a later marker text. All three are optional / omit-when-default.
    let right_panel_active_tab =
        parse_optional_string_field(rest, &mut cursor, b"\"right_panel_active_tab\":")?;
    let right_panel_hidden_tabs =
        parse_optional_array_field(rest, &mut cursor, b"\"right_panel_hidden_tabs\":")?;
    let right_panel_tab_order =
        parse_optional_array_field(rest, &mut cursor, b"\"right_panel_tab_order\":")?;
    // saved_views (key 'sav' — after last_backup_at, before
    // screen_capture_protection ['sav' < 'scr'], MYND-273). A nested array of
    // canonical SavedView objects; parsed from the same monotonic cursor so the
    // following screen_capture_protection find is never fooled by a view name /
    // filter value that literally contains the marker text.
    let saved_views = parse_optional_saved_views_field(rest, &mut cursor, b"\"saved_views\":")?;

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

    // ---- spell-check fields (MYND-267, canonical keys between
    // screen_capture_protection and theme) ----
    // Located by marker in the post-screen_capture_protection region, like
    // `theme`. spell_enabled is tolerant (absent / unrecognized → None);
    // spell_languages is a set-array (absent → empty, present-but-malformed →
    // PlaintextParseFailed, matching deliberate_folders).
    let spell_enabled = parse_optional_bool_marker(after_key, b"\"spell_enabled\":");
    let spell_languages = parse_optional_array_marker(after_key, b"\"spell_languages\":")?;
    // show_note_timestamps (key 'sho…' — between screen_capture_protection and
    // spell_enabled, located by marker in the post-SCP region like spell_enabled).
    // INVERTED default polarity: absent ≡ the default `true` (omit-when-default),
    // and a tolerant unrecognized value also collapses to the default (like
    // spell_enabled / theme — this field is non-load-bearing). Only a literal
    // `false` on disk flips it.
    let show_note_timestamps =
        parse_optional_bool_marker(after_key, b"\"show_note_timestamps\":").unwrap_or(true);

    // show_task_marker (key 'show_t…' — between show_note_timestamps and
    // spell_enabled). Absent means the default `true`, mirroring the encoder's
    // omit-when-default rule, so a pre-MYND-613 blob parses unchanged.
    let show_task_marker =
        parse_optional_bool_marker(after_key, b"\"show_task_marker\":").unwrap_or(true);
    // transcription_enabled (key 'tra…' — between theme and view_order,
    // MYND-592). Same omit-when-default polarity as show_task_marker above:
    // absent ≡ `true`, so every blob predating the field decodes with
    // speech-to-text on, and only a literal `false` turns it off.
    let transcription_enabled =
        parse_optional_bool_marker(after_key, b"\"transcription_enabled\":").unwrap_or(true);
    // time_format + timezone (myne#279, keys 'ti…' — between theme and
    // transcription_enabled). Located by marker in the
    // post-screen_capture_protection region like theme/spell/startup_open.
    // Tolerant: an absent key OR a non-string value decodes to None (the
    // editor_default_view_mode / theme forward-compat discipline — both are
    // non-load-bearing display settings, None ≡ host default `system`).
    let time_format = parse_optional_string_marker(after_key, b"\"time_format\":");
    let timezone = parse_optional_string_marker(after_key, b"\"timezone\":");
    // view_order (key 'v' — LAST, after theme [t < v], MYND-273). A sequence
    // array located by marker in the post-screen_capture_protection region, like
    // theme/spell. Absent → empty; present-but-malformed → PlaintextParseFailed.
    let view_order = parse_optional_array_marker(after_key, b"\"view_order\":")?;
    // startup_open + startup_open_note (keys 'sta…' — between spell_languages and
    // theme in canonical order, MYND-462). Located by marker in the
    // post-screen_capture_protection region like theme/spell. Tolerant: an absent
    // key OR a non-string value decodes to None (the editor_default_view_mode /
    // theme forward-compat discipline — both are non-load-bearing, None ≡ host
    // default).
    let startup_open = parse_optional_string_marker(after_key, b"\"startup_open\":");
    let startup_open_note = parse_optional_string_marker(after_key, b"\"startup_open_note\":");

    Ok(PrefsView {
        ai_provider,
        ai_provider_consent,
        ai_provider_key,
        ai_provider_model,
        attachment_compression_enabled,
        attachment_ocr_enabled,
        screen_capture_protection,
        show_note_timestamps,
        show_task_marker,
        time_format,
        timezone,
        transcription_enabled,
        folder_icons,
        hidden_bar_items,
        bar_items_order,
        cli_enabled,
        cli_excluded_folders,
        cli_rate_limit_disabled,
        color_groups,
        icon,
        item_colors,
        deliberate_folders,
        developer_mode,
        device_names,
        auto_lock_seconds,
        auto_tag_enabled,
        custom_theme,
        daily_date_format,
        daily_folder,
        daily_template,
        date_format,
        favorites,
        field_clocks,
        item_order,
        keymap,
        active_workspace,
        ai_enabled,
        ai_excluded_folders,
        archive_disabled,
        archived_folders,
        editor_layout,
        editor_line_numbers,
        editor_vim_mode,
        editor_content_width,
        editor_default_view_mode,
        editor_focus_dim_inactive,
        editor_focus_typewriter,
        editor_font_family,
        editor_line_spacing,
        editor_slash_hidden,
        editor_slash_order,
        editor_text_size,
        editor_toolbar_hidden,
        editor_toolbar_order,
        theme,
        label,
        last_backup_at,
        new_note_location,
        new_note_location_folder,
        startup_open,
        startup_open_note,
        paired_extensions,
        reminder_horizon_days,
        reminders_enabled,
        right_panel_active_tab,
        right_panel_hidden_tabs,
        right_panel_tab_order,
        spell_enabled,
        spell_languages,
        saved_views,
        view_order,
    })
}

/// Parse the OPTIONAL `saved_views` nested-array-of-objects field (MYND-273),
/// searching `rest` from `*cursor` onward. On a hit, decodes the canonical
/// `SavedView` array via [`crate::saved_view::parse_saved_views_array`] and
/// advances `*cursor` past the closing `]`; on a miss returns an empty `Vec`
/// and leaves `*cursor` unchanged. A malformed array (a `SavedView` that fails
/// to decode, or a non-array value) collapses to
/// [`PrefsBlobError::PlaintextParseFailed`] (the caller falls back to defaults
/// per § 9.5.5). The monotonic cursor keeps the canonical key-order discipline:
/// the following `screen_capture_protection` find never matches inside a view's
/// content.
fn parse_optional_saved_views_field(
    rest: &[u8],
    cursor: &mut usize,
    marker: &[u8],
) -> Result<Vec<crate::saved_view::SavedView>, PrefsBlobError> {
    match find_top_level_marker(rest, *cursor, marker) {
        Some(rel_idx) => {
            let val_start = *cursor + rel_idx + marker.len();
            let (views, consumed) = crate::saved_view::parse_saved_views_array(&rest[val_start..])
                .map_err(|_| PrefsBlobError::PlaintextParseFailed)?;
            *cursor = val_start + consumed;
            Ok(views)
        }
        None => Ok(Vec::new()),
    }
}

/// Parse the OPTIONAL `color_groups` nested-array-of-objects field
/// (MYND-604), searching `rest` from `*cursor` onward. On a hit, decodes the
/// canonical `ColorGroup` array via
/// [`crate::color_group::parse_color_groups_array`] and advances `*cursor`
/// past the closing `]`; on a miss returns an empty `Vec` and leaves
/// `*cursor` unchanged. A malformed array (a `ColorGroup` that fails to
/// decode, or a non-array value) collapses to
/// [`PrefsBlobError::PlaintextParseFailed`] (the caller falls back to
/// defaults per § 9.5.5). The monotonic cursor keeps the canonical
/// key-order discipline: the following `custom_theme` find never matches
/// inside a rule's content.
fn parse_optional_color_groups_field(
    rest: &[u8],
    cursor: &mut usize,
    marker: &[u8],
) -> Result<Vec<crate::color_group::ColorGroup>, PrefsBlobError> {
    match find_top_level_marker(rest, *cursor, marker) {
        Some(rel_idx) => {
            let val_start = *cursor + rel_idx + marker.len();
            let (groups, consumed) =
                crate::color_group::parse_color_groups_array(&rest[val_start..])
                    .map_err(|_| PrefsBlobError::PlaintextParseFailed)?;
            *cursor = val_start + consumed;
            Ok(groups)
        }
        None => Ok(Vec::new()),
    }
}

/// Parse the OPTIONAL `paired_extensions` nested-array-of-objects field
/// (MYND-443), searching `rest` from `*cursor` onward. On a hit, decodes the
/// canonical [`crate::paired_extension::PairedExtension`] array via
/// [`crate::paired_extension::parse_paired_extensions_array`] and advances
/// `*cursor` past the closing `]`; on a miss returns an empty `Vec` and leaves
/// `*cursor` unchanged. A malformed array (a record that fails to decode, or a
/// non-array value) collapses to [`PrefsBlobError::PlaintextParseFailed`] (the
/// caller falls back to defaults — an empty registry → the extension re-pairs,
/// § 9.5.5). The monotonic cursor keeps the canonical key-order discipline: the
/// following `saved_views` / `screen_capture_protection` finds never match
/// inside a record's content.
fn parse_optional_paired_extensions_field(
    rest: &[u8],
    cursor: &mut usize,
    marker: &[u8],
) -> Result<Vec<crate::paired_extension::PairedExtension>, PrefsBlobError> {
    match find_top_level_marker(rest, *cursor, marker) {
        Some(rel_idx) => {
            let val_start = *cursor + rel_idx + marker.len();
            let (records, consumed) =
                crate::paired_extension::parse_paired_extensions_array(&rest[val_start..])
                    .map_err(|_| PrefsBlobError::PlaintextParseFailed)?;
            *cursor = val_start + consumed;
            Ok(records)
        }
        None => Ok(Vec::new()),
    }
}

/// Tolerant OPTIONAL bool field located by `marker` in `region` (the
/// `spell_enabled` field, MYND-267). Returns `None` when the key is absent or
/// the value is not a strict `true`/`false` literal — treated as an unknown /
/// unset field (forward-compat, spec § 9.5.2) rather than a parse failure,
/// because `spell_enabled` is non-load-bearing (`None` ≡ host default-ON,
/// SYNC-15). Located by `find_subslice` so a future field sorting between
/// `screen_capture_protection` and this key cannot hide it.
fn parse_optional_bool_marker(region: &[u8], marker: &[u8]) -> Option<bool> {
    let idx = find_subslice(region, marker)?;
    let after = &region[idx + marker.len()..];
    parse_json_bool(after).map(|(v, _rest)| v)
}

/// Tolerant OPTIONAL string field located by `marker` in `region` (the
/// post-screen_capture_protection sibling of [`parse_optional_string_field`], for
/// the `startup_open*` fields, MYND-462). Returns `None` when the key is absent
/// or the value is not a well-formed JSON string — treated as an unknown / unset
/// field (forward-compat, spec § 9.5.2) rather than a parse failure, because the
/// startup fields are non-load-bearing (`None` ≡ host default `last`). Located by
/// `find_subslice` so a future field sorting between
/// `screen_capture_protection` and this key cannot hide it.
fn parse_optional_string_marker(region: &[u8], marker: &[u8]) -> Option<String> {
    let idx = find_subslice(region, marker)?;
    let after = &region[idx + marker.len()..];
    parse_json_string(after).map(|(v, _consumed)| v)
}

/// OPTIONAL set-semantics string-array field located by `marker` in `region`
/// (the `spell_languages` field, MYND-267). Absent → empty `Vec`;
/// present-but-malformed → [`PrefsBlobError::PlaintextParseFailed`] (same
/// discipline as `deliberate_folders`). Cursor-less sibling of
/// [`parse_optional_array_field`] for the post-screen_capture_protection region
/// (shared with `theme` + the spell fields, all located by marker there).
fn parse_optional_array_marker(
    region: &[u8],
    marker: &[u8],
) -> Result<Vec<String>, PrefsBlobError> {
    match find_subslice(region, marker) {
        Some(idx) => {
            let (list, _consumed) = parse_json_string_array(&region[idx + marker.len()..])
                .ok_or(PrefsBlobError::PlaintextParseFailed)?;
            Ok(list)
        }
        None => Ok(Vec::new()),
    }
}

/// Parse an OPTIONAL canonical unsigned-integer field whose key marker is
/// `marker`, searching `rest` from `*cursor` onward (the `u64` epoch-seconds
/// sibling of [`parse_optional_string_field`]). On a hit, the digits MUST be
/// followed by `,` — `screen_capture_protection` is mandatory and sorts after
/// every integer field this helper serves, so a further member always
/// follows; a trailing `.` (float, FORBIDDEN per spec § 9.5.2) or any other
/// byte rejects the parse. Advances `*cursor` past the digits on a hit;
/// returns `None` and leaves `*cursor` unchanged on a miss.
fn parse_optional_uint64_field(
    rest: &[u8],
    cursor: &mut usize,
    marker: &[u8],
) -> Result<Option<u64>, PrefsBlobError> {
    match find_top_level_marker(rest, *cursor, marker) {
        Some(rel_idx) => {
            let val_start = *cursor + rel_idx + marker.len();
            let (val, consumed) = parse_json_uint64(&rest[val_start..])?;
            if rest.get(val_start + consumed) != Some(&b',') {
                return Err(PrefsBlobError::PlaintextParseFailed);
            }
            *cursor = val_start + consumed;
            Ok(Some(val))
        }
        None => Ok(None),
    }
}

/// Parse an OPTIONAL canonical JSON boolean field whose key marker is `marker`,
/// searching `rest` from `*cursor` onward (the cursor-based bool sibling of
/// [`parse_optional_uint64_field`], for the `editor_line_numbers` field that
/// sorts BEFORE `screen_capture_protection` — unlike `spell_enabled`, which
/// sorts AFTER and uses the post-SCP [`parse_optional_bool_marker`]). On a hit,
/// the literal MUST be `true`/`false` followed by `,` — `screen_capture_protection`
/// is mandatory and canonically later, so a further member always follows; any
/// other byte rejects with [`PrefsBlobError::PlaintextParseFailed`]. Advances
/// `*cursor` past the literal on a hit; returns `None` and leaves `*cursor`
/// unchanged on a miss.
fn parse_optional_bool_field(
    rest: &[u8],
    cursor: &mut usize,
    marker: &[u8],
) -> Result<Option<bool>, PrefsBlobError> {
    match find_top_level_marker(rest, *cursor, marker) {
        Some(rel_idx) => {
            let val_start = *cursor + rel_idx + marker.len();
            let (val, after) =
                parse_json_bool(&rest[val_start..]).ok_or(PrefsBlobError::PlaintextParseFailed)?;
            if after.first() != Some(&b',') {
                return Err(PrefsBlobError::PlaintextParseFailed);
            }
            *cursor = rest.len() - after.len();
            Ok(Some(val))
        }
        None => Ok(None),
    }
}

/// Parse a leading run of ASCII decimal digits into a `u64` — the
/// epoch-seconds sibling of [`parse_json_uint`]. Consumes ONLY digit bytes;
/// rejects an empty run and overflow.
fn parse_json_uint64(bytes: &[u8]) -> Result<(u64, usize), PrefsBlobError> {
    let mut i = 0;
    let mut val: u64 = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        let d = (bytes[i] - b'0') as u64;
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
    match find_top_level_marker(rest, *cursor, marker) {
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
/// other than `"light"` / `"dark"` / `"amoled"`. An unrecognized value is
/// treated as an unknown field (forward-compat, spec § 9.5.2) rather than a
/// parse failure, because `theme` is a non-load-bearing cosmetic preference
/// and `None` ≡ follow-the-OS. Located by `find_subslice` on the key marker
/// so a future field sorting between `screen_capture_protection` and `theme`
/// does not hide it.
fn parse_optional_theme(region: &[u8]) -> Option<ThemeChoice> {
    let marker = b"\"theme\":";
    let idx = find_subslice(region, marker)?;
    let after = &region[idx + marker.len()..];
    let (value, _consumed) = parse_json_string(after)?;
    match value.as_str() {
        "light" => Some(ThemeChoice::Light),
        "dark" => Some(ThemeChoice::Dark),
        "amoled" => Some(ThemeChoice::Amoled),
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
    match find_top_level_marker(rest, *cursor, marker) {
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
    match find_top_level_marker(rest, *cursor, marker) {
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

/// Parse an OPTIONAL canonical string→string object field whose key marker is
/// `marker` (the decoration maps `folder_icons` / `item_colors`), searching
/// `rest` from `*cursor` onward. On a hit, advances `*cursor` past the closing
/// `}` and returns the decoded map; on a miss returns an empty map and leaves
/// `*cursor` unchanged. Mirrors [`parse_optional_array_field`] for an object
/// value, keeping the same monotonic-cursor canonical-key-order discipline.
fn parse_optional_string_map_field(
    rest: &[u8],
    cursor: &mut usize,
    marker: &[u8],
) -> Result<BTreeMap<String, String>, PrefsBlobError> {
    match find_top_level_marker(rest, *cursor, marker) {
        Some(rel_idx) => {
            let obj_start = *cursor + rel_idx + marker.len();
            let (map, consumed) = parse_json_string_map(&rest[obj_start..])
                .ok_or(PrefsBlobError::PlaintextParseFailed)?;
            *cursor = obj_start + consumed;
            Ok(map)
        }
        None => Ok(BTreeMap::new()),
    }
}

/// Parse the OPTIONAL `field_clocks` field (MYND-478) from the monotonic
/// cursor. Absent → empty map; present-but-malformed →
/// [`PrefsBlobError::PlaintextParseFailed`]. Mirrors
/// [`parse_optional_string_map_field`] but each value is a bare non-negative
/// JSON integer (an epoch-ms LWW clock) rather than a string.
fn parse_optional_u64_map_field(
    rest: &[u8],
    cursor: &mut usize,
    marker: &[u8],
) -> Result<BTreeMap<String, u64>, PrefsBlobError> {
    match find_top_level_marker(rest, *cursor, marker) {
        Some(rel_idx) => {
            let obj_start = *cursor + rel_idx + marker.len();
            let (map, consumed) = parse_json_u64_map(&rest[obj_start..])
                .ok_or(PrefsBlobError::PlaintextParseFailed)?;
            *cursor = obj_start + consumed;
            Ok(map)
        }
        None => Ok(BTreeMap::new()),
    }
}

/// Parse a JSON object of string→integer members starting at `bytes[0] == '{'`.
/// Returns the decoded map + bytes consumed (through the closing `}`), or `None`
/// on any malformation. The u64-valued sibling of [`parse_json_string_map`]
/// (values parse via [`parse_json_uint64`] — bare decimal, no floats, no signs).
/// Duplicate keys collapse last-wins via `BTreeMap::insert` (canonical input
/// never produces them).
fn parse_json_u64_map(bytes: &[u8]) -> Option<(BTreeMap<String, u64>, usize)> {
    if bytes.first() != Some(&b'{') {
        return None;
    }
    let mut i = 1;
    let mut out: BTreeMap<String, u64> = BTreeMap::new();
    if bytes.get(i) == Some(&b'}') {
        return Some((out, i + 1));
    }
    loop {
        if bytes.get(i) != Some(&b'"') {
            return None;
        }
        let (key, consumed) = parse_json_string(&bytes[i..])?;
        i += consumed;
        if bytes.get(i) != Some(&b':') {
            return None;
        }
        i += 1;
        let (value, consumed) = parse_json_uint64(&bytes[i..]).ok()?;
        i += consumed;
        out.insert(key, value);
        match bytes.get(i) {
            Some(&b',') => {
                i += 1;
                continue;
            }
            Some(&b'}') => return Some((out, i + 1)),
            _ => return None,
        }
    }
}

/// Parse a JSON object of string→string members starting at `bytes[0] == '{'`.
/// Returns the decoded map + bytes consumed (through the closing `}`), or `None`
/// on any malformation. Mirrors [`parse_json_string_array`] for `"key":"value"`
/// members; values nest no deeper than strings (the only object shape the
/// decoration maps use). Duplicate keys collapse last-wins via `BTreeMap::insert`
/// (canonical input never produces them).
fn parse_json_string_map(bytes: &[u8]) -> Option<(BTreeMap<String, String>, usize)> {
    if bytes.first() != Some(&b'{') {
        return None;
    }
    let mut i = 1;
    let mut out: BTreeMap<String, String> = BTreeMap::new();
    if bytes.get(i) == Some(&b'}') {
        return Some((out, i + 1));
    }
    loop {
        if bytes.get(i) != Some(&b'"') {
            return None;
        }
        let (key, consumed) = parse_json_string(&bytes[i..])?;
        i += consumed;
        if bytes.get(i) != Some(&b':') {
            return None;
        }
        i += 1;
        if bytes.get(i) != Some(&b'"') {
            return None;
        }
        let (value, consumed) = parse_json_string(&bytes[i..])?;
        i += consumed;
        out.insert(key, value);
        match bytes.get(i) {
            Some(&b',') => {
                i += 1;
                continue;
            }
            Some(&b'}') => return Some((out, i + 1)),
            _ => return None,
        }
    }
}

/// Parse the OPTIONAL `keymap` field (MYND-304) from the monotonic cursor.
/// Absent → empty map; present-but-malformed → [`PrefsBlobError::PlaintextParseFailed`].
/// Mirrors [`parse_optional_string_map_field`] but each value is a JSON string
/// ARRAY (the command's chord set) rather than a string.
fn parse_optional_string_array_map_field(
    rest: &[u8],
    cursor: &mut usize,
    marker: &[u8],
) -> Result<BTreeMap<String, Vec<String>>, PrefsBlobError> {
    match find_top_level_marker(rest, *cursor, marker) {
        Some(rel_idx) => {
            let obj_start = *cursor + rel_idx + marker.len();
            let (map, consumed) = parse_json_string_array_map(&rest[obj_start..])
                .ok_or(PrefsBlobError::PlaintextParseFailed)?;
            *cursor = obj_start + consumed;
            Ok(map)
        }
        None => Ok(BTreeMap::new()),
    }
}

/// Parse a JSON object of string→string-array members starting at `bytes[0] == '{'`.
/// Returns the decoded map + bytes consumed (through the closing `}`), or `None`
/// on any malformation. Mirrors [`parse_json_string_map`] but each value is a
/// `parse_json_string_array` (the `keymap` chord set, MYND-304); an empty array
/// `[]` is a valid value (the explicit-unbind state). Duplicate keys collapse
/// last-wins via `BTreeMap::insert` (canonical input never produces them).
fn parse_json_string_array_map(bytes: &[u8]) -> Option<(BTreeMap<String, Vec<String>>, usize)> {
    if bytes.first() != Some(&b'{') {
        return None;
    }
    let mut i = 1;
    let mut out: BTreeMap<String, Vec<String>> = BTreeMap::new();
    if bytes.get(i) == Some(&b'}') {
        return Some((out, i + 1));
    }
    loop {
        if bytes.get(i) != Some(&b'"') {
            return None;
        }
        let (key, consumed) = parse_json_string(&bytes[i..])?;
        i += consumed;
        if bytes.get(i) != Some(&b':') {
            return None;
        }
        i += 1;
        if bytes.get(i) != Some(&b'[') {
            return None;
        }
        let (value, consumed) = parse_json_string_array(&bytes[i..])?;
        i += consumed;
        out.insert(key, value);
        match bytes.get(i) {
            Some(&b',') => {
                i += 1;
                continue;
            }
            Some(&b'}') => return Some((out, i + 1)),
            _ => return None,
        }
    }
}

/// Parse a leading run of ASCII decimal digits into a `u32`, returning
/// `(value, digits_consumed)`. Rejects an empty run (no digit present)
/// and overflow. It consumes ONLY digit bytes, so a fractional literal
/// like `300.5` parses `300` and leaves the `.` for the caller's
/// terminator check to reject — enforcing the spec § 9.5.2 float ban.
/// Delegates to [`parse_json_uint64`] (single-homed digit loop); a run
/// exceeding `u32::MAX` rejects identically to the old in-loop overflow
/// check, via the `try_from`.
fn parse_json_uint(bytes: &[u8]) -> Result<(u32, usize), PrefsBlobError> {
    let (val, consumed) = parse_json_uint64(bytes)?;
    let val = u32::try_from(val).map_err(|_| PrefsBlobError::PlaintextParseFailed)?;
    Ok((val, consumed))
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

/// Find a canonical `"key":` marker at the **top level** of the prefs object,
/// scanning `rest` from `from` onward and returning the offset RELATIVE to
/// `from` (so the cursor-chain call sites read exactly like the
/// [`find_subslice`] they replace).
///
/// WHY THIS IS NOT `find_subslice`. `field_clocks` is a nested object whose
/// KEYS ARE FIELD NAMES by construction (§ 9.5.2), so a plain byte search for
/// `"color_groups":` happily matches the clock entry `"color_groups":17…` and
/// then tries to parse an integer as a rule array. That mattered exactly when
/// the real field was ABSENT — set a field, then unset it, and its stale clock
/// key stays behind to shadow it. Because § 9.5.5 collapses any inner parse
/// failure to "return defaults", the result was the SILENT loss of the whole
/// preference set (label, favorites, saved views, folder icons, every editor
/// setting), persisted by the next write. `color_groups` made it reachable by
/// an ordinary action — delete your last colour rule — but the trap is older
/// than that field and `favorites` / the `daily_*` fields sit in it too: every
/// stamped shared field parsed from the cursor chain BEFORE `field_clocks`
/// (`fi`) in canonical key order.
///
/// `rest` begins inside the root object (the strictly-positional prefix fields
/// are already consumed), so relative depth 0 IS the top level. Skipping
/// deeper matches also closes the same shadowing through the user-keyed maps
/// (`keymap`, `folder_icons`, `item_colors`).
///
/// Decode-side only: no encoding changes, so byte-stability and the golden
/// vectors are untouched, and every blob that parsed before still parses —
/// this strictly REMOVES false matches.
fn find_top_level_marker(rest: &[u8], from: usize, marker: &[u8]) -> Option<usize> {
    let hay = rest.get(from..)?;
    let mut depth = 0i32;
    let mut i = 0usize;
    while i < hay.len() {
        match hay[i] {
            b'"' => {
                if depth == 0 && hay[i..].starts_with(marker) {
                    return Some(i);
                }
                // Skip the whole string, honouring backslash escapes, so a
                // brace or quote inside a value can never move `depth`. A
                // top-level string VALUE can never false-match: the marker
                // ends in `:`, and a value is always followed by `,` or `}`.
                i += 1;
                while i < hay.len() {
                    match hay[i] {
                        b'\\' => i += 2,
                        b'"' => {
                            i += 1;
                            break;
                        }
                        _ => i += 1,
                    }
                }
                continue;
            }
            b'{' | b'[' => depth += 1,
            b'}' | b']' => depth -= 1,
            _ => {}
        }
        i += 1;
    }
    None
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
    // Magic-detecting: `MYP1` → the v0.1 family, `MYP5` → the migrated v0.2 family
    // (§10.4.1). The caller MUST have derived `prefs_key` under the matching
    // generation (a v0.2 vault derives the KEK via `derive_subkey_v0_2`). Every
    // other magic fails the magic check; the header-too-short distinction is kept
    // so the parse_fail reject surface (and its vectors) is unchanged.
    let version = match blob.get(0..4) {
        Some(m) if m == PREFS_BLOB_MAGIC => MetaVersion::V0_1,
        Some(m) if m == PREFS_BLOB_V0_2_MAGIC => MetaVersion::V0_2,
        _ => {
            if blob.len() < PREFS_BLOB_HEADER_LEN {
                return Err(PrefsBlobError::HeaderTooShort);
            }
            return Err(PrefsBlobError::MagicMismatch);
        }
    };
    decode_prefs_blob_versioned(version, prefs_key, account_number_hash, blob)
}

/// Pick the (magic, AAD) pair for `version`: `MYP1` + [`aad_prefs_blob`] for
/// v0.1, `MYP5` + the v0.2-prefixed AAD for v0.2. The `protocol_version` header
/// byte stays `0x01` in both (the generations domain-separate on magic + AAD
/// prefix + KEK, not on that byte — same shape as the `blob_envelope` families).
fn prefs_family_for(
    version: MetaVersion,
    account_number_hash: &[u8; PREFS_BLOB_ACCOUNT_HASH_LEN],
) -> ([u8; 4], Vec<u8>) {
    match version {
        MetaVersion::V0_1 => (PREFS_BLOB_MAGIC, aad_prefs_blob(account_number_hash)),
        MetaVersion::V0_2 => (
            PREFS_BLOB_V0_2_MAGIC,
            aad_singleton_blob_v0_2(PREFS_BLOB_AAD_ROLE, account_number_hash),
        ),
    }
}

/// Version-aware seal of `vault.prefs`, pulling the nonce from the OS CSPRNG. v0.1
/// writes `MYP1` + `aad_prefs_blob`; v0.2 writes `MYP5` + the v0.2 AAD. Header
/// assembly + AEAD are byte-identical to [`encode_prefs_blob`] otherwise; the
/// `prefs_key` MUST be derived under the same generation by the caller.
pub fn encode_prefs_blob_versioned(
    version: MetaVersion,
    prefs_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; PREFS_BLOB_ACCOUNT_HASH_LEN],
    prefs: &PrefsView,
) -> Result<Vec<u8>, PrefsBlobError> {
    let (magic, aad) = prefs_family_for(version, account_number_hash);
    let plaintext = Zeroizing::new(canonical_json_encode(prefs));
    if plaintext.len() > MAX_PREFS_PLAINTEXT_LEN {
        return Err(PrefsBlobError::CiphertextLenOverflow);
    }

    let mut prefs_nonce = [0u8; AEAD_NONCE_LEN];
    getrandom(&mut prefs_nonce).map_err(|_| PrefsBlobError::RandomnessUnavailable)?;
    let sealed = match aead_seal_ctx(prefs_key, &prefs_nonce, &plaintext, &aad) {
        Ok(s) => s,
        Err(e) => {
            prefs_nonce.zeroize();
            return Err(PrefsBlobError::from(e));
        }
    };
    let ciphertext_len = sealed.len();

    let mut out = Vec::with_capacity(PREFS_BLOB_HEADER_LEN + ciphertext_len);
    out.extend_from_slice(&magic);
    out.push(PREFS_BLOB_PROTOCOL_VERSION);
    out.push(PREFS_BLOB_RESERVED);
    out.extend_from_slice(&prefs_nonce);
    out.extend_from_slice(&(ciphertext_len as u32).to_be_bytes());
    out.extend_from_slice(&sealed);
    prefs_nonce.zeroize();
    Ok(out)
}

/// Version-aware open of `vault.prefs` — mirror of
/// [`encode_prefs_blob_versioned`]. Expects the `version`'s magic + AAD; every
/// structural check runs before decryption, same as [`decode_prefs_blob`].
pub fn decode_prefs_blob_versioned(
    version: MetaVersion,
    prefs_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; PREFS_BLOB_ACCOUNT_HASH_LEN],
    blob: &[u8],
) -> Result<PrefsView, PrefsBlobError> {
    let (magic, aad) = prefs_family_for(version, account_number_hash);
    if blob.len() < PREFS_BLOB_HEADER_LEN {
        return Err(PrefsBlobError::HeaderTooShort);
    }
    if blob[0..4] != magic {
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
    if ciphertext_len > MAX_PREFS_PLAINTEXT_LEN + CTX_COMMITMENT_TAG_LEN {
        return Err(PrefsBlobError::CiphertextLenOverflow);
    }
    let ciphertext_end = PREFS_BLOB_HEADER_LEN + ciphertext_len;
    if blob.len() < ciphertext_end {
        return Err(PrefsBlobError::CiphertextTruncated);
    }

    let plaintext_zeroizing = aead_open_ctx(
        prefs_key,
        &prefs_nonce,
        &blob[PREFS_BLOB_HEADER_LEN..ciphertext_end],
        &aad,
    )?;
    canonical_json_decode(&plaintext_zeroizing)
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::subkey::{derive_subkey, SubkeyRole};
    use crate::test_vector_fmt::{hex_lower, json_escape};

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
            attachment_compression_enabled: true,
            developer_mode: false,
            attachment_ocr_enabled: true,
            time_format: None,
            timezone: None,
            transcription_enabled: true,
            screen_capture_protection: true,
            bar_items_order: Vec::new(),
            cli_enabled: false,
            cli_excluded_folders: Vec::new(),
            cli_rate_limit_disabled: None,
            color_groups: Vec::new(),
            show_note_timestamps: true,
            reminders_enabled: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            folder_icons: Default::default(),
            device_names: Default::default(),
            hidden_bar_items: Vec::new(),
            icon: None,
            item_colors: Default::default(),
            keymap: Default::default(),
            theme: None,
            item_order: Default::default(),
            favorites: Vec::new(),
            field_clocks: Default::default(),
            deliberate_folders: Vec::new(),
            auto_lock_seconds: None,
            auto_tag_enabled: false,
            custom_theme: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            date_format: None,
            active_workspace: None,
            ai_enabled: false,
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            archive_disabled: None,
            archived_folders: Vec::new(),
            editor_layout: None,
            editor_line_numbers: None,
            editor_content_width: None,
            editor_default_view_mode: None,
            editor_focus_dim_inactive: None,
            editor_focus_typewriter: None,
            editor_font_family: None,
            editor_line_spacing: None,
            editor_text_size: None,
            editor_vim_mode: None,
            label: None,
            last_backup_at: None,
            new_note_location: None,
            new_note_location_folder: None,
            paired_extensions: Vec::new(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            startup_open: None,
            startup_open_note: None,
            saved_views: Vec::new(),
            view_order: Vec::new(),
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
    }

    #[test]
    fn canonical_json_encodes_false_to_expected_bytes() {
        let prefs = PrefsView {
            attachment_compression_enabled: true,
            developer_mode: false,
            attachment_ocr_enabled: true,
            time_format: None,
            timezone: None,
            transcription_enabled: true,
            screen_capture_protection: false,
            bar_items_order: Vec::new(),
            cli_enabled: false,
            cli_excluded_folders: Vec::new(),
            cli_rate_limit_disabled: None,
            color_groups: Vec::new(),
            show_note_timestamps: true,
            reminders_enabled: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            folder_icons: Default::default(),
            device_names: Default::default(),
            hidden_bar_items: Vec::new(),
            icon: None,
            item_colors: Default::default(),
            keymap: Default::default(),
            theme: None,
            item_order: Default::default(),
            favorites: Vec::new(),
            field_clocks: Default::default(),
            deliberate_folders: Vec::new(),
            auto_lock_seconds: None,
            auto_tag_enabled: false,
            custom_theme: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            date_format: None,
            active_workspace: None,
            ai_enabled: false,
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            archive_disabled: None,
            archived_folders: Vec::new(),
            editor_layout: None,
            editor_line_numbers: None,
            editor_content_width: None,
            editor_default_view_mode: None,
            editor_focus_dim_inactive: None,
            editor_focus_typewriter: None,
            editor_font_family: None,
            editor_line_spacing: None,
            editor_text_size: None,
            editor_vim_mode: None,
            label: None,
            last_backup_at: None,
            new_note_location: None,
            new_note_location_folder: None,
            paired_extensions: Vec::new(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            startup_open: None,
            startup_open_note: None,
            saved_views: Vec::new(),
            view_order: Vec::new(),
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

    // ---- decoration maps: folder_icons + item_colors (MYND-184 / 185) ----

    fn map_of(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (String::from(*k), String::from(*v)))
            .collect()
    }

    #[test]
    fn canonical_json_encodes_decoration_maps_in_canonical_position() {
        // folder_icons ('f') sorts after favorites, item_colors ('i') after
        // folder_icons — both BEFORE screen_capture_protection ('s'). Keys
        // within each object are emitted in lexicographic order.
        let prefs = PrefsView {
            folder_icons: map_of(&[("Projects/Myne/", "book"), ("Archive/2025/", "archive")]),
            device_names: Default::default(),
            hidden_bar_items: Vec::new(),
            item_colors: map_of(&[
                ("Projects/Myne/", "slate"),
                ("0190a000-0000-7000-8000-000000000001", "moss"),
            ]),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"folder_icons":{"Archive/2025/":"archive","Projects/Myne/":"book"},"item_colors":{"0190a000-0000-7000-8000-000000000001":"moss","Projects/Myne/":"slate"},"screen_capture_protection":true}"#
        );
    }

    #[test]
    fn field_clocks_encodes_in_canonical_position() {
        // field_clocks ('fi') sorts after favorites ('fa'), before
        // folder_icons ('fo') — the §9.5.2 canonical slot (MYND-478). Keys
        // within the object are emitted in lexicographic order; values are
        // bare epoch-ms integers (no floats, no trailing .0).
        let mut clocks = BTreeMap::new();
        clocks.insert(String::from("label"), 1_765_432_099_000u64);
        clocks.insert(
            String::from("device_names/3f9ac2d1aabbccdd00112233445566ff"),
            1_765_432_100_000u64,
        );
        let prefs = PrefsView {
            favorites: alloc::vec![String::from("0190a000-0000-7000-8000-000000000002")],
            field_clocks: clocks,
            folder_icons: map_of(&[("Projects/Myne/", "book")]),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"favorites":["0190a000-0000-7000-8000-000000000002"],"field_clocks":{"device_names/3f9ac2d1aabbccdd00112233445566ff":1765432100000,"label":1765432099000},"folder_icons":{"Projects/Myne/":"book"},"screen_capture_protection":true}"#
        );
    }

    #[test]
    fn empty_field_clocks_is_omitted_entirely() {
        // The omit-when-empty discipline: a vault whose shared fields were
        // never clock-stamped (every pre-MYND-478 vault) encodes byte-identically
        // to a build that predates the field — existing golden vectors
        // unaffected.
        let prefs = PrefsView::default();
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
        assert!(!encoded
            .windows(b"field_clocks".len())
            .any(|w| w == b"field_clocks"));
    }

    #[test]
    fn a_stale_field_clock_key_never_shadows_its_absent_field() {
        // REGRESSION (MYND-604). `field_clocks` keys ARE field names (§ 9.5.2),
        // so a byte-search for a top-level `"<field>":` used to match the clock
        // entry of a field that had since been UNSET — parse the integer as the
        // field's value, fail, and hand § 9.5.5 a blanket "return defaults".
        // The user-visible bug was total, silent prefs loss (label, favorites,
        // saved views, folder icons, every editor setting) after an ordinary
        // action: delete your last colour rule.
        //
        // Both fields below are parsed from the cursor chain BEFORE
        // `field_clocks` (`col` < `fi`, `fa` < `fi`), which is what made them
        // reachable; `favorites` shows the trap predates `color_groups`.
        for field in ["color_groups", "favorites"] {
            let mut clocks = BTreeMap::new();
            clocks.insert(String::from(field), 1_700_000_000_000u64);
            let view = PrefsView {
                label: Some(String::from("Keepme")),
                item_order: BTreeMap::from([(
                    String::from(""),
                    alloc::vec![String::from("0190a000-0000-7000-8000-000000000002")],
                )]),
                field_clocks: clocks.clone(),
                ..PrefsView::default()
            };
            let decoded = canonical_json_decode(&canonical_json_encode(&view))
                .expect("a stale clock key must not fail the parse");
            // The rest of the blob survived rather than collapsing to defaults.
            assert_eq!(decoded.label.as_deref(), Some("Keepme"), "{field}");
            assert_eq!(decoded.item_order, view.item_order, "{field}");
            assert_eq!(decoded.field_clocks, clocks, "{field}");
            // …and the shadowed field itself reads as genuinely absent.
            assert!(decoded.color_groups.is_empty(), "{field}");
            assert!(decoded.favorites.is_empty(), "{field}");
        }
    }

    #[test]
    fn top_level_marker_search_ignores_nested_and_value_lookalikes() {
        // The finder keys on structural depth, not on `field_clocks`
        // specifically: a user-controlled map key (`folder_icons` paths) and a
        // string VALUE that spells a field name are both non-matches, while the
        // real top-level field is still found.
        let mut icons = BTreeMap::new();
        icons.insert(String::from("Projects/"), String::from("book"));
        let view = PrefsView {
            // A label whose VALUE is a field name.
            label: Some(String::from("favorites")),
            favorites: alloc::vec![String::from("0190a000-0000-7000-8000-000000000002")],
            folder_icons: icons,
            ..PrefsView::default()
        };
        let decoded = canonical_json_decode(&canonical_json_encode(&view)).expect("parses");
        assert_eq!(decoded.favorites, view.favorites);
        assert_eq!(decoded.label.as_deref(), Some("favorites"));
        assert_eq!(decoded.folder_icons, view.folder_icons);
    }

    #[test]
    fn field_clocks_round_trips() {
        // Encode → decode preserves the full map, including a namespaced
        // device_names/<key> entry and a max-magnitude u64 clock.
        let mut clocks = BTreeMap::new();
        clocks.insert(String::from("label"), 1u64);
        clocks.insert(String::from("icon"), u64::MAX);
        clocks.insert(String::from("device_names/00ff"), 1_765_432_100_000u64);
        let prefs = PrefsView {
            field_clocks: clocks.clone(),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&prefs);
        let decoded = canonical_json_decode(&encoded).expect("round-trip decode");
        assert_eq!(decoded.field_clocks, clocks);
        assert_eq!(decoded, prefs);
    }

    #[test]
    fn absent_field_clocks_decodes_to_empty_map() {
        // A pre-MYND-478 plaintext (no field_clocks key) MUST decode with an
        // empty map — absent = every clock 0 to the merge (sync-protocol.md
        // §10.2).
        let plaintext = br#"{"favorites":["f1"],"folder_icons":{"P/":"book"},"screen_capture_protection":true}"#;
        let decoded = canonical_json_decode(plaintext).expect("legacy decode");
        assert!(decoded.field_clocks.is_empty());
    }

    #[test]
    fn canonical_json_omits_empty_decoration_maps() {
        // Default (empty maps) must be byte-identical to the screen_capture-only
        // form — the omit-when-empty discipline that keeps pre-feature golden
        // vectors unaffected.
        let encoded = canonical_json_encode(&PrefsView::default());
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
    }

    #[test]
    fn decoration_maps_round_trip_through_blob() {
        let original = PrefsView {
            folder_icons: map_of(&[("Archive/2025/", "archive"), ("Projects/Myne/", "book")]),
            device_names: Default::default(),
            hidden_bar_items: Vec::new(),
            item_colors: map_of(&[
                ("0190a000-0000-7000-8000-000000000001", "moss"),
                ("Projects/Myne/", "slate"),
            ]),
            ..PrefsView::default()
        };
        let prefs_key = derive_subkey(&fixed_root_key(), SubkeyRole::PrefsKey);
        let account_hash = fixed_account_number_hash();
        let blob =
            encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce())
                .expect("encode");
        let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).expect("decode");
        assert_eq!(decoded, original);
    }

    #[test]
    fn decode_parses_hand_written_decoration_maps() {
        let plaintext = br#"{"folder_icons":{"Projects/":"code"},"item_colors":{"0190a000-0000-7000-8000-000000000002":"clay"},"screen_capture_protection":false}"#;
        let parsed = canonical_json_decode(plaintext).expect("decode");
        assert_eq!(parsed.folder_icons, map_of(&[("Projects/", "code")]));
        assert_eq!(
            parsed.item_colors,
            map_of(&[("0190a000-0000-7000-8000-000000000002", "clay")])
        );
        assert!(!parsed.screen_capture_protection);
    }

    #[test]
    fn device_names_encode_canonical_bytes() {
        // device_names (SYNC-41) encodes as a canonical string→string object
        // (lexicographic keys, NFC) at canonical key 'd' — before
        // screen_capture_protection ('s'). Pins the new field's byte layout.
        let prefs = PrefsView {
            device_names: map_of(&[("bb", "Phone"), ("aa", "Laptop")]),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"device_names":{"aa":"Laptop","bb":"Phone"},"screen_capture_protection":true}"#
        );
    }

    #[test]
    fn device_names_canonical_position_between_deliberate_folders_and_editor() {
        // Load-bearing canonical key order: deliberate_folders (del) <
        // device_names (dev) < editor_content_width (e). Guards the exact slot.
        let prefs = PrefsView {
            deliberate_folders: alloc::vec![alloc::string::String::from("A/")],
            device_names: map_of(&[("d1", "Mac")]),
            editor_content_width: Some(String::from("wide")),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"deliberate_folders":["A/"],"device_names":{"d1":"Mac"},"editor_content_width":"wide","screen_capture_protection":true}"#
        );
    }

    #[test]
    fn device_names_omitted_when_empty_preserves_pre_feature_bytes() {
        // A vault that never named a device must be byte-identical to the
        // pre-feature form — the migration-less additive-field discipline.
        let prefs = PrefsView {
            deliberate_folders: alloc::vec![alloc::string::String::from("A/")],
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&prefs);
        // The exact golden below has no `device_names` key — proof the empty map
        // is omitted and the byte layout is unperturbed.
        assert_eq!(
            encoded.as_slice(),
            br#"{"deliberate_folders":["A/"],"screen_capture_protection":true}"#
        );
    }

    #[test]
    fn device_names_round_trips_through_blob() {
        let original = PrefsView {
            device_names: map_of(&[("0a1b", "Work Laptop"), ("ff00", "Phone")]),
            ..PrefsView::default()
        };
        let prefs_key = derive_subkey(&fixed_root_key(), SubkeyRole::PrefsKey);
        let account_hash = fixed_account_number_hash();
        let blob =
            encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce())
                .expect("encode");
        let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).expect("decode");
        assert_eq!(decoded, original);
        assert_eq!(decoded.device_names, original.device_names);
    }

    #[test]
    fn decoration_map_keys_and_values_are_nfc_normalized() {
        // A folder key supplied in NFD ("e" + U+0301 combining acute) must be
        // emitted in NFC (U+00E9) — byte-stability discipline.
        let prefs = PrefsView {
            folder_icons: map_of(&[("Cafe\u{301}/", "book")]),
            device_names: Default::default(),
            hidden_bar_items: Vec::new(),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&prefs);
        // NFC "é" = 0xC3 0xA9; the NFD combining mark 0xCC 0x81 must be absent.
        assert!(find_subslice(&encoded, &[0xC3, 0xA9]).is_some());
        assert!(find_subslice(&encoded, &[0xCC, 0x81]).is_none());
    }

    #[test]
    fn empty_decoration_map_object_decodes_to_empty() {
        // A literal `{}` value (the codec never emits this — caller omits the
        // key — but a hand-tampered-but-AEAD-OK blob could) decodes to empty.
        let plaintext = br#"{"folder_icons":{},"screen_capture_protection":true}"#;
        let parsed = canonical_json_decode(plaintext).expect("decode");
        assert!(parsed.folder_icons.is_empty());
        assert!(parsed.item_colors.is_empty());
    }

    // ---- canonical JSON decoder ----------------------------------------

    #[test]
    fn canonical_json_decodes_true() {
        let parsed = canonical_json_decode(br#"{"screen_capture_protection":true}"#).unwrap();
        assert_eq!(
            parsed,
            PrefsView {
                attachment_compression_enabled: true,
                developer_mode: false,
                attachment_ocr_enabled: true,
                time_format: None,
                timezone: None,
                transcription_enabled: true,
                screen_capture_protection: true,
                bar_items_order: Vec::new(),
                cli_enabled: false,
                cli_excluded_folders: Vec::new(),
                cli_rate_limit_disabled: None,
                color_groups: Vec::new(),
                icon: None,
                ai_enabled: false,
                ai_excluded_folders: Vec::new(),
                ai_provider: None,
                ai_provider_consent: None,
                ai_provider_key: None,
                ai_provider_model: None,
                archived_folders: Vec::new(),
                show_note_timestamps: true,
                reminders_enabled: true,
                reminder_horizon_days: None,
                show_task_marker: true,
                folder_icons: Default::default(),
                device_names: Default::default(),
                hidden_bar_items: Vec::new(),
                item_colors: Default::default(),
                keymap: Default::default(),
                theme: None,
                item_order: Default::default(),
                favorites: Vec::new(),
                field_clocks: Default::default(),
                deliberate_folders: Vec::new(),
                auto_lock_seconds: None,
                auto_tag_enabled: false,
                custom_theme: None,
                daily_date_format: None,
                daily_folder: None,
                daily_template: None,
                date_format: None,
                active_workspace: None,
                archive_disabled: None,
                editor_layout: None,
                editor_line_numbers: None,
                editor_content_width: None,
                editor_default_view_mode: None,
                editor_focus_dim_inactive: None,
                editor_focus_typewriter: None,
                editor_font_family: None,
                editor_line_spacing: None,
                editor_text_size: None,
                editor_vim_mode: None,
                label: None,
                last_backup_at: None,
                new_note_location: None,
                new_note_location_folder: None,
                paired_extensions: Vec::new(),
                right_panel_active_tab: None,
                right_panel_hidden_tabs: Vec::new(),
                right_panel_tab_order: Vec::new(),
                editor_slash_hidden: Vec::new(),
                editor_slash_order: Vec::new(),
                editor_toolbar_hidden: Vec::new(),
                editor_toolbar_order: Vec::new(),
                spell_enabled: None,
                spell_languages: Vec::new(),
                startup_open: None,
                startup_open_note: None,
                saved_views: Vec::new(),
                view_order: Vec::new(),
            }
        );
    }

    #[test]
    fn canonical_json_decodes_false() {
        let parsed = canonical_json_decode(br#"{"screen_capture_protection":false}"#).unwrap();
        assert_eq!(
            parsed,
            PrefsView {
                attachment_compression_enabled: true,
                developer_mode: false,
                attachment_ocr_enabled: true,
                time_format: None,
                timezone: None,
                transcription_enabled: true,
                screen_capture_protection: false,
                bar_items_order: Vec::new(),
                cli_enabled: false,
                cli_excluded_folders: Vec::new(),
                cli_rate_limit_disabled: None,
                color_groups: Vec::new(),
                icon: None,
                ai_enabled: false,
                ai_excluded_folders: Vec::new(),
                ai_provider: None,
                ai_provider_consent: None,
                ai_provider_key: None,
                ai_provider_model: None,
                archived_folders: Vec::new(),
                show_note_timestamps: true,
                reminders_enabled: true,
                reminder_horizon_days: None,
                show_task_marker: true,
                folder_icons: Default::default(),
                device_names: Default::default(),
                hidden_bar_items: Vec::new(),
                item_colors: Default::default(),
                keymap: Default::default(),
                theme: None,
                item_order: Default::default(),
                favorites: Vec::new(),
                field_clocks: Default::default(),
                deliberate_folders: Vec::new(),
                auto_lock_seconds: None,
                auto_tag_enabled: false,
                custom_theme: None,
                daily_date_format: None,
                daily_folder: None,
                daily_template: None,
                date_format: None,
                active_workspace: None,
                archive_disabled: None,
                editor_layout: None,
                editor_line_numbers: None,
                editor_content_width: None,
                editor_default_view_mode: None,
                editor_focus_dim_inactive: None,
                editor_focus_typewriter: None,
                editor_font_family: None,
                editor_line_spacing: None,
                editor_text_size: None,
                editor_vim_mode: None,
                label: None,
                last_backup_at: None,
                new_note_location: None,
                new_note_location_folder: None,
                paired_extensions: Vec::new(),
                right_panel_active_tab: None,
                right_panel_hidden_tabs: Vec::new(),
                right_panel_tab_order: Vec::new(),
                editor_slash_hidden: Vec::new(),
                editor_slash_order: Vec::new(),
                editor_toolbar_hidden: Vec::new(),
                editor_toolbar_order: Vec::new(),
                spell_enabled: None,
                spell_languages: Vec::new(),
                startup_open: None,
                startup_open_note: None,
                saved_views: Vec::new(),
                view_order: Vec::new(),
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

    // ---- label field (MYND-205) --------------------------------------

    #[test]
    fn encode_omits_label_when_none_byte_identical_to_pre_label() {
        // A vault that never set a label encodes byte-identically to the
        // single-field pre-MYND-205 form (migration-less additive field).
        let encoded = canonical_json_encode(&PrefsView::default());
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#,);
    }

    #[test]
    fn encode_places_label_between_item_order_and_screen_capture() {
        // Canonical key order: item_order (i) < label (l) < screen_capture (s).
        let encoded = canonical_json_encode(&PrefsView {
            item_order: BTreeMap::from([(
                alloc::string::String::from(""),
                alloc::vec![alloc::string::String::from("n1")],
            )]),
            label: Some(alloc::string::String::from("Work")),
            ..PrefsView::default()
        });
        assert_eq!(
            encoded.as_slice(),
            br#"{"item_order":{"":["n1"]},"label":"Work","screen_capture_protection":true}"#,
        );
    }

    // ---- icon field (vault-icons) ------------------------------------

    #[test]
    fn encode_omits_icon_when_none_byte_identical_to_pre_icon() {
        // A vault that never set an icon encodes byte-identically to the
        // single-field pre-feature form (migration-less additive field, the
        // `label` precedent class — existing golden vectors unaffected).
        let encoded = canonical_json_encode(&PrefsView {
            icon: None,
            ..PrefsView::default()
        });
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#,);
    }

    #[test]
    fn encode_places_icon_between_hidden_bar_items_and_item_colors() {
        // Canonical key order: hidden_bar_items (h) < icon (ico) < item_colors (ite).
        let encoded = canonical_json_encode(&PrefsView {
            hidden_bar_items: alloc::vec![alloc::string::String::from("graph")],
            icon: Some(alloc::string::String::from("book")),
            item_colors: map_of(&[("Projects/", "red")]),
            ..PrefsView::default()
        });
        assert_eq!(
            encoded.as_slice(),
            br#"{"hidden_bar_items":["graph"],"icon":"book","item_colors":{"Projects/":"red"},"screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn icon_round_trips_through_decode() {
        let original = PrefsView {
            icon: Some(alloc::string::String::from("briefcase")),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(decoded.icon, Some(alloc::string::String::from("briefcase")));
    }

    #[test]
    fn decode_absent_icon_is_none() {
        let decoded =
            canonical_json_decode(br#"{"screen_capture_protection":true}"#).expect("decode");
        assert_eq!(decoded.icon, None);
    }

    // ---- keymap (MYND-304 / 366) -------------------------------------------

    fn keymap_of(pairs: &[(&str, &[&str])]) -> BTreeMap<String, Vec<String>> {
        pairs
            .iter()
            .map(|(k, chords)| {
                (
                    alloc::string::String::from(*k),
                    chords
                        .iter()
                        .map(|c| alloc::string::String::from(*c))
                        .collect::<Vec<String>>(),
                )
            })
            .collect()
    }

    #[test]
    fn encode_places_keymap_between_item_order_and_label() {
        // Canonical key order: item_order (i) < keymap (k) < label (l).
        let encoded = canonical_json_encode(&PrefsView {
            item_order: BTreeMap::from([(
                alloc::string::String::from(""),
                alloc::vec![alloc::string::String::from("n1")],
            )]),
            keymap: keymap_of(&[("graph.show", &["Mod-Shift-g"])]),
            label: Some(alloc::string::String::from("Work")),
            ..PrefsView::default()
        });
        assert_eq!(
            encoded.as_slice(),
            br#"{"item_order":{"":["n1"]},"keymap":{"graph.show":["Mod-Shift-g"]},"label":"Work","screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn keymap_omitted_when_empty() {
        // An empty keymap produces NO key, so a vault that never rebound a
        // shortcut is byte-identical to a pre-MYND-304 vault.prefs.
        let encoded = canonical_json_encode(&PrefsView::default());
        assert!(find_subslice(&encoded, b"keymap").is_none());
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
    }

    #[test]
    fn keymap_round_trips_with_multi_binding_and_unbind() {
        // Three states in one value: an override (multi-binding), an
        // explicit-unbind (`[]`), and an absent command (not in the map).
        let original = PrefsView {
            keymap: keymap_of(&[
                ("app.command-palette", &["Mod-k", "Mod-p"]),
                ("vault.lock", &[]),
            ]),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(decoded.keymap, original.keymap);
        // The empty array is preserved verbatim (explicit-unbind, NOT dropped).
        assert_eq!(
            decoded.keymap.get("vault.lock"),
            Some(&Vec::<String>::new())
        );
        assert!(!decoded.keymap.contains_key("never.bound"));
    }

    #[test]
    fn keymap_chord_array_is_set_canonical() {
        // Chord arrays are NFC + sorted + exact-deduped (binding order does not
        // affect dispatch), and keys are emitted in lexicographic order.
        let encoded = canonical_json_encode(&PrefsView {
            keymap: keymap_of(&[
                ("z.cmd", &["Mod-z"]),
                ("a.cmd", &["Mod-z", "Mod-a", "Mod-z"]),
            ]),
            ..PrefsView::default()
        });
        assert_eq!(
            encoded.as_slice(),
            br#"{"keymap":{"a.cmd":["Mod-a","Mod-z"],"z.cmd":["Mod-z"]},"screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn keymap_empty_array_round_trips_distinct_from_absent() {
        let encoded = canonical_json_encode(&PrefsView {
            keymap: keymap_of(&[("vault.lock", &[])]),
            ..PrefsView::default()
        });
        assert_eq!(
            encoded.as_slice(),
            br#"{"keymap":{"vault.lock":[]},"screen_capture_protection":true}"#,
        );
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(
            decoded.keymap.get("vault.lock"),
            Some(&Vec::<String>::new())
        );
    }

    #[test]
    fn keymap_malformed_value_rejected() {
        // A value that is not a JSON array (a bare string) is a structural
        // malformation → PlaintextParseFailed (the chord set must be an array).
        let plaintext = br#"{"keymap":{"a.cmd":"Mod-a"},"screen_capture_protection":true}"#;
        assert!(matches!(
            canonical_json_decode(plaintext),
            Err(PrefsBlobError::PlaintextParseFailed)
        ));
    }

    #[test]
    fn label_round_trips_through_decode() {
        let original = PrefsView {
            label: Some(alloc::string::String::from("Personal")),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(decoded.label, Some(alloc::string::String::from("Personal")));
        // The rest of the view round-trips to defaults.
        assert_eq!(decoded, original);
    }

    #[test]
    fn encode_omits_typography_when_none_byte_identical_to_pre_feature() {
        // A vault that never customized editor typography encodes byte-
        // identically to the bare pre-feature form (migration-less additive
        // fields — existing golden vectors unaffected).
        let encoded = canonical_json_encode(&PrefsView::default());
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#,);
    }

    #[test]
    fn encode_places_typography_around_editor_layout() {
        // Canonical key order: editor_content_width < editor_font_family <
        // editor_layout < editor_line_numbers < editor_line_spacing <
        // editor_text_size (< favorites).
        let encoded = canonical_json_encode(&PrefsView {
            editor_content_width: Some(alloc::string::String::from("wide")),
            editor_font_family: Some(alloc::string::String::from("sans")),
            editor_layout: Some(sample_layout()),
            editor_line_numbers: Some(true),
            editor_line_spacing: Some(alloc::string::String::from("relaxed")),
            editor_text_size: Some(alloc::string::String::from("lg")),
            ..PrefsView::default()
        });
        let s = core::str::from_utf8(&encoded).unwrap();
        let cw = s.find("editor_content_width").unwrap();
        let ff = s.find("editor_font_family").unwrap();
        let el = s.find("editor_layout").unwrap();
        let ln = s.find("editor_line_numbers").unwrap();
        let ls = s.find("editor_line_spacing").unwrap();
        let ts = s.find("editor_text_size").unwrap();
        assert!(
            cw < ff && ff < el && el < ln && ln < ls && ls < ts,
            "canonical order: {s}"
        );
    }

    #[test]
    fn encode_omits_vim_mode_when_none_byte_identical_to_pre_feature() {
        // vim-keyboard-mode (MYND-313): a vault that never touched the vim toggle
        // must encode byte-identically to the pre-feature form, so every existing
        // golden vector stays valid (migration-less additive field on MYP1).
        let encoded = canonical_json_encode(&PrefsView {
            editor_vim_mode: None,
            ..PrefsView::default()
        });
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
    }

    #[test]
    fn encode_places_vim_mode_between_toolbar_order_and_favorites() {
        // Canonical key order: editor_text_size < editor_toolbar_hidden <
        // editor_toolbar_order < editor_vim_mode < favorites
        // (`editor_te` < `editor_to` < `editor_v` < `f`). Getting this wrong
        // breaks cross-implementation byte agreement, so it is pinned here.
        let encoded = canonical_json_encode(&PrefsView {
            editor_text_size: Some(alloc::string::String::from("lg")),
            editor_toolbar_hidden: alloc::vec![alloc::string::String::from("bold")],
            editor_toolbar_order: alloc::vec![alloc::string::String::from("italic")],
            editor_vim_mode: Some(true),
            favorites: alloc::vec![alloc::string::String::from(
                "0192f1a0-0000-7000-8000-000000000000"
            )],
            ..PrefsView::default()
        });
        let s = core::str::from_utf8(&encoded).unwrap();
        let ts = s.find("editor_text_size").unwrap();
        let th = s.find("editor_toolbar_hidden").unwrap();
        let to = s.find("editor_toolbar_order").unwrap();
        let vm = s.find("editor_vim_mode").unwrap();
        let fav = s.find("favorites").unwrap();
        assert!(
            ts < th && th < to && to < vm && vm < fav,
            "canonical order: {s}"
        );
    }

    #[test]
    fn vim_mode_round_trips_through_decode_both_values() {
        // Both explicit values must survive encode→decode. `Some(false)` is a
        // real state (the user turned vim off explicitly) and must NOT collapse
        // into `None` (never set) — the two are distinguishable on disk.
        for value in [true, false] {
            let original = PrefsView {
                editor_vim_mode: Some(value),
                ..PrefsView::default()
            };
            let encoded = canonical_json_encode(&original);
            let decoded = canonical_json_decode(&encoded).expect("decode");
            assert_eq!(decoded.editor_vim_mode, Some(value));
            assert_eq!(decoded, original);
        }
        // And absent stays absent.
        let decoded =
            canonical_json_decode(&canonical_json_encode(&PrefsView::default())).expect("decode");
        assert_eq!(decoded.editor_vim_mode, None);
    }

    #[test]
    fn files_panel_fields_round_trip_through_decode() {
        // MYND-462 — new_note_location(+folder) and startup_open(+note) round-trip
        // through a full encode/decode, both the mode-only and mode+target forms.
        let original = PrefsView {
            new_note_location: Some(alloc::string::String::from("specific")),
            new_note_location_folder: Some(alloc::string::String::from("Inbox/")),
            startup_open: Some(alloc::string::String::from("specific")),
            startup_open_note: Some(alloc::string::String::from(
                "0192f1a0-0000-7000-8000-000000000000",
            )),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(decoded, original);
    }

    #[test]
    fn files_panel_fields_omitted_when_none_byte_identical_to_pre_feature() {
        // A vault that never touched the Files-panel settings encodes byte-
        // identically to the bare pre-feature form (migration-less additive
        // fields — existing golden vectors unaffected).
        let encoded = canonical_json_encode(&PrefsView {
            new_note_location: None,
            new_note_location_folder: None,
            startup_open: None,
            startup_open_note: None,
            ..PrefsView::default()
        });
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
    }

    #[test]
    fn files_panel_fields_canonical_key_positions() {
        // new_note_location(+folder) sort after last_backup_at, before
        // paired_extensions (before screen_capture_protection); startup_open(+note)
        // sort after spell_languages, before theme (after screen_capture_protection).
        let prefs = PrefsView {
            last_backup_at: Some(42),
            new_note_location: Some(alloc::string::String::from("current")),
            new_note_location_folder: Some(alloc::string::String::from("Notes/")),
            spell_languages: alloc::vec![alloc::string::String::from("en-US")],
            startup_open: Some(alloc::string::String::from("empty")),
            startup_open_note: Some(alloc::string::String::from("x")),
            theme: Some(ThemeChoice::Dark),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&prefs);
        let s = core::str::from_utf8(&encoded).unwrap();
        let lba = s.find("last_backup_at").unwrap();
        let nnl = s.find("new_note_location\"").unwrap();
        let nnf = s.find("new_note_location_folder").unwrap();
        let scp = s.find("screen_capture_protection").unwrap();
        let spl = s.find("spell_languages").unwrap();
        let sto = s.find("startup_open\"").unwrap();
        let stn = s.find("startup_open_note").unwrap();
        let thm = s.find("theme").unwrap();
        assert!(lba < nnl && nnl < nnf && nnf < scp, "new_note_* order: {s}");
        assert!(
            scp < spl && spl < sto && sto < stn && stn < thm,
            "startup_* order: {s}"
        );
    }

    #[test]
    fn typography_round_trips_through_decode() {
        let original = PrefsView {
            editor_content_width: Some(alloc::string::String::from("narrow")),
            editor_font_family: Some(alloc::string::String::from("sans")),
            editor_line_spacing: Some(alloc::string::String::from("tight")),
            editor_text_size: Some(alloc::string::String::from("xl")),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(decoded, original);
    }

    // ---- myne#279: display date/time/timezone -----------------------------

    #[test]
    fn display_datetime_prefs_round_trip_through_decode() {
        let original = PrefsView {
            date_format: Some(alloc::string::String::from("dmy")),
            time_format: Some(alloc::string::String::from("24h")),
            timezone: Some(alloc::string::String::from("Europe/Berlin")),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(decoded, original);
    }

    #[test]
    fn encode_omits_display_datetime_prefs_when_none_byte_identical_to_pre_feature() {
        // A vault that never chose a display format encodes byte-identically to
        // the bare pre-feature form (migration-less additive fields — existing
        // golden vectors unaffected).
        let encoded = canonical_json_encode(&PrefsView {
            date_format: None,
            time_format: None,
            timezone: None,
            ..PrefsView::default()
        });
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
    }

    #[test]
    fn encode_places_date_format_between_daily_template_and_deliberate_folders() {
        // Canonical key order: daily_template (`dai`) < date_format (`dat`) <
        // deliberate_folders (`de`). The exact slot, not merely "somewhere".
        let encoded = canonical_json_encode(&PrefsView {
            daily_template: Some(alloc::string::String::from("t1")),
            date_format: Some(alloc::string::String::from("iso")),
            deliberate_folders: alloc::vec![alloc::string::String::from("A/")],
            ..PrefsView::default()
        });
        assert_eq!(
            encoded.as_slice(),
            br#"{"daily_template":"t1","date_format":"iso","deliberate_folders":["A/"],"screen_capture_protection":true}"#
        );
    }

    #[test]
    fn encode_places_time_fields_between_theme_and_transcription_enabled() {
        // Canonical key order: theme (`th`) < time_format (`ti`) < timezone
        // (`_` < `z`) < transcription_enabled (`ti` < `tr`).
        let encoded = canonical_json_encode(&PrefsView {
            theme: Some(ThemeChoice::Dark),
            time_format: Some(alloc::string::String::from("12h")),
            timezone: Some(alloc::string::String::from("Europe/Istanbul")),
            transcription_enabled: false,
            ..PrefsView::default()
        });
        assert_eq!(
            encoded.as_slice(),
            br#"{"screen_capture_protection":true,"theme":"dark","time_format":"12h","timezone":"Europe/Istanbul","transcription_enabled":false}"#
        );
    }

    #[test]
    fn display_datetime_prefs_survive_a_blob_round_trip() {
        let original = PrefsView {
            date_format: Some(alloc::string::String::from("mdy")),
            time_format: Some(alloc::string::String::from("12h")),
            timezone: Some(alloc::string::String::from("America/New_York")),
            ..PrefsView::default()
        };
        let key = [7u8; 32];
        let hash = [9u8; 16];
        let blob = encode_prefs_blob_raw(&key, &hash, &original, &[3u8; 24]).expect("encode");
        let decoded = decode_prefs_blob(&key, &hash, &blob).expect("decode");
        assert_eq!(decoded, original);
    }

    #[test]
    fn a_non_string_display_pref_decodes_to_none_rather_than_failing() {
        // Forward-compat, the `theme` / `editor_default_view_mode` discipline:
        // these are non-load-bearing display settings, so a value shape this
        // build does not understand means "unset", not "corrupt vault".
        let decoded = canonical_json_decode(
            br#"{"screen_capture_protection":true,"time_format":7,"timezone":null}"#,
        )
        .expect("decode");
        assert_eq!(decoded.time_format, None);
        assert_eq!(decoded.timezone, None);
    }

    #[test]
    fn encode_omits_editor_line_numbers_when_none_byte_identical_to_pre_feature() {
        // A vault that never touched the line-number gutter encodes byte-
        // identically to the bare pre-feature form (migration-less additive
        // field — existing golden vectors unaffected).
        let encoded = canonical_json_encode(&PrefsView {
            editor_line_numbers: None,
            ..PrefsView::default()
        });
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
    }

    #[test]
    fn encode_emits_editor_line_numbers_between_layout_and_line_spacing() {
        // Canonical key order: editor_layout < editor_line_numbers <
        // editor_line_spacing (`editor_la` < `editor_line_n` < `editor_line_s`).
        let on = canonical_json_encode(&PrefsView {
            editor_line_numbers: Some(true),
            ..PrefsView::default()
        });
        assert_eq!(
            on.as_slice(),
            br#"{"editor_line_numbers":true,"screen_capture_protection":true}"#,
        );
        // The non-default `false` is persisted explicitly (Some(false) != None).
        let off = canonical_json_encode(&PrefsView {
            editor_line_numbers: Some(false),
            ..PrefsView::default()
        });
        assert_eq!(
            off.as_slice(),
            br#"{"editor_line_numbers":false,"screen_capture_protection":true}"#,
        );
        // With editor_layout present, the new key sorts after it.
        let with_layout = canonical_json_encode(&PrefsView {
            editor_layout: Some(sample_layout()),
            editor_line_numbers: Some(true),
            editor_line_spacing: Some(alloc::string::String::from("relaxed")),
            ..PrefsView::default()
        });
        let s = core::str::from_utf8(&with_layout).unwrap();
        let el = s.find("editor_layout").unwrap();
        let ln = s.find("editor_line_numbers").unwrap();
        let ls = s.find("editor_line_spacing").unwrap();
        assert!(el < ln && ln < ls, "canonical order: {s}");
    }

    #[test]
    fn editor_line_numbers_round_trips_through_decode() {
        for value in [Some(true), Some(false), None] {
            let original = PrefsView {
                editor_line_numbers: value,
                ..PrefsView::default()
            };
            let encoded = canonical_json_encode(&original);
            let decoded = canonical_json_decode(&encoded).expect("decode");
            assert_eq!(decoded, original);
            assert_eq!(decoded.editor_line_numbers, value);
        }
    }

    // ---- ai_enabled / ai_excluded_folders (local-ai, MYND-408, SYNC-12/14) --

    #[test]
    fn encode_omits_ai_fields_when_default_byte_identical_to_pre_feature() {
        // A vault that never enabled AI (ai_enabled=false, ai_excluded_folders
        // empty — the defaults) encodes byte-identically to the bare pre-feature
        // form: both additive fields are omitted, so existing MYP1 golden vectors
        // are unaffected (SYNC-12/14 migration-less additive discipline).
        let encoded = canonical_json_encode(&PrefsView {
            ai_enabled: false,
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            ..PrefsView::default()
        });
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
    }

    #[test]
    fn encode_emits_ai_fields_in_canonical_position() {
        // Canonical key order: active_workspace < ai_enabled < ai_excluded_folders
        // < archive_disabled < auto_lock_seconds (`ac` < `ai_en` < `ai_ex` < `ar`
        // < `au`). ai_enabled emits only `true`; ai_excluded_folders is a sorted,
        // deduped, NFC set (mirrors deliberate_folders).
        let encoded = canonical_json_encode(&PrefsView {
            active_workspace: Some(alloc::string::String::from("ws-1")),
            ai_enabled: true,
            ai_excluded_folders: alloc::vec![
                alloc::string::String::from("Zeta/"),
                alloc::string::String::from("Alpha/"),
                alloc::string::String::from("Alpha/"),
            ],
            archive_disabled: Some(true),
            auto_lock_seconds: Some(300),
            ..PrefsView::default()
        });
        assert_eq!(
            encoded.as_slice(),
            br#"{"active_workspace":"ws-1","ai_enabled":true,"ai_excluded_folders":["Alpha/","Zeta/"],"archive_disabled":true,"auto_lock_seconds":300,"screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn ai_enabled_omitted_when_false_emitted_only_when_true() {
        let off = canonical_json_encode(&PrefsView {
            ai_enabled: false,
            ..PrefsView::default()
        });
        assert!(!core::str::from_utf8(&off).unwrap().contains("ai_enabled"));
        let on = canonical_json_encode(&PrefsView {
            ai_enabled: true,
            ..PrefsView::default()
        });
        assert_eq!(
            on.as_slice(),
            br#"{"ai_enabled":true,"screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn developer_mode_omitted_when_false_emitted_only_when_true() {
        let off = canonical_json_encode(&PrefsView {
            developer_mode: false,
            ..PrefsView::default()
        });
        assert!(!core::str::from_utf8(&off)
            .unwrap()
            .contains("developer_mode"));
        let on = canonical_json_encode(&PrefsView {
            developer_mode: true,
            ..PrefsView::default()
        });
        assert_eq!(
            on.as_slice(),
            br#"{"developer_mode":true,"screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn developer_mode_canonical_position_between_deliberate_folders_and_device_names() {
        let encoded = canonical_json_encode(&PrefsView {
            deliberate_folders: alloc::vec![alloc::string::String::from("A/")],
            developer_mode: true,
            device_names: map_of(&[("d1", "Mac")]),
            ..PrefsView::default()
        });
        assert_eq!(
            encoded.as_slice(),
            br#"{"deliberate_folders":["A/"],"developer_mode":true,"device_names":{"d1":"Mac"},"screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn developer_mode_round_trips_through_decode_both_values() {
        for value in [true, false] {
            let original = PrefsView {
                developer_mode: value,
                ..PrefsView::default()
            };
            let encoded = canonical_json_encode(&original);
            let decoded = canonical_json_decode(&encoded).expect("decode must succeed");
            assert_eq!(decoded.developer_mode, value);
        }
    }

    #[test]
    fn developer_mode_absent_decodes_to_false() {
        let decoded =
            canonical_json_decode(br#"{"screen_capture_protection":true}"#).expect("decode ok");
        assert!(!decoded.developer_mode);
    }

    /// Cross-branch guard for the develop↔cli-thin-client merge: `cli_*`
    /// (between `bar_items_order` and `custom_theme`) and `developer_mode`
    /// (after `deliberate_folders`) landed on develop and the CLI branch
    /// independently, both auto-merging into the canonical order with no git
    /// conflict. The encoder and the decoder each walk keys once through a
    /// monotonic forward cursor, so a mis-ordered insertion fails *silently* —
    /// the decoder steps past the out-of-order key and reports it absent
    /// (defaulted), never an error. Setting a non-default value in every field
    /// touched by BOTH sides and asserting each survives a full round-trip is
    /// the only thing that catches that: neither branch's own suite exercises
    /// the pair together.
    #[test]
    fn cli_and_develop_prefs_fields_round_trip_together() {
        let original = PrefsView {
            bar_items_order: alloc::vec![alloc::string::String::from("view-mode")], // cli_enabled's left neighbour
            cli_enabled: true,
            cli_excluded_folders: alloc::vec![alloc::string::String::from("Private/")],
            cli_rate_limit_disabled: Some(true),
            developer_mode: true,
            show_task_marker: false, // default true → emitted only when false
            time_format: None,
            timezone: None,
            transcription_enabled: false, // default true → emitted only when false
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);

        // The bytes must be in canonical key order across both branches' fields;
        // a positional decode depends on it.
        let text = core::str::from_utf8(&encoded).expect("utf-8");
        let pos = |k: &str| text.find(k).unwrap_or_else(|| panic!("missing key {k}"));
        assert!(pos("\"bar_items_order\"") < pos("\"cli_enabled\""));
        assert!(pos("\"cli_enabled\"") < pos("\"cli_excluded_folders\""));
        assert!(pos("\"cli_excluded_folders\"") < pos("\"cli_rate_limit_disabled\""));
        assert!(pos("\"cli_rate_limit_disabled\"") < pos("\"developer_mode\""));
        assert!(pos("\"developer_mode\"") < pos("\"show_task_marker\""));
        assert!(pos("\"show_task_marker\"") < pos("\"transcription_enabled\""));

        let decoded = canonical_json_decode(&encoded).expect("decode must succeed");
        assert!(decoded.cli_enabled);
        assert_eq!(decoded.cli_excluded_folders, original.cli_excluded_folders);
        assert_eq!(decoded.cli_rate_limit_disabled, Some(true));
        assert!(decoded.developer_mode);
        assert!(!decoded.show_task_marker);
        assert!(!decoded.transcription_enabled);
    }

    /// `auto_tag_enabled` (MYND-651) is a default-off positive opt-in, so it is
    /// emitted ONLY when `true` — the `ai_enabled` / `cli_enabled` discipline.
    /// A vault that never enabled it therefore stays byte-identical to a
    /// pre-feature blob, which is what preserves the existing KAT vectors.
    #[test]
    fn auto_tag_enabled_omitted_when_false_emitted_only_when_true() {
        let off = canonical_json_encode(&PrefsView {
            auto_tag_enabled: false,
            ..PrefsView::default()
        });
        assert!(
            !core::str::from_utf8(&off)
                .unwrap()
                .contains("auto_tag_enabled"),
            "the default must not be written"
        );
        assert_eq!(off, canonical_json_encode(&PrefsView::default()));

        let on = canonical_json_encode(&PrefsView {
            auto_tag_enabled: true,
            ..PrefsView::default()
        });
        assert!(core::str::from_utf8(&on)
            .unwrap()
            .contains(r#""auto_tag_enabled":true"#));
    }

    /// The positional-decode guard for the new key. `auto_tag_enabled` sits at
    /// the boundary between the `strip_prefix`-chained prefix fields and the
    /// cursor-located ones (`auto_lock_seconds` < `auto_tag_enabled` <
    /// `bar_items_order`), and a mis-ordered insertion there fails *silently* —
    /// the decoder steps past the out-of-order key and reports it absent
    /// (defaulted), never an error. Setting a non-default value in both
    /// neighbours and asserting all three survive one round-trip is the only
    /// thing that catches it.
    #[test]
    fn auto_tag_enabled_round_trips_between_its_canonical_neighbours() {
        let original = PrefsView {
            auto_lock_seconds: Some(300), // left neighbour
            auto_tag_enabled: true,
            bar_items_order: alloc::vec![alloc::string::String::from("view-mode")], // right neighbour
            ai_enabled: true, // the flag the tag pass is co-gated on
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);

        let text = core::str::from_utf8(&encoded).expect("utf-8");
        let pos = |k: &str| text.find(k).unwrap_or_else(|| panic!("missing key {k}"));
        assert!(pos("\"ai_enabled\"") < pos("\"auto_lock_seconds\""));
        assert!(pos("\"auto_lock_seconds\"") < pos("\"auto_tag_enabled\""));
        assert!(pos("\"auto_tag_enabled\"") < pos("\"bar_items_order\""));

        let decoded = canonical_json_decode(&encoded).expect("decode must succeed");
        assert!(decoded.auto_tag_enabled);
        assert_eq!(decoded.auto_lock_seconds, Some(300));
        assert_eq!(decoded.bar_items_order, original.bar_items_order);
        assert!(decoded.ai_enabled);
    }

    /// A pre-MYND-651 blob decodes with the feature off — the fall-back a
    /// decoder that does not find the key MUST apply (spec § 9.5.2).
    #[test]
    fn auto_tag_enabled_absent_decodes_to_false() {
        let decoded =
            canonical_json_decode(br#"{"screen_capture_protection":true}"#).expect("decode ok");
        assert!(!decoded.auto_tag_enabled);
    }

    /// The inverse of the `ai_enabled` rule, because this pref defaults to TRUE:
    /// it is emitted only when the user turned it OFF. A vault that never
    /// touched the toggle therefore stays byte-identical to a pre-MYND-441
    /// blob, which is what preserves the existing KAT vectors.
    #[test]
    fn attachment_ocr_omitted_when_true_emitted_only_when_false() {
        let on = canonical_json_encode(&PrefsView {
            attachment_ocr_enabled: true,
            ..PrefsView::default()
        });
        assert!(
            !core::str::from_utf8(&on)
                .unwrap()
                .contains("attachment_ocr_enabled"),
            "the default must not be written"
        );
        let off = canonical_json_encode(&PrefsView {
            attachment_ocr_enabled: false,
            ..PrefsView::default()
        });
        assert_eq!(
            off.as_slice(),
            br#"{"attachment_ocr_enabled":false,"screen_capture_protection":true}"#,
        );
    }

    /// **The backward-compatibility assertion that matters.** Every vault in
    /// existence has a prefs blob written before this field existed. Decoding
    /// one must yield the feature ON — a bare `#[serde(default)]` would have
    /// yielded `false` and silently disabled OCR for every existing user.
    #[test]
    fn a_prefs_blob_predating_the_field_decodes_with_ocr_enabled() {
        let pre_feature = br#"{"screen_capture_protection":true}"#;
        let parsed = canonical_json_decode(pre_feature).expect("decodes");
        assert!(
            parsed.attachment_ocr_enabled,
            "an older blob must decode with OCR ON, not off"
        );
    }

    /// Round-trip in the non-default direction, including the canonical key
    /// position (after `archived_folders`, before `auto_lock_seconds`).
    #[test]
    fn attachment_ocr_false_round_trips_in_canonical_position() {
        let src = PrefsView {
            attachment_ocr_enabled: false,
            archived_folders: alloc::vec!["Ops/".into()],
            auto_lock_seconds: Some(300),
            ..PrefsView::default()
        };
        let bytes = canonical_json_encode(&src);
        let text = core::str::from_utf8(&bytes).unwrap();
        let i_arch = text
            .find("archived_folders")
            .expect("archived_folders present");
        let i_ocr = text
            .find("attachment_ocr_enabled")
            .expect("attachment_ocr_enabled present");
        let i_auto = text
            .find("auto_lock_seconds")
            .expect("auto_lock_seconds present");
        assert!(
            i_arch < i_ocr && i_ocr < i_auto,
            "canonical key order violated: {text}"
        );
        let back = canonical_json_decode(&bytes).expect("decodes");
        assert!(!back.attachment_ocr_enabled);
        assert_eq!(back.auto_lock_seconds, Some(300));
        assert_eq!(
            back.archived_folders,
            alloc::vec![alloc::string::String::from("Ops/")]
        );
    }

    /// The inverse of the `ai_enabled` rule, same shape as
    /// `attachment_ocr_enabled`'s coverage: it is emitted only when the user
    /// turned it OFF. A vault that never touched the toggle therefore stays
    /// byte-identical to a pre-feature blob, which is what preserves the
    /// existing KAT vectors.
    #[test]
    fn attachment_compression_omitted_when_true_emitted_only_when_false() {
        let on = canonical_json_encode(&PrefsView {
            attachment_compression_enabled: true,
            ..PrefsView::default()
        });
        assert!(
            !core::str::from_utf8(&on)
                .unwrap()
                .contains("attachment_compression_enabled"),
            "the default must not be written"
        );
        let off = canonical_json_encode(&PrefsView {
            attachment_compression_enabled: false,
            ..PrefsView::default()
        });
        assert_eq!(
            off.as_slice(),
            br#"{"attachment_compression_enabled":false,"screen_capture_protection":true}"#,
        );
    }

    /// **The backward-compatibility assertion that matters.** Every vault in
    /// existence has a prefs blob written before this field existed. Decoding
    /// one must yield the feature ON — a bare `#[serde(default)]` would have
    /// yielded `false` and silently disabled compression for every existing
    /// user.
    #[test]
    fn a_prefs_blob_predating_the_field_decodes_with_compression_enabled() {
        let pre_feature = br#"{"screen_capture_protection":true}"#;
        let parsed = canonical_json_decode(pre_feature).expect("decodes");
        assert!(
            parsed.attachment_compression_enabled,
            "an older blob must decode with compression ON, not off"
        );
    }

    /// Round-trip in the non-default direction, including the canonical key
    /// position (after `archived_folders`, before `attachment_ocr_enabled`).
    #[test]
    fn attachment_compression_false_round_trips_in_canonical_position() {
        let src = PrefsView {
            attachment_compression_enabled: false,
            archived_folders: alloc::vec!["Ops/".into()],
            attachment_ocr_enabled: false,
            ..PrefsView::default()
        };
        let bytes = canonical_json_encode(&src);
        let text = core::str::from_utf8(&bytes).unwrap();
        let i_arch = text
            .find("archived_folders")
            .expect("archived_folders present");
        let i_compress = text
            .find("attachment_compression_enabled")
            .expect("attachment_compression_enabled present");
        let i_ocr = text
            .find("attachment_ocr_enabled")
            .expect("attachment_ocr_enabled present");
        assert!(
            i_arch < i_compress && i_compress < i_ocr,
            "canonical key order violated: {text}"
        );
        let back = canonical_json_decode(&bytes).expect("decodes");
        assert!(!back.attachment_compression_enabled);
        assert!(!back.attachment_ocr_enabled);
        assert_eq!(
            back.archived_folders,
            alloc::vec![alloc::string::String::from("Ops/")]
        );
    }

    #[test]
    fn ai_excluded_folders_omitted_when_empty_present_when_set() {
        let empty = canonical_json_encode(&PrefsView {
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            ..PrefsView::default()
        });
        assert!(!core::str::from_utf8(&empty)
            .unwrap()
            .contains("ai_excluded_folders"));
        let set = canonical_json_encode(&PrefsView {
            ai_excluded_folders: alloc::vec![alloc::string::String::from("Secret/")],
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            ..PrefsView::default()
        });
        assert_eq!(
            set.as_slice(),
            br#"{"ai_excluded_folders":["Secret/"],"screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn ai_fields_round_trip_through_decode() {
        // Already-canonical (sorted) input → decode reproduces the original.
        let original = PrefsView {
            ai_enabled: true,
            ai_excluded_folders: alloc::vec![
                alloc::string::String::from("Alpha/"),
                alloc::string::String::from("Beta/"),
            ],
            active_workspace: Some(alloc::string::String::from("ws-2")),
            archive_disabled: Some(false),
            auto_lock_seconds: Some(900),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(decoded, original);
    }

    #[test]
    fn ai_fields_default_off_empty_when_absent_on_decode() {
        // A pre-feature blob (no ai keys) decodes to the defaults (off / empty),
        // spec § 9.5.2 forward-compat fall-back.
        let decoded =
            canonical_json_decode(br#"{"screen_capture_protection":true}"#).expect("decode");
        assert!(!decoded.ai_enabled);
        assert!(decoded.ai_excluded_folders.is_empty());
    }

    // ---- archived_folders (folder-archive) -----------------------------

    #[test]
    fn archived_folders_omitted_when_empty_present_when_set() {
        let empty = canonical_json_encode(&PrefsView {
            archived_folders: Vec::new(),
            ..PrefsView::default()
        });
        assert!(!core::str::from_utf8(&empty)
            .unwrap()
            .contains("archived_folders"));
        let set = canonical_json_encode(&PrefsView {
            archived_folders: alloc::vec![alloc::string::String::from("Projects/")],
            ..PrefsView::default()
        });
        assert_eq!(
            set.as_slice(),
            br#"{"archived_folders":["Projects/"],"screen_capture_protection":true}"#,
        );
    }

    /// The remote-provider quartet sits between `ai_excluded_folders` and
    /// `archive_disabled`, and the parser is POSITIONAL — a field placed wrong
    /// round-trips wrong. Both lexicographic neighbours are named and asserted
    /// by position, per the `auto_tag_enabled` precedent above.
    #[test]
    fn ai_provider_quartet_encodes_between_ai_excluded_folders_and_archive_disabled() {
        let encoded = canonical_json_encode(&PrefsView {
            ai_excluded_folders: alloc::vec![alloc::string::String::from("Private/")],
            ai_provider: Some(alloc::string::String::from("openrouter")),
            ai_provider_consent: Some(alloc::string::String::from("openrouter")),
            ai_provider_key: Some(Zeroizing::new(alloc::string::String::from(
                "sk-sentinel-000",
            ))),
            ai_provider_model: Some(alloc::string::String::from("meta-llama/llama-3.1-8b")),
            archive_disabled: Some(true),
            ..PrefsView::default()
        });
        let text = core::str::from_utf8(&encoded).unwrap();
        let pos = |k: &str| text.find(k).unwrap_or_else(|| panic!("missing {k}"));
        // ai_excluded_folders < ai_provider < ai_provider_consent <
        // ai_provider_key < ai_provider_model < archive_disabled.
        assert!(pos("\"ai_excluded_folders\"") < pos("\"ai_provider\""));
        assert!(pos("\"ai_provider\"") < pos("\"ai_provider_consent\""));
        assert!(pos("\"ai_provider_consent\"") < pos("\"ai_provider_key\""));
        assert!(pos("\"ai_provider_key\"") < pos("\"ai_provider_model\""));
        assert!(pos("\"ai_provider_model\"") < pos("\"archive_disabled\""));
        // And it round-trips through the positional parser.
        let back = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(back.ai_provider.as_deref(), Some("openrouter"));
        assert_eq!(back.ai_provider_consent.as_deref(), Some("openrouter"));
        assert_eq!(
            back.ai_provider_key.as_deref().map(|k| k.as_str()),
            Some("sk-sentinel-000")
        );
        assert_eq!(
            back.ai_provider_model.as_deref(),
            Some("meta-llama/llama-3.1-8b")
        );
        assert_eq!(back.archive_disabled, Some(true));
    }

    /// The model is the one member of the quartet that is BOTH persisted and
    /// allowed across IPC — the panel renders the current selection back, and a
    /// published model name is not a credential. Its own test because the
    /// nearest field in the file (`ai_provider_key`) is the exact opposite, and
    /// a future `skip_serializing` copied one field too far would leave the
    /// chooser rendering blank with nothing failing.
    #[test]
    fn the_chosen_model_crosses_ipc_unlike_the_key_beside_it() {
        const MODEL: &str = "qwen/qwen3-30b";
        let view = PrefsView {
            ai_provider: Some(alloc::string::String::from("openrouter")),
            ai_provider_key: Some(Zeroizing::new(alloc::string::String::from(
                "sk-not-this-one",
            ))),
            ai_provider_model: Some(alloc::string::String::from(MODEL)),
            ..PrefsView::default()
        };
        let json = serde_json::to_string(&view).expect("serialize");
        assert!(
            json.contains(MODEL),
            "the chosen model must reach the panel"
        );
        assert!(!json.contains("sk-not-this-one"), "the key VALUE leaked");
    }

    /// A model chosen without a provider is a state the UI cannot produce, but
    /// the codec must not corrupt it: the positional parser has to skip the
    /// three absent siblings and still find the model.
    ///
    /// It does NOT catch a chain wired to the wrong `post_*` variable, though
    /// an earlier revision of this comment claimed it did. Every field AFTER
    /// the model is absent here too, so nothing ever consumes the cursor the
    /// wrong branch would have poisoned. The test below is the one that
    /// consumes it.
    #[test]
    fn the_model_round_trips_with_every_sibling_absent() {
        let encoded = canonical_json_encode(&PrefsView {
            ai_provider_model: Some(alloc::string::String::from("solo")),
            ..PrefsView::default()
        });
        assert_eq!(
            core::str::from_utf8(&encoded).unwrap(),
            r#"{"ai_provider_model":"solo","screen_capture_protection":true}"#,
        );
        let back = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(back.ai_provider_model.as_deref(), Some("solo"));
        assert_eq!(back.ai_provider, None);
    }

    /// The shape the test above cannot reach: the model present WITH fields
    /// after it also present. `archive_disabled` is `Option<bool>` and is
    /// omitted unless the user touched the archive toggle, so this is the
    /// ordinary state of any vault whose owner named a provider — and it is
    /// exactly where a `None =>` arm wired to the wrong `post_*` bites.
    ///
    /// The four fields after `archive_disabled` are located by `strip_prefix`,
    /// not by `find_top_level_marker`, so a cursor that rewinds BEHIND
    /// `ai_provider_model` makes every one of them miss its marker and take
    /// its absent-branch default. Silently: the decode still returns `Ok`.
    #[test]
    fn the_model_does_not_swallow_the_preferences_that_follow_it() {
        let original = PrefsView {
            ai_provider_model: Some(alloc::string::String::from("meta-llama/llama-3.1-8b")),
            archive_disabled: None,
            archived_folders: alloc::vec![alloc::string::String::from("Old/")],
            attachment_compression_enabled: false,
            attachment_ocr_enabled: false,
            auto_lock_seconds: Some(900),
            ..PrefsView::default()
        };
        let back = canonical_json_decode(&canonical_json_encode(&original)).expect("decode");

        // `auto_lock_seconds` first: losing it silently shortens the vault's
        // protective envelope to DEFAULT_AUTO_LOCK_SECS without the user
        // asking, which is a security setting changing itself.
        assert_eq!(back.auto_lock_seconds, Some(900), "auto-lock was reset");
        assert!(
            !back.attachment_ocr_enabled,
            "an OCR opt-out flipped back on"
        );
        assert!(!back.attachment_compression_enabled);
        assert_eq!(back.archived_folders, original.archived_folders);
        assert_eq!(
            back.ai_provider_model.as_deref(),
            Some("meta-llama/llama-3.1-8b"),
        );
    }

    /// The DEFAULT STATE leaves no trace in the blob. A vault that never named
    /// a provider must encode byte-identically to a pre-feature `vault.prefs`,
    /// which is what keeps every existing KAT vector valid — and, separately,
    /// what stops the blob from carrying an at-rest "this user configured AI"
    /// fingerprint.
    #[test]
    fn the_ai_provider_triple_is_omitted_entirely_when_unset() {
        let empty = canonical_json_encode(&PrefsView::default());
        let text = core::str::from_utf8(&empty).unwrap();
        assert!(!text.contains("ai_provider"), "got: {text}");
        // The pre-feature baseline: `PrefsView::default()` encodes to exactly
        // the mandatory trailing field and nothing else.
        assert_eq!(text, r#"{"screen_capture_protection":true}"#);
    }

    /// The credential's buffer wipes when it drops (myne-md/myne#444).
    ///
    /// Asserted at COMPILE time, not by inspecting freed memory. Reading a
    /// dropped allocation is undefined behaviour, so a runtime "the bytes are
    /// gone" test would be either unsound or — more likely — a test of what the
    /// allocator happened to do on one machine, which is the shape of assertion
    /// that passes forever and means nothing. The property here is entirely
    /// carried by the type: `Zeroizing<T>` wipes in its `Drop`, so pinning the
    /// field's type pins the behaviour.
    ///
    /// What this catches is the realistic regression: someone adding a prefs
    /// field, copying the line above it, and quietly widening the type back to
    /// `String` because that is what every sibling is.
    #[test]
    fn the_provider_key_field_is_zeroizing_rather_than_a_plain_string() {
        let view = PrefsView {
            ai_provider_key: Some(Zeroizing::new(alloc::string::String::from("sk-x"))),
            ..PrefsView::default()
        };
        // Compiles only while the field is `Option<Zeroizing<String>>`: a plain
        // `String` fails to coerce, and a different wrapper is a different type.
        let _pinned: Option<Zeroizing<alloc::string::String>> = view.ai_provider_key.clone();

        // …and the wrapper is transparent to the codec, so the on-disk bytes are
        // unchanged by the hardening. A format change here would be a silent
        // cross-implementation break — every other client holds a plain string.
        let plain = PrefsView {
            ai_provider_key: None,
            ..PrefsView::default()
        };
        let with_key = canonical_json_encode(&view);
        assert!(
            with_key
                .windows(b"\"ai_provider_key\":\"sk-x\"".len())
                .any(|w| w == b"\"ai_provider_key\":\"sk-x\""),
            "the wrapper must not change the emitted bytes: {}",
            alloc::string::String::from_utf8_lossy(&with_key)
        );
        assert!(!canonical_json_encode(&plain)
            .windows(4)
            .any(|w| w == b"sk-x"));
    }

    /// **The IPC confinement.** `prefs_read` serializes the whole `PrefsView`
    /// to the WebView, so a key without `#[serde(skip_serializing)]` reaches
    /// page context on every read. The twin of
    /// `prefs_view_serde_serialization_omits_token_value`: the key survives the
    /// BLOB round trip (it is encrypted vault content) and is absent from the
    /// IPC JSON — both the field NAME and a sentinel VALUE, because asserting
    /// only the name would pass against a rename.
    #[test]
    fn the_provider_key_round_trips_on_disk_and_never_reaches_the_ipc_json() {
        const SENTINEL: &str = "sk-do-not-let-this-cross-ipc";
        let view = PrefsView {
            ai_provider: Some(alloc::string::String::from("openrouter")),
            ai_provider_consent: Some(alloc::string::String::from("openrouter")),
            ai_provider_key: Some(Zeroizing::new(alloc::string::String::from(SENTINEL))),
            ai_provider_model: None,
            ..PrefsView::default()
        };

        // On disk: present, and it comes back.
        let blob = canonical_json_encode(&view);
        let back = canonical_json_decode(&blob).expect("decode");
        assert_eq!(
            back.ai_provider_key.as_deref().map(|k| k.as_str()),
            Some(SENTINEL)
        );

        // Across IPC: absent, by name AND by value.
        let json = serde_json::to_string(&view).expect("serialize");
        assert!(!json.contains("ai_provider_key"), "field name leaked");
        assert!(!json.contains(SENTINEL), "the key VALUE leaked");
        // The two siblings DO cross — the UI needs to render which provider is
        // selected and whether consent was given. Asserting this is what makes
        // the absence above a targeted skip rather than a serialization that
        // silently dropped the whole group.
        assert!(json.contains("ai_provider"), "the selection must cross");
        assert!(json.contains("ai_provider_consent"), "consent must cross");
    }

    #[test]
    fn archived_folders_encode_sorts_dedupes_between_archive_disabled_and_auto_lock() {
        // Canonical key order: archive_disabled < archived_folders <
        // auto_lock_seconds (`archive_` `_`=0x5F < `archived` `d`=0x64; `ar` < `au`).
        // The set is NFC-sorted + exact-deduped like deliberate_folders.
        let encoded = canonical_json_encode(&PrefsView {
            archive_disabled: Some(true),
            archived_folders: alloc::vec![
                alloc::string::String::from("Zeta/"),
                alloc::string::String::from("Alpha/"),
                alloc::string::String::from("Alpha/"),
            ],
            auto_lock_seconds: Some(300),
            ..PrefsView::default()
        });
        assert_eq!(
            encoded.as_slice(),
            br#"{"archive_disabled":true,"archived_folders":["Alpha/","Zeta/"],"auto_lock_seconds":300,"screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn archived_folders_round_trip_through_decode() {
        // Already-canonical (sorted) input → decode reproduces the original,
        // alongside the neighbors that bracket it in canonical order.
        let original = PrefsView {
            archive_disabled: Some(false),
            archived_folders: alloc::vec![
                alloc::string::String::from("Archive/"),
                alloc::string::String::from("Projects/"),
            ],
            auto_lock_seconds: Some(900),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(decoded, original);
    }

    #[test]
    fn archived_folders_default_empty_when_absent_on_decode() {
        // A pre-feature blob (no archived_folders key) decodes to the empty
        // default, spec § 9.5.2 forward-compat fall-back.
        let decoded =
            canonical_json_decode(br#"{"screen_capture_protection":true}"#).expect("decode");
        assert!(decoded.archived_folders.is_empty());
    }

    // ---- archive_disabled (archive-disable, MYND-…) --------------------

    #[test]
    fn encode_omits_archive_disabled_when_none_byte_identical_to_pre_feature() {
        // A vault that never touched the archive toggle encodes byte-identically
        // to the bare pre-feature form (migration-less additive field — existing
        // golden vectors unaffected).
        let encoded = canonical_json_encode(&PrefsView {
            archive_disabled: None,
            ..PrefsView::default()
        });
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
    }

    #[test]
    fn encode_emits_archive_disabled_between_active_workspace_and_auto_lock() {
        // Canonical key order: active_workspace < archive_disabled <
        // auto_lock_seconds (`ac` < `ar` < `au`).
        let on = canonical_json_encode(&PrefsView {
            archive_disabled: Some(true),
            ..PrefsView::default()
        });
        assert_eq!(
            on.as_slice(),
            br#"{"archive_disabled":true,"screen_capture_protection":true}"#,
        );
        // The non-default `false` is persisted explicitly (Some(false) != None).
        let off = canonical_json_encode(&PrefsView {
            archive_disabled: Some(false),
            ..PrefsView::default()
        });
        assert_eq!(
            off.as_slice(),
            br#"{"archive_disabled":false,"screen_capture_protection":true}"#,
        );
        // With active_workspace + auto_lock_seconds present, the new key sorts
        // strictly between them.
        let with_neighbors = canonical_json_encode(&PrefsView {
            active_workspace: Some(alloc::string::String::from("ws-1")),
            archive_disabled: Some(true),
            auto_lock_seconds: Some(300),
            ..PrefsView::default()
        });
        let s = core::str::from_utf8(&with_neighbors).unwrap();
        let aw = s.find("active_workspace").unwrap();
        let ar = s.find("archive_disabled").unwrap();
        let al = s.find("auto_lock_seconds").unwrap();
        assert!(aw < ar && ar < al, "canonical order: {s}");
    }

    #[test]
    fn archive_disabled_round_trips_through_decode() {
        for value in [Some(true), Some(false), None] {
            let original = PrefsView {
                archive_disabled: value,
                ..PrefsView::default()
            };
            let encoded = canonical_json_encode(&original);
            let decoded = canonical_json_decode(&encoded).expect("decode");
            assert_eq!(decoded, original);
            assert_eq!(decoded.archive_disabled, value);
        }
    }

    #[test]
    fn archive_disabled_round_trips_alongside_neighbors() {
        // Exercise the strip_prefix decode path with both canonical neighbors
        // present, so a regression in the post_active → post_archive threading
        // (e.g. auto_lock_seconds stripping from the wrong slice) is caught.
        let original = PrefsView {
            active_workspace: Some(alloc::string::String::from("ws-1")),
            archive_disabled: Some(true),
            auto_lock_seconds: Some(300),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(decoded, original);
    }

    // ---- active_workspace (MYND-308) -----------------------------------

    #[test]
    fn encode_omits_active_workspace_when_none_byte_identical_to_pre_feature() {
        // A vault that never set an active workspace encodes byte-identically to
        // the bare pre-feature form (migration-less additive field).
        let encoded = canonical_json_encode(&PrefsView {
            active_workspace: None,
            ..PrefsView::default()
        });
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
    }

    #[test]
    fn encode_emits_active_workspace_first_before_auto_lock_seconds() {
        // Canonical key order: active_workspace < auto_lock_seconds ("ac" < "au").
        let encoded = canonical_json_encode(&PrefsView {
            active_workspace: Some(alloc::string::String::from("ws-1")),
            ..PrefsView::default()
        });
        assert_eq!(
            encoded.as_slice(),
            br#"{"active_workspace":"ws-1","screen_capture_protection":true}"#,
        );
        // With auto_lock_seconds present, active_workspace still sorts first.
        let with_auto = canonical_json_encode(&PrefsView {
            active_workspace: Some(alloc::string::String::from("ws-1")),
            auto_lock_seconds: Some(300),
            ..PrefsView::default()
        });
        let s = core::str::from_utf8(&with_auto).unwrap();
        let aw = s.find("active_workspace").unwrap();
        let al = s.find("auto_lock_seconds").unwrap();
        assert!(aw < al, "canonical order: {s}");
    }

    #[test]
    fn active_workspace_is_nfc_normalized_on_encode() {
        // "é" as NFD (e + combining acute) normalizes to NFC single codepoint.
        let nfd = alloc::string::String::from("ws-Cafe\u{0301}");
        let encoded = canonical_json_encode(&PrefsView {
            active_workspace: Some(nfd),
            ..PrefsView::default()
        });
        assert_eq!(
            encoded.as_slice(),
            "{\"active_workspace\":\"ws-Café\",\"screen_capture_protection\":true}".as_bytes(),
        );
    }

    #[test]
    fn active_workspace_round_trips_through_decode() {
        for value in [Some(alloc::string::String::from("ws-1")), None] {
            let original = PrefsView {
                active_workspace: value.clone(),
                ..PrefsView::default()
            };
            let encoded = canonical_json_encode(&original);
            let decoded = canonical_json_decode(&encoded).expect("decode");
            assert_eq!(decoded, original);
            assert_eq!(decoded.active_workspace, value);
        }
        // Round-trips alongside auto_lock_seconds (active_workspace canonically
        // first; auto_lock_seconds is the strip_prefix-matched second field).
        let original = PrefsView {
            active_workspace: Some(alloc::string::String::from("ws-7")),
            auto_lock_seconds: Some(900),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(decoded, original);
    }

    // ---- editor focus + default-view-mode (MYND-299 / MYND-348) --------

    #[test]
    fn encode_omits_editor_batch_fields_when_none_byte_identical_to_pre_feature() {
        // A vault that never touched the batch editor fields encodes byte-
        // identically to the bare pre-feature form (migration-less additive
        // fields — existing golden vectors unaffected).
        let encoded = canonical_json_encode(&PrefsView {
            editor_default_view_mode: None,
            editor_focus_dim_inactive: None,
            editor_focus_typewriter: None,
            ..PrefsView::default()
        });
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
    }

    #[test]
    fn encode_places_editor_batch_fields_in_canonical_order() {
        // Canonical editor_* order: editor_content_width <
        // editor_default_view_mode < editor_focus_dim_inactive <
        // editor_focus_typewriter < editor_font_family.
        let encoded = canonical_json_encode(&PrefsView {
            editor_content_width: Some(alloc::string::String::from("wide")),
            editor_default_view_mode: Some(alloc::string::String::from("reading")),
            editor_focus_dim_inactive: Some(true),
            editor_focus_typewriter: Some(false),
            editor_font_family: Some(alloc::string::String::from("sans")),
            ..PrefsView::default()
        });
        let s = core::str::from_utf8(&encoded).unwrap();
        let cw = s.find("editor_content_width").unwrap();
        let dvm = s.find("editor_default_view_mode").unwrap();
        let di = s.find("editor_focus_dim_inactive").unwrap();
        let tw = s.find("editor_focus_typewriter").unwrap();
        let ff = s.find("editor_font_family").unwrap();
        assert!(
            cw < dvm && dvm < di && di < tw && tw < ff,
            "canonical order: {s}"
        );
        // Bools encode as bare true/false; the string view-mode as a JSON string.
        assert_eq!(
            encoded.as_slice(),
            br#"{"editor_content_width":"wide","editor_default_view_mode":"reading","editor_focus_dim_inactive":true,"editor_focus_typewriter":false,"editor_font_family":"sans","screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn editor_default_view_mode_is_nfc_normalized_on_encode() {
        let nfd = alloc::string::String::from("Cafe\u{0301}");
        let encoded = canonical_json_encode(&PrefsView {
            editor_default_view_mode: Some(nfd),
            ..PrefsView::default()
        });
        assert_eq!(
            encoded.as_slice(),
            "{\"editor_default_view_mode\":\"Café\",\"screen_capture_protection\":true}".as_bytes(),
        );
    }

    #[test]
    fn editor_batch_fields_round_trip_through_decode() {
        for dvm in [Some(alloc::string::String::from("source")), None] {
            for di in [Some(true), Some(false), None] {
                for tw in [Some(true), Some(false), None] {
                    let original = PrefsView {
                        editor_default_view_mode: dvm.clone(),
                        editor_focus_dim_inactive: di,
                        editor_focus_typewriter: tw,
                        ..PrefsView::default()
                    };
                    let encoded = canonical_json_encode(&original);
                    let decoded = canonical_json_decode(&encoded).expect("decode");
                    assert_eq!(decoded, original);
                    assert_eq!(decoded.editor_default_view_mode, dvm);
                    assert_eq!(decoded.editor_focus_dim_inactive, di);
                    assert_eq!(decoded.editor_focus_typewriter, tw);
                }
            }
        }
    }

    #[test]
    fn label_is_nfc_normalized_on_encode() {
        // "é" as NFD (e + combining acute) normalizes to NFC single codepoint.
        let nfd = alloc::string::String::from("Cafe\u{0301}");
        let encoded = canonical_json_encode(&PrefsView {
            label: Some(nfd),
            ..PrefsView::default()
        });
        assert_eq!(
            encoded.as_slice(),
            "{\"label\":\"Café\",\"screen_capture_protection\":true}".as_bytes(),
        );
    }

    #[test]
    fn decode_absent_label_is_none() {
        // A pre-MYND-205 single-field blob decodes with label == None.
        let parsed =
            canonical_json_decode(br#"{"screen_capture_protection":true}"#).expect("decode");
        assert_eq!(parsed.label, None);
    }

    // ---- last_backup_at field (MYND-58, vault-backup-restore epic) ----

    #[test]
    fn encode_places_last_backup_at_between_label_and_screen_capture() {
        // Canonical key order: label (lab) < last_backup_at (las) <
        // screen_capture_protection (s).
        let encoded = canonical_json_encode(&PrefsView {
            label: Some(alloc::string::String::from("Work")),
            last_backup_at: Some(1765000000),
            paired_extensions: Vec::new(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            ..PrefsView::default()
        });
        assert_eq!(
            encoded.as_slice(),
            br#"{"label":"Work","last_backup_at":1765000000,"screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn last_backup_at_round_trips_through_decode() {
        let original = PrefsView {
            last_backup_at: Some(1765432100),
            paired_extensions: Vec::new(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(decoded, original);
    }

    #[test]
    fn last_backup_at_u64_beyond_u32_round_trips() {
        // Epoch seconds are u64 — a value past the 2106 u32 horizon must
        // survive (no silent truncation).
        let original = PrefsView {
            last_backup_at: Some(u64::from(u32::MAX) + 12345),
            paired_extensions: Vec::new(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(decoded.last_backup_at, Some(u64::from(u32::MAX) + 12345));
    }

    #[test]
    fn decode_absent_last_backup_at_is_none() {
        // A pre-MYND-58 blob decodes with last_backup_at == None ("never
        // backed up"); byte-identity of the default encode is asserted by
        // encode_omits_label_when_none_byte_identical_to_pre_label.
        let parsed =
            canonical_json_decode(br#"{"screen_capture_protection":true}"#).expect("decode");
        assert_eq!(parsed.last_backup_at, None);
    }

    #[test]
    fn fractional_last_backup_at_rejects_parse() {
        // Floats are FORBIDDEN (spec §9.5.2): the digits parse, then the
        // strict `,` terminator check rejects the `.`.
        let result = canonical_json_decode(
            br#"{"last_backup_at":1765000000.5,"screen_capture_protection":true}"#,
        );
        assert_eq!(result, Err(PrefsBlobError::PlaintextParseFailed));
    }

    #[test]
    fn encode_emits_theme_last_dark_with_scp_false() {
        let encoded = canonical_json_encode(&PrefsView {
            screen_capture_protection: false,
            bar_items_order: Vec::new(),
            color_groups: Vec::new(),
            show_note_timestamps: true,
            reminders_enabled: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            folder_icons: Default::default(),
            device_names: Default::default(),
            hidden_bar_items: Vec::new(),
            icon: None,
            item_colors: Default::default(),
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
            attachment_compression_enabled: true,
            developer_mode: false,
            attachment_ocr_enabled: true,
            time_format: None,
            timezone: None,
            transcription_enabled: true,
            screen_capture_protection: true,
            bar_items_order: Vec::new(),
            cli_enabled: false,
            cli_excluded_folders: Vec::new(),
            cli_rate_limit_disabled: None,
            color_groups: Vec::new(),
            archived_folders: Vec::new(),
            show_note_timestamps: true,
            reminders_enabled: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            folder_icons: Default::default(),
            device_names: Default::default(),
            hidden_bar_items: Vec::new(),
            icon: None,
            item_colors: Default::default(),
            keymap: Default::default(),
            deliberate_folders: alloc::vec![alloc::string::String::from("Archive/")],
            auto_lock_seconds: Some(300),
            auto_tag_enabled: false,
            custom_theme: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            date_format: None,
            favorites: alloc::vec![alloc::string::String::from("f1")],
            field_clocks: Default::default(),
            item_order: BTreeMap::from([(
                alloc::string::String::from(""),
                alloc::vec![alloc::string::String::from("n1")],
            )]),
            editor_layout: Some(EditorLayout {
                left_width: 312,
                right_width: 288,
                left_collapsed: false,
                right_collapsed: true,
            }),
            editor_line_numbers: None,
            theme: Some(ThemeChoice::Dark),
            active_workspace: None,
            ai_enabled: false,
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            archive_disabled: None,
            editor_content_width: None,
            editor_default_view_mode: None,
            editor_focus_dim_inactive: None,
            editor_focus_typewriter: None,
            editor_font_family: None,
            editor_line_spacing: None,
            editor_text_size: None,
            editor_vim_mode: None,
            label: None,
            last_backup_at: None,
            new_note_location: None,
            new_note_location_folder: None,
            paired_extensions: Vec::new(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            startup_open: None,
            startup_open_note: None,
            saved_views: Vec::new(),
            view_order: Vec::new(),
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"auto_lock_seconds":300,"deliberate_folders":["Archive/"],"editor_layout":{"left_collapsed":false,"left_width":312,"right_collapsed":true,"right_width":288},"favorites":["f1"],"item_order":{"":["n1"]},"screen_capture_protection":true,"theme":"dark"}"#,
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
    fn decode_round_trips_theme_amoled() {
        let parsed =
            canonical_json_decode(br#"{"screen_capture_protection":true,"theme":"amoled"}"#)
                .unwrap();
        assert_eq!(parsed.theme, Some(ThemeChoice::Amoled));
        assert!(parsed.screen_capture_protection);
    }

    #[test]
    fn encode_emits_amoled_theme_value() {
        let prefs = PrefsView {
            theme: Some(ThemeChoice::Amoled),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&prefs);
        // The `theme` key is canonically LAST among the cosmetic fields and
        // serializes the lowercase variant string.
        assert!(find_subslice(&encoded, br#""theme":"amoled""#).is_some());
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
    fn full_blob_round_trip_with_theme_amoled() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let account_hash = fixed_account_number_hash();
        let original = PrefsView {
            theme: Some(ThemeChoice::Amoled),
            ..PrefsView::default()
        };
        let blob =
            encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce())
                .unwrap();
        let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
        assert_eq!(original, decoded);
        assert_eq!(decoded.theme, Some(ThemeChoice::Amoled));
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

    // ---- spell-check fields (MYND-267) --------------------------------

    #[test]
    fn full_blob_round_trip_with_spell_fields() {
        // spell_enabled + spell_languages survive a full encode/decode.
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let account_hash = fixed_account_number_hash();
        let original = PrefsView {
            paired_extensions: Vec::new(),
            spell_enabled: Some(true),
            spell_languages: alloc::vec![String::from("en-US"), String::from("tr")],
            ..PrefsView::default()
        };
        let blob =
            encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce())
                .unwrap();
        let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
        assert_eq!(original, decoded);
        assert_eq!(decoded.spell_enabled, Some(true));
        assert_eq!(decoded.spell_languages, alloc::vec!["en-US", "tr"]);
    }

    #[test]
    fn spell_languages_canonicalized_sorted_and_deduped() {
        // Set-semantics like deliberate_folders: the encoder NFC-sorts +
        // exact-dedupes, so a caller's unordered/duplicated input round-trips
        // to the canonical form.
        let original = PrefsView {
            spell_languages: alloc::vec![
                String::from("tr"),
                String::from("en-US"),
                String::from("tr"),
            ],
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(decoded.spell_languages, alloc::vec!["en-US", "tr"]);
    }

    #[test]
    fn spell_fields_omitted_when_unset_are_byte_identical() {
        // A vault that never touched spell-check encodes with NO "spell_" key,
        // so it is byte-identical to a pre-MYND-267 vault.prefs.
        let encoded = canonical_json_encode(&PrefsView::default());
        assert!(
            find_subslice(&encoded, b"spell_").is_none(),
            "default prefs must not emit any spell_* key"
        );
    }

    #[test]
    fn spell_enabled_false_round_trips() {
        let original = PrefsView {
            paired_extensions: Vec::new(),
            spell_enabled: Some(false),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(decoded.spell_enabled, Some(false));
    }

    // ---- show_note_timestamps (sidebar-note-timestamps) ----------------

    #[test]
    fn encode_omits_show_note_timestamps_when_default() {
        // Default `true` is omit-when-default → a vault that never touched the
        // toggle is byte-identical to a pre-feature vault.prefs (no key emitted).
        let encoded = canonical_json_encode(&PrefsView::default());
        assert!(
            find_subslice(&encoded, b"show_note_timestamps").is_none(),
            "default prefs must not emit the show_note_timestamps key"
        );
    }

    #[test]
    fn encode_emits_show_note_timestamps_false_in_canonical_order() {
        // The non-default `false` IS emitted, immediately after the mandatory
        // screen_capture_protection value (scr < sho < spe).
        let prefs = PrefsView {
            show_note_timestamps: false,
            reminders_enabled: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"screen_capture_protection":true,"show_note_timestamps":false}"#
        );
    }

    #[test]
    fn show_note_timestamps_false_round_trips() {
        let original = PrefsView {
            show_note_timestamps: false,
            reminders_enabled: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert!(!decoded.show_note_timestamps);
    }

    // ---- show_task_marker (MYND-613) ----------------------------------

    #[test]
    fn encode_omits_show_task_marker_when_default() {
        // The default `true` is NOT emitted, so a vault that never touched the
        // toggle stays byte-identical to a pre-MYND-613 vault.prefs — which is
        // what keeps the existing KAT vectors valid.
        let prefs = PrefsView::default();
        let encoded = canonical_json_encode(&prefs);
        assert!(!String::from_utf8_lossy(&encoded).contains("show_task_marker"));
    }

    #[test]
    fn encode_emits_show_task_marker_false_in_canonical_order() {
        // Lexicographic position: after show_note_timestamps (show_n < show_t),
        // before spell_enabled (sho < spe).
        let prefs = PrefsView {
            show_note_timestamps: false,
            reminders_enabled: true,
            reminder_horizon_days: None,
            show_task_marker: false,
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"screen_capture_protection":true,"show_note_timestamps":false,"show_task_marker":false}"#
        );
    }

    #[test]
    fn show_task_marker_false_round_trips() {
        let original = PrefsView {
            reminders_enabled: true,
            reminder_horizon_days: None,
            show_task_marker: false,
            ..PrefsView::default()
        };
        let decoded = canonical_json_decode(&canonical_json_encode(&original)).expect("decode");
        assert!(!decoded.show_task_marker);
    }

    #[test]
    fn show_task_marker_absent_decodes_to_true() {
        // A pre-MYND-613 blob carries no such key; it must read as shown, not
        // hidden — the omit-when-default rule read backwards.
        let decoded =
            canonical_json_decode(br#"{"screen_capture_protection":true}"#).expect("decode");
        assert!(decoded.show_task_marker);
    }

    #[test]
    fn reminders_enabled_false_round_trips() {
        let original = PrefsView {
            reminders_enabled: false,
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        assert_eq!(
            encoded.as_slice(),
            br#"{"reminders_enabled":false,"screen_capture_protection":true}"#
        );
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert!(!decoded.reminders_enabled);
    }

    #[test]
    fn reminders_enabled_absent_decodes_to_true() {
        // A pre-MYND-618 blob carries no such key; it must read as ENABLED, not
        // silenced — the omit-when-default rule read backwards. Silently
        // disabling reminders on every existing vault would be the worst
        // available reading of an absent key.
        let decoded =
            canonical_json_decode(br#"{"screen_capture_protection":true}"#).expect("decode");
        assert!(decoded.reminders_enabled);
    }

    #[test]
    fn reminder_horizon_days_round_trips() {
        let original = PrefsView {
            reminder_horizon_days: Some(3),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        assert_eq!(
            encoded.as_slice(),
            br#"{"reminder_horizon_days":3,"screen_capture_protection":true}"#
        );
        assert_eq!(
            canonical_json_decode(&encoded)
                .expect("decode")
                .reminder_horizon_days,
            Some(3)
        );
    }

    #[test]
    fn reminder_horizon_days_absent_decodes_to_none() {
        // `None` means "use the client's built-in horizon", which is what a
        // vault that never touched the setting must get.
        let decoded =
            canonical_json_decode(br#"{"screen_capture_protection":true}"#).expect("decode");
        assert_eq!(decoded.reminder_horizon_days, None);
    }

    #[test]
    fn both_reminder_fields_sort_between_paired_extensions_and_right_panel() {
        // The canonical ordering claim, asserted rather than argued: the parser
        // is a sequential prefix matcher, so a field in the wrong position does
        // not merely look untidy — it fails to parse.
        let original = PrefsView {
            reminders_enabled: false,
            reminder_horizon_days: Some(14),
            right_panel_active_tab: Some(String::from("backlinks")),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        assert_eq!(
            encoded.as_slice(),
            br#"{"reminder_horizon_days":14,"reminders_enabled":false,"right_panel_active_tab":"backlinks","screen_capture_protection":true}"#
        );
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(decoded.reminder_horizon_days, Some(14));
        assert!(!decoded.reminders_enabled);
        assert_eq!(decoded.right_panel_active_tab.as_deref(), Some("backlinks"));
    }

    #[test]
    fn defaults_are_omitted_so_an_untouched_vault_is_byte_identical() {
        // The property the existing KAT vectors depend on: adding two fields
        // must not change one byte of a blob that never set them.
        let encoded = canonical_json_encode(&PrefsView::default());
        assert!(!encoded.windows(b"reminder".len()).any(|w| w == b"reminder"));
    }

    #[test]
    fn show_note_timestamps_absent_decodes_to_true() {
        // The inverted-default proof: a pre-feature blob (no key) decodes to the
        // default `true` (timestamps visible), NOT bool's `false`.
        let decoded =
            canonical_json_decode(br#"{"screen_capture_protection":true}"#).expect("decode");
        assert!(decoded.show_note_timestamps);
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
            attachment_compression_enabled: true,
            developer_mode: false,
            attachment_ocr_enabled: true,
            time_format: None,
            timezone: None,
            transcription_enabled: true,
            screen_capture_protection: true,
            bar_items_order: Vec::new(),
            cli_enabled: false,
            cli_excluded_folders: Vec::new(),
            cli_rate_limit_disabled: None,
            color_groups: Vec::new(),
            show_note_timestamps: true,
            reminders_enabled: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            folder_icons: Default::default(),
            device_names: Default::default(),
            hidden_bar_items: Vec::new(),
            icon: None,
            item_colors: Default::default(),
            keymap: Default::default(),
            theme: None,
            item_order: Default::default(),
            favorites: Vec::new(),
            field_clocks: Default::default(),
            deliberate_folders: alloc::vec![
                alloc::string::String::from("Projects/"),
                alloc::string::String::from("Archive/"),
            ],
            auto_lock_seconds: None,
            auto_tag_enabled: false,
            custom_theme: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            date_format: None,
            active_workspace: None,
            ai_enabled: false,
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            archive_disabled: None,
            archived_folders: Vec::new(),
            editor_layout: None,
            editor_line_numbers: None,
            editor_content_width: None,
            editor_default_view_mode: None,
            editor_focus_dim_inactive: None,
            editor_focus_typewriter: None,
            editor_font_family: None,
            editor_line_spacing: None,
            editor_text_size: None,
            editor_vim_mode: None,
            label: None,
            last_backup_at: None,
            new_note_location: None,
            new_note_location_folder: None,
            paired_extensions: Vec::new(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            startup_open: None,
            startup_open_note: None,
            saved_views: Vec::new(),
            view_order: Vec::new(),
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
            attachment_compression_enabled: true,
            developer_mode: false,
            attachment_ocr_enabled: true,
            time_format: None,
            timezone: None,
            transcription_enabled: true,
            screen_capture_protection: false,
            bar_items_order: Vec::new(),
            cli_enabled: false,
            cli_excluded_folders: Vec::new(),
            cli_rate_limit_disabled: None,
            color_groups: Vec::new(),
            show_note_timestamps: true,
            reminders_enabled: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            folder_icons: Default::default(),
            device_names: Default::default(),
            hidden_bar_items: Vec::new(),
            icon: None,
            item_colors: Default::default(),
            keymap: Default::default(),
            theme: None,
            item_order: Default::default(),
            favorites: Vec::new(),
            field_clocks: Default::default(),
            deliberate_folders: alloc::vec![
                alloc::string::String::from("b/"),
                alloc::string::String::from("a/"),
                alloc::string::String::from("b/"),
            ],
            auto_lock_seconds: None,
            auto_tag_enabled: false,
            custom_theme: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            date_format: None,
            active_workspace: None,
            ai_enabled: false,
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            archive_disabled: None,
            archived_folders: Vec::new(),
            editor_layout: None,
            editor_line_numbers: None,
            editor_content_width: None,
            editor_default_view_mode: None,
            editor_focus_dim_inactive: None,
            editor_focus_typewriter: None,
            editor_font_family: None,
            editor_line_spacing: None,
            editor_text_size: None,
            editor_vim_mode: None,
            label: None,
            last_backup_at: None,
            new_note_location: None,
            new_note_location_folder: None,
            paired_extensions: Vec::new(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            startup_open: None,
            startup_open_note: None,
            saved_views: Vec::new(),
            view_order: Vec::new(),
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
            attachment_compression_enabled: true,
            developer_mode: false,
            attachment_ocr_enabled: true,
            time_format: None,
            timezone: None,
            transcription_enabled: true,
            screen_capture_protection: true,
            bar_items_order: Vec::new(),
            cli_enabled: false,
            cli_excluded_folders: Vec::new(),
            cli_rate_limit_disabled: None,
            color_groups: Vec::new(),
            show_note_timestamps: true,
            reminders_enabled: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            folder_icons: Default::default(),
            device_names: Default::default(),
            hidden_bar_items: Vec::new(),
            icon: None,
            item_colors: Default::default(),
            keymap: Default::default(),
            theme: None,
            item_order: Default::default(),
            favorites: Vec::new(),
            field_clocks: Default::default(),
            deliberate_folders: alloc::vec![alloc::string::String::from("a\"b/")],
            auto_lock_seconds: None,
            auto_tag_enabled: false,
            custom_theme: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            date_format: None,
            active_workspace: None,
            ai_enabled: false,
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            archive_disabled: None,
            archived_folders: Vec::new(),
            editor_layout: None,
            editor_line_numbers: None,
            editor_content_width: None,
            editor_default_view_mode: None,
            editor_focus_dim_inactive: None,
            editor_focus_typewriter: None,
            editor_font_family: None,
            editor_line_spacing: None,
            editor_text_size: None,
            editor_vim_mode: None,
            label: None,
            last_backup_at: None,
            new_note_location: None,
            new_note_location_folder: None,
            paired_extensions: Vec::new(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            startup_open: None,
            startup_open_note: None,
            saved_views: Vec::new(),
            view_order: Vec::new(),
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
            attachment_compression_enabled: true,
            developer_mode: false,
            attachment_ocr_enabled: true,
            time_format: None,
            timezone: None,
            transcription_enabled: true,
            screen_capture_protection: true,
            bar_items_order: Vec::new(),
            cli_enabled: false,
            cli_excluded_folders: Vec::new(),
            cli_rate_limit_disabled: None,
            color_groups: Vec::new(),
            show_note_timestamps: true,
            reminders_enabled: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            folder_icons: Default::default(),
            device_names: Default::default(),
            hidden_bar_items: Vec::new(),
            icon: None,
            item_colors: Default::default(),
            keymap: Default::default(),
            theme: None,
            item_order: Default::default(),
            favorites: Vec::new(),
            field_clocks: Default::default(),
            deliberate_folders: alloc::vec![alloc::string::String::from("Cafe\u{0301}/")],
            auto_lock_seconds: None,
            auto_tag_enabled: false,
            custom_theme: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            date_format: None,
            active_workspace: None,
            ai_enabled: false,
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            archive_disabled: None,
            archived_folders: Vec::new(),
            editor_layout: None,
            editor_line_numbers: None,
            editor_content_width: None,
            editor_default_view_mode: None,
            editor_focus_dim_inactive: None,
            editor_focus_typewriter: None,
            editor_font_family: None,
            editor_line_spacing: None,
            editor_text_size: None,
            editor_vim_mode: None,
            label: None,
            last_backup_at: None,
            new_note_location: None,
            new_note_location_folder: None,
            paired_extensions: Vec::new(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            startup_open: None,
            startup_open_note: None,
            saved_views: Vec::new(),
            view_order: Vec::new(),
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
            attachment_compression_enabled: true,
            developer_mode: false,
            attachment_ocr_enabled: true,
            time_format: None,
            timezone: None,
            transcription_enabled: true,
            screen_capture_protection: false,
            bar_items_order: Vec::new(),
            cli_enabled: false,
            cli_excluded_folders: Vec::new(),
            cli_rate_limit_disabled: None,
            color_groups: Vec::new(),
            show_note_timestamps: true,
            reminders_enabled: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            folder_icons: Default::default(),
            device_names: Default::default(),
            hidden_bar_items: Vec::new(),
            icon: None,
            item_colors: Default::default(),
            keymap: Default::default(),
            theme: None,
            item_order: Default::default(),
            favorites: Vec::new(),
            field_clocks: Default::default(),
            deliberate_folders: alloc::vec![
                alloc::string::String::from("Projects/Myne/"),
                alloc::string::String::from("Archive/2025/"),
            ],
            auto_lock_seconds: None,
            auto_tag_enabled: false,
            custom_theme: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            date_format: None,
            active_workspace: None,
            ai_enabled: false,
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            archive_disabled: None,
            archived_folders: Vec::new(),
            editor_layout: None,
            editor_line_numbers: None,
            editor_content_width: None,
            editor_default_view_mode: None,
            editor_focus_dim_inactive: None,
            editor_focus_typewriter: None,
            editor_font_family: None,
            editor_line_spacing: None,
            editor_text_size: None,
            editor_vim_mode: None,
            label: None,
            last_backup_at: None,
            new_note_location: None,
            new_note_location_folder: None,
            paired_extensions: Vec::new(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            startup_open: None,
            startup_open_note: None,
            saved_views: Vec::new(),
            view_order: Vec::new(),
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
            attachment_compression_enabled: true,
            developer_mode: false,
            attachment_ocr_enabled: true,
            time_format: None,
            timezone: None,
            transcription_enabled: true,
            field_clocks: Default::default(),
            screen_capture_protection: true,
            bar_items_order: Vec::new(),
            cli_enabled: false,
            cli_excluded_folders: Vec::new(),
            cli_rate_limit_disabled: None,
            color_groups: Vec::new(),
            show_note_timestamps: true,
            reminders_enabled: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            folder_icons: Default::default(),
            device_names: Default::default(),
            hidden_bar_items: Vec::new(),
            icon: None,
            item_colors: Default::default(),
            keymap: Default::default(),
            theme: None,
            deliberate_folders: alloc::vec![alloc::string::String::from("Archive/")],
            auto_lock_seconds: None,
            auto_tag_enabled: false,
            custom_theme: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            date_format: None,
            favorites: alloc::vec![
                alloc::string::String::from("f2"),
                alloc::string::String::from("f1"),
            ],
            item_order: BTreeMap::from([(
                alloc::string::String::from(""),
                alloc::vec![
                    alloc::string::String::from("n1"),
                    alloc::string::String::from("Zebra/"),
                    alloc::string::String::from("n2"),
                ],
            )]),
            active_workspace: None,
            ai_enabled: false,
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            archive_disabled: None,
            archived_folders: Vec::new(),
            editor_layout: None,
            editor_line_numbers: None,
            editor_content_width: None,
            editor_default_view_mode: None,
            editor_focus_dim_inactive: None,
            editor_focus_typewriter: None,
            editor_font_family: None,
            editor_line_spacing: None,
            editor_text_size: None,
            editor_vim_mode: None,
            label: None,
            last_backup_at: None,
            new_note_location: None,
            new_note_location_folder: None,
            paired_extensions: Vec::new(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            startup_open: None,
            startup_open_note: None,
            saved_views: Vec::new(),
            view_order: Vec::new(),
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"deliberate_folders":["Archive/"],"favorites":["f2","f1"],"item_order":{"":["n1","Zebra/","n2"]},"screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn encode_preserves_order_does_not_sort_or_dedupe() {
        // item_order is a SEQUENCE: element order is the payload, so the
        // encoder must NOT sort and NOT dedupe (contrast canonical_folder_list
        // which does both). The duplicate "zzz" must survive verbatim.
        let prefs = PrefsView {
            attachment_compression_enabled: true,
            developer_mode: false,
            attachment_ocr_enabled: true,
            time_format: None,
            timezone: None,
            transcription_enabled: true,
            screen_capture_protection: true,
            bar_items_order: Vec::new(),
            cli_enabled: false,
            cli_excluded_folders: Vec::new(),
            cli_rate_limit_disabled: None,
            color_groups: Vec::new(),
            show_note_timestamps: true,
            reminders_enabled: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            folder_icons: Default::default(),
            device_names: Default::default(),
            hidden_bar_items: Vec::new(),
            icon: None,
            item_colors: Default::default(),
            keymap: Default::default(),
            theme: None,
            deliberate_folders: Vec::new(),
            auto_lock_seconds: None,
            auto_tag_enabled: false,
            custom_theme: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            date_format: None,
            favorites: Vec::new(),
            field_clocks: Default::default(),
            item_order: BTreeMap::from([(
                alloc::string::String::from(""),
                alloc::vec![
                    alloc::string::String::from("zzz"),
                    alloc::string::String::from("aaa"),
                    alloc::string::String::from("mmm"),
                    alloc::string::String::from("zzz"),
                ],
            )]),
            active_workspace: None,
            ai_enabled: false,
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            archive_disabled: None,
            archived_folders: Vec::new(),
            editor_layout: None,
            editor_line_numbers: None,
            editor_content_width: None,
            editor_default_view_mode: None,
            editor_focus_dim_inactive: None,
            editor_focus_typewriter: None,
            editor_font_family: None,
            editor_line_spacing: None,
            editor_text_size: None,
            editor_vim_mode: None,
            label: None,
            last_backup_at: None,
            new_note_location: None,
            new_note_location_folder: None,
            paired_extensions: Vec::new(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            startup_open: None,
            startup_open_note: None,
            saved_views: Vec::new(),
            view_order: Vec::new(),
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"item_order":{"":["zzz","aaa","mmm","zzz"]},"screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn item_order_multi_container_keys_lexicographic_values_ordered() {
        // MYND-596: item_order is a container-keyed map. Container KEYS emit in
        // lexicographic order (root "" first, then "Projects/"), independent of
        // insertion order; each per-container VALUE sequence stays order-
        // preserving (NOT sorted/deduped — the "Projects/" folder sits BETWEEN
        // two notes in the root container). Round-trips verbatim.
        let prefs = PrefsView {
            item_order: BTreeMap::from([
                (
                    // Container key is the FOLDED folder key (`projects/`), not
                    // the display path — matches the clients' `folderKey`
                    // identity so both derive byte-identical keys (MYND-596).
                    alloc::string::String::from("projects/"),
                    alloc::vec![alloc::string::String::from("Projects/Myne/")],
                ),
                (
                    alloc::string::String::from(""),
                    alloc::vec![
                        alloc::string::String::from("n2"),
                        alloc::string::String::from("Projects/"),
                        alloc::string::String::from("n1"),
                    ],
                ),
            ]),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"item_order":{"":["n2","Projects/","n1"],"projects/":["Projects/Myne/"]},"screen_capture_protection":true}"#,
        );
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(decoded.item_order, prefs.item_order);
    }

    #[test]
    fn decode_round_trips_favorites_and_item_order_preserving_sequence() {
        let parsed = canonical_json_decode(
            br#"{"favorites":["f2","f1"],"item_order":{"":["n1","Zebra/","n2"]},"screen_capture_protection":true}"#,
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
            BTreeMap::from([(
                alloc::string::String::from(""),
                alloc::vec![
                    alloc::string::String::from("n1"),
                    alloc::string::String::from("Zebra/"),
                    alloc::string::String::from("n2"),
                ],
            )]),
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
            attachment_compression_enabled: true,
            developer_mode: false,
            attachment_ocr_enabled: true,
            time_format: None,
            timezone: None,
            transcription_enabled: true,
            field_clocks: Default::default(),
            screen_capture_protection: false,
            bar_items_order: Vec::new(),
            cli_enabled: false,
            cli_excluded_folders: Vec::new(),
            cli_rate_limit_disabled: None,
            color_groups: Vec::new(),
            show_note_timestamps: true,
            reminders_enabled: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            folder_icons: Default::default(),
            device_names: Default::default(),
            hidden_bar_items: alloc::vec![
                alloc::string::String::from("graph"),
                alloc::string::String::from("word-count"),
            ],
            icon: None,
            item_colors: Default::default(),
            keymap: Default::default(),
            theme: None,
            deliberate_folders: alloc::vec![alloc::string::String::from("Projects/")],
            auto_lock_seconds: Some(900),
            auto_tag_enabled: false,
            custom_theme: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            date_format: None,
            favorites: alloc::vec![alloc::string::String::from(
                "0190a000-0000-7000-8000-000000000002",
            )],
            item_order: BTreeMap::from([(
                alloc::string::String::from(""),
                alloc::vec![
                    alloc::string::String::from("0190a000-0000-7000-8000-000000000002"),
                    alloc::string::String::from("Projects/"),
                    alloc::string::String::from("0190a000-0000-7000-8000-000000000001"),
                ],
            )]),
            active_workspace: None,
            ai_enabled: false,
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            archive_disabled: None,
            archived_folders: Vec::new(),
            editor_layout: None,
            editor_line_numbers: None,
            editor_content_width: None,
            editor_default_view_mode: None,
            editor_focus_dim_inactive: None,
            editor_focus_typewriter: None,
            editor_font_family: None,
            editor_line_spacing: None,
            editor_text_size: None,
            editor_vim_mode: None,
            label: None,
            last_backup_at: None,
            new_note_location: None,
            new_note_location_folder: None,
            paired_extensions: Vec::new(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            startup_open: None,
            startup_open_note: None,
            saved_views: Vec::new(),
            view_order: Vec::new(),
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
        // hidden_bar_items is a set field — round-trips canonicalized (sorted).
        assert_eq!(
            decoded.hidden_bar_items,
            alloc::vec![
                alloc::string::String::from("graph"),
                alloc::string::String::from("word-count"),
            ],
        );
    }

    #[test]
    fn encode_places_hidden_bar_items_between_folder_icons_and_item_colors() {
        // Canonical key order: folder_icons (f) < hidden_bar_items (h) <
        // item_colors (i). The set-array is sorted + exact-deduped on encode
        // (graph/word-count out of order + a duplicate collapse to a clean set).
        let prefs = PrefsView {
            attachment_compression_enabled: true,
            developer_mode: false,
            attachment_ocr_enabled: true,
            time_format: None,
            timezone: None,
            transcription_enabled: true,
            screen_capture_protection: true,
            bar_items_order: Vec::new(),
            cli_enabled: false,
            cli_excluded_folders: Vec::new(),
            cli_rate_limit_disabled: None,
            color_groups: Vec::new(),
            show_note_timestamps: true,
            reminders_enabled: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            folder_icons: map_of(&[("Projects/", "book")]),
            device_names: Default::default(),
            hidden_bar_items: alloc::vec![
                alloc::string::String::from("word-count"),
                alloc::string::String::from("graph"),
                alloc::string::String::from("graph"),
            ],
            icon: None,
            item_colors: map_of(&[("Projects/", "red")]),
            keymap: Default::default(),
            theme: None,
            item_order: Default::default(),
            favorites: Vec::new(),
            field_clocks: Default::default(),
            deliberate_folders: Vec::new(),
            auto_lock_seconds: None,
            auto_tag_enabled: false,
            custom_theme: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            date_format: None,
            active_workspace: None,
            ai_enabled: false,
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            archive_disabled: None,
            archived_folders: Vec::new(),
            editor_layout: None,
            editor_line_numbers: None,
            editor_content_width: None,
            editor_default_view_mode: None,
            editor_focus_dim_inactive: None,
            editor_focus_typewriter: None,
            editor_font_family: None,
            editor_line_spacing: None,
            editor_text_size: None,
            editor_vim_mode: None,
            label: None,
            last_backup_at: None,
            new_note_location: None,
            new_note_location_folder: None,
            paired_extensions: Vec::new(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            startup_open: None,
            startup_open_note: None,
            saved_views: Vec::new(),
            view_order: Vec::new(),
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"folder_icons":{"Projects/":"book"},"hidden_bar_items":["graph","word-count"],"item_colors":{"Projects/":"red"},"screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn encode_omits_hidden_bar_items_when_empty() {
        // Empty (the default — bar fully visible) → byte-identical to a
        // pre-feature vault.prefs (preserves existing KAT vectors + vaults).
        let encoded = canonical_json_encode(&PrefsView::default());
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
    }

    // ---- bar_items_order canonical field (MYND bottom-bar reorder) ------

    #[test]
    fn encode_omits_bar_items_order_when_empty() {
        // Empty (the default — canonical bar order) → byte-identical to a
        // pre-feature vault.prefs (preserves existing KAT vectors + vaults).
        let encoded = canonical_json_encode(&PrefsView::default());
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
    }

    #[test]
    fn encode_emits_bar_items_order_in_canonical_position() {
        // Canonical key order: auto_lock_seconds (au) < bar_items_order (b) <
        // custom_theme (c) < screen_capture_protection (s). Pin the position
        // between auto_lock_seconds and custom_theme with all three present.
        let prefs = PrefsView {
            auto_lock_seconds: Some(300),
            bar_items_order: alloc::vec!["graph".into(), "tags".into()],
            custom_theme: Some("midnight".into()),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"auto_lock_seconds":300,"bar_items_order":["graph","tags"],"custom_theme":"midnight","screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn bar_items_order_round_trips_verbatim_not_sorted() {
        // Sequence semantics: order is the payload, so a non-sorted input must
        // survive encode→decode VERBATIM (unlike the set-array hidden_bar_items).
        let order: alloc::vec::Vec<String> = alloc::vec![
            "word-count".into(),
            "graph".into(),
            "tags".into(),
            "view-mode".into(),
        ];
        let prefs = PrefsView {
            bar_items_order: order.clone(),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&prefs);
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(decoded.bar_items_order, order);
    }

    // ---- cli_enabled / cli_excluded_folders / cli_rate_limit_disabled
    // (myne-cli epic, MYND-490; `cli-thin-client` task 2) ------------------

    #[test]
    fn cli_enabled_omitted_when_false_emitted_only_when_true() {
        let off = canonical_json_encode(&PrefsView {
            cli_enabled: false,
            ..PrefsView::default()
        });
        assert!(!core::str::from_utf8(&off).unwrap().contains("cli_enabled"));
        let on = canonical_json_encode(&PrefsView {
            cli_enabled: true,
            ..PrefsView::default()
        });
        assert_eq!(
            on.as_slice(),
            br#"{"cli_enabled":true,"screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn cli_excluded_folders_omitted_when_empty_present_when_set() {
        let empty = canonical_json_encode(&PrefsView {
            cli_excluded_folders: Vec::new(),
            ..PrefsView::default()
        });
        assert!(!core::str::from_utf8(&empty)
            .unwrap()
            .contains("cli_excluded_folders"));
        let set = canonical_json_encode(&PrefsView {
            cli_excluded_folders: alloc::vec![alloc::string::String::from("Secret/")],
            ..PrefsView::default()
        });
        assert_eq!(
            set.as_slice(),
            br#"{"cli_excluded_folders":["Secret/"],"screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn cli_excluded_folders_canonicalized_nfc_sorted_deduped() {
        // Same canonical set encoding as ai_excluded_folders / deliberate_folders:
        // NFC-normalized, lexicographically sorted, exact-deduped.
        let nfd_cafe = alloc::string::String::from("Cafe\u{0301}/"); // "Café/" as NFD
        let encoded = canonical_json_encode(&PrefsView {
            cli_excluded_folders: alloc::vec![
                alloc::string::String::from("Zeta/"),
                nfd_cafe,
                alloc::string::String::from("Alpha/"),
                alloc::string::String::from("Alpha/"),
            ],
            ..PrefsView::default()
        });
        assert_eq!(
            encoded.as_slice(),
            "{\"cli_excluded_folders\":[\"Alpha/\",\"Café/\",\"Zeta/\"],\"screen_capture_protection\":true}"
                .as_bytes(),
        );
    }

    #[test]
    fn encode_omits_cli_rate_limit_disabled_when_none_byte_identical_to_pre_feature() {
        let encoded = canonical_json_encode(&PrefsView {
            cli_rate_limit_disabled: None,
            ..PrefsView::default()
        });
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
    }

    #[test]
    fn encode_emits_cli_fields_between_bar_items_order_and_custom_theme() {
        // Canonical key order: bar_items_order (b) < cli_enabled <
        // cli_excluded_folders < cli_rate_limit_disabled < custom_theme (c).
        let encoded = canonical_json_encode(&PrefsView {
            bar_items_order: alloc::vec!["graph".into()],
            cli_enabled: true,
            cli_excluded_folders: alloc::vec![alloc::string::String::from("Work/")],
            cli_rate_limit_disabled: Some(true),
            custom_theme: Some("midnight".into()),
            ..PrefsView::default()
        });
        assert_eq!(
            encoded.as_slice(),
            br#"{"bar_items_order":["graph"],"cli_enabled":true,"cli_excluded_folders":["Work/"],"cli_rate_limit_disabled":true,"custom_theme":"midnight","screen_capture_protection":true}"#,
        );
        // The non-default `false` is persisted explicitly (Some(false) != None).
        let off = canonical_json_encode(&PrefsView {
            cli_rate_limit_disabled: Some(false),
            ..PrefsView::default()
        });
        assert_eq!(
            off.as_slice(),
            br#"{"cli_rate_limit_disabled":false,"screen_capture_protection":true}"#,
        );
    }

    #[test]
    fn cli_fields_round_trip_through_decode() {
        let original = PrefsView {
            bar_items_order: alloc::vec!["tags".into()],
            cli_enabled: true,
            cli_excluded_folders: alloc::vec![
                alloc::string::String::from("Alpha/"),
                alloc::string::String::from("Beta/"),
            ],
            cli_rate_limit_disabled: Some(true),
            custom_theme: Some("midnight".into()),
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        let decoded = canonical_json_decode(&encoded).expect("decode");
        assert_eq!(decoded, original);
    }

    #[test]
    fn cli_fields_default_off_empty_none_when_absent_on_decode() {
        // A pre-feature blob (no cli_* keys) decodes to the defaults — closed
        // door, empty exclusion set, unset rate-limit toggle — spec § 9.5.2
        // forward-compat fall-back.
        let decoded =
            canonical_json_decode(br#"{"screen_capture_protection":true}"#).expect("decode");
        assert!(!decoded.cli_enabled);
        assert!(decoded.cli_excluded_folders.is_empty());
        assert_eq!(decoded.cli_rate_limit_disabled, None);
    }

    #[test]
    fn cli_rate_limit_disabled_round_trips_through_decode() {
        for value in [Some(true), Some(false), None] {
            let original = PrefsView {
                cli_rate_limit_disabled: value,
                ..PrefsView::default()
            };
            let encoded = canonical_json_encode(&original);
            let decoded = canonical_json_decode(&encoded).expect("decode");
            assert_eq!(decoded, original);
            assert_eq!(decoded.cli_rate_limit_disabled, value);
        }
    }

    // ---- editor toolbar / slash customization (MYND-336) ---------------

    #[test]
    fn editor_toolbar_slash_customization_round_trips() {
        // order fields are verbatim sequences; hidden fields are sorted+deduped
        // sets (canonical_folder_list), exactly like bar_items_order / hidden_bar_items.
        let prefs = PrefsView {
            editor_toolbar_order: alloc::vec!["link".into(), "bold".into()],
            editor_toolbar_hidden: alloc::vec!["quote".into(), "bold".into(), "quote".into()],
            editor_slash_order: alloc::vec!["table".into()],
            editor_slash_hidden: alloc::vec!["callout".into()],
            ..PrefsView::default()
        };
        let decoded = canonical_json_decode(&canonical_json_encode(&prefs)).expect("decode");
        assert_eq!(decoded.editor_toolbar_order, alloc::vec!["link", "bold"]); // verbatim
        assert_eq!(decoded.editor_slash_order, alloc::vec!["table"]);
        assert_eq!(decoded.editor_toolbar_hidden, alloc::vec!["bold", "quote"]); // sorted+deduped
        assert_eq!(decoded.editor_slash_hidden, alloc::vec!["callout"]);
    }

    #[test]
    fn editor_customization_absent_decodes_to_empty_migration_less() {
        // A default (un-customized) vault.prefs OMITS all four keys — byte-
        // identical to a pre-MYND-336 blob — and decodes with them empty.
        let bytes = canonical_json_encode(&PrefsView::default());
        let s = alloc::string::String::from_utf8(bytes.clone()).unwrap();
        assert!(!s.contains("editor_toolbar"), "omitted when empty: {s}");
        assert!(!s.contains("editor_slash"), "omitted when empty: {s}");
        let decoded = canonical_json_decode(&bytes).expect("decode");
        assert!(decoded.editor_toolbar_order.is_empty());
        assert!(decoded.editor_toolbar_hidden.is_empty());
        assert!(decoded.editor_slash_order.is_empty());
        assert!(decoded.editor_slash_hidden.is_empty());
    }

    #[test]
    fn editor_customization_canonical_key_positions() {
        // editor_slash_* < editor_text_size < editor_toolbar_* in canonical order.
        let prefs = PrefsView {
            editor_text_size: Some("large".into()),
            editor_slash_order: alloc::vec!["a".into()],
            editor_toolbar_order: alloc::vec!["b".into()],
            ..PrefsView::default()
        };
        let s = alloc::string::String::from_utf8(canonical_json_encode(&prefs)).unwrap();
        let slash = s.find("editor_slash_order").unwrap();
        let text = s.find("editor_text_size").unwrap();
        let toolbar = s.find("editor_toolbar_order").unwrap();
        assert!(
            slash < text && text < toolbar,
            "canonical order violated: {s}"
        );
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
            attachment_compression_enabled: true,
            developer_mode: false,
            attachment_ocr_enabled: true,
            time_format: None,
            timezone: None,
            transcription_enabled: true,
            screen_capture_protection: true,
            bar_items_order: Vec::new(),
            cli_enabled: false,
            cli_excluded_folders: Vec::new(),
            cli_rate_limit_disabled: None,
            color_groups: Vec::new(),
            show_note_timestamps: true,
            reminders_enabled: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            folder_icons: Default::default(),
            device_names: Default::default(),
            hidden_bar_items: Vec::new(),
            icon: None,
            item_colors: Default::default(),
            keymap: Default::default(),
            theme: None,
            item_order: Default::default(),
            favorites: Vec::new(),
            field_clocks: Default::default(),
            deliberate_folders: Vec::new(),
            auto_lock_seconds: Some(300),
            auto_tag_enabled: false,
            custom_theme: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            date_format: None,
            active_workspace: None,
            ai_enabled: false,
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            archive_disabled: None,
            archived_folders: Vec::new(),
            editor_layout: None,
            editor_line_numbers: None,
            editor_content_width: None,
            editor_default_view_mode: None,
            editor_focus_dim_inactive: None,
            editor_focus_typewriter: None,
            editor_font_family: None,
            editor_line_spacing: None,
            editor_text_size: None,
            editor_vim_mode: None,
            label: None,
            last_backup_at: None,
            new_note_location: None,
            new_note_location_folder: None,
            paired_extensions: Vec::new(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            startup_open: None,
            startup_open_note: None,
            saved_views: Vec::new(),
            view_order: Vec::new(),
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
            attachment_compression_enabled: true,
            developer_mode: false,
            attachment_ocr_enabled: true,
            time_format: None,
            timezone: None,
            transcription_enabled: true,
            screen_capture_protection: false,
            bar_items_order: Vec::new(),
            cli_enabled: false,
            cli_excluded_folders: Vec::new(),
            cli_rate_limit_disabled: None,
            color_groups: Vec::new(),
            show_note_timestamps: true,
            reminders_enabled: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            folder_icons: Default::default(),
            device_names: Default::default(),
            hidden_bar_items: Vec::new(),
            icon: None,
            item_colors: Default::default(),
            keymap: Default::default(),
            theme: None,
            item_order: Default::default(),
            favorites: Vec::new(),
            field_clocks: Default::default(),
            deliberate_folders: alloc::vec![alloc::string::String::from("Archive/")],
            auto_lock_seconds: Some(900),
            auto_tag_enabled: false,
            custom_theme: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            date_format: None,
            active_workspace: None,
            ai_enabled: false,
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            archive_disabled: None,
            archived_folders: Vec::new(),
            editor_layout: None,
            editor_line_numbers: None,
            editor_content_width: None,
            editor_default_view_mode: None,
            editor_focus_dim_inactive: None,
            editor_focus_typewriter: None,
            editor_font_family: None,
            editor_line_spacing: None,
            editor_text_size: None,
            editor_vim_mode: None,
            label: None,
            last_backup_at: None,
            new_note_location: None,
            new_note_location_folder: None,
            paired_extensions: Vec::new(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            startup_open: None,
            startup_open_note: None,
            saved_views: Vec::new(),
            view_order: Vec::new(),
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
            attachment_compression_enabled: true,
            developer_mode: false,
            attachment_ocr_enabled: true,
            time_format: None,
            timezone: None,
            transcription_enabled: true,
            screen_capture_protection: true,
            bar_items_order: Vec::new(),
            cli_enabled: false,
            cli_excluded_folders: Vec::new(),
            cli_rate_limit_disabled: None,
            color_groups: Vec::new(),
            show_note_timestamps: true,
            reminders_enabled: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            folder_icons: Default::default(),
            device_names: Default::default(),
            hidden_bar_items: Vec::new(),
            icon: None,
            item_colors: Default::default(),
            keymap: Default::default(),
            theme: None,
            item_order: Default::default(),
            favorites: Vec::new(),
            field_clocks: Default::default(),
            deliberate_folders: Vec::new(),
            auto_lock_seconds: Some(0),
            auto_tag_enabled: false,
            custom_theme: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            date_format: None,
            active_workspace: None,
            ai_enabled: false,
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            archive_disabled: None,
            archived_folders: Vec::new(),
            editor_layout: None,
            editor_line_numbers: None,
            editor_content_width: None,
            editor_default_view_mode: None,
            editor_focus_dim_inactive: None,
            editor_focus_typewriter: None,
            editor_font_family: None,
            editor_line_spacing: None,
            editor_text_size: None,
            editor_vim_mode: None,
            label: None,
            last_backup_at: None,
            new_note_location: None,
            new_note_location_folder: None,
            paired_extensions: Vec::new(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            startup_open: None,
            startup_open_note: None,
            saved_views: Vec::new(),
            view_order: Vec::new(),
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
            attachment_compression_enabled: true,
            developer_mode: false,
            attachment_ocr_enabled: true,
            time_format: None,
            timezone: None,
            transcription_enabled: true,
            screen_capture_protection: true,
            bar_items_order: Vec::new(),
            cli_enabled: false,
            cli_excluded_folders: Vec::new(),
            cli_rate_limit_disabled: None,
            color_groups: Vec::new(),
            show_note_timestamps: true,
            reminders_enabled: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            folder_icons: Default::default(),
            device_names: Default::default(),
            hidden_bar_items: Vec::new(),
            icon: None,
            item_colors: Default::default(),
            keymap: Default::default(),
            theme: None,
            item_order: Default::default(),
            favorites: Vec::new(),
            field_clocks: Default::default(),
            deliberate_folders: alloc::vec![alloc::string::String::from("Projects/")],
            auto_lock_seconds: Some(1800),
            auto_tag_enabled: false,
            custom_theme: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            date_format: None,
            active_workspace: None,
            ai_enabled: false,
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            archive_disabled: None,
            archived_folders: Vec::new(),
            editor_layout: None,
            editor_line_numbers: None,
            editor_content_width: None,
            editor_default_view_mode: None,
            editor_focus_dim_inactive: None,
            editor_focus_typewriter: None,
            editor_font_family: None,
            editor_line_spacing: None,
            editor_text_size: None,
            editor_vim_mode: None,
            label: None,
            last_backup_at: None,
            new_note_location: None,
            new_note_location_folder: None,
            paired_extensions: Vec::new(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            startup_open: None,
            startup_open_note: None,
            saved_views: Vec::new(),
            view_order: Vec::new(),
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
            attachment_compression_enabled: true,
            developer_mode: false,
            attachment_ocr_enabled: true,
            time_format: None,
            timezone: None,
            transcription_enabled: true,
            screen_capture_protection: true,
            bar_items_order: Vec::new(),
            cli_enabled: false,
            cli_excluded_folders: Vec::new(),
            cli_rate_limit_disabled: None,
            color_groups: Vec::new(),
            archived_folders: Vec::new(),
            show_note_timestamps: true,
            reminders_enabled: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            folder_icons: Default::default(),
            device_names: Default::default(),
            hidden_bar_items: Vec::new(),
            icon: None,
            item_colors: Default::default(),
            keymap: Default::default(),
            theme: None,
            deliberate_folders: alloc::vec![alloc::string::String::from("Archive/")],
            auto_lock_seconds: None,
            auto_tag_enabled: false,
            custom_theme: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            date_format: None,
            favorites: alloc::vec![alloc::string::String::from("f1")],
            field_clocks: Default::default(),
            item_order: BTreeMap::from([(
                alloc::string::String::from(""),
                alloc::vec![alloc::string::String::from("n1")],
            )]),
            active_workspace: None,
            ai_enabled: false,
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            archive_disabled: None,
            editor_layout: Some(sample_layout()),
            editor_line_numbers: None,
            editor_content_width: None,
            editor_default_view_mode: None,
            editor_focus_dim_inactive: None,
            editor_focus_typewriter: None,
            editor_font_family: None,
            editor_line_spacing: None,
            editor_text_size: None,
            editor_vim_mode: None,
            label: None,
            last_backup_at: None,
            new_note_location: None,
            new_note_location_folder: None,
            paired_extensions: Vec::new(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            startup_open: None,
            startup_open_note: None,
            saved_views: Vec::new(),
            view_order: Vec::new(),
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"deliberate_folders":["Archive/"],"editor_layout":{"left_collapsed":false,"left_width":312,"right_collapsed":true,"right_width":288},"favorites":["f1"],"item_order":{"":["n1"]},"screen_capture_protection":true}"#,
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
            br#"{"auto_lock_seconds":900,"deliberate_folders":["Archive/"],"editor_layout":{"left_collapsed":false,"left_width":320,"right_collapsed":true,"right_width":300},"favorites":["f1"],"item_order":{"":["n2","n1"]},"screen_capture_protection":false}"#,
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
            BTreeMap::from([(
                alloc::string::String::from(""),
                alloc::vec![
                    alloc::string::String::from("n2"),
                    alloc::string::String::from("n1"),
                ],
            )])
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
            attachment_compression_enabled: true,
            developer_mode: false,
            attachment_ocr_enabled: true,
            time_format: None,
            timezone: None,
            transcription_enabled: true,
            screen_capture_protection: false,
            bar_items_order: Vec::new(),
            cli_enabled: false,
            cli_excluded_folders: Vec::new(),
            cli_rate_limit_disabled: None,
            color_groups: Vec::new(),
            show_note_timestamps: true,
            reminders_enabled: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            folder_icons: Default::default(),
            device_names: Default::default(),
            hidden_bar_items: Vec::new(),
            icon: None,
            item_colors: Default::default(),
            keymap: Default::default(),
            theme: None,
            item_order: Default::default(),
            favorites: Vec::new(),
            field_clocks: Default::default(),
            deliberate_folders: Vec::new(),
            auto_lock_seconds: None,
            auto_tag_enabled: false,
            custom_theme: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            date_format: None,
            active_workspace: None,
            ai_enabled: false,
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            archive_disabled: None,
            archived_folders: Vec::new(),
            editor_layout: None,
            editor_line_numbers: None,
            editor_content_width: None,
            editor_default_view_mode: None,
            editor_focus_dim_inactive: None,
            editor_focus_typewriter: None,
            editor_font_family: None,
            editor_line_spacing: None,
            editor_text_size: None,
            editor_vim_mode: None,
            label: None,
            last_backup_at: None,
            new_note_location: None,
            new_note_location_folder: None,
            paired_extensions: Vec::new(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            startup_open: None,
            startup_open_note: None,
            saved_views: Vec::new(),
            view_order: Vec::new(),
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
            attachment_compression_enabled: true,
            developer_mode: false,
            attachment_ocr_enabled: true,
            time_format: None,
            timezone: None,
            transcription_enabled: true,
            screen_capture_protection: false,
            bar_items_order: Vec::new(),
            cli_enabled: false,
            cli_excluded_folders: Vec::new(),
            cli_rate_limit_disabled: None,
            color_groups: Vec::new(),
            show_note_timestamps: true,
            reminders_enabled: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            folder_icons: Default::default(),
            device_names: Default::default(),
            hidden_bar_items: Vec::new(),
            icon: None,
            item_colors: Default::default(),
            keymap: Default::default(),
            theme: None,
            item_order: Default::default(),
            favorites: Vec::new(),
            field_clocks: Default::default(),
            deliberate_folders: Vec::new(),
            auto_lock_seconds: None,
            auto_tag_enabled: false,
            custom_theme: None,
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            date_format: None,
            active_workspace: None,
            ai_enabled: false,
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            archive_disabled: None,
            archived_folders: Vec::new(),
            editor_layout: None,
            editor_line_numbers: None,
            editor_content_width: None,
            editor_default_view_mode: None,
            editor_focus_dim_inactive: None,
            editor_focus_typewriter: None,
            editor_font_family: None,
            editor_line_spacing: None,
            editor_text_size: None,
            editor_vim_mode: None,
            label: None,
            last_backup_at: None,
            new_note_location: None,
            new_note_location_folder: None,
            paired_extensions: Vec::new(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            startup_open: None,
            startup_open_note: None,
            saved_views: Vec::new(),
            view_order: Vec::new(),
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
    ///
    /// (The MYND-184/185 decoration-maps vector is emitted separately by
    /// [`emit_decorations_prefs_vector`] to keep this generator stable.)
    #[test]
    #[ignore]
    fn emit_decorations_prefs_vector() {
        extern crate std;

        // Vault A — same fixed inputs as the sibling generator, distinct nonce
        // (0xCC×24) so the decorations blob diverges from every other case.
        let root_a: [u8; 32] = [0x42; 32];
        let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
        let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);
        let nonce: [u8; AEAD_NONCE_LEN] = [0xCC; AEAD_NONCE_LEN];

        let mut folder_icons = BTreeMap::new();
        folder_icons.insert(String::from("Archive/2025/"), String::from("archive"));
        folder_icons.insert(String::from("Projects/Myne/"), String::from("book"));
        let mut item_colors = BTreeMap::new();
        item_colors.insert(
            String::from("0190a000-0000-7000-8000-000000000001"),
            String::from("moss"),
        );
        item_colors.insert(String::from("Projects/Myne/"), String::from("slate"));

        let prefs = PrefsView {
            folder_icons,
            item_colors,
            ..PrefsView::default()
        };
        let canonical = canonical_json_encode(&prefs);
        let blob = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs, &nonce)
            .expect("encode decorations");
        // Self-validate the round-trip before emitting.
        let decoded = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob).expect("decode");
        assert_eq!(decoded, prefs);

        let mut dump = alloc::string::String::new();
        dump.push_str("\n---begin decorations vector---\n");
        dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
        dump.push_str(&alloc::format!(
            "prefs_key_hex: {}\n",
            hex_lower(&*prefs_key_a)
        ));
        dump.push_str(&alloc::format!(
            "account_number_hash_hex: {}\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str(&alloc::format!("prefs_nonce_hex: {}\n", hex_lower(&nonce)));
        dump.push_str(&alloc::format!(
            "plaintext_canonical_utf8_hex: {}\n",
            hex_lower(&canonical)
        ));
        dump.push_str(&alloc::format!(
            "plaintext_str: {}\n",
            std::string::String::from_utf8_lossy(&canonical)
        ));
        dump.push_str(&alloc::format!(
            "expected_prefs_blob_hex: {}\n",
            hex_lower(&blob)
        ));
        dump.push_str("---end decorations vector---\n");
        std::println!("{dump}");
    }

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
                attachment_compression_enabled: true,
                developer_mode: false,
                attachment_ocr_enabled: true,
                time_format: None,
                timezone: None,
                transcription_enabled: true,
                screen_capture_protection: true,
                bar_items_order: Vec::new(),
                cli_enabled: false,
                cli_excluded_folders: Vec::new(),
                cli_rate_limit_disabled: None,
                color_groups: Vec::new(),
                icon: None,
                ai_enabled: false,
                ai_excluded_folders: Vec::new(),
                ai_provider: None,
                ai_provider_consent: None,
                ai_provider_key: None,
                ai_provider_model: None,
                archived_folders: Vec::new(),
                show_note_timestamps: true,
                reminders_enabled: true,
                reminder_horizon_days: None,
                show_task_marker: true,
                folder_icons: Default::default(),
                device_names: Default::default(),
                hidden_bar_items: Vec::new(),
                item_colors: Default::default(),
                keymap: Default::default(),
                theme: None,
                item_order: Default::default(),
                favorites: Vec::new(),
                field_clocks: Default::default(),
                deliberate_folders: Vec::new(),
                auto_lock_seconds: None,
                auto_tag_enabled: false,
                custom_theme: None,
                daily_date_format: None,
                daily_folder: None,
                daily_template: None,
                date_format: None,
                active_workspace: None,
                archive_disabled: None,
                editor_layout: None,
                editor_line_numbers: None,
                editor_content_width: None,
                editor_default_view_mode: None,
                editor_focus_dim_inactive: None,
                editor_focus_typewriter: None,
                editor_font_family: None,
                editor_line_spacing: None,
                editor_text_size: None,
                editor_vim_mode: None,
                label: None,
                last_backup_at: None,
                new_note_location: None,
                new_note_location_folder: None,
                paired_extensions: Vec::new(),
                right_panel_active_tab: None,
                right_panel_hidden_tabs: Vec::new(),
                right_panel_tab_order: Vec::new(),
                editor_slash_hidden: Vec::new(),
                editor_slash_order: Vec::new(),
                editor_toolbar_hidden: Vec::new(),
                editor_toolbar_order: Vec::new(),
                spell_enabled: None,
                spell_languages: Vec::new(),
                startup_open: None,
                startup_open_note: None,
                saved_views: Vec::new(),
                view_order: Vec::new(),
            },
            &nonce_default,
        )
        .expect("encode default");

        let blob_toggled = encode_prefs_blob_raw(
            &prefs_key_a,
            &account_hash_a,
            &PrefsView {
                attachment_compression_enabled: true,
                developer_mode: false,
                attachment_ocr_enabled: true,
                time_format: None,
                timezone: None,
                transcription_enabled: true,
                screen_capture_protection: false,
                bar_items_order: Vec::new(),
                cli_enabled: false,
                cli_excluded_folders: Vec::new(),
                cli_rate_limit_disabled: None,
                color_groups: Vec::new(),
                icon: None,
                ai_enabled: false,
                ai_excluded_folders: Vec::new(),
                ai_provider: None,
                ai_provider_consent: None,
                ai_provider_key: None,
                ai_provider_model: None,
                archived_folders: Vec::new(),
                show_note_timestamps: true,
                reminders_enabled: true,
                reminder_horizon_days: None,
                show_task_marker: true,
                folder_icons: Default::default(),
                device_names: Default::default(),
                hidden_bar_items: Vec::new(),
                item_colors: Default::default(),
                keymap: Default::default(),
                theme: None,
                item_order: Default::default(),
                favorites: Vec::new(),
                field_clocks: Default::default(),
                deliberate_folders: Vec::new(),
                auto_lock_seconds: None,
                auto_tag_enabled: false,
                custom_theme: None,
                daily_date_format: None,
                daily_folder: None,
                daily_template: None,
                date_format: None,
                active_workspace: None,
                archive_disabled: None,
                editor_layout: None,
                editor_line_numbers: None,
                editor_content_width: None,
                editor_default_view_mode: None,
                editor_focus_dim_inactive: None,
                editor_focus_typewriter: None,
                editor_font_family: None,
                editor_line_spacing: None,
                editor_text_size: None,
                editor_vim_mode: None,
                label: None,
                last_backup_at: None,
                new_note_location: None,
                new_note_location_folder: None,
                paired_extensions: Vec::new(),
                right_panel_active_tab: None,
                right_panel_hidden_tabs: Vec::new(),
                right_panel_tab_order: Vec::new(),
                editor_slash_hidden: Vec::new(),
                editor_slash_order: Vec::new(),
                editor_toolbar_hidden: Vec::new(),
                editor_toolbar_order: Vec::new(),
                spell_enabled: None,
                spell_languages: Vec::new(),
                startup_open: None,
                startup_open_note: None,
                saved_views: Vec::new(),
                view_order: Vec::new(),
            },
            &nonce_toggled,
        )
        .expect("encode toggled");

        // Fully-populated case (MYND-183): heterogeneous item_order (note UUIDs
        // + folder paths interleaved) + favorites + every other field, matching
        // the spec § 9.5.2 worked example. The canonical plaintext is COMPUTED
        // (not hardcoded) so the generator self-validates the canonical key
        // order + sequence discipline before emitting.
        // MYND-596 + coverage backfill: this "fully-populated" case now sets
        // every previously-unvectored field to a NON-default value, so the
        // golden vectors exercise the canonical slot, the inverse-default emit
        // polarity (the six default-`true` bools emitted only when `false`), and
        // the set-vs-sequence array discipline for each. `canonical_json_encode`
        // self-validates the key order + discipline at mint (round-trip below).
        let prefs_populated = PrefsView {
            // inverse-default bools (default true → emitted only when false)
            attachment_compression_enabled: false,
            attachment_ocr_enabled: false,
            time_format: None,
            timezone: None,
            transcription_enabled: false,
            show_note_timestamps: false,
            reminders_enabled: false,
            show_task_marker: false,
            // positive-opt-in bools
            developer_mode: true,
            cli_enabled: true,
            ai_enabled: false,
            field_clocks: Default::default(),
            screen_capture_protection: true,
            // sequence array (order preserved verbatim)
            bar_items_order: alloc::vec![
                alloc::string::String::from("view-mode"),
                alloc::string::String::from("tags"),
                alloc::string::String::from("graph"),
            ],
            // set array (sorted + deduped)
            cli_excluded_folders: alloc::vec![alloc::string::String::from("Private/")],
            cli_rate_limit_disabled: Some(true),
            // color_groups: one enabled hasTag rule — pins the canonical slot
            // (bar_items_order < color_groups < custom_theme) inside vault.prefs;
            // the array codec itself is pinned by the color-group category.
            color_groups: alloc::vec![crate::color_group::ColorGroup {
                id: alloc::string::String::from("0190a000-0000-7000-8000-000000000007"),
                name: alloc::string::String::from("Work"),
                color: alloc::string::String::from("moss"),
                enabled: true,
                filter: crate::saved_view::FilterNode::HasTag {
                    tag: alloc::string::String::from("work"),
                },
            }],
            ai_excluded_folders: Vec::new(),
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            archived_folders: Vec::new(),
            reminder_horizon_days: Some(7),
            folder_icons: Default::default(),
            device_names: Default::default(),
            // set array (sorted + deduped) — the bottom-bar hidden set
            hidden_bar_items: alloc::vec![
                alloc::string::String::from("graph"),
                alloc::string::String::from("word-count"),
            ],
            icon: Some(alloc::string::String::from("book")),
            item_colors: Default::default(),
            keymap: Default::default(),
            theme: None,
            deliberate_folders: alloc::vec![
                alloc::string::String::from("Archive/2025/"),
                alloc::string::String::from("Projects/Myne/"),
            ],
            auto_lock_seconds: Some(300),
            auto_tag_enabled: false,
            custom_theme: Some(alloc::string::String::from("solarized-dark")),
            daily_date_format: None,
            daily_folder: None,
            daily_template: None,
            date_format: None,
            favorites: alloc::vec![alloc::string::String::from(
                "0190a000-0000-7000-8000-000000000002",
            )],
            // MYND-596 container-keyed: the root container interleaves a note,
            // the "Projects/" folder, and another note; "Projects/" then orders
            // its own child sub-folder. Keys emit in lexicographic order
            // ("" < "Projects/"); each value sequence is order-preserving.
            item_order: BTreeMap::from([
                (
                    alloc::string::String::from(""),
                    alloc::vec![
                        alloc::string::String::from("0190a000-0000-7000-8000-000000000002"),
                        alloc::string::String::from("Projects/"),
                        alloc::string::String::from("0190a000-0000-7000-8000-000000000001"),
                    ],
                ),
                (
                    // Container key is the FOLDED folder key (`projects/`), not
                    // the display path — matches the clients' `folderKey`
                    // identity so both derive byte-identical keys (MYND-596).
                    alloc::string::String::from("projects/"),
                    alloc::vec![alloc::string::String::from("Projects/Myne/")],
                ),
            ]),
            active_workspace: Some(alloc::string::String::from(
                "0190a000-0000-7000-8000-0000000000ff",
            )),
            archive_disabled: None,
            editor_layout: Some(EditorLayout {
                left_width: 312,
                right_width: 288,
                left_collapsed: false,
                right_collapsed: true,
            }),
            editor_line_numbers: Some(true),
            editor_content_width: Some(alloc::string::String::from("wide")),
            editor_default_view_mode: Some(alloc::string::String::from("reading")),
            editor_focus_dim_inactive: Some(true),
            editor_focus_typewriter: Some(false),
            editor_font_family: Some(alloc::string::String::from("sans")),
            editor_line_spacing: Some(alloc::string::String::from("relaxed")),
            editor_text_size: Some(alloc::string::String::from("lg")),
            editor_vim_mode: Some(true),
            label: Some(alloc::string::String::from("Work")),
            last_backup_at: Some(1765432100),
            new_note_location: Some(alloc::string::String::from("specific")),
            new_note_location_folder: Some(alloc::string::String::from("Inbox/")),
            paired_extensions: Vec::new(),
            right_panel_active_tab: Some(alloc::string::String::from("backlinks")),
            // set array (sorted + deduped)
            right_panel_hidden_tabs: alloc::vec![alloc::string::String::from("outline")],
            // sequence array (order preserved verbatim)
            right_panel_tab_order: alloc::vec![
                alloc::string::String::from("backlinks"),
                alloc::string::String::from("unlinked"),
                alloc::string::String::from("outline"),
            ],
            // set arrays (sorted + deduped)
            editor_slash_hidden: alloc::vec![
                alloc::string::String::from("callout"),
                alloc::string::String::from("table"),
            ],
            editor_toolbar_hidden: alloc::vec![
                alloc::string::String::from("quote"),
                alloc::string::String::from("wikilink"),
            ],
            // sequence arrays (order preserved verbatim)
            editor_slash_order: alloc::vec![
                alloc::string::String::from("h1"),
                alloc::string::String::from("todo"),
                alloc::string::String::from("divider"),
            ],
            editor_toolbar_order: alloc::vec![
                alloc::string::String::from("bold"),
                alloc::string::String::from("italic"),
                alloc::string::String::from("link"),
                alloc::string::String::from("heading"),
            ],
            spell_enabled: Some(true),
            // set array (sorted + deduped)
            spell_languages: alloc::vec![
                alloc::string::String::from("en-US"),
                alloc::string::String::from("tr-TR"),
            ],
            startup_open: Some(alloc::string::String::from("specific")),
            startup_open_note: Some(alloc::string::String::from(
                "0190a000-0000-7000-8000-000000000006",
            )),
            saved_views: Vec::new(),
            view_order: Vec::new(),
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

        // decrypt-populated — round-trip with encrypt-populated. Generated here
        // (no longer hand-derived) so the expected_prefs_view can never drift
        // from the encrypt case's PrefsView. The canonical plaintext IS valid
        // JSON, so paste `expected_prefs_view` from `plaintext_canonical_utf8`
        // below as the case's `expected_prefs_view` object verbatim.
        dump.push_str("# case: decrypt-populated (round-trip with encrypt-populated)\n");
        dump.push_str(&alloc::format!(
            "input_blob_hex: {}\n",
            hex_lower(&blob_populated)
        ));
        dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
        dump.push_str(&alloc::format!(
            "account_number_hash_hex: {}\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str("expected_kind: ok\n");
        dump.push_str(&alloc::format!(
            "expected_plaintext_utf8_hex: {}\n",
            hex_lower(&canonical_populated)
        ));
        dump.push_str(&alloc::format!(
            "expected_prefs_view (canonical JSON — paste as the object verbatim): {}\n\n",
            core::str::from_utf8(&canonical_populated).unwrap_or("<non-utf8>")
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

    /// Generator for the MYND-205 `label` + §9.5.2 forward-compat vector
    /// cases (appended to the companion repo's `vault-prefs` family; the
    /// per-feature-generator pattern of [`emit_decorations_prefs_vector`]
    /// keeps the original [`emit_prefs_vectors_for_paste`] stable):
    ///
    /// `cargo test -p protocol --lib emit_label_and_tolerance_prefs_vectors -- --ignored`
    ///
    /// - `encrypt-labeled`: `item_order` + `label` set, the label given in
    ///   NFD in this source (`Cafe\u{0301}`) so the emitted canonical bytes
    ///   pin the NFC normalization (`Caf\u{e9}`) AND the canonical key order
    ///   `item_order` (i) < `label` (l) < `screen_capture_protection` (s).
    /// - `decrypt-labeled`: round-trip of the blob above; decoders must
    ///   surface the label.
    /// - `decrypt-unknown-field-tolerated`: a blob sealed over a plaintext
    ///   carrying a genuinely unknown future field (`zz_future_pref`, in
    ///   sorted position after `theme`); decoders must recover the known
    ///   fields and ignore the unknown one (spec § 9.5.2 forward-compat).
    ///   Sealed manually (header assembly mirrors `encode_prefs_blob_raw`)
    ///   because the typed encoder can only emit canonical v0.1 plaintexts.
    #[test]
    #[ignore]
    fn emit_label_and_tolerance_prefs_vectors() {
        extern crate std;

        // Same fixed vault-A inputs as the sibling generators; nonces 0xDD /
        // 0xEE are the next free entries in the family's nonce registry
        // (0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC are taken).
        let root_a: [u8; 32] = [0x42; 32];
        let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
        let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);

        // --- encrypt-labeled + decrypt-labeled -----------------------------
        let nonce_labeled: [u8; AEAD_NONCE_LEN] = [0xDD; AEAD_NONCE_LEN];
        let prefs_labeled = PrefsView {
            item_order: BTreeMap::from([(
                String::from(""),
                alloc::vec![
                    String::from("0190a000-0000-7000-8000-000000000001"),
                    String::from("Projects/Myne/"),
                ],
            )]),
            // NFD on purpose: 'e' + U+0301 combining acute. The encoder must
            // emit the NFC form (U+00E9, bytes c3 a9).
            label: Some(String::from("Cafe\u{301}")),
            ..PrefsView::default()
        };
        let canonical_labeled = canonical_json_encode(&prefs_labeled);
        assert_eq!(
            canonical_labeled.as_slice(),
            b"{\"item_order\":{\"\":[\"0190a000-0000-7000-8000-000000000001\",\"Projects/Myne/\"]},\"label\":\"Caf\xc3\xa9\",\"screen_capture_protection\":true}"
                .as_slice(),
            "canonical plaintext must NFC-normalize the label and sort i < l < s",
        );
        let blob_labeled = encode_prefs_blob_raw(
            &prefs_key_a,
            &account_hash_a,
            &prefs_labeled,
            &nonce_labeled,
        )
        .expect("encode labeled");
        // Round-trip self-validation: the decoded view carries the NFC label.
        let expected_labeled_view = PrefsView {
            item_order: prefs_labeled.item_order.clone(),
            label: Some(String::from("Caf\u{e9}")),
            ..PrefsView::default()
        };
        let decoded_labeled =
            decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_labeled).expect("decode");
        assert_eq!(decoded_labeled, expected_labeled_view);

        // --- decrypt-unknown-field-tolerated -------------------------------
        let nonce_tolerance: [u8; AEAD_NONCE_LEN] = [0xEE; AEAD_NONCE_LEN];
        // `zz_future_pref` sorts after `theme` — the cursor-based decoder
        // expects additive fields at their lexicographic position.
        let plaintext_future: &[u8] =
            br#"{"screen_capture_protection":true,"theme":"dark","zz_future_pref":7}"#;
        let aad = aad_prefs_blob(&account_hash_a);
        let sealed =
            aead_seal_ctx(&prefs_key_a, &nonce_tolerance, plaintext_future, &aad).expect("seal");
        let mut blob_tolerance = Vec::with_capacity(PREFS_BLOB_HEADER_LEN + sealed.len());
        blob_tolerance.extend_from_slice(&PREFS_BLOB_MAGIC);
        blob_tolerance.push(PREFS_BLOB_PROTOCOL_VERSION);
        blob_tolerance.push(PREFS_BLOB_RESERVED);
        blob_tolerance.extend_from_slice(&nonce_tolerance);
        blob_tolerance.extend_from_slice(&(sealed.len() as u32).to_be_bytes());
        blob_tolerance.extend_from_slice(&sealed);

        let expected_tolerance_view = PrefsView {
            theme: Some(ThemeChoice::Dark),
            ..PrefsView::default()
        };
        let decoded_tolerance = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_tolerance)
            .expect("decode tolerance blob");
        assert_eq!(
            decoded_tolerance, expected_tolerance_view,
            "unknown future field must be ignored, known fields recovered",
        );
        // The canonical re-encode of the decoded view — what the runner pins
        // as expected_plaintext_canonical_utf8_hex (NOT the sealed bytes).
        let canonical_tolerance = canonical_json_encode(&decoded_tolerance);
        assert_eq!(
            canonical_tolerance.as_slice(),
            br#"{"screen_capture_protection":true,"theme":"dark"}"#.as_slice(),
        );

        let mut dump = alloc::string::String::new();
        dump.push_str("---begin label + tolerance prefs vectors---\n\n");

        dump.push_str("# case 1/3: encrypt-labeled (MYND-205; NFD source -> NFC bytes; i<l<s)\n");
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
            hex_lower(&canonical_labeled)
        ));
        dump.push_str(&alloc::format!(
            "plaintext_canonical_utf8: {}\n",
            core::str::from_utf8(&canonical_labeled).unwrap_or("<non-utf8>")
        ));
        dump.push_str(&alloc::format!(
            "prefs_nonce_hex: {}\n",
            hex_lower(&nonce_labeled)
        ));
        dump.push_str(&alloc::format!(
            "expected_prefs_blob_hex: {}\n\n",
            hex_lower(&blob_labeled)
        ));

        dump.push_str("# case 2/3: decrypt-labeled (round-trip with case 1)\n");
        dump.push_str(&alloc::format!(
            "input_blob_hex: {}\n",
            hex_lower(&blob_labeled)
        ));
        dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
        dump.push_str(&alloc::format!(
            "account_number_hash_hex: {}\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str("expected_kind: ok\n");
        dump.push_str(&alloc::format!(
            "expected_plaintext_canonical_utf8_hex: {}\n",
            hex_lower(&canonical_labeled)
        ));
        dump.push_str(
            "expected_prefs_view: { \"item_order\": { \"\": [\"0190a000-0000-7000-8000-000000000001\", \"Projects/Myne/\"] }, \"label\": \"Café\", \"screen_capture_protection\": true }\n\n",
        );

        dump.push_str(
            "# case 3/3: decrypt-unknown-field-tolerated (spec \u{a7}9.5.2 forward-compat)\n",
        );
        dump.push_str(&alloc::format!(
            "input_blob_hex: {}\n",
            hex_lower(&blob_tolerance)
        ));
        dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
        dump.push_str(&alloc::format!(
            "account_number_hash_hex: {}\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str(&alloc::format!(
            "informational_sealed_plaintext_utf8_hex: {}\n",
            hex_lower(plaintext_future)
        ));
        dump.push_str(&alloc::format!(
            "informational_sealed_plaintext_utf8: {}\n",
            core::str::from_utf8(plaintext_future).unwrap_or("<non-utf8>")
        ));
        dump.push_str("expected_kind: ok\n");
        dump.push_str(&alloc::format!(
            "expected_plaintext_canonical_utf8_hex: {}\n",
            hex_lower(&canonical_tolerance)
        ));
        dump.push_str(
            "expected_prefs_view: { \"screen_capture_protection\": true, \"theme\": \"dark\" }\n\n",
        );

        dump.push_str("---end label + tolerance prefs vectors---\n");
        std::fs::write("/tmp/myne_vault_prefs_label_vectors.txt", dump.as_bytes())
            .expect("write label prefs vectors dump");
    }

    /// Mint the two `vault-prefs` cases pinning the **remote-provider triple**
    /// (myne#415). A separate per-feature generator, per this family's
    /// convention — `emit_prefs_vectors_for_paste` and its siblings stay
    /// byte-stable so already-shipped vectors never move.
    ///
    /// It emits ready-to-append **JSON case objects** rather than the
    /// human-transcribed "paste" text the older siblings produce: the
    /// transcription step is where a hand-copied hex digit goes wrong, and
    /// there is no reason to keep paying for it.
    ///
    /// Nonce `0xF1` — the next free entry in this family's nonce registry
    /// (0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE are taken).
    #[test]
    #[ignore = "generator: mints vault-prefs provider-triple cases for the companion repo"]
    #[cfg_attr(coverage_nightly, coverage(off))]
    fn emit_ai_provider_prefs_vectors() {
        extern crate std;

        let root_a: [u8; 32] = [0x42; 32];
        let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
        let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);
        let nonce: [u8; AEAD_NONCE_LEN] = [0xF1; AEAD_NONCE_LEN];

        // Both lexicographic neighbours are present, so the case pins the
        // quartet's canonical POSITION and not merely its presence.
        let view = PrefsView {
            ai_excluded_folders: alloc::vec![String::from("Private/")],
            ai_provider: Some(String::from("openrouter")),
            ai_provider_consent: Some(alloc::string::String::from("openrouter")),
            ai_provider_key: Some(Zeroizing::new(String::from("sk-vector-fixture-000"))),
            ai_provider_model: Some(String::from("meta-llama/llama-3.1-8b")),
            archive_disabled: Some(true),
            ..PrefsView::default()
        };
        let canonical = canonical_json_encode(&view);
        assert_eq!(
            canonical.as_slice(),
            br#"{"ai_excluded_folders":["Private/"],"ai_provider":"openrouter","ai_provider_consent":"openrouter","ai_provider_key":"sk-vector-fixture-000","ai_provider_model":"meta-llama/llama-3.1-8b","archive_disabled":true,"screen_capture_protection":true}"#.as_slice(),
            "canonical order must be ai_excluded_folders < ai_provider < ai_provider_consent < ai_provider_key < ai_provider_model < archive_disabled < screen_capture_protection",
        );
        let blob = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &view, &nonce)
            .expect("encode provider triple");
        // Self-validating at mint: the blob decodes back to the same view.
        let back = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob).expect("decode");
        assert_eq!(back, view);

        let mut dump = alloc::string::String::new();
        dump.push_str("[\n");
        dump.push_str("  {\n");
        dump.push_str("    \"vector_id\": \"vault-prefs/v0.1/encrypt-ai-provider\",\n");
        dump.push_str("    \"description\": \"myne#415 remote-provider quartet. PrefsView carries BOTH lexicographic neighbours (ai_excluded_folders before, archive_disabled after) so the case pins the canonical POSITION of ai_provider < ai_provider_consent < ai_provider_key < ai_provider_model, not merely their presence. ai_provider_key is present in the ENCRYPTED blob and MUST NOT cross the host->UI boundary in any implementation (protocol.md 9.5.2). Generated by `cargo test -p protocol --lib emit_ai_provider_prefs_vectors -- --ignored` (in protocol/src/prefs.rs).\",\n");
        dump.push_str("    \"case_kind\": \"encrypt\",\n");
        dump.push_str(&alloc::format!(
            "    \"input_root_key_hex\": \"{}\",\n",
            hex_lower(&root_a)
        ));
        dump.push_str(&alloc::format!(
            "    \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str(&alloc::format!(
            "    \"input_plaintext_canonical_utf8_hex\": \"{}\",\n",
            hex_lower(&canonical)
        ));
        dump.push_str(&alloc::format!(
            "    \"input_prefs_nonce_hex\": \"{}\",\n",
            hex_lower(&nonce)
        ));
        dump.push_str(&alloc::format!(
            "    \"informational_prefs_key_hex\": \"{}\",\n",
            hex_lower(&*prefs_key_a)
        ));
        dump.push_str(&alloc::format!(
            "    \"expected_prefs_blob_hex\": \"{}\"\n",
            hex_lower(&blob)
        ));
        dump.push_str("  },\n");
        dump.push_str("  {\n");
        dump.push_str("    \"vector_id\": \"vault-prefs/v0.1/decrypt-ai-provider\",\n");
        dump.push_str("    \"description\": \"Round-trip with encrypt-ai-provider: the blob decodes back to a PrefsView carrying the provider selection, the consent name, the key and the chosen model, each read from its canonical position between ai_excluded_folders and archive_disabled. A decoder that mis-orders the quartet fails here rather than silently returning a shifted value.\",\n");
        dump.push_str("    \"case_kind\": \"decrypt_ok\",\n");
        dump.push_str(&alloc::format!(
            "    \"input_blob_hex\": \"{}\",\n",
            hex_lower(&blob)
        ));
        dump.push_str(&alloc::format!(
            "    \"input_root_key_hex\": \"{}\",\n",
            hex_lower(&root_a)
        ));
        dump.push_str(&alloc::format!(
            "    \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str(&alloc::format!(
            "    \"expected_plaintext_canonical_utf8_hex\": \"{}\",\n",
            hex_lower(&canonical)
        ));
        dump.push_str("    \"expected_prefs_view\": {\n");
        dump.push_str("      \"ai_excluded_folders\": [\"Private/\"],\n");
        dump.push_str("      \"ai_provider\": \"openrouter\",\n");
        dump.push_str("      \"ai_provider_consent\": \"openrouter\",\n");
        dump.push_str("      \"ai_provider_key\": \"sk-vector-fixture-000\",\n");
        dump.push_str("      \"ai_provider_model\": \"meta-llama/llama-3.1-8b\",\n");
        dump.push_str("      \"archive_disabled\": true,\n");
        dump.push_str("      \"screen_capture_protection\": true\n");
        dump.push_str("    }\n");
        dump.push_str("  }\n");
        dump.push_str("]\n");

        std::fs::write(
            "/tmp/myne_vault_prefs_provider_vectors.json",
            dump.as_bytes(),
        )
        .expect("write provider prefs vectors dump");
    }

    /// Generator for the `device_names` vector pair (appended to the companion
    /// repo's `vault-prefs` family; per-feature generator, keeps the originals
    /// byte-stable) — pins the MYND-459 / SYNC-41 `device_names` additive field
    /// (`docs/spec/protocol.md` §9.5). Golden AEAD bytes cannot be hand-authored,
    /// so this `#[ignore]` emitter is the mechanism even though the companion
    /// vectors are the deliverable — it emits, it is not a runtime test.
    ///
    /// `cargo test -p protocol --lib emit_device_names_prefs_vectors -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn emit_device_names_prefs_vectors() {
        extern crate std;
        // Same fixed vault-A inputs as the sibling generators. Nonce 0xF6 is the
        // next free entry in the family's nonce registry (0x77–0xF5 taken;
        // 0xB1/0xB2 = paired_extensions).
        let root_a: [u8; 32] = [0x42; 32];
        let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
        let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);
        let nonce: [u8; AEAD_NONCE_LEN] = [0xF6; AEAD_NONCE_LEN];

        // Two device_id (hex) → friendly-name entries. `map_of` collects into a
        // BTreeMap; the encoder emits keys in lexicographic order regardless of
        // insertion order, so the sort is load-bearing (1a2b… < f9e8…).
        let prefs = PrefsView {
            device_names: map_of(&[
                ("f9e8d7c6b5a4938271605f4e3d2c1b0a", "Phone"),
                ("1a2b3c4d5e6f708192a3b4c5d6e7f809", "Work Laptop"),
            ]),
            ..PrefsView::default()
        };
        let canonical = canonical_json_encode(&prefs);
        assert_eq!(
            canonical.as_slice(),
            br#"{"device_names":{"1a2b3c4d5e6f708192a3b4c5d6e7f809":"Work Laptop","f9e8d7c6b5a4938271605f4e3d2c1b0a":"Phone"},"screen_capture_protection":true}"#.as_slice(),
            "device_names sorts keys lexicographically + sits at canonical 'd' before screen_capture_protection",
        );
        let blob = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs, &nonce)
            .expect("encode device_names");
        // Round-trip self-validation.
        let decoded = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob).expect("decode");
        assert_eq!(decoded, prefs);

        std::println!("---begin device_names prefs vectors---");
        std::println!("input_root_key_hex: {}", hex_lower(&root_a));
        std::println!(
            "input_account_number_hash_hex: {}",
            hex_lower(&account_hash_a)
        );
        std::println!("input_prefs_nonce_hex: {}", hex_lower(&nonce));
        std::println!("informational_prefs_key_hex: {}", hex_lower(&*prefs_key_a));
        std::println!(
            "input_plaintext_canonical_utf8_hex: {}",
            hex_lower(&canonical)
        );
        std::println!("expected_prefs_blob_hex: {}", hex_lower(&blob));
        std::println!("---end device_names prefs vectors---");
    }

    /// Generator for the `paired_extensions` vector pair (appended to the
    /// companion repo's `vault-prefs` family; per-feature generator, keeps the
    /// originals byte-stable):
    ///
    /// `cargo test -p protocol --lib emit_paired_extensions_prefs_vectors -- --ignored`
    ///
    /// Pins the MYND-443 browser-clipper pairing-token persistence + the
    /// MYND-442 `paired_at` additive field (`design-notes.md` 2026-06-21):
    ///
    /// - `encrypt-paired-extensions`: a `PrefsView` carrying a two-record
    ///   `paired_extensions` array — one record WITHOUT `paired_at` (the
    ///   pre-feature, byte-identical encoding; `revoked: true`) and one WITH
    ///   `paired_at` (`revoked: false`). Pins (a) the canonical record key
    ///   order `extension_id < paired_at < revoked < token_value` with
    ///   `paired_at` emitted as a bare decimal u64 in its canonical slot, (b)
    ///   the omitted-when-`None` rule (record 1 is identical to a pre-MYND-442
    ///   record), (c) the array sort by `(extension_id, token_value)` — the
    ///   records are constructed out of sort order here so the encoder's sort
    ///   is load-bearing — and (d) the `paired_extensions` (p) < `screen_
    ///   capture_protection` (s) field order on `PrefsView`.
    /// - `decrypt-paired-extensions`: round-trip of the blob above; decoders
    ///   must surface both records, including the `paired_at` on record 2 and
    ///   its absence (`None`) on record 1.
    ///
    /// Nonce `0xB1` is the next free entry in the family's nonce registry
    /// (0x77–0xF5 partially taken; 0xB1/0xB2 free).
    #[test]
    #[ignore]
    fn emit_paired_extensions_prefs_vectors() {
        extern crate std;
        use crate::paired_extension::PairedExtension;

        // Same fixed vault-A inputs as the sibling generators.
        let root_a: [u8; 32] = [0x42; 32];
        let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
        let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);
        let nonce_paired: [u8; AEAD_NONCE_LEN] = [0xB1; AEAD_NONCE_LEN];

        // 64-hex token values (hex of 32 CSPRNG bytes); fixed test patterns.
        let token_a =
            String::from("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let token_b =
            String::from("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        // Constructed OUT of canonical sort order (Firefox record first) so the
        // encoder's `(extension_id, token_value)` sort is exercised: the Chrome
        // record (`abcd…` < `clipper@…`) must lead in the emitted bytes.
        let prefs_paired = PrefsView {
            paired_extensions: alloc::vec![
                PairedExtension {
                    extension_id: String::from("clipper@myne.md"),
                    token_value: token_a.clone(),
                    revoked: false,
                    paired_at: Some(1_750_000_000),
                },
                PairedExtension {
                    extension_id: String::from("abcdefghijklmnopabcdefghijklmnop"),
                    token_value: token_b.clone(),
                    revoked: true,
                    paired_at: None,
                },
            ],
            ..PrefsView::default()
        };
        let canonical_paired = canonical_json_encode(&prefs_paired);
        // The Chrome record (no `paired_at`, `revoked:true`) leads; the Firefox
        // record carries `paired_at` in its canonical slot between extension_id
        // and revoked. `paired_extensions` (p) sorts before screen_capture (s).
        assert_eq!(
            core::str::from_utf8(&canonical_paired).unwrap(),
            "{\"paired_extensions\":[\
{\"extension_id\":\"abcdefghijklmnopabcdefghijklmnop\",\"revoked\":true,\
\"token_value\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"},\
{\"extension_id\":\"clipper@myne.md\",\"paired_at\":1750000000,\"revoked\":false,\
\"token_value\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}\
],\"screen_capture_protection\":true}",
            "paired_at omitted on record 1, present (bare u64) on record 2; array sorted; p<s",
        );
        let blob_paired =
            encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs_paired, &nonce_paired)
                .expect("encode paired");
        // Round-trip: decoder surfaces both records incl. the paired_at split.
        let decoded_paired =
            decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_paired).expect("decode");
        assert_eq!(decoded_paired.paired_extensions.len(), 2);
        // Decoded order follows the canonical (sorted) bytes: Chrome then Firefox.
        assert_eq!(decoded_paired.paired_extensions[0].paired_at, None);
        assert_eq!(
            decoded_paired.paired_extensions[1].paired_at,
            Some(1_750_000_000)
        );

        let mut dump = alloc::string::String::new();
        dump.push_str("---begin paired_extensions prefs vectors---\n\n");

        dump.push_str(
            "# case 1/2: encrypt-paired-extensions (MYND-443/442; paired_at omitted|present; sort; p<s)\n",
        );
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
            hex_lower(&canonical_paired)
        ));
        dump.push_str(&alloc::format!(
            "plaintext_canonical_utf8: {}\n",
            core::str::from_utf8(&canonical_paired).unwrap_or("<non-utf8>")
        ));
        dump.push_str(&alloc::format!(
            "prefs_nonce_hex: {}\n",
            hex_lower(&nonce_paired)
        ));
        dump.push_str(&alloc::format!(
            "expected_prefs_blob_hex: {}\n\n",
            hex_lower(&blob_paired)
        ));

        dump.push_str("# case 2/2: decrypt-paired-extensions (round-trip with case 1)\n");
        dump.push_str(&alloc::format!(
            "input_blob_hex: {}\n",
            hex_lower(&blob_paired)
        ));
        dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
        dump.push_str(&alloc::format!(
            "account_number_hash_hex: {}\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str("expected_kind: ok\n");
        dump.push_str(&alloc::format!(
            "expected_plaintext_canonical_utf8_hex: {}\n",
            hex_lower(&canonical_paired)
        ));
        dump.push_str(
            "expected_prefs_view: { \"paired_extensions\": [ \
{ \"extension_id\": \"abcdefghijklmnopabcdefghijklmnop\", \"revoked\": true, \"token_value\": \"bbbb…(64)\" }, \
{ \"extension_id\": \"clipper@myne.md\", \"paired_at\": 1750000000, \"revoked\": false, \"token_value\": \"aaaa…(64)\" } \
], \"screen_capture_protection\": true }\n\n",
        );

        dump.push_str("---end paired_extensions prefs vectors---\n");
        std::fs::write(
            "/tmp/myne_vault_prefs_paired_extensions_vectors.txt",
            dump.as_bytes(),
        )
        .expect("write paired_extensions prefs vectors dump");
    }

    /// Generator for the AMOLED `theme` vector case (appended to the companion
    /// repo's `vault-prefs` family; per-feature generator, keeps the originals
    /// byte-stable):
    ///
    /// `cargo test -p protocol --lib emit_amoled_theme_prefs_vector -- --ignored`
    ///
    /// One `encrypt` + one `decrypt_ok` case for a prefs blob carrying the
    /// third explicit theme value (`ThemeChoice::Amoled` → canonical
    /// `"theme":"amoled"`). Pins the lowercase variant string the serializer
    /// emits and the round-trip back through the decoder, the cross-impl
    /// contract for the AMOLED theme. Nonce `0xA0` is the next free entry in
    /// the family's nonce registry (0x77–0xEE taken by the sibling generators).
    #[test]
    #[ignore]
    fn emit_amoled_theme_prefs_vector() {
        extern crate std;

        let root_a: [u8; 32] = [0x42; 32];
        let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
        let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);

        let nonce_amoled: [u8; AEAD_NONCE_LEN] = [0xA0; AEAD_NONCE_LEN];
        let prefs_amoled = PrefsView {
            theme: Some(ThemeChoice::Amoled),
            ..PrefsView::default()
        };
        let canonical_amoled = canonical_json_encode(&prefs_amoled);
        assert_eq!(
            canonical_amoled.as_slice(),
            br#"{"screen_capture_protection":true,"theme":"amoled"}"#.as_slice(),
            "canonical plaintext must emit the lowercase amoled variant, theme last",
        );
        let blob_amoled =
            encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs_amoled, &nonce_amoled)
                .expect("encode amoled");
        let decoded_amoled =
            decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_amoled).expect("decode amoled");
        assert_eq!(decoded_amoled, prefs_amoled);
        assert_eq!(decoded_amoled.theme, Some(ThemeChoice::Amoled));

        let mut dump = alloc::string::String::new();
        dump.push_str("---begin amoled theme prefs vectors---\n\n");

        dump.push_str("# case 1/2: encrypt-themed-amoled\n");
        dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
        dump.push_str(&alloc::format!(
            "account_number_hash_hex: {}\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str(&alloc::format!(
            "plaintext_canonical_utf8_hex: {}\n",
            hex_lower(&canonical_amoled)
        ));
        dump.push_str(&alloc::format!(
            "plaintext_canonical_utf8: {}\n",
            core::str::from_utf8(&canonical_amoled).unwrap_or("<non-utf8>")
        ));
        dump.push_str(&alloc::format!(
            "prefs_nonce_hex: {}\n",
            hex_lower(&nonce_amoled)
        ));
        dump.push_str(&alloc::format!(
            "expected_prefs_blob_hex: {}\n\n",
            hex_lower(&blob_amoled)
        ));

        dump.push_str("# case 2/2: decrypt-themed-amoled (round-trip with case 1)\n");
        dump.push_str(&alloc::format!(
            "input_blob_hex: {}\n",
            hex_lower(&blob_amoled)
        ));
        dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
        dump.push_str(&alloc::format!(
            "account_number_hash_hex: {}\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str("expected_kind: ok\n");
        dump.push_str(&alloc::format!(
            "expected_plaintext_canonical_utf8_hex: {}\n",
            hex_lower(&canonical_amoled)
        ));
        dump.push_str(
            "expected_prefs_view: { \"screen_capture_protection\": true, \"theme\": \"amoled\" }\n\n",
        );

        dump.push_str("---end amoled theme prefs vectors---\n");
        std::fs::write("/tmp/myne_vault_prefs_amoled_vectors.txt", dump.as_bytes())
            .expect("write amoled prefs vectors dump");
    }

    /// Generator for the local-ai `ai_enabled` + `ai_excluded_folders` vector
    /// cases (MYND-408 / SYNC-12/14; appended to the companion repo's
    /// `vault-prefs` family — per-feature generator, keeps the originals
    /// byte-stable):
    ///
    /// `cargo test -p protocol --lib emit_ai_prefs_vectors -- --ignored`
    ///
    /// One `encrypt` + one `decrypt_ok` case for a prefs blob carrying the two
    /// additive local-AI fields — `ai_enabled: true` and a one-entry
    /// `ai_excluded_folders: ["Private/"]`. Pins the canonical key positions
    /// (`ai_enabled` < `ai_excluded_folders` < `screen_capture_protection`, all
    /// alphabetical) + the folder-set encoding (same `canonical_folder_list`
    /// codec as `deliberate_folders`), the cross-impl MYP1 contract for the AI
    /// prefs. Nonce `0xA1` (next free after `0xA0` amoled).
    #[test]
    #[ignore]
    fn emit_ai_prefs_vectors() {
        extern crate std;

        let root_a: [u8; 32] = [0x42; 32];
        let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
        let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);

        let nonce_ai: [u8; AEAD_NONCE_LEN] = [0xA1; AEAD_NONCE_LEN];
        let prefs_ai = PrefsView {
            ai_enabled: true,
            ai_excluded_folders: alloc::vec![alloc::string::String::from("Private/")],
            ai_provider: None,
            ai_provider_consent: None,
            ai_provider_key: None,
            ai_provider_model: None,
            ..PrefsView::default()
        };
        let canonical_ai = canonical_json_encode(&prefs_ai);
        assert_eq!(
            canonical_ai.as_slice(),
            br#"{"ai_enabled":true,"ai_excluded_folders":["Private/"],"screen_capture_protection":true}"#.as_slice(),
            "canonical plaintext must emit ai_enabled < ai_excluded_folders < screen_capture_protection",
        );
        let blob_ai = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs_ai, &nonce_ai)
            .expect("encode ai");
        let decoded_ai =
            decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_ai).expect("decode ai");
        assert_eq!(decoded_ai, prefs_ai);
        assert!(decoded_ai.ai_enabled);
        assert_eq!(
            decoded_ai.ai_excluded_folders,
            alloc::vec![alloc::string::String::from("Private/")]
        );

        let mut dump = alloc::string::String::new();
        dump.push_str("---begin local-ai prefs vectors---\n\n");

        dump.push_str("# case 1/2: encrypt-ai-enabled-excluded\n");
        dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
        dump.push_str(&alloc::format!(
            "account_number_hash_hex: {}\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str(&alloc::format!(
            "plaintext_canonical_utf8_hex: {}\n",
            hex_lower(&canonical_ai)
        ));
        dump.push_str(&alloc::format!(
            "plaintext_canonical_utf8: {}\n",
            core::str::from_utf8(&canonical_ai).unwrap_or("<non-utf8>")
        ));
        dump.push_str(&alloc::format!(
            "prefs_nonce_hex: {}\n",
            hex_lower(&nonce_ai)
        ));
        dump.push_str(&alloc::format!(
            "expected_prefs_blob_hex: {}\n\n",
            hex_lower(&blob_ai)
        ));

        dump.push_str("# case 2/2: decrypt-ai-enabled-excluded (round-trip with case 1)\n");
        dump.push_str(&alloc::format!("input_blob_hex: {}\n", hex_lower(&blob_ai)));
        dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
        dump.push_str(&alloc::format!(
            "account_number_hash_hex: {}\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str("expected_kind: ok\n");
        dump.push_str(&alloc::format!(
            "expected_plaintext_canonical_utf8_hex: {}\n",
            hex_lower(&canonical_ai)
        ));
        dump.push_str(
            "expected_prefs_view: { \"ai_enabled\": true, \"ai_excluded_folders\": [\"Private/\"], \"screen_capture_protection\": true }\n\n",
        );

        dump.push_str("---end local-ai prefs vectors---\n");
        std::fs::write("/tmp/myne_vault_prefs_ai_vectors.txt", dump.as_bytes())
            .expect("write ai prefs vectors dump");
    }

    /// Generator for the MYND-273 `saved_views` + `view_order` vector cases
    /// (appended to the companion repo's `vault-prefs` family; per-feature
    /// generator, keeps the originals byte-stable):
    ///
    /// `cargo test -p protocol --lib emit_saved_views_prefs_vector -- --ignored`
    ///
    /// One `encrypt` + one `decrypt_ok` case for a prefs blob carrying a single
    /// saved view (a card view over `Books/` with a typed `rating > 4` filter,
    /// a sort, columns, and image fields) plus a `view_order`, pinning the
    /// canonical key positions `saved_views` (before `screen_capture_protection`)
    /// and `view_order` (last, after `theme`) and the saved-view sub-object's own
    /// lexicographic key + filter-AST encoding.
    #[test]
    #[ignore]
    fn emit_saved_views_prefs_vector() {
        extern crate std;

        let root_a: [u8; 32] = [0x42; 32];
        let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
        let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);
        // 0xF0 is the next free nonce in the family registry (…0xDD, 0xEE taken).
        let nonce: [u8; AEAD_NONCE_LEN] = [0xF0; AEAD_NONCE_LEN];

        let view = crate::saved_view::SavedView {
            id: String::from("0190a000-0000-7000-8000-000000000005"),
            name: String::from("Books"),
            view_type: crate::saved_view::ViewType::Cards,
            filters: crate::saved_view::FilterNode::And {
                children: alloc::vec![
                    crate::saved_view::FilterNode::InFolder {
                        path: String::from("Books/"),
                    },
                    crate::saved_view::FilterNode::Property {
                        key: String::from("rating"),
                        op: crate::saved_view::PropertyOp::Gt,
                        value: String::from("4"),
                    },
                ],
            },
            sort: Some(crate::saved_view::ViewSort {
                key: String::from("finished"),
                direction: crate::saved_view::SortDirection::Desc,
            }),
            group_by: Some(String::from("status")),
            columns: alloc::vec![String::from("author"), String::from("rating")],
            card_size: Some(300),
            image: Some(String::from("image")),
            image_aspect_ratio: Some(String::from("1.65")),
        };
        let prefs = PrefsView {
            saved_views: alloc::vec![view],
            view_order: alloc::vec![String::from("0190a000-0000-7000-8000-000000000005")],
            ..PrefsView::default()
        };

        let canonical = canonical_json_encode(&prefs);
        assert_eq!(
            canonical.as_slice(),
            br#"{"saved_views":[{"card_size":300,"columns":["author","rating"],"filters":{"children":[{"kind":"inFolder","path":"Books/"},{"key":"rating","kind":"property","op":">","value":"4"}],"kind":"and"},"group_by":"status","id":"0190a000-0000-7000-8000-000000000005","image":"image","image_aspect_ratio":"1.65","name":"Books","sort":{"direction":"desc","key":"finished"},"view_type":"cards"}],"screen_capture_protection":true,"view_order":["0190a000-0000-7000-8000-000000000005"]}"#.as_slice(),
            "canonical plaintext must place saved_views before screen_capture_protection and view_order last, with the saved-view sub-object + filter AST in lexicographic key order",
        );
        let blob = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs, &nonce)
            .expect("encode saved_views");
        // Round-trip self-validation.
        assert_eq!(
            decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob).expect("decode"),
            prefs,
        );

        let mut dump = alloc::string::String::new();
        dump.push_str("---begin saved_views prefs vector (MYND-273)---\n\n");
        dump.push_str("# case: encrypt-saved-views\n");
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
            hex_lower(&canonical)
        ));
        dump.push_str(&alloc::format!(
            "plaintext_canonical_utf8: {}\n",
            core::str::from_utf8(&canonical).unwrap_or("<non-utf8>")
        ));
        dump.push_str(&alloc::format!("prefs_nonce_hex: {}\n", hex_lower(&nonce)));
        dump.push_str(&alloc::format!(
            "expected_prefs_blob_hex: {}\n",
            hex_lower(&blob)
        ));
        dump.push_str("---end saved_views prefs vector---\n");
        std::fs::write(
            "/tmp/myne_vault_prefs_saved_views_vector.txt",
            dump.as_bytes(),
        )
        .expect("write saved_views prefs vector dump");
    }

    /// Generator for the MYND-58 `last_backup_at` vector cases (appended to
    /// the companion repo's `vault-prefs` family; per-feature-generator
    /// pattern of [`emit_label_and_tolerance_prefs_vectors`]):
    ///
    /// `cargo test -p protocol --lib emit_last_backup_at_prefs_vectors -- --ignored`
    ///
    /// - `encrypt-last-backup-at`: `label` + `last_backup_at` both set so the
    ///   emitted canonical bytes pin the order of the two 'l' keys
    ///   (`label` [lab] < `last_backup_at` [las] < `screen_capture_protection`)
    ///   and the bare-decimal u64 epoch encoding.
    /// - `decrypt-last-backup-at`: round-trip of the blob above; decoders
    ///   must surface the epoch value.
    #[test]
    #[ignore]
    fn emit_last_backup_at_prefs_vectors() {
        extern crate std;

        // Same fixed vault-A inputs as the sibling generators; nonce 0xF1 is
        // the next free entry in the family's nonce registry (0x77, 0x88,
        // 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE are taken).
        let root_a: [u8; 32] = [0x42; 32];
        let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
        let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);

        let nonce: [u8; AEAD_NONCE_LEN] = [0xF1; AEAD_NONCE_LEN];
        let prefs = PrefsView {
            label: Some(String::from("Work")),
            last_backup_at: Some(1765432100),
            paired_extensions: Vec::new(),
            right_panel_active_tab: None,
            right_panel_hidden_tabs: Vec::new(),
            right_panel_tab_order: Vec::new(),
            editor_slash_hidden: Vec::new(),
            editor_slash_order: Vec::new(),
            editor_toolbar_hidden: Vec::new(),
            editor_toolbar_order: Vec::new(),
            spell_enabled: None,
            spell_languages: Vec::new(),
            ..PrefsView::default()
        };
        let canonical = canonical_json_encode(&prefs);
        assert_eq!(
            canonical.as_slice(),
            br#"{"label":"Work","last_backup_at":1765432100,"screen_capture_protection":true}"#
                .as_slice(),
            "canonical plaintext must sort label < last_backup_at < screen_capture_protection",
        );
        let blob =
            encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs, &nonce).expect("encode");
        let decoded = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob).expect("decode");
        assert_eq!(decoded, prefs);

        let mut dump = alloc::string::String::new();
        dump.push_str("---begin last_backup_at prefs vectors---\n\n");

        dump.push_str("# case 1/2: encrypt-last-backup-at (MYND-58; lab < las < s; bare u64)\n");
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
            hex_lower(&canonical)
        ));
        dump.push_str(&alloc::format!(
            "plaintext_canonical_utf8: {}\n",
            core::str::from_utf8(&canonical).unwrap_or("<non-utf8>")
        ));
        dump.push_str(&alloc::format!("prefs_nonce_hex: {}\n", hex_lower(&nonce)));
        dump.push_str(&alloc::format!(
            "expected_prefs_blob_hex: {}\n\n",
            hex_lower(&blob)
        ));

        dump.push_str("# case 2/2: decrypt-last-backup-at (round-trip with case 1)\n");
        dump.push_str(&alloc::format!("input_blob_hex: {}\n", hex_lower(&blob)));
        dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
        dump.push_str(&alloc::format!(
            "account_number_hash_hex: {}\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str("expected_kind: ok\n");
        dump.push_str(&alloc::format!(
            "expected_plaintext_canonical_utf8_hex: {}\n",
            hex_lower(&canonical)
        ));
        dump.push_str(
            "expected_prefs_view: { \"label\": \"Work\", \"last_backup_at\": 1765432100, \"screen_capture_protection\": true }\n\n",
        );

        dump.push_str("---end last_backup_at prefs vectors---\n");
        std::fs::write(
            "/tmp/myne_vault_prefs_last_backup_vectors.txt",
            dump.as_bytes(),
        )
        .expect("write last_backup_at prefs vectors dump");
    }

    /// Generator for the editor-line-numbers (MYND-314) `editor_line_numbers`
    /// vector cases (appended to the companion repo's `vault-prefs` family;
    /// per-feature generator, keeps the originals byte-stable — the
    /// [`emit_amoled_theme_prefs_vector`] pattern):
    ///
    /// `cargo test -p protocol --lib emit_line_numbers_prefs_vector -- --ignored`
    ///
    /// One `encrypt` + one `decrypt_ok` case for a prefs blob carrying the
    /// optional line-number gutter toggle (`editor_line_numbers: Some(true)` →
    /// canonical `"editor_line_numbers":true`). Pins the bool encoding and its
    /// canonical key slot (after `editor_layout`, before
    /// `screen_capture_protection`) plus the round-trip back through the decoder.
    /// Nonce `0xF4` is the next free entry in the family's nonce registry
    /// (0x77–0xF3 taken by the sibling generators). Omit-when-`None` keeps an
    /// untouched vault byte-identical to a pre-feature blob (no encrypt case
    /// needed for that — `encrypt-default` already pins the bare form).
    #[test]
    #[ignore]
    fn emit_line_numbers_prefs_vector() {
        extern crate std;

        let root_a: [u8; 32] = [0x42; 32];
        let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
        let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);

        let nonce: [u8; AEAD_NONCE_LEN] = [0xF4; AEAD_NONCE_LEN];
        let prefs = PrefsView {
            editor_line_numbers: Some(true),
            ..PrefsView::default()
        };
        let canonical = canonical_json_encode(&prefs);
        assert_eq!(
            canonical.as_slice(),
            br#"{"editor_line_numbers":true,"screen_capture_protection":true}"#.as_slice(),
            "canonical plaintext must place editor_line_numbers before screen_capture_protection as a bare bool",
        );
        let blob = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs, &nonce)
            .expect("encode line_numbers");
        // Round-trip self-validation.
        let decoded = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob).expect("decode");
        assert_eq!(decoded, prefs);
        assert_eq!(decoded.editor_line_numbers, Some(true));

        let mut dump = alloc::string::String::new();
        dump.push_str("---begin editor_line_numbers prefs vectors (MYND-314)---\n\n");

        dump.push_str("# case 1/2: encrypt-editor-line-numbers\n");
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
            hex_lower(&canonical)
        ));
        dump.push_str(&alloc::format!(
            "plaintext_canonical_utf8: {}\n",
            core::str::from_utf8(&canonical).unwrap_or("<non-utf8>")
        ));
        dump.push_str(&alloc::format!("prefs_nonce_hex: {}\n", hex_lower(&nonce)));
        dump.push_str(&alloc::format!(
            "expected_prefs_blob_hex: {}\n\n",
            hex_lower(&blob)
        ));

        dump.push_str("# case 2/2: decrypt-editor-line-numbers (round-trip with case 1)\n");
        dump.push_str(&alloc::format!("input_blob_hex: {}\n", hex_lower(&blob)));
        dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
        dump.push_str(&alloc::format!(
            "account_number_hash_hex: {}\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str("expected_kind: ok\n");
        dump.push_str(&alloc::format!(
            "expected_plaintext_canonical_utf8_hex: {}\n",
            hex_lower(&canonical)
        ));
        dump.push_str(
            "expected_prefs_view: { \"editor_line_numbers\": true, \"screen_capture_protection\": true }\n\n",
        );

        dump.push_str("---end editor_line_numbers prefs vectors---\n");
        std::fs::write(
            "/tmp/myne_vault_prefs_line_numbers_vector.txt",
            dump.as_bytes(),
        )
        .expect("write line_numbers prefs vector dump");
    }

    /// Generator for the `archive_disabled` (archive-disable) vector cases —
    /// appended to the companion repo's `vault-prefs` family (per-feature
    /// generator, keeps the originals byte-stable — the
    /// [`emit_line_numbers_prefs_vector`] pattern):
    ///
    /// `cargo test -p protocol --lib emit_archive_disabled_prefs_vector -- --ignored`
    ///
    /// One `encrypt` + one `decrypt_ok` case for a prefs blob carrying the
    /// optional archive-disable toggle (`archive_disabled: Some(true)` → canonical
    /// `"archive_disabled":true`). Pins the bool encoding and its canonical key
    /// slot (after `active_workspace`, before `auto_lock_seconds`) plus the
    /// round-trip back through the decoder. Nonce `0xA7` is a free entry in the
    /// family's nonce registry. Omit-when-`None` keeps an untouched vault
    /// byte-identical to a pre-feature blob (no encrypt case needed for that —
    /// `encrypt-default` already pins the bare form).
    #[test]
    #[ignore]
    fn emit_archive_disabled_prefs_vector() {
        extern crate std;

        let root_a: [u8; 32] = [0x42; 32];
        let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
        let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);

        let nonce: [u8; AEAD_NONCE_LEN] = [0xA7; AEAD_NONCE_LEN];
        let prefs = PrefsView {
            archive_disabled: Some(true),
            ..PrefsView::default()
        };
        let canonical = canonical_json_encode(&prefs);
        assert_eq!(
            canonical.as_slice(),
            br#"{"archive_disabled":true,"screen_capture_protection":true}"#.as_slice(),
            "canonical plaintext must place archive_disabled before screen_capture_protection as a bare bool",
        );
        let blob = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs, &nonce)
            .expect("encode archive_disabled");
        // Round-trip self-validation.
        let decoded = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob).expect("decode");
        assert_eq!(decoded, prefs);
        assert_eq!(decoded.archive_disabled, Some(true));

        let mut dump = alloc::string::String::new();
        dump.push_str("---begin archive_disabled prefs vectors (archive-disable)---\n\n");

        dump.push_str("# case 1/2: encrypt-archive-disabled\n");
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
            hex_lower(&canonical)
        ));
        dump.push_str(&alloc::format!(
            "plaintext_canonical_utf8: {}\n",
            core::str::from_utf8(&canonical).unwrap_or("<non-utf8>")
        ));
        dump.push_str(&alloc::format!("prefs_nonce_hex: {}\n", hex_lower(&nonce)));
        dump.push_str(&alloc::format!(
            "expected_prefs_blob_hex: {}\n\n",
            hex_lower(&blob)
        ));

        dump.push_str("# case 2/2: decrypt-archive-disabled (round-trip with case 1)\n");
        dump.push_str(&alloc::format!("input_blob_hex: {}\n", hex_lower(&blob)));
        dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
        dump.push_str(&alloc::format!(
            "account_number_hash_hex: {}\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str("expected_kind: ok\n");
        dump.push_str(&alloc::format!(
            "expected_plaintext_canonical_utf8_hex: {}\n",
            hex_lower(&canonical)
        ));
        dump.push_str(
            "expected_prefs_view: { \"archive_disabled\": true, \"screen_capture_protection\": true }\n\n",
        );

        dump.push_str("---end archive_disabled prefs vectors---\n");
        std::fs::write(
            "/tmp/myne_vault_prefs_archive_disabled_vector.txt",
            dump.as_bytes(),
        )
        .expect("write archive_disabled prefs vector dump");
    }

    /// Generator for the `archived_folders` (folder-archive) vector cases —
    /// appended to the companion repo's `vault-prefs` family (per-feature
    /// generator, keeps the originals byte-stable — the
    /// [`emit_archive_disabled_prefs_vector`] pattern):
    ///
    /// `cargo test -p protocol --lib emit_archived_folders_prefs_vectors -- --ignored`
    ///
    /// One `encrypt` + one `decrypt_ok` case for a prefs blob carrying the
    /// folder-archive set (`archived_folders: ["Alpha/","Zeta/"]`, given unsorted
    /// with a duplicate to pin the set-canonical sort+dedup). Its canonical key
    /// slot sits between `archive_disabled` and `auto_lock_seconds`, so both
    /// neighbors are present to pin the exact ordering. Nonce `0xAF` is a free
    /// entry in the family's nonce registry. Omit-when-empty keeps an untouched
    /// vault byte-identical to a pre-feature blob (`encrypt-default` pins the
    /// bare form).
    #[test]
    #[ignore]
    fn emit_archived_folders_prefs_vectors() {
        extern crate std;

        let root_a: [u8; 32] = [0x42; 32];
        let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
        let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);

        let nonce: [u8; AEAD_NONCE_LEN] = [0xAF; AEAD_NONCE_LEN];
        let prefs = PrefsView {
            archive_disabled: Some(true),
            archived_folders: alloc::vec![
                alloc::string::String::from("Zeta/"),
                alloc::string::String::from("Alpha/"),
                alloc::string::String::from("Alpha/"),
            ],
            auto_lock_seconds: Some(300),
            ..PrefsView::default()
        };
        let canonical = canonical_json_encode(&prefs);
        assert_eq!(
            canonical.as_slice(),
            br#"{"archive_disabled":true,"archived_folders":["Alpha/","Zeta/"],"auto_lock_seconds":300,"screen_capture_protection":true}"#.as_slice(),
            "canonical plaintext must sort+dedupe archived_folders and place it between archive_disabled and auto_lock_seconds",
        );
        let blob = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs, &nonce)
            .expect("encode archived_folders");
        let decoded = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob).expect("decode");
        // The encoder sorts + dedupes the set, so the decoded form carries the
        // canonical `["Alpha/","Zeta/"]` (not the unsorted+dup input struct).
        assert_eq!(
            decoded.archived_folders,
            alloc::vec![
                alloc::string::String::from("Alpha/"),
                alloc::string::String::from("Zeta/"),
            ]
        );
        assert_eq!(decoded.archive_disabled, Some(true));
        assert_eq!(decoded.auto_lock_seconds, Some(300));

        let mut dump = alloc::string::String::new();
        dump.push_str("---begin archived_folders prefs vectors (folder-archive)---\n\n");

        dump.push_str("# case 1/2: encrypt-archived-folders\n");
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
            hex_lower(&canonical)
        ));
        dump.push_str(&alloc::format!(
            "plaintext_canonical_utf8: {}\n",
            core::str::from_utf8(&canonical).unwrap_or("<non-utf8>")
        ));
        dump.push_str(&alloc::format!("prefs_nonce_hex: {}\n", hex_lower(&nonce)));
        dump.push_str(&alloc::format!(
            "expected_prefs_blob_hex: {}\n\n",
            hex_lower(&blob)
        ));

        dump.push_str("# case 2/2: decrypt-archived-folders (round-trip with case 1)\n");
        dump.push_str(&alloc::format!("input_blob_hex: {}\n", hex_lower(&blob)));
        dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
        dump.push_str(&alloc::format!(
            "account_number_hash_hex: {}\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str("expected_kind: ok\n");
        dump.push_str(&alloc::format!(
            "expected_plaintext_canonical_utf8_hex: {}\n",
            hex_lower(&canonical)
        ));
        dump.push_str(
            "expected_prefs_view: { \"archive_disabled\": true, \"archived_folders\": [\"Alpha/\", \"Zeta/\"], \"auto_lock_seconds\": 300, \"screen_capture_protection\": true }\n\n",
        );

        dump.push_str("---end archived_folders prefs vectors---\n");
        std::fs::write(
            "/tmp/myne_vault_prefs_archived_folders_vectors.txt",
            dump.as_bytes(),
        )
        .expect("write archived_folders prefs vector dump");
    }

    /// Generator for the batch editor-prefs (MYND-308 / MYND-299 / MYND-348)
    /// vector cases (appended to the companion repo's `vault-prefs` family;
    /// per-feature generator, keeps the originals byte-stable — the
    /// [`emit_line_numbers_prefs_vector`] pattern):
    ///
    /// `cargo test -p protocol --lib emit_batch_editor_prefs_vector -- --ignored`
    ///
    /// One `encrypt` + one `decrypt_ok` case for a prefs blob carrying all four
    /// optional batch fields at once — `active_workspace` (canonical FIRST key),
    /// `editor_default_view_mode` (string), `editor_focus_dim_inactive` +
    /// `editor_focus_typewriter` (bools). Pins the canonical key slots
    /// (active_workspace < … < editor_content_width < editor_default_view_mode <
    /// editor_focus_dim_inactive < editor_focus_typewriter < editor_font_family)
    /// and the string-vs-bare-bool encoding plus the round-trip back through the
    /// decoder. Nonce `0x95` is a free entry in the family's nonce registry.
    /// Omit-when-`None` keeps an untouched vault byte-identical to a pre-feature
    /// blob (no encrypt case needed for that — `encrypt-default` already pins it).
    #[test]
    #[ignore]
    fn emit_batch_editor_prefs_vector() {
        extern crate std;

        let root_a: [u8; 32] = [0x42; 32];
        let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
        let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);

        let nonce: [u8; AEAD_NONCE_LEN] = [0x95; AEAD_NONCE_LEN];
        let prefs = PrefsView {
            active_workspace: Some(alloc::string::String::from(
                "0190a000-0000-7000-8000-0000000000ff",
            )),
            editor_default_view_mode: Some(alloc::string::String::from("reading")),
            editor_focus_dim_inactive: Some(true),
            editor_focus_typewriter: Some(false),
            ..PrefsView::default()
        };
        let canonical = canonical_json_encode(&prefs);
        assert_eq!(
            canonical.as_slice(),
            br#"{"active_workspace":"0190a000-0000-7000-8000-0000000000ff","editor_default_view_mode":"reading","editor_focus_dim_inactive":true,"editor_focus_typewriter":false,"screen_capture_protection":true}"#.as_slice(),
            "canonical plaintext must place active_workspace first then the editor batch fields in canonical order",
        );
        let blob = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs, &nonce)
            .expect("encode batch editor prefs");
        // Round-trip self-validation.
        let decoded = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob).expect("decode");
        assert_eq!(decoded, prefs);

        let mut dump = alloc::string::String::new();
        dump.push_str("---begin batch editor prefs vectors (MYND-308/299/348)---\n\n");

        dump.push_str("# case 1/2: encrypt-batch-editor-prefs\n");
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
            hex_lower(&canonical)
        ));
        dump.push_str(&alloc::format!(
            "plaintext_canonical_utf8: {}\n",
            core::str::from_utf8(&canonical).unwrap_or("<non-utf8>")
        ));
        dump.push_str(&alloc::format!("prefs_nonce_hex: {}\n", hex_lower(&nonce)));
        dump.push_str(&alloc::format!(
            "expected_prefs_blob_hex: {}\n\n",
            hex_lower(&blob)
        ));

        dump.push_str("# case 2/2: decrypt-batch-editor-prefs (round-trip with case 1)\n");
        dump.push_str(&alloc::format!("input_blob_hex: {}\n", hex_lower(&blob)));
        dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
        dump.push_str(&alloc::format!(
            "account_number_hash_hex: {}\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str("expected_kind: ok\n");
        dump.push_str(&alloc::format!(
            "expected_plaintext_canonical_utf8_hex: {}\n\n",
            hex_lower(&canonical)
        ));

        dump.push_str("---end batch editor prefs vectors---\n");
        std::fs::write(
            "/tmp/myne_vault_prefs_batch_editor_vector.txt",
            dump.as_bytes(),
        )
        .expect("write batch editor prefs vector dump");
    }

    /// Generator for the MYND-304 `keymap` vector cases (hotkeys epic;
    /// appended to the companion repo's `vault-prefs` family; per-feature-
    /// generator pattern of [`emit_label_and_tolerance_prefs_vectors`], keeping
    /// the original generators byte-stable). Emits a JSON **array fragment** of
    /// 3 case objects at `/tmp/myne_vault_prefs_keymap_vectors.json`, spliced by
    /// hand into the existing `cases` array.
    ///
    /// `cargo test -p protocol --lib emit_keymap_prefs_vectors -- --ignored`
    ///
    /// - `encrypt-keymap`: `item_order` + `keymap` + `label` set so the canonical
    ///   bytes pin the key order item_order (i) < keymap (k) < label (l) < scp (s),
    ///   the inner string→array object (command id → chord set), the set-canonical
    ///   chord array (sorted + deduped), and the explicit-unbind state (`[]`,
    ///   distinct from an absent command, preserved verbatim).
    /// - `decrypt-keymap`: round-trip of the blob above.
    /// - `parse-fail-keymap-value-not-array`: a validly-sealed envelope whose inner
    ///   plaintext gives a `keymap` value as a bare string instead of an array;
    ///   AEAD passes, the canonical-JSON parse rejects (`plaintext_parse_failed`).
    ///   Sealed manually (the typed encoder can only emit canonical v0.1 plaintexts).
    #[test]
    #[ignore]
    fn emit_keymap_prefs_vectors() {
        extern crate std;
        use crate::aead::{aad_prefs_blob, aead_seal_ctx, CTX_COMMITMENT_TAG_LEN};

        // Same fixed vault-A inputs as the sibling generators; nonces 0xF4 / 0xF5
        // are the next free entries in the family's nonce registry (0x77, 0x88,
        // 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xF1, 0xF2, 0xF3 are taken).
        let root_a: [u8; 32] = [0x42; 32];
        let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
        let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);

        // --- encrypt-keymap + decrypt-keymap -------------------------------
        let nonce_keymap: [u8; AEAD_NONCE_LEN] = [0xF4; AEAD_NONCE_LEN];
        let mut keymap = BTreeMap::new();
        keymap.insert(
            String::from("app.command-palette"),
            alloc::vec![String::from("Mod-k"), String::from("Mod-p")],
        );
        keymap.insert(String::from("vault.lock"), Vec::new()); // explicit-unbind
        let prefs_keymap = PrefsView {
            item_order: BTreeMap::from([(String::from(""), alloc::vec![String::from("n1")])]),
            keymap: keymap.clone(),
            label: Some(String::from("Work")),
            ..PrefsView::default()
        };
        let canonical = canonical_json_encode(&prefs_keymap);
        assert_eq!(
            canonical.as_slice(),
            br#"{"item_order":{"":["n1"]},"keymap":{"app.command-palette":["Mod-k","Mod-p"],"vault.lock":[]},"label":"Work","screen_capture_protection":true}"#.as_slice(),
            "canonical bytes must pin i<k<l<s, set-canonical chords, and the []-unbind state",
        );
        let blob_keymap =
            encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs_keymap, &nonce_keymap)
                .expect("encode keymap");
        let decoded =
            decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_keymap).expect("decode");
        assert_eq!(decoded, prefs_keymap, "keymap blob must round-trip exactly");
        assert_eq!(
            decoded.keymap.get("vault.lock"),
            Some(&Vec::<String>::new()),
            "explicit-unbind []  must survive round-trip",
        );

        // --- parse-fail-keymap-value-not-array -----------------------------
        let nonce_bad: [u8; AEAD_NONCE_LEN] = [0xF5; AEAD_NONCE_LEN];
        // keymap value is a bare string, not an array → structural parse reject.
        let bad_plaintext: &[u8] =
            br#"{"keymap":{"a.cmd":"Mod-a"},"screen_capture_protection":true}"#;
        let aad = aad_prefs_blob(&account_hash_a);
        let sealed =
            aead_seal_ctx(&prefs_key_a, &nonce_bad, bad_plaintext, &aad).expect("seal bad");
        debug_assert_eq!(sealed.len(), bad_plaintext.len() + CTX_COMMITMENT_TAG_LEN);
        let mut blob_bad = Vec::with_capacity(PREFS_BLOB_HEADER_LEN + sealed.len());
        blob_bad.extend_from_slice(&PREFS_BLOB_MAGIC);
        blob_bad.push(PREFS_BLOB_PROTOCOL_VERSION);
        blob_bad.push(PREFS_BLOB_RESERVED);
        blob_bad.extend_from_slice(&nonce_bad);
        blob_bad.extend_from_slice(&(sealed.len() as u32).to_be_bytes());
        blob_bad.extend_from_slice(&sealed);
        assert_eq!(
            decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_bad).as_ref(),
            Err(&PrefsBlobError::PlaintextParseFailed),
            "a non-array keymap value must reject at the canonical-JSON parse stage",
        );

        let mut dump = alloc::string::String::new();
        dump.push_str("[\n");

        // case 1/3: encrypt-keymap
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/encrypt-keymap\",\n");
        dump.push_str("      \"description\": \"MYND-304 keymap overrides. PrefsView carries item_order + keymap (a string->array object: command id -> chord set) + label, pinning the canonical key order item_order (i) < keymap (k) < label (l) < screen_capture_protection (s), the inner lexicographic key order (app.command-palette < vault.lock), the set-canonical chord array (sorted Mod-k < Mod-p), and the explicit-unbind state (vault.lock -> [], preserved verbatim and distinct from an absent command). Same vault-A inputs as the sibling cases; prefs_nonce=0xF4x24. Generated by emit_keymap_prefs_vectors in protocol/src/prefs.rs.\",\n");
        dump.push_str("      \"case_kind\": \"encrypt\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n",
            hex_lower(&root_a)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_plaintext_canonical_utf8_hex\": \"{}\",\n",
            hex_lower(&canonical)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_prefs_nonce_hex\": \"{}\",\n",
            hex_lower(&nonce_keymap)
        ));
        dump.push_str(&alloc::format!(
            "      \"informational_prefs_key_hex\": \"{}\",\n",
            hex_lower(&*prefs_key_a)
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_prefs_blob_hex\": \"{}\"\n",
            hex_lower(&blob_keymap)
        ));
        dump.push_str("    },\n");

        // case 2/3: decrypt-keymap
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/decrypt-keymap\",\n");
        dump.push_str("      \"description\": \"Round-trip with encrypt-keymap: the blob decodes back to a PrefsView carrying item_order + the keymap override map + label under the same root_key + account_number_hash. Verifies decoders surface the MYND-304 keymap from its canonical position between item_order and label, parse the inner string->array object, and preserve the []-unbind entry verbatim.\",\n");
        dump.push_str("      \"case_kind\": \"decrypt_ok\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex_lower(&blob_keymap)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n",
            hex_lower(&root_a)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_plaintext_canonical_utf8_hex\": \"{}\",\n",
            hex_lower(&canonical)
        ));
        dump.push_str("      \"expected_prefs_view\": {\n");
        dump.push_str("        \"screen_capture_protection\": true,\n");
        dump.push_str("        \"item_order\": { \"\": [\"n1\"] },\n");
        dump.push_str("        \"keymap\": { \"app.command-palette\": [\"Mod-k\", \"Mod-p\"], \"vault.lock\": [] },\n");
        dump.push_str("        \"label\": \"Work\"\n");
        dump.push_str("      }\n");
        dump.push_str("    },\n");

        // case 3/3: parse-fail-keymap-value-not-array
        dump.push_str("    {\n");
        dump.push_str(
            "      \"vector_id\": \"vault-prefs/v0.1/parse-fail-keymap-value-not-array\",\n",
        );
        dump.push_str("      \"description\": \"A structurally valid envelope sealed under the REAL prefs_key + AAD whose inner plaintext gives a keymap value as a bare string (a.cmd -> \\\"Mod-a\\\") instead of an array. AEAD verification succeeds; the reject fires at the canonical-JSON parse stage (the chord set MUST be an array). Distinguishable plaintext_parse_failed, not a CannotDecrypt. Sealed manually (the typed encoder can only emit canonical v0.1 plaintexts); prefs_nonce=0xF5x24.\",\n");
        dump.push_str("      \"case_kind\": \"parse_fail\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex_lower(&blob_bad)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n",
            hex_lower(&root_a)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str("      \"expected_error\": \"plaintext_parse_failed\",\n");
        dump.push_str("      \"informational_tamper_description\": \"validly-sealed inner plaintext with a non-array keymap value (nonce 0xf5x24)\"\n");
        dump.push_str("    }\n");

        dump.push_str("]\n");

        std::fs::write("/tmp/myne_vault_prefs_keymap_vectors.json", dump.as_bytes())
            .expect("write vault-prefs keymap vectors dump");
    }

    /// Generator for the right-panel-tabs vault-prefs vectors (right-panel tabs;
    /// per-feature-generator pattern of [`emit_keymap_prefs_vectors`]). Emits a
    /// 2-case JSON **array fragment** (encrypt + decrypt_ok) at
    /// `/tmp/myne_vault_prefs_right_panel_vectors.json`, spliced by hand into the
    /// existing `cases` array. Exercises the three additive fields
    /// `right_panel_active_tab` (Option<String> pointer) / `right_panel_hidden_tabs`
    /// (set-canonical: sorted+deduped) / `right_panel_tab_order` (sequence:
    /// verbatim). Same fixed vault-A inputs as the sibling generators;
    /// prefs_nonce=0xF6 (the next free entry in the family's nonce registry —
    /// 0x77/0x88/0x99/0xAA/0xBB/0xCC/0xDD/0xEE/0xF1..0xF5 are taken).
    ///
    /// `cargo test -p protocol --lib emit_right_panel_prefs_vectors -- --ignored`
    #[test]
    #[ignore]
    fn emit_right_panel_prefs_vectors() {
        extern crate std;

        let root_a: [u8; 32] = [0x42; 32];
        let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
        let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);

        let nonce_rp: [u8; AEAD_NONCE_LEN] = [0xF6; AEAD_NONCE_LEN];
        let prefs_rp = PrefsView {
            right_panel_active_tab: Some(String::from("backlinks")),
            right_panel_hidden_tabs: alloc::vec![String::from("outline")],
            right_panel_tab_order: alloc::vec![
                String::from("backlinks"),
                String::from("unlinked"),
                String::from("outline"),
            ],
            ..PrefsView::default()
        };
        let canonical = canonical_json_encode(&prefs_rp);
        assert_eq!(
            canonical.as_slice(),
            br#"{"right_panel_active_tab":"backlinks","right_panel_hidden_tabs":["outline"],"right_panel_tab_order":["backlinks","unlinked","outline"],"screen_capture_protection":true}"#.as_slice(),
            "canonical bytes must pin right_panel_active_tab < right_panel_hidden_tabs < right_panel_tab_order < screen_capture_protection (all between paired_extensions and saved_views), set-canonical hidden tabs, verbatim tab order",
        );
        let blob_rp = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs_rp, &nonce_rp)
            .expect("encode right-panel");
        let decoded = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_rp).expect("decode");
        assert_eq!(
            decoded, prefs_rp,
            "right-panel blob must round-trip exactly"
        );

        let mut dump = alloc::string::String::new();
        dump.push_str("[\n");

        // case 1/2: encrypt-right-panel-tabs
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/encrypt-right-panel-tabs\",\n");
        dump.push_str("      \"description\": \"Right-panel tabs. PrefsView carries right_panel_active_tab (an Option<String> pointer) + right_panel_hidden_tabs (set-canonical: sorted+deduped) + right_panel_tab_order (sequence: verbatim), pinning the canonical key order right_panel_active_tab (r-a) < right_panel_hidden_tabs (r-h) < right_panel_tab_order (r-t) < screen_capture_protection (s), all sorting between paired_extensions (p) and saved_views (sav). Same vault-A inputs as the sibling cases; prefs_nonce=0xF6x24. Generated by emit_right_panel_prefs_vectors in protocol/src/prefs.rs.\",\n");
        dump.push_str("      \"case_kind\": \"encrypt\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n",
            hex_lower(&root_a)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_plaintext_canonical_utf8_hex\": \"{}\",\n",
            hex_lower(&canonical)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_prefs_nonce_hex\": \"{}\",\n",
            hex_lower(&nonce_rp)
        ));
        dump.push_str(&alloc::format!(
            "      \"informational_prefs_key_hex\": \"{}\",\n",
            hex_lower(&*prefs_key_a)
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_prefs_blob_hex\": \"{}\"\n",
            hex_lower(&blob_rp)
        ));
        dump.push_str("    },\n");

        // case 2/2: decrypt-right-panel-tabs
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/decrypt-right-panel-tabs\",\n");
        dump.push_str("      \"description\": \"Round-trip with encrypt-right-panel-tabs: the blob decodes back to a PrefsView carrying the active-tab pointer + the hidden-tabs set + the tab-order sequence under the same root_key + account_number_hash. Verifies decoders surface the three right-panel fields from their canonical positions between paired_extensions and saved_views, canonicalize the hidden set (sorted+deduped), and preserve the order sequence verbatim.\",\n");
        dump.push_str("      \"case_kind\": \"decrypt_ok\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex_lower(&blob_rp)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n",
            hex_lower(&root_a)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_plaintext_canonical_utf8_hex\": \"{}\",\n",
            hex_lower(&canonical)
        ));
        dump.push_str("      \"expected_prefs_view\": {\n");
        dump.push_str("        \"screen_capture_protection\": true,\n");
        dump.push_str("        \"right_panel_active_tab\": \"backlinks\",\n");
        dump.push_str("        \"right_panel_hidden_tabs\": [\"outline\"],\n");
        dump.push_str(
            "        \"right_panel_tab_order\": [\"backlinks\", \"unlinked\", \"outline\"]\n",
        );
        dump.push_str("      }\n");
        dump.push_str("    }\n");

        dump.push_str("]\n");

        std::fs::write(
            "/tmp/myne_vault_prefs_right_panel_vectors.json",
            dump.as_bytes(),
        )
        .expect("write vault-prefs right-panel vectors dump");
    }

    /// Generator for the MYND-478 `field_clocks` vault-prefs vectors (Phase 2
    /// prefs sync; per-feature-generator pattern of
    /// [`emit_right_panel_prefs_vectors`]). Emits a 2-case JSON **array
    /// fragment** (encrypt + decrypt_ok) at
    /// `/tmp/myne_vault_prefs_field_clocks_vectors.json`, spliced by hand into
    /// the existing `cases` array. Exercises the additive
    /// `field_clocks` map (string key → epoch-ms u64) in its canonical slot
    /// between `favorites` (fa) and `folder_icons` (fo), including a
    /// namespaced `device_names/<key>` entry. Same fixed vault-A inputs as the
    /// sibling generators; prefs_nonce=0xF7 (the next free entry in the
    /// family's nonce registry — 0x77..0xEE + 0xF1..0xF6 are taken).
    ///
    /// `cargo test -p protocol --lib emit_field_clocks_prefs_vectors -- --ignored`
    #[test]
    #[ignore]
    fn emit_field_clocks_prefs_vectors() {
        extern crate std;

        let root_a: [u8; 32] = [0x42; 32];
        let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
        let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);

        let nonce_fc: [u8; AEAD_NONCE_LEN] = [0xF7; AEAD_NONCE_LEN];
        let mut clocks = BTreeMap::new();
        clocks.insert(String::from("label"), 1_765_432_099_000u64);
        clocks.insert(
            String::from("device_names/3f9ac2d1aabbccdd00112233445566ff"),
            1_765_432_100_000u64,
        );
        let prefs_fc = PrefsView {
            favorites: alloc::vec![String::from("0190a000-0000-7000-8000-000000000002")],
            field_clocks: clocks,
            folder_icons: {
                let mut m = BTreeMap::new();
                m.insert(String::from("Projects/Myne/"), String::from("book"));
                m
            },
            label: Some(String::from("Work")),
            ..PrefsView::default()
        };
        let canonical = canonical_json_encode(&prefs_fc);
        assert_eq!(
            canonical.as_slice(),
            br#"{"favorites":["0190a000-0000-7000-8000-000000000002"],"field_clocks":{"device_names/3f9ac2d1aabbccdd00112233445566ff":1765432100000,"label":1765432099000},"folder_icons":{"Projects/Myne/":"book"},"label":"Work","screen_capture_protection":true}"#.as_slice(),
            "canonical bytes must pin favorites (fa) < field_clocks (fi) < folder_icons (fo) < label (l) < screen_capture_protection (s), lexicographic clock keys, bare-decimal epoch-ms values",
        );
        let blob_fc = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs_fc, &nonce_fc)
            .expect("encode field-clocks");
        let decoded = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_fc).expect("decode");
        assert_eq!(
            decoded, prefs_fc,
            "field-clocks blob must round-trip exactly"
        );

        let mut dump = alloc::string::String::new();
        dump.push_str("[\n");

        // case 1/2: encrypt-field-clocks
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/encrypt-field-clocks\",\n");
        dump.push_str("      \"description\": \"Per-field LWW clocks (MYND-478, Phase 2 prefs sync). PrefsView carries the additive field_clocks map (string key -> epoch-ms u64; here the 'label' field clock plus a namespaced device_names/<key> per-entry clock) beside favorites, folder_icons and label, pinning the canonical key order favorites (fa) < field_clocks (fi) < folder_icons (fo) < label (l) < screen_capture_protection (s), lexicographic clock-key order inside the map, and bare-decimal integer values (floats forbidden). Same vault-A inputs as the sibling cases; prefs_nonce=0xF7x24. Generated by emit_field_clocks_prefs_vectors in protocol/src/prefs.rs.\",\n");
        dump.push_str("      \"case_kind\": \"encrypt\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n",
            hex_lower(&root_a)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_plaintext_canonical_utf8_hex\": \"{}\",\n",
            hex_lower(&canonical)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_prefs_nonce_hex\": \"{}\",\n",
            hex_lower(&nonce_fc)
        ));
        dump.push_str(&alloc::format!(
            "      \"informational_prefs_key_hex\": \"{}\",\n",
            hex_lower(&*prefs_key_a)
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_prefs_blob_hex\": \"{}\"\n",
            hex_lower(&blob_fc)
        ));
        dump.push_str("    },\n");

        // case 2/2: decrypt-field-clocks
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/decrypt-field-clocks\",\n");
        dump.push_str("      \"description\": \"Round-trip with encrypt-field-clocks: the blob decodes back to a PrefsView carrying the field_clocks map (label clock + namespaced device_names/<key> clock) under the same root_key + account_number_hash. Verifies decoders surface field_clocks from its canonical position between favorites and folder_icons and parse the inner string->integer object; a decoder that does not know the field (pre-MYND-478) tolerates it per the §9.5.2 forward-compat rule and treats every clock as absent (= 0 to the sync-protocol.md §10.2 merge).\",\n");
        dump.push_str("      \"case_kind\": \"decrypt_ok\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex_lower(&blob_fc)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n",
            hex_lower(&root_a)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_plaintext_canonical_utf8_hex\": \"{}\",\n",
            hex_lower(&canonical)
        ));
        dump.push_str("      \"expected_prefs_view\": {\n");
        dump.push_str("        \"screen_capture_protection\": true,\n");
        dump.push_str("        \"favorites\": [\"0190a000-0000-7000-8000-000000000002\"],\n");
        dump.push_str("        \"field_clocks\": { \"device_names/3f9ac2d1aabbccdd00112233445566ff\": 1765432100000, \"label\": 1765432099000 },\n");
        dump.push_str("        \"folder_icons\": { \"Projects/Myne/\": \"book\" },\n");
        dump.push_str("        \"label\": \"Work\"\n");
        dump.push_str("      }\n");
        dump.push_str("    }\n");

        dump.push_str("]\n");

        std::fs::write(
            "/tmp/myne_vault_prefs_field_clocks_vectors.json",
            dump.as_bytes(),
        )
        .expect("write vault-prefs field-clocks vectors dump");
    }

    /// Generator for the display-formatting quartet's `vault-prefs` cases —
    /// `auto_tag_enabled`, `date_format`, `time_format`, `timezone`.
    ///
    /// `cargo test -p protocol --lib emit_datetime_quartet_prefs_vectors -- --ignored`
    ///
    /// These four shipped without a single companion-repo vector between them:
    /// each is exercised by `#[cfg(test)]` unit tests here and by nothing a port
    /// can run. That is a real cross-implementation gap rather than a tidiness
    /// one, because `vault.prefs` is canonical JSON — **key order is part of the
    /// bytes**, so a port that emits a correct value in the wrong slot produces a
    /// blob this crate cannot decode, and no existing vector would have said so.
    ///
    /// Each field is therefore pinned **beside both of its canonical neighbours**,
    /// which is what makes the case a slot pin rather than a value pin:
    ///
    /// * `auto_lock_seconds` < `auto_tag_enabled` < `bar_items_order`
    /// * `daily_template` < `date_format` < `deliberate_folders`
    /// * `theme` < `time_format` < `timezone` < `transcription_enabled`
    ///
    /// `auto_tag_enabled` is additionally the one member of the quartet with the
    /// emit-only-when-`true` convention, so it is set `true` here — set `false`
    /// it would vanish from the bytes and pin nothing at all.
    #[test]
    #[ignore]
    fn emit_datetime_quartet_prefs_vectors() {
        extern crate std;

        let root_a: [u8; 32] = [0x42; 32];
        let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
        let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);
        let nonce_dq: [u8; AEAD_NONCE_LEN] = [0xD4; AEAD_NONCE_LEN];

        let prefs_dq = PrefsView {
            auto_lock_seconds: Some(300),
            auto_tag_enabled: true,
            bar_items_order: alloc::vec![String::from("search"), String::from("graph")],
            daily_template: Some(String::from("Templates/Daily.md")),
            date_format: Some(String::from("iso")),
            deliberate_folders: alloc::vec![String::from("Archive/")],
            theme: Some(ThemeChoice::Dark),
            time_format: Some(String::from("24h")),
            timezone: Some(String::from("Europe/Istanbul")),
            transcription_enabled: false,
            ..PrefsView::default()
        };

        let canonical = canonical_json_encode(&prefs_dq);
        let canonical_str = core::str::from_utf8(&canonical).expect("canonical JSON is UTF-8");

        // Slot assertions, stated as ordering rather than as one frozen string:
        // a future field landing between any of these pairs must not silently
        // invalidate the pin it is not related to.
        let pos = |needle: &str| -> usize {
            canonical_str
                .find(needle)
                .unwrap_or_else(|| panic!("canonical JSON is missing {needle}: {canonical_str}"))
        };
        assert!(
            pos("\"auto_lock_seconds\"") < pos("\"auto_tag_enabled\"")
                && pos("\"auto_tag_enabled\"") < pos("\"bar_items_order\""),
            "auto_tag_enabled must sit between auto_lock_seconds and bar_items_order: {canonical_str}"
        );
        assert!(
            pos("\"daily_template\"") < pos("\"date_format\"")
                && pos("\"date_format\"") < pos("\"deliberate_folders\""),
            "date_format must sit between daily_template and deliberate_folders: {canonical_str}"
        );
        assert!(
            pos("\"theme\"") < pos("\"time_format\"")
                && pos("\"time_format\"") < pos("\"timezone\"")
                && pos("\"timezone\"") < pos("\"transcription_enabled\""),
            "time_format < timezone must sit between theme and transcription_enabled: {canonical_str}"
        );

        let blob_dq = encode_prefs_blob_raw(&prefs_key_a, &account_hash_a, &prefs_dq, &nonce_dq)
            .expect("encode datetime quartet");
        let decoded = decode_prefs_blob(&prefs_key_a, &account_hash_a, &blob_dq).expect("decode");
        assert_eq!(
            decoded, prefs_dq,
            "datetime-quartet blob must round-trip exactly"
        );

        let mut dump = alloc::string::String::new();
        dump.push_str("[\n");

        // case 1/2: encrypt-datetime-quartet
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/encrypt-datetime-quartet\",\n");
        dump.push_str("      \"description\": \"The four display-formatting preferences that had no cross-implementation vector: auto_tag_enabled (on-device tag suggestion, emitted only when true), date_format, time_format and timezone (myne#279 display overrides). Each is written beside BOTH of its canonical neighbours so the case pins its slot rather than merely its value: auto_lock_seconds < auto_tag_enabled < bar_items_order; daily_template < date_format < deliberate_folders; theme < time_format < timezone < transcription_enabled. vault.prefs is canonical JSON, so key order is part of the bytes — a port emitting a correct value in the wrong slot produces a blob the reference decoder rejects. All four values are display-only: none ever enters a .myn file, a blob or the sync wire as a formatting instruction. Same vault-A inputs as the sibling cases; prefs_nonce=0xD4x24. Generated by emit_datetime_quartet_prefs_vectors in protocol/src/prefs.rs.\",\n");
        dump.push_str("      \"case_kind\": \"encrypt\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n",
            hex_lower(&root_a)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_plaintext_canonical_utf8_hex\": \"{}\",\n",
            hex_lower(&canonical)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_prefs_nonce_hex\": \"{}\",\n",
            hex_lower(&nonce_dq)
        ));
        dump.push_str(&alloc::format!(
            "      \"informational_prefs_key_hex\": \"{}\",\n",
            hex_lower(&*prefs_key_a)
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_prefs_blob_hex\": \"{}\"\n",
            hex_lower(&blob_dq)
        ));
        dump.push_str("    },\n");

        // case 2/2: decrypt-datetime-quartet
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"vault-prefs/v0.1/decrypt-datetime-quartet\",\n");
        dump.push_str("      \"description\": \"Round-trip with encrypt-datetime-quartet: the blob decodes back to a PrefsView carrying all four display-formatting fields at their canonical positions. A decoder that does not know one of them tolerates it per the §9.5.2 forward-compat rule and falls back to that field's default (auto_tag_enabled=false, the other three = 'follow the OS locale'), which is exactly what a pre-feature client does — the point of the case is that skipping a field must not desynchronise the positional cursor and swallow the fields that follow it.\",\n");
        dump.push_str("      \"case_kind\": \"decrypt_ok\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_blob_hex\": \"{}\",\n",
            hex_lower(&blob_dq)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_root_key_hex\": \"{}\",\n",
            hex_lower(&root_a)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_plaintext_canonical_utf8_hex\": \"{}\",\n",
            hex_lower(&canonical)
        ));
        dump.push_str("      \"expected_prefs_view\": {\n");
        dump.push_str("        \"screen_capture_protection\": true,\n");
        dump.push_str("        \"auto_lock_seconds\": 300,\n");
        dump.push_str("        \"auto_tag_enabled\": true,\n");
        dump.push_str("        \"bar_items_order\": [\"search\", \"graph\"],\n");
        dump.push_str("        \"daily_template\": \"Templates/Daily.md\",\n");
        dump.push_str("        \"date_format\": \"iso\",\n");
        dump.push_str("        \"deliberate_folders\": [\"Archive/\"],\n");
        dump.push_str("        \"theme\": \"dark\",\n");
        dump.push_str("        \"time_format\": \"24h\",\n");
        dump.push_str("        \"timezone\": \"Europe/Istanbul\",\n");
        dump.push_str("        \"transcription_enabled\": false\n");
        dump.push_str("      }\n");
        dump.push_str("    }\n");

        dump.push_str("]\n");

        std::fs::write(
            "/tmp/myne_vault_prefs_datetime_quartet_vectors.json",
            dump.as_bytes(),
        )
        .expect("write vault-prefs datetime-quartet vectors dump");
        std::println!("canonical JSON: {canonical_str}");
    }

    /// Generator for the MYND-227 structural `parse_fail` vector cases
    /// (appended to the companion repo's `vault-prefs` family; per-feature-
    /// generator pattern of [`emit_label_and_tolerance_prefs_vectors`]).
    /// Emits a JSON **array fragment** of 7 case objects at
    /// `/tmp/myne_vault_prefs_parse_fail_vectors.json`, spliced by hand
    /// into the existing `cases` array.
    ///
    /// `cargo test -p protocol --lib emit_prefs_parse_fail_vectors -- --ignored`
    ///
    /// One case per distinguishable `PrefsBlobError` reject reachable from
    /// a decode-a-blob vector: the 6 pre-AEAD structural rejects
    /// (vault-search parity) + the post-AEAD `plaintext_parse_failed`
    /// (a validly-sealed blob whose inner plaintext is not canonical JSON —
    /// possible only with the real `prefs_key`, which every case therefore
    /// carries). Encode-side `CiphertextLenOverflow` + `RandomnessUnavailable`
    /// cannot be expressed as decode cases and stay unvectored.
    #[test]
    #[ignore]
    fn emit_prefs_parse_fail_vectors() {
        extern crate std;
        use crate::aead::{aad_prefs_blob, aead_seal_ctx, CTX_COMMITMENT_TAG_LEN};

        // Same fixed vault-A inputs as the sibling generators; nonces 0xF2 +
        // 0xF3 are the next free entries in the family's nonce registry
        // (0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xF1 are taken).
        let root_a: [u8; 32] = [0x42; 32];
        let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
        let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);
        let nonce_base: [u8; AEAD_NONCE_LEN] = [0xF2; AEAD_NONCE_LEN];
        let nonce_bad_inner: [u8; AEAD_NONCE_LEN] = [0xF3; AEAD_NONCE_LEN];

        // Base blob for the structural tampers: default PrefsView under the
        // real key. The header bytes are NOT bound into the AAD, so a port
        // that skips a structural check will decrypt the tampered blob
        // successfully and return Ok — which the runner catches. That is
        // why these cases carry the real root_key instead of a dummy.
        let base = encode_prefs_blob_raw(
            &prefs_key_a,
            &account_hash_a,
            &PrefsView::default(),
            &nonce_base,
        )
        .expect("encode base");

        let header_short: Vec<u8> = PREFS_BLOB_MAGIC.to_vec();
        let mut magic_tamper = base.clone();
        magic_tamper[0] = b'X';
        let mut version_tamper = base.clone();
        version_tamper[4] = 0x02;
        let mut reserved_tamper = base.clone();
        reserved_tamper[5] = 0x01;
        let mut len_overflow = base.clone();
        len_overflow[30..34].copy_from_slice(&0xFFFF_FFFFu32.to_be_bytes());
        let mut truncated = base.clone();
        truncated.truncate(truncated.len() - 1);

        // plaintext_parse_failed: a hand-assembled envelope (same header
        // layout as encode_prefs_blob_raw) sealing bytes that are NOT
        // canonical JSON. AEAD verification passes — the reject happens at
        // the inner-plaintext parse stage, distinguishable per §9.5.5.
        let bad_plaintext = b"this is not canonical json";
        let aad = aad_prefs_blob(&account_hash_a);
        let sealed = aead_seal_ctx(&prefs_key_a, &nonce_bad_inner, bad_plaintext, &aad)
            .expect("seal bad inner");
        debug_assert_eq!(sealed.len(), bad_plaintext.len() + CTX_COMMITMENT_TAG_LEN);
        let mut bad_inner = Vec::with_capacity(PREFS_BLOB_HEADER_LEN + sealed.len());
        bad_inner.extend_from_slice(&PREFS_BLOB_MAGIC);
        bad_inner.push(PREFS_BLOB_PROTOCOL_VERSION);
        bad_inner.push(PREFS_BLOB_RESERVED);
        bad_inner.extend_from_slice(&nonce_bad_inner);
        bad_inner.extend_from_slice(&(sealed.len() as u32).to_be_bytes());
        bad_inner.extend_from_slice(&sealed);

        let cases: [(&str, &str, &[u8], PrefsBlobError, &str); 7] = [
            (
                "parse-fail-header-too-short",
                "Only the 4-byte MYP1 magic — no room for the 34-byte header (magic + version + reserved + 24-byte nonce + 4-byte ciphertext_len). Rejected before any field read.",
                header_short.as_slice(),
                PrefsBlobError::HeaderTooShort,
                "blob is the 4 magic bytes only (4 < 34)",
            ),
            (
                "parse-fail-magic-mismatch",
                "First byte of the MYP1 magic corrupted to 'X'. Rejected at offset 0 before any decryption — a foreign file, different artifact type, or forward-incompatible MYP5 blob all fail here.",
                magic_tamper.as_slice(),
                PrefsBlobError::MagicMismatch,
                "byte 0 (magic[0]) 'M' → 'X'",
            ),
            (
                "parse-fail-protocol-version-mismatch",
                "protocol_version byte (offset 4) set to 0x02 instead of 0x01. A v0.1 decoder rejects an unknown protocol version before decrypting.",
                version_tamper.as_slice(),
                PrefsBlobError::ProtocolVersionMismatch,
                "byte 4 (protocol_version) 0x01 → 0x02",
            ),
            (
                "parse-fail-reserved-nonzero",
                "reserved byte (offset 5) set to 0x01 instead of 0x00. Spec §9.5.1 makes non-zero an unconditional parse rejection — reserved bytes are flag carriers for future v0.1.x revisions and a v0.1.0 client cannot honor unknown flags.",
                reserved_tamper.as_slice(),
                PrefsBlobError::ReservedByteNonZero,
                "byte 5 (reserved) 0x00 → 0x01",
            ),
            (
                "parse-fail-ciphertext-len-overflow",
                "ciphertext_len field (offset 30..34) set to 0xFFFFFFFF, far above MAX_PREFS_PLAINTEXT_LEN + 32 (64 KiB + 32). The overflow guard rejects before any slice indexing — a port MUST bound-check ciphertext_len before allocating or indexing (DoS-allocation defense, §9.5.4).",
                len_overflow.as_slice(),
                PrefsBlobError::CiphertextLenOverflow,
                "bytes 30..34 (ciphertext_len) → 0xffffffff",
            ),
            (
                "parse-fail-ciphertext-truncated",
                "Valid header advertising ciphertext_len = N, but the blob is one byte shorter than header + N. Rejected before the AEAD stage.",
                truncated.as_slice(),
                PrefsBlobError::CiphertextTruncated,
                "final byte dropped (blob shorter than header + advertised ciphertext_len)",
            ),
            (
                "parse-fail-plaintext-parse-failed",
                "A structurally valid envelope sealed under the REAL prefs_key + AAD whose inner plaintext is 'this is not canonical json'. AEAD verification succeeds — the reject fires at the canonical-JSON parse stage. Distinguishable from CannotDecrypt because the tag check already proved the bytes came from a prefs_key holder (corruption past that point is structural, not adversarial). A port that returns its AEAD-failure error here has merged two distinct failure surfaces.",
                bad_inner.as_slice(),
                PrefsBlobError::PlaintextParseFailed,
                "validly-sealed non-JSON inner plaintext (nonce 0xf3×24)",
            ),
        ];

        let expected_error_str = |e: &PrefsBlobError| -> &'static str {
            match e {
                PrefsBlobError::HeaderTooShort => "header_too_short",
                PrefsBlobError::MagicMismatch => "magic_mismatch",
                PrefsBlobError::ProtocolVersionMismatch => "protocol_version_mismatch",
                PrefsBlobError::ReservedByteNonZero => "reserved_byte_nonzero",
                PrefsBlobError::CiphertextLenOverflow => "ciphertext_len_overflow",
                PrefsBlobError::CiphertextTruncated => "ciphertext_truncated",
                PrefsBlobError::PlaintextParseFailed => "plaintext_parse_failed",
                other => panic!("unexpected expected-error variant {other:?}"),
            }
        };

        let mut dump = alloc::string::String::new();
        dump.push_str("[\n");
        for (i, (slug, description, blob, expected, tamper)) in cases.iter().enumerate() {
            assert_eq!(
                decode_prefs_blob(&prefs_key_a, &account_hash_a, blob).as_ref(),
                Err(expected),
                "[{slug}] tampered blob must reject with {expected:?}"
            );
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"vault-prefs/v0.1/{}\",\n",
                slug
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(description)
            ));
            dump.push_str("      \"case_kind\": \"parse_fail\",\n");
            dump.push_str(&alloc::format!(
                "      \"input_blob_hex\": \"{}\",\n",
                hex_lower(blob)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_root_key_hex\": \"{}\",\n",
                hex_lower(&root_a)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_account_number_hash_hex\": \"{}\",\n",
                hex_lower(&account_hash_a)
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_error\": \"{}\",\n",
                expected_error_str(expected)
            ));
            dump.push_str(&alloc::format!(
                "      \"informational_tamper_description\": \"{}\"\n",
                json_escape(tamper)
            ));
            if i + 1 < cases.len() {
                dump.push_str("    },\n");
            } else {
                dump.push_str("    }\n");
            }
        }
        dump.push_str("]\n");

        std::fs::write(
            "/tmp/myne_vault_prefs_parse_fail_vectors.json",
            dump.as_bytes(),
        )
        .expect("write vault-prefs parse_fail vectors dump");
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
            date_format: None,
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
            date_format: None,
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

    // ---- color_groups (graph-connection-ux-polish, MYND-604) ---------------

    fn sample_color_group(id: &str, name: &str) -> crate::color_group::ColorGroup {
        crate::color_group::ColorGroup {
            id: id.into(),
            name: name.into(),
            color: "moss".into(),
            enabled: true,
            filter: crate::saved_view::FilterNode::HasTag { tag: "work".into() },
        }
    }

    #[test]
    fn color_groups_round_trips_and_positions_b_before_col_before_cus() {
        // Round-trip alongside bar_items_order (before, 'b') + custom_theme
        // (after, 'cus') to pin color_groups' canonical position ('col').
        let prefs = PrefsView {
            bar_items_order: alloc::vec!["graph".into()],
            color_groups: alloc::vec![
                sample_color_group("g1", "Work"),
                sample_color_group("g2", "Rest")
            ],
            custom_theme: Some("solarized-dark".into()),
            ..PrefsView::default()
        };
        let prefs_key = derive_subkey(&fixed_root_key(), SubkeyRole::PrefsKey);
        let hash = fixed_account_number_hash();
        let blob = encode_prefs_blob_raw(&prefs_key, &hash, &prefs, &fixed_prefs_nonce()).unwrap();
        let decoded = decode_prefs_blob(&prefs_key, &hash, &blob).unwrap();
        assert_eq!(decoded, prefs);
        // Order preserved verbatim — precedence, not id-sorted (g1 before g2).
        assert_eq!(decoded.color_groups[0].id, "g1");
        assert_eq!(decoded.color_groups[1].id, "g2");

        let json = canonical_json_encode(&prefs);
        let s = core::str::from_utf8(&json).unwrap();
        let b = s.find("bar_items_order").unwrap();
        let cg = s.find("color_groups").unwrap();
        let cus = s.find("custom_theme").unwrap();
        assert!(
            b < cg && cg < cus,
            "canonical order must be b < col < cus: {s}"
        );
    }

    #[test]
    fn color_groups_omitted_when_empty_byte_identical_to_pre_feature_blob() {
        // A vault that never opens the feature re-encodes byte-identically to
        // a pre-MYND-604 vault.prefs (story 36) — the field must not appear
        // at all, not merely as `[]`.
        let prefs = PrefsView::default();
        let json = canonical_json_encode(&prefs);
        let s = core::str::from_utf8(&json).unwrap();
        assert!(
            !s.contains("color_groups"),
            "empty color_groups must be omitted: {s}"
        );
    }

    #[test]
    fn color_groups_disabled_rule_round_trips() {
        let mut g = sample_color_group("g1", "Muted");
        g.enabled = false;
        let prefs = PrefsView {
            color_groups: alloc::vec![g],
            ..PrefsView::default()
        };
        let prefs_key = derive_subkey(&fixed_root_key(), SubkeyRole::PrefsKey);
        let hash = fixed_account_number_hash();
        let blob = encode_prefs_blob_raw(&prefs_key, &hash, &prefs, &fixed_prefs_nonce()).unwrap();
        let decoded = decode_prefs_blob(&prefs_key, &hash, &blob).unwrap();
        assert_eq!(decoded, prefs);
        assert!(!decoded.color_groups[0].enabled);
    }

    // ---- custom_theme (custom-themes epic, MYND-297) -----------------------

    #[test]
    fn custom_theme_round_trips_and_positions_a_before_c_before_t() {
        // Round-trip alongside auto_lock_seconds (before, 'a') + theme (after, 't')
        // to pin custom_theme's canonical position ('c') across the codec.
        let prefs = PrefsView {
            custom_theme: Some("solarized-dark".into()),
            auto_lock_seconds: Some(300),
            theme: Some(ThemeChoice::Dark),
            ..PrefsView::default()
        };
        let prefs_key = derive_subkey(&fixed_root_key(), SubkeyRole::PrefsKey);
        let hash = fixed_account_number_hash();
        let blob = encode_prefs_blob_raw(&prefs_key, &hash, &prefs, &fixed_prefs_nonce()).unwrap();
        let decoded = decode_prefs_blob(&prefs_key, &hash, &blob).unwrap();
        assert_eq!(decoded, prefs);
        assert_eq!(decoded.custom_theme.as_deref(), Some("solarized-dark"));

        let json = canonical_json_encode(&prefs);
        let s = core::str::from_utf8(&json).unwrap();
        let al = s.find("auto_lock_seconds").unwrap();
        let ct = s.find("custom_theme").unwrap();
        let th = s.find("\"theme\"").unwrap();
        assert!(al < ct && ct < th, "canonical order must be a < c < t: {s}");
    }

    #[test]
    fn custom_theme_omitted_when_none_is_byte_identical() {
        // A vault with no custom theme must not emit the key at all, so it stays
        // byte-identical to a pre-MYND-297 vault.prefs.
        let prefs = PrefsView {
            theme: Some(ThemeChoice::Light),
            ..PrefsView::default()
        };
        let json = canonical_json_encode(&prefs);
        assert!(
            find_subslice(&json, b"custom_theme").is_none(),
            "absent custom_theme must not appear in canonical JSON"
        );
    }

    // ---- saved_views + view_order (MYND-273) -------------------------------

    fn sample_view(id: &str, name: &str) -> crate::saved_view::SavedView {
        use crate::saved_view::{FilterNode, SavedView, ViewType};
        SavedView {
            id: String::from(id),
            name: String::from(name),
            view_type: ViewType::Cards,
            filters: FilterNode::InFolder {
                path: String::from("Books/"),
            },
            sort: None,
            group_by: None,
            columns: alloc::vec![String::from("author")],
            card_size: Some(300),
            image: Some(String::from("image")),
            image_aspect_ratio: Some(String::from("1.65")),
        }
    }

    #[test]
    fn saved_views_and_view_order_round_trip_through_blob() {
        let prefs_key = derive_subkey(&fixed_root_key(), SubkeyRole::PrefsKey);
        let hash = fixed_account_number_hash();
        let original = PrefsView {
            saved_views: alloc::vec![sample_view("v2", "Books"), sample_view("v1", "Films")],
            view_order: alloc::vec![String::from("v2"), String::from("v1")],
            ..PrefsView::default()
        };
        let blob =
            encode_prefs_blob_raw(&prefs_key, &hash, &original, &fixed_prefs_nonce()).unwrap();
        let decoded = decode_prefs_blob(&prefs_key, &hash, &blob).unwrap();
        // saved_views decode in canonical (id-sorted) order; view_order verbatim.
        assert_eq!(decoded.saved_views.len(), 2);
        assert_eq!(decoded.saved_views[0].id, "v1");
        assert_eq!(decoded.saved_views[1].id, "v2");
        assert_eq!(decoded.view_order, alloc::vec!["v2", "v1"]);
        assert_eq!(decoded.saved_views[1].name, "Books");
    }

    #[test]
    fn empty_saved_views_and_view_order_are_byte_identical_to_pre_feature() {
        // A vault with no views emits NO "saved_views"/"view_order" key, so it
        // is byte-identical to a pre-MYND-273 vault.prefs (existing golden
        // vectors unaffected — migration-less additive fields).
        let encoded = canonical_json_encode(&PrefsView::default());
        assert!(find_subslice(&encoded, b"saved_views").is_none());
        assert!(find_subslice(&encoded, b"view_order").is_none());
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
    }

    #[test]
    fn view_order_preserves_sequence_not_sorted_or_deduped() {
        // Sequence semantics (like item_order/favorites): order verbatim, dupes
        // kept — the codec performs no GC.
        let original = PrefsView {
            view_order: alloc::vec![String::from("v3"), String::from("v1"), String::from("v3"),],
            ..PrefsView::default()
        };
        let decoded = canonical_json_decode(&canonical_json_encode(&original)).expect("decode");
        assert_eq!(decoded.view_order, alloc::vec!["v3", "v1", "v3"]);
    }

    #[test]
    fn saved_views_encoded_sorted_by_id() {
        // The set's array order is canonical (id-sorted) regardless of caller
        // order; the display order lives in view_order.
        let original = PrefsView {
            saved_views: alloc::vec![sample_view("zzz", "Z"), sample_view("aaa", "A")],
            ..PrefsView::default()
        };
        let encoded = canonical_json_encode(&original);
        let s = core::str::from_utf8(&encoded).unwrap();
        let pos_a = s.find("\"id\":\"aaa\"").unwrap();
        let pos_z = s.find("\"id\":\"zzz\"").unwrap();
        assert!(pos_a < pos_z, "saved_views must be encoded sorted by id");
    }

    #[test]
    fn saved_views_canonical_key_position() {
        // saved_views sorts before screen_capture_protection; view_order is last.
        let original = PrefsView {
            saved_views: alloc::vec![sample_view("v1", "A")],
            view_order: alloc::vec![String::from("v1")],
            ..PrefsView::default()
        };
        let s = String::from_utf8(canonical_json_encode(&original)).unwrap();
        let sv = s.find("\"saved_views\":").unwrap();
        let scp = s.find("\"screen_capture_protection\":").unwrap();
        let vo = s.find("\"view_order\":").unwrap();
        assert!(sv < scp, "saved_views before screen_capture_protection");
        assert!(scp < vo, "view_order last");
    }

    #[test]
    fn malformed_saved_view_collapses_to_parse_failed() {
        // A structurally-bad saved view (a `map` viewType) makes the whole prefs
        // plaintext fail to parse — the caller falls back to defaults (§9.5.5).
        let bad = br#"{"saved_views":[{"filters":{"kind":"all"},"id":"x","name":"n","view_type":"map"}],"screen_capture_protection":true}"#;
        assert_eq!(
            canonical_json_decode(bad),
            Err(PrefsBlobError::PlaintextParseFailed)
        );
    }

    #[test]
    fn default_prefs_has_empty_saved_views() {
        // §9.5.5 fall-back-to-defaults yields an empty saved-views set.
        assert!(PrefsView::default().saved_views.is_empty());
        assert!(PrefsView::default().view_order.is_empty());
    }

    // ---- paired_extensions (MYND-443, browser-clipper pairing-token persistence) ----

    fn sample_paired(
        ext: &str,
        tok: &str,
        revoked: bool,
    ) -> crate::paired_extension::PairedExtension {
        crate::paired_extension::PairedExtension {
            extension_id: String::from(ext),
            token_value: String::from(tok),
            revoked,
            paired_at: None,
        }
    }

    #[test]
    fn paired_extensions_round_trip_through_blob() {
        let prefs_key = derive_subkey(&fixed_root_key(), SubkeyRole::PrefsKey);
        let hash = fixed_account_number_hash();
        let original = PrefsView {
            paired_extensions: alloc::vec![
                sample_paired("ext-a", "aa11", false),
                sample_paired("ext-b", "bb22", true),
            ],
            ..PrefsView::default()
        };
        let blob =
            encode_prefs_blob_raw(&prefs_key, &hash, &original, &fixed_prefs_nonce()).unwrap();
        let decoded = decode_prefs_blob(&prefs_key, &hash, &blob).unwrap();
        assert_eq!(decoded.paired_extensions.len(), 2);
        // Encoded sorted by (extension_id, token_value): ext-a then ext-b.
        assert_eq!(decoded.paired_extensions[0].extension_id, "ext-a");
        assert!(!decoded.paired_extensions[0].revoked);
        assert_eq!(decoded.paired_extensions[1].extension_id, "ext-b");
        assert!(decoded.paired_extensions[1].revoked);
    }

    #[test]
    fn empty_paired_extensions_is_byte_identical_to_pre_feature() {
        // A vault that never paired an extension emits NO "paired_extensions"
        // key, so it is byte-identical to a pre-MYND-443 vault.prefs (existing
        // golden vectors unaffected — migration-less additive field).
        let encoded = canonical_json_encode(&PrefsView::default());
        assert!(find_subslice(&encoded, b"paired_extensions").is_none());
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
    }

    #[test]
    fn paired_extensions_canonical_key_position() {
        // paired_extensions sorts after last_backup_at and before saved_views.
        let original = PrefsView {
            last_backup_at: Some(1_700_000_000),
            paired_extensions: alloc::vec![sample_paired("e", "t", false)],
            saved_views: alloc::vec![sample_view("v1", "A")],
            ..PrefsView::default()
        };
        let s = String::from_utf8(canonical_json_encode(&original)).unwrap();
        let lba = s.find("\"last_backup_at\":").unwrap();
        let pe = s.find("\"paired_extensions\":").unwrap();
        let sv = s.find("\"saved_views\":").unwrap();
        assert!(lba < pe, "paired_extensions after last_backup_at");
        assert!(pe < sv, "paired_extensions before saved_views");
    }

    #[test]
    fn malformed_paired_extension_collapses_to_parse_failed() {
        // A structurally-bad record (missing token_value) makes the whole prefs
        // plaintext fail to parse — the caller falls back to the empty registry
        // (§9.5.5), so the extension must re-pair (never a partial grant).
        let bad = br#"{"paired_extensions":[{"extension_id":"x","revoked":false}],"screen_capture_protection":true}"#;
        assert_eq!(
            canonical_json_decode(bad),
            Err(PrefsBlobError::PlaintextParseFailed)
        );
    }

    #[test]
    fn default_prefs_has_empty_paired_extensions() {
        // §9.5.5 fall-back-to-defaults yields an empty paired-extensions set.
        assert!(PrefsView::default().paired_extensions.is_empty());
    }

    #[test]
    fn prefs_view_serde_serialization_omits_token_value() {
        // H1 regression: `prefs_read` returns `PrefsView` to the WebView via
        // serde. The bearer `token_value` must NEVER cross that IPC boundary
        // (`#[serde(skip_serializing)]` on `PairedExtension.token_value`); a
        // WebView that could read it would replay it to the 0600 relay and mint
        // clips without the pairing dialog. The Settings UI gets ids/timestamps
        // through the dedicated `pairing_list_paired` command, not `prefs_read`.
        // (On-disk persistence is hand-rolled canonical JSON and is unaffected —
        // `paired_extensions_round_trip_through_blob` covers that direction.)
        let view = PrefsView {
            paired_extensions: alloc::vec![sample_paired(
                "ext-a",
                "SECRET-bearer-token-must-not-leak",
                false,
            )],
            ..PrefsView::default()
        };
        let json = serde_json::to_string(&view).expect("PrefsView serializes");
        assert!(
            !json.contains("token_value"),
            "prefs_read JSON must not carry the token_value key: {json}"
        );
        assert!(
            !json.contains("SECRET-bearer-token-must-not-leak"),
            "prefs_read JSON must not carry the bearer secret value: {json}"
        );
        // We skip ONLY the bearer secret — the non-secret record fields still
        // serialize (so this is a confinement fix, not a blanket field removal).
        assert!(
            json.contains("ext-a"),
            "non-secret extension_id should still serialize: {json}"
        );
    }
}
