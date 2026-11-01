// @vitest-environment jsdom
//
// The phone's accept-an-invite step and the name step behind it
// (myne-md/myne#851 tasks 14 and 15). Three things are under test and none is the
// backend:
//
//   1. The WIRING. `personAcceptInvite` has been exported from
//      `mobile/src/lib/personAccount.ts` since the identity flow landed and no
//      production code has ever called it, so the mobile client listed pending
//      invites and then told the user to open one somewhere that does not exist.
//      What this spec pins is the four arguments the accept command takes, in
//      order, from the four things the form collects: the invite id from the row
//      that opened it, the owner's out-of-band identity code, the recovery
//      phrase, and the device-local password (myne-md/myne#851 task 7).
//
//   2. The COPY, asserted BY i18n KEY. `useTranslation` echoes its keys here, so
//      every string this form renders is compared against the desktop's own
//      `identityHome.accept*` keys rather than against an English sentence
//      retyped into this file. Two clients holding the same key cannot render
//      different copy, and the catalog assertion that closes that spec (`locales/
//      en/common.json` really carries every key) is what stops an echoed key from
//      passing while rendering nothing.
//
//   3. The NAME STEP, which is what makes the accept's completion conditional
//      (task 15). An accepted vault is on disk and unlocked when `accept` returns,
//      and the callback that would open its editor is WITHHELD until a name is
//      written, so `onAccepted` firing is evidence the name landed and not evidence
//      the accept did. The step asks the ROSTER whether it has to ask at all, so the
//      spec drives both answers: a member with no row yet is asked and cannot get
//      past it, and one re-invited to a vault they already named in is not asked.
//
// The write's own refusal mapping is NOT re-stated here: it lives in
// `@myne/client-core/member-name`, and this file mocks `setMyMemberName` while
// keeping the REAL mapper through `importOriginal`, so the error assertion below
// exercises the shared switch rather than a copy of it.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const personSetup = vi.hoisted(() => vi.fn());
const personStatus = vi.hoisted(() => vi.fn());
const personListInvites = vi.hoisted(() => vi.fn());
const personLock = vi.hoisted(() => vi.fn());
const personAcceptInvite = vi.hoisted(() => vi.fn());
const personAccountNumber = vi.hoisted(() => vi.fn());
const syncSetEndpoint = vi.hoisted(() => vi.fn());
const listRoster = vi.hoisted(() => vi.fn());
const setMyMemberName = vi.hoisted(() => vi.fn());

/**
 * What the accept/join reports back. The flow reads `vault_id` off it to address
 * the approval wait the installed vault owes (`AppShell`'s
 * `landOnInstalledVault`), so a mock resolving `undefined` would throw inside the
 * flow rather than exercise it.
 */
const ACCEPTED_VIEW = {
  vault_id: "00000000-0000-7000-8000-00000000000b",
  vault_account_hash_hex: "00112233445566778899aabbccddeeff",
  owner_fingerprint_hex: "00".repeat(32),
  group_key_epoch: 1,
};

vi.mock("../../src/lib/app-window", () => ({ HAS_TAURI: true }));
vi.mock("../../src/lib/personAccount", () => ({
  personSetup,
  personStatus,
  personListInvites,
  personLock,
  personAcceptInvite,
  // The gate shows the account number once it lands on home (myne-md/myne#911);
  // a mock that omits the export makes that call throw inside the probe's
  // `.then`, which keeps the flow on the gate and reads as a routing bug.
  personAccountNumber,
}));
vi.mock("../../src/lib/sync", () => ({ syncSetEndpoint, listRoster }));
// `setMyMemberName` is stubbed because the command is the boundary this tier does
// not cross, but `memberNameErrorKey` is kept REAL: the error assertion below is
// about the shared six-arm mapping in `@myne/client-core/member-name`, and a second
// copy of it written here would be the drift that mapper exists to prevent.
vi.mock("../../src/lib/memberNames", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/memberNames")>()),
  setMyMemberName,
}));
// `useTranslation` echoes keys, so every copy assertion below reads as the
// desktop's own `identityHome.accept*` KEY rather than as an English sentence
// retyped here. The `initReactI18next` stub is not decoration: the flow reaches
// the shared `@myne/i18n` runtime transitively (`src/lib/device-name.ts`), whose
// module body calls `i18n.use(initReactI18next)`, and a mock without it throws on
// import. Same shape as `tests/hide-vault-names.test.ts`.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

import { IdentityFlow } from "../../src/app/flows/IdentityFlow";
// The real English catalog, through the alias the mobile test config already resolves
// to it: the copy spec below compares rendered strings against i18n KEYS (that is what
// the `useTranslation` stub echoes), and an echoed key would pass while the shipped app
// renders nothing if the catalog never carried it. Reading the ALIAS rather than a
// relative path keeps the resolution correct if this spec ever moves.
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
const ACCEPT_COPY_KEYS = [
  "identityHome.stepIndicator",
  "identityHome.stepVerifyOwner",
  "identityHome.stepRecoveryPhrase",
  "identityHome.stepDevicePassword",
  "identityHome.acceptHeading",
  "identityHome.acceptHint",
  "identityHome.acceptOwnerCodeLabel",
  "identityHome.phraseHeading",
  "identityHome.acceptPhraseHint",
  "identityHome.acceptPhraseLabel",
  "identityHome.passwordHeading",
  "identityHome.acceptPasswordNote",
  "password.createForm.passwordLabel",
  "password.createForm.confirmLabel",
  "identityHome.acceptSubmit",
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

const INVITE_ID = "invite-id-hex";
const OWNER_CODE = "MYNE-PERSON-1:aa:bb:cc:dd";
const PASSWORD = "Correct-Horse-9-Battery";
/** What the name step is given. A display name is a label, not a credential:
 *  SYNC-13 covers phrases and passwords, which are compared below by projected
 *  digest rather than by value. */
const MEMBER_NAME = "Rowan Ash";
/** This device's own row, as `sync_list_roster` reports it. `is_self` is decided by
 *  the backend from the local person fingerprint (myne-md/myne#859), so the panel and
 *  this step both read it rather than inferring one from `role`. */
const SELF_ROW = {
  fingerprint_hex: "a".repeat(64),
  is_self: true,
  display_name: "",
  name_state: "absent" as const,
  role: "member" as const,
  previous_fingerprint_hex: null,
  continuity: null,
};

beforeEach(() => {
  personAccountNumber.mockReset().mockResolvedValue("MY-ABCD-EFGH-JKMN-PQRS-TUVW");
  personStatus.mockReset().mockResolvedValue({
    enrolled: true,
    identity_unlocked: true,
    person_id_hex: "person",
    identity_code: OWNER_CODE,
    sealed_keypair_present: true,
    // The lifecycle state is what routes the flow past the gate (myne-md/myne#911
    // task 12): the mock is a copy of the status contract, and a copy that omits a
    // field the flow reads sends an enrolled device to the gate.
    state: "enrolled",
  });
  personListInvites.mockReset().mockResolvedValue([
    { invite_id_hex: INVITE_ID, vault_account_hash_hex: "a".repeat(64), claimed: false },
  ]);
  personSetup.mockReset().mockResolvedValue({
    phrase: PHRASE.join(" "),
    fingerprint_hex: "fingerprint",
    person_id_hex: "person",
    identity_code: OWNER_CODE,
    approved: true,
  });
  personLock.mockReset().mockResolvedValue(undefined);
  personAcceptInvite.mockReset().mockResolvedValue(ACCEPTED_VIEW);
  syncSetEndpoint.mockReset().mockResolvedValue(undefined);
  // Default: an accepted member whose row carries no name yet, which is the state
  // the step exists for. `namedRoster()` below is the other answer.
  listRoster.mockReset().mockResolvedValue({
    members: [SELF_ROW],
    authority: "member",
    group_key_epoch: 1,
  });
  setMyMemberName.mockReset().mockResolvedValue({});
});

/** The roster as a member RE-INVITED to a vault they already named in reads it. */
function namedRoster(): void {
  listRoster.mockResolvedValue({
    members: [
      { ...SELF_ROW, display_name: MEMBER_NAME, name_state: "verified", signature_hex: "ff" },
    ],
    authority: "member",
    group_key_epoch: 1,
  });
}

afterEach(() => cleanup());

/** Land on the identity home (an enrolled device with one pending invite) and
 *  open the accept step from that row. The owner-code field is the step's own
 *  first control, so it is the sentinel for "the step is on screen". */
async function openAccept(onAccepted: () => void = () => {}): Promise<void> {
  render(<IdentityFlow onCancel={() => {}} onAccepted={onAccepted} />);
  fireEvent.click(await screen.findByTestId("identity-flow.invite-open"));
  await screen.findByTestId("identity-flow.accept-owner-code");
}

/** Fill the 24 phrase cells from DOM order. */
function typePhrase(): void {
  const cells = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[data-testid^="identity-flow.accept-phrase"]'),
  );
  expect(cells).toHaveLength(24);
  cells.forEach((cell, i) => {
    fireEvent.change(cell, { target: { value: PHRASE[i] } });
  });
}

/** Fill the owner's identity code on wizard step 1, which releases Continue. */
async function fillOwnerCode(): Promise<void> {
  fireEvent.change(screen.getByTestId("identity-flow.accept-owner-code"), {
    target: { value: OWNER_CODE },
  });
}

/** The Continue control, which shares one testid across wizard steps 1 and 2
 *  (only one is mounted at a time). */
function continueButton(): HTMLButtonElement {
  return screen.getByTestId("identity-flow.accept-continue") as HTMLButtonElement;
}

/** Step 1 → step 2 (the phrase). Gated on the owner's code being present. */
function toPhraseStep(): void {
  fireEvent.click(continueButton());
}

/** Step 2 → step 3 (the password). Gated on all 24 cells being filled. */
function toPasswordStep(): void {
  fireEvent.click(continueButton());
}

function setPassword(value: string, confirm = value): void {
  fireEvent.change(screen.getByTestId("identity-flow.accept.password-input"), {
    target: { value },
  });
  fireEvent.change(screen.getByTestId("identity-flow.accept.confirm-input"), {
    target: { value: confirm },
  });
}

function submit(): HTMLButtonElement {
  return screen.getByTestId("identity-flow.accept.submit") as HTMLButtonElement;
}

/** Arrive at the name step past its roster check and write `name`. Not awaited
 *  past the click: the write is async, and each caller waits on what it cares
 *  about (`onAccepted` or the error banner) rather than on a proxy. */
async function typeName(name: string): Promise<void> {
  const input = await screen.findByTestId("identity-flow.name-input");
  fireEvent.change(input, { target: { value: name } });
  fireEvent.click(screen.getByTestId("identity-flow.name.save"));
}

/** Drive the whole accept wizard to the name step it now lands on. */
async function acceptToNameStep(): Promise<void> {
  await fillOwnerCode();
  toPhraseStep();
  typePhrase();
  toPasswordStep();
  setPassword(PASSWORD);
  fireEvent.click(submit());
  await screen.findByTestId("identity-flow.name-input");
}

describe("IdentityFlow accept (myne-md/myne#851 task 14)", () => {
  it("opens the accept step from a pending invite row", async () => {
    await openAccept();
    // The step is the form; the invite row is behind it.
    expect(screen.getByTestId("identity-flow.accept-owner-code")).toBeTruthy();
    expect(screen.queryByTestId("identity-flow.invite-row")).toBeNull();
    // The wizard's first step: its counter is on screen and the phrase grid is not.
    expect(screen.getByTestId("identity-flow.accept-step")).toBeTruthy();
    expect(screen.queryByTestId("identity-flow.accept-phrase")).toBeNull();
    expect(screen.queryByTestId("identity-flow.accept.password-input")).toBeNull();
  });

  it("walks the steps in order, and Back preserves what the last one collected", async () => {
    await openAccept();

    // Step 1: the owner check, and NOT the phrase grid or the password.
    expect(screen.queryByTestId("identity-flow.accept-phrase")).toBeNull();
    expect(screen.queryByTestId("identity-flow.accept.password-input")).toBeNull();

    const segmentFill = (): (string | null)[] =>
      Array.from(
        screen.getByTestId("identity-flow.accept-step").querySelectorAll("[data-filled]"),
      ).map((el) => el.getAttribute("data-filled"));

    // Three steps, one segment filled.
    expect(segmentFill()).toEqual(["true", "false", "false"]);

    // Step 1's Continue is the gate on the owner's code: blocked until it is
    // present.
    expect(continueButton().disabled).toBe(true);
    await fillOwnerCode();
    expect(continueButton().disabled).toBe(false);
    toPhraseStep();

    // Step 2: the phrase grid, and NOT the password.
    expect(screen.getByTestId("identity-flow.accept-phrase")).toBeTruthy();
    expect(screen.queryByTestId("identity-flow.accept.password-input")).toBeNull();
    expect(segmentFill()).toEqual(["true", "true", "false"]);
    // 24 empty cells: Continue is blocked.
    expect(continueButton().disabled).toBe(true);
    typePhrase();
    expect(continueButton().disabled).toBe(false);
    toPasswordStep();

    // Step 3: the password form, and NOT the phrase grid.
    expect(screen.getByTestId("identity-flow.accept.password-input")).toBeTruthy();
    expect(screen.queryByTestId("identity-flow.accept-phrase")).toBeNull();
    expect(segmentFill()).toEqual(["true", "true", "true"]);

    // Back, twice, and step 1 still carries what it collected: the owner's code,
    // which keeps Continue unlocked.
    fireEvent.click(screen.getByTestId("identity-flow.accept-step-back"));
    fireEvent.click(screen.getByTestId("identity-flow.accept-step-back"));
    expect(
      (screen.getByTestId("identity-flow.accept-owner-code") as HTMLTextAreaElement).value,
    ).toBe(OWNER_CODE);
    expect(continueButton().disabled).toBe(false);
  });

  it("accepts with the invite id, the owner code, the phrase and the password", async () => {
    const onAccepted = vi.fn();
    await openAccept(onAccepted);

    // Nothing collected: step 1's gate is shut.
    expect(continueButton().disabled).toBe(true);

    await fillOwnerCode();
    // Fingerprint confirmed: step 1 opens, but the submit is not reachable yet.
    expect(continueButton().disabled).toBe(false);
    toPhraseStep();

    // Phrase step, nothing typed: blocked.
    expect(continueButton().disabled).toBe(true);

    typePhrase();
    // Phrase complete, so the step opens; the final submit is behind the password.
    expect(continueButton().disabled).toBe(false);
    toPasswordStep();

    // No password: blocked. The credential is REQUIRED, not offered
    // (myne-md/myne#851 task 7), so a member vault is never materialized
    // without one.
    expect(submit().disabled).toBe(true);

    setPassword(PASSWORD);
    expect(submit().disabled).toBe(false);

    fireEvent.click(submit());
    expect(personAcceptInvite).toHaveBeenCalledTimes(1);
    // The four arguments in order, with the two SECRETS compared by projected digest
    // rather than by value (SYNC-13). `secretDigest` still fails on an empty,
    // truncated or different string, so this is not merely "the call happened".
    const [inviteId, ownerCode, sentPhrase, sentPassword] = personAcceptInvite.mock
      .calls[0] as [string, string, string, string];
    expect(inviteId).toBe(INVITE_ID);
    expect(ownerCode).toBe(OWNER_CODE);
    expect(secretDigest(sentPhrase)).toBe(secretDigest(PHRASE.join(" ")));
    expect(secretDigest(sentPassword)).toBe(secretDigest(PASSWORD));
    // The vault exists and is unlocked, and the shell's callback is STILL withheld:
    // the name step sits between the two and is what opens the editor.
    expect(onAccepted).not.toHaveBeenCalled();
    await typeName(MEMBER_NAME);
    await vi.waitFor(() => expect(setMyMemberName).toHaveBeenCalledWith(MEMBER_NAME));
    // The installed vault's id travels with the callback: the shell addresses the
    // approval wait with it, and a fresh member device owes that wait before it can
    // pull (`AppShell`'s `landOnInstalledVault`).
    expect(onAccepted).toHaveBeenCalledWith(ACCEPTED_VIEW.vault_id);
  });

  it("keeps the credential behind the project's floor", async () => {
    await openAccept();
    await fillOwnerCode();
    toPhraseStep();
    typePhrase();
    toPasswordStep();

    setPassword("short-9");
    expect(submit().disabled).toBe(true);

    // Met length, mismatched confirm: still blocked, so the device password
    // cannot be one the user mistyped.
    setPassword(PASSWORD, `${PASSWORD}-x`);
    expect(submit().disabled).toBe(true);

    setPassword(PASSWORD);
    expect(submit().disabled).toBe(false);
  });

  it("gates the owner step on the owner's code being present", async () => {
    await openAccept();
    expect(continueButton().disabled).toBe(true);

    fireEvent.change(screen.getByTestId("identity-flow.accept-owner-code"), {
      target: { value: OWNER_CODE },
    });
    expect(continueButton().disabled).toBe(false);
  });

  it("maps a refused accept to the desktop's own message", async () => {
    const onAccepted = vi.fn();
    await openAccept(onAccepted);
    await fillOwnerCode();
    toPhraseStep();
    typePhrase();
    toPasswordStep();
    setPassword(PASSWORD);

    personAcceptInvite.mockRejectedValueOnce({ kind: "NotEnrolled" });
    fireEvent.click(submit());

    // The refusal belongs to the step that produced it (the password step), so its
    // banner is there, and the step change clears it.
    const banner = await screen.findByTestId("identity-flow.accept-error");
    expect(banner.textContent).toBe("identityHome.acceptErrorNotEnrolled");
    expect(onAccepted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("identity-flow.accept-step-back"));
    expect(screen.queryByTestId("identity-flow.accept-error")).toBeNull();
  });

  it("renders the desktop's copy, key for key", async () => {
    await openAccept();

    // Step 1: the owner check.
    expect(screen.getByTestId("identity-flow.accept-step").textContent).toBe(
      "identityHome.stepIndicator",
    );
    expect(screen.getByText("identityHome.acceptHeading")).toBeTruthy();
    expect(screen.getByTestId("identity-flow.accept-hint").textContent).toBe(
      "identityHome.acceptHint",
    );
    expect(
      screen.getByTestId("identity-flow.accept-owner-code").getAttribute("aria-label"),
    ).toBe("identityHome.acceptOwnerCodeLabel");

    await fillOwnerCode();
    toPhraseStep();

    // Step 2: the phrase.
    expect(screen.getByText("identityHome.phraseHeading")).toBeTruthy();
    expect(screen.getByText("identityHome.acceptPhraseHint")).toBeTruthy();
    expect(screen.getByTestId("identity-flow.accept-phrase-label").textContent).toBe(
      "identityHome.acceptPhraseLabel",
    );
    typePhrase();
    toPasswordStep();

    // Step 3: the password.
    expect(screen.getByText("identityHome.passwordHeading")).toBeTruthy();
    expect(screen.getByTestId("identity-flow.accept-password-note").textContent).toBe(
      "identityHome.acceptPasswordNote",
    );
    expect(screen.getByTestId("identity-flow.accept.password-label").textContent).toBe(
      "password.createForm.passwordLabel",
    );
    expect(screen.getByTestId("identity-flow.accept.confirm-label").textContent).toBe(
      "password.createForm.confirmLabel",
    );
    expect(submit().textContent).toBe("identityHome.acceptSubmit");

    // The echoed-key half is only half the claim: a key the REAL catalog does not carry
    // renders nothing in the shipped app while passing every assertion above. Each key
    // this spec asserted against is resolved in `locales/en/common.json` here, and a
    // value equal to its own key means the catalog would render the key verbatim.
    expect(
      ACCEPT_COPY_KEYS.filter((key) => {
        const value = localeValue(key);
        return typeof value !== "string" || value === "" || value === key;
      }),
    ).toEqual([]);
  });
});

// The name step behind the accept (myne-md/myne#851 task 15). It is the accept's
// completion rather than a follow-up screen: the vault is already on disk and
// unlocked, and the callback that opens its editor is withheld until a name is
// written.
describe("IdentityFlow name step (myne-md/myne#851 task 15)", () => {
  it("cannot be left without a name, and writes nothing until Save", async () => {
    const onAccepted = vi.fn();
    await openAccept(onAccepted);
    await acceptToNameStep();

    // Forward-only, and the header says so: no back chevron, no skip, and the accept
    // form is gone rather than sitting behind the step.
    expect(screen.queryByLabelText("common.back")).toBeNull();
    expect(screen.queryByTestId("identity-flow.accept.submit")).toBeNull();

    const save = screen.getByTestId("identity-flow.name.save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    // Blank is not a name, and the guard is not merely the button's `disabled`: a
    // click on a whitespace draft must not reach the writer either, or the disabled
    // state would be the only thing standing between a required step and an empty row.
    fireEvent.change(screen.getByTestId("identity-flow.name-input"), {
      target: { value: "   " },
    });
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(setMyMemberName).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it("does not ask a member who already named itself in this vault", async () => {
    namedRoster();
    const onAccepted = vi.fn();
    await openAccept(onAccepted);
    await fillOwnerCode();
    toPhraseStep();
    typePhrase();
    toPasswordStep();
    setPassword(PASSWORD);
    fireEvent.click(submit());

    // The roster's answer IS the question here, and a member re-invited to a vault
    // they already named in reads as named: the step is passed through rather than
    // asked again, and the callback fires without a second write.
    await vi.waitFor(() => expect(onAccepted).toHaveBeenCalledWith(ACCEPTED_VIEW.vault_id));
    expect(setMyMemberName).not.toHaveBeenCalled();
    // Non-vacuity: the step did render (the test harness never unmounts the flow, so
    // it is still on screen) and the member was released THROUGH it rather than the
    // whole branch having been skipped. The absence of a write is what says no second
    // question was asked.
    expect(screen.getByTestId("identity-flow.name-input")).toBeTruthy();
  });

  it("still asks when the roster cannot be read", async () => {
    listRoster.mockRejectedValue(new Error("no session"));
    const onAccepted = vi.fn();
    await openAccept(onAccepted);
    await fillOwnerCode();
    toPhraseStep();
    typePhrase();
    toPasswordStep();
    setPassword(PASSWORD);
    fireEvent.click(submit());

    // An unreadable roster is not a name and not a reason to skip a required step:
    // the safe direction is to ask.
    expect(await screen.findByTestId("identity-flow.name-input")).toBeTruthy();
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it("maps a refused name write to the desktop's own message, and stays put", async () => {
    const onAccepted = vi.fn();
    await openAccept(onAccepted);
    await acceptToNameStep();

    setMyMemberName.mockRejectedValueOnce({ kind: "NameTooLong" });
    await typeName(MEMBER_NAME);

    const banner = await screen.findByTestId("identity-flow.name-error");
    expect(banner.textContent).toBe("sync.memberRoster.nameErrorTooLong");
    expect(onAccepted).not.toHaveBeenCalled();
    // Recoverable by retyping rather than by re-accepting: the field is still there.
    expect(screen.getByTestId("identity-flow.name-input")).toBeTruthy();
  });

  it("falls back to the generic message for a kind it does not know", async () => {
    const onAccepted = vi.fn();
    await openAccept(onAccepted);
    await acceptToNameStep();

    // The default arm is the one whose absence is silent: a new refusal kind would
    // otherwise render as whichever case happened to be last in the switch.
    setMyMemberName.mockRejectedValueOnce({ kind: "SomeKindAddedLater" });
    await typeName(MEMBER_NAME);

    const banner = await screen.findByTestId("identity-flow.name-error");
    expect(banner.textContent).toBe("sync.memberRoster.nameErrorGeneric");
  });

  it("renders the desktop gate's copy, key for key", async () => {
    await openAccept();
    await acceptToNameStep();

    expect(
      screen.getByTestId("identity-flow.name-input").getAttribute("aria-label"),
    ).toBe("sync.nameGate.label");
    expect(screen.getByTestId("identity-flow.name.save").textContent).toBe(
      "sync.nameGate.save",
    );
  });
});

// ── The first-run fork, the forget trigger and the account number ─────────────
//
// Three defects found while manually testing the identity surfaces
// (myne-md/myne#932). Each assertion below fails on the code as it shipped:
//
//  1. "I already have an identity" was one level in, behind a button labelled
//     "Create your identity and vault", so a returning user had to walk into a
//     create action to find their own identity.
//  2. The forget-identity acknowledgement rendered permanently on the home step,
//     with the destructive button merely disabled until it was ticked.
//  3. The account number rendered as its raw 20-character canonical body, with no
//     `MY-` prefix and no dash groups.

describe("IdentityFlow first-run fork (myne-md/myne#932)", () => {
  it("offers both credentials of an identity you already have", () => {
    const onScanCode = vi.fn();
    render(
      <IdentityFlow
        initialStep="join-fork"
        onScanCode={onScanCode}
        onCancel={() => {}}
        onAccepted={() => {}}
      />,
    );
    try {
      expect(screen.getByTestId("identity-flow.fork-words")).toBeTruthy();
      const code = screen.getByTestId("identity-flow.fork-code");
      fireEvent.click(code);
      expect(onScanCode).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it("shows the words door even when the shell cannot scan", () => {
    // The QR door is optional because the scanner is the shell's; the phrase door
    // is not, and a flow that rendered neither would leave a user with an existing
    // identity no way in at all.
    render(<IdentityFlow initialStep="join-fork" onCancel={() => {}} onAccepted={() => {}} />);
    try {
      expect(screen.getByTestId("identity-flow.fork-words")).toBeTruthy();
      expect(screen.queryByTestId("identity-flow.fork-code")).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("IdentityFlow identity home (myne-md/myne#932)", () => {
  it("puts the forget acknowledgement behind its trigger", async () => {
    render(<IdentityFlow onCancel={() => {}} onAccepted={() => {}} />);
    try {
      // The home step is what an enrolled device lands on.
      const open = await screen.findByTestId("identity-flow.home-forget-open");
      expect(screen.queryByTestId("identity-flow.home-forget-ack")).toBeNull();
      expect(screen.queryByTestId("identity-flow.home-forget")).toBeNull();

      fireEvent.click(open);

      expect(screen.getByTestId("identity-flow.home-forget-ack")).toBeTruthy();
      const destructive = screen.getByTestId("identity-flow.home-forget") as HTMLButtonElement;
      // Still gated by the acknowledgement, which is the point of the checkbox.
      expect(destructive.disabled).toBe(true);

      fireEvent.click(screen.getByTestId("identity-flow.home-forget-ack"));
      expect((screen.getByTestId("identity-flow.home-forget") as HTMLButtonElement).disabled).toBe(
        false,
      );
    } finally {
      cleanup();
    }
  });

  it("renders the account number in the MY- display form", async () => {
    // The command answers the CANONICAL body and leaves the grouping to the
    // client; the desktop takes it from `@myne/client-core`, and so must this
    // screen. A canonical fixture (20 chars, no dashes) is what makes the
    // assertion able to fail.
    personAccountNumber.mockResolvedValue("0123456789abcdefghij");
    render(<IdentityFlow onCancel={() => {}} onAccepted={() => {}} />);
    try {
      const field = (await screen.findByTestId(
        "identity-flow.home-account-number",
      )) as HTMLInputElement;
      expect(personAccountNumber).toHaveBeenCalled();
      expect(field.value).toBe("MY-0123-4567-89AB-CDEF-GHIJ");
    } finally {
      cleanup();
    }
  });
});
