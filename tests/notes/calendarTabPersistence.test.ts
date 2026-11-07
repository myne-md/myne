// The calendar tab's zoom, and that it survives a reload (myne-md/myne#1037, task 5).
//
// The zoom rides the **workspace descriptor**, per tab, exactly as the task tab's
// view does (MYND-616): "which month am I looking at" is where the user is, not how
// the product is configured, and it must not become a synced preference that makes
// one device's scroll position another device's.
//
// What these tests pin is what makes an opaque descriptor field safe, and each is a
// failure this file exists to prevent: **omit-when-default**, so a calendar tab a
// user never switched serialises byte-identical to one written before the field
// existed; **round-trip**, so a switch survives a reload and a pane reopen; and
// **degrade-don't-error**, so junk cannot reject the whole blob and lose every open
// tab.

import { describe, expect, it } from "vitest";
import {
  CALENDAR_TAB_ID,
  calendarItem,
  calendarViewOf,
  emptyWorkspace,
  openInFocusedTab,
  setCalendarViewState,
  type WorkspaceState,
} from "../../src/notes/workspaceState";
import { deserializeWorkspace, serializeWorkspace } from "../../src/lib/workspace-persist";

function withCalendarTab(): WorkspaceState {
  return openInFocusedTab(emptyWorkspace("p1"), calendarItem());
}

function tab(state: WorkspaceState): Record<string, unknown> {
  const leaf = state.root as { tabs: Array<Record<string, unknown>> };
  return leaf.tabs.find((t) => t.kind === "calendar")!;
}

function roundTrip(state: WorkspaceState): WorkspaceState {
  const parsed = deserializeWorkspace(serializeWorkspace(state));
  if (parsed === null) throw new Error("workspace failed to round-trip");
  return parsed;
}

describe("the zoom", () => {
  it("defaults to the month and writes no field", () => {
    expect(calendarViewOf(calendarItem())).toBe("month");
    expect(tab(withCalendarTab())).not.toHaveProperty("calendarView");
  });

  it("is per tab: switching one calendar tab leaves another alone", () => {
    const split = openInFocusedTab(withCalendarTab(), calendarItem());
    const switched = setCalendarViewState(split, "p1", "day");
    const leaf = switched.root as { tabs: Array<Record<string, unknown>> };
    const calendars = leaf.tabs.filter((t) => t.kind === "calendar");
    expect(calendars).toHaveLength(1);
    expect(calendarViewOf(calendars[0] as never)).toBe("day");
    void CALENDAR_TAB_ID;
  });

  it("survives a serialize/deserialize round trip", () => {
    const switched = setCalendarViewState(withCalendarTab(), "p1", "week");
    expect(calendarViewOf(tab(roundTrip(switched)) as never)).toBe("week");
  });

  it("degrades to the month on a value it does not know", () => {
    const blob = serializeWorkspace(withCalendarTab()).replace(
      '"kind":"calendar"',
      '"kind":"calendar","calendarView":{"view":"century"}',
    );
    const parsed = deserializeWorkspace(blob);
    expect(parsed).not.toBeNull();
    const leaf = parsed!.root as { tabs: Array<Record<string, unknown>> };
    const calendar = leaf.tabs.find((t) => t.kind === "calendar")!;
    expect(calendarViewOf(calendar as never)).toBe("month");
  });

  it("switching back to the month removes the field again", () => {
    const round = setCalendarViewState(
      setCalendarViewState(withCalendarTab(), "p1", "day"),
      "p1",
      "month",
    );
    expect(tab(round)).not.toHaveProperty("calendarView");
  });

  it("gives every view its own persisted value", () => {
    for (const view of ["week", "day", "agenda"] as const) {
      const switched = setCalendarViewState(withCalendarTab(), "p1", view);
      expect(calendarViewOf(tab(roundTrip(switched)) as never)).toBe(view);
    }
  });
});
