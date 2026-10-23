// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const personSetup = vi.hoisted(() => vi.fn());
const personStatus = vi.hoisted(() => vi.fn());
const personLock = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock("../../src/lib/personAccount", () => ({
  personSetup,
  personStatus,
}));

vi.mock("../../src/lib/invite", () => ({ personLock }));

vi.mock("../../src/platform/core", () => ({ invoke }));

import { IdentitySetupDialog } from "../../src/components/IdentitySetupDialog";
import { PHRASE_CELL_COUNT } from "../../src/components/PhraseEntryGrid";

function fillPhrase(): void {
  for (let index = 0; index < PHRASE_CELL_COUNT; index += 1) {
    fireEvent.change(
      screen.getByTestId(
        index === 0 ? "identity-setup.phrase-input" : `identity-setup.phrase-cell-${index + 1}`,
      ),
      { target: { value: `word${index + 1}` } },
    );
  }
}

beforeEach(() => {
  personSetup.mockReset().mockResolvedValue({
    phrase: null,
    fingerprint_hex: "fingerprint",
    person_id_hex: "person",
    identity_code: "code",
    approved: true,
  });
  personStatus.mockReset().mockResolvedValue({
    enrolled: false,
    identity_unlocked: false,
    person_id_hex: null,
    identity_code: null,
    sealed_keypair_present: false,
  });
  personLock.mockReset().mockResolvedValue(undefined);
  // A configured endpoint by default, so the dialog shows its identity form.
  // The server-step case is its own test below.
  invoke.mockReset().mockResolvedValue({ endpoint_url: "https://sync.example" });
});

afterEach(() => cleanup());

describe("IdentitySetupDialog", () => {
  it("uses the 24-cell recovery credential and submits the joined phrase", async () => {
    const onCreated = vi.fn();
    render(<IdentitySetupDialog open onClose={() => {}} onCreated={onCreated} />);

    // The recovery grid sits behind its own door, so a first identity is not
    // met by twenty-four empty fields.
    expect(screen.queryByTestId("identity-setup.phrase-grid")).toBeNull();
    fireEvent.click(await screen.findByTestId("identity-setup.recover-open"));

    const recoverCta = (await screen.findByTestId(
      "identity-setup.recover-cta",
    )) as HTMLButtonElement;
    expect(recoverCta.disabled).toBe(true);
    fillPhrase();
    expect(recoverCta.disabled).toBe(false);
    fireEvent.click(recoverCta);

    await waitFor(() =>
      expect(personSetup).toHaveBeenCalledWith(
        Array.from({ length: PHRASE_CELL_COUNT }, (_, index) => `word${index + 1}`).join(" "),
      ),
    );
  });

  // A RECOVERED identity returns `phrase: null`, and the frame used to derive
  // "a ceremony happened" from `phraseShown`. That is true only of the CREATE
  // arm, so Done on the recovery path closed the dialog without telling the
  // host, which never re-probed and left the user on a stale panel
  // (myne-md/myne#911 review). The assertion is on the callback, not the copy,
  // because the defect was invisible on screen.
  it("reports a recovered identity to the host when Done lands", async () => {
    const onCreated = vi.fn();
    render(<IdentitySetupDialog open onClose={() => {}} onCreated={onCreated} />);

    fireEvent.click(await screen.findByTestId("identity-setup.recover-open"));
    fillPhrase();
    fireEvent.click(await screen.findByTestId("identity-setup.recover-cta"));

    // The recovery arm's Done is the only way out: a recovered identity has
    // nothing to reveal and nothing to type back.
    fireEvent.click(await screen.findByTestId("identity-setup.close-cta"));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  });

  it("asks for no server address anywhere in the ceremony", () => {
    // myne-md/myne#911 task 6. Creating an identity is network-free: the keypair
    // derives from the phrase and registration is a separate act the identity
    // home offers later. The first-run server step and its "change server" link
    // therefore have no door here, and the assertion is on BOTH ids because a
    // hidden-but-mounted form is the failure a single query cannot see.
    render(<IdentitySetupDialog open onClose={() => {}} />);
    expect(screen.queryByTestId("identity-setup.change-server")).toBeNull();
    expect(screen.queryByTestId("first-run-server.root")).toBeNull();
    expect(screen.queryByTestId("sync.endpoint-config")).toBeNull();
  });

  it("reaches the identity form with no endpoint configured", async () => {
    // The same removal, from the direction that used to bite: a device with no
    // server at all is the ORDINARY first-run state now, and it must still be
    // able to create an identity.
    invoke.mockReset().mockResolvedValue({ endpoint_url: null });
    render(<IdentitySetupDialog open onClose={() => {}} />);
    expect(await screen.findByTestId("identity-setup.create-cta")).toBeTruthy();
    expect(screen.queryByTestId("first-run-server.root")).toBeNull();
  });

  it("reports a setup failure without offering a server door", async () => {
    // Registration used to be part of setup, so a TLS failure had its own
    // message and a link to fix the endpoint. Setup no longer registers, so any
    // failure here is the generic arm, and the remedy is not a server address.
    personSetup.mockRejectedValue({ kind: "Internal" });
    render(<IdentitySetupDialog open onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("identity-setup.create-cta"));

    expect((await screen.findByTestId("identity-setup.error")).textContent).toBe(
      "identitySetup.error",
    );
    expect(screen.queryByTestId("identity-setup.change-server")).toBeNull();
  });

  // myne-md/myne#780: a device that already holds a sealed identity is offered
  // Recover plus an explicit forget, never a Create that cannot open the frame.
  it("offers recover and an explicit forget when an identity is already held", async () => {
    personStatus.mockReset().mockResolvedValue({
      enrolled: false,
      identity_unlocked: false,
      person_id_hex: null,
      identity_code: null,
      sealed_keypair_present: true,
    });
    render(<IdentitySetupDialog open onClose={() => {}} />);

    await screen.findByTestId("identity-setup.held");
    // No Create affordance for a held identity.
    expect(screen.queryByTestId("identity-setup.create-cta")).toBeNull();
    // Recover stays reachable.
    expect(screen.getByTestId("identity-setup.recover-cta")).toBeTruthy();

    fireEvent.click(screen.getByTestId("identity-setup.forget-cta"));
    expect(screen.getByTestId("identity-setup.forget-confirm")).toBeTruthy();

    fireEvent.click(screen.getByTestId("identity-setup.forget-confirm-cta"));
    await waitFor(() => expect(personLock).toHaveBeenCalledWith(true));
    await waitFor(() => expect(personSetup).toHaveBeenCalled());
  });

  // The held identity's PUBLIC code is shown, so "an identity is held" names
  // WHICH one rather than only offering a recovery form (myne-md/myne#792
  // follow-up).
  it("shows the held identity's public code when an identity is held", async () => {
    personStatus.mockReset().mockResolvedValue({
      enrolled: false,
      identity_unlocked: false,
      person_id_hex: null,
      identity_code: "MYNE-PERSON-1:abc",
      sealed_keypair_present: true,
    });
    render(<IdentitySetupDialog open onClose={() => {}} />);

    const code = (await screen.findByTestId("identity-setup.held-code")) as HTMLInputElement;
    expect(code.value).toBe("MYNE-PERSON-1:abc");
  });

  // The stale-probe path: the backend still holds an identity even though the
  // status read said otherwise, so the typed error must reveal the forget path.
  it("reveals the forget path when the backend reports a held identity", async () => {
    personSetup.mockReset().mockRejectedValue({ kind: "AlreadyHeldIdentity" });
    render(<IdentitySetupDialog open onClose={() => {}} />);

    fireEvent.click(await screen.findByTestId("identity-setup.create-cta"));
    await screen.findByTestId("identity-setup.error");
    expect(screen.getByTestId("identity-setup.forget-cta")).toBeTruthy();
  });
});
