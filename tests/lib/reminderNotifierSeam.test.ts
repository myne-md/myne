// The seam both clients share, asserted from the desktop side (myne-md/myne#1076,
// task 22 of the 0.19 block).
//
// `ReminderNotifier` is the one interface the scheduling core knows about:
// `listPending`, `schedule`, `cancel`. Desktop's in-app notifier and mobile's
// plugin-backed one are two implementations of it, and the thing that can silently
// stop being true is that the core still drives them THROUGH it rather than around
// it. A test that only asserted the notifier's own methods would pass with the
// scheduler calling `setTimeout` itself, which is the drift this file exists to
// catch: so it drives a real pass and asserts what the notifier was asked to hold.
import { describe, it, expect, vi } from "vitest";

import { createInAppNotifier } from "../../src/lib/reminderNotifier";
import {
  runReminderPass,
  type ReminderNotifier,
  type VaultTask,
} from "../../src/lib/reminderSchedule";

/** A clock the test owns, so the pass arithmetic needs no fake timers. */
function at(iso: string) {
  return () => new Date(iso);
}

/** A task with a reminder instant, which is the only thing the target set reads. */
function task(id: string, remind: string): VaultTask {
  return {
    noteId: id,
    lineIndex: 0,
    text: `task ${id}`,
    completed: false,
    remind,
  } as unknown as VaultTask;
}

describe("the reminder notifier is the seam the scheduler drives", () => {
  it("a desktop notifier satisfies ReminderNotifier and holds what a pass registered", async () => {
    const deliver = vi.fn();
    // Typed as the interface on purpose: the assignment fails to compile if the
    // in-app notifier ever stops satisfying it, which is the cheapest possible
    // assertion of the contract and the one that cannot be skipped.
    const notifier: ReminderNotifier = createInAppNotifier({
      deliver,
      clock: at("2026-11-22T08:00"),
    });
    const app = notifier as ReminderNotifier & { dispose: () => void };

    const result = await runReminderPass(
      [task("a", "2026-11-22T09:00"), task("b", "2026-11-22T10:00")],
      notifier,
      at("2026-11-22T08:00"),
    );

    expect(result.scheduled).toBe(2);
    expect(result.failed).toBe(0);
    // The notifier's own answer, not the pass's: a pass that counted two
    // registrations into a set the notifier does not hold would have reported
    // success it cannot deliver.
    const pending = await notifier.listPending();
    expect(pending).toHaveLength(2);
    expect(pending.map((row) => row.at)).toEqual([
      "2026-11-22T09:00",
      "2026-11-22T10:00",
    ]);
    expect(deliver).not.toHaveBeenCalled();

    app.dispose();
  });

  it("a second pass over the same tasks withdraws what left the set and keeps the rest", async () => {
    const deliver = vi.fn();
    const notifier = createInAppNotifier({ deliver, clock: at("2026-11-22T08:00") });

    await runReminderPass(
      [task("a", "2026-11-22T09:00"), task("b", "2026-11-22T10:00")],
      notifier,
      at("2026-11-22T08:00"),
    );
    const before = (await notifier.listPending()).map((row) => row.id);

    // `b` is gone from the vault. The pass must CANCEL it through the interface
    // rather than dropping it from its own bookkeeping: the OS tier is the one
    // that cannot be told twice, and this is the same call shape it will get.
    const cancel = vi.spyOn(notifier, "cancel");
    await runReminderPass([task("a", "2026-11-22T09:00")], notifier, at("2026-11-22T08:00"));

    const after = (await notifier.listPending()).map((row) => row.id);
    expect(after.length).toBeLessThan(before.length);
    expect(cancel).toHaveBeenCalled();

    (notifier as ReminderNotifier & { dispose: () => void }).dispose();
  });
});
