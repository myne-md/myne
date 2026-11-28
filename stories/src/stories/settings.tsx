// Stories for the settings panels (myne-md/myne#832).
//
// One entry per settings surface. See `primitives.tsx` for the descriptor shape.
// Breadth over depth: a single `default` state per surface. Panels read their
// data through the seam, so `PREFS_FIXTURE` supplies a full default `vault.prefs`
// (the named `unlocked` fixture answers `prefs_read` with `{}`, leaving every
// field a panel reads `undefined`); a panel that renders only inside a provider
// gets that provider here.

import { useEffect, useState, type ReactNode } from "react";
import type { Fixture, StoryDescriptor } from "../types";
import { DEFAULT_PREFS, FIXTURE_VAULT_ID } from "../../fixtures";
import { SidebarStateProvider } from "@app/notes/sidebarState";
import { WorkspaceProvider } from "@app/notes/workspaceContext";

import { AboutPanel } from "@app/components/settings/AboutPanel";
import { setActiveSettingsTopic } from "@app/components/settings/SettingsTabs";
import { DiagnosticsPanel } from "@app/components/settings/DiagnosticsPanel";
import { BarCustomizeSettings } from "@app/components/settings/BarCustomizeSettings";
import {
  CUSTOMIZE_LIST_STYLE,
  CustomizeRow,
  useDragReorder,
} from "@app/components/settings/CustomizeList";
import { AccountPanel } from "@app/components/settings/AccountPanel";
import { BrowserExtensionsPanel } from "@app/components/settings/BrowserExtensionsPanel";
import { AiModelCatalogue } from "@app/components/settings/AiModelCatalogue";
import { VaultPanel } from "@app/components/settings/VaultPanel";
import { AiOnboardingSurface } from "@app/components/settings/AiOnboardingSurface";
import { AiPanel } from "@app/components/settings/AiPanel";
import { ModelPathButton } from "@app/components/settings/ModelPathButton";
import { AiProviderConsent } from "@app/components/settings/AiProviderConsent";
import { AppearancePanel } from "@app/components/settings/AppearancePanel";
import { ArchiveSettings } from "@app/components/settings/ArchiveSettings";
import { AttachmentCompressionSettings } from "@app/components/settings/AttachmentCompressionSettings";
import { AttachmentOcrSettings } from "@app/components/settings/AttachmentOcrSettings";
import { AutomaticBackupBlock } from "@app/components/settings/AutomaticBackupBlock";
import { CliAccessSettings } from "@app/components/settings/CliAccessSettings";
import { CliPanel } from "@app/components/settings/CliPanel";
import { ConnectionsPanel } from "@app/components/settings/ConnectionsPanel";
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
import { SeedMemoryWizard } from "@app/components/settings/SeedMemoryWizard";
import { SeedMemoryCard } from "@app/notes/components/SeedMemoryCard";
import { McpSection } from "@app/components/settings/McpSection";
import { ClientMark } from "@app/components/settings/mcp-client-marks";
import { NetworkPanel } from "@app/components/settings/NetworkPanel";
import { NewNoteLocationSettings } from "@app/components/settings/NewNoteLocationSettings";
import { PeriodicNotesSettings } from "@app/components/settings/PeriodicNotesSettings";
import { CalendarSettings } from "@app/components/settings/CalendarSettings";
import { PlainFileSettings } from "@app/components/settings/PlainFileSettings";
import { PrivacyPanel } from "@app/components/settings/PrivacyPanel";
import { QuickUnlockSettings } from "@app/components/settings/QuickUnlockSettings";
import { MemberPasswordSettings } from "@app/components/settings/MemberPasswordSettings";
import { ReminderSettings } from "@app/components/settings/ReminderSettings";
import { RibbonCustomizeSettings } from "@app/components/settings/RibbonCustomizeSettings";
import { SettingRow } from "@app/components/settings/SettingRow";
import { SettingsSection } from "@app/components/settings/SettingsSection";
import {
  SettingsTabs,
  SettingsTopicPanel,
} from "@app/components/settings/SettingsTabs";
import { AI_PANEL_TOPICS } from "@app/components/settings/settingsTopics";
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


/** Renders the Vault panel with its DANGER topic active, which is the only way
 *  that section is mounted: the panel remembers one topic and renders one body. */
function DangerTopicVaultPanel() {
  // Before the panel mounts, so it reads the topic it is being given rather than
  // switching to it after the fact.
  useState(() => {
    setActiveSettingsTopic("vault", "danger");
    return null;
  });
  return (
    <Frame>
      <VaultPanel
        vaultId={FIXTURE_VAULT_ID}
        onChangePasswordSuccess={action("onChangePasswordSuccess")}
        onDeleteVaultSuccess={action("onDeleteVaultSuccess")}
      />
    </Frame>
  );
}

/**
 * One host answer that turns the About row's check into the install
 * (myne-md/myne#1020): the row holds ONE control, and what that control is
 * depends on what the check found.
 *
 * A fixture rather than a prop, because the state is the component's own: it
 * starts idle and the press is what moves it. Pressing it in a story is the
 * honest way to render the offered state, since a prop that seeded it would be
 * a second path into a state only a real check can reach.
 */
const UPDATE_OFFER_FIXTURE: Fixture = {
  description: "one unlocked vault whose update check finds a newer release",
  handlers: {
    ...PREFS_FIXTURE.handlers,
    "plugin:update|update_check": () => ({
      kind: "available",
      version: "0.14.0",
      notes: null,
    }),
  },
};

/** Renders `AboutPanel` and presses its update check once, so the row below is
 *  the state that press produces rather than the idle one. */
function OfferedUpdateAbout() {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (host === null) return;
    // The row's own control, found by the testid it renders whichever state it
    // is in. Guarded: a story whose control moved must render the idle row and
    // fail the catalogue's description check, not throw on mount.
    const button = host.querySelector<HTMLButtonElement>(
      '[data-testid="about.update-check"]',
    );
    button?.click();
  }, [host]);
  return (
    <div ref={setHost}>
      <AboutPanel />
    </div>
  );
}

/** The reviewed vault seed (myne-md/myne#915): AI on, an empty memory and a
 *  small vault outline, so the scope step has real counts to state. */
// The command names below are matched EXACTLY by the fake host
// (`stories/src/host/internals.ts`, `handlers[cmd]`), so `local_inference` with an
// underscore is not a near miss: it misses, `invoke` resolves the benign `[]`,
// and every field the surface reads is `undefined`. That is how this wizard
// rendered raw i18n keys for its count chips, and it is why the plugin id here
// is `local-inference`.
const SEED_FIXTURE: Fixture = {
  description: "AI on, empty memory, a small vault outline",
  handlers: {
    ...PREFS_FIXTURE.handlers,
    "plugin:prefs|prefs_read": () => ({ ...DEFAULT_PREFS, ai_enabled: true }),
    "plugin:memory|memory_list": () => ({ rows: [], cap: 100 }),
    "plugin:memory|personality_read": () => ({ directives: [] }),
    "plugin:local-inference|seed_memory_status": () => ({
      notes: 24,
      folders: 4,
      tags: 7,
      seedEntries: 0,
      seededAt: null,
      provider: "in-process",
      remote: false,
    }),
    // The scope step reads its counts from `seed_memory_payload`, a SECOND
    // command, and a fixture that answers only the status left every chip
    // rendering its raw i18n key (`count: undefined`), which is what the
    // catalogue showed until this was added.
    "plugin:local-inference|seed_memory_generate": () => ({
      candidates: [
        { text: "Projects: Myne, including the roadmap and the release checklist." },
        { text: "Prefers short, decision-first answers." },
        { text: "Folders are organised by area, one folder per active project." },
      ],
      notesRead: 0,
      foldersRead: [],
    }),
    "plugin:memory|memory_seed_apply": () => ({ ids: ["a", "b", "c"], replaced: 0, liveCount: 3 }),
    "plugin:local-inference|seed_memory_payload": () => ({
      notes: 24,
      folders: 4,
      tags: 7,
      excludedNotes: 1,
      titlesOmitted: 0,
      chars: 412,
      payload:
        "VAULT OUTLINE\nLive notes: 24\nFolders: 4\nNotes omitted because their folder is excluded from AI: 1\nTags: work, health\n\n- Projects/ (6 notes)\n  - Roadmap\n  - Release checklist\n- Notes/ (18 notes)\n  - Weekly review\n",
    }),
  },
};

/** The same vault after a reviewed seed: three seed rows and one user row, so
 *  the `From your vault` group and its Remove all are visible. */
const SEEDED_FIXTURE: Fixture = {
  description: "AI on, a seeded memory group and one user row",
  handlers: {
    ...SEED_FIXTURE.handlers,
    "plugin:memory|memory_list": () => ({
      cap: 100,
      rows: [
        { id: "seed1", created_at: 1_700_000_000_000, updated_at: 1_700_000_100_000, version: 1, quarantined: false, origin: "seed" },
        { id: "seed2", created_at: 1_700_000_000_000, updated_at: 1_700_000_100_001, version: 1, quarantined: false, origin: "seed" },
        { id: "seed3", created_at: 1_700_000_000_000, updated_at: 1_700_000_100_002, version: 1, quarantined: false, origin: "seed" },
        { id: "user1", created_at: 1_700_000_200_000, updated_at: 1_700_000_200_000, version: 1, quarantined: false },
      ],
    }),
    "plugin:memory|memory_read": (args: Record<string, unknown>) => {
      const id = String(args.memoryIdHex ?? "");
      if (id === "user1") return "A fact the user wrote herself.";
      return "An entry distilled from the vault.";
    },
    "plugin:local-inference|seed_memory_status": () => ({
      notes: 24,
      folders: 4,
      tags: 7,
      seedEntries: 3,
      seededAt: 1_700_000_000_000,
      provider: "in-process",
      remote: false,
    }),
  },
};

/** The catalogue with one artefact installed and one not, which is the state it
 *  exists for: a list that answers "is this installed" and "what else can I get"
 *  in one place. `PREFS_FIXTURE` first, because a hand-rolled partial answers
 *  every other pref as `undefined` and the surface throws where the real host
 *  would not. */
const CATALOGUE_FIXTURE: Fixture = {
  description: "the model catalogue, one artefact installed",
  handlers: {
    ...PREFS_FIXTURE.handlers,
    "plugin:local-inference|get_model_path": (args: Record<string, unknown>) =>
      args.role === "tag"
        ? "/Users/you/Library/Application Support/md.myne.desktop/models/tag/model.gguf"
        : null,
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

/** Same vault, with two approved external MCP connections (myne-md/myne#923). */
const MCP_FIXTURE: Fixture = {
  description: "one unlocked vault with two approved external MCP connections",
  handlers: {
    ...PREFS_FIXTURE.handlers,
    "plugin:mcp|mcp_external_access": () => ({
      connections: [
        {
          name: "claude-desktop",
          legacy: false,
          legacyFolders: [],
          excludedFolders: ["Private/"],
          staleExcludedFolders: [],
          writeFolders: ["Projects/"],
          approvedAt: 1_761_000_000,
          lastUsedAt: 1_761_000_600,
          noteCount: 412,
          folderCount: 4,
        },
        {
          name: "lm-studio",
          legacy: false,
          legacyFolders: [],
          excludedFolders: ["Archive/", "Old/"],
          staleExcludedFolders: ["Old/"],
          writeFolders: [],
          approvedAt: 1_759_000_000,
          lastUsedAt: null,
          noteCount: 7,
          folderCount: 4,
        },
        {
          name: "editor-plugin",
          legacy: true,
          legacyFolders: ["Projects/"],
          excludedFolders: [],
          staleExcludedFolders: [],
          writeFolders: [],
          approvedAt: 1_758_000_000,
          lastUsedAt: null,
          noteCount: 0,
          folderCount: 0,
        },
      ],
      folders: ["", "Archive/", "Projects/", "Projects/Deep/", "Work/"],
      noteCount: 512,
      // One write the host refused and kept: the card above the connection list
      // is the state this story exists to show, because it is the one thing on
      // this surface that is waiting for the person.
      writeRequests: [
        {
          connection: "claude-desktop",
          folder: "inbox/",
          requestedAt: 1_761_000_900,
          summary: "Shopping list",
          verb: "note_create",
        },
      ],
    }),
    "plugin:mcp|mcp_grant_preview": () => ({
      noteCount: 512,
      folderCount: 4,
      excludedCount: 1,
      excludedFolders: ["Archive/"],
      // What the write picker offers: the readable set under these exclusions, so
      // `Archive/` is absent and nothing the writer would refuse is selectable.
      folders: ["", "Projects/", "Projects/Deep/", "Work/"],
    }),
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
    description:
      "Settings → About: version and update channel (Stable or Beta), a link to the threat model, the licence, and the Developer mode toggle that reveals the developer-group panels. Look for the single channel row, which names the channel this build updates from rather than a hardcoded \"Stable\".",
    tags: ["settings", "about", "version", "channel", "threat-model", "license", "developer-mode"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <AboutPanel />
      </Frame>
    ),
  },
  {
    id: "settings/aboutpanel/update-offered",
    group: "settings",
    surface: "AboutPanel",
    state: "update-offered",
    description:
      "The same row after its check finds a release: the button that said \"Check for updates\" now says \"Restart to update\" and is the install, with the offered version in the status line beside it. Look for there being ONE control in the row rather than a new second button, and for the row's height not moving between the two states.",
    tags: ["settings", "about", "update", "install", "restart", "one-control"],
    fixture: UPDATE_OFFER_FIXTURE,
    render: () => (
      <Frame>
        <OfferedUpdateAbout />
      </Frame>
    ),
  },
  {
    id: "settings/diagnosticspanel/default",
    group: "settings",
    surface: "DiagnosticsPanel",
    state: "default",
    description:
      "Settings → Diagnostics: the report block that is the exact string Copy puts on the clipboard, the opt-in plaintext log switch, the crash record when one exists, and the two ways the log leaves the device (open its folder, or save a report). Look for the preview being the copy itself rather than a summary of it.",
    tags: ["settings", "diagnostics", "log", "crash", "report", "support"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <DiagnosticsPanel />
      </Frame>
    ),
  },
  {
    id: "settings/vaultpanel/default",
    group: "settings",
    surface: "VaultPanel",
    state: "default",
    description:
      "Settings → Vault: everything that acts on the sealed container itself, its label and icon, the password that opens it, and its destruction (delete the vault, or erase just this browser's copy). Look for the danger zone at the foot of the panel.",
    tags: ["settings", "vault", "label", "icon", "change-password", "delete-vault", "danger-zone"],
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
    id: "settings/vaultpanel/danger",
    group: "settings",
    surface: "VaultPanel",
    state: "danger",
    description:
      "The Vault panel's danger topic: what destroying this vault means, the typed `DELETE` field and the button it gates, all in one step. Look for there being no reveal press in front of the field, and for the disclosure being stated once rather than twice.",
    tags: ["settings", "vault", "danger-zone", "delete-vault", "typed-confirm"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <DangerTopicVaultPanel />
    ),
  },
  {
    id: "settings/accountpanel/default",
    group: "settings",
    surface: "AccountPanel",
    state: "default",
    description:
      "Settings → Account: the person account number and the device-local grouping of vaults. It is deliberately the account level, not the vault's own label, which lives in the Vault panel; the browser clipper's pairing surface moved out of here into its own panel (myne-md/myne#960).",
    tags: ["settings", "account", "device-local", "vault-group", "account-number"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <AccountPanel vaultId={FIXTURE_VAULT_ID} />
      </Frame>
    ),
  },
  {
    id: "settings/browserextensionspanel/default",
    // A `role="switch"` whose value is unresolved: this story does not answer
    // the command that drives the install toggle, so `checked` is not a boolean
    // and `aria-checked` is missing. The catalogue is showing a frame the app
    // passes through before its read resolves, never its resting state;
    // answering the command in the fixture is the fix (myne-md/myne#845).
    a11y: "todo",
    group: "settings",
    surface: "BrowserExtensionsPanel",
    state: "default",
    description:
      "Settings → Browser extensions: its own rail panel since myne-md/myne#960, holding the clipper install toggle and the browsers paired with this account. The rail omits the whole entry on a client that cannot host a native-messaging endpoint, so this panel never appears on web.",
    tags: ["settings", "browser-extensions", "clipper", "pairing", "revoke", "panel"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <BrowserExtensionsPanel />
      </Frame>
    ),
  },
  {
    id: "settings/aionboardingsurface/default",
    group: "settings",
    surface: "AiOnboardingSurface",
    state: "default",
    description:
      "The first-run AI onboarding surface, shown once per device after the first unlock and fully skippable: what runs on-device, what would leave it, and the doors to enable or defer. The app works with AI off, so look for the decline path to be as plain as the download one.",
    tags: ["settings", "ai", "onboarding", "first-run", "download", "opt-in", "privacy"],
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
    id: "settings/aimodelcatalogue/default",
    group: "settings",
    surface: "AiModelCatalogue",
    state: "default",
    description:
      "The model catalogue: every artefact Myne's own origin can serve, whether or not it is installed, each as a row of the same four columns (model, size, state, action). Inline in the AI panel's Models topic, next to the per-role assignment rows, which is what stops fetching a model and assigning one from being two blocks in a row.",
    tags: ["settings", "ai", "models", "catalogue", "download", "table"],
    fixture: CATALOGUE_FIXTURE,
    render: () => (
      <Frame>
        <AiModelCatalogue
          modelPaths={{
            generation: null,
            transcription: null,
            tag: "/Users/you/Library/Application Support/md.myne.desktop/models/tag/model.gguf",
          }}
          aiEnabled
          onChanged={action("onChanged")}
          onShowToast={action("onShowToast")}
        />
      </Frame>
    ),
  },
  {
    id: "settings/modelpathbutton/default",
    group: "settings",
    surface: "ModelPathButton",
    state: "default",
    description:
      "The location control every model row carries: a folder button whose accessible name is the FILE, which is the half a user recognises, and whose press opens the whole path with the one action that path enables. A full path printed inline ran past the panel's edge, which is why this is a button at all.",
    tags: ["settings", "ai", "models", "path", "location"],
    render: () => (
      <Frame>
        <ModelPathButton
          path="/Users/you/Library/Application Support/md.myne.desktop/models/tag/model.gguf"
          label="Tag model: automatic tag suggestions"
          revealLabel="Show in folder"
          testId="story.model-path"
          panelTestId="story.model-path-panel"
        />
      </Frame>
    ),
  },
  {
    id: "settings/aipanel/default",
    group: "settings",
    surface: "AiPanel",
    state: "default",
    description:
      "Settings → AI, organised as topics rather than one scroll: Answering (the master switch, the trust card, the runtime address, the remote provider with its key and model), Models (the per-role file rows and the catalogue), Tagging, Limits and Advanced. Look for the master switch gating the rest.",
    tags: ["settings", "ai", "provider", "models", "topics", "opt-in", "endpoint"],
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
    description:
      "The one-time per-provider consent dialog. The accept action is rendered only by this component, so there is no route to acceptance that skips this text; what leaves the device and to whom is the whole of it, never a summary with the detail a click away.",
    tags: ["settings", "ai", "consent", "remote-provider", "disclosure", "egress", "privacy"],
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
    description:
      "Settings → Appearance: the Light/Dark/System theme control and the custom-theme picker, and nothing beyond the purely visual; note-authoring behaviour lives in the Editor panel. Look for the custom-theme door to be a tracked disabled control with a real label, not a \"coming soon\" pill.",
    tags: ["settings", "appearance", "theme", "dark-mode", "custom-theme", "visual"],
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
    description:
      "Settings → Editor: the note-archive switch. Turning archiving OFF first unarchives every archived note so none is left unreachable, and only then persists the flag; a partial failure writes nothing. Look for a two-step disable rather than a bare toggle.",
    tags: ["settings", "editor", "archive", "toggle", "unarchive", "data-safety"],
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
    id: "settings/calendarsettings/default",
    group: "settings",
    surface: "CalendarSettings",
    state: "default",
    description:
      "Settings -> Editor -> Calendar: the all-day reminder anchor (chosen from the 48 half-hours, never typed) and the per-calendar colour map. Pick a colour and look for it landing on the swatch immediately, and for the empty state naming what fills the list rather than showing a bare row.",
    tags: ["settings", "editor", "calendar", "colours", "reminders", "empty-state"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <CalendarSettings />
      </Frame>
    ),
  },
  {
    id: "settings/calendarsettings/with-colours",
    group: "settings",
    surface: "CalendarSettings",
    state: "with-colours",
    description:
      "The same block once two calendars carry colours: one row per name with the shared eight-token swatch picker and a remove control, and the add row underneath. Each swatch paints through var(--group-*), so this is the specimen that shows a theme switch repainting the calendar's colours with everything else.",
    tags: ["settings", "editor", "calendar", "colours", "tokens", "theme"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <CalendarSettings />
      </Frame>
    ),
  },
  {
    id: "settings/attachmentcompressionsettings/default",
    group: "settings",
    surface: "AttachmentCompressionSettings",
    state: "default",
    description:
      "Settings → Files: the opt-out for downscaling and re-encoding images as they are added to a note. The helper states the transform is irreversible because the original bytes are not kept, so look for that warning sitting beside the switch.",
    tags: ["settings", "files", "attachments", "image-compression", "opt-out", "irreversible"],
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
    description:
      "Settings → Files: the OCR opt-out. OCR is on by default and is search correctness rather than an AI feature, so this row exists for the heavy vault where the background extraction shows up as sustained CPU and battery. Look for the switch gating both the worker and the eager path.",
    tags: ["settings", "files", "attachments", "ocr", "search", "opt-out", "battery"],
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
    description:
      "Settings → Storage's \"Automatic backups\" block: the enable toggle, cadence, target folder, retention count and a last-run status line, additive to the manual Back up control. Config is device-local and the scheduler that runs it lives in the editor. The rail nests this under StoragePanel.",
    tags: ["settings", "storage", "backup", "schedule", "cadence", "retention", "device-local"],
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
    description:
      "The terminal-access block: the default-off toggle that opens the CLI door, the excluded-folder list, the rate-limit removal control and a last-access line. It is a block; CliPanel is the panel that hosts it.",
    tags: ["settings", "cli", "terminal-access", "toggle", "folder-exclusions", "rate-limit"],
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
    id: "settings/mcpsection/default",
    group: "settings",
    surface: "McpSection",
    state: "default",
    description:
      "The external-access tab under Settings → AI, its own topic since the rework: the master switch for the myne-mcp door, one queued write a connection attempted outside its write scope (a proposal, with Accept widening exactly that one grant by exactly that one folder), three approved connections with what each may read, what it may write and when it was last used, and per-connection Revoke plus the setup snippet a client's config pastes. A connection's name is a label rather than a credential, and the section states plainly what Myne does not control about what a connected tool does with what it reads.",
    tags: [
      "settings",
      "ai",
      "mcp",
      "external-access",
      "connections",
      "revoke",
      "developer-mode",
    ],
    fixture: MCP_FIXTURE,
    render: () => (
      <Frame>
        <McpSection
          enabled
          onSetEnabled={action("onSetEnabled")}
          onShowToast={action("onShowToast")}
        />
      </Frame>
    ),
  },
  {
    id: "settings/mcpsection/disabled",
    group: "settings",
    surface: "McpSection",
    state: "disabled",
    description:
      "The same tab with the master switch OFF: the switch, the line saying what it does, and no connection rows, no request cards and no second sentence restating that nothing can reach the vault.",
    tags: ["settings", "ai", "mcp", "external-access", "off", "developer-mode"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <McpSection
          enabled={false}
          onSetEnabled={action("onSetEnabled")}
          onShowToast={action("onShowToast")}
        />
      </Frame>
    ),
  },
  {
    id: "settings/mcpclientmarks/glyphs",
    group: "settings",
    surface: "mcp-client-marks",
    state: "glyphs",
    description:
      "The monograms on the approval flow's client cards, drawn from each client's own name. An earlier version inlined the vendors' artwork and their brand colours; that is somebody else's protected work regardless of the disclaimer beside it, so the bundle now carries no third-party mark and the names are the reference (`myne-md/myne#1052`, `myne-md/myne#183`). Two letters at most, uppercase, `aria-hidden` because the card's label is the accessible name, and every card the same size so the grid does not jump.",
    tags: ["settings", "ai", "mcp", "external-access", "icons", "monochrome"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <ClientMark name="Claude Desktop" />
          <ClientMark name="VS Code" />
          <ClientMark name="Cursor" />
          <ClientMark name="OpenCode" />
          <ClientMark name="Hermes" />
          <ClientMark name="Some MCP client" />
        </div>
      </Frame>
    ),
  },
  {
    id: "settings/connectionspanel/default",
    group: "settings",
    surface: "ConnectionsPanel",
    state: "default",
    description:
      "Settings → Connections: the CLI, the browser clipper and an external MCP client in one panel, because they are three doors into the same vault. Each section is absent rather than disabled where its capability is missing, and the panel itself leaves the rail when a client has none of the three.",
    tags: ["settings", "connections", "cli", "clipper", "mcp", "panel"],
    // The clipper section inherits the gap `settings/connectedextensions/default`
    // records: this fixture does not answer the command that drives its install
    // switch, so `aria-checked` is unresolved here too. Same cause, same record.
    a11y: "todo",
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <ConnectionsPanel />
      </Frame>
    ),
  },
  {
    id: "settings/clipanel/default",
    group: "settings",
    surface: "CliPanel",
    state: "default",
    description:
      "Settings → CLI, the developer-group panel that hosts the terminal-access block along with the folder exclusions and the rate-limit control. Look for the whole panel being omitted unless Developer mode is on and the platform carries the CLI capability.",
    tags: ["settings", "cli", "developer", "terminal", "panel", "capability"],
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
    description:
      "The connected-extensions list, composed by the Browser extensions panel: the live browser extensions paired with this vault, each with a per-row Revoke. Revoke is durable on the backend (the token is dropped from the encrypted prefs), and a one-line hint says a revoked extension has to pair again.",
    tags: ["settings", "browser-extensions", "pairing", "revoke", "clipper"],
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
    description:
      "The stacked settings shape: label, then a full-content-width control, then the helper. It is the documented exception to SettingRow, for a control that genuinely needs the whole column, such as a reorderable list or a multi-line textarea.",
    tags: ["settings", "controlblock", "stacked", "layout", "full-width", "pattern"],
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
    description:
      "Settings → Appearance's custom-themes subsection: the user's themes from the encrypted themes store, each with a palette chiplet and Apply / Export / Delete, plus an Import action. Import validates through the shared value-shape allowlist before sealing, so there are no invalid rows.",
    tags: ["settings", "appearance", "custom-theme", "palette", "import", "export", "delete"],
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
    description:
      "Settings → Editor → Text & display: how dates and times are printed, over three closed vocabularies (date format, time format, timezone). Closed on purpose, since a free-text pattern is a mini-language to validate, localise and round-trip for a setting most people set once.",
    tags: ["settings", "editor", "date-format", "time-format", "timezone", "display"],
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
    description:
      "Settings → Editor: the default view mode, a three-way picker over Live preview, Reading and Source. Unset means the host default (live), and only an explicit choice is persisted.",
    tags: ["settings", "editor", "view-mode", "live-preview", "reading", "source"],
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
    description:
      "Settings → Editor: note-authoring behaviour rather than visual appearance, spell-check with its language picker and the periodic-notes configuration, now behind an in-panel topic strip. Look for this panel to hold no theme control, which lives in Appearance.",
    tags: ["settings", "editor", "spell-check", "daily-notes", "topics", "writing"],
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
    description:
      "Settings → Files: a thin composition shell grouping the file-oriented preferences that child blocks own, which note opens on launch and where new notes land. Mirrors a \"Files & Links\" grouping rather than the editor's own behaviour.",
    tags: ["settings", "files", "startup", "new-note", "grouping", "composition"],
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
    description:
      "Settings → Editor: the two focus-mode behaviours, typewriter scroll and dimming inactive lines, both default-on. These configure behaviour only, since entering focus mode itself is an ephemeral shortcut; each setter bumps the prefs nonce so an open editor reconfigures live.",
    tags: ["settings", "editor", "focus-mode", "typewriter", "dim-lines", "distraction-free"],
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
    description:
      "Settings → Files: the folder-notes switch, which ships off. With it off the folder-index entry points are hidden and a `folder_index: true` flag is not honoured for sidebar or link presentation, while the switch never rewrites frontmatter.",
    tags: ["settings", "files", "folder-notes", "toggle", "sidebar", "presentation-gate"],
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
    description:
      "Settings → Hotkeys: every bindable command grouped, each showing its effective binding as glyphs, with fuzzy search. Rebinding captures a validated chord and the write goes through the prefs binding setter so the live key engine re-reads. CodeMirror and literal-Ctrl rows are fixed.",
    tags: ["settings", "hotkeys", "keybindings", "rebind", "shortcuts", "chords"],
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
    description:
      "Settings → Appearance: the app display-language selector. Unlike the other Appearance controls it does not persist to `vault.prefs`, because language is device-local and must work before unlock; it routes through the i18n setter. Look for the endonym list.",
    tags: ["settings", "appearance", "language", "locale", "device-local", "i18n"],
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
    description:
      "Settings → Editor: a single switch for the editor's line-number gutter, default off. The setter bumps the prefs nonce so an open editor re-reads and reconfigures its gutter live, with no remount.",
    tags: ["settings", "editor", "line-numbers", "gutter", "toggle", "opt-in"],
    fixture: PREFS_FIXTURE,
    render: () => (
      <Frame>
        <LineNumbersSettings />
      </Frame>
    ),
  },
  {
    id: "settings/seedmemorywizard/scope",
    group: "settings",
    surface: "SeedMemoryWizard",
    state: "scope",
    description:
      "The first step of Teach Myne your vault: provider, note/folder/tag counts, the estimated payload size, the excluded-folder count and the real payload behind a toggle. A local provider needs no consent; a remote one cannot continue until the box is ticked.",
    tags: ["settings", "ai", "memory", "seed", "review", "consent", "wizard"],
    fixture: SEED_FIXTURE,
    render: () => (
      <Frame>
        <SeedMemoryWizard open onClose={action("onClose")} />
      </Frame>
    ),
  },
  {
    id: "settings/seedmemorycard/default",
    group: "settings",
    surface: "SeedMemoryCard",
    state: "default",
    description:
      "The once-only offer in the chat zero state: AI is on, memory is empty and the vault has enough notes to distil. Two actions, one of which dismisses the offer permanently on this device.",
    tags: ["settings", "ai", "memory", "seed", "card", "zero-state", "offer"],
    fixture: SEED_FIXTURE,
    render: () => {
      // The card's own device-local gate, set before it mounts. A story that
      // skipped this would render nothing and assert nothing.
      try {
        localStorage.setItem("myne.aiOnboardingSeen", "1");
        localStorage.removeItem("myne.seedMemorySeen");
      } catch {
        // Storage unavailable: the story still renders the zero state without
        // the offer, which is the honest degraded shape.
      }
      return (
        <Frame>
          <SeedMemoryCard />
        </Frame>
      );
    },
  },
  {
    id: "settings/memorysection/default",
    group: "settings",
    surface: "MemorySection",
    state: "default",
    description:
      "The agent-memory and personality management surface: the complete list, edit, delete, clear-all-with-confirm and the personality editor, sharing one store and one set of commands with the chat header's discoverable popover. Rendered here with `aiEnabled={false}`, so look for the disabled or empty treatment.",
    tags: ["settings", "ai", "agent", "memory", "personality", "management"],
    fixture: SEED_FIXTURE,
    render: () => (
      <Frame>
        <MemorySection onShowToast={action("onShowToast")} aiEnabled={false} />
      </Frame>
    ),
  },
  {
    id: "settings/memorysection/seeded",
    group: "settings",
    surface: "MemorySection",
    state: "seeded",
    description:
      "The same panel after a reviewed seed: the seed entries in their own From your vault group with the seed date and Remove all, the ordinary rows above them, and the user row untouched.",
    tags: ["settings", "ai", "memory", "seed", "group", "remove-all"],
    fixture: SEEDED_FIXTURE,
    render: () => (
      <Frame>
        <MemorySection onShowToast={action("onShowToast")} aiEnabled />
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
    description:
      "Settings → Developer → Network: the device-local Tor-routing toggle. Turning it on makes sync depend on a Tor client Myne bundles but does not operate and on a volunteer relay network, which is why it sits in the developer group.",
    tags: ["settings", "developer", "network", "tor", "routing", "privacy", "sync"],
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
    description:
      "Settings → Files: where new notes are created, a mode select (vault root / same folder as current note / a specific folder) and, when specific, the shared searchable folder picker rather than a typed path. Designating a folder registers it so it survives empty.",
    tags: ["settings", "files", "new-note", "location", "folder-picker", "default"],
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
    description:
      "Settings → Editor: periodic notes, one block with a period switcher at the top (Daily / Weekly / Monthly) and only the selected period's three controls, folder, title format and template. Writes are disk-first, and designating a folder registers it.",
    tags: ["settings", "editor", "periodic-notes", "daily-notes", "weekly", "monthly", "template"],
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
    description:
      "Settings → Editor: the switch for the plain-file editor. It is a device-local setting rather than a vault pref, because the surface it gates must work with the vault locked or with no vault at all. On by default and deliberately not behind Developer mode.",
    tags: ["settings", "editor", "plain-file", "device-local", "lock-screen", "no-vault"],
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
    description:
      "Settings → Privacy: the screen-capture-protection toggle and the auto-lock timeout selector. The timeout offers enabled durations only, with no Off, because auto-lock is an always-on guarantee rather than an optional convenience.",
    tags: ["settings", "privacy", "auto-lock", "screen-capture", "timeout", "security"],
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
    description:
      "Settings → Privacy → Quick unlock: the opt-in PIN or Touch ID fast re-entry layered over the already-encrypted store. It is a convenience gate that never weakens the zero-knowledge root, and the master password stays the primary credential.",
    tags: ["settings", "privacy", "quick-unlock", "pin", "touch-id", "auto-lock", "convenience"],
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
    description:
      "Settings → Privacy → Shared vault unlock: for a member vault, set a device-local fast credential (a password, PIN or biometric) so the vault re-unlocks without retyping the recovery phrase, which stays the portable fallback. Rendered only while a member vault is active.",
    tags: ["settings", "privacy", "shared-vault", "member", "unlock", "biometric", "recovery-phrase"],
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
    description:
      "The reminder settings: a two-row block. This row is the per-device switch and its honesty sentence; the horizon row beside it states how far ahead reminders are registered and where that horizon currently reaches.",
    tags: ["settings", "reminders", "notifications", "switch", "horizon", "device-local"],
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
    description:
      "Settings → Appearance: left-ribbon customization. The heading's Add opens a searchable dropdown of eligible commands, and the list below shows only pinned commands, drag-reorderable, each with an × to remove. Look for pinning being the roster rather than a set of checkboxes.",
    tags: ["settings", "appearance", "ribbon", "customize", "pin", "drag-reorder", "commands"],
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
    description:
      "The canonical settings control layout: label on the left, control on the right, helper text below the label, error below that. This is the default shape for every setting; ControlBlock is the documented exception for a control needing the whole column.",
    tags: ["settings", "settingrow", "layout", "label", "control", "pattern"],
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
    // The long-copy affordance (myne-md/myne#885), shown where it actually
    // lives: on a row whose helper is one sentence and whose explanation is
    // three paragraphs. It is LIVE here, so the copy is one hover or one Tab
    // away rather than depicted; that is also what makes this story the place a
    // reviewer reads the popover's measure and its placement against the row it
    // belongs to.
    id: "settings/helperdisclosure/default",
    group: "settings",
    surface: "HelperDisclosure",
    state: "default",
    parent: "SettingRow",
    description:
      "Helper Disclosure: the question mark beside a setting's title that holds the copy the row does not need to show, opened on hover, on focus or on press.",
    tags: ["settings", "helperdisclosure", "helper", "disclosure", "tooltip", "default"],
    docs: {
      whenNotToUse:
        "When the row's helper is already one sentence. A question mark that opens one line is an extra click to read the same thing, and the row loses the only cue that there is more to say.",
      content:
        "Sentence case, and the copy behind it is the row's own paragraph moved rather than rewritten. The trigger's own accessible name is fixed ('More about this setting') because the copy it opens is per row and a name derived from the first words of a paragraph reads badly as a control.",
      related: ["SettingRow", "Tooltip"],
    },
    render: () => (
      <Frame>
        <SettingRow
          label="Hide vault names on the lock screen"
          // The destructive sentence stays on the row; the placeholder
          // explanation, the residue caveat and the keychain context move
          // behind the question mark. The story mirrors the shipped row rather
          // than inventing a tidier split, so the arrangement under review is
          // the one that ships.
          helper="Turning it on destroys the keys that make the names stored here readable."
          explanation={[
            "On a device with a usable keychain the vault picker shows a vault's name once this device has unlocked it. With this on every vault shows a placeholder such as Vault 2 instead, and that number stays with the vault however the list reorders.",
            "Turning it on destroys the keys that make the names stored here readable, so those names cannot be recovered on this device, and no further name is written while it stays on.",
            "It cannot reach a copy taken earlier: a full-system backup, a disk image, or any other system-level copy of this disk made while names were showing carries both the stored names and their keys.",
          ]}
          testId="stories.helperdisclosure.row"
          control={(helperId, explanationId) => (
            <Switch
              checked={false}
              onChange={action("onChange")}
              ariaLabel="Hide vault names on the lock screen"
              ariaDescribedBy={
                explanationId === undefined ? helperId : `${helperId} ${explanationId}`
              }
              testId="stories.helperdisclosure.switch"
            />
          )}
        />
      </Frame>
    ),
  },
  {
    // The one section treatment in the settings tree (myne-md/myne#885), shown
    // the way a panel composes it: a titled group whose rule carries the accent,
    // stacked twice so the boundary between one concern and the next is the
    // thing on the stage rather than a single group in isolation.
    id: "settings/settingssection/default",
    group: "settings",
    surface: "SettingsSection",
    state: "default",
    description:
      "Settings Section: the titled group whose accent rule separates one concern from the next in every settings panel.",
    tags: ["settings", "settingssection", "section", "divider", "default"],
    render: () => (
      <Frame>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-6)",
            maxWidth: 520,
          }}
        >
          <SettingsSection title="Text & display">
            <SettingRow
              label="Text size"
              helper="Base size of the editor text. Headings scale with it."
              control={
                <Switch
                  checked
                  onChange={action("onChange")}
                  ariaLabel="Text size"
                  testId="stories.settingssection.size"
                />
              }
            />
          </SettingsSection>
          <SettingsSection title="Editing">
            <SettingRow
              label="Vim keyboard mode"
              helper="Use vim keys in the editor."
              control={
                <Switch
                  checked={false}
                  onChange={action("onChange")}
                  ariaLabel="Vim keyboard mode"
                  testId="stories.settingssection.vim"
                />
              }
            />
          </SettingsSection>
        </div>
      </Frame>
    ),
  },
  {
    // The in-panel topic strip (myne-md/myne#885). Composed the way the modal
    // and a panel compose it - the strip above, the active topic's body below -
    // because the strip alone would render `aria-controls` at nothing and the
    // specimen would not be the surface a user meets.
    id: "settings/settingstabs/default",
    group: "settings",
    surface: "SettingsTabs",
    state: "default",
    description:
      "Settings Tabs: the in-panel topic strip and the active topic's own body beneath it.",
    tags: ["settings", "settingstabs", "topics", "tabs", "default"],
    render: () => (
      <Frame>
        <div
          style={{
            maxWidth: 640,
            background: "var(--bg-2)",
            border: "1px solid var(--line-1)",
            borderRadius: "var(--radius-2)",
            overflow: "hidden",
          }}
        >
          <SettingsTabs panelId="ai" topics={AI_PANEL_TOPICS} />
          <div style={{ padding: "var(--space-5)" }}>
            <SettingsTopicPanel panelId="ai" topicId="answering">
              <span>The Answering topic&apos;s own controls render here.</span>
            </SettingsTopicPanel>
            <SettingsTopicPanel panelId="ai" topicId="models">
              <span>The Models topic&apos;s own controls render here.</span>
            </SettingsTopicPanel>
            <SettingsTopicPanel panelId="ai" topicId="limits">
              <span>The Limits topic&apos;s own controls render here.</span>
            </SettingsTopicPanel>
            <SettingsTopicPanel panelId="ai" topicId="advanced">
              <span>The Advanced topic&apos;s own controls render here.</span>
            </SettingsTopicPanel>
          </div>
        </div>
      </Frame>
    ),
  },
  {
    id: "settings/spellsettings/default",
    group: "settings",
    surface: "SpellSettings",
    state: "default",
    description:
      "Settings → Editor's spell-check configuration: an enable toggle and a multi-select picker over the bundled-language manifest, which is the single source rather than a hard-coded list. Look for the picker offering only languages Myne actually ships dictionaries for.",
    tags: ["settings", "editor", "spell-check", "dictionary", "languages", "writing"],
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
    description:
      "Settings → Files: which file opens on startup, a mode select (last opened / new note / a specific note) and, when specific, a searchable picker over the vault's live notes with trashed, archived and template records excluded.",
    tags: ["settings", "files", "startup", "open-file", "note-picker", "preference"],
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
    description:
      "Settings → Storage: the manual Backup and Restore actions, with the automatic-backup block nested under it in the rail. The vault's on-disk location used to be printed here; it is gone (myne-md/myne#960), because a path a user cannot act on inside the app answers a question only the filesystem can, and two of the three clients have no path to show.",
    tags: ["settings", "storage", "backup", "restore", "manual"],
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
    description:
      "Settings → Sync, the in-app hub for the sync engine: runtime status and manual sync, this-account device management (add, approve, remove), the cold-start index-building state and the keep-both Conflicts surface. This fixture is the not-enrolled state, so look for the enrolment door rather than device rows.",
    tags: ["settings", "sync", "enrolment", "devices", "conflicts", "status", "manual-sync"],
    fixture: SYNC_FIXTURE,
    render: () => (
      <Frame>
        <SidebarStateProvider>
          <SyncPanel onDialogOpenChange={action("onDialogOpenChange")} />
        </SidebarStateProvider>
      </Frame>
    ),
  },
  {
    id: "settings/toolbarcustomizesettings/default",
    group: "settings",
    surface: "ToolbarCustomizeSettings",
    state: "default",
    description:
      "Settings → Editor: floating-toolbar customization, a reorder and show/hide list over the frozen toolbar command vocabulary with no custom buttons. Config surface and persistence only; the resolved order is what the editor's toolbar plugin renders.",
    tags: ["settings", "editor", "toolbar", "customize", "reorder", "show-hide", "commands"],
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
    description:
      "Settings → Transcription: the speech-to-text switch. Speech-to-text ships a bundled on-device model and does one bounded thing one file at a time, which is why it is its own panel rather than a row. The default is on, so this switch is an opt-out.",
    tags: ["settings", "transcription", "speech-to-text", "on-device", "model", "opt-out", "voice"],
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
    description:
      "Settings → Editor: editor-typography presets for text size, line spacing, content width and font family. Selecting a field's canonical default clears the stored value to null, keeping an explicitly-default vault byte-identical to an untouched one.",
    tags: ["settings", "editor", "typography", "text-size", "line-spacing", "font", "presets"],
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
    description:
      "Settings → Editor: the Views feature switch, a device-local preference rather than a vault one. Effective state is the stored pref if set, else the back-compat default derived from whether the vault already has saved views; writing bumps the event so the sidebar entry appears live.",
    tags: ["settings", "editor", "saved-views", "toggle", "device-local", "sidebar"],
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
    description:
      "Settings → Editor: a single switch for vim keyboard mode, default off, with the engine downloaded only on the first enable. The setter bumps the prefs nonce so an open editor reconfigures its vim compartment live, with no remount.",
    tags: ["settings", "editor", "vim", "modal-editing", "keyboard", "toggle"],
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
    description:
      "Not a panel: the vendored browser glyph set the connected-extensions list draws, shown on its own so a new or missing icon is visible without opening a paired-extension row. Renders one icon by extension id.",
    tags: ["settings", "browser-extensions", "icon", "glyph", "chromium", "firefox", "vendor"],
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
    description:
      "The settings search field at rest, empty. It scores a static registry rather than scanning the rendered panels, because panels run IPC on mount; typing opens a suggestion listbox under the input.",
    tags: ["settings", "search", "query", "field", "registry", "suggestions"],
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
    description:
      "The settings search results for one query: each hit grouped under its owning panel, and selecting one navigates there and scrolls to the setting's anchor. This fixture is a single Appearance → Theme hit.",
    tags: ["settings", "search", "results", "grouped", "navigation", "theme"],
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
    description:
      "Settings → Appearance: bottom-bar customization, a reorder and show/hide roster over the frozen bar vocabulary. It is a precondition of the bar being allowed to disappear, since otherwise the only way to restore a hidden item was the bar's own right-click menu.",
    tags: ["settings", "appearance", "bottom-bar", "customize", "reorder", "show-hide", "commands"],
    fixture: PREFS_FIXTURE,
    render: () => <BarCustomizeSettings />,
  },
  {
    id: "settings/customizelist/default",
    group: "settings",
    surface: "CustomizeList",
    state: "default",
    description:
      "The shared shape of a \"customize this strip of commands\" list, demonstrated with three icon rows; the ribbon customization and the bar customization both compose it. It is a toolkit (a row plus a drag hook plus its style) rather than a self-contained surface, so this wrapper is what a story can mount.",
    tags: ["settings", "customizelist", "reorder", "icon-rows", "shared", "pattern"],
    render: () => <CustomizeListDemo />,
  },
];
