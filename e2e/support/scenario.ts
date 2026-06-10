// Scenario composition layer — owns the lifecycle every suite repeats:
// platform skip, launch, artifact-on-failure, teardown. Specs supply
// only their seed + assertions; forgetting `saveArtifacts` or leaking a
// driver process becomes structurally impossible (simplify pass on the
// e2e-harness feature; four more suites land on this).

import { afterEach, describe } from "vitest";
import { harnessSupported, launchApp, type AppSession, type LaunchOptions } from "./session";

const support = harnessSupported();
let warned = false;

/** `describe` that self-skips (with one honest reason line) when the
 *  platform/binary can't run the harness — macOS host, missing build. */
export const describeE2E: typeof describe | typeof describe.skip = support.ok
  ? describe
  : describe.skip;

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
