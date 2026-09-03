// The web lane's gate: skip honestly, and say why once (MYND-574 task 105).
//
// The desktop analogue is `e2e/support/scenario.ts`, and this is deliberately
// the same shape — `describeE2E`, `describeE2E.flaky`, one warning at import
// time — so a contributor who knows one lane knows this one.
//
// **What it does NOT have yet: the session half.** `scenario(label, opts, body)`
// (launch → run → save artifacts on throw → tear down in `finally`) needs a
// browser session to launch, and the driver layer is not written. Adding a
// `scenario()` that *looked* right and had never been run would be the exact
// failure this feature keeps catching. So the gate — the part that decides
// whether the lane is honest when it cannot run, and the part that IS testable
// without a browser — ships now, and the session half lands with the driver.

import { describe } from "vitest";
import { harnessEnv, harnessSupport, type Support } from "./harness";

const support: Support = harnessSupport(harnessEnv());
let warned = false;

// Quarantine gate, mirroring the desktop lane's `MYNE_E2E_QUARANTINE=1`: the
// stable run skips known contention-victims, and a separate run takes ONLY
// those. Keep the flaky set short and visible: a quarantined scenario is a debt,
// never a place to bury a real failure.
//
// This comment said "the blocking step" until myne-md/myne#579, and on this lane
// that was true: `e2e-web` was a blocking per-push gate. It is not one now. The
// lane lives in `.woodpecker/e2e.yml`, runs on a manual trigger before a release
// and on no push or pull request, so no change can go red on it either way.
const quarantineOnly = process.env.MYNE_WEB_E2E_QUARANTINE === "1";

function gate(isFlaky: boolean): typeof describe | typeof describe.skip {
  if (!support.ok) return describe.skip;
  return quarantineOnly === isFlaky ? describe : describe.skip;
}

/** `describe` that self-skips with one honest reason when the lane cannot run. */
export const describeE2E = Object.assign(gate(false), { flaky: gate(true) });

/** The reason, printed once. Called at import time so even a filtered run that
 *  matches nothing explains itself — a silently skipping suite is a suite that
 *  has been skipping for three weeks with nobody noticing. */
export function skipReason(): string | undefined {
  if (!support.ok && !warned) {
    warned = true;
    // eslint-disable-next-line no-console
    console.warn(`[e2e-web] suite skipped: ${support.reason}`);
  }
  return support.ok ? undefined : support.reason;
}

skipReason();
