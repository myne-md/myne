// @vitest-environment jsdom
//
// `applyOrnamentAttributes` and the on-flag (myne#394).
//
// Every rule in `ornaments.css` is scoped under `:root[data-o-on]`, so this flag
// is not bookkeeping — it is the difference between an ornament DRAWING and an
// ornament being validated, stored, synced and invisible. jsdom rather than the
// suite's default `node` environment because the flag's whole job is what a
// stylesheet can then select; asserting it against a stand-in object would test
// the bookkeeping and not the thing that broke.

import { describe, expect, it } from "vitest";
import {
  applyOrnamentAttributes,
  clearOrnamentAttributes,
  ORNAMENT_ON_ATTR,
  ORNAMENT_TINT_ATTR,
} from "../../ornaments/src";

const root = () => document.createElement("div");

describe("the on-flag", () => {
  it("turns the layer on for a role-scoped selection", () => {
    const el = root();
    expect(applyOrnamentAttributes(el, { "--box-frame": "thick" })).toBe(true);
    expect(el.getAttribute("data-o-box-frame")).toBe("thick");
    expect(el.hasAttribute(ORNAMENT_ON_ATTR)).toBe(true);
  });

  it("gives a tint-only palette BOTH the on-flag and the tint attribute", () => {
    // Two separate regressions, found one after the other. First: keying the
    // flag off the attribute COUNT alone left a tint-only theme with no flag at
    // all. Second, found by looking at the rendered result rather than the DOM:
    // the flag alone is not enough, because the `::before` layer is
    // `display: none` until some rule selects it — and CSS cannot branch on
    // whether `--tint` is set, so the wash needs a state of its own. Without it
    // a tint-only theme drew NOTHING, and "tint plus a texture" looked identical
    // to "just a texture".
    const el = root();
    expect(applyOrnamentAttributes(el, { "--tint": "#ff5cae", "--tint-strength": "0.1" })).toBe(
      true,
    );
    expect(el.hasAttribute(ORNAMENT_ON_ATTR)).toBe(true);
    expect(el.hasAttribute(ORNAMENT_TINT_ATTR)).toBe(true);
  });

  it("stays off for a colour-only palette — every theme published before this vocabulary", () => {
    // The flag exists to keep those themes from paying for a `position`, two
    // pseudo-element style resolutions and a `box-shadow` per role-bearing
    // element, so turning it on unconditionally would be a real regression.
    const el = root();
    expect(applyOrnamentAttributes(el, { "--accent": "#ff5cae", "--paper": "#ffffff" })).toBe(false);
    expect(el.hasAttribute(ORNAMENT_ON_ATTR)).toBe(false);
  });

  it("stays off for a strength with no colour to wash", () => {
    const el = root();
    expect(applyOrnamentAttributes(el, { "--tint-strength": "0.1" })).toBe(false);
    expect(el.hasAttribute(ORNAMENT_ON_ATTR)).toBe(false);
  });

  it("ignores an unknown variant rather than flagging the layer on for it", () => {
    const el = root();
    expect(applyOrnamentAttributes(el, { "--box-frame": "quilted" })).toBe(false);
    expect(el.hasAttribute("data-o-box-frame")).toBe(false);
    expect(el.hasAttribute(ORNAMENT_ON_ATTR)).toBe(false);
  });

  it("clears the flag along with the attributes, so a locked screen wears neither", () => {
    // A leftover flag is an A6 leak of exactly the kind a leftover palette
    // variable is: the vault's ornament, still on screen, after lock.
    const el = root();
    applyOrnamentAttributes(el, { "--box-frame": "thick", "--tint": "#ff5cae" });
    clearOrnamentAttributes(el);
    expect(el.hasAttribute(ORNAMENT_ON_ATTR)).toBe(false);
    expect(el.hasAttribute(ORNAMENT_TINT_ATTR)).toBe(false);
    expect(el.hasAttribute("data-o-box-frame")).toBe(false);
  });

  it("stays off for a palette whose every ornament key is `none` — an explicit opt-out", () => {
    // `none` and `plain` are WRITTEN (the two inheriting primitives need an
    // explicit reset) but they are not a SELECTION. Keying the flag off the
    // attribute COUNT made this palette pay for the whole layer: `position:
    // relative`, `isolation: isolate` and two pseudo-element resolutions on
    // every role-bearing element, to draw nothing. Reverting the fix left the
    // suite green, so the correct behaviour was unpinned.
    const el = root();
    applyOrnamentAttributes(el, {
      "--surface-frame": "none",
      "--box-frame": "none",
      "--chrome-shadow": "none",
    });
    expect(el.hasAttribute(ORNAMENT_ON_ATTR)).toBe(false);
    // …and the resets themselves are still written, because that is what makes
    // a nested box able to refuse an ancestor's frame.
    expect(el.getAttribute("data-o-box-frame")).toBe("none");
  });

  it("turns on when a real selection sits beside a `none`", () => {
    const el = root();
    applyOrnamentAttributes(el, { "--surface-frame": "thick", "--box-frame": "none" });
    expect(el.hasAttribute(ORNAMENT_ON_ATTR)).toBe(true);
  });
});
