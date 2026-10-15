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
import { DEFAULT_PREFS, FIXTURE_VAULT_ID } from "../../fixtures";
import { SidebarStateProvider } from "@app/notes/sidebarState";
import { WorkspaceProvider } from "@app/notes/workspaceContext";

import { AboutPanel } from "@app/components/settings/AboutPanel";
import { BarCustomizeSettings } from "@app/components/settings/BarCustomizeSettings";
import { RecoveryDrillRow } from "@app/components/settings/RecoveryDrillRow";
import {
  CUSTOMIZE_LIST_STYLE,
  CustomizeRow,
  useDragReorder,
} from "@app/components/settings/CustomizeList";
import { AccountPanel } from "@app/components/settings/AccountPanel";
import { VaultPanel } from "@app/components/settings/VaultPanel";
import { AiOnboardingSurface } from "@app/components/settings/AiOnboardingSurface";
import { AiPanel } from "@app/components/settings/AiPanel";
import { AiProviderConsent } from "@app/components/settings/AiProviderConsent";
import { AppearancePanel } from "@app/components/settings/AppearancePanel";
import { ArchiveSettings } from "@app/components/settings/ArchiveSettings";
import { AttachmentCompressionSettings } from "@app/components/settings/AttachmentCompressionSettings";
import { AttachmentOcrSettings } from "@app/components/settings/AttachmentOcrSettings";
import { AutomaticBackupBlock } from "@app/components/settings/AutomaticBackupBlock";
import { CliAccessSettings } from "@app/components/settings/CliAccessSettings";
import { CliPanel } from "@app/components/settings/CliPanel";
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
import { MemberPasswordSettings } from "@app/components/settings/MemberPasswordSettings";
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
import { WRITABILITY_NONE } from "@app/components/settings/search/settingsSearchIndex";
import { action } from "../actions";
import { Switch } from "@app/components/primitives/Switch";

const noop = () => {};

// Default `vault.prefs`, mirroring the host's `PrefsView::default()`. A panel
// that reads a pref field needs the whole object: the named `unlocked` fixture
// answers `prefs_read` with `{}`, so any field a panel reads off it is
// `undefined` and a `.join()`/`.map()` on it throws.

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
    "plugin:prefs|prefs_read": () => DEFAULT_PREFS,
    "plugin:vault-unlock|vault_list": () => [VAULT_SUMMARY],
    "plugin:vault-unlock|vault_slot_kind": () => "Unlocked",
    // AI panels read these object-shaped commands; the fake host's `[]` default
    // makes `endpoint.url`/`p.members` `undefined` and the surface throws.
    "plugin:local-inference|get_ai_endpoint": () => null,
    "plugin:local-inference|get_model_path": () => null,
    "plugin:local-inference|ai_capability_report": () => ({ compiled: false }),
    "plugin:prefs|ai_provider_has_key": () => false,
    // `AboutPanel` reads this as a boolean and gates its toggle row on
    // `!== null`. Left unanswered, the fake host's benign `[]` default is not
    // null, so the row rendered with `aria-checked=""`. An invalid value for
    // `role="switch"`, which axe reports as a missing required attribute. The
    // real command returns a bool, so the fixture answers one (myne-md/myne#845).
    "plugin:update|update_get_auto_check": () => true,
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
    // Not enrolled means the server has no account to report on, so the usage
    // block is ABSENT rather than zeroed. Omitting this handler left the fake
    // host answering `{}`, and `SyncUsageBlock` then rendered
    // "NaN KiB of NaN KiB" and "undefined of undefined" (myne-md/myne#843).
    "plugin:sync|sync_account_status": () => null,
    "plugin:sync|sync_list_devices": () => [],
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

/**
 * `CustomizeList` is a toolkit (a row + a drag-reorder hook + its style), not a
 * self-contained surface, so this wrapper is what a story can mount. It is the
 * same shape `BarCustomizeSettings` and the ribbon panel compose.
 */
function CustomizeListDemo() {
  const reorder = useDragReorder(["pin", "search", "settings"], noop);
  const rows: { id: string; icon: "pin" | "search" | "settings"; label: string }[] = [
    { id: "pin", icon: "pin", label: "Pinned" },
    { id: "search", icon: "search", label: "Search" },
    { id: "settings", icon: "settings", label: "Settings" },
  ];
  return (
    <div
      style={CUSTOMIZE_LIST_STYLE}
      // Both real callers (`BarCustomizeSettings`, the ribbon panel) put
      // `role="list"` here; the demo omitted it, so its `role="listitem"` rows
      // had no list parent and axe reported `aria-required-parent`. The story
      // was showing a shape the app never renders (myne-md/myne#845).
      role="list"
      data-testid="stories.customize.list"
    >
      {rows.map((row, i) => (
        <CustomizeRow
          key={row.id}
          id={row.id}
          icon={row.icon}
          label={row.label}
          index={i}
          total={rows.length}
          reorder={reorder}
          trailing={null}
          testId={`stories.customize.${row.id}`}
        />
      ))}
    </div>
  );
}

export const SETTINGS_STORIES: StoryDescriptor[] = [
  {
    id: "settings/aboutpanel/default",
    group: "settings",
    surface: "AboutPanel",
    state: "default",
    description: "About Panel, a default state.",
    tags: ["settings", "aboutpanel", "default"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <AboutPanel />
      </Frame>
    ),
  },
  {
    id: "settings/vaultpanel/default",
    group: "settings",
    surface: "VaultPanel",
    state: "default",
    description: "Vault Panel, a default state.",
    tags: ["settings", "vaultpanel", "default"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <VaultPanel
          vaultId={FIXTURE_VAULT_ID}
          onChangePasswordSuccess={action("onChangePasswordSuccess")}
          onDeleteVaultSuccess={action("onDeleteVaultSuccess")}
        />
      </Frame>
    ),
  },
  {
    id: "settings/accountpanel/default",
    // A `role="switch"` whose value is unresolved: this story does not answer
    // the command that drives the toggle, so `checked` is not a boolean and
    // `aria-checked` is missing. The catalogue is showing a frame the app
    // passes through before its read resolves, never its resting state ,
    // answering the command in the fixture is the fix (myne-md/myne#845).
    // The switch is the browser-clipper install toggle, which sits in the
    // paired-extensions block, which is account-level and therefore here.
    a11y: "todo",
    group: "settings",
    surface: "AccountPanel",
    state: "default",
    description: "Account Panel, a default state.",
    tags: ["settings", "accountpanel", "default"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <AccountPanel vaultId={FIXTURE_VAULT_ID} />
      </Frame>
    ),
  },
  {
    id: "settings/aionboardingsurface/default",
    group: "settings",
    surface: "AiOnboardingSurface",
    state: "default",
    description: "Ai Onboarding Surface, a default state.",
    tags: ["settings", "aionboardingsurface", "default"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <AiOnboardingSurface
          open
          onClose={action("onClose")}
          downloads={false}
          onOpenProviderSetup={action("onOpenProviderSetup")}
        />
      </Frame>
    ),
  },
  {
    id: "settings/aipanel/default",
    group: "settings",
    surface: "AiPanel",
    state: "default",
    description: "Ai Panel, a default state.",
    tags: ["settings", "aipanel", "default"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <AiPanel onShowToast={action("onShowToast")} onDialogOpenChange={action("onDialogOpenChange")} />
      </Frame>
    ),
  },
  {
    id: "settings/aiproviderconsent/default",
    group: "settings",
    surface: "AiProviderConsent",
    state: "default",
    description: "Ai Provider Consent, a default state.",
    tags: ["settings", "aiproviderconsent", "default"],
    render: () => (
      <Frame>
        <AiProviderConsent
          open
          providerLabel="Local runtime"
          onAccept={action("onAccept")}
          onCancel={action("onCancel")}
        />
      </Frame>
    ),
  },
  {
    id: "settings/appearancepanel/default",
    group: "settings",
    surface: "AppearancePanel",
    state: "default",
    description: "Appearance Panel, a default state.",
    tags: ["settings", "appearancepanel", "default"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <AppearancePanel onOpenGraph={action("onOpenGraph")} onDialogOpenChange={action("onDialogOpenChange")} />
      </Frame>
    ),
  },
  {
    id: "settings/archivesettings/default",
    group: "settings",
    surface: "ArchiveSettings",
    state: "default",
    description: "Archive Settings, a default state.",
    tags: ["settings", "archivesettings", "default"],
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
    description: "Attachment Compression Settings, a default state.",
    tags: ["settings", "attachmentcompressionsettings", "default"],
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
    description: "Attachment Ocr Settings, a default state.",
    tags: ["settings", "attachmentocrsettings", "default"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <AttachmentOcrSettings />
      </Frame>
    ),
  },
  {
    id: "settings/automaticbackupblock/default",
    // A real subcomponent edge: `StoragePanel` composes this block, and the
    // import runs parent to child, so the tree nests it rather than listing it
    // beside its parent (myne-md/myne#847).
    parent: "StoragePanel",
    // A `role="switch"` whose value is unresolved: this story does not answer
    // the command that drives the toggle, so `checked` is not a boolean and
    // `aria-checked` is missing. The catalogue is showing a frame the app
    // passes through before its read resolves, never its resting state ,
    // answering the command in the fixture is the fix (myne-md/myne#845).
    a11y: "todo",
    group: "settings",
    surface: "AutomaticBackupBlock",
    state: "default",
    description: "Automatic Backup Block, a default state.",
    tags: ["settings", "automaticbackupblock", "default"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <AutomaticBackupBlock vaultId={FIXTURE_VAULT_ID} onShowToast={action("onShowToast")} />
      </Frame>
    ),
  },
  {
    id: "settings/cliaccesssettings/default",
    group: "settings",
    surface: "CliAccessSettings",
    state: "default",
    description: "Cli Access Settings, a default state.",
    tags: ["settings", "cliaccesssettings", "default"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <CliAccessSettings
          enabled={false}
          excludedFolders={[]}
          rateLimitDisabled={null}
          onSetEnabled={action("onSetEnabled")}
          onSetExcludedFolders={action("onSetExcludedFolders")}
          onSetRateLimitDisabled={action("onSetRateLimitDisabled")}
        />
      </Frame>
    ),
  },
  {
    id: "settings/clipanel/default",
    group: "settings",
    surface: "CliPanel",
    state: "default",
    description:
      "Cli Panel, a default state. The props-driven CLI block inside its panel, which is where the terminal door, the folder exclusions and the rate-limit control live (decisions/ui/0678).",
    tags: ["settings", "clipanel", "cli", "default"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <CliPanel />
      </Frame>
    ),
  },
  {
    id: "settings/connectedextensions/default",
    // A `role="switch"` whose value is unresolved: this story does not answer
    // the command that drives the toggle, so `checked` is not a boolean and
    // `aria-checked` is missing. The catalogue is showing a frame the app
    // passes through before its read resolves, never its resting state ,
    // answering the command in the fixture is the fix (myne-md/myne#845).
    a11y: "todo",
    group: "settings",
    surface: "ConnectedExtensions",
    state: "default",
    description: "Connected Extensions, a default state.",
    tags: ["settings", "connectedextensions", "default"],
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
    description: "Control Block, a default state.",
    tags: ["settings", "controlblock", "default"],
    render: () => (
      <Frame>
        <ControlBlock
          label="Reordered item list"
          helper="A block that needs the full content width, such as a reorderable list."
          control={
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
              <span style={{ color: "var(--fg-1)" }}>Pinned</span>
              <span style={{ color: "var(--fg-1)" }}>Search</span>
              <span style={{ color: "var(--fg-1)" }}>Settings</span>
            </div>
          }
        />
      </Frame>
    ),
  },
  {
    id: "settings/customthemessection/default",
    group: "settings",
    surface: "CustomThemesSection",
    state: "default",
    description: "Custom Themes Section, a default state.",
    tags: ["settings", "customthemessection", "default"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <CustomThemesSection activeCustom={null} onActiveCustomChange={action("onActiveCustomChange")} />
      </Frame>
    ),
  },
  {
    id: "settings/datetimesettings/default",
    group: "settings",
    surface: "DateTimeSettings",
    state: "default",
    description: "Date Time Settings, a default state.",
    tags: ["settings", "datetimesettings", "default"],
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
    description: "Default View Mode Settings, a default state.",
    tags: ["settings", "defaultviewmodesettings", "default"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <DefaultViewModeSettings />
      </Frame>
    ),
  },
  {
    id: "settings/editorpanel/default",
    // A `role="switch"` whose value is unresolved: this story does not answer
    // the command that drives the toggle, so `checked` is not a boolean and
    // `aria-checked` is missing. The catalogue is showing a frame the app
    // passes through before its read resolves, never its resting state ,
    // answering the command in the fixture is the fix (myne-md/myne#845).
    a11y: "todo",
    group: "settings",
    surface: "EditorPanel",
    state: "default",
    description: "Editor Panel, a default state.",
    tags: ["settings", "editorpanel", "default"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <SidebarStateProvider>
          <WorkspaceProvider>
            <EditorPanel onShowToast={action("onShowToast")} />
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
    description: "Files Panel, a default state.",
    tags: ["settings", "filespanel", "default"],
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
    description: "Focus Mode Settings, a default state.",
    tags: ["settings", "focusmodesettings", "default"],
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
    description: "Folder Notes Settings, a default state.",
    tags: ["settings", "foldernotessettings", "default"],
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
    description: "Hotkeys Panel, a default state.",
    tags: ["settings", "hotkeyspanel", "default"],
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
    description: "Language Select, a default state.",
    tags: ["settings", "languageselect", "default"],
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
    description: "Line Numbers Settings, a default state.",
    tags: ["settings", "linenumberssettings", "default"],
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
    description: "Memory Section, a default state.",
    tags: ["settings", "memorysection", "default"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <MemorySection onShowToast={action("onShowToast")} aiEnabled={false} />
      </Frame>
    ),
  },
  {
    id: "settings/migratevaultform/default",
    group: "settings",
    surface: "MigrateVaultForm",
    state: "default",
    description: "Migrate Vault Form, a default state.",
    tags: ["settings", "migratevaultform", "default"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <MigrateVaultForm onMigrated={action("onMigrated")} />
      </Frame>
    ),
  },
  {
    id: "settings/networkpanel/default",
    // A `role="switch"` whose value is unresolved: this story does not answer
    // the command that drives the toggle, so `checked` is not a boolean and
    // `aria-checked` is missing. The catalogue is showing a frame the app
    // passes through before its read resolves, never its resting state ,
    // answering the command in the fixture is the fix (myne-md/myne#845).
    a11y: "todo",
    group: "settings",
    surface: "NetworkPanel",
    state: "default",
    description: "Network Panel, a default state.",
    tags: ["settings", "networkpanel", "default"],
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
    description: "New Note Location Settings, a default state.",
    tags: ["settings", "newnotelocationsettings", "default"],
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
    description: "Periodic Notes Settings, a default state.",
    tags: ["settings", "periodicnotessettings", "default"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <PeriodicNotesSettings />
      </Frame>
    ),
  },
  {
    id: "settings/plainfilesettings/default",
    // A `role="switch"` whose value is unresolved: this story does not answer
    // the command that drives the toggle, so `checked` is not a boolean and
    // `aria-checked` is missing. The catalogue is showing a frame the app
    // passes through before its read resolves, never its resting state ,
    // answering the command in the fixture is the fix (myne-md/myne#845).
    a11y: "todo",
    group: "settings",
    surface: "PlainFileSettings",
    state: "default",
    description: "Plain File Settings, a default state.",
    tags: ["settings", "plainfilesettings", "default"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <PlainFileSettings />
      </Frame>
    ),
  },
  {
    id: "settings/privacypanel/default",
    // A `role="switch"` whose value is unresolved: this story does not answer
    // the command that drives the toggle, so `checked` is not a boolean and
    // `aria-checked` is missing. The catalogue is showing a frame the app
    // passes through before its read resolves, never its resting state ,
    // answering the command in the fixture is the fix (myne-md/myne#845).
    a11y: "todo",
    group: "settings",
    surface: "PrivacyPanel",
    state: "default",
    description: "Privacy Panel, a default state.",
    tags: ["settings", "privacypanel", "default"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <PrivacyPanel onShowToast={action("onShowToast")} />
      </Frame>
    ),
  },
  {
    id: "settings/quickunlocksettings/default",
    group: "settings",
    surface: "QuickUnlockSettings",
    state: "default",
    description: "Quick Unlock Settings, a default state.",
    tags: ["settings", "quickunlocksettings", "default"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <QuickUnlockSettings />
      </Frame>
    ),
  },
  {
    id: "settings/memberpasswordsettings/default",
    group: "settings",
    surface: "MemberPasswordSettings",
    state: "default",
    description: "Member Password Settings, a default state.",
    tags: ["settings", "memberpasswordsettings", "default"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <MemberPasswordSettings />
      </Frame>
    ),
  },
  {
    id: "settings/remindersettings/default",
    group: "settings",
    surface: "ReminderSettings",
    state: "default",
    description: "Reminder Settings, a default state.",
    tags: ["settings", "remindersettings", "default"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <ReminderSettings enabled onEnabledChange={action("onEnabledChange")} />
      </Frame>
    ),
  },
  {
    id: "settings/ribboncustomizesettings/default",
    group: "settings",
    surface: "RibbonCustomizeSettings",
    state: "default",
    description: "Ribbon Customize Settings, a default state.",
    tags: ["settings", "ribboncustomizesettings", "default"],
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
    description: "Setting Row, a default state.",
    tags: ["settings", "settingrow", "default"],
    render: () => (
      <Frame>
        <SettingRow
          label="Show note timestamps"
          helper="Label left, control right, helper below. This is the shape every setting row takes."
          control={
            <Switch
              checked
              onChange={action("onChange")}
              ariaLabel="Show note timestamps"
              testId="stories.settingrow.switch"
            />
          }
        />
      </Frame>
    ),
  },
  {
    id: "settings/settingssection/default",
    group: "settings",
    surface: "SettingsSection",
    state: "default",
    description: "Settings Section, a default state.",
    tags: ["settings", "settingssection", "default"],
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
    description: "Settle Migration Block, a default state.",
    unreachable: {
      what: "the block offering to settle a completed migration",
      why: "it renders only when the backend reports an unsettled legacy snapshot, and the fake host reports none",
    },
    tags: ["settings", "settlemigrationblock", "default"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <SettleMigrationBlock onSettled={action("onSettled")} />
      </Frame>
    ),
  },
  {
    id: "settings/spellsettings/default",
    group: "settings",
    surface: "SpellSettings",
    state: "default",
    description: "Spell Settings, a default state.",
    tags: ["settings", "spellsettings", "default"],
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
    description: "Startup Open Settings, a default state.",
    tags: ["settings", "startupopensettings", "default"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <StartupOpenSettings />
      </Frame>
    ),
  },
  {
    id: "settings/storagepanel/default",
    // A `role="switch"` whose value is unresolved: this story does not answer
    // the command that drives the toggle, so `checked` is not a boolean and
    // `aria-checked` is missing. The catalogue is showing a frame the app
    // passes through before its read resolves, never its resting state ,
    // answering the command in the fixture is the fix (myne-md/myne#845).
    a11y: "todo",
    group: "settings",
    surface: "StoragePanel",
    state: "default",
    description: "Storage Panel, a default state.",
    tags: ["settings", "storagepanel", "default"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <StoragePanel
          vaultId={FIXTURE_VAULT_ID}
          onImportObsidian={action("onImportObsidian")}
          onBackupVault={action("onBackupVault")}
          onRestoreBackup={action("onRestoreBackup")}
          onExportVault={action("onExportVault")}
          onShowToast={action("onShowToast")}
        />
      </Frame>
    ),
  },
  {
    id: "settings/syncpanel/default",
    group: "settings",
    surface: "SyncPanel",
    state: "default",
    description: "Sync Panel, a default state.",
    tags: ["settings", "syncpanel", "default"],
    fixture: SYNC_FIXTURE,
    render: () => (
      <Frame>
        <SidebarStateProvider>
          <SyncPanel onMigrated={action("onMigrated")} onDialogOpenChange={action("onDialogOpenChange")} />
        </SidebarStateProvider>
      </Frame>
    ),
  },
  {
    id: "settings/toolbarcustomizesettings/default",
    group: "settings",
    surface: "ToolbarCustomizeSettings",
    state: "default",
    description: "Toolbar Customize Settings, a default state.",
    tags: ["settings", "toolbarcustomizesettings", "default"],
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
    description: "Transcription Panel, a default state.",
    tags: ["settings", "transcriptionpanel", "default"],
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
    description: "Typography Settings, a default state.",
    tags: ["settings", "typographysettings", "default"],
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
    description: "Views Settings, a default state.",
    tags: ["settings", "viewssettings", "default"],
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
    description: "Vim Mode Settings, a default state.",
    tags: ["settings", "vimmodesettings", "default"],
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
    description: "browser-icons, a default state.",
    tags: ["settings", "browser-icons", "default"],
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
    description: "Settings Search, a default state.",
    tags: ["settings", "settingssearch", "default"],
    render: () => (
      <Frame>
        <SettingsSearch query="" onQueryChange={action("onQueryChange")} />
      </Frame>
    ),
  },
  {
    id: "settings/settingssearchresults/default",
    group: "settings",
    surface: "SettingsSearchResults",
    state: "default",
    description: "Settings Search Results, a default state.",
    tags: ["settings", "settingssearchresults", "default"],
    render: () => (
      <Frame>
        <SettingsSearchResults
          query="theme"
          onSelect={action("onSelect")}
          results={[
            {
              id: "settings.appearance.theme",
              agentWritability: WRITABILITY_NONE,
              panelId: "appearance",
              titleKey: "settings.appearance.themeTitle",
              descriptionKey: "settings.appearance.themeHelper",
            },
          ]}
        />
      </Frame>
    ),
  },
  {
    id: "settings/barcustomizesettings/default",
    group: "settings",
    surface: "BarCustomizeSettings",
    state: "default",
    description: "Bar Customize Settings, a default state.",
    tags: ["settings", "barcustomizesettings", "default"],
    fixture: PREFS_FIXTURE,
    render: () => <BarCustomizeSettings />,
  },
  {
    id: "settings/recoverydrillrow/default",
    group: "settings",
    surface: "RecoveryDrillRow",
    state: "default",
    description: "Recovery Drill Row, a default state.",
    tags: ["settings", "recoverydrillrow", "default"],
    fixture: PREFS_FIXTURE,
    render: () => <RecoveryDrillRow />,
  },
  {
    id: "settings/customizelist/default",
    group: "settings",
    surface: "CustomizeList",
    state: "default",
    description: "Customize List, a default state.",
    tags: ["settings", "customizelist", "default"],
    render: () => <CustomizeListDemo />,
  },
];
