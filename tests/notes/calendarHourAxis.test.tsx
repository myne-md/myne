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

  it("puts a timed row in its own hour and an all-day one above the axis", async () => {
    const { host, cleanup } = await renderPane(dayPane());
    const fourteen = slot(host, 14)!;
    expect(fourteen.textContent).toContain("Design review");
    // 02:00 must NOT hold it: an hour row that draws everything makes the axis a
    // decoration, and the assertion that catches that is this pair.
    expect(slot(host, 2)!.textContent).not.toContain("Design review");
    expect(slot(host, 0)!.textContent).not.toContain("Away in Lisbon");
    expect(host.querySelector(".myne-calendar__allday")!.textContent).toContain("Away in Lisbon");
    cleanup();
  });

  it("captures at the hour that was clicked, not at the pane's default", async () => {
    const { host, cleanup } = await renderPane(dayPane());
    const fourteen = slot(host, 14)!;
    await act(async () => {
      fourteen.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const field = host.querySelector(".myne-calendar__slotform input") as HTMLInputElement | null;
    expect(field).not.toBeNull();

    await act(async () => {
      // React tracks the value through its own setter, so the input is driven the
      // way a person drives it rather than by assigning `.value`.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(field, "Design review");
      field!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      field!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });

    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toContain("start: 2026-11-05 14:00");
    cleanup();
  });
});
