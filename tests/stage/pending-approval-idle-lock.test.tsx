// @vitest-environment jsdom
//
// myne-md/myne#535: the awaiting-approval wait, wired through `App`.
//
// # Why this file mounts `App` rather than the hook
//
// It used to render `useIdleAutoLock` directly with the arguments `App` passes,
// and its own header claimed the property was "the hook is mounted with a live
// timeout on this stage and disabled off it". It proved neither half. Deleting
// the `useIdleAutoLock` call from `App.tsx` left it green, and so did deleting
// the effect that produces the stage in the first place, because nothing in the
// file ever reached `App`.
//
// That is the shape `myne-agents` calls shipped-inert wiring: a correct unit
// with an unproven binding. This change has two of those bindings and both were
// rewritten repeatedly, so they are the part that needs a test, not the hook.
//
// # The two bindings
//
// 1. `awaitingApprovalVerdict()` answering `true` must move the stage from
//    `editor` to `pending-approval`, through `transition` and a functional
//    `setStage`. The verdict's own answers are driven per capability in
//    `tests/lib/pendingApprovalVerdict.test.ts`; here it is mocked, because what
//    is under test is what `App` does with the answer.
// 2. That stage must arm an idle auto-lock. It holds an UNLOCKED vault
//    deliberately (the wait exists so the sync cycle can claim a token, and the
//    claim needs `root_key`), but it renders `AccountBootstrap`, not `Editor`,
//    and on the web client the only idle auto-lock there is lives inside
//    `Editor`. Without this the transition routes a user to a screen holding
//    live keys where nothing ever locks them, and the stage has no outbound
//    transition of its own.
//
//    `threat-model.md` §1 A6 rates the stolen-unlocked-device case mitigated ON
//    auto-lock zeroizing those keys, and its per-client clause qualifies the web
//    timer as weaker, never as absent on a whole screen.
//
// # What is stubbed, and why that is not the test stubbing its own subject
//
// `Editor` and `AccountBootstrap` are stubs. Neither is the subject: the subject
// is which one `App` renders and what it arms alongside it. Stubbing `Editor`
// also removes the only other `useIdleAutoLock` in the tree, so a `lock` IPC
// observed here can have come from exactly one place.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const invokeMock = vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
}));

/**
 * Absent capabilities for the case in hand; rewritten per test.
 *
 * Through `vi.hoisted` rather than a plain `let`, because `src/lib/stage.ts`
 * calls `has()` at MODULE LOAD (`verifyInitialStageFromProbe` walks every legal
 * transition), and a `vi.mock` factory is hoisted above a `let`, so the plain
 * form dies in the temporal dead zone before a single test runs.
 */
const caps = vi.hoisted(() => ({ absent: [] as string[] }));
vi.mock("../../src/platform/capabilities", () => ({
  has: (cap: string) => !caps.absent.includes(cap),
  ALL_CAPABILITIES: [],
}));

const verdictMock = vi.fn<() => Promise<boolean>>();
vi.mock("../../src/lib/pending-approval", () => ({
  awaitingApprovalVerdict: () => verdictMock(),
}));

vi.mock("../../src/screens/Editor", () => ({
  Editor: () => <div data-testid="stub.editor" />,
}));
vi.mock("../../src/screens/AccountBootstrap", () => ({
  AccountBootstrap: () => <div data-testid="stub.account-bootstrap" />,
}));

import App from "../../src/App";

/** The client this stage exists for: a vault here is never the only copy. */
const WEB = ["localOnlyVault", "osIdleAutoLock", "vaultCreation"];
const DESKTOP: string[] = [];

const AUTO_LOCK_SECS = 60;

/**
 * One healthy vault, its slot unlocked, so boot routes straight to `editor`.
 *
 * `slotKind` is a box rather than a constant because `lockVault()` ends in
 * `reprobe()`, and a probe that still answered `"Unlocked"` after a lock would
 * walk the user back into the editor and make the assertion ambiguous.
 */
function wire(): { slotKind: { value: string } } {
  const slotKind = { value: "Unlocked" };
  invokeMock.mockImplementation(async (cmd) => {
    switch (cmd) {
      case "plugin:vault-unlock|vault_list":
        return [{ id: "v1", status: { kind: "Exists" } }];
      case "plugin:vault-unlock|vault_slot_kind":
        return slotKind.value;
      case "plugin:prefs|prefs_read":
        return { auto_lock_seconds: AUTO_LOCK_SECS };
      case "plugin:sync|sync_person_status":
        return { enrolled: false, person_id_hex: null, identity_code: null };
      case "plugin:vault-unlock|lock":
        slotKind.value = "Empty";
        return undefined;
      default:
        return undefined;
    }
  });
  return { slotKind };
}

const lockCalls = () =>
  invokeMock.mock.calls.filter(([cmd]) => cmd === "plugin:vault-unlock|lock").length;

beforeEach(() => {
  // `shouldAdvanceTime` so Testing Library's own waiting still makes progress
  // while `useIdleAutoLock`'s `Date.now()` deltas stay under this test's
  // control. The hook compares timestamps rather than counting ticks, so a
  // frozen clock would never reach a deadline however far the interval ran.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  caps.absent = WEB;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  verdictMock.mockReset();
});

describe("the awaiting-approval verdict, wired through App", () => {
  it("moves an unlocked editor onto the wait when the verdict says yes", async () => {
    wire();
    verdictMock.mockResolvedValue(true);

    render(<App />);

    expect(
      await screen.findByTestId("stub.account-bootstrap"),
      "the verdict answered yes and App left the editor on it",
    ).toBeTruthy();
    expect(screen.queryByTestId("stub.editor")).toBeNull();
  });

  it("and arms the idle lock that stage would otherwise not have", async () => {
    wire();
    verdictMock.mockResolvedValue(true);

    render(<App />);
    await screen.findByTestId("stub.account-bootstrap");

    expect(lockCalls(), "no deadline has passed yet").toBe(0);
    await vi.advanceTimersByTimeAsync((AUTO_LOCK_SECS + 5) * 1000);
    expect(
      lockCalls(),
      "a screen holding root_key with no timer is the A6 exposure this closes, and " +
        "`Editor` is stubbed here so this IPC can only have come from the pending stage",
    ).toBe(1);
  });

  it("leaves a device that has already synced in the editor, with no timer of its own", async () => {
    wire();
    verdictMock.mockResolvedValue(false);

    render(<App />);
    await screen.findByTestId("stub.editor");

    await vi.advanceTimersByTimeAsync((AUTO_LOCK_SECS + 5) * 1000);
    expect(screen.queryByTestId("stub.account-bootstrap")).toBeNull();
    expect(
      lockCalls(),
      "off the pending stage App passes a timeout of 0; the editor owns its own timer, " +
        "and two clocks locking one vault would be the regression this avoids",
    ).toBe(0);
  });

  it("asks nothing on a client whose vault may be the only copy", async () => {
    // Desktop reaches the same effect, and the per-client rule lives inside the
    // verdict rather than in `App`. What `App` owes is that it does not arm a
    // second clock where `auto_lock.rs` already owns one: `osIdleAutoLock` is
    // present here, so `useIdleAutoLock` is inert whatever timeout it is given.
    wire();
    caps.absent = DESKTOP;
    verdictMock.mockResolvedValue(false);

    render(<App />);
    await screen.findByTestId("stub.editor");

    await vi.advanceTimersByTimeAsync((AUTO_LOCK_SECS + 5) * 1000);
    expect(lockCalls()).toBe(0);
  });
});
