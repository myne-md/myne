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
