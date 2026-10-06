// @vitest-environment jsdom
//
// The recovery phrase reads left-to-right even when the page does not
// (myne-md/myne#468). Mobile's half of the same fix the desktop grid got.
//
// A correctness fix, not typography. The ORDER of the 24 words is part of the
// secret and `recovery-flow.md` §2.4 commits to never showing them again, so a
// grid laid out in an RTL locale's direction hands the user a transcription whose
// wrongness is undiscoverable: BIP-39's checksum does not catch a permutation, so
// the phrase simply fails to open the vault, months later, with nothing left to
// compare against.
//
// `RecoveryGrid` is rendered by BOTH mobile phrase surfaces — the vault-creation
// recovery kit and the person-identity flow — so one assertion covers both.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { RecoveryGrid } from "../../src/components";

const WORDS = Array.from({ length: 24 }, (_, i) => `word${i + 1}`);

afterEach(cleanup);

describe("RecoveryGrid", () => {
  it("pins itself left-to-right, whatever the page direction is", () => {
    // Set on the grid rather than on the page, and the document is the control:
    // a blanket `dir` on a wrapper would satisfy a grid-only assertion while
    // breaking every Arabic sentence around it.
    document.documentElement.setAttribute("dir", "rtl");
    try {
      render(<RecoveryGrid words={WORDS} />);
      expect(screen.getByTestId("recovery-grid").getAttribute("dir")).toBe("ltr");
      expect(
        document.documentElement.getAttribute("dir"),
        "the grid pinned the whole page",
      ).toBe("rtl");
    } finally {
      document.documentElement.removeAttribute("dir");
    }
  });

  it("renders every word it is given, in order", () => {
    // Non-vacuity for the assertion above: `dir="ltr"` on an empty grid is a
    // property of nothing. Also the half-reveal case the kit step uses, where the
    // grid is handed twelve words rather than twenty-four.
    render(<RecoveryGrid words={WORDS.slice(0, 12)} />);
    const cells = screen.getByTestId("recovery-grid").children;
    expect(cells.length).toBe(12);
    for (let i = 0; i < 12; i++) {
      expect(cells[i].textContent).toContain(WORDS[i]);
    }
  });
});
