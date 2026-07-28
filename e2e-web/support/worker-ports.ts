// Per-worker port bands for the PARALLEL web-E2E run (MYND-574 task 105).
//
// The exact shape `e2e/support/worker-ports.ts` uses on the desktop lane, and
// deliberately so: vitest runs each `*.e2e.ts` file in a worker slot, and each
// concurrent slot here needs BOTH its own driver port and its own bundle-server
// port. Two slots sharing a bundle server would share an ORIGIN, and OPFS is
// keyed by origin — so a test's vault would be visible to its neighbour, which
// is the one isolation property this lane cannot do without.
//
// The band is 100 wide per slot, matching the desktop lane, so neither ever
// reaches into the next slot's range.
//
// Registered as a vitest `setupFiles` entry so it runs once per worker BEFORE
// the test module and its imports load.

/** vitest's 1-based worker slot; 1 when running outside a pool. */
const slot = Number(process.env.VITEST_POOL_ID ?? "1");
const band = (Number.isFinite(slot) && slot > 0 ? slot - 1 : 0) * 100;

/** Where this slot's browser driver (chromedriver / geckodriver) listens. */
export const DRIVER_PORT = 4544 + band;
/** Where this slot's bundle server listens. The test ORIGIN is derived from it. */
export const BUNDLE_PORT = 4545 + band;

// The BUNDLE port is always exported: the harness starts that server itself, so
// a value here is always real.
process.env.MYNE_WEB_E2E_BUNDLE_PORT ??= String(BUNDLE_PORT);

// The DRIVER port is NOT exported unconditionally, and that took a bug to get
// right. Setting it here made `harnessSupport` read "a driver is configured" on
// every machine — including one with no chromedriver at all — so the lane opened
// its gate and the smoke scenario failed instead of skipping. The env var is now
// an explicit OPT-IN that a human or CI sets to say "a driver is running"; this
// file only offsets it into the slot's band when it is already present, so
// parallel workers still do not collide.
if (process.env.MYNE_WEB_E2E_DRIVER_PORT !== undefined) {
  const requested = Number(process.env.MYNE_WEB_E2E_DRIVER_PORT);
  if (Number.isFinite(requested)) {
    process.env.MYNE_WEB_E2E_DRIVER_PORT = String(requested + band);
  }
}
