// @vitest-environment jsdom
//
// Regression: keyboard arrow nav must not be hijacked by the mouse pointer.
//
// `move()` rebuilds the menu rows (`replaceChildren`) and `scrollIntoView`s the
// selection on every press. When the pointer rests over the menu, the browser
// fires a synthetic `mouseenter`/`mouseover` on whichever fresh row now sits
// under the (stationary) cursor — which used to yank the highlight back to the
// mouse and fight the arrow keys (ArrowDown appeared to "jump back to the top").
// The hover handler is bound to `mousemove`, which only fires on real pointer
// motion, so a stationary mouse can no longer steal the keyboard highlight.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Mounted, mount, teardown } from "./_conformance";

beforeAll(() => {
  // jsdom doesn't implement scrollIntoView; the menu calls it on the selected
  // row during render. A no-op keeps render() from throwing.
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = () => {};
  }
});

const raf = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
});

describe("slash menu hover vs keyboard nav", () => {
  it("a stationary-pointer mouseenter never steals the keyboard highlight; a real mousemove does", async () => {
    m = mount("", 0);
    // jsdom has no layout, so `coordsAtPos` throws (it does real geometry); the
    // menu's render path tolerates a null return and falls back to the editor
    // rect. Force that branch so render doesn't blow up under jsdom.
    m.view.coordsAtPos = () => null;
    // Typing `/` at line start opens the menu (render is rAF-deferred).
    m.view.dispatch({ changes: { from: 0, insert: "/" }, selection: { anchor: 1 } });
    await raf();

    const menu = document.body.querySelector(".cm-slash-menu");
    expect(menu).not.toBeNull();
    const rows = menu!.querySelectorAll<HTMLElement>(".cm-slash-menu-row");
    expect(rows.length).toBeGreaterThan(3);

    const isSelected = (i: number): boolean =>
      rows[i].classList.contains("cm-slash-menu-row-selected");

    // Row 0 is highlighted on open.
    expect(isSelected(0)).toBe(true);

    // Synthetic mouseenter (what the browser fires on a rebuild/scroll under a
    // stationary pointer) must NOT move the highlight.
    rows[2].dispatchEvent(new MouseEvent("mouseenter"));
    expect(isSelected(0)).toBe(true);
    expect(isSelected(2)).toBe(false);

    // Genuine pointer motion (mousemove) DOES move the highlight.
    rows[2].dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    expect(isSelected(2)).toBe(true);
    expect(isSelected(0)).toBe(false);
  });
});
