// Injection tests for `check-core-io-seam.mjs`'s matcher.
//
// The guard exists because `std::fs` COMPILES for wasm32 and dies at runtime,
// so nothing else in the build can see the defect it catches. What it could not
// see was itself: `/(?:std::)?fs::[a-z_]+\s*\(/` had no left-hand boundary, so
// it matched INSIDE any Rust path segment ending in those two letters.
// `protocol::prefs::device_scoped_consent(name)` was reported as direct
// filesystem access in a file that had none, which reddened `pnpm-build` on
// develop and took the whole serial chain behind it (`vitest`,
// `tauri-compile`, `cargo-test-tauri`) out of the run with it
// (myne-md/myne#647).
//
// Both directions, because that is what the rule asks for and because the
// second one is what nobody tries: the false positive must stop firing, AND
// every real shape the guard caught before must still fire. A guard that has
// quietly stopped checking is green by definition.

import { describe, expect, it } from "vitest";
import { FS_CALL } from "../../scripts/check-core-io-seam.mjs";

describe("FS_CALL: the false positive that shut CI down", () => {
  it("passes a `prefs::` call, which is not the filesystem", () => {
    expect(FS_CALL.test("    let stored = protocol::prefs::device_scoped_consent(name);")).toBe(
      false,
    );
  });

  it("passes `consent_is_device_scoped`, the second site it named", () => {
    expect(FS_CALL.test("    if !protocol::prefs::consent_is_device_scoped(")).toBe(false);
  });

  // `prefs` was the one that fired; these are the rest of the class, so a
  // future edit cannot fix one segment and leave the others.
  it("passes every other path segment ending in `fs`", () => {
    expect(FS_CALL.test("crate::refs::resolve(&id)")).toBe(false);
    expect(FS_CALL.test("let d = defs::lookup(name);")).toBe(false);
    expect(FS_CALL.test("self.blobs::open(")).toBe(false);
  });
});

describe("FS_CALL: everything it caught before, it still catches", () => {
  it("names a qualified call", () => {
    expect(FS_CALL.test("    let bytes = std::fs::read(&p)?;")).toBe(true);
  });

  it("names a bare call where the module is imported", () => {
    expect(FS_CALL.test("    fs::write(&p, &bytes)?;")).toBe(true);
    expect(FS_CALL.test("    let _ = fs::create_dir_all(&d);")).toBe(true);
  });

  it("names the two handle constructors", () => {
    expect(FS_CALL.test("    let f = File::open(&p)?;")).toBe(true);
    expect(FS_CALL.test("    let f = File::create(&p)?;")).toBe(true);
    expect(FS_CALL.test("    OpenOptions::new().read(true)")).toBe(true);
  });

  // The blind spot the guard's own header records closing. It reaches the
  // filesystem exactly as `std::fs` does, and the lookbehind must not have
  // reopened it.
  it("names `crate::atomic_write::atomic_write`", () => {
    expect(FS_CALL.test("    crate::atomic_write::atomic_write(&p, &bytes)?;")).toBe(true);
    expect(FS_CALL.test("    crate::atomic_write::atomic_write_sync(&p, &bytes)?;")).toBe(true);
  });
});
