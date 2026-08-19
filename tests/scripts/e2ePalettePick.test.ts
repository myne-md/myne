// The palette helpers must re-assert their query, not type it once and wait.
//
// `runPaletteAction` and `searchAndOpenNote` both opened the palette, sent the
// query, and then waited up to 45 s for a row. `openPalette` itself already
// re-fires its chord until the input exists, for the reason `e2e/CLAUDE.md`
// records at length: a wait with nothing to re-fire spends its whole budget and
// reports a timeout. The two lines after it never got the same treatment, and
// both of their failure modes are permanent rather than slow:
//
//   1. WebKit's driver drops leading keystrokes while an input settles focus.
//      The password field and `typeIntoEditor` both guard this already; the
//      palette did not, so a truncated query stayed truncated forever.
//   2. The row list is derived from the input's `onChange`, so a note indexed a
//      moment after the query ran is not in the rendered rows and nothing
//      re-runs the search.
//
// `image-ocr-search` is the scenario that paid for both: its budget was raised
// to 120 s and bought nothing, which is exactly what "permanent, not slow"
// looks like from the outside.
//
// These run against a `Session` whose WIRE calls are stubbed and whose
// `waitUntil` is the real one, so the polling loop under test is the shipped
// loop rather than a re-implementation of it.

import { describe, expect, it } from "vitest";

import { palettePick, searchAndOpenNote } from "../../e2e/support/flows";
import { Session } from "../../e2e/support/webdriver";

const NOTE_ID = "01a00f65-f23e-7362-a9de-15994fa13aee";
const QUERY = "invoice";

interface Recorder {
  typed: string[];
  replaced: string[];
  clicked: number;
  /** How many poll iterations had run when the first re-type happened.
   *
   *  **Counting this is what makes the truncation test mean anything.** The
   *  helper has a SECOND path that also re-types: a rate-limited nudge that
   *  fires a few seconds in when the query is intact but no row matched. With
   *  only "was `replaceText` called" asserted, deleting the truncation guard
   *  outright leaves the test green, because the nudge arrives later and calls
   *  it anyway. Injected exactly that and watched it pass. The two arms are
   *  distinguishable only by WHEN they fire: the truncation guard acts on the
   *  first poll, the nudge cannot act before its window elapses. */
  pollsBeforeFirstReplace: number | null;
}

/**
 * A `Session` whose element lookups are answered from a tiny in-memory model:
 * the palette input holds `value`, and the target row appears only once `value`
 * equals `QUERY`. That is the whole causal chain the helper depends on, and it
 * is what makes a truncated first type observable.
 */
function fakeSession(opts: { firstTypeLands: string }): {
  session: Session;
  rec: Recorder;
} {
  const rec: Recorder = {
    typed: [],
    replaced: [],
    clicked: 0,
    pollsBeforeFirstReplace: null,
  };
  let value = "";
  let polls = 0;

  const input = {
    sendKeys: async (text: string) => {
      rec.typed.push(text);
      // The injected defect: the driver delivers only part of what was sent.
      value = opts.firstTypeLands;
    },
    property: async <T,>() => value as T,
    replaceText: async (text: string) => {
      if (rec.pollsBeforeFirstReplace === null) rec.pollsBeforeFirstReplace = polls;
      rec.replaced.push(text);
      value = text;
    },
    click: async () => {
      rec.clicked += 1;
    },
  };
  const row = {
    click: async () => {
      rec.clicked += 1;
    },
  };

  const session = new Session("http://127.0.0.1:0", "fake");
  // The palette is treated as already open, so these tests are about the two
  // lines AFTER `openPalette` rather than about the chord it fires.
  Object.assign(session, {
    byTestId: async () => input,
    byTestIdAll: async () => [input],
    // The row exists only while the input actually holds the full query. This
    // is also the poll counter: `findElements` is the first thing each
    // iteration does.
    findElements: async () => {
      polls += 1;
      return value === QUERY ? [row] : [];
    },
    execute: async () => true,
    send: async () => undefined,
  });
  return { session: session as unknown as Session, rec };
}

describe("palette query helpers", () => {
  it("re-types a query the driver truncated, instead of waiting on it", async () => {
    // "nvoice": the leading character was swallowed during the focus settle.
    // No row can ever match, and no budget rescues it.
    const { session, rec } = fakeSession({ firstTypeLands: "nvoice" });
    await searchAndOpenNote(session, QUERY, NOTE_ID);
    expect(rec.typed).toEqual([QUERY]);
    expect(rec.replaced, "the truncated value must be re-entered in full").toEqual([QUERY]);
    expect(
      rec.pollsBeforeFirstReplace,
      "the re-type must come from the TRUNCATION arm (first poll), not from the " +
        "rate-limited nudge seconds later — the two are otherwise indistinguishable " +
        "and deleting the truncation guard leaves this test green",
    ).toBe(1);
    expect(rec.clicked).toBe(1);
  });

  it("does not re-type when the query landed intact", async () => {
    // The nudge is rate-limited on purpose: retyping is BACKSPACE-per-character
    // plus the text, so doing it every poll would be its own load on the
    // surface under test.
    const { session, rec } = fakeSession({ firstTypeLands: QUERY });
    await searchAndOpenNote(session, QUERY, NOTE_ID);
    expect(rec.typed).toEqual([QUERY]);
    expect(rec.replaced).toEqual([]);
    expect(rec.clicked).toBe(1);
  });

  it("names what the input actually held when it gives up", async () => {
    // A row that never appears is a real outcome, and the message has to say
    // which of the two causes it was. Here the query is intact, so the report
    // must be the re-run arm rather than the truncation arm.
    const session = new Session("http://127.0.0.1:0", "fake");
    Object.assign(session, {
      byTestId: async () => ({ sendKeys: async () => undefined }),
      byTestIdAll: async () => [
        { property: async () => QUERY, replaceText: async () => undefined },
      ],
      findElements: async () => [],
      execute: async () => true,
      send: async () => undefined,
    });
    // Short budget: the give-up MESSAGE is under test, not the 45 s a real
    // scenario spends earning it.
    await expect(
      palettePick(session as unknown as Session, QUERY, "[data-testid]", "a row", {
        timeoutMs: 4_000,
      }),
    ).rejects.toThrow(/last poll: the query landed but no row matched/);
  });
});
