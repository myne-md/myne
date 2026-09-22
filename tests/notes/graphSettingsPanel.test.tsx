// @vitest-environment jsdom
//
// The graph settings panel's SHELL (myne-md/myne#727).
//
// Three of the four things a user reported about this panel are structural
// rather than visual, so they are testable here and worth pinning: the header
// has to be a SIBLING of the scroller rather than a `position: sticky` child of
// it (that is what "the title stays put" actually means), the Reset control
// belongs beside the close control rather than at the bottom of the list, and
// each group of settings has to fold.
//
// The fourth, the scrollbar, is `scrollArea.test.tsx`'s subject, and the
// panel's job is only to put the settings inside one.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GraphSettingsPanel } from "../../src/notes/components/GraphSettingsPanel";
import { DEFAULT_GRAPH_SETTINGS } from "../../src/notes/graphSettings";

// The panel renders `ColorGroupEditor`, which reads `usePrefs` and the selected
// note. Neither is this spec's subject, and both would drag the whole sidebar
// provider in.
vi.mock("../../src/notes/components/ColorGroupEditor", () => ({
  ColorGroupEditor: () => <div data-testid="editor.color-groups-stub" />,
}));

afterEach(cleanup);

const renderPanel = (open = true) =>
  render(
    <GraphSettingsPanel
      open={open}
      onClose={() => {}}
      settings={DEFAULT_GRAPH_SETTINGS}
      onChange={() => {}}
      onReset={() => {}}
    />,
  );

describe("GraphSettingsPanel shell", () => {
  it("renders nothing when closed", () => {
    renderPanel(false);
    expect(screen.queryByTestId("editor.graph-settings-panel")).toBeNull();
  });

  it("keeps the title, the reset control and the close control OUT of the scroller", () => {
    // This is the "sticky header" requirement in its testable form. A
    // `position: sticky` header would be a CHILD of the scroller and would need
    // its own background and stacking to stop rows showing through it; a sibling
    // cannot scroll away in the first place, which is the stronger guarantee and
    // the one asserted here.
    renderPanel();
    const scroller = screen.getByTestId("editor.graph-settings-scroll");
    const header = screen.getByTestId("editor.graph-settings-panel")
      .firstElementChild!;
    expect(header.contains(scroller)).toBe(false);
    expect(scroller.contains(header)).toBe(false);
    for (const id of [
      "editor.graph-settings-reset",
      "editor.graph-settings-close",
    ]) {
      const control = screen.getByTestId(id);
      expect(header.contains(control)).toBe(true);
      expect(scroller.contains(control)).toBe(false);
    }
  });

  it("puts reset beside close rather than at the end of the list", () => {
    // In the list it read as one more setting and sat below the fold.
    renderPanel();
    const header = screen.getByTestId("editor.graph-settings-panel")
      .firstElementChild!;
    const order = Array.from(header.querySelectorAll("[data-testid]")).map((el) =>
      el.getAttribute("data-testid"),
    );
    expect(order.indexOf("editor.graph-settings-reset")).toBeLessThan(
      order.indexOf("editor.graph-settings-close"),
    );
  });

  it("folds each group, and is expanded on open", () => {
    renderPanel();
    for (const group of ["appearance", "forces", "colors"]) {
      const toggle = screen.getByTestId(`editor.graph-settings-group-${group}-toggle`);
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(
        screen.queryByTestId(`editor.graph-settings-group-${group}-body`),
      ).not.toBeNull();
    }
    // The controls are inside the group body, not loose in the scroller, which
    // is what makes folding them possible at all.
    const appearanceBody = screen.getByTestId(
      "editor.graph-settings-group-appearance-body",
    );
    expect(
      appearanceBody.contains(screen.getByTestId("editor.graph-settings-node-size")),
    ).toBe(true);
    expect(
      appearanceBody.contains(
        screen.getByTestId("editor.graph-settings-arrows-toggle"),
      ),
    ).toBe(true);
    const forcesBody = screen.getByTestId("editor.graph-settings-group-forces-body");
    expect(
      forcesBody.contains(screen.getByTestId("editor.graph-settings-force-repel")),
    ).toBe(true);
    expect(
      screen.getByTestId("editor.graph-settings-group-colors-body").contains(
        screen.getByTestId("editor.color-groups-stub"),
      ),
    ).toBe(true);
  });

  it("collapses a group to just its label, and expands it again", () => {
    renderPanel();
    const toggle = screen.getByTestId("editor.graph-settings-group-forces-toggle");
    const bodyId = "editor.graph-settings-group-forces-body";
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId(bodyId)).toBeNull();
    // The OTHER groups are untouched: folding one must not fold the panel.
    expect(
      screen.getByTestId("editor.graph-settings-group-appearance-body"),
    ).not.toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByTestId(bodyId)).not.toBeNull();
  });
});
