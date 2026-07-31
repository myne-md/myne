// @vitest-environment jsdom
//
// Settings → Developer → Network: the Tor-routing toggle (MYND-650 task 7).
//
// Two things are worth a test here, and neither is "does the switch flip".
//
// 1. **The copy's BOUNDS.** `docs/threat-model.md` is normative and Tor mode is
//    an opt-in client-side reduction of the AS14/A2 source-IP exposure and
//    nothing more. Copy that called it anonymity would exceed the model on the
//    one screen a user reads before trusting it, so the forbidden vocabulary is
//    asserted against the real English catalog — and, separately, the four
//    residuals the PRD requires are asserted to be *present*, because a
//    disclosure is only honest if it is complete.
// 2. **What a failed toggle says.** `SidecarStartFailed` is not a failed save:
//    the preference IS on and sync is paused rather than routed directly
//    (`src-tauri/src/plugins/sync/tor.rs` module doc). Copy that read as "the
//    toggle didn't take" would tell the user they are on the clearnet when they
//    are not — the inverse of the mistake this feature exists to prevent.
//
// Copy is asserted through the catalog rather than pasted, so the wording stays
// the catalog's business — what is pinned is the bound, which no translation may
// cross either.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const getTorRouting = vi.fn();
const setTorRouting = vi.fn();
vi.mock("../../src/lib/tor-routing", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/tor-routing")>();
  return {
    ...real,
    getTorRouting: () => getTorRouting(),
    setTorRouting: (enabled: boolean) => setTorRouting(enabled),
  };
});

const { NetworkPanel, writeFailureNotice } = await import(
  "../../src/components/settings/NetworkPanel"
);
const i18n = (await import("../../src/i18n")).default;

/** Every word that would turn the toggle into an anonymity claim. */
const FORBIDDEN = ["anonymous", "anonymity", "untraceable", "invisible", "no one can"];

/** The strings this panel actually renders (keywords are a haystack, not copy). */
const RENDERED_KEYS = [
  "settings.network.torLabel",
  "settings.network.torHelper",
  "settings.network.residualsToggle",
  "settings.network.residualExit",
  "settings.network.residualMetadata",
  "settings.network.residualPayment",
  "settings.network.residualScope",
  "settings.network.errorRead",
  "settings.network.errorSave",
  "settings.network.errorSidecar",
];

afterEach(() => {
  cleanup();
  getTorRouting.mockReset();
  setTorRouting.mockReset();
});

describe("Network panel — copy bounds", () => {
  it("claims no anonymity anywhere it renders", () => {
    for (const key of RENDERED_KEYS) {
      const copy = i18n.t(key).toLowerCase();
      for (const word of FORBIDDEN) {
        // The helper's own "does not make you anonymous to Myne" is the one
        // legitimate use, and it is a NEGATION — allowed precisely because it
        // removes the claim rather than making it.
        if (key === "settings.network.torHelper" && word === "anonymous") continue;
        expect(copy, `${key} must not say "${word}"`).not.toContain(word);
      }
    }
  });

  it("states the negative cases in the same breath as the positive one", () => {
    const helper = i18n.t("settings.network.torHelper");
    expect(helper).toContain("Hides your IP address and location");
    expect(helper).toContain("does not make you anonymous to Myne");
    expect(helper).toContain("does not hide what you sync or when");
  });

  it("discloses all four residuals", async () => {
    getTorRouting.mockResolvedValue({ enabled: false });
    render(<NetworkPanel />);
    await waitFor(() => expect(getTorRouting).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("settings.tor-residuals-toggle"));

    const residuals = screen.getByTestId("settings.tor-residuals").textContent ?? "";
    // Exit node sees the destination; server metadata unchanged; hosted-tier
    // payment correlation; and the scope limit (Myne's sync, not the device).
    expect(residuals).toContain("exit node");
    expect(residuals).toContain("how many devices");
    expect(residuals).toContain("billing trail");
    expect(residuals).toContain("Nothing else on this device");
  });

  it("keeps the residuals collapsed until asked", async () => {
    getTorRouting.mockResolvedValue({ enabled: false });
    render(<NetworkPanel />);
    await waitFor(() => expect(getTorRouting).toHaveBeenCalled());
    expect(screen.queryByTestId("settings.tor-residuals")).toBeNull();
  });
});

describe("Network panel — the toggle", () => {
  it("shows the persisted preference", async () => {
    getTorRouting.mockResolvedValue({ enabled: true });
    render(<NetworkPanel />);
    await waitFor(() =>
      expect(
        screen.getByTestId("settings.tor-routing").getAttribute("data-enabled"),
      ).toBe("true"),
    );
  });

  it("a spawn failure leaves the toggle ON and says sync is paused, not that the save failed", async () => {
    getTorRouting.mockResolvedValueOnce({ enabled: false });
    setTorRouting.mockRejectedValueOnce({ kind: "SidecarStartFailed" });
    // The re-read after the failure: the backend does NOT roll the preference
    // back, so it is on.
    getTorRouting.mockResolvedValue({ enabled: true });

    render(<NetworkPanel />);
    await waitFor(() => expect(getTorRouting).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("settings.tor-routing-toggle"));

    await waitFor(() =>
      expect(
        screen.getByTestId("settings.tor-routing").getAttribute("data-enabled"),
      ).toBe("true"),
    );
    expect(screen.getByTestId("settings.tor-routing-notice").textContent).toBe(
      i18n.t("settings.network.errorSidecar"),
    );
  });

  it("a write failure says nothing changed", async () => {
    getTorRouting.mockResolvedValue({ enabled: false });
    setTorRouting.mockRejectedValueOnce({ kind: "Io", detail: { io_error_kind: "PermissionDenied" } });

    render(<NetworkPanel />);
    await waitFor(() => expect(getTorRouting).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("settings.tor-routing-toggle"));

    await waitFor(() =>
      expect(screen.getByTestId("settings.tor-routing-notice").textContent).toBe(
        i18n.t("settings.network.errorSave"),
      ),
    );
    expect(
      screen.getByTestId("settings.tor-routing").getAttribute("data-enabled"),
    ).toBe("false");
  });

  it("an unreadable preference says so instead of asserting a position", async () => {
    getTorRouting.mockRejectedValue({ kind: "Io", detail: { io_error_kind: "NotFound" } });
    render(<NetworkPanel />);
    await waitFor(() =>
      expect(screen.getByTestId("settings.tor-routing-notice").textContent).toBe(
        i18n.t("settings.network.errorRead"),
      ),
    );
  });

  it("classifies a spawn failure apart from every other write failure", () => {
    expect(writeFailureNotice("SidecarStartFailed")).toBe("sidecar");
    expect(writeFailureNotice("Io")).toBe("save");
    expect(writeFailureNotice("Parse")).toBe("save");
    // An unrecognised rejection is a failed save, not a silent success.
    expect(writeFailureNotice(null)).toBe("save");
  });
});
