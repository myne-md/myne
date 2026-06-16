// @vitest-environment jsdom
//
// Find-session singleton (`editor/find/find-session.ts`, MYND-175). Three
// behaviors:
//   - the active-view registry: register/unregister with stale-unmount guard
//   - `getFindCaseSensitive` / `setFindCaseSensitive`: the session-level mode bit
//   - `openInNoteFind`: no-ops (returns false) with no registered view; opens the
//     panel on the registered view; prefills a single-line selection as the query
//     and skips a multiline selection.
//
// The module is a singleton, so state is reset in afterEach to avoid cross-test
// contamination (a known hazard in this project).

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { getSearchQuery, searchPanelOpen } from "@codemirror/search";
import {
  registerFindView,
  unregisterFindView,
  openInNoteFind,
  getFindCaseSensitive,
  setFindCaseSensitive,
} from "../../src/editor/find/find-session";
import { findExtension } from "../../src/editor/find/find-extension";

type Mounted = { view: EditorView; host: HTMLElement };

function mount(doc: string, anchor = 0, head = anchor): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor, head },
      extensions: [...findExtension()],
    }),
    parent: host,
  });
  return { view, host };
}

let mounted: Mounted | null = null;

afterEach(() => {
  // Reset the module singleton: clear any leftover registered view + case bit.
  if (mounted !== null) {
    unregisterFindView(mounted.view);
    mounted.view.destroy();
    mounted.host.remove();
    mounted = null;
  }
  setFindCaseSensitive(false);
});

describe("case-sensitivity mode bit", () => {
  it("defaults to off and round-trips through the setter", () => {
    expect(getFindCaseSensitive()).toBe(false);
    setFindCaseSensitive(true);
    expect(getFindCaseSensitive()).toBe(true);
    setFindCaseSensitive(false);
    expect(getFindCaseSensitive()).toBe(false);
  });
});

describe("openInNoteFind without a registered view", () => {
  it("returns false (no-op on every non-editor stage)", () => {
    // No view registered (the findExtension's ViewPlugin auto-registers on
    // mount, so explicitly unregister to model a non-editor stage).
    expect(openInNoteFind()).toBe(false);
  });
});

describe("openInNoteFind with a registered view", () => {
  it("opens the search panel and returns true", () => {
    mounted = mount("hello world");
    // The findExtension ViewPlugin already registered this view on mount.
    expect(searchPanelOpen(mounted.view.state)).toBe(false);
    expect(openInNoteFind()).toBe(true);
    expect(searchPanelOpen(mounted.view.state)).toBe(true);
  });

  it("prefills a single-line selection as the query (literal substring)", () => {
    mounted = mount("find this word", 5, 9); // selects "this"
    openInNoteFind();
    const q = getSearchQuery(mounted.view.state);
    expect(q.search).toBe("this");
    expect(q.literal).toBe(true); // never regex (v1 scope)
  });

  it("does NOT prefill from an empty selection (fresh empty bar)", () => {
    // Our guard is `if (!sel.empty)`; an empty selection leaves the query as-is.
    // CM's openSearchPanel only seeds the bar from a NON-empty selection, so a
    // collapsed caret is a clean way to assert our no-prefill branch end-to-end.
    mounted = mount("some words here", 4, 4); // collapsed caret, empty selection
    openInNoteFind();
    expect(getSearchQuery(mounted.view.state).search).toBe("");
  });

  it("re-pressing while open refocuses without overwriting the live query", () => {
    mounted = mount("alpha beta", 0, 5); // "alpha"
    openInNoteFind();
    expect(getSearchQuery(mounted.view.state).search).toBe("alpha");
    // Move the cursor elsewhere, then re-press: query must be untouched.
    mounted.view.dispatch({ selection: { anchor: 6, head: 10 } }); // "beta"
    expect(openInNoteFind()).toBe(true);
    expect(getSearchQuery(mounted.view.state).search).toBe("alpha");
  });

  it("honors the case-sensitivity bit when prefilling", () => {
    setFindCaseSensitive(true);
    mounted = mount("Find This", 5, 9); // "This"
    openInNoteFind();
    expect(getSearchQuery(mounted.view.state).caseSensitive).toBe(true);
  });
});

describe("register / unregister guard", () => {
  it("a stale unmount does not clear a newer registered view", () => {
    const hostA = document.createElement("div");
    const viewA = new EditorView({ state: EditorState.create({ doc: "a" }), parent: hostA });
    const hostB = document.createElement("div");
    const viewB = new EditorView({ state: EditorState.create({ doc: "b" }), parent: hostB });
    try {
      registerFindView(viewA);
      registerFindView(viewB); // B is now active
      unregisterFindView(viewA); // stale unmount of A — must NOT clear B
      // B is still active: opening find should target it (returns true).
      expect(openInNoteFind()).toBe(true);
      expect(searchPanelOpen(viewB.state)).toBe(true);
    } finally {
      unregisterFindView(viewB);
      viewA.destroy();
      hostA.remove();
      viewB.destroy();
      hostB.remove();
    }
  });
});
