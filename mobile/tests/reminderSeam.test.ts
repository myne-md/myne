// The seam, asserted from the mobile side (myne-md/myne#1076, task 22 of the 0.19
// block).
//
// Mobile's notifier is the plugin-backed one and desktop's keeps its set in memory,
// and the two are the SAME interface rather than two that resemble each other:
// `mobile/src/lib/reminders.ts` imports `ReminderNotifier` from the shared schedule
// module instead of restating it. What can silently stop being true is that the
// bounded pass still drives the notifier THROUGH that interface, so this file runs a
// real pass against the plugin-backed notifier and asserts what the plugin was told.
//
// The IPC mock is the same shape `reminders.test.ts` uses, because the point here is
// the pass and not the wire contract that file already pins.
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn(async () => [] as unknown);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

let hasTauri = true;
vi.mock("../src/lib/app-window", () => ({
  get HAS_TAURI() {
    return hasTauri;
  },
}));

import { createReminderNotifier } from "../src/lib/reminders";
import { runBoundedReminderPass } from "../src/lib/reminderPass";
import type { ReminderNotifier, VaultTask } from "@myne/reminder-schedule";

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

const clock = () => new Date("2026-11-22T08:00");

beforeEach(() => {
  invoke.mockClear();
  hasTauri = true;
});

describe("the mobile notifier is the seam the bounded pass drives", () => {
  it("satisfies ReminderNotifier and registers through the plugin", async () => {
    // Typed as the interface on purpose: this assignment fails to compile if the
    // plugin-backed notifier ever stops satisfying the shared shape.
    const notifier: ReminderNotifier = createReminderNotifier();

    const result = await runBoundedReminderPass({
      tasks: [task("a", "2026-11-22T09:00"), task("b", "2026-11-22T10:00")],
      notifier,
      clock,
    });

    expect(result.scheduled).toBe(2);
    expect(result.failed).toBe(0);
    const calls = invoke.mock.calls as unknown as [string, unknown][];
    const scheduled = calls.filter(([command]) => command === "plugin:reminders|schedule");
    expect(scheduled).toHaveLength(2);
    expect(scheduled[0][1]).toEqual({ reminder: { id: expect.any(String), at: "2026-11-22T09:00" } });
  });

  it("the platform ceiling is applied before anything is registered", async () => {
    // The bound is the reason mobile has its own pass at all: the strictest
    // platform drops what it cannot hold, silently, so the pass must never hand it
    // more than the ceiling. A `max` of one proves the narrowing reaches the
    // plugin rather than being counted and ignored.
    const notifier = createReminderNotifier();
    await runBoundedReminderPass({
      tasks: [
        task("a", "2026-11-22T09:00"),
        task("b", "2026-11-22T10:00"),
        task("c", "2026-11-22T11:00"),
      ],
      notifier,
      clock,
      max: 1,
    });

    const calls = invoke.mock.calls as unknown as [string, unknown][];
    const scheduled = calls.filter(([command]) => command === "plugin:reminders|schedule");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0][1]).toEqual({ reminder: { id: expect.any(String), at: "2026-11-22T09:00" } });
  });
});
