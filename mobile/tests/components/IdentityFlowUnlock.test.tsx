// @vitest-environment jsdom
//
// The phone's identity unlock door (2026-10-25, desktop parity).
//
// The failure this pins, stated as it was seen: `IdentityFlow` rendered
// "Create a vault" unconditionally, and the act signs the vault's first member
// list with the person identity. A phone whose identity was sealed for the
// session therefore offered a button whose only possible answer was
// `PersonLocked`, and mobile had no surface at all that could clear it: the
// unlock modal existed on desktop only. The asymmetry was invisible to
// `check-twin-inventory.mjs`, because the pair (`IdentityHome` / `IdentityFlow`)
// never shares a filename.
//
// Three things are asserted here, and the third is the one that would rot
// silently:
//
//   1. THE WITHHOLDING. While `identity_unlocked` is false the create action is
//      ABSENT (not disabled) and the door is present. Both directions, because
//      "the button is missing" is also satisfied by a screen that rendered
//      nothing.
//   2. THE ACT. The door opens the phrase step and submitting calls
//      `sync_person_unlock` with the phrase the user typed, then returns home.
//   3. THE PROVENANCE. The gate reads `identity_unlocked` from the STATUS probe,
//      not from the flow's own guess, so the test drives the two answers through
//      `personStatus` and changes nothing else.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const personStatus = vi.hoisted(() => vi.fn());
const personUnlock = vi.hoisted(() => vi.fn());
const personListInvites = vi.hoisted(() => vi.fn());
const personAccountNumber = vi.hoisted(() => vi.fn());
const personSetup = vi.hoisted(() => vi.fn());
const personLock = vi.hoisted(() => vi.fn());
const personRegister = vi.hoisted(() => vi.fn());
const personAcceptInvite = vi.hoisted(() => vi.fn());
const personJoinVault = vi.hoisted(() => vi.fn());
const personJoinDevice = vi.hoisted(() => vi.fn());
const personClaimDevice = vi.hoisted(() => vi.fn());
const personListVaults = vi.hoisted(() => vi.fn());
const syncSetEndpoint = vi.hoisted(() => vi.fn());
const listRoster = vi.hoisted(() => vi.fn());
const setMyMemberName = vi.hoisted(() => vi.fn());

vi.mock("../../src/lib/app-window", () => ({ HAS_TAURI: true }));
vi.mock("../../src/lib/personAccount", () => ({
  personStatus,
  personUnlock,
  personListInvites,
  personAccountNumber,
  personSetup,
  personLock,
  personRegister,
  personAcceptInvite,
  personJoinVault,
  personJoinDevice,
  personClaimDevice,
  personListVaults,
}));
vi.mock("../../src/lib/sync", () => ({ syncSetEndpoint, listRoster }));
vi.mock("../../src/lib/memberNames", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/memberNames")>()),
  setMyMemberName,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

import { IdentityFlow } from "../../src/app/flows/IdentityFlow";

/** BIP-39, in order, so the phrase is valid-shaped and 24 words wide. */
const PHRASE = [
  "abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract",
  "absurd", "abuse", "access", "accident", "account", "accuse", "achieve", "acid",
  "acoustic", "acquire", "across", "act", "action", "actor", "actress", "actual",
];

function status(identityUnlocked: boolean) {
  return {
    enrolled: true,
    identity_unlocked: identityUnlocked,
    person_id_hex: "person",
    identity_code: "MYNE-PERSON-1:aa:bb:cc:dd",
    sealed_keypair_present: true,
    state: "enrolled",
  };
}

beforeEach(() => {
  personStatus.mockReset().mockResolvedValue(status(false));
  personUnlock.mockReset().mockResolvedValue({
    fingerprint_hex: "fingerprint",
    person_id_hex: "person",
    identity_code: "MYNE-PERSON-1:aa:bb:cc:dd",
  });
  personListInvites.mockReset().mockResolvedValue([]);
  personAccountNumber.mockReset().mockResolvedValue("MY-ABCD-EFGH-JKMN-PQRS-TUVW");
  personSetup.mockReset();
  personLock.mockReset().mockResolvedValue(undefined);
  personRegister.mockReset();
  personAcceptInvite.mockReset();
  personJoinVault.mockReset();
  personJoinDevice.mockReset();
  personClaimDevice.mockReset();
  personListVaults.mockReset();
  syncSetEndpoint.mockReset().mockResolvedValue(undefined);
  listRoster.mockReset().mockResolvedValue({ members: [], authority: "owner", group_key_epoch: 1 });
  setMyMemberName.mockReset().mockResolvedValue({});
});

afterEach(() => cleanup());

function renderFlow(onCreateVault: () => void = () => {}): void {
  render(
    <IdentityFlow
      onCancel={() => {}}
      onAccepted={() => {}}
      onCreateVault={onCreateVault}
    />,
  );
}

/** The home step's own heading, so "on the home" is the step and not a guess. */
async function reachHome(): Promise<void> {
  await screen.findByTestId("identity-flow.home-vault-hint");
}

function phraseCells(prefix: string): HTMLInputElement[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>(`input[data-testid^="${prefix}"]`),
  );
}

describe("IdentityFlow: the identity unlock door", () => {
  it("withholds the create action while the identity is sealed, and offers the door", async () => {
    const onCreateVault = vi.fn();
    renderFlow(onCreateVault);
    await reachHome();

    // Both directions: the withheld action AND the replacement, so a home that
    // rendered neither could not pass.
    expect(screen.queryByTestId("identity-flow.home-create-vault")).toBeNull();
    const locked = screen.getByTestId("identity-flow.home-create-vault-locked");
    expect(locked.textContent).toContain("identityHome.createVaultLocked");
    expect(screen.getByTestId("identity-flow.home-unlock-open")).toBeTruthy();
    // The old failure: the create action was pressed, the command refused, and the
    // user had nothing to press next. No press happens here at all.
    expect(onCreateVault).not.toHaveBeenCalled();
  });

  it("offers the create action once the identity is open, and no door", async () => {
    personStatus.mockResolvedValue(status(true));
    renderFlow();
    await reachHome();

    expect(screen.getByTestId("identity-flow.home-create-vault")).toBeTruthy();
    expect(screen.queryByTestId("identity-flow.home-create-vault-locked")).toBeNull();
    expect(screen.queryByTestId("identity-flow.home-unlock-open")).toBeNull();
  });

  it("unlocks from the door and comes back to the home with the action offered", async () => {
    // The real contract after a successful unlock: the next status probe answers
    // `identity_unlocked: true`, because the command installed the session in RAM.
    // The flow ALSO flips the flag locally on success, which covers the round trip
    // before the probe returns; this mock sequence is the truthful backend, so the
    // assertion below is about the outcome the user sees rather than about which
    // of the two set it.
    // A truthful backend: the probe answers the RAM truth, which the unlock
    // changes. The flow probes twice on the way in (mount, then entering the home),
    // so this is a live value rather than a one-shot.
    let unlocked = false;
    personStatus.mockReset();
    personStatus.mockImplementation(async () => status(unlocked));
    personUnlock.mockImplementation(async () => {
      unlocked = true;
      return {
        fingerprint_hex: "fingerprint",
        person_id_hex: "person",
        identity_code: "MYNE-PERSON-1:aa:bb:cc:dd",
      };
    });
    renderFlow();
    await reachHome();
    fireEvent.click(screen.getByTestId("identity-flow.home-unlock-open"));

    const cells = phraseCells("identity-flow.unlock-cell");
    expect(cells).toHaveLength(24);
    PHRASE.forEach((word, i) => {
      fireEvent.change(cells[i], { target: { value: word } });
    });
    fireEvent.click(screen.getByTestId("identity-flow.unlock-submit"));

    await waitFor(() => expect(personUnlock).toHaveBeenCalledTimes(1));
    expect(personUnlock.mock.calls[0][0]).toBe(PHRASE.join(" "));
    await reachHome();
    expect(screen.getByTestId("identity-flow.home-create-vault")).toBeTruthy();
    expect(screen.queryByTestId("identity-flow.home-unlock-open")).toBeNull();
  });

  it("reports a refused phrase on the step and wipes the cells", async () => {
    personUnlock.mockRejectedValueOnce({ kind: "BadRequest" });
    renderFlow();
    await reachHome();
    fireEvent.click(screen.getByTestId("identity-flow.home-unlock-open"));

    const cells = phraseCells("identity-flow.unlock-cell");
    PHRASE.forEach((word, i) => {
      fireEvent.change(cells[i], { target: { value: word } });
    });
    fireEvent.click(screen.getByTestId("identity-flow.unlock-submit"));

    await waitFor(() =>
      expect(screen.getByText("identityFlow.unlock.failed")).toBeTruthy(),
    );
    // The rejected words do not stay in the inputs: nothing mounted keeps a
    // credential that was just refused.
    expect(
      phraseCells("identity-flow.unlock-cell").every((cell) => cell.value === ""),
    ).toBe(true);
  });
});
