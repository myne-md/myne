// @vitest-environment jsdom
//
// The wikilink picker's keyboard path, driven against the FULL composed editor
// (myne-md/myne#601 item 3).
//
// # Why this file exists rather than another case in `wikilink-picker.test.ts`
//
// That file mounts `[noteSetExtension(), wikilinkPickerExtension()]` and nothing
// else. Its ArrowDown/Enter cases pass, and they cannot fail for the reason the
// issue reports, because a key can only be stolen by a handler that file never
// installs. The issue is explicit about this: "Item 3 is not a missing binding
// ... the thread to pull is why they do not run", and it asks that the surface
// be established before any binding is touched.
//
// So this mounts what the user actually runs, `myneExtensions()`, and asks the
// same four questions of it. If a chord is consumed by something earlier in the
// composed keymap, this is where that shows up and the other file cannot.

import { afterEach, describe, expect, it } from "vitest";
import { runScopeHandlers } from "@codemirror/view";
import { mount, teardown, type Mounted } from "./_conformance";
import { reconfigureNoteSet } from "../../src/editor/wikilink/note-set";
import type { ResolverNote } from "../../src/notes/resolveWikilink";

if (typeof Element.prototype.scrollIntoView !== "function") {
  Element.prototype.scrollIntoView = () => {};
}

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
});

const NOTES: readonly ResolverNote[] = [
  { noteUuid: "a", title: "Wednesday", folder: "notes/2025/" },
  { noteUuid: "b", title: "Weekly Review", folder: "Projects/" },
  { noteUuid: "c", title: "Welcome", folder: null },
];

/** Type `text` one character at a time, so the `[[` pair is seen as a pair. */
function type(view: Mounted["view"], text: string): void {
  for (const ch of text) {
    const at = view.state.selection.main.head;
    view.dispatch({ changes: { from: at, insert: ch }, selection: { anchor: at + 1 } });
  }
}

/** The production dispatch path, not a direct call into the plugin.
 *
 *  The caller must await a frame afterwards before reading the DOM: `move()`
 *  goes through `scheduleRender`, which is rAF-driven, so the highlight lands
 *  one frame after the key is handled. Reading immediately reports the OLD row
 *  and looks exactly like an arrow key that does nothing. */
function key(view: Mounted["view"], name: string): boolean {
  return runScopeHandlers(
    view,
    new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
    "editor",
  );
}

function menu(): Element | null {
  // The picker REUSES the slash-menu surface (`extensions.ts`, where it is
  // composed), so the container is `.cm-slash-menu` and the picker's own rows
  // carry `.cm-wiki-picker-row`. Querying `.cm-wikilink-picker`, which is what
  // the name suggests, matches nothing and reads as "the picker never opened".
  return document.querySelector(".cm-wiki-picker");
}

/** The index of the highlighted row, or -1. Asserting on the SELECTION rather
 *  than on the handler's return value is the difference that matters: a key can
 *  be "handled" by something else entirely and still return true. */
function selectedRow(): number {
  const rows = Array.from(document.querySelectorAll(".cm-wiki-picker-row"));
  return rows.findIndex((r) => r.className.includes("selected"));
}

/** The picker renders on a frame, not synchronously with the dispatch, so
   *  every case awaits one before asking what is on screen. Skipping that is
   *  how this file first reported "the picker never opened" against a picker
   *  that opens perfectly well. */
  const raf = (): Promise<void> =>
    new Promise((r) => {
      requestAnimationFrame(() => r());
    });

describe("wikilink picker keyboard path, composed editor (myne#601 item 3)", () => {
  async function open(): Promise<Mounted> {
    const mounted = mount("");
    mounted.view.coordsAtPos = () => null; // jsdom has no layout
    mounted.view.dispatch({ effects: reconfigureNoteSet(NOTES) });
    type(mounted.view, "[[");
    await raf();
    await raf();
    return mounted;
  }

  it("renders the picker's own surface, not another one", async () => {
    m = await open();
    // Establishing WHICH surface is on screen is the diagnosis the issue asks
    // for before any binding is touched. If this is null while a list is
    // visible to a user, the list they see belongs to something else.
    expect(menu(), "the picker's own menu should be the surface").not.toBeNull();
  });

  it("ArrowDown MOVES the highlight, not merely returns handled", async () => {
    m = await open();
    const before = selectedRow();
    expect(before, "a row should start highlighted").toBeGreaterThanOrEqual(0);
    expect(key(m.view, "ArrowDown"), "ArrowDown should be handled").toBe(true);
    await raf();
    expect(selectedRow(), "the highlight should have moved").not.toBe(before);
  });

  it("ArrowUp moves it back", async () => {
    m = await open();
    const start = selectedRow();
    key(m.view, "ArrowDown");
    await raf();
    expect(key(m.view, "ArrowUp"), "ArrowUp should be handled").toBe(true);
    await raf();
    expect(selectedRow(), "the highlight should be back where it started").toBe(start);
  });

  it("Enter reaches the picker and inserts, rather than breaking the line", async () => {
    m = await open();
    const before = m.view.state.doc.toString();
    expect(key(m.view, "Enter"), "Enter should be handled by the picker").toBe(true);
    const after = m.view.state.doc.toString();
    expect(after, "Enter must not have inserted a newline").not.toContain("\n");
    expect(after, "Enter should have completed the link").not.toBe(before);
  });

  it("Escape dismisses the picker", async () => {
    m = await open();
    expect(key(m.view, "Escape"), "Escape should be handled").toBe(true);
    await raf();
    expect(menu(), "the picker should be gone").toBeNull();
  });
});
