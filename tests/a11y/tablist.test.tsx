// @vitest-environment jsdom
//
// Guards the note tab strip's a11y contract (myne-md/myne#728, task 3):
//   - the strip is ONE Tab stop (roving tabindex), so a pane with a dozen open
//     notes costs one stop rather than a dozen;
//   - arrow keys move focus and Enter/Space activates (MANUAL activation:
//     the WAI-ARIA default is automatic, but that is a default for cheap
//     panel switches and each activation here re-points the editor body and
//     persists workspace state);
//   - no interactive control is nested inside a `role="tab"` widget, which is
//     the `nested-interactive` rule the axe E2E baseline recorded as debt and
//     task 17 drains to empty.
//
// Then it runs axe over the strip itself, so the debt cannot come back
// silently.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TabStrip, tabDomId } from "../../src/notes/components/TabStrip";
import { useRovingFocus } from "@myne/editor/host/lib/roving-focus";
import { runAxe, formatViolations } from "./axe-config";

afterEach(cleanup);

function setup(activeTab: string | null = "B", panelId?: string) {
  const onActivate = vi.fn();
  const onClose = vi.fn();
  const { container } = render(
    <TabStrip
      paneId="pane-1"
      tabs={["A", "B", "C"]}
      activeTab={activeTab}
      titleOf={(id) => `Note ${id}`}
      onActivate={onActivate}
      onClose={onClose}
      onNewTab={vi.fn()}
      onMoveTab={vi.fn()}
      panelId={panelId}
    />,
  );
  return { container, onActivate, onClose };
}

describe("note tab strip is a real tablist", () => {
  it("keeps exactly one tab in the Tab order", () => {
    setup();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((el) => el.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
  });

  it("moves focus on an arrow key WITHOUT activating", () => {
    // Manual activation (myne#728, review). This case asserted the opposite
    // for one round, which was the WAI-ARIA default rather than a decision:
    // automatic activation is the default only because switching panels is
    // usually cheap, and here each one re-points the editor body and
    // persists workspace state. Arrowing from the first tab to the eighth
    // did that seven times on the way past.
    const { onActivate } = setup();
    const tabs = screen.getAllByRole("tab");
    tabs[1]!.focus();
    fireEvent.keyDown(tabs[1]!, { key: "ArrowRight" });
    expect(document.activeElement, "focus moved").toBe(tabs[2]);
    expect(onActivate, "but nothing was activated on the way").not.toHaveBeenCalled();
  });

  it("activates the focused tab on Enter and on Space", () => {
    for (const key of ["Enter", " "]) {
      const { onActivate } = setup();
      const tabs = screen.getAllByRole("tab");
      tabs[1]!.focus();
      fireEvent.keyDown(tabs[1]!, { key: "ArrowRight" });
      fireEvent.keyDown(tabs[2]!, { key });
      expect(onActivate, `${key} activates`).toHaveBeenCalledWith("C");
      cleanup();
    }
  });

  it("keeps arrowing from where focus reached, not from the active tab", () => {
    // The state manual activation has to carry. The caller's `activeIndex`
    // deliberately stops moving while the arrows walk, so a hook that kept
    // computing from it would answer the SAME neighbour to every press and
    // focus would stick one step from the active tab. Active is "B" (index
    // 1), so two rights must reach C and then wrap to A.
    const { onActivate } = setup();
    const tabs = screen.getAllByRole("tab");
    tabs[1]!.focus();
    fireEvent.keyDown(tabs[1]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[2]);
    fireEvent.keyDown(tabs[2]!, { key: "ArrowRight" });
    expect(document.activeElement, "the second arrow advances rather than sticking").toBe(
      tabs[0],
    );
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("nests no interactive control inside a role=tab", () => {
    const { container } = setup();
    const nested = container.querySelectorAll(
      '[role="tab"] button, [role="tab"] a, [role="tab"] input, [role="tab"] [role="button"]',
    );
    expect(nested).toHaveLength(0);
  });

  it("closes the focused tab on Delete", () => {
    const { onClose } = setup();
    const tabs = screen.getAllByRole("tab");
    tabs[1]!.focus();
    fireEvent.keyDown(tabs[1]!, { key: "Delete" });
    expect(onClose).toHaveBeenCalledWith("B");
  });

  it("offers close in the tab context menu, which the demotion's justification names", () => {
    // The per-tab x is an `aria-hidden` mouse affordance, and the whole
    // argument for that rests on THREE keyboard paths: Mod-W, Delete or
    // Backspace on the focused tab, and this menu. For one review round the
    // menu had no close item, so the justification named a path that did not
    // exist while reading as checked, in three places at once (the call-site
    // comment, the axe baseline header, and decision 0599).
    const onClose = vi.fn();
    render(
      <TabStrip
        paneId="pane-1"
        tabs={["A", "B", "C"]}
        activeTab="B"
        titleOf={(id) => `Note ${id}`}
        onActivate={vi.fn()}
        onClose={onClose}
        onNewTab={vi.fn()}
        onMoveTab={vi.fn()}
        onTogglePin={vi.fn()}
        isPinned={() => false}
      />,
    );
    fireEvent.contextMenu(screen.getAllByRole("tab")[1]!);
    const close = document.querySelector('[data-item-id="tab.close"]');
    expect(close, "the menu offers a close item").not.toBeNull();
    fireEvent.click(close as Element);
    expect(onClose).toHaveBeenCalledWith("B");
  });

  it("closes the tab from the mouse affordance", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getAllByTestId("editor.tab-close")[1]!);
    expect(onClose).toHaveBeenCalledWith("B");
  });

  it("has no axe violation of its own", async () => {
    const { container } = setup();
    const results = await runAxe(container);
    expect(results.violations, formatViolations(results)).toEqual([]);
  });
});

// The tabs <-> panel pairing (myne#728, task 3). The pane body carries
// `role="tabpanel"` and borrows its name from the ACTIVE tab, so the two sides
// have to agree on one id. `tabDomId` is the agreement: the strip stamps it on
// every tab and `PaneView` reads the same function for `aria-labelledby`, so
// there is no second copy of the id rule to drift.
describe("the note tab strip pairs with a panel", () => {
  it("gives every tab the shared stable id", () => {
    setup();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((el) => el.id)).toEqual([
      tabDomId("pane-1", "A"),
      tabDomId("pane-1", "B"),
      tabDomId("pane-1", "C"),
    ]);
  });

  it("scopes the id by pane, because one note can be open in two panes", () => {
    expect(tabDomId("pane-1", "note:x")).not.toBe(tabDomId("pane-2", "note:x"));
  });

  it("points only the ACTIVE tab at the panel it controls", () => {
    setup("B", "pane-panel-1");
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((el) => el.getAttribute("aria-controls"))).toEqual([
      null,
      "pane-panel-1",
      null,
    ]);
  });

  it("names no panel when the pane has none, rather than dangling", () => {
    // A strip rendered without a panel (the title-bar-alignment harness, and
    // every standalone test) must not claim to control an element that is not
    // in the document: axe reads `aria-controls` as a real reference.
    setup("B");
    for (const el of screen.getAllByRole("tab")) {
      expect(el.getAttribute("aria-controls")).toBeNull();
    }
  });

  it("has no axe violation with the panel wired up", async () => {
    const { container } = setup("B", "pane-panel-1");
    // The panel the strip points at has to exist for `aria-controls` to
    // resolve, exactly as it does inside a pane.
    const panel = document.createElement("div");
    panel.id = "pane-panel-1";
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tabDomId("pane-1", "B"));
    container.appendChild(panel);
    const results = await runAxe(container);
    expect(results.violations, formatViolations(results)).toEqual([]);
  });
});


/**
 * The RIGHT-PANEL strip (myne-md/myne#728, review).
 *
 * `src/screens/Editor.tsx` cannot be mounted in jsdom, and no E2E scenario
 * touches `editor.right-panel-tab`, so removing its `onKeyDown` or its
 * `tabIndexFor` call failed nothing and put the panel back at one Tab stop
 * per tab with no arrow navigation: the exact state task 3 exists to remove.
 *
 * Driven against a fabricated DOM of the shape that screen renders, the
 * technique `noteListTabStops.test.tsx` already uses, and against the REAL
 * `useRovingFocus` rather than a copy of it, so the hook's own behaviour is
 * what is asserted.
 */
describe("the right-panel strip is one Tab stop with arrows inside", () => {
  const TABS = ["backlinks", "outline", "ai-chat"] as const;

  function Strip({ active }: { active: string }) {
    const roving = useRovingFocus({
      count: TABS.length,
      activeIndex: TABS.indexOf(active as (typeof TABS)[number]),
      orientation: "horizontal",
      itemSelector: '[role="tab"][data-panel-tab-id]',
      manualActivation: true,
    });
    return (
      <div
        ref={roving.containerRef as React.RefObject<HTMLDivElement>}
        role="tablist"
        aria-label="Side panel"
        onKeyDown={roving.onKeyDown}
      >
        {TABS.map((id, i) => (
          <button
            key={id}
            type="button"
            role="tab"
            data-panel-tab-id={id}
            aria-selected={id === active}
            aria-label={id}
            tabIndex={roving.tabIndexFor(i)}
          >
            {id}
          </button>
        ))}
      </div>
    );
  }

  it("keeps exactly one tab in the Tab order", () => {
    render(<Strip active="outline" />);
    const stops = screen
      .getAllByRole("tab")
      .filter((el) => el.getAttribute("tabindex") === "0");
    expect(stops).toHaveLength(1);
    expect(stops[0]!.getAttribute("data-panel-tab-id")).toBe("outline");
  });

  it("moves focus on ArrowRight without activating", () => {
    // Activation here WRITES A PREF, which is why this strip is manual.
    render(<Strip active="outline" />);
    const tabs = screen.getAllByRole("tab");
    tabs[1]!.focus();
    fireEvent.keyDown(tabs[1]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[2]);
    expect(
      tabs[2]!.getAttribute("aria-selected"),
      "focus moved but nothing was selected",
    ).toBe("false");
  });

  it("wraps, so the strip is a cycle rather than a walk that ends", () => {
    render(<Strip active="ai-chat" />);
    const tabs = screen.getAllByRole("tab");
    tabs[2]!.focus();
    fireEvent.keyDown(tabs[2]!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(tabs[0]);
  });
});
