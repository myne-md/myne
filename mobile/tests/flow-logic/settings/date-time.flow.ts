// Flow-logic: Settings → Editor → date, time and time zone (myne-md/myne#609).
// Headless Chromium + mock IPC, so NOT end-to-end. It proves the three rows are
// wired: a pick reaches the setter, and the zone field's two failure paths put
// the stored value back rather than leaving a value the vault does not hold.
//
// **Why this tier at all, when the surface already has a manual roster item.**
// The half that made this feature inert on mobile in the first place was wiring:
// a control that renders, reads a preference, and calls nothing. That is exactly
// what a mocked IPC can assert cheaply and on every push, and the lane it runs in
// (`mobile-flow-logic`) executes on every push, unlike the desktop E2E lane,
// which has been manual and pre-release only since myne-md/myne#579.
//
// **What this tier cannot touch, and the roster owns instead:** a real
// `vault.prefs` write arriving over sync from another device, and which side of
// the merge each of the three fields lands on. The mock answers whatever it was
// seeded with, so a spec here asserting those would be asserting the mock.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

const NOTE_ID = "note-date-time-1";
const BODY = `---\ntitle: Draft\n---\n\n- [ ] pay rent [due:: 2026-08-01]\n`;

/** Seed the same way the sibling settings specs do: the shell needs a vault
 *  with at least one note before Settings is reachable. */
type Seed = Parameters<typeof installMockIpc>[1];
function seed(extra: Seed = {}): Seed {
  return { noteIds: [NOTE_ID], noteBodies: { [NOTE_ID]: BODY }, ...extra };
}

/** Settings → Editor, where the date and time block lives. */
async function openEditorPanel(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).first().click();
  // Wait for the rail before clicking into it: without this the click can land
  // before the sheet mounts and the run then times out on the panel's contents
  // with a page snapshot showing the notes list, which reads as a missing testid
  // rather than a race.
  await expect(page.getByText("Editor", { exact: true })).toBeVisible();
  await page.getByText("Editor", { exact: true }).click();
  // The block sits below the editor toggles, so it needs scrolling into view
  // before Playwright's visibility check will pass on a 390px-tall phone
  // viewport.
  await page.getByTestId("settings.dateTime.date-select").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("settings.dateTime.date-select")).toBeVisible();
}

type Win = {
  __dateFormatWrites?: (string | null)[];
  __timeFormatWrites?: (string | null)[];
  __timezoneWrites?: (string | null)[];
};

test.describe("mobile date and time settings", () => {
  test("picking a date format reaches the setter", async ({ page }) => {
    await installMockIpc(page, seed());
    await page.goto("/");
    await openEditorPanel(page);

    const select = page.getByTestId("settings.dateTime.date-select");
    await expect(select).toBeVisible();
    await select.selectOption("dmy");

    await expect
      .poll(() => page.evaluate(() => (window as unknown as Win).__dateFormatWrites))
      .toEqual(["dmy"]);
  });

  test("choosing the system option CLEARS the stored value rather than storing a name", async ({
    page,
  }) => {
    // `null` is what the blob omits, and the mapping lives in one place for the
    // reason the block's own comment gives: it was written four times and had to
    // agree.
    await installMockIpc(page, seed({ prefs: { date_format: "dmy" } }));
    await page.goto("/");
    await openEditorPanel(page);

    await page.getByTestId("settings.dateTime.date-select").selectOption("system");

    await expect
      .poll(() => page.evaluate(() => (window as unknown as Win).__dateFormatWrites))
      .toEqual([null]);
  });

  test("picking a time format reaches its setter through the segmented control", async ({
    page,
  }) => {
    await installMockIpc(page, seed());
    await page.goto("/");
    await openEditorPanel(page);

    // A HYPHEN before the value. `Segmented` derives its segment testids as
    // `${testIdPrefix}-${value}`, which the reminders flow tier also reads
    // (`settings.reminders-horizon-picker-1`). This read a dot until
    // myne-md/myne#609 met develop's component at a merge.
    await page.getByTestId("settings.dateTime.time-segmented-24h").click();

    await expect
      .poll(() => page.evaluate(() => (window as unknown as Win).__timeFormatWrites))
      .toEqual(["24h"]);
  });

  test("a zone this runtime cannot format is REFUSED, and the field goes back", async ({
    page,
  }) => {
    // The row shows a zone, the vault holds a different one, and dismissing the
    // sheet makes the wrong one look settled. That is the reading the restore
    // exists to remove.
    await installMockIpc(page, seed({ prefs: { timezone: "Europe/Berlin" } }));
    await page.goto("/");
    await openEditorPanel(page);

    const zone = page.getByTestId("settings.dateTime.zone-input");
    await expect(zone).toHaveValue("Europe/Berlin");
    await zone.fill("Not/AZone");
    await zone.press("Enter");

    await expect(zone).toHaveValue("Europe/Berlin");
    await expect
      .poll(() => page.evaluate(() => (window as unknown as Win).__timezoneWrites ?? []))
      .toEqual([]);
  });

  test("Enter commits, not blur alone", async ({ page }) => {
    // On Android the hardware back button dismisses this sheet without ever
    // blurring the focused field, so a blur-only commit silently discarded a
    // zone the reader had typed and considered entered.
    await installMockIpc(page, seed());
    await page.goto("/");
    await openEditorPanel(page);

    const zone = page.getByTestId("settings.dateTime.zone-input");
    await zone.fill("Europe/Istanbul");
    await zone.press("Enter");

    await expect
      .poll(() => page.evaluate(() => (window as unknown as Win).__timezoneWrites))
      .toEqual(["Europe/Istanbul"]);
  });

  test("a zone whose WRITE fails puts the stored value back too", async ({ page }) => {
    // The other half of the same rule, and the one the validation branch does
    // not cover: the value is a real zone, so it passes the check and the write
    // is what rejects.
    await installMockIpc(page, seed({
      prefs: { timezone: "Europe/Berlin" },
      timezoneWriteFails: true,
    }));
    await page.goto("/");
    await openEditorPanel(page);

    const zone = page.getByTestId("settings.dateTime.zone-input");
    await zone.fill("Europe/Istanbul");
    await zone.press("Enter");

    await expect
      .poll(() => page.evaluate(() => (window as unknown as Win).__timezoneWrites))
      .toEqual(["Europe/Istanbul"]);
    await expect(zone).toHaveValue("Europe/Berlin");
  });
});
