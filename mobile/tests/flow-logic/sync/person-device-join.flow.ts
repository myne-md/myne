// Flow-logic: the PERSON device join on the phone (myne-md/myne#911 task 9,
// wired on this client by task 12). Headless Chromium + mock IPC — NOT
// end-to-end: the approval is a second device's act and no lane here has one, so
// what this file proves is the phone's HALF of the contract.
//
// Three claims:
//
//   1. A `person` code is not refused any more. Before task 12 this client said
//      "this phone cannot do that yet" and stopped, which left the owner's QR
//      useless on the one device it exists for.
//   2. The credential it asks for is the IDENTITY PHRASE, not a vault password or
//      an account number: the code names the person, and the phrase is what proves
//      this device is that person's.
//   3. The device lands PENDING rather than admitted, and says what the other
//      device has to do. That pending gate is what makes a stolen phrase
//      insufficient on its own (story 16), so the screen asserting it is the
//      assertion that the gate exists.

import { test, expect } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

const PERSON_ID_HEX = "cd".repeat(16);

/** Welcome → "Connect to my account" → the scan door. */
async function openJoinDoor(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("welcome.have-identity-cta").click();
  // The account door is now the first-run fork's third row: the welcome
  // button opens the identity fork, which offers the phrase, the code and
  // this account route (myne-md/myne#932).
  await page.getByTestId("identity-flow.fork-account").click();
  await expect(page.getByTestId("sync.join.scan-qr")).toBeVisible();
}

test.describe("person device join on the phone (myne-md/myne#911 task 12)", () => {
  test("a person code opens the phrase wizard, not the account form", async ({ page }) => {
    await installMockIpc(page, {
      freshDevice: true,
      qrScan: { value: "MYQR3|p|https://sync.example.com|" + PERSON_ID_HEX },
      qrDecode: {
        kind: "person",
        endpoint_url: "https://sync.example.com",
        person_id_hex: PERSON_ID_HEX,
        fresh: true,
      },
    });
    await openJoinDoor(page);
    await page.getByTestId("sync.join.scan-qr").click();

    // The wizard, at its phrase step. The owner's confirm step is the screen this
    // must NOT be: a person code has no account number to show there.
    await expect(page.getByTestId("identity-flow.person-join-cell")).toBeVisible();
    await expect(page.getByTestId("sync.join.account-input")).toHaveCount(0);
  });

  test("the phrase admits this device PENDING, and says the other device must approve", async ({
    page,
  }) => {
    await installMockIpc(page, {
      freshDevice: true,
      qrScan: { value: "MYQR3|p|https://sync.example.com|" + PERSON_ID_HEX },
      qrDecode: {
        kind: "person",
        endpoint_url: "https://sync.example.com",
        person_id_hex: PERSON_ID_HEX,
        fresh: true,
      },
      personJoinApproved: false,
    });
    await openJoinDoor(page);
    await page.getByTestId("sync.join.scan-qr").click();

    const cells = page.locator('input[data-testid^="identity-flow.person-join-cell"]');
    await expect(cells).toHaveCount(24);
    for (let i = 0; i < 24; i += 1) {
      await cells.nth(i).fill("ribbon");
    }
    await page.getByTestId("identity-flow.person-join-submit").click();

    // The phrase crossed IPC once, with the person the code named.
    const args = await page.evaluate(
      () =>
        (
          window as unknown as {
            __personJoinArgs?: { personIdHex?: string; endpointUrl?: string; phrase?: string };
          }
        ).__personJoinArgs,
    );
    expect(args?.personIdHex).toBe(PERSON_ID_HEX);
    expect(args?.endpointUrl).toBe("https://sync.example.com");
    expect((args?.phrase ?? "").split(" ")).toHaveLength(24);

    // Pending, and the screen says so rather than spinning in silence.
    await expect(page.getByTestId("identity-flow.person-join-pending")).toBeVisible();
  });

  test("an approved join lists the account's vaults and leaves the wizard", async ({ page }) => {
    await installMockIpc(page, {
      freshDevice: true,
      qrScan: { value: "MYQR3|p|https://sync.example.com|" + PERSON_ID_HEX },
      qrDecode: {
        kind: "person",
        endpoint_url: "https://sync.example.com",
        person_id_hex: PERSON_ID_HEX,
        fresh: true,
      },
      personJoinApproved: true,
      personVaults: [
        { vault_id: "vault-a", account_hash_hex: "a".repeat(64), role: "owner" },
      ],
    });
    await openJoinDoor(page);
    await page.getByTestId("sync.join.scan-qr").click();

    const cells = page.locator('input[data-testid^="identity-flow.person-join-cell"]');
    await expect(cells).toHaveCount(24);
    for (let i = 0; i < 24; i += 1) {
      await cells.nth(i).fill("ribbon");
    }
    await page.getByTestId("identity-flow.person-join-submit").click();

    // The join listed the account's vaults, so the shell's re-probe is what decides
    // where the user lands. The wizard is gone either way: what this asserts is
    // that it is not still sitting on the phrase step.
    await expect(page.getByTestId("identity-flow.person-join-pending")).toHaveCount(0);
    await expect(page.getByTestId("identity-flow.person-join-cell")).toHaveCount(0);
  });
});
