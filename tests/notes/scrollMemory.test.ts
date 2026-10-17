// @vitest-environment jsdom
//
// The reading position is remembered as a DOCUMENT anchor (myne-md/myne#600).
//
// jsdom has no layout, so what a `scrollTop` would have been cannot be asserted
// here, and that is the point of the change rather than a limitation of the
// test: the old memory WAS a `scrollTop`, and a pixel is wrong twice over (it is
// clamped when it is restored before the document has finished growing, and it
// points at different content once a narrower pane re-wraps the text). What this
// file pins is the part that decides both: the map's contract, and that a
// restore is dispatched as CodeMirror's own `scrollIntoView` effect rather than
// assigned to a scroller.

import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  beginScrollRestore,
  evictClosedTabs,
  forgetScroll,
  isRestoringScroll,
  readScrollAnchor,
  recallScroll,
  rememberScroll,
  resetScrollMemory,
} from "../../src/notes/scrollMemory";
// `applyScrollAnchor` is the one function here that needs the `EditorView`
// VALUE, so it lives in its own module (see that file's header). The rest of the
// store must stay CodeMirror-free: the vault-leaving paths import it before
// anything the editor owns.
import { applyScrollAnchor } from "../../src/notes/scrollAnchorApply";

afterEach(() => {
  resetScrollMemory();
  vi.restoreAllMocks();
});

const DOC = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");

/** A view whose measurement answers are stubbed, since jsdom reports zeroes for
 *  every rect and would make `posAtCoords` unanswerable. */
function stubbedView(posAtTop: number | null, lineTop: number): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({ doc: DOC }),
    parent: host,
  });
  vi.spyOn(view, "posAtCoords").mockReturnValue(posAtTop);
  vi.spyOn(view, "lineBlockAt").mockReturnValue({
    top: lineTop,
    from: 0,
    to: 0,
    height: 20,
    bottom: lineTop + 20,
    length: 0,
    widget: null,
    widgetLineBreaks: 0,
    type: 0,
  } as never);
  vi.spyOn(view.contentDOM, "getBoundingClientRect").mockReturnValue({
    top: 100,
    left: 10,
  } as DOMRect);
  return view;
}

/** A scroller whose top edge is at y=150. */
function stubbedScroller(): HTMLElement {
  const el = document.createElement("div");
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({ top: 150 } as DOMRect);
  return el;
}

describe("readScrollAnchor", () => {
  it("reports the position at the viewport top and how far below it that line starts", () => {
    // content top 100 + the line's own top 80 = 180, which is 30px below the
    // scroller's top edge at 150.
    const view = stubbedView(120, 80);
    expect(readScrollAnchor(view, stubbedScroller())).toEqual({
      pos: 120,
      offsetPx: 30,
    });
  });

  it("reports a NEGATIVE offset for a line scrolled partly off the top", () => {
    // The usual case: the top line is half out of view, and the fraction is what
    // keeps a restore from jumping by up to one line height.
    const view = stubbedView(120, 30);
    expect(readScrollAnchor(view, stubbedScroller())?.offsetPx).toBe(-20);
  });

  it("gives up rather than guessing when the position cannot be measured", () => {
    expect(readScrollAnchor(stubbedView(null, 0), stubbedScroller())).toBeNull();
  });

  it("gives up on a position CodeMirror itself refuses to measure", () => {
    // The `catch` around `lineBlockAt`, driven by the real method rather than by
    // a stub that throws. A stub proves the catch runs; it cannot prove the
    // branch is reachable, and the comment there names a specific cause (a
    // position outside the measured height map), which a thrown stub asserts
    // nothing about. So `lineBlockAt` is left alone here and only `posAtCoords`
    // is made to answer with a position past the end of the document, which is
    // what a stale coordinate read during a re-layout looks like.
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView({
      state: EditorState.create({ doc: DOC }),
      parent: host,
    });
    vi.spyOn(view, "posAtCoords").mockReturnValue(DOC.length + 5000);
    vi.spyOn(view.contentDOM, "getBoundingClientRect").mockReturnValue({
      top: 100,
      left: 10,
    } as DOMRect);
    expect(readScrollAnchor(view, stubbedScroller())).toBeNull();
    view.destroy();
    host.remove();
  });
});

describe("the memory", () => {
  it("remembers per note and recalls what it stored", () => {
    rememberScroll("note-a", stubbedView(120, 80), stubbedScroller());
    rememberScroll("note-b", stubbedView(300, 80), stubbedScroller());
    expect(recallScroll("note-a")?.pos).toBe(120);
    expect(recallScroll("note-b")?.pos).toBe(300);
  });

  it("does not overwrite a good anchor with an unmeasurable moment", () => {
    // A pane mid-split has no layout to read. Writing a null there would lose
    // exactly the position the split is about to need.
    rememberScroll("note-a", stubbedView(120, 80), stubbedScroller());
    rememberScroll("note-a", stubbedView(null, 0), stubbedScroller());
    expect(recallScroll("note-a")?.pos).toBe(120);
  });

  it("forgets a note on request, which is what closing its tab does", () => {
    rememberScroll("note-a", stubbedView(120, 80), stubbedScroller());
    forgetScroll("note-a");
    expect(recallScroll("note-a")).toBeUndefined();
  });

  it("survives the component that captured it", () => {
    // The whole reason it is module state: a split unmounts the pane.
    rememberScroll("note-a", stubbedView(120, 80), stubbedScroller());
    expect(recallScroll("note-a")).toBeDefined();
  });
});

describe("applyScrollAnchor", () => {
  it("dispatches CodeMirror's scrollIntoView rather than assigning a scrollTop", () => {
    const view = stubbedView(0, 0);
    const dispatch = vi.spyOn(view, "dispatch");
    applyScrollAnchor(view, { pos: 120, offsetPx: -20 }, "n1");
    expect(dispatch).toHaveBeenCalledTimes(1);
    const spec = dispatch.mock.calls[0]![0] as { effects?: unknown };
    expect(spec.effects).toBeDefined();
  });

  it("clamps a position past the end of a document that has since shrunk", () => {
    const view = stubbedView(0, 0);
    const dispatch = vi.spyOn(view, "dispatch");
    applyScrollAnchor(view, { pos: 10_000, offsetPx: 0 }, "n1");
    // Dispatching a position outside the document throws; the clamp is what
    // keeps a stale anchor from taking the editor down with it.
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("evictClosedTabs", () => {
  it("forgets a closed tab whose note was never in the state cache", () => {
    // The defect this function exists to end. The eviction used to walk the
    // state cache's keys, which hold only notes the pane switched AWAY from, so
    // a tab opened, scrolled and closed without ever being left kept its
    // reading position for the rest of the session. The cache here is empty on
    // purpose: that is the case, not a simplification.
    rememberScroll("n1", stubbedView(120, 80), stubbedScroller());
    expect(recallScroll("n1")).toBeDefined();
    const cache = new Map<string, unknown>();
    expect(evictClosedTabs(new Set(["n1"]), new Set(), cache)).toEqual(["n1"]);
    expect(recallScroll("n1")).toBeUndefined();
  });

  it("keeps the anchor of a tab that is still open", () => {
    // The split case: the source pane keeps its tab, so nothing was closed.
    rememberScroll("n1", stubbedView(120, 80), stubbedScroller());
    expect(
      evictClosedTabs(new Set(["n1"]), new Set(["n1"]), new Map()),
    ).toEqual([]);
    expect(recallScroll("n1")).toBeDefined();
  });

  it("evicts the cached state alongside, so the two cannot disagree", () => {
    const cache = new Map<string, unknown>([["n1", {}], ["n2", {}]]);
    evictClosedTabs(new Set(["n1", "n2"]), new Set(["n2"]), cache);
    expect([...cache.keys()]).toEqual(["n2"]);
  });
});

// myne-md/myne#651, a note walked one notch down the viewport on every sidebar
// toggle and never walked back.
//
// The cause is a feedback loop with no damping, not a bad measurement.
// `applyScrollAnchor` scrolls; that scroll fires the pane's scroll listener; the
// listener calls `rememberScroll`, storing where the restore actually landed. A
// restore is exact only when nothing changed, and it runs precisely because the
// pane's width changed and re-wrapped the text, so the LINE goes back and its
// offset within it does not. The residue is written over the anchor, so the next
// restore starts from the drifted value and adds its own.
describe("a restore does not write its own drift back", () => {
  it("holds the anchor steady across ten restore cycles", () => {
    // Each cycle reports a position 3px off from where it was asked to land ,
    // the residue a re-wrap leaves. Before the fix that compounded to 30px,
    // which is more than a line.
    rememberScroll("n1", stubbedView(120, 80), stubbedScroller());
    const original = recallScroll("n1");
    expect(original).toEqual({ pos: 120, offsetPx: 30 });

    for (let i = 1; i <= 10; i++) {
      const view = stubbedView(120, 80 + i * 3); // the drifted reading
      applyScrollAnchor(view, recallScroll("n1")!, "n1");
      // The restore's own scroll reporting back, exactly as the pane's listener
      // does. Suppressed, so it must change nothing.
      rememberScroll("n1", view, stubbedScroller());
    }

    expect(recallScroll("n1")).toEqual(original);
  });

  // Non-vacuity, and the half that proves the anchor is not simply frozen.
  it("remembers a genuine scroll once the window has passed", () => {
    rememberScroll("n1", stubbedView(120, 80), stubbedScroller());
    applyScrollAnchor(stubbedView(120, 80), recallScroll("n1")!, "n1");

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10_000);
    expect(isRestoringScroll("n1")).toBe(false);

    rememberScroll("n1", stubbedView(120, 200), stubbedScroller());
    expect(recallScroll("n1")?.offsetPx).toBe(150);
  });

  // Per note: restoring one pane's note must not silence the remember for a
  // different note the reader is scrolling in another pane.
  it("suppresses only the note being restored", () => {
    const t0 = 5_000_000;
    beginScrollRestore("n1", t0);
    expect(isRestoringScroll("n1", t0 + 100)).toBe(true);
    expect(isRestoringScroll("n2", t0 + 100)).toBe(false);
  });

  it("covers PaneView's whole settle chain, not just the scroll", () => {
    // The write to suppress arrives on the trailing edge of a 120ms timer that
    // starts when the scroll lands, so a window shorter than that is the bug
    // back. Asserted as a property rather than by reading the constant, so
    // tightening it fails here.
    const t0 = 6_000_000;
    beginScrollRestore("n1", t0);
    expect(isRestoringScroll("n1", t0 + 240)).toBe(true);
  });

  it("clears the in-flight marks on reset, like the anchors themselves", () => {
    // `resetScrollMemory` runs on every vault-leaving path
    // (`check-frontend-lock-teardown.mjs` asserts it). A mark left behind
    // outlives its vault and silences the first scroll write of the next
    // session's note with the same id.
    beginScrollRestore("n1");
    resetScrollMemory();
    expect(isRestoringScroll("n1")).toBe(false);
  });
});
