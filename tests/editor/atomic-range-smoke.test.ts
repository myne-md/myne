// @vitest-environment jsdom
//
// jsdom keystroke smoke test for the wikilink chip — one regression detector
// that the keymap → command pipeline fires `deleteCharBackward` on a real
// Backspace KeyboardEvent.
//
// Per grill 2026-05-16 Q6 (S2+E3) — this is the single integration test
// that complements the 8 state-machine tests in atomic-range.test.ts.
// Its job is to surface keymap-wiring breakage in future CM6 major bumps;
// it does NOT assert the entire DOM rendering, only that the doc changes
// after a synthetic keystroke.
//
// MYND-299 cursor-reveal update: a link on the FOCUSED caret's line lifts to its
// raw, editable `[[…]]` text and is NOT atomic (so arrow keys can enter it to add
// a `#heading` anchor — chip-widget.ts `isWikilinkRevealed`). So a caret resting
// right after a chip, on its line, edits the now-raw link char-by-char rather
// than atomic-deleting the whole chip. (The static atomic set — caret off the
// link's line — is still covered by atomic-range.test.ts via `wikilinkAtomicRanges`.)

import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { Wikilink } from "../../src/dialect/lezer/wikilink";
import { wikilinkChipExtensions } from "../../src/editor/wikilink";

describe("Wikilink chip atomic-range — keystroke smoke", () => {
  let view: EditorView | null = null;
  let host: HTMLElement | null = null;

  afterEach(() => {
    if (view !== null) view.destroy();
    if (host !== null) host.remove();
    view = null;
    host = null;
  });

  it("synthetic Backspace right-of-chip edits the cursor-revealed link (char delete)", () => {
    const doc = "before [[Note]] after";
    const rightOfChip = doc.indexOf("]]") + 2;

    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: rightOfChip, head: rightOfChip },
        extensions: [
          markdown({
            base: markdownLanguage,
            extensions: [Wikilink],
          }),
          wikilinkChipExtensions(),
          keymap.of(defaultKeymap),
        ],
      }),
      parent: host,
    });

    // Focus so the keymap fires.
    view.focus();
    const event = new KeyboardEvent("keydown", {
      key: "Backspace",
      code: "Backspace",
      bubbles: true,
      cancelable: true,
    });
    view.contentDOM.dispatchEvent(event);

    // The caret is on the link's line → the chip is revealed (raw, non-atomic),
    // so Backspace deletes ONE char (the trailing `]`) — edit mode, not an atomic
    // whole-chip delete. Confirms the keymap → deleteCharBackward pipeline fired.
    expect(view.state.doc.toString()).toBe("before [[Note] after");
  });
});
