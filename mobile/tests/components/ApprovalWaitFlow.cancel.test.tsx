// @vitest-environment jsdom
//
// The approval wait's two exits, and the marker that decides whether the §6.3
// compare is still owed (myne-md/myne#957 review).
//
// # Why this spec exists
//
// `ApprovalWaitFlow` decides, on every way out, whether the device-local marker
// that owes the head-fingerprint compare is retired, and no test pressed either
// control. Replacing the cancel arm's body with a bare `onCancel()`, or retiring
// the marker unconditionally, left 1 148 mobile unit tests and 371 flow-logic
// cases green: the mitigation was decided by code nothing measured.
//
// Three arms, and each is asserted in BOTH directions rather than by a single
// post-condition:
//
//   1. Cancel on the spinner KEEPS the marker. The code has not been shown yet,
//      so the compare has not been offered, and a marker retired here makes the
//      only out-of-band mitigation optional for anyone who taps once.
//   2. Cancel on the compare RETIRES it. The code was on screen, the compare was
//      offered, and the reader said no. That is a deliberate answer and it must
//      not leave a marker no act of the user's can clear.
//   3. The idle re-lock KEEPS it. An auto-lock is not a comparison, so a phone
//      left on the compare cannot lose the question to a timer.
//
// Every assertion reads the real marker store (`@myne/client-core/approval-wait`)
// rather than a mock of it: the store is four lines of localStorage and mocking it
// would test the mock.

import { cleanup, render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const compare = vi.hoisted(() => ({
  value: { fingerprint: null as string | null, changed: false },
}));
const idleLock = vi.hoisted(() => ({ callback: undefined as undefined | (() => void) }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // The shared i18n runtime is initialised by `src/i18n` on module load, so the
  // mock has to hand it something to `use()`; without this the real index throws
  // before any component renders.
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("../../src/lib/use-prefs", () => ({
  usePrefs: () => ({ prefs: { auto_lock_seconds: 90 } }),
}));
vi.mock("../../src/hooks/useHeadFingerprintCompare", () => ({
  useHeadFingerprintCompare: () => compare.value,
}));
vi.mock("../../src/hooks/useIdleAutoLock", () => ({
  useIdleAutoLock: (callback: () => void) => {
    idleLock.callback = callback;
  },
}));
vi.mock("../../src/lib/sync", () => ({ syncResetLocal: () => Promise.resolve() }));
vi.mock("../../src/lib/app-window", () => ({ HAS_TAURI: true }));

import { ApprovalWaitFlow } from "../../src/app/flows/ApprovalWaitFlow";
import { isApprovalWait, markApprovalWait } from "@myne/client-core/approval-wait";

const VAULT = "00000000-0000-7000-8000-00000000000a";

function mount(step: "pending" | "verify") {
  compare.value =
    step === "pending" ? { fingerprint: null, changed: false } : { fingerprint: "TYRS-N318", changed: false };
  const onCancel = vi.fn();
  render(<ApprovalWaitFlow vaultId={VAULT} onApproved={vi.fn()} onCancel={onCancel} />);
  return { onCancel };
}

beforeEach(() => {
  markApprovalWait(VAULT);
  idleLock.callback = undefined;
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the approval wait's exits and the marker", () => {
  it("keeps the marker when Cancel is pressed on the spinner, because no code was shown", () => {
    const { onCancel } = mount("pending");
    expect(screen.getByTestId("sync.join.pending")).toBeTruthy();
    // Positive control: the marker is what the assertion below can observe going
    // from set to clear, so its absence cannot pass this spec silently.
    expect(isApprovalWait(VAULT)).toBe(true);

    fireEvent.click(screen.getByTestId("sync.join.cancel"));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(isApprovalWait(VAULT)).toBe(true);
  });

  it("retires the marker when Cancel is pressed on the compare, because the code was on screen", () => {
    const { onCancel } = mount("verify");
    expect(screen.getByTestId("sync.join.verify")).toBeTruthy();
    expect(isApprovalWait(VAULT)).toBe(true);

    fireEvent.click(screen.getByTestId("sync.join.cancel"));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(isApprovalWait(VAULT)).toBe(false);
  });

  it("keeps the marker when the idle re-lock fires, because a timer is not a comparison", () => {
    const { onCancel } = mount("verify");
    expect(isApprovalWait(VAULT)).toBe(true);
    expect(idleLock.callback).toBeTypeOf("function");

    idleLock.callback?.();

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(isApprovalWait(VAULT)).toBe(true);
  });
});
