// Build the fixture generator BEFORE any test's budget starts — myne-md/myne#555,
// the "un-quarantine first" step.
//
// # The measurement this exists for
//
// `nav1` was quarantined as a runner-contention victim, then re-diagnosed twice
// (the `clickNewMenuItem` re-click, then the driver port). Neither closed it: on
// an idle machine, in a warm container, `--retry=0`, it still failed roughly one
// run in five, always as `Test timed out in 180000ms`.
//
// Instrumenting the scenario end to end found where the time goes, and it is not
// in the scenario:
//
//     OUTER before-scenario  @      0 ms
//     OUTER seed-start       @      1 ms
//     OUTER seed-done        @ 171311 ms   <-- here
//     OUTER body-entered     @ 171724 ms
//     …the entire back/forward walk…
//     OUTER scenario-returned@ 178399 ms
//
// The navigation logic the scenario is about takes **6.4 seconds**. The other
// 171 are `seedVault` → `ensureGeneratorBuilt()` → `cargo build --release -p
// e2e-fixture-gen`, memoized per PROCESS and therefore paid, lazily, by whichever
// test happens to seed first in that process. Against a 180 s `testTimeout` that
// is a coin flip, and every property the earlier diagnoses could not explain
// falls out of it at once:
//
//  * **bimodal durations.** The binary is either already in the shared target
//    volume or it is not; there is no middle.
//  * **a different victim every run.** The cost lands on the first SEEDING test
//    in a worker process, which is a different file every time.
//  * **raising `DEFAULT_TIMEOUT_MS` fixed nothing.** No inner wait is involved;
//    the budget being exceeded is the OUTER one, and 180 s is already just above
//    the build.
//  * **it reproduces on an idle machine.** Nothing is contended. The build is
//    simply slow.
//  * **`e2e-one.sh` hits it almost every time.** Each invocation is a fresh
//    `--rm` container, so the first spec in it always seeds cold.
//
// `ensureGeneratorBuilt`'s own comment says the memoization is there so seeds
// pay "no cargo startup / target-lock cost inside test budgets". The memoization
// does that for the SECOND seed onward. The first one still pays all of it, and
// that is the whole of this bug.
//
// # Why a globalSetup rather than a line in the runner scripts
//
// The four local runners (`e2e-local.sh`, `e2e-buildrun.sh`, `e2e-batch.sh`,
// `e2e-one.sh`) could each prepend a `cargo build`, and CI's `e2e` step invokes
// vitest directly, so that would be five copies of one rule and the CI copy is
// the one that matters. `globalSetup` runs once per vitest invocation, before
// any worker starts and outside every test budget, which is exactly the property
// wanted — and it covers CI and all four scripts with one edit.
//
// # It is deliberately not silent, and deliberately not fatal
//
// A cold build prints how long it took, because "the suite paused for three
// minutes" with no output is how this went undiagnosed for three rounds. And a
// FAILED build does not abort the run: the generator is unreachable on a
// non-Linux host (the whole suite self-skips there), and turning a skip into a
// hard error would break `pnpm test:e2e` on a developer's Mac for no gain. The
// failure surfaces at the first seed, where it always did, with the same message
// it always had.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const GENERATOR_BIN = join(REPO_ROOT, "target", "release", "e2e-fixture-gen");

export default function globalSetup(): void {
  // The suite self-skips off Linux (`support/scenario.ts`), so a Mac or Windows
  // invocation must not spend three minutes building a binary nothing will run.
  if (process.platform !== "linux") return;

  // NO `existsSync` shortcut, and that is a correction rather than an omission.
  // The first draft returned early when the binary was already on disk, and the
  // build STILL cost 167 s inside the test — because the expensive part is not
  // producing a missing binary, it is cargo re-checking the workspace under the
  // release profile after `pnpm tauri build` has touched it. The freshness
  // question is cargo's to answer, and the only thing that matters here is
  // WHERE it answers it: outside a test budget rather than inside one.
  const alreadyBuilt = existsSync(GENERATOR_BIN);
  const started = Date.now();
  try {
    execFileSync("cargo", ["build", "--quiet", "--release", "-p", "e2e-fixture-gen"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "inherit", "inherit"],
      timeout: 600_000,
    });
    // Loud on purpose: a silent three-minute pause is what made this look like
    // a flaky navigation test for three diagnosis rounds.
    const secs = Math.round((Date.now() - started) / 1000);
    console.error(
      `[e2e] e2e-fixture-gen ready in ${secs}s ` +
        `(${alreadyBuilt ? "re-checked" : "built"}, outside every test budget — ` +
        `see e2e/support/global-setup.ts)`,
    );
  } catch {
    // Not fatal. See the header: the first seed reports the real failure with
    // the message it has always had, and an off-platform run must stay a skip.
    console.error(
      "[e2e] could not pre-build e2e-fixture-gen; the first seeding test will " +
        "build it inside its own budget and may time out",
    );
  }
}
