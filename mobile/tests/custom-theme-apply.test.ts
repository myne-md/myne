// @vitest-environment jsdom
//
// The mobile custom-palette applier (MYND-598) — `applyCustomTheme` /
// `clearCustomTheme`, the CSSOM half of the read-only custom-theme consumer.
//
// jsdom because the whole module is a document-root mutation; there is nothing
// to test without one. No Tauri stub is needed — this layer never invokes.
//
// Two properties carry the weight here:
//
//   1. The SYNTAX FILL is per-role. A dark palette that defines only some of the
//      12 `--syntax-*` roles must get the rest aliased to the built-in dark ramp
//      and keep the ones it chose. Desktop shipped the all-or-nothing version of
//      this rule first and had to fix it again (MYND-356 → MYND-527); mobile
//      consumes the same shared derivation precisely so it inherits the fix
//      rather than the bug, and this asserts the shared module is actually wired
//      in — a resolution failure or a stale copy fails here, loudly.
//   2. The REVERT is exact. `clearCustomTheme` removes the keys the last apply
//      wrote and nothing else. It runs on lock, where "nothing else" is not
//      tidiness: over-removal breaks unrelated inline properties, and
//      under-removal leaves a locked screen wearing the vault's palette.

import { afterEach, describe, expect, it } from "vitest";

import { applyCustomTheme, clearCustomTheme, hasCustomTheme, resolveCustomPalette } from "../src/lib/customTheme";

const root = () => document.documentElement;
const prop = (key: string) => root().style.getPropertyValue(key);

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
  it("aliases only the syntax roles a dark palette omits, leaving its own alone", () => {
    const palette = darkPartialPalette();
    applyCustomTheme(palette);

    for (const role of OMITTED_ROLES) {
      expect(prop(`--syntax-${role}`)).toBe(`var(--_syntax-${role}-dark)`);
    }
    for (const role of DEFINED_ROLES) {
      expect(prop(`--syntax-${role}`)).toBe(palette[`--syntax-${role}`]);
    }
  });

  it("derives no syntax tokens for a light palette", () => {
    applyCustomTheme({ "--paper": "#fdfcf9", "--ink": "#1a1a1a" });

    for (const role of [...DEFINED_ROLES, ...OMITTED_ROLES]) {
      expect(prop(`--syntax-${role}`)).toBe("");
    }
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
  it("removes exactly the keys the last apply wrote, derived ones included", () => {
    applyCustomTheme(darkPartialPalette());
    clearCustomTheme();

    for (const role of [...DEFINED_ROLES, ...OMITTED_ROLES]) {
      expect(prop(`--syntax-${role}`)).toBe("");
    }
    expect(prop("--paper")).toBe("");
    expect(prop("--ink")).toBe("");
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

  it("is false for a palette that carried no `--*` key at all", () => {
    applyCustomTheme({ name: "not a token" });
    expect(hasCustomTheme()).toBe(false);
  });
});
