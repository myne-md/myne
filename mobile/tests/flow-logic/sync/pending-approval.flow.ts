// Flow-logic: the approval wait RESUMED after the join overlay is gone
// (myne-md/myne#535, mobile half).
//
// The defect this holds: `sync_join_account` writes the account's real meta and
// unlocks the vault BEFORE the enrolment that comes back pending, so a device
// nobody has approved presents an ordinary container. The wait and the §6.3
// compare lived only in `JoinFlow`'s own state, so losing that overlay once (a
// WebView reclaim, the pending screen's Cancel) left the phone on an unlock form
// whose password worked, an empty vault behind it, and no surface left that could
// display its code — while the approving device sat on "Verify the new device"
// with nothing to compare, and the first background cycle claimed the token with
// the compare skipped.
//
// So the fixture boots straight into the EDITOR (an unlocked slot, no overlay),
// with `sync_head_fingerprint` answering null and `sync_status` answering
// `pending`. The verdict must route to the wait, the poll must then pick up the
// adopted head, and the compare must appear — with the same code the other device
// shows, which is the only thing the ceremony exists for.
//
// The fingerprint fixture is an ARRAY because the reads are ordered: the first
// call is the verdict's (null = never adopted a head), and every later call is the
// flow's own poll.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

test.describe("pending approval, resumed", () => {
  test("an enrolled, unapproved device is returned to the compare instead of the editor", async ({
    page,
  }) => {
    await installMockIpc(page, {
      // No overlay and no fresh device: this is a container that already exists
      // on disk and unlocks, which is exactly the state the join left behind.
      headFingerprint: [null, "TYRS-N318", "TYRS-N318"],
      syncStatus: { state: "pending" },
      devicePlatform: "ios",
    });
    await page.goto("/");

    // The verdict lands after the editor mounts, routes to the wait, and the flow's
    // own poll then sees the head this device just adopted — which is what the
    // approving device is showing too. The compare is the assertion, not the
    // intermediate pending frame: the two are one screen apart in time and only the
    // code is the ceremony.
    await expect(page.getByTestId("sync.join.verify")).toBeVisible();
    await expect(page.getByTestId("sync.join.sas-fingerprint")).toHaveText("TYRS-N318");
    // The editor did not open behind it: the vault is unlocked (the claim needs
    // `root_key`), and the surface covering it is the one the user must answer.
    await expect(page.getByRole("button", { name: "Settings" })).toHaveCount(0);

    // "They match" is the only exit that reaches the editor, and it is the
    // ceremony's own answer rather than a screen being dismissed.
    await page.getByTestId("sync.join.sas-match").click();
    await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();
  });

  test("the resumed wait offers no phrase door, because it never collected an account number", async ({
    page,
  }) => {
    await installMockIpc(page, {
      // No head ever arrives, so the wait stays up for the assertions below.
      headFingerprint: [null, null, null],
      syncStatus: { state: "pending" },
      devicePlatform: "ios",
    });
    await page.goto("/");

    await expect(page.getByTestId("sync.join.pending")).toBeVisible();
    // The escape re-enrols with the account number the FORM collected, and this
    // entry has no form behind it. Offering it would submit an empty one.
    await expect(page.getByTestId("sync.join.use-phrase")).toHaveCount(0);
    // Cancel stays: the wait must never be a screen with no way out.
    await expect(page.getByTestId("sync.join.cancel")).toBeVisible();
  });

  test("an approved device stays in the editor", async ({ page }) => {
    // The same boot, one field different: a persisted baseline means it synced,
    // so it was approved. Nothing routes, and no wait flashes.
    await installMockIpc(page, {
      headFingerprint: ["TYRS-N318"],
      syncStatus: { state: "idle" },
      devicePlatform: "ios",
    });
    await page.goto("/");

    await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();
    await expect(page.getByTestId("sync.join.pending")).toHaveCount(0);
  });
});
