// Scenario composition layer — owns the lifecycle every suite repeats:
// platform skip, launch, artifact-on-failure, teardown. Specs supply
// only their seed + assertions; forgetting `saveArtifacts` or leaking a
// driver process becomes structurally impossible (simplify pass on the
// e2e-harness feature; four more suites land on this).

import { afterEach, describe } from "vitest";
import { harnessSupported, launchApp, type AppSession, type LaunchOptions } from "./session";
import { recordWait } from "./webdriver";
import { vaultDirState } from "./fixtures";

const support = harnessSupported();
let warned = false;

// Quarantine gate (flaky-test epic). A `describeE2E.flaky(...)` spec is a
// KNOWN contention-victim: a mount that never paints within budget on a
// contended CI runner (verified cross-branch in the flakiness profile, NOT a
// logic bug). The `e2e` step SKIPS these; the `e2e-quarantine` step
// (`MYNE_E2E_QUARANTINE=1`) runs ONLY these. Keep the flaky set SHORT and
// visible: a quarantined spec is a debt to pay down (deterministic mount signal
// or contention fix), never a place to bury a real failure. `describeE2E.flaky`
// is a describe.skip in a normal run.
//
// Neither step blocks a merge, and this comment said one of them did until
// myne-md/myne#579. Both live in `.woodpecker/e2e.yml`, which runs on a manual
// trigger before a release and on no push or pull request; `e2e` is
// `failure: ignore` there and `e2e-floor` is the only step that can redden the
// run. So what quarantining a spec actually costs is its place in `e2e-floor`'s
// counted set (`scripts/e2e-scenario-floor.json`), which is the number a release
// reads.
const quarantineOnly = process.env.MYNE_E2E_QUARANTINE === "1";

function gate(isFlaky: boolean): typeof describe | typeof describe.skip {
  if (!support.ok) return describe.skip;
  // Stable run → everything EXCEPT flaky; quarantine run → ONLY flaky.
  return quarantineOnly === isFlaky ? describe : describe.skip;
}

/** `describe` that self-skips (with one honest reason line) when the
 *  platform or binary cannot run the harness (a macOS host, a missing build).
 *  `.flaky` marks a quarantined contention-victim scenario (see the gate note
 *  above): skipped in the stable run, run only in the quarantine one. */
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
  // The per-scenario FIXED cost (seed the fixture vault, spawn the driver and
  // the app, wait for the handshake), recorded as a wait so the profiler can put
  // it beside the in-test waits it competes with. Across the whole suite this is
  // the floor and the first thing to look at when asking whether a shard count
  // is the lever or the waits are.
  const launchStarted = Date.now();
  const app = await launchApp(opts);
  recordWait(`[launch] ${label}`, Date.now() - launchStarted, false);
  current = app;
  try {
    await body(app);
  } catch (e) {
    await app.saveArtifacts(label);
    // **What the app could SEE, appended to what it DID.** The boot probe added
    // to `unlockToEditor` reported that six scenarios were sitting on the
    // WELCOME screen, which `initialStageFromProbe` reaches on exactly one
    // input: `vault_list` answered with zero vaults. The seed runs to
    // completion before the process spawns, so "the seed was late" is already
    // ruled out and the remaining explanations split on one fact this line
    // supplies and nothing else could — whether the vault is on disk at the
    // moment of failure. Populated means the app read a different place or
    // dropped what it read; empty means something removed it after the
    // generator wrote it.
    //
    // Structural only (names of directories the harness itself created, plus a
    // presence bit), so nothing here can carry vault content into a CI log.
    throw new Error(`${(e as Error).message}\n  vault dir: ${vaultDirState(app.appDataDir)}`, {
      cause: e,
    });
  } finally {
    current = null;
    await app.teardown();
  }
}
