// @vitest-environment jsdom
//
// Click-to-navigate carries the GENERIC anchor (MYND-305, SYNC-5): clicking a
// resolved anchor-bearing chip dispatches `myne-open-wikilink` with the note
// UUID AND a `{ heading?, blockId? }` anchor, so the open chain can scroll to
// the deep-link target after the body loads. A plain (anchor-less) chip carries
// a null anchor. Drives the live chip extension under jsdom.

import { afterEach, describe, expect, it } from "vitest";
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

/** Click the (single) rendered chip and capture the emitted open event detail. */
function clickChipDetail(
  v: EditorView,
): { noteUuid: string; anchor: WikilinkAnchor | null } | null {
  let detail: { noteUuid: string; anchor: WikilinkAnchor | null } | null = null;
  v.dom.addEventListener("myne-open-wikilink", (e) => {
    detail = (e as CustomEvent).detail;
  });
  const chip = host!.querySelector(".cm-wikilink-chip") as HTMLElement | null;
  expect(chip).not.toBeNull();
  // jsdom has no geometry; `posAtDOM` works off the DOM tree, which is enough.
  chip!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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
