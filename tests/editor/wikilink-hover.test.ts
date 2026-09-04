// @vitest-environment jsdom
//
// Wikilink hover-tooltip source (`editor/wikilink/hover.ts`, wikilink.md §6.2).
// Drives the exported `wikilinkHoverTooltip` source against a live view with a
// parsed `[[…]]` chip + a resolver note-set, asserting:
//   - a hover inside (and at the edge of) a chip returns a tooltip anchored to
//     the full span, with the §6.2 resolution text in a `.cm-wikilink-hover` node
//   - a hover outside any wikilink returns null
//   - a MEDIA embed returns null (no tooltip)
//   - `enclosingWikilink` ancestor-walk finds / misses the Wikilink node
//
// This bypasses the live `mousemove` + 300ms timer + geometry (browser-only) by
// invoking the tooltip source directly — the resolution + DOM-build branches are
// what carry the logic.

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { assertParsed } from "./_parse-budget";
import { Wikilink } from "../../src/dialect/lezer/wikilink";
import {
  noteSetExtension,
  reconfigureNoteSet,
} from "../../src/editor/wikilink/note-set";
import {
  enclosingWikilink,
  wikilinkHoverTooltip,
} from "../../src/editor/wikilink/hover";
import type { ResolverNote } from "../../src/notes/resolveWikilink";

type Mounted = { view: EditorView; host: HTMLElement };

function mount(doc: string, notes: readonly ResolverNote[]): Mounted {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage, extensions: [Wikilink] }),
        noteSetExtension(),
      ],
    }),
    parent: host,
  });
  view.dispatch({ effects: reconfigureNoteSet(notes) });
  assertParsed(view);
  return { view, host };
}

function teardown(m: Mounted): void {
  m.view.destroy();
  m.host.remove();
}

const note = (
  noteUuid: string,
  title: string | null,
  folder: string | null,
): ResolverNote => ({ noteUuid, title, folder });

let m: Mounted | null = null;
afterEach(() => {
  if (m !== null) teardown(m);
  m = null;
});

describe("wikilinkHoverTooltip", () => {
  it("returns a tooltip anchored to the chip with the resolved §6.2 text", () => {
    const doc = "see [[Wednesday]] now";
    m = mount(doc, [note("a", "Wednesday", null)]);
    const pos = doc.indexOf("Wednesday"); // inside the chip
    const tip = wikilinkHoverTooltip(m.view, pos);
    expect(tip).not.toBeNull();
    // Anchored to the full `[[Wednesday]]` span.
    expect(tip!.pos).toBe(doc.indexOf("[["));
    expect(tip!.end).toBe(doc.indexOf("]]") + 2);
    // The create() DOM carries the resolution text.
    const { dom } = tip!.create(m.view);
    expect(dom.className).toBe("cm-wikilink-hover");
    expect(dom.textContent).toBe("Wednesday → Wednesday.md");
  });

  it("resolves a hover at the chip's leading edge (both-sides probe)", () => {
    const doc = "[[Wednesday]]";
    m = mount(doc, [note("a", "Wednesday", null)]);
    // Position 0 sits at the very start; the -1/+1 dual resolve must still find it.
    const tip = wikilinkHoverTooltip(m.view, 0);
    expect(tip).not.toBeNull();
    expect(tip!.pos).toBe(0);
  });

  it("shows '(no match)' for a broken link", () => {
    const doc = "[[Ghost]]";
    m = mount(doc, [note("a", "Other", null)]);
    const tip = wikilinkHoverTooltip(m.view, 3);
    expect(tip).not.toBeNull();
    expect(tip!.create(m.view).dom.textContent).toBe("(no match)");
  });

  it("returns null outside any wikilink", () => {
    const doc = "plain prose [[X]]";
    m = mount(doc, [note("a", "X", null)]);
    const tip = wikilinkHoverTooltip(m.view, 2); // inside "plain"
    expect(tip).toBeNull();
  });

  it("returns null for a MEDIA embed (no tooltip)", () => {
    const doc = "![[image.png]]";
    m = mount(doc, []);
    const tip = wikilinkHoverTooltip(m.view, 5);
    expect(tip).toBeNull();
  });
});

describe("enclosingWikilink", () => {
  it("finds the Wikilink ancestor from a node inside the chip", () => {
    const doc = "[[Target]]";
    m = mount(doc, []);
    const inner = syntaxTree(m.view.state).resolveInner(3, 1);
    expect(enclosingWikilink(inner)?.name).toBe("Wikilink");
  });

  it("returns null for a node not inside any wikilink", () => {
    const doc = "no link here";
    m = mount(doc, []);
    const inner = syntaxTree(m.view.state).resolveInner(3, 1);
    expect(enclosingWikilink(inner)).toBeNull();
  });

  it("returns null for a null node", () => {
    expect(enclosingWikilink(null)).toBeNull();
  });
});
