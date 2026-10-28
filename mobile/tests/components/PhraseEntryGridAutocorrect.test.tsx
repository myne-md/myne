// @vitest-environment jsdom
//
// The mobile phrase grid's input attributes (myne-md/myne#932).
//
// # The defect this pins
//
// `spellCheck={false}` does not suppress iOS autocorrect. The attribute that does
// is `autoCorrect`, and it was missing from the shared mobile `TextField`, which
// backs every phrase grid on this client. On a device the keyboard can therefore
// substitute a word inside a cell silently, and the only visible consequence is
// that the phrase is refused, which reads as "my words are wrong".
//
// The desktop grid has set `autoCorrect="off"` since it shipped
// (`src/components/PhraseEntryGrid.tsx`), and the other mobile secret fields set
// it one by one, so this is a gap rather than a decision. The assertion is on the
// rendered attribute because that is the thing the platform reads: a prop that
// stopped reaching the DOM would leave the behaviour gone and every other test in
// this file green.

import { cleanup, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PhraseEntryGrid } from "../../src/components/inputs";

describe("mobile PhraseEntryGrid", () => {
  it("turns autocorrect off on every phrase cell", () => {
    render(
      <PhraseEntryGrid
        cells={Array.from({ length: 24 }, () => "")}
        onCells={() => {}}
        testIdPrefix="test.phrase"
        cellLabel={(index) => `word ${index + 1}`}
        labelledBy="test-label"
      />,
    );
    try {
      const cells = screen.getAllByTestId("test.phrase-cell");
      expect(cells).toHaveLength(24);
      for (const cell of cells) {
        // React maps `autoCorrect` onto the `autocorrect` attribute.
        expect(cell.getAttribute("autocorrect")).toBe("off");
        // The weaker guard it used to rely on stays.
        expect(cell.getAttribute("spellcheck")).toBe("false");
      }
    } finally {
      cleanup();
    }
  });
});
