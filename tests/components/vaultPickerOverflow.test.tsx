// @vitest-environment jsdom
//
// myne-md/myne#565: a long vault list must scroll INSIDE the card, not push the
// card off the window.
//
// The vault count is unbounded and this is a pre-unlock surface, so the failure
// is not a cosmetic overflow: once the card outgrows the viewport there is no
// scroll anywhere in the chain, and every row past the fold plus all three
// footer actions become unreachable with no way to get at them.
//
// jsdom has no layout, so this cannot measure the overflow. What it CAN pin is
// the three declarations that decide it, each of which was absent:
//
//   1. the root is not a fixed `100vh` box inside App's already-shortened column
//   2. the card is bounded by the height it was given
//   3. the LIST is the scroller, and the chrome around it does not shrink
//
// Two of the three are silently useless without the third, which is why they are
// asserted together rather than one per test.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const listVaults = vi.fn();

vi.mock("../../src/lib/vault-list", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/vault-list")>(
    "../../src/lib/vault-list",
  );
  return { ...actual, listVaults: (...a: unknown[]) => listVaults(...a) };
});

import { VaultPicker } from "../../src/screens/VaultPicker";
import type { VaultSummary } from "../../src/types/vault-summary";

afterEach(() => {
  cleanup();
  listVaults.mockReset();
});

const MANY: VaultSummary[] = Array.from({ length: 24 }, (_, i) => ({
  id: `v${i}`,
  label: `Vault ${i}`,
  icon: null,
  last_unlock: 1000 + i,
  status: { kind: "Exists" } as const,
}));

async function renderPicker() {
  listVaults.mockResolvedValue({ ok: MANY });
  render(
    <VaultPicker
      onSelect={() => {}}
      onCreateAnother={() => {}}
      onRestoreBackup={() => {}}
      onJoinDevice={() => {}}
    />,
  );
  await waitFor(() => expect(screen.getAllByTestId("picker.vault-row").length).toBe(24));
  return screen.getByTestId("picker.root");
}

describe("VaultPicker at a vault count that overflows the window", () => {
  it("does not force a 100vh root inside App's shortened column", () => {
    // App.tsx renders this BELOW a 38px window-drag strip, inside a
    // `flex: 1 / minHeight: 0` column. A 100vh child there is 38px taller than
    // the box it sits in, nothing in the chain scrolls, and centring inside the
    // over-tall box drops the card half that distance below the optical centre.
    return renderPicker().then((root) => {
      expect(root.style.minHeight).not.toBe("100vh");
      expect(root.style.flexGrow).toBe("1");
      expect(root.style.minHeight).toBe("0px");
    });
  });

  it("bounds the card and makes the LIST the only scroller", async () => {
    const root = await renderPicker();
    const card = root.firstElementChild as HTMLElement;
    expect(card.style.maxHeight).toBe("100%");
    // `min-height: auto` on a flex item refuses to shrink below its content, so
    // without this the maxHeight above has nothing to act on.
    expect(card.style.minHeight).toBe("0px");

    const list = screen.getAllByTestId("picker.vault-row")[0]!.parentElement!;
    expect(list.style.overflowY).toBe("auto");
    expect(list.style.minHeight).toBe("0px");
  });

  it("keeps the heading and the three actions out of the shrink", async () => {
    // If the chrome shrank too, a tall list would compress the heading and the
    // footer instead of scrolling, so the same rows are lost in a different way.
    await renderPicker();
    for (const testId of ["picker.create-cta", "picker.join-cta", "picker.restore-cta"]) {
      expect(screen.getByTestId(testId).style.flexShrink).toBe("0");
    }
    expect(screen.getByRole("heading").style.flexShrink).toBe("0");
  });
});
