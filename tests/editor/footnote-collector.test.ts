// @vitest-environment jsdom
//
// Footnote collection / ordering / resolution model (MYND-153, task 3).
// Pure `(state) -> model` function; a view is mounted only to force a complete
// parse so `syntaxTree(state)` is populated.

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { assertParsed } from "./_parse-budget";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Footnote } from "../../src/dialect/lezer/footnote";
import { collectFootnotes } from "../../src/editor/decorations/footnote-collector";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

function parsedState(doc: string): EditorState {
  host = document.createElement("div");
  document.body.appendChild(host);
  view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage, extensions: [Footnote] })],
    }),
    parent: host,
  });
  assertParsed(view);
  return view.state;
}

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

describe("collectFootnotes — collection", () => {
  it("collects each definition exactly once with the correct text slice", () => {
    const model = collectFootnotes(
      parsedState("a [^1] b [^2]\n\n[^1]: First.\n[^2]: Second.\n"),
    );
    expect(model.entries.map((e) => e.identifier)).toEqual(["1", "2"]);
    expect(model.entries.map((e) => e.text)).toEqual(["First.", "Second."]);
  });

  it("handles integer and non-integer identifiers", () => {
    const model = collectFootnotes(
      parsedState("[^note] and [^1]\n\n[^note]: Named.\n[^1]: Numbered.\n"),
    );
    const byId = new Map(model.entries.map((e) => [e.identifier, e.text]));
    expect(byId.get("note")).toBe("Named.");
    expect(byId.get("1")).toBe("Numbered.");
  });

  it("keeps the FIRST definition when an id is defined twice", () => {
    const model = collectFootnotes(
      parsedState("[^1]\n\n[^1]: First wins.\n[^1]: Second ignored.\n"),
    );
    expect(model.entries).toHaveLength(1);
    expect(model.entries[0]!.text).toBe("First wins.");
  });

  it("collects a bare empty definition with text ''", () => {
    const model = collectFootnotes(parsedState("[^1]\n\n[^1]:\n"));
    expect(model.entries[0]!.text).toBe("");
  });

  it("collects a multi-line (continuation) definition body as collapsed text", () => {
    const doc = "[^1]\n\n[^1]: line one\n    line two\n";
    const state = parsedState(doc);
    const entry = collectFootnotes(state).entries[0]!;
    expect(entry.text).toBe("line one line two");
    // The definition node spans both source lines.
    expect(state.doc.sliceString(entry.definitionFrom, entry.definitionTo)).toContain(
      "line two",
    );
  });
});

describe("collectFootnotes — ordering", () => {
  it("orders by first-reference appearance, not definition order", () => {
    // Referenced in textual order 1, 3, 2; defined in order 2, 3, 1.
    const doc = "[^1] [^3] [^2]\n\n[^2]: two\n[^3]: three\n[^1]: one\n";
    const model = collectFootnotes(parsedState(doc));
    expect(model.entries.map((e) => e.identifier)).toEqual(["1", "3", "2"]);
  });

  it("appends definition-only (unreferenced) entries in source order, after referenced", () => {
    const doc = "[^a]\n\n[^a]: referenced\n[^z]: orphanZ\n[^m]: orphanM\n";
    const model = collectFootnotes(parsedState(doc));
    expect(model.entries.map((e) => e.identifier)).toEqual(["a", "z", "m"]);
    expect(model.entries.map((e) => e.unreferenced)).toEqual([false, true, true]);
  });

  it("is stable across re-parse of the same document", () => {
    const doc = "[^1] [^2]\n\n[^2]: b\n[^1]: a\n";
    const a = collectFootnotes(parsedState(doc));
    const b = collectFootnotes(parsedState(doc));
    expect(a.entries.map((e) => e.identifier)).toEqual(
      b.entries.map((e) => e.identifier),
    );
  });
});

describe("collectFootnotes — resolution + orphans", () => {
  it("maps each defined identifier to its definition source offset", () => {
    const doc = "[^1]\n\n[^1]: note\n";
    const state = parsedState(doc);
    const model = collectFootnotes(state);
    const offset = model.resolution.get("1")!;
    // The resolved offset is the start of the `[^1]:` definition line.
    expect(state.doc.sliceString(offset, offset + 4)).toBe("[^1]");
  });

  it("an orphan reference (no definition) is absent from resolution and invents no entry", () => {
    const model = collectFootnotes(parsedState("body [^99] only\n"));
    expect(model.resolution.has("99")).toBe(false);
    expect(model.entries).toHaveLength(0);
  });

  it("an orphan definition (no reference) is collected and flagged unreferenced", () => {
    const model = collectFootnotes(parsedState("plain text\n\n[^unused]: dangling\n"));
    expect(model.entries).toHaveLength(1);
    expect(model.entries[0]!.identifier).toBe("unused");
    expect(model.entries[0]!.unreferenced).toBe(true);
    expect(model.resolution.has("unused")).toBe(true);
  });

  it("a referenced definition is not flagged unreferenced", () => {
    const model = collectFootnotes(parsedState("[^1]\n\n[^1]: note\n"));
    expect(model.entries[0]!.unreferenced).toBe(false);
  });

  it("referenceFirst points at the FIRST reference of each id (back-affordance target)", () => {
    const doc = "first [^1] then again [^1]\n\n[^1]: note\n";
    const state = parsedState(doc);
    const model = collectFootnotes(state);
    const offset = model.referenceFirst.get("1")!;
    // The first `[^1]` starts at index 6 ("first " is 6 chars).
    expect(offset).toBe(6);
    expect(state.doc.sliceString(offset, offset + 4)).toBe("[^1]");
  });

  it("referenceFirst omits a definition that is never referenced", () => {
    const model = collectFootnotes(parsedState("text\n\n[^x]: dangling\n"));
    expect(model.referenceFirst.has("x")).toBe(false);
  });
});
