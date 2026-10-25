// @vitest-environment jsdom
//
// Component tests for `src/components/sync/DeviceAttributionPanel.tsx`
// (myne-md/myne#852, PRD story 11). The panel consumes the real
// `useDeviceBindings` hook, which reaches `plugin:device-binding|*` through
// `invoke`, so `invoke` is mocked at the Tauri boundary and routed by command
// name, exercising the panel and the hook end to end.
//
// What these tests exist to hold, in order of how badly it would hurt to lose
// it:
//
//   1. An id whose row did not verify is NEVER rendered next to a person or a
//      name. The row signature binds the row to the signer and NOTHING to the
//      device (`protocol.md` §9.30.4), so naming a member beside an unverified
//      id invents exactly the attribution the backend's partition exists to
//      withhold. The fixture gives `prefs.device_names` an entry FOR the
//      unverified id, so an implementation that resolves a device LABEL there
//      fails this test rather than passing it.
//   2. `StoreUnreadable` is reported, not folded into "no devices". Answering
//      empty for a damaged store lets the next write persist that emptiness over
//      every other device's real row (`device-binding-error.ts` says so).
//   3. An unshared vault is a STATE and not an error.
//   4. A row's claim is rendered as a claim ("claimed by"), and a member with no
//      name falls back to the fingerprint rather than to the device label.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const invokeMock = vi.fn();

const ROW_A = {
  device_id_hex: "aa".repeat(16),
  person_fingerprint_hex: "11".repeat(32),
  person_id_hex: "22".repeat(32),
  member_name: "Ada",
  is_this_device: true,
};
const ROW_B = {
  device_id_hex: "bb".repeat(16),
  person_fingerprint_hex: "33".repeat(32),
  person_id_hex: "44".repeat(32),
  member_name: null,
  is_this_device: false,
};
/** The id whose row did not verify. `prefs.device_names` below carries a name
 *  for it ON PURPOSE: the panel must not read one. */
const UNVERIFIED_ID = "dd".repeat(16);

const PREFS_STUB = {
  device_names: {
    // A name for the unverified id, and a friendly name for a verified one:
    // the two halves of the rule this panel has to get right.
    [UNVERIFIED_ID]: "Ada's laptop",
    [ROW_B.device_id_hex]: "Studio Mac",
  },
};

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// The hook subscribes to `sync://changed`; stub the event bridge so jsdom has
// no IPC to fail on (a rejected `listen` warns rather than throwing, but the
// subscription is not what these tests are about).
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { DeviceAttributionPanel } from "../../src/components/sync/DeviceAttributionPanel";

/** Route `device_bindings_list` to a result, or to a rejection. */
function listAnswers(answer: unknown | (() => Promise<unknown>)) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "plugin:device-binding|device_bindings_list") {
      if (typeof answer === "function") return (answer as () => Promise<unknown>)();
      if (answer instanceof Error) throw answer;
      return answer;
    }
    if (cmd === "plugin:prefs|prefs_read") return PREFS_STUB;
    return undefined;
  });
}

/** Reject with a tagged `DeviceBindingError` arm. */
function listRejects(kind: string) {
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "plugin:device-binding|device_bindings_list") throw { kind };
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

describe("DeviceAttributionPanel: a claim is a claim", () => {
  it("names the claiming member on a verified row, and says 'claimed by'", async () => {
    listAnswers({ rows: [ROW_A], unverified_device_ids: [] });
    render(<DeviceAttributionPanel />);

    await waitFor(() =>
      expect(screen.queryByTestId("device-bindings.row")).toBeTruthy(),
    );
    const claim = screen.getByTestId("device-bindings.claimed-by");
    expect(claim.textContent).toMatch(/claimed by Ada/);
    expect(claim.getAttribute("data-named")).toBe("true");
    // Never the wording the signature does not support.
    expect(claim.textContent).not.toMatch(/belongs|owned/i);
  });

  it("falls back to the fingerprint when the claiming member has no name, never to the device label", async () => {
    listAnswers({ rows: [ROW_B], unverified_device_ids: [] });
    render(<DeviceAttributionPanel />);

    await waitFor(() =>
      expect(screen.queryByTestId("device-bindings.claimed-by")).toBeTruthy(),
    );
    const claim = screen.getByTestId("device-bindings.claimed-by");
    expect(claim.getAttribute("data-named")).toBe("false");
    // The fingerprint prefix, not "Studio Mac": the device's own label is the
    // DEVICE half of the row and must never stand in for the person half.
    expect(claim.textContent).toMatch(new RegExp(ROW_B.person_fingerprint_hex.slice(0, 16)));
    expect(claim.textContent).not.toMatch(/Studio Mac/);
    // The device label still renders, on the device half where it belongs.
    expect(screen.getByTestId("device-bindings.device-label").textContent).toBe(
      "Studio Mac",
    );
  });

  it("badges this device, and offers no claim button when a row is already ours", async () => {
    listAnswers({ rows: [ROW_A], unverified_device_ids: [] });
    render(<DeviceAttributionPanel />);

    await waitFor(() =>
      expect(screen.queryByTestId("device-bindings.this-device")).toBeTruthy(),
    );
    expect(screen.queryByTestId("device-bindings.claim")).toBeNull();
  });
});

describe("DeviceAttributionPanel: an unverified id is an id and nothing else", () => {
  it("renders the bare id under a marker, and never a member name or a device label", async () => {
    listAnswers({
      rows: [ROW_A, ROW_B],
      unverified_device_ids: [UNVERIFIED_ID],
    });
    render(<DeviceAttributionPanel />);

    await waitFor(() =>
      expect(screen.queryByTestId("device-bindings.unverified-row")).toBeTruthy(),
    );
    const row = screen.getByTestId("device-bindings.unverified-row");
    expect(row.textContent).toMatch(new RegExp(UNVERIFIED_ID.slice(0, 16)));
    expect(screen.getByTestId("device-bindings.unverified-marker").textContent).toBe(
      "Not verified",
    );
    // The rule, stated as an assertion: `prefs.device_names` DOES hold a name for
    // this id (see PREFS_STUB), so a label-resolving implementation fails here.
    expect(row.textContent).not.toMatch(/Ada's laptop/);
    // And no member name from any row leaks onto it either.
    expect(row.textContent).not.toMatch(/Ada/);
    expect(row.textContent).not.toMatch(/Grace/);
    // The 32-hex value never reaches the DOM: the roster panel's rule, and a
    // sharper one here, because an unverified key can be arbitrary member-written
    // bytes rather than a device id at all.
    expect(row.getAttribute("data-device-id")).toBe(UNVERIFIED_ID.slice(0, 16));
    expect(row.outerHTML).not.toMatch(new RegExp(UNVERIFIED_ID));
  });

  it("renders an id that is not even valid device-id hex without inventing anything for it", async () => {
    // A member can write any key into the group-tier store, so this is the shape
    // a tampered map produces. It must render as opaque text, not crash and not
    // gain a label.
    listAnswers({ rows: [], unverified_device_ids: ["not-a-device-id"] });
    render(<DeviceAttributionPanel />);

    await waitFor(() =>
      expect(screen.queryByTestId("device-bindings.unverified-id")).toBeTruthy(),
    );
    expect(screen.getByTestId("device-bindings.unverified-id").textContent).toBe(
      "not-a-device-id",
    );
    // With no verified rows the empty state is ALSO shown, which is the honest
    // pair: nothing is attributed, and here is what could not be.
    expect(screen.queryByTestId("device-bindings.empty")).toBeTruthy();
  });
});

describe("DeviceAttributionPanel: failures are typed, not flattened", () => {
  it("StoreUnreadable is reported, NOT folded into 'no devices'", async () => {
    listRejects("StoreUnreadable");
    render(<DeviceAttributionPanel />);

    await waitFor(() =>
      expect(screen.queryByTestId("device-bindings.error")).toBeTruthy(),
    );
    expect(screen.getByTestId("device-bindings.error").textContent).toMatch(
      /could not be read/i,
    );
    // The failure this guards: an empty list over a damaged store reads as "this
    // vault has no devices", and the next write persists that over every real
    // row.
    expect(screen.queryByTestId("device-bindings.empty")).toBeNull();
    expect(screen.queryByTestId("device-bindings.list")).toBeNull();
  });

  it("NoDeviceId says this device has no identity to claim under", async () => {
    listRejects("NoDeviceId");
    render(<DeviceAttributionPanel />);

    await waitFor(() =>
      expect(screen.queryByTestId("device-bindings.error")).toBeTruthy(),
    );
    expect(screen.getByTestId("device-bindings.error").textContent).toMatch(
      /has not been added to your account/i,
    );
  });

  it("an unshared vault is a state and not an error", async () => {
    listRejects("NotASharedVault");
    render(<DeviceAttributionPanel />);

    await waitFor(() =>
      expect(screen.queryByTestId("device-bindings.unshared")).toBeTruthy(),
    );
    // No failure line over a state the user did not cause, and no claim button
    // that could only ever answer `NotASharedVault`.
    expect(screen.queryByTestId("device-bindings.error")).toBeNull();
    expect(screen.queryByTestId("device-bindings.claim")).toBeNull();
  });

  // 2026-10-25 owner report: "shared is ready and syncing, yet this says not
  // shared yet". The refusal is the same (`NotASharedVault`) but the FACT is not:
  // an `NTV5` vault has no group tier, while a person-born `NTV7` vault carries one
  // from birth and this family is still unreachable on it because the member plane
  // is `NTV6`-only (`protocol.md` §9.29). The old copy answered both with "sharing
  // happens the first time you invite someone", which on the second vault is an
  // act the product cannot perform.
  it("says the generation cannot carry the family, not 'not shared yet'", async () => {
    listRejects("NotASharedVault");
    render(<DeviceAttributionPanel personBorn />);

    await waitFor(() =>
      expect(screen.queryByTestId("device-bindings.generation")).toBeTruthy(),
    );
    // The `NTV5` sentence promises an invite, so it must NOT be the one shown here.
    expect(screen.queryByTestId("device-bindings.unshared")).toBeNull();
  });
});

describe("DeviceAttributionPanel: the claim affordance", () => {
  it("offers the claim when no row is ours, and replaces the view with what the command answers", async () => {
    // First read: someone else's device only, so this device has no row.
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:device-binding|device_bindings_list") {
        return { rows: [ROW_B], unverified_device_ids: [] };
      }
      if (cmd === "plugin:device-binding|device_bindings_claim") {
        return { rows: [ROW_B, ROW_A], unverified_device_ids: [] };
      }
      if (cmd === "plugin:prefs|prefs_read") return PREFS_STUB;
      return undefined;
    });
    render(<DeviceAttributionPanel />);

    const claim = await screen.findByTestId("device-bindings.claim");
    expect(claim.textContent).toMatch(/Claim this device/);
    fireEvent.click(claim);

    // The command's own answer is what lands, not a locally-assumed success: the
    // partition lives in the backend, so a re-read is the only honest update.
    await waitFor(() =>
      expect(screen.queryAllByTestId("device-bindings.row")).toHaveLength(2),
    );
    expect(screen.queryByTestId("device-bindings.this-device")).toBeTruthy();
    // A row is ours now, so the affordance retires.
    await waitFor(() =>
      expect(screen.queryByTestId("device-bindings.claim")).toBeNull(),
    );
  });

  it("reports a refused claim without dropping the rows already read", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "plugin:device-binding|device_bindings_list") {
        return { rows: [ROW_B], unverified_device_ids: [] };
      }
      if (cmd === "plugin:device-binding|device_bindings_claim") {
        throw { kind: "NoDeviceId" };
      }
      if (cmd === "plugin:prefs|prefs_read") return PREFS_STUB;
      return undefined;
    });
    render(<DeviceAttributionPanel />);

    fireEvent.click(await screen.findByTestId("device-bindings.claim"));

    await waitFor(() =>
      expect(screen.queryByTestId("device-bindings.error")).toBeTruthy(),
    );
    expect(screen.getByTestId("device-bindings.error").textContent).toMatch(
      /has not been added to your account/i,
    );
  });
});
