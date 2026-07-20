// Scenario composition layer — owns the lifecycle every suite repeats:
// platform skip, launch, artifact-on-failure, teardown. Specs supply
// only their seed + assertions; forgetting `saveArtifacts` or leaking a
// driver process becomes structurally impossible (simplify pass on the
// e2e-harness feature; four more suites land on this).

import { afterEach, describe } from "vitest";
import { harnessSupported, launchApp, type AppSession, type LaunchOptions } from "./session";

const support = harnessSupported();
let warned = false;

// Quarantine gate (flaky-test epic). A `describeE2E.flaky(...)` spec is a
// KNOWN contention-victim: a mount that never paints within budget on a
// contended CI runner (verified cross-branch in the flakiness profile — NOT a
// logic bug). The blocking `e2e` step SKIPS these so an unrelated PR can't go
// red on someone else's flake; the non-blocking `e2e-quarantine` step
// (`MYNE_E2E_QUARANTINE=1`, `failure: ignore`) runs ONLY these and reports
// without gating. Keep the flaky set SHORT and visible: a quarantined spec is a
// debt to pay down (deterministic mount signal / contention fix), never a place
// to bury a real failure. `describeE2E.flaky` is a describe.skip in a normal run.
const quarantineOnly = process.env.MYNE_E2E_QUARANTINE === "1";

function gate(isFlaky: boolean): typeof describe | typeof describe.skip {
  if (!support.ok) return describe.skip;
  // Stable run → everything EXCEPT flaky; quarantine run → ONLY flaky.
  return quarantineOnly === isFlaky ? describe : describe.skip;
}

/** `describe` that self-skips (with one honest reason line) when the
 *  platform/binary can't run the harness — macOS host, missing build.
 *  `.flaky` marks a quarantined contention-victim scenario (see the gate note
 *  above): skipped in the blocking run, run only in the non-blocking one. */
export const describeE2E = Object.assign(gate(false), { flaky: gate(true) });

export function skipReason(): string | undefined {
  if (!support.ok && !warned) {
    warned = true;
    // eslint-disable-next-line no-console
    console.warn(`[e2e] suite skipped: ${support.reason}`);
  }
  return support.reason;
}
// Emit the warning at module-import time so even an empty filtered run
// explains itself.
skipReason();

/** Tracks the live session so `afterEach` can clean up regardless of
 *  how the scenario body exited. One app at a time by config. */
let current: AppSession | null = null;

afterEach(async () => {
  if (current) {
    await current.teardown();
    current = null;
  }
});

/**
 * Run one scenario: launch (with optional seed), execute `body`, save
 * failure artifacts under `label` if it throws, always tear down.
 */
export async function scenario(
  label: string,
  opts: LaunchOptions,
  body: (app: AppSession) => Promise<void>,
): Promise<void> {
  const app = await launchApp(opts);
  current = app;
  try {
    await body(app);
  } catch (e) {
    await app.saveArtifacts(label);
    throw e;
  } finally {
    current = null;
    await app.teardown();
  }
}
