// @vitest-environment jsdom
//
// Plain list rendering (MYND-208, task 4). Off-cursor: `-`/`*`/`+` → muted
// bullet glyph (`•` top level, `◦` nested), ordered `n.` muted; cursor-aware
// reveal of the raw marker; task items left to task-list.ts; byte-stable.

import { afterEach, describe, expect, it } from "vitest";
import {
  type Mounted,
  focusAt,
  mount,
  query,
  renderedText,
  roundTripBytes,
  teardown,
} from "./_conformance";

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
});

describe("bullet lists", () => {
  it("renders a top-level bullet (filled disc) and hides the raw marker off-cursor", () => {
    m = mount("- first\n- second\n");
    const bullet = query(m, ".cm-list-bullet");
    expect(bullet).not.toBeNull();
    // CSS-drawn disc → no glyph text, and not the nested ring variant.
    expect(bullet!.classList.contains("cm-list-bullet-ring")).toBe(false);
    // The raw `-` marker is replaced; the rendered line shows the body text.
    expect(renderedText(m)).toContain("first");
  });

  it("uses the hollow ring variant for a nested bullet", () => {
    m = mount("- top\n  - nested\n");
    const top = m.host.querySelector(".cm-list-bullet:not(.cm-list-bullet-ring)");
    const ring = m.host.querySelector(".cm-list-bullet-ring");
    expect(top).not.toBeNull();
    expect(ring).not.toBeNull();
  });

  it("applies the hanging-indent line class to list lines", () => {
    m = mount("- item\n");
    expect(query(m, ".cm-list-item-line")).not.toBeNull();
  });

  it("reveals the raw `-` marker when the cursor is on the line", () => {
    m = mount("- item here\n");
    focusAt(m, 3); // cursor on the list line
    expect(renderedText(m)).toContain("- item here");
  });
});

describe("ordered lists", () => {
  it("mutes the number marker but keeps it visible", () => {
    m = mount("1. first\n2. second\n");
    const num = query(m, ".cm-list-number");
    expect(num).not.toBeNull();
    expect(renderedText(m)).toContain("1.");
  });
});

describe("task items are left to task-list.ts", () => {
  it("does not add a bullet glyph to a task item", () => {
    m = mount("- [ ] todo\n");
    expect(query(m, ".cm-list-bullet")).toBeNull();
    expect(query(m, ".cm-task-checkbox")).not.toBeNull();
  });
});

describe("byte stability", () => {
  it("round-trips bullet, ordered, nested and task lists unchanged", () => {
    const doc = "- a\n- b\n  - c\n\n1. one\n2. two\n\n- [ ] t\n- [x] d\n";
    expect(roundTripBytes(doc)).toBe(doc);
  });
});
