// @vitest-environment jsdom
//
// The mobile client can consume the docked sheet (myne-md/myne#884).
//
// The point is not that the sheet works: the desktop suite proves the whole
// wizard against a real editor view. The point is that the shell and the
// viewport helper resolve through MOBILE's module graph, which is a separate
// resolution (the client aliases `@myne/*` into the parent tree) and a separate
// bundler from the one the desktop suite exercises. The mobile editor shipped
// once rendering the shared task chips with no listener behind them; this is the
// same class of gap one layer down, caught at the import.

import { afterEach, describe, expect, it } from "vitest";
import { createDockedSheet } from "@myne/editor/floating/docked-sheet";
import { dockGeometry, visibleViewport } from "@myne/editor/floating/viewport";

afterEach(() => {
  document.body.replaceChildren();
});

describe("the docked sheet through mobile's module graph", () => {
  it("builds the shell with the body and the actions as siblings", () => {
    const sheet = createDockedSheet({
      title: "Add field",
      testId: "mobile.task-field-sheet",
      backLabel: "Back",
      closeLabel: "Close",
      onClose: () => {},
    });
    document.body.appendChild(sheet.root);

    const body = document.querySelector('[data-testid="mobile.task-field-sheet-body"]');
    const actions = document.querySelector('[data-testid="mobile.task-field-sheet-actions"]');
    expect(body).not.toBeNull();
    expect(actions).not.toBeNull();
    // The commit row must not live inside the scroller.
    expect(body!.contains(actions!)).toBe(false);
    // Back starts hidden: the first step of a wizard has nowhere to go back to.
    expect(
      (document.querySelector('[data-testid="mobile.task-field-sheet-back"]') as HTMLElement).hidden,
    ).toBe(true);

    sheet.dispose();
  });

  it("writes the viewport geometry into the sheet's own style", () => {
    const sheet = createDockedSheet({
      title: "Add field",
      testId: "mobile.task-field-sheet",
      backLabel: "Back",
      closeLabel: "Close",
      onClose: () => {},
    });
    document.body.appendChild(sheet.root);

    // jsdom has no visualViewport, so the helper's honest fallback is what lands:
    // the layout viewport, bottom 0. What this pins is that the geometry is WRITTEN
    // from the helper rather than left to the stylesheet.
    const geometry = dockGeometry(visibleViewport());
    expect(sheet.root.style.bottom).toBe(`${geometry.bottom}px`);
    expect(sheet.root.style.getPropertyValue("--cm-visible-h")).toBe(`${geometry.maxHeight}px`);

    sheet.dispose();
  });
});
