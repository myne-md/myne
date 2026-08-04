// @vitest-environment jsdom
//
// Callout rendering (MYND-47). `> [!TYPE]` blockquotes promote to styled
// callout containers (color + icon + title); case-insensitive; custom title;
// unknown type → plain blockquote; cursor-reveal; byte-stable.

import { afterEach, describe, expect, it } from "vitest";
import {
  type Mounted,
  focusAt,
  mount,
  query,
  queryAll,
  renderedText,
  roundTripBytes,
  teardown,
} from "./_conformance";

/** The icon's child tags, in order. Empty means the glyph rendered as nothing —
 *  which is the shape #376 reported and which asserting on `<svg>` alone misses. */
function iconShapes(m: Mounted): string[] {
  const svg = query(m, ".cm-callout-title")?.querySelector("svg");
  if (svg === null || svg === undefined) return [];
  return Array.from(svg.children).map((c) => c.tagName.toLowerCase());
}

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
});

describe("callouts", () => {
  it("promotes `> [!note]` to a callout with a title header", () => {
    m = mount("> [!note]\n> body text\n");
    expect(query(m, ".cm-callout-bg-accent")).not.toBeNull();
    const title = query(m, ".cm-callout-title");
    expect(title).not.toBeNull();
    expect(title!.textContent).toContain("Note");
    expect(title!.querySelector("svg")).not.toBeNull();
    // The glyph itself, not just its container: an `<svg>` that parsed to nothing
    // still satisfies the line above (#376). `note` draws the pencil — two paths.
    expect(iconShapes(m)).toEqual(["path", "path"]);
  });

  it("draws the type's own glyph, not a shared one", () => {
    m = mount("> [!info]\n> body text\n");
    expect(iconShapes(m)).toEqual(["circle", "path", "path"]);
    teardown(m);
    m = mount("> [!todo]\n> body text\n");
    expect(iconShapes(m)).toEqual(["circle"]);
  });

  // Pins the invariant, NOT the condition that threatens it: the duplicate-header
  // case needs a Blockquote spanning two of `view.visibleRanges`, and a jsdom mount
  // has one contiguous range. The dedup in callout.ts is defensive on that path.
  it("renders exactly one header per callout", () => {
    m = mount("> [!note] Title\n> body\n");
    expect(queryAll(m, ".cm-callout-title")).toHaveLength(1);
  });

  it("maps types to colors (warning → warning tint)", () => {
    m = mount("> [!warning]\n> careful\n");
    expect(query(m, ".cm-callout-bg-warning")).not.toBeNull();
  });

  it("renders a custom title", () => {
    m = mount("> [!tip] My Custom Tip\n> body\n");
    expect(query(m, ".cm-callout-title")?.textContent).toContain("My Custom Tip");
  });

  it("is case-insensitive (`[!NOTE]` == `[!note]`)", () => {
    m = mount("> [!NOTE]\n> x\n");
    expect(query(m, ".cm-callout-title")).not.toBeNull();
  });

  it("leaves an unknown type as a plain blockquote (no promotion)", () => {
    m = mount("> [!frobnicate]\n> x\n");
    expect(query(m, ".cm-callout-title")).toBeNull();
    expect(query(m, ".cm-blockquote")).not.toBeNull();
  });

  it("reveals the raw `[!note]` marker on-cursor", () => {
    m = mount("> [!note] Title\n> body\n");
    focusAt(m, 4); // on the header line
    expect(renderedText(m)).toContain("[!note]");
  });

  it("round-trips a callout byte-identical", () => {
    const doc = "> [!warning]+ Heads up\n> line one\n> line two\n";
    expect(roundTripBytes(doc)).toBe(doc);
  });
});
