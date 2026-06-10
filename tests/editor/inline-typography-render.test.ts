// @vitest-environment jsdom
//
// Highlight / subscript / superscript rendering (MYND-156, task 2). Cursor-aware
// mark + marker-hide, the SYNC-6 shared classes; byte-stable. (Emoji shortcode
// glyph rendering is task 3.)

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

describe("highlight", () => {
  it("renders ==text== with .cm-highlight and hides the == markers off-cursor", () => {
    m = mount("a ==marked== b\n");
    expect(query(m, ".cm-highlight")).not.toBeNull();
    expect(renderedText(m)).not.toContain("==");
    expect(renderedText(m)).toContain("marked");
  });

  it("reveals the raw == markers on-cursor", () => {
    m = mount("==hi== x\n");
    focusAt(m, 2); // inside ==hi==
    expect(renderedText(m)).toContain("==hi==");
  });
});

describe("subscript / superscript", () => {
  it("renders ~x~ as .cm-sub and ^x^ as .cm-sup", () => {
    m = mount("H~2~O and X^2^ end\n");
    expect(query(m, ".cm-sub")).not.toBeNull();
    expect(query(m, ".cm-sup")).not.toBeNull();
  });
});

describe("byte stability", () => {
  it("round-trips highlight/sub/sup (and adjacent strikethrough) unchanged", () => {
    const doc = "==a== H~2~O X^2^ ~~strike~~\n";
    expect(roundTripBytes(doc)).toBe(doc);
  });
});
