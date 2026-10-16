// Flow-logic: Settings → Editor → periodic-notes settings (myne-md/myne#880).
// Headless Chromium + mock IPC, so NOT end-to-end. It proves the daily, weekly
// and monthly rows are wired: a commit reaches the SETTER, the setter reaches the
// right COMMAND, and the value survives into the next `prefs_read`.
//
// **Why this tier at all, when the block has a component spec.** The component
// spec drives the block in isolation with mocked modules; this one renders the
// whole sheet, so a block that lost its mount, or a period whose write route
// drifted, fails here. It is also the tier that runs on every push.
//
// **The load-bearing assertion is the recorded command.** The mock resolves an
// UNMOCKED command to `[]`, so a spec that only checked the field's own value
// would pass against its optimistic draft with no command ever reaching the
// handler. Asserting on the recorded writes is what tells those two apart, and
// asserting on BOTH recorders is what proves the daily/periodic routing rather
// than merely that something was written.
//
// **What this tier cannot touch, and the roster owns instead:** a real
// `vault.prefs` write arriving over sync from another device, and which side of
// the §10.2 merge each field lands on. The mock answers whatever it was seeded
// with, so a spec here asserting those would be asserting the mock.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

const TEMPLATE_ID = "note-tpl-1";
const PLAIN_ID = "note-plain-1";
const TEMPLATE_BODY = "---\ntemplate: true\ntitle: Meeting\n---\n\nAgenda\n";
const PLAIN_BODY = "---\ntitle: Plain\n---\n\nBody\n";

type Seed = Parameters<typeof installMockIpc>[1];
function seed(extra: Seed = {}): Seed {
  return {
    notes: [
      { id: TEMPLATE_ID, text: TEMPLATE_BODY },
      { id: PLAIN_ID, text: PLAIN_BODY },
    ],
    ...extra,
  };
}

/** Settings → Editor, where the periodic-notes block sits below the toggles. */
async function openEditorPanel(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).first().click();
  await expect(page.getByText("Editor", { exact: true })).toBeVisible();
  await page.getByText("Editor", { exact: true }).click();
  // The block is below the editor toggles and the date/time fields, so it needs
  // scrolling into view before Playwright's visibility check passes on a
  // 390px-tall phone viewport.
  await page.getByTestId("settings.periodicNotes.folder").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("settings.periodicNotes")).toBeVisible();
}

type Win = {
  __dailyFolderWrites?: string[];
  __dailyFormatWrites?: string[];
  __dailyTemplateWrites?: (string | null)[];
  __periodicNoteWrites?: { period: string; setting: string; value: string | null }[];
};

const dailyFolderWrites = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__dailyFolderWrites ?? []);
const periodicWrites = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__periodicNoteWrites ?? []);
const dailyTemplateWrites = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__dailyTemplateWrites ?? []);

test.describe("mobile periodic-notes settings", () => {
  test("a daily folder commit writes the legacy field and not the periodic map", async ({ page }) => {
    await installMockIpc(page, seed());
    await page.goto("/");
    await openEditorPanel(page);

    const folder = page.getByTestId("settings.periodicNotes.folder");
    await folder.fill("Journal/");
    await page.getByTestId("settings.periodicNotes.folder-commit").click();

    // The real command fired, with the daily payload shape.
    await expect.poll(() => dailyFolderWrites(page)).toEqual(["Journal/"]);
    // And the map was NOT touched: daily writes its three legacy top-level
    // fields, which is the no-migration decision rather than an oversight.
    expect(await periodicWrites(page)).toEqual([]);
  });

  test("a weekly folder commit writes one periodic-map entry", async ({ page }) => {
    await installMockIpc(page, seed());
    await page.goto("/");
    await openEditorPanel(page);

    await page.getByTestId("settings.periodicNotes-period-weekly").click();
    const folder = page.getByTestId("settings.periodicNotes.folder");
    await expect(folder).toHaveValue("Weekly/");
    await folder.fill("Weeks/");
    await page.getByTestId("settings.periodicNotes.folder-commit").click();

    await expect.poll(() => periodicWrites(page)).toEqual([
      { period: "weekly", setting: "folder", value: "Weeks/" },
    ]);
    expect(await dailyFolderWrites(page)).toEqual([]);
  });

  test("the value survives a sheet reopen, so it is disk truth not the draft", async ({ page }) => {
    // The half that makes the write meaningful: the mock's prefs store is
    // stateful, so a reopen answers the next `prefs_read` with what was written.
    await installMockIpc(page, seed());
    await page.goto("/");
    await openEditorPanel(page);

    await page.getByTestId("settings.periodicNotes-period-weekly").click();
    // WAIT for the period switch to settle before typing. The block re-seeds the
    // folder draft from the newly selected period in a `useEffect`, so a `fill`
    // issued in the same tick as the segment click can land between the effect's
    // render and the DOM write: the field is momentarily "Weekly/" (the weekly
    // default) with the caret at the end, and Playwright's `fill` then appends
    // rather than replaces, committing "Weekly/Weeks/". Measured: without this
    // wait the test fails 8 of 8 in isolation, and the recorded write is the
    // appended path. The weekly test above already waits this way; this one
    // omitted it, which is the whole of the difference.
    await expect(page.getByTestId("settings.periodicNotes.folder")).toHaveValue("Weekly/");
    await page.getByTestId("settings.periodicNotes.folder").fill("Weeks/");
    await page.getByTestId("settings.periodicNotes.folder-commit").click();
    await expect.poll(() => periodicWrites(page)).toHaveLength(1);

    await page.mouse.click(195, 50);
    await expect(page.getByTestId("sheet.card")).toHaveCount(0);
    await openEditorPanel(page);
    await page.getByTestId("settings.periodicNotes-period-weekly").click();
    await expect(page.getByTestId("settings.periodicNotes.folder")).toHaveValue("Weeks/");
  });

  test("the template picker offers only template notes, and a tap writes the id", async ({ page }) => {
    await installMockIpc(page, seed());
    await page.goto("/");
    await openEditorPanel(page);

    await expect(page.getByTestId(`settings.periodicNotes.template-${TEMPLATE_ID}`)).toBeVisible();
    // A plain note is not offered: only `template: true` notes are.
    await expect(page.getByTestId(`settings.periodicNotes.template-${PLAIN_ID}`)).toHaveCount(0);

    await page.getByTestId(`settings.periodicNotes.template-${TEMPLATE_ID}`).click();
    await expect.poll(() => dailyTemplateWrites(page)).toEqual([TEMPLATE_ID]);

    await page.getByTestId("settings.periodicNotes.template-none").click();
    await expect.poll(() => dailyTemplateWrites(page)).toEqual([TEMPLATE_ID, null]);
  });
});
