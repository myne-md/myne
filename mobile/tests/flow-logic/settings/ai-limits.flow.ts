// Flow-logic: Settings → AI → the meeting prompt and the chat-history budget
// (myne-md/myne#617 and meeting-ai, reached mobile in myne-md/myne#880).
// Headless Chromium + mock IPC, so NOT end-to-end.
//
// **Why the prompt row gets a flow spec and not only a component one.** It is
// the row whose absence was the sharpest: the phone is where meeting capture
// HAPPENS, so the device that records a meeting could not author the instruction
// that processes it. The component spec drives the block with mocked modules;
// this one renders the whole sheet, so a block that lost its mount fails here.
//
// **What this tier cannot touch, and the roster owns instead:** whether a real
// drained meeting capture then uses the new prompt. The mock answers whatever it
// was seeded with, and the meeting drain is a Rust path; a spec asserting it here
// would be asserting the mock.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

const NOTE_ID = "note-ai-limits-1";
const BODY = `---\ntitle: Draft\n---\n\nHello.\n`;

type Seed = Parameters<typeof installMockIpc>[1];
function seed(extra: Seed = {}): Seed {
  return { noteIds: [NOTE_ID], noteBodies: { [NOTE_ID]: BODY }, ...extra };
}

/** Settings → AI, where the two limit rows sit below the provider rows. */
async function openAiPanel(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).first().click();
  await expect(page.getByText("AI", { exact: true })).toBeVisible();
  await page.getByText("AI", { exact: true }).click();
  // The limit rows sit behind the Advanced disclosure (0.17.0 owner pass: the
  // panel leads with the switches a user changes, not with the ones that bound
  // them). A flow spec that skipped this row was asserting a layout nobody ships.
  await page.getByTestId("settings.ai.advanced-row").click();
  await page.getByTestId("settings.aiLimits.budget").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("settings.aiLimits")).toBeVisible();
}

type Win = {
  __meetingPromptWrites?: (string | null)[];
  __chatBudgetWrites?: (number | null)[];
};

const promptWrites = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__meetingPromptWrites ?? []);
const budgetWrites = (page: Page) =>
  page.evaluate(() => (window as unknown as Win).__chatBudgetWrites ?? []);

test.describe("mobile AI limits", () => {
  test("editing the meeting prompt writes it, and it survives a reopen", async ({ page }) => {
    await installMockIpc(page, seed());
    await page.goto("/");
    await openAiPanel(page);

    const field = page.getByTestId("settings.aiLimits.meetingPrompt");
    await field.fill("Summarise in three bullets.");
    await page.getByTestId("settings.aiLimits.prompt-commit").click();

    await expect.poll(() => promptWrites(page)).toEqual(["Summarise in three bullets."]);

    // The mock's prefs store is stateful, so a reopen answers the next
    // `prefs_read` with what was written rather than with the seed.
    await page.mouse.click(195, 50);
    await expect(page.getByTestId("sheet.card")).toHaveCount(0);
    await openAiPanel(page);
    await expect(page.getByTestId("settings.aiLimits.meetingPrompt")).toHaveValue(
      "Summarise in three bullets.",
    );
  });

  test("the budget is editable on the phone that enforces it", async ({ page }) => {
    await installMockIpc(page, seed({ prefs: { chat_history_budget: 2000 } }));
    await page.goto("/");
    await openAiPanel(page);

    const field = page.getByTestId("settings.aiLimits.budget");
    await expect(field).toHaveValue("2000");
    await field.fill("4000");
    await page.getByTestId("settings.aiLimits.budget-commit").click();

    await expect.poll(() => budgetWrites(page)).toEqual([4000]);
  });
});
