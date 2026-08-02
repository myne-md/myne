// Flow-logic: RTL mirroring of the compact editor chrome (RTL epic,
// myne-md/myne-mobile#33). Headless Chromium + mock IPC — NOT end-to-end. The
// shared `@myne/i18n` runtime sets `document.documentElement.dir` from the active
// locale at boot; this spec proves that flip reaches mobile AND that the
// mobile-local RTL pass actually mirrors the layout:
//
//   • booting an RTL locale (`ar`, forced via `localStorage["myne.lang"]`) turns
//     `document.dir` to "rtl";
//   • the editor back chevron carries `data-flip`, so the `[dir="rtl"] [data-flip]`
//     rule in tokens.css mirrors the glyph (computed transform `scaleX(-1)`);
//   • the back affordance lands on the inline-end (right) half of the top bar —
//     the mirror of its LTR top-left placement, since the flex row's visual order
//     flips with `dir`.
//
// The default-locale (en) case is the control: dir "ltr", glyph unflipped, back
// button on the left. Real-device bidi (WKWebView shaping, Arabic fonts) stays a
// device-matrix check — what IS JS-testable is the direction wiring above.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "./mock-ipc";

/** Boot the unlocked workspace, optionally under a forced locale, then open a
 *  new note so the compact editor top bar (with the back chevron) is on screen.
 *  Navigation is testid-based so it is locale-independent — under `ar` every
 *  aria-label is Arabic, so a label selector would not match. */
async function bootToEditor(page: Page, lang?: string): Promise<void> {
  await installMockIpc(page, {});
  if (lang) await page.addInitScript((l) => localStorage.setItem("myne.lang", l), lang);
  await page.goto("/");
  await expect(page.getByTestId("workspace.app-header")).toBeVisible();
  await page.getByTestId("notes.new-note").click();
  await expect(page.getByTestId("editor.top-bar")).toBeVisible();
}

/** The computed `transform` of the back chevron's `<svg>` — `matrix(-1, 0, 0, 1,
 *  0, 0)` when the `[dir="rtl"] [data-flip]` primitive has mirrored it, `none`
 *  otherwise. */
function backChevronTransform(page: Page): Promise<string> {
  return page.evaluate(() => {
    const svg = document.querySelector('[data-testid="editor.back"] svg');
    return svg ? getComputedStyle(svg).transform : "MISSING";
  });
}

test.describe("RTL mirroring", () => {
  test("an RTL locale flips <html dir> and mirrors the editor back chevron", async ({ page }) => {
    await bootToEditor(page, "ar");

    // The shared i18n dir-flip reaches the mobile WebView.
    expect(await page.evaluate(() => document.documentElement.dir)).toBe("rtl");

    // The glyph is mirrored by the tokens.css primitive (proves both the CSS
    // rule and the `flip` prop on the chevron).
    expect(await backChevronTransform(page)).toBe("matrix(-1, 0, 0, 1, 0, 0)");

    // Mirrored placement: the back button now sits on the inline-end (right) half.
    const box = await page.getByTestId("editor.back").boundingBox();
    const vw = page.viewportSize()!.width;
    expect(box!.x).toBeGreaterThan(vw / 2);
  });

  test("LTR control: dir is ltr, chevron unflipped, back button on the left", async ({ page }) => {
    await bootToEditor(page); // default en (navigator.language, no stored override)

    expect(await page.evaluate(() => document.documentElement.dir)).toBe("ltr");
    expect(await backChevronTransform(page)).toBe("none");

    const box = await page.getByTestId("editor.back").boundingBox();
    const vw = page.viewportSize()!.width;
    expect(box!.x).toBeLessThan(vw / 2);
  });
});
