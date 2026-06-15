// @vitest-environment jsdom
//
// A note that is ONLY frontmatter must stay writable: the block-replace
// Properties widget must NOT swallow the entire document, or there is no
// editable line for the caret and the user can't click to start typing the
// body (the frontmatter-only-note bug).
//
// Two shapes:
//   - trailing newline (`---\n…\n---\n`): the decoration stops one char short
//     of the final break so the empty body line below renders + is clickable.
//   - no trailing newline (`---\n…\n---`): no line exists to expose, so a click
//     in the dead area below the widget inserts one and lands the caret on it.

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { frontmatterDecorations } from "../../src/editor/decorations/frontmatter";

type Mounted = { view: EditorView; host: HTMLElement };

function mount(doc: string): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [frontmatterDecorations()],
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

describe("frontmatter-only note stays writable", () => {
  let mounted: Mounted | null = null;
  afterEach(() => {
    if (mounted !== null) teardown(mounted);
    mounted = null;
  });

  it("trailing-newline frontmatter-only note keeps one editable body line", () => {
    mounted = mount("---\ntitle: x\n---\n");
    // The Properties widget renders…
    expect(mounted.host.querySelector(".cm-fm-properties")).not.toBeNull();
    // …but the trailing empty line is left as a live, clickable caret target.
    expect(mounted.host.querySelectorAll(".cm-line").length).toBe(1);
  });

  it("frontmatter followed by a blank body line still renders the body", () => {
    mounted = mount("---\ntitle: x\n---\n\n");
    expect(mounted.host.querySelector(".cm-fm-properties")).not.toBeNull();
    expect(
      mounted.host.querySelectorAll(".cm-line").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("a note WITH body content is not over-shrunk (body lines render)", () => {
    mounted = mount("---\ntitle: x\n---\nbody text\n");
    expect(mounted.host.querySelector(".cm-fm-properties")).not.toBeNull();
    const text = mounted.host.querySelector(".cm-content")?.textContent ?? "";
    expect(text).toContain("body text");
  });

  it("click below the widget on a no-trailing-newline note creates a body line", () => {
    mounted = mount("---\ntitle: x\n---");
    const { view } = mounted;
    expect(view.state.doc.length).toBe(16);

    // jsdom's getBoundingClientRect is all-zero; a clientY > 0 reads as "below
    // the widget" so the handler fires.
    const event = new MouseEvent("mousedown", {
      button: 0,
      clientY: 10,
      bubbles: true,
      cancelable: true,
    });
    view.contentDOM.dispatchEvent(event);

    // A newline was appended and the caret sits on the fresh body line.
    expect(view.state.doc.toString()).toBe("---\ntitle: x\n---\n");
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
  });

  it("click on a note WITH body is left to CodeMirror (no spurious newline)", () => {
    mounted = mount("---\ntitle: x\n---\nbody\n");
    const { view } = mounted;
    const before = view.state.doc.toString();
    const event = new MouseEvent("mousedown", {
      button: 0,
      clientY: 10,
      bubbles: true,
      cancelable: true,
    });
    view.contentDOM.dispatchEvent(event);
    // The handler bails (note already has a body) — no spurious newline. CM's
    // own selection logic may preventDefault the mousedown; only the doc matters.
    expect(view.state.doc.toString()).toBe(before);
  });
});
