// The web lane's self-skip logic (MYND-574 task 105).
//
// This is the part of a test harness that decides whether it is honest when it
// cannot run. The desktop lane learned the failure mode: a suite that skips
// silently is a suite that has been skipping for three weeks with nobody
// noticing, and a suite that reports one merged "harness unavailable" sends
// people to the wrong fix.
//
// So each reason is asserted to NAME its own fix, and the ordering is asserted
// too — an unsupported browser must not be reported as a missing bundle just
// because the bundle also happens to be absent.

import { describe, expect, it } from "vitest";
import { harnessSupport, SUPPORTED_BROWSERS } from "../../e2e-web/support/harness";

const present = () => true;
const absent = () => false;
const base = { bundleDir: "web/dist", driverConfigured: true, browser: "chrome" };

describe("when it can run", () => {
  it("says so with no reason attached", () => {
    expect(harnessSupport(base, present)).toEqual({ ok: true });
  });

  it("accepts every browser in the matrix", () => {
    for (const browser of SUPPORTED_BROWSERS) {
      if (browser === "safari" && process.platform !== "darwin") continue;
      expect(harnessSupport({ ...base, browser }, present).ok).toBe(true);
    }
  });
});

describe("when it cannot", () => {
  function reasonFor(env: Partial<typeof base>, exists = present) {
    const s = harnessSupport({ ...base, ...env }, exists);
    expect(s.ok).toBe(false);
    return s.ok ? "" : s.reason;
  }

  it("names `pnpm web:build` for a missing bundle", () => {
    expect(reasonFor({}, absent)).toContain("pnpm web:build");
  });

  it("names the driver env var and the pinning rule for a missing driver", () => {
    const r = reasonFor({ driverConfigured: false });
    expect(r).toContain("MYNE_WEB_E2E_DRIVER_PORT");
    // The pinning rule travels with the instruction, so nobody closes the gap
    // with an unpinned `npx …  install` — which is the exact thing the
    // 2026-07-27 decision forbids in a blocking step.
    expect(r).toMatch(/pinned/i);
  });

  it("names the matrix for an unknown browser", () => {
    const r = reasonFor({ browser: "edge" });
    expect(r).toContain("edge");
    expect(r).toContain("chrome");
  });

  /**
   * Ordering, and it is not cosmetic. A run configured for a browser this lane
   * does not support must say THAT — reporting "no bundle" because the bundle
   * also happens to be missing sends someone to build a bundle that will not
   * help.
   */
  it("reports the browser problem first when several are true at once", () => {
    const r = reasonFor({ browser: "edge", driverConfigured: false }, absent);
    expect(r).toContain("edge");
    expect(r).not.toContain("pnpm web:build");
  });

  /** Safari is a macOS gate, and the reason says so rather than pretending the
   *  browser is unknown — the distinction a contributor on Linux needs. */
  it("explains the Safari seat rather than rejecting it as unknown", () => {
    if (process.platform === "darwin") return;
    const r = reasonFor({ browser: "safari" });
    expect(r).toContain("macOS");
    expect(r).not.toContain("is not one of");
  });

  it("always gives exactly one sentence-shaped reason, never an empty string", () => {
    for (const env of [
      { browser: "edge" },
      { driverConfigured: false },
      {},
    ] as Array<Partial<typeof base>>) {
      const r = reasonFor(env, env.browser === undefined && env.driverConfigured === undefined ? absent : present);
      expect(r.length).toBeGreaterThan(20);
    }
  });
});
