// Flow-logic: the `[[##` and `[[^^` pickers return rows on mobile (myne-md/myne#452).
//
// Both pickers have always MOUNTED here: `wikilinkPickerExtension()` composes
// `vaultHeadingsExtension()` and `vaultBlockAnchorsExtension()` unconditionally,
// and it sits unconditionally inside `myneExtensions()`. What was missing was
// everything behind them. Mobile registered neither `vault_indices_headings` nor
// `vault_indices_block_anchors`, its `IndexRecord` carried neither field, and
// `<CMEditor>` received neither prop, so both pickers opened on a phone and
// listed nothing. That is indistinguishable, on screen, from a vault that has no
// headings in it, which is why it survived from myne#216 until now.
//
// So these assertions are about ROWS EXISTING, which no rendering assertion
// elsewhere makes, plus the one thing the rows alone would not prove: that the
// trash-blind index is joined against the resident note-set before it is shown.
//
// Headless Chromium against the dev server with mock IPC, NOT an end-to-end
// suite.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

const AUTHOR_ID = "note-author";
const SOURCE_ID = "note-source";

/** The source note carries BOTH headings and the anchor in its body, so the mock
 *  can serve the dumps from what `vault_indices_apply` was actually sent rather
 *  than from a static array. A static array cannot change between reads, which
 *  makes "the index moved and the picker refreshed" unobservable however the
 *  assertion is written. */
const NOTES = [
  {
    id: SOURCE_ID,
    text: "---\ntitle: Kaynak\n---\n\n## Hedefler\n\nmetin ^blok-1\n\n### Notlar\n\nbaska bir satir\n",
  },
  { id: AUTHOR_ID, text: "---\ntitle: Yazar\n---\n\nbir satir\n" },
];

/** Seeded rows for a note that is NOT in `NOTES`, which is how a trashed or
 *  template note reaches a client: the Rust index is trash-blind and hands it
 *  over, and the join is the only thing that drops it. Nothing applies these, so
 *  they survive the apply-derived serving above and stay seedable. Without them
 *  this spec passes on a client that renders the dump raw. */
const HEADINGS = [{ noteId: "note-trashed", text: "Cope atilmis baslik", level: 1 }];

/** The same for `[[^^`, and it has a second job the heading rows do not.
 *
 *  `noteTitle` on the RESIDENT row is deliberately wrong ("Eski ad", a name the
 *  note no longer has). The join takes title and folder from the resident
 *  note-set instead of from the row, because the row's copy is as old as that
 *  note's last apply and the picker emits a PATH from it. A client that maps
 *  rather than joins renders "Eski ad", so this fixture fails such a client on
 *  two counts: the stale title, and the non-resident row surviving. Until this
 *  round it had neither, and reverting the join to a map left every case green. */
const ANCHORS = [
  {
    noteId: SOURCE_ID,
    noteTitle: "Eski ad",
    noteFolder: "Eski/",
    blockId: "blok-1",
    preview: "metin",
  },
  {
    noteId: "note-trashed",
    noteTitle: "Cope atilmis not",
    noteFolder: null,
    blockId: "cop-blok",
    preview: "cope atilmis onizleme",
  },
];

async function bootToAuthoringNote(
  page: Page,
  extra: { pickerFailures?: number; firstReadDelayMs?: number } = {},
): Promise<void> {
  await installMockIpc(page, {
    notes: NOTES,
    vaultHeadings: HEADINGS,
    vaultBlockAnchors: ANCHORS,
    vaultPickerFailures: extra.pickerFailures ?? 0,
    vaultPickerFirstReadDelayMs: extra.firstReadDelayMs ?? 0,
    // The whole point of this round's fixture change: the dumps answer from what
    // was applied, so an in-session edit changes what the next read returns.
    vaultPickersFromApplies: true,
  });
  await page.goto("/");
  await expect(page.getByTestId("workspace.app-header")).toBeVisible();
  // The index sweep the picker sets ride on is debounced 400ms; both fetches
  // happen after the applies it already ran, so wait past the whole pass.
  await page.waitForTimeout(1200);

  await page.locator(`[data-testid="notes.row"][data-note-id="${AUTHOR_ID}"]`).click();
  await expect(page.getByTestId("editor.top-bar")).toBeVisible();
  await page.locator(".cm-content").getByText("bir satir").click();
  await page.keyboard.press("End");
}

/**
 * Open the picker in one of its vault-wide modes.
 *
 * The mode marker goes in through `insertText`, NOT through `type`, and that is
 * load-bearing rather than stylistic. The picker re-ranks on every doc change
 * and CLOSES when the current filter has no rows, and once closed this `[[]]`
 * does not reopen. Typed character by character, `[[##` passes through `[[#`,
 * which is current-note-heading mode over a note that has none, and `[[^^`
 * passes through `[[^`, which is note mode with a query no title can match. Both
 * intermediate states have zero rows, so the menu closes before the second
 * character lands and the assertion below sees an empty picker: exactly the
 * defect this spec exists to catch, for a completely unrelated reason.
 *
 * It was flaky rather than failing outright, because a zero-delay burst
 * sometimes delivers both characters inside one animation frame and the
 * intermediate state is never rendered. A slower, more realistic `type` made it
 * fail every time. `insertText` dispatches ONE input event, so CodeMirror
 * applies one transaction and no intermediate filter ever exists.
 */
async function openPicker(page: Page, marker: "##" | "^^"): Promise<void> {
  await page.keyboard.type("\n[[");
  // Wait for a RENDERED ROW rather than for the menu element: the container
  // appears before the picker has ranked anything.
  await expect(page.getByTestId("picker.note-row").first()).toBeVisible();
  await page.keyboard.insertText(marker);
}

/**
 * Open the picker, and if it has no rows yet, close it and try again.
 *
 * A plain `toHaveCount(n, { timeout })` cannot express "eventually" here, and
 * the reason is in `openPicker` above: the picker CLOSES when its filter has no
 * rows, and a closed `[[]]` does not reopen. So polling a shut menu polls a DOM
 * that will never change, and the assertion times out reporting zero rows no
 * matter what the app has since fetched. Measured while writing these cases: the
 * app had the rows 6 seconds in and the test still failed at 15.
 *
 * Reopening is what actually asks the question again.
 */
async function expectPickerEventually(
  page: Page,
  marker: "##" | "^^",
  testid: string,
  count: number,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await openPicker(page, marker);
    if ((await page.getByTestId(testid).count()) === count) return;
    if (Date.now() >= deadline) break;
    await page.keyboard.press("Escape");
    await page.keyboard.press("End");
    await page.waitForTimeout(750);
  }
  // One last attempt, asserted properly so the failure message is the real one.
  await openPicker(page, marker);
  await expect(page.getByTestId(testid)).toHaveCount(count);
}

test.describe("the vault-wide wikilink pickers have rows on mobile", () => {
  test("`[[##` lists the vault's headings", async ({ page }) => {
    await bootToAuthoringNote(page);
    await expectPickerEventually(page, "##", "picker.vault-heading-row", 2);

    const rows = page.getByTestId("picker.vault-heading-row");
    await expect(rows.first()).toContainText("Hedefler");
    await expect(rows.nth(1)).toContainText("Notlar");
  });

  test("`[[##` drops a row whose note is not resident", async ({ page }) => {
    // The join, asserted directly. A client that passed the index dump straight
    // to the facet would show three rows here and look entirely correct.
    await bootToAuthoringNote(page);
    await expectPickerEventually(page, "##", "picker.vault-heading-row", 2);
    await expect(page.getByText("Cope atilmis baslik")).toHaveCount(0);
  });

  test("`[[^^` lists the vault's imported block anchors", async ({ page }) => {
    await bootToAuthoringNote(page);
    await expectPickerEventually(page, "^^", "picker.vault-block-anchor-row", 1);
    const row = page.getByTestId("picker.vault-block-anchor-row").first();
    await expect(row).toContainText("metin");
    // The join, asserted on the `[[^^` leg the way it already was on `[[##`.
    // The non-resident row must be gone, and the row's own stale `noteTitle`
    // must have been replaced by the resident note's. A client that maps rather
    // than joins fails both.
    await expect(page.getByText("cope atilmis onizleme")).toHaveCount(0);
    await expect(row).toContainText("Kaynak");
    await expect(row).not.toContainText("Eski ad");
  });
});

test.describe("a refused picker read is retried, and exhausting the budget is not terminal", () => {
  // The defect this covers is the one the fix for myne-md/myne#452 nearly
  // shipped with. The two reads used to ride the index sweep's async body, after
  // the apply loop had marked every note; the sweep early-returns on an empty
  // delta, so ONE rejected read left both pickers empty with the delta already
  // consumed and nothing able to re-issue. Reading notes changes no signature,
  // so no later sweep fires: the picker stayed empty until the app was killed.
  //
  // `vaultPickerFailures` rejects the first reads of each command with the shape
  // the `Slot::Unlocked` gate really produces, which is the case that happens (a
  // read racing an auto-lock). Two, so the recovery cannot come from the boot
  // sweep's own second read alone and the retry has to carry it.
  const REFUSALS = 2;
  /**
   * Enough refusals to outlast everything boot issues.
   *
   * NOT computed from `PICKER_FETCH_RETRIES`, and the first version of this case
   * was, which is why it tested nothing. The budget is per INDEX VALUE and boot
   * produces more than one (the `[vaultId]` reset's own trigger, then the
   * sweep's lockstep bump), so `PICKER_FETCH_RETRIES + 1` was four refusals
   * against five boot reads: the fifth was served and the picker already held
   * the right two rows before the case did anything. Measured in the running
   * page: at 4 refusals `rowsBeforeEdit=2`, at 5, 6, 8 and 999 it is 0.
   *
   * Eight is two full budgets, which is the worst case boot can issue, and the
   * case ASSERTS the stranded state before proceeding rather than trusting this
   * number to still be right.
   */
  const REFUSALS_PAST_EXHAUSTION = 8;

  test("`[[##` fills after its first reads are refused", async ({ page }) => {
    await bootToAuthoringNote(page, { pickerFailures: REFUSALS });
    await expectPickerEventually(page, "##", "picker.vault-heading-row", 2);
  });

  test("`[[^^` fills after its first reads are refused", async ({ page }) => {
    await bootToAuthoringNote(page, { pickerFailures: REFUSALS });
    await expectPickerEventually(page, "^^", "picker.vault-block-anchor-row", 1);
  });

  test("an EXHAUSTED budget recovers on the next index move", async ({ page }) => {
    // The boundary the retry constant sets, in two halves, because only the pair
    // is a test. First that the budget is FINITE: enough refusals really do
    // strand the picker. Then that being stranded is not terminal: the next real
    // index bump resets the budget and editing any note brings both pickers
    // back. Without the first half the second passes for the same reason the two
    // refusal cases above already pass, which is what the first version of this
    // case did.
    await bootToAuthoringNote(page, { pickerFailures: REFUSALS_PAST_EXHAUSTION });
    await page.waitForTimeout(8000);

    // The stranded state, ASSERTED rather than assumed. If a change makes boot
    // issue more reads than this budget covers, this fails here and names the
    // precondition, instead of the case quietly going back to testing nothing.
    await openPicker(page, "##");
    await expect(page.getByTestId("picker.vault-heading-row")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("End");

    await page.locator(".cm-content").getByText("bir satir").click();
    await page.keyboard.press("End");
    await page.keyboard.type("\n\nbir degisiklik\n");
    await page.getByTestId("editor.back").click();
    await expect(page.getByTestId("workspace.app-header")).toBeVisible();
    await page.waitForTimeout(1500);

    await page.locator(`[data-testid="notes.row"][data-note-id="${AUTHOR_ID}"]`).click();
    await expect(page.getByTestId("editor.top-bar")).toBeVisible();
    await page.locator(".cm-content").getByText("bir satir").click();
    await page.keyboard.press("End");

    await expectPickerEventually(page, "##", "picker.vault-heading-row", 2);
  });
});

test.describe("the picker sets follow the index rather than the boot sweep", () => {
  // Round 2 of review measured that the lockstep bump at the end of the index
  // sweep, and the monotonic sequence guard on the reads, could BOTH be deleted
  // with the entire flow tier and both Vitest suites staying green. The reason
  // was the fixture, not the assertions: the mock served a static array, so a
  // re-read after an apply returned exactly what a stale set already held and no
  // spec could observe a refresh. `vaultPickersFromApplies` is that fixed; these
  // two cases are what it buys.

  test("a heading typed in this session reaches `[[##`", async ({ page }) => {
    // The lockstep bump. Without it the sweep applies the edited note and the
    // readers are never told, so the picker keeps the set it read at boot. That
    // is desktop's `useIndexNonce` behaviour, which mobile has to supply itself.
    await bootToAuthoringNote(page);
    await expectPickerEventually(page, "##", "picker.vault-heading-row", 2);
    await page.keyboard.press("Escape");

    // Type a new heading into the note being authored, then LEAVE the note, which
    // is what flushes the write (`save-delta.flow.ts` drives the same seam). The
    // sweep diffs against `bodies`, and `bodies` only moves once the note is
    // saved, so typing alone changes nothing the index can see.
    await page.locator(".cm-content").getByText("bir satir").click();
    await page.keyboard.press("End");
    await page.keyboard.type("\n\n## Yepyeni baslik\n");
    await page.getByTestId("editor.back").click();
    await expect(page.getByTestId("workspace.app-header")).toBeVisible();
    await page.waitForTimeout(1500);

    // Back into the note, and ask the picker again.
    await page.locator(`[data-testid="notes.row"][data-note-id="${AUTHOR_ID}"]`).click();
    await expect(page.getByTestId("editor.top-bar")).toBeVisible();
    await page.locator(".cm-content").getByText("bir satir").click();
    await page.keyboard.press("End");

    await expectPickerEventually(page, "##", "picker.vault-heading-row", 3);
    await expect(page.getByText("Yepyeni baslik")).toHaveCount(1);
  });

  test("a slow early read cannot overwrite a newer one", async ({ page }) => {
    // The monotonic sequence guard. The first read is delayed past the read that
    // follows the boot applies, so it resolves LAST carrying the pre-apply set
    // (which holds nothing resident). Without the guard it overwrites the newer
    // result and both pickers end up empty; with it the stale answer is dropped.
    await bootToAuthoringNote(page, { firstReadDelayMs: 2500 });
    await page.waitForTimeout(4000);

    await expectPickerEventually(page, "##", "picker.vault-heading-row", 2);
  });
});
