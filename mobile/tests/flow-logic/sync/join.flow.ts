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
      joinResult: { vault_id: "flow-vault", pending: true, fingerprint: null },
      // sync_head_fingerprint returns a value → the pending poll advances to verify.
      headFingerprint: "TYRS-N318",
      syncStatus: { state: "pending" },
    });
    await page.goto("/");

    // Welcome offers the new entry; open the join flow.
    await page.getByRole("button", { name: "Connect to my account" }).click();
    await expect(page.getByTestId("sync.join")).toBeVisible();

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

  // ── Device-join via QR (MYND-466) ──────────────────────────────────────────
  test("Scan QR → confirm → prefilled form → pending", async ({ page }) => {
    await installMockIpc(page, {
      freshDevice: true,
      qrScan: { value: "MYQR1|https://sync.example.com|4K7P9RH2JR3T8XW6VZ0A|-|9999999999" },
      qrDecode: {
        endpoint_url: "https://sync.example.com",
        account_number: "4K7P9RH2JR3T8XW6VZ0A",
        cert_pin_hex: null,
        pin_source: "self_host_no_pin",
        fresh: true,
      },
      joinResult: { vault_id: "flow-vault", pending: true, fingerprint: null },
      headFingerprint: "TYRS-N318",
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Connect to my account" }).click();

    // Scan → confirm screen shows the decoded server + account#.
    await page.getByTestId("sync.join.scan-qr").click();
    await expect(page.getByTestId("sync.join.qr-confirm")).toBeVisible();
    await expect(page.getByTestId("sync.join.qr-confirm.server")).toHaveText("https://sync.example.com");
    await expect(page.getByTestId("sync.join.qr-confirm.account")).toHaveText("MY-4K7P-9RH2-JR3T-8XW6-VZ0A");

    // Continue → back to the form, server + account prefilled; only the password left.
    await page.getByTestId("sync.join.qr-confirm.continue").click();
    await expect(page.getByTestId("sync.join.server-input")).toHaveValue("https://sync.example.com");
    await expect(page.getByTestId("sync.join.account-input")).toHaveValue("MY-4K7P-9RH2-JR3T-8XW6-VZ0A");

    await page.getByTestId("sync.join.password-input").fill("correct horse battery staple");
    await page.getByTestId("sync.join.submit").click();
    await expect(page.getByTestId("sync.join.verify")).toBeVisible();
  });

  test("expired QR → re-scan message, no confirm step", async ({ page }) => {
    await installMockIpc(page, {
      freshDevice: true,
      qrScan: { value: "MYQR1|https://sync.example.com|4K7P9RH2JR3T8XW6VZ0A|-|1" },
      qrDecode: {
        endpoint_url: "https://sync.example.com",
        account_number: "4K7P9RH2JR3T8XW6VZ0A",
        cert_pin_hex: null,
        pin_source: "self_host_no_pin",
        fresh: false,
      },
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Connect to my account" }).click();
    await page.getByTestId("sync.join.scan-qr").click();
    await expect(page.getByTestId("sync.join.error")).toBeVisible();
    await expect(page.getByTestId("sync.join.qr-confirm")).toHaveCount(0);
  });

  test("non-Myne QR → error, stays on the form", async ({ page }) => {
    await installMockIpc(page, {
      freshDevice: true,
      qrScan: { value: "https://evil.example" },
      qrDecodeError: { kind: "NotAQrJoinPayload" },
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Connect to my account" }).click();
    await page.getByTestId("sync.join.scan-qr").click();
    await expect(page.getByTestId("sync.join.error")).toBeVisible();
    await expect(page.getByTestId("sync.join.qr-confirm")).toHaveCount(0);
  });
});
