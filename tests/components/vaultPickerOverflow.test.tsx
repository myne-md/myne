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
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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

  it("bounds the centre column and makes the LIST the only scroller", async () => {
    // The screen is deboxed since myne-md/myne#773, so the bounded box is the
    // shell's centre column rather than a card — but the invariant is the one
    // that mattered before and the reason is unchanged: the vault count is
    // unbounded, nothing in the chain above scrolls, and a column that grows to
    // fit takes its overflow off the bottom of the window with it.
    const root = await renderPicker();
    const view = root.querySelector(".myne-auth-view") as HTMLElement;
    expect(view, "the shell's centre column is gone").not.toBeNull();
    expect(view.style.maxHeight).toBe("100%");
    // `min-height: auto` on a flex item refuses to shrink below its content, so
    // without this the maxHeight above has nothing to act on.
    expect(view.style.minHeight).toBe("0px");

    const list = screen.getAllByTestId("picker.vault-row")[0]!.parentElement!;
    expect(list.style.overflowY).toBe("auto");
    expect(list.style.minHeight).toBe("0px");
  });

  it("keeps the heading and the three actions out of the shrink", async () => {
    // If the chrome shrank too, a tall list would compress the heading and the
    // actions instead of scrolling, so the same rows are lost in a different
    // way. The three actions moved into the shell's top bar, which is where
    // they are now held out of the shrink — as a row, rather than one button at
    // a time. They must still be REACHABLE at any vault count, which is most of
    // what moving them out of the list's column bought.
    const root = await renderPicker();
    for (const testId of ["picker.create-cta", "picker.join-cta", "picker.restore-cta"]) {
      expect(screen.getByTestId(testId), `${testId} is gone`).toBeTruthy();
    }
    const header = root.querySelector("header") as HTMLElement;
    expect(header.style.flexShrink, "the top bar must not compress").toBe("0");
    // The actions row, not the button: an icon button that carries a tooltip is
    // wrapped by the tooltip's own span, so the button's parent is that wrapper
    // rather than the row. Reaching for the row by position says what is meant.
    const actions = header.lastElementChild as HTMLElement;
    expect(actions.contains(screen.getByTestId("picker.create-cta"))).toBe(true);
    expect(actions.style.flexShrink).toBe("0");
    // The heading's GROUP, not the `<h1>`. The title and its subtitle are one
    // block now (they were two siblings a section-gap apart), so the group is
    // the flex item the column sizes — `flex-shrink` on a child of it means
    // nothing, which is the same trap the Tooltip wrapper sprang one screen
    // over. The `<h1>` is asserted to be inside it, or "the group does not
    // shrink" would be true of a group that no longer holds the heading.
    const heading = screen.getByRole("heading");
    const group = heading.parentElement as HTMLElement;
    expect(group.style.flexDirection, "the heading is not in a group").toBe("column");
    expect(group.style.flexShrink).toBe("0");
    // And the pair really is tighter than the section gap it used to sit in.
    const subline = group.querySelector("p");
    expect(subline, "the subtitle left the group").not.toBeNull();
    expect(group.style.gap).toBe("var(--space-1)");
  });
});

describe("the row under the pointer wears the accent", () => {
  it("rings the hovered row in the accent, not a second grey", async () => {
    // The neutral `--line-1` → `--line-2` step it replaced was a change nobody
    // could see: two adjacent greys, on a 60px row, behind a fill that was also
    // changing. On this screen the row is the only thing to press.
    await renderPicker();
    const row = screen.getAllByTestId("picker.vault-row")[0]!;
    expect(row.style.border).toContain("var(--line-1)");

    fireEvent.mouseEnter(row);
    expect(row.style.border, "hover must reach for the accent").toContain(
      "var(--accent)",
    );
    expect(row.style.background).toContain("var(--accent-soft)");

    fireEvent.mouseLeave(row);
    expect(row.style.border).toContain("var(--line-1)");
  });

  it("does not change the row's geometry on hover", () => {
    // A box-shadow ring would change the row's optical size, and a 60px row in
    // a scrolling list would appear to breathe as the pointer ran down it. The
    // colour changes; the geometry does not.
    return renderPicker().then(() => {
      const row = screen.getAllByTestId("picker.vault-row")[0]!;
      const before = { h: row.style.height, p: row.style.padding, r: row.style.borderRadius };
      fireEvent.mouseEnter(row);
      expect(row.style.height).toBe(before.h);
      expect(row.style.padding).toBe(before.p);
      expect(row.style.borderRadius).toBe(before.r);
      expect(row.style.boxShadow, "a ring would resize the row").toBe("");
    });
  });
});
