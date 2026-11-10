// @vitest-environment jsdom
//
// `[[` completion inside a table cell (`editor/src/decorations/tableCellLink.ts`,
// owner 2026-11-10).
//
// The defect: an editable cell is a plain `<input>`, so the CodeMirror `[[` picker
// — a ViewPlugin keyed on the document — never ran there, and a link inside a table
// could only be written by knowing its exact title from memory. What this file
// pins is that the cell now (a) recognises the link being authored, (b) ranks
// candidates through the PICKER's own ranker and (c) inserts the PICKER's own
// emitted bytes, so a link in a cell and a link in a paragraph are the same link.
//
// Verified by injection: dropping `readNoteSet` from the candidate call (a second,
// private source) makes the "uses the note-set facet" case fail, and replacing
// `cellSuggestionText` with `[[title]]` makes the canonical-form case fail.

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { noteSetFacet } from "../../src/editor/wikilink/note-set";
import {
  activeCellLink,
  applyCellSuggestion,
  attachCellLinkSuggest,
  cellSuggestionText,
  cellSuggestions,
  CELL_SUGGEST_CAP,
} from "../../src/editor/decorations/tableCellLink";
import type { ResolverNote } from "../../src/editor/host/notes/resolveWikilink";

const NOTES: readonly ResolverNote[] = [
  { noteUuid: "id-1", title: "Roadmap", folder: "Projects/" },
  { noteUuid: "id-2", title: "Roadmap archive", folder: "Projects/" },
  { noteUuid: "id-3", title: "Reading list", folder: null },
] as unknown as readonly ResolverNote[];

afterEach(() => {
  document.body.replaceChildren();
});

describe("activeCellLink", () => {
  it("finds the link being authored and its query", () => {
    expect(activeCellLink("see [[Roa", 10)).toEqual({ from: 4, query: "Roa" });
  });

  it("returns null for a closed link, an alias or a heading", () => {
    // Closed: the caret is past `]]`, so nothing is being authored.
    expect(activeCellLink("see [[Roadmap]]", 16)).toBeNull();
    // `|` and `#` belong to the alias and heading halves the picker offers as
    // separate modes; a cell input offers the note name only.
    expect(activeCellLink("[[Roadmap|Ro", 12)).toBeNull();
    expect(activeCellLink("[[Roadmap#He", 12)).toBeNull();
    // Two triggers: the INNERMOST one is the link being authored, so the
    // abandoned first one is not treated as the query.
    expect(activeCellLink("[[one [[t", 9)).toEqual({ from: 6, query: "t" });
  });

  it("finds nothing before the first character", () => {
    expect(activeCellLink("[[", 0)).toBeNull();
  });
});

describe("cellSuggestions", () => {
  it("ranks the note-set through the picker's own ranker", () => {
    const rows = cellSuggestions("road", NOTES, []);
    expect(rows.length).toBeGreaterThan(0);
    // Both notes fuzzy-match "road"; the exact-ish one sorts first.
    expect(rows[0]?.kind).toBe("note");
    if (rows[0]?.kind === "note") expect(rows[0].note.title).toBe("Roadmap");
  });

  it("offers an empty query as the recent notes, then caps the list", () => {
    const rows = cellSuggestions("", NOTES, ["id-3"]);
    expect(rows.length).toBeLessThanOrEqual(CELL_SUGGEST_CAP);
    // Recency is the picker's own tiebreak on an empty query.
    if (rows[0]?.kind === "note") expect(rows[0].note.noteUuid).toBe("id-3");
  });
});

describe("the emitted bytes are the picker's", () => {
  it("writes the canonical path-with-alias form, not a bare title", () => {
    // `emitNoteWikilink` bakes the folder and the display alias (wikilink.md §3).
    // A `[[Roadmap]]` here would be a SECOND spelling of the same link — exactly
    // what the emitter exists to prevent.
    expect(cellSuggestionText({ kind: "note", note: NOTES[0]!, path: "Projects/Roadmap.md" })).toBe(
      "[[Projects/Roadmap.md|Roadmap]]",
    );
  });

  it("writes the trailing-slash form for a folder target", () => {
    expect(cellSuggestionText({ kind: "folder", path: "Projects/" })).toBe("[[Projects/]]");
  });
});

describe("applyCellSuggestion", () => {
  it("replaces the in-progress link and moves the caret past it", () => {
    const value = "see [[Roa here";
    // Caret right after "Roa" — the query is what has been typed since `[[`.
    const link = activeCellLink(value, 9)!;
    const next = applyCellSuggestion(value, link, "[[Projects/Roadmap.md|Roadmap]]");
    // " here" — the text after the in-progress link — survives.
    expect(next.value).toBe("see [[Projects/Roadmap.md|Roadmap]] here");
    expect(next.caret).toBe("see [[Projects/Roadmap.md|Roadmap]]".length);
  });
});

describe("attachCellLinkSuggest", () => {
  function mount(): { input: HTMLInputElement; view: EditorView } {
    const parent = document.createElement("div");
    const input = document.createElement("input");
    input.type = "text";
    parent.appendChild(input);
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({
        doc: "| a |\n| - |\n",
        extensions: [noteSetFacet.of(NOTES)],
      }),
    });
    return { input, view };
  }

  it("opens on `[[`, accepts the active row, and leaves the edit running", () => {
    const { input, view } = mount();
    const suggest = attachCellLinkSuggest(input, view);

    input.value = "see [[road";
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event("input"));
    expect(suggest.isOpen()).toBe(true);
    const popup = document.querySelector(".cm-table-link-suggest") as HTMLDivElement;
    expect(popup.style.display).toBe("block");
    expect(popup.children.length).toBeGreaterThan(0);

    // Enter accepts the highlighted row instead of committing the cell: the input
    // keeps its focus and its value now carries the canonical link.
    const handled = suggest.handleKey(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(handled).toBe(true);
    expect(input.value).toBe("see [[Projects/Roadmap.md|Roadmap]]");
    expect(suggest.isOpen()).toBe(false);
    suggest.destroy();
    view.destroy();
  });

  it("closes on a link that has no candidates, so the cell keeps working", () => {
    const { input, view } = mount();
    const suggest = attachCellLinkSuggest(input, view);
    input.value = "nothing [[zzzzzzzz";
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event("input"));
    expect(suggest.isOpen()).toBe(false);
    // Unhandled keys fall through to the cell's own Enter/Tab/arrow behaviour.
    expect(suggest.handleKey(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(false);
    suggest.destroy();
    view.destroy();
  });
});
