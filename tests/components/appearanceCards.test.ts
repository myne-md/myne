// The theme-preview cards show the themes they name — myne-md/myne#556, the
// `settings.panel.appearance` bullet.
//
// `AppearancePanel.tsx` draws a small mock-up of each theme in its picker card,
// and it draws them from LITERAL HEX rather than from the tokens: the card is
// rendered while a DIFFERENT theme is active, so `var(--paper)` would paint
// three cards in the current theme's colours and the picker would say nothing.
// The literals are correct and necessary; what they are not is checked.
//
// The failure that produces is precise and quiet: somebody tunes `--paper-3` in
// `tokens.css`, the app changes, the card does not, and from then on the picker
// advertises a theme that no longer exists. A hand-walk cannot catch it — the
// card and the theme are never on screen at the same moment, so "does the card
// look like the theme" is a memory test.
//
// A string comparison against the token source catches it on every client at
// once, without rendering anything.
//
// Deliberately reading `src/styles/tokens.css` and not `agent-tooling/docs/design/
// colors_and_type.css`: the design copy is a SUBSET (`src/AGENTS.md`) and
// carries no `:root[data-theme="amoled"]` block at all, so a third of this
// matrix would silently go unchecked — the third with the pure-black background,
// which is the one whose card is most obviously wrong when it drifts.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();

const PANEL = readFileSync(
  join(REPO_ROOT, "src/components/settings/AppearancePanel.tsx"),
  "utf8",
);
// **Both sheets, concatenated.** myne-md/myne#478 moved the design TOKENS to
// `client-core/src/tokens.css` and left `src/styles/tokens.css` as this
// client's component layer; its own header says so. Reading one of them
// means a token that moves between them turns this into a test that fails
// about its own input, which is how this file came to report 167 missing
// tokens against a palette that was entirely present.
const TOKENS = [
  readFileSync(join(REPO_ROOT, "client-core/src/tokens.css"), "utf8"),
  readFileSync(join(REPO_ROOT, "src/styles/tokens.css"), "utf8"),
].join("\n");

/**
 * Resolve a custom property to a literal hex, following `var()` indirections
 * (the amoled twins are declared as `var(--_x-dark)`).
 *
 * Throws rather than defaulting: a token this cannot find is a token the sheet
 * no longer has, and answering "black" for it would let a drifted card pass.
 */
function token(name: string, depth = 0): string {
  if (depth > 4) throw new Error(`--${name}: var() chain too deep`);
  const m = TOKENS.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!m) throw new Error(`token --${name} not found in src/styles/tokens.css`);
  const value = m[1].trim();
  const hex = value.match(/^#([0-9a-fA-F]{6})$/);
  if (hex) return `#${hex[1].toLowerCase()}`;
  const ref = value.match(/^var\(\s*--([a-zA-Z0-9_-]+)\s*\)$/);
  if (ref) return token(ref[1], depth + 1);
  throw new Error(`--${name} is neither a literal hex nor a single var(): ${value}`);
}

/** The literal swatch the panel draws for `theme`, parsed out of the source. */
function swatch(theme: "light" | "dark" | "amoled"): Record<string, string> {
  const block = PANEL.match(new RegExp(`${theme}:\\s*\\{([^}]*)\\}`));
  if (!block) throw new Error(`no THEME_SWATCHES entry for ${theme}`);
  const out: Record<string, string> = {};
  for (const [, key, value] of block[1].matchAll(/(\w+):\s*"(#[0-9a-fA-F]{6})"/g)) {
    out[key] = value.toLowerCase();
  }
  return out;
}

/**
 * Which token each swatch field is a picture of, per theme.
 *
 * Written out rather than derived from the field name: `paper2` maps to
 * `--paper-2` in light and to `--_paper-2-dark` in dark, and a name-mangling
 * rule that produced both would be a second implementation of the theme block
 * structure — which is the thing most likely to change.
 */
const MAPPING: Record<"light" | "dark" | "amoled", Record<string, string>> = {
  light: {
    paper: "paper",
    paper2: "paper-2",
    line: "line-1",
    ink: "ink-1",
    accent: "accent",
  },
  dark: {
    paper: "_paper-dark",
    paper2: "_paper-2-dark",
    line: "_line-1-dark",
    ink: "_ink-1-dark",
    accent: "_accent-dark",
  },
  amoled: {
    paper: "_paper-amoled",
    paper2: "_paper-2-amoled",
    line: "_line-1-amoled",
    ink: "_ink-1-amoled",
    accent: "_accent-amoled",
  },
};

const THEMES = ["light", "dark", "amoled"] as const;

describe("the panel's literal swatches are the ones this file compares", () => {
  it("finds a full swatch for every theme", () => {
    // A regex that matched nothing would compare two empty objects and agree.
    for (const theme of THEMES) {
      const s = swatch(theme);
      expect(Object.keys(s).sort(), `${theme}`).toEqual([
        "accent",
        "ink",
        "line",
        "paper",
        "paper2",
      ]);
    }
  });

  it("the mapping names a token for every field it found", () => {
    // Both directions, so neither side can quietly stop describing the other.
    for (const theme of THEMES) {
      expect(Object.keys(swatch(theme)).sort()).toEqual(Object.keys(MAPPING[theme]).sort());
    }
  });
});

describe("each theme card is drawn in that theme's real colours", () => {
  for (const theme of THEMES) {
    for (const [field, tokenName] of Object.entries(MAPPING[theme])) {
      it(`${theme}.${field} matches --${tokenName}`, () => {
        const drawn = swatch(theme)[field];
        const real = token(tokenName);
        expect(
          drawn,
          `the ${theme} preview card paints ${field} as ${drawn} while the ` +
            `theme's --${tokenName} is ${real}. The card and the theme are ` +
            `never on screen together, so nobody sees this drift — the picker ` +
            `just quietly advertises a theme that no longer exists.`,
        ).toBe(real);
      });
    }
  }
});

describe("the comparison is not vacuous", () => {
  it("the three swatches differ from each other", () => {
    // Three identical swatches would satisfy any single-theme assertion.
    const rendered = THEMES.map((t) => JSON.stringify(swatch(t)));
    expect(new Set(rendered).size).toBe(3);
  });

  it("amoled really is pure black, which is the point of the theme", () => {
    expect(swatch("amoled").paper).toBe("#000000");
    expect(swatch("light").paper).not.toBe("#000000");
  });

  it("the token resolver actually resolves, rather than answering a default", () => {
    expect(token("paper")).toMatch(/^#[0-9a-f]{6}$/);
    expect(() => token("paper-1")).toThrow(); // there is no --paper-1
    expect(() => token("definitely-not-a-token")).toThrow();
  });
});
