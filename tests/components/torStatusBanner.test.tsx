// @vitest-environment jsdom
//
// The Tor connection banner in the editor chrome (MYND-650 task 8).
//
// This strip is the only place a user learns that sync has stopped. The
// transport is fail-closed — with Tor mode on and the tunnel down it refuses to
// connect at all rather than falling back to a direct connection — so a paused
// sync produces no error, no retry storm and no visible symptom. Silence here
// is indistinguishable from "everything is fine" right up until the user needs
// the data on another device.
//
// So what is pinned is not layout: it is (a) that the fail-closed state renders
// at all, (b) that it renders as a problem rather than as progress, (c) that
// the two states which must stay silent do, and (d) that the copy names what is
// happening to the user's data instead of naming our process.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { TorStatusBanner } from "../../src/components/sync/TorStatusBanner";
import i18n from "../../src/i18n";

afterEach(cleanup);

describe("TorStatusBanner", () => {
  it("stays silent when Tor is off, when it is working, and before the first read", () => {
    for (const posture of ["inactive", "active", null] as const) {
      render(<TorStatusBanner posture={posture} />);
      expect(screen.queryByTestId("sync.tor-banner"), `${posture} must be silent`).toBeNull();
      cleanup();
    }
  });

  it("says sync is paused while the tunnel comes up", () => {
    render(<TorStatusBanner posture="connecting" />);
    const banner = screen.getByTestId("sync.tor-banner");
    expect(banner.getAttribute("data-posture")).toBe("connecting");
    expect(banner.getAttribute("role")).toBe("status");
    expect(banner.textContent).toContain(i18n.t("sync.tor.connecting"));
  });

  it("announces the fail-closed state as a problem, not as progress", () => {
    render(<TorStatusBanner posture="unavailable" />);
    const banner = screen.getByTestId("sync.tor-banner");
    expect(banner.getAttribute("data-posture")).toBe("unavailable");
    // `alert`, so a screen reader hears it without going looking. `status`
    // would wait for a pause in whatever the user is doing.
    expect(banner.getAttribute("role")).toBe("alert");
    expect(banner.textContent).toContain(i18n.t("sync.tor.unavailable"));
    // And it points at the one control that resolves it.
    expect(banner.textContent).toContain(i18n.t("sync.tor.settingsHint"));
  });

  it("carries no dismiss affordance", () => {
    // Both conditions are still true after a dismissal, and `unavailable` does
    // not resolve on its own — dismissing would restore exactly the silence
    // this banner exists to break.
    render(<TorStatusBanner posture="unavailable" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("names what is happening to the data, not what our process is doing", () => {
    for (const key of ["sync.tor.connecting", "sync.tor.unavailable"] as const) {
      const copy = i18n.t(key);
      expect(copy.toLowerCase(), `${key} must say sync is paused`).toContain("paused");
      expect(copy, `${key} must rule out a direct connection`).toContain("directly");
      for (const word of ["protected", "anonymous", "secure"]) {
        expect(copy.toLowerCase(), `${key} must not say "${word}"`).not.toContain(word);
      }
    }
  });
});
