// The attachment library gets a FLEX COLUMN as its pane body (myne-md/myne#779).
//
// A regression from the tab conversion itself, reported on a running build: the
// library scrolled nowhere.
//
// `PaneView` wraps a filling body in `<div style={{ height: "100%" }}>`, which
// is a BLOCK. The library is written as a flex child — its root is
// `flex: 1; minHeight: 0` and its scroller is `flex: 1; minHeight: 0;
// overflowY: auto` — so with no flex parent neither got a bounded height: the
// root grew to content and the scroller had nothing to scroll inside. The pane
// clipped and the rest of the library was unreachable. `GraphPane` never
// exposed it, because a canvas fills `height: 100%` on its own.
//
// A SOURCE assertion, and it says so. The real condition is
// `scrollHeight > clientHeight` on a rendered scroller, which needs layout and
// a library with enough content to overflow — and the E2E fixture generator
// cannot seed attachments, so a scenario written for it would assert on a
// library that is always empty and pass with the bug restored. That is the
// vacuous-fixture shape, so it is not written. What this catches is the fix
// being deleted, which is the regression that would otherwise be silent.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC: string = readFileSync(
  fileURLToPath(new URL("../../src/notes/components/PaneView.tsx", import.meta.url)),
  "utf8",
);

/** The `isAttachments` arm's source, from the guard to its closing brace. */
function attachmentsArm(): string {
  const at = SRC.indexOf("if (isAttachments) {");
  expect(at, "the attachments pane arm is gone").toBeGreaterThan(-1);
  // The arm ends at the next sibling `if (` at the same indentation.
  const next = SRC.indexOf("\n    if (", at + 10);
  return SRC.slice(at, next === -1 ? at + 2000 : next);
}

describe("the attachments pane body is a bounded flex column", () => {
  it("declares the column, so the library's flex children get a height", () => {
    const arm = attachmentsArm();
    expect(arm).toContain('display: "flex"');
    expect(arm).toContain('flexDirection: "column"');
  });

  it("bounds that column to the pane rather than to its content", () => {
    // `height: 100%` is the half that makes it bounded. Without it the column
    // is still a column and still grows to content, which is the original bug
    // wearing a flex parent.
    const arm = attachmentsArm();
    expect(arm).toContain('height: "100%"');
    expect(arm).toContain("minHeight: 0");
  });

  it("still fills, with no gutters", () => {
    // `fill: false` would hand it the flowing-body regime, where the PANE
    // scrolls instead of the library — the grid would run past the fold and
    // the toolbar would scroll away with it.
    const arm = attachmentsArm();
    expect(arm).toContain("fill: true");
    expect(arm).toContain("gutters: false");
  });
});
