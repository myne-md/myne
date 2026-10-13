// @vitest-environment jsdom
//
// The Privacy-side reminder for a member with no fast credential
// (myne-md/myne#851 task 9, story 22). Shown only while NO method exists, dismissible,
// and it writes nothing: a member who joined before the password step shipped can
// still open their vault with the phrase, so this asks rather than blocks.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const activeVaultId = vi.hoisted(() => vi.fn());
const memberVaultStatus = vi.hoisted(() => vi.fn());
const memberUnlockStatus = vi.hoisted(() => vi.fn());
const setMemberPassword = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../src/i18n", () => ({ default: { t: (key: string) => key } }));

vi.mock("../../src/lib/vault-list", () => ({ activeVaultId }));

vi.mock("../../src/lib/personAccount", () => ({
  memberVaultStatus,
  memberUnlockStatus,
  setMemberPassword,
  setMemberPin: vi.fn(),
  setMemberBiometric: vi.fn(),
  clearMemberUnlock: vi.fn(),
}));

vi.mock("../../src/platform/capabilities", () => ({
  has: () => true,
  get: () => true,
}));

vi.mock("../../src/commands/chord", () => ({ isMacPlatform: () => false }));

const { MemberPasswordSettings } = await import(
  "../../src/components/settings/MemberPasswordSettings"
);

afterEach(() => {
  cleanup();
  activeVaultId.mockReset();
  memberVaultStatus.mockReset();
  memberUnlockStatus.mockReset();
  setMemberPassword.mockReset();
});

const reminder = () => screen.queryByTestId("settings.member-password-reminder");

describe("MemberPasswordSettings reminder", () => {
  it("reminds a member with no fast credential, and stops once one exists", async () => {
    activeVaultId.mockResolvedValue("vault-1");
    memberVaultStatus.mockResolvedValue(true);
    memberUnlockStatus.mockResolvedValue(null);
    const { unmount } = render(<MemberPasswordSettings />);
    expect(await screen.findByTestId("settings.member-password-reminder")).toBeTruthy();
    unmount();

    // Any method at all means the member is not stuck on the phrase.
    memberUnlockStatus.mockResolvedValue("password");
    render(<MemberPasswordSettings />);
    await waitFor(() =>
      expect(screen.getByTestId("settings.member-password-status").textContent).toContain(
        "settings.memberPassword.helperConfigured",
      ),
    );
    expect(reminder()).toBeNull();
  });

  it("does not flash the reminder before the status probe resolves", async () => {
    activeVaultId.mockResolvedValue("vault-1");
    memberVaultStatus.mockResolvedValue(true);
    // The probe is a promise that has not settled: `configured === null` is its value
    // before the answer arrives, and it must not read as "no method", or the reminder
    // appears on a vault that does have one.
    let settle: (method: "password" | null) => void = () => {};
    memberUnlockStatus.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    render(<MemberPasswordSettings />);
    await waitFor(() => expect(memberUnlockStatus).toHaveBeenCalled());
    expect(reminder()).toBeNull();

    settle("password");
    await waitFor(() =>
      expect(screen.getByTestId("settings.member-password-status").textContent).toContain(
        "settings.memberPassword.helperConfigured",
      ),
    );
    expect(reminder()).toBeNull();
  });

  it("dismisses without writing anything", async () => {
    activeVaultId.mockResolvedValue("vault-1");
    memberVaultStatus.mockResolvedValue(true);
    memberUnlockStatus.mockResolvedValue(null);
    render(<MemberPasswordSettings />);

    fireEvent.click(await screen.findByTestId("settings.member-password-reminder-dismiss"));
    expect(reminder()).toBeNull();
    expect(setMemberPassword).not.toHaveBeenCalled();
    // The row that SETS one is untouched: dismissing the ask is not losing the way.
    expect(screen.getByTestId("settings.member-password-set")).toBeTruthy();
  });

  it("says nothing at all on a vault that is not a member vault", async () => {
    activeVaultId.mockResolvedValue("vault-1");
    memberVaultStatus.mockResolvedValue(false);
    const { container } = render(<MemberPasswordSettings />);
    await waitFor(() => expect(memberVaultStatus).toHaveBeenCalled());
    expect(container.firstChild).toBeNull();
    expect(reminder()).toBeNull();
  });
});
