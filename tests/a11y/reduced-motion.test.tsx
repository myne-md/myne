// @vitest-environment jsdom
//
// Reduced-motion guard (MYND-93, task 10). The acceptance: "the reduced-motion
// path does not hide state changes." Two halves:
//   1. MECHANISM — the global `@media (prefers-reduced-motion: reduce)` rule
//      zeroes animation + transition on every element, so nothing relies on
//      motion to be perceivable. This test pins that rule.
//   2. NON-MOTION STATE — the high-signal state surfaces convey their state via
//      TEXT + a live-region role, not animation alone, so zeroing motion can't
//      erase the signal (Toast shown here; banners covered by announce.test).
//
// The E2E variant that FORCES `prefers-reduced-motion` in the real WebView is
// gated on a harness capability gap: WebKitGTK has no WebDriver media-emulation
// hook and the suite is zero-hook, so forcing the media query is not yet wired.
// This Vitest guard verifies the actual requirement (motion zeroed + state
// text-bearing) without needing to force the query.

import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, cleanup, screen } from "@testing-library/react";
import { Toaster } from "../../src/components/toast/Toaster";
import { toast, resetToasts } from "../../src/components/toast/toastStore";

afterEach(() => {
  resetToasts();
  cleanup();
});

// `process.cwd()` (repo root under vitest), not `import.meta.url` — in the jsdom
// environment `import.meta.url` is not a file:// URL, so fileURLToPath throws.
const tokens = readFileSync(join(process.cwd(), "src/styles/tokens.css"), "utf8");

describe("reduced-motion zeroes motion without hiding state", () => {
  it("the global prefers-reduced-motion rule zeroes animation + transition", () => {
    const at = tokens.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(at).toBeGreaterThanOrEqual(0);
    const block = tokens.slice(at, at + 300);
    expect(block).toContain("*, *::before, *::after");
    expect(block).toMatch(/animation-duration:\s*0m?s\s*!important/);
    expect(block).toMatch(/transition-duration:\s*0m?s\s*!important/);
  });

  it("a status surface conveys its state by text (survives motion-zeroing)", () => {
    toast({ message: "Note saved" });
    render(<Toaster />);
    // The state is in the text + a live region — not in the entrance animation.
    const el = screen.getByRole("status");
    expect(el.textContent).toContain("Note saved");
    expect(el.getAttribute("aria-live")).toBe("polite");
  });
});
