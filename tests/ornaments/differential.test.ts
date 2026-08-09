// @vitest-environment jsdom
//
// The two reflect implementations must agree — pinned, not assumed (myne#394).
//
// # Why this file exists
//
// There are two: `ornaments/src/roles.ts`, which the app uses and which knows
// its vocabulary at compile time; and `preview/src/apply.mjs`, which the website
// builder and the gallery renderer use and which derives its vocabulary from the
// captured STYLESHEET, because a Node CLI can import neither `.ts` nor
// `@myne/ornaments`. That split is deliberate and documented in both files.
//
// What was missing is any test that compares them. `on-flag.test.ts` exercises
// one, `myne-themes/tools/render-preview.test.mjs` exercises the other, and each
// passed while the pair disagreed — the same self-agreeing-check shape this
// feature has now hit five times. The divergences a reviewer found by diffing
// them over 334 palettes:
//
//   • a palette key `--seg` raised the on-flag in the preview and not in the
//     app, because the stylesheet's INTERNAL multi-line marker `data-o-seg` was
//     being scraped into the theme's vocabulary;
//   • sixteen `none`/`plain` cells were written by one and dropped by the other.
//
// # What the contract actually is
//
// **Not attribute-set equality.** The two answer different questions on purpose:
// the app reflects what its build recognizes, the preview reflects what its
// stylesheet can draw, and a value the app knows but this stylesheet has no rule
// for SHOULD differ. Demanding equality would force one of them to lie.
//
// What must agree is what a user can see and pay for:
//   1. **The on-flag.** It gates every rule in the sheet and costs `position:
//      relative` + `isolation: isolate` + two pseudo-element resolutions on every
//      role-bearing element. On in one and off in the other is a real divergence.
//   2. **Every attribute they BOTH emit** must carry the same value.
//   3. **Neither may emit an attribute outside the theme's channel** — the
//      internal segment marker is Myne's, not a theme's to set.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyOrnamentAttributes,
  ORNAMENT_ON_ATTR,
  ORNAMENT_TINT_ATTR,
} from "../../ornaments/src";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain ESM with JSDoc types, deliberately not TypeScript (see its header)
import { drawableOrnaments, ornamentAttributes } from "../../preview/src/apply.mjs";

// Resolved from the vitest root rather than `import.meta.url`: this file runs
// under jsdom (the flag's job is what a stylesheet can select), and there
// `import.meta.url` is not a `file:` URL.
const css = readFileSync(resolve(process.cwd(), "ornaments/src/ornaments.css"), "utf8");
const drawable = drawableOrnaments(css);

/** What the APP reflects, as a plain object, for the same palette. */
function appAttrs(palette: Record<string, string>): Record<string, string> {
  const el = document.createElement("div");
  applyOrnamentAttributes(el, palette);
  return Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));
}

/** What the PREVIEW reflects, for the same palette. */
function previewAttrs(palette: Record<string, string>): Record<string, string> {
  return ornamentAttributes(palette, drawable) as Record<string, string>;
}

/**
 * The corpus. Every shape that has ever diverged, plus the ordinary ones.
 *
 * Built from the stylesheet's own drawable set so it grows with the vocabulary
 * instead of freezing at whatever was true the day it was written.
 */
const CORPUS: Array<[string, Record<string, string>]> = [
  ["empty", {}],
  ["colour-only", { "--paper": "#fff", "--ink-1": "#000" }],
  ["one selection", { "--box-frame": "thick" }],
  ["tint only", { "--tint": "#c0392b" }],
  ["tint + strength", { "--tint": "#c0392b", "--tint-strength": "0.5" }],
  ["strength with no colour", { "--tint-strength": "0.5" }],
  ["all none", { "--box-frame": "none", "--surface-frame": "none", "--chrome-shadow": "none" }],
  ["none beside a selection", { "--surface-frame": "thick", "--box-frame": "none" }],
  // The two that diverged: `plain` is edge's no-op and `none` is frame's, so
  // each spelling on the wrong primitive is a value neither sheet draws.
  ["plain on a frame", { "--box-frame": "plain" }],
  ["none on an edge", { "--surface-edge": "none" }],
  ["plain on an edge", { "--surface-edge": "plain" }],
  // The internal segment marker, which is not a theme key at all.
  ["the segment marker", { "--seg": "start" }],
  ["segment marker beside a real selection", { "--seg": "mid", "--box-frame": "thick" }],
  // A refused role×primitive cell, and an unknown value.
  ["refused cell", { "--chrome-fold": "dogear" }],
  ["unknown value", { "--box-texture": "quilted" }],
  ["empty value", { "--box-frame": "" }],
  ["reserved namespace", { "--_o-ceiling": "1" }],
];

// …plus one palette per drawable cell, so a new primitive is covered the day it
// gains a rule rather than the day someone remembers this file.
for (const [attr, values] of drawable as Map<string, Set<string>>) {
  const token = `--${attr.replace(/^data-o-/, "")}`;
  for (const value of values) CORPUS.push([`${token}: ${value}`, { [token]: value }]);
}

describe("the app and the preview reflect the same decisions", () => {
  it.each(CORPUS)("agrees on the on-flag for %s", (_label, palette) => {
    const app = appAttrs(palette);
    const preview = previewAttrs(palette);
    expect(ORNAMENT_ON_ATTR in preview, "on-flag disagreement").toBe(ORNAMENT_ON_ATTR in app);
    expect(ORNAMENT_TINT_ATTR in preview, "tint-flag disagreement").toBe(
      ORNAMENT_TINT_ATTR in app,
    );
  });

  it.each(CORPUS)("agrees on the value of every attribute both emit, for %s", (_label, palette) => {
    const app = appAttrs(palette);
    const preview = previewAttrs(palette);
    for (const [attr, value] of Object.entries(preview)) {
      if (attr in app) expect(app[attr], `${attr} value disagreement`).toBe(value);
    }
  });

  it.each(CORPUS)("keeps the internal segment marker out of both, for %s", (_label, palette) => {
    // `data-o-seg` is the multi-line-box mechanism's own marker. A theme key
    // `--seg` passes `is_allowed_key`, `is_allowed_value` AND `is_known`, so it
    // merges through marketplace CI and survives the desktop read filter —
    // nothing upstream stops it, which is why it has to stop here.
    expect(appAttrs(palette)).not.toHaveProperty("data-o-seg");
    expect(previewAttrs(palette)).not.toHaveProperty("data-o-seg");
  });

  it("neither emits an attribute the stylesheet cannot draw", () => {
    // The preview's whole premise. The app is allowed to emit a `none` its own
    // build knows, so this is asserted of the preview alone — but if it ever
    // emitted something outside the drawable set, the attribute would sit in the
    // DOM matching nothing, which is the failure the module was extracted over.
    for (const [, palette] of CORPUS) {
      for (const [attr, value] of Object.entries(previewAttrs(palette))) {
        if (attr === ORNAMENT_ON_ATTR || attr === ORNAMENT_TINT_ATTR) continue;
        expect(
          (drawable as Map<string, Set<string>>).get(attr)?.has(value),
          `${attr}="${value}" is not drawable`,
        ).toBe(true);
      }
    }
  });
});
