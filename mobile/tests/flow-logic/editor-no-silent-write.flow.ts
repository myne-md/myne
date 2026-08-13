// Flow-logic: the editor's write discipline — opening a note must never write
// on its own. Headless Chromium against the dev server with mock IPC — NOT an
// end-to-end suite. Pins two data-integrity invariants around the open-note
// buffer:
//
//   • an open alone never rewrites the note — not on mount (the desktop
//     mount-rewrite class), and not on backgrounding (the pagehide flush must
//     skip an untouched buffer: a no-op rewrite burns a fresh nonce + bumps
//     `updated:`, which reads as a phantom edit to sync on other devices);
//   • an EDITED note still flushes on backgrounding — exactly once, with the
//     typed content (the flush exists for the app-suspend save; the no-op skip
//     must not eat real edits);
//   • a FAILED read never binds the editor: the user stays on the list and no
//     later flush can hand the note's id a blank body (silent data loss).

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "./mock-ipc";

/** One seeded note with a frontmatter title + a recognizable body line. */
const NOTE = {
  id: "n1",
  text: "---\ntitle: Alpha\nupdated: 2026-07-01T10:00:00.000Z\n---\n\nalpha body line\n",
};

async function readNoteUpdates(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __noteUpdates?: string[] }).__noteUpdates ?? [],
  );
}

async function firePagehide(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
}

async function bootAndOpenNote(page: Page): Promise<void> {
  await installMockIpc(page, { notes: [NOTE] });
  await page.goto("/");
  await expect(page.getByTestId("workspace.app-header")).toBeVisible();
  await page.locator('[data-testid="notes.row"][data-note-id="n1"]').click();
  await expect(page.getByTestId("editor.top-bar")).toBeVisible();
}

test.describe("editor never writes silently", () => {
  test("opening a note never writes on its own", async ({ page }) => {
    await bootAndOpenNote(page);

    // A mount-triggered rewrite would land within moments of the editor
    // appearing; give it ample time to (not) happen.
    await page.waitForTimeout(1500);
    expect(await readNoteUpdates(page)).toHaveLength(0);
  });

  test("backgrounding an untouched note does not write", async ({ page }) => {
    await bootAndOpenNote(page);

    await firePagehide(page);

    await page.waitForTimeout(300);
    expect(await readNoteUpdates(page)).toHaveLength(0);
  });

  test("backgrounding an edited note flushes it exactly once", async ({ page }) => {
    await bootAndOpenNote(page);
    // Click the body LINE, not `.cm-content` — the live-preview frontmatter
    // renders a Properties widget whose key input sits at the content's
    // center, and a center-click types into that input instead of the note.
    await page.locator(".cm-content").getByText("alpha body line").click();
    await page.keyboard.press("End");
    await page.keyboard.type("edited marker");

    await firePagehide(page);

    await expect.poll(() => readNoteUpdates(page)).toHaveLength(1);
    const [update] = await readNoteUpdates(page);
    expect(update).toContain("edited marker");
    expect(update).toContain("alpha body line");
  });

  test("a failed read never binds the editor", async ({ page }) => {
    await installMockIpc(page, { notes: [NOTE], noteReadErrorIds: ["n1"] });
    await page.goto("/");
    await expect(page.getByTestId("workspace.app-header")).toBeVisible();

    await page.locator('[data-testid="notes.row"][data-note-id="n1"]').click();

    // The open fails: the list stays up with the failure banner, and no editor
    // is bound to the unreadable note.
    await expect(page.getByText("Couldn't open this note.")).toBeVisible();
    await expect(page.getByTestId("workspace.app-header")).toBeVisible();
    await expect(page.getByTestId("editor.top-bar")).toHaveCount(0);

    // Backgrounding now must write nothing — a bound empty buffer here would
    // overwrite the real note body with "".
    await firePagehide(page);
    await page.waitForTimeout(300);
    expect(await readNoteUpdates(page)).toHaveLength(0);
  });
});
