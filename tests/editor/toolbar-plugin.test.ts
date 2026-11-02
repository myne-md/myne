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
import { HIGHLIGHT_CLASSES } from "../../editor/src/html/sanitize";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { assertParsed } from "./_parse-budget";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { codeNestMarkdownExtension } from "../../src/editor/code-highlight";
import {
  selectionToolbarExtension,
  setToolbarLayout,
} from "../../src/editor/toolbar/plugin";

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
  assertParsed(view);
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

/**
 * A toolbar button by its control id.
 *
 * Selected by `data-testid` rather than by visible text: the buttons stopped
 * carrying text when they got real icons (issue #970, item 2), and a test that
 * matched on the glyph would be asserting the icon SET rather than the command
 * a button runs. The id is the stable half.
 */
function buttonByControl(id: string): HTMLButtonElement | null {
  const tb = toolbar();
  if (tb === null) return null;
  return tb.querySelector<HTMLButtonElement>(`[data-testid='toolbar.${id}']`);
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
  // Module-level state: a test that feeds a layout must not leak it into the next.
  setToolbarLayout(null);
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
    expect(buttonByControl("bold")).not.toBeNull();
    expect(buttonByControl("italic")).not.toBeNull();
    expect(buttonByControl("strike")).not.toBeNull();
    expect(buttonByControl("code")).not.toBeNull();
    expect(blockTypeButton()).not.toBeNull();
    expect(buttonByControl("link")).not.toBeNull();
    // Each button carries an icon and BOTH halves of its name: a tooltip for the
    // pointer and an `aria-label` for a screen reader. The bar it replaced drew
    // a letter with no name at all, so "S" was a strikethrough only to somebody
    // who already knew.
    const bold = buttonByControl("bold")!;
    expect(bold.querySelector("svg")).not.toBeNull();
    expect(bold.getAttribute("aria-label")).toBe("Bold");
    expect(bold.title).toBe("Bold");
    expect(tb!.getAttribute("role")).toBe("toolbar");
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
    press(buttonByControl("bold")!);
    expect(m.view.state.doc.toString()).toBe("**hello** world");
  });

  it("Italic wraps the selection in *…*", async () => {
    m = mount("hello world", 0, 5);
    await raf();
    press(buttonByControl("italic")!);
    expect(m.view.state.doc.toString()).toBe("*hello* world");
  });

  it("Strike wraps the selection in ~~…~~", async () => {
    m = mount("hello world", 0, 5);
    await raf();
    press(buttonByControl("strike")!);
    expect(m.view.state.doc.toString()).toBe("~~hello~~ world");
  });

  it("Code wraps the selection in `…`", async () => {
    m = mount("hello world", 0, 5);
    await raf();
    press(buttonByControl("code")!);
    expect(m.view.state.doc.toString()).toBe("`hello` world");
  });

  it("Bold is an idempotent toggle (re-press unwraps)", async () => {
    m = mount("**hello** world", 0, 9); // select the whole **hello** span
    await raf();
    press(buttonByControl("bold")!);
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

  it("the caret opens a swatch dropdown, one per allowed class; a swatch wraps in <mark class>", async () => {
    m = mount("hello world", 0, 5);
    await raf();
    const caret = toolbar()!.querySelector<HTMLButtonElement>(
      "[data-testid='toolbar.highlight-caret']",
    );
    press(caret!);
    await raf();
    const swatches = toolbar()!.querySelectorAll(".cm-toolbar-highlight-swatch");
    // Bound to the sanitizer's allowlist rather than a literal (MYND-632): the
    // dropdown must offer exactly the classes that survive sanitization, so a
    // palette change cannot silently ship a swatch that renders unstyled.
    expect(swatches.length).toBe(HIGHLIGHT_CLASSES.length);
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
    press(buttonByControl("link")!);
    await raf();
    const overlay = document.body.querySelector(".cm-url-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelector("input")).not.toBeNull();
  });

  it("Enter in the overlay wraps the selection as [text](url)", async () => {
    m = mount("hello world", 0, 5);
    await raf();
    press(buttonByControl("link")!);
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

  // ── myne#327: the overlay's selection must follow the document ────────────
  //
  // `savedSelection` was frozen at open and `commit()` sliced and replaced those
  // raw offsets in the CURRENT document. The overlay is open across an untimed
  // window — the user is typing a URL, often pasting it from elsewhere — so an
  // autosave stamp or any edit above shifted the run, and the brackets landed
  // mid-word while the word the user selected kept no link. Silently.

  it("follows an edit made ABOVE the selection while the overlay is open", async () => {
    m = mount("hello world", 0, 5);
    await raf();
    press(buttonByControl("link")!);
    await raf();

    m.view.dispatch({ changes: { from: 0, insert: "PREFIX " } });

    const input = document.body.querySelector<HTMLInputElement>(".cm-url-overlay-input")!;
    input.value = "https://x.test";
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(m.view.state.doc.toString()).toBe("PREFIX [hello](https://x.test) world");
  });

  it("declines instead of throwing when the selection is deleted under it", async () => {
    m = mount("hello world", 0, 5);
    await raf();
    press(buttonByControl("link")!);
    await raf();

    // The Cmd+A/Backspace shape: the document shrinks past the frozen `to`,
    // which used to throw a RangeError out of the keydown listener and escape
    // uncaught — leaving the overlay wedged on document.body, editor unfocused.
    m.view.dispatch({ changes: { from: 0, to: m.view.state.doc.length, insert: "" } });

    const input = document.body.querySelector<HTMLInputElement>(".cm-url-overlay-input")!;
    input.value = "https://x.test";
    expect(() =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      ),
    ).not.toThrow();
    expect(m.view.state.doc.toString()).toBe("");
    // …and the overlay really is gone, rather than wedged.
    expect(document.body.querySelector(".cm-url-overlay")).toBeNull();
  });

  it("an empty URL on Enter dismisses without mutating the doc", async () => {
    m = mount("hello world", 0, 5);
    await raf();
    press(buttonByControl("link")!);
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
    press(buttonByControl("link")!);
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
    press(buttonByControl("link")!);
    await raf();
    const input = document.body.querySelector<HTMLInputElement>(".cm-url-overlay-input")!;
    input.value = "https://y.test";
    const apply = document.body.querySelector<HTMLButtonElement>(".cm-url-overlay-apply")!;
    press(apply);
    expect(m.view.state.doc.toString()).toBe("[hello](https://y.test) world");
  });
});

describe("the block and note commands render (issue #970, item 1)", () => {
  // The five ids that used to be pinned hidden with a "Coming soon" row in
  // Settings: their commands existed, the toolbar skipped them. This asserts the
  // pin is genuinely gone: the layout the host feeds is honoured id for id.
  const NOTE_COMMANDS = ["bulletList", "numberedList", "checklist", "quote", "wikilink"];

  it("every vocabulary id is rendered when the layout asks for it", async () => {
    setToolbarLayout([
      "heading",
      "bold",
      "italic",
      "strike",
      "code",
      "highlight",
      "link",
      ...NOTE_COMMANDS,
    ]);
    m = mount("hello world", 0, 5);
    await raf();
    for (const id of NOTE_COMMANDS) {
      expect(buttonByControl(id), id).not.toBeNull();
    }
  });

  it("feeds dividers between groups, not one undifferentiated run", async () => {
    setToolbarLayout(["heading", "bold", "highlight", "bulletList", "wikilink"]);
    m = mount("hello world", 0, 5);
    await raf();
    // heading|inline, inline|colour, colour|list, list|note
    expect(toolbar()!.querySelectorAll(".cm-toolbar-sep").length).toBe(4);
  });

  it("bullet list prefixes every line the selection touches, and toggles off", async () => {
    setToolbarLayout(["bulletList"]);
    m = mount("one\ntwo", 0, 3);
    await raf();
    press(buttonByControl("bulletList")!);
    expect(m.view.state.doc.toString()).toBe("- one\ntwo");
    await raf();
    press(buttonByControl("bulletList")!);
    expect(m.view.state.doc.toString()).toBe("one\ntwo");
  });

  it("checklist writes the task marker, not a bare bullet", async () => {
    setToolbarLayout(["checklist"]);
    m = mount("buy milk", 0, 8);
    await raf();
    press(buttonByControl("checklist")!);
    expect(m.view.state.doc.toString()).toBe("- [ ] buy milk");
  });

  it("quote prefixes the line with '> '", async () => {
    setToolbarLayout(["quote"]);
    m = mount("hello world", 0, 5);
    await raf();
    press(buttonByControl("quote")!);
    expect(m.view.state.doc.toString()).toBe("> hello world");
  });

  it("numbered list prefixes with '1. '", async () => {
    setToolbarLayout(["numberedList"]);
    m = mount("hello world", 0, 5);
    await raf();
    press(buttonByControl("numberedList")!);
    expect(m.view.state.doc.toString()).toBe("1. hello world");
  });

  it("wikilink wraps the selection in [[…]]", async () => {
    setToolbarLayout(["wikilink"]);
    m = mount("hello world", 0, 5);
    await raf();
    press(buttonByControl("wikilink")!);
    expect(m.view.state.doc.toString()).toBe("[[hello]] world");
  });

  it("paints the block the caret is already in as pressed", async () => {
    setToolbarLayout(["bulletList", "quote", "checklist"]);
    m = mount("- already a bullet", 2, 5);
    await raf();
    expect(buttonByControl("bulletList")!.getAttribute("aria-pressed")).toBe("true");
    expect(buttonByControl("quote")!.getAttribute("aria-pressed")).toBe("false");
    // A task is drawn as a bullet AND as a task: both are true of the line, and
    // the task button is the more specific of the two.
    expect(buttonByControl("checklist")!.getAttribute("aria-pressed")).toBe("false");
    expect(buttonByControl("bulletList")!.classList.contains("cm-toolbar-button-active")).toBe(
      true,
    );
  });

  it("the block-type control names the block the caret is IN", async () => {
    setToolbarLayout(["heading"]);
    m = mount("> quoted line", 3, 6);
    await raf();
    expect(blockTypeButton()!.textContent).toContain("Quote");
  });

  it("the block-type dropdown offers the list and quote blocks too", async () => {
    setToolbarLayout(["heading"]);
    m = mount("hello world", 0, 5);
    await raf();
    press(blockTypeButton()!);
    await raf();
    const items = Array.from(
      toolbar()!.querySelectorAll<HTMLElement>(".cm-toolbar-heading-item"),
    ).map((el) => el.textContent);
    expect(items).toContain("Bullet list");
    expect(items).toContain("Checklist");
    expect(items).toContain("Quote");
    const quote = toolbar()!.querySelector<HTMLElement>(
      "[data-testid='toolbar.blockType.quote']",
    )!;
    press(quote);
    expect(m.view.state.doc.toString()).toBe("> hello world");
  });
});

describe("active marks (issue #970, item 2)", () => {
  it("marks the buttons whose delimiter already surrounds the selection", async () => {
    setToolbarLayout(["bold", "italic", "strike", "code"]);
    m = mount("**hello** world", 2, 7);
    await raf();
    expect(buttonByControl("bold")!.getAttribute("aria-pressed")).toBe("true");
    // `*` is a prefix of `**`, so a bold span must not read as italic too.
    expect(buttonByControl("italic")!.getAttribute("aria-pressed")).toBe("false");
    expect(buttonByControl("code")!.getAttribute("aria-pressed")).toBe("false");
  });

  it("reads an italic span as italic", async () => {
    setToolbarLayout(["bold", "italic"]);
    m = mount("*hello* world", 1, 6);
    await raf();
    expect(buttonByControl("italic")!.getAttribute("aria-pressed")).toBe("true");
    expect(buttonByControl("bold")!.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("keyboard activation (issue #970 review, D6)", () => {
  /** The `click` a browser synthesizes for Enter or Space on a focused button:
   *  `detail` is 0 because no pointer was involved. */
  function keyboardClick(el: Element): void {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
  }

  it("runs the command on a keyboard-generated click", async () => {
    setToolbarLayout(["bold"]);
    m = mount("hello world", 0, 5);
    await raf();
    keyboardClick(buttonByControl("bold")!);
    expect(m.view.state.doc.toString()).toBe("**hello** world");
  });

  it("does not run the command twice on a real pointer press", async () => {
    // The defect a naive `click` listener would introduce: the pointer press
    // runs the action from `mousedown`, and the `click` that follows runs it
    // again, toggling the mark straight back off. `detail !== 0` is what a
    // pointer-generated click carries.
    setToolbarLayout(["bold"]);
    m = mount("hello world", 0, 5);
    await raf();
    const bold = buttonByControl("bold")!;
    press(bold);
    bold.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    expect(m.view.state.doc.toString()).toBe("**hello** world");
  });

  it("makes the block-type dropdown's menu items reachable from the keyboard", async () => {
    m = mount("hello world", 0, 5);
    await raf();
    press(blockTypeButton()!);
    await raf();
    const quote = toolbar()!.querySelector<HTMLElement>("[data-testid='toolbar.blockType.quote']")!;
    // `role="menuitem"` on a div: no browser focuses or activates it on its own.
    expect(quote.tabIndex).toBe(0);
    quote.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(m.view.state.doc.toString()).toBe("> hello world");
  });
});
