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
import { fillPhraseField } from "../helpers";

const PERSON_ID_HEX = "cd".repeat(16);

/** Welcome → "I have an identity" → the fork's code arm, which hands control to
 *  the shell's scanner and routes the decoded code into the wizard it names. */
async function openJoinDoor(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("welcome.have-identity-cta").click();
  // The fork offers the two credentials an existing identity comes with: the 24
  // words and a code. The account-and-password row that used to sit beside them
  // is gone from the client (myne-md/myne), so its absence is asserted here
  // rather than left to the reader: a third door reappearing would be a new
  // ingress rather than a layout change.
  await expect(page.getByTestId("identity-flow.fork-code")).toBeVisible();
  await expect(page.getByTestId("identity-flow.fork-account")).toHaveCount(0);
  await page.getByTestId("identity-flow.fork-code").click();
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

    // The wizard, at its phrase step. The owner's confirm step is the screen this
    // must NOT be: a person code has no account number to show there.
    await expect(page.getByTestId("identity-flow.person-join-cell")).toBeVisible();
    await expect(page.getByTestId("identity-flow.person-join-submit")).toBeVisible();
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

    // One field holding the whole phrase (myne-md/myne#945 item 02): the step takes
    // the phrase as a string because it arrives from the other device.
    await fillPhraseField(page, "identity-flow.person-join-cell");
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

    await fillPhraseField(page, "identity-flow.person-join-cell");
    await page.getByTestId("identity-flow.person-join-submit").click();

    // The join listed the account's vaults, so the shell's landing is what decides
    // where the user lands. The wizard is gone either way: what this asserts is
    // that it is not still sitting on the phrase step.
    await expect(page.getByTestId("identity-flow.person-join-pending")).toHaveCount(0);
    await expect(page.getByTestId("identity-flow.person-join-cell")).toHaveCount(0);
  });

  test("an approved join owes the compare, and the vault's own unlock is what reaches it", async ({
    page,
  }) => {
    // The end of the ceremony the whole feature exists for, and the half that had
    // no surface: a person join writes the vault's FRAME and installs no key, so
    // the approval wait cannot run until this device opens the vault with its own
    // password. The wait was therefore never entered at all.
    //
    // `headFingerprint` answers immediately, which is the case that used to be
    // skipped even by a client that did reach the wait: the first pull lands a head
    // on the locked→unlocked edge, and a verdict that read the baseline first
    // called that "approved" and retired the marker that owed the compare.
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
      headFingerprint: ["TYRS-N318", "TYRS-N318", "TYRS-N318"],
      syncStatus: { state: "idle" },
      devicePlatform: "ios",
    });
    await openJoinDoor(page);

    await fillPhraseField(page, "identity-flow.person-join-cell");
    await page.getByTestId("identity-flow.person-join-submit").click();

    // The frame landed locked, so the probe lands on that vault's unlock form —
    // the password screen the reporter saw, and the right screen: this VAULT's
    // password is the only key to it (the join installs none).
    await expect(page.getByTestId("unlock-submit")).toBeVisible();
    await page.getByTestId("unlock-password").fill("correct horse battery staple");
    await page.getByTestId("unlock-submit").click();

    // …and the compare the device owes is what opens, not the editor, even though
    // a head already exists by now.
    await expect(page.getByTestId("sync.join.verify")).toBeVisible();
    await expect(page.getByTestId("sync.join.sas-fingerprint")).toHaveText("TYRS-N318");
  });

  test("a join whose frames did not land says so and stays put", async ({ page }) => {
    // The other end of the same read: the device is admitted, and not one vault
    // arrived. Continuing would land on Welcome with a correct account number and
    // no vaults and no explanation, which is the report this covers.
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
        { vault_id: null, account_hash_hex: "b".repeat(64), role: "member" },
      ],
    });
    await openJoinDoor(page);

    await fillPhraseField(page, "identity-flow.person-join-cell");
    await page.getByTestId("identity-flow.person-join-submit").click();

    await expect(page.getByTestId("identity-flow.person-join-list-error")).toBeVisible();
    await expect(page.getByTestId("identity-flow.person-join-list-retry")).toBeVisible();
    // Not the unlock form and not the editor: there is no vault, so there is
    // nothing to unlock and the retry is the only way forward.
    await expect(page.getByTestId("unlock-submit")).toHaveCount(0);
  });
});
