// Pure scheduling-core + orchestrator tests for the automatic-backup engine
// (MYND-351 task 3). The elapsed-check and `runScheduledBackupIfDue` are pure /
// dependency-injected, so every branch runs without Tauri. The React glue
// (`useBackupScheduler`) and the real Rust IPC are out of scope here — E2E
// (task 8) covers the wired behavior end-to-end.

import { describe, expect, it, vi } from "vitest";
import {
  FAILED_RETRY_FLOOR_MS,
  intervalMs,
  isBackupDue,
  runScheduledBackupIfDue,
  shouldToastOutcome,
  type ScheduleConfig,
  type ScheduleEngineDeps,
} from "../../src/lib/backup-schedule";

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const NOW = new Date("2026-06-18T12:00:00.000Z");
const NOW_MS = NOW.getTime();
/** When this unlocked session began. `every-unlock` means once per session, so
 *  the due-check needs a session marker (myne#316) — an hour ago here, so a
 *  success stamped before it counts as "a previous session". */
const SESSION_START_MS = NOW_MS - 60 * 60_000;

function config(overrides: Partial<ScheduleConfig> = {}): ScheduleConfig {
  return {
    enabled: true,
    interval: "daily",
    targetFolder: "/Users/me/Backups",
    retentionN: 7,
    lastScheduledSuccessAt: null,
    lastBackupAttemptAt: null,
    lastBackupStatus: "never",
    trackedBackups: 0,
    ...overrides,
  };
}

describe("intervalMs", () => {
  it("maps each preset", () => {
    expect(intervalMs("every-unlock")).toBe(0);
    expect(intervalMs("daily")).toBe(DAY_MS);
    expect(intervalMs("weekly")).toBe(WEEK_MS);
  });
});

describe("isBackupDue", () => {
  it("is due when never run (and enabled + targeted)", () => {
    expect(isBackupDue(config({ lastScheduledSuccessAt: null }), NOW_MS, SESSION_START_MS)).toBe(true);
  });

  it("is not due when disabled", () => {
    expect(isBackupDue(config({ enabled: false }), NOW_MS, SESSION_START_MS)).toBe(false);
  });

  it("is not due with no target folder", () => {
    expect(isBackupDue(config({ targetFolder: null }), NOW_MS, SESSION_START_MS)).toBe(false);
    expect(isBackupDue(config({ targetFolder: "" }), NOW_MS, SESSION_START_MS)).toBe(false);
  });

  it("daily: due exactly at the 24h boundary, not a millisecond before", () => {
    const justUnder = config({ lastScheduledSuccessAt: NOW_MS - DAY_MS + 1 });
    const exactly = config({ lastScheduledSuccessAt: NOW_MS - DAY_MS });
    expect(isBackupDue(justUnder, NOW_MS)).toBe(false);
    expect(isBackupDue(exactly, NOW_MS)).toBe(true);
  });

  it("weekly: due exactly at the 7d boundary, not before", () => {
    expect(isBackupDue(config({ interval: "weekly", lastScheduledSuccessAt: NOW_MS - WEEK_MS + 1 }), NOW_MS, SESSION_START_MS)).toBe(false);
    expect(isBackupDue(config({ interval: "weekly", lastScheduledSuccessAt: NOW_MS - WEEK_MS }), NOW_MS, SESSION_START_MS)).toBe(true);
  });

  // myne#316 — `every-unlock` means once per unlocked SESSION.
  //
  // Its interval is zero, and the due-check was `now - lastSuccess >= interval`,
  // which is unconditionally true. So a user who asked for one backup per
  // session got one every 5 minutes, and the keep-last-N pruner then deleted
  // real files from their backup folder until the retained window was the last
  // ~35 minutes — the folder still showing N files, the status still "success".
  it("every-unlock: due once per session, not on every evaluation", () => {
    // A success from a PREVIOUS session (before this unlock) → due.
    expect(
      isBackupDue(
        config({ interval: "every-unlock", lastScheduledSuccessAt: SESSION_START_MS - 1 }),
        NOW_MS,
        SESSION_START_MS,
      ),
    ).toBe(true);
    // A success from THIS session → not due again, however long the session runs.
    expect(
      isBackupDue(
        config({ interval: "every-unlock", lastScheduledSuccessAt: SESSION_START_MS + 1 }),
        NOW_MS,
        SESSION_START_MS,
      ),
    ).toBe(false);
    // Never run → due.
    expect(
      isBackupDue(
        config({ interval: "every-unlock", lastScheduledSuccessAt: null }),
        NOW_MS,
        SESSION_START_MS,
      ),
    ).toBe(true);
  });

  // myne#317 — a failed attempt backs off; it does not retry on the next tick.
  //
  // `record_failure` stamps the attempt clock and leaves the success clock
  // alone, and the due-check consulted only the success clock — so a "Daily"
  // schedule attempted a full vault export 288 times a day against a failing
  // target, each attempt taking the capacity-1 auth permit and quiescing note
  // writers. The user saw one toast; the loop was invisible.
  describe("after a failure", () => {
    const failed = (over: Partial<ScheduleConfig> = {}) =>
      config({
        lastBackupStatus: "failed",
        lastBackupAttemptAt: NOW_MS - 5 * 60_000, // one tick ago
        lastScheduledSuccessAt: NOW_MS - 2 * DAY_MS, // long overdue on its own
        ...over,
      });

    it("is not due again on the next 5-minute tick", () => {
      expect(isBackupDue(failed(), NOW_MS, SESSION_START_MS)).toBe(false);
    });

    it("is due again once the configured cadence has elapsed", () => {
      expect(
        isBackupDue(
          failed({ lastBackupAttemptAt: NOW_MS - DAY_MS }),
          NOW_MS,
          SESSION_START_MS,
        ),
      ).toBe(true);
    });

    it("floors the backoff for every-unlock, whose interval is zero", () => {
      const base = failed({ interval: "every-unlock", lastScheduledSuccessAt: null });
      expect(isBackupDue(base, NOW_MS, SESSION_START_MS)).toBe(false);
      expect(
        isBackupDue(
          { ...base, lastBackupAttemptAt: NOW_MS - FAILED_RETRY_FLOOR_MS },
          NOW_MS,
          SESSION_START_MS,
        ),
      ).toBe(true);
    });

    it("does not back off after a SUCCESS", () => {
      // The backoff keys on the recorded status, not on the attempt clock
      // alone — a successful attempt a minute ago must not block a due weekly.
      expect(
        isBackupDue(
          config({
            interval: "weekly",
            lastBackupStatus: "success",
            lastBackupAttemptAt: NOW_MS - 60_000,
            lastScheduledSuccessAt: NOW_MS - WEEK_MS,
          }),
          NOW_MS,
          SESSION_START_MS,
        ),
      ).toBe(true);
    });
  });
});

describe("runScheduledBackupIfDue", () => {
  function deps(config: ScheduleConfig, exportImpl?: () => Promise<unknown>): {
    deps: ScheduleEngineDeps;
    calls: {
      exportBackup: ReturnType<typeof vi.fn>;
      recordResult: ReturnType<typeof vi.fn>;
    };
  } {
    const exportBackup = vi.fn(exportImpl ?? (() => Promise.resolve({ members: 3 })));
    const recordResult = vi.fn(() => Promise.resolve());
    return {
      deps: {
        readConfig: () => Promise.resolve(config),
        defaultFilename: () => Promise.resolve("Myne backup 2026-06-18 1200.myne-backup"),
        exportBackup,
        recordResult,
        joinPath: (folder, name) => Promise.resolve(`${folder}/${name}`),
      },
      calls: { exportBackup, recordResult },
    };
  }

  it("backs up and records success when due (catch-up on unlock)", async () => {
    // Overdue daily schedule — the unlock-time evaluation runs the backup.
    const cfg = config({ lastScheduledSuccessAt: NOW_MS - 2 * DAY_MS });
    const { deps: d, calls } = deps(cfg);
    const outcome = await runScheduledBackupIfDue("vault-1", NOW, d, SESSION_START_MS);
    expect(outcome).toBe("backed-up");
    expect(calls.exportBackup).toHaveBeenCalledWith(
      "/Users/me/Backups/Myne backup 2026-06-18 1200.myne-backup",
      "vault-1",
    );
    expect(calls.recordResult).toHaveBeenCalledWith(
      "vault-1",
      true,
      "/Users/me/Backups/Myne backup 2026-06-18 1200.myne-backup",
    );
  });

  it("backs up a never-run schedule", async () => {
    const { deps: d, calls } = deps(config({ lastScheduledSuccessAt: null }));
    expect(await runScheduledBackupIfDue("v", NOW, d, SESSION_START_MS)).toBe("backed-up");
    expect(calls.exportBackup).toHaveBeenCalledOnce();
  });

  it("does not fire when not due", async () => {
    const cfg = config({ lastScheduledSuccessAt: NOW_MS - 60_000 }); // 1 min ago, daily
    const { deps: d, calls } = deps(cfg);
    expect(await runScheduledBackupIfDue("v", NOW, d, SESSION_START_MS)).toBe("not-due");
    expect(calls.exportBackup).not.toHaveBeenCalled();
    expect(calls.recordResult).not.toHaveBeenCalled();
  });

  it("does not fire when disabled", async () => {
    const { deps: d, calls } = deps(config({ enabled: false }));
    expect(await runScheduledBackupIfDue("v", NOW, d, SESSION_START_MS)).toBe("disabled");
    expect(calls.exportBackup).not.toHaveBeenCalled();
  });

  it("does not fire with no target folder", async () => {
    const { deps: d, calls } = deps(config({ targetFolder: null }));
    expect(await runScheduledBackupIfDue("v", NOW, d, SESSION_START_MS)).toBe("no-target");
    expect(calls.exportBackup).not.toHaveBeenCalled();
  });

  it("records a failure (and never throws) when the export rejects", async () => {
    const { deps: d, calls } = deps(
      config({ lastScheduledSuccessAt: null }),
      () => Promise.reject(new Error("target gone")),
    );
    const outcome = await runScheduledBackupIfDue("v", NOW, d, SESSION_START_MS);
    expect(outcome).toBe("failed");
    expect(calls.recordResult).toHaveBeenCalledWith("v", false);
  });

  it("skips (not fails) when a user auth op held the permit — Direction 1", async () => {
    // The export rejects with the reject-never-queue permit error; that is a
    // transient skip, not a backup failure — status must NOT flip to Failed.
    const { deps: d, calls } = deps(config({ lastScheduledSuccessAt: null }), () =>
      Promise.reject({ kind: "AuthOperationInProgress" }),
    );
    const outcome = await runScheduledBackupIfDue("v", NOW, d, SESSION_START_MS);
    expect(outcome).toBe("skipped");
    expect(calls.recordResult).not.toHaveBeenCalled();
  });

  it("skips when a user auth op preempted the run mid-flight (Cancelled)", async () => {
    const { deps: d, calls } = deps(config({ lastScheduledSuccessAt: null }), () =>
      Promise.reject({ kind: "Cancelled" }),
    );
    expect(await runScheduledBackupIfDue("v", NOW, d, SESSION_START_MS)).toBe("skipped");
    expect(calls.recordResult).not.toHaveBeenCalled();
  });
});

describe("shouldToastOutcome (failure-toast debounce)", () => {
  it("toasts the first failure", () => {
    expect(shouldToastOutcome(null, "failed")).toBe(true);
    expect(shouldToastOutcome("backed-up", "failed")).toBe(true);
    expect(shouldToastOutcome("skipped", "failed")).toBe(true);
  });

  it("does NOT re-toast a persistent failure", () => {
    expect(shouldToastOutcome("failed", "failed")).toBe(false);
  });

  it("re-toasts a failure after a recovery in between", () => {
    // failed → backed-up → failed: the second failure is fresh again.
    expect(shouldToastOutcome("backed-up", "failed")).toBe(true);
  });

  it("never toasts a non-failure outcome", () => {
    for (const curr of ["backed-up", "skipped", "not-due", "disabled", "no-target"] as const) {
      expect(shouldToastOutcome("failed", curr)).toBe(false);
      expect(shouldToastOutcome(null, curr)).toBe(false);
    }
  });
});
