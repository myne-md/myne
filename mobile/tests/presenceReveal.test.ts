// The roster row's jump target (myne-md/myne#849 task 8).
//
// A presence frame carries a character OFFSET and the shared editor's `revealLine`
// takes a LINE plus that line's text, so the conversion is the thing to pin. It is
// also the thing that can be wrong in a way nobody sees: an off-by-one reveals a
// neighbouring line, and an unclamped offset scrolls to a line the document does not
// have.
//
// What this file CANNOT reach, stated rather than implied: the editor actually
// scrolling. `revealLine` is the shared engine's, applied once per nonce for the note
// it holds, so "the view moves" is a device observation, not a claim of this suite.

import { describe, expect, it } from "vitest";
import { presenceRevealFor } from "@myne/presence-jump";

const NOTE = "n";

describe("offset to line", () => {
  it("derives the line the offset sits on, 0-based", () => {
    const text = "one\ntwo\nthree";
    // `one` occupies 0-2, the newline 3, `t` 4 and `w` 5. So offset 5 is ON the
    // "w", and the prefix the editor gets back is "t": the line so far, not the
    // whole line, which is what the shared editor's reveal matches against.
    // `text` is the WHOLE line, trimmed, because that is what the shared editor
    // compares it to; the first version emitted the prefix up to the caret and made
    // every mid-line jump a silent no-op (myne-md/myne#849 review).
    expect(presenceRevealFor(NOTE, text, 5, 1)).toEqual({
      noteId: NOTE,
      line: 1,
      text: "two",
      nonce: 1,
    });
  });

  it("treats an offset at the very start as line 0", () => {
    expect(presenceRevealFor(NOTE, "a\nb", 0, 2).line).toBe(0);
  });

  it("treats an offset ON the newline as the line it ends", () => {
    // Offset 3 is the "\n" after "one": the caret is still on line 0.
    expect(presenceRevealFor(NOTE, "one\ntwo", 3, 3).line).toBe(0);
  });

  it("returns the WHOLE line, not the prefix up to the caret", () => {
    // The value the consumer needs: `doc.line(n).text.trim() === target`.
    const text = "alpha\nbeta\ngamma";
    const reveal = presenceRevealFor(NOTE, text, text.indexOf("gam") + 1, 4);
    expect(reveal.line).toBe(2);
    expect(reveal.text).toBe("gamma");
  });

  it("carries the note id it was given, untouched", () => {
    expect(presenceRevealFor("note-x", "", 0, 5).noteId).toBe("note-x");
  });

  it("carries the nonce it was given, so a repeat jump re-acts", () => {
    const a = presenceRevealFor(NOTE, "x", 0, 100);
    const b = presenceRevealFor(NOTE, "x", 0, 200);
    expect(a.nonce).toBe(100);
    expect(b.nonce).toBe(200);
  });
});

describe("clamping, because the offset describes the PEER's document", () => {
  it("clamps an offset past our end to the last line", () => {
    const text = "short\nnote";
    const reveal = presenceRevealFor(NOTE, text, 9999, 1);
    // Line 1, not line 1 of a document 9999 characters long.
    expect(reveal.line).toBe(1);
    expect(reveal.text).toBe("note");
  });

  it("clamps a negative offset to the start", () => {
    // The distinguishing input is a negative offset STRICTLY INSIDE (-length, 0):
    // there `text.slice(0, offset)` keeps `length + offset` characters, while the
    // clamp gives "". The first version used -5 on a 3-character string, where
    // `slice`'s own end-relative rule already yields "", so the arm could not tell
    // the clamp from no clamp and stayed green under injection (myne-md/myne#849
    // review).
    // A MULTI-LINE document, because that is the only place the clamp is
    // load-bearing now that `text` is taken from the whole document: unclamped,
    // `slice(0, -1)` keeps everything but the last character, so the prefix still
    // contains the newline and the derived line is 1. Clamped, it is 0.
    expect(presenceRevealFor(NOTE, "a\nbcdef", -1, 1)).toMatchObject({ line: 0, text: "a" });
    expect(presenceRevealFor(NOTE, "a\nb", -5, 1)).toMatchObject({ line: 0, text: "a" });
  });

  it("handles a fractional offset without producing a fractional line", () => {
    // This case used to be titled "truncates a fractional offset rather than
    // trusting it", and injection proved the title was describing something the
    // code does not rely on: `String.prototype.slice` truncates its own index, so
    // no input could fail with a `Math.trunc` present or absent (myne-md/myne#849
    // review). The redundant call is gone and this asserts the property that
    // remains: a fractional offset yields an integer line and a string prefix.
    const reveal = presenceRevealFor(NOTE, "one\ntwo", 3.9, 1);
    expect(Number.isInteger(reveal.line)).toBe(true);
    expect(reveal.line).toBe(0);
    expect(reveal.text).toBe("one");
  });

  it("handles an empty document without producing a negative line", () => {
    expect(presenceRevealFor(NOTE, "", 0, 1)).toMatchObject({ line: 0, text: "" });
  });
});
