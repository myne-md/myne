// The structural opacity ceiling (myne#394 task 7).
//
// This is the design's answer to the one gap the contrast gate cannot close: a
// ratio is computed over a colour pair and is blind to a pattern rendered
// between the glyphs and their background, so a theme could clear every WCAG
// floor and still bury its text under a texture. The mitigation is not another
// check — it is that the strength a theme asks for is composed through `min()`
// against a ceiling defined in Myne's own stylesheet, which a theme has no way
// to raise.
//
// These tests assert the MECHANISM rather than a rendered pixel: that the
// ceiling exists, that every behind-text primitive goes through it, and that
// nothing bypasses it with a raw strength or a hardcoded alpha.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../ornaments/src/ornaments.css", import.meta.url), "utf8");

/** The primitives that render behind text and therefore must be ceiling-bound.
 *
 * `tint` belongs here and was missing from this roster while three separate
 * documents claimed it was bound — which is exactly how it shipped unbounded.
 * A roster that lists less than the claim is worse than no roster. */
const BEHIND_TEXT = ["texture", "ruled", "tint"];

describe("the opacity ceiling", () => {
  it("is defined once, as a number a theme cannot reach", () => {
    const m = /--_o-ceiling:\s*([0-9.]+)/.exec(css);
    expect(m, "no --_o-ceiling declaration").not.toBeNull();
    const ceiling = Number(m![1]);
    expect(ceiling).toBeGreaterThan(0);
    // A texture worth more than this stops reading as grain and starts reading
    // as a second layer of content over the words.
    expect(ceiling).toBeLessThanOrEqual(0.2);
  });

  it("composes the theme's requested strength through min()", () => {
    // `min()` rather than a JS clamp, so the bound holds even if some future
    // path writes the variable without going through the host's apply.
    expect(css).toMatch(/--_o-strength:\s*min\(\s*var\(--tint-strength[^)]*\)\s*,\s*var\(--_o-ceiling\)\s*\)/);
  });

  it("routes every behind-text primitive through the bounded strength", () => {
    for (const primitive of BEHIND_TEXT) {
      // Three spellings reach the ceiling, and all three are legitimate: inline
      // `--_o-strength`, the tint's own `--_o-tint-bounded`, and `--_o-ink` (the
      // pattern ink, which mixes `--ink-1` AT `--_o-strength` so the patterns
      // invert with the palette instead of being fixed black — invisible on a
      // dark theme). What must never happen is a slot naming a colour with no
      // bound anywhere in its chain; `--_o-ink`'s own bound is pinned below.
      // Match the DECLARATION, not everything up to the end of its block: a
      // slice-to-block-end lets a later declaration in the same rule satisfy the
      // bound, which is the shape the ribbon test one function down was already
      // hardened against. Same bug, one test above the fix.
      const slot = new RegExp(`--_o-${primitive}(-bounded)?:[^;]*;`, "g");
      const blocks = css.match(slot) ?? [];
      expect(blocks.length, `no --_o-${primitive} rules found`).toBeGreaterThan(0);
      // **Per declaration, not over their join.** Joining them and matching the
      // result once means ONE unbounded declaration among ten bounded ones is
      // invisible — a `repeating-linear-gradient(#000 0 1px, transparent 1px 3px)`
      // in a single texture variant paints opaque black over a third of the area
      // behind body text and the whole suite stays green. That is the identical
      // shape as the slice-to-block-end bug the ribbon test one function down was
      // hardened against; this assertion had it one level up, in the test that
      // carries the bound for ten patterns at once.
      for (const decl of blocks) {
        expect(decl, `${primitive} declaration is unbounded: ${decl}`).toMatch(
          /var\(--_o-strength\)|--_o-tint-bounded|var\(--_o-ink\)|:\s*none\s*;/,
        );
      }
    }
  });

  it("bounds the pattern ink itself, since the patterns now defer to it", () => {
    // `--_o-ink` is the single indirection every texture and ruled ground draws
    // through, so it carries their whole bound. Unbounded here, all ten of those
    // patterns become unbounded at once and the test above still passes — which
    // is precisely the shape that let the tint wash ship without a ceiling.
    const m = /--_o-ink:\s*color-mix\(([\s\S]*?)\n\s*\);/.exec(css);
    expect(m, "no --_o-ink color-mix declaration").not.toBeNull();
    expect(m![1], "--_o-ink must mix at the bounded strength").toMatch(/--_o-strength/);
    expect(m![1], "--_o-ink must mix toward transparent").toMatch(/transparent/);
  });

  it("never hands the theme's raw tint colour to a paint slot", () => {
    // The specific regression: `--_o-tint: linear-gradient(var(--tint), …)`
    // paints `--tint: #000000` as an opaque rectangle behind every word, and the
    // contrast gate cannot see it.
    expect(css).not.toMatch(/--_o-tint:\s*linear-gradient\(\s*var\(--tint[,)]/);
    expect(css).toMatch(/--_o-tint-bounded:\s*color-mix\([\s\S]*--_o-strength/);
  });

  it("never hardcodes an alpha in a behind-text layer", () => {
    // A literal `rgb(0 0 0 / 0.5)` in one of these slots would bypass the
    // ceiling entirely and nothing else would notice.
    for (const primitive of BEHIND_TEXT) {
      const slot = new RegExp(`--_o-${primitive}:[\\s\\S]*?(?=\\n\\s*\\})`, "g");
      for (const block of css.match(slot) ?? []) {
        expect(block, `${primitive} must not carry a literal alpha`).not.toMatch(
          /\/\s*0?\.\d+\s*\)/,
        );
      }
    }
  });

  it("accounts for EVERY paint slot the stylesheet composes, bounded or not", () => {
    // The claim being pinned: `texture`, `ruled` and `tint` render as a FIELD
    // under the writing and are ceiling-bound; the other four paint opaque
    // colour bounded by GEOMETRY instead, sitting at the box's edge rather than
    // beneath its text.
    //
    // The point of reading the stylesheet is that the roster must be COMPLETE.
    // An earlier version of this test compared `BEHIND_TEXT` against a second
    // hardcoded list beside it and passed no matter what the CSS did — a
    // tautology over its own constant, in the one test whose job is to stop a
    // silent exemption. A primitive added to the composition and to neither
    // roster is exactly the case that must fail here.
    const composed = new Set(
      [...css.matchAll(/background:([^;]*);/g)]
        .flatMap(([, value]) => [...value.matchAll(/var\(--_o-([a-z-]+)/g)])
        .map(([, name]) => name),
    );
    expect(composed.size, "no background composition found — the stylesheet's shape changed").
      toBeGreaterThan(0);
    const EDGE_DECORATIONS = ["ribbon", "perforation", "edge", "fold"];
    const accounted = new Set([...BEHIND_TEXT, ...EDGE_DECORATIONS]);
    for (const slot of composed) {
      expect(
        accounted.has(slot),
        `--_o-${slot} is painted but claimed neither ceiling-bound nor edge-geometry — ` +
          "decide which, and say so in the roster",
      ).toBe(true);
    }
    // …and in the other direction: a roster entry no longer painted is a claim
    // about nothing.
    for (const slot of accounted) {
      expect(composed.has(slot), `--_o-${slot} is claimed but never painted`).toBe(true);
    }
  });

  it("leaves the four edge decorations unbounded, and that is deliberate", () => {
    // Stated as a test so the asymmetry is a decision rather than an oversight:
    // these do not go under text, so binding them would only make them
    // invisible — the ceiling is 0.14, and a torn edge at 14% opacity is a
    // smudge. Read the DECLARATIONS, not everything after the first mention of
    // the name: the multi-line-box rules clear `--_o-ribbon: none` well before
    // the ribbon variants are defined, so a slice-to-end swept in every
    // behind-text primitive that follows and asserted nothing.
    const decls = [...css.matchAll(/--_o-(ribbon|perforation|edge|fold):([^;]*);/g)]
      .map(([, , value]) => value)
      .join("\n");
    expect(decls.length, "no edge-decoration declarations found").toBeGreaterThan(0);
    expect(decls).not.toContain("--_o-strength");
    expect(decls).not.toContain("--_o-ink");
  });
});
