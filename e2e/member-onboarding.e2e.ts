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
import { closeSettings, openSettings } from "./support/flows";
import { testIdSelector } from "./support/webdriver";
// The fleet steps and the phrase vectors live in `support/member-fleet.ts`, shared
// with `member-devices.e2e.ts` rather than copied: the parts that matter are the
// parts a copy loses silently, and two of those (the two phrases must be two
// PEOPLE, and the accept's submit IS the password step) are load-bearing here.
import {
  MEMBER_NAME,
  RENAMED_NAME,
  SYNC_BUDGET_MS,
  acceptInvite,
  createMemberIdentity,
  launchMemberDevice,
  launchOwnerDevice,
  sendInvite,
  sleep,
  startOwnerIdentity,
  syncNow,
  type Session,
} from "./support/member-fleet";

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
    // Birth format (v0.2) on purpose: this is the vault a real user gets, and the
    // first invite below is what gains it the group tier.
    const launchedOwner = await launchOwnerDevice(srv.url);
    owner = launchedOwner.owner;
    member = await launchMemberDevice(1, srv.url);
    const memberCode = await createMemberIdentity(member);
    const ownerCode = await startOwnerIdentity(owner, launchedOwner.account);
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
