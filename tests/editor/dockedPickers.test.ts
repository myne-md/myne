// @vitest-environment jsdom
//
// The three typeahead pickers on the docked presentation (myne-md/myne#884,
// task 5): the slash menu, the `[[` wikilink picker and the `{{` template-token
// menu.
//
// # What this pins that the anchored specs cannot
//
// Each of the three has a spec of its own covering the ANCHORED popover
// (`slash-menu-hover-nav.test.ts`, `wikilink-picker.test.ts`,
// `template-token-menu.test.ts`), and those stay the reference for the anchored
// behaviour. This file asserts the DELTA the docked presentation introduces, and
// it does so for all three in one place because the three are one change at
// three call sites: they share the placement machinery, so they share the
// answer. That is the shape `taskFieldDockedSheet.test.ts` already uses for the
// task-field surfaces.
//
//   1. the surface arrives INSIDE the docked sheet, not as a popover anchored to
//      the caret, and the anchored client still gets the popover;
//   2. the sheet it arrives in is NOT modal: it is a direct child of the body
//      with no backdrop, so the editor keeps the focus and the user keeps typing
//      to filter. A modal sheet would break the typeahead it is presenting;
//   3. each surface's own content is untouched: the same rows, the same
//      filtering and the same keyboard navigation, driven through the same
//      primitives the anchored specs use.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { getHost, setEditorHost } from "@myne/editor/host";
import { slashMenuExtension } from "../../src/editor/slash/plugin";
import { templateTokenMenuExtension } from "../../src/editor/template-tokens/plugin";
import { wikilinkPickerExtension } from "../../src/editor/wikilink/picker";
import {
  noteSetExtension,
  reconfigureNoteSet,
} from "../../src/editor/wikilink/note-set";
import { SUPPORTED_TOKENS } from "../../src/dialect/templateEngine";
import type { ResolverNote } from "../../src/notes/resolveWikilink";

const SLASH = "editor.slash-menu-sheet";
const WIKI = "editor.wikilink-picker-sheet";
const TOKEN = "editor.template-token-sheet";

const NOTES: readonly ResolverNote[] = [
  { noteUuid: "a", title: "Wednesday", folder: "notes/2025/" },
  { noteUuid: "b", title: "Weekly Review", folder: "Projects/" },
  { noteUuid: "c", title: "Welcome", folder: null },
];

const TEMPLATE_FM = "---\ntemplate: true\n---\n";
const TOKEN_LABELS = SUPPORTED_TOKENS.map((t) => `{{${t}}}`);

beforeAll(() => {
  // jsdom has no `scrollIntoView`; every picker calls it on the highlighted row
  // during render, so a no-op keeps render() from throwing.
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = () => {};
  }
});

const raf = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

let teardowns: Array<() => void> = [];

afterEach(() => {
  for (const t of teardowns) t();
  teardowns = [];
  // The docked sheet is the caller's to remove and a failing assertion can leave
  // one behind; the anchored popovers are covered the same way by the sibling
  // specs.
  document.body
    .querySelectorAll(".cm-docked-sheet, .cm-slash-menu")
    .forEach((e) => e.remove());
  // Put the shared stub's presentation back, so an arm that installs `docked`
  // cannot leak into a spec that runs after it.
  installPresentation("anchored");
});

/** The global setup installs the shared stub with the anchored presentation;
 *  this swaps the one member so both arms run against the same host otherwise. */
function installPresentation(presentation: "anchored" | "docked"): void {
  setEditorHost({ ...getHost(), floatingSurface: presentation });
}

/** Mount a view over `extensions`, with `coordsAtPos` forced to the null
 *  fallback the render paths tolerate (jsdom computes no geometry). */
function mount(doc: string, extensions: Extension[]): EditorView {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length, head: doc.length },
      extensions,
    }),
    parent: host,
  });
  view.coordsAtPos = () => null;
  teardowns.push(() => {
    view.destroy();
    host.remove();
  });
  return view;
}

/** Type `text` at the cursor, one transaction per character, so a two-character
 *  trigger (`[[`, `{{`) is seen as the pair it is typed as. */
function typeText(view: EditorView, text: string): void {
  for (const ch of text) {
    const head = view.state.selection.main.head;
    view.dispatch({ changes: { from: head, insert: ch }, selection: { anchor: head + 1 } });
  }
}

function runKey(view: EditorView, key: string): boolean {
  return runScopeHandlers(
    view,
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    "editor",
  );
}

function sheet(testId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function sheetList(testId: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-testid="${testId}-list"]`);
  if (el === null) throw new Error(`no docked picker list for ${testId}`);
  return el;
}

function labels(testId: string): string[] {
  return Array.from(
    sheetList(testId).querySelectorAll<HTMLElement>(".cm-slash-menu-label"),
  ).map((e) => e.textContent ?? "");
}

function selectedIdx(testId: string): number {
  return Array.from(
    sheetList(testId).querySelectorAll<HTMLElement>(".cm-slash-menu-row"),
  ).findIndex((r) => r.classList.contains("cm-slash-menu-row-selected"));
}

describe("the slash menu", () => {
  it("docked: opens inside the sheet, which is a child of the body rather than a modal", async () => {
    installPresentation("docked");
    const view = mount("", [slashMenuExtension()]);
    typeText(view, "/");
    await raf();

    const el = sheet(SLASH);
    expect(el).not.toBeNull();
    // The anchored popover, and only that, is what must not be there. Its
    // absence is the whole claim.
    expect(document.querySelector(".cm-slash-menu")).toBeNull();
    // No backdrop and no focus trap: a typeahead the user filters by typing
    // cannot be modal. Structurally that is "the sheet's parent is the body".
    expect(el!.parentElement).toBe(document.body);
    expect(sheetList(SLASH).querySelectorAll(".cm-slash-menu-row").length).toBeGreaterThan(3);
  });

  it("anchored: still opens the popover, and never the sheet", async () => {
    installPresentation("anchored");
    const view = mount("", [slashMenuExtension()]);
    typeText(view, "/");
    await raf();

    expect(document.querySelector(".cm-slash-menu")).not.toBeNull();
    expect(sheet(SLASH)).toBeNull();
  });

  it("docked: keeps filtering, keyboard navigation and Escape, and applies the chosen command", async () => {
    installPresentation("docked");
    const view = mount("", [slashMenuExtension()]);
    typeText(view, "/");
    await raf();
    const all = sheetList(SLASH).querySelectorAll(".cm-slash-menu-row").length;

    // Filtering, driven the way the user drives it: more typing, in the editor.
    typeText(view, "h1");
    await raf();
    expect(labels(SLASH)).toEqual(["Heading 1"]);
    expect(sheetList(SLASH).querySelectorAll(".cm-slash-menu-row").length).toBeLessThan(all);
    expect(selectedIdx(SLASH)).toBe(0);

    // Keyboard navigation, through the plugin's own `Prec.highest` keymap, which
    // is what proves the sheet did not take the keys for itself.
    expect(runKey(view, "Enter")).toBe(true);
    await raf();
    expect(view.state.doc.toString()).not.toContain("/h1");
    expect(view.state.doc.toString()).toContain("#");
    // Applying a command closes the surface, so the sheet is torn down with it.
    expect(sheet(SLASH)).toBeNull();
  });

  it("docked: Escape dismisses the sheet without applying anything", async () => {
    installPresentation("docked");
    const view = mount("", [slashMenuExtension()]);
    typeText(view, "/h1");
    await raf();
    expect(sheet(SLASH)).not.toBeNull();

    expect(runKey(view, "Escape")).toBe(true);
    await raf();
    expect(sheet(SLASH)).toBeNull();
    expect(view.state.doc.toString()).toBe("/h1");
  });
});

describe("the template-token menu", () => {
  it("docked: opens inside the sheet and lists the engine's tokens", async () => {
    installPresentation("docked");
    const view = mount(TEMPLATE_FM, [templateTokenMenuExtension()]);
    typeText(view, "{{");
    await raf();

    expect(sheet(TOKEN)).not.toBeNull();
    expect(document.querySelector(".cm-slash-menu")).toBeNull();
    expect(sheet(TOKEN)!.parentElement).toBe(document.body);
    expect(labels(TOKEN)).toEqual(TOKEN_LABELS);
  });

  it("docked: still refuses to open in a note that is not a template", async () => {
    installPresentation("docked");
    const view = mount("---\ntitle: Note\n---\n", [templateTokenMenuExtension()]);
    typeText(view, "{{");
    await raf();

    expect(sheet(TOKEN)).toBeNull();
  });

  it("anchored: still opens the popover, and never the sheet", async () => {
    installPresentation("anchored");
    const view = mount(TEMPLATE_FM, [templateTokenMenuExtension()]);
    typeText(view, "{{");
    await raf();

    expect(document.querySelector(".cm-slash-menu")).not.toBeNull();
    expect(sheet(TOKEN)).toBeNull();
  });

  it("docked: keeps filtering and insertion", async () => {
    installPresentation("docked");
    const view = mount(TEMPLATE_FM, [templateTokenMenuExtension()]);
    typeText(view, "{{da");
    await raf();
    expect(labels(TOKEN)).toEqual(["{{date}}", "{{datetime}}"]);

    expect(runKey(view, "Enter")).toBe(true);
    await raf();
    expect(view.state.doc.toString()).toBe(`${TEMPLATE_FM}{{date}}`);
    expect(sheet(TOKEN)).toBeNull();
  });
});

describe("the wikilink picker", () => {
  function mountWiki(): EditorView {
    const view = mount("", [noteSetExtension(), wikilinkPickerExtension()]);
    view.dispatch({ effects: reconfigureNoteSet(NOTES) });
    return view;
  }

  it("docked: opens inside the sheet and lists the notes", async () => {
    installPresentation("docked");
    const view = mountWiki();
    typeText(view, "[[");
    await raf();

    expect(sheet(WIKI)).not.toBeNull();
    expect(document.querySelector(".cm-slash-menu")).toBeNull();
    expect(sheet(WIKI)!.parentElement).toBe(document.body);
    // The picker's own rows, reached through the sheet's list.
    expect(
      sheetList(WIKI).querySelectorAll('[data-testid="picker.note-row"]').length,
    ).toBe(3);
  });

  it("anchored: still opens the popover, and never the sheet", async () => {
    installPresentation("anchored");
    const view = mountWiki();
    typeText(view, "[[");
    await raf();

    expect(document.querySelector(".cm-wiki-picker")).not.toBeNull();
    expect(sheet(WIKI)).toBeNull();
  });

  it("docked: keeps filtering and the keyboard-driven insertion", async () => {
    installPresentation("docked");
    const view = mountWiki();
    typeText(view, "[[wed");
    await raf();
    // "Wednesday" only: the query is a prefix of the one title and of no other.
    expect(labels(WIKI)).toEqual(["Wednesday"]);

    expect(runKey(view, "Enter")).toBe(true);
    await raf();
    expect(view.state.doc.toString()).toBe("[[notes/2025/Wednesday.md|Wednesday]]");
    expect(sheet(WIKI)).toBeNull();
  });
});
