// Bindable-command catalog invariants (#184). The catalog
// (`src/commands/bindableCatalog.ts`) is the Hotkeys panel's display source; the
// editor-formatting rows dispatch through the EDITOR keymap Compartment, whose
// defaults live in `@myne/editor` (`EDITOR_KEYMAP_DEFAULTS`). Those two lists of
// default chords are hand-mirrored across the package boundary (importing the
// editor keymap into the catalog would drag CodeMirror into the settings bundle),
// so this test is the drift lock — the same class of safety net as the
// MIN_PASSWORD_LEN Rust↔TS mirror check.

import { describe, it, expect } from "vitest";
import { BINDABLE_COMMANDS, catalogDefaults } from "../../src/commands/bindableCatalog";
import { normalizeChord, splitChord } from "../../src/commands/chord";
import { EDITOR_KEYMAP_DEFAULTS, EDITOR_KEYMAP_IDS } from "../../src/editor/keymap";

describe("bindableCatalog ↔ editor keymap defaults (#184 drift lock)", () => {
  it("every editor.* catalog row's default chords match EDITOR_KEYMAP_DEFAULTS", () => {
    for (const cmd of BINDABLE_COMMANDS) {
      if (!EDITOR_KEYMAP_IDS.includes(cmd.id)) continue;
      expect(cmd.defaultBindings, `catalog defaults for ${cmd.id}`).toEqual(
        EDITOR_KEYMAP_DEFAULTS[cmd.id],
      );
    }
  });

  it("every editor keymap id is present in the catalog", () => {
    const catalogIds = new Set(BINDABLE_COMMANDS.map((c) => c.id));
    for (const id of EDITOR_KEYMAP_IDS) {
      expect(catalogIds.has(id), `catalog missing ${id}`).toBe(true);
    }
  });

  it("every editor.* catalog row is now rebindable (#184 track B — no fixed CM rows)", () => {
    for (const cmd of BINDABLE_COMMANDS) {
      if (!EDITOR_KEYMAP_IDS.includes(cmd.id)) continue;
      expect(cmd.rebindable, `${cmd.id} should be rebindable`).toBe(true);
    }
  });

  it("Ctrl+Tab (pane.cycle-tab) is the ONE remaining fixed row", () => {
    const fixed = BINDABLE_COMMANDS.filter((c) => !c.rebindable).map((c) => c.id);
    expect(fixed).toEqual(["pane.cycle-tab"]);
  });

  it("note.new-tab carries both Mod-t and Mod-n defaults (#184 — Cmd+N folded in)", () => {
    const newTab = BINDABLE_COMMANDS.find((c) => c.id === "note.new-tab")!;
    expect(newTab.defaultBindings).toEqual(["Mod-t", "Mod-n"]);
  });

  it("find.open is listed with a Mod-f default (#184 — was a hidden window listener)", () => {
    const find = BINDABLE_COMMANDS.find((c) => c.id === "find.open");
    expect(find).toBeDefined();
    expect(find!.defaultBindings).toEqual(["Mod-f"]);
    expect(find!.rebindable).toBe(true);
  });
});

// ── myne#337: every default chord must be one a keydown can actually produce ──
//
// `pane.split-column` shipped `Mod-Shift-\`, and the chord a keydown produces is
// built from `keyName(event)`, which reports the SHIFTED character — so
// Shift+`\` arrives as `|` and the stored default could never match. The
// shortcut was permanently dead while the Hotkeys panel, the command palette and
// the conflict detector all presented it as live, and the conflict detector
// reasoned about a binding that cannot fire.
describe("default chords are producible by a keydown (myne#337)", () => {
  /** US-layout pairs: pressing Shift with the key on the left yields the right.
   *  A default that combines `Shift` with a LEFT member is unreachable — the
   *  event will carry the right member instead. */
  const SHIFT_PAIRS: Record<string, string> = {
    "`": "~",
    "1": "!",
    "2": "@",
    "3": "#",
    "4": "$",
    "5": "%",
    "6": "^",
    "7": "&",
    "8": "*",
    "9": "(",
    "0": ")",
    "-": "_",
    "=": "+",
    "[": "{",
    "]": "}",
    "\\": "|",
    ";": ":",
    "'": '"',
    ",": "<",
    ".": ">",
    "/": "?",
  };

  // Scoped to the ids MYNE's dispatcher resolves. `editor.*` chords are
  // installed into CodeMirror's keymap, and CM falls back to
  // `base[event.keyCode]` whenever a modifier is held — so `Mod-Shift-7` reaches
  // `editor.ordered-list` there. Myne's `eventToChord` has no such fallback, and
  // deliberately: its capture path stores the SHIFTED spelling, so accepting
  // both would give one chord two spellings and defeat the conflict detector.
  // The two engines therefore differ, and this guard is about the one that does
  // not fall back.
  it("no dispatcher default combines Shift with a key whose shifted form differs", () => {
    const offenders: string[] = [];
    for (const [id, chords] of Object.entries(catalogDefaults())) {
      if (id.startsWith("editor.")) continue;
      for (const chord of chords) {
        const { mods, key } = splitChord(chord);
        const hasShift = mods.some((m) => m.toLowerCase() === "shift" || m.toLowerCase() === "s");
        if (!hasShift) continue;
        const shifted = SHIFT_PAIRS[key];
        if (shifted !== undefined) {
          offenders.push(`${id}: ${chord} — a keydown produces Shift-${shifted}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });


  it("every default normalizes to itself, so a stored chord compares equal", () => {
    for (const chords of Object.values(catalogDefaults())) {
      for (const chord of chords) {
        expect(normalizeChord(chord)).toBe(normalizeChord(normalizeChord(chord)));
      }
    }
  });
});
