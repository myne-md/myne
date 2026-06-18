// @vitest-environment jsdom
//
// In-note find+replace EXTENSION wiring (MYND-302): the real `findExtension()`
// driving @codemirror/search's replaceNext / replaceAll over a live doc. Asserts:
//   - the toggle reveals the replace row inside the docked panel
//   - replace-one replaces the current match and advances to the next
//   - replace-all rewrites all occurrences in a SINGLE undoable transaction
//   - match-case governs replacement (inherited via SearchQuery.caseSensitive)
//   - literal replacement of regex-special characters (no regex interpretation)
//   - the replace string carried on setSearchQuery survives a query edit
//   - Escape closes the bar even when the replace row is expanded
//
// The debounced full-doc scan is advanced with fake timers (mirrors
// find-extension.test.ts).

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";
import { openSearchPanel, searchPanelOpen } from "@codemirror/search";
import { findExtension } from "../../src/editor/find/find-extension";
import { setFindCaseSensitive } from "../../src/editor/find/find-session";

beforeAll(() => {
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = () => {};
  }
  vi.useFakeTimers();
});

type Mounted = { view: EditorView; host: HTMLElement };

function mount(doc: string, pos = 0): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: pos, head: pos },
      extensions: [history(), findExtension()],
    }),
    parent: host,
  });
  view.requestMeasure();
  return { view, host };
}

function teardown(m: Mounted): void {
  m.view.destroy();
  m.host.remove();
}

const input = (m: Mounted) =>
  m.host.querySelector(".cm-find-bar-input") as HTMLInputElement;
const byTestId = (m: Mounted, id: string) =>
  m.host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const replaceInput = (m: Mounted) => byTestId(m, "find.replace-input") as HTMLInputElement;
const click = (el: HTMLElement | null) =>
  el?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

/** Type a query into the find input and flush the debounced scan. */
function typeQuery(m: Mounted, q: string): void {
  const el = input(m);
  el.value = q;
  el.dispatchEvent(new Event("input"));
  vi.runAllTimers();
}

/** Expand the replace row, set the replacement, and flush. */
function setReplacement(m: Mounted, value: string): void {
  click(byTestId(m, "find.toggle-replace"));
  const el = replaceInput(m);
  el.value = value;
  el.dispatchEvent(new Event("input"));
  vi.runAllTimers();
}

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
  setFindCaseSensitive(false);
});

describe("find+replace extension: toggle reveals the replace row", () => {
  it("the toggle in the docked panel expands the replace input", () => {
    m = mount("alpha beta alpha");
    openSearchPanel(m.view);
    expect(byTestId(m, "find.replace-input")).toBeNull();
    click(byTestId(m, "find.toggle-replace"));
    expect(byTestId(m, "find.replace-input")).not.toBeNull();
  });
});

describe("find+replace extension: replace-one", () => {
  it("replaces the current match, leaving the others untouched", () => {
    m = mount("alpha beta alpha gamma alpha", 0);
    openSearchPanel(m.view);
    typeQuery(m, "alpha");
    setReplacement(m, "OMEGA");

    // Settle the selection onto the first match (Enter from an empty selection).
    input(m).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    click(byTestId(m, "find.replace-one"));
    // The first "alpha" became "OMEGA"; the others are untouched.
    expect(m.view.state.doc.toString()).toBe("OMEGA beta alpha gamma alpha");
  });

  it("steps through occurrences: replace-one advances to the next match, then replaces it", () => {
    // CodeMirror's replaceNext leaves the selection ON the just-inserted
    // replacement (not a match), so the following click ADVANCES to the next
    // match without replacing; the click after that replaces it. This is the
    // canonical replace/find-next stepping (Obsidian/VS Code behave identically).
    m = mount("alpha beta alpha gamma alpha", 0);
    openSearchPanel(m.view);
    typeQuery(m, "alpha");
    setReplacement(m, "OMEGA");
    input(m).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    click(byTestId(m, "find.replace-one")); // replace match 1
    expect(m.view.state.doc.toString()).toBe("OMEGA beta alpha gamma alpha");
    click(byTestId(m, "find.replace-one")); // advance onto match 2 (no replace)
    expect(m.view.state.doc.toString()).toBe("OMEGA beta alpha gamma alpha");
    click(byTestId(m, "find.replace-one")); // replace match 2
    expect(m.view.state.doc.toString()).toBe("OMEGA beta OMEGA gamma alpha");
  });
});

describe("find+replace extension: replace-all", () => {
  it("rewrites every occurrence", () => {
    m = mount("alpha beta alpha gamma alpha", 0);
    openSearchPanel(m.view);
    typeQuery(m, "alpha");
    setReplacement(m, "OMEGA");
    click(byTestId(m, "find.replace-all"));
    expect(m.view.state.doc.toString()).toBe("OMEGA beta OMEGA gamma OMEGA");
  });

  it("applies as a SINGLE undoable transaction (one undo reverts the whole bulk replace)", () => {
    const original = "alpha beta alpha gamma alpha";
    m = mount(original, 0);
    openSearchPanel(m.view);
    typeQuery(m, "alpha");
    setReplacement(m, "OMEGA");
    click(byTestId(m, "find.replace-all"));
    expect(m.view.state.doc.toString()).toBe("OMEGA beta OMEGA gamma OMEGA");

    // One undo reverts all three replacements at once → back to the original.
    undo(m.view);
    expect(m.view.state.doc.toString()).toBe(original);
  });
});

describe("find+replace extension: match-case inheritance", () => {
  it("case-insensitive (default) replaces all case variants", () => {
    m = mount("Alpha alpha ALPHA", 0);
    openSearchPanel(m.view);
    typeQuery(m, "alpha");
    setReplacement(m, "X");
    click(byTestId(m, "find.replace-all"));
    expect(m.view.state.doc.toString()).toBe("X X X");
  });

  it("case-sensitive replace only touches exact-case matches", () => {
    m = mount("Alpha alpha ALPHA", 0);
    openSearchPanel(m.view);
    typeQuery(m, "alpha");
    // Engage match-case via the toggle.
    click(m.host.querySelector(".cm-find-bar-case") as HTMLButtonElement);
    vi.runAllTimers();
    setReplacement(m, "X");
    click(byTestId(m, "find.replace-all"));
    // Only the exact lowercase "alpha" is replaced.
    expect(m.view.state.doc.toString()).toBe("Alpha X ALPHA");
  });
});

describe("find+replace extension: literal (no regex)", () => {
  it("treats a regex-special query as a literal string", () => {
    m = mount("a.b a.b axb", 0);
    openSearchPanel(m.view);
    typeQuery(m, "a.b");
    setReplacement(m, "Z");
    click(byTestId(m, "find.replace-all"));
    // Literal: "a.b" matches the two dotted forms only, never "axb" (which a
    // regex `.` would have hit).
    expect(m.view.state.doc.toString()).toBe("Z Z axb");
  });
});

describe("find+replace extension: replace string survives a query edit", () => {
  it("editing the query keeps the replacement carried on the query", () => {
    m = mount("alpha alpha beta", 0);
    openSearchPanel(m.view);
    typeQuery(m, "alpha");
    setReplacement(m, "X");
    // Now change the query to target "beta" — the replacement must stick.
    typeQuery(m, "beta");
    click(byTestId(m, "find.replace-all"));
    expect(m.view.state.doc.toString()).toBe("alpha alpha X");
  });
});

describe("find+replace extension: Escape with the replace row open", () => {
  it("Escape closes the bar even when replace is expanded", () => {
    m = mount("alpha", 0);
    openSearchPanel(m.view);
    click(byTestId(m, "find.toggle-replace"));
    expect(byTestId(m, "find.replace-input")).not.toBeNull();
    input(m).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(searchPanelOpen(m.view.state)).toBe(false);
  });
});
