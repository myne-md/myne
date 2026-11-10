// @vitest-environment jsdom
//
// Settings → Developer → Network: the Tor-routing toggle (MYND-650 task 7) and
// the connection-state row beside it (task 8).
//
// Three things are worth a test here, and none of them is "does the switch
// flip".
//
// 1. **The copy's BOUNDS.** `agent-tooling/docs/threat-model.md` is normative and Tor mode is
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
// 3. **The posture is not the switch.** The switch says what was asked for; the
//    posture row says what is happening. They disagree exactly when it matters
//    — a Tor client that failed to start leaves the preference on and the
//    tunnel down — so the five postures are asserted to render *distinctly*,
//    and the two paused ones are asserted to say sync is paused rather than
//    anything that could be read as protection. `exempt` is the fifth: a
//    loopback endpoint travels through no circuit whatever the process gate
//    says, and rendering that as "active" would claim a tunnel that does not
//    exist.
//
// Copy is asserted through the catalog rather than pasted, so the wording stays
// the catalog's business — what is pinned is the bound, which no translation may
// cross either.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const getTorRouting = vi.fn();
const setTorRouting = vi.fn();
const getTorState = vi.fn();
vi.mock("../../src/lib/tor-routing", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/lib/tor-routing")>();
  return {
    ...real,
    getTorRouting: () => getTorRouting(),
    setTorRouting: (enabled: boolean) => setTorRouting(enabled),
    // `torPosture` is deliberately NOT mocked: the mapping from the backend
    // view to the four postures is the thing under test everywhere below.
    getTorState: () => getTorState(),
  };
});

const { NetworkPanel, writeFailureNotice } = await import(
  "../../src/components/settings/NetworkPanel"
);
type TorStateView = import("../../src/lib/tor-routing").TorStateView;
type TorPosture = import("../../src/lib/tor-routing").TorPosture;
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
  "settings.network.postureHeading",
  "settings.network.postureInactive",
  "settings.network.postureConnecting",
  "settings.network.postureConnectingDetail",
  "settings.network.postureActive",
  "settings.network.postureUnavailable",
  "settings.network.postureUnavailableDetail",
  "settings.network.postureExempt",
  "settings.network.postureExemptDetail",
  "settings.network.disabledCue",
];

beforeEach(() => {
  // The resting posture of every install that never opted in. Tests that care
  // about a different one override it.
  getTorState.mockResolvedValue({ enabled: false, state: { kind: "stopped" }, exempt: false });
});

afterEach(() => {
  cleanup();
  getTorRouting.mockReset();
  setTorRouting.mockReset();
  getTorState.mockReset();
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
    // The claim is the row's sentence and the caveats are behind the `?` beside
    // it, so the guarantee is read over the two together: a reader who opens the
    // row sees the positive claim and, one interaction away, what it does not do.
    const surface = `${i18n.t("settings.network.torInline")} ${i18n.t("settings.network.torHelper")}`;
    expect(surface).toContain("Hides your IP address and location");
    expect(surface).toContain("does not make you anonymous to Myne");
    expect(surface).toContain("does not hide what you sync or when");
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

describe("Network panel — the posture row (task 8)", () => {
  const mount = async (state: TorStateView) => {
    getTorRouting.mockResolvedValue({ enabled: state.enabled });
    getTorState.mockResolvedValue(state);
    render(<NetworkPanel />);
    return await screen.findByTestId("settings.tor-posture");
  };

  it("renders each of the five postures distinctly", async () => {
    const cases: Array<[TorStateView, TorPosture, string]> = [
      [{ enabled: false, state: { kind: "stopped" }, exempt: false }, "inactive", "postureInactive"],
      [{ enabled: true, state: { kind: "starting" }, exempt: false }, "connecting", "postureConnecting"],
      [{ enabled: true, state: { kind: "ready" }, exempt: false }, "active", "postureActive"],
      [{ enabled: true, state: { kind: "failed" }, exempt: false }, "unavailable", "postureUnavailable"],
      [{ enabled: true, state: { kind: "ready" }, exempt: true }, "exempt", "postureExempt"],
    ];
    const seen = new Set<string>();
    for (const [view, posture, key] of cases) {
      const row = await mount(view);
      expect(row.getAttribute("data-posture")).toBe(posture);
      const label = screen.getByTestId("settings.tor-posture-label").textContent ?? "";
      expect(label).toBe(i18n.t(`settings.network.${key}`));
      expect(seen.has(label), `"${label}" is not distinct`).toBe(false);
      seen.add(label);
      cleanup();
    }
    expect(seen.size).toBe(5);
  });

  /// A loopback endpoint tunnels nothing whatever the process gate says. The
  /// bug this pins: `enabled` + a `ready` sidecar rendered "Sync is going
  /// through Tor" over an endpoint no circuit ever touched. It must not read as
  /// protection, and it must not read as a paused sync either — sync works.
  it("does not claim a tunnel over a Tor-exempt endpoint", async () => {
    const row = await mount({ enabled: true, state: { kind: "ready" }, exempt: true });
    expect(row.getAttribute("data-posture")).toBe("exempt");
    expect(row.textContent).not.toContain(i18n.t("settings.network.postureActive"));
    expect(row.textContent).toContain(i18n.t("settings.network.postureExemptDetail"));
    // The switch still shows what the user asked for; only the posture reports
    // what is happening to their traffic.
    expect(screen.getByTestId("settings.tor-routing").getAttribute("data-enabled")).toBe("true");
    const exemptCopy = i18n.t("settings.network.postureExempt").toLowerCase();
    expect(exemptCopy).not.toContain("paused");
    for (const word of ["protected", "secure", "safe"]) {
      expect(exemptCopy).not.toContain(word);
    }
  });

  /// The overclaim this copy was corrected for. All the client knows is that the
  /// endpoint's HOST STRING is `127.0.0.1` / `localhost` / `::1` — and the
  /// realistic shape of that is not the dev server, it is an SSH or `socat`
  /// forward to a remote host, where the traffic really does leave and there
  /// really is something to hide; Myne just cannot route it. So the detail may
  /// say what enters no circuit. It may not say what stays on the machine, and
  /// it has to name the case it cannot see — a shorter version that dropped the
  /// second sentence would read as the reassurance this test exists to block.
  it("does not promise a Tor-exempt endpoint's traffic stays on this device", () => {
    const detail = i18n.t("settings.network.postureExemptDetail").toLowerCase();
    for (const overclaim of [
      "never leaves",
      "doesn't leave",
      "does not leave",
      "nothing leaves",
      "nothing to hide",
      "stays on this",
    ]) {
      expect(detail, `"${overclaim}" claims more than a loopback host string proves`).not.toContain(
        overclaim,
      );
    }
    expect(detail, "the copy must name the forward-to-elsewhere case it cannot see").toMatch(
      /elsewhere|somewhere else|another (computer|machine|device|server)|remote/,
    );
  });

  /// The exemption is only reported when Tor mode is ON. With it off there is
  /// nothing to explain — direct sync is the default and `inactive` says so.
  it("reports a loopback endpoint as inactive while Tor mode is off", async () => {
    const row = await mount({ enabled: false, state: { kind: "stopped" }, exempt: true });
    expect(row.getAttribute("data-posture")).toBe("inactive");
  });

  /// A dead Tor client and a deliberately-stopped one are the same situation
  /// for the user — sync is paused, nothing goes out direct — so they are one
  /// posture. What must never happen is either of them reading as fine.
  it("reports a stopped client under Tor mode as unavailable, not as off", async () => {
    const row = await mount({ enabled: true, state: { kind: "stopped" }, exempt: false });
    expect(row.getAttribute("data-posture")).toBe("unavailable");
  });

  /// The switch is what was asked for; the posture is what is happening. A
  /// spawn failure is exactly the case where they disagree, and the row is the
  /// only place the disagreement is visible.
  it("shows sync paused while the switch sits ON after a failed start", async () => {
    const row = await mount({ enabled: true, state: { kind: "failed" }, exempt: false });
    expect(screen.getByTestId("settings.tor-routing").getAttribute("data-enabled")).toBe("true");
    expect(row.textContent).toContain(i18n.t("settings.network.postureUnavailable"));
    expect(row.textContent).toContain(i18n.t("settings.network.postureUnavailableDetail"));
  });

  it("never lets a paused posture read as protection", () => {
    // "paused" and "nothing is being sent directly" are the two facts a user
    // needs; "protected"/"secure"/"private" would claim the opposite of what is
    // true while the tunnel is down.
    for (const key of ["postureConnecting", "postureUnavailable"] as const) {
      const copy = i18n.t(`settings.network.${key}`).toLowerCase();
      expect(copy).toContain("paused");
      for (const word of ["protected", "secure", "safe"]) {
        expect(copy, `${key} must not say "${word}"`).not.toContain(word);
      }
    }
    for (const key of ["postureConnectingDetail", "postureUnavailableDetail"] as const) {
      expect(i18n.t(`settings.network.${key}`)).toContain("directly");
    }
  });

  it("says so explicitly when the user turns Tor off", async () => {
    getTorRouting.mockResolvedValue({ enabled: true });
    getTorState.mockResolvedValue({ enabled: true, state: { kind: "ready" }, exempt: false });
    setTorRouting.mockResolvedValueOnce({ enabled: false });

    render(<NetworkPanel />);
    await screen.findByTestId("settings.tor-posture");
    expect(screen.queryByTestId("settings.tor-disabled-cue")).toBeNull();

    getTorState.mockResolvedValue({ enabled: false, state: { kind: "stopped" }, exempt: false });
    fireEvent.click(screen.getByTestId("settings.tor-routing-toggle"));

    const cue = await screen.findByTestId("settings.tor-disabled-cue");
    expect(cue.textContent).toBe(i18n.t("settings.network.disabledCue"));
    await waitFor(() =>
      expect(
        screen.getByTestId("settings.tor-posture").getAttribute("data-posture"),
      ).toBe("inactive"),
    );
  });

  it("renders nothing at all until the first read resolves", () => {
    getTorRouting.mockResolvedValue({ enabled: false });
    getTorState.mockReturnValue(new Promise(() => {}));
    render(<NetworkPanel />);
    // No dot, no label, no guess. An unknown posture is not "inactive".
    expect(screen.queryByTestId("settings.tor-posture")).toBeNull();
  });
});
