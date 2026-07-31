// Flow-logic: Settings → Appearance → Custom themes (MYND-598 task 3).
// Headless Chromium + mock IPC — NOT end-to-end. It proves the read-only block
// renders both ways round: populated (name + a real swatch per row, the stored
// selection marked) and empty (helper line, no rows).
//
// The empty case is the load-bearing one. The block is deliberately rendered
// even with nothing in it, because its helper line is the only place the product
// tells the user that themes are installed on the computer — hiding the block
// would turn "you have installed none" into "sync looks broken".
//
// Applying a theme on tap and persisting the choice is task 4; this spec asserts
// only what is on screen, and asserts that the phone offers no way to author.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

/** Two seeded themes, given in the host's UTF-8 byte order (uppercase first) so
 *  the locale-collation assertion below is meaningful rather than incidental. */
const SEEDED = [
  {
    name: "Zinc",
    palette: {
      "--paper": "#101014",
      "--paper-2": "#191920",
      "--ink-1": "#e6e6ea",
      "--accent": "#7aa2f7",
      "--line-1": "#2a2a33",
    },
  },
  {
    name: "amber dusk",
    palette: {
      "--paper": "#fdf6e3",
      "--paper-2": "#f5ecd7",
      "--ink-1": "#3b3228",
      "--accent": "#b58900",
      "--line-1": "#e0d5bb",
    },
  },
];

async function openAppearance(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByText("Appearance", { exact: true }).click();
}

test.describe("mobile custom-themes list", () => {
  test("no themes installed → the block still renders, with its helper line", async ({ page }) => {
    await installMockIpc(page, { customThemes: [] });
    await page.goto("/");
    await openAppearance(page);

    const block = page.getByTestId("settings.custom-themes");
    await expect(block).toBeVisible();
    await expect(
      block.getByText("Custom themes are installed on your computer. Yours arrive here on their own after a sync.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByTestId("settings.custom-theme-row")).toHaveCount(0);
  });

  test("two themes → a row each with a real swatch, the stored one marked", async ({ page }) => {
    await installMockIpc(page, { customThemes: SEEDED, prefs: { custom_theme: "Zinc" } });
    await page.goto("/");
    await openAppearance(page);

    const rows = page.getByTestId("settings.custom-theme-row");
    await expect(rows).toHaveCount(2);
    // Collated in the reader's locale, NOT the store's byte order — byte order
    // would have put "Zinc" first.
    expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-theme-name")))).toEqual([
      "amber dusk",
      "Zinc",
    ]);
    await expect(rows.nth(0)).toContainText("amber dusk");
    await expect(rows.nth(1)).toContainText("Zinc");

    // The row named by `custom_theme` is the marked one, and only it.
    await expect(rows.nth(0)).toHaveAttribute("data-selected", "false");
    await expect(rows.nth(1)).toHaveAttribute("data-selected", "true");
    await expect(rows.nth(1)).toContainText("Applied");

    // The swatch is drawn from that row's OWN palette: five cells, each carrying
    // the colour the seeded palette gave for that role. Asserting the resolved
    // values (not merely "non-empty") is what proves the preview is per-theme
    // rather than a shared placeholder strip.
    const swatchColors = await page
      .getByTestId("settings.custom-theme-swatch")
      .nth(0)
      .evaluate((el) =>
        Array.from(el.children).map((c) => getComputedStyle(c as HTMLElement).backgroundColor),
      );
    expect(swatchColors).toEqual([
      "rgb(253, 246, 227)",
      "rgb(245, 236, 215)",
      "rgb(59, 50, 40)",
      "rgb(181, 137, 0)",
      "rgb(224, 213, 187)",
    ]);

    // Read-only, and visibly so: no authoring affordance anywhere in the panel.
    // (Task 4 makes the ROW itself the apply control — there is still no button.)
    for (const label of ["Import theme…", "Export", "Delete", "Apply"]) {
      await expect(page.getByRole("button", { name: label })).toHaveCount(0);
    }
  });
});
