// The shared member-fleet setup: a person identity on a device, an owner who
// enrols and invites, and the accept that carries the member into the vault.
//
// # Why these live here rather than in each spec
//
// `member-onboarding.e2e.ts` (myne-md/myne#851) wrote them first, and
// `member-devices.e2e.ts` (myne-md/myne#852) needs every one of them: the same
// phrase vectors, the same recover arm, the same two-step invite door, the same
// accept with its password step and its name gate. A copy would be the second,
// and the parts that matter are the parts a copy loses silently: the two
// phrases must be two PEOPLE (`is_self_invite` refuses an invite naming the
// inviter's own fingerprint), the accept's submit IS the password step rather
// than a form with a button beside it, and the name gate WITHHOLDS the
// completion callback rather than offering a dismissible prompt.
//
// Nothing here is a scenario. Every export is a step, and each spec composes
// them in the order its own claim needs. The comments travel with the steps
// because they are the reason the step is shaped that way.

import { expect } from "vitest";
import { type AppSession } from "./session";
import { launchDevice, syncConfigSeed } from "./multi-device";
import { closeSettings, ipcOk, openSettings, unlockToEditor, dismissImporterOffer } from "./flows";
import { seedVault } from "./fixtures";

/** A session, as every helper below takes it. */
export type Session = AppSession["session"];

/** The OWNER's person phrase: the public `abandon`/`about` BIP-39 vector, not a
 *  secret, and the same constant `member-roster.e2e.ts` enrols with. */
export const OWNER_PHRASE = `${"abandon ".repeat(23).trim()} about`;

/** The MEMBER's person phrase: a structurally valid 24-word BIP-39 vector that is
 *  deliberately NOT the owner's. Two people, two phrases, or the backend refuses
 *  the invite as a self-invite before it reaches the relay.
 *
 *  It is also the phrase a member's SECOND device recovers: one person, one
 *  phrase, however many devices (`decisions/protocol/0604`). */
export const MEMBER_PHRASE =
  "abandon ability able about above absent absorb abstract absurd abuse access accident " +
  "account accuse achieve acid acoustic acquire across act action actor actress actual";

/** The name typed into the gate. A display name is a label rather than a
 *  credential: SYNC-13 concerns phrases and passwords, and neither appears in any
 *  `expect` below. */
export const MEMBER_NAME = "Rowan Ash";

/** What the member renames itself to in a later scenario. */
export const RENAMED_NAME = "Rowan Ashby";

export const OWNER_PASSWORD = "CanaryPass-9-animals!";

/** The member's device-local password for the SHARED vault, deliberately not the
 *  owner's: the whole point of the password step is that the two credentials are
 *  separate, and the member never learns the owner's. */
export const MEMBER_PASSWORD = "MemberPass-4-lanterns!";

/** How long a cross-device round trip is given: a name is written on one device,
 *  pushed by a sync cycle, pulled and merged by the other's, and only then read. */
export const SYNC_BUDGET_MS = 120_000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ask a device to run one sync cycle now. A write lands locally and is pushed by
 *  the NEXT cycle, so a scenario that read the other side without this would be
 *  waiting on a timer rather than on the behaviour under test. */
export async function syncNow(session: Session): Promise<void> {
  await ipcOk(session, "plugin:sync|sync_now", {});
}

/** The value of a readonly input that renders a code. `property` rather than
 *  `text`, because a controlled input's value is a live DOM property and its text
 *  content is empty. */
export async function readValue(session: Session, testId: string): Promise<string> {
  const element = await session.byTestId(testId);
  const value = await element.property<string>("value");
  return (value ?? "").trim();
}

/** Type a phrase into a cell grid. Every grid on this path names its first cell
 *  bare and the rest `<prefix>-<n>` (1-based), the shared `PhraseEntryGrid`
 *  convention. */
export async function typePhrase(
  session: Session,
  firstCellTestId: string,
  laterCellPrefix: string,
  phrase: string,
): Promise<void> {
  for (const [index, word] of phrase.split(" ").entries()) {
    const testId = index === 0 ? firstCellTestId : `${laterCellPrefix}-${index + 1}`;
    await (await session.byTestId(testId)).replaceText(word);
  }
}

/**
 * A device with the MEMBER's person identity and nothing else: from a vault-less
 * boot to a held identity and its out-of-band code, via the RECOVER arm.
 *
 * The recover arm is what makes this deterministic AND it is the path a real
 * person takes on a second device: the phrase is the portable credential, so the
 * same call on two devices yields the same person, which is the fact the
 * second-device join is built on.
 */
export async function createMemberIdentity(member: AppSession): Promise<string> {
  // The first run's ONE door (myne-md/myne#911 task 6): the identity ceremony is
  // inline on its own stage, so the ids are the first-run panel's rather than
  // the Settings dialog's. The RECOVER arm itself is unchanged.
  await (await member.session.byTestId("welcome.create-cta")).click();
  await (await member.session.byTestId("first-run.identity.recover-open")).click();
  await typePhrase(
    member.session,
    "first-run.identity.phrase-input",
    "first-run.identity.phrase-cell",
    MEMBER_PHRASE,
  );
  await (await member.session.byTestId("first-run.identity.recover-cta")).click();
  // The recover arm echoes no phrase and generated nothing to prove possession of,
  // so the type-back challenge does not apply and the dialog goes straight to the
  // recovered result (`identitySetup.recovered`), whose only exit is Done.
  await member.session.byTestId("first-run.identity.close-cta", { timeoutMs: 90_000 });
  // Asserted, not assumed: a device awaiting approval holds no token, and the invite
  // listing a caller is about would then fail rather than show anything. The FIRST
  // device of a person account is approved, which is the arm a fresh server puts this
  // device in.
  expect(
    await member.session.byTestIdAll("first-run.identity.pending"),
    "the member's first device is approved without a second-device wait",
  ).toHaveLength(0);
  // Done hands off to vault creation; the identity home is the ABANDON path
  // (Back from the briefing re-probes, and "identity, no vault" routes home).
  await (await member.session.byTestId("first-run.identity.close-cta")).click();
  await (await member.session.byTestId("create.briefing-back")).click();
  await member.session.byTestId("identity-home.root");
  return readValue(member.session, "identity-home.identity-code");
}

/**
 * The owner device: unlock, enrol this vault with the relay, unlock the person
 * identity, and back with the owner's own out-of-band code.
 */
export async function startOwnerIdentity(owner: AppSession, account: string): Promise<string> {
  await owner.session.byTestId("unlock.password-input", { timeoutMs: 20_000 });
  await unlockToEditor(owner.session, OWNER_PASSWORD);
  await dismissImporterOffer(owner.session);
  await openSettings(owner.session, "sync");
  await owner.session.byTestId("sync.enroll.account-input", { timeoutMs: 10_000 });
  // The relay post needs an authenticated device: enrolling registers this vault at
  // the endpoint and self-approves the first device, which is the credential
  // `ensure_owner_member_token` later rides on. `sendKeys`, not `replaceText`: the
  // account field is empty here, and `setupTwoSyncedDevices` reads the same way.
  await (await owner.session.byTestId("sync.enroll.account-input")).sendKeys(account);
  await (await owner.session.byTestId("sync.enroll.password-input")).sendKeys(OWNER_PASSWORD);
  await (await owner.session.byTestId("sync.enroll.submit")).click();
  await owner.session.byTestId("sync.enroll.approved", { timeoutMs: 30_000 });
  await closeSettings(owner.session);
  // The identity is unlocked from the Sync panel's Identity block, which is collapsed
  // by default (myne-md/myne#831); the roster no longer carries its own grid.
  await openSettings(owner.session, "sync");
  await (await owner.session.byTestId("sync.panel.identity-unlock.open")).click();
  await typePhrase(
    owner.session,
    "sync.panel.identity-unlock.phrase-input",
    "sync.panel.identity-unlock.phrase-cell",
    OWNER_PHRASE,
  );
  await (await owner.session.byTestId("sync.panel.identity-unlock.submit")).click();
  await owner.session.byTestId("member-roster.person-ready", { timeoutMs: 90_000 });
  return readValue(owner.session, "member-roster.owner-code");
}

/**
 * Send the invite. `create_invite_from_host` relays it itself, so the caller has
 * nothing to carry: the proof it landed is the sent-invitations list, not a click
 * that returned.
 *
 * The invite's own completion is also what gains this vault the group tier, which
 * every step after it depends on: the binding store, the names store and the
 * group package are all `NTV6`-only, so a join attempted against a vault that has
 * never invited would fail on a tier rather than on a phrase.
 */
export async function sendInvite(owner: AppSession, memberCode: string): Promise<void> {
  await (await owner.session.byTestId("member-roster.invite-button")).click();
  // The invite button is a TWO-STEP door on a vault that has not yet gained the group
  // tier, and gaining it is permanent; a birth-format vault that has never been shared
  // is exactly that, so the confirmation is deterministic rather than optional.
  await owner.session.byTestId("member-roster.share-confirm");
  await (await owner.session.byTestId("member-roster.share-confirm-cta")).click();
  await owner.session.byTestId("member-roster.invite-modal");
  await (await owner.session.byTestId("member-roster.invite-code")).replaceText(memberCode);
  await (await owner.session.byTestId("member-roster.invite-confirm")).click();
  await owner.session.byTestId("member-roster.invitation-row", { timeoutMs: 60_000 });
  await closeSettings(owner.session);
}

/**
 * Accept, through the three wizard steps the accept owns (verify the owner, the
 * recovery phrase, the device password) and then the name gate.
 *
 * This is the FIRST membership, so it is the only path that may write a name.
 * The store the name lands in is `decisions/protocol/0666` and the row is signed
 * per `0667`; the rule that ONLY this path writes one has no decision entry of its
 * own and is carried by `src/components/sync/InviteWizard.tsx`'s comment on the
 * join wizard ("the accept owes the name gate, the join must not touch a name at
 * all"). A second device joins through `joinMemberVault` instead and writes none,
 * which is asserted in `member-devices.e2e.ts` by the name gate's absence there.
 */
export async function acceptInvite(
  member: AppSession,
  ownerCode: string,
  name: string,
): Promise<void> {
  // The identity home polls the relay on a timer and re-reads on focus, so an invite
  // posted a moment ago arrives without a nudge.
  await member.session.byTestId("identity-home.invite-row", { timeoutMs: SYNC_BUDGET_MS });
  await (await member.session.byTestId("identity-home.accept-open")).click();
  await member.session.byTestId("identity-home.accept-form");
  await (await member.session.byTestId("identity-home.accept-owner-code")).replaceText(ownerCode);
  // The owner's code releases the owner step, and the phrase is typed next. The
  // three collects are three screens now (myne-md/myne#871), and only the current
  // step's Continue exists, so one testid walks both gates.
  await (await member.session.byTestId("identity-home.accept-continue")).click();
  await member.session.byTestId("identity-home.accept-phrase-grid");
  await typePhrase(
    member.session,
    "identity-home.accept-phrase",
    "identity-home.accept-phrase-cell",
    MEMBER_PHRASE,
  );
  await (await member.session.byTestId("identity-home.accept-continue")).click();
  await member.session.byTestId("identity-home.accept.password-input");
  await (await member.session.byTestId("identity-home.accept.password-input")).replaceText(
    MEMBER_PASSWORD,
  );
  await (await member.session.byTestId("identity-home.accept.confirm-input")).replaceText(
    MEMBER_PASSWORD,
  );
  // This form's own submit IS the accept button, so the phrase, the out-of-band
  // confirmation and a password meeting the project floor are all satisfied by one
  // gesture. An accepted vault therefore always carries a credential this device can
  // open it with, and it is not the owner's.
  await (await member.session.byTestId("identity-home.accept.submit")).click();
  // The name gate is the accept's own completion: the callback that would put this
  // device in the editor is WITHHELD until a name is saved, so leaving the takeover by
  // naming itself is the only way out. There is deliberately no skip control, and its
  // absence is what the next line leans on.
  await member.session.byTestId("name-gate.input", { timeoutMs: SYNC_BUDGET_MS });
  await (await member.session.byTestId("name-gate.input")).replaceText(name);
  await (await member.session.byTestId("name-gate.save")).click();
  // Landing in the editor is the proof both steps completed: the accepted vault
  // becomes the ACTIVE member slot, so the editor is reached without a second unlock.
  await member.session.byTestId("editor.settings-cta", { timeoutMs: 60_000 });
  // Then clear the first-run importer offer, which is what an editor mount does
  // before anything else on this device can be clicked. The offered vault is a
  // FRESH vault here in exactly the way the owner's seeded one was: the offer's
  // condition is `localStorage[IMPORTER_OFFER_KEY] !== "1"` on editor mount
  // (`screens/Editor.tsx`), this device has never dismissed it, and the owner's
  // dismissal happens in the OWNER's WebView rather than this one. Leaving it up is
  // not a cosmetic failure: the offer registers the whole page `inert`
  // (`useOverlayInert`, myne-md/myne#728), so every later interaction on this device
  // is refused as `element not interactable` while the button it aims at is plainly
  // on screen.
  await dismissImporterOffer(member.session);
}

/**
 * Launch the OWNER's device: index 0, seeded with a birth-format (`v0.2`) vault,
 * carrying the relay's endpoint config.
 *
 * Birth format is what a real user gets AND what makes the first invite
 * deterministic: the seeded vault has no group tier, so `sendInvite`'s two-step
 * door is the only door rather than one of two. The account number is minted
 * inside the seed callback, which runs before the app is returned, so it comes
 * back as a second value rather than through a field on the session.
 */
export async function launchOwnerDevice(
  serverUrl: string,
): Promise<{ owner: AppSession; account: string }> {
  let account = "";
  const owner = await launchDevice(0, {
    seedConfig: syncConfigSeed(serverUrl),
    seed: (appDataDir) => {
      const seeded = seedVault(appDataDir, { password: OWNER_PASSWORD });
      account = seeded.account;
    },
  });
  return { owner, account };
}

/** Launch a vault-less device at `index`, carrying the relay's endpoint config.
 *  A vault-less boot lands on the identity-only home, which is the state
 *  `createMemberIdentity` and the joining device both expect. */
export async function launchMemberDevice(index: number, serverUrl: string): Promise<AppSession> {
  return launchDevice(index, { seedConfig: syncConfigSeed(serverUrl) });
}
