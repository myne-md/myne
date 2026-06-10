// @vitest-environment jsdom
//
// Hard line break rendering (MYND-208, task 6). Trailing 2-spaces / `\` markers
// hidden off-cursor (no glyph), revealed on-cursor; byte-stable.

import { afterEach, describe, expect, it } from "vitest";
import {
  type Mounted,
  focusAt,
  mount,
  queryAll,
  renderedText,
  roundTripBytes,
  teardown,
} from "./_conformance";

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
});

describe("hard break rendering", () => {
  it("hides a trailing backslash hard break off-cursor", () => {
    m = mount("line one\\\nline two\n");
    expect(renderedText(m)).not.toContain("\\");
  });

  it("hides trailing-two-spaces off the first line", () => {
    m = mount("a  \nb\n");
    const firstLine = queryAll(m, ".cm-line")[0];
    expect(firstLine?.textContent).toBe("a");
  });

  it("reveals the raw trailing backslash when the cursor is on the line", () => {
    m = mount("one\\\ntwo\n");
    focusAt(m, 1); // cursor on line one
    expect(renderedText(m)).toContain("\\");
  });

  it("round-trips both hard-break forms byte-identical", () => {
    const doc = "two  \ntrailing  \nspaces\n\nback\\\nslash\n";
    expect(roundTripBytes(doc)).toBe(doc);
  });
});
