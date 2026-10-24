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
  failRun,
  currentRunEpoch,
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
import { DeviceAttributionPanel } from "@app/components/sync/DeviceAttributionPanel";
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
import { InvitesDialog } from "@app/components/sync/InvitesDialog";
import { PersonIdentityUnlock } from "@app/components/sync/PersonIdentityUnlock";
import { PersonPhraseUnlock } from "@app/components/PersonPhraseUnlock";
import { VaultFormatUpgrade } from "@app/components/settings/VaultFormatUpgrade";
import { EndpointConfig } from "@app/components/sync/EndpointConfig";
import { EnrollDeviceForm } from "@app/components/sync/EnrollDeviceForm";
import { PhraseEntryGrid } from "@app/components/PhraseEntryGrid";
import { ErrorBanner } from "@app/components/ErrorBanner";
import { ExportEgressNotice } from "@app/components/export/ExportEgressNotice";
import { FailClosedError } from "@app/components/FailClosedError";
import { Icon } from "@app/components/primitives/Icon";
import { IdentityHome } from "@app/screens/IdentityHome";
import { AcceptInviteWizard, JoinVaultWizard } from "@app/components/sync/InviteWizard";
import { IdentitySetupDialog } from "@app/components/IdentitySetupDialog";
import { IdentitySetupPanel } from "@app/components/IdentitySetupPanel";
import { ImportPlainFileButton } from "@app/components/plain/ImportPlainFileButton";
import { IntegrityAlertBanner } from "@app/components/sync/IntegrityAlertBanner";
import { JoinDeviceModal } from "@app/components/sync/JoinDeviceModal";
import { Keycaps } from "@app/components/primitives/Keycaps";
import { MemberNameGate } from "@app/components/sync/MemberNameGate";
import { MemberRosterPanel } from "@app/components/sync/MemberRosterPanel";
import { PersonRegisterForm } from "@app/components/sync/PersonRegisterForm";
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
import { UpdateNotice } from "@app/components/update/UpdateNotice";
import { UpdatingScreen } from "@app/screens/UpdatingScreen";
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

/**
 * Synthetic release notes for the update-notice stories. The field is prose of
 * unknown length (the host passes the updater manifest's own body through), so
 * the sample is deliberately longer than one line: the notice clamps it, and a
 * one-line fixture would hide whether the clamp works.
 */
const UPDATE_NOTES = [
  "Attachments now sync in both directions, so a file added on a phone reaches every other device.",
  "The task panel keeps its scroll position when you switch notes.",
  "Fix: a note opened from a wikilink no longer steals the rename field on first render.",
].join("\n");

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
function SeededReview({
  openRow = false,
  failure = false,
}: {
  openRow?: boolean;
  failure?: boolean;
}) {
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
              // A diff rather than a move, because this row is the one the
              // `row-opened` story discloses and a move's detail is a folder
              // pair: a story describing a diff that renders a pair is the same
              // defect as describing a dialog that is a card (myne-md/myne#894,
              // from review). The text is plainly synthetic, which is also what
              // this fixture is for.
              kind: "replace",
              anchor: "The draft lists three dates and no owners.",
              replacement: "The draft lists three dates, each with an owner.",
            },
            {
              noteId: "n2",
              kind: "move",
              anchor: "",
              replacement: "01 - PROJECTS/",
            },
          ],
          newNotes: [],
          // The model's own claim. The card does not render it (it is the
          // turn's prose), so its length only matters to the turn stories.
          summary:
            "Analyzed all 23 notes in 00 - INBOX/ and rehomed each according to your PARA structure. ".repeat(
              3,
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
    if (failure) {
      // The failed arm: the headline names the cause, and there is deliberately no
      // second dismissing control beside it (myne-md/myne#894).
      failRun("Writing the changes did not finish.");
    }
    setReady(true);
    return () => clearAgentForLock();
  }, [failure]);

  // The opened-row state is an INTERACTION, so it is replayed rather than passed
  // in: a row's own text (a diff, or a move's folder pair) is behind its chevron,
  // and a story that asserted the closed shape only would depict a card whose
  // detail nobody has looked at.
  useEffect(() => {
    if (!ready || !openRow) return;
    const toggle = document.querySelector<HTMLElement>(
      '[data-testid="agentReview.toggleDiff"]',
    );
    toggle?.click();
  }, [ready, openRow]);
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
    description:
      "A polite status line that is announced to assistive tech and shown as a small caption, such as \"Copied to clipboard\". Look for the message to be a live-region announcement rather than only a thing on screen.",
    tags: ["components", "action-status", "live-region", "announce", "feedback", "confirmation"],
    render: () => <ActionStatus message="Copied to clipboard" />,
  },
  {
    id: "components/actionstatus/visually-hidden",
    group: "components",
    surface: "ActionStatus",
    state: "visually-hidden",
    description:
      "The same status line with no visible element at all, for a confirmation the sighted user already gets from elsewhere; only the live region announces it.",
    tags: ["components", "action-status", "visually-hidden", "sr-only", "live-region", "a11y"],
    render: () => <ActionStatus message="Copied to clipboard" visuallyHidden />,
  },
  {
    id: "components/answeredbyindicator/default",
    group: "components",
    surface: "AnsweredByIndicator",
    state: "default",
    description:
      "The small marker on an AI turn naming which provider answered it, here the local runtime. It exists so a reader can tell an on-device answer from a remote one at a glance.",
    tags: ["components", "ai", "answered-by", "provider", "local-runtime", "provenance"],
    render: () => (
      <AnsweredByIndicator answeredBy={{ kind: "local-runtime", name: "llama" }} />
    ),
  },
  {
    id: "components/errorbanner/default",
    group: "components",
    surface: "ErrorBanner",
    state: "default",
    description:
      "The shared inline error surface: a title, a body that says nothing was changed on disk, and one primary action, rendered here in its inline mode. The dedicated mode is for a failure that owns the whole screen.",
    tags: ["components", "error", "banner", "inline", "retry", "failure"],
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
    description:
      "The fail-closed card for a React stage and a Rust slot that disagree: one reason, one call to action and no detail. The CTA is a LOCK rather than an exit, because the safe answer to \"the app state is untrustworthy\" is to drop the keys.",
    tags: ["components", "fail-closed", "error", "invalid-state", "lock", "security"],
    render: () => (
      <FailClosedError reason={{ kind: "invalid-state" }} onCtaClick={action("onCtaClick")} />
    ),
  },
  {
    id: "components/suspicionbanner/default",
    group: "components",
    surface: "SuspicionBanner",
    state: "default",
    description:
      "The informational banner shown on the unlock screen after the vault metadata was changed outside this session. Look for the honest \"we noticed, here is what it means\" tone rather than an alarm.",
    tags: ["components", "banner", "suspicion", "vault-meta", "relock", "informational"],
    render: () => <SuspicionBanner reason="vault-meta-changed-externally" />,
  },
  {
    id: "components/skiptocontent/default",
    group: "components",
    surface: "SkipToContent",
    state: "default",
    description:
      "The first Tab stop on every screen: a link that jumps past the chrome to the content region. It is visible only while focused, which is exactly the point.",
    tags: ["components", "skip-link", "a11y", "keyboard", "focus", "landmark"],
    render: () => <SkipToContent />,
  },
  {
    id: "components/rooterrorboundary/default",
    group: "components",
    surface: "RootErrorBoundary",
    state: "default",
    description:
      "The root error boundary around a healthy subtree, rendering its children unchanged. Its fallback is the fail-closed card that replaces the whole workspace when a render throws during boot.",
    tags: ["components", "error-boundary", "react", "fallback", "fail-closed", "boot"],
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
    description:
      "The escape control shown while screen-capture protection is on. It renders in response to an OS screen-capture event, which the catalogue cannot fire, so the stage shows that reason instead of the control.",
    unreachable: {
      what: "the escape control shown while screen-capture protection is on",
      why: "it renders in response to an OS screen-capture event, which the catalogue cannot fire",
    },
    tags: ["components", "screen-capture", "privacy", "escape", "unreachable", "macos"],
    render: () => <ScreenCaptureEscape />,
  },
  {
    id: "components/webreloadnotice/default",
    group: "components",
    surface: "WebReloadNotice",
    state: "default",
    description:
      "The web client's notice that the page is about to reload, shown where a flow cannot continue in place. Look for it explaining what happens to the open vault rather than just reloading.",
    tags: ["components", "web", "reload", "notice", "single-tab", "navigation"],
    render: () => <WebReloadNotice />,
  },

  // ── Primitives that live under components/primitives/ ────────────────────
  {
    id: "components/centeredcard/default",
    group: "components",
    surface: "CenteredCard",
    state: "default",
    description:
      "The centered-card layout the auth and takeover screens share: content in a narrow column on the app's ground, sized to the viewport. It is a layout primitive, so its subject is the framing rather than the copy inside.",
    tags: ["components", "layout", "centered-card", "auth", "framing", "primitive"],
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
    description:
      "The single icon primitive: one glyph from the registry at a named size, with a frozen inner-markup object so a re-render cannot replace the node under a pointer. Renders the settings glyph.",
    tags: ["components", "icon", "glyph", "registry", "primitive"],
    render: () => <Icon name="settings" />,
  },
  {
    id: "components/keycaps/default",
    group: "components",
    surface: "Keycaps",
    state: "default",
    description:
      "A keyboard chord rendered as keycaps (`Mod+K`), used wherever a shortcut is named. It splits the chord into individual keys and draws each as a cap.",
    tags: ["components", "keycaps", "keyboard", "shortcut", "chord", "primitive"],
    render: () => <Keycaps chord="Mod+K" />,
  },
  {
    id: "components/modalshell/default",
    group: "components",
    surface: "ModalShell",
    state: "default",
    description:
      "The shared modal chrome: backdrop, titled panel, close control and dismissal by Esc, the backdrop or the close button. The caller supplies the body and its padding; the body here is a note saying so.",
    tags: ["components", "modal", "shell", "dialog", "backdrop", "focus-trap"],
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
    description:
      "The Myne mark, drawn at a requested size: the brand glyph that opens the welcome screen and the auth shell. Look for it staying crisp at both small and large sizes.",
    tags: ["components", "brand", "mark", "logo", "glyph"],
    render: () => <MyneMark size={48} />,
  },
  {
    id: "components/paneltoggleglyph/default",
    group: "components",
    surface: "PanelToggleGlyph",
    state: "default",
    description:
      "The sidebar collapse/expand glyph, pointing by `side` and flipping with `collapsed`. A static mount cannot force a pseudo-class, so this is the resting direction of the chevron.",
    tags: ["components", "glyph", "sidebar", "collapse", "toggle", "chrome"],
    render: () => <PanelToggleGlyph side="left" collapsed={false} />,
  },
  {
    id: "components/resizehandle/default",
    group: "components",
    surface: "ResizeHandle",
    state: "default",
    description:
      "The drag handle that resizes a sidebar: dragging changes the width between a min and a max, and it also owns the collapse toggle. Look for a labelled, keyboard-reachable handle rather than a bare divider.",
    tags: ["components", "resize", "drag", "sidebar", "handle", "layout"],
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
    description:
      "The app's own scroller: a native scroll region paired with the custom indicator, so the bar can hide when idle rather than follow the OS always-visible setting. The content-at-end story covers the gutter case.",
    tags: ["components", "scroll-area", "overflow", "indicator", "scrollbar", "primitive"],
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
    description:
      "The searchable select: a trigger and a portal menu with its own filter field, for option sets too long for `Select`. It is shared with the display-language and spell-language pickers.",
    tags: ["components", "select", "searchable", "dropdown", "filter", "primitive"],
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
    description:
      "A theme's palette as a small five-colour chiplet: the preview the custom-themes list draws per row so a theme is recognisable before it is applied.",
    tags: ["components", "theme", "palette", "preview", "chiplet", "custom-theme"],
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
    description:
      "The destructive-action banner: a red-tinted frame around copy stating what cannot be undone. Look for the tone to warn without alarming, and the copy to name the real loss.",
    tags: ["components", "banner", "destructive", "danger", "warning", "irreversible"],
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
    description:
      "The shared password field: a labelled input with a reveal toggle and an optional strength meter. Look for the label to be associated with the input, which is what makes it announce as a password field rather than a bare text box.",
    tags: ["components", "password", "input", "reveal", "auth", "form"],
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
    description:
      "The password-strength meter: a score and an optional warning line from zxcvbn. This frame is a mid score carrying a warning, which is the case a bar alone gets wrong.",
    tags: ["components", "password", "strength", "zxcvbn", "meter", "warning"],
    render: () => <PasswordStrength score={3} warning="A common word" />,
  },
  {
    id: "components/passwordcreateform/default",
    group: "components",
    surface: "PasswordCreateForm",
    state: "default",
    description:
      "The two-field password form (new plus confirm) used by vault creation and recovery, under the shared length and score gates. Look for both fields to be announced separately rather than as one opaque block.",
    tags: ["components", "password", "form", "create", "confirm", "validation"],
    render: () => <PasswordCreateForm submitLabel="Continue" onSubmit={action("onSubmit")} />,
  },
  {
    id: "components/passwordchangeform/default",
    group: "components",
    surface: "PasswordChangeForm",
    state: "default",
    description:
      "The three-field change-password form (current, new, confirm) rendered in Settings → Vault. Its submit path is the only Argon2id-bound IPC here, which is why the modal gates dismissal while it runs.",
    tags: ["components", "password", "form", "change", "account", "async"],
    render: () => <PasswordChangeForm onSubmit={action("onSubmit")} onCancel={action("onCancel")} />,
  },
  {
    id: "components/deletevaultconfirmform/default",
    group: "components",
    surface: "DeleteVaultConfirmForm",
    state: "default",
    description:
      "The delete-vault confirmation: the destructive warning plus the typed confirmation, with a `partialFailContext` slot for the state where deletion half-succeeded. This frame is the clean first attempt.",
    tags: ["components", "delete", "vault", "confirm", "destructive", "partial-failure"],
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
    description:
      "The progress line for attachment sync: how many bodies are in flight and their bytes, rendered globally rather than per attachment so the reader sees the whole queue.",
    tags: ["components", "attachments", "sync", "progress", "upload", "indicator"],
    render: () => <AttachmentSyncProgress />,
  },
  {
    id: "components/attachmentthumbnail/default",
    group: "components",
    surface: "AttachmentThumbnail",
    state: "default",
    description:
      "An attachment's thumbnail: the decoded image at a requested box size, with its filename. An attachment whose bytes cannot decode shows the file treatment rather than a broken image.",
    tags: ["components", "attachments", "thumbnail", "image", "preview"],
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
    description:
      "The attachments library: every stored attachment with its type and size, searchable, with the per-item actions. Mounted inside the sidebar provider because it reads the live note cache for \"used in\" counts.",
    tags: ["components", "attachments", "library", "browse", "search", "files"],
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
    description:
      "The dialog that offers to delete attachments nothing references, returning how many were deleted, skipped and the bytes reclaimed. Look for it saying what it will spare, not only what it will remove.",
    tags: ["components", "attachments", "cleanup", "orphans", "dialog", "storage"],
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
    description:
      "The confirmation for deleting one attachment, listing the notes that reference it so the user sees the consequence before the press. Here there are none, which is the clean case.",
    tags: ["components", "attachments", "delete", "references", "confirm", "destructive"],
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
    description:
      "The picker for a note's banner cover, open on a note without one: choose an attachment as the cover, or remove. Look for the empty state to offer the pick rather than showing a blank frame.",
    tags: ["components", "cover", "picker", "banner", "note", "attachments"],
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
    description:
      "The popover listing which notes use an attachment. It positions itself from a live anchor element, and the story passes a detached ref so it has no coordinates, which is why the stage shows that reason instead of a misplaced panel.",
    unreachable: {
      what: "the popover listing the notes that use an attachment",
      why: "it positions itself from a live anchor element, and the story passes a detached ref so it has no coordinates",
    },
    tags: ["components", "attachments", "backlinks", "popover", "unreachable", "anchor"],
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
    description:
      "The modal showing a transcript for one audio attachment: the filename, the extracted text and its close control. Look for the text to be selectable for copying.",
    tags: ["components", "transcription", "audio", "text", "modal", "attachments"],
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
    description:
      "The backup modal: write an encrypted `.myne-backup`, with the recovery drill offered beside it. Mounted with an unlocked-vault fixture because the export path reads the vault.",
    tags: ["components", "backup", "export", "modal", "drill", "vault"],
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
    description:
      "The confirmation shown before content is written outside the vault, carrying the caller's own sentence naming exactly what leaves and where it goes. It exists so no export is silent about its destination.",
    tags: ["components", "export", "egress", "notice", "consent", "privacy"],
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
    description:
      "The export dialog for a single note: format and options, with the attachment count so the user knows whether embedded files travel with it.",
    tags: ["components", "export", "note", "markdown", "attachments", "dialog"],
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
    description:
      "The notice shown before a note is exported to PDF. A PDF cannot carry the embedded files, so the ones that will be left behind are listed by name rather than dropped silently.",
    tags: ["components", "export", "pdf", "attachments", "notice", "data-loss"],
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
    description:
      "The whole-vault export dialog: choose the folders to include and write decrypted markdown to a destination. Look for the folder filter and the plaintext-destination warning.",
    tags: ["components", "export", "vault", "markdown", "plaintext", "folders"],
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
    description:
      "The one-time beta terms consent shown before sync is enrolled, carrying the terms and the accept/cancel pair. Look for acceptance to require the text to have been presented.",
    tags: ["components", "sync", "beta", "terms", "consent", "legal"],
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
    description:
      "The cold-start state while the sync index is being built: a blocking progress surface with the reason a first sync takes longer than every one after it.",
    tags: ["components", "sync", "cold-start", "index", "progress", "blocking"],
    render: () => <BuildingIndexState building />,
  },
  {
    id: "components/deviceattributionpanel/default",
    group: "components",
    surface: "DeviceAttributionPanel",
    state: "default",
    description:
      "The device-attribution panel on a shared vault: one device claimed by a named member, one claimed by a member with no name (which shows the fingerprint instead), this device's own row, and one device id whose row did not verify, rendered as a bare id under a marker. Look for verification to be visible per row.",
    tags: ["components", "device-attribution", "b2b", "member", "devices", "fingerprint", "verification"],
    fixture: {
      description:
        "shared vault whose device-binding map holds three verified rows and one id that did not verify",
      handlers: {
        "plugin:device-binding|device_bindings_list": () => ({
          rows: [
            {
              device_id_hex: "aa".repeat(16),
              person_fingerprint_hex: "11".repeat(32),
              person_id_hex: "22".repeat(32),
              member_name: "Ada",
              is_this_device: true,
            },
            {
              device_id_hex: "bb".repeat(16),
              person_fingerprint_hex: "33".repeat(32),
              person_id_hex: "44".repeat(32),
              member_name: null,
              is_this_device: false,
            },
            {
              device_id_hex: "cc".repeat(16),
              person_fingerprint_hex: "55".repeat(32),
              person_id_hex: null,
              member_name: "Grace",
              is_this_device: false,
            },
          ],
          unverified_device_ids: ["dd".repeat(16)],
        }),
      },
    },
    render: () => <DeviceAttributionPanel />,
  },
  {
    id: "components/devicejoinqr/default",
    group: "components",
    surface: "DeviceJoinQr",
    state: "default",
    description:
      "The owner's device-join code: the account number is pasted in, and the scanning device is asked for the vault password.",
    tags: ["components", "devicejoinqr", "default"],
    render: () => <DeviceJoinQr />,
  },
  {
    id: "components/devicejoinqr/member",
    group: "components",
    surface: "DeviceJoinQr",
    state: "member",
    description:
      "A member's own-device code: no input at all, the code is built from the active session, and the three steps beside it send the other device through the recovery phrase.",
    tags: ["components", "devicejoinqr", "member"],
    render: () => <DeviceJoinQr variant="member" />,
  },
  {
    id: "components/devicemanagementpanel/default",
    group: "components",
    surface: "DeviceManagementPanel",
    state: "default",
    description:
      "The account's devices on an owner vault: the roster, with rename and remove.",
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
        plane="owner"
      />
    ),
  },
  {
    id: "components/devicemanagementpanel/member-vault",
    group: "components",
    surface: "DeviceManagementPanel",
    state: "member-vault",
    description:
      "The same roster on a vault this person joined: no Remove, because only the vault's owner can revoke that access, and no local reset, because it would clear the membership token the vault syncs on.",
    tags: ["components", "devicemanagementpanel", "member"],
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
        plane="member"
      />
    ),
  },
  {
    id: "components/endpointconfig/default",
    group: "components",
    surface: "EndpointConfig",
    state: "default",
    description:
      "The self-host server endpoint configuration: the URL the client syncs against, validated before it is stored. Look for a malformed origin to be refused here rather than accepted and failing later.",
    tags: ["components", "sync", "endpoint", "server", "self-host", "configuration"],
    render: () => <EndpointConfig />,
  },
  {
    id: "components/enrolldeviceform/default",
    group: "components",
    surface: "EnrollDeviceForm",
    state: "default",
    description:
      "The form that enrols this device onto an account, taking the credentials the server needs and submitting them. Look for the fields to match the enrolment the backend expects rather than a generic login.",
    tags: ["components", "sync", "enrol", "device", "form", "account"],
    render: () => <EnrollDeviceForm />,
  },
  {
    id: "components/enrollphrasecredential/default",
    group: "components",
    surface: "PhraseEntryGrid",
    state: "default",
    description:
      "The 24-cell grid a recovery or enrolment phrase is typed into, one cell per word with paste support. It is the entry twin of the display grid.",
    tags: ["components", "recovery-phrase", "phrase-entry", "grid", "input", "ceremony"],
    render: () => (
      <PhraseEntryGrid
        baseId="story-enroll"
        cells={PHONE_CELLS}
        onCellChange={() => noop}
        onCellPaste={() => noop}
      />
    ),
  },
  {
    id: "components/integrityalertbanner/default",
    group: "components",
    surface: "IntegrityAlertBanner",
    state: "default",
    description:
      "The banner raised when stored data fails its integrity check, dismissible once acknowledged. Look for it naming the affected store rather than a generic \"something is wrong\".",
    tags: ["components", "integrity", "alert", "banner", "corruption", "security"],
    render: () => <IntegrityAlertBanner present onDismiss={action("onDismiss")} />,
  },
  {
    id: "components/joindevicemodal/default",
    group: "components",
    surface: "JoinDeviceModal",
    state: "default",
    description:
      "The modal for pairing a new device: it runs the join flow and reports back joined, or recovering when a device has to fall back to the phrase.",
    tags: ["components", "sync", "join", "device", "pairing", "modal"],
    render: () => (
      <JoinDeviceModal
        onCancel={action("onCancel")}
        onJoined={action("onJoined")}
        onRecovering={action("onRecovering")}
        onAccountJoined={action("onAccountJoined")}
      />
    ),
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
    description:
      "The shared vault's member roster: who belongs to the vault, their roles and their continuity. This fixture is the empty roster, so look for the empty treatment rather than rows.",
    tags: ["components", "sync", "members", "roster", "b2b", "shared-vault"],
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
    id: "components/personregisterform/default",
    group: "components",
    surface: "PersonRegisterForm",
    state: "default",
    description:
      "The one register-an-identity form, mounted by the identity home and by Settings → Sync. It asks for the 24 words in the shared grid and, when the device has no sync server yet, for the address too: registering is a write against a server, and the identity home is reachable at zero vaults, where Settings does not exist. The catch every failure arm shares is that a registration failure wipes the words while an address failure keeps them.",
    tags: ["components", "sync", "identity", "register", "recovery phrase", "b2b"],
    fixture: {
      description: "a device with no sync server configured",
      handlers: {
        "plugin:sync|sync_get_endpoint": () => ({ endpoint_url: null }),
        "plugin:sync|sync_beta_terms_accepted": () => true,
      },
    },
    render: () => (
      <PersonRegisterForm
        testIdPrefix="story.register"
        onRegistered={() => {}}
      />
    ),
  },
  {
    id: "components/membervaultunlockcard/default",
    group: "components",
    surface: "MemberVaultUnlockCard",
    state: "default",
    description:
      "The credential body a shared (member) vault is opened with. It renders INSIDE AuthShell, like the owner's password form, so the mark, the heading naming the vault and the back link to the picker are the same on both screens and only the credential differs. A member holds no vault password of their own: this offers whichever device-local fast credential is configured (password, PIN or biometric) with the member's own recovery phrase one click away, and the swap between the two is a text link rather than a button.",
    tags: [
      "components",
      "member vault",
      "shared vault",
      "unlock",
      "recovery phrase",
      "b2b",
      "credential swap",
    ],
    render: () => (
      <MemberVaultUnlockCard vaultId={FIXTURE_VAULT_ID} onUnlocked={action("onUnlocked")} />
    ),
  },
  {
    id: "components/reconcilebanner/default",
    group: "components",
    surface: "ReconcileBanner",
    state: "default",
    description:
      "The banner shown while the client reconciles local and remote state at startup, dismissed once the two agree. Look for it to be informational rather than an error.",
    tags: ["components", "sync", "reconcile", "banner", "startup", "informational"],
    render: () => <ReconcileBanner active onDismiss={action("onDismiss")} />,
  },
  {
    id: "components/recoverednotes/default",
    group: "components",
    surface: "RecoveredNotes",
    state: "default",
    description:
      "The list of notes recovered after an interrupted operation, naming what was saved so the user can check rather than hope. Look for the titles and where they landed.",
    tags: ["components", "recovery", "notes", "data-recovery", "list", "safety"],
    render: () => <RecoveredNotes />,
  },
  {
    id: "components/remotemergehint/default",
    group: "components",
    surface: "RemoteMergeHint",
    state: "default",
    description:
      "The hint shown when a peer's changes arrive while a note is being edited. It appears on a sync event from the running backend, which the fake host does not emit, so the stage shows that reason.",
    unreachable: {
      what: "the hint shown when a peer's changes arrive mid-edit",
      why: "it appears on a sync event from the running backend, which the fake host does not emit",
    },
    tags: ["components", "sync", "merge", "hint", "conflict", "unreachable"],
    render: () => <RemoteMergeHint />,
  },
  {
    id: "components/repairresiduebanner/default",
    group: "components",
    surface: "RepairResidueBanner",
    state: "default",
    description:
      "The banner offering to sweep orphan residue. It appears only when the mount scan finds residue on disk, and the fake host reports none, so the stage shows that reason rather than the offer.",
    unreachable: {
      what: "the banner offering to sweep orphan residue",
      why: "it appears only when the mount scan finds residue on disk, and the fake host reports none",
    },
    tags: ["components", "repair", "residue", "orphans", "unreachable", "cleanup"],
    render: () => <RepairResidueBanner />,
  },
  {
    id: "components/syncbanners/default",
    group: "components",
    surface: "SyncBanners",
    state: "default",
    description:
      "The sync status banners, driven by live sync state the fake host does not emit, so the stage shows that reason. In the app it is the top-of-window strip carrying the paused, error and progress states.",
    unreachable: {
      what: "the sync status banners",
      why: "they are driven by live sync state the fake host does not emit",
    },
    tags: ["components", "sync", "banners", "status", "unreachable", "notification"],
    fixture: "unlocked",
    render: () => <SyncBanners />,
  },
  {
    id: "components/updatenotice/offer",
    group: "components",
    surface: "UpdateNotice",
    state: "offer",
    description:
      "The update notice offering a new version, with its release notes and the vault consequence stated before the press.",
    tags: ["components", "updatenotice", "offer", "update"],
    fixture: "unlocked",
    render: () => (
      <UpdateNotice
        view="offer"
        version="0.10.1"
        notes={UPDATE_NOTES}
        onRequestUpdate={action("onRequestUpdate")}
        onConfirm={action("onConfirm")}
        onCancel={action("onCancel")}
        onLater={action("onLater")}
        onReopen={action("onReopen")}
      />
    ),
  },
  {
    id: "components/updatenotice/offer-no-notes",
    group: "components",
    surface: "UpdateNotice",
    state: "offer-no-notes",
    description:
      "The same offer from a manifest that carries no release notes, which is the nullable half of the field.",
    tags: ["components", "updatenotice", "offer", "update", "empty"],
    fixture: "unlocked",
    render: () => (
      <UpdateNotice
        view="offer"
        version="0.10.1"
        notes={null}
        onRequestUpdate={action("onRequestUpdate")}
        onConfirm={action("onConfirm")}
        onCancel={action("onCancel")}
        onLater={action("onLater")}
        onReopen={action("onReopen")}
      />
    ),
  },
  {
    id: "components/updatenotice/confirm",
    group: "components",
    surface: "UpdateNotice",
    state: "confirm",
    description:
      "The notice expanded into its confirm, naming the vault lock and the restart before anything starts.",
    tags: ["components", "updatenotice", "confirm", "update"],
    fixture: "unlocked",
    render: () => (
      <UpdateNotice
        view="confirm"
        version="0.10.1"
        notes={UPDATE_NOTES}
        onRequestUpdate={action("onRequestUpdate")}
        onConfirm={action("onConfirm")}
        onCancel={action("onCancel")}
        onLater={action("onLater")}
        onReopen={action("onReopen")}
      />
    ),
  },
  {
    id: "components/updatenotice/pill",
    group: "components",
    surface: "UpdateNotice",
    state: "pill",
    description:
      "The notice reduced to its pill, which is what it falls back to once it has announced itself and left the reading area.",
    tags: ["components", "updatenotice", "pill", "update"],
    fixture: "unlocked",
    render: () => (
      <UpdateNotice
        view="pill"
        version="0.10.1"
        notes={UPDATE_NOTES}
        onRequestUpdate={action("onRequestUpdate")}
        onConfirm={action("onConfirm")}
        onCancel={action("onCancel")}
        onLater={action("onLater")}
        onReopen={action("onReopen")}
      />
    ),
  },
  {
    id: "components/updatingscreen/working",
    group: "components",
    surface: "UpdatingScreen",
    state: "working",
    description:
      "The full-window updating surface mid install, with the version resolving once over the spinner.",
    tags: ["components", "updatingscreen", "working", "update"],
    fixture: "unlocked",
    render: () => (
      <UpdatingScreen
        phase="working"
        version="0.10.1"
        onRetry={action("onRetry")}
        onBackToUnlock={action("onBackToUnlock")}
      />
    ),
  },
  {
    id: "components/updatingscreen/failed",
    group: "components",
    surface: "UpdatingScreen",
    state: "failed",
    description:
      "The updating surface after a failed install, with the retry and the only honest way back, which is unlock.",
    tags: ["components", "updatingscreen", "failed", "update"],
    fixture: "unlocked",
    render: () => (
      <UpdatingScreen
        phase="failed"
        version="0.10.1"
        onRetry={action("onRetry")}
        onBackToUnlock={action("onBackToUnlock")}
      />
    ),
  },
  {
    id: "components/syncstatusindicator/default",
    group: "components",
    surface: "SyncStatusIndicator",
    state: "default",
    description:
      "The compact sync status indicator in the bottom bar: a dot and a label over the sync state, here configured and idle. It is the at-a-glance companion to the Sync panel.",
    tags: ["components", "sync", "status", "indicator", "bottom-bar", "idle"],
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
    description:
      "The sync account's usage block: stored versus quota bytes and the device count, rendered here on the OWNER plane with the storage meter shown. On a member vault the storage row is suppressed because the figure would be the member's own account.",
    tags: ["components", "sync", "usage", "storage", "quota", "devices"],
    render: () => (
      <SyncUsageBlock
        status={{
          stored_bytes: 512_000_000,
          quota_bytes: 2_000_000_000,
          device_count: 2,
          max_devices: 5,
          frozen: false,
        }}
        // The catalogue renders the OWNER plane's shape: `showStorage` is what
        // reveals the storage row and its meter, and on a member vault that row
        // is suppressed because the figure would be the member's own person
        // account. A story that omitted it would leave the meter out of the
        // catalogue entirely.
        showStorage={true}
      />
    ),
  },
  {
    id: "components/torstatusbanner/default",
    group: "components",
    surface: "TorStatusBanner",
    state: "default",
    description:
      "The banner reporting the Tor routing posture, here mid-connect: the client syncs over Tor when the device-local routing option is on, and this is where that is visible.",
    tags: ["components", "sync", "tor", "routing", "banner", "posture"],
    render: () => <TorStatusBanner posture="connecting" />,
  },

  // ── Toast ────────────────────────────────────────────────────────────────
  {
    id: "components/toast/default",
    group: "components",
    surface: "Toast",
    state: "default",
    description:
      "The headless bridge that pushes a message into the shared toast store; the single Toaster renders it. It draws nothing itself, so a story mounts the pair the way the app does, which is what makes a toast visible here.",
    tags: ["components", "toast", "notification", "bridge", "headless", "store"],
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
    description:
      "The Toaster's own subject: the STACK. The newest toast is fully shown and older ones peek behind it, so this seeds three with a long hold rather than the real 2.5s so the catalogue does not empty itself under the reader.",
    tags: ["components", "toast", "stack", "notification", "queue", "overlay"],
    render: () => <ToasterStackDemo />,
  },

  // ── Dialog and picker surfaces ───────────────────────────────────────────
  {
    id: "components/commandpalette/default",
    group: "components",
    surface: "CommandPalette",
    state: "default",
    description:
      "The command palette: a search field over every bindable action for the current stage, walked with the keyboard. It is a modal carve-out mounted by the editor, and its subject is the filtered command list.",
    tags: ["components", "command-palette", "commands", "search", "keyboard", "modal"],
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
    description:
      "The quick picker: a lightweight list for choosing one item, here two notes with an optional sublabel. It is what a command that needs an argument opens instead of a full dialog.",
    tags: ["components", "quick-picker", "list", "chooser", "notes", "keyboard"],
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
    description:
      "The clipper pairing dialog, mid-session: the challenge code the user compares between the browser and the app. The fixture answers a real pending session rather than the fake host's default, because otherwise the code box renders empty.",
    tags: ["components", "clipper", "pairing", "browser-extension", "challenge", "code"],
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
    description:
      "The install confirmation for a custom-theme link. It renders only when the app receives a theme deep link from the OS, which the catalogue cannot fire, so the stage shows that reason.",
    unreachable: {
      what: "the install confirmation for a theme link",
      why: "it renders only when the app receives a custom-theme deep link from the OS, which the catalogue cannot fire",
    },
    tags: ["components", "theme", "install", "deep-link", "unreachable", "custom-theme"],
    render: () => <ThemeInstallDialog />,
  },
  {
    id: "components/meetingaidialog/default",
    group: "components",
    surface: "MeetingAiDialog",
    state: "default",
    description:
      "The meeting-AI dialog: it appears when a note looks like it holds a transcript and offers to pull out the sections. The story publishes an offer first, because the dialog renders nothing until one exists.",
    tags: ["components", "ai", "meeting", "transcript", "sections", "dialog"],
    render: () => {
      // The dialog renders nothing until an offer exists; publish one so the
      // story shows the section picker.
      offerMeetingAi("story-note", "A short meeting transcript.");
      return <MeetingAiDialog />;
    },
  },
  {
    id: "components/invitesdialog/default",
    group: "components",
    surface: "InvitesDialog",
    state: "default",
    description:
      "The invitations dialog a device that already holds a vault uses to accept one: the recipient-scoped list, one row per invitation addressed to this identity, with the accept wizard behind the row. It exists because the identity home, which carried this list, renders only at ZERO vaults, so a device with a vault had no surface on which an invitation could be accepted.",
    tags: ["components", "invites", "dialog", "b2b", "member", "onboarding"],
    render: () => (
      <InvitesDialog
        open
        invites={[
          {
            invite_id_hex: "aa".repeat(16),
            vault_account_hash_hex: "bb".repeat(32),
            claimed: false,
          },
        ]}
        loading={false}
        unavailable={null}
        onClose={action("onClose")}
        onRetry={action("onRetry")}
        onAccepted={action("onAccepted")}
      />
    ),
  },
  {
    id: "components/identitysetupdialog/default",
    group: "components",
    surface: "IdentitySetupDialog",
    state: "default",
    description:
      "The dialog that creates a person's identity: the ceremony that derives the deterministic keypair from the recovery phrase. It creates no vault, so a person can be invite-addressed before owning one.",
    tags: ["components", "identity", "setup", "dialog", "recovery-phrase", "b2b"],
    fixture: "unlocked",
    render: () => <IdentitySetupDialog open onClose={action("onClose")} />,
  },
  {
    id: "components/identitysetuppanel/default",
    group: "components",
    surface: "IdentitySetupPanel",
    state: "default",
    description:
      "The identity ceremony as a PANEL: the same body the Settings dialog mounts, and the body the first run mounts inline. One create row and one recover row, no server address anywhere, because creating an identity is network-free and registration is a separate act. Look for the absence of an endpoint field and of any modal chrome.",
    tags: ["components", "identity", "setup", "panel", "recovery-phrase", "offline", "first-run"],
    fixture: "unlocked",
    render: () => (
      <IdentitySetupPanel onDone={action("onDone")} onCancel={action("onCancel")} />
    ),
  },
  {
    id: "components/newnotefromtemplatemodal/default",
    group: "components",
    surface: "NewNoteFromTemplateModal",
    state: "default",
    description:
      "The modal offering the two ways to start a note: a blank one, or one built from a template. Look for the template door and the blank door to be equally weighted rather than one hidden behind the other.",
    tags: ["components", "templates", "new-note", "modal", "blank", "chooser"],
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
    description:
      "The note-template manager: lists the vault's templates and maps each row to New, Edit, Remove from templates and Delete. A modal carve-out opened from the command palette, with a first-run empty state rather than seeded examples.",
    tags: ["components", "templates", "manager", "modal", "notes", "management"],
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
    description:
      "The Settings shell modal: the left rail of panels and the content column for the selected one. Look for the rail taxonomy (Account through About, then the developer group) and that panels carrying an absent capability are dropped rather than greyed.",
    tags: ["components", "settings", "modal", "rail", "panels", "shell"],
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
    description:
      "The vault switcher: choose which of this device's vaults to open, or create another. Look for the switch-in-progress state a slow unlock passes through.",
    tags: ["components", "vaults", "switcher", "picker", "switch", "multi-vault"],
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
    description:
      "The full-screen blocking progress surface a long ceremony step holds the user on: an eyebrow, a heading and a caption over an indeterminate indicator, with no dismissal because the operation owns the app.",
    tags: ["components", "progress", "blocking", "ceremony", "encrypting", "overlay"],
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
    description:
      "The button that imports a plain markdown file into the vault, taking the OS file-handle id it was shared with. It is the vault-side half of the plain-file surface, reachable before a vault exists.",
    tags: ["components", "plain-file", "import", "markdown", "file-handle", "button"],
    render: () => <ImportPlainFileButton handle={1} />,
  },
  {
    id: "components/quickunlockentry/default",
    group: "components",
    surface: "QuickUnlockEntry",
    state: "default",
    description:
      "The quick-unlock entry on the locked screen: the PIN pad or biometric prompt that reopens a vault without the master password, with a fallback to the full credential. Mounted against a locked-vault fixture.",
    tags: ["components", "quick-unlock", "pin", "biometric", "locked", "unlock"],
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
    description:
      "The once-only reveal of a secret phrase: the words shown with a cover, an explicit reveal, and the save-to-file affordance. The word list is rendered verbatim and never re-derived for display.",
    tags: ["components", "recovery-phrase", "reveal", "secret", "once-only", "ceremony"],
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
    description:
      "The web client's dead-end screen for a visitor no account can be routed to, here the no-account wall. It explains why nothing can proceed rather than offering an action that would fail.",
    tags: ["components", "web", "dead-end", "no-account", "wall", "first-run"],
    render: () => <WebNoAccount wall="no-account" />,
  },

  // ── Vault-creation flow steps ────────────────────────────────────────────
  {
    id: "components/briefingstep/default",
    group: "components",
    surface: "BriefingStep",
    state: "default",
    description:
      "The first-run safety briefing: three acknowledged statements, each with an opt-in explanation, gating the Continue into vault creation. Look for the honesty of the copy and that Continue waits on every acknowledgement.",
    tags: ["components", "onboarding", "briefing", "first-run", "acknowledgement", "safety"],
    render: () => <BriefingStep onBack={action("onBack")} onContinue={action("onContinue")} />,
  },
  {
    id: "components/passwordstep/default",
    group: "components",
    surface: "PasswordStep",
    state: "default",
    description:
      "The password step of vault creation: the new-and-confirm fields with the length and score gates, and a slot for the create error. It holds the plaintext credential only until the ceremony commits.",
    tags: ["components", "vault-creation", "password", "step", "ceremony", "validation"],
    render: () => <PasswordStep error={null} onBack={action("onBack")} onSubmit={action("onSubmit")} />,
  },
  {
    id: "components/confirmstep/default",
    group: "components",
    surface: "ConfirmStep",
    state: "default",
    description:
      "The phrase confirmation step of vault creation: four labelled fields, one per drawn word position, checked against the phrase before the vault is committed. The committing and error slots cover the retry states.",
    tags: ["components", "vault-creation", "recovery-phrase", "confirm", "step", "ceremony"],
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
    description:
      "The encrypting step of vault creation: the blocking progress surface shown while the newly entered password and phrase seal the first blobs. Its whole job is to say that a real, slow operation is under way.",
    tags: ["components", "vault-creation", "encrypting", "step", "progress", "ceremony"],
    render: () => <EncryptingStep />,
  },
  {
    id: "components/sessionloststep/default",
    group: "components",
    surface: "SessionLostStep",
    state: "default",
    description:
      "The terminal step shown when the creation session is lost mid-ceremony: an error with a restart action, because the in-memory password reference is gone and the flow cannot continue where it stopped.",
    tags: ["components", "vault-creation", "session-lost", "error", "restart", "ceremony"],
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
    description:
      "The provisioning step of vault creation: the blocking surface while the fresh vault's device-local artefacts are created and the runtime slot is populated.",
    tags: ["components", "vault-creation", "provisioning", "step", "progress", "ceremony"],
    render: () => <ProvisioningStep expectsPhrase />,
  },
  {
    id: "components/readystep/default",
    group: "components",
    surface: "ReadyStep",
    state: "default",
    description:
      "The final step of vault creation: confirmation that the vault is ready, whose Done triggers the auto-unlock chain into the editor rather than leaving the user at the unlock screen.",
    tags: ["components", "vault-creation", "ready", "step", "auto-unlock", "ceremony"],
    render: () => <ReadyStep onDone={action("onDone")} vaultId={FIXTURE_VAULT_ID} />,
  },
  {
    id: "components/readylocalartefacts/default",
    group: "components",
    surface: "ReadyLocalArtefacts",
    state: "default",
    description:
      "The block on the ready step listing the device-local artefacts a sync-enrolled vault creates, with a pending state while they are written. Look for it naming what exists on this device after creation.",
    tags: ["components", "vault-creation", "local-artefacts", "ready", "sync", "pending"],
    render: () => <ReadyLocalArtefacts pending={false} vaultId={FIXTURE_VAULT_ID} />,
  },

  // ── Vault-recover flow steps ─────────────────────────────────────────────
  {
    id: "components/recoveryselectstep/default",
    group: "components",
    surface: "RecoverySelectStep",
    state: "default",
    description:
      "The first step of recovery: choose which vault to recover, against a locked-vault fixture. Look for the vault to be named so the choice is unambiguous before the phrase is typed.",
    tags: ["components", "recovery", "vault-recover", "select", "step", "locked"],
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
    description:
      "The phrase-entry step of recovery: the 24-cell grid where the words are typed, with the in-progress state carried on the reducer and a cancel door. Look for paste to fill the whole grid at once.",
    tags: ["components", "recovery", "phrase-entry", "grid", "step", "unlock"],
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
    description:
      "The decrypting step of recovery: the blocking surface while the entered phrase unwraps the vault's keys. It says what is happening rather than showing an anonymous spinner.",
    tags: ["components", "recovery", "decrypting", "step", "progress", "unlock"],
    render: () => <DecryptingStep />,
  },
  {
    id: "components/passwordresetstep/default",
    group: "components",
    surface: "PasswordResetStep",
    state: "default",
    description:
      "The step after a successful recovery where a new password is set, with its complete-success and recover-another exits. The phrase has already unlocked the vault; this re-seals it under a fresh credential.",
    tags: ["components", "recovery", "password-reset", "step", "re-key", "unlock"],
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
    description:
      "The screen serving BOTH the web client's first-run account entry and its pending-approval wait, chosen by the enrolment state. It is the phase-3 bootstrap that turns an empty browser into a device pulling a known account.",
    tags: ["components", "web", "account-bootstrap", "first-run", "pending-approval", "enrolment"],
    fixture: "no-vault",
    render: () => <AccountBootstrap onBootstrapped={action("onBootstrapped")} />,
  },
  {
    id: "components/agentreview/default",
    group: "components",
    surface: "AgentReview",
    state: "default",
    description:
      "The review card as a decision surface: one line per proposed change (the note, and what the change does), a Reject on every row, and the footer's two bulk acts. The change's own text is behind its row's chevron, so forty proposals read as a list rather than a document.",
    tags: ["components", "agentreview", "review", "card", "rows"],
    render: () => <SeededReview />,
  },
  {
    id: "components/agentreview/row-opened",
    group: "components",
    surface: "AgentReview",
    state: "row-opened",
    description:
      "The same card with one row's detail disclosed: the anchor text and what replaces it, in the mode the card's width allows. This is the state a reader actually decides in, and the one the closed row is compact enough to hide.",
    tags: ["components", "agentreview", "review", "diff", "opened-row"],
    render: () => <SeededReview openRow />,
  },
  {
    id: "components/agentreview/failed",
    group: "components",
    surface: "AgentReview",
    state: "failed",
    description:
      "An apply that failed: the headline names the cause instead of one sentence for every refusal, and there is no second dismissing control beside it. The refusal block itself is NOT here, because it renders above the model's claim on the transcript turn (myne-md/myne#848).",
    tags: ["components", "agentreview", "review", "failed", "cause"],
    render: () => <SeededReview failure />,
  },
  {
    id: "components/editor/default",
    group: "components",
    surface: "Editor",
    state: "default",
    description:
      "The whole post-unlock workspace, full-bleed: sync banners, the three-pane row, the split/tab pane tree, the bottom bar and every modal mount. It is the largest surface here, mounted inside the sidebar and workspace providers with the default prefs shape.",
    tags: ["components", "editor", "workspace", "panes", "sidebar", "chrome"],
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
    id: "components/identityhome/enrolled",
    group: "components",
    surface: "IdentityHome",
    state: "enrolled",
    description:
      "The same home with the identity's own material on screen: the account number and the invite code, each one field with its Copy control beside it, and the reservation paragraph that carries the Register action when the identity is not on a sync server yet. Look for one paragraph per state rather than two saying the same thing.",
    tags: ["components", "identity", "home", "account-number", "invite-code", "register", "b2b"],
    fixture: "unlocked",
    render: () => (
      <IdentityHome
        identityCode={
          "MYNE-PERSON-1:9a0bc51b14d2e6460450a9224ff49b9f3:eaf9564cc57dd8ae3f2b1a02cd77a41b:" +
          "7d118c51239d2573e48aa3def8cf1b257d141f7c8be55516305269d42a8ab08d"
        }
        accountNumber="MY-M2Y5-3CAD-5SJ6-0H8A-J8JM"
        onCreateVault={action("onCreateVault")}
        onAccepted={action("onAccepted")}
        onForgotten={action("onForgotten")}
        accountState="reserved"
        onRegistered={action("onRegistered")}
      />
    ),
  },
  {
    id: "components/identityhome/default",
    group: "components",
    surface: "IdentityHome",
    state: "default",
    description:
      "The identity home: where a person lands after identity-only setup, with the identity code and the doors to create a vault, accept an invite or start over. This frame has no code yet, which is the pre-identity state.",
    tags: ["components", "identity", "home", "onboarding", "invite", "b2b"],
    fixture: "unlocked",
    render: () => (
      <IdentityHome
        identityCode={null}
        accountNumber={null}
        onCreateVault={action("onCreateVault")}
        onAccepted={action("onAccepted")}
        onForgotten={action("onForgotten")}
        accountState={null}
        onRegistered={action("onRegistered")}
      />
    ),
  },
  {
    id: "components/invitewizard/accept",
    group: "components",
    surface: "InviteWizard",
    state: "accept",
    description:
      "Step 1 of 3 of accepting an invitation (myne-md/myne#871): the owner's identity code, pasted and nothing else. The member's own phrase and the device password are the two steps that follow, each on its own screen.",
    tags: ["components", "invitewizard", "accept", "onboarding", "wizard"],
    fixture: {
      description: "an unclaimed invite addressed to this identity; nothing is submitted from this step",
    },
    render: () => (
      <AcceptInviteWizard
        invite={{ invite_id_hex: "aa", vault_account_hash_hex: "bb".repeat(32), claimed: false }}
        onCancel={action("onCancel")}
        onAccepted={action("onAccepted")}
      />
    ),
  },
  {
    id: "components/invitewizard/join",
    group: "components",
    surface: "InviteWizard",
    state: "join",
    description:
      "Step 1 of 2 of adding an already-shared vault to this device (myne-md/myne#871): the recovery phrase and nothing else. There is deliberately no owner-code field here, because the owner this device verifies against is the one its own per-(person, vault) profile already pins.",
    tags: ["components", "invitewizard", "join", "onboarding", "wizard"],
    fixture: {
      description: "a claimed invite this identity can install with the phrase; nothing is submitted from this step",
    },
    render: () => (
      <JoinVaultWizard
        invite={{ invite_id_hex: "cc", vault_account_hash_hex: "dd".repeat(32), claimed: true }}
        onCancel={action("onCancel")}
        onAccepted={action("onAccepted")}
      />
    ),
  },
  {
    id: "components/restorebackup/default",
    group: "components",
    surface: "RestoreBackup",
    state: "default",
    description:
      "The restore-from-backup screen reached from the welcome door: choose a `.myne-backup` and open it. It is the fresh-install recovery path for a vault whose container is gone.",
    tags: ["components", "restore", "backup", "recovery", "welcome", "screen"],
    fixture: "no-vault",
    render: () => <RestoreBackup entry="welcome" onExit={action("onExit")} />,
  },
  {
    id: "components/unlock/default",
    group: "components",
    surface: "Unlock",
    state: "default",
    description:
      "The unlock screen for an existing vault: the quick-unlock or password form, one at a time, over a reducer with idle, decrypting and corrupted modes. Look for the recovery and restore doors beside the credential field.",
    tags: ["components", "unlock", "password", "quick-unlock", "locked", "screen"],
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
    description:
      "The vault picker shown when more than one vault exists on this device: each vault as a row, plus restore, create-another and join-device doors. Mounted against a locked fixture so it renders the choose-a-vault state.",
    tags: ["components", "vaults", "picker", "multi-vault", "select", "locked"],
    fixture: "locked",
    render: () => (
      <VaultPicker
        onSelect={action("onSelect")}
        onRestoreBackup={action("onRestoreBackup")}
        onCreateAnother={action("onCreateAnother")}
        onJoinDevice={action("onJoinDevice")}
        inviteCount={0}
        onInvites={action("onInvites")}
      />
    ),
  },
  {
    id: "components/vaultrecover/default",
    group: "components",
    surface: "VaultRecover",
    state: "default",
    description:
      "The full vault-recovery flow at its first step: the phrase-entry sub-step of the reducer that walks phrase, password reset and completion. It is the screen a user reaches without their password.",
    tags: ["components", "recovery", "vault-recover", "phrase-entry", "flow", "screen"],
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
    description:
      "The multi-step vault-creation flow at its entry: the reducer-driven ceremony from name through password, phrase, confirm and account to ready. It ends by auto-unlocking into the editor.",
    tags: ["components", "vault-creation", "create", "flow", "ceremony", "screen"],
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
    description:
      "The shell every auth and unlock screen renders inside: the mark, the centered card and the shared framing, with the caller supplying the credential body and its copy.",
    tags: ["components", "auth", "shell", "layout", "unlock", "framing"],
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
    description:
      "The naming step of vault creation: one field for the vault's label, with submit and back. Look for the label to be optional and the step to advance on Enter.",
    tags: ["components", "vault-creation", "name", "step", "label", "ceremony"],
    render: () => (
      <NameStep value="" onChange={action("onChange")} onSubmit={action("onSubmit")} onBack={action("onBack")} />
    ),
  },
  {
    id: "components/kitstep/default",
    group: "components",
    surface: "KitStep",
    state: "default",
    description:
      "The recovery-kit step: the once-only reveal of the 24 words together with the account number, and the instruction to write both down. It is the screen where the phrase exists in plaintext, so the reveal is explicit.",
    tags: ["components", "vault-creation", "recovery-kit", "phrase", "account-number", "ceremony"],
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
    description:
      "The choice row used on the welcome fork and the invite screens: a title, a body and one action, with a flag for the last row in the stack. It is the list shape rather than a settings row.",
    tags: ["components", "choice-list", "choice-row", "welcome", "list", "pattern"],
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
    description:
      "The 24-word display grid shown while the phrase is revealed and hidden behind a cover, with its own reveal/hide. It is the read-only twin of the phrase-entry grid.",
    tags: ["components", "recovery-phrase", "phrase-grid", "display", "reveal", "ceremony"],
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
    description:
      "The platform caveats shown beside a once-only secret. Both are conditional on a capability being ABSENT, and on the desktop capability set both are present, so the stage shows that reason rather than an empty block.",
    unreachable: {
      what: "the platform caveats shown beside a once-only secret",
      why: "both caveats are conditional on a capability being ABSENT, and on the desktop capability set both are present",
    },
    tags: ["components", "secret", "caveats", "capability", "unreachable", "a11y"],
    render: () => <SecretDisplayCaveats testIdPrefix="stories.secret" />,
  },
  {
    id: "components/devicejoinqrdialog/default",
    group: "components",
    surface: "DeviceJoinQrDialog",
    state: "default",
    description:
      "The dialog form of the device-join code, opened over the app rather than shown as a page. It is the same code as the standalone surface, framed for a modal entry point.",
    tags: ["components", "sync", "device-join", "qr", "dialog", "pairing"],
    render: () => <DeviceJoinQrDialog open onClose={action("onClose")} />,
  },
  {
    id: "components/personidentityunlock/default",
    group: "components",
    surface: "PersonIdentityUnlock",
    state: "default",
    description:
      "The prompt that unlocks a person's identity keypair when an action needs it outside a vault session. It is the person-plane credential prompt, separate from the vault unlock.",
    tags: ["components", "identity", "person", "unlock", "prompt", "b2b"],
    render: () => <PersonIdentityUnlock open onOpenChange={action("onOpenChange")} />,
  },
  {
    id: "components/personphraseunlock/default",
    group: "components",
    surface: "PersonPhraseUnlock",
    state: "default",
    description:
      "The identity-phrase credential for an upgraded vault, as the unlock screen's sub-view: 24 cells, one paste target and one non-distinguishing failure. It replaces the vault-recovery link on a person-wrapped vault, because the explicit upgrade retired that vault's own phrase.",
    tags: [
      "components",
      "unlock",
      "identity",
      "phrase",
      "person",
      "one-phrase",
      "a11y",
    ],
    render: () => (
      <PersonPhraseUnlock
        onUnlocked={action("onUnlocked")}
        onCancel={action("onCancel")}
      />
    ),
  },
  {
    id: "components/vaultformatupgrade/default",
    group: "components",
    surface: "VaultFormatUpgrade",
    state: "default",
    description:
      "The explicit upgrade of an existing vault to one-phrase recovery, as the Settings row offers it: one CTA, and the confirmation appears only after a press. The fixture answers the person-wrap probe with false, which is the only state in which the row renders anything at all.",
    tags: [
      "components",
      "settings",
      "vault",
      "format",
      "migration",
      "one-phrase",
      "irreversible",
    ],
    fixture: {
      description:
        "a vault that has not been upgraded yet, so the row offers the upgrade",
      handlers: {
        "plugin:vault-unlock|vault_is_person_wrapped": () => false,
      },
    },
    render: () => <VaultFormatUpgrade />,
  },
];
