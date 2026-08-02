// @vitest-environment jsdom
//
// Guards the toast polish (#238): the central store + <Toaster> stack and the
// headless <Toast> bridge.
//
//   1. Auto-dismiss survives re-renders. The timer lives on the Toaster row,
//      keyed on the toast's identity — not on any inline callback — so a stream
//      of parent re-renders no longer resets the countdown (the old bug left
//      toasts on screen indefinitely while the app was active).
//   2. The dismiss × removes the toast and notifies its owner.
//   3. Variants render their icon; multiple toasts stack.
//   4. The <Toast> bridge feeds the store.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Toaster } from "../../src/components/toast/Toaster";
import { toast, resetToasts } from "../../src/components/toast/toastStore";
import { Toast } from "../../src/components/Toast";

afterEach(() => {
  resetToasts();
  cleanup();
  vi.useRealTimers();
});

describe("auto-dismiss is robust to re-renders (#238)", () => {
  it("fires onDismiss after the duration despite repeated Toaster re-renders", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    toast({ message: "Saved", durationMs: 1000, onDismiss });

    const { rerender } = render(<Toaster />);
    act(() => {
      vi.advanceTimersByTime(20);
    });
    // Re-render the whole surface three times inside the window — each hands the
    // row a fresh inline onExpire; none must reset the timer.
    for (let i = 0; i < 3; i++) {
      act(() => {
        vi.advanceTimersByTime(300);
      });
      rerender(<Toaster />);
    }
    expect(onDismiss).not.toHaveBeenCalled(); // ~920 ms in

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("Toaster rendering + dismiss (#238)", () => {
  it("renders a toast as a polite live region", () => {
    toast({ message: "Saved" });
    render(<Toaster />);
    const el = screen.getByRole("status");
    expect(el.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByText("Saved")).toBeTruthy();
  });

  it("clicking the × removes the toast and notifies its owner", () => {
    const onDismiss = vi.fn();
    toast({ message: "Saved", onDismiss });
    render(<Toaster />);
    fireEvent.click(screen.getByTestId("editor.toast-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("a variant renders its status icon and variant class", () => {
    toast({ message: "Done", variant: "success" });
    render(<Toaster />);
    const el = screen.getByTestId("editor.toast");
    expect(el.className).toContain("myne-toast--success");
    // Leading status icon + the dismiss ×.
    expect(el.querySelectorAll("svg").length).toBeGreaterThanOrEqual(2);
  });

  it("stacks multiple toasts", () => {
    toast({ message: "A" });
    toast({ message: "B" });
    render(<Toaster />);
    expect(screen.getAllByRole("status").length).toBe(2);
  });
});

describe("headless <Toast> bridge (#238)", () => {
  it("feeds its message into the store so the Toaster renders it", () => {
    render(
      <>
        <Toast message="Hi there" onDone={() => {}} variant="info" />
        <Toaster />
      </>,
    );
    expect(screen.getByText("Hi there")).toBeTruthy();
    expect(screen.getByTestId("editor.toast").className).toContain("myne-toast--info");
  });
});
