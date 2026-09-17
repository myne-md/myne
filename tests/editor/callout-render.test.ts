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
import {
  DEFAULT_DISPLAY,
  setDateTimeDisplay,
  __resetDateTimeDisplayForTest,
} from "@myne/editor/host/lib/datetimeFormat";
import i18n from "../../src/i18n";

/** The icon's child tags, in order. Empty means the glyph rendered as nothing —
 *  which is the shape #376 reported and which asserting on `<svg>` alone misses. */
function iconShapes(m: Mounted): string[] {
  const svg = query(m, ".cm-callout-title")?.querySelector("svg");
  if (svg === null || svg === undefined) return [];
  return Array.from(svg.children).map((c) => c.tagName.toLowerCase());
}

let m: Mounted | null = null;
afterEach(async () => {
  if (m !== null) teardown(m);
  m = null;
  // A language switched for one test must not leak into the next. `tr` is a
  // lazy catalog, so the injected bundle has to come back out as well.
  if (i18n.language !== "en") await i18n.changeLanguage("en");
  i18n.removeResourceBundle("tr", "common");
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

  it("rebuilds on an ambient display change without losing its header", () => {
    // myne-md/myne#609 gave the shared rebuild gate a signal for ambient state
    // (the reader's date format and language), which this module's own header
    // records as deliberately unwired before that. A display-format change does
    // not alter the callout's own label, so this pins only that the rebuild
    // leaves the header intact; the label half is the next test.
    m = mount("> [!note]\n> body text\n");
    expect(query(m, ".cm-callout-title")!.textContent).toContain("Note");
    setDateTimeDisplay({ ...DEFAULT_DISPLAY, dateFormat: "dmy" });
    expect(query(m, ".cm-callout-title")!.textContent).toContain("Note");
    __resetDateTimeDisplayForTest();
  });

  // myne-md/myne#644. The callout header replacement begins exactly where
  // `blockquote.ts`'s `> ` marker-hide ends. With a non-inclusive replace both
  // points share the same positive `startSide`, so a rebuild whose changed range
  // starts on that shared boundary made CodeMirror read the header widget as a
  // continuation of a zero-length phantom point and never render it: the source
  // stayed hidden and nothing replaced it. A language switch is what changes the
  // label, so it is what triggers a rebuild on that boundary; the *next edit* is
  // the same rebuild path and is the step the issue reports. `inclusive: true`
  // on the replacement is the fix.
  it("re-labels on a language switch through the production ambient channel", async () => {
    m = mount("> [!note]\n> body text\n");
    expect(query(m, ".cm-callout-title")!.textContent).toContain("Note");

    // The rebuild is driven the way production drives it: the host adapter
    // carries the active language in `DateTimeDisplay.locale` and republishes
    // when it changes, which fires the shared `ambientLabelsChanged` gate. A
    // synthetic doc edit would pass through the `docChanged` gate instead and
    // prove nothing about the ambient path.
    i18n.addResourceBundle(
      "tr",
      "common",
      { editor: { callout: { label: { note: "NOT-TR" } } } },
      true,
      true,
    );
    await i18n.changeLanguage("tr");
    setDateTimeDisplay({ ...DEFAULT_DISPLAY, locale: "tr" });

    const title = query(m, ".cm-callout-title");
    expect(title).not.toBeNull();
    expect(title!.textContent).toContain("NOT-TR");
    __resetDateTimeDisplayForTest();
  });

  it("keeps its header through the edit that follows a language switch", async () => {
    m = mount("> [!note]\n> body text\n");
    i18n.addResourceBundle(
      "tr",
      "common",
      { editor: { callout: { label: { note: "NOT-TR" } } } },
      true,
      true,
    );
    await i18n.changeLanguage("tr");
    setDateTimeDisplay({ ...DEFAULT_DISPLAY, locale: "tr" });
    m.view.dispatch({ changes: { from: m.view.state.doc.length, insert: "x" } });

    const title = query(m, ".cm-callout-title");
    expect(title).not.toBeNull();
    expect(title!.textContent).toContain("NOT-TR");
    __resetDateTimeDisplayForTest();
  });

  it("keeps end-of-line typing visible", () => {
    // Pins that a keystroke landing exactly on the end of the header line
    // renders: the header replacement must never absorb it into the hidden
    // span, or the typed character would vanish with the document unchanged.
    m = mount("> [!note]\n> body text\n");
    const end = m.view.state.doc.line(1).to;
    m.view.dispatch({ changes: { from: end, insert: "!" } });

    expect(m.view.state.doc.toString()).toContain("> [!note]!");
    expect(query(m, ".cm-callout-title")).not.toBeNull();
    expect(renderedText(m)).toContain("!");
  });
});
