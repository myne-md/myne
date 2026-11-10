// SPDX-License-Identifier: AGPL-3.0
//! `prefs` Tauri command handlers (MYND-160 Task 9).
//!
//! - [`prefs_read`] — Slot::Unlocked-gated read of the `vault.prefs`
//!   blob; fall-back-to-defaults on absent / AEAD-fail / parse-fail
//!   per `agent-tooling/docs/spec/protocol.md` § 9.5.5.
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
    update_prefs_with_dir_if(
        vault_dir,
        state,
        hooks,
        |_, _| true,
        |prefs| {
            mutate(prefs);
            MutationClock::Stamped(None)
        },
        io,
        host,
    )
    .await
}

/// What a mutation approved by [`update_prefs_with_dir_if`] does on its way to
/// the blob.
enum MutationClock {
    /// Write, and stamp every shared field the mutation changed at this clock.
    /// `None` means the host clock, which is the ordinary answer for a change a
    /// person made. One clock covers the WHOLE write, not one key: a mutation
    /// that changes two shared fields stamps both, which is why the only caller
    /// of the fixed-clock arm is a mutation that touches a single entry.
    Stamped(Option<u64>),
    /// Write, and stamp nothing, so §10.2 reads the value as an entry nobody has
    /// claimed. This is what an AUTOMATIC value owes a human one: with no clock
    /// the entry loses to every clocked write on every device, and it is already
    /// the canonical wire form, because the merge treats an absent clock as zero
    /// and drops a zero clock on the way through. Stamping a literal zero instead
    /// would write the same meaning in a non-canonical shape and leave the
    /// writer's `shared_subset_hash` disagreeing with every peer's.
    Unstamped,
    /// Do not write at all. The blob keeps its bytes, which means it keeps its
    /// nonce, which is the proof §10.2.1's push gate leans on.
    Refused,
}

/// [`update_prefs_with_dir`], with the last word on whether the write happens,
/// and on the clock it is stamped with.
///
/// `proceed` runs after the blob has been read and its [`PrefsOrigin`] is known,
/// which is the one moment a caller can refuse on a fact that is not in
/// `PrefsView`. "There is no `vault.prefs` on this device at all" is the case
/// this exists for (see [`self_name_device_with_dir`]). It runs under the same
/// write mutex as the mutation, so it cannot be raced by a second writer the way
/// a check taken before the call would be.
///
/// `mutate` runs under that mutex too, and says both things at once: whether the
/// write happens and what clock it carries (see [`MutationClock`]). A caller that
/// reports an outcome tracks it from inside `mutate` rather than from this return
/// value, which stays `Result<(), PrefsWriteError>` for the failures that are
/// failures.
async fn update_prefs_with_dir_if(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    proceed: impl FnOnce(&PrefsView, PrefsOrigin) -> bool,
    mutate: impl FnOnce(&mut PrefsView) -> MutationClock,
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
    if !proceed(&prefs, origin) {
        return Ok(());
    }
    let before = prefs.clone();
    let clock = match mutate(&mut prefs) {
        // A refusal that reached the mutation still writes nothing: encoding and
        // writing an unchanged `PrefsView` would re-encrypt under a fresh nonce,
        // and "an unchanged blob keeps its nonce" is what lets the sync phase skip
        // a decrypt it would otherwise have to do (§10.2.1).
        MutationClock::Refused => return Ok(()),
        MutationClock::Stamped(clock) => Some(clock),
        MutationClock::Unstamped => None,
    };

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
    if let Some(clock) = clock {
        let now_ms = clock.unwrap_or_else(|| host.now_unix_millis());
        crate::plugins::sync::prefs_merge::stamp_changed_shared_fields(&before, &mut prefs, now_ms);
    }

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
pub const KNOWN_AI_PROVIDERS: &[&str] =
    &["ollama-cloud", "openrouter", "opencode-zen", "opencode-go"];

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
            // …and its approval, or the map accumulates decisions about views
            // that no longer exist, and re-importing the same id later would
            // arrive pre-approved by an entry nobody can see in the list.
            // Deleting the view IS the revoke (the PRD's rule), and this is what
            // makes that true of the stored map rather than only of the UI.
            prefs.view_approvals.remove(&id);
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

/// Slot::Unlocked-gated setter for THIS DEVICE's approval of one saved view
/// (`view-manifests`; `agent-tooling/docs/spec/protocol.md` §9.5). Read-modify-write under the
/// per-plugin write mutex; **no native side-effect**. The field is device-local
/// per `sync-protocol.md` §10.2, so `update_prefs_with_dir` stamps no clock for it
/// and the merge keeps the local map. Pass `version: None` to clear an approval.
/// See [`set_view_approval_with_dir`] for the two calling shapes and for why the
/// id is authoritative over the definition's own.
pub async fn set_view_approval_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    approval: ViewApproval,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_view_approval_with_dir(&dir, state, hooks, approval, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_view_approval<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    view_id: String,
    version: Option<u32>,
    definition: Option<SavedView>,
) -> Result<(), PrefsWriteError> {
    set_view_approval_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        ViewApproval {
            view_id,
            version,
            definition,
        },
        &crate::vault_io::StdVaultIo,
    )
    .await
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

/// The settings the calendar map carries (myne-md/myne#1037). Unlike
/// [`PERIOD_SETTINGS`] one of them is namespaced by an entity: a colour belongs
/// to a `calendar:` name, so the key is `colours.<name>`.
const CALENDAR_ANCHOR_SETTING: &str = "day_reminder_anchor";
const CALENDAR_COLOUR_PREFIX: &str = "colours.";

/// Slot::Unlocked-gated setter for one `calendar_settings` entry
/// (myne-md/myne#1037). `Some(value)` sets it, `None` removes the key, which the
/// Phase 2 merge represents as a stamped absence rather than as "this device
/// never had it". Read-modify-write under the write mutex; disk-first;
/// non-load-bearing.
///
/// Host-side validation exists because the codec deliberately performs none, and
/// the three rules are each a key that nothing would ever read:
///
/// * the setting must be [`CALENDAR_ANCHOR_SETTING`] or carry the
///   [`CALENDAR_COLOUR_PREFIX`] namespace, so a typo cannot write an entry that
///   is dead on arrival;
/// * the anchor must be `HH:MM` in 24-hour wall clock, the same shape the client
///   writes, because a value the reader cannot parse is a preference that
///   silently does nothing;
/// * a calendar NAME must be one legal segment (non-empty, no `/`, no control
///   character, bounded) and a colour must be a token name (lowercase ASCII,
///   digits, `-`), because the token sheet is the client's and membership is
///   resolved there. A hex literal is therefore refused here rather than stored
///   and ignored: the calendar binds to design tokens, never to a literal.
///
/// The NAME is user text (a calendar label) and is never logged; see
/// src-tauri/AGENTS.md "Secret-handling logging discipline".
pub async fn set_calendar_setting_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    setting: String,
    value: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<(), PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_calendar_setting_with_dir(&dir, state, hooks, setting, value, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_calendar_setting<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    setting: String,
    value: Option<String>,
) -> Result<(), PrefsWriteError> {
    set_calendar_setting_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        setting,
        value,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Whether `HH:MM` is a real 24-hour wall clock time.
fn is_wall_clock_hm(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return false;
    }
    let digits_ok = bytes
        .iter()
        .enumerate()
        .all(|(i, b)| i == 2 || b.is_ascii_digit());
    if !digits_ok {
        return false;
    }
    let hours: u32 = value[0..2].parse().unwrap_or(99);
    let minutes: u32 = value[3..5].parse().unwrap_or(99);
    hours < 24 && minutes < 60
}

/// Whether `name` is one legal calendar segment: non-empty, no separator, no
/// control character, bounded like a folder segment.
fn is_legal_calendar_name(name: &str) -> bool {
    // One definition, in the calendar vocabulary that decides which values a READER
    // accepts. A second copy here decided which keys the setter WRITES, so a tightened
    // rule would land on one side of a write/read pair and the picker would store a
    // value the pane then refuses to render.
    crate::plugins::vault_indices::calendar::is_legal_calendar_name(name)
}

/// Whether `value` is a design-token NAME (`moss`, `slate-2`), never a colour
/// literal. Membership is the client's question; this is the shape, and it is the
/// client's own predicate character for character:
/// `TOKEN_KEY = /^[a-z0-9][a-z0-9-]*$/` in `src/notes/graphColorGroups.ts`, which
/// is also what the renderer uses to decide a stored value is usable. A mismatch
/// here would refuse a value the picker can produce, which reads as a broken
/// control rather than as a validation rule.
///
/// The one addition is a length bound. `var(--…)` is resolved from a token sheet
/// a person does not type, so 64 bytes cannot be reached from the picker; it
/// exists so a tampered blob cannot hand a renderer an unbounded property name.
fn is_token_name(value: &str) -> bool {
    if value.is_empty() || value.len() > 64 {
        return false;
    }
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Testable core of [`set_calendar_setting`].
pub(crate) async fn set_calendar_setting_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    setting: String,
    value: Option<String>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    let is_anchor = setting == CALENDAR_ANCHOR_SETTING;
    let colour_name = setting.strip_prefix(CALENDAR_COLOUR_PREFIX);
    if !is_anchor && colour_name.is_none() {
        return Err(PrefsWriteError::InvalidValue);
    }
    if is_anchor {
        if let Some(v) = value.as_deref() {
            if !is_wall_clock_hm(v) {
                return Err(PrefsWriteError::InvalidValue);
            }
        }
    }
    if let Some(name) = colour_name {
        if !is_legal_calendar_name(name) {
            return Err(PrefsWriteError::InvalidValue);
        }
        if let Some(v) = value.as_deref() {
            if !is_token_name(v) {
                return Err(PrefsWriteError::InvalidValue);
            }
        }
    }

    let cleared = value.is_none();
    // The logged entry is the setting's own kind, never the calendar name: a
    // calendar label is user text (AS3-class vault structure) and the name is
    // the only part of this key a person typed.
    let logged_kind = if is_anchor { "anchor" } else { "colour" };

    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| match value {
            Some(v) => {
                prefs.calendar_settings.insert(setting.clone(), v);
            }
            None => {
                prefs.calendar_settings.remove(&setting);
            }
        },
        io,
        host,
    )
    .await?;

    tracing::info!(
        event = "prefs_written",
        field = "calendar_settings",
        entry = logged_kind,
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
/// classification (`agent-tooling/docs/spec/sync-protocol.md` 10.2) meaning the local value
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
) -> Result<bool, PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_device_name_with_dir(&dir, state, hooks, device_id_hex, name, io, host).await
}

/// [`set_device_name_from_host`] for the UNATTENDED self-naming write
/// (myne-md/myne#973). Returns whether it wrote; see
/// [`self_name_device_with_dir`] for the three refusals that separate the two.
pub async fn self_name_device_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    device_id_hex: String,
    name: String,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<bool, PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    self_name_device_with_dir(&dir, state, hooks, device_id_hex, name, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_device_name<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    device_id_hex: String,
    name: String,
    self_name: Option<bool>,
) -> Result<bool, PrefsWriteError> {
    // ONE command for both write paths, because the two differ only in the
    // refusals `self_name_device_with_dir` adds: a second command would owe a row
    // in every registry a `plugin:prefs|<verb>` owes one (the web dispatcher, its
    // capability allowlist, the parity map, two build-script lists) to say what one
    // argument says.
    if self_name == Some(true) {
        self_name_device_from_host(
            &TauriHost::new(app),
            state.inner(),
            hooks.inner(),
            device_id_hex,
            name,
            &crate::vault_io::StdVaultIo,
        )
        .await
    } else {
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
}

/// The key and the value a device-name write is allowed to store, or `None` when
/// either is refused.
///
/// The key is permanent (§10.2 union merge has no deletion) and replicates to
/// every peer, so a malformed one is unrecoverable in-app: anything that is not a
/// 32-char lowercase-hex device_id is refused before the read-modify-write. An
/// empty or whitespace-only name is a cancel, not a write (both clients submit an
/// empty field as "cancel"; this is the fail-closed backstop).
fn validated_device_name(device_id_hex: String, name: String) -> Option<(String, String)> {
    if device_id_hex.len() != 32
        || !device_id_hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some((device_id_hex, trimmed.to_string()))
}

/// Whether the synced `device_names` map already answers for this device.
///
/// A whitespace-only stored value counts as absent, mirroring
/// `client-core/src/device-name.ts::hasDeviceName`: the two must agree, because the
/// client decides whether to ASK and this decides whether to WRITE.
fn has_stored_device_name(prefs: &PrefsView, device_id_hex: &str) -> bool {
    prefs
        .device_names
        .get(device_id_hex)
        .is_some_and(|stored| !stored.trim().is_empty())
}

/// Testable core of [`set_device_name`].
/// Returns whether it wrote. A refused value (a device id that is not 32-char
/// lowercase hex, a name that trims to empty) is `Ok(false)`, not `Ok(())`: both
/// clients document `set_device_name` as resolving to whether the name landed
/// (`src/lib/prefs.ts`, `mobile/src/lib/prefs.ts`), so a refusal has to be
/// distinguishable from a write on the same channel or the surface above it has
/// to guess.
pub(crate) async fn set_device_name_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    device_id_hex: String,
    name: String,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<bool, PrefsWriteError> {
    let Some((device_id_hex, value)) = validated_device_name(device_id_hex, name) else {
        return Ok(false);
    };

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
    Ok(true)
}

/// The write an approved device makes on its OWN behalf, once, when it has never
/// had a name (myne-md/myne#973). Returns whether it wrote.
///
/// The roster row renders an id-derived label until a name exists, and that label
/// is the same six characters the row's code line prints, so an unnamed device
/// either shows the code twice or loses the only thing that distinguishes it from
/// a sibling. Naming it is therefore worth doing automatically. Three refusals
/// separate this from [`set_device_name_with_dir`], and each one guards a loss the
/// user would not connect to the name:
///
/// 1. **A member session.** `device_names` belongs to the ACTIVE VAULT's
///    `vault.prefs`, while the roster a member session is looking at is that
///    person's own account (`AccountPlane::Person`). The id would label no row of
///    the vault's roster, and the name would replicate to every co-member of a
///    group-shared map that has no deletion: it is a per-key LWW map whose keys
///    survive everything (`core::plugins::sync::prefs_classification`, and
///    `decisions/sync/0348` clause 3 for the no-deletion half). The MANUAL setter
///    stays open to a member: a person typing a name is choosing to publish it,
///    and the row they are labelling is in front of them.
///
///    This is the one refusal taken BEFORE the write mutex, because the plane is
///    read through an `await` and `proceed` is synchronous. It is a check on an
///    authority that cannot change under this directory, which is why that is
///    sound rather than lucky: a lock empties the slot, and a different vault
///    cannot occupy the same directory before the write, since `update_prefs_with_dir_if`
///    compares the slot's vault id against the directory's own.
/// 2. **An absent `vault.prefs`.** The enrollment wholesale seed is keyed on that
///    file being ABSENT (§10.2.1), and it carries the account's DEVICE-LOCAL
///    fields (`custom_theme`, `auto_lock_seconds`, the `editor_*` family), which
///    the merge path can never adopt, because device-local fields are exactly the
///    ones it excludes. Creating the blob here would silently cost this device all
///    of them, and only on the devices that just joined, which is the worst place
///    for a one-off. The tail is why this gate is the seed's own signal rather
///    than a proxy for it: a freshly approved device adopts its vault head EARLY
///    in the first cycle (`orchestrator::sync_cycle_attempt` persists it before
///    downloading bodies) while the seed runs at the end of that same cycle, so
///    "has adopted a head" is true for minutes on a large account while "has
///    prefs" is still false.
/// 3. **An entry that is already there**, checked INSIDE the write mutex.
///
/// Refusal 3 is necessary and NOT sufficient, which is why this path also writes
/// no clock. `has_stored_device_name` reads this device's own `vault.prefs`,
/// and a peer's name reaches it only at the next merge: a device that has been
/// offline since somebody renamed it holds no entry, so the check passes and the
/// write would land with `now`, a clock LATER than the human write it never saw,
/// and `device_names` is a per-key LWW map, so the rename would be replaced on
/// every device with no history to recover it from. A process-local mutex cannot
/// close a race between two devices.
///
/// So the value carries NO clock (`MutationClock::Unstamped`), which §10.2 reads
/// as the weakest claim there is: any name a client ever writes beats it, on
/// every device, forever, and this path can then only ever fill an entry nobody
/// has claimed. Absent rather than a literal zero because the merge normalises a
/// zero clock away, so stamping one would leave this device's `shared_subset_hash`
/// disagreeing with every peer's and cost a redundant push round per device;
/// absent is the same meaning in the canonical shape.
///
/// The name it writes is the platform word the enrollment field is pre-filled
/// with, so losing that race costs nothing. **`set_device_name` does not bound the
/// value**, and a reader should not read one into this: any non-blank string is
/// accepted on both paths, exactly as a manual rename is. What holds this entry to
/// a platform word is the client that sends it.
///
/// Returns `Ok(false)` for every refusal. Nothing failed in those cases and the
/// caller has nothing to report: the row keeps its id-derived label, and the
/// rename affordance beside it still works.
pub(crate) async fn self_name_device_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    device_id_hex: String,
    name: String,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<bool, PrefsWriteError> {
    let Some((device_id_hex, value)) = validated_device_name(device_id_hex, name) else {
        return Ok(false);
    };

    if crate::plugins::sync::devices::account_plane_from_host(state).await
        != crate::plugins::sync::devices::AccountPlane::Vault
    {
        tracing::info!(
            event = "prefs_write_refused",
            field = "device_names",
            reason = "person_plane",
            "the roster speaks for a person account, so this name would label no row of the vault's roster"
        );
        return Ok(false);
    }

    let mut wrote = false;
    update_prefs_with_dir_if(
        vault_dir,
        state,
        hooks,
        |_, origin| origin != PrefsOrigin::Absent,
        |prefs| {
            if has_stored_device_name(prefs, &device_id_hex) {
                // Refuse rather than write the same value back: an unchanged
                // encode would still cost a fresh nonce, and with it the proof
                // the sync phase uses to skip this blob.
                return MutationClock::Refused;
            }
            prefs
                .device_names
                .insert(device_id_hex.clone(), value.clone());
            wrote = true;
            // No clock at all: see refusal 3 above. The ordinary stamp would let
            // this unattended write outrank a rename it never saw.
            MutationClock::Unstamped
        },
        io,
        host,
    )
    .await?;

    if wrote {
        // Field name only: the name is AS3-sensitive user input and the device id
        // is a correlation tag (see `set_device_name_with_dir`'s doc comment).
        tracing::info!(event = "prefs_written", field = "device_names");
    }
    Ok(wrote)
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
/// ux-polish, agent-tooling/docs/spec/protocol.md §9.5.2) — the ordered color-group rule list
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

/// One approval action, as the two call shapes need it: what to record, and
/// optionally the definition to write in the SAME prefs write.
///
/// A struct rather than three parameters because the core took eight arguments,
/// which clippy refuses and a reader should. It also names the pair that has to
/// travel together: `version` is the approval being recorded and `definition` is
/// the bytes it is expected to describe, so a local edit cannot land one without
/// the other.
pub struct ViewApproval {
    /// The view being approved, and the map key. Authoritative: a `definition`
    /// naming a different id is refused rather than approving bytes that were
    /// never shown.
    pub view_id: String,
    /// The definition version being approved. `None` CLEARS this device's
    /// approval of `view_id`.
    pub version: Option<u32>,
    /// The definition to upsert in the same write, for a LOCAL edit. `None` is the
    /// plain approval action the import path uses.
    pub definition: Option<SavedView>,
}

/// Testable core of [`set_view_approval`].
///
/// Records (or clears) THIS DEVICE's approval of one saved view, optionally in
/// the same prefs write as the definition it approves. Device-local per
/// `sync-protocol.md` §10.2; see `prefs_classification`'s row for why the merge
/// keeps the local map. The value is a VERSION rather than a flag, so
/// "approved" is an equality ([`protocol::is_view_approved`]) and a later
/// version bump revokes it with nothing to clear.
///
/// Two callers, one command:
///
/// - `definition: None` is the plain APPROVAL action the import path uses: a
///   pending view becomes approved, nothing else changes.
/// - `definition: Some(_)` is a LOCAL EDIT, which must never leave the user's own
///   view unapproved: the new definition and the approval of its version land in
///   one write, so there is no window in which the app has stored a version this
///   device has not approved. An IMPORTED update deliberately does not use this
///   arm (§9.5.2's ordered comparison clears approval instead, so new bytes are a
///   new decision).
///
/// `view_id` is the map key and is authoritative. A `definition` naming a
/// different id is refused with [`PrefsWriteError::InvalidValue`] rather than
/// approving one view while storing another, which would be an approval of bytes
/// that were never shown.
pub(crate) async fn set_view_approval_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    approval: ViewApproval,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<(), PrefsWriteError> {
    let ViewApproval {
        view_id,
        version,
        definition,
    } = approval;
    if let Some(ref def) = definition {
        if def.id != view_id {
            return Err(PrefsWriteError::InvalidValue);
        }
    }

    let mut count = 0usize;
    let approved = version.is_some();
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            if let Some(def) = definition.clone() {
                match prefs.saved_views.iter_mut().find(|v| v.id == def.id) {
                    Some(existing) => *existing = def,
                    None => prefs.saved_views.push(def),
                }
            }
            match version {
                Some(v) => {
                    prefs.view_approvals.insert(view_id.clone(), u64::from(v));
                }
                None => {
                    prefs.view_approvals.remove(&view_id);
                }
            }
            count = prefs.view_approvals.len();
        },
        io,
        host,
    )
    .await?;

    // COUNT and a boolean only, never the view id (AS3-Sensitive correlation
    // surface, the `delete_saved_view` discipline) and never the version.
    tracing::info!(
        event = "prefs_written",
        field = "view_approvals",
        approved,
        count
    );
    Ok(())
}

// ---- external MCP connection grants (external-mcp-connection task 3) -----
//
// Two writers over `PrefsView::mcp_connections`: approve (or re-approve) one
// named connection, and revoke one. Both are DEVICE-LOCAL per
// `sync-protocol.md` §10.2, so neither stamps a field clock and neither bumps
// the sync push window; both go through `update_prefs_with_dir`, which is the
// one read-modify-write path that bumps the prefs nonce.
//
// Three shapes here are decisions rather than conveniences:
//
// - **The approval stamp is the HOST's clock.** The caller names the folders to
//   LEAVE OUT; it does not get to say when the approval happened.
// - **The name is NFC-normalized on the way in.** The encoder NFC-normalizes map
//   keys, so a caller passing a decomposed name would store one key and fail to
//   find it on revoke, which is a silent failed revocation.
// - **The folders are canonicalized before they are stored**, by the one folder
//   key the resolver compares against, so a casing the user typed and a casing
//   the sidebar shows cannot disagree at call time.
// - **An addition is refused, not failed.** §9.5.4 requires an over-budget
//   addition to be declined rather than turning the whole write into an error,
//   because a full blob that refuses every write also refuses the removals that
//   would fix it. The return value says whether the grant was accepted, so the
//   Settings surface can say so; the write itself still succeeds.

/// The largest grant map this build will accept, measured on the whole canonical
/// plaintext. `PREFS_PLAINTEXT_BUDGET_BYTES` is the reference implementation's
/// §9.5.4 bound (the cap less 4 KiB), shared with the set fields so one blob has
/// one budget rather than one per feature.
fn mcp_grant_fits(prefs: &protocol::PrefsView) -> bool {
    protocol::canonical_plaintext_len(prefs) <= super::set_mutation::PREFS_PLAINTEXT_BUDGET_BYTES
}

/// The NFC form of a connection name, or `None` when the name is empty after
/// normalization. Empty is refused because a grant keyed by nothing is a grant
/// nothing can address and nothing can revoke by name.
fn normalize_connection_name(name: &str) -> Option<String> {
    use unicode_normalization::UnicodeNormalization;
    let normalized: String = name.nfc().collect();
    (!normalized.is_empty()).then_some(normalized)
}

/// Slot::Unlocked-gated approval (or re-approval) of one external MCP
/// connection. Returns `false` when the grant did not fit the prefs budget; the
/// existing grant is then left untouched rather than partially written.
///
/// `excluded_folders` is what the connection may NOT read. Re-approving a grant
/// written under the retired allow-list model rewrites it under this one, which
/// is the only path that turns a legacy grant back into a servable one.
///
/// `write_folders` is what it MAY write in: an allow list, always a subset of the
/// read scope, and empty means it may write nowhere. A folder named for writing
/// that the same approval leaves out of the read scope is refused
/// (`PrefsWriteError::InvalidValue`) rather than dropped, so the screen and the
/// stored bytes never disagree about the grant.
#[allow(clippy::too_many_arguments)]
pub async fn set_mcp_connection_grant_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    name: String,
    excluded_folders: Vec<String>,
    write_folders: Vec<String>,
    disabled_verbs: Vec<String>,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<bool, PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    set_mcp_connection_grant_with_dir(
        &dir,
        state,
        hooks,
        name,
        excluded_folders,
        write_folders,
        disabled_verbs,
        io,
        host,
    )
    .await
}

/// Accept and dismiss the queued out-of-scope writes (external-mcp-connection
/// task 13). Both are Slot::Unlocked-gated prefs writers for the reason every other
/// grant command is: the nonce may only be bumped from this module.
///
/// Accept returns whether the WRITE grant changed, which is `false` for a stale row
/// (its connection revoked, its folder since excluded) as well as for one that did
/// not fit the budget. The surface re-reads the view either way, so the row
/// disappearing is the honest signal rather than the boolean.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn accept_mcp_write_request<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    connection: String,
    folder: String,
) -> Result<bool, PrefsWriteError> {
    accept_mcp_write_request_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        connection,
        folder,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn dismiss_mcp_write_request<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    connection: String,
    folder: String,
    // `write` or `read`: one folder can be waiting for both kinds at once, and a
    // dismiss that guessed would clear a decision the person had not answered.
    kind: protocol::McpRequestKind,
) -> Result<bool, PrefsWriteError> {
    dismiss_mcp_write_request_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        connection,
        folder,
        kind,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Re-root every folder path an MCP grant holds after a folder rename. See
/// [`rewrite_mcp_folder_paths_with_dir`] for why a rename of an excluded folder is
/// a fail-OPEN event for a deny list.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn rewrite_mcp_folder_paths<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    from: String,
    to: String,
) -> Result<usize, PrefsWriteError> {
    rewrite_mcp_folder_paths_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        from,
        to,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn set_mcp_connection_grant<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    name: String,
    excluded_folders: Vec<String>,
    write_folders: Vec<String>,
    disabled_verbs: Vec<String>,
) -> Result<bool, PrefsWriteError> {
    set_mcp_connection_grant_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        name,
        excluded_folders,
        write_folders,
        disabled_verbs,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`set_mcp_connection_grant`].
#[allow(clippy::too_many_arguments)]
pub(crate) async fn set_mcp_connection_grant_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    name: String,
    excluded_folders: Vec<String>,
    write_folders: Vec<String>,
    disabled_verbs: Vec<String>,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<bool, PrefsWriteError> {
    let Some(name) = normalize_connection_name(&name) else {
        return Err(PrefsWriteError::InvalidValue);
    };
    let approved_at = host.now_unix_secs();
    // A SET, canonicalized and sorted: the same tick made twice writes the same
    // bytes, and the resolver's comparison runs against exactly this form.
    let excluded_set: std::collections::BTreeSet<String> = excluded_folders
        .iter()
        .map(|folder| crate::folder_key::canonical_input_folder(folder))
        .collect();
    let write_set: std::collections::BTreeSet<String> = write_folders
        .iter()
        .map(|folder| crate::folder_key::canonical_input_folder(folder))
        .collect();
    // **The write scope is a SUBSET of the read scope, enforced HERE as well as at
    // call time.** A folder the connection may write but not read is a place it
    // could put notes it can never find again, and refusing it at approval tells
    // the person; refusing it only at use tells a client. Refused rather than
    // silently dropped, because a dropped entry would leave the screen showing a
    // write grant the stored bytes do not carry (`core/AGENTS.md` on a sink that
    // resolves on a refused write).
    //
    // The read scope being compared against is the EFFECTIVE one, which is this
    // grant's exclusions UNION the folders the user already left out of Myne's own
    // AI and of the terminal client (`protocol.md` §9.5.2 makes the union
    // normative). Comparing against this grant's list alone accepted a write folder
    // the spec forbids; the call-time check still refused it, so nothing was ever
    // exposed, but a stored grant carrying what the format forbids is the kind of
    // divergence the next reader builds on. The union is used HERE and not stored:
    // folding another surface's exclusions into this grant's bytes would make them
    // survive the user un-excluding them there.
    let quiet_union: std::collections::BTreeSet<String> =
        match prefs_read_with_dir(vault_dir, state, io).await {
            Ok(view) => crate::plugins::mcp::scope::quiet_folders(&view)
                .iter()
                .map(|folder| crate::folder_key::canonical_input_folder(folder))
                .collect(),
            // A vault whose prefs cannot be read is not a state to widen a grant in.
            Err(_) => return Err(PrefsWriteError::InvalidValue),
        };
    let effective_excluded: std::collections::BTreeSet<String> =
        excluded_set.union(&quiet_union).cloned().collect();
    if write_set
        .iter()
        .any(|folder| crate::folder_key::exclusions_cover(&effective_excluded, folder))
    {
        return Err(PrefsWriteError::InvalidValue);
    }
    let folder_count = excluded_set.len();
    let write_folder_count = write_set.len();
    // The verb set, canonicalized the same way: a verb is a wire name this build
    // owns, so the canonical form is trimmed, sorted and deduped. An empty set is
    // stored as empty and omitted from the bytes, which the resolver reads as
    // "every verb is on" (mcp external access rework, myne-md/myne#1052).
    let disabled_set: std::collections::BTreeSet<String> = disabled_verbs
        .iter()
        .map(|verb| verb.trim().to_string())
        .filter(|verb| !verb.is_empty())
        .collect();
    let disabled_verb_count = disabled_set.len();
    let disabled_verbs: Vec<String> = disabled_set.into_iter().collect();
    let excluded_folders: Vec<String> = excluded_set.into_iter().collect();
    let write_folders: Vec<String> = write_set.into_iter().collect();
    let mut accepted = false;

    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            // Measure the WHOLE blob with the grant in place rather than adding a
            // per-field share: five set fields already share one cap, and a
            // sixth content-scaled consumer cannot be granted its own slice.
            let mut candidate = prefs.clone();
            let last_used_at = candidate
                .mcp_connections
                .get(&name)
                .and_then(|existing| existing.last_used_at);
            candidate.mcp_connections.insert(
                name.clone(),
                protocol::McpConnectionGrant {
                    // Always this model: the approval screen selects what to leave
                    // out, and there is no other model to write.
                    model: protocol::McpScopeModel::Exclude,
                    // The allow list stays empty. Writing both arrays would make
                    // the stored grant describe two rules at once, which the
                    // decoder refuses on the next read.
                    folders: Vec::new(),
                    excluded_folders,
                    approved_at,
                    // Re-approval keeps the last-use stamp: the approval changed,
                    // the usage history did not.
                    last_used_at,
                    // The write allow list, already canonical and sorted above and
                    // already checked against the exclusions. Empty is stored as
                    // empty and omitted from the bytes, which the resolver reads as
                    // "may write nowhere".
                    write_folders,
                    // The verbs the person switched off, canonical and sorted above.
                    // Empty is stored as empty and omitted from the bytes: the
                    // resolver reads that as every verb available, which is the
                    // reading every grant written before this member existed has to
                    // keep.
                    disabled_verbs,
                },
            );
            if mcp_grant_fits(&candidate) {
                // A re-approval can widen the WRITE scope past a folder that was
                // waiting for a decision, and a request for a folder the grant now
                // covers is a decision already made. Dropping it is what keeps the
                // card from asking about something the person just granted.
                let granted: std::collections::BTreeSet<String> = candidate
                    .mcp_connections
                    .get(&name)
                    .map(|grant| grant.write_folders.iter().cloned().collect())
                    .unwrap_or_default();
                candidate.mcp_write_requests.retain(|request| {
                    request.connection != name || !granted.contains(&request.folder)
                });
                *prefs = candidate;
                accepted = true;
            }
        },
        io,
        host,
    )
    .await?;
    // COUNT only: a connection name is user text (AS3-class) and a folder path is
    // a vault path, so neither reaches the log.
    tracing::info!(
        event = "prefs_written",
        field = "mcp_connections",
        accepted,
        excluded_folders = folder_count,
        write_folders = write_folder_count,
        disabled_verbs = disabled_verb_count
    );
    Ok(accepted)
}

/// Slot::Unlocked-gated recording of one out-of-scope write (external-mcp-connection
/// task 13; `decisions/ai/0752`).
///
/// Called by the tool layer when a write names a folder the connection may READ
/// but not WRITE. Nothing is applied: the request waits for a person, and
/// accepting it extends the grant by exactly that folder.
///
/// Returns whether the row is NOW in the queue. `false` covers two outcomes that
/// the caller must treat the same way, by answering the client with the plain
/// out-of-scope refusal rather than `write_queued_for_review`: the queue was full
/// of OTHER connections' rows, or the plaintext budget would not take it. A retry
/// of a row that is already stored returns `true`, because the row IS there and the
/// person will be shown it. A row that is not stored is a decision nobody will be
/// shown, so claiming it waits for review is the lie this return value exists to
/// prevent.
///
/// `summary` is client-authored USER TEXT (AS3-class). It reaches the blob and
/// never a log line: a note title in a diagnostic log is a title leaving the
/// envelope.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn enqueue_mcp_write_request_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    connection: String,
    folder: String,
    verb: String,
    summary: String,
    kind: protocol::McpRequestKind,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<bool, PrefsWriteError> {
    let Some(connection) = normalize_connection_name(&connection) else {
        return Err(PrefsWriteError::InvalidValue);
    };
    let requested_at = host.now_unix_secs();
    let mut grew = false;
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            let mut candidate = prefs.clone();
            let queued = crate::plugins::mcp::queue::enqueue(
                &mut candidate.mcp_write_requests,
                protocol::McpWriteRequest {
                    kind,
                    connection: connection.clone(),
                    folder,
                    requested_at,
                    summary,
                    verb,
                },
            );
            grew = queued && mcp_grant_fits(&candidate);
            if mcp_grant_fits(&candidate) {
                *prefs = candidate;
            } else {
                // Out of budget: the queue keeps what it had. Dropping the row is
                // the right failure, because a request the person cannot see is
                // worth no bytes, and `false` is what makes the caller answer with
                // the plain refusal rather than a queue the row is not in.
                grew = false;
            }
        },
        io,
        host,
    )
    .await?;
    // COUNT and a bool only: the folder, the verb and the summary are all user
    // content, and a note title in a diagnostic log is a title leaving the
    // envelope.
    tracing::info!(event = "prefs_written", field = "mcp_write_requests", grew);
    Ok(grew)
}

/// Slot::Unlocked-gated ACCEPT of one queued write request: extend that
/// connection's write grant by exactly the folder it named, and drop the row.
///
/// Returns whether the grant changed. `false` covers every case where nothing was
/// widened: no grant under that name (the row outlived a revocation), a legacy
/// grant (re-approval is the only thing that rewrites it), or a folder that is no
/// longer inside the read scope (the person excluded it after the request landed).
/// In all three the row is dropped as well, because a request that can never be
/// accepted is a row the card would keep offering.
pub(crate) async fn accept_mcp_write_request_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    connection: String,
    folder: String,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<bool, PrefsWriteError> {
    let Some(connection) = normalize_connection_name(&connection) else {
        return Err(PrefsWriteError::InvalidValue);
    };
    let mut accepted = false;
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            let mut candidate = prefs.clone();
            let Some(request) = crate::plugins::mcp::queue::take(
                &mut candidate.mcp_write_requests,
                &connection,
                &folder,
                protocol::McpRequestKind::Write,
            ) else {
                // Nothing queued for that pair: a stale click. Keeping the row is
                // not an option because there is none, so this is a no-op.
                return;
            };
            let grant = candidate.mcp_connections.get(&connection);
            // The read scope as it is NOW, resolved through the same resolver the
            // tools clamp with: accept widens the write grant, and the write grant
            // may never exceed the read scope.
            let readable = grant.map(|_| {
                crate::plugins::mcp::scope::resolve_scope_with_quiet(
                    &connection,
                    &candidate.mcp_connections,
                    &crate::plugins::mcp::scope::quiet_folders(&candidate),
                )
            });
            let scope_ok = readable
                .as_ref()
                .map(|scope| scope.covers_folder(&request.folder))
                .unwrap_or(false);
            let target =
                crate::plugins::mcp::queue::accept_target(grant, &request.folder, |_| scope_ok);
            if target.is_err() || !scope_ok {
                // Dropped, not kept: see the doc comment.
                accepted = false;
                if mcp_grant_fits(&candidate) {
                    *prefs = candidate;
                }
                return;
            }
            if let Some(grant) = candidate.mcp_connections.get_mut(&connection) {
                if !grant.write_folders.contains(&request.folder) {
                    grant.write_folders.push(request.folder.clone());
                    grant.write_folders.sort();
                    accepted = true;
                }
            }
            if mcp_grant_fits(&candidate) {
                *prefs = candidate;
            } else {
                accepted = false;
            }
        },
        io,
        host,
    )
    .await?;
    tracing::info!(
        event = "prefs_written",
        field = "mcp_connections",
        accepted,
        write_scope_extended = accepted
    );
    Ok(accepted)
}

/// Slot::Unlocked-gated ACCEPT of one queued READ request: the folder stops being
/// left out of that connection's read scope, and nothing else changes
/// (mcp external access rework, myne-md/myne#1052).
///
/// The mirror of [`accept_mcp_write_request`], and deliberately a separate command
/// rather than a mode of that one: the two move the grant in opposite directions,
/// so a caller that passed the wrong kind would widen where it meant to narrow.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn accept_mcp_read_request<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    connection: String,
    folder: String,
) -> Result<bool, PrefsWriteError> {
    accept_mcp_read_request_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        connection,
        folder,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

pub async fn accept_mcp_read_request_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    connection: String,
    folder: String,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<bool, PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    accept_mcp_read_request_with_dir(&dir, state, hooks, connection, folder, io, host).await
}

pub(crate) async fn accept_mcp_read_request_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    connection: String,
    folder: String,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<bool, PrefsWriteError> {
    let Some(connection) = normalize_connection_name(&connection) else {
        return Err(PrefsWriteError::InvalidValue);
    };
    let mut accepted = false;
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            let mut candidate = prefs.clone();
            let Some(request) = crate::plugins::mcp::queue::take(
                &mut candidate.mcp_write_requests,
                &connection,
                &folder,
                protocol::McpRequestKind::Read,
            ) else {
                // Nothing queued for that pair: a stale click, and keeping a row
                // that does not exist is not an option.
                return;
            };
            let quiet = crate::plugins::mcp::scope::quiet_folders(&candidate);
            let target = crate::plugins::mcp::queue::accept_read_target(
                candidate.mcp_connections.get(&connection),
                &request.folder,
                &quiet,
            );
            let next_exclusions = match target {
                Ok(next) => next,
                Err(_) => {
                    // Dropped rather than kept: the row cannot be acted on, and a
                    // card that keeps offering it would ask the same unanswerable
                    // question after every reload.
                    if mcp_grant_fits(&candidate) {
                        *prefs = candidate;
                    }
                    return;
                }
            };
            if let Some(grant) = candidate.mcp_connections.get_mut(&connection) {
                grant.excluded_folders = next_exclusions;
                accepted = true;
            }
            if mcp_grant_fits(&candidate) {
                *prefs = candidate;
            } else {
                accepted = false;
            }
        },
        io,
        host,
    )
    .await?;
    // COUNT only: neither a connection name nor a folder path reaches the log.
    tracing::info!(
        event = "prefs_written",
        field = "mcp_connections",
        accepted,
        read_scope_extended = accepted
    );
    Ok(accepted)
}

/// Slot::Unlocked-gated DISMISS of one queued write request: drop the row and
/// change nothing else. The client is not told; its next attempt queues again.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn dismiss_mcp_write_request_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    connection: String,
    folder: String,
    kind: protocol::McpRequestKind,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<bool, PrefsWriteError> {
    let Some(connection) = normalize_connection_name(&connection) else {
        return Err(PrefsWriteError::InvalidValue);
    };
    let mut removed = false;
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            let mut candidate = prefs.clone();
            removed = crate::plugins::mcp::queue::take(
                &mut candidate.mcp_write_requests,
                &connection,
                &folder,
                kind,
            )
            .is_some();
            if removed {
                *prefs = candidate;
            }
        },
        io,
        host,
    )
    .await?;
    Ok(removed)
}

/// Slot::Unlocked-gated REWRITE of every folder path an external MCP grant holds,
/// after a folder was renamed (external-mcp-connection; the D3 finding of the
/// 2026-10-30 review).
///
/// The read scope is a DENY list, which makes a rename fail OPEN: an excluded
/// folder renamed to a new key stops matching, and the notes under it become
/// readable by an approved client with no prompt and no act by the person who
/// excluded them. The write scope and the queue have the same property, so all
/// three are re-rooted here, in one atomic write.
///
/// This is NOT an approval: `approved_at` and the grant's `model` are untouched,
/// and no folder is added or removed. Returns how many entries moved, so the
/// caller can skip a write (and a nonce bump) when the rename touched nothing.
pub(crate) async fn rewrite_mcp_folder_paths_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    from: String,
    to: String,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<usize, PrefsWriteError> {
    let from = crate::folder_key::canonical_input_folder(&from);
    let to = crate::folder_key::canonical_input_folder(&to);
    if from == to {
        return Ok(0);
    }
    let mut moved = 0usize;
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            let mut candidate = prefs.clone();
            let mut moved_here = 0usize;
            for grant in candidate.mcp_connections.values_mut() {
                for folder in grant
                    .excluded_folders
                    .iter_mut()
                    .chain(grant.write_folders.iter_mut())
                {
                    let rerooted = crate::folder_key::reroot(folder, &from, &to);
                    if rerooted != *folder {
                        *folder = rerooted;
                        moved_here += 1;
                    }
                }
                // The writer stores these sorted; a rename can break that, and a
                // byte-identical re-encode is what the format promises.
                grant.excluded_folders.sort();
                grant.excluded_folders.dedup();
                grant.write_folders.sort();
                grant.write_folders.dedup();
            }
            for request in candidate.mcp_write_requests.iter_mut() {
                let rerooted = crate::folder_key::reroot(&request.folder, &from, &to);
                if rerooted != request.folder {
                    request.folder = rerooted;
                    moved_here += 1;
                }
            }
            moved = moved_here;
            if moved_here > 0 && mcp_grant_fits(&candidate) {
                *prefs = candidate;
            } else {
                moved = 0;
            }
        },
        io,
        host,
    )
    .await?;
    // COUNT only: a folder path is a vault path and never reaches the log.
    tracing::info!(
        event = "prefs_written",
        field = "mcp_connections",
        rewritten = moved
    );
    Ok(moved)
}

/// The host-facing wrappers below mirror the grant commands one screen up: the
/// same three-layer split (`_with_dir` core, `_from_host`, Tauri command), because
/// these are prefs writers and the nonce may only be bumped from this module.
#[allow(clippy::too_many_arguments)]
pub async fn enqueue_mcp_write_request_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    connection: String,
    folder: String,
    verb: String,
    summary: String,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<bool, PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    enqueue_mcp_write_request_with_dir(
        &dir,
        state,
        hooks,
        connection,
        folder,
        verb,
        summary,
        protocol::McpRequestKind::Write,
        io,
        host,
    )
    .await
}

/// Queue a READ request: the client named a folder this connection may not read
/// (mcp external access rework, myne-md/myne#1052).
///
/// A separate entry point rather than a flag on the write one, because the summary
/// argument has no meaning here: a read request carries no client-authored text,
/// and a read card that displayed one would be showing a string nobody wrote for it.
pub async fn enqueue_mcp_read_request_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    connection: String,
    folder: String,
    verb: String,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<bool, PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    enqueue_mcp_write_request_with_dir(
        &dir,
        state,
        hooks,
        connection,
        folder,
        verb,
        String::new(),
        protocol::McpRequestKind::Read,
        io,
        host,
    )
    .await
}

pub async fn rewrite_mcp_folder_paths_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    from: String,
    to: String,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<usize, PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    rewrite_mcp_folder_paths_with_dir(&dir, state, hooks, from, to, io, host).await
}

pub async fn accept_mcp_write_request_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    connection: String,
    folder: String,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<bool, PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    accept_mcp_write_request_with_dir(&dir, state, hooks, connection, folder, io, host).await
}

pub async fn dismiss_mcp_write_request_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    connection: String,
    folder: String,
    kind: protocol::McpRequestKind,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<bool, PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    dismiss_mcp_write_request_with_dir(&dir, state, hooks, connection, folder, kind, io, host).await
}

/// Slot::Unlocked-gated revocation of one external MCP connection. Revoking a
/// name that holds no grant is a successful no-op: the user's intent ("this name
/// may not call") is already true, and a second confirmation dialog for a list
/// row that has gone stale is worse than the no-op.
pub async fn revoke_mcp_connection_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    name: String,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<bool, PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    revoke_mcp_connection_with_dir(&dir, state, hooks, name, io, host).await
}

#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn revoke_mcp_connection<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    name: String,
) -> Result<bool, PrefsWriteError> {
    revoke_mcp_connection_from_host(
        &TauriHost::new(app),
        state.inner(),
        hooks.inner(),
        name,
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Testable core of [`revoke_mcp_connection`]. Returns whether a grant was
/// actually removed.
pub(crate) async fn revoke_mcp_connection_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    name: String,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<bool, PrefsWriteError> {
    let Some(name) = normalize_connection_name(&name) else {
        return Err(PrefsWriteError::InvalidValue);
    };
    let mut removed = false;
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            removed = prefs.mcp_connections.remove(&name).is_some();
            // Revoking drops that connection's queued requests with it. A row whose
            // grant is gone cannot be accepted (there is nothing to widen), and a
            // card that kept offering one would be asking about a connection the
            // person just closed.
            prefs
                .mcp_write_requests
                .retain(|request| request.connection != name);
        },
        io,
        host,
    )
    .await?;
    tracing::info!(event = "prefs_written", field = "mcp_connections", removed);
    Ok(removed)
}

/// How stale a connection's `last_used_at` must be before a call refreshes it.
///
/// **A call does not cost a write.** `vault.prefs` is an encrypted blob and every
/// write re-encodes it and bumps the nonce, so stamping on every `tools/call`
/// would turn an agent's search loop into hundreds of vault writes. The CLI door
/// refuses the same trade for the same reason (`cli_bridge/activity.rs` keeps its
/// stamp in RAM). Five minutes is the width that keeps the Settings row honest to
/// the minute for a connection in use, at one write per connection per window
/// rather than one per call.
pub const MCP_LAST_USED_WRITE_INTERVAL_SECS: u64 = 300;

/// Whether a call at `now` should refresh a stamp of `previous`.
///
/// Pure, so the throttle is testable without a clock: `None` (never used) always
/// writes, and a stamp in the FUTURE (a clock that moved backwards) always
/// writes, because a row reporting "last used in 3 hours" is worse than a write.
fn last_use_needs_stamp(previous: Option<u64>, now: u64) -> bool {
    match previous {
        None => true,
        Some(previous) => now < previous || now - previous >= MCP_LAST_USED_WRITE_INTERVAL_SECS,
    }
}

/// Record that `name` reached the door, at most once per
/// [`MCP_LAST_USED_WRITE_INTERVAL_SECS`].
///
/// Returns whether a write happened. **Every failure is `Ok(false)`**, and that
/// is deliberate rather than sloppy: this runs AFTER a tool call has already been
/// answered, so a failure here costs one stale Settings row and must never turn a
/// successful read into an error the agent reports to the user. The `event` line
/// says which failure it was, without naming the connection.
///
/// A name with no grant is not an error either: revocation and this stamp race by
/// design (a revoked connection's next call is refused, and a refusal still
/// counts as reaching the door), and re-creating a grant in order to stamp it
/// would be a write nobody asked for.
pub async fn touch_mcp_connection_last_used_from_host(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    name: String,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<bool, PrefsWriteError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(PrefsWriteError::from)?;
    touch_mcp_connection_last_used_with_dir(&dir, state, hooks, name, io, host).await
}

/// Testable core of [`touch_mcp_connection_last_used_from_host`].
pub(crate) async fn touch_mcp_connection_last_used_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    name: String,
    io: &dyn crate::vault_io::VaultIo,
    host: &dyn HostCtx,
) -> Result<bool, PrefsWriteError> {
    let Some(name) = normalize_connection_name(&name) else {
        return Ok(false);
    };
    // The decision costs a READ, on every call, and that is the cheap half: the
    // prefs blob is already in the page cache and the door reads it anyway to
    // resolve the grant. The write is the part that is throttled.
    let prefs = match prefs_read_with_dir(vault_dir, state, io).await {
        Ok(prefs) => prefs,
        Err(_) => return Ok(false),
    };
    let Some(grant) = prefs.mcp_connections.get(&name) else {
        return Ok(false);
    };
    let now = host.now_unix_secs();
    if !last_use_needs_stamp(grant.last_used_at, now) {
        return Ok(false);
    }
    let mut wrote = false;
    update_prefs_with_dir(
        vault_dir,
        state,
        hooks,
        |prefs| {
            if let Some(grant) = prefs.mcp_connections.get_mut(&name) {
                grant.last_used_at = Some(now);
                wrote = true;
            }
        },
        io,
        host,
    )
    .await?;
    if wrote {
        // No connection name in the line: it is user text (AS3 class), and the
        // one fact a reader of the log needs is that the stamp moved.
        tracing::debug!(event = "mcp_last_use_stamped");
    }
    Ok(wrote)
}

#[cfg(test)]
#[path = "commands_tests.rs"]
mod tests;
