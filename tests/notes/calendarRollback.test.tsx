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
  taskFixture.rows = [];
  written.length = 0;
  created.length = 0;
  refuseWith = null;
  rangeRows = defaultRows;
});

// These drags run in the MONTH view, where the gesture is still the native one
// (dragstart, then a drop on a cell). The hour axis moves a block by the POINTER
// instead, because a day-granular drop cannot say "10:30"; that path is
// `calendarGestures.test.tsx`. Both run through one writer, so the rollback this
// file is about is the same code either way.
describe("dragging an event", () => {
  it("draws the row where it was dropped, then writes the note once", async () => {
    const { host, cleanup } = await renderPane(
      <CalendarPane paneId="pane-1" item={calendarItem("month")} initialAnchor={{ year: 2026, month: 11, day: 5 }} />,
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
      <CalendarPane paneId="pane-1" item={calendarItem("month")} initialAnchor={{ year: 2026, month: 11, day: 5 }} />,
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
      <CalendarPane paneId="pane-1" item={calendarItem("month")} initialAnchor={{ year: 2026, month: 11, day: 5 }} />,
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
      <CalendarPane paneId="pane-1" item={calendarItem("month")} initialAnchor={{ year: 2026, month: 11, day: 5 }} />,
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

// ── Orientation: where "now" is, and how a keyboard moves through the grid ────
//
// Both claims are about the pane as a CALENDAR rather than as a list. A day that
// looks like every other day makes the reader do arithmetic the app already knows,
// and a grid an arrow key cannot enter is a grid only a mouse can use.

describe("the pane as a calendar", () => {
  it("marks today's column and draws the now line once", async () => {
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    rangeRows = [
      {
        ...(defaultRows[0] as Record<string, unknown>),
        noteId: "today-row",
        start: `${stamp} 00:01`,
        end: null,
      },
    ];
    const { host, cleanup } = await renderPane(
      <CalendarPane
        paneId="pane-1"
        item={calendarItem("week")}
        initialAnchor={{
          year: today.getFullYear(),
          month: today.getMonth() + 1,
          day: today.getDate(),
        }}
      />,
    );
    expect(host.querySelector('[data-testid="calendar.today-header"]')).not.toBeNull();
    // Exactly one, however many rows the day holds: a marker per row would draw the
    // same line several times and let a reader think there are several "nows".
    expect(host.querySelectorAll('[data-testid="calendar.now"]')).toHaveLength(1);
    cleanup();
  });

  it("moves the anchor by a day on an arrow and returns to today on `t`", async () => {
    const { host, cleanup } = await renderPane(
      <CalendarPane paneId="pane-1" item={calendarItem("week")} initialAnchor={{ year: 2026, month: 11, day: 5 }} />,
    );
    const pane = host.querySelector('[data-testid="calendar.pane"]') as HTMLElement;
    expect(pane).not.toBeNull();
    const dates = () =>
      Array.from(host.querySelectorAll("[data-date]")).map((el) => el.getAttribute("data-date"));

    // The week view holds seven days, so a one-day shift changes WHERE the window
    // starts rather than which days are visible. Asserting the window's first day is
    // the version of this test that would catch an arrow moving by a whole week.
    const firstDay = dates()[0];
    expect(firstDay).toBe("2026-11-02");
    // Four presses from Thursday the 5th: Sunday the 8th still sits in the week that
    // starts on the 2nd, and the fourth lands on Monday the 9th, whose week starts
    // there. Asserting the window's first day is what catches an arrow that moves by
    // a whole week instead of a day.
    for (let index = 0; index < 4; index += 1) {
      act(() => {
        pane.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      });
      await act(async () => {});
    }
    expect(dates()[0]).toBe("2026-11-09");

    act(() => {
      pane.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));
    });
    await act(async () => {});
    // Back to the machine's today, whichever month that is in.
    expect(dates()).toContain(
      `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}-${String(new Date().getDate()).padStart(2, "0")}`,
    );
    cleanup();
  });

  it("leaves a keypress alone while the user is typing in a field", async () => {
    const { host, cleanup } = await renderPane(
      <CalendarPane paneId="pane-1" item={calendarItem("week")} initialAnchor={{ year: 2026, month: 11, day: 5 }} />,
    );
    const pane = host.querySelector('[data-testid="calendar.pane"]') as HTMLElement;
    const field = document.createElement("input");
    pane.appendChild(field);
    const dates = () => Array.from(host.querySelectorAll("[data-date]")).map((el) => el.getAttribute("data-date"));
    const before = dates();
    act(() => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    await act(async () => {});
    // A window-level listener would move the calendar while the user types a time.
    expect(dates()).toEqual(before);
    cleanup();
  });
});

describe("starting an event from the grid", () => {
  it("opens the form on the day and hour whose empty space was clicked", async () => {
    const { host, cleanup } = await renderPane(
      <CalendarPane paneId="pane-1" item={calendarItem("week")} initialAnchor={{ year: 2026, month: 11, day: 5 }} />,
    );
    // The week view is an hour axis, so the target is one cell of it: the 6th at
    // 11:00. The claim is the same one this test has always made - the note lands
    // where the user pointed rather than on today - and it now holds for the hour
    // as well as the day, through the form rather than an inline field.
    const slot = host.querySelector('[data-date="2026-11-06"] [data-hour="11"]') as HTMLElement;
    act(() => {
      slot.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});
    expect(
      host.querySelector('[data-testid="calendar.form.startDate"]')?.getAttribute("data-value"),
    ).toBe("2026-11-06");
    expect(
      host.querySelector('[data-testid="calendar.form.startTime"]')?.getAttribute("data-value"),
    ).toBe("11:00");

    const field = host.querySelector(".myne-event-form input") as HTMLInputElement;
    await act(async () => {
      // React tracks the value through its own setter, so the field is driven the
      // way a person drives it rather than by assigning `.value`.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(field, "Coffee");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      host.querySelector<HTMLElement>('[data-testid="calendar.form.save"]')!.click();
    });

    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toContain("start: 2026-11-06 11:00");
    cleanup();
  });

  it("opens the event's own form on a chip, never the markdown note", async () => {
    const { host, cleanup } = await renderPane(
      <CalendarPane paneId="pane-1" item={calendarItem("week")} initialAnchor={{ year: 2026, month: 11, day: 5 }} />,
    );
    const chip = host.querySelector('[data-testid="calendar.row"]') as HTMLElement;
    expect(chip).not.toBeNull();
    act(() => {
      chip.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});
    // The chip opens the SAME designed form a cell click opens, prefilled, and
    // never the note: an event's markdown is not part of the notes UI (owner,
    // 2026-11-08). Prefilled is the half a create-form would also satisfy, so the
    // assertion is on the values the row carries.
    const form = host.querySelector('[data-testid="calendar.form"]');
    expect(form).not.toBeNull();
    expect(form?.textContent).toMatch(/Edit event/);
    expect(
      host.querySelector('[data-testid="calendar.form.startDate"]')?.getAttribute("data-value"),
    ).toBe("2026-11-05");
    expect(
      host.querySelector('[data-testid="calendar.form.startTime"]')?.getAttribute("data-value"),
    ).toBe("09:00");
    cleanup();
  });
});

// ── Tasks on the calendar ────────────────────────────────────────────────────
//
// A due-bearing task is a note with a date, exactly as an event is, so a calendar
// showing only one of them answers half of "what is on this week". The second
// assertion matters as much as the first: a task is NOT an event, and a drag that
// treated it as one would patch a field no reader of that line agrees about.

const taskFixture = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock("../../src/notes/taskIndex", async (importActual) => {
  const actual = await importActual<typeof import("../../src/notes/taskIndex")>();
  // Controllable rather than fixed: this mock is in the same file as the drag tests,
  // and a task standing on a day by default would quietly change what those measure.
  return { ...actual, useLiveVaultTasks: () => taskFixture.rows };
});

describe("tasks on the calendar", () => {
  it("draws a due task on its day and leaves the completed one out", async () => {
    taskFixture.rows = [
      {
        noteId: "task-note",
        noteTitle: "Weekly review",
        noteFolder: "Notes/",
        lineIndex: 3,
        rawLine: "- [ ] Weekly review [due:: 2026-11-06]",
        completed: false,
        oversized: false,
        due: "2026-11-06",
      },
      {
        noteId: "done-note",
        noteTitle: "Finished thing",
        noteFolder: "Notes/",
        lineIndex: 4,
        rawLine: "- [x] Finished thing [due:: 2026-11-06]",
        completed: true,
        oversized: false,
        due: "2026-11-06",
      },
    ];
    const { host, cleanup } = await renderPane(
      <CalendarPane paneId="pane-1" item={calendarItem("week")} initialAnchor={{ year: 2026, month: 11, day: 5 }} />,
    );
    const taskRows = Array.from(host.querySelectorAll('[data-task="true"]'));
    expect(taskRows).toHaveLength(1);
    expect(taskRows[0].textContent).toContain("Weekly review");
    // A calendar is a forward view: a finished item keeps its own surface instead of
    // appearing as work still to do.
    expect(host.textContent).not.toContain("Finished thing");
    cleanup();
  });

  it("does not let a task be dragged like an event", async () => {
    taskFixture.rows = [
      {
        noteId: "task-note",
        noteTitle: "Weekly review",
        noteFolder: "Notes/",
        lineIndex: 3,
        rawLine: "- [ ] Weekly review [due:: 2026-11-06]",
        completed: false,
        oversized: false,
        due: "2026-11-06",
      },
    ];
    const { host, cleanup } = await renderPane(
      <CalendarPane paneId="pane-1" item={calendarItem("week")} initialAnchor={{ year: 2026, month: 11, day: 5 }} />,
    );
    const taskRow = host.querySelector('[data-task="true"]') as HTMLElement;
    expect(taskRow.getAttribute("draggable")).toBe("false");
    const target = host.querySelector('[data-date="2026-11-07"]') as HTMLElement;
    act(() => {
      taskRow.dispatchEvent(new Event("dragstart", { bubbles: true }));
    });
    await act(async () => {
      target.dispatchEvent(new Event("drop", { bubbles: true }));
    });
    await act(async () => {});
    // No write at all: a move writer aimed at a task would rewrite the line's own
    // fields, and nothing would report it because the file still parses.
    expect(written).toHaveLength(0);
    cleanup();
  });
});
