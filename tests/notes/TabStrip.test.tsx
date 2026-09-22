// @vitest-environment jsdom
//
// <TabStrip> behavior tests (MYND-166, Task 3): renders tabs with the
// active state, click activates, the close control fires onClose, `+`
// fires onNewTab, and the overflow `…` menu lists every open tab and
// switches on pick.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TabStrip } from "../../src/notes/components/TabStrip";

// `globals: false` in vitest.config → RTL's auto-cleanup is off; unmount
// each render so queries don't match nodes from a prior test.
afterEach(cleanup);

const TITLES: Record<string, string | null> = {
  A: "Note A",
  B: "Note B",
  C: null, // untitled
};
const titleOf = (id: string) => TITLES[id] ?? null;

function setup(overrides: Partial<Parameters<typeof TabStrip>[0]> = {}) {
  const onActivate = vi.fn();
  const onClose = vi.fn();
  const onNewTab = vi.fn();
  const onMoveTab = vi.fn();
  render(
    <TabStrip
      paneId="pane-1"
      tabs={["A", "B", "C"]}
      activeTab="B"
      titleOf={titleOf}
      onActivate={onActivate}
      onClose={onClose}
      onNewTab={onNewTab}
      onMoveTab={onMoveTab}
      {...overrides}
    />,
  );
  return { onActivate, onClose, onNewTab, onMoveTab };
}

describe("<TabStrip>", () => {
  it("renders one tab per id with the active one selected", () => {
    setup();
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(screen.getByText("Note A")).toBeTruthy();
    expect(screen.getByText("Note B")).toBeTruthy();
    expect(screen.getByText("Untitled")).toBeTruthy(); // null title
    const active = tabs.find((t) => t.getAttribute("aria-selected") === "true");
    expect(active).toBeTruthy();
    expect(within(active!).getByText("Note B")).toBeTruthy();
  });

  it("clicking a tab activates it", () => {
    const { onActivate } = setup();
    fireEvent.click(screen.getByText("Note A"));
    expect(onActivate).toHaveBeenCalledWith("A");
  });

  it("the close control fires onClose for that tab", () => {
    const { onClose } = setup();
    // The × is a mouse affordance outside the a11y tree (myne#728), so it is
    // found by testid rather than by role. Tab order is B at index 1.
    const closes = screen.getAllByTestId("editor.tab-close");
    fireEvent.click(closes[1]!);
    expect(onClose).toHaveBeenCalledWith("B");
  });

  it("the + control fires onNewTab", () => {
    const { onNewTab } = setup();
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    expect(onNewTab).toHaveBeenCalledTimes(1);
  });

  it("the overflow menu lists every tab and switches on pick", () => {
    const { onActivate } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Open notes" }));
    const menu = screen.getByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(items).toHaveLength(3);
    fireEvent.click(within(menu).getByText("Note A"));
    expect(onActivate).toHaveBeenCalledWith("A");
    // menu closes after a pick
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("shows no overflow menu button when there are no tabs", () => {
    setup({ tabs: [], activeTab: null });
    expect(screen.queryByRole("button", { name: "Open notes" })).toBeNull();
    // `+` is still available to start a note
    expect(
      screen.getByRole("button", { name: "New tab" }),
    ).toBeTruthy();
  });
});
