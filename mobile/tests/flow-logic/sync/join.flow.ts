// Flow-logic: the fresh-device "Connect to my account" join flow (MYND-459 /
// MYND-462 T3). Drives headless Chromium against the dev server with mock IPC —
// NOT an end-to-end suite (no device, no Rust, no real transport). Boots to
// Welcome (freshDevice), enters the join flow, submits {server, account#,
// password}, and — since the mock join returns `pending: true` — asserts the
// pending-approval screen, then "Continue" lands the editor.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

test.describe("sync join flow", () => {
  test("Welcome → Connect to my account → pending → editor", async ({ page }) => {
    await installMockIpc(page, {
      freshDevice: true,
      joinResult: {
        vault_id: "flow-vault",
        pending: true,
        fingerprint: null,
        device_id_hex: "aa11bb22cc33dd44ee55ff6677889900",
      },
      devicePlatform: "ios",
      // sync_head_fingerprint returns a value → the pending poll advances to verify.
      headFingerprint: "TYRS-N318",
      syncStatus: { state: "pending" },
    });
    await page.goto("/");

    // Welcome offers the new entry; open the join flow.
    await page.getByRole("button", { name: "Connect to my account" }).click();
    await expect(page.getByTestId("sync.join")).toBeVisible();

    // MYND-548: the join door carries the same pre-filled name field the Settings
    // enrollment panel does — a device arriving through this one nameless would be
    // a silent regression no other test would catch.
    await expect(page.getByTestId("sync.join.device-name-input")).toHaveValue("iPhone");
    await page.getByTestId("sync.join.device-name-input").fill("New phone");

    await page.getByTestId("sync.join.server-input").fill("https://sync.example.com");
    await page.getByTestId("sync.join.account-input").fill("MY-4K7P-9RH2-JR3T-8XW6-VZ0A");
    await page.getByTestId("sync.join.password-input").fill("correct horse battery staple");
    await page.getByTestId("sync.join.submit").click();

    // Password join → pending; the poll picks up the adopted-head fingerprint and
    // advances to the mandatory SYNC-40 verify step showing the SAS code.
    await expect(page.getByTestId("sync.join.verify")).toBeVisible();
    await expect(page.getByTestId("sync.join.sas-fingerprint")).toHaveText("TYRS-N318");

    // "They match" dispatches welcome.join-success → editor mounts (main surface up).
    await page.getByTestId("sync.join.sas-match").click();
    await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();
  });

  test("wrong account → the single non-distinguishing banner", async ({ page }) => {
    await installMockIpc(page, {
      freshDevice: true,
      joinError: { kind: "BadRequest" }, // account/password/existence all collapse
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Connect to my account" }).click();

    await page.getByTestId("sync.join.server-input").fill("https://sync.example.com");
    await page.getByTestId("sync.join.account-input").fill("MY-0000-0000-0000-0000-0000");
    await page.getByTestId("sync.join.password-input").fill("whatever");
    await page.getByTestId("sync.join.submit").click();

    await expect(page.getByTestId("sync.join.error")).toBeVisible();
  });
});
