// `useBackupScheduler` — the React glue that drives the automatic local-backup
// engine (MYND-351 task 3) while the Editor (the only post-unlock surface) is
// mounted. Model A: the scheduler runs only while the app is open and a vault
// is unlocked, so the Editor's lifetime IS the scheduler's window.
//
// On mount (i.e. on unlock) it evaluates the elapsed-check once — the catch-up
// pass that heals a schedule missed while the app was closed — then re-checks
// on a coarse interval so a long unlocked session still produces fresh backups.
// The pure decision + the export orchestration live in `lib/backup-schedule.ts`
// (unit-tested); this hook only wires the live Tauri deps and resolves the
// active vault.
//
// The engine never throws (a failed export is recorded as a failure and
// returned as `"failed"`); the optional `onOutcome` callback lets a parent
// surface the result (task 5 wires the StoragePanel status + toast).

import { useEffect, useRef } from "react";
import { has } from "../platform/capabilities";
import { join } from "../platform/path";
import { backupDefaultFilename, exportBackup } from "../lib/vault-backup";
import {
  runScheduledBackupIfDue,
  scheduleRead,
  scheduleRecordResult,
  shouldToastOutcome,
  type ScheduleEngineDeps,
  type ScheduleRunOutcome,
  type ScheduleTick,
} from "../lib/backup-schedule";

/** How often to re-evaluate the elapsed-check while the vault stays unlocked.
 *  Coarse on purpose — the per-preset interval (≥ daily) gates actual runs, so
 *  this only needs to be frequent enough to catch a mid-session boundary. */
const PERIODIC_CHECK_MS = 5 * 60_000;

/** Live Tauri wiring for the scheduling engine. */
const LIVE_DEPS: ScheduleEngineDeps = {
  readConfig: scheduleRead,
  defaultFilename: backupDefaultFilename,
  exportBackup: (destination, vaultId) => exportBackup(destination, vaultId),
  recordResult: scheduleRecordResult,
  joinPath: (folder, name) => join(folder, name),
};

/**
 * Drive the automatic-backup scheduler for the lifetime of the calling
 * (post-unlock) component.
 *
 * `vaultId` is the vault to back up, and it is a REQUIRED parameter since #250
 * — the hook used to resolve it itself, via `resolveActiveVaultId()`, which
 * ordered the non-authoritative `registry.json` last-unlock cache. That cache
 * was stamped by the password path only, so a quick-unlocked or recovered
 * session scheduled its backups against a DIFFERENT vault than the open one.
 * `null` means "not resolved yet"; the tick is skipped rather than guessed.
 *
 * Optional `onTick` is invoked after each evaluation
 * with the engine's outcome plus a debounced `freshFailure` flag (true only on
 * a failure that wasn't already failing) so the parent can surface a quiet,
 * non-repeating failure toast (task 5).
 */
export function useBackupScheduler(
  vaultId: string | null,
  onTick?: (tick: ScheduleTick) => void,
): void {
  // Gated on the capability, at the TOP of the hook (phase3-web-client task 96).
  //
  // The Editor mounts this unconditionally, so on a client where `backup` is
  // absent it became a five-minute timer running for the whole unlocked session,
  // calling `vault_list` and `plugin:backup|backup_schedule_read` forever. Every
  // one of those is answered `Unsupported`, and every failure is swallowed by
  // the engine's own catch — so the loop was invisible, permanent, and
  // pointless: an IPC heartbeat for a feature the platform does not have.
  //
  // Gated here rather than at the Editor's call site so the guarantee holds for
  // every caller, including a future one. The effect below still runs its
  // cleanup path unchanged; it simply never arms.
  const enabled = has("backup");
  // Keep the latest callback without re-arming the interval each render.
  const onTickRef = useRef(onTick);
  onTickRef.current = onTick;
  // Previous outcome, for the failure-toast debounce across ticks.
  const prevOutcomeRef = useRef<ScheduleRunOutcome | null>(null);

  useEffect(() => {
    if (!enabled) return;
    // No resolved target yet (a post-reload editor whose id is still in
    // flight): do not arm. A tick with no vault has nothing to back up, and
    // guessing one is the defect this parameter exists to remove.
    if (vaultId == null) return;
    const target = vaultId;
    let cancelled = false;

    const tick = async () => {
      try {
        if (cancelled) return;
        const outcome = await runScheduledBackupIfDue(target, new Date(), LIVE_DEPS);
        if (cancelled) return;
        const freshFailure = shouldToastOutcome(prevOutcomeRef.current, outcome);
        prevOutcomeRef.current = outcome;
        onTickRef.current?.({ outcome, freshFailure });
      } catch {
        // Resolution/IPC hiccup — best-effort; the next tick retries. The
        // engine itself never throws on an export failure.
      }
    };

    void tick(); // catch-up on unlock
    const timer = setInterval(() => void tick(), PERIODIC_CHECK_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // `enabled` is a build-time constant per client, so this dependency never
    // actually changes — it is listed because it is read.
  }, [enabled, vaultId]);
}
