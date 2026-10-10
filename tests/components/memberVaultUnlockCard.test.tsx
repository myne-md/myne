// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  unlock: vi.fn(),
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
  personUnlockMemberVault: mocks.unlock,
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
  mocks.unlock.mockReset();
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

async function fillPhrase(): Promise<void> {
  for (let i = 0; i < 24; i += 1) {
    fireEvent.change(
      await screen.findByTestId(
        i === 0 ? "unlock.member-phrase" : `unlock.member-phrase-cell-${i + 1}`,
      ),
      { target: { value: `word${i + 1}` } },
    );
  }
}

function expectedPhrase(): string {
  return Array.from({ length: 24 }, (_, i) => `word${i + 1}`).join(" ");
}

describe("MemberVaultUnlockCard", () => {
  it("hydrates identity state from the successful unlock and status probe", async () => {
    mocks.unlock.mockResolvedValue(undefined);
    mocks.status.mockResolvedValue({
      enrolled: true,
      identity_unlocked: true,
      identity_code: "runtime-code",
    });
    const onUnlocked = vi.fn();
    render(
      <MemberVaultUnlockCard vaultId="vault-1" onUnlocked={onUnlocked} />,
    );

    await fillPhrase();
    const input = screen.getByTestId("unlock.member-phrase");

    fireEvent.click(screen.getByTestId("unlock.member-submit"));

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledOnce());
    expect(mocks.unlock).toHaveBeenCalledWith("vault-1", expectedPhrase());

    expect(mocks.status).toHaveBeenCalledOnce();
    expect(mocks.setState).toHaveBeenCalledWith({ ready: true, ownerCode: "runtime-code" });
    expect((input as HTMLInputElement).value).toBe("");

  });

  it("does not claim readiness when the status probe fails", async () => {
    mocks.unlock.mockResolvedValue(undefined);
    mocks.status.mockRejectedValue(new Error("status unavailable"));
    const onUnlocked = vi.fn();
    render(
      <MemberVaultUnlockCard vaultId="vault-1" onUnlocked={onUnlocked} />,
    );

    await fillPhrase();

    fireEvent.click(screen.getByTestId("unlock.member-submit"));

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledOnce());
    expect(mocks.setState).toHaveBeenCalledWith({ ready: false, ownerCode: null });
  });

  it("shows an unlock failure without reporting success", async () => {
    mocks.unlock.mockRejectedValue(new Error("bad phrase"));
    const onUnlocked = vi.fn();
    render(
      <MemberVaultUnlockCard vaultId="vault-1" onUnlocked={onUnlocked} />,
    );

    await fillPhrase();

    fireEvent.click(screen.getByTestId("unlock.member-submit"));

    await waitFor(() => expect(screen.getByTestId("unlock.member-error")).toBeTruthy());
    expect(onUnlocked).not.toHaveBeenCalled();
    expect(mocks.setState).not.toHaveBeenCalled();
  });

  it("opens on the password field when a device password is configured", async () => {
    mocks.unlockStatus.mockResolvedValue("password");
    mocks.unlockWithPassword.mockResolvedValue(undefined);
    mocks.status.mockResolvedValue({
      enrolled: true,
      identity_unlocked: true,
      identity_code: null,
    });
    const onUnlocked = vi.fn();
    render(<MemberVaultUnlockCard vaultId="vault-1" onUnlocked={onUnlocked} />);

    const input = await screen.findByTestId("unlock.member-password");
    fireEvent.change(input, { target: { value: "correct horse battery" } });
    fireEvent.click(screen.getByTestId("unlock.member-submit"));

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledOnce());
    expect(mocks.unlockWithPassword).toHaveBeenCalledWith("vault-1", "correct horse battery");
    expect(mocks.unlock).not.toHaveBeenCalled();
  });

  it("can fall back to the recovery phrase from a password-configured vault", async () => {
    mocks.unlockStatus.mockResolvedValue("password");
    mocks.unlock.mockResolvedValue(undefined);
    mocks.status.mockResolvedValue({
      enrolled: true,
      identity_unlocked: true,
      identity_code: null,
    });
    const onUnlocked = vi.fn();
    render(<MemberVaultUnlockCard vaultId="vault-1" onUnlocked={onUnlocked} />);

    await screen.findByTestId("unlock.member-password");
    fireEvent.click(screen.getByTestId("unlock.member-toggle-credential"));
    await fillPhrase();
    fireEvent.click(screen.getByTestId("unlock.member-submit"));

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledOnce());
    expect(mocks.unlock).toHaveBeenCalledWith("vault-1", expectedPhrase());
  });
});
