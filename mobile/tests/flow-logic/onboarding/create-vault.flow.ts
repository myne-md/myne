// Flow-logic: the 5-step first-run vault-creation onboarding (E2E-gap #5, the
// primary path every new user takes). Headless Chromium + mock IPC — NOT
// end-to-end (no real Argon2id, no on-disk vault). What IS flow-testable: the
// full Welcome → briefing → password → phrase → type-back → account → commit →
// auto-unlock → editor chain drives the real begin/commit/unlock IPC wrappers.
//
// The mock `begin` returns 24× the same word so the RANDOM 4-word type-back
// challenge is satisfiable by typing that word everywhere (the flow picks four
// random positions we can't predict).

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

const PHRASE_WORD = "ribbon";

async function ackBriefing(page: Page): Promise<void> {
  // Three acknowledgement rows must all be checked before Continue enables.
  for (const fragment of [
    "Myne has no access to my notes",
    "There is no password reset",
    "recovery phrase is the only way back",
  ]) {
    await page.getByText(fragment, { exact: false }).first().click();
  }
  await page.getByRole("button", { name: "Continue" }).click();
}

test.describe("mobile create-vault onboarding", () => {
  test("Welcome → … → commit → auto-unlock → editor", async ({ page }) => {
    await installMockIpc(page, { freshDevice: true });
    await page.goto("/");

    // Welcome (fresh install, no vaults). First run is identity-first
    // (myne-md/myne#768), so the vault door is the "Create a local vault
    // instead" ghost button, beside the "Create an identity" primary.
    await page.getByRole("button", { name: "Create a local vault instead" }).click();

    // Step 1 — safety briefing.
    await ackBriefing(page);

    // Step 2 — password + confirm (two masked inputs, no testids).
    const pwInputs = page.locator('input[type="password"]');
    await expect(pwInputs).toHaveCount(2);
    await pwInputs.nth(0).fill("correct horse battery staple");
    await pwInputs.nth(1).fill("correct horse battery staple");
    await page.getByRole("button", { name: "Continue" }).click();

    // Encrypting overlay auto-advances (mock `begin` resolves instantly) to the
    // recovery-phrase reveal.
    await page.getByRole("button", { name: /Show words/ }).click();
    await page.getByRole("button", { name: "I've written them down" }).click();

    // Step 3 — type-back: fill all four challenge cells with the (uniform) word.
    const wordCells = page.locator("input");
    await expect(wordCells).toHaveCount(4);
    for (let i = 0; i < 4; i++) await wordCells.nth(i).fill(PHRASE_WORD);
    await page.getByRole("button", { name: "Continue" }).click();

    // Step 4 — account number: acknowledge saved, then commit.
    await page.getByText("I have saved my account number").click();
    await page.getByRole("button", { name: "Commit" }).click();

    // Step 5 — ready → open the new vault → editor.
    await page.getByRole("button", { name: "Open vault" }).click();
    await expect(page.getByTestId("workspace.app-header")).toBeVisible();
  });
});
