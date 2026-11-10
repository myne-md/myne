// @vitest-environment jsdom
//
// The two gestures the hour axis gained (myne-md/myne#1037): dragging empty space
// to draw a range, and dragging an event's edge to move one instant.
//
// Why these need their own file rather than a line in `calendarDrag.test.ts`: that
// one proves the WRITE refuses and this one proves the SURFACE asks for the right
// write. A pane that computed the range from the wrong axis, or snapped to the
// wrong grain, would still pass every planner test - the plan is only as good as
// the minutes it is handed.
//
// The column's box is stubbed to 1px per minute, because jsdom computes no layout:
// with `height: 1440` the arithmetic in the pane is the identity, so a pointer at
// y=540 IS 09:00 and the assertion is about the mapping rather than about a rect.

import { describe, expect, it, vi, beforeEach } from "vitest";
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

const written: string[] = [];

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
  noteCreate: async () => "new-note",
  normalizeFolderPath: (p: string) => p,
}));
vi.mock("../../src/notes/updateNote", () => ({
  noteUpdate: async (_id: string, body: string) => {
    written.push(body);
  },
}));

const taskFixture = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("../../src/notes/taskIndex", async (importActual) => {
  const actual = await importActual<typeof import("../../src/notes/taskIndex")>();
  return { ...actual, useLiveVaultTasks: () => taskFixture.rows };
});

import { CalendarPane } from "../../src/notes/components/CalendarPane";
import { WorkspaceProvider } from "../../src/notes/workspaceContext";
import { calendarItem, emptyWorkspace } from "../../src/notes/workspaceState";

async function renderPane(): Promise<{ host: HTMLElement; cleanup: () => void }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <WorkspaceProvider initialState={emptyWorkspace("pane-1")}>
        <CalendarPane
          paneId="pane-1"
          item={calendarItem("day")}
          initialAnchor={{ year: 2026, month: 11, day: 5 }}
        />
      </WorkspaceProvider>,
    );
  });
  // The pane's range read is a promise; the rows do not exist until it settles.
  await act(async () => {});
  // One pixel per minute: the pane maps a pointer through this box.
  const column = host.querySelector<HTMLElement>(".myne-calendar__column")!;
  column.getBoundingClientRect = () =>
    ({ top: 0, left: 0, bottom: 1440, right: 200, width: 200, height: 1440, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  return {
    host,
    cleanup: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/** A pointer event at minute `minutes` past midnight, on `target`. */
function pointer(target: EventTarget, type: string, minutes: number): void {
  act(() => {
    target.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, clientY: minutes, button: 0, pointerId: 1 }),
    );
  });
}

beforeEach(() => {
  taskFixture.rows = [];
  written.length = 0;
  rangeRows = [];
});

describe("dragging empty hour space", () => {
  it("draws the range, then opens the form in it", async () => {
    const { host, cleanup } = await renderPane();
    const nine = host.querySelector('[data-hour="9"]')!;

    pointer(nine, "pointerdown", 540);
    // The preview follows the pointer: 09:00 is where the press landed, 11:00 is
    // where the drag has reached, and both are quarter-hour snapped.
    pointer(window, "pointermove", 660);
    const ghost = host.querySelector('[data-testid="calendar.createSpan"]');
    expect(ghost).not.toBeNull();
    expect(ghost!.getAttribute("data-start-minute")).toBe("540");
    expect(ghost!.getAttribute("data-end-minute")).toBe("660");

    pointer(window, "pointerup", 660);
    expect(host.querySelector('[data-testid="calendar.createSpan"]')).toBeNull();

    // The form, in the range that was drawn - not at the pane's default hour.
    expect(host.querySelector('[data-testid="calendar.form"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="calendar.form.startDate"]')?.getAttribute("data-value")).toBe(
      "2026-11-05",
    );
    expect(host.querySelector('[data-testid="calendar.form.startTime"]')?.getAttribute("data-value")).toBe("09:00");
    expect(host.querySelector('[data-testid="calendar.form.endTime"]')?.getAttribute("data-value")).toBe("11:00");
    cleanup();
  });

  it("snaps a stray drag to a quarter hour and never draws an empty range", async () => {
    const { host, cleanup } = await renderPane();
    pointer(host.querySelector('[data-hour="9"]')!, "pointerdown", 540);
    // Four minutes is closer to 09:00 than to 09:15, and a drag that ends where it
    // began would be a zero-length event: both resolve to one snap unit.
    pointer(window, "pointermove", 544);
    expect(host.querySelector('[data-testid="calendar.createSpan"]')!.getAttribute("data-end-minute")).toBe("555");
    pointer(window, "pointerup", 544);
    expect(host.querySelector('[data-testid="calendar.form.endTime"]')?.getAttribute("data-value")).toBe("09:15");
    cleanup();
  });

  it("reads a drag UPWARD as the same range, the right way round", async () => {
    const { host, cleanup } = await renderPane();
    // Pressed at 11:00 and dragged to 09:00: the range is 09:00-11:00, not a
    // negative one and not "11:00 plus a snap unit".
    pointer(host.querySelector('[data-hour="11"]')!, "pointerdown", 660);
    pointer(window, "pointermove", 540);
    pointer(window, "pointerup", 540);

    expect(host.querySelector('[data-testid="calendar.form.startTime"]')?.getAttribute("data-value")).toBe("09:00");
    expect(host.querySelector('[data-testid="calendar.form.endTime"]')?.getAttribute("data-value")).toBe("11:00");
    cleanup();
  });

  it("leaves a plain press as the inline capture it always was", async () => {
    const { host, cleanup } = await renderPane();
    const nine = host.querySelector('[data-hour="9"]')!;
    pointer(nine, "pointerdown", 540);
    pointer(window, "pointerup", 540);
    expect(host.querySelector('[data-testid="calendar.form"]')).toBeNull();

    // The click that follows a press-release is what captures, and a drag must not
    // reach here - the drag already answered with the form.
    act(() => {
      nine.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(host.querySelector(".myne-calendar__slotform input")).not.toBeNull();
    cleanup();
  });
});

describe("dragging an event's edge", () => {
  it("moves the end to the minute the pointer reached, and writes once", async () => {
    rangeRows = [standup];
    const { host, cleanup } = await renderPane();
    const grip = host.querySelector('[data-testid="calendar.block"] [data-edge="end"]')!;

    pointer(grip, "pointerdown", 570);
    pointer(window, "pointermove", 690);
    // The block follows the pointer while the write is still pending.
    expect(host.querySelector('[data-testid="calendar.block"]')!.getAttribute("data-end-minute")).toBe("690");

    pointer(window, "pointerup", 690);
    await vi.waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toContain("end: 2026-11-05 11:30");
    // One write for the whole gesture, and the START is untouched.
    expect(written[0]).toContain("start: 2026-11-05 09:00");
    cleanup();
  });

  it("refuses an edge dragged past the other one instead of inverting the span", async () => {
    rangeRows = [standup];
    const { host, cleanup } = await renderPane();
    const grip = host.querySelector('[data-testid="calendar.block"] [data-edge="end"]')!;

    pointer(grip, "pointerdown", 570);
    pointer(window, "pointermove", 480); // 08:00, before the 09:00 start
    pointer(window, "pointerup", 480);

    // Nothing was written and the block still covers the note's own span: an
    // optimistic span left behind here would show an end the file does not carry.
    expect(written).toHaveLength(0);
    await vi.waitFor(() =>
      expect(host.querySelector('[data-testid="calendar.block"]')!.getAttribute("data-end-minute")).toBe("570"),
    );
    cleanup();
  });
});
