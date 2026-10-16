// @vitest-environment jsdom
//
// The identity phrase's type-back on the phone (myne-md/myne#855), and the
// two-step ceremony that owns it (myne-md/myne#869). The rule is
// `phraseChallenge`'s, tested on its own; what is under test HERE is the WIRING:
// the phrase and the challenge are SEPARATE steps (the vault flow's kit/typeback
// split), Continue off the phrase step needs the words REVEALED, and the
// challenge's own Continue needs all four words right. Before #855 the only gate
// was an acknowledgement checkbox, so a user who never wrote the phrase down had
// no signal until they lost the device, and an identity cannot be recovered
// without it.

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
// `useTranslation` echoes keys, so the header's back chevron is reachable by the
// `common.back` KEY it labels itself with. The `initReactI18next` stub is not
// decoration: the flow reaches the shared `@myne/i18n` runtime transitively,
// whose module body calls `i18n.use(initReactI18next)`, and a mock without it
// throws on import. Same shape as `IdentityFlowAccept.test.tsx`.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

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
  fireEvent.change(await screen.findByTestId("identity-flow.server-input"), {
    target: { value: "https://sync.example" },
  });
  fireEvent.click(screen.getByTestId("identity-flow.server-connect"));
  fireEvent.click(await screen.findByTestId("identity-flow.create"));
  await screen.findByTestId("identity-flow.phrase-reveal");
  if (reveal) fireEvent.click(screen.getByTestId("identity-flow.phrase-reveal"));
}

/** …and on through the phrase step's Continue to the four-field challenge. */
async function reachTypeback(): Promise<void> {
  await reachPhrase(true);
  fireEvent.click(phraseContinue());
  await screen.findByTestId("identity-flow.typeback-continue");
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

/** The phrase step's Continue (reveal -> challenge). */
function phraseContinue(): HTMLButtonElement {
  return screen.getByTestId("identity-flow.phrase-continue") as HTMLButtonElement;
}

/** The challenge step's Continue (finishes the ceremony). */
function typebackContinue(): HTMLButtonElement {
  return screen.getByTestId("identity-flow.typeback-continue") as HTMLButtonElement;
}

describe("IdentityFlow phrase type-back (myne-md/myne#855)", () => {
  it("gates the phrase step's Continue on the reveal, and hides the challenge behind it", async () => {
    await reachPhrase(false);
    // Unrevealed: nothing to continue from, and no challenge to skip ahead to.
    expect(phraseContinue().disabled).toBe(true);
    expect(inputs()).toHaveLength(0);

    fireEvent.click(screen.getByTestId("identity-flow.phrase-reveal"));
    expect(phraseContinue().disabled).toBe(false);
  });

  it("keeps the phrase and the challenge on separate steps", async () => {
    await reachPhrase(true);
    // Step one: the grid, and no challenge anywhere.
    expect(screen.getByTestId("recovery-grid")).toBeTruthy();
    expect(inputs()).toHaveLength(0);

    fireEvent.click(phraseContinue());
    // Step two: four fields, and the grid gone.
    expect(await screen.findByTestId("identity-flow.typeback-continue")).toBeTruthy();
    expect(inputs()).toHaveLength(4);
    expect(screen.queryByTestId("recovery-grid")).toBeNull();
  });

  it("draws four fields and gates Continue on all four", async () => {
    await reachTypeback();
    const fields = inputs();
    expect(fields).toHaveLength(4);
    // Nothing typed: blocked.
    expect(typebackContinue().disabled).toBe(true);

    // Three of four: still blocked.
    for (const el of fields.slice(0, 3)) {
      fireEvent.change(el, { target: { value: PHRASE[position(el)] } });
    }
    expect(typebackContinue().disabled).toBe(true);

    // The fourth unlocks it.
    fireEvent.change(fields[3], { target: { value: PHRASE[position(fields[3])] } });
    expect(typebackContinue().disabled).toBe(false);
  });

  it("marks a wrong word inline and keeps Continue blocked", async () => {
    await reachTypeback();
    const fields = inputs();
    for (const el of fields) {
      fireEvent.change(el, { target: { value: PHRASE[position(el)] } });
    }
    expect(typebackContinue().disabled).toBe(false);

    const first = fields[0];
    fireEvent.change(first, { target: { value: "zoo" } });

    const errors = document.querySelectorAll('[data-testid^="identity-flow.typeback-error-"]');
    expect(errors).toHaveLength(1);
    expect(typebackContinue().disabled).toBe(true);
  });

  it("back-returns to the phrase still revealed and keeps the answers", async () => {
    await reachTypeback();
    const fields = inputs();
    fireEvent.change(fields[0], { target: { value: PHRASE[position(fields[0])] } });
    fireEvent.change(fields[1], { target: { value: PHRASE[position(fields[1])] } });

    // The header chevron (aria-label from `common.back`) is the only way back;
    // the phrase is NOT re-hidden, which is what makes one reveal enough.
    fireEvent.click(screen.getByLabelText("common.back"));
    expect(screen.getByTestId("recovery-grid")).toBeTruthy();
    expect(phraseContinue().disabled).toBe(false);

    // …and the two typed words survived the round trip.
    fireEvent.click(phraseContinue());
    expect(inputs().filter((el) => el.value.length > 0)).toHaveLength(2);
  });
});
