// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { resetPersonIdentityState } from "../../src/components/sync/personIdentityState";

const invokeMock = vi.hoisted(() => vi.fn());
let personReady = false;

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

function fillPhrase(): void {
  for (let index = 0; index < PHRASE_CELL_COUNT; index += 1) {
    fireEvent.change(
      screen.getByTestId(
        index === 0 ? "member-roster.phrase-input" : `member-roster.phrase-cell-${index + 1}`,
      ),
      { target: { value: index === 0 ? "abandon" : "about" } },
    );
  }
}

beforeEach(() => {
  personReady = false;
  resetPersonIdentityState();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "plugin:sync|sync_list_roster") {
      return { members: [], authority: "owner", group_key_epoch: null };
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
  it("waits for person unlock before fetching invitations and reports a later failure", async () => {
    render(<MemberRosterPanel />);

    await screen.findByTestId("member-roster.person-unlock");
    await act(async () => {});
    expect(inviteCalls()).toBe(0);
    expect(screen.queryByTestId("member-roster.invitations-error")).toBeNull();

     fillPhrase();

    await act(async () => {
      fireEvent.click(screen.getByTestId("member-roster.person-unlock-button"));
    });
    await screen.findByTestId("member-roster.person-ready");

    await waitFor(() => expect(inviteCalls()).toBe(1));
    expect(screen.getByTestId("member-roster.invitations-error")).toBeTruthy();
  });

  it("keeps the unlocked person identity available after the panel remounts", async () => {
    const first = render(<MemberRosterPanel />);
    await screen.findByTestId("member-roster.person-unlock");
     fillPhrase();

    await act(async () => {
      fireEvent.click(screen.getByTestId("member-roster.person-unlock-button"));
    });
    await screen.findByTestId("member-roster.person-ready");

    first.unmount();
    render(<MemberRosterPanel />);

    await screen.findByTestId("member-roster.person-ready");
    expect(screen.queryByTestId("member-roster.phrase-input")).toBeNull();
    expect((screen.getByTestId("member-roster.owner-code") as HTMLInputElement).value).toBe(
      "MYNE-PERSON-1:owner",
    );
  });
});
