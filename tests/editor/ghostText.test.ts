// @vitest-environment jsdom
//
// Tests for the AI ghost-text field + accept/dismiss (writing-assistant
// MYND-410 tasks 2/4). Mounts a real CM6 EditorView with the ghost field, drives
// the StateEffects, and asserts the widget renders, Tab-accept inserts plain
// markdown reversible in one undo, and Esc / edits / cursor-moves dismiss.

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo } from "@codemirror/commands";

import {
  acceptGhost,
  clearGhostSuggestion,
  dismissGhost,
  ghostField,
  ghostShowing,
  setGhostSuggestion,
} from "../../src/editor/ai/ghostText";

interface Mounted {
  view: EditorView;
  host: HTMLElement;
}

function mount(doc: string, cursor = doc.length): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor, head: cursor },
      extensions: [history(), ghostField],
    }),
    parent: host,
  });
  return { view, host };
}

let m: Mounted | null = null;
afterEach(() => {
  m?.view.destroy();
  m?.host.remove();
  m = null;
});

function showGhost(view: EditorView, text: string, from: number): void {
  view.dispatch({ effects: setGhostSuggestion.of({ text, from }) });
}

describe("ghost field + widget", () => {
  it("renders the dimmed ghost widget when a suggestion is set", () => {
    m = mount("The quick");
    expect(ghostShowing(m.view)).toBe(false);
    showGhost(m.view, " brown fox", 9);
    expect(ghostShowing(m.view)).toBe(true);
    const ghost = m.host.querySelector('[data-testid="ai.ghost-text"]');
    expect(ghost).not.toBeNull();
    expect(ghost?.textContent).toBe(" brown fox");
    // The widget is not in the document text — the buffer is unchanged.
    expect(m.view.state.doc.toString()).toBe("The quick");
  });
});

describe("acceptGhost (Tab)", () => {
  it("inserts the suggestion as plain markdown and clears the ghost", () => {
    m = mount("The quick");
    showGhost(m.view, " brown fox", 9);
    expect(acceptGhost(m.view)).toBe(true);
    expect(m.view.state.doc.toString()).toBe("The quick brown fox");
    expect(ghostShowing(m.view)).toBe(false);
  });

  it("is reversible in one undo step", () => {
    m = mount("abc");
    showGhost(m.view, "def", 3);
    acceptGhost(m.view);
    expect(m.view.state.doc.toString()).toBe("abcdef");
    undo(m.view);
    expect(m.view.state.doc.toString()).toBe("abc");
  });

  it("returns false (falls through to indentWithTab) when nothing is showing", () => {
    m = mount("abc");
    expect(acceptGhost(m.view)).toBe(false);
    expect(m.view.state.doc.toString()).toBe("abc");
  });
});

describe("dismiss paths", () => {
  it("Esc clears the showing suggestion and returns true; false when none", () => {
    m = mount("abc");
    expect(dismissGhost(m.view)).toBe(false);
    showGhost(m.view, "xyz", 3);
    expect(dismissGhost(m.view)).toBe(true);
    expect(ghostShowing(m.view)).toBe(false);
  });

  it("any document edit dismisses the suggestion", () => {
    m = mount("abc");
    showGhost(m.view, "xyz", 3);
    m.view.dispatch({ changes: { from: 3, insert: "Z" } });
    expect(ghostShowing(m.view)).toBe(false);
  });

  it("an explicit clear effect dismisses the suggestion", () => {
    m = mount("abc");
    showGhost(m.view, "xyz", 3);
    m.view.dispatch({ effects: clearGhostSuggestion.of(null) });
    expect(ghostShowing(m.view)).toBe(false);
  });

  it("a cursor move dismisses the suggestion", () => {
    m = mount("abcdef", 6);
    showGhost(m.view, "xyz", 6);
    m.view.dispatch({ selection: { anchor: 0, head: 0 } });
    expect(ghostShowing(m.view)).toBe(false);
  });
});
