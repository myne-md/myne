// A triple-click on a task row selects that row and leaves the caret on it
// (myne-md/myne#560).
//
// # What this covers that the unit suite cannot
//
// Two other lanes cover this and each covers a different step.
// `tests/editor/taskRowSelection.test.ts` is the DECISION: `trimRowNewline` as a
// pure function, every refusal branch and the reverse-drag direction.
// `tests/editor/taskLineEditing.test.ts` is the WIRING: a mounted CM6 view, a
// dispatched `select.pointer` transaction, the resulting selection and DOM.
// Neither can produce that transaction from a GESTURE, because jsdom has no
// `detail`-aware selection model and CM6 never runs its triple-click handler
// there, so the step from three clicks to that annotated transaction is assumed
// in both.
//
// This scenario is that step, and it is where the bug lived: CM6's own gesture
// takes the line plus its trailing newline, so the range ends at the NEXT line's
// start and the caret sits one visual row below the row that was clicked. The
// unit test asserts what the filter does with the transaction; this asserts that
// pressing three times is what hands it one.
//
// # What is deliberately NOT asserted, and why
//
// The other half of #560 is `drawSelection` painting the multi-row form (a band
// running to the right edge plus a zero-width piece on the following row)
// instead of one band over the row. That is a paint, and this harness has no
// pixel comparison; asserting it would mean re-implementing the geometry the bug
// was IN. The rendered selection's extent is what decides that paint, so pinning
// the extent is the closest checkable statement, and it is also what decides the
// caret and the clipboard.
//
// The assertion reads the DOM selection rather than CM6's `state.selection`,
// deliberately. Reaching the view would mean either an internals walk
// (`.cmView`) or a production test hook, and `scripts/check-web-no-test-hooks.mjs`
// bans the second by name. The DOM is also the more honest subject here: the
// rendered rows are what the user is looking at when the caret appears on the
// wrong one.
//
// Vault-count precondition: 1 (weak KDF generator fixture).

import { expect, it } from "vitest";
import { describeE2E, scenario } from "./support/scenario";
import { seedVault } from "./support/fixtures";
import {
  createNote,
  dismissImporterOffer,
  pasteIntoEditor,
  unlockToEditor,
  waitForSaved,
} from "./support/flows";
import type { Session } from "./support/webdriver";

const BODY = ["- [ ] first task rowsel1", "- [ ] second task rowsel2"].join("\n");

/**
 * Which rendered `.cm-line` the selection's two ends sit on, 0-based, or
 * `null` while there is no selection inside a focused editor.
 *
 * `.cm-focused` is load-bearing, and the ai-degradation spec pays for the same
 * lesson: a DOM selection inside `.cm-content` on an UNFOCUSED editor satisfies
 * every weaker check and tells CodeMirror nothing.
 */
async function selectedRows(s: Session): Promise<{ anchor: number; focus: number } | null> {
  return s.execute<{ anchor: number; focus: number } | null>(
    "var sel = window.getSelection();" +
      "if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;" +
      "if (!document.querySelector('.cm-editor.cm-focused')) return null;" +
      "var content = document.querySelector('[data-testid=\"editor.content\"] .cm-content');" +
      "if (!content) return null;" +
      "var rows = Array.prototype.slice.call(content.querySelectorAll('.cm-line'));" +
      "function rowOf(node) {" +
      "  var el = node && node.nodeType === 1 ? node : node && node.parentElement;" +
      "  var line = el && el.closest ? el.closest('.cm-line') : null;" +
      "  return line ? rows.indexOf(line) : -1;" +
      "}" +
      "var a = rowOf(sel.anchorNode);" +
      "var f = rowOf(sel.focusNode);" +
      "if (a < 0 || f < 0) return null;" +
      "return { anchor: a, focus: f };",
  );
}

describeE2E("trs1 a triple-click on a task row keeps the caret on that row", () => {
  // Vault-count precondition: 1 (weak KDF).
  it("selects the row without its newline, so the caret does not fall to the next", async () => {
    let password = "";
    await scenario(
      "trs1-task-row-selection",
      { seed: (dir) => void (password = seedVault(dir).password) },
      async (app) => {
        const s = app.session;
        await unlockToEditor(s, password);
        await dismissImporterOffer(s);
        await createNote(s, "Row Selection Note");
        await pasteIntoEditor(s, BODY);
        await waitForSaved(s);

        // The FIRST of the two task rows, so there is a row below it for the
        // selection to spill onto. `.cm-line` rather than a testid: the subject
        // is the line box CM6 laid out, and it must have a row after it.
        const rows = await s.findElements(
          '[data-testid="editor.content"] .cm-content .cm-line',
        );
        const target = rows[rows.length - 2];
        if (target === undefined) throw new Error("trs1: fewer than two lines rendered");
        await target.tripleClick();

        const sel = await s.waitUntil(async () => await selectedRows(s), {
          label: "a non-empty selection inside the focused editor",
        });

        // One row, both ends. Before the filter the focus end was on the NEXT
        // row, which is what dropped the caret a row below the row clicked and
        // what made `drawSelection` paint the two-rectangle form.
        expect(sel.focus, "the selection must not spill onto the next row").toBe(sel.anchor);
      },
    );
  });
});
