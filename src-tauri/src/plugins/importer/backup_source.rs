//! Open a `.myne-backup` container as a read-only import source
//! (myne-md/myne#816).
//!
//! The vault-to-vault import reads a source vault's `notes/` and `attachments/`
//! through a `Slot::ImportSource`, whose root the core now carries
//! (`myne_core::plugins::vault_unlock::state::ImportSourceMaterial::vault_root`).
//! A local vault resolves that root to `vaults/<id>/`; a backup has no such
//! directory, so this module extracts the container's members into a private
//! staging directory and opens the slot AT that root. Every reader then works
//! unchanged.
//!
//! **The container reader is reused, not re-implemented.** `read_and_verify_
//! container_hooked` + `extract_all_members` are the same all-or-nothing
//! verification the restore path uses (`backup/restore.rs`), so a damaged or
//! tampered backup is refused here exactly as it is there, and no second parser
//! exists to drift.
//!
//! **Staging is outside `vaults/`** (`<app_data>/import-staging/<id>/`) so the
//! vault picker never lists it, and it holds the container's members, which are
//! ciphertext: no plaintext is ever written. `import_source_close_backup`
//! removes it; a crash leaves a directory a later open sweeps.
//!
//! Logging: DENY-list clean (`src-tauri/AGENTS.md`). No path, no vault id and
//! no container byte reaches a log or an error message.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;
use tauri::{AppHandle, Runtime, State};

use myne_core::host::tauri_host::TauriHost;
use myne_core::plugins::vault_unlock::import_source::{self, open_at_root, SourceCredential};
use myne_core::vault_io::StdVaultIo;

use crate::backup_container::{
    extract_all_members, read_and_verify_container_hooked, BackupContainerError, ContainerHooks,
};
use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use myne_core::plugins::vault_unlock::error::VaultUnlockError;

use crate::plugins::vault_unlock::state::VaultRuntimeState;
use crate::vault_id::VaultId;

/// Staging directories older than this are swept on the next open (the
/// `backup/restore.rs` stale-staging posture, same reasoning: a crashed import
/// must not leak its extraction directory forever).
const STAGING_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// Closed failure taxonomy for opening a backup as an import source
/// (myne-md/myne#816). Serde-tagged so the TS side can branch on `kind`; every
/// variant is path-free and OS-string-free.
#[derive(Debug, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ImportSourceOpenBackupError {
    /// The picked file is not a Myne backup container.
    #[error("not a backup file")]
    NotABackupFile,
    /// The container failed structural or integrity verification.
    #[error("backup file is damaged")]
    DamagedBackup,
    /// The embedded `vault.meta` is missing or fails its structural parse.
    #[error("backup vault metadata is unreadable")]
    InvalidVaultMeta,
    /// The credential did not open the backup's vault.
    #[error("invalid credential")]
    InvalidCredentialOrVault,
    /// Another Argon2id-bound operation holds the shared permit.
    #[error("another vault operation is in progress")]
    UnlockInProgress,
    /// Nothing is unlocked to import into.
    #[error("no vault is open to import into")]
    NoActiveVaultToImportInto,
    /// Another import source is already open.
    #[error("another import source is already open")]
    VaultOpenAsImportSource,
    /// The user cancelled the extraction.
    #[error("operation cancelled")]
    Cancelled,
    /// The host cannot service the backup vault's KDF memory cost. Kept as its
    /// own variant (myne-md/myne#827) because the remedy differs from a generic
    /// open failure: this device is too small, not the file wrong.
    #[error("this device cannot service the backup vault's memory cost")]
    KdfMemoryExceedsHostCapability,
    /// Any other vault-open failure (a join failure, a recovery in progress).
    /// Not distinguished for the user, who has one remedy: retry.
    #[error("could not open the backup vault")]
    VaultOpenFailed,
    /// Filesystem failure, reduced to the closed kind.
    #[error("io failure")]
    Io { io_error_kind: IoFailureKind },
}

impl From<BackupContainerError> for ImportSourceOpenBackupError {
    fn from(e: BackupContainerError) -> Self {
        match e {
            BackupContainerError::Io(kind) => Self::Io {
                io_error_kind: from_io_error_kind(kind),
            },
            BackupContainerError::MagicMismatch
            | BackupContainerError::HeaderTooShort
            | BackupContainerError::ProtocolVersionMismatch => Self::NotABackupFile,
            BackupContainerError::Cancelled => Self::Cancelled,
            BackupContainerError::ReservedByteNonZero
            | BackupContainerError::MemberCountOverflow
            | BackupContainerError::MemberTableOverflow
            | BackupContainerError::PathInvalid
            | BackupContainerError::PathNotAllowlisted
            | BackupContainerError::DuplicatePath
            | BackupContainerError::PathOrderViolation
            | BackupContainerError::MemberLenOverflow
            | BackupContainerError::LengthsInconsistent
            | BackupContainerError::HashMismatch => Self::DamagedBackup,
        }
    }
}

impl From<VaultUnlockError> for ImportSourceOpenBackupError {
    fn from(e: VaultUnlockError) -> Self {
        match e {
            VaultUnlockError::InvalidCredentialOrVault => Self::InvalidCredentialOrVault,
            VaultUnlockError::InvalidVaultMeta => Self::InvalidVaultMeta,
            VaultUnlockError::UnlockInProgress => Self::UnlockInProgress,
            VaultUnlockError::NoActiveVaultToImportInto => Self::NoActiveVaultToImportInto,
            VaultUnlockError::VaultOpenAsImportSource => Self::VaultOpenAsImportSource,
            VaultUnlockError::IoError { io_error_kind } => Self::Io { io_error_kind },
            VaultUnlockError::KdfMemoryExceedsHostCapability { .. } => {
                Self::KdfMemoryExceedsHostCapability
            }
            VaultUnlockError::VaultNotFound
            | VaultUnlockError::VaultUpgradedUnsupported
            | VaultUnlockError::VaultAlreadyUnlocked
            | VaultUnlockError::VaultRecoveryInProgress
            | VaultUnlockError::JoinFailure => Self::VaultOpenFailed,
        }
    }
}

/// Where an import source's staging directory lives. Deterministic from the
/// minted id, so both the open and the close can find it without a side map.
fn staging_root(base: &Path, id: VaultId) -> PathBuf {
    base.join("import-staging").join(id.to_string())
}

/// Best-effort sweep of abandoned staging directories from crashed prior runs.
/// A live import's directory is younger than [`STAGING_MAX_AGE`], so this never
/// touches one in flight.
fn sweep_stale_staging(base: &Path) {
    let root = base.join("import-staging");
    let Ok(entries) = std::fs::read_dir(&root) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .map(|age| age >= STAGING_MAX_AGE)
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Create the staging directory with owner-only permissions (0700 on Unix), so
/// its listing is not world-readable: the member names are note-id filenames, a
/// DENY-list correlation tag (`src-tauri/AGENTS.md`), even though the bodies are
/// ciphertext (myne-md/myne#827). On non-Unix the platform default stands, which
/// is the same posture the rest of the device-local stores take.
fn create_staging_dir_private(staging: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .mode(0o700)
            .recursive(true)
            .create(staging)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(staging)
    }
}

/// Tauri command: extract `backup_path` into a private staging directory and
/// open it as a read-only import source, returning the minted source vault id.
///
/// The credential is the BACKUP's own password or recovery phrase. Exactly one
/// of the two is required; both-or-neither is refused (the core's
/// `SourceCredential::from_ipc`).
#[tauri::command]
pub async fn import_source_open_backup<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    backup_path: String,
    password: Option<String>,
    recovery_phrase: Option<String>,
) -> Result<String, ImportSourceOpenBackupError> {
    let credential = SourceCredential::from_ipc(password, recovery_phrase)
        .ok_or(ImportSourceOpenBackupError::InvalidCredentialOrVault)?;
    let base = crate::paths::app_data_dir(&app).map_err(|_| ImportSourceOpenBackupError::Io {
        io_error_kind: IoFailureKind::Other,
    })?;

    let source_id = VaultId::mint();
    let staging = staging_root(&base, source_id);
    let backup = PathBuf::from(backup_path);
    // A cancel flag the extraction and the Argon2id open both poll, so the
    // modal's Cancel is not inert during the longest phase of the flow
    // (myne-md/myne#827). The import engine's run loop owns the same intent
    // frontend-side; this wires it into the blocking extraction.
    let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

    // Extraction is blocking (fs + hashing); keep it off the async runtime.
    let extract = {
        let staging = staging.clone();
        let backup = backup.clone();
        let cancelled = cancelled.clone();
        tokio::task::spawn_blocking(move || -> Result<(), ImportSourceOpenBackupError> {
            sweep_stale_staging(
                staging
                    .parent()
                    .and_then(Path::parent)
                    .unwrap_or_else(|| Path::new(".")),
            );
            let _ = std::fs::remove_dir_all(&staging);
            create_staging_dir_private(&staging).map_err(|e| ImportSourceOpenBackupError::Io {
                io_error_kind: from_io_error_kind(e.kind()),
            })?;
            let hooks = ContainerHooks {
                progress: None,
                cancelled: Some(cancelled.clone()),
            };
            let records = read_and_verify_container_hooked(&backup, &hooks)?;
            extract_all_members(&backup, &records, &staging, &hooks, &[])?;
            Ok(())
        })
        .await
    };
    match extract {
        Ok(Ok(())) => {}
        Ok(Err(e)) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
        Err(_) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(ImportSourceOpenBackupError::VaultOpenFailed);
        }
    }

    // Open the slot at the extraction root. Any failure removes the staging.
    if let Err(e) = open_at_root(
        source_id,
        staging.clone(),
        credential,
        state.inner(),
        &TauriHost::new(app),
        &StdVaultIo,
    )
    .await
    {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e.into());
    }

    tracing::info!(
        event = "import_source_backup_opened",
        "a backup was opened for reading"
    );
    Ok(source_id.to_string())
}

/// Tauri command: close a backup import source and remove its staging
/// directory. Idempotent, so the frontend calls it on every exit path.
#[tauri::command]
pub async fn import_source_close_backup<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    source_vault_id: String,
) -> Result<(), ImportSourceOpenBackupError> {
    let source_id = VaultId::parse(&source_vault_id)
        .map_err(|_| ImportSourceOpenBackupError::VaultOpenFailed)?;
    import_source::close(source_id, state.inner()).await;
    if let Ok(base) = crate::paths::app_data_dir(&app) {
        let _ = std::fs::remove_dir_all(staging_root(&base, source_id));
    }
    Ok(())
}
