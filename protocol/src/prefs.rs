// SPDX-License-Identifier: AGPL-3.0-only

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
//! ## Additive fields
//!
//! A field documented below as omitted at its default is an additive field: an
//! untouched vault keeps emitting the bare pre-feature form, so the golden and
//! KAT vectors are unaffected and no magic, version or header byte moves. Each
//! docblock names the earlier field whose shape it copies.
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

/// Which narrowing model a connection's grant was written under.
///
/// **The model is a stored discriminator rather than an inferred shape**, and
/// the reason is the one thing shape-inference cannot do here: an allow list and
/// a deny list are both arrays of folder paths. Read the wrong way round, an
/// allow list of `private/` means "everything except `private/`", which is the
/// exact inverse of the consent the user gave, and nothing in the bytes would
/// look wrong.
///
/// [`McpScopeModel::Folders`] is what the released build minted. It is still
/// DECODED and preserved verbatim, and it is refused at call time with a named
/// reason instead of being reinterpreted, because widening a connection's reach
/// as a side effect of an upgrade is worse than asking the user again.
/// [`McpScopeModel::Exclude`] is what this build mints: the connection may read
/// the whole vault except the stored paths.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpScopeModel {
    /// Legacy allow list: [`McpConnectionGrant::folders`], frozen at approval.
    /// No longer minted; readable so an existing approval is never silently
    /// dropped or inverted.
    #[default]
    Folders,
    /// Deny list: [`McpConnectionGrant::excluded_folders`]. Every other folder
    /// in the vault is readable.
    Exclude,
}

impl McpScopeModel {
    /// The canonical JSON token for the model. `Folders` has none: it is the
    /// default, and the codec omits a default rather than spelling it out, so a
    /// legacy blob re-encodes byte for byte.
    pub fn canonical_token(self) -> Option<&'static str> {
        match self {
            McpScopeModel::Folders => None,
            McpScopeModel::Exclude => Some("exclude"),
        }
    }

    /// Parse the canonical token. `None` is an unknown model, which the parser
    /// refuses rather than defaulting: a future model read as `Folders` would be
    /// served with the legacy semantics it was not written under.
    pub fn from_canonical_token(token: &str) -> Option<Self> {
        match token {
            "folders" => Some(McpScopeModel::Folders),
            "exclude" => Some(McpScopeModel::Exclude),
            _ => None,
        }
    }
}

/// What a queued request asks the person to decide
/// (mcp external access rework, myne-md/myne#1052).
///
/// Two kinds, and they move the grant in OPPOSITE directions: accepting a write
/// request adds a folder to the write allow list, and accepting a read request
/// removes a folder from the read deny list. Both are one folder, both re-read the
/// grant at the moment of acceptance, and neither is authority the queue holds.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum McpRequestKind {
    /// The client tried to write into a folder it may read but was not granted for
    /// writing. This is every row written before the read kind existed, so it is
    /// the default and carries no token.
    #[default]
    Write,
    /// The client named a folder the user left out, and asked to read it.
    Read,
}

impl McpRequestKind {
    /// The canonical JSON token, or `None` for the default (a write request),
    /// which is omitted so a row written before this member existed re-encodes byte
    /// for byte.
    pub fn canonical_token(self) -> Option<&'static str> {
        match self {
            McpRequestKind::Write => None,
            McpRequestKind::Read => Some("read"),
        }
    }

    /// Parse the canonical token. `None` is an unknown kind, refused rather than
    /// defaulted: a future kind read as `Write` would widen where it meant to
    /// narrow.
    pub fn from_canonical_token(token: &str) -> Option<Self> {
        match token {
            "write" => Some(McpRequestKind::Write),
            "read" => Some(McpRequestKind::Read),
            _ => None,
        }
    }
}

/// One external MCP connection's grant: what a named client may read, when the
/// user approved it, and when it last ran a tool (external-mcp-connection,
/// myne-md/myne#923).
///
/// **The narrowing is a folder PATH SET, not a note list.** A note the user
/// later puts inside a covered folder is covered, because the unit is the path
/// rather than the note ids; a note-id set would make the grant decay as the
/// user works, which teaches them to re-approve without reading.
///
/// **Which paths are covered is [`McpScopeModel`]'s answer, and the model owns
/// exactly one of the two arrays.** A grant carrying both is refused by the
/// decoder rather than resolved by a precedence rule, because a precedence rule
/// is how one of the two meanings eventually gets read as the other.
///
/// **The name is a label, not a credential.** It distinguishes well-behaved
/// clients and makes per-connection scope and revocation possible; it stops
/// nothing a program running as the same OS user could not already do. That is
/// why an approval is recorded per name on ONE device rather than as a secret:
/// see [`PrefsView::mcp_connections`] for the classification and why it does not
/// sync.
///
/// **The write scope is a separate, narrower ALLOW list on the same record.**
/// [`write_folders`](Self::write_folders) names the folders a connection may
/// write in, and it is an allow list while the read scope beside it is a deny
/// list. The asymmetry is the decision rather than an oversight: reading a folder
/// the user did not think about is recoverable by revoking, and writing into one
/// is not. `decisions/ai/0752`.
///
/// **An absent write list is not "everywhere".** The member is omitted when no
/// folder was named, which keeps a grant written before it existed round-tripping
/// byte for byte, and both the resolver and the empty-list reading agree that an
/// absent or empty list means the connection may write NOWHERE. That is stated
/// here rather than left to the call site because "empty means everything" is
/// exactly the reading a later implementation would reach for by analogy with
/// [`excluded_folders`](Self::excluded_folders).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpConnectionGrant {
    /// The model this grant was written under. Omitted from the canonical JSON
    /// when it is [`McpScopeModel::Folders`], which is what makes a legacy blob
    /// round-trip byte for byte.
    #[serde(default)]
    pub model: McpScopeModel,
    /// **Legacy, and only meaningful under [`McpScopeModel::Folders`].** The
    /// canonical trailing-slash folder paths this connection may read: the whole
    /// of its reach, captured at approval. Never minted by this build; kept so a
    /// downgrade or a re-encode cannot silently drop an existing approval, and
    /// refused at call time rather than read as an exclusion list.
    /// **Set semantics**: NFC-normalized, lexicographically sorted,
    /// exact-deduplicated by the encoder.
    #[serde(default)]
    pub folders: Vec<alloc::string::String>,
    /// The canonical folder paths this connection may NOT read. Under
    /// [`McpScopeModel::Exclude`] the scope is every folder in the vault except
    /// these, and an entry takes its SUBTREE with it (prefix subtraction):
    /// excluding `Projects/` while leaving `Projects/2026/` readable would be
    /// the surprise the exclusion exists to remove.
    ///
    /// Empty is a real value under this model, meaning the whole vault, and the
    /// approval screen is what states that in words. **Set semantics**: NFC,
    /// sorted, exact-deduped, like every other folder set in this blob.
    #[serde(default)]
    pub excluded_folders: Vec<alloc::string::String>,
    /// When the user approved this connection, in Unix epoch **seconds**
    /// (`last_backup_at`'s unit: this is a "when did this happen" stamp shown to
    /// a person, not a last-write-wins clock compared across devices).
    #[serde(default)]
    pub approved_at: u64,
    /// When this connection last ran a tool, in Unix epoch seconds, or `None`
    /// for "never". Omitted entirely from the canonical JSON when `None`, so a
    /// freshly approved connection costs no bytes for a timestamp that does not
    /// exist yet.
    #[serde(default)]
    pub last_used_at: Option<u64>,
    /// The canonical folder paths this connection may **write** in: the folders
    /// the user named at approval for this connection. An **allow list**, and
    /// strictly narrower than the read scope, because a write into a folder the
    /// user never pictured is the surprise the whole feature is written against.
    ///
    /// **Empty means "nowrite", never "everywhere".** There is no input in
    /// this surface that can express "everywhere", and the encoder omits the
    /// member when the list is empty so a grant that predates the write scope
    /// still re-encodes byte for byte.
    ///
    /// **Set semantics**: NFC-normalized, lexicographically sorted,
    /// exact-deduplicated by the encoder, like every other folder set in this
    /// blob. Membership is exact-match on the folder key, not by prefix: writing
    /// into a folder created after the approval is a grant the user did not give,
    /// which is why the write scope is the one that stays a list of names.
    #[serde(default)]
    pub write_folders: Vec<alloc::string::String>,
    /// The verbs this connection may NOT call, as wire identifiers
    /// (`note_edit`, `note_move`, …), which is the switch bank on the approval
    /// screen (mcp external access rework, myne-md/myne#1052).
    ///
    /// **Absent or empty means every verb the catalog names is available.** That
    /// is the reading every grant written before this member existed must keep,
    /// and it is the opposite of [`write_folders`](Self::write_folders), where
    /// empty means "nowhere": a verb set that defaulted to "nothing enabled"
    /// would turn an upgrade into a revocation.
    ///
    /// **A name this build does not know is inert.** The catalog is the roster
    /// (`mcp/src/tool_list.rs`, nine verbs, all of them static literals), and a
    /// verb missing from it is not callable in the first place, so an unknown
    /// entry narrows nothing and widens nothing.
    ///
    /// **Set semantics**: lexicographically sorted and exact-deduplicated by the
    /// encoder, like every other set in this record.
    ///
    /// Omitted from the canonical JSON when empty, so a grant that disables
    /// nothing re-encodes byte for byte. Note the asymmetry with the parser, which
    /// REFUSES the member on a legacy ([`McpScopeModel::Folders`]) grant: such a
    /// grant serves nothing until it is approved again, so a verb set beside one
    /// would be a restriction nothing enforces.
    #[serde(default)]
    pub disabled_verbs: Vec<alloc::string::String>,
}

/// One write a connection attempted into a folder it may READ but not WRITE
/// (external-mcp-connection, myne-md/myne#923 task 13; `decisions/ai/0752`).
///
/// **The request is a proposal, never a pending write.** Nothing here is applied:
/// accepting one extends the grant by exactly [`folder`](Self::folder), and the
/// client retries against the wider scope it now holds. That is the whole reason
/// the record exists. A plain refusal is answered by a client retrying, and a
/// client retrying is indistinguishable from a client probing.
///
/// **`summary` is user text and AS3-class.** It is a title or a first line the
/// client offered so the person can recognise the write, it stays inside the AEAD
/// envelope with every other field, and it never reaches a log line. It is omitted
/// from the canonical JSON when empty, so a request that carries no summary costs
/// no bytes.
///
/// **Bounded by the writer, not by the codec.** The prefs plaintext budget already
/// caps the whole blob; the queue keeps itself short (`MAX_PENDING_WRITES` in
/// `core/src/plugins/mcp/queue.rs`) so a client in a retry loop cannot spend that
/// budget on its own refusals.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct McpWriteRequest {
    /// The declared connection name the write arrived under. NFC-normalized, like
    /// the grant map's keys, so the card addresses the same connection the
    /// approval did.
    #[serde(default)]
    pub connection: alloc::string::String,
    /// The folder the write named, canonical (`projects/`, the root as `""`).
    #[serde(default)]
    pub folder: alloc::string::String,
    /// When the client asked, in Unix epoch **seconds**: a "when did this
    /// happen" stamp shown to a person, like `approved_at`.
    #[serde(default)]
    pub requested_at: u64,
    /// What the client said it wanted to write, as one line: a title, a first
    /// sentence, or the field and value. USER TEXT (AS3-class): never logged.
    /// Omitted from the canonical JSON when empty.
    #[serde(default)]
    pub summary: alloc::string::String,
    /// The verb it called (`note_create`, `note_append`, …), so the card can say
    /// what was attempted rather than only where.
    #[serde(default)]
    pub verb: alloc::string::String,
    /// Which direction accepting this row moves the grant. Omitted from the
    /// canonical JSON for [`McpRequestKind::Write`], which is what every row
    /// written before the member existed already means.
    #[serde(default)]
    pub kind: McpRequestKind,
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
/// `src-tauri/AGENTS.md` rejects by name: that feature wraps the `Deserialize`
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

    /// Show the per-note "last edited" timestamp under each note row in the sidebar
    /// (sidebar-note-timestamps feature). Default `true` (timestamps visible — the pre-feature
    /// behaviour). **Omitted entirely from the canonical JSON when `true`** (the default;
    /// precedent: `item_colors` / `spell_enabled`). Only the non-default `false` is persisted.
    /// **Non-load-bearing** (a tampered / replayed value can at worst show or hide a date) — no
    /// protective-envelope clamp. NOTE the default polarity is INVERTED vs `spell_enabled`: this is
    /// a plain `bool` defaulting `true`, so the serde-derive path needs `default = "default_true"`
    /// (a bare `#[serde(default)]` would yield `false`). Canonical key `show_note_timestamps` —
    /// sorts after `screen_capture_protection` (`scr` < `sho`), before `spell_enabled` (`sho` <
    /// `spe`).
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

    /// The left ribbon's ordered pinned command ids (myne-md/myne#699).
    ///
    /// **`Option` on purpose.** `None` means the user has never configured the
    /// rail, so the client renders its curated default set; `Some([])` is a
    /// deliberately emptied rail and stays empty. A plain `Vec` could not tell
    /// those apart under the codec's omit-when-empty discipline, which would
    /// re-seed the defaults on a rail the user emptied. **Device-local** for the
    /// merge, like `bar_items_order` / `right_panel_tab_order`: the rail is a
    /// per-device chrome arrangement, so another device's rail never merges into
    /// this one. The enclosing `vault.prefs` blob still rides the sync wire and
    /// seeds a fresh device (see `sync-protocol.md` 10.2.1), so "device-local"
    /// is a merge classification and not "never leaves the device".
    /// **Non-load-bearing** (a tampered value can at worst rearrange or hide
    /// rail buttons), so there is no protective-envelope clamp. Canonical key
    /// `ribbon_items`, sorting after `reminders_enabled` (`re` < `ri`) and
    /// before `ribbon_visible`.
    #[serde(default)]
    pub ribbon_items: Option<Vec<String>>,

    /// Whether THIS DEVICE shows the left ribbon (myne-md/myne#699). Default
    /// `true`. **Device-local** for the same reason as `ribbon_items`.
    /// Inverted default polarity like `show_note_timestamps`, so the
    /// serde-derive path needs `default = "default_true"`; the encoder emits it
    /// only when `false`, keeping an untouched vault byte-identical. Canonical
    /// key `ribbon_visible`, sorting after `ribbon_items` and before
    /// `right_panel_active_tab`.
    #[serde(default = "default_true")]
    pub ribbon_visible: bool,

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
    /// grill 2026-05-29). Default empty. Conflict semantics are a union that
    /// carries a per-entry removal clock in `field_clocks` (myne#613,
    /// `sync-protocol.md` §10.2), NOT the clockless add-wins union this line
    /// described until then: without the clock a deletion is indistinguishable
    /// from never having had the entry, so a peer restores it. Encoded as a
    /// canonical JSON string array
    /// (NFC-normalized, lexicographically sorted, exact-deduped, and **omitted
    /// entirely when empty** so a vault with no deliberate folders is
    /// byte-identical to a v0.1.0 `vault.prefs`).
    #[serde(default)]
    pub deliberate_folders: Vec<alloc::string::String>,

    /// Developer mode master switch (developer-mode feature, MYND-593). `false` ≡ off (the
    /// default). **Omitted entirely from the canonical JSON when `false`**. Canonical key
    /// `developer_mode` — sorts after `deliberate_folders` (`deliberate_` < `developer_`, `l`=0x6C
    /// < `v`=0x76 at the 3rd byte), before `device_names` (`develope` < `device_n`, `e`=0x65 <
    /// `i`=0x69 at the 4th byte). Classified **device-local** in `sync-protocol.md` §10.2: it gates
    /// a device-local model-path override, so a synced flag would read "on" on a device with no
    /// override behind it. **Non-load-bearing** — a tampered/replayed value can at worst reveal or
    /// hide the AI/local-model developer surface; no protective-envelope clamp.
    #[serde(default)]
    pub developer_mode: bool,

    /// Friendly device names (device-management, SYNC-41) — a map of `device_id` (hex) →
    /// user-chosen display name. **The single home** for device names so no client ships a second
    /// default-name heuristic; both clients read/write it and it rides the already-synced, AEAD'd
    /// `MYP1` prefs. A `BTreeMap` so the canonical encoder emits keys in lexicographic order
    /// (precedent: `folder_icons` / `item_colors`). **Same canonical string→string map encoding as
    /// `folder_icons`** (NFC-normalized keys + values, lexicographic key order) and **omitted
    /// entirely from the canonical JSON when empty**. Default empty. Canonical key `device_names` —
    /// sorts after `deliberate_folders` (`del` < `dev`), before the `editor_*` block (`d` < `e`).
    /// **Non-load-bearing** (a tampered/replayed value can at worst mislabel a device in the device
    /// list) — no protective-envelope clamp.
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

    /// The **remote AI provider** the user named, or `None` for the default — which is not "off"
    /// but **unreachable**: with no provider selected there is no remote code path to reach
    /// (`decisions.md` 2026-08-09). A closed value, stored as its wire string: `"ollama-cloud"`,
    /// `"openrouter"`, `"opencode-zen"` or `"opencode-go"` (`decisions/ai/0773`). Kept as a `String` rather than an enum because this codec is `no_std`
    /// canonical JSON and an unknown value must decode to *something* a newer client wrote; the
    /// host validates it against its own registry and treats an unrecognized name as no provider.
    ///
    /// **The destination is NOT stored here.** Each provider's base URL is a compiled-in constant,
    /// so a tampered `vault.prefs` cannot redirect traffic to a host of the attacker's choosing.
    ///
    /// Canonical key `ai_provider` — sorts after `ai_excluded_folders` (`ai_e` < `ai_p`), before
    /// `ai_provider_consent` (a shorter string sorts before its own extension) and
    /// `archive_disabled` (`ai` < `ar`). Omitted entirely when `None`.
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
    /// It is also DENY-listed for logging (`src-tauri/AGENTS.md`).
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
    /// There is no default and Myne ships no per-provider fallback (SYNC-24): the user picks from
    /// the list the provider itself reports. A pinned model tag rots faster than the release that
    /// pinned it, and on a metered API a default nobody chose is a bill nobody chose. `None`
    /// therefore means *not yet chosen*, and the remote arm has nothing to ask with — which is a
    /// refusal, not a silent substitution.
    ///
    /// **Not `skip_serializing`, unlike the key.** The panel renders the current selection back to
    /// the user, so this value has to cross IPC; it is a model name the provider published, not a
    /// credential.
    ///
    /// Canonical key `ai_provider_model` — after `ai_provider_key` (`k` < `m`), before
    /// `archive_disabled` (`ai` < `ar`). Omitted when `None`, so a vault that never named a
    /// provider stays byte-identical to a pre-feature `vault.prefs`.
    #[serde(default)]
    pub ai_provider_model: Option<String>,

    /// Automatic on-device tag suggestion toggle (on-device-tag-suggestion, MYND-651). `false` ≡
    /// off (the default). **Omitted entirely from the canonical JSON when `false`**. Canonical key
    /// `auto_tag_enabled` — sorts after `auto_lock_seconds` (`auto_l` < `auto_t`), before
    /// `bar_items_order` (`a` < `b`).
    ///
    /// It is the SECOND half of a two-key gate: the tag pass runs only when this AND `ai_enabled`
    /// are both on, and the host re-reads both before it touches the model, so a tampered or
    /// replayed value cannot start inference on a vault whose AI opt-in is off. **Non-load-bearing
    /// / AS-low** — no protective-envelope clamp.
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

    /// Display date format (myne#279) — a closed enum string chosen from `system` / `iso` / `dmy` /
    /// `mdy` / `dmmmy`. `None` ≡ `system` (follow the OS locale), applied host-side. Stored as a
    /// free `Option<String>` here: the enum interpretation + unknown→default fallback live on the
    /// client, no codec-level validation (precedent: `editor_content_width`).
    ///
    /// **Display only.** It never enters a `.myn` file as a formatting instruction:
    /// `dialect/src/taskFields.ts` keeps the on-disk bytes zone-free and format-free, and this
    /// decides how they are printed, nothing else. It does of course live in a blob, namely this
    /// one, and it is Shared scalar-LWW, so it reaches every device by design. The "or a blob or
    /// the sync wire" this line used to carry was simply wrong (myne-md/myne#609). Canonical key
    /// `date_format`, sorting after `daily_template` (`dai` < `dat`), before `deliberate_folders`
    /// (`da` < `de`). Omitted when `None`. **Non-load-bearing** cosmetic (AS-low) — no
    /// protective-envelope clamp.
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

    /// Active workspace slot id (MYND-308) — the id of the workspace slot the editor should restore
    /// on unlock. `None` ≡ unset → the host applies its default (first / last-used) workspace
    /// policy. A free `Option<String>` stored verbatim (NFC-normalized at encode time); no
    /// codec-level value validation (precedent: `daily_folder`). Omitted entirely from the
    /// canonical JSON when `None`. **Non-load-bearing** (a tampered / replayed value can at worst
    /// restore the wrong workspace) — no protective-envelope clamp. Canonical key
    /// `active_workspace` — sorts FIRST, before `auto_lock_seconds` (`ac` < `au`).
    #[serde(default)]
    pub active_workspace: Option<alloc::string::String>,

    /// AI opt-in toggle (local-ai epic, ai-ux-surface MYND-408, SYNC-12). `false` ≡ AI off (the
    /// default). **Omitted entirely from the canonical JSON when `false`** (precedent:
    /// `archive_disabled`). Canonical key `ai_enabled` — sorts after `active_workspace` (`ac` <
    /// `ai`), before `archive_disabled` (`ai` < `ar`). **Non-load-bearing / AS-low** — no
    /// protective-envelope clamp; the host treats a tampered/replayed value as a cosmetic toggle.
    #[serde(default)]
    pub ai_enabled: bool,

    /// Folders excluded from every AI read/index (local-ai epic, ai-ux-surface MYND-408, SYNC-14) —
    /// canonical trailing-slash display form. **Same canonical encoding as `deliberate_folders`**
    /// (NFC-normalized, lexicographically sorted, exact-deduped set) and **omitted entirely when
    /// empty**. Default empty (whole vault in scope; AI is already opt-in). Canonical key
    /// `ai_excluded_folders` — sorts after `ai_enabled` (`ai_en` < `ai_ex`), before
    /// `archive_disabled` (`ai` < `ar`). **Non-load-bearing** — a tampered value can at worst
    /// widen/narrow this device's AI read scope; no protective-envelope clamp.
    #[serde(default)]
    pub ai_excluded_folders: Vec<alloc::string::String>,

    /// User toggle that disables the note-archive feature (archive-disable, MYND-…). `None` ≡ unset
    /// → the host applies the default-OFF policy (archiving enabled — the pre-feature behaviour).
    /// Omitted entirely from the canonical JSON when `None` (precedent: `editor_line_numbers`).
    /// **Non-load-bearing** (a tampered / replayed value can at worst show or hide the archive
    /// entry points; the underlying `archived:` frontmatter surgery is untouched) — no
    /// protective-envelope clamp. Canonical key `archive_disabled` — sorts after `active_workspace`
    /// (`ac` < `ar`), before `auto_lock_seconds` (`ar` < `au`).
    #[serde(default)]
    pub archive_disabled: Option<bool>,

    /// Folders archived as a unit (folder-archive) — canonical trailing-slash display form. **Same
    /// canonical encoding as `deliberate_folders` / `ai_excluded_folders`** (NFC-normalized,
    /// lexicographically sorted, exact-deduped set) and **omitted entirely when empty** (precedent:
    /// `ai_excluded_folders`). Default empty. A folder in this set (and its subtree) drops out of
    /// the working-set sidebar/tree while its notes stay resolvable (backlink / graph / search) —
    /// the folder-level twin of the per-note `archived:` marker. Canonical key `archived_folders` —
    /// sorts after `archive_disabled` (`archive_` `_`=0x5F < `archived` `d`=0x64), before
    /// `auto_lock_seconds` (`ar` < `au`). **Non-load-bearing** — a tampered value can at worst
    /// show/hide a folder subtree; no protective-envelope clamp.
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

    /// Editor line-number gutter toggle (editor-line-numbers, MYND-314). `None` ≡ unset → the host
    /// applies the default-OFF policy (prose-first; the gutter is opt-in). Omitted entirely from
    /// the canonical JSON when `None` (precedent: `spell_enabled`). **Non-load-bearing** (a
    /// tampered / replayed value can at worst show or hide the line-number gutter) — no
    /// protective-envelope clamp. Canonical key `editor_line_numbers` — sorts after `editor_layout`
    /// (`editor_la` < `editor_li`), before `editor_line_spacing` (`editor_line_n` <
    /// `editor_line_s`).
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

    /// Editor content max-width preset (editor-typography). `None` ≡ the canonical default
    /// `normal`, applied host-side. A closed enum string (`narrow`/`normal`/`wide`/`full`); stored
    /// as a free `Option<String>` here — the enum interpretation + unknown→default fallback live on
    /// the client (precedent: `daily_date_format`). Omitted entirely when `None`.
    /// **Non-load-bearing** cosmetic (AS-low) — no protective-envelope clamp. Canonical key
    /// `editor_content_width` — sorts after `deliberate_folders` (`d` < `e`), before
    /// `editor_default_view_mode` (`editor_c` < `editor_d`).
    #[serde(default)]
    pub editor_content_width: Option<alloc::string::String>,

    /// Editor default view-mode preset (MYND-299) — the mode a note opens in: `live` / `reading` /
    /// `source`. `None` ≡ the canonical default applied host-side. A closed enum string stored as a
    /// free `Option<String>` — the enum interpretation + unknown→default fallback live on the
    /// client (precedent: `editor_content_width`). Omitted entirely from the canonical JSON when
    /// `None`. **Non-load-bearing** cosmetic — no protective-envelope clamp. Canonical key
    /// `editor_default_view_mode` — sorts after `editor_content_width` (`editor_c` < `editor_d`),
    /// before `editor_focus_dim_inactive` (`editor_d` < `editor_f`).
    #[serde(default)]
    pub editor_default_view_mode: Option<alloc::string::String>,

    /// Editor focus-mode dim-inactive toggle (MYND-348). `None` ≡ unset → the host applies its
    /// default focus-mode policy at read time. Omitted entirely from the canonical JSON when `None`
    /// (precedent: `editor_line_numbers`). **Non-load-bearing** (a tampered / replayed value can at
    /// worst dim or undim the inactive paragraphs) — no protective-envelope clamp. Canonical key
    /// `editor_focus_dim_inactive` — sorts after `editor_default_view_mode` (`editor_d` <
    /// `editor_f`), before `editor_focus_typewriter` (`editor_focus_d` < `editor_focus_t`).
    #[serde(default)]
    pub editor_focus_dim_inactive: Option<bool>,

    /// Editor focus-mode typewriter-scrolling toggle (MYND-348). `None` ≡ unset → the host applies
    /// its default focus-mode policy at read time. Omitted entirely from the canonical JSON when
    /// `None` (precedent: `editor_line_numbers`). **Non-load-bearing** (a tampered / replayed value
    /// can at worst enable or disable typewriter scrolling) — no protective-envelope clamp.
    /// Canonical key `editor_focus_typewriter` — sorts after `editor_focus_dim_inactive`
    /// (`editor_focus_d` < `editor_focus_t`), before `editor_font_family` (`editor_focus` <
    /// `editor_font`: `c` < `n`).
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

    /// Vim keyboard-mode toggle (vim-keyboard-mode, MYND-313). `None` ≡ unset → the host applies
    /// the default-OFF policy (modal editing is opt-in). Omitted entirely from the canonical JSON
    /// when `None` (precedent: `editor_line_numbers`). **Non-load-bearing** (a tampered / replayed
    /// value can at worst turn modal editing on or off; it grants no capability and reaches no key
    /// material) — no protective-envelope clamp. Canonical key `editor_vim_mode` — sorts after
    /// `editor_toolbar_order` (`editor_to` < `editor_v`), before `favorites` (`e` < `f`).
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

    /// Whether speech-to-text may run on this vault's audio attachments (MYND-592). Canonical key
    /// `transcription_enabled` — sorts after `theme` (`the` < `tra`), before `view_order` (`t` <
    /// `v`).
    ///
    /// **Default ON**, hence the explicit default function — the same polarity as
    /// `attachment_ocr_enabled` and for the same two reasons: a bare `#[serde(default)]` would
    /// yield `false` and silently disable the feature for every vault whose blob predates the
    /// field, and emitting only the non-default `false` keeps such a vault byte-identical to a
    /// pre-feature `vault.prefs`.
    ///
    /// This field exists because transcription was previously gated on `ai_enabled` — the
    /// *embedding store's* opt-in, which it has nothing to do with. Speech-to-text ships a bundled
    /// model, runs entirely on-device and does one bounded, user-initiated thing, so it is a
    /// product feature rather than a lab experiment and carries its own switch.
    ///
    /// **Non-load-bearing / AS-low** — no protective-envelope clamp. A tampered value can at worst
    /// enable or disable a user-initiated local computation; it grants no read access the vault did
    /// not already have, and the host re-reads it rather than trusting the WebView. Display time
    /// format (myne#279) — a closed enum string chosen from `system` / `24h` / `12h`. `None` ≡
    /// `system` (follow the OS locale), applied host-side. Same free-`Option<String>` + client-side
    /// validation discipline as [`PrefsView::date_format`]. Canonical key `time_format` — sorts
    /// after `theme` (`th` < `ti`), before `timezone` (`_` < `z`). Omitted when `None`.
    /// **Non-load-bearing** cosmetic — no clamp.
    #[serde(default)]
    pub time_format: Option<alloc::string::String>,

    /// Display timezone override (myne#279) — an IANA zone identifier, or `None`
    /// ≡ `system` (the host's own zone).
    ///
    /// **Display only, and that is load-bearing for a different reason than the
    /// two fields above.** It decides what the app considers "today" and how a
    /// stored wall-clock value is printed. It NEVER enters a `.myn` file:
    /// `dialect/src/taskFields.ts` states the rule this preserves, that no
    /// timezone offset and no zone identifier is ever produced, times are local
    /// wall-clock, which is what a personal reminder means and which keeps a
    /// coarse geolocation datum out of a file that gets exported as plaintext.
    /// Storing the *display* choice here, encrypted at rest and never in note
    /// bytes, does not walk that back.
    ///
    /// It DOES enter a blob, namely this one, and the sentence above said
    /// otherwise in the same paragraph that then described storing it here
    /// (myne-md/myne#609). The blob is pushed and pulled verbatim; `DeviceLocal`
    /// governs the MERGE, so the local value survives, and `sync-protocol.md`
    /// 10.2.1 has a newly enrolled device adopt it as a starting default.
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

    /// Folder-notes feature off-switch (myne-md/myne#661). Gates the
    /// folder-index entry points and whether a note's `folder_index: true`
    /// flag is honoured for sidebar / link presentation. A plain `bool`
    /// defaulting **`false`** (feature off), so an untouched vault meets folder
    /// notes hidden; **emitted ONLY when `true`**, omitted entirely at the
    /// default so a vault that never enabled the feature is byte-identical to a
    /// pre-#661 `vault.prefs` (existing golden vectors unaffected, the
    /// `auto_tag_enabled` polarity). The switch touches **no bytes**: a note
    /// keeping `folder_index: true` while the feature is off is a correct,
    /// fully-reversible state, so this field never rewrites managed frontmatter.
    /// Classified **Shared / scalar last-write-wins**, a sibling note-list
    /// presentation preference (`show_task_marker` class), consistent across a
    /// user's devices rather than re-chosen per device. **Non-load-bearing**: a
    /// tampered / replayed value can at worst show or hide a sidebar affordance.
    /// Canonical key 'f' sorts after `folder_icons` (`folder_i` < `folder_n`),
    /// before `hidden_bar_items` (`f` < `h`).
    #[serde(default)]
    pub folder_notes_enabled: bool,

    /// Hidden bottom-bar item ids (MYND bottom-bar customization) — the **set** of `BottomBar`
    /// element ids the user chose to hide via the bar's right-click menu (e.g. `graph`, `tags`,
    /// `word-count`). A `set`-semantics array: NFC-normalized, lexicographically sorted,
    /// exact-deduped, and **omitted entirely when empty** (precedent: `spell_languages`). An
    /// unknown id is ignored at render and pruned on the next write (no codec-level GC).
    /// **Non-load-bearing** (a tampered / replayed value can at worst hide or reveal a bar
    /// affordance) — no protective-envelope clamp. Canonical key 'h' — sorts after `folder_icons`
    /// (`f` < `h`), before `item_colors` (`h` < `i`).
    #[serde(default)]
    pub hidden_bar_items: Vec<String>,

    /// The home surface's ordered card list (myne-md/myne#1074).
    ///
    /// **`Option` for the reason `ribbon_items` is.** `None` means the user has
    /// never arranged their home, so the client renders its default layout and
    /// writes nothing; `Some([])` is a deliberately emptied home and stays empty.
    /// A plain `Vec` could not tell those apart under the codec's
    /// omit-when-empty discipline, which would re-seed the defaults over a home
    /// the user had emptied.
    ///
    /// **Synced, not device-local.** The arrangement is how this person likes to
    /// start work, not a property of one machine, so it merges like
    /// `favorites` rather than like `ribbon_items`. **Non-load-bearing** (a
    /// tampered value can at worst rearrange cards), so there is no
    /// protective-envelope clamp. The shape lives in
    /// [`crate::home_layout`]; this member is only where it sits. Canonical key
    /// `home_cards` — sorts after `hidden_bar_items` (`hid` < `hom`), before
    /// `home_open_on_start` (`home_c` < `home_o`).
    #[serde(default)]
    pub home_cards: Option<Vec<crate::home_layout::HomeCard>>,

    /// Whether THIS DEVICE opens the home tab on start (myne-md/myne#1074).
    /// Default `false`, so an untouched vault keeps today's behaviour: the app
    /// opens on the workspace it was left on.
    ///
    /// **Device-local**, by the rule the other device-local switches follow: a
    /// desktop that opens on its home surface and a phone that opens on the note
    /// you were reading are both reasonable, so the value must not follow the
    /// person between them. Omit-when-default, so a vault that never set it stays
    /// byte-identical to a pre-#1074 `vault.prefs`. Canonical key
    /// `home_open_on_start` — after `home_cards`, before `icon`.
    #[serde(default)]
    pub home_open_on_start: bool,

    /// User-chosen bottom-bar item display order (MYND bottom-bar customization, drag-to-reorder
    /// twin of [`PrefsView::hidden_bar_items`]). A `sequence`-semantics array of right-cluster
    /// `BottomBar` element ids (e.g. `view-mode`, `tags`, `graph`) in the order the user arranged
    /// them by dragging or via the bar's right-click "move left / move right" actions. Order is
    /// MEANINGFUL (precedent: `view_order`). An id not in the host's known set is ignored at render
    /// and pruned on the next write (no codec-level GC); a known id absent from the array falls
    /// back to its canonical default position. **Non-load-bearing** (a tampered / replayed value
    /// can at worst reorder a bar affordance) — no protective-envelope clamp. Canonical key 'b' —
    /// sorts after `auto_lock_seconds` (`au` < `b`), before `custom_theme` (`b` < `c`).
    #[serde(default)]
    pub bar_items_order: Vec<String>,

    /// Calendar settings (myne-md/myne#1037) - a flat string map the client owns
    /// both halves of, keyed by SETTING: `day_reminder_anchor` (an `HH:MM` local
    /// wall-clock time, the anchor an all-day event's relative reminder counts
    /// back from) and `colours.<calendar name>` (the design-token name that
    /// calendar draws in, never a colour literal, so a custom theme repaints the
    /// calendar with the rest of the app).
    ///
    /// **One map rather than two fields, and the shape is `periodic_notes`'s
    /// verbatim**: a `BTreeMap<String, String>` gets lexicographic key order from
    /// the canonical encoder for free, reuses the existing string-map codec, and
    /// leaves the key grammar to the client, so a later calendar setting costs no
    /// protocol change at all. A codec that validated either half would turn every
    /// future setting into a format decision.
    ///
    /// Default empty; **omitted entirely from the canonical JSON when empty**, so
    /// a vault that never touched a calendar setting is byte-identical to a
    /// pre-myne#1037 `vault.prefs` (existing golden vectors unaffected, a
    /// migration-less additive field on `MYP1`: no new magic, no new `SubkeyRole`,
    /// no new AAD role, zero new crypto). **Non-load-bearing** (cosmetic plus
    /// cold/derivable, AS-low): a replayed or tampered value can at worst draw one
    /// calendar in the wrong colour or fire an all-day reminder at the wrong hour,
    /// so it carries no protective-envelope clamp.
    ///
    /// Canonical key `calendar_settings`, which sorts after `bar_items_order`
    /// (`ba` < `ca`), before `chat_history_budget` (`cal` < `cha`). That position
    /// is the cursor-scanned region rather than the `strip_prefix` run, which is
    /// where an additive field belongs for the reason `chat_history_budget`'s own
    /// doc states at length.
    #[serde(default)]
    pub calendar_settings: BTreeMap<String, String>,

    /// How many characters of visible chat history an agent run may be seeded with
    /// (myne-md/myne#617). `None` means the host applies its own default.
    ///
    /// **A bound rather than a feature toggle.** `build_request` re-sends every message on every
    /// iteration, up to the loop's 24-iteration ceiling, so this number is multiplied by the
    /// iteration count, and on the remote arm it is multiplied into characters that leave the
    /// device. TB13 and `decisions/ai/0515` both record that no per-run volume cap exists
    /// anywhere else, which is why the host clamps it.
    ///
    /// **The clamp is WRITE-side, which is a weaker class than `auto_lock_seconds`, and saying
    /// otherwise would overstate it.** That field resolves `clamp(..)` in code at every read, so a
    /// replayed or tampered `vault.prefs` can only make auto-lock stricter no matter who wrote it.
    /// This one is clamped in its setter, so the bound holds while every writer clamps: a property
    /// of today's call sites rather than of the value. Nothing reachable exploits the difference
    /// (the blob is AEAD-sealed and AAD-bound, so a replay can only restore a previously-clamped
    /// value), and the read path deliberately does not re-clamp so a second copy of the ceiling
    /// cannot drift from the real one. A second writer, on the mobile port or anywhere else, is the
    /// case that would make this matter, and it is the reason the distinction is written down
    /// rather than glossed.
    ///
    /// Additive on `MYP1` and omitted entirely when unset (precedent: `archive_disabled`).
    /// Canonical key `chat_history_budget`, which sorts after `bar_items_order` (`b` < `c`) before
    /// `cli_enabled` (`ch` < `cl`).
    ///
    /// **That position is the load-bearing part of the name, not a preference.** The decoder
    /// locates every field up to and including `auto_lock_seconds` by `strip_prefix`, so an unknown
    /// key inside that run is not skipped: it sits in front of the next marker and every
    /// prefix-chained field behind it misses and takes its default. A field named for its consumer
    /// (`agent_history_budget`) sorted into exactly that run, and an already shipped client reading
    /// a blob that carried it would have decoded SUCCESSFULLY while silently losing
    /// `auto_lock_seconds`, `ai_excluded_folders` and the `Zeroizing`-wrapped `ai_provider_key`,
    /// then persisted that loss on its next read-modify-write. Successfully is the bad part:
    /// `update_prefs_with_dir` refuses to write over a read that ERRORED, and this degrades without
    /// erroring. Named for what is budgeted instead, the key lands in the cursor-scanned region,
    /// where `find_top_level_marker` scans forward and an unknown key between two known ones is
    /// skipped. `docs/spec/protocol.md` §9.5.2's forward-compat clause is only true of that region,
    /// and an additive field belongs there.
    #[serde(default)]
    pub chat_history_budget: Option<u32>,

    /// CLI terminal-access door toggle (myne-cli epic, MYND-490; `cli-thin-client` task 2). `false`
    /// ≡ the door is closed (the default) — the local socket the `myne` CLI dials is never created
    /// regardless of unlock state. **Omitted entirely from the canonical JSON when `false`**
    /// (precedent: `ai_enabled`). Class `DeviceLocal` (see
    /// `core/src/plugins/sync/prefs_classification.rs`): the CLI door is a per-machine decision, so
    /// this value never travels in a merge — a laptop and a desktop each carry their own. Rationale
    /// for the no-identity-gatekeeper design this toggle is one leg of: `decisions.md` "CLI
    /// terminal access is a default-off, unlock-gated local socket with a folder exclusion list
    /// (MYND-490)" and `docs/threat-model.md` §7. **Non-load-bearing / AS-low** — no
    /// protective-envelope clamp; the host treats a tampered/replayed value as a cosmetic toggle,
    /// same as `ai_enabled`. Canonical key `cli_enabled` — sorts after `bar_items_order` (`b` <
    /// `c`), before `cli_excluded_folders` (`cli_en` < `cli_ex`) and `custom_theme` (`cli` < `cu`).
    #[serde(default)]
    pub cli_enabled: bool,

    /// Folders excluded from the CLI's reach (myne-cli epic, MYND-490; `cli-thin-client` task 2) —
    /// canonical trailing-slash display form. **Same canonical encoding as `deliberate_folders` /
    /// `ai_excluded_folders`** (NFC-normalized, lexicographically sorted, exact-deduped set) and
    /// **omitted entirely when empty**. Default empty (whole vault in scope once the door is
    /// opened). Class `Shared(SetUnion)`: an exclusion added on one device must never be lost in a
    /// merge with a device that lacks it — union is the fail-safe discipline, exactly the
    /// `ai_excluded_folders` precedent. Enforcement of the exclusion (filtering
    /// `list`/`search`/writes) is out of scope for this field's codec — see `cli-thin-client` task
    /// 5; this field only stores and syncs the set. **Non-load-bearing** — a tampered value can at
    /// worst widen/narrow the CLI's reach; no protective-envelope clamp. Canonical key
    /// `cli_excluded_folders` — sorts after `cli_enabled` (`cli_en` < `cli_ex`), before
    /// `cli_rate_limit_disabled` (`cli_ex` < `cli_r`) and `custom_theme` (`cli` < `cu`).
    #[serde(default)]
    pub cli_excluded_folders: Vec<alloc::string::String>,

    /// CLI socket rate-limit opt-out (myne-cli epic, MYND-490; `cli-thin-client` task 2). **Shape
    /// decision, made by this field** (task 2's "What to build" flagged the rate-limit field's
    /// shape as an open question): modeled **exactly on the `archive_disabled` precedent** —
    /// `Option<bool>`, not a numeric requests-per-second value, because the control the user is
    /// given in Settings is a single on/off switch ("remove the default slowdown"), not a tunable
    /// rate. `None` ≡ unset → the default-ON rate limit applies (a runaway or hostile script cannot
    /// drain the vault at full speed). `Some(true)` ≡ the user explicitly disabled the limit in
    /// Settings (task 10 reads this to skip rate-limiting the socket). `Some(false)` is a legal
    /// value — re-enabling the limit after disabling it — but the UI is not expected to ever
    /// produce it: omitting the field again (returning to `None`) has the identical effect, and
    /// which one a "re-enable" control writes is the client's choice, not something this codec
    /// cares about. Omitted entirely from the canonical JSON when `None`. Class `DeviceLocal`: a
    /// machine-local performance knob — a laptop and a desktop may legitimately want different
    /// limits. **Non-load-bearing** (a tampered/replayed value can at worst speed up or slow down
    /// the CLI socket; it grants no capability the door does not already grant) — no
    /// protective-envelope clamp. Canonical key `cli_rate_limit_disabled` — sorts after
    /// `cli_excluded_folders` (`cli_ex` < `cli_r`), before `custom_theme` (`cli` < `cu`).
    #[serde(default)]
    pub cli_rate_limit_disabled: Option<bool>,
    /// Color-group rules (graph-connection-ux-polish, MYND-604) — the ordered list of user-authored
    /// `{id, name, color, enabled, filter}` rules the knowledge-graph pane paints matching notes
    /// with at render time. ONE structured field, not a field per rule (precedent: `saved_views`).
    /// Order is MEANINGFUL and IS the rule precedence — first match wins — so unlike `saved_views`
    /// (sorted by id; its display order lives in the separate `view_order`) this array is preserved
    /// **verbatim**, never re-sorted (the `bar_items_order` / `favorites` sequence discipline, but
    /// classified whole-value LWW, not sequence-LWW — see
    /// `core::plugins::sync::prefs_classification`). A disabled rule stays in the list, evaluated
    /// as a no-match. Each element is a nested canonical [`crate::color_group::ColorGroup`] object;
    /// `filter` reuses the same `FilterNode` AST `saved_views` already persists. Default empty;
    /// **omitted entirely from the canonical JSON when empty**, so a vault that never opens the
    /// feature stays byte-identical to a pre-feature `vault.prefs`. AS3-Sensitive (a rule's name /
    /// filter / referenced tag or folder) — rides the existing prefs AEAD envelope;
    /// **non-load-bearing** (no protective-envelope clamp — a tampered or replayed `vault.prefs`
    /// can at worst reset rules to empty or apply a stale rule set, never expose or corrupt note
    /// content). Canonical key `color_groups` — sorts after `bar_items_order` (`b` < `c`), before
    /// `custom_theme` (`col` < `cus`).
    #[serde(default)]
    pub color_groups: Vec<crate::color_group::ColorGroup>,

    /// Per-vault decorative icon (vault-icons) — the curated stroke-glyph name the in-app vault
    /// switcher shows beside this vault's name, replacing the default `M` wordmark. `None` ≡ no
    /// icon set → the switcher shows the neutral `M` fallback. Drawn from the client's curated
    /// glyph set (the same `FOLDER_ICON_PATHS` family as [`PrefsView::folder_icons`]); an unknown
    /// name is ignored at render (falls back to the wordmark). A **non-load-bearing** cosmetic
    /// preference (AS-low) — a tampered/replayed `vault.prefs` can at worst surface a different
    /// glyph — so no protective-envelope clamp. Like [`PrefsView::label`], the icon lives
    /// **encrypted-only** inside `vault.prefs` (SYNC-3): it decrypts into a per-session RAM cache
    /// on unlock and the switcher reads that cache (never re-derivable from disk without the
    /// `prefs_key`). NFC-normalized + **omitted entirely when `None`**. Canonical key `icon` —
    /// sorts after `hidden_bar_items` (`h` < `i`), before `item_colors` (`ico` < `ite`).
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

    /// **External MCP connection grants** (external-mcp-connection,
    /// myne-md/myne#923), keyed by the connection name the client declares — one
    /// [`McpConnectionGrant`] per name, carrying the folders it may NOT read,
    /// the approval stamp and the last-use stamp.
    ///
    /// **Device-local, and that is the point rather than a detail.** This is the
    /// consent record for opening the vault to a process Myne does not ship, and
    /// a synced copy would let a newly enrolled device inherit an approval nobody
    /// gave it. The same bug was found twice in this tree already (the AI provider
    /// consent until myne-md/myne#456, and the plugin feature's post-audit pass),
    /// and a synced grant would also mean something different per device: the
    /// exclusions name folder paths, and two devices can hold different trees
    /// after a merge. `sync-protocol.md` §10.2 classifies it `DeviceLocal`, so the
    /// local value always survives the merge and a second device is asked again.
    ///
    /// A `BTreeMap` so the canonical encoder emits connection names in
    /// lexicographic order, and the whole map is **omitted entirely when empty**,
    /// so a vault that never granted a connection is byte-identical to a
    /// pre-feature `vault.prefs`. A decoder that does not find the key MUST treat
    /// it as the empty map, which is "no connection granted" — not an error, and
    /// not a default grant.
    ///
    /// **Non-load-bearing** in the protective-envelope sense (a replay can at
    /// worst restore or drop an approval; the host still re-reads the live blob
    /// before serving a call), so it carries no clamp. AS3-class content: folder
    /// paths, and they stay inside the AEAD envelope like every other field.
    /// Every write goes through the one read-modify-write helper that bumps the
    /// prefs nonce (`core/src/plugins/prefs/commands.rs::update_prefs_with_dir`).
    /// Canonical key `mcp_connections` — sorts after `last_backup_at` (`las` <
    /// `mcp`) and before `meeting_ai_prompt` (`mc` < `me`).
    #[serde(default)]
    pub mcp_connections: BTreeMap<alloc::string::String, McpConnectionGrant>,

    /// **External MCP write requests** (external-mcp-connection, myne-md/myne#923
    /// task 13): writes a connection attempted into a folder it may read but not
    /// write, waiting for a person to accept or dismiss them. Device-local, like
    /// the grants beside them and for the same reason: the folder paths name one
    /// device's tree, so a request accepted on another machine would widen a grant
    /// that machine does not hold.
    ///
    /// **A queue of proposals, never a pending write.** Nothing is applied from
    /// here; accepting a request extends the grant by that one folder and the
    /// client retries.
    ///
    /// **Set semantics**: canonical folder keys and connection names, sorted, with
    /// one request per `(connection, folder, verb)`, the newest, so a client in a
    /// retry loop cannot fill the queue with its own duplicates. Omitted entirely
    /// when empty, so a vault that has never had one is byte-identical to a
    /// pre-feature `vault.prefs`. Canonical key `mcp_write_requests`, which sorts
    /// after `mcp_connections` (`mcp_` < `mcpd`) and before `meeting_ai_prompt`
    /// (`mc` < `me`).
    #[serde(default)]
    pub mcp_write_requests: Vec<McpWriteRequest>,

    /// **Meeting AI prompt** (meeting-ai): the user's replacement for the meeting AI pass's reduce
    /// instruction. `None` or empty means the built-in default instruction (which carries the
    /// section headings and the language line); a non-empty value is used verbatim and replaces
    /// that machinery. It scopes to the meeting AI feature only, not the other AI surfaces. Omitted
    /// entirely from the canonical JSON when `None`. **Non-load-bearing** (a tampered / replayed
    /// value changes only what the user's own model is asked to produce), no protective-envelope
    /// clamp. Canonical key `meeting_ai_prompt` sorts after `last_backup_at` (`l` < `m`), before
    /// `new_note_location` (`m` < `n`).
    #[serde(default)]
    pub meeting_ai_prompt: Option<alloc::string::String>,

    /// Default location for newly-created notes (MYND-462, "Files" settings panel) — the MODE:
    /// `root` (vault root), `current` (the active note's folder), or `specific` (the folder named
    /// by [`PrefsView::new_note_location_folder`]). `None` ≡ the canonical default `root`, applied
    /// host-side. A closed enum string stored as a free `Option<String>` — the enum interpretation
    /// and the unknown→default fallback live on the client (precedent:
    /// `editor_default_view_mode`).
    /// Omitted entirely from the canonical JSON when `None`. **Non-load-bearing** (a tampered /
    /// replayed value can at worst place a new note in the wrong folder) — no protective-envelope
    /// clamp. Canonical key `new_note_location` — sorts after `last_backup_at` (`l` < `n`), before
    /// `new_note_location_folder` (prefix) and `paired_extensions` (`n` < `p`).
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

    /// Which file opens on app startup (MYND-462, "Files" settings panel) — the MODE: `last`
    /// (restore the last workspace layout — the pre-feature behaviour), `empty` (open a fresh empty
    /// editor), or `specific` (open the note named by [`PrefsView::startup_open_note`]). `None` ≡
    /// the canonical default `last`, applied host-side. A closed enum string stored as a free
    /// `Option<String>` — the enum interpretation + unknown→default fallback live on the client
    /// (precedent: `editor_default_view_mode`). Omitted entirely from the canonical JSON when
    /// `None`. **Non-load-bearing** (a tampered / replayed value can at worst open the wrong note
    /// or an empty editor; the saved workspace is never destroyed) — no protective-envelope clamp.
    /// Canonical key `startup_open` — sorts after `spell_languages` (`spe` < `sta`), before
    /// `startup_open_note` (prefix) and `theme` (`sta` < `the`).
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

    /// Periodic-notes settings (myne#177): one entry per `<period>.<setting>`
    /// pair, e.g. `weekly.folder` → `Weekly/`, `monthly.format` → `YYYY-MM`,
    /// `weekly.template` → a template note's UUIDv7. The three settings mirror
    /// what `daily_folder` / `daily_date_format` / `daily_template` already
    /// carry for the daily period, which keeps its three top-level fields and
    /// is deliberately NOT migrated in here: prefs merge per field, so a device
    /// on an older build would go on writing the flat fields while a newer one
    /// wrote this map, and the two would silently diverge with no way to say
    /// which is authoritative.
    ///
    /// A flat `BTreeMap<String, String>` rather than a map of nested objects,
    /// which buys two things. The canonical encoder emits keys in lexicographic
    /// order for free and the existing string-map codec applies unchanged (the
    /// `folder_icons` / `item_colors` precedent class, keys + values
    /// NFC-normalized at encode time). And the Phase 2 field clock is then
    /// `periodic_notes/<period>.<setting>`, i.e. per SETTING: a folder edit on
    /// one device and a template edit on another, to the same period in the
    /// same round, both survive.
    ///
    /// The `<period>.<setting>` grammar is the CLIENT's, exactly like
    /// `daily_date_format`'s token grammar. This codec validates nothing and
    /// stores both halves verbatim, so an entry naming a period this build does
    /// not know (a later `quarterly.folder`) decodes and is ignored rather than
    /// failing the blob. That is what makes a fourth period cost no spec change.
    ///
    /// Default empty; **omitted entirely from the canonical JSON when empty**,
    /// so a vault that configured no period is byte-identical to a pre-myne#177
    /// `vault.prefs` (existing golden vectors unaffected, a migration-less
    /// additive field on `MYP1`: no new magic, no new `SubkeyRole`, no new AAD
    /// role, zero new crypto). **Non-load-bearing** (cold/derivable, AS-low): a
    /// replayed or tampered value can at worst file a period note in the wrong
    /// folder or title it differently, so no protective-envelope clamp.
    /// Canonical key `periodic_notes`, which sorts after `paired_extensions`
    /// (`pai` < `per`), before `reminder_horizon_days` (`p` < `r`).
    #[serde(default)]
    pub periodic_notes: BTreeMap<String, String>,

    /// Active right-panel tab id (right-panel tabs) — the id of the right sidebar tab the editor
    /// should restore (e.g. `backlinks`, `unlinked`, `outline`). `None` ≡ unset → the host applies
    /// its default (the first visible tab in canonical order). A free `Option<String>` stored
    /// verbatim (NFC-normalized at encode time); no codec-level value validation (precedent:
    /// `active_workspace`). Omitted entirely from the canonical JSON when `None`.
    /// **Non-load-bearing** (a tampered / replayed value can at worst restore the wrong tab) — no
    /// protective-envelope clamp. Canonical key `right_panel_active_tab` — sorts after
    /// `paired_extensions` (`p` < `r`), before `right_panel_hidden_tabs`.
    #[serde(default)]
    pub right_panel_active_tab: Option<alloc::string::String>,

    /// Hidden right-panel tab ids (right-panel tabs) — the **set** of right sidebar tab ids the
    /// user chose to hide via the panel's right-click menu. A `set`-semantics array:
    /// NFC-normalized, lexicographically sorted, exact-deduped (precedent: `canonical_folder_list`
    /// / `hidden_bar_items`), and **omitted entirely when empty**. An unknown id is ignored at
    /// render and pruned on the next write (no codec-level GC). **Non-load-bearing** (a tampered /
    /// replayed value can at worst hide or reveal a tab) — no protective-envelope clamp. Canonical
    /// key `right_panel_hidden_tabs` — sorts after `right_panel_active_tab`, before
    /// `right_panel_tab_order`.
    #[serde(default)]
    pub right_panel_hidden_tabs: Vec<String>,

    /// User-chosen right-panel tab display order (right-panel tabs, drag-to-reorder twin of
    /// [`PrefsView::right_panel_hidden_tabs`]). A `sequence`-semantics array of right sidebar tab
    /// ids in the order the user arranged them by dragging or via the panel's "move left / move
    /// right" actions. Order is MEANINGFUL. An id not in the host's known set is ignored at render
    /// and pruned on the next write (no codec-level GC); a known id absent from the array falls
    /// back to its canonical default position. **Non-load-bearing** (a tampered / replayed value
    /// can at worst reorder a tab) — no protective-envelope clamp. Canonical key
    /// `right_panel_tab_order` — sorts after `right_panel_hidden_tabs`, before `saved_views` (`r` <
    /// `sav`).
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

    /// `saved_views` entries this build CANNOT represent, carried verbatim from
    /// the bytes it read so a whole-blob re-write re-emits them instead of
    /// deleting a newer client's views (§9.5.2 / §9.5.5). A newer client's
    /// `view_type` (`"timeline"`, …) is the motivating case: without this carrier
    /// the array decode fails, §9.5.5 falls the WHOLE blob back to defaults, and
    /// this client's next write pushes that loss to every device — the theme,
    /// keymap and favorites gone because of one view it could not render.
    ///
    /// **Not a preference field, and deliberately NOT on the wire.**
    /// `#[serde(skip)]` keeps it off the IPC/serde path — the host struct is
    /// authoritative because prefs writes are per-field setters that read the
    /// whole view and write it back, so the carrier survives a setter without
    /// the WebView ever holding raw bytes it cannot interpret. It has no
    /// canonical key, no clock and no §10.2 classification: it is part of the
    /// `saved_views` encoding, not a field beside it, which is also why the
    /// merge carries it along with whichever side wins the whole-value LWW.
    #[serde(skip)]
    pub opaque_saved_views: Vec<crate::saved_view::OpaqueSavedView>,

    /// Device-local approval of saved views (`view-manifests`): one row per
    /// view id this DEVICE has approved, holding the definition VERSION that was
    /// approved. Canonical key `view_approvals`, after `transcription_enabled`
    /// (`view_a` < `view_o`), before [`PrefsView::view_order`].
    ///
    /// **Device-local on purpose, and it is the whole point of the field.** An
    /// approval is a decision a person makes at a device, so §10.2's merge keeps
    /// the local map and a freshly enrolled device never inherits one. The
    /// precedent is `ai_provider_consent` in this same section: it was shared
    /// until a new device inherited the consent and began sending with nobody
    /// there having been asked.
    ///
    /// "Approved" is an EQUALITY, not a flag: the value must equal the view's
    /// current `version`, so a version bump revokes approval with no clear step
    /// and nothing to forget. [`crate::view_manifest::is_view_approved`] is the
    /// single comparison.
    ///
    /// Values are the same bare non-negative integers (and the same canonical
    /// map encoding: NFC keys, lexicographic order) the `field_clocks` map uses,
    /// so the framing has one implementation. A stored number no `version` can
    /// hold simply never matches, which is the fail-closed direction.
    ///
    /// Keyed by an opaque view id and a number, and it says nothing about a
    /// note, so it is not AS3-sensitive content; it is omitted entirely when
    /// empty, so a vault that never approves anything stays byte-identical to a
    /// pre-feature blob.
    #[serde(default)]
    pub view_approvals: BTreeMap<String, u64>,

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
            calendar_settings: Default::default(),
            chat_history_budget: None,
            cli_enabled: false,
            cli_excluded_folders: Vec::new(),
            cli_rate_limit_disabled: None,
            color_groups: Vec::new(),
            show_note_timestamps: true,
            reminders_enabled: true,
            ribbon_items: None,
            ribbon_visible: true,
            reminder_horizon_days: None,
            show_task_marker: true,
            folder_icons: Default::default(),
            folder_notes_enabled: false,
            hidden_bar_items: Vec::new(),
            home_cards: None,
            home_open_on_start: false,
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
            mcp_connections: Default::default(),
            mcp_write_requests: Default::default(),
            meeting_ai_prompt: None,
            new_note_location: None,
            new_note_location_folder: None,
            paired_extensions: Vec::new(),
            periodic_notes: Default::default(),
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
            opaque_saved_views: Vec::new(),
            view_approvals: Default::default(),
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

    // active_workspace (canonically FIRST — 'ac' < 'au' = auto_lock_seconds, MYND-308). A free enum
    // string; omitted entirely when None. NFC-normalized like the daily_* / custom_theme string
    // fields.
    if let Some(ref slot) = prefs.active_workspace {
        out.extend_from_slice(b"\"active_workspace\":");
        push_json_string(&mut out, &slot.nfc().collect::<String>());
        out.push(b',');
    }

    // ai_enabled (canonical key 'ai_enabled' — after active_workspace ['ai' > 'ac'], before
    // ai_excluded_folders ['ai_en' < 'ai_ex'] and archive_disabled ['ai' < 'ar']). AI opt-in toggle
    // (local-ai epic, SYNC-12). Emitted ONLY when true; omitted entirely when false (the default).
    // Per-vault + encrypted — no at-rest "uses AI" fingerprint.
    if prefs.ai_enabled {
        out.extend_from_slice(b"\"ai_enabled\":true,");
    }

    // ai_excluded_folders (canonical key 'ai_ex…' — after ai_enabled ['ai_en' < 'ai_ex'], before
    // archive_disabled ['ai' < 'ar']). Folders the AI never reads/indexes (local-ai epic, SYNC-14).
    // SAME canonical encoding as deliberate_folders (NFC-normalized, sorted, exact-deduped set),
    // OMITTED entirely when empty.
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

    // ai_provider / ai_provider_consent / ai_provider_key (canonical keys 'ai_provider…' — after
    // ai_excluded_folders ['ai_ex' < 'ai_pr'], before archive_disabled ['ai' < 'ar']; among
    // themselves, the bare key sorts before its own extensions and 'c' < 'k'). The remote-provider
    // triple (ai-remote-providers, SYNC-15/SYNC-22). Each omitted entirely when unset/false — and,
    // more to the point, the DEFAULT STATE leaves no trace in the blob at all.
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

    // archive_disabled (canonical key 'a', AFTER active_workspace ['ar' > 'ac'] and BEFORE
    // auto_lock_seconds ['ar' < 'au']). A bool; omitted entirely when None.
    if let Some(on) = prefs.archive_disabled {
        out.extend_from_slice(b"\"archive_disabled\":");
        out.extend_from_slice(if on { b"true" } else { b"false" });
        out.push(b',');
    }

    // archived_folders (canonical key 'archived_folders' — after archive_disabled ['archive_'
    // '_'=0x5F < 'archived' 'd'=0x64], before auto_lock_seconds ['ar' < 'au']). Folders archived as
    // a unit (folder-archive). SAME canonical encoding as deliberate_folders / ai_excluded_folders
    // (NFC-normalized, sorted, exact-deduped set), OMITTED entirely when empty.
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

    // attachment_compression_enabled (canonical key 'attachment_compression_enabled' — after
    // archived_folders ['archived_' < 'attachment_c'], before attachment_ocr_enabled
    // ['attachment_c' < 'attachment_o']). Ingest-time image compression opt-out
    // (ingest-image-compression). Emitted ONLY when FALSE — same inverse-of-`ai_enabled` rule as
    // attachment_ocr_enabled, because this one also defaults to TRUE. A vault that never touched
    // the toggle is therefore byte-identical to a pre-feature vault.prefs, which preserves the
    // existing KAT vectors.
    if !prefs.attachment_compression_enabled {
        out.extend_from_slice(b"\"attachment_compression_enabled\":false,");
    }

    // attachment_ocr_enabled (canonical key 'attachment_ocr_enabled' — after
    // attachment_compression_enabled ['attachment_c' < 'attachment_o'], before auto_lock_seconds
    // ['att' < 'aut']). Image-OCR opt-out (MYND-441). Emitted ONLY when FALSE — the inverse of the
    // `ai_enabled` rule, because this one defaults to TRUE. A vault that never touched the toggle
    // is therefore byte-identical to a pre-feature vault.prefs, which preserves the existing KAT
    // vectors.
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

    // auto_tag_enabled (canonical key 'auto_tag_enabled' — after auto_lock_seconds ['auto_l' <
    // 'auto_t'], before bar_items_order ['a' < 'b']). Automatic on-device tag suggestion
    // (MYND-651). Emitted ONLY when true; omitted entirely when false (the default) — same
    // discipline as ai_enabled.
    if prefs.auto_tag_enabled {
        out.extend_from_slice(b"\"auto_tag_enabled\":true,");
    }

    // bar_items_order (canonical key 'b' — after auto_lock_seconds [au < b], before custom_theme [b
    // < c]). The bottom-bar display sequence (MYND bottom-bar customization); same order-preserving
    // discipline as favorites / item_order / view_order — preserved verbatim, NOT sorted/deduped.
    // Trailing comma (a pre-screen_capture_protection field); omitted entirely when empty.
    if !prefs.bar_items_order.is_empty() {
        out.extend_from_slice(b"\"bar_items_order\":");
        push_ordered_string_array(&mut out, &prefs.bar_items_order);
        out.push(b',');
    }

    // calendar_settings (canonical key 'calendar_settings', after bar_items_order ['ba' < 'ca'],
    // before chat_history_budget ['cal' < 'cha'], myne-md/myne#1037). The calendar's own settings
    // map: the all-day reminder anchor and one colour token per `calendar:` name. The
    // periodic_notes string-map encoder reused verbatim (lexicographic keys, NFC keys + values,
    // omitted entirely when empty), because the codec validates no half of a client-owned key.
    if !prefs.calendar_settings.is_empty() {
        out.extend_from_slice(b"\"calendar_settings\":");
        push_canonical_string_map(&mut out, &prefs.calendar_settings);
        out.push(b',');
    }

    // chat_history_budget (canonical key 'chat_history_budget', after bar_items_order ['b' < 'c'],
    // before cli_enabled ['ch' < 'cl']). How many characters of chat history an agent run may be
    // seeded with (myne-md/myne#617). Deliberately in the CURSOR-scanned region rather than the
    // strip_prefix run: an unknown key inside that run blinds every field behind it in an older
    // client, which is silent rather than an error. See the field's own doc on PrefsView. Omitted
    // entirely when None.
    if let Some(budget) = prefs.chat_history_budget {
        out.extend_from_slice(b"\"chat_history_budget\":");
        push_json_uint(&mut out, budget);
        out.push(b',');
    }

    // cli_enabled (canonical key 'cli_enabled' — after bar_items_order ['b' < 'c'], before
    // cli_excluded_folders ['cli_en' < 'cli_ex'] and custom_theme ['cli' < 'cu']). CLI
    // terminal-access door toggle (myne-cli epic, MYND-490). Emitted ONLY when true; omitted
    // entirely when false (the default) — same discipline as ai_enabled.
    if prefs.cli_enabled {
        out.extend_from_slice(b"\"cli_enabled\":true,");
    }

    // cli_excluded_folders (canonical key 'cli_excluded_folders' — after cli_enabled ['cli_en' <
    // 'cli_ex'], before cli_rate_limit_disabled ['cli_ex' < 'cli_r'] and custom_theme ['cli' <
    // 'cu']). Folders the CLI never reaches (myne-cli epic, MYND-490). SAME canonical encoding as
    // deliberate_folders / ai_excluded_folders (NFC-normalized, sorted, exact-deduped set), OMITTED
    // entirely when empty.
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

    // cli_rate_limit_disabled (canonical key 'cli_rate_limit_disabled' — after cli_excluded_folders
    // ['cli_ex' < 'cli_r'], before custom_theme ['cli' < 'cu']). CLI socket rate-limit opt-out
    // (myne-cli epic, MYND-490); shape decision recorded on the field's rustdoc — Option<bool>, the
    // archive_disabled precedent class. A bool; omitted entirely when None.
    if let Some(on) = prefs.cli_rate_limit_disabled {
        out.extend_from_slice(b"\"cli_rate_limit_disabled\":");
        out.extend_from_slice(if on { b"true" } else { b"false" });
        out.push(b',');
    }

    // custom_theme (canonical key 'c' — after auto_lock_seconds 'a', before the daily_* block 'd';
    // the only 'c' key). The active custom-theme name; takes color_groups (canonical key 'col' —
    // after bar_items_order [b < c], before custom_theme [col < cus], MYND-604
    // graph-connection-ux-polish). The ordered color-group rule list; order IS rule precedence.
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

    // date_format (myne#279) — canonical key 'dat…', after daily_template (`dai` < `dat`) and
    // before deliberate_folders (`da` < `de`). A free enum string; the client validates + maps
    // unknown→default. Omitted when None.
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

    // developer_mode (canonical key 'd' — after deliberate_folders [`deliberate_` < `developer_`],
    // before device_names [`develope` < `device_n`]). Emitted only when `true` (the `ai_enabled`
    // positive-opt-in convention).
    if prefs.developer_mode {
        out.extend_from_slice(b"\"developer_mode\":true,");
    }

    // device_names (canonical key 'd' — after deliberate_folders [`del` < `dev`], before the
    // editor_* block [`d` < `e`]). A device_id-hex → friendly-name string→string object (SYNC-41,
    // the single home for device names); omitted entirely when empty (existing KAT vectors
    // unaffected — migration-less additive field on MYP1, the folder_icons / item_colors precedent
    // class). Keys emitted in lexicographic order, NFC-normalized (push_canonical_string_map).
    if !prefs.device_names.is_empty() {
        out.extend_from_slice(b"\"device_names\":");
        push_canonical_string_map(&mut out, &prefs.device_names);
        out.push(b',');
    }

    // editor-typography string presets (canonical key 'e'). content_width + default_view_mode +
    // font_family sort BEFORE editor_layout (`editor_c`/`editor_d`/`editor_f` < `editor_l`), the
    // focus bools + the other typography presets AFTER it (below). Each omitted when None. Free
    // enum strings — the client validates + maps unknown→default.
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
    // editor_focus_* bools (MYND-348) — after editor_default_view_mode (`editor_d` < `editor_f`),
    // before editor_font_family (`editor_focus` < `editor_font`: 'c' < 'n'). dim_inactive <
    // typewriter (`editor_focus_d` < `editor_focus_t`). Bare bools; omitted when None.
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

    // editor_line_numbers (canonical key 'e', AFTER editor_layout [`editor_li` > `editor_la`] and
    // BEFORE editor_line_spacing [`editor_line_n` < `editor_line_s`]). A bool; omitted entirely
    // when None.
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
    // editor_slash_hidden (set — sorted+deduped, canonical_folder_list) then editor_slash_order
    // (sequence — verbatim). MYND-336. Both omitted when empty. Canonical: after
    // editor_line_spacing, before editor_text_size (editor_li < editor_s < editor_te).
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

    // editor_vim_mode (canonical key 'e', AFTER editor_toolbar_order [`editor_to` < `editor_v`] and
    // BEFORE favorites [`e` < `f`]). A bool; omitted entirely when None. vim-keyboard-mode,
    // MYND-313.
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

    // folder_notes_enabled (canonical key 'folder_n', after 'folder_icons' ['folder_i' <
    // 'folder_n'], before 'hidden_bar_items' ['f' < 'h']). The folder-notes feature off-switch
    // (myne-md/myne#661). Emitted ONLY when true; omitted entirely when false (the default), the
    // same discipline as auto_tag_enabled.
    if prefs.folder_notes_enabled {
        out.extend_from_slice(b"\"folder_notes_enabled\":true,");
    }

    // hidden_bar_items (canonical key 'h' — after 'folder_icons' [f < h], before 'item_colors' [h <
    // i]). A set-semantics array: NFC-normalized, sorted, exact-deduped (canonical_folder_list,
    // shared with deliberate_folders / spell_languages); omitted entirely when empty.
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

    // home_cards + home_open_on_start (canonical keys 'hom' — after
    // 'hidden_bar_items' ['hid' < 'hom'], before 'icon' ['hom' < 'ico'],
    // myne-md/myne#1074). `home_cards` is an `Option` so `Some([])` (a home the
    // user emptied) is EMITTED as `[]` while `None` (never arranged) is omitted,
    // which is what lets the client seed its default layout only when the key is
    // absent. The card shape and its byte contract live in `crate::home_layout`.
    if let Some(ref cards) = prefs.home_cards {
        out.extend_from_slice(b"\"home_cards\":");
        crate::home_layout::push_home_cards(&mut out, cards);
        out.push(b',');
    }
    // `home_open_on_start` is omit-when-default, so only `true` is written and an
    // untouched vault stays byte-identical.
    if prefs.home_open_on_start {
        out.extend_from_slice(b"\"home_open_on_start\":true,");
    }

    // icon (canonical key 'icon' — after 'hidden_bar_items' [h < i], before 'item_colors' ['ico' <
    // 'ite']). The per-vault switcher glyph name (vault-icons); omitted entirely when None
    // (existing KAT vectors unaffected). NFC-normalized like label.
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

    // mcp_connections (canonical key 'mcp' — after last_backup_at [las < mcp],
    // before meeting_ai_prompt [mc < me], external-mcp-connection myne#923).
    // The external MCP connection grants: the folders a connection may NOT read,
    // plus approval and last-use stamps, per declared connection name. Omitted
    // ENTIRELY when the map is empty, so a vault that never granted a connection
    // is byte-identical to a pre-feature vault.prefs. Names and folder paths are
    // NFC-normalized; the map is a BTreeMap so names sort, and each grant object
    // emits its own keys in canonical order (approved_at < excluded_folders <
    // folders < last_used_at < model). `folders` and `excluded_folders` never
    // both appear: the two arrays describe opposite rules, and a grant carrying
    // both is refused by the parser rather than resolved by a precedence rule.
    if !prefs.mcp_connections.is_empty() {
        out.extend_from_slice(b"\"mcp_connections\":");
        push_mcp_connections_map(&mut out, &prefs.mcp_connections);
        out.push(b',');
    }

    // mcp_write_requests (canonical key `mcp_write_requests`, after
    // `mcp_connections` [`mcp_` < `mcpd`], before `meeting_ai_prompt` [`mc` <
    // `me`], external-mcp-connection task 13). The writes waiting for a person,
    // omitted ENTIRELY when empty so a vault that has never had one is
    // byte-identical to a pre-feature vault.prefs.
    //
    // One request per (connection, folder, verb), newest first, so a client in a
    // retry loop cannot fill the queue with its own duplicates. Everything about
    // the ORDER lives in `push_mcp_write_requests` and nowhere else: a second
    // sorting rule is a second byte layout for the same field.
    if !prefs.mcp_write_requests.is_empty() {
        out.extend_from_slice(b"\"mcp_write_requests\":");
        push_mcp_write_requests(&mut out, &prefs.mcp_write_requests);
        out.push(b',');
    }

    // new_note_location (canonical key 'n' — after last_backup_at [l < n], before
    // new_note_location_folder [prefix] and paired_extensions [n < p], MYND-462). The new-note
    // default-location MODE (root/current/specific); omitted entirely when None. Trailing comma
    // like last_backup_at (screen_capture_protection is mandatory and canonically later).
    // meeting_ai_prompt (canonical key 'm', after last_backup_at [l < m], before new_note_location
    // [m < n], meeting-ai). The user's replacement for the meeting AI reduce instruction; omitted
    // entirely when None.
    if let Some(ref v) = prefs.meeting_ai_prompt {
        out.extend_from_slice(b"\"meeting_ai_prompt\":");
        push_json_string(&mut out, &v.nfc().collect::<String>());
        out.push(b',');
    }

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

    // periodic_notes (canonical key 'per': after paired_extensions [pai < per],
    // before reminder_horizon_days [p < r], myne#177). A canonical string→string
    // map keyed `<period>.<setting>`, the folder_icons / item_colors encoding
    // reused verbatim; omitted entirely when empty so a vault that configured no
    // period is byte-identical to a pre-myne#177 vault.prefs (existing golden
    // vectors unaffected).
    if !prefs.periodic_notes.is_empty() {
        out.extend_from_slice(b"\"periodic_notes\":");
        push_canonical_string_map(&mut out, &prefs.periodic_notes);
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

    // ribbon_items (canonical key 'ribbon_items': after reminders_enabled
    // ['re' < 'ri'], before ribbon_visible, myne-md/myne#699). `Option` so
    // `Some([])` (a deliberately emptied rail) is EMITTED as `[]` while `None`
    // (never configured) is omitted, which is what lets the client seed its
    // curated default only when the key is absent.
    if let Some(ref items) = prefs.ribbon_items {
        out.extend_from_slice(b"\"ribbon_items\":");
        push_ordered_string_array(&mut out, items);
        out.push(b',');
    }

    // ribbon_visible (canonical key 'ribbon_visible': after ribbon_items
    // ['ribbon_i' < 'ribbon_v'], before right_panel_active_tab ['rib' < 'rig'],
    // myne-md/myne#699). Default `true`, so only a `false` is written; an
    // untouched vault stays byte-identical.
    if !prefs.ribbon_visible {
        out.extend_from_slice(b"\"ribbon_visible\":false,");
    }

    // right_panel_active_tab (canonical key 'right_panel_a…' — after paired_extensions ['p' < 'r'],
    // before right_panel_hidden_tabs). A free enum string; omitted entirely when None.
    // NFC-normalized like active_workspace.
    if let Some(ref tab) = prefs.right_panel_active_tab {
        out.extend_from_slice(b"\"right_panel_active_tab\":");
        push_json_string(&mut out, &tab.nfc().collect::<String>());
        out.push(b',');
    }

    // right_panel_hidden_tabs (canonical key 'right_panel_h…' — after right_panel_active_tab,
    // before right_panel_tab_order ['h' < 't']). A set-semantics array: NFC-normalized, sorted,
    // exact-deduped (canonical_folder_list, shared with hidden_bar_items); omitted entirely when
    // empty.
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

    // right_panel_tab_order (canonical key 'right_panel_t…' — after right_panel_hidden_tabs, before
    // saved_views ['r' < 'sav']). The right-panel tab display sequence; same order-preserving
    // discipline as bar_items_order — preserved verbatim, NOT sorted/deduped. Omitted entirely when
    // empty.
    if !prefs.right_panel_tab_order.is_empty() {
        out.extend_from_slice(b"\"right_panel_tab_order\":");
        push_ordered_string_array(&mut out, &prefs.right_panel_tab_order);
        out.push(b',');
    }

    // saved_views (canonical key 'sav' — after last_backup_at, before
    // screen_capture_protection ['sav' < 'scr']). A nested array of canonical
    // SavedView objects, sorted by id (MYND-273); omitted entirely when empty so
    // a vault with no views is byte-identical to a pre-MYND-273 vault.prefs.
    // Written through the opaque-aware encoder and gated on BOTH vecs: a blob
    // whose only views are ones this build cannot represent must still be
    // re-emitted, or this client's next write would delete them.
    if !prefs.saved_views.is_empty() || !prefs.opaque_saved_views.is_empty() {
        out.extend_from_slice(b"\"saved_views\":");
        out.extend_from_slice(
            &crate::saved_view::canonical_encode_saved_views_with_opaque(
                &prefs.saved_views,
                &prefs.opaque_saved_views,
            ),
        );
        out.push(b',');
    }

    out.extend_from_slice(b"\"screen_capture_protection\":");
    out.extend_from_slice(if prefs.screen_capture_protection {
        b"true"
    } else {
        b"false"
    });

    // show_note_timestamps (canonical key 'sho…' — after screen_capture_protection [scr < sho],
    // before spell_enabled [sho < spe]). OMIT-WHEN-DEFAULT, inverted polarity vs spell_enabled: the
    // default is `true`, so ONLY the non-default `false` is emitted (prepending a comma like
    // spell_enabled). A vault that never touched the toggle stays byte-identical to a pre-feature
    // vault.prefs.
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

    // startup_open (canonical key 'sta…' — after spell_languages [spl < sta], before
    // startup_open_note [prefix] and theme [sta < the], MYND-462). The startup-open MODE
    // (last/empty/specific); leading comma like theme. Omitted entirely when None.
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

    // time_format + timezone (myne#279) — canonical keys 'ti…', between theme ['th' < 'ti'] and
    // transcription_enabled ['ti' < 'tr']. Leading comma like theme, since this region is emitted
    // after the last comma-terminated block. Free enum / IANA strings; the client validates + maps
    // unknown→default. Each omitted when None.
    if let Some(ref v) = prefs.time_format {
        out.extend_from_slice(b",\"time_format\":");
        push_json_string(&mut out, &v.nfc().collect::<String>());
    }
    if let Some(ref v) = prefs.timezone {
        out.extend_from_slice(b",\"timezone\":");
        push_json_string(&mut out, &v.nfc().collect::<String>());
    }

    // transcription_enabled (canonical key 'transcription_enabled' — after theme ['the' < 'tra'],
    // before view_order ['t' < 'v']). Speech-to-text opt-OUT (MYND-592). Emitted ONLY when FALSE —
    // the same inverse rule as attachment_ocr_enabled, because this one defaults to TRUE. A vault
    // that never touched the toggle is therefore byte-identical to a pre-feature vault.prefs, which
    // preserves the existing KAT vectors.
    if !prefs.transcription_enabled {
        out.extend_from_slice(b",\"transcription_enabled\":false");
    }

    // view_approvals (canonical key 'view_a…', after transcription_enabled
    // ['t' < 'v'], BEFORE view_order ['view_a' < 'view_o']). The device-local
    // approval map (view-manifests): `{view_id: approved_version}`. Same
    // canonical integer-map framing as field_clocks (NFC keys, lexicographic
    // order); omitted entirely when empty so a vault that never approves
    // anything is byte-identical to a pre-feature blob.
    if !prefs.view_approvals.is_empty() {
        out.extend_from_slice(b",\"view_approvals\":");
        push_canonical_u64_map(&mut out, &prefs.view_approvals);
    }

    // view_order (canonical key 'v', after view_approvals ['view_a' < 'view_o']).
    // The saved-view display sequence (MYND-273); same order-preserving discipline
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

/// Canonical form of a verb set: sorted and exact-deduplicated.
///
/// NFC is applied for the same reason [`canonical_folder_list`] applies it, even
/// though every verb this build writes is lowercase ASCII: the canonical bytes
/// must be a function of the LOGICAL value, so a hand-edited or future-translated
/// entry normalises before it sorts rather than producing a second spelling of one
/// set. Sorting is what makes two spellings of the same set one set of bytes.
fn canonical_verb_list(verbs: &[String]) -> Vec<String> {
    let mut v: Vec<String> = verbs.iter().map(|s| s.nfc().collect::<String>()).collect();
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

/// The suffix marking an `ai_provider_consent` recorded **on the reading
/// device, under the device-local classification**, rather than inherited.
///
/// **Why the value carries its own classification** (myne-md/myne#456, found by
/// review). Two populations hold a consent that no longer means what the gate
/// reads it to mean, and neither can be told apart from a fresh one by the
/// value alone:
///
/// * A desktop install that named a provider, consented, stored a key and then
///   turned Developer mode OFF. Under the previous build `developer_mode` was a
///   request-time precondition AND the backend selection consulted it, so that
///   configuration was answered by the in-process local arm and nothing left
///   the device. With the precondition gone the identical preferences authorize
///   the REMOTE arm, so note plaintext begins crossing TB13 on upgrade with no
///   user act and no notice.
/// * A device enrolled BEFORE the reclassification, which inherited the value
///   under the old SHARED class. The prefs merge keeps the local value always,
///   so no merge will ever revise it, while `threat-model.md` TB13,
///   `sync-protocol.md` 10.2 and `CONSENT_DEVICE_SCOPE` in `@myne/copy` all now
///   state device scope without qualification.
///
/// **One token rather than a migration.** A one-time clear needs somewhere to
/// record that it ran, which is a new field or a new device-local blob; making
/// the value carry its classification makes the field its own marker. A legacy
/// value fails the gate, the surface shows the consent screen, the user agrees,
/// and the scoped value is written. Fail-closed for both populations,
/// self-extinguishing, and no new format family.
///
/// `@` cannot appear in a provider wire name (`openrouter`, `ollama-cloud`), so
/// the split is unambiguous and a legacy value is RECOGNISABLE rather than
/// merely unequal, which is what lets a surface say "you agreed once, under a
/// build with a second gate" instead of "you never agreed".
pub const CONSENT_DEVICE_SUFFIX: &str = "@device";

/// The stored value for a consent recorded on this device for `provider_wire`.
///
/// Every writer goes through this rather than formatting the string, so a
/// second spelling cannot appear: the gate compares for equality and a mismatch
/// is a silent refusal rather than an error anybody sees.
pub fn device_scoped_consent(provider_wire: &str) -> alloc::string::String {
    let mut out =
        alloc::string::String::with_capacity(provider_wire.len() + CONSENT_DEVICE_SUFFIX.len());
    out.push_str(provider_wire);
    out.push_str(CONSENT_DEVICE_SUFFIX);
    out
}

/// Whether `stored` is a consent recorded on THIS device for `provider_wire`.
///
/// A legacy bare-wire-name value is deliberately not accepted; that is the fix
/// rather than an oversight, and [`CONSENT_DEVICE_SUFFIX`] carries the reason.
pub fn consent_is_device_scoped(stored: Option<&str>, provider_wire: &str) -> bool {
    match stored {
        Some(v) => match v.strip_suffix(CONSENT_DEVICE_SUFFIX) {
            Some(name) => name == provider_wire,
            None => false,
        },
        None => false,
    }
}

/// Whether `stored` is a LEGACY consent for `provider_wire`: the bare wire
/// name, recorded before the reclassification.
///
/// Separated from "no consent at all" so a surface can say the true thing. The
/// user did agree once, to this same provider, under a build where a second
/// host-side precondition also had to hold.
pub fn consent_is_legacy(stored: Option<&str>, provider_wire: &str) -> bool {
    stored == Some(provider_wire)
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
/// Emit the `mcp_connections` map (name → grant object) in canonical form.
///
/// Names are NFC-normalized and emitted in `BTreeMap` (lexicographic) order;
/// each grant object's own keys are emitted in canonical order (`approved_at` <
/// `excluded_folders` < `folders` < `last_used_at` < `model`), each folder array
/// goes through the canonical set encoding (NFC, sorted, exact-deduped), and
/// both `last_used_at` and the model token are omitted when they are the
/// default. A second opinion about any of those rules is a second byte layout
/// for the same field.
///
/// **Only the array the model owns is written.** A `Folders` grant emits
/// `folders` (and no `excluded_folders`), an `Exclude` grant emits
/// `excluded_folders` (and no `folders`), and a grant whose model and arrays
/// disagree therefore cannot produce bytes the decoder would then refuse: the
/// model decides, so re-encoding is always a fixed point.
/// The canonical bytes of ONE grant object, without the map around it.
///
/// The unit the vector family pins, and the reason it is exported rather than a
/// test helper: an independent implementation needs a named encoder to compare
/// against, and it is the same bytes [`push_mcp_connections_map`] writes inside
/// the map (this function slices them out of the real encoder instead of
/// restating the layout, so the two cannot disagree).
pub fn canonical_encode_mcp_connection_grant(grant: &McpConnectionGrant) -> Vec<u8> {
    let mut map: BTreeMap<String, McpConnectionGrant> = BTreeMap::new();
    map.insert(String::from("a"), grant.clone());
    let mut out = Vec::new();
    push_mcp_connections_map(&mut out, &map);
    // `{"a":{…}}` → the inner object, braces included: start after the member
    // boundary `:{`, drop the map's own closing brace.
    let boundary = out
        .windows(2)
        .position(|pair| pair == b":{")
        .expect("the map encoder always writes a member boundary");
    out[boundary + 1..out.len() - 1].to_vec()
}

fn push_mcp_connections_map(
    out: &mut Vec<u8>,
    map: &BTreeMap<alloc::string::String, McpConnectionGrant>,
) {
    out.push(b'{');
    for (index, (name, grant)) in map.iter().enumerate() {
        if index > 0 {
            out.push(b',');
        }
        push_json_string(out, &name.nfc().collect::<String>());
        out.push(b':');
        out.push(b'{');
        out.extend_from_slice(b"\"approved_at\":");
        push_json_uint64(out, grant.approved_at);
        // Sorts before `excluded_folders` (`app` < `dis` < `exc`) and omitted
        // when empty, which keeps a grant written before the verb switches
        // existed round-tripping byte for byte.
        if !grant.disabled_verbs.is_empty() {
            out.push(b',');
            out.extend_from_slice(b"\"disabled_verbs\":");
            push_ordered_string_array(out, &canonical_verb_list(&grant.disabled_verbs));
        }
        if matches!(grant.model, McpScopeModel::Exclude) {
            if !grant.excluded_folders.is_empty() {
                out.push(b',');
                out.extend_from_slice(b"\"excluded_folders\":");
                push_ordered_string_array(out, &canonical_folder_list(&grant.excluded_folders));
            }
        } else {
            // Always emitted, even empty: under the legacy model an absent list
            // and an empty one are different statements ("nothing was captured"
            // against "nothing is readable"), and the released parser refused
            // the absent shape for exactly that reason.
            out.push(b',');
            out.extend_from_slice(b"\"folders\":");
            push_ordered_string_array(out, &canonical_folder_list(&grant.folders));
        }
        if let Some(last_used_at) = grant.last_used_at {
            out.push(b',');
            out.extend_from_slice(b"\"last_used_at\":");
            push_json_uint64(out, last_used_at);
        }
        if let Some(token) = grant.model.canonical_token() {
            out.push(b',');
            out.extend_from_slice(b"\"model\":");
            push_json_string(out, token);
        }
        // Last in key order (`model` < `write_folders`) and omitted when empty,
        // which is what makes a grant written before the write scope existed
        // round-trip byte for byte. Absent and empty are the same reading here
        // (may write nowhere), unlike the legacy `folders` member where they were
        // different statements.
        if !grant.write_folders.is_empty() {
            out.push(b',');
            out.extend_from_slice(b"\"write_folders\":");
            push_ordered_string_array(out, &canonical_folder_list(&grant.write_folders));
        }
        out.push(b'}');
    }
    out.push(b'}');
}

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
    // Canonical key order active_workspace < ai_enabled < ai_excluded_folders
    // < archive_disabled, so when present this bool is a literal PREFIX of the
    // post-active_workspace bytes (strip_prefix, not
    // find_subslice — a later folder name containing an `"ai_enabled":`-looking
    // substring cannot fool it). Emitted only as `true` by the encoder; `false`
    // is tolerated for robustness. Absent → false (the default). MUST be
    // followed by `,`.
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
    // calendar_settings (key 'cal': after bar_items_order ['ba' < 'ca'], before
    // chat_history_budget ['cal' < 'cha'], myne-md/myne#1037). The folder_icons
    // string-map parse reused verbatim, located from the same monotonic cursor as
    // its neighbours. Absent -> empty, and an entry naming a setting this build
    // does not know decodes and is ignored by the client rather than failing the
    // blob.
    let calendar_settings =
        parse_optional_string_map_field(rest, &mut cursor, b"\"calendar_settings\":")?;
    // chat_history_budget (canonical key 'chat_history_budget', after
    // bar_items_order ['b' < 'c'], before cli_enabled ['ch' < 'cl']). How many
    // characters of chat history an agent run may be seeded with
    // (myne-md/myne#617). Located from the same monotonic cursor as its
    // neighbours, which is what makes it tolerable to a client that has never
    // heard of it: `find_top_level_marker` scans FORWARD, so an unknown key
    // between two known ones is stepped over rather than left blocking the next
    // marker. Absent → None (the default).
    let chat_history_budget =
        parse_optional_uint_field(rest, &mut cursor, b"\"chat_history_budget\":")?;
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
    // folder_notes_enabled (key 'folder_n') sits between folder_icons (folder_i)
    // and hidden_bar_items (h) in canonical order (myne-md/myne#661): the
    // folder-notes feature off-switch. Absent decodes to false (feature off by
    // default); parsed from the same monotonic cursor as its neighbours.
    let folder_notes_enabled =
        parse_optional_bool_field(rest, &mut cursor, b"\"folder_notes_enabled\":")?
            .unwrap_or(false);
    // hidden_bar_items (key 'h') sits between folder_icons (f) and item_colors (i)
    // in canonical order. A set-semantics array parsed from the same monotonic
    // cursor so a later field's key marker is never matched inside its content
    // (`h` < `s`, so the cursor-based helper — not the post-SCP `_marker`
    // variant — is correct here).
    let hidden_bar_items = parse_optional_array_field(rest, &mut cursor, b"\"hidden_bar_items\":")?;
    // home_cards + home_open_on_start (keys 'hom' — after hidden_bar_items
    // ['hid' < 'hom'], before icon ['hom' < 'ico'], myne-md/myne#1074).
    // `home_cards` uses the Option-returning parse so ABSENT (never arranged)
    // stays distinguishable from PRESENT-but-EMPTY (deliberately emptied);
    // `home_open_on_start` is omit-when-default, absent → `false`.
    let home_cards = parse_optional_home_cards_field(rest, &mut cursor, b"\"home_cards\":")?;
    let home_open_on_start =
        parse_optional_bool_field(rest, &mut cursor, b"\"home_open_on_start\":")?.unwrap_or(false);
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
    // mcp_connections (key 'mcp' — after last_backup_at [las < mcp], before
    // meeting_ai_prompt [mc < me], external-mcp-connection myne#923). A nested
    // object map (name → grant object), which is why it has its own parser
    // rather than reusing the string-map one. Absent → empty, which is "no
    // connection granted"; present-but-malformed → PlaintextParseFailed.
    let mcp_connections =
        parse_optional_mcp_connections_field(rest, &mut cursor, b"\"mcp_connections\":")?;
    // mcp_write_requests (key `mcp_write_requests`, after mcp_connections,
    // before meeting_ai_prompt, external-mcp-connection task 13). An array of
    // request objects, which is why it has its own parser. Absent → empty, which
    // is "nothing waiting"; present-but-malformed → PlaintextParseFailed.
    let mcp_write_requests =
        parse_optional_mcp_write_requests_field(rest, &mut cursor, b"\"mcp_write_requests\":")?;
    // meeting_ai_prompt (key 'm', after last_backup_at [l < m], before
    // new_note_location [m < n], meeting-ai). Parsed from the same monotonic
    // cursor so a later field's key marker is never matched inside the prompt
    // text.
    let meeting_ai_prompt =
        parse_optional_string_field(rest, &mut cursor, b"\"meeting_ai_prompt\":")?;
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
    // periodic_notes (key 'per': after paired_extensions [pai < per], before
    // reminder_horizon_days [p < r], myne#177). The folder_icons string-map
    // parse reused verbatim; absent → empty, and an entry naming a period this
    // build does not know decodes and is ignored by the client rather than
    // failing the blob.
    let periodic_notes =
        parse_optional_string_map_field(rest, &mut cursor, b"\"periodic_notes\":")?;
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
    // ribbon_items + ribbon_visible (keys 'ribbon': after reminders_enabled
    // ['re' < 'ri'], before right_panel_* ['rib' < 'rig'], myne-md/myne#699).
    // `ribbon_items` uses the Option-returning array parse so ABSENT (never
    // configured) stays distinguishable from PRESENT-but-EMPTY (deliberately
    // emptied); `ribbon_visible` is omit-when-default, absent → `true`.
    let ribbon_items = parse_optional_array_field_opt(rest, &mut cursor, b"\"ribbon_items\":")?;
    let ribbon_visible =
        parse_optional_bool_field(rest, &mut cursor, b"\"ribbon_visible\":")?.unwrap_or(true);
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
    let (saved_views, opaque_saved_views) =
        parse_optional_saved_views_field(rest, &mut cursor, b"\"saved_views\":")?;

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
    // view_approvals (key 'view_a…', between transcription_enabled [t] and
    // view_order, view-manifests). A device-local integer map located by marker in
    // the post-screen_capture_protection region, like view_order.
    //
    // TOLERANT on a malformed value (`.unwrap_or_default()`), which is the
    // deliberate choice rather than a shortcut: this map is the gate a view has to
    // pass before it may open, so the two failure directions are not symmetric.
    // Reading damage as "no approvals" makes every pending view stay PENDING,
    // which is the fail-closed direction and heals by approving again, while
    // every other preference in the blob survives. Refusing the parse instead
    // would drive §9.5.5's whole-blob fall-back to defaults, which clears the
    // approvals AND the theme, keymap and favorites, and then a write pushes that
    // loss to every device: the same class task 1 removed for `saved_views`.
    let view_approvals = {
        let mut approvals_cursor = 0usize;
        parse_optional_u64_map_field(after_key, &mut approvals_cursor, b"\"view_approvals\":")
            .unwrap_or_default()
    };
    // view_order (key 'v', after view_approvals and after theme [t < v], MYND-273). A
    // sequence array located by marker in the post-screen_capture_protection
    // region, like theme/spell. Absent → empty; present-but-malformed →
    // PlaintextParseFailed.
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
        folder_notes_enabled,
        hidden_bar_items,
        home_cards,
        home_open_on_start,
        bar_items_order,
        calendar_settings,
        chat_history_budget,
        cli_enabled,
        cli_excluded_folders,
        cli_rate_limit_disabled,
        mcp_connections,
        mcp_write_requests,
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
        meeting_ai_prompt,
        new_note_location,
        new_note_location_folder,
        startup_open,
        startup_open_note,
        paired_extensions,
        periodic_notes,
        reminder_horizon_days,
        reminders_enabled,
        ribbon_items,
        ribbon_visible,
        right_panel_active_tab,
        right_panel_hidden_tabs,
        right_panel_tab_order,
        spell_enabled,
        spell_languages,
        saved_views,
        opaque_saved_views,
        view_approvals,
        view_order,
    })
}

/// Parse the OPTIONAL `saved_views` nested-array-of-objects field (MYND-273),
/// searching `rest` from `*cursor` onward. On a hit, decodes the canonical
/// `SavedView` array via [`crate::saved_view::parse_saved_views_array_with_opaque`]
/// and advances `*cursor` past the closing `]`; on a miss returns two empty
/// `Vec`s and leaves `*cursor` unchanged.
///
/// The second vec is the entries this build cannot represent, which are carried
/// rather than treated as a parse failure: a newer client's `view_type` used to
/// collapse the WHOLE blob to defaults (§9.5.5) and then be overwritten by this
/// client's next write. Structural damage is still fatal and still collapses to
/// [`PrefsBlobError::PlaintextParseFailed`] (a non-array value, a malformed
/// `SavedView`, damaged JSON). The monotonic cursor keeps the canonical
/// key-order discipline: the following `screen_capture_protection` find never
/// matches inside a view's content.
fn parse_optional_saved_views_field(
    rest: &[u8],
    cursor: &mut usize,
    marker: &[u8],
) -> Result<
    (
        Vec<crate::saved_view::SavedView>,
        Vec<crate::saved_view::OpaqueSavedView>,
    ),
    PrefsBlobError,
> {
    match find_top_level_marker(rest, *cursor, marker) {
        Some(rel_idx) => {
            let val_start = *cursor + rel_idx + marker.len();
            let (views, opaque, consumed) =
                crate::saved_view::parse_saved_views_array_with_opaque(&rest[val_start..])
                    .map_err(|_| PrefsBlobError::PlaintextParseFailed)?;
            *cursor = val_start + consumed;
            Ok((views, opaque))
        }
        None => Ok((Vec::new(), Vec::new())),
    }
}

/// Parse the OPTIONAL `home_cards` nested-array-of-objects field
/// (myne-md/myne#1074), searching `rest` from `*cursor` onward. On a hit,
/// decodes the canonical [`crate::home_layout::HomeCard`] array and advances
/// `*cursor` past the closing `]`; on a miss returns `None` and leaves `*cursor`
/// unchanged, which is what keeps "never arranged" distinguishable from
/// "deliberately emptied".
///
/// A malformed array collapses to `PlaintextParseFailed` for the same reason
/// every other member does: a blob whose bytes do not parse is not a blob whose
/// OTHER preferences should be trusted.
fn parse_optional_home_cards_field(
    rest: &[u8],
    cursor: &mut usize,
    marker: &[u8],
) -> Result<Option<Vec<crate::home_layout::HomeCard>>, PrefsBlobError> {
    match find_top_level_marker(rest, *cursor, marker) {
        Some(rel_idx) => {
            let val_start = *cursor + rel_idx + marker.len();
            let (cards, consumed) = crate::home_layout::parse_home_cards_array(&rest[val_start..])
                .map_err(|_| PrefsBlobError::PlaintextParseFailed)?;
            *cursor = val_start + consumed;
            Ok(Some(cards))
        }
        None => Ok(None),
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

/// Parse an OPTIONAL canonical JSON unsigned-integer field whose key marker is
/// `marker`, searching `rest` from `*cursor` onward. The `u32` sibling of
/// [`parse_optional_bool_field`], with the same monotonic-cursor canonical
/// key-order discipline: on a hit it advances `*cursor` past the value's
/// trailing `,` and returns `Some`, on a miss it returns `None` and leaves
/// `*cursor` where it was.
///
/// The trailing `,` is REQUIRED rather than optional, exactly as in the bool
/// sibling: `screen_capture_protection` is mandatory and canonically last, so a
/// further field always follows, and a value that runs to `}` is malformed. A
/// trailing `.` (a float, FORBIDDEN per `docs/spec/protocol.md` §9.5.2)
/// therefore rejects here rather than truncating.
fn parse_optional_uint_field(
    rest: &[u8],
    cursor: &mut usize,
    marker: &[u8],
) -> Result<Option<u32>, PrefsBlobError> {
    match find_top_level_marker(rest, *cursor, marker) {
        Some(rel_idx) => {
            let val_start = *cursor + rel_idx + marker.len();
            let (val, consumed) = parse_json_uint(&rest[val_start..])?;
            let after = &rest[val_start + consumed..];
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

/// Parse an OPTIONAL canonical string-array field that must distinguish ABSENT
/// from PRESENT-but-EMPTY (`ribbon_items`), searching `rest` from `*cursor`
/// onward. On a hit, advances `*cursor` past the closing `]` and returns
/// `Some(list)`; on a miss returns `None` and leaves `*cursor` unchanged.
fn parse_optional_array_field_opt(
    rest: &[u8],
    cursor: &mut usize,
    marker: &[u8],
) -> Result<Option<Vec<String>>, PrefsBlobError> {
    match find_top_level_marker(rest, *cursor, marker) {
        Some(rel_idx) => {
            let array_start = *cursor + rel_idx + marker.len();
            let (list, consumed) = parse_json_string_array(&rest[array_start..])
                .ok_or(PrefsBlobError::PlaintextParseFailed)?;
            *cursor = array_start + consumed;
            Ok(Some(list))
        }
        None => Ok(None),
    }
}

/// Parse an OPTIONAL canonical string-array field whose key marker is
/// `marker`, searching `rest` from `*cursor` onward. On a hit, advances
/// `*cursor` past the closing `]` and returns the decoded list; on a miss
/// returns an empty list and leaves `*cursor` unchanged. Searching from a
/// monotonically-advancing cursor (rather than from 0) keeps the canonical
/// key-order discipline load-bearing: a later field's key marker is only
/// matched after the prior field's array span. Delegates the walk to
/// [`parse_optional_array_field_opt`], collapsing the miss arm.
fn parse_optional_array_field(
    rest: &[u8],
    cursor: &mut usize,
    marker: &[u8],
) -> Result<Vec<String>, PrefsBlobError> {
    Ok(parse_optional_array_field_opt(rest, cursor, marker)?.unwrap_or_default())
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

/// Parse the OPTIONAL `mcp_connections` field from the monotonic cursor
/// (external-mcp-connection, myne-md/myne#923). Absent → empty map ("no
/// connection granted"); present-but-malformed →
/// [`PrefsBlobError::PlaintextParseFailed`], the same contract as every other
/// optional field. Locating the marker from the cursor rather than by
/// `strip_prefix` is what keeps a folder path in an earlier field (a value the
/// user authored) from being read as this field's key.
fn parse_optional_mcp_connections_field(
    rest: &[u8],
    cursor: &mut usize,
    marker: &[u8],
) -> Result<BTreeMap<alloc::string::String, McpConnectionGrant>, PrefsBlobError> {
    match find_top_level_marker(rest, *cursor, marker) {
        Some(rel_idx) => {
            let obj_start = *cursor + rel_idx + marker.len();
            let (map, consumed) = parse_json_mcp_connections(&rest[obj_start..])
                .ok_or(PrefsBlobError::PlaintextParseFailed)?;
            *cursor = obj_start + consumed;
            Ok(map)
        }
        None => Ok(BTreeMap::new()),
    }
}

/// Parse a JSON object of `connection name -> grant object` members starting at
/// `bytes[0] == '{'`. Returns the decoded map + bytes consumed (through the
/// closing `}`), or `None` on any malformation.
///
/// The one nested-object-map shape in this codec, which is why it is its own
/// parser rather than a reuse of [`parse_json_string_map`]: a grant is an object,
/// not a string. Member ORDER is not enforced, because the decoder's job is to
/// read what an encoder wrote and the canonical order is the encoder's; the
/// encoder's shape is pinned by the golden-byte tests instead.
fn parse_json_mcp_connections(
    bytes: &[u8],
) -> Option<(BTreeMap<alloc::string::String, McpConnectionGrant>, usize)> {
    if bytes.first() != Some(&b'{') {
        return None;
    }
    let mut i = 1;
    let mut out: BTreeMap<alloc::string::String, McpConnectionGrant> = BTreeMap::new();
    if bytes.get(i) == Some(&b'}') {
        return Some((out, i + 1));
    }
    loop {
        if bytes.get(i) != Some(&b'"') {
            return None;
        }
        let (name, consumed) = parse_json_string(&bytes[i..])?;
        i += consumed;
        if bytes.get(i) != Some(&b':') {
            return None;
        }
        i += 1;
        let (grant, consumed) = parse_mcp_connection_grant(&bytes[i..])?;
        i += consumed;
        out.insert(name, grant);
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

/// Emit `mcp_write_requests` in canonical form.
///
/// **Order and de-duplication are decided here, once.** A request sorts by
/// `(connection, folder, verb)` and, within that triple, newest `requested_at`
/// first; the first of a triple is kept and the rest are dropped, which is what
/// makes a client in a retry loop cost one row rather than a hundred. Every
/// string is NFC-normalized like the rest of this blob.
///
/// Members are emitted in canonical order (`connection` < `folder` <
/// `requested_at` < `summary` < `verb`), and `summary` is omitted when empty.
fn push_mcp_write_requests(out: &mut Vec<u8>, requests: &[McpWriteRequest]) {
    let mut canonical: Vec<McpWriteRequest> = requests.to_vec();
    for request in &mut canonical {
        request.connection = request.connection.nfc().collect();
        request.folder = request.folder.nfc().collect();
        // A title or a first line: NFC so the same text never encodes twice.
        request.summary = request.summary.nfc().collect();
    }
    canonical.sort_by(|a, b| {
        a.connection
            .cmp(&b.connection)
            .then(a.folder.cmp(&b.folder))
            .then(a.verb.cmp(&b.verb))
            .then(b.requested_at.cmp(&a.requested_at))
    });
    canonical.dedup_by(|later, kept| {
        kept.connection == later.connection
            && kept.folder == later.folder
            && kept.verb == later.verb
    });

    out.push(b'[');
    for (index, request) in canonical.iter().enumerate() {
        if index > 0 {
            out.push(b',');
        }
        out.push(b'{');
        out.extend_from_slice(b"\"connection\":");
        push_json_string(out, &request.connection);
        out.push(b',');
        out.extend_from_slice(b"\"folder\":");
        push_json_string(out, &request.folder);
        if let Some(token) = request.kind.canonical_token() {
            out.push(b',');
            out.extend_from_slice(b"\"kind\":");
            push_json_string(out, token);
        }
        out.push(b',');
        out.extend_from_slice(b"\"requested_at\":");
        push_json_uint64(out, request.requested_at);
        if !request.summary.is_empty() {
            out.push(b',');
            out.extend_from_slice(b"\"summary\":");
            push_json_string(out, &request.summary);
        }
        out.push(b',');
        out.extend_from_slice(b"\"verb\":");
        push_json_string(out, &request.verb);
        out.push(b'}');
    }
    out.push(b']');
}

/// Parse the OPTIONAL `mcp_write_requests` field from the monotonic cursor.
/// Absent → empty ("nothing waiting"); present-but-malformed →
/// [`PrefsBlobError::PlaintextParseFailed`], the same contract as every other
/// optional field.
fn parse_optional_mcp_write_requests_field(
    rest: &[u8],
    cursor: &mut usize,
    marker: &[u8],
) -> Result<Vec<McpWriteRequest>, PrefsBlobError> {
    match find_top_level_marker(rest, *cursor, marker) {
        Some(rel_idx) => {
            let arr_start = *cursor + rel_idx + marker.len();
            let (requests, consumed) = parse_json_mcp_write_requests(&rest[arr_start..])
                .ok_or(PrefsBlobError::PlaintextParseFailed)?;
            *cursor = arr_start + consumed;
            Ok(requests)
        }
        None => Ok(Vec::new()),
    }
}

/// Parse a JSON array of request objects starting at `bytes[0] == '['`. Returns
/// the decoded requests + bytes consumed (through the closing `]`), or `None` on
/// any malformation.
///
/// Member order is not enforced here for the same reason it is not enforced for a
/// grant: the decoder's job is to read what an encoder wrote, and the encoder's
/// order is pinned by the golden-byte tests. An UNKNOWN member IS refused, again
/// like a grant: the forward-compatible extension point for this object is a field
/// a later build adds, and a build that dropped it silently would answer the card
/// with half a request.
fn parse_json_mcp_write_requests(bytes: &[u8]) -> Option<(Vec<McpWriteRequest>, usize)> {
    if bytes.first() != Some(&b'[') {
        return None;
    }
    let mut i = 1;
    let mut out: Vec<McpWriteRequest> = Vec::new();
    if bytes.get(i) == Some(&b']') {
        return Some((out, i + 1));
    }
    loop {
        let (request, consumed) = parse_mcp_write_request(&bytes[i..])?;
        i += consumed;
        out.push(request);
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

/// Parse one request object starting at `bytes[0] == '{'`.
///
/// A repeated member is refused rather than last-wins, for the same reason a
/// repeated field is refused everywhere else in this codec: two values for one
/// key is a blob this build did not write, and picking one of them silently is
/// how a queue row ends up describing a write nobody made.
///
/// **`connection`, `folder`, `requested_at` and `verb` are required**, and a
/// request missing one is refused. Only `summary` may be absent. A row with no
/// folder cannot be accepted (there is nothing to extend the grant BY), a row
/// with no connection cannot be matched to a grant, and a row with no verb cannot
/// be described to the person deciding: a parser that defaulted them would hand
/// the card a proposal that cannot be granted, which reads as a Myne bug rather
/// than as a client's malformed blob.
pub fn parse_mcp_write_request(bytes: &[u8]) -> Option<(McpWriteRequest, usize)> {
    if bytes.first() != Some(&b'{') {
        return None;
    }
    let mut i = 1;
    let mut request = McpWriteRequest::default();
    let mut seen: [bool; 6] = [false; 6];
    if bytes.get(i) == Some(&b'}') {
        return None;
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
        let slot = match key.as_str() {
            "connection" => 0,
            "folder" => 1,
            "kind" => 5,
            "requested_at" => 2,
            "summary" => 3,
            "verb" => 4,
            _ => return None,
        };
        if core::mem::replace(&mut seen[slot], true) {
            return None;
        }
        match slot {
            0 => {
                let (value, consumed) = parse_json_string(&bytes[i..])?;
                request.connection = value;
                i += consumed;
            }
            1 => {
                let (value, consumed) = parse_json_string(&bytes[i..])?;
                request.folder = value;
                i += consumed;
            }
            2 => {
                let (value, consumed) = parse_json_uint64(&bytes[i..]).ok()?;
                request.requested_at = value;
                i += consumed;
            }
            3 => {
                let (value, consumed) = parse_json_string(&bytes[i..])?;
                request.summary = value;
                i += consumed;
            }
            4 => {
                let (value, consumed) = parse_json_string(&bytes[i..])?;
                request.verb = value;
                i += consumed;
            }
            _ => {
                let (value, consumed) = parse_json_string(&bytes[i..])?;
                request.kind = McpRequestKind::from_canonical_token(&value)?;
                i += consumed;
            }
        }
        match bytes.get(i) {
            Some(&b',') => {
                i += 1;
                continue;
            }
            Some(&b'}') => {
                let required = seen[0] && seen[1] && seen[2] && seen[4];
                return required.then_some((request, i + 1));
            }
            _ => return None,
        }
    }
}

/// Parse one grant object starting at `bytes[0] == '{'`.
///
/// Folder arrays are canonicalized on read too (NFC, sorted, deduped) rather
/// than trusted: the value came out of an AEAD-verified blob, so this is not an
/// attacker boundary, but a grant whose set is unsorted would otherwise
/// round-trip to different bytes on the next write, and "read then write is
/// byte-identical" is a property the vector family pins.
///
/// **Model and arrays must agree, and disagreement is a parse failure.** A
/// `Folders` grant carrying an exclusion list, or an `Exclude` grant carrying an
/// allow list, is refused rather than resolved by precedence: the two arrays
/// mean opposite things, and a precedence rule is exactly how one of them ends
/// up read as the other.
///
/// An UNKNOWN member is refused rather than skipped, unlike a whole unknown
/// top-level field: the forward-compatible extension point for this object is
/// the write grant that task 13 adds, and it arrives as a new member this build
/// must not silently drop. Refusing means an older build reports an unreadable
/// prefs blob instead of quietly narrowing a grant it cannot represent.
pub fn parse_mcp_connection_grant(bytes: &[u8]) -> Option<(McpConnectionGrant, usize)> {
    if bytes.first() != Some(&b'{') {
        return None;
    }
    let mut i = 1;
    let mut grant = McpConnectionGrant::default();
    let mut seen_folders = false;
    let mut seen_excluded_folders = false;
    let mut seen_approved_at = false;
    let mut seen_model = false;
    let mut seen_write_folders = false;
    let mut seen_disabled_verbs = false;
    if bytes.get(i) == Some(&b'}') {
        return None;
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
        match key.as_str() {
            "approved_at" => {
                if seen_approved_at {
                    return None;
                }
                let (value, consumed) = parse_json_uint64(&bytes[i..]).ok()?;
                i += consumed;
                grant.approved_at = value;
                seen_approved_at = true;
            }
            "disabled_verbs" => {
                if seen_disabled_verbs {
                    return None;
                }
                let (verbs, consumed) = parse_json_string_array(&bytes[i..])?;
                i += consumed;
                grant.disabled_verbs = canonical_verb_list(&verbs);
                seen_disabled_verbs = true;
            }
            "excluded_folders" => {
                if seen_excluded_folders {
                    return None;
                }
                let (folders, consumed) = parse_json_string_array(&bytes[i..])?;
                i += consumed;
                grant.excluded_folders = canonical_folder_list(&folders);
                seen_excluded_folders = true;
            }
            "folders" => {
                if seen_folders {
                    return None;
                }
                let (folders, consumed) = parse_json_string_array(&bytes[i..])?;
                i += consumed;
                grant.folders = canonical_folder_list(&folders);
                seen_folders = true;
            }
            "last_used_at" => {
                if grant.last_used_at.is_some() {
                    return None;
                }
                let (value, consumed) = parse_json_uint64(&bytes[i..]).ok()?;
                i += consumed;
                grant.last_used_at = Some(value);
            }
            "model" => {
                if seen_model {
                    return None;
                }
                let (token, consumed) = parse_json_string(&bytes[i..])?;
                i += consumed;
                grant.model = McpScopeModel::from_canonical_token(&token)?;
                seen_model = true;
            }
            "write_folders" => {
                if seen_write_folders {
                    return None;
                }
                let (folders, consumed) = parse_json_string_array(&bytes[i..])?;
                i += consumed;
                grant.write_folders = canonical_folder_list(&folders);
                seen_write_folders = true;
            }
            _ => return None,
        }
        match bytes.get(i) {
            Some(&b',') => {
                i += 1;
                continue;
            }
            Some(&b'}') => {
                if !seen_approved_at {
                    return None;
                }
                match grant.model {
                    // The legacy shape: the allow list is REQUIRED there, even
                    // when empty, because an absent list and "nothing is
                    // readable" were different statements in the released
                    // codec and that reading is preserved. A write list on one is
                    // refused: the grant itself is unreadable to this build, so a
                    // write scope beside it would be a promise nothing serves.
                    McpScopeModel::Folders => {
                        if !seen_folders
                            || seen_excluded_folders
                            || seen_write_folders
                            || seen_disabled_verbs
                        {
                            return None;
                        }
                    }
                    // The exclusion shape: no array is a legal, complete grant
                    // (nothing is excluded, so the whole vault is readable),
                    // and an allow list alongside it is the inversion this
                    // parser exists to refuse.
                    McpScopeModel::Exclude => {
                        if seen_folders {
                            return None;
                        }
                    }
                }
                return Some((grant, i + 1));
            }
            _ => return None,
        }
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

/// Length in bytes of the canonical JSON plaintext `prefs` encodes to.
///
/// Exposed for the set-field byte budget in `myne-core` (myne-md/myne#613),
/// which has to answer "how close is this whole blob to
/// [`MAX_PREFS_PLAINTEXT_LEN`]" rather than "how big is this one field". The two
/// are not the same question, and the difference is everything the earlier
/// per-field estimate could not see: the four other set fields, the
/// `field_clocks` entries that outlive the entries they belonged to, and the
/// rest of the blob.
///
/// This encodes, so it is not free. Call it once for a base and add per-entry
/// deltas rather than calling it per candidate.
pub fn canonical_plaintext_len(prefs: &PrefsView) -> usize {
    canonical_json_encode(prefs).len()
}

/// Bytes one set-field entry costs inside the canonical plaintext, comma
/// included.
///
/// The companion to [`canonical_plaintext_len`], and exposed for the same
/// caller: a budget that measures the blob once and then adds per-entry deltas
/// needs those deltas in the ENCODER's units, not the caller's. Two rules make
/// `entry.len() + 3` wrong, and both are in this file rather than in the
/// caller's: the entry is NFC-normalised ([`canonical_folder_list`]), which can
/// move its byte length in either direction, and it is escaped
/// ([`crate::canonical_json`]), where a `"` or a `\` costs two bytes and a C0
/// control character costs six.
///
/// So the arithmetic lives here, next to the encoder it has to agree with,
/// rather than being re-derived by `myne-core`. A second copy of an escape table
/// is a second thing to keep in step.
pub fn canonical_set_entry_cost(entry: &str) -> usize {
    let normalized = entry.nfc().collect::<String>();
    crate::canonical_json::json_string_len(&normalized) + 1
}

/// Bytes one `field_clocks` member costs inside the canonical plaintext: the
/// key, a colon, the decimal value and a comma.
///
/// Same contract and same reason as [`canonical_set_entry_cost`]. The value's
/// own width is passed rather than assumed, because the caller is budgeting for
/// a clock that does not exist yet and the only honest input is the width the
/// stamper will write.
pub fn canonical_clock_member_cost(key: &str, value_digits: usize) -> usize {
    let normalized = key.nfc().collect::<String>();
    crate::canonical_json::json_string_len(&normalized) + 1 + value_digits + 1
}

/// Encode a `vault.prefs` blob with caller-supplied randomness
/// (`_raw` per `protocol/AGENTS.md` randomness-injection convention).
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
#[path = "prefs_mcp_connections_tests.rs"]
mod mcp_connections_tests;
#[cfg(test)]
#[path = "prefs_mcp_write_request_tests.rs"]
mod mcp_write_request_tests;
#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
#[path = "prefs_tests.rs"]
mod tests;
