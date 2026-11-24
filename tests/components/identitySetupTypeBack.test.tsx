// @vitest-environment jsdom
//
// The identity phrase's type-back challenge (myne-md/myne#855) and the two-step
// ceremony that owns it (myne-md/myne#869). Before #855 the identity dialog's
// Done was the ONLY signal that the user had saved the phrase, so a user who
// never wrote it down had none until the day they lost the device, and an
// identity cannot be recovered without it. `docs/spec/protocol.md` section 7.1.3
// requires the demonstration for the vault phrase; this gives the identity
// phrase the same one (`decisions/ui/0665`, superseding that clause of
// 0615).
//
// #869 is the part these tests exist for now: the phrase and the challenge are
// SEPARATE steps (the vault flow's kit/typeback split), and the dialog REFUSES
// dismissal (Esc, backdrop, ×) until the four words match. On the old single
// screen a backdrop click was a free exit from the one surface where the phrase
// is shown once, and the challenge could not gate a door it did not own.
//
// The challenge draws four positions at random, so these read the positions off
// the rendered fields rather than hardcoding them, which is also what makes the
// test survive a change to the draw.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const personSetup = vi.hoisted(() => vi.fn());
const personStatus = vi.hoisted(() => vi.fn());
const personLock = vi.hoisted(() => vi.fn());
const invoke = vi.hoisted(() => vi.fn());
const onClose = vi.hoisted(() => vi.fn());

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
  onClose.mockReset();
});

afterEach(() => cleanup());

/** Walk Create → reveal the phrase → Continue, and land on the challenge. */
async function createIdentity(): Promise<void> {
  render(<IdentitySetupDialog open onClose={onClose} />);
  fireEvent.click(await screen.findByTestId("identity-setup.create-cta"));
  fireEvent.click(await screen.findByTestId("identity-setup.phrase-reveal"));
  fireEvent.click(screen.getByTestId("identity-setup.phrase-continue"));
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

/** Esc is the ModalShell's window-level listener, the same one a user hits. */
function pressEscape(): void {
  fireEvent.keyDown(window, { key: "Escape" });
}

/** The backdrop IS the dialog root; a real backdrop click targets it directly. */
function clickBackdrop(): void {
  fireEvent.click(screen.getByTestId("identity-setup.root"));
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

describe("IdentitySetupDialog two-step ceremony (myne-md/myne#869)", () => {
  it("keeps the phrase and the challenge on separate steps", async () => {
    render(<IdentitySetupDialog open onClose={onClose} />);
    fireEvent.click(await screen.findByTestId("identity-setup.create-cta"));

    // Step one: the grid, and no challenge fields anywhere.
    await screen.findByTestId("identity-setup.phrase-reveal");
    expect(screen.queryAllByTestId("identity-setup.confirm-input")).toHaveLength(0);

    // Continue needs the phrase REVEALED, not merely present: a user who has
    // not looked at the words has nothing to continue with.
    const cont = screen.getByTestId("identity-setup.phrase-continue") as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("identity-setup.phrase-reveal"));
    expect(cont.disabled).toBe(false);

    fireEvent.click(cont);
    // Step two: the four fields, and the grid gone.
    expect(await screen.findAllByTestId("identity-setup.confirm-input")).toHaveLength(4);
    expect(screen.queryAllByTestId("identity-setup.phrase-word")).toHaveLength(0);
  });

  it("returns to the phrase step on Back, still revealed and keeping the answers", async () => {
    await createIdentity();
    const pos = positions();
    answer((p) => PHRASE[p - 1], pos.slice(0, 2));

    fireEvent.click(screen.getByTestId("identity-setup.confirm-back"));
    // The grid is back WITHOUT a second reveal click, and Continue is usable:
    // one reveal per ceremony is the point of keeping the local reveal state.
    expect(screen.getAllByTestId("identity-setup.phrase-word").length).toBeGreaterThan(0);
    expect((screen.getByTestId("identity-setup.phrase-continue") as HTMLButtonElement).disabled).toBe(
      false,
    );

    fireEvent.click(screen.getByTestId("identity-setup.phrase-continue"));
    // The two typed words survived the round trip.
    const typed = fields().filter((el) => (el as HTMLInputElement).value.length > 0);
    expect(typed).toHaveLength(2);
  });

  it("refuses all three dismissal routes while the challenge is unanswered", async () => {
    await createIdentity();
    // Nothing typed: the ceremony is pending.
    expect(screen.queryByTestId("identity-setup.root-close")).toBeNull();
    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    clickBackdrop();
    expect(onClose).not.toHaveBeenCalled();

    // Three of four is still pending, so the gate is the words, not a click.
    const pos = positions();
    answer((p) => PHRASE[p - 1], pos.slice(0, 3));
    expect(screen.queryByTestId("identity-setup.root-close")).toBeNull();
    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    clickBackdrop();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("refuses dismissal on the phrase step too, before Continue", async () => {
    render(<IdentitySetupDialog open onClose={onClose} />);
    fireEvent.click(await screen.findByTestId("identity-setup.create-cta"));
    await screen.findByTestId("identity-setup.phrase-reveal");

    // The phrase is on screen and unrevealed; Esc and the backdrop are shut.
    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    clickBackdrop();
    expect(onClose).not.toHaveBeenCalled();
    // The × goes a frame later than the phrase: a parent renders before its
    // children, so the frame cannot see the panel's own facts in the commit
    // that mounts them. AWAITED rather than asserted synchronously, and the
    // refusal does not depend on it: `IdentitySetupDialog.close` re-checks the
    // live gate, so a click in that frame is a no-op rather than an escape.
    await waitFor(() => expect(screen.queryByTestId("identity-setup.root-close")).toBeNull());

    // Revealing the words does not open the door either. Only the four
    // matching words do (myne-md/myne#855's demonstration, #869's gate).
    fireEvent.click(screen.getByTestId("identity-setup.phrase-reveal"));
    pressEscape();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("reopens every dismissal route once the four words match", async () => {
    await createIdentity();
    answer((p) => PHRASE[p - 1]);

    // The challenge is satisfied: the × is back and Esc closes.
    const closeBtn = screen.getByTestId("identity-setup.root-close");
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);

    // …and the × itself is a route too.
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("draws no challenge for a recovered identity and dismisses as before", async () => {
    // A recover call answers with no `phrase` (the user typed all 24 words, which
    // already IS the demonstration), so no positions are drawn and the dialog
    // must keep its ordinary dismissal instead of blocking forever.
    personSetup.mockResolvedValue({
      phrase: null,
      fingerprint_hex: "fingerprint",
      person_id_hex: "person",
      identity_code: "code",
      approved: true,
    });
    render(<IdentitySetupDialog open onClose={onClose} />);
    fireEvent.click(await screen.findByTestId("identity-setup.recover-open"));
    const cells = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[data-testid^="identity-setup.phrase-"]'),
    );
    expect(cells).toHaveLength(24);
    for (const el of cells) {
      fireEvent.change(el, { target: { value: PHRASE[Number(el.getAttribute("data-index")) - 1] } });
    }
    fireEvent.click(screen.getByTestId("identity-setup.recover-cta"));

    await screen.findByText("identitySetup.recovered");
    expect(screen.queryAllByTestId("identity-setup.confirm-input")).toHaveLength(0);
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
