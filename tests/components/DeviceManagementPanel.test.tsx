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

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// The hook listens for `sync://enrollment-changed`; stub it to a no-op unlistener.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { DeviceManagementPanel } from "../../src/components/sync/DeviceManagementPanel";

/** Make the roster load reject with a given non-secret error kind. */
function listRejects(kind: string) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "plugin:sync|sync_list_devices") throw { kind };
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
    render(<DeviceManagementPanel />);

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
    render(<DeviceManagementPanel />);

    await waitFor(() => expect(screen.queryByTestId("sync.device-error")).toBeTruthy());
    expect(screen.getByTestId("sync.device-error").textContent).toMatch(
      /Couldn.t reach sync \(Unauthenticated\)/,
    );
    expect(screen.getByTestId("sync.reset-local")).toBeTruthy();
  });

  it("a transient transport error shows the error line + a re-pin hint, but NO reset button", async () => {
    listRejects("Transport");
    render(<DeviceManagementPanel />);

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
      return undefined;
    });
    render(<DeviceManagementPanel />);

    await waitFor(() =>
      expect(screen.queryByTestId("sync.device-retired-self")).toBeTruthy(),
    );
    expect(screen.getByTestId("sync.reset-local")).toBeTruthy();
  });
});

describe("DeviceManagementPanel — reset recovery arc", () => {
  it("clicking reset invokes sync_reset_local, then the refresh reports NotEnrolled → flips to 'add above'", async () => {
    listRejects("Unauthenticated");
    render(<DeviceManagementPanel />);
    await waitFor(() => expect(screen.queryByTestId("sync.reset-local")).toBeTruthy());

    invokeMock.mockClear();
    // After the local reset, the token is gone → the refresh now reports NotEnrolled.
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:sync|sync_reset_local") return undefined;
      if (cmd === "plugin:sync|sync_list_devices") throw { kind: "NotEnrolled" };
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
      return Promise.resolve(undefined);
    });
    render(<DeviceManagementPanel />);
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeTruthy());
  });
});
