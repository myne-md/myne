// @vitest-environment jsdom
//
// `[[#` / `[[##` heading autocomplete in the live `[[` picker ViewPlugin
// (MYND-305). Mirrors `wikilink-picker.test.ts`'s harness: drive the real
// plugin under jsdom, type the trigger, assert the menu rows + the hybrid emit.
//
//  - `[[#`  → current-note headings → inserts the compact `[[#Heading]]`.
//  - `[[##` → vault-wide headings (from the vault-heading facet) → inserts the
//             full `[[vault/path.md#Heading|Display]]` path form.
//  - zero matches close the picker (no-create-on-miss).

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { wikilinkPickerExtension } from "../../src/editor/wikilink/picker";
import {
  noteSetExtension,
  reconfigureNoteSet,
} from "../../src/editor/wikilink/note-set";
import { reconfigureVaultHeadings } from "../../src/editor/wikilink/vault-headings";
import type { VaultHeading } from "../../src/editor/wikilink/vault-headings";
import type { ResolverNote } from "../../src/notes/resolveWikilink";

beforeAll(() => {
  if (typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = () => {};
  }
});

const raf = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

const NOTES: readonly ResolverNote[] = [
  { noteUuid: "a", title: "Spec", folder: "Projects/" },
  { noteUuid: "b", title: "Diary", folder: null },
];

const VAULT_HEADINGS: readonly VaultHeading[] = [
  { noteUuid: "a", title: "Spec", folder: "Projects/", heading: "Goals", level: 2 },
  { noteUuid: "a", title: "Spec", folder: "Projects/", heading: "Setup", level: 2 },
  { noteUuid: "b", title: "Diary", folder: null, heading: "Morning", level: 1 },
];

// The current note's body — headings come from this live document. The leading
// blank `[[` cursor sits at the END, so `[[#` triggers parse cleanly after it.
const CURRENT_BODY = "# Intro\n\n## Setup steps\n\n## Deploy\n\nbody\n\n";

function mount(): { view: EditorView; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const doc = CURRENT_BODY;
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length, head: doc.length },
      extensions: [noteSetExtension(), wikilinkPickerExtension()],
    }),
    parent: host,
  });
  view.coordsAtPos = () => null;
  view.dispatch({ effects: reconfigureNoteSet(NOTES) });
  view.dispatch({ effects: reconfigureVaultHeadings(VAULT_HEADINGS) });
  return { view, host };
}

function typeText(view: EditorView, text: string): void {
  for (const ch of text) {
    const head = view.state.selection.main.head;
    view.dispatch({ changes: { from: head, insert: ch }, selection: { anchor: head + 1 } });
  }
}

const menu = (): HTMLElement | null => document.body.querySelector(".cm-wiki-picker");
const headingRows = (): HTMLElement[] =>
  Array.from(document.body.querySelectorAll<HTMLElement>('[data-testid="picker.heading-row"]'));
const vaultHeadingRows = (): HTMLElement[] =>
  Array.from(
    document.body.querySelectorAll<HTMLElement>('[data-testid="picker.vault-heading-row"]'),
  );

let teardowns: Array<() => void> = [];
afterEach(() => {
  for (const t of teardowns) t();
  teardowns = [];
  document.body.querySelectorAll(".cm-wiki-picker").forEach((e) => e.remove());
});

describe("`[[#` current-note heading autocomplete", () => {
  it("lists the current note's headings and tags rows current-scope", async () => {
    const { view } = mount();
    teardowns.push(() => view.destroy());
    typeText(view, "[[#");
    await raf();
    expect(menu()).not.toBeNull();
    const labels = headingRows().map(
      (r) => r.querySelector(".cm-wiki-picker-title")?.textContent,
    );
    expect(labels).toEqual(["Intro", "Setup steps", "Deploy"]);
    expect(headingRows()[0]?.getAttribute("data-heading-scope")).toBe("current");
    // It is NOT showing vault-heading rows in this mode.
    expect(vaultHeadingRows()).toHaveLength(0);
  });

  it("inserts the compact `[[#Heading]]` form on click", async () => {
    const { view } = mount();
    teardowns.push(() => view.destroy());
    typeText(view, "[[#setup");
    await raf();
    const row = headingRows().find(
      (r) => r.querySelector(".cm-wiki-picker-title")?.textContent === "Setup steps",
    )!;
    expect(row).toBeDefined();
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await raf();
    expect(view.state.doc.toString().endsWith("[[#Setup steps]]")).toBe(true);
    expect(menu()).toBeNull();
  });

  it("closes (no menu) on a no-match heading query — no create", async () => {
    const { view } = mount();
    teardowns.push(() => view.destroy());
    typeText(view, "[[#zzqqxx");
    await raf();
    expect(menu()).toBeNull();
  });
});

describe("`[[##` vault-wide heading autocomplete", () => {
  it("lists vault-wide headings and tags rows vault-scope", async () => {
    const { view } = mount();
    teardowns.push(() => view.destroy());
    typeText(view, "[[##");
    await raf();
    expect(menu()).not.toBeNull();
    const labels = vaultHeadingRows().map(
      (r) => r.querySelector(".cm-wiki-picker-title")?.textContent,
    );
    expect(labels).toEqual(expect.arrayContaining(["Goals", "Setup", "Morning"]));
    expect(vaultHeadingRows()[0]?.getAttribute("data-heading-scope")).toBe("vault");
    // The context line names the owning note.
    const goals = vaultHeadingRows().find(
      (r) => r.querySelector(".cm-wiki-picker-title")?.textContent === "Goals",
    )!;
    expect(goals.querySelector(".cm-wiki-picker-path")?.textContent).toBe("Spec");
  });

  it("inserts the full `[[vault/path.md#Heading|Display]]` path form on click", async () => {
    const { view } = mount();
    teardowns.push(() => view.destroy());
    typeText(view, "[[##goals");
    await raf();
    const row = vaultHeadingRows().find(
      (r) => r.querySelector(".cm-wiki-picker-title")?.textContent === "Goals",
    )!;
    expect(row).toBeDefined();
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await raf();
    expect(
      view.state.doc.toString().endsWith("[[Projects/Spec.md#Goals|Spec › Goals]]"),
    ).toBe(true);
    expect(menu()).toBeNull();
  });

  it("closes (no menu) on a no-match vault-heading query — no create", async () => {
    const { view } = mount();
    teardowns.push(() => view.destroy());
    typeText(view, "[[##zzqqxx");
    await raf();
    expect(menu()).toBeNull();
  });
});
