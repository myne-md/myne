// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  unlockWithPassword: vi.fn(),
  unlockWithPin: vi.fn(),
  unlockWithBiometric: vi.fn(),
  unlockStatus: vi.fn(),
  status: vi.fn(),
  setState: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../src/lib/personAccount", () => ({
  personUnlockMemberVaultWithPassword: mocks.unlockWithPassword,
  personUnlockMemberVaultWithPin: mocks.unlockWithPin,
  personUnlockMemberVaultWithBiometric: mocks.unlockWithBiometric,
  memberUnlockStatus: mocks.unlockStatus,
  personStatus: mocks.status,
}));

vi.mock("../../src/components/sync/personIdentityState", () => ({
  setPersonIdentityState: mocks.setState,
}));

import { MemberVaultUnlockCard } from "../../src/components/sync/MemberVaultUnlockCard";

beforeEach(() => {
  mocks.unlockWithPassword.mockReset();
  mocks.unlockWithPin.mockReset();
  mocks.unlockWithBiometric.mockReset();
  mocks.unlockStatus.mockReset();
  mocks.unlockStatus.mockResolvedValue(null);
  mocks.status.mockReset();
  mocks.setState.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("MemberVaultUnlockCard", () => {
  // The phrase arm is GONE (myne-md/myne#938 task 12, `0763`): `vault.member-key`
  // is retired, so a member has exactly one way in and the surface must not offer
  // a second. This is the assertion that keeps it gone: a card that grew a phrase
  // grid back would pass every other test in this file.
  it("offers no recovery-phrase arm at all", async () => {
    mocks.unlockStatus.mockResolvedValue("password");
    render(<MemberVaultUnlockCard vaultId="vault-1" onUnlocked={vi.fn()} />);

    await screen.findByTestId("unlock.member-password");
    expect(screen.queryByTestId("unlock.member-phrase-grid")).toBeNull();
    expect(screen.queryByTestId("unlock.member-toggle-credential")).toBeNull();
  });

  it("says a fresh invite is needed when this device holds no credential", async () => {
    // `memberUnlockStatus` answers `null`: no `vault.member-unlock` on this device.
    render(<MemberVaultUnlockCard vaultId="vault-1" onUnlocked={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByTestId("unlock.member-no-credential")).toBeTruthy(),
    );
    expect(screen.queryByTestId("unlock.member-submit")).toBeNull();
    expect(screen.queryByTestId("unlock.member-password")).toBeNull();
    // And no HINT either. The hint used to be a ternary chain ending on the
    // biometric one, so this surface told the user to approve with a fingerprint
    // directly above the paragraph saying to ask the owner for an invite
    // (myne-md/myne#938 review). A surface with no control has nothing to hint at.
    expect(screen.queryByTestId("unlock.member-hint")).toBeNull();
  });

  it("hints the credential the device actually holds", async () => {
    // The other half of the same claim, so the assertion above cannot pass by the
    // hint being absent everywhere: a password device gets the password hint.
    mocks.unlockStatus.mockResolvedValue("password");
    render(<MemberVaultUnlockCard vaultId="vault-1" onUnlocked={vi.fn()} />);

    const hint = await screen.findByTestId("unlock.member-hint");
    expect(hint.textContent).toBe("unlock.memberPasswordHint");
  });

  it("hydrates identity state from the successful unlock and status probe", async () => {
    mocks.unlockStatus.mockResolvedValue("password");
    mocks.unlockWithPassword.mockResolvedValue(undefined);
    mocks.status.mockResolvedValue({
      enrolled: true,
      identity_unlocked: true,
      identity_code: "runtime-code",
    });
    const onUnlocked = vi.fn();
    render(<MemberVaultUnlockCard vaultId="vault-1" onUnlocked={onUnlocked} />);

    const input = await screen.findByTestId("unlock.member-password");
    fireEvent.change(input, { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByTestId("unlock.member-submit"));

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledOnce());
    expect(mocks.unlockWithPassword).toHaveBeenCalledWith("vault-1", "correct horse battery");

    expect(mocks.status).toHaveBeenCalledOnce();
    expect(mocks.setState).toHaveBeenCalledWith({ ready: true, ownerCode: "runtime-code" });
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("does not claim readiness when the status probe fails", async () => {
    mocks.unlockStatus.mockResolvedValue("password");
    mocks.unlockWithPassword.mockResolvedValue(undefined);
    mocks.status.mockRejectedValue(new Error("status unavailable"));
    const onUnlocked = vi.fn();
    render(<MemberVaultUnlockCard vaultId="vault-1" onUnlocked={onUnlocked} />);

    const input = await screen.findByTestId("unlock.member-password");
    fireEvent.change(input, { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByTestId("unlock.member-submit"));

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledOnce());
    expect(mocks.setState).toHaveBeenCalledWith({ ready: false, ownerCode: null });
  });

  it("shows an unlock failure without reporting success", async () => {
    mocks.unlockStatus.mockResolvedValue("password");
    mocks.unlockWithPassword.mockRejectedValue(new Error("bad password"));
    const onUnlocked = vi.fn();
    render(<MemberVaultUnlockCard vaultId="vault-1" onUnlocked={onUnlocked} />);

    const input = await screen.findByTestId("unlock.member-password");
    fireEvent.change(input, { target: { value: "wrong password" } });
    fireEvent.click(screen.getByTestId("unlock.member-submit"));

    await waitFor(() => expect(screen.getByTestId("unlock.member-error")).toBeTruthy());
    expect(onUnlocked).not.toHaveBeenCalled();
    expect(mocks.setState).not.toHaveBeenCalled();
  });

  it("opens on the PIN field when a device PIN is configured", async () => {
    mocks.unlockStatus.mockResolvedValue("pin");
    mocks.unlockWithPin.mockResolvedValue(undefined);
    mocks.status.mockResolvedValue({ enrolled: true, identity_unlocked: true, identity_code: null });
    const onUnlocked = vi.fn();
    render(<MemberVaultUnlockCard vaultId="vault-1" onUnlocked={onUnlocked} />);

    const input = await screen.findByTestId("unlock.member-pin");
    fireEvent.change(input, { target: { value: "123456" } });
    fireEvent.click(screen.getByTestId("unlock.member-submit"));

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledOnce());
    expect(mocks.unlockWithPin).toHaveBeenCalledWith("vault-1", "123456");
    expect(mocks.unlockWithPassword).not.toHaveBeenCalled();
  });
});
