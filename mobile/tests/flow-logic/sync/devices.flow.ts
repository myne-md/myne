// Flow-logic: the device list's naming surface (MYND-548). Drives headless
// Chromium against the dev server with mock IPC — NOT an end-to-end suite (no
// device, no Rust, no real transport, no replication). This tier verifies the UI
// contract: what the row renders, and what the rename interaction writes. Whether
// a name actually replicates between two devices is the DESKTOP suite's job
// (`e2e/device-names.e2e.ts`), which drives real IPC against a real server.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

const NAMED = "aa11bb22cc33dd44ee55ff6677889900";
const UNNAMED = "bb22cc33dd44ee55ff6677889900aa11";
/** A device awaiting the approval gate — the SYNC-40 ceremony's subject. */
const PENDING = "cc33dd44ee55ff6677889900aa11bb22";

/** Two approved devices: one named, one not — so a single fixture covers both the
 *  stored-name path and the id-derived fallback. */
const DEVICES = [
  { device_id_hex: NAMED, approved: true, retired: false, is_current: true },
  { device_id_hex: UNNAMED, approved: true, retired: false, is_current: false },
];

async function openDevices(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByText("Sync", { exact: true }).click();
  await page.getByTestId("sync.settings.devices").click();
  await expect(page.getByTestId("sync.device-row").first()).toBeVisible();
}

/** Every `plugin:prefs|set_device_name` the page issued. A row that keeps its hex
 *  label proves nothing about a write that never landed in `device_names`, which
 *  is why the negatives below assert the CALL rather than the rendering. */
async function deviceNameWrites(page: import("@playwright/test").Page) {
  return page.evaluate(
    () =>
      (window as unknown as { __deviceNameWrites?: { id: string; name: string }[] })
        .__deviceNameWrites ?? [],
  );
}

test.describe("device names", () => {
  test("a named device leads with its name; an unnamed one keeps the id-derived fallback", async ({
    page,
  }) => {
    await installMockIpc(page, {
      syncStatus: { state: "idle" },
      devices: DEVICES,
      deviceNames: { [NAMED]: "Work phone" },
    });
    await openDevices(page);

    const names = page.getByTestId("sync.device-name");
    await expect(names.nth(0)).toHaveText("Work phone");
    // The fallback is the short-id label — the pre-feature rendering, unchanged.
    await expect(names.nth(1)).toContainText(UNNAMED.slice(0, 6));
  });

  test("only a named row demotes the device code, because the unnamed title IS it", async ({
    page,
  }) => {
    // The code is what tells two same-named devices apart, so it is a permanent
    // line rather than a hover affordance (mobile has no hover). On an unnamed row
    // the title is derived from the same six characters, so the line would print
    // them twice (myne-md/myne#973).
    await installMockIpc(page, {
      syncStatus: { state: "idle" },
      devices: DEVICES,
      deviceNames: { [NAMED]: "Work phone" },
    });
    await openDevices(page);

    const codes = page.getByTestId("sync.device-code");
    await expect(codes).toHaveCount(1);
    await expect(codes.nth(0)).toHaveText(NAMED.slice(0, 6));
  });

  test("an unnamed current device names itself once a cycle has completed", async ({ page }) => {
    await installMockIpc(page, {
      syncStatus: { state: "idle" },
      devicePlatform: "ios",
      devices: [{ device_id_hex: UNNAMED, approved: true, retired: false, is_current: true }],
      // Non-null: this device has adopted a head, i.e. a cycle completed. Writing a
      // name before that would create `vault.prefs` ahead of the enrollment seed
      // (`decisions/sync/0348` clause 2).
      headFingerprint: "TYRS-N318",
    });
    await openDevices(page);

    await expect(page.getByTestId("sync.device-name")).toHaveText("iPhone");
    // The row now carries two facts instead of one repeated, so the code is back.
    await expect(page.getByTestId("sync.device-code")).toHaveText(UNNAMED.slice(0, 6));
    expect(await deviceNameWrites(page)).toEqual([{ id: UNNAMED, name: "iPhone" }]);
  });

  test("never names a pending device, which is still unverified", async ({ page }) => {
    await installMockIpc(page, {
      syncStatus: { state: "idle" },
      devicePlatform: "ios",
      devices: [
        { device_id_hex: NAMED, approved: true, retired: false, is_current: false },
        { device_id_hex: PENDING, approved: false, retired: false, is_current: true },
      ],
      deviceNames: { [NAMED]: "Work phone" },
      headFingerprint: "TYRS-N318",
    });
    await openDevices(page);

    await expect(page.getByTestId("sync.pending-name")).toContainText(PENDING.slice(0, 6));
    await expect(page.getByText("iPhone")).toHaveCount(0);
    // The assertion that has teeth: a pending device was never written, even
    // though its own label renders the fallback either way.
    expect(await deviceNameWrites(page)).toEqual([]);
  });

  test("renaming a row persists and re-renders from the stored map", async ({ page }) => {
    await installMockIpc(page, {
      syncStatus: { state: "idle" },
      devices: DEVICES,
      deviceNames: { [NAMED]: "Work phone" },
    });
    await openDevices(page);

    await page.getByTestId("sync.rename-device").first().click();
    const input = page.getByTestId("sync.device-name-input");
    await expect(input).toHaveValue("Work phone");
    await input.fill("Studio iPad");
    await input.press("Enter");

    await expect(page.getByTestId("sync.device-name").nth(0)).toHaveText("Studio iPad");
  });

  test("rename is offered on a device that is NOT this one", async ({ page }) => {
    // Load-bearing: devices enrolled before names existed are named from whatever
    // device the user happens to be holding. Restricting rename to "this device"
    // would strand exactly that set.
    await installMockIpc(page, {
      syncStatus: { state: "idle" },
      devices: DEVICES,
    });
    await openDevices(page);

    await page.getByTestId("sync.rename-device").nth(1).click();
    const input = page.getByTestId("sync.device-name-input");
    await input.fill("Old laptop");
    await input.press("Enter");

    await expect(page.getByTestId("sync.device-name").nth(1)).toHaveText("Old laptop");
  });

  test("Escape cancels a rename and an empty submit keeps the previous name", async ({ page }) => {
    // There is no clear path by design (§10.2 unions single-sided keys, so a
    // deletion would not propagate), which is why a blank submit must read as
    // "cancel" rather than as "erase".
    await installMockIpc(page, {
      syncStatus: { state: "idle" },
      devices: DEVICES,
      deviceNames: { [NAMED]: "Work phone" },
    });
    await openDevices(page);

    await page.getByTestId("sync.rename-device").first().click();
    await page.getByTestId("sync.device-name-input").fill("Discarded");
    await page.getByTestId("sync.device-name-input").press("Escape");
    await expect(page.getByTestId("sync.device-name").nth(0)).toHaveText("Work phone");

    await page.getByTestId("sync.rename-device").first().click();
    await page.getByTestId("sync.device-name-input").fill("   ");
    await page.getByTestId("sync.device-name-input").press("Enter");
    await expect(page.getByTestId("sync.device-name").nth(0)).toHaveText("Work phone");
  });

  test("the rename field caps its input length", async ({ page }) => {
    await installMockIpc(page, {
      syncStatus: { state: "idle" },
      devices: DEVICES,
      deviceNames: { [NAMED]: "Work phone" },
    });
    await openDevices(page);

    await page.getByTestId("sync.rename-device").first().click();
    const input = page.getByTestId("sync.device-name-input");
    await input.fill("x".repeat(120));
    const value = await input.inputValue();
    expect(value.length).toBeLessThanOrEqual(40);
  });

  test("a PENDING device never shows a name, even when one is stored for its id", async ({
    page,
  }) => {
    // SYNC-40. This is the assertion that was missing: the pending row rendered
    // the names map, so a stored name WOULD have surfaced beside an unverified
    // device — a trust signal nothing verifies, which weakens the SAS
    // eye-compare. Seeding a name for the pending id is the only way to tell the
    // two implementations apart; without it the row falls back either way and the
    // test passes for the wrong reason.
    await installMockIpc(page, {
      syncStatus: { state: "idle" },
      devices: [
        ...DEVICES,
        { device_id_hex: PENDING, approved: false, retired: false, is_current: false },
      ],
      deviceNames: { [PENDING]: "Attacker Laptop" },
    });
    await openDevices(page);

    const pendingRow = page.getByTestId("sync.pending-row");
    await expect(pendingRow).toBeVisible();
    await expect(pendingRow).not.toContainText("Attacker Laptop");
    await expect(page.getByTestId("sync.pending-name")).toContainText(PENDING.slice(0, 6));
  });

  // myne#462. This surface — the mobile APPROVING side's SAS eye-compare — had
  // no test of any kind, and that is how it kept a shape the desktop side had
  // already moved on from: a single one-shot `sync_head_fingerprint` read, the
  // pre-#243 form, with no poll, no retry and no way back in. `None` is the
  // honest answer while no head is adopted, so one early call left "this code
  // appears once the new device finishes its first sync" on screen for good.
  test("the compare polls for the code instead of reading it once", async ({ page }) => {
    await installMockIpc(page, {
      syncStatus: { state: "idle" },
      // Nothing adopted yet, then a head lands. A one-shot read shows the
      // pending copy forever; a poll reaches the code.
      headFingerprint: [null, null, "TYRS-N318"],
    });

    // Boot straight to the wait: this device's OWN baseline is what the shell reads
    // on entry to the editor (`awaitingApprovalVerdict`), and a null baseline is the
    // honest answer to "has this device adopted a head", so it is routed to the
    // compare before Settings is reachable. That routing is `decisions/sync/0767`'s
    // half of the ceremony, and the pending copy is what it must not get stuck on.
    await page.goto("/");
    await expect(page.getByTestId("sync.join.verify")).toBeVisible();
    await expect(page.getByTestId("sync.join.sas-fingerprint")).toHaveText("TYRS-N318", {
      timeout: 10_000,
    });
  });

  // The other half of the same fix: once a code is on screen it must keep
  // tracking the head, and a head that MOVES is announced rather than silently
  // swapped under the reader.
  test("the approving side follows a head that advances, and says that it did", async ({ page }) => {
    await installMockIpc(page, {
      syncStatus: { state: "idle" },
      devices: [
        ...DEVICES,
        { device_id_hex: PENDING, approved: false, retired: false, is_current: false },
      ],
      // The current row is NAMED here on purpose: an unnamed one makes the panel's
      // self-naming probe read `sync_head_fingerprint` once, which consumes an
      // entry of the queue below and leaves the compare with nothing to observe
      // (myne-md/myne#973). The fixture's subject is the head, not the name.
      deviceNames: { [NAMED]: "Work phone" },
      // Three values, not two: the FIRST read is the shell's own baseline check on
      // entry (a non-null baseline is what keeps this device in the editor instead
      // of routing it to the wait), and the panel's compare then watches the head
      // move. With two, the hook's first read was already the last value and no
      // change was ever observable inside it.
      headFingerprint: ["TYRS-N318", "TYRS-N318", "P8WX-2ND4"],
    });
    await openDevices(page);

    await page.getByTestId("sync.approve-device").click();
    await expect(page.getByTestId("sync.sas-fingerprint")).toHaveText("P8WX-2ND4", {
      timeout: 10_000,
    });
    await expect(page.getByTestId("sync.sas-changed")).toBeVisible();
  });

  test("removing a device names the target it is about to revoke", async ({ page }) => {
    await installMockIpc(page, {
      syncStatus: { state: "idle" },
      devices: DEVICES,
      deviceNames: { [UNNAMED]: "Old laptop" },
    });
    await openDevices(page);

    await page.getByTestId("sync.remove-device").click();
    // Name AND code: revocation is the one place a mis-read row costs something.
    const target = page.getByTestId("sync.remove-target");
    await expect(target).toContainText("Old laptop");
    await expect(target).toContainText(UNNAMED.slice(0, 6));
  });
});
