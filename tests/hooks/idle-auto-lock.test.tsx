// @vitest-environment jsdom
//
// Page-driven idle auto-lock (phase3-web-client task 43).
//
// The one property worth testing is the one a naive implementation gets wrong:
// **a throttled background tab must still lock.** Browsers clamp a hidden tab's
// timers to about once a minute and may suspend them entirely, so a countdown
// built from ticks stops counting exactly when the user has walked away. Every
// case below is therefore about elapsed WALL TIME, not about how many ticks
// happened to fire.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useIdleAutoLock } from "../../src/hooks/useIdleAutoLock";

function Harness({ timeoutSecs, onIdle }: { timeoutSecs: number; onIdle: () => void }) {
  useIdleAutoLock({ timeoutSecs, onIdle, enabled: true });
  return null;
}

/** Drive the document's visibility, which jsdom leaves read-only by default. */
function setVisibility(state: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility("visible");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("idle auto-lock", () => {
  // The case the WEB scenario found and no test here covered: the timeout
  // arriving AFTER mount. In production `Editor.tsx` mounts with
  // `auto_lock_seconds` still `null` (`timeoutSecs` 0, so the hook is inert) and
  // the value lands moments later, once `usePrefs` has read the blob — or later
  // still, when the user changes it in Settings. Every other case in this file
  // renders with the timeout already set, which is the one shape the app never
  // has on a cold start.
  //
  // myne-md/myne#556: a web vault never auto-locks in a session where the pref
  // was set, and does lock after a reload — i.e. exactly when the value IS
  // present at mount.
  it("arms when the timeout arrives after mount, not only when it is set at mount", () => {
    const onIdle = vi.fn();
    const { rerender } = render(<Harness timeoutSecs={0} onIdle={onIdle} />);

    // Inert while the pref is unknown. Not a nicety: 0 means "no timeout", and
    // a hook that locked here would lock a vault the user never asked to lock.
    vi.advanceTimersByTime(120_000);
    expect(
      onIdle,
      "the hook fired with timeoutSecs 0, which means no auto-lock at all",
    ).not.toHaveBeenCalled();

    // …and now the value arrives.
    rerender(<Harness timeoutSecs={60} onIdle={onIdle} />);
    vi.advanceTimersByTime(61_000);
    expect(
      onIdle,
      "the timeout arrived after mount and the hook never armed. That is the " +
        "production shape on every cold start — Editor.tsx mounts before " +
        "usePrefs has read vault.prefs — and it is what leaves a web vault " +
        "unlocked forever (myne-md/myne#556).",
    ).toHaveBeenCalledTimes(1);
  });

  it("locks once the idle deadline passes", () => {
    const onIdle = vi.fn();
    render(<Harness timeoutSecs={60} onIdle={onIdle} />);

    vi.advanceTimersByTime(59_000);
    expect(onIdle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(6_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("activity resets the deadline", () => {
    const onIdle = vi.fn();
    render(<Harness timeoutSecs={60} onIdle={onIdle} />);

    vi.advanceTimersByTime(50_000);
    window.dispatchEvent(new Event("keydown"));
    vi.advanceTimersByTime(50_000);
    expect(onIdle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(15_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("a THROTTLED background tab still locks — the case a tick counter misses", () => {
    const onIdle = vi.fn();
    render(<Harness timeoutSecs={60} onIdle={onIdle} />);

    // Hidden tab: the browser clamps the 5 s interval to roughly one minute, so
    // a whole idle period passes with a single tick. A counter decremented per
    // tick would be nowhere near zero; a timestamp comparison is already past
    // the deadline on that one tick.
    setVisibility("hidden");
    vi.advanceTimersByTime(120_000);

    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("a SUSPENDED tab locks the moment it becomes visible again", () => {
    const onIdle = vi.fn();
    render(<Harness timeoutSecs={60} onIdle={onIdle} />);

    // The harsher case: timers do not fire at all while hidden (memory
    // pressure), so wall time moves without any tick. Evaluating on
    // `visibilitychange` is what catches it — and it must be evaluated BEFORE
    // the user can type, which is why becoming visible is not treated as
    // activity.
    setVisibility("hidden");
    vi.setSystemTime(Date.now() + 3_600_000);
    expect(onIdle).not.toHaveBeenCalled();

    setVisibility("visible");
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("fires once, and activity afterwards does not un-lock", () => {
    const onIdle = vi.fn();
    render(<Harness timeoutSecs={60} onIdle={onIdle} />);

    vi.advanceTimersByTime(120_000);
    expect(onIdle).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event("keydown"));
    vi.advanceTimersByTime(120_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("a timeout of zero disables locking entirely", () => {
    const onIdle = vi.fn();
    render(<Harness timeoutSecs={0} onIdle={onIdle} />);
    vi.advanceTimersByTime(3_600_000);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it("stops listening when unmounted", () => {
    const onIdle = vi.fn();
    const { unmount } = render(<Harness timeoutSecs={60} onIdle={onIdle} />);
    unmount();
    vi.advanceTimersByTime(3_600_000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});
