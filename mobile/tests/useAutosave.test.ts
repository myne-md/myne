// @vitest-environment jsdom
// The phone editor autosaves (myne-md/myne#1037 review).
//
// This is the branch's headline mobile fix and it had no test: deleting both
// effects left the whole mobile suite green. What is asserted is the cadence, not
// the writer: one write after the idle window, and one per ceiling while the text
// keeps changing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  AUTOSAVE_IDLE_MS,
  AUTOSAVE_MAX_MS,
  useAutosave,
} from "../src/app/flows/editor/chrome/useAutosave";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useAutosave", () => {
  it("writes once the typing stops, and not before", () => {
    const persist = vi.fn();
    const { rerender } = renderHook(({ text }) => useAutosave(text, true, persist), {
      initialProps: { text: "a" },
    });
    vi.advanceTimersByTime(AUTOSAVE_IDLE_MS - 50);
    expect(persist).not.toHaveBeenCalled();
    rerender({ text: "ab" });
    // The second keystroke restarted the window: the first one never fired.
    vi.advanceTimersByTime(AUTOSAVE_IDLE_MS + 1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("keeps writing under continuous typing, at the ceiling", () => {
    const persist = vi.fn();
    const { rerender } = renderHook(({ text }) => useAutosave(text, true, persist), {
      initialProps: { text: "a" },
    });
    for (let i = 0; i < 20; i++) {
      rerender({ text: `a${i}` });
      vi.advanceTimersByTime(100);
    }
    // Two seconds of unbroken typing: the idle timer never fired, the ceiling did.
    expect(persist).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(AUTOSAVE_MAX_MS);
    expect(persist).toHaveBeenCalled();
  });

  it("does nothing while disabled", () => {
    const persist = vi.fn();
    renderHook(({ text }) => useAutosave(text, false, persist), {
      initialProps: { text: "a" },
    });
    vi.advanceTimersByTime(AUTOSAVE_MAX_MS * 2);
    expect(persist).not.toHaveBeenCalled();
  });
});
