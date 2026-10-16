// Flow-logic: Settings → Editor → the gated spell row (myne-md/myne#880).
// Headless Chromium + mock IPC, so NOT end-to-end. What it proves is that the
// row STATES its absence rather than sitting there inert: the switch is
// disabled, the helper sentence names the reason, and a tap changes nothing.
//
// **Why this tier, when the same property has a component spec.** The component
// spec (`tests/components/SpellRowGate.test.tsx`) reads the source and renders
// the shared switch; this one renders the WHOLE sheet through the real editor
// panel, so a row that lost its gate by being re-rendered elsewhere fails here.
// It is also the tier that runs on every push.
//
// **What this tier cannot touch, and the roster owns instead:** whether a real
// mobile editor draws a squiggle once a dictionary ships. There is no dictionary
// on this client and no `spell` slot in `mobile/src/editor-host.ts`, which is
// the fact the gate rests on; the mock IPC would answer for either world.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

const NOTE_ID = "note-spell-1";
const BODY = `---\ntitle: Draft\n---\n\nHello wrold.\n`;

type Seed = Parameters<typeof installMockIpc>[1];
function seed(extra: Seed = {}): Seed {
  return { noteIds: [NOTE_ID], noteBodies: { [NOTE_ID]: BODY }, ...extra };
}

/** Settings → Editor, where the spell row is the first of the toggle group. */
async function openEditorPanel(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).first().click();
  await expect(page.getByText("Editor", { exact: true })).toBeVisible();
  await page.getByText("Editor", { exact: true }).click();
  await expect(page.getByTestId("settings.spell-row")).toBeVisible();
}

test.describe("mobile spell row", () => {
  test("states that spell checking is unavailable and cannot be turned on", async ({ page }) => {
    await installMockIpc(page, seed());
    await page.goto("/");
    await openEditorPanel(page);

    const row = page.getByTestId("settings.spell-row");
    await expect(row).toBeVisible();
    // The row is VISIBLE, not hidden: the point of gating rather than removing
    // is that the absence is stated.
    await expect(row).toContainText("Spell check");
    await expect(row).toContainText("not available on this phone");

    const sw = row.getByRole("switch");
    await expect(sw).toHaveAttribute("aria-disabled", "true");
    const before = await sw.getAttribute("aria-checked");

    // A tap must change nothing. `Switch` drops its click handler when
    // disabled, so this is the observable half of the gate.
    await sw.click({ force: true });
    await expect(sw).toHaveAttribute("aria-checked", before ?? "true");
  });

  test("the gate is not a styling trick: the sentence and the switch agree", async ({ page }) => {
    // Seeded with the pref explicitly ON, which is the state a desktop could
    // have synced in. The row still refuses, and that is the property: the gate
    // is the client's backend, not the stored value.
    await installMockIpc(page, seed({ prefs: { spell_enabled: true } }));
    await page.goto("/");
    await openEditorPanel(page);

    const row = page.getByTestId("settings.spell-row");
    const sw = row.getByRole("switch");
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await expect(sw).toHaveAttribute("aria-disabled", "true");
    await sw.click({ force: true });
    await expect(sw).toHaveAttribute("aria-checked", "true");
  });
});
