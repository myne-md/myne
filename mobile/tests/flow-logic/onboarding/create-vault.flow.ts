// Flow-logic: the first-run vault-creation onboarding (E2E-gap #5, the primary
// path every new user takes). Headless Chromium + mock IPC — NOT end-to-end (no
// real Argon2id, no on-disk vault). What IS flow-testable: the full
// Welcome → briefing → name → password → recovery kit → type-back (which commits)
// → auto-unlock → editor chain drives the real begin/commit/unlock IPC wrappers.
//
// The shape changed in myne-md/myne#468: a vault-NAME step opens the flow, the
// phrase and account-number steps merged into one recovery kit, and the
// type-back's own button is the commit. The account step's "I have saved my
// account number" checkbox is gone rather than moved — `protocol.md` §7.1.3 says
// a bare checkbox is not evidence, and the type-back already is.
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

    // Welcome (fresh install, no vaults).
    // "Create a local vault instead", not "Create a vault": the mobile Welcome
    // became identity-first in myne-md/myne#768 and that label went with it, so
    // this lookup had been waiting thirty seconds for a button that no longer
    // exists. Nothing reported it — a Playwright label is not typechecked, and a
    // stale one reads as a hung app rather than as a renamed control.
    await page.getByRole("button", { name: "Create a local vault instead" }).click();

    // The safety briefing (first-run only, and unnumbered for that reason).
    await ackBriefing(page);

    // Step 1 — name the vault. Named rather than skipped: the value is written as
    // the vault's label after the auto-unlock, and it heads the recovery kit.
    await page.getByTestId("create-vault.name-input").fill("Flow Kasa");
    await page.getByTestId("create-vault.name-continue").click();

    // Step 2 — password + confirm (two masked inputs, no testids).
    const pwInputs = page.locator('input[type="password"]');
    await expect(pwInputs).toHaveCount(2);
    await pwInputs.nth(0).fill("correct horse battery staple");
    await pwInputs.nth(1).fill("correct horse battery staple");
    await page.getByRole("button", { name: "Continue" }).click();

    // Encrypting overlay auto-advances (mock `begin` resolves instantly) to the
    // recovery kit. Step 3 — BOTH secrets in one sheet, which is the merge: the
    // account number has no step of its own to arrive on later.
    await expect(page.getByTestId("create-vault.kit-sheet")).toBeVisible();
    await expect(page.getByTestId("create-vault.kit-meta")).toHaveText("Flow Kasa");
    await page.getByRole("button", { name: /Show words/ }).click();

    // Save writes the KIT — both secrets, from the shared `recoveryKitText` the
    // desktop uses — not the phrase the step this replaced wrote. A save path
    // still writing only the phrase reports the same success sentence, so the
    // contents are read off the IPC. Shape only, never printed.
    await page.getByTestId("create-vault.kit-save").click();
    const saved = await page.evaluate(async () => {
      const w = window as unknown as { __secretSaves?: { path: string; contents: string }[] };
      for (let i = 0; i < 50 && (w.__secretSaves ?? []).length === 0; i++) {
        await new Promise((r) => setTimeout(r, 40));
      }
      return w.__secretSaves ?? [];
    });
    expect(saved.length, "nothing was written").toBe(1);
    expect(saved[0].path.endsWith("myne-recovery-kit.txt")).toBe(true);
    const lines = saved[0].contents.split("\n").map((l: string) => l.trim());
    expect(
      lines.some((l: string) => l.split(/\s+/).length === 24),
      "no 24-word line in the saved kit",
    ).toBe(true);
    expect(
      lines.some((l: string) => /^MY(-[0-9A-Z]{4}){4}-[0-9A-Z]$/.test(l)),
      "no account number in the saved kit",
    ).toBe(true);
    expect(saved[0].contents.includes("Flow Kasa"), "the kit does not name its vault").toBe(
      true,
    );

    await page.getByRole("button", { name: "I've written them down" }).click();

    // Step 4 — type-back, and its own button COMMITS. There is no fifth step and
    // no acknowledgement checkbox between the two.
    const wordCells = page.locator("input");
    await expect(wordCells).toHaveCount(4);
    for (let i = 0; i < 4; i++) await wordCells.nth(i).fill(PHRASE_WORD);
    await expect(
      page.getByText("I have saved my account number"),
      "the acknowledgement checkbox came back",
    ).toHaveCount(0);
    await page.getByTestId("create-vault.commit").click();

    // Ready → open the new vault → editor.
    await page.getByRole("button", { name: "Open vault" }).click();
    await expect(page.getByTestId("workspace.app-header")).toBeVisible();

    // The name becomes the vault's LABEL, and it has to happen after the unlock:
    // `prefs|vault_set_label` writes under the active vault's `prefs_key`, so it
    // is unlock-gated and there is no slot to write into during creation. Every
    // way this breaks is quiet — writing at commit time rejects with
    // `SlotNotUnlocked` on a flow that has already succeeded, and an empty label
    // is a legitimate value meaning "no name". So the user names their vault,
    // lands in the editor, and finds it called "Vault 2".
    expect(
      await page.evaluate(
        () => (window as unknown as { __vaultLabelWrites?: (string | null)[] }).__vaultLabelWrites ?? [],
      ),
    ).toEqual(["Flow Kasa"]);
  });

  test("a vault left unnamed writes no label at all", async ({ page }) => {
    // Blank is a legitimate answer on the name step, and the right result is the
    // picker's neutral fallback rather than a written `null`: the two look
    // identical to a user and one of them costs a prefs write on every unnamed
    // vault. An assertion on an ABSENCE, so the walk to the editor is the control
    // that proves the flow ran at all.
    await installMockIpc(page, { freshDevice: true });
    await page.goto("/");
    await page.getByRole("button", { name: "Create a local vault instead" }).click();
    await ackBriefing(page);

    // Straight past the name step without typing, which is the point.
    await page.getByTestId("create-vault.name-continue").click();

    const pwInputs = page.locator('input[type="password"]');
    await expect(pwInputs).toHaveCount(2);
    await pwInputs.nth(0).fill("correct horse battery staple");
    await pwInputs.nth(1).fill("correct horse battery staple");
    await page.getByRole("button", { name: "Continue" }).click();

    await page.getByRole("button", { name: /Show words/ }).click();
    await page.getByRole("button", { name: "I've written them down" }).click();
    const wordCells = page.locator("input");
    await expect(wordCells).toHaveCount(4);
    for (let i = 0; i < 4; i++) await wordCells.nth(i).fill(PHRASE_WORD);
    await page.getByTestId("create-vault.commit").click();
    await page.getByRole("button", { name: "Open vault" }).click();
    await expect(page.getByTestId("workspace.app-header")).toBeVisible();

    expect(
      await page.evaluate(
        () => (window as unknown as { __vaultLabelWrites?: (string | null)[] }).__vaultLabelWrites ?? [],
      ),
    ).toEqual([]);
  });
});
