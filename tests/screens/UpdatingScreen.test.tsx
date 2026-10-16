// @vitest-environment jsdom
//
// Component tests for `src/screens/UpdatingScreen.tsx` (myne-md/myne#870).
//
// Two things are worth asserting here and they are different in kind: that the
// failed phase offers the retry AND the way back (the vault is locked by then, so
// there is no path to the editor without an unlock), and that the cipher reveal
// is decorative in the accessibility tree while the version is announced as one
// stable string. A scrubbed line whose glyphs were readable would be announced
// glyph by glyph, which is worse than no animation at all.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { UpdatingScreen } from "../../src/screens/UpdatingScreen";

afterEach(cleanup);

describe("the working phase", () => {
  it("names the version and offers no action a user could take mid install", () => {
    render(
      <UpdatingScreen
        phase="working"
        version="0.10.1"
        onRetry={vi.fn()}
        onBackToUnlock={vi.fn()}
      />,
    );
    expect(screen.getByTestId("update.updating")).toBeTruthy();
    expect(screen.getByText("update.updating.caption")).toBeTruthy();
    // No retry and no exit: the install is running and the only honest action is
    // to wait. A cancel here would be a lie, since the download is not abortable.
    expect(screen.queryByTestId("update.failed-retry")).toBeNull();
    expect(screen.queryByTestId("update.failed-back")).toBeNull();
  });

  it("reveals the version once, behind an aria-hidden stagger, with the value announced once", () => {
    const { container } = render(
      <UpdatingScreen
        phase="working"
        version="0.10.1"
        onRetry={vi.fn()}
        onBackToUnlock={vi.fn()}
      />,
    );
    const reveal = container.querySelector(".myne-version-reveal");
    expect(reveal).toBeTruthy();
    const glyphs = reveal?.querySelectorAll('span[aria-hidden="true"]') ?? [];
    expect(glyphs.length).toBe("0.10.1".length);
    // Each glyph carries a stagger delay derived from the token, not a literal.
    expect(glyphs[1]?.getAttribute("style")).toContain("var(--stagger-step)");
    // The stable string is present and NOT one of the animated glyphs.
    expect(reveal?.textContent).toContain("update.updating.version");
  });
});

describe("the failed phase", () => {
  it("offers the retry and the only way back, and states that nothing changed", () => {
    const onRetry = vi.fn();
    const onBackToUnlock = vi.fn();
    render(
      <UpdatingScreen
        phase="failed"
        version="0.10.1"
        onRetry={onRetry}
        onBackToUnlock={onBackToUnlock}
      />,
    );
    expect(screen.getByTestId("update.failed")).toBeTruthy();
    expect(screen.getByText("update.failed.caption")).toBeTruthy();
    expect(screen.getByText("update.failed.hint")).toBeTruthy();

    fireEvent.click(screen.getByTestId("update.failed-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("update.failed-back"));
    expect(onBackToUnlock).toHaveBeenCalledTimes(1);
  });
});
