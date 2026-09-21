//! `vault_export_backup` — write a verified `.myne-backup` container
//! (MYND-32, spec §9.11; SYNC-3 member set, SYNC-4 "success = verified").
//!
//! Concurrency discipline (SYNC-6, both lock states):
//! 1. `try_acquire` the capacity-1 `auth_permits` lifecycle permit —
//!    reject-never-queue; held for the WHOLE export so no unlock /
//!    change-password / delete (or second export) can interleave.
//! 2. Take the writer-quiescence guard (slots WRITE lock) for **phase
//!    one** only: header + table + every small member's bytes. In-flight
//!    `hold_unlocked_*` writers drain first (fair queueing); new ones
//!    queue behind.
//! 3. Drop the guard; stream the immutable content-addressed MYA1 blobs
//!    into their reserved holes (**phase two** — a blob deleted meanwhile
//!    fails the export honestly).
//!
//! Pipeline: collect the §9.11.3 allowlist members from the vault dir →
//! phase one to `<destination>.tmp` → phase two → re-read THE DESTINATION
//! BYTES and verify every member hash (SYNC-4) → atomic same-directory
//! rename. A `.myne-backup` file exists at the destination only if it
//! verified; every failure path removes the temp.
//!
//! Logging: `// see: ../../AGENTS.md "Secret-handling logging discipline"` —
//! no paths, no vault ids, closed `IoFailureKind` only.

use crate::backup_container::{
    classify_member_path, read_and_verify_container_hooked, write_container_phase_one,
    ContainerHooks, MemberFamily, PhasedWriter,
};
use crate::io_failure_kind::IoFailureKind;
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use crate::vault_id::VaultId;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Runtime, State};

use super::error::{backup_export_error_kind, BackupExportError};

/// Per-family member counts for the post-export summary (the SYNC-3
/// manifest counts the UI renders; MYND-56).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ExportSummary {
    /// Total members written.
    pub members: u32,
    /// Total member bytes (container `members_total_len`).
    pub bytes: u64,
    /// `notes/*.myn` count.
    pub notes: u32,
    /// `snapshots/*.myn` count.
    pub snapshots: u32,
    /// `attachments/*` blob count.
    pub attachments: u32,
    /// Whether `vault.prefs` was present and included.
    pub prefs_included: bool,
}

/// Export the vault at `vault_id` — a REQUIRED target since #250 — as a
/// `.myne-backup` file at `destination`.
///
/// The id used to be optional, falling back to the active slot and then to a
/// sole-vault disk heuristic. That made the scheduled backup's target a guess:
/// `useBackupScheduler` resolved it from the non-authoritative registry cache,
/// and an explicit (wrong) id BEAT the runtime slot. Requiring it moves the
/// question to the one place that can answer it — the caller holding the
/// unlocked vault's id.
#[tauri::command]
pub async fn vault_export_backup<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    lifecycle_hooks: State<'_, myne_core::hooks::Hooks>,
    vault_id: String,
    destination: String,
) -> Result<ExportSummary, BackupExportError> {
    let target = Some(VaultId::parse(&vault_id).map_err(|_| BackupExportError::VaultNotFound)?);
    // Non-creating resolver (MYND-253): export reads an EXISTING vault; a
    // missing/forged target must fail the vault.meta probe below cleanly —
    // the old creating resolver materialized an empty legacy `vault/` here,
    // the trigger of the 2026-06-11 data-loss incident.
    let vault_dir = crate::paths::vault_root_for_id_optional(&app, target).map_err(|_| {
        BackupExportError::Io {
            io_error_kind: IoFailureKind::Other,
        }
    })?;
    let destination = PathBuf::from(destination);

    // Progress forwarder: counts-only payloads to the WebView (SYNC-7).
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(u32, u32, &'static str)>();
    let emitter = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::Emitter;
        while let Some((done, total, phase)) = rx.recv().await {
            let _ = emitter.emit(
                BACKUP_PROGRESS_EVENT,
                BackupProgressPayload { done, total, phase },
            );
        }
    });
    let runtime = backup_runtime(&app);
    let hooks = ContainerHooks {
        progress: Some(tx),
        cancelled: Some(runtime.cancel.clone()),
    };

    let result = export_backup_core(
        vault_dir,
        state.inner(),
        lifecycle_hooks.inner(),
        destination,
        hooks,
        &myne_core::host::tauri_host::TauriHost::new(app.clone()),
    )
    .await;

    match &result {
        Ok(summary) => {
            tracing::info!(
                event = "vault_backup_exported",
                members = summary.members,
                "vault backup exported and verified"
            );
        }
        Err(e) => {
            tracing::warn!(
                stage = "export_backup",
                error_kind = backup_export_error_kind(e),
                "vault backup export failed"
            );
        }
    }
    result
}

/// Async core of [`vault_export_backup`] — testable without an
/// `AppHandle`. Owns the SYNC-6 sequence: permit → quiesce(phase one) →
/// unguarded phase two + verify + rename.
pub(crate) async fn export_backup_core(
    vault_dir: PathBuf,
    state: &VaultRuntimeState,
    lifecycle_hooks: &myne_core::hooks::Hooks,
    destination: PathBuf,
    hooks: ContainerHooks,
    // Threaded in with MYND-574 task 14: the prefs write path takes the host for
    // its §10.2 LWW field clocks. A `NoopHost` here would compile and stamp
    // `last_backup_at` with clock 0 — which the sync merge would then treat as
    // the oldest possible write and always lose. Not a metric this time: a
    // wrong value in a merge is data loss that looks like a sync bug.
    host: &dyn myne_core::host::HostCtx,
) -> Result<ExportSummary, BackupExportError> {
    // (1) Lifecycle permit, both lock states, reject-never-queue. Bound to
    // `_permit` so it is held until this function returns.
    let _permit = state
        .auth_permits()
        .try_acquire()
        .map_err(|_| BackupExportError::AuthOperationInProgress)?;

    // Reset the cooperative cancel flag only AFTER the permit is ours: a
    // rejected second export never wipes a `backup_cancel` aimed at the
    // in-flight one. ("Never" holds for exports; a permitless-staging
    // RESTORE start can — see restore.rs's single-UI-surface rationale.)
    hooks.reset_cancel();

    // (2) Phase one under writer quiescence. The guard is held across the
    // spawn_blocking await (the notes-writer pattern); in-flight writers
    // drain first, new writers queue until the drop below.
    let quiesce = state.quiesce_writers().await;
    let phase_dir = vault_dir.clone();
    let phase_dest = destination.clone();
    let phase_hooks = hooks.clone();
    let writer = tokio::task::spawn_blocking(move || -> Result<PhasedWriter, BackupExportError> {
        export_phase_one(&phase_dir, &phase_dest, phase_hooks)
    })
    .await
    .map_err(|_| {
        // A panicked phase leaves only ciphertext residue, but the module
        // contract is "every failure path removes the temp".
        let _ = std::fs::remove_file(temp_sibling(&destination));
        BackupExportError::JoinFailure
    })??;
    drop(quiesce);

    // (3) Phase two + verify + rename, outside the lock window.
    let final_dest = destination.clone();
    let summary = tokio::task::spawn_blocking(move || export_finalize(writer, &final_dest, hooks))
        .await
        .map_err(|_| {
            let _ = std::fs::remove_file(temp_sibling(&destination));
            BackupExportError::JoinFailure
        })??;

    // Spec §9.5.2: an UNLOCKED export records `last_backup_at` (the 30-day
    // reminder's clock). A locked export cannot — prefs writes need
    // root_key — and that is the documented, accepted wrinkle. Best-effort:
    // a failed prefs write never demotes a verified export.
    let epoch_seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if epoch_seconds > 0 {
        if let Err(e) = crate::plugins::prefs::commands::record_last_backup_at_with_dir(
            &vault_dir,
            state,
            lifecycle_hooks,
            epoch_seconds,
            &myne_core::vault_io::StdVaultIo,
            host,
        )
        .await
        {
            // SlotNotUnlocked here = locked export (the documented
            // wrinkle); anything else is a best-effort write failure.
            let outcome: &'static str = match e {
                crate::plugins::prefs::error::PrefsWriteError::SlotNotUnlocked => "locked_export",
                _ => "write_failed",
            };
            tracing::debug!(
                stage = "record_last_backup_at",
                outcome,
                "last_backup_at not recorded"
            );
        }
    }
    Ok(summary)
}

/// Blocking phase one: validate, collect the allowlist member set, and
/// write header + table + small-member bytes to the temp sibling
/// (immutable attachment blobs deferred). MUST run under the caller-held
/// writer-quiescence guard.
pub(crate) fn export_phase_one(
    vault_dir: &Path,
    destination: &Path,
    hooks: ContainerHooks,
) -> Result<PhasedWriter, BackupExportError> {
    // A vault without vault.meta is not a vault (§9.11.3: REQUIRED member).
    if !vault_dir.join("vault.meta").is_file() {
        return Err(BackupExportError::VaultNotFound);
    }
    destination
        .parent()
        .filter(|p| !p.as_os_str().is_empty() && p.is_dir())
        .ok_or(BackupExportError::InvalidDestination)?;

    let members = collect_members(vault_dir)?;
    write_container_phase_one(&temp_sibling(destination), &members, hooks).map_err(Into::into)
}

/// Blocking phase two + SYNC-4 read-back + atomic rename. Runs OUTSIDE
/// the quiescence window.
pub(crate) fn export_finalize(
    writer: PhasedWriter,
    destination: &Path,
    hooks: ContainerHooks,
) -> Result<ExportSummary, BackupExportError> {
    let tmp = temp_sibling(destination);

    let written = writer.finish()?; // removes the partial file on error
    #[cfg(test)]
    test_seam::corrupt_tmp_if_armed(&tmp);
    // SYNC-4 read-back with per-member "verify" ticks + cooperative cancel
    // from the codec — a `backup_cancel` during the longest post-quiescence
    // pass aborts here (and removes the temp).
    match read_and_verify_container_hooked(&tmp, &hooks) {
        Ok(verified) if verified == written => {}
        Ok(_) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(BackupExportError::VerifyFailed);
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.into());
        }
    }
    // Atomic, durable rename via the single canonical helper (Windows:
    // MoveFileExW WRITE_THROUGH; Unix: rename + parent-dir sync_all).
    if let Err(e) = crate::atomic_write::finalize_atomic(&tmp, destination, true) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.into());
    }

    let mut summary = ExportSummary {
        members: written.len() as u32,
        bytes: written.iter().map(|r| r.len).sum(),
        notes: 0,
        snapshots: 0,
        attachments: 0,
        prefs_included: false,
    };
    for record in &written {
        match classify_member_path(&record.path) {
            Some(MemberFamily::Note) => summary.notes += 1,
            Some(MemberFamily::Snapshot) => summary.snapshots += 1,
            Some(MemberFamily::AttachmentBlob) => summary.attachments += 1,
            Some(MemberFamily::VaultPrefs) => summary.prefs_included = true,
            _ => {}
        }
    }
    Ok(summary)
}

/// `<destination>.tmp` sibling (same directory ⇒ same filesystem ⇒ atomic
/// rename), the `atomic_write` naming convention.
fn temp_sibling(destination: &Path) -> PathBuf {
    crate::atomic_write::tmp_path(destination)
}

/// Collect the §9.11.3 closed-allowlist member set from the vault
/// directory: the singletons when present (vault.meta REQUIRED —
/// checked by the caller), plus every `notes/`, `snapshots/`, and
/// `attachments/` entry whose name classifies. Anything else — `*.tmp`
/// residue, `vault.search`, stranger droppings — is skipped by
/// construction (positive match only, the SYNC-3 allowlist-not-walk rule).
fn collect_members(vault_dir: &Path) -> Result<Vec<(String, PathBuf, bool)>, BackupExportError> {
    let mut members: Vec<(String, PathBuf, bool)> = Vec::new();
    // The list is duplicated-by-necessity against `backup_container.rs`'s
    // classifier, which already allowlists every family below — including
    // `vault.themes`, which this collector did not name (#256). A member the
    // classifier accepts and the collector never offers is missing from EVERY
    // backup, silently: the container verifies, the restore succeeds, and the
    // custom themes are simply gone. Adding a §10.3 family owes an entry here.
    for singleton in [
        "vault.meta",
        "vault.prefs",
        "vault.dictionary",
        "vault.themes",
        "vault.attachments",
        "vault.chats",
        // #697: the memory plane rides the same closed allowlist (the #256
        // class: a family the classifier accepts but the collector never
        // offers is missing from every backup, silently).
        "vault.agent-memory",
        "vault.personality",
    ] {
        let path = vault_dir.join(singleton);
        if path.is_file() {
            members.push((singleton.to_string(), path, false));
        }
    }
    for dir in ["notes", "snapshots", "attachments", "chats", "memories"] {
        let dir_path = vault_dir.join(dir);
        if !dir_path.is_dir() {
            continue;
        }
        for entry in std::fs::read_dir(&dir_path)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let Ok(name) = entry.file_name().into_string() else {
                continue; // non-UTF-8 name can never classify
            };
            let member_path = format!("{dir}/{name}");
            if let Some(family) = classify_member_path(&member_path) {
                // Immutable content-addressed blobs stream OUTSIDE the
                // quiescence window (SYNC-6 bounded lock hold).
                let defer = family == MemberFamily::AttachmentBlob;
                members.push((member_path, entry.path(), defer));
            }
        }
    }
    Ok(members)
}

/// Default export filename (engine-owned rule so every surface agrees):
/// `Myne backup <YYYY-MM-DD HHMM>.myne-backup`. Takes the user's LOCAL
/// time components from the caller (the WebView has the local clock; Rust
/// std has no timezone database) — by construction the name carries the
/// product name + a local date and NEVER the vault label (encrypted-only,
/// SYNC-2/SYNC-7).
pub fn default_backup_filename(year: u16, month: u8, day: u8, hour: u8, minute: u8) -> String {
    format!("Myne backup {year:04}-{month:02}-{day:02} {hour:02}{minute:02}.myne-backup")
}

/// IPC wrapper for [`default_backup_filename`] — the UI passes its local
/// clock components and consumes the engine-owned naming rule verbatim
/// (one home; the save dialog's suggested filename).
#[tauri::command]
pub fn backup_default_filename(year: u16, month: u8, day: u8, hour: u8, minute: u8) -> String {
    default_backup_filename(year, month, day, hour, minute)
}

/// `backup://progress` — counts-only payload (DENY-list: no paths, no
/// vault ids). Mirrored on the TS side as `BackupProgress`.
pub(crate) const BACKUP_PROGRESS_EVENT: &str = "backup://progress";

/// Payload for [`BACKUP_PROGRESS_EVENT`].
#[derive(Debug, Clone, Copy, Serialize)]
pub struct BackupProgressPayload {
    /// Members completed in the current phase.
    pub done: u32,
    /// Total members in the current phase.
    pub total: u32,
    /// `"copy"` (small members, under quiescence) / `"blobs"` (immutable
    /// attachment blobs) / `"verify"` (SYNC-4 read-back).
    pub phase: &'static str,
}

/// Per-app backup runtime: the cooperative cancel flag the
/// `backup_cancel` command sets (SYNC-7 — cancel discards partial
/// output via the codec's cancel checks + cleanup paths).
#[derive(Default)]
pub struct BackupRuntime {
    pub(crate) cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

pub(crate) fn backup_runtime<R: Runtime>(app: &AppHandle<R>) -> tauri::State<'_, BackupRuntime> {
    use tauri::Manager;
    app.state::<BackupRuntime>()
}

/// "User always wins" bridge (MYND-351, Direction 2): preempt an in-flight
/// scheduled backup so a user-initiated auth op takes the shared auth permit.
/// Signals this app's `BackupRuntime` cancel flag and waits (bounded) for the
/// permit to free (`VaultRuntimeState::preempt_backup_for_user_auth`).
///
/// Called from the editor-originated auth ops that can race a live scheduled
/// backup — `change_password`, `vault_delete`, and the quick-unlock
/// setup/disable commands (Settings → Privacy).
///
/// `unlock` / `vault_recover` / `vault_creation` and the quick-unlock REDEEM
/// path deliberately do NOT call it: they run pre-editor, when no scheduled
/// backup is live (Model A), so there is nothing to preempt.
///
/// This roster is hand-maintained and nothing checks it. It is what tells the
/// next author that an omission was a decision — the quick-unlock paths joined
/// the `auth_permits` discipline in myne#378, and without the split above,
/// adding the permit to setup would have turned "Set PIN" during a scheduled
/// backup into a rejection.
pub(crate) async fn preempt_inflight_backup_for_user_auth<R: Runtime>(
    state: &VaultRuntimeState,
    app: &AppHandle<R>,
) {
    let backup_cancel = backup_runtime(app).cancel.clone();
    state.preempt_backup_for_user_auth(&backup_cancel).await;
}

/// Cancel the in-flight backup export, if any. Idempotent; the export
/// returns `Cancelled` at its next cooperative check and removes the
/// partial file (the opposite of the importer's keep-partial Cancel).
#[tauri::command]
pub fn backup_cancel<R: Runtime>(app: AppHandle<R>) {
    backup_runtime(&app)
        .cancel
        .store(true, std::sync::atomic::Ordering::Relaxed);
    tracing::info!(event = "vault_backup_cancel_requested");
}

#[cfg(test)]
pub(crate) mod test_seam {
    //! Fault-injection seam for the SYNC-4 invariant tests: corrupt the
    //! temp container between phase two and the read-back verify, proving
    //! "a `.myne-backup` exists ⇒ it verified" holds against a lying
    //! destination medium. Compiled out of non-test builds.
    use std::path::PathBuf;
    use std::sync::Mutex;

    /// Path-targeted arming (tests run in parallel; a global boolean
    /// would race across unrelated exports).
    pub(crate) static CORRUPT_TMP_BEFORE_VERIFY: Mutex<Option<PathBuf>> = Mutex::new(None);

    pub(crate) fn corrupt_tmp_if_armed(tmp: &std::path::Path) {
        let mut armed = CORRUPT_TMP_BEFORE_VERIFY.lock().expect("seam lock");
        if armed.as_deref() == Some(tmp) {
            *armed = None;
            if let Ok(mut bytes) = std::fs::read(tmp) {
                if let Some(last) = bytes.last_mut() {
                    *last ^= 0x01;
                }
                let _ = std::fs::write(tmp, bytes);
            }
        }
    }
}

// see: ../../AGENTS.md "Secret-handling logging discipline"

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScopedTempDir;
    use std::fs;

    const NOTE_A: &str = "0190a000-0000-7000-8000-00000000000a";
    const NOTE_B: &str = "0190a000-0000-7000-8000-00000000000b";
    const SNAP: &str = "0190a000-0000-7000-8000-0000000000f1";

    /// Build a locked-vault fixture directory: singletons + notes +
    /// snapshots + attachments, PLUS excluded residue (vault.search, a
    /// stray `.tmp`, a non-conforming filename).
    fn fixture_vault(dir: &ScopedTempDir) -> PathBuf {
        let root = dir.path().join("vault");
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::create_dir_all(root.join("snapshots")).unwrap();
        fs::create_dir_all(root.join("attachments")).unwrap();
        fs::write(root.join("vault.meta"), vec![0xAB; 345]).unwrap();
        fs::write(root.join("vault.prefs"), vec![0x01; 100]).unwrap();
        // #256: a member the classifier allowlists but the collector never
        // offered — so it was absent from every backup, silently.
        fs::write(root.join("vault.themes"), vec![0x03; 128]).unwrap();
        fs::write(root.join("vault.attachments"), vec![0x02; 64]).unwrap();
        // #675: same #256 class: the chats catalog and conversation files
        // are vault CONTENT (Class-1 sync members); a backup that omits them
        // restores a vault with the conversation history gone.
        fs::write(root.join("vault.chats"), vec![0x04; 96]).unwrap();
        fs::create_dir_all(root.join("chats")).unwrap();
        fs::write(root.join("chats/0123456789abcdef0123456789abcdef"), b"conv").unwrap();
        fs::write(root.join(format!("notes/{NOTE_A}.myn")), b"note-a").unwrap();
        fs::write(root.join(format!("notes/{NOTE_B}.myn")), vec![0xCD; 2048]).unwrap();
        fs::write(
            root.join(format!("snapshots/{NOTE_A}__{SNAP}.myn")),
            b"snap-bytes",
        )
        .unwrap();
        fs::write(
            root.join(format!("attachments/{}", "ab".repeat(32))),
            b"blob",
        )
        .unwrap();
        // Excluded residue: must never appear in the container.
        fs::write(root.join("vault.search"), b"rebuildable-cache").unwrap();
        fs::write(root.join("vault.meta.tmp"), b"atomic-write-residue").unwrap();
        fs::write(root.join("notes/not-a-uuid.txt"), b"stranger").unwrap();
        fs::write(root.join(format!("notes/{NOTE_A}.myn.tmp")), b"tmp-residue").unwrap();
        root
    }

    /// Lock-free synchronous wrapper (test seam): phase one + finalize
    /// without the permit/quiesce dance — the fixture vault has no live
    /// runtime state.
    fn export_backup_with_dir(
        vault_dir: &Path,
        destination: &Path,
    ) -> Result<ExportSummary, BackupExportError> {
        let writer = export_phase_one(vault_dir, destination, ContainerHooks::default())?;
        export_finalize(writer, destination, ContainerHooks::default())
    }

    #[test]
    fn locked_export_round_trips_and_excludes_residue() {
        let dir = ScopedTempDir::new("be-export").unwrap();
        let vault = fixture_vault(&dir);
        let dest = dir.path().join("Myne backup 2026-06-10 1200.myne-backup");

        let summary = export_backup_with_dir(&vault, &dest).expect("export");
        assert_eq!(summary.members, 10); // 5 singletons + 2 notes + 1 snapshot + 1 blob + 1 conversation
        assert_eq!(summary.notes, 2);
        assert_eq!(summary.snapshots, 1);
        assert_eq!(summary.attachments, 1);
        assert!(summary.prefs_included);

        // The destination verifies (SYNC-4: a file that exists has verified).
        let records = crate::backup_container::read_and_verify_container(&dest).expect("verify");
        assert_eq!(records.len(), 10);
        let paths: Vec<&str> = records.iter().map(|r| r.path.as_str()).collect();
        // #256: custom themes are vault CONTENT — encrypted, synced, and not
        // rebuildable from anything else. A verified backup that omits them
        // restores a vault the user's themes are gone from.
        assert!(
            paths.contains(&"vault.themes"),
            "a verified backup must carry the custom-theme store"
        );
        assert!(!paths.contains(&"vault.search"));
        assert!(paths.iter().all(|p| !p.ends_with(".tmp")));
        // #675: the chats catalog and its conversation files are vault
        // CONTENT (Class-1 sync members). A backup that omits them restores
        // a vault with the conversation history gone.
        assert!(
            paths.contains(&"vault.chats"),
            "a verified backup must carry the conversations catalog"
        );
        assert!(
            paths.contains(&"chats/0123456789abcdef0123456789abcdef"),
            "a verified backup must carry the conversation files"
        );
        // No temp sibling left behind.
        assert!(!temp_sibling(&dest).exists());
    }

    #[test]
    fn export_without_vault_meta_is_vault_not_found() {
        let dir = ScopedTempDir::new("be-nometa").unwrap();
        let empty = dir.path().join("empty-vault");
        fs::create_dir_all(&empty).unwrap();
        let dest = dir.path().join("out.myne-backup");
        assert!(matches!(
            export_backup_with_dir(&empty, &dest),
            Err(BackupExportError::VaultNotFound)
        ));
        assert!(!dest.exists());
    }

    #[test]
    fn export_to_missing_parent_is_invalid_destination() {
        let dir = ScopedTempDir::new("be-baddest").unwrap();
        let vault = fixture_vault(&dir);
        let dest = dir.path().join("no-such-dir").join("out.myne-backup");
        assert!(matches!(
            export_backup_with_dir(&vault, &dest),
            Err(BackupExportError::InvalidDestination)
        ));
    }

    #[test]
    fn failed_export_leaves_no_file_at_destination() {
        // An oversized vault.meta makes the container writer reject
        // mid-stream; neither the temp nor the destination may remain.
        let dir = ScopedTempDir::new("be-fail").unwrap();
        let vault = fixture_vault(&dir);
        let cap = myne_format::backup_container::family_member_cap(
            myne_format::backup_container::MemberFamily::VaultMeta,
        ) as usize;
        fs::write(vault.join("vault.meta"), vec![0xAB; cap + 1]).unwrap();
        let dest = dir.path().join("out.myne-backup");
        assert!(matches!(
            export_backup_with_dir(&vault, &dest),
            Err(BackupExportError::MemberTooLarge)
        ));
        assert!(!dest.exists());
        assert!(!temp_sibling(&dest).exists());
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    /// No-op lifecycle hooks for the `record_last_backup_at` seam (MYND-517:
    /// the prefs write path takes hooks; `last_backup_at` is device-local so
    /// the sync bump never fires here anyway).
    fn noop_lifecycle_hooks() -> myne_core::hooks::Hooks {
        std::sync::Arc::new(myne_core::hooks::NoopHooks)
    }

    #[test]
    fn export_rejects_while_auth_permit_is_held() {
        // SYNC-6 mutual exclusion, direction 1: a running unlock /
        // change-password / delete (permit holder) rejects export with the
        // honest reject-never-queue variant.
        rt().block_on(async {
            let dir = ScopedTempDir::new("be-permit").unwrap();
            let vault = fixture_vault(&dir);
            let dest = dir.path().join("out.myne-backup");
            let state = VaultRuntimeState::default();

            let held = state.auth_permits().try_acquire().expect("permit");
            assert!(matches!(
                export_backup_core(
                    vault.clone(),
                    &state,
                    &noop_lifecycle_hooks(),
                    dest.clone(),
                    ContainerHooks::default(),
                    &myne_core::host::NoopHost,
                )
                .await,
                Err(BackupExportError::AuthOperationInProgress)
            ));
            drop(held);

            // Permit released → export proceeds and returns it.
            export_backup_core(
                vault,
                &state,
                &noop_lifecycle_hooks(),
                dest,
                ContainerHooks::default(),
                &myne_core::host::NoopHost,
            )
            .await
            .expect("export");
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }

    #[test]
    fn export_queues_behind_inflight_writer_and_excludes_auth_ops_meanwhile() {
        // SYNC-6 quiescence + mutual exclusion, direction 2: an in-flight
        // writer (bound `hold_unlocked_*` guard) keeps the export's phase
        // one pending; the export already holds the lifecycle permit while
        // queued, so an unlock-style `try_acquire` fails until the export
        // completes.
        use crate::plugins::vault_unlock::state::{fixture_unlocked_with_keys, test_vault_id};
        rt().block_on(async {
            let dir = ScopedTempDir::new("be-quiesce").unwrap();
            let vault = fixture_vault(&dir);
            let dest = dir.path().join("out.myne-backup");
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(test_vault_id(), fixture_unlocked_with_keys(0x42, 0x99, 1))
                .await;

            // Simulated in-flight writer: a bound hold-guard (the exact
            // binding every prefs/attachments/search writer now holds
            // across its atomic_write).
            let writer_guard = state.hold_unlocked_root_key().await.expect("unlocked");

            let lifecycle_hooks = noop_lifecycle_hooks();
            let export = export_backup_core(
                vault,
                &state,
                &lifecycle_hooks,
                dest.clone(),
                ContainerHooks::default(),
                &myne_core::host::NoopHost,
            );
            tokio::pin!(export);
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(50), &mut export)
                    .await
                    .is_err(),
                "export phase one must queue behind the in-flight writer",
            );
            // While queued, the export already holds the lifecycle permit:
            // an unlock/change-password-style try_acquire is rejected.
            assert!(state.auth_permits().try_acquire().is_err());

            drop(writer_guard);
            let summary = tokio::time::timeout(std::time::Duration::from_secs(5), export)
                .await
                .expect("export completes once the writer drains")
                .expect("export ok");
            assert!(summary.members >= 1);
            assert!(dest.exists());
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }

    #[test]
    fn progress_events_are_counts_only_and_end_with_verify() {
        rt().block_on(async {
            let dir = ScopedTempDir::new("be-progress").unwrap();
            let vault = fixture_vault(&dir);
            let dest = dir.path().join("out.myne-backup");
            let state = VaultRuntimeState::default();
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            let hooks = ContainerHooks {
                progress: Some(tx),
                cancelled: None,
            };
            let summary = export_backup_core(
                vault,
                &state,
                &noop_lifecycle_hooks(),
                dest,
                hooks,
                &myne_core::host::NoopHost,
            )
            .await
            .expect("export");

            let mut events: Vec<(u32, u32, &'static str)> = Vec::new();
            while let Ok(ev) = rx.try_recv() {
                events.push(ev);
            }
            // Payloads are counts + phase only (type-enforced); the
            // sequence covers the copy phase, the deferred-blob phase, and
            // ends with the full-count verify tick.
            assert!(!events.is_empty());
            assert!(events.iter().any(|(_, _, p)| *p == "copy"));
            assert!(events.iter().any(|(_, _, p)| *p == "blobs"));
            assert_eq!(
                events.last().copied(),
                Some((summary.members, summary.members, "verify")),
            );
        });
    }

    #[test]
    fn cancelled_export_discards_partial_output() {
        rt().block_on(async {
            let dir = ScopedTempDir::new("be-cancel").unwrap();
            let vault = fixture_vault(&dir);
            let dest = dir.path().join("out.myne-backup");
            let state = VaultRuntimeState::default();
            // Cancel mid-flight via the first progress tick (a pre-set flag
            // is deliberately wiped by the post-permit reset, so stale
            // cancels never kill a fresh export).
            let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let (tx, mut prx) = tokio::sync::mpsc::unbounded_channel();
            let canceller = flag.clone();
            tokio::spawn(async move {
                if prx.recv().await.is_some() {
                    canceller.store(true, std::sync::atomic::Ordering::Relaxed);
                }
            });
            let hooks = ContainerHooks {
                progress: Some(tx),
                cancelled: Some(flag),
            };
            assert!(matches!(
                export_backup_core(
                    vault,
                    &state,
                    &noop_lifecycle_hooks(),
                    dest.clone(),
                    hooks,
                    &myne_core::host::NoopHost
                )
                .await,
                Err(BackupExportError::Cancelled)
            ));
            assert!(!dest.exists(), "cancel must discard partial output");
            assert!(!temp_sibling(&dest).exists());
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }

    #[test]
    fn corrupted_destination_medium_fails_verify_and_cleans_up() {
        // SYNC-4 invariant under a lying destination: the test seam flips a
        // byte between phase two and the read-back — the export must report
        // VerifyFailed and leave NOTHING at the destination.
        let dir = ScopedTempDir::new("be-verifyfail").unwrap();
        let vault = fixture_vault(&dir);
        let dest = dir.path().join("out.myne-backup");
        *test_seam::CORRUPT_TMP_BEFORE_VERIFY.lock().unwrap() = Some(temp_sibling(&dest));
        let result = export_backup_with_dir(&vault, &dest);
        *test_seam::CORRUPT_TMP_BEFORE_VERIFY.lock().unwrap() = None;
        assert!(matches!(result, Err(BackupExportError::VerifyFailed)));
        assert!(!dest.exists());
        assert!(!temp_sibling(&dest).exists());
    }

    #[cfg(unix)]
    #[test]
    fn permission_denied_destination_maps_to_closed_io_kind() {
        use std::os::unix::fs::PermissionsExt;
        let dir = ScopedTempDir::new("be-perm").unwrap();
        let vault = fixture_vault(&dir);
        let ro = dir.path().join("readonly");
        fs::create_dir_all(&ro).unwrap();
        fs::set_permissions(&ro, fs::Permissions::from_mode(0o555)).unwrap();
        let dest = ro.join("out.myne-backup");
        let result = export_backup_with_dir(&vault, &dest);
        fs::set_permissions(&ro, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(matches!(
            result,
            Err(BackupExportError::Io {
                io_error_kind: crate::io_failure_kind::IoFailureKind::PermissionDenied
            })
        ));
        assert!(!dest.exists());
    }

    #[test]
    fn default_filename_carries_product_and_local_stamp_only() {
        assert_eq!(
            default_backup_filename(2026, 6, 10, 9, 5),
            "Myne backup 2026-06-10 0905.myne-backup"
        );
    }
}
