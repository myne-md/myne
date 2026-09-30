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

import { IdentityHome, acceptErrorKey } from "../../src/screens/IdentityHome";

beforeEach(() => {
  personListInvites.mockReset().mockResolvedValue([]);
  personLock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

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

// myne-md/myne#794: an invite that arrives while the identity home is already
// open must appear without quitting and reopening the app. The relay has no
// push channel for a person account, so the screen re-fetches on an interval
// and immediately when the window regains focus (or the tab becomes visible).
describe("IdentityHome invite refresh (myne-md/myne#794)", () => {
  const INVITE = { invite_id_hex: "aa", vault_account_hash_hex: "bb", claimed: false };

  const renderHome = () =>
    render(
      <IdentityHome
        personIdHex="person"
        identityCode="code"
        onCreateVault={() => {}}
        onAccepted={() => {}}
        onForgotten={() => {}}
      />,
    );

  it("re-fetches the list on window focus, without a remount", async () => {
    personListInvites.mockResolvedValue([]);
    renderHome();
    await waitFor(() => expect(personListInvites).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("identity-home.empty-invites")).toBeTruthy();

    personListInvites.mockResolvedValue([INVITE]);
    fireEvent(window, new Event("focus"));

    expect(await screen.findByTestId("identity-home.accept-open")).toBeTruthy();
    expect(personListInvites).toHaveBeenCalledTimes(2);
  });

  it("re-polls on an interval so a new invite surfaces while the screen stays open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    personListInvites.mockResolvedValueOnce([]).mockResolvedValue([INVITE]);
    renderHome();

    await waitFor(() => expect(personListInvites).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("identity-home.accept-open")).toBeNull();

    vi.advanceTimersByTime(5000);
    await waitFor(() => expect(personListInvites.mock.calls.length).toBeGreaterThanOrEqual(2));

    expect(await screen.findByTestId("identity-home.accept-open")).toBeTruthy();
  });

  it("keeps the last good list when a background refetch fails", async () => {
    personListInvites.mockResolvedValue([INVITE]);
    renderHome();
    await screen.findByTestId("identity-home.accept-open");

    personListInvites.mockRejectedValueOnce(new Error("relay down"));
    fireEvent(window, new Event("focus"));

    await waitFor(() => expect(personListInvites).toHaveBeenCalledTimes(2));
    // The invite stays; the "could not load" banner is reserved for the initial
    // load, so a transient poll failure must not replace a working list.
    expect(screen.getByTestId("identity-home.accept-open")).toBeTruthy();
    expect(screen.queryByTestId("identity-home.error")).toBeNull();
  });
});

// myne-md/myne#794: the accept failure used to collapse every distinct cause
// into one sentence, which made a real failure indistinguishable from a wrong
// owner code during manual testing. Each closed `SyncDeviceError` kind now maps
// to its own message.
describe("identity accept error mapping", () => {
  it("maps each SyncDeviceError kind to a distinct message key", () => {
    expect(acceptErrorKey({ kind: "BadRequest" })).toBe("identityHome.acceptErrorBadRequest");
    expect(acceptErrorKey({ kind: "DeviceNotFound" })).toBe("identityHome.acceptErrorNotFound");
    expect(acceptErrorKey({ kind: "NotEnrolled" })).toBe("identityHome.acceptErrorNotEnrolled");
    expect(acceptErrorKey({ kind: "Unauthenticated" })).toBe(
      "identityHome.acceptErrorUnauthenticated",
    );
    expect(acceptErrorKey({ kind: "Transport" })).toBe("identityHome.acceptErrorTransport");
  });

  it("falls back to the generic message for anything unexpected", () => {
    expect(acceptErrorKey(new Error("boom"))).toBe("identityHome.acceptError");
    expect(acceptErrorKey(undefined)).toBe("identityHome.acceptError");
    expect(acceptErrorKey({ kind: "SomethingElse" })).toBe("identityHome.acceptError");
  });
});
