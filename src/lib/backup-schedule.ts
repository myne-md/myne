// Device-local automatic-backup scheduler (MYND-351).
//
// Two layers live here:
//  1. IPC wrappers over the `backup` plugin's schedule commands — hand-mirror
//     `src-tauri/src/plugins/backup/schedule.rs` (no codegen canary yet; see
//     src/CLAUDE.md "Tauri command bindings").
//  2. The pure scheduling core (`intervalMs`, `isBackupDue`) + the orchestrator
//     (`runScheduledBackupIfDue`) that reuses the EXISTING `vault_export_backup`
//     verbatim. The orchestrator takes injected deps so it is unit-testable
//     without Tauri; the React glue (`useBackupScheduler`) wires the live deps.
//
// Model A (design session 2026-06-17): the scheduler runs only while the app
// is open and a vault is unlocked. The elapsed-check is opportunistic — it
// fires on unlock and periodically while unlocked — so auto-lock never starves
// a fixed wall-clock timer. The per-device clock (`lastScheduledSuccessAt`) is
// deliberately separate from the encrypted `vault.prefs.last_backup_at`.

import { invoke } from "../platform/core";

/** Cadence presets. Mirrors Rust `BackupInterval` (serde string form). */
export type BackupInterval = "every-unlock" | "daily" | "weekly";

/** Last-attempt outcome. Mirrors Rust `BackupStatus` (serde string form). */
export type BackupStatus = "never" | "success" | "failed";

/** Read projection of a schedule entry. Mirrors Rust `ScheduleConfigDto`. */
export interface ScheduleConfig {
  enabled: boolean;
  interval: BackupInterval;
  targetFolder: string | null;
  retentionN: number;
  /** Per-device elapsed-check clock (epoch ms UTC), null if never run. */
  lastScheduledSuccessAt: number | null;
  lastBackupAttemptAt: number | null;
  lastBackupStatus: BackupStatus;
  /** How many backups the pruning ledger currently tracks. */
  trackedBackups: number;
}

/** User-editable settings written by the StoragePanel. Mirrors Rust
 *  `ScheduleSettingsDto`. Engine state is preserved server-side on write. */
export interface ScheduleSettings {
  enabled: boolean;
  interval: BackupInterval;
  targetFolder: string | null;
  retentionN: number;
}

// ---- IPC wrappers -------------------------------------------------------

/** `backup:backup_schedule_read` — config for one vault (defaults if unset). */
export function scheduleRead(vaultId: string): Promise<ScheduleConfig> {
  return invoke<ScheduleConfig>("plugin:backup|backup_schedule_read", {
    vaultId,
  });
}

/** `backup:backup_schedule_write` — upsert user settings (engine state kept). */
export function scheduleWrite(
  vaultId: string,
  settings: ScheduleSettings,
): Promise<void> {
  return invoke<void>("plugin:backup|backup_schedule_write", {
    vaultId,
    settings,
  });
}

/** `backup:backup_schedule_record_result` — record a run's outcome (success
 *  appends the path to the prune ledger + stamps the clock; failure stamps the
 *  attempt + Failed status). */
export function scheduleRecordResult(
  vaultId: string,
  success: boolean,
  writtenPath?: string,
): Promise<void> {
  return invoke<void>("plugin:backup|backup_schedule_record_result", {
    vaultId,
    success,
    writtenPath: writtenPath ?? null,
  });
}

// ---- pure scheduling core (unit-tested) ---------------------------------

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** Minimum gap between scheduled backups for a preset. `every-unlock` is 0 —
 *  the elapsed-check is then trivially satisfied (back up each session). */
export function intervalMs(interval: BackupInterval): number {
  switch (interval) {
    case "every-unlock":
      return 0;
    case "daily":
      return DAY_MS;
    case "weekly":
      return WEEK_MS;
  }
}

/** Whether a scheduled backup is due at `nowMs`. Requires the schedule to be
 *  enabled with a target folder; if it has never run it is immediately due,
 *  else the configured interval must have elapsed since the last success. */
export function isBackupDue(config: ScheduleConfig, nowMs: number): boolean {
  if (!config.enabled) return false;
  if (config.targetFolder == null || config.targetFolder === "") return false;
  if (config.lastScheduledSuccessAt == null) return true;
  return nowMs - config.lastScheduledSuccessAt >= intervalMs(config.interval);
}

// ---- orchestrator (injected deps; unit-tested) --------------------------

/** Outcome of one `runScheduledBackupIfDue` evaluation. */
export type ScheduleRunOutcome =
  | "backed-up"
  | "failed"
  | "skipped"
  | "not-due"
  | "disabled"
  | "no-target";

/**
 * Whether an export rejection is a transient "skip", not a backup failure.
 * `AuthOperationInProgress` = a user auth op (unlock / change-password /
 * delete) held the shared permit at this tick (MYND-351 Direction 1) — the
 * reject-never-queue permit means we simply retry next cycle. `Cancelled` =
 * a user auth op preempted us mid-run (Direction 2). Neither flips the status
 * to Failed; they are not the target-gone / disk-full failures task 5 surfaces.
 */
function isTransientSkip(err: unknown): boolean {
  const kind =
    typeof err === "object" && err !== null && "kind" in err
      ? (err as { kind: unknown }).kind
      : undefined;
  return kind === "AuthOperationInProgress" || kind === "Cancelled";
}

/** A single scheduler evaluation's result, plus whether it is a *fresh*
 *  failure that warrants a user-facing toast (debounced — see
 *  {@link shouldToastOutcome}). */
export interface ScheduleTick {
  outcome: ScheduleRunOutcome;
  freshFailure: boolean;
}

/**
 * Debounce decision for the failure toast (task 5): toast only on a `"failed"`
 * outcome whose previous outcome was NOT already `"failed"`. A persistent
 * failure (failed → failed → …) toasts once; a recovery and a later re-failure
 * (failed → backed-up → failed) toasts again. `null` prev = first evaluation.
 * Non-failure outcomes never toast (success is a quiet status line; skip /
 * not-due / disabled / no-target are silent).
 */
export function shouldToastOutcome(
  prev: ScheduleRunOutcome | null,
  curr: ScheduleRunOutcome,
): boolean {
  return curr === "failed" && prev !== "failed";
}

/** Injected collaborators — the live wiring is in `useBackupScheduler`; tests
 *  pass mocks so the orchestrator runs without Tauri. */
export interface ScheduleEngineDeps {
  readConfig: (vaultId: string) => Promise<ScheduleConfig>;
  defaultFilename: (now: Date) => Promise<string>;
  exportBackup: (destination: string, vaultId: string) => Promise<unknown>;
  recordResult: (
    vaultId: string,
    success: boolean,
    writtenPath?: string,
  ) => Promise<void>;
  joinPath: (folder: string, name: string) => Promise<string>;
}

/**
 * Read the schedule for `vaultId` and, if a backup is due, run it via the
 * existing `vault_export_backup` and record the result. The destination is the
 * configured target folder joined with the engine-owned default filename. A
 * failed export records a failure (status flips to Failed, schedule stays
 * enabled) and returns `"failed"` — it never throws, so a misbehaving target
 * cannot break the caller's render loop.
 */
export async function runScheduledBackupIfDue(
  vaultId: string,
  now: Date,
  deps: ScheduleEngineDeps,
): Promise<ScheduleRunOutcome> {
  const config = await deps.readConfig(vaultId);
  if (!config.enabled) return "disabled";
  if (config.targetFolder == null || config.targetFolder === "") {
    return "no-target";
  }
  if (!isBackupDue(config, now.getTime())) return "not-due";

  const filename = await deps.defaultFilename(now);
  const destination = await deps.joinPath(config.targetFolder, filename);
  try {
    await deps.exportBackup(destination, vaultId);
    await deps.recordResult(vaultId, true, destination);
    return "backed-up";
  } catch (err) {
    // A user auth op held / preempted the shared permit (Direction 1/2) — not
    // a backup failure. Skip silently and retry next cycle; do NOT flip status.
    if (isTransientSkip(err)) return "skipped";
    // A real export failure (target gone / disk full / permission denied).
    // Record it; the schedule stays enabled and retries next cycle.
    await deps.recordResult(vaultId, false);
    return "failed";
  }
}
