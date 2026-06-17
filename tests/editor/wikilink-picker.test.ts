// @vitest-environment jsdom
//
// `[[` note-picker ViewPlugin (`editor/wikilink/picker.ts`, wikilink.md §6.1).
// `wikilink-picker-rank.test.ts` covers the pure ranking; this drives the live
// ViewPlugin under jsdom: the `[[` trigger opens the menu, typing filters it,
// ↑/↓ wrap-navigate, Enter/click insert the canonical §3 link (consuming the
// closeBrackets `]]`), a stray `]`/newline or a no-match closes it, Escape
// dismisses, and `pickerActiveFromField` tracks + maps the active `[[` start.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import {
  wikilinkPickerExtension,
  openWikilinkPicker,
  pickerActiveFromField,
} from "../../src/editor/wikilink/picker";
import { noteSetExtension, reconfigureNoteSet } from "../../src/editor/wikilink/note-set";
import type { ResolverNote } from "../../src/notes/resolveWikilink";

beforeAll(() => {
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = () => {};
  }
});

const NOTES: readonly ResolverNote[] = [
  { noteUuid: "a", title: "Wednesday", folder: "notes/2025/" },
  { noteUuid: "b", title: "Weekly Review", folder: "Projects/" },
  { noteUuid: "c", title: "Welcome", folder: null },
];

const raf = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));
const tick = (): Promise<void> => Promise.resolve();

function mount(doc = "", notes: readonly ResolverNote[] = NOTES): {
  view: EditorView;
  host: HTMLElement;
} {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length, head: doc.length },
      extensions: [noteSetExtension(), wikilinkPickerExtension()],
    }),
    parent: host,
  });
  // jsdom has no layout — coordsAtPos throws on real geometry; force the
  // null-return fallback the render path tolerates.
  view.coordsAtPos = () => null;
  view.dispatch({ effects: reconfigureNoteSet(notes) });
  return { view, host };
}

/** Type a string char-by-char at the cursor (so `[[` detection sees the pair). */
function typeText(view: EditorView, text: string): void {
  for (const ch of text) {
    const head = view.state.selection.main.head;
    view.dispatch({ changes: { from: head, insert: ch }, selection: { anchor: head + 1 } });
  }
}

const menu = (): HTMLElement | null => document.body.querySelector(".cm-wiki-picker");
const rows = (): HTMLElement[] =>
  Array.from(document.body.querySelectorAll<HTMLElement>(".cm-wiki-picker-row"));
const noteRows = (): HTMLElement[] =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[data-testid="picker.note-row"]'));
const folderRows = (): HTMLElement[] =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[data-testid="picker.folder-row"]'));
const selectedIdx = (): number => rows().findIndex((r) => r.classList.contains("cm-slash-menu-row-selected"));

let teardowns: Array<() => void> = [];
afterEach(() => {
  for (const t of teardowns) t();
  teardowns = [];
  document.body.querySelectorAll(".cm-wiki-picker").forEach((e) => e.remove());
});

describe("WikilinkPicker ViewPlugin", () => {
  it("opens on a typed `[[`, lists every titled note + implied folder, and selects row 0", async () => {
    const { view } = mount();
    teardowns.push(() => view.destroy());
    typeText(view, "[[");
    await raf();
    expect(menu()).not.toBeNull();
    // 3 titled notes + 3 implied folders (notes/, notes/2025/, Projects/).
    expect(noteRows()).toHaveLength(3);
    expect(folderRows()).toHaveLength(3);
    expect(selectedIdx()).toBe(0);
    // Notes rank before folders at equal (empty-query) score → row 0 is a note.
    expect(rows()[0]?.getAttribute("data-testid")).toBe("picker.note-row");
  });

  it("offers a folder-target row and inserts the trailing-slash form `[[Projects/]]`", async () => {
    const { view } = mount();
    teardowns.push(() => view.destroy());
    typeText(view, "[[projects");
    await raf();
    expect(menu()).not.toBeNull();
    const folder = folderRows().find(
      (r) => r.querySelector(".cm-wiki-picker-title")?.textContent === "Projects/",
    )!;
    expect(folder).toBeDefined();
    folder.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await raf();
    expect(view.state.doc.toString()).toBe("[[Projects/]]");
    expect(menu()).toBeNull();
  });

  it("filters as the user types into the link and ranks the match first", async () => {
    const { view } = mount();
    teardowns.push(() => view.destroy());
    typeText(view, "[[week");
    await raf();
    const titles = rows().map((r) =>
      r.querySelector(".cm-wiki-picker-title")?.textContent,
    );
    expect(titles).toContain("Weekly Review");
    // "Wednesday" / "Welcome" do not contain the subsequence "week" → filtered out.
    expect(titles).not.toContain("Welcome");
  });

  it("closes (no menu) when the filter has no match — never creates a note", async () => {
    const { view } = mount();
    teardowns.push(() => view.destroy());
    typeText(view, "[[zzqqxx");
    await raf();
    expect(menu()).toBeNull();
  });

  it("closes when a stray `]` lands in the filter", async () => {
    const { view } = mount();
    teardowns.push(() => view.destroy());
    typeText(view, "[[we");
    await raf();
    expect(menu()).not.toBeNull();
    typeText(view, "]");
    await raf();
    expect(menu()).toBeNull();
  });

  it("ArrowDown/ArrowUp wrap-navigate the selection", async () => {
    const { view } = mount();
    teardowns.push(() => view.destroy());
    typeText(view, "[[");
    await raf();
    const last = rows().length - 1;
    expect(selectedIdx()).toBe(0);

    runKey(view, "ArrowDown");
    await raf();
    expect(selectedIdx()).toBe(1);

    // Wrap from the top to the last entry.
    runKey(view, "ArrowUp");
    await raf();
    expect(selectedIdx()).toBe(0);
    runKey(view, "ArrowUp");
    await raf();
    expect(selectedIdx()).toBe(last);
  });

  it("Enter inserts the canonical §3 link for the selected row and closes", async () => {
    const { view } = mount();
    teardowns.push(() => view.destroy());
    typeText(view, "[[wednesday");
    await raf();
    expect(menu()).not.toBeNull();
    runKey(view, "Enter");
    await raf();
    expect(view.state.doc.toString()).toBe("[[notes/2025/Wednesday.md|Wednesday]]");
    expect(menu()).toBeNull();
  });

  it("a row mousedown inserts that row's link (and consumes a closeBrackets `]]`)", async () => {
    const { view } = mount();
    teardowns.push(() => view.destroy());
    // Reproduce closeBrackets: typing the second `[` inserts `[` AND the
    // auto-closed `]]`, landing the cursor between them at `[[|]]`.
    view.dispatch({ changes: { from: 0, insert: "[" }, selection: { anchor: 1 } });
    view.dispatch({ changes: { from: 1, insert: "[]]" }, selection: { anchor: 2 } });
    await raf();
    expect(menu()).not.toBeNull();
    expect(view.state.doc.toString()).toBe("[[]]");
    const welcome = rows().find(
      (r) => r.querySelector(".cm-wiki-picker-title")?.textContent === "Welcome",
    )!;
    welcome.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await raf();
    // The trailing auto-closed `]]` is consumed → one clean link, no dangling `]]`.
    expect(view.state.doc.toString()).toBe("[[Welcome.md|Welcome]]");
  });

  it("Escape dismisses the menu without inserting", async () => {
    const { view } = mount();
    teardowns.push(() => view.destroy());
    typeText(view, "[[we");
    await raf();
    expect(menu()).not.toBeNull();
    runKey(view, "Escape");
    await raf();
    expect(menu()).toBeNull();
    // Doc keeps the raw, un-inserted text.
    expect(view.state.doc.toString()).toBe("[[we");
  });

  it("moving the cursor out of the `[[…` span closes the menu", async () => {
    const { view } = mount();
    teardowns.push(() => view.destroy());
    typeText(view, "[[we");
    await raf();
    expect(menu()).not.toBeNull();
    // Jump the cursor to position 0 (before the trigger) → out of range → close.
    view.dispatch({ selection: { anchor: 0, head: 0 } });
    await raf();
    expect(menu()).toBeNull();
  });
});

describe("pickerActiveFromField", () => {
  it("publishes the active `[[` start while authoring, and clears it on insert", async () => {
    const { view } = mount();
    teardowns.push(() => view.destroy());
    typeText(view, "prefix [[we");
    await raf();
    // The microtask-deferred setActiveFrom has run; the field points at the `[[`.
    await tick();
    expect(view.state.field(pickerActiveFromField)).toBe("prefix ".length);

    runKey(view, "Enter");
    await raf();
    // The insert transaction clears the active node synchronously.
    expect(view.state.field(pickerActiveFromField)).toBeNull();
  });

  it("maps the active position forward through an edit before the trigger", async () => {
    const { view } = mount();
    teardowns.push(() => view.destroy());
    typeText(view, "ab [[we");
    await raf();
    await tick();
    const before = view.state.field(pickerActiveFromField);
    expect(before).toBe("ab ".length);
    // Insert two chars at the very start — the active `[[` position shifts +2.
    view.dispatch({ changes: { from: 0, insert: "XY" } });
    expect(view.state.field(pickerActiveFromField)).toBe(before! + 2);
  });
});

describe("openWikilinkPicker command", () => {
  it("inserts a bare `[[`, moves the cursor inside, and opens the menu", async () => {
    const { view } = mount("hello ");
    teardowns.push(() => view.destroy());
    view.dispatch({ selection: { anchor: 6, head: 6 } });
    const handled = openWikilinkPicker(view);
    expect(handled).toBe(true);
    expect(view.state.doc.toString()).toBe("hello [[");
    expect(view.state.selection.main.head).toBe(8);
    await raf();
    expect(menu()).not.toBeNull();
  });
});

// Drive the picker's keymap binding for `key` through CM6's production
// `runScopeHandlers` (the same path the editor's real keydown handler takes),
// so ArrowDown/Up/Enter/Escape route to the picker's move/confirm/dismiss.
function runKey(view: EditorView, key: string): boolean {
  return runScopeHandlers(
    view,
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    "editor",
  );
}
