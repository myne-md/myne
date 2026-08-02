// @vitest-environment jsdom
//
// Guards the screen-reader announcement contract for critical copy (MYND-93,
// task 9). Errors, suspicion warnings, destructive confirmations, and status
// toasts must carry a live-region role so a screen-reader user hears the state
// change without navigating to find it. These are the surfaces a blind user
// most needs announced; this test makes their `role`/`aria-live` load-bearing.

import { afterEach, describe, expect, it } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { Toaster } from "../../src/components/toast/Toaster";
import { toast, resetToasts } from "../../src/components/toast/toastStore";
import { SuspicionBanner } from "../../src/components/SuspicionBanner";
import { DestructiveBanner } from "../../src/components/DestructiveBanner";

afterEach(() => {
  resetToasts();
  cleanup();
});

describe("critical copy is a screen-reader live region", () => {
  it("Toast announces politely via role=status", () => {
    toast({ message: "Saved" });
    render(<Toaster />);
    const el = screen.getByRole("status");
    expect(el.getAttribute("aria-live")).toBe("polite");
  });

  it("SuspicionBanner announces assertively via role=alert", () => {
    render(<SuspicionBanner reason="vault-locked-during-change" />);
    const el = screen.getByRole("alert");
    expect(el.getAttribute("aria-live")).toBe("assertive");
  });

  it("DestructiveBanner is an alert region", () => {
    render(<DestructiveBanner testId="x">Permanent. This cannot be undone.</DestructiveBanner>);
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
