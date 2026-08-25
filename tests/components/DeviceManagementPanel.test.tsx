// @vitest-environment jsdom
//
// Component tests for `src/components/sync/DeviceManagementPanel.tsx`. The panel
// consumes the real `useDevices` hook, which talks to the `sync` plugin via
// `invoke` (`plugin:sync|sync_list_devices` + approve/remove/reset). We mock
// `invoke` at the Tauri boundary and route by command name, exercising the
// panel + hook end-to-end. Assertions pin the recently-added branching:
//   - NotEnrolled → an informational "add it above" message, NO reset button;
//   - Unauthenticated → the error line WITH the "Reset sync on this device" button;
//   - any other (transport) error → the error line WITHOUT the reset button (a
//     network blip must not offer a baseline-wiping reset);
//   - the loading-fix: a not-enrolled roster (devices===null + error) must NOT spin
//     on "Loading…", while a genuinely in-flight first read still shows it;
//   - the recovery arc: reset → refresh reports NotEnrolled → UI flips to "add above".

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();

// The panel reads `device_names` off `usePrefs`, so every mock below must answer
// `prefs_read` with a prefs-shaped object — returning `undefined` (the old
// catch-all) crashes the panel on `prefs.device_names`.
const PREFS_STUB = { device_names: {} };

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// The hook listens for `sync://enrollment-changed`; stub it to a no-op unlistener.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { DeviceManagementPanel } from "../../src/components/sync/DeviceManagementPanel";
import { useDevices } from "../../src/hooks/useDevices";

// The panel now takes the `useDevices` result as a prop (the hook is lifted to
// SyncPanel in production). This harness re-creates the panel+hook integration
// the tests exercise: it owns the hook so `invoke` mocking still drives the
// full roster→render path end-to-end.
function Harness() {
  return <DeviceManagementPanel hook={useDevices()} />;
}

/** Make the roster load reject with a given non-secret error kind. */
function listRejects(kind: string) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "plugin:sync|sync_list_devices") throw { kind };
    if (cmd === "plugin:prefs|prefs_read") return PREFS_STUB;
    return undefined;
  });
}

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
});

describe("DeviceManagementPanel — error-state branching", () => {
  it("NotEnrolled shows the informational message, no reset button, and no 'Loading…'", async () => {
    listRejects("NotEnrolled");
    render(<Harness />);

    await waitFor(() =>
      expect(screen.queryByTestId("sync.device-not-enrolled")).toBeTruthy(),
    );
    expect(screen.queryByTestId("sync.reset-local")).toBeNull();
    expect(screen.queryByTestId("sync.device-error")).toBeNull();
    // The loading-fix: devices===null + error must NOT render the spinner forever.
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("Unauthenticated shows the error line WITH the reset button", async () => {
    listRejects("Unauthenticated");
    render(<Harness />);

    await waitFor(() => expect(screen.queryByTestId("sync.device-error")).toBeTruthy());
    expect(screen.getByTestId("sync.device-error").textContent).toMatch(
      // A readable reason, not the backend's serde `kind`. The raw identifier
      // used to be interpolated into translated copy in all 32 locales, which
      // told the reader nothing and pinned that leak in this assertion.
      /Couldn.t reach sync \(the server rejected this device.s sign-in\)/,
    );
    expect(screen.getByTestId("sync.reset-local")).toBeTruthy();
  });

  it("a transient transport error shows the error line + a re-pin hint, but NO reset button", async () => {
    listRejects("Transport");
    render(<Harness />);

    await waitFor(() => expect(screen.queryByTestId("sync.device-error")).toBeTruthy());
    // A network blip is not a reason to drop the baseline → no reset CTA, but a hint
    // toward re-pinning the endpoint (the likely cause: server moved / cert changed).
    expect(screen.queryByTestId("sync.reset-local")).toBeNull();
    expect(screen.getByTestId("sync.transport-hint")).toBeTruthy();
  });

  it("a remotely-retired self surfaces a reset CTA even when the roster loads cleanly", async () => {
    // The roster load SUCCEEDS, but this device's own row comes back retired (it was
    // removed from another device). Without the explicit branch it would be filtered
    // out of both `approved` and `pending` and vanish silently.
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:sync|sync_list_devices") {
        return [{ device_id_hex: "aa00", approved: true, retired: true, is_current: true }];
      }
      if (cmd === "plugin:prefs|prefs_read") return PREFS_STUB;
      return undefined;
    });
    render(<Harness />);

    await waitFor(() =>
      expect(screen.queryByTestId("sync.device-retired-self")).toBeTruthy(),
    );
    expect(screen.getByTestId("sync.reset-local")).toBeTruthy();
  });
});

describe("DeviceManagementPanel — reset recovery arc", () => {
  it("clicking reset invokes sync_reset_local, then the refresh reports NotEnrolled → flips to 'add above'", async () => {
    listRejects("Unauthenticated");
    render(<Harness />);
    await waitFor(() => expect(screen.queryByTestId("sync.reset-local")).toBeTruthy());

    invokeMock.mockClear();
    // After the local reset, the token is gone → the refresh now reports NotEnrolled.
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:sync|sync_reset_local") return undefined;
      if (cmd === "plugin:sync|sync_list_devices") throw { kind: "NotEnrolled" };
      if (cmd === "plugin:prefs|prefs_read") return PREFS_STUB;
      return undefined;
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("sync.reset-local"));
    });

    expect(
      invokeMock.mock.calls.some((c) => c[0] === "plugin:sync|sync_reset_local"),
    ).toBe(true);
    // The recovery refresh flips the panel to the friendly not-enrolled message.
    await waitFor(() =>
      expect(screen.queryByTestId("sync.device-not-enrolled")).toBeTruthy(),
    );
    expect(screen.queryByTestId("sync.reset-local")).toBeNull();
  });
});

describe("DeviceManagementPanel — loading", () => {
  it("shows 'Loading…' while the first roster read is genuinely in flight (no error)", async () => {
    // A never-settling list keeps devices===null with NO error → genuine loading.
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "plugin:sync|sync_list_devices") return new Promise(() => {});
      if (cmd === "plugin:prefs|prefs_read") return Promise.resolve(PREFS_STUB);
      return Promise.resolve(undefined);
    });
    render(<Harness />);
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeTruthy());
  });
});

// ── #243: the approving side has to keep looking ────────────────────────────
//
// `sync_head_fingerprint` answers `None` for as long as this device has adopted
// no head, so the single call the panel used to make could — and on a first join
// routinely did — land before there was anything to show. The panel then sat on
// "this code appears once the new device finishes its first sync" permanently,
// while the joining side polled every second.
describe("DeviceManagementPanel — SAS verify polling", () => {
  const ROSTER = [
    { device_id_hex: "aa00", approved: true, retired: false, is_current: true },
    { device_id_hex: "bb11", approved: true, retired: false, is_current: false },
    { device_id_hex: "cc22", approved: false, retired: false, is_current: false },
  ];

  /** Roster + prefs, with `sync_head_fingerprint` driven by `fingerprints`. */
  function mountWith(fingerprints: (string | null)[]) {
    const queue = [...fingerprints];
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:sync|sync_list_devices") return ROSTER;
      if (cmd === "plugin:prefs|prefs_read") return PREFS_STUB;
      if (cmd === "plugin:sync|sync_head_fingerprint") {
        return queue.length > 1 ? queue.shift()! : (queue[0] ?? null);
      }
      return undefined;
    });
  }

  it("keeps polling until a head is adopted, then renders the code", async () => {
    vi.useFakeTimers();
    try {
      // Two empty answers, then the head lands.
      mountWith([null, null, "K3M9-QR7T"]);
      render(<Harness />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId("sync.verify-device"));
      });
      // First check came back empty — the pending copy, not the code.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.queryByTestId("sync.sas-pending")).toBeTruthy();
      expect(screen.queryByTestId("sync.sas-fingerprint")).toBeNull();

      // Two more ~1 s ticks and the adopted head arrives.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
      expect(screen.getByTestId("sync.sas-fingerprint").textContent).toBe("K3M9-QR7T");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not await sync_now before checking the fingerprint", async () => {
    vi.useFakeTimers();
    try {
      invokeMock.mockImplementation((cmd: string) => {
        if (cmd === "plugin:sync|sync_list_devices") return Promise.resolve(ROSTER);
        if (cmd === "plugin:prefs|prefs_read") return Promise.resolve(PREFS_STUB);
        // A full vault sync that never returns — the shape that made the match
        // code unreachable on a large vault. The fingerprint check must not be
        // sequenced behind it.
        if (cmd === "plugin:sync|sync_now") return new Promise(() => {});
        if (cmd === "plugin:sync|sync_head_fingerprint") return Promise.resolve("K3M9-QR7T");
        return Promise.resolve(undefined);
      });
      render(<Harness />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      await act(async () => {
        fireEvent.click(screen.getByTestId("sync.verify-device"));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // `sync_now` was started (single-flight) but never settled, and the code
      // is on screen anyway.
      expect(
        invokeMock.mock.calls.some((c) => c[0] === "plugin:sync|sync_now"),
      ).toBe(true);
      expect(screen.getByTestId("sync.sas-fingerprint").textContent).toBe("K3M9-QR7T");
    } finally {
      vi.useRealTimers();
    }
  });

  // ── myne#462 ────────────────────────────────────────────────────────────────

  /// THE regression test. Before the fix this side stopped polling on its first
  /// non-null answer — which, on an already-enrolled device, is the head it held
  /// BEFORE its own sync landed. It then sat on that stale value while the
  /// ceremony moved the vault head underneath, and the two screens showed
  /// different codes.
  ///
  /// Fails against the pre-fix tree: the old `return` after `setSas` meant the
  /// second value was never read.
  it("tracks the head instead of latching the first answer", async () => {
    vi.useFakeTimers();
    try {
      mountWith(["K3M9-QR7T", "P8WX-2ND4"]);
      render(<Harness />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId("sync.verify-device"));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByTestId("sync.sas-fingerprint").textContent).toBe("K3M9-QR7T");

      // The head advanced. The screen must follow it rather than keep showing a
      // value this device no longer holds.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100);
      });
      expect(screen.getByTestId("sync.sas-fingerprint").textContent).toBe("P8WX-2ND4");
    } finally {
      vi.useRealTimers();
    }
  });

  /// A stable head must NOT churn the display, and the poll must still be alive
  /// while it is stable — otherwise "the code did not change" would be
  /// indistinguishable from "we stopped looking", which is exactly the bug.
  it("keeps polling while the head is stable, without re-rendering the code", async () => {
    vi.useFakeTimers();
    try {
      mountWith(["K3M9-QR7T"]);
      render(<Harness />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId("sync.verify-device"));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const before = invokeMock.mock.calls.filter(
        (c) => c[0] === "plugin:sync|sync_head_fingerprint",
      ).length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100);
      });
      expect(screen.getByTestId("sync.sas-fingerprint").textContent).toBe("K3M9-QR7T");
      const after = invokeMock.mock.calls.filter(
        (c) => c[0] === "plugin:sync|sync_head_fingerprint",
      ).length;
      expect(after).toBeGreaterThan(before);
      // A stable head is not an alarm.
      expect(screen.queryByTestId("sync.sas-changed")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /// The push hold is what makes the head stand still under the compare. It is
  /// armed on every tick (it doubles as the lease ping) and released when the
  /// screen goes away — a hold nobody releases would hold this device's pushes
  /// for the full 15 s lease for no reason.
  it("arms the push hold while the compare is open and releases it on exit", async () => {
    vi.useFakeTimers();
    try {
      mountWith(["K3M9-QR7T"]);
      render(<Harness />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const armsBefore = invokeMock.mock.calls.filter(
        (c) => c[0] === "plugin:sync|sync_verify_hold_begin",
      ).length;
      expect(armsBefore).toBe(0); // not armed by merely listing devices

      await act(async () => {
        fireEvent.click(screen.getByTestId("sync.verify-device"));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
      const arms = invokeMock.mock.calls.filter(
        (c) => c[0] === "plugin:sync|sync_verify_hold_begin",
      ).length;
      expect(arms).toBeGreaterThan(1); // re-armed each tick, i.e. the lease ping

      await act(async () => {
        fireEvent.click(screen.getByTestId("sync.sas-match"));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(
        invokeMock.mock.calls.some((c) => c[0] === "plugin:sync|sync_verify_hold_end"),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  /// A mismatch used to revoke the other device on ONE click, with no
  /// confirmation — while every other removal on this panel goes through the
  /// `REMOVE_DEVICE_CONFIRM` disclosure, and while the mobile counterpart
  /// already confirmed. Now that a mismatch is known to be a timing artefact far
  /// more often than an attack, the destructive default is the wrong one.
  it("routes a mismatch through the removal confirmation instead of revoking", async () => {
    vi.useFakeTimers();
    try {
      mountWith(["K3M9-QR7T"]);
      render(<Harness />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId("sync.verify-device"));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        fireEvent.click(screen.getByTestId("sync.sas-mismatch"));
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // The confirmation is up and NOTHING has been revoked yet.
      expect(screen.queryByTestId("sync.remove-confirm")).toBeTruthy();
      expect(
        invokeMock.mock.calls.some((c) => c[0] === "plugin:sync|sync_remove_device"),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers a route back into the verify screen for an already-approved device", async () => {
    mountWith(["K3M9-QR7T"]);
    render(<Harness />);
    await waitFor(() => expect(screen.queryByTestId("sync.verify-device")).toBeTruthy());

    // Only the OTHER device gets the button — comparing a code against itself is
    // not a ceremony.
    expect(screen.getAllByTestId("sync.verify-device")).toHaveLength(1);

    await act(async () => {
      fireEvent.click(screen.getByTestId("sync.verify-device"));
    });
    await waitFor(() =>
      expect(screen.queryByTestId("sync.approve-verify")).toBeTruthy(),
    );
    // …and it does NOT re-approve on the way in.
    expect(
      invokeMock.mock.calls.some((c) => c[0] === "plugin:sync|sync_approve_device"),
    ).toBe(false);
  });
});
