// SPDX-License-Identifier: AGPL-3.0
//! Device-local backup-schedule config store (MYND-351).
//!
//! ## What this is
//!
//! A best-effort, **plaintext, device-local** JSON file holding the automatic
//! local-backup schedule, keyed by [`VaultId`]. It lives at
//! `<app_data_dir>/vaults/backup-schedule.json` — a sibling of the
//! `registry.json` cache (`vault_registry`), and modelled on it.
//!
//! ## Why device-local plaintext (decisions.md forward-look)
//!
//! The target folder is inherently device-specific — a filesystem path on
//! machine X is meaningless on machine Y — so the schedule cannot live in the
//! encrypted, Phase-2-syncing `vault.prefs`. Per the design session
//! (`myne-agents/sessions/design/2026-06-17-scheduled-local-backup.md`,
//! Model A) all schedule fields are bound together device-locally: binding the
//! "enabled + interval + N" intent to the device-local target avoids a
//! half-configured split-storage state.
//!
//! This is a DELIBERATE departure from `registry.json`'s no-paths discipline
//! (`vault_registry` stores ONLY opaque id + last-unlock): the schedule store
//! records the target folder and the written-backup ledger as plaintext paths.
//! Backups are ciphertext (the MYB1 container copies encrypted blobs), so a
//! known location does not break confidentiality, and a plaintext path on disk
//! is consistent with the already-out-of-scope A7 (local malware) posture. The
//! `myne-agents/docs/decisions.md` entry (feature task 7) records this so it is not later
//! mistaken for a SYNC-3 violation.
//!
//! ## Field roles
//!
//! Per VaultId the entry carries two groups:
//! - **User settings** ([`ScheduleSettings`]): `enabled`, `interval`,
//!   `target_folder`, `retention_n`. Written by the StoragePanel UI.
//! - **Engine state**: `ledger` (paths the scheduler itself wrote — the
//!   pruning allowlist, feature task 2), `last_scheduled_success_at` (the
//!   per-device elapsed-check clock, task 3, deliberately decoupled from
//!   `vault.prefs.last_backup_at`), `last_backup_attempt_at` /
//!   `last_backup_status` (the failure surface, task 5).
//!
//! [`write_settings`] is read-modify-write: it updates ONLY the user-settings
//! group and preserves the engine state, so a UI save never clobbers the
//! ledger or the clock.
//!
//! ## Best-effort, self-healing (the registry precedent)
//!
//! A missing or corrupt file decodes to "no entries" → every vault reads its
//! defaults (disabled, N=7). The parser is strict per-entry: an entry whose
//! `id` does not parse collapses the whole file to defaults rather than
//! importing partial data; advisory fields (interval, status, timestamps)
//! degrade individually to their defaults.
//!
//! ## Logging discipline
//!
//! Per `src-tauri/AGENTS.md` "Secret-handling logging discipline", a full
//! filesystem path and a `VaultId` are both DENY-listed. This module keeps
//! both off the tracing surface entirely — it emits nothing, by design (every
//! IO failure is swallowed best-effort, exactly like the registry cache).

use crate::paths::VAULTS_DIR_NAME;
use crate::vault_id::VaultId;
use std::path::Path;

/// Best-effort schedule store filename, persisted alongside the vault roots
/// (and `registry.json`) under `vaults/`. JSON; decodes to defaults if missing
/// or corrupt.
const SCHEDULE_FILE_NAME: &str = "backup-schedule.json";

/// Default number of backups to keep (keep-last-N). User-configurable; this is
/// the value an unconfigured or freshly-defaulted vault starts at.
pub(crate) const DEFAULT_RETENTION_N: u32 = 7;

/// Retention is clamped to this inclusive range. The floor is 1 (keeping 0
/// would delete every backup the instant it is written — nonsensical); the
/// ceiling is a defensive cap, not a product limit.
const RETENTION_MIN: u32 = 1;
const RETENTION_MAX: u32 = 365;

/// How often the scheduler should produce a backup. The elapsed-check
/// (feature task 3) interprets these against `last_scheduled_success_at`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum BackupInterval {
    /// Back up on every unlock (subject to the elapsed-check being trivially
    /// satisfied — effectively "each session").
    EveryUnlock,
    /// At most once per 24h. The default cadence for a freshly-enabled vault.
    #[default]
    Daily,
    /// At most once per 7d.
    Weekly,
}

impl BackupInterval {
    /// Canonical at-rest / IPC string form.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            BackupInterval::EveryUnlock => "every-unlock",
            BackupInterval::Daily => "daily",
            BackupInterval::Weekly => "weekly",
        }
    }

    /// Parse the canonical string form; `None` for anything else.
    pub(crate) fn parse(s: &str) -> Option<Self> {
        match s {
            "every-unlock" => Some(BackupInterval::EveryUnlock),
            "daily" => Some(BackupInterval::Daily),
            "weekly" => Some(BackupInterval::Weekly),
            _ => None,
        }
    }
}

/// Outcome of the most recent scheduled-backup attempt (the failure surface,
/// feature task 5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum BackupStatus {
    /// No scheduled backup has been attempted yet for this vault on this
    /// device.
    #[default]
    Never,
    /// The last attempt produced a verified `.myne-backup`.
    Success,
    /// The last attempt failed (target gone / disk full / permission denied).
    Failed,
}

impl BackupStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            BackupStatus::Never => "never",
            BackupStatus::Success => "success",
            BackupStatus::Failed => "failed",
        }
    }

    pub(crate) fn parse(s: &str) -> Option<Self> {
        match s {
            "never" => Some(BackupStatus::Never),
            "success" => Some(BackupStatus::Success),
            "failed" => Some(BackupStatus::Failed),
            _ => None,
        }
    }
}

/// The user-editable subset of a schedule entry — what the StoragePanel UI
/// writes via [`write_settings`]. Engine state (ledger, clock, status) is NOT
/// part of this and is preserved across writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ScheduleSettings {
    pub(crate) enabled: bool,
    pub(crate) interval: BackupInterval,
    pub(crate) target_folder: Option<String>,
    pub(crate) retention_n: u32,
}

/// One vault's full schedule record: user settings + engine state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ScheduleEntry {
    pub(crate) id: VaultId,
    // user settings
    pub(crate) enabled: bool,
    pub(crate) interval: BackupInterval,
    pub(crate) target_folder: Option<String>,
    pub(crate) retention_n: u32,
    // engine state
    pub(crate) ledger: Vec<String>,
    pub(crate) last_scheduled_success_at: Option<u64>,
    pub(crate) last_backup_attempt_at: Option<u64>,
    pub(crate) last_backup_status: BackupStatus,
}

impl ScheduleEntry {
    /// The defaults a vault with no stored config reads: automatic backup
    /// off, daily cadence, no target, keep-7, empty engine state.
    pub(crate) fn defaults_for(id: VaultId) -> Self {
        ScheduleEntry {
            id,
            enabled: false,
            interval: BackupInterval::default(),
            target_folder: None,
            retention_n: DEFAULT_RETENTION_N,
            ledger: Vec::new(),
            last_scheduled_success_at: None,
            last_backup_attempt_at: None,
            last_backup_status: BackupStatus::Never,
        }
    }
}

/// The whole device-local store: zero or more per-vault entries.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct BackupScheduleStore {
    pub(crate) entries: Vec<ScheduleEntry>,
}

impl BackupScheduleStore {
    fn get(&self, id: &VaultId) -> Option<&ScheduleEntry> {
        self.entries.iter().find(|e| &e.id == id)
    }
}

/// Clamp a (possibly user-supplied or on-disk) retention count into the
/// supported range. Out-of-range values are clamped, not rejected — N is a
/// non-load-bearing convenience.
fn clamp_retention(n: u32) -> u32 {
    n.clamp(RETENTION_MIN, RETENTION_MAX)
}

// ---- public store API ---------------------------------------------------

/// Read the schedule entry for `id`, returning [`ScheduleEntry::defaults_for`]
/// when the store is missing/corrupt or has no entry for this vault. Never
/// fails — a vault with no config always reads sane defaults.
pub(crate) fn read_config(base: &Path, id: &VaultId) -> ScheduleEntry {
    load_store(base)
        .get(id)
        .cloned()
        .unwrap_or_else(|| ScheduleEntry::defaults_for(*id))
}

/// Upsert the **user settings** for `id`, preserving any existing engine state
/// (ledger, clock, status). Read-modify-write against the device-local file;
/// best-effort persist (the returned error is for the caller to surface, but
/// the store stays non-authoritative). `retention_n` is clamped.
pub(crate) fn write_settings(
    base: &Path,
    id: &VaultId,
    settings: &ScheduleSettings,
) -> std::io::Result<()> {
    let mut store = load_store(base);
    let clamped = clamp_retention(settings.retention_n);
    match store.entries.iter_mut().find(|e| &e.id == id) {
        Some(entry) => {
            entry.enabled = settings.enabled;
            entry.interval = settings.interval;
            entry.target_folder = settings.target_folder.clone();
            entry.retention_n = clamped;
        }
        None => {
            let mut entry = ScheduleEntry::defaults_for(*id);
            entry.enabled = settings.enabled;
            entry.interval = settings.interval;
            entry.target_folder = settings.target_folder.clone();
            entry.retention_n = clamped;
            store.entries.push(entry);
        }
    }
    write_store_file(base, &store)
}

// ---- engine state mutators (feature tasks 2/3/5) ------------------------

/// Find-or-insert the entry for `id`, returning a mutable handle. A fresh
/// entry starts from [`ScheduleEntry::defaults_for`].
fn ensure_entry(store: &mut BackupScheduleStore, id: VaultId) -> &mut ScheduleEntry {
    match store.entries.iter().position(|e| e.id == id) {
        Some(pos) => &mut store.entries[pos],
        None => {
            store.entries.push(ScheduleEntry::defaults_for(id));
            store.entries.last_mut().expect("just pushed an entry")
        }
    }
}

/// Keep-last-N prune over an entry's ledger. While the ledger holds more than
/// `retention_n` paths, drop the OLDEST (front) and best-effort delete its
/// file. ONLY ledgered paths are ever touched — a file not in the ledger is
/// never referenced. A ledgered file the user moved/removed out-of-band makes
/// the `remove_file` a no-op (the error is swallowed); the ledger entry is
/// trimmed regardless, so the ledger and disk reconverge. Safe under a
/// cloud-synced target: we only ever delete our own recorded copies.
fn prune_entry_files(entry: &mut ScheduleEntry) {
    let keep = entry.retention_n as usize;
    while entry.ledger.len() > keep {
        let oldest = entry.ledger.remove(0);
        // Best-effort: a missing/moved file is a no-op, never an error.
        let _ = std::fs::remove_file(&oldest);
    }
}

/// True iff `path` is a `.myne-backup` file located under `target_folder`
/// (component-wise, so `/a/b-evil` is NOT under `/a/b`). Validates a
/// WebView-supplied scheduled-backup path BEFORE it can reach the retention
/// pruner's `remove_file` — an out-of-target path would be an arbitrary-file
/// delete primitive (TB6 narrow-seam). An absent/empty target cannot be
/// validated, so it fails closed.
pub(crate) fn backup_path_under_target(path: &str, target_folder: Option<&str>) -> bool {
    let p = std::path::Path::new(path);
    let ext_ok = p.extension().and_then(|e| e.to_str()) == Some("myne-backup");
    let under_ok = target_folder
        .map(|t| !t.is_empty() && p.starts_with(t))
        .unwrap_or(false);
    ext_ok && under_ok
}

/// Record a successful scheduled backup: append `written_path` to the ledger,
/// stamp the per-device success/attempt clock + `Success` status, prune to
/// `retention_n`, and persist. The append-then-prune order means a freshly
/// written backup is always among the kept set.
pub(crate) fn record_success(
    base: &Path,
    id: &VaultId,
    written_path: String,
    now_ms: u64,
) -> std::io::Result<()> {
    let mut store = load_store(base);
    let entry = ensure_entry(&mut store, *id);
    entry.ledger.push(written_path);
    entry.last_scheduled_success_at = Some(now_ms);
    entry.last_backup_attempt_at = Some(now_ms);
    entry.last_backup_status = BackupStatus::Success;
    prune_entry_files(entry);
    write_store_file(base, &store)
}

/// Record a failed scheduled-backup attempt: stamp the attempt clock +
/// `Failed` status, leaving the success clock and ledger untouched (the
/// schedule stays enabled and retries next cycle — feature task 5).
pub(crate) fn record_failure(base: &Path, id: &VaultId, now_ms: u64) -> std::io::Result<()> {
    let mut store = load_store(base);
    let entry = ensure_entry(&mut store, *id);
    entry.last_backup_attempt_at = Some(now_ms);
    entry.last_backup_status = BackupStatus::Failed;
    write_store_file(base, &store)
}

// ---- persistence --------------------------------------------------------

/// Load + parse the store, returning an empty store on any read/parse failure
/// (missing file, unreadable, malformed) — the self-healing default path.
fn load_store(base: &Path) -> BackupScheduleStore {
    let path = base.join(VAULTS_DIR_NAME).join(SCHEDULE_FILE_NAME);
    let Ok(bytes) = std::fs::read(path) else {
        return BackupScheduleStore::default();
    };
    parse_store(&bytes).unwrap_or_default()
}

/// Persist the store as JSON at `vaults/backup-schedule.json`, creating the
/// `vaults/` directory if absent. Best-effort: surfaces the IO error to the
/// caller (which treats the store as non-authoritative).
fn write_store_file(base: &Path, store: &BackupScheduleStore) -> std::io::Result<()> {
    let vaults_dir = base.join(VAULTS_DIR_NAME);
    std::fs::create_dir_all(&vaults_dir)?;
    let path = vaults_dir.join(SCHEDULE_FILE_NAME);
    std::fs::write(path, serialize_store(store))
}

/// Serialize to a stable JSON document. `VaultId` renders as its canonical
/// hyphenated string; enums as their canonical string form; timestamps as
/// plain integers or `null`.
fn serialize_store(store: &BackupScheduleStore) -> Vec<u8> {
    let value = serde_json::json!({
        "version": 1,
        "schedules": store
            .entries
            .iter()
            .map(|e| serde_json::json!({
                "id": e.id.to_string(),
                "enabled": e.enabled,
                "interval": e.interval.as_str(),
                "target_folder": e.target_folder,
                "retention_n": e.retention_n,
                "ledger": e.ledger,
                "last_scheduled_success_at": e.last_scheduled_success_at,
                "last_backup_attempt_at": e.last_backup_attempt_at,
                "last_backup_status": e.last_backup_status.as_str(),
            }))
            .collect::<Vec<_>>(),
    });
    serde_json::to_vec(&value).unwrap_or_else(|_| b"{}".to_vec())
}

/// Strict parse. A non-object root, wrong/missing version, `schedules` not an
/// array, or an entry whose `id` does not parse → `None` (whole-file fallback
/// to defaults). Advisory fields degrade individually to their defaults.
fn parse_store(bytes: &[u8]) -> Option<BackupScheduleStore> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let obj = value.as_object()?;
    if obj.get("version").and_then(|v| v.as_u64()) != Some(1) {
        return None;
    }
    let arr = obj.get("schedules")?.as_array()?;
    let mut entries = Vec::with_capacity(arr.len());
    for item in arr {
        let item = item.as_object()?;
        // A bad id collapses the whole file (like the registry's id rule).
        let id = VaultId::parse(item.get("id")?.as_str()?).ok()?;

        let enabled = item
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let interval = item
            .get("interval")
            .and_then(|v| v.as_str())
            .and_then(BackupInterval::parse)
            .unwrap_or_default();
        let target_folder = item
            .get("target_folder")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let retention_n = item
            .get("retention_n")
            .and_then(|v| v.as_u64())
            .map(|n| clamp_retention(n as u32))
            .unwrap_or(DEFAULT_RETENTION_N);
        let ledger = item
            .get("ledger")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|p| p.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let last_scheduled_success_at = item
            .get("last_scheduled_success_at")
            .and_then(|v| v.as_u64());
        let last_backup_attempt_at = item.get("last_backup_attempt_at").and_then(|v| v.as_u64());
        let last_backup_status = item
            .get("last_backup_status")
            .and_then(|v| v.as_str())
            .and_then(BackupStatus::parse)
            .unwrap_or_default();

        entries.push(ScheduleEntry {
            id,
            enabled,
            interval,
            target_folder,
            retention_n,
            ledger,
            last_scheduled_success_at,
            last_backup_attempt_at,
            last_backup_status,
        });
    }
    Some(BackupScheduleStore { entries })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScopedTempDir;
    use std::path::PathBuf;

    fn schedule_path(base: &Path) -> PathBuf {
        base.join(VAULTS_DIR_NAME).join(SCHEDULE_FILE_NAME)
    }

    fn settings(
        enabled: bool,
        interval: BackupInterval,
        target: Option<&str>,
        n: u32,
    ) -> ScheduleSettings {
        ScheduleSettings {
            enabled,
            interval,
            target_folder: target.map(|s| s.to_string()),
            retention_n: n,
        }
    }

    // ---- defaults for an unconfigured vault ----------------------------

    #[test]
    fn backup_path_under_target_accepts_myne_backup_within_target() {
        assert!(backup_path_under_target(
            "/Users/me/Backups/myne-2026-07-03.myne-backup",
            Some("/Users/me/Backups"),
        ));
    }

    #[test]
    fn backup_path_under_target_rejects_outside_target_wrong_ext_or_no_target() {
        // Outside the configured folder — the arbitrary-delete vector.
        assert!(!backup_path_under_target(
            "/Users/me/Documents/taxes.pdf",
            Some("/Users/me/Backups"),
        ));
        // Right folder, wrong extension.
        assert!(!backup_path_under_target(
            "/Users/me/Backups/notes.txt",
            Some("/Users/me/Backups"),
        ));
        // Component-wise: a sibling sharing a name prefix must NOT match.
        assert!(!backup_path_under_target(
            "/Users/me/Backups-evil/x.myne-backup",
            Some("/Users/me/Backups"),
        ));
        // No target, or empty target → cannot validate → fail closed.
        assert!(!backup_path_under_target("/x.myne-backup", None));
        assert!(!backup_path_under_target("/x.myne-backup", Some("")));
    }

    #[test]
    fn read_returns_defaults_when_store_absent() {
        let tmp = ScopedTempDir::new("sched-absent").unwrap();
        let id = VaultId::mint();
        let entry = read_config(tmp.path(), &id);
        assert_eq!(entry, ScheduleEntry::defaults_for(id));
        assert!(!entry.enabled);
        assert_eq!(entry.retention_n, DEFAULT_RETENTION_N);
        assert_eq!(entry.last_backup_status, BackupStatus::Never);
    }

    #[test]
    fn read_returns_defaults_when_store_corrupt() {
        let tmp = ScopedTempDir::new("sched-corrupt").unwrap();
        std::fs::create_dir_all(tmp.path().join(VAULTS_DIR_NAME)).unwrap();
        std::fs::write(schedule_path(tmp.path()), b"not json {{{").unwrap();
        let id = VaultId::mint();
        let entry = read_config(tmp.path(), &id);
        assert_eq!(
            entry,
            ScheduleEntry::defaults_for(id),
            "corrupt store → defaults"
        );
    }

    #[test]
    fn read_returns_defaults_for_vault_absent_from_store() {
        // A store that exists but has no entry for this vault.
        let tmp = ScopedTempDir::new("sched-other").unwrap();
        let configured = VaultId::mint();
        write_settings(
            tmp.path(),
            &configured,
            &settings(true, BackupInterval::Weekly, Some("/x"), 3),
        )
        .unwrap();
        let other = VaultId::mint();
        assert_eq!(
            read_config(tmp.path(), &other),
            ScheduleEntry::defaults_for(other)
        );
    }

    // ---- round-trip + survives restart ---------------------------------

    #[test]
    fn settings_round_trip_survive_reload() {
        let tmp = ScopedTempDir::new("sched-roundtrip").unwrap();
        let id = VaultId::mint();
        write_settings(
            tmp.path(),
            &id,
            &settings(true, BackupInterval::Weekly, Some("/Users/me/Backups"), 10),
        )
        .unwrap();

        // Fresh read from disk == a simulated app restart (no in-memory state).
        let entry = read_config(tmp.path(), &id);
        assert!(entry.enabled);
        assert_eq!(entry.interval, BackupInterval::Weekly);
        assert_eq!(entry.target_folder.as_deref(), Some("/Users/me/Backups"));
        assert_eq!(entry.retention_n, 10);
        assert!(schedule_path(tmp.path()).is_file());
    }

    #[test]
    fn rewrite_updates_settings() {
        let tmp = ScopedTempDir::new("sched-rewrite").unwrap();
        let id = VaultId::mint();
        write_settings(
            tmp.path(),
            &id,
            &settings(true, BackupInterval::Daily, Some("/a"), 7),
        )
        .unwrap();
        write_settings(
            tmp.path(),
            &id,
            &settings(false, BackupInterval::EveryUnlock, Some("/b"), 5),
        )
        .unwrap();
        let entry = read_config(tmp.path(), &id);
        assert!(!entry.enabled);
        assert_eq!(entry.interval, BackupInterval::EveryUnlock);
        assert_eq!(entry.target_folder.as_deref(), Some("/b"));
        assert_eq!(entry.retention_n, 5);
    }

    // ---- two vaults stay independent -----------------------------------

    #[test]
    fn distinct_vaults_keep_independent_config() {
        let tmp = ScopedTempDir::new("sched-indep").unwrap();
        let a = VaultId::mint();
        let b = VaultId::mint();
        write_settings(
            tmp.path(),
            &a,
            &settings(true, BackupInterval::Daily, Some("/a"), 7),
        )
        .unwrap();
        write_settings(
            tmp.path(),
            &b,
            &settings(false, BackupInterval::Weekly, Some("/b"), 14),
        )
        .unwrap();

        let ea = read_config(tmp.path(), &a);
        let eb = read_config(tmp.path(), &b);
        assert!(ea.enabled && ea.target_folder.as_deref() == Some("/a") && ea.retention_n == 7);
        assert!(!eb.enabled && eb.target_folder.as_deref() == Some("/b") && eb.retention_n == 14);
        // Writing one never disturbs the other.
        write_settings(
            tmp.path(),
            &a,
            &settings(false, BackupInterval::EveryUnlock, None, 2),
        )
        .unwrap();
        assert_eq!(
            read_config(tmp.path(), &b),
            eb,
            "vault B untouched by a write to A"
        );
    }

    // ---- write_settings preserves engine state -------------------------

    #[test]
    fn write_settings_preserves_engine_state() {
        // Seed an entry whose engine fields are populated (as task 2/3/5 would
        // leave them), then a UI settings write must not clobber them.
        let tmp = ScopedTempDir::new("sched-preserve").unwrap();
        let id = VaultId::mint();
        let seeded = ScheduleEntry {
            ledger: vec!["/b/one.myne-backup".into(), "/b/two.myne-backup".into()],
            last_scheduled_success_at: Some(1_700_000_000_000),
            last_backup_attempt_at: Some(1_700_000_500_000),
            last_backup_status: BackupStatus::Success,
            ..ScheduleEntry::defaults_for(id)
        };
        let store = BackupScheduleStore {
            entries: vec![seeded.clone()],
        };
        std::fs::create_dir_all(tmp.path().join(VAULTS_DIR_NAME)).unwrap();
        std::fs::write(schedule_path(tmp.path()), serialize_store(&store)).unwrap();

        write_settings(
            tmp.path(),
            &id,
            &settings(true, BackupInterval::Weekly, Some("/new"), 9),
        )
        .unwrap();
        let entry = read_config(tmp.path(), &id);
        // settings updated…
        assert!(entry.enabled);
        assert_eq!(entry.interval, BackupInterval::Weekly);
        assert_eq!(entry.target_folder.as_deref(), Some("/new"));
        assert_eq!(entry.retention_n, 9);
        // …engine state preserved.
        assert_eq!(entry.ledger, seeded.ledger);
        assert_eq!(entry.last_scheduled_success_at, Some(1_700_000_000_000));
        assert_eq!(entry.last_backup_attempt_at, Some(1_700_000_500_000));
        assert_eq!(entry.last_backup_status, BackupStatus::Success);
    }

    // ---- retention clamp -----------------------------------------------

    #[test]
    fn retention_is_clamped() {
        let tmp = ScopedTempDir::new("sched-clamp").unwrap();
        let id = VaultId::mint();
        write_settings(
            tmp.path(),
            &id,
            &settings(true, BackupInterval::Daily, None, 0),
        )
        .unwrap();
        assert_eq!(
            read_config(tmp.path(), &id).retention_n,
            RETENTION_MIN,
            "0 clamps up to the floor"
        );
        write_settings(
            tmp.path(),
            &id,
            &settings(true, BackupInterval::Daily, None, 99_999),
        )
        .unwrap();
        assert_eq!(
            read_config(tmp.path(), &id).retention_n,
            RETENTION_MAX,
            "huge clamps to the ceiling"
        );
    }

    // ---- serialize ↔ parse round-trip + strictness ---------------------

    #[test]
    fn store_round_trips_through_json() {
        let id = VaultId::mint();
        let store = BackupScheduleStore {
            entries: vec![ScheduleEntry {
                id,
                enabled: true,
                interval: BackupInterval::Weekly,
                target_folder: Some("/tmp/x".into()),
                retention_n: 7,
                ledger: vec!["/tmp/x/a.myne-backup".into()],
                last_scheduled_success_at: Some(42),
                last_backup_attempt_at: Some(43),
                last_backup_status: BackupStatus::Failed,
            }],
        };
        let parsed = parse_store(&serialize_store(&store)).expect("round-trips");
        assert_eq!(parsed, store);
    }

    #[test]
    fn parse_rejects_wrong_version() {
        assert!(parse_store(br#"{"version":99,"schedules":[]}"#).is_none());
    }

    #[test]
    fn parse_rejects_unparseable_id() {
        let bytes = br#"{"version":1,"schedules":[{"id":"not-a-uuid","enabled":true}]}"#;
        assert!(
            parse_store(bytes).is_none(),
            "a bad id collapses the whole file"
        );
    }

    #[test]
    fn parse_degrades_unknown_interval_and_status_to_defaults() {
        let id = VaultId::mint();
        let json = format!(
            r#"{{"version":1,"schedules":[{{"id":"{id}","interval":"hourly","last_backup_status":"weird"}}]}}"#
        );
        let parsed = parse_store(json.as_bytes()).expect("advisory fields degrade, file survives");
        let e = &parsed.entries[0];
        assert_eq!(
            e.interval,
            BackupInterval::default(),
            "unknown interval → default"
        );
        assert_eq!(
            e.last_backup_status,
            BackupStatus::Never,
            "unknown status → default"
        );
        assert_eq!(
            e.retention_n, DEFAULT_RETENTION_N,
            "missing retention → default"
        );
        assert!(!e.enabled, "missing enabled → false");
    }

    #[test]
    fn interval_and_status_string_forms_round_trip() {
        for iv in [
            BackupInterval::EveryUnlock,
            BackupInterval::Daily,
            BackupInterval::Weekly,
        ] {
            assert_eq!(BackupInterval::parse(iv.as_str()), Some(iv));
        }
        for st in [
            BackupStatus::Never,
            BackupStatus::Success,
            BackupStatus::Failed,
        ] {
            assert_eq!(BackupStatus::parse(st.as_str()), Some(st));
        }
    }

    // ---- task 2: ledger + keep-last-N pruning --------------------------

    /// Create a real backup file in a `backups/` dir under `base` and return
    /// its absolute path string.
    fn make_backup_file(base: &Path, name: &str) -> String {
        let dir = base.join("backups");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, b"ciphertext").unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn record_success_appends_and_stamps() {
        let tmp = ScopedTempDir::new("sched-success").unwrap();
        let id = VaultId::mint();
        let p = make_backup_file(tmp.path(), "a.myne-backup");
        record_success(tmp.path(), &id, p.clone(), 1_700_000_000_000).unwrap();
        let entry = read_config(tmp.path(), &id);
        assert_eq!(entry.ledger, vec![p]);
        assert_eq!(entry.last_scheduled_success_at, Some(1_700_000_000_000));
        assert_eq!(entry.last_backup_attempt_at, Some(1_700_000_000_000));
        assert_eq!(entry.last_backup_status, BackupStatus::Success);
    }

    #[test]
    fn prune_keeps_last_n_and_deletes_oldest() {
        // N=7 with an 8th backup: the oldest is deleted, exactly 7 remain.
        let tmp = ScopedTempDir::new("sched-prune-n").unwrap();
        let id = VaultId::mint();
        write_settings(
            tmp.path(),
            &id,
            &settings(true, BackupInterval::Daily, Some("/b"), 7),
        )
        .unwrap();
        let mut paths = Vec::new();
        for i in 0..8 {
            let p = make_backup_file(tmp.path(), &format!("b{i}.myne-backup"));
            paths.push(p.clone());
            record_success(tmp.path(), &id, p, 1_700_000_000_000 + i as u64).unwrap();
        }
        let entry = read_config(tmp.path(), &id);
        assert_eq!(entry.ledger.len(), 7, "exactly N kept");
        assert!(
            !std::path::Path::new(&paths[0]).exists(),
            "oldest file deleted"
        );
        for p in &paths[1..] {
            assert!(std::path::Path::new(p).exists(), "the 7 newest survive");
        }
        assert_eq!(entry.ledger, paths[1..].to_vec(), "ledger == the 7 newest");
    }

    #[test]
    fn prune_never_deletes_an_unledgered_file() {
        // A file the scheduler never recorded must survive pruning.
        let tmp = ScopedTempDir::new("sched-prune-foreign").unwrap();
        let id = VaultId::mint();
        write_settings(
            tmp.path(),
            &id,
            &settings(true, BackupInterval::Daily, Some("/b"), 1),
        )
        .unwrap();
        let foreign = make_backup_file(tmp.path(), "user-file.myne-backup");
        let a = make_backup_file(tmp.path(), "a.myne-backup");
        let b = make_backup_file(tmp.path(), "b.myne-backup");
        record_success(tmp.path(), &id, a.clone(), 1).unwrap();
        record_success(tmp.path(), &id, b, 2).unwrap();
        assert!(!std::path::Path::new(&a).exists(), "ledgered oldest pruned");
        assert!(
            std::path::Path::new(&foreign).exists(),
            "unledgered file never touched"
        );
    }

    #[test]
    fn prune_skips_moved_or_missing_ledgered_file() {
        // A ledgered file removed out-of-band → prune's remove_file is a no-op,
        // ledger still trims, no error surfaces.
        let tmp = ScopedTempDir::new("sched-prune-missing").unwrap();
        let id = VaultId::mint();
        write_settings(
            tmp.path(),
            &id,
            &settings(true, BackupInterval::Daily, Some("/b"), 1),
        )
        .unwrap();
        let a = make_backup_file(tmp.path(), "a.myne-backup");
        record_success(tmp.path(), &id, a.clone(), 1).unwrap();
        std::fs::remove_file(&a).unwrap();
        let b = make_backup_file(tmp.path(), "b.myne-backup");
        record_success(tmp.path(), &id, b.clone(), 2).unwrap();
        let entry = read_config(tmp.path(), &id);
        assert_eq!(
            entry.ledger,
            vec![b],
            "ledger trimmed to N despite a missing file"
        );
    }

    #[test]
    fn lowering_n_prunes_on_next_record() {
        // 5 files at N=5, then lower N to 2; the next recorded backup prunes
        // down to 2.
        let tmp = ScopedTempDir::new("sched-lower-n").unwrap();
        let id = VaultId::mint();
        write_settings(
            tmp.path(),
            &id,
            &settings(true, BackupInterval::Daily, Some("/b"), 5),
        )
        .unwrap();
        let mut paths = Vec::new();
        for i in 0..5 {
            let p = make_backup_file(tmp.path(), &format!("c{i}.myne-backup"));
            paths.push(p.clone());
            record_success(tmp.path(), &id, p, i as u64).unwrap();
        }
        assert_eq!(read_config(tmp.path(), &id).ledger.len(), 5);
        write_settings(
            tmp.path(),
            &id,
            &settings(true, BackupInterval::Daily, Some("/b"), 2),
        )
        .unwrap();
        assert_eq!(
            read_config(tmp.path(), &id).ledger.len(),
            5,
            "settings write does not prune"
        );
        let last = make_backup_file(tmp.path(), "c5.myne-backup");
        record_success(tmp.path(), &id, last.clone(), 99).unwrap();
        let entry = read_config(tmp.path(), &id);
        assert_eq!(entry.ledger.len(), 2, "next run prunes to the lowered N");
        assert_eq!(
            entry.ledger,
            vec![paths[4].clone(), last],
            "the 2 newest survive"
        );
    }

    #[test]
    fn record_failure_stamps_without_touching_ledger_or_success_clock() {
        let tmp = ScopedTempDir::new("sched-failure").unwrap();
        let id = VaultId::mint();
        let p = make_backup_file(tmp.path(), "ok.myne-backup");
        record_success(tmp.path(), &id, p.clone(), 100).unwrap();
        record_failure(tmp.path(), &id, 200).unwrap();
        let entry = read_config(tmp.path(), &id);
        assert_eq!(entry.last_backup_status, BackupStatus::Failed);
        assert_eq!(
            entry.last_backup_attempt_at,
            Some(200),
            "attempt clock advances"
        );
        assert_eq!(
            entry.last_scheduled_success_at,
            Some(100),
            "success clock untouched"
        );
        assert_eq!(entry.ledger, vec![p], "ledger untouched on failure");
    }
}
