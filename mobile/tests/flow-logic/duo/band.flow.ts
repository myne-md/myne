// Flow-logic: the folded band (myne-md/myne#918).
//
// ONE spec, five projects (see playwright.config.ts): the unfolded Duo, the same
// device with the platform still reporting its folded panel, folded, landscape,
// and half of the screen beside another app. This tier is the only place the
// band can be driven without hardware, because `screen` and `viewport` are
// pinned per project and the size class reads both.
//
// What is asserted here is the arrangement, not the arithmetic: the arithmetic
// is `tests/size-class.test.ts`. One column with no pane, the list as an overlay
// that leaves the note where it was, and the caret and scroll surviving a fold
// that happens mid-edit.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

const BAND_MIN = 600;
const BAND_MAX = 700;

function width(page: Page): number {
  return page.viewportSize()?.width ?? 0;
}
function inBand(page: Page): boolean {
  return width(page) >= BAND_MIN && width(page) < BAND_MAX;
}

async function bootToEditor(page: Page): Promise<void> {
  // `statefulNoteWrites`: the write the drawer's replace-path owes has to be
  // OBSERVABLE, and the tier's default discards note_create/note_update, so a
  // vault seeded empty stays empty and a persisted note is invisible.
  await installMockIpc(page, { statefulNoteWrites: true });
  await page.goto("/");
  await expect(page.getByTestId("workspace.app-header")).toBeVisible();
  await page.getByTestId("notes.new-note").click();
  await expect(page.getByTestId("editor.top-bar")).toBeVisible();
}

test.describe("the unfolded band", () => {
  test("is one column: the note owns the width and no pane mounts", async ({ page }) => {
    test.skip(!inBand(page), "band-only project");
    await bootToEditor(page);

    await expect(page.locator("[data-size-class]")).toHaveAttribute("data-size-class", "compactWide");
    await expect(page.getByTestId("workspace.split")).toHaveCount(0);
    await expect(page.getByTestId("workspace.list-pane")).toHaveCount(0);

    // The note takes the window (one column) but stops at the measure, so there
    // is still a gutter on each side rather than 626pt of line length.
    // Pin the two numbers the band actually sets, read off the element that
    // carries them: `maxWidth: 664` and the phone's 22pt gutter. Measuring
    // `.cm-content` would fold CodeMirror's own inset into the answer, and a
    // fraction of the viewport passes on the phone arm too.
    const prose = await page.getByTestId("editor.content").evaluate((el) => {
      const cs = getComputedStyle(el);
      return { maxWidth: cs.maxWidth, paddingInline: cs.paddingLeft };
    });
    expect(prose.maxWidth).toBe("664px");
    expect(prose.paddingInline).toBe("22px");
  });

  test("puts the list over the note without moving it", async ({ page }) => {
    test.skip(!inBand(page), "band-only project");
    await bootToEditor(page);
    await page.locator(".cm-content").click();
    await page.keyboard.type("drawer survivor");
    const before = await page.locator(".cm-content").boundingBox();

    await page.getByTestId("editor.back").click();
    await expect(page.getByTestId("notes.list-drawer")).toBeVisible();
    await expect(page.getByTestId("notes.list-drawer-scrim")).toBeVisible();

    // Opening the list must not reset the reading position either.
    const scrollBefore = await page.locator(".m-scroll").first().evaluate((el) => el.scrollTop);
    await page.getByTestId("notes.list-drawer-scrim").click({ position: { x: Math.round(width(page) * 0.9), y: 120 } });
    await expect(page.getByTestId("notes.list-drawer")).toHaveCount(0);
    const scrollAfter = await page.locator(".m-scroll").first().evaluate((el) => el.scrollTop);
    expect(scrollAfter).toBe(scrollBefore);

    await page.getByTestId("editor.back").click();
    await expect(page.getByTestId("notes.list-drawer")).toBeVisible();

    // The note is still mounted at its own width: an overlay, not a push, so
    // nothing reflows underneath while the list is open. It is also out of the
    // focus and accessibility order, which is what `inert` buys.
    await expect(page.locator("[data-size-class] [inert]")).toHaveCount(1);
    const after = await page.locator(".cm-content").boundingBox();
    expect(after!.width).toBe(before!.width);
    await expect(page.locator(".cm-content")).toContainText("drawer survivor");

    // Tapping the strip of page to the right of the drawer closes it.
    await page.getByTestId("notes.list-drawer-scrim").click({ position: { x: Math.round(width(page) * 0.9), y: 120 } });
    await expect(page.getByTestId("notes.list-drawer")).toHaveCount(0);
  });

  test("honours Reduce Motion: the same surface, no slide", async ({ page }) => {
    test.skip(!inBand(page), "band-only project");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await bootToEditor(page);
    await page.getByTestId("editor.back").click();
    const panel = page.getByTestId("notes.list-drawer");
    await expect(panel).toBeVisible();
    const duration = await panel.evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(duration, "the drawer must not animate under Reduce Motion").toMatch(/^0s?,? ?/);
  });

  test("opens from the inline-start edge, which RTL mirrors", async ({ page }) => {
    test.skip(!inBand(page), "band-only project");
    // The rtl.flow.ts precedent: the shared i18n layer flips <html dir>, and the
    // drawer is positioned by the inline-start edge rather than a left offset.
    await page.addInitScript(() => localStorage.setItem("myne.lang", "ar"));
    await bootToEditor(page);
    await page.getByTestId("editor.back").click();
    const vw = width(page);
    // Flush against the inline-end edge once the slide settles: the right edge in
    // RTL, which is the mirrored position of the LTR drawer's left edge.
    await expect
      .poll(async () => {
        const box = await page.getByTestId("notes.list-drawer").boundingBox();
        return box ? Math.round(box.x + box.width) : -1;
      })
      .toBeGreaterThanOrEqual(vw - 4);
  });

  test("a tap inside the drawer reaches the drawer's own controls", async ({ page }) => {
    test.skip(!inBand(page), "band-only project");
    await bootToEditor(page);
    await page.getByTestId("editor.back").click();
    await expect(page.getByTestId("notes.list-drawer")).toBeVisible();

    // The drawer hosts the whole list, so its own buttons have to receive a
    // press: capturing the pointer on pointerdown would retarget it here.
    await page.getByTestId("notes.new-note").click();
    await expect(page.getByTestId("notes.list-drawer")).toHaveCount(0);
    await expect(page.getByTestId("editor.top-bar")).toBeVisible();
  });

  test("a control that replaces the buffer writes it first", async ({ page }) => {
    test.skip(!inBand(page), "band-only project");
    await bootToEditor(page);
    await page.locator(".cm-content").click();
    await page.keyboard.type("this must reach disk before it is replaced");

    // "+ New note" inside the drawer replaces the open buffer. This client has
    // no autosave and no snapshot, so a replace with no write is unrecoverable.
    await page.getByTestId("editor.back").click();
    await expect(page.getByTestId("notes.list-drawer")).toBeVisible();
    await page.getByTestId("notes.new-note").click();
    await expect(page.getByTestId("notes.list-drawer")).toHaveCount(0);

    await page.getByTestId("editor.back").click();
    await expect(page.getByTestId("notes.list-drawer")).toBeVisible();
    // A row here is a note that reached the store; without the write the list
    // would show none of it. The count is not pinned because the dev-only seed
    // spread (`maybeSeedTestData`, which fires on a vault of one note or fewer)
    // contributes rows of its own once writes persist.
    await expect.poll(async () => page.getByTestId("notes.row").count()).toBeGreaterThan(0);
  });

  test("survives a fold with the drawer open instead of losing the list", async ({ page }) => {
    test.skip(!inBand(page), "band-only project");
    await bootToEditor(page);
    await page.locator(".cm-content").click();
    await page.keyboard.type("drawer fold survivor");
    await page.getByTestId("editor.back").click();
    await expect(page.getByTestId("notes.list-drawer")).toBeVisible();

    const unfolded = page.viewportSize()!;
    await page.setViewportSize({ width: 466, height: 618 });
    await expect(page.locator("[data-size-class]")).toHaveAttribute("data-size-class", "compact");
    // Folding must not silently swap the list for the note: the phone layout has
    // its own full-screen list, and that is where the user was.
    await expect(page.getByTestId("notes.list-drawer")).toHaveCount(0);
    await expect(page.getByTestId("notes.new-note")).toBeVisible();
    await expect(page.locator(".cm-content")).toHaveCount(0);

    await page.setViewportSize(unfolded);
    await expect(page.locator("[data-size-class]")).toHaveAttribute("data-size-class", "compactWide");
  });

  test("closes on Escape and does not strand focus on the document root", async ({ page }) => {
    test.skip(!inBand(page), "band-only project");
    await bootToEditor(page);
    await page.getByTestId("editor.back").click();
    await expect(page.getByTestId("notes.list-drawer")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("notes.list-drawer")).toHaveCount(0);
    expect(
      await page.evaluate(() => document.activeElement?.className.includes("cm-content") ?? false),
      "focus goes back to the note, not to the document root",
    ).toBe(true);
  });

  test("keeps the caret when the device folds mid-edit", async ({ page }) => {
    test.skip(!inBand(page), "band-only project");
    await bootToEditor(page);
    await page.locator(".cm-content").click();
    await page.keyboard.type("abc");
    // Caret between "a" and "b".
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");

    const unfolded = page.viewportSize()!;
    await page.setViewportSize({ width: 466, height: 618 });
    await expect(page.locator("[data-size-class]")).toHaveAttribute("data-size-class", "compact");
    await page.setViewportSize(unfolded);
    await expect(page.locator("[data-size-class]")).toHaveAttribute("data-size-class", "compactWide");

    // Typing goes in at the restored caret, with no click and no focus() call:
    // the restore owns the keyboard too. Without it the text reads "Zabc".
    await page.keyboard.type("Z");
    await expect(page.locator(".cm-content")).toHaveText("aZbc");

    // A SECOND fold, after the caret has moved by typing. The snapshot is
    // re-armed at that move; a strategy that kept replaying the first one would
    // fold this edit back to offset 1.
    await page.keyboard.press("End");
    await page.setViewportSize({ width: 466, height: 618 });
    await expect(page.locator("[data-size-class]")).toHaveAttribute("data-size-class", "compact");
    await page.setViewportSize(unfolded);
    await expect(page.locator("[data-size-class]")).toHaveAttribute("data-size-class", "compactWide");
    await page.keyboard.type("!");
    await expect(page.locator(".cm-content")).toHaveText("aZbc!");
  });

  test("keeps the scroll position when the device folds mid-scroll", async ({ page }) => {
    test.skip(!inBand(page), "band-only project");
    await bootToEditor(page);
    await page.locator(".cm-content").click();
    await page.keyboard.insertText(Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n"));

    // The editor pane's own `.m-scroll` wrapper is the scrolling element on
    // mobile (the CodeMirror scroller inside it is not the one that overflows).
    const scroller = page.locator(".m-scroll").first();
    await scroller.evaluate((el) => {
      el.scrollTop = 600;
    });
    const before = await scroller.evaluate((el) => el.scrollTop);
    expect(before).toBeGreaterThan(300);

    const unfolded = page.viewportSize()!;
    await page.setViewportSize({ width: 466, height: 618 });
    await expect(page.locator("[data-size-class]")).toHaveAttribute("data-size-class", "compact");
    await page.setViewportSize(unfolded);
    await expect(page.locator("[data-size-class]")).toHaveAttribute("data-size-class", "compactWide");

    const after = await scroller.evaluate((el) => el.scrollTop);
    // A tolerance because the two layouts have different heights and the editor
    // clamps at the end of the document; a lost position reads as 0.
    expect(Math.abs(after - before)).toBeLessThan(32);
  });
});

test.describe("the other shapes of the same device", () => {
  test("folded, and half of the screen, stay the phone layout", async ({ page }) => {
    test.skip(width(page) >= BAND_MIN, "folded or half-width only");
    await bootToEditor(page);
    await expect(page.locator("[data-size-class]")).toHaveAttribute("data-size-class", "compact");
    await expect(page.getByTestId("workspace.split")).toHaveCount(0);
    await expect(page.getByTestId("notes.list-drawer")).toHaveCount(0);
  });

  test("unfolded landscape is the tablet two-pane", async ({ page }) => {
    test.skip(width(page) < BAND_MAX, "landscape-only project");
    await installMockIpc(page, {});
    await page.goto("/");
    await expect(page.locator("[data-size-class]")).toHaveAttribute("data-size-class", "medium");
    await expect(page.getByTestId("workspace.split")).toBeVisible();
    await expect(page.getByTestId("workspace.list-pane")).toBeVisible();
  });
});
