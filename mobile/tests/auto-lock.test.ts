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

// #53: the idle clock compares TIMESTAMPS; it does not count down.
//
// It used to be a `setTimeout` restarted on every touch. A phone suspends
// timers the moment the app leaves the foreground, so time spent backgrounded —
// which is most of the time a phone is unattended, and exactly the A6 "lost or
// stolen device" case auto-lock exists for — never counted toward the deadline.
// The vault locked 30 seconds after the user came BACK rather than 30 seconds
// after they left.
//
// Asserted over the source rather than by driving the flow: the component needs
// a whole vault session to mount, and the property is structural — a countdown
// that is restarted, versus a deadline that is compared.
describe("mobile idle auto-lock is deadline-based (#53)", () => {
  it("re-evaluates on visibilitychange rather than trusting a suspended timer", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/app/flows/EditorFlow.tsx", "utf8"),
    );
    const block = src.slice(src.indexOf("// Auto-lock:"));
    expect(
      block.includes('document.addEventListener("visibilitychange"'),
      "returning to the foreground is the first moment elapsed time is observable",
    ).toBe(true);
    expect(
      /Date\.now\(\) - lastActivity >=/.test(block),
      "the deadline must be a timestamp comparison",
    ).toBe(true);
  });

  it("no longer arms a lock-after-N countdown that activity restarts", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync("src/app/flows/EditorFlow.tsx", "utf8"),
    );
    const block = src.slice(
      src.indexOf("// Auto-lock:"),
      src.indexOf("// Best-effort plaintext wipe on unmount."),
    );
    expect(
      /setTimeout\(\(\) => onLock\(\)/.test(block),
      "a restartable countdown is the defect",
    ).toBe(false);
  });
});
