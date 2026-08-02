// Bindable-command catalog invariants (#184). The catalog
// (`src/commands/bindableCatalog.ts`) is the Hotkeys panel's display source; the
// editor-formatting rows dispatch through the EDITOR keymap Compartment, whose
// defaults live in `@myne/editor` (`EDITOR_KEYMAP_DEFAULTS`). Those two lists of
// default chords are hand-mirrored across the package boundary (importing the
// editor keymap into the catalog would drag CodeMirror into the settings bundle),
// so this test is the drift lock — the same class of safety net as the
// MIN_PASSWORD_LEN Rust↔TS mirror check.

import { describe, it, expect } from "vitest";
import { BINDABLE_COMMANDS } from "../../src/commands/bindableCatalog";
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
