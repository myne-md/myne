// Flow-logic: the phone accepts an invite to somebody else's vault, and the
// required name step behind it (myne-md/myne#851 tasks 14 and 15). Drives
// headless Chromium against the dev server with mock IPC, so this is a proof
// about the FLOW (which step follows which, what is reachable, what is written
// when) and not about the device, the transport or the Rust half. The device-tier
// gap is named in the roster entry rather than implied by this file.
//
// Three things the mocked tier is the right height for, and one it is not:
//
//   1. That the accept is REACHABLE at all, and takes the four arguments in
//      order. `personAcceptInvite` was exported from `mobile/src/lib/personAccount.ts`
//      from the day the identity flow landed with no production caller, so the
//      phone listed pending invites and then told the user to open one where no
//      such affordance existed. The row's `Open` control is the fix and this spec
//      is what keeps it there.
//
//   2. That the name step is a GATE and not a follow-up screen. The vault is on
//      disk and unlocked when the accept returns, so "the editor mounted" is the
//      assertion that separates an accept which finished from one which finished
//      and then demanded a name. Every spec below reaches the editor only through
//      a name, except the one where the roster says there is already one.
//
//   3. That the flow SURVIVES the answers it does not like: an unreadable roster
//      (asks rather than skipping), a refused accept, a refused write.
//
// What it is NOT: the accept command's own contract. `sync_person_accept_invite`
// materializes and unlocks a slot, checks the phrase against the owner's sealed
// copy and writes `vault.member-unlock`; none of that exists at this tier, and
// asserting on a mock's return value would be asserting on this file.

import { test, expect, type Page } from "@playwright/test";
import { installMockIpc } from "../mock-ipc";

/** BIP-39, in order: a valid-shaped 24-word phrase. The mocked accept never
 *  checks it against anything; the FORM does (24 non-empty cells), which is the
 *  half this tier owns. */
const PHRASE = [
  "abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract",
  "absurd", "abuse", "access", "accident", "account", "accuse", "achieve", "acid",
  "acoustic", "acquire", "across", "act", "action", "actor", "actress", "actual",
];

const INVITE_ID = "invite-id-hex";
const OWNER_CODE = "MYNE-PERSON-1:aa:bb:cc:dd";
const PASSWORD = "Correct-Horse-9-Battery";
/** The name this device gives itself. A label, not a credential: SYNC-13 covers
 *  phrases and passwords, so the two below are compared by projected digest rather
 *  than by value. */
const MEMBER_NAME = "Rowan Ash";

/** This device's own roster row, nameless: the state the step exists for. */
const SELF_ROW_ABSENT = {
  fingerprint_hex: "a".repeat(64),
  is_self: true,
  display_name: "",
  name_state: "absent" as const,
  role: "member" as const,
  previous_fingerprint_hex: null,
  continuity: null,
};

/** The roster a member RE-INVITED to a vault they already named in reads. */
const SELF_ROW_VERIFIED = {
  ...SELF_ROW_ABSENT,
  display_name: MEMBER_NAME,
  name_state: "verified" as const,
};

/** A projected digest of a SECRET (SYNC-13). The phrase and the password are compared
 *  through this so the value that was SENT is proven without the secret itself
 *  appearing as an expected argument; a digest and not a length, so an empty,
 *  truncated or different argument still fails. */
function secretDigest(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h = Math.imul(h ^ value.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h;
}

/** Boot to Welcome on a fresh device, open the identity flow, and land on its
 *  home step with one pending invite. `personStatus.enrolled` is what routes past
 *  the gate; the invite row is then the only control that opens an accept. */
async function openIdentity(page: Page): Promise<void> {
  await page.goto("/");
  // Welcome's ONE create door (myne-md/myne#911 task 12). The identity flow opens
  // at the gate or straight at the home depending on `personStatus`, so this helper
  // does not click a second time: the specs using it configure an enrolled device.
  await page.getByTestId("welcome.create-cta").click();
  await expect(page.getByTestId("identity-flow.invite-row")).toBeVisible();
}

/** Open the accept step from the pending invite row. */
async function openAccept(page: Page): Promise<void> {
  await page.getByTestId("identity-flow.invite-open").click();
  await expect(page.getByTestId("identity-flow.accept-owner-code")).toBeVisible();
}

/** The owner's own identity code, pasted on wizard step 1. Public material only:
 *  it never leaves the device. */
async function fillOwnerCode(page: Page): Promise<void> {
  await page.getByTestId("identity-flow.accept-owner-code").fill(OWNER_CODE);
}

/** Step 1 → step 2 (the phrase). Gated on the owner's code being present. */
async function toPhraseStep(page: Page): Promise<void> {
  await page.getByTestId("identity-flow.accept-continue").click();
  await expect(page.getByTestId("identity-flow.accept-phrase")).toBeVisible();
}

/** Step 2 → step 3 (the password). Gated on all 24 cells being filled. */
async function toPasswordStep(page: Page): Promise<void> {
  await page.getByTestId("identity-flow.accept-continue").click();
  await expect(page.getByTestId("identity-flow.accept.password-input")).toBeVisible();
}

/** Fill the 24 phrase cells, which live on wizard step 2. Cell 1 carries testid
 *  `…accept-phrase` and the rest are `…accept-phrase-cell-N`, the flow's own
 *  naming, not a positional gamble. */
async function typePhrase(page: Page): Promise<void> {
  for (let i = 0; i < PHRASE.length; i += 1) {
    const id = i === 0 ? "identity-flow.accept-phrase" : `identity-flow.accept-phrase-cell-${i + 1}`;
    await page.getByTestId(id).fill(PHRASE[i]);
  }
}

/** Fill the accept form and submit it, without assuming what comes next. The
 *  name step's own roster check decides that, and it can pass straight through. */
async function submitAccept(page: Page): Promise<void> {
  await fillOwnerCode(page);
  await toPhraseStep(page);
  await typePhrase(page);
  await toPasswordStep(page);
  await page.getByTestId("identity-flow.accept.password-input").fill(PASSWORD);
  await page.getByTestId("identity-flow.accept.confirm-input").fill(PASSWORD);
  await expect(page.getByTestId("identity-flow.accept.submit")).toBeEnabled();
  await page.getByTestId("identity-flow.accept.submit").click();
}

/** Drive the accept step to the name step it LANDS ON, for the cases where the
 *  roster says it has to ask. */
async function acceptToNameStep(page: Page): Promise<void> {
  await submitAccept(page);
  await expect(page.getByTestId("identity-flow.name-input")).toBeVisible();
}

/** The app is on its main surface. The editor's Settings control is the anchor
 *  every other mobile spec uses for "a vault is open". */
function settingsControl(page: Page) {
  return page.getByRole("button", { name: "Settings" }).first();
}

const ENROLLED = {
  enrolled: true,
  identity_unlocked: true,
  person_id_hex: "person",
  identity_code: OWNER_CODE,
  sealed_keypair_present: true,
  // The lifecycle state routes the flow past the gate (myne-md/myne#911 task 12):
  // `state` is what the identity flow reads, not `enrolled`, because a `reserved`
  // identity is an identity too.
  state: "enrolled",
};

const ONE_INVITE = [
  { invite_id_hex: INVITE_ID, vault_account_hash_hex: "b".repeat(64), claimed: false },
];

test.describe("member accept (myne-md/myne#851 task 14)", () => {
  test("Welcome → identity → accept → name → editor", async ({ page }) => {
    await installMockIpc(page, {
      freshDevice: true,
      personStatus: ENROLLED,
      personInvites: ONE_INVITE,
      // The roster answers "no name yet", which is the state an accepted member
      // is in: the record is written by the step below, not by the accept.
      roster: { members: [SELF_ROW_ABSENT], authority: "member", group_key_epoch: 1 },
    });
    await openIdentity(page);
    await openAccept(page);

    await fillOwnerCode(page);
    await toPhraseStep(page);
    await typePhrase(page);
    await toPasswordStep(page);
    await page.getByTestId("identity-flow.accept.password-input").fill(PASSWORD);
    await page.getByTestId("identity-flow.accept.confirm-input").fill(PASSWORD);
    await page.getByTestId("identity-flow.accept.submit").click();

    // The name step, and the editor NOT yet: the vault is on disk and unlocked at
    // this point, so a missing step is exactly the difference this asserts.
    await expect(page.getByTestId("identity-flow.name-input")).toBeVisible();
    await expect(settingsControl(page)).toHaveCount(0);

    await page.getByTestId("identity-flow.name-input").fill(MEMBER_NAME);
    await page.getByTestId("identity-flow.name.save").click();

    // Save is what opens the vault: the shell re-probes, `vault_list` now reports
    // the accepted vault and the slot is Unlocked, so the editor mounts.
    await expect(settingsControl(page)).toBeVisible();

    // What the writer was handed. Read from the recorded arguments rather than
    // from the banner, because the mocked `member_names_set_mine` returns `{}`
    // whether or not it was ever called.
    const acceptArgs = await page.evaluate(
      () => (window as unknown as { __acceptInviteArgs?: Record<string, unknown> }).__acceptInviteArgs,
    );
    expect(acceptArgs).toBeTruthy();
    expect(acceptArgs!.inviteIdHex).toBe(INVITE_ID);
    expect(acceptArgs!.ownerCode).toBe(OWNER_CODE);
    // The phrase and the password are compared by projected digest: SYNC-13 keeps the
    // two secrets out of an expected-value position, and a digest rather than a length
    // still fails on an empty, truncated or different argument.
    expect(secretDigest(String(acceptArgs!.phrase))).toBe(secretDigest(PHRASE.join(" ")));
    expect(secretDigest(String(acceptArgs!.password))).toBe(secretDigest(PASSWORD));

    const nameArgs = await page.evaluate(
      () => (window as unknown as { __memberNameArgs?: Record<string, unknown> }).__memberNameArgs,
    );
    expect(nameArgs!.name).toBe(MEMBER_NAME);
  });

  test("the accept wizard steps in order, and Back preserves the confirmed fingerprint", async ({
    page,
  }) => {
    await installMockIpc(page, {
      freshDevice: true,
      personStatus: ENROLLED,
      personInvites: ONE_INVITE,
    });
    await openIdentity(page);
    await openAccept(page);

    // Step 1: the owner check, and neither the phrase grid nor the password form.
    await expect(page.getByTestId("identity-flow.accept-step")).toBeVisible();
    await expect(page.getByTestId("identity-flow.accept-phrase")).toHaveCount(0);
    await expect(page.getByTestId("identity-flow.accept.password-input")).toHaveCount(0);
    // The step's Continue is the gate on the owner's code.
    await expect(page.getByTestId("identity-flow.accept-continue")).toBeDisabled();

    await fillOwnerCode(page);
    await expect(page.getByTestId("identity-flow.accept-continue")).toBeEnabled();
    await page.getByTestId("identity-flow.accept-continue").click();

    // Step 2: the phrase grid, and NOT the password form.
    await expect(page.getByTestId("identity-flow.accept-phrase")).toBeVisible();
    await expect(page.getByTestId("identity-flow.accept.password-input")).toHaveCount(0);

    // Back to step 1: the owner's code is still there, so Continue stays open.
    await page.getByTestId("identity-flow.accept-step-back").click();
    await expect(page.getByTestId("identity-flow.accept-owner-code")).toHaveValue(OWNER_CODE);
    await expect(page.getByTestId("identity-flow.accept-continue")).toBeEnabled();
  });

  test("the name step cannot be left empty", async ({ page }) => {
    await installMockIpc(page, {
      freshDevice: true,
      personStatus: ENROLLED,
      personInvites: ONE_INVITE,
      roster: { members: [SELF_ROW_ABSENT], authority: "member", group_key_epoch: 1 },
    });
    await openIdentity(page);
    await openAccept(page);
    await acceptToNameStep(page);

    // No exit: no back chevron, and the accept form is gone rather than behind.
    await expect(page.getByRole("button", { name: "Back" })).toHaveCount(0);
    await expect(page.getByTestId("identity-flow.accept.submit")).toHaveCount(0);

    const save = page.getByTestId("identity-flow.name.save");
    await expect(save).toBeDisabled();
    // Whitespace is not a name, and the check is not merely the button's disabled
    // state: a click on a blank draft must not reach the writer either.
    await page.getByTestId("identity-flow.name-input").fill("   ");
    await expect(save).toBeDisabled();

    const written = await page.evaluate(
      () => (window as unknown as { __memberNameArgs?: unknown }).__memberNameArgs,
    );
    expect(written).toBeUndefined();
    await expect(settingsControl(page)).toHaveCount(0);
  });

  test("a member already named in this vault is not asked again", async ({ page }) => {
    await installMockIpc(page, {
      freshDevice: true,
      personStatus: ENROLLED,
      personInvites: ONE_INVITE,
      roster: { members: [SELF_ROW_VERIFIED], authority: "member", group_key_epoch: 1 },
    });
    await openIdentity(page);
    await openAccept(page);
    // Deliberately NOT `acceptToNameStep`: this is the case where the step is
    // passed THROUGH, so waiting on its input would wait for something that is
    // never on screen, because the check resolves and releases the callback within a
    // render. What is asserted instead is the destination.
    await submitAccept(page);

    // The roster's answer is the question: a member re-invited to a vault they
    // already named in lands in the editor without a second write. Asserting the
    // absence of the write is what says no question was asked, since an editor that
    // mounted after a silent overwrite would look the same.
    await expect(settingsControl(page)).toBeVisible();
    const written = await page.evaluate(
      () => (window as unknown as { __memberNameArgs?: unknown }).__memberNameArgs,
    );
    expect(written).toBeUndefined();
  });

  test("an unreadable roster still asks", async ({ page }) => {
    await installMockIpc(page, {
      freshDevice: true,
      personStatus: ENROLLED,
      personInvites: ONE_INVITE,
      // `null` makes `sync_list_roster` REJECT, which is distinct from an empty
      // roster: one says "this device cannot ask", the other "nobody is named".
      roster: null,
    });
    await openIdentity(page);
    await openAccept(page);
    await acceptToNameStep(page);

    // Not a name and not a reason to skip a required step. The safe direction is
    // to ask, and the vault does not open until the user answers.
    await expect(page.getByTestId("identity-flow.name-input")).toBeVisible();
    await expect(settingsControl(page)).toHaveCount(0);
  });

  test("a refused accept says why and stays on the form", async ({ page }) => {
    await installMockIpc(page, {
      freshDevice: true,
      personStatus: ENROLLED,
      personInvites: ONE_INVITE,
      acceptInviteError: { kind: "InviteAlreadyClaimed" },
      roster: { members: [SELF_ROW_ABSENT], authority: "member", group_key_epoch: 1 },
    });
    await openIdentity(page);
    await openAccept(page);
    await fillOwnerCode(page);
    await toPhraseStep(page);
    await typePhrase(page);
    await toPasswordStep(page);
    await page.getByTestId("identity-flow.accept.password-input").fill(PASSWORD);
    await page.getByTestId("identity-flow.accept.confirm-input").fill(PASSWORD);
    await page.getByTestId("identity-flow.accept.submit").click();

    // The message is the point rather than the refusal: an unmapped kind renders
    // as "could not accept", which invites a retry that can never work.
    await expect(page.getByTestId("identity-flow.accept-error")).toBeVisible();
    await expect(page.getByTestId("identity-flow.name-input")).toHaveCount(0);
    await expect(settingsControl(page)).toHaveCount(0);
  });

  test("a refused name write says why and stays on the step", async ({ page }) => {
    await installMockIpc(page, {
      freshDevice: true,
      personStatus: ENROLLED,
      personInvites: ONE_INVITE,
      roster: { members: [SELF_ROW_ABSENT], authority: "member", group_key_epoch: 1 },
      memberNameError: { kind: "NameTooLong" },
    });
    await openIdentity(page);
    await openAccept(page);
    await acceptToNameStep(page);

    await page.getByTestId("identity-flow.name-input").fill(MEMBER_NAME);
    await page.getByTestId("identity-flow.name.save").click();

    // Recoverable by retyping rather than by re-accepting: the field is still
    // there, and the vault still has not opened.
    await expect(page.getByTestId("identity-flow.name-error")).toBeVisible();
    await expect(page.getByTestId("identity-flow.name-input")).toBeVisible();
    await expect(settingsControl(page)).toHaveCount(0);
  });
});
