// Mobile review evidence for myne-md/myne#1049.
//
// The desktop frames come from the tauri-driver container (scripts/capture-ux-fixes.sh);
// the phone cannot use that seat at all, so this file drives the same headless
// Chromium + mock-IPC harness the flow-logic tier already uses and writes PNGs to
// e2e/artifacts/ux-fixes-mobile/. It is a CAPTURE tool, not a test: nothing here
// asserts, so a frame that cannot be reached is logged and skipped.
//
// Run from mobile/: `pnpm exec playwright test --config=ux-fixes-capture.config.ts`

import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { installMockIpc } from "./mock-ipc";

const OUT = "../e2e/artifacts/ux-fixes-mobile";

async function shot(page: import("@playwright/test").Page, name: string): Promise<void> {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  // eslint-disable-next-line no-console
  console.log(`[ux-mobile] OK ${name}.png`);
}

async function openSettings(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).first().click();
}

test("mobile frames", async ({ page }) => {
  // A capture pass drives seven screens; the harness default of 30s is a TEST
  // budget and this is not a test.
  test.setTimeout(180_000);
  mkdirSync(OUT, { recursive: true });
  await installMockIpc(page, {
    pendingCaptures: [],
    quickUnlock: { configured: false, method: "pin", available: true },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).first().waitFor();

  // The root roster: the panel list, in the order a phone user meets it.
  await openSettings(page);
  await shot(page, "m1-settings-root");

  // Vault: the name is a field with its save button and the rename notice, not a
  // drill-down, and quick unlock is one row with a switch.
  await page.getByTestId("settings.category-vault").click();
  await shot(page, "m2-settings-vault");

  // Quick unlock. On this branch the row IS a switch and turning it on opens the
  // setup inline; on the merge base the same testid is a drill-down row, so the
  // capture drives whichever shape it finds. That difference is the frame's
  // whole point, and a capture tool that only knew one shape would photograph
  // the base as a failure.
  const quRow = page.getByTestId("settings.quick-unlock-row");
  const quSwitch = quRow.getByRole("switch");
  if ((await quSwitch.count()) > 0) await quSwitch.click();
  else await quRow.click();
  await shot(page, "m3-settings-quickunlock");

  // Editor: default view, archiving with its sentence, typewriter. Each
  // category is reached from a FRESH load rather than by walking back out of the
  // previous one: the sheet's back affordance is a row, not a button with a
  // stable name, and a capture tool should not depend on the navigation it is
  // photographing.
  // The root roster gives only `vault` and `ai` a testid (they are the two rows
  // with a live value in the column), so the rest are reached by their own label.
  for (const [label, name] of [
    ["Editor", "m4-settings-editor"],
    ["Appearance", "m5-settings-appearance"],
    ["AI", "m6-settings-ai"],
    ["About", "m7-settings-about"],
  ] as const) {
    await page.goto("/");
    await page.getByRole("button", { name: "Settings" }).first().click();
    await page.getByText(label, { exact: true }).click();
    await shot(page, name);
  }
});
