// @vitest-environment jsdom

// The identity home and its accept path (myne-md/myne#768, reusing the #711
// flow). The failure this guards: joining a vault that was shared with you needs
// your OWN recovery phrase, never a vault phrase a member never had
// (`decisions/protocol/0606`), and the accept path must be reachable from the
// identity-first landing.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const personListInvites = vi.hoisted(() => vi.fn());
const personLock = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock("../../src/lib/personAccount", () => ({
  personListInvites,
  personAcceptInvite: vi.fn(),
}));

vi.mock("../../src/lib/invite", () => ({
  inspectInviteCode: vi.fn(),
  personLock,
}));

vi.mock("../../src/lib/clipboard", () => ({ copyText: vi.fn() }));
vi.mock("../../src/platform/clipboardManager", () => ({ writeText: vi.fn() }));
vi.mock("../../src/components/toast/toastStore", () => ({ toast: vi.fn() }));

import { IdentityHome } from "../../src/screens/IdentityHome";

beforeEach(() => {
  personListInvites.mockReset().mockResolvedValue([]);
  personLock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe("IdentityHome accept path", () => {
  it("offers a vault creation from the identity landing in one action", async () => {
    render(
      <IdentityHome
        personIdHex="person"
        identityCode="code"
        onCreateVault={() => {}}
        onAccepted={() => {}}
        onForgotten={() => {}}
      />,
    );
    await waitFor(() => expect(personListInvites).toHaveBeenCalled());
    expect(screen.getByTestId("identity-home.create-vault-cta")).toBeTruthy();
  });

  it("lists a pending invite and opens the accept form with the member phrase", async () => {
    personListInvites.mockResolvedValue([
      { invite_id_hex: "aa", vault_account_hash_hex: "bb", claimed: false },
    ]);
    render(
      <IdentityHome
        personIdHex="person"
        identityCode="code"
        onCreateVault={() => {}}
        onAccepted={() => {}}
        onForgotten={() => {}}
      />,
    );
    const open = await screen.findByTestId("identity-home.accept-open");
    fireEvent.click(open);
    // The accept form opens with the owner-code field; the member then inspects
    // the fingerprint and confirms before the phrase step.
    expect(await screen.findByTestId("identity-home.accept-owner-code")).toBeTruthy();
    expect(screen.getByTestId("identity-home.accept-inspect")).toBeTruthy();
  });

  // myne-md/myne#782: the identity can be forgotten from the home, gated on a
  // short acknowledgement, and the parent is told so it can re-probe.
  it("forgets this device's identity behind an acknowledgement", async () => {
    const onForgotten = vi.fn();
    render(
      <IdentityHome
        personIdHex="person"
        identityCode="code"
        onCreateVault={() => {}}
        onAccepted={() => {}}
        onForgotten={onForgotten}
      />,
    );

    fireEvent.click(await screen.findByTestId("identity-home.forget-cta"));
    const confirm = (await screen.findByTestId(
      "identity-home.forget-confirm-cta",
    )) as HTMLButtonElement;
    // Gated until the acknowledgement is ticked.
    expect(confirm.disabled).toBe(true);

    fireEvent.click(screen.getByTestId("identity-home.forget-ack"));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);

    await waitFor(() => expect(personLock).toHaveBeenCalledWith(true));
    await waitFor(() => expect(onForgotten).toHaveBeenCalled());
  });
});
