// @vitest-environment jsdom
//
// Footnote rendering (MYND-153, tasks 2 / 4 / 5 / 6). jsdom mount smoke over
// the real decoration extensions:
//   - inline `[^N]` superscript reference + cursor-aware reveal (task 2)
//   - in-source `[^N]:` definition de-emphasis + reveal (task 5)
//   - EOD "Footnotes" block widget: collection, ordering, injection-safety,
//     byte-stability, orphan handling (task 4)
//   - click-to-jump, orphan no-op, back-affordance (task 6)

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Footnote } from "../../src/dialect/lezer/footnote";
import { footnoteDecorations } from "../../src/editor/decorations/footnote";

type Mounted = { view: EditorView; host: HTMLElement };

function mount(doc: string, selectionPos?: number): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const pos = selectionPos ?? doc.length;
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: pos, head: pos },
      extensions: [
        markdown({ base: markdownLanguage, extensions: [Footnote] }),
        ...footnoteDecorations(),
      ],
    }),
    parent: host,
  });
  view.requestMeasure();
  return { view, host };
}

/** Focus + re-dispatch the current selection so the ViewPlugin rebuilds with
 *  the live `view.hasFocus` value (jsdom `.focus()` alone doesn't fire it). */
function focusAt(m: Mounted, pos: number): void {
  m.view.focus();
  m.view.dispatch({ selection: { anchor: pos, head: pos } });
  m.view.requestMeasure();
}

function teardown(m: Mounted): void {
  m.view.destroy();
  m.host.remove();
}

let mounted: Mounted | null = null;
afterEach(() => {
  if (mounted !== null) teardown(mounted);
  mounted = null;
});

describe("inline reference superscript (task 2)", () => {
  it("renders a resolved [^1] as a superscript '1' with brackets hidden", () => {
    mounted = mount("see [^1] here\n\n[^1]: note\n");
    const ref = mounted.host.querySelector(".cm-footnote-ref");
    expect(ref).not.toBeNull();
    expect(ref!.textContent).toBe("1");
    expect(ref!.classList.contains("cm-footnote-ref-orphan")).toBe(false);
    // The body line shows "see 1 here" — `[^` and `]` are replaced/hidden.
    const body = mounted.view.contentDOM.textContent ?? "";
    expect(body).toContain("see 1 here");
  });

  it("renders a non-integer id [^note] as the superscript glyph 'note'", () => {
    mounted = mount("x [^note] y\n\n[^note]: n\n");
    const ref = mounted.host.querySelector(".cm-footnote-ref");
    expect(ref!.textContent).toBe("note");
  });

  it("cursor inside the reference reveals raw [^1]; off it re-renders the superscript", () => {
    mounted = mount("see [^1] here\n\n[^1]: note\n");
    const refStart = "see ".length;
    focusAt(mounted, refStart + 2); // inside `[^1]`
    expect(mounted.view.contentDOM.textContent).toContain("[^1]");
    // Move off the reference — superscript returns.
    focusAt(mounted, mounted.view.state.doc.length);
    expect(mounted.host.querySelector(".cm-footnote-ref")).not.toBeNull();
  });

  it("a no-edit cursor round-trip leaves the source byte-identical", () => {
    mounted = mount("a [^1] b\n\n[^1]: note\n");
    const before = mounted.view.state.doc.toString();
    focusAt(mounted, "a ".length + 2); // into the reference
    focusAt(mounted, mounted.view.state.doc.length); // back out
    expect(mounted.view.state.doc.toString()).toBe(before);
  });
});

describe("in-source definition de-emphasis (task 5)", () => {
  it("de-emphasizes the [^N]: line off-cursor", () => {
    mounted = mount("[^1]\n\n[^1]: First note.\n");
    expect(mounted.host.querySelector(".cm-footnote-def")).not.toBeNull();
  });

  it("reveals the definition line at full prominence when the cursor is on it", () => {
    const doc = "[^1]\n\n[^1]: First note.\n";
    mounted = mount(doc);
    const defLineStart = doc.indexOf("[^1]: First");
    focusAt(mounted, defLineStart + 8); // on the definition's line
    expect(mounted.host.querySelector(".cm-footnote-def")).toBeNull();
  });

  it("hides the [^/]: brackets off-cursor but keeps the id as a superscript marker; reveals raw on-cursor", () => {
    const doc = "ref [^xyz]\n\n[^xyz]: First note.\n";
    mounted = mount(doc); // unfocused → off-cursor treatment
    // The `[^xyz]:` brackets/colon are hidden in-source...
    expect(mounted.view.contentDOM.textContent).not.toContain("[^xyz]:");
    // ...but the identifier stays as a superscript marker (identity preserved)...
    const marker = mounted.host.querySelector(".cm-footnote-def-marker");
    expect(marker).not.toBeNull();
    expect(marker!.textContent).toBe("xyz");
    // ...and the body text still renders.
    expect(mounted.view.contentDOM.textContent).toContain("First note.");
    // Cursor on the definition line → raw marker revealed for editing.
    const defStart = doc.indexOf("[^xyz]: First");
    focusAt(mounted, defStart + 8);
    expect(mounted.view.contentDOM.textContent).toContain("[^xyz]:");
    expect(mounted.host.querySelector(".cm-footnote-def-marker")).toBeNull();
  });
});

describe("EOD Footnotes block widget (task 4)", () => {
  it("renders a single list at document end with each definition once", () => {
    mounted = mount("[^1] [^2]\n\n[^1]: One.\n[^2]: Two.\n");
    const lists = mounted.host.querySelectorAll(".cm-footnote-list");
    expect(lists.length).toBe(1);
    const items = mounted.host.querySelectorAll(".cm-footnote-item");
    expect(items.length).toBe(2);
    const heading = mounted.host.querySelector(".cm-footnote-list-heading");
    expect(heading!.textContent).toBe("Footnotes");
  });

  it("appears on initial load (no extra transaction needed)", () => {
    mounted = mount("body [^1]\n\n[^1]: note\n");
    expect(mounted.host.querySelector(".cm-footnote-list")).not.toBeNull();
  });

  it("orders entries by first-reference appearance (1, 3, 2)", () => {
    mounted = mount("[^1] [^3] [^2]\n\n[^2]: b\n[^3]: c\n[^1]: a\n");
    const markers = [...mounted.host.querySelectorAll(".cm-footnote-item-marker")].map(
      (m) => m.textContent,
    );
    expect(markers).toEqual(["1", "3", "2"]);
  });

  it("inserts definition text via textContent — no HTML injection (TB2)", () => {
    mounted = mount("[^1]\n\n[^1]: <b>x</b>\n");
    expect(mounted.host.querySelector(".cm-footnote-list b")).toBeNull();
    const text = mounted.host.querySelector(".cm-footnote-item-text");
    expect(text!.textContent).toBe("<b>x</b>");
  });

  it("does not mutate document text (the list is a derived view)", () => {
    const doc = "[^1]\n\n[^1]: note\n";
    mounted = mount(doc);
    expect(mounted.view.state.doc.toString()).toBe(doc);
  });

  it("renders no widget when the document has no footnote definitions", () => {
    mounted = mount("plain paragraph, no footnotes\n");
    expect(mounted.host.querySelector(".cm-footnote-list")).toBeNull();
  });

  it("renders a multi-line definition's full body in the EOD list (MYND-153 AC#3)", () => {
    mounted = mount("[^1]\n\n[^1]: first line\n    second line\n");
    const text = mounted.host.querySelector(".cm-footnote-item-text");
    expect(text!.textContent).toBe("first line second line");
  });
});

describe("orphan handling (task 6)", () => {
  it("an orphan reference renders distinguishably and clicking is a safe no-op", () => {
    mounted = mount("body [^99] only\n");
    const ref = mounted.host.querySelector(".cm-footnote-ref");
    expect(ref).not.toBeNull();
    expect(ref!.classList.contains("cm-footnote-ref-orphan")).toBe(true);
    // No definition → no EOD entry invented for it.
    expect(mounted.host.querySelector(".cm-footnote-list")).toBeNull();
    // Clicking must not throw.
    expect(() =>
      ref!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })),
    ).not.toThrow();
  });

  it("an orphan definition appears in the EOD list flagged unreferenced", () => {
    mounted = mount("plain text\n\n[^unused]: dangling\n");
    const item = mounted.host.querySelector(".cm-footnote-item");
    expect(item).not.toBeNull();
    expect(item!.classList.contains("cm-footnote-item-unreferenced")).toBe(true);
    expect(mounted.host.querySelector(".cm-footnote-item-badge")!.textContent).toBe(
      "unreferenced",
    );
  });
});

describe("click-to-jump + back-affordance (task 6)", () => {
  it("clicking a resolved reference moves the cursor to its definition", () => {
    const doc = "see [^1] here\n\n[^1]: The note.\n";
    mounted = mount(doc);
    const ref = mounted.host.querySelector("[data-cm-footnote-ref]")!;
    ref.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    const head = mounted.view.state.selection.main.head;
    const defStart = doc.indexOf("[^1]: The note.");
    expect(head).toBe(defStart);
  });

  it("clicking the EOD back-affordance jumps to the first reference", () => {
    const doc = "first [^1] and again [^1]\n\n[^1]: note\n";
    mounted = mount(doc);
    const back = mounted.host.querySelector("[data-cm-footnote-backref]");
    expect(back).not.toBeNull();
    back!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    const head = mounted.view.state.selection.main.head;
    expect(head).toBe("first ".length); // start of the FIRST `[^1]`
  });
});
