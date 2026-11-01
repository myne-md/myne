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
//
// It reads the HOOK, not the editor, since the timer moved there (myne-md/myne#535):
// the approval wait is a second post-unlock screen that holds keys, so the one
// implementation now serves two call sites and a source assertion against the
// editor would pass while the hook it delegates to lost the property.
describe("mobile idle auto-lock is deadline-based (#53)", () => {
  const read = async (path: string) =>
    import("node:fs").then((fs) => fs.readFileSync(path, "utf8"));

  it("re-evaluates on visibilitychange rather than trusting a suspended timer", async () => {
    const src = await read("src/hooks/useIdleAutoLock.ts");
    expect(
      src.includes('document.addEventListener("visibilitychange"'),
      "returning to the foreground is the first moment elapsed time is observable",
    ).toBe(true);
    expect(
      /Date\.now\(\) - lastActivity >=/.test(src),
      "the deadline must be a timestamp comparison",
    ).toBe(true);
  });

  it("no longer arms a lock-after-N countdown that activity restarts", async () => {
    for (const path of ["src/hooks/useIdleAutoLock.ts", "src/app/flows/EditorFlow.tsx"]) {
      const src = await read(path);
      expect(
        /setTimeout\(\(\) => onLock\(\)/.test(src),
        `a restartable countdown is the defect, and ${path} must not carry one`,
      ).toBe(false);
    }
  });

  it("is armed by every post-unlock screen that holds keys", async () => {
    // Two call sites, and the second one is the reason the hook exists: an
    // approval wait with no timer is an unlocked vault left on a screen nobody
    // asked to keep open (A6).
    for (const path of ["src/app/flows/EditorFlow.tsx", "src/app/flows/PendingApprovalFlow.tsx"]) {
      const src = await read(path);
      expect(src.includes("useIdleAutoLock("), `${path} must arm the idle lock`).toBe(true);
    }
  });
});
