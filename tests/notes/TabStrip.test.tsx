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

describe("the active tab breaks the strip's bottom rule", () => {
  // Obsidian's look, and the reason is legibility rather than taste: an
  // unbroken rule under the active tab draws a closed box around it, and a
  // closed box says "this is a chip", not "this is the thing you are looking
  // at". The gap — the tab's own fill repainting that one pixel, with its side
  // hairlines running down into it — is what joins the tab to the note body.
  //
  // This file's own source comment used to assert the opposite ("the line does
  // NOT break under it") while calling that the Obsidian style, which is how a
  // deliberate-looking choice survives: it was written down.

  function tabAt(index: number): HTMLElement {
    return screen.getAllByRole("tab")[index] as HTMLElement;
  }

  it("hangs the active tab over the rule and repaints it in the tab's fill", () => {
    setup(); // active is "B", index 1
    const active = tabAt(1);
    // A HEIGHT, not a negative margin: under the app's global border-box, a
    // -1px margin on a flex item with an explicit height moves nothing, and
    // the tab's own bottom border sat one pixel above the rule.
    expect(active.style.height, "the tab must reach down over the rule").toBe(
      "calc(100% + 1px)",
    );
    expect(
      active.style.borderBottom,
      "and repaint that pixel in its own fill, or the rule shows through",
    ).toContain("var(--bg-1)");
    expect(
      active.style.background,
      "the fill it repaints with must be the fill it has",
    ).toContain("var(--bg-1)");
  });

  it("does the same for the pending new-tab chip, which is the selected tab then", () => {
    // The chip is its own component, so the fix above skipped it and the rule
    // kept running under "New tab" (myne-md/myne#772).
    setup({ pendingNewTab: true });
    const chip = screen
      .getAllByRole("tab")
      .find((el) => el.getAttribute("title") === "notes.tabStrip.newTab" || /New tab/.test(el.textContent ?? ""))!;
    expect(chip.style.height).toBe("calc(100% + 1px)");
    expect(chip.style.borderBottom).toContain("var(--bg-1)");
    expect(chip.style.background).toContain("var(--bg-1)");
  });

  it("is not clipped by the scrolling row that holds it", () => {
    // The overhang above was asserted and the rule still showed on screen. The
    // row the tabs scroll in is `overflow-x: auto`, which forces `overflow-y`
    // to clip too, so the hanging pixel was cut at the row's padding edge. The
    // row therefore carries one pixel of padding below the tabs (inside its
    // clip) and the equal negative margin, which keeps the strip's height.
    setup();
    const row = tabAt(1).parentElement as HTMLElement;
    expect(row.style.overflowY, "not the row this test is about").toBe("hidden");
    // The two values are the `--hairline` token (myne-md/myne#773 moved the
    // literal into the shared sheet). Asserted on the inline style text: jsdom's
    // CSSOM does not resolve `var()` for a longhand, so `row.style.paddingBottom`
    // is not readable here.
    const inline = row.getAttribute("style") ?? "";
    expect(inline, "the overhang is clipped by the row").toContain("padding-bottom: var(--hairline)");
    expect(inline, "and the strip grew a pixel").toContain("margin-bottom: calc(var(--hairline) * -1)");
  });

  it("leaves every inactive tab's stretch of the rule intact", () => {
    // An inactive tab is transparent: a filled bottom border there would punch
    // a hole in the rule under a tab that is not open, which is the same defect
    // pointing the other way.
    setup();
    for (const i of [0, 2]) {
      expect(tabAt(i).style.height, `tab ${i} overhangs the rule`).toBe("100%");
      expect(tabAt(i).style.borderBottom, `tab ${i} paints over the rule`).toBe("");
    }
  });

  it("still draws the rule for the strip to break", () => {
    // A gap in a rule that does not exist is just a tab floating on a surface.
    setup();
    expect(
      (screen.getByTestId("editor.tab-strip") as HTMLElement).style.borderBottom,
    ).toContain("var(--line-1)");
  });
});

describe("the strip never ends flush against the window edge", () => {
  // With the right sidebar open nothing floats over the strip's right end, so
  // `insetRight` is 0 and the tab-list caret was the last control on the row —
  // pressed against the edge while the right-sidebar toggle, in the other
  // layout, sits TITLE_BAR_RIGHT_EDGE in. The two now end the row on one line.
  it("takes the title bar's edge offset when nothing floats beside it", async () => {
    const { TITLE_BAR_RIGHT_EDGE } = await import("../../src/screens/titlebar");
    setup({ insetRight: 0 });
    const strip = screen.getByTestId("editor.tab-strip");
    expect(strip.style.paddingInlineEnd).toBe(`${TITLE_BAR_RIGHT_EDGE}px`);
  });

  it("keeps the larger clearance when the floated controls need it", () => {
    // That clearance already contains the edge offset; adding it again would
    // leave a gap between the caret and the floated `…`.
    setup({ insetRight: 76 });
    expect(screen.getByTestId("editor.tab-strip").style.paddingInlineEnd).toBe("76px");
  });
});

describe("tab title reveal (myne-md/myne#908 item 6)", () => {
  it("carries no native title tooltip on the tab", () => {
    setup();
    const tabs = screen.getAllByTestId("editor.tab");
    for (const tab of tabs) expect(tab.getAttribute("title")).toBeNull();
  });

  it("marks the label box so the reveal has a measurable target", () => {
    setup();
    const label = screen.getAllByTestId("editor.tab-label")[0];
    expect(label).toBeTruthy();
    expect(label?.style.overflow).toBe("hidden");
    // The ellipsis stays at REST and is dropped only while the reveal runs:
    // removing it outright deleted every truncation mark in the strip.
    expect(label?.style.textOverflow).toBe("ellipsis");
    // And the text is `inline` at rest, because an inline-block child is an
    // atomic box that swallows the parent's ellipsis.
    expect((label?.firstElementChild as HTMLElement | null)?.style.display).toBe(
      "inline",
    );
  });
});

describe("the strip's observer is torn down (myne-md/myne#913)", () => {
  it("disconnects the ResizeObserver when the strip unmounts", () => {
    // The row's `ref` was an inline arrow that called the overflow hook and
    // DROPPED the cleanup it returns, so every render built a fresh observer for
    // the live node and never disconnected the old one: an unbounded leak on a
    // component rendered per pane and re-rendered on every save-status change.
    // The observable consequence is on the OBSERVER, not on the listener: React
    // wraps listeners, so an identity comparison there is inconclusive.
    const disconnect = vi.spyOn(ResizeObserver.prototype, "disconnect");
    const observe = vi.spyOn(ResizeObserver.prototype, "observe");

    const { unmount } = render(
      <TabStrip
        paneId="pane-1"
        tabs={["A", "B", "C"]}
        activeTab="B"
        titleOf={titleOf}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onNewTab={vi.fn()}
        onMoveTab={vi.fn()}
      />,
    );
    expect(observe).toHaveBeenCalled();
    disconnect.mockClear();

    unmount();

    expect(disconnect).toHaveBeenCalled();
    disconnect.mockRestore();
    observe.mockRestore();
  });
});

describe("<TabStrip> tab widths", () => {
  it("keeps every tab readable and lets the row scroll instead of shrinking", () => {
    // myne-md/myne#913, second report: the strip shrank inactive tabs to an icon
    // (56px) and the note titles became unreadable. Shrinking is what produced
    // that, so the floor is a readable label and an overflowing row scrolls.
    setup();
    const [first, active] = screen.getAllByRole("tab");
    // jsdom keeps the inline value verbatim, which is the point of asserting it.
    expect(first!.style.minWidth).toBe("132px");
    expect(first!.style.flexShrink).toBe("0");
    // The active tab is sized by its own label, not by the floor.
    expect(active!.style.minWidth).toBe("max-content");
    expect(active!.style.flexShrink).toBe("0");
  });
});

describe("<TabStrip> tab widths", () => {
  it("keeps every tab readable and lets the row scroll instead of shrinking", () => {
    // myne-md/myne#913, second report: the strip shrank inactive tabs to an icon
    // (56px) and the note titles became unreadable. Shrinking is what produced
    // that, so the floor is a readable label and an overflowing row scrolls.
    setup();
    const [first, active] = screen.getAllByRole("tab");
    // jsdom keeps the inline value verbatim, which is the point of asserting it.
    expect(first!.style.minWidth).toBe("132px");
    expect(first!.style.flexShrink).toBe("0");
    // The active tab is sized by its own label, not by the floor.
    expect(active!.style.minWidth).toBe("max-content");
    expect(active!.style.flexShrink).toBe("0");
  });
});
