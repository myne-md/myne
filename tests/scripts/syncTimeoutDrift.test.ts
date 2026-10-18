// Injection tests for `scripts/check-sync-timeout-drift.mjs` (audit R0.3,
// 2026-10-19).
//
// The guard exists because the sync request deadline is written in two
// languages and had already drifted once, in the direction nobody could see:
// the Rust `SOCKET_TIMEOUT` moved to 180 s in myne-md/myne#222 and the browser's
// `REQUEST_TIMEOUT_MS` stayed at 60 s with a comment claiming it mirrored the
// native value. `SOCKET_TIMEOUT` is `#[cfg(not(target_arch = "wasm32"))]`, so it
// is not in the browser's build at all — nothing could compare them.
//
// Both directions are asserted: a disagreement must be NAMED, and a missing
// input must fail rather than print ok over a file the guard could not read.
// The second is the shape that makes a guard useless, and it is the one nobody
// writes a test for.

import { describe, expect, it } from "vitest";
import {
  compareTimeouts,
  parseJsTimeout,
  parseRustTimeout,
} from "../../scripts/check-sync-timeout-drift.mjs";

describe("parseJsTimeout", () => {
  it("reads the declaration, with separators", () => {
    expect(parseJsTimeout("const REQUEST_TIMEOUT_MS = 180_000;")).toBe(180_000);
  });

  it("reads a plain literal", () => {
    expect(parseJsTimeout("const REQUEST_TIMEOUT_MS = 60000;")).toBe(60_000);
  });

  it("returns null on a renamed constant, so the caller can fail by name", () => {
    // The rename is not hypothetical: teaching the guard the new shape is the
    // documented fix, and reporting a number it did not find is the failure.
    expect(parseJsTimeout("const XHR_DEADLINE_MS = 180_000;")).toBeNull();
  });
});

describe("parseRustTimeout", () => {
  it("reads the `Duration::from_secs` form and scales it to milliseconds", () => {
    expect(
      parseRustTimeout(
        "pub(crate) const SOCKET_TIMEOUT: Duration = Duration::from_secs(180);",
      ),
    ).toBe(180_000);
  });

  it("does not match a private or differently-typed declaration", () => {
    // `pub(crate)` is load-bearing: a `const SOCKET_TIMEOUT: u64` would be a
    // different fact, and matching it loosely is how a guard compares a value
    // with something that is not the value.
    expect(parseRustTimeout("const SOCKET_TIMEOUT: u64 = 180;")).toBeNull();
  });
});

describe("compareTimeouts", () => {
  it("accepts the pair R0.3 landed", () => {
    expect(compareTimeouts(180_000, 180_000)).toBeNull();
  });

  it("names the disagreement the guard found, in both languages", () => {
    const message = compareTimeouts(60_000, 180_000);
    expect(message).toContain("web/src/worker/sync-transport.ts says 60000 ms");
    expect(message).toContain("core/src/plugins/sync/http_transport.rs says 180000 ms");
  });

  it("defers to the missing-input failure rather than reporting a verdict", () => {
    // A `null` side is "the file did not contain what I look for", which the
    // caller has already recorded as a failure. Returning a disagreement here
    // would print a second, misleading sentence about it.
    expect(compareTimeouts(null, 180_000)).toBeNull();
    expect(compareTimeouts(180_000, null)).toBeNull();
  });
});
