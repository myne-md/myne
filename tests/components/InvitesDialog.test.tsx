// @vitest-environment jsdom
//
// The invitations dialog, which is the surface that lets a device holding a
// vault accept an invitation at all (myne-md/myne#911 follow-up).
//
// What this pins, stated as the failure: the dialog is the only door for a
// person whose identity is `reserved` or `pending`, and those two states have NO
// invitations to list because the relay addresses them to a registered person.
// Rendering the ordinary "no invitations yet" line there would read as "nobody
// invited you", which is a different and false statement, so each state gets its
// own body and the test asserts which one.
//
// The wizards are stubbed: `AcceptInviteWizard` reaches the accept command, and
// this file is about which surface the dialog chooses, not about the command.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

vi.mock("../../src/components/sync/InviteWizard", () => ({
  AcceptInviteWizard: ({ invite }: { invite: { invite_id_hex: string } }) => (
    <div data-testid="stub.accept-wizard">{invite.invite_id_hex}</div>
  ),
  JoinVaultWizard: ({ invite }: { invite: { invite_id_hex: string } }) => (
    <div data-testid="stub.join-wizard">{invite.invite_id_hex}</div>
  ),
}));

vi.mock("../../src/lib/personAccount", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/personAccount")>();
  return { ...actual, personDeclineInvite: vi.fn() };
});
vi.mock("../../src/components/sync/PersonRegisterDialog", () => ({
  PersonRegisterDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="stub.register-dialog" /> : null,
}));

import { InvitesDialog } from "../../src/components/sync/InvitesDialog";
import {
  personDeclineInvite,
  type InviteSummary,
} from "../../src/lib/personAccount";

afterEach(() => cleanup());

const PENDING_INVITE: InviteSummary = {
  invite_id_hex: "aa11",
  vault_account_hash_hex: "bb".repeat(32),
  claimed: false,
};
const CLAIMED_INVITE: InviteSummary = {
  invite_id_hex: "cc22",
  vault_account_hash_hex: "dd".repeat(32),
  claimed: true,
};

function renderDialog(overrides: Partial<Parameters<typeof InvitesDialog>[0]> = {}) {
  const props = {
    open: true,
    invites: [] as InviteSummary[],
    loading: false,
    unavailable: null,
    onClose: vi.fn(),
    onRetry: vi.fn(),
    onAccepted: vi.fn(),
    ...overrides,
  };
  render(<InvitesDialog {...props} />);
  return props;
}

describe("InvitesDialog", () => {
  it("renders inside the modal shell", () => {
    renderDialog();
    expect(screen.getByTestId("invites.dialog")).toBeTruthy();
  });

  it("says an identity must be registered rather than claiming there are no invites", () => {
    renderDialog({ unavailable: "not-enrolled" });
    expect(screen.getByTestId("invites.not-enrolled")).toBeTruthy();
    // The remedy, where the question is asked (decisions/ui/0725).
    expect(screen.getByTestId("invites.register-cta")).toBeTruthy();
    // The false statement this guards: "No invitations yet." for a person the
    // server has never seen.
    expect(screen.queryByTestId("invites.empty")).toBeNull();
  });

  it("names the missing identity when the device holds none", () => {
    renderDialog({ unavailable: "no-identity" });
    expect(screen.getByTestId("invites.no-identity")).toBeTruthy();
    expect(screen.queryByTestId("invites.empty")).toBeNull();
  });

  it("offers a retry when the read failed, and calls it", () => {
    const props = renderDialog({ unavailable: "error" });
    expect(screen.getByTestId("invites.error")).toBeTruthy();
    fireEvent.click(screen.getByTestId("invites.retry"));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  it("has an honest empty state when the list is real and empty", () => {
    renderDialog();
    expect(screen.getByTestId("invites.empty")).toBeTruthy();
  });

  it("splits unaccepted invitations from claimed ones and opens the right wizard", () => {
    renderDialog({ invites: [PENDING_INVITE, CLAIMED_INVITE] });
    expect(screen.getAllByTestId("invites.row")).toHaveLength(1);
    expect(screen.getAllByTestId("invites.claimed-row")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("invites.accept"));
    expect(screen.getByTestId("stub.accept-wizard").textContent).toBe("aa11");
    // The list is replaced by the wizard, not stacked under it: the wizard owns
    // the phrase and the owner code, and a second row would invite the two to be
    // confused.
    expect(screen.queryByTestId("invites.row")).toBeNull();
  });

  it("declines only after the confirmation, and only then calls the command", async () => {
    // Declining cannot be undone: the server drops the sealed payload, so the
    // owner has to invite again. The press that matters is the second one, and the
    // assertion that no request leaves the app before it is the point of the test.
    const props = renderDialog({ invites: [PENDING_INVITE] });
    fireEvent.click(screen.getByTestId("invites.decline"));
    expect(personDeclineInvite).not.toHaveBeenCalled();
    expect(screen.getByTestId("invites.decline-confirm")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId("invites.decline-confirm-cta"));
    });
    expect(personDeclineInvite).toHaveBeenCalledWith("aa11");
    // The list is re-read rather than locally spliced: the row that was just
    // refused is gone on the server, and the count in the vault switcher is
    // derived from the same list.
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  it("keeps the invitation and reports the failure when the decline is refused", async () => {
    vi.mocked(personDeclineInvite).mockRejectedValueOnce({ kind: "Transport" });
    const props = renderDialog({ invites: [PENDING_INVITE] });
    fireEvent.click(screen.getByTestId("invites.decline"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("invites.decline-confirm-cta"));
    });
    expect(screen.getByTestId("invites.decline-error")).toBeTruthy();
    expect(props.onRetry).not.toHaveBeenCalled();
  });

  it("opens the join wizard for a claimed invite", () => {
    renderDialog({ invites: [CLAIMED_INVITE] });
    fireEvent.click(screen.getByTestId("invites.join"));
    expect(screen.getByTestId("stub.join-wizard").textContent).toBe("cc22");
  });
});
