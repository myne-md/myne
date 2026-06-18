// SYNC-1 contract test (heading-list-folding / MYND-300, story 10).
//
// `headingSections(source, tree?)` is the ONE canonical "heading list with
// positions" surface that the wikilink-deep-links feature (MYND-305) imports
// for anchor resolution + `[[#` autocomplete. Shape per heading:
//   { level, text, from, sectionTo }
// where `from` is the heading line start and `sectionTo` is the end of that
// heading's section — the start of the next same-or-higher heading, or the
// document end. These boundaries are load-bearing for #305, so they get a
// direct test: nesting, same-level siblings, and duplicate headings.

import { describe, expect, it } from "vitest";
import { headingSections } from "../../../src/dialect/visitors/headingSections";

describe("headingSections (SYNC-1)", () => {
  it("returns [] for an empty document", () => {
    expect(headingSections("")).toEqual([]);
  });

  it("a single heading section runs to the document end", () => {
    const src = "# Title\n\nBody paragraph.\nMore body.\n";
    const sections = headingSections(src);
    expect(sections).toHaveLength(1);
    const [h] = sections;
    expect(h!.level).toBe(1);
    expect(h!.text).toBe("Title");
    expect(h!.from).toBe(0);
    expect(h!.sectionTo).toBe(src.length);
  });

  it("a deeper heading is subsumed: the parent section spans its child", () => {
    const src = "# A\nintro\n## A.1\nchild body\n# B\ntail\n";
    const sections = headingSections(src);
    expect(sections.map((s) => [s.level, s.text])).toEqual([
      [1, "A"],
      [2, "A.1"],
      [1, "B"],
    ]);
    const a = sections[0]!;
    const a1 = sections[1]!;
    const b = sections[2]!;
    // `# A` runs until the next same-or-higher heading (`# B`), so its section
    // SUBSUMES the nested `## A.1` — this is what makes a folded H1 collapse the
    // whole subtree.
    expect(a.from).toBe(0);
    expect(a.sectionTo).toBe(b.from);
    // `## A.1` runs until `# B` too (the next same-or-higher heading).
    expect(a1.sectionTo).toBe(b.from);
    // `# B` runs to the document end.
    expect(b.sectionTo).toBe(src.length);
  });

  it("a same-level sibling ends the previous section", () => {
    const src = "## One\na\n## Two\nb\n";
    const sections = headingSections(src);
    expect(sections).toHaveLength(2);
    const one = sections[0]!;
    const two = sections[1]!;
    expect(one.sectionTo).toBe(two.from);
    expect(two.sectionTo).toBe(src.length);
  });

  it("a shallower heading also ends a deeper section (same-or-higher rule)", () => {
    const src = "## Deep\nx\n# Shallow\ny\n";
    const sections = headingSections(src);
    const deep = sections[0]!;
    const shallow = sections[1]!;
    // `## Deep` is ended by the shallower `# Shallow` (level 1 ≤ 2).
    expect(deep.sectionTo).toBe(shallow.from);
  });

  it("handles duplicate heading text with distinct positions", () => {
    const src = "# Notes\nfirst\n# Notes\nsecond\n";
    const sections = headingSections(src);
    expect(sections).toHaveLength(2);
    expect(sections[0]!.text).toBe("Notes");
    expect(sections[1]!.text).toBe("Notes");
    // Distinct positions despite identical text — anchor resolution (#305) must
    // not collapse duplicates onto one offset.
    expect(sections[0]!.from).not.toBe(sections[1]!.from);
    expect(sections[0]!.sectionTo).toBe(sections[1]!.from);
    expect(sections[1]!.sectionTo).toBe(src.length);
  });

  it("`from` is the heading LINE start, not the inline text start", () => {
    const src = "intro line\n## Section\nbody\n";
    const sections = headingSections(src);
    const sec = sections[0]!;
    // Heading line begins at the offset of "## Section".
    expect(src.slice(sec.from, sec.from + 2)).toBe("##");
  });
});
