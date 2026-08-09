// @vitest-environment jsdom
//
// myne#329 — the slash menu must close when its own `/` is deleted.
//
// The selection guard read `head < triggerFrom`, and `triggerFrom` IS the index
// of the `/`. So a caret landing exactly there — which is where Backspace over
// the trigger puts it — did not satisfy the guard and the menu stayed open. Its
// filter slice degenerated to the empty string, the fuzzy filter returns every
// command for an empty query, and the whole menu kept rendering.
//
// The `Prec.highest` Enter binding then consumed the key and applied the first
// entry, `/h1`, whose `replaceLinePrefix` rewrote the caret's line to
// `# <line>` and swallowed the newline the user asked for. Undo recovers it,
// but it is a silent wrong edit on a line the user never targeted.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Mounted, mount, teardown } from "./_conformance";

beforeAll(() => {
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

const menu = () => document.body.querySelector(".cm-slash-menu");

describe("the slash menu and its trigger", () => {
  it("closes when the `/` is backspaced away", async () => {
    m = mount("hello ", 6);
    m.view.coordsAtPos = () => null;

    m.view.dispatch({ changes: { from: 6, insert: "/" }, selection: { anchor: 7 } });
    await raf();
    expect(menu()).not.toBeNull();

    // Backspace over the trigger: the `/` is gone and the caret is exactly at
    // where it was.
    m.view.dispatch({ changes: { from: 6, to: 7 }, selection: { anchor: 6 } });
    await raf();
    expect(menu()).toBeNull();
  });

  it("leaves Enter alone once the trigger is gone", async () => {
    m = mount("hello ", 6);
    m.view.coordsAtPos = () => null;
    m.view.dispatch({ changes: { from: 6, insert: "/" }, selection: { anchor: 7 } });
    await raf();
    m.view.dispatch({ changes: { from: 6, to: 7 }, selection: { anchor: 6 } });
    await raf();

    // The document must not have been rewritten by `/h1`.
    expect(m.view.state.doc.toString()).toBe("hello ");
    expect(m.view.state.doc.toString().startsWith("# ")).toBe(false);
  });

  it("stays open while the trigger is still there", async () => {
    // The bound in the other direction: typing a query after `/` must not close
    // the menu.
    m = mount("hello ", 6);
    m.view.coordsAtPos = () => null;
    m.view.dispatch({ changes: { from: 6, insert: "/" }, selection: { anchor: 7 } });
    await raf();
    m.view.dispatch({ changes: { from: 7, insert: "h" }, selection: { anchor: 8 } });
    await raf();
    expect(menu()).not.toBeNull();
  });

  it("closes when the caret moves left of the trigger", async () => {
    m = mount("hello ", 6);
    m.view.coordsAtPos = () => null;
    m.view.dispatch({ changes: { from: 6, insert: "/" }, selection: { anchor: 7 } });
    await raf();
    m.view.dispatch({ selection: { anchor: 3 } });
    await raf();
    expect(menu()).toBeNull();
  });

  // myne#408 — a no-match query closes the menu, but deleting the query back
  // toward the `/` must bring it back (the menu tracks the query in BOTH
  // directions). The reopen-on-deletion path is guarded so it never resurrects
  // the #329 case above.

  it("reopens the full list when a no-match query is deleted back to a bare `/`", async () => {
    m = mount("", 0);
    m.view.coordsAtPos = () => null;
    m.view.dispatch({ changes: { from: 0, insert: "/" }, selection: { anchor: 1 } });
    await raf();
    expect(menu()).not.toBeNull(); // opens with the full list

    m.view.dispatch({ changes: { from: 1, insert: "skj" }, selection: { anchor: 4 } });
    await raf();
    expect(menu()).toBeNull(); // "/skj" matches nothing → closes

    m.view.dispatch({ changes: { from: 1, to: 4 }, selection: { anchor: 1 } }); // back to "/"
    await raf();
    expect(menu()).not.toBeNull(); // reopened — the exact state that opened it
  });

  it("reopens at a matching prefix mid-deletion, not only at a bare `/` (continuous)", async () => {
    m = mount("", 0);
    m.view.coordsAtPos = () => null;
    m.view.dispatch({ changes: { from: 0, insert: "/" }, selection: { anchor: 1 } });
    await raf();
    // `/todozz` misses (no command has the trailing `zz`), so the menu closes.
    m.view.dispatch({ changes: { from: 1, insert: "todozz" }, selection: { anchor: 7 } });
    await raf();
    expect(menu()).toBeNull();

    // Delete just the `zz`: the query is back to `todo` — NOT a bare `/` — and it
    // matches the `todo` command again, so the menu returns before the trigger.
    m.view.dispatch({ changes: { from: 5, to: 7 }, selection: { anchor: 5 } });
    await raf();
    expect(menu()).not.toBeNull();
    expect(m.view.state.doc.toString()).toBe("/todo");
  });

  it("does not reopen when the `/` itself is deleted (#329 preserved)", async () => {
    m = mount("", 0);
    m.view.coordsAtPos = () => null;
    m.view.dispatch({ changes: { from: 0, insert: "/" }, selection: { anchor: 1 } });
    await raf();
    m.view.dispatch({ changes: { from: 1, insert: "skj" }, selection: { anchor: 4 } });
    await raf();
    m.view.dispatch({ changes: { from: 1, to: 4 }, selection: { anchor: 1 } }); // back to "/"
    await raf();
    expect(menu()).not.toBeNull(); // reopened at bare `/`

    // Now delete the `/` itself — the reopen path has no existing `/` to latch
    // onto, and the #329 selection guard closes it. It must stay closed, and the
    // doc must not be rewritten by a stray Enter path.
    m.view.dispatch({ changes: { from: 0, to: 1 }, selection: { anchor: 0 } });
    await raf();
    expect(menu()).toBeNull();
    expect(m.view.state.doc.toString()).toBe("");
  });
});
