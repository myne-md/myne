// myne#291 — the snapshot-write-failure event name, pinned across all three
// places that spell it.
//
// The web hook emitted a HARDCODED literal, and it was the wrong one: plural
// (`snapshots://write-failed`) where the canonical constant is singular. Nothing
// compared the two strings — not the compiler, not clippy, not any `scripts/`
// guard — so it landed green. The Worker host demultiplexes events by exact
// `Map` key, so the message was simply dropped, and the silent-snapshot-failure
// warning would have shipped dead on the web client the moment that client got
// a real snapshot writer. That is precisely the failure the event exists to
// surface.
//
// This test lives in the JS lane deliberately. The obvious home — a `#[test]` in
// `web/wasm/src/hooks.rs` — never runs: that module is `#[cfg(target_arch =
// "wasm32")]`, so `cargo test -p myne-web-wasm` (a host build) compiles it out
// entirely. An assertion that cannot run is the same class of defect as the one
// it is meant to catch.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");

/** The one canonical spelling, declared in `core/src/plugins/notes/commands.rs`. */
function rustConstant(): string {
  const src = read("core/src/plugins/notes/commands.rs");
  const m = /pub const SNAPSHOT_WRITE_FAILED_EVENT: &str = "([^"]+)";/.exec(src);
  expect(m, "SNAPSHOT_WRITE_FAILED_EVENT must be declared in core").not.toBeNull();
  return m![1]!;
}

describe("the snapshot-write-failure event name", () => {
  it("is spelled the same in Rust and in the TS listener", () => {
    const ts = read("src/notes/components/SnapshotFailedIndicator.tsx");
    const m = /const SNAPSHOT_WRITE_FAILED_EVENT = "([^"]+)";/.exec(ts);
    expect(m, "the TS mirror must declare the event name").not.toBeNull();
    expect(m![1]).toBe(rustConstant());
  });

  it("is emitted by the web hook through the constant, never a literal", () => {
    // The desktop hook already used the constant; only web hardcoded it.
    const hooks = read("web/wasm/src/hooks.rs");
    expect(hooks).toContain("SNAPSHOT_WRITE_FAILED_EVENT");
    expect(hooks).not.toMatch(/"snapshots?:\/\/write-failed"/);
  });

  it("has no other spelling anywhere in the shared or web trees", () => {
    // A second listener on the plural name would disprove the whole diagnosis,
    // and a third spelling would reintroduce it.
    for (const path of [
      "src/notes/components/SnapshotFailedIndicator.tsx",
      "core/src/plugins/notes/commands.rs",
      "src-tauri/src/hooks.rs",
      "web/wasm/src/hooks.rs",
    ]) {
      expect(read(path), `${path} must not carry the plural spelling`).not.toContain(
        "snapshots://write-failed",
      );
    }
  });
});
