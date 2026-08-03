// @vitest-environment jsdom
//
// The automatic-backup scheduler, per platform (phase3-web-client task 96).
//
// `Editor.tsx` mounts this hook unconditionally, and the Editor is mounted for
// the whole unlocked session. On a client where `backup` is absent that made it
// a five-minute timer calling `vault_list` and
// `plugin:backup|backup_schedule_read` forever — every call answered
// `Unsupported`, every failure swallowed by the engine's own catch. Invisible,
// permanent, and pointless.
//
// The assertion that matters is the NEGATIVE one, and it has to be made against
// the real hook rather than the engine: the engine was always well-behaved. It
// was the mounting that was wrong.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const scheduleRead = vi.fn(async () => ({ enabled: false }));
const runScheduledBackupIfDue = vi.fn(async () => "skipped");

vi.mock("../../src/lib/backup-schedule", () => ({
  scheduleRead: () => scheduleRead(),
  runScheduledBackupIfDue: (...a: unknown[]) => runScheduledBackupIfDue(...(a as [])),
  scheduleRecordResult: vi.fn(async () => {}),
  shouldToastOutcome: () => false,
}));
vi.mock("../../src/lib/vault-backup", () => ({
  backupDefaultFilename: () => "b.myne-backup",
  exportBackup: vi.fn(async () => {}),
}));
vi.mock("../../src/platform/path", () => ({ join: async (...p: string[]) => p.join("/") }));

async function mountWith(absent: string[], vaultId: string | null = "v1") {
  vi.resetModules();
  vi.doMock("../../src/platform/capabilities", () => ({
    has: (cap: string) => !absent.includes(cap),
  }));
  const { useBackupScheduler } = await import("../../src/hooks/useBackupScheduler");
  return renderHook(() => useBackupScheduler(vaultId));
}

beforeEach(() => {
  vi.useFakeTimers();
  runScheduledBackupIfDue.mockClear();
  scheduleRead.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useBackupScheduler", () => {
  it("issues NOTHING on a client with no backup capability", async () => {
    await mountWith(["backup"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(runScheduledBackupIfDue).not.toHaveBeenCalled();

    // …and not on the next tick either. The failure being prevented is a loop,
    // so one quiet render proves nothing.
    await vi.advanceTimersByTimeAsync(5 * 60_000 * 3);
    expect(runScheduledBackupIfDue).not.toHaveBeenCalled();
    expect(scheduleRead).not.toHaveBeenCalled();
  });

  it("still runs its catch-up pass where backup exists", async () => {
    // The desktop half, asserted so the gate cannot be "fixed" by disabling the
    // feature everywhere.
    await mountWith([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(runScheduledBackupIfDue).toHaveBeenCalled();
  });

  // #250: the hook no longer resolves its own target. An unresolved id means
  // the caller does not yet know which vault is open — and a scheduled export
  // aimed at a guess is how the scheduler backed up the wrong vault after a
  // quick-unlock. No target, no tick.
  it("does not arm until it is given a vault to back up", async () => {
    await mountWith([], null);
    await vi.advanceTimersByTimeAsync(0);
    expect(runScheduledBackupIfDue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5 * 60_000 * 3);
    expect(runScheduledBackupIfDue).not.toHaveBeenCalled();
  });

  it("backs up exactly the vault it was given", async () => {
    await mountWith([], "v-explicit");
    await vi.advanceTimersByTimeAsync(0);
    expect(runScheduledBackupIfDue).toHaveBeenCalled();
    expect(runScheduledBackupIfDue.mock.calls[0]?.[0]).toBe("v-explicit");
  });
});
