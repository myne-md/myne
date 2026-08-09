// @vitest-environment jsdom
//
// `applyCustomTheme` + the measure clamp, at the integration seam (myne#394 task 3).
//
// The clamp arithmetic itself is covered by `themeMeasure.test.ts`; what is
// asserted here is the wiring the arithmetic is useless without — that a measure
// value is bounded on the way to the CSSOM, that a value with no establishable
// bound is skipped rather than painted, and that `clearCustomTheme` reverts what
// was actually written (which, after clamping, is not what the palette said).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyCustomTheme, clearCustomTheme } from "../../src/lib/theme";

/** Stand in for `tokens.css`, which no test environment loads. */
function installDefaults(css: string): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  return style;
}

let sheet: HTMLStyleElement | null = null;

beforeEach(() => {
  sheet = installDefaults(":root { --space-4: 16px; --weight-medium: 500; }");
});

afterEach(() => {
  clearCustomTheme();
  sheet?.remove();
  sheet = null;
  document.documentElement.removeAttribute("data-theme");
});

describe("applyCustomTheme", () => {
  it("paints colour keys verbatim", () => {
    applyCustomTheme({ "--paper": "#fbfbfa", "--ink-1": "#1a1a17" });
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--paper")).toBe("#fbfbfa");
    expect(root.style.getPropertyValue("--ink-1")).toBe("#1a1a17");
  });

  it("bounds an oversized measure value instead of painting it", () => {
    // The failure the envelope exists for: a theme asking for 25× the default
    // spacing would leave no room for content at all.
    applyCustomTheme({ "--space-4": "400px" });
    expect(document.documentElement.style.getPropertyValue("--space-4")).toBe("32px");
  });

  it("bounds an undersized measure value", () => {
    applyCustomTheme({ "--weight-medium": "10" });
    expect(document.documentElement.style.getPropertyValue("--weight-medium")).toBe("250");
  });

  it("skips a measure key whose bound cannot be established", () => {
    // No `--radius-2` default is installed here, so there is no band. Painting
    // it unbounded is exactly what must not happen.
    applyCustomTheme({ "--radius-2": "80px", "--paper": "#fff" });
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--radius-2")).toBe("");
    expect(root.style.getPropertyValue("--paper")).toBe("#fff");
  });

  it("drops the built-in data-theme attribute", () => {
    document.documentElement.setAttribute("data-theme", "dark");
    applyCustomTheme({ "--paper": "#111" });
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});

describe("clearCustomTheme", () => {
  it("reverts a clamped measure key, not just the colours", () => {
    // The revert list is built from what was WRITTEN, so a key whose painted
    // value differs from the palette's must still come off. A revert keyed off
    // the palette would leave this one behind — and a stale measure token on a
    // locked screen is exactly the A6 leak the clear exists to prevent.
    applyCustomTheme({ "--paper": "#111", "--space-4": "400px" });
    expect(document.documentElement.style.getPropertyValue("--space-4")).toBe("32px");
    clearCustomTheme();
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--space-4")).toBe("");
    expect(root.style.getPropertyValue("--paper")).toBe("");
  });

  it("is idempotent", () => {
    applyCustomTheme({ "--paper": "#111" });
    clearCustomTheme();
    clearCustomTheme();
    expect(document.documentElement.style.getPropertyValue("--paper")).toBe("");
  });
});

describe("ornament reflection", () => {
  it("reflects a recognized selection onto the root as an attribute", () => {
    // CSS cannot branch on a custom property's value, so the selection has to
    // reach a selector some other way. This is that way.
    applyCustomTheme({ "--box-frame": "thick", "--chrome-shadow": "offset" });
    const root = document.documentElement;
    expect(root.getAttribute("data-o-box-frame")).toBe("thick");
    expect(root.getAttribute("data-o-chrome-shadow")).toBe("offset");
  });

  it("skips a value this build does not recognize", () => {
    applyCustomTheme({ "--box-frame": "banana" });
    expect(document.documentElement.hasAttribute("data-o-box-frame")).toBe(false);
  });

  it("removes ornament attributes on clear, not just the variables", () => {
    // A leftover attribute would keep a locked screen wearing the vault's
    // ornament — the same A6 leak the variable clear exists to prevent.
    applyCustomTheme({ "--box-frame": "thick" });
    clearCustomTheme();
    expect(document.documentElement.hasAttribute("data-o-box-frame")).toBe(false);
  });

  it("reflects the tint wash's own flag, which is what opens its layer", () => {
    // The wash is not role-scoped and carries no enumerated variant, so the
    // stylesheet reads `--tint` through `var()` directly — and this test used to
    // assert that it therefore reflected NO attribute at all. That was wrong in
    // a way nothing caught: the `::before` layer is `display: none` until a rule
    // selects it, and CSS cannot branch on whether a custom property is set, so
    // a tint-only theme painted its colour onto a layer that was never
    // displayed. It rendered only when some other `::before` primitive happened
    // to be selected and opened the layer for it — which is why "tint" and
    // "tint plus a texture" looked identical. Measured in a browser.
    applyCustomTheme({ "--tint": "#ff0000", "--tint-strength": "0.4" });
    const root = document.documentElement;
    expect(root.hasAttribute("data-o-tint")).toBe(true);
    expect(root.hasAttribute("data-o-on")).toBe(true);
    expect(root.style.getPropertyValue("--tint")).toBe("#ff0000");
  });

  it("raises neither flag for a strength with no colour to wash", () => {
    // `--tint` is the whole condition. A strength alone has nothing to apply
    // itself to, and opening the layer for it would cost every role-bearing
    // element a pseudo-element resolution to paint nothing.
    applyCustomTheme({ "--tint-strength": "0.4" });
    const root = document.documentElement;
    expect(root.hasAttribute("data-o-tint")).toBe(false);
    expect(root.hasAttribute("data-o-on")).toBe(false);
  });

  it("clears the tint flag too, so a locked screen wears no wash", () => {
    applyCustomTheme({ "--tint": "#ff0000" });
    clearCustomTheme();
    const root = document.documentElement;
    expect(root.hasAttribute("data-o-tint")).toBe(false);
    expect(root.hasAttribute("data-o-on")).toBe(false);
  });

  it("refuses to carry the layer's own internal variables", () => {
    // `--_o-*` passes the key grammar (`_` is allowed) and would otherwise reach
    // `:root`, where `--_o-ceiling` is the bound the tint wash is clamped by.
    // The host filters the prefix; this pins that it stays filtered.
    applyCustomTheme({ "--paper": "#fff", "--_o-ceiling": "1" } as Record<string, string>);
    expect(document.documentElement.style.getPropertyValue("--_o-ceiling")).toBe("");
  });
});
