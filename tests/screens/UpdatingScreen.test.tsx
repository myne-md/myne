// @vitest-environment jsdom
//
// Component tests for `src/screens/UpdatingScreen.tsx` (myne-md/myne#870 for the
// surface, myne-md/myne#1020 for the progress-led redesign).
//
// Three things are worth asserting and they are different in kind: that the
// failed phase offers the retry AND the way back (the vault is locked by then, so
// there is no path to the editor without an unlock); that the cipher reveal is
// decorative in the accessibility tree while the version is announced as one
// stable string; and that the bar reports the host's numbers rather than an
// animation. The last one is the point of the redesign: a progress bar that drew a
// plausible fill from nothing would look identical to this one and pass a test
// that only checked it rendered, so the assertions are on the reported values and
// on the shape that has none.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key) }),
}));

import { UpdatingScreen } from "../../src/screens/UpdatingScreen";
import type { UpdateProgressState } from "../../src/hooks/useUpdateAvailable";

afterEach(cleanup);

function renderWorking(progress?: UpdateProgressState | null) {
  return render(
    <UpdatingScreen
      phase="working"
      version="0.10.1"
      progress={progress}
      onRetry={vi.fn()}
      onBackToUnlock={vi.fn()}
    />,
  );
}

describe("the working phase", () => {
  it("names the version and offers no action a user could take mid install", () => {
    renderWorking();
    expect(screen.getByTestId("update.updating")).toBeTruthy();
    expect(screen.getByText("update.updating.hint")).toBeTruthy();
    // No retry and no exit: the install is running and the only honest action is
    // to wait. A cancel here would be a lie, since the download is not abortable.
    expect(screen.queryByTestId("update.failed-retry")).toBeNull();
    expect(screen.queryByTestId("update.failed-back")).toBeNull();
  });

  it("reveals the version once, behind an aria-hidden stagger, with the value announced once", () => {
    const { container } = renderWorking();
    const reveal = container.querySelector(".myne-version-reveal");
    expect(reveal).toBeTruthy();
    const glyphs = reveal?.querySelectorAll('span[aria-hidden="true"]') ?? [];
    expect(glyphs.length).toBe("0.10.1".length);
    // Each glyph carries a stagger delay derived from the token, not a literal.
    expect(glyphs[1]?.getAttribute("style")).toContain("var(--stagger-step)");
    // The stable string is present and NOT one of the animated glyphs.
    expect(reveal?.textContent).toContain("update.updating.version");
  });

  it("reports the host's byte counts as a determinate bar and a percentage", () => {
    renderWorking({
      phase: "downloading",
      downloaded: 5_242_880,
      total: 10_485_760,
    });
    const bar = screen.getByTestId("update.progress");
    expect(bar.getAttribute("role")).toBe("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    // The phase word and the number beside it, in the state the host reported.
    expect(screen.getByTestId("update.status").textContent).toBe(
      "update.phase.downloading",
    );
    expect(screen.getByTestId("update.percent").textContent).toBe("50%");
    // Both halves of the byte readout, formatted (not raw counts).
    const bytes = screen.getByTestId("update.bytes").textContent ?? "";
    expect(bytes).toContain("update.updating.bytesOfTotal");
    expect(bytes).toContain("5 MiB");
    expect(bytes).toContain("10 MiB");
    // No indeterminate sweep when there IS a total: that shape is the answer to a
    // missing denominator, not to a slow connection.
    expect(
      document.querySelector(".myne-update-progress-indeterminate"),
    ).toBeNull();
  });

  it("floors the percentage, so 100% is never shown while bytes are still arriving", () => {
    renderWorking({
      phase: "downloading",
      downloaded: 10_485_759,
      total: 10_485_760,
    });
    expect(screen.getByTestId("update.percent").textContent).toBe("99%");
  });

  it("sweeps and states no percentage when the origin sent no Content-Length", () => {
    renderWorking({
      phase: "downloading",
      downloaded: 4_194_304,
      total: null,
    });
    const bar = screen.getByTestId("update.progress");
    // An indeterminate progressbar carries no value: the number does not exist.
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
    expect(
      document.querySelector(".myne-update-progress-indeterminate"),
    ).toBeTruthy();
    // The readout still says what has arrived, which is the only true thing left.
    expect(screen.getByTestId("update.percent").textContent).toBe("");
    const bytes = screen.getByTestId("update.bytes").textContent ?? "";
    expect(bytes).toContain("update.updating.bytes");
    expect(bytes).not.toContain("bytesOfTotal");
  });

  it("shows a full bar and no byte line for the phases that have no bytes left", () => {
    for (const phase of ["verifying", "installing"] as const) {
      const { unmount } = renderWorking({
        phase,
        downloaded: 10_485_760,
        total: 10_485_760,
      });
      expect(screen.getByTestId("update.progress").getAttribute("aria-valuenow")).toBe(
        "100",
      );
      expect(screen.getByTestId("update.status").textContent).toBe(
        `update.phase.${phase}`,
      );
      expect(screen.queryByTestId("update.bytes")).toBeNull();
      unmount();
    }
  });

  it("renders its starting shape with no progress at all, rather than 0% of an unknown", () => {
    renderWorking(null);
    expect(screen.getByTestId("update.status").textContent).toBe(
      "update.phase.starting",
    );
    expect(screen.getByTestId("update.percent").textContent).toBe("");
    expect(screen.queryByTestId("update.bytes")).toBeNull();
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
    expect(screen.getByText("update.failed.heading")).toBeTruthy();
    expect(screen.getByText("update.failed.hint")).toBeTruthy();
    // The redesigned surface states the RUNNING version in that sentence, and it
    // is the one the app is on rather than the one that failed to install.
    expect(screen.getByText(/update\.failed\.caption/)).toBeTruthy();

    fireEvent.click(screen.getByTestId("update.failed-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("update.failed-back"));
    expect(onBackToUnlock).toHaveBeenCalledTimes(1);
  });

  it("draws no bar at all: the install is not running, so there is nothing to measure", () => {
    render(
      <UpdatingScreen
        phase="failed"
        version="0.10.1"
        progress={{ phase: "downloading", downloaded: 1024, total: 4096 }}
        onRetry={vi.fn()}
        onBackToUnlock={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("update.progress")).toBeNull();
    expect(screen.queryByTestId("update.percent")).toBeNull();
  });
});
