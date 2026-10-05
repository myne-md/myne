// @vitest-environment jsdom
//
// The Vault members panel's invitation gate (myne-md/myne#783).
//
// The defect this guards: on a freshly created `NTV5` vault the panel fetched
// the sent-invitation list, the fetch could not succeed, and the user saw
// "Could not load your invitations" on a vault where they had invited nobody.
// A vault that is not shared yet is a STATE, not a failure.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { resetPersonIdentityState } from "../../src/components/sync/personIdentityState";

const invokeMock = vi.hoisted(() => vi.fn());
let personReady = false;
/** The roster's group-key epoch: `null` = NTV5 (unshared), a number = NTV6. */
let groupKeyEpoch: number | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../src/hooks/usePrefs", () => ({
  usePrefs: () => ({ prefs: { label: "Test vault" } }),
}));

vi.mock("../../src/hooks/useFocusTrap", () => ({
  useFocusTrap: () => {},
}));

import { MemberRosterPanel } from "../../src/components/sync/MemberRosterPanel";
import { PHRASE_CELL_COUNT } from "../../src/components/sync/EnrollPhraseCredential";

const inviteCalls = () =>
  invokeMock.mock.calls.filter(([command]) => command === "plugin:sync|sync_list_vault_invites").length;
const migrationCalls = () =>
  invokeMock.mock.calls.filter(([command]) => command === "plugin:sync|sync_start_b2b_migration").length;

/** The 24-word grid sits behind the card's Unlock button, closed by default so
 *  the panel does not open on twenty-four empty fields. */
function openUnlock(): void {
  const open = screen.queryByTestId("member-roster.person-unlock-open");
  if (open) fireEvent.click(open);
}

function fillPhrase(): void {
  openUnlock();
  for (let index = 0; index < PHRASE_CELL_COUNT; index += 1) {
    fireEvent.change(
      screen.getByTestId(
        index === 0 ? "member-roster.phrase-input" : `member-roster.phrase-cell-${index + 1}`,
      ),
      { target: { value: index === 0 ? "abandon" : "about" } },
    );
  }
}

async function unlockPerson(): Promise<void> {
  await screen.findByTestId("member-roster.person-unlock");
  // The phrase grid is collapsed by default; reveal it, then fill it.
  fireEvent.click(screen.getByTestId("member-roster.person-unlock-open"));
  fillPhrase();
  await act(async () => {
    fireEvent.click(screen.getByTestId("member-roster.person-unlock-button"));
  });
  await screen.findByTestId("member-roster.person-ready");
}

beforeEach(() => {
  personReady = false;
  groupKeyEpoch = null;
  resetPersonIdentityState();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "plugin:sync|sync_list_roster") {
      return { members: [], authority: "owner", group_key_epoch: groupKeyEpoch };
    }
    if (command === "plugin:sync|sync_person_unlock") {
      personReady = true;
      return {
        fingerprint_hex: "00".repeat(32),
        person_id_hex: "11".repeat(16),
        identity_code: "MYNE-PERSON-1:owner",
      };
    }
    if (command === "plugin:sync|sync_person_lock") return undefined;
    if (command === "plugin:sync|sync_start_b2b_migration") return { group_key_epoch: 1, singletons_migrated: 0 };
    if (command === "plugin:sync|sync_list_vault_invites") {
      if (!personReady) throw { kind: "NotEnrolled" };
      throw { kind: "Transport" };
    }
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  resetPersonIdentityState();
});

describe("MemberRosterPanel invitation loading gate", () => {
  it("does not fetch or report a failure on an unshared vault", async () => {
    render(<MemberRosterPanel />);
    await unlockPerson();

    // An `NTV5` vault has no roster to list: no fetch, no error line (the
    // whole point of myne-md/myne#783).
    await act(async () => {});
    expect(inviteCalls()).toBe(0);
    expect(screen.queryByTestId("member-roster.invitations-error")).toBeNull();
    // It says so plainly instead.
    expect(screen.getByTestId("member-roster.unshared")).toBeTruthy();
  });

  it("fetches and reports a real failure on a shared vault", async () => {
    groupKeyEpoch = 1;
    render(<MemberRosterPanel />);
    await unlockPerson();

    await waitFor(() => expect(inviteCalls()).toBe(1));
    expect(screen.getByTestId("member-roster.invitations-error")).toBeTruthy();
    // A shared vault is not "unshared"; the two states do not overlap.
    expect(screen.queryByTestId("member-roster.unshared")).toBeNull();
  });

  it("confirms the permanent migration before opening the invite form on an unshared vault", async () => {
    render(<MemberRosterPanel />);
    await unlockPerson();

    fireEvent.click(screen.getByTestId("member-roster.invite-button"));
    // The invite form does NOT open first: the confirmation does.
    expect(screen.getByTestId("member-roster.share-confirm")).toBeTruthy();
    expect(screen.queryByTestId("member-roster.invite-code")).toBeNull();
    expect(migrationCalls()).toBe(0);

    await act(async () => {
      fireEvent.click(screen.getByTestId("member-roster.share-confirm-cta"));
    });
    await waitFor(() => expect(migrationCalls()).toBe(1));
  });

  it("keeps the unlocked person identity available after the panel remounts", async () => {
    const first = render(<MemberRosterPanel />);
    await unlockPerson();

    first.unmount();
    render(<MemberRosterPanel />);

    await screen.findByTestId("member-roster.person-ready");
    expect(screen.queryByTestId("member-roster.phrase-input")).toBeNull();
    expect((screen.getByTestId("member-roster.owner-code") as HTMLInputElement).value).toBe(
      "MYNE-PERSON-1:owner",
    );
  });
});
