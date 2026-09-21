// @vitest-environment jsdom
//
// The palette and the quick picker are comboboxes (myne-md/myne#728, task 5).
//
// Both are an input over a filtered list, and in both the input keeps focus
// while the arrows move a highlight inside the list. That is a combobox, and
// the moving highlight is conveyed by exactly one thing:
// `aria-activedescendant`. Without it a screen-reader user arrowing down twenty
// commands hears nothing at all, because focus never moved.
//
// What is asserted is the property, not the wiring: the id the input points at
// must be the id of the row that is visually highlighted. A test that only
// checked "the attribute is present" would pass on an attribute naming the
// wrong row, which is the shape this can actually break into as rows are
// filtered out from under a stale index.
//
// It also closes an axe finding rather than suppressing one. A `role="listbox"`
// that a `role="combobox"` references through `aria-controls` is a combobox
// popup, and `scrollable-region-focusable` deliberately does not match one
// (axe-core `scrollableRegionFocusableMatches`). That rule is one of the four
// ids in the E2E baseline task 17 drains, so the relationship is asserted here
// rather than left to be rediscovered there.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QuickPicker } from "../../src/components/QuickPicker";
import { formatViolations, runAxe } from "./axe-config";

afterEach(cleanup);

const ITEMS = [
  { id: "a", label: "Archive" },
  { id: "b", label: "Backlog" },
  { id: "c", label: "Chores" },
];

function picker(items = ITEMS, single = true) {
  render(
    <QuickPicker
      open
      title="Move to folder"
      placeholder="Search folders…"
      emptyText="No folders match."
      items={items}
      onPick={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  // `single` is false only in the two-pickers case below, where `getByRole`
  // would report the ambiguity it is there to create.
  return {
    input: single ? screen.getByRole("combobox") : screen.getAllByRole("combobox")[0]!,
    get options() {
      return screen.queryAllByRole("option");
    },
  };
}

/** The row the input claims is active, resolved to its element. */
function activeDescendant(input: HTMLElement): HTMLElement | null {
  const id = input.getAttribute("aria-activedescendant");
  return id === null ? null : document.getElementById(id);
}

describe("the quick picker is a combobox", () => {
  it("exposes the combobox role on the input, not on the dialog", () => {
    const { input } = picker();
    expect(input.tagName).toBe("INPUT");
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
  });

  it("controls the listbox it is paired with", () => {
    const { input } = picker();
    const listbox = screen.getByRole("listbox");
    expect(input.getAttribute("aria-controls")).toBe(listbox.id);
    expect(listbox.id).not.toBe("");
    expect(input.getAttribute("aria-expanded")).toBe("true");
  });

  it("points at the row that is visually selected, and follows the arrows", () => {
    const { input, options } = picker();
    expect(activeDescendant(input)).toBe(options[0]);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(activeDescendant(input)).toBe(screen.queryAllByRole("option")[1]);
    expect(screen.queryAllByRole("option")[1]?.getAttribute("aria-selected")).toBe("true");

    // Wrapping is where a naive id scheme drifts from the highlight.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    const last = screen.queryAllByRole("option").at(-1);
    expect(activeDescendant(input)).toBe(last);
    expect(last?.getAttribute("aria-selected")).toBe("true");
  });

  it("keeps the pairing when the list shrinks from under the selection", () => {
    // Filtering is not the only way the row under the index disappears: the
    // parent can hand over a shorter `items` list (a folder list refreshing).
    // A dangling id announces nothing at all, which is worse than announcing
    // the wrong row because it looks like the feature is simply absent.
    const { rerender } = render(
      <QuickPicker
        open
        title="Move to folder"
        placeholder="Search folders…"
        emptyText="No folders match."
        items={ITEMS}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(activeDescendant(input)).toBe(screen.queryAllByRole("option").at(-1));

    rerender(
      <QuickPicker
        open
        title="Move to folder"
        placeholder="Search folders…"
        emptyText="No folders match."
        items={[ITEMS[0]!]}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const options = screen.queryAllByRole("option");
    expect(options).toHaveLength(1);
    expect(activeDescendant(input)).toBe(options[0]);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
  });

  it("names a row only when that row is the highlighted one", () => {
    // The invariant, stated once over every reachable state: whatever the
    // input names must be the row carrying `aria-selected="true"`, and when no
    // row carries it the input must name nothing.
    const { input } = picker();
    for (const key of ["ArrowDown", "ArrowDown", "ArrowUp", "ArrowDown", "ArrowDown"]) {
      fireEvent.keyDown(input, { key });
      const highlighted =
        screen
          .queryAllByRole("option")
          .find((el) => el.getAttribute("aria-selected") === "true") ?? null;
      expect(activeDescendant(input), `after ${key}`).toBe(highlighted);
    }
  });

  it("claims neither a popup nor an active row when nothing matches", () => {
    const { input } = picker();
    fireEvent.change(input, { target: { value: "zzzz" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.getAttribute("aria-controls")).toBeNull();
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
    // And the empty state says so out loud rather than leaving a silent gap.
    expect(screen.getByRole("status").textContent).toBe("No folders match.");
    // OUTSIDE the listbox. A listbox may own only `option` and `group`
    // children, so a `role="status"` inside it is `aria-required-children` -
    // one of the four rule ids this branch deletes from the E2E axe baseline,
    // which it would have reintroduced on the one render no scenario produces.
    expect(screen.getByRole("status").closest('[role="listbox"]')).toBeNull();
  });

  it("is axe-clean on the render no E2E scenario reaches", async () => {
    // The zero-results render is the gap the deleted baseline left open: ax1
    // to ax5 never type a non-matching query, so the empty state is never
    // seen by the real-render pass. Asserted here instead, under the same
    // WCAG 2.2 AA tag set.
    const { input } = picker();
    fireEvent.change(input, { target: { value: "zzzz" } });
    // `document.body`, because the picker portals there: the render's own
    // container holds nothing.
    const results = await runAxe(document.body);
    expect(results.violations, formatViolations(results)).toHaveLength(0);
  });

  it("gives two pickers two listboxes", () => {
    // `useId` rather than a module constant: two mounted at once would
    // otherwise share one DOM id and every `aria-controls` would resolve to
    // whichever rendered first.
    picker();
    picker(ITEMS, false);
    const ids = screen.getAllByRole("listbox").map((el) => el.id);
    expect(new Set(ids).size).toBe(2);
    const inputs = screen.getAllByRole("combobox");
    expect(inputs[0]?.getAttribute("aria-controls")).not.toBe(
      inputs[1]?.getAttribute("aria-controls"),
    );
  });
});
