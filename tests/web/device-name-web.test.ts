// The one observable behaviour difference the web target introduces in SHARED
// code (phase3-web-client task 11).
//
// `plugin:prefs|device_platform` returns `std::env::consts::OS` verbatim, and on
// `wasm32-unknown-unknown` that constant is the **empty string**. Measured, not
// assumed: a real-browser probe of the built bundle returned `""`, where the
// natural guess would have been `"unknown"`.
//
// `src/lib/device-name.ts` then maps the token through the i18n catalogue with
// `sync.devices.platform.unknown` as its fallback key. Whether an EMPTY token
// hits that fallback is an i18next resolution detail — `sync.devices.platform.`
// has a trailing separator, so it splits to a final empty segment — and getting
// it wrong is not a crash. It is a device arriving in the user's synced device
// list named `sync.devices.platform.`, which would look like a product bug and
// be traced back here only after someone read three files.
//
// Nothing else pins this: the desktop clients never produce an empty token, so
// no desktop test can reach the case, and the web E2E lane is deliberately thin
// (`decisions.md` 2026-07-26 "Web E2E policy").

import { describe, expect, it } from "vitest";
import i18n from "../../src/i18n";

/**
 * The lookup `src/lib/device-name.ts` performs, reproduced rather than imported.
 *
 * Importing `suggestedDeviceName` would drag in `src/lib/prefs.ts` and therefore
 * the platform seam, which in a node test resolves to the DESKTOP seam and its
 * `@tauri-apps/*` imports — so the test would be asserting a mock's behaviour,
 * not i18next's. The one line under test is the key-array lookup itself.
 */
const deviceNameForPlatform = (token: string) =>
  i18n.t([`sync.devices.platform.${token}`, "sync.devices.platform.unknown"]);

describe("device-name suggestion on the web target", () => {
  it("an empty platform token falls back to the neutral label", () => {
    const name = deviceNameForPlatform("");
    expect(name).toBe("This device");
    // The failure this guards is a resolved-to-the-key-string result, which
    // renders as literal dotted text in the device list rather than throwing.
    expect(name).not.toContain("sync.devices.platform");
  });

  it("still resolves the desktop and mobile tokens it always did", () => {
    // The fallback must not have been achieved by breaking the normal lookup.
    expect(deviceNameForPlatform("macos")).toBe("Mac");
    expect(deviceNameForPlatform("windows")).toBe("Windows PC");
    expect(deviceNameForPlatform("linux")).toBe("Linux PC");
    expect(deviceNameForPlatform("ios")).toBe("iPhone");
    expect(deviceNameForPlatform("android")).toBe("Android phone");
  });

  it("an unrecognised token falls back the same way", () => {
    // A future Tauri platform. Same neutral answer, never the raw key.
    expect(deviceNameForPlatform("plan9")).toBe("This device");
  });

  it("names a BROWSER device distinguishably (phase3-web-client task 69)", () => {
    // `device_platform_value()` answers `"web"` on wasm32 — the CLIENT, since a
    // page cannot honestly report the OS underneath it. Until this catalogue
    // entry existed that token hit the neutral fallback, so a browser enrolled
    // as "This device": correct on the machine you are holding and useless in
    // the device list of the machine you are not, where every unnamed device
    // reads the same. The device list is where a user decides what to REMOVE,
    // so two devices that cannot be told apart is a safety problem, not a
    // cosmetic one.
    expect(deviceNameForPlatform("web")).toBe("Browser");
    expect(deviceNameForPlatform("web")).not.toBe(deviceNameForPlatform(""));
  });
});
