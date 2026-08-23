// @vitest-environment jsdom
//
// Changing the auto-lock timeout in Settings must reach the ALREADY-MOUNTED
// editor. myne-md/myne#556.
//
// # The defect this is written against, measured in a real browser
//
// `e2e-web/auto-lock-hidden-tab.e2e.ts` found that a web vault never
// auto-locks, and five measurements isolated it to propagation rather than to
// the timer:
//
//   1. the pref PERSISTS (survives a Settings close/reopen, re-read from disk);
//   2. a visible untouched tab does not lock 75s later;
//   3. a genuinely hidden tab does not lock either (68.0s, one transition each
//      way, recorded from the page);
//   4. the manual Lock button DOES lock, in under a second;
//   5. after a page RELOAD — so the editor mounts with the value already on
//      disk — it locks correctly, at ~63s for a 60s timeout.
//
// So `Editor.tsx`'s `useIdleAutoLock` stays armed with whatever
// `auto_lock_seconds` was at mount. Set it and keep working: the vault never
// locks. Set it and restart: it does. Which is the worse ordering, because the
// first is what anyone actually does — you change the setting BECAUSE you are
// about to rely on it.
//
// # Why this test mocks lower than the existing one
//
// `tests/hooks/usePrefs.test.ts` mocks the whole `src/lib/prefs` seam,
// `setAutoLockTimeout` included, with plain spies. Those spies do not bump the
// prefs nonce — so no test in that file can observe whether a real write
// reaches a SIBLING `usePrefs` instance, which is the entire subject here. That
// is a reasonable seam for what those tests are about, and it is also why this
// went unnoticed: `check-prefs-nonce.mjs` proves the call SHAPE, the unit tests
// mock the CALL, and nothing on either side exercises a second live consumer.
//
// So this mocks one layer down — `src/platform/core`'s `invoke` — and runs the
// real `src/lib/prefs`, the real `bumpPrefsNonce`, and the real subscription.
// Two `usePrefs()` instances stand in for Settings and the editor chrome.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

/** Disk truth, as the mocked `invoke` reports it. */
let stored: Record<string, unknown> = {};

const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
  if (command === "plugin:prefs|prefs_read") return { ...stored };
  if (command === "plugin:prefs|set_auto_lock_timeout") {
    stored = { ...stored, auto_lock_seconds: args?.seconds };
    return undefined;
  }
  return undefined;
});

vi.mock("../../src/platform/core", () => ({
  invoke: (command: string, args?: Record<string, unknown>) => invoke(command, args),
}));

import { usePrefs } from "../../src/hooks/usePrefs";
import { __resetPrefsNonceForTest } from "../../src/notes/prefsNonce";

function baseView(over: Record<string, unknown> = {}) {
  return { auto_lock_seconds: null, ...over };
}

describe("an auto-lock change reaches a sibling usePrefs instance (myne-md/myne#556)", () => {
  beforeEach(() => {
    __resetPrefsNonceForTest();
    stored = baseView();
    invoke.mockClear();
  });

  it("updates the editor's instance, not only the panel's", async () => {
    // Two independent consumers, exactly as production has them: SettingsModal
    // mounts its own `usePrefs`, and `Editor.tsx` holds `barPrefs` from another.
    const panel = renderHook(() => usePrefs());
    const editor = renderHook(() => usePrefs());

    // Both settle on disk truth first, or "it changed" below has no baseline.
    await waitFor(() => {
      expect(panel.result.current.prefs.auto_lock_seconds).toBe(null);
      expect(editor.result.current.prefs.auto_lock_seconds).toBe(null);
    });

    await act(async () => {
      await panel.result.current.setAutoLock(60);
    });

    // The panel's own instance updates optimistically — this is the assertion
    // that would pass on the broken build too, and it is here only so a failure
    // below cannot be confused with "the write did nothing".
    await waitFor(() => {
      expect(
        panel.result.current.prefs.auto_lock_seconds,
        "the panel that made the change does not show it, so nothing was written " +
          "at all and the sibling assertion below says nothing",
      ).toBe(60);
    });

    // …and the one that matters.
    await waitFor(() => {
      expect(
        editor.result.current.prefs.auto_lock_seconds,
        "a second, already-mounted usePrefs instance still reads the pre-change " +
          "value after the panel wrote it. In production that instance is " +
          "`barPrefs` in Editor.tsx, and it is what `useIdleAutoLock` takes its " +
          "timeout from — so setting auto-lock while the editor is open arms " +
          "nothing, and the vault never locks until the app is restarted.",
      ).toBe(60);
    });
  });
});
