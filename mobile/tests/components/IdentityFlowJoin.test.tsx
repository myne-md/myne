// @vitest-environment jsdom
//
// The phone's second-device join step (myne-md/myne#852 task 7): a member adding a
// vault this identity ALREADY belongs to onto this device. Three things are under
// test and none is the backend:
//
//   1. THE LIST. The invite list is recipient-scoped and carries claimed rows, and
//      the flow filtered them out entirely: a member looking at a vault they had
//      already been invited to saw "No invitations yet." and had no way to add it.
//      What this spec pins is that a claimed row renders, with a join affordance,
//      beside the pending rows rather than instead of them.
//
//   2. THE WIRING AND ITS SHAPE. `personJoinVault` takes the invite id, the vault's
//      account hash, the person's OWN recovery phrase and this device's password.
//      Four arguments, and the shape is the point: the join collects NO owner code,
//      because a second device has none and the owner it verifies against is the one
//      its own sealed profile already pins (decisions/protocol/0675). A field here
//      would let whatever is pasted into it become the trust anchor the pin exists to
//      be, so the negative half of this spec is about what the step does NOT collect.
//      Each negative assertion is paired with a positive one, since
//      `queryByTestId(...) === null` is otherwise satisfied by a step that never
//      rendered.
//
//   3. THE ERROR MAPPING, which is deliberately NOT the accept's. Both steps share
//      one Rust enum, but the accept's `BadRequest` arm tells the user to check a
//      pasted owner code and this step never collected one; rendering it would send
//      them looking for a field that is not there (myne-md/myne#794's shape, one
//      command over). The mapper lives in `@myne/client-core/join-member-vault` and is
//      exercised here through the real step rather than re-stated.
//
// The COPY is asserted BY i18n KEY: `useTranslation` echoes its keys in this file,
// so every string this step renders is compared against the desktop's own
// `identityHome.join*` keys. That half alone is vacuous, for the reason
// `mobile/AGENTS.md` records about the accept spec beside this one, so the closing
// block resolves each key in `locales/en/common.json` through the `@myne/locales-en`
// alias.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const personSetup = vi.hoisted(() => vi.fn());
const personStatus = vi.hoisted(() => vi.fn());
const personListInvites = vi.hoisted(() => vi.fn());
const personLock = vi.hoisted(() => vi.fn());
const personAcceptInvite = vi.hoisted(() => vi.fn());
const personJoinVault = vi.hoisted(() => vi.fn());
const inspectInviteCode = vi.hoisted(() => vi.fn());
const syncSetEndpoint = vi.hoisted(() => vi.fn());
const listRoster = vi.hoisted(() => vi.fn());
const setMyMemberName = vi.hoisted(() => vi.fn());

vi.mock("../../src/lib/app-window", () => ({ HAS_TAURI: true }));
vi.mock("../../src/lib/personAccount", () => ({
  personSetup,
  personStatus,
  personListInvites,
  personLock,
  personAcceptInvite,
  personJoinVault,
  inspectInviteCode,
}));
vi.mock("../../src/lib/sync", () => ({ syncSetEndpoint, listRoster }));
// `setMyMemberName` is stubbed because the command is the boundary this tier does
// not cross, but `memberNameErrorKey` is kept REAL so the sibling accept spec's
// assertions against the shared mapper are not invalidated by this file's mock.
vi.mock("../../src/lib/memberNames", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/memberNames")>()),
  setMyMemberName,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

import { IdentityFlow } from "../../src/app/flows/IdentityFlow";
import enCatalog from "@myne/locales-en";

const EN_CATALOG = enCatalog as Record<string, unknown>;

function localeValue(key: string): unknown {
  let node: unknown = EN_CATALOG;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null || !(part in node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** Every key the copy spec below asserts against, so the catalog claim is one list. */
const JOIN_COPY_KEYS = [
  "identityHome.claimedHeading",
  "identityHome.claimedHint",
  "identityHome.join",
  "identityHome.joinHint",
  "identityHome.joinPhraseLabel",
  "identityHome.joinPasswordNote",
  "identityHome.joinSubmit",
  "password.createForm.passwordLabel",
  "password.createForm.confirmLabel",
];

/** A projected digest of a SECRET (SYNC-13). The phrase and the password are compared
 *  through this so the value that was SENT is proven without the secret itself
 *  appearing as an expected argument; a digest and not a length, so an empty,
 *  truncated or different string still fails. */
function secretDigest(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h = Math.imul(h ^ value.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h;
}

/** BIP-39, in order, so the phrase is valid-shaped and 24 words wide. */
const PHRASE = [
  "abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract",
  "absurd", "abuse", "access", "accident", "account", "accuse", "achieve", "acid",
  "acoustic", "acquire", "across", "act", "action", "actor", "actress", "actual",
];

const CLAIMED_ID = "invite-claimed";
const CLAIMED_HASH = "ab".repeat(32);
const PENDING_ID = "invite-pending";
const PASSWORD = "Correct-Horse-9-Battery";

const CLAIMED = { invite_id_hex: CLAIMED_ID, vault_account_hash_hex: CLAIMED_HASH, claimed: true };
const PENDING = {
  invite_id_hex: PENDING_ID,
  vault_account_hash_hex: "cd".repeat(32),
  claimed: false,
};

beforeEach(() => {
  personStatus.mockReset().mockResolvedValue({
    enrolled: true,
    identity_unlocked: true,
    person_id_hex: "person",
    identity_code: "MYNE-PERSON-1:aa:bb:cc:dd",
    sealed_keypair_present: true,
  });
  personListInvites.mockReset().mockResolvedValue([CLAIMED]);
  personSetup.mockReset().mockResolvedValue({
    phrase: PHRASE.join(" "),
    fingerprint_hex: "fingerprint",
    person_id_hex: "person",
    identity_code: "MYNE-PERSON-1:aa:bb:cc:dd",
    approved: true,
  });
  personLock.mockReset().mockResolvedValue(undefined);
  personAcceptInvite.mockReset().mockResolvedValue(undefined);
  personJoinVault.mockReset().mockResolvedValue(undefined);
  inspectInviteCode.mockReset();
  syncSetEndpoint.mockReset().mockResolvedValue(undefined);
  // The name step is never reached from a join, but the accept spec's own path
  // passes through it and this module is shared state across both files' mocks.
  listRoster.mockReset().mockResolvedValue({ members: [], authority: "member", group_key_epoch: 1 });
  setMyMemberName.mockReset().mockResolvedValue({});
});

afterEach(() => cleanup());

function renderFlow(onAccepted: () => void = () => {}): void {
  render(<IdentityFlow onCancel={() => {}} onAccepted={onAccepted} />);
}

/** The join step's own first control, so it is the sentinel for "the step is on
 *  screen" rather than a proxy for it. */
async function openJoin(): Promise<void> {
  fireEvent.click(await screen.findByTestId("identity-flow.join-open"));
  await screen.findByTestId("identity-flow.join-hint");
}

function joinCells(): HTMLInputElement[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>('input[data-testid^="identity-flow.join-phrase"]'),
  );
}

/** Fill the 24 join cells from DOM order. */
function typeJoinPhrase(): void {
  const cells = joinCells();
  expect(cells).toHaveLength(24);
  cells.forEach((cell, i) => {
    fireEvent.change(cell, { target: { value: PHRASE[i] } });
  });
}

function setJoinPassword(value: string, confirm = value): void {
  fireEvent.change(screen.getByTestId("identity-flow.join.password-input"), {
    target: { value },
  });
  fireEvent.change(screen.getByTestId("identity-flow.join.confirm-input"), {
    target: { value: confirm },
  });
}

function submit(): HTMLButtonElement {
  return screen.getByTestId("identity-flow.join.submit") as HTMLButtonElement;
}

describe("IdentityFlow second-device join (myne-md/myne#852 task 7)", () => {
  it("lists a CLAIMED invite, which the accept list hides", async () => {
    renderFlow();

    // The row exists and offers the add, and the empty state, which is the only
    // thing a claimed-only list used to render, is gone.
    expect(await screen.findByTestId("identity-flow.claimed-row")).toBeTruthy();
    expect(screen.getByTestId("identity-flow.join-open")).toBeTruthy();
    expect(screen.queryByTestId("identity-flow.home-empty")).toBeNull();
    // …and a claimed row is NOT offered as an accept, which would re-claim an invite
    // this identity already holds a membership for.
    expect(screen.queryByTestId("identity-flow.invite-open")).toBeNull();
  });

  it("keeps the two lists apart when both kinds of invite are present", async () => {
    personListInvites.mockResolvedValue([PENDING, CLAIMED]);
    renderFlow();

    await screen.findByTestId("identity-flow.invite-row");
    // One row each, and neither affordance appears twice.
    expect(screen.getAllByTestId("identity-flow.invite-row")).toHaveLength(1);
    expect(screen.getAllByTestId("identity-flow.claimed-row")).toHaveLength(1);
    expect(screen.getAllByTestId("identity-flow.invite-open")).toHaveLength(1);
    expect(screen.getAllByTestId("identity-flow.join-open")).toHaveLength(1);
  });

  it("asks for the recovery phrase and a device password, and for no owner code", async () => {
    renderFlow();
    await openJoin();

    // Positive half first: the step really is on screen with its own phrase grid.
    expect(joinCells()).toHaveLength(24);
    expect(screen.getByTestId("identity-flow.join.password-input")).toBeTruthy();
    expect(screen.getByTestId("identity-flow.join-password-note")).toBeTruthy();

    // The negative half. No owner-code field, no fingerprint compare and nothing to
    // confirm: the owner this device verifies against comes from its own pinned
    // profile record, and a field here would let a pasted value replace that anchor.
    expect(screen.queryByTestId("identity-flow.accept-owner-code")).toBeNull();
    expect(screen.queryByTestId("identity-flow.accept-inspect")).toBeNull();
    expect(screen.queryByTestId("identity-flow.accept-owner-fingerprint")).toBeNull();
    expect(screen.queryByTestId("identity-flow.accept-confirm")).toBeNull();
    expect(inspectInviteCode).not.toHaveBeenCalled();

    // …and structurally, so a field arriving under a DIFFERENT testid convention is
    // caught too: this step collects no free text at all. The accept step's one
    // textarea IS the out-of-band owner code, so a textarea here is that field
    // renamed.
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
    expect(
      Array.from(document.querySelectorAll("[data-testid]")).filter((el) =>
        (el.getAttribute("data-testid") ?? "").includes("owner"),
      ),
    ).toHaveLength(0);
  });

  it("joins with the invite id, the account hash, the phrase and the password", async () => {
    const onAccepted = vi.fn();
    renderFlow(onAccepted);
    await openJoin();

    // Nothing collected: blocked.
    expect(submit().disabled).toBe(true);

    typeJoinPhrase();
    // Phrase complete, no password: blocked. The credential is REQUIRED, not offered
    // (myne-md/myne#851 task 7), so a member vault is never materialized without one.
    expect(submit().disabled).toBe(true);

    setJoinPassword(PASSWORD);
    expect(submit().disabled).toBe(false);

    fireEvent.click(submit());
    expect(personJoinVault).toHaveBeenCalledTimes(1);
    // The four arguments in order, with the two SECRETS compared by projected digest
    // rather than by value (SYNC-13). `secretDigest` still fails on an empty,
    // truncated or different string, so this is not merely "the call happened".
    const call = personJoinVault.mock.calls[0] as [string, string, string, string];
    expect(call).toHaveLength(4);
    expect(call[0]).toBe(CLAIMED_ID);
    expect(call[1]).toBe(CLAIMED_HASH);
    expect(secretDigest(call[2])).toBe(secretDigest(PHRASE.join(" ")));
    expect(secretDigest(call[3])).toBe(secretDigest(PASSWORD));
    // The two commands are not interchangeable: the accept claims an invite and
    // collects an owner code this step does not have.
    expect(personAcceptInvite).not.toHaveBeenCalled();
    // Reaches the shell directly: a join installs a vault the identity is already a
    // member of, so there is nothing to name (see the next test).
    await vi.waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
  });

  it("keeps the device password behind the project's floor", async () => {
    renderFlow();
    await openJoin();
    typeJoinPhrase();

    setJoinPassword("short-9");
    expect(submit().disabled).toBe(true);

    // Met length, mismatched confirm: still blocked, so the device password cannot be
    // one the user mistyped.
    setJoinPassword(PASSWORD, `${PASSWORD}-x`);
    expect(submit().disabled).toBe(true);
    expect(screen.getByTestId("identity-flow.join.password-mismatch")).toBeTruthy();
    fireEvent.click(submit());
    expect(personJoinVault).not.toHaveBeenCalled();

    setJoinPassword(PASSWORD);
    expect(submit().disabled).toBe(false);
  });

  // A join installs a vault this identity is ALREADY a member of, under a name its
  // first device already wrote. A name step here would let a second device silently
  // re-name a person, and the roster the name step consults is the one that already
  // holds that name.
  it("reaches the shell straight away, writing no name", async () => {
    const onAccepted = vi.fn();
    renderFlow(onAccepted);
    await openJoin();
    typeJoinPhrase();
    setJoinPassword(PASSWORD);
    fireEvent.click(submit());

    await vi.waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("identity-flow.name-input")).toBeNull();
    expect(setMyMemberName).not.toHaveBeenCalled();
  });

  it("maps a refused join to the join's own message, and stays put", async () => {
    const onAccepted = vi.fn();
    renderFlow(onAccepted);
    await openJoin();
    typeJoinPhrase();
    setJoinPassword(PASSWORD);

    personJoinVault.mockRejectedValueOnce({ kind: "BadRequest" });
    fireEvent.click(submit());

    const banner = await screen.findByTestId("identity-flow.join-error");
    expect(banner.textContent).toBe("identityHome.joinErrorBadRequest");
    // The accept's answer to the same enum arm names a pasted owner code, and this
    // step never collected one.
    expect(banner.textContent).not.toBe("identityHome.acceptErrorBadRequest");
    expect(onAccepted).not.toHaveBeenCalled();
    // Recoverable by retrying rather than by re-opening: the form is still there with
    // the phrase the user typed.
    expect(screen.getByTestId("identity-flow.join-hint")).toBeTruthy();
    expect(joinCells().map((cell) => cell.value)).toEqual(PHRASE);
  });

  it("gives the already-held refusal its own sentence", async () => {
    renderFlow();
    await openJoin();
    typeJoinPhrase();
    setJoinPassword(PASSWORD);

    personJoinVault.mockRejectedValueOnce({ kind: "VaultAlreadyHeld" });
    fireEvent.click(submit());

    // The routine case for a second device that has already been added, and its
    // remedy is the OPPOSITE of the generic `BadRequest` one: there is nothing to
    // fix and nothing to add. Folded into one arm, one of the two users is sent to
    // do the wrong thing.
    const banner = await screen.findByTestId("identity-flow.join-error");
    expect(banner.textContent).toBe("identityHome.joinErrorAlreadyHeld");
  });

  it("falls back to the generic message for a kind it does not know", async () => {
    renderFlow();
    await openJoin();
    typeJoinPhrase();
    setJoinPassword(PASSWORD);

    personJoinVault.mockRejectedValueOnce({ kind: "SomeKindAddedLater" });
    fireEvent.click(submit());

    // The default arm is the one whose absence is silent: a new refusal kind would
    // otherwise render as whichever case happened to be last in the switch.
    const banner = await screen.findByTestId("identity-flow.join-error");
    expect(banner.textContent).toBe("identityHome.joinError");
  });

  // Each step RESETS what it collects on the way IN, not on the way out, and that is
  // the property the user depends on: the phrase typed into one step must not be
  // sitting in the other's cells when it opens, where the accept's owner-code gate
  // would be the only thing between a phrase meant for a join and a foreign owner.
  // The three assertions below are the two directions of that, plus the same step
  // re-entered.
  //
  // The fixture asserts the PROPERTY rather than either mechanism, and the belts are
  // mutually redundant on purpose: each step also clears on its two exits (the header
  // back and the footer cancel), so removing any ONE of the three clear sites leaves
  // every assertion here green (injected and measured). What the assertions do catch
  // is the property actually breaking, which is proven live by disabling all three
  // clear sites for one step: the join side then fails assertion two, the accept side
  // assertion one. A future exit path that skips both belts is exactly the regression
  // this holds, so it is worth the round trip.
  it("starts each step empty, whatever the last one collected", async () => {
    personListInvites.mockResolvedValue([PENDING, CLAIMED]);
    inspectInviteCode.mockResolvedValue({
      person_id_hex: "owner-person",
      fingerprint_hex: "c0ffee01",
    });
    renderFlow();

    // The accept hides its phrase grid behind the owner check, so the code has to be
    // inspected and confirmed before there is a phrase to type into it.
    const acceptCells = (): HTMLInputElement[] =>
      Array.from(
        document.querySelectorAll<HTMLInputElement>(
          'input[data-testid^="identity-flow.accept-phrase"]',
        ),
      );
    const openAcceptFromHome = async (): Promise<void> => {
      fireEvent.click(await screen.findByTestId("identity-flow.invite-open"));
      fireEvent.change(await screen.findByTestId("identity-flow.accept-owner-code"), {
        target: { value: "MYNE-PERSON-1:aa:bb:cc:dd" },
      });
      fireEvent.click(screen.getByTestId("identity-flow.accept-inspect"));
      await screen.findByTestId("identity-flow.accept-owner-fingerprint");
      fireEvent.click(screen.getByTestId("identity-flow.accept-confirm"));
    };

    await openAcceptFromHome();
    expect(acceptCells()).toHaveLength(24);
    acceptCells().forEach((cell, i) => fireEvent.change(cell, { target: { value: PHRASE[i] } }));
    fireEvent.click(screen.getByTestId("identity-flow.accept-cancel"));

    // The accept's phrase is not in the join's cells.
    await openJoin();
    expect(joinCells().map((cell) => cell.value)).toEqual(Array(24).fill(""));

    // …and the join's phrase is not left behind for the next join either.
    typeJoinPhrase();
    fireEvent.click(screen.getByTestId("identity-flow.join-cancel"));
    await openJoin();
    expect(joinCells().map((cell) => cell.value)).toEqual(Array(24).fill(""));

    // …and it is not in the accept's cells, which is the direction that matters most:
    // an accept submitted with a phrase the user typed for a join is a phrase offered
    // to an owner this device has not verified.
    fireEvent.click(screen.getByTestId("identity-flow.join-cancel"));
    await openAcceptFromHome();
    expect(acceptCells().map((cell) => cell.value)).toEqual(Array(24).fill(""));
  });

  // The join grid pastes as the accept grid does. Both go through one shared
  // spreader, so this is also the accept's paste path under test: a 24-word phrase
  // is pasted rather than typed, and a paste that lands only in the first cell is
  // not a usable shape.
  it("spreads a pasted phrase across the join grid", async () => {
    renderFlow();
    await openJoin();

    fireEvent.paste(joinCells()[0], { clipboardData: { getData: () => PHRASE.join(" ") } });
    expect(joinCells().map((cell) => cell.value)).toEqual(PHRASE);
  });

  it("renders the desktop's copy, key for key", async () => {
    renderFlow();

    expect((await screen.findByTestId("identity-flow.join-open")).textContent).toBe(
      "identityHome.join",
    );
    // The claimed section's own heading and hint, read before the step replaces them.
    expect(screen.getByTestId("identity-flow.claimed-hint").textContent).toBe(
      "identityHome.claimedHint",
    );
    await openJoin();

    expect(screen.getByTestId("identity-flow.join-hint").textContent).toBe(
      "identityHome.joinHint",
    );
    expect(screen.getByTestId("identity-flow.join-phrase-label").textContent).toBe(
      "identityHome.joinPhraseLabel",
    );
    expect(screen.getByTestId("identity-flow.join-password-note").textContent).toBe(
      "identityHome.joinPasswordNote",
    );
    expect(screen.getByTestId("identity-flow.join.password-label").textContent).toBe(
      "password.createForm.passwordLabel",
    );
    expect(screen.getByTestId("identity-flow.join.confirm-label").textContent).toBe(
      "password.createForm.confirmLabel",
    );
    expect(submit().textContent).toBe("identityHome.joinSubmit");

    // The echoed-key half is only half the claim: a key the REAL catalog does not
    // carry renders nothing in the shipped app while passing every assertion above.
    // Each key this spec asserted against, plus the claimed section's own two, is
    // resolved in `locales/en/common.json` here, and a value equal to its own key
    // means the catalog would render the key verbatim.
    expect(
      JOIN_COPY_KEYS.filter((key) => {
        const value = localeValue(key);
        return typeof value !== "string" || value === "" || value === key;
      }),
    ).toEqual([]);
  });
});
