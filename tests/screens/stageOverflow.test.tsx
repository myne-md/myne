// @vitest-environment jsdom
//
// The two stages that got `stageRootStyle` and no scroll region with it
// (myne-md/myne#565's review, under myne-md/myne#520's branch).
//
// `stageRootStyle` replaced `min-height: 100vh` with `flex: 1; min-height: 0`
// on seven stages. That is the fix: a 100vh child inside App's shortened column
// is 38px taller than its box. But the two shapes behave differently when the
// content does not fit. The old root GREW, so overflow ran off the bottom only
// and the top of the step stayed on screen. The new one is capped, and
// `alignItems: center` then pushes a too-tall child out of BOTH ends, so a
// short window takes the heading and the primary button away together.
//
// `CenteredCard` and `VaultPicker` were given the scroll region in the same
// change; these two were not, and they are the tallest surfaces in the tree:
// the 24-cell recovery-phrase ENTRY grid is the screen a user with nothing but
// their phrase has to complete, and the vault-creation steps carry the phrase
// display and the password reset.
//
// jsdom has no layout, so what is pinned is the declarations that decide the
// outcome, the same way `centeredCardOverflow.test.tsx` pins its primitive.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StepLayout } from "../../src/screens/vault-creation/step-shell";
import { PhraseEntryStep } from "../../src/screens/vault-recover/PhraseEntryStep";
import { initialState } from "../../src/screens/vault-recover/reducer";

afterEach(cleanup);

/** The declarations a bounded root needs on the child it centres. */
function expectScrollable(el: HTMLElement, label: string): void {
  expect(el.style.overflowY, `${label}: must scroll`).toBe("auto");
  expect(el.style.maxHeight, `${label}: must be bounded by the root`).toBe("100%");
  // `min-height: 0` is what lets a flex child shrink below its content height.
  // Without it the two above are inert: the child keeps its full height and
  // overflows the capped root anyway.
  expect(el.style.minHeight, `${label}: must be allowed to shrink`).toBe("0px");
}

describe("StepLayout, the vault-creation stage envelope", () => {
  it("centres its column inside a bounded root, and lets that column scroll", () => {
    render(
      <StepLayout>
        <p data-testid="probe">content</p>
      </StepLayout>,
    );
    const column = screen.getByTestId("probe").parentElement as HTMLElement;
    const root = column.parentElement as HTMLElement;
    // The root is bounded, which is the change that made this necessary.
    expect(root.style.flexGrow).toBe("1");
    expect(root.style.minHeight).toBe("0px");
    expectScrollable(column, "StepLayout column");
  });
});

describe("PhraseEntryStep, the 24-cell recovery grid", () => {
  it("bounds its card and lets it scroll", () => {
    render(
      <PhraseEntryStep
        state={initialState("phrase")}
        dispatch={vi.fn()}
        onCancel={() => {}}
        onSubmitNormalizedPhrase={vi.fn()}
      />,
    );
    // The 24 cells are inside the card, so the grid's grandparent is it. Read
    // through the DOM rather than a testid: the point is the CARD's style, and
    // adding a testid for a jsdom probe would put a test hook in production.
    const cell = screen.getAllByRole("textbox")[0] as HTMLElement;
    let card: HTMLElement | null = cell;
    while (card !== null && card.style.maxWidth !== "600px") card = card.parentElement;
    if (card === null) throw new Error("PhraseEntryStep card not found from a cell");
    expectScrollable(card, "PhraseEntryStep card");
  });
});
