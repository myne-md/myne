// Flow-logic: the note editor never scrolls sideways (myne-md/myne#630).
// Headless Chromium, NOT end-to-end, but it IS a real layout engine, which is
// the whole point: jsdom computes no widths, so this property was untestable in
// the Vitest tier and untested anywhere.
//
// `EditorView.lineWrapping` has always been mounted, so TEXT wrapped. What
// scrolled was widgets that would not shrink. CodeMirror's base theme gives
// `.cm-scroller` `overflow-x: auto` and `.cm-content` `flex-shrink: 0` with the
// flex default `min-width: auto`, so a single unshrinkable descendant floors the
// content width and turns the whole note into a horizontal swipe. The frontmatter
// Properties grid was one: `24px 160px 1fr`, with `<input>`s setting `width: 100%`
// and never `min-width: 0`, so the value track floored at an input's intrinsic
// ~20-character width.
//
// TWO WIDTHS, and the second one is the one that discriminates:
//
//   • 390px, the pinned phone viewport, the width the bug was reported at. The
//     pre-fix CSS does NOT overflow here in Chromium (measured: 331px of content
//     in a 331px box), because Chromium resolves an input's automatic minimum
//     size against its percentage width more generously than WebKit, which is the
//     engine both shipped clients actually run on. At this width the spec is
//     coverage, not a discriminator, and saying so is the point of this note.
//   • 280px, a narrow split pane: same layout, same rules, and here the pre-fix
//     CSS fails in Chromium too: measured 329px of content in a 236px box, 93px
//     of sideways scroll. That is the width that proves the guard.
//
// The assertions are a PAIR at each width and neither alone is the property:
//
//   • `.cm-scroller` AND the `.m-scroll` pane around it have nothing to scroll
//     to, so the note does not drift sideways at either level. `.cm-content` is
//     deliberately not measured against itself: it carries `flex-shrink: 0` with
//     `min-width: auto`, so it grows to its widest child by construction and the
//     difference is ~0 in the broken build and the fixed one alike;
//   • a wide table still scrolls INSIDE `.cm-table-editable`, so a fix that
//     merely clipped everything, which would satisfy the first one, fails here.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

const NOTE_ID = "note-hscroll-1";

// Frontmatter with long values (the widget's own grid is the primary suspect),
// a wide GFM table (the construct that legitimately overflows and must scroll in
// its own box), and a long unbroken token, which is what `overflow-wrap` rather
// than `lineWrapping` has to handle.
//
// No `folder:`, because the note has to sit at the tree root for the list row to be one
// click away. The long path value it would carry lives on `path:` instead, which
// occupies the same grid track.
//
// Kept byte-identical to `e2e/editor-no-hscroll.e2e.ts`'s `BODY`. The two
// harnesses are legitimately separate (WebKitGTK there, Chromium here, and the
// engine difference is the whole reason both exist), but the DOCUMENT is not
// engine-specific, and two lanes claiming to measure the same property against
// slightly different documents is the drift that makes a disagreement between
// them unreadable. No fixture module spans a tauri-driver suite and a Playwright
// one today, so the duplication is stated rather than shared.
const NOTE_BODY = [
  "---",
  "title: Freedom",
  "path: Areas/Read/Saadat Hasan Manto/Collected Stories",
  "created: 2026-08-03T14:57:19.690Z",
  "tags:",
  "  - 1947 Partition",
  "  - Pakistan",
  "source: https://example.invalid/a/very/long/path/that/does/not/wrap/on/its/own",
  "---",
  "",
  "# Partition before reading",
  "",
  "https://example.invalid/an/extremely/long/unbroken/url/token/with/no/spaces/at/all",
  "",
  "| Column one | Column two | Column three | Column four | Column five | Column six |",
  "| --- | --- | --- | --- | --- | --- |",
  "| aaaaaaaaaa | bbbbbbbbbb | cccccccccc | dddddddddd | eeeeeeeeee | ffffffffff |",
  "",
].join("\n");

interface Overflow {
  readonly scrollWidth: number;
  readonly clientWidth: number;
}

/** Horizontal overflow of `selector`, or null while it has not rendered. */
async function overflowOf(page: Page, selector: string): Promise<Overflow | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) return null;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  }, selector);
}

async function openNote(page: Page): Promise<void> {
  await installMockIpc(page, { notes: [{ id: NOTE_ID, text: NOTE_BODY }] });
  await page.goto("/");
  await page.locator(`[data-testid="notes.row"][data-note-id="${NOTE_ID}"]`).click();
  await expect(page.getByTestId("editor.top-bar")).toBeVisible();
  // The Properties widget is a block-replace decoration built after the first
  // syntax-tree pass; measuring before it mounts measures the wrong document.
  await expect(page.locator(".cm-fm-properties")).toBeVisible();
}

/** 1px of sub-pixel rounding is not a scrollable inch. */
const SLACK_PX = 1;

for (const width of [390, 280] as const) {
  test.describe(`the editor never scrolls horizontally at ${width}px`, () => {
    test.use({ viewport: { width, height: 800 } });

    test("the content fits the scroller", async ({ page }) => {
      await openNote(page);

      // Poll rather than assert once: CodeMirror re-measures after the widget
      // mounts, and the first frame is not the layout's answer.
      await expect
        .poll(async () => {
          const m = await overflowOf(page, ".cm-scroller");
          return m === null ? null : m.scrollWidth - m.clientWidth;
        })
        .toBeLessThanOrEqual(SLACK_PX);

      // The PANE outside `.cm-scroller` too. Two of the four containment fixes
      // are about that container (`.m-scroll` here, the one-axis split in
      // `PaneView` on desktop), and measuring only inside the scroller left both
      // revertible with this lane still green.
      const pane = await overflowOf(page, ".m-scroll");
      expect(pane).not.toBeNull();
      expect(pane!.scrollWidth - pane!.clientWidth).toBeLessThanOrEqual(SLACK_PX);
    });

    test("the Properties block fits, rather than being clipped by an ancestor", async ({
      page,
    }) => {
      await openNote(page);

      // The distinction the assertion above cannot make on its own: a block still
      // 370px wide but hidden under an ancestor's `overflow-x: hidden` would pass
      // it while the last third of every property value stayed unreachable.
      const props = await overflowOf(page, ".cm-fm-properties");
      expect(props).not.toBeNull();
      expect(props!.scrollWidth - props!.clientWidth).toBeLessThanOrEqual(SLACK_PX);

      // And the value inputs are inside the viewport rather than off its right
      // edge, which is what a floored grid track looks like from the user's side.
      const inputsInside = await page.evaluate(() => {
        const inputs = [...document.querySelectorAll(".cm-fm-properties-value")];
        return inputs.every((el) => el.getBoundingClientRect().right <= window.innerWidth + 1);
      });
      expect(inputsInside).toBe(true);
    });

    test("a wide table still scrolls inside its own box", async ({ page }) => {
      await openNote(page);

      // The half that makes the two above mean something. Table cells carry
      // `min-width: 6em` and `white-space: nowrap` deliberately (Obsidian
      // behaviour), so a six-column table IS wider than this viewport, and the
      // right answer is that the table's own box scrolls, not that the note does.
      // `.cm-table-editable` is the top-level table's container (`table.ts`);
      // `.cm-table-scroll` is the read-only nested variant, which this note has
      // none of.
      await expect(page.locator(".cm-table-editable")).toBeVisible();
      const table = await overflowOf(page, ".cm-table-editable");
      expect(table).not.toBeNull();
      expect(
        table!.scrollWidth,
        "the table is not actually wider than its box, so this case proves nothing",
      ).toBeGreaterThan(table!.clientWidth + SLACK_PX);
    });
  });
}
