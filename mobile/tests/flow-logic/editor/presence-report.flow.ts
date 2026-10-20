// Flow-logic: the phone REPORTS its own caret for the note on screen
// (myne-md/myne#849 review). Headless Chromium against the dev server with mock
// IPC, NOT an end-to-end suite.
//
// Without the reporter the phone publishes its join frame and never a position,
// so a peer's roster row for it carries nothing to jump to. A machine can judge
// this one: it needs no backend event, only that moving the caret in the editor
// reaches `live_session_set_presence` for the note that is open, with a position.
// What it cannot judge, a peer actually drawing that caret, is in the manual
// roster item `collab.presence`.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

const NOTE = {
  id: "n1",
  text: "---\ntitle: Alpha\nupdated: 2026-07-01T10:00:00.000Z\n---\n\nalpha body line\nsecond line\n",
};

async function presenceReports(page: Page): Promise<{ noteId: string; cursor: number | null }[]> {
  return page.evaluate(
    () =>
      (window as unknown as { __livePresence?: { noteId: string; cursor: number | null }[] })
        .__livePresence ?? [],
  );
}

test.describe("presence reporting", () => {
  test("moving the caret reports a position for the note on screen", async ({ page }) => {
    await installMockIpc(page, { notes: [NOTE] });
    await page.goto("/");
    await expect(page.getByTestId("workspace.app-header")).toBeVisible();
    await page.locator('[data-testid="notes.row"][data-note-id="n1"]').click();
    await expect(page.getByTestId("editor.top-bar")).toBeVisible();

    // Click the body LINE rather than `.cm-content`, whose centre is the
    // frontmatter's Properties widget (the same reason the sibling specs give).
    await page.locator(".cm-content").getByText("second line").click();
    await page.keyboard.press("End");

    // The reporter is trailing-throttled to the awareness coalescing floor.
    await expect
      .poll(async () => (await presenceReports(page)).filter((r) => r.noteId === "n1" && r.cursor !== null))
      .not.toHaveLength(0);
  });
});
