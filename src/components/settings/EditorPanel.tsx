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

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { TypographySettings } from "./TypographySettings";
import { LineNumbersSettings } from "./LineNumbersSettings";
import { VimModeSettings } from "./VimModeSettings";
import { ToolbarCustomizeSettings } from "./ToolbarCustomizeSettings";
import { DefaultViewModeSettings } from "./DefaultViewModeSettings";
import { FocusModeSettings } from "./FocusModeSettings";
import { SpellSettings } from "./SpellSettings";
import { DailyNotesSettings } from "./DailyNotesSettings";
import { ArchiveSettings } from "./ArchiveSettings";
import { ReminderSettings } from "./ReminderSettings";
import { PANEL_ROOT_STYLE } from "./panel-styles";
import { SettingsSection } from "./SettingsSection";
import { usePrefs } from "../../hooks/usePrefs";

export function EditorPanel() {
  const { t } = useTranslation();
  // Task reminders (MYND-618) read their pref here and echo the toggle locally:
  // `usePrefs` reads once on mount, so the panel — not the hook — is what keeps
  // the switch in step with the write the block performs itself.
  const { prefs } = usePrefs();
  const [remindersEnabled, setRemindersEnabledEcho] = useState<boolean | null>(null);
  useEffect(() => {
    setRemindersEnabledEcho(null);
  }, [prefs.reminders_enabled]);

  return (
    <div style={PANEL_ROOT_STYLE}>
      {/* MYND-624: grouped rather than run together. The order within each group
          is unchanged; only the seams are new. */}
      <SettingsSection
        title={t("settings.editor.sections.text")}
        testId="settings.section.editor-text"
      >
        {/* Editor-typography (editor-typography) — text size / line spacing /
            content width / font family presets. */}
        <TypographySettings />
        {/* Line-number gutter toggle (editor-line-numbers, MYND-314) — off by
            default. */}
        <LineNumbersSettings />
      </SettingsSection>

      <SettingsSection
        title={t("settings.editor.sections.editing")}
        testId="settings.section.editor-editing"
      >
        {/* Vim keyboard mode (vim-keyboard-mode, MYND-313) — optional modal
            editing; off by default. The engine is only downloaded when this is
            turned on.

            Behind Developer mode (#181), the same setting-level gate the CLI
            block in PrivacyPanel carries: a power-user editing affordance kept
            out of the default Settings surface. It stays in Editor rather than
            moving to a Developer panel so "where's my vim setting?" still lands
            where the topic lives. Hiding is not disabling — an already-enabled
            keymap keeps running when the mode goes back off. */}
        {prefs.developer_mode && <VimModeSettings />}
        {/* Default view mode (reading-source-modes, MYND-299) — Live/Reading/
            Source a note opens in; per-tab override via ⇧⌘E. */}
        <DefaultViewModeSettings />
        {/* Focus-mode behaviours (focus-mode, MYND-348) — typewriter scroll +
            dim inactive lines, honored when focus mode (⇧⌘F) is active. */}
        <FocusModeSettings />
        {/* Floating-toolbar customization (MYND-336) — reorder + show/hide the
            selection toolbar's buttons over the frozen command vocabulary. */}
        <ToolbarCustomizeSettings />
      </SettingsSection>

      <SettingsSection
        title={t("settings.editor.sections.writing")}
        testId="settings.section.editor-writing"
      >
        {/* Spell-check configuration (MYND-267) — toggle + language picker. */}
        <SpellSettings />
        {/* Daily-notes configuration (MYND-191) — folder / date-format /
            template. */}
        <DailyNotesSettings />
        {/* Task reminders (MYND-618) — note-authoring behaviour, which is why it
            belongs in this group rather than under Appearance. Device-local:
            whether THIS machine is interrupted is a property of the machine. */}
        <ReminderSettings
          enabled={remindersEnabled ?? prefs.reminders_enabled}
          horizonDays={prefs.reminder_horizon_days}
          onEnabledChange={setRemindersEnabledEcho}
        />
      </SettingsSection>

      <SettingsSection
        title={t("settings.editor.sections.features")}
        testId="settings.section.editor-features"
      >
        {/* Note-archive feature toggle — on by default; turning it off restores
            every archived note and hides the archive controls. */}
        <ArchiveSettings />
      </SettingsSection>
    </div>
  );
}
