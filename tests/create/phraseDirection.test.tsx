// @vitest-environment jsdom
//
// The phrase reads left-to-right even when the page does not (myne-md/myne#468).
//
// This is a correctness fix, not typography. The ORDER of the 24 words is part
// of the secret; `recovery-flow.md` §2.4 is a no-re-display commitment, so the
// user sees them once. Under an RTL locale a grid laid out in the locale's
// direction presents column-major order right-to-left, and a user transcribing
// what they see writes down a permutation — which BIP-39's checksum does not
// catch, because a permutation of a valid phrase can itself be valid. The
// failure surfaces months later as "my recovery phrase does not work", with
// nothing left to compare against.
//
// The same argument covers the type-back inputs: a field in the locale's
// direction puts the caret and the rendered word on the opposite side from where
// the grid showed it, on the one screen whose whole job is to catch a
// transcription error.
//
// The PAGE stays in the locale's direction. Pinning the document would be a
// different bug wearing this fix's clothes.

import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import i18n from "../../src/i18n";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}));

import { PhraseGrid } from "../../src/components/PhraseGrid";
import { ConfirmStep } from "../../src/screens/vault-creation/ConfirmStep";

const PHRASE = Array.from({ length: 24 }, (_, i) => `word${i + 1}`);
let previous: string;

beforeAll(async () => {
  previous = i18n.language;
  // Arabic: a shipped RTL locale. The catalog need not be complete — English
  // falls back — because what is under test is direction, not translation.
  await i18n.changeLanguage("ar");
});

afterAll(async () => {
  await i18n.changeLanguage(previous);
});

afterEach(cleanup);

describe("under an RTL locale", () => {
  it("the phrase grid is pinned left-to-right", () => {
    render(
      <PhraseGrid
        phrase={PHRASE}
        revealed={true}
        onReveal={() => {}}
        onHide={() => {}}
        testIdPrefix="x.phrase"
      />,
    );
    expect(screen.getByTestId("x.phrase-grid").getAttribute("dir")).toBe("ltr");
  });

  it("every type-back input is pinned left-to-right", () => {
    render(
      <ConfirmStep
        phrase={PHRASE}
        positions={[3, 10, 14, 21]}
        inputs={{}}
        committing={false}
        error={null}
        dispatch={() => {}}
      />,
    );
    const fields = screen.getAllByTestId("create.confirm-input");
    expect(fields.length).toBe(4);
    for (const field of fields) {
      expect(
        field.getAttribute("dir"),
        `word ${field.getAttribute("data-index")} follows the locale`,
      ).toBe("ltr");
    }
  });

  it("pins the grid and the fields, NOT the page", () => {
    // The whole screen mirroring would be a different defect. Nothing in the
    // creation flow writes `dir` on the document, and this asserts it stays that
    // way: a blanket `dir="ltr"` on the step layout would satisfy the two tests
    // above and break every Arabic sentence on the screen.
    render(
      <ConfirmStep
        phrase={PHRASE}
        positions={[1, 9, 12, 20]}
        inputs={{}}
        committing={false}
        error={null}
        dispatch={() => {}}
      />,
    );
    // `<html dir>` follows the locale, set by i18n's language-change side effect
    // (`src/i18n/index.ts`), which is what makes the page mirror at all. So the
    // rule is not "nothing sets a direction" — it is that nothing between the
    // heading and that root overrides it back to `ltr`.
    expect(
      document.documentElement.getAttribute("dir"),
      "the page did not follow the RTL locale, so there is nothing to protect",
    ).toBe("rtl");
    const heading = screen.getByText(i18n.t("vaultCreation.confirm.heading"));
    for (
      let el: HTMLElement | null = heading;
      el && el !== document.documentElement;
      el = el.parentElement
    ) {
      expect(
        el.getAttribute("dir"),
        "an ancestor of the heading pins the page left-to-right",
      ).not.toBe("ltr");
    }
  });
});
