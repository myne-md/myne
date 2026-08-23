// Both platform branches of the chord vocabulary, without a Mac —
// myne-md/myne#557's `editor.text-editing` / `settings.panel.hotkeys` bullet.
//
// The roster row asked a person to open the Hotkeys panel on macOS and on
// Windows and confirm the glyphs and the Mod mapping are right on each. Half of
// that walk needs a machine nobody in CI has, and none of it needs one:
// `eventToChord(e, mac)`, `formatChord(chord, mac)` and `chordTokens(chord, mac)`
// all take `mac` as a PARAMETER, so both platforms are two arguments rather than
// two machines.
//
// `tests/commands/chord.test.ts` already covers the common cases. This file is
// the part of the bullet it does not reach, and each of the three has teeth:
//
//  1. **The ⌃ glyph.** `Ctrl` on macOS is a modifier in its own right, distinct
//     from `Mod`, and it renders as ⌃ rather than as "Ctrl". Nothing pinned that,
//     and it is the one glyph a non-Mac author has no intuition for.
//  2. **"Ctrl does nothing on mac".** This is the claim the roster row was really
//     about, and it is a claim about DISPATCH rather than about rendering: a
//     binding stored as `Mod-k` must not fire when a Mac user presses Ctrl+K,
//     because on that platform Ctrl is not the accelerator. Asserted through
//     `commandIdsForChord`, which is what the dispatcher actually consults.
//  3. **`Meta` off macOS.** The Windows/Super key is a real, distinct modifier
//     there — `Meta`, not `Mod` — so a chord carrying it must not silently
//     collapse into the Ctrl binding.
//
// What stays manual: whether the OS delivers the keystroke at all. That is the
// platform's contract, not Myne's, and no seat can answer it for another.

import { describe, expect, it } from "vitest";
import {
  chordTokens,
  commandIdsForChord,
  eventToChord,
  formatChord,
} from "../../src/commands/chord";

const MAC = true;
const OTHER = false;

// ── 1. The glyph vocabulary, both platforms, every modifier ─────────────────

describe("the four macOS modifier glyphs", () => {
  it.each([
    ["Mod-k", "⌘K"],
    ["Alt-k", "⌥K"],
    ["Shift-k", "⇧K"],
    ["Ctrl-k", "⌃K"],
    ["Mod-Ctrl-Alt-Shift-k", "⌘⌃⌥⇧K"],
  ])("%s renders as %s", (chord, glyphs) => {
    expect(formatChord(chord, MAC)).toBe(glyphs);
  });

  it("renders a literal Ctrl as ⌃ and the accelerator as ⌘, never the same glyph", () => {
    // The distinction the whole mac branch rests on. Collapsing them would make
    // two different bindings look identical in the Hotkeys panel.
    expect(formatChord("Ctrl-k", MAC)).not.toBe(formatChord("Mod-k", MAC));
  });

  it("uses the same glyphs when the panel renders per-key caps", () => {
    // `chordTokens` feeds the keycap UI and duplicates the mapping; a drift
    // between the two shows as one surface saying ⌘ and the other saying Mod.
    expect(chordTokens("Mod-Ctrl-Alt-Shift-k", MAC)).toEqual(["⌘", "⌃", "⌥", "⇧", "K"]);
    expect(chordTokens("Mod-k", MAC).join("")).toBe(formatChord("Mod-k", MAC));
  });
});

describe("the non-macOS words", () => {
  it.each([
    ["Mod-k", "Ctrl+K"],
    ["Alt-k", "Alt+K"],
    ["Shift-k", "Shift+K"],
    ["Mod-Alt-Shift-k", "Ctrl+Alt+Shift+K"],
  ])("%s renders as %s", (chord, words) => {
    expect(formatChord(chord, OTHER)).toBe(words);
  });

  it("keeps Meta as its own word rather than folding it into Ctrl", () => {
    // The Windows/Super key. `Mod` IS Ctrl here, so a chord that also carries
    // Meta must show two distinct modifiers or the two bindings read alike.
    expect(formatChord("Meta-k", OTHER)).toBe("Meta+K");
    expect(formatChord("Meta-k", OTHER)).not.toBe(formatChord("Mod-k", OTHER));
    expect(chordTokens("Meta-k", OTHER)).toEqual(["Meta", "K"]);
  });

  it("renders every chord differently from its macOS form", () => {
    // A sanity floor: if the two branches ever produced the same string, every
    // per-platform assertion in this file would be measuring one branch twice.
    for (const chord of ["Mod-k", "Alt-k", "Shift-k", "Mod-Alt-Shift-k"]) {
      expect(formatChord(chord, MAC), chord).not.toBe(formatChord(chord, OTHER));
    }
  });
});

// ── 2. The same physical keypress, read on each platform ────────────────────

describe("one physical keypress, two platforms", () => {
  it("Cmd+K is the accelerator on macOS and Meta elsewhere", () => {
    // The literal Windows key on a PC is not the accelerator, and reading it as
    // one would fire the palette on a keypress the user did not make.
    expect(eventToChord({ key: "k", metaKey: true }, MAC)).toBe("Mod-k");
    expect(eventToChord({ key: "k", metaKey: true }, OTHER)).toBe("Meta-k");
  });

  it("Ctrl+K is the accelerator off macOS and a literal Ctrl on it", () => {
    expect(eventToChord({ key: "k", ctrlKey: true }, OTHER)).toBe("Mod-k");
    expect(eventToChord({ key: "k", ctrlKey: true }, MAC)).toBe("Ctrl-k");
  });

  it("Cmd+Ctrl+K carries both, in canonical order", () => {
    // Both modifiers are real and distinct on macOS, so the chord has to hold
    // both — a mapping that dropped one would silently alias two bindings.
    expect(eventToChord({ key: "k", metaKey: true, ctrlKey: true }, MAC)).toBe(
      "Mod-Ctrl-k",
    );
  });
});

// ── 3. "Ctrl does nothing on mac", as a dispatch claim ──────────────────────

describe("a Mod binding does not fire on a macOS Ctrl press", () => {
  // `commandIdsForChord` is what the dispatcher consults, so this asserts the
  // behaviour rather than the string. The keymap below is the shape
  // `effectiveKeymap` produces.
  const keymap = { "palette.open": ["Mod-k"], "editor.bold": ["Mod-b"] };

  it("Cmd+K opens the palette on macOS", () => {
    const chord = eventToChord({ key: "k", metaKey: true }, MAC)!;
    expect(commandIdsForChord(chord, keymap)).toEqual(["palette.open"]);
  });

  it("Ctrl+K opens NOTHING on macOS", () => {
    const chord = eventToChord({ key: "k", ctrlKey: true }, MAC)!;
    expect(
      commandIdsForChord(chord, keymap),
      "a Ctrl press matched a Mod binding on macOS, where Ctrl is not the " +
        "accelerator — the command would fire on a keystroke the user did not " +
        "mean as one",
    ).toEqual([]);
  });

  it("…and Ctrl+K DOES open the palette off macOS, so the negative is not vacuous", () => {
    const chord = eventToChord({ key: "k", ctrlKey: true }, OTHER)!;
    expect(commandIdsForChord(chord, keymap)).toEqual(["palette.open"]);
  });

  it("the Windows key opens nothing either, on the platform where it is not Mod", () => {
    const chord = eventToChord({ key: "k", metaKey: true }, OTHER)!;
    expect(commandIdsForChord(chord, keymap)).toEqual([]);
  });
});
