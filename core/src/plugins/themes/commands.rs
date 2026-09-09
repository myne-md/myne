// SPDX-License-Identifier: AGPL-3.0
//! `themes` Tauri command handlers + pure cores (MYND-486).
//!
//! The vault-content custom-theme store: an encrypted `vault.themes` (`MYT1`)
//! singleton holding a `{theme_name → `[`ThemeEntry`]`}` map — a palette plus
//! the per-name wall clocks the sync merge reconciles on. Every command is
//! `Slot::Unlocked`-gated and derives its KEK from the unlocked vault's
//! `root_key` via `SubkeyRole::CustomThemesKey`; the `account_number_hash` that
//! binds the blob AAD is re-read from `vault.meta` per call (Slot stays
//! crypto-state-only, mirroring `prefs` / `spell`).
//!
//! Split like the protocol crate's `_raw`/convenience pair — the **pure
//! `*_in_dir` cores** take the derived KEK + account-hash directly (fully
//! unit-testable against a `ScopedTempDir`); the thin `*_with_dir` wrappers
//! fetch `root_key`/hash from the unlocked `VaultRuntimeState`; the
//! `#[tauri::command]` wrappers resolve the active vault dir. Any failure on read
//! collapses to the empty theme store (fall-back-to-empty, § 9.21.4).
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

use super::error::ThemesError;
use crate::host::HostCtx;
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use protocol::{
    decode_themes_blob, derive_subkey_versioned, encode_themes_blob_versioned, meta_version_of,
    parse_vault_meta_any, MetaVersion, SubkeyRole, AEAD_KEY_LEN, VAULT_META_ACCOUNT_HASH_LEN,
};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::OnceLock;
// Tauri types are needed only by the cfg-gated wrappers below, so the import is
// gated the same way — otherwise a `--no-default-features` build fails on an
// unused import of a dependency that is not there.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use crate::host::tauri_host::TauriHost;
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use tauri::{AppHandle, Runtime, State};
use theme_validator::validate_theme_for_import;
use tokio::sync::Mutex;

/// Build-time coupling guard: the `vault.meta` account-hash field and the
/// themes blob's AAD account-hash are the same 16-byte field.
const _: () = assert!(VAULT_META_ACCOUNT_HASH_LEN == protocol::THEMES_BLOB_ACCOUNT_HASH_LEN);

/// One custom theme's palette: a flat map of CSS-variable token → value. The
/// `BTreeMap` ordering makes the inner JSON deterministic on re-encode.
pub type ThemePalette = BTreeMap<String, String>;

/// One entry in the custom-theme store: a palette plus the wall-clock fields
/// the sync merge reconciles on (MYND-486).
///
/// The clocks exist so `vault.themes` can be merged **per theme name** rather
/// than whole-map-LWW: device A's "Nord" and device B's "Solarized" both
/// survive a concurrent add, and only a same-name concurrent edit falls to LWW
/// (a palette is one coherent design, so it is LWW **within** a name — never
/// merged token-by-token). See [`merge_custom_themes`] for the rule table.
///
/// [`merge_custom_themes`]: crate::plugins::sync::conflict::merge_custom_themes
///
/// Field order is **alphabetical by declaration** so `serde_json` emits
/// lexicographic keys — the canonical-JSON key ordering the sibling
/// `AttachmentMeta` follows, which keeps the sealed plaintext byte-stable for
/// a given logical store.
///
/// Clock honesty (`sync-protocol.md` §11.4, inherited verbatim from the
/// catalog): these are client wall-clocks from different devices; skew can make
/// the "wrong" side win a revival or edit race. Deterministic convergence is the
/// contract, not clock truth.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ThemeEntry {
    /// Import timestamp — UNIX seconds. Compared against a tombstone's
    /// `deleted_at` by the merge's resurrection guard: a live entry survives a
    /// tombstone only when this **strictly** postdates it (a deliberate re-add).
    pub created_at: u64,
    /// Deletion timestamp — UNIX seconds, **optional**. Presence turns the
    /// entry into a **themes tombstone**: the multi-device deletion marker that
    /// stops a peer's stale live copy from resurrecting the theme. The palette
    /// is scrubbed at delete time (see [`ThemeEntry::into_tombstone`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<u64>,
    /// The theme's CSS-variable palette. Empty on a tombstone.
    pub palette: ThemePalette,
    /// Last-edit timestamp — UNIX seconds. Now only a **tie-break** discriminator
    /// for a same-`version` concurrent edit (greater wins); the primary key is
    /// `version`. Equals `created_at` on a fresh import; re-importing the same
    /// name bumps it.
    pub updated_at: u64,
    /// Causal merge counter — the **primary key** of the sync merge join
    /// (`sync-protocol.md` §10.2.2, myne-md/myne#405). Bumped to
    /// `max(versions observed for this name) + 1` on any local mutation; the
    /// greater `version` wins a reconcile, and the wall-clock fields above only
    /// break an equal-`version` tie. Absent on a legacy (pre-#405) blob → 0,
    /// repaired on the first clocked write; an additive optional field
    /// (`#[serde(default)]`, skipped when 0), so a legacy blob stays
    /// byte-identical. Declared last to keep canonical (alphabetical) key order.
    #[serde(default, skip_serializing_if = "is_zero_u64")]
    pub version: u64,
}

/// `#[serde(skip_serializing_if)]` predicate: omit a `version` of 0 so a
/// legacy (pre-#405) entry re-encodes byte-identically and a fresh field stays
/// compact.
fn is_zero_u64(v: &u64) -> bool {
    *v == 0
}

/// One **live** theme as the list surface hands it out: the name plus the
/// palette the store already had decoded in hand.
///
/// The list returns palettes rather than bare names because the store is a
/// SINGLE blob: [`read_themes_map_in_dir`] decrypts `vault.themes` and decodes
/// every palette to answer a list at all. Returning names would throw those
/// palettes away and force the caller to buy each one back with a full
/// `read_account_number_hash` + `derive_subkey` + AEAD-open + whole-map JSON
/// parse — K+1 decrypts to render a K-row picker. The one-file-per-theme layout
/// this surface was born under is gone; the shape follows the storage.
///
/// The clocks are deliberately NOT here: they are sync-merge machinery
/// ([`ThemeEntry`]), not something a picker or an apply path has any use for.
///
/// Field order is **alphabetical by declaration**, the same canonical-JSON
/// discipline [`ThemeEntry`] follows.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ThemeListEntry {
    /// The theme's name — the store's map key, lifted into the entry.
    pub name: String,
    /// The theme's CSS-variable palette. Never empty (a scrubbed palette means
    /// a tombstone, and tombstones never reach this surface).
    pub palette: ThemePalette,
}

impl ThemeEntry {
    /// A live (non-tombstone) entry imported at `now` — a brand-new name, so its
    /// causal `version` starts at 1 (`max(∅) + 1`). The real upsert path
    /// ([`apply_import`]) computes `version` from the existing entry instead, so
    /// a revival/edit outranks its predecessor.
    pub fn live(palette: ThemePalette, now: u64) -> Self {
        Self {
            created_at: now,
            deleted_at: None,
            palette,
            updated_at: now,
            version: 1,
        }
    }

    /// Whether this entry is a themes tombstone.
    pub fn is_tombstone(&self) -> bool {
        self.deleted_at.is_some()
    }

    /// Convert this entry into its deletion tombstone: `deleted_at` set, the
    /// palette **scrubbed** so the synced store keeps nothing descriptive about
    /// a deleted theme (mirroring `AttachmentMeta::into_tombstone`).
    ///
    /// Scrubbing is a confidentiality measure, NOT a convergence one — it does
    /// not make two tombstones of the same name byte-identical, because
    /// `created_at` and `updated_at` survive it and can differ across devices.
    /// Commutativity is delivered by `merge_theme_entry`'s total-order
    /// tie-break, which compares every retained field.
    ///
    /// `created_at`/`updated_at` are retained; `version` is bumped
    /// (`self.version + 1`) because a delete is a mutation — the tombstone must
    /// outrank the live entry it replaces so a peer's stale live copy loses the
    /// merge (`sync-protocol.md` §10.2.2, myne-md/myne#405).
    pub fn into_tombstone(self, deleted_at: u64) -> Self {
        Self {
            created_at: self.created_at,
            deleted_at: Some(deleted_at),
            palette: ThemePalette::new(),
            updated_at: self.updated_at,
            version: self.version + 1,
        }
    }
}

/// The whole custom-theme store: `{theme_name → entry}`. `BTreeMap` so the
/// serialized `vault.themes` plaintext is byte-deterministic (name-sorted), the
/// canonical-serialization discipline the other vault singletons follow.
///
/// The map holds **tombstones alongside live entries** — the read-side cores
/// ([`themes_list_in_dir`] / [`themes_read_in_dir`]) filter them out. There is
/// no tombstone GC: a tombstone is a name plus a timestamp and themes number in
/// the single digits, so the map stays trivially small.
pub type ThemesMap = BTreeMap<String, ThemeEntry>;

/// Vault-relative filename of the themes singleton blob.
const THEMES_FILE: &str = "vault.themes";

/// Per-plugin write serialization. `OnceLock<Mutex<()>>` lazily initialized on
/// first write; every `themes_import` / `themes_delete` shares it so concurrent
/// read-modify-write mutations of the whole-map blob commit FIFO and never lose
/// an update. (Phase 1 single-window makes a real race unlikely; the mutex is
/// structural preparation, mirroring the `prefs` plugin.)
///
/// `pub` so the sync orchestrator's `vault.themes` phase holds it across its own
/// read-merge-write — exactly as the prefs/catalog phases hold their plugins'
/// (`sync_themes_phase`).
pub fn write_mutex() -> &'static Mutex<()> {
    static M: OnceLock<Mutex<()>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(()))
}

// The entry `created_at` / `updated_at` / `deleted_at` stamps come from
// `HostCtx::now_unix_secs()`, NOT from `SystemTime::now()` (phase3-web-client
// task 45). That call compiles for wasm32 and then PANICS — std has no wasm arm
// — and these are the §10.2 LWW field clocks the theme merge reconciles on, so a
// client that could not read a clock could not write a theme at all.
//
// The `sync-protocol.md` §11.4 clock-honesty caveat rides along unchanged:
// these are client wall-clocks from different devices, skew can decide a race,
// and deterministic convergence is the contract rather than clock truth.

/// Read `vault.meta` and return its `account_number_hash` (offset 6, 16 bytes),
/// used to build the themes-blob AAD per § 9.21.3.
async fn read_account_number_hash(
    io: &dyn crate::vault_io::VaultIo,
    vault_meta_path: &Path,
) -> Result<(MetaVersion, [u8; VAULT_META_ACCOUNT_HASH_LEN]), ThemesError> {
    let bytes = io
        .read(vault_meta_path)
        .await
        .map_err(|io_error_kind| ThemesError::Io { io_error_kind })?;
    let version = meta_version_of(&bytes).ok_or(ThemesError::InvalidVaultMeta)?;
    let meta = parse_vault_meta_any(&bytes).map_err(|_| ThemesError::InvalidVaultMeta)?;
    Ok((version, meta.account_number_hash))
}

/// Serialize a `{name → palette}` map to the deterministic-JSON inner plaintext
/// the `MYT1` blob wraps. `BTreeMap` iteration is name-sorted, and `serde_json`
/// preserves that order, so the bytes are stable for a given logical store.
fn serialize_themes_map(map: &ThemesMap) -> Result<Vec<u8>, ThemesError> {
    serde_json::to_vec(map).map_err(|_| ThemesError::Encode)
}

/// Deserialize the inner plaintext back into the map. A malformed payload
/// (should never happen for our own writes) collapses to the empty store.
fn deserialize_themes_map(plaintext: &[u8]) -> ThemesMap {
    serde_json::from_slice(plaintext).unwrap_or_default()
}

/// PURE CORE — seal `map` into the blob bytes for `version`'s family: `MYT1`
/// under the v0.1 AAD, `MYT5` under the v0.2 one (§10.4.1).
///
/// **The version is a parameter, not a default.** The KEK is already derived
/// version-aware by every caller, so an unversioned encode does not fail — it
/// stamps `MYT1` over a v0.2-derived key, which is self-inconsistent: the
/// magic tells the sniffing decoder to verify under the v0.1 AAD, that AEAD
/// check fails, and §9.21.4's fall-back-to-empty then reports the store as
/// simply having no themes. A migrated vault lost every custom theme on the
/// first theme edit that way.
pub fn encode_themes_map(
    version: MetaVersion,
    themes_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
    map: &ThemesMap,
) -> Result<Vec<u8>, ThemesError> {
    let plaintext = serialize_themes_map(map)?;
    encode_themes_blob_versioned(version, themes_key, account_number_hash, &plaintext)
        .map_err(|_| ThemesError::Encode)
}

/// PURE CORE — decode `bytes` (a `MYT1` blob, or `None` for an absent file)
/// into the map, collapsing ANY failure — absent / truncated / AEAD-fail /
/// unsupported-format / malformed inner JSON — to the empty store
/// (fall-back-to-empty, § 9.21.4). The `protocol::read_or_empty` analog for the
/// client-owned inner format: the sync phase decodes the *remote* blob with it,
/// so a hostile or corrupt remote store collapses to empty (and `merge(local,
/// empty) == local`, losing nothing).
pub fn decode_themes_map_or_empty(
    themes_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
    bytes: Option<&[u8]>,
) -> ThemesMap {
    bytes
        .and_then(|b| {
            decode_themes_blob(themes_key, account_number_hash, b)
                .ok()
                .map(|pt| deserialize_themes_map(&pt))
        })
        .unwrap_or_default()
}

// ---- pure `*_in_dir` cores (KEK + account-hash injected) ------------------

/// PURE CORE — read + decrypt `vault.themes` under `vault_dir` into the
/// `{name → palette}` map.
///
/// **Absent is not the same as unreadable (#255).** §9.21.4's fall-back-to-empty
/// is the right answer for an ABSENT blob: a vault with no custom themes has no
/// file, and the empty map is the fact, not a guess. It used to cover every
/// failure alike — so a blob that existed and could not be read this once
/// collapsed to empty, and the read-modify-writes below re-sealed that empty
/// over the user's themes. This one is worse than the dictionary's twin:
/// `vault.themes` IS synced, so the wipe propagates to every device.
///
/// `NotFound` → the empty map. Anything else is an error the caller must not
/// paper over with a write.
///
/// This is deliberately NOT [`decode_themes_map_or_empty`], which keeps
/// collapsing everything: that one decodes the REMOTE blob during sync, where
/// `merge(local, empty) == local` loses nothing and a hostile store must not be
/// able to fail the cycle.
pub async fn read_themes_map_in_dir(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
    themes_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
) -> Result<ThemesMap, ThemesError> {
    // Through the SINGLETON fallback, not a plain read (myne#301). `VaultIo::read`
    // answers with the newest STRUCTURALLY INTACT candidate — which on the web
    // client is the newest slot whose 8-byte generation stamp landed, torn
    // payload and all. A tear there made the whole theme store read as EMPTY
    // with a complete, verifiable copy sitting unread beside it, and the next
    // write targeted that intact slot. `vault.themes` is SYNCED, so the wipe
    // propagated. `open_newest` is the loop that exists so no reader has to
    // write "take the first" itself, and the caller's own decode is its verifier.
    //
    // Sweeping is deliberate here: once a candidate has actually decrypted, the
    // copies it superseded are litter rather than evidence.
    use crate::singleton::{open_newest_and_sweep, OpenOutcome};
    match open_newest_and_sweep(io, &vault_dir.join(THEMES_FILE), |bytes| {
        decode_themes_blob(themes_key, account_number_hash, bytes)
            .map(|pt| deserialize_themes_map(&pt))
    })
    .await
    {
        Ok(map) => Ok(map),
        // §9.21.4's fall-back-to-empty is the right answer for an ABSENT blob: a
        // vault with no custom themes has no file, and the empty map is the fact.
        Err(OpenOutcome::Absent) => Ok(ThemesMap::default()),
        Err(OpenOutcome::Io(io_error_kind)) => Err(ThemesError::Io { io_error_kind }),
        Err(OpenOutcome::Undecodable(_)) => {
            tracing::warn!(
                event = "themes_undecryptable",
                "vault.themes exists but no copy could be decrypted; refusing to treat it as empty"
            );
            Err(ThemesError::StoreUnreadable)
        }
    }
}

/// The newest copy of `vault.themes` that actually DECRYPTS, as raw bytes.
///
/// The sync phase needs the bytes rather than the map: it compares nonces, and
/// it pushes the blob verbatim. A plain `VaultIo::read` there answers with the
/// newest structurally intact candidate — so on the web client a torn slot was
/// read, its nonce taken as the local one, and the torn bytes PUSHED to the
/// server, where every peer decodes them to empty (myne#301).
///
/// `None` when no copy exists or none decrypts; the caller treats that the same
/// way it treats an absent store, which is the conservative direction — it
/// re-pushes the local map rather than adopting a store it could not read.
pub async fn read_verified_themes_bytes(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
    themes_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
) -> Option<Vec<u8>> {
    let candidates = io
        .read_candidates(&vault_dir.join(THEMES_FILE))
        .await
        .ok()?;
    candidates
        .into_iter()
        .find(|bytes| decode_themes_blob(themes_key, account_number_hash, bytes).is_ok())
}

/// PURE CORE — encrypt `map` to the `vault.themes` blob and atomically write it
/// under `vault_dir`. When `map` is empty, the file is removed (best-effort) so
/// an empty store leaves no file (fall-back-to-empty on read; byte-clean vault).
pub async fn write_themes_map_in_dir(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
    version: MetaVersion,
    themes_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
    map: &ThemesMap,
) -> Result<(), ThemesError> {
    let path = vault_dir.join(THEMES_FILE);
    if map.is_empty() {
        // Best-effort remove; absent == empty on read.
        let _ = io.remove_file(&path).await;
        return Ok(());
    }
    let blob = encode_themes_map(version, themes_key, account_number_hash, map)?;
    io.write(&path, &blob, crate::vault_io::WriteOpts::default())
        .await
        .map_err(|io_error_kind| ThemesError::Io { io_error_kind })?;
    Ok(())
}

// ---- what counts as "live" (one definition, both layers) -----------------
//
// A tombstoned entry is gone from the user's view even though its marker lives
// on to drive the sync merge (a dropped key would let a peer's still-live copy
// resurrect the theme). Both the pure `*_in_dir` cores and the `*_with_dir` IPC
// cores read liveness through these two helpers, so the rule cannot drift
// between the layers.

/// The value-shape allowlist, applied where a palette **leaves** the store
/// (myne#386).
///
/// **Why the read side and not just import.** The injection guard is the
/// primary control for this surface — the WebView CSP carries
/// `style-src 'unsafe-inline'`, so a theme value that reaches the DOM executes
/// — and [`validate_theme`] runs at exactly two call sites, both of them
/// import. `vault.themes` has **three** writers: import, the sync merge
/// ([`crate::plugins::sync::conflict::merge_custom_themes`] clones a peer's
/// entry verbatim, and the agreeing-store arm writes the server's bytes
/// unchanged), and a restored backup (a container member extracted
/// byte-identically). Two of the three never see the grammar, so
/// "every palette in the store is validated" was true only of palettes this
/// device imported. One check at the exit covers all three and every future
/// writer, which is what the crate's own doctrine asks for: a control that runs
/// on one of three producers is not an allowlist.
///
/// **Filter, do not reject.** A single off-grammar token from a peer must not
/// blank the theme picker on every other device, and a dropped token falls back
/// to the built-in value in `src/styles/tokens.css` — the same path a palette
/// that merely omits a token already takes. (Import rejects instead, correctly:
/// there is an author standing there to be told what was wrong. On read there
/// is no author.)
///
/// **This is the per-token grammar, not the whole of [`validate_theme`].** It
/// deliberately omits `parse_theme`'s `REQUIRED_KEYS` presence check, so a
/// filtered read can hand back a palette missing a required token — a shape
/// import can never produce. That is the intended trade: a partially-filtered
/// theme renders with built-in fallbacks, where rejecting the whole palette
/// would lose a theme the user can still see the name of.
fn vetted(palette: &ThemePalette) -> ThemePalette {
    palette
        .iter()
        // SAFETY (threat-model §149): the injection guard. A value here reaches
        // the DOM and executes. Never widen this.
        .filter(|(k, v)| theme_validator::is_allowed_key(k) && theme_validator::is_allowed_value(v))
        // The ornament layer's INTERNAL variables (`--_o-ceiling`, `--_o-strength`,
        // `--_o-frame`, …) are reachable by the key grammar — `_` is an allowed
        // character — and `applyCustomTheme` writes every `--*` key onto `:root`.
        // Today the cascade contains that (the consuming rules re-declare what
        // matters, and no allowed value is a valid <image> or <shadow>), but that
        // containment is an accident one refactor deep: hoisting `--_o-ceiling` to
        // `:root` would hand a theme the opacity ceiling it is bounded by. The
        // prefix is reserved here so the property is structural, not incidental.
        .filter(|(k, _)| !k.starts_with("--_"))
        // MEANING (myne#394): an ornament value a NEWER peer knows and this build
        // does not renders plain rather than failing. Widening this is free, and
        // keeping the two filters separate is what stops a compatibility
        // relaxation from reading like a security one.
        .filter(|(k, v)| theme_validator::is_known(k, v))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// The **live** entries in `map` — name + palette each, name-sorted, each
/// palette [`vetted`].
///
/// Ordering is inherited, not imposed: [`ThemesMap`] is a `BTreeMap`, so
/// iteration is already lexicographic by name and a filter/map preserves it. No
/// caller needs to re-sort.
fn live_entries(map: &ThemesMap) -> Vec<ThemeListEntry> {
    map.iter()
        .filter(|(_, e)| !e.is_tombstone())
        .map(|(name, e)| ThemeListEntry {
            name: name.clone(),
            palette: vetted(&e.palette),
        })
        .collect()
}

/// One **live** theme's [`vetted`] palette by name, or
/// [`ThemesError::NotFound`] — which a tombstoned name also yields (it reads as
/// absent).
/// A single live palette, vetted and **gated on readability** (myne#394).
///
/// The contrast gate runs HERE as well as at import, and the distinction between
/// this and [`themes_list_in_dir`] is the whole point: `read` is what an *apply*
/// goes through, `list` is what the picker goes through. Gating only import left
/// three populations permanently ungated — palettes sealed before the gate
/// existed, palettes arriving by sync from a device on an older build, and
/// palettes reinstated wholesale by a backup restore. `decisions.md` 2026-08-06
/// clause (e) says "refused at apply time", and this is what makes that true.
///
/// The picker is deliberately NOT gated: a peer's unreadable palette must still
/// be listed and nameable (so the user can delete it), and blanking the picker
/// over one bad entry is the failure the read path's filter-don't-reject rule
/// exists to prevent. Refusing at the moment of *use* is the narrowest place the
/// refusal can live.
fn live_palette(map: &ThemesMap, name: &str) -> Result<ThemePalette, ThemesError> {
    live_palette_gated(map, name, true)
}

/// [`live_palette`], with the readability gate optional.
///
/// **Export does not gate, and that is deliberate.** The contrast floor exists so
/// an unreadable palette cannot be WORN; it has nothing to say about whether the
/// user may have their file back. Routing export through the gated read made a
/// stored theme un-exportable — a grandfathered one, or one whose gated colour is
/// a bare keyword the gate refuses rather than skips — which is the one outcome
/// "you walk away with your files" does not permit. The user can still delete it,
/// still see it listed, and now still get it out; what they cannot do is apply it
/// (myne#394).
fn live_palette_gated(
    map: &ThemesMap,
    name: &str,
    gate_contrast: bool,
) -> Result<ThemePalette, ThemesError> {
    let palette = map
        .get(name)
        .filter(|e| !e.is_tombstone())
        .map(|e| vetted(&e.palette))
        .ok_or(ThemesError::NotFound)?;
    if gate_contrast {
        theme_validator::check_contrast(&palette)
            .map_err(|error| ThemesError::Invalid { error })?;
    }
    Ok(palette)
}

/// PURE CORE — the name-sorted list of **live** custom themes in the store,
/// each carrying the palette this read already decoded (see [`ThemeListEntry`]).
pub async fn themes_list_in_dir(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
    themes_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
) -> Result<Vec<ThemeListEntry>, ThemesError> {
    Ok(live_entries(
        &read_themes_map_in_dir(io, vault_dir, themes_key, account_number_hash).await?,
    ))
}

/// PURE CORE — one **live** theme's palette by name, or
/// [`ThemesError::NotFound`]. A tombstoned name reads as absent.
///
/// This is also the export core: a plaintext `.json` export reads exactly what
/// a read reads. The separately-grantable export *permission* lives at the IPC
/// boundary ([`themes_export_with_dir`] + its `allow-themes-export` ACL), which
/// is where the TB3 egress door is actually guarded — a duplicate pure-core
/// alias would add a second name without adding a second check.
///
/// One consequence of the read-side [`vetted`] filter (myne#386) belongs here
/// rather than only at the helper: because export and read are the same core,
/// an exported `.json` no longer round-trips a token a peer planted through the
/// sync merge. That is a behaviour change, and a small one downstream — the
/// `myne-themes` marketplace gate runs `theme-validator`'s own `validate`
/// binary over every submission — but it means an export is now the vetted
/// palette rather than the stored bytes.
pub async fn themes_read_in_dir(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
    themes_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
    name: &str,
) -> Result<ThemePalette, ThemesError> {
    live_palette(
        &read_themes_map_in_dir(io, vault_dir, themes_key, account_number_hash).await?,
        name,
    )
}

/// Apply an import of `palette` under `name` at `now` to an in-memory map.
///
/// - **new name** → a fresh live entry (`created_at` = `updated_at` = `now`).
/// - **existing live name** → replace-in-place: the palette and `updated_at`
///   move, `created_at` is retained (the theme's identity did not restart).
/// - **tombstoned name** → the deliberate **re-add**: a fresh live entry whose
///   `created_at` is `now`, clearing the tombstone. Its `version` is bumped past
///   the tombstone's (`max(observed) + 1`), so the revival — which observed the
///   delete — outranks it in the merge (`sync-protocol.md` §10.2.2,
///   myne-md/myne#405).
fn apply_import(map: &mut ThemesMap, name: &str, palette: ThemePalette, now: u64) {
    let prev = map.get(name);
    let created_at = match prev {
        Some(e) if !e.is_tombstone() => e.created_at,
        _ => now,
    };
    // Causal bump: max(version seen for this name) + 1 — new name → 1, an edit or
    // a revival outranks its predecessor (live or tombstone).
    let version = prev.map_or(0, |e| e.version) + 1;
    map.insert(
        name.to_string(),
        ThemeEntry {
            created_at,
            deleted_at: None,
            palette,
            updated_at: now,
            version,
        },
    );
}

/// Apply a delete of `name` at `now` to an in-memory map: the entry becomes a
/// **tombstone** (palette scrubbed, `deleted_at` set) rather than being dropped.
/// Dropping the key would let a peer's still-live copy resurrect the theme on
/// the next merge. Deleting an absent name is a no-op — a name that never
/// existed gets no marker; re-deleting an existing tombstone keeps the original
/// `deleted_at` (idempotent, no clock churn).
fn apply_delete(map: &mut ThemesMap, name: &str, now: u64) {
    match map.get(name) {
        Some(e) if e.is_tombstone() => {}
        Some(e) => {
            let tomb = e.clone().into_tombstone(now);
            map.insert(name.to_string(), tomb);
        }
        None => {}
    }
}

/// PURE CORE — validate `palette_json` through the shared value-shape allowlist,
/// upsert it under `name` (replace-in-place, else insert; a tombstone is cleared
/// — the deliberate re-add), and re-seal the blob. An invalid palette rejects
/// with [`ThemesError::Invalid`] BEFORE any write, so the on-disk store is
/// untouched. `now` is UNIX seconds, injected so the core stays pure.
// The vault's generation joins the KEK, the account hash and the palette on the
// parameter list; splitting them into a struct would hide which of them the
// caller is responsible for keeping consistent, which is the whole point here.
#[allow(clippy::too_many_arguments)]
pub async fn themes_import_in_dir(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
    version: MetaVersion,
    themes_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
    name: &str,
    palette_json: &str,
    now: u64,
) -> Result<(), ThemesError> {
    // The full import gate in one call (threat-model §149 injection guard, then
    // the WCAG floors). One entry point rather than two calls per site: composing
    // the pair by convention already failed once — the readability gate reached
    // only this function and not its sibling below, and every unit test stayed
    // green while the real command shipped unguarded (myne#394).
    let parsed =
        validate_theme_for_import(palette_json).map_err(|error| ThemesError::Invalid { error })?;
    let mut map = read_themes_map_in_dir(io, vault_dir, themes_key, account_number_hash).await?;
    apply_import(&mut map, name, parsed.vars, now);
    write_themes_map_in_dir(
        io,
        vault_dir,
        version,
        themes_key,
        account_number_hash,
        &map,
    )
    .await
}

/// PURE CORE — **tombstone** `name` in the store and re-seal the blob. Deleting
/// an absent name is a no-op success (idempotent). `now` is UNIX seconds,
/// injected so the core stays pure.
pub async fn themes_delete_in_dir(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
    version: MetaVersion,
    themes_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
    name: &str,
    now: u64,
) -> Result<(), ThemesError> {
    let mut map = read_themes_map_in_dir(io, vault_dir, themes_key, account_number_hash).await?;
    apply_delete(&mut map, name, now);
    write_themes_map_in_dir(
        io,
        vault_dir,
        version,
        themes_key,
        account_number_hash,
        &map,
    )
    .await
}

// ---- `*_with_dir` wrappers (fetch material from the unlocked slot) ---------

/// Read the `{name → palette}` map for the currently-unlocked vault. MUST be
/// called while `Slot::Unlocked`.
async fn read_themes_map_with_dir(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
    state: &VaultRuntimeState,
) -> Result<ThemesMap, ThemesError> {
    let (root_key, _vmh) = state
        .peek_unlocked_root_key_and_hash_clone()
        .await
        .ok_or(ThemesError::SlotNotUnlocked)?;
    let (meta_version, account_number_hash) =
        read_account_number_hash(io, &vault_dir.join("vault.meta")).await?;
    let themes_key = derive_subkey_versioned(meta_version, &root_key, SubkeyRole::CustomThemesKey);
    read_themes_map_in_dir(io, vault_dir, &themes_key, &account_number_hash).await
}

/// Shared read-modify-write core for the write commands (SYNC-6): take the
/// per-plugin write mutex → hold the SYNC-6 root-key guard across the disk write
/// → derive the KEK → read the current map → apply `mutate` → re-seal + persist.
async fn mutate_themes_with_dir(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    mutate: impl FnOnce(&mut ThemesMap),
) -> Result<(), ThemesError> {
    let _write_guard = write_mutex().lock().await;

    // SYNC-6 writer-guard: hold the slot read guard across the atomic_write so a
    // slots WRITE-lock holder (backup quiescence, vault_lock, vault_delete)
    // queues behind the in-flight write instead of observing a torn vault dir.
    let (_slots_guard, root_key, _vmh) = state
        .hold_unlocked_root_key_and_hash()
        .await
        .ok_or(ThemesError::SlotNotUnlocked)?;
    let (meta_version, account_number_hash) =
        read_account_number_hash(io, &vault_dir.join("vault.meta")).await?;
    let themes_key = derive_subkey_versioned(meta_version, &root_key, SubkeyRole::CustomThemesKey);

    // A read that FAILED aborts the mutation (#255): re-sealing a map we never
    // read would replace the stored themes with an empty store — and this blob
    // syncs, so the wipe would reach every device.
    let mut map = read_themes_map_in_dir(io, vault_dir, &themes_key, &account_number_hash).await?;
    mutate(&mut map);
    write_themes_map_in_dir(
        io,
        vault_dir,
        meta_version,
        &themes_key,
        &account_number_hash,
        &map,
    )
    .await?;

    // #266: open the coalesced push window, exactly as a prefs write does.
    //
    // `vault.themes` is a Class-1 sync member with a reserved blob id, so the
    // cycle PULLS it every time — but the push is gated behind `allow_push`,
    // which is driven by `dirty_since`, which only a `bump_local_change` sets.
    // Nothing in this module called it, so a theme imported or deleted here sat
    // unpushed until an unrelated note edit happened to open the window. On a
    // client where that is rare the edit effectively never left the device,
    // while the same device kept pulling the peers' copy over it.
    //
    // After the write, per the disk-FIRST-then-side-effect ordering contract
    // (soft dep — a no-op if the sync plugin is unmanaged).
    hooks.bump_local_change();
    Ok(())
}

/// Testable core of [`themes_list`]. Tombstoned names are skipped.
pub async fn themes_list_with_dir(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
    state: &VaultRuntimeState,
) -> Result<Vec<ThemeListEntry>, ThemesError> {
    Ok(live_entries(
        &read_themes_map_with_dir(io, vault_dir, state).await?,
    ))
}

/// Testable core of [`themes_read`]. A tombstoned name reads as absent.
pub async fn themes_read_with_dir(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
    state: &VaultRuntimeState,
    name: &str,
) -> Result<ThemePalette, ThemesError> {
    live_palette(&read_themes_map_with_dir(io, vault_dir, state).await?, name)
}

/// Testable core of [`themes_export`] — the read core WITHOUT the readability
/// gate.
///
/// It used to delegate to [`themes_read_with_dir`] verbatim, which meant the
/// contrast floor gated export too: a palette that fails the floor could not be
/// got out of the app at all. Refusing to let someone WEAR an unreadable theme is
/// the point of the gate; refusing to let them keep a copy of their own file is
/// not (myne#394).
pub async fn themes_export_with_dir(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
    state: &VaultRuntimeState,
    name: &str,
) -> Result<ThemePalette, ThemesError> {
    live_palette_gated(
        &read_themes_map_with_dir(io, vault_dir, state).await?,
        name,
        false,
    )
}

/// Testable core of [`themes_import`]. Validation runs BEFORE the SYNC-6 write
/// guard is taken, so an invalid palette never enters the read-modify-write.
pub async fn themes_import_with_dir(
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    name: &str,
    palette_json: &str,
) -> Result<(), ThemesError> {
    // Same one gate as the `_in_dir` sibling — see its comment for why this is a
    // single call rather than a composition each site re-performs.
    let parsed =
        validate_theme_for_import(palette_json).map_err(|error| ThemesError::Invalid { error })?;
    let vars = parsed.vars;
    let now = host.now_unix_secs();
    mutate_themes_with_dir(io, vault_dir, state, hooks, |map| {
        apply_import(map, name, vars, now);
    })
    .await?;
    tracing::info!(event = "themes_written", op = "import");
    Ok(())
}

/// Testable core of [`themes_delete`]. Writes a tombstone (never drops the key —
/// a dropped name would be resurrected by a peer's live copy on the next sync
/// merge). Idempotent (deleting an absent name is a no-op success).
pub async fn themes_delete_with_dir(
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    name: &str,
) -> Result<(), ThemesError> {
    let now = host.now_unix_secs();
    mutate_themes_with_dir(io, vault_dir, state, hooks, |map| {
        apply_delete(map, name, now);
    })
    .await?;
    tracing::info!(event = "themes_written", op = "delete");
    Ok(())
}

// ---- host-taking inners + the Tauri wrappers over them ---------------------
//
// phase3-web-client task 79, keystone. Each command is now two functions:
//
//   `*_from_host`  — takes `&dyn HostCtx`, compiles on EVERY target, and is
//                    the whole of the command. It differs from the old wrapper
//                    by exactly one line: the path resolution.
//   `*` (wrapper)  — `#[tauri::command]`, cfg-gated off on wasm and behind the
//                    default-on `tauri-ipc` feature, and reduced to a single
//                    delegation. The IPC name and payload shape are byte-
//                    identical **because it is literally the same function**
//                    the frontend already calls (Option B, `decisions.md`
//                    2026-07-26 / `core-hostctx-design.md`).
//
// `state.inner()` is the only asymmetry: the wrapper unwraps Tauri's
// `State<'_, T>` so the inner takes a plain `&VaultRuntimeState`. That is the
// shape the `*_with_dir` layer below already uses, which is why the inners are
// three lines each rather than a rewrite.

/// IPC: list every live custom theme in the unlocked vault's store — name +
/// palette per entry, so a picker renders its previews off THIS decrypt instead
/// of buying each palette back with a `themes_read` round-trip.
/// Host-taking inner. Compiles on every target.
pub async fn themes_list_from_host(
    host: &dyn HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    state: &VaultRuntimeState,
) -> Result<Vec<ThemeListEntry>, ThemesError> {
    let dir = crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)?;
    themes_list_with_dir(io, &dir, state).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn themes_list<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<Vec<ThemeListEntry>, ThemesError> {
    themes_list_from_host(
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
    )
    .await
}

/// IPC: read one custom theme's palette by name (consumed by the apply layer).
/// Host-taking inner. Compiles on every target.
pub async fn themes_read_from_host(
    host: &dyn HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    state: &VaultRuntimeState,
    name: String,
) -> Result<ThemePalette, ThemesError> {
    let dir = crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)?;
    themes_read_with_dir(io, &dir, state, &name).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn themes_read<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    name: String,
) -> Result<ThemePalette, ThemesError> {
    themes_read_from_host(
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        name,
    )
    .await
}

/// IPC: read one custom theme's palette for a plaintext `.json` export.
/// Host-taking inner. Compiles on every target.
pub async fn themes_export_from_host(
    host: &dyn HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    state: &VaultRuntimeState,
    name: String,
) -> Result<ThemePalette, ThemesError> {
    let dir = crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)?;
    themes_export_with_dir(io, &dir, state, &name).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn themes_export<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    name: String,
) -> Result<ThemePalette, ThemesError> {
    themes_export_from_host(
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        name,
    )
    .await
}

/// IPC: import (upsert) a validated custom theme under `name`. `palette_json` is
/// the raw contents of a user-picked `.json` theme file; it is validated through
/// the shared allowlist before being sealed into `vault.themes`.
/// Host-taking inner. Compiles on every target.
pub async fn themes_import_from_host(
    host: &dyn HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    name: String,
    palette_json: String,
) -> Result<(), ThemesError> {
    let dir = crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)?;
    themes_import_with_dir(io, host, &dir, state, hooks, &name, &palette_json).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn themes_import<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    name: String,
    palette_json: String,
) -> Result<(), ThemesError> {
    themes_import_from_host(
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        hooks.inner(),
        name,
        palette_json,
    )
    .await
}

/// IPC: delete one custom theme by name (idempotent).
/// Host-taking inner. Compiles on every target.
pub async fn themes_delete_from_host(
    host: &dyn HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    name: String,
) -> Result<(), ThemesError> {
    let dir = crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)?;
    themes_delete_with_dir(io, host, &dir, state, hooks, &name).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn themes_delete<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    name: String,
) -> Result<(), ThemesError> {
    themes_delete_from_host(
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        hooks.inner(),
        name,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScopedTempDir;

    const KEY: [u8; AEAD_KEY_LEN] = [0x55; AEAD_KEY_LEN];
    const HASH: [u8; VAULT_META_ACCOUNT_HASH_LEN] = [0x7c; VAULT_META_ACCOUNT_HASH_LEN];

    // The same counting double the prefs plugin asserts its sync window with
    // (#266) — one copy, so the two assertions cannot drift.
    use crate::hooks::test_hooks::CountingHooks;

    #[test]
    fn theme_entry_version_is_additive_absent_zero_and_zero_omitted() {
        // Migration (myne-md/myne#405): a legacy JSON entry with no `version`
        // decodes to 0, and a version-0 entry re-encodes WITHOUT the field, so a
        // pre-#405 blob stays byte-identical. A stamped entry emits the field.
        let legacy_json = r##"{"created_at":5,"palette":{"--accent":"#x"},"updated_at":5}"##;
        let e: ThemeEntry = serde_json::from_str(legacy_json).unwrap();
        assert_eq!(e.version, 0, "absent version decodes to 0");
        let reser = serde_json::to_string(&e).unwrap();
        assert!(!reser.contains("version"), "version 0 is omitted: {reser}");
        let stamped = ThemeEntry {
            created_at: 5,
            deleted_at: None,
            palette: ThemePalette::from([("--accent".to_string(), "#x".to_string())]),
            updated_at: 5,
            version: 2,
        };
        assert!(serde_json::to_string(&stamped)
            .unwrap()
            .contains("\"version\":2"));
    }

    /// A vault directory with a parseable `vault.meta` plus an unlocked slot
    /// keyed to it, so the `*_with_dir` production cores can run.
    async fn unlocked_vault() -> (ScopedTempDir, VaultRuntimeState) {
        use crate::plugins::vault_unlock::state::{fixture_unlocked_with_keys, test_vault_id};
        let tmp = ScopedTempDir::new("themes-sync").expect("tmp");
        // `read_account_number_hash` only needs the blob to PARSE; every other
        // field is filler.
        let meta = protocol::VaultMeta {
            account_number_hash: HASH,
            kdf_params: protocol::DEFAULT_V0_1_KDF_PARAMS,
            random_salt_password: [1u8; 16],
            random_salt_recovery: [2u8; 16],
            nonce_password_wrap: [3u8; 24],
            enc_root_key_password: [4u8; 64],
            nonce_recovery_wrap: [5u8; 24],
            enc_root_key_recovery: [6u8; 64],
            items_key_id: [7u8; 16],
            items_key_nonce: [8u8; 24],
            enc_items_key: [9u8; 64],
            membership: None,
        };
        std::fs::write(
            tmp.path().join("vault.meta"),
            protocol::serialize_vault_meta(&meta),
        )
        .expect("seed vault.meta");
        let state = VaultRuntimeState::default();
        state
            .set_unlocked(test_vault_id(), fixture_unlocked_with_keys(0x42, 0x99, 1))
            .await;
        (tmp, state)
    }

    /// A complete, well-formed minimal-core palette JSON (every required key,
    /// valid hex values) under `name`, as a JSON string.
    ///
    /// The ink/paper tokens carry REAL values rather than one filler colour,
    /// because import now runs the WCAG gate (myne#394) and a palette of
    /// identical hexes measures 1.00:1 — every gated pair would fail. The five
    /// gated tokens are the only ones that have to be honest; the rest stay
    /// filler, which keeps the fixture's intent (structure, not aesthetics)
    /// legible.
    fn valid_palette_json() -> String {
        let mut s = String::from("{\n");
        let keys = theme_validator::REQUIRED_KEYS;
        for (i, key) in keys.iter().enumerate() {
            let comma = if i + 1 < keys.len() { "," } else { "" };
            let value = match *key {
                "--paper" | "--paper-2" | "--paper-3" => "#ffffff",
                "--ink-0" | "--ink-1" => "#1a1a17",
                "--ink-2" => "#5c5c50",
                "--accent" => "#8a5a2b",
                _ => "#123456",
            };
            s.push_str(&format!("  \"{key}\": \"{value}\"{comma}\n"));
        }
        s.push('}');
        s
    }

    /// The same palette as a decoded map, for tests that build a store directly.
    fn a_palette() -> ThemePalette {
        serde_json::from_str(&valid_palette_json()).expect("valid palette JSON")
    }

    /// Wall-clock stand-in for the injected `now` (UNIX seconds).
    const T0: u64 = 1_700_000_000;

    // ── the seam, driven synchronously (phase3-web-client task 45) ──────────
    //
    // The `*_in_dir` cores became async when they moved onto `VaultIo`. These
    // shims shadow them inside the test module so the ~50 existing call sites
    // read exactly as they did — the assertions are about themes, not about
    // await points, and rewriting them all would have buried the behavioural
    // diff in mechanical noise.
    //
    // They drive the REAL native arm (`StdVaultIo`), not a double: the whole
    // claim of the port is that one code path serves both targets, and a fake
    // here would only prove the signature compiles.
    const IO: crate::vault_io::StdVaultIo = crate::vault_io::StdVaultIo;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    fn read_themes_map_in_dir(
        vault_dir: &Path,
        themes_key: &[u8; AEAD_KEY_LEN],
        account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
    ) -> ThemesMap {
        rt().block_on(super::read_themes_map_in_dir(
            &IO,
            vault_dir,
            themes_key,
            account_number_hash,
        ))
        .expect("read")
    }

    /// The same read, kept as a `Result` for the tests that assert an
    /// unreadable store is an ERROR rather than an empty one (#255).
    fn try_read_themes_map_in_dir(
        vault_dir: &Path,
        themes_key: &[u8; AEAD_KEY_LEN],
        account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
    ) -> Result<ThemesMap, ThemesError> {
        rt().block_on(super::read_themes_map_in_dir(
            &IO,
            vault_dir,
            themes_key,
            account_number_hash,
        ))
    }

    /// An IO stub that serves a scripted candidate list for `vault.themes` — the
    /// browser's double-buffered container, which native `StdVaultIo` cannot
    /// model (its `read_candidates` is a one-element list by construction).
    struct TornContainer {
        candidates: Vec<Vec<u8>>,
    }

    #[async_trait::async_trait]
    impl crate::vault_io::VaultIo for TornContainer {
        async fn read(&self, _path: &Path) -> crate::vault_io::IoResult<Vec<u8>> {
            // What `VaultIo::read` does on the web: the newest STRUCTURALLY
            // intact copy, torn payload and all.
            self.candidates
                .first()
                .cloned()
                .ok_or(crate::io_failure_kind::IoFailureKind::NotFound)
        }
        async fn read_candidates(&self, _path: &Path) -> crate::vault_io::IoResult<Vec<Vec<u8>>> {
            Ok(self.candidates.clone())
        }
        async fn read_prefix(&self, _p: &Path, _l: usize) -> crate::vault_io::IoResult<Vec<u8>> {
            Err(crate::io_failure_kind::IoFailureKind::NotFound)
        }
        async fn write(
            &self,
            _p: &Path,
            _b: &[u8],
            _o: crate::vault_io::WriteOpts,
        ) -> crate::vault_io::IoResult<()> {
            unreachable!("not exercised")
        }
        async fn remove_file(&self, _p: &Path) -> crate::vault_io::IoResult<()> {
            Ok(())
        }
        async fn exists(&self, _p: &Path) -> crate::vault_io::IoResult<bool> {
            Ok(true)
        }
        async fn read_dir(
            &self,
            _p: &Path,
        ) -> crate::vault_io::IoResult<Vec<crate::vault_io::DirEntry>> {
            Ok(Vec::new())
        }
        async fn create_dir_all(&self, _p: &Path) -> crate::vault_io::IoResult<()> {
            Ok(())
        }
        async fn remove_dir_all(&self, _p: &Path) -> crate::vault_io::IoResult<()> {
            Ok(())
        }
        async fn is_dir(&self, _p: &Path) -> crate::vault_io::IoResult<bool> {
            Ok(false)
        }
        async fn rename(&self, _f: &Path, _t: &Path) -> crate::vault_io::IoResult<()> {
            unreachable!("not exercised")
        }
    }

    fn write_themes_map_in_dir(
        vault_dir: &Path,
        themes_key: &[u8; AEAD_KEY_LEN],
        account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
        map: &ThemesMap,
    ) -> Result<(), ThemesError> {
        rt().block_on(super::write_themes_map_in_dir(
            &IO,
            vault_dir,
            MetaVersion::V0_1,
            themes_key,
            account_number_hash,
            map,
        ))
    }

    fn themes_list_in_dir(
        vault_dir: &Path,
        themes_key: &[u8; AEAD_KEY_LEN],
        account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
    ) -> Vec<ThemeListEntry> {
        rt().block_on(super::themes_list_in_dir(
            &IO,
            vault_dir,
            themes_key,
            account_number_hash,
        ))
        .expect("list")
    }

    fn themes_read_in_dir(
        vault_dir: &Path,
        themes_key: &[u8; AEAD_KEY_LEN],
        account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
        name: &str,
    ) -> Result<ThemePalette, ThemesError> {
        rt().block_on(super::themes_read_in_dir(
            &IO,
            vault_dir,
            themes_key,
            account_number_hash,
            name,
        ))
    }

    fn themes_import_in_dir(
        vault_dir: &Path,
        themes_key: &[u8; AEAD_KEY_LEN],
        account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
        name: &str,
        palette_json: &str,
        now: u64,
    ) -> Result<(), ThemesError> {
        rt().block_on(super::themes_import_in_dir(
            &IO,
            vault_dir,
            MetaVersion::V0_1,
            themes_key,
            account_number_hash,
            name,
            palette_json,
            now,
        ))
    }

    fn themes_delete_in_dir(
        vault_dir: &Path,
        themes_key: &[u8; AEAD_KEY_LEN],
        account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
        name: &str,
        now: u64,
    ) -> Result<(), ThemesError> {
        rt().block_on(super::themes_delete_in_dir(
            &IO,
            vault_dir,
            MetaVersion::V0_1,
            themes_key,
            account_number_hash,
            name,
            now,
        ))
    }

    /// The live theme NAMES [`themes_list_in_dir`] reports, under the fixed
    /// `KEY`/`HASH`. The list surface hands out `{name, palette}` entries, but
    /// the assertions below are about WHICH themes are live (and in what order)
    /// — the palette side is covered by the read tests — so they project the
    /// entries down to their names rather than spelling out palette literals.
    fn list_names(vault_dir: &Path) -> Vec<String> {
        themes_list_in_dir(vault_dir, &KEY, &HASH)
            .into_iter()
            .map(|e| e.name)
            .collect()
    }

    /// A palette that is *stored* but fails the readability floor.
    ///
    /// Written straight into the map rather than through import, because import
    /// refuses it — which is the whole point: these are the palettes that got in
    /// before the gate existed, arrived by sync from an older device, or came
    /// back with a backup restore.
    fn seal_unreadable(vault_dir: &Path, name: &str) {
        let mut map = ThemesMap::new();
        let mut palette = ThemePalette::new();
        for key in theme_validator::REQUIRED_KEYS {
            // Ink equal to paper: perfectly safe, perfectly unreadable, 1.00:1.
            palette.insert((*key).into(), "#ffffff".into());
        }
        map.insert(name.into(), ThemeEntry::live(palette, T0));
        write_themes_map_in_dir(vault_dir, &KEY, &HASH, &map).expect("write");
    }

    #[test]
    fn an_unreadable_stored_palette_cannot_be_worn() {
        // The 2026-08-07 entry's thesis was that the gate reached one import path
        // and not its sibling, every unit test stayed green, and only an E2E
        // scenario noticed. The read-path gate shipped with the same shape: delete
        // `check_contrast` from `live_palette` and nothing in the repo failed.
        let tmp = ScopedTempDir::new("themes-unreadable-read").expect("tmp");
        seal_unreadable(tmp.path(), "flat");
        let err = themes_read_in_dir(tmp.path(), &KEY, &HASH, "flat")
            .expect_err("an unreadable palette must not be applicable");
        assert!(
            matches!(err, ThemesError::Invalid { .. }),
            "expected Invalid, got {err:?}",
        );
    }

    #[test]
    fn an_unreadable_stored_palette_is_still_listed() {
        // Deliberately NOT gated: a peer's bad palette must stay visible so the
        // user can find and delete it. Blanking the picker over one bad entry is
        // the failure the read path's filter-don't-reject rule exists to prevent.
        let tmp = ScopedTempDir::new("themes-unreadable-list").expect("tmp");
        seal_unreadable(tmp.path(), "flat");
        assert_eq!(list_names(tmp.path()), vec!["flat"]);
    }

    #[test]
    fn vetted_strips_the_reserved_namespace_and_unknown_ornament_values() {
        // `--_o-ceiling` is the bound the tint wash is clamped by; a palette that
        // could set it could raise its own ceiling. An ornament value this build
        // does not know renders plain rather than failing — the forward-compat
        // contract an older client depends on.
        let mut palette = ThemePalette::new();
        palette.insert("--accent".into(), "#8a5a2b".into());
        palette.insert("--_o-ceiling".into(), "1".into());
        palette.insert("--box-frame".into(), "thick".into());
        // An ornament key this build knows, carrying a value it does not.
        palette.insert("--box-texture".into(), "quilted".into());
        // A role×primitive pair the sparse matrix refuses outright.
        palette.insert("--chrome-fold".into(), "dogear".into());

        let out = vetted(&palette);
        assert_eq!(out.get("--accent").map(String::as_str), Some("#8a5a2b"));
        assert_eq!(out.get("--box-frame").map(String::as_str), Some("thick"));
        assert!(
            !out.contains_key("--_o-ceiling"),
            "reserved namespace leaked"
        );
        // The half this test used to NAME and never check: deleting the
        // `is_known` filter left the previous version green, because it asserted
        // only the two survivors and the reserved key.
        assert!(
            !out.contains_key("--box-texture"),
            "unknown ornament value survived vetting"
        );
        // …and the distinction that is easy to get backwards, pinned so it is a
        // decision rather than an accident. An unrecognized VALUE on a cell this
        // build owns is dropped: the build knows what `--box-texture` means and
        // knows `quilted` is not one of the answers. A refused CELL is NOT
        // dropped — `classify_key` returns `Other` for it, which is the same
        // answer it gives a key from a vocabulary that does not exist yet, and
        // this build genuinely cannot tell those apart. Dropping it would make
        // an export round-trip lose a newer peer's ornament, which is the
        // forward-compat property §9.21.2 promises. It is safe because it is
        // still key- and value-allowlisted, and because reflection is gated
        // separately: `ornamentAttributes` filters through `roleAccepts`, so no
        // `data-o-chrome-fold` ever reaches the DOM.
        assert_eq!(
            out.get("--chrome-fold").map(String::as_str),
            Some("dogear"),
            "a refused cell must survive vetting — it is indistinguishable from a future key"
        );
    }

    #[test]
    fn an_unreadable_palette_can_still_be_exported() {
        // "You walk away with your files." The floor stops a theme being WORN; it
        // has no business stopping the user keeping a copy. Export used to
        // delegate to the gated read verbatim, which made such a palette
        // impossible to get out of the app at all.
        let tmp = ScopedTempDir::new("themes-unreadable-export").expect("tmp");
        seal_unreadable(tmp.path(), "flat");
        let map = read_themes_map_in_dir(tmp.path(), &KEY, &HASH);
        let exported = super::live_palette_gated(&map, "flat", false).expect("export must work");
        assert!(!exported.is_empty());
        // …and the same map, gated, refuses — so the two paths really do differ.
        assert!(super::live_palette_gated(&map, "flat", true).is_err());
    }

    #[test]
    fn seal_then_read_map_round_trips_with_fixed_key() {
        let tmp = ScopedTempDir::new("themes-roundtrip").expect("tmp");
        let mut map = ThemesMap::new();
        let mut palette = ThemePalette::new();
        palette.insert("--accent".into(), "#268bd2".into());
        palette.insert("--paper".into(), "#fdf6e3".into());
        map.insert("solarized".into(), ThemeEntry::live(palette.clone(), T0));

        write_themes_map_in_dir(tmp.path(), &KEY, &HASH, &map).expect("write");
        assert!(tmp.path().join(THEMES_FILE).exists());
        let back = read_themes_map_in_dir(tmp.path(), &KEY, &HASH);
        assert_eq!(back, map, "the clocks round-trip with the palette");
        assert_eq!(back["solarized"].palette, palette);
        assert_eq!(back["solarized"].created_at, T0);
        assert_eq!(back["solarized"].updated_at, T0);
        assert_eq!(back["solarized"].deleted_at, None);
    }

    #[test]
    fn tombstone_round_trips_through_the_blob() {
        // A tombstone must survive the seal/read cycle — it is the marker that
        // stops a peer resurrecting the theme on the next merge.
        let tmp = ScopedTempDir::new("themes-tomb-roundtrip").expect("tmp");
        let mut map = ThemesMap::new();
        map.insert(
            "nord".into(),
            ThemeEntry::live(
                ThemePalette::from([("--accent".into(), "#88c0d0".into())]),
                T0,
            )
            .into_tombstone(T0 + 5),
        );
        write_themes_map_in_dir(tmp.path(), &KEY, &HASH, &map).expect("write");
        let back = read_themes_map_in_dir(tmp.path(), &KEY, &HASH);
        assert_eq!(back, map);
        assert!(back["nord"].is_tombstone());
        assert_eq!(back["nord"].deleted_at, Some(T0 + 5));
        // The palette is scrubbed — a deleted theme leaves nothing descriptive.
        assert!(back["nord"].palette.is_empty());
    }

    #[test]
    fn live_entry_serializes_without_a_deleted_at_key() {
        // `deleted_at` is skipped when absent, so a live entry's inner JSON
        // carries exactly {created_at, palette, updated_at} — and the tombstone
        // discriminator is the key's presence.
        let map = ThemesMap::from([("t".to_string(), ThemeEntry::live(ThemePalette::new(), T0))]);
        let json = String::from_utf8(serialize_themes_map(&map).unwrap()).unwrap();
        assert!(!json.contains("deleted_at"), "live entry: {json}");
        let tombstoned = ThemesMap::from([(
            "t".to_string(),
            ThemeEntry::live(ThemePalette::new(), T0).into_tombstone(T0 + 1),
        )]);
        let json = String::from_utf8(serialize_themes_map(&tombstoned).unwrap()).unwrap();
        assert!(json.contains("deleted_at"), "tombstone: {json}");
    }

    #[test]
    fn absent_blob_reads_empty_map() {
        let tmp = ScopedTempDir::new("themes-absent").expect("tmp");
        assert!(read_themes_map_in_dir(tmp.path(), &KEY, &HASH).is_empty());
        assert!(list_names(tmp.path()).is_empty());
    }

    #[test]
    fn import_list_read_export_delete_flow() {
        let tmp = ScopedTempDir::new("themes-flow").expect("tmp");

        // import
        themes_import_in_dir(tmp.path(), &KEY, &HASH, "solar", &valid_palette_json(), T0)
            .expect("import");
        // list
        assert_eq!(list_names(tmp.path()), vec!["solar"]);
        // read
        let palette = themes_read_in_dir(tmp.path(), &KEY, &HASH, "solar").expect("read");
        assert_eq!(palette.get("--accent").map(String::as_str), Some("#8a5a2b"));
        assert_eq!(palette.len(), theme_validator::REQUIRED_KEYS.len());
        // export reads through the same core
        let exported = themes_read_in_dir(tmp.path(), &KEY, &HASH, "solar").expect("export");
        assert_eq!(exported, palette);
        // delete
        themes_delete_in_dir(tmp.path(), &KEY, &HASH, "solar", T0 + 10).expect("delete");
        assert!(list_names(tmp.path()).is_empty());
        // The blob PERSISTS carrying the tombstone — unlike the pre-sync drop
        // semantic, the deletion marker must survive to suppress resurrection.
        assert!(tmp.path().join(THEMES_FILE).exists());
    }

    #[test]
    fn delete_writes_a_tombstone_rather_than_dropping_the_key() {
        let tmp = ScopedTempDir::new("themes-tombstone").expect("tmp");
        themes_import_in_dir(tmp.path(), &KEY, &HASH, "solar", &valid_palette_json(), T0)
            .expect("import");
        themes_delete_in_dir(tmp.path(), &KEY, &HASH, "solar", T0 + 10).expect("delete");

        // The raw map still carries the name — as a tombstone, not a drop. A
        // dropped key would let a peer's live copy resurrect the theme.
        let map = read_themes_map_in_dir(tmp.path(), &KEY, &HASH);
        assert_eq!(map.len(), 1, "the name survives as a marker");
        let entry = &map["solar"];
        assert!(entry.is_tombstone());
        assert_eq!(entry.deleted_at, Some(T0 + 10));
        assert_eq!(entry.created_at, T0, "created_at is retained");
        assert!(entry.palette.is_empty(), "palette scrubbed at delete");
    }

    #[test]
    fn list_and_read_skip_tombstones() {
        let tmp = ScopedTempDir::new("themes-skip-tomb").expect("tmp");
        themes_import_in_dir(tmp.path(), &KEY, &HASH, "gone", &valid_palette_json(), T0)
            .expect("import gone");
        themes_import_in_dir(tmp.path(), &KEY, &HASH, "kept", &valid_palette_json(), T0)
            .expect("import kept");
        themes_delete_in_dir(tmp.path(), &KEY, &HASH, "gone", T0 + 10).expect("delete");

        // list skips the tombstone but keeps the live sibling.
        assert_eq!(list_names(tmp.path()), vec!["kept"]);
        // read (and therefore export, which shares this core) treats it as absent.
        assert_eq!(
            themes_read_in_dir(tmp.path(), &KEY, &HASH, "gone"),
            Err(ThemesError::NotFound)
        );
        assert!(themes_read_in_dir(tmp.path(), &KEY, &HASH, "kept").is_ok());
    }

    #[test]
    fn deliberate_readd_clears_the_tombstone() {
        let tmp = ScopedTempDir::new("themes-readd").expect("tmp");
        themes_import_in_dir(tmp.path(), &KEY, &HASH, "solar", &valid_palette_json(), T0)
            .expect("import");
        themes_delete_in_dir(tmp.path(), &KEY, &HASH, "solar", T0 + 10).expect("delete");

        // Re-importing the name is the deliberate re-add: the tombstone clears
        // and `created_at` is the re-add's clock, which STRICTLY postdates the
        // `deleted_at` so the revival wins the sync merge.
        themes_import_in_dir(
            tmp.path(),
            &KEY,
            &HASH,
            "solar",
            &valid_palette_json(),
            T0 + 20,
        )
        .expect("re-add");

        let map = read_themes_map_in_dir(tmp.path(), &KEY, &HASH);
        let entry = &map["solar"];
        assert!(!entry.is_tombstone(), "tombstone cleared");
        assert_eq!(entry.deleted_at, None);
        assert_eq!(entry.created_at, T0 + 20, "re-add restarts created_at");
        assert!(
            entry.created_at > T0 + 10,
            "created_at strictly postdates deleted_at ⇒ the revival wins the merge"
        );
        assert_eq!(list_names(tmp.path()), vec!["solar"]);
    }

    #[test]
    fn import_upsert_replaces_in_place() {
        let tmp = ScopedTempDir::new("themes-upsert").expect("tmp");
        themes_import_in_dir(tmp.path(), &KEY, &HASH, "t", &valid_palette_json(), T0)
            .expect("import 1");

        // Re-import the same name with an added optional token → replace, not dup.
        let mut s = valid_palette_json();
        s.pop(); // drop closing brace
        s.push_str(",\n  \"--syntax-keyword\": \"#abcdef\"\n}");
        themes_import_in_dir(tmp.path(), &KEY, &HASH, "t", &s, T0 + 30).expect("import 2");

        assert_eq!(list_names(tmp.path()), vec!["t"]);
        let palette = themes_read_in_dir(tmp.path(), &KEY, &HASH, "t").expect("read");
        assert!(palette.contains_key("--syntax-keyword"));
        // An edit of a LIVE theme moves updated_at (the LWW discriminator) but
        // retains created_at — the theme's identity did not restart.
        let entry = read_themes_map_in_dir(tmp.path(), &KEY, &HASH)
            .remove("t")
            .unwrap();
        assert_eq!(entry.created_at, T0, "created_at retained across an edit");
        assert_eq!(entry.updated_at, T0 + 30, "updated_at moves on an edit");
    }

    #[test]
    fn import_rejects_invalid_palette_without_writing() {
        let tmp = ScopedTempDir::new("themes-invalid").expect("tmp");
        // A value-shape violation (CSS injection vector) must reject.
        let err = themes_import_in_dir(
            tmp.path(),
            &KEY,
            &HASH,
            "evil",
            "{ \"--paper\": \"url(evil)\" }",
            T0,
        )
        .expect_err("invalid palette rejects");
        assert!(matches!(err, ThemesError::Invalid { .. }));
        // Nothing written.
        assert!(!tmp.path().join(THEMES_FILE).exists());
        assert!(list_names(tmp.path()).is_empty());
    }

    /// myne#386, the mirror of the test above in the opposite direction.
    ///
    /// `write_themes_map_in_dir` seals an arbitrary `ThemesMap` WITHOUT the
    /// import guard — which is precisely the shape a second device produces:
    /// the sync merge clones a peer's entry verbatim, and a restored backup
    /// extracts the blob byte-identically. Neither passes through
    /// `validate_theme`, so before this change the store could hold a value the
    /// grammar would have rejected and the read handed it straight to the
    /// CSSOM.
    #[test]
    fn a_palette_written_around_the_import_guard_is_filtered_on_read() {
        let tmp = ScopedTempDir::new("themes-unvetted").expect("tmp");

        let mut planted = a_palette();
        // The exact payload `import_rejects_invalid_palette_without_writing`
        // refuses at the front door, arriving through the back one.
        planted.insert("--paper".into(), "url(https://evil.example/x)".into());
        // A key off the grammar as well, since the guard covers both halves.
        planted.insert("--evil<script>".into(), "#123456".into());
        let map = ThemesMap::from([("peer".to_string(), ThemeEntry::live(planted, T0))]);
        write_themes_map_in_dir(tmp.path(), &KEY, &HASH, &map).expect("seal");

        let palette = themes_read_in_dir(tmp.path(), &KEY, &HASH, "peer").expect("read");
        assert!(
            !palette.contains_key("--paper"),
            "an off-grammar VALUE must not survive the read"
        );
        assert!(
            !palette.contains_key("--evil<script>"),
            "an off-grammar KEY must not survive the read"
        );
        assert_eq!(
            palette.get("--ink-1").map(String::as_str),
            Some("#1a1a17"),
            "every well-formed token is kept — this filters, it does not reject"
        );

        // The list core goes through the same helper, so the picker sees the
        // same filtered palette rather than the stored one.
        let listed = themes_list_in_dir(tmp.path(), &KEY, &HASH);
        let entry = listed.iter().find(|e| e.name == "peer").expect("entry");
        assert!(!entry.palette.contains_key("--paper"));
        assert!(!entry.palette.contains_key("--evil<script>"));
        assert!(entry.palette.contains_key("--ink-1"));
        assert_eq!(
            list_names(tmp.path()),
            vec!["peer"],
            "the theme itself survives — filtering a token must not drop the theme"
        );
    }

    #[test]
    fn read_absent_name_is_not_found() {
        let tmp = ScopedTempDir::new("themes-notfound").expect("tmp");
        themes_import_in_dir(tmp.path(), &KEY, &HASH, "a", &valid_palette_json(), T0)
            .expect("import");
        assert_eq!(
            themes_read_in_dir(tmp.path(), &KEY, &HASH, "ghost"),
            Err(ThemesError::NotFound)
        );
    }

    #[test]
    fn delete_absent_name_is_idempotent() {
        let tmp = ScopedTempDir::new("themes-del-idem").expect("tmp");
        themes_delete_in_dir(tmp.path(), &KEY, &HASH, "ghost", T0).expect("delete absent ok");
        // A name that never existed gets NO tombstone — the store stays empty
        // (and file-less), so a theme-less vault stays themes-silent on sync.
        assert!(list_names(tmp.path()).is_empty());
        assert!(read_themes_map_in_dir(tmp.path(), &KEY, &HASH).is_empty());
        assert!(!tmp.path().join(THEMES_FILE).exists());
    }

    #[test]
    fn re_deleting_a_tombstone_keeps_the_original_deleted_at() {
        // Idempotent delete: a second delete of the same name must not churn
        // the clock (a moved deleted_at would beat a peer's legitimate re-add).
        let tmp = ScopedTempDir::new("themes-redelete").expect("tmp");
        themes_import_in_dir(tmp.path(), &KEY, &HASH, "t", &valid_palette_json(), T0)
            .expect("import");
        themes_delete_in_dir(tmp.path(), &KEY, &HASH, "t", T0 + 10).expect("delete");
        themes_delete_in_dir(tmp.path(), &KEY, &HASH, "t", T0 + 99).expect("delete again");
        let map = read_themes_map_in_dir(tmp.path(), &KEY, &HASH);
        assert_eq!(map["t"].deleted_at, Some(T0 + 10), "original clock kept");
    }

    #[test]
    fn wrong_key_or_hash_is_unreadable_not_empty() {
        // #255: a LOCAL store that exists and does not decrypt is an error, not
        // an empty map. Reporting empty is what let the next read-modify-write
        // re-seal an empty store over the user's themes — and this blob syncs,
        // so the wipe reached every device.
        let tmp = ScopedTempDir::new("themes-crossvault").expect("tmp");
        themes_import_in_dir(tmp.path(), &KEY, &HASH, "secret", &valid_palette_json(), T0)
            .expect("import");
        let other_key = [0x11; AEAD_KEY_LEN];
        assert!(matches!(
            try_read_themes_map_in_dir(tmp.path(), &other_key, &HASH),
            Err(ThemesError::StoreUnreadable)
        ));
        let other_hash = [0x22; VAULT_META_ACCOUNT_HASH_LEN];
        assert!(matches!(
            try_read_themes_map_in_dir(tmp.path(), &KEY, &other_hash),
            Err(ThemesError::StoreUnreadable)
        ));
    }

    /// The consequence, end to end: a write attempted against an unreadable
    /// store must fail rather than replace it.
    #[test]
    fn an_unreadable_store_is_never_replaced_by_a_write() {
        let tmp = ScopedTempDir::new("themes-nowipe").expect("tmp");
        themes_import_in_dir(tmp.path(), &KEY, &HASH, "keeper", &valid_palette_json(), T0)
            .expect("import");
        let before = rt()
            .block_on(crate::vault_io::VaultIo::read(
                &IO,
                &tmp.path().join(THEMES_FILE),
            ))
            .expect("read blob");

        // An import driven with the WRONG key — the "could not read it" case.
        let wrong = [0x11; AEAD_KEY_LEN];
        let err = themes_import_in_dir(
            tmp.path(),
            &wrong,
            &HASH,
            "newcomer",
            &valid_palette_json(),
            T0 + 1,
        )
        .expect_err("an unreadable store must refuse the write");
        assert!(matches!(err, ThemesError::StoreUnreadable));

        let after = rt()
            .block_on(crate::vault_io::VaultIo::read(
                &IO,
                &tmp.path().join(THEMES_FILE),
            ))
            .expect("read blob");
        assert_eq!(before, after, "a refused write must not touch the blob");
        assert!(
            read_themes_map_in_dir(tmp.path(), &KEY, &HASH).contains_key("keeper"),
            "the real themes are still there under the real key"
        );
    }

    /// #266: a theme write must open the coalesced push window.
    ///
    /// `vault.themes` is a Class-1 sync member with a reserved blob id, so the
    /// cycle PULLS it every time — but the push is gated behind `allow_push`,
    /// driven by `dirty_since`, which only `bump_local_change` sets. Nothing in
    /// this module called it, so a theme imported here sat unpushed until an
    /// unrelated note edit happened to open the window, while the same device
    /// kept pulling the peers' copy over it.
    #[test]
    fn a_theme_write_opens_the_sync_push_window() {
        rt().block_on(async {
            let (tmp, state) = unlocked_vault().await;
            let bumps = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
            let hooks: crate::hooks::Hooks = std::sync::Arc::new(CountingHooks::new(bumps.clone()));

            super::themes_import_with_dir(
                &IO,
                &crate::host::NoopHost,
                tmp.path(),
                &state,
                &hooks,
                "solar",
                &valid_palette_json(),
            )
            .await
            .expect("import");
            assert_eq!(
                bumps.load(std::sync::atomic::Ordering::Relaxed),
                1,
                "an import must open the push window"
            );

            super::themes_delete_with_dir(
                &IO,
                &crate::host::NoopHost,
                tmp.path(),
                &state,
                &hooks,
                "solar",
            )
            .await
            .expect("delete");
            assert_eq!(
                bumps.load(std::sync::atomic::Ordering::Relaxed),
                2,
                "a delete writes a tombstone that peers must receive too"
            );
        });
    }

    #[test]
    fn corrupt_blob_is_unreadable_not_empty() {
        let tmp = ScopedTempDir::new("themes-corrupt").expect("tmp");
        // Through the seam like everything else — the bytes are deliberately
        // garbage, but the WRITE is not special, and reaching for `std::fs` here
        // would put this file back on the io-seam ratchet it just left.
        rt().block_on(crate::vault_io::VaultIo::write(
            &IO,
            &tmp.path().join(THEMES_FILE),
            b"not a MYT1 blob",
            crate::vault_io::WriteOpts::default(),
        ))
        .expect("write");
        assert!(matches!(
            try_read_themes_map_in_dir(tmp.path(), &KEY, &HASH),
            Err(ThemesError::StoreUnreadable)
        ));
    }

    #[test]
    fn serialized_map_is_deterministic() {
        // Two logically-equal maps built in different insertion orders serialize
        // to identical bytes (BTreeMap name-sort + serde_json order-preservation;
        // the entry struct's alphabetical field declaration keeps the inner keys
        // lexicographic too).
        let z = ThemeEntry::live(ThemePalette::from([("--paper".into(), "#000".into())]), T0);
        let a_entry = ThemeEntry::live(
            ThemePalette::from([("--accent".into(), "#fff".into())]),
            T0 + 1,
        );
        let mut a = ThemesMap::new();
        a.insert("z".into(), z.clone());
        a.insert("a".into(), a_entry.clone());
        let mut b = ThemesMap::new();
        b.insert("a".into(), a_entry);
        b.insert("z".into(), z);
        assert_eq!(
            serialize_themes_map(&a).unwrap(),
            serialize_themes_map(&b).unwrap()
        );
    }

    #[test]
    fn decode_themes_map_or_empty_collapses_every_failure() {
        // The read_or_empty analog the sync phase decodes the REMOTE blob with:
        // absent / corrupt / wrong-key all collapse to the empty store, so
        // merge(local, empty) == local and a hostile remote loses nothing.
        assert!(decode_themes_map_or_empty(&KEY, &HASH, None).is_empty());
        assert!(decode_themes_map_or_empty(&KEY, &HASH, Some(b"not a MYT1 blob")).is_empty());
        let map = ThemesMap::from([("t".to_string(), ThemeEntry::live(ThemePalette::new(), T0))]);
        let bytes = encode_themes_map(MetaVersion::V0_1, &KEY, &HASH, &map).expect("encode");
        assert_eq!(decode_themes_map_or_empty(&KEY, &HASH, Some(&bytes)), map);
        assert!(decode_themes_map_or_empty(&[0x11; AEAD_KEY_LEN], &HASH, Some(&bytes)).is_empty());
    }
    // ── myne#301: a torn newest slot must not read as an EMPTY store ─────────
    //
    // `VaultIo::read` answers with the newest STRUCTURALLY intact candidate, so
    // on the web client a slot torn mid-write was read, failed to decrypt, and
    // — before #255 — collapsed to empty; after #255 it errored. Either way the
    // complete copy beside it was never consulted, and `vault.themes` is SYNCED,
    // so the loss propagated.

    #[test]
    fn a_torn_newest_slot_falls_back_to_the_intact_copy() {
        let key = [0x42u8; AEAD_KEY_LEN];
        let mut map = ThemesMap::default();
        map.insert("midnight".to_string(), ThemeEntry::live(a_palette(), T0));
        let intact = encode_themes_map(MetaVersion::V0_1, &key, &HASH, &map).expect("encode");

        // A tear that kept the header but lost the tail — the shape the
        // container models as `StopMidWrite`.
        let mut torn = intact.clone();
        torn.truncate(intact.len() - 8);

        let io = TornContainer {
            candidates: vec![torn, intact],
        };
        let got = rt()
            .block_on(super::read_themes_map_in_dir(
                &io,
                Path::new("/vault"),
                &key,
                &HASH,
            ))
            .expect("the intact copy is right there");
        assert!(
            got.contains_key("midnight"),
            "reading the torn slot and stopping loses every custom theme while a \
             verifiable copy sits unread beside it"
        );
    }

    #[test]
    fn every_copy_torn_is_still_an_error_not_an_empty_store() {
        // #255's property, preserved: unreadable is not the same as absent, and
        // an empty map here would be re-sealed over the user's themes.
        let key = [0x42u8; AEAD_KEY_LEN];
        let io = TornContainer {
            candidates: vec![b"MYT1 torn".to_vec(), b"MYT1 also torn".to_vec()],
        };
        let err = rt()
            .block_on(super::read_themes_map_in_dir(
                &io,
                Path::new("/vault"),
                &key,
                &HASH,
            ))
            .expect_err("no copy decrypts");
        assert!(matches!(err, ThemesError::StoreUnreadable));
    }

    #[test]
    fn no_copy_at_all_is_the_empty_store() {
        // §9.21.4's fall-back-to-empty, which applies to ABSENT and only absent.
        let key = [0x42u8; AEAD_KEY_LEN];
        let io = TornContainer { candidates: vec![] };
        let got = rt()
            .block_on(super::read_themes_map_in_dir(
                &io,
                Path::new("/vault"),
                &key,
                &HASH,
            ))
            .expect("absent is not an error");
        assert!(got.is_empty());
    }

    #[test]
    fn the_sync_phase_reads_bytes_that_actually_decrypt() {
        // The push path takes the BYTES, so a torn slot there is published to
        // the server and every peer decodes it to empty.
        let key = [0x42u8; AEAD_KEY_LEN];
        let mut map = ThemesMap::default();
        map.insert("midnight".to_string(), ThemeEntry::live(a_palette(), T0));
        let intact = encode_themes_map(MetaVersion::V0_1, &key, &HASH, &map).expect("encode");
        let mut torn = intact.clone();
        torn.truncate(intact.len() - 8);

        let io = TornContainer {
            candidates: vec![torn, intact.clone()],
        };
        let got = rt().block_on(super::read_verified_themes_bytes(
            &io,
            Path::new("/vault"),
            &key,
            &HASH,
        ));
        assert_eq!(got.as_deref(), Some(intact.as_slice()));
    }
}
