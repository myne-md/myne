// Flow-logic: the Apple Watch pending-capture drain (§9.18). Drives headless
// Chromium against the dev server with mock IPC — NOT an end-to-end suite. The
// native watch app + WatchConnectivity + the device-key keychain seal are the
// manual device-E2E exemption (they cannot run in this harness); what IS
// JS-testable is the slice inside the WebView trust boundary:
//
//   • on unlock (EditorFlow mount), `take_pending` → `note_create` per capture →
//     `ack` per capture (drainPendingCaptures);
//   • a staged-capture window event triggers `seal_staged` (initCaptures).
//
// The Rust seal/queue/decode is covered by `cargo test -p myne-core captures` and
// the `MYK1` byte layout by `cargo test -p protocol` + the `pending-capture`
// vectors; here we pin only the JS orchestration.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

async function readNoteCreates(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __noteCreates?: string[] }).__noteCreates ?? [],
  );
}

async function readAcks(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __captureAcks?: string[] }).__captureAcks ?? [],
  );
}

async function readSealCount(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __sealStagedCalls?: number }).__sealStagedCalls ?? 0,
  );
}

test.describe("Apple Watch pending-capture drain", () => {
  test("on unlock, queued captures become notes and are acked", async ({ page }) => {
    // Default boot is an Unlocked slot → the app routes straight to the editor,
    // so EditorFlow mounts and the drain runs immediately.
    await installMockIpc(page, {
      pendingCaptures: [
        { id: "a".repeat(32), text: "Buy oat milk on the way home" },
        { id: "b".repeat(32), text: "Idea: café não 🎙️" },
      ],
    });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();

    // Both captures were turned into notes (the DEV seeder may create other
    // notes too, so assert containment, not equality).
    await expect
      .poll(() => readNoteCreates(page))
      .toEqual(expect.arrayContaining(["Buy oat milk on the way home", "Idea: café não 🎙️"]));

    // Exactly the two captures were acked (only drainPendingCaptures acks).
    await expect.poll(() => readAcks(page)).toEqual(
      expect.arrayContaining(["a".repeat(32), "b".repeat(32)]),
    );
    expect(await readAcks(page)).toHaveLength(2);
  });

  test("no queued captures → no notes created, no acks", async ({ page }) => {
    await installMockIpc(page, { pendingCaptures: [] });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();
    // Give the drain a beat to run; it must not ack anything with an empty queue.
    await page.waitForTimeout(150);
    expect(await readAcks(page)).toHaveLength(0);
  });

  test("a staged-capture event triggers a seal", async ({ page }) => {
    await installMockIpc(page, {});
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();

    const before = await readSealCount(page);
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("myne-capture-staged")));
    await expect.poll(() => readSealCount(page)).toBeGreaterThan(before);
  });
});
