// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  unlock: vi.fn(),
  status: vi.fn(),
  setState: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../src/lib/personAccount", () => ({
  personUnlockMemberVault: mocks.unlock,
  personStatus: mocks.status,
}));

vi.mock("../../src/components/sync/personIdentityState", () => ({
  setPersonIdentityState: mocks.setState,
}));

import { MemberVaultUnlockCard } from "../../src/components/sync/MemberVaultUnlockCard";

beforeEach(() => {
  mocks.unlock.mockReset();
  mocks.status.mockReset();
  mocks.setState.mockReset();
});

afterEach(() => {
  cleanup();
});

function fillPhrase(): void {
  for (let i = 0; i < 24; i += 1) {
    fireEvent.change(
      screen.getByTestId(i === 0 ? "unlock.member-phrase" : `unlock.member-phrase-cell-${i + 1}`),
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

    const input = screen.getByTestId("unlock.member-phrase");
    fillPhrase();

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

     fillPhrase();

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

     fillPhrase();

    fireEvent.click(screen.getByTestId("unlock.member-submit"));

    await waitFor(() => expect(screen.getByTestId("unlock.member-error")).toBeTruthy());
    expect(onUnlocked).not.toHaveBeenCalled();
    expect(mocks.setState).not.toHaveBeenCalled();
  });
});
