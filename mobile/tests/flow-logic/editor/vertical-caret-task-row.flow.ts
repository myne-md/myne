// Flow-logic: a vertical arrow from a TASK row moves one row, and never to the
// document's first line (myne-md/myne#631's row half).
//
// # Why this exists at all
//
// `e2e/editor-vertical-caret.e2e.ts` pins the COLUMN half of vertical motion and
// its fixture is plain prose — a heading and three text lines, not one task row.
// `tests/editor/lineVertical.test.ts` pins the arithmetic against a stubbed view,
// because jsdom computes no layout and the probe cannot be exercised there. So
// the one input this bug needed — a caret on a `- [ ]` row, whose marker is a
// replaced range and whose line ends in the `+` point widget — was covered by
// neither tier, and "ArrowUp teleports me to the note's heading" was reported
// against a build where every gate was green.
//
// # What it asserts, and what it cannot
//
// The property is the invariant the fix added to `targetRow`: **a vertical arrow
// moves at most one visual row.** The rows are read from the DOM selection rather
// than from CodeMirror's state (the production bundle has no `cmView`, and a
// probe that cannot fail loudly is worse than none — the same reasoning
// `e2e/editor-vertical-caret.e2e.ts` records for its own `sample`).
//
// It is a REGRESSION GUARD, not a reproduction: the reported jump does not
// reproduce in Chromium or WebKit at either the phone or the desktop geometry
// (measured 2026-10-19), so reverting the fix leaves this green. The tier that
// fails without the fix is `tests/editor/lineVertical.test.ts`'s
// "refuses a row answer that is not adjacent", which drives a stub that answers
// with offset 0 exactly as `posAtCoords` does when its upward scan passes the
// top of the content box. This one holds the same property against a real layout
// engine, which is where the fix could break something the stubs cannot see.
//
// No credential is in this file: note bodies are in-source scenario content
// (SYNC-13).

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

const NOTE_ID = "note-vertical-task-row";

/** The reporter's own document shape, byte-for-byte. No padding: the note is
 *  short enough to render whole, so no lane-specific scroller is involved. */
const NOTE_BODY = [
  "---",
  "title: Friday",
  "---",
  "## Friday",
  "### Tasks",
  "- [ ] Study german 2 hours",
  "- [ ] Go to gym",
  "- [ ] Minimum 1 leetcode question",
  "- [ ] Read book",
  "- [ ] Pray minimum 1 times and read Quran",
  "- [ ] PhotoPrism meeting",
  "- [ ] PhotoPrism timelog",
  "### Notes",
  "- bir not",
  "",
].join("\n");

async function openNote(page: Page): Promise<void> {
  await installMockIpc(page, { notes: [{ id: NOTE_ID, text: NOTE_BODY }] });
  await page.goto("/");
  await page.locator(`[data-testid="notes.row"][data-note-id="${NOTE_ID}"]`).click();
  await expect(page.getByTestId("editor.top-bar")).toBeVisible();
  await expect(page.locator(".cm-content").getByText("Go to gym")).toBeVisible();
}

/** The caret's rendered row: its text, and how far into it the caret sits. */
async function caretRow(page: Page): Promise<{ text: string; column: number }> {
  return page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.focusNode) throw new Error("no selection");
    const start =
      sel.focusNode.nodeType === 1
        ? (sel.focusNode as Element)
        : (sel.focusNode.parentElement as Element);
    const row = start?.closest?.(".cm-line");
    if (!row) throw new Error("caret is not on a rendered row");
    const r = document.createRange();
    r.setStart(row, 0);
    r.setEnd(sel.focusNode, sel.focusOffset);
    return { text: row.textContent ?? "", column: r.toString().length };
  });
}

test.describe("a vertical arrow from a task row", () => {
  test("walks one row at a time and never reaches the note's first line", async ({ page }) => {
    await openNote(page);
    await page.locator(".cm-content").getByText("Go to gym").click();

    // Every step, named. A jump to the document's first line is one press that
    // crosses many rows, which is the report verbatim; anything that skips a row
    // fails on the text it landed on rather than on a number.
    const expected = [
      "Study german 2 hours", // the row directly above
      "Tasks", // the heading above the list
      "Friday", // the note's first body line, one row up again
    ];
    for (const [i, text] of expected.entries()) {
      await page.keyboard.press("ArrowUp");
      const at = await caretRow(page);
      expect(at.text.replace(/\+$/, ""), `press ${i + 1}`).toBe(text);
    }

    // At the document's edge the press is a no-op and nothing jumps: the row
    // above the day heading does not exist. The row TEXT may read `## Friday`
    // here rather than `Friday`, because CodeMirror's own fallback lands the
    // caret at the line's raw start, inside the `## ` run, which re-reveals the
    // marker — a rendering detail of the first line, not a row move.
    await page.keyboard.press("ArrowUp");
    expect((await caretRow(page)).text).toContain("Friday");

    // And back down again, one row at a time, so the guard is not one-sided.
    const down = ["Tasks", "Study german 2 hours", "Go to gym"];
    for (const [i, text] of down.entries()) {
      await page.keyboard.press("ArrowDown");
      const at = await caretRow(page);
      expect(at.text.replace(/\+$/, ""), `down ${i + 1}`).toBe(text);
    }
  });
});
