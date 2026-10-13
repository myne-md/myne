// The member-onboarding accept gate and the name step, end to end
// (myne-md/myne#851).
//
// # What no other tier can prove
//
// The accept path is the ONE place where three credentials meet: the owner's
// out-of-band identity code (read back through a SAS fingerprint the invitee
// confirms), the member's OWN recovery phrase (which is also their person
// identity, so it is typed for two different reasons), and a password the
// member sets for THIS device. Each of the three is unit-tested. What is not is
// that they compose in the real app, over the real relay, and land the member in
// the editor rather than on an unlock screen.
//
// Two of those steps are new, and neither was reachable from any suite before
// this one:
//
// - the password step is the accept form's OWN submit, so "accept" and "set a
//   password for this device" are one gesture, and there is no state in which an
//   accepted vault exists without a credential;
// - the name gate WITHHOLDS the accept's completion callback until a name is
//   saved, so an accepted vault cannot reach the editor unnamed. It is a
//   takeover rather than a dismissible prompt, which is why the only way out of
//   this scenario's gate is to name itself.
//
// # Two devices, because a member's own row never shows their name
//
// `MemberRosterPanel` renders the caller's OWN row as the you-badge and never as
// their display name, so "the name appears in the member list" is observable
// only on the OTHER side of the sync. The rename and clear affordances are the
// mirror image: they render on the caller's own row only (`m.is_self && shared`,
// the family being `NTV6`-only, so a member vault always has the group tier).
// Neither half is assertable on one device, so the fleet is two devices plus one
// ephemeral server.
//
// `member-roster.name` renders the you-badge through the SAME testid on the
// caller's own row, so every assertion below counts rows carrying a name rather
// than testing for presence: exactly ONE row may carry it, and it can never be
// the caller's own.
//
// # The member's phrase is a fixed vector, not one read off the DOM
//
// The identity setup dialog has a RECOVER arm (`identity-setup.recover-open`), so
// a device can adopt a known phrase instead of creating one and reading the
// generated grid back out of the page. That is what makes this deterministic, and
// it is also the path a real member takes to re-establish an existing identity on
// a second device. Two constraints follow. The phrase must be 24 words
// (`PHRASE_CELL_COUNT = 24`, and both submits stay disabled until every cell is
// non-empty), so the 12-word fixture in `vault-migrate.e2e.ts` will not do. And it
// must DIFFER from the owner's, because `is_self_invite` refuses an invite naming
// the inviter's own fingerprint, which is why the two constants below are two
// people rather than one phrase reused. `MEMBER_PHRASE` is the same valid vector
// `recovery-phrase-check.e2e.ts` carries as `OTHER_PHRASE`, repeated rather than
// imported so each spec's preconditions read on their own page.
//
// # Preconditions
//
// Vault-count: 1 seeded vault on the owner (birth format, v0.2, so the first
// invite is what gains the group tier and the two-step share door is
// deterministic), 0 on the member, which therefore boots to the identity-only
// home. Both devices get the ephemeral server's endpoint config, and the owner's
// vault is ENROLLED before it invites: the relay post needs an authenticated
// device, and `create_invite_from_host` mints the owner's member token on the way.
// Self-skips without the tauri-driver harness AND the `myne-server` binary, the
// gate every two-device scenario here carries.

import { describe, expect, it } from "vitest";
import { harnessSupported, type AppSession } from "./support/session";
import { startSyncServer, syncServerSupported } from "./support/sync-server";
import { launchDevice, syncConfigSeed } from "./support/multi-device";
import {
  closeSettings,
  dismissImporterOffer,
  ipcOk,
  openSettings,
  unlockToEditor,
} from "./support/flows";
import { seedVault } from "./support/fixtures";
import { testIdSelector } from "./support/webdriver";

/** A session, as every helper below takes it. */
type Session = AppSession["session"];

const driver = harnessSupported();
const server = syncServerSupported();
const ready = driver.ok && server.ok;

if (!ready) {
  // One honest reason line, so a filtered run explains itself.
  // eslint-disable-next-line no-console
  console.warn(
    `[e2e] member-onboarding skipped: ${!driver.ok ? driver.reason : server.reason}`,
  );
}

const describeCanary = ready ? describe : describe.skip;

/** The OWNER's person phrase: the public `abandon`/`about` BIP-39 vector, not a
 *  secret, and the same constant `member-roster.e2e.ts` enrolls with. */
const OWNER_PHRASE = `${"abandon ".repeat(23).trim()} about`;

/** The MEMBER's person phrase: a structurally valid 24-word BIP-39 vector that is
 *  deliberately NOT the owner's. Two people, two phrases, or the backend refuses
 *  the invite as a self-invite before it reaches the relay. */
const MEMBER_PHRASE =
  "abandon ability able about above absent absorb abstract absurd abuse access accident " +
  "account accuse achieve acid acoustic acquire across act action actor actress actual";

/** The name typed into the gate. A display name is a label rather than a
 *  credential: SYNC-13 concerns phrases and passwords, and neither appears in any
 *  `expect` below. */
const MEMBER_NAME = "Rowan Ash";
/** What the member renames itself to in the second scenario. */
const RENAMED_NAME = "Rowan Ashby";

const OWNER_PASSWORD = "CanaryPass-9-animals!";
/** The member's device-local password for the SHARED vault, deliberately not the
 *  owner's: the whole point of the step is that the two credentials are separate,
 *  and the member never learns the owner's. */
const MEMBER_PASSWORD = "MemberPass-4-lanterns!";

/** How long a cross-device round trip is given: a name is written on one device,
 *  pushed by a sync cycle, pulled and merged by the other's, and only then read. */
const SYNC_BUDGET_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Ask a device to run one sync cycle now. A name write lands locally and is
 *  pushed by the NEXT cycle, so a scenario that read the other side without this
 *  would be waiting on a timer rather than on the behaviour under test. */
async function syncNow(session: Session): Promise<void> {
  await ipcOk(session, "plugin:sync|sync_now", {});
}

/** The value of a readonly input that renders a code. `property` rather than
 *  `text`, because a controlled input's value is a live DOM property and its text
 *  content is empty. */
async function readValue(session: Session, testId: string): Promise<string> {
  const element = await session.byTestId(testId);
  const value = await element.property<string>("value");
  return (value ?? "").trim();
}

/** Type a phrase into a cell grid. Every grid on this path names its first cell
 *  bare and the rest `<prefix>-<n>` (1-based), the shared `EnrollPhraseCredential`
 *  convention. */
async function typePhrase(
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

/** Every rendered `member-roster.name`. The caller's own row renders the you-badge
 *  through the SAME testid, so the COUNT of rows carrying a given name is the
 *  discriminator; a presence test would not be. */
async function renderedNames(session: Session): Promise<string[]> {
  const cells = await session.byTestIdAll("member-roster.name");
  return Promise.all(cells.map(async (cell) => (await cell.text()).trim()));
}

/**
 * Poll a member list until `predicate` holds over its rendered names.
 *
 * Every round nudges the device that WROTE (whose cycle is what pushes) and
 * re-mounts the panel being read. The re-mount is not cosmetic: `useRoster`
 * fetches on mount and on its own explicit reload tick, and nothing in the panel
 * subscribes to a sync event, so a pull that landed behind an already-open panel
 * is invisible until the panel remounts. Closing and re-opening IS the read.
 */
async function pollRoster(
  session: Session,
  writer: Session,
  predicate: (names: string[]) => boolean,
  describeFailure: (names: string[]) => string,
): Promise<string[]> {
  const deadline = Date.now() + SYNC_BUDGET_MS;
  for (;;) {
    if ((await session.byTestIdAll("settings.modal")).length > 0) {
      await closeSettings(session);
    }
    if ((await session.byTestIdAll("editor.root")).length === 0) {
      // The read below opens Settings from the editor, so a device that is not
      // there is a state no budget reaches.
      throw new Error("the device being read is not on the editor screen");
    }
    await syncNow(writer);
    await syncNow(session);
    await openSettings(session, "sync");
    await session.byTestId("member-roster");
    // `member-roster` mounts before `useRoster` resolves, so the root alone is not
    // the roster having loaded.
    await sleep(1_000);
    const names = await renderedNames(session);
    if (predicate(names)) return names;
    if (Date.now() >= deadline) throw new Error(describeFailure(names));
    await sleep(2_000);
  }
}

/** Wait until exactly one member row carries `name`, and return that read. */
async function waitForName(
  session: Session,
  writer: Session,
  name: string,
  label: string,
): Promise<string[]> {
  return pollRoster(
    session,
    writer,
    (names) => names.filter((candidate) => candidate === name).length === 1,
    (names) =>
      `${label}: no member row carried the name within ${SYNC_BUDGET_MS} ms ` +
      `(${names.length} row(s) rendered a name)`,
  );
}

/** Wait until NO member row carries `name` any more. */
async function waitForNoName(
  session: Session,
  writer: Session,
  name: string,
  label: string,
): Promise<void> {
  await pollRoster(
    session,
    writer,
    (names) => !names.includes(name),
    () => `${label}: the name was still on the member list after ${SYNC_BUDGET_MS} ms`,
  );
}

/** Open Settings -> Sync on a device and wait for its own roster, with the identity
 *  ready. `member-roster.person-ready` reflects a BACKEND probe of the sealed
 *  keypair rather than a session flag, so waiting on it is also the assertion that
 *  this device can sign a name at all. */
async function openOwnRoster(device: AppSession): Promise<void> {
  await openSettings(device.session, "sync");
  await device.session.byTestId("member-roster", { timeoutMs: 10_000 });
  await device.session.byTestId("member-roster.person-ready", { timeoutMs: 60_000 });
}

/**
 * The member device: from a vault-less boot to a held identity and its out-of-band
 * code, via the RECOVER arm.
 */
async function createMemberIdentity(member: AppSession): Promise<string> {
  await (await member.session.byTestId("welcome.identity-cta")).click();
  await (await member.session.byTestId("identity-setup.recover-open")).click();
  await typePhrase(
    member.session,
    "identity-setup.phrase-input",
    "identity-setup.phrase-cell",
    MEMBER_PHRASE,
  );
  await (await member.session.byTestId("identity-setup.recover-cta")).click();
  // The recover arm echoes no phrase and generated nothing to prove possession of,
  // so the type-back challenge does not apply and the dialog goes straight to the
  // fingerprint.
  await member.session.byTestId("identity-setup.fingerprint", { timeoutMs: 90_000 });
  // Asserted, not assumed: a device awaiting approval holds no token, and the invite
  // listing this scenario is about would then fail rather than show anything. The
  // FIRST device of a person account is approved, which is the arm a fresh server
  // puts this device in.
  expect(
    await member.session.byTestIdAll("identity-setup.pending"),
    "the member's first device is approved without a second-device wait",
  ).toHaveLength(0);
  await (await member.session.byTestId("identity-setup.close-cta")).click();
  await member.session.byTestId("identity-home.root");
  return readValue(member.session, "identity-home.identity-code");
}

/**
 * The owner device: unlock, enrol this vault with the relay, unlock the person
 * identity, and back with the owner's own out-of-band code.
 */
async function startOwnerIdentity(owner: AppSession, account: string): Promise<string> {
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
 */
async function sendInvite(owner: AppSession, memberCode: string): Promise<void> {
  await (await owner.session.byTestId("member-roster.invite-button")).click();
  // The invite button is a TWO-STEP door on a vault that has not yet gained the group
  // tier, and gaining it is permanent; this vault is birth format and has never been
  // shared, so the confirmation is deterministic here rather than optional.
  await owner.session.byTestId("member-roster.share-confirm");
  await (await owner.session.byTestId("member-roster.share-confirm-cta")).click();
  await owner.session.byTestId("member-roster.invite-modal");
  await (await owner.session.byTestId("member-roster.invite-code")).replaceText(memberCode);
  // Inspect derives the SAS fingerprint locally, so it needs no server.
  await (await owner.session.byTestId("member-roster.inspect")).click();
  await owner.session.byTestId("member-roster.sas-fingerprint");
  // The post is gated on an explicit confirm.
  await (await owner.session.byTestId("member-roster.sas-confirm")).click();
  await (await owner.session.byTestId("member-roster.invite-confirm")).click();
  await owner.session.byTestId("member-roster.invitation-row", { timeoutMs: 60_000 });
  await closeSettings(owner.session);
}

/** Accept, through BOTH new steps: the password and the name gate. */
async function acceptInvite(member: AppSession, ownerCode: string, name: string): Promise<void> {
  // The identity home polls the relay on a timer and re-reads on focus, so an invite
  // posted a moment ago arrives without a nudge.
  await member.session.byTestId("identity-home.invite-row", { timeoutMs: SYNC_BUDGET_MS });
  await (await member.session.byTestId("identity-home.accept-open")).click();
  await member.session.byTestId("identity-home.accept-form");
  await (await member.session.byTestId("identity-home.accept-owner-code")).replaceText(ownerCode);
  await (await member.session.byTestId("identity-home.accept-inspect")).click();
  await member.session.byTestId("identity-home.accept-sas");
  // The out-of-band compare comes BEFORE the phrase is typed: it is the last point at
  // which the invitee can still refuse, and submit is gated on it.
  await (await member.session.byTestId("identity-home.accept-confirm")).click();
  await typePhrase(
    member.session,
    "identity-home.accept-phrase",
    "identity-home.accept-phrase-cell",
    MEMBER_PHRASE,
  );
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
  // dismissal two helpers up happened in the OWNER's WebView rather than this one.
  // Leaving it up is not a cosmetic failure: the offer registers the whole page
  // `inert` (`useOverlayInert`, myne-md/myne#728), so every later interaction on
  // this device is refused as `element not interactable` while the button it aims
  // at is plainly on screen. That is what this scenario did for three consecutive
  // runs before this line existed, at `openOwnRoster`'s `openSettings`.
  await dismissImporterOffer(member.session);
}

/**
 * Boot the fleet, drive the whole onboarding, and hand both devices to `fn`. The
 * teardown is in a `finally`, so a scenario throw never leaks a process.
 */
async function withAcceptedMember(
  fn: (owner: AppSession, member: AppSession) => Promise<void>,
): Promise<void> {
  const srv = await startSyncServer();
  let owner: AppSession | undefined;
  let member: AppSession | undefined;
  try {
    let account = "";
    owner = await launchDevice(0, {
      seedConfig: syncConfigSeed(srv.url),
      seed: (appDataDir) => {
        // Birth format (v0.2) on purpose: this is the vault a real user gets, and the
        // first invite below is what gains it the group tier.
        const seeded = seedVault(appDataDir, { password: OWNER_PASSWORD });
        account = seeded.account;
      },
    });
    member = await launchDevice(1, { seedConfig: syncConfigSeed(srv.url) });
    const memberCode = await createMemberIdentity(member);
    const ownerCode = await startOwnerIdentity(owner, account);
    await sendInvite(owner, memberCode);
    await acceptInvite(member, ownerCode, MEMBER_NAME);
    await fn(owner, member);
  } finally {
    if (member) await member.teardown();
    if (owner) await owner.teardown();
    await srv.teardown();
  }
}

describeCanary("MO-1 member onboarding (myne-md/myne#851)", () => {
  // The accept gate's whole claim: an accepted vault cannot reach the editor
  // unnamed, and the name the gate saved is what the other members read.
  // Vault-count precondition: 1 seeded vault on the owner, 0 on the member.
  it("accepts an invite through the password step and the name gate, and the name reaches the owner's list", async () => {
    await withAcceptedMember(async (owner, member) => {
      // The claim in one assertion: a row on the OWNER's list carries the name the
      // member typed into the gate. Nothing on the member's own device could show it,
      // and nothing but the group-tier member-names blob carries it across.
      await waitForName(
        owner.session,
        member.session,
        MEMBER_NAME,
        "the name the gate saved reaches the owner's list",
      );
      // Non-vacuity, both halves. The owner's own row is on that same list and it
      // renders the you-badge, so the row above is the member's and not the owner
      // reading its own name back; and the member's own row, read from the member's
      // device, carries no name at all, which is exactly why the count above and not a
      // presence test is the discriminator.
      expect(
        await owner.session.byTestIdAll("member-roster.row"),
        "the owner's list holds both people",
      ).toHaveLength(2);
      await openOwnRoster(member);
      expect(
        await renderedNames(member.session),
        "the member's own row is the you-badge, never their own name",
      ).not.toContain(MEMBER_NAME);
      await closeSettings(member.session);
    });
  });

  // The name is a label rather than a credential, so the member can change it from its
  // own row and clear it back to the fingerprint. Both are things the OTHER members
  // must see, which is the half one device cannot test.
  // Vault-count precondition: 1 seeded vault on the owner, 0 on the member.
  it("renames from the member's own row and clears it again, and the owner sees both", async () => {
    await withAcceptedMember(async (owner, member) => {
      // Baseline, so the rename below is a CHANGE rather than a first write.
      const baseline = await waitForName(
        owner.session,
        member.session,
        MEMBER_NAME,
        "baseline name on the owner's list",
      );
      expect(baseline.filter((candidate) => candidate === MEMBER_NAME)).toHaveLength(1);

      // The rename affordance renders on the caller's OWN row only, so it is the
      // member's device that drives it.
      await openOwnRoster(member);
      await (await member.session.byTestId("member-roster.name-edit")).click();
      await (await member.session.byTestId("member-roster.name-input")).replaceText(RENAMED_NAME);
      await (await member.session.byTestId("member-roster.name-save")).click();
      // The editor closes on save and the panel reloads on the same tick, so the input's
      // disappearance is the write having landed rather than a timeout.
      await member.session.waitForGone(testIdSelector("member-roster.name-input"));
      await closeSettings(member.session);

      const renamed = await waitForName(
        owner.session,
        member.session,
        RENAMED_NAME,
        "the renamed name reaches the owner's list",
      );
      // A rename REPLACES the row rather than adding one, so the old name must be gone.
      // Asserted on the same freshly-mounted read `waitForName` returned from (the panel
      // is still open on it), so it is one observation rather than a second one racing
      // the first.
      expect(renamed).not.toContain(MEMBER_NAME);

      // Clear: back to the fingerprint. The affordance is the second button of the same
      // row editor, so the editor is re-opened rather than left standing.
      await openOwnRoster(member);
      await (await member.session.byTestId("member-roster.name-edit")).click();
      await (await member.session.byTestId("member-roster.name-clear")).click();
      await member.session.waitForGone(testIdSelector("member-roster.name-input"));
      await closeSettings(member.session);

      await waitForNoName(
        owner.session,
        member.session,
        RENAMED_NAME,
        "the cleared name leaves the owner's list",
      );
      // The other half of the one rule every row follows: a row with no name is still
      // identified. The owner's own row renders no fingerprint, so the single fallback
      // on this list can only be the member's.
      expect(
        await owner.session.byTestIdAll("member-roster.fingerprint"),
        "a cleared name falls back to the short fingerprint",
      ).toHaveLength(1);
    });
  });
});
