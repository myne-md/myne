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
