// @vitest-environment jsdom
//
// Selection-toolbar ViewPlugin behavior (`editor/toolbar/plugin.ts`, PRD
// editor-mvp-baseline stories 35-40, 42). Drives the live floating toolbar
// against real selections and asserts:
//   - the toolbar mounts only over a non-empty, formattable selection
//   - each button's mousedown runs the correct wrap/heading/link command and
//     mutates the document accordingly
//   - the heading + highlight dropdowns open/close and apply
//   - the URL overlay wraps the selection as `[text](url)` on Enter / Apply
//
// jsdom has no layout, so `coordsAtPos` is stubbed (the plugin tolerates a
// rect; we only assert the DOM + doc, not pixel positions). The toolbar mounts
// to document.body and renders on a rAF, so each assertion awaits a frame.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { forceParsing } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { codeNestMarkdownExtension } from "../../src/editor/code-highlight";
import { selectionToolbarExtension } from "../../src/editor/toolbar/plugin";

beforeAll(() => {
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = () => {};
  }
});

type Mounted = { view: EditorView; host: HTMLElement };

function mount(doc: string, anchor: number, head: number): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor, head },
      extensions: [
        markdown({ base: markdownLanguage, extensions: [codeNestMarkdownExtension] }),
        selectionToolbarExtension(),
      ],
    }),
    parent: host,
  });
  // jsdom has no geometry — `coordsAtPos` does real math and would throw/null.
  // Return a fixed rect so the render path positions and mounts the toolbar.
  view.coordsAtPos = () => ({ left: 10, right: 20, top: 10, bottom: 24 });
  forceParsing(view);
  // The plugin only refreshes on selectionSet/docChanged/viewportChanged — none
  // of which fire on bare mount under jsdom. Re-dispatch the selection so the
  // toolbar's `update()` runs and (when applicable) schedules a render.
  view.dispatch({ selection: { anchor, head } });
  return { view, host };
}

function teardown(m: Mounted): void {
  m.view.destroy();
  m.host.remove();
}

const raf = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

function toolbar(): HTMLElement | null {
  return document.body.querySelector(".cm-toolbar");
}

/** A toolbar button bearing the given visible label (B / I / S / <> / ↗). */
function buttonByText(label: string): HTMLButtonElement | null {
  const tb = toolbar();
  if (tb === null) return null;
  return (
    Array.from(tb.querySelectorAll<HTMLButtonElement>("button.cm-toolbar-button")).find(
      (b) => b.textContent === label,
    ) ?? null
  );
}

/** The leading block-type control (shows the current type + opens the dropdown).
 *  Selected by class since its label is dynamic (Paragraph / H1..H6). */
function blockTypeButton(): HTMLButtonElement | null {
  return toolbar()?.querySelector<HTMLButtonElement>("button.cm-toolbar-blocktype") ?? null;
}

/** Fire the (preventDefault'd) mousedown the toolbar buttons listen for. */
function press(el: Element): void {
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
}

let m: Mounted | null = null;
afterEach(() => {
  // Any stray toolbar/overlay container is mounted on document.body, not host.
  document.body.querySelectorAll(".cm-toolbar, .cm-url-overlay").forEach((n) => n.remove());
  if (m !== null) teardown(m);
  m = null;
});

describe("toolbar mount gating", () => {
  it("does not mount over an empty (collapsed) selection", async () => {
    m = mount("hello world", 5, 5);
    await raf();
    expect(toolbar()).toBeNull();
  });

  it("mounts over a non-empty prose selection with all format buttons", async () => {
    m = mount("hello world", 0, 5); // "hello"
    await raf();
    const tb = toolbar();
    expect(tb).not.toBeNull();
    expect(buttonByText("B")).not.toBeNull();
    expect(buttonByText("I")).not.toBeNull();
    expect(buttonByText("S")).not.toBeNull();
    expect(buttonByText("<>")).not.toBeNull();
    expect(blockTypeButton()).not.toBeNull();
    expect(buttonByText("↗")).not.toBeNull();
  });

  it("does not mount when the selection is inside a fenced code block", async () => {
    const FENCED = "```rust\nlet x = 1;\n```"; // body starts at offset 8
    m = mount(FENCED, 8, 13); // "let x"
    await raf();
    expect(toolbar()).toBeNull();
  });

  it("dismisses when a range selection collapses to a caret", async () => {
    m = mount("hello world", 0, 5);
    await raf();
    expect(toolbar()).not.toBeNull();
    m.view.dispatch({ selection: { anchor: 5, head: 5 } });
    await raf();
    expect(toolbar()).toBeNull();
  });
});

describe("toolbar format buttons mutate the doc", () => {
  it("Bold wraps the selection in **…**", async () => {
    m = mount("hello world", 0, 5);
    await raf();
    press(buttonByText("B")!);
    expect(m.view.state.doc.toString()).toBe("**hello** world");
  });

  it("Italic wraps the selection in *…*", async () => {
    m = mount("hello world", 0, 5);
    await raf();
    press(buttonByText("I")!);
    expect(m.view.state.doc.toString()).toBe("*hello* world");
  });

  it("Strike wraps the selection in ~~…~~", async () => {
    m = mount("hello world", 0, 5);
    await raf();
    press(buttonByText("S")!);
    expect(m.view.state.doc.toString()).toBe("~~hello~~ world");
  });

  it("Code wraps the selection in `…`", async () => {
    m = mount("hello world", 0, 5);
    await raf();
    press(buttonByText("<>")!);
    expect(m.view.state.doc.toString()).toBe("`hello` world");
  });

  it("Bold is an idempotent toggle (re-press unwraps)", async () => {
    m = mount("**hello** world", 0, 9); // select the whole **hello** span
    await raf();
    press(buttonByText("B")!);
    expect(m.view.state.doc.toString()).toBe("hello world");
  });
});

describe("highlight control", () => {
  it("the main H button applies the default yellow ==…==", async () => {
    m = mount("hello world", 0, 5);
    await raf();
    const mainBtn = toolbar()!.querySelector<HTMLButtonElement>(
      "[data-testid='toolbar.highlight']",
    );
    expect(mainBtn).not.toBeNull();
    press(mainBtn!);
    expect(m.view.state.doc.toString()).toBe("==hello== world");
  });

  it("the caret opens a 5-swatch dropdown; a color swatch wraps in <mark class>", async () => {
    m = mount("hello world", 0, 5);
    await raf();
    const caret = toolbar()!.querySelector<HTMLButtonElement>(
      "[data-testid='toolbar.highlight-caret']",
    );
    press(caret!);
    await raf();
    const swatches = toolbar()!.querySelectorAll(".cm-toolbar-highlight-swatch");
    expect(swatches.length).toBe(5);
    const green = toolbar()!.querySelector<HTMLButtonElement>(
      "[data-testid='toolbar.highlight-hl-green']",
    );
    press(green!);
    expect(m.view.state.doc.toString()).toBe('<mark class="hl-green">hello</mark> world');
  });
});

describe("heading dropdown", () => {
  it("opens on H▾ click and applies a level to the cursor line", async () => {
    m = mount("hello world", 0, 5);
    await raf();
    press(blockTypeButton()!);
    await raf();
    const drop = toolbar()!.querySelector(".cm-toolbar-heading-dropdown");
    expect(drop).not.toBeNull();
    const h2 = Array.from(
      drop!.querySelectorAll<HTMLElement>(".cm-toolbar-heading-item"),
    ).find((el) => el.textContent === "H2");
    press(h2!);
    expect(m.view.state.doc.toString()).toBe("## hello world");
  });

  it("Paragraph (level 0) strips an existing heading prefix", async () => {
    m = mount("### title here", 4, 9); // selection inside the heading line
    await raf();
    press(blockTypeButton()!);
    await raf();
    const drop = toolbar()!.querySelector(".cm-toolbar-heading-dropdown")!;
    const para = Array.from(
      drop.querySelectorAll<HTMLElement>(".cm-toolbar-heading-item"),
    ).find((el) => el.textContent === "Paragraph");
    press(para!);
    expect(m.view.state.doc.toString()).toBe("title here");
  });

  it("re-applying H▾ replaces the prior heading level rather than stacking #", async () => {
    m = mount("# title", 2, 5);
    await raf();
    press(blockTypeButton()!);
    await raf();
    const drop = toolbar()!.querySelector(".cm-toolbar-heading-dropdown")!;
    const h3 = Array.from(
      drop.querySelectorAll<HTMLElement>(".cm-toolbar-heading-item"),
    ).find((el) => el.textContent === "H3");
    press(h3!);
    expect(m.view.state.doc.toString()).toBe("### title");
  });
});

describe("URL overlay (link)", () => {
  it("the ↗ button opens a URL overlay with a focused input", async () => {
    m = mount("hello world", 0, 5);
    await raf();
    press(buttonByText("↗")!);
    await raf();
    const overlay = document.body.querySelector(".cm-url-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelector("input")).not.toBeNull();
  });

  it("Enter in the overlay wraps the selection as [text](url)", async () => {
    m = mount("hello world", 0, 5);
    await raf();
    press(buttonByText("↗")!);
    await raf();
    const input = document.body.querySelector<HTMLInputElement>(".cm-url-overlay-input")!;
    input.value = "https://x.test";
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(m.view.state.doc.toString()).toBe("[hello](https://x.test) world");
    // Overlay dismissed after commit.
    expect(document.body.querySelector(".cm-url-overlay")).toBeNull();
  });

  it("an empty URL on Enter dismisses without mutating the doc", async () => {
    m = mount("hello world", 0, 5);
    await raf();
    press(buttonByText("↗")!);
    await raf();
    const input = document.body.querySelector<HTMLInputElement>(".cm-url-overlay-input")!;
    input.value = "   "; // trims to empty
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(m.view.state.doc.toString()).toBe("hello world");
    expect(document.body.querySelector(".cm-url-overlay")).toBeNull();
  });

  it("Escape in the overlay dismisses without mutating the doc", async () => {
    m = mount("hello world", 0, 5);
    await raf();
    press(buttonByText("↗")!);
    await raf();
    const input = document.body.querySelector<HTMLInputElement>(".cm-url-overlay-input")!;
    input.value = "https://x.test";
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(m.view.state.doc.toString()).toBe("hello world");
    expect(document.body.querySelector(".cm-url-overlay")).toBeNull();
  });

  it("the Apply button commits the link", async () => {
    m = mount("hello world", 0, 5);
    await raf();
    press(buttonByText("↗")!);
    await raf();
    const input = document.body.querySelector<HTMLInputElement>(".cm-url-overlay-input")!;
    input.value = "https://y.test";
    const apply = document.body.querySelector<HTMLButtonElement>(".cm-url-overlay-apply")!;
    press(apply);
    expect(m.view.state.doc.toString()).toBe("[hello](https://y.test) world");
  });
});
