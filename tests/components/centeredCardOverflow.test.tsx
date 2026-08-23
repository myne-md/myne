// @vitest-environment jsdom
//
// myne-md/myne#565's shared half. `<CenteredCard>` is the envelope for thirteen
// screens (Unlock, RestoreBackup, AccountBootstrap, the recover flow, the two
// Editor-mounted takeovers) and every one of them was losing the same 38px.
//
// The leaf that made it visible (`VaultPicker`) has its own test; this one holds
// the primitive, which is where the risk actually is. jsdom has no layout, so
// what is pinned is the three declarations that decide the outcome, each of
// which was absent, plus the two the scroll-region contract adds.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CenteredCard } from "../../src/components/primitives/CenteredCard";

afterEach(cleanup);

/**
 * One render, three levels read off it: the scroll region that owns the
 * overflow and the fade, the card frame one level out, and the centring root one
 * further. Rendering per accessor would put two probes in the document.
 */
function levels(): { scroller: HTMLElement; card: HTMLElement; root: HTMLElement } {
  render(
    <CenteredCard>
      <p data-testid="probe">content</p>
    </CenteredCard>,
  );
  const scroller = screen.getByTestId("probe").parentElement as HTMLElement;
  const card = scroller.parentElement as HTMLElement;
  return { scroller, card, root: card.parentElement as HTMLElement };
}

describe("CenteredCard inside App's shortened column", () => {
  it("does not force a 100vh root", () => {
    // App.tsx renders every consumer BELOW a 38px window-drag strip, inside a
    // `flex: 1 / minHeight: 0` column. A 100vh child there is 38px taller than
    // the box it sits in, nothing in the chain scrolls, and centring inside the
    // over-tall box drops the card half that distance below the optical centre.
    const { root } = levels();
    expect(root.style.minHeight).not.toBe("100vh");
    expect(root.style.flexGrow).toBe("1");
    expect(root.style.minHeight).toBe("0px");
  });

  it("bounds the card and scrolls the region INSIDE it", () => {
    const { card, scroller } = levels();
    expect(card.style.maxHeight).toBe("100%");
    expect(card.style.overflowY).toBe("");
    expect(scroller.style.overflowY).toBe("auto");
    // The scroller is a child of a COLUMN card, so here filling the parent's
    // main axis IS filling vertically and the grow is load-bearing: without it
    // the scroller is content-height, the card never overflows it, and the fade
    // this whole primitive exists for measures `false / false` forever.
    //
    // Asserted because the shared style was split by axis (`scrollRegionStyle`
    // is now axis-agnostic, `fillingScrollRegionStyle` adds the grow), and only
    // the row-axis direction of that split had a test. A split verified in one
    // direction is a split that can silently stop working in the other.
    expect(scroller.style.flexGrow).toBe("1");
  });

  it("does not mask the card, so its frame survives an overflow", () => {
    // A `mask-image` clips the whole rendered box. On the card that means the
    // `--bg-2` fill, the `--line-1` hairline and the `--radius-2` corners fade
    // to transparent the moment anything overflows, which is the chrome
    // `docs/design/README.md` defines a card by. The fade belongs on the
    // content, one level in.
    const { card, scroller } = levels();
    expect(card.className).not.toContain("myne-scroll-fade");
    expect(scroller.className).toContain("myne-scroll-fade");
  });

  it("pulls the scroller out to the card's padding box and pads it back", () => {
    // Otherwise the scrollbar and the faded edges stop at the gutter, and the
    // fade sits in 32px of padding where there is nothing to fade.
    const el = levels().scroller;
    expect(el.style.margin).toBe("calc(var(--space-6) * -1)");
    expect(el.style.padding).toBe("var(--space-6)");
  });
});
