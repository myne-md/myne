// @vitest-environment jsdom
//
// The sidebar's arrow keys are scoped to the sidebar region (myne-md/myne#728,
// task 6).
//
// `makeKeyboardNavHandler` is bound at DOCUMENT level, deliberately: it has to
// answer arrows while nothing in particular is focused, which is the state
// right after clicking a note row. The cost of that reach was that it answered
// arrows ANYWHERE that was not an editable target, so an arrow press inside the
// right panel moved the note selection behind the user's back, and after F6 put
// focus somewhere on purpose that stopped being tolerable.
//
// The scope is therefore "the sidebar region, or nowhere in particular", and
// both halves are asserted. Dropping the second half would be a regression
// disguised as a fix: it is the common case, not an edge.
//
// The factory had no spec at all before this, so a floor of its existing
// behaviour is pinned here too, or a later scoping change could quietly remove
// the navigation it is scoping.

import { afterEach, describe, expect, it, vi } from "vitest";
import { makeKeyboardNavHandler } from "../../src/notes/components/NoteList";
import { REGION_ATTR } from "../../src/lib/regions";

afterEach(() => {
  document.body.innerHTML = "";
});

const IDS = ["a", "b", "c"];

function handler(selectedId: string | null, select = vi.fn()) {
  return {
    select,
    run: makeKeyboardNavHandler({
      sortedIds: IDS,
      selectedId,
      renamingId: null,
      select,
      open: async () => undefined,
    }),
  };
}

/** A keydown whose target is `target`, with a spy-able `preventDefault`. */
function keydown(key: string, target: EventTarget | null): KeyboardEvent {
  return { key, target, preventDefault: vi.fn() } as unknown as KeyboardEvent;
}

function regionElement(id: string): HTMLElement {
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div ${REGION_ATTR}="${id}"><button>in ${id}</button></div>`,
  );
  return document.querySelector(`[${REGION_ATTR}="${id}"] button`) as HTMLElement;
}

describe("the sidebar arrow keys are scoped to their region", () => {
  it("moves the selection from inside the sidebar", () => {
    const { select, run } = handler("a");
    run(keydown("ArrowDown", regionElement("sidebar")));
    expect(select).toHaveBeenCalledWith("b");
  });

  it("moves the selection when nothing in particular is focused", () => {
    // The common case: the user clicked a note row and reached for the arrows.
    // `document.body` is not in any region, and refusing it would remove
    // behaviour that works today.
    const { select, run } = handler("a");
    run(keydown("ArrowDown", document.body));
    expect(select).toHaveBeenCalledWith("b");
    const second = handler("a");
    second.run(keydown("ArrowDown", null));
    expect(second.select).toHaveBeenCalledWith("b");
  });

  it("stands down inside the editor region", () => {
    const { select, run } = handler("a");
    run(keydown("ArrowDown", regionElement("editor")));
    expect(select).not.toHaveBeenCalled();
  });

  it("stands down inside the right panel", () => {
    // The concrete regression: arrowing through the outline or the backlinks
    // list changed which note was open.
    const { select, run } = handler("a");
    run(keydown("ArrowDown", regionElement("right-panel")));
    expect(select).not.toHaveBeenCalled();
  });

  it("still stands down in a plain input, wherever it lives", () => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div ${REGION_ATTR}="sidebar"><input /></div>`,
    );
    const input = document.querySelector("input") as HTMLElement;
    const { select, run } = handler("a");
    run(keydown("ArrowDown", input));
    expect(select).not.toHaveBeenCalled();
  });

  // ── floor: the navigation the scoping must not remove ───────────────────
  it("walks the list with the arrows and clamps at both ends", () => {
    const sidebar = regionElement("sidebar");
    const up = handler("a");
    up.run(keydown("ArrowUp", sidebar));
    expect(up.select).toHaveBeenCalledWith("a");
    const down = handler("c");
    down.run(keydown("ArrowDown", sidebar));
    expect(down.select).toHaveBeenCalledWith("c");
  });

  it("jumps to the ends on Home and End", () => {
    const sidebar = regionElement("sidebar");
    const home = handler("b");
    home.run(keydown("Home", sidebar));
    expect(home.select).toHaveBeenCalledWith("a");
    const end = handler("b");
    end.run(keydown("End", sidebar));
    expect(end.select).toHaveBeenCalledWith("c");
  });

  it("opens the selected note on Enter", async () => {
    const open = vi.fn(async () => undefined);
    const run = makeKeyboardNavHandler({
      sortedIds: IDS,
      selectedId: "b",
      renamingId: null,
      select: vi.fn(),
      open,
    });
    run(keydown("Enter", regionElement("sidebar")));
    expect(open).toHaveBeenCalledWith("b");
  });
});
