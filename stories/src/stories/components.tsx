// Stories for the shared components and the remaining screens (myne-md/myne#832).
//
// One entry per surface. See `primitives.tsx` for the descriptor shape.
//
// Breadth over depth: most surfaces carry a single `default` state. Components
// that only render once an event or a fixture arrives (PairingDialog,
// ThemeInstallDialog, SyncBanners, RepairResidueBanner, …) still get a story —
// mounting them is what catches a module-scope crash — and render whatever their
// default state is.

import type { ReactNode } from "react";
import { ActionStatus } from "@app/components/ActionStatus";
import { AccountStep } from "@app/screens/vault-creation/AccountStep";
import { AccountBootstrap } from "@app/screens/AccountBootstrap";
import { CreateVault } from "@app/screens/CreateVault";
import { AgentReview } from "@app/screens/AgentReview";
import { AnsweredByIndicator } from "@app/components/AnsweredByIndicator";
import { AttachmentSyncProgress } from "@app/components/attachments/AttachmentSyncProgress";
import { AttachmentThumbnail } from "@app/components/attachments/AttachmentThumbnail";
import { AttachmentsLibrary } from "@app/components/attachments/AttachmentsLibrary";
import { BackupExportModal } from "@app/components/backup/BackupExportModal";
import { BetaTermsConsent } from "@app/components/sync/BetaTermsConsent";
import { BlockingProgressStep } from "@app/components/BlockingProgressStep";
import { BriefingStep } from "@app/screens/vault-creation/BriefingStep";
import { BuildingIndexState } from "@app/components/sync/BuildingIndexState";
import { CenteredCard } from "@app/components/primitives/CenteredCard";
import { CleanUnusedAttachmentsDialog } from "@app/components/attachments/CleanUnusedAttachmentsDialog";
import { CommandPalette } from "@app/components/CommandPalette";
import { ConfirmStep } from "@app/screens/vault-creation/ConfirmStep";
import { CoverPicker } from "@app/components/attachments/CoverPicker";
import { DecryptingStep } from "@app/screens/vault-recover/DecryptingStep";
import { DeleteAttachmentDialog } from "@app/components/attachments/DeleteAttachmentDialog";
import { DeleteVaultConfirmForm } from "@app/components/DeleteVaultConfirmForm";
import { DestructiveBanner } from "@app/components/DestructiveBanner";
import { DeviceJoinQr } from "@app/components/sync/DeviceJoinQr";
import { DeviceManagementPanel } from "@app/components/sync/DeviceManagementPanel";
import { Editor } from "@app/screens/Editor";
import { EncryptingStep } from "@app/screens/vault-creation/EncryptingStep";
import { EndpointConfig } from "@app/components/sync/EndpointConfig";
import { EnrollDeviceForm } from "@app/components/sync/EnrollDeviceForm";
import { EnrollPhraseCredential } from "@app/components/sync/EnrollPhraseCredential";
import { ErrorBanner } from "@app/components/ErrorBanner";
import { ExportEgressNotice } from "@app/components/export/ExportEgressNotice";
import { FailClosedError } from "@app/components/FailClosedError";
import { FirstRunServerStep } from "@app/components/sync/FirstRunServerStep";
import { Icon } from "@app/components/primitives/Icon";
import { IdentityHome } from "@app/screens/IdentityHome";
import { IdentitySetupDialog } from "@app/components/IdentitySetupDialog";
import { ImportPlainFileButton } from "@app/components/plain/ImportPlainFileButton";
import { IntegrityAlertBanner } from "@app/components/sync/IntegrityAlertBanner";
import { JoinDeviceModal } from "@app/components/sync/JoinDeviceModal";
import { Keycaps } from "@app/components/primitives/Keycaps";
import { MemberRosterPanel } from "@app/components/sync/MemberRosterPanel";
import { MemberVaultUnlockCard } from "@app/components/sync/MemberVaultUnlockCard";
import { ModalShell } from "@app/components/primitives/ModalShell";
import { MyneMark } from "@app/components/primitives/MyneMark";
import { NewNoteFromTemplateModal } from "@app/components/NewNoteFromTemplateModal";
import { NoteExportModal } from "@app/components/export/NoteExportModal";
import { NotePdfExportNotice } from "@app/components/export/NotePdfExportNotice";
import { PairingDialog } from "@app/components/PairingDialog";
import { PanelToggleGlyph } from "@app/components/primitives/PanelToggleGlyph";
import { PasswordChangeForm } from "@app/components/PasswordChangeForm";
import { PasswordCreateForm } from "@app/components/PasswordCreateForm";
import { PasswordInput } from "@app/components/PasswordInput";
import { PasswordResetStep } from "@app/screens/vault-recover/PasswordResetStep";
import { PasswordStep } from "@app/screens/vault-creation/PasswordStep";
import { PasswordStrength } from "@app/components/PasswordStrength";
import { PhraseEntryStep } from "@app/screens/vault-recover/PhraseEntryStep";
import { PhraseStep } from "@app/screens/vault-creation/PhraseStep";
import { ProvisioningStep } from "@app/screens/vault-creation/ProvisioningStep";
import { QuickPicker } from "@app/components/QuickPicker";
import { QuickUnlockEntry } from "@app/components/QuickUnlockEntry";
import { ReadyLocalArtefacts } from "@app/screens/vault-creation/ReadyLocalArtefacts";
import { ReadyStep } from "@app/screens/vault-creation/ReadyStep";
import { ReconcileBanner } from "@app/components/sync/ReconcileBanner";
import { RecoveredNotes } from "@app/components/sync/RecoveredNotes";
import { RecoverySelectStep } from "@app/screens/vault-recover/RecoverySelectStep";
import { RemoteMergeHint } from "@app/components/sync/RemoteMergeHint";
import { RepairResidueBanner } from "@app/components/RepairResidueBanner";
import { ResizeHandle } from "@app/components/primitives/ResizeHandle";
import { RestoreBackup } from "@app/screens/RestoreBackup";
import { RootErrorBoundary } from "@app/components/RootErrorBoundary";
import { ScreenCaptureEscape } from "@app/components/ScreenCaptureEscape";
import { ScrollArea } from "@app/components/primitives/ScrollArea";
import { SearchableSelect } from "@app/components/primitives/SearchableSelect";
import { SecretPhraseReveal } from "@app/components/SecretPhraseReveal";
import { SessionLostStep } from "@app/screens/vault-creation/SessionLostStep";
import { SettingsModal } from "@app/components/SettingsModal";
import { SkipToContent } from "@app/components/SkipToContent";
import { SuspicionBanner } from "@app/components/SuspicionBanner";
import { SyncBanners } from "@app/components/sync/SyncBanners";
import { SyncStatusIndicator } from "@app/components/sync/SyncStatusIndicator";
import { SyncUsageBlock } from "@app/components/sync/SyncUsageBlock";
import { TemplatesManager } from "@app/components/TemplatesManager";
import { ThemeChiplet } from "@app/components/primitives/ThemeChiplet";
import { ThemeInstallDialog } from "@app/components/ThemeInstallDialog";
import { Toast } from "@app/components/Toast";
import { Toaster } from "@app/components/toast/Toaster";
import { TorStatusBanner } from "@app/components/sync/TorStatusBanner";
import { TranscriptionModal } from "@app/components/attachments/TranscriptionModal";
import { Unlock } from "@app/screens/Unlock";
import { UsedInNotesPopover } from "@app/components/attachments/UsedInNotesPopover";
import { VaultExportModal } from "@app/components/export/VaultExportModal";
import { VaultPicker } from "@app/screens/VaultPicker";
import { VaultRecover } from "@app/screens/VaultRecover";
import { VaultSwitcher } from "@app/components/VaultSwitcher";
import { WebNoAccount } from "@app/screens/WebNoAccount";
import { WebReloadNotice } from "@app/components/WebReloadNotice";
import { SidebarStateProvider } from "@app/notes/sidebarState";
import { WorkspaceProvider } from "@app/notes/workspaceContext";
import type { StoryDescriptor } from "../types";
import type { CommandContext } from "@app/commands/registry";
import type { VaultRecoverState } from "@app/screens/vault-recover/reducer";

const noop = () => {};
const asyncNoop = async (): Promise<void> => {};

const VAULT_ID = "00000000-0000-7000-8000-000000000001";

/** 24 synthetic word tokens — deliberately not BIP-39 words. */
const PHRASE: readonly string[] = Array.from(
  { length: 24 },
  (_, i) => `word${String(i + 1).padStart(2, "0")}`,
);

const PHONE_CELLS: string[] = Array.from({ length: 24 }, () => "");
const EMPTY_CACHE = new Map();
const ANCHOR_REF: { current: HTMLElement | null } = { current: null };

const ATTACHMENT = {
  id: "0".repeat(64),
  content_type: "image/png",
  created_at: 1_700_000_000,
  filename: "diagram.png",
  size: 204_800,
};

const COMMAND_CONTEXT = {
  stageName: "editor",
  selectedNoteId: null,
  aiEnabled: false,
  prefs: {},
} as unknown as CommandContext;

/**
 * One unlocked vault with the prefs shape the editor tree reads. The named
 * `unlocked` fixture returns bare `{}` for `prefs_read`, which leaves
 * `prefs.archived_folders` undefined and trips `archivedFolderKeys(...)`.
 */
const UNLOCKED_FIXTURE = {
  description: "one unlocked vault with the default prefs shape",
  handlers: {
    "plugin:vault-unlock|vault_list": () => [
      {
        id: VAULT_ID,
        status: { kind: "Exists" },
        label: null,
        icon: null,
        last_unlock: null,
      },
    ],
    "plugin:vault-unlock|vault_slot_kind": () => "Unlocked",
    "plugin:prefs|prefs_read": () => ({
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
    }),
  },
};

const RECOVER_PHRASE_ENTRY: VaultRecoverState = {
  subStep: "phrase-entry",
  vaultId: null,
  cells: PHONE_CELLS,
  password: "",
  banner: null,
  failClosed: null,
  deleteInFlight: false,
  deletePartialFail: null,
};

const RECOVER_PASSWORD_RESET: VaultRecoverState = {
  ...RECOVER_PHRASE_ENTRY,
  subStep: "password-reset",
};

/** A centered child, so a layout primitive has something to lay out. */
function Prose({ children }: { children: ReactNode }) {
  return <p>{children}</p>;
}

export const COMPONENT_STORIES: StoryDescriptor[] = [
  // ── Intro / status surfaces ──────────────────────────────────────────────
  {
    id: "components/actionstatus/default",
    group: "components",
    surface: "ActionStatus",
    state: "default",
    render: () => <ActionStatus message="Copied to clipboard" />,
  },
  {
    id: "components/actionstatus/visually-hidden",
    group: "components",
    surface: "ActionStatus",
    state: "visually-hidden",
    render: () => <ActionStatus message="Copied to clipboard" visuallyHidden />,
  },
  {
    id: "components/answeredbyindicator/default",
    group: "components",
    surface: "AnsweredByIndicator",
    state: "default",
    render: () => (
      <AnsweredByIndicator answeredBy={{ kind: "local-runtime", name: "llama" }} />
    ),
  },
  {
    id: "components/errorbanner/default",
    group: "components",
    surface: "ErrorBanner",
    state: "default",
    render: () => (
      <ErrorBanner
        error={{
          title: "Could not create the vault",
          body: "Something went wrong. Nothing was changed on disk.",
          primaryAction: "retry",
          displayMode: "inline",
        }}
      />
    ),
  },
  {
    id: "components/failclosederror/invalid-state",
    group: "components",
    surface: "FailClosedError",
    state: "invalid-state",
    render: () => (
      <FailClosedError reason={{ kind: "invalid-state" }} onCtaClick={noop} />
    ),
  },
  {
    id: "components/suspicionbanner/default",
    group: "components",
    surface: "SuspicionBanner",
    state: "default",
    render: () => <SuspicionBanner reason="vault-meta-changed-externally" />,
  },
  {
    id: "components/skiptocontent/default",
    group: "components",
    surface: "SkipToContent",
    state: "default",
    render: () => <SkipToContent />,
  },
  {
    id: "components/rooterrorboundary/default",
    group: "components",
    surface: "RootErrorBoundary",
    state: "default",
    render: () => (
      <RootErrorBoundary>
        <Prose>A healthy subtree.</Prose>
      </RootErrorBoundary>
    ),
  },
  {
    id: "components/screencaptureescape/default",
    group: "components",
    surface: "ScreenCaptureEscape",
    state: "default",
    render: () => <ScreenCaptureEscape />,
  },
  {
    id: "components/webreloadnotice/default",
    group: "components",
    surface: "WebReloadNotice",
    state: "default",
    render: () => <WebReloadNotice />,
  },

  // ── Primitives that live under components/primitives/ ────────────────────
  {
    id: "components/centeredcard/default",
    group: "components",
    surface: "CenteredCard",
    state: "default",
    render: () => (
      <CenteredCard>
        <Prose>Centered content.</Prose>
      </CenteredCard>
    ),
  },
  {
    id: "components/icon/default",
    group: "components",
    surface: "Icon",
    state: "default",
    render: () => <Icon name="settings" />,
  },
  {
    id: "components/keycaps/default",
    group: "components",
    surface: "Keycaps",
    state: "default",
    render: () => <Keycaps chord="Mod+K" />,
  },
  {
    id: "components/modalshell/default",
    group: "components",
    surface: "ModalShell",
    state: "default",
    render: () => (
      <ModalShell
        open
        title="Modal title"
        onClose={noop}
        labelId="story-modal-title"
      >
        <Prose>Modal body.</Prose>
      </ModalShell>
    ),
  },
  {
    id: "components/mynemark/default",
    group: "components",
    surface: "MyneMark",
    state: "default",
    render: () => <MyneMark size={48} />,
  },
  {
    id: "components/paneltoggleglyph/default",
    group: "components",
    surface: "PanelToggleGlyph",
    state: "default",
    render: () => <PanelToggleGlyph side="left" collapsed={false} />,
  },
  {
    id: "components/resizehandle/default",
    group: "components",
    surface: "ResizeHandle",
    state: "default",
    render: () => (
      <ResizeHandle
        side="left"
        width={260}
        min={180}
        max={480}
        containerRef={ANCHOR_REF}
        onResize={noop}
        onToggleCollapse={noop}
        label="Resize notes sidebar"
      />
    ),
  },
  {
    id: "components/scrollarea/default",
    group: "components",
    surface: "ScrollArea",
    state: "default",
    render: () => (
      <ScrollArea ariaLabel="Scrollable sample">
        <Prose>Scrollable content.</Prose>
      </ScrollArea>
    ),
  },
  {
    id: "components/searchableselect/default",
    group: "components",
    surface: "SearchableSelect",
    state: "default",
    render: () => (
      <SearchableSelect
        aria-label="Theme"
        options={[
          { value: "system", label: "System" },
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
        selected={["system"]}
        onChange={noop}
      />
    ),
  },
  {
    id: "components/themechiplet/default",
    group: "components",
    surface: "ThemeChiplet",
    state: "default",
    render: () => (
      <ThemeChiplet
        preview={{
          background: "var(--paper)",
          "surface": "var(--bg-2)",
          foreground: "var(--fg-1)",
          accent: "var(--accent)",
          line: "var(--line-1)",
        }}
      />
    ),
  },
  {
    id: "components/destructivebanner/default",
    group: "components",
    surface: "DestructiveBanner",
    state: "default",
    render: () => (
      <DestructiveBanner testId="story.destructive">
        <Prose>This cannot be undone.</Prose>
      </DestructiveBanner>
    ),
  },

  // ── Password and form surfaces ───────────────────────────────────────────
  {
    id: "components/passwordinput/default",
    group: "components",
    surface: "PasswordInput",
    state: "default",
    render: () => (
      <PasswordInput
        label="Master password"
        value=""
        onChange={noop}
        show={false}
        onToggleShow={noop}
      />
    ),
  },
  {
    id: "components/passwordstrength/default",
    group: "components",
    surface: "PasswordStrength",
    state: "default",
    render: () => <PasswordStrength score={3} warning="A common word" />,
  },
  {
    id: "components/passwordcreateform/default",
    group: "components",
    surface: "PasswordCreateForm",
    state: "default",
    render: () => <PasswordCreateForm submitLabel="Continue" onSubmit={noop} />,
  },
  {
    id: "components/passwordchangeform/default",
    group: "components",
    surface: "PasswordChangeForm",
    state: "default",
    render: () => <PasswordChangeForm onSubmit={noop} onCancel={noop} />,
  },
  {
    id: "components/deletevaultconfirmform/default",
    group: "components",
    surface: "DeleteVaultConfirmForm",
    state: "default",
    render: () => (
      <DeleteVaultConfirmForm
        onSubmit={noop}
        onCancel={noop}
        onContinueAfterPartial={noop}
        partialFailContext={null}
      />
    ),
  },

  // ── Attachments ──────────────────────────────────────────────────────────
  {
    id: "components/attachmentsyncprogress/default",
    group: "components",
    surface: "AttachmentSyncProgress",
    state: "default",
    render: () => <AttachmentSyncProgress />,
  },
  {
    id: "components/attachmentthumbnail/default",
    group: "components",
    surface: "AttachmentThumbnail",
    state: "default",
    render: () => (
      <AttachmentThumbnail
        id={ATTACHMENT.id}
        contentType={ATTACHMENT.content_type}
        filename={ATTACHMENT.filename}
        size={96}
      />
    ),
  },
  {
    id: "components/attachmentslibrary/default",
    group: "components",
    surface: "AttachmentsLibrary",
    state: "default",
    fixture: "unlocked",
    render: () => (
      <SidebarStateProvider>
        <AttachmentsLibrary onClose={noop} />
      </SidebarStateProvider>
    ),
  },
  {
    id: "components/cleanunusedattachmentsdialog/default",
    group: "components",
    surface: "CleanUnusedAttachmentsDialog",
    state: "default",
    render: () => (
      <CleanUnusedAttachmentsDialog
        attachments={[ATTACHMENT]}
        onConfirm={async () => ({ deleted: 1, skipped: 0, bytes_reclaimed: 204_800 })}
        onClose={noop}
      />
    ),
  },
  {
    id: "components/deleteattachmentdialog/default",
    group: "components",
    surface: "DeleteAttachmentDialog",
    state: "default",
    render: () => (
      <DeleteAttachmentDialog
        attachment={ATTACHMENT}
        referencingNoteIds={[]}
        cache={EMPTY_CACHE}
        onConfirm={asyncNoop}
        onClose={noop}
      />
    ),
  },
  {
    id: "components/coverpicker/default",
    group: "components",
    surface: "CoverPicker",
    state: "default",
    render: () => (
      <CoverPicker
        open
        hasCover={false}
        onClose={noop}
        onPick={noop}
        onRemove={noop}
      />
    ),
  },
  {
    id: "components/usedinnotespopover/default",
    group: "components",
    surface: "UsedInNotesPopover",
    state: "default",
    render: () => (
      <UsedInNotesPopover
        noteIds={[]}
        cache={EMPTY_CACHE}
        onJump={noop}
        onClose={noop}
        anchorRef={ANCHOR_REF}
      />
    ),
  },
  {
    id: "components/transcriptionmodal/default",
    group: "components",
    surface: "TranscriptionModal",
    state: "default",
    render: () => (
      <TranscriptionModal
        open
        filename="recording.m4a"
        text="Transcribed text."
        onClose={noop}
      />
    ),
  },

  // ── Export and backup ────────────────────────────────────────────────────
  {
    id: "components/backupexportmodal/default",
    group: "components",
    surface: "BackupExportModal",
    state: "default",
    fixture: "unlocked",
    render: () => (
      <BackupExportModal
        open
        onClose={noop}
        vaultId={VAULT_ID}
        onShowToast={noop}
      />
    ),
  },
  {
    id: "components/exportegressnotice/default",
    group: "components",
    surface: "ExportEgressNotice",
    state: "default",
    render: () => (
      <ExportEgressNotice
        open
        sentence="This will write the note to a file you choose."
        onCancel={noop}
        onConfirm={noop}
      />
    ),
  },
  {
    id: "components/noteexportmodal/default",
    group: "components",
    surface: "NoteExportModal",
    state: "default",
    render: () => (
      <NoteExportModal
        open
        attachmentCount={2}
        onCancel={noop}
        onConfirm={noop}
        onCopy={noop}
      />
    ),
  },
  {
    id: "components/notepdfexportnotice/default",
    group: "components",
    surface: "NotePdfExportNotice",
    state: "default",
    render: () => (
      <NotePdfExportNotice
        open
        excludedAttachments={[{ id: ATTACHMENT.id, filename: ATTACHMENT.filename }]}
        onCancel={noop}
        onConfirm={noop}
      />
    ),
  },
  {
    id: "components/vaultexportmodal/default",
    group: "components",
    surface: "VaultExportModal",
    state: "default",
    render: () => (
      <VaultExportModal open onClose={noop} folders={["notes/", "archive/"]} />
    ),
  },

  // ── Sync surfaces ────────────────────────────────────────────────────────
  {
    id: "components/betatermsconsent/default",
    group: "components",
    surface: "BetaTermsConsent",
    state: "default",
    render: () => (
      <BetaTermsConsent
        open
        testId="story.beta-terms"
        onAccept={noop}
        onCancel={noop}
      />
    ),
  },
  {
    id: "components/buildingindexstate/default",
    group: "components",
    surface: "BuildingIndexState",
    state: "default",
    render: () => <BuildingIndexState building />,
  },
  {
    id: "components/devicejoinqr/default",
    group: "components",
    surface: "DeviceJoinQr",
    state: "default",
    render: () => <DeviceJoinQr />,
  },
  {
    id: "components/devicemanagementpanel/default",
    group: "components",
    surface: "DeviceManagementPanel",
    state: "default",
    render: () => (
      <DeviceManagementPanel
        hook={{
          devices: [],
          pending: [],
          error: null,
          busy: false,
          refresh: asyncNoop,
          approve: async () => true,
          remove: asyncNoop,
          resetLocal: asyncNoop,
        }}
      />
    ),
  },
  {
    id: "components/endpointconfig/default",
    group: "components",
    surface: "EndpointConfig",
    state: "default",
    render: () => <EndpointConfig />,
  },
  {
    id: "components/enrolldeviceform/default",
    group: "components",
    surface: "EnrollDeviceForm",
    state: "default",
    render: () => <EnrollDeviceForm />,
  },
  {
    id: "components/enrollphrasecredential/default",
    group: "components",
    surface: "EnrollPhraseCredential",
    state: "default",
    render: () => (
      <EnrollPhraseCredential
        baseId="story-enroll"
        cells={PHONE_CELLS}
        onCellChange={() => noop}
        onCellPaste={() => noop}
      />
    ),
  },
  {
    id: "components/firstrunserverstep/default",
    group: "components",
    surface: "FirstRunServerStep",
    state: "default",
    render: () => (
      <FirstRunServerStep onConnected={noop} onBack={noop} />
    ),
  },
  {
    id: "components/integrityalertbanner/default",
    group: "components",
    surface: "IntegrityAlertBanner",
    state: "default",
    render: () => <IntegrityAlertBanner present onDismiss={noop} />,
  },
  {
    id: "components/joindevicemodal/default",
    group: "components",
    surface: "JoinDeviceModal",
    state: "default",
    render: () => <JoinDeviceModal onCancel={noop} onJoined={noop} />,
  },
  {
    id: "components/memberrosterpanel/default",
    group: "components",
    surface: "MemberRosterPanel",
    state: "default",
    fixture: {
      description: "unlocked vault whose membership roster is empty",
      handlers: {
        "plugin:sync|sync_list_roster": () => ({
          members: [],
          authority: "member",
          group_key_epoch: null,
        }),
      },
    },
    render: () => <MemberRosterPanel />,
  },
  {
    id: "components/membervaultunlockcard/default",
    group: "components",
    surface: "MemberVaultUnlockCard",
    state: "default",
    render: () => (
      <MemberVaultUnlockCard vaultId={VAULT_ID} onUnlocked={noop} />
    ),
  },
  {
    id: "components/reconcilebanner/default",
    group: "components",
    surface: "ReconcileBanner",
    state: "default",
    render: () => <ReconcileBanner active onDismiss={noop} />,
  },
  {
    id: "components/recoverednotes/default",
    group: "components",
    surface: "RecoveredNotes",
    state: "default",
    render: () => <RecoveredNotes />,
  },
  {
    id: "components/remotemergehint/default",
    group: "components",
    surface: "RemoteMergeHint",
    state: "default",
    render: () => <RemoteMergeHint />,
  },
  {
    id: "components/repairresiduebanner/default",
    group: "components",
    surface: "RepairResidueBanner",
    state: "default",
    render: () => <RepairResidueBanner />,
  },
  {
    id: "components/syncbanners/default",
    group: "components",
    surface: "SyncBanners",
    state: "default",
    fixture: "unlocked",
    render: () => <SyncBanners />,
  },
  {
    id: "components/syncstatusindicator/default",
    group: "components",
    surface: "SyncStatusIndicator",
    state: "default",
    fixture: {
      description: "sync configured and idle",
      handlers: { "plugin:sync|sync_status": () => ({ state: "idle" }) },
    },
    render: () => <SyncStatusIndicator />,
  },
  {
    id: "components/syncusageblock/default",
    group: "components",
    surface: "SyncUsageBlock",
    state: "default",
    render: () => (
      <SyncUsageBlock
        status={{
          stored_bytes: 512_000_000,
          quota_bytes: 2_000_000_000,
          device_count: 2,
          max_devices: 5,
          frozen: false,
        }}
      />
    ),
  },
  {
    id: "components/torstatusbanner/default",
    group: "components",
    surface: "TorStatusBanner",
    state: "default",
    render: () => <TorStatusBanner posture="connecting" />,
  },

  // ── Toast ────────────────────────────────────────────────────────────────
  {
    id: "components/toast/default",
    group: "components",
    surface: "Toast",
    state: "default",
    render: () => <Toast message="Saved" onDone={noop} />,
  },
  {
    id: "components/toaster/default",
    group: "components",
    surface: "Toaster",
    state: "default",
    render: () => <Toaster />,
  },

  // ── Dialog and picker surfaces ───────────────────────────────────────────
  {
    id: "components/commandpalette/default",
    group: "components",
    surface: "CommandPalette",
    state: "default",
    fixture: UNLOCKED_FIXTURE,
    render: () => (
      <SidebarStateProvider>
        <CommandPalette open onClose={noop} ctx={COMMAND_CONTEXT} />
      </SidebarStateProvider>
    ),
  },
  {
    id: "components/quickpicker/default",
    group: "components",
    surface: "QuickPicker",
    state: "default",
    render: () => (
      <QuickPicker
        open
        title="Pick a note"
        placeholder="Search…"
        items={[
          { id: "n1", label: "Meeting notes" },
          { id: "n2", label: "Reading list", sublabel: "projects" },
        ]}
        emptyText="No matches"
        onPick={noop}
        onClose={noop}
      />
    ),
  },
  {
    id: "components/pairingdialog/default",
    group: "components",
    surface: "PairingDialog",
    state: "default",
    render: () => <PairingDialog />,
  },
  {
    id: "components/themeinstalldialog/default",
    group: "components",
    surface: "ThemeInstallDialog",
    state: "default",
    render: () => <ThemeInstallDialog />,
  },
  {
    id: "components/identitysetupdialog/default",
    group: "components",
    surface: "IdentitySetupDialog",
    state: "default",
    fixture: "unlocked",
    render: () => <IdentitySetupDialog open onClose={noop} />,
  },
  {
    id: "components/newnotefromtemplatemodal/default",
    group: "components",
    surface: "NewNoteFromTemplateModal",
    state: "default",
    render: () => (
      <NewNoteFromTemplateModal
        open
        onClose={noop}
        onBlankNote={noop}
        onCreateFromTemplate={noop}
      />
    ),
  },
  {
    id: "components/templatesmanager/default",
    group: "components",
    surface: "TemplatesManager",
    state: "default",
    fixture: "unlocked",
    render: () => (
      <TemplatesManager open onClose={noop} onOpenNote={noop} />
    ),
  },
  {
    id: "components/settingsmodal/default",
    group: "components",
    surface: "SettingsModal",
    state: "default",
    fixture: "unlocked",
    render: () => (
      <SettingsModal
        vaultId={VAULT_ID}
        open
        onClose={noop}
        onDeleteVaultSuccess={noop}
      />
    ),
  },
  {
    id: "components/vaultswitcher/default",
    group: "components",
    surface: "VaultSwitcher",
    state: "default",
    fixture: "unlocked",
    render: () => (
      <VaultSwitcher
        onSwitchVault={noop}
        onCreateAnother={noop}
        switching={false}
      />
    ),
  },

  // ── Blocking progress / boot-side surfaces ───────────────────────────────
  {
    id: "components/blockingprogressstep/default",
    group: "components",
    surface: "BlockingProgressStep",
    state: "default",
    render: () => (
      <BlockingProgressStep
        eyebrow="ENCRYPTING"
        heading="Encrypting your vault"
        caption="This takes a moment."
      />
    ),
  },
  {
    id: "components/importplainfilebutton/default",
    group: "components",
    surface: "ImportPlainFileButton",
    state: "default",
    render: () => <ImportPlainFileButton handle={1} />,
  },
  {
    id: "components/quickunlockentry/default",
    group: "components",
    surface: "QuickUnlockEntry",
    state: "default",
    fixture: "locked",
    render: () => (
      <QuickUnlockEntry
        vaultId={VAULT_ID}
        method="pin"
        onUnlocked={noop}
        onUnavailable={noop}
      />
    ),
  },
  {
    id: "components/secretphrasereveal/default",
    group: "components",
    surface: "SecretPhraseReveal",
    state: "default",
    render: () => (
      <SecretPhraseReveal
        phrase={PHRASE}
        revealed
        onReveal={noop}
        onHide={noop}
        testIdPrefix="story.phrase"
        saveFilename="recovery-phrase.txt"
      />
    ),
  },
  {
    id: "components/webnoaccount/default",
    group: "components",
    surface: "WebNoAccount",
    state: "default",
    render: () => <WebNoAccount wall="no-account" />,
  },

  // ── Vault-creation flow steps ────────────────────────────────────────────
  {
    id: "components/briefingstep/default",
    group: "components",
    surface: "BriefingStep",
    state: "default",
    render: () => <BriefingStep onBack={noop} onContinue={noop} />,
  },
  {
    id: "components/passwordstep/default",
    group: "components",
    surface: "PasswordStep",
    state: "default",
    render: () => <PasswordStep error={null} onBack={noop} onSubmit={noop} />,
  },
  {
    id: "components/phrasestep/default",
    group: "components",
    surface: "PhraseStep",
    state: "default",
    render: () => (
      <PhraseStep
        phrase={[...PHRASE]}
        revealed
        dispatch={noop}
        onCancelSession={noop}
      />
    ),
  },
  {
    id: "components/confirmstep/default",
    group: "components",
    surface: "ConfirmStep",
    state: "default",
    render: () => (
      <ConfirmStep
        phrase={[...PHRASE]}
        positions={[1, 9, 17, 24]}
        inputs={{}}
        dispatch={noop}
      />
    ),
  },
  {
    id: "components/accountstep/default",
    group: "components",
    surface: "AccountStep",
    state: "default",
    render: () => (
      <AccountStep
        accountNumber="MY-ABCD-EFGH-JKMN-PQRS-TVWX"
        acknowledged={false}
        committing={false}
        error={null}
        inviteCode=""
        onInviteCodeChange={noop}
        showInviteCode
        dispatch={noop}
      />
    ),
  },
  {
    id: "components/encryptingstep/default",
    group: "components",
    surface: "EncryptingStep",
    state: "default",
    render: () => <EncryptingStep />,
  },
  {
    id: "components/sessionloststep/default",
    group: "components",
    surface: "SessionLostStep",
    state: "default",
    render: () => (
      <SessionLostStep
        error={{
          title: "Session ended",
          body: "The creation session was lost. Start again.",
          primaryAction: "restart",
          displayMode: "dedicated",
        }}
        dispatch={noop}
      />
    ),
  },
  {
    id: "components/provisioningstep/default",
    group: "components",
    surface: "ProvisioningStep",
    state: "default",
    render: () => <ProvisioningStep />,
  },
  {
    id: "components/readystep/default",
    group: "components",
    surface: "ReadyStep",
    state: "default",
    render: () => <ReadyStep onDone={noop} vaultId={VAULT_ID} />,
  },
  {
    id: "components/readylocalartefacts/default",
    group: "components",
    surface: "ReadyLocalArtefacts",
    state: "default",
    render: () => <ReadyLocalArtefacts pending={false} vaultId={VAULT_ID} />,
  },

  // ── Vault-recover flow steps ─────────────────────────────────────────────
  {
    id: "components/recoveryselectstep/default",
    group: "components",
    surface: "RecoverySelectStep",
    state: "default",
    fixture: "locked",
    render: () => (
      <RecoverySelectStep onVaultSelected={noop} onCancel={noop} />
    ),
  },
  {
    id: "components/phraseentrystep/default",
    group: "components",
    surface: "PhraseEntryStep",
    state: "default",
    render: () => (
      <PhraseEntryStep
        state={RECOVER_PHRASE_ENTRY}
        dispatch={noop}
        onCancel={noop}
        onSubmitNormalizedPhrase={noop}
      />
    ),
  },
  {
    id: "components/decryptingstep/default",
    group: "components",
    surface: "DecryptingStep",
    state: "default",
    render: () => <DecryptingStep />,
  },
  {
    id: "components/passwordresetstep/default",
    group: "components",
    surface: "PasswordResetStep",
    state: "default",
    render: () => (
      <PasswordResetStep
        state={RECOVER_PASSWORD_RESET}
        dispatch={noop}
        onCompleteSuccess={noop}
        onRecoverAnother={noop}
      />
    ),
  },

  // ── Screens ──────────────────────────────────────────────────────────────
  {
    id: "components/accountbootstrap/default",
    group: "components",
    surface: "AccountBootstrap",
    state: "default",
    fixture: "no-vault",
    render: () => <AccountBootstrap onBootstrapped={noop} />,
  },
  {
    id: "components/agentreview/default",
    group: "components",
    surface: "AgentReview",
    state: "default",
    render: () => (
      <AgentReview onClose={noop} titleOf={() => null} />
    ),
  },
  {
    id: "components/editor/default",
    group: "components",
    surface: "Editor",
    state: "default",
    fixture: UNLOCKED_FIXTURE,
    render: () => (
      <WorkspaceProvider>
        <SidebarStateProvider>
          <Editor onRestoreBackup={noop} onDeleteVaultSuccess={noop} />
        </SidebarStateProvider>
      </WorkspaceProvider>
    ),
  },
  {
    id: "components/identityhome/default",
    group: "components",
    surface: "IdentityHome",
    state: "default",
    fixture: "unlocked",
    render: () => (
      <IdentityHome
        personIdHex={null}
        identityCode={null}
        onCreateVault={noop}
        onAccepted={noop}
        onForgotten={noop}
      />
    ),
  },
  {
    id: "components/restorebackup/default",
    group: "components",
    surface: "RestoreBackup",
    state: "default",
    fixture: "no-vault",
    render: () => <RestoreBackup entry="welcome" onExit={noop} />,
  },
  {
    id: "components/unlock/default",
    group: "components",
    surface: "Unlock",
    state: "default",
    fixture: "locked",
    render: () => (
      <Unlock
        initialStatus={{ kind: "Exists" }}
        onUnlocked={noop}
        onStartRecovery={noop}
        onResumeRecovery={noop}
        onDeleteVaultSuccess={noop}
        onRestoreBackup={noop}
      />
    ),
  },
  {
    id: "components/vaultpicker/default",
    group: "components",
    surface: "VaultPicker",
    state: "default",
    fixture: "locked",
    render: () => (
      <VaultPicker
        onSelect={noop}
        onRestoreBackup={noop}
        onCreateAnother={noop}
        onJoinDevice={noop}
      />
    ),
  },
  {
    id: "components/vaultrecover/default",
    group: "components",
    surface: "VaultRecover",
    state: "default",
    fixture: "no-vault",
    render: () => (
      <VaultRecover
        initialSubStep="phrase-entry"
        onCancel={noop}
        onCompleteSuccess={noop}
        onDeleteVaultSuccess={noop}
      />
    ),
  },
  {
    id: "components/createvault/default",
    group: "components",
    surface: "CreateVault",
    state: "default",
    fixture: "no-vault",
    render: () => (
      <CreateVault
        onBack={noop}
        onAutoUnlockSuccess={noop}
        onAutoUnlockFailed={noop}
      />
    ),
  },
];
