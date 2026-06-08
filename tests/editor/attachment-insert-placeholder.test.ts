// @vitest-environment jsdom
//
// Optimistic in-editor import placeholder (MYND-164 dogfooding fix #4).
//
//   - showing a placeholder renders a clean "Importing…" progress chip
//   - it is decoration-only: the document string is NEVER mutated (so the
//     placeholder can't be persisted by autosave)
//   - clearing removes it
//   - the placeholder maps across concurrent edits (stays at its insert point)

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  attachmentInsertPlaceholderExtension,
  clearInsertPlaceholder,
  showInsertPlaceholder,
} from "../../src/editor/attachments/insert-placeholder";

let view: EditorView | null = null;
let host: HTMLElement | null = null;

function mount(doc: string): EditorView {
  host = document.createElement("div");
  document.body.appendChild(host);
  view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [attachmentInsertPlaceholderExtension()],
    }),
    parent: host,
  });
  return view;
}

afterEach(() => {
  view?.destroy();
  host?.remove();
  view = null;
  host = null;
});

describe("optimistic import placeholder", () => {
  it("renders a clean Importing… progress chip at the cursor", () => {
    const v = mount("hello world");
    showInsertPlaceholder(v, 5, "importing");
    v.requestMeasure();
    const chip = host!.querySelector(".cm-attachment-progress");
    expect(chip).not.toBeNull();
    expect(chip!.querySelector(".cm-attachment-progress-label")?.textContent).toBe("Importing…");
  });

  it("does NOT mutate the document bytes (never persisted)", () => {
    const v = mount("hello world");
    showInsertPlaceholder(v, 5, "importing");
    expect(v.state.doc.toString()).toBe("hello world");
  });

  it("clears the placeholder by token", () => {
    const v = mount("hello world");
    const token = showInsertPlaceholder(v, 5, "importing");
    v.requestMeasure();
    expect(host!.querySelector(".cm-attachment-progress")).not.toBeNull();
    clearInsertPlaceholder(v, token);
    v.requestMeasure();
    expect(host!.querySelector(".cm-attachment-progress")).toBeNull();
  });

  it("survives a concurrent edit before its position (still one chip)", () => {
    const v = mount("hello world");
    showInsertPlaceholder(v, 11, "importing"); // end of doc
    // Insert text at the very start — the placeholder position should map.
    v.dispatch({ changes: { from: 0, insert: "XX " } });
    v.requestMeasure();
    expect(host!.querySelectorAll(".cm-attachment-progress").length).toBe(1);
    expect(v.state.doc.toString()).toBe("XX hello world");
  });
});
