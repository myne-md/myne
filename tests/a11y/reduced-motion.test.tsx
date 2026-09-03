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
// The E2E variant now EXISTS — `e2e/reduced-motion.e2e.ts` (rm1,
// myne-md/myne#555). The gap recorded here was real about WebDriver and wrong
// about the platform: WebKitGTK does not take the preference from a driver
// command, it takes it from GTK, and GTK takes it from
// `$XDG_CONFIG_HOME/gtk-3.0/settings.ini` — a file the harness already owns,
// because it points `XDG_CONFIG_HOME` at a per-scenario temp tree before
// launch. So the query is forced through the real OS-level path and the suite's
// zero-hook rule is intact. Measured: the WebView reports
// `prefers-reduced-motion: reduce`, and rm1 asserts that before anything else
// precisely so a lever that stopped connecting fails loudly instead of turning
// the whole scenario into a vacuous pass.
//
// The split between the two files: this one pins the STYLESHEET (the rule is
// declared, and state surfaces carry text rather than motion); rm1 pins the
// EFFECT (nothing on screen still animates, and the one documented exemption
// still does).

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
