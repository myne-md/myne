// Harness wiring spec — the only E2E file that runs WITHOUT the driver.
//
// Purpose: prove the `pnpm test:e2e` entry point, the separate Vitest
// config, and the support-module surface on any platform (including the
// macOS dev machine, where tauri-driver cannot run — SYNC-1). Real
// scenarios live in their own `*.e2e.ts` files and self-skip via
// `harnessSupported()` when the platform/binary is unavailable.

import { describe, expect, it } from "vitest";
import {
  UNLOCK_NON_DISTINGUISHING_BANNER,
  RECOVERY_NON_DISTINGUISHING_BANNER,
} from "../src/lib/load-bearing-copy";
import { Session, WebDriverError } from "./support/webdriver";
import { defaultAppPath, driverBinary, harnessSupported } from "./support/session";

describe("e2e harness wiring", () => {
  it("support modules load and expose the expected surface", () => {
    expect(typeof Session).toBe("function");
    expect(typeof WebDriverError).toBe("function");
    expect(defaultAppPath()).toContain("myne-desktop");
    expect(driverBinary().length).toBeGreaterThan(0);
  });

  it("platform preflight yields an actionable verdict", () => {
    const verdict = harnessSupported();
    if (!verdict.ok) {
      // Off-platform (e.g. macOS dev machine): the reason must point at
      // the container workflow, not leave a bare failure.
      expect(verdict.reason).toMatch(/container|docs\/dev\/e2e\.md|MYNE_E2E_APP/);
    } else {
      expect(verdict.reason).toBeUndefined();
    }
  });

  it("load-bearing banner literals are importable for full-literal asserts (SYNC-8)", () => {
    expect(UNLOCK_NON_DISTINGUISHING_BANNER).toBe(
      "Wrong password or vault file is corrupted.",
    );
    expect(RECOVERY_NON_DISTINGUISHING_BANNER).toBe(
      "Phrase or vault file is invalid. Please try again.",
    );
  });
});
