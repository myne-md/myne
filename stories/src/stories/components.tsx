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
import { useEffect, useState } from "react";
import { ActionStatus } from "@app/components/ActionStatus";
import { AccountBootstrap } from "@app/screens/AccountBootstrap";
import { CreateVault } from "@app/screens/CreateVault";
import { AgentReview } from "@app/screens/AgentReview";
import {
  beginRun,
  clearAgentForLock,
  currentRunEpoch,
  settleApply,
  settleStep,
} from "@app/notes/agent/agentStore";
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
import { KitStep } from "@app/screens/vault-creation/KitStep";
import { NameStep } from "@app/screens/vault-creation/NameStep";
import { AuthShell } from "@app/screens/AuthShell";
import { ChoiceRow } from "@app/components/ChoiceList";
import { PhraseGrid } from "@app/components/PhraseGrid";
import { PhraseTypeBack } from "@app/components/PhraseTypeBack";
import { SecretDisplayCaveats } from "@app/components/SecretDisplayCaveats";
import { DeviceJoinQrDialog } from "@app/components/sync/DeviceJoinQrDialog";
import { PersonIdentityUnlock } from "@app/components/sync/PersonIdentityUnlock";
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
import { MemberNameGate } from "@app/components/sync/MemberNameGate";
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
import { MeetingAiDialog } from "@app/components/meeting/MeetingAiDialog";
import { offerMeetingAi } from "@app/components/meeting/meetingAiStore";
import { Toast } from "@app/components/Toast";
import { Toaster } from "@app/components/toast/Toaster";
import { dismissToast, toast } from "@app/components/toast/toastStore";
import { TorStatusBanner } from "@app/components/sync/TorStatusBanner";
import { TranscriptionModal } from "@app/components/attachments/TranscriptionModal";
import { Unlock } from "@app/screens/Unlock";
import { UpdateBanner } from "@app/components/UpdateBanner";
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
import { DEFAULT_PREFS, FIXTURE_VAULT_ID } from "../../fixtures";
import type { CommandContext } from "@app/commands/registry";
import type { VaultRecoverState } from "@app/screens/vault-recover/reducer";
import { action } from "../actions";
import { Button } from "@app/components/primitives/Button";

const noop = () => {};
const asyncNoop = async (): Promise<void> => {};


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
        id: FIXTURE_VAULT_ID,
        status: { kind: "Exists" },
        label: null,
        icon: null,
        last_unlock: null,
      },
    ],
    "plugin:vault-unlock|vault_slot_kind": () => "Unlocked",
    "plugin:prefs|prefs_read": () => DEFAULT_PREFS,
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

/**
 * `<Toast>` is a HEADLESS bridge (myne#238): it draws nothing at all and pushes
 * its message into the shared store, which the ONE `<Toaster>` renders. So a
 * story mounting the bridge alone showed an empty box, and a story mounting the
 * Toaster alone subscribed to an empty store. Neither was broken; both were
 * half of a pair. These two helpers mount the pair the way the app does
 * (Editor mounts the Toaster once, every surface mounts the bridge), so the
 * stories finally show a toast (myne-md/myne#845).
 */
function ToastWithStack({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <Toaster />
    </>
  );
}

/**
 * The Toaster's own subject is the STACK: the newest toast fully shown, older
 * ones peeking behind it. So this pushes three. `HOLD_MS` is deliberately long,
 * because the real default is 2.5s and a catalogue story must not empty itself
 * while somebody is looking at it.
 */
const TOAST_HOLD_MS = 600_000;

function ToasterStackDemo() {
  useEffect(() => {
    const ids = [
      toast({ message: "Saved", variant: "success", durationMs: TOAST_HOLD_MS }),
      toast({ message: "Attachment uploaded", variant: "info", durationMs: TOAST_HOLD_MS }),
      toast({ message: "Sync failed", variant: "error", durationMs: TOAST_HOLD_MS }),
    ];
    return () => {
      for (const id of ids) dismissToast(id, { silent: true });
    };
  }, []);
  return <Toaster />;
}

/**
 * The review screen with a settled run behind it.
 *
 * **Seeded on mount and cleared on unmount, deliberately.** A run lives in a
 * module-scope store, so a story that seeded one during render would leave
 * twenty-one proposed edits in front of whichever story the catalogue renders
 * next, and the store is not something the fake host swaps. Clearing in the
 * effect's cleanup is what makes this story's state belong to this story.
 */
function SeededReview({ refusals = false }: { refusals?: boolean }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    beginRun(null);
    settleStep(
      {
        view: {
          runId: "story-run",
          scopeTotal: 431,
          userGrants: 1,
          modelGrants: 0,
          cancelled: false,
        },
        proposal: {
          edits: [
            {
              noteId: "n1",
              kind: "move",
              anchor: "",
              replacement: "02 - AREAS/Self Improvement/",
            },
            {
              noteId: "n2",
              kind: "move",
              anchor: "",
              replacement: "01 - PROJECTS/",
            },
          ],
          newNotes: [],
          // Long enough to be clamped: the modal shows three lines and a
          // disclosure, so the diff below is what the screen is about.
          summary:
            "Analyzed all 23 notes in 00 - INBOX/ and rehomed each according to your PARA structure. ".repeat(
              6,
            ),
        },
        end: { kind: "finished" },
        iterations: 3,
        notesRead: 23,
        charsOffDevice: null,
        excludedCount: 0,
        memoryUpdated: 0,
      },
      currentRunEpoch(),
    );
    if (refusals) {
      settleApply(
        {
          applied: 0,
          refused: [
            { noteId: "n2", index: 1, reason: "moveIntoExcludedFolder" },
          ],
          refusedNewNotes: [],
          notesWritten: [],
          notesCreated: [],
          restorePoints: [],
        },
        [],
        currentRunEpoch(),
      );
    }
    setReady(true);
    return () => clearAgentForLock();
  }, [refusals]);
  if (!ready) return null;
  return (
    <AgentReview
      onClose={action("onClose")}
      onNotesWritten={action("onNotesWritten")}
      titleOf={() => "00 - INBOX"}
      folderOf={() => "00 - INBOX/"}
    />
  );
}

export const COMPONENT_STORIES: StoryDescriptor[] = [
  // ── Intro / status surfaces ──────────────────────────────────────────────
  {
    id: "components/actionstatus/default",
    group: "components",
    surface: "ActionStatus",
    state: "default",
    description: "Action Status, a default state.",
    tags: ["components", "actionstatus", "default"],
    render: () => <ActionStatus message="Copied to clipboard" />,
  },
  {
    id: "components/actionstatus/visually-hidden",
    group: "components",
    surface: "ActionStatus",
    state: "visually-hidden",
    description: "Action Status, a visually-hidden state.",
    tags: ["components", "actionstatus", "visually-hidden"],
    render: () => <ActionStatus message="Copied to clipboard" visuallyHidden />,
  },
  {
    id: "components/answeredbyindicator/default",
    group: "components",
    surface: "AnsweredByIndicator",
    state: "default",
    description: "Answered By Indicator, a default state.",
    tags: ["components", "answeredbyindicator", "default"],
    render: () => (
      <AnsweredByIndicator answeredBy={{ kind: "local-runtime", name: "llama" }} />
    ),
  },
  {
    id: "components/errorbanner/default",
    group: "components",
    surface: "ErrorBanner",
    state: "default",
    description: "Error Banner, a default state.",
    tags: ["components", "errorbanner", "default"],
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
    description: "Fail Closed Error, an invalid-state state.",
    tags: ["components", "failclosederror", "invalid-state"],
    render: () => (
      <FailClosedError reason={{ kind: "invalid-state" }} onCtaClick={action("onCtaClick")} />
    ),
  },
  {
    id: "components/suspicionbanner/default",
    group: "components",
    surface: "SuspicionBanner",
    state: "default",
    description: "Suspicion Banner, a default state.",
    tags: ["components", "suspicionbanner", "default"],
    render: () => <SuspicionBanner reason="vault-meta-changed-externally" />,
  },
  {
    id: "components/skiptocontent/default",
    group: "components",
    surface: "SkipToContent",
    state: "default",
    description: "Skip To Content, a default state.",
    tags: ["components", "skiptocontent", "default"],
    render: () => <SkipToContent />,
  },
  {
    id: "components/rooterrorboundary/default",
    group: "components",
    surface: "RootErrorBoundary",
    state: "default",
    description: "Root Error Boundary, a default state.",
    tags: ["components", "rooterrorboundary", "default"],
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
    description: "Screen Capture Escape, a default state.",
    unreachable: {
      what: "the escape control shown while screen-capture protection is on",
      why: "it renders in response to an OS screen-capture event, which the catalogue cannot fire",
    },
    tags: ["components", "screencaptureescape", "default"],
    render: () => <ScreenCaptureEscape />,
  },
  {
    id: "components/webreloadnotice/default",
    group: "components",
    surface: "WebReloadNotice",
    state: "default",
    description: "Web Reload Notice, a default state.",
    tags: ["components", "webreloadnotice", "default"],
    render: () => <WebReloadNotice />,
  },

  // ── Primitives that live under components/primitives/ ────────────────────
  {
    id: "components/centeredcard/default",
    group: "components",
    surface: "CenteredCard",
    state: "default",
    description: "Centered Card, a default state.",
    tags: ["components", "centeredcard", "default"],
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
    description: "Icon, a default state.",
    tags: ["components", "icon", "default"],
    render: () => <Icon name="settings" />,
  },
  {
    id: "components/keycaps/default",
    group: "components",
    surface: "Keycaps",
    state: "default",
    description: "Keycaps, a default state.",
    tags: ["components", "keycaps", "default"],
    render: () => <Keycaps chord="Mod+K" />,
  },
  {
    id: "components/modalshell/default",
    group: "components",
    surface: "ModalShell",
    state: "default",
    description: "Modal Shell, a default state.",
    tags: ["components", "modalshell", "default"],
    render: () => (
      <ModalShell
        open
        title="Modal title"
        onClose={action("onClose")}
        labelId="story-modal-title"
      >
        <div
          style={{
            padding: "var(--space-5)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-3)",
          }}
        >
          <Prose>
            The shell supplies the chrome; the caller supplies the body and pads
            it. Esc, the backdrop and the close control all dismiss.
          </Prose>
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button variant="primary" onClick={action("onConfirm")}>
              Confirm
            </Button>
            <Button variant="secondary" onClick={action("onClose")}>
              Cancel
            </Button>
          </div>
        </div>
      </ModalShell>
    ),
  },
  {
    id: "components/mynemark/default",
    group: "components",
    surface: "MyneMark",
    state: "default",
    description: "Myne Mark, a default state.",
    tags: ["components", "mynemark", "default"],
    render: () => <MyneMark size={48} />,
  },
  {
    id: "components/paneltoggleglyph/default",
    group: "components",
    surface: "PanelToggleGlyph",
    state: "default",
    description: "Panel Toggle Glyph, a default state.",
    tags: ["components", "paneltoggleglyph", "default"],
    render: () => <PanelToggleGlyph side="left" collapsed={false} />,
  },
  {
    id: "components/resizehandle/default",
    group: "components",
    surface: "ResizeHandle",
    state: "default",
    description: "Resize Handle, a default state.",
    tags: ["components", "resizehandle", "default"],
    render: () => (
      <ResizeHandle
        side="left"
        width={260}
        min={180}
        max={480}
        containerRef={ANCHOR_REF}
        onResize={action("onResize")}
        onToggleCollapse={action("onToggleCollapse")}
        label="Resize notes sidebar"
      />
    ),
  },
  {
    id: "components/scrollarea/default",
    group: "components",
    surface: "ScrollArea",
    state: "default",
    description: "Scroll Area, a default state.",
    tags: ["components", "scrollarea", "default"],
    render: () => (
      <ScrollArea ariaLabel="Scrollable sample">
        <Prose>Scrollable content.</Prose>
      </ScrollArea>
    ),
  },
  {
    id: "components/scrollarea/content-at-end",
    group: "components",
    surface: "ScrollArea",
    state: "content-at-end",
    description:
      "A scroller whose content is aligned to the END of its column, which is the case the indicator's gutter exists for (myne-md/myne#848): the rows stop before the thumb instead of underneath it, which is what a right-aligned chat bubble needed.",
    tags: ["components", "scrollarea", "gutter", "overflow", "alignment"],
    render: () => (
      <div style={{ width: 280, height: 180, background: "var(--bg-1)" }}>
        <ScrollArea ariaLabel="Scrollable sample" style={{ height: 180 }}>
          {Array.from({ length: 10 }, (_, i) => (
            <div
              key={i}
              style={{
                alignSelf: "flex-end",
                width: "fit-content",
                marginInlineStart: "auto",
                marginBottom: "var(--space-2)",
                padding: "var(--space-2)",
                background: "var(--paper-2)",
                border: "1px solid var(--line-1)",
                borderRadius: "var(--radius-1)",
                fontSize: "var(--text-sm)",
              }}
            >
              A row aligned to the end, {i + 1}
            </div>
          ))}
        </ScrollArea>
      </div>
    ),
  },
  {
    id: "components/searchableselect/default",
    group: "components",
    surface: "SearchableSelect",
    state: "default",
    description: "Searchable Select, a default state.",
    tags: ["components", "searchableselect", "default"],
    render: () => (
      <SearchableSelect
        aria-label="Theme"
        options={[
          { value: "system", label: "System" },
          { value: "light", label: "Light" },
          { value: "dark", label: "Dark" },
        ]}
        selected={["system"]}
        onChange={action("onChange")}
      />
    ),
  },
  {
    id: "components/themechiplet/default",
    group: "components",
    surface: "ThemeChiplet",
    state: "default",
    description: "Theme Chiplet, a default state.",
    tags: ["components", "themechiplet", "default"],
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
    description: "Destructive Banner, a default state.",
    tags: ["components", "destructivebanner", "default"],
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
    description: "Password Input, a default state.",
    tags: ["components", "passwordinput", "default"],
    render: () => (
      <PasswordInput
        label="Master password"
        value=""
        onChange={action("onChange")}
        show={false}
        onToggleShow={action("onToggleShow")}
      />
    ),
  },
  {
    id: "components/passwordstrength/default",
    group: "components",
    surface: "PasswordStrength",
    state: "default",
    description: "Password Strength, a default state.",
    tags: ["components", "passwordstrength", "default"],
    render: () => <PasswordStrength score={3} warning="A common word" />,
  },
  {
    id: "components/passwordcreateform/default",
    group: "components",
    surface: "PasswordCreateForm",
    state: "default",
    description: "Password Create Form, a default state.",
    tags: ["components", "passwordcreateform", "default"],
    render: () => <PasswordCreateForm submitLabel="Continue" onSubmit={action("onSubmit")} />,
  },
  {
    id: "components/passwordchangeform/default",
    group: "components",
    surface: "PasswordChangeForm",
    state: "default",
    description: "Password Change Form, a default state.",
    tags: ["components", "passwordchangeform", "default"],
    render: () => <PasswordChangeForm onSubmit={action("onSubmit")} onCancel={action("onCancel")} />,
  },
  {
    id: "components/deletevaultconfirmform/default",
    group: "components",
    surface: "DeleteVaultConfirmForm",
    state: "default",
    description: "Delete Vault Confirm Form, a default state.",
    tags: ["components", "deletevaultconfirmform", "default"],
    render: () => (
      <DeleteVaultConfirmForm
        onSubmit={action("onSubmit")}
        onCancel={action("onCancel")}
        onContinueAfterPartial={action("onContinueAfterPartial")}
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
    description: "Attachment Sync Progress, a default state.",
    tags: ["components", "attachmentsyncprogress", "default"],
    render: () => <AttachmentSyncProgress />,
  },
  {
    id: "components/attachmentthumbnail/default",
    group: "components",
    surface: "AttachmentThumbnail",
    state: "default",
    description: "Attachment Thumbnail, a default state.",
    tags: ["components", "attachmentthumbnail", "default"],
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
    description: "Attachments Library, a default state.",
    tags: ["components", "attachmentslibrary", "default"],
    fixture: "unlocked",
    render: () => (
      <SidebarStateProvider>
        <AttachmentsLibrary />
      </SidebarStateProvider>
    ),
  },
  {
    id: "components/cleanunusedattachmentsdialog/default",
    group: "components",
    surface: "CleanUnusedAttachmentsDialog",
    state: "default",
    description: "Clean Unused Attachments Dialog, a default state.",
    tags: ["components", "cleanunusedattachmentsdialog", "default"],
    render: () => (
      <CleanUnusedAttachmentsDialog
        attachments={[ATTACHMENT]}
        onConfirm={async () => ({ deleted: 1, skipped: 0, bytes_reclaimed: 204_800 })}
        onClose={action("onClose")}
      />
    ),
  },
  {
    id: "components/deleteattachmentdialog/default",
    group: "components",
    surface: "DeleteAttachmentDialog",
    state: "default",
    description: "Delete Attachment Dialog, a default state.",
    tags: ["components", "deleteattachmentdialog", "default"],
    render: () => (
      <DeleteAttachmentDialog
        attachment={ATTACHMENT}
        referencingNoteIds={[]}
        cache={EMPTY_CACHE}
        onConfirm={asyncNoop}
        onClose={action("onClose")}
      />
    ),
  },
  {
    id: "components/coverpicker/default",
    group: "components",
    surface: "CoverPicker",
    state: "default",
    description: "Cover Picker, a default state.",
    tags: ["components", "coverpicker", "default"],
    render: () => (
      <CoverPicker
        open
        hasCover={false}
        onClose={action("onClose")}
        onPick={action("onPick")}
        onRemove={action("onRemove")}
      />
    ),
  },
  {
    id: "components/usedinnotespopover/default",
    group: "components",
    surface: "UsedInNotesPopover",
    state: "default",
    description: "Used In Notes Popover, a default state.",
    unreachable: {
      what: "the popover listing the notes that use an attachment",
      why: "it positions itself from a live anchor element, and the story passes a detached ref so it has no coordinates",
    },
    tags: ["components", "usedinnotespopover", "default"],
    render: () => (
      <UsedInNotesPopover
        noteIds={[]}
        cache={EMPTY_CACHE}
        onJump={action("onJump")}
        onClose={action("onClose")}
        anchorRef={ANCHOR_REF}
      />
    ),
  },
  {
    id: "components/transcriptionmodal/default",
    group: "components",
    surface: "TranscriptionModal",
    state: "default",
    description: "Transcription Modal, a default state.",
    tags: ["components", "transcriptionmodal", "default"],
    render: () => (
      <TranscriptionModal
        open
        filename="recording.m4a"
        text="Transcribed text."
        onClose={action("onClose")}
      />
    ),
  },

  // ── Export and backup ────────────────────────────────────────────────────
  {
    id: "components/backupexportmodal/default",
    group: "components",
    surface: "BackupExportModal",
    state: "default",
    description: "Backup Export Modal, a default state.",
    tags: ["components", "backupexportmodal", "default"],
    fixture: "unlocked",
    render: () => (
      <BackupExportModal
        open
        onClose={action("onClose")}
        onOpenDrill={action("onOpenDrill")}
        vaultId={FIXTURE_VAULT_ID}
      />
    ),
  },
  {
    id: "components/exportegressnotice/default",
    group: "components",
    surface: "ExportEgressNotice",
    state: "default",
    description: "Export Egress Notice, a default state.",
    tags: ["components", "exportegressnotice", "default"],
    render: () => (
      <ExportEgressNotice
        open
        sentence="This will write the note to a file you choose."
        onCancel={action("onCancel")}
        onConfirm={action("onConfirm")}
      />
    ),
  },
  {
    id: "components/noteexportmodal/default",
    group: "components",
    surface: "NoteExportModal",
    state: "default",
    description: "Note Export Modal, a default state.",
    tags: ["components", "noteexportmodal", "default"],
    render: () => (
      <NoteExportModal
        open
        attachmentCount={2}
        onCancel={action("onCancel")}
        onConfirm={action("onConfirm")}
        onCopy={action("onCopy")}
      />
    ),
  },
  {
    id: "components/notepdfexportnotice/default",
    group: "components",
    surface: "NotePdfExportNotice",
    state: "default",
    description: "Note Pdf Export Notice, a default state.",
    tags: ["components", "notepdfexportnotice", "default"],
    render: () => (
      <NotePdfExportNotice
        open
        excludedAttachments={[{ id: ATTACHMENT.id, filename: ATTACHMENT.filename }]}
        onCancel={action("onCancel")}
        onConfirm={action("onConfirm")}
      />
    ),
  },
  {
    id: "components/vaultexportmodal/default",
    group: "components",
    surface: "VaultExportModal",
    state: "default",
    description: "Vault Export Modal, a default state.",
    tags: ["components", "vaultexportmodal", "default"],
    render: () => (
      <VaultExportModal open onClose={action("onClose")} folders={["notes/", "archive/"]} />
    ),
  },

  // ── Sync surfaces ────────────────────────────────────────────────────────
  {
    id: "components/betatermsconsent/default",
    group: "components",
    surface: "BetaTermsConsent",
    state: "default",
    description: "Beta Terms Consent, a default state.",
    tags: ["components", "betatermsconsent", "default"],
    render: () => (
      <BetaTermsConsent
        open
        testId="story.beta-terms"
        onAccept={action("onAccept")}
        onCancel={action("onCancel")}
      />
    ),
  },
  {
    id: "components/buildingindexstate/default",
    group: "components",
    surface: "BuildingIndexState",
    state: "default",
    description: "Building Index State, a default state.",
    tags: ["components", "buildingindexstate", "default"],
    render: () => <BuildingIndexState building />,
  },
  {
    id: "components/devicejoinqr/default",
    group: "components",
    surface: "DeviceJoinQr",
    state: "default",
    description: "Device Join Qr, a default state.",
    tags: ["components", "devicejoinqr", "default"],
    render: () => <DeviceJoinQr />,
  },
  {
    id: "components/devicemanagementpanel/default",
    group: "components",
    surface: "DeviceManagementPanel",
    state: "default",
    description: "Device Management Panel, a default state.",
    tags: ["components", "devicemanagementpanel", "default"],
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
    description: "Endpoint Config, a default state.",
    tags: ["components", "endpointconfig", "default"],
    render: () => <EndpointConfig />,
  },
  {
    id: "components/enrolldeviceform/default",
    group: "components",
    surface: "EnrollDeviceForm",
    state: "default",
    description: "Enroll Device Form, a default state.",
    tags: ["components", "enrolldeviceform", "default"],
    render: () => <EnrollDeviceForm />,
  },
  {
    id: "components/enrollphrasecredential/default",
    group: "components",
    surface: "EnrollPhraseCredential",
    state: "default",
    description: "Enroll Phrase Credential, a default state.",
    tags: ["components", "enrollphrasecredential", "default"],
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
    description: "First Run Server Step, a default state.",
    tags: ["components", "firstrunserverstep", "default"],
    render: () => (
      <FirstRunServerStep onConnected={action("onConnected")} onBack={action("onBack")} />
    ),
  },
  {
    id: "components/integrityalertbanner/default",
    group: "components",
    surface: "IntegrityAlertBanner",
    state: "default",
    description: "Integrity Alert Banner, a default state.",
    tags: ["components", "integrityalertbanner", "default"],
    render: () => <IntegrityAlertBanner present onDismiss={action("onDismiss")} />,
  },
  {
    id: "components/joindevicemodal/default",
    group: "components",
    surface: "JoinDeviceModal",
    state: "default",
    description: "Join Device Modal, a default state.",
    tags: ["components", "joindevicemodal", "default"],
    render: () => <JoinDeviceModal onCancel={action("onCancel")} onJoined={action("onJoined")} onRecovering={action("onRecovering")} />,
  },
  {
    id: "components/membernamegate/default",
    group: "components",
    surface: "MemberNameGate",
    state: "default",
    description:
      "The required name step right after an accept (myne-md/myne#851 task 8). The caller's own roster row carries no verified name, so the gate asks for one: there is no skip control, the copy says the name is how the other members will see them, and the gate writes nothing until Save, so quitting here leaves the accepted vault openable and unnamed.",
    tags: ["components", "membernamegate", "default", "onboarding"],
    fixture: {
      description: "an accepted member vault whose caller has not set a name",
      handlers: {
        "plugin:sync|sync_list_roster": () => ({
          members: [
            {
              fingerprint_hex: "aa".repeat(32),
              is_self: true,
              display_name: "",
              name_state: "absent",
              role: "member",
              version: 0,
              previous_fingerprint_hex: null,
              joined_at: 0,
              member_ed_pk_hex: "bb".repeat(32),
              member_kem_ek_hex: "cc".repeat(32),
              member_mldsa_vk_hex: "dd".repeat(48),
              continuity: null,
            },
          ],
          authority: "member",
          group_key_epoch: 3,
        }),
      },
    },
    render: () => <MemberNameGate onDone={action("onDone")} />,
  },
  {
    id: "components/memberrosterpanel/default",
    group: "components",
    surface: "MemberRosterPanel",
    state: "default",
    description: "Member Roster Panel, a default state.",
    tags: ["components", "memberrosterpanel", "default"],
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
    description: "Member Vault Unlock Card, a default state.",
    tags: ["components", "membervaultunlockcard", "default"],
    render: () => (
      <MemberVaultUnlockCard vaultId={FIXTURE_VAULT_ID} onUnlocked={action("onUnlocked")} />
    ),
  },
  {
    id: "components/reconcilebanner/default",
    group: "components",
    surface: "ReconcileBanner",
    state: "default",
    description: "Reconcile Banner, a default state.",
    tags: ["components", "reconcilebanner", "default"],
    render: () => <ReconcileBanner active onDismiss={action("onDismiss")} />,
  },
  {
    id: "components/recoverednotes/default",
    group: "components",
    surface: "RecoveredNotes",
    state: "default",
    description: "Recovered Notes, a default state.",
    tags: ["components", "recoverednotes", "default"],
    render: () => <RecoveredNotes />,
  },
  {
    id: "components/remotemergehint/default",
    group: "components",
    surface: "RemoteMergeHint",
    state: "default",
    description: "Remote Merge Hint, a default state.",
    unreachable: {
      what: "the hint shown when a peer's changes arrive mid-edit",
      why: "it appears on a sync event from the running backend, which the fake host does not emit",
    },
    tags: ["components", "remotemergehint", "default"],
    render: () => <RemoteMergeHint />,
  },
  {
    id: "components/repairresiduebanner/default",
    group: "components",
    surface: "RepairResidueBanner",
    state: "default",
    description: "Repair Residue Banner, a default state.",
    unreachable: {
      what: "the banner offering to sweep orphan residue",
      why: "it appears only when the mount scan finds residue on disk, and the fake host reports none",
    },
    tags: ["components", "repairresiduebanner", "default"],
    render: () => <RepairResidueBanner />,
  },
  {
    id: "components/syncbanners/default",
    group: "components",
    surface: "SyncBanners",
    state: "default",
    description: "Sync Banners, a default state.",
    unreachable: {
      what: "the sync status banners",
      why: "they are driven by live sync state the fake host does not emit",
    },
    tags: ["components", "syncbanners", "default"],
    fixture: "unlocked",
    render: () => <SyncBanners />,
  },
  {
    id: "components/updatebanner/default",
    group: "components",
    surface: "UpdateBanner",
    state: "default",
    description: "Update Banner, a default state.",
    unreachable: {
      what: "the desktop self-update banner",
      why: "it appears only when the updater reports an available release, which the host does not answer here",
    },
    tags: ["components", "updatebanner", "default"],
    fixture: "unlocked",
    render: () => <UpdateBanner />,
  },
  {
    id: "components/syncstatusindicator/default",
    group: "components",
    surface: "SyncStatusIndicator",
    state: "default",
    description: "Sync Status Indicator, a default state.",
    tags: ["components", "syncstatusindicator", "default"],
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
    description: "Sync Usage Block, a default state.",
    tags: ["components", "syncusageblock", "default"],
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
    description: "Tor Status Banner, a default state.",
    tags: ["components", "torstatusbanner", "default"],
    render: () => <TorStatusBanner posture="connecting" />,
  },

  // ── Toast ────────────────────────────────────────────────────────────────
  {
    id: "components/toast/default",
    group: "components",
    surface: "Toast",
    state: "default",
    description: "Toast, a default state.",
    tags: ["components", "toast", "default"],
    render: () => (
      <ToastWithStack>
        <Toast message="Saved" onDone={action("onDone")} />
      </ToastWithStack>
    ),
  },
  {
    id: "components/toaster/default",
    group: "components",
    surface: "Toaster",
    state: "default",
    description: "Toaster, a default state.",
    tags: ["components", "toaster", "default"],
    render: () => <ToasterStackDemo />,
  },

  // ── Dialog and picker surfaces ───────────────────────────────────────────
  {
    id: "components/commandpalette/default",
    group: "components",
    surface: "CommandPalette",
    state: "default",
    description: "Command Palette, a default state.",
    tags: ["components", "commandpalette", "default"],
    fixture: UNLOCKED_FIXTURE,
    render: () => (
      <SidebarStateProvider>
        <CommandPalette open onClose={action("onClose")} ctx={COMMAND_CONTEXT} />
      </SidebarStateProvider>
    ),
  },
  {
    id: "components/quickpicker/default",
    group: "components",
    surface: "QuickPicker",
    state: "default",
    description: "Quick Picker, a default state.",
    tags: ["components", "quickpicker", "default"],
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
        onPick={action("onPick")}
        onClose={action("onClose")}
      />
    ),
  },
  {
    id: "components/pairingdialog/default",
    group: "components",
    surface: "PairingDialog",
    state: "default",
    description: "Pairing Dialog, a default state.",
    tags: ["components", "pairingdialog", "default"],
    // Without this the dialog answered the fake host's benign default, so the
    // challenge box rendered EMPTY and its height collapsed to the padding: the
    // story showed a shape the app never produces (myne-md/myne#845).
    fixture: {
      description: "a clipper pairing session waiting for the user to compare a code",
      handlers: {
        "plugin:clipper-pairing|pairing_pending": () => ({
          extension_id: "sample-extension-id",
          challenge: "004291",
          request_id: null,
        }),
      },
    },
    render: () => <PairingDialog />,
  },
  {
    id: "components/themeinstalldialog/default",
    group: "components",
    surface: "ThemeInstallDialog",
    state: "default",
    description: "Theme Install Dialog, a default state.",
    unreachable: {
      what: "the install confirmation for a theme link",
      why: "it renders only when the app receives a custom-theme deep link from the OS, which the catalogue cannot fire",
    },
    tags: ["components", "themeinstalldialog", "default"],
    render: () => <ThemeInstallDialog />,
  },
  {
    id: "components/meetingaidialog/default",
    group: "components",
    surface: "MeetingAiDialog",
    state: "default",
    description: "Meeting Ai Dialog, a default state.",
    tags: ["components", "meetingaidialog", "default"],
    render: () => {
      // The dialog renders nothing until an offer exists; publish one so the
      // story shows the section picker.
      offerMeetingAi("story-note", "A short meeting transcript.");
      return <MeetingAiDialog />;
    },
  },
  {
    id: "components/identitysetupdialog/default",
    group: "components",
    surface: "IdentitySetupDialog",
    state: "default",
    description: "Identity Setup Dialog, a default state.",
    tags: ["components", "identitysetupdialog", "default"],
    fixture: "unlocked",
    render: () => <IdentitySetupDialog open onClose={action("onClose")} />,
  },
  {
    id: "components/newnotefromtemplatemodal/default",
    group: "components",
    surface: "NewNoteFromTemplateModal",
    state: "default",
    description: "New Note From Template Modal, a default state.",
    tags: ["components", "newnotefromtemplatemodal", "default"],
    render: () => (
      <NewNoteFromTemplateModal
        open
        onClose={action("onClose")}
        onBlankNote={action("onBlankNote")}
        onCreateFromTemplate={action("onCreateFromTemplate")}
      />
    ),
  },
  {
    id: "components/templatesmanager/default",
    group: "components",
    surface: "TemplatesManager",
    state: "default",
    description: "Templates Manager, a default state.",
    tags: ["components", "templatesmanager", "default"],
    fixture: "unlocked",
    render: () => (
      <TemplatesManager open onClose={action("onClose")} onOpenNote={action("onOpenNote")} />
    ),
  },
  {
    id: "components/settingsmodal/default",
    // A `role="switch"` whose value is unresolved: this story does not answer
    // the command that drives the toggle, so `checked` is not a boolean and
    // `aria-checked` is missing. The catalogue is showing a frame the app
    // passes through before its read resolves, never its resting state ,
    // answering the command in the fixture is the fix (myne-md/myne#845).
    a11y: "todo",
    group: "components",
    surface: "SettingsModal",
    state: "default",
    description: "Settings Modal, a default state.",
    tags: ["components", "settingsmodal", "default"],
    fixture: "unlocked",
    render: () => (
      <SettingsModal
        vaultId={FIXTURE_VAULT_ID}
        open
        onClose={action("onClose")}
        onDeleteVaultSuccess={action("onDeleteVaultSuccess")}
      />
    ),
  },
  {
    id: "components/vaultswitcher/default",
    group: "components",
    surface: "VaultSwitcher",
    state: "default",
    description: "Vault Switcher, a default state.",
    tags: ["components", "vaultswitcher", "default"],
    fixture: "unlocked",
    render: () => (
      <VaultSwitcher
        onSwitchVault={action("onSwitchVault")}
        onCreateAnother={action("onCreateAnother")}
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
    description: "Blocking Progress Step, a default state.",
    tags: ["components", "blockingprogressstep", "default"],
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
    description: "Import Plain File Button, a default state.",
    tags: ["components", "importplainfilebutton", "default"],
    render: () => <ImportPlainFileButton handle={1} />,
  },
  {
    id: "components/quickunlockentry/default",
    group: "components",
    surface: "QuickUnlockEntry",
    state: "default",
    description: "Quick Unlock Entry, a default state.",
    tags: ["components", "quickunlockentry", "default"],
    fixture: "locked",
    render: () => (
      <QuickUnlockEntry
        vaultId={FIXTURE_VAULT_ID}
        method="pin"
        onUnlocked={action("onUnlocked")}
        onUnavailable={action("onUnavailable")}
      />
    ),
  },
  {
    id: "components/secretphrasereveal/default",
    group: "components",
    surface: "SecretPhraseReveal",
    state: "default",
    description: "Secret Phrase Reveal, a default state.",
    tags: ["components", "secretphrasereveal", "default"],
    render: () => (
      <SecretPhraseReveal
        phrase={PHRASE}
        revealed
        onReveal={action("onReveal")}
        onHide={action("onHide")}
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
    description: "Web No Account, a default state.",
    tags: ["components", "webnoaccount", "default"],
    render: () => <WebNoAccount wall="no-account" />,
  },

  // ── Vault-creation flow steps ────────────────────────────────────────────
  {
    id: "components/briefingstep/default",
    group: "components",
    surface: "BriefingStep",
    state: "default",
    description: "Briefing Step, a default state.",
    tags: ["components", "briefingstep", "default"],
    render: () => <BriefingStep onBack={action("onBack")} onContinue={action("onContinue")} />,
  },
  {
    id: "components/passwordstep/default",
    group: "components",
    surface: "PasswordStep",
    state: "default",
    description: "Password Step, a default state.",
    tags: ["components", "passwordstep", "default"],
    render: () => <PasswordStep error={null} onBack={action("onBack")} onSubmit={action("onSubmit")} />,
  },
  {
    id: "components/confirmstep/default",
    group: "components",
    surface: "ConfirmStep",
    state: "default",
    description: "Confirm Step, a default state.",
    tags: ["components", "confirmstep", "default"],
    render: () => (
      <ConfirmStep
        phrase={[...PHRASE]}
        positions={[1, 9, 17, 24]}
        inputs={{}}
        committing={false}
        error={null}
        dispatch={action("dispatch")}
      />
    ),
  },
  {
    id: "components/encryptingstep/default",
    group: "components",
    surface: "EncryptingStep",
    state: "default",
    description: "Encrypting Step, a default state.",
    tags: ["components", "encryptingstep", "default"],
    render: () => <EncryptingStep />,
  },
  {
    id: "components/sessionloststep/default",
    group: "components",
    surface: "SessionLostStep",
    state: "default",
    description: "Session Lost Step, a default state.",
    tags: ["components", "sessionloststep", "default"],
    render: () => (
      <SessionLostStep
        error={{
          title: "Session ended",
          body: "The creation session was lost. Start again.",
          primaryAction: "restart",
          displayMode: "dedicated",
        }}
        dispatch={action("dispatch")}
      />
    ),
  },
  {
    id: "components/provisioningstep/default",
    group: "components",
    surface: "ProvisioningStep",
    state: "default",
    description: "Provisioning Step, a default state.",
    tags: ["components", "provisioningstep", "default"],
    render: () => <ProvisioningStep />,
  },
  {
    id: "components/readystep/default",
    group: "components",
    surface: "ReadyStep",
    state: "default",
    description: "Ready Step, a default state.",
    tags: ["components", "readystep", "default"],
    render: () => <ReadyStep onDone={action("onDone")} vaultId={FIXTURE_VAULT_ID} />,
  },
  {
    id: "components/readylocalartefacts/default",
    group: "components",
    surface: "ReadyLocalArtefacts",
    state: "default",
    description: "Ready Local Artefacts, a default state.",
    tags: ["components", "readylocalartefacts", "default"],
    render: () => <ReadyLocalArtefacts pending={false} vaultId={FIXTURE_VAULT_ID} />,
  },

  // ── Vault-recover flow steps ─────────────────────────────────────────────
  {
    id: "components/recoveryselectstep/default",
    group: "components",
    surface: "RecoverySelectStep",
    state: "default",
    description: "Recovery Select Step, a default state.",
    tags: ["components", "recoveryselectstep", "default"],
    fixture: "locked",
    render: () => (
      <RecoverySelectStep onVaultSelected={action("onVaultSelected")} onCancel={action("onCancel")} />
    ),
  },
  {
    id: "components/phraseentrystep/default",
    group: "components",
    surface: "PhraseEntryStep",
    state: "default",
    description: "Phrase Entry Step, a default state.",
    tags: ["components", "phraseentrystep", "default"],
    render: () => (
      <PhraseEntryStep
        state={RECOVER_PHRASE_ENTRY}
        dispatch={action("dispatch")}
        onCancel={action("onCancel")}
        onSubmitNormalizedPhrase={action("onSubmitNormalizedPhrase")}
      />
    ),
  },
  {
    id: "components/decryptingstep/default",
    group: "components",
    surface: "DecryptingStep",
    state: "default",
    description: "Decrypting Step, a default state.",
    tags: ["components", "decryptingstep", "default"],
    render: () => <DecryptingStep />,
  },
  {
    id: "components/passwordresetstep/default",
    group: "components",
    surface: "PasswordResetStep",
    state: "default",
    description: "Password Reset Step, a default state.",
    tags: ["components", "passwordresetstep", "default"],
    render: () => (
      <PasswordResetStep
        state={RECOVER_PASSWORD_RESET}
        dispatch={action("dispatch")}
        onCompleteSuccess={action("onCompleteSuccess")}
        onRecoverAnother={action("onRecoverAnother")}
      />
    ),
  },

  // ── Screens ──────────────────────────────────────────────────────────────
  {
    id: "components/accountbootstrap/default",
    group: "components",
    surface: "AccountBootstrap",
    state: "default",
    description: "Account Bootstrap, a default state.",
    tags: ["components", "accountbootstrap", "default"],
    fixture: "no-vault",
    render: () => <AccountBootstrap onBootstrapped={action("onBootstrapped")} />,
  },
  {
    id: "components/agentreview/default",
    group: "components",
    surface: "AgentReview",
    state: "default",
    description: "Agent Review, a default state.",
    tags: ["components", "agentreview", "default"],
    render: () => (
      <AgentReview
        onClose={action("onClose")}
        titleOf={() => null}
        folderOf={() => null}
      />
    ),
  },
  {
    id: "components/agentreview/clamped-summary",
    group: "components",
    surface: "AgentReview",
    state: "clamped-summary",
    description:
      "A settled run whose summary is long: three lines and a disclosure above the diff, so the diff is what the screen is about. The summary stays on screen rather than being hidden, because a refusal has to be able to contradict it (myne-md/myne#848).",
    tags: ["components", "agentreview", "review", "summary", "clamp"],
    render: () => <SeededReview />,
  },
  {
    id: "components/agentreview/refusals-above-the-claim",
    group: "components",
    surface: "AgentReview",
    state: "refusals-above-the-claim",
    description:
      "An apply that refused one of the moves: the host's refusal is pinned ABOVE the model's summary, with a count, so the claim cannot be read in the order that flatters it (myne-md/myne#848).",
    tags: ["components", "agentreview", "review", "refusal", "applied"],
    render: () => <SeededReview refusals />,
  },
  {
    id: "components/editor/default",
    group: "components",
    surface: "Editor",
    state: "default",
    description: "Editor, a default state.",
    fullBleed: true,
    tags: ["components", "editor", "default"],
    fixture: UNLOCKED_FIXTURE,
    render: () => (
      <WorkspaceProvider>
        <SidebarStateProvider>
          <Editor onRestoreBackup={action("onRestoreBackup")} onDeleteVaultSuccess={action("onDeleteVaultSuccess")} />
        </SidebarStateProvider>
      </WorkspaceProvider>
    ),
  },
  {
    id: "components/identityhome/default",
    group: "components",
    surface: "IdentityHome",
    state: "default",
    description: "Identity Home, a default state.",
    tags: ["components", "identityhome", "default"],
    fixture: "unlocked",
    render: () => (
      <IdentityHome
        personIdHex={null}
        identityCode={null}
        onCreateVault={action("onCreateVault")}
        onAccepted={action("onAccepted")}
        onForgotten={action("onForgotten")}
      />
    ),
  },
  {
    id: "components/restorebackup/default",
    group: "components",
    surface: "RestoreBackup",
    state: "default",
    description: "Restore Backup, a default state.",
    tags: ["components", "restorebackup", "default"],
    fixture: "no-vault",
    render: () => <RestoreBackup entry="welcome" onExit={action("onExit")} />,
  },
  {
    id: "components/unlock/default",
    group: "components",
    surface: "Unlock",
    state: "default",
    description: "Unlock, a default state.",
    tags: ["components", "unlock", "default"],
    fixture: "locked",
    render: () => (
      <Unlock
        initialStatus={{ kind: "Exists" }}
        onUnlocked={action("onUnlocked")}
        onStartRecovery={action("onStartRecovery")}
        onResumeRecovery={action("onResumeRecovery")}
        onDeleteVaultSuccess={action("onDeleteVaultSuccess")}
        onRestoreBackup={action("onRestoreBackup")}
      />
    ),
  },
  {
    id: "components/vaultpicker/default",
    group: "components",
    surface: "VaultPicker",
    state: "default",
    description: "Vault Picker, a default state.",
    tags: ["components", "vaultpicker", "default"],
    fixture: "locked",
    render: () => (
      <VaultPicker
        onSelect={action("onSelect")}
        onRestoreBackup={action("onRestoreBackup")}
        onCreateAnother={action("onCreateAnother")}
        onJoinDevice={action("onJoinDevice")}
      />
    ),
  },
  {
    id: "components/vaultrecover/default",
    group: "components",
    surface: "VaultRecover",
    state: "default",
    description: "Vault Recover, a default state.",
    tags: ["components", "vaultrecover", "default"],
    fixture: "no-vault",
    render: () => (
      <VaultRecover
        initialSubStep="phrase-entry"
        onCancel={action("onCancel")}
        onCompleteSuccess={action("onCompleteSuccess")}
        onDeleteVaultSuccess={action("onDeleteVaultSuccess")}
      />
    ),
  },
  {
    id: "components/createvault/default",
    group: "components",
    surface: "CreateVault",
    state: "default",
    description: "Create Vault, a default state.",
    tags: ["components", "createvault", "default"],
    fixture: "no-vault",
    render: () => (
      <CreateVault
        onBack={action("onBack")}
        onAutoUnlockSuccess={action("onAutoUnlockSuccess")}
        onAutoUnlockFailed={action("onAutoUnlockFailed")}
      />
    ),
  },
  {
    id: "components/authshell/default",
    group: "components",
    surface: "AuthShell",
    state: "default",
    description: "Auth Shell, a default state.",
    tags: ["components", "authshell", "default"],
    render: () => (
      <AuthShell>
        <div
          style={{
            padding: "var(--space-5)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-4)",
          }}
        >
          <h1 style={{ margin: 0, fontSize: "var(--text-lg)", color: "var(--fg-1)" }}>
            Unlock your vault
          </h1>
          <p style={{ margin: 0, color: "var(--fg-2)" }}>
            Your password is never sent anywhere; it unwraps the key on this device.
          </p>
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button variant="primary" onClick={action("onUnlock")}>
              Unlock
            </Button>
          </div>
        </div>
      </AuthShell>
    ),
  },
  {
    id: "components/namestep/default",
    group: "components",
    surface: "NameStep",
    state: "default",
    description: "Name Step, a default state.",
    tags: ["components", "namestep", "default"],
    render: () => (
      <NameStep value="" onChange={action("onChange")} onSubmit={action("onSubmit")} onBack={action("onBack")} />
    ),
  },
  {
    id: "components/kitstep/default",
    group: "components",
    surface: "KitStep",
    state: "default",
    description: "Kit Step, a default state.",
    tags: ["components", "kitstep", "default"],
    render: () => (
      <KitStep
        phrase={[...PHRASE]}
        accountNumber="MY-ABCD-EFGH-JKMN-PQRS-TVWX"
        vaultName="My vault"
        revealed
        dispatch={action("dispatch")}
      />
    ),
  },
  {
    id: "components/choicelist/default",
    group: "components",
    surface: "ChoiceList",
    state: "default",
    description: "Choice List, a default state.",
    tags: ["components", "choicelist", "default"],
    render: () => (
      <ChoiceRow
        title="Sync this vault"
        body="Keep an encrypted copy on the server."
        action={<span>Choose</span>}
        last
      />
    ),
  },
  {
    id: "components/phrasegrid/default",
    group: "components",
    surface: "PhraseGrid",
    state: "default",
    description: "Phrase Grid, a default state.",
    tags: ["components", "phrasegrid", "default"],
    render: () => (
      <PhraseGrid
        phrase={[...PHRASE]}
        revealed
        onReveal={action("onReveal")}
        onHide={action("onHide")}
        testIdPrefix="stories.phrase"
      />
    ),
  },
  {
    id: "components/phrasetypeback/default",
    group: "components",
    surface: "PhraseTypeBack",
    state: "default",
    description:
      "The recovery-phrase type-back challenge the vault and identity ceremonies share: four labelled fields in a 2x2 grid, one per drawn word position. The frame shows one answered field, a WRONG answer with its inline mismatch line beneath the input, and the remaining fields empty.",
    tags: ["components", "phrasetypeback", "default"],
    // Three states in one frame on purpose: an answered field, a WRONG answer
    // (the inline mismatch), and one still empty.
    render: () => (
      <PhraseTypeBack
        phrase={PHRASE}
        positions={[2, 11, 14, 21]}
        values={{ 2: PHRASE[1], 11: "wrong", 21: "" }}
        onChange={action("onChange")}
        labelFor={(pos) => `Word #${pos}`}
        mismatchFor={(pos) => `That does not match word #${pos}.`}
        testIdPrefix="stories.confirm"
      />
    ),
  },
  {
    id: "components/secretdisplaycaveats/default",
    group: "components",
    surface: "SecretDisplayCaveats",
    state: "default",
    description: "Secret Display Caveats, a default state.",
    unreachable: {
      what: "the platform caveats shown beside a once-only secret",
      why: "both caveats are conditional on a capability being ABSENT, and on the desktop capability set both are present",
    },
    tags: ["components", "secretdisplaycaveats", "default"],
    render: () => <SecretDisplayCaveats testIdPrefix="stories.secret" />,
  },
  {
    id: "components/devicejoinqrdialog/default",
    group: "components",
    surface: "DeviceJoinQrDialog",
    state: "default",
    description: "Device Join Qr Dialog, a default state.",
    tags: ["components", "devicejoinqrdialog", "default"],
    render: () => <DeviceJoinQrDialog open onClose={action("onClose")} />,
  },
  {
    id: "components/personidentityunlock/default",
    group: "components",
    surface: "PersonIdentityUnlock",
    state: "default",
    description: "Person Identity Unlock, a default state.",
    tags: ["components", "personidentityunlock", "default"],
    render: () => <PersonIdentityUnlock open onOpenChange={action("onOpenChange")} />,
  },
];
