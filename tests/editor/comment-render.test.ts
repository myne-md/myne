// @vitest-environment jsdom
//
// Dialect comment (`%%…%%`) rendering (MYND-315 + the 2026-06-17 UX revision).
// Comments are DIMMED in the editor — always VISIBLE via the `.cm-comment` mark,
// never hidden (a hidden comment is invisible-and-confusing; the strip happens on
// export/output, not in the editor). Recognize-and-render-only — bytes survive a
// focus cycle (§6 C1). Spec: docs/spec/markdown-dialect.md §3.1 / §3.2 / §6.

import { afterEach, describe, expect, it } from "vitest";
import {
  type Mounted,
  mount,
  renderedText,
  roundTripBytes,
  teardown,
} from "./_conformance";

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
});

/** Concatenated text of all `.cm-comment`-marked spans in the rendered DOM. */
function commentMarkedText(mm: Mounted): string {
  return Array.from(mm.view.contentDOM.querySelectorAll(".cm-comment"))
    .map((el) => el.textContent ?? "")
    .join("");
}

describe("inline `%%…%%` (dimmed, always visible)", () => {
  it("renders the comment visible and marked `.cm-comment`", () => {
    m = mount("visible %%a note%% text\n");
    const text = renderedText(m);
    expect(text).toContain("visible");
    expect(text).toContain("text");
    // The comment is NOT hidden — the raw span stays on screen (dimmed).
    expect(text).toContain("%%a note%%");
    // …and it carries the dim mark so it reads as a de-emphasized comment.
    expect(commentMarkedText(m)).toContain("a note");
  });

  it("leaves an unterminated `%%` visible AND unmarked (inert)", () => {
    m = mount("a %% lone opener\n");
    expect(renderedText(m)).toContain("%% lone opener");
    expect(commentMarkedText(m)).toBe(""); // no comment node → no dim mark
  });
});

describe("block / multi-line `%%`…`%%` (dimmed, always visible)", () => {
  it("renders a single-line block comment visible + marked", () => {
    m = mount("before\n\n%% a block note %%\n\nafter\n");
    const text = renderedText(m);
    expect(text).toContain("before");
    expect(text).toContain("after");
    expect(text).toContain("a block note");
    expect(commentMarkedText(m)).toContain("a block note");
  });

  it("renders a multi-line block comment visible + marked", () => {
    m = mount("before\n\n%% line one\nline two\nclose %%\n\nafter\n");
    expect(commentMarkedText(m)).toContain("line one");
    expect(commentMarkedText(m)).toContain("line two");
    expect(renderedText(m)).toContain("before");
    expect(renderedText(m)).toContain("after");
  });
});

describe("byte stability (§6 C1)", () => {
  it("round-trips inline + block comments through a focus cycle unchanged", () => {
    const doc = "a %%inline%% b\n\n%% block\nmulti %%\n\ntail\n";
    expect(roundTripBytes(doc)).toBe(doc);
  });

  it("round-trips an unterminated `%%` unchanged", () => {
    const doc = "%% never closed\n\n# Heading\n";
    expect(roundTripBytes(doc)).toBe(doc);
  });
});
