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
import { cursorCharLeft, cursorCharRight, defaultKeymap } from "@codemirror/commands";
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

  /** Mount `doc` with the caret at `caret`, wired for chip + keymap behaviour. */
  function mountAt(doc: string, caret: number): EditorView {
    host = document.createElement("div");
    document.body.appendChild(host);
    view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: caret, head: caret },
        extensions: [
          markdown({ base: markdownLanguage, extensions: [Wikilink] }),
          wikilinkChipExtensions(),
          keymap.of(defaultKeymap),
        ],
      }),
      parent: host,
    });
    view.focus(); // so the keymap fires and reveal is not focus-suppressed
    return view;
  }

  it("synthetic Backspace right-of-chip deletes the atomic chip", () => {
    const doc = "before [[Note]] after";
    const rightOfChip = doc.indexOf("]]") + 2;
    view = mountAt(doc, rightOfChip);
    const event = new KeyboardEvent("keydown", {
      key: "Backspace",
      code: "Backspace",
      bubbles: true,
      cancelable: true,
    });
    view.contentDOM.dispatchEvent(event);

    // myne#659 changed this, deliberately, and the trade is worth stating.
    //
    // Reveal used to be LINE-scoped, so a caret anywhere on the row lifted the
    // chip to raw text and Backspace deleted one character, leaving a broken
    // `[[Note]`. It is now half-open per range: `from` reveals, `to` does not.
    //
    // `to` is where the caret sits the instant you finish typing `]]`, and
    // revealing there was the reason a link you had just written never rendered
    //. There was no moment at which the editor confirmed a link existed. That
    // was the half of #659 that bit hardest, so it wins the position.
    //
    // What that costs is exactly this keystroke: Backspace immediately after a
    // chip now deletes the whole chip, because it is still atomic there. That
    // is the better answer for an atomic range anyway, the old one left the
    // document holding malformed `[[Note]`, but it IS a behaviour change, and
    // asserting the new bytes rather than deleting the test is how it stays
    // visible. Editing from the right still works: one more Left press parks the
    // caret at `from`, which reveals.
    expect(view.state.doc.toString()).toBe("before  after");
  });

  it("a caret at the chip's START reveals it, so Backspace edits char-wise", () => {
    // The other side of the half-open rule, and the non-vacuity partner of the
    // case above: if `from` stopped revealing too, the chip would be permanently
    // uneditable by keyboard and the test above would still pass.
    const doc = "before [[Note]] after";
    const chipFrom = doc.indexOf("[[");

    // Drive it through the path atomicity actually governs. A programmatic
    // `dispatch` of a selection is NEVER adjusted by `atomicRanges`, CM6
    // consults them in cursor MOTION, the pointer path and the selection layer,
    // never in a transaction filter, so asserting a dispatched caret position
    // proves nothing. Measured: the same assertion passes on an unfocused view,
    // where reveal is off and the chip IS atomic.
    view = mountAt(doc, doc.indexOf("]]") + 2);
    cursorCharLeft(view);
    // Atomic from the right (`to` does not reveal), so the motion skips the
    // whole chip and parks at `from`, which DOES reveal, dropping atomicity.
    expect(view.state.selection.main.head).toBe(chipFrom);
    cursorCharRight(view);
    // Now non-atomic, so one press moves one character INTO the raw text
    // rather than jumping the chip again. This is the half that keeps a
    // wikilink keyboard-editable, and it is what would break if `from` stopped
    // revealing.
    expect(view.state.selection.main.head).toBe(chipFrom + 1);
  });
});
