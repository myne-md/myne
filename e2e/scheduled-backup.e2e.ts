// Scheduled (automatic) local-backup suite (MYND-351; engine MYND-32, spec
// §9.11). Pins the scheduler's BACKEND production path through the release
// binary.
//
// The scheduler is Model A: it runs only while the app is open and a vault is
// unlocked (the Editor's `useBackupScheduler`). Its TS elapsed-check, the
// orchestrator outcomes, and the failure-toast debounce are Vitest-pinned
// (tests/backup/scheduleEngine.test.ts). What can ONLY be pinned end-to-end is
// the on-disk effect: the device-local schedule config commands, the real
// `vault_export_backup` the scheduler reuses, and the result recorder that
// updates the ledger + status. We drive those EXACT production IPCs from the
// page seat — the timer + native folder dialog cannot be driven by WebDriver
// (the backup-restore suite's dialog-bypass pattern; production IPC, no test
// hook). The Settings → Storage CONTROLS are asserted for real (they render
// and carry their testids).
//
// KDF: weak generator fixtures (legal — unlock reads params from vault.meta).

import { expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import {
  closeSettings,
  dismissImporterOffer,
  openSettings,
  pageSeatInvoke,
  unlockToEditor,
} from "./support/flows";

interface ScheduleConfigDto {
  enabled: boolean;
  interval: string;
  targetFolder: string | null;
  retentionN: number;
  lastScheduledSuccessAt: number | null;
  lastBackupAttemptAt: number | null;
  lastBackupStatus: string;
  trackedBackups: number;
}

type Session = Parameters<typeof pageSeatInvoke>[0];

async function writeSchedule(
  session: Session,
  vaultId: string,
  settings: {
    enabled: boolean;
    interval: string;
    targetFolder: string | null;
    retentionN: number;
  },
): Promise<void> {
  const res = await pageSeatInvoke(
    session,
    "plugin:backup|backup_schedule_write",
    { vaultId, settings },
    20_000,
  );
  if (res.err !== undefined) {
    throw new Error("schedule write failed: " + JSON.stringify(res.err));
  }
}

async function readSchedule(session: Session, vaultId: string): Promise<ScheduleConfigDto> {
  const res = await pageSeatInvoke(
    session,
    "plugin:backup|backup_schedule_read",
    { vaultId },
    20_000,
  );
  if (res.ok === undefined) {
    throw new Error("schedule read failed: " + JSON.stringify(res.err));
  }
  return res.ok as ScheduleConfigDto;
}

/** Drive the exact backend pair the scheduler runs internally: export to
 *  `destination`, then record the result. Returns the verdict AND the export's
 *  own error, so a failure can say why on the first run. */
async function runSchedulerBackend(
  session: Session,
  vaultId: string,
  destination: string,
): Promise<{ success: boolean; error: unknown }> {
  const exported = await pageSeatInvoke(
    session,
    "plugin:backup|vault_export_backup",
    // `vaultId` is `String`, not `Option<String>` — the command parses it and
    // answers `VaultNotFound` on a bad one (`plugins/backup/commands.rs`). This
    // used to send `null` and the whole scenario failed on the arg, never
    // reaching the export it exists to test.
    { vaultId, destination },
    60_000,
  );
  const success = exported.err === undefined;
  const rec = await pageSeatInvoke(
    session,
    "plugin:backup|backup_schedule_record_result",
    { vaultId, success, writtenPath: success ? destination : null },
    20_000,
  );
  if (rec.err !== undefined) {
    throw new Error("record_result failed: " + JSON.stringify(rec.err));
  }
  // Carry the export's own error out with the verdict. Collapsing it to a bare
  // boolean is what made this scenario's failure read `expected false to be
  // true` — a message that names neither the command that failed nor why, so
  // the only way to learn anything was to re-run it by hand with a probe. The
  // backend's error IS the finding here; a scheduled backup that cannot write
  // is a data-loss-adjacent failure and deserves to say so on the first run.
  return { success, error: exported.err };
}

describeE2E("scheduled-backup (MYND-351)", () => {
  it("sb1: controls render → schedule a backup → verified .myne-backup + status success", async () => {
    // Vault-count precondition: 1 (weak KDF).
    let seeded!: SeededVault;
    await scenario(
      "sb1-happy",
      { seed: (dir) => void (seeded = seedVault(dir)) },
      async (app) => {
        const { session } = app;
        await unlockToEditor(session, seeded.password);
        await dismissImporterOffer(session);

        // Settings → Storage carries the new automatic-backup controls AND the
        // unchanged manual backup button (story 14).
        await openSettings(session, "storage");
        expect(await (await session.byTestId("settings.auto-backup")).enabled()).toBe(true);
        await session.byTestId("settings.auto-backup-toggle");
        await session.byTestId("settings.auto-backup-interval");
        await session.byTestId("settings.auto-backup-retention");
        await session.byTestId("settings.auto-backup-status");
        expect(await (await session.byTestId("settings.backup-vault")).enabled()).toBe(true);
        await closeSettings(session);

        // Configure the schedule (the folder dialog is native → write the
        // config from the page seat).
        const targetFolder = path.join(app.dataHome, "auto-backups");
        fs.mkdirSync(targetFolder, { recursive: true });
        await writeSchedule(session, seeded.vaultId, {
          enabled: true,
          interval: "every-unlock",
          targetFolder,
          retentionN: 7,
        });

        // Run the scheduler's backend exactly as it would on a due tick.
        const destination = path.join(targetFolder, "Myne backup 2026-06-18 1200.myne-backup");
        const run = await runSchedulerBackend(session, seeded.vaultId, destination);
        expect(
          run.success,
          `vault_export_backup refused the scheduled write: ${JSON.stringify(run.error)}`,
        ).toBe(true);

        // A verified .myne-backup landed, and the device-local status + ledger
        // reflect the success.
        expect(fs.existsSync(destination)).toBe(true);
        const cfg = await readSchedule(session, seeded.vaultId);
        expect(cfg.lastBackupStatus).toBe("success");
        expect(cfg.lastScheduledSuccessAt).not.toBeNull();
        expect(cfg.trackedBackups).toBe(1);
        expect(cfg.enabled).toBe(true);
      },
    );
  });

  it("sb2: a failing target records a failure and the schedule stays enabled (never silent, never auto-disabled)", async () => {
    // Vault-count precondition: 1 (weak KDF).
    let seeded!: SeededVault;
    await scenario(
      "sb2-failure",
      { seed: (dir) => void (seeded = seedVault(dir)) },
      async (app) => {
        const { session } = app;
        await unlockToEditor(session, seeded.password);
        await dismissImporterOffer(session);

        // Target whose PARENT does not exist → the export rejects with
        // InvalidDestination; the scheduler records a failure (not a crash).
        const badTarget = path.join(app.dataHome, "ghost-parent", "backups");
        const badDest = path.join(badTarget, "Myne backup 2026-06-18 1200.myne-backup");
        await writeSchedule(session, seeded.vaultId, {
          enabled: true,
          interval: "every-unlock",
          targetFolder: badTarget,
          retentionN: 7,
        });

        const ok = (await runSchedulerBackend(session, seeded.vaultId, badDest)).success;
        expect(ok).toBe(false);

        // Failure recorded; schedule stays enabled (story 9), nothing written.
        const cfg = await readSchedule(session, seeded.vaultId);
        expect(cfg.lastBackupStatus).toBe("failed");
        expect(cfg.lastBackupAttemptAt).not.toBeNull();
        expect(cfg.enabled).toBe(true); // never auto-disabled
        expect(cfg.trackedBackups).toBe(0); // nothing written → ledger empty
        expect(fs.existsSync(badDest)).toBe(false);
      },
    );
  });
});
