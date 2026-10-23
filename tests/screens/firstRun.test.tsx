// @vitest-environment jsdom

// The first run is the identity, then the vault (myne-md/myne#911 task 6).
//
// What this guards, in the order the user meets it:
//
//  1. ONE phrase ceremony. The identity's 24 words are shown once, the screen
//     offers one save action for them, and the type-back is the only door
//     forward. A second kit on the vault that follows is the failure: it would
//     ask the user to keep a phrase that the vault does not have.
//  2. The phrase ceremony is the identity's, and it is the thing the type-back
//     gates. "Continue" is disabled until the words have been revealed, exactly
//     as the modal's ceremony is, because the surface moved rather than changed.
//  3. Leaving is not cancelling. `onAbandon` fires; nothing here resets or
//     deletes an identity that already exists on disk.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const personSetup = vi.hoisted(() => vi.fn());
const personStatus = vi.hoisted(() => vi.fn());
const personLock = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock("../../src/lib/personAccount", () => ({ personSetup, personStatus }));
vi.mock("../../src/lib/invite", () => ({ personLock }));
vi.mock("../../src/platform/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));

import { FirstRun } from "../../src/screens/FirstRun";

const PHRASE = Array.from({ length: 24 }, (_, i) => `word${i + 1}`);

beforeEach(() => {
  personSetup.mockReset().mockResolvedValue({
    phrase: PHRASE.join(" "),
    fingerprint_hex: "f",
    person_id_hex: "p",
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
});

afterEach(() => cleanup());

describe("FirstRun", () => {
  it("shows the identity ceremony, not a vault one", async () => {
    render(<FirstRun onIdentityCreated={() => {}} onAbandon={() => {}} />);
    // The panel is mounted with the first run's own testid prefix, so a
    // selector written for the Settings dialog cannot silently pass here.
    expect(await screen.findByTestId("first-run.identity.create-cta")).toBeTruthy();
    expect(screen.queryByTestId("identity-setup.create-cta")).toBeNull();
    expect(screen.queryByTestId("create.phrase-grid")).toBeNull();
  });

  it("walks one phrase, one save action and one type-back, then hands off to the vault", async () => {
    const onIdentityCreated = vi.fn();
    render(<FirstRun onIdentityCreated={onIdentityCreated} onAbandon={() => {}} />);

    fireEvent.click(await screen.findByTestId("first-run.identity.create-cta"));

    // Step 1: the phrase. Continue is gated on the words having been shown,
    // and the screen carries exactly one save action for them.
    const cont = (await screen.findByTestId(
      "first-run.identity.phrase-continue",
    )) as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    expect(await screen.findByTestId("first-run.identity.phrase-save")).toBeTruthy();
    fireEvent.click(screen.getByTestId("first-run.identity.phrase-reveal"));
    await waitFor(() => expect(cont.disabled).toBe(false));
    fireEvent.click(cont);

    // Step 2: the type-back. It is the only way to the hand-off.
    const cells = await screen.findAllByTestId("first-run.identity.confirm-input");
    expect(cells.length).toBe(4);
    const done = (await screen.findByTestId(
      "first-run.identity.close-cta",
    )) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    for (const cell of cells) {
      const pos = Number(await cell.getAttribute("data-index"));
      fireEvent.change(cell, { target: { value: PHRASE[pos - 1] } });
    }
    await waitFor(() => expect(done.disabled).toBe(false));
    fireEvent.click(done);

    expect(onIdentityCreated).toHaveBeenCalledTimes(1);
  });

  it("leaves without cancelling: abandoning fires the host's exit", async () => {
    const onAbandon = vi.fn();
    render(<FirstRun onIdentityCreated={() => {}} onAbandon={onAbandon} />);
    fireEvent.click(await screen.findByTestId("first-run.identity.cancel"));
    expect(onAbandon).toHaveBeenCalledTimes(1);
    // Nothing was created, so no ceremony ran and no setup call was spent.
    expect(personSetup).not.toHaveBeenCalled();
  });
});
