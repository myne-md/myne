// @vitest-environment jsdom
//
// The browser-reserved chord table (phase3-web-client task 66).
//
// What is assertable here is NOT "Cmd+W really closes the tab" — no test can
// observe that, and a page cannot even tell whether its `preventDefault` was
// honoured. What IS assertable, and is where this table would actually go
// wrong, is that every entry is a chord the app's own normalizer can produce:
// an entry spelled in a form `eventToChord` never emits (a literal `Ctrl-` token
// off macOS, an uppercase key) is silently dead — it matches nothing, warns
// nobody, and looks exactly like a table that works.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { eventToChord, normalizeChord } from "../../src/commands/chord";

async function load(mac: boolean) {
  vi.resetModules();
  vi.stubGlobal("navigator", { platform: mac ? "MacIntel" : "Linux x86_64" });
  return await import("../../web/src/platform/keyboard");
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("the table itself", () => {
  it("spells every chord in the canonical form", async () => {
    for (const mac of [true, false]) {
      const { allReservedChords } = await load(mac);
      for (const r of allReservedChords()) {
        expect(normalizeChord(r.chord)).toBe(r.chord);
      }
    }
  });

  it("names at least one browser per entry", async () => {
    const { allReservedChords } = await load(true);
    for (const r of allReservedChords()) {
      expect(r.browsers.length).toBeGreaterThan(0);
    }
  });

  it("covers more than Chromium", async () => {
    // The acceptance criterion, as a test: a table that only knew Chrome would
    // quietly under-warn every Firefox and Safari user.
    const { allReservedChords } = await load(true);
    const browsers = new Set(allReservedChords().flatMap((r) => [...r.browsers]));
    expect(browsers).toEqual(new Set(["chromium", "firefox", "safari"]));
  });

  it("declares no duplicate chords on one platform", async () => {
    // A duplicate is not a crash; it is a second entry that can never be seen,
    // which is how a tier or a browser list silently stops applying.
    for (const mac of [true, false]) {
      const { allReservedChords } = await load(mac);
      const chords = allReservedChords().map((r) => r.chord);
      expect(new Set(chords).size).toBe(chords.length);
    }
  });
});

describe("lookups", () => {
  it("matches the chord the normalizer produces for a real keypress", async () => {
    const { reservedChord } = await load(true);
    // Cmd+W as the DOM would deliver it on macOS.
    const chord = eventToChord({ key: "w", metaKey: true }, true);
    expect(chord).toBe("Mod-w");
    const hit = reservedChord(chord!);
    expect(hit?.tier).toBe("hard");
    expect(hit?.actionKey).toBe("closeTab");
  });

  it("leaves Myne's own bindings alone", async () => {
    const { reservedChord } = await load(true);
    // The command palette, in-note find and new-note chords must survive — a
    // table that swallowed those would disable the app's core keyboard surface
    // in the name of protecting it.
    expect(reservedChord("Mod-k")).toBeNull();
    expect(reservedChord("Mod-f")).toBeNull();
    expect(reservedChord("Mod-p")).toBeNull();
    expect(reservedChord("Mod-s")).toBeNull();
  });

  it("does not offer macOS-only reservations to a Linux user", async () => {
    const { reservedChord } = await load(false);
    // Cmd+M minimises on macOS. On Linux there is no Cmd key at all, and
    // `Mod` there is Ctrl — Ctrl+M is not the browser's.
    expect(reservedChord("Mod-m")).toBeNull();
    expect(reservedChord("Mod-h")?.actionKey).toBe("openHistory");
  });

  it("does not offer Linux/Windows-only reservations to a macOS user", async () => {
    const { reservedChord } = await load(true);
    expect(reservedChord("F12")).toBeNull();
    expect(reservedChord("Mod-Shift-q")).toBeNull();
    // …while Cmd+H IS taken there, by the OS-level hide.
    expect(reservedChord("Mod-h")?.actionKey).toBe("hideApplication");
  });

  it("keeps both tiers, because the honest message differs", async () => {
    const { allReservedChords } = await load(true);
    const tiers = new Set(allReservedChords().map((r) => r.tier));
    expect(tiers).toEqual(new Set(["hard", "unreliable"]));
  });
});
