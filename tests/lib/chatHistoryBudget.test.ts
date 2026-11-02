// The one number that exists on both sides of the IPC boundary
// (myne-md/myne#617).
//
// The host CLAMPS the chat-history seed budget at the write, because that
// number bounds how much of the user's plaintext one run sends to a provider,
// multiplied by the loop's iteration ceiling, and TB13 records that no other
// per-run volume cap exists. The settings input needs the same number to render
// a `max` attribute, so it is written twice.
//
// **Twice is fine; twice-and-unchecked is not.** A UI whose bound agrees with
// the host's by accident is the shape this repo keeps finding, and the failure
// is quiet in the direction that matters: raise the Rust ceiling and the input
// silently keeps offering the old one, or lower it and the input offers a value
// every write will reduce, with no error the user can act on. This test reads
// the Rust file and fails when the two drift, the same mechanism
// `agentBulkApproval.test.ts` uses to hold the marker rosters together.

import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  CHAT_HISTORY_BUDGET_DEFAULT,
  CHAT_HISTORY_BUDGET_MAX,
} from "../../src/lib/agent-run";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HISTORY_RS = join(REPO, "core", "src", "plugins", "agent", "history.rs");

/** The value of a `pub const NAME: usize = …;` in the Rust source. */
function rustConst(source: string, name: string): number {
  const m = new RegExp(`pub const ${name}: usize = ([0-9_]+);`).exec(source);
  if (m === null) {
    // Panics rather than returning a default, for the reason `hide.rs`'s own
    // roster test gives: a missing input compares equal to nothing and the test
    // passes having read no source at all.
    throw new Error(
      `${name} not found in core/src/plugins/agent/history.rs. If it moved or ` +
        `was renamed, this test has to follow it rather than be deleted: it is ` +
        `the only thing holding the settings input's bound to the host's.`,
    );
  }
  return Number.parseInt(m[1]!.replace(/_/g, ""), 10);
}

describe("the agent history budget", () => {
  const source = readFileSync(HISTORY_RS, "utf8");

  it("has the same ceiling on both sides of the IPC boundary", () => {
    expect(CHAT_HISTORY_BUDGET_MAX).toBe(rustConst(source, "MAX_HISTORY_BUDGET"));
  });

  /// The default is BELOW the ceiling, which is the only relationship between
  /// the two that has to hold, and would catch a ceiling lowered under an
  /// unchanged default.
  it("has a default below its own ceiling", () => {
    expect(rustConst(source, "DEFAULT_HISTORY_BUDGET")).toBeLessThan(
      rustConst(source, "MAX_HISTORY_BUDGET"),
    );
  });

  /// The default IS mirrored in TS since issue #970, and only for display: the
  /// settings input's empty state has to name the number an empty field means,
  /// or "leave empty for the default" says a default exists without saying what
  /// it is. It is checked here rather than trusted, because a mirror nothing
  /// reads is the same shape as the ceiling's own mirror going stale.
  it("has the same default on both sides of the IPC boundary", () => {
    expect(CHAT_HISTORY_BUDGET_DEFAULT).toBe(rustConst(source, "DEFAULT_HISTORY_BUDGET"));
  });
});
