// @vitest-environment jsdom
//
// The self-naming path through the real panel (myne-md/myne#973), and the row
// shape it leaves behind.
//
// Its own file, not another `it` in `DeviceManagementPanel.test.tsx`, and the
// reason is mechanical: `devicePlatform()` memoises its promise at MODULE scope,
// so the first test that lets it resolve unmocked caches "the platform is
// unknown" for every test after it in the same file. Sharing the file would make
// the positive case below pass or fail by test ORDER rather than by the rule.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { DeviceManagementPanel } from "../../src/components/sync/DeviceManagementPanel";
import { useDevices } from "../../src/hooks/useDevices";

const SELF = "aa11bb22cc33dd44ee55ff6677889900";
const OTHER = "bb22cc33dd44ee55ff6677889900aa11";

function Harness() {
  return <DeviceManagementPanel hook={useDevices()} plane="owner" />;
}

function approved(deviceIdHex: string, isCurrent = false) {
  return { device_id_hex: deviceIdHex, approved: true, retired: false, is_current: isCurrent };
}

/** Mount with a roster, the names map a completed prefs read would return, and
 *  the two facts the auto-name gate reads: the adopted-head fingerprint (its
 *  `null` is "this device has never pulled") and the platform token. */
function mount(
  roster: ReturnType<typeof approved>[],
  opts: { names?: Record<string, string>; fingerprint?: string | null; platform?: string } = {},
) {
  const { names = {}, fingerprint = null, platform = "macos" } = opts;
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "plugin:sync|sync_list_devices") return roster;
    if (cmd === "plugin:prefs|prefs_read") return { device_names: names };
    if (cmd === "plugin:prefs|device_platform") return platform;
    if (cmd === "plugin:sync|sync_head_fingerprint") return fingerprint;
    return undefined;
  });
  return render(<Harness />);
}

/** Every name write the panel attempted, in order. */
function nameWrites(): Array<{ deviceIdHex: string; name: string }> {
  return invokeMock.mock.calls
    .filter(([cmd]) => cmd === "plugin:prefs|set_device_name")
    .map(([, args]) => args as { deviceIdHex: string; name: string });
}

beforeEach(() => {
  invokeMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("device row shape (myne-md/myne#973)", () => {
  it("demotes the code only where the title is not the code, and says 'this device' once", async () => {
    mount([approved(SELF, true), approved(OTHER)], { names: { [OTHER]: "Studio iPad" } });

    await waitFor(() => expect(screen.getAllByTestId("sync.device-row")).toHaveLength(2));

    // The named row keeps its demoted code: that line is what tells two devices
    // apart when their names collide.
    const codes = screen.getAllByTestId("sync.device-code");
    expect(codes).toHaveLength(1);
    expect(codes[0].textContent).toBe(OTHER.slice(0, 6));

    // The unnamed row leads with the id-derived label and prints it once.
    expect(screen.getAllByTestId("sync.device-name")[0].textContent).toBe(
      `Device ${SELF.slice(0, 6)}`,
    );
    // One label for "this is the row you are on", not two.
    expect(screen.getAllByTestId("sync.this-device")).toHaveLength(1);
    expect(screen.queryByText("Synced here")).toBeNull();
  });
});

describe("self-naming (myne-md/myne#973)", () => {
  it("names an approved device that has never had a name", async () => {
    mount([approved(SELF, true)], { fingerprint: "ABCD-EFGH" });

    await waitFor(() => expect(nameWrites()).toEqual([{ deviceIdHex: SELF, name: "Mac" }]));
  });

  it("writes nothing before this device has adopted a vault head", async () => {
    // `null` is "never pulled". Naming earlier would create `vault.prefs` before
    // the enrollment wholesale seed, which is keyed on that file being ABSENT
    // (`decisions/sync/0348` clause 2).
    mount([approved(SELF, true)], { fingerprint: null });

    await waitFor(() => expect(screen.getAllByTestId("sync.device-row")).toHaveLength(1));
    expect(nameWrites()).toEqual([]);
    expect(screen.getAllByTestId("sync.device-name")[0].textContent).toBe(
      `Device ${SELF.slice(0, 6)}`,
    );
  });

  it("never names a device that is still awaiting approval", async () => {
    mount([{ ...approved(SELF, true), approved: false }], { fingerprint: "ABCD-EFGH" });

    await waitFor(() => expect(screen.getAllByTestId("sync.pending-row")).toHaveLength(1));
    expect(nameWrites()).toEqual([]);
    // The pending row keeps the id-derived label and never gains a name, which is
    // the SYNC-40 rule: a self-chosen name beside an unverified device reads as a
    // trust signal while nothing verifies it.
    expect(screen.queryByText("Mac")).toBeNull();
  });

  it("leaves an already-named device alone", async () => {
    mount([approved(SELF, true)], { names: { [SELF]: "Studio Mac" }, fingerprint: "ABCD-EFGH" });

    await waitFor(() => expect(screen.getAllByTestId("sync.device-name")).toHaveLength(1));
    expect(nameWrites()).toEqual([]);
    expect(screen.getAllByTestId("sync.device-name")[0].textContent).toBe("Studio Mac");
  });
});
