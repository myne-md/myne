// The CLI-write invalidation event name, on both sides of the boundary (#258).
//
// The `myne` CLI writes into the same vault the editor has open. Nothing told
// the editor, so an open pane kept its stale body and base hash and the next
// autosave wrote them straight over the CLI's append — with sync off there is no
// base-hash guard to catch it, and the snapshot window hides the loss because
// the overwriting save coalesces with the pane's earlier ones.
//
// The fix is an event, and an event name is a string on each side that no
// compiler relates to the other. Drift here does not fail a build: it produces
// an editor that has silently stopped noticing CLI writes, which is exactly the
// bug again. So assert the two literals agree — the same duplicated-by-design
// contract `scripts/check-cli-sidecar.mjs` keeps for the socket basenames.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CLI_NOTES_CHANGED_EVENT } from "../../src/lib/cli-access";

const RUST_SOURCE = "src-tauri/src/cli_bridge/dispatch.rs";

describe("CLI notes-changed event", () => {
  it("matches the constant the Rust bridge emits", () => {
    const rust = readFileSync(RUST_SOURCE, "utf8");
    const match = rust.match(
      /pub const CLI_NOTES_CHANGED_EVENT: &str = "([^"]+)";/,
    );
    expect(
      match,
      `${RUST_SOURCE} must declare CLI_NOTES_CHANGED_EVENT`,
    ).not.toBeNull();
    expect(match?.[1]).toBe(CLI_NOTES_CHANGED_EVENT);
  });

  it("is emitted on every CLI write path", () => {
    // Both writers, not one: `daily --append` is the destructive case and
    // `new` is the one whose note simply did not appear until a restart.
    const rust = readFileSync(RUST_SOURCE, "utf8");
    const emits = rust.match(/self\.notify_notes_changed\(\)/g) ?? [];
    expect(
      emits.length,
      "both create_note and daily_append must announce their write",
    ).toBeGreaterThanOrEqual(2);
  });
});
