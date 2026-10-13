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
const personAcceptInvite = vi.hoisted(() => vi.fn());
const inspectInviteCode = vi.hoisted(() => vi.fn());
const listRoster = vi.hoisted(() => vi.fn());
const setMyMemberName = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// The accept form's submit is `PasswordCreateForm`'s own, and its gate includes
// zxcvbn: stubbed to a ready, passing score so the unit under test is the accept
// gate rather than an asynchronous dynamic import.
vi.mock("../../src/components/PasswordInput", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/components/PasswordInput")>();
  return { ...real, usePasswordStrength: () => ({ ready: true, result: { score: 4 } }) };
});

vi.mock("../../src/lib/personAccount", () => ({
  personListInvites,
  personAcceptInvite,
}));

vi.mock("../../src/lib/invite", () => ({
  inspectInviteCode,
  personLock,
  listRoster,
}));

vi.mock("../../src/lib/memberNames", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/memberNames")>();
  return { ...real, setMyMemberName };
});

vi.mock("../../src/lib/clipboard", () => ({ copyText: vi.fn() }));
vi.mock("../../src/platform/clipboardManager", () => ({ writeText: vi.fn() }));
vi.mock("../../src/components/toast/toastStore", () => ({ toast: vi.fn() }));

import { IdentityHome, acceptErrorKey } from "../../src/screens/IdentityHome";
import { PHRASE_CELL_COUNT } from "../../src/components/sync/EnrollPhraseCredential";
import { MIN_PASSWORD_LEN } from "../../src/components/PasswordInput";

beforeEach(() => {
  personListInvites.mockReset().mockResolvedValue([]);
  personLock.mockReset().mockResolvedValue(undefined);
  personAcceptInvite.mockReset().mockResolvedValue(undefined);
  inspectInviteCode.mockReset();
  listRoster.mockReset();
  setMyMemberName.mockReset();
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

// myne-md/myne#851 task 7: an accepted vault always carries a device-local fast
// credential, because the accept form cannot be completed without a password that
// meets the project floor. The password reaches the command as its own argument,
// and the copy says plainly what it is (this device's, not the owner's).
describe("IdentityHome accept requires a device password", () => {
  const OWNER_CODE = `MYNE-PERSON-1:${"11".repeat(16)}:${"22".repeat(32)}:${"33".repeat(32)}:${"44".repeat(48)}`;
  const PASSWORD = "correct horse battery staple";
  const INVITE = { invite_id_hex: "invite-1", vault_account_hash_hex: "bb", claimed: false };

  function fillPhrase(): void {
    for (let index = 0; index < PHRASE_CELL_COUNT; index += 1) {
      fireEvent.change(
        screen.getByTestId(
          index === 0
            ? "identity-home.accept-phrase"
            : `identity-home.accept-phrase-cell-${index + 1}`,
        ),
        { target: { value: `word${index + 1}` } },
      );
    }
  }

  /** Open the form and satisfy everything EXCEPT the password. */
  async function readyExceptPassword(): Promise<void> {
    personListInvites.mockResolvedValue([INVITE]);
    inspectInviteCode.mockResolvedValue({ fingerprint_hex: "55".repeat(32) });
    render(
      <IdentityHome
        personIdHex="person"
        identityCode="code"
        onCreateVault={() => {}}
        onAccepted={() => {}}
        onForgotten={() => {}}
      />,
    );
    fireEvent.click(await screen.findByTestId("identity-home.accept-open"));
    fireEvent.change(screen.getByTestId("identity-home.accept-owner-code"), {
      target: { value: OWNER_CODE },
    });
    fireEvent.click(screen.getByTestId("identity-home.accept-inspect"));
    await screen.findByTestId("identity-home.accept-sas");
    fireEvent.click(screen.getByTestId("identity-home.accept-confirm"));
    fillPhrase();
  }

  const submit = () =>
    screen.getByTestId("identity-home.accept.submit") as HTMLButtonElement;

  it("keeps accept disabled until a password meeting the floor is confirmed", async () => {
    await readyExceptPassword();
    // The phrase and the out-of-band confirmation are done, and that is no longer
    // enough: the password step is required.
    expect(submit().disabled).toBe(true);

    fireEvent.change(screen.getByTestId("identity-home.accept.password-input"), {
      target: { value: "a".repeat(MIN_PASSWORD_LEN - 1) },
    });
    expect(submit().disabled).toBe(true);

    fireEvent.change(screen.getByTestId("identity-home.accept.password-input"), {
      target: { value: PASSWORD },
    });
    // Over the floor, but unconfirmed.
    expect(submit().disabled).toBe(true);

    fireEvent.change(screen.getByTestId("identity-home.accept.confirm-input"), {
      target: { value: PASSWORD },
    });
    expect(submit().disabled).toBe(false);
  });

  it("does not accept while the two password fields differ", async () => {
    await readyExceptPassword();
    const password = screen.getByTestId("identity-home.accept.password-input");
    fireEvent.change(password, { target: { value: PASSWORD } });
    fireEvent.change(screen.getByTestId("identity-home.accept.confirm-input"), {
      target: { value: `${PASSWORD}x` },
    });
    expect(submit().disabled).toBe(true);
    fireEvent.click(submit());
    expect(personAcceptInvite).not.toHaveBeenCalled();
  });

  it("says the password is for this device, not the owner's", async () => {
    await readyExceptPassword();
    expect(screen.getByTestId("identity-home.accept-password-note").textContent).toBe(
      "identityHome.acceptPasswordNote",
    );
  });

  it("passes the password to the command beside the phrase", async () => {
    const onAccepted = vi.fn();
    personListInvites.mockResolvedValue([INVITE]);
    inspectInviteCode.mockResolvedValue({ fingerprint_hex: "55".repeat(32) });
    render(
      <IdentityHome
        personIdHex="person"
        identityCode="code"
        onCreateVault={() => {}}
        onAccepted={onAccepted}
        onForgotten={() => {}}
      />,
    );
    fireEvent.click(await screen.findByTestId("identity-home.accept-open"));
    fireEvent.change(screen.getByTestId("identity-home.accept-owner-code"), {
      target: { value: OWNER_CODE },
    });
    fireEvent.click(screen.getByTestId("identity-home.accept-inspect"));
    await screen.findByTestId("identity-home.accept-sas");
    fireEvent.click(screen.getByTestId("identity-home.accept-confirm"));
    fillPhrase();
    fireEvent.change(screen.getByTestId("identity-home.accept.password-input"), {
      target: { value: PASSWORD },
    });
    fireEvent.change(screen.getByTestId("identity-home.accept.confirm-input"), {
      target: { value: PASSWORD },
    });
    fireEvent.click(submit());

    await waitFor(() =>
      expect(personAcceptInvite).toHaveBeenCalledWith(
        "invite-1",
        OWNER_CODE,
        Array.from({ length: PHRASE_CELL_COUNT }, (_, index) => `word${index + 1}`).join(" "),
        PASSWORD,
      ),
    );
    // The accept no longer lands on the editor: the name gate does (task 8), and
    // the callback that reprobes is withheld until it completes.
    expect(await screen.findByTestId("name-gate.input")).toBeTruthy();
    expect(onAccepted).not.toHaveBeenCalled();
  });
});

// myne-md/myne#851 task 8 (stories 5 to 7): the accept does not reach the editor
// until a name has been written, and quitting at the gate is not a lockout.
describe("IdentityHome accept reaches the name gate", () => {
  const OWNER_CODE = `MYNE-PERSON-1:${"11".repeat(16)}:${"22".repeat(32)}:${"33".repeat(32)}:${"44".repeat(48)}`;
  const PASSWORD = "correct horse battery staple";
  const INVITE = { invite_id_hex: "invite-1", vault_account_hash_hex: "bb", claimed: false };

  async function accept(onAccepted: () => void): Promise<void> {
    personListInvites.mockResolvedValue([INVITE]);
    inspectInviteCode.mockResolvedValue({ fingerprint_hex: "55".repeat(32) });
    personAcceptInvite.mockResolvedValue({});
    render(
      <IdentityHome
        personIdHex="person"
        identityCode="code"
        onCreateVault={() => {}}
        onAccepted={onAccepted}
        onForgotten={() => {}}
      />,
    );
    fireEvent.click(await screen.findByTestId("identity-home.accept-open"));
    fireEvent.change(screen.getByTestId("identity-home.accept-owner-code"), {
      target: { value: OWNER_CODE },
    });
    fireEvent.click(screen.getByTestId("identity-home.accept-inspect"));
    await screen.findByTestId("identity-home.accept-sas");
    fireEvent.click(screen.getByTestId("identity-home.accept-confirm"));
    for (let index = 0; index < PHRASE_CELL_COUNT; index += 1) {
      fireEvent.change(
        screen.getByTestId(
          index === 0
            ? "identity-home.accept-phrase"
            : `identity-home.accept-phrase-cell-${index + 1}`,
        ),
        { target: { value: `word${index + 1}` } },
      );
    }
    fireEvent.change(screen.getByTestId("identity-home.accept.password-input"), {
      target: { value: PASSWORD },
    });
    fireEvent.change(screen.getByTestId("identity-home.accept.confirm-input"), {
      target: { value: PASSWORD },
    });
    fireEvent.click(screen.getByTestId("identity-home.accept.submit"));
    await waitFor(() => expect(personAcceptInvite).toHaveBeenCalled());
  }

  // A roster where the CALLER has no name, which is what the gate is for.
  function unnamedRoster() {
    return {
      members: [
        {
          fingerprint_hex: "aa".repeat(32),
          is_self: true,
          display_name: "",
          name_state: "absent",
          role: "member",
          version: 0,
          previous_fingerprint_hex: null,
          joined_at: 0,
          member_ed_pk_hex: "bb".repeat(32),
          member_kem_ek_hex: "cc".repeat(32),
          member_mldsa_vk_hex: "dd".repeat(48),
          continuity: null,
        },
      ],
      authority: "member",
      group_key_epoch: 3,
    };
  }

  it("cannot reach the editor without a name, and continues once one is set", async () => {
    listRoster.mockResolvedValue(unnamedRoster());
    setMyMemberName.mockResolvedValue({});
    const onAccepted = vi.fn();
    await accept(onAccepted);

    // The gate, not the editor: the screen took over and the phrase grid is gone.
    expect(await screen.findByTestId("name-gate.input")).toBeTruthy();
    expect(screen.queryByTestId("identity-home.accept-phrase")).toBeNull();
    expect(onAccepted).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("name-gate.input"), { target: { value: "Ada" } });
    fireEvent.click(screen.getByTestId("name-gate.save"));

    await waitFor(() => expect(setMyMemberName).toHaveBeenCalledWith("Ada"));
    await waitFor(() => expect(onAccepted).toHaveBeenCalledOnce());
  });

  // Story 7. The gate writes nothing, so a member who quits here still has the vault
  // the accept committed, with no name, and the row falls back to the fingerprint.
  it("writes nothing, leaving an openable unnamed vault behind", async () => {
    listRoster.mockResolvedValue(unnamedRoster());
    const onAccepted = vi.fn();
    await accept(onAccepted);
    await screen.findByTestId("name-gate.input");

    cleanup();
    expect(setMyMemberName).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
  });
});
