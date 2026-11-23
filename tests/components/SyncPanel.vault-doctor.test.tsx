// @vitest-environment jsdom
//
// The Sync panel's one authority sentence, derived from the VAULT DOCTOR
// (myne-md/myne#1003).
//
// Before this the line was derived from `SyncFailureClass`, a lossy projection of
// `AuthorityMissing` that names two of its nine causes: `identity_locked` and
// `device_key_missing`. Every other cause rendered nothing, so the panel was silent
// about seven states in which sync cannot run, and the two it did name could not be
// told apart from the four they were standing in for.
//
// What these specs pin, in one sentence each:
//   * the sentence follows the CAUSE the doctor reports;
//   * a doctor that says the authority is PRESENT renders no sentence, because the
//     failure is then a different half and an authority sentence sends the reader
//     after the wrong one;
//   * a doctor that cannot be read leaves the class-based fallback working, so the
//     panel is never silent about a failure it can still partly name;
//   * the read happens on a FAILURE and not on the status beat, because one call
//     verifies the vault's roster (an ML-DSA verify) and a five-second poll is not
//     where that belongs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor } from "@testing-library/react";

const invokeMock = vi.fn();
const writeTextMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: writeTextMock,
}));

import { resetToasts } from "../../src/components/toast/toastStore";
import { resetPersonIdentityState } from "../../src/components/sync/personIdentityState";
import { renderSyncPanel, syncPanelCommandRouter } from "./_syncPanelHarness";

function mount(route: Parameters<typeof syncPanelCommandRouter>[0]): void {
  invokeMock.mockImplementation(syncPanelCommandRouter(route));
  renderSyncPanel();
}

/** How many times the panel asked the doctor. */
function doctorReads(): number {
  return invokeMock.mock.calls.filter(([cmd]) => cmd === "plugin:sync|sync_vault_doctor").length;
}

/** The rendered sentence, or `null` when the line is absent. */
function verdictLine(): string | null {
  return screen.queryByTestId("sync.authority-verdict")?.textContent ?? null;
}

beforeEach(() => {
  invokeMock.mockReset();
  writeTextMock.mockReset().mockResolvedValue(undefined);
  resetPersonIdentityState();
  resetToasts();
});
afterEach(() => {
  cleanup();
  resetPersonIdentityState();
  vi.clearAllMocks();
});

describe("the authority sentence, derived from the doctor", () => {
  it("names the cause the doctor reports, not the failure class", async () => {
    // `sync_failed` is the class a cause the class map does not know becomes. The
    // sentence has to come from the doctor anyway, which is the whole point.
    mount({
      syncState: "error",
      syncDetail: "sync_failed",
      doctor: { authority: { state: "missing", cause: "no_key_at_rest" } },
    });
    await waitFor(() =>
      expect(verdictLine()).toContain("This device holds no signing key"),
    );
  });

  it("tells an unreadable key store apart from an absent key", async () => {
    // The two facts the storage ladder exists to separate: rung 4 ("no key here", the
    // ordinary state) and a store that refused (a fault, and the one cause that may
    // need a platform fix). One sentence for both was the defect class this fixes.
    mount({
      syncState: "error",
      syncDetail: "identity_locked",
      doctor: { authority: { state: "missing", cause: "key_unreadable" } },
    });
    await waitFor(() =>
      expect(verdictLine()).toContain("the system key store would not read it"),
    );
  });

  it("says nothing about the authority when the doctor says it is present", async () => {
    // A failure with a bound device key is a different half of the pipeline. Rendering
    // an authority sentence here would send the reader after a credential that works.
    mount({
      syncState: "error",
      syncDetail: "identity_locked",
      doctor: { authority: { state: "device_key" } },
    });
    // `doctorReads()` counts INVOCATIONS, so it turns 1 before the answer has been
    // applied: asserting the absence synchronously here read the class fallback that
    // is still on screen and failed under CI's parallel load while passing alone.
    // Wait for the line to clear, which is the state this test is about.
    await waitFor(() => expect(doctorReads()).toBe(1));
    await waitFor(() => expect(verdictLine()).toBeNull());
  });

  it("falls back to the failure class when the doctor cannot be read", async () => {
    mount({ syncState: "error", syncDetail: "identity_locked", doctor: "refuse" });
    await waitFor(() =>
      expect(verdictLine()).toContain("Sync resumes once you open your identity on this device"),
    );
  });

  it("treats an unreadable vault frame as the frame's problem, not the credentials'", async () => {
    // The report has its own `unknown` authority state for a `vault.meta` this machine
    // could not read, and the FIVE FACTS stay out of it. The sentence is the same fact as a
    // head context that never built, so the panel says it rather than going silent.
    mount({
      syncState: "error",
      syncDetail: "sync_failed",
      doctor: { generation: "unreadable", authority: { state: "unknown" } },
    });
    await waitFor(() =>
      expect(verdictLine()).toContain("Your credentials are not the problem"),
    );
  });

  it("drops a stale report when the failure changes and the next read refuses", async () => {
    // The regression: a report that named cause A stayed on screen after the failure
    // became B, so the panel named a cause the current failure did not have, and a refused
    // re-read kept it there for good. Both halves are the same rule: a verdict describes one
    // moment, and the class-based fallback is what covers the moment after it.
    vi.useFakeTimers();
    try {
      invokeMock.mockImplementation(
        syncPanelCommandRouter({
          syncState: "error",
          syncDetail: "identity_locked",
          doctor: { authority: { state: "missing", cause: "no_key_at_rest" } },
        }),
      );
      renderSyncPanel();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(verdictLine()).toContain("This device holds no signing key");

      // Same state, a different failure tag, and a doctor that now refuses.
      invokeMock.mockImplementation(
        syncPanelCommandRouter({
          syncState: "error",
          syncDetail: "device_key_missing",
          doctor: "refuse",
        }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(verdictLine()).not.toContain("This device holds no signing key");
      expect(verdictLine()).toContain(
        "Sync resumes once you open your identity and this device is repaired",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not ask the doctor while sync is not failing", async () => {
    mount({ syncState: "idle" });
    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    // Give the effects the same number of beats a failing mount would need.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(doctorReads()).toBe(0);
    expect(verdictLine()).toBeNull();
  });
});
