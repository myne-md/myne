// SPDX-License-Identifier: AGPL-3.0
//! Single canonical HKDF helper — see `docs/spec/protocol.md` § 3.2, § 3.4.
//!
//! Every subkey derivation in the v0.1 protocol MUST go through
//! [`derive_subkey`]. Direct calls to `hkdf::Hkdf::expand` from outside
//! this module are forbidden by the AGENTS.md "subkey derivation
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
//! | [`SubkeyRole::SessionStateKey`]        | `session-state-key`       |
//! | [`SubkeyRole::PersonalDictKey`]        | `personal-dictionary-key` |
//! | [`SubkeyRole::VaultIndicesKey`]        | `vault-indices-key`       |
//! | [`SubkeyRole::VaultHeadMac`]           | `vault-head-mac`          |
//! | [`SubkeyRole::ServerAuth`]             | `server-auth`             |
//! | [`SubkeyRole::AttachmentTextKey`]      | `attachment-text-key`     |
//! | [`SubkeyRole::CatalogSyncId`]          | `catalog-sync-id`         |
//! | [`SubkeyRole::PrefsSyncId`]            | `prefs-sync-id`           |
//! | [`SubkeyRole::CustomThemesKey`]           | `custom-themes-key`       |
//! | [`SubkeyRole::ThemesSyncId`]              | `themes-sync-id`          |
//! | [`SubkeyRole::ChatsCatalogKey`]           | `chats-catalog-key`       |
//! | [`SubkeyRole::ChatsCatalogSyncId`]        | `chats-catalog-sync-id`   |
//! | [`SubkeyRole::ChatsKey`]                  | `chats-key`               |
//! | [`SubkeyRole::MembershipKey`]             | `membership-key`          |
//!
//! Future v0.1.x revisions may register additional roles by appending
//! variants to [`SubkeyRole`]. The `#[non_exhaustive]` attribute
//! prevents downstream code (companion repos, future feature branches)
//! from match-exhausting a stale list.

use crate::types::MetaVersion;
use alloc::vec::Vec;
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

/// Domain-separation prefix for every Myne v0.1 HKDF context string.
///
/// Spec § 1.2 + § 3.2.2 mandate this exact 10-byte sequence,
/// **including the trailing space** — it is part of the `info`
/// parameter that gets bound into every derived subkey. Any drift
/// here silently invalidates every existing vault.
const HKDF_PREFIX_V0_1: &[u8] = b"myne.v0.1 ";

/// Domain-separation prefix for every Myne **v0.2** (next-major) HKDF context
/// string — the CRDT-note-type / migration hierarchy (`spec/protocol.md` §10.3
/// registry v0.2 row, §10.7). **Load-bearing** exactly as [`HKDF_PREFIX_V0_1`]:
/// a v0.2 subkey derived under this prefix produces different bytes than the same
/// role under v0.1 even with the same `root_key` (the §10.5 context-separation
/// anti-downgrade property), so the whole-vault re-key (§10.4.1, #420) yields a
/// genuinely independent key hierarchy. Note the trailing space — part of the
/// bound `info`. Allocated by the `automerge-sync-migration` epic
/// (`decisions.md` 2026-08-09 format-commitment entry).
const HKDF_PREFIX_V0_2: &[u8] = b"myne.v0.2 ";

/// Registered owner-only role that wraps the current shared group key.
const ROLE_STR_GROUP_KEY_WRAP: &[u8] = b"group-key-wrap";

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
/// and survives a later epoch rotation.
const ROLE_STR_SESSION_STATE_KEY: &[u8] = b"session-state-key";

/// Registered role string for the v0.1 personal-dictionary blob KEK
/// (MYND-266; encrypts the `vault.dictionary` blob — `dictionary_blob.rs`,
/// `protocol.md` § 9.13 + § 3.4). Load-bearing: drift silently changes the
/// KEK. `root_key`-derived (like prefs/search/workspace), so it is
/// `itemsKey`-independent and survives a later epoch rotation.
const ROLE_STR_PERSONAL_DICT_KEY: &[u8] = b"personal-dictionary-key";

/// Registered role string for the v0.1 vault-indices blob KEK
/// (MYND-271; design MYND-31; encrypts the `vault.indices` structured-metadata
/// index blob — `protocol.md` § 9.8 + § 3.4). Load-bearing: drift silently
/// changes the KEK. `root_key`-derived (like prefs/search/workspace), so it is
/// `itemsKey`-independent and survives a later epoch rotation. DISTINCT from
/// `search-index-key` — `vault.indices` (structured metadata) and `vault.search`
/// (BM25 full-text) are separate blob families (one magic / one KEK per family).
const ROLE_STR_VAULT_INDICES_KEY: &[u8] = b"vault-indices-key";

/// Registered role string for the v0.1 vault-head MAC key
/// (MYND-416; keys `HMAC-SHA-256(key, head_mac_input)` for the sync fork-consistency
/// vault head — `vault_head.rs`, `sync-protocol.md` §3 + `protocol.md` §3.4).
/// Phase 2 — derived but not used until sync ships (like `server-auth`). NOT a
/// blob KEK; keys the head MAC and re-verifies the device-local `MYH1` baseline.
/// Load-bearing: drift silently changes every head MAC.
const ROLE_STR_VAULT_HEAD_MAC: &[u8] = b"vault-head-mac";

/// Registered role string for the Phase 2 server-authentication secret
/// (`protocol.md` §3.4 + §11.1; MYND-420). `secret = HKDF(root_key, "server-auth")`
/// is a 256-bit high-entropy SCRAM-SHA-256-PLUS credential proven at device-enroll
/// (never transmitted). Derived but unused until sync auth ships. NOT a blob KEK.
const ROLE_STR_SERVER_AUTH: &[u8] = b"server-auth";
/// Registered role string for the v0.1 attachment-text blob KEK
/// (MYND-328; encrypts the per-attachment extracted-text cache blobs —
/// `attachment_text_blob.rs`, `MYE1`, `protocol.md` § 9.15 + § 3.4).
/// Load-bearing: drift silently changes the KEK. `root_key`-derived (like
/// prefs/search/dictionary), so it is `itemsKey`-independent and survives a
/// later epoch rotation. ONE KEK serves every attachment-text blob; per-blob
/// separation comes from the `attachment_id` AAD binding (§ 9.15.3), not a
/// distinct subkey. DISTINCT from the AAD role string `"attachment-text-blob"`.
const ROLE_STR_ATTACHMENT_TEXT_KEY: &[u8] = b"attachment-text-key";

/// Registered role string for the Phase 2 sync blob-id of the
/// `vault.attachments` catalog (MYND-468; `protocol.md` §3.4,
/// `sync-protocol.md` §8.1). The catalog is a synced singleton outside
/// the head manifest, so it needs a deterministic, device-independent
/// 16-byte identifier in the sync metadata plane:
/// `catalog_sync_id = derive_subkey(root_key, CatalogSyncId)[0..16]`.
/// Like `attachments-id-hmac` this derives an *identifier*, NOT key
/// material — the catalog KEK stays `attachments-catalog-key`.
/// Load-bearing: drift silently splits the catalog into a second sync
/// record on every existing account.
const ROLE_STR_CATALOG_SYNC_ID: &[u8] = b"catalog-sync-id";

/// Registered role string for the Phase 2 sync blob-id of `vault.prefs`
/// (MYND-478; `protocol.md` §3.4, `sync-protocol.md` §10.2.1). Like the
/// attachments catalog, `vault.prefs` is a synced singleton outside the
/// head manifest, so it needs a deterministic, device-independent
/// 16-byte identifier in the sync metadata plane:
/// `prefs_sync_id = derive_subkey(root_key, PrefsSyncId)[0..16]`.
/// Like `catalog-sync-id` this derives an *identifier*, NOT key
/// material — the prefs KEK stays `prefs-key`. Load-bearing: drift
/// silently splits vault.prefs into a second sync record on every
/// existing account.
const ROLE_STR_PREFS_SYNC_ID: &[u8] = b"prefs-sync-id";

/// Registered role string for the v0.1 AI-embeddings blob KEK
/// (MYND-453; encrypts the `vault.embeddings` on-device AI embedding index —
/// `embeddings_blob.rs`, `MYR1`, `protocol.md` § 9.17 + § 3.4). Load-bearing:
/// drift silently changes the KEK. `root_key`-derived (like prefs/search/
/// indices), so it is `itemsKey`-independent and survives a later epoch
/// rotation. Only ever derived with the default-off `local-inference` feature +
/// `ai_enabled` on. DISTINCT from the AAD role string `"ai-embeddings-blob"`.
const ROLE_STR_AI_EMBEDDINGS_KEY: &[u8] = b"ai-embeddings-key";

/// Registered role string for the v0.1 custom-themes blob KEK
/// (MYND-486; encrypts the `vault.themes` custom-theme palette store —
/// `themes_blob.rs`, `MYT1`, `protocol.md` § 9.21 + § 3.4). Load-bearing:
/// drift silently changes the KEK. `root_key`-derived (like prefs/search/
/// dictionary), so it is `itemsKey`-independent and survives a later epoch
/// rotation. DISTINCT from the AAD role string `"custom-themes-blob"`.
const ROLE_STR_CUSTOM_THEMES_KEY: &[u8] = b"custom-themes-key";

/// Registered role string for the Phase 2 sync blob-id of `vault.themes`
/// (MYND-486; `protocol.md` §3.4, `sync-protocol.md` §10.x). Like the
/// attachments catalog and `vault.prefs`, `vault.themes` is a synced
/// singleton outside the head manifest, so it needs a deterministic,
/// device-independent 16-byte identifier in the sync metadata plane:
/// `themes_sync_id = derive_subkey(root_key, ThemesSyncId)[0..16]`.
/// Like `catalog-sync-id` / `prefs-sync-id` this derives an *identifier*,
/// NOT key material — the themes KEK stays `custom-themes-key`.
/// Load-bearing: drift silently splits vault.themes into a second sync
/// record on every existing account.
const ROLE_STR_THEMES_SYNC_ID: &[u8] = b"themes-sync-id";

/// Registered role string for the v0.1 AI conversations-catalog blob KEK
/// (myne-md/myne#675; encrypts the `vault.chats` conversation roster:
/// `chats_catalog_blob.rs`, `MYM1`, `protocol.md` § 9.23 + § 3.4).
/// Load-bearing: drift silently changes the KEK. `root_key`-derived (like
/// prefs/search/themes), so it is `itemsKey`-independent and survives a
/// later epoch rotation. DISTINCT from the AAD role string
/// `"chats-catalog"` and from the per-file family KEK `"chats-key"`.
const ROLE_STR_CHATS_CATALOG_KEY: &[u8] = b"chats-catalog-key";

/// Registered role string for the Phase 2 sync blob-id of `vault.chats`
/// (myne-md/myne#675; `protocol.md` § 3.4, `sync-protocol.md` § 4.2). Like
/// the attachments catalog, `vault.prefs` and `vault.themes`, the
/// conversations catalog is a synced singleton outside the head manifest,
/// so it needs a deterministic, device-independent 16-byte identifier in
/// the sync metadata plane:
/// `chats_catalog_sync_id = derive_subkey(root_key, ChatsCatalogSyncId)[0..16]`.
/// Like `catalog-sync-id` this derives an *identifier*, NOT key material:
/// the catalog KEK stays `chats-catalog-key`. The per-conversation `MYJ1`
/// files need no sync-id role: their sync blob-id is the conversation id's
/// own 16 bytes (the attachment-id pattern). Load-bearing: drift silently
/// splits the catalog into a second sync record on every existing account.
const ROLE_STR_CHATS_CATALOG_SYNC_ID: &[u8] = b"chats-catalog-sync-id";

/// Registered role string for the v0.1 per-conversation AI chat blob KEK
/// (myne-md/myne#675; encrypts the `chats/<id-hex>` turn lists:
/// `chats_blob.rs`, `MYJ1`, `protocol.md` § 9.24 + § 3.4). One KEK for the
/// whole family; per-conversation separation comes from the
/// `conversation_id` AAD binding (§ 9.24.3), the `attachment-text-key`
/// archetype. Load-bearing: drift silently changes the KEK.
/// `root_key`-derived (like prefs/search/attachment-text), so it is
/// `itemsKey`-independent and survives a later epoch rotation. DISTINCT
/// from the AAD role string `"chats-blob"` and from the catalog KEK
/// `"chats-catalog-key"`.
const ROLE_STR_CHATS_KEY: &[u8] = b"chats-key";
/// Registered role string for the v0.1 graph-layout blob KEK (encrypts the
/// `vault.graph` on-device knowledge-graph layout cache — `graph_layout_blob.rs`,
/// `MYG1`, `protocol.md` § 9.19). Load-bearing: drift silently changes the KEK.
/// `root_key`-derived (like prefs/search/indices/embeddings), so it is
/// `itemsKey`-independent and survives a later epoch rotation. A rebuildable
/// cache — never synced, never backed up. DISTINCT from the AAD role string
/// `"graph-layout-blob"`.
const ROLE_STR_GRAPH_LAYOUT_KEY: &[u8] = b"graph-layout-key";

/// Registered role string for the group-tier KEK that seals the owner-signed
/// group roster inside an `NTV6` `vault.meta` (myne-md/myne#712, `protocol.md`
/// §9.3.3). GROUP-tier only: a member holds the group key and must be able to
/// read the roster, while an owner-root-tier key must not open it. The roster
/// carries user-authored display names and the collaboration graph, so it is
/// sealed rather than appended in the clear. DISTINCT from the AAD role string
/// `"group-roster-blob"`.
const ROLE_STR_GROUP_ROSTER_KEY: &[u8] = b"group-roster-key";
/// KEK for the B2B member-names singleton (`vault.member-names`, `MYO5`;
/// `docs/spec/protocol.md` §9.29, `decisions/protocol/0666`). Group-tier: a member
/// holds the shared `group_key` and can therefore derive it, which is the point of
/// the family.
const ROLE_STR_MEMBER_NAMES_KEY: &[u8] = b"member-names-key";
/// Deterministic sync blob-id for the member-names singleton (the
/// `catalog-sync-id` / `prefs-sync-id` archetype), derived from the shared
/// `group_key` so an owner and a member of the same epoch address the same blob.
/// Derives an identifier, not key material.
const ROLE_STR_MEMBER_NAMES_SYNC_ID: &[u8] = b"member-names-sync-id";
/// KEK for the B2B device-to-person binding singleton (`vault.device-bindings`,
/// `MYU5`; `docs/spec/protocol.md` §9.30, the `member-devices` feature). Group-tier:
/// a member holds the shared `group_key` and can therefore derive it, which is the
/// point of the family.
const ROLE_STR_DEVICE_BINDING_KEY: &[u8] = b"device-binding-key";
/// Deterministic sync blob-id for the device-binding singleton (the
/// `catalog-sync-id` / `prefs-sync-id` archetype), derived from the shared
/// `group_key` so an owner and a member of the same epoch address the same blob.
/// Derives an identifier, not key material.
const ROLE_STR_DEVICE_BINDING_SYNC_ID: &[u8] = b"device-binding-sync-id";

/// Registered role string for the v0.2 vault membership field KEK (encrypts the
/// sealed account id in `vault.meta` §9.3.1, the account/vault split,
/// `decisions.md` 2026-09-07). Load-bearing: drift silently changes the KEK.
/// Derived under the v0.2 context prefix (the field is NTV5-only), NOT v0.1:
/// `root_key`-derived (like prefs/search/workspace), so it is `itemsKey`-independent
/// and survives a later epoch rotation. DISTINCT from the AAD role string
/// `"membership-blob"`.
const ROLE_STR_MEMBERSHIP_KEY: &[u8] = b"membership-key";

/// Registered role string for the device-local vault-bound person-identity
/// carrier (`<app_config_dir>/person-vault-carriers/<vault_id_hex>.json`; `protocol.md` §3.4). Seals
/// the person keypair, at rest, under the owner's `root_key`, so an `NTV6`
/// owner-vault unlock re-installs the person identity without the recovery
/// phrase. Root-tier and owner-only: a member holds no `root_key`. Load-bearing
/// (`hkdf-sha256` vector); DISTINCT from the AAD role string
/// `"person-vault-carrier-blob"`.
const ROLE_STR_PERSON_VAULT_CARRIER: &[u8] = b"person-vault-carrier";

/// Registered role string for the v0.1 agent-memory catalog KEK (encrypts the
/// `vault.agent-memory` singleton: `agent_memory_blob.rs`, `MYN1`,
/// `protocol.md` § 9.25, myne-md/myne#697). Load-bearing: drift silently
/// changes the KEK. `root_key`-derived (like prefs/search/chats-catalog), so
/// it is `itemsKey`-independent and survives a later epoch rotation. Written
/// only while `ai_enabled` is on. DISTINCT from the AAD role string
/// `"agent-memory-catalog"` and from the per-file family KEK
/// `"agent-memory-key"`.
const ROLE_STR_AGENT_MEMORY_CATALOG_KEY: &[u8] = b"agent-memory-catalog-key";

/// Registered role string for the Phase 2 sync blob-id of `vault.agent-memory`
/// (myne-md/myne#697; `protocol.md` § 3.4, `sync-protocol.md` § 10.2.6). Like
/// the chats/themes catalogs, the memory catalog is a synced singleton outside
/// the head manifest, so it needs a deterministic, device-independent 16-byte
/// identifier in the sync metadata plane:
/// `agent_memory_catalog_sync_id = derive_subkey(root_key, AgentMemoryCatalogSyncId)[0..16]`.
/// Like `chats-catalog-sync-id` this derives an *identifier*, NOT key material:
/// the catalog KEK stays `agent-memory-catalog-key`. The per-entry `MYX1`
/// files need no sync-id role: their sync blob-id is the entry id's own 16
/// bytes (the attachment-id pattern). Load-bearing: drift silently splits the
/// catalog into a second sync record on every existing account.
const ROLE_STR_AGENT_MEMORY_CATALOG_SYNC_ID: &[u8] = b"agent-memory-catalog-sync-id";

/// Registered role string for the v0.1 per-entry agent-memory blob KEK
/// (myne-md/myne#697; encrypts the `memories/<id-hex>` entries:
/// `agent_memory_blob.rs`, `MYX1`, `protocol.md` § 9.26 + § 3.4). One KEK for
/// the whole family; per-entry separation comes from the `memory_entry_id`
/// AAD binding (§ 9.26.3), the `attachment-text-key` archetype.
/// Load-bearing: drift silently changes the KEK. `root_key`-derived (like
/// prefs/search/attachment-text), so it is `itemsKey`-independent and survives
/// a later epoch rotation. DISTINCT from the AAD role string
/// `"agent-memory-blob"` and from the catalog KEK
/// `"agent-memory-catalog-key"`.
const ROLE_STR_AGENT_MEMORY_KEY: &[u8] = b"agent-memory-key";

/// Registered role string for the v0.1 agent-personality singleton KEK
/// (encrypts the `vault.personality` voice-directive singleton:
/// `agent_personality_blob.rs`, `MYZ1`, `protocol.md` § 9.27,
/// myne-md/myne#697). Load-bearing: drift silently changes the KEK.
/// `root_key`-derived (like prefs/search/themes), so it is
/// `itemsKey`-independent and survives a later epoch rotation. User-authored
/// only; written only while `ai_enabled` is on. DISTINCT from the AAD role
/// string `"personality-blob"`.
const ROLE_STR_AGENT_PERSONALITY_KEY: &[u8] = b"agent-personality-key";

/// Registered role string for the Phase 2 sync blob-id of `vault.personality`
/// (myne-md/myne#697; `protocol.md` § 3.4, `sync-protocol.md` § 10.2.7). The
/// personality singleton is a synced singleton outside the head manifest, so
/// it needs a deterministic, device-independent 16-byte identifier in the sync
/// metadata plane:
/// `agent_personality_sync_id = derive_subkey(root_key, AgentPersonalitySyncId)[0..16]`.
/// Like `themes-sync-id` this derives an *identifier*, NOT key material: the
/// singleton's KEK stays `agent-personality-key`. Load-bearing: drift
/// silently splits the singleton into a second sync record on every existing
/// account.
const ROLE_STR_AGENT_PERSONALITY_SYNC_ID: &[u8] = b"agent-personality-sync-id";

/// Registered role string for the per-note **awareness room id** of the
/// live-collaboration awareness plane (`protocol.md` § 3.4; SYNC-1/SYNC-9).
/// The room id sent to the relay is the first 16 bytes of
/// `HMAC-SHA-256(derive_subkey_v0_2(root_key, AwarenessRoomId), note_uuid)` (the
/// `attachments-id-hmac` archetype), so it is per-note and note-unlinkable: the
/// relay cannot invert it to a note id. Derives an **identifier**, NOT key
/// material (like `catalog-sync-id`); the frame KEK stays `awareness-key`.
/// Registered in v0.2 only.
const ROLE_STR_AWARENESS_ROOM_ID: &[u8] = b"awareness-room-id";

/// Registered role string for the **awareness frame** KEK of the
/// live-collaboration awareness plane (`protocol.md` § 3.4; SYNC-1). The 32-byte
/// output seals the ephemeral awareness frames (canonical JSON carrying
/// cursor/selection/presence and opaque Automerge change bytes). Group-derived
/// for an `NTV6` vault so a member removal rotates it with the group key.
/// Registered in v0.2 only.
const ROLE_STR_AWARENESS_KEY: &[u8] = b"awareness-key";

/// Owner-only root material. A member-held [`GroupKey`] cannot be supplied to
/// [`derive_owner_subkey_v0_2`] without an explicit, review-visible conversion.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct OwnerKey([u8; 32]);

impl OwnerKey {
    pub fn new(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
}

/// Shared member-held root material for the current group-key epoch.
#[derive(Zeroize, ZeroizeOnDrop)]
pub struct GroupKey([u8; 32]);

impl GroupKey {
    pub fn new(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
}

/// Roles derived exclusively from [`OwnerKey`].
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum OwnerRole {
    GroupKeyWrap,
    ServerAuth,
    MembershipKey,
    VaultHeadMac,
    AiEmbeddingsKey,
    ChatsCatalogKey,
    ChatsCatalogSyncId,
    ChatsKey,
    AgentMemoryCatalogKey,
    AgentMemoryCatalogSyncId,
    AgentMemoryKey,
    AgentPersonalityKey,
    AgentPersonalitySyncId,
    PersonVaultCarrier,
}

impl OwnerRole {
    pub const ALL: [Self; 14] = [
        Self::GroupKeyWrap,
        Self::ServerAuth,
        Self::MembershipKey,
        Self::VaultHeadMac,
        Self::AiEmbeddingsKey,
        Self::ChatsCatalogKey,
        Self::ChatsCatalogSyncId,
        Self::ChatsKey,
        Self::AgentMemoryCatalogKey,
        Self::AgentMemoryCatalogSyncId,
        Self::AgentMemoryKey,
        Self::AgentPersonalityKey,
        Self::AgentPersonalitySyncId,
        Self::PersonVaultCarrier,
    ];

    fn role_str(self) -> &'static [u8] {
        match self {
            Self::GroupKeyWrap => ROLE_STR_GROUP_KEY_WRAP,
            Self::ServerAuth => ROLE_STR_SERVER_AUTH,
            Self::MembershipKey => ROLE_STR_MEMBERSHIP_KEY,
            Self::VaultHeadMac => ROLE_STR_VAULT_HEAD_MAC,
            Self::AiEmbeddingsKey => ROLE_STR_AI_EMBEDDINGS_KEY,
            Self::ChatsCatalogKey => ROLE_STR_CHATS_CATALOG_KEY,
            Self::ChatsCatalogSyncId => ROLE_STR_CHATS_CATALOG_SYNC_ID,
            Self::ChatsKey => ROLE_STR_CHATS_KEY,
            Self::AgentMemoryCatalogKey => ROLE_STR_AGENT_MEMORY_CATALOG_KEY,
            Self::AgentMemoryCatalogSyncId => ROLE_STR_AGENT_MEMORY_CATALOG_SYNC_ID,
            Self::AgentMemoryKey => ROLE_STR_AGENT_MEMORY_KEY,
            Self::AgentPersonalityKey => ROLE_STR_AGENT_PERSONALITY_KEY,
            Self::AgentPersonalitySyncId => ROLE_STR_AGENT_PERSONALITY_SYNC_ID,
            Self::PersonVaultCarrier => ROLE_STR_PERSON_VAULT_CARRIER,
        }
    }
}

/// Roles derived exclusively from [`GroupKey`].
#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum GroupRole {
    ItemsKeyWrap,
    PrefsKey,
    SearchIndexKey,
    AttachmentsCatalogKey,
    /// RESERVED, deliberately unused. The content-addressed attachment-id is
    /// keyed under the OWNER `root_key` and must stay stable across a B2B
    /// migration (spec §9.9): the migration reseals the catalog under the group
    /// tier but never rewrites attachment filenames, catalog keys or note
    /// `![[att:…]]` references, so a group-derived id would orphan every
    /// existing blob and duplicate every re-import. `SubkeyRole::shared_group_role`
    /// therefore refuses to map `AttachmentsIdHmac` here, and no reader derives
    /// this role. It stays registered so a future design that DOES rewrite ids
    /// (a member-authored import scheme) can adopt it without re-cutting the
    /// registry.
    AttachmentsIdHmac,
    SessionStateKey,
    PersonalDictKey,
    VaultIndicesKey,
    AttachmentTextKey,
    CatalogSyncId,
    PrefsSyncId,
    CustomThemesKey,
    ThemesSyncId,
    GraphLayoutKey,
    /// KEK for the sealed owner-signed group roster in an `NTV6` `vault.meta`.
    GroupRosterKey,
    /// Per-note awareness room id of the live-collaboration awareness plane
    /// (`protocol.md` § 3.4; SYNC-1/SYNC-9). The group-tier counterpart of
    /// `SubkeyRole::AwarenessRoomId`: a member derives the same room id from the
    /// shared `group_key`, so owner and member address one room. Derives an
    /// **identifier**, NOT key material.
    AwarenessRoomId,
    /// KEK for the live-collaboration awareness frames (`protocol.md` § 3.4;
    /// SYNC-1). The group-tier counterpart of `SubkeyRole::AwarenessKey`, so a
    /// member seals and opens the same frames as the owner.
    AwarenessKey,
    /// KEK for the B2B member-names singleton (`vault.member-names`, `MYO5`;
    /// `protocol.md` §9.29, `decisions/protocol/0666`). A member holds the shared
    /// `group_key`, so this is what makes the family readable by every member and
    /// by nobody else. Distinct string from the AAD role `"member-names-blob"`.
    MemberNamesKey,
    /// Deterministic sync blob-id for that same singleton (the `catalog-sync-id`
    /// archetype). Derives an identifier, NOT key material.
    MemberNamesSyncId,
    /// KEK for the B2B device-to-person binding singleton (`vault.device-bindings`,
    /// `MYU5`; `protocol.md` §9.30, the `member-devices` feature). A member holds the
    /// shared `group_key`, so this is what makes the family readable by every member
    /// and by nobody else. Distinct string from the AAD role `"device-binding-blob"`,
    /// and distinct from `member-names-key`: the two families are sealed separately
    /// even though both are member-writable, so a blob of one can never be opened as
    /// the other.
    ///
    /// Like `MemberNamesKey`, this has **no** [`SubkeyRole`] counterpart: the family is
    /// `NTV6`-only, a pre-B2B vault has no `group_key` to derive it from, and therefore
    /// no vault in which a member-writable binding map could exist at all.
    DeviceBindingKey,
    /// Deterministic sync blob-id for that same singleton (the `catalog-sync-id`
    /// archetype, and the `MemberNamesSyncId` twin one row up). Derives an
    /// identifier, NOT key material.
    ///
    /// It is derived from the GROUP key rather than the owner root, which is what lets a
    /// member address the blob the owner wrote. It therefore ROTATES with the group key on
    /// member removal, which moves it in two halves that must be read as one: the blob is
    /// re-sealed to the new epoch, and the retired epoch's id is queued for server reclaim.
    /// Reclaiming without re-sealing has the server delete the record and leave nothing at
    /// the new epoch; re-sealing without reclaiming leaves the retired record readable to
    /// the member just removed, who still holds the old group key.
    DeviceBindingSyncId,
}

impl GroupRole {
    pub const ALL: [Self; 21] = [
        Self::ItemsKeyWrap,
        Self::PrefsKey,
        Self::SearchIndexKey,
        Self::AttachmentsCatalogKey,
        Self::AttachmentsIdHmac,
        Self::SessionStateKey,
        Self::PersonalDictKey,
        Self::VaultIndicesKey,
        Self::AttachmentTextKey,
        Self::CatalogSyncId,
        Self::PrefsSyncId,
        Self::CustomThemesKey,
        Self::ThemesSyncId,
        Self::GraphLayoutKey,
        Self::GroupRosterKey,
        Self::AwarenessRoomId,
        Self::AwarenessKey,
        Self::MemberNamesKey,
        Self::MemberNamesSyncId,
        Self::DeviceBindingKey,
        Self::DeviceBindingSyncId,
    ];

    fn role_str(self) -> &'static [u8] {
        match self {
            Self::ItemsKeyWrap => ROLE_STR_ITEMS_KEY_WRAP,
            Self::PrefsKey => ROLE_STR_PREFS_KEY,
            Self::SearchIndexKey => ROLE_STR_SEARCH_INDEX_KEY,
            Self::AttachmentsCatalogKey => ROLE_STR_ATTACHMENTS_CATALOG_KEY,
            Self::AttachmentsIdHmac => ROLE_STR_ATTACHMENTS_ID_HMAC,
            Self::SessionStateKey => ROLE_STR_SESSION_STATE_KEY,
            Self::PersonalDictKey => ROLE_STR_PERSONAL_DICT_KEY,
            Self::VaultIndicesKey => ROLE_STR_VAULT_INDICES_KEY,
            Self::AttachmentTextKey => ROLE_STR_ATTACHMENT_TEXT_KEY,
            Self::CatalogSyncId => ROLE_STR_CATALOG_SYNC_ID,
            Self::PrefsSyncId => ROLE_STR_PREFS_SYNC_ID,
            Self::CustomThemesKey => ROLE_STR_CUSTOM_THEMES_KEY,
            Self::ThemesSyncId => ROLE_STR_THEMES_SYNC_ID,
            Self::GraphLayoutKey => ROLE_STR_GRAPH_LAYOUT_KEY,
            Self::GroupRosterKey => ROLE_STR_GROUP_ROSTER_KEY,
            Self::AwarenessRoomId => ROLE_STR_AWARENESS_ROOM_ID,
            Self::AwarenessKey => ROLE_STR_AWARENESS_KEY,
            Self::MemberNamesKey => ROLE_STR_MEMBER_NAMES_KEY,
            Self::MemberNamesSyncId => ROLE_STR_MEMBER_NAMES_SYNC_ID,
            Self::DeviceBindingKey => ROLE_STR_DEVICE_BINDING_KEY,
            Self::DeviceBindingSyncId => ROLE_STR_DEVICE_BINDING_SYNC_ID,
        }
    }
}

impl SubkeyRole {
    /// The [`GroupRole`] counterpart of a SHARED singleton role.
    ///
    /// A pre-B2B session seals its shared singletons under the owner's
    /// root-tier key (`derive_subkey_versioned`); an `NTV6` session seals the
    /// same blobs under the group key (`derive_group_subkey_v0_2`). The blob
    /// codecs, their AAD role strings and their framing are IDENTICAL either
    /// way, so the only thing a reader needs to switch is which registry names
    /// the KEK.
    ///
    /// `None` for an owner-only role: the SCRAM secret, the membership key, the
    /// vault-head MAC, the attachment id-HMAC, the AI embedding index and the
    /// chats / agent-memory / agent-personality singletons stay root-derived. A
    /// `None` here is a refusal, not a fallback: passing such a role to the
    /// group tier would derive a key no writer ever produced.
    ///
    /// `AttachmentsIdHmac` is the one that looks shared but is not. Spec §9.9
    /// keys the content-addressed attachment-id under `root_key` and requires it
    /// to be stable within a vault; a B2B migration reseals the CATALOG under
    /// the group tier but never rewrites attachment filenames, catalog keys or
    /// note `![[att:…]]` references, so a group-derived id would orphan every
    /// existing blob and duplicate every re-import. It therefore refuses here,
    /// and the import path derives it from the owner root explicitly.
    pub fn shared_group_role(self) -> Option<GroupRole> {
        match self {
            Self::ItemsKeyWrap => Some(GroupRole::ItemsKeyWrap),
            Self::PrefsKey => Some(GroupRole::PrefsKey),
            Self::SearchIndexKey => Some(GroupRole::SearchIndexKey),
            Self::AttachmentsCatalogKey => Some(GroupRole::AttachmentsCatalogKey),
            Self::SessionStateKey => Some(GroupRole::SessionStateKey),
            Self::PersonalDictKey => Some(GroupRole::PersonalDictKey),
            Self::VaultIndicesKey => Some(GroupRole::VaultIndicesKey),
            Self::AttachmentTextKey => Some(GroupRole::AttachmentTextKey),
            Self::CatalogSyncId => Some(GroupRole::CatalogSyncId),
            Self::PrefsSyncId => Some(GroupRole::PrefsSyncId),
            Self::CustomThemesKey => Some(GroupRole::CustomThemesKey),
            Self::ThemesSyncId => Some(GroupRole::ThemesSyncId),
            Self::GraphLayoutKey => Some(GroupRole::GraphLayoutKey),
            Self::AwarenessRoomId => Some(GroupRole::AwarenessRoomId),
            Self::AwarenessKey => Some(GroupRole::AwarenessKey),
            Self::VaultHeadMac
            | Self::ServerAuth
            | Self::AttachmentsIdHmac
            | Self::AiEmbeddingsKey
            | Self::ChatsCatalogKey
            | Self::ChatsCatalogSyncId
            | Self::ChatsKey
            | Self::MembershipKey
            | Self::AgentMemoryCatalogKey
            | Self::AgentMemoryCatalogSyncId
            | Self::AgentMemoryKey
            | Self::AgentPersonalityKey
            | Self::AgentPersonalitySyncId
            | Self::PersonVaultCarrier => None,
        }
    }
}

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
    /// KEK for the v0.1 vault-indices blob (`vault.indices`, `MYI1`,
    /// MYND-271; design MYND-31). Encrypts the serialized structured-metadata
    /// index (wikilink graph + tag index + title resolution + typed property
    /// records) under XChaCha20-Poly1305 (CTX commitment outer). Distinct from
    /// `SearchIndexKey` so the structured-index and full-text-search blob
    /// families are domain-separated (one KEK per family).
    VaultIndicesKey,
    /// HMAC key for the v0.1 sync **vault head** (`vault.head-state` / wire head,
    /// MYND-416; `sync-protocol.md` §3). Keys `HMAC-SHA-256(key, head_mac_input)`
    /// for the fork-consistency head and re-verifies the device-local `MYH1`
    /// baseline. **Phase 2** — derived but not transmitted until sync ships
    /// (like the reserved `server-auth` material). NOT a blob KEK; distinct from
    /// every other role so the head MAC is domain-separated.
    VaultHeadMac,
    /// Phase 2 server-authentication secret (`protocol.md` §3.4 + §11.1; MYND-420).
    /// `secret = HKDF(root_key, "server-auth")` — a 256-bit high-entropy credential
    /// proven to the sync server via SCRAM-SHA-256-PLUS at device-enroll and NEVER
    /// transmitted (the server stores only a StoredKey/ServerKey verifier). Derived
    /// but unused until sync auth ships. NOT a blob KEK; domain-separated from every
    /// other role.
    ServerAuth,
    /// KEK for the v0.1 attachment-text blobs (`attachments-text/<id>`,
    /// `MYE1`, MYND-328). Encrypts the per-attachment extracted-text cache
    /// (PDF/DOCX/text-like) under XChaCha20-Poly1305 (CTX commitment outer).
    /// One KEK for all such blobs; per-blob safety comes from the
    /// `attachment_id` AAD binding (§ 9.15.3). Distinct from every other
    /// `root_key`-derived blob KEK so the families stay domain-separated.
    AttachmentTextKey,
    /// KEK for the v0.1 AI-embeddings blob (`vault.embeddings`, `MYR1`,
    /// MYND-453). Encrypts the on-device AI embedding index (semantic-search /
    /// Q&A vectors + `{note_id → content_nonce}` manifest + the model-identity
    /// tuple) under XChaCha20-Poly1305 (CTX commitment outer). `root_key`-derived
    /// (like prefs/search/indices), so it is `itemsKey`-independent and survives
    /// a later epoch rotation. Distinct from every other blob KEK so the families
    /// stay domain-separated; only derived with the `local-inference` feature.
    AiEmbeddingsKey,
    /// Phase 2 sync blob-id derivation for the `vault.attachments` catalog
    /// (MYND-468; `protocol.md` §3.4, `sync-protocol.md` §8.1). The first 16
    /// bytes of the derived output are the catalog's reserved sync-plane
    /// blob-id — deterministic across the fleet, indistinguishable from a
    /// note UUID to the server. Derives an **identifier**, NOT key material
    /// (like `AttachmentsIdHmac`); the catalog KEK stays
    /// `AttachmentsCatalogKey`. Domain-separated from every other role.
    CatalogSyncId,
    /// Phase 2 sync blob-id derivation for `vault.prefs` (MYND-478;
    /// `protocol.md` §3.4, `sync-protocol.md` §10.2.1). The first 16 bytes
    /// of the derived output are the prefs blob's reserved sync-plane
    /// blob-id — deterministic across the fleet, indistinguishable from a
    /// note UUID to the server. Derives an **identifier**, NOT key material
    /// (like `CatalogSyncId` / `AttachmentsIdHmac`); the prefs KEK stays
    /// `PrefsKey`. Domain-separated from every other role.
    PrefsSyncId,
    /// KEK for the v0.1 custom-themes blob (`vault.themes`, `MYT1`,
    /// MYND-486). Encrypts the `{theme_name → palette_map}` custom-theme
    /// store under XChaCha20-Poly1305 (CTX commitment outer). `root_key`-derived
    /// (like prefs/search/dictionary), so it is `itemsKey`-independent and
    /// survives a later epoch rotation. Distinct from every other
    /// `root_key`-derived blob KEK so every blob family is cryptographically
    /// domain-separated; distinct from the AAD role `"custom-themes-blob"`.
    CustomThemesKey,
    /// Phase 2 sync blob-id derivation for `vault.themes` (MYND-486;
    /// `protocol.md` §3.4, `sync-protocol.md` §10.x). The first 16 bytes of
    /// the derived output are the themes blob's reserved sync-plane blob-id —
    /// deterministic across the fleet, indistinguishable from a note UUID to
    /// the server. Derives an **identifier**, NOT key material (like
    /// `PrefsSyncId` / `CatalogSyncId` / `AttachmentsIdHmac`); the themes KEK
    /// stays `CustomThemesKey`. Domain-separated from every other role.
    ThemesSyncId,
    /// KEK for the v0.1 graph-layout blob (`vault.graph`, `MYG1`). Encrypts the
    /// on-device knowledge-graph layout cache (node positions + a staleness
    /// marker) under XChaCha20-Poly1305 (CTX commitment outer). `root_key`-derived
    /// (like prefs/search/indices/embeddings), so it is `itemsKey`-independent and
    /// survives a later epoch rotation. A rebuildable cache — never synced, never
    /// backed up. Distinct from every other blob KEK so the families stay
    /// domain-separated.
    GraphLayoutKey,
    /// KEK for the v0.1 AI conversations-catalog blob (`vault.chats`, `MYM1`,
    /// myne-md/myne#675). Encrypts the canonical-JSON conversation roster
    /// (id / title / timestamps / causal version / tombstone) under
    /// XChaCha20-Poly1305 (CTX commitment outer). `root_key`-derived (like
    /// prefs/search/themes), so it is `itemsKey`-independent and survives a
    /// later epoch rotation. Distinct from every other blob KEK so the
    /// families stay domain-separated; distinct from the per-file family KEK
    /// `ChatsKey` and from the AAD role `"chats-catalog"`.
    ChatsCatalogKey,
    /// Phase 2 sync blob-id derivation for `vault.chats` (myne-md/myne#675;
    /// `protocol.md` § 3.4, `sync-protocol.md` § 4.2). The first 16 bytes of
    /// the derived output are the catalog's reserved sync-plane blob-id:
    /// deterministic across the fleet, indistinguishable from a note UUID to
    /// the server. Derives an **identifier**, NOT key material (like
    /// `ThemesSyncId` / `PrefsSyncId` / `CatalogSyncId`); the catalog KEK
    /// stays `ChatsCatalogKey`. The per-conversation `MYJ1` files carry no
    /// sync-id role: their blob-id is the conversation id itself.
    /// Domain-separated from every other role.
    ChatsCatalogSyncId,
    /// KEK for the v0.1 per-conversation AI chat blobs (`chats/<id-hex>`,
    /// `MYJ1`, myne-md/myne#675). Encrypts each conversation's ordered
    /// immutable turn list under XChaCha20-Poly1305 (CTX commitment outer).
    /// ONE KEK for the whole family; per-conversation safety comes from the
    /// `conversation_id` AAD binding (§ 9.24.3), the `AttachmentTextKey`
    /// archetype. `root_key`-derived (like prefs/search/attachment-text), so
    /// it is `itemsKey`-independent and survives a later epoch rotation.
    /// Distinct from every other blob KEK so the families stay
    /// domain-separated; distinct from the catalog KEK `ChatsCatalogKey`
    /// and from the AAD role `"chats-blob"`.
    ChatsKey,
    /// KEK for the v0.2 vault membership field (`vault.meta` §9.3.1). Encrypts the
    /// sealed account id under XChaCha20-Poly1305 (CTX commitment outer),
    /// derived under the v0.2 context prefix because the field is NTV5-only.
    /// `root_key`-derived (like prefs/search/workspace), so it is
    /// `itemsKey`-independent and survives a later epoch rotation. Distinct from
    /// every other blob KEK so the families stay domain-separated; distinct from
    /// the AAD role `"membership-blob"`.
    MembershipKey,
    /// KEK for the v0.1 agent-memory catalog singleton (`vault.agent-memory`,
    /// `MYN1`, myne-md/myne#697; `protocol.md` § 9.25). Encrypts the canonical-JSON
    /// memory roster under XChaCha20-Poly1305 (CTX commitment outer).
    /// `root_key`-derived (like prefs/search/chats-catalog), so it is
    /// `itemsKey`-independent and survives a later epoch rotation. Written only
    /// while the `ai_enabled` opt-in is on. Distinct from every other blob KEK so
    /// the families stay domain-separated; distinct from the per-file family KEK
    /// `AgentMemoryKey` and from the AAD role `"agent-memory-catalog"`.
    AgentMemoryCatalogKey,
    /// Phase 2 sync blob-id derivation for `vault.agent-memory` (myne-md/myne#697;
    /// `protocol.md` § 3.4, `sync-protocol.md` § 10.2.6). The first 16 bytes of
    /// the derived output are the catalog's reserved sync-plane blob-id:
    /// deterministic across the fleet, indistinguishable from a note UUID to
    /// the server. Derives an **identifier**, NOT key material (like
    /// `ChatsCatalogSyncId`); the catalog KEK stays `AgentMemoryCatalogKey`.
    /// The per-entry `MYX1` files carry no sync-id role: their blob-id is the
    /// entry id itself. Domain-separated from every other role.
    AgentMemoryCatalogSyncId,
    /// KEK for the v0.1 per-entry agent-memory blobs (`memories/<id-hex>`,
    /// `MYX1`, myne-md/myne#697). Encrypts each entry's distilled text under
    /// XChaCha20-Poly1305 (CTX commitment outer). ONE KEK for the whole
    /// family; per-entry safety comes from the `memory_entry_id` AAD binding
    /// (§ 9.26.3), the `AttachmentTextKey` archetype. `root_key`-derived (like
    /// prefs/search/attachment-text), so it is `itemsKey`-independent and
    /// survives a later epoch rotation. Distinct from every other blob KEK so
    /// the families stay domain-separated; distinct from the catalog KEK
    /// `AgentMemoryCatalogKey` and from the AAD role `"agent-memory-blob"`.
    AgentMemoryKey,
    /// KEK for the v0.1 agent-personality singleton (`vault.personality`,
    /// `MYZ1`, myne-md/myne#697; `protocol.md` § 9.27). Encrypts the canonical-JSON
    /// voice-directive block under XChaCha20-Poly1305 (CTX commitment outer).
    /// `root_key`-derived (like prefs/search/themes), so it is
    /// `itemsKey`-independent and survives a later epoch rotation.
    /// User-authored only; written only while `ai_enabled` is on. Distinct from
    /// every other blob KEK so the families stay domain-separated; distinct
    /// from the AAD role `"personality-blob"`.
    AgentPersonalityKey,
    /// Phase 2 sync blob-id derivation for `vault.personality` (myne-md/myne#697;
    /// `protocol.md` § 3.4, `sync-protocol.md` § 10.2.7). The first 16 bytes of
    /// the derived output are the singleton's reserved sync-plane blob-id:
    /// deterministic across the fleet, indistinguishable from a note UUID to
    /// the server. Derives an **identifier**, NOT key material (like
    /// `ThemesSyncId`); the singleton's KEK stays `AgentPersonalityKey`.
    /// Domain-separated from every other role.
    AgentPersonalitySyncId,
    /// KEK for the device-local, vault-bound person-identity carrier
    /// (`<app_config_dir>/person-vault-carriers/<vault_id_hex>.json`; `protocol.md` §3.4). Seals the
    /// person keypair, at rest, under the owner's `root_key`, so an `NTV6`
    /// owner-vault unlock installs the person session without the recovery
    /// phrase (decisions/protocol/0612 amended). Root-derived and owner-only (a
    /// member holds no `root_key`); never synced. Distinct
    /// from the AAD role `"person-vault-carrier-blob"`.
    PersonVaultCarrier,
    /// Per-note awareness room id of the live-collaboration awareness plane
    /// (`protocol.md` § 3.4; SYNC-1/SYNC-9). Derives an **identifier**, NOT key
    /// material (like `CatalogSyncId` / `AttachmentsIdHmac`): the first 16 bytes
    /// of an HMAC over the note uuid keyed by this role's output are the room id
    /// sent to the relay; the frame KEK stays `AwarenessKey`. Distinct from
    /// `AwarenessKey` so the id and the KEK are domain-separated. Registered in
    /// v0.2 only; its group counterpart is `GroupRole::AwarenessRoomId`.
    AwarenessRoomId,
    /// KEK for the live-collaboration awareness frames (`protocol.md` § 3.4;
    /// SYNC-1). Seals the ephemeral per-note frames carrying cursor/selection/
    /// presence and opaque Automerge change bytes under XChaCha20-Poly1305
    /// (CTX commitment outer). v0.2-only; its group counterpart is
    /// `GroupRole::AwarenessKey`, so a member removal rotates it with the group
    /// key.
    AwarenessKey,
}

impl SubkeyRole {
    /// Every registered role, in declaration order — the machine-readable
    /// mirror of the spec § 3.4 registry table.
    ///
    /// Exists so coverage guards enumerate the registry instead of restating
    /// it. The `myne-test-vectors` `hkdf-sha256` runner iterates this to assert
    /// every role has a companion-repo vector; before it existed, that runner
    /// carried a hand-maintained string list that silently fell four roles
    /// behind the enum (`vault-head-mac`, `server-auth`, `custom-themes-key`,
    /// `themes-sync-id` derived without a single cross-implementation vector).
    ///
    /// **Adding a `SubkeyRole` variant means adding it here too** — the
    /// `all_covers_every_registered_role` test fails compilation until you do.
    pub const ALL: [SubkeyRole; 29] = [
        SubkeyRole::ItemsKeyWrap,
        SubkeyRole::PrefsKey,
        SubkeyRole::SearchIndexKey,
        SubkeyRole::AttachmentsCatalogKey,
        SubkeyRole::AttachmentsIdHmac,
        SubkeyRole::SessionStateKey,
        SubkeyRole::PersonalDictKey,
        SubkeyRole::VaultIndicesKey,
        SubkeyRole::VaultHeadMac,
        SubkeyRole::ServerAuth,
        SubkeyRole::AttachmentTextKey,
        SubkeyRole::AiEmbeddingsKey,
        SubkeyRole::CatalogSyncId,
        SubkeyRole::PrefsSyncId,
        SubkeyRole::CustomThemesKey,
        SubkeyRole::ThemesSyncId,
        SubkeyRole::GraphLayoutKey,
        SubkeyRole::ChatsCatalogKey,
        SubkeyRole::ChatsCatalogSyncId,
        SubkeyRole::ChatsKey,
        SubkeyRole::MembershipKey,
        SubkeyRole::AgentMemoryCatalogKey,
        SubkeyRole::AgentMemoryCatalogSyncId,
        SubkeyRole::AgentMemoryKey,
        SubkeyRole::AgentPersonalityKey,
        SubkeyRole::AgentPersonalitySyncId,
        SubkeyRole::PersonVaultCarrier,
        SubkeyRole::AwarenessRoomId,
        SubkeyRole::AwarenessKey,
    ];

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
            SubkeyRole::VaultIndicesKey => ROLE_STR_VAULT_INDICES_KEY,
            SubkeyRole::VaultHeadMac => ROLE_STR_VAULT_HEAD_MAC,
            SubkeyRole::ServerAuth => ROLE_STR_SERVER_AUTH,
            SubkeyRole::AttachmentTextKey => ROLE_STR_ATTACHMENT_TEXT_KEY,
            SubkeyRole::AiEmbeddingsKey => ROLE_STR_AI_EMBEDDINGS_KEY,
            SubkeyRole::CatalogSyncId => ROLE_STR_CATALOG_SYNC_ID,
            SubkeyRole::PrefsSyncId => ROLE_STR_PREFS_SYNC_ID,
            SubkeyRole::CustomThemesKey => ROLE_STR_CUSTOM_THEMES_KEY,
            SubkeyRole::ThemesSyncId => ROLE_STR_THEMES_SYNC_ID,
            SubkeyRole::GraphLayoutKey => ROLE_STR_GRAPH_LAYOUT_KEY,
            SubkeyRole::ChatsCatalogKey => ROLE_STR_CHATS_CATALOG_KEY,
            SubkeyRole::ChatsCatalogSyncId => ROLE_STR_CHATS_CATALOG_SYNC_ID,
            SubkeyRole::ChatsKey => ROLE_STR_CHATS_KEY,
            SubkeyRole::MembershipKey => ROLE_STR_MEMBERSHIP_KEY,
            SubkeyRole::AgentMemoryCatalogKey => ROLE_STR_AGENT_MEMORY_CATALOG_KEY,
            SubkeyRole::AgentMemoryCatalogSyncId => ROLE_STR_AGENT_MEMORY_CATALOG_SYNC_ID,
            SubkeyRole::AgentMemoryKey => ROLE_STR_AGENT_MEMORY_KEY,
            SubkeyRole::AgentPersonalityKey => ROLE_STR_AGENT_PERSONALITY_KEY,
            SubkeyRole::AgentPersonalitySyncId => ROLE_STR_AGENT_PERSONALITY_SYNC_ID,
            SubkeyRole::PersonVaultCarrier => ROLE_STR_PERSON_VAULT_CARRIER,
            SubkeyRole::AwarenessRoomId => ROLE_STR_AWARENESS_ROOM_ID,
            SubkeyRole::AwarenessKey => ROLE_STR_AWARENESS_KEY,
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

/// Derive a 32-byte subkey from a **v0.2** `root_key` for the given role — the
/// same registered role strings as [`derive_subkey`], under the next-major
/// context prefix [`HKDF_PREFIX_V0_2`] instead of v0.1's.
///
/// This is the **only** public path for a v0.2 subkey, mirroring the v0.1
/// single-helper discipline (the underlying `hkdf.expand` stays module-private).
/// It exists for the whole-vault migration (§10.4.1, #420): after minting a fresh
/// v0.2 `root_key`, the migration derives `itemsKey_wrap_key` and every singleton
/// KEK through this helper. Because the context prefix differs, a v0.2 subkey is
/// unrelated to its v0.1 namesake even when the `root_key` bytes coincide — the
/// §10.5 context-separation property, asserted by
/// `v0_2_subkey_differs_from_v0_1_same_role_same_root`.
pub fn derive_subkey_v0_2(root_key: &[u8; 32], role: SubkeyRole) -> Zeroizing<[u8; 32]> {
    let role_bytes = role.role_str();
    let mut info = Vec::with_capacity(HKDF_PREFIX_V0_2.len() + role_bytes.len());
    info.extend_from_slice(HKDF_PREFIX_V0_2);
    info.extend_from_slice(role_bytes);
    derive_with_context(root_key, &info)
}

/// Derive an owner-only v0.2 subkey from typed owner material.
pub fn derive_owner_subkey_v0_2(owner_key: &OwnerKey, role: OwnerRole) -> Zeroizing<[u8; 32]> {
    derive_v0_2_typed(&owner_key.0, role.role_str())
}

/// Derive a shared v0.2 subkey from typed group material.
pub fn derive_group_subkey_v0_2(group_key: &GroupKey, role: GroupRole) -> Zeroizing<[u8; 32]> {
    derive_v0_2_typed(&group_key.0, role.role_str())
}

fn derive_v0_2_typed(key: &[u8; 32], role: &[u8]) -> Zeroizing<[u8; 32]> {
    let mut info = Vec::with_capacity(HKDF_PREFIX_V0_2.len() + role.len());
    info.extend_from_slice(HKDF_PREFIX_V0_2);
    info.extend_from_slice(role);
    derive_with_context(key, &info)
}

/// Derive a subkey under the generation named by `version` — [`derive_subkey`]
/// for [`MetaVersion::V0_1`], [`derive_subkey_v0_2`] for [`MetaVersion::V0_2`].
///
/// This is the one dispatch every version-aware reader/writer uses: it reads the
/// slot's [`MetaVersion`] and derives the KEK under the matching context prefix,
/// so a migrated (v0.2) vault derives every singleton/index KEK under
/// `"myne.v0.2 "` while an un-migrated one stays on `"myne.v0.1 "` — with no
/// per-call-site `match` duplicated across a dozen plugins.
pub fn derive_subkey_versioned(
    version: MetaVersion,
    root_key: &[u8; 32],
    role: SubkeyRole,
) -> Zeroizing<[u8; 32]> {
    match version {
        MetaVersion::V0_1 => derive_subkey(root_key, role),
        MetaVersion::V0_2 => derive_subkey_v0_2(root_key, role),
    }
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
    let mut okm = Zeroizing::new([0u8; 32]);
    derive_with_context_into(root_key, info, &mut okm[..]);
    okm
}

/// [`derive_with_context`] into a caller-sized buffer, for the one caller that
/// needs more than 32 bytes: the deterministic person-identity expansion, whose
/// ML-KEM seed is 64 bytes (`d || z`). Stays `pub(crate)` for the same reason
/// the 32-byte entry does, and is the only other place in the crate that calls
/// `hkdf.expand` (the registry guard permits `.expand(` in this module alone).
pub(crate) fn derive_with_context_into(root_key: &[u8; 32], info: &[u8], out: &mut [u8]) {
    let zero_salt = [0u8; 32];
    let hk = Hkdf::<Sha256>::new(Some(&zero_salt), root_key);
    hk.expand(info, out)
        .expect("HKDF-Expand output length is within the SHA-256 8160-byte limit");
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::test_vector_fmt::{hex_lower, json_escape};

    #[test]
    fn all_covers_every_registered_role() {
        // The exhaustive match below is the compile-time half of the guard: a
        // new SubkeyRole variant fails to compile here, forcing the author to
        // land it in `SubkeyRole::ALL` (and thus in the companion-repo
        // hkdf-sha256 coverage pin) in the same change. The index assertions
        // are the runtime half — they catch a variant listed out of order or
        // omitted from ALL entirely.
        fn declaration_index(role: SubkeyRole) -> usize {
            match role {
                SubkeyRole::ItemsKeyWrap => 0,
                SubkeyRole::PrefsKey => 1,
                SubkeyRole::SearchIndexKey => 2,
                SubkeyRole::AttachmentsCatalogKey => 3,
                SubkeyRole::AttachmentsIdHmac => 4,
                SubkeyRole::SessionStateKey => 5,
                SubkeyRole::PersonalDictKey => 6,
                SubkeyRole::VaultIndicesKey => 7,
                SubkeyRole::VaultHeadMac => 8,
                SubkeyRole::ServerAuth => 9,
                SubkeyRole::AttachmentTextKey => 10,
                SubkeyRole::AiEmbeddingsKey => 11,
                SubkeyRole::CatalogSyncId => 12,
                SubkeyRole::PrefsSyncId => 13,
                SubkeyRole::CustomThemesKey => 14,
                SubkeyRole::ThemesSyncId => 15,
                SubkeyRole::GraphLayoutKey => 16,
                SubkeyRole::ChatsCatalogKey => 17,
                SubkeyRole::ChatsCatalogSyncId => 18,
                SubkeyRole::ChatsKey => 19,
                SubkeyRole::MembershipKey => 20,
                SubkeyRole::AgentMemoryCatalogKey => 21,
                SubkeyRole::AgentMemoryCatalogSyncId => 22,
                SubkeyRole::AgentMemoryKey => 23,
                SubkeyRole::AgentPersonalityKey => 24,
                SubkeyRole::AgentPersonalitySyncId => 25,
                SubkeyRole::PersonVaultCarrier => 26,
                SubkeyRole::AwarenessRoomId => 27,
                SubkeyRole::AwarenessKey => 28,
            }
        }

        for (i, role) in SubkeyRole::ALL.iter().enumerate() {
            assert_eq!(
                declaration_index(*role),
                i,
                "SubkeyRole::ALL[{i}] is {role:?} — ALL is out of order or missing a variant"
            );
        }

        // Every role string is distinct: two roles sharing an info string
        // would silently collapse two key lineages into one.
        for (i, a) in SubkeyRole::ALL.iter().enumerate() {
            for b in SubkeyRole::ALL.iter().skip(i + 1) {
                assert_ne!(
                    a.role_str(),
                    b.role_str(),
                    "{a:?} and {b:?} share a role string — domain separation lost"
                );
            }
        }
    }

    #[test]
    fn every_registered_role_derives_a_distinct_subkey() {
        // Domain separation (spec § 3.2.2): every registered role's `info`
        // string is distinct (`all_covers_every_registered_role`), and
        // `derive_subkey` is exactly HKDF(`prefix || role_str`)
        // (`derive_subkey_concatenates_prefix_and_role_string`), so distinct
        // roles MUST derive distinct subkeys. This states that once over the
        // WHOLE registry, which the per-role pairwise copies it replaces each
        // restated for a hand-picked subset. The load-bearing case is the
        // id-vs-KEK families (`catalog-sync-id` / `prefs-sync-id` /
        // `themes-sync-id` against their `*-key` KEKs, §9.10.1): a collision
        // there would let one store's id be another store's key.
        let root = [0u8; 32];
        for (i, a) in SubkeyRole::ALL.iter().enumerate() {
            let derived_a = derive_subkey(&root, *a);
            for b in SubkeyRole::ALL.iter().skip(i + 1) {
                assert_ne!(
                    *derived_a,
                    *derive_subkey(&root, *b),
                    "{a:?} and {b:?} derive the SAME subkey: domain separation lost"
                );
            }
        }
    }

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
        // MYND-266 registry entry "myne.v0.1 personal-dictionary-key" (§ 9.13).
        // Frozen + load-bearing: drift silently changes the vault.dictionary KEK.
        assert_eq!(
            SubkeyRole::PersonalDictKey.role_str(),
            b"personal-dictionary-key"
        );
    }

    #[test]
    fn server_auth_role_string_matches_spec_registry() {
        // MYND-420 registry entry "myne.v0.1 server-auth" (§3.4 + §11.1). The
        // SCRAM-SHA-256-PLUS credential secret is HKDF(root_key, "server-auth");
        // drift silently breaks server authentication.
        assert_eq!(SubkeyRole::ServerAuth.role_str(), b"server-auth");
    }

    #[test]
    fn vault_indices_key_role_string_matches_spec_registry() {
        // MYND-271 registry entry "myne.v0.1 vault-indices-key" (§ 9.8; design
        // MYND-31). Frozen + load-bearing: drift silently changes the
        // vault.indices KEK.
        assert_eq!(SubkeyRole::VaultIndicesKey.role_str(), b"vault-indices-key");
    }

    #[test]
    fn derive_subkey_zero_root_vault_indices_key_golden() {
        // In-crate golden mirroring the companion vector
        // `hkdf-sha256/v0.1/zero-root-vault-indices-key`. Both must pass against
        // identical bytes — drift in either indicates HKDF prefix / role-string
        // corruption of the vault.indices KEK. Regenerate via
        // `emit_subkey_vectors_for_paste` if the algorithm/prefix/role changes.
        let derived = derive_subkey(&[0u8; 32], SubkeyRole::VaultIndicesKey);
        let expected: [u8; 32] = [
            0x16, 0x25, 0x47, 0x16, 0xC8, 0x7A, 0xB3, 0x17, 0x34, 0x64, 0xFF, 0x03, 0x8D, 0x61,
            0x8D, 0xF3, 0x1C, 0xF6, 0xE1, 0xFE, 0x49, 0xCF, 0x03, 0x3C, 0xD4, 0x39, 0x0A, 0x17,
            0x44, 0x62, 0x9A, 0x4B,
        ];
        assert_eq!(*derived, expected, "HKDF golden mismatch — regenerate");
    }

    #[test]
    fn attachment_text_key_role_string_matches_spec_registry() {
        // MYND-328 registry entry "myne.v0.1 attachment-text-key" (§ 9.15).
        // Frozen + load-bearing: drift silently changes the MYE1 KEK.
        assert_eq!(
            SubkeyRole::AttachmentTextKey.role_str(),
            b"attachment-text-key"
        );
    }

    #[test]
    fn catalog_sync_id_role_string_matches_spec_registry() {
        // MYND-468 registry entry "myne.v0.1 catalog-sync-id" (§3.4;
        // sync-protocol.md §8.1). Derives the catalog's reserved 16-byte
        // sync blob-id; drift silently splits the catalog into a second
        // sync record on every existing account.
        assert_eq!(SubkeyRole::CatalogSyncId.role_str(), b"catalog-sync-id");
    }

    #[test]
    fn prefs_sync_id_role_string_matches_spec_registry() {
        // MYND-478 registry entry "myne.v0.1 prefs-sync-id" (§3.4;
        // sync-protocol.md §10.2.1). Derives vault.prefs' reserved 16-byte
        // sync blob-id; drift silently splits vault.prefs into a second
        // sync record on every existing account.
        assert_eq!(SubkeyRole::PrefsSyncId.role_str(), b"prefs-sync-id");
    }

    #[test]
    fn themes_sync_id_role_string_matches_spec_registry() {
        // MYND-486 registry entry "myne.v0.1 themes-sync-id" (§3.4;
        // sync-protocol.md §10.x). Derives vault.themes' reserved 16-byte
        // sync blob-id; drift silently splits vault.themes into a second
        // sync record on every existing account.
        assert_eq!(SubkeyRole::ThemesSyncId.role_str(), b"themes-sync-id");
    }

    #[test]
    fn custom_themes_key_role_string_matches_spec_registry() {
        // MYND-486 registry entry "myne.v0.1 custom-themes-key" (§ 9.21).
        // Frozen + load-bearing: drift silently changes the vault.themes KEK.
        assert_eq!(SubkeyRole::CustomThemesKey.role_str(), b"custom-themes-key");
    }

    #[test]
    fn graph_layout_key_role_string_matches_spec_registry() {
        // Registry entry "myne.v0.1 graph-layout-key" (§3.4; §9.19). KEK for
        // the vault.graph layout cache; drift silently changes the KEK.
        assert_eq!(SubkeyRole::GraphLayoutKey.role_str(), b"graph-layout-key");
    }

    #[test]
    fn membership_key_role_string_matches_spec_registry() {
        // Registry entry "myne.v0.2 membership-key" (§3.4; §9.3.1). KEK for the
        // sealed vault membership field; drift silently changes the KEK.
        assert_eq!(SubkeyRole::MembershipKey.role_str(), b"membership-key");
    }

    #[test]
    fn group_only_role_strings_match_the_spec_registry() {
        // The five roles that exist ONLY in the group tier, and therefore have no
        // `SubkeyRole` counterpart to be pinned beside: `subkey.rs`'s one-test-per-role
        // convention was written for the root tier, so these had no string pin at all
        // until this test. They need one for the reason every other role does: the role
        // string IS the HKDF `info`, so a one-character drift silently derives a
        // different key for a family whose blobs then stop opening, and a copy-paste of
        // a neighbouring arm silently makes two families share one key.
        //
        // `roster-key` / `member-names-key` / `member-names-sync-id` are `NTV6`-only
        // group-tier roles (§3.4, §9.3.2, §9.29); `device-binding-key` and
        // `device-binding-sync-id` are the `member-devices` family's (§9.30). Each of the
        // last four differs only by a hyphen or a suffix from a neighbour, which is
        // exactly the shape a hand edit gets wrong.
        assert_eq!(GroupRole::GroupRosterKey.role_str(), b"group-roster-key");
        assert_eq!(GroupRole::MemberNamesKey.role_str(), b"member-names-key");
        assert_eq!(
            GroupRole::MemberNamesSyncId.role_str(),
            b"member-names-sync-id"
        );
        assert_eq!(
            GroupRole::DeviceBindingKey.role_str(),
            b"device-binding-key"
        );
        assert_eq!(
            GroupRole::DeviceBindingSyncId.role_str(),
            b"device-binding-sync-id"
        );
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
    fn v0_2_subkey_differs_from_v0_1_same_role_same_root() {
        // §10.5 context-separation: the SAME role under the SAME root_key derives
        // DIFFERENT bytes across major versions, because the context prefix differs
        // ("myne.v0.1 " vs "myne.v0.2 "). This is what makes the whole-vault re-key
        // (§10.4.1) a genuinely independent hierarchy, not a re-label.
        let root = [0x5Au8; 32];
        for role in SubkeyRole::ALL {
            assert_ne!(
                *derive_subkey(&root, role),
                *derive_subkey_v0_2(&root, role),
                "v0.1 and v0.2 subkeys collided for role {role:?}"
            );
        }
        // And the v0.2 helper is exactly `"myne.v0.2 " || role` (no separator).
        let manual = derive_with_context(&root, b"myne.v0.2 itemsKey-wrap");
        assert_eq!(
            *manual,
            *derive_subkey_v0_2(&root, SubkeyRole::ItemsKeyWrap)
        );
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
    /// The 48 cases cover the v0.1 input space. Every case before the eight
    /// appends shares its root with a sibling role, which is what the
    /// independence argument below rests on; the eight appends do NOT, so they
    /// are pinned as single inputs and the argument deliberately excludes them.
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
    /// - 2 `VaultIndicesKey` (MYND-271, §9.8): all-zero root + the alpha
    ///   pseudorandom root (the latter carries `informational_info_utf8_hex`
    ///   for the canonical `"myne.v0.1 vault-indices-key"` info assembly) —
    ///   the `vault.indices` KEK, pinned in lockstep with the `vault-indices`
    ///   family; distinct from `search-index-key` (one KEK per blob family).
    /// - 2 `PersonalDictKey` (MYND-266, §9.13): all-zero root + the alpha
    ///   pseudorandom root (the latter carries `informational_info_utf8_hex`
    ///   for the canonical `"myne.v0.1 personal-dictionary-key"` info assembly) —
    ///   the `vault.dictionary` KEK, pinned in lockstep with the
    ///   `vault-dictionary` family; distinct from the AAD role
    ///   `personal-dictionary-blob`.
    /// - 18 further roles, each as a {all-zero, alpha} pair, appended one
    ///   feature at a time rather than as one block: `CatalogSyncId`,
    ///   `PrefsSyncId`, `CustomThemesKey`, `ThemesSyncId`, `GraphLayoutKey`,
    ///   `AttachmentTextKey`, `AiEmbeddingsKey`, `VaultHeadMac` and
    ///   `ServerAuth`. The alpha half of each carries
    ///   `informational_info_utf8_hex`, which is where the nine canonical info
    ///   assemblies are documented for porters. The list above is grouped by
    ///   feature rather than partitioned, so every group is named in ONE sum to
    ///   make the 48 reconcile: 4 baseline + 6 pseudorandom + 2 search + 4
    ///   attachments + 2 session-state + 2 vault-indices + 2 personal-dictionary
    ///   + 18 (the nine pairs above) + 8 single-input = 48.
    /// - 8 single-input roles: the `chats-*` family (MYM1 / MYJ1, myne-md/myne#675)
    ///   and the `agent-*` family (MYN1 / MYX1 / MYZ1, myne-md/myne#697), each
    ///   under the shared `chats_agent_root` (`0x42` repeated). These append
    ///   LAST, in the order their features landed, because that is the order
    ///   the companion file carries them; all carry
    ///   `informational_info_utf8_hex`.
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
                SubkeyRole::VaultIndicesKey => "vault-indices-key",
                SubkeyRole::VaultHeadMac => "vault-head-mac",
                SubkeyRole::ServerAuth => "server-auth",
                SubkeyRole::AttachmentTextKey => "attachment-text-key",
                SubkeyRole::AiEmbeddingsKey => "ai-embeddings-key",
                SubkeyRole::CatalogSyncId => "catalog-sync-id",
                SubkeyRole::PrefsSyncId => "prefs-sync-id",
                SubkeyRole::CustomThemesKey => "custom-themes-key",
                SubkeyRole::ThemesSyncId => "themes-sync-id",
                SubkeyRole::GraphLayoutKey => "graph-layout-key",
                SubkeyRole::ChatsCatalogKey => "chats-catalog-key",
                SubkeyRole::ChatsCatalogSyncId => "chats-catalog-sync-id",
                SubkeyRole::ChatsKey => "chats-key",
                SubkeyRole::MembershipKey => "membership-key",
                SubkeyRole::AgentMemoryCatalogKey => "agent-memory-catalog-key",
                SubkeyRole::AgentMemoryCatalogSyncId => "agent-memory-catalog-sync-id",
                SubkeyRole::AgentMemoryKey => "agent-memory-key",
                SubkeyRole::AgentPersonalityKey => "agent-personality-key",
                SubkeyRole::AgentPersonalitySyncId => "agent-personality-sync-id",
                SubkeyRole::PersonVaultCarrier => "person-vault-carrier",
                // v0.2-only roles never appear in the v0.1 category: its envelope
                // promises `"myne.v0.1 "` info bytes. Reaching this arm means a
                // v0.2-only role was added to the v0.1 case list, which is a bug.
                SubkeyRole::AwarenessRoomId | SubkeyRole::AwarenessKey => {
                    panic!("v0.2-only role reached the v0.1 hkdf-sha256 generator")
                }
            }
        }

        let zero_root: [u8; 32] = [0u8; 32];
        let ff_root: [u8; 32] = [0xFFu8; 32];
        let alpha = pseudorandom_root(b"myne-test-vectors-seed-v0.1.alpha");
        let beta = pseudorandom_root(b"myne-test-vectors-seed-v0.1.beta");
        let gamma = pseudorandom_root(b"myne-test-vectors-seed-v0.1.gamma");
        // The FOURTH root, whose bytes are `0x42` repeated. It is not a
        // `pseudorandom_root(...)` seed and it carries no prefix in its slugs:
        // the `chats-*` (myne-md/myne#675) and `agent-*` (myne-md/myne#697) roles
        // reached the companion fixture this way, and this emitter was not
        // extended at the time, so for two releases the documented regeneration
        // command below produced a 40-case document against a 48-case file. That
        // loss is LOUD rather than silent only because the runner pins
        // `SubkeyRole::ALL` by name; the emitter is what had to be right.
        //
        // It is named rather than inlined so the eight appends below say out loud
        // that they share one input, which is what makes the three
        // `*CatalogKey`/`*CatalogSyncId` pairs readable as domain-separation
        // pairs rather than as eight unrelated derivations.
        let chats_agent_root: [u8; 32] = [0x42; 32];

        type Case<'a> = (&'a str, &'a str, &'a [u8; 32], SubkeyRole, bool);
        let cases: [Case<'_>; 48] = [
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
            (
                "zero-root-vault-indices-key",
                "All-zero root_key with the VaultIndicesKey role (MYND-271, §9.8; design MYND-31). KEK for the vault.indices structured-metadata blob; role string 'vault-indices-key' (17 ASCII bytes). Pairs with the other zero-root vectors under the same trivial root — catches a role-confusion bug that would collapse the vault-indices lineage onto another role's info string (most importantly search-index-key, the structural sibling).",
                &zero_root,
                SubkeyRole::VaultIndicesKey,
                false,
            ),
            (
                "prn-alpha-vault-indices-key",
                "Pseudorandom alpha root with the VaultIndicesKey role. The informational_info_utf8_hex field carries the canonical 27-byte HKDF info bytes ('myne.v0.1 vault-indices-key') so independent implementers can verify the seventh registered role's info assembly without re-parsing the spec. NOTE: the HKDF role string 'vault-indices-key' is DISTINCT from the AAD role string 'vault-indices-blob' (aad_vault_indices_blob, ctx-aead vectors), AND distinct from search-index-key — vault.indices (structured metadata) and vault.search (BM25) are separate blob families.",
                &alpha,
                SubkeyRole::VaultIndicesKey,
                true,
            ),
            (
                "zero-root-personal-dictionary-key",
                "All-zero root_key with the PersonalDictKey role (MYND-266, §9.13). KEK for the vault.dictionary blob; role string 'personal-dictionary-key' (23 ASCII bytes). Pairs with the other zero-root vectors under the same trivial root — catches a role-confusion bug that would collapse the dictionary lineage onto another role's info string.",
                &zero_root,
                SubkeyRole::PersonalDictKey,
                false,
            ),
            (
                "prn-alpha-personal-dictionary-key",
                "Pseudorandom alpha root with the PersonalDictKey role. The informational_info_utf8_hex field carries the canonical 33-byte HKDF info bytes ('myne.v0.1 personal-dictionary-key') so independent implementers can verify the eighth registered role's info assembly without re-parsing the spec. NOTE: the HKDF role string 'personal-dictionary-key' is DISTINCT from the AAD role string 'personal-dictionary-blob' (aad_personal_dictionary_blob, ctx-aead vectors) — they are different load-bearing constants.",
                &alpha,
                SubkeyRole::PersonalDictKey,
                true,
            ),
            (
                "zero-root-attachment-text-key",
                "All-zero root_key with the AttachmentTextKey role (MYND-328, §9.15). KEK for the per-attachment MYE1 extracted-text cache blobs; role string 'attachment-text-key' (19 ASCII bytes). Pairs with the other zero-root vectors under the same trivial root — catches a role-confusion bug that would collapse the attachment-text lineage onto another role's info string.",
                &zero_root,
                SubkeyRole::AttachmentTextKey,
                false,
            ),
            (
                "prn-alpha-attachment-text-key",
                "Pseudorandom alpha root with the AttachmentTextKey role. The informational_info_utf8_hex field carries the canonical 29-byte HKDF info bytes ('myne.v0.1 attachment-text-key') so independent implementers can verify the ninth registered role's info assembly without re-parsing the spec. NOTE: the HKDF role string 'attachment-text-key' is DISTINCT from the AAD role string 'attachment-text-blob' (aad_attachment_text_blob, ctx-aead / aad-construction vectors) — they are different load-bearing constants. One KEK serves all attachment-text blobs; per-blob separation is via the attachment_id AAD binding, not a distinct subkey.",
                &alpha,
                SubkeyRole::AttachmentTextKey,
                true,
            ),
            (
                "zero-root-ai-embeddings-key",
                "All-zero root_key with the AiEmbeddingsKey role (MYND-453, §9.17). KEK for the vault.embeddings on-device AI embedding-index blob (MYR1); role string 'ai-embeddings-key' (17 ASCII bytes). Pairs with the other zero-root vectors under the same trivial root — catches a role-confusion bug that would collapse the ai-embeddings lineage onto another role's info string (most importantly vault-indices-key and search-index-key, its structural siblings).",
                &zero_root,
                SubkeyRole::AiEmbeddingsKey,
                false,
            ),
            (
                "prn-alpha-ai-embeddings-key",
                "Pseudorandom alpha root with the AiEmbeddingsKey role. The informational_info_utf8_hex field carries the canonical 27-byte HKDF info bytes ('myne.v0.1 ai-embeddings-key') so independent implementers can verify the tenth registered role's info assembly without re-parsing the spec. NOTE: the HKDF role string 'ai-embeddings-key' is DISTINCT from the AAD role string 'ai-embeddings-blob' (aad_ai_embeddings_blob, ctx-aead / aad-construction vectors), AND distinct from vault-indices-key / search-index-key — vault.embeddings (dense AI vectors), vault.indices (structured metadata), and vault.search (BM25) are separate blob families, one KEK each.",
                &alpha,
                SubkeyRole::AiEmbeddingsKey,
                true,
            ),
            (
                "zero-root-catalog-sync-id",
                "All-zero root_key with the CatalogSyncId role (MYND-468, §3.4; sync-protocol.md §8.1). Derives the reserved sync-plane blob-id of the vault.attachments catalog — the FIRST 16 BYTES of this 32-byte output are the id; role string 'catalog-sync-id' (15 ASCII bytes). An identifier derivation like attachments-id-hmac, NOT a KEK — the catalog KEK stays attachments-catalog-key. Pairs with the other zero-root vectors under the same trivial root.",
                &zero_root,
                SubkeyRole::CatalogSyncId,
                false,
            ),
            (
                "prn-alpha-catalog-sync-id",
                "Pseudorandom alpha root with the CatalogSyncId role. The informational_info_utf8_hex field carries the canonical 25-byte HKDF info bytes ('myne.v0.1 catalog-sync-id') so independent implementers can verify the eleventh registered role's info assembly without re-parsing the spec. Domain-separation triple with the alpha attachments-catalog-key and attachments-id-hmac vectors (same input_root_key_hex, three byte-different outputs): id derivation, catalog KEK, and attachment-id HMAC must never coincide.",
                &alpha,
                SubkeyRole::CatalogSyncId,
                true,
            ),
            (
                "zero-root-prefs-sync-id",
                "All-zero root_key with the PrefsSyncId role (MYND-478, §3.4; sync-protocol.md §10.2.1). Derives the reserved sync-plane blob-id of vault.prefs — the FIRST 16 BYTES of this 32-byte output are the id; role string 'prefs-sync-id' (13 ASCII bytes). An identifier derivation like catalog-sync-id, NOT a KEK — the prefs KEK stays prefs-key. Pairs with the other zero-root vectors under the same trivial root.",
                &zero_root,
                SubkeyRole::PrefsSyncId,
                false,
            ),
            (
                "prn-alpha-prefs-sync-id",
                "Pseudorandom alpha root with the PrefsSyncId role. The informational_info_utf8_hex field carries the canonical 23-byte HKDF info bytes ('myne.v0.1 prefs-sync-id') so independent implementers can verify the twelfth registered role's info assembly without re-parsing the spec. Domain-separation pair with the alpha prefs-key vector (same input_root_key_hex, byte-different outputs): the prefs blob-id derivation and the prefs KEK must never coincide — and with the alpha catalog-sync-id vector, the two singleton sync-id lineages must never coincide either.",
                &alpha,
                SubkeyRole::PrefsSyncId,
                true,
            ),
            (
                "zero-root-graph-layout-key",
                "All-zero root_key with the GraphLayoutKey role (§3.4; §9.19). KEK for the vault.graph knowledge-graph layout cache (MYG1); role string 'graph-layout-key' (16 ASCII bytes). root_key-derived (like prefs/search/indices/embeddings), a rebuildable cache — never synced, never backed up. Pairs with the other zero-root vectors under the same trivial root — catches a role-confusion bug that would collapse the graph-layout lineage onto another role's info string.",
                &zero_root,
                SubkeyRole::GraphLayoutKey,
                false,
            ),
            (
                "prn-alpha-graph-layout-key",
                "Pseudorandom alpha root with the GraphLayoutKey role. The informational_info_utf8_hex field carries the canonical 26-byte HKDF info bytes ('myne.v0.1 graph-layout-key') so independent implementers can verify the thirteenth registered role's info assembly without re-parsing the spec. NOTE: the HKDF role string 'graph-layout-key' is DISTINCT from the AAD role string 'graph-layout-blob' (aad_graph_layout_blob), AND distinct from its rebuildable-cache siblings search-index-key / vault-indices-key / ai-embeddings-key — vault.graph (layout), vault.search (BM25), vault.indices (metadata), vault.embeddings (AI vectors) are separate blob families, one KEK each.",
                &alpha,
                SubkeyRole::GraphLayoutKey,
                true,
            ),
            (
                "zero-root-vault-head-mac",
                "All-zero root_key with the VaultHeadMac role (MYND-416/417, §3.4; sync-protocol.md §3). HMAC key for the Phase 2 sync vault head — keys HMAC-SHA-256(key, head_mac_input) for the fork-consistency head and re-verifies the device-local MYH1 vault.head-state baseline; role string 'vault-head-mac' (14 ASCII bytes). NOT a blob KEK. Pairs with the other zero-root vectors under the same trivial root — catches a role-confusion bug that would collapse the head-MAC lineage onto a blob KEK's info string.",
                &zero_root,
                SubkeyRole::VaultHeadMac,
                false,
            ),
            (
                "prn-alpha-vault-head-mac",
                "Pseudorandom alpha root with the VaultHeadMac role. The informational_info_utf8_hex field carries the canonical 24-byte HKDF info bytes ('myne.v0.1 vault-head-mac') so independent implementers can verify this role's info assembly without re-parsing the spec. The vault-head / vault-head-state families consume this key transitively; this vector pins the derivation itself, so a port that drifts here fails at the derivation layer rather than deep inside a MAC comparison.",
                &alpha,
                SubkeyRole::VaultHeadMac,
                true,
            ),
            (
                "zero-root-server-auth",
                "All-zero root_key with the ServerAuth role (MYND-420, §3.4 + §11.1). The Phase 2 server-authentication secret proven to the sync server via SCRAM-SHA-256-PLUS at device-enroll and NEVER transmitted (the server stores only a StoredKey/ServerKey verifier); role string 'server-auth' (11 ASCII bytes). NOT a blob KEK. Pairs with the other zero-root vectors under the same trivial root.",
                &zero_root,
                SubkeyRole::ServerAuth,
                false,
            ),
            (
                "prn-alpha-server-auth",
                "Pseudorandom alpha root with the ServerAuth role. The informational_info_utf8_hex field carries the canonical 21-byte HKDF info bytes ('myne.v0.1 server-auth') so independent implementers can verify this role's info assembly without re-parsing the spec. The scram-auth family consumes this secret as its input_secret_hex; this vector pins where that secret comes from, closing the gap between the SCRAM vectors and the root_key.",
                &alpha,
                SubkeyRole::ServerAuth,
                true,
            ),
            (
                "zero-root-custom-themes-key",
                "All-zero root_key with the CustomThemesKey role (MYND-486, §3.4; §9.21.3). KEK for the vault.themes custom-theme store (MYT1); role string 'custom-themes-key' (17 ASCII bytes). root_key-derived so it is itemsKey-independent and survives an items-key rotation. Pairs with the other zero-root vectors under the same trivial root — catches a role-confusion bug that would collapse the custom-themes lineage onto another blob KEK's info string.",
                &zero_root,
                SubkeyRole::CustomThemesKey,
                false,
            ),
            (
                "prn-alpha-custom-themes-key",
                "Pseudorandom alpha root with the CustomThemesKey role. The informational_info_utf8_hex field carries the canonical 27-byte HKDF info bytes ('myne.v0.1 custom-themes-key') so independent implementers can verify this role's info assembly without re-parsing the spec. NOTE: the HKDF role string 'custom-themes-key' is DISTINCT from the AAD role string 'custom-themes-blob' (aad_custom_themes_blob, aad-construction vectors) and from the themes-sync-id identifier derivation — three different load-bearing strings in the same feature.",
                &alpha,
                SubkeyRole::CustomThemesKey,
                true,
            ),
            (
                "zero-root-themes-sync-id",
                "All-zero root_key with the ThemesSyncId role (MYND-486, §3.4; sync-protocol.md §10.2.2). Derives the reserved sync-plane blob-id of vault.themes — the FIRST 16 BYTES of this 32-byte output are the id; role string 'themes-sync-id' (14 ASCII bytes). An identifier derivation like catalog-sync-id / prefs-sync-id, NOT a KEK — the themes KEK stays custom-themes-key. Pairs with the other zero-root vectors under the same trivial root.",
                &zero_root,
                SubkeyRole::ThemesSyncId,
                false,
            ),
            (
                "prn-alpha-themes-sync-id",
                "Pseudorandom alpha root with the ThemesSyncId role. The informational_info_utf8_hex field carries the canonical 24-byte HKDF info bytes ('myne.v0.1 themes-sync-id') so independent implementers can verify this role's info assembly without re-parsing the spec. Domain-separation pair with the alpha custom-themes-key vector (same input_root_key_hex, byte-different outputs): the themes blob-id derivation and the themes KEK must never coincide — and with the alpha catalog-sync-id / prefs-sync-id vectors, the three singleton sync-id lineages must never coincide either.",
                &alpha,
                SubkeyRole::ThemesSyncId,
                true,
            ),
            // ---- the `chats-*` and `agent-*` appends -----------------------
            //
            // Eight cases, appended by their own features after this emitter was
            // last touched, all under the shared `chats_agent_root` above. The
            // slug carries no root prefix, deliberately: these are the
            // single-input roles of their families, not a `zero-root` /
            // `prn-alpha` pair, and naming them `zero-root-chats-key` would
            // claim an input this file does not use.
            (
                "chats-catalog-key",
                "KEK for the vault.chats conversations catalog (MYM1, §9.23). DISTINCT from the AAD role chats-catalog and from the per-file family KEK chats-key.",
                &chats_agent_root,
                SubkeyRole::ChatsCatalogKey,
                true,
            ),
            (
                "chats-catalog-sync-id",
                "Phase-2 sync blob-id of vault.chats (§3.4 + sync-protocol.md §10.2.5): the FIRST 16 BYTES of the 32-byte output are the id; an IDENTIFIER derivation like catalog-sync-id, NOT a KEK (the catalog KEK stays chats-catalog-key).",
                &chats_agent_root,
                SubkeyRole::ChatsCatalogSyncId,
                true,
            ),
            (
                "chats-key",
                "KEK for every per-conversation chats file (MYJ1, §9.24): one KEK serves the family, the per-entry conversation_id travels in the AAD (the MYE1 archetype). DISTINCT from the AAD role chats-blob and from the catalog KEK chats-catalog-key.",
                &chats_agent_root,
                SubkeyRole::ChatsKey,
                true,
            ),
            (
                "agent-memory-catalog-key",
                "KEK for the vault.agent-memory catalog (MYN1, §9.25). DISTINCT from the AAD role agent-memory-catalog and from the per-file family KEK agent-memory-key.",
                &chats_agent_root,
                SubkeyRole::AgentMemoryCatalogKey,
                true,
            ),
            (
                "agent-memory-catalog-sync-id",
                "Sync blob-id derivation for vault.agent-memory (identifier, NOT key material).",
                &chats_agent_root,
                SubkeyRole::AgentMemoryCatalogSyncId,
                true,
            ),
            (
                "agent-memory-key",
                "Family KEK for the per-entry MYX1 memory blobs; per-entry separation comes from the AAD binding.",
                &chats_agent_root,
                SubkeyRole::AgentMemoryKey,
                true,
            ),
            (
                "agent-personality-key",
                "KEK for the vault.personality singleton (MYZ1, §9.27).",
                &chats_agent_root,
                SubkeyRole::AgentPersonalityKey,
                true,
            ),
            (
                "agent-personality-sync-id",
                "Sync blob-id derivation for vault.personality (identifier, NOT key material).",
                &chats_agent_root,
                SubkeyRole::AgentPersonalitySyncId,
                true,
            ),
        ];

        let mut dump = alloc::string::String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"hkdf-sha256\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §3.2 + §3.4\",\n");
        dump.push_str("  \"description\": \"Pins protocol::derive_subkey byte mapping for cross-implementation conformance. Each case fixes a (root_key, role) input pair under HKDF-SHA-256 with salt=zero_32 and info='myne.v0.1 '||role, and the 32-byte subkey the helper must produce. Role registry mirrors the type-safe Rust SubkeyRole enum (spec §3.4); v0.1 registers itemsKey-wrap + prefs-key + search-index-key + attachments-catalog-key + attachments-id-hmac + session-state-key + personal-dictionary-key + vault-indices-key + vault-head-mac + server-auth + attachment-text-key + ai-embeddings-key + catalog-sync-id + prefs-sync-id + custom-themes-key + themes-sync-id + graph-layout-key + chats-catalog-key + chats-catalog-sync-id + chats-key + agent-memory-catalog-key + agent-memory-catalog-sync-id + agent-memory-key + agent-personality-key + agent-personality-sync-id. MembershipKey derives under the v0.2 prefix and is pinned by the hkdf-sha256/v0.2 category instead. Vectors generated by `cargo test -p protocol --lib emit_subkey_vectors_for_paste -- --ignored` (in protocol/src/subkey.rs).\",\n");
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

    /// Emit the v0.2 `hkdf-sha256` vectors for paste into the companion repo
    /// (`vectors/hkdf-sha256/v0.2/cases.json`).
    ///
    /// The membership KEK derives under the v0.2 context prefix
    /// (`derive_subkey_v0_2`, info `'myne.v0.2 membership-key'`), so it cannot
    /// live in the v0.1 category, whose envelope promises v0.1 info bytes.
    /// Same zero/alpha roots as the v0.1 family for cross-version eyeballing.
    /// Run: `cargo test -p protocol --lib emit_subkey_v0_2_vectors_for_paste -- --ignored`
    #[test]
    #[ignore]
    fn emit_subkey_v0_2_vectors_for_paste() {
        extern crate std;
        use sha2::Digest;

        fn pseudorandom_root(label: &[u8]) -> [u8; 32] {
            let digest = sha2::Sha256::digest(label);
            let mut out = [0u8; 32];
            out.copy_from_slice(&digest);
            out
        }

        let zero_root: [u8; 32] = [0u8; 32];
        let alpha = pseudorandom_root(b"myne-test-vectors-seed-v0.1.alpha");

        let cases: [(&str, &str, &[u8; 32], bool, SubkeyRole); 8] = [
            (
                "zero-root-membership-key",
                "All-zero root_key with the MembershipKey role (§3.4; §9.3.1). KEK for the sealed vault membership field (the account/vault split, decisions.md 2026-09-07); role string 'membership-key' (14 ASCII bytes). Derived under the v0.2 context prefix because the field is NTV5-only: info is 'myne.v0.2 membership-key' (24 bytes). root_key-derived (like prefs/search/workspace), so it is itemsKey-independent. Pairs with the alpha vector under the same derivation: the two must differ only by root.",
                &zero_root,
                false,
                SubkeyRole::MembershipKey,
            ),
            (
                "prn-alpha-membership-key",
                "Pseudorandom alpha root with the MembershipKey role. The informational_info_utf8_hex field carries the canonical 24-byte HKDF info bytes ('myne.v0.2 membership-key') so independent implementers can verify this role's info assembly without re-parsing the spec. NOTE: the HKDF role string 'membership-key' is DISTINCT from the AAD role string 'membership-blob' (aad_membership_blob): two different load-bearing strings in the same feature.",
                &alpha,
                true,
                SubkeyRole::MembershipKey,
            ),
            (
                "zero-root-person-vault-carrier",
                "All-zero root_key with the PersonVaultCarrier role (§3.4; myne-md/myne#792). KEK for the device-local, vault-bound person-identity carrier (device-local, `<app_config_dir>/person-vault-carriers/<vault_id_hex>.json`), which seals the person keypair under the owner root_key so an NTV6 owner-vault unlock installs the person session without the recovery phrase; role string 'person-vault-carrier' (20 ASCII bytes). info is 'myne.v0.2 person-vault-carrier'. Root-derived and owner-only (a member holds no root_key); never synced. Pairs with the alpha vector under the same derivation: the two must differ only by root.",
                &zero_root,
                false,
                SubkeyRole::PersonVaultCarrier,
            ),
            (
                "prn-alpha-person-vault-carrier",
                "Pseudorandom alpha root with the PersonVaultCarrier role. The informational_info_utf8_hex field carries the canonical 30-byte HKDF info bytes ('myne.v0.2 person-vault-carrier') so independent implementers can verify this role's info assembly without re-parsing the spec. NOTE: the HKDF role string 'person-vault-carrier' is DISTINCT from the AAD role string 'person-vault-carrier-blob' (aad_person_vault_carrier): two different load-bearing strings in the same feature.",
                &alpha,
                true,
                SubkeyRole::PersonVaultCarrier,
            ),
            (
                "zero-root-awareness-room-id",
                "All-zero root_key with the AwarenessRoomId role (§3.4; live-collab). Derives an identifier, NOT key material: the per-note awareness room id sent to the relay is HMAC-SHA-256(DeriveSubkey_v0_2(root_key, 'awareness-room-id'), note_uuid)[0..16]. info is 'myne.v0.2 awareness-room-id'. Pairs with the alpha vector under the same derivation: the two differ only by root. NOTE: the HKDF role string 'awareness-room-id' is DISTINCT from the AAD role string 'awareness-frame' (aad_awareness_frame).",
                &zero_root,
                false,
                SubkeyRole::AwarenessRoomId,
            ),
            (
                "prn-alpha-awareness-room-id",
                "Pseudorandom alpha root with the AwarenessRoomId role. The informational_info_utf8_hex field carries the canonical HKDF info bytes ('myne.v0.2 awareness-room-id') so independent implementers can verify this role's info assembly without re-parsing the spec.",
                &alpha,
                true,
                SubkeyRole::AwarenessRoomId,
            ),
            (
                "zero-root-awareness-key",
                "All-zero root_key with the AwarenessKey role (§3.4; live-collab). KEK for the ephemeral, wire-only awareness frames. info is 'myne.v0.2 awareness-key'. Group counterpart GroupRole::AwarenessKey so a member removal rotates it with the group key.",
                &zero_root,
                false,
                SubkeyRole::AwarenessKey,
            ),
            (
                "prn-alpha-awareness-key",
                "Pseudorandom alpha root with the AwarenessKey role. The informational_info_utf8_hex field carries the canonical HKDF info bytes ('myne.v0.2 awareness-key') so independent implementers can verify this role's info assembly without re-parsing the spec.",
                &alpha,
                true,
                SubkeyRole::AwarenessKey,
            ),
        ];

        let mut dump = alloc::string::String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"hkdf-sha256\",\n");
        dump.push_str("  \"protocol_version\": \"v0.2\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §3.2 + §3.4 + §10.7\",\n");
        dump.push_str("  \"description\": \"Pins protocol::derive_subkey_v0_2 byte mapping for the v0.2 context prefix (info='myne.v0.2 '||role): the membership KEK (its field is NTV5-only), the device-local vault-bound PersonVaultCarrier KEK (myne-md/myne#792), and the two live-collaboration awareness roles awareness-room-id and awareness-key (live-collab). Vectors generated by `cargo test -p protocol --lib emit_subkey_v0_2_vectors_for_paste -- --ignored` (in protocol/src/subkey.rs).\",\n");
        dump.push_str("  \"cases\": [\n");

        for (i, (slug, desc, root, include_info, role)) in cases.iter().enumerate() {
            let subkey = derive_subkey_v0_2(root, *role);

            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"hkdf-sha256/v0.2/{}\",\n",
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
                core::str::from_utf8(role.role_str()).expect("role str is ASCII")
            ));
            if *include_info {
                let mut info = alloc::vec::Vec::new();
                info.extend_from_slice(HKDF_PREFIX_V0_2);
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

        std::fs::write("/tmp/myne_hkdf_sha256_v0_2_vectors.json", dump.as_bytes())
            .expect("write hkdf v0.2 vectors dump");
    }

    #[test]
    fn owner_and_group_derivation_are_type_and_domain_separated() {
        let owner_root = OwnerKey::new([0x11; 32]);
        let group_key = GroupKey::new([0x11; 32]);

        let owner_wrap = derive_owner_subkey_v0_2(&owner_root, OwnerRole::GroupKeyWrap);
        let group_wrap = derive_group_subkey_v0_2(&group_key, GroupRole::ItemsKeyWrap);

        assert_ne!(*owner_wrap, *group_wrap);
    }

    #[test]
    fn awareness_roles_are_v0_2_only_and_dual_tier() {
        // The two live-collaboration awareness roles derive under the v0.2
        // prefix, differ from each other, and differ from their un-migrated
        // v0.1 namesake (context separation). Each maps to a group counterpart,
        // so a member addresses the same room and seals the same frames, and a
        // group key still cannot derive an owner-only role.
        let root = [0x5Au8; 32];
        let group = GroupKey::new([0x5Au8; 32]);

        let room_id = derive_subkey_v0_2(&root, SubkeyRole::AwarenessRoomId);
        let frame_key = derive_subkey_v0_2(&root, SubkeyRole::AwarenessKey);
        assert_ne!(*room_id, *frame_key, "id and KEK must be domain-separated");
        assert_ne!(
            *room_id,
            *derive_subkey(&root, SubkeyRole::AwarenessRoomId),
            "a v0.2 subkey must differ from its v0.1 namesake under the same root"
        );

        assert_eq!(
            SubkeyRole::AwarenessRoomId.shared_group_role(),
            Some(GroupRole::AwarenessRoomId)
        );
        assert_eq!(
            SubkeyRole::AwarenessKey.shared_group_role(),
            Some(GroupRole::AwarenessKey)
        );

        let group_room_id = derive_group_subkey_v0_2(&group, GroupRole::AwarenessRoomId);
        let group_frame_key = derive_group_subkey_v0_2(&group, GroupRole::AwarenessKey);
        assert_ne!(*group_room_id, *group_frame_key);

        assert_eq!(
            SubkeyRole::ServerAuth.shared_group_role(),
            None,
            "an owner-only role must still refuse the group tier"
        );
    }

    #[test]
    fn typed_role_registries_are_exhaustive_and_disjoint() {
        fn owner_role_index(role: OwnerRole) -> usize {
            match role {
                OwnerRole::GroupKeyWrap => 0,
                OwnerRole::ServerAuth => 1,
                OwnerRole::MembershipKey => 2,
                OwnerRole::VaultHeadMac => 3,
                OwnerRole::AiEmbeddingsKey => 4,
                OwnerRole::ChatsCatalogKey => 5,
                OwnerRole::ChatsCatalogSyncId => 6,
                OwnerRole::ChatsKey => 7,
                OwnerRole::AgentMemoryCatalogKey => 8,
                OwnerRole::AgentMemoryCatalogSyncId => 9,
                OwnerRole::AgentMemoryKey => 10,
                OwnerRole::AgentPersonalityKey => 11,
                OwnerRole::AgentPersonalitySyncId => 12,
                OwnerRole::PersonVaultCarrier => 13,
            }
        }

        fn group_role_index(role: GroupRole) -> usize {
            match role {
                GroupRole::ItemsKeyWrap => 0,
                GroupRole::PrefsKey => 1,
                GroupRole::SearchIndexKey => 2,
                GroupRole::AttachmentsCatalogKey => 3,
                GroupRole::AttachmentsIdHmac => 4,
                GroupRole::SessionStateKey => 5,
                GroupRole::PersonalDictKey => 6,
                GroupRole::VaultIndicesKey => 7,
                GroupRole::AttachmentTextKey => 8,
                GroupRole::CatalogSyncId => 9,
                GroupRole::PrefsSyncId => 10,
                GroupRole::CustomThemesKey => 11,
                GroupRole::ThemesSyncId => 12,
                GroupRole::GraphLayoutKey => 13,
                GroupRole::GroupRosterKey => 14,
                GroupRole::AwarenessRoomId => 15,
                GroupRole::AwarenessKey => 16,
                GroupRole::MemberNamesKey => 17,
                GroupRole::MemberNamesSyncId => 18,
                GroupRole::DeviceBindingKey => 19,
                GroupRole::DeviceBindingSyncId => 20,
            }
        }

        let mut owner_seen = [false; OwnerRole::ALL.len()];
        for role in OwnerRole::ALL {
            let index = owner_role_index(role);
            assert!(!owner_seen[index]);
            owner_seen[index] = true;
        }
        assert!(owner_seen.into_iter().all(core::convert::identity));

        let mut group_seen = [false; GroupRole::ALL.len()];
        for role in GroupRole::ALL {
            let index = group_role_index(role);
            assert!(!group_seen[index]);
            group_seen[index] = true;
        }
        assert!(group_seen.into_iter().all(core::convert::identity));

        // Every role string is distinct, in BOTH typed tiers, for the same reason
        // `all_covers_every_registered_role` asserts it over `SubkeyRole`: the role
        // string is the whole of the HKDF `info` past the prefix, so two roles sharing
        // one string derive ONE key and the domain separation the registries exist to
        // provide is gone.
        //
        // The `declaration_index` bijection asserted above is NOT the same property and
        // does not imply it: that proves each variant has its own INDEX in a hand-written
        // match, while nothing compared the strings those variants actually derive from.
        // Measured, not assumed: with the two loops below removed, changing
        // `ROLE_STR_DEVICE_BINDING_KEY` to `b"member-names-key"` left the whole test file
        // green (30 passed), which would have sealed `vault.device-bindings` and
        // `vault.member-names` under one key with no test, guard or build saying a word.
        for (i, a) in OwnerRole::ALL.iter().enumerate() {
            for b in OwnerRole::ALL.iter().skip(i + 1) {
                assert_ne!(
                    a.role_str(),
                    b.role_str(),
                    "{a:?} and {b:?} share a role string, so the domain separation is lost"
                );
            }
        }
        for (i, a) in GroupRole::ALL.iter().enumerate() {
            for b in GroupRole::ALL.iter().skip(i + 1) {
                assert_ne!(
                    a.role_str(),
                    b.role_str(),
                    "{a:?} and {b:?} share a role string, so the domain separation is lost"
                );
            }
        }
    }
}
