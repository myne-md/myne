import { describe, it, expect } from "vitest";
import {
  effectiveMobileAutoLockSecs,
  MIN_AUTO_LOCK_SECS,
  DEFAULT_AUTO_LOCK_SECS,
  AUTO_LOCK_CEILING_SECS,
} from "../src/lib/auto-lock";

// Mirrors the desktop `effective_auto_lock_secs` cases. The load-bearing
// property (A6 envelope, threat-model §7): there is NO input that returns a
// "disabled" value — a sentinel/replayed "off" (0 or negative) clamps to the
// floor, never disables the idle lock.
describe("effectiveMobileAutoLockSecs()", () => {
  it("uses the default when the preference is unset (null)", () => {
    expect(effectiveMobileAutoLockSecs(null)).toBe(DEFAULT_AUTO_LOCK_SECS);
    expect(effectiveMobileAutoLockSecs(null)).toBe(300);
  });

  it("clamps a sentinel/replayed off (0 or negative) up to the floor — never disabled", () => {
    expect(effectiveMobileAutoLockSecs(0)).toBe(MIN_AUTO_LOCK_SECS);
    expect(effectiveMobileAutoLockSecs(0)).toBe(30);
    expect(effectiveMobileAutoLockSecs(-5)).toBe(30);
    expect(effectiveMobileAutoLockSecs(-99999)).toBe(30);
  });

  it("clamps a below-floor value up to the floor", () => {
    expect(effectiveMobileAutoLockSecs(1)).toBe(30);
    expect(effectiveMobileAutoLockSecs(29)).toBe(30);
  });

  it("clamps a huge value down to the ceiling", () => {
    expect(effectiveMobileAutoLockSecs(999999)).toBe(AUTO_LOCK_CEILING_SECS);
    expect(effectiveMobileAutoLockSecs(999999)).toBe(3600);
    expect(effectiveMobileAutoLockSecs(3601)).toBe(3600);
  });

  it("passes an in-range value through unchanged", () => {
    expect(effectiveMobileAutoLockSecs(120)).toBe(120);
    expect(effectiveMobileAutoLockSecs(300)).toBe(300);
  });

  it("keeps the exact boundaries", () => {
    expect(effectiveMobileAutoLockSecs(30)).toBe(30);
    expect(effectiveMobileAutoLockSecs(3600)).toBe(3600);
  });
});
