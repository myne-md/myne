// @vitest-environment jsdom
//
// The appearance canon (myne-md/myne#900), in two halves.
//
// 1. The ROSTER is held to its sources. `APPEARANCE_VARYING_TOKENS` is a table of
//    NAMES, and the failure it exists to prevent is a table that has fallen
//    behind the sheet: it carried 5 of the sheet's 13 highlight washes when it
//    first landed, so 8 of them still resolved to the light value on a dark
//    theme. This test parses `client-core/src/tokens.css` and the validator's
//    `REQUIRED_KEYS` and compares BOTH ways, so a family added to the sheet fails
//    here by name rather than silently staying light. A roster compared against a
//    second copy of itself is the trap this deliberately avoids: the expected set
//    is derived from the two files, never from the roster.
//
// 2. The READ honours the appearance the palette declares, measured from the
//    palette's own `--paper` rather than from whichever built-in is active, and
//    puts the borrowed attribute back.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { APPEARANCE_VARYING_TOKENS, readAppearanceCanon } from "../../src/lib/themeCanon";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The declared `--token: value` pairs inside one top-level CSS block. */
function declaredTokens(css: string, selector: RegExp): Map<string, string> {
  const block = selector.exec(css);
  if (block === null) {
    throw new Error(`no block matched ${selector} in the token sheet`);
  }
  const out = new Map<string, string>();
  for (const [, key, value] of block[1].matchAll(/(--[a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g)) {
    out.set(key, value.trim());
  }
  return out;
}

/** The tokens a theme may omit but whose built-in value depends on the appearance. */
function appearanceVaryingTokens(): string[] {
  const css: string = readFileSync(join(REPO_ROOT, "client-core/src/tokens.css"), "utf8");
  const light = declaredTokens(css, /\n:root\s*\{([\s\S]*?)\n\}/);
  const dark = declaredTokens(css, /\n:root\[data-theme="dark"\]\s*\{([\s\S]*?)\n\}/);
  if (light.size === 0 || dark.size === 0) {
    throw new Error("the token sheet's :root / dark blocks came back empty");
  }
  return [...dark.keys()].filter(
    (key) => light.has(key) && !key.startsWith("--_") && light.get(key) !== dark.get(key),
  );
}

/** The 21 tokens a theme must carry, so the palette always paints them. */
function requiredKeys(): Set<string> {
  const schema: string = readFileSync(join(REPO_ROOT, "theme-validator/src/schema.rs"), "utf8");
  const list = /pub const REQUIRED_KEYS: &\[&str\] = &\[([\s\S]*?)\];/.exec(schema);
  if (list === null) {
    throw new Error("REQUIRED_KEYS not found in theme-validator/src/schema.rs");
  }
  const keys = [...list[1].matchAll(/"(--[a-z0-9-]+)"/g)].map(([, key]) => key);
  if (keys.length === 0) {
    throw new Error("REQUIRED_KEYS parsed as empty");
  }
  return new Set(keys);
}

describe("APPEARANCE_VARYING_TOKENS", () => {
  it("is exactly the sheet's appearance-varying set minus the required keys", () => {
    const required = requiredKeys();
    // No exclusion: `--info` is seeded too. Its dark declaration aliases
    // `--accent`, which `readAppearanceCanon` resolves against the theme's own
    // accent rather than freezing the built-in one.
    const expected = appearanceVaryingTokens()
      .filter((key) => !required.has(key))
      .sort();
    expect([...APPEARANCE_VARYING_TOKENS].sort()).toEqual(expected);
  });

  it("names no required token, so the palette is never second-guessed", () => {
    const required = requiredKeys();
    expect(APPEARANCE_VARYING_TOKENS.filter((key) => required.has(key))).toEqual([]);
  });

  it("holds a measured floor, so a shrink cannot read as agreement", () => {
    // The floor is the count this test measured; it moves only when the sheet
    // grows a family. Without it, emptying the roster would satisfy the
    // comparison above on a sheet that had also lost the families.
    expect(APPEARANCE_VARYING_TOKENS.length).toBeGreaterThanOrEqual(46);
  });
});

describe("readAppearanceCanon", () => {
  const sheet = document.createElement("style");
  sheet.textContent = `
    :root { --paper: #fbfbfa; --highlight-teal: #cfe6e2; --label-clay: #b0543f; }
    :root[data-theme="dark"] { --paper: #141412; --highlight-teal: #183531; --label-clay: #d99683; }
  `;
  document.head.appendChild(sheet);

  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
  });

  it("reads the DARK canon for a dark palette, whatever the active built-in is", () => {
    const root = document.documentElement;
    root.setAttribute("data-theme", "amoled");
    const canon = readAppearanceCanon(root, { "--paper": "#1e1e2e" });
    expect(canon["--highlight-teal"]).toBe("#183531");
    expect(canon["--label-clay"]).toBe("#d99683");
  });

  it("reads the LIGHT canon for a light palette", () => {
    const canon = readAppearanceCanon(document.documentElement, { "--paper": "#fdfdfc" });
    expect(canon["--highlight-teal"]).toBe("#cfe6e2");
  });

  it("treats an absent or unreadable --paper as light rather than throwing", () => {
    const root = document.documentElement;
    expect(readAppearanceCanon(root, {})["--highlight-teal"]).toBe("#cfe6e2");
    expect(readAppearanceCanon(root, { "--paper": "not a colour" })["--highlight-teal"]).toBe("#cfe6e2");
  });

  it("puts back the attribute it borrowed, present or absent", () => {
    const root = document.documentElement;
    root.setAttribute("data-theme", "dark");
    readAppearanceCanon(root, { "--paper": "#fdfdfc" });
    expect(root.getAttribute("data-theme")).toBe("dark");

    root.removeAttribute("data-theme");
    readAppearanceCanon(root, { "--paper": "#fdfdfc" });
    expect(root.hasAttribute("data-theme")).toBe(false);
  });
});
