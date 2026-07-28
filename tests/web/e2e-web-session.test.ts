// The browser-session layer's capability payload (MYND-574 task 105).
//
// A session layer cannot be unit-tested against a browser, and most of it
// should not be — driving a real Chrome is what the lane itself does. What CAN
// and must be tested here is the part whose failure is SILENT: the capability
// payload.
//
// A payload that lost its profile flag produces a suite that passes on a fresh
// machine (nothing in the profile yet) and shares vaults everywhere else, and
// the symptom is a neighbouring test's data appearing in yours — which reads as
// a product bug, not a harness bug. That is the class of failure this file
// exists to make loud.

import { describe, expect, it } from "vitest";
import { capabilitiesFor } from "../../e2e-web/support/session";

const PROFILE = "/tmp/myne-web-e2e-profile-abc";

describe("browser capabilities", () => {
  it("gives Chrome a throwaway profile directory", () => {
    const caps = capabilitiesFor("chrome", PROFILE, true);
    const args = (caps["goog:chromeOptions"] as { args: string[] }).args;
    expect(args).toContain(`--user-data-dir=${PROFILE}`);
  });

  it("gives Firefox a throwaway profile directory", () => {
    const caps = capabilitiesFor("firefox", PROFILE, true);
    const args = (caps["moz:firefoxOptions"] as { args: string[] }).args;
    // Firefox takes it as two argv entries, not one `=`-joined string — a
    // difference that silently produces a DEFAULT-profile session if copied
    // from the Chrome arm.
    expect(args).toContain("-profile");
    expect(args[args.indexOf("-profile") + 1]).toBe(PROFILE);
  });

  it("is headless by default and headed only when asked", () => {
    const chromeHeadless = capabilitiesFor("chrome", PROFILE, true);
    expect((chromeHeadless["goog:chromeOptions"] as { args: string[] }).args).toContain(
      "--headless=new",
    );
    const chromeHeaded = capabilitiesFor("chrome", PROFILE, false);
    expect(
      (chromeHeaded["goog:chromeOptions"] as { args: string[] }).args.join(" "),
    ).not.toContain("headless");

    const ffHeadless = capabilitiesFor("firefox", PROFILE, true);
    expect((ffHeadless["moz:firefoxOptions"] as { args: string[] }).args).toContain("-headless");
    const ffHeaded = capabilitiesFor("firefox", PROFILE, false);
    expect((ffHeaded["moz:firefoxOptions"] as { args: string[] }).args).not.toContain("-headless");
  });

  it("enables the Firefox pref the storage design depends on", () => {
    // OPFS sync access handles are what task 18's double-buffered container is
    // written against. A session that silently ran without them would be testing
    // a different code path and passing.
    const caps = capabilitiesFor("firefox", PROFILE, true);
    const prefs = (caps["moz:firefoxOptions"] as { prefs: Record<string, unknown> }).prefs;
    expect(prefs["dom.fs.enabled"]).toBe(true);
  });

  it("asks Safari for nothing, because safaridriver accepts nothing", () => {
    // The asymmetry is the point and it is why Safari is a manual per-release
    // gate rather than a lane: safaridriver drives the user's own browser, so
    // the profile isolation every other seat gets is simply unavailable there.
    // A payload that pretended otherwise would make the Safari seat look like
    // the others in code while behaving nothing like them.
    expect(capabilitiesFor("safari", PROFILE, true)).toEqual({ browserName: "safari" });
  });

  it("names a distinct browser in every payload", () => {
    // Cheap, and it catches the copy-paste that gives Firefox Chrome's
    // `browserName` — a session that then launches Chrome while the test
    // believes it is proving Firefox behaviour.
    const names = (["chrome", "firefox", "safari"] as const).map(
      (b) => capabilitiesFor(b, PROFILE, true).browserName,
    );
    expect(new Set(names).size).toBe(3);
  });
});
