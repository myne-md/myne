// Flow-logic: the OS share-sheet drain (§9.20). Drives headless Chromium against
// the dev server with mock IPC — NOT an end-to-end suite. The native iOS Share
// Extension / Android ACTION_SEND intent + the device-key seal are the manual
// device-E2E exemption (they cannot run in this harness); what IS JS-testable is
// the slice inside the WebView trust boundary:
//
//   • on unlock (EditorFlow mount), `drain_pending_shares` runs and its result
//     drives the SF5 confirmation toast (drainPendingShares → ShareImportToast);
//   • a batch that is ALL dedup hits shows no toast (SYNC-9);
//   • an empty queue is a silent no-op.
//
// The Rust decrypt/import/ack is covered by `cargo test -p myne-core share_import`
// and the `MYF1` byte layout by `cargo test -p protocol share_import`; here we
// pin only the JS orchestration + the confirmation surface.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

async function readShareDrains(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __shareDrains?: number }).__shareDrains ?? 0,
  );
}

test.describe("OS share-sheet drain", () => {
  test("on unlock, staged shares import and a confirmation toast shows", async ({ page }) => {
    // Default boot is an Unlocked slot → the app routes straight to the editor,
    // so EditorFlow mounts and the drain runs immediately.
    await installMockIpc(page, {
      pendingShares: [
        { id: "a".repeat(32), filename: "receipt.pdf", deduplicated: false },
        { id: "b".repeat(32), filename: "photo.png", deduplicated: false },
      ],
    });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();

    // The drain ran, and the multi-file confirmation toast is shown (stay-put).
    const toast = page.getByTestId("share-import-toast");
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("2 files added to your library");
    expect(await readShareDrains(page)).toBeGreaterThan(0);
  });

  test("tapping the confirmation toast opens the library the share landed in (MYND-640)", async ({ page }) => {
    await installMockIpc(page, {
      pendingShares: [
        { id: "a".repeat(32), filename: "receipt.pdf", deduplicated: false },
        { id: "b".repeat(32), filename: "photo.png", deduplicated: false },
      ],
    });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();

    const toast = page.getByTestId("share-import-toast");
    await expect(toast).toBeVisible();

    // The toast is the ONLY route to the imported file (the drain files it into
    // the attachment library, not where the user was looking). Tapping it must
    // open the Files library and dismiss the toast. Regression guard for the
    // pointer-events fix: the confirmation is a real <button> whose pointer
    // events are enabled — before the fix the full-width wrapper swallowed the
    // tap and this click never reached the button.
    await page.getByTestId("share-import-toast-open").click();
    await expect(page.getByTestId("files.page")).toBeVisible();
    await expect(page.getByTestId("share-import-toast")).toHaveCount(0);
  });

  test("a single shared file names the file in the toast", async ({ page }) => {
    await installMockIpc(page, {
      pendingShares: [{ id: "c".repeat(32), filename: "invoice.pdf", deduplicated: false }],
    });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();

    const toast = page.getByTestId("share-import-toast");
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("invoice.pdf added to your library");
  });

  test("a batch of only dedup hits shows no toast (SYNC-9)", async ({ page }) => {
    await installMockIpc(page, {
      pendingShares: [{ id: "d".repeat(32), filename: "dup.png", deduplicated: true }],
    });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();
    // The drain ran (imported the re-share as a dedup hit) but nothing fresh, so
    // no confirmation surfaces.
    await expect.poll(() => readShareDrains(page)).toBeGreaterThan(0);
    await expect(page.getByTestId("share-import-toast")).toHaveCount(0);
  });

  test("an empty queue is a silent no-op", async ({ page }) => {
    await installMockIpc(page, { pendingShares: [] });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();
    await page.waitForTimeout(150);
    await expect(page.getByTestId("share-import-toast")).toHaveCount(0);
  });
});
