// Flow-logic: the compact editor's left-edge swipe-back gesture (the touch
// twin of the `editor.back` chevron — autosave + pop to the list). Headless
// Chromium against the dev server with mock IPC — NOT an end-to-end suite; the
// real-finger feel (WKWebView touch stream, safe-area edges) stays a device
// check. What IS JS-testable is the recognizer itself:
//
//   • a long edge swipe rightward commits → editor exits to the list;
//   • a swipe with typed content commits through the same autosave path
//     (`note_create` fires before the pop);
//   • an under-threshold drag springs back — still in the editor;
//   • a horizontal drag starting away from the left edge never engages.
//
// Touch events are dispatched synthetically (single tick), so the flick
// velocity branch would see ~infinite speed — the stay-put cases keep their
// travel under FLICK_MIN_PX (48px) so no timing dependence sneaks in.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "./mock-ipc";

// TouchEvent/Touch constructors only exist in a touch-enabled context.
test.use({ hasTouch: true });

/** Dispatch a one-finger horizontal touch sequence on the phone screen
 *  element: touchstart at xs[0], a touchmove per following x, touchend at the
 *  last. Constant y — the recognizer sees a pure horizontal drag. */
async function swipe(page: Page, xs: number[], y = 300): Promise<void> {
  await page.evaluate(
    ([pts, py]) => {
      const el = document.querySelector(".m-screen");
      if (!el) throw new Error("no .m-screen on screen");
      const touch = (x: number) =>
        new Touch({ identifier: 1, target: el, clientX: x, clientY: py as number });
      const init = (x: number) => ({
        touches: [touch(x)],
        changedTouches: [touch(x)],
        bubbles: true,
        cancelable: true,
      });
      const p = pts as number[];
      el.dispatchEvent(new TouchEvent("touchstart", init(p[0])));
      for (const x of p.slice(1)) el.dispatchEvent(new TouchEvent("touchmove", init(x)));
      const last = p[p.length - 1];
      el.dispatchEvent(
        new TouchEvent("touchend", { touches: [], changedTouches: [touch(last)], bubbles: true, cancelable: true }),
      );
    },
    [xs, y] as const,
  );
}

async function bootToEditor(page: Page): Promise<void> {
  await installMockIpc(page, { syncStatus: { state: "idle" } });
  await page.goto("/");
  await expect(page.getByTestId("workspace.app-header")).toBeVisible();
  await page.getByLabel("New note").click();
  await expect(page.getByTestId("editor.top-bar")).toBeVisible();
}

test.describe("compact editor swipe-back", () => {
  test("a full left-edge swipe pops back to the list", async ({ page }) => {
    await bootToEditor(page);

    // Start in the 32px edge strip, travel well past the 32%-width commit
    // threshold (390 × 0.32 ≈ 125px).
    await swipe(page, [10, 40, 100, 160, 200]);

    await expect(page.getByTestId("workspace.app-header")).toBeVisible();
    await expect(page.getByTestId("editor.top-bar")).toHaveCount(0);
    // The empty new note was discarded, exactly like the back chevron.
    //
    // Counted as ROWS rather than read off the "No notes yet" placeholder,
    // because since myne-md/myne#613 that placeholder is not what an empty
    // vault shows: a deliberate folder persists once a note has landed in it,
    // so the tree renders folder rows and correctly short-circuits nothing.
    // `folders/empty-folders.flow.ts` asserts that directly. The dev-only
    // demo seeder registers three such folders in this tier, which is what
    // made the old assertion a proxy that stopped tracking its subject.
    await expect(page.getByTestId("notes.row")).toHaveCount(0);
  });

  test("swipe-back autosaves typed content before popping", async ({ page }) => {
    await bootToEditor(page);
    await page.locator(".cm-content").click();
    await page.keyboard.type("saved by swipe");

    await swipe(page, [10, 40, 100, 160, 200]);

    await expect(page.getByTestId("workspace.app-header")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __noteCreates?: string[] }).__noteCreates ?? []),
      )
      .toEqual(expect.arrayContaining([expect.stringContaining("saved by swipe")]));
  });

  test("an under-threshold drag springs back — still in the editor", async ({ page }) => {
    await bootToEditor(page);

    // Engages (>12px) but stays under both commit gates (48px flick floor,
    // 125px distance) — must settle back with no navigation.
    await swipe(page, [10, 28, 40]);

    await expect(page.getByTestId("editor.top-bar")).toBeVisible();
    await expect(page.getByTestId("workspace.app-header")).toHaveCount(0);
  });

  test("a drag starting away from the left edge never engages", async ({ page }) => {
    await bootToEditor(page);

    await swipe(page, [200, 240, 300, 360, 390]);

    await expect(page.getByTestId("editor.top-bar")).toBeVisible();
    await expect(page.getByTestId("workspace.app-header")).toHaveCount(0);
  });
});
