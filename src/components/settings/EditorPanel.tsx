// Settings → Editor panel: note-authoring behaviour preferences that are not
// visual — spell-check (toggle + language picker, MYND-267) and daily-notes
// configuration (folder / date-format / template, MYND-191). Both moved here
// from the Appearance panel, which had become a grab-bag of visual + editor
// controls; the Editor panel keeps Appearance purely visual (theme / custom
// theme). Taxonomy change recorded in `docs/decisions.md`
// (supersedes the 2026-05-08 5-panel lock).
//
// Each child control persists **disk-first** with no in-flight gating (the
// writes are fast, not Argon2-bound), matching their prior behaviour under
// Appearance. This panel is a thin composition shell — the persistence logic
// lives in the two child components.

import { TypographySettings } from "./TypographySettings";
import { SpellSettings } from "./SpellSettings";
import { DailyNotesSettings } from "./DailyNotesSettings";
import { PANEL_ROOT_STYLE } from "./panel-styles";

export function EditorPanel() {
  return (
    <div style={PANEL_ROOT_STYLE}>
      {/* Editor-typography (editor-typography) — text size / line spacing /
          content width / font family presets. First, as the core authoring
          surface. */}
      <TypographySettings />

      {/* Spell-check configuration (MYND-267) — toggle + language picker. */}
      <SpellSettings />

      {/* Daily-notes configuration (MYND-191) — folder / date-format / template. */}
      <DailyNotesSettings />
    </div>
  );
}
