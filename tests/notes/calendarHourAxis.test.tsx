// @vitest-environment jsdom
//
// The calendar's hour axis (myne-md/myne#1037).
//
// The day and week views draw one row per hour so a person can put something AT
// an hour, which is the question a list of rows could not answer. Two claims are
// what make that real rather than decorative, and neither is visible to a
// compiler:
//
// 1. a timed row is drawn in the hour it starts in, and an all-day one is not
//    (an all-day event inside 00:00 would say it begins at midnight), and
// 2. clicking an hour captures at THAT hour - the write, not the field, is the
//    assertion, because a slot that opened a form and saved 09:00 would look
//    identical on screen.
//
// The seam is faked at the module boundary, the same shape `calendarRollback`
// uses: `noteCreate` is where the captured bytes can be read.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

/** The rows the mocked host returns; a test may replace this. */
let rangeRows: unknown[] = [];

const timedRow = {
  noteId: "n1",
  title: "Design review",
  folder: "Calendar/",
  calendar: "Work",
  start: "2026-11-05 14:00",
  end: "2026-11-05 15:00",
  allDay: false,
  occurrenceOf: null,
  occurrenceDate: null,
  conflicts: false,
  repeat: null,
  repeatUnrecognized: false,
};

const allDayRow = {
  ...timedRow,
  noteId: "n2",
  title: "Away in Lisbon",
  start: "2026-11-05",
  end: "2026-11-07",
  allDay: true,
};

const rangeAnswer = { get rows() { return rangeRows; }, unreadable: [] as unknown[] };

const created: string[] = [];

vi.mock("../../src/notes/vaultIndices", async () => {
  const actual = await vi.importActual<typeof import("../../src/notes/vaultIndices")>(
    "../../src/notes/vaultIndices",
  );
  return { ...actual, vaultIndicesCalendarRange: async () => rangeAnswer };
});
vi.mock("../../src/notes/createNote", () => ({
  noteCreate: async (body: string) => {
    created.push(body);
    return "new-note";
  },
  normalizeFolderPath: (p: string) => p,
}));
vi.mock("../../src/notes/readNote", () => ({
  noteRead: async () => "",
  isLiveNote: () => false,
}));
vi.mock("../../src/notes/updateNote", () => ({ noteUpdate: async () => undefined }));

const taskFixture = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("../../src/notes/taskIndex", async (importActual) => {
  const actual = await importActual<typeof import("../../src/notes/taskIndex")>();
  return { ...actual, useLiveVaultTasks: () => taskFixture.rows };
});

import { CalendarPane } from "../../src/notes/components/CalendarPane";
import { WorkspaceProvider } from "../../src/notes/workspaceContext";
import { calendarItem, emptyWorkspace } from "../../src/notes/workspaceState";

async function renderPane(node: React.ReactNode): Promise<{ host: HTMLElement; cleanup: () => void }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<WorkspaceProvider initialState={emptyWorkspace("pane-1")}>{node}</WorkspaceProvider>);
  });
  // The range read is a promise; the rows do not exist until it settles.
  await act(async () => {});
  return {
    host,
    cleanup: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const dayPane = () => (
  <CalendarPane paneId="pane-1" item={calendarItem("day")} initialAnchor={{ year: 2026, month: 11, day: 5 }} />
);

const slot = (host: HTMLElement, hour: number) =>
  host.querySelector(`[data-hour="${hour}"]`) as HTMLElement | null;

beforeEach(() => {
  taskFixture.rows = [];
  created.length = 0;
  rangeRows = [timedRow, allDayRow];
});

describe("the hour axis", () => {
  it("draws one row per hour, 00:00 to 23:00", async () => {
    const { host, cleanup } = await renderPane(dayPane());
    const slots = [...host.querySelectorAll('[data-hour]')].map((el) => Number(el.getAttribute("data-hour")));
    expect(slots).toEqual(Array.from({ length: 24 }, (_, hour) => hour));
    cleanup();
  });

  it("draws a timed row as a block that SPANS its minutes", async () => {
    const { host, cleanup } = await renderPane(dayPane());
    // 14:00-15:00 covers minutes 840 to 900 of the day, and that is what the grid
    // positions: 840/1440 of the column's height, one hour tall. The defect this
    // replaces drew the row INSIDE the 14:00 slot, so the hour after two looked
    // free while the note said the event was in it.
    const block = host.querySelector('[data-testid="calendar.block"]') as HTMLElement | null;
    expect(block).not.toBeNull();
    expect(block!.getAttribute("data-start-minute")).toBe("840");
    expect(block!.getAttribute("data-end-minute")).toBe("900");
    expect(block!.style.top).toBe(`${(840 / 1440) * 100}%`);
    expect(block!.style.height).toBe(`${(60 / 1440) * 100}%`);
    expect(block!.textContent).toContain("Design review");

    // The slot is now a rule and a click target, not a container: a row inside it
    // could never be taller than an hour.
    expect(slot(host, 14)!.textContent).not.toContain("Design review");
    expect(slot(host, 2)!.textContent).not.toContain("Design review");
    expect(slot(host, 0)!.textContent).not.toContain("Away in Lisbon");
    expect(host.querySelector(".myne-calendar__allday")!.textContent).toContain("Away in Lisbon");
    cleanup();
  });

  it("opens the form at the hour that was clicked, not at the pane's default", async () => {
    const { host, cleanup } = await renderPane(dayPane());
    const fourteen = slot(host, 14)!;
    await act(async () => {
      fourteen.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // The click opens the SAME form the `+` opens, seeded with the hour under the
    // pointer: one way to make an event, and the write is what the assertion below
    // reads - a form that saved 09:00 would look identical on screen.
    expect(
      host.querySelector('[data-testid="calendar.form.startTime"]')?.getAttribute("data-value"),
    ).toBe("14:00");

    const field = host.querySelector(".myne-event-form input") as HTMLInputElement;
    await act(async () => {
      // React tracks the value through its own setter, so the input is driven the
      // way a person drives it rather than by assigning `.value`.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(field, "Design review");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      host.querySelector<HTMLElement>('[data-testid="calendar.form.save"]')!.click();
    });

    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toContain("start: 2026-11-05 14:00");
    cleanup();
  });

  // The `+` beside a date in the week and day headers (owner, 2026-11-11: "weekly
  // viewde tarihlerin yanindaki + isareti calismiyor"). It set the inline capture
  // at an hour of `null`, and the hour axis only drew that field inside a slot
  // whose hour matched — so the button was a no-op in exactly the two views that
  // have a header row.
  it("opens the form from the + beside a day's date", async () => {
    const { host, cleanup } = await renderPane(
      <CalendarPane paneId="pane-1" item={calendarItem("week")} initialAnchor={{ year: 2026, month: 11, day: 5 }} />,
    );
    const plus = host.querySelector<HTMLElement>('[aria-label="Add an event on 2026-11-06"]');
    expect(plus).not.toBeNull();
    await act(async () => {
      plus!.click();
    });
    expect(
      host.querySelector('[data-testid="calendar.form.startDate"]')?.getAttribute("data-value"),
    ).toBe("2026-11-06");
    cleanup();
  });

  // A block under an hour has one line of height, and the clock used to take it:
  // a 20-minute event drew as "14:20" with no name in it (owner, 2026-11-11). The
  // pane marks the short block and the stylesheet's compact rule spends the line
  // on the title; what a jsdom test can hold is the marker and the presence of the
  // title, since the paint itself is the stylesheet's.
  it("marks a block under an hour compact, and keeps its title", async () => {
    rangeRows = [
      {
        ...timedRow,
        noteId: "n3",
        title: "Standup",
        start: "2026-11-05 14:20",
        end: "2026-11-05 14:40",
      },
    ];
    const { host, cleanup } = await renderPane(dayPane());
    const block = host.querySelector('[data-testid="calendar.block"]') as HTMLElement;
    expect(block.getAttribute("data-compact")).toBe("true");
    expect(block.textContent).toContain("Standup");
    // The clock the compact shape hides is still the block's tooltip, so the hour
    // is not lost with the line it used to occupy.
    expect(block.getAttribute("title")).toContain("Standup");
    expect(block.getAttribute("title")).toContain("2:20");
    cleanup();
  });

  it("leaves an hour-long block in the two-line shape", async () => {
    const { host, cleanup } = await renderPane(dayPane());
    const block = host.querySelector('[data-testid="calendar.block"]') as HTMLElement;
    expect(block.getAttribute("data-compact")).toBeNull();
    expect(block.textContent).toContain("Design review");
    cleanup();
  });
});
