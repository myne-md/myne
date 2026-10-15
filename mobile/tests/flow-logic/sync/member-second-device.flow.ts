// Flow-logic: a member's SECOND DEVICE joins the same vault from the phrase
// alone (myne-md/myne#852 task 7), on the phone. Drives headless Chromium
// against the dev server with mock IPC, so this is a proof about the FLOW
// (which step follows which, what is reachable, what is written when) and not
// about the device, the transport or the Rust half. The device-tier gap is
// named in the roster entry rather than implied by this file.
//
// Why this is a tier of its own rather than another case in
// `member-accept.flow.ts` next door. The accept and the join are the two halves
// of the same screen and they must not be confused for one another:
//
//   1. The invite ROW the user acts on is different. The accept lists PENDING
//      invites; the join lists CLAIMED ones, which the accept's list hides
//      because a claimed invite cannot be accepted. So the reachability half of
//      this spec is "the claimed row is on screen at all", which no
//      accept-shaped fixture can express.
//
//   2. The COMMAND is different, and reaching the wrong one is silent. A claimed
//      row routed through `sync_person_accept_invite` answers `InviteAlreadyClaimed`
//      and renders as a permanent failure, while a pending row routed through
//      `sync_member_join_vault` fails on a pin that was never written. Both
//      type-check and both look like a plausible message, so the assertion that
//      matters is which of the two commands the IPC boundary saw, and each is
//      recorded under its own global for exactly that.
//
//   3. There is NO owner code and NO name step. The owner is read from the pin
//      this person's own sealed profile carries; the person already has a name
//      for this vault. So "the editor mounted without a name being asked" is the
//      assertion that separates a finished join from one that finished and then
//      demanded something it has no way to collect.
//
// What it is NOT: the command's own contract. `sync_member_join_vault` recovers
// the person identity, reads the pinned owner, fetches the group package from
// the person-addressed route, verifies it and installs the member session; none
// of that exists at this tier, and asserting on a mock's return value would be
// asserting on this file.

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
/** The device-local credential this phone sets. Not the owner's, and not the
 *  vault password: a member never had one of those (`decisions/protocol/0606`). */
const PASSWORD = "Correct-Horse-9-Battery";

/** A CLAIMED invite: a vault this identity already belongs to. The accept's list
 *  hides it, which is what makes the row the reachability assertion. */
const CLAIMED_INVITE = {
  invite_id_hex: INVITE_ID,
  vault_account_hash_hex: VAULT_ACCOUNT_HASH,
  claimed: true,
};

/** A projected digest of a SECRET (SYNC-13). The phrase and the password are
 *  compared through this so the value that was SENT is proven without the secret
 *  itself appearing as an expected argument; a digest and not a length, so an
 *  empty, truncated or different argument still fails. */
function secretDigest(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h = Math.imul(h ^ value.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h;
}

/** Boot to Welcome on a fresh device, open the identity flow, and land on its
 *  home step with the claimed invite listed. `personStatus.enrolled` is what
 *  routes past the gate; the claimed row is then the only control that opens a
 *  join. */
async function openIdentity(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Create an identity" }).click();
}

/** Open the join step from the CLAIMED invite row. */
async function openJoin(page: Page): Promise<void> {
  await page.getByTestId("identity-flow.join-open").click();
  await expect(page.getByTestId("identity-flow.join-phrase")).toBeVisible();
}

/** Fill the 24 phrase cells, which live on wizard step 1. Cell 1 carries testid
 *  `…join-phrase` and the rest are `…join-phrase-cell-N`, the flow's own naming,
 *  not a positional gamble. */
async function typePhrase(page: Page): Promise<void> {
  for (let i = 0; i < PHRASE.length; i += 1) {
    const id = i === 0 ? "identity-flow.join-phrase" : `identity-flow.join-phrase-cell-${i + 1}`;
    await page.getByTestId(id).fill(PHRASE[i]);
  }
}

/** Step 1 → step 2 (the password). Gated on all 24 cells being filled. */
async function toJoinPasswordStep(page: Page): Promise<void> {
  await page.getByTestId("identity-flow.join-continue").click();
  await expect(page.getByTestId("identity-flow.join.password-input")).toBeVisible();
}

/** Fill the join form and submit it, without assuming what comes next. */
async function submitJoin(page: Page): Promise<void> {
  await typePhrase(page);
  await toJoinPasswordStep(page);
  await page.getByTestId("identity-flow.join.password-input").fill(PASSWORD);
  await page.getByTestId("identity-flow.join.confirm-input").fill(PASSWORD);
  await expect(page.getByTestId("identity-flow.join.submit")).toBeEnabled();
  await page.getByTestId("identity-flow.join.submit").click();
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
  identity_code: "MYNE-PERSON-1:aa:bb:cc:dd",
  sealed_keypair_present: true,
};

test.describe("member second device (myne-md/myne#852 task 7)", () => {
  test("Welcome → identity → claimed row → join → editor, with no name asked", async ({
    page,
  }) => {
    await installMockIpc(page, {
      freshDevice: true,
      personStatus: ENROLLED,
      personInvites: [CLAIMED_INVITE],
    });
    await openIdentity(page);

    // The reachability half. A claimed invite is invisible to the accept's own
    // affordance, so before this row existed the phone could list nothing it was
    // allowed to act on and the whole second-device path was unreachable.
    await expect(page.getByTestId("identity-flow.claimed-row")).toBeVisible();
    await expect(page.getByTestId("identity-flow.claimed-row")).toContainText(
      VAULT_ACCOUNT_HASH.slice(0, 8),
    );
    // …and it is NOT in the accept's list, which is the separation between the
    // two halves rather than a detail: one row in both lists would make the two
    // commands interchangeable from the user's side.
    await expect(page.getByTestId("identity-flow.invite-row")).toHaveCount(0);

    await openJoin(page);

    // No owner code, and no fingerprint to compare: the owner is read from this
    // person's own sealed profile. The accept's controls being absent is the
    // assertion, because a join that re-asked for a code it cannot verify would
    // still be a form a user could fill in. Asserted on BOTH wizard steps, since
    // the point is that the wizard never grows such a field as it advances.
    const expectNoOwnerCode = async (): Promise<void> => {
      await expect(page.getByTestId("identity-flow.accept-owner-code")).toHaveCount(0);
      await expect(page.getByTestId("identity-flow.accept-inspect")).toHaveCount(0);
      await expect(page.getByTestId("identity-flow.accept-owner-fingerprint")).toHaveCount(0);
    };
    await expectNoOwnerCode();

    await typePhrase(page);
    await toJoinPasswordStep(page);
    await expectNoOwnerCode();
    await page.getByTestId("identity-flow.join.password-input").fill(PASSWORD);
    await page.getByTestId("identity-flow.join.confirm-input").fill(PASSWORD);
    await expect(page.getByTestId("identity-flow.join.submit")).toBeEnabled();
    await page.getByTestId("identity-flow.join.submit").click();

    // The editor, and NOT a name step: this person already has a name for this
    // vault, and the accept's name gate is a gate on a FIRST membership, which
    // this is not. Reaching the editor is the assertion that the re-probe found
    // the slot the join materialized.
    await expect(settingsControl(page)).toBeVisible();
    await expect(page.getByTestId("identity-flow.name-input")).toHaveCount(0);

    // What the command was handed. Read from the recorded arguments rather than
    // from the banner, because the mocked join returns `null` whether or not it
    // was ever called.
    const joinArgs = await page.evaluate(
      () =>
        (window as unknown as { __joinVaultArgs?: Record<string, unknown> }).__joinVaultArgs,
    );
    expect(joinArgs).toBeTruthy();
    expect(joinArgs!.inviteIdHex).toBe(INVITE_ID);
    expect(joinArgs!.vaultAccountHashHex).toBe(VAULT_ACCOUNT_HASH);
    // The phrase and the password are compared by projected digest: SYNC-13 keeps
    // the two secrets out of an expected-value position.
    expect(secretDigest(String(joinArgs!.phrase))).toBe(secretDigest(PHRASE.join(" ")));
    expect(secretDigest(String(joinArgs!.password))).toBe(secretDigest(PASSWORD));
    // And no owner code went with them, which is a claim about the ARGUMENT rather
    // than about the form: a step that collected a code and forwarded nothing would
    // look identical on screen.
    expect(joinArgs!.ownerCode).toBeUndefined();

    // The accept was not the command that ran. A claimed row routed through it
    // would have reached here too, on some configurations, with a permanently
    // failing invite.
    const acceptArgs = await page.evaluate(
      () =>
        (window as unknown as { __acceptInviteArgs?: unknown }).__acceptInviteArgs,
    );
    expect(acceptArgs).toBeUndefined();
  });

  test("a refused join says its own thing and stays on the form", async ({ page }) => {
    await installMockIpc(page, {
      freshDevice: true,
      personStatus: ENROLLED,
      personInvites: [CLAIMED_INVITE],
      // `BadRequest` is the arm a real second device lands on FIRST: it means this
      // device could not establish which owner to verify against, which is the state
      // of every second device until the pin is written, and the pin is written by
      // the first device's next unlock. Its remedy is the OPPOSITE of the accept's
      // `BadRequest` ("paste the owner's code"), which is why the two commands have
      // two mappings rather than one shared switch: the sentence that tells this user
      // to paste a code is a sentence about a control this screen does not have.
      //
      // The other arms are the COMPONENT spec's business
      // (`mobile/tests/components/IdentityFlowJoin.test.tsx` drives all six through
      // the shared mapper); what this tier owes is that the mapping is reached at all
      // and that the join's sentence is not the accept's.
      memberJoinError: { kind: "BadRequest" },
    });
    await openIdentity(page);
    await openJoin(page);
    await submitJoin(page);

    const banner = page.getByTestId("identity-flow.join-error");
    await expect(banner).toBeVisible();
    // By LITERAL, because the whole defect is which of two messages rendered: a
    // visible-error assertion passes on either one.
    await expect(banner).toHaveText(
      "This device could not confirm which owner this vault belongs to, so it did not add the vault. If this is the first time you sign in to this vault here, open it once on a device that already has it, then try again.",
    );
    await expect(banner).not.toHaveText(
      "The invite could not be verified. Paste the vault owner's identity code (they share it when they invite you) and compare the fingerprint on both sides.",
    );

    // Recoverable by reading rather than by re-filling: the form is still there, and
    // the phrase is still in its cells one step back.
    await expect(page.getByTestId("identity-flow.join.submit")).toBeVisible();
    await expect(page.getByTestId("identity-flow.name-input")).toHaveCount(0);
    await expect(settingsControl(page)).toHaveCount(0);

    // The phrase survived the refusal, so the retry costs a password and not 24
    // words. Asserted on a cell rather than on the model, because the reset that
    // would lose it is a render-path change and this is where it would show. The
    // cells are on step 1, so the wizard has to be walked back to read them.
    await page.getByTestId("identity-flow.join-step-back").click();
    await expect(page.getByTestId("identity-flow.join-phrase")).toHaveValue(PHRASE[0]);
    await expect(page.getByTestId("identity-flow.join-phrase-cell-24")).toHaveValue(PHRASE[23]);
  });

  test("the join wizard steps in order, and Back preserves the phrase", async ({ page }) => {
    await installMockIpc(page, {
      freshDevice: true,
      personStatus: ENROLLED,
      personInvites: [CLAIMED_INVITE],
    });
    await openIdentity(page);
    await openJoin(page);

    // Step 1: the phrase grid, with the password form NOT present.
    await expect(page.getByTestId("identity-flow.join-step")).toBeVisible();
    await expect(page.getByTestId("identity-flow.join-phrase")).toBeVisible();
    await expect(page.getByTestId("identity-flow.join.password-input")).toHaveCount(0);
    await expect(page.getByTestId("identity-flow.join-continue")).toBeDisabled();

    await typePhrase(page);
    await expect(page.getByTestId("identity-flow.join-continue")).toBeEnabled();
    await page.getByTestId("identity-flow.join-continue").click();

    // Step 2: the password form, with the phrase grid NOT present.
    await expect(page.getByTestId("identity-flow.join.password-input")).toBeVisible();
    await expect(page.getByTestId("identity-flow.join-phrase")).toHaveCount(0);

    // Back to step 1: the phrase the user typed is still in its cells.
    await page.getByTestId("identity-flow.join-step-back").click();
    await expect(page.getByTestId("identity-flow.join-phrase")).toHaveValue(PHRASE[0]);
    await expect(page.getByTestId("identity-flow.join-phrase-cell-24")).toHaveValue(PHRASE[23]);
  });

  // The subject is the UI STATE of the submit control, and nothing here clicks it.
  // A negative assertion on the recorded arguments used to close this test
  // (`expect(joinArgs).toBeUndefined()`), and it was deleted rather than kept
  // (`member-devices` task 5 review, D9): with no click in the test it holds for every
  // implementation, so it reads as "the join was not called" while proving only that
  // the mock was never reached. Where that claim is worth making it is made in the
  // POSITIVE, in the join test above, which reads the recorded arguments back and
  // checks each one.
  test("the join's device password is behind the project's floor", async ({ page }) => {
    await installMockIpc(page, {
      freshDevice: true,
      personStatus: ENROLLED,
      personInvites: [CLAIMED_INVITE],
    });
    await openIdentity(page);
    await openJoin(page);
    await typePhrase(page);
    await toJoinPasswordStep(page);

    const submit = page.getByTestId("identity-flow.join.submit");
    // A phrase alone is not enough: it is the portable credential, and this step
    // is where a device-local one is set so the vault is not re-unlocked from 24
    // words every session.
    await expect(submit).toBeDisabled();
    await page.getByTestId("identity-flow.join.password-input").fill("short");
    await page.getByTestId("identity-flow.join.confirm-input").fill("short");
    await expect(submit).toBeDisabled();
    // …and the confirmation is a real comparison, not a second box.
    await page.getByTestId("identity-flow.join.password-input").fill(PASSWORD);
    await page
      .getByTestId("identity-flow.join.confirm-input")
      .fill(`${PASSWORD}-different`);
    await expect(submit).toBeDisabled();
    await page.getByTestId("identity-flow.join.confirm-input").fill(PASSWORD);
    await expect(submit).toBeEnabled();
  });
});
