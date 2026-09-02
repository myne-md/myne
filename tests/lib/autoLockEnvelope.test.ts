import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Through the package's BARREL, which is what the production call sites use
// (`src/screens/Editor.tsx`, `src/App.tsx`, `mobile/src/lib/auto-lock.ts`), so
// this test exercises the path the app takes rather than a second one.
import {
  AUTO_LOCK_CEILING_SECS,
  DEFAULT_AUTO_LOCK_SECS,
  MIN_AUTO_LOCK_SECS,
  effectiveAutoLockSecs,
} from "@myne/client-core";

// Drift lock for the A6 auto-lock envelope across the language boundary
// (myne-md/myne#479).
//
// **The defect.** The envelope is three numbers and one clamp, and it existed in
// FOUR places: the desktop Rust, mobile's Rust hook, the web Rust hook, and a
// TypeScript copy in `mobile/src/lib/auto-lock.ts`. Two of the four had no clamp
// at all, `prefs_value.unwrap_or(DEFAULT)`, which is a plausible-looking
// `unwrap_or` that compiles, satisfies `clippy -D warnings` and returns a
// sensible number, so nothing reported it. `vault.prefs` is a replayable blob,
// so on those two clients a tampered `auto_lock_seconds` reached the timer
// unfiltered and an A4 disk attacker could WIDEN the A6 exposure window, which
// is the exact property `AUTO_LOCK_CEILING_SECS`'s docstring says it prevents.
//
// The Rust side is now one declaration with four `const _: () = assert!(…)`
// invariants, so a bad edit there fails the BUILD. The TypeScript side has no
// such mechanism and cannot borrow one, which is what this file is for: all
// three constants are marked PLACEHOLDER in the Rust and owned by MYND-122, so
// the day they are settled the asserts fire on one side and this test fires on
// the other. Without it, a phone's timer silently keeps the old ceiling.
//
// The Rust path is a CONSTANT rather than a glob, for the reason
// `tests/lib/engineErrorTaxonomy.test.ts` records: an `ENOENT` on a path that
// moved is the right failure, where a glob would find some other file and
// compare against the wrong numbers.

const LIB_RS: string = fileURLToPath(new URL("../../core/src/lib.rs", import.meta.url));

/** The `u32` value of a `pub const <name>` in the Rust source. */
function rustConst(src: string, name: string): number {
  const m = new RegExp(`pub const ${name}: u32 = (\\d+);`).exec(src);
  if (!m) throw new Error(`no \`pub const ${name}: u32\` in core/src/lib.rs`);
  return Number(m[1]);
}

describe("auto-lock envelope, TypeScript mirrors the Rust", () => {
  const rs: string = readFileSync(LIB_RS, "utf8");

  it("agrees on all three constants", () => {
    expect(MIN_AUTO_LOCK_SECS).toBe(rustConst(rs, "MIN_AUTO_LOCK_SECS"));
    expect(DEFAULT_AUTO_LOCK_SECS).toBe(rustConst(rs, "DEFAULT_AUTO_LOCK_SECS"));
    expect(AUTO_LOCK_CEILING_SECS).toBe(rustConst(rs, "AUTO_LOCK_CEILING_SECS"));
  });

  it("fails by name when a constant is renamed away", () => {
    // Not a formality: the whole value of a constant path is that it breaks
    // loudly rather than comparing against nothing.
    expect(() => rustConst("pub const SOMETHING_ELSE: u32 = 1;", "MIN_AUTO_LOCK_SECS")).toThrow(
      /MIN_AUTO_LOCK_SECS/,
    );
  });

  it("carries the same compile-time invariants the Rust asserts", () => {
    // `core/src/lib.rs` fails the BUILD on each of these. TypeScript has no
    // equivalent, so they are asserted here instead of trusted.
    expect(MIN_AUTO_LOCK_SECS).toBeGreaterThan(0);
    expect(MIN_AUTO_LOCK_SECS).toBeLessThanOrEqual(AUTO_LOCK_CEILING_SECS);
    expect(DEFAULT_AUTO_LOCK_SECS).toBeGreaterThanOrEqual(MIN_AUTO_LOCK_SECS);
    expect(DEFAULT_AUTO_LOCK_SECS).toBeLessThanOrEqual(AUTO_LOCK_CEILING_SECS);
  });
});

describe("auto-lock envelope, every input lands on a protective state", () => {
  it("clamps the whole replay table, exactly as the Rust suite does", () => {
    // The same table `core/src/lib.rs`'s `auto_lock_envelope_tests` runs, so a
    // divergence in BEHAVIOUR shows up here and not only a divergence in the
    // constants. NO input, absent, sentinel-off, negative, replayed-long,
    // yields a disabled or out-of-range result.
    for (const input of [
      null,
      0,
      -1,
      1,
      MIN_AUTO_LOCK_SECS,
      DEFAULT_AUTO_LOCK_SECS,
      AUTO_LOCK_CEILING_SECS,
      AUTO_LOCK_CEILING_SECS + 1,
      Number.MAX_SAFE_INTEGER,
    ]) {
      const eff = effectiveAutoLockSecs(input);
      expect(eff, `${input} -> ${eff} below floor`).toBeGreaterThanOrEqual(MIN_AUTO_LOCK_SECS);
      expect(eff, `${input} -> ${eff} above ceiling`).toBeLessThanOrEqual(AUTO_LOCK_CEILING_SECS);
      expect(eff, `${input} -> ${eff} would disable auto-lock`).toBeGreaterThan(0);
    }
  });

  it("passes an in-range value through unchanged", () => {
    expect(effectiveAutoLockSecs(600)).toBe(600);
  });

  it("resolves an absent preference to the default", () => {
    expect(effectiveAutoLockSecs(null)).toBe(DEFAULT_AUTO_LOCK_SECS);
  });
});
