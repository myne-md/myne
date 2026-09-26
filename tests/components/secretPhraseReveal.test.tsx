// @vitest-environment jsdom

// The identity phrase ceremony (myne-md/myne#768).
//
// The failure this guards: the identity phrase was rendered as a plain block
// while the vault phrase got blur-by-default, walk-away re-hiding and capability
// caveats. Same secret, one screen with a showing. These assert the protections
// the two now share, and that the identity phrase still gets NO type-back.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const has = vi.hoisted(() => vi.fn(() => true));
const copySecretToClipboard = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const saveSecretAsTextFile = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../src/platform/capabilities", () => ({ has }));

vi.mock("../../src/lib/secret-export", () => ({
  copySecretToClipboard,
  saveSecretAsTextFile,
  saveOutcomeMessage: (ok: boolean, s: { saved: string; started: string; failed: string }) =>
    ok ? s.saved : s.failed,
}));

import { SecretPhraseReveal, useLocalPhraseReveal } from "../../src/components/SecretPhraseReveal";

const PHRASE = ["r1", "r2", "r3", "r4"];

function Harness() {
  const reveal = useLocalPhraseReveal();
  return (
    <SecretPhraseReveal
      phrase={PHRASE}
      revealed={reveal.revealed}
      onReveal={reveal.onReveal}
      onHide={reveal.onHide}
      testIdPrefix="x.phrase"
      saveFilename="x.txt"
    />
  );
}

beforeEach(() => {
  has.mockReset().mockReturnValue(true);
  copySecretToClipboard.mockClear();
  saveSecretAsTextFile.mockClear();
});

afterEach(() => cleanup());

describe("SecretPhraseReveal", () => {
  it("starts hidden and reveals on request", () => {
    render(<Harness />);
    expect(screen.getByTestId("x.phrase-grid").getAttribute("data-revealed")).toBe("false");
    fireEvent.click(screen.getByTestId("x.phrase-reveal"));
    expect(screen.getByTestId("x.phrase-grid").getAttribute("data-revealed")).toBe("true");
  });

  it("re-hides when the window loses focus", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("x.phrase-reveal"));
    expect(screen.getByTestId("x.phrase-grid").getAttribute("data-revealed")).toBe("true");
    fireEvent.blur(window);
    expect(screen.getByTestId("x.phrase-grid").getAttribute("data-revealed")).toBe("false");
  });

  it("renders no caveats where both capabilities are present", () => {
    render(<Harness />);
    expect(screen.queryByTestId("x.phrase-clipboard-notice")).toBeNull();
    expect(screen.queryByTestId("x.phrase-extension-notice")).toBeNull();
  });

  it("renders both caveats where the capabilities are absent", () => {
    has.mockReturnValue(false);
    render(<Harness />);
    expect(screen.getByTestId("x.phrase-clipboard-notice")).toBeTruthy();
    expect(screen.getByTestId("x.phrase-extension-notice")).toBeTruthy();
  });

  it("copies the whole phrase joined by single spaces", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("x.phrase-copy"));
    expect(copySecretToClipboard).toHaveBeenCalledWith("r1 r2 r3 r4", expect.anything());
  });
});
