// @vitest-environment jsdom
//
// Click-to-navigate carries the GENERIC anchor (MYND-305, SYNC-5): clicking a
// resolved anchor-bearing chip dispatches `myne-open-wikilink` with the note
// UUID AND a `{ heading?, blockId? }` anchor, so the open chain can scroll to
// the deep-link target after the body loads. A plain (anchor-less) chip carries
// a null anchor. Drives the live chip extension under jsdom.

import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Wikilink } from "../../src/dialect/lezer/wikilink";
import { wikilinkChipExtensions } from "../../src/editor/wikilink";
import {
  noteSetExtension,
  reconfigureNoteSet,
} from "../../src/editor/wikilink/note-set";
import { wikilinkPickerExtension } from "../../src/editor/wikilink/picker";
import type { WikilinkAnchor } from "../../src/editor/wikilink/anchor";

let host: HTMLDivElement | null = null;
let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

function mount(doc: string): EditorView {
  host = document.createElement("div");
  document.body.appendChild(host);
  view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage, extensions: [Wikilink] }),
        noteSetExtension(),
        wikilinkPickerExtension(),
        ...wikilinkChipExtensions(),
      ],
    }),
    parent: host,
  });
  view.dispatch({
    effects: reconfigureNoteSet([{ noteUuid: "n1", title: "Spec", folder: "Projects/" }]),
  });
  return view;
}

/** Press on the (single) rendered chip, release where the pointer now is, and
 *  capture the emitted open event detail.
 *
 *  A press and a release rather than a click, because in a real browser there IS
 *  no click: the press moves the selection onto the link, which lifts the chip
 *  back to its raw `[[…]]` source and so REMOVES the pressed element from the
 *  document, and a click is only synthesised for a press and release that share
 *  a target. Measured in Chromium: `mousedown` on `.cm-wikilink-chip`, `mouseup`
 *  on `.cm-line`, no `click` at all, not even on `document`.
 *
 *  jsdom reproduces the removal itself, asserted below since it is the whole
 *  premise, so the release has to be dispatched on the content, exactly as the
 *  browser delivers it. Dispatching it on the chip would land on a detached node
 *  and reach no handler, which is the pre-fix failure wearing a test's clothes. */
function clickChipDetail(
  v: EditorView,
): { noteUuid: string; anchor: WikilinkAnchor | null } | null {
  let detail: { noteUuid: string; anchor: WikilinkAnchor | null } | null = null;
  v.dom.addEventListener("myne-open-wikilink", (e) => {
    detail = (e as CustomEvent).detail;
  });
  const chip = host!.querySelector(".cm-wikilink-chip") as HTMLElement | null;
  expect(chip).not.toBeNull();
  const at = { bubbles: true, button: 0, clientX: 20, clientY: 10 };
  chip!.dispatchEvent(new MouseEvent("mousedown", at));
  // The press revealed the raw source: the element it landed on is gone.
  expect(v.contentDOM.contains(chip)).toBe(false);
  v.contentDOM.dispatchEvent(new MouseEvent("mouseup", at));
  return detail;
}

describe("chip click carries the generic anchor (SYNC-5)", () => {
  it("a heading-anchor chip emits the heading anchor", () => {
    const v = mount("[[Spec#Goals]]");
    const detail = clickChipDetail(v);
    expect(detail).not.toBeNull();
    expect(detail!.noteUuid).toBe("n1");
    expect(detail!.anchor).toEqual({ heading: "Goals", blockId: null });
  });

  it("a `^block-id` chip emits the block anchor (imported resolve-on-click)", () => {
    const v = mount("[[Spec^para-7]]");
    const detail = clickChipDetail(v);
    expect(detail!.anchor).toEqual({ heading: null, blockId: "para-7" });
  });

  it("a plain chip emits a null anchor (opens at note top)", () => {
    const v = mount("[[Spec]]");
    const detail = clickChipDetail(v);
    expect(detail!.noteUuid).toBe("n1");
    expect(detail!.anchor).toBeNull();
  });

  it("a path-form heading chip emits the heading anchor", () => {
    const v = mount("[[Projects/Spec.md#Goals|Spec]]");
    const detail = clickChipDetail(v);
    expect(detail!.anchor).toEqual({ heading: "Goals", blockId: null });
  });
});

describe("the release navigates, using what the press recorded (myne-md/myne#601)", () => {
  it("navigates from the press's own position, not from where the release landed", () => {
    // The rendered-chip case, which is the one that failed in the app. In a real
    // browser the press reveals the raw source and the line reflows, so the
    // release lands somewhere else entirely, and there is no `click` event at
    // all, because the element the press was on has been removed. Only the
    // position read during the press survives that.
    const v = mount("[[Spec]] and a good deal of text after it\n");
    let detail: { noteUuid: string } | null = null;
    v.dom.addEventListener("myne-open-wikilink", (e) => {
      detail = (e as CustomEvent).detail;
    });
    const chip = host!.querySelector(".cm-wikilink-chip") as HTMLElement;
    chip.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        button: 0,
        clientX: 30,
        clientY: 10,
      }),
    );
    // The release arrives over prose far from the link, the way it does once the
    // raw form has pushed the line around. If the handler read the release's
    // coordinates it would resolve nothing.
    vi.spyOn(v, "posAtCoords").mockReturnValue(v.state.doc.length - 1);
    v.contentDOM.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        button: 0,
        clientX: 31,
        clientY: 10,
      }),
    );
    expect(detail).not.toBeNull();
    expect(detail!.noteUuid).toBe("n1");
  });

  it("does NOT navigate from a link that was already RAW when the press landed", () => {
    // The raw `[[…]]` form exists so the target can be edited, so a press on it
    // belongs to CodeMirror's own selection: taking it would leave no way to put
    // the caret inside a link with the mouse at all.
    //
    // An earlier version recorded any press whose coordinates landed inside a
    // Wikilink node, on the reasoning that a link is a link whichever way it is
    // drawn. That reads as consistent and removes a gesture: clicking into
    // `[[Spec]]` to fix a typo in the target navigated away instead.
    const v = mount("[[Spec]]");
    let fired = false;
    v.dom.addEventListener("myne-open-wikilink", () => {
      fired = true;
    });
    // jsdom reports no geometry, so stand in for the coordinate lookup with a
    // position inside the link's own range. It must not matter.
    vi.spyOn(v, "posAtCoords").mockReturnValue(2);
    const at = { bubbles: true, button: 0, clientX: 40, clientY: 10 };
    v.contentDOM.dispatchEvent(new MouseEvent("mousedown", at));
    v.contentDOM.dispatchEvent(new MouseEvent("mouseup", at));
    expect(fired).toBe(false);
  });

  it("resolves a position that lands on the link's own END offset", () => {
    // `posAtDOM` of a replace widget routinely answers with the range's edge. A
    // range walk over `[pos, pos + 1)` finds nothing there, because the node
    // stops exactly at `pos`, which is what the pre-fix handler did. Mocked on
    // `posAtDOM` rather than `posAtCoords` because the press is now only ever
    // recorded from the chip element, so that is the call that can return an
    // edge.
    const v = mount("[[Spec]]");
    let detail: { noteUuid: string } | null = null;
    v.dom.addEventListener("myne-open-wikilink", (e) => {
      detail = (e as CustomEvent).detail;
    });
    vi.spyOn(v, "posAtDOM").mockReturnValue(v.state.doc.length);
    const chip = host!.querySelector(".cm-wikilink-chip") as HTMLElement;
    const at = { bubbles: true, button: 0, clientX: 20, clientY: 10 };
    chip.dispatchEvent(new MouseEvent("mousedown", at));
    v.contentDOM.dispatchEvent(new MouseEvent("mouseup", at));
    expect(detail).not.toBeNull();
    expect(detail!.noteUuid).toBe("n1");
  });

  it("does NOT navigate when the press turned into a drag", () => {
    // Pressing on a chip and dragging is a text selection (§5.2), not a click.
    const v = mount("[[Spec]] and a good deal of text after it\n");
    let fired = false;
    v.dom.addEventListener("myne-open-wikilink", () => {
      fired = true;
    });
    const chip = host!.querySelector(".cm-wikilink-chip") as HTMLElement;
    chip.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        button: 0,
        clientX: 30,
        clientY: 10,
      }),
    );
    v.contentDOM.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        button: 0,
        clientX: 220,
        clientY: 10,
      }),
    );
    expect(fired).toBe(false);
  });

  it("does NOT navigate on a release with no press before it", () => {
    // A release that arrives without its own press (the pointer came down
    // outside the editor) has nothing recorded and must stay inert.
    const v = mount("[[Spec]]");
    let fired = false;
    v.dom.addEventListener("myne-open-wikilink", () => {
      fired = true;
    });
    vi.spyOn(v, "posAtCoords").mockReturnValue(2);
    v.contentDOM.dispatchEvent(
      new MouseEvent("mouseup", {
        bubbles: true,
        button: 0,
        clientX: 40,
        clientY: 10,
      }),
    );
    expect(fired).toBe(false);
  });

  it("stays inert on a press that is over no link at all", () => {
    const v = mount("just prose");
    let fired = false;
    v.dom.addEventListener("myne-open-wikilink", () => {
      fired = true;
    });
    vi.spyOn(v, "posAtCoords").mockReturnValue(3);
    const at = { bubbles: true, button: 0, clientX: 40, clientY: 10 };
    v.contentDOM.dispatchEvent(new MouseEvent("mousedown", at));
    v.contentDOM.dispatchEvent(new MouseEvent("mouseup", at));
    expect(fired).toBe(false);
  });
});
