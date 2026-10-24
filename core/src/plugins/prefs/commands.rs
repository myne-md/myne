// SPDX-License-Identifier: AGPL-3.0
//! `prefs` Tauri command handlers (MYND-160 Task 9).
//!
//! - [`prefs_read`] — Slot::Unlocked-gated read of the `vault.prefs`
//!   blob; fall-back-to-defaults on absent / AEAD-fail / parse-fail
//!   per `docs/spec/protocol.md` § 9.5.5.
//! - [`set_screen_capture_protection`] — per-field setter under a
//!   per-plugin `tokio::sync::Mutex` so concurrent setter calls
//!   commit FIFO; **critical ordering: disk write FIRST, native
//!   side-effect SECOND** so a disk failure leaves the UI / disk
//!   consistent (MYND-160 grill Q5.2).
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline".

use super::error::{PrefsReadError, PrefsWriteError};
use super::set_mutation::{apply_set_mutation, SetMutation};
use crate::host::HostCtx;
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use protocol::{
    decode_prefs_blob, encode_prefs_blob_versioned, meta_version_of, parse_vault_meta_any,
    ColorGroup, EditorLayout, MetaVersion, PrefsBlobError, PrefsView, SavedView, SubkeyRole,
    ThemeChoice, VAULT_META_ACCOUNT_HASH_LEN,
};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
// Tauri types serve only the cfg-gated IPC wrappers (task 79, Option B).
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use crate::host::tauri_host::TauriHost;
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use tauri::{AppHandle, Runtime, State};
use tokio::sync::Mutex;

/// Per-plugin write serialization. `OnceLock<Mutex<()>>` is lazily
/// initialized on first `set_*` call; subsequent calls reuse the
/// same lock instance. Phase 1 single-window means the practical
/// risk of concurrent writers is low (the SettingsModal serializes
/// toggle interactions at the UI level), but the mutex is structural
/// preparation for v0.2 multi-window where two SettingsModals could
/// theoretically race. Future per-field setters (`set_theme`,
/// `set_font_size`, ...) share this same mutex so cross-field
/// concurrent writes also serialize.
pub fn write_mutex() -> &'static Mutex<()> {
    static M: OnceLock<Mutex<()>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(()))
}

/// Resolve the ACTIVE (sole-`Unlocked`) vault's root. `active_id` is read from
/// the runtime state by the calling command (`state.active_vault_id().await`) —
/// the only place with `.await` access to the slot map. SYNC-6: prefs always
/// operate on the unlocked vault, so resolving via the active id (not the
/// transitional sole-vault disk heuristic) is what keeps `vault.prefs` reads +
/// the label write targeting the correct vault once two or more exist.
/// Resolve the active vault's root. One line over the pure resolver in
/// `crate::paths`, so the host arm and the (now removed) Tauri arm cannot
/// compute different paths.
fn vault_dir_from_host(
    host: &dyn HostCtx,
    active_id: Option<crate::vault_id::VaultId>,
) -> std::io::Result<PathBuf> {
    crate::paths::active_vault_root_io_from_host(host, active_id)
}

/// Where a [`PrefsView`] came from, for the callers that cannot treat a
/// § 9.5.5 fallback as an answer.
///
/// The spec rule — absent / undecodable `vault.prefs` degrades to defaults,
/// never fails — is right for every consumer whose action the user can simply
/// redo: a wrong theme is one click away from correct. It is **not** enough for
/// a consumer whose action is irreversible. `attachment_compression_enabled`
/// defaults to `true`, so on a damaged blob the fallback would start discarding
/// pixels on behalf of a user whose actual answer nobody could read.
///
/// This enum changes no value and no fallback: [`read_or_default`] returns
/// exactly what it did before. It only lets a caller ask the second question —
/// *is this the stored answer, or the fallback?* — instead of guessing from a
/// value that looks identical either way.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrefsOrigin {
    /// Decoded from a stored blob. These are the user's settings.
    Stored,
    /// No blob exists. Defaults are the *correct* answer here rather than a
    /// fallback — a vault that has never written prefs is not a damaged one
    /// (the standard case for a fresh vault and for every pre-MYND-160 one),
    /// and "never changed the default" is itself an answer.
    Absent,
    /// A blob exists and could not be read or decoded. The values are § 9.5.5
    /// defaults and say nothing about what the user chose.
    Degraded,
}

/// Read `vault.prefs` from disk and decode under `prefs_key` + AAD
/// bound to `account_number_hash`. Returns `PrefsView::default()` on
/// any failure (absent / truncated / AEAD-fail / parse-fail) per
/// spec § 9.5.5; logs the failure category via `tracing::warn!`
/// without leaking key material or path strings.
///
/// `pub(crate)` so the future Task 10 (vault_unlock pipeline
/// integration) can share the same read-or-default discipline at the
/// unlock-time step 5 call site.
pub async fn read_or_default(
    io: &dyn crate::vault_io::VaultIo,
    prefs_path: &Path,
    prefs_key: &[u8; 32],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
) -> PrefsView {
    read_or_default_reporting_origin(io, prefs_path, prefs_key, account_number_hash)
        .await
        .0
}

/// [`read_or_default`], plus the [`PrefsOrigin`] that produced it.
///
/// The single implementation of both; `read_or_default` is this with the origin
/// dropped, so the fallback rule cannot drift between them.
pub async fn read_or_default_reporting_origin(
    io: &dyn crate::vault_io::VaultIo,
    prefs_path: &Path,
    prefs_key: &[u8; 32],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
) -> (PrefsView, PrefsOrigin) {
    // The newest copy that DECODES (phase3-web-client task 18), not the newest
    // copy. On the web client a singleton is two alternating files, and here the
    // difference is user-visible in a way it is nowhere else: § 9.5.5 says an
    // undecodable `vault.prefs` degrades to defaults, so a torn newest copy
    // would silently reset the user's settings — with their real prefs intact in
    // the other buffer. Falling back first is what keeps the degrade-to-defaults
    // rule a last resort instead of a routine outcome after a crash.
    //
    // Native is unchanged: `read_candidates` yields one copy there, so this is
    // the same read, the same decode, the same fallback.
    match crate::singleton::open_newest(io, prefs_path, |candidate| {
        decode_prefs_blob(prefs_key, account_number_hash, candidate)
    })
    .await
    {
        Ok(view) => (view, PrefsOrigin::Stored),
        Err(crate::singleton::OpenOutcome::Absent) => {
            // Absent file is the standard case for pre-MYND-160 vaults
            // and for the first read after vault_create (until Task 12
            // lands eager-write). Not a warn — this is the documented
            // happy path of spec § 9.5.5.
            (PrefsView::default(), PrefsOrigin::Absent)
        }
        Err(crate::singleton::OpenOutcome::Io(e)) => {
            tracing::warn!(
                event = "prefs_io_failed",
                stage = "read",
                io_kind = ?e,
                "vault.prefs read failed; falling back to defaults"
            );
            (PrefsView::default(), PrefsOrigin::Degraded)
        }
        Err(crate::singleton::OpenOutcome::Undecodable(cause)) => {
            // Every stored copy failed — on desktop the only one, on web both.
            // The warn keeps the same shape and reason code it had when this was
            // a single decode, because for an operator the situation is the
            // same: prefs are gone and defaults are in use.
            tracing::warn!(
                event = "prefs_decrypt_failed",
                reason = prefs_blob_error_kind(&cause),
                "vault.prefs decode failed; falling back to defaults"
            );
            (PrefsView::default(), PrefsOrigin::Degraded)
        }
    }
}

/// The decode-and-fall-back half of [`read_or_default`], over bytes already read.
///
/// Split out (phase3-web-client task 14) because the seam's read is **async**
/// and one caller cannot await: `export`'s `stage_export_tree_inner` is a
/// synchronous function, and `export` is host-only (gated out of the wasm build
/// entirely), so it reads with `std::fs` and decodes here.
///
/// Sharing this function rather than letting that caller reimplement the
/// fallback is the point: § 9.5.5's "absent / undecodable prefs degrade to
/// defaults, never fail" is a spec rule, and two copies of it would be two
/// places for it to drift.
pub fn decode_or_default(
    bytes: &[u8],
    prefs_key: &[u8; 32],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
) -> PrefsView {
    match decode_prefs_blob(prefs_key, account_number_hash, bytes) {
        Ok(view) => view,
        Err(cause) => {
            tracing::warn!(
                event = "prefs_decrypt_failed",
                reason = prefs_blob_error_kind(&cause),
                "vault.prefs decode failed; falling back to defaults"
            );
            PrefsView::default()
        }
    }
}

/// Closed-enum mapping from `PrefsBlobError` to a static log tag.
///
/// `PrefsBlobError` already has a `Debug` impl that emits the variant
/// name (the variants are unit-like or carry no DENY-listed payload),
/// but using the static-string helper here keeps the secret-handling
/// logging discipline visible at the call site and provides a single
/// place to evolve the mapping if a future variant ever carries
/// path-like or key-like fields.
fn prefs_blob_error_kind(e: &PrefsBlobError) -> &'static str {
    match e {
        PrefsBlobError::HeaderTooShort => "header_too_short",
        PrefsBlobError::MagicMismatch => "magic_mismatch",
        PrefsBlobError::ProtocolVersionMismatch => "protocol_version_mismatch",
        PrefsBlobError::ReservedByteNonZero => "reserved_byte_non_zero",
        PrefsBlobError::CiphertextLenOverflow => "ciphertext_len_overflow",
        PrefsBlobError::CiphertextTruncated => "ciphertext_truncated",
        PrefsBlobError::CannotDecrypt => "aead_fail",
        PrefsBlobError::PlaintextParseFailed => "plaintext_parse_failed",
        PrefsBlobError::RandomnessUnavailable => "randomness_unavailable",
        _ => "other_prefs_blob_error",
    }
}

/// Read `vault.meta` from disk and return the `account_number_hash`
/// field (offset 6, 16 bytes). Used by both `prefs_read` and
/// `set_screen_capture_protection` to construct the AAD per spec
/// § 9.5.3 — `account_number_hash` is not cached in `Slot::Unlocked`
/// (Slot stays crypto-state-only per grill Q5.1), so each prefs IPC
/// re-reads. Cost is a single ~345-byte file read + parse; acceptable
/// for the lazy/rare prefs cadence.
async fn read_account_number_hash(
    io: &dyn crate::vault_io::VaultIo,
    vault_meta_path: &Path,
) -> Result<(MetaVersion, [u8; VAULT_META_ACCOUNT_HASH_LEN]), PrefsReadError> {
    let bytes = io
        .read(vault_meta_path)
        .await
        .map_err(|k| PrefsReadError::Io { io_error_kind: k })?;
    let version = meta_version_of(&bytes).ok_or(PrefsReadError::InvalidVaultMeta)?;
    let meta = parse_vault_meta_any(&bytes).map_err(|_| PrefsReadError::InvalidVaultMeta)?;
    Ok((version, meta.account_number_hash))
}

/// Read-side helper bridging `read_account_number_hash` into the
/// write-error type. Trivial wrapper — kept separate so the error
/// surface stays asymmetric (read fails differently than write) per
/// MYND-160 grill Q3.4 + Q6.3.
async fn read_account_number_hash_for_write(
    io: &dyn crate::vault_io::VaultIo,
    vault_meta_path: &Path,
) -> Result<(MetaVersion, [u8; VAULT_META_ACCOUNT_HASH_LEN]), PrefsWriteError> {
    let bytes = io
        .read(vault_meta_path)
        .await
        .map_err(|k| PrefsWriteError::Io { io_error_kind: k })?;
    let version = meta_version_of(&bytes).ok_or(PrefsWriteError::InvalidVaultMeta)?;
    let meta = parse_vault_meta_any(&bytes).map_err(|_| PrefsWriteError::InvalidVaultMeta)?;
    Ok((version, meta.account_number_hash))
}

/// Shared read-modify-write core for every `Slot::Unlocked`-gated prefs setter
/// (SYNC-6, MYND-32). Every `set_*_with_dir` below wrapped the SAME skeleton:
/// take the per-plugin write mutex → hold the SYNC-6 root-key guard → derive the
/// prefs key → read-or-default the current `vault.prefs` → apply the field
/// mutation → re-encode → atomically persist. This centralises that skeleton;
/// callers supply only `mutate` (the field-specific edit) and keep their own
/// success `tracing::info!(event = "prefs_written", field = …)` line (the field
/// name — and whether its value is loggable — is per-setter) plus any native
/// side-effect. **Ordering contract (MYND-160 grill Q5.2):** this persists to
/// disk BEFORE returning, so a caller's native side-effect runs on the
/// `.await?`-success path — disk write FIRST, native side-effect SECOND.
async fn update_prefs_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    mutate: impl FnOnce(&mut PrefsView),
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    use crate::plugins::sync::prefs_merge::shared_subset_hash;

    let _write_guard = write_mutex().lock().await;
    let _quiesce = crate::singleton_quiesce::shared().await;

    // ---- #250: the key and the path must name the SAME vault -------------
    //
    // This function takes its key from the unlocked slot and its directory
    // from the caller, and nothing compared the two. A caller holding a stale
    // "which vault is active" answer therefore encrypted vault A's prefs under
    // vault B's key and wrote them over vault B's real blob — and because
    // `read_or_default` degrades an unreadable blob to `PrefsView::default()`,
    // the read-modify-write silently replaced the other vault's settings
    // instead of failing. Refuse rather than write.
    //
    // Compared as IDENTITIES, not as paths: `vault_id_from_root` is the same
    // derivation the unlock/delete set-sites use to key the slot map, so this
    // asks the question that matters ("is this the vault whose key I hold?")
    // rather than a string question about two path spellings. A directory that
    // names no vault derives the legacy sentinel — the same id a legacy vault's
    // slot carries — so the pre-multi-vault layout keeps working unchanged.
    if let Some(active) = state.active_vault_id().await {
        let targeted = crate::paths::vault_id_from_root(vault_dir);
        if targeted != active {
            tracing::warn!(
                event = "prefs_write_refused",
                reason = "vault_target_mismatch",
                "prefs write targeted a vault that is not the active one"
            );
            return Err(PrefsWriteError::VaultTargetMismatch);
        }
    }

    // SYNC-6 writer-guard (MYND-32): see state::hold_unlocked_root_key_and_hash.
    let (_slots_guard, shared, _vmh) = state
        .hold_unlocked_shared_singleton_material()
        .await
        .ok_or(PrefsWriteError::SlotNotUnlocked)?;

    let (meta_version, account_number_hash) =
        read_account_number_hash_for_write(io, &vault_dir.join("vault.meta")).await?;
    let prefs_key = shared.derive(meta_version, SubkeyRole::PrefsKey);
    let prefs_path = vault_dir.join("vault.prefs");

    // REFUSE rather than write over a read that degraded (test-audit #40).
    //
    // §9.5.5's "an absent or undecodable `vault.prefs` degrades to defaults,
    // never fails" is a READ rule — it is what keeps a vault openable when its
    // prefs blob is unreadable. Carrying that into the WRITE turns a
    // recoverable read failure into permanent loss: the read-modify-write bases
    // itself on `PrefsView::default()` and then persists those defaults over a
    // blob that may be perfectly intact and merely unreadable right now (a full
    // disk, an EIO, a torn copy on the web client's double buffer). The SHARED
    // subset syncs, so the defaults do not even stay on this device.
    //
    // `Absent` is NOT refused, and the distinction is the point: an absent file
    // means "this vault has never written prefs", which is an answer and is the
    // normal state of every vault that has not opened Settings. Only `Degraded`
    // — the read tried and failed — blocks the write. That is the same line the
    // attachment-import path already draws on the same value
    // (`plugins/attachments/commands.rs`), and this brings the write path onto
    // it rather than inventing a second rule.
    let (mut prefs, origin) =
        read_or_default_reporting_origin(io, &prefs_path, &prefs_key, &account_number_hash).await;
    if origin == PrefsOrigin::Degraded {
        tracing::warn!(
            event = "prefs_write_refused",
            reason = "prefs_unreadable",
            "prefs write refused: the read degraded to defaults and writing would persist them"
        );
        return Err(PrefsWriteError::PrefsUnreadable);
    }
    let before = prefs.clone();
    mutate(&mut prefs);

    // MYND-478 (sync-protocol.md §10.2): stamp the LWW field clock of every
    // SHARED field this write changed — centrally, so no setter can forget.
    // Device-local fields are never stamped; set-union fields are stamped PER ENTRY, for adds and removals alike, except the two monotone egress sets (`ai_excluded_folders`, `cli_excluded_folders`), which stamp nothing at all (myne-md/myne#613); a wall-clock
    // failure degrades to clock 0 (the legacy value) rather than blocking the
    // write.
    // Host clock (task 14 — the TODO this replaces was recorded in task 12).
    // `SystemTime::now()` panics on wasm32 and this is a WRITE path, so the
    // whole `set_*` surface would have aborted the instance the first time a
    // user changed a setting in a browser.
    //
    // WALL clock, in MILLISECONDS: these are §10.2 last-write-wins field clocks
    // compared across devices, so a monotonic reading would be meaningless and a
    // second-granularity one would make two edits inside the same second
    // unorderable. Exactly why `HostCtx` carries both clocks at millisecond
    // resolution.
    let now_ms = host.now_unix_millis();
    crate::plugins::sync::prefs_merge::stamp_changed_shared_fields(&before, &mut prefs, now_ms);

    // myne#613: the last-resort cap guard, AFTER stamping, because stamping is
    // the step that grows the blob. `apply_set_mutation`'s budget already keeps
    // an ordinary write well inside the cap, including the tombstones a future
    // removal will mint, so on every vault this feature created this sheds
    // nothing and costs one length measurement.
    //
    // It is here for the vault that arrives OVER that budget anyway: one merged
    // from a peer, or one whose set fields predate the budget entirely. On those
    // a removal can still push the plaintext past the cap, and a removal is the
    // one operation that must never be refused, since deleting is the only
    // remedy the budget-full notice offers. Shedding the oldest tombstone is the
    // recoverable loss; a `PrefsEncodeFailed` on a delete is not.
    let shed = crate::plugins::prefs::set_mutation::shed_retained_clocks(&mut prefs);
    if shed > 0 {
        tracing::warn!(
            stage = "prefs",
            event = "retained_clocks_shed",
            count = shed,
            "the prefs blob was over the plaintext cap; shed the oldest removal clocks to keep it writable"
        );
    }

    // MYND-517: did this write change the SHARED subset? Compared via
    // `shared_subset_hash` — the §10.2.1 push gate's own discriminator — so
    // the bump below fires exactly when the sync phase would see a dirty
    // prefs blob: shared LWW edits (via their stamped clock), set-union edits
    // (via the value itself, and since myne#613 via their per-entry clocks too
    // on the three fields that propagate removals), and `device_names` key
    // changes all register; a device-local-only or no-op write never does.
    let shared_changed = shared_subset_hash(&prefs) != shared_subset_hash(&before);

    let blob_bytes =
        encode_prefs_blob_versioned(meta_version, &prefs_key, &account_number_hash, &prefs)
            .map_err(|_| PrefsWriteError::PrefsEncodeFailed)?;

    io.write(
        &prefs_path,
        &blob_bytes,
        crate::vault_io::WriteOpts::default(),
    )
    .await
    .map_err(|io_error_kind| PrefsWriteError::Io { io_error_kind })?;

    // MYND-517: a shared-pref edit opens the same coalesced push window a note
    // edit does — without this, a prefs-only change (vault rename, favorites,
    // saved views, …) waits for an unrelated note push to ride along, which on
    // mobile is effectively never. Device-local edits must NOT bump (no-traffic
    // discipline / resolution-blur, §10.2.1). After the atomic write, per the
    // disk-FIRST-then-side-effect ordering contract above (soft dep — no-op if
    // the sync plugin is unmanaged).
    if shared_changed {
        hooks.bump_local_change();
    }

    Ok(())
}

/// Tauri event announcing a `vault.prefs` change applied OUTSIDE the user's
/// own IPC round-trip — today the Phase 2 sync merge phase (MYND-478). A
/// local setter needs no event (its own IPC success is the signal, and the
/// WebView dispatches its window-level refresh itself); a sync-applied merge
/// is invisible to the WebView without this. Frontends bridge it into their
/// prefs re-read path (desktop: the `VAULT_PREFS_CHANGED_EVENT` window event;
/// mobile: `bumpPrefsNonce`). Payload: none (contentless — the listener
/// re-reads; the event never carries pref values).
pub const PREFS_CHANGED_EVENT: &str = "myne://prefs-changed";

/// Slot::Unlocked-gated read of the `vault.prefs` blob.
///
/// Returns `PrefsView::default()` on any prefs-blob failure (absent /
/// AEAD-fail / parse-fail) per spec § 9.5.5; only Slot precondition
/// failures and `vault.meta` IO failures surface as `PrefsReadError`.
/// The Tauri-command wrapper resolves `app_data_dir` then delegates
/// to [`prefs_read_with_dir`] so tests can exercise the core logic
/// against a `ScopedTempDir` without spinning up a Tauri runtime.
pub async fn prefs_read_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<PrefsView, PrefsReadError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsReadError::from)?;
    prefs_read_with_dir(&dir, state, io).await
}

/// The same read, reporting WHERE the values came from.
///
/// **A second entry point rather than a change to `prefs_read_from_host`**, because
/// the origin matters to exactly one caller and the plain value is right for
/// everybody else: § 9.5.5 degrades an absent or undecodable blob to defaults, so
/// "never set this" and "could not read what you set" are the same `PrefsView` and
/// different facts. The agent's undo record is the caller that has to tell them
/// apart (myne-md/myne#850, from the 2026-10-13 review): it stores the value a write
/// replaced, and a `None` from a degraded read would be stored as "there was
/// nothing here", which the undo restores by CLEARING a value nobody ever saw.
/// `plugins::attachments::commands`'s compression gate is the older caller of the
/// `_with_dir` form and gives the same reasoning for the same reason, one field
/// over: a premium lost permanently against a value lost permanently.
pub async fn prefs_read_from_host_reporting_origin(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(PrefsView, PrefsOrigin), PrefsReadError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsReadError::from)?;
    prefs_read_with_dir_reporting_origin(&dir, state, io).await
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn prefs_read<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<PrefsView, PrefsReadError> {
    prefs_read_from_host(
        &TauriHost::new(app),
        state.inner(),
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`prefs_read`].
pub async fn prefs_read_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<PrefsView, PrefsReadError> {
    prefs_read_with_dir_reporting_origin(vault_dir, state, io)
        .await
        .map(|(view, _origin)| view)
}

/// [`prefs_read_with_dir`], plus the [`PrefsOrigin`] behind the returned view.
///
/// For the callers that must distinguish "the user's stored answer" from "the
/// § 9.5.5 fallback that happens to look like one" — today the ingest-time
/// image-compression gate in `plugins::attachments::commands`, whose action
/// discards pixels and cannot be undone by re-reading a repaired blob.
pub async fn prefs_read_with_dir_reporting_origin(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(PrefsView, PrefsOrigin), PrefsReadError> {
    // Peek root_key from the Unlocked slot (ignore the
    // vault_meta_bytes_hash — prefs has no CAS anchor against it).
    let shared = state
        .peek_unlocked_shared_singleton_key()
        .await
        .ok_or(PrefsReadError::SlotNotUnlocked)?;

    let (meta_version, account_number_hash) =
        read_account_number_hash(io, &vault_dir.join("vault.meta")).await?;
    let prefs_key = shared.derive(meta_version, SubkeyRole::PrefsKey);
    let prefs_path = vault_dir.join("vault.prefs");

    Ok(read_or_default_reporting_origin(io, &prefs_path, &prefs_key, &account_number_hash).await)
}

/// Internal (non-IPC) setter: record the last successful backup export
/// (MYND-58; spec §9.5.2 `last_backup_at` — drives the 30-day backup
/// reminder). Same write discipline as every IPC setter (per-plugin write
/// mutex + SYNC-6 hold guard). Best-effort at the call site: a failed
/// prefs write never demotes a verified export.
pub async fn record_last_backup_at_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    epoch_seconds: u64,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.last_backup_at = Some(epoch_seconds);
        },
        io,
        host,
    )
    .await?;

    tracing::info!(event = "prefs_written", field = "last_backup_at");
    Ok(())
}

/// Internal (non-IPC) setter: persist the browser-clipper pairing-token
/// registry snapshot to the `paired_extensions` prefs field (MYND-443,
/// `ext-foundation-handoff` task 7). Same write discipline as every IPC setter
/// (per-plugin write mutex + SYNC-6 hold guard). The caller passes the full
/// desired record set (`registry.to_paired_extensions()`); the codec sorts +
/// canonicalizes on encode. Called after a successful `pairing_accept` (a token
/// was issued) and after a revoke, so pairing survives a restart and a
/// revocation is durable.
///
/// Logs the record COUNT only — a token value + an extension id are vault-stable
/// correlation tags (see ../../AGENTS.md "Secret-handling logging discipline").
/// The token VALUES never reach the log surface.
pub async fn persist_paired_extensions_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    records: Vec<protocol::PairedExtension>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    let count = records.len();
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.paired_extensions = records;
        },
        io,
        host,
    )
    .await?;

    // COUNT only — never a token value / extension id (AS-low correlation tags).
    tracing::info!(event = "prefs_written", field = "paired_extensions", count);
    Ok(())
}

/// Slot::Unlocked-gated per-field setter for the
/// `screen_capture_protection` toggle. Acquires the per-plugin write
/// mutex, executes a read-modify-write under it, then **after** the
/// disk write succeeds calls `screen_capture::apply` for the native
/// side-effect. **Disk-then-native ordering is load-bearing**: if
/// the disk write fails, the native state is unchanged so UI / disk
/// never silently diverge (MYND-160 grill Q5.2 — story 16).
pub async fn set_screen_capture_protection_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    // Disk-side commit FIRST, under the mutex.
    set_screen_capture_protection_with_dir(&dir, state, hooks, enabled, io, host).await?;
    // Native side-effect SECOND, only on disk-side success (desktop-only;
    // mobile no-op through the hook).
    hooks.apply_screen_capture(enabled, "runtime_apply");
    Ok(())
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_screen_capture_protection<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    set_screen_capture_protection_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        enabled,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_screen_capture_protection`]. Performs the
/// disk-side commit (read-modify-write under the per-plugin mutex)
/// but NOT the native side-effect — tests assert the disk shape
/// without needing a `WebviewWindow`. Production callers MUST pair
/// this with `screen_capture::apply` per the critical ordering rule
/// captured in the Tauri-command wrapper above.
pub(crate) async fn set_screen_capture_protection_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.screen_capture_protection = enabled;
        },
        io,
        host,
    )
    .await?;

    tracing::info!(
        event = "prefs_written",
        field = "screen_capture_protection",
        value = enabled,
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `spell_enabled` toggle (MYND-267,
/// spell-checker epic). Read-modify-write under the per-plugin write mutex; no
/// native side-effect (like `set_deliberate_folders`). Always persists an
/// explicit `Some(enabled)` — the default-ON policy (SYNC-15) is a host
/// read-time concern, not a stored value. Non-load-bearing → no clamp.
pub async fn set_spell_enabled_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_spell_enabled_with_dir(&dir, state, hooks, enabled, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_spell_enabled<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    set_spell_enabled_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        enabled,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_spell_enabled`].
pub(crate) async fn set_spell_enabled_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.spell_enabled = Some(enabled);
        },
        io,
        host,
    )
    .await?;

    tracing::info!(
        event = "prefs_written",
        field = "spell_enabled",
        value = enabled
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `editor_line_numbers` toggle
/// (editor-line-numbers, MYND-314). Read-modify-write under the per-plugin write
/// mutex; no native side-effect (like `set_spell_enabled`). Always persists an
/// explicit `Some(enabled)` — the default-OFF policy (prose-first) is a host
/// read-time concern, not a stored value. Non-load-bearing → no clamp.
pub async fn set_editor_line_numbers_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_editor_line_numbers_with_dir(&dir, state, hooks, enabled, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_editor_line_numbers<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    set_editor_line_numbers_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        enabled,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_editor_line_numbers`].
pub(crate) async fn set_editor_line_numbers_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.editor_line_numbers = Some(enabled);
        },
        io,
        host,
    )
    .await?;

    tracing::info!(
        event = "prefs_written",
        field = "editor_line_numbers",
        value = enabled
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `editor_vim_mode` toggle
/// (vim-keyboard-mode, MYND-313). Read-modify-write under the per-plugin write
/// mutex; no native side-effect (like `set_editor_line_numbers`). Always persists
/// an explicit `Some(enabled)` — the default-OFF policy (modal editing is opt-in)
/// is a host read-time concern, not a stored value. Non-load-bearing → no clamp.
pub async fn set_editor_vim_mode_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_editor_vim_mode_with_dir(&dir, state, hooks, enabled, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_editor_vim_mode<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    set_editor_vim_mode_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        enabled,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_editor_vim_mode`].
pub(crate) async fn set_editor_vim_mode_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.editor_vim_mode = Some(enabled);
        },
        io,
        host,
    )
    .await?;

    tracing::info!(
        event = "prefs_written",
        field = "editor_vim_mode",
        value = enabled
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `archive_disabled` toggle (archive-disable,
/// MYND-…). Read-modify-write under the per-plugin write mutex; no native
/// side-effect (like `set_editor_line_numbers`). Always persists an explicit
/// `Some(enabled)` — the default-OFF policy (archiving enabled) is a host
/// read-time concern, not a stored value. Non-load-bearing → no clamp. The
/// auto-unarchive of existing archived notes when the toggle flips ON is a
/// WebView-side orchestration concern (runs before this setter); this command
/// only persists the flag.
pub async fn set_archive_disabled_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_archive_disabled_with_dir(&dir, state, hooks, enabled, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_archive_disabled<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    set_archive_disabled_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        enabled,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_archive_disabled`].
pub(crate) async fn set_archive_disabled_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.archive_disabled = Some(enabled);
        },
        io,
        host,
    )
    .await?;

    tracing::info!(
        event = "prefs_written",
        field = "archive_disabled",
        value = enabled
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the note-task marker's visibility
/// (MYND-613). Read-modify-write under the per-plugin write mutex; no native
/// side-effect. Omit-when-default keeps a vault that never touched it
/// byte-identical to a pre-feature `vault.prefs`. Non-load-bearing (it can at
/// worst show or hide a glyph) → no protective-envelope clamp.
pub async fn set_show_task_marker_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_show_task_marker_with_dir(&dir, state, hooks, enabled, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_show_task_marker<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    set_show_task_marker_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        enabled,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_show_task_marker`].
pub(crate) async fn set_show_task_marker_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.show_task_marker = enabled;
        },
        io,
        host,
    )
    .await?;

    tracing::info!(
        event = "prefs_written",
        field = "show_task_marker",
        value = enabled
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the folder-notes feature off-switch
/// (myne-md/myne#661). Read-modify-write under the per-plugin write mutex; no
/// native side-effect. This is a **presentation gate only**: it never rewrites
/// a note's `folder_index:` frontmatter, so a note keeping `folder_index: true`
/// while the feature is off is a correct, fully-reversible state. Omit-when-
/// default keeps a vault that never enabled folder notes byte-identical to a
/// pre-feature `vault.prefs`. Non-load-bearing (it can at worst show or hide a
/// sidebar affordance) → no protective-envelope clamp.
pub async fn set_folder_notes_enabled_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_folder_notes_enabled_with_dir(&dir, state, hooks, enabled, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_folder_notes_enabled<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    set_folder_notes_enabled_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        enabled,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_folder_notes_enabled`].
pub(crate) async fn set_folder_notes_enabled_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.folder_notes_enabled = enabled;
        },
        io,
        host,
    )
    .await?;

    tracing::info!(
        event = "prefs_written",
        field = "folder_notes_enabled",
        value = enabled
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for whether speech-to-text may run on this
/// vault's audio attachments (MYND-592). Shared / scalar-LWW: a bundled model
/// every client carries, so wanting the feature is a vault-level preference
/// rather than a device capability. Omit-when-default keeps an untouched vault
/// byte-identical to a pre-feature `vault.prefs`.
///
/// **Not** the enforcement point — the host-side gate re-reads the persisted
/// value at the top of `transcribe` rather than trusting a resident copy, so
/// this setter has no native side-effect and needs no lifecycle hook.
pub async fn set_transcription_enabled_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_transcription_enabled_with_dir(&dir, state, hooks, enabled, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_transcription_enabled<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    set_transcription_enabled_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        enabled,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_transcription_enabled`].
pub(crate) async fn set_transcription_enabled_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.transcription_enabled = enabled;
        },
        io,
        host,
    )
    .await?;

    tracing::info!(
        event = "prefs_written",
        field = "transcription_enabled",
        value = enabled
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for whether automatic on-device tag suggestion
/// runs on this vault's notes (MYND-651). Default-off, emitted on disk only
/// when `true`, so an untouched vault stays byte-identical to a pre-feature
/// `vault.prefs`. Shared / scalar-LWW like `transcription_enabled`: a bundled
/// task-model, so wanting the feature is a vault-level preference rather than a
/// device capability.
///
/// **Not** the enforcement point. The tag pass is gated on `ai_enabled` AND
/// this flag, both re-read host-side before the model is touched, so a WebView
/// that skips or forges this setter gains nothing — and in particular cannot
/// start inference on a vault whose AI opt-in is off.
pub async fn set_auto_tag_enabled_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_auto_tag_enabled_with_dir(&dir, state, hooks, enabled, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_auto_tag_enabled<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    set_auto_tag_enabled_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        enabled,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_auto_tag_enabled`].
pub(crate) async fn set_auto_tag_enabled_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.auto_tag_enabled = enabled;
        },
        io,
        host,
    )
    .await?;

    tracing::info!(
        event = "prefs_written",
        field = "auto_tag_enabled",
        value = enabled
    );
    Ok(())
}

/// `Slot::Unlocked`-gated setter for the **remote AI provider** the user named
/// (myne#415). `None` clears it, returning the arm to **unreachable** — not
/// merely disabled: with no provider selected there is no remote path to reach.
///
/// The value is a closed wire string validated host-side against the build's
/// own registry; an unrecognized name is refused rather than stored, so a
/// compromised WebView cannot park a value a future build would honour.
///
/// **Not the enforcement point.** The request path re-reads the provider, the
/// consent and the key before it sends, so a WebView that forges this setter
/// gains a stored string and nothing else.
pub async fn set_ai_provider_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    provider: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_ai_provider_with_dir(&dir, state, hooks, provider, io, host).await
}

/// IPC wrapper for [`set_ai_provider_from_host`].
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_ai_provider<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    provider: Option<String>,
) -> Result<(), PrefsWriteError> {
    set_ai_provider_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        provider,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// The providers this build knows how to reach. A closed list here rather than
/// a free-form string is what keeps a stored value from outrunning the code
/// that has to honour it.
pub const KNOWN_AI_PROVIDERS: &[&str] = &["ollama-cloud", "openrouter"];

/// Testable core of [`set_ai_provider`].
pub(crate) async fn set_ai_provider_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    provider: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    if let Some(ref name) = provider {
        if !KNOWN_AI_PROVIDERS.contains(&name.as_str()) {
            return Err(PrefsWriteError::InvalidValue);
        }
    }
    // Clearing the provider clears the consent and the key with it. Leaving a
    // key behind for a provider nobody selected is a credential with no owner
    // and no surface that shows it; leaving the consent behind would silently
    // pre-approve the NEXT provider the user picks, which is the one thing a
    // one-time consent must never do.
    let clearing = provider.is_none();
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            let changed = prefs.ai_provider != provider;
            prefs.ai_provider = provider.clone();
            // Clearing drops the key too: a credential for a provider nobody
            // selected is a credential with no owner and no surface that shows
            // it. Switching keeps nothing either — the new provider's key is a
            // different secret. The consent needs no clearing here at all: it
            // NAMES the provider it was given for, so a stale one simply stops
            // matching. Belt and braces, it is dropped anyway, because a value
            // that can only ever be wrong should not sit in the blob.
            if clearing || changed {
                prefs.ai_provider_key = None;
                prefs.ai_provider_consent = None;
                // And the chosen model, for the third time the same reason: it
                // names a model AT a provider. Every provider publishes its own
                // catalogue, so a selection carried across a switch is a name
                // the new provider has never heard of — and SYNC-24 ships no
                // fallback that would quietly paper over it.
                prefs.ai_provider_model = None;
            }
        },
        io,
        host,
    )
    .await?;

    // The NAME is loggable — it is a closed value from the list above, not user
    // input. The key never appears here or anywhere else (DENY list).
    tracing::info!(
        event = "prefs_written",
        field = "ai_provider",
        value = clearing
    );
    Ok(())
}

/// `Slot::Unlocked`-gated setter for the **meeting AI prompt** (meeting-ai).
/// `None` or an all-whitespace value clears it, restoring the built-in default
/// instruction; a non-empty value is stored verbatim and replaces the meeting
/// AI reduce instruction. Bounded in length so a compromised WebView cannot use
/// the blob as storage. Classified Shared / scalar last-write-wins
/// (`sync-protocol.md` 10.2), so the instruction reaches the account's other
/// devices. The value is user text, so it is never logged (DENY list).
pub async fn set_meeting_ai_prompt_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    prompt: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_meeting_ai_prompt_with_dir(&dir, state, hooks, prompt, io, host).await
}

/// IPC wrapper for [`set_meeting_ai_prompt_from_host`].
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_meeting_ai_prompt<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    prompt: Option<String>,
) -> Result<(), PrefsWriteError> {
    set_meeting_ai_prompt_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        prompt,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// The maximum stored meeting-AI prompt length, in bytes. A bound rather than a
/// shape: the value is free user text, so the only thing to keep in check is
/// that a compromised WebView cannot park an arbitrarily large blob here.
pub const MAX_MEETING_AI_PROMPT_LEN: usize = 4000;

/// Testable core of [`set_meeting_ai_prompt`].
pub(crate) async fn set_meeting_ai_prompt_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    prompt: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    let prompt = match prompt {
        // An all-whitespace value is a clear, not a stored blank that would
        // replace the default with an empty instruction.
        Some(p) if p.trim().is_empty() => None,
        Some(p) if p.len() > MAX_MEETING_AI_PROMPT_LEN => {
            return Err(PrefsWriteError::InvalidValue);
        }
        other => other,
    };
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.meeting_ai_prompt = prompt.clone();
        },
        io,
        host,
    )
    .await?;
    // The prompt is user text: the field name is logged, never the value.
    tracing::info!(event = "prefs_written", field = "meeting_ai_prompt");
    Ok(())
}

/// `Slot::Unlocked`-gated setter for the remote-provider consent
/// (myne#415, SYNC-22; device-local since myne-md/myne#456).
///
/// **A gate, not a display flag.** The request path checks it, so a client
/// whose UI never showed the screen still cannot send.
///
/// **The caller hands a PROVIDER NAME and this function stores the
/// device-scoped token.** The suffix is added here rather than by the caller so
/// there is one writer of the stored spelling: the gate compares for equality,
/// and a second spelling would be a silent refusal rather than an error anybody
/// sees. `provider_gate::CONSENT_DEVICE_SUFFIX` carries the whole argument for
/// why the token exists; in one line, a legacy bare-name value is what both
/// silently-re-routed populations hold, and the gate must not accept it.
pub async fn set_ai_provider_consent_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    granted_for: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    // The consent names WHO it was given to, so an unknown name is refused for
    // the same reason `set_ai_provider` refuses one: a consent recorded for a
    // provider this build cannot reach is a value the request path can only
    // ignore, and a future build might not.
    if let Some(ref name) = granted_for {
        if !KNOWN_AI_PROVIDERS.contains(&name.as_str()) {
            return Err(PrefsWriteError::InvalidValue);
        }
    }
    // Stored device-scoped, which is the form `provider_gate` requires: a bare
    // wire name is refused there, so writing one here would record a consent
    // that never opens the gate. `granted_for` is validated against
    // `KNOWN_AI_PROVIDERS` above, so the name reaching the grammar is known.
    let stored = granted_for
        .as_deref()
        .map(protocol::prefs::device_scoped_consent);
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    let present = granted_for.is_some();
    update_prefs_with_dir(
        &dir,
        state,
        hooks,
        |prefs| {
            prefs.ai_provider_consent = stored.clone();
        },
        io,
        host,
    )
    .await?;
    tracing::info!(
        event = "prefs_written",
        field = "ai_provider_consent",
        value = present
    );
    Ok(())
}

/// IPC wrapper for [`set_ai_provider_consent_from_host`].
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_ai_provider_consent<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    granted_for: Option<String>,
) -> Result<(), PrefsWriteError> {
    set_ai_provider_consent_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        granted_for,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// `Slot::Unlocked`-gated setter for the remote-provider API key (myne#415).
/// `None` **revokes** it.
///
/// The value goes **in** across IPC and never comes back out: `PrefsView`
/// marks the field `#[serde(skip_serializing)]`, and the UI reads
/// [`ai_provider_has_key`] instead. That asymmetry is the whole design — the
/// user has to be able to type a key, and nothing has to be able to read it
/// back.
///
/// Wrapped in `Zeroizing` on the first non-doc statement, like every other
/// secret that arrives over IPC (`src-tauri/AGENTS.md`). Never logged.
pub async fn set_ai_provider_key_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    key: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let key = key.map(zeroize::Zeroizing::new);
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    // An all-whitespace key is a cleared key, not a stored blank — otherwise a
    // user who selected the field and hit delete would leave the arm "has a
    // key" and every request would fail with an auth error they cannot see.
    // The trimmed copy is wrapped too (myne-md/myne#444). It used to be a plain
    // `String`, so the careful `Zeroizing` on the line above bought nothing past
    // this point: `k.trim().to_string()` allocates a second buffer holding the
    // same credential, and that one was the copy that reached the blob.
    let stored = key
        .as_deref()
        .map(|k| zeroize::Zeroizing::new(k.trim().to_string()))
        .filter(|k| !k.is_empty());
    let present = stored.is_some();
    update_prefs_with_dir(
        &dir,
        state,
        hooks,
        |prefs| {
            prefs.ai_provider_key = stored.clone();
        },
        io,
        host,
    )
    .await?;
    // PRESENCE only. Not the value, not its length — a length is a partial
    // attempt-counter leak of exactly the kind the DENY list names.
    tracing::info!(
        event = "prefs_written",
        field = "ai_provider_key",
        value = present
    );
    Ok(())
}

/// IPC wrapper for [`set_ai_provider_key_from_host`].
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_ai_provider_key<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    key: Option<String>,
) -> Result<(), PrefsWriteError> {
    set_ai_provider_key_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        key,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// `Slot::Unlocked`-gated setter for **which model** at the named provider
/// answers (myne#415, SYNC-24). `None` clears the selection.
///
/// **Unvalidated against a list, deliberately.** Every sibling setter in this
/// group checks its value against `KNOWN_AI_PROVIDERS`, and this one cannot:
/// the valid set is whatever the provider published a moment ago, which is the
/// entire content of SYNC-24 ("no hardcoded per-provider model default — the
/// user picks from the list the provider itself reports"). A compiled-in
/// allowlist here would re-introduce exactly the rot that resolution rejected,
/// and it would buy nothing — this value chooses among a provider's own
/// catalogue, it cannot name a *destination*, which is the property the
/// compiled-in host table protects.
///
/// What is bounded instead is the **length**, so a compromised WebView cannot
/// park an unbounded string in the blob, and an all-whitespace value is treated
/// as a clear rather than stored as a blank that would fail every request.
pub async fn set_ai_provider_model_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    model: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    // A provider's model identifier is a short path-like token
    // ("meta-llama/llama-3.1-8b-instruct"). The cap is generous enough that no
    // real name meets it and small enough that the blob cannot be used as
    // storage.
    const MAX_MODEL_LEN: usize = 200;
    let model = match model {
        Some(ref m) if m.trim().is_empty() => None,
        Some(m) => {
            if m.len() > MAX_MODEL_LEN {
                return Err(PrefsWriteError::InvalidValue);
            }
            Some(m.trim().to_string())
        }
        None => None,
    };
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    let present = model.is_some();
    update_prefs_with_dir(
        &dir,
        state,
        hooks,
        |prefs| {
            prefs.ai_provider_model = model.clone();
        },
        io,
        host,
    )
    .await?;
    // Loggable as a PRESENCE only. The name itself is published by the provider
    // and is not a secret, but it is a per-account configuration detail with no
    // diagnostic value that the boolean does not already carry.
    tracing::info!(
        event = "prefs_written",
        field = "ai_provider_model",
        value = present
    );
    Ok(())
}

/// IPC wrapper for [`set_ai_provider_model_from_host`].
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_ai_provider_model<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    model: Option<String>,
) -> Result<(), PrefsWriteError> {
    set_ai_provider_model_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        model,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Whether a remote-provider API key is stored — **the boolean the UI reads
/// instead of the key** (myne#415).
///
/// It exists because `prefs_read` serializes the whole `PrefsView` and the key
/// is skipped there, so the panel has no way to render "a key is set" from that
/// payload — and must not be given one. Same split the clipper already uses:
/// the panel gets ids and timestamps from a dedicated command, never the token.
///
/// Answers `false` rather than an error when the vault is locked or the prefs
/// blob is unreadable: "no key" is the safe answer for a control whose only
/// job is to choose between "Add key" and "Replace key".
pub async fn ai_provider_has_key_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    io: &dyn crate::vault_io::VaultIo,
) -> bool {
    let Ok(dir) = vault_dir_from_host(host, state.active_vault_id().await) else {
        return false;
    };
    prefs_read_with_dir(&dir, state, io)
        .await
        .ok()
        .and_then(|p| p.ai_provider_key)
        .is_some()
}

/// IPC wrapper for [`ai_provider_has_key_from_host`].
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn ai_provider_has_key<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<bool, PrefsWriteError> {
    Ok(ai_provider_has_key_from_host(
        &TauriHost::new(app),
        state.inner(),
        &crate::vault_io::StdVaultIo,
    )
    .await)
}

/// Slot::Unlocked-gated setter for whether THIS DEVICE shows task reminders
/// (MYND-618). Device-local: whether a given machine should be interrupted is a
/// property of that machine, so it never syncs. Omit-when-default keeps an
/// untouched vault byte-identical. Non-load-bearing (it can at worst silence or
/// enable a notification) → no protective-envelope clamp.
pub async fn set_reminders_enabled_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_reminders_enabled_with_dir(&dir, state, hooks, enabled, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_reminders_enabled<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    set_reminders_enabled_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        enabled,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_reminders_enabled`].
pub(crate) async fn set_reminders_enabled_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.reminders_enabled = enabled;
        },
        io,
        host,
    )
    .await?;

    tracing::info!(
        event = "prefs_written",
        field = "reminders_enabled",
        value = enabled
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for how many days ahead this device registers
/// reminders with the OS (MYND-618); `None` falls back to the client's built-in
/// horizon. Device-local for the same reason as `reminders_enabled`. The horizon
/// is a PRIVACY bound before a resource one — pending times leave the AEAD
/// envelope and sit in OS-owned plaintext (`threat-model.md` §7) — so it is
/// stored verbatim with no clamp; clamping here would silently disagree with
/// what the settings UI showed.
pub async fn set_reminder_horizon_days_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    days: Option<u32>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_reminder_horizon_days_with_dir(&dir, state, hooks, days, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_reminder_horizon_days<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    days: Option<u32>,
) -> Result<(), PrefsWriteError> {
    set_reminder_horizon_days_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        days,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_reminder_horizon_days`].
pub(crate) async fn set_reminder_horizon_days_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    days: Option<u32>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.reminder_horizon_days = days;
        },
        io,
        host,
    )
    .await?;

    tracing::info!(
        event = "prefs_written",
        field = "reminder_horizon_days",
        value = days
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `active_workspace` slot id (MYND-308) —
/// the workspace slot the editor restores on unlock, or `None` to clear back to
/// the host default. Read-modify-write under the per-plugin write mutex; no
/// native side-effect. A free `Option<String>` stored verbatim (the
/// `set_custom_theme` precedent class); non-load-bearing → no clamp.
pub async fn set_active_workspace_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    value: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_typography_field_with_dir(
        &dir,
        state,
        hooks,
        "active_workspace",
        |p| {
            p.active_workspace = value;
        },
        io,
        host,
    )
    .await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_active_workspace<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    value: Option<String>,
) -> Result<(), PrefsWriteError> {
    set_active_workspace_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        value,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Slot::Unlocked-gated setter for the `editor_default_view_mode` preset
/// (MYND-299) — `live`/`reading`/`source`, or `None` to clear to the host
/// default. Read-modify-write under the write mutex; no native side-effect. A
/// free `Option<String>` (the `set_editor_content_width` precedent class); the
/// enum interpretation + unknown→default fallback live on the client.
pub async fn set_editor_default_view_mode_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    value: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_typography_field_with_dir(
        &dir,
        state,
        hooks,
        "editor_default_view_mode",
        |p| {
            p.editor_default_view_mode = value;
        },
        io,
        host,
    )
    .await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_editor_default_view_mode<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    value: Option<String>,
) -> Result<(), PrefsWriteError> {
    set_editor_default_view_mode_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        value,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Slot::Unlocked-gated setter for the `editor_focus_dim_inactive` toggle
/// (MYND-348). Read-modify-write under the per-plugin write mutex; no native
/// side-effect (like `set_editor_line_numbers`). Always persists an explicit
/// `Some(enabled)` — the host applies the default focus-mode policy at read time.
/// Non-load-bearing → no clamp.
pub async fn set_editor_focus_dim_inactive_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_editor_focus_dim_inactive_with_dir(&dir, state, hooks, enabled, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_editor_focus_dim_inactive<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    set_editor_focus_dim_inactive_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        enabled,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_editor_focus_dim_inactive`].
pub(crate) async fn set_editor_focus_dim_inactive_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.editor_focus_dim_inactive = Some(enabled);
        },
        io,
        host,
    )
    .await?;

    tracing::info!(
        event = "prefs_written",
        field = "editor_focus_dim_inactive",
        value = enabled
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `editor_focus_typewriter` toggle
/// (MYND-348). Read-modify-write under the per-plugin write mutex; no native
/// side-effect (like `set_editor_line_numbers`). Always persists an explicit
/// `Some(enabled)` — the host applies the default focus-mode policy at read time.
/// Non-load-bearing → no clamp.
pub async fn set_editor_focus_typewriter_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_editor_focus_typewriter_with_dir(&dir, state, hooks, enabled, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_editor_focus_typewriter<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    set_editor_focus_typewriter_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        enabled,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_editor_focus_typewriter`].
pub(crate) async fn set_editor_focus_typewriter_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.editor_focus_typewriter = Some(enabled);
        },
        io,
        host,
    )
    .await?;

    tracing::info!(
        event = "prefs_written",
        field = "editor_focus_typewriter",
        value = enabled
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `show_note_timestamps` toggle
/// (sidebar-note-timestamps feature). Read-modify-write under the per-plugin
/// write mutex; no native side-effect (like `set_spell_enabled`). The field is a
/// plain `bool` (default `true`), so this stores the value directly (no `Some`
/// wrap); the codec omits it on disk when `true`, so toggling back ON re-encodes
/// byte-identical to a pre-feature vault.prefs. Non-load-bearing → no clamp.
pub async fn set_show_note_timestamps_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_show_note_timestamps_with_dir(&dir, state, hooks, enabled, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_show_note_timestamps<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    set_show_note_timestamps_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        enabled,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_show_note_timestamps`].
pub(crate) async fn set_show_note_timestamps_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.show_note_timestamps = enabled;
        },
        io,
        host,
    )
    .await?;

    tracing::info!(
        event = "prefs_written",
        field = "show_note_timestamps",
        value = enabled
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `spell_languages` set (MYND-267 /
/// SYNC-11 union). Read-modify-write under the per-plugin write mutex; no
/// native side-effect. The caller passes the full desired set; the codec
/// NFC-normalizes + sorts + exact-dedupes for canonical byte-stability
/// (folded-identity dedup is the caller's job). Non-load-bearing → no clamp.
/// Logs the COUNT only — the specific language tags are mildly fingerprintable,
/// so they stay off the log surface (mirrors `set_deliberate_folders`).
pub async fn set_spell_languages_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    mutation: SetMutation,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<u32, PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_spell_languages_with_dir(&dir, state, hooks, mutation, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_spell_languages<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    mutation: SetMutation,
) -> Result<u32, PrefsWriteError> {
    set_spell_languages_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        mutation,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_spell_languages`].
pub(crate) async fn set_spell_languages_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    mutation: SetMutation,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<u32, PrefsWriteError> {
    let (added, removed) = (mutation.add.len(), mutation.remove.len());
    // The closure runs inside the write mutex and cannot return a value,
    // so the refusal count comes back through a cell.
    let mut refused: usize = 0;
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            // `folded` is no longer passed: `apply_set_mutation` reads the
            // field's identity rule off `CLASSIFICATION` itself, so a swapped
            // literal here is no longer expressible (myne-md/myne#613).
            refused = apply_set_mutation(prefs, "spell_languages", &mutation);
        },
        io,
        host,
    )
    .await?;

    tracing::info!(
        event = "prefs_written",
        field = "spell_languages",
        added,
        removed,
        refused,
    );
    Ok(refused as u32)
}

/// Slot::Unlocked-gated setter for ONE command's keymap override (hotkeys
/// epic, MYND-304). Three states via `Option<Vec<String>>`:
/// - `Some(non-empty)` → override the command to those chords;
/// - `Some(empty)` → explicit-unbind (the `[]` state — the command has no shortcut);
/// - `None` → remove the override entry (revert to the in-code default).
///
/// Read-modify-write under the per-plugin write mutex; no native side-effect.
/// The codec NFC-sorts + exact-dedupes each chord set on encode (set-canonical),
/// so the caller passes the raw desired set. **Non-load-bearing** (a tampered /
/// replayed value can at worst rebind or drop a shortcut; every command stays
/// reachable via the palette) — no protective-envelope clamp. Logs the
/// remove/set discriminator + chord count only — never the command id or the
/// chord strings (a user's specific binding is mildly fingerprintable, like
/// `spell_languages`). Inherits the main-window-only invariant of the other
/// `set_*` setters.
pub async fn set_keymap_binding_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    command_id: String,
    chords: Option<Vec<String>>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_keymap_binding_with_dir(&dir, state, hooks, command_id, chords, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_keymap_binding<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    command_id: String,
    chords: Option<Vec<String>>,
) -> Result<(), PrefsWriteError> {
    set_keymap_binding_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        command_id,
        chords,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_keymap_binding`].
pub(crate) async fn set_keymap_binding_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    command_id: String,
    chords: Option<Vec<String>>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    let removed = chords.is_none();
    let count = chords.as_ref().map(Vec::len).unwrap_or(0);
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| match chords {
            Some(c) => {
                prefs.keymap.insert(command_id, c);
            }
            None => {
                prefs.keymap.remove(&command_id);
            }
        },
        io,
        host,
    )
    .await?;

    tracing::info!(event = "prefs_written", field = "keymap", removed, count);
    Ok(())
}

/// Slot::Unlocked-gated setter for the `deliberate_folders` set
/// (MYND-144 — the carrier for empty / deliberately-created folders in
/// the virtual-folder model). Read-modify-write under the per-plugin
/// write mutex. **No native side-effect** (unlike
/// `set_screen_capture_protection`) — purely a disk commit, so the
/// disk-then-native ordering rule does not apply here.
///
/// The caller passes a [`SetMutation`], never a whole set. That is the myne#613
/// fix rather than a refactor: a whole-set write from a stale view reads to
/// `stamp_changed_shared_fields` as an intentional deletion of every entry the
/// view never saw, so a lost update became a distributed delete. The mutation is
/// applied to the CURRENT stored set, inside this write's mutex, which is what
/// makes the stamper's `before \ after` diff sound.
///
/// Folded-identity dedup is the caller's job for the DISPLAY form; the identity
/// a removal matches on is taken from the field's own classification row.
pub async fn set_deliberate_folders_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    mutation: SetMutation,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<u32, PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_deliberate_folders_with_dir(&dir, state, hooks, mutation, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_deliberate_folders<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    mutation: SetMutation,
) -> Result<u32, PrefsWriteError> {
    set_deliberate_folders_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        mutation,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_deliberate_folders`].
pub async fn set_deliberate_folders_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    mutation: SetMutation,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<u32, PrefsWriteError> {
    let (added, removed) = (mutation.add.len(), mutation.remove.len());
    // The closure runs inside the write mutex and cannot return a value,
    // so the refusal count comes back through a cell.
    let mut refused: usize = 0;
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            // `folded` is no longer passed: `apply_set_mutation` reads the
            // field's identity rule off `CLASSIFICATION` itself, so a swapped
            // literal here is no longer expressible (myne-md/myne#613).
            refused = apply_set_mutation(prefs, "deliberate_folders", &mutation);
        },
        io,
        host,
    )
    .await?;

    // Folder COUNT only — never the paths (folder structure is AS3
    // Sensitive; see ../../AGENTS.md "Secret-handling logging discipline").
    tracing::info!(
        event = "prefs_written",
        field = "deliberate_folders",
        added,
        removed,
        refused,
    );
    Ok(refused as u32)
}

/// Ensure `folder` is registered as a deliberate folder, refusing to resurrect a
/// removal the user made (myne-md/myne#850 task 3).
///
/// **The agent's folder-ensuring seam**, and a separate call from the setting
/// setter rather than folded into it, because the two answer different
/// questions. The setter's own registration goes through the user-act route and
/// wins over a removal, which is what a folder picker needs. This one is a
/// repair: the model chose the folder, and the ensure must not bring back
/// something the user deleted.
///
/// Returns whether the folder is registered. `false` means a removal of it is on
/// record and nothing was written, which the caller reports as a refusal: a
/// folder that is not registered does not appear in the sidebar until its first
/// note, so a setting that named it and skipped this would look like it did
/// nothing.
pub async fn ensure_deliberate_folder_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    folder: String,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<bool, PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    ensure_deliberate_folder_with_dir(&dir, state, hooks, folder, io, host).await
}

/// Testable core of [`ensure_deliberate_folder_from_host`].
pub(crate) async fn ensure_deliberate_folder_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    folder: String,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<bool, PrefsWriteError> {
    // The closure runs inside the write mutex and cannot return a value, so the
    // answer comes back through a cell, the `set_deliberate_folders` shape.
    let mut registered = false;
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            registered =
                crate::plugins::prefs::set_mutation::ensure_deliberate_folder(prefs, &folder);
        },
        io,
        host,
    )
    .await?;

    // Field name only, never the path (folder structure is AS3 Sensitive; see
    // ../../AGENTS.md "Secret-handling logging discipline").
    tracing::info!(event = "prefs_written", field = "deliberate_folders");
    Ok(registered)
}

/// Slot::Unlocked-gated setter for the `archived_folders` set (folder-archive)
/// — folders archived as a unit (their subtree drops out of the working-set
/// sidebar/tree while the notes stay resolvable). Read-modify-write under the
/// per-plugin write mutex. **No native side-effect** (a pure disk commit, same
/// shape as [`set_deliberate_folders`] — unlike `set_ai_excluded_folders` there
/// is no AI runtime to reconcile).
///
/// Takes a [`SetMutation`] rather than a whole set, for the reason spelled out
/// on [`set_deliberate_folders_from_host`]. `archived_folders` propagates
/// removals, so a removal here stamps a clock and reaches every device: clearing
/// this set is a vault-wide act, not a device-local one.
pub async fn set_archived_folders_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    mutation: SetMutation,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<u32, PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_archived_folders_with_dir(&dir, state, hooks, mutation, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_archived_folders<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    mutation: SetMutation,
) -> Result<u32, PrefsWriteError> {
    set_archived_folders_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        mutation,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_archived_folders`].
pub async fn set_archived_folders_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    mutation: SetMutation,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<u32, PrefsWriteError> {
    let (added, removed) = (mutation.add.len(), mutation.remove.len());
    // The closure runs inside the write mutex and cannot return a value,
    // so the refusal count comes back through a cell.
    let mut refused: usize = 0;
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            // `folded` is no longer passed: `apply_set_mutation` reads the
            // field's identity rule off `CLASSIFICATION` itself, so a swapped
            // literal here is no longer expressible (myne-md/myne#613).
            refused = apply_set_mutation(prefs, "archived_folders", &mutation);
        },
        io,
        host,
    )
    .await?;

    // Folder COUNT only — never the paths (folder structure is AS3
    // Sensitive; see the `set_deliberate_folders` note + ../../AGENTS.md).
    tracing::info!(
        event = "prefs_written",
        field = "archived_folders",
        added,
        removed,
        refused,
    );
    Ok(refused as u32)
}

/// Slot::Unlocked-gated setter for the `ai_enabled` AI opt-in toggle (local-ai
/// epic, ai-ux-surface MYND-408, SYNC-12). Read-modify-write under the
/// per-plugin write mutex; **no native side-effect** (same shape as
/// `set_deliberate_folders`). Per-vault + encrypted in `vault.prefs` (the
/// at-rest "uses AI" fingerprint never leaks).
pub async fn set_ai_enabled_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    // Disk-side commit, under the mutex. The new policy needs no runtime push:
    // the inference seam re-reads `vault.prefs` at request time, and
    // `ai_excluded_folders` no longer has a resident index to purge.
    set_ai_enabled_with_dir(&dir, state, hooks, enabled, io, host).await?;
    Ok(())
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_ai_enabled<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    set_ai_enabled_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        enabled,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_ai_enabled`].
pub(crate) async fn set_ai_enabled_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.ai_enabled = enabled;
        },
        io,
        host,
    )
    .await?;

    tracing::info!(event = "prefs_written", field = "ai_enabled", enabled);
    Ok(())
}

/// Slot::Unlocked-gated setter for the `attachment_ocr_enabled` toggle
/// (MYND-441) — whether attachment text extraction may read images and scanned
/// PDFs. Read-modify-write under the per-plugin write mutex; **no native
/// side-effect**, exactly like [`set_ai_enabled`].
///
/// Turning it off stops the background extraction worker on the next drain but
/// never deletes cached results, so toggling costs the user nothing. Device-local
/// (`sync-protocol.md` §10.2): per-device compute budget, so a phone can opt out
/// without disabling OCR on the desktop.
pub async fn set_attachment_ocr_enabled_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_attachment_ocr_enabled_with_dir(&dir, state, hooks, enabled, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_attachment_ocr_enabled<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    set_attachment_ocr_enabled_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        enabled,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_attachment_ocr_enabled`].
pub(crate) async fn set_attachment_ocr_enabled_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.attachment_ocr_enabled = enabled;
        },
        io,
        host,
    )
    .await?;

    tracing::info!(
        event = "prefs_written",
        field = "attachment_ocr_enabled",
        enabled
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for `chat_history_budget` (myne-md/myne#617):
/// how many characters of visible chat history an agent run may be seeded with.
///
/// **The clamp is HERE, at the write, and that placement is the control.**
/// `MAX_HISTORY_BUDGET` bounds how much of the user's plaintext one run can
/// send to a provider, multiplied by the loop's iteration ceiling, and TB13
/// records that no other per-run volume cap exists. A bound applied in the
/// settings input instead would be a host-side rule whose trigger came from the
/// caller, which is the exact shape `apply.rs` already learned about itself: one
/// field away from off. Any path that reaches this command gets the same
/// ceiling, including one that never rendered a control.
///
/// `None` clears the override and returns the host to its own default.
pub async fn set_chat_history_budget_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    budget: Option<u32>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_chat_history_budget_with_dir(&dir, state, hooks, budget, io, host).await
}

/// IPC wrapper. Delegates; this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_chat_history_budget<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    budget: Option<u32>,
) -> Result<(), PrefsWriteError> {
    set_chat_history_budget_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        budget,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_chat_history_budget`].
pub(crate) async fn set_chat_history_budget_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    budget: Option<u32>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    let clamped = budget.map(|b| b.min(crate::plugins::agent::history::MAX_HISTORY_BUDGET as u32));
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.chat_history_budget = clamped;
        },
        io,
        host,
    )
    .await?;

    // The VALUE is a bound the user chose, not content, so it is safe to log
    // and useful when a run's cost is being read back.
    //
    // `value = clamped`, matching `set_reminder_horizon_days` rather than
    // inventing a field name, and carrying the `Option` rather than flattening
    // it: `unwrap_or(0)` made "unset" and an explicit zero log identically, and
    // zero is a real distinct choice here ("seed nothing") rather than an
    // absence.
    tracing::info!(
        event = "prefs_written",
        field = "chat_history_budget",
        value = ?clamped
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `developer_mode` toggle (MYND-593,
/// `developer-mode` feature task 3) — the gate the AI opt-in and the local-model
/// override pickers sit behind. Read-modify-write under the per-plugin write
/// mutex; **no native side-effect**, same disk-only shape as
/// [`set_attachment_ocr_enabled`]. Nothing consumes this field yet — the
/// host-side effective-enabled conjunction and the model-path rejection are
/// task 4's territory; this setter only persists the flag.
pub async fn set_developer_mode_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_developer_mode_with_dir(&dir, state, hooks, enabled, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_developer_mode<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    set_developer_mode_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        enabled,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_developer_mode`].
pub(crate) async fn set_developer_mode_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.developer_mode = enabled;
        },
        io,
        host,
    )
    .await?;

    tracing::info!(event = "prefs_written", field = "developer_mode", enabled);
    Ok(())
}

/// Slot::Unlocked-gated setter for the `attachment_compression_enabled`
/// toggle — whether an imported image attachment is downscaled/re-encoded on
/// ingest. Read-modify-write under the per-plugin write mutex; **no native
/// side-effect**, exactly like [`set_attachment_ocr_enabled`].
///
/// Shared (`sync-protocol.md` §10.2), unlike its OCR/AI neighbours: this is a
/// content-fidelity switch with a vault-wide, irreversible effect (a
/// compressed attachment's original bytes are gone), not a per-device
/// compute-budget switch, so the switch must have the same reach as the
/// effect. Toggling it off affects only attachments imported *after* the
/// change; nothing already stored is read or rewritten.
pub async fn set_attachment_compression_enabled_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_attachment_compression_enabled_with_dir(&dir, state, hooks, enabled, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_attachment_compression_enabled<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    set_attachment_compression_enabled_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        enabled,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_attachment_compression_enabled`].
pub(crate) async fn set_attachment_compression_enabled_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.attachment_compression_enabled = enabled;
        },
        io,
        host,
    )
    .await?;

    tracing::info!(
        event = "prefs_written",
        field = "attachment_compression_enabled",
        enabled
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `ai_excluded_folders` set (local-ai
/// epic, ai-ux-surface MYND-408, SYNC-14) — folders the AI never reads/indexes.
/// Same canonical set encoding as `deliberate_folders`; direct mirror of
/// [`set_deliberate_folders`] (read-modify-write, no native side-effect).
pub async fn set_ai_excluded_folders_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    mutation: SetMutation,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<u32, PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    // Disk-side commit, under the mutex. The new policy needs no runtime push:
    // the inference seam re-reads `vault.prefs` at request time, and
    // `ai_excluded_folders` no longer has a resident index to purge.
    let refused = set_ai_excluded_folders_with_dir(&dir, state, hooks, mutation, io, host).await?;
    Ok(refused)
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_ai_excluded_folders<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    mutation: SetMutation,
) -> Result<u32, PrefsWriteError> {
    set_ai_excluded_folders_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        mutation,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_ai_excluded_folders`].
pub(crate) async fn set_ai_excluded_folders_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    mutation: SetMutation,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<u32, PrefsWriteError> {
    let (added, removed) = (mutation.add.len(), mutation.remove.len());
    // The closure runs inside the write mutex and cannot return a value,
    // so the refusal count comes back through a cell.
    let mut refused: usize = 0;
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            // `folded` is no longer passed: `apply_set_mutation` reads the
            // field's identity rule off `CLASSIFICATION` itself, so a swapped
            // literal here is no longer expressible (myne-md/myne#613).
            refused = apply_set_mutation(prefs, "ai_excluded_folders", &mutation);
        },
        io,
        host,
    )
    .await?;

    // Folder COUNT only — never the paths (AS3 Sensitive; see the
    // `set_deliberate_folders` note + ../../AGENTS.md logging discipline).
    tracing::info!(
        event = "prefs_written",
        field = "ai_excluded_folders",
        added,
        removed,
        refused,
    );
    Ok(refused as u32)
}

/// Slot::Unlocked-gated setter for the `cli_enabled` CLI terminal-access door
/// toggle (myne-cli epic, MYND-490; `cli-thin-client` task 2). Read-modify-write
/// under the per-plugin write mutex; **no native side-effect** — same shape as
/// [`set_archive_disabled`]. Opening/closing the actual socket in response to
/// this toggle (plus the vault's unlock state) is the task-3 lifecycle's job,
/// not this setter's; this command only persists the flag.
pub async fn set_cli_enabled_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_cli_enabled_with_dir(&dir, state, hooks, enabled, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_cli_enabled<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    enabled: bool,
) -> Result<(), PrefsWriteError> {
    set_cli_enabled_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        enabled,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_cli_enabled`].
pub(crate) async fn set_cli_enabled_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    enabled: bool,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.cli_enabled = enabled;
        },
        io,
        host,
    )
    .await?;

    tracing::info!(event = "prefs_written", field = "cli_enabled", enabled);
    Ok(())
}

/// Slot::Unlocked-gated setter for the `cli_excluded_folders` set (myne-cli
/// epic, MYND-490; `cli-thin-client` task 2) — folders the CLI door never
/// reaches. Same canonical set encoding as `deliberate_folders` /
/// `ai_excluded_folders`; direct mirror of [`set_ai_excluded_folders`]
/// (read-modify-write, no native side-effect — enforcing the exclusion is
/// task 5's job, not this setter's).
pub async fn set_cli_excluded_folders_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    mutation: SetMutation,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<u32, PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_cli_excluded_folders_with_dir(&dir, state, hooks, mutation, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_cli_excluded_folders<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    mutation: SetMutation,
) -> Result<u32, PrefsWriteError> {
    set_cli_excluded_folders_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        mutation,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_cli_excluded_folders`].
pub(crate) async fn set_cli_excluded_folders_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    mutation: SetMutation,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<u32, PrefsWriteError> {
    let (added, removed) = (mutation.add.len(), mutation.remove.len());
    // The closure runs inside the write mutex and cannot return a value,
    // so the refusal count comes back through a cell.
    let mut refused: usize = 0;
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            // `folded` is no longer passed: `apply_set_mutation` reads the
            // field's identity rule off `CLASSIFICATION` itself, so a swapped
            // literal here is no longer expressible (myne-md/myne#613).
            refused = apply_set_mutation(prefs, "cli_excluded_folders", &mutation);
        },
        io,
        host,
    )
    .await?;

    // Folder COUNT only — never the paths (AS3 Sensitive; see the
    // `set_deliberate_folders` note + ../../AGENTS.md logging discipline).
    tracing::info!(
        event = "prefs_written",
        field = "cli_excluded_folders",
        added,
        removed,
        refused,
    );
    Ok(refused as u32)
}

/// Slot::Unlocked-gated setter for the `cli_rate_limit_disabled` toggle
/// (myne-cli epic, MYND-490; `cli-thin-client` task 2). Read-modify-write
/// under the per-plugin write mutex; **no native side-effect** (the task-3
/// socket reads the current value on the next request rather than being
/// pushed to). Always persists an explicit `Some(disabled)` — the
/// `set_archive_disabled` precedent — because the default-ON rate limit is a
/// host read-time concern, not a stored value. Non-load-bearing → no clamp.
pub async fn set_cli_rate_limit_disabled_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    disabled: bool,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_cli_rate_limit_disabled_with_dir(&dir, state, hooks, disabled, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_cli_rate_limit_disabled<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    disabled: bool,
) -> Result<(), PrefsWriteError> {
    set_cli_rate_limit_disabled_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        disabled,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_cli_rate_limit_disabled`].
pub(crate) async fn set_cli_rate_limit_disabled_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    disabled: bool,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.cli_rate_limit_disabled = Some(disabled);
        },
        io,
        host,
    )
    .await?;

    tracing::info!(
        event = "prefs_written",
        field = "cli_rate_limit_disabled",
        disabled
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `item_order` sequence — the unified
/// manual sidebar order across the interleaved file-tree — a **container-keyed
/// map** (container path → ordered child sequence of note UUIDs + child folder
/// paths, MYND-183 + MYND-596, superseding the old flat list). Read-modify-write
/// under the per-plugin write mutex; **no native side-effect** (same shape as
/// `set_deliberate_folders`). The caller passes the full desired map; each
/// container's sequence is written verbatim (order IS the payload,
/// `protocol::PrefsView::item_order`), and the central write path stamps an
/// `item_order/<container>` LWW clock for each changed container (§10.2.1), so a
/// reorder in one folder never clobbers a concurrent reorder in another.
pub async fn set_item_order_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    order: std::collections::BTreeMap<String, Vec<String>>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_item_order_with_dir(&dir, state, hooks, order, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_item_order<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    order: std::collections::BTreeMap<String, Vec<String>>,
) -> Result<(), PrefsWriteError> {
    set_item_order_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        order,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_item_order`].
pub(crate) async fn set_item_order_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    order: std::collections::BTreeMap<String, Vec<String>>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    // COUNTS only, computed before the value is moved into the closure — never
    // the container paths / item IDs (note_id is a per-note vault-stable
    // correlation tag, folder paths are AS3 Sensitive; see ../../AGENTS.md
    // "Secret-handling logging discipline").
    let containers = order.len();
    let items: usize = order.values().map(Vec::len).sum();
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.item_order = order;
        },
        io,
        host,
    )
    .await?;

    tracing::info!(
        event = "prefs_written",
        field = "item_order",
        containers,
        items
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `hidden_bar_items` set — the bottom-bar
/// element ids the user chose to hide via the bar's right-click menu (bottom-bar
/// customization). Read-modify-write under the per-plugin write mutex; **no
/// native side-effect** (same shape as `set_item_order`). The caller passes the
/// full desired set; the codec canonicalizes it (sorted + exact-deduped) on
/// encode (`protocol::PrefsView::hidden_bar_items`). An empty set is the default
/// (bar fully visible) and encodes to byte-identical-to-pre-feature.
pub async fn set_hidden_bar_items_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    items: Vec<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_hidden_bar_items_with_dir(&dir, state, hooks, items, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_hidden_bar_items<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    items: Vec<String>,
) -> Result<(), PrefsWriteError> {
    set_hidden_bar_items_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        items,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_hidden_bar_items`].
pub(crate) async fn set_hidden_bar_items_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    items: Vec<String>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    let count = items.len();
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.hidden_bar_items = items;
        },
        io,
        host,
    )
    .await?;

    // COUNT only — the ids are a non-secret closed UI vocabulary, but stay
    // consistent with the other prefs setters' count-only discipline.
    tracing::info!(event = "prefs_written", field = "hidden_bar_items", count,);
    Ok(())
}

/// Slot::Unlocked-gated save/edit (upsert-by-id) of one saved view (MYND-273,
/// Saved Views epic). Read-modify-write under the per-plugin write mutex; **no
/// native side-effect** (same shape as `set_item_order`). "Save" and "edit" are
/// one operation: the view REPLACES any existing entry with the same `id`, else
/// it is appended (so editing never creates a duplicate). The 64 KiB §9.5.4
/// prefs cap is enforced by `encode_prefs_blob` BEFORE the atomic write, so an
/// over-cap save fails `PrefsEncodeFailed` and leaves the on-disk prefs
/// untouched (story 13). Logs the view COUNT only — a view's name / filter /
/// referenced property is AS3-Sensitive and never reaches the log surface (see
/// ../../AGENTS.md "Secret-handling logging discipline").
pub async fn upsert_saved_view_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    view: SavedView,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    upsert_saved_view_with_dir(&dir, state, hooks, view, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn upsert_saved_view<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    view: SavedView,
) -> Result<(), PrefsWriteError> {
    upsert_saved_view_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        view,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`upsert_saved_view`].
pub(crate) async fn upsert_saved_view_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    view: SavedView,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    let mut count = 0usize;
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            // Upsert by id: replace in place, else append. No duplicate ids.
            match prefs.saved_views.iter_mut().find(|v| v.id == view.id) {
                Some(existing) => *existing = view,
                None => prefs.saved_views.push(view),
            }
            count = prefs.saved_views.len();
        },
        io,
        host,
    )
    .await?;

    // COUNT only — never a view name / filter / property (AS3-Sensitive).
    tracing::info!(event = "prefs_written", field = "saved_views", count);
    Ok(())
}

/// Slot::Unlocked-gated delete of one saved view by `id` (MYND-273). Removes the
/// view from `saved_views` AND prunes that id from `view_order` (so a deleted
/// view leaves no dangling display-order entry). Read-modify-write under the
/// per-plugin write mutex; no native side-effect. Deleting an absent id is a
/// no-op success (idempotent). Logs the post-delete view COUNT only.
pub async fn delete_saved_view_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    id: String,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    delete_saved_view_with_dir(&dir, state, hooks, id, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn delete_saved_view<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    id: String,
) -> Result<(), PrefsWriteError> {
    delete_saved_view_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        id,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`delete_saved_view`].
pub(crate) async fn delete_saved_view_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    id: String,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    let mut count = 0usize;
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.saved_views.retain(|v| v.id != id);
            // Prune the id from the display order too (no dangling entry).
            prefs.view_order.retain(|vid| *vid != id);
            count = prefs.saved_views.len();
        },
        io,
        host,
    )
    .await?;

    // COUNT only — never the view id (AS3-Sensitive correlation surface).
    tracing::info!(event = "prefs_written", field = "saved_views", count);
    Ok(())
}

/// Slot::Unlocked-gated setter for the `view_order` sequence (MYND-273) — the
/// saved-view display order (SYNC-10). Read-modify-write under the per-plugin
/// write mutex; **no native side-effect**. The caller passes the full desired
/// sequence; the codec preserves element order VERBATIM (the sequence is the
/// payload — same discipline as `set_item_order`). Stale-id pruning is the
/// caller's job; the codec performs no GC (mirroring `favorites`). Logs the
/// COUNT only.
pub async fn set_view_order_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    order: Vec<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_view_order_with_dir(&dir, state, hooks, order, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_view_order<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    order: Vec<String>,
) -> Result<(), PrefsWriteError> {
    set_view_order_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        order,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_view_order`].
pub(crate) async fn set_view_order_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    order: Vec<String>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    let count = order.len();
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.view_order = order;
        },
        io,
        host,
    )
    .await?;

    // COUNT only — never the view ids (AS3-Sensitive correlation surface).
    tracing::info!(event = "prefs_written", field = "view_order", count);
    Ok(())
}

/// Slot::Unlocked-gated setter for the `bar_items_order` sequence (MYND
/// bottom-bar customization) — the bottom-bar item display order. Read-modify-
/// write under the per-plugin write mutex; **no native side-effect** (same shape
/// as `set_view_order`). The caller passes the full desired sequence of
/// right-cluster bar element ids; the codec preserves element order VERBATIM
/// (the sequence is the payload). Unknown-id pruning is the caller's job; the
/// codec performs no GC. Logs the COUNT only.
pub async fn set_bar_items_order_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    order: Vec<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_bar_items_order_with_dir(&dir, state, hooks, order, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_bar_items_order<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    order: Vec<String>,
) -> Result<(), PrefsWriteError> {
    set_bar_items_order_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        order,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_bar_items_order`].
pub(crate) async fn set_bar_items_order_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    order: Vec<String>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    let count = order.len();
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.bar_items_order = order;
        },
        io,
        host,
    )
    .await?;

    // COUNT only — the bar element ids are fixed UI affordance names, but keep
    // the count-only discipline uniform with the other prefs setters.
    tracing::info!(event = "prefs_written", field = "bar_items_order", count);
    Ok(())
}

/// Slot::Unlocked-gated setter for the `right_panel_active_tab` slot id
/// (right-panel tabs) — the right sidebar tab the editor restores, or `None` to
/// clear back to the host default. Read-modify-write under the per-plugin write
/// mutex; no native side-effect. A free `Option<String>` stored verbatim (the
/// `set_active_workspace` precedent class); non-load-bearing → no clamp.
pub async fn set_right_panel_active_tab_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    value: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_typography_field_with_dir(
        &dir,
        state,
        hooks,
        "right_panel_active_tab",
        |p| {
            p.right_panel_active_tab = value;
        },
        io,
        host,
    )
    .await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_right_panel_active_tab<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    value: Option<String>,
) -> Result<(), PrefsWriteError> {
    set_right_panel_active_tab_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        value,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Slot::Unlocked-gated setter for the `right_panel_hidden_tabs` set (right-panel
/// tabs). Read-modify-write under the per-plugin write mutex; **no native
/// side-effect** (same shape as `set_hidden_bar_items`). The caller passes the
/// full desired set; the codec canonicalizes it (sorted + exact-deduped) on
/// encode. An empty set is the default (every tab visible) and encodes to
/// byte-identical-to-pre-feature.
pub async fn set_right_panel_hidden_tabs_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    items: Vec<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_right_panel_hidden_tabs_with_dir(&dir, state, hooks, items, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_right_panel_hidden_tabs<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    items: Vec<String>,
) -> Result<(), PrefsWriteError> {
    set_right_panel_hidden_tabs_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        items,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_right_panel_hidden_tabs`].
pub(crate) async fn set_right_panel_hidden_tabs_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    items: Vec<String>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    let count = items.len();
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.right_panel_hidden_tabs = items;
        },
        io,
        host,
    )
    .await?;

    // COUNT only — the tab ids are a non-secret closed UI vocabulary, but stay
    // consistent with the other prefs setters' count-only discipline.
    tracing::info!(
        event = "prefs_written",
        field = "right_panel_hidden_tabs",
        count,
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `right_panel_tab_order` sequence
/// (right-panel tabs) — the right sidebar tab display order. Read-modify-write
/// under the per-plugin write mutex; **no native side-effect** (same shape as
/// `set_bar_items_order`). The caller passes the full desired sequence of tab
/// ids; the codec preserves element order VERBATIM. Unknown-id pruning is the
/// caller's job; the codec performs no GC. Logs the COUNT only.
pub async fn set_right_panel_tab_order_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    order: Vec<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_right_panel_tab_order_with_dir(&dir, state, hooks, order, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_right_panel_tab_order<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    order: Vec<String>,
) -> Result<(), PrefsWriteError> {
    set_right_panel_tab_order_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        order,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_right_panel_tab_order`].
pub(crate) async fn set_right_panel_tab_order_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    order: Vec<String>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    let count = order.len();
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.right_panel_tab_order = order;
        },
        io,
        host,
    )
    .await?;

    // COUNT only — the tab ids are fixed UI affordance names, but keep the
    // count-only discipline uniform with the other prefs setters.
    tracing::info!(
        event = "prefs_written",
        field = "right_panel_tab_order",
        count
    );
    Ok(())
}

// ---- MYND-336 editor toolbar / slash-menu customization ----------------
// Four count-only setters mirroring the right-panel-tabs pattern: *_order is a
// verbatim sequence, *_hidden is a set the codec canonicalizes on encode.

/// Slot::Unlocked-gated setter for `editor_toolbar_order` (verbatim sequence).
pub async fn set_editor_toolbar_order_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    order: Vec<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_editor_toolbar_order_with_dir(&dir, state, hooks, order, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_editor_toolbar_order<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    order: Vec<String>,
) -> Result<(), PrefsWriteError> {
    set_editor_toolbar_order_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        order,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_editor_toolbar_order`].
pub(crate) async fn set_editor_toolbar_order_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    order: Vec<String>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    let count = order.len();
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.editor_toolbar_order = order;
        },
        io,
        host,
    )
    .await?;
    tracing::info!(
        event = "prefs_written",
        field = "editor_toolbar_order",
        count
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for `editor_toolbar_hidden` (sorted+deduped set).
pub async fn set_editor_toolbar_hidden_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    items: Vec<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_editor_toolbar_hidden_with_dir(&dir, state, hooks, items, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_editor_toolbar_hidden<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    items: Vec<String>,
) -> Result<(), PrefsWriteError> {
    set_editor_toolbar_hidden_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        items,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_editor_toolbar_hidden`].
pub(crate) async fn set_editor_toolbar_hidden_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    items: Vec<String>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    let count = items.len();
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.editor_toolbar_hidden = items;
        },
        io,
        host,
    )
    .await?;
    tracing::info!(
        event = "prefs_written",
        field = "editor_toolbar_hidden",
        count
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for `editor_slash_order` (verbatim sequence).
pub async fn set_editor_slash_order_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    order: Vec<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_editor_slash_order_with_dir(&dir, state, hooks, order, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_editor_slash_order<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    order: Vec<String>,
) -> Result<(), PrefsWriteError> {
    set_editor_slash_order_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        order,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_editor_slash_order`].
pub(crate) async fn set_editor_slash_order_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    order: Vec<String>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    let count = order.len();
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.editor_slash_order = order;
        },
        io,
        host,
    )
    .await?;
    tracing::info!(event = "prefs_written", field = "editor_slash_order", count);
    Ok(())
}

/// Slot::Unlocked-gated setter for `editor_slash_hidden` (sorted+deduped set).
pub async fn set_editor_slash_hidden_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    items: Vec<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_editor_slash_hidden_with_dir(&dir, state, hooks, items, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_editor_slash_hidden<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    items: Vec<String>,
) -> Result<(), PrefsWriteError> {
    set_editor_slash_hidden_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        items,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_editor_slash_hidden`].
pub(crate) async fn set_editor_slash_hidden_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    items: Vec<String>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    let count = items.len();
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.editor_slash_hidden = items;
        },
        io,
        host,
    )
    .await?;
    tracing::info!(
        event = "prefs_written",
        field = "editor_slash_hidden",
        count
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `daily_date_format` field (MYND-191) —
/// the daily-notes date-format string (e.g. `YYYY-MM-DD`). Read-modify-write
/// under the per-plugin write mutex; no native side-effect. Disk-first. The
/// field is non-load-bearing (cold/derivable); no protective-envelope clamp.
pub async fn set_daily_date_format_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    format: String,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_daily_date_format_with_dir(&dir, state, hooks, format, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_daily_date_format<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    format: String,
) -> Result<(), PrefsWriteError> {
    set_daily_date_format_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        format,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_daily_date_format`].
pub(crate) async fn set_daily_date_format_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    format: String,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.daily_date_format = Some(format);
        },
        io,
        host,
    )
    .await?;

    tracing::info!(event = "prefs_written", field = "daily_date_format");
    Ok(())
}

/// Slot::Unlocked-gated setter for the `daily_folder` field (MYND-191) — the
/// daily-notes folder path. Beyond writing the pointer, designating a daily
/// folder ALSO registers it as a deliberate folder (union, exact-dedup) so the
/// folder survives empty (the virtual-folder model, MYND-144). Read-modify-write
/// under the write mutex; no native side-effect; disk-first. Non-load-bearing.
pub async fn set_daily_folder_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    folder: String,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_daily_folder_with_dir(&dir, state, hooks, folder, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_daily_folder<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    folder: String,
) -> Result<(), PrefsWriteError> {
    set_daily_folder_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        folder,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_daily_folder`].
pub(crate) async fn set_daily_folder_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    folder: String,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.daily_folder = Some(folder.clone());
            // Register as a deliberate folder so the daily folder survives empty
            // (MYND-144). Through the named seam (myne-md/myne#850 task 3), which
            // does the dedup AND stamps the per-entry clock the merge reads; the
            // hand-written push skipped both.
            let _ = crate::plugins::prefs::set_mutation::register_deliberate_folder(prefs, &folder);
        },
        io,
        host,
    )
    .await?;

    // Field name only — never the path (folder structure is AS3 Sensitive; see
    // ../../AGENTS.md "Secret-handling logging discipline").
    tracing::info!(event = "prefs_written", field = "daily_folder");
    Ok(())
}

/// Clear the two pointers whose setters take a REQUIRED value (myne-md/myne#850).
///
/// **Two functions rather than a widened setter, and the asymmetry is the whole
/// reason they exist.** `set_daily_folder_with_dir` and
/// `set_daily_date_format_with_dir` take a `String`, so no call on either
/// expresses "there was nothing here"; the agent's undo of a run that set one of
/// them for the first time needs exactly that, and its intent table records the
/// same fact as `clearable`. The alternative (widening both setters and every
/// caller, including their IPC wrappers and the settings panel) is the change
/// `PrefTarget::clearable` names as the follow-up; these two keep the agent's
/// path honest until somebody takes it.
///
/// **Deliberately without an IPC wrapper, which is what keeps this free of any
/// capability or ACL change**: the agent's own `agent_undo` command is the only
/// caller, and it reaches the prefs plugin in-process the way `write_target`
/// already does for every other target.
///
/// Written through the same `update_prefs_with_dir` as every other prefs write,
/// so the nonce bump, the AEAD and the disk-first ordering are structural rather
/// than re-implemented here. **The deliberate-folder registration is left alone
/// on purpose**: the folder NAME stays on record, because that record is what
/// keeps it alive as a virtual folder, and the pointer being cleared is exactly
/// the state the user had before the run.
pub async fn clear_daily_folder_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    clear_daily_folder_with_dir(&dir, state, hooks, io, host).await
}

/// Testable core of [`clear_daily_folder_from_host`].
pub(crate) async fn clear_daily_folder_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.daily_folder = None;
        },
        io,
        host,
    )
    .await?;

    tracing::info!(event = "prefs_written", field = "daily_folder");
    Ok(())
}

/// The same, for `daily_date_format`. See `clear_daily_folder_from_host`.
pub async fn clear_daily_date_format_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    clear_daily_date_format_with_dir(&dir, state, hooks, io, host).await
}

/// Testable core of [`clear_daily_date_format_from_host`].
pub(crate) async fn clear_daily_date_format_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.daily_date_format = None;
        },
        io,
        host,
    )
    .await?;

    tracing::info!(event = "prefs_written", field = "daily_date_format");
    Ok(())
}

/// Slot::Unlocked-gated setter for the `daily_template` pointer (MYND-191) — the
/// UUIDv7 of the template to instantiate today's note from. `Some(id)` sets it;
/// `None` clears it (the canonical "blank daily note" state). Read-modify-write
/// under the write mutex; no native side-effect; disk-first. Non-load-bearing.
pub async fn set_daily_template_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    template_id: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_daily_template_with_dir(&dir, state, hooks, template_id, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_daily_template<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    template_id: Option<String>,
) -> Result<(), PrefsWriteError> {
    set_daily_template_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        template_id,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_daily_template`].
pub(crate) async fn set_daily_template_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    template_id: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    let cleared = template_id.is_none();
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.daily_template = template_id;
        },
        io,
        host,
    )
    .await?;

    // Field name + set/cleared only — never the UUID (note_id is a vault-stable
    // correlation tag; see ../../AGENTS.md "Secret-handling logging discipline").
    tracing::info!(event = "prefs_written", field = "daily_template", cleared);
    Ok(())
}

/// Slot::Unlocked-gated setter for the `ribbon_items` rail order
/// (myne-md/myne#699): the left ribbon's pinned command ids. Read-modify-write
/// under the per-plugin write mutex; no native side-effect; disk-first.
/// **Device-local** (the `bar_items_order` class), so it is never clock-stamped.
/// The caller passes the full desired sequence; the codec preserves element
/// order VERBATIM. Writing always marks the rail CONFIGURED (`Some(...)`), so a
/// deliberately emptied rail (`Some([])`) stays empty rather than re-seeding the
/// client's curated default. Logs the COUNT only.
pub async fn set_ribbon_items_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    items: Vec<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_ribbon_items_with_dir(&dir, state, hooks, items, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_ribbon_items<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    items: Vec<String>,
) -> Result<(), PrefsWriteError> {
    set_ribbon_items_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        items,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_ribbon_items`].
pub(crate) async fn set_ribbon_items_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    items: Vec<String>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    // A caller passes registry command ids (`note.new`, `daily.open-today`:
    // short dotted tokens, the longest in the registry under 40 bytes). The
    // caps are generous enough that no honest rail meets either and small
    // enough that a compromised WebView cannot park storage in the blob: 128
    // ids of 200 bytes each stay far under the 64 KiB `MYP1` envelope, which
    // is the backstop, not the validation.
    const MAX_RIBBON_ITEMS: usize = 128;
    const MAX_RIBBON_ITEM_LEN: usize = 200;
    if items.len() > MAX_RIBBON_ITEMS || items.iter().any(|id| id.len() > MAX_RIBBON_ITEM_LEN) {
        return Err(PrefsWriteError::InvalidValue);
    }
    let count = items.len();
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.ribbon_items = Some(items);
        },
        io,
        host,
    )
    .await?;

    tracing::info!(event = "prefs_written", field = "ribbon_items", count);
    Ok(())
}

/// Slot::Unlocked-gated setter for the `ribbon_visible` flag
/// (myne-md/myne#699): whether THIS DEVICE shows the left ribbon. Default
/// `true`; the codec omits the field unless it is `false`. Read-modify-write
/// under the write mutex; no native side-effect; disk-first. **Device-local**,
/// so it is never clock-stamped. Non-load-bearing.
pub async fn set_ribbon_visible_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    visible: bool,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_ribbon_visible_with_dir(&dir, state, hooks, visible, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_ribbon_visible<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    visible: bool,
) -> Result<(), PrefsWriteError> {
    set_ribbon_visible_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        visible,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_ribbon_visible`].
pub(crate) async fn set_ribbon_visible_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    visible: bool,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.ribbon_visible = visible;
        },
        io,
        host,
    )
    .await?;

    tracing::info!(event = "prefs_written", field = "ribbon_visible", visible);
    Ok(())
}

/// The three settings a period carries, mirroring what `daily_folder` /
/// `daily_date_format` / `daily_template` carry for the daily period. The key
/// written into `periodic_notes` is `<period>.<setting>` (myne#177).
const PERIOD_SETTINGS: [&str; 3] = ["folder", "format", "template"];

/// Slot::Unlocked-gated setter for one `periodic_notes` entry (myne#177),
/// keyed `<period>.<setting>`, e.g. `weekly` + `folder`. `Some(value)` sets it,
/// `None` removes the key, which the Phase 2 merge represents as a stamped
/// absence rather than as "this device never had it". Read-modify-write under
/// the write mutex; disk-first; non-load-bearing.
///
/// Two host-side validations, because the codec deliberately performs none. The
/// **setting** must be one of [`PERIOD_SETTINGS`], so a typo cannot write a key
/// nothing will ever read. The **period** must be a non-empty run of ASCII
/// lowercase letters, which keeps the `<period>.<setting>` grammar unambiguous:
/// a period containing a dot would produce a key that parses two ways. The
/// period is deliberately NOT checked against a closed list, because a build that
/// ships a fourth period writes `quarterly.folder` with no codec, spec or
/// vector change, and an older build decodes that entry and ignores it.
///
/// `daily` is accepted by the grammar but is not where the daily period lives:
/// daily keeps its three top-level fields, and writing `daily.folder` here
/// would create a second home for one setting. The caller owns that; the UI
/// routes daily to `set_daily_folder` and friends.
pub async fn set_periodic_note_setting_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    period: String,
    setting: String,
    value: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_periodic_note_setting_with_dir(&dir, state, hooks, period, setting, value, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_periodic_note_setting<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    period: String,
    setting: String,
    value: Option<String>,
) -> Result<(), PrefsWriteError> {
    set_periodic_note_setting_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        period,
        setting,
        value,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_periodic_note_setting`].
#[allow(clippy::too_many_arguments)]
pub(crate) async fn set_periodic_note_setting_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    period: String,
    setting: String,
    value: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    if !PERIOD_SETTINGS.contains(&setting.as_str()) {
        return Err(PrefsWriteError::InvalidValue);
    }
    if period.is_empty() || !period.chars().all(|c| c.is_ascii_lowercase()) {
        return Err(PrefsWriteError::InvalidValue);
    }
    // Daily is refused HERE, not merely avoided by the caller. Daily keeps its
    // three flat top-level fields, and `daily_match::period_settings` returns
    // early for it and never reads this map, so a `daily.folder` entry would
    // write, sync and be read by nothing: a second home for one setting, which
    // is the exact shape the no-migration decision exists to prevent. It was
    // reachable, and only `PeriodicNotesSettings.tsx`'s `period === "daily"`
    // branch kept it from happening.
    if period == "daily" {
        return Err(PrefsWriteError::InvalidValue);
    }
    let key = format!("{period}.{setting}");
    let cleared = value.is_none();

    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            match value {
                Some(v) => {
                    prefs.periodic_notes.insert(key.clone(), v.clone());
                    // A period folder is registered as a deliberate folder for
                    // the same reason the daily one is (MYND-144): the folder
                    // has no notes in it until the first period note is
                    // created, and without this it would not appear in the
                    // sidebar, so the setting would look like it did nothing.
                    //
                    // **Through the named seam, not by pushing onto the
                    // vector** (myne-md/myne#850 task 3). The push skipped the
                    // blob budget and left the entry without the per-entry clock
                    // the merge reads, so a registration made this way could be
                    // shed or silently re-deleted.
                    if setting == "folder" {
                        let _ = crate::plugins::prefs::set_mutation::register_deliberate_folder(
                            prefs, &v,
                        );
                    }
                }
                None => {
                    prefs.periodic_notes.remove(&key);
                }
            }
        },
        io,
        host,
    )
    .await?;

    // Field + which entry + set/cleared. The SETTING is a closed vocabulary
    // this function just validated against `PERIOD_SETTINGS`; the PERIOD is a
    // bounded-charset grammar token (a non-empty run of ASCII lowercase, daily
    // excluded) rather than a closed list, deliberately, so a build shipping a
    // fourth period needs no change here. Neither is user text, and the VALUE
    // (a folder path, AS3 Sensitive) is never logged. See
    // src-tauri/AGENTS.md "Secret-handling logging discipline".
    tracing::info!(
        event = "prefs_written",
        field = "periodic_notes",
        entry = %key,
        cleared
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the new-note default-location pair (MYND-462,
/// "Files" settings panel) — `new_note_location` (the mode: root/current/specific) +
/// `new_note_location_folder` (the target folder when mode == "specific"). Set
/// atomically in one disk write so the mode and target never desync. When a
/// folder is supplied it is ALSO registered as a deliberate folder (union,
/// exact-dedup) so the target survives empty (the `set_daily_folder` discipline,
/// MYND-144). The caller passes `folder = None` whenever `location != "specific"`.
/// Read-modify-write under the write mutex; no native side-effect; disk-first;
/// non-load-bearing.
pub async fn set_new_note_location_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    location: Option<String>,
    folder: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_new_note_location_with_dir(&dir, state, hooks, location, folder, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_new_note_location<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    location: Option<String>,
    folder: Option<String>,
) -> Result<(), PrefsWriteError> {
    set_new_note_location_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        location,
        folder,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_new_note_location`].
pub(crate) async fn set_new_note_location_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    location: Option<String>,
    folder: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.new_note_location = location;
            prefs.new_note_location_folder = folder.clone();
            // When a specific target folder is named, register it as a deliberate folder
            // so it survives empty (MYND-144) — exactly like set_daily_folder.
            // Through the named seam (myne-md/myne#850 task 3), not a push.
            if let Some(folder) = folder {
                let _ =
                    crate::plugins::prefs::set_mutation::register_deliberate_folder(prefs, &folder);
            }
        },
        io,
        host,
    )
    .await?;

    // Field name only — never the path (folder structure is AS3 Sensitive; see
    // ../../AGENTS.md "Secret-handling logging discipline").
    tracing::info!(event = "prefs_written", field = "new_note_location");
    Ok(())
}

/// Shared read-modify-write core for the four editor-typography string presets
/// (editor-typography: `editor_text_size` / `editor_line_spacing` /
/// `editor_content_width` / `editor_font_family`). Each is a free
/// `Option<String>` enum where `None` clears to the canonical default (omitted
/// on disk, byte-identical to an untouched vault) and `Some(v)` stores the
/// chosen preset — the enum interpretation + unknown→default fallback live on
/// the client (the `set_theme` precedent class). Disk-first; no native
/// side-effect; non-load-bearing (no protective-envelope clamp).
async fn set_typography_field_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    field_label: &'static str,
    mutate: impl FnOnce(&mut PrefsView),
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(vault_dir, state, hooks, mutate, io, host).await?;

    // Field name only — never the value (a typography preset is not secret, but
    // the field-name-only discipline is uniform across prefs setters).
    tracing::info!(event = "prefs_written", field = field_label);
    Ok(())
}

/// Slot::Unlocked-gated setter for the `editor_text_size` preset
/// (editor-typography) — `sm`/`md`/`lg`/`xl`, or `None` to clear to the `md`
/// default. Read-modify-write under the write mutex; no native side-effect.
pub async fn set_editor_text_size_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    value: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_typography_field_with_dir(
        &dir,
        state,
        hooks,
        "editor_text_size",
        |p| {
            p.editor_text_size = value;
        },
        io,
        host,
    )
    .await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_editor_text_size<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    value: Option<String>,
) -> Result<(), PrefsWriteError> {
    set_editor_text_size_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        value,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Slot::Unlocked-gated setter for the `editor_line_spacing` preset
/// (editor-typography) — `tight`/`normal`/`relaxed`, or `None` to clear.
pub async fn set_editor_line_spacing_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    value: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_typography_field_with_dir(
        &dir,
        state,
        hooks,
        "editor_line_spacing",
        |p| {
            p.editor_line_spacing = value;
        },
        io,
        host,
    )
    .await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_editor_line_spacing<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    value: Option<String>,
) -> Result<(), PrefsWriteError> {
    set_editor_line_spacing_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        value,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Slot::Unlocked-gated setter for the `editor_content_width` preset
/// (editor-typography) — `narrow`/`normal`/`wide`/`full`, or `None` to clear.
pub async fn set_editor_content_width_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    value: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_typography_field_with_dir(
        &dir,
        state,
        hooks,
        "editor_content_width",
        |p| {
            p.editor_content_width = value;
        },
        io,
        host,
    )
    .await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_editor_content_width<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    value: Option<String>,
) -> Result<(), PrefsWriteError> {
    set_editor_content_width_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        value,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Slot::Unlocked-gated setter for the `date_format` display preference (myne#279)
/// — `system`/`iso`/`dmy`/`mdy`/`dmmmy`, or `None` to clear to the `system` default.
///
/// A free `Option<String>` (the `set_editor_content_width` precedent
/// class): the enum interpretation and the unknown-value fallback live on the
/// client, so a value this build does not recognise reads as the default rather
/// than failing a write.
pub async fn set_date_format_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    value: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_typography_field_with_dir(
        &dir,
        state,
        hooks,
        "date_format",
        |p| {
            p.date_format = value;
        },
        io,
        host,
    )
    .await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_date_format<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    value: Option<String>,
) -> Result<(), PrefsWriteError> {
    set_date_format_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        value,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Slot::Unlocked-gated setter for the `time_format` display preference (myne#279)
/// — `system`/`24h`/`12h`, or `None` to clear to the `system` default.
///
/// Same free-`Option<String>` discipline as `set_date_format`.
pub async fn set_time_format_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    value: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_typography_field_with_dir(
        &dir,
        state,
        hooks,
        "time_format",
        |p| {
            p.time_format = value;
        },
        io,
        host,
    )
    .await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_time_format<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    value: Option<String>,
) -> Result<(), PrefsWriteError> {
    set_time_format_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        value,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Slot::Unlocked-gated setter for the `timezone` display preference (myne#279)
/// — an IANA zone identifier, or `None` to clear to the `system` default.
///
/// **Display only.** It decides what the app treats as "today" and how a stored
/// wall-clock value is printed; it never enters a `.myn` file, so a note never
/// records where its author was.
///
/// It DOES enter a blob, and this comment said otherwise until myne-md/myne#609:
/// the body below writes the zone into `vault.prefs`, which the sync layer
/// pushes and pulls verbatim. `PrefClass::DeviceLocal` is a MERGE
/// classification (`docs/spec/sync-protocol.md` 10.2) meaning the local value
/// survives the merge, not a statement that the value stays on the device, and
/// 10.2.1 has a newly enrolled device adopt it as a starting default.
pub async fn set_timezone_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    value: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_typography_field_with_dir(
        &dir,
        state,
        hooks,
        "timezone",
        |p| {
            p.timezone = value;
        },
        io,
        host,
    )
    .await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_timezone<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    value: Option<String>,
) -> Result<(), PrefsWriteError> {
    set_timezone_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        value,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Slot::Unlocked-gated setter for the `editor_font_family` preset
/// (editor-typography) — `mono`/`sans`, or `None` to clear to the `mono` default.
pub async fn set_editor_font_family_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    value: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_typography_field_with_dir(
        &dir,
        state,
        hooks,
        "editor_font_family",
        |p| {
            p.editor_font_family = value;
        },
        io,
        host,
    )
    .await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_editor_font_family<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    value: Option<String>,
) -> Result<(), PrefsWriteError> {
    set_editor_font_family_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        value,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Slot::Unlocked-gated setter for the startup-open pair (MYND-462, "Files"
/// settings panel) — `startup_open` (the mode: last/empty/specific) +
/// `startup_open_note` (the target note UUID when mode == "specific"). Set
/// atomically in one disk write (via the shared typography core) so the mode and
/// target never desync. No deliberate-folder side-effect (a note pointer, not a
/// folder). The caller passes `note = None` whenever `mode != "specific"`.
/// Disk-first; non-load-bearing.
pub async fn set_startup_open_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    mode: Option<String>,
    note: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_startup_open_with_dir(&dir, state, hooks, mode, note, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_startup_open<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    mode: Option<String>,
    note: Option<String>,
) -> Result<(), PrefsWriteError> {
    set_startup_open_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        mode,
        note,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_startup_open`]. Writes the `startup_open` mode +
/// `startup_open_note` target atomically via the shared typography core.
pub(crate) async fn set_startup_open_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    mode: Option<String>,
    note: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    set_typography_field_with_dir(
        vault_dir,
        state,
        hooks,
        "startup_open",
        |p| {
            p.startup_open = mode;
            p.startup_open_note = note;
        },
        io,
        host,
    )
    .await
}

/// Slot::Unlocked-gated setter for the `favorites` sequence — the user's
/// favorited notes (an ordered list of note UUIDs surfaced in the sidebar's
/// Favorites section, MYND-183). Identical read-modify-write + order-
/// preserving + no-native-side-effect shape as [`set_item_order`], applied to
/// the favorites field.
pub async fn set_favorites_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    order: Vec<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_favorites_with_dir(&dir, state, hooks, order, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_favorites<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    order: Vec<String>,
) -> Result<(), PrefsWriteError> {
    set_favorites_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        order,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_favorites`].
pub(crate) async fn set_favorites_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    order: Vec<String>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    let count = order.len();
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.favorites = order;
        },
        io,
        host,
    )
    .await?;

    // COUNT only — never the note IDs (note_id is a per-note vault-stable
    // correlation tag; see ../../AGENTS.md "Secret-handling logging discipline").
    tracing::info!(event = "prefs_written", field = "favorites", count,);
    Ok(())
}

/// Slot::Unlocked-gated setter for the `auto_lock_seconds` field (MYND-121).
/// Read-modify-write under the per-plugin write mutex. Getter is the existing
/// [`prefs_read`] (the returned `PrefsView` already carries `auto_lock_seconds`).
pub async fn set_auto_lock_timeout_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    seconds: u32,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_auto_lock_timeout_with_dir(&dir, state, hooks, seconds, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_auto_lock_timeout<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    seconds: u32,
) -> Result<(), PrefsWriteError> {
    set_auto_lock_timeout_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        seconds,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_auto_lock_timeout`]. Persists `auto_lock_seconds`
/// to `vault.prefs` (disk commit FIRST), then refreshes the idle timer's
/// cached effective timeout (the "effect"; window-free, so it lives in the
/// core rather than the wrapper — unlike `set_screen_capture_protection`
/// whose native effect needs a `WebviewWindow`). The disk-FIRST-then-effect
/// ordering still holds: a disk-write failure returns before the cache update.
///
/// The RAW user value is stored on disk; the protective-envelope clamp
/// (MYND-121 task 3) is applied only to the in-memory cache + at read time,
/// so a replayed `vault.prefs` can still only make auto-lock stricter
/// (`threat-model.md` §7 two-class taxonomy).
pub async fn set_auto_lock_timeout_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    seconds: u32,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.auto_lock_seconds = Some(seconds);
        },
        io,
        host,
    )
    .await?;

    // Effect SECOND (only on disk success): refresh the cached effective
    // timeout, clamped through the envelope so a live change can never exceed
    // the ceiling. The clamp is SHARED since myne-md/myne#479
    // (`crate::effective_auto_lock_secs`) and is the hook trait's DEFAULT, so a
    // client that overrides nothing still gets it.
    //
    // What reads the value it writes is DESKTOP only: `VaultRuntimeState::
    // auto_lock_timeout_secs` is consumed by `src-tauri/src/auto_lock.rs`'s tick
    // loop and by nothing else. The WebView timers on mobile and web read the
    // pref themselves and clamp with the TypeScript mirror
    // (`@myne/client-core`), so this line is not what bounds them.
    state.set_auto_lock_timeout_secs(hooks.effective_auto_lock_secs(Some(seconds)));

    tracing::info!(
        event = "prefs_written",
        field = "auto_lock_seconds",
        value = seconds,
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `editor_layout` field (MYND-137) —
/// the editor three-pane sidebar widths + collapsed flags. Read-modify-write
/// under the per-plugin write mutex; **no native side-effect** (same shape as
/// `set_item_order`). The caller passes the full desired layout; v0.1
/// single-device writes it verbatim. The codec persists the RAW client value;
/// the min/max clamp + collapse policy live in the UI layer (a replayed /
/// tampered `vault.prefs` is re-clamped on the client at read time), so this
/// command only persists the choice.
pub async fn set_editor_layout_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    layout: EditorLayout,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_editor_layout_with_dir(&dir, state, hooks, layout, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_editor_layout<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    layout: EditorLayout,
) -> Result<(), PrefsWriteError> {
    set_editor_layout_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        layout,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_editor_layout`].
pub(crate) async fn set_editor_layout_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    layout: EditorLayout,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    let (left_collapsed, right_collapsed) = (layout.left_collapsed, layout.right_collapsed);
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.editor_layout = Some(layout);
        },
        io,
        host,
    )
    .await?;

    // Collapsed flags only — window-layout metadata (AS3-low), never note
    // content; widths are equally benign but omitted to keep the line minimal.
    tracing::info!(
        event = "prefs_written",
        field = "editor_layout",
        left_collapsed,
        right_collapsed,
    );
    Ok(())
}

/// Static label for the theme preference, for non-secret structured
/// logging. `theme` is an AS3-low cosmetic UI preference (light / dark /
/// amoled / system), so the value itself is safe to emit (unlike the
/// DENY-listed secret material in ../../AGENTS.md "Secret-handling logging
/// discipline").
fn theme_label(theme: Option<ThemeChoice>) -> &'static str {
    match theme {
        None => "system",
        Some(ThemeChoice::Light) => "light",
        Some(ThemeChoice::Dark) => "dark",
        Some(ThemeChoice::Amoled) => "amoled",
    }
}

/// Slot::Unlocked-gated setter for the `theme` field (MYND-110) — the
/// user's Light / Dark / System choice. Read-modify-write under the
/// per-plugin write mutex; **no native side-effect** (same shape as
/// [`set_favorites`]). The argument is `Option<ThemeChoice>`: `None` ≡
/// **system** (clears the field so the client follows the OS
/// `prefers-color-scheme`), `Some(Light/Dark)` is an explicit choice that
/// the client maps to `<html data-theme="…">`. `theme` is a
/// **non-load-bearing** cosmetic preference — no protective-envelope clamp
/// (a tampered / replayed `vault.prefs` can at worst surface the wrong
/// color). The getter is the existing [`prefs_read`] — the returned
/// `PrefsView` already carries `theme`. Disk-first ordering is trivial
/// here (nothing is sequenced after the write).
pub async fn set_theme_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    theme: Option<ThemeChoice>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_theme_with_dir(&dir, state, hooks, theme, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_theme<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    theme: Option<ThemeChoice>,
) -> Result<(), PrefsWriteError> {
    set_theme_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        theme,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_theme`].
pub(crate) async fn set_theme_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    theme: Option<ThemeChoice>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.theme = theme;
        },
        io,
        host,
    )
    .await?;

    // Theme is a non-secret cosmetic preference (AS3-low) — the resolved
    // label is safe to emit.
    tracing::info!(
        event = "prefs_written",
        field = "theme",
        value = theme_label(theme),
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `custom_theme` field (custom-themes
/// epic, MYND-297) — the active custom-theme name, i.e. a key of the encrypted
/// `vault.themes` store (`MYT1`, `protocol.md` §9.21). It named a plaintext
/// file stem under `app_config_dir/themes/` until `decisions.md` 2026-07-16
/// promoted palettes to vault content; the blob holds the palettes, this field
/// holds the pointer. `Some(name)` selects a custom theme (takes precedence
/// over `theme` host-side); `None` clears it (the client falls back to the
/// built-in `theme`). Read-modify-write under the per-plugin write mutex;
/// **no native side-effect**, disk-first (same shape as [`set_theme`]).
/// `custom_theme` is a **non-load-bearing** cosmetic preference — no
/// protective-envelope clamp (a tampered/replayed value at worst selects a
/// different or absent palette: a name with no live entry in the store falls
/// back to the built-in `theme`, and an unreadable store reads as empty per
/// §9.21.4). The name is `is_valid_theme_name`-constrained at the themes-plugin
/// import boundary; this setter stores the string verbatim.
pub async fn set_custom_theme_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    custom_theme: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_custom_theme_with_dir(&dir, state, hooks, custom_theme, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_custom_theme<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    custom_theme: Option<String>,
) -> Result<(), PrefsWriteError> {
    set_custom_theme_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        custom_theme,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_custom_theme`].
pub(crate) async fn set_custom_theme_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    custom_theme: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    let is_set = custom_theme.is_some();
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.custom_theme = custom_theme;
        },
        io,
        host,
    )
    .await?;

    // The custom-theme NAME is user-authored cosmetic data; emit only whether a
    // custom theme is now selected or cleared, never the name itself.
    tracing::info!(
        event = "prefs_written",
        field = "custom_theme",
        set = is_set
    );
    Ok(())
}

/// Slot::Unlocked-gated setter for the `item_colors` map (MYND-184) — the
/// per-item color labels keyed by note UUID OR canonical trailing-slash folder
/// path (notes + folders both take a color). Read-modify-write under the
/// per-plugin write mutex; **no native side-effect** (same shape as
/// `set_deliberate_folders`). The caller passes the full desired map; v0.1
/// single-device writes it verbatim. Clearing a color = omit its key from the
/// map (an empty map omits the whole field on disk). Stale-key pruning
/// (deleted note/folder) is the caller's job — the codec performs no GC.
pub async fn set_item_colors_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    colors: std::collections::BTreeMap<String, String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_item_colors_with_dir(&dir, state, hooks, colors, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_item_colors<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    colors: std::collections::BTreeMap<String, String>,
) -> Result<(), PrefsWriteError> {
    set_item_colors_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        colors,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_item_colors`].
pub(crate) async fn set_item_colors_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    colors: std::collections::BTreeMap<String, String>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    let count = colors.len();
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.item_colors = colors;
        },
        io,
        host,
    )
    .await?;

    // Entry COUNT only — never the keys (note IDs / folder paths are AS3
    // correlation tags; see ../../AGENTS.md "Secret-handling logging discipline").
    tracing::info!(event = "prefs_written", field = "item_colors", count,);
    Ok(())
}

/// Slot::Unlocked-gated setter for the `folder_icons` map (MYND-185) — the
/// per-folder custom sidebar icons keyed by canonical trailing-slash folder
/// path. Same read-modify-write, no-native-side-effect contract as
/// [`set_item_colors`]. The caller passes the full desired map; resetting a
/// folder to its default glyph = omit its key (an empty map omits the field on
/// disk). Stale-key pruning (deleted/renamed folder) is the caller's job.
pub async fn set_folder_icons_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    icons: std::collections::BTreeMap<String, String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_folder_icons_with_dir(&dir, state, hooks, icons, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_folder_icons<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    icons: std::collections::BTreeMap<String, String>,
) -> Result<(), PrefsWriteError> {
    set_folder_icons_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        icons,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_folder_icons`].
pub(crate) async fn set_folder_icons_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    icons: std::collections::BTreeMap<String, String>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    let count = icons.len();
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.folder_icons = icons;
        },
        io,
        host,
    )
    .await?;

    // Entry COUNT only — never the keys (folder paths are AS3 correlation tags).
    tracing::info!(event = "prefs_written", field = "folder_icons", count,);
    Ok(())
}

/// The running device's platform token — [`std::env::consts::OS`] verbatim
/// (`"macos"`, `"windows"`, `"linux"`, `"ios"`, `"android"`).
///
/// This is the product's SINGLE default-device-name heuristic (MYND-548): the
/// enrollment forms seed their "Name this device" field from it, mapping the
/// token to a display word through the i18n catalogue. Clients MUST NOT derive
/// the platform from `navigator` instead — that would be a second heuristic
/// diverging per client, which is exactly what the `PrefsView::device_names`
/// doc comment ("the single home for device names so no client ships a second
/// default-name heuristic") exists to prevent. A client MAY refine the token
/// with information the core cannot see (mobile splits `"ios"` into phone vs
/// tablet via its size class) — that only picks a better *suggestion* for an
/// editable field; the stored value is whatever the user confirms.
///
/// Deliberately NOT `Slot::Unlocked`-gated and infallible: it reads a
/// compile-time constant and touches no vault state, and the join flow needs it
/// while bootstrapping a vault that is not unlocked yet.
pub fn device_platform_value() -> String {
    // **`std::env::consts::OS` is the EMPTY STRING on `wasm32-unknown-unknown`**
    // — measured in a browser, not assumed (phase3-web-client). It is not
    // `"unknown"`, which is what the name suggests and what an earlier note in
    // this feature's progress log wrongly claimed. An empty platform token is
    // worse than a wrong one: every `platform === "…"` branch silently takes its
    // else, and nothing reports a problem.
    //
    // "web" rather than the browser or the OS underneath it: the value names the
    // CLIENT, which is what a caller branches on, and a page cannot honestly
    // report the operating system anyway.
    #[cfg(target_arch = "wasm32")]
    {
        "web".to_string()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        std::env::consts::OS.to_string()
    }
}

/// IPC wrapper. The only host-specific thing about this command is the
/// attribute — it takes no Tauri types at all.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub fn device_platform() -> String {
    device_platform_value()
}

/// Slot::Unlocked-gated setter for ONE entry of the `device_names` map
/// (MYND-548 / SYNC-41) — the human-readable label the device list shows for a
/// `device_id`, keyed by its hex. Read-modify-write under the per-plugin write
/// mutex; **no native side-effect** (same disk-only shape as
/// [`set_folder_icons`]).
///
/// Two deliberate deviations from the [`vault_set_label`] precedent this
/// otherwise mirrors:
///
/// 1. **No clear path.** The parameter is a plain `String`, not
///    `Option<String>`. `device_names` merges per-key by UNION
///    (`sync-protocol.md` §10.2): a key present on one side and absent on the
///    other is carried over verbatim, so removing an entry does not propagate —
///    it resurrects from the first peer that still holds it. Rather than ship a
///    delete that silently fails to stick (or mint an empty-string tombstone,
///    which would need its own § 9.5.2 clause and would linger forever), the
///    operation does not exist. A RENAME always works: it stamps a fresh
///    `device_names/<hex>` clock and wins LWW.
/// 2. **Empty is a no-op, not a write.** A blank or whitespace-only name is
///    refused before the read-modify-write (returning `Ok`), so no row can ever
///    render nameless. Both clients treat an empty submit as "cancel"; this is
///    the fail-closed backstop for that contract, not a second code path.
///
/// The stored value is trimmed. NFC folding is the codec's job
/// (`push_canonical_string_map` normalizes keys AND values on encode — the
/// `spell_languages` precedent), so this setter does not re-normalize.
/// **Non-load-bearing** (a tampered or replayed value can at worst mislabel a
/// row) — no protective-envelope clamp. No per-name length cap here either: the
/// clients cap the input for readability, and the `MAX_PREFS_PLAINTEXT_LEN`
/// ceiling already fails the encode closed.
///
/// Logs the field name only — NEVER the name or the device id. The name is the
/// user's own input (AS3-sensitive, like `label`); the device id is a
/// correlation tag (like the `item_colors` keys).
pub async fn set_device_name_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    device_id_hex: String,
    name: String,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_device_name_with_dir(&dir, state, hooks, device_id_hex, name, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_device_name<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    device_id_hex: String,
    name: String,
) -> Result<(), PrefsWriteError> {
    set_device_name_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        device_id_hex,
        name,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_device_name`].
pub(crate) async fn set_device_name_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    device_id_hex: String,
    name: String,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    // The key is permanent (§10.2 union merge has no deletion) and replicates to
    // every peer, so a malformed one is unrecoverable in-app. Reject anything that
    // is not a 32-char lowercase-hex device_id before the read-modify-write.
    if device_id_hex.len() != 32
        || !device_id_hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Ok(());
    }

    let trimmed = name.trim();
    if trimmed.is_empty() {
        // Empty submit == cancel (see the doc comment). Nothing is written, so
        // the previous name — or the client's id-derived fallback — survives.
        return Ok(());
    }
    let value = trimmed.to_string();

    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.device_names.insert(device_id_hex, value);
        },
        io,
        host,
    )
    .await?;

    // Field name only — neither the label nor the device id reaches the log
    // surface (see the doc comment).
    tracing::info!(event = "prefs_written", field = "device_names");
    Ok(())
}

/// Slot::Unlocked-gated setter for the per-vault `label` field (MYND-205) — the
/// human-readable name the in-app vault switcher shows for this vault. `Some`
/// sets/changes it; `None` clears it (back to the neutral-fallback state).
/// Read-modify-write under the per-plugin write mutex; **no native side-effect**
/// (same disk-only shape as `set_theme`).
///
/// **Unlock-gated by construction** (SYNC-3): writing the label needs
/// `prefs_key`, which only exists while the vault is unlocked — and under
/// SYNC-1 the sole `Unlocked` slot is the active vault — so the user can only
/// rename the vault they are currently inside. After the disk write commits,
/// the decrypted label is refreshed in the per-session RAM cache so the
/// switcher (`vault_list`) reflects the rename immediately. The plaintext label
/// lives ONLY inside the AEAD-sealed `vault.prefs` at rest and in that RAM
/// cache at runtime; it is never logged (DENY-list discipline — the value is
/// the user's own input, treated as AS3-sensitive).
///
/// Since myne-md/myne#411 a rename also writes THROUGH to the device-local
/// sealed label store (`MYL1`), so the LOCKED picker shows the new name on the
/// next launch instead of the one this device last unlocked under. That write
/// is suppressed while the device-wide hide-vault-names option is on, and it is
/// best-effort: see [`crate::vault_label::writeback`].
pub async fn vault_set_label_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    label: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
    keychain: &dyn crate::vault_label::key::LabelKeychain,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    vault_set_label_with_dir(&dir, state, hooks, label, io, host, keychain).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn vault_set_label<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    label: Option<String>,
) -> Result<(), PrefsWriteError> {
    vault_set_label_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        label,
        &crate::vault_io::StdVaultIo,
        crate::vault_label::key::platform_keychain(),
    )
    .await
}

/// Testable core of [`vault_set_label`]. Performs the disk-side commit
/// (read-modify-write under the per-plugin write mutex) FIRST, then refreshes
/// the active vault's entry in the per-session RAM label cache (the "effect";
/// window-free, so it lives in the core rather than the wrapper — like
/// `set_auto_lock_timeout`'s idle-timer cache refresh). The disk-FIRST-then-
/// effect ordering holds: a disk-write failure returns before the cache update,
/// so the switcher never reflects a label that did not persist.
pub(crate) async fn vault_set_label_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    label: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
    keychain: &dyn crate::vault_label::key::LabelKeychain,
) -> Result<(), PrefsWriteError> {
    let cleared = label.is_none();
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.label = label.clone();
        },
        io,
        host,
    )
    .await?;

    // Effect SECOND (only on disk success): refresh the active vault's entry in
    // the per-session RAM label cache so `vault_list` reflects the rename
    // immediately. SYNC-1: the sole `Unlocked` slot is the active vault we just
    // wrote to. If a concurrent lock raced (Phase 2 only; impossible Phase 1
    // single-window), `active_vault_id` returns None and the cache update is
    // skipped — disk truth is canonical and the next unlock re-decrypts it.
    if let Some(active) = state.active_vault_id().await {
        state.set_cached_label(active, label.clone()).await;

        // myne-md/myne#411: and write THROUGH to the device-local sealed label
        // store, so the LOCKED picker shows the new name on the next launch
        // rather than the one this device last unlocked under. The id comes
        // from the runtime slot for the same reason the cache key does: the
        // slot is the authority, so a caller cannot seal one vault's name into
        // another's directory.
        //
        // Best-effort and LAST. It is a device-local convenience cache: a
        // keychainless device must still be able to rename its vault, and the
        // picker there falls back to the neutral label exactly as it does
        // today. The suppression while the hide option is on lives inside
        // `persist_label_from_host`, not here, so this call site cannot
        // disagree with the Settings row about what a damaged flag file means.
        crate::vault_label::writeback::persist_label_from_host(
            host,
            io,
            vault_dir,
            active,
            label.as_deref(),
            keychain,
        )
        .await;
    }

    // Field name + set/cleared only — NEVER the label value (it is the user's
    // own input, treated as AS3-sensitive; see ../../AGENTS.md "Secret-handling
    // logging discipline").
    tracing::info!(event = "prefs_written", field = "label", cleared);
    Ok(())
}

/// Slot::Unlocked-gated setter for the per-vault `icon` field (vault-icons) —
/// the curated switcher glyph name shown beside this vault's name. `Some`
/// sets/changes it; `None` clears it (back to the neutral-wordmark state). The
/// twin of [`vault_set_label`]: read-modify-write under the per-plugin write
/// mutex, **no native side-effect** (disk-only, like `set_theme`).
///
/// **Unlock-gated by construction** (SYNC-3): writing the icon needs
/// `prefs_key`, which only exists while the vault is unlocked — and under SYNC-1
/// the sole `Unlocked` slot is the active vault — so the user can only re-icon
/// the vault they are currently inside. After the disk write commits, the
/// decrypted icon is refreshed in the per-session RAM cache so the switcher
/// (`vault_list`) reflects the change immediately. The glyph name lives ONLY
/// inside the AEAD-sealed `vault.prefs` at rest and in that RAM cache at runtime.
pub async fn vault_set_icon_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    icon: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    vault_set_icon_with_dir(&dir, state, hooks, icon, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn vault_set_icon<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    icon: Option<String>,
) -> Result<(), PrefsWriteError> {
    vault_set_icon_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        icon,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`vault_set_icon`]. Performs the disk-side commit
/// (read-modify-write under the per-plugin write mutex) FIRST, then refreshes
/// the active vault's entry in the per-session RAM icon cache (the "effect") —
/// same disk-FIRST-then-effect ordering as [`vault_set_label_with_dir`], so the
/// switcher never reflects an icon that did not persist.
pub(crate) async fn vault_set_icon_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    icon: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    let cleared = icon.is_none();
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.icon = icon.clone();
        },
        io,
        host,
    )
    .await?;

    // Effect SECOND (only on disk success): refresh the active vault's entry in
    // the per-session RAM icon cache so `vault_list` reflects the change
    // immediately. SYNC-1: the sole `Unlocked` slot is the active vault we just
    // wrote to; a concurrent lock race (Phase 2 only) makes `active_vault_id`
    // return None and the cache update is skipped — disk truth is canonical.
    if let Some(active) = state.active_vault_id().await {
        state.set_cached_icon(active, icon).await;
    }

    // Field name + set/cleared only — the glyph name is a curated, closed-set
    // value (not free user text), but we keep parity with label's discipline
    // and never log the value itself.
    tracing::info!(event = "prefs_written", field = "icon", cleared);
    Ok(())
}

/// Slot::Unlocked-gated setter for the `color_groups` list (graph-connection-
/// ux-polish, docs/spec/protocol.md §9.5.2) — the ordered color-group rule list
/// the graph pane's color-group editor authors. Read-modify-write under the
/// per-plugin write mutex; **no native side-effect**. The caller passes the
/// FULL desired list; the codec preserves element order VERBATIM (order IS
/// rule precedence here — unlike `saved_views`, there is no separate
/// `*_order` field, so this is a whole-list replace in the `set_bar_items_order`
/// shape, not a per-item upsert/delete like `upsert_saved_view`). Classified
/// `Shared(WholeValueLww)` in `prefs_classification` — the centralized LWW
/// clock stamp in `update_prefs_with_dir` covers this field automatically.
/// Logs the COUNT only — never a rule name, color key or filter (AS3-Sensitive).
pub async fn set_color_groups_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    groups: Vec<ColorGroup>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_color_groups_with_dir(&dir, state, hooks, groups, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_color_groups<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    groups: Vec<ColorGroup>,
) -> Result<(), PrefsWriteError> {
    set_color_groups_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        groups,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_color_groups`].
pub(crate) async fn set_color_groups_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    groups: Vec<ColorGroup>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    let count = groups.len();
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            prefs.color_groups = groups;
        },
        io,
        host,
    )
    .await?;

    // COUNT only — never a rule name, color key or filter (AS3-Sensitive).
    tracing::info!(event = "prefs_written", field = "color_groups", count);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::vault_unlock::state::{fixture_unlocked_with_keys, test_vault_id};
    use crate::test_support::ScopedTempDir;
    use protocol::{encode_prefs_blob_raw, AEAD_NONCE_LEN};

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    /// A `Hooks` that overrides nothing.
    ///
    /// **It CLAMPS**, and an earlier version of this doc said the opposite
    /// ("a no-op, returns the value unchanged, the core has no desktop clamp
    /// range"). Since myne-md/myne#479 the envelope is shared and
    /// `VaultLifecycleHooks::effective_auto_lock_secs` is defaulted to it, which
    /// `NoopHooks` inherits. A test written on the old belief would assert
    /// against a clamped value and read as passing for the wrong reason.
    fn noop_hooks() -> crate::hooks::Hooks {
        std::sync::Arc::new(crate::hooks::NoopHooks)
    }

    // `CountingHooks` moved to `crate::hooks` (#266) so the themes plugin's
    // identical sync-window assertion uses the same double instead of a second
    // 26-method copy.
    use crate::hooks::test_hooks::CountingHooks;

    fn counting_hooks() -> (
        crate::hooks::Hooks,
        std::sync::Arc<std::sync::atomic::AtomicU64>,
    ) {
        let counter = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        (
            std::sync::Arc::new(CountingHooks::new(counter.clone())),
            counter,
        )
    }

    #[test]
    fn shared_pref_edit_bumps_the_sync_push_window() {
        // MYND-517: a shared-LWW edit (the vault rename that motivated the
        // bug) must call bump_local_change so the sync scheduler opens the
        // coalesced push window — without it a prefs-only change waits for an
        // unrelated note push forever.
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            let (hooks, bumps) = counting_hooks();
            vault_set_label_with_dir(
                tmp.path(),
                &state,
                &hooks,
                Some("Renamed".into()),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
                &crate::vault_label::key::UnavailableKeychain,
            )
            .await
            .expect("set label");
            assert_eq!(bumps.load(std::sync::atomic::Ordering::Relaxed), 1);
        });
    }

    // folder_notes_enabled setter (myne-md/myne#661): default off, round-trips.

    #[test]
    fn set_folder_notes_enabled_persists_and_reads_back() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            let io = crate::vault_io::StdVaultIo;

            // Default off: a fresh vault never enabled folder notes.
            let prefs = prefs_read_with_dir(tmp.path(), &state, &io)
                .await
                .expect("read prefs");
            assert!(!prefs.folder_notes_enabled);

            // Turn it on, read it back.
            set_folder_notes_enabled_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                true,
                &io,
                &crate::host::NoopHost,
            )
            .await
            .expect("enable folder notes");
            let prefs = prefs_read_with_dir(tmp.path(), &state, &io)
                .await
                .expect("read prefs");
            assert!(prefs.folder_notes_enabled);

            // Turn it back off.
            set_folder_notes_enabled_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                false,
                &io,
                &crate::host::NoopHost,
            )
            .await
            .expect("disable folder notes");
            let prefs = prefs_read_with_dir(tmp.path(), &state, &io)
                .await
                .expect("read prefs");
            assert!(!prefs.folder_notes_enabled);
        });
    }

    // periodic_notes setter (myne#177).

    #[test]
    fn set_periodic_note_setting_writes_the_composed_key_and_registers_the_folder() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            set_periodic_note_setting_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                "weekly".into(),
                "folder".into(),
                Some("Weekly/".into()),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("set weekly folder");

            let prefs = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read prefs");
            assert_eq!(
                prefs
                    .periodic_notes
                    .get("weekly.folder")
                    .map(String::as_str),
                Some("Weekly/")
            );
            // The daily folder's discipline (MYND-144): without this the folder
            // is invisible in the sidebar until the first note lands in it, so
            // the setting looks like it did nothing.
            assert!(prefs.deliberate_folders.iter().any(|f| f == "Weekly/"));
        });
    }

    #[test]
    fn set_periodic_note_setting_clears_by_removing_the_key() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            let io = crate::vault_io::StdVaultIo;
            for (setting, value) in [("folder", "Weekly/"), ("template", "0190a000-tmpl")] {
                set_periodic_note_setting_with_dir(
                    tmp.path(),
                    &state,
                    &noop_hooks(),
                    "weekly".into(),
                    setting.into(),
                    Some(value.into()),
                    &io,
                    &crate::host::NoopHost,
                )
                .await
                .expect("set");
            }
            set_periodic_note_setting_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                "weekly".into(),
                "template".into(),
                None,
                &io,
                &crate::host::NoopHost,
            )
            .await
            .expect("clear template");

            let prefs = prefs_read_with_dir(tmp.path(), &state, &io)
                .await
                .expect("read prefs");
            assert!(!prefs.periodic_notes.contains_key("weekly.template"));
            // Clearing one setting must not disturb the period's others.
            assert_eq!(
                prefs
                    .periodic_notes
                    .get("weekly.folder")
                    .map(String::as_str),
                Some("Weekly/")
            );
        });
    }

    /// **The clear the UNDO reaches for two of the twelve intents**
    /// (myne-md/myne#850, from the 2026-10-14 review). `set_daily_folder` takes a
    /// required value, so the undo of "the run set this for the first time" has
    /// no setter to reach; these two exist for exactly that state, and neither
    /// had a test, so emptying either body left every gate green.
    #[test]
    fn clear_daily_folder_empties_the_pointer_and_keeps_the_folder_on_record() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            let io = crate::vault_io::StdVaultIo;
            set_daily_folder_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                "Daily/".into(),
                &io,
                &crate::host::NoopHost,
            )
            .await
            .expect("set");
            clear_daily_folder_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                &io,
                &crate::host::NoopHost,
            )
            .await
            .expect("clear");

            let prefs = prefs_read_with_dir(tmp.path(), &state, &io)
                .await
                .expect("read prefs");
            assert!(prefs.daily_folder.is_none());
            // The NAME stays on record: that record is what keeps the folder
            // alive as a virtual folder, and clearing the pointer is the state
            // the user had before the run.
            assert!(prefs.deliberate_folders.iter().any(|f| f == "Daily/"));
        });
    }

    /// The `daily_date_format` twin, and the same deletion-test reasoning.
    #[test]
    fn clear_daily_date_format_empties_the_pointer() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            let io = crate::vault_io::StdVaultIo;
            set_daily_date_format_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                "YYYY-MM-DD".into(),
                &io,
                &crate::host::NoopHost,
            )
            .await
            .expect("set");
            clear_daily_date_format_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                &io,
                &crate::host::NoopHost,
            )
            .await
            .expect("clear");

            let prefs = prefs_read_with_dir(tmp.path(), &state, &io)
                .await
                .expect("read prefs");
            assert!(prefs.daily_date_format.is_none());
        });
    }

    #[test]
    fn set_periodic_note_setting_refuses_an_unknown_setting_or_a_dotted_period() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            let io = crate::vault_io::StdVaultIo;
            for (period, setting) in [
                ("weekly", "colour"),       // not one of the three
                ("weekly.extra", "folder"), // a dot makes the key ambiguous
                ("", "folder"),             // empty period
                ("Weekly", "folder"),       // not a bare lowercase word
                // Daily keeps its three flat fields; an entry here would write,
                // sync and be read by nothing, which is a second home for one
                // setting.
                ("daily", "folder"),
                ("daily", "format"),
                ("daily", "template"),
            ] {
                let err = set_periodic_note_setting_with_dir(
                    tmp.path(),
                    &state,
                    &noop_hooks(),
                    period.into(),
                    setting.into(),
                    Some("x".into()),
                    &io,
                    &crate::host::NoopHost,
                )
                .await
                .expect_err("must refuse");
                assert!(
                    matches!(err, PrefsWriteError::InvalidValue),
                    "{period}.{setting}"
                );
            }
            // Refusing means writing nothing, not writing something odd.
            let prefs = prefs_read_with_dir(tmp.path(), &state, &io)
                .await
                .expect("read prefs");
            assert!(prefs.periodic_notes.is_empty());
        });
    }

    #[test]
    fn set_periodic_note_setting_accepts_a_period_this_build_has_no_ui_for() {
        // The period is validated as a GRAMMAR, not against a closed list. That
        // is what makes a fourth period a client-side change with no codec,
        // spec or vector edit behind it.
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            let io = crate::vault_io::StdVaultIo;
            set_periodic_note_setting_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                "quarterly".into(),
                "folder".into(),
                Some("Quarterly/".into()),
                &io,
                &crate::host::NoopHost,
            )
            .await
            .expect("set quarterly folder");
            let prefs = prefs_read_with_dir(tmp.path(), &state, &io)
                .await
                .expect("read prefs");
            assert_eq!(
                prefs
                    .periodic_notes
                    .get("quarterly.folder")
                    .map(String::as_str),
                Some("Quarterly/")
            );
        });
    }

    #[test]
    fn set_union_pref_edit_bumps_the_sync_push_window() {
        // MYND-517: set-union fields are SHARED but clockless (never stamped
        // by stamp_changed_shared_fields) — the bump gate is the shared-subset
        // hash, which sees the value change itself, so they bump too.
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            let (hooks, bumps) = counting_hooks();
            set_spell_languages_with_dir(
                tmp.path(),
                &state,
                &hooks,
                SetMutation::adding_all(vec!["en".into()]),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("set spell languages");
            assert_eq!(bumps.load(std::sync::atomic::Ordering::Relaxed), 1);
        });
    }

    #[test]
    fn device_local_pref_edit_never_bumps() {
        // MYND-517 no-traffic discipline (§10.2.1): a device-local edit
        // re-encrypts the blob but leaves the shared subset unchanged — it
        // must NOT open a push window (resolution-blur; a poll-only device
        // stays poll-only).
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            let (hooks, bumps) = counting_hooks();
            set_theme_with_dir(
                tmp.path(),
                &state,
                &hooks,
                Some(protocol::ThemeChoice::Dark),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("set theme");
            assert_eq!(bumps.load(std::sync::atomic::Ordering::Relaxed), 0);
        });
    }

    #[test]
    fn noop_shared_pref_write_never_bumps() {
        // MYND-517: re-writing the SAME shared value changes neither the field
        // clocks nor the shared subset — no pointless push cycle.
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            let (hooks, bumps) = counting_hooks();
            vault_set_label_with_dir(
                tmp.path(),
                &state,
                &hooks,
                Some("Same".into()),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
                &crate::vault_label::key::UnavailableKeychain,
            )
            .await
            .expect("first set");
            vault_set_label_with_dir(
                tmp.path(),
                &state,
                &hooks,
                Some("Same".into()),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
                &crate::vault_label::key::UnavailableKeychain,
            )
            .await
            .expect("no-op re-set");
            assert_eq!(bumps.load(std::sync::atomic::Ordering::Relaxed), 1);
        });
    }

    // ── device_names (MYND-548 / SYNC-41) ────────────────────────────────────

    /// A device id key shaped like the real thing (32 lowercase hex chars).
    const DEV_HEX: &str = "3f9ac2d1aabbccdd00112233445566ff";

    #[test]
    fn device_name_round_trips_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x41).await;
            set_device_name_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                DEV_HEX.into(),
                "Studio Mac".into(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("set device name");

            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read prefs");
            assert_eq!(
                view.device_names.get(DEV_HEX).map(String::as_str),
                Some("Studio Mac")
            );
        });
    }

    #[test]
    fn device_name_write_stamps_its_per_key_field_clock() {
        // sync-protocol.md §10.2: device_names races per KEY, on a namespaced
        // `device_names/<key>` clock — not one clock for the whole map.
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x42).await;
            set_device_name_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                DEV_HEX.into(),
                "Laptop".into(),
                &crate::vault_io::StdVaultIo,
                &crate::host::test_host::TestHost::new(tmp.path()),
            )
            .await
            .expect("set device name");

            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read prefs");
            let clock = view
                .field_clocks
                .get(&format!("device_names/{DEV_HEX}"))
                .copied();
            assert!(
                clock.is_some_and(|c| c > 0),
                "expected a stamped per-key clock, got {clock:?}"
            );
            // The whole-field name must NOT be stamped — that would make one
            // device's rename clobber every other device's name on merge.
            assert!(!view.field_clocks.contains_key("device_names"));
        });
    }

    #[test]
    fn device_name_edit_bumps_the_sync_push_window_once() {
        // MYND-517: device_names is SHARED, so a name change must open the
        // coalesced push window; re-writing the SAME name must not.
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x43).await;
            let (hooks, bumps) = counting_hooks();
            set_device_name_with_dir(
                tmp.path(),
                &state,
                &hooks,
                DEV_HEX.into(),
                "Phone".into(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("first set");
            assert_eq!(bumps.load(std::sync::atomic::Ordering::Relaxed), 1);

            set_device_name_with_dir(
                tmp.path(),
                &state,
                &hooks,
                DEV_HEX.into(),
                "Phone".into(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("no-op re-set");
            assert_eq!(bumps.load(std::sync::atomic::Ordering::Relaxed), 1);
        });
    }

    #[test]
    fn device_name_is_nfc_normalized_through_the_codec() {
        // The setter does not normalize; push_canonical_string_map folds keys
        // AND values to NFC on encode (the spell_languages precedent). Writing
        // a decomposed "é" must read back precomposed, or two devices could
        // encode byte-different blobs for the same visible name.
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x44).await;
            set_device_name_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                DEV_HEX.into(),
                "Cafe\u{0301} Mac".into(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("set device name");

            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read prefs");
            assert_eq!(
                view.device_names.get(DEV_HEX).map(String::as_str),
                Some("Caf\u{00e9} Mac")
            );
        });
    }

    #[test]
    fn device_name_is_storable_for_an_unknown_device_id() {
        // The map is keyed independently of the server roster: a name can be
        // written for a device the roster has never reported (the enrolling
        // device names ITSELF before approval, and a removed device keeps its
        // entry — sync-protocol.md §4 never prunes).
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x45).await;
            set_device_name_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                "ffffffffffffffffffffffffffffffff".into(),
                "Retired phone".into(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("set device name");

            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read prefs");
            assert_eq!(view.device_names.len(), 1);
        });
    }

    #[test]
    fn empty_device_name_is_a_no_op_and_preserves_the_previous_name() {
        // Empty submit == cancel. There is no clear path (the §10.2 union merge
        // cannot propagate a deletion), so a blank must never reach the blob.
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x46).await;
            let (hooks, bumps) = counting_hooks();
            set_device_name_with_dir(
                tmp.path(),
                &state,
                &hooks,
                DEV_HEX.into(),
                "Desk".into(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("set device name");

            for blank in ["", "   ", "\t\n"] {
                set_device_name_with_dir(
                    tmp.path(),
                    &state,
                    &hooks,
                    DEV_HEX.into(),
                    blank.into(),
                    &crate::vault_io::StdVaultIo,
                    &crate::host::NoopHost,
                )
                .await
                .expect("blank is Ok, not an error");
            }

            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read prefs");
            assert_eq!(
                view.device_names.get(DEV_HEX).map(String::as_str),
                Some("Desk")
            );
            // A refused write must not open a push window either.
            assert_eq!(bumps.load(std::sync::atomic::Ordering::Relaxed), 1);
        });
    }

    #[test]
    fn device_name_is_trimmed_before_storage() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x47).await;
            set_device_name_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                DEV_HEX.into(),
                "  Work Mac \n".into(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("set device name");

            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read prefs");
            assert_eq!(
                view.device_names.get(DEV_HEX).map(String::as_str),
                Some("Work Mac")
            );
        });
    }

    #[test]
    fn malformed_device_id_is_refused() {
        // The key is permanent and replicates; a junk one could never be removed
        // from the account afterwards.
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x48).await;
            for bad in [
                "",
                "short",
                "AA11BB22CC33DD44EE55FF6677889900",
                "zz11bb22cc33dd44ee55ff6677889900",
            ] {
                set_device_name_with_dir(
                    tmp.path(),
                    &state,
                    &noop_hooks(),
                    bad.into(),
                    "Nope".into(),
                    &crate::vault_io::StdVaultIo,
                    &crate::host::NoopHost,
                )
                .await
                .expect("refusal is Ok, not an error");
            }
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read prefs");
            assert!(view.device_names.is_empty());
        });
    }

    /// #250: the key comes from the unlocked slot and the directory comes from
    /// the caller. A caller holding a stale "which vault is active" answer used
    /// to encrypt this vault's prefs under that vault's key and write them over
    /// the other vault's real blob — silently, because `read_or_default`
    /// degrades an unreadable blob to defaults instead of failing.
    #[test]
    fn a_prefs_write_aimed_at_another_vault_is_refused() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            // A directory that derives a DIFFERENT VaultId than the slot holds.
            let other = tmp
                .path()
                .join("vaults")
                .join("33333333-3333-7333-8333-333333333333");
            std::fs::create_dir_all(&other).expect("create sibling vault dir");
            seed_real_vault_meta(&other, 0x44);

            let err = vault_set_label_with_dir(
                &other,
                &state,
                &noop_hooks(),
                Some("Work".into()),
                &crate::vault_io::StdVaultIo,
                &crate::host::test_host::TestHost::new(tmp.path()),
                &crate::vault_label::key::UnavailableKeychain,
            )
            .await
            .expect_err("a write aimed at a non-active vault must be refused");
            assert!(
                matches!(err, PrefsWriteError::VaultTargetMismatch),
                "expected VaultTargetMismatch, got {err:?}"
            );
            // And it must have written NOTHING — the refusal happens before the
            // read-modify-write, so the other vault's blob never appears.
            assert!(
                !other.join("vault.prefs").exists(),
                "the refused write must not have created the other vault's prefs blob"
            );
        });
    }

    /// test-audit #40: a write whose READ degraded must refuse, not persist
    /// defaults over the blob it could not read.
    ///
    /// The loss this prevents is total and silent. §9.5.5 says an undecodable
    /// `vault.prefs` degrades to defaults so the vault stays openable — a READ
    /// rule. Carrying it into the write means the next toggle bases its
    /// read-modify-write on `PrefsView::default()` and persists that, over a
    /// blob that may be intact and merely unreadable at this instant. And
    /// because the SHARED subset syncs, the defaults do not stay local.
    #[test]
    fn a_prefs_write_is_refused_when_the_current_prefs_cannot_be_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            let vault_dir = tmp.path().to_path_buf();

            // Write real prefs first, so there is something to lose.
            vault_set_label_with_dir(
                &vault_dir,
                &state,
                &noop_hooks(),
                Some("Work".into()),
                &crate::vault_io::StdVaultIo,
                &crate::host::test_host::TestHost::new(tmp.path()),
                &crate::vault_label::key::UnavailableKeychain,
            )
            .await
            .expect("seed a real prefs blob");
            let stored = std::fs::read(vault_dir.join("vault.prefs")).expect("prefs on disk");
            assert!(!stored.is_empty(), "the fixture must have written prefs");

            // Corrupt it: the magic survives, the ciphertext does not decode.
            // This is the shape a torn write or a bit-rotted blob has, and the
            // one `read_or_default` degrades to defaults on.
            let mut corrupt = stored.clone();
            let tail = corrupt.len() - 1;
            corrupt[tail] ^= 0xff;
            std::fs::write(vault_dir.join("vault.prefs"), &corrupt).expect("corrupt the blob");

            let err = vault_set_label_with_dir(
                &vault_dir,
                &state,
                &noop_hooks(),
                Some("Home".into()),
                &crate::vault_io::StdVaultIo,
                &crate::host::test_host::TestHost::new(tmp.path()),
                &crate::vault_label::key::UnavailableKeychain,
            )
            .await
            .expect_err("a write over an unreadable prefs blob must be refused");
            assert!(
                matches!(err, PrefsWriteError::PrefsUnreadable),
                "expected PrefsUnreadable, got {err:?}"
            );

            // The refusal has teeth: the bytes on disk are untouched, so a
            // transient read failure leaves the real prefs recoverable.
            let after = std::fs::read(vault_dir.join("vault.prefs")).expect("prefs still there");
            assert_eq!(
                after, corrupt,
                "the refused write must not have replaced the blob it could not read"
            );
        });
    }

    /// The other half of #40, and the reason this is not simply "refuse on any
    /// non-Stored read": an ABSENT blob is an answer, not a failure. Every
    /// vault that has never opened Settings is in that state, so refusing there
    /// would make the first setting change impossible.
    #[test]
    fn a_prefs_write_still_works_when_no_prefs_have_ever_been_written() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            let vault_dir = tmp.path().to_path_buf();
            assert!(
                !vault_dir.join("vault.prefs").exists(),
                "this test needs a vault that has never written prefs"
            );
            vault_set_label_with_dir(
                &vault_dir,
                &state,
                &noop_hooks(),
                Some("First".into()),
                &crate::vault_io::StdVaultIo,
                &crate::host::test_host::TestHost::new(tmp.path()),
                &crate::vault_label::key::UnavailableKeychain,
            )
            .await
            .expect("an absent blob must not block the first write");
            let view = prefs_read_with_dir(&vault_dir, &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read prefs");
            assert_eq!(view.label.as_deref(), Some("First"));
        });
    }

    #[test]
    fn shared_field_setter_stamps_its_field_clock() {
        // MYND-478: every setter routed through update_prefs_with_dir stamps
        // the changed SHARED field's clock; a device-local setter stamps
        // nothing (sync-protocol.md §10.2).
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            vault_set_label_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                Some("Work".into()),
                &crate::vault_io::StdVaultIo,
                &crate::host::test_host::TestHost::new(tmp.path()),
                &crate::vault_label::key::UnavailableKeychain,
            )
            .await
            .expect("set label");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read");
            let label_clock = *view.field_clocks.get("label").expect("label stamped");
            assert!(label_clock > 0, "epoch-ms clock must be non-zero");

            // Device-local setter: no stamp, and the label clock survives.
            set_theme_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                Some(protocol::ThemeChoice::Dark),
                &crate::vault_io::StdVaultIo,
                &crate::host::test_host::TestHost::new(tmp.path()),
            )
            .await
            .expect("set theme");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read");
            assert!(!view.field_clocks.contains_key("theme"));
            assert_eq!(view.field_clocks.get("label"), Some(&label_clock));
        });
    }

    #[test]
    fn record_last_backup_at_round_trips_through_prefs() {
        // MYND-58: the export engine's best-effort recorder writes the
        // §9.5.2 `last_backup_at` field via the standard setter discipline.
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            record_last_backup_at_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                1765432100,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("record");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read");
            assert_eq!(view.last_backup_at, Some(1765432100));
        });
    }

    // ---- helpers -------------------------------------------------------

    async fn make_temp_vault_with_unlocked_state(
        seed_account_hash: u8,
    ) -> (ScopedTempDir, VaultRuntimeState) {
        let tmp = ScopedTempDir::new("prefs-it").expect("scoped tempdir");
        seed_real_vault_meta(tmp.path(), seed_account_hash);
        let state = VaultRuntimeState::default();
        // root_key matches the fixture's deterministic key material.
        // fixture_unlocked_with_keys(seed_root, seed_items, salts_seed)
        // derives root_key from `seed_root` (filling [u8; 32] with the
        // seed byte). Match that here so test assertions can recompute
        // prefs_key off the same root_key.
        let unlocked = fixture_unlocked_with_keys(0x42, 0x99, 1);
        state.set_unlocked(test_vault_id(), unlocked).await;
        (tmp, state)
    }

    /// Build a real 345-byte vault.meta blob with `account_number_hash`
    /// filled by `seed_byte` repeating. Other fields are filler bytes —
    /// the prefs code only consumes account_number_hash, so the other
    /// fields just need to parse-pass.
    fn seed_real_vault_meta(dir: &Path, seed_byte: u8) {
        let meta = protocol::VaultMeta {
            account_number_hash: [seed_byte; VAULT_META_ACCOUNT_HASH_LEN],
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
            person_binding: None,
        };
        std::fs::write(
            dir.join("vault.meta"),
            protocol::serialize_vault_meta(&meta),
        )
        .expect("seed vault.meta");
    }

    /// Compute the prefs_key the same way the production codec does,
    /// so encrypt-side test fixtures can seed a vault.prefs blob that
    /// the production decoder will accept.
    fn compute_prefs_key(seed_root: u8) -> [u8; 32] {
        let root_key = [seed_root; 32];
        let derived = protocol::derive_subkey(&root_key, SubkeyRole::PrefsKey);
        *derived
    }

    // ---- Slot precondition --------------------------------------------

    #[test]
    fn prefs_read_rejects_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let result =
                prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo).await;
            assert!(matches!(result, Err(PrefsReadError::SlotNotUnlocked)));
        });
    }

    #[test]
    fn set_screen_capture_protection_rejects_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-write-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            let result = set_screen_capture_protection_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                false,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(PrefsWriteError::SlotNotUnlocked)));
        });
    }

    // ---- read fall-back-to-defaults (§ 9.5.5) -------------------------

    #[test]
    fn prefs_read_returns_default_when_vault_prefs_absent() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            // vault.meta is seeded, vault.prefs is absent.
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("absent vault.prefs collapses to defaults");
            assert_eq!(view, PrefsView::default());
            assert!(
                view.screen_capture_protection,
                "default state has protection on per spec § 9.5.5"
            );
        });
    }

    #[test]
    fn prefs_read_returns_default_when_vault_prefs_tampered() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            // Seed a valid encrypted vault.prefs, then flip a byte.
            let prefs_key = compute_prefs_key(0x42);
            let account_hash = [0x33u8; VAULT_META_ACCOUNT_HASH_LEN];
            let mut blob = encode_prefs_blob_raw(
                &prefs_key,
                &account_hash,
                &PrefsView {
                    attachment_compression_enabled: true,
                    developer_mode: false,
                    ribbon_items: None,
                    ribbon_visible: true,
                    attachment_ocr_enabled: true,
                    time_format: None,
                    timezone: None,
                    transcription_enabled: true,
                    screen_capture_protection: false,
                    ai_enabled: false,
                    ai_excluded_folders: Vec::new(),
                    ai_provider: None,
                    ai_provider_consent: None,
                    ai_provider_key: None,
                    ai_provider_model: None,
                    meeting_ai_prompt: None,
                    bar_items_order: Vec::new(),
                    cli_enabled: false,
                    cli_excluded_folders: Vec::new(),
                    cli_rate_limit_disabled: None,
                    color_groups: Vec::new(),
                    editor_toolbar_order: Vec::new(),
                    editor_toolbar_hidden: Vec::new(),
                    editor_slash_order: Vec::new(),
                    editor_slash_hidden: Vec::new(),
                    show_note_timestamps: true,
                    reminders_enabled: true,
                    reminder_horizon_days: None,
                    show_task_marker: true,
                    folder_icons: Default::default(),
                    folder_notes_enabled: false,
                    hidden_bar_items: Vec::new(),
                    icon: None,
                    item_colors: Default::default(),
                    theme: None,
                    deliberate_folders: Vec::new(),
                    device_names: Default::default(),
                    auto_lock_seconds: None,
                    auto_tag_enabled: false,
                    custom_theme: None,
                    daily_date_format: None,
                    daily_folder: None,
                    daily_template: None,
                    date_format: None,
                    favorites: Vec::new(),
                    field_clocks: Default::default(),
                    item_order: Default::default(),
                    keymap: Default::default(),
                    active_workspace: None,
                    chat_history_budget: None,
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
                    periodic_notes: Default::default(),
                    right_panel_active_tab: None,
                    right_panel_hidden_tabs: Vec::new(),
                    right_panel_tab_order: Vec::new(),
                    spell_enabled: None,
                    spell_languages: Vec::new(),
                    startup_open: None,
                    startup_open_note: None,
                    saved_views: Vec::new(),
                    opaque_saved_views: Vec::new(),
                    view_order: Vec::new(),
                },
                &[0x77; AEAD_NONCE_LEN],
            )
            .expect("encode");
            blob[40] ^= 0xFF;
            std::fs::write(tmp.path().join("vault.prefs"), &blob).expect("seed tampered prefs");

            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("tampered vault.prefs collapses to defaults");
            assert_eq!(view, PrefsView::default());
        });
    }

    // ---- round-trip via the plugin's own write+read --------------------

    #[test]
    fn round_trip_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

            // Toggle off via the plugin.
            set_screen_capture_protection_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                false,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write must succeed");

            // Disk file now exists.
            assert!(
                tmp.path().join("vault.prefs").exists(),
                "set_screen_capture_protection must create vault.prefs"
            );

            // Read back via the plugin.
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read must succeed after write");
            assert!(
                !view.screen_capture_protection,
                "toggled-off value must round-trip"
            );

            // Toggle back on.
            set_screen_capture_protection_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                true,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("second write must succeed");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read must succeed after second write");
            assert!(
                view.screen_capture_protection,
                "toggled-on value must round-trip"
            );
        });
    }

    // ---- editor_layout setter (MYND-137) ------------------------------

    #[test]
    fn editor_layout_round_trips_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

            let layout = EditorLayout {
                left_width: 312,
                right_width: 248,
                left_collapsed: false,
                right_collapsed: true,
            };
            set_editor_layout_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                layout,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write must succeed");

            assert!(
                tmp.path().join("vault.prefs").exists(),
                "set_editor_layout must create vault.prefs"
            );

            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read must succeed after write");
            assert_eq!(
                view.editor_layout,
                Some(layout),
                "editor_layout value must round-trip through disk"
            );

            // A second write overwrites (last-write-wins on the whole object).
            let layout2 = EditorLayout {
                left_width: 200,
                right_width: 460,
                left_collapsed: true,
                right_collapsed: false,
            };
            set_editor_layout_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                layout2,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("second write must succeed");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read must succeed after second write");
            assert_eq!(view.editor_layout, Some(layout2));
        });
    }

    // ---- deliberate_folders setter (MYND-144) -------------------------

    // ---- auto_lock_seconds setter (MYND-121) --------------------------

    #[test]
    fn auto_lock_timeout_round_trips_and_caches_effective() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

            set_auto_lock_timeout_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                900,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write must succeed");

            // Disk: prefs_read returns the raw stored value.
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read must succeed after write");
            assert_eq!(view.auto_lock_seconds, Some(900));

            // Effect: the cached effective timeout the idle timer reads is
            // updated (900 is in-range → unchanged by the clamp).
            assert_eq!(state.auto_lock_timeout_secs(), 900);
        });
    }

    // The clamp-WIRING test (`set_auto_lock_timeout_stores_raw_but_caches_clamped`)
    // asserts the cached effective timeout is clamped to the ceiling, and it
    // still lives desktop-side (`src-tauri/src/plugins/prefs/mod.rs` tests) for
    // historical reasons rather than because the clamp is desktop-only: since
    // myne-md/myne#479 it is shared and defaulted, so `noop_hooks()` above
    // clamps too. The clamp FUNCTION is unit-tested beside itself in
    // `core/src/lib.rs::auto_lock_envelope_tests`, and the trait DEFAULT is
    // covered in `core/src/hooks.rs`.

    #[test]
    fn deliberate_folders_round_trip_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

            set_deliberate_folders_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                SetMutation::adding_all(alloc_vec(["Projects/Myne/", "Archive/2025/"])),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write must succeed");

            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read must succeed after write");
            // Canonical sort applies at encode → read-back is sorted.
            assert_eq!(
                view.deliberate_folders,
                alloc_vec(["Archive/2025/", "Projects/Myne/"]),
            );
            // screen_capture_protection untouched (defaults on).
            assert!(view.screen_capture_protection);

            // Empty set round-trips (and re-encodes byte-identical to v0.1.0).
            set_deliberate_folders_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                SetMutation {
                    add: Vec::new(),
                    add_unless_removed: Vec::new(),
                    remove: vec!["Projects/Myne/".to_string(), "Archive/2025/".to_string()],
                    remove_prefix: Vec::new(),
                    rename_prefix: Vec::new(),
                },
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("clear must succeed");
            let cleared = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after clear");
            assert!(cleared.deliberate_folders.is_empty());
        });
    }

    // ---- archived_folders setter (folder-archive) ---------------------

    #[test]
    fn archived_folders_round_trip_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x34).await;

            set_archived_folders_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                SetMutation::adding_all(alloc_vec(["Projects/Myne/", "Archive/2025/"])),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write must succeed");

            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read must succeed after write");
            // Canonical sort applies at encode → read-back is sorted.
            assert_eq!(
                view.archived_folders,
                alloc_vec(["Archive/2025/", "Projects/Myne/"]),
            );
            // Independent of deliberate_folders (the two sets don't interfere).
            assert!(view.deliberate_folders.is_empty());

            // Empty set round-trips (and re-encodes byte-identical to pre-feature).
            set_archived_folders_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                SetMutation {
                    add: Vec::new(),
                    add_unless_removed: Vec::new(),
                    remove: vec!["Projects/Myne/".to_string(), "Archive/2025/".to_string()],
                    remove_prefix: Vec::new(),
                    rename_prefix: Vec::new(),
                },
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("clear must succeed");
            let cleared = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after clear");
            assert!(cleared.archived_folders.is_empty());
        });
    }

    // ---- AI prefs setters (local-ai, ai-ux-surface MYND-408) ----------

    #[test]
    fn ai_prefs_round_trip_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x51).await;

            // Defaults: AI off, no exclusions.
            let base = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read");
            assert!(!base.ai_enabled);
            assert!(base.ai_excluded_folders.is_empty());

            // Enable + set exclusions (unsorted input).
            set_ai_enabled_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                true,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("enable must succeed");
            set_ai_excluded_folders_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                SetMutation::adding_all(alloc_vec(["Private/", "Archive/2025/"])),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("set exclusions must succeed");

            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after write");
            assert!(view.ai_enabled);
            // Canonical sort applies at encode → read-back is sorted.
            assert_eq!(
                view.ai_excluded_folders,
                alloc_vec(["Archive/2025/", "Private/"]),
            );
            // Unrelated fields untouched (defaults on).
            assert!(view.screen_capture_protection);

            // Disable + clear → back to defaults (byte-identical to pre-field).
            set_ai_enabled_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                false,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("disable must succeed");
            set_ai_excluded_folders_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                SetMutation {
                    add: Vec::new(),
                    add_unless_removed: Vec::new(),
                    remove: vec!["Private/".to_string(), "Archive/2025/".to_string()],
                    remove_prefix: Vec::new(),
                    rename_prefix: Vec::new(),
                },
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("clear must succeed");
            let cleared = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after clear");
            assert!(!cleared.ai_enabled);
            assert!(cleared.ai_excluded_folders.is_empty());
        });
    }

    // ---- Developer mode setter (developer-mode, MYND-593) -------------

    /// **The clamp is the control, so it is asserted through the COMMAND, not
    /// through a helper** (myne-md/myne#617). This number bounds how much of the
    /// user's plaintext one agent run sends to a provider, multiplied by the
    /// loop's iteration ceiling, and TB13 records that no other per-run volume
    /// cap exists. A test that called a clamping function directly would prove
    /// the function clamps and say nothing about whether the write path uses it,
    /// which is exactly the gap between a host-side rule and a host-side rule
    /// whose trigger came from the caller.
    #[test]
    fn chat_history_budget_is_clamped_at_the_write_not_in_the_ui() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x53).await;
            let io = crate::vault_io::StdVaultIo;
            let max = crate::plugins::agent::history::MAX_HISTORY_BUDGET as u32;

            // Unset by default: the host applies its own, and the field is
            // omitted from the blob entirely.
            let base = prefs_read_with_dir(tmp.path(), &state, &io)
                .await
                .expect("read");
            assert_eq!(base.chat_history_budget, None);

            // A value over the ceiling is STORED at the ceiling. Read back from
            // disk rather than trusted from the return value: a host that
            // reported success and wrote the raw number would pass a
            // return-value assertion.
            set_chat_history_budget_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                Some(max + 50_000),
                &io,
                &crate::host::NoopHost,
            )
            .await
            .expect("write must succeed");
            let over = prefs_read_with_dir(tmp.path(), &state, &io)
                .await
                .expect("read");
            assert_eq!(
                over.chat_history_budget,
                Some(max),
                "an over-ceiling budget must be stored at the ceiling, not as sent"
            );

            // An ordinary value survives unchanged, which is the direction that
            // would make the clamp a bug rather than a bound.
            set_chat_history_budget_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                Some(1_500),
                &io,
                &crate::host::NoopHost,
            )
            .await
            .expect("write must succeed");
            let ordinary = prefs_read_with_dir(tmp.path(), &state, &io)
                .await
                .expect("read");
            assert_eq!(ordinary.chat_history_budget, Some(1_500));

            // And `None` clears the override rather than storing a zero: unset
            // and "seed nothing" are different states, and only one of them is
            // the default.
            set_chat_history_budget_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                None,
                &io,
                &crate::host::NoopHost,
            )
            .await
            .expect("write must succeed");
            let cleared = prefs_read_with_dir(tmp.path(), &state, &io)
                .await
                .expect("read");
            assert_eq!(cleared.chat_history_budget, None);
        });
    }

    #[test]
    fn developer_mode_persist_and_reload_round_trip() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x52).await;

            // Default: off.
            let base = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read");
            assert!(!base.developer_mode);

            // Enable, then reload from a fresh read (persist-and-reload).
            set_developer_mode_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                true,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("enable must succeed");
            let enabled = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after enable");
            assert!(enabled.developer_mode);
            // Unrelated fields untouched.
            assert!(enabled.screen_capture_protection);

            // Disable → back to default (byte-identical to pre-field, since the
            // codec emits the key only when true).
            set_developer_mode_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                false,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("disable must succeed");
            let disabled = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after disable");
            assert!(!disabled.developer_mode);
        });
    }

    // ---- CLI prefs setters (myne-cli epic, MYND-490; task 2) ----------

    #[test]
    fn cli_prefs_round_trip_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x52).await;

            // Defaults: door closed, no exclusions, rate limit untouched.
            let base = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read");
            assert!(!base.cli_enabled);
            assert!(base.cli_excluded_folders.is_empty());
            assert_eq!(base.cli_rate_limit_disabled, None);

            // Enable + set exclusions (unsorted input) + disable the rate limit.
            set_cli_enabled_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                true,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("enable must succeed");
            set_cli_excluded_folders_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                SetMutation::adding_all(alloc_vec(["Private/", "Archive/2025/"])),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("set exclusions must succeed");
            set_cli_rate_limit_disabled_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                true,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("disable rate limit must succeed");

            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after write");
            assert!(view.cli_enabled);
            // Canonical sort applies at encode → read-back is sorted.
            assert_eq!(
                view.cli_excluded_folders,
                alloc_vec(["Archive/2025/", "Private/"]),
            );
            assert_eq!(view.cli_rate_limit_disabled, Some(true));
            // Unrelated fields untouched (defaults on).
            assert!(view.screen_capture_protection);

            // Disable + clear → back to defaults (door closed, empty set); the
            // rate-limit toggle persists an explicit Some(false), not back to
            // None (the archive_disabled precedent).
            set_cli_enabled_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                false,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("disable must succeed");
            set_cli_excluded_folders_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                SetMutation {
                    add: Vec::new(),
                    add_unless_removed: Vec::new(),
                    remove: vec!["Private/".to_string(), "Archive/2025/".to_string()],
                    remove_prefix: Vec::new(),
                    rename_prefix: Vec::new(),
                },
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("clear must succeed");
            set_cli_rate_limit_disabled_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                false,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("re-enable rate limit must succeed");
            let cleared = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after clear");
            assert!(!cleared.cli_enabled);
            assert!(cleared.cli_excluded_folders.is_empty());
            assert_eq!(cleared.cli_rate_limit_disabled, Some(false));
        });
    }

    // ---- "Files" panel setters (MYND-462) -----------------------------

    #[test]
    fn new_note_location_specific_registers_deliberate_folder() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x44).await;

            // "specific" mode with a target folder: the pair round-trips AND the
            // folder is registered as a deliberate folder so it survives empty.
            set_new_note_location_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                Some("specific".to_string()),
                Some("Inbox/".to_string()),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write must succeed");

            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read must succeed after write");
            assert_eq!(view.new_note_location.as_deref(), Some("specific"));
            assert_eq!(view.new_note_location_folder.as_deref(), Some("Inbox/"));
            assert!(view.deliberate_folders.contains(&"Inbox/".to_string()));

            // Switching back to "root" clears the target (caller passes None).
            set_new_note_location_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                Some("root".to_string()),
                None,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("second write must succeed");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after second write");
            assert_eq!(view.new_note_location.as_deref(), Some("root"));
            assert_eq!(view.new_note_location_folder, None);
            // The deliberate folder persists (designating then un-designating a
            // folder does not delete it — the daily_folder discipline).
            assert!(view.deliberate_folders.contains(&"Inbox/".to_string()));
        });
    }

    #[test]
    fn startup_open_specific_round_trips_through_disk() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x45).await;

            set_startup_open_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                Some("specific".to_string()),
                Some("0192f1a0-0000-7000-8000-000000000000".to_string()),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write must succeed");

            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read must succeed after write");
            assert_eq!(view.startup_open.as_deref(), Some("specific"));
            assert_eq!(
                view.startup_open_note.as_deref(),
                Some("0192f1a0-0000-7000-8000-000000000000")
            );

            // "empty" mode clears the note pointer (caller passes None).
            set_startup_open_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                Some("empty".to_string()),
                None,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("second write must succeed");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after second write");
            assert_eq!(view.startup_open.as_deref(), Some("empty"));
            assert_eq!(view.startup_open_note, None);
        });
    }

    // ---- decoration maps: item_colors / folder_icons (MYND-184/185) --

    #[test]
    fn item_colors_round_trip_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

            let colors = std::collections::BTreeMap::from([
                (
                    String::from("0190a000-0000-7000-8000-000000000001"),
                    String::from("moss"),
                ),
                (String::from("Projects/Myne/"), String::from("slate")),
            ]);
            set_item_colors_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                colors.clone(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write must succeed");

            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after write");
            assert_eq!(view.item_colors, colors);
            // screen_capture_protection untouched (defaults on).
            assert!(view.screen_capture_protection);

            // Empty map round-trips (re-encodes byte-identical to a pre-feature blob).
            set_item_colors_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                std::collections::BTreeMap::new(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("clear must succeed");
            let cleared = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after clear");
            assert!(cleared.item_colors.is_empty());
        });
    }

    #[test]
    fn folder_icons_round_trip_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

            let icons = std::collections::BTreeMap::from([
                (String::from("Archive/2025/"), String::from("archive")),
                (String::from("Projects/Myne/"), String::from("book")),
            ]);
            set_folder_icons_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                icons.clone(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write must succeed");

            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after write");
            assert_eq!(view.folder_icons, icons);

            set_folder_icons_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                std::collections::BTreeMap::new(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("clear must succeed");
            let cleared = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after clear");
            assert!(cleared.folder_icons.is_empty());
        });
    }

    // ---- item_order / favorites setters (MYND-183) -------------------

    /// A single-root-container `item_order` map (`"" → [ids…]`) — the shape a
    /// test writes when it exercises just one container (MYND-596).
    fn root_order<const N: usize>(
        ids: [&str; N],
    ) -> std::collections::BTreeMap<String, Vec<String>> {
        std::collections::BTreeMap::from([(
            String::new(),
            ids.iter().map(|s| s.to_string()).collect(),
        )])
    }

    #[test]
    fn item_order_and_favorites_round_trip_preserving_sequence() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

            // item_order is a heterogeneous sequence (note UUIDs + folder paths)
            // — element order is the payload, so it round-trips VERBATIM (not
            // sorted, unlike deliberate_folders). A folder path is interleaved
            // between note UUIDs to exercise the heterogeneity.
            set_item_order_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                root_order(["n-zzz", "Zebra/", "n-aaa"]),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write item_order");
            set_favorites_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                alloc_vec(["n-zzz", "n-aaa"]),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write favorites");

            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after order writes");
            assert_eq!(view.item_order, root_order(["n-zzz", "Zebra/", "n-aaa"]));
            assert_eq!(view.favorites, alloc_vec(["n-zzz", "n-aaa"]));
            // The pre-existing screen_capture default is untouched.
            assert!(view.screen_capture_protection);

            // Clearing item_order round-trips back to empty; favorites is
            // an independent field and stays set.
            set_item_order_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                std::collections::BTreeMap::new(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("clear item_order");
            let cleared = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after clear");
            assert!(cleared.item_order.is_empty());
            assert_eq!(cleared.favorites, alloc_vec(["n-zzz", "n-aaa"]));
        });
    }

    fn alloc_vec(items: impl IntoIterator<Item = &'static str>) -> Vec<String> {
        items.into_iter().map(String::from).collect()
    }

    // ---- hidden_bar_items setter (bottom-bar customization) -----------

    #[test]
    fn hidden_bar_items_round_trips_as_canonicalized_set() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x44).await;

            // hidden_bar_items is a SET — the codec sorts + dedupes on encode,
            // so an out-of-order, duplicated input reads back canonicalized.
            set_hidden_bar_items_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                alloc_vec(["word-count", "graph", "graph"]),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write hidden_bar_items");

            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after hidden_bar_items write");
            assert_eq!(view.hidden_bar_items, alloc_vec(["graph", "word-count"]));
            assert!(view.screen_capture_protection);

            // Clearing round-trips back to empty (bar fully visible default).
            set_hidden_bar_items_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                Vec::new(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("clear hidden_bar_items");
            let cleared = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after clear");
            assert!(cleared.hidden_bar_items.is_empty());
        });
    }

    // ---- saved-view CRUD (MYND-273) -----------------------------------

    fn test_view(id: &str, name: &str) -> SavedView {
        use protocol::{FilterNode, ViewType};
        SavedView {
            id: String::from(id),
            name: String::from(name),
            view_type: ViewType::Cards,
            filters: FilterNode::InFolder {
                path: String::from("Books/"),
            },
            sort: None,
            group_by: None,
            columns: alloc_vec(["author"]),
            card_size: Some(300),
            image: Some(String::from("image")),
            image_aspect_ratio: Some(String::from("1.65")),
        }
    }

    #[test]
    fn upsert_saved_view_round_trips_and_edits_by_id() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x44).await;

            // Save v1 → read returns it.
            upsert_saved_view_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                test_view("v1", "Books"),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("save v1");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read");
            assert_eq!(view.saved_views.len(), 1);
            assert_eq!(view.saved_views[0].name, "Books");

            // Edit v1 (same id, new name) → still one view, updated (no duplicate).
            upsert_saved_view_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                test_view("v1", "Reading"),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("edit v1");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read");
            assert_eq!(view.saved_views.len(), 1);
            assert_eq!(view.saved_views[0].name, "Reading");

            // Save a second view → two distinct entries.
            upsert_saved_view_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                test_view("v2", "Films"),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("save v2");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read");
            assert_eq!(view.saved_views.len(), 2);
            // The pre-existing screen_capture default is untouched.
            assert!(view.screen_capture_protection);
        });
    }

    // The browser-clipper paired-extension persistence acceptance tests
    // (`paired_extensions_persist_and_read_round_trip_valid_and_revoked` +
    // `paired_extensions_persist_rejects_when_slot_empty`) exercise the core
    // `persist_paired_extensions_with_dir` path but build/validate the records
    // through the desktop-only `clipper::token::TokenRegistry`, so they live
    // desktop-side (`src-tauri/src/plugins/prefs/mod.rs` tests). The protocol
    // round-trip of the `paired_extensions` field is covered in `protocol`.

    #[test]
    fn upsert_over_cap_fails_and_leaves_prior_prefs_intact() {
        // Story 13: a save whose encoded prefs exceeds the 64 KiB §9.5.4 cap
        // fails PrefsEncodeFailed BEFORE the atomic write — the prior on-disk
        // view set is untouched.
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x45).await;
            upsert_saved_view_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                test_view("v1", "Small"),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("save small");

            // A view with a >64 KiB name blows the cap on encode.
            let mut huge = test_view("v2", "");
            huge.name = "x".repeat(70 * 1024);
            let result = upsert_saved_view_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                huge,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(PrefsWriteError::PrefsEncodeFailed)));

            // Prior prefs intact: still exactly the one small view.
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read");
            assert_eq!(view.saved_views.len(), 1);
            assert_eq!(view.saved_views[0].id, "v1");
        });
    }

    #[test]
    fn delete_and_set_view_order_reject_when_slot_empty() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-sv-del-empty").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            assert!(matches!(
                delete_saved_view_with_dir(
                    tmp.path(),
                    &state,
                    &noop_hooks(),
                    String::from("v1"),
                    &crate::vault_io::StdVaultIo,
                    &crate::host::NoopHost
                )
                .await,
                Err(PrefsWriteError::SlotNotUnlocked)
            ));
            assert!(matches!(
                set_view_order_with_dir(
                    tmp.path(),
                    &state,
                    &noop_hooks(),
                    alloc_vec(["v1"]),
                    &crate::vault_io::StdVaultIo,
                    &crate::host::NoopHost
                )
                .await,
                Err(PrefsWriteError::SlotNotUnlocked)
            ));
        });
    }

    #[test]
    fn delete_saved_view_removes_and_prunes_view_order() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x46).await;
            upsert_saved_view_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                test_view("v1", "A"),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("save v1");
            upsert_saved_view_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                test_view("v2", "B"),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("save v2");
            set_view_order_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                alloc_vec(["v2", "v1"]),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("order");

            // Delete v1 → gone from saved_views AND pruned from view_order.
            delete_saved_view_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                String::from("v1"),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("delete v1");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read");
            assert_eq!(view.saved_views.len(), 1);
            assert_eq!(view.saved_views[0].id, "v2");
            assert_eq!(view.view_order, alloc_vec(["v2"]));

            // Deleting an absent id is an idempotent no-op success.
            delete_saved_view_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                String::from("ghost"),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("delete absent is ok");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read");
            assert_eq!(view.saved_views.len(), 1);
        });
    }

    #[test]
    fn set_view_order_preserves_sequence_verbatim_no_gc() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x47).await;
            // A reorder over ids that don't (yet) exist is tolerated — no codec GC.
            set_view_order_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                alloc_vec(["v3", "v1", "v3"]),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("set order");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read");
            assert_eq!(view.view_order, alloc_vec(["v3", "v1", "v3"]));
        });
    }

    // ---- bar_items_order setter (bottom-bar reorder) ------------------

    #[test]
    fn set_bar_items_order_preserves_sequence_verbatim() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x49).await;
            // Sequence semantics — order is the payload, preserved verbatim
            // (NOT sorted/deduped, unlike the hidden_bar_items set).
            set_bar_items_order_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                alloc_vec(["word-count", "graph", "tags", "view-mode"]),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("set order");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read");
            assert_eq!(
                view.bar_items_order,
                alloc_vec(["word-count", "graph", "tags", "view-mode"])
            );

            // Clearing round-trips back to empty.
            set_bar_items_order_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                Vec::new(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("clear order");
            let cleared = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read");
            assert!(cleared.bar_items_order.is_empty());
        });
    }

    // ---- ribbon setters (myne-md/myne#699) ----------------------------

    #[test]
    fn set_ribbon_items_writes_some_so_emptied_stays_emptied() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x4a).await;
            // Sequence semantics: order is the payload, preserved verbatim.
            set_ribbon_items_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                alloc_vec(["note.new", "daily.open-today"]),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("set items");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read");
            assert_eq!(
                view.ribbon_items,
                Some(alloc_vec(["note.new", "daily.open-today"]))
            );

            // Emptying writes `Some([])`, NOT `None`: a deliberately emptied
            // rail must not decode back to "never configured" and re-seed.
            set_ribbon_items_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                Vec::new(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("clear items");
            let cleared = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read");
            assert_eq!(cleared.ribbon_items, Some(Vec::new()));
        });
    }

    #[test]
    fn set_ribbon_items_rejects_over_cap_count_and_length() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x4c).await;
            // 129 ids: one past MAX_RIBBON_ITEMS.
            let too_many: Vec<String> = (0..129).map(|i| format!("cmd.{i}")).collect();
            let result = set_ribbon_items_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                too_many,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(PrefsWriteError::InvalidValue)));
            // One id past MAX_RIBBON_ITEM_LEN.
            let too_long: Vec<String> = vec!["x".repeat(201)];
            let result = set_ribbon_items_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                too_long,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await;
            assert!(matches!(result, Err(PrefsWriteError::InvalidValue)));
            // Neither refusal wrote: the rail is still unconfigured.
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read");
            assert_eq!(view.ribbon_items, None);
        });
    }

    #[test]
    fn set_ribbon_visible_round_trips() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x4b).await;
            set_ribbon_visible_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                false,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("hide ribbon");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read");
            assert!(!view.ribbon_visible);
        });
    }

    // ---- color-groups setter (graph-connection-ux-polish) -------------

    fn test_color_group(id: &str, color: &str, enabled: bool) -> ColorGroup {
        ColorGroup {
            id: id.to_string(),
            name: id.to_string(),
            color: color.to_string(),
            enabled,
            filter: protocol::FilterNode::All,
        }
    }

    #[test]
    fn set_color_groups_preserves_order_verbatim_and_round_trips() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x4a).await;
            // Order is precedence here — no separate `*_order` field, so the
            // codec must preserve caller order VERBATIM (not id-sorted).
            let groups = vec![
                test_color_group("g2", "group-fern", true),
                test_color_group("g1", "group-olive", false),
            ];
            set_color_groups_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                groups.clone(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("set color groups");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read");
            assert_eq!(view.color_groups, groups);

            // Clearing round-trips back to empty (omit-when-empty on disk).
            set_color_groups_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                Vec::new(),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("clear color groups");
            let cleared = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read");
            assert!(cleared.color_groups.is_empty());
        });
    }

    #[test]
    fn color_groups_edit_stamps_its_lww_clock_and_opens_the_push_window() {
        // MYND-635: the two things that must be true on the AUTHORING device
        // before a color group can reach a second synced device at all. The
        // round-trip above proves neither — it passes `NoopHost` + `noop_hooks`,
        // which swallow both signals — and neither follows from the §10.2
        // classification row on its own.
        //
        //   1. the write stamps `field_clocks["color_groups"]`. The field is
        //      `Shared(WholeValueLww)`, so ordering IS the clock. Left
        //      unstamped it reads as 0 and ties with a peer's untouched empty
        //      list, at which point the equal-clock tiebreak (canonical-encoding
        //      bytes) decides whether the authored rules survive — i.e. luck.
        //   2. the write calls `bump_local_change` — the MYND-517 coalesced
        //      push window. Without it the blob sits on disk until some
        //      unrelated note push carries it along, which on a phone is
        //      effectively never.
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x4b).await;
            let (hooks, bumps) = counting_hooks();
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let bumped = || bumps.load(std::sync::atomic::Ordering::Relaxed);
            let groups = vec![test_color_group("g1", "group-olive", true)];

            set_color_groups_with_dir(
                tmp.path(),
                &state,
                &hooks,
                groups.clone(),
                &crate::vault_io::StdVaultIo,
                &host,
            )
            .await
            .expect("author color groups");

            let authored_clock = {
                let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                    .await
                    .expect("read");
                *view
                    .field_clocks
                    .get("color_groups")
                    .expect("color_groups stamped")
            };
            assert_eq!(authored_clock, host.now_unix_millis());
            assert!(authored_clock > 0, "epoch-ms clock must be non-zero");
            assert_eq!(bumped(), 1, "authoring opens the push window");

            // A no-op re-write of the IDENTICAL list must neither re-stamp nor
            // re-bump, even though the clock has advanced in between: the gate
            // is the shared-subset hash, not "a setter ran". A device that
            // re-stamped here would win every race by writing nothing.
            host.set_now(1_700_000_500);
            set_color_groups_with_dir(
                tmp.path(),
                &state,
                &hooks,
                groups.clone(),
                &crate::vault_io::StdVaultIo,
                &host,
            )
            .await
            .expect("no-op re-write");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read");
            assert_eq!(view.field_clocks.get("color_groups"), Some(&authored_clock));
            assert_eq!(bumped(), 1, "a no-op write must not bump");

            // Clearing must advance the clock and bump again — otherwise the
            // deletion loses to a stale peer still holding the rules and they
            // come back on the next merge.
            set_color_groups_with_dir(
                tmp.path(),
                &state,
                &hooks,
                Vec::new(),
                &crate::vault_io::StdVaultIo,
                &host,
            )
            .await
            .expect("clear color groups");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read");
            let cleared_clock = *view
                .field_clocks
                .get("color_groups")
                .expect("clearing stamps too");
            assert!(
                cleared_clock > authored_clock,
                "a delete must out-rank the write it deletes ({cleared_clock} vs {authored_clock})"
            );
            assert_eq!(bumped(), 2, "clearing opens the push window too");
        });
    }

    // ---- theme setter (MYND-110) --------------------------------------

    #[test]
    fn theme_round_trips_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

            // Explicit Dark persists (disk-first) + round-trips.
            set_theme_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                Some(ThemeChoice::Dark),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write theme");
            assert!(
                tmp.path().join("vault.prefs").exists(),
                "set_theme must create vault.prefs"
            );
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after theme write");
            assert_eq!(view.theme, Some(ThemeChoice::Dark));
            // The pre-existing screen_capture default is untouched.
            assert!(view.screen_capture_protection);

            // Switching to Light overwrites.
            set_theme_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                Some(ThemeChoice::Light),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write light");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after light");
            assert_eq!(view.theme, Some(ThemeChoice::Light));

            // System (None) clears the field back to "no explicit choice".
            set_theme_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                None,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write system");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after system");
            assert_eq!(view.theme, None);
        });
    }

    #[test]
    fn custom_theme_round_trips_and_coexists_with_theme() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

            // Select a custom theme (disk-first) + round-trip.
            set_custom_theme_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                Some(String::from("solarized-dark")),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write custom_theme");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after custom_theme write");
            assert_eq!(view.custom_theme.as_deref(), Some("solarized-dark"));

            // A built-in theme can be set alongside it; both persist (precedence
            // — custom_theme winning — is resolved client-side).
            set_theme_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                Some(ThemeChoice::Dark),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write theme");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after theme write");
            assert_eq!(view.custom_theme.as_deref(), Some("solarized-dark"));
            assert_eq!(view.theme, Some(ThemeChoice::Dark));

            // Clearing custom_theme (None) drops the field back to "no custom".
            set_custom_theme_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                None,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("clear custom_theme");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after clear");
            assert_eq!(view.custom_theme, None);
            assert_eq!(view.theme, Some(ThemeChoice::Dark));
        });
    }

    // ---- editor-typography setters ------------------------------------

    #[test]
    fn typography_presets_round_trip_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x44).await;

            set_typography_field_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                "editor_text_size",
                |p| {
                    p.editor_text_size = Some(String::from("lg"));
                },
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write text size");
            set_typography_field_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                "editor_font_family",
                |p| {
                    p.editor_font_family = Some(String::from("sans"));
                },
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write font family");
            assert!(tmp.path().join("vault.prefs").exists());

            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after typography write");
            assert_eq!(view.editor_text_size.as_deref(), Some("lg"));
            assert_eq!(view.editor_font_family.as_deref(), Some("sans"));
            // Pre-existing defaults untouched.
            assert!(view.screen_capture_protection);

            // None clears the field back to the default (omitted on disk).
            set_typography_field_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                "editor_text_size",
                |p| {
                    p.editor_text_size = None;
                },
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("clear text size");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after clear");
            assert_eq!(view.editor_text_size, None);
            assert_eq!(view.editor_font_family.as_deref(), Some("sans"));
        });
    }

    // ---- spell-check setters (MYND-267) -------------------------------

    #[test]
    fn spell_prefs_round_trip_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x44).await;

            // Enable persists (disk-first) + round-trips.
            set_spell_enabled_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                true,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write spell_enabled");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after enable");
            assert_eq!(view.spell_enabled, Some(true));
            // Pre-existing screen_capture default untouched.
            assert!(view.screen_capture_protection);

            // Languages set: codec NFC-sorts + dedupes (caller order/dupes
            // collapse to canonical form).
            set_spell_languages_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                SetMutation::adding_all(vec![
                    "tr".to_string(),
                    "en-US".to_string(),
                    "tr".to_string(),
                ]),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write spell_languages");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after languages");
            assert_eq!(
                view.spell_languages,
                vec!["en-US".to_string(), "tr".to_string()]
            );
            // spell_enabled still set (independent field).
            assert_eq!(view.spell_enabled, Some(true));

            // Disable overwrites.
            set_spell_enabled_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                false,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write disable");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after disable");
            assert_eq!(view.spell_enabled, Some(false));
        });
    }

    // ---- show_note_timestamps setter (sidebar-note-timestamps) --------

    #[test]
    fn show_note_timestamps_round_trips_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x45).await;

            // Default (no write yet) reads back as `true` (visible).
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read default");
            assert!(view.show_note_timestamps);

            // Turn OFF persists (disk-first) + round-trips.
            set_show_note_timestamps_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                false,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write off");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after off");
            assert!(!view.show_note_timestamps);
            // Pre-existing screen_capture default untouched.
            assert!(view.screen_capture_protection);

            // Turn back ON overwrites (re-encodes byte-identical to pre-feature).
            set_show_note_timestamps_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                true,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write on");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after on");
            assert!(view.show_note_timestamps);
        });
    }

    // ---- editor_line_numbers setter (editor-line-numbers, MYND-314) ---

    #[test]
    fn editor_line_numbers_round_trips_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x46).await;

            // Default (no write yet) reads back as `None` (host default-OFF).
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read default");
            assert_eq!(view.editor_line_numbers, None);

            // Turn ON persists (disk-first) + round-trips.
            set_editor_line_numbers_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                true,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write on");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after on");
            assert_eq!(view.editor_line_numbers, Some(true));
            // Pre-existing screen_capture default untouched.
            assert!(view.screen_capture_protection);

            // Turn OFF overwrites (explicit Some(false), not back to None).
            set_editor_line_numbers_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                false,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write off");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after off");
            assert_eq!(view.editor_line_numbers, Some(false));
        });
    }

    // ---- editor_vim_mode setter (vim-keyboard-mode, MYND-313) ---------

    #[test]
    fn editor_vim_mode_round_trips_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x4d).await;

            // Default (no write yet) reads back as `None` — the host applies the
            // default-OFF policy; modal editing is opt-in.
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read default");
            assert_eq!(view.editor_vim_mode, None);

            // Turn ON persists (disk-first) + round-trips.
            set_editor_vim_mode_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                true,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write on");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after on");
            assert_eq!(view.editor_vim_mode, Some(true));
            // Pre-existing screen_capture default untouched.
            assert!(view.screen_capture_protection);

            // Turn OFF overwrites (explicit Some(false), NOT back to None) — an
            // explicit off stays distinguishable from never-set on disk.
            set_editor_vim_mode_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                false,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write off");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after off");
            assert_eq!(view.editor_vim_mode, Some(false));
        });
    }

    #[test]
    fn editor_vim_mode_write_leaves_neighbouring_prefs_untouched() {
        // The vim toggle is a read-modify-write on a shared blob; a sibling
        // editor pref written first must survive the write intact.
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x4e).await;

            set_editor_line_numbers_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                true,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write line numbers");
            set_editor_vim_mode_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                true,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write vim mode");

            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after both");
            assert_eq!(view.editor_line_numbers, Some(true));
            assert_eq!(view.editor_vim_mode, Some(true));
        });
    }

    // ---- archive_disabled setter (archive-disable, MYND-…) ------------

    #[test]
    fn archive_disabled_round_trips_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x47).await;

            // Default (no write yet) reads back as `None` (host default-OFF —
            // archiving enabled).
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read default");
            assert_eq!(view.archive_disabled, None);

            // Turn ON persists (disk-first) + round-trips.
            set_archive_disabled_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                true,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write on");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after on");
            assert_eq!(view.archive_disabled, Some(true));
            // Pre-existing screen_capture default untouched.
            assert!(view.screen_capture_protection);

            // Turn OFF overwrites (explicit Some(false), not back to None).
            set_archive_disabled_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                false,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write off");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after off");
            assert_eq!(view.archive_disabled, Some(false));
        });
    }

    // ---- attachment_compression_enabled setter -------------------------

    #[test]
    fn attachment_compression_enabled_round_trips_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x53).await;

            // Default (no write yet) reads back as `true` — compression on.
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read default");
            assert!(view.attachment_compression_enabled);

            // Turn OFF persists (disk-first) + round-trips.
            set_attachment_compression_enabled_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                false,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write off");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after off");
            assert!(!view.attachment_compression_enabled);
            // Pre-existing screen_capture default untouched.
            assert!(view.screen_capture_protection);

            // Simulate a lock/unlock cycle: a fresh VaultRuntimeState reading
            // the same on-disk vault.prefs must still observe the persisted
            // value (the setter's disk write, not any in-memory cache, is
            // what the value survives on). Match `make_temp_vault_with_unlocked_state`'s
            // fixture key material (0x42, 0x99, 1) so the re-derived prefs_key
            // can decrypt the blob written above.
            let reunlocked_state = VaultRuntimeState::default();
            let unlocked = fixture_unlocked_with_keys(0x42, 0x99, 1);
            reunlocked_state
                .set_unlocked(test_vault_id(), unlocked)
                .await;
            let view =
                prefs_read_with_dir(tmp.path(), &reunlocked_state, &crate::vault_io::StdVaultIo)
                    .await
                    .expect("read after simulated re-unlock");
            assert!(!view.attachment_compression_enabled);

            // Turn back ON overwrites (explicit true again).
            set_attachment_compression_enabled_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                true,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write on");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after on");
            assert!(view.attachment_compression_enabled);
        });
    }

    // ---- batch editor setters (MYND-308 / MYND-299 / MYND-348) --------

    #[test]
    fn editor_focus_toggles_round_trip_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x47).await;

            // Default (no write yet) reads back as `None`.
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read default");
            assert_eq!(view.editor_focus_dim_inactive, None);
            assert_eq!(view.editor_focus_typewriter, None);

            // Enable both persists (disk-first) + round-trips.
            set_editor_focus_dim_inactive_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                true,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write dim on");
            set_editor_focus_typewriter_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                false,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write typewriter off");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after writes");
            assert_eq!(view.editor_focus_dim_inactive, Some(true));
            assert_eq!(view.editor_focus_typewriter, Some(false));
            // Pre-existing screen_capture default untouched.
            assert!(view.screen_capture_protection);
        });
    }

    #[test]
    fn active_workspace_and_default_view_mode_round_trip_via_set_then_read() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x48).await;

            // Set both string fields (via the shared typography core, the
            // command wrappers' read-modify-write helper).
            set_typography_field_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                "active_workspace",
                |p| {
                    p.active_workspace = Some(String::from("ws-7"));
                },
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write active_workspace");
            set_typography_field_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                "editor_default_view_mode",
                |p| {
                    p.editor_default_view_mode = Some(String::from("reading"));
                },
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write default view mode");

            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after writes");
            assert_eq!(view.active_workspace.as_deref(), Some("ws-7"));
            assert_eq!(view.editor_default_view_mode.as_deref(), Some("reading"));
            assert!(view.screen_capture_protection);

            // None clears active_workspace back to the default (omitted on disk).
            set_typography_field_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                "active_workspace",
                |p| {
                    p.active_workspace = None;
                },
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("clear active_workspace");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after clear");
            assert_eq!(view.active_workspace, None);
            assert_eq!(view.editor_default_view_mode.as_deref(), Some("reading"));
        });
    }

    // ---- set_keymap_binding setter (hotkeys epic, MYND-304) -----------

    #[test]
    fn keymap_binding_round_trips_three_states() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x4B).await;

            // Default (no write yet) reads back as an empty keymap.
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read default");
            assert!(view.keymap.is_empty());

            // Override: Some(non-empty) persists; codec NFC-sorts + dedupes the
            // chord set (caller order/dupes collapse to canonical form).
            set_keymap_binding_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                "app.command-palette".to_string(),
                Some(vec![
                    "Mod-p".to_string(),
                    "Mod-k".to_string(),
                    "Mod-p".to_string(),
                ]),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write override");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after override");
            assert_eq!(
                view.keymap.get("app.command-palette"),
                Some(&vec!["Mod-k".to_string(), "Mod-p".to_string()])
            );
            // Pre-existing screen_capture default untouched.
            assert!(view.screen_capture_protection);

            // Explicit-unbind: Some(empty) persists `[]` (distinct from absent).
            set_keymap_binding_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                "vault.lock".to_string(),
                Some(Vec::new()),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write unbind");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after unbind");
            assert_eq!(view.keymap.get("vault.lock"), Some(&Vec::<String>::new()));
            // The earlier override is independent + untouched.
            assert_eq!(
                view.keymap.get("app.command-palette"),
                Some(&vec!["Mod-k".to_string(), "Mod-p".to_string()])
            );

            // Remove: None drops the entry (revert to the code default).
            set_keymap_binding_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                "app.command-palette".to_string(),
                None,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write remove");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after remove");
            assert!(!view.keymap.contains_key("app.command-palette"));
            // The unbind entry survives the unrelated remove.
            assert_eq!(view.keymap.get("vault.lock"), Some(&Vec::<String>::new()));
        });
    }

    // ---- vault_set_label setter (MYND-205) ----------------------------

    /// The label round-trips through the encrypted `vault.prefs` (disk-first),
    /// AND the per-session RAM cache is refreshed so `vault_list` reflects the
    /// rename immediately. Clearing (`None`) round-trips back to no-label and
    /// removes the cache entry.
    #[test]
    fn vault_set_label_round_trips_and_updates_cache() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

            // Before any write, the cache holds no label for the active vault.
            assert_eq!(state.cached_label(test_vault_id()).await, None);

            // Set a label — persists on disk + caches in RAM.
            vault_set_label_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                Some(String::from("Work")),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
                &crate::vault_label::key::UnavailableKeychain,
            )
            .await
            .expect("write label");
            assert!(
                tmp.path().join("vault.prefs").exists(),
                "vault_set_label must create vault.prefs"
            );
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after label write");
            assert_eq!(view.label, Some(String::from("Work")));
            // The pre-existing screen_capture default is untouched.
            assert!(view.screen_capture_protection);
            // RAM cache reflects the label immediately (the switcher source).
            assert_eq!(
                state.cached_label(test_vault_id()).await,
                Some(String::from("Work"))
            );

            // Rename overwrites both disk + cache.
            vault_set_label_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                Some(String::from("Personal")),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
                &crate::vault_label::key::UnavailableKeychain,
            )
            .await
            .expect("rename label");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after rename");
            assert_eq!(view.label, Some(String::from("Personal")));
            assert_eq!(
                state.cached_label(test_vault_id()).await,
                Some(String::from("Personal"))
            );

            // Clearing (None) removes the label on disk AND evicts the cache.
            vault_set_label_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                None,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
                &crate::vault_label::key::UnavailableKeychain,
            )
            .await
            .expect("clear label");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after clear");
            assert_eq!(view.label, None);
            assert_eq!(state.cached_label(test_vault_id()).await, None);
        });
    }

    // ---- myne-md/myne#411: the rename writes THROUGH to `MYL1` ---------
    //
    // `vault.prefs` is sealed under a `root_key`-derived KEK, so the rename
    // above is invisible to the LOCKED picker until the vault is unlocked
    // again. These pin the second write that closes that gap, and its two
    // rules: the hide flag suppresses it, and clearing removes the file.
    //
    // A `TestHost` rather than `NoopHost` in this block, deliberately: the
    // write-through resolves the hide flag through `app_config_dir`, and
    // `NoopHost` resolves none, which is exactly what keeps the tests ABOVE
    // free of a sealed file they never asked for.

    #[test]
    fn a_rename_writes_through_to_the_sealed_label_store() {
        use crate::vault_label::fake_keychain::FakeKeychain;
        use crate::vault_label::store::{read_label, LabelRead};

        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let keychain = FakeKeychain::empty();

            vault_set_label_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                Some(String::from("Work")),
                &crate::vault_io::StdVaultIo,
                &host,
                &keychain,
            )
            .await
            .expect("rename");

            assert_eq!(
                read_label(
                    &crate::vault_io::StdVaultIo,
                    tmp.path(),
                    test_vault_id(),
                    &keychain
                )
                .await
                .expect("read the sealed name back"),
                LabelRead::Label(String::from("Work")),
                "a rename must reach the locked picker without waiting for the \
                 next unlock"
            );
        });
    }

    #[test]
    fn clearing_the_label_removes_the_sealed_file_rather_than_storing_an_empty_one() {
        use crate::vault_label::fake_keychain::FakeKeychain;
        use crate::vault_label::store::label_path;

        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let keychain = FakeKeychain::empty();

            vault_set_label_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                Some(String::from("Work")),
                &crate::vault_io::StdVaultIo,
                &host,
                &keychain,
            )
            .await
            .expect("rename");
            assert!(label_path(tmp.path()).exists(), "seeded");

            vault_set_label_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                None,
                &crate::vault_io::StdVaultIo,
                &host,
                &keychain,
            )
            .await
            .expect("clear");

            assert!(
                !label_path(tmp.path()).exists(),
                "the codec refuses a zero-length plaintext, so an empty name has \
                 to be a removal by construction"
            );
        });
    }

    #[test]
    fn a_rename_writes_no_name_while_names_are_hidden() {
        use crate::vault_label::fake_keychain::FakeKeychain;
        use crate::vault_label::hide_flag::{
            hide_flag_path_from_host, write_hide_vault_names, HideVaultNamesConfig,
        };
        use crate::vault_label::store::label_path;

        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            let host = crate::host::test_host::TestHost::new(tmp.path());
            let keychain = FakeKeychain::empty();

            let flag_path = hide_flag_path_from_host(&host, &crate::vault_io::StdVaultIo)
                .await
                .expect("flag path");
            write_hide_vault_names(
                &crate::vault_io::StdVaultIo,
                &flag_path,
                HideVaultNamesConfig { hidden: true },
            )
            .await
            .expect("turn the option on");

            vault_set_label_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                Some(String::from("Work")),
                &crate::vault_io::StdVaultIo,
                &host,
                &keychain,
            )
            .await
            .expect("the rename itself must still succeed");

            // The rename landed where it always did.
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read");
            assert_eq!(view.label, Some(String::from("Work")));

            // And nowhere else.
            assert!(!label_path(tmp.path()).exists());
            assert!(keychain.accounts().is_empty(), "no wrap key was minted");
        });
    }

    #[test]
    fn a_rename_on_a_keychainless_device_still_renames() {
        // The device-local name cache is a convenience for the picker. Failing
        // a rename because a Linux box has no secret-service daemon would trade
        // a real operation for a cosmetic one.
        use crate::vault_label::store::label_path;

        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            let host = crate::host::test_host::TestHost::new(tmp.path());

            vault_set_label_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                Some(String::from("Work")),
                &crate::vault_io::StdVaultIo,
                &host,
                &crate::vault_label::key::UnavailableKeychain,
            )
            .await
            .expect("rename");

            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read");
            assert_eq!(view.label, Some(String::from("Work")));
            assert!(
                !label_path(tmp.path()).exists(),
                "and in particular no plaintext fallback was written"
            );
        });
    }

    // ---- vault_set_icon setter (vault-icons) ---------------------------

    /// The icon round-trips through the encrypted `vault.prefs` (disk-first),
    /// AND the per-session RAM icon cache is refreshed so `vault_list` reflects
    /// the change immediately. Clearing (`None`) round-trips back to no-icon and
    /// evicts the cache entry — the switcher falls back to the neutral wordmark.
    #[test]
    fn vault_set_icon_round_trips_and_updates_cache() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

            // Before any write, the cache holds no icon for the active vault.
            assert_eq!(state.cached_icon(test_vault_id()).await, None);

            // Set an icon — persists on disk + caches in RAM.
            vault_set_icon_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                Some(String::from("book")),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("write icon");
            assert!(
                tmp.path().join("vault.prefs").exists(),
                "vault_set_icon must create vault.prefs"
            );
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after icon write");
            assert_eq!(view.icon, Some(String::from("book")));
            // The pre-existing screen_capture default is untouched.
            assert!(view.screen_capture_protection);
            // RAM cache reflects the icon immediately (the switcher source).
            assert_eq!(
                state.cached_icon(test_vault_id()).await,
                Some(String::from("book"))
            );

            // Changing the icon overwrites both disk + cache.
            vault_set_icon_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                Some(String::from("code")),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("change icon");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after change");
            assert_eq!(view.icon, Some(String::from("code")));
            assert_eq!(
                state.cached_icon(test_vault_id()).await,
                Some(String::from("code"))
            );

            // Clearing (None) removes the icon on disk AND evicts the cache.
            vault_set_icon_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                None,
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
            )
            .await
            .expect("clear icon");
            let view = prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo)
                .await
                .expect("read after clear");
            assert_eq!(view.icon, None);
            assert_eq!(state.cached_icon(test_vault_id()).await, None);
        });
    }

    /// DENY-list: the user-supplied label value must NEVER appear in any
    /// tracing payload (it is AS3-sensitive input). The emitted
    /// `prefs_written` event carries only the field name + `cleared` flag.
    #[test]
    #[tracing_test::traced_test]
    fn vault_set_label_does_not_log_the_label_value() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;
            let secret_label = "TopSecretProjectName";
            vault_set_label_with_dir(
                tmp.path(),
                &state,
                &noop_hooks(),
                Some(String::from(secret_label)),
                &crate::vault_io::StdVaultIo,
                &crate::host::NoopHost,
                &crate::vault_label::key::UnavailableKeychain,
            )
            .await
            .expect("write label");
            assert!(
                logs_contain("field=\"label\""),
                "expected the prefs_written event with field=label"
            );
            assert!(
                !logs_contain(secret_label),
                "the label value must NEVER cross the tracing boundary (DENY-list)"
            );
        });
    }

    // ---- vault.meta IO failure surfaces ------------------------------

    #[test]
    fn prefs_read_surfaces_io_error_when_vault_meta_missing() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-no-meta").expect("scoped tempdir");
            let state = VaultRuntimeState::default();
            // Don't seed vault.meta — just set slot to unlocked.
            state
                .set_unlocked(test_vault_id(), fixture_unlocked_with_keys(0x42, 0x99, 1))
                .await;
            let result =
                prefs_read_with_dir(tmp.path(), &state, &crate::vault_io::StdVaultIo).await;
            // vault.meta absent → Io error (NOT collapsed to defaults
            // like vault.prefs absent — vault.meta is structural).
            assert!(matches!(result, Err(PrefsReadError::Io { .. })));
        });
    }

    // ---- closed-enum helper -------------------------------------------

    #[test]
    fn prefs_blob_error_kind_maps_aead_fail_to_static_label() {
        assert_eq!(
            prefs_blob_error_kind(&PrefsBlobError::CannotDecrypt),
            "aead_fail"
        );
    }

    #[test]
    fn prefs_blob_error_kind_maps_magic_mismatch_to_static_label() {
        assert_eq!(
            prefs_blob_error_kind(&PrefsBlobError::MagicMismatch),
            "magic_mismatch"
        );
    }
}
