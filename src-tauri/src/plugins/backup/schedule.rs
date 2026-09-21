//! Device-local backup-schedule config commands (MYND-351, feature task 1).
//!
//! Thin IPC seam over the pure [`crate::backup_schedule`] store: the WebView
//! reads/writes the per-vault automatic-backup settings; the Rust core owns
//! the device-local JSON file (`vaults/backup-schedule.json`) and all its IO.
//!
//! `backup_schedule_write` updates ONLY the user-settings group (enabled /
//! interval / target folder / retention N); the engine state (ledger, clock,
//! status) is preserved by the store's read-modify-write, so a UI save can
//! never clobber the pruning ledger or the elapsed-check clock.
//!
//! Logging: see `src-tauri/AGENTS.md` "Secret-handling logging discipline" —
//! the target folder is a full filesystem path (DENY-listed) and the vault id
//! is a vault-stable correlation tag (DENY-listed); neither is ever emitted.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};

use crate::backup_schedule::{self, BackupInterval, ScheduleEntry, ScheduleSettings};
use crate::io_failure_kind::IoFailureKind;
use crate::vault_id::VaultId;

/// Closed error surface for the schedule-config commands. All variants are
/// DENY-list-safe (no path, no id, bounded enum only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum ScheduleConfigError {
    /// `vault_id` did not parse as a canonical [`VaultId`].
    InvalidVaultId,
    /// `interval` was not one of `every-unlock` / `daily` / `weekly`.
    InvalidInterval,
    /// A `success` result was recorded without a valid written backup path —
    /// absent, or not a `.myne-backup` under the schedule's configured target
    /// folder (the pruner only ever deletes ledgered paths, so an out-of-target
    /// path must be rejected before it can become a delete target).
    MissingBackupPath,
    /// Resolving `app_data_dir` or persisting the store failed.
    Io { io_error_kind: IoFailureKind },
}

/// Read projection of a [`ScheduleEntry`] (the full record minus the ledger
/// paths, which the WebView never needs — pruning is Rust-side, feature task
/// 2). camelCase to match the TS layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleConfigDto {
    pub enabled: bool,
    /// `every-unlock` / `daily` / `weekly`.
    pub interval: String,
    pub target_folder: Option<String>,
    pub retention_n: u32,
    /// Per-device elapsed-check clock (epoch ms), `null` if never run.
    pub last_scheduled_success_at: Option<u64>,
    pub last_backup_attempt_at: Option<u64>,
    /// `never` / `success` / `failed`.
    pub last_backup_status: String,
    /// How many backups the scheduler currently tracks (ledger length) — for
    /// the UI's "N kept" affordance, without exposing the paths themselves.
    pub tracked_backups: u32,
}

impl From<ScheduleEntry> for ScheduleConfigDto {
    fn from(e: ScheduleEntry) -> Self {
        ScheduleConfigDto {
            enabled: e.enabled,
            interval: e.interval.as_str().to_string(),
            target_folder: e.target_folder,
            retention_n: e.retention_n,
            last_scheduled_success_at: e.last_scheduled_success_at,
            last_backup_attempt_at: e.last_backup_attempt_at,
            last_backup_status: e.last_backup_status.as_str().to_string(),
            tracked_backups: e.ledger.len() as u32,
        }
    }
}

/// User-settings write payload (the StoragePanel form).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleSettingsDto {
    pub enabled: bool,
    pub interval: String,
    pub target_folder: Option<String>,
    pub retention_n: u32,
}

fn parse_id(vault_id: &str) -> Result<VaultId, ScheduleConfigError> {
    VaultId::parse(vault_id).map_err(|_| ScheduleConfigError::InvalidVaultId)
}

fn app_base<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, ScheduleConfigError> {
    crate::paths::app_data_dir(app).map_err(|_| ScheduleConfigError::Io {
        io_error_kind: IoFailureKind::Other,
    })
}

/// Read the schedule config for `vault_id`, returning sane defaults (disabled,
/// N=7) when nothing is stored — never fails on a missing/corrupt store.
#[tauri::command]
pub async fn backup_schedule_read<R: Runtime>(
    app: AppHandle<R>,
    vault_id: String,
) -> Result<ScheduleConfigDto, ScheduleConfigError> {
    let id = parse_id(&vault_id)?;
    let base = app_base(&app)?;
    let entry = tokio::task::spawn_blocking(move || backup_schedule::read_config(&base, &id))
        .await
        .map_err(|_| ScheduleConfigError::Io {
            io_error_kind: IoFailureKind::Other,
        })?;
    Ok(ScheduleConfigDto::from(entry))
}

/// Upsert the user settings for `vault_id`, preserving engine state.
#[tauri::command]
pub async fn backup_schedule_write<R: Runtime>(
    app: AppHandle<R>,
    vault_id: String,
    settings: ScheduleSettingsDto,
) -> Result<(), ScheduleConfigError> {
    let id = parse_id(&vault_id)?;
    let interval =
        BackupInterval::parse(&settings.interval).ok_or(ScheduleConfigError::InvalidInterval)?;
    let base = app_base(&app)?;
    let settings = ScheduleSettings {
        enabled: settings.enabled,
        interval,
        target_folder: settings.target_folder,
        retention_n: settings.retention_n,
    };

    let result =
        tokio::task::spawn_blocking(move || backup_schedule::write_settings(&base, &id, &settings))
            .await
            .map_err(|_| ScheduleConfigError::Io {
                io_error_kind: IoFailureKind::Other,
            })?;

    result.map_err(|e| {
        let kind = crate::io_failure_kind::from_io_error_kind(e.kind());
        tracing::warn!(
            stage = "backup_schedule_write",
            io_failure_kind = ?kind,
            "device-local backup schedule write failed"
        );
        ScheduleConfigError::Io {
            io_error_kind: kind,
        }
    })
}

/// Current wall-clock as Unix-epoch milliseconds (UTC). The per-device
/// elapsed-check clock; the TS scheduler compares `Date.now()` against the
/// `last_scheduled_success_at` this stamps — both UTC epoch ms, so they agree.
fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Record the outcome of a scheduled backup the TS engine just ran (feature
/// task 3 calls this after `vault_export_backup`). On success the verified
/// backup's path is appended to the pruning ledger, the success/attempt clock
/// + `Success` status are stamped, and the ledger is pruned to retention N. On
/// failure only the attempt clock + `Failed` status are stamped — the schedule
/// stays enabled and retries next cycle (feature task 5). The clock is the
/// Rust-side `now_epoch_ms` (not trusted from the WebView).
#[tauri::command]
pub async fn backup_schedule_record_result<R: Runtime>(
    app: AppHandle<R>,
    vault_id: String,
    success: bool,
    written_path: Option<String>,
) -> Result<(), ScheduleConfigError> {
    let id = parse_id(&vault_id)?;
    if success && written_path.is_none() {
        return Err(ScheduleConfigError::MissingBackupPath);
    }
    let base = app_base(&app)?;
    let now_ms = now_epoch_ms();

    // TB6 narrow-seam: the WebView-supplied `written_path` becomes a delete target
    // in the retention pruner (`prune_entry_files` remove_file's ledgered paths),
    // so require a real `.myne-backup` UNDER this schedule's configured target
    // folder before recording — otherwise a compromised WebView gets an arbitrary
    // file-delete primitive reaching outside the vault.
    if success {
        let path = written_path
            .as_deref()
            .expect("checked above: a success result carries a path");
        let target = backup_schedule::read_config(&base, &id).target_folder;
        if !backup_schedule::backup_path_under_target(path, target.as_deref()) {
            return Err(ScheduleConfigError::MissingBackupPath);
        }
    }

    let result = tokio::task::spawn_blocking(move || {
        if success {
            // Checked above; the path is present on the success branch.
            let path = written_path.expect("success result carries a path");
            backup_schedule::record_success(&base, &id, path, now_ms)
        } else {
            backup_schedule::record_failure(&base, &id, now_ms)
        }
    })
    .await
    .map_err(|_| ScheduleConfigError::Io {
        io_error_kind: IoFailureKind::Other,
    })?;

    result.map_err(|e| {
        let kind = crate::io_failure_kind::from_io_error_kind(e.kind());
        tracing::warn!(
            stage = "backup_schedule_record_result",
            io_failure_kind = ?kind,
            "device-local backup schedule result write failed"
        );
        ScheduleConfigError::Io {
            io_error_kind: kind,
        }
    })
}
