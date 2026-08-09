// Multi-line ornament boxes (myne#394).
//
// A callout or a blockquote is one box to the reader and N sibling line divs to
// CodeMirror. The role lands on every line, so without a segment marker a theme
// selecting `frame: thick` drew a complete frame around EACH line — a three-line
// callout came out as three stacked cards with a seam between every line. These
// pin both halves: the marker the editor emits, and the stylesheet rules that
// reassemble one box from it.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import { ornamentSegment } from "../../editor/src/decorations/ornament-segment";

const css = readFileSync(new URL("../../ornaments/src/ornaments.css", import.meta.url), "utf8");

describe("the segment marker", () => {
  it("marks a multi-line block's first, middle and last lines", () => {
    expect(ornamentSegment(10, 10, 13)["data-o-seg"]).toBe("start");
    expect(ornamentSegment(11, 10, 13)["data-o-seg"]).toBe("mid");
    expect(ornamentSegment(13, 10, 13)["data-o-seg"]).toBe("end");
  });

  it("marks a two-line block as start and end, with no middle", () => {
    expect(ornamentSegment(4, 4, 5)["data-o-seg"]).toBe("start");
    expect(ornamentSegment(5, 4, 5)["data-o-seg"]).toBe("end");
  });

  it("leaves a single-line block unmarked — it IS the whole box", () => {
    // Deliberate: the unqualified rules are already correct for a lone line, so
    // a `solo` value would have meant editing every existing rule to keep it
    // working. Absence is the common case and costs nothing.
    expect(ornamentSegment(7, 7, 7)["data-o-seg"]).toBeUndefined();
  });

  it("always carries the role, marked or not", () => {
    for (const attrs of [ornamentSegment(7, 7, 7), ornamentSegment(8, 7, 9)]) {
      expect(attrs["data-ornament"]).toBe("box");
    }
  });
});

describe("the stylesheet reassembles the box", () => {
  it("drops the top edge on every line that is not the top", () => {
    expect(css).toMatch(/\[data-o-seg="mid"\][\s\S]{0,120}--_o-fr-t:\s*0 0 #0000/);
  });

  it("drops the bottom edge and the drop shadow on every line that is not the bottom", () => {
    const block = /\[data-o-seg="start"\][\s\S]{0,200}?\{([\s\S]*?)\}/.exec(css);
    expect(block, "no start-segment rule").not.toBeNull();
    expect(block![1]).toContain("--_o-fr-b: 0 0 #0000");
    // The SIDEWAYS part of an offset shadow must survive — it is what makes the
    // block read as one card standing off the page rather than N cards.
    expect(block![1]).toContain("--_o-sh-y: 0");
  });

  it("keeps the shadow's horizontal offset out of the segment rules", () => {
    // Zeroing the whole shadow would flatten the block; only `y` is segmented.
    expect(css).not.toMatch(/\[data-o-seg[^{]*\{[^}]*--_o-shadow:/);
  });

  it("squares off the joins so a tall quote is not a stack of pills", () => {
    expect(css).toMatch(/\[data-o-seg="mid"\][^{]*\{[^}]*border-radius:\s*0/);
  });

  it("puts each fold at its own end of the block", () => {
    // `dogear` turns the TOP-right corner down; `folded` lifts the BOTTOM-right
    // one. One shared "not the start" rule put the dog-ear on the last line of
    // every callout, which is the bug this test exists for.
    const dogear = /fold="dogear"[\s\S]*?\{[\s\S]*?\}/.exec(css)?.[0] ?? "";
    expect(dogear).toContain('data-o-seg="end"');
    expect(dogear).not.toContain('data-o-seg="start"');
    const folded = /fold="folded"[\s\S]*?\{[\s\S]*?\}/.exec(css)?.[0] ?? "";
    expect(folded).toContain('data-o-seg="start"');
    expect(folded).not.toContain('data-o-seg="end"');
  });

  it("lets a punched left margin run the full height", () => {
    // A perforated margin is continuous by definition, so it is the one
    // decoration restored on every line rather than drawn once at an end.
    expect(css).toMatch(/perforation="left"[^{]*\[data-o-seg\][^{]*\{[\s\S]*?repeat-y/);
  });

  it("changes no geometry — the segment rules only remove paint", () => {
    // The paint-layer rule has to survive this whole mechanism: a rule here that
    // set padding, width or position would move a control that a theme dressed.
    const segRules = [...css.matchAll(/\[data-o-seg[^{]*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(segRules.length).toBeGreaterThan(4);
    for (const body of segRules) {
      expect(body).not.toMatch(/(?:^|;)\s*(padding|margin|width|height|inset|position|border-width|border-style)\s*:/);
    }
  });
});

describe("the `none` opt-out", () => {
  // `frame` and `shadow` write their slots on the HOST, and custom properties
  // inherit — so a box nested inside a framed surface inherits that frame. The
  // stylesheet's header documents `none` as the escape hatch; for a long time
  // nothing implemented it, and `ModalShell` (a surface) framed every
  // `SettingRow` (a box) inside it with no way for a theme to stop it.
  //
  // Removing the attribute cannot substitute: an absent attribute leaves the
  // inherited value in place. Only an explicit rule resets the slot.
  it("resets every frame edge, so a nested box can refuse an inherited frame", () => {
    const block = /\[data-o-box-frame="none"\][^{]*\{([^}]*)\}/.exec(css);
    expect(block, "no box frame=none rule").not.toBeNull();
    for (const slot of ["--_o-fr-t", "--_o-fr-r", "--_o-fr-b", "--_o-fr-l"]) {
      expect(block![1]).toContain(`${slot}: 0 0 #0000`);
    }
    // The recessed variant's inner shade rides its own slot and inherits too.
    expect(block![1]).toContain("--_o-frame-extra: 0 0 #0000");
  });

  it("resets the drop shadow", () => {
    const block = /\[data-o-box-shadow="none"\][^{]*\{([^}]*)\}/.exec(css);
    expect(block, "no box shadow=none rule").not.toBeNull();
    expect(block![1]).toContain("--_o-shadow: 0 0 #0000");
  });

  it("covers all three roles for both inheriting primitives", () => {
    for (const role of ["surface", "box", "chrome"]) {
      for (const primitive of ["frame", "shadow"]) {
        expect(
          css.includes(`[data-o-${role}-${primitive}="none"]`),
          `${role} ${primitive} has no none-reset`,
        ).toBe(true);
      }
    }
  });

  it("does NOT add reset rules for the six pseudo-element primitives", () => {
    // They draw on ::before/::after. A pseudo-element is not an ancestor, so
    // nothing inherits and an unselected slot already paints nothing — a rule
    // here would be dead weight that a future reader would have to explain.
    for (const primitive of ["texture", "ruled", "edge", "fold", "ribbon", "perforation"]) {
      expect(
        css.includes(`-${primitive}="none"]`) || css.includes(`-${primitive}="plain"]`),
        `${primitive} should need no none-reset`,
      ).toBe(false);
    }
  });
});
