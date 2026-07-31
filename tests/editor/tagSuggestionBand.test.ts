// @vitest-environment jsdom
//
// The inline tag-suggestion band (on-device-tag-suggestion MYND-651 task 7).
//
// The properties worth pinning are the ones that are invisible when broken: the
// band is ABSENT (not empty) on an idle note so nothing shifts, it anchors on
// the frontmatter/BODY boundary rather than inside the frontmatter block, the
// bytes are never touched, a chip's tag survives a re-render as a live
// attribute rather than a captured closure, and both halves of a chip are
// reachable from the keyboard.

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { parser } from "../../src/dialect/lezer/parser";
import { readingModeFacet } from "@myne/editor/decorations/cursor-aware";
import { frontmatterDecorations } from "@myne/editor/decorations/frontmatter";
import {
  buildTagSuggestionBand,
  setTagSuggestions,
  TAG_SUGGESTION_ACCEPT_EVENT,
  TAG_SUGGESTION_DISMISS_EVENT,
  tagSuggestionBandAnchor,
  tagSuggestionBandDecorations,
  type TagSuggestionChip,
  type TagSuggestionEventDetail,
} from "@myne/editor/decorations/tag-suggestion-band";

const FM_DOC = ["---", "title: Notes", "---", "", "Body text here.", ""].join("\n");
const BARE_DOC = "Just a body, no frontmatter.\n";

const CHIPS: readonly TagSuggestionChip[] = [
  { tag: "rust", isNew: false },
  { tag: "compilers", isNew: true },
];

function mount(
  doc = FM_DOC,
  extra: readonly unknown[] = [],
): { view: EditorView; host: HTMLElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ base: { parser } as never }),
        tagSuggestionBandDecorations(),
        ...(extra as never[]),
      ],
    }),
  });
  return { view, host };
}

function teardown(view: EditorView, host: HTMLElement): void {
  view.destroy();
  host.remove();
}

const q = (host: HTMLElement, id: string): HTMLElement | null =>
  host.querySelector(`[data-testid="${id}"]`);
const all = (host: HTMLElement, id: string): HTMLElement[] =>
  [...host.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];

function push(view: EditorView, chips: readonly TagSuggestionChip[]): void {
  view.dispatch({ effects: setTagSuggestions.of(chips) });
}

/** Collect one band event, returning the detail it carried (or null). */
function capture(
  view: EditorView,
  type: string,
  act: () => void,
): TagSuggestionEventDetail | null {
  let seen: TagSuggestionEventDetail | null = null;
  const handler = (e: Event): void => {
    seen = (e as CustomEvent<TagSuggestionEventDetail>).detail;
  };
  view.dom.addEventListener(type, handler);
  act();
  view.dom.removeEventListener(type, handler);
  return seen;
}

describe("absent when idle", () => {
  it("renders no band at all before anything is pushed", () => {
    // Not an empty band: an always-mounted strip would shift every note in the
    // vault for a feature that is off by default.
    const { view, host } = mount();
    expect(q(host, "editor.tag-suggestion-band")).toBeNull();
    expect(buildTagSuggestionBand(view.state).size).toBe(0);
    teardown(view, host);
  });

  it("an empty push clears a band that was showing", () => {
    const { view, host } = mount();
    push(view, CHIPS);
    expect(q(host, "editor.tag-suggestion-band")).not.toBeNull();
    push(view, []);
    expect(q(host, "editor.tag-suggestion-band")).toBeNull();
    teardown(view, host);
  });

  it("renders nothing in reading mode — a read-only view cannot accept", () => {
    const { view, host } = mount(FM_DOC, [readingModeFacet.of(true)]);
    push(view, CHIPS);
    expect(q(host, "editor.tag-suggestion-band")).toBeNull();
    teardown(view, host);
  });
});

describe("anchor", () => {
  it("sits on the frontmatter/body boundary, not inside the block", () => {
    // `bodyStart`/`bodyEnd` name the YAML block's own interior; the boundary
    // between frontmatter and the NOTE body is `blockEnd`.
    const { view, host } = mount();
    const at = tagSuggestionBandAnchor(view.state);
    expect(at).toBe(FM_DOC.indexOf("---\n\n") + "---\n".length);
    expect(view.state.doc.sliceString(0, at)).toBe("---\ntitle: Notes\n---\n");
    teardown(view, host);
  });

  it("renders alongside the frontmatter Properties widget it anchors against", () => {
    // The band alone cannot show this. `frontmatter.ts` REPLACES
    // `[blockStart, blockEnd]` with a block widget, and a block decoration at
    // `blockEnd` with a negative side sorts inside that range — CodeMirror then
    // drops the band silently, on every note that has frontmatter (i.e. every
    // note the app creates). Composing the two layers is the only way to see it.
    const { view, host } = mount(FM_DOC, [frontmatterDecorations()]);
    push(view, CHIPS);
    expect(q(host, "editor.tag-suggestion-band")).not.toBeNull();
    expect(all(host, "editor.tag-suggestion-chip").length).toBe(CHIPS.length);
    // …and it really is on the far side of the frontmatter block.
    const band = q(host, "editor.tag-suggestion-band")!;
    const properties = host.querySelector(".cm-fm-properties")!;
    expect(
      properties.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    teardown(view, host);
  });

  it("sits at the top of a note that has no frontmatter", () => {
    const { view, host } = mount(BARE_DOC);
    expect(tagSuggestionBandAnchor(view.state)).toBe(0);
    // …and a block widget at offset 0 really renders (CodeMirror rejects a
    // block decoration that lands mid-line).
    push(view, CHIPS);
    expect(q(host, "editor.tag-suggestion-band")).not.toBeNull();
    expect(view.state.doc.toString()).toBe(BARE_DOC);
    teardown(view, host);
  });

  it("follows the boundary when the frontmatter grows", () => {
    const { view, host } = mount();
    const before = tagSuggestionBandAnchor(view.state);
    view.dispatch({ changes: { from: FM_DOC.indexOf("title:"), insert: "tags: [a]\n" } });
    expect(tagSuggestionBandAnchor(view.state)).toBe(before + "tags: [a]\n".length);
    teardown(view, host);
  });

  it("places exactly one band, whatever the chip count", () => {
    const { view, host } = mount();
    push(view, CHIPS);
    expect(buildTagSuggestionBand(view.state).size).toBe(1);
    expect(all(host, "editor.tag-suggestion-band")).toHaveLength(1);
    teardown(view, host);
  });
});

describe("chips", () => {
  it("renders one chip per suggestion, in the order it was handed", () => {
    const { view, host } = mount();
    push(view, CHIPS);
    expect(all(host, "editor.tag-suggestion-chip").map((n) => n.textContent)).toEqual([
      "rust",
      "+ compilers",
    ]);
    teardown(view, host);
  });

  it("marks a new tag distinctly from existing vocabulary", () => {
    // Solid vs dashed is the whole visual vocabulary: accepting a dashed chip
    // grows the vault's tag set.
    const { view, host } = mount();
    push(view, CHIPS);
    const chips = all(host, "editor.tag-suggestion-chip");
    expect(chips.map((n) => n.getAttribute("data-is-new"))).toEqual(["false", "true"]);
    expect(chips[0]!.parentElement!.className).not.toContain("cm-tag-suggestion-chip-new");
    expect(chips[1]!.parentElement!.className).toContain("cm-tag-suggestion-chip-new");
    teardown(view, host);
  });

  it("carries the count the band is showing", () => {
    const { view, host } = mount();
    push(view, CHIPS);
    expect(q(host, "editor.tag-suggestion-band")!.getAttribute("data-suggestion-count")).toBe(
      "2",
    );
    teardown(view, host);
  });

  it("renders a tag as TEXT, never as markup", () => {
    // The tag came out of a model reading the user's own (untrusted) note.
    const { view, host } = mount();
    push(view, [{ tag: "<img src=x onerror=1>", isNew: true }]);
    expect(host.querySelector("img")).toBeNull();
    expect(q(host, "editor.tag-suggestion-chip")?.textContent).toBe("+ <img src=x onerror=1>");
    teardown(view, host);
  });

  it("gives every chip an accessible name naming the tag", () => {
    const { view, host } = mount();
    push(view, CHIPS);
    expect(q(host, "editor.tag-suggestion-chip")!.getAttribute("aria-label")).toContain("rust");
    expect(q(host, "editor.tag-suggestion-dismiss")!.getAttribute("aria-label")).toContain(
      "rust",
    );
    teardown(view, host);
  });
});

describe("activation", () => {
  it("a chip click asks the host to accept that tag", () => {
    const { view, host } = mount();
    push(view, CHIPS);
    const chip = all(host, "editor.tag-suggestion-chip")[1]!;
    const detail = capture(view, TAG_SUGGESTION_ACCEPT_EVENT, () => {
      chip.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(detail).toEqual({ tag: "compilers" });
    teardown(view, host);
  });

  it("a × click asks the host to dismiss that tag, not to accept it", () => {
    const { view, host } = mount();
    push(view, CHIPS);
    const x = all(host, "editor.tag-suggestion-dismiss")[0]!;
    const accepted = capture(view, TAG_SUGGESTION_ACCEPT_EVENT, () => {
      const detail = capture(view, TAG_SUGGESTION_DISMISS_EVENT, () => {
        x.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      });
      expect(detail).toEqual({ tag: "rust" });
    });
    expect(accepted).toBeNull();
    teardown(view, host);
  });

  it("is reachable from the keyboard", () => {
    // The band never opens into raw text, so a pointer is otherwise the only
    // way in.
    const { view, host } = mount();
    push(view, CHIPS);
    const chip = all(host, "editor.tag-suggestion-chip")[0]!;
    const detail = capture(view, TAG_SUGGESTION_ACCEPT_EVENT, () => {
      chip.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(detail).toEqual({ tag: "rust" });
    teardown(view, host);
  });

  it("ignores a click that missed both halves of a chip", () => {
    const { view, host } = mount();
    push(view, CHIPS);
    const label = q(host, "editor.tag-suggestion-label")!;
    const detail = capture(view, TAG_SUGGESTION_ACCEPT_EVENT, () => {
      label.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(detail).toBeNull();
    teardown(view, host);
  });

  it("accepts the CURRENT tag after the band was re-rendered", () => {
    // The tag rides a data attribute the handler re-reads, not a closure — so a
    // reused DOM node cannot accept a stale tag (the task-chip lesson).
    const { view, host } = mount();
    push(view, CHIPS);
    push(view, [{ tag: "linkers", isNew: true }]);
    const chip = all(host, "editor.tag-suggestion-chip")[0]!;
    const detail = capture(view, TAG_SUGGESTION_ACCEPT_EVENT, () => {
      chip.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(detail).toEqual({ tag: "linkers" });
    teardown(view, host);
  });
});

describe("byte stability", () => {
  it("showing, changing and clearing the band never touches the document", () => {
    const { view, host } = mount();
    push(view, CHIPS);
    push(view, [{ tag: "linkers", isNew: true }]);
    push(view, []);
    expect(view.state.doc.toString()).toBe(FM_DOC);
    teardown(view, host);
  });

  it("survives an edit — it is not cleared by typing", () => {
    // The trigger re-arms on every edit; a band that vanished on the first
    // keystroke would flicker through every typing burst.
    const { view, host } = mount();
    push(view, CHIPS);
    view.dispatch({ changes: { from: view.state.doc.length, insert: "more" } });
    expect(all(host, "editor.tag-suggestion-chip")).toHaveLength(2);
    teardown(view, host);
  });
});
