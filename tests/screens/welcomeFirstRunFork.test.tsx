// @vitest-environment jsdom

// The zero-vault first-run fork (myne-md/myne#768).
//
// The failure this guards: the first run put "Create new vault" first, so a user
// ended up with a vault and no identity, could not be invited to anyone's vault,
// and had no way to discover the model Myne is built around. The fork makes the
// identity the primary door and keeps the local-vault door adjacent, so neither
// path is reachable only by knowing to ask for it.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en", resolvedLanguage: "en" },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock("../../src/lib/personAccount", () => ({
  personSetup: vi.fn().mockResolvedValue({
    phrase: null,
    fingerprint_hex: "f",
    person_id_hex: "p",
    identity_code: "c",
    approved: true,
  }),
  personStatus: vi.fn().mockResolvedValue({
    enrolled: false,
    identity_unlocked: false,
    person_id_hex: null,
    identity_code: null,
    sealed_keypair_present: false,
  }),
}));

vi.mock("../../src/platform/core", () => ({
  invoke: vi.fn().mockResolvedValue({ endpoint_url: "https://sync.example" }),
}));

const setLanguage = vi.fn().mockResolvedValue(true);
vi.mock("../../src/i18n", () => ({ setLanguage: (c: string) => setLanguage(c) }));

import { Welcome } from "../../src/screens/Welcome";

afterEach(() => cleanup());

describe("Welcome first-run fork", () => {
  it("offers both the identity and the local-vault door", () => {
    render(
      <Welcome
        onCreateVault={() => {}}
        onRestoreBackup={() => {}}
        onJoinDevice={() => {}}
      />,
    );
    expect(screen.getByTestId("welcome.identity-cta")).toBeTruthy();
    expect(screen.getByTestId("welcome.create-cta")).toBeTruthy();
  });

  it("opens the identity flow from the identity door, not vault creation", () => {
    const onCreateVault = vi.fn();
    render(
      <Welcome
        onCreateVault={onCreateVault}
        onRestoreBackup={() => {}}
        onJoinDevice={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("welcome.identity-cta"));
    // The identity dialog opens; vault creation was not reached.
    expect(screen.getByTestId("identity-setup.root")).toBeTruthy();
    expect(onCreateVault).not.toHaveBeenCalled();
  });

  it("still reaches local vault creation as an identity-less door", () => {
    const onCreateVault = vi.fn();
    render(
      <Welcome
        onCreateVault={onCreateVault}
        onRestoreBackup={() => {}}
        onJoinDevice={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("welcome.create-cta"));
    expect(onCreateVault).toHaveBeenCalledTimes(1);
  });

  it("lets a first-run user change the language before any vault exists", () => {
    // Language is device-local (src/i18n/config.ts), so the first screen is the
    // one place a person who does not read English can reach it without help.
    render(
      <Welcome onCreateVault={() => {}} onRestoreBackup={() => {}} onJoinDevice={() => {}} />,
    );
    expect(screen.getByTestId("welcome.language-select")).toBeTruthy();
  });
});
