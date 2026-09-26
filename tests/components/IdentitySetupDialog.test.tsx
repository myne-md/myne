// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const personSetup = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock("../../src/lib/personAccount", () => ({
  personSetup,
}));

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

  it("fronts the first-run server step when no endpoint is configured", async () => {
    invoke.mockReset().mockResolvedValue({ endpoint_url: null });
    render(<IdentitySetupDialog open onClose={() => {}} />);

    const step = await screen.findByTestId("first-run-server.root");
    expect(step).toBeTruthy();
    // The identity form is not reachable until a server is configured.
    expect(screen.queryByTestId("identity-setup.create-cta")).toBeNull();
    expect(screen.getByTestId("first-run-server.continue").hasAttribute("disabled")).toBe(true);
  });
});
