// Flow-logic: Settings → Data → the attachment image-OCR switch
// (MYND-441, switchable on mobile in myne-md/myne#880).
// Headless Chromium + mock IPC, so NOT end-to-end.
//
// **Why this row gets a flow spec.** It is a row with real behaviour and no
// visual judgement, so a machine can judge it, which is the roster's own test
// for what belongs in the automated column. The component spec drives the block
// with mocked modules; this one renders the whole sheet, so a block that lost
// its mount fails here.
//
// **What this tier cannot touch, and the roster owns instead:** whether the Rust
// import path actually declines an image when the pref is off. The mock answers
// whatever it was seeded with, and the extractor selection is a Rust path; that
// half is asserted by `import_mobile.rs`'s own tests, not here.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

const NOTE_ID = "note-ocr-1";
const BODY = `---\ntitle: Draft\n---\n\nHello.\n`;

type Seed = Parameters<typeof installMockIpc>[1];
function seed(extra: Seed = {}): Seed {
  return { noteIds: [NOTE_ID], noteBodies: { [NOTE_ID]: BODY }, ...extra };
}

/** Settings → Data, where the OCR switch sits below the export row. */
async function openDataPanel(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).first().click();
  await expect(page.getByText("Data", { exact: true })).toBeVisible();
  await page.getByText("Data", { exact: true }).click();
  await expect(page.getByTestId("settings.attachmentOcr")).toBeVisible();
}

type Win = { __attachmentOcrWrites?: boolean[] };
const ocrWrites = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__attachmentOcrWrites ?? []);

test.describe("mobile attachment OCR switch", () => {
  test("turning it off writes the pref, and the choice survives a reopen", async ({ page }) => {
    await installMockIpc(page, seed());
    await page.goto("/");
    await openDataPanel(page);

    await expect(page.getByTestId("settings.attachmentOcr.toggle")).toHaveAttribute("data-on", "true");
    await page.getByTestId("settings.attachmentOcr.toggle").click();

    await expect.poll(() => ocrWrites(page)).toEqual([false]);

    // The mock's prefs store is stateful, so a reopen answers the next
    // `prefs_read` with what was written rather than with the seed.
    await page.mouse.click(195, 50);
    await expect(page.getByTestId("sheet.card")).toHaveCount(0);
    await openDataPanel(page);
    await expect(page.getByTestId("settings.attachmentOcr.toggle")).toHaveAttribute("data-on", "false");
  });

  test("an inherited off value renders off, and turning it back on writes true", async ({ page }) => {
    await installMockIpc(page, seed({ prefs: { attachment_ocr_enabled: false } }));
    await page.goto("/");
    await openDataPanel(page);

    await expect(page.getByTestId("settings.attachmentOcr.toggle")).toHaveAttribute("data-on", "false");
    await page.getByTestId("settings.attachmentOcr.toggle").click();

    await expect.poll(() => ocrWrites(page)).toEqual([true]);
  });
});
