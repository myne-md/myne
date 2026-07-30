// The in-app notifier (MYND-618) — the delivery half the scheduling core was
// written against and shipped without.
//
// What is worth testing hard here is not "a timer fires" but the three places
// this implementation has to agree with the shared core, because a disagreement
// is silent: replace-by-id (which `runReminderPass` relies on when it calls
// re-registration harmless), the sorted `listPending` (an unsorted one makes
// `diffReminders` report churn that is not there), and the staleness guard
// (`targetReminders` is explicit that firing late reads as the reminder being
// wrong).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInAppNotifier, DELIVERY_GRACE_MS } from "../../src/lib/reminderNotifier";
import type { ReminderPayload } from "../../src/lib/reminderSchedule";

const NOW = new Date(2026, 6, 28, 10, 0);

/** `at` values are local wall-clock, so build them the same way. */
function at(hh: number, mm = 0): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `2026-07-28T${p(hh)}:${p(mm)}`;
}

let clockNow: Date;
const clock = (): Date => clockNow;

beforeEach(() => {
  clockNow = new Date(NOW);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

describe("createInAppNotifier", () => {
  it("delivers when the instant arrives, and only then", () => {
    const deliver = vi.fn<(p: ReminderPayload) => void>();
    const n = createInAppNotifier({ deliver, clock });

    void n.schedule({ id: "a", at: at(10, 5) });
    expect(deliver).not.toHaveBeenCalled();

    clockNow = new Date(2026, 6, 28, 10, 5);
    vi.advanceTimersByTime(5 * 60_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]![0]!.id).toBe("a");
  });

  it("drops a pending registration once delivered", async () => {
    const n = createInAppNotifier({ deliver: () => {}, clock });
    void n.schedule({ id: "a", at: at(10, 5) });
    expect(await n.listPending()).toHaveLength(1);

    clockNow = new Date(2026, 6, 28, 10, 5);
    vi.advanceTimersByTime(5 * 60_000);
    expect(await n.listPending()).toHaveLength(0);
  });

  it("replaces by id rather than stacking a second timer", async () => {
    // `runReminderPass` calls re-registering something already registered
    // harmless because "the OS replaces by id". A stacking implementation would
    // fire twice for a moved reminder — the duplicate a user actually notices.
    const deliver = vi.fn<(p: ReminderPayload) => void>();
    const n = createInAppNotifier({ deliver, clock });

    void n.schedule({ id: "a", at: at(10, 5) });
    void n.schedule({ id: "a", at: at(10, 9) });
    expect(await n.listPending()).toEqual([{ id: "a", at: at(10, 9) }]);

    clockNow = new Date(2026, 6, 28, 10, 5);
    vi.advanceTimersByTime(5 * 60_000);
    expect(deliver).not.toHaveBeenCalled(); // the 10:05 timer was cancelled

    clockNow = new Date(2026, 6, 28, 10, 9);
    vi.advanceTimersByTime(4 * 60_000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("cancels without delivering", () => {
    const deliver = vi.fn();
    const n = createInAppNotifier({ deliver, clock });
    void n.schedule({ id: "a", at: at(10, 5) });
    void n.cancel("a");

    clockNow = new Date(2026, 6, 28, 10, 5);
    vi.advanceTimersByTime(5 * 60_000);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("cancelling an unknown id is a no-op, not a throw", async () => {
    const n = createInAppNotifier({ deliver: () => {}, clock });
    await expect(n.cancel("never-registered")).resolves.toBeUndefined();
  });

  it("lists pending sorted by id, so a diff sees no phantom churn", async () => {
    const n = createInAppNotifier({ deliver: () => {}, clock });
    void n.schedule({ id: "c", at: at(11) });
    void n.schedule({ id: "a", at: at(12) });
    void n.schedule({ id: "b", at: at(13) });

    expect((await n.listPending()).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("delivers a just-passed instant immediately", () => {
    // The pass excludes past instants, but the moment can pass between the
    // target computation and the schedule call.
    const deliver = vi.fn();
    const n = createInAppNotifier({ deliver, clock });
    void n.schedule({ id: "a", at: at(9, 59) });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("refuses to fire an instant that is stale beyond the grace window", () => {
    // A machine that slept through the instant wakes with an overdue timer.
    // `targetReminders`: "firing late is worse than not firing, because it reads
    // as the reminder being wrong."
    const deliver = vi.fn();
    const n = createInAppNotifier({ deliver, clock });
    void n.schedule({ id: "a", at: at(8, 0) }); // two hours ago
    expect(deliver).not.toHaveBeenCalled();
  });

  it("still fires one that is late but inside the grace window", () => {
    const deliver = vi.fn();
    const n = createInAppNotifier({ deliver, clock });
    const lateBy = DELIVERY_GRACE_MS - 1_000;
    clockNow = new Date(NOW.getTime() + lateBy);
    void n.schedule({ id: "a", at: at(10, 0) });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("dispose drops every timer without delivering", async () => {
    // The lock path calls this: an in-app reminder has nowhere to appear once the
    // workspace is unmounted, and a surviving timer would fire into a locked app.
    const deliver = vi.fn();
    const n = createInAppNotifier({ deliver, clock });
    void n.schedule({ id: "a", at: at(10, 5) });
    void n.schedule({ id: "b", at: at(10, 6) });

    n.dispose();
    expect(await n.listPending()).toHaveLength(0);

    clockNow = new Date(2026, 6, 28, 10, 10);
    vi.advanceTimersByTime(10 * 60_000);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("hands the delivery callback the registration and nothing else", () => {
    // The payload is `{id, at}` by design, so there is no task text here to leak
    // even by accident.
    const deliver = vi.fn<(p: ReminderPayload) => void>();
    const n = createInAppNotifier({ deliver, clock });
    void n.schedule({ id: "a", at: at(9, 59) });
    expect(Object.keys(deliver.mock.calls[0]![0]!).sort()).toEqual(["at", "id"]);
  });
});
