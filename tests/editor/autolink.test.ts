// @vitest-environment jsdom
//
// Autolink decoration — MYND-150 (angle-bracket `<https://url>` /
// `<email@domain>`) + MYND-151 (bare URLs / emails, GFM autolink extension).
//
// Strategy: mount a real EditorView with the autolink extension, inspect the
// rendered DOM (`contentDOM.textContent` for visible text, `[data-cm-url]`
// for the clickable target). Off-cursor angle autolinks hide their brackets;
// bare URLs are decoration-only (source unchanged); cursor-inside reveals the
// raw `<...>`; unsafe schemes are not decorated.

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Wikilink } from "../../src/dialect/lezer/wikilink";
import { InlineTag } from "../../src/dialect/lezer/inline-tag";
import { autolinkDecorations } from "../../src/editor/decorations/autolink";

type Mounted = { view: EditorView; host: HTMLElement };

function mount(doc: string, selectionPos: number | null): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection:
        selectionPos === null
          ? undefined
          : { anchor: selectionPos, head: selectionPos },
      extensions: [
        markdown({ base: markdownLanguage, extensions: [Wikilink, InlineTag] }),
        ...autolinkDecorations(),
      ],
    }),
    parent: host,
  });
  return { view, host };
}

function focusOffCursor(m: Mounted): void {
  // Park the cursor at the end (well off any autolink) and force a rebuild
  // with `view.hasFocus === true` so the off-cursor path runs.
  m.view.focus();
  m.view.dispatch({ selection: { anchor: m.view.state.doc.length } });
  m.view.requestMeasure();
}

function teardown(m: Mounted): void {
  m.view.destroy();
  m.host.remove();
}

describe("Autolink decoration (MYND-150 + MYND-151)", () => {
  let mounted: Mounted | null = null;
  afterEach(() => {
    if (mounted !== null) teardown(mounted);
    mounted = null;
  });

  it("angle-bracket URL autolink: brackets hidden off-cursor, http href set", () => {
    mounted = mount("link <https://myne.md> here\n", null);
    focusOffCursor(mounted);
    const text = mounted.view.contentDOM.textContent ?? "";
    expect(text.includes("<https://myne.md>")).toBe(false); // brackets hidden
    expect(text).toContain("https://myne.md"); // URL still rendered
    const el = mounted.view.contentDOM.querySelector("[data-cm-url]");
    expect(el?.getAttribute("data-cm-url")).toBe("https://myne.md");
  });

  it("angle-bracket email autolink: mailto href", () => {
    mounted = mount("mail <hello@myne.md> ok\n", null);
    focusOffCursor(mounted);
    const text = mounted.view.contentDOM.textContent ?? "";
    expect(text.includes("<hello@myne.md>")).toBe(false);
    const el = mounted.view.contentDOM.querySelector("[data-cm-url]");
    expect(el?.getAttribute("data-cm-url")).toBe("mailto:hello@myne.md");
  });

  it("cursor inside angle autolink reveals raw <...>", () => {
    const doc = "link <https://myne.md> here\n";
    const inside = doc.indexOf("myne.md");
    mounted = mount(doc, inside);
    mounted.view.focus();
    mounted.view.dispatch({ selection: mounted.view.state.selection });
    mounted.view.requestMeasure();
    const text = mounted.view.contentDOM.textContent ?? "";
    expect(text).toContain("<https://myne.md>"); // brackets revealed for editing
  });

  it("bare URL: decoration-only, source unchanged, href set", () => {
    const doc = "see https://github.com/myne-md/myne now\n";
    mounted = mount(doc, null);
    focusOffCursor(mounted);
    const text = mounted.view.contentDOM.textContent ?? "";
    // Decoration must not mutate the document text.
    expect(mounted.view.state.doc.toString()).toBe(doc);
    expect(text).toContain("https://github.com/myne-md/myne");
    const el = mounted.view.contentDOM.querySelector("[data-cm-url]");
    expect(el?.getAttribute("data-cm-url")).toBe(
      "https://github.com/myne-md/myne",
    );
  });

  it("bare URL trailing punctuation excluded (GFM boundary)", () => {
    mounted = mount("see https://x.com/a, ok\n", null);
    focusOffCursor(mounted);
    const el = mounted.view.contentDOM.querySelector("[data-cm-url]");
    // The trailing comma is not part of the link target.
    expect(el?.getAttribute("data-cm-url")).toBe("https://x.com/a");
    expect(el?.textContent).toBe("https://x.com/a");
  });

  it("bare email auto-linked as mailto", () => {
    mounted = mount("write hello@myne.md soon\n", null);
    focusOffCursor(mounted);
    const el = mounted.view.contentDOM.querySelector("[data-cm-url]");
    expect(el?.getAttribute("data-cm-url")).toBe("mailto:hello@myne.md");
  });

  it("unsafe scheme is not made clickable", () => {
    const doc = "x <javascript:alert(1)> y\n";
    mounted = mount(doc, null);
    focusOffCursor(mounted);
    const el = mounted.view.contentDOM.querySelector("[data-cm-url]");
    expect(el).toBeNull();
    // Left as raw text — brackets not stripped.
    expect(mounted.view.contentDOM.textContent).toContain(
      "<javascript:alert(1)>",
    );
  });

  it("regular [text](url) link is not given a data-cm-url (click edits, not opens)", () => {
    mounted = mount("a [text](https://myne.md) b\n", null);
    focusOffCursor(mounted);
    expect(mounted.view.contentDOM.querySelector("[data-cm-url]")).toBeNull();
  });
});
