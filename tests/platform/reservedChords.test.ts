// @vitest-environment jsdom
//
// The browser-reserved chord table, both directions, without a Mac —
// myne-md/myne#556, the `web.keyboard.reserved-chords` / `input.keybindings`
// bullet.
//
// The roster row asked a person to walk the Hotkeys panel on macOS and on
// Windows and confirm that the right chords carry a "reserved" badge. Half of
// that walk needs a machine nobody in CI has, and the other half is checking a
// filter — because the platform split is not a measurement at all: it is
// `isMacPlatform()` applied to a STATIC table, and the function takes its answer
// from `navigator.platform`, which jsdom will happily set to anything.
//
// So both directions are assertable here:
//
//  * a `mac`-only entry (Cmd+M minimise, Cmd+Q quit, Cmd+Alt+I devtools) is
//    offered on macOS and ABSENT elsewhere — a Linux user must not be told that
//    Cmd+M is unavailable on a machine with no Cmd key;
//  * an `other`-only entry (Ctrl+Shift+Q, Firefox's quit on Windows/Linux; F12;
//    Ctrl+Shift+I) is offered off macOS and absent on it.
//
// What is deliberately NOT asserted, because it cannot be: whether the browser
// really takes the chord. The web seam's own header says so — "a page cannot
// observe whether the host acted; `preventDefault()` on a reserved chord returns
// exactly the same nothing whether it worked or not" — and the table is
// knowledge rather than measurement. The asymmetry is what makes that
// survivable: over-listing costs one binding with a visible explanation,
// under-listing costs a binding that silently does nothing. This file holds the
// FILTER and the table's internal coherence; the browser's own behaviour is the
// e2e lane's, and the parts of it that no seat can reach stay a roster row.

import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();

// Both seam implementations. The desktop one is imported for the claim it makes
// by being empty; the web one is loaded through its own path because it is the
// substituted module, not a variant of the desktop file.
const desktop = await import("../../src/platform/keyboard");
const web = await import("../../web/src/platform/keyboard");

const ORIGINAL_PLATFORM = window.navigator.platform;

function setPlatform(value: string) {
  Object.defineProperty(window.navigator, "platform", { value, configurable: true });
}

afterEach(() => setPlatform(ORIGINAL_PLATFORM));

/** Every reserved chord string the web host declares under `platform`. */
function chordsUnder(platform: string): string[] {
  setPlatform(platform);
  return web.allReservedChords().map((r) => r.chord).sort();
}

const MAC = "MacIntel";
const WINDOWS = "Win32";
const LINUX = "Linux x86_64";

// ── 1. The desktop seam reserves nothing, and that is its whole content ─────

describe("a desktop window reserves nothing", () => {
  it("answers null for every chord, including the ones the browser takes", () => {
    // Not an omission: a window gets the keystrokes the OS gives it. The few
    // chords the OS itself keeps never reach any application, so there is
    // nothing to reconcile and nothing to explain.
    for (const chord of ["Mod-w", "Mod-t", "Mod-1", "F12", "Ctrl-Tab", "Mod-b"]) {
      expect(desktop.reservedChord(chord), chord).toBeNull();
    }
    expect(desktop.allReservedChords()).toEqual([]);
  });

  it("does not vary by desktop OS", () => {
    for (const platform of [MAC, WINDOWS, LINUX]) {
      setPlatform(platform);
      expect(desktop.allReservedChords(), platform).toEqual([]);
      expect(desktop.reservedChord("Mod-m"), platform).toBeNull();
    }
  });
});

// ── 2. The mac-only half, asserted without a Mac ────────────────────────────

describe("mac-only reservations are offered on macOS and nowhere else", () => {
  /** Entries the table marks `applies: "mac"`. */
  const MAC_ONLY = ["Mod-m", "Mod-q", "Mod-Alt-i", "Mod-y", "Ctrl-Tab", "Ctrl-Shift-Tab"];

  it.each(MAC_ONLY)("%s is reserved on macOS", (chord) => {
    setPlatform(MAC);
    expect(web.reservedChord(chord), `${chord} is not reserved on macOS`).not.toBeNull();
  });

  it.each(MAC_ONLY)("%s is NOT reserved on Windows or Linux", (chord) => {
    for (const platform of [WINDOWS, LINUX]) {
      setPlatform(platform);
      expect(
        web.reservedChord(chord),
        `${chord} is marked reserved on ${platform}. A user with no Cmd key ` +
          `would be told a chord they never had is unavailable.`,
      ).toBeNull();
    }
  });
});

describe("non-mac reservations are offered off macOS and not on it", () => {
  /** Entries the table marks `applies: "other"`. */
  const OTHER_ONLY = [
    "Mod-Shift-q",
    "Mod-Shift-i",
    "Mod-Shift-j",
    "Mod-Shift-c",
    "F12",
    "F11",
    "Mod-Tab",
    "Mod-Shift-Tab",
    "Mod-h",
  ];

  it.each(OTHER_ONLY)("%s is reserved on Windows and Linux", (chord) => {
    for (const platform of [WINDOWS, LINUX]) {
      setPlatform(platform);
      expect(web.reservedChord(chord), `${chord} on ${platform}`).not.toBeNull();
    }
  });

  it.each(OTHER_ONLY.filter((c) => c !== "Mod-h"))(
    "%s is NOT reserved on macOS",
    (chord) => {
      // `Mod-h` is the deliberate exception: it is `hideApplication` (hard) on
      // macOS and `openHistory` (unreliable) elsewhere, so it is reserved on
      // BOTH — with different entries. It is excluded from this negative and
      // asserted on its own below.
      setPlatform(MAC);
      expect(web.reservedChord(chord), `${chord} on macOS`).toBeNull();
    },
  );

  it("Mod-h is reserved on both, for different reasons", () => {
    setPlatform(MAC);
    const mac = web.reservedChord("Mod-h");
    setPlatform(LINUX);
    const linux = web.reservedChord("Mod-h");
    expect(mac).not.toBeNull();
    expect(linux).not.toBeNull();
    // The copy the user reads is the difference, and flattening the two would
    // put a false explanation on one of the platforms.
    expect(mac!.actionKey).toBe("hideApplication");
    expect(linux!.actionKey).toBe("openHistory");
    expect(mac!.tier).toBe("hard");
    expect(linux!.tier).toBe("unreliable");
  });
});

// ── 3. The platform split is real ───────────────────────────────────────────

describe("the two platform tables differ, so the filter is doing something", () => {
  it("macOS and Linux reserve different sets", () => {
    const mac = chordsUnder(MAC);
    const linux = chordsUnder(LINUX);
    expect(mac).not.toEqual(linux);
    expect(mac.length).toBeGreaterThan(20);
    expect(linux.length).toBeGreaterThan(20);
  });

  it("Windows and Linux reserve the same set", () => {
    // The table's only axis is mac-vs-not. If these ever diverge, an entry has
    // grown a third case and the `Applies` union needs to say so.
    expect(chordsUnder(WINDOWS)).toEqual(chordsUnder(LINUX));
  });

  it("the chords common to both platforms are the unconditional ones", () => {
    const mac = new Set(chordsUnder(MAC));
    const linux = new Set(chordsUnder(LINUX));
    const both = [...mac].filter((c) => linux.has(c));
    // Tab and window lifecycle is reserved everywhere — those are the entries
    // with no `applies` at all.
    for (const chord of ["Mod-w", "Mod-t", "Mod-l", "Mod-1", "Mod-9"]) {
      expect(both, `${chord} should be reserved on every platform`).toContain(chord);
    }
  });
});

// ── 4. The table's own coherence ────────────────────────────────────────────

describe("every entry is well-formed", () => {
  it.each([MAC, LINUX])("under %s", (platform) => {
    setPlatform(platform);
    const all = web.allReservedChords();
    expect(all.length).toBeGreaterThan(0);
    for (const r of all) {
      expect(["hard", "unreliable"], `${r.chord} tier`).toContain(r.tier);
      // "Never empty" is the type's own claim, and an empty list would mean a
      // reservation that applies to no browser — a badge with no reason.
      expect(r.browsers.length, `${r.chord} names no browser`).toBeGreaterThan(0);
      for (const b of r.browsers) {
        expect(["chromium", "firefox", "safari"], `${r.chord}`).toContain(b);
      }
      expect(r.actionKey.length, `${r.chord} has no actionKey`).toBeGreaterThan(0);
      // The chord is stored canonically, so panel matching is string equality.
      expect(r.chord.trim(), `${r.chord} is not trimmed`).toBe(r.chord);
    }
  });

  it("no chord is reserved twice under one platform", () => {
    // Two entries for one chord means `find` picks the first and the second is
    // dead — including its (possibly different) copy.
    for (const platform of [MAC, LINUX]) {
      const chords = chordsUnder(platform);
      const dupes = chords.filter((c, i) => chords.indexOf(c) !== i);
      expect(dupes, `${platform} reserves a chord twice`).toEqual([]);
    }
  });

  it("every actionKey exists in the English catalog", () => {
    // The badge renders `settings.hotkeys.reserved.<actionKey>`. A missing key
    // renders the key itself, which reads as a bug to the user and as nothing
    // at all to `check-i18n.mjs` — the keys here are composed at runtime, so
    // its static `t("…")` scan cannot see them.
    const catalog = JSON.parse(
      readFileSync(join(REPO_ROOT, "locales/en/common.json"), "utf8"),
    ) as Record<string, unknown>;
    const reserved = ((catalog.settings as Record<string, unknown>)?.hotkeys as Record<
      string,
      unknown
    >)?.reserved as Record<string, string> | undefined;
    expect(reserved, "settings.hotkeys.reserved is missing from the catalog").toBeDefined();

    const keys = new Set<string>();
    for (const platform of [MAC, LINUX]) {
      setPlatform(platform);
      for (const r of web.allReservedChords()) keys.add(r.actionKey);
    }
    expect(keys.size).toBeGreaterThan(5);
    for (const key of keys) {
      expect(
        reserved![key],
        `no settings.hotkeys.reserved.${key} — the badge would render the key`,
      ).toBeTruthy();
    }
  });

  it("no catalog entry describes a reservation the table no longer has", () => {
    // The other direction. A stale key is a sentence nobody can reach, and it
    // is the half a one-directional check never notices.
    const catalog = JSON.parse(
      readFileSync(join(REPO_ROOT, "locales/en/common.json"), "utf8"),
    ) as Record<string, unknown>;
    const reserved = ((catalog.settings as Record<string, unknown>)?.hotkeys as Record<
      string,
      unknown
    >)?.reserved as Record<string, string>;

    const keys = new Set<string>();
    for (const platform of [MAC, LINUX]) {
      setPlatform(platform);
      for (const r of web.allReservedChords()) keys.add(r.actionKey);
    }
    const orphans = Object.keys(reserved).filter((k) => !keys.has(k));
    expect(orphans, "catalog keys for reservations that no longer exist").toEqual([]);
  });
});
