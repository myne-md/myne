// @vitest-environment jsdom
//
// The identity phrase's type-back on the phone (myne-md/myne#855). The rule is
// `phraseChallenge`'s, tested on its own; what is under test HERE is the WIRING:
// the flow draws a challenge, renders one field per requested position, and does
// not let Continue through until all four are right and the phrase has been
// revealed. Before this change the only gate was an acknowledgement checkbox, so
// a user who never wrote the phrase down had no signal until they lost the
// device, and an identity cannot be recovered without it.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const personSetup = vi.hoisted(() => vi.fn());
const personStatus = vi.hoisted(() => vi.fn());
const personListInvites = vi.hoisted(() => vi.fn());
const personLock = vi.hoisted(() => vi.fn());
const syncSetEndpoint = vi.hoisted(() => vi.fn());

vi.mock("../../src/lib/app-window", () => ({ HAS_TAURI: true }));
vi.mock("../../src/lib/personAccount", () => ({
  personSetup,
  personStatus,
  personListInvites,
  personLock,
}));
vi.mock("../../src/lib/sync", () => ({ syncSetEndpoint }));

import { IdentityFlow } from "../../src/app/flows/IdentityFlow";

// A fixed 24-word phrase, so the answers are known while the positions stay
// random. BIP-39 words, in order.
const PHRASE = [
  "abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract",
  "absurd", "abuse", "access", "accident", "account", "accuse", "achieve", "acid",
  "acoustic", "acquire", "across", "act", "action", "actor", "actress", "actual",
];

beforeEach(() => {
  personSetup.mockReset().mockResolvedValue({
    phrase: PHRASE.join(" "),
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
  personListInvites.mockReset().mockResolvedValue([]);
  personLock.mockReset().mockResolvedValue(undefined);
  syncSetEndpoint.mockReset().mockResolvedValue(undefined);
});

afterEach(() => cleanup());

/** Walk gate -> server -> create, and land on the phrase step. */
async function reachPhrase(reveal: boolean): Promise<void> {
  render(<IdentityFlow onCancel={() => {}} />);
  fireEvent.click(await screen.findByTestId("identity-flow.start"));
  fireEvent.click(await screen.findByTestId("identity-flow.server-myne-sync"));
  fireEvent.click(await screen.findByTestId("identity-flow.create"));
  await screen.findByTestId("identity-flow.phrase-reveal");
  if (reveal) fireEvent.click(screen.getByTestId("identity-flow.phrase-reveal"));
}

/** The four challenge inputs (the mismatch lines are divs, so this misses them). */
function inputs(): HTMLInputElement[] {
  return Array.from(
    document.querySelectorAll<HTMLInputElement>('input[data-testid^="identity-flow.typeback-"]'),
  );
}

/** The 0-based phrase index a field asks for, read off its own testid. */
function position(el: HTMLInputElement): number {
  const id = el.getAttribute("data-testid") ?? "";
  return Number(id.replace("identity-flow.typeback-", "")) - 1;
}

function continueCta(): HTMLButtonElement {
  return screen.getByTestId("identity-flow.phrase-continue") as HTMLButtonElement;
}

describe("IdentityFlow phrase type-back (myne-md/myne#855)", () => {
  it("draws four fields and gates Continue on all four", async () => {
    await reachPhrase(true);
    const fields = inputs();
    expect(fields).toHaveLength(4);
    // Nothing typed: blocked.
    expect(continueCta().disabled).toBe(true);

    // Three of four: still blocked.
    for (const el of fields.slice(0, 3)) {
      fireEvent.change(el, { target: { value: PHRASE[position(el)] } });
    }
    expect(continueCta().disabled).toBe(true);

    // The fourth unlocks it.
    fireEvent.change(fields[3], { target: { value: PHRASE[position(fields[3])] } });
    expect(continueCta().disabled).toBe(false);
  });

  it("refuses Continue while the phrase is still hidden", async () => {
    await reachPhrase(false);
    for (const el of inputs()) {
      fireEvent.change(el, { target: { value: PHRASE[position(el)] } });
    }
    // Every word is right and it is STILL blocked: the challenge is unanswerable
    // without looking at the phrase.
    expect(continueCta().disabled).toBe(true);
  });

  it("marks a wrong word inline and keeps Continue blocked", async () => {
    await reachPhrase(true);
    const fields = inputs();
    for (const el of fields) {
      fireEvent.change(el, { target: { value: PHRASE[position(el)] } });
    }
    expect(continueCta().disabled).toBe(false);

    const first = fields[0];
    fireEvent.change(first, { target: { value: "zoo" } });

    const errors = document.querySelectorAll('[data-testid^="identity-flow.typeback-error-"]');
    expect(errors).toHaveLength(1);
    expect(continueCta().disabled).toBe(true);
  });
});
