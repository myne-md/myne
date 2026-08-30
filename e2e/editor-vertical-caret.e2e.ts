// ArrowUp / ArrowDown keep the column, on a real layout engine (myne-md/myne#631).
//
//   vc1  Down from a long line through a SHORT one and out the other side
//        returns to the original column, and never lands on a line's end.
//
// This lane exists because the defect cannot be reproduced anywhere else. The
// mechanism is CodeMirror's `cursorByLine` falling through to
// `moveToLineBoundary`, a coordinate probe against `view.dom`'s right edge, in
// an app whose editor sits inside a centred max-width column, and its other
// arm mis-deriving the goal when `coordsAtPos` returns null. Both need a layout
// engine. `tests/editor/lineVertical.test.ts` pins the column arithmetic against
// a stubbed view, which is the most jsdom can say, and the module's own header
// says so.
//
// THE HEADING IS THE POINT, not decoration. The reported case walks down from a
// 2em heading into 14px monospace task lines: CodeMirror's goal is a pixel x, so
// one x is two different columns on those two rows, and the caret lands near the
// end of the first and at the end of every one after it. A fixture of uniform
// lines would pass against the broken build.
//
// The assertion is the caret's OFFSET WITHIN ITS LINE, read from the selection
// rather than from coordinates: a coordinate assertion here would be measuring
// the same probe the fix stopped trusting.
//
// Note bodies are in-source scenario content, never credentials (SYNC-13).
//
// Vault-count precondition: 1 (weak KDF generator fixture, legal: unlock reads
// params from vault.meta).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  clickNoteRow,
  createNote,
  dismissImporterOffer,
  dismissImporterOfferIfPresent,
  pageSeatInvoke,
  selectedNoteId,
  settleOn,
  unlockToEditor,
} from "./support/flows";
import { KEY, pressKey } from "./support/keyboard";
import { type Session } from "./support/webdriver";

const IPC_TIMEOUT = 15_000;

/** How far back from a long line's end the measured walk starts. */
const BACKSTEPS = 12;

// A 2em heading, a long line, a SHORT line, and a long line again. Column 24
// exists on both long lines and not on the short one, which is what makes the
// round trip a test of the goal rather than of one move.
const LONG = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const BODY = ["# Things should be done", LONG, "abcde", LONG, ""].join("\n");

/** Where the caret is: which rendered row, how far into it, and that row's text. */
interface Caret {
  /** 1-based index among the rendered `.cm-line` rows. */
  readonly line: number;
  /** Characters between the row's start and the caret. */
  readonly column: number;
  /** The row's own text, which is how the walk locates itself. */
  readonly text: string;
}

/**
 * Read the caret from the DOM SELECTION, not from CodeMirror's state.
 *
 * The obvious probe is `contentDOM.cmView.view.state.selection`, and it does not
 * survive the production bundle: an earlier revision of this scenario used it,
 * every reading came back `''`, and the walk below silently ran its full 12
 * steps to the end of the document while reporting only that it never found the
 * line it was looking for. A probe that cannot fail loudly is worse than no
 * probe, and this one has no library internals to lose.
 *
 * It is also the more honest measurement for this scenario. The report is about
 * where the caret VISIBLY lands, and a `Range` from the row's start to the caret
 * counts exactly the characters a reader would count. It is not a coordinate
 * assertion, which is the thing this fix stopped trusting; it is a character
 * count taken from the rendered row.
 *
 * `''` while there is no selection in the editor yet, for `settleOn` to retry.
 */
function sample(s: Session): Promise<string> {
  return s.execute<string>(
    "var sel = window.getSelection();" +
      "if (!sel || sel.rangeCount === 0 || !sel.focusNode) return '';" +
      "var start = sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement;" +
      "var row = start && start.closest ? start.closest('.cm-line') : null;" +
      "if (!row || !row.parentElement) return '';" +
      "var r = document.createRange();" +
      "r.setStart(row, 0);" +
      "r.setEnd(sel.focusNode, sel.focusOffset);" +
      "var rows = Array.prototype.slice.call(row.parentElement.querySelectorAll('.cm-line'));" +
      "return JSON.stringify({" +
      "  line: rows.indexOf(row) + 1," +
      "  column: r.toString().length," +
      "  text: row.textContent" +
      "});",
  );
}

const caret = (s: Session, label: string): Promise<Caret> =>
  // `|| null` because `settleOn`'s not-ready sentinel is `null`: two `''`
  // readings would satisfy its stability run and reach `JSON.parse('')`, which
  // throws a `SyntaxError` `waitUntil` re-throws. `sample` returns `''` before
  // the click lands a selection, which is a real state on every run.
  settleOn(s, async () => (await sample(s)) || null, {
    label,
    parse: (raw) => JSON.parse(raw) as Caret,
    timeoutMs: 20_000,
  });

describeE2E("vc1 vertical motion keeps the column across a short line (#631)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("Down from an interior column clamps on the short line and comes back", async () => {
    let password = "";
    await scenario(
      "vc1-vertical-caret-column",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        await createNote(s, "Caret");
        const noteId = await selectedNoteId(s);
        const cur = await pageSeatInvoke(s, "plugin:notes|note_read", { noteId }, IPC_TIMEOUT);
        const base = typeof cur.ok === "string" ? cur.ok : "";
        const up = await pageSeatInvoke(
          s,
          "plugin:notes|note_update",
          { noteId, plaintext: `${base}\n${BODY}` },
          IPC_TIMEOUT,
        );
        expect(up.err, "note_update should succeed").toBeUndefined();

        await s.refresh();
        await s.byTestId("editor.root", { timeoutMs: 30_000 });
        await dismissImporterOfferIfPresent(s);
        await clickNoteRow(s, noteId);

        // Focus the editor. `:nth-child(1)` would be wrong here and was: the
        // frontmatter block is a block-replace widget, so `.cm-content`'s first
        // CHILD is CodeMirror's own widget buffer and no `.cm-line` matches.
        // The first `.cm-line` in document order is what this wants.
        const firstLine = await s.waitForElement(".cm-content .cm-line");
        await firstLine.click();

        // Walk down to the first long line. This is NAVIGATION, not the
        // assertion: the row's own text is read back each step, so it does not
        // matter how many rows the frontmatter widget and the heading occupy,
        // and a build whose vertical motion is broken still gets here.
        //
        // The failure message carries the rows the walk DID see. Without it the
        // only thing a red run says is "never found it", which is equally true
        // of a broken probe and of a document that is not what the fixture
        // thinks, and telling those apart cost a container round trip once.
        const seen: string[] = [];
        for (let step = 0; step < 12 && seen[seen.length - 1] !== LONG; step += 1) {
          await pressKey(s, KEY.ARROW_DOWN);
          seen.push((await caret(s, `caret after ArrowDown ${step + 1}`)).text);
        }
        expect(
          seen[seen.length - 1],
          `the walk never reached the first long line; rows seen: ${JSON.stringify(seen)}`,
        ).toBe(LONG);

        // The starting column has to be a FACT, not wherever a click resolved,
        // and it has to be past the short line's length or the clamp assertion
        // below asserts nothing. End of line, then a fixed walk back.
        await pressKey(s, KEY.END);
        for (let i = 0; i < BACKSTEPS; i += 1) await pressKey(s, KEY.ARROW_LEFT);
        const start = await caret(s, "the caret settles at a known interior column");
        const column = LONG.length - BACKSTEPS;
        expect(start.column, "END then a fixed walk back is a known column").toBe(column);
        expect(column, "the start column must exceed the short line's length").toBeGreaterThan(5);

        // Down onto the short line: clamped to its end, not left dangling past it.
        await pressKey(s, KEY.ARROW_DOWN);
        const short = await caret(s, "caret on the short line");
        expect(short.text, "one step down is the short line").toBe("abcde");
        expect(short.column, "clamped to the short line").toBe(5);

        // Out the other side: the column comes back. This is the assertion the
        // reported defect fails. A build that re-derives the goal from the
        // clamped position lands on column 5, and one that falls through to
        // `moveToLineBoundary` lands on the line's end.
        await pressKey(s, KEY.ARROW_DOWN);
        const after = await caret(s, "caret on the line below the short one");
        expect(after.text, "two steps down is the long line again").toBe(LONG);
        expect(after.column, "the original column came back after the short line").toBe(column);
        expect(after.column, "and it is not the line's end").toBeLessThan(LONG.length);
      },
    );
  });
});
