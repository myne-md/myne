// @vitest-environment jsdom
// Integration: a path-form chip to an EXISTING note must NOT render broken once
// the WL-5 note-set facet is populated (repro for the "linked but looks
// unlinked" report, MYND-37/38).

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
import {
  wikilinkPickerExtension,
  setPickerActiveFrom,
} from "../../src/editor/wikilink/picker";

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
  return view;
}

describe("chip resolution after note-set reconfigure", () => {
  it("path-form chip to an existing note is NOT broken once the facet is populated", () => {
    const v = mount("[[Markdown Test Document.md|Markdown Test Document]]");
    v.dispatch({
      effects: reconfigureNoteSet([
        { noteUuid: "a", title: "Markdown Test Document", folder: null },
      ]),
    });
    const chip = host!.querySelector(".cm-wikilink-chip");
    expect(chip).not.toBeNull();
    expect(chip!.classList.contains("cm-wikilink-chip-broken")).toBe(false);
  });

  it("is broken when the note-set does NOT contain the target", () => {
    const v = mount("[[Ghost.md|Ghost]]");
    v.dispatch({
      effects: reconfigureNoteSet([
        { noteUuid: "a", title: "Markdown Test Document", folder: null },
      ]),
    });
    const chip = host!.querySelector(".cm-wikilink-chip");
    expect(chip!.classList.contains("cm-wikilink-chip-broken")).toBe(true);
  });
});

describe("active picker node stays raw (MYND-38 picker fix)", () => {
  it("the link the picker is authoring is NOT chipped while active, re-chips on close", () => {
    const v = mount("[[Mark]]");
    // Not active yet → chipped.
    expect(host!.querySelector(".cm-wikilink-chip")).not.toBeNull();
    // Mark the `[[` at position 0 as the active picker node → no chip (raw text).
    v.dispatch({ effects: setPickerActiveFrom.of(0) });
    expect(host!.querySelector(".cm-wikilink-chip")).toBeNull();
    // Clear → chips again.
    v.dispatch({ effects: setPickerActiveFrom.of(null) });
    expect(host!.querySelector(".cm-wikilink-chip")).not.toBeNull();
  });
});
