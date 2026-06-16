// @vitest-environment jsdom
//
// `{{` template-token autocomplete ViewPlugin (`editor/template-tokens/plugin.ts`,
// MYND-189). Drives the live ViewPlugin under jsdom: the menu opens ONLY inside a
// `template: true` note, lists the engine's `SUPPORTED_TOKENS`, filters by prefix,
// ↑/↓ wrap-navigate, Enter/click insert one clean `{{token}}` (consuming a
// closeBrackets `}}`), and a non-token char / no-match / cursor-exit closes it.
// In an ordinary note `{{` stays literal — the menu never appears.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { templateTokenMenuExtension } from "../../src/editor/template-tokens/plugin";
import { SUPPORTED_TOKENS } from "../../src/dialect/templateEngine";

beforeAll(() => {
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = () => {};
  }
});

const TEMPLATE_FM = "---\ntemplate: true\n---\n";
const PLAIN_FM = "---\ntitle: Note\n---\n";

const raf = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

function mount(doc: string): { view: EditorView; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length, head: doc.length },
      extensions: [templateTokenMenuExtension()],
    }),
    parent: host,
  });
  view.coordsAtPos = () => null; // jsdom has no layout → force the rect fallback
  return { view, host };
}

function typeText(view: EditorView, text: string): void {
  for (const ch of text) {
    const head = view.state.selection.main.head;
    view.dispatch({ changes: { from: head, insert: ch }, selection: { anchor: head + 1 } });
  }
}

const menu = (): HTMLElement | null => document.body.querySelector(".cm-slash-menu");
const labels = (): string[] =>
  Array.from(document.body.querySelectorAll<HTMLElement>(".cm-slash-menu-row .cm-slash-menu-label")).map(
    (e) => e.textContent ?? "",
  );
const selectedIdx = (): number =>
  Array.from(document.body.querySelectorAll<HTMLElement>(".cm-slash-menu .cm-slash-menu-row")).findIndex(
    (r) => r.classList.contains("cm-slash-menu-row-selected"),
  );

function runKey(view: EditorView, key: string): boolean {
  return runScopeHandlers(
    view,
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    "editor",
  );
}

let teardowns: Array<() => void> = [];
afterEach(() => {
  for (const t of teardowns) t();
  teardowns = [];
  document.body.querySelectorAll(".cm-slash-menu").forEach((e) => e.remove());
});

describe("template-token menu — gating", () => {
  it("does NOT open in an ordinary (non-template) note", async () => {
    const { view } = mount(PLAIN_FM);
    teardowns.push(() => view.destroy());
    typeText(view, "{{");
    await raf();
    expect(menu()).toBeNull();
  });

  it("opens in a `template: true` note and lists every supported token", async () => {
    const { view } = mount(TEMPLATE_FM);
    teardowns.push(() => view.destroy());
    typeText(view, "{{");
    await raf();
    expect(menu()).not.toBeNull();
    expect(labels()).toEqual(SUPPORTED_TOKENS.map((t) => `{{${t}}}`));
    expect(selectedIdx()).toBe(0);
  });
});

describe("template-token menu — filtering + navigation", () => {
  it("filters to a prefix match (`da` → only {{date}}/{{datetime}})", async () => {
    const { view } = mount(TEMPLATE_FM);
    teardowns.push(() => view.destroy());
    typeText(view, "{{da");
    await raf();
    expect(labels()).toEqual(["{{date}}", "{{datetime}}"]);
  });

  it("closes when the filter matches no token", async () => {
    const { view } = mount(TEMPLATE_FM);
    teardowns.push(() => view.destroy());
    typeText(view, "{{zzz");
    await raf();
    expect(menu()).toBeNull();
  });

  it("closes when a non-letter char enters the filter (e.g. `}` or a space)", async () => {
    const { view } = mount(TEMPLATE_FM);
    teardowns.push(() => view.destroy());
    typeText(view, "{{da");
    await raf();
    expect(menu()).not.toBeNull();
    typeText(view, " ");
    await raf();
    expect(menu()).toBeNull();
  });

  it("ArrowDown/ArrowUp wrap-navigate the selection", async () => {
    const { view } = mount(TEMPLATE_FM);
    teardowns.push(() => view.destroy());
    typeText(view, "{{");
    await raf();
    const n = SUPPORTED_TOKENS.length;
    expect(selectedIdx()).toBe(0);
    runKey(view, "ArrowUp"); // wrap to last
    await raf();
    expect(selectedIdx()).toBe(n - 1);
    runKey(view, "ArrowDown"); // wrap back to first
    await raf();
    expect(selectedIdx()).toBe(0);
  });
});

describe("template-token menu — insertion", () => {
  it("Enter inserts the selected `{{token}}` and closes", async () => {
    const { view } = mount(TEMPLATE_FM);
    teardowns.push(() => view.destroy());
    typeText(view, "body {{date");
    await raf();
    expect(menu()).not.toBeNull();
    runKey(view, "Enter");
    await raf();
    expect(view.state.doc.toString()).toBe(`${TEMPLATE_FM}body {{date}}`);
    expect(menu()).toBeNull();
  });

  it("consumes a trailing closeBrackets `}}` so the result is one clean token", async () => {
    const { view } = mount(TEMPLATE_FM);
    teardowns.push(() => view.destroy());
    const base = view.state.doc.length;
    // closeBrackets: typing the second `{` inserts `{` + the auto-closed `}}`,
    // landing the cursor at `{{|}}`.
    view.dispatch({ changes: { from: base, insert: "{" }, selection: { anchor: base + 1 } });
    view.dispatch({ changes: { from: base + 1, insert: "{}}" }, selection: { anchor: base + 2 } });
    await raf();
    expect(menu()).not.toBeNull();
    typeText(view, "time");
    await raf();
    runKey(view, "Enter");
    await raf();
    // No `{{time}}}}` doubling — the auto-closed `}}` is consumed.
    expect(view.state.doc.toString()).toBe(`${TEMPLATE_FM}{{time}}`);
  });

  it("a row mousedown inserts that token", async () => {
    const { view } = mount(TEMPLATE_FM);
    teardowns.push(() => view.destroy());
    typeText(view, "{{week");
    await raf();
    const row = Array.from(
      document.body.querySelectorAll<HTMLElement>(".cm-slash-menu-row"),
    ).find((r) => r.textContent === "{{weekday}}")!;
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await raf();
    expect(view.state.doc.toString()).toBe(`${TEMPLATE_FM}{{weekday}}`);
  });

  it("Escape dismisses without inserting", async () => {
    const { view } = mount(TEMPLATE_FM);
    teardowns.push(() => view.destroy());
    typeText(view, "{{da");
    await raf();
    expect(menu()).not.toBeNull();
    runKey(view, "Escape");
    await raf();
    expect(menu()).toBeNull();
    expect(view.state.doc.toString()).toBe(`${TEMPLATE_FM}{{da`);
  });

  it("moving the cursor out of the `{{…` span closes the menu", async () => {
    const { view } = mount(TEMPLATE_FM);
    teardowns.push(() => view.destroy());
    typeText(view, "{{da");
    await raf();
    expect(menu()).not.toBeNull();
    view.dispatch({ selection: { anchor: 0, head: 0 } });
    await raf();
    expect(menu()).toBeNull();
  });
});
