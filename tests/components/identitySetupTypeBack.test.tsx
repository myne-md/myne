// @vitest-environment jsdom
//
// The identity phrase's type-back challenge (myne-md/myne#855). Before it, the
// identity dialog's Done was the ONLY signal that the user had saved the phrase,
// so a user who never wrote it down had none until the day they lost the device,
// and an identity cannot be recovered without it. `docs/spec/protocol.md` section
// 7.1.3 requires the demonstration for the vault phrase; this gives the identity
// phrase the same one (`docs/decisions/ui/0665`, superseding that clause of 0615).
//
// The challenge draws four positions at random, so these read the positions off
// the rendered fields rather than hardcoding them, which is also what makes the
// test survive a change to the draw.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const personSetup = vi.hoisted(() => vi.fn());
const personStatus = vi.hoisted(() => vi.fn());
const personLock = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock("../../src/lib/personAccount", () => ({ personSetup, personStatus }));
vi.mock("../../src/lib/invite", () => ({ personLock }));
vi.mock("../../src/platform/core", () => ({ invoke }));

import { IdentitySetupDialog } from "../../src/components/IdentitySetupDialog";

// A fixed 24-word phrase (BIP-39 words, in order) so the challenge's answers are
// known while the positions stay random.
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
  personLock.mockReset().mockResolvedValue(undefined);
  invoke.mockReset().mockResolvedValue({ endpoint_url: "https://sync.example" });
});

afterEach(() => cleanup());

async function createIdentity(): Promise<void> {
  render(<IdentitySetupDialog open onClose={() => {}} />);
  fireEvent.click(await screen.findByTestId("identity-setup.create-cta"));
  // Four fields, so this cannot be findByTestId.
  await screen.findAllByTestId("identity-setup.confirm-input");
}

function fields(): HTMLElement[] {
  return screen.getAllByTestId("identity-setup.confirm-input");
}

function positions(): number[] {
  return fields().map((el) => Number(el.getAttribute("data-index")));
}

function doneCta(): HTMLButtonElement {
  return screen.getByTestId("identity-setup.close-cta") as HTMLButtonElement;
}

/** Answer every field from `wordAt`, or only those whose position is in `only`. */
function answer(wordAt: (pos: number) => string, only?: number[]): void {
  for (const el of fields()) {
    const pos = Number(el.getAttribute("data-index"));
    if (only && !only.includes(pos)) continue;
    fireEvent.change(el, { target: { value: wordAt(pos) } });
  }
}

describe("IdentitySetupDialog phrase type-back (myne-md/myne#855)", () => {
  it("gates Done on the four requested words, not on a click", async () => {
    await createIdentity();
    expect(fields()).toHaveLength(4);
    // Nothing typed yet: the commit is blocked.
    expect(doneCta().disabled).toBe(true);

    // Three of four answered is still blocked.
    const pos = positions();
    answer((p) => PHRASE[p - 1], pos.slice(0, 3));
    expect(doneCta().disabled).toBe(true);

    // The fourth unlocks it.
    answer((p) => PHRASE[p - 1], pos.slice(3));
    expect(doneCta().disabled).toBe(false);
  });

  it("shows an inline mismatch for a wrong word and keeps Done blocked", async () => {
    await createIdentity();
    answer((p) => PHRASE[p - 1]);
    expect(doneCta().disabled).toBe(false);

    // Answer the first field with a different valid word.
    const first = positions()[0];
    const field = fields().find((el) => Number(el.getAttribute("data-index")) === first);
    fireEvent.change(field as HTMLElement, { target: { value: "zoo" } });

    const errors = screen.getAllByTestId("identity-setup.confirm-error");
    expect(errors).toHaveLength(1);
    expect(errors[0].getAttribute("data-index")).toBe(String(first));
    expect(doneCta().disabled).toBe(true);
  });

  it("accepts a mixed-case, padded answer (NFKD + trim + lowercase)", async () => {
    await createIdentity();
    answer((p) => `  ${PHRASE[p - 1].toUpperCase()} `);
    expect(screen.queryAllByTestId("identity-setup.confirm-error")).toHaveLength(0);
    expect(doneCta().disabled).toBe(false);
  });
});
