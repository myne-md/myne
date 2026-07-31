// @vitest-environment jsdom
//
// The single tag-accept write path (on-device-tag-suggestion task 6). Accepting
// a chip writes into the LIVE CodeMirror document's frontmatter `tags:` list —
// never an inline `#tag`, never a disk write behind the open buffer (SYNC-15).
//
// The cursor assertions are the reason the writer computes a minimal edit rather
// than replacing the whole document: an accept can land while the user is typing.

import { afterEach, describe, expect, it } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { acceptTagIntoView } from "../../src/notes/ai/acceptTagIntoView";

const mounted: EditorView[] = [];

function mount(doc: string, anchor?: number): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: anchor === undefined ? undefined : { anchor },
    }),
    parent: host,
  });
  mounted.push(view);
  return view;
}

afterEach(() => {
  for (const view of mounted.splice(0)) {
    const host = view.dom.parentElement;
    view.destroy();
    host?.remove();
  }
});

describe("acceptTagIntoView", () => {
  it("writes the tag into frontmatter `tags:`, not as an inline #tag", () => {
    const view = mount("---\ntitle: N\n---\n\nsome body\n");
    expect(acceptTagIntoView(view, "rust")).toBe(true);
    expect(view.state.doc.toString()).toBe(
      "---\ntitle: N\ntags:\n  - rust\n---\n\nsome body\n",
    );
    expect(view.state.doc.toString()).not.toContain("#rust");
  });

  it("synthesizes a frontmatter block for a note that has none", () => {
    const view = mount("just a body");
    expect(acceptTagIntoView(view, "#rust")).toBe(true);
    expect(view.state.doc.toString()).toBe("---\ntags:\n  - rust\n---\n\njust a body");
  });

  it("keeps the caret where it was — the edit is minimal, not a whole-doc rewrite", () => {
    // Caret inside the body, after "some ".
    const doc = "---\ntitle: N\n---\n\nsome body\n";
    const caret = doc.indexOf("some body") + "some ".length;
    const view = mount(doc, caret);
    acceptTagIntoView(view, "rust");
    // The insert is above the caret, so it maps forward by exactly its length
    // and still sits between "some " and "body".
    const after = view.state.doc.toString();
    expect(view.state.selection.main.head).toBe(after.indexOf("some body") + "some ".length);
    expect(view.state.selection.main.empty).toBe(true);
  });

  it("dispatches nothing when the note already carries the tag", () => {
    const view = mount("---\ntags:\n  - Rust\n---\n\nbody\n");
    const before = view.state.doc.toString();
    expect(acceptTagIntoView(view, "rust")).toBe(false);
    expect(view.state.doc.toString()).toBe(before);
  });

  it("dispatches nothing for frontmatter the writer refuses to touch", () => {
    const view = mount("---\ntitle: [unclosed\n---\nbody");
    const before = view.state.doc.toString();
    expect(acceptTagIntoView(view, "rust")).toBe(false);
    expect(view.state.doc.toString()).toBe(before);
  });

  it("carries the `ai.accept-tag` user event", () => {
    const view = mount("body");
    const seen: Array<string | undefined> = [];
    view.setState(
      EditorState.create({
        doc: "body",
        extensions: [
          EditorState.transactionExtender.of((tr) => {
            if (tr.docChanged) seen.push(tr.annotation(Transaction.userEvent));
            return null;
          }),
        ],
      }),
    );
    acceptTagIntoView(view, "rust");
    expect(seen).toEqual(["ai.accept-tag"]);
  });
});
