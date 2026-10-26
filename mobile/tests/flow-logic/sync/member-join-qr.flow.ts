// Flow-logic: a member's OWN second device arrives by SCANNING a QR shown by a
// device already in the vault (myne-md/myne), on the phone.
//
// Drives headless Chromium against the dev server with mock IPC, so this is a
// proof about the FLOW — which door the code opens, which wizard it lands on, and
// what the scanner is asked for — and not about the device, the camera, the
// transport or the Rust half. Those gaps are named in the roster entry rather
// than implied by this file.
//
// # Why this is its own file rather than another case next door
//
// `member-second-device.flow.ts` covers the same JOIN WIZARD reached the long way:
// Welcome → "Create an identity" → the claimed row → join. What this file adds is
// the door and the dispatch, and the dispatch is exactly the part that can be
// wrong while every other assertion stays green:
//
//   - the QR is decoded at ONE place (`sync_decode_join_qr`), and the product
//     decision is that the CODE decides which wizard runs, not the user. So the
//     assertion that matters is which flow a `member_vault` code lands on — the
//     owner's confirm step and the member's join wizard are both plausible next
//     screens, and reaching the wrong one type-checks and renders.
//   - the owner's confirm step exists to display an ACCOUNT NUMBER, which a member
//     payload does not carry at all. A member code that reached it would show an
//     empty or invented account number on the one screen whose job is to let the
//     user verify what they are about to join.
//   - the endpoint the code carries has to reach the wizard that will use it, and
//     no account number may be asked for anywhere along the way.
//
// What it is NOT: the codec. `sync_decode_join_qr` is mocked, so nothing here says
// anything about how the payload is framed, what validates it or how freshness is
// judged; that is the Rust codec's own tier (`core/src/plugins/sync/qr_join.rs`
// plus `e2e/member-devices.e2e.ts` for the panel side).

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

/** BIP-39, in order: a valid-shaped 24-word phrase. The mocked join never checks
 *  it against anything; the FORM does (24 non-empty cells), which is the half
 *  this tier owns. This is the person's OWN phrase, never a vault password. */
const PHRASE = [
  "abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract",
  "absurd", "abuse", "access", "accident", "account", "accuse", "achieve", "acid",
  "acoustic", "acquire", "across", "act", "action", "actor", "actress", "actual",
];

const INVITE_ID = "invite-claimed-hex";
const VAULT_ACCOUNT_HASH = "ab".repeat(32);
const PASSWORD = "Correct-Horse-9-Battery";
const ENDPOINT = "https://sync.from-the-code.example";

/** The code the other device showed: a `member_vault` payload. It carries the
 *  vault by its account HASH — a member never holds the display form — and no
 *  account number exists on this shape at all. */
const MEMBER_QR = `MYQR2|m|${ENDPOINT}|${VAULT_ACCOUNT_HASH}|-|1700000000`;

const CLAIMED_INVITE = {
  invite_id_hex: INVITE_ID,
  vault_account_hash_hex: VAULT_ACCOUNT_HASH,
  claimed: true,
};

/** A projected digest of a SECRET (SYNC-13). The phrase is compared through this
 *  so the value that was SENT is proven without the secret itself appearing as an
 *  expected argument; a digest and not a length, so an empty, truncated or
 *  different phrase still fails. */
function secretDigest(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h = Math.imul(h ^ value.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h;
}

const ENROLLED = {
  enrolled: true,
  identity_unlocked: true,
  person_id_hex: "person",
  identity_code: "MYNE-PERSON-1:aa:bb:cc:dd",
  sealed_keypair_present: true,
  // The lifecycle state routes the flow past the gate (myne-md/myne#911 task 12):
  // `state` is what the identity flow reads, not `enrolled`, because a `reserved`
  // identity is an identity too.
  state: "enrolled",
};

/** The "Connect to my account" door on Welcome (the owner's join flow). */
async function openJoinDoor(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Connect to my account" }).click();
  await expect(page.getByTestId("sync.join.scan-qr")).toBeVisible();
}

test.describe("member's own-device QR (myne-md/myne)", () => {
  test("a member code opens the identity join wizard, not the owner's confirm step", async ({
    page,
  }) => {
    await installMockIpc(page, {
      freshDevice: true,
      personStatus: ENROLLED,
      personInvites: [CLAIMED_INVITE],
      qrScan: { value: MEMBER_QR },
      qrDecode: {
        kind: "member_vault",
        endpoint_url: ENDPOINT,
        account_hash_hex: VAULT_ACCOUNT_HASH,
        fresh: true,
      },
    });

    await openJoinDoor(page);
    await page.getByTestId("sync.join.scan-qr").click();

    // Landed on the JOIN WIZARD, straight at its phrase step: no claimed-row click
    // is needed, because the code named the vault. The owner's confirm step is the
    // screen this must NOT be, and it is asserted absent rather than merely unused
    // — it is the plausible wrong answer, and it is the one that would have no
    // account number to show.
    await expect(page.getByTestId("identity-flow.join-phrase")).toBeVisible();
    await expect(page.getByTestId("sync.join.qr-confirm")).toHaveCount(0);

    // No account number is asked for anywhere: not on the wizard, and not on the
    // owner's form behind it, which a mis-dispatched member code would have
    // returned the user to.
    await expect(page.getByTestId("sync.join.account-input")).toHaveCount(0);

    // The join itself still needs the phrase and a device password, and both are
    // collected here — the QR shortens the path, it does not replace the
    // credential (`SYNC-47`: the code carries no secret).
    for (let i = 0; i < PHRASE.length; i += 1) {
      const id = i === 0 ? "identity-flow.join-phrase" : `identity-flow.join-phrase-cell-${i + 1}`;
      await page.getByTestId(id).fill(PHRASE[i]);
    }
    await page.getByTestId("identity-flow.join-continue").click();
    await page.getByTestId("identity-flow.join.password-input").fill(PASSWORD);
    await page.getByTestId("identity-flow.join.confirm-input").fill(PASSWORD);
    await expect(page.getByTestId("identity-flow.join.submit")).toBeEnabled();
    await page.getByTestId("identity-flow.join.submit").click();

    // The command was handed the vault the CODE named, which is the whole point of
    // carrying the hash: a wizard opened for the right-looking vault but addressed
    // at another one would be indistinguishable on screen.
    await expect(page.getByRole("button", { name: "Settings" }).first()).toBeVisible();
    const joinArgs = await page.evaluate(
      () =>
        (window as unknown as { __joinVaultArgs?: Record<string, unknown> }).__joinVaultArgs,
    );
    expect(joinArgs).toBeTruthy();
    expect(joinArgs!.vaultAccountHashHex).toBe(VAULT_ACCOUNT_HASH);
    expect(joinArgs!.inviteIdHex).toBe(INVITE_ID);
  });

  /**
   * The phone that has NEVER held the identity (the gate's recover door).
   *
   * This is the case the member-vault QR exists for and the one the flow could
   * not finish: a second device that has never held the person identity scans the
   * code, and the gate offered exactly one way forward — `Create an identity`,
   * whose handler calls `personSetup()` with NO phrase and therefore MINTS a new
   * person id. A brand-new person has no invitations, so the QR effect fell
   * through to `identityFlow.joinFromQr.notFound` and the wizard the code was
   * meant to open never opened. The door asserted here is the fix, and what it
   * has to prove is narrow and specific: the phrase reaches
   * `sync_person_setup` as a phrase (not as `null`), and the wizard for the vault
   * the code named is what ends up on screen.
   */
  test("a phone that never held the identity recovers the phrase and the QR completes", async ({
    page,
  }) => {
    await installMockIpc(page, {
      freshDevice: true,
      // Stated rather than left to the default: not enrolled, no token, and no
      // sealed keypair either, which is what puts the flow on its GATE step
      // instead of the held-identity one.
      personStatus: {
        enrolled: false,
        identity_unlocked: false,
        person_id_hex: null,
        identity_code: null,
        sealed_keypair_present: false,
      },
      // What the recovered identity's invite list answers. The mock cannot know
      // which identity a phrase opens, so the roster the QR effect will match the
      // scanned hash against is seeded here; on a device this is the list the
      // server serves for the person the phrase recovered.
      personInvites: [CLAIMED_INVITE],
      qrScan: { value: MEMBER_QR },
      qrDecode: {
        kind: "member_vault",
        endpoint_url: ENDPOINT,
        account_hash_hex: VAULT_ACCOUNT_HASH,
        fresh: true,
      },
      // A RECOVER: `phrase: null` in the RESULT is the backend's own signal that
      // it opened an identity rather than generating one (it returns a phrase
      // only when it generated it), which is what makes landing directly on the
      // home step correct rather than a lost phrase ceremony.
      personSetupResult: {
        phrase: null,
        fingerprint_hex: "f".repeat(64),
        person_id_hex: "person-recovered",
        identity_code: "MYNE-PERSON-1:aa:bb:cc:dd",
        approved: true,
      },
    });

    await openJoinDoor(page);
    await page.getByTestId("sync.join.scan-qr").click();

    // The gate, with the third door on it. Before the arm landed this screen had
    // `Create an identity` and `Not now…` and nothing else, and neither can put an
    // identity on this device that the scanned vault has ever heard of.
    await expect(page.getByTestId("identity-flow.recover-open")).toBeVisible();
    // …and the wizard has NOT opened yet, which is the state the code alone cannot
    // get past: the vault can only be added by an identity that holds it.
    await expect(page.getByTestId("identity-flow.join-phrase")).toHaveCount(0);

    await page.getByTestId("identity-flow.recover-open").click();
    // The 24 cells are the recover step, and they are the join grid's own shape:
    // same testid convention, so a miss here is a different screen rather than a
    // renamed cell.
    for (let i = 0; i < PHRASE.length; i += 1) {
      const id = i === 0 ? "identity-flow.recover-phrase" : `identity-flow.recover-phrase-cell-${i + 1}`;
      await page.getByTestId(id).fill(PHRASE[i]);
    }
    await expect(page.getByTestId("identity-flow.recover-submit")).toBeEnabled();
    await page.getByTestId("identity-flow.recover-submit").click();

    // The interactive half: the recovered session installs, the home step's invite
    // list loads, and the effect the code was handed takes over. The wizard on
    // screen is the assertion, because the not-found arm renders the home step's
    // banner instead and would leave this unreachable.
    await expect(page.getByTestId("identity-flow.join-phrase")).toBeVisible();

    // The command was handed the phrase and not `null`. This is the assertion that
    // separates the recover door from the create one, and it is made on the
    // RECORDED ARGUMENT rather than on the screen because the two doors look the
    // same from the outside — one mints a person with no invitations, the other
    // opens the person who has them. Compared by projected digest: SYNC-13 keeps
    // the credential out of an expected-value position.
    const setupArgs = await page.evaluate(
      () =>
        (window as unknown as { __personSetupArgs?: Record<string, unknown> }).__personSetupArgs,
    );
    expect(setupArgs).toBeTruthy();
    expect(secretDigest(String(setupArgs!.phrase))).toBe(secretDigest(PHRASE.join(" ")));
  });

  test("a refused recovery stays on the step, with the words still in their cells", async ({
    page,
  }) => {
    // `BadRequest` is the ONE kind this path folds every credential failure into: a
    // wrong phrase and a sealed identity this device cannot open arrive here
    // identical, so the copy cannot name which it was. The refusal is asserted by
    // TESTID rather than by its sentence — the mock echoes keys, so a
    // `toHaveText` here would be comparing the stub against itself unless it also
    // resolved the key in `locales/en/common.json`, which is what the component
    // tier does and this one has no reader for.
    await installMockIpc(page, {
      freshDevice: true,
      personStatus: {
        enrolled: false,
        identity_unlocked: false,
        person_id_hex: null,
        identity_code: null,
        sealed_keypair_present: false,
      },
      personInvites: [CLAIMED_INVITE],
      qrScan: { value: MEMBER_QR },
      qrDecode: {
        kind: "member_vault",
        endpoint_url: ENDPOINT,
        account_hash_hex: VAULT_ACCOUNT_HASH,
        fresh: true,
      },
      personSetupResult: {
        phrase: null,
        fingerprint_hex: "f".repeat(64),
        person_id_hex: "person-recovered",
        identity_code: "MYNE-PERSON-1:aa:bb:cc:dd",
        approved: true,
      },
      personSetupError: { kind: "BadRequest" },
    });

    await openJoinDoor(page);
    await page.getByTestId("sync.join.scan-qr").click();
    await page.getByTestId("identity-flow.recover-open").click();
    for (let i = 0; i < PHRASE.length; i += 1) {
      const id = i === 0 ? "identity-flow.recover-phrase" : `identity-flow.recover-phrase-cell-${i + 1}`;
      await page.getByTestId(id).fill(PHRASE[i]);
    }
    await page.getByTestId("identity-flow.recover-submit").click();

    await expect(page.getByTestId("identity-flow.recover-error")).toBeVisible();
    // Still the recover step, and NOT the wizard: a refusal that opened the join
    // wizard would be indistinguishable from a session that installed.
    await expect(page.getByTestId("identity-flow.recover-submit")).toBeVisible();
    await expect(page.getByTestId("identity-flow.join-phrase")).toHaveCount(0);
    // The words survive the refusal, so a retry costs a correction and not 24
    // words — the same property the join's refusal case pins one file over.
    await expect(page.getByTestId("identity-flow.recover-phrase")).toHaveValue(PHRASE[0]);
    await expect(page.getByTestId("identity-flow.recover-phrase-cell-24")).toHaveValue(PHRASE[23]);
  });

  test("an account code still takes the owner's path, so the dispatch is not one-way", async ({
    page,
  }) => {
    // The control. Without it, "a member code opens the wizard" is satisfied by a
    // flow that opens the wizard for every code.
    await installMockIpc(page, {
      freshDevice: true,
      personStatus: ENROLLED,
      personInvites: [CLAIMED_INVITE],
      qrScan: { value: "MYQR2|a|https://sync.example.com|4K7P9RH2JR3T8XW6VZ0A|-|1700000000" },
      qrDecode: {
        kind: "account",
        endpoint_url: "https://sync.example.com",
        account_number: "4K7P9RH2JR3T8XW6VZ0A",
        fresh: true,
      },
    });

    await openJoinDoor(page);
    await page.getByTestId("sync.join.scan-qr").click();

    await expect(page.getByTestId("sync.join.qr-confirm")).toBeVisible();
    await expect(page.getByTestId("identity-flow.join-phrase")).toHaveCount(0);
  });
});
