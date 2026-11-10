// @vitest-environment jsdom
//
// The second clock ON THE CALENDAR (decisions/storage/0797): an event's stored time
// is a wall clock, and the home zone adds a second reading beside it.
//
// Two failures are what this file exists for, and neither is visible in a planner
// test. The first is that the preference was read once, during render, so writing it
// in Settings left every open calendar showing one clock until something else
// re-rendered it. The second is that the reading was appended INSIDE the clock line,
// which a block in a week column is too narrow to hold, so it was cut mid-string by
// the block's own `overflow: hidden`.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

let rangeRows: unknown[] = [];

const standup = {
  noteId: "n1",
  title: "Standup",
  folder: "Calendar/",
  calendar: "Work",
  start: "2026-11-05 09:00",
  end: "2026-11-05 09:30",
  allDay: false,
  occurrenceOf: null,
  occurrenceDate: null,
  conflicts: false,
  repeat: null,
  repeatUnrecognized: false,
};

const rangeAnswer = { get rows() { return rangeRows; }, unreadable: [] as unknown[] };

vi.mock("../../src/notes/vaultIndices", async () => {
  const actual = await vi.importActual<typeof import("../../src/notes/vaultIndices")>(
    "../../src/notes/vaultIndices",
  );
  return { ...actual, vaultIndicesCalendarRange: async () => rangeAnswer };
});
vi.mock("../../src/notes/readNote", () => ({
  noteRead: async () => "---\nkind: event\nstart: 2026-11-05 09:00\n---\n\nStandup\n",
  isLiveNote: () => false,
}));
vi.mock("../../src/notes/createNote", () => ({
  noteCreate: async () => "new-note",
  normalizeFolderPath: (p: string) => p,
}));
vi.mock("../../src/notes/updateNote", () => ({ noteUpdate: async () => {} }));

const taskFixture = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("../../src/notes/taskIndex", async (importActual) => {
  const actual = await importActual<typeof import("../../src/notes/taskIndex")>();
  return { ...actual, useLiveVaultTasks: () => taskFixture.rows };
});

import { CalendarPane } from "../../src/notes/components/CalendarPane";
import { WorkspaceProvider } from "../../src/notes/workspaceContext";
import { calendarItem, emptyWorkspace } from "../../src/notes/workspaceState";
import { deviceZone, homeClockFor, writeHomeZone } from "../../src/lib/homeZone";

// The easternmost zone there is (UTC+14, no DST): every device on earth is west of
// it, so a late-evening start here ALWAYS reads as the next day at home. A zone
// picked for being "a few hours ahead" of the machine would make the day-offset case
// pass or fail depending on where the test runs, which is the fragility CI caught.
const HOME = "Pacific/Kiritimati";

/** What the row must say for a stored start, derived rather than hardcoded. */
function expectedReading(start: string): string {
  const reading = homeClockFor(start.replace(" ", "T"), HOME, deviceZone());
  expect(reading, `${start} has no reading in ${HOME} from ${deviceZone()}`).not.toBeNull();
  const day = reading!.dayOffset === 0 ? "" : reading!.dayOffset > 0 ? "+1" : "-1";
  return `${reading!.time}${day}`;
}

async function renderPane(view: "day" | "week"): Promise<{ host: HTMLElement; cleanup: () => void }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <WorkspaceProvider initialState={emptyWorkspace("pane-1")}>
        <CalendarPane
          paneId="pane-1"
          item={calendarItem(view)}
          initialAnchor={{ year: 2026, month: 11, day: 5 }}
        />
      </WorkspaceProvider>,
    );
  });
  await act(async () => {});
  return {
    host,
    cleanup: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const homeClock = (host: HTMLElement) => host.querySelector('[data-testid="calendar.row.home-clock"]');

// A store of its own rather than `jsdom`'s: the preference is a `localStorage` value,
// and `tests/lib/homeZone.test.ts` stubs one for the same reason.
const store = new Map<string, string>();

beforeEach(() => {
  taskFixture.rows = [];
  rangeRows = [standup];
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  expect(deviceZone()).not.toBe(HOME);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the second clock on a calendar row", () => {
  it("reads the event's wall clock in the home zone", async () => {
    writeHomeZone(HOME);
    const { host, cleanup } = await renderPane("day");
    const reading = homeClock(host)?.textContent ?? "";
    expect(reading).toBe(expectedReading(standup.start));
    // And it is a SECOND reading, not the event's own clock echoed back.
    expect(reading).not.toContain("09:00");
    cleanup();
  });

  it("names the day too when the reading crosses midnight", async () => {
    writeHomeZone(HOME);
    rangeRows = [{ ...standup, start: "2026-11-05 23:30", end: "2026-11-06 00:15" }];
    const { host, cleanup } = await renderPane("day");
    expect(homeClock(host)?.textContent).toBe(expectedReading("2026-11-05 23:30"));
    expect(homeClock(host)?.textContent).toContain("+1");
    cleanup();
  });

  it("appears the moment the preference is written, without remounting", async () => {
    const { host, cleanup } = await renderPane("day");
    expect(homeClock(host)).toBeNull();

    // Settings writes the zone on another screen; the calendar is already mounted.
    act(() => writeHomeZone(HOME));
    await act(async () => {});
    expect(homeClock(host), "an open calendar ignored the zone written after mount").not.toBeNull();
    cleanup();
  });

  it("goes away when the preference is cleared", async () => {
    writeHomeZone(HOME);
    const { host, cleanup } = await renderPane("day");
    expect(homeClock(host)).not.toBeNull();

    act(() => writeHomeZone(""));
    await act(async () => {});
    expect(homeClock(host)).toBeNull();
    cleanup();
  });

  it("keeps its own line in a week block, away from the clock that can be cut", async () => {
    writeHomeZone(HOME);
    const { host, cleanup } = await renderPane("week");
    const clock = homeClock(host)!;
    // The block is a narrow column and clips on overflow, so a reading glued to the
    // end of "09:00" is a reading nobody sees. It is a sibling line instead.
    expect(clock.closest(".myne-calendar__time")).toBeNull();
    cleanup();
  });

  it("adds nothing to an all-day row, which has no clock to convert", async () => {
    writeHomeZone(HOME);
    rangeRows = [{ ...standup, start: "2026-11-05", end: "2026-11-06", allDay: true }];
    const { host, cleanup } = await renderPane("day");
    expect(homeClock(host)).toBeNull();
    cleanup();
  });
});
