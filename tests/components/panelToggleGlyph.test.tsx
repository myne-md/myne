// @vitest-environment jsdom
//
// The sidebar toggle's glyph. It replaced an `<Icon>` swap between `panel-left`
// and `panel-left-close`, which could never animate: those are two different
// Lucide `d` paths and an SVG path does not interpolate.
//
// So the property under test is that the OUTLINE is the same in both states and
// only a fill opacity moves. A future change that reintroduces a per-state
// outline would pass a "renders something" test and fail these.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PanelToggleGlyph } from "../../src/components/primitives/PanelToggleGlyph";
import { ICON_PATHS } from "../../src/lib/icons";

afterEach(cleanup);

function fill(): SVGRectElement {
  return screen.getByTestId("editor.sidebar-toggle-fill") as unknown as SVGRectElement;
}

/** Both sides of an outline comparison go through the SAME serialiser.
 *  `ICON_PATHS` stores `<rect …/>`; the DOM hands it back as `<rect …></rect>`,
 *  so comparing the stored string against the rendered one compares two
 *  spellings of the same markup and always fails. */
function serialised(markup: string): string {
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.innerHTML = markup;
  return g.innerHTML.replace(/\s+/g, "");
}

function renderedOutline(): string {
  return serialised(
    screen.getByTestId("editor.sidebar-toggle-glyph").querySelector("g")!.innerHTML,
  );
}

describe("PanelToggleGlyph", () => {
  it("empties the panel region while the pane is collapsed", () => {
    render(<PanelToggleGlyph side="left" collapsed />);
    expect(fill().style.fillOpacity).toBe("0");
  });

  it("fills the panel region while the pane is open", () => {
    render(<PanelToggleGlyph side="left" collapsed={false} />);
    expect(fill().style.fillOpacity).toBe("1");
  });

  it("keeps ONE outline across both states: the state is the fill, not the path", () => {
    const { rerender } = render(<PanelToggleGlyph side="left" collapsed />);
    const outlineWhenCollapsed = renderedOutline();
    rerender(<PanelToggleGlyph side="left" collapsed={false} />);
    expect(renderedOutline()).toBe(outlineWhenCollapsed);
    // And it is the repo's own Lucide copy rather than a second hand-drawn one.
    expect(outlineWhenCollapsed).toBe(serialised(ICON_PATHS["panel-left"]!));
  });

  it("never draws the caret variants the swap used to reach for", () => {
    for (const collapsed of [true, false]) {
      cleanup();
      render(<PanelToggleGlyph side="left" collapsed={collapsed} />);
      const html = screen.getByTestId("editor.sidebar-toggle-glyph").innerHTML;
      // `m16 15-3-3 3-3` is `panel-left-close`'s inward caret.
      expect(html).not.toContain("m16 15-3-3 3-3");
    }
  });

  it("fills the side the pane is on: left strip for the left pane, right for the right", () => {
    render(<PanelToggleGlyph side="left" collapsed={false} />);
    expect(fill().getAttribute("x")).toBe("3");
    cleanup();
    render(<PanelToggleGlyph side="right" collapsed={false} />);
    expect(fill().getAttribute("x")).toBe("15");
  });

  it("uses the right outline per side", () => {
    render(<PanelToggleGlyph side="right" collapsed />);
    expect(renderedOutline()).toBe(serialised(ICON_PATHS["panel-right"]!));
  });

  it("keeps the RTL mirror `<Icon>` would have applied", () => {
    // `panel-left` / `panel-right` are in Icon's DIRECTIONAL_ICONS set. Drawing
    // the glyph by hand bypasses that logic, so the attribute is asserted here
    // rather than assumed: without it an RTL locale gets a toggle pointing the
    // wrong way, silently.
    render(<PanelToggleGlyph side="left" collapsed />);
    expect(
      screen.getByTestId("editor.sidebar-toggle-glyph").hasAttribute("data-flip"),
    ).toBe(true);
  });

  it("transitions the fill on a motion token rather than a literal duration", () => {
    render(<PanelToggleGlyph side="left" collapsed />);
    // jsdom's CSSOM drops `var()` inside a shorthand, so the transition string
    // is read off the React-rendered attribute rather than the style object.
    const raw = fill().getAttribute("style") ?? "";
    expect(raw).toContain("var(--duration-base)");
    expect(raw).toContain("var(--ease-standard)");
  });
});
