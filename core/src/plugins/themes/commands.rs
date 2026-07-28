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
    decode_themes_blob, derive_subkey, encode_themes_blob, parse_vault_meta, SubkeyRole,
    AEAD_KEY_LEN, VAULT_META_ACCOUNT_HASH_LEN,
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
use theme_validator::validate_theme;
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
    /// Last-edit timestamp — UNIX seconds. The LWW discriminator for a
    /// same-name concurrent edit (greater wins). Equals `created_at` on a fresh
    /// import; re-importing the same name bumps it.
    pub updated_at: u64,
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
    /// A live (non-tombstone) entry imported at `now`.
    pub fn live(palette: ThemePalette, now: u64) -> Self {
        Self {
            created_at: now,
            deleted_at: None,
            palette,
            updated_at: now,
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
    /// `created_at` is retained (required field; the merge compares the *live*
    /// side's `created_at` against `deleted_at`).
    pub fn into_tombstone(self, deleted_at: u64) -> Self {
        Self {
            created_at: self.created_at,
            deleted_at: Some(deleted_at),
            palette: ThemePalette::new(),
            updated_at: self.updated_at,
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
) -> Result<[u8; VAULT_META_ACCOUNT_HASH_LEN], ThemesError> {
    let bytes = io
        .read(vault_meta_path)
        .await
        .map_err(|io_error_kind| ThemesError::Io { io_error_kind })?;
    let meta = parse_vault_meta(&bytes).map_err(|_| ThemesError::InvalidVaultMeta)?;
    Ok(meta.account_number_hash)
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

/// PURE CORE — seal `map` into the `MYT1` blob bytes.
pub fn encode_themes_map(
    themes_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
    map: &ThemesMap,
) -> Result<Vec<u8>, ThemesError> {
    let plaintext = serialize_themes_map(map)?;
    encode_themes_blob(themes_key, account_number_hash, &plaintext).map_err(|_| ThemesError::Encode)
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
/// `{name → palette}` map. Absent file / AEAD-fail / malformed payload → empty
/// map (the fall-back-to-empty semantic, § 9.21.4).
pub async fn read_themes_map_in_dir(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
    themes_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
) -> ThemesMap {
    // Absent is not an error here — §9.21.4's fall-back-to-empty covers absent,
    // truncated, AEAD-failed and malformed alike, so every IO failure collapses
    // the same way the decode failures do.
    let blob = io.read(&vault_dir.join(THEMES_FILE)).await.ok();
    decode_themes_map_or_empty(themes_key, account_number_hash, blob.as_deref())
}

/// PURE CORE — encrypt `map` to the `vault.themes` blob and atomically write it
/// under `vault_dir`. When `map` is empty, the file is removed (best-effort) so
/// an empty store leaves no file (fall-back-to-empty on read; byte-clean vault).
pub async fn write_themes_map_in_dir(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
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
    let blob = encode_themes_map(themes_key, account_number_hash, map)?;
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

/// The **live** entries in `map` — name + palette each, name-sorted.
///
/// Ordering is inherited, not imposed: [`ThemesMap`] is a `BTreeMap`, so
/// iteration is already lexicographic by name and a filter/map preserves it. No
/// caller needs to re-sort.
fn live_entries(map: &ThemesMap) -> Vec<ThemeListEntry> {
    map.iter()
        .filter(|(_, e)| !e.is_tombstone())
        .map(|(name, e)| ThemeListEntry {
            name: name.clone(),
            palette: e.palette.clone(),
        })
        .collect()
}

/// One **live** theme's palette by name, or [`ThemesError::NotFound`] — which a
/// tombstoned name also yields (it reads as absent).
fn live_palette(map: &ThemesMap, name: &str) -> Result<ThemePalette, ThemesError> {
    map.get(name)
        .filter(|e| !e.is_tombstone())
        .map(|e| e.palette.clone())
        .ok_or(ThemesError::NotFound)
}

/// PURE CORE — the name-sorted list of **live** custom themes in the store,
/// each carrying the palette this read already decoded (see [`ThemeListEntry`]).
pub async fn themes_list_in_dir(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
    themes_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
) -> Vec<ThemeListEntry> {
    live_entries(&read_themes_map_in_dir(io, vault_dir, themes_key, account_number_hash).await)
}

/// PURE CORE — one **live** theme's palette by name, or
/// [`ThemesError::NotFound`]. A tombstoned name reads as absent.
///
/// This is also the export core: a plaintext `.json` export reads exactly what
/// a read reads. The separately-grantable export *permission* lives at the IPC
/// boundary ([`themes_export_with_dir`] + its `allow-themes-export` ACL), which
/// is where the TB3 egress door is actually guarded — a duplicate pure-core
/// alias would add a second name without adding a second check.
pub async fn themes_read_in_dir(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
    themes_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
    name: &str,
) -> Result<ThemePalette, ThemesError> {
    live_palette(
        &read_themes_map_in_dir(io, vault_dir, themes_key, account_number_hash).await,
        name,
    )
}

/// Apply an import of `palette` under `name` at `now` to an in-memory map.
///
/// - **new name** → a fresh live entry (`created_at` = `updated_at` = `now`).
/// - **existing live name** → replace-in-place: the palette and `updated_at`
///   move, `created_at` is retained (the theme's identity did not restart).
/// - **tombstoned name** → the deliberate **re-add**: a fresh live entry whose
///   `created_at` is `now`, clearing the tombstone. `now` postdates the
///   `deleted_at` in wall-clock terms, so the revival wins the merge — the same
///   rule (and the same single-second clock-granularity caveat, §11.4) the
///   attachments catalog's re-import path carries.
fn apply_import(map: &mut ThemesMap, name: &str, palette: ThemePalette, now: u64) {
    let created_at = match map.get(name) {
        Some(e) if !e.is_tombstone() => e.created_at,
        _ => now,
    };
    map.insert(
        name.to_string(),
        ThemeEntry {
            created_at,
            deleted_at: None,
            palette,
            updated_at: now,
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
pub async fn themes_import_in_dir(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
    themes_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
    name: &str,
    palette_json: &str,
    now: u64,
) -> Result<(), ThemesError> {
    // Security-load-bearing injection guard (threat-model §149): a value that
    // reaches the DOM executes under the WebView's `style-src 'unsafe-inline'`.
    let parsed = validate_theme(palette_json).map_err(|error| ThemesError::Invalid { error })?;
    let mut map = read_themes_map_in_dir(io, vault_dir, themes_key, account_number_hash).await;
    apply_import(&mut map, name, parsed.vars, now);
    write_themes_map_in_dir(io, vault_dir, themes_key, account_number_hash, &map).await
}

/// PURE CORE — **tombstone** `name` in the store and re-seal the blob. Deleting
/// an absent name is a no-op success (idempotent). `now` is UNIX seconds,
/// injected so the core stays pure.
pub async fn themes_delete_in_dir(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
    themes_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
    name: &str,
    now: u64,
) -> Result<(), ThemesError> {
    let mut map = read_themes_map_in_dir(io, vault_dir, themes_key, account_number_hash).await;
    apply_delete(&mut map, name, now);
    write_themes_map_in_dir(io, vault_dir, themes_key, account_number_hash, &map).await
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
    let account_number_hash = read_account_number_hash(io, &vault_dir.join("vault.meta")).await?;
    let themes_key = derive_subkey(&root_key, SubkeyRole::CustomThemesKey);
    Ok(read_themes_map_in_dir(io, vault_dir, &themes_key, &account_number_hash).await)
}

/// Shared read-modify-write core for the write commands (SYNC-6): take the
/// per-plugin write mutex → hold the SYNC-6 root-key guard across the disk write
/// → derive the KEK → read the current map → apply `mutate` → re-seal + persist.
async fn mutate_themes_with_dir(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
    state: &VaultRuntimeState,
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
    let account_number_hash = read_account_number_hash(io, &vault_dir.join("vault.meta")).await?;
    let themes_key = derive_subkey(&root_key, SubkeyRole::CustomThemesKey);

    let mut map = read_themes_map_in_dir(io, vault_dir, &themes_key, &account_number_hash).await;
    mutate(&mut map);
    write_themes_map_in_dir(io, vault_dir, &themes_key, &account_number_hash, &map).await
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

/// Testable core of [`themes_export`] (byte-identical to the read core).
pub async fn themes_export_with_dir(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
    state: &VaultRuntimeState,
    name: &str,
) -> Result<ThemePalette, ThemesError> {
    themes_read_with_dir(io, vault_dir, state, name).await
}

/// Testable core of [`themes_import`]. Validation runs BEFORE the SYNC-6 write
/// guard is taken, so an invalid palette never enters the read-modify-write.
pub async fn themes_import_with_dir(
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
    vault_dir: &Path,
    state: &VaultRuntimeState,
    name: &str,
    palette_json: &str,
) -> Result<(), ThemesError> {
    let parsed = validate_theme(palette_json).map_err(|error| ThemesError::Invalid { error })?;
    let vars = parsed.vars;
    let now = host.now_unix_secs();
    mutate_themes_with_dir(io, vault_dir, state, |map| {
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
    name: &str,
) -> Result<(), ThemesError> {
    let now = host.now_unix_secs();
    mutate_themes_with_dir(io, vault_dir, state, |map| {
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
    name: String,
    palette_json: String,
) -> Result<(), ThemesError> {
    let dir = crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)?;
    themes_import_with_dir(io, host, &dir, state, &name, &palette_json).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn themes_import<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    name: String,
    palette_json: String,
) -> Result<(), ThemesError> {
    themes_import_from_host(
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
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
    name: String,
) -> Result<(), ThemesError> {
    let dir = crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)?;
    themes_delete_with_dir(io, host, &dir, state, &name).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn themes_delete<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    name: String,
) -> Result<(), ThemesError> {
    themes_delete_from_host(
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
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

    /// A complete, well-formed minimal-core palette JSON (every required key,
    /// valid hex values) under `name`, as a JSON string.
    fn valid_palette_json() -> String {
        let mut s = String::from("{\n");
        let keys = theme_validator::REQUIRED_KEYS;
        for (i, key) in keys.iter().enumerate() {
            let comma = if i + 1 < keys.len() { "," } else { "" };
            s.push_str(&format!("  \"{key}\": \"#123456\"{comma}\n"));
        }
        s.push('}');
        s
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
        assert_eq!(palette.get("--accent").map(String::as_str), Some("#123456"));
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
    fn wrong_key_or_hash_reads_empty_cross_vault() {
        let tmp = ScopedTempDir::new("themes-crossvault").expect("tmp");
        themes_import_in_dir(tmp.path(), &KEY, &HASH, "secret", &valid_palette_json(), T0)
            .expect("import");
        // Different KEK (different vault) → AEAD fails → empty.
        let other_key = [0x11; AEAD_KEY_LEN];
        assert!(read_themes_map_in_dir(tmp.path(), &other_key, &HASH).is_empty());
        // Different account-hash (cross-vault AAD) → empty.
        let other_hash = [0x22; VAULT_META_ACCOUNT_HASH_LEN];
        assert!(read_themes_map_in_dir(tmp.path(), &KEY, &other_hash).is_empty());
    }

    #[test]
    fn corrupt_blob_reads_empty() {
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
        assert!(read_themes_map_in_dir(tmp.path(), &KEY, &HASH).is_empty());
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
        let bytes = encode_themes_map(&KEY, &HASH, &map).expect("encode");
        assert_eq!(decode_themes_map_or_empty(&KEY, &HASH, Some(&bytes)), map);
        assert!(decode_themes_map_or_empty(&[0x11; AEAD_KEY_LEN], &HASH, Some(&bytes)).is_empty());
    }
}
