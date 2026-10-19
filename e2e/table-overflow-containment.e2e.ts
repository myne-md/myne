// tof1 — a wide table scrolls inside its own box, and nothing else moves.
// myne-md/myne#555, the `editor.tables` bullet:
//
//   > assert `scrollWidth > clientWidth` on the table's own box while the
//   > pane's and body's `scrollWidth` equal their `clientWidth`, plus a minimum
//   > per-column width.
//
// # The regression this is named for, in the tree's own words
//
// `editor/src/theme.ts` records the fix and the feedback that forced it:
//
//   > inline-block + max-width:100% + overflow-x:auto is the proven "scroll
//   > inside the widget, never the editor" pattern (mirrors `.cm-mermaid-card`).
//   > A `block` here fills the editor width and lets a wide table overflow into
//   > the editor's own horizontal scroller (MYND-162 feedback: "only the table
//   > should scroll").
//
// One CSS word — `block` instead of `inline-block` — and the whole document
// gains a horizontal scrollbar. Every paragraph in the note then scrolls
// sideways because one table three screens down is wide, which is a far worse
// experience than the wide table itself, and it is invisible until somebody
// opens a note that has one.
//
// # Why the assertion is a triple rather than "the table scrolls"
//
// Three boxes have to hold different things at the same time, and any one of
// them alone is satisfiable by a bug:
//
//  * the TABLE's box overflows — otherwise the table wrapped or was truncated,
//    and there is nothing to contain;
//  * the EDITOR's content box does not — that is the regression;
//  * the DOCUMENT does not — the pane could be containing it while the window
//    still grew, which is the same failure one level out.
//
// The per-column minimum is the fourth, and it is what stops the "fix" of
// letting cells collapse to nothing: `min-width: 6em` with `white-space:
// nowrap` is the deliberate choice — a cell widens and the table scrolls,
// rather than the text wrapping into a tall wall (MYND-162 again).
//
// Vault-count precondition: 1 (weak KDF generator fixture).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault, type SeededVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  seedEmbedIntoNote,
  unlockToEditor,
} from "./support/flows";
import type { Session } from "./support/webdriver";
import { testIdSelector } from "./support/webdriver";

const EDITOR = testIdSelector("editor.content");
const CM_CONTENT = `${EDITOR} .cm-content`;
const CM_SCROLLER = `${EDITOR} .cm-scroller`;
// The scroll container for a TOP-LEVEL table, which is what this scenario
// writes. `.cm-table-scroll` is the other one — the read-only NESTED case (a
// table inside a blockquote or a list item), which is not editable and gets an
// inline-block wrapper instead.
//
// A first draft asserted on `.cm-table-scroll` and timed out three runs running
// while the table was rendering perfectly. The diagnostic added for the
// PREVIOUS failure is what settled it: it reported one `.cm-table` element and
// the cells' text on screen, so the block had parsed AND decorated, and the
// only thing missing was a class this document never emits. Both containers
// have the same job (`overflow-x: auto`, contained width) and different names,
// and nothing in the selector said which case it meant.
const TABLE_SCROLL = `${EDITOR} .cm-table-editable`;

type Box = { scroll: number; client: number };

async function boxOf(s: Session, selector: string): Promise<Box | null> {
  return await s.execute<Box | null>(
    "var el = document.querySelector(arguments[0]);" +
      "if (!el) return null;" +
      "return { scroll: el.scrollWidth, client: el.clientWidth };",
    [selector],
  );
}

describeE2E("tof1 a wide table scrolls in its own box (myne-md/myne#555)", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("overflows the table and nothing else, and keeps columns readable", async () => {
    let seeded: SeededVault;
    await scenario(
      "tof1-table-overflow",
      { seed: (dir) => void (seeded = seedVault(dir, {})) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, seeded.password);
        await dismissImporterOffer(s);
        await createNote(s, "Genis tablo");

        // A GFM table far wider than any pane: eight columns of long,
        // space-free cells. `white-space: nowrap` means each one widens its
        // column rather than wrapping, which is the documented behaviour and
        // what makes the table exceed the pane deterministically.
        const cell = (n: number) => `veri-hucresi-uzun-${n}-abcdefghijklmnop`;
        const header = `| ${[0, 1, 2, 3, 4, 5, 6, 7].map((n) => `Sutun ${n}`).join(" | ")} |`;
        const rule = `| ${[0, 1, 2, 3, 4, 5, 6, 7].map(() => "---").join(" | ")} |`;
        const row = `| ${[0, 1, 2, 3, 4, 5, 6, 7].map(cell).join(" | ")} |`;

        // WRITTEN through `note_update` and reopened, not typed — and that is a
        // correction rather than a preference. A first draft typed the table
        // with `typeIntoEditor` and the widget never mounted: `.cm-table-scroll`
        // timed out at 15 s, three runs in a row. CodeMirror's own input
        // handling is in the way (the embed scenarios learned the same thing
        // about `[`, and `e2e/AGENTS.md` records four rounds of it), and this
        // scenario is about LAYOUT — whether a user can type a table is a
        // different claim, covered where typing is the subject.
        //
        // The reopen is also what puts the caret outside the block, which a
        // block decoration needs in order to render at all (the live-preview
        // reveal rule that cbt1 and tq1 note at their own call sites).
        //
        // The LEADING blank line is load-bearing, and its absence is what the
        // first two runs failed on. `seedEmbedIntoNote` appends as
        // `<existing>\n<text>`, and `createNote` leaves a title line at the end
        // — so without a blank line the header row is a lazy continuation of
        // that paragraph, GFM never emits a `Table` node, and no decoration is
        // built. The wait then times out on `.cm-table-scroll` and reads like a
        // missing widget rather than a malformed document.
        await seedEmbedIntoNote(s, ["", header, rule, row, row].join("\n"));

        // Diagnosed the way the renderer works rather than the way the author
        // hoped: a table that failed to PARSE and one that parsed and failed to
        // DECORATE are different bugs with the same symptom, and only the buffer
        // separates them. The label is a thunk, which the harness reads only on
        // the timeout path — so the probe below costs one round trip per poll
        // and the message costs nothing when the wait succeeds.
        let seen = { text: "", tables: 0 };
        await s.waitUntil(
          async () => {
            seen =
              (await s.execute<{ text: string; tables: number }>(
                "var c = document.querySelector('[data-testid=\"editor.content\"]');" +
                  "return {" +
                  "  text: (c ? c.textContent || '' : '').slice(0, 300)," +
                  "  tables: document.querySelectorAll('.cm-table').length" +
                  "};",
              )) ?? seen;
            return (await s.findElements(TABLE_SCROLL)).length > 0 ? true : null;
          },
          {
            timeoutMs: 15_000,
            label: () =>
              `the table decorated — found ${seen.tables} .cm-table element(s) and no ` +
              `.cm-table-editable. The editor is showing ${JSON.stringify(seen.text)}. ` +
              `RAW PIPES there mean the block never parsed as a GFM table (a table ` +
              `needs a blank line before it). RENDERED CELLS with no ` +
              `.cm-table-editable mean it parsed and took the NESTED read-only ` +
              `branch instead, which wraps in .cm-table-scroll — see isTopLevelTable ` +
              `in editor/src/decorations/table.ts`,
          },
        );

        const table = await boxOf(s, TABLE_SCROLL);
        const content = await boxOf(s, CM_CONTENT);
        const scroller = await boxOf(s, CM_SCROLLER);
        const body = await s.execute<Box>(
          "return { scroll: document.documentElement.scrollWidth," +
            " client: document.documentElement.clientWidth };",
        );

        expect(table, "the table widget never mounted").not.toBeNull();

        // 1. The table's own box really is overflowing. Without this the two
        //    containment assertions below are vacuous — a table that fitted
        //    would satisfy them trivially.
        expect(
          table!.scroll,
          `the table's box is ${table!.scroll}px wide against a ${table!.client}px ` +
            `viewport, i.e. it is NOT overflowing. Either the cells wrapped ` +
            `(contradicting the deliberate white-space: nowrap) or the table was ` +
            `truncated — and either way this scenario is no longer testing ` +
            `containment, because there is nothing to contain.`,
        ).toBeGreaterThan(table!.client);

        // 2. THE regression. `inline-block` + `max-width: 100%` is what keeps
        //    the overflow inside the widget; a `block` here fills the editor
        //    width and pushes the whole document sideways.
        expect(
          content!.scroll,
          `the editor's content box overflows horizontally ` +
            `(${content!.scroll} > ${content!.client}) because of a wide table. ` +
            `Every paragraph in the note then scrolls sideways, which is worse ` +
            `than the wide table ever was — MYND-162: "only the table should scroll".`,
        ).toBeLessThanOrEqual(content!.client + 1);

        expect(
          scroller!.scroll,
          `the editor's scroller overflows horizontally ` +
            `(${scroller!.scroll} > ${scroller!.client}) — the pane grew to fit the ` +
            `table instead of the table scrolling inside itself`,
        ).toBeLessThanOrEqual(scroller!.client + 1);

        // 3. One level further out: the pane could be containing it while the
        //    window still grew.
        expect(
          body.scroll,
          `the document itself overflows horizontally (${body.scroll} > ${body.client}) ` +
            `— the containment held at the pane and failed at the window`,
        ).toBeLessThanOrEqual(body.client + 1);

        // 4. The columns are still readable. The alternative "fix" for an
        //    overflowing table is to let cells collapse, and that would satisfy
        //    every assertion above while making the table useless.
        const narrowest = await s.execute<number>(
          "var cells = document.querySelectorAll(arguments[0] + ' td, ' + arguments[0] + ' th');" +
            "if (!cells.length) return -1;" +
            "var min = Infinity;" +
            "for (var i = 0; i < cells.length; i++) {" +
            "  min = Math.min(min, cells[i].getBoundingClientRect().width);" +
            "}" +
            "return min;",
          [TABLE_SCROLL],
        );
        expect(narrowest, "no table cells were found to measure").toBeGreaterThan(0);
        // `min-width: 6em` at the table's 13px font is ~78px; the floor is set
        // well under it so this measures "did not collapse" rather than
        // re-deriving the exact declaration.
        expect(
          narrowest,
          `the narrowest table cell is ${narrowest}px. Cells carry a min-width of ` +
            `6em precisely so that a wide table SCROLLS rather than collapsing its ` +
            `columns — a table contained by squeezing its content is contained and ` +
            `unreadable.`,
        ).toBeGreaterThan(40);
      },
    );
  });
});
