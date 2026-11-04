// @vitest-environment jsdom
//
// The wait screen's two jobs beyond watching for a code (myne-md/myne#1000).
//
// # Why this spec exists
//
// The screen called `sync_now` every second, threw the answer away, and rendered the
// same spinner whether the pull was one tick away or could never run. Two devices sat
// on it, one of them approved and unable to say so. The three arms below are the
// answers, and each is asserted in both directions because a one-armed assertion here
// passes for the states this screen spends its ordinary life in:
//
//   1. A PENDING device keeps the clean spinner. `sync_status: pending` is the normal
//      reading and must not raise a warning, or the screen cries wolf on every join.
//   2. A device whose sync is FAILING says so at once, in the sync panel's own words.
//      `identity_locked` is the class a joined device actually reaches.
//   3. A device that has waited out the deadline without a code says which state it is
//      stuck in even when that state is not an error (`not_enrolled`), which is the
//      reading a device with an empty token produces.
//
// The claim poll is measured too: `sync_person_claim_device` is the only thing that
// installs the credential a person-plane device needs, and the join wizard used to be
// its only caller.

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ status: { state: "pending" } as Record<string, unknown> }));
const claim = vi.hoisted(() => ({ calls: 0 }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("../../src/lib/use-prefs", () => ({
  usePrefs: () => ({ prefs: { auto_lock_seconds: 90 } }),
}));
vi.mock("../../src/hooks/useHeadFingerprintCompare", () => ({
  useHeadFingerprintCompare: () => ({ fingerprint: null, changed: false }),
}));
vi.mock("../../src/hooks/useIdleAutoLock", () => ({ useIdleAutoLock: () => {} }));
vi.mock("../../src/lib/sync", () => ({ syncResetLocal: () => Promise.resolve() }));
vi.mock("../../src/lib/app-window", () => ({ HAS_TAURI: true }));
vi.mock("../../src/lib/personAccount", () => ({
  personClaimDevice: () => {
    claim.calls += 1;
    return Promise.resolve({ approved: false });
  },
}));
vi.mock("../../src/platform/core", () => ({
  invoke: (command: string) =>
    Promise.resolve(command === "plugin:sync|sync_status" ? ipc.status : null),
}));

import { ApprovalWaitFlow } from "../../src/app/flows/ApprovalWaitFlow";

const VAULT = "00000000-0000-7000-8000-00000000000a";

function mount() {
  render(<ApprovalWaitFlow vaultId={VAULT} onApproved={vi.fn()} onCancel={vi.fn()} />);
}

/** Flush the mount-time poll, which fires inside a promise chain. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  claim.calls = 0;
  ipc.status = { state: "pending" };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the approval wait names why the code has not arrived", () => {
  it("raises nothing for a device that is simply still pending", async () => {
    mount();
    await flush();
    expect(screen.queryByTestId("sync.join.stalled")).toBeNull();
    expect(screen.getByTestId("sync.join.pending")).toBeTruthy();
  });

  it("says at once when sync is failing, in the panel's own words", async () => {
    ipc.status = { state: "error", detail: "identity_locked" };
    mount();
    await flush();
    const line = screen.getByTestId("sync.join.stalled");
    expect(line.textContent).toContain("sync.status.errorIdentityLocked");
  });

  it("names the state it is stuck in once the wait outlives any ordinary approval", async () => {
    vi.useFakeTimers();
    ipc.status = { state: "not_enrolled" };
    mount();
    // The mount-time poll resolves before the deadline, so the first assertion is the
    // negative: a state that is also the ordinary reading must not speak yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.queryByTestId("sync.join.stalled")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(21_000);
    });
    const line = screen.getByTestId("sync.join.stalled");
    expect(line.textContent).toContain("settings.sync.summary.notSetUp");
  });

  it("drives the device-credential claim the join wizard used to own", async () => {
    mount();
    await flush();
    expect(claim.calls).toBeGreaterThan(0);
  });
});
