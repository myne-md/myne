// @vitest-environment jsdom
//
// The title-bar row's two families of control have to sit on ONE line.
//
// The row is shared by controls laid out two different ways: the sidebar
// toggles, the back/forward nav and the note-actions "…" are floated into the
// editor's corners by `screens/Editor.tsx` (absolute, from the top), while the
// tab strip's `+` and overflow buttons are flex children of the 38px strip.
//
// They did not line up. The strip's buttons were 28px tall and `alignSelf:
// center`, which centres them in the strip's CONTENT box, and that box starts
// below the strip's top padding, so they landed two pixels lower than the
// floated controls. The visible symptom was a larger gap above the overflow
// caret than above the "…" immediately to its right.
//
// jsdom does no layout, so this cannot measure pixels. What it CAN do is assert
// the arithmetic that produces them, which is where the bug actually was: the
// button's own offset from the strip's top edge must equal the floated
// controls' offset, and its height must equal theirs.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TabStrip } from "../../src/notes/components/TabStrip";
// The row's geometry is owned by the title bar, not by the strip: a constant
// owned by one of two consumers is one the other can have moved out from
// under it. Reading it from the same place production does is the point.
import {
  TITLE_BAR_CONTROL_HEIGHT,
  TITLE_BAR_CONTROL_TOP,
} from "../../src/screens/titlebar";

afterEach(cleanup);

function renderStrip() {
  render(
    <TabStrip
      paneId="pane-1"
      tabs={["A"]}
      activeTab="A"
      titleOf={() => "Note A"}
      onActivate={vi.fn()}
      onClose={vi.fn()}
      onNewTab={vi.fn()}
      onMoveTab={vi.fn()}
    />,
  );
  const strip = screen.getByTestId("editor.tab-strip");
  // The `+` and the overflow caret are the strip's two buttons, and both carry
  // the same chrome. Selected by testid rather than by shape: filtering
  // `querySelectorAll("button")` also caught each tab's own × close control,
  // which is 18px and is not part of this row.
  const buttons = screen.getAllByTestId("editor.tab-strip-button");
  return { strip, buttons };
}

describe("title-bar row alignment", () => {
  // Named for what it proves, not for the relation it is about: only the strip
// is rendered here, so this checks that the strip DERIVES its offset from the
// shared title-bar constant rather than from a literal of its own. The
// arithmetic holds for any value of either constant, which is the point: the
// failure it catches is the strip going back to a private number.
  it("derives the strip buttons' offset from the shared title-bar constant", () => {
    const { strip, buttons } = renderStrip();
    const stripPaddingTop = parseFloat(strip.style.paddingTop || "0");
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      // Pinned to the top edge, not centred: centring is what introduced the
      // offset, because the content box starts below the padding.
      expect(button.style.alignSelf).toBe("flex-start");
      const marginTop = parseFloat(button.style.marginTop || "0");
      expect(stripPaddingTop + marginTop).toBe(TITLE_BAR_CONTROL_TOP);
    }
  });

  it("derives their height from the same shared constant", () => {
    const { buttons } = renderStrip();
    for (const button of buttons) {
      expect(button.style.height).toBe(`${TITLE_BAR_CONTROL_HEIGHT}px`);
    }
  });

  it("rounds the strip's buttons on the radius scale, like their neighbours", () => {
    // It was a literal `8`, which is off the scale entirely (`--radius-1` is
    // 3px, `--radius-2` 6px, `--radius-3` 10px) and read as a rounder square
    // than the "…" beside it.
    const { buttons } = renderStrip();
    for (const button of buttons) {
      expect(button.getAttribute("style") ?? "").toContain("var(--radius-1)");
    }
  });
});
