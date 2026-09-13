// @vitest-environment jsdom
//
// The task panel's "today" follows the day — myne-md/myne#557, the `tasks.panel`
// bullet.
//
// The bullet named a defect rather than a check: `TasksPane` resolved the
// current civil date with `useMemo(() => todayLocal(new Date(), zone), [zone])`,
// which re-runs when the ZONE changes and at no other time. A window left open
// across midnight therefore kept yesterday's date: the Today filter listed
// yesterday's tasks, Overdue stayed one short, and nothing on screen said so.
//
// It is the shape of bug a once-a-release hand-walk structurally cannot find —
// the reviewer opens the app and checks the buckets within a minute of opening
// it, so the stale-date window never opens. Fake timers reach it in
// milliseconds.
//
// Fixed in the same change (`src/notes/useLocalToday.ts`) rather than recorded
// as a failing test: a red test pays no roster row, and the roster row exists
// because the buckets are wrong, not because nobody looked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";

import { msUntilNextLocalMidnight, useLocalToday } from "../../src/notes/useLocalToday";

// ── the pure half: when is the next midnight ────────────────────────────────

describe("msUntilNextLocalMidnight", () => {
  it("is a whole day plus the margin at exactly midnight", () => {
    // 2026-03-10T00:00:00Z, read in UTC.
    const at = new Date(Date.UTC(2026, 2, 10, 0, 0, 0, 0));
    expect(msUntilNextLocalMidnight(at, "UTC")).toBe(86_400_000 + 1_000);
  });

  it("shrinks as the day advances", () => {
    const morning = new Date(Date.UTC(2026, 2, 10, 6, 0, 0, 0));
    const evening = new Date(Date.UTC(2026, 2, 10, 22, 0, 0, 0));
    expect(msUntilNextLocalMidnight(morning, "UTC")).toBe(18 * 3_600_000 + 1_000);
    expect(msUntilNextLocalMidnight(evening, "UTC")).toBe(2 * 3_600_000 + 1_000);
  });

  it("answers in the DISPLAY zone, not the machine's", () => {
    // 12:00 UTC is 21:00 in Tokyo and 04:00 in Los Angeles. A single instant
    // must therefore be three hours from midnight in one zone and twenty in
    // the other — the whole reason the zone is a parameter.
    const at = new Date(Date.UTC(2026, 2, 10, 12, 0, 0, 0));
    expect(msUntilNextLocalMidnight(at, "Asia/Tokyo")).toBe(3 * 3_600_000 + 1_000);
    // Los Angeles is on PDT by 2026-03-10 (US DST began on the 8th), so 12:00
    // UTC is 05:00 there — nineteen hours, not twenty. Pinning the DST-correct
    // number rather than the naive winter offset is the point: an arithmetic
    // shortcut that ignored the transition would answer twenty.
    expect(msUntilNextLocalMidnight(at, "America/Los_Angeles")).toBe(
      19 * 3_600_000 + 1_000,
    );
  });

  it("never returns a non-positive delay, on any hour of any zone", () => {
    // A zero or negative delay would spin `setTimeout` at full speed. Sweeping
    // every hour across a DST-transition day in a zone that observes one is the
    // case an arithmetic shortcut gets wrong.
    for (const zone of ["UTC", "Europe/Berlin", "Australia/Lord_Howe", "Asia/Kathmandu"]) {
      for (let h = 0; h < 24; h++) {
        for (const day of [8, 9, 29, 30]) {
          const at = new Date(Date.UTC(2026, 2, day, h, 30, 0, 0));
          const d = msUntilNextLocalMidnight(at, zone);
          expect(d, `${zone} at ${at.toISOString()}`).toBeGreaterThan(0);
          expect(d, `${zone} at ${at.toISOString()}`).toBeLessThanOrEqual(
            86_400_000 + 1_000,
          );
        }
      }
    }
  });

  it("falls back to the machine's calendar for a zone ICU does not know", () => {
    // The pref carries a free string. "What time is it" may not throw.
    const at = new Date(Date.UTC(2026, 2, 10, 12, 0, 0, 0));
    expect(() => msUntilNextLocalMidnight(at, "Middle/Earth")).not.toThrow();
    expect(msUntilNextLocalMidnight(at, "Middle/Earth")).toBeGreaterThan(0);
  });
});

// ── the hook: the value changes when the day does ───────────────────────────

describe("useLocalToday", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("rolls over to the new date when local midnight passes", () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 10, 23, 58, 0, 0)));
    const { result } = renderHook(() => useLocalToday("UTC"));
    expect(result.current).toBe("2026-03-10");

    act(() => {
      vi.advanceTimersByTime(3 * 60_000); // 23:58 -> 00:01
    });
    expect(
      result.current,
      "the panel kept yesterday's date across midnight — the Today filter " +
        "would list yesterday's tasks and Overdue would stay one short",
    ).toBe("2026-03-11");
  });

  it("keeps rolling on the SECOND midnight, not just the first", () => {
    // A one-shot timer passes the test above and then never fires again, which
    // is the same bug one day later.
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 10, 23, 59, 0, 0)));
    const { result } = renderHook(() => useLocalToday("UTC"));
    act(() => {
      vi.advanceTimersByTime(2 * 60_000);
    });
    expect(result.current).toBe("2026-03-11");
    act(() => {
      vi.advanceTimersByTime(24 * 3_600_000);
    });
    expect(result.current).toBe("2026-03-12");
  });

  it("does not roll over early", () => {
    // The margin exists so a hair-early delivery cannot resolve to yesterday;
    // it must not cost a whole extra day either.
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 10, 12, 0, 0, 0)));
    const { result } = renderHook(() => useLocalToday("UTC"));
    act(() => {
      vi.advanceTimersByTime(11 * 3_600_000 + 59 * 60_000);
    });
    expect(result.current).toBe("2026-03-10");
  });

  it("rolls over on the DISPLAY zone's midnight, not the machine's", () => {
    // The machine is at 2026-03-10T14:00Z, which is 23:00 on the 10th in
    // Tokyo: an hour from Tokyo's midnight and ten from UTC's. A hook that
    // rolled on the machine's midnight would still read 03-10 after that hour.
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 10, 14, 0, 0, 0)));
    const { result } = renderHook(() => useLocalToday("Asia/Tokyo"));
    expect(result.current).toBe("2026-03-10");
    act(() => {
      vi.advanceTimersByTime(61 * 60_000);
    });
    expect(result.current).toBe("2026-03-11");
  });

  it("re-resolves immediately when the display zone changes", () => {
    // 2026-03-10T20:00Z is still the 10th in UTC and already the 11th in
    // Tokyo, so the switch has to move the value the moment it happens.
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 10, 20, 0, 0, 0)));
    const { result, rerender } = renderHook(({ zone }) => useLocalToday(zone), {
      initialProps: { zone: "UTC" as string },
    });
    expect(result.current).toBe("2026-03-10");
    rerender({ zone: "Asia/Tokyo" });
    // Not "at the next midnight in the new zone", which could be a day away.
    expect(result.current).toBe("2026-03-11");
  });

  it("re-resolves when the document becomes visible again", () => {
    // A background tab's timers are throttled to almost nothing and a suspended
    // laptop runs none, so the midnight timer can fire hours late. The user is
    // looking at the panel the moment the tab comes back.
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 10, 23, 59, 0, 0)));
    const { result } = renderHook(() => useLocalToday("UTC"));
    expect(result.current).toBe("2026-03-10");

    // Move the clock without letting the timer run, which is what a throttled
    // or suspended host does.
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 11, 9, 0, 0, 0)));
    expect(result.current).toBe("2026-03-10");

    act(() => {
      Object.defineProperty(document, "visibilityState", {
        value: "visible",
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(result.current).toBe("2026-03-11");
  });

  it("stops its timer on unmount", () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 10, 23, 59, 0, 0)));
    const { unmount } = renderHook(() => useLocalToday("UTC"));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount(), "the midnight timer outlived the panel").toBe(0);
  });
});

// ── the surface: the panel's buckets move with it ───────────────────────────

const tasks = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock("../../src/notes/taskIndex", () => ({
  useLiveVaultTasks: () => tasks.value,
}));
vi.mock("../../src/notes/workspaceContext", () => ({
  useWorkspace: () => ({
    setTaskViewState: vi.fn(),
    // Container-level view, narrowed to the due-today window.
    taskView: {
      status: "undone",
      due: "today",
      folders: [],
      noteId: null,
      tags: [],
      priority: "any",
      sort: "due",
    },
    flushAll: vi.fn(),
    openInFocused: vi.fn(),
  }),
}));
vi.mock("../../src/notes/sidebarState", () => ({
  useSelectedNote: () => ({ selectedId: null }),
}));
const displayZone = vi.hoisted(() => ({ value: "UTC" as string | null }));
vi.mock("../../src/lib/useDateTimeDisplay", () => ({
  useDateTimeDisplay: () => ({ timeZone: displayZone.value }),
}));

describe("TasksPane's Today bucket follows the day", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    displayZone.value = "UTC";
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("moves a task out of Today when the day rolls over", async () => {
    // One task due 2026-03-10. At 23:58 on the 10th it is due TODAY; two
    // minutes later it is OVERDUE, and the panel has to say so without anybody
    // touching it.
    tasks.value = [
      {
        noteId: "n1",
        noteTitle: "Bills",
        noteFolder: null,
        lineIndex: 0,
        rawLine: "- [ ] ship the thing",
        completed: false,
        oversized: false,
        due: "2026-03-10",
      },
    ];
    vi.setSystemTime(new Date(Date.UTC(2026, 2, 10, 23, 58, 0, 0)));

    const { TasksPane } = await import("../../src/notes/components/TasksPane");
    render(
      <TasksPane
        paneId={"p1" as never}
        // Narrowed to the due-today window; the section model applies on top.
        item={{ kind: "tasks", taskView: { due: "today" } } as never}
      />,
    );

    // Due today: the row is listed.
    expect(screen.queryByText("ship the thing")).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(3 * 60_000);
    });

    // Past midnight it is no longer due today, so the due-today view drops it.
    expect(
      screen.queryByText("ship the thing"),
      "the due-today view still lists yesterday's task after midnight",
    ).toBeNull();
  });
});
