// Stories for the settings panels (myne-md/myne#832).
//
// One entry per settings surface. See `primitives.tsx` for the descriptor shape.
// Breadth over depth: a single `default` state per surface. Panels read their
// data through the seam, so `PREFS_FIXTURE` supplies a full default `vault.prefs`
// (the named `unlocked` fixture answers `prefs_read` with `{}`, leaving every
// field a panel reads `undefined`); a panel that renders only inside a provider
// gets that provider here.

import type { ReactNode } from "react";
import type { Fixture, StoryDescriptor } from "../types";
import { FIXTURE_VAULT_ID } from "../../fixtures";
import { SidebarStateProvider } from "@app/notes/sidebarState";
import { WorkspaceProvider } from "@app/notes/workspaceContext";

import { AboutPanel } from "@app/components/settings/AboutPanel";
import { AccountPanel } from "@app/components/settings/AccountPanel";
import { AiOnboardingSurface } from "@app/components/settings/AiOnboardingSurface";
import { AiPanel } from "@app/components/settings/AiPanel";
import { AiProviderConsent } from "@app/components/settings/AiProviderConsent";
import { AppearancePanel } from "@app/components/settings/AppearancePanel";
import { ArchiveSettings } from "@app/components/settings/ArchiveSettings";
import { AttachmentCompressionSettings } from "@app/components/settings/AttachmentCompressionSettings";
import { AttachmentOcrSettings } from "@app/components/settings/AttachmentOcrSettings";
import { AutomaticBackupBlock } from "@app/components/settings/AutomaticBackupBlock";
import { CliAccessSettings } from "@app/components/settings/CliAccessSettings";
import { ConnectedExtensions } from "@app/components/settings/ConnectedExtensions";
import { ControlBlock } from "@app/components/settings/ControlBlock";
import { CustomThemesSection } from "@app/components/settings/CustomThemesSection";
import { DateTimeSettings } from "@app/components/settings/DateTimeSettings";
import { DefaultViewModeSettings } from "@app/components/settings/DefaultViewModeSettings";
import { EditorPanel } from "@app/components/settings/EditorPanel";
import { FilesPanel } from "@app/components/settings/FilesPanel";
import { FocusModeSettings } from "@app/components/settings/FocusModeSettings";
import { FolderNotesSettings } from "@app/components/settings/FolderNotesSettings";
import { HotkeysPanel } from "@app/components/settings/HotkeysPanel";
import { LanguageSelect } from "@app/components/settings/LanguageSelect";
import { LineNumbersSettings } from "@app/components/settings/LineNumbersSettings";
import { MemorySection } from "@app/components/settings/MemorySection";
import { MigrateVaultForm } from "@app/components/settings/MigrateVaultForm";
import { NetworkPanel } from "@app/components/settings/NetworkPanel";
import { NewNoteLocationSettings } from "@app/components/settings/NewNoteLocationSettings";
import { PeriodicNotesSettings } from "@app/components/settings/PeriodicNotesSettings";
import { PlainFileSettings } from "@app/components/settings/PlainFileSettings";
import { PrivacyPanel } from "@app/components/settings/PrivacyPanel";
import { QuickUnlockSettings } from "@app/components/settings/QuickUnlockSettings";
import { ReminderSettings } from "@app/components/settings/ReminderSettings";
import { RibbonCustomizeSettings } from "@app/components/settings/RibbonCustomizeSettings";
import { SettingRow } from "@app/components/settings/SettingRow";
import { SettingsSection } from "@app/components/settings/SettingsSection";
import { SettleMigrationBlock } from "@app/components/settings/SettleMigrationBlock";
import { SpellSettings } from "@app/components/settings/SpellSettings";
import { StartupOpenSettings } from "@app/components/settings/StartupOpenSettings";
import { StoragePanel } from "@app/components/settings/StoragePanel";
import { SyncPanel } from "@app/components/settings/SyncPanel";
import { ToolbarCustomizeSettings } from "@app/components/settings/ToolbarCustomizeSettings";
import { TranscriptionPanel } from "@app/components/settings/TranscriptionPanel";
import { TypographySettings } from "@app/components/settings/TypographySettings";
import { ViewsSettings } from "@app/components/settings/ViewsSettings";
import { VimModeSettings } from "@app/components/settings/VimModeSettings";
import { BrowserIcon } from "@app/components/settings/browser-icons";
import { SettingsSearch } from "@app/components/settings/search/SettingsSearch";
import { SettingsSearchResults } from "@app/components/settings/search/SettingsSearchResults";

const noop = () => {};

// Default `vault.prefs`, mirroring the host's `PrefsView::default()`. A panel
// that reads a pref field needs the whole object: the named `unlocked` fixture
// answers `prefs_read` with `{}`, so any field a panel reads off it is
// `undefined` and a `.join()`/`.map()` on it throws.
const PREFS: Record<string, unknown> = {
  screen_capture_protection: true,
  show_note_timestamps: true,
  reminders_enabled: true,
  reminder_horizon_days: null,
  show_task_marker: true,
  transcription_enabled: true,
  deliberate_folders: [],
  ai_enabled: false,
  attachment_compression_enabled: true,
  attachment_ocr_enabled: true,
  ai_excluded_folders: [],
  developer_mode: false,
  chat_history_budget: null,
  archived_folders: [],
  auto_lock_seconds: null,
  auto_tag_enabled: false,
  ai_provider: null,
  ai_provider_consent: null,
  ai_provider_model: null,
  active_workspace: null,
  custom_theme: null,
  daily_date_format: null,
  daily_folder: null,
  daily_template: null,
  periodic_notes: {},
  favorites: [],
  item_order: {},
  editor_layout: null,
  date_format: null,
  time_format: null,
  timezone: null,
  editor_content_width: null,
  editor_default_view_mode: null,
  editor_focus_dim_inactive: null,
  editor_focus_typewriter: null,
  editor_font_family: null,
  editor_line_spacing: null,
  editor_text_size: null,
  editor_line_numbers: null,
  editor_vim_mode: null,
  archive_disabled: null,
  cli_enabled: false,
  cli_excluded_folders: [],
  cli_rate_limit_disabled: null,
  theme: null,
  folder_icons: {},
  folder_notes_enabled: false,
  device_names: {},
  hidden_bar_items: [],
  bar_items_order: [],
  color_groups: [],
  right_panel_active_tab: null,
  right_panel_hidden_tabs: [],
  right_panel_tab_order: [],
  editor_toolbar_order: [],
  editor_toolbar_hidden: [],
  editor_slash_order: [],
  editor_slash_hidden: [],
  item_colors: {},
  keymap: {},
  label: null,
  icon: null,
  last_backup_at: null,
  new_note_location: null,
  new_note_location_folder: null,
  startup_open: null,
  startup_open_note: null,
  spell_enabled: null,
  spell_languages: [],
  saved_views: [],
  view_order: [],
  ribbon_items: null,
  ribbon_visible: true,
};

const VAULT_SUMMARY = {
  id: FIXTURE_VAULT_ID,
  status: { kind: "Exists" },
  label: null,
  icon: null,
  last_unlock: null,
};

/** One unlocked vault with default prefs: what a settings panel sees in the app. */
const PREFS_FIXTURE: Fixture = {
  description: "one unlocked vault with default prefs",
  handlers: {
    "plugin:prefs|prefs_read": () => PREFS,
    "plugin:vault-unlock|vault_list": () => [VAULT_SUMMARY],
    "plugin:vault-unlock|vault_slot_kind": () => "Unlocked",
    // AI panels read these object-shaped commands; the fake host's `[]` default
    // makes `endpoint.url`/`p.members` `undefined` and the surface throws.
    "plugin:local-inference|get_ai_endpoint": () => null,
    "plugin:local-inference|get_model_path": () => null,
    "plugin:local-inference|ai_capability_report": () => ({ compiled: false }),
    "plugin:prefs|ai_provider_has_key": () => false,
  },
};


/** Same vault, with sync answering a real (non-enrolled) state. */
const SYNC_FIXTURE: Fixture = {
  description: "one unlocked vault, sync not enrolled",
  handlers: {
    ...PREFS_FIXTURE.handlers,
    "plugin:sync|sync_status": () => ({ state: "not_enrolled" }),
    "plugin:sync|sync_list_roster": () => ({
      members: [],
      authority: "member",
      group_key_epoch: null,
    }),
    "plugin:sync|sync_list_vault_invites": () => [],
  },
};

/** Settings panels are rendered inside the modal's content column; give the
 *  story the same surface tokens so a panel that leans on them reads right. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: "var(--space-4)",
        background: "var(--bg-1)",
        color: "var(--fg-1)",
        fontFamily: "var(--font-sans)",
      }}
    >
      {children}
    </div>
  );
}

export const SETTINGS_STORIES: StoryDescriptor[] = [
  {
    id: "settings/aboutpanel/default",
    group: "settings",
    surface: "AboutPanel",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <AboutPanel />
      </Frame>
    ),
  },
  {
    id: "settings/accountpanel/default",
    group: "settings",
    surface: "AccountPanel",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <AccountPanel
          vaultId={FIXTURE_VAULT_ID}
          onChangePasswordSuccess={noop}
          onDeleteVaultSuccess={noop}
        />
      </Frame>
    ),
  },
  {
    id: "settings/aionboardingsurface/default",
    group: "settings",
    surface: "AiOnboardingSurface",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <AiOnboardingSurface
          open
          onClose={noop}
          downloads={false}
          onOpenProviderSetup={noop}
        />
      </Frame>
    ),
  },
  {
    id: "settings/aipanel/default",
    group: "settings",
    surface: "AiPanel",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <AiPanel onShowToast={noop} onDialogOpenChange={noop} />
      </Frame>
    ),
  },
  {
    id: "settings/aiproviderconsent/default",
    group: "settings",
    surface: "AiProviderConsent",
    state: "default",
    render: () => (
      <Frame>
        <AiProviderConsent
          open
          providerLabel="Local runtime"
          onAccept={noop}
          onCancel={noop}
        />
      </Frame>
    ),
  },
  {
    id: "settings/appearancepanel/default",
    group: "settings",
    surface: "AppearancePanel",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <AppearancePanel onOpenGraph={noop} onDialogOpenChange={noop} />
      </Frame>
    ),
  },
  {
    id: "settings/archivesettings/default",
    group: "settings",
    surface: "ArchiveSettings",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <SidebarStateProvider>
          <ArchiveSettings />
        </SidebarStateProvider>
      </Frame>
    ),
  },
  {
    id: "settings/attachmentcompressionsettings/default",
    group: "settings",
    surface: "AttachmentCompressionSettings",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <AttachmentCompressionSettings />
      </Frame>
    ),
  },
  {
    id: "settings/attachmentocrsettings/default",
    group: "settings",
    surface: "AttachmentOcrSettings",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <AttachmentOcrSettings />
      </Frame>
    ),
  },
  {
    id: "settings/automaticbackupblock/default",
    group: "settings",
    surface: "AutomaticBackupBlock",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <AutomaticBackupBlock vaultId={FIXTURE_VAULT_ID} onShowToast={noop} />
      </Frame>
    ),
  },
  {
    id: "settings/cliaccesssettings/default",
    group: "settings",
    surface: "CliAccessSettings",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <CliAccessSettings
          enabled={false}
          excludedFolders={[]}
          rateLimitDisabled={null}
          onSetEnabled={noop}
          onSetExcludedFolders={noop}
          onSetRateLimitDisabled={noop}
        />
      </Frame>
    ),
  },
  {
    id: "settings/connectedextensions/default",
    group: "settings",
    surface: "ConnectedExtensions",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <ConnectedExtensions />
      </Frame>
    ),
  },
  {
    id: "settings/controlblock/default",
    group: "settings",
    surface: "ControlBlock",
    state: "default",
    render: () => (
      <Frame>
        <ControlBlock
          label="Reordered item list"
          helper="A block that needs the full content width."
          control={<span>Control</span>}
        />
      </Frame>
    ),
  },
  {
    id: "settings/customthemessection/default",
    group: "settings",
    surface: "CustomThemesSection",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <CustomThemesSection activeCustom={null} onActiveCustomChange={noop} />
      </Frame>
    ),
  },
  {
    id: "settings/datetimesettings/default",
    group: "settings",
    surface: "DateTimeSettings",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <DateTimeSettings />
      </Frame>
    ),
  },
  {
    id: "settings/defaultviewmodesettings/default",
    group: "settings",
    surface: "DefaultViewModeSettings",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <DefaultViewModeSettings />
      </Frame>
    ),
  },
  {
    id: "settings/editorpanel/default",
    group: "settings",
    surface: "EditorPanel",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <SidebarStateProvider>
          <WorkspaceProvider>
            <EditorPanel onShowToast={noop} />
          </WorkspaceProvider>
        </SidebarStateProvider>
      </Frame>
    ),
  },
  {
    id: "settings/filespanel/default",
    group: "settings",
    surface: "FilesPanel",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <FilesPanel />
      </Frame>
    ),
  },
  {
    id: "settings/focusmodesettings/default",
    group: "settings",
    surface: "FocusModeSettings",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <FocusModeSettings />
      </Frame>
    ),
  },
  {
    id: "settings/foldernotessettings/default",
    group: "settings",
    surface: "FolderNotesSettings",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <FolderNotesSettings />
      </Frame>
    ),
  },
  {
    id: "settings/hotkeyspanel/default",
    group: "settings",
    surface: "HotkeysPanel",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <HotkeysPanel />
      </Frame>
    ),
  },
  {
    id: "settings/languageselect/default",
    group: "settings",
    surface: "LanguageSelect",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <LanguageSelect />
      </Frame>
    ),
  },
  {
    id: "settings/linenumberssettings/default",
    group: "settings",
    surface: "LineNumbersSettings",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <LineNumbersSettings />
      </Frame>
    ),
  },
  {
    id: "settings/memorysection/default",
    group: "settings",
    surface: "MemorySection",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <MemorySection onShowToast={noop} aiEnabled={false} />
      </Frame>
    ),
  },
  {
    id: "settings/migratevaultform/default",
    group: "settings",
    surface: "MigrateVaultForm",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <MigrateVaultForm onMigrated={noop} />
      </Frame>
    ),
  },
  {
    id: "settings/networkpanel/default",
    group: "settings",
    surface: "NetworkPanel",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <NetworkPanel />
      </Frame>
    ),
  },
  {
    id: "settings/newnotelocationsettings/default",
    group: "settings",
    surface: "NewNoteLocationSettings",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <NewNoteLocationSettings />
      </Frame>
    ),
  },
  {
    id: "settings/periodicnotessettings/default",
    group: "settings",
    surface: "PeriodicNotesSettings",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <PeriodicNotesSettings />
      </Frame>
    ),
  },
  {
    id: "settings/plainfilesettings/default",
    group: "settings",
    surface: "PlainFileSettings",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <PlainFileSettings />
      </Frame>
    ),
  },
  {
    id: "settings/privacypanel/default",
    group: "settings",
    surface: "PrivacyPanel",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <PrivacyPanel onShowToast={noop} />
      </Frame>
    ),
  },
  {
    id: "settings/quickunlocksettings/default",
    group: "settings",
    surface: "QuickUnlockSettings",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <QuickUnlockSettings />
      </Frame>
    ),
  },
  {
    id: "settings/remindersettings/default",
    group: "settings",
    surface: "ReminderSettings",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <ReminderSettings enabled onEnabledChange={noop} />
      </Frame>
    ),
  },
  {
    id: "settings/ribboncustomizesettings/default",
    group: "settings",
    surface: "RibbonCustomizeSettings",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <RibbonCustomizeSettings />
      </Frame>
    ),
  },
  {
    id: "settings/settingrow/default",
    group: "settings",
    surface: "SettingRow",
    state: "default",
    render: () => (
      <Frame>
        <SettingRow
          label="Example setting"
          helper="Label left, control right, helper below."
          control={<span>Control</span>}
        />
      </Frame>
    ),
  },
  {
    id: "settings/settingssection/default",
    group: "settings",
    surface: "SettingsSection",
    state: "default",
    render: () => (
      <Frame>
        <SettingsSection title="Section heading">
          <span>Section body</span>
        </SettingsSection>
      </Frame>
    ),
  },
  {
    id: "settings/settlemigrationblock/default",
    group: "settings",
    surface: "SettleMigrationBlock",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <SettleMigrationBlock onSettled={noop} />
      </Frame>
    ),
  },
  {
    id: "settings/spellsettings/default",
    group: "settings",
    surface: "SpellSettings",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <SpellSettings />
      </Frame>
    ),
  },
  {
    id: "settings/startupopensettings/default",
    group: "settings",
    surface: "StartupOpenSettings",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <StartupOpenSettings />
      </Frame>
    ),
  },
  {
    id: "settings/storagepanel/default",
    group: "settings",
    surface: "StoragePanel",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <StoragePanel
          vaultId={FIXTURE_VAULT_ID}
          onImportObsidian={noop}
          onBackupVault={noop}
          onRestoreBackup={noop}
          onExportVault={noop}
          onShowToast={noop}
        />
      </Frame>
    ),
  },
  {
    id: "settings/syncpanel/default",
    group: "settings",
    surface: "SyncPanel",
    state: "default",
    fixture: SYNC_FIXTURE,
    render: () => (
      <Frame>
        <SidebarStateProvider>
          <SyncPanel onMigrated={noop} onDialogOpenChange={noop} />
        </SidebarStateProvider>
      </Frame>
    ),
  },
  {
    id: "settings/toolbarcustomizesettings/default",
    group: "settings",
    surface: "ToolbarCustomizeSettings",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <ToolbarCustomizeSettings />
      </Frame>
    ),
  },
  {
    id: "settings/transcriptionpanel/default",
    group: "settings",
    surface: "TranscriptionPanel",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <TranscriptionPanel />
      </Frame>
    ),
  },
  {
    id: "settings/typographysettings/default",
    group: "settings",
    surface: "TypographySettings",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <TypographySettings />
      </Frame>
    ),
  },
  {
    id: "settings/viewssettings/default",
    group: "settings",
    surface: "ViewsSettings",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <ViewsSettings />
      </Frame>
    ),
  },
  {
    id: "settings/vimmodesettings/default",
    group: "settings",
    surface: "VimModeSettings",
    state: "default",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <VimModeSettings />
      </Frame>
    ),
  },
  {
    id: "settings/browser-icons/default",
    group: "settings",
    surface: "browser-icons",
    state: "default",
    render: () => (
      <Frame>
        <BrowserIcon extensionId="example-extension-id" />
      </Frame>
    ),
  },
  {
    id: "settings/settingssearch/default",
    group: "settings",
    surface: "SettingsSearch",
    state: "default",
    render: () => (
      <Frame>
        <SettingsSearch query="" onQueryChange={noop} />
      </Frame>
    ),
  },
  {
    id: "settings/settingssearchresults/default",
    group: "settings",
    surface: "SettingsSearchResults",
    state: "default",
    render: () => (
      <Frame>
        <SettingsSearchResults
          query="theme"
          onSelect={noop}
          results={[
            {
              id: "settings.appearance.theme",
              panelId: "appearance",
              titleKey: "settings.appearance.themeTitle",
              descriptionKey: "settings.appearance.themeHelper",
            },
          ]}
        />
      </Frame>
    ),
  },
];
