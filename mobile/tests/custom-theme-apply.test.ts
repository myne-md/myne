// @vitest-environment jsdom
//
// The mobile custom-palette applier (MYND-598) — `applyCustomTheme` /
// `clearCustomTheme`, the CSSOM half of the read-only custom-theme consumer.
//
// jsdom because the applier is a document-root mutation; there is nothing to
// test without one. No Tauri stub is needed: the module's unlock-path
// orchestrator (`paintSelectedCustomTheme`) is the only part that invokes, and
// it is not exercised here — importing the IPC wrappers is inert.
//
// Two properties carry the weight here:
//
//   1. The CANON SEED is per-token and appearance-correct. A theme is a partial
//      palette: every optional token it omits (the syntax roles, the label
//      colours, the highlights) must come from the built-in canon for the
//      appearance the palette DECLARES, and a token it does set must keep the
//      author's value. Mobile consumes the shared rule
//      (`@myne/theme-canon`, the same module desktop paints through) precisely so
//      the two clients cannot disagree, and this asserts it is actually wired in.
//      A resolution failure or a stale copy fails here, loudly.
//   2. The REVERT is exact. `clearCustomTheme` removes the keys the last apply
//      wrote and nothing else. It runs on lock, where "nothing else" is not
//      tidiness: over-removal breaks unrelated inline properties, and
//      under-removal leaves a locked screen wearing the vault's palette.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyCustomTheme, clearCustomTheme, hasCustomTheme, resolveCustomPalette } from "../src/lib/customTheme";

const root = () => document.documentElement;
const prop = (key: string) => root().style.getPropertyValue(key);

/** Stand in for the token sheet, which no test environment loads. */
function installDefaults(css: string): HTMLStyleElement {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  return style;
}

/** The built-in canon for one appearance, as the sheet would declare it. */
function canonSheet(): HTMLStyleElement {
  return installDefaults(`
    :root { --highlight: #f3e7c4; --label-clay: #b0543f; --syntax-property: #6a5a8c; --syntax-invalid: #b03030; }
    :root[data-theme="dark"] { --highlight: #4f4422; --label-clay: #d99683; --syntax-property: #9a8cc0; --syntax-invalid: #e06060; }
  `);
}

/** The 5 roles the shipped gallery themes define; the other 7 are the fill set. */
const DEFINED_ROLES = ["keyword", "string", "comment", "number", "variable"] as const;
const OMITTED_ROLES = [
  "property",
  "function",
  "type",
  "operator",
  "tag",
  "meta",
  "invalid",
] as const;

const darkPartialPalette = (): Record<string, string> => ({
  "--paper": "#14161a",
  "--ink": "#e6e8ec",
  ...Object.fromEntries(DEFINED_ROLES.map((r, i) => [`--syntax-${r}`, `#a${i}b0c0`])),
});

afterEach(() => {
  clearCustomTheme();
  root().removeAttribute("data-theme");
  root().removeAttribute("style");
});

describe("applyCustomTheme", () => {
  it("seeds a DARK palette's omitted tokens from the dark canon, keeping its own", () => {
    const sheet = canonSheet();
    try {
      const palette = darkPartialPalette();
      applyCustomTheme(palette);

      // A token the theme omits takes the canon for ITS appearance: on a dark
      // background that is the dark value, not the light one `:root` would
      // otherwise expose once `data-theme` is dropped.
      expect(prop("--syntax-property")).toBe("#9a8cc0");
      expect(prop("--label-clay")).toBe("#d99683");
      expect(prop("--highlight")).toBe("#4f4422");
      // A token the theme defines keeps the author's value.
      for (const role of DEFINED_ROLES) {
        expect(prop(`--syntax-${role}`)).toBe(palette[`--syntax-${role}`]);
      }
    } finally {
      sheet.remove();
    }
  });

  it("seeds a LIGHT palette's omitted tokens from the light canon", () => {
    const sheet = canonSheet();
    try {
      applyCustomTheme({ "--paper": "#fdfcf9", "--ink": "#1a1a1a" });

      expect(prop("--syntax-property")).toBe("#6a5a8c");
      expect(prop("--label-clay")).toBe("#b0543f");
      expect(prop("--paper")).toBe("#fdfcf9");
    } finally {
      sheet.remove();
    }
  });

  it("paints only the palette when no sheet declares a canon", () => {
    // The seed must not invent values: with no token sheet there is nothing to
    // read, and the behaviour is exactly what it was before the seed existed.
    applyCustomTheme({ "--paper": "#fdfcf9" });

    expect(prop("--syntax-property")).toBe("");
    expect(prop("--paper")).toBe("#fdfcf9");
  });

  it("drops the built-in data-theme attribute", () => {
    root().setAttribute("data-theme", "dark");
    applyCustomTheme({ "--paper": "#14161a" });

    expect(root().hasAttribute("data-theme")).toBe(false);
  });

  it("writes only `--*` keys", () => {
    applyCustomTheme({ "--paper": "#14161a", color: "red", name: "midnight" });

    expect(prop("--paper")).toBe("#14161a");
    expect(root().style.getPropertyValue("color")).toBe("");
    expect(root().style.getPropertyValue("name")).toBe("");
  });

  it("reverts the previous palette's keys when a second palette is applied", () => {
    applyCustomTheme({ "--paper": "#14161a", "--accent": "#ff8800" });
    applyCustomTheme({ "--paper": "#fdfcf9" });

    expect(prop("--paper")).toBe("#fdfcf9");
    expect(prop("--accent")).toBe("");
  });
});

describe("clearCustomTheme", () => {
  it("removes exactly the keys the last apply wrote, seeded ones included", () => {
    const sheet = canonSheet();
    try {
      applyCustomTheme(darkPartialPalette());
      clearCustomTheme();

      for (const role of [...DEFINED_ROLES, ...OMITTED_ROLES]) {
        expect(prop(`--syntax-${role}`)).toBe("");
      }
      expect(prop("--label-clay")).toBe("");
      expect(prop("--highlight")).toBe("");
      expect(prop("--paper")).toBe("");
      expect(prop("--ink")).toBe("");
    } finally {
      sheet.remove();
    }
  });

  it("leaves unrelated inline custom properties untouched", () => {
    root().style.setProperty("--kbd-inset", "12px");
    applyCustomTheme({ "--paper": "#14161a" });
    clearCustomTheme();

    expect(prop("--kbd-inset")).toBe("12px");
  });

  it("is a no-op when nothing was applied", () => {
    root().style.setProperty("--kbd-inset", "12px");
    clearCustomTheme();
    clearCustomTheme();

    expect(prop("--kbd-inset")).toBe("12px");
  });
});

// The unlock-path resolution rule (MYND-598 task 5). Pure on purpose: the
// interesting behaviour is "which palette, if any" and it must be assertable
// without a document, a host or a screen.
//
// Its load-bearing case is the DANGLING selection — a theme deleted on the
// computer whose name still sits in this phone's `custom_theme` pref. The answer
// is `null` (fall back to the built-in choice) and, crucially, the caller must
// not "repair" the pref: a desktop re-add clears the deletion tombstone, so the
// next sync round revives the theme and the phone paints it again with no user
// action. Rewriting the pref here would destroy that revival property, and it
// would delete a device-local preference the user never touched on evidence that
// arrived from another device.
describe("resolveCustomPalette", () => {
  const entries = [
    { name: "Zinc", palette: { "--paper": "#101014" } },
    { name: "amber dusk", palette: { "--paper": "#fdf6e3" } },
  ];

  it("returns the named theme's palette", () => {
    expect(resolveCustomPalette("amber dusk", entries)).toEqual({ "--paper": "#fdf6e3" });
  });

  it("returns null when no theme is selected", () => {
    expect(resolveCustomPalette(null, entries)).toBeNull();
  });

  it("returns null when the selection names a theme that is gone", () => {
    expect(resolveCustomPalette("Solarized", entries)).toBeNull();
  });

  it("returns null when the list is empty, selection or not", () => {
    expect(resolveCustomPalette("Zinc", [])).toBeNull();
  });

  it("matches the name exactly — theme names are store keys, not labels", () => {
    expect(resolveCustomPalette("zinc", entries)).toBeNull();
    expect(resolveCustomPalette("Zinc ", entries)).toBeNull();
  });
});

describe("hasCustomTheme", () => {
  it("is false before any apply and true while a palette is on the root", () => {
    expect(hasCustomTheme()).toBe(false);
    applyCustomTheme({ "--paper": "#14161a" });
    expect(hasCustomTheme()).toBe(true);
  });

  it("goes back to false once the palette is cleared", () => {
    applyCustomTheme({ "--paper": "#14161a" });
    clearCustomTheme();
    expect(hasCustomTheme()).toBe(false);
  });

  it("is true after an apply that painted only the canon, and false with no sheet", () => {
    // Since the canon seed (myne-md/myne#900) an apply paints the canon for the
    // declared appearance even when the palette names no token, so the predicate
    // answers "did an apply run". This file installs no token sheet, which is the
    // one case where nothing at all is painted and it stays false.
    applyCustomTheme({ name: "not a token" });
    expect(hasCustomTheme()).toBe(false);

    const sheet = canonSheet();
    try {
      applyCustomTheme({ name: "not a token" });
      expect(hasCustomTheme()).toBe(true);
      expect(prop("--highlight")).toBe("#f3e7c4");
    } finally {
      sheet.remove();
      clearCustomTheme();
    }
  });
});
