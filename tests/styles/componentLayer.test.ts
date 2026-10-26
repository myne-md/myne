// Contracts of the shared component layer (`@myne/client-core/components.css`,
// myne-md/myne#773).
//
// These are CSS assertions, and they live in their own file for the reason the
// segmented-selection spec does: jsdom does not apply an external stylesheet, so
// a component test can see an element's class and cannot see that the rule keyed
// off it paints anything. Each case below is a defect that shipped, or a rule
// whose deletion would silently restore one.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHEET: string = readFileSync(
  fileURLToPath(new URL("../../client-core/src/components.css", import.meta.url)),
  "utf8",
);
const TOKENS: string = readFileSync(
  fileURLToPath(new URL("../../client-core/src/tokens.css", import.meta.url)),
  "utf8",
);

/** The declaration body of the first rule whose selector text contains `needle`. */
function ruleBody(sheet: string, needle: string): string {
  const at = sheet.indexOf(needle);
  expect(at, `no rule matching ${needle}`).toBeGreaterThan(-1);
  const open = sheet.indexOf("{", at);
  const close = sheet.indexOf("}", open);
  return sheet.slice(open + 1, close);
}

describe("every interactive primitive answers a pointer", () => {
  it("gives the modal close button a hover AND a focus state", () => {
    // It had NEITHER. `CLOSE_BUTTON_STYLE` was a static inline object, so every
    // modal in the app answered a pointer over its × with nothing — on the one
    // control whose entire job is to be found in a hurry. A component styled
    // inline cannot express `:hover`, which is why this went unfixed rather
    // than unnoticed.
    const body = ruleBody(SHEET, ".myne-modal-close:hover,");
    expect(body).toContain("background: var(--bg-3)");
    expect(SHEET).toContain(".myne-modal-close:focus-visible");
  });

  it("pairs :focus-visible with :hover on the icon button", () => {
    // Hover came from an `onMouseEnter` handler, so a keyboard user tabbing
    // onto an icon-only control got the ring and no surface change. On a rail
    // of identical glyphs the ring alone is a weak "you are here".
    expect(SHEET).toContain(".myne-icon-btn:enabled:focus-visible");
  });

  it("gives every button variant a press state, not only primary", () => {
    // The React version tracked `press` and then used it for `primary` alone,
    // and drove it from `mousedown` — so three of four variants answered a
    // click with nothing, and NO variant answered a keyboard activation.
    // `:active` fires on Space and Enter; a mousedown handler does not.
    for (const variant of ["primary", "secondary", "ghost", "danger"]) {
      expect(
        SHEET,
        `the ${variant} button has no :active state`,
      ).toContain(`.myne-btn[data-variant="${variant}"]:enabled:active`);
    }
  });

  it("keeps press feedback at the instant duration", () => {
    // A press that takes a normal transition to register reads as the control
    // deciding whether to respond.
    expect(ruleBody(SHEET, ".myne-btn:enabled:active")).toContain(
      "var(--duration-instant)",
    );
  });

  it("gives the ghost variant a resting fill, and keeps the disabled arm flat", () => {
    // A control that paints nothing until it is hovered reads as a label, so the
    // quietest action in a card or a dialog is the one a user cannot find
    // (2026-10-23). Three assertions, and each guards a different arm:
    //  - the fill exists on `:enabled`, so it never lights a disabled control;
    //  - the base rule KEEPS `transparent`, which is what a disabled ghost falls
    //    back to (dropping it painted the user agent's button face);
    //  - `:not([role="menuitem"])` keeps a menu flat, because a list whose every
    //    row is filled has no affordance left.
    expect(SHEET).toContain(
      '.myne-btn[data-variant="ghost"]:enabled:not([role="menuitem"]) {',
    );
    const fill = ruleBody(SHEET, '.myne-btn[data-variant="ghost"]:enabled');
    expect(fill).toContain("background: color-mix(in srgb, var(--bg-3)");
    const base = ruleBody(
      SHEET,
      '.myne-btn[data-variant="ghost"] {\n  background: transparent;',
    );
    expect(base).toContain("color: var(--fg-2)");
  });
});

describe("state rules cannot fire on a disabled control", () => {
  it("scopes every button and icon-button state rule with :enabled", () => {
    const stateLines = SHEET.split("\n").filter(
      (l) =>
        (l.startsWith(".myne-btn") || l.startsWith(".myne-icon-btn")) &&
        (l.includes(":hover") || l.includes(":active")),
    );
    expect(stateLines.length).toBeGreaterThan(0);
    for (const line of stateLines) {
      expect(line, `${line.trim()} would light a disabled control`).toContain(
        ":enabled",
      );
    }
  });
});

describe("the switch keeps its own shape when focused", () => {
  it("restates its radius under :focus-visible", () => {
    // The global `button:focus-visible` rule sets `border-radius:
    // var(--radius-2)` on EVERY button. This control is `--radius-3`, so a
    // keyboard user watched the pill visibly square off the instant it took
    // focus. An inline style cannot reach `:focus-visible` to restate it.
    expect(ruleBody(SHEET, ".myne-switch:focus-visible")).toContain(
      "border-radius: var(--radius-3)",
    );
  });
});

describe("the modal scrim is a theme-dependent token", () => {
  it("paints the backdrop from --scrim rather than a literal", () => {
    expect(ruleBody(SHEET, ".myne-modal-backdrop")).toContain("background: var(--scrim)");
  });

  it("declares --scrim for light AND overrides it on every dark family", () => {
    // `DESIGN.md`'s No-Glass Rule specifies `rgba(11,11,9,0.4)` light and
    // `rgba(0,0,0,0.6)` dark. Eight files had hand-written one fixed
    // `rgba(0, 0, 0, 0.4)` instead: pure black where the canon asks for ink,
    // and 0.4 on dark where it asks for 0.6, so a modal over a near-black page
    // was barely separated from it. Three dark contexts exist — the explicit
    // dark theme, amoled, and the prefers-color-scheme media query — and
    // missing any one leaves that theme on the light value.
    const decls = TOKENS.match(/--scrim:\s*[^;]+;/g) ?? [];
    expect(decls.length, "expected one light declaration + three dark overrides").toBe(4);
    expect(decls[0]).toContain("rgba(11, 11, 9, 0.4)");
    for (const d of decls.slice(1)) expect(d).toContain("rgba(0, 0, 0, 0.6)");
  });

  it("leaves no hand-written scrim literal in the shared tree", () => {
    // The whole point of the token is that there is one value, not nine.
    const offenders: string[] = [];
    for (const rel of ["src", "web/src", "mobile/src"]) {
      const dir = fileURLToPath(new URL(`../../${rel}`, import.meta.url));
      walk(dir, offenders);
    }
    expect(offenders, `hand-written scrim in: ${offenders.join(", ")}`).toEqual([]);
  });
});

function walk(dir: string, out: string[]): void {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = `${dir}/${name}`;
    if (statSync(full).isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      walk(full, out);
    } else if (/\.(ts|tsx|css)$/.test(name)) {
      const src: string = readFileSync(full, "utf8");
      if (src.includes('background: "rgba(0, 0, 0, 0.4)"')) out.push(full);
    }
  }
}

describe("the zero state's wash (design-notes/ui/0633)", () => {
  it("takes its colour from the accent, so every palette tints it with its own", () => {
    // A literal here would be the one colour in the zero state no theme reaches.
    expect(ruleBody(SHEET, ".myne-empty {")).toContain("--myne-empty-wash: var(--accent)");
    expect(ruleBody(SHEET, ".myne-empty__wash {")).toContain("var(--myne-empty-wash)");
  });

  it("fades to nothing at every edge, so a filled state has no hard line", () => {
    // A filled zero state has no border to hide where the wash is cut off, so
    // without a mask the glow met the pane edge as a visible seam.
    const wash = ruleBody(SHEET, ".myne-empty__wash {");
    expect(wash).toMatch(/(^|\s)mask-image: radial-gradient\(closest-side,[^;]*transparent 100%\)/);
  });

  it("is static: no animation, so it needs no motion-canon exemption", () => {
    const wash = ruleBody(SHEET, ".myne-empty__wash {");
    expect(wash).not.toContain("animation");
    expect(wash).not.toContain("transition");
  });

  it("turns to the danger colour on the error variant rather than a second rule set", () => {
    expect(ruleBody(SHEET, '.myne-empty[data-variant="error"] {')).toContain(
      "--myne-empty-wash: var(--danger)",
    );
  });

  it("the binary field's rules left with it", () => {
    expect(SHEET.includes(".myne-empty__field"), "the 01 field's rule came back").toBe(false);
    expect(SHEET.includes("--myne-empty-scrim"), "the field's scrim outlived it").toBe(false);
  });
});

describe("a zero state that owns its surface stops drawing a card on one", () => {
  it("drops the border and the fill, and takes the height offered", () => {
    // The Archive modal is the case: a ~200px bordered card pinned to the top
    // of a 700px modal, with the rest of the modal empty underneath, so the box
    // the user sees and the box the state draws are two different rectangles.
    // Stretching the card instead would nest two rounded rectangles of the same
    // radius with nothing between them, which reads as a rendering fault.
    const body = ruleBody(SHEET, '.myne-empty[data-fill="true"] {');
    expect(body).toContain("flex: 1");
    expect(body).toContain("border: none");
    expect(body).toContain("background: transparent");
  });
});

describe("a dropdown's height is stated in two places, so they must agree", () => {
  // `placeMenu` writes an INLINE `max-height`, which overrides the stylesheet
  // rather than deferring to it — so the sheet's number is not a cap unless
  // the same number is passed to that helper. The first version of this
  // assumed the sheet would still bind, and a folder list near the bottom of a
  // tall window grew to fill nearly the whole screen.
  //
  // Changing one and not the other makes the CSS declaration dead: it keeps
  // reading like the answer and stops being it.

  function maxHeightOf(selector: string): number {
    const body = ruleBody(SHEET, selector);
    const m = /max-height:\s*(\d+)px/.exec(body);
    expect(m, `${selector} has no pixel max-height`).not.toBeNull();
    return Number(m![1]);
  }

  function capPassedIn(file: string): number {
    const src: string = readFileSync(resolve(process.cwd(), file), "utf8");
    const m = /placeMenu\([^)]*\{\s*cap:\s*(\d+)/s.exec(src);
    expect(m, `${file} does not pass a cap to placeMenu`).not.toBeNull();
    return Number(m![1]);
  }

  it("the plain Select agrees with its stylesheet", () => {
    expect(capPassedIn("src/components/primitives/Select.tsx")).toBe(
      maxHeightOf(".myne-select-menu {"),
    );
  });

  it("the searchable one agrees with its own, which is taller", () => {
    const searchable = maxHeightOf('.myne-select-menu[data-searchable="true"]');
    expect(capPassedIn("src/components/primitives/SearchableSelect.tsx")).toBe(searchable);
    // And the two variants really do differ, or this pair of tests is one test
    // written twice: the searchable menu carries a pinned search row above its
    // list, which is what the extra height is for.
    expect(searchable).toBeGreaterThan(maxHeightOf(".myne-select-menu {"));
  });
});

describe("a text chip is not a theme swatch", () => {
  // `.myne-chiplet` is a 40x28 colour swatch with `overflow: hidden`. The
  // agent hub's note anchor was given it, on the reasoning that an app with
  // one chip design should have one chip class — the right instinct pointed at
  // the wrong class, which put a text label in a fixed 40px box with its
  // overflow cut off.
  //
  // Two classes for two things, and this holds them apart: the failure is
  // silent, because a label in a swatch still renders, still has its testid,
  // and is simply unreadable.

  it("the swatch is a fixed box", () => {
    const body = ruleBody(SHEET, ".myne-chiplet {");
    expect(body).toContain("width: 40px");
    expect(body).toContain("overflow: hidden");
  });

  it("the pill is sized by its text", () => {
    const body = ruleBody(SHEET, ".myne-pill {");
    expect(body, "a text chip with a fixed width cannot hold text").not.toMatch(
      /^\s*width:/m,
    );
    expect(body).toContain("text-overflow: ellipsis");
    expect(body).toContain("white-space: nowrap");
  });

  it("only an interactive pill answers a pointer", () => {
    // Most pills are statements, and a statement with a hover state invites a
    // press that does nothing.
    expect(SHEET).toContain('.myne-pill[data-interactive="true"]:enabled:hover');
    expect(
      /^\.myne-pill:hover/m.test(SHEET),
      "every pill lights up under the pointer",
    ).toBe(false);
  });
});

describe("the searchable menu's list can shrink, or it cannot scroll", () => {
  // myne-md/myne#867. The list is a flex item of a fixed-height flex column:
  // `.myne-select-menu[data-searchable="true"]` is `display: flex;
  // flex-direction: column; max-height: 320px; overflow-y: hidden`, and the list
  // sits under a pinned search row. A column flex item's default `min-height` is
  // `auto`, which resolves to its content height, so without the explicit `0`
  // the list grew to fit every option, the menu clipped the rest, and the folder
  // picker in the chat composer would not scroll.
  //
  // jsdom does not lay out, so no rendered test can see the clip: every option
  // IS in the DOM and a keyboard walk reaches all of them. The declarations are
  // the behaviour, which is why they are asserted here.

  it("permits the shrink and takes the scroll", () => {
    const body = ruleBody(SHEET, ".myne-select-list {");
    expect(body, "a flex item without min-height: 0 cannot shrink").toContain(
      "min-height: 0",
    );
    expect(body).toContain("overflow-y: auto");
  });

  it("is a flex item of a fixed-height, clipping column", () => {
    // The precondition for the rule above. If the menu ever stops being a
    // bounded flex column, the shrink permission stops meaning anything and
    // this pair of assertions is one assertion written twice.
    const menu = ruleBody(SHEET, '.myne-select-menu[data-searchable="true"]');
    expect(menu).toContain("display: flex");
    expect(menu).toContain("flex-direction: column");
    expect(menu).toContain("overflow-y: hidden");
    expect(menu).toMatch(/max-height:\s*\d+px/);
  });
});
