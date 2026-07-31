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

type Page = import("@playwright/test").Page;

async function openAppearance(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByText("Appearance", { exact: true }).click();
}

/** Every `--*` custom property currently set on `<html>` by the CSSOM, as a
 *  `key → value` map. Reading the style attribute's own key list (rather than a
 *  computed value) is what distinguishes "the applier wrote it" from "a stylesheet
 *  happened to define it", which is the whole point of the revert assertions. */
function rootCustomProps(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const s = document.documentElement.style;
    const out: Record<string, string> = {};
    for (let i = 0; i < s.length; i++) {
      const key = s.item(i);
      if (key.startsWith("--")) out[key] = s.getPropertyValue(key);
    }
    return out;
  });
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
    // The ROW itself is the apply control, so there is still no button.
    for (const label of ["Import theme…", "Export", "Delete", "Apply"]) {
      await expect(page.getByRole("button", { name: label })).toHaveCount(0);
    }
  });
});

/** Every `custom_theme` value written through `plugin:prefs|set_custom_theme`. */
const themeWrites = (page: Page) =>
  page.evaluate(() => (window as unknown as { __customThemeWrites?: (string | null)[] }).__customThemeWrites ?? []);

/** How many times the palette-bearing list command was called. */
const listCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __themesListCalls?: number }).__themesListCalls ?? 0);

/** Dismiss the Settings sheet by tapping the backdrop above the card — the
 *  Sheet's only programmatic exit (no close button, and Escape is not bound).
 *  Reopening remounts the sheet, which drops the optimistic draft, so what the
 *  reopened panel marks is DISK truth rather than the write we just made. */
async function closeSheet(page: Page): Promise<void> {
  await page.mouse.click(195, 50);
  await expect(page.getByTestId("sheet.card")).toHaveCount(0);
}

const row = (page: Page, name: string) => page.locator(`[data-theme-name="${name}"]`);

test.describe("mobile custom-themes apply", () => {
  test("tapping a row applies that palette and persists the selection", async ({ page }) => {
    await installMockIpc(page, { customThemes: SEEDED });
    await page.goto("/");
    await openAppearance(page);

    await row(page, "Zinc").click();

    // Persisted by NAME (the palette is vault content and never leaves the vault
    // to be stored anywhere else), and marked as applied.
    await expect.poll(() => themeWrites(page)).toEqual(["Zinc"]);
    await expect(row(page, "Zinc")).toHaveAttribute("data-selected", "true");
    await expect(row(page, "amber dusk")).toHaveAttribute("data-selected", "false");

    // Painted: the row's own palette is on the document root, and the built-in
    // `data-theme` attribute is gone (a custom theme supersedes light/dark).
    const props = await rootCustomProps(page);
    expect(props["--paper"]).toBe("#101014");
    expect(props["--accent"]).toBe("#7aa2f7");
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBeNull();
    // Zinc is a dark palette that defines none of the 12 syntax roles, so the
    // shared derivation filled them — the same defect desktop fixed twice, and
    // proof the applier ran end-to-end rather than only writing literal keys.
    expect(props["--syntax-keyword"]).toBe("var(--_syntax-keyword-dark)");

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
    await installMockIpc(page, { customThemes: SEEDED });
    await page.goto("/");
    await openAppearance(page);

    await row(page, "amber dusk").click();
    await expect.poll(() => themeWrites(page)).toEqual(["amber dusk"]);
    expect((await rootCustomProps(page))["--accent"]).toBe("#b58900");

    await page.getByText("Dark", { exact: true }).click();

    // The palette is gone — every custom property the applier wrote, not merely
    // the ones the built-in theme happens to redefine — and so is the selection.
    await expect.poll(() => themeWrites(page)).toEqual(["amber dusk", null]);
    expect(await rootCustomProps(page)).toEqual({});
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-theme"))).toBe("dark");
    await expect(row(page, "amber dusk")).toHaveAttribute("data-selected", "false");

    // And it stays cleared on disk, not just on screen.
    await closeSheet(page);
    await openAppearance(page);
    await expect(row(page, "amber dusk")).toHaveAttribute("data-selected", "false");
  });
});
