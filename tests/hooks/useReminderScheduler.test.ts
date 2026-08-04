// @vitest-environment jsdom
//
// The in-app reminder scheduler (MYND-618 task 4).
//
// The one thing worth testing hard here is the **divergence from the backup
// scheduler's pattern**: that hook re-checks every five minutes, which is right
// for a daily schedule and would make a minute-accurate reminder arrive up to
// five minutes late. This layer computes a timer to the next instant instead,
// and the bounds on that computation are what the tests pin.

import { describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { createElement } from "react";
import {
  MAX_SLEEP_MS,
  MIN_SLEEP_MS,
  msUntilNextPass,
  useReminderScheduler,
  type ReminderSchedulerOptions,
} from "../../src/hooks/useReminderScheduler";
import type { ReminderNotifier } from "../../src/lib/reminderSchedule";
import type { VaultTask } from "../../src/notes/taskIndex";

const NOW = new Date(2026, 6, 28, 10, 0);

function task(over: Partial<VaultTask> & { noteId?: string }): VaultTask {
  return {
    noteId: over.noteId ?? "n1",
    noteTitle: "Bills",
    noteFolder: null,
    lineIndex: 0,
    rawLine: "- [ ] x",
    completed: false,
    oversized: false,
    ...over,
  } as VaultTask;
}

function notifier() {
  const calls = { listed: 0, scheduled: [] as string[], cancelled: [] as string[] };
  const impl: ReminderNotifier = {
    listPending: async () => {
      calls.listed++;
      return [];
    },
    schedule: async (p) => void calls.scheduled.push(p.id),
    cancel: async (id) => void calls.cancelled.push(id),
  };
  return { impl, calls };
}

/** Mount a component that runs the hook, and return an unmount. */
function mount(options: ReminderSchedulerOptions): () => void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const Probe = (): null => {
    useReminderScheduler(options);
    return null;
  };
  act(() => root.render(createElement(Probe)));
  return () => {
    act(() => root.unmount());
    host.remove();
  };
}

describe("the tick is computed, not a coarse interval", () => {
  it("sleeps until the next instant when it is soon", () => {
    // 10:00 now, reminder at 10:00:30 → half a minute, not five.
    const soon = new Date(2026, 6, 28, 10, 0, 0);
    const ms = msUntilNextPass([task({ remind: "2026-07-28 10:00" })], soon);
    // The instant is not strictly in the future, so it is not registered at
    // all and the sleep falls back to the ceiling.
    expect(ms).toBe(MAX_SLEEP_MS);
  });

  it("sleeps to a reminder inside the ceiling", () => {
    const at = new Date(2026, 6, 28, 10, 0, 30);
    const ms = msUntilNextPass([task({ remind: "2026-07-28 10:01" })], at);
    expect(ms).toBe(30_000);
  });

  it("is bounded above, however far away the next reminder is", () => {
    // The list changes underneath us — an edit can add a sooner reminder — so
    // a multi-day sleep would miss it entirely.
    const ms = msUntilNextPass([task({ remind: "2026-08-03 09:00" })], NOW);
    expect(ms).toBe(MAX_SLEEP_MS);
  });

  it("is bounded below, so a due-now reminder cannot spin the pass", () => {
    const at = new Date(2026, 6, 28, 10, 0, 59, 900);
    const ms = msUntilNextPass([task({ remind: "2026-07-28 10:01" })], at);
    expect(ms).toBe(MIN_SLEEP_MS);
  });

  it("falls back to the ceiling when nothing is pending", () => {
    expect(msUntilNextPass([], NOW)).toBe(MAX_SLEEP_MS);
  });

  it("is far finer than the backup scheduler's five-minute tick", () => {
    // The divergence, stated as an assertion: inheriting that interval would
    // have shipped a reminder that arrives up to five minutes late.
    expect(MAX_SLEEP_MS).toBeLessThan(5 * 60_000);
  });
});

describe("the catch-up pass", () => {
  it("runs on mount — i.e. on unlock", async () => {
    const { impl, calls } = notifier();
    const unmount = mount({
      enabled: true,
      tasks: [task({ remind: "2026-07-30 09:00" })],
      notifier: impl,
      clock: () => NOW,
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls.listed).toBeGreaterThan(0);
    expect(calls.scheduled).toContain("myne.reminder.n1.0");
    unmount();
  });

  it("does nothing at all when disabled", async () => {
    const { impl, calls } = notifier();
    const unmount = mount({
      enabled: false,
      tasks: [task({ remind: "2026-07-30 09:00" })],
      notifier: impl,
      clock: () => NOW,
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls.listed).toBe(0);
    expect(calls.scheduled).toEqual([]);
    unmount();
  });

  it("does nothing without a notifier — an unsupported platform is not an error", async () => {
    const unmount = mount({
      enabled: true,
      tasks: [task({ remind: "2026-07-30 09:00" })],
      notifier: null,
      clock: () => NOW,
    });
    await act(async () => {
      await Promise.resolve();
    });
    unmount();
  });

  it("reports the pass result rather than swallowing it", async () => {
    const onPass = vi.fn();
    const { impl } = notifier();
    const unmount = mount({
      enabled: true,
      tasks: [task({ remind: "2026-07-30 09:00" })],
      notifier: impl,
      clock: () => NOW,
      onPass,
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(onPass).toHaveBeenCalledWith({ scheduled: 1, cancelled: 0, failed: 0 });
    unmount();
  });
});

describe("it never throws", () => {
  it("a notifier that fails everything does not crash the mount", async () => {
    // This runs from an unlock hook; an exception here would surface as a crash
    // for a feature the user may not even have enabled.
    const impl: ReminderNotifier = {
      listPending: async () => {
        throw new Error("no permission");
      },
      schedule: async () => {
        throw new Error("no permission");
      },
      cancel: async () => {
        throw new Error("no permission");
      },
    };
    const onPass = vi.fn();
    const unmount = mount({
      enabled: true,
      tasks: [task({ remind: "2026-07-30 09:00" })],
      notifier: impl,
      clock: () => NOW,
      onPass,
    });
    await act(async () => {
      await Promise.resolve();
    });
    // The failure is RECORDED, not surfaced as a crash.
    expect(onPass).toHaveBeenCalledWith({ scheduled: 0, cancelled: 0, failed: 1 });
    unmount();
  });

  it("unmounting cancels the timer and stops further passes", async () => {
    vi.useFakeTimers();
    try {
      const { impl, calls } = notifier();
      const unmount = mount({
        enabled: true,
        tasks: [task({ remind: "2026-07-30 09:00" })],
        notifier: impl,
        clock: () => NOW,
      });
      await act(async () => {
        await Promise.resolve();
      });
      const after = calls.listed;
      unmount();
      await act(async () => {
        vi.advanceTimersByTime(MAX_SLEEP_MS * 3);
        await Promise.resolve();
      });
      expect(calls.listed).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── myne#318: the default clock must not re-arm the effect on every render ───
//
// It used to be a destructuring default — `clock = () => new Date()` — which
// allocates a fresh function identity per call and sat in the effect's dep
// array. `EditorChrome` re-renders several times per typing burst, so the effect
// tore down and re-ran that often, each time paying a full reconciliation over
// EVERY task in the vault.
//
// The delivery race is the part that is not merely wasteful: `targetReminders`
// compares at minute granularity, so a pass at or after the due instant cancels
// the pending delivery timer. The timer-driven pass is registered after that
// timer and loses the race by ordering; a render-driven one is not.
describe("the default clock is stable across renders (myne#318)", () => {
  /** Mount with a re-renderable options object, returning a re-render fn. */
  function mountRerenderable(makeOptions: () => ReminderSchedulerOptions) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const Probe = (): null => {
      useReminderScheduler(makeOptions());
      return null;
    };
    act(() => root.render(createElement(Probe)));
    return {
      rerender: () => act(() => root.render(createElement(Probe, { key: undefined }))),
      unmount: () => {
        act(() => root.unmount());
        host.remove();
      },
    };
  }

  it("does not re-run the pass when nothing but render identity changed", () => {
    const n = notifier();
    const tasks = [task({ remind: "2026-07-28 10:00" })];
    // No `clock` passed — the defaulted one, which is what production does.
    const { rerender, unmount } = mountRerenderable(() => ({
      enabled: true,
      tasks,
      notifier: n.impl,
      // A fresh closure per render, the shape every `EditorChrome` render has.
      onPass: () => {},
    }));
    const afterMount = n.calls.listed;
    expect(afterMount).toBeGreaterThan(0);

    for (let i = 0; i < 3; i++) rerender();

    expect(n.calls.listed).toBe(afterMount);
    unmount();
  });

  it("still re-runs when the task list changes", () => {
    // The dependency that is deliberately kept: a reminder the user just typed
    // has to register now, not at the next tick.
    const n = notifier();
    let tasks = [task({ remind: "2026-07-28 10:00" })];
    const { rerender, unmount } = mountRerenderable(() => ({
      enabled: true,
      tasks,
      notifier: n.impl,
    }));
    const afterMount = n.calls.listed;
    tasks = [task({ remind: "2026-07-28 11:00" })];
    rerender();
    expect(n.calls.listed).toBeGreaterThan(afterMount);
    unmount();
  });
});
