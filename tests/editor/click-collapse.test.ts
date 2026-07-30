// @vitest-environment jsdom
//
// Click-to-collapse (`editor/click-collapse.ts`). A plain click whose
// cursor-aware reveal reflows the line can leave a tiny spurious selection; the
// extension collapses such a selection to a caret IFF the pointer didn't move
// (a click, not a drag) AND the selection is small. A real drag or a large
// selection is left alone.
//
// The collapse is deferred to a requestAnimationFrame, so each act-then-assert
// awaits a frame.

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { clickCollapseExtension } from "../../src/editor/click-collapse";

type Mounted = { view: EditorView; host: HTMLElement };

function mount(doc: string): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [clickCollapseExtension()] }),
    parent: host,
  });
  // CodeMirror's own mousedown handler resolves the pointer to a doc position
  // via real geometry (`posAndSideAtCoords` → `posAtCoords`), which throws under
  // jsdom (no layout). The collapse extension's handlers only RECORD coords and
  // never preempt CM, so we stub the geometry to make CM's selection logic bail
  // early — the test drives the *selection* explicitly to model the reflow
  // artifact that the collapse logic reacts to.
  const stub = view as unknown as {
    posAndSideAtCoords: () => { pos: number; side: number };
    posAtCoords: () => number;
  };
  stub.posAndSideAtCoords = () => ({ pos: 0, side: 0 });
  stub.posAtCoords = () => 0;
  return { view, host };
}

function teardown(m: Mounted): void {
  m.view.destroy();
  m.host.remove();
}

const raf = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

/** Dispatch a left-button mousedown then mouseup on the editor content DOM at
 *  the given client coords. `selectionAfter` models the post-click selection CM
 *  would have resolved (the reflow artifact under test) — it is set after the
 *  events fire but before the rAF, so the extension reads it on the next frame.
 *  The collapse is rAF-deferred. */
function pressRelease(
  m: Mounted,
  down: { x: number; y: number },
  up: { x: number; y: number },
  selectionAfter?: { anchor: number; head: number },
): void {
  const target = m.view.contentDOM;
  target.dispatchEvent(
    new MouseEvent("mousedown", { button: 0, clientX: down.x, clientY: down.y, bubbles: true }),
  );
  target.dispatchEvent(
    new MouseEvent("mouseup", { button: 0, clientX: up.x, clientY: up.y, bubbles: true }),
  );
  if (selectionAfter !== undefined) m.view.dispatch({ selection: selectionAfter });
}

/** A finger's press: `pointerdown` with `pointerType: "touch"` before the
 *  synthesized mouse pair, which is what a WebView emits for a tap. jsdom has no
 *  PointerEvent constructor, so the event is built from MouseEvent with the
 *  property added — the extension only reads `pointerType`. */
function touchPressRelease(
  m: Mounted,
  selectionAfter: { anchor: number; head: number },
): void {
  const target = m.view.contentDOM;
  const pd = new MouseEvent("pointerdown", { button: 0, clientX: 10, clientY: 10, bubbles: true });
  Object.defineProperty(pd, "pointerType", { value: "touch" });
  target.dispatchEvent(pd);
  pressRelease(m, { x: 10, y: 10 }, { x: 10, y: 10 }, selectionAfter);
}

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
});

describe("clickCollapseExtension", () => {
  it("collapses a small spurious selection to a caret on a no-move click", async () => {
    m = mount("Heading text here");
    // The reflow artifact: a small selection is present after the click.
    pressRelease(m, { x: 10, y: 10 }, { x: 11, y: 10 }, { anchor: 0, head: 3 }); // 1px ≤ thresh
    await raf();
    expect(m.view.state.selection.main.empty).toBe(true);
    expect(m.view.state.selection.main.head).toBe(3); // collapsed to the head
  });

  it("leaves a large selection alone even on a no-move click", async () => {
    m = mount("a much longer line of text here");
    pressRelease(m, { x: 10, y: 10 }, { x: 10, y: 10 }, { anchor: 0, head: 20 }); // > MAX_SPURIOUS
    await raf();
    expect(m.view.state.selection.main.empty).toBe(false);
    expect(m.view.state.selection.main.head).toBe(20);
  });

  it("leaves a small selection alone when the pointer moved past the threshold (a drag)", async () => {
    m = mount("Heading text here");
    pressRelease(m, { x: 10, y: 10 }, { x: 30, y: 10 }, { anchor: 0, head: 3 }); // moved 20px
    await raf();
    expect(m.view.state.selection.main.empty).toBe(false);
  });

  it("does nothing when the selection is already a caret", async () => {
    m = mount("plain text");
    pressRelease(m, { x: 10, y: 10 }, { x: 10, y: 10 }, { anchor: 4, head: 4 });
    await raf();
    expect(m.view.state.selection.main.head).toBe(4);
    expect(m.view.state.selection.main.empty).toBe(true);
  });

  it("ignores a non-left (e.g. right) mousedown — no collapse", async () => {
    m = mount("Heading text here");
    // Right-button mousedown: the handler records nothing, so mouseup bails.
    m.view.contentDOM.dispatchEvent(
      new MouseEvent("mousedown", { button: 2, clientX: 10, clientY: 10, bubbles: true }),
    );
    m.view.contentDOM.dispatchEvent(
      new MouseEvent("mouseup", { button: 0, clientX: 10, clientY: 10, bubbles: true }),
    );
    m.view.dispatch({ selection: { anchor: 0, head: 3 } });
    await raf();
    expect(m.view.state.selection.main.empty).toBe(false);
  });

  // MYND-642: a double-TAP on a short word used to lose its selection. The
  // `event.detail >= 2` exemption is the only path a deliberate double-press
  // has, and WebKit's tap-synthesized mouse events do not reliably carry
  // `detail >= 2` — so the collapse ran and the word dropped to a caret. It
  // looked intermittent only because the collapse is capped at MAX_SPURIOUS:
  // short words broke, long ones survived.
  it("leaves a touch-originated selection alone, however small", async () => {
    m = mount("the cat sat");
    touchPressRelease(m, { anchor: 4, head: 7 }); // "cat" — 3 chars, well under the cap
    await raf();
    expect(
      m.view.state.selection.main.empty,
      "a double-tapped short word must stay selected",
    ).toBe(false);
    expect(m.view.state.selection.main.anchor).toBe(4);
    expect(m.view.state.selection.main.head).toBe(7);
  });

  it("still collapses a MOUSE click after a touch press has been seen", async () => {
    // The touch flag must track the press in flight, not latch for the session:
    // a trackpad click after a tap (iPad with a mouse, a hybrid laptop) still
    // produces the reflow artifact and still needs collapsing.
    m = mount("Heading text here");
    touchPressRelease(m, { anchor: 4, head: 7 });
    await raf();
    const pd = new MouseEvent("pointerdown", { button: 0, clientX: 10, clientY: 10, bubbles: true });
    Object.defineProperty(pd, "pointerType", { value: "mouse" });
    m.view.contentDOM.dispatchEvent(pd);
    pressRelease(m, { x: 10, y: 10 }, { x: 10, y: 10 }, { anchor: 0, head: 3 });
    await raf();
    expect(m.view.state.selection.main.empty).toBe(true);
  });
});
