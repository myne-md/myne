// @vitest-environment jsdom
//
// The "add this to your PATH" hint appears exactly where it can help —
// myne-md/myne#555, the `cli.path_shim` bullets:
//
//   > the UI half is `showPathHint` behind `settings.cli-access-path-hint`,
//   > drivable by launching with a PATH that omits the shim dir.
//
//   > the Windows claim is a pure conditional (`showPathHint` requires
//   > `shimDir !== null`, and the Rust answers `ShimOutcome::Unsupported`): a
//   > component test plus the existing outcome-label test.
//
// # Three inputs, and each wrong answer fails differently
//
// The hint is `enabled && !commandOnPath && shimDir !== null`, and the three
// conjuncts are not interchangeable:
//
//  * **enabled** — the door is shut, so telling someone how to reach a door
//    that refuses them is noise at best;
//  * **!commandOnPath** — `myne` already resolves, so the hint is advice to fix
//    something that is not broken, in a settings panel, permanently;
//  * **shimDir !== null** — there IS no directory to point at. This is the
//    Windows arm (`ShimOutcome::Unsupported`) and the failure it prevents is the
//    worst of the three: the hint would render its `export PATH=…` line with
//    the directory interpolated as `null`, which is a command that looks
//    authoritative and cannot work.
//
// A hand-walk reaches at most one of these on the machine it runs on: the
// developer's `$PATH` either has the shim dir or does not, and nobody has a
// Windows box in the loop. All four combinations are one prop away here.
//
// # Why the copy is asserted by literal
//
// The hint's whole value is the pasteable line. Asserting only that the block
// rendered would pass on a hint whose `dir` interpolated to `undefined` — which
// is exactly the shape the third conjunct exists to prevent. So the rendered
// directory is checked against the value that was fed in.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

/** What the backend reports for this render. */
let cliState = {
  lastUsedSecsAgo: null as number | null,
  commandOnPath: false,
  shimDir: null as string | null,
};

vi.mock("../../src/lib/cli-access", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/cli-access")>();
  return { ...actual, readCliAccessState: async () => cliState };
});

const { CliAccessSettings } = await import("../../src/components/settings/CliAccessSettings");

const SHIM_DIR = "/home/kullanici/.local/bin";

function mount(enabled: boolean) {
  render(
    <CliAccessSettings
      enabled={enabled}
      excludedFolders={[]}
      rateLimitDisabled={null}
      onSetEnabled={vi.fn()}
      onSetExcludedFolders={vi.fn()}
      onSetRateLimitDisabled={vi.fn()}
    />,
  );
}

/** The hint, or null. */
function hint() {
  return screen.queryByTestId("settings.cli-access-path-hint");
}

beforeEach(() => {
  cliState = { lastUsedSecsAgo: null, commandOnPath: false, shimDir: null };
});

afterEach(cleanup);

describe("the CLI PATH hint", () => {
  it("shows, with the real directory, when the door is open and the command is not found", async () => {
    // The positive case first. Every absence below would otherwise be
    // satisfiable by a component that renders no hint under any condition.
    cliState = { lastUsedSecsAgo: null, commandOnPath: false, shimDir: SHIM_DIR };
    mount(true);
    const block = await screen.findByTestId("settings.cli-access-path-hint");
    expect(
      block.textContent ?? "",
      `the hint rendered without the shim directory in it. Its entire value is a ` +
        `line the user can paste into a shell; one with the directory missing is ` +
        `a command that looks authoritative and does nothing.`,
    ).toContain(SHIM_DIR);
  });

  it("stays hidden when the command already resolves on PATH", async () => {
    cliState = { lastUsedSecsAgo: null, commandOnPath: true, shimDir: SHIM_DIR };
    mount(true);
    await screen.findByTestId("settings.cli-access");
    expect(
      hint(),
      "the hint tells a user to fix their PATH when `myne` already resolves — " +
        "advice to repair something that is not broken, sitting in Settings " +
        "permanently",
    ).toBeNull();
  });

  it("stays hidden when the door is shut", async () => {
    cliState = { lastUsedSecsAgo: null, commandOnPath: false, shimDir: SHIM_DIR };
    mount(false);
    await screen.findByTestId("settings.cli-access");
    expect(
      hint(),
      "the hint explains how to reach a door that is closed, which is the one " +
        "state where reaching it would be refused anyway",
    ).toBeNull();
  });

  it("stays hidden where there is no shim directory at all — the Windows arm", async () => {
    // `ShimOutcome::Unsupported` on the Rust side arrives here as `shimDir:
    // null`. This is the conjunct whose failure is worst: without it the hint
    // renders its `export PATH=…` line with `null` interpolated where a
    // directory should be.
    cliState = { lastUsedSecsAgo: null, commandOnPath: false, shimDir: null };
    mount(true);
    await screen.findByTestId("settings.cli-access");
    expect(
      hint(),
      "the hint rendered on a platform that reports no shim directory. There is " +
        "nothing to point at, so the pasteable line would carry `null` where a " +
        "path belongs — a command that reads as authoritative and cannot work.",
    ).toBeNull();
  });

  it("stays hidden before the first state read has answered", async () => {
    // `UNKNOWN_CLI_ACCESS_STATE` is the initial value AND the value a failed
    // read falls back to, and it carries `shimDir: null` precisely so the hint
    // is absent rather than half-built. Asserted synchronously, before the
    // promise resolves.
    cliState = { lastUsedSecsAgo: null, commandOnPath: false, shimDir: SHIM_DIR };
    mount(true);
    expect(
      hint(),
      "the hint rendered on the frame before the backend had answered, so a " +
        "user sees it flash in with whatever the default state happened to be",
    ).toBeNull();
  });

});
