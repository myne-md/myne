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
// The apply half (MYND-598 task 4) is the second describe below: one tap applies
// the row's own palette and persists the choice to the `custom_theme` pref, and
// picking a built-in theme afterwards takes both back. What must NOT happen is
// asserted just as hard — no second read command for a palette the list already
// handed over, and nothing about the theme in `localStorage`.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";
import { closeSheet, customThemeWrites, rootCustomProps, SEEDED_THEMES } from "../helpers";

async function openAppearance(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByText("Appearance", { exact: true }).click();
}

test.describe("mobile custom-themes list", () => {
  test("no themes installed → the block is ABSENT, not an empty card", async ({ page }) => {
    await installMockIpc(page, { customThemes: [] });
    await page.goto("/");
    await openAppearance(page);

    // 0.17.0 owner pass: a read-only block with nothing in it is a row whose only
    // content is "none yet", and the Appearance panel above it already reads as
    // populated. The scope sentence travels with the list it describes.
    await expect(page.getByTestId("settings.custom-themes")).toHaveCount(0);
    await expect(page.getByTestId("settings.custom-theme-row")).toHaveCount(0);
  });

  test("two themes → a row each with a real swatch, the stored one marked", async ({ page }) => {
    await installMockIpc(page, { customThemes: SEEDED_THEMES, prefs: { custom_theme: "Zinc" } });
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
    // The ROW itself is the apply control, so there is still no button.
    for (const label of ["Import theme…", "Export", "Delete", "Apply"]) {
      await expect(page.getByRole("button", { name: label })).toHaveCount(0);
    }
  });
});

/** How many times the palette-bearing list command was called. */
const listCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __themesListCalls?: number }).__themesListCalls ?? 0);

const row = (page: Page, name: string) => page.locator(`[data-theme-name="${name}"]`);

test.describe("mobile custom-themes apply", () => {
  test("tapping a row applies that palette and persists the selection", async ({ page }) => {
    await installMockIpc(page, { customThemes: SEEDED_THEMES });
    await page.goto("/");
    await openAppearance(page);

    await row(page, "Zinc").click();

    // Persisted by NAME (the palette is vault content and never leaves the vault
    // to be stored anywhere else), and marked as applied.
    await expect.poll(() => customThemeWrites(page)).toEqual(["Zinc"]);
    await expect(row(page, "Zinc")).toHaveAttribute("data-selected", "true");
    await expect(row(page, "amber dusk")).toHaveAttribute("data-selected", "false");

    // Painted: the row's own palette is on the document root, and the built-in
    // `data-theme` attribute is gone (a custom theme supersedes light/dark).
    const props = await rootCustomProps(page);
    expect(props["--paper"]).toBe("#101014");
    expect(props["--accent"]).toBe("#7aa2f7");
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBeNull();
    // Zinc is a dark palette that defines none of the 12 syntax roles, so the
    // canon seed filled them from the DARK ramp: the inline value is the
    // resolved dark colour, not the light `:root` default the dropped
    // `data-theme` would otherwise expose. Compared against the ramp the
    // stylesheet declares rather than a literal, so a sheet value change does
    // not redden this, and proof the applier ran end-to-end rather than only
    // writing the keys the palette carried.
    const darkSyntaxRamp = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--_syntax-keyword-dark").trim(),
    );
    expect(darkSyntaxRamp).not.toBe("");
    expect(props["--syntax-keyword"]).toBe(darkSyntaxRamp);

    // ONE list call, and no read: the palette came from the entry the list
    // already handed over. (`themes_read` is mocked as the ACL rejection it is
    // on a device, so reaching for it would fail this test loudly.)
    expect(await listCalls(page)).toBe(1);

    // Nothing about the theme reaches plaintext device storage — not the name,
    // not the palette. localStorage keeps ONLY its built-in boot-cache job.
    const stored = await page.evaluate(() =>
      Object.fromEntries(Object.entries(localStorage).map(([k, v]) => [k, String(v)])),
    );
    expect(JSON.stringify(stored)).not.toContain("Zinc");
    expect(JSON.stringify(stored)).not.toContain("#101014");
    expect(stored["myne.theme"] ?? "system").toMatch(/^(system|light|dark|amoled)$/);

    // Survives a remount: the reopened panel reads the selection off the prefs
    // store, not off the draft the tap left behind.
    await closeSheet(page);
    await openAppearance(page);
    await expect(row(page, "Zinc")).toHaveAttribute("data-selected", "true");
  });

  test("picking a built-in theme clears the custom selection and its properties", async ({ page }) => {
    await installMockIpc(page, { customThemes: SEEDED_THEMES });
    await page.goto("/");
    await openAppearance(page);

    await row(page, "amber dusk").click();
    await expect.poll(() => customThemeWrites(page)).toEqual(["amber dusk"]);
    expect((await rootCustomProps(page))["--accent"]).toBe("#b58900");

    await page.getByText("Dark", { exact: true }).click();

    // The palette is gone — every custom property the applier wrote, not merely
    // the ones the built-in theme happens to redefine — and so is the selection.
    // Polled, not read once: the clear is DISK-FIRST (`pickTheme`), so the write
    // lands before the screen does and an immediate read would race the revert.
    await expect.poll(() => customThemeWrites(page)).toEqual(["amber dusk", null]);
    await expect.poll(() => rootCustomProps(page)).toEqual({});
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("dark");
    await expect(row(page, "amber dusk")).toHaveAttribute("data-selected", "false");

    // And it stays cleared on disk, not just on screen.
    await closeSheet(page);
    await openAppearance(page);
    await expect(row(page, "amber dusk")).toHaveAttribute("data-selected", "false");
  });

  // The clear is disk-first for the reason this test states: the two paths must
  // never leave the phone wearing one theme while `vault.prefs` names another,
  // because the disagreement is invisible until the NEXT unlock paints the
  // palette back over a built-in choice the user thought they had made.
  test("a failed clear changes nothing — screen and disk stay in agreement", async ({ page }) => {
    await installMockIpc(page, {
      customThemes: SEEDED_THEMES,
      prefs: { custom_theme: "amber dusk" },
      customThemeWriteFails: true,
    });
    await page.goto("/");
    // The boot paint already put the seeded selection on the root.
    expect((await rootCustomProps(page))["--accent"]).toBe("#b58900");
    await openAppearance(page);

    await page.getByText("Dark", { exact: true }).click();

    await expect(page.getByText("Couldn't save that setting", { exact: true })).toBeVisible();
    // Still the custom theme, on screen and in the panel — not a half-applied
    // built-in choice over a selection the vault still holds.
    expect((await rootCustomProps(page))["--accent"]).toBe("#b58900");
    await expect(row(page, "amber dusk")).toHaveAttribute("data-selected", "true");
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBeNull();
  });
});
