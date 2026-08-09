// The role contract + its agreement with the Rust vocabulary (myne#394 task 5).
//
// Stays on the `node` environment because it reads the stylesheet off disk.
// `applyOrnamentAttributes`'s runtime behaviour needs a real element and so
// lives in `on-flag.test.ts`, which is jsdom.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import {
  isOrnamentRole,
  ornamentRole,
  ornamentToken,
  ORNAMENT_PRIMITIVES,
  ORNAMENT_ROLES,
  ROLE_ATTR,
  roleAccepts,
} from "../../ornaments/src";

describe("roles", () => {
  it("declares exactly the three roles the vocabulary is scoped to", () => {
    expect([...ORNAMENT_ROLES]).toEqual(["surface", "box", "chrome"]);
  });

  it("produces the attribute the stylesheet selects on", () => {
    expect(ornamentRole("box")).toEqual({ [ROLE_ATTR]: "box" });
  });

  it("recognizes its own roles and nothing else", () => {
    for (const r of ORNAMENT_ROLES) expect(isOrnamentRole(r)).toBe(true);
    for (const r of ["sidebar", "callout", "", "Box"]) expect(isOrnamentRole(r)).toBe(false);
  });
});

describe("token naming", () => {
  it("matches the `--<role>-<primitive>` shape the Rust classifier parses", () => {
    expect(ornamentToken("box", "frame")).toBe("--box-frame");
    expect(ornamentToken("surface", "texture")).toBe("--surface-texture");
    expect(ornamentToken("chrome", "tint-strength")).toBe("--chrome-tint-strength");
  });
});


describe("primitive vocabulary", () => {
  it("carries the eight role-scoped primitives (the tint wash is not one)", () => {
    expect(Object.keys(ORNAMENT_PRIMITIVES)).toEqual([
      "frame",
      "shadow",
      "texture",
      "ruled",
      "edge",
      "fold",
      "ribbon",
      "perforation",
    ]);
  });

  it("uses no hyphenated VALUES, because the theme allowlist cannot express them", () => {
    // The bare-keyword arm of the value allowlist is ASCII letters only. A value
    // like `corner-tape` would need the allowlist widened — the trade this whole
    // design refuses — so the vocabulary is shaped around it instead.
    for (const [name, values] of Object.entries(ORNAMENT_PRIMITIVES)) {
      for (const v of values) {
        expect(v, `${name}: ${v}`).toMatch(/^[a-z]+$/);
      }
    }
  });

  it("gives every enumerated primitive a `none`-or-plain no-op value", () => {
    // A theme that selects nothing must render as before, so every primitive
    // needs an explicit way to say "draw nothing".
    for (const [name, values] of Object.entries(ORNAMENT_PRIMITIVES)) {
      expect(values.includes("none") || values.includes("plain"), `${name}`).toBe(true);
    }
  });
});

const css = readFileSync(new URL("../../ornaments/src/ornaments.css", import.meta.url), "utf8");

describe("the paint-layer rule, as written in the stylesheet", () => {
  // A weak but real regression guard: the mechanical proof (measuring a
  // control's hit rectangle with and without ornament) belongs to task 14 and
  // needs a real layout engine. What this catches is someone deleting the rules
  // that make that proof possible.
  it("neutralizes pointer events on both ornament layers", () => {
    expect(css).toMatch(/pointer-events:\s*none/);
  });

  it("takes the ornament layers out of flow", () => {
    expect(css).toMatch(/position:\s*absolute/);
    expect(css).toMatch(/inset:\s*0/);
  });

  it("matches nothing at all until a theme selects an ornament", () => {
    // The layer is scoped under a root flag the host sets only when the palette
    // carries a selection, so an unthemed session pays for no rule here.
    expect(css).toMatch(/:root\[data-o-on\]/);
  });

  it("keeps host content above the ornament with ONE stacking context", () => {
    // `isolation` on the host rather than `z-index` on every child: the role
    // lands on CM6 line divs, so promoting children would cost a PaintLayer per
    // syntax span on every quote and callout line, rebuilt per keystroke.
    expect(css).toMatch(/isolation:\s*isolate/);
    // Strip comments first: the header NAMES the rejected rule in order to
    // explain why it is rejected, and a bare grep would read that as the rule.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toMatch(/\[data-ornament\]\s*>\s*\*/);
  });

  it("honours reduced motion", () => {
    expect(css).toMatch(/prefers-reduced-motion/);
  });
});

describe("primitive set A is drawn for every value it declares", () => {
  const SET_A = ["frame", "shadow", "edge", "fold"];

  it("has a rule per role per non-`none` value", () => {
    // The vocabulary and the stylesheet are two lists that must agree, and
    // nothing but this test says so: a value with no rule is a theme setting
    // that silently does nothing.
    for (const primitive of SET_A) {
      for (const value of ORNAMENT_PRIMITIVES[primitive]) {
        if (value === "none" || value === "plain") continue;
        for (const role of ORNAMENT_ROLES) {
          const selector = `[data-o-${role}-${primitive}="${value}"]`;
          // The matrix is SPARSE: a role draws only the primitives it accepts.
          // A rule for a pair the vocabulary refuses is worse than a missing one
          // — the gallery renderer derives its behaviour from these selectors,
          // so a dead rule there draws ornament the app then drops on install.
          if (roleAccepts(role, primitive)) {
            expect(css, `${role}/${primitive}=${value} is accepted but not drawn`).toContain(
              selector,
            );
          } else {
            expect(css, `${role}/${primitive}=${value} is refused but still drawn`).not.toContain(
              selector,
            );
          }
        }
      }
    }
  });

  it("draws frame as an inset shadow, never a border", () => {
    // A border changes the box; ornament may not. If this ever regresses, a
    // themed control moves and the paint-layer guarantee is gone.
    expect(css).not.toMatch(/\n\s*border(-width|-style)?:/);
    // The frame is composed from four EDGE slots (`--_o-fr-t/r/b/l`) rather than
    // one ring, so a multi-line box can drop its top and bottom on the lines
    // that are not its ends. Still inset shadows — still never a border.
    expect(css).toMatch(/--_o-fr-t:\s*inset/);
    expect(css).toMatch(/--_o-fr-b:\s*inset/);
  });

  it("composes frame and shadow rather than letting one replace the other", () => {
    // Every edge slot, then the extra (the recessed variant's inner shade),
    // then the drop shadow — one declaration, so selecting a frame AND a shadow
    // composes instead of one silently winning.
    expect(css).toMatch(
      /box-shadow:\s*var\(--_o-fr-t[\s\S]*var\(--_o-fr-b[\s\S]*var\(--_o-shadow/,
    );
  });

  it("never clips the host, which would clip its hit area", () => {
    expect(css).not.toMatch(/clip-path:/);
  });
});

describe("every declared value is drawn, and nothing else is", () => {
  // The vocabulary and the stylesheet are two lists that must agree, and nothing
  // else says so: a value with no rule is a theme setting that silently does
  // nothing. Driven off ORNAMENT_PRIMITIVES rather than a hand-kept roster, so a
  // new primitive is covered the moment it is declared.
  //
  // Both directions matter, and the second one was learned the hard way. The
  // role matrix is SPARSE, and when it narrowed from 24 cells to 18 the
  // stylesheet kept all 24 — dead from the app's side, and very much alive from
  // the gallery's, because `myne-themes/tools/render-preview.mjs` derives what
  // it reflects from these selectors. A submitted theme could draw a dog-eared
  // tab on its gallery card that the app then refuses on install.
  it("has a rule for exactly the role×primitive pairs the vocabulary accepts", () => {
    for (const [primitive, values] of Object.entries(ORNAMENT_PRIMITIVES)) {
      for (const value of values) {
        if (value === "none" || value === "plain") continue;
        for (const role of ORNAMENT_ROLES) {
          const selector = `[data-o-${role}-${primitive}="${value}"]`;
          if (roleAccepts(role, primitive)) {
            expect(css, `${role}/${primitive}=${value} is accepted but not drawn`).toContain(
              selector,
            );
          } else {
            expect(css, `${role}/${primitive}=${value} is refused but still drawn`).not.toContain(
              selector,
            );
          }
        }
      }
    }
  });

  it("gives the CRT/scanline effect as a texture value, not a feature of its own", () => {
    expect(css).toContain('[data-o-box-texture="scanline"]');
  });

  it("draws frame as an inset shadow, never a border", () => {
    // A border changes the box; ornament may not. If this regresses, a themed
    // control moves and the paint-layer guarantee is gone.
    expect(css).not.toMatch(/\n\s*border(-width|-style)?:/);
    // The frame is composed from four EDGE slots (`--_o-fr-t/r/b/l`) rather than
    // one ring, so a multi-line box can drop its top and bottom on the lines
    // that are not its ends. Still inset shadows — still never a border.
    expect(css).toMatch(/--_o-fr-t:\s*inset/);
    expect(css).toMatch(/--_o-fr-b:\s*inset/);
  });

  it("composes frame and shadow rather than letting one replace the other", () => {
    // Every edge slot, then the extra (the recessed variant's inner shade),
    // then the drop shadow — one declaration, so selecting a frame AND a shadow
    // composes instead of one silently winning.
    expect(css).toMatch(
      /box-shadow:\s*var\(--_o-fr-t[\s\S]*var\(--_o-fr-b[\s\S]*var\(--_o-shadow/,
    );
  });

  it("never clips the host, which would clip its hit area", () => {
    expect(css).not.toMatch(/clip-path:/);
  });

  it("stacks both layers through var-composition so primitives do not overwrite", () => {
    expect(css).toMatch(/background:\s*var\(--_o-edge[\s\S]*var\(--_o-tint/);
    expect(css).toMatch(/background:\s*var\(--_o-ribbon[\s\S]*var\(--_o-fold/);
  });

  // The composition must be the `background` SHORTHAND, and this test is here
  // because the version that was not shipped green: most slots hold a whole
  // background layer (`<image> <position> / <size> <repeat>`), which is invalid
  // in `background-image` and takes the entire declaration — including the
  // valid slots beside it — down with it. Eleven of eighteen ornament variants
  // drew nothing, and the composition test above still passed, because it
  // checked that the slots were composed and never that anything was painted.
  it("composes into the shorthand, because most slots carry a full layer", () => {
    const slotted = [...css.matchAll(/--_o-(edge|texture|ruled|fold|ribbon|perforation):([^;]*);/g)];
    expect(slotted.length).toBeGreaterThan(10);
    const layered = slotted.filter(([, , v]) => /\/\s*\d|repeat|no-repeat/.test(v));
    expect(layered.length).toBeGreaterThan(0);
    // Whenever any slot carries position/size/repeat, `background-image` cannot
    // be the composing property for the layer that slot feeds.
    expect(css).not.toMatch(/background-image:\s*var\(--_o-/);
  });
});
