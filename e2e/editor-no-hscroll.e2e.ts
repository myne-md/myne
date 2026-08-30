// The editor never scrolls sideways, at any pane width (myne-md/myne#630).
//
//   hs1  A note carrying frontmatter properties and a wide table, opened in a
//        two-pane split, fits its scroller, while the table still scrolls
//        inside its own box.
//
// `EditorView.lineWrapping` has always been mounted, so TEXT wrapped. What
// scrolled was widgets that would not shrink: CodeMirror's base theme gives
// `.cm-scroller` `overflow-x: auto` and `.cm-content` `flex-shrink: 0` with the
// flex default `min-width: auto`, so one unshrinkable descendant floors the
// content width and turns the whole note into a sideways swipe. The frontmatter
// Properties grid was one (`24px 160px 1fr` with `<input>`s that set
// `width: 100%` and never `min-width: 0`).
//
// THE SPLIT IS THE POINT, not decoration. The desktop window has `minWidth: 880`
// (tauri.conf.json), and at 880px a single pane is wide enough that the pre-fix
// CSS fits, so a scenario that only narrowed the window would pass against the
// broken build. A split puts each editor at roughly a phone's width, which is
// the "split view" half of the report and the width where the defect appears.
//
// TWO panes, not three, and the number is a measurement rather than a taste: on
// this harness three panes leave 138px of editor, which is narrower than any
// window a person works in and narrow enough that a tag chip's own glyphs cannot
// fit whatever CSS says. Asserting there would be asserting that text has no
// minimum size. Two panes leave 232px, which is a real split and is the
// width class the report is about.
//
// TWO ASSERTIONS, and neither alone is the property:
//   - `.cm-scroller` has nothing to scroll to, so the note does not drift sideways;
//   - `.cm-table-editable` is still wider than its own box, so a fix that merely
//     clipped everything, which satisfies the first one, fails here.
//
// The scroller carries no testid (it is CodeMirror's own div), so it is resolved
// the way the scroll-slack scenario resolves its own: from the content outward.
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
  rowMenuPick,
  selectedNoteId,
  settleOn,
  unlockToEditor,
} from "./support/flows";
import { type Session } from "./support/webdriver";

const IPC_TIMEOUT = 15_000;

// Long property values (the Properties grid is the primary suspect), a wide GFM
// table (the construct that legitimately overflows and must scroll in its own
// box), and a long unbroken token, which is what `overflow-wrap` rather than
// `lineWrapping` has to handle.
const BODY = [
  "---",
  "title: Freedom",
  "path: Areas/Read/Saadat Hasan Manto/Collected Stories",
  "created: 2026-08-03T14:57:19.690Z",
  "tags:",
  "  - 1947 Partition",
  "  - Pakistan",
  "source: https://example.invalid/a/very/long/path/that/does/not/wrap/on/its/own",
  "---",
  "",
  "# Partition before reading",
  "",
  "https://example.invalid/an/extremely/long/unbroken/url/token/with/no/spaces/at/all",
  "",
  "| Column one | Column two | Column three | Column four | Column five | Column six |",
  "| --- | --- | --- | --- | --- | --- |",
  "| aaaaaaaaaa | bbbbbbbbbb | cccccccccc | dddddddddd | eeeeeeeeee | ffffffffff |",
  "",
].join("\n");

/** 1px of sub-pixel rounding is not a scrollable inch. */
const SLACK_PX = 1;

interface Widths {
  /** Horizontal overflow of the scroller holding the Properties widget. */
  readonly scrollerOverflow: number;
  /** …and of the PANE around it, a scroll container in its own right. */
  readonly paneOverflow: number;
  /** Horizontal overflow of the table's own box (must be POSITIVE). */
  readonly tableOverflow: number;
  /** The pane's inner width, reported so a failure says how narrow it got. */
  readonly paneWidth: number;
}

/**
 * Measure the pane that holds the Properties widget, as a raw JSON string for
 * `settleOn` to compare. `''` while the widget or the table has not mounted:
 * both are block-replace decorations built after the first syntax-tree pass, and
 * a measurement taken before them is a measurement of a different document.
 *
 * `.cm-content` is deliberately NOT measured against itself. It carries
 * `flex-shrink: 0` with `min-width: auto`, so it grows to its widest child by
 * construction, and that difference is ~0 in the broken build and the fixed one
 * alike. An assertion that cannot move does not belong in a scenario whose whole
 * design note is about which assertions discriminate.
 */
function sample(s: Session): Promise<string> {
  return s.execute<string>(
    "var props = document.querySelector('.cm-fm-properties');" +
      "if (!props) return '';" +
      "var scroller = props.closest('.cm-scroller');" +
      "if (!scroller) return '';" +
      "var table = scroller.querySelector('.cm-table-editable');" +
      "if (!table) return '';" +
      "var pane = scroller.parentElement;" +
      "while (pane) {" +
      "  var cs = getComputedStyle(pane);" +
      "  if (cs.overflowX === 'auto' || cs.overflowX === 'scroll' ||" +
      "      cs.overflowY === 'auto' || cs.overflowY === 'scroll') break;" +
      "  pane = pane.parentElement;" +
      "}" +
      "if (!pane) return '';" +
      "return JSON.stringify({" +
      "  scrollerOverflow: scroller.scrollWidth - scroller.clientWidth," +
      "  paneOverflow: pane.scrollWidth - pane.clientWidth," +
      "  tableOverflow: table.scrollWidth - table.clientWidth," +
      "  paneWidth: scroller.clientWidth" +
      "});",
  );
}

describeE2E("hs1 the editor never scrolls horizontally in a narrow split (#630)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("a split pane fits its content, and only the table scrolls", async () => {
    let password = "";
    await scenario(
      "hs1-editor-no-hscroll",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);

        // Two notes: one carrying the fixture, one only to earn the split.
        // Each id is read the moment its note is created, because `noteRowIds` returns
        // rows in TREE order, which is not creation order, so picking `[0]` from
        // it would be picking whichever note happens to sort first.
        await createNote(s, "Wide");
        const wideId = await selectedNoteId(s);
        await createNote(s, "Filler one");
        const fillerOne = await selectedNoteId(s);

        // The body goes in over IPC rather than through typeIntoEditor: the
        // driver drops keystrokes over a body this size (same reason as ss1/wd1).
        const cur = await pageSeatInvoke(
          s,
          "plugin:notes|note_read",
          { noteId: wideId },
          IPC_TIMEOUT,
        );
        const base = typeof cur.ok === "string" ? cur.ok : "";
        const up = await pageSeatInvoke(
          s,
          "plugin:notes|note_update",
          { noteId: wideId, plaintext: `${BODY}\n${base}` },
          IPC_TIMEOUT,
        );
        expect(up.err, "note_update should succeed").toBeUndefined();

        // Reload so the editor reads the note from disk rather than its own
        // buffer, then rebuild the layout: the fixture note plus one split, so
        // each pane is about a phone's width.
        await s.refresh();
        await s.byTestId("editor.root", { timeoutMs: 30_000 });
        // …IfPresent on the second mount: the offer is a fresh-vault overlay and
        // does not come back on a vault that already has notes, so the hard
        // variant would burn its budget here.
        await dismissImporterOfferIfPresent(s);
        await clickNoteRow(s, wideId);
        await rowMenuPick(s, fillerOne, "open-to-side");

        // `settleOn` rather than a hand-rolled measure-twice: only a reading that
        // REPEATS is the layout's answer rather than one frame of it, and
        // COMPARING the two readings is the part a measure-twice leaves out.
        const w = await settleOn(s, () => sample(s), {
          label: "the Properties widget and the table settle at one measurement",
          parse: (raw) => JSON.parse(raw) as Widths,
          timeoutMs: 20_000,
        });

        expect(
          w.scrollerOverflow,
          `the editor scrolls sideways in a ${w.paneWidth}px pane`,
        ).toBeLessThanOrEqual(SLACK_PX);
        // The container OUTSIDE the editor, which is a second scroll container:
        // `overflow: auto` is both axes, so splitting it to one is half of this
        // fix and was revertible with the scroller measurement alone.
        expect(
          w.paneOverflow,
          `the pane around the editor scrolls sideways at ${w.paneWidth}px`,
        ).toBeLessThanOrEqual(SLACK_PX);
        // The half that makes the two above mean something. Table cells carry
        // `min-width: 6em` and `white-space: nowrap` deliberately, so a
        // six-column table IS wider than this pane, and the right answer is that
        // the table's box scrolls, not that the note does.
        expect(
          w.tableOverflow,
          "the table is not wider than its own box, so this scenario proves nothing",
        ).toBeGreaterThan(SLACK_PX);
      },
    );
  });
});
