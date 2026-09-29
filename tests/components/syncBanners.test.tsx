// @vitest-environment jsdom
//
// The editor-shell sync banner stack (test-audit #9/#48).
//
// WHAT THIS PINS AND WHY. `SyncBanners` is the ONLY place several sync
// conditions become visible to a user, and one of them —
// `sync://integrity-alert` — is the single user-facing signal that the engine's
// head-verify rejected a rollback, i.e. the only thing a hostile or compromised
// server's rewind produces on screen. None of the five banners was covered in
// any lane: not here, not in the desktop E2E suite, not in the web one. A
// refactor that dropped a `listen` subscription, renamed an event string, or
// re-ordered the early-return guard would have shipped in silence, and the
// symptom would be an alert that never appears — which looks exactly like an
// attack that never happened.
//
// Three properties, in descending order of how much it matters that they hold:
//
//   1. Each event lights ITS OWN banner. An event string that stops matching is
//      invisible from either side alone: the emitter still emits, the component
//      still subscribes, and nothing renders.
//   2. The two non-dismissable banners have no dismiss control. This is not
//      styling. `SyncBanners.tsx` states the reason for both: the condition does
//      not resolve on its own and every later cycle re-refuses, so a dismiss
//      button would let the user restore exactly the silence the banner exists
//      to break. A dismiss button added here would be a real regression and
//      nothing else would notice.
//   3. Silence is the default. With no events, the stack renders nothing —
//      otherwise the banners would be chrome, and chrome gets ignored.
//
// Copy is asserted against `SYNC_INTEGRITY_ALERT` from
// `src/lib/load-bearing-copy.ts`, by FULL-LITERAL equality — the repo's own
// rule for load-bearing banner copy (`e2e/AGENTS.md`), and not against a
// literal duplicated into this file. A test carrying its own copy passes after
// a copy collapse, which is precisely the failure that rule exists to prevent.
// (This sentence is deliberately not an i18n key: it is a security disclosure
// whose wording is a decisions.md event, not a copy edit.)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

/** Captured `listen(event, handler)` subscriptions, keyed by event name. */
const handlers = new Map<string, Array<() => void>>();

vi.mock("../../src/platform/event", () => ({
  listen: async (event: string, fn: () => void) => {
    const list = handlers.get(event) ?? [];
    list.push(fn);
    handlers.set(event, list);
    return () => {
      const cur = handlers.get(event) ?? [];
      handlers.set(
        event,
        cur.filter((f) => f !== fn),
      );
    };
  },
}));

// The other two producers in the stack are separate features with their own
// tests; hold them at their silent state so this file is about the events.
vi.mock("../../src/hooks/useMaterialisationProgress", () => ({
  useMaterialisationProgress: () => null,
}));
vi.mock("../../src/hooks/useTorState", () => ({
  useTorState: () => ({ posture: null }),
}));
// The stale-sync strip (myne#583) is driven by polled STATUS rather than by an
// event, so it needs its own handle. Default: nothing wrong.
let syncStatus: unknown = { state: "idle" };
vi.mock("../../src/hooks/useSyncStatus", () => ({
  useSyncStatus: () => ({ status: syncStatus, syncNow: () => {}, busy: false }),
}));

const { SyncBanners } = await import("../../src/components/sync/SyncBanners");
const { SYNC_INTEGRITY_ALERT } = await import("../../src/lib/load-bearing-copy");

/** Fire a backend event at every live subscriber, inside act(). */
async function emit(event: string): Promise<void> {
  const list = handlers.get(event) ?? [];
  expect(list.length, `nothing is subscribed to ${event}`).toBeGreaterThan(0);
  for (const fn of list) fn();
}

beforeEach(() => {
  handlers.clear();
  syncStatus = { state: "idle" };
});
afterEach(cleanup);

/** event -> the testid it must light. */
const CASES: Array<{ event: string; testId: string }> = [
  { event: "sync://reconcile-started", testId: "sync.reconcile-banner" },
  { event: "sync://reconcile-finished", testId: "sync.reconcile-banner" },
  { event: "sync://integrity-alert", testId: "sync.integrity-alert" },
  { event: "sync://credential-ambiguous", testId: "sync.credential-ambiguous" },
  { event: "sync://vault-rekeyed", testId: "sync.vault-rekeyed" },
];

describe("SyncBanners (test-audit #9/#48)", () => {
  it("renders nothing at all until something happens", async () => {
    const { container } = render(<SyncBanners />);
    // Subscriptions are async; let them settle before concluding "silent".
    await waitFor(() => expect(handlers.size).toBeGreaterThan(0));
    expect(container.firstChild, "an idle vault must show no sync chrome").toBeNull();
  });

  it.each(CASES)("$event lights $testId", async ({ event, testId }) => {
    render(<SyncBanners />);
    await waitFor(() => expect(handlers.has(event)).toBe(true));
    await emit(event);
    await waitFor(() => expect(screen.getByTestId(testId)).toBeTruthy());
  });

  it("lights ONLY its own banner, so a mismatched event string cannot pass", async () => {
    render(<SyncBanners />);
    await waitFor(() => expect(handlers.has("sync://integrity-alert")).toBe(true));
    await emit("sync://integrity-alert");
    await waitFor(() => expect(screen.getByTestId("sync.integrity-alert")).toBeTruthy());
    for (const { testId } of CASES) {
      if (testId === "sync.integrity-alert") continue;
      expect(screen.queryByTestId(testId), `${testId} must stay silent`).toBeNull();
    }
  });

  it("the integrity alert says what happened, in its load-bearing wording", async () => {
    render(<SyncBanners />);
    await waitFor(() => expect(handlers.has("sync://integrity-alert")).toBe(true));
    await emit("sync://integrity-alert");
    const el = await waitFor(() => screen.getByTestId("sync.integrity-alert"));
    // `role="alert"` and not `status`: this one interrupts on purpose.
    expect(el.getAttribute("role")).toBe("alert");
    // FULL literal, not a substring of it: a copy collapse that dropped the
    // "Your local notes are safe" half would still contain any prefix.
    expect(el.textContent ?? "").toContain(SYNC_INTEGRITY_ALERT);
  });

  it.each([
    { event: "sync://credential-ambiguous", testId: "sync.credential-ambiguous" },
    { event: "sync://vault-rekeyed", testId: "sync.vault-rekeyed" },
  ])("$testId offers no way to dismiss it", async ({ event, testId }) => {
    render(<SyncBanners />);
    await waitFor(() => expect(handlers.has(event)).toBe(true));
    await emit(event);
    const el = await waitFor(() => screen.getByTestId(testId));
    expect(
      el.querySelector("button"),
      "dismissing this would restore the silence it exists to break — SyncBanners.tsx says so",
    ).toBeNull();
  });

  it("the dismissable ones really are dismissable", async () => {
    render(<SyncBanners />);
    await waitFor(() => expect(handlers.has("sync://integrity-alert")).toBe(true));
    await emit("sync://integrity-alert");
    const el = await waitFor(() => screen.getByTestId("sync.integrity-alert"));
    expect(
      screen.queryByTestId("sync.integrity-alert-dismiss"),
      "an alert with no way out becomes chrome",
    ).toBeTruthy();
    expect(el).toBeTruthy();
  });
});

// myne#583. The fourth condition in this stack and the only one that is a
// DURATION rather than an event — which is exactly why it exists. Sync against
// the hosted server was dead for four days while the status dot said "Sync
// error" the whole time, in a settings panel nobody opens while their notes
// look like they are saving. They were saving, to one disk.
describe("stale-sync warning", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("appears once a failure is days old, and can be dismissed", async () => {
    syncStatus = {
      state: "error",
      detail: "tls_failure",
      last_success_at: Date.now() - 5 * DAY,
    };
    render(<SyncBanners />);
    const strip = await screen.findByTestId("sync.stale-warning");
    // An alert, not a status: something is wrong right now, and has been.
    expect(strip.getAttribute("role")).toBe("alert");
    // No date and no elapsed count anywhere in the copy (AS6/AS15).
    expect(strip.textContent).not.toMatch(/\d{4}|\d+\s*(day|hour|minute)/i);

    screen.getByTestId("sync.stale-dismiss").click();
    await waitFor(() =>
      expect(screen.queryByTestId("sync.stale-warning")).toBeNull(),
    );
  });

  it("stays silent for a fresh failure and for a healthy vault", async () => {
    syncStatus = {
      state: "error",
      detail: "sync_failed",
      last_success_at: Date.now() - 60_000,
    };
    const { unmount } = render(<SyncBanners />);
    expect(screen.queryByTestId("sync.stale-warning")).toBeNull();
    unmount();

    // And an error with no recorded success at all: a device that has never
    // synced is mid-setup, not stale.
    syncStatus = { state: "error", detail: "sync_failed" };
    render(<SyncBanners />);
    expect(screen.queryByTestId("sync.stale-warning")).toBeNull();
  });
});
