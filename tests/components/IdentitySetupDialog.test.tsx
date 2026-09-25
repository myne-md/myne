// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const personSetup = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../src/lib/personAccount", () => ({
  personSetup,
}));

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
});

afterEach(() => cleanup());

describe("IdentitySetupDialog", () => {
  it("uses the 24-cell recovery credential and submits the joined phrase", async () => {
    const onCreated = vi.fn();
    render(<IdentitySetupDialog open onClose={() => {}} onCreated={onCreated} />);

    expect((screen.getByTestId("identity-setup.recover-cta") as HTMLButtonElement).disabled).toBe(
      true,
    );
    fillPhrase();
    expect((screen.getByTestId("identity-setup.recover-cta") as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByTestId("identity-setup.recover-cta"));

    await waitFor(() =>
      expect(personSetup).toHaveBeenCalledWith(
        Array.from({ length: PHRASE_CELL_COUNT }, (_, index) => `word${index + 1}`).join(" "),
      ),
    );
  });
});
