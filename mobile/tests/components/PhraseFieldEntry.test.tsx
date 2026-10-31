// @vitest-environment jsdom
//
// The single-field phrase entry (myne-md/myne#945 item 02).
//
// The 24-box grid is the right shape for CHECKING a phrase against a written
// copy and the wrong shape for entering one the user already holds as a string:
// on a phone it is a screen and a half of boxes, and word 14 is off screen. The
// owner's report is the screenshot; what this file pins is the behaviour the
// replacement has to have, which the grid got for free from having one input per
// word:
//
//  * the SPACE the user types between two words survives, because the field owns
//    its text and reports words upward. Deriving the text from the caller's words
//    would delete the separator on every keystroke and concatenate word two onto
//    word one, and the result would still be "24 words" to a naive counter;
//  * the count is reported, because that is the only feedback that a phrase is
//    complete once the cells are gone;
//  * a caller that REPLACES the words from outside (a step re-entry, an error
//    reset) is followed, because otherwise the box shows text the caller has
//    already discarded.

import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// `t` echoes its key and the values it was given, which is how every component
// spec in this tree reads copy without a translator: the ASSERTION is about the
// count reaching the sentence, and the sentence itself is asserted against the
// English catalog below (`PhraseEntryGridAutocorrect.test.tsx` establishes the
// pattern, `IdentityFlowJoin.test.tsx` the mock).
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      `${key}|${Object.entries(vars ?? {})
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(",")}`,
  }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

import enCatalog from "@myne/locales-en";
import { PhraseEntryGrid } from "../../src/components/inputs";

const EN_CATALOG = enCatalog as Record<string, unknown>;

function localeValue(key: string): unknown {
  let node: unknown = EN_CATALOG;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null || !(part in node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

const WORDS = Array.from({ length: 24 }, (_, i) => `word${i + 1}`);

function renderField(cells: string[], onCells: (next: string[]) => void) {
  render(
    <PhraseEntryGrid
      cells={cells}
      onCells={onCells}
      testIdPrefix="test.phrase"
      cellLabel={(index) => `word ${index + 1}`}
      labelledBy="test-label"
      layout="field"
    />,
  );
  return screen.getByTestId("test.phrase-cell") as HTMLTextAreaElement;
}

describe("PhraseEntryGrid layout=field", () => {
  it("has an English sentence behind the count", () => {
    // A key with no English value renders as the key in the product, and the
    // component spec above would still pass because the mock echoes whatever it
    // is handed.
    const value = localeValue("common.phraseWordsProgress");
    expect(typeof value).toBe("string");
    expect(value).toContain("{{filled}}");
    expect(value).toContain("{{total}}");
  });

  it("splits the whole phrase into the caller's words", () => {
    const onCells = vi.fn();
    try {
      const field = renderField(Array.from({ length: 24 }, () => ""), onCells);
      fireEvent.change(field, { target: { value: "ribbon kernel voyage" } });
      expect(onCells).toHaveBeenCalledTimes(1);
      const next = onCells.mock.calls[0]![0] as string[];
      expect(next.slice(0, 3)).toEqual(["ribbon", "kernel", "voyage"]);
      // Padded, not truncated: the caller's gate is `every(word is non-empty)`.
      expect(next).toHaveLength(24);
      expect(next[3]).toBe("");
    } finally {
      cleanup();
    }
  });

  it("keeps the space the user is typing between two words", () => {
    // The regression this design exists for: a value derived from the words
    // would render "ribbon" back after the space and the next keystroke would
    // produce "ribbonk". The caller ECHOES, as both real callers do, so this is
    // the shape the app actually has.
    try {
      function Harness() {
        const [cells, setCells] = useState<string[]>(Array.from({ length: 24 }, () => ""));
        return (
          <PhraseEntryGrid
            cells={cells}
            onCells={setCells}
            testIdPrefix="test.phrase"
            cellLabel={(index) => `word ${index + 1}`}
            labelledBy="test-label"
            layout="field"
          />
        );
      }
      render(<Harness />);
      fireEvent.change(screen.getByTestId("test.phrase-cell"), {
        target: { value: "ribbon " },
      });
      const field = screen.getByTestId("test.phrase-cell") as HTMLTextAreaElement;
      expect(field.value).toBe("ribbon ");
      // And the next word lands beside it rather than inside it.
      fireEvent.change(field, { target: { value: "ribbon kernel" } });
      expect((screen.getByTestId("test.phrase-cell") as HTMLTextAreaElement).value).toBe(
        "ribbon kernel",
      );
    } finally {
      cleanup();
    }
  });

  it("counts the words it holds", () => {
    try {
      function Harness() {
        const [cells, setCells] = useState<string[]>(Array.from({ length: 24 }, () => ""));
        return (
          <PhraseEntryGrid
            cells={cells}
            onCells={setCells}
            testIdPrefix="test.phrase"
            cellLabel={(index) => `word ${index + 1}`}
            labelledBy="test-label"
            layout="field"
          />
        );
      }
      render(<Harness />);
      const count = () => screen.getByTestId("test.phrase-count").textContent;
      expect(count()).toBe("common.phraseWordsProgress|filled=0,total=24");
      fireEvent.change(screen.getByTestId("test.phrase-cell"), {
        target: { value: WORDS.slice(0, 5).join(" ") },
      });
      expect(count()).toBe("common.phraseWordsProgress|filled=5,total=24");
      fireEvent.change(screen.getByTestId("test.phrase-cell"), {
        target: { value: WORDS.join(" ") },
      });
      expect(count()).toBe("common.phraseWordsProgress|filled=24,total=24");
    } finally {
      cleanup();
    }
  });

  it("follows the caller when it replaces the words from outside", () => {
    try {
      // Rerendered with DIFFERENT cells rather than rendered once with the final
      // ones: the branch this pins is the one that adopts a replacement from the
      // caller, and a single render with the final value proves only that the
      // initial state was right (myne-md/myne#945 review, D9).
      const { rerender } = render(
        <PhraseEntryGrid
          cells={WORDS}
          onCells={() => {}}
          testIdPrefix="test.phrase"
          cellLabel={(index) => `word ${index + 1}`}
          labelledBy="test-label"
          layout="field"
        />,
      );
      expect((screen.getByTestId("test.phrase-cell") as HTMLTextAreaElement).value).toBe(
        WORDS.join(" "),
      );
      const replaced = WORDS.map((_, index) => (index === 0 ? "replaced" : ""));
      rerender(
        <PhraseEntryGrid
          cells={replaced}
          onCells={() => {}}
          testIdPrefix="test.phrase"
          cellLabel={(index) => `word ${index + 1}`}
          labelledBy="test-label"
          layout="field"
        />,
      );
      expect((screen.getByTestId("test.phrase-cell") as HTMLTextAreaElement).value).toBe(
        "replaced",
      );
      expect(screen.getByTestId("test.phrase-count").textContent).toBe(
        "common.phraseWordsProgress|filled=1,total=24",
      );
    } finally {
      cleanup();
    }
  });

  it("keeps the attributes that stop the keyboard rewriting a secret", () => {
    try {
      const field = renderField(Array.from({ length: 24 }, () => ""), () => {});
      // Same three as the grid's cells (myne-md/myne#932): `spellCheck` alone
      // does not stop iOS autocorrect, and a capitalised first letter changes
      // the phrase.
      expect(field.getAttribute("autocorrect")).toBe("off");
      expect(field.getAttribute("autocapitalize")).toBe("none");
      expect(field.getAttribute("spellcheck")).toBe("false");
      expect(field.getAttribute("dir")).toBe("ltr");
    } finally {
      cleanup();
    }
  });
});
