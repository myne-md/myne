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
import {
  resetPersonIdentityState,
  setPersonIdentityState,
} from "../../src/components/sync/personIdentityState";

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

const inviteCalls = () =>
  invokeMock.mock.calls.filter(([command]) => command === "plugin:sync|sync_list_vault_invites").length;
const migrationCalls = () =>
  invokeMock.mock.calls.filter(([command]) => command === "plugin:sync|sync_start_b2b_migration").length;

/** The panel reads the shared identity store; the Sync panel's Identity block
 *  is what actually unlocks it (myne-md/myne#831), so the fixture seeds the
 *  store rather than driving a phrase grid this panel no longer owns. */
async function unlockPerson(): Promise<void> {
  personReady = true;
  await act(async () => {
    setPersonIdentityState({ ready: true, ownerCode: "MYNE-PERSON-1:owner" });
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

  it("names the missing publish when the server refuses for want of a record", async () => {
    // A vault born under an identity invites with the person session, and a vault
    // that was never published has no selector to address, so the backend answers
    // `NotEnrolled` before any round trip. "The invite could not be created" reads
    // as a broken product when the act that is missing is publishing.
    groupKeyEpoch = 1;
    const prev = invokeMock.getMockImplementation();
    invokeMock.mockImplementation(async (command: string, args?: unknown) => {
      if (command === "plugin:sync|sync_person_create_invite") throw { kind: "NotEnrolled" };
      return prev?.(command, args);
    });
    render(<MemberRosterPanel />);
    await unlockPerson();

    fireEvent.click(screen.getByTestId("member-roster.invite-button"));
    fireEvent.change(screen.getByTestId("member-roster.invite-code"), {
      target: { value: "MYNE-PERSON-1:" + "ab".repeat(16) + ":" + "00".repeat(1088) + ":" + "00".repeat(32) + ":" + "00".repeat(1952) },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("member-roster.invite-confirm"));
    });

    await waitFor(() =>
      expect(screen.getByTestId("member-roster.action-error").textContent).toBe(
        "sync.memberRoster.inviteNotOnServer",
      ),
    );
  });

  it("keeps the unlocked person identity available after the panel remounts", async () => {
    const first = render(<MemberRosterPanel />);
    await unlockPerson();

    first.unmount();
    render(<MemberRosterPanel />);

    await screen.findByTestId("member-roster.person-ready");
    expect((screen.getByTestId("member-roster.owner-code") as HTMLInputElement).value).toBe(
      "MYNE-PERSON-1:owner",
    );
  });
});

// 2026-10-25, second report. A vault born under an identity used to be
// owner-only (`protocol.md` §9.29; `decisions/ui/0729` item 4 withheld the invite
// and explained why). The member plane reads that generation's tail now, so the
// panel offers the same controls on every vault: no generation branch, no sentence
// about a limit that no longer exists. What still decides is the person identity
// (a locked one cannot invite) and the vault's own shared state.
describe("MemberRosterPanel on a vault born under an identity", () => {
  it("offers the invite, and states no generation limit", async () => {
    groupKeyEpoch = 1;
    render(<MemberRosterPanel />);
    await unlockPerson();
    await act(async () => {});

    expect(screen.getByTestId("member-roster.invite-button")).toBeTruthy();
    expect(screen.queryByTestId("member-roster.generation-notice")).toBeNull();
    // The zero state asks for an invite again, because the vault can take one.
    expect(screen.getByText("sync.memberRoster.empty")).toBeTruthy();
    expect(screen.queryByText("sync.memberRoster.emptyOwnedAlone")).toBeNull();
  });

  it("still offers the invite on a legacy vault, which could already be shared", async () => {
    groupKeyEpoch = null;
    render(<MemberRosterPanel />);
    await unlockPerson();

    expect(screen.getByTestId("member-roster.invite-button")).toBeTruthy();
    expect(screen.queryByTestId("member-roster.generation-notice")).toBeNull();
  });

  it("names the locked identity and mounts the door, instead of a dead button", async () => {
    groupKeyEpoch = 1;
    // NOT unlocked: this is the state the panel answered with silence. Its whole
    // identity section is gated on `personReady`, and the Identity row that owns
    // the unlock lives in the Connection topic, so from this panel the fix was
    // unreachable and the disabled control gave no reason.
    render(<MemberRosterPanel />);
    await act(async () => {});

    expect(screen.getByTestId("member-roster.identity-locked")).toBeTruthy();
    expect(screen.getByTestId("sync.panel.identity-unlock.open")).toBeTruthy();
    expect((screen.getByTestId("member-roster.invite-button") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
