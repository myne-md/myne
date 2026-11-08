// @vitest-environment jsdom
//
// The press primitive's contract (motion-system task 2, myne-md/myne#732).
//
// The failure this pins, in the tree's own terms: the app styles inline, and an
// inline `background` outranks any stylesheet rule, so a press expressed as a CSS
// `:active` class loses to the element's own resting fill. `hoverSurface` exists
// for exactly that reason and carries no press arm, and `CenteredCard`'s
// `ctaHover` was a second, independent press implementation used by eight screens.
// This file holds the one primitive that replaces it, and asserts the handler
// contract rather than the colour values, which come from tokens.
//
// What a green run does NOT prove is that the values are right; that is
// `myne-agents/docs/design/README.md`'s job and the last test here is the one place a value is
// asserted, deliberately, so a silent edit to the neutral step fails.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ACCENT_PRESS_BG,
  NEUTRAL_PRESS_BG,
  pressSurface,
  usePressSurface,
} from "../../src/components/primitives/pressSurface";
import { interactiveSurface } from "../../src/components/primitives/interactiveSurface";
import { hoverSurface } from "../../src/components/primitives/hoverSurface";

afterEach(cleanup);

/** The resting fill a caller with no hover would pass. */
const REST = "transparent";
/** The fill a caller with hover returns to when a press releases under the pointer. */
const HOVER = "var(--accent-hover)";

/**
 * Render a real `<button>` carrying the handlers, so the test exercises React's
 * event wiring rather than calling the handlers by hand. A handler whose NAME is
 * right but which React never attaches would pass a direct-call test and fail
 * this one.
 */
function mount(opts: Parameters<typeof pressSurface>[0]): HTMLElement {
  const handlers = pressSurface(opts);
  const { getByTestId } = render(
    createElement("button", { ...handlers, "data-testid": "surface" }, "press me"),
  );
  return getByTestId("surface");
}

describe("pressSurface", () => {
  it("deepens to the neutral step on pointer-down", () => {
    const el = mount({ restBg: REST });

    fireEvent.pointerDown(el);

    expect(el.style.background).toBe(NEUTRAL_PRESS_BG);
  });

  it("restores the resting fill on pointer-up when no hover fill is given", () => {
    const el = mount({ restBg: REST });
    fireEvent.pointerDown(el);

    fireEvent.pointerUp(el);

    expect(el.style.background).toBe(REST);
  });

  it("restores the resting fill on pointer-leave, so a press abandoned by leaving does not stick", () => {
    const el = mount({ restBg: REST });
    fireEvent.pointerDown(el);

    fireEvent.pointerLeave(el);

    expect(el.style.background).toBe(REST);
  });

  it("restores the resting fill on pointer-cancel, which leave does not cover on touch", () => {
    const el = mount({ restBg: REST });
    fireEvent.pointerDown(el);

    fireEvent.pointerCancel(el);

    expect(el.style.background).toBe(REST);
  });

  it("releases back to the hover fill rather than the resting one when the surface has hover", () => {
    const el = mount({ restBg: REST, releaseBg: HOVER });
    fireEvent.pointerDown(el);

    fireEvent.pointerUp(el);

    expect(el.style.background).toBe(HOVER);
  });

  it("uses the accent step on an accent surface", () => {
    const el = mount({ restBg: "var(--accent)", releaseBg: HOVER, accent: true });

    fireEvent.pointerDown(el);

    expect(el.style.background).toBe(ACCENT_PRESS_BG);
  });

  it("honours an explicit pressBg over both defaults", () => {
    const el = mount({ restBg: REST, pressBg: "var(--danger-solid)" });

    fireEvent.pointerDown(el);

    expect(el.style.background).toBe("var(--danger-solid)");
  });

  it("returns no handlers at all when disabled, so nothing is attached to fire", () => {
    expect(pressSurface({ disabled: true })).toEqual({});
  });

  it("leaves a disabled surface untouched under the pointer", () => {
    const el = mount({ disabled: true, restBg: REST });

    fireEvent.pointerDown(el);
    fireEvent.pointerUp(el);

    expect(el.style.background).toBe("");
  });

  it("defaults its resting fill to transparent, matching hoverSurface", () => {
    const el = mount({});
    fireEvent.pointerDown(el);

    fireEvent.pointerLeave(el);

    expect(el.style.background).toBe("transparent");
  });

  it("pins the neutral step to one value and holds the component layer to it", () => {
    // Two artifacts express this step: this module, for inline-styled surfaces,
    // and `client-core/src/components.css`, for class-based ones. They cannot
    // import from each other, so the copy is pinned here instead of drifting
    // silently the way the canon and the code already did once.
    expect(NEUTRAL_PRESS_BG).toBe(
      "color-mix(in srgb, var(--bg-3), var(--fg-1) 8%)",
    );

    // Scoped to the Button SECTION of the sheet, not to the whole file. The
    // expression appears twice in that sheet (the button and `.myne-modal-close`),
    // so a file-wide `toContain` passes while the BUTTON's copy has drifted and
    // the other one still matches: the assertion could not fail on the defect it
    // names. Injection found that; this is the fix.
    const sheet: string = readFileSync(
      resolve(process.cwd(), "client-core/src/components.css"),
      "utf8",
    );
    const buttonSection = sheet.slice(
      sheet.indexOf(".myne-btn {"),
      sheet.indexOf(".myne-btn:disabled"),
    );
    expect(buttonSection.length).toBeGreaterThan(0);
    expect(buttonSection).toContain(NEUTRAL_PRESS_BG);
    expect(buttonSection.split(NEUTRAL_PRESS_BG).length - 1).toBe(1);
  });
});

describe("interactiveSurface", () => {
  /** Render a button carrying an arbitrary handler bag. */
  function mountWith(handlers: Record<string, unknown>, testId = "surface"): HTMLElement {
    const { getByTestId } = render(
      createElement("button", { ...handlers, "data-testid": testId }, "press me"),
    );
    return getByTestId(testId);
  }

  it("attaches both halves, so hover and press arrive together", () => {
    const handlers = interactiveSurface({ restBg: REST });

    expect(typeof handlers.onMouseEnter).toBe("function");
    expect(typeof handlers.onMouseLeave).toBe("function");
    expect(typeof handlers.onPointerDown).toBe("function");
    expect(typeof handlers.onPointerUp).toBe("function");
    expect(typeof handlers.onPointerLeave).toBe("function");
    expect(typeof handlers.onPointerCancel).toBe("function");
  });

  it("deepens on press and releases onto the hover fill", () => {
    const el = mountWith(interactiveSurface({ restBg: REST, hoverBg: HOVER }));
    fireEvent.mouseEnter(el);
    expect(el.style.background).toBe(HOVER);

    fireEvent.pointerDown(el);
    expect(el.style.background).toBe(NEUTRAL_PRESS_BG);

    fireEvent.pointerUp(el);
    expect(el.style.background).toBe(HOVER);
  });

  it("releases onto the hover fill even when the caller left hoverBg at its default", () => {
    // The bug this pins is the reason this module exists rather than a bare
    // sibling pair: with no fills given, a separate press surface would release
    // to `transparent` and leave a hovered element blank, because `pointerup`
    // does not re-fire `mouseenter`.
    const el = mountWith(interactiveSurface({ disabled: false }));

    fireEvent.mouseEnter(el);
    fireEvent.pointerDown(el);
    fireEvent.pointerUp(el);

    expect(el.style.background).toBe("var(--bg-3)");
    expect(el.style.background).not.toBe("transparent");
  });

  it("agrees with hoverSurface on the hover default, so the restated default cannot drift", () => {
    const viaHover = mountWith(hoverSurface({}), "via-hover");
    const viaInteractive = mountWith(interactiveSurface({}), "via-interactive");

    fireEvent.mouseEnter(viaHover);
    fireEvent.mouseEnter(viaInteractive);

    expect(viaInteractive.style.background).toBe(viaHover.style.background);
  });

  it("still gives a disabled surface nothing at all", () => {
    const el = mountWith(interactiveSurface({ disabled: true, restBg: REST }));

    fireEvent.mouseEnter(el);
    fireEvent.pointerDown(el);

    expect(el.style.background).toBe("");
  });

  it("passes the accent flag through to the press half", () => {
    const el = mountWith(interactiveSurface({ restBg: "var(--accent)", accent: true }));

    fireEvent.pointerDown(el);

    expect(el.style.background).toBe(ACCENT_PRESS_BG);
  });
});

describe("usePressSurface", () => {
  /** A component whose computed background depends on the hook's `pressed`. */
  function Probe({ disabled }: { disabled?: boolean }) {
    const { pressed, pressBg, handlers } = usePressSurface({ disabled });
    return createElement("button", {
      ...handlers,
      "data-testid": "probe",
      "data-pressed": String(pressed),
      style: { background: pressed ? pressBg : "var(--paper-2)" },
    });
  }

  it("reports pressed on pointer-down and clears it on up, leave and cancel", () => {
    const { getByTestId } = render(createElement(Probe, {}));
    const el = getByTestId("probe");
    expect(el.getAttribute("data-pressed")).toBe("false");

    fireEvent.pointerDown(el);
    expect(el.getAttribute("data-pressed")).toBe("true");
    expect(el.style.background).toBe(NEUTRAL_PRESS_BG);

    fireEvent.pointerUp(el);
    expect(el.getAttribute("data-pressed")).toBe("false");
    expect(el.style.background).toBe("var(--paper-2)");
  });

  it("clears on pointer-leave and on pointer-cancel", () => {
    for (const clear of ["pointerLeave", "pointerCancel"] as const) {
      const { getByTestId, unmount } = render(createElement(Probe, {}));
      const el = getByTestId("probe");
      fireEvent.pointerDown(el);
      expect(el.getAttribute("data-pressed")).toBe("true");

      fireEvent[clear](el);

      expect(el.getAttribute("data-pressed")).toBe("false");
      unmount();
    }
  });

  it("tracks the pressed KEY for a list that shares one hover state", () => {
    // The keyed half of the hook, which `ContextMenu` and `ImportSourcePicker`
    // depend on entirely: without it a menu whose rows share one `hoverId` would
    // paint every row pressed or none. Injection found this assertion missing.
    function ListProbe() {
      const { isPressed, handlersFor } = usePressSurface();
      return createElement(
        "div",
        null,
        ...["a", "b"].map((key) =>
          createElement("button", {
            key,
            ...handlersFor(key),
            "data-testid": `row-${key}`,
            "data-pressed": String(isPressed(key)),
          }),
        ),
      );
    }

    const { getByTestId } = render(createElement(ListProbe, {}));
    const rowA = getByTestId("row-a");
    const rowB = getByTestId("row-b");

    fireEvent.pointerDown(rowB);

    expect(rowB.getAttribute("data-pressed")).toBe("true");
    expect(rowA.getAttribute("data-pressed")).toBe("false");

    // A leave on the OTHER row must not clear the pressed one, which is what the
    // `k === key` guard in the clear callback is for.
    fireEvent.pointerLeave(rowA);
    expect(rowB.getAttribute("data-pressed")).toBe("true");

    fireEvent.pointerLeave(rowB);
    expect(rowB.getAttribute("data-pressed")).toBe("false");
  });

  it("never reports pressed when disabled, and attaches nothing", () => {
    const { getByTestId } = render(createElement(Probe, { disabled: true }));
    const el = getByTestId("probe");

    fireEvent.pointerDown(el);

    expect(el.getAttribute("data-pressed")).toBe("false");
    expect(el.style.background).toBe("var(--paper-2)");
  });

  it("survives a re-render while the pointer is down, which the mutation cannot", () => {
    // The whole reason the hook exists. A DOM mutation is erased by the next
    // render; the fact is React state, so it is re-applied.
    const { getByTestId, rerender } = render(createElement(Probe, {}));
    const el = getByTestId("probe");
    fireEvent.pointerDown(el);
    expect(el.style.background).toBe(NEUTRAL_PRESS_BG);

    rerender(createElement(Probe, {}));

    expect(el.getAttribute("data-pressed")).toBe("true");
    expect(el.style.background).toBe(NEUTRAL_PRESS_BG);
  });
});

describe("the press treatment, as a COMPUTED value", () => {
  /**
   * Reading `style.background` proves a write was attempted. Reading the computed
   * value proves the property is actually the one painting the element, which is
   * the distinction that matters: an inline `background` set on the element wins
   * over any stylesheet, and a press expressed as a stylesheet rule loses to it.
   * The class-based `.myne-btn` cannot be checked this way in jsdom, because
   * jsdom's `getComputedStyle` does not resolve `:active` at all; the surfaces
   * that CAN be checked here are the ones the primitives drive.
   */
  function computedAfterPress(): { resting: string; pressed: string } {
    const surface = interactiveSurface({ restBg: "transparent", hoverBg: "var(--bg-3)" });
    const { getByTestId } = render(
      createElement("button", { ...surface, "data-testid": "computed" }, "press me"),
    );
    const el = getByTestId("computed");
    const resting = getComputedStyle(el).background;
    fireEvent.pointerDown(el);
    return { resting, pressed: getComputedStyle(el).background };
  }

  it("changes the computed background on pointer-down", () => {
    const { resting, pressed } = computedAfterPress();

    expect(pressed).not.toBe(resting);
  });

  it("paints the press step itself, not just any different value", () => {
    const { pressed } = computedAfterPress();

    expect(pressed).toBe(NEUTRAL_PRESS_BG);
  });
});
