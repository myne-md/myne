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
import { APPEARANCE_VARYING_TOKENS, readAppearanceCanon } from "../../src/lib/themeCanon";

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

// ── The canon seed ───────────────────────────────────────────────────────────
//
// A theme file is a PARTIAL palette: it carries the 21 required tokens plus
// whichever optional ones its author set, and the twelve shipped gallery themes
// carry 27 of the 44 colour tokens on average. Painting only the file's keys left
// the omitted families on the built-in LIGHT values, because `applyCustomTheme`
// drops `data-theme` first, so a dark theme came out with light-mode label chips
// and highlights. The fix seeds the omitted tokens from the canon for the
// appearance the theme DECLARES.
describe("applyCustomTheme seeds the appearance canon for omitted tokens", () => {
  let canon: HTMLStyleElement;

  beforeEach(() => {
    canon = installDefaults(`
      :root { --paper: #fbfbfa; --highlight: #f3e7c4; --label-clay: #b0543f; --syntax-keyword: #7a3b8c; }
      :root[data-theme="dark"] { --paper: #141412; --highlight: #4f4422; --label-clay: #d99683; --syntax-keyword: #c58cd8; }
    `);
  });

  afterEach(() => canon.remove());

  it("gives a DARK theme the dark canon for the families it omits", () => {
    applyCustomTheme({ "--paper": "#1e1e2e" });
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--paper")).toBe("#1e1e2e");
    // The three families a dark gallery theme omits, each of which used to arrive
    // as the light value.
    expect(root.style.getPropertyValue("--highlight")).toBe("#4f4422");
    expect(root.style.getPropertyValue("--label-clay")).toBe("#d99683");
    expect(root.style.getPropertyValue("--syntax-keyword")).toBe("#c58cd8");
  });

  it("gives a LIGHT theme the light canon", () => {
    applyCustomTheme({ "--paper": "#fdfdfc" });
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--highlight")).toBe("#f3e7c4");
    expect(root.style.getPropertyValue("--label-clay")).toBe("#b0543f");
  });

  it("never overrides a token the theme sets itself", () => {
    applyCustomTheme({ "--paper": "#1e1e2e", "--highlight": "#123456", "--label-clay": "#654321" });
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--highlight")).toBe("#123456");
    expect(root.style.getPropertyValue("--label-clay")).toBe("#654321");
  });

  it("reverts the seeded canon on clear, so a locked screen keeps none of it", () => {
    applyCustomTheme({ "--paper": "#1e1e2e" });
    clearCustomTheme();
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--paper")).toBe("");
    expect(root.style.getPropertyValue("--highlight")).toBe("");
    expect(root.style.getPropertyValue("--syntax-keyword")).toBe("");
  });

  it("readAppearanceCanon puts back the attribute it borrowed", () => {
    const root = document.documentElement;
    root.setAttribute("data-theme", "amoled");
    const dark = readAppearanceCanon(root, { "--paper": "#1e1e2e" });
    expect(root.getAttribute("data-theme")).toBe("amoled");
    expect(dark["--highlight"]).toBe("#4f4422");

    root.removeAttribute("data-theme");
    const light = readAppearanceCanon(root, { "--paper": "#fdfdfc" });
    expect(root.hasAttribute("data-theme")).toBe(false);
    expect(light["--highlight"]).toBe("#f3e7c4");
  });
});

// The COMPLETENESS half of the roster is `themeCanon.test.ts`, which derives the
// expected set from the sheet and the validator and compares both ways. What this
// one asserts is that a sheet declaring every roster token leaves none of them
// unpainted, which is the wiring the roster is useless without.
describe("the seed paints a value for every token in the roster", () => {
  let canon: HTMLStyleElement;
  beforeEach(() => {
    // The fixture's list IS the roster, deliberately: this test asserts the wiring
    // (a declared token reaches the root), and the roster's own completeness is
    // held to the sheet by `themeCanon.test.ts`. Spelling a second list here is
    // what made the first version of this test unable to fail.
    const light = APPEARANCE_VARYING_TOKENS.map((name) => `${name}: #111111;`).join(" ");
    const dark = APPEARANCE_VARYING_TOKENS.map((name) => `${name}: #222222;`).join(" ");
    canon = installDefaults(`:root { ${light} } :root[data-theme="dark"] { ${dark} }`);
  });
  afterEach(() => canon.remove());

  it("leaves no roster token unpainted for a dark theme, and paints the dark value", () => {
    // The defect this pins: the shipped gallery themes omit whole families, so a
    // theme that omits one must still end up with a value for it.
    applyCustomTheme({ "--paper": "#1e1e2e" });
    const root = document.documentElement;
    const missing = APPEARANCE_VARYING_TOKENS.filter((k) => root.style.getPropertyValue(k).trim() === "");
    expect(missing).toEqual([]);
    expect(root.style.getPropertyValue("--highlight-teal")).toBe("#222222");
  });

  it("falls back to the light canon when the theme carries no --paper", () => {
    // `isDarkBackground("")` is false by design, so an unreadable or absent
    // background takes the light canon rather than throwing.
    applyCustomTheme({ "--ink-1": "#111111" });
    expect(document.documentElement.style.getPropertyValue("--highlight-teal")).toBe("#111111");
  });
});
