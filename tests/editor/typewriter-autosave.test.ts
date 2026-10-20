// @vitest-environment jsdom
//
// myne-md/myne#908 item 9 — autosave must not re-centre the editor.
//
// The focus-mode typewriter plugin re-centres on any document change that is
// not a pointer selection. An autosave echo arrives as a PROGRAMMATIC dispatch
// (the frontmatter `updated:` patch), so pausing until the note saved moved the
// page under a reader who had not moved. The rule under test is the decision
// function the plugin delegates to; the plugin itself needs layout and jsdom has
// none, so testing the decision is the honest surface.

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  shouldRecenterOnChange,
  transactionsAreUserDriven,
  typewriterDecision,
} from "@myne/editor/focus-mode";

const base = {
  selectionSet: false,
  docChanged: true,
  pointerSelection: false,
  userDriven: true,
  hasFocus: true,
  typewriterEnabled: true,
};

describe("shouldRecenterOnChange", () => {
  it("re-centres for a typed change", () => {
    expect(shouldRecenterOnChange(base)).toBe(true);
  });

  it("does NOT re-centre for a programmatic document change (the autosave echo)", () => {
    expect(shouldRecenterOnChange({ ...base, userDriven: false })).toBe(false);
  });

  it("does not re-centre for a pointer selection", () => {
    expect(shouldRecenterOnChange({ ...base, pointerSelection: true })).toBe(false);
  });

  it("does nothing when the view is unfocused or typewriter is off", () => {
    expect(shouldRecenterOnChange({ ...base, hasFocus: false })).toBe(false);
    expect(shouldRecenterOnChange({ ...base, typewriterEnabled: false })).toBe(false);
  });

  it("ignores an update that neither moved the selection nor changed the doc", () => {
    expect(
      shouldRecenterOnChange({ ...base, selectionSet: false, docChanged: false }),
    ).toBe(false);
  });
});

describe("transactionsAreUserDriven", () => {
  const state = EditorState.create({ doc: "abc" });

  it("is false for a programmatic dispatch, which is what a save echo is", () => {
    const tx = state.update({ changes: { from: 0, insert: "x" } });
    expect(transactionsAreUserDriven([tx])).toBe(false);
  });

  it("is true for a typed transaction", () => {
    const tx = state.update({
      changes: { from: 0, insert: "x" },
      userEvent: "input.type",
    });
    expect(transactionsAreUserDriven([tx])).toBe(true);
  });

  it("is true for a keyboard selection move", () => {
    const tx = state.update({
      selection: { anchor: 1 },
      userEvent: "select",
    });
    expect(transactionsAreUserDriven([tx])).toBe(true);
  });
});

describe("typewriterDecision (the plugin's own wiring)", () => {
  // The predicate above is only half the claim. The plugin used to pass the
  // pieces inline, so it could pass `userDriven: true` and every spec still went
  // green while the autosave bug came back (a review measured exactly that).
  // These drive the ADAPTER with a real transaction and a real DOM gate.
  const gate = () => {
    const el = document.createElement("div");
    el.setAttribute("data-focus-typewriter", "true");
    const editor = document.createElement("div");
    el.appendChild(editor);
    document.body.appendChild(el);
    return editor;
  };
  const view = (dom: Element) => ({ hasFocus: true, dom });

  it("declines a programmatic change, which is what an autosave echo is", () => {
    const dom = gate();
    const state = EditorState.create({ doc: "abc" });
    const tx = state.update({ changes: { from: 0, insert: "x" } });
    expect(
      typewriterDecision(
        { selectionSet: false, docChanged: true, transactions: [tx] },
        view(dom),
      ),
    ).toBe(false);
  });

  it("accepts a typed change inside the focus-mode gate", () => {
    const dom = gate();
    const state = EditorState.create({ doc: "abc" });
    const tx = state.update({
      changes: { from: 0, insert: "x" },
      userEvent: "input.type",
    });
    expect(
      typewriterDecision(
        { selectionSet: false, docChanged: true, transactions: [tx] },
        view(dom),
      ),
    ).toBe(true);
  });

  it("declines a typed change outside the gate", () => {
    const bare = document.createElement("div");
    const state = EditorState.create({ doc: "abc" });
    const tx = state.update({
      changes: { from: 0, insert: "x" },
      userEvent: "input.type",
    });
    expect(
      typewriterDecision(
        { selectionSet: false, docChanged: true, transactions: [tx] },
        view(bare),
      ),
    ).toBe(false);
  });
});
