// @vitest-environment jsdom
//
// An embed takes its own row (myne-md/myne#604).
//
// Reported as three symptoms of one shape: an image inside a checklist item
// wrecks the row it is on, typing before or after it scrolls the view and
// flashes, and there is no way to drag it smaller. All three come from the embed
// being an INLINE replace decoration, sharing a line box with the prose around
// it.
//
// The browser is what proved it, because none of this is visible without layout.
// Measured in Chromium against the real widget: typing one character before a
// mid-line embed gives its frame a NEW DOM identity, whatever `eq()` says, while
// an embed alone on its own line keeps its DOM untouched; and each rebuild
// collapsed the frame from 240px to 31px and back, which is the flash and the
// height jump. What this file pins is the decidable half of the fix, so a
// regression fails here rather than in a container nobody runs by hand.

import { afterEach, describe, expect, it } from "vitest";
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Wikilink } from "../../src/dialect/lezer/wikilink";
import {
  type CatalogRow,
  attachmentCatalogExtension,
  setCatalogLoader,
} from "../../src/editor/attachments/catalog";
import {
  attachmentEmbedDecorations,
  embedIsAlone,
} from "../../src/editor/decorations/attachment-embed";
import { ownLineInsertion } from "../../src/editor/attachments/insert";

const ID = "a".repeat(64);
const EMBED = `![[att:${ID}|shot.png]]`;
const ROW: CatalogRow = {
  id: ID,
  contentType: "image/png",
  filename: "shot.png",
  size: 10,
};

let mounted: { view: EditorView; host: HTMLElement } | null = null;
afterEach(() => {
  mounted?.view.destroy();
  mounted?.host.remove();
  mounted = null;
});

async function mount(doc: string): Promise<{ view: EditorView; host: HTMLElement }> {
  const restore = setCatalogLoader(async () => new Map([[ID, ROW]]));
  const host = document.createElement("div");
  document.body.appendChild(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage, extensions: [Wikilink] }),
        ...attachmentCatalogExtension(),
        ...attachmentEmbedDecorations(),
      ],
    }),
    parent: host,
  });
  await Promise.resolve();
  await Promise.resolve();
  view.requestMeasure();
  restore();
  return { view, host };
}

/** Where a rendered frame sits: inside a `.cm-line` means inline, outside means
 *  CodeMirror drew it as a block. This is the property, and it is the one an
 *  assertion on the decoration set alone would miss. */
function placement(host: HTMLElement): "block" | "inline" | "absent" {
  const frame = host.querySelector(".cm-attachment-frame");
  if (frame === null) return "absent";
  return frame.closest(".cm-line") === null ? "block" : "inline";
}

describe("an embed alone on its line is drawn as a block", () => {
  it("draws a block when the line holds nothing else", async () => {
    mounted = await mount(EMBED);
    expect(placement(mounted.host)).toBe("block");
  });

  it("draws a block when the line holds nothing else BUT indent", async () => {
    // The shape a screenshot pasted under a task item takes. It is what the
    // report was about, so it is the case that must not regress to inline.
    mounted = await mount(`- [ ] a task\n    ${EMBED}\n`);
    expect(placement(mounted.host)).toBe("block");
  });

  it("stays INLINE when prose shares the line", async () => {
    // Not a compromise: `block: true` is illegal on a decoration that does not
    // cover whole lines, so this is the only form CodeMirror will accept here.
    // The aspect-ratio reservation in the widget is what keeps this case from
    // flashing.
    mounted = await mount(`- [ ] text before ${EMBED} and after`);
    expect(placement(mounted.host)).toBe("inline");
  });

  it("stays INLINE when a list marker shares the line", async () => {
    // `- ![[…]]`. A block decoration would have to cover the whole line, which
    // would swallow the marker and un-list the item.
    mounted = await mount(`- ${EMBED}`);
    expect(placement(mounted.host)).toBe("inline");
  });

  it("draws both forms in one document, one frame each", async () => {
    // Two providers over one document: the block half is a StateField because
    // CodeMirror refuses a block decoration from a plugin, and the inline half
    // stays a ViewPlugin so it can scope itself to the viewport.
    //
    // This does NOT prove the inline half skips what the block half draws, and
    // it was written claiming to. Removing that skip leaves this green: the
    // block decoration replaces the whole line, so an inline widget inside it is
    // built and then never rendered. The skip is a build-cost decision (one
    // widget per embed per keystroke that nothing will paint), not a correctness
    // one, and this file should not imply otherwise.
    mounted = await mount(`${EMBED}\n\ntext ${EMBED} text\n`);
    expect(mounted.host.querySelectorAll(".cm-attachment-frame")).toHaveLength(2);
  });

  it("still becomes a block when typing COMPLETES the embed", async () => {
    // The block field skips its whole-document walk for a transaction that
    // provably cannot change the set: nothing drawn as a block, a pure
    // insertion, and no `[`, `]` or newline in the inserted text. The last
    // clause is the one under test. Typing the final `]` of `![[att:…]]` is an
    // insertion into a document with no block embeds, and it creates one.
    mounted = await mount(`![[att:${ID}|shot.png]`);
    expect(placement(mounted.host)).toBe("absent");
    mounted.view.dispatch({
      changes: { from: mounted.view.state.doc.length, insert: "]" },
    });
    await Promise.resolve();
    expect(placement(mounted.host)).toBe("block");
  });

  it("still becomes a block when a NEWLINE leaves the embed alone on its line", async () => {
    // The other half of the same clause. The embed shares its line with prose,
    // so it is inline; inserting a newline in front of it splits the line and
    // leaves it alone on the second half, which is a block. Nothing was deleted
    // and no bracket was typed, so only the newline test stops the skip here.
    mounted = await mount(`text ${EMBED}`);
    expect(placement(mounted.host)).toBe("inline");
    mounted.view.dispatch({ changes: { from: 5, insert: "\n" } });
    await Promise.resolve();
    expect(placement(mounted.host)).toBe("block");
  });

  it("does not rewrite a single byte of the note", async () => {
    // The placement rule reads the source; it never edits it
    // (`markdown-dialect.md` §6 C1).
    const doc = `- [ ] text before ${EMBED} and after\n\n${EMBED}\n`;
    mounted = await mount(doc);
    expect(mounted.view.state.doc.toString()).toBe(doc);
  });
});

describe("embedIsAlone", () => {
  const state = (doc: string) => EditorState.create({ doc });

  it("accepts an embed with only whitespace around it", () => {
    const s = state(`   ${EMBED}  `);
    expect(embedIsAlone(s, 3, 3 + EMBED.length)).toBe(true);
  });

  it("rejects an embed with a list marker before it", () => {
    const s = state(`- ${EMBED}`);
    expect(embedIsAlone(s, 2, 2 + EMBED.length)).toBe(false);
  });

  it("rejects an embed with prose after it", () => {
    const s = state(`${EMBED} caption`);
    expect(embedIsAlone(s, 0, EMBED.length)).toBe(false);
  });

  it("rejects a range that runs past the end of its line", () => {
    const s = state(`${EMBED}\nnext`);
    expect(embedIsAlone(s, 0, EMBED.length + 3)).toBe(false);
  });
});

describe("ownLineInsertion", () => {
  const at = (doc: string, pos: number) => ownLineInsertion(Text.of(doc.split("\n")), pos, "X");

  it("adds nothing when the line is empty", () => {
    expect(at("a\n\nb", 2)).toEqual({ insert: "X", anchor: 3 });
  });

  it("keeps the indent rather than trimming it, and adds no newline", () => {
    // A screenshot pasted at the indent under a task item stays at that indent,
    // which `embedIsAlone` accepts because it compares against the trimmed line.
    expect(at("- [ ] task\n    ", 15)).toEqual({ insert: "X", anchor: 16 });
  });

  it("breaks the line when there is text before the cursor", () => {
    expect(at("hello", 5)).toEqual({ insert: "\nX", anchor: 7 });
  });

  it("breaks the line on BOTH sides when the cursor is mid-sentence", () => {
    expect(at("hello world", 5)).toEqual({ insert: "\nX\n", anchor: 7 });
  });

  it("adds no trailing newline when only whitespace follows", () => {
    expect(at("hello   ", 5)).toEqual({ insert: "\nX", anchor: 7 });
  });
  it("protects the whole replaced span, indent included, on an indented block embed", async () => {
    // The block decoration replaces `[line.from, line.to)` while the atomic
    // range used to cover only `[node.from, node.to)`, so the two leading
    // spaces of `  ![[att:…]]` sat inside a replaced, unrendered span that
    // nothing protected: a caret could land at an offset with no rendered
    // coordinates. `embedIsAlone` accepts an indented line on purpose, so this
    // is the case that reaches it rather than an invented one.
    const m = await mount(`  ![[att:${ID}|photo.png]]\n`);
    const atomic = m.view.state.facet(EditorView.atomicRanges).map((f) => f(m.view));
    const line = m.view.state.doc.line(1);
    let covered = false;
    for (const set of atomic) {
      set.between(line.from, line.to, (from, to) => {
        if (from <= line.from && to >= line.to) covered = true;
      });
    }
    expect(covered).toBe(true);
    m.host.remove();
  });

  it("promotes a plain wikilink to a block embed when `!` is typed in front of it", async () => {
    // The skip's three conditions read as a proof that the set cannot have
    // moved, and this is the way it can that they missed: the line already held
    // a complete `[[att:...]]` alone on it, so the block set was empty, the
    // change is insert-only, and `!` is none of the characters the class
    // listed. The embed became valid and nothing rebuilt, so it rendered as raw
    // source until an unrelated edit happened to force one.
    const plain = EMBED.startsWith("!") ? EMBED.slice(1) : EMBED;
    mounted = await mount(`${plain}\n`);
    expect(placement(mounted.host), "a plain wikilink is no embed").toBe("absent");
    mounted.view.dispatch({ changes: { from: 0, insert: "!" } });
    await Promise.resolve();
    await Promise.resolve();
    mounted.view.requestMeasure();
    expect(placement(mounted.host), "typing `!` should promote it").toBe("block");
  });
});

// What the wrapper exists for is a browser measurement, so the numbers live in
// the issue and in `theme.ts`: with the rhythm as a MARGIN on the card, five
// block embeds made the painted content 37px taller than CodeMirror's height map,
// every coordinate below them resolved one to three rows low, and a click landed
// that far from the pointer. These pin the decidable half: that the box
// CodeMirror measures is the one carrying the spacing.
describe("a block embed's spacing lives inside the measured box", () => {
  it("wraps the card in .cm-attachment-block rather than placing it in .cm-content", async () => {
    mounted = await mount(EMBED);
    const frame = mounted.host.querySelector(".cm-attachment-frame") as HTMLElement;
    expect(frame).not.toBeNull();
    // A wrapper is the whole fix: `getBoundingClientRect()` excludes margins,
    // so a margin on the card is height CodeMirror never counts. Padding on a
    // parent it does measure is counted. A card that IS the widget's DOM has
    // nowhere to put that padding without growing its own border.
    expect(frame.parentElement?.className).toBe("cm-attachment-block");
  });

  it("leaves the INLINE form unwrapped", async () => {
    // An inline widget's margin is inside its line's box, which CodeMirror does
    // measure, so wrapping it would add a level for nothing and could break the
    // line box it sits in.
    mounted = await mount(`- [ ] text before ${EMBED} and after`);
    const frame = mounted.host.querySelector(".cm-attachment-frame") as HTMLElement;
    expect(frame).not.toBeNull();
    expect(frame.closest(".cm-attachment-block")).toBeNull();
  });
});
