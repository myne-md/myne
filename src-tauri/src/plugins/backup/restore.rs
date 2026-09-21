//! `vault_restore_backup` — recreate a vault from a `.myne-backup` file
//! (MYND-218, spec §9.11; SYNC-5 placement mechanics, SYNC-6 permit split).
//!
//! Pipeline:
//! 1. **Validate, credential-free** (§9.11.6 stages 1–5): container
//!    structure + every member hash (`"verify"` ticks), `vault.meta`
//!    membership (REQUIRED), then the §9.3 structural parse of the embedded
//!    `vault.meta` — restore must never reproduce the `InvalidVaultMeta`
//!    state it exists to repair. A `MYB5` container is refused with the
//!    explicit migration-prompt variant (§10.4).
//! 2. **Stage, outside the permit**: sweep stale staging dirs, then stream
//!    every member into a fresh `vaults/.restore-staging-*` directory
//!    (`"restore"` ticks). The name never parses as a `VaultId`, so
//!    discovery/boot/picker cannot see a half-staged vault.
//! 3. **Commit, inside the permit**: `try_acquire` the capacity-1
//!    `auth_permits` lifecycle mutex (reject-never-queue), mint a fresh
//!    `VaultId` (the archive deliberately carries none), one same-filesystem
//!    rename into `vaults/<id>/`, best-effort parent-dir durability.
//!    The registry self-reconciles from disk-scan; the restored vault
//!    starts locked and unlocks with password OR phrase (both wraps travel
//!    inside the copied `vault.meta`).
//!
//! Failure at ANY point leaves prior state byte-identical: validation
//! touches nothing; staging failures remove the staged dir; a crashed
//! commit leaves only an invisible staging dir for the sweep.
//!
//! Logging: see `src-tauri/AGENTS.md` "Secret-handling logging discipline".

use crate::backup_container::{
    extract_all_members, extract_member, read_and_verify_container_hooked,
    read_and_verify_members_tolerant, ContainerHooks, MemberRecord,
};
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use serde::Deserialize;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Runtime, State};

use super::commands::backup_runtime;
use super::error::{backup_restore_error_kind, BackupRestoreError};

/// Prefix of the discovery-invisible staging directories under `vaults/`
/// (never parses as a `VaultId`; leading dot keeps it out of casual `ls`).
const STAGING_PREFIX: &str = ".restore-staging-";

/// Caller-declared intent when the backup's vault identity already exists
/// on this device (SYNC-5 policy, ratified grill #3 Q1). The ENGINE treats
/// both values identically — restore-into-new either way; `ReplaceExisting`
/// is the UI's signal that it will chain the existing typed-confirm
/// `vault_delete` on the matched vault AFTER this restore succeeds (the
/// engine never deletes; replace-cleanup keeps the typed-confirm gate).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CollisionIntent {
    /// Side-by-side: both vaults remain (twin picker entries — UI copy
    /// owns the explanation).
    KeepBoth,
    /// The UI will delete the matched vault after a successful restore.
    ReplaceExisting,
}

/// Optional restore behaviors (absent ⇒ strict defaults).
#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub struct RestoreOptions {
    /// Required when the backup collides with an existing vault; absent +
    /// collision ⇒ `VaultAlreadyExists` so the UI can ask the user.
    #[serde(default)]
    pub on_collision: Option<CollisionIntent>,
    /// Explicit salvage opt-in (SYNC-5d): restore intact members of a
    /// damaged container, reporting the skipped set. NEVER the default.
    #[serde(default)]
    pub salvage: bool,
}

/// Result of a successful restore.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RestoreOutcome {
    /// The freshly-minted `VaultId` (canonical hyphenated string) the
    /// vault now lives under — the picker shows it on the next probe.
    pub vault_id: String,
    /// Members restored.
    pub members: u32,
    /// Total member bytes restored.
    pub bytes: u64,
    /// `notes/*.myn` count (SYNC-3 summary surface).
    pub notes: u32,
    /// `snapshots/*.myn` count.
    pub snapshots: u32,
    /// `attachments/*` blob count.
    pub attachments: u32,
    /// Existing vault with the same `account_number_hash`, when one was
    /// detected and the caller chose to proceed — the UI's replace step
    /// targets this id.
    pub collided_vault_id: Option<String>,
    /// Salvage mode only: damaged members that were skipped (exact paths).
    /// Non-empty ⇒ the UI MUST present the result as a partial restore.
    pub skipped: Vec<String>,
}

/// Restore a vault from the `.myne-backup` at `source`.
#[tauri::command]
pub async fn vault_restore_backup<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    source: String,
    options: Option<RestoreOptions>,
) -> Result<RestoreOutcome, BackupRestoreError> {
    let base = crate::paths::app_data_dir(&app).map_err(|_| BackupRestoreError::Io {
        io_error_kind: crate::io_failure_kind::IoFailureKind::Other,
    })?;

    // Progress forwarder — same counts-only event as export (SYNC-7).
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(u32, u32, &'static str)>();
    let emitter = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::Emitter;
        while let Some((done, total, phase)) = rx.recv().await {
            let _ = emitter.emit(
                super::commands::BACKUP_PROGRESS_EVENT,
                super::commands::BackupProgressPayload { done, total, phase },
            );
        }
    });
    let runtime = backup_runtime(&app);
    let hooks = ContainerHooks {
        progress: Some(tx),
        cancelled: Some(runtime.cancel.clone()),
    };

    let result = restore_backup_core(
        base,
        state.inner(),
        PathBuf::from(source),
        options.unwrap_or_default(),
        hooks,
    )
    .await;
    match &result {
        Ok(outcome) => {
            tracing::info!(
                event = "vault_backup_restored",
                members = outcome.members,
                "vault restored from backup"
            );
        }
        Err(e) => {
            tracing::warn!(
                stage = "restore_backup",
                error_kind = backup_restore_error_kind(e),
                "vault restore failed"
            );
        }
    }
    result
}

/// Async core of [`vault_restore_backup`] — testable without an
/// `AppHandle`. `base` is the app-data dir (`vaults/` parent).
pub(crate) async fn restore_backup_core(
    base: PathBuf,
    state: &VaultRuntimeState,
    source: PathBuf,
    options: RestoreOptions,
    hooks: ContainerHooks,
) -> Result<RestoreOutcome, BackupRestoreError> {
    // Stale-cancel hygiene mirrors export: the flag is reset at the start
    // of the op it now belongs to. (Restores stage permitless by design —
    // SYNC-6 — so two concurrent restores are possible; the single shared
    // flag means `backup_cancel` aims at "the backup operation", which is
    // exactly the one UI surface MYND-56 exposes.)
    hooks.reset_cancel();

    // (1) Credential-free validation (stages 1–5). Default: all-or-nothing.
    // Salvage (explicit opt-in): tolerate per-member hash damage, but the
    // container structure AND vault.meta must be intact (an unreadable
    // meta is unsalvageable — nothing restored could ever unlock).
    let validate_source = source.clone();
    let validate_hooks = hooks.clone();
    let salvage = options.salvage;
    let (records, skipped, meta_hash) = tokio::task::spawn_blocking(move || {
        validate_backup_file(&validate_source, &validate_hooks, salvage)
    })
    .await
    .map_err(|_| BackupRestoreError::JoinFailure)??;

    // (1b) Identity collision (SYNC-5): credential-free header match across
    // discovered vaults. Absent intent + collision ⇒ the UI asks the user.
    let collided = detect_collision(&base, &meta_hash);
    let collided_vault_id = match (&collided, options.on_collision) {
        (Some(existing), None) => {
            return Err(BackupRestoreError::VaultAlreadyExists {
                vault_id: existing.clone(),
            });
        }
        (Some(existing), Some(_)) => Some(existing.clone()),
        (None, _) => None,
    };

    // (2) Staging, outside the permit. Sweep stale staging first.
    let vaults_dir = base.join("vaults");
    std::fs::create_dir_all(&vaults_dir)?;
    sweep_stale_staging(&vaults_dir);
    let staging = staging_dir(&vaults_dir);
    let stage_source = source.clone();
    let stage_records = records.clone();
    let stage_hooks = hooks.clone();
    let stage_dir = staging.clone();
    let stage_skip = skipped.clone();
    let staged = tokio::task::spawn_blocking(move || -> Result<(), BackupRestoreError> {
        extract_all_members(
            &stage_source,
            &stage_records,
            &stage_dir,
            &stage_hooks,
            &stage_skip,
        )
        .map_err(Into::into)
    })
    .await
    .map_err(|_| {
        // A panicked staging pass must not leak its directory (F5).
        let _ = std::fs::remove_dir_all(&staging);
        BackupRestoreError::JoinFailure
    })?;
    if let Err(e) = staged {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }

    // (3) Commit, inside the permit (SYNC-6: staging outside, commit in).
    let permit = state.auth_permits().try_acquire();
    let _permit = match permit {
        Ok(p) => p,
        Err(_) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(BackupRestoreError::AuthOperationInProgress);
        }
    };
    if let Some(flag) = &hooks.cancelled {
        if flag.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(BackupRestoreError::Cancelled);
        }
    }
    // Commit-time collision re-check (F3): the pre-staging scan can go
    // stale during a long extraction (a sibling restore committing the
    // same identity). 22-byte header reads — cheap inside the permit. A
    // NEW collision with no declared intent aborts cleanly.
    if collided_vault_id.is_none() && options.on_collision.is_none() {
        if let Some(existing) = detect_collision(&base, &meta_hash) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(BackupRestoreError::VaultAlreadyExists { vault_id: existing });
        }
    }
    let vault_id = crate::vault_registry::mint_unique_vault_id(&base);
    let dest = vaults_dir.join(vault_id.to_string());
    if let Err(e) = std::fs::rename(&staging, &dest) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e.into());
    }
    // Best-effort directory-entry durability (the atomic_write Unix
    // discipline; Windows relies on the journal).
    #[cfg(unix)]
    if let Ok(dir) = std::fs::File::open(&vaults_dir) {
        let _ = dir.sync_all();
    }

    let mut outcome = RestoreOutcome {
        vault_id: vault_id.to_string(),
        members: (records.len() - skipped.len()) as u32,
        bytes: 0,
        notes: 0,
        snapshots: 0,
        attachments: 0,
        collided_vault_id,
        skipped,
    };
    for record in &records {
        use crate::backup_container::{classify_member_path, MemberFamily};
        if outcome.skipped.iter().any(|s| s == &record.path) {
            continue;
        }
        outcome.bytes += record.len;
        match classify_member_path(&record.path) {
            Some(MemberFamily::Note) => outcome.notes += 1,
            Some(MemberFamily::Snapshot) => outcome.snapshots += 1,
            Some(MemberFamily::AttachmentBlob) => outcome.attachments += 1,
            _ => {}
        }
    }
    Ok(outcome)
}

/// Output of [`validate_backup_file`]: the full table-order records, the
/// damaged-member paths (non-empty only in salvage mode), and the embedded
/// `vault.meta`'s `account_number_hash` (the collision-scan key).
pub(crate) type ValidatedBackup = (Vec<MemberRecord>, Vec<String>, [u8; 16]);

/// §9.11.6 stages 1–5, credential-free.
pub(crate) fn validate_backup_file(
    source: &Path,
    hooks: &ContainerHooks,
    salvage: bool,
) -> Result<ValidatedBackup, BackupRestoreError> {
    let verify_result = if salvage {
        // Tolerant verifier returns the FULL table-order record list
        // (container offsets are computed over it) + the damaged paths;
        // extraction suppresses the damaged ones by path.
        read_and_verify_members_tolerant(source, hooks)
    } else {
        read_and_verify_container_hooked(source, hooks).map(|records| (records, Vec::new()))
    };
    let (records, skipped) = match verify_result {
        Ok(pair) => pair,
        Err(crate::backup_container::BackupContainerError::MagicMismatch) => {
            // Distinguish the v005 reservation: §10.4 demands an explicit
            // migration prompt for a future-version container.
            // 4-byte sniff only — a mis-picked multi-GB foreign file must
            // not be slurped into RAM on the error path (F2).
            let mut magic = [0u8; 4];
            let is_v005 = std::fs::File::open(source)
                .and_then(|mut f| {
                    use std::io::Read;
                    f.read_exact(&mut magic)
                })
                .is_ok()
                && magic == *b"MYB5";
            return Err(if is_v005 {
                BackupRestoreError::FutureVersionBackup
            } else {
                BackupRestoreError::NotABackupFile
            });
        }
        Err(e) => return Err(e.into()),
    };

    // Salvage is unsalvageable without an intact vault.meta.
    if skipped.iter().any(|s| s == "vault.meta") {
        return Err(BackupRestoreError::InvalidVaultMeta);
    }

    // Stage 5: the REQUIRED vault.meta member, structurally parsed with the
    // same parser that produces `InvalidVaultMeta` today.
    let meta_bytes = extract_member(source, &records, "vault.meta")
        .map_err(BackupRestoreError::from)?
        .ok_or(BackupRestoreError::MissingVaultMeta)?;
    // Either generation (myne-md/myne#433). `NTV5` is the same 345 bytes, so
    // stages 1-4 accept the container and only this parse rejected it: every
    // backup taken after a migration verified cleanly and was unrestorable.
    let meta = protocol::parse_vault_meta_any(&meta_bytes)
        .map_err(|_| BackupRestoreError::InvalidVaultMeta)?;
    Ok((records, skipped, meta.account_number_hash))
}

/// Credential-free same-identity scan (SYNC-5 mechanics) — first match
/// wins, deterministically (sorted discovery; the recovery-selector
/// posture).
fn detect_collision(base: &Path, hash: &[u8; 16]) -> Option<String> {
    // Reuses the recovery-selector's canonical header read (NO magic
    // gate — a structurally-damaged twin must still match; that IS
    // restore's flagship repair case) and `discover_vaults`'s sorted,
    // deterministic iteration (first-match-wins, the selector posture).
    crate::vault_registry::discover_vaults(base)
        .into_iter()
        .find(|v| {
            crate::plugins::vault_recover::account_number_select::read_account_number_hash_from_header(
                &v.root,
            )
            .as_ref()
                == Some(hash)
        })
        .map(|v| v.id.to_string())
}

/// Fresh discovery-invisible staging path. Uniqueness via pid + a
/// monotonic counter (no clock — keeps tests deterministic enough while
/// two concurrent restores still get distinct dirs).
fn staging_dir(vaults_dir: &Path) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    vaults_dir.join(format!("{STAGING_PREFIX}{}-{n}", std::process::id()))
}

/// Remove leftover staging dirs from CRASHED PRIOR PROCESSES (the
/// `vault_migration` discard-partial posture). Same-process staging is
/// preserved: restores stage permitless by design (SYNC-6), so a sibling
/// in-flight restore's live staging MUST survive this sweep (adversarial
/// review F1 — deleting it would let an incomplete vault commit with a
/// full-count success report, the failure class SYNC-4 exists to kill).
/// Cross-process is closed by `tauri-plugin-single-instance`; residue is
/// always ciphertext (hygiene, never confidentiality). Runs at
/// restore-start; a boot-time sweep is deliberately NOT wired — the next
/// restore reclaims, and a never-restoring install keeps only
/// at-rest-class ciphertext residue.
pub(crate) fn sweep_stale_staging(vaults_dir: &Path) {
    let live_prefix = format!("{STAGING_PREFIX}{}-", std::process::id());
    let Ok(entries) = std::fs::read_dir(vaults_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.starts_with(STAGING_PREFIX) && !name.starts_with(&live_prefix) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

// see: ../../AGENTS.md "Secret-handling logging discipline"

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{seed_real_vault_meta, ScopedTempDir};
    use std::fs;

    const NOTE_A: &str = "0190a000-0000-7000-8000-00000000000a";
    const SNAP: &str = "0190a000-0000-7000-8000-0000000000f1";

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    /// Build a realistic source vault (REAL parseable vault.meta) and
    /// export it to a `.myne-backup`; returns (tempdir, backup_path).
    fn fixture_backup(dir: &ScopedTempDir) -> PathBuf {
        let vault = dir.path().join("source-vault");
        fs::create_dir_all(vault.join("notes")).unwrap();
        fs::create_dir_all(vault.join("snapshots")).unwrap();
        fs::create_dir_all(vault.join("attachments")).unwrap();
        seed_real_vault_meta(&vault, 0x33);
        fs::write(vault.join("vault.prefs"), vec![0x01; 100]).unwrap();
        fs::write(vault.join("vault.attachments"), vec![0x02; 64]).unwrap();
        fs::write(vault.join(format!("notes/{NOTE_A}.myn")), b"note-bytes").unwrap();
        fs::write(
            vault.join(format!("snapshots/{NOTE_A}__{SNAP}.myn")),
            b"snap-bytes",
        )
        .unwrap();
        fs::write(
            vault.join(format!("attachments/{}", "cd".repeat(32))),
            vec![0xEE; 4096],
        )
        .unwrap();
        let backup = dir.path().join("fixture.myne-backup");
        let writer =
            super::super::commands::export_phase_one(&vault, &backup, ContainerHooks::default())
                .expect("phase one");
        super::super::commands::export_finalize(writer, &backup, ContainerHooks::default())
            .expect("finalize");
        backup
    }

    #[test]
    fn round_trip_restores_byte_identical_members() {
        rt().block_on(async {
            let dir = ScopedTempDir::new("br-roundtrip").unwrap();
            let backup = fixture_backup(&dir);
            let base = dir.path().join("appdata");
            fs::create_dir_all(&base).unwrap();
            let state = VaultRuntimeState::default();

            let outcome = restore_backup_core(
                base.clone(),
                &state,
                backup.clone(),
                RestoreOptions::default(),
                ContainerHooks::default(),
            )
            .await
            .expect("restore");

            assert_eq!(outcome.notes, 1);
            assert_eq!(outcome.snapshots, 1);
            assert_eq!(outcome.attachments, 1);
            let restored = base.join("vaults").join(&outcome.vault_id);

            // Every member byte-identical to the source vault.
            let source = dir.path().join("source-vault");
            for member in [
                "vault.meta",
                "vault.prefs",
                "vault.attachments",
                &format!("notes/{NOTE_A}.myn"),
                &format!("snapshots/{NOTE_A}__{SNAP}.myn"),
                &format!("attachments/{}", "cd".repeat(32)),
            ] {
                assert_eq!(
                    fs::read(source.join(member)).unwrap(),
                    fs::read(restored.join(member)).unwrap(),
                    "member {member} must round-trip byte-identically",
                );
            }
            // Excluded family stays excluded.
            assert!(!restored.join("vault.search").exists());
            // No staging residue.
            assert!(fs::read_dir(base.join("vaults"))
                .unwrap()
                .flatten()
                .all(|e| !e.file_name().to_string_lossy().starts_with(STAGING_PREFIX)));
            // The restored id parses as a VaultId (discovery-visible).
            assert!(crate::vault_id::VaultId::parse_optional(Some(&outcome.vault_id)).is_some());
            // Permit returned.
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }

    #[test]
    fn rejection_taxonomy_is_distinguishable() {
        let dir = ScopedTempDir::new("br-reject").unwrap();
        let backup = fixture_backup(&dir);
        let bytes = fs::read(&backup).unwrap();
        let hooks = ContainerHooks::default();

        // MYB5 → explicit migration-prompt variant (§10.4).
        let v005 = dir.path().join("future.myne-backup");
        let mut b = bytes.clone();
        b[3] = b'5';
        fs::write(&v005, &b).unwrap();
        assert!(matches!(
            validate_backup_file(&v005, &hooks, false),
            Err(BackupRestoreError::FutureVersionBackup)
        ));

        // Foreign magic → NotABackupFile.
        let foreign = dir.path().join("foreign.bin");
        let mut b = bytes.clone();
        b[0] = b'X';
        fs::write(&foreign, &b).unwrap();
        assert!(matches!(
            validate_backup_file(&foreign, &hooks, false),
            Err(BackupRestoreError::NotABackupFile)
        ));

        // Flipped data byte → DamagedBackup.
        let damaged = dir.path().join("damaged.myne-backup");
        let mut b = bytes.clone();
        let last = b.len() - 1;
        b[last] ^= 0x01;
        fs::write(&damaged, &b).unwrap();
        assert!(matches!(
            validate_backup_file(&damaged, &hooks, false),
            Err(BackupRestoreError::DamagedBackup)
        ));

        // Structurally-bad embedded vault.meta → InvalidVaultMeta (the
        // repair loop-guard): rebuild a backup whose meta is 345 garbage
        // bytes (container-valid, §9.3-invalid).
        let bad_vault = dir.path().join("bad-meta-vault");
        fs::create_dir_all(&bad_vault).unwrap();
        fs::write(bad_vault.join("vault.meta"), vec![0xAB; 345]).unwrap();
        let bad_backup = dir.path().join("bad-meta.myne-backup");
        let writer = super::super::commands::export_phase_one(
            &bad_vault,
            &bad_backup,
            ContainerHooks::default(),
        )
        .expect("phase one");
        super::super::commands::export_finalize(writer, &bad_backup, ContainerHooks::default())
            .expect("finalize");
        assert!(matches!(
            validate_backup_file(&bad_backup, &hooks, false),
            Err(BackupRestoreError::InvalidVaultMeta)
        ));
    }

    #[test]
    fn restore_rejects_while_permit_held_and_cleans_staging() {
        rt().block_on(async {
            let dir = ScopedTempDir::new("br-permit").unwrap();
            let backup = fixture_backup(&dir);
            let base = dir.path().join("appdata");
            fs::create_dir_all(&base).unwrap();
            let state = VaultRuntimeState::default();

            let held = state.auth_permits().try_acquire().expect("permit");
            assert!(matches!(
                restore_backup_core(
                    base.clone(),
                    &state,
                    backup.clone(),
                    RestoreOptions::default(),
                    ContainerHooks::default()
                )
                .await,
                Err(BackupRestoreError::AuthOperationInProgress)
            ));
            // Staged bytes were discarded; vaults/ holds nothing visible.
            let leftovers: Vec<_> = fs::read_dir(base.join("vaults"))
                .unwrap()
                .flatten()
                .collect();
            assert!(leftovers.is_empty(), "rejected commit must clean staging");
            drop(held);

            restore_backup_core(
                base,
                &state,
                backup,
                RestoreOptions::default(),
                ContainerHooks::default(),
            )
            .await
            .expect("restore proceeds after permit release");
        });
    }

    #[test]
    fn collision_detection_and_intents() {
        rt().block_on(async {
            let dir = ScopedTempDir::new("br-collision").unwrap();
            let backup = fixture_backup(&dir);
            let base = dir.path().join("appdata");
            fs::create_dir_all(&base).unwrap();
            let state = VaultRuntimeState::default();

            // First restore: no collision possible.
            let first = restore_backup_core(
                base.clone(),
                &state,
                backup.clone(),
                RestoreOptions::default(),
                ContainerHooks::default(),
            )
            .await
            .expect("first restore");
            assert_eq!(first.collided_vault_id, None);

            // Second restore of the SAME backup: identity collision. No
            // intent ⇒ the engine reports the matched id and touches nothing.
            let err = restore_backup_core(
                base.clone(),
                &state,
                backup.clone(),
                RestoreOptions::default(),
                ContainerHooks::default(),
            )
            .await
            .expect_err("collision must surface");
            let BackupRestoreError::VaultAlreadyExists { vault_id } = &err else {
                panic!("expected VaultAlreadyExists, got {err:?}");
            };
            assert_eq!(vault_id, &first.vault_id);
            // Nothing new under vaults/ (no staging residue, no second vault).
            assert_eq!(fs::read_dir(base.join("vaults")).unwrap().count(), 1);

            // KeepBoth: side-by-side, outcome carries the matched id.
            let second = restore_backup_core(
                base.clone(),
                &state,
                backup.clone(),
                RestoreOptions {
                    on_collision: Some(CollisionIntent::KeepBoth),
                    salvage: false,
                },
                ContainerHooks::default(),
            )
            .await
            .expect("keep-both restore");
            assert_eq!(
                second.collided_vault_id.as_deref(),
                Some(first.vault_id.as_str())
            );
            assert_ne!(second.vault_id, first.vault_id, "fresh id minted");
            assert_eq!(fs::read_dir(base.join("vaults")).unwrap().count(), 2);

            // ReplaceExisting: engine behavior identical (restore-into-new;
            // the typed-confirm delete is the UI's chained step) — outcome
            // names the vault that step targets.
            let third = restore_backup_core(
                base,
                &state,
                backup,
                RestoreOptions {
                    on_collision: Some(CollisionIntent::ReplaceExisting),
                    salvage: false,
                },
                ContainerHooks::default(),
            )
            .await
            .expect("replace-intent restore");
            assert!(third.collided_vault_id.is_some());
        });
    }

    #[test]
    fn salvage_restores_intact_members_and_reports_skipped() {
        rt().block_on(async {
            let dir = ScopedTempDir::new("br-salvage").unwrap();
            let backup = fixture_backup(&dir);
            // Damage the LAST member's data (the vault.prefs member sorts
            // before vault.meta? lexicographic: attachments < notes <
            // snapshots < vault.attachments < vault.meta < vault.prefs —
            // so the last data bytes belong to vault.prefs).
            let mut bytes = fs::read(&backup).unwrap();
            let last = bytes.len() - 1;
            bytes[last] ^= 0x01;
            let damaged = dir.path().join("damaged.myne-backup");
            fs::write(&damaged, &bytes).unwrap();

            let base = dir.path().join("appdata");
            fs::create_dir_all(&base).unwrap();
            let state = VaultRuntimeState::default();

            // Default posture: all-or-nothing reject.
            assert!(matches!(
                restore_backup_core(
                    base.clone(),
                    &state,
                    damaged.clone(),
                    RestoreOptions::default(),
                    ContainerHooks::default()
                )
                .await,
                Err(BackupRestoreError::DamagedBackup)
            ));

            // Explicit salvage: intact members restored, damaged listed.
            let outcome = restore_backup_core(
                base.clone(),
                &state,
                damaged,
                RestoreOptions {
                    on_collision: None,
                    salvage: true,
                },
                ContainerHooks::default(),
            )
            .await
            .expect("salvage restore");
            assert_eq!(outcome.skipped, vec!["vault.prefs".to_string()]);
            let restored = base.join("vaults").join(&outcome.vault_id);
            assert!(!restored.join("vault.prefs").exists());
            assert!(restored.join("vault.meta").exists());
            assert!(restored.join(format!("notes/{NOTE_A}.myn")).exists());
        });
    }

    #[test]
    fn salvage_with_damaged_vault_meta_is_unsalvageable() {
        let dir = ScopedTempDir::new("br-salvage-meta").unwrap();
        let backup = fixture_backup(&dir);
        let bytes = fs::read(&backup).unwrap();
        // Locate vault.meta's data region and flip a byte inside it.
        let records = crate::backup_container::read_and_verify_container(&backup).expect("verify");
        let idx = records.iter().position(|r| r.path == "vault.meta").unwrap();
        let offset = crate::backup_container::member_data_offsets(&records)[idx] as usize;
        let mut damaged_bytes = bytes;
        damaged_bytes[offset + 30] ^= 0x01;
        let damaged = dir.path().join("meta-damaged.myne-backup");
        fs::write(&damaged, &damaged_bytes).unwrap();
        assert!(matches!(
            validate_backup_file(&damaged, &ContainerHooks::default(), true),
            Err(BackupRestoreError::InvalidVaultMeta)
        ));
    }

    #[test]
    fn restore_leaves_unlocked_sibling_vault_untouched() {
        // Auto-lock orthogonality (SYNC-5 mechanics): restore never touches
        // the slot map — an unlocked sibling stays unlocked, no forced lock.
        use crate::plugins::vault_unlock::state::{
            fixture_unlocked_with_keys, test_vault_id, SlotKind,
        };
        rt().block_on(async {
            let dir = ScopedTempDir::new("br-orthogonal").unwrap();
            let backup = fixture_backup(&dir);
            let base = dir.path().join("appdata");
            fs::create_dir_all(&base).unwrap();
            let state = VaultRuntimeState::default();
            state
                .set_unlocked(test_vault_id(), fixture_unlocked_with_keys(0x42, 0x99, 1))
                .await;

            restore_backup_core(
                base,
                &state,
                backup,
                RestoreOptions::default(),
                ContainerHooks::default(),
            )
            .await
            .expect("restore");
            assert_eq!(state.slot_kind(test_vault_id()).await, SlotKind::Unlocked);
        });
    }

    #[test]
    fn sweep_preserves_same_process_live_staging() {
        // F1 pin: a sibling in-flight restore's staging (same pid) MUST
        // survive the sweep; another process's crashed residue must not.
        let dir = ScopedTempDir::new("br-sweep-live").unwrap();
        let vaults = dir.path().join("vaults");
        fs::create_dir_all(&vaults).unwrap();
        let live = vaults.join(format!("{STAGING_PREFIX}{}-42", std::process::id()));
        let dead = vaults.join(format!("{STAGING_PREFIX}999999-0"));
        fs::create_dir_all(&live).unwrap();
        fs::create_dir_all(&dead).unwrap();
        sweep_stale_staging(&vaults);
        assert!(live.exists(), "same-process staging must survive");
        assert!(!dead.exists(), "foreign-pid residue must be reclaimed");
    }

    #[test]
    fn stale_staging_is_swept_at_restore_start() {
        rt().block_on(async {
            let dir = ScopedTempDir::new("br-sweep").unwrap();
            let backup = fixture_backup(&dir);
            let base = dir.path().join("appdata");
            let vaults = base.join("vaults");
            fs::create_dir_all(&vaults).unwrap();
            let stale = vaults.join(format!("{STAGING_PREFIX}999-0"));
            fs::create_dir_all(&stale).unwrap();
            fs::write(stale.join("vault.meta"), b"crashed-residue").unwrap();

            let state = VaultRuntimeState::default();
            restore_backup_core(
                base,
                &state,
                backup,
                RestoreOptions::default(),
                ContainerHooks::default(),
            )
            .await
            .expect("restore");
            assert!(!stale.exists(), "stale staging must be swept");
        });
    }
}
