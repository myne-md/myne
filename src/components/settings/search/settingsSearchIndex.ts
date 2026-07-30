// Settings search-index registry (MYND-536). The single declarative source of
// truth for what the Settings search can find. Matching runs against THIS static
// array, never the rendered DOM — panels run IPC on mount (prefsRead / usePrefs),
// so mounting all ten to scan their text is rejected as heavy + fragile.
//
// Each entry names an i18n key for its title (+ optional description + optional
// translatable keyword/synonym string) and the `panelId` that owns it. The `id`
// doubles as the `data-setting-anchor="<id>"` scroll target; where a setting
// already exposes a stable `data-testid` the entry records it as `testid` and the
// shell's scroll/flash resolver falls back to it — so most settings need no panel
// edit. Titles/descriptions reference the SAME keys the panels already render, so
// search text can't drift from the UI; a few settings whose live label is an
// inline string (or lives outside the `settings.*` namespace) get dedicated
// `settings.search.extra.*` / `sync.panel.*` keys.
//
// CONVENTION (see PRD + candidate decisions.md entry): a new user-facing setting
// ships with its entry here in the same change. The drift test guards key
// resolution + panel coverage, but cannot know about an entry that was never added.

import type { PanelId } from "../../SettingsModal";
import { has, type Capability } from "../../../platform/capabilities";

export interface SettingsIndexEntry {
  /** Unique, stable id. Also the `data-setting-anchor` value (Task 4). */
  id: string;
  /** Owning rail panel — the navigation target + results grouping key. */
  panelId: PanelId;
  /** Existing `data-testid` on this setting's control, used as the scroll/flash
   *  fallback target when no `data-setting-anchor` is present (optional). */
  testid?: string;
  /** i18n key for the setting's display title (required). */
  titleKey: string;
  /** i18n key for the setting's description/helper (optional). */
  descriptionKey?: string;
  /** i18n key resolving to a space/comma-joined synonym string (optional,
   *  translatable). Broadens matching beyond the literal label. */
  keywordsKey?: string;
  /**
   * The capability this setting's control needs (phase3-web-client task 96).
   *
   * Matching runs against THIS static array rather than the rendered DOM —
   * panels are not mounted, which is the whole reason the registry exists. That
   * makes an ungated index actively harmful on a client with absent
   * capabilities: the search happily finds a setting, navigates to its panel and
   * scrolls to a `data-setting-anchor` that was never rendered, leaving the user
   * at a panel with no explanation and no setting.
   *
   * Absent ⇒ the setting is unconditional. Present ⇒ the entry is filtered out
   * where `platform/capabilities.has()` says no, which is the same rule the rail
   * and the panels already use — one descriptor, three consumers, no third
   * source of truth.
   */
  capability?: Capability;
  /**
   * Whether this entry additionally requires the `developer_mode` preference
   * to be on (developer-mode feature, MYND-593). **Deliberately separate from
   * `capability`** — the capability set is a static per-build descriptor the
   * platform seam-contract tests rest on, while Developer mode is a runtime
   * user toggle; folding the two together would make a static invariant
   * dynamic. Settings search resolves straight to a panel id, so without this
   * an entry behind the gate would happily navigate into a hidden panel.
   */
  developerGated?: boolean;
}

// Ordered by rail order (account → … → about → ai), and within a panel by the
// order the settings appear in the panel. Keeping this aligned with the panels
// makes the additive `data-setting-anchor` pass in Task 4 a straight read-down.
export const SETTINGS_SEARCH_INDEX: readonly SettingsIndexEntry[] = [
  // ── Account ────────────────────────────────────────────────────────────────
  {
    id: "account.vault-label",
    panelId: "account",
    testid: "settings.label-input",
    titleKey: "settings.account.vaultLabelEyebrow",
    descriptionKey: "settings.account.vaultLabelHelper",
    keywordsKey: "settings.search.keywords.vaultLabel",
  },
  {
    id: "account.vault-icon",
    panelId: "account",
    testid: "settings.icon-picker",
    titleKey: "settings.account.vaultIconLabel",
    keywordsKey: "settings.search.keywords.vaultIcon",
  },
  {
    id: "account.change-password",
    panelId: "account",
    testid: "settings.change-password-cta",
    titleKey: "settings.account.changePasswordHeading",
    descriptionKey: "settings.account.changePasswordHelper",
    keywordsKey: "settings.search.keywords.changePassword",
  },
  {
    id: "account.danger-zone",
    panelId: "account",
    testid: "settings.delete-vault-cta",
    titleKey: "settings.account.dangerZoneHeading",
    descriptionKey: "settings.account.dangerZoneHelper",
    keywordsKey: "settings.search.keywords.dangerZone",
  },

  // ── Privacy ────────────────────────────────────────────────────────────────
  {
    id: "privacy.screen-capture",
    capability: "screenCaptureProtection",
    panelId: "privacy",
    titleKey: "settings.privacy.screenCaptureLabel",
    descriptionKey: "settings.privacy.screenCaptureHelperOn",
    keywordsKey: "settings.search.keywords.screenCapture",
  },
  {
    id: "privacy.realtime-sync",
    panelId: "privacy",
    testid: "settings.realtime-sync-info",
    titleKey: "settings.privacy.realtimeSyncLabel",
    descriptionKey: "settings.privacy.realtimeSyncHelper",
    keywordsKey: "settings.search.keywords.realtimeSync",
  },
  {
    // The "Continue where you left off" toggle renders inline English (no
    // `settings.*` key today); give search a dedicated translatable pair.
    id: "privacy.last-active-note",
    panelId: "privacy",
    testid: "settings.last-active-note-toggle",
    titleKey: "settings.search.extra.lastActiveNoteTitle",
    descriptionKey: "settings.search.extra.lastActiveNoteDesc",
    keywordsKey: "settings.search.keywords.lastActiveNote",
  },
  {
    id: "privacy.auto-lock",
    panelId: "privacy",
    testid: "settings.auto-lock-select",
    titleKey: "settings.privacy.autoLockLabel",
    descriptionKey: "settings.privacy.autoLockHelper",
    keywordsKey: "settings.search.keywords.autoLock",
  },
  {
    id: "privacy.quick-unlock",
    capability: "biometricQuickUnlock",
    panelId: "privacy",
    testid: "settings.quick-unlock",
    titleKey: "settings.quickUnlock.title",
    descriptionKey: "settings.quickUnlock.setupHelper",
    keywordsKey: "settings.search.keywords.quickUnlock",
  },

  // ── Sync (keys live under `sync.panel.*`, not `settings.*`) ─────────────────
  {
    id: "sync.status",
    panelId: "sync",
    titleKey: "sync.panel.status.label",
    descriptionKey: "sync.panel.status.helper",
    keywordsKey: "settings.search.keywords.syncStatus",
  },
  {
    id: "sync.devices",
    panelId: "sync",
    titleKey: "sync.panel.devices.label",
    keywordsKey: "settings.search.keywords.syncDevices",
  },
  {
    id: "sync.add-device",
    panelId: "sync",
    titleKey: "sync.panel.addDevice.label",
    descriptionKey: "sync.panel.addDevice.helper",
    keywordsKey: "settings.search.keywords.syncAddDevice",
  },
  {
    id: "sync.conflicts",
    panelId: "sync",
    titleKey: "sync.panel.conflicts.label",
    descriptionKey: "sync.panel.conflicts.helper",
    keywordsKey: "settings.search.keywords.syncConflicts",
  },
  {
    id: "sync.recovered",
    panelId: "sync",
    titleKey: "sync.panel.recovered.label",
    descriptionKey: "sync.panel.recovered.helper",
    keywordsKey: "settings.search.keywords.syncRecovered",
  },
  {
    id: "sync.server",
    panelId: "sync",
    titleKey: "sync.panel.server.label",
    keywordsKey: "settings.search.keywords.syncServer",
  },

  // ── Editor ─────────────────────────────────────────────────────────────────
  {
    id: "editor.text-size",
    panelId: "editor",
    titleKey: "settings.typography.textSizeLabel",
    keywordsKey: "settings.search.keywords.textSize",
  },
  {
    id: "editor.line-spacing",
    panelId: "editor",
    titleKey: "settings.typography.lineSpacingLabel",
    keywordsKey: "settings.search.keywords.lineSpacing",
  },
  {
    id: "editor.content-width",
    panelId: "editor",
    titleKey: "settings.typography.contentWidthLabel",
    descriptionKey: "settings.typography.contentWidthHelper",
    keywordsKey: "settings.search.keywords.contentWidth",
  },
  {
    id: "editor.font",
    panelId: "editor",
    titleKey: "settings.typography.fontLabel",
    keywordsKey: "settings.search.keywords.font",
  },
  {
    id: "editor.line-numbers",
    panelId: "editor",
    testid: "settings.line-numbers",
    titleKey: "settings.lineNumbers.label",
    descriptionKey: "settings.lineNumbers.helper",
    keywordsKey: "settings.search.keywords.lineNumbers",
  },
  {
    id: "editor.vim-mode",
    panelId: "editor",
    testid: "settings.vim-mode",
    titleKey: "settings.vimMode.label",
    descriptionKey: "settings.vimMode.helper",
    keywordsKey: "settings.search.keywords.vimMode",
  },
  {
    id: "editor.toolbar",
    panelId: "editor",
    testid: "settings.toolbar-customize",
    titleKey: "settings.toolbarCustomize.label",
    descriptionKey: "settings.toolbarCustomize.helper",
    keywordsKey: "settings.search.keywords.toolbar",
  },
  {
    id: "editor.view-mode",
    panelId: "editor",
    titleKey: "settings.viewMode.label",
    descriptionKey: "settings.viewMode.helper",
    keywordsKey: "settings.search.keywords.viewMode",
  },
  {
    id: "editor.focus-dim",
    panelId: "editor",
    testid: "settings.focus-dim",
    titleKey: "settings.focusMode.dimLabel",
    descriptionKey: "settings.focusMode.dimHelper",
    keywordsKey: "settings.search.keywords.focusMode",
  },
  {
    id: "editor.focus-typewriter",
    panelId: "editor",
    testid: "settings.focus-typewriter",
    titleKey: "settings.focusMode.typewriterLabel",
    descriptionKey: "settings.focusMode.typewriterHelper",
    keywordsKey: "settings.search.keywords.focusMode",
  },
  {
    id: "editor.spell-check",
    capability: "spellCheck",
    panelId: "editor",
    testid: "settings.spell-check",
    titleKey: "settings.spell.label",
    descriptionKey: "settings.spell.helper",
    keywordsKey: "settings.search.keywords.spell",
  },
  {
    id: "editor.spell-languages",
    capability: "spellCheck",
    panelId: "editor",
    titleKey: "settings.spell.languagesLabel",
    descriptionKey: "settings.spell.languagesHelper",
    keywordsKey: "settings.search.keywords.spellLanguages",
  },
  {
    id: "editor.daily-notes-folder",
    panelId: "editor",
    titleKey: "settings.dailyNotes.folderLabel",
    descriptionKey: "settings.dailyNotes.folderHelper",
    keywordsKey: "settings.search.keywords.dailyNotes",
  },
  {
    id: "editor.daily-notes-date-format",
    panelId: "editor",
    titleKey: "settings.dailyNotes.dateFormatLabel",
    descriptionKey: "settings.dailyNotes.dateFormatHelper",
    keywordsKey: "settings.search.keywords.dailyNotes",
  },
  {
    id: "editor.daily-notes-template",
    panelId: "editor",
    titleKey: "settings.dailyNotes.templateLabel",
    descriptionKey: "settings.dailyNotes.templateHelper",
    keywordsKey: "settings.search.keywords.dailyNotes",
  },
  {
    id: "editor.reminders",
    panelId: "editor",
    testid: "settings.reminders-toggle",
    titleKey: "settings.reminders.label",
    keywordsKey: "settings.search.keywords.reminders",
  },
  {
    id: "editor.archive",
    panelId: "editor",
    testid: "settings.archive-disabled",
    titleKey: "settings.archive.label",
    descriptionKey: "settings.archive.helper",
    keywordsKey: "settings.search.keywords.archive",
  },

  // ── Files ──────────────────────────────────────────────────────────────────
  {
    id: "files.startup-open",
    panelId: "files",
    testid: "settings.startup-open-select",
    titleKey: "settings.files.startup.label",
    descriptionKey: "settings.files.startup.helper",
    keywordsKey: "settings.search.keywords.startupOpen",
  },
  {
    id: "files.new-note-location",
    panelId: "files",
    testid: "settings.new-note-location-select",
    titleKey: "settings.files.newNote.label",
    descriptionKey: "settings.files.newNote.helper",
    keywordsKey: "settings.search.keywords.newNoteLocation",
  },
  {
    id: "files.attachment-ocr",
    panelId: "files",
    testid: "settings.attachment-ocr",
    titleKey: "settings.attachmentOcr.label",
    descriptionKey: "settings.attachmentOcr.helper",
    keywordsKey: "settings.search.keywords.attachmentOcr",
  },

  // ── Transcription ──────────────────────────────────────────────────────────
  {
    id: "transcription.enabled",
    panelId: "transcription",
    testid: "settings.transcription",
    titleKey: "settings.transcription.label",
    descriptionKey: "settings.transcription.helper",
    keywordsKey: "settings.search.keywords.transcription",
  },

  // ── Hotkeys (the panel has its own in-panel search; one entry routes to it) ──
  {
    id: "hotkeys.shortcuts",
    panelId: "hotkeys",
    titleKey: "settings.shell.panels.hotkeys",
    descriptionKey: "settings.hotkeys.helper",
    keywordsKey: "settings.search.keywords.hotkeys",
  },

  // ── Appearance ─────────────────────────────────────────────────────────────
  {
    id: "appearance.theme",
    panelId: "appearance",
    titleKey: "settings.appearance.themeLabel",
    descriptionKey: "settings.appearance.themeHelper",
    keywordsKey: "settings.search.keywords.theme",
  },
  {
    id: "appearance.show-edit-times",
    panelId: "appearance",
    testid: "settings.note-timestamps-toggle",
    titleKey: "settings.appearance.showEditTimesLabel",
    descriptionKey: "settings.appearance.showEditTimesHelper",
    keywordsKey: "settings.search.keywords.showEditTimes",
  },
  {
    id: "appearance.custom-themes",
    panelId: "appearance",
    titleKey: "settings.customThemes.label",
    keywordsKey: "settings.search.keywords.customThemes",
  },
  {
    id: "appearance.language",
    panelId: "appearance",
    titleKey: "settings.language.label",
    descriptionKey: "settings.language.helper",
    keywordsKey: "settings.search.keywords.language",
  },

  // ── Storage ────────────────────────────────────────────────────────────────
  {
    id: "storage.backup",
    capability: "backup",
    panelId: "storage",
    titleKey: "settings.storage.backupLabel",
    descriptionKey: "settings.storage.backupHelper",
    keywordsKey: "settings.search.keywords.backup",
  },
  {
    id: "storage.export",
    capability: "vaultExport",
    panelId: "storage",
    titleKey: "settings.storage.exportLabel",
    keywordsKey: "settings.search.keywords.export",
  },
  {
    id: "storage.import",
    panelId: "storage",
    titleKey: "settings.storage.importLabel",
    keywordsKey: "settings.search.keywords.import",
  },
  {
    id: "storage.location",
    capability: "nativeSaveAs",
    panelId: "storage",
    titleKey: "settings.storage.locationLabel",
    keywordsKey: "settings.search.keywords.vaultLocation",
  },
  {
    id: "storage.auto-backup",
    capability: "backup",
    panelId: "storage",
    testid: "settings.auto-backup",
    titleKey: "settings.autoBackup.title",
    descriptionKey: "settings.autoBackup.helper",
    keywordsKey: "settings.search.keywords.autoBackup",
  },
  {
    id: "storage.clipper",
    capability: "clipper",
    panelId: "storage",
    testid: "settings.clipper-install",
    titleKey: "settings.clipperInstall.label",
    descriptionKey: "settings.clipperInstall.helper",
    keywordsKey: "settings.search.keywords.clipper",
  },

  // ── About ──────────────────────────────────────────────────────────────────
  {
    id: "about.build-channel",
    panelId: "about",
    titleKey: "settings.about.buildChannelLabel",
    keywordsKey: "settings.search.keywords.buildChannel",
  },
  {
    id: "about.changelog",
    panelId: "about",
    titleKey: "settings.about.changelogLabel",
    descriptionKey: "settings.about.changelogHelper",
    keywordsKey: "settings.search.keywords.changelog",
  },
  {
    id: "about.license",
    panelId: "about",
    titleKey: "settings.about.licenseLabel",
    keywordsKey: "settings.search.keywords.license",
  },
  {
    id: "about.threat-model",
    panelId: "about",
    titleKey: "settings.about.threatModelLabel",
    descriptionKey: "settings.about.threatModelHelper",
    keywordsKey: "settings.search.keywords.threatModel",
  },

  // ── AI (Developer group, MYND-593) ──────────────────────────────────────────
  {
    id: "ai.enable",
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    titleKey: "settings.ai.enableLabel",
    descriptionKey: "settings.ai.enableHelper",
    keywordsKey: "settings.search.keywords.aiEnable",
  },
  {
    id: "ai.models",
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    titleKey: "settings.ai.modelsLabel",
    descriptionKey: "settings.ai.modelsHelper",
    keywordsKey: "settings.search.keywords.aiModels",
  },
  {
    id: "ai.excluded-folders",
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    titleKey: "settings.ai.excludedLabel",
    descriptionKey: "settings.ai.excludedHelper",
    keywordsKey: "settings.search.keywords.aiExcluded",
  },
];

/**
 * The entries this client can actually navigate to right now.
 *
 * Every search path goes through here rather than through
 * {@link SETTINGS_SEARCH_INDEX} directly — the raw array stays exported because
 * the drift test needs to see ALL of it, including the entries this platform
 * hides. `developerModeEnabled` is the live `vault.prefs.developer_mode` value
 * (developer-mode feature, MYND-593) — a runtime toggle, unlike `capability`,
 * so it's threaded in as a parameter rather than read from a module-level
 * static the way the capability set is.
 */
export function visibleSettingsIndex(developerModeEnabled: boolean): readonly SettingsIndexEntry[] {
  return SETTINGS_SEARCH_INDEX.filter(
    (e) =>
      (e.capability === undefined || has(e.capability)) &&
      (!e.developerGated || developerModeEnabled),
  );
}
