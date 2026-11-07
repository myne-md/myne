// @vitest-environment jsdom
//
// The calendar's drag gesture rolls back (myne-md/myne#1037, task 6).
//
// `tests/notes/calendarDrag.test.ts` proves the WRITE refuses; this proves the
// SURFACE believes the refusal. They are different claims, and the second one is
// the one a user experiences: a pane that keeps the row where it was dropped is
// claiming a write that never landed, and every later drag in that session then
// fails against a position the note does not share.
//
// So the two things asserted here are exactly the two halves of that:
//
// 1. the row is drawn where it was dropped while the write is in flight (the
//    gesture must feel instant), and
// 2. when the host refuses, the row goes back to where the NOTE says it is, and
//    the reason is on screen rather than in a toast that has already gone.
//
// The seam is faked at the module boundary on purpose: a fixture that returned a
// fixed answer could not be made to refuse, and a test that cannot reach the
// refused state is the vacuous fixture this repository has been bitten by.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

/** The rows the mocked host returns; a test may replace this. */
let rangeRows: unknown[] = [];

const defaultRows = [
    {
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
    },
  ];

const rangeAnswer = { get rows() { return rangeRows; }, unreadable: [] as unknown[] };

const written: string[] = [];
const created: string[] = [];
let refuseWith: unknown = null;

vi.mock("../../src/notes/vaultIndices", async () => {
  const actual = await vi.importActual<typeof import("../../src/notes/vaultIndices")>(
    "../../src/notes/vaultIndices",
  );
  return { ...actual, vaultIndicesCalendarRange: async () => rangeAnswer };
});
vi.mock("../../src/notes/readNote", () => ({
  noteRead: async () =>
    "---\nkind: event\nstart: 2026-11-05 09:00\nend: 2026-11-05 09:30\n---\n\nStandup\n",
  isLiveNote: () => false,
}));
vi.mock("../../src/notes/createNote", () => ({
  noteCreate: async (body: string) => {
    created.push(body);
    return "new-note";
  },
  normalizeFolderPath: (p: string) => p,
}));
vi.mock("../../src/notes/updateNote", () => ({
  noteUpdate: async (_id: string, body: string) => {
    if (refuseWith !== null) throw refuseWith;
    written.push(body);
  },
}));

import { CalendarPane } from "../../src/notes/components/CalendarPane";
import { WorkspaceProvider } from "../../src/notes/workspaceContext";
import { calendarItem, emptyWorkspace } from "../../src/notes/workspaceState";

/** Render the pane inside the provider it reads its zoom and flush from. */
async function renderPane(node: React.ReactNode): Promise<{ host: HTMLElement; cleanup: () => void }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<WorkspaceProvider initialState={emptyWorkspace("pane-1")}>{node}</WorkspaceProvider>);
  });
  // The pane's range read is a promise; the rows do not exist until it settles.
  await act(async () => {});
  return {
    host,
    cleanup: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

beforeEach(() => {
  written.length = 0;
  created.length = 0;
  refuseWith = null;
  rangeRows = defaultRows;
});

describe("dragging an event", () => {
  it("draws the row where it was dropped, then writes the note once", async () => {
    const { host, cleanup } = await renderPane(
      <CalendarPane paneId="pane-1" item={calendarItem("week")} initialAnchor={{ year: 2026, month: 11, day: 5 }} />,
    );
    const chip = host.querySelector('[data-testid="calendar.row"]');
    expect(chip).not.toBeNull();
    const target = host.querySelector('[data-date="2026-11-06"]');
    expect(target).not.toBeNull();

    act(() => {
      chip!.dispatchEvent(new Event("dragstart", { bubbles: true }));
    });
    await act(async () => {
      target!.dispatchEvent(new Event("drop", { bubbles: true }));
      // The handler is `void dropOn(...)`: React does not await it, and the chain
      // crosses a WebCrypto digest, so it settles on a macrotask rather than in the
      // next microtask. `vi.waitFor` below is what makes the assertions about the
      // SETTLED screen rather than about the frame the drop landed on.
    });

    await vi.waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toContain("start: 2026-11-06 09:00");
    cleanup();
  });

  it("puts the row back and names the reason when the host refuses", async () => {
    refuseWith = Object.assign(new Error("base mismatch"), { kind: "BaseMismatch" });
    const { host, cleanup } = await renderPane(
      <CalendarPane paneId="pane-1" item={calendarItem("week")} initialAnchor={{ year: 2026, month: 11, day: 5 }} />,
    );
    const chip = host.querySelector('[data-testid="calendar.row"]');
    const target = host.querySelector('[data-date="2026-11-06"]');

    act(() => {
      chip!.dispatchEvent(new Event("dragstart", { bubbles: true }));
    });
    await act(async () => {
      target!.dispatchEvent(new Event("drop", { bubbles: true }));
      // The handler is `void dropOn(...)`: React does not await it, and the chain
      // crosses a WebCrypto digest, so it settles on a macrotask rather than in the
      // next microtask. `vi.waitFor` below is what makes the assertions about the
      // SETTLED screen rather than about the frame the drop landed on.
    });

    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="calendar.writeRefused"]')).not.toBeNull(),
    );
    expect(written).toHaveLength(0);
    // The row is back in the cell the note names, not the one it was dropped on.
    const cellsWithRows = [...host.querySelectorAll('[data-testid="calendar.cell"]')]
      .filter((cell) => cell.querySelector('[data-testid="calendar.row"]') !== null)
      .map((cell) => cell.getAttribute("data-date"));
    expect(cellsWithRows).toContain("2026-11-05");
    expect(cellsWithRows).not.toContain("2026-11-06");
    cleanup();
  });
});

describe("dragging an occurrence of a series", () => {
  const projected = {
    ...(defaultRows[0] as Record<string, unknown>),
    occurrenceOf: "series-1",
    occurrenceDate: "2026-11-05",
    repeat: "every week",
  };

  it("refuses with both affordances, and writes nothing at all", async () => {
    rangeRows = [projected];
    const { host, cleanup } = await renderPane(
      <CalendarPane paneId="pane-1" item={calendarItem("week")} initialAnchor={{ year: 2026, month: 11, day: 5 }} />,
    );
    const chip = host.querySelector('[data-testid="calendar.row"]');
    expect(chip!.getAttribute("data-occurrence")).toBe("true");
    const target = host.querySelector('[data-date="2026-11-06"]');

    act(() => {
      chip!.dispatchEvent(new Event("dragstart", { bubbles: true }));
    });
    await act(async () => {
      target!.dispatchEvent(new Event("drop", { bubbles: true }));
    });

    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="calendar.occurrenceRefused"]')).not.toBeNull(),
    );
    // The refusal names the series and the occurrence's own date.
    const panel = host.querySelector('[data-testid="calendar.occurrenceRefused"]')!;
    expect(panel.textContent).toContain("2026-11-05");
    // Neither the series nor any note was written, and no one-off was created yet.
    expect(written).toHaveLength(0);
    expect(created).toHaveLength(0);
    cleanup();
  });

  it("creates a separate one-off note, leaving the series bytes untouched", async () => {
    rangeRows = [projected];
    const { host, cleanup } = await renderPane(
      <CalendarPane paneId="pane-1" item={calendarItem("week")} initialAnchor={{ year: 2026, month: 11, day: 5 }} />,
    );
    const chip = host.querySelector('[data-testid="calendar.row"]');
    const target = host.querySelector('[data-date="2026-11-06"]');
    act(() => {
      chip!.dispatchEvent(new Event("dragstart", { bubbles: true }));
    });
    await act(async () => {
      target!.dispatchEvent(new Event("drop", { bubbles: true }));
    });
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="calendar.occurrenceRefused"]')).not.toBeNull(),
    );

    const addOneOff = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Add a one-off on this day",
    );
    expect(addOneOff).not.toBeUndefined();
    await act(async () => {
      addOneOff!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await vi.waitFor(() => expect(created).toHaveLength(1));
    // The new note carries no rule, and NOTHING was written to the series.
    expect(created[0]).toContain("kind: event");
    expect(created[0]).not.toContain("repeat:");
    expect(written).toHaveLength(0);
    cleanup();
  });
});
