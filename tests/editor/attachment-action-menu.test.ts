// @vitest-environment jsdom
//
// Shared "⋯" overflow action menu (MYND-173 / MYND-259): the body-mounted,
// toggle-on-click menu the file-card + audio-player widgets share. Drives the
// real open/close lifecycle, the per-action run() + auto-close, the
// dismiss-on-outside-pointer / scroll / resize wiring, and the teardown that
// keeps a left-open menu's document listener from outliving the widget DOM.

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOverflowMenu } from "../../src/editor/attachments/actionMenu";

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const OPTS = { buttonTestId: "card.menu-button", menuTestId: "card.menu" } as const;

function btn(wrap: HTMLElement): HTMLButtonElement {
  return wrap.querySelector('[data-testid="card.menu-button"]') as HTMLButtonElement;
}
function menu(): HTMLElement | null {
  return document.querySelector('[data-testid="card.menu"]');
}

describe("buildOverflowMenu", () => {
  it("builds an accessible toggle button with the right testid + aria", () => {
    const { wrap } = buildOverflowMenu([], OPTS);
    const b = btn(wrap);
    expect(b.getAttribute("aria-haspopup")).toBe("menu");
    expect(b.getAttribute("aria-expanded")).toBe("false");
    expect(b.getAttribute("aria-label")).toBe("Attachment actions");
    expect(b.textContent).toBe("⋯");
  });

  it("opens a body-mounted menu on click with one role=menuitem per action", () => {
    const { wrap } = buildOverflowMenu(
      [
        { label: "Export", testid: "card.export", run: () => {} },
        { label: "Remove", testid: "card.remove", run: () => {} },
      ],
      OPTS,
    );
    document.body.appendChild(wrap);
    expect(menu()).toBeNull();
    btn(wrap).click();
    const m = menu();
    expect(m).not.toBeNull();
    // Portaled out of the wrap, mounted on body, role=menu, fixed positioning.
    expect(m!.parentElement).toBe(document.body);
    expect(m!.getAttribute("role")).toBe("menu");
    expect(m!.style.position).toBe("fixed");
    expect(btn(wrap).getAttribute("aria-expanded")).toBe("true");
    const items = m!.querySelectorAll('[role="menuitem"]');
    expect(items).toHaveLength(2);
    expect((items[0] as HTMLElement).textContent).toBe("Export");
    expect((items[0] as HTMLElement).getAttribute("data-testid")).toBe("card.export");
  });

  it("toggles closed on a second button click", () => {
    const { wrap } = buildOverflowMenu([{ label: "X", testid: "card.x", run: () => {} }], OPTS);
    document.body.appendChild(wrap);
    btn(wrap).click();
    expect(menu()).not.toBeNull();
    btn(wrap).click();
    expect(menu()).toBeNull();
    expect(btn(wrap).getAttribute("aria-expanded")).toBe("false");
  });

  it("runs the action and closes when a menu item is clicked", () => {
    const run = vi.fn();
    const { wrap } = buildOverflowMenu([{ label: "Export", testid: "card.export", run }], OPTS);
    document.body.appendChild(wrap);
    btn(wrap).click();
    (menu()!.querySelector('[data-testid="card.export"]') as HTMLButtonElement).click();
    expect(run).toHaveBeenCalledOnce();
    // The menu closes immediately after the action fires.
    expect(menu()).toBeNull();
  });

  it("dismisses on an outside pointerdown but stays open for a click inside the menu", () => {
    const { wrap } = buildOverflowMenu([{ label: "X", testid: "card.x", run: () => {} }], OPTS);
    document.body.appendChild(wrap);
    btn(wrap).click();
    // mousedown inside the menu → no close.
    menu()!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(menu()).not.toBeNull();
    // mousedown elsewhere (capture-phase document listener) → close.
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(menu()).toBeNull();
  });

  it("closes on window scroll and on resize (body-mounted menu does not track)", () => {
    const { wrap } = buildOverflowMenu([{ label: "X", testid: "card.x", run: () => {} }], OPTS);
    document.body.appendChild(wrap);

    btn(wrap).click();
    window.dispatchEvent(new Event("scroll"));
    expect(menu()).toBeNull();

    btn(wrap).click();
    window.dispatchEvent(new Event("resize"));
    expect(menu()).toBeNull();
  });

  it("teardown() closes an open menu and removes its document listener", () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const { wrap, teardown } = buildOverflowMenu(
      [{ label: "X", testid: "card.x", run: () => {} }],
      OPTS,
    );
    document.body.appendChild(wrap);
    btn(wrap).click();
    expect(menu()).not.toBeNull();
    teardown();
    expect(menu()).toBeNull();
    // The capture-phase mousedown dismiss listener is detached on teardown.
    expect(removeSpy).toHaveBeenCalledWith("mousedown", expect.any(Function), true);
  });

  it("teardown() on a closed menu is a harmless no-op", () => {
    const { teardown } = buildOverflowMenu([], OPTS);
    expect(() => teardown()).not.toThrow();
    expect(menu()).toBeNull();
  });
});
