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
import { PHRASE_CELL_COUNT } from "../../src/components/sync/EnrollPhraseCredential";

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

  it("fronts the first-run server choice when no endpoint is configured", async () => {
    invoke.mockReset().mockResolvedValue({ endpoint_url: null });
    render(<IdentitySetupDialog open onClose={() => {}} />);

    const step = await screen.findByTestId("first-run-server.root");
    expect(step).toBeTruthy();
    // Both doors are offered, and the identity form is not reachable until a
    // server is configured.
    expect(screen.getByTestId("first-run-server.myne-sync")).toBeTruthy();
    expect(screen.getByTestId("first-run-server.self-hosted")).toBeTruthy();
    expect(screen.queryByTestId("identity-setup.create-cta")).toBeNull();
  });

  it("offers both server choices without Settings when a vault-less device has an old endpoint", async () => {
    render(<IdentitySetupDialog open onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("identity-setup.change-server"));

    expect(screen.getByTestId("first-run-server.myne-sync")).toBeTruthy();
    expect(screen.getByTestId("first-run-server.self-hosted")).toBeTruthy();
    expect(screen.queryByTestId("identity-setup.create-cta")).toBeNull();
    fireEvent.click(screen.getByTestId("first-run-server.self-hosted"));
    expect(await screen.findByTestId("sync.endpoint-config")).toBeTruthy();
    fireEvent.click(screen.getByTestId("first-run-server.back"));
    fireEvent.click(screen.getByTestId("first-run-server.back"));
    expect(screen.getByTestId("identity-setup.recover-cta")).toBeTruthy();
  });

  it("keeps a pin failure distinct and provides recovery from the identity form", async () => {
    personSetup.mockRejectedValue({ kind: "CertPinMismatch" });
    render(<IdentitySetupDialog open onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("identity-setup.create-cta"));

    expect((await screen.findByTestId("identity-setup.error")).textContent).toBe(
      "identitySetup.errorCertPinMismatch",
    );
    fireEvent.click(screen.getByTestId("identity-setup.change-server"));
    expect(screen.getByTestId("first-run-server.myne-sync")).toBeTruthy();
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
