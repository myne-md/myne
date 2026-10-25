// @vitest-environment jsdom

// The identity home and its accept path (myne-md/myne#768, reusing the #711
// flow). The failure this guards: joining a vault that was shared with you needs
// your OWN recovery phrase, never a vault phrase a member never had
// (`decisions/protocol/0606`), and the accept path must be reachable from the
// identity-first landing.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const personListInvites = vi.hoisted(() => vi.fn());
const personRegister = vi.hoisted(() => vi.fn());
const readSyncConfig = vi.hoisted(() => vi.fn());
const writeSyncEndpoint = vi.hoisted(() => vi.fn());
const personLock = vi.hoisted(() => vi.fn());
const personAcceptInvite = vi.hoisted(() => vi.fn());
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
  personRegister,
  readSyncConfig,
  writeSyncEndpoint,
}));

vi.mock("../../src/lib/invite", () => ({
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
// The register door is behind the beta-terms gate (operations#15). Settled here so
// a submit reaches `personRegister`; the gate has its own specs.
vi.mock("../../src/hooks/useBetaTermsGate", () => ({
  useBetaTermsGate: () => ({ pending: false, needed: false, accept: vi.fn() }),
}));

import { IdentityHome, acceptErrorKey } from "../../src/screens/IdentityHome";
import {
  resetPersonIdentityState,
  setPersonIdentityState,
} from "../../src/components/sync/personIdentityState";
import { PHRASE_CELL_COUNT } from "../../src/components/PhraseEntryGrid";
import { MIN_PASSWORD_LEN } from "../../src/components/PasswordInput";

/** Leave the current accept step for the next one. The accept is three steps now
 *  (myne-md/myne#871) and only the current step's Continue is on screen, so one
 *  testid addresses all of them. */
function continueAccept(): void {
  fireEvent.click(screen.getByTestId("identity-home.accept-continue"));
}

beforeEach(() => {
  resetPersonIdentityState();
  personListInvites.mockReset().mockResolvedValue([]);
  personRegister.mockReset().mockResolvedValue({});
  readSyncConfig
    .mockReset()
    .mockResolvedValue({ endpoint_url: "https://sync.example", invite_code: null });
  writeSyncEndpoint.mockReset().mockResolvedValue(undefined);
  personLock.mockReset().mockResolvedValue(undefined);
  personAcceptInvite.mockReset().mockResolvedValue(undefined);
  listRoster.mockReset();
  setMyMemberName.mockReset();
});

afterEach(() => {
  cleanup();
  resetPersonIdentityState();
  vi.useRealTimers();
});

describe("IdentityHome accept path", () => {
  const OWNER_CODE = `MYNE-PERSON-1:${"11".repeat(16)}:${"22".repeat(32)}:${"33".repeat(32)}:${"44".repeat(48)}`;

  it("offers a vault creation from the identity landing in one action", async () => {
    // The identity is UNLOCKED for this session, which is what the CTA needs: a
    // vault born under an identity signs its first member list with that key, so
    // the button is withheld (not disabled) while it is sealed. The next case
    // pins the locked arm.
    setPersonIdentityState({ ready: true, ownerCode: "MYNE-PERSON-1:owner" });
    render(
      <IdentityHome
        identityCode="code"
        accountNumber={null}
        onCreateVault={() => {}}
        onAccepted={() => {}}
        onForgotten={() => {}}
        accountState="enrolled"
        onRegistered={() => {}}
      />,
    );
    await waitFor(() => expect(personListInvites).toHaveBeenCalled());
    expect(screen.getByTestId("identity-home.create-vault-cta")).toBeTruthy();
  });

  it("offers the unlock door instead of a CTA it cannot honour while the identity is locked", async () => {
    // 2026-10-25 owner report: the CTA was offered while the identity was locked,
    // the creation flow answered `PersonLocked`, and that sentence pointed at a
    // door this screen did not have. On a device with zero vaults this screen is
    // the only surface reachable, so the dead end was total.
    setPersonIdentityState({ ready: false, ownerCode: "MYNE-PERSON-1:owner" });
    render(
      <IdentityHome
        identityCode="code"
        accountNumber={null}
        onCreateVault={() => {}}
        onAccepted={() => {}}
        onForgotten={() => {}}
        accountState="enrolled"
        onRegistered={() => {}}
      />,
    );

    expect(await screen.findByTestId("identity-home.create-vault-locked")).toBeTruthy();
    expect(screen.queryByTestId("identity-home.create-vault-cta")).toBeNull();
    // The door is mounted here, not pointed at: the same modal Settings uses.
    expect(screen.getByTestId("sync.panel.identity-unlock.open")).toBeTruthy();
  });

  it("lists a pending invite and opens the accept form with the member phrase", async () => {
    personListInvites.mockResolvedValue([
      { invite_id_hex: "aa", vault_account_hash_hex: "bb", claimed: false },
    ]);
    render(
      <IdentityHome
        identityCode="code"
        accountNumber={null}
        onCreateVault={() => {}}
        onAccepted={() => {}}
        onForgotten={() => {}}
        accountState="enrolled"
        onRegistered={() => {}}
      />,
    );
    const open = await screen.findByTestId("identity-home.accept-open");
    fireEvent.click(open);
    // The accept opens on its OWNER step: the owner's identity code and nothing
    // else. The member phrase is a step of its own below, and there is no
    // out-of-band fingerprint compare to perform on this step.
    expect(await screen.findByTestId("identity-home.accept-step")).toBeTruthy();
    expect(screen.getByTestId("identity-home.accept-owner-code")).toBeTruthy();
    expect(screen.queryByTestId("identity-home.accept-inspect")).toBeNull();
    expect(screen.queryByTestId("identity-home.accept-phrase-grid")).toBeNull();
  });

  // The three-step skeleton itself (myne-md/myne#871): step 1 -> phrase ->
  // password, and every step can be walked back to without losing what the
  // earlier ones collected (which is why that state lives in the wizard and not
  // in the step components).
  it("walks owner -> phrase -> password, and back", async () => {
    personListInvites.mockResolvedValue([
      { invite_id_hex: "aa", vault_account_hash_hex: "bb", claimed: false },
    ]);
    render(
      <IdentityHome
        identityCode="code"
        accountNumber={null}
        onCreateVault={() => {}}
        onAccepted={() => {}}
        onForgotten={() => {}}
        accountState="enrolled"
        onRegistered={() => {}}
      />,
    );
    fireEvent.click(await screen.findByTestId("identity-home.accept-open"));

    // Step 1's Continue is gated on the owner's code being present.
    const firstContinue = () => screen.getByTestId("identity-home.accept-continue") as HTMLButtonElement;
    expect(firstContinue().disabled).toBe(true);
    fireEvent.change(screen.getByTestId("identity-home.accept-owner-code"), {
      target: { value: OWNER_CODE },
    });
    expect(firstContinue().disabled).toBe(false);

    fireEvent.click(firstContinue());
    expect(await screen.findByTestId("identity-home.accept-phrase-grid")).toBeTruthy();

    // Back from the phrase returns to the owner step with its code still in the
    // box, so the walk is not a re-entry of the out-of-band material.
    fireEvent.click(screen.getByTestId("identity-home.accept-back"));
    expect(await screen.findByTestId("identity-home.accept-owner-code")).toBeTruthy();
    expect(
      (screen.getByTestId("identity-home.accept-owner-code") as HTMLTextAreaElement).value,
    ).toBe(OWNER_CODE);
    fireEvent.click(screen.getByTestId("identity-home.accept-continue"));

    // The phrase step's Continue is gated on all 24 words.
    const phraseContinue = () =>
      screen.getByTestId("identity-home.accept-continue") as HTMLButtonElement;
    expect(phraseContinue().disabled).toBe(true);
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
    expect(phraseContinue().disabled).toBe(false);
    fireEvent.click(phraseContinue());

    // Step 3 is the password, and its Back goes to the phrase step rather than
    // out of the wizard.
    expect(await screen.findByTestId("identity-home.accept.password-input")).toBeTruthy();
    fireEvent.click(screen.getByTestId("identity-home.accept.secondary"));
    expect(await screen.findByTestId("identity-home.accept-phrase-grid")).toBeTruthy();
  });

  // Cancel exits the takeover entirely; the invite row is still there to re-open
  // (and the wizard's fields, including the phrase, went with the unmount).
  it("cancels out of the accept wizard back to the invite list", async () => {
    personListInvites.mockResolvedValue([
      { invite_id_hex: "aa", vault_account_hash_hex: "bb", claimed: false },
    ]);
    render(
      <IdentityHome
        identityCode="code"
        accountNumber={null}
        onCreateVault={() => {}}
        onAccepted={() => {}}
        onForgotten={() => {}}
        accountState="enrolled"
        onRegistered={() => {}}
      />,
    );
    fireEvent.click(await screen.findByTestId("identity-home.accept-open"));
    fireEvent.click(screen.getByTestId("identity-home.accept-cancel"));

    expect(await screen.findByTestId("identity-home.invite-row")).toBeTruthy();
    expect(screen.queryByTestId("identity-home.accept-form")).toBeNull();
  });

  // myne-md/myne#782: the identity can be forgotten from the home, gated on a
  // short acknowledgement, and the parent is told so it can re-probe.
  it("forgets this device's identity behind an acknowledgement", async () => {
    const onForgotten = vi.fn();
    render(
      <IdentityHome
        identityCode="code"
        accountNumber={null}
        onCreateVault={() => {}}
        onAccepted={() => {}}
        onForgotten={onForgotten}
        accountState="enrolled"
        onRegistered={() => {}}
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

  // The confirmation is a DIALOG rather than a box expanding in the card
  // (2026-10-24). What that buys the user has to be asserted, or the shell could
  // be swapped back for a div and every test above would still pass: the surface
  // says it is a modal, and Escape answers it without the erase running.
  it("opens the forget confirmation as a dialog that Escape dismisses", async () => {
    render(
      <IdentityHome
        identityCode="code"
        accountNumber={null}
        onCreateVault={() => {}}
        onAccepted={() => {}}
        onForgotten={() => {}}
        accountState="enrolled"
        onRegistered={() => {}}
      />,
    );

    // Nothing is expanded before the press: the card states the action, and the
    // warning lives in the dialog.
    expect(screen.queryByTestId("identity-home.forget-confirm")).toBeNull();
    fireEvent.click(await screen.findByTestId("identity-home.forget-cta"));

    const dialog = await screen.findByTestId("identity-home.forget-confirm");
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByTestId("identity-home.forget-warning")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("identity-home.forget-confirm")).toBeNull(),
    );
    expect(personLock).not.toHaveBeenCalled();
  });

  // The acknowledgement is the dialog's own state, not the screen's, so closing
  // the dialog throws it away instead of leaving a ticked box behind for whoever
  // opens it next (which is what the inline box did by hand).
  it("does not carry the acknowledgement across a close", async () => {
    render(
      <IdentityHome
        identityCode="code"
        accountNumber={null}
        onCreateVault={() => {}}
        onAccepted={() => {}}
        onForgotten={() => {}}
        accountState="enrolled"
        onRegistered={() => {}}
      />,
    );

    fireEvent.click(await screen.findByTestId("identity-home.forget-cta"));
    fireEvent.click(screen.getByTestId("identity-home.forget-ack"));
    expect(
      (screen.getByTestId("identity-home.forget-confirm-cta") as HTMLButtonElement)
        .disabled,
    ).toBe(false);

    fireEvent.click(screen.getByTestId("identity-home.forget-cancel"));
    fireEvent.click(screen.getByTestId("identity-home.forget-cta"));

    expect(
      (screen.getByTestId("identity-home.forget-confirm-cta") as HTMLButtonElement)
        .disabled,
    ).toBe(true);
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
        identityCode="code"
        accountNumber={null}
        onCreateVault={() => {}}
        onAccepted={() => {}}
        onForgotten={() => {}}
        accountState="enrolled"
        onRegistered={() => {}}
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
    render(
      <IdentityHome
        identityCode="code"
        accountNumber={null}
        onCreateVault={() => {}}
        onAccepted={() => {}}
        onForgotten={() => {}}
        accountState="enrolled"
        onRegistered={() => {}}
      />,
    );
    fireEvent.click(await screen.findByTestId("identity-home.accept-open"));
    fireEvent.change(screen.getByTestId("identity-home.accept-owner-code"), {
      target: { value: OWNER_CODE },
    });
    continueAccept();
    await screen.findByTestId("identity-home.accept-phrase-grid");
    fillPhrase();
    continueAccept();
    await screen.findByTestId("identity-home.accept.password-input");
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

  it("withholds the in-flight Back, so a late refusal keeps a banner to land on", async () => {
    let fail!: () => void;
    personAcceptInvite.mockImplementation(
      () =>
        new Promise<void>((_, reject) => {
          fail = () => reject({ kind: "BadRequest" });
        }),
    );
    await readyExceptPassword();
    fireEvent.change(screen.getByTestId("identity-home.accept.password-input"), {
      target: { value: PASSWORD },
    });
    fireEvent.change(screen.getByTestId("identity-home.accept.confirm-input"), {
      target: { value: PASSWORD },
    });
    fireEvent.click(submit());

    // In flight, and the submit is an Argon2id-bound call: there is no Back. A
    // refusal that arrives late renders on THIS step's banner, and walking to the
    // phrase step, which has none, would drop it silently.
    await waitFor(() =>
      expect(screen.queryByTestId("identity-home.accept.secondary")).toBeNull(),
    );
    expect(submit().disabled).toBe(true);

    fail();
    expect((await screen.findByTestId("identity-home.accept-error")).textContent).toBe(
      "identityHome.acceptErrorBadRequest",
    );
    // …and the walk is offered again once the call has settled.
    await waitFor(() =>
      expect(screen.getByTestId("identity-home.accept.secondary")).toBeTruthy(),
    );
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
    render(
      <IdentityHome
        identityCode="code"
        accountNumber={null}
        onCreateVault={() => {}}
        onAccepted={onAccepted}
        onForgotten={() => {}}
        accountState="enrolled"
        onRegistered={() => {}}
      />,
    );
    fireEvent.click(await screen.findByTestId("identity-home.accept-open"));
    fireEvent.change(screen.getByTestId("identity-home.accept-owner-code"), {
      target: { value: OWNER_CODE },
    });
    continueAccept();
    await screen.findByTestId("identity-home.accept-phrase-grid");
    fillPhrase();
    continueAccept();
    await screen.findByTestId("identity-home.accept.password-input");
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
    personAcceptInvite.mockResolvedValue({});
    render(
      <IdentityHome
        identityCode="code"
        accountNumber={null}
        onCreateVault={() => {}}
        onAccepted={onAccepted}
        onForgotten={() => {}}
        accountState="enrolled"
        onRegistered={() => {}}
      />,
    );
    fireEvent.click(await screen.findByTestId("identity-home.accept-open"));
    fireEvent.change(screen.getByTestId("identity-home.accept-owner-code"), {
      target: { value: OWNER_CODE },
    });
    continueAccept();
    await screen.findByTestId("identity-home.accept-phrase-grid");
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
    continueAccept();
    await screen.findByTestId("identity-home.accept.password-input");
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

// 2026-10-23. The invitation list is addressed to a `person_id_hash` the server
// holds, so a `reserved` identity (nothing sent) or a `pending` one (no token)
// has none to miss. The screen used to ask the relay anyway and paint the
// refusal as "could not load invites. Check your connection and sync server",
// which turned a normal first-run state into a fault and pointed the user at
// the one cause that was not the problem.
describe("IdentityHome invitation state follows the account lifecycle", () => {
  const renderWith = (accountState: "reserved" | "pending" | "enrolled") =>
    render(
      <IdentityHome
        identityCode="code"
        accountNumber={null}
        onCreateVault={() => {}}
        onAccepted={() => {}}
        onForgotten={() => {}}
        accountState={accountState}
        onRegistered={() => {}}
      />,
    );

  it("does not ask the relay for a reserved identity, and says why", async () => {
    renderWith("reserved");
    await screen.findByTestId("identity-home.invites-unavailable");
    expect(personListInvites).not.toHaveBeenCalled();
    expect(screen.getByTestId("identity-home.invites-unavailable").textContent).toBe(
      "identityHome.invitesUnregistered",
    );
    // The explanation and the action that ends the state are ONE block
    // (2026-10-24): the paragraph says no invitation can reach this identity, and
    // the register control sits under it rather than in a second block below the
    // list. Injection: moving the control back out reddens this.
    expect(screen.getByTestId("identity-home.register-cta")).toBeTruthy();
    expect(screen.getByTestId("identity-home.account-state").textContent).toContain(
      "identityHome.invitesUnregistered",
    );
    expect(screen.queryByTestId("identity-home.error")).toBeNull();
  });

  it("does not ask the relay for a pending device, and says why", async () => {
    renderWith("pending");
    await screen.findByTestId("identity-home.invites-unavailable");
    expect(personListInvites).not.toHaveBeenCalled();
    expect(screen.getByTestId("identity-home.invites-unavailable").textContent).toBe(
      "identityHome.invitesPending",
    );
    // A wait has no action: the register control belongs to `reserved` alone.
    expect(screen.queryByTestId("identity-home.register-cta")).toBeNull();
  });

  it("reads a NotEnrolled refusal as the same state, not as a connection error", async () => {
    // A stale `accountState` (registered on another surface this session) can
    // still reach the relay; the refusal is the same fact as the prop's and must
    // land in the same place. Injection: mapping it back to `failed` reddens this.
    personListInvites.mockRejectedValue({ kind: "NotEnrolled" });
    renderWith("enrolled");
    await screen.findByTestId("identity-home.invites-unavailable");
    expect(screen.queryByTestId("identity-home.error")).toBeNull();
  });

  it("keeps a genuine failure as the connection banner", async () => {
    personListInvites.mockRejectedValue({ kind: "Transport" });
    renderWith("enrolled");
    await screen.findByTestId("identity-home.error");
    expect(screen.queryByTestId("identity-home.invites-unavailable")).toBeNull();
  });
});

// 2026-10-24: the register act is a DIALOG (it used to expand a 24-cell grid
// inside the card, which is what pushed the card past the window), in TWO STEPS
// (the server is a decision, the phrase is a secret, and one view made the user
// read both before understanding either), and the server step comes first, because
// which server the identity is written to is a decision with a place rather than a
// value inherited in silence. This screen is reachable at zero vaults, where
// Settings does not exist, so the address has to be answerable here.
describe("IdentityHome registration", () => {
  const P = "identity-home.register";
  const PHRASE = Array.from({ length: PHRASE_CELL_COUNT }, (_, i) => `word${i + 1}`);

  const renderReserved = (onRegistered: () => void = () => {}) =>
    render(
      <IdentityHome
        identityCode="code"
        accountNumber={null}
        onCreateVault={() => {}}
        onAccepted={() => {}}
        onForgotten={() => {}}
        accountState="reserved"
        onRegistered={onRegistered}
      />,
    );

  const fillCells = (prefix: string) => {
    for (let i = 0; i < PHRASE_CELL_COUNT; i += 1) {
      const id = i === 0 ? `${prefix}-phrase` : `${prefix}-phrase-cell-${i + 1}`;
      fireEvent.change(screen.getByTestId(id), { target: { value: PHRASE[i] } });
    }
  };

  /** Step one's Continue, the only way to the phrase. */
  const toPhraseStep = async (prefix: string = P) => {
    fireEvent.click(await screen.findByTestId(`${prefix}-continue`));
    await screen.findByTestId(`${prefix}-phrase-grid`);
  };

  it("opens as a dialog on the server step, with the card left as it was", async () => {
    renderReserved();
    // Nothing of the form is in the card before the press.
    expect(screen.queryByTestId(`${P}-server`)).toBeNull();
    fireEvent.click(await screen.findByTestId("identity-home.register-cta"));
    // Mounted through a portal on `document.body`, and the form is inside it.
    const dialog = await screen.findByTestId(`${P}-dialog`);
    expect(dialog.parentElement).toBe(document.body);
    expect(screen.getByTestId(`${P}-server`)).toBeTruthy();
    // The phrase is not in the same view as the address.
    expect(screen.queryByTestId(`${P}-phrase-grid`)).toBeNull();
  });

  it("asks for the phrase in 24 cells, and keeps Register disabled until they are full", async () => {
    renderReserved();
    fireEvent.click(await screen.findByTestId("identity-home.register-cta"));
    await toPhraseStep();
    const submit = screen.getByTestId(`${P}-submit`) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByTestId(`${P}-phrase`), {
      target: { value: PHRASE[0] },
    });
    expect(submit.disabled).toBe(true);

    fillCells(P);
    expect(submit.disabled).toBe(false);
  });

  it("shows the server the identity will be registered on, prefilled", async () => {
    renderReserved();
    fireEvent.click(await screen.findByTestId("identity-home.register-cta"));
    const server = (await screen.findByTestId(`${P}-server`)) as HTMLInputElement;
    await waitFor(() => expect(server.value).toBe("https://sync.example"));
    // Unchanged, so it is not re-written (each write re-verifies TLS).
    await toPhraseStep();
    fillCells(P);
    fireEvent.click(screen.getByTestId(`${P}-submit`));
    await waitFor(() => expect(personRegister).toHaveBeenCalledWith(PHRASE.join(" ")));
    expect(writeSyncEndpoint).not.toHaveBeenCalled();
  });

  it("takes an address when the device has none, and sets it before any phrase", async () => {
    readSyncConfig.mockResolvedValue({ endpoint_url: null, invite_code: null });
    renderReserved();
    fireEvent.click(await screen.findByTestId("identity-home.register-cta"));
    const server = await screen.findByTestId(`${P}-server`);
    // No address, no way forward: the order the 2026-10-24 report asked for.
    expect((screen.getByTestId(`${P}-continue`) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(server, { target: { value: "https://sync.example" } });
    await toPhraseStep();
    expect(writeSyncEndpoint).toHaveBeenCalledWith("https://sync.example", null);
    expect(personRegister).not.toHaveBeenCalled();
    fillCells(P);
    fireEvent.click(screen.getByTestId(`${P}-submit`));
    await waitFor(() => expect(personRegister).toHaveBeenCalledWith(PHRASE.join(" ")));
  });

  it("goes back to the server step on NotConfigured, with the words kept", async () => {
    // The defect the report named: the address was hidden, the register call
    // refused `NotConfigured`, and the 24 words were wiped before the address
    // field appeared. Injection: restoring `resetCells()` on this arm reddens it.
    personRegister.mockRejectedValue({ kind: "NotConfigured" });
    renderReserved();
    fireEvent.click(await screen.findByTestId("identity-home.register-cta"));
    await toPhraseStep();
    fillCells(P);
    fireEvent.click(screen.getByTestId(`${P}-submit`));

    expect((await screen.findByTestId(`${P}-error`)).textContent).toBe(
      "identityHome.registerServerError",
    );
    // Back where the fix is, and the words survived the round trip.
    expect(screen.getByTestId(`${P}-server`)).toBeTruthy();
    await toPhraseStep();
    expect((screen.getByTestId(`${P}-phrase`) as HTMLInputElement).value).toBe(PHRASE[0]);
  });

  it("closes the dialog and reprobes once the registration lands", async () => {
    const onRegistered = vi.fn();
    renderReserved(onRegistered);
    fireEvent.click(await screen.findByTestId("identity-home.register-cta"));
    await toPhraseStep();
    fillCells(P);
    fireEvent.click(screen.getByTestId(`${P}-submit`));
    await waitFor(() => expect(onRegistered).toHaveBeenCalled());
    expect(screen.queryByTestId(`${P}-dialog`)).toBeNull();
  });
});
