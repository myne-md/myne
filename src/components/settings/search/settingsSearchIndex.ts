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
    // NO `capability`, and that is the asymmetry with the override entry
    // below. `PrivacyPanel` renders THIS row unconditionally, so tagging it
    // was the inverse of the rule `src/CLAUDE.md` states: search filtered it
    // out on web while the panel rendered it, which is a setting a user can
    // see and cannot find. The prose in this file and in
    // `check-web-surfaces.mjs` said the two rows matched; correcting the
    // prose without correcting the gate would have left the same defect with
    // better documentation.
    panelId: "privacy",
    titleKey: "settings.privacy.screenCaptureLabel",
    descriptionKey: "settings.privacy.screenCaptureHelperOn",
    keywordsKey: "settings.search.keywords.screenCapture",
  },
  {
    // myne-md/myne#482. The device-local escape hatch, mirrored here so a user
    // who took it pre-unlock has an obvious way back. `capability`-tagged
    // because `PrivacyPanel` wraps THIS row in `has("screenCaptureProtection")`
    // and an untagged entry would navigate to an anchor that was never
    // rendered. The per-vault row above is NOT gated, so the two differ: this
    // comment claimed they matched, and the web verdict in
    // `check-web-surfaces.mjs` said the same, both wrongly. The gate is new and
    // one-sided, and it stays that way deliberately: the per-vault field is
    // vault content that a user may want to read and set on a client where the
    // native call does nothing, while this row writes a device-local file whose
    // only purpose is suppressing a call that client never makes.
    //
    // No `developerGated`: the person this exists for is a low-vision or
    // remote-desktop user on a black window, and a setting behind Developer
    // mode cannot be found by them.
    id: "privacy.screen-capture-override",
    capability: "screenCaptureProtection",
    panelId: "privacy",
    titleKey: "settings.privacy.screenCaptureOverrideLabel",
    descriptionKey: "settings.privacy.screenCaptureOverrideHelper",
    keywordsKey: "settings.search.keywords.screenCaptureOverride",
  },
  {
    // myne-md/myne#411. One gate, and deliberately not the other.
    //
    // `capability`, because PrivacyPanel omits the row where
    // `lockedVaultNames` is absent, and an untagged entry would navigate to an
    // anchor that was never rendered. The capability is about the locked
    // picker and the keychain-sealed store behind it, not about the setting.
    //
    // No `developerGated`: `developer_mode` is a per-vault `vault.prefs` field
    // and the picker this governs is device-wide, and the person the option is
    // fully honest for is the one who sets it before a first unlock ever
    // writes a name, and a control behind Developer mode cannot be found by
    // them.
    id: "privacy.hide-vault-names",
    capability: "lockedVaultNames",
    panelId: "privacy",
    testid: "settings.hide-vault-names",
    titleKey: "settings.privacy.hideVaultNamesLabel",
    descriptionKey: "settings.privacy.hideVaultNamesHelper",
    keywordsKey: "settings.search.keywords.hideVaultNames",
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
  // CLI terminal access (MYND-490). All three carry `cliAccess`: the block is
  // omitted where the capability is absent, so an ungated entry would navigate
  // to an anchor that was never rendered. All three ALSO carry
  // `developerGated` (#181) — PrivacyPanel now renders the block only while
  // Developer mode is on, and the two gates are independent, so the entry
  // needs both to stay in step with its control. The first developer-gated
  // entries in a `core` panel: the flag has never meant "lives in the
  // Developer rail group", only "hidden while the mode is off".
  {
    id: "privacy.cli-access",
    capability: "cliAccess",
    developerGated: true,
    panelId: "privacy",
    titleKey: "settings.cliAccess.label",
    descriptionKey: "settings.cliAccess.helperOff",
    keywordsKey: "settings.search.keywords.cliAccess",
  },
  {
    id: "privacy.cli-excluded-folders",
    capability: "cliAccess",
    developerGated: true,
    panelId: "privacy",
    titleKey: "settings.cliAccess.excludedLabel",
    descriptionKey: "settings.cliAccess.excludedHelper",
    keywordsKey: "settings.search.keywords.cliExcludedFolders",
  },
  {
    id: "privacy.cli-rate-limit",
    capability: "cliAccess",
    developerGated: true,
    panelId: "privacy",
    titleKey: "settings.cliAccess.rateLimitLabel",
    descriptionKey: "settings.cliAccess.rateLimitHelper",
    keywordsKey: "settings.search.keywords.cliRateLimit",
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
    // Developer-gated (#181), like the CLI trio above and for the same
    // reason: EditorPanel renders the toggle only while Developer mode is on.
    // No `capability` — vim ships on every client, so this entry's gate is
    // the runtime one alone.
    id: "editor.vim-mode",
    developerGated: true,
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
    id: "editor.date-format",
    panelId: "editor",
    titleKey: "settings.dateTime.dateLabel",
    descriptionKey: "settings.dateTime.dateHelper",
    keywordsKey: "settings.search.keywords.dateFormat",
  },
  {
    id: "editor.time-format",
    panelId: "editor",
    titleKey: "settings.dateTime.timeLabel",
    descriptionKey: "settings.dateTime.timeHelper",
    keywordsKey: "settings.search.keywords.timeFormat",
  },
  {
    id: "editor.timezone",
    panelId: "editor",
    titleKey: "settings.dateTime.zoneLabel",
    descriptionKey: "settings.dateTime.zoneHelper",
    keywordsKey: "settings.search.keywords.timezone",
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
    titleKey: "settings.dailyNotes.sectionDaily",
    descriptionKey: "settings.dailyNotes.periodFolderLabel",
    keywordsKey: "settings.search.keywords.dailyNotes",
  },
  {
    id: "editor.daily-notes-date-format",
    panelId: "editor",
    titleKey: "settings.dailyNotes.sectionDaily",
    descriptionKey: "settings.dailyNotes.periodFormatLabel",
    keywordsKey: "settings.search.keywords.dailyNotes",
  },
  {
    id: "editor.daily-notes-template",
    panelId: "editor",
    titleKey: "settings.dailyNotes.sectionDaily",
    descriptionKey: "settings.dailyNotes.periodTemplateLabel",
    keywordsKey: "settings.search.keywords.dailyNotes",
  },
  // myne#177. The weekly and monthly rows get their own entries rather than
  // riding the daily ones: search scrolls to a setting's ANCHOR, and the three
  // periods are three anchors. Each is titled by its section and described by
  // its row, so three results are not all called "Folder".
  {
    id: "editor.weekly-notes-folder",
    panelId: "editor",
    titleKey: "settings.dailyNotes.sectionWeekly",
    descriptionKey: "settings.dailyNotes.periodFolderLabel",
    keywordsKey: "settings.search.keywords.periodicNotes",
  },
  {
    id: "editor.weekly-notes-date-format",
    panelId: "editor",
    titleKey: "settings.dailyNotes.sectionWeekly",
    descriptionKey: "settings.dailyNotes.periodFormatLabel",
    keywordsKey: "settings.search.keywords.periodicNotes",
  },
  {
    id: "editor.weekly-notes-template",
    panelId: "editor",
    titleKey: "settings.dailyNotes.sectionWeekly",
    descriptionKey: "settings.dailyNotes.periodTemplateLabel",
    keywordsKey: "settings.search.keywords.periodicNotes",
  },
  {
    id: "editor.monthly-notes-folder",
    panelId: "editor",
    titleKey: "settings.dailyNotes.sectionMonthly",
    descriptionKey: "settings.dailyNotes.periodFolderLabel",
    keywordsKey: "settings.search.keywords.periodicNotes",
  },
  {
    id: "editor.monthly-notes-date-format",
    panelId: "editor",
    titleKey: "settings.dailyNotes.sectionMonthly",
    descriptionKey: "settings.dailyNotes.periodFormatLabel",
    keywordsKey: "settings.search.keywords.periodicNotes",
  },
  {
    id: "editor.monthly-notes-template",
    panelId: "editor",
    titleKey: "settings.dailyNotes.sectionMonthly",
    descriptionKey: "settings.dailyNotes.periodTemplateLabel",
    keywordsKey: "settings.search.keywords.periodicNotes",
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
  {
    id: "editor.views",
    panelId: "editor",
    testid: "settings.views-enabled",
    titleKey: "settings.views.label",
    descriptionKey: "settings.views.helper",
  },
  {
    id: "editor.task-chip-color",
    panelId: "editor",
    testid: "settings.editor.taskChipColor",
    titleKey: "settings.editor.taskChipColor.label",
    descriptionKey: "settings.editor.taskChipColor.help",
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
    id: "files.folder-notes",
    panelId: "files",
    testid: "settings.folder-notes-toggle",
    titleKey: "settings.folderNotes.label",
    descriptionKey: "settings.folderNotes.helper",
    keywordsKey: "settings.search.keywords.folderNotes",
  },
  {
    id: "files.attachment-compression",
    panelId: "files",
    testid: "settings.attachment-compression",
    titleKey: "settings.attachmentCompression.label",
    descriptionKey: "settings.attachmentCompression.helper",
    keywordsKey: "settings.search.keywords.attachmentCompression",
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
    id: "appearance.accent",
    panelId: "appearance",
    testid: "settings.accent-color",
    titleKey: "settings.appearance.accentLabel",
    descriptionKey: "settings.appearance.accentHelper",
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
    // A pointer row, not a control (MYND-604): the graph's own settings live in
    // the graph pane. Indexed anyway — "where do I change how the graph looks?"
    // is exactly the question Settings search is asked, and the row it lands on
    // answers it.
    id: "appearance.graph-settings",
    panelId: "appearance",
    testid: "settings.open-graph",
    titleKey: "settings.appearance.graphSettingsLabel",
    descriptionKey: "settings.appearance.graphSettingsHelper",
    keywordsKey: "settings.search.keywords.graphSettings",
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
    id: "about.legal",
    panelId: "about",
    titleKey: "settings.about.legalLabel",
    descriptionKey: "settings.about.legalHelper",
    keywordsKey: "settings.search.keywords.legal",
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
    // The remote-provider block (myne#415). `developerGated` AND `capability`
    // both apply: they are independent gates and neither implies the other
    // (`src/CLAUDE.md`) — the whole AI panel is behind Developer mode, and it
    // is absent entirely where the platform has no local-AI capability.
    id: "ai.provider",
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    titleKey: "settings.ai.providerLabel",
    descriptionKey: "settings.ai.providerHelper",
    keywordsKey: "settings.search.keywords.aiProvider",
  },
  {
    // Scrolls to the provider BLOCK, via the testid fallback, rather than to
    // the chooser itself: the chooser only renders once a provider is named,
    // so its own anchor would be missing exactly when someone searches for it
    // — the "navigates to a panel and scrolls to nothing" failure the
    // capability gating above exists to prevent, in its runtime form.
    id: "ai.provider-model",
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    testid: "ai.provider-section",
    titleKey: "settings.ai.providerModelLabel",
    descriptionKey: "settings.ai.providerModelHelper",
    keywordsKey: "settings.search.keywords.aiProviderModel",
  },
  {
    id: "ai.endpoint",
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    titleKey: "settings.ai.endpointLabel",
    descriptionKey: "settings.ai.endpointHelper",
    keywordsKey: "settings.search.keywords.aiEndpoint",
  },
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
    id: "ai.auto-tag",
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    titleKey: "settings.ai.autoTagLabel",
    descriptionKey: "settings.ai.autoTagHelper",
    keywordsKey: "settings.search.keywords.aiAutoTag",
    testid: "ai.auto-tag-toggle",
  },
  {
    // myne-md/myne#617. Both gates, because they are independent and neither
    // implies the other: `capability` drops it where there is no local-AI
    // surface at all, `developerGated` drops it where the group is hidden.
    // Search that found a setting the panel never rendered would scroll to
    // nothing.
    id: "ai.history-budget",
    capability: "localAi",
    developerGated: true,
    panelId: "ai",
    titleKey: "settings.ai.historyBudgetLabel",
    descriptionKey: "settings.ai.historyBudgetHelper",
    keywordsKey: "settings.search.keywords.aiHistoryBudget",
    testid: "ai.history-budget-input",
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

  // ── Network (Developer group, MYND-650) ────────────────────────────────────
  {
    // The keyword string deliberately includes "anonymity": someone searching
    // for it should land exactly here, on copy whose first sentence says Tor
    // mode does NOT make them anonymous to Myne. Keywords are a haystack, never
    // rendered, so this broadens the match without making the claim.
    id: "network.tor-routing",
    capability: "torRouting",
    developerGated: true,
    panelId: "network",
    titleKey: "settings.network.torLabel",
    descriptionKey: "settings.network.torHelper",
    keywordsKey: "settings.search.keywords.torRouting",
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
