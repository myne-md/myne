// Settings → Editor panel: note-authoring behaviour preferences that are not
// visual — spell-check (toggle + language picker, MYND-267) and daily-notes
// configuration (folder / date-format / template, MYND-191). Both moved here
// from the Appearance panel, which had become a grab-bag of visual + editor
// controls; the Editor panel keeps Appearance purely visual (theme / custom
// theme). Taxonomy change recorded in `design-notes.md`
// (supersedes the 2026-05-08 5-panel lock).
//
// Each child control persists **disk-first** with no in-flight gating (the
// writes are fast, not Argon2-bound), matching their prior behaviour under
// Appearance. This panel is a thin composition shell — the persistence logic
// lives in the two child components.

import { TypographySettings } from "./TypographySettings";
import { LineNumbersSettings } from "./LineNumbersSettings";
import { VimModeSettings } from "./VimModeSettings";
import { ToolbarCustomizeSettings } from "./ToolbarCustomizeSettings";
import { DefaultViewModeSettings } from "./DefaultViewModeSettings";
import { FocusModeSettings } from "./FocusModeSettings";
import { SpellSettings } from "./SpellSettings";
import { DailyNotesSettings } from "./DailyNotesSettings";
import { ArchiveSettings } from "./ArchiveSettings";
import { PANEL_ROOT_STYLE } from "./panel-styles";

export function EditorPanel() {
  return (
    <div style={PANEL_ROOT_STYLE}>
      {/* Editor-typography (editor-typography) — text size / line spacing /
          content width / font family presets. First, as the core authoring
          surface. */}
      <TypographySettings />

      {/* Line-number gutter toggle (editor-line-numbers, MYND-314) — off by
          default; lives next to typography as an editor-display preference. */}
      <LineNumbersSettings />

      {/* Vim keyboard mode (vim-keyboard-mode, MYND-313) — optional modal
          editing; off by default. Sits next to the line-number toggle as the
          other editor-input preference. The engine is only downloaded when this
          is turned on. */}
      <VimModeSettings />

      {/* Floating-toolbar customization (MYND-336) — reorder + show/hide the
          selection toolbar's buttons over the frozen command vocabulary. */}
      <ToolbarCustomizeSettings />

      {/* Default view mode (reading-source-modes, MYND-299) — Live/Reading/Source
          a note opens in; per-tab override via ⇧⌘E / the bottom-bar switcher. */}
      <DefaultViewModeSettings />

      {/* Focus-mode behaviours (focus-mode, MYND-348) — typewriter scroll + dim
          inactive lines, both honored when focus mode (⇧⌘F) is active. */}
      <FocusModeSettings />

      {/* Spell-check configuration (MYND-267) — toggle + language picker. */}
      <SpellSettings />

      {/* Daily-notes configuration (MYND-191) — folder / date-format / template. */}
      <DailyNotesSettings />

      {/* Note-archive feature toggle (archive-disable, MYND-…) — on by default;
          turning it off restores every archived note and hides the archive
          controls. Last, as a feature-level (not per-edit) preference. */}
      <ArchiveSettings />
    </div>
  );
}
