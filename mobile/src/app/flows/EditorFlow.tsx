import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motionDurationMs, motionEasing } from "@myne/client-core/motion";
import { useTranslation } from "react-i18next";
import { ornamentRole } from "@myne/ornaments";
import { copyText } from "@myne/clipboard";
import { EmptyState } from "@myne/client-core/emptyState";
import { showToast } from "../../components/ToastHost";
import { buildMentionTargets } from "@myne/note-mentions";
import { writeText as clipboardWriteText } from "../../lib/clipboardTransport";
import { useEdgeSwipeBack } from "../../lib/edgeSwipeBack";
import { CMEditor } from "@myne/editor/CMEditor";
import { typographyStyle } from "@myne/editor/typography";
import { REVEAL_ATTACHMENT_EVENT } from "@myne/editor/attachments/fileCardActions";
import { installTaskChipEditor } from "@myne/editor/decorations/task-chip-listener";
import { headingSections } from "@myne/dialect";
import type { EditorView } from "@codemirror/view";
import { emit, listen } from "../../platform/event";
import { exportPath } from "../../platform/path";
import {
  Button,
  Screen,
  ScreenScroll,
  Icon,
  Banner,
  Spinner,
  Sheet,
  SnapshotFailedBanner,
  SyncBanners,
  ConflictsSheet,
  AiOnboardingSheet,
  LIST_TOP,
} from "../../components";
import { noteList, noteRead, noteCreate, noteUpdate, deleteNoteRouted, createTitledNote } from "../../lib/notes";
import {
  closeLiveNote,
  openLiveNote,
  patchEpoch,
  readLiveNote,
  reportLivePresence,
  settledPatches,
  takeRemoteSplices,
} from "../../lib/liveNote";
import {
  applySplicesToText,
  installRemoteMergeDrain,
  type RemoteMergeDrain,
} from "../../lib/liveRemoteMerge";
import { runLiveResync } from "../../lib/liveResync";
import { createConflictCopy } from "../../lib/conflictCopy";
import { remoteDispatchSpec } from "@myne/editor/live-bridge";
import { useAwarenessChannel, useAwarenessForNote, useAwarenessLabelResolution, useAwarenessPeers } from "../../lib/awareness";
import {
  presenceRevealFor,
  requestPresenceJump,
  PRESENCE_JUMP_EVENT,
  type PresenceJumpDetail,
} from "@myne/presence-jump";
import { PresenceSheet } from "./editor/sheets/PresenceSheet";
import {
  DrawingCanvasLazy,
  extractSceneJson,
  writeSceneJson,
  isDrawingBody,
  buildDrawingNoteBytes,
  type DrawingEmbedIo,
  type ExcalidrawImperativeAPI,
} from "@myne/editor/drawing";
import type { ResolverNote } from "@myne/editor/host/notes/resolveWikilink";
import type { NoteListError } from "../../lib/notes";
import { useConflictMaterializer } from "../../lib/use-conflict-materializer";
import { activeVaultId, listVaults, orderByLastUnlock } from "../../lib/vault-list";
import { HAS_TAURI } from "../../lib/app-window";
import { useIdleAutoLock } from "../../hooks/useIdleAutoLock";
import { useMobileReminderPass } from "../../lib/useMobileReminderPass";
import { consumePendingCapture, CAPTURE_EVENT, type CaptureMode } from "../../lib/deep-link";
import {
  drainPendingCaptures,
  sealMeetingInbox,
  sealStagedCaptures,
} from "../../lib/captures";
import { drainPendingMeetings } from "../../lib/meetingDrain";
import { drainPendingShares } from "../../lib/shareImport";
import { ShareImportToast } from "./ShareImportToast";
import { ioBanner } from "../../lib/io-banner";
import { usePrefs } from "../../lib/use-prefs";
import { normalizeNewNoteLocation } from "../../lib/prefs";
import { vaultDisplayLabel } from "../../lib/vault-label";
import { useSwipeBack } from "../../lib/use-swipe-back";
import { isRtl } from "../../lib/util";
import { setFavorites, mutateArchivedFolders, mutateDeliberateFolders, mutationFrom, prefsRead, registerDeliberateFolders, setFolderIcons, setItemColors, setItemOrder, PREFS_SYNC_APPLIED_EVENT } from "../../lib/prefs";
import { backfillDeliberateFolders } from "../../lib/folderBackfill";
import { bumpPrefsNonce, withPrefsBatch } from "../../lib/prefsNonce";
import { useHiddenHomeTiles } from "../../lib/home-tiles";
import { searchNotes } from "../../lib/search-notes";
import { buildTagIndex } from "../../lib/tags";
import { tagIndexToGraphTags } from "@myne/graph-overlay";
import { publishEditorTagTree } from "../../lib/editor-tag-bridge";
import { maybeSeedTestData } from "../../lib/seed";
import { countWords } from "../../lib/word-count";
import {
  readNoteFlags,
  isArchivedNote,
  isListedTemplate,
  isLiveNote,
  isResolverCandidate,
  isTrashedNote,
  bodyAfterFrontmatter,
  frontmatterBody,
  stampUpdated,
  readNoteFolder,
  moveNoteToFolder,
  moveNoteToFolderWithoutRegistering,
  trashNote,
  restoreNote,
  archiveNote,
  unarchiveNote,
  type NoteFlags,
} from "../../lib/note-organize";
import { deriveTree, subtreeCount, orderedChildren, reorderChildBeside, notesInSubtree } from "../../lib/folders";
import type { Child, OrderedNoteRecord } from "@myne/editor/host/notes/itemOrder";
import { toggleFolderExpanded, useExpandedFolders } from "../../lib/folder-expand-store";
import { ensureWorkspaceHydrated, flushWorkspaceNow } from "../../lib/workspace-persist";
import { flushChatHistoryNow } from "../../lib/chatHistory";
import { endAgentRun } from "../../lib/agent-lifetime";
import { clearAwareness } from "@myne/awareness-store";
import { resolvePeriodNote, createNoteFromTemplate, createBlankNamedNote } from "../../lib/daily";
import { periodSettings, zonedNow } from "../../lib/daily";
import type { Period } from "../../lib/daily";
import { normalizeFolderPath, ancestorPaths, foldSegment, folderKey } from "../../dialect/folderPath";
import {
  archivedFolderKeys,
  filterVisibleDeliberate,
  isNoteFolderArchived,
  topLevelArchivedFolders,
  removeFolderFromArchive,
  collectSubtreeNoteIds,
} from "../../lib/archivedFolders";
import { buildInitialPlaintext, readUpdatedFromFmBody } from "../../dialect/surgery";
import { formatRelativeTime } from "../../lib/relative-time";
import { runView, type RunViewContext, type ViewResult } from "@myne/editor/host/notes/queryEngine";
import { foldDecorationKeys, rewriteFolderPrefix } from "@myne/editor/host/notes/decorationKeys";
import { MobileViewRenderHost } from "./editor/views/MobileViewRenderHost";
import type { SavedView } from "../../lib/prefs";
import { ViewEditorSheet } from "./ViewEditorSheet";
import { importFile, ATTACHMENT_ACCEPT, attachmentDelete } from "../../lib/attachments";
import {
  buildPhotoNoteBlock,
  localDateStamp,
  photoNoteTitle,
  shouldDiscardPhotoDraft,
} from "../../lib/photoNoteBody";
import { emitAttachmentEmbed } from "../../lib/attachmentRef";
import { AttachmentsSheet } from "./AttachmentsSheet";
import { CalendarSurface } from "./CalendarSurface";
import { PhotoNoteSheet, type PhotoNoteDestination } from "./PhotoNoteSheet";
import { RecordingSheet } from "./RecordingSheet";
import { VOICE_RECORD_EVENT } from "../../lib/voice-record-bridge";
import { SnapshotsSheet } from "./SnapshotsSheet";
import { TemplatesSheet } from "./TemplatesSheet";
import { unmarkTemplate, createTemplate } from "../../lib/templates";
import { deriveTitleSnippet } from "../../lib/note-title";
import { searchIndexReplace, searchIndexApply, searchIndexRemove, type SearchDoc } from "../../lib/search";
import { vaultIndicesApply, vaultIndicesRemove, vaultIndicesAllEdges, vaultIndicesHeadings, vaultIndicesBlockAnchors, vaultIndicesPropertyValues, vaultIndicesPropertyKeys, type WikilinkEdge, type VaultHeadingRow, type VaultBlockAnchor } from "../../lib/vault-indices";
import { joinVaultHeadings } from "@myne/editor/host/notes/vaultHeadings";
import { joinVaultBlockAnchors } from "@myne/editor/host/notes/blockAnchors";
import type { VaultHeading } from "@myne/editor/wikilink/vault-headings";
import type { VaultBlockAnchor as EditorVaultBlockAnchor } from "@myne/editor/wikilink/vault-block-anchors";
import { extractRecord } from "../../lib/indices-extract";
import { createIndexDeltaTracker, type DeltaItem, type IndexDeltaTracker } from "../../lib/index-delta";
import {
  flushVaultIndicesPersistNow,
  hydrateVaultIndicesOnce,
  noteVaultIndicesChanged,
  resetVaultIndicesLifecycle,
  seedIndexTrackerFromHydration,
  setVaultIndicesExitSeamLeveller,
  warnVaultIndicesFailure,
} from "../../lib/vault-indices-lifecycle";
import { buildNoteGraphAndModel, clientEdges } from "../../lib/backend-graph";
import { MarkdownView } from "../../components/MarkdownView";
import type { VaultSummary } from "../../types/vault-summary";
import type { EditorFlowProps } from "./types";
import type { VaultId } from "../../lib/stage";
import { SettingsSheet, applyStoredTheme, type Panel } from "./SettingsSheet";
import { IdentityFlow } from "./IdentityFlow";
import { isRegularSizeClass, useSizeClass } from "../../formfactor/SizeClassContext";
import { ListDrawer } from "./editor/sheets/ListDrawer";
import { applyCaret, snapshotCaret, type CaretSnapshot } from "./editor/caretRestore";
import { EmptyDetail } from "./editor/EmptyDetail";
import { NavRibbon } from "./editor/chrome/NavRibbon";
import { HomeSurfaceMobile } from "./editor/HomeSurfaceMobile";
import { AppHeader } from "./editor/chrome/AppHeader";
import { useAutosave } from "./editor/chrome/useAutosave";
import { ActionPill } from "./editor/chrome/ActionPill";
import { EditorTopBar } from "./editor/chrome/EditorTopBar";
import { FavoritesStrip } from "./editor/chrome/FavoritesStrip";
import { FormatBar } from "./editor/chrome/FormatBar";
import { GraphTab } from "./editor/chrome/GraphTab";
import { NoteRow } from "./editor/chrome/NoteRow";
import { FolderTreeRow } from "./editor/chrome/FolderTreeRow";
import { ReadingBar } from "./editor/chrome/ReadingBar";
import { TabBar, type WorkspaceTab } from "./editor/chrome/TabBar";
import { defaultGrantFor } from "@myne/agent-protocol";

import { AiChatFlow } from "./AiChatFlow";
import { TaskSurface } from "../../components/TaskSurface";
import { DEFAULT_TASK_VIEW, type TaskView } from "@myne/task-view";
import { takeReminderLanding } from "../../lib/reminderLanding";
import { useVaultTasks, vaultTasks } from "../../lib/tasks";
import { NoteContextPanel } from "./editor/panels/NoteContextPanel";
import { CommandPalette } from "./editor/sheets/CommandPalette";
import { FilterSheet } from "./editor/sheets/FilterSheet";
import { NoteActionsSheet } from "./editor/sheets/NoteActionsSheet";
import { CoverPickerSheet } from "./editor/sheets/CoverPickerSheet";
import { setNoteCover, type CoverChoice } from "../../lib/setNoteCover";
import {
  OPEN_COVER_PICKER_EVENT,
  REMOVE_COVER_EVENT,
  type OpenCoverPickerDetail,
  type RemoveCoverDetail,
} from "@myne/editor/cover-signal";
import { NoteRowActionsSheet } from "./editor/sheets/NoteRowActionsSheet";
import { FolderActionsSheet } from "./editor/sheets/FolderActionsSheet";
import { DecorationSheet } from "./editor/sheets/DecorationSheet";
import { TagBrowserSheet } from "./editor/sheets/TagBrowserSheet";
import { VaultSwitcher } from "./editor/sheets/VaultSwitcher";
import { ViewsSheet } from "./editor/sheets/ViewsSheet";
import type { NoteEntry, OutlineItem, PaletteCommand } from "./editor/types";

// One period-note failure string per period (myne#177), the desktop twin of
// `src/screens/Editor.tsx::PERIOD_OPEN_FAILED_KEY`. Spelled out as literals
// rather than built from the period name, because a template-built key is
// invisible to `check-i18n.mjs` and would go missing from the catalog silently.
const PERIOD_OPEN_FAILED_KEY: Record<Period, string> = {
  daily: "editor.periodicNotes.openFailed.daily",
  weekly: "editor.periodicNotes.openFailed.weekly",
  monthly: "editor.periodicNotes.openFailed.monthly",
};

/**
 * Editor flow - the wired main surface after unlock. Mirrors the static
 * `notes/05·06` list + `notes/07` reading + `workspace/08` editor +
 * `workspace/11 · Settings` screens, but driven by the real `notes` plugin.
 *
 * View machine: `list` ⇄ `editor`. Mount → `noteList()` then `noteRead()` per
 * id to derive a (title, snippet) for each row. `+` opens a blank editor;
 * tapping a row opens it on that note's plaintext (plain <textarea>, the mobile
 * port of the desktop B4.5 stub - no CodeMirror). Save → `noteCreate` /
 * `noteUpdate`; delete → `noteDelete`. The gear (Settings tab) opens the
 * <SettingsSheet>; the "Personal ▾" bar opens a vault switcher.
 *
 * Note plaintext is held in component-local state for the controlled textarea
 * and wiped on every exit path + on unmount (best-effort; the load-bearing
 * zeroize is Rust-side per `src-tauri/AGENTS.md`).
 */

type Editing = { id: string | null };

/** Left-to-right tab position - drives the slide direction of the page
 *  transition: moving to a higher-indexed tab enters from the right, a
 *  lower-indexed tab from the left (an iOS push/pop feel across the tab row). */
const TAB_ORDER: Record<WorkspaceTab, number> = {
  // Home is the leftmost page: it sits before the list, so entering it slides in
  // from the left like a back-navigation.
  home: -1,
  notes: 0,
  // MYND-620: `tasks` is placed between notes and graph rather than appended,
  // because this record is what decides the push/pop slide direction - a tab
  // that sits second in the bar and last in this record slides in from the
  // wrong side.
  tasks: 1,
  "note-tasks": 2,
  search: 3,
  graph: 4,
  // The calendar's sidebar row follows Graph, so its slide position does too; it
  // has no bottom-bar column (the bar is at its budget, see `TabBar.tsx`), and
  // this record is about the page transition rather than the bar.
  calendar: 4,
  files: 5,
  templates: 6,
  // Last, matching its position in the bar. The comment above is the reason
  // this is not a free choice: a tab that sits last in the bar and earlier here
  // slides in from the wrong side, and nothing but the eye reports that.
  chat: 7,
};

/** Editor typography presets (mirror the desktop `editor-typography` prefs), so
 *  the Appearance settings tangibly change the note editor. */
// Reading-view (MarkdownView) base font px - matches the shared editor-typography
// TEXT_SIZE presets so reading mode + the live editor + desktop stay consistent
// (MYND-483). The live editor itself uses `typographyStyle` CSS vars, not this.
const EDITOR_TEXT_PX: Record<string, number> = { sm: 13, md: 14, lg: 16, xl: 18 };

/**
 * Rejection handler for the `void`-ed prefs writes below. It does nothing, and
 * that is the point. Named rather than an inline `() => {}` so every site reads
 * as the same deliberate decision, and greppable so a change that surfaces one
 * of these failures has a work list.
 *
 * **myne-md/myne#613 walked that work list**, and the rule it settled on is the
 * one every remaining site is measured against: report a failure when the user
 * asked for the thing that failed, stay silent when the failure costs them
 * something they did not ask for and cannot act on. The three classes:
 *
 *   1. **A self-healing or derived write**: the decoration fold-on-load
 *      migration, and the decoration/favorites/item-order writers. Silent, and
 *      the decoration-writer comment further down carries the full argument:
 *      there is no optimistic local state to revert, a rejected `invoke` means
 *      the backend wrote nothing, and the next render already shows disk truth.
 *   2. **A write RIDING on an action that succeeded**: registering the folder
 *      of a note the user just created or moved. The note landed, which is what
 *      they asked for; the folder still works and loses only the promise to
 *      outlive being emptied. Silent, because a notice here would report a
 *      failure of something they did not ask for on top of a success.
 *   3. **A write that IS the action**: creating a folder. Reported, through
 *      `registerDeliberateFolders`, which retries once and then distinguishes a
 *      full budget (actionable) from a persistent failure (not). That is the one
 *      site this issue changed.
 *
 * `mutateArchivedFolders` sits in class 3 by that rule and is NOT changed here:
 * archive is `archived_folders`, a different set with a different surface, and
 * widening this issue into it would mean shipping its notice with no test and no
 * design pass. It is the one knowingly-unpaid site, stated rather than left to
 * be rediscovered.
 */
const ignorePrefsWriteFailure = (): void => {};

/**
 * Shared chrome for the `Sheet`s below that ask a question and offer two
 * buttons: purge a note, move a note to a folder, delete a folder.
 *
 * The first two had their own copies, identical except where one had drifted (a
 * 13px body against a 14px one, with nothing choosing between them). Collapsed
 * when the folder-delete sheet made it three (myne-md/myne#628), because a third
 * copy is where a change to one of them quietly stops reaching the others.
 *
 * The BUTTONS are not here, and that is the point of the shape: mobile already
 * has the primitive, and `UnlockFlow`'s delete-vault sheet is the same dialog
 * built out of it. Keeping a private geometry beside it would have made a fourth
 * answer to "how tall is the destructive button on a bottom sheet" (this file
 * had 50/r8, `Button` has 52 and 48/r6, `AttachmentsSheet` has 48/r8). These
 * three now use `Button`, so the design system reaches them.
 */
const SHEET_TITLE = {
  fontSize: 17,
  fontWeight: 600,
  color: "var(--fg-1)",
  textAlign: "center",
} as const;
const SHEET_BODY = {
  marginTop: 8,
  fontSize: 14,
  lineHeight: 1.5,
  color: "var(--fg-3)",
  textAlign: "center",
} as const;
/**
 * The same paragraph in full ink, for a sheet whose body IS the decision rather
 * than reassurance about it: the folder delete names how many notes move, and
 * that count is what the user is agreeing to. Two named constants rather than a
 * spread with an inline colour, so the distinction is a choice a call site makes
 * by name instead of a literal a reader has to interpret.
 */
const SHEET_LEAD = { ...SHEET_BODY, color: "var(--fg-1)" } as const;
const SHEET_ACTIONS = {
  marginTop: 18,
  display: "flex",
  flexDirection: "column",
  gap: 10,
} as const;
const DEV_SEED: string[] = [
  "# Threat model v2\n\nWe assume a powerful network adversary that can observe all traffic and compromise the relay. The vault key never leaves the device.",
  "# Weekly review - 2026-06-15\n\nShipped the sync conflict resolver. Next: mobile share sheet and editor polish.",
  "# Reading - Seeing Like a State\n\nLegibility as the central drive of the modern state. Chapter 1 notes.",
];

/** Title + snippet for a note. Prefers the managed `title:` frontmatter (desktop
 *  convention); otherwise the first heading/line of the body-after-frontmatter.
 *  Snippet is the next non-empty body line (md marks stripped). */

function entryFrom(id: string, text: string): NoteEntry {
  const { title, snippet } = deriveTitleSnippet(text);
  return { id, title: title || "Untitled note", snippet };
}

/** Next unused "Drawing N" title among existing drawing notes, so an inline
 *  `![[Drawing N]]` embed reference is unambiguous (#213). Mobile has no
 *  ref-rewriting rename, so the created name is the one that sticks. */
function nextMobileDrawingTitle(
  notes: readonly NoteEntry[],
  bodies: ReadonlyMap<string, string>,
): string {
  let max = 0;
  for (const n of notes) {
    if (!isDrawingBody(bodies.get(n.id) ?? "")) continue;
    const m = /^Drawing (\d+)$/.exec((n.title ?? "").trim());
    if (m !== null) max = Math.max(max, Number(m[1]));
  }
  return `Drawing ${max + 1}`;
}

/** One index-delta tracker per mount, built lazily - the factory allocates, and
 *  this component re-renders on every keystroke. */
function useIndexDeltaTracker(): IndexDeltaTracker {
  const ref = useRef<IndexDeltaTracker | null>(null);
  if (ref.current === null) ref.current = createIndexDeltaTracker();
  return ref.current;
}


/** The cleared value for a vault-scoped picker set. An empty ARRAY and not
 *  `null`: `null` reaches `<CMEditor>` as an absent prop, which it reads as "no
 *  opinion" and does not dispatch, so the compartment would keep the previous
 *  vault's rows. One shared value rather than a fresh `[]` per site, so the
 *  `[vaultId]` reset does not churn the joins' memo deps. */
const EMPTY_ROWS = Object.freeze([]) as readonly never[];

/** How many times a failed picker read is RE-ISSUED against the same index
 *  value before it gives up until the index next moves. Retries, not attempts:
 *  three retries after the first read, so four reads over roughly six seconds.
 *  Both commands are `Slot::Unlocked`-gated, so the failure this covers is a
 *  read racing an auto-lock: transient, and worth a few seconds rather than a
 *  session.
 *
 *  Exhausting it is not terminal: the budget resets on the next real index
 *  bump, so editing any note recovers both pickers. `vault-pickers.flow.ts`
 *  asserts the stranded state AND that recovery, at a refusal count measured
 *  against the running page rather than computed from this number, because the
 *  boot sweep produces more than one index value. Changing this constant does
 *  not move that fixture's count, so re-measure rather than deriving it. */
const PICKER_FETCH_RETRIES = 3;

/** Trailing throttle for reporting this device's caret to peers. The same 100 ms
 *  the desktop pane uses, which is the awareness coalescing floor (`SYNC-5`): a
 *  caret moved faster than this is reported once, and the supervisor coalesces
 *  further anyway. */
const PRESENCE_REPORT_MS = 100;

/** Delay between those attempts. Long enough that a relock-then-unlock can
 *  complete inside the budget, short enough that a user who opens `[[##`
 *  straight after unlocking does not watch an empty picker. */
const PICKER_FETCH_RETRY_MS = 1_500;

/** One photo-to-note draft, from the picked file until it lands or is discarded.
 *
 *  `id` is null while the import runs, which is what lets the sheet show the
 *  photograph during the seconds OCR takes. `deduplicated` records whether the
 *  vault already held this exact image: `attachment_import` is content-addressed
 *  and returns the existing entry in that case, so the flow does NOT own it and
 *  must never delete it. */
interface PhotoDraft {
  id: string | null;
  filename: string;
  /** A local `blob:` URL for the picked file, revoked when the draft ends. */
  previewUrl: string | null;
  /** The OCR preference as the IMPORT saw it, not as it stands now. */
  ocrEnabled: boolean;
  /** True when the import deduplicated onto an attachment the vault already had. */
  deduplicated: boolean;
}

/** Ids whose delete a LOCK refused, retried on the next mount.
 *
 *  The import runs before the review, so the bytes exist before the user has
 *  agreed to keep them; a lock mid-draft unmounts this flow AFTER the slot has
 *  dropped, so `attachment_delete` is refused and the photograph would otherwise
 *  sit in the library and sync with nothing saying so. The set lives in the
 *  module, which survives a lock in the same process (auto-lock does not kill the
 *  app), and the mount effect below retries it once the vault is unlocked again.
 *  A kill before that next unlock still leaves the import, which is stated in
 *  `decisions/ui/0731` rather than pretended away. */
const pendingPhotoDiscards = new Set<string>();

/** Free a draft's blob URL, if it has one. Guarded because the browser-dev
 *  harness and jsdom do not both provide `URL.createObjectURL`. */
function releasePhotoPreview(url: string | null): void {
  if (url !== null && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
    URL.revokeObjectURL(url);
  }
}
export function EditorFlow({ vaultId: stageVaultId, onLock, onCreateVault, onJoinAccount, onSwitchVault, onDeleteVaultSuccess, onShowApprovalCode }: EditorFlowProps) {
  const { t } = useTranslation();
  // The authoritative active-vault id for every vault-targeting surface below,
  // mirroring `src/screens/Editor.tsx` since myne-md/myne#476. Prefer the id
  // the stage already carries; fall back to the runtime slot ONLY where the
  // stage has none, which is the post-reload editor entry. This client used to
  // pass the possibly-undefined prop straight to the danger-zone delete, and
  // the answer it could have fallen back to, `resolveActiveVaultId()`, sitting
  // uncalled in `lib/vault-list.ts`, was the very function myne-md/myne#250
  // deleted from desktop for ordering the non-authoritative `registry.json`
  // cache, which only the password path ever stamped, so a quick-unlocked or
  // recovered session pointed the delete at another vault (#241).
  const [resolved, setResolved] = useState<VaultId | undefined>(undefined);
  useEffect(() => {
    // Only the fallback lives in state. Mirroring the prop into state as well
    // meant `vaultId` transitioned `undefined -> id` one IPC round-trip after
    // mount on the post-reload path, which re-ran three `vaultId`-keyed effects
    //, including `bumpPrefsNonce()`, where each advance is a full backend
    // round-trip per mounted `usePrefs` (its own docstring says so) and the two
    // fires straddle this await, so the microtask coalescing cannot merge them.
    if (stageVaultId != null) return;
    let cancelled = false;
    void activeVaultId().then((id) => {
      if (!cancelled) setResolved(id ?? undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [stageVaultId]);
  const vaultId = stageVaultId ?? resolved;
  const [view, setView] = useState<"list" | "editor">("list");
  const [tab, setTab] = useState<WorkspaceTab>("notes");
  // Task-view state lives HERE rather than in TaskSurface: every mount below
  // is conditional, so component-local state would reset each time the user
  // leaves and re-enters the destination. One state per scope family, matching
  // desktop's per-tab persistence semantics (myne-md/myne#656 review).
  const [vaultTaskView, setVaultTaskView] = useState<TaskView>(DEFAULT_TASK_VIEW);
  const [noteTaskView, setNoteTaskView] = useState<TaskView>(DEFAULT_TASK_VIEW);
  // Layout axis (SizeClassContext): compact = the phone's full-screen list ⇄
  // editor swap; medium/expanded ("regular") = persistent multi-pane split.
  // `view` stays the compact navigation intent; `editing` drives the detail
  // pane on regular (the invariant `view === "editor" ⟺ editing != null`
  // already holds on compact).
  const { sizeClass } = useSizeClass();
  // `compactWide` is a single column with an overlay list, not a two-pane
  // layout, so "regular" is the medium/expanded pair and nothing else.
  const isRegular = isRegularSizeClass(sizeClass);

  // Slide the incoming tab page in from the side its tab sits on (Notes ← … →
  // Templates). Same Web-Animations technique as the Settings drawer; the first
  // paint and editor round-trips (tab unchanged) don't animate.
  const tabPaneRef = useRef<HTMLDivElement>(null);
  const prevTabRef = useRef(tab);
  useLayoutEffect(() => {
    const prev = prevTabRef.current;
    prevTabRef.current = tab;
    if (tab === prev) return;
    // Regular layouts don't page-flip - the prev ref still updates above so a
    // later rotation back to compact can't replay a stale slide. The folded band
    // DOES page-flip: it is one column with the same list chrome, so a tab switch
    // there is the same navigation the phone does.
    if (isRegular) return;
    const el = tabPaneRef.current;
    if (!el || typeof el.animate !== "function") return;
    const forward = TAB_ORDER[tab] >= TAB_ORDER[prev];
    // Under RTL a "forward" (later) tab enters from the LEFT, so flip the axis.
    const enter = (forward ? 20 : -20) * (isRtl() ? -1 : 1);
    el.animate(
      [
        { opacity: 0, transform: `translateX(${enter}px)` },
        { opacity: 1, transform: "translateX(0)" },
      ],
      // `backwards` fill applies the opacity:0 first frame immediately, so there
      // is no one-frame flash of the fully-opaque new content before the fade.
      { duration: motionDurationMs("--duration-slow"), easing: motionEasing("--ease-emphasized"), fill: "backwards" },
    );
  }, [tab]);

  // Push/pop the whole screen when moving between the note LIST and the EDITOR
  // (iOS nav feel - opening a note pushes in from the right, back pops from the
  // left). Both branches render `<Screen>` in the same slot, so React reuses the
  // element and `screenRef` stays valid across the swap. First paint doesn't run.
  const screenRef = useRef<HTMLDivElement>(null);
  const prevViewRef = useRef(view);
  useLayoutEffect(() => {
    const prev = prevViewRef.current;
    prevViewRef.current = view;
    if (view === prev) return;
    // The push/pop belongs to the compact swap alone: the band's list is a
    // DRAWER over the note, so animating the whole screen when `view` flips
    // would slide the page out from under an overlay. Updating the prev ref
    // unconditionally above prevents a stale animation after a rotation.
    if (sizeClass !== "compact") return;
    const el = screenRef.current;
    if (!el || typeof el.animate !== "function") return;
    const push = view === "editor"; // list → editor is "deeper"
    // RTL flips the depth axis: a deeper screen slides in from the LEFT.
    const enter = (push ? 34 : -34) * (isRtl() ? -1 : 1);
    el.animate(
      [
        { opacity: 0, transform: `translateX(${enter}px)` },
        { opacity: 1, transform: "translateX(0)" },
      ],
      // `backwards` fill = no flash of the fully-opaque incoming screen before
      // the slide starts (the "flash when coming back to the list" bug).
      { duration: motionDurationMs("--duration-slower"), easing: motionEasing("--ease-emphasized"), fill: "backwards" },
    );
  }, [view]);

  const { prefs } = usePrefs();

  // Fold-on-load migration (MYND-562): mobile reads decorations by the folded
  // folder identity, so a legacy display-cased entry (`Work/`) written by the
  // old code must be re-keyed to `work/` or it goes invisible. Idempotent +
  // self-healing (mirrors desktop's `useFolderManagement` effect); persists once
  // when it actually re-keys. Covers the mobile-only user who has no desktop to
  // migrate + sync folded keys.
  useEffect(() => {
    const { next, changed } = foldDecorationKeys(prefs.item_colors);
    if (changed && HAS_TAURI) void setItemColors(next).catch(ignorePrefsWriteFailure);
  }, [prefs.item_colors]);
  useEffect(() => {
    const { next, changed } = foldDecorationKeys(prefs.folder_icons);
    if (changed && HAS_TAURI) void setFolderIcons(next).catch(ignorePrefsWriteFailure);
  }, [prefs.folder_icons]);

  const [notes, setNotes] = useState<NoteEntry[]>([]);
  // Raw note bodies (id → text), kept so the Graph tab can compute the wikilink
  // graph without a second read - the list load already decrypts every note.
  const [bodies, setBodies] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [editing, setEditing] = useState<Editing | null>(null);
  const [readingMode, setReadingMode] = useState(false);
  // Raw (source) vs live-preview inside the editor - toggled from the FormatBar.
  const [rawMode, setRawMode] = useState(false);
  const [editorText, setEditorText] = useState("");
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  // A calm notice, distinct from `editorError`: the live resync rebuilt the note
  // from its session, which is information rather than a failure.
  const [editorNotice, setEditorNotice] = useState<string | null>(null);
  // Drawing dispatch (SF2): a value-strict `kind: drawing` body routes the editor
  // pane to the shared Excalidraw canvas instead of CMEditor (parity w/ PaneView).
  const isDrawing = useMemo(() => isDrawingBody(editorText), [editorText]);

  // The editor body's accessible name (myne-md/myne#728, review). Derived
  // from the LIVE body rather than from a stored field, which is both the
  // only title this flow has (`Editing` carries an id and nothing else) and
  // the better answer: a rename is a body edit, so the name follows it
  // without a reconfigure, which is the thing the desktop had to arrange
  // explicitly. Empty maps to `null`, which the shared namer reads as
  // "untitled" - an `aria-label=""` is not a name.
  const editorTitle = useMemo(
    () => deriveTitleSnippet(editorText).title || null,
    [editorText],
  );

  // Regular size classes: the left panes (nav + note list) stay OPEN when a note
  // is opened, and the editor appears beside them (owner, 2026-11-27: "iPad'de
  // notu açınca default olarak sidebar'ı kapatıyor, bunu yapmamalı, direkt sağda
  // açması lazım"). Collapsing was the old default — the editor took the full
  // width on every note open — which on a portrait tablet threw away the list a
  // person had just tapped in. The toggle in the editor's top bar still hides
  // them deliberately.
  const [panesRevealed, setPanesRevealed] = useState(true);
  // Collapse only for an EXISTING focused note (`editing.id` set) - a brand-new
  // note keeps the list on screen (you're still placing it; matches the tablet
  // flow-logic UX), so `editing?.id` not `editing`.
  const panesCollapsed = isRegular && tab === "notes" && editing?.id != null && !panesRevealed;

  // No-op-write guard: the open note's RAW buffer text as of its last
  // successful read or write, keyed by id so a stale in-flight write can never
  // stamp another note's baseline. Every save path checks it and skips the
  // disk write when the buffer is untouched - a rewrite of identical content
  // would burn a fresh nonce and bump `updated:`, which sync reads as a
  // phantom edit (conflict bait on every open+background). `updated:` is
  // stamped at write time, so the baseline deliberately stores the PRE-stamp
  // buffer and every comparison is raw-vs-raw.
  const loadedTextRef = useRef<{ id: string; text: string } | null>(null);
  /** True when the note's buffer is byte-identical to its last read/written
   *  body - i.e. persisting now would be a pure no-op rewrite. */
  const editorUnchanged = (id: string) =>
    loadedTextRef.current?.id === id && loadedTextRef.current.text === editorText;

  // Flush the open note to disk when the app is BACKGROUNDED / hidden. Mobile
  // otherwise persists only on an explicit exit (back / swipe-back / switching
  // notes) - but a drawing has no such exit on tablet (you just draw and leave),
  // so an edit was lost to an app suspend/kill before it ever hit disk (and thus
  // never synced). This closes that window: best-effort + detached; the foreground
  // sync loop pushes it on resume. `flushRef` reads the latest state so the
  // listeners register once. A brand-new note is create-flushed at most once
  // (guarded) to avoid duplicate blobs across repeated backgrounding.
  const newNoteFlushedRef = useRef(false);
  const liveNoteIdRef = useRef<string | null>(null);
  useEffect(() => {
    newNoteFlushedRef.current = false;
    // Live co-editing: the note on screen holds a live session, and leaving it
    // releases that session. While one is open this device is the note's SINGLE
    // durable writer (`SYNC-33`), and the backend refuses a stateless
    // `note_update` for it, which is why `flushRef` routes through the session
    // below. Best-effort: a drawing note or a locked vault leaves the note
    // untracked and the durable path runs unchanged.
    const next = editing?.id ?? null;
    if (liveNoteIdRef.current !== next) {
      if (liveNoteIdRef.current !== null) void closeLiveNote(liveNoteIdRef.current);
      // Once the session exists, drain it once: a pull that landed between the
      // editor's read and this open is in the session and raised no merge event.
      if (next !== null) void openLiveNote(next).then(() => drainRef.current?.catchUp(next));
      liveNoteIdRef.current = next;
    }
  }, [editing?.id]);
  // The editor leaving the screen releases the session too. Its own effect, so
  // the close is not conditional on a change of `editing.id`.
  useEffect(() => {
    return () => {
      if (liveNoteIdRef.current !== null) void closeLiveNote(liveNoteIdRef.current);
      liveNoteIdRef.current = null;
    };
  }, []);
  // Live-collaboration presence (myne-md/myne#849). The channel is installed for as
  // long as this screen is mounted. The supervisor emits on `sync://awareness` only
  // for notes with an OPEN live session, which is why the session wiring above comes
  // first: before it existed there was nothing for this to consume. The push is bound
  // to the note ON SCREEN, which is what makes a peer editing a different note render
  // nothing here rather than land as a caret on this one.
  useAwarenessChannel();
  useAwarenessLabelResolution(editing?.id ?? null);
  const awarenessPush = useAwarenessForNote(editing?.id ?? null);
  // The roster's peer count (task 6): the same store read the sheet lists from, so
  // the chip cannot appear while the sheet would show nothing.
  const awarenessPeers = useAwarenessPeers(editing?.id ?? null);
  const [presenceOpen, setPresenceOpen] = useState(false);
  // This device's caret/selection, trailing-throttled to the awareness coalescing
  // floor the desktop pane uses, so a fast caret does not flood the IPC and a note
  // with no live session is a no-op at the policy. The refs are what let the
  // timer read the LATEST position rather than the one the first keystroke saw.
  const presenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presenceLastRef = useRef<{
    noteId: string | null;
    cursor: number | null;
    selection: [number, number] | null;
  } | null>(
    null,
  );
  const handleCursorChange = useCallback(
    (cursor: number | null, selection: [number, number] | null) => {
      // The note is captured WITH the position: the timer fires up to one throttle
      // later, and a note switch inside that window would otherwise report this
      // note's offset as presence on the next one (myne-md/myne#849 review).
      presenceLastRef.current = { noteId: liveNoteIdRef.current, cursor, selection };
      // A caret that moved somewhere other than the restored offset is the user
      // typing, and the fold's snapshot is stale from that moment on.
      if (pendingCaretRef.current && cursor !== pendingCaretRef.current.head) {
        pendingCaretRef.current = null;
      }
      if (presenceTimerRef.current !== null) return;
      presenceTimerRef.current = setTimeout(() => {
        presenceTimerRef.current = null;
        const id = liveNoteIdRef.current;
        const latest = presenceLastRef.current;
        if (id === null || latest === null || latest.noteId !== id) return;
        reportLivePresence(id, latest.cursor, latest.selection);
      }, PRESENCE_REPORT_MS);
    },
    [],
  );
  useEffect(
    () => () => {
      if (presenceTimerRef.current !== null) clearTimeout(presenceTimerRef.current);
    },
    [],
  );
  // Deliver a sync pull's merge into the OPEN live note (myne-md/myne#849 review,
  // C2). The cycle already merged it into the session and queued the body diff;
  // this drains it, maps it over the unsaved text this screen holds, and applies it
  // as ONE editor change, so the buffer catches up WITHOUT the reload this screen
  // does not perform, and the next whole-markdown save therefore cannot delete the
  // merged-in peer text. `./lib/liveRemoteMerge.ts` states why the mapping is
  // Needed here, not on desktop: this screen autosaves on a debounce, so a
  // replace that lands mid-write has a save in flight to reconcile with.
  //
  // `sessionMirrorRef` is the screen's record of what the session holds as far as
  // this buffer knows: the text it loaded, then the text each of the screen's OWN
  // saves sent (`editorSave` below), then each merge it applied. Another writer's
  // patch (the cover, a move, a template flag) does NOT move it: the buffer does
  // not hold that change, so the next drain must still see it as remote. The buffer's own
  // latest value is read from the view when one is mounted, and from
  // `editorTextRef` in reading mode, where there is no view to dispatch into.
  const sessionMirrorRef = useRef<{ id: string; text: string } | null>(null);
  const editorTextRef = useRef(editorText);
  editorTextRef.current = editorText;
  // The text this screen's buffer was derived from, handed to every save of the
  // note on screen so the core three-way merges a save from a stale buffer
  // instead of replacing the session's text with it (myne-md/myne#849 review):
  // a peer's change that landed after the last drain survives the save.
  // `undefined` when the screen does not know, which is the plain replace.
  const sessionBaseFor = (id: string): string | undefined =>
    sessionMirrorRef.current?.id === id ? sessionMirrorRef.current.text : undefined;
  const resyncRef = useRef<(id: string) => void>(() => {});
  const drainRef = useRef<RemoteMergeDrain | null>(null);
  // Every save of the buffer goes through here. The mirror moves to the text SENT,
  // not the text the core returns (myne-md/myne#849 review round 4): when the core
  // merged a peer edit into this save, the returned text holds it and the buffer
  // does not, so a mirror at the returned text would hide it from the next drain
  // and the save after that would delete it. At the sent text, the drain diffs the
  // merged-in edit as remote and delivers it. It moves before the save settles,
  // which is what a drain waiting on `settledPatches` relies on.
  const editorSave = (id: string, text: string): Promise<void> =>
    noteUpdate(id, text, undefined, sessionBaseFor(id), () => {
      if (liveNoteIdRef.current === id) sessionMirrorRef.current = { id, text };
    });
  useEffect(() => {
    const drain = installRemoteMergeDrain({
      currentNoteId: () => liveNoteIdRef.current,
      takeSplices: takeRemoteSplices,
      settled: settledPatches,
      patchEpoch,
      readSession: readLiveNote,
      sessionText: (id) =>
        sessionMirrorRef.current?.id === id ? sessionMirrorRef.current.text : null,
      setSessionText: (id, text) => {
        sessionMirrorRef.current = { id, text };
      },
      buffer: () => editorViewRef.current?.state.doc.toString() ?? editorTextRef.current,
      deliver: (splices) => {
        const view = editorViewRef.current;
        if (view !== null) {
          view.dispatch(remoteDispatchSpec(view.state, splices));
          return;
        }
        const next = applySplicesToText(editorTextRef.current, splices);
        editorTextRef.current = next;
        setEditorText(next);
      },
      resync: (id) => resyncRef.current(id),
    });
    drainRef.current = drain;
    return () => {
      drainRef.current = null;
      drain.dispose();
    };
  }, []);
  // The roster's jump target (task 8): the line a peer's caret sits on, revealed
  // once. `nonce` makes a second jump to the SAME line act again, and the shared
  // editor applies it only when `noteId` matches the note it holds.
  const [revealLine, setRevealLine] = useState<{
    noteId: string;
    line: number;
    text: string;
    nonce: number;
  } | null>(null);
  // The listener registers ONCE, so it cannot read `editing`/`editorText` from its
  // closure: this ref is what makes the newest pair visible to it.
  const presenceJumpRef = useRef<{ id: string | null; text: string }>({ id: null, text: "" });
  presenceJumpRef.current = { id: editing?.id ?? null, text: editorText };
  useEffect(() => {
    const onPresenceJump = (e: Event) => {
      const detail = (e as CustomEvent<PresenceJumpDetail>).detail;
      const cur = presenceJumpRef.current;
      // A jump for a note this screen is not showing is IGNORED rather than
      // applied, which is the whole reason the event carries a note id.
      if (detail === undefined || cur.id === null || detail.noteId !== cur.id) return;
      setRevealLine(presenceRevealFor(cur.id, cur.text, detail.offset, Date.now()));
    };
    window.addEventListener(PRESENCE_JUMP_EVENT, onPresenceJump);
    return () => window.removeEventListener(PRESENCE_JUMP_EVENT, onPresenceJump);
    // Deliberately empty: the ref above carries the live values, so re-registering
    // per keystroke is not needed and would be a listener churn this screen cannot
    // afford. The repo has no eslint, so the empty array is the whole convention.
  }, []);
  /** One corpus item, from the same derivation the boot hydrate and the sweep
   *  use, so the tracker's signature means one thing everywhere. */
  const indexCorpusItem = useCallback(
    (id: string, body: string): DeltaItem => ({
      id,
      title: entryFrom(id, body).title,
      folder: readNoteFolder(body),
      body,
    }),
    [],
  );

  /** Bring the RAM index level with a body this flush just handed to disk.
   *
   *  `vault_indices_persist` pairs a manifest scanned from disk at call time
   *  with the RAM records. A flush writes the open note's body (fresh
   *  `content_nonce`) and the index moves only on the sweep's 400 ms debounce,
   *  so without this the pair can persist a pre-edit record under a post-edit
   *  nonce, and the next unlock would trust it. Desktop keeps the same order
   *  its own way: autosave reindexes the note, and the only persist call site
   *  is the graceful-exit flush chain, never a per-edit write. Returns false
   *  when the apply failed, which tells the caller to skip the persist: an old
   *  record under a new nonce is the one shape the staleness check cannot
   *  see. */
  const applyOpenNoteToIndex = async (id: string, body: string): Promise<boolean> => {
    const item = indexCorpusItem(id, body);
    try {
      await vaultIndicesApply(extractRecord(item.id, item.title, item.folder, item.body));
      indicesDelta.markApplied(item);
      noteVaultIndicesChanged();
      return true;
    } catch {
      return false;
    }
  };

  /** Notes minted by this flush. They are applied and tracked by id, but they
   *  are not in `resolverNotes`/`bodies` yet, so both corpora below splice them
   *  in: otherwise `diff` reports them as REMOVED and the sweep undoes the very
   *  record the flush just wrote. */
  const seamCreatedRef = useRef<DeltaItem[]>([]);
  const flushRef = useRef<() => Promise<boolean>>(async () => true);
  flushRef.current = async () => {
    if (!HAS_TAURI || !editing) return true;
    if (editing.id != null) {
      const id = editing.id;
      const raw = editorText;
      // Untouched since load / last write → nothing to persist. Updating the
      // baseline BEFORE the write resolves also collapses the visibilitychange
      // + pagehide double-fire into a single write.
      if (editorUnchanged(id)) return true;
      loadedTextRef.current = { id, text: raw };
      // Through `editorSave`, like every other save on this screen (review
      // finding): this is the one write that runs when the OS is about to kill
      // the WebView, and a bare `noteUpdate` passes no merge base, so a peer edit
      // merged into the session and not yet drained would be replaced rather than
      // merged, and the mirror would not move, which makes the next save duplicate
      // the text it flushed.
      try {
        await editorSave(id, stampUpdated(raw));
      } catch {
        // Failed write: drop the baseline so a later flush/save retries.
        if (loadedTextRef.current?.id === id) loadedTextRef.current = null;
        return false;
      }
      return await applyOpenNoteToIndex(id, raw);
    }
    if (editorText.trim() !== "" && !newNoteFlushedRef.current) {
      newNoteFlushedRef.current = true;
      // The folder comes off the body being flushed, so a note backgrounded
      // before its first save registers its folder exactly as a saved one does.
      // It did not, which made the folder's survival depend on whether the user
      // pressed save or the OS took the app away (myne#613 review round 2).
      const flushed = stampUpdated(editorText);
      try {
        const id = await noteCreate(flushed, readNoteFolder(flushed) || null);
        const applied = await applyOpenNoteToIndex(id, flushed);
        if (applied) seamCreatedRef.current.push(indexCorpusItem(id, flushed));
        return applied;
      } catch {
        newNoteFlushedRef.current = false;
        return false;
      }
    }
    return true;
  };
  useEffect(() => {
    // ONE listener pair for the whole app-background moment. Everything that must
    // reach disk before an OS kill hangs off it: the open note's body, and the
    // sidebar folder-expand set (MYND-561 - `vault.workspace`'s only other write
    // seam is `lockVault()`). Both are best-effort and independent; neither can
    // block the other, and a second registration for the same event would just be
    // two ways to get the same moment wrong.
    const flushAll = () => {
      // MYI1 on the same seam, and ORDERED behind the body write rather than
      // beside it. A phone is BACKGROUNDED rather than closed, and an OS kill
      // of a backgrounded WebView is the normal way the process ends, so this
      // is mobile's graceful exit: write the index while the slot is unlocked.
      // The flush returns false when it could not make the index level with
      // the bytes it wrote, and persisting a lagging index is the one shape
      // hydrate cannot detect, so that case writes nothing.
      void (async () => {
        if (!(await flushRef.current())) return;
        // `flushVaultIndicesPersistNow` runs the registered leveller first, so
        // the write only happens when the RAM index is level with disk; a
        // failed pass writes nothing (§9.8.4: rebuild is the fail direction).
        await flushVaultIndicesPersistNow();
      })();
      void flushWorkspaceNow();
      // Settled chat turns a backgrounding interrupted (myne-md/myne#675): the
      // AI flow stages its transcript on every settle and this flushes what is
      // still staged. Best-effort and independent like its neighbours; a run
      // lost to the pocket keeps its settled turns.
      void flushChatHistoryNow();
      // **Not a flush.** The other two here are writes racing an OS kill; this
      // is a drop. The OS suspends a backgrounded WebView and may reclaim the
      // process, so an in-flight run's reply can simply never arrive, leaving a
      // screen that says "Working" forever over a provider that may still be
      // charging for it. Cancel it, clear the note-derived plaintext, and leave
      // a notice: the user is coming back to this screen and is owed a reason
      // for it being empty.
      endAgentRun("background", t("agent.progress.cancelledBackground"));
      // The live-presence store too (myne-md/myne#849 task 9), and for the same
      // reason the run above is cancelled rather than flushed: the OS suspends a
      // backgrounded WebView and may reclaim the process, so peers' names and
      // carets left in a module-scope store are a record of who was editing what,
      // resident in a process nobody is watching. Desktop has no analogue of this
      // moment, so this is the one leaving path that exists on this client alone.
      // Coming back repopulates it: `sync_lifecycle_resume` marks every open session
      // as owing a JOIN, and a join is what makes peers re-announce (`SYNC-29`), so
      // an idle peer who never moved their caret reappears too. Without that, a hide
      // too short to tear the stream down left them missing until they moved
      // (myne-md/myne#849 review, D7).
      clearAwareness();
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") flushAll();
    };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", flushAll);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", flushAll);
    };
  }, [t]);

  // "Back to the list" means two different things by layout. On the phone it is
  // the save-then-pop contract: the note closes and the list replaces it. In the
  // folded band the note must STAY MOUNTED under the drawer, so it is pure
  // navigation: no write, no `exitEditor` (which clears `editing` and would take
  // the page out from under the overlay). The bytes are safe either way, because
  // the background flush and the note's own save paths own them.
  const openList = () => {
    if (sizeClass === "compactWide") {
      // Navigation, not exit: the note stays mounted under the drawer, and the
      // bytes are not written here. Every control in that drawer that REPLACES
      // the buffer writes it first through `persistOpenBuffer`, which is the
      // only place the write is actually owed.
      setView("list");
      return;
    }
    void saveNote();
  };

  // Compact-only left-edge swipe-back: same semantics as the top-bar chevron
  // (autosave + return to the list), same busy guard. `saveNote` is a hoisted
  // function declaration, so referencing it here is fine.
  useSwipeBack(
    screenRef,
    () => {
      if (sizeClass === "compactWide") {
        setView("list");
        return;
      }
      if (!editorBusy) void saveNote();
    },
    !isRegular && view === "editor",
  );
  // Attachment insert: the editor textarea + hidden file input, and a busy flag
  // while the picked file is encrypted (MYA1) on the host.
  const attachInputRef = useRef<HTMLInputElement>(null);
  const [attaching, setAttaching] = useState(false);
  // Photo to note (myne-md/myne#926): the camera/library input, and the one
  // attachment this flow imported and has not committed yet. `photoNote`
  // non-null IS the draft sheet being open.
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [photoNote, setPhotoNote] = useState<PhotoDraft | null>(null);
  // Whether the open draft already landed. A ref, because the unmount cleanup
  // reads it in a closure registered once, and because React's own unmount is
  // what runs it.
  const photoNoteCommittedRef = useRef(false);
  // The user backed out while the import was still running, so its result must
  // be undone rather than shown.
  const photoNoteCancelledRef = useRef(false);
  // The same value, in a ref, for the unmount cleanup below: it must not delete
  // an attachment it no longer owns, and a stale closure would.
  const photoNoteRef = useRef<PhotoDraft | null>(null);
  photoNoteRef.current = photoNote;
  // A lock unmounts this flow mid-import; the resolve has to know.
  const editorMountedRef = useRef(true);
  // The live CMEditor view, handed over via <CMEditor onReady>. Drives the
  // above-keyboard FormatBar through the shared @myne/editor commands.
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  // The same view, in a ref, for the listeners below: they are registered ONCE, so
  // they cannot read a state value from their closure.
  const editorViewRef = useRef<EditorView | null>(null);
  // The element that actually scrolls the note (the pane's `.m-scroll`
  // wrapper). The fold hands the reader's position across a remount through it.
  const editorScrollRef = useRef<HTMLDivElement | null>(null);
  // The size class the CURRENT tree was rendered for, and the offsets captured
  // when it changed (caretRestore.ts). `null` means there was nothing to carry.
  const lastSizeClassRef = useRef(sizeClass);
  const pendingCaretRef = useRef<CaretSnapshot | null>(null);
  const [manageAttachments, setManageAttachments] = useState(false);
  // Voice-note recording sheet open (mic button / widget voice capture / the
  // shared editor's `/record` slash all raise this).
  const [recordOpen, setRecordOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // **The note the AI tab runs over, which is NOT `editing`.** On a phone the
  // editor REPLACES the list, so the bottom bar (and therefore the AI tab) is
  // only reachable with no note on screen, and `exitEditor` clears `editing`.
  // Deriving the default scope from `editing` alone therefore meant the tab
  // ALWAYS had a null scope: Send was disabled on every phone and an agent run
  // was unreachable. Found by the /simplify pass, after the same pass corrected
  // the other half of this (the vault-wide fallback the host refuses).
  //
  // "The note you were just working in" is the honest mobile analogue of
  // desktop's "the note open in a pane", which is what its composer uses. It is
  // RAM only and lives as long as this component, so it goes with the vault: a
  // lock or a switch unmounts `EditorFlow`.
  const [lastNoteId, setLastNoteId] = useState<string | null>(null);
  // Editor side panel (mobile stand-in for the desktop side sheet): note
  // context + actions, sliding in from the right.
  const [rightPanel, setRightPanel] = useState(false);
  // Note actions overflow (⋯): Copy / Move / History / Export / Archive / Trash.
  const [moreOpen, setMoreOpen] = useState(false);
  // The note cover's picker (myne-md/myne#410). `| null` rather than an `open`
  // flag: `hasCover` only means anything while it is open, and it comes from the
  // editor, which has just resolved the field. The shell cannot see it.
  // `noteId` is the note the sheet was opened FOR; `null` means the entry point
  // did not name one and the open note is the target (myne-md/myne#520).
  const [coverPicker, setCoverPicker] = useState<
    { hasCover: boolean; noteId: string | null } | null
  >(null);
  // MYND-620 task 4: the phone's answer to the desktop's note-scoped side panel.
  // There is no permanently-visible panel beside an editor on a phone, so the
  // same information arrives as a sheet on request - the established mechanism
  // that attachments, snapshots, templates, settings and the view editor all
  // already use.
  const [noteTasksOpen, setNoteTasksOpen] = useState(false);
  // Long-press action sheet target: the list-row note whose actions are open.
  const [rowActions, setRowActions] = useState<NoteEntry | null>(null);
  // Backend vault-indices edge dump (null until the first sweep; drives the
  // Turkish-correct graph + backlinks). Falls back to the client graph in dev.
  const [backendEdges, setBackendEdges] = useState<[string, WikilinkEdge[]][] | null>(null);
  // MYI1 fast path (protocol.md §9.8): the delta sweep below may not seed its
  // tracker until the persisted index has been hydrated and the tracker has
  // been told which records the host already holds. `pending` gates the sweep;
  // a failed hydrate still resolves it to `ready` with an empty tracker, which
  // is the specification's fall-to-rebuild rather than an error state.
  const [indicesHydration, setIndicesHydration] = useState<"pending" | "ready">(
    HAS_TAURI ? "pending" : "ready",
  );
  // Bumped on every vault change; a hydrate that resolves across one is
  // dropped rather than seeding the new vault's tracker with the old ids.
  const indicesHydrationGen = useRef(0);
  // myne-md/myne#452: the two whole-vault picker sets, raw as the index returns
  // them. Empty until a read lands, and empty again whenever the vault changes.
  //
  // There is deliberately no "not read yet" state distinct from "read and
  // empty". Neither is observable (see `EMPTY_ROWS`: both render zero rows), and
  // the `[vaultId]` effect below runs in the first effect flush, before the
  // debounced read is issued, so a `null` initialiser would survive one frame.
  // Reintroducing the distinction needs BOTH a mount guard on that effect and a
  // consumer that can tell the two apart. Today nothing can.
  const [headingRows, setHeadingRows] = useState<readonly VaultHeadingRow[]>(EMPTY_ROWS);
  const [blockAnchorRows, setBlockAnchorRows] = useState<readonly VaultBlockAnchor[]>(EMPTY_ROWS);
  // The refresh key those reads are keyed on: the sweep below bumps it in
  // lockstep with the delta tracker, so every reader re-queries once the index
  // moved. Desktop's counterpart is the module-scope SYNC-5 nonce in
  // `src/notes/vaultIndices.ts`, which this client does not use and could not
  // share: this one is vault-scoped, resettable, and carries a retry budget the
  // desktop counter has no equivalent of.
  //
  // `attempt` rides along so a FAILED read can re-issue without pretending the
  // index moved. Every real bump resets it to 0, so the budget is per index
  // change rather than per session.
  const [pickerFetch, setPickerFetch] = useState<{ index: number; attempt: number }>({
    index: 0,
    attempt: 0,
  });
  // Monotonic, so a read that resolves after a newer one is DISCARDED rather
  // than the newer one being cancelled (desktop's `useVaultHeadings` guard).
  const pickerFetchSeq = useRef(0);
  // Permanent-delete confirm target: a note id being purged from Trash, or null.
  const [purgeId, setPurgeId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * The identity-unlock door Settings → Sync opens (myne-md/myne#1029).
   *
   * Mounted HERE rather than at the shell, and the placement is the fix's other
   * half: a blocked sync row is one that names "unlock your identity", and the
   * phone had no surface that could perform the act because `IdentityFlow` mounted
   * on the zero-vault stage only. Rendering it from the shell instead would mean
   * `StageSwitch` returns the overlay INSTEAD of the editor, which unmounts this
   * component and loses `editing`, the note the user was reading, every time they
   * opened the door. As an overlay beside the Settings sheet the editor stays
   * mounted, and `.m-screen` is `position: relative`, so `inset: 0` covers it.
   */
  const [identityDoorOpen, setIdentityDoorOpen] = useState(false);
  // First-run AI onboarding (myne-md/myne#805): offered once per device, from the
  // Settings AI row rather than on unlock (owner, 2026-11-10). It used to open on
  // the editor's mount, so the second a vault unlocked a sheet about AI covered the
  // notes; the localStorage flag is still written when the sheet closes, and the row
  // is what decides whether to offer it (`SettingsSheet`'s `onAiOnboarding`).
  const [aiOnboardingOpen, setAiOnboardingOpen] = useState(false);
  // Panel the next SettingsSheet opens on; the onboarding's provider button
  // routes straight to `ai`, the bar entry leaves it `root`.
  const [settingsPanel, setSettingsPanel] = useState<Panel | undefined>(undefined);
  // SY-08 sync status detail sheet (MYND-461 T6), opened from the header glyph.
  // Conflicts sheet (MYND-461 T8), opened from the conflicts count banner.
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [vaults, setVaults] = useState<VaultSummary[]>([]);
  // Active `#tag` filter on the notes list (folded/lowercase key), or null.
  const [activeTag, setActiveTag] = useState<string | null>(null);

  // Which slice of the notes tab is shown: live notes / archive / trash.
  const [listView, setListView] = useState<"notes" | "archive" | "trash">("notes");

  // MYND-620 task 7: a reminder tapped while locked lands here, once, after
  // unlock. The editor mounts on every unlock path, which is the same seam the
  // watch-capture drain and the share-import drain already use.
  //
  // The latch is consumed even when it cannot be resolved: one that survived a
  // failed resolution would fire again on the next unlock and send the user
  // somewhere they did not ask to go a second time.
  useEffect(() => {
    let live = true;
    void (async () => {
      const landing = takeReminderLanding(await vaultTasks());
      if (!live || landing.kind === "none") return;
      // Either way the notification led somewhere: to the task's note when the
      // identifier still names one, and to the Tasks list when it does not -
      // which is where that task would have been.
      setTab("tasks");
      if (landing.kind === "task") void openNote(landing.task.noteId);
    })();
    return () => {
      live = false;
    };
    // Mount only: this is the unlock moment, not a subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Archive-view folder drill (MYND-470): null = archive root (folder rows +
  // loose archived notes); a folder path = browsing that archived folder's notes.
  const [archiveFolder, setArchiveFolder] = useState<string | null>(null);
  // Edge-swipe back (myne-md/myne#970 item 24). Scoped to the list views that
  // HAVE a back: Notes is the root, so a swipe there has nowhere to go, and the
  // editor's own surfaces (a sheet, the tag chip row) must not be closed by a
  // gesture that started in the middle of them. The hook only listens in the
  // first 28px of the pane, which is why attaching it here cannot fight a row's
  // swipe actions.
  //
  // Inside an archive folder the swipe goes up one level, to the archive root
  // rather than straight out to Notes, so it mirrors the visible back control
  // (`archive.folder-back`) exactly.
  const edgeSwipeBack = useEdgeSwipeBack(
    tab === "notes" && listView !== "notes"
      ? () => {
          if (listView === "archive" && archiveFolder !== null) {
            setArchiveFolder(null);
            return;
          }
          setListView("notes");
        }
      : null,
  );
  // Folder path armed for the inline "Move N notes to Trash?" confirm (null = none).
  const [confirmArchiveFolder, setConfirmArchiveFolder] = useState<string | null>(null);
  // Current folder for NEW-note placement (root by default; the tree no longer
  // drills, so this stays null unless a future "new note in folder" sets it).
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  // OPEN folders in the inline hierarchy, keyed by folded folder identity
  // (MYND-561). Owned by a module store - not `useState` - and persisted into the
  // `vault.workspace` container so the set survives a restart; see
  // `lib/folder-expand-store.ts` for why the store owns it and
  // `lib/workspace-persist.ts` for the encoding + write cadence. Polarity is
  // desktop's (present = expanded, empty = all collapsed), so a cold vault opens
  // collapsed on both clients. The list is a tree, not a drill-down.
  const expandedFolders = useExpandedFolders();
  // Filter sheet (the single home for Tags / Views / Archive / Trash).
  const [filterOpen, setFilterOpen] = useState(false);
  // Sort sheet - the sort-order picker (same modal treatment as Filter).

  // Views sheet - browse/activate saved views + create a new one.
  const [viewsOpen, setViewsOpen] = useState(false);
  // Inline note-list search (filters THIS page's list; NOT the command palette).
  const [searchQuery, setSearchQuery] = useState("");
  // Command palette - opened from the header button (left of Settings).
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Tag Browser (multi-select tag filter → matching notes; desktop bottom-bar port).
  const [tagBrowserOpen, setTagBrowserOpen] = useState(false);
  // Editor "Move to folder": the note id being moved + the folder-path input.
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const [moveInput, setMoveInput] = useState("");
  // Folder create + long-press actions (MYND-473 / MYND-480).
  const [folderActions, setFolderActions] = useState<{ path: string; name: string } | null>(null);
  // Folder delete confirmation (myne-md/myne#628). The desktop has asked before
  // moving a non-empty folder's subtree to Trash since MYND-133; mobile's danger
  // row called the delete straight through, so the same action was one tap here
  // and a dialog there. Carries the note count so the sheet can name what goes.
  const [folderTrash, setFolderTrash] = useState<
    { path: string; name: string; noteCount: number } | null
  >(null);
  const [folderPrompt, setFolderPrompt] = useState<
    | { mode: "new" }
    | { mode: "subfolder"; parent: string }
    | { mode: "rename"; path: string }
    | null
  >(null);
  const [folderPromptInput, setFolderPromptInput] = useState("");
  // Focus the name field AFTER the sheet has finished sliding in (owner,
  // 2026-11-27 round 2: the new-folder screen "bütün render olan ekranı yukarı
  // itiyor sonra geri jumplıyor"). iOS raises the keyboard the moment a field
  // takes focus, and the app's height follows the visual viewport, so an
  // `autoFocus` inside a sheet that is still animating shrank the whole screen
  // mid-slide and released it a frame later. Waiting for the enter transition is
  // the standard shape: the sheet lands, then the keyboard rises under it.
  const folderPromptInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!folderPrompt) return;
    const handle = window.setTimeout(() => folderPromptInputRef.current?.focus(), 280);
    return () => window.clearTimeout(handle);
  }, [folderPrompt]);
  // Color / folder-icon picker target (MYND-516) - a note (color only) or a
  // folder (color + icon). Opened from the long-press action sheets.
  const [decoTarget, setDecoTarget] = useState<
    | { kind: "note"; id: string }
    | { kind: "folder"; path: string }
    | null
  >(null);
  // Home quick-action tiles hidden per-tile from Settings → Appearance (MYND-479).
  const hiddenHomeTiles = useHiddenHomeTiles();
  // Active saved view (its id) filtering the notes list, or null. Mutually
  // exclusive with the folder drill-down + tag filter.
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  // The view-editor sheet: `{ initial }` open (null initial = create), or null.
  const [viewEditor, setViewEditor] = useState<{ initial: SavedView | null } | null>(null);
  // Vault property-key universe for the view editor's group / sort / column
  // pickers (the `vault_indices_property_keys` accessor). Loaded when the editor
  // sheet opens (fresh, so the pickers reflect the current index).
  const [viewPropertyKeys, setViewPropertyKeys] = useState<string[]>([]);

  // ── Folder-expand persistence (MYND-561) ─────────────────────────────────────
  // Restore the open-folder set from `vault.workspace` once per unlock session.
  // The store is the single owner, so this is a plain replace with disk truth -
  // no mount-order ref, and a toggle that beats it just gets overwritten (same
  // outcome as a cold start).
  //
  // The WRITE side rides the app-background listener above (and `lockVault()`).
  // Per-toggle writes are deliberately NOT a seam: `vault.workspace`'s mtime is
  // visible to an adversary with filesystem access even though its contents are
  // sealed, and desktop keeps that mtime from becoming an activity log by writing
  // on graceful exit only (design grill 2026-06-01 Q1). Backgrounding is the
  // mobile equivalent - an OS kill of a backgrounded app is the normal way a
  // mobile app dies.
  useEffect(() => {
    void ensureWorkspaceHydrated();
  }, []);

  useEffect(() => {
    if (viewEditor === null) return;
    let cancelled = false;
    void vaultIndicesPropertyKeys()
      .then((keys) => {
        if (!cancelled) setViewPropertyKeys(keys);
      })
      .catch(() => {
        /* index hiccup → empty pickers; tag/folder/search conditions still work */
      });
    return () => {
      cancelled = true;
    };
  }, [viewEditor]);


  // Managed frontmatter flags per note (trashed/archived/template/…) - the
  // live-set gate for the main list + the trash/archive views.
  const noteFlags = useMemo(() => {
    const m = new Map<string, NoteFlags>();
    for (const n of notes) m.set(n.id, readNoteFlags(bodies.get(n.id) ?? ""));
    return m;
  }, [notes, bodies]);
  // Last-edited (`updated:`) timestamp per note → the note-list row subtitle
  // (desktop-parity meta; replaces the body snippet). Null when unset/invalid.
  const updatedById = useMemo(() => {
    const m = new Map<string, Date | null>();
    for (const n of notes) {
      const iso = readUpdatedFromFmBody(frontmatterBody(bodies.get(n.id) ?? ""));
      m.set(n.id, iso ? new Date(iso) : null);
    }
    return m;
  }, [notes, bodies]);
  // An EVENT belongs to the calendar, not the notes list (myne-md/myne#1037).
  // Deliberately NOT in `isLiveNote`: the host's calendar read skips a record whose
  // `live` flag is false. `resolverNotes` is untouched, so it still resolves.
  const liveNotes = useMemo(
    () =>
      notes.filter((n) => {
        const flags = noteFlags.get(n.id);
        return flags !== undefined && flags.kind !== "event" && isLiveNote(flags);
      }),
    [notes, noteFlags],
  );
  // The note-set every RESOLVER surface runs against (graph, backlinks, the
  // vault-indices sweep) - desktop's `resolverCache` rule, verbatim
  // (`src/notes/sidebarState.tsx`): trashed / soft-deleted / template /
  // conflict-copy out, **archived IN**. An archived note is hidden from the
  // working-set list but must still resolve as a link target and appear in the
  // graph, which is the two-axis split desktop settled on and this client used
  // to get wrong by reusing `liveNotes` here (myne-md/myne#199).
  // `folderIndex` is false for every note: mobile has no folder-note
  // designation UI, the same value `deriveTree` already passes.
  const resolverNotes = useMemo(
    () =>
      notes
        // #260: the shared predicate, so the resolver's admission rule cannot
        // drift from desktop's again. Archived notes stay resolvable - archive
        // is a working-set filter, not a deletion.
        .filter((n) => {
          const f = noteFlags.get(n.id);
          return f !== undefined && isResolverCandidate(f);
        })
        .map((n) => ({
          noteUuid: n.id,
          title: n.title || null,
          folder: readNoteFolder(bodies.get(n.id) ?? ""),
          folderIndex: false,
        })),
    [notes, noteFlags, bodies],
  );
  // The note names a chat answer may turn into a link (myne-md/myne#867).
  // Built from `resolverNotes` rather than from `liveNotes`, and that is the
  // desktop's own choice: an ARCHIVED note is hidden from the list but is still
  // a note a model can name, so a link to it must work. The matcher's three
  // boundary rules are the shared ones (`@myne/note-mentions`), because the
  // failure they prevent is opening a note nobody named.
  const mentionTargets = useMemo(
    () => buildMentionTargets(resolverNotes),
    [resolverNotes],
  );
  // #46: `isTrashedNote` excludes TOMBSTONES (`deleted:`). Without that clause
  // "Delete permanently" was a visible no-op - the tombstone it writes left the
  // row rendered, so the note looked like it was still in the trash.
  const trashedNotes = useMemo(
    () => notes.filter((n) => isTrashedNote(noteFlags.get(n.id) ?? {})),
    [notes, noteFlags],
  );
  const archivedNotes = useMemo(
    () => notes.filter((n) => isArchivedNote(noteFlags.get(n.id) ?? {})),
    [notes, noteFlags],
  );
  // Template notes (`template: true`) - excluded from the live list; managed via
  // the Templates sheet + instantiated by the daily-note engine.
  const templateNotes = useMemo(
    () =>
      notes
        .filter((n) => isListedTemplate(noteFlags.get(n.id) ?? {}))
        .map((n) => ({ id: n.id, title: deriveTitleSnippet(bodies.get(n.id) ?? "").title })),
    [notes, noteFlags, bodies],
  );

  // Folder path per live note (from `folder:` frontmatter) - the drill-down tree.
  const folderOf = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const n of liveNotes) m.set(n.id, readNoteFolder(bodies.get(n.id) ?? ""));
    return m;
  }, [liveNotes, bodies]);

  // The DELETE path: `folderOf` hides events, so their folder would read as empty.
  const folderOfAll = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const n of resolverNotes) m.set(n.noteUuid, readNoteFolder(bodies.get(n.noteUuid) ?? ""));
    return m;
  }, [resolverNotes, bodies]);

  // The interleave cache (MYND-596): note id → `updatedAt`, the recency key the
  // shared `orderContainerChildren` reads for unlisted notes. A superset (all
  // notes) is fine - the ranker only touches the ids a container actually holds.
  const orderCache = useMemo<Map<string, OrderedNoteRecord>>(
    () => new Map(notes.map((n) => [n.id, { updatedAt: updatedById.get(n.id) ?? null }])),
    [notes, updatedById],
  );
  // The FULL folder tree (fav/archive-unfiltered) - the reorder handlers resolve
  // a row's true `item_order` container against it, so a nudge is relative to the
  // note's real manual neighbours even when the fav strip hides some of them.
  // `[]` for the archived set is deliberate and load-bearing here: this tree
  // exists to resolve a row's TRUE container, so it must keep the folders the
  // working-set tree hides.
  const fullTree = useMemo(
    () => deriveTree(folderOf, prefs.deliberate_folders, []),
    [folderOf, prefs.deliberate_folders],
  );

  // Folder-archive (MYND-470): the synced `archived_folders` set decluttered from
  // the working tree. A note under an archived folder keeps NO note-level flag
  // (folder-archive never rewrites notes), so it sits in `liveNotes` - split those
  // out so the Notes tree hides them (matching desktop) while they stay live +
  // resolvable (graph/tags/search), and browse them under the Archive view.
  const archivedKeys = useMemo(
    () => archivedFolderKeys(prefs.archived_folders),
    [prefs.archived_folders],
  );
  // Live notes hidden by folder-archive (id → folder), and the working set that
  // remains after removing them. Empty `archivedKeys` → no split (zero overhead).
  const folderArchivedOf = useMemo(() => {
    const m = new Map<string, string | null>();
    if (archivedKeys.length === 0) return m;
    for (const n of liveNotes) {
      const f = folderOf.get(n.id) ?? null;
      if (isNoteFolderArchived(f, archivedKeys)) m.set(n.id, f);
    }
    return m;
  }, [liveNotes, folderOf, archivedKeys]);
  const workingNotes = useMemo(
    () => (folderArchivedOf.size === 0 ? liveNotes : liveNotes.filter((n) => !folderArchivedOf.has(n.id))),
    [liveNotes, folderArchivedOf],
  );
  // The note→folder map with folder-archived notes removed - the map every
  // working-set query resolves against (desktop's `liveCache(cache, archivedKeys)`
  // equivalent). The unfiltered `folderOf` stays for the Archive view, which is
  // the one surface that must still see them.
  const workingFolderOf = useMemo(
    () =>
      folderArchivedOf.size === 0
        ? folderOf
        : new Map([...folderOf].filter(([id]) => !folderArchivedOf.has(id))),
    [folderOf, folderArchivedOf],
  );
  // Top-level archived folders (nested ones fold under their ancestor) for the
  // Archive view's folder rows.
  const archivedFolders = useMemo(
    () => topLevelArchivedFolders(prefs.archived_folders),
    [prefs.archived_folders],
  );
  // Folder of each note shown by the Archive view - folder-archived LIVE notes
  // plus note-flag `archived:` notes - so the root can drop notes already under a
  // folder row, and a folder drill can gather its subtree. id → folder.
  const archiveNoteFolderOf = useMemo(() => {
    const m = new Map<string, string | null>(folderArchivedOf);
    for (const n of archivedNotes) m.set(n.id, readNoteFolder(bodies.get(n.id) ?? ""));
    return m;
  }, [folderArchivedOf, archivedNotes, bodies]);
  // Leaving the Archive view resets the folder drill + any armed delete confirm,
  // so re-entering Archive always starts at its root.
  useEffect(() => {
    if (listView !== "archive") {
      setArchiveFolder(null);
      setConfirmArchiveFolder(null);
    }
  }, [listView]);

  // The wikilink graph over the RESOLVER note-set. The Graph tab renders the
  // shared MODEL directly (the shared canvas takes it as-is); the in-editor
  // "Linked from" list reads the projection. One build, both consumers.
  const { graph: noteGraph, model: graphModel } = useMemo(
    () => buildNoteGraphAndModel(resolverNotes, backendEdges ?? clientEdges(resolverNotes, bodies)),
    [backendEdges, resolverNotes, bodies],
  );
  // The `#tag` index over the LIVE notes - drives the notes-list tag filter.
  const tagIndex = useMemo(() => buildTagIndex(liveNotes, bodies), [liveNotes, bodies]);
  // The graph's tag inputs (myne-md/myne#727): the same index the tag browser
  // uses, turned into the two shapes the SHARED overlay builder takes. Computed
  // here rather than in the graph tab because this is where the index lives, and
  // `tagIndexToGraphTags` derives the subtree-inclusive count the Rust tag tree
  // reports on desktop, so both clients agree about which tags qualify for the
  // derived default grouping.
  const graphTags = useMemo(
    () =>
      tagIndexToGraphTags(
        tagIndex.byTag,
        new Map(tagIndex.tags.map(({ tag }) => [foldSegment(tag), tag])),
      ),
    [tagIndex],
  );
  // The scope strip's tag half. `noteTags` is already built for the tag browser;
  // a second derivation would be a second answer to "what tags does this note
  // carry".
  const tagsOfNote = useCallback(
    (noteId: string): readonly string[] => tagIndex.noteTags.get(noteId) ?? [],
    [tagIndex],
  );

  // Publish the live tags into the shared editor host so the in-editor `#tag`
  // autocomplete suggests the vault's existing tags (flat; folded key for match,
  // first-seen casing for display).
  useEffect(() => {
    publishEditorTagTree(
      tagIndex.tags.map(({ tag, count }) => ({
        key: foldSegment(tag),
        display: tag,
        depth: 0,
        directCount: count,
        subtreeCount: count,
      })),
    );
  }, [tagIndex]);

  // Saved views (prefs.saved_views) in display order (view_order first, then any
  // id not yet ordered - e.g. a view authored on another client).
  const orderedViews = useMemo(() => {
    const byId = new Map(prefs.saved_views.map((v) => [v.id, v]));
    const seen = new Set<string>();
    const out: SavedView[] = [];
    for (const id of prefs.view_order) {
      const v = byId.get(id);
      if (v && !seen.has(id)) {
        out.push(v);
        seen.add(id);
      }
    }
    for (const v of prefs.saved_views) if (!seen.has(v.id)) out.push(v);
    return out;
  }, [prefs.saved_views, prefs.view_order]);
  const activeView = useMemo(
    () => orderedViews.find((v) => v.id === activeViewId) ?? null,
    [orderedViews, activeViewId],
  );
  // The active view's grouped/sorted rows, computed by the SHARED query engine
  // (`runView`) over the same resolvers the tag/folder chips use - so a saved
  // view honours view_type + group_by + sort + columns identically to desktop.
  // The `property` leaf + grouping/sort/columns now resolve against the MYI1
  // property index (which the mobile sweep feeds since MYND-277/278). Null when
  // no view is active. `runView` never throws (locked vault → empty groups).
  const viewCtx = useMemo<RunViewContext | null>(() => {
    if (!activeView) return null;
    // The working set, NOT `liveNotes`: a folder-archived note carries no
    // note-level marker, so it stays in `liveNotes` and a saved view would list
    // notes the tree has hidden (myne-md/myne-mobile#39). Desktop intersects
    // through `liveCache(cache, archivedKeys)` for the same reason.
    const liveIds = new Set(workingNotes.map((n) => n.id));
    const titleById = new Map(notes.map((n) => [n.id, n.title]));
    return {
      liveIds,
      resolvers: {
        // The shared engine passes the raw tag; mobile's tag index is keyed by
        // the folded form (the desktop `byTag` folds internally), so fold here.
        hasTag: async (tag) => tagIndex.byTag.get(foldSegment(tag)) ?? [],
        inFolder: async (path) => notesInSubtree(workingFolderOf, path),
        search: async (query) => searchNotes(query, workingNotes, bodies).map((h) => h.id),
        propertyValues: (key) => vaultIndicesPropertyValues(key),
      },
      rowFor: (id) => ({
        title: titleById.get(id) ?? null,
        folder: folderOf.get(id) ?? null,
      }),
      recencyFallback: (ids) => {
        const at = (id: string) => updatedById.get(id)?.getTime() ?? 0;
        return [...ids].sort((a, b) => at(b) - at(a));
      },
    };
  }, [
    activeView,
    workingNotes,
    notes,
    tagIndex,
    folderOf,
    workingFolderOf,
    bodies,
    updatedById,
  ]);

  const [viewResult, setViewResult] = useState<ViewResult | null>(null);
  useEffect(() => {
    if (!activeView || !viewCtx) {
      setViewResult(null);
      return;
    }
    let cancelled = false;
    void runView(
      {
        filter: activeView.filters,
        groupBy: activeView.group_by,
        sort: activeView.sort,
        columns: activeView.columns,
      },
      viewCtx,
    ).then((r) => {
      if (!cancelled) setViewResult(r);
    });
    return () => {
      cancelled = true;
    };
  }, [activeView, viewCtx]);

  // Distinct note count for the view's "N notes" bar (fan-out rows across a
  // list-valued groupBy collapse to distinct notes). 0 while the async run
  // resolves. Memoized so it isn't rebuilt on every render.
  const viewNoteCount = useMemo(
    () =>
      viewResult
        ? new Set(viewResult.groups.flatMap((g) => g.rows.map((r) => r.noteId))).size
        : 0,
    [viewResult],
  );

  // All folder paths (ancestor-expanded), for the view editor's folder picker.
  const allFolderPaths = useMemo(() => {
    const s = new Set<string>();
    for (const f of folderOf.values()) if (f) for (const a of ancestorPaths(f)) s.add(a);
    return [...s].sort();
  }, [folderOf]);

  // Favorites (prefs.favorites - an ordered list of note UUIDs). Favorited notes
  // sort to the top of the notes list; a star toggle lives on each row.
  const favSet = useMemo(() => new Set(prefs.favorites), [prefs.favorites]);
  const toggleFavorite = useCallback(
    (id: string) => {
      const cur = prefs.favorites;
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      if (HAS_TAURI) void setFavorites(next).catch(ignorePrefsWriteFailure);
    },
    [prefs.favorites],
  );

  // Move-up/move-down reorder (MYND-596). Offered only in the plain notes tree -
  // where `item_order` is the active ordering - and, for notes, never for a
  // favorited one (it lives in the strip, ordered by `favorites`, not
  // `item_order`). Each nudge rewrites the acted row's container sequence and
  // persists via the whole-map `set_item_order`, then bumps the prefs nonce (the
  // favorites-writer chokepoint) so the re-read reflects the new order.
  const reorderableTree =
    listView === "notes" && !activeTag && activeViewId == null && searchQuery.trim() === "";
  const persistItemOrder = (next: Record<string, string[]> | null) => {
    if (next && HAS_TAURI) void setItemOrder(next).catch(ignorePrefsWriteFailure);
  };
  // Row boxes, measured when a drag starts and keyed by `data-reorder-key`. Scoped
  // to the tree's ref: a document-wide query also sees the trash and archive lists.
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  const dragBoxes = useRef<Map<string, { top: number; bottom: number }>>(new Map());
  const [dragRowKey, setDragRowKey] = useState<string | null>(null);

  /** The press-and-hold reorder gesture that replaced the action sheet's arrows:
   *  boxes measured on PRESS, target decided on RELEASE, so one drop is one write.
   *  Inert when the tree is not the manual-order surface. */
  const dragFor = (rowKey: string, containerPath: string | null) => {
    if (!reorderableTree) return undefined;
    return {
      onStart: () => {
        const boxes = new Map<string, { top: number; bottom: number }>();
        const root = treeScrollRef.current;
        if (root !== null) {
          for (const el of root.querySelectorAll("[data-reorder-key]")) {
            const key = el.getAttribute("data-reorder-key");
            if (key === null) continue;
            const r = el.getBoundingClientRect();
            boxes.set(key, { top: r.top, bottom: r.bottom });
          }
        }
        dragBoxes.current = boxes;
        setDragRowKey(rowKey);
      },
      // No per-move work: the lifted row is the feedback, and a setState per move
      // would re-render the whole tree on every pointer event.
      onEnd: (point: { x: number; y: number }, moved: boolean) => {
        setDragRowKey(null);
        // A hold that never moved is the action sheet's, which `useHold` fires.
        if (!moved) return;
        const hit = [...dragBoxes.current.entries()]
          .filter(([key]) => key !== rowKey)
          .find(([, box]) => point.y >= box.top && point.y <= box.bottom);
        if (hit === undefined) return;
        const [targetKey, box] = hit;
        const place = point.y < (box.top + box.bottom) / 2 ? "above" : "below";
        persistItemOrder(
          reorderChildBeside({
            tree: fullTree,
            itemOrder: prefs.item_order,
            cache: orderCache,
            containerPath,
            rowKey,
            targetKey,
            place,
          }),
        );
      },
    };
  };

  // Honor the default-view-mode pref when entering the editor for an EXISTING
  // note: "reading" → static reading view, "source" → raw markdown in the live
  // editor, "live" (default) → rendered live editor. A new (empty) note always
  // opens in the live edit view.
  useEffect(() => {
    if (view !== "editor") return;
    const existing = editing?.id != null;
    setReadingMode(existing && prefs.editor_default_view_mode === "reading");
    setRawMode(existing && prefs.editor_default_view_mode === "source");
  }, [view, editing, prefs.editor_default_view_mode]);

  // Size-class transitions (rotation, iPad Split View drag, window resize):
  // entering compact must land on a concrete screen - the editor when a note is
  // open, the list otherwise. Regular layouts ignore `view`, but every setView
  // call still fires (navigation intent) so the view-keyed default-view-mode
  // effect above keeps working on all size classes. Deps intentionally narrow:
  // this reconciles ONLY when the size class itself flips.
  useEffect(() => {
    if (isRegular) return;
    // Land on a concrete one-column screen without discarding the one the user
    // is on: folding from the band with the drawer up leaves `view` at "list",
    // and forcing "editor" here silently replaced the list they were browsing
    // (myne-md/myne#918 review, D7). Only an editor with nothing open has to
    // move, and it moves to the list.
    setView((current) => (current === "editor" && editing == null ? "list" : current));
  }, [sizeClass]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stop filtering when the active view is deleted elsewhere (prefs refresh).
  useEffect(() => {
    if (activeViewId != null && !orderedViews.some((v) => v.id === activeViewId)) {
      setActiveViewId(null);
    }
  }, [activeViewId, orderedViews]);

  // Both index feeds below are DELTA-driven (myne-mobile#41). `bodies` is a new
  // Map on every load, so an effect keyed on it re-fires whether or not any note
  // actually changed - and both used to answer that by re-sending the entire
  // vault. The trackers hold what each index last accepted, so a re-fire that
  // carries one changed body is one apply. Nothing is recorded until the backend
  // takes it, so a rejected or cancelled item comes back on the next pass.
  const searchDelta = useIndexDeltaTracker();
  const indicesDelta = useIndexDeltaTracker();
  // Both indices belong to the OPEN vault. Every routine exit unmounts this
  // component (lock and switch both route through the unlock stage), but the
  // vault id is a prop, so a swap without a remount is expressible - and a
  // tracker carried across it would delta against another vault's index and
  // leave this one's records unwritten.
  useEffect(() => {
    searchDelta.reset();
    indicesDelta.reset();
    // myne-md/myne#452: the two picker sets are vault-scoped for the same reason
    // the trackers are. `EMPTY_ROWS` and never `null`, or the memos below hand
    // `<CMEditor>` an absent prop and the compartment keeps vault A's rows.
    // Belt and braces on purpose: the joins already drop every row whose note
    // the new vault does not hold, but a filter is not a lifecycle and the two
    // are not guaranteed to commit in the same render.
    // `tests/editor/vault-picker-facet-clearing.test.tsx` is that contract
    // against a mounted editor.
    setHeadingRows(EMPTY_ROWS);
    setBlockAnchorRows(EMPTY_ROWS);
    setPickerFetch({ index: 0, attempt: 0 });
    // The persisted index and its write are per vault too. Clearing the
    // hydration latch here means a swap WITHOUT a remount falls back to the
    // sweep's full rebuild rather than seeding from vault A's blob. The
    // generation additionally invalidates a hydrate already in flight: the
    // latch alone cannot cancel it, and its result would seed vault A's ids
    // into vault B's tracker.
    indicesHydrationGen.current += 1;
    seamCreatedRef.current = [];
    resetVaultIndicesLifecycle();
  }, [vaultId, searchDelta, indicesDelta]);

  /**
   * MYI1 fast path (`protocol.md` §9.8): hydrate the persisted structured index,
   * seed the delta tracker with the records the host loaded, and only then let
   * the sweep below run.
   *
   * `corpus` is the boot-time read, deliberately, not live component state: the
   * persisted records describe the notes as they were when the hydrate scan ran.
   * Seeding from a later body would mark an edit that landed during the hydrate
   * as already applied, leaving the Rust record stale for the session. A seeded
   * signature that no longer matches the live body is re-applied by the sweep,
   * which is the direction this has to fail in.
   *
   * `stale === null` is a command-level failure (slot / IO): the tracker stays
   * empty, the sweep rebuilds the whole corpus, and the cache is exactly as
   * authoritative as §9.8.4 says it is: not at all.
   */
  const hydrateIndicesFromBlob = useCallback(
    async (corpus: readonly DeltaItem[]) => {
      const generation = indicesHydrationGen.current;
      const stale = await hydrateVaultIndicesOnce();
      // A vault swap during the read: the store this reply describes is not
      // the store now open, and seeding it would make the sweep remove vault
      // B's notes as "gone". Open the gate instead of leaving it `pending`:
      // this component does not remount on a vault change, so nothing would
      // re-run the boot hydrate, and a stuck gate means an index that never
      // rebuilds for the session. The reset above emptied the tracker, so the
      // sweep that follows is a full rebuild, which is the correct answer for
      // a vault whose blob was never hydrated.
      if (indicesHydrationGen.current !== generation) {
        setIndicesHydration("ready");
        return;
      }
      if (stale !== null) {
        seedIndexTrackerFromHydration(indicesDelta, corpus, stale);
        // A record the host loaded for a note that is no longer in the LIVE
        // set (trashed, templated, conflicted on another device) has no sweep
        // to report it: `diff` only removes ids the tracker knows, and the
        // stale list never entered the tracker. The Rust store is trash-blind
        // by design (§9.8.4), so the caller owns this half: drop those
        // records, or the blob's stale entry outlives the note's liveness.
        const live = new Set(corpus.map((item) => item.id));
        let dropped = false;
        for (const id of stale) {
          if (live.has(id)) continue;
          try {
            await vaultIndicesRemove(id);
            dropped = true;
          } catch (err) {
            // Best-effort. The record survives until a later unlock retries,
            // so it is worth one line in the log rather than silence.
            warnVaultIndicesFailure(err);
          }
        }
        // The removal is a change the store must write back, or the blob keeps
        // the record and every unlock re-installs and re-drops it.
        if (dropped) noteVaultIndicesChanged();
        // The store now holds the unchanged records. When nothing is stale the
        // sweep early-returns, so the graph's edge dump and the two picker
        // readers have to be told about the new index by THIS path.
        try {
          setBackendEdges(await vaultIndicesAllEdges());
        } catch {
          // The sweep's own fallback (client graph) covers a failed read.
        }
      }
      if (indicesHydrationGen.current !== generation) return;
      setPickerFetch((p) => ({ index: p.index + 1, attempt: 0 }));
      setIndicesHydration("ready");
    },
    [indicesDelta],
  );

  // Keep the backend MYS1 search index synced with the live corpus (the WebView
  // already holds every note's plaintext). Debounced so a burst of edits settles
  // once. The whole-corpus `search_index_replace` is the SEED - it runs on the
  // first pass after unlock, when there is no prior state to delta against; every
  // pass after that sends only what moved.
  useEffect(() => {
    if (!HAS_TAURI) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      const tracker = searchDelta;
      const corpus = liveNotes.map((n) => ({
        id: n.id,
        title: n.title,
        folder: null,
        body: bodies.get(n.id) ?? "",
      }));
      const { changed, removed } = tracker.diff(corpus);
      // Seeding with a corpus reports every note as changed, so this covers the
      // seed too - and an EMPTY vault correctly seeds nothing rather than
      // re-sending an empty replace on every pass.
      if (changed.length === 0 && removed.length === 0) return;
      const seeding = tracker.isEmpty();
      // The wire shape is 3 fields; `folder` only exists to be diffed on.
      const asDocs = (items: typeof corpus): SearchDoc[] =>
        items.map((d) => ({ id: d.id, title: d.title, body: d.body }));
      void (async () => {
        try {
          if (seeding) {
            await searchIndexReplace(asDocs(corpus));
          } else {
            if (removed.length > 0) await searchIndexRemove(removed);
            if (cancelled) return;
            if (changed.length > 0) await searchIndexApply(asDocs(changed));
          }
          if (cancelled) return;
          changed.forEach((d) => tracker.markApplied(d));
          removed.forEach((id) => tracker.markRemoved(id));
        } catch {
          // Nothing marked → the next pass retries this exact delta.
        }
      })();
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [liveNotes, bodies, searchDelta]);

  // Feed the backend vault-indices (MYI1) - extract each CHANGED note's
  // links/tags TS-side, apply, then read the Turkish-correctly-folded edge dump
  // back to drive the graph + backlinks. Debounced; falls back to the client
  // graph on any failure.
  //
  // The applies run SEQUENTIALLY with a live `cancelled` check between them.
  // They used to be one `Promise.all` over the whole vault, and the flag only
  // guarded the `setBackendEdges` at the end - so a save landing mid-sweep
  // stacked a second full sweep on the first instead of replacing it, and every
  // `extractRecord` parse in the map ran synchronously on the main thread before
  // the first await could yield.
  /**
   * Apply the pending delta for `corpus`: removals first, then applies, with
   * the tracker marked per successful call. Returns whether anything moved.
   *
   * ONE implementation for the sweep and for the exit seam, deliberately. The
   * seam persists `{manifest scanned from disk, RAM records}`, and the only
   * way that pair is sound is for the records to be level with the bodies on
   * disk first: a record left behind by the 400 ms debounce would sit under a
   * fresh `content_nonce` and the next hydrate would read it as unchanged
   * (§9.8.4's identity-with-rebuild property).
   *
   * `isCancelled` is checked BETWEEN awaits, so a superseded sweep stops
   * without stranding a mark it did not earn.
   */
  const applyPendingIndices = useCallback(
    async (corpus: readonly DeltaItem[], isCancelled: () => boolean = () => false): Promise<boolean> => {
      const { changed, removed } = indicesDelta.diff(corpus);
      let moved = false;
      for (const id of removed) {
        if (isCancelled()) return moved;
        await vaultIndicesRemove(id);
        indicesDelta.markRemoved(id);
        moved = true;
      }
      for (const note of changed) {
        if (isCancelled()) return moved;
        await vaultIndicesApply(extractRecord(note.id, note.title, note.folder, note.body));
        indicesDelta.markApplied(note);
        moved = true;
      }
      return moved;
    },
    [indicesDelta],
  );

  /** The live corpus as the sweep sees it, with the open note's unsaved buffer
   *  spliced in so a body the flush just wrote is not diffed against its old
   *  copy. A brand-new note is not in `resolverNotes` yet; the flush applied
   *  its record by id, so leaving it out here is harmless. */
  const indexCorpus = useCallback((): DeltaItem[] => {
    const corpus = resolverNotes.map((n) => ({
      id: n.noteUuid,
      title: n.title ?? "",
      folder: n.folder,
      body: bodies.get(n.noteUuid) ?? "",
    }));
    if (editing?.id != null) {
      const live = indexCorpusItem(editing.id, editorText);
      const at = corpus.findIndex((item) => item.id === editing.id);
      if (at >= 0) corpus[at] = live;
      else corpus.push(live);
    }
    for (const minted of seamCreatedRef.current) {
      if (!corpus.some((item) => item.id === minted.id)) corpus.push(minted);
    }
    return corpus;
  }, [resolverNotes, bodies, editing?.id, editorText, indexCorpusItem]);

  // Every exit seam levels the store first (see the lifecycle module). The
  // leveller is registered here because this component owns the tracker and
  // the corpus; a lock does not unmount it, so it must survive one. It reads
  // today's corpus through a ref, so the registration is one-shot and no seam
  // can land in the gap between a cleanup and a re-register.
  const levellerRef = useRef<() => Promise<void>>(async () => {});
  levellerRef.current = async () => {
    if (await applyPendingIndices(indexCorpus())) noteVaultIndicesChanged();
  };
  useEffect(() => {
    setVaultIndicesExitSeamLeveller(() => levellerRef.current());
    return () => setVaultIndicesExitSeamLeveller(null);
  }, []);

  useEffect(() => {
    if (!HAS_TAURI) {
      setBackendEdges(null);
      return;
    }
    // Do not seed the tracker before the persisted index has hydrated: the
    // first pass would report the whole vault as changed and re-send it, which
    // is exactly the rebuild the blob exists to avoid.
    if (indicesHydration !== "ready") return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      const tracker = indicesDelta;
      const corpus = resolverNotes.map((n) => ({
        id: n.noteUuid,
        title: n.title ?? "",
        folder: n.folder,
        body: bodies.get(n.noteUuid) ?? "",
      }));
      for (const minted of seamCreatedRef.current) {
        if (!corpus.some((item) => item.id === minted.id)) corpus.push(minted);
      }
      const { changed, removed } = tracker.diff(corpus);
      if (changed.length === 0 && removed.length === 0) return;
      void (async () => {
        // Whether this pass moved the backend index at all. Set in lockstep with
        // the tracker, because the two have to agree: a note that is marked
        // applied will not be re-sent by any later pass, so if the tracker moved
        // and the nonce did not, the readers below never learn the index changed.
        let moved = false;
        try {
          moved = await applyPendingIndices(corpus, () => cancelled);
          if (cancelled) return;
          setBackendEdges(await vaultIndicesAllEdges());
        } catch {
          if (!cancelled) setBackendEdges(null);
        } finally {
          // myne-md/myne#452. In `finally`, and deliberately NOT behind
          // `cancelled`: a newer pass computes its delta from the tracker this
          // one already marked, so a cancellation landing after the last apply
          // leaves the replacement sweep with an EMPTY delta and an early
          // return, and a bump skipped here is a bump nothing ever makes.
          // `refreshAll` installs a fresh `bodies` Map on every call, a no-op
          // sync pull included, so that race is ordinary rather than exotic.
          // `finally` also covers the throwing path, where the loops may have
          // applied and marked several notes before the failure.
          if (moved) setPickerFetch((p) => ({ index: p.index + 1, attempt: 0 }));
          // MYI1: the store moved, so the next exit seam has something to
          // write. Nothing is written from here: the cadence is the exit
          // seams (`protocol.md` §9.8.5), and an edit that never reaches one
          // costs the next unlock a rebuild of exactly these notes. A
          // cancelled or partly-failed pass marks too, because the notes it
          // did apply are still on disk; the seam runs this same delta to
          // completion before it writes, and `encode_snapshot` never persists
          // a manifest entry the store has no record for, so an unreached note
          // reads as stale instead of being trusted.
          if (moved) noteVaultIndicesChanged();
        }
      })();
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [resolverNotes, bodies, indicesDelta, indicesHydration]);

  // myne-md/myne#452: read the two whole-vault picker sets back.
  //
  // Its OWN effect, not the tail of the sweep above, and that is load-bearing: a
  // read changes no note signature, so nothing re-issues one. Sharing the
  // sweep's body meant a pass that reached the applies and then failed or was
  // superseded left both sets empty with the delta already consumed, and both
  // pickers listed nothing for the rest of the session.
  //
  // Keyed on `pickerFetch` instead, which the sweep bumps in lockstep with the
  // tracker, so "the index moved" and "the readers were told" cannot come apart.
  // Desktop reaches the same place through `useIndexNonce`.
  useEffect(() => {
    if (!HAS_TAURI) return;
    const seq = ++pickerFetchSeq.current;
    let retryTimer: number | null = null;
    // 400 ms is the cadence the two index sweeps above already debounce at, not
    // a measured figure. It rides on top of the sweep's own 400, so a keystroke
    // reaches the pickers roughly 800 ms plus the apply loop after it lands.
    const t = window.setTimeout(() => {
      void (async () => {
        // One read each rather than a `Promise.all`, so one command being
        // unregistered cannot blank the OTHER picker. A superseded read is
        // dropped by the sequence guard rather than a `cancelled` flag, which
        // would skip the retry too and make a cancellation look like a refusal.
        let failed = false;
        try {
          const rows = await vaultIndicesHeadings();
          if (seq === pickerFetchSeq.current) setHeadingRows(rows);
        } catch {
          failed = true;
        }
        try {
          const rows = await vaultIndicesBlockAnchors();
          if (seq === pickerFetchSeq.current) setBlockAnchorRows(rows);
        } catch {
          failed = true;
        }
        // Retry against the SAME index value, since nothing else will: on this
        // client no nonce moves until a note is edited, so without this one
        // unlucky boot read costs the pickers the whole session.
        if (failed && seq === pickerFetchSeq.current && pickerFetch.attempt < PICKER_FETCH_RETRIES) {
          retryTimer = window.setTimeout(() => {
            // The equality test is belt and braces, not a race: the cleanup
            // below clears `retryTimer` on every dependency change, so this can
            // only fire while `pickerFetch` is still the value it closed over.
            setPickerFetch((p) =>
              p.index === pickerFetch.index && p.attempt === pickerFetch.attempt
                ? { index: p.index, attempt: p.attempt + 1 }
                : p,
            );
          }, PICKER_FETCH_RETRY_MS);
        }
      })();
    }, 400);
    return () => {
      window.clearTimeout(t);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      // Invalidate this run's sequence. A NEW run increments it, so the guards
      // above already drop a superseded read; an UNMOUNT does not. Without this
      // the async body resumes after teardown, writes both row states, and arms
      // a retry timer the cleanup has already read as null and so never clears.
      // Unmount here is a lock or a vault switch, which is exactly when nothing
      // should still be pending against the vault that just closed.
      pickerFetchSeq.current += 1;
    };
  }, [vaultId, pickerFetch]);

  // The `[[##` picker's set. The join is not a formatting step: the Rust index
  // is trash-blind, so joining against `resolverNotes` is what keeps trashed,
  // template and conflict-copy notes out, and it supplies each row's title and
  // folder fresh rather than as of the last apply. See `joinVaultHeadings`.
  const vaultHeadings = useMemo<readonly VaultHeading[]>(
    () => joinVaultHeadings(headingRows, resolverNotes),
    [headingRows, resolverNotes],
  );
  // The `[[^^` picker's set, through the twin join in the same shared module,
  // and the stakes are higher here because a `[[^^` row is a DEEP LINK. These
  // rows carry a `noteTitle`/`noteFolder` of their own and the join deliberately
  // ignores them: the resident note-set's copy is the one a rename updates.
  const vaultBlockAnchors = useMemo<readonly EditorVaultBlockAnchor[]>(
    () => joinVaultBlockAnchors(blockAnchorRows, resolverNotes),
    [blockAnchorRows, resolverNotes],
  );

  // In-memory note store for browser-dev (no Tauri host). The real backend
  // owns persistence under `pnpm tauri dev`; this keeps `pnpm dev` demoable.
  const devStoreRef = useRef<Map<string, string> | null>(null);
  const devStore = useCallback((): Map<string, string> => {
    if (devStoreRef.current === null) {
      const m = new Map<string, string>();
      if (!HAS_TAURI) DEV_SEED.forEach((t) => m.set(crypto.randomUUID(), t));
      devStoreRef.current = m;
    }
    return devStoreRef.current;
  }, []);

  const loadEntries = useCallback(async (): Promise<{ entries: NoteEntry[]; texts: Map<string, string> }> => {
    if (HAS_TAURI) {
      const ids = await noteList();
      const texts = await Promise.all(ids.map((id) => noteRead(id).catch(() => "")));
      const map = new Map<string, string>();
      ids.forEach((id, i) => map.set(id, texts[i]));
      return { entries: ids.map((id, i) => entryFrom(id, texts[i])), texts: map };
    }
    const map = new Map(devStore());
    return { entries: [...map.entries()].map(([id, text]) => entryFrom(id, text)), texts: map };
  }, [devStore]);

  // Surgical vs whole-vault, the desktop split (`sidebarState.tsx` refreshOne /
  // refreshAll). `refreshAll` re-reads and re-decrypts EVERY note; it belongs to
  // the paths that genuinely cannot know what moved - the first load after
  // unlock, and an incoming sync write. Every other write path knows the id it
  // just touched and must splice that one row instead, or saving one note costs
  // work proportional to the vault (myne-mobile#41).
  //
  // A splice installs a new `bodies` Map identity, same as a full load - the
  // difference is that the two index feeds now diff against what they last
  // applied, so a new identity carrying one changed body is one apply.

  /** Splice one note's text into the list + bodies. `text` must be the body as
   *  written to disk: every caller either just wrote it or just read it. */
  const applyOne = useCallback((id: string, text: string) => {
    setBodies((prev) => new Map(prev).set(id, text));
    setNotes((prev) => {
      const entry = entryFrom(id, text);
      const at = prev.findIndex((n) => n.id === id);
      if (at !== -1) {
        const next = [...prev];
        next[at] = entry;
        return next;
      }
      // `note_list` returns ids sorted ascending and the list's own ordering
      // derives from that, so a new note is inserted in place rather than
      // appended - otherwise the row order depends on how the note arrived.
      const next = [...prev, entry];
      next.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return next;
    });
  }, []);

  /** Drop one note from the list + bodies (hard delete / purge). */
  const dropOne = useCallback((id: string) => {
    setBodies((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    setNotes((prev) => (prev.some((n) => n.id === id) ? prev.filter((n) => n.id !== id) : prev));
  }, []);

  /** Re-read ONE note and splice it - for a write whose resulting body the
   *  caller does not hold (a backend-side rewrite, a materialized conflict copy).
   *  A failed read leaves the row as it was rather than blanking it. */
  const refreshOne = useCallback(
    async (id: string) => {
      if (!HAS_TAURI) {
        const text = devStore().get(id);
        if (text !== undefined) applyOne(id, text);
        else dropOne(id);
        return;
      }
      try {
        applyOne(id, await noteRead(id));
      } catch {
        // The note may simply be gone (deleted underneath us); either way one
        // unreadable row must not take down the caller's flow.
      }
    },
    [applyOne, dropOne, devStore],
  );

  // The resync for a change the drain could not place (myne-md/myne#849 review).
  // The rule and every arm live in `../../lib/liveResync.ts`, where a spec drives
  // them; this is the screen's half. A failure is an error, a reload is a calm
  // notice: nothing failed when a note is rebuilt from the session, and in a
  // shared vault the change may come from a person rather than a device.
  resyncRef.current = (id: string) => {
    void runLiveResync(id, {
      currentNoteId: () => liveNoteIdRef.current,
      readSession: readLiveNote,
      readDisk: noteRead,
      buffer: () => editorViewRef.current?.state.doc.toString() ?? editorTextRef.current,
      persisted: (noteId) => (loadedTextRef.current?.id === noteId ? loadedTextRef.current.text : null),
      createCopy: (text, noteId) => createConflictCopy(text, noteId),
      // The copy is a separate note no session owns, so this is a plain write.
      updateCopy: (copyId, text) => noteUpdate(copyId, text),
      rebuild: (noteId, text) => {
        loadedTextRef.current = { id: noteId, text };
        sessionMirrorRef.current = { id: noteId, text };
        editorTextRef.current = text;
        setEditorText(text);
      },
      report: (outcome, copyId) => {
        if (copyId !== undefined) void refreshOne(copyId);
        if (outcome === "readFailed" || outcome === "copyFailed") {
          // The mirror is dropped so the next change resyncs again rather than
          // being placed against a base the screen no longer trusts.
          sessionMirrorRef.current = null;
          setEditorError(
            t(outcome === "readFailed" ? "editor.flow.liveResyncFailed" : "editor.flow.liveCopyFailed"),
          );
          return;
        }
        setEditorNotice(
          t(outcome === "reloadedKept" ? "editor.flow.liveResyncedKept" : "editor.flow.liveResynced"),
        );
      },
    });
  };

  // Returns the bodies it loaded, or null when the load failed. The boot caller
  // needs them to register the folders they prove (myne-md/myne#613 back-fill),
  // and re-reading every note would be a whole extra decrypt pass over the vault.
  const refreshAll = useCallback(async (): Promise<ReadonlyMap<string, string> | null> => {
    setLoading(true);
    setListError(null);
    try {
      const { entries, texts } = await loadEntries();
      setNotes(entries);
      setBodies(texts);
      return texts;
    } catch (raw) {
      const e = raw as NoteListError;
      console.error("[notes] load failed:", raw);
      setListError(
        e && typeof e === "object" && e.kind === "Io"
          ? ioBanner(e.detail.io_error_kind)
          : t("editor.flow.loadFailed"),
      );
      return null;
    } finally {
      setLoading(false);
    }
  }, [loadEntries]);

  // #213: the resolver note-set fed to the shared editor so `![[Drawing]]` embeds
  // (and wikilink chips generally) resolve - mobile did not wire this before, so
  // links rendered unresolved. `isDrawing` + `folder` come from the already-loaded
  // bodies, so no extra reads.
  const resolverNoteSet = useMemo<ResolverNote[]>(
    () =>
      notes.map((n) => {
        const body = bodies.get(n.id) ?? "";
        return {
          noteUuid: n.id,
          title: n.title,
          folder: readNoteFolder(body) || null,
          isDrawing: isDrawingBody(body),
        };
      }),
    [notes, bodies],
  );

  // #213: the inline-drawing-embed IO seam. Mobile is an OPEN-FULL-SCREEN host -
  // tapping a drawing embed opens the drawing's own screen (reusing the existing
  // full-screen canvas) rather than a cramped inline canvas, and there is no
  // inline rename (no ref-rewriting rename on mobile). `saveScene`/`renameDrawing`
  // are deliberately omitted; the shared widget hides the inline canvas + makes the
  // title static accordingly. Live deps read through a ref so the seam stays stable.
  const drawingLiveRef = useRef({ editorText, notes, bodies, openRelated, applyOne });
  drawingLiveRef.current = { editorText, notes, bodies, openRelated, applyOne };
  const drawingIo = useMemo<DrawingEmbedIo>(
    () => ({
      readScene: async (id) => extractSceneJson(await noteRead(id)),
      createSibling: async () => {
        const live = drawingLiveRef.current;
        const folder = readNoteFolder(live.editorText) || null;
        const title = nextMobileDrawingTitle(live.notes, live.bodies);
        const body = new TextDecoder().decode(buildDrawingNoteBytes(title, folder));
        // `folder` is already in hand here and was dropped, while desktop's
        // `createDrawing.ts` twin WAS wired, so the two clients disagreed about
        // whether a drawing sibling's folder is remembered.
        const id = await noteCreate(body, folder);
        // Splice the new drawing in so it enters the resolver note-set and the
        // just-inserted `![[Drawing N]]` resolves to it. The body is the one we
        // just wrote, so this needs no read.
        live.applyOne(id, body);
        return title;
      },
      openNote: (id) => void drawingLiveRef.current.openRelated(id),
    }),
    [],
  );

  // #179: the whole-note drawing's Excalidraw API - its mobile-menu items (Theme /
  // Canvas background / Reset) move to the ⋯ sheet since the hamburger is hidden.
  const drawingApiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const drawingActions = useMemo(
    () => ({
      onReset: () => drawingApiRef.current?.resetScene(),
      onToggleTheme: () => {
        const api = drawingApiRef.current;
        if (api === null) return;
        const cur = api.getAppState().theme;
        api.updateScene({ appState: { theme: cur === "dark" ? "light" : "dark" } });
      },
      onSetBackground: (color: string) =>
        drawingApiRef.current?.updateScene({ appState: { viewBackgroundColor: color } }),
    }),
    [],
  );

  // Boot: apply the persisted theme, (dev) seed an empty vault, then load.
  //
  // `booted` is the StrictMode double-invoke guard its desktop twin has
  // (`src/screens/Editor.tsx`). Without it React 19 dev runs this twice, both
  // runs read the pre-write `deliberate_folders`, and the second issues a
  // duplicate ADD write: a second full `vault.prefs` re-encrypt on every dev
  // unlock. `src/AGENTS.md`: "Effects run twice; design with idempotency."
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    applyStoredTheme();
    void (async () => {
      if (HAS_TAURI) await maybeSeedTestData();
      const loaded = await refreshAll();
      // myne-md/myne#613: register the folders this vault's notes already prove,
      // once per unlocked session. A vault created before at-fill has no
      // registrations at all, so its oldest folders are the ones that still
      // vanish when emptied.
      //
      // HERE and not in `refreshAll`, deliberately: this effect runs on mount,
      // which is the unlock, while `refreshAll`'s other callers include the
      // `sync://changed` listener. Backfilling on a pull would re-add a folder a
      // peer had deleted, from notes whose deletions have not arrived yet.
      //
      // `prefsRead()` rather than the `usePrefs` cache: that cache still holds
      // its defaults while its own read is in flight, and an empty
      // `deliberate_folders` read as truth would make this write on every single
      // unlock forever.
      if (HAS_TAURI && loaded !== null) {
        void prefsRead()
          .then((p) => backfillDeliberateFolders(loaded.values(), p.deliberate_folders))
          .catch(ignorePrefsWriteFailure);
      }
      // MYI1 fast path. HERE rather than in an effect of its own for two
      // reasons: it must run AFTER `refreshAll` (the corpus below is the boot
      // read, which is what the persisted records describe) and BEFORE the
      // sweep's first pass; and `booted` already guarantees one invocation, so
      // React 19's double-invoked effect cannot issue a second hydrate that
      // bulk-replaces records an in-between apply had already fixed.
      //
      // A load failure resolves the gate with an empty tracker rather than
      // staying pending: the sweep must still re-seed from whatever the sync
      // listener later reads.
      if (HAS_TAURI && loaded !== null) {
        const corpus: DeltaItem[] = [];
        for (const [id, body] of loaded) {
          if (!isResolverCandidate(readNoteFlags(body))) continue;
          corpus.push(indexCorpusItem(id, body));
        }
        await hydrateIndicesFromBlob(corpus);
      } else {
        setIndicesHydration("ready");
      }
    })();
  }, [refreshAll, hydrateIndicesFromBlob, indexCorpusItem]);

  // SYNC-37: the foreground sync loop (and manual `sync_now`) emit `sync://changed`
  // after a pull writes incoming notes to disk - reload the list + bodies so notes
  // synced from another device actually appear without a manual refresh. Ported
  // from the desktop `Editor.tsx` listener.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        // The event carries no payload, so this genuinely cannot know which
        // notes the pull wrote - one of the two paths that keeps `refreshAll`.
        const handle = await listen("sync://changed", () => {
          if (!cancelled) void refreshAll();
        });
        if (cancelled) handle();
        else unlisten = handle;
      } catch {
        // Not inside Tauri (browser dev shim) → no sync events.
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [refreshAll]);

  // MYND-478: the sync loop merges remote `vault.prefs` changes onto disk and
  // emits `PREFS_SYNC_APPLIED_EVENT` (never for this device's own IPC writes).
  // A vault is open, and this is the ONE place on mobile that is true (myne-md/myne#609).
  //
  // Announce it on the prefs nonce, because that nonce is how a root-mounted
  // consumer learns prefs became readable. Before this, the only two bump sites
  // were `writePref` and the sync bridge below, and neither fires on an unlock:
  // `useDateTimeDisplaySync` mounts in `AppShell`, above the stage machine, so
  // its first `prefsRead()` hit a locked slot, the rejection was swallowed, and
  // nothing re-ran. The shared display store then held its defaults for the whole
  // session, which is exactly the inert-on-mobile defect this feature was filed
  // to fix, one layer over.
  //
  // Keyed on `vaultId` rather than mount, so a vault SWITCH re-announces too.
  // Without that the store keeps the previous vault's format and zone until the
  // next prefs write, and the zone is a coarse-location datum the multi-vault
  // posture keeps per vault everywhere else.
  //
  // Here rather than in each unlock path: password, quick unlock, recovery,
  // creation and vault switch all land on the `editor` stage, and this component
  // renders for that stage alone. A bump per unlock path is the partial fix that
  // works for whichever path its author was looking at.
  useEffect(() => {
    bumpPrefsNonce();
  }, [vaultId]);

  // Bridge it into the prefs nonce so an incoming vault rename / shared-pref
  // change refreshes the header + settings live; the switcher's vault list
  // re-fetches on its next open (its RAM-cache label was refreshed core-side).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const handle = await listen(PREFS_SYNC_APPLIED_EVENT, () => {
          if (!cancelled) bumpPrefsNonce();
        });
        if (cancelled) handle();
        else unlisten = handle;
      } catch {
        // Not inside Tauri (browser dev shim) → no sync events.
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // MYND-427: drain the engine's staged keep-both conflicts (materialize each
  // remote revision as a `conflict_of:` copy, then resolve) on mount + every
  // `sync://changed`, refreshing the list when a copy lands.
  useConflictMaterializer(
    useCallback(
      (createdIds: string[]) => {
        void Promise.allSettled(createdIds.map((id) => refreshOne(id)));
      },
      [refreshOne],
    ),
  );

  // "Reveal in library" from a note's file-card menu (shared @myne/editor) →
  // open the attachments library over the note (desktop-parity action).
  useEffect(() => {
    const onReveal = () => setManageAttachments(true);
    window.addEventListener(REVEAL_ATTACHMENT_EVENT, onReveal);
    return () => window.removeEventListener(REVEAL_ATTACHMENT_EVENT, onReveal);
  }, []);

  // Task-field chip activation (MYND-614): the shared task-chip decoration
  // dispatches `myne-open-task-chip`; the shared listener opens the field editor
  // anchored to that chip and writes the result back through the single writer
  // seam. This is the SAME implementation the desktop installs - without it the
  // chips render and do nothing, which is exactly the state the mobile editor
  // shipped in (the decoration is cross-client; only desktop had listened).
  useEffect(() => installTaskChipEditor(), []);

  // Auto-lock: re-lock the vault after `auto_lock_seconds` of inactivity (any
  // touch / key / pointer resets the countdown). Idle re-lock is what makes the
  // quick-unlock PIN fast-path actually appear on the next unlock. The timer
  // itself moved into the shared hook when the approval wait became a second
  // post-unlock screen that holds keys (myne-md/myne#535).
  useIdleAutoLock(onLock, prefs.auto_lock_seconds);

  // Reminders, from the moment the vault is readable (myne-md/myne#1037).
  //
  // The hook sits HERE rather than in the app root because a reminder pass needs an
  // unlocked vault: the task index and the calendar range both refuse before that.
  // This is the same place `useIdleAutoLock` lives, and for the same reason — it is
  // the one screen that only exists while the keys are in memory.
  useMobileReminderPass();

  // Best-effort plaintext wipe on unmount.
  useEffect(() => {
    return () => setEditorText("");
  }, []);

  // Lazy-load the switcher's vault list when it opens.
  useEffect(() => {
    if (!switcherOpen) return;
    let cancelled = false;
    void (async () => {
      if (HAS_TAURI) {
        const res = await listVaults();
        if (cancelled) return;
        setVaults("ok" in res ? orderByLastUnlock(res.ok) : []);
      } else {
        // `icon: "book"` on the active row is deliberate: browser-dev is the only
        // surface where the VaultMark glyph branch can be seen without a device.
        setVaults([
          // `published: false` is the honest answer for a browser-dev placeholder:
          // nothing here has a sync record behind it.
          { id: vaultId ?? "dev-personal", status: { kind: "Exists" }, label: "Personal", icon: "book", last_unlock: Date.now(), published: false },
          { id: "dev-work", status: { kind: "Exists" }, label: "Work", icon: null, last_unlock: Date.now() - 86_400_000, published: false },
        ]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [switcherOpen, vaultId]);

  // ── Editor transitions ─────────────────────────────────────────────────────
  const exitEditor = useCallback(() => {
    setEditorText("");
    setEditing(null);
    setEditorBusy(false);
    setEditorError(null);
    // Don't leak per-note editor surfaces into the next note we open.
    setManageAttachments(false);
    setReadingMode(false);
    setView("list");
  }, []);

  const newNote = useCallback(async () => {
    // Flush first: the autosave is a debounce a tap can beat, and this control
    // replaces the buffer outright, so the line typed a moment ago would be gone.
    if (!(await persistOpenBuffer())) return;
    // Create in the folder you're currently viewing (root → empty body).
    setEditorText(buildInitialPlaintext(normalizeFolderPath(currentFolder)));
    setEditing({ id: null });
    setEditorError(null);
    setReadingMode(false);
    setView("editor");
  }, [currentFolder, persistOpenBuffer]);

  const newDrawing = useCallback(async () => {
    if (!(await persistOpenBuffer())) return;
    // Seed a `kind: drawing` body so the first render routes to the canvas (SF2);
    // saveNote persists it through the same note_create path as a text note.
    setEditorText(
      new TextDecoder().decode(buildDrawingNoteBytes(undefined, currentFolder)),
    );
    setEditing({ id: null });
    setEditorError(null);
    setReadingMode(false);
    setView("editor");
  }, [currentFolder]);

  // Widget deep-link capture (ios-widgets `myne://capture`): open a fresh note.
  // Cold launch on a locked device latches the intent in `deep-link.ts` and it
  // is consumed HERE once the editor mounts post-unlock; a tap while the app is
  // already open fires CAPTURE_EVENT below. `mode: "voice"` (the widget's mic
  // button, `myne://capture?mode=voice`) opens a fresh note AND the recording
  // sheet in its ready state - the user taps Stop when done (safer than
  // auto-arming the mic on a cold launch).
  const startCapture = useCallback((mode: CaptureMode) => {
    void newNote();
    if (mode === "voice") setRecordOpen(true);
  }, [newNote]);
  useEffect(() => {
    const mode = consumePendingCapture();
    if (mode !== null) startCapture(mode);
  }, [startCapture]);
  useEffect(() => {
    const onCapture = (e: Event) => startCapture((e as CustomEvent<{ mode: CaptureMode }>).detail?.mode ?? "text");
    window.addEventListener(CAPTURE_EVENT, onCapture);
    return () => window.removeEventListener(CAPTURE_EVENT, onCapture);
  }, [startCapture]);
  // Apple Watch pending-capture drain (§9.18): this editor mounts on every unlock
  // path, so draining here turns queued watch dictations into notes right after
  // unlock. `drainPendingCaptures` self-serialises and no-ops when empty.
  useEffect(() => {
    const runDrain = () => {
      // Share-import drain (§9.20, SYNC-4/6): decrypt + import any files shared
      // via the OS share sheet into the attachment library, host-side. A sibling
      // of the capture drain - independent (it refreshes the library, not the
      // notes list) and self-serialising; its SF5 toast is rendered by
      // <ShareImportToast/>.
      void drainPendingShares();
      void (async () => {
        // Seal any just-staged watch captures first, then drain the queue into
        // notes (both no-op when empty / the host is absent).
        await sealStagedCaptures();
        const created = await drainPendingCaptures();
        // Retry any meeting-audio chunk still sitting in the app-owned inbox
        // (a seal that failed before the first post-boot unlock, or a process
        // death between the native move and the seal). Device-key based, so it
        // runs here on unlock; idempotent, and a no-op when the inbox is empty.
        await sealMeetingInbox();
        // The watch MEETING lane (myne-md/myne#812): decrypt + import each
        // pending session's sealed audio chunks into the vault library, then
        // write one meeting note per session (audio embeds + transcript). Its
        // own self-serialising guard, and it also no-ops when empty.
        const meetings = await drainPendingMeetings();
        // `refreshAll`, not `loadEntries`: the latter READS the vault and throws
        // the result away - the drained captures never reached the list, and the
        // cost was a second full decrypt of every note on every foreground.
        // The drains report counts, not ids, so this is a legitimate whole-vault
        // reload - and it only runs when something was actually created.
        if (created > 0 || meetings > 0) await refreshAll();
      })();
    };
    runDrain(); // on mount - every unlock path lands here
    // Also drain when the app returns to the foreground: a watch capture may have
    // been delivered + staged while we were backgrounded (there is no native
    // event bridge to JS yet, so foreground is the prompt-seal trigger).
    const onVisible = () => {
      if (document.visibilityState === "visible") runDrain();
    };
    window.addEventListener("focus", runDrain);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", runDrain);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshAll]);
  // The shared `@myne/editor` `/record` slash command routes through the mobile
  // EditorHost's `voiceRecord` slot, which dispatches VOICE_RECORD_EVENT (it
  // can't reach React state directly). Open the same recording sheet.
  useEffect(() => {
    const onRecord = () => setRecordOpen(true);
    window.addEventListener(VOICE_RECORD_EVENT, onRecord);
    return () => window.removeEventListener(VOICE_RECORD_EVENT, onRecord);
  }, []);

  const openNote = useCallback(
    async (id: string) => {
      setEditorError(null);
      setEditorNotice(null);
      let text: string;
      try {
        text = HAS_TAURI ? await noteRead(id) : devStore().get(id) ?? "";
      } catch {
        // A failed read must NOT bind the editor: committing an empty buffer
        // under the note's id would hand every later flush/save that id with a
        // blank body - overwriting the real note (silent data loss). Stay on
        // the list and surface the failure there instead.
        setListError(t("editor.flow.openFailed"));
        return;
      }
      loadedTextRef.current = { id, text };
      // The session opens from the same text (or already holds it, since
      // `noteRead` reads a live note from its session), so this is the base the
      // first merge's splices are measured against.
      sessionMirrorRef.current = { id, text };
      setEditorText(text);
      setEditing({ id });
      setLastNoteId(id);
      setView("editor");
    },
    [devStore],
  );

  async function saveNote() {
    if (!editing) return;
    // Discard a brand-new empty note rather than persisting an empty blob.
    if (editing.id === null && editorText.trim() === "") {
      exitEditor();
      return;
    }
    // Untouched existing note → exit without rewriting (a save here would burn
    // a fresh nonce + bump `updated:` for zero content change).
    if (editing.id !== null && editorUnchanged(editing.id)) {
      exitEditor();
      return;
    }
    setEditorBusy(true);
    setEditorError(null);
    try {
      const stamped = stampUpdated(editorText);
      // The written body IS the row's new content, so the list and both index
      // feeds are updated from what we just wrote - no read, and nothing
      // proportional to the vault (myne-mobile#41).
      if (editing.id === null) {
        const id = HAS_TAURI
          ? await noteCreate(stamped, readNoteFolder(stamped) || null)
          : crypto.randomUUID();
        if (!HAS_TAURI) devStore().set(id, stamped);
        applyOne(id, stamped);
      } else {
        if (HAS_TAURI) await editorSave(editing.id, stamped);
        else devStore().set(editing.id, stamped);
        loadedTextRef.current = { id: editing.id, text: editorText };
        applyOne(editing.id, stamped);
      }
      exitEditor();
    } catch {
      setEditorError(t("editor.flow.saveFailed"));
      setEditorBusy(false);
    }
  }

  /** Permanently delete the note staged in `purgeId` (from the Trash view). */
  async function confirmPurge() {
    const id = purgeId;
    if (id == null) return;
    try {
      await purgeNote(id);
      // Dropping the row is enough: the index effects notice the id left the
      // corpus and issue the backend removals themselves, so every path that
      // loses a note is covered rather than just this one.
      dropOne(id);
    } catch {
      /* best-effort; the row stays in Trash on failure */
    }
    setPurgeId(null);
  }

  /** Open a linked note without losing the current edit: persist the open note
   *  first (existing notes only), then switch to the target. */
  async function openRelated(id: string) {
    if (editing?.id != null && !editorUnchanged(editing.id)) {
      try {
        const stamped = stampUpdated(editorText);
        if (HAS_TAURI) await editorSave(editing.id, stamped);
        else devStore().set(editing.id, stamped);
        loadedTextRef.current = { id: editing.id, text: editorText };
        applyOne(editing.id, stamped);
      } catch {
        // STAY on the note. `openNote` replaces the buffer and clears the error in
        // the same batch, so navigating here discarded the unsaved text AND hid
        // the message saying so (myne-md/myne#849 review, D7): this client has no
        // autosave and no snapshot, so that text existed nowhere else. A dead tap
        // with a visible reason is the recoverable outcome; the user can retry or
        // copy the text out.
        setEditorError(t("editor.flow.saveFailed"));
        return;
      }
    }
    await openNote(id);
  }

  /** Open a note from any LIST surface (rows, favorites, graph, palette, tag
   *  browser, templates). On compact the list is only reachable with no editor
   *  open (`exitEditor` precedes it), so this reduces to `openNote`. On regular
   *  the editor pane stays mounted next to the list: persist the in-progress
   *  note first - an existing note through `openRelated`'s save-then-open, a
   *  brand-new non-empty note by creating it - so a row tap never silently
   *  discards typed text. */
  /**
   * myne-md/myne#613: register the folder a freshly-created note landed in.
   *
   * Mobile carries the folder inside the note body rather than as a create
   * argument, so the registration reads it back off what was just written.
   * ADD only and fire-and-forget: it can never claim a removal, so a failure
   * costs at most that this folder is not remembered yet.
   */
  /**
   * Write the open buffer if disk does not already have it, WITHOUT leaving the
   * note. `saveNote` is the EXIT path (it calls `exitEditor`), so anything that
   * replaces the buffer while a list is reachable owes this first: this client
   * keeps no snapshot history, so a replaced buffer exists nowhere
   * (mobile/AGENTS.md). Returns false when the write failed, and every caller
   * then stays put rather than navigating away from text nobody can recover.
   *
   * The folded band is why this is not layout-gated any more: its list is a
   * drawer over a LIVE note, so "the list is only reachable with no editor open"
   * stopped being true (myne-md/myne#918 review, D8).
   */
  async function persistOpenBuffer(): Promise<boolean> {
    if (editing == null) return true;
    if (editing.id === null && editorText.trim() === "") return true;
    try {
      const stamped = stampUpdated(editorText);
      if (editing.id === null) {
        const newId = HAS_TAURI
          ? await noteCreate(stamped, readNoteFolder(stamped) || null)
          : crypto.randomUUID();
        if (!HAS_TAURI) devStore().set(newId, stamped);
        applyOne(newId, stamped);
        loadedTextRef.current = { id: newId, text: editorText };
        setEditing({ id: newId });
        return true;
      }
      if (editorUnchanged(editing.id)) return true;
      if (HAS_TAURI) await editorSave(editing.id, stamped);
      else devStore().set(editing.id, stamped);
      loadedTextRef.current = { id: editing.id, text: editorText };
      applyOne(editing.id, stamped);
      return true;
    } catch {
      setEditorError(t("editor.flow.saveFailed"));
      return false;
    }
  }

  // The writer answers "did it land"; the cadence only needs to know it ran.
  useAutosave(editorText, view === "editor" && editing !== null, () => {
    void persistOpenBuffer();
  });

  /** A list row's open: persist the open buffer first, and a failed write keeps the
   *  user where the text is rather than navigating away from it. */
  async function openFromList(id: string) {
    if (!(await persistOpenBuffer())) return;
    await openRelated(id);
  }

  /** Move the open note to Trash / Archive (soft, reversible), then exit. */
  async function organizeCurrent(fn: (id: string) => Promise<void>, failMsg: string) {
    if (editing?.id == null) return;
    try {
      const id = editing.id;
      await fn(id);
      // Archive/trash are frontmatter rewrites - the note stays on disk, so the
      // row is re-read rather than dropped, and only that row.
      await refreshOne(id);
      exitEditor();
    } catch {
      setEditorError(failMsg);
    }
  }

  // The banner's controls reach this flow through window signals: the banner is
  // CodeMirror DOM in the shared editor package and has no route into this
  // component, which owns both the sheet mounts and the open note. Same shape
  // the desktop shell uses, and the event names are spelled identically on
  // purpose (`@myne/editor/cover-signal` says so).
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<OpenCoverPickerDetail>).detail;
      setCoverPicker({
        hasCover: detail?.hasCover === true,
        noteId: detail?.noteId ?? null,
      });
    };
    // `?? null` on a possibly-absent detail rather than a destructure: a bare
    // `new CustomEvent(REMOVE_COVER_EVENT)` still has to mean "the open note"
    // rather than throw (myne-md/myne#520).
    const onRemove = (e: Event) => {
      const detail = (e as CustomEvent<RemoveCoverDetail>).detail;
      void applyNoteCover(null, detail?.noteId ?? null);
    };
    window.addEventListener(OPEN_COVER_PICKER_EVENT, onOpen);
    window.addEventListener(REMOVE_COVER_EVENT, onRemove);
    return () => {
      window.removeEventListener(OPEN_COVER_PICKER_EVENT, onOpen);
      window.removeEventListener(REMOVE_COVER_EVENT, onRemove);
    };
    // Re-subscribes when the open note changes, so `applyNoteCover` always
    // closes over the right one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id, editorText]);

  /**
   * Write the open note's cover, or clear it when `choice === null`.
   *
   * Two orderings matter here and both are copied from `confirmMove` above.
   * Any pending edit is persisted FIRST, so the cover write does not land on
   * top of bytes the user has since changed and the re-read below does not
   * discard their typing. Then the new bytes are read back into the editor:
   * `setNoteCover` rewrites frontmatter out of band of this buffer, and without
   * the re-read the next autosave would write the pre-write text back and
   * silently revert the cover.
   */
  async function applyNoteCover(choice: CoverChoice | null, target: string | null) {
    // The control's stated target, falling back to the open note for the entry
    // points that do not name one (myne-md/myne#520). One note is ever open
    // here, so the fallback is almost always what runs; carrying the argument
    // is what keeps this flow honest against the shared seam rather than
    // relying on the coincidence.
    const id = target ?? editing?.id;
    setCoverPicker(null);
    if (id == null) return;
    // Whether `id` is the note this editor is showing. Everything below that
    // touches `editorText` is gated on it, and that gate is the point of
    // accepting a target at all: `editorUnchanged` answers false for ANY id that
    // is not the loaded one, so an ungated flush would write THIS buffer into
    // that other note, and the re-read would replace the open note's text with
    // the other note's. Unreachable today, since the only caller passing a
    // target passes this note's id, but relying on that coincidence is exactly
    // what the seam change exists to stop.
    const isOpenNote = id === editing?.id;
    try {
      if (isOpenNote && !editorUnchanged(id)) {
        if (HAS_TAURI) await editorSave(id, editorText);
        loadedTextRef.current = { id, text: editorText };
      }
      await setNoteCover(id, choice);
      if (isOpenNote) {
        const next = await noteRead(id);
        setEditorText(next);
        loadedTextRef.current = { id, text: next };
        // The buffer now holds what the session holds, cover included, so the
        // mirror moves with it. The cover's own patch did not move it, and left
        // there the next drain would deliver the cover a second time.
        if (sessionMirrorRef.current?.id === id) sessionMirrorRef.current = { id, text: next };
      }
      await refreshOne(id);
    } catch {
      setEditorError(t("editor.cover.writeFailed"));
    }
  }

  /** Move the note staged in `moveTarget` to the folder typed in `moveInput`
   *  (blank = root), persisting any open edit first, then land on that folder. */
  async function confirmMove() {
    const id = moveTarget;
    if (id == null) return;
    const dest = normalizeFolderPath(moveInput.trim() || null);
    try {
      if (editing?.id === id && !editorUnchanged(id)) {
        if (HAS_TAURI) await editorSave(id, editorText);
        else devStore().set(id, editorText);
        loadedTextRef.current = { id, text: editorText };
      }
      await moveNoteToFolder(id, dest);
      await refreshOne(id);
      setMoveTarget(null);
      setCurrentFolder(dest);
      if (editing?.id === id) exitEditor();
    } catch {
      setMoveTarget(null);
      setEditorError(t("editor.flow.moveFailed"));
    }
  }

  // ── Folder create + actions (MYND-473 / MYND-480) ───────────────────────────
  /** Parent of a canonical trailing-slash folder path (`A/B/` → `A/`; top → null). */
  function folderParent(path: string): string | null {
    const t2 = path.endsWith("/") ? path.slice(0, -1) : path;
    const i = t2.lastIndexOf("/");
    return i < 0 ? null : t2.slice(0, i + 1);
  }

  function openFolderPrompt(p: { mode: "new" } | { mode: "subfolder"; parent: string } | { mode: "rename"; path: string }) {
    setFolderActions(null);
    setFolderPromptInput(
      p.mode === "rename" ? (folderParent(p.path) ? p.path.slice(folderParent(p.path)!.length) : p.path).replace(/\/$/, "") : "",
    );
    setFolderPrompt(p);
  }

  /** New note directly in `path` (folder long-press → "New note"). Mirrors
   *  `newNote` but seeds the note's `folder:` with the target folder. */
  async function newNoteInFolder(path: string) {
    if (!(await persistOpenBuffer())) return;
    setFolderActions(null);
    setEditorText(buildInitialPlaintext(normalizeFolderPath(path)));
    setEditing({ id: null });
    setEditorError(null);
    setReadingMode(false);
    setView("editor");
  }

  /** New drawing note directly in `path` (folder long-press → "New drawing").
   *  Mirrors `newDrawing` but seeds the drawing note's `folder:` (MYND-515). */
  async function newDrawingInFolder(path: string) {
    if (!(await persistOpenBuffer())) return;
    setFolderActions(null);
    setEditorText(
      new TextDecoder().decode(buildDrawingNoteBytes(undefined, normalizeFolderPath(path))),
    );
    setEditing({ id: null });
    setEditorError(null);
    setReadingMode(false);
    setView("editor");
  }

  // ── Decoration: per-item color labels + per-folder icons (MYND-516) ───────
  // Whole-map prefs writes (the `set_item_colors` / `set_folder_icons` setters
  // take the full desired map). Assign = splice the one key; "None"/"Default" =
  // delete it. Key discipline (MYND-562): item_colors is keyed by note UUID OR
  // the folder's FOLDED identity (`folderKey`, applied at the decoration call
  // sites); folder_icons by that folded key only - byte-identical to the keys
  // desktop writes, so a desktop-assigned decoration round-trips across case-
  // variants. The success-path nonce bump belongs to `writePref` inside
  // `lib/prefs.ts`.
  //
  // The `.catch(ignorePrefsWriteFailure)` these writers keep is the failure
  // path, and the handler is named for what it does because it used to be
  // spelled `bumpPrefsNonce`, which read as a correction it never performed.
  // There is no optimistic local state here to revert: `item_colors`,
  // `folder_icons`, `favorites` and `item_order` are read straight off
  // `usePrefs` at render, and the `next` each writer builds is never stored. A
  // rejected `invoke` also means the backend wrote nothing, so the re-read a
  // bump would trigger returns exactly what the caller already holds. The
  // handler's whole job is to keep a `void`-ed call from raising an unhandled
  // rejection. That a failed decoration write is invisible to the user is a
  // real gap and belongs in its own change.
  function assignItemColor(key: string, slot: string | null) {
    const next = { ...prefs.item_colors };
    if (slot === null) delete next[key];
    else next[key] = slot;
    if (HAS_TAURI) void setItemColors(next).catch(ignorePrefsWriteFailure);
  }
  function assignFolderIcon(path: string, name: string | null) {
    const next = { ...prefs.folder_icons };
    if (name === null) delete next[path];
    else next[path] = name;
    if (HAS_TAURI) void setFolderIcons(next).catch(ignorePrefsWriteFailure);
  }
  /** Open the color/icon picker for a folder (color + icon), closing the folder
   *  action sheet first - the `openFolderPrompt` close-then-open idiom. */
  function openFolderDecoration(path: string) {
    setFolderActions(null);
    setDecoTarget({ kind: "folder", path });
  }

  /** Re-root every LIVE note (+ the deliberate/archived folder sets) under
   *  `oldPath` to the matching path under `newPath` - the mobile folder rename/
   *  move primitive. Paths come from the tree (derived from the notes' own
   *  `folder:`), so a case-exact prefix match is reliable. */
  async function reRootFolderSubtree(oldPath: string, newPath: string) {
    if (folderKey(oldPath) === folderKey(newPath)) return;
    const moved: string[] = [];
    for (const [id, folder] of folderOf) {
      if (folder != null && folder.startsWith(oldPath)) {
        const dest = normalizeFolderPath(newPath + folder.slice(oldPath.length));
        // NOT `moveNoteToFolder`: that registers per call, which here would be
        // one full `vault.prefs` re-encrypt and one nonce advance per note in
        // the subtree, outside the `withPrefsBatch` below that exists to stop
        // exactly that. The batch's own `mutationFrom` already states every
        // re-rooted path, so the per-note writes were redundant as well as
        // expensive (myne-md/myne#613 pr-review).
        await moveNoteToFolderWithoutRegistering(id, dest);
        moved.push(id);
      }
    }
    if (HAS_TAURI) {
      // One nonce NOTIFY for the whole rename, not one per setter. Each of
      // these four writes bumps inside `writePref`, and they await each other,
      // so without the batch the microtask coalescing cannot collapse them:
      // a rename cost up to four advances, each re-reading and re-decrypting
      // `vault.prefs` in every mounted `usePrefs`.
      await withPrefsBatch(async () => {
        // Stated as ONE prefix re-root, resolved by the core against the stored
        // set, for the reason the delete above states: a delta over the
        // `usePrefs` cache cannot mention an entry that cache has never seen, so
        // an at-fill registration or a peer's entry was neither re-rooted nor
        // removed and stayed under the OLD path, reappearing empty at the next
        // unlock. It is also atomic, which a remove-plus-add pair is not: under
        // the byte budget that pair can land its removals, stamp each as a
        // deletion that propagates to every device, and refuse its additions.
        //
        // The `archived_folders` write lost its `some(startsWith)` guard on
        // purpose. That guard read the same cache, so a `false` from it proved
        // nothing: it can only under-report, which is the direction that skips a
        // re-root that was needed. It costs one extra blob re-encrypt on a
        // rename that archived nothing, inside the batch, on a rare user action.
        const oldKey = folderKey(oldPath);
        if (oldKey !== "") {
          await mutateDeliberateFolders({
            renamePrefix: [{ from: oldKey, to: newPath }],
          });
          await mutateArchivedFolders({
            renamePrefix: [{ from: oldKey, to: newPath }],
          });
        }
        // Decorations follow the folder (MYND-562): re-root item_colors +
        // folder_icons by folded prefix, exactly as desktop does on rename,
        // else the color/icon strands under the old folded key.
        const colors = rewriteFolderPrefix(prefs.item_colors, oldPath, newPath);
        if (colors.changed) await setItemColors(colors.next);
        const icons = rewriteFolderPrefix(prefs.folder_icons, oldPath, newPath);
        if (icons.changed) await setFolderIcons(icons.next);
      });
    }
    // Only the notes that actually moved were rewritten - a folder rename in a
    // 500-note vault touching 3 notes costs 3 reads, not 500.
    await Promise.allSettled(moved.map((id) => refreshOne(id)));
  }

  /** Apply the folder-name prompt (new / subfolder / rename). Empty = cancel. */
  async function submitFolderPrompt() {
    const p = folderPrompt;
    if (p == null) return;
    const name = folderPromptInput.trim();
    setFolderPrompt(null);
    if (name === "") return;
    try {
      if (p.mode === "rename") {
        const dest = normalizeFolderPath((folderParent(p.path) ?? "") + name);
        if (dest) await reRootFolderSubtree(p.path, dest);
        return;
      }
      const base = p.mode === "subfolder" ? p.parent : "";
      const path = normalizeFolderPath(base + name);
      // A deliberate folder persists even while empty (the virtual-folder model).
      if (path != null && HAS_TAURI) {
        // Class 3 above: this write IS the action, so its failure is reported.
        // A plain add, stated rather than derived from a snapshot.
        //
        // `registerDeliberateFolders` retries once before saying anything, so a
        // disk hiccup costs the user nothing, and separates a full byte budget
        // (which they can act on by deleting a folder) from a persistent write
        // failure (which they cannot). The desktop twin is
        // `useFolderManagement.ts`'s `addDeliberate`.
        const outcome = await registerDeliberateFolders({ add: [path] });
        if (outcome === "budget-full") {
          setEditorError(t("notes.folderManagement.folderListFull"));
        } else if (outcome === "failed") {
          setEditorError(t("notes.folderManagement.folderNotRemembered"));
        }
      }
    } catch {
      setEditorError(t("editor.flow.moveFailed"));
    }
  }

  /** Archive a folder as a unit (folder long-press → Archive). */
  async function archiveFolderFromMenu(path: string) {
    setFolderActions(null);
    const canonical = normalizeFolderPath(path) ?? path;
    if (HAS_TAURI) {
      // The knowingly-unpaid site named in `ignorePrefsWriteFailure`'s doc: this
      // write IS the action, so by that rule it should report, and it does not.
      // `archived_folders` is a different set with a different surface and
      // widening myne-md/myne#613 into it would ship a notice with no test.
      await mutateArchivedFolders({ add: [canonical] }).catch(ignorePrefsWriteFailure);
    }
  }

  /** Folder long-press → Delete folder. Mirrors the desktop's
   *  `deleteFolderAction` (myne-md/myne#628): a note-empty folder goes without a
   *  prompt, a non-empty one asks first and names how many notes move.
   *
   *  The subtree is walked again at confirm time rather than reused from here,
   *  because notes can move while the sheet is open and the set that goes should
   *  be the live one. On the empty path there is no sheet and no elapsed time,
   *  so that second walk is redundant; it is left in place because the
   *  alternative is a second entry point into the delete with a
   *  pre-computed list, which is how the two get to disagree. */
  function requestFolderTrash(path: string, name: string) {
    setFolderActions(null);
    const noteCount = notesInSubtree(folderOfAll, path).length;
    if (noteCount === 0) {
      void trashFolderFromMenu(path);
      return;
    }
    setFolderTrash({ path, name, noteCount });
  }

  /** Move a folder's whole subtree to Trash. Reached only through
   *  `requestFolderTrash`, which owns the actions sheet, so this closes only the
   *  confirmation it was opened from. */
  async function trashFolderFromMenu(path: string) {
    setFolderTrash(null);
    const ids = notesInSubtree(folderOfAll, path);
    try {
      for (const id of ids) await trashNote(id);
      if (HAS_TAURI) {
        const key = folderKey(path);
        // The subtree is STATED and the core resolves it against what is
        // actually stored (myne#613 review round 2). It used to filter
        // `prefs.deliberate_folders`, which is the `usePrefs` cache: that cache
        // starts at DEFAULT_PREFS and catches up only through a nonce-bump round
        // trip, and this same change gave mobile two fire-and-forget
        // registrations that write behind it. A delete inside that window stated
        // `remove: []`, the registration survived on disk, and the folder came
        // back EMPTY at the next unlock and on every device, because the
        // surviving entry carries a newer add clock than the removal.
        //
        // `folderKey("")` is the empty string and an empty prefix is a prefix of
        // everything, so the root is refused here rather than sent. The core
        // ignores an empty prefix too; both, because this is a delete.
        if (key !== "") {
          await mutateDeliberateFolders({ removePrefix: [key] });
        }
      }
    } catch {
      setEditorError(t("editor.flow.trashFailed"));
    }
    await Promise.allSettled(ids.map((id) => refreshOne(id)));
  }

  /** Row action in the trash/archive views (restore / unarchive / purge). */
  async function organizeRow(fn: (id: string) => Promise<void>, id: string) {
    try {
      await fn(id);
    } catch {
      /* best-effort */
    }
    await refreshOne(id);
  }

  /** Restore an archived folder (MYND-470): drop it (and any nested archived
   *  descendant) from `archived_folders` so its subtree returns to the live tree.
   *  Prefs-only - no note bodies change. */
  async function restoreArchivedFolder(path: string) {
    const next = removeFolderFromArchive(prefs.archived_folders, path);
    if (HAS_TAURI)
      await mutateArchivedFolders(
        mutationFrom(prefs.archived_folders, next),
      ).catch(ignorePrefsWriteFailure);
    if (archiveFolder !== null && folderKey(archiveFolder).startsWith(folderKey(path))) {
      setArchiveFolder(null);
    }
  }

  /** Delete an archived folder to Trash (MYND-470): soft-trash every note in its
   *  subtree, then drop it from `archived_folders`. Reversible from Trash. */
  async function deleteArchivedFolderToTrash(path: string) {
    const ids = collectSubtreeNoteIds(archiveNoteFolderOf, folderKey(path));
    try {
      for (const id of ids) await trashNote(id);
      const next = removeFolderFromArchive(prefs.archived_folders, path);
      if (HAS_TAURI)
        await mutateArchivedFolders(
          mutationFrom(prefs.archived_folders, next),
        ).catch(ignorePrefsWriteFailure);
    } catch {
      setEditorError(t("editor.flow.trashFailed"));
    }
    setConfirmArchiveFolder(null);
    if (archiveFolder !== null && folderKey(archiveFolder).startsWith(folderKey(path))) {
      setArchiveFolder(null);
    }
    await Promise.allSettled(ids.map((id) => refreshOne(id)));
  }

  async function purgeNote(id: string) {
    // Route through deleteNoteRouted so a purge under sync writes a propagating
    // `deleted:` tombstone (not a bare local unlink that resurrects on next pull).
    if (HAS_TAURI) await deleteNoteRouted(id);
    else devStore().delete(id);
  }

  /** Open (or create) a period's note per the periodic-notes prefs (myne#177).
   *  One function for all three periods: daily reads its three legacy top-level
   *  prefs fields and the other two read the `periodic_notes` map, which
   *  `periodSettings` resolves, so this flow does not know the difference. */
  async function openPeriod(period: Period) {
    try {
      const candidates = liveNotes.map((n) => ({ id: n.id, title: n.title, folder: folderOf.get(n.id) ?? null }));
      const settings = periodSettings(prefs, period);
      // ONE instant, read once: it anchors the period AND renders the
      // template's `{{date}}`/`{{time}}`. Two calls could title the note with
      // one date and stamp its body with another.
      //
      // `null`, not `prefs.timezone`, and that is deliberate (myne#177). The
      // pref is device-local as a MERGE class, which is not an exclusion from
      // the blob: enrolment adopts the whole prefs blob as this device's
      // starting defaults (`sync-protocol.md` §10.2.1), so a phone enrolled
      // after a computer set an override starts out holding that zone. Mobile
      // ships no control for it and displays nothing derived from it, so
      // applying it here would move which note this opens while changing
      // nothing the user can see or alter. A client honours the override where
      // it can also show and change it. Pass `prefs.timezone` on the day mobile
      // ships the setting, and not before.
      const now = zonedNow(new Date(), null);
      const res = resolvePeriodNote(now, period, settings, candidates);
      if (res.kind === "open") {
        void openFromList(res.id);
        return;
      }
      const id =
        settings.template != null
          ? await createNoteFromTemplate(settings.template, res.dateTitle, res.folder, now, {
              start: res.range.start,
              end: res.range.end,
            })
          : await createBlankNamedNote(res.dateTitle, res.folder);
      await refreshOne(id);
      void openFromList(id);
    } catch (e) {
      // Never let the period-note path crash the app: surface a message instead,
      // naming the period that failed rather than always saying "today".
      console.error(`[${period}] failed:`, e);
      if (HAS_TAURI) setListError(t(PERIOD_OPEN_FAILED_KEY[period]));
    }
  }

  /** Open (or create) today's daily note. The name the pre-myne#177 call sites
   *  use; a delegation, so daily cannot drift from the other two periods. */
  async function openToday() {
    await openPeriod("daily");
  }

  /** Copy the current note's Markdown to the clipboard (WebView clipboard API -
   *  no native plugin). Transient "Copied" feedback via the button label. */
  async function copyNote() {
    // myne-md/myne#455 opened on this function. It reached the WebView clipboard
    // API directly, and it swallowed the rejection, so a refused write left the
    // sheet reading "Copy to clipboard" exactly as if the tap had not
    // registered, and the user then pasted whatever was on the clipboard
    // before, believing it was their note.
    //
    // Two things changed. The write goes through the native seam, which a
    // WebView cannot refuse the way it can refuse a page's clipboard request, so
    // the failure is now rare rather than merely reported. And both outcomes are
    // stated, so when it does fail the user is told.
    await copyText(clipboardWriteText, editorText, {
      onSuccess: {
        kind: "inline",
        run: () => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        },
      },
      onFailure: {
        // Ordinary content, so a TOAST rather than an inline confirmation: the
        // note sheet may already be closing, and there is no once-only value at
        // stake. Reuses the desktop client's key rather than minting a mobile
        // twin, so both clients say the same sentence about the same action.
        kind: "toast",
        run: () => showToast(t("export.note.modal.copyFailed")),
      },
    });
  }

  /** Insert text at the end of the note. Caret-aware insertion + selection
   *  wrapping now live inside the shared CMEditor engine (its selection toolbar
   *  + slash menu); a cursor-position attachment insert is a follow-up. Keeps a
   *  trailing newline so consecutive inserts don't run together. */
  function insertIntoEditor(text: string) {
    setEditorText((t) => (t === "" || t.endsWith("\n") ? t : t + "\n") + text + "\n");
  }

  /** Export the current note as a PDF. `window.print()` is a no-op in the mobile
   *  WebView, so hand the rendered `#myne-print` HTML to the native export sheet
   *  (iOS: render to a PDF file → native share sheet → Save to Files/AirDrop,
   *  MYND-475). Browser-dev falls back to `window.print()`. Pairs with
   *  `src-tauri/src/pdf_export.rs`. */
  async function exportNotePdf() {
    const bodyHtml = document.getElementById("myne-print")?.innerHTML ?? "";
    const title = deriveTitleSnippet(editorText).title || (editing?.id ? "Untitled" : "New note");
    // Wrap the rendered body in a minimal print stylesheet so the PDF is legible
    // (UIMarkupTextPrintFormatter honors basic inline CSS).
    const html =
      `<html><head><meta charset="utf-8"><style>` +
      `body{font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:12pt;line-height:1.55;color:#111;margin:0}` +
      `h1{font-size:20pt;margin:0 0 12pt}h2{font-size:16pt}h3{font-size:14pt}` +
      `pre,code{font-family:Menlo,Consolas,monospace;font-size:10.5pt}` +
      `pre{background:#f5f5f5;padding:10px;border-radius:6px;white-space:pre-wrap}` +
      `blockquote{color:#555;border-left:3px solid #ccc;margin:0;padding-left:12px}` +
      `img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}` +
      `</style></head><body>${bodyHtml}</body></html>`;
    if (!HAS_TAURI) {
      window.print();
      return;
    }
    try {
      // Save the PDF under Documents (reachable even if the share sheet is
      // cancelled), then the native share sheet lets the user pick where to keep
      // it (MYND-475). The title is untrusted and is NOT sanitized here any
      // more: `exportPath` reduces it to a bare basename host-side, so a title
      // carrying `/`, `\` or a leading `..` cannot address anything outside the
      // export directory (myne#517). The hand-rolled version that used to sit
      // here existed in two of the four export flows and in neither of the
      // other two.
      //
      // The `"note"` fallback is the one the deleted TypeScript carried, and it
      // is load-bearing rather than defensive: a note whose derived title is
      // `...` sanitizes away entirely, and without it the export fails. The
      // extension survives the sanitizer host-side, so this stays one argument
      // rather than a stem plus a suffix.
      const { path } = await exportPath(`${title}.pdf`, "note");
      await emit("export-note-pdf", { title, html, path });
    } catch {
      setEditorError(t("editor.flow.exportFailed"));
    }
  }

  /** Import a picked file into the vault (MYA1) and insert its form-C embed. */
  async function attachFile(file: File) {
    if (!HAS_TAURI) {
      setEditorError(t("editor.flow.attachNeedsApp"));
      return;
    }
    setAttaching(true);
    setEditorError(null);
    try {
      const res = await importFile(file);
      insertIntoEditor(emitAttachmentEmbed(res.id, res.filename));
    } catch (e) {
      setEditorError(attachFailureMessage(e));
    } finally {
      setAttaching(false);
    }
  }

  /** The three import failures the attachment path already names. Shared by the
   *  attach button and the photo entry so the newer path cannot answer with a
   *  vaguer sentence than the one beside it. */
  function attachFailureMessage(e: unknown): string {
    const kind = (e as { kind?: string })?.kind;
    return kind === "Oversize"
      ? t("editor.flow.attachTooLarge")
      : kind === "UnsupportedType"
        ? t("editor.flow.attachUnsupported")
        : t("editor.flow.attachFailed");
  }

  /**
   * Photo to note (myne-md/myne#926): import the photograph, then open the DRAFT
   * sheet instead of inserting a bare embed.
   *
   * The sheet opens on the PICKED FILE, not on the attachment id, because the
   * import runs OCR and can take seconds: waiting for the id would leave the user
   * staring at a dimmed toolbar button for exactly the part of the flow that has
   * something to show. `previewUrl` is a blob URL that dies with the draft.
   *
   * The existing attach path is deliberately untouched. A user who wants an
   * image in a note still gets one in one tap; this entry is the one that also
   * offers to read the page. Two paths is the accepted cost.
   */
  async function attachPhoto(file: File) {
    if (!HAS_TAURI) {
      setEditorError(t("editor.flow.attachNeedsApp"));
      return;
    }
    setAttaching(true);
    setEditorError(null);
    photoNoteCommittedRef.current = false;
    photoNoteCancelledRef.current = false;
    const previewUrl =
      typeof URL !== "undefined" && typeof URL.createObjectURL === "function"
        ? URL.createObjectURL(file)
        : null;
    // The OCR preference AS THE IMPORT READS IT, frozen into the draft. The
    // cache entry is written (or skipped) inside this call, so a switch flipped
    // afterwards cannot change what this photo has, and letting the sheet read
    // the live pref would make it re-probe a cache nobody wrote.
    setPhotoNote({
      id: null,
      filename: file.name || t("photoNote.untitledFile"),
      previewUrl,
      ocrEnabled: prefs.attachment_ocr_enabled !== false,
      deduplicated: false,
    });
    try {
      const res = await importFile(file);
      // The user backed out, or the vault locked, while the bytes were being
      // written. The import cannot be aborted, so it is undone here, and ONLY
      // when it created something: `deduplicated` means the vault already held
      // this exact image and deleting it would destroy somebody's attachment.
      if (photoNoteCancelledRef.current || !editorMountedRef.current) {
        if (!res.deduplicated) {
          void attachmentDelete(res.id).catch(() => {
            // Nothing to tell on a dead component, and everything to tell on a
            // live one: this is the same refusal the cancel path reports.
            pendingPhotoDiscards.add(res.id);
            if (editorMountedRef.current) setEditorError(t("photoNote.discardFailed"));
          });
        }
        releasePhotoPreview(previewUrl);
        return;
      }
      setPhotoNote((draft) =>
        draft === null
          ? null
          : {
              ...draft,
              id: res.id,
              filename: res.filename,
              deduplicated: res.deduplicated,
            },
      );
    } catch (e) {
      setPhotoNote(null);
      releasePhotoPreview(previewUrl);
      setEditorError(attachFailureMessage(e));
    } finally {
      setAttaching(false);
    }
  }

  /**
   * Land the reviewed draft.
   *
   * `note` inserts the block through the editor's ordinary insert path, so it is
   * one undoable change and takes the normal note-save route (MY01). `new`
   * creates a titled note through the same helper the saved-transcript path
   * uses, honours the user's new-note location, then opens it with `openFromList`
   * rather than `openNote`: "autosave" is an idle debounce, and switching buffers
   * without flushing first silently discards whatever is in the editor.
   */
  async function commitPhotoNote(text: string, destination: PhotoNoteDestination) {
    const draft = photoNote;
    if (draft === null || draft.id === null) return;
    const block = buildPhotoNoteBlock(
      emitAttachmentEmbed(draft.id, draft.filename),
      text,
    );
    // Set BEFORE the write it guards: an unmount inside the create would
    // otherwise run the cleanup with "not committed" and delete the attachment
    // the new note was just created to reference. The catch puts it back,
    // because a create that failed landed nothing.
    photoNoteCommittedRef.current = true;
    if (destination === "new") {
      const title = photoNoteTitle(
        text,
        t("photoNote.defaultTitle", { date: localDateStamp() }),
      );
      // The user's "Default location for new notes" (MYND-462). An explicit
      // folder argument wins over the pref everywhere else, and there is none
      // here, so this is exactly the root-level create the pref governs. No
      // try/catch: `prefs` is already-loaded plain data, and a swallowed throw
      // here would file the note at the root while looking like a successful
      // default, which is the defect this whole clause exists to fix.
      const mode = normalizeNewNoteLocation(prefs.new_note_location);
      const folder =
        mode === "specific"
          ? prefs.new_note_location_folder ?? null
          : mode === "current"
            ? readNoteFolder(editorText)
            : null;
      let id: string;
      try {
        id = await createTitledNote(block, title, folder);
      } catch {
        photoNoteCommittedRef.current = false;
        // The sheet stays open with the user's text: a failed create must not
        // look like a successful one, and re-tapping the button retries.
        setEditorError(t("photoNote.saveFailed"));
        return;
      }
      // The note EXISTS from here. Clearing the draft before opening it used to
      // share one catch with the create, so a failed OPEN told the user the note
      // was not created and invited a retry that made a second one.
      setPhotoNote(null);
      releasePhotoPreview(draft.previewUrl);
      try {
        await openFromList(id);
      } catch {
        setEditorError(t("photoNote.openFailed"));
      }
      return;
    }
    setPhotoNote(null);
    releasePhotoPreview(draft.previewUrl);
    insertIntoEditor(block);
  }

  /**
   * Abandon the draft: nothing is written, and the attachment this flow imported
   * is deleted through the existing path.
   *
   * **Not every draft owns its attachment.** `attachment_import` is
   * content-addressed and dedups, so picking a photograph the vault already holds
   * returns the EXISTING entry with `deduplicated: true`. Deleting that would
   * break every note that embeds it and push a tombstone to every device, which
   * is the opposite of "cancel writes nothing". So the dedup flag decides, and
   * the flow says so on failure instead of closing as though the bytes went away.
   */
  function cancelPhotoNote() {
    const draft = photoNote;
    photoNoteCancelledRef.current = true;
    photoNoteCommittedRef.current = false;
    setPhotoNote(null);
    releasePhotoPreview(draft?.previewUrl ?? null);
    if (draft === null || !shouldDiscardPhotoDraft(draft, photoNoteCommittedRef.current)) return;
    const id = draft.id;
    if (id === null) return; // the predicate already covers it; this narrows for TS
    void attachmentDelete(id).catch(() => {
      pendingPhotoDiscards.add(id);
      setEditorError(t("photoNote.discardFailed"));
    });
  }

  // A lock (or any other unmount of this flow) with a draft open drops the
  // plaintext with the component and drops the blob URL. The uncommitted import
  // is deleted best-effort: after a lock the delete is refused, and then the
  // image stays in the library, which is the recoverable arm rather than a write
  // nobody asked for. A deduplicated import is never deleted, because the vault
  // already held it.
  useEffect(() => {
    editorMountedRef.current = true;
    // Retry the discards a lock refused. The slot is unlocked now, which is the
    // one thing that changed since the delete failed.
    for (const id of [...pendingPhotoDiscards]) {
      void attachmentDelete(id)
        .then(() => pendingPhotoDiscards.delete(id))
        .catch(() => {});
    }
    return () => {
      editorMountedRef.current = false;
      const draft = photoNoteRef.current;
      releasePhotoPreview(draft?.previewUrl ?? null);
      if (draft === null || !shouldDiscardPhotoDraft(draft, photoNoteCommittedRef.current)) return;
      const id = draft.id;
      if (id === null) return;
      // Register FIRST and clear on success: after a lock this delete is refused,
      // and the id has to survive to be retried on the next unlock.
      pendingPhotoDiscards.add(id);
      void attachmentDelete(id).then(() => pendingPhotoDiscards.delete(id)).catch(() => {});
    };
  }, []);

  // Heading outline of the note body (skips fenced code so `# in code` isn't a
  // heading). Each entry keeps the char offset so tapping jumps the caret there.
  // MUST stay above the `view === "list"` early return - a hook called only in
  // the editor branch renders "more hooks than the previous render" and crashes
  // the whole flow to a blank screen on the first list→editor transition.
  const outline = useMemo(() => deriveOutline(editorText), [editorText]);

  // Unlinked mentions - live notes whose BODY contains this note's title as
  // plain text but that don't already wiki-link it (excludes the backlinks +
  // self). Feeds the right panel's `#` tab (distinct from the Tag Browser);
  // guarded on a ≥3-char title to avoid trivial-substring noise. Two-stage memo
  // so the all-bodies fold-scan doesn't rerun per keystroke: the folded title
  // only changes when the note's first line does (an unchanged string is
  // Object.is-equal, so it never invalidates the scan memo). Same hook-order
  // constraint as `outline` above: MUST stay above the list-view early return.
  // Quirk preserved from the pre-memo version: an untitled note folds the
  // "Untitled"/"New note" display fallback and scans for that literal string.
  const foldedTitle = useMemo(
    () => foldSegment((deriveTitleSnippet(editorText).title || (editing?.id ? "Untitled" : "New note")).trim()),
    [editorText, editing?.id],
  );
  const unlinkedMentions = useMemo(() => {
    if (editing?.id == null || foldedTitle.length < 3) return [] as NoteEntry[];
    const linked = new Set(noteGraph.backlinks.get(editing.id) ?? []);
    return liveNotes.filter(
      (n) => n.id !== editing.id && !linked.has(n.id) && foldSegment(bodyAfterFrontmatter(bodies.get(n.id) ?? "")).includes(foldedTitle),
    );
  }, [editing?.id, foldedTitle, noteGraph, liveNotes, bodies]);

  // Command-palette registry (mobile subset of the desktop action list). Used by
  // the CommandPalette overlay, which renders at the layout level (reachable
  // from every size class), so it lives OUTSIDE the list-pane render helper.
  const gi = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  // One calendar glyph for all three periods (myne#177): three byte-identical
  // copies of the same markup is three places to edit when it changes.
  const calendarGlyph = (
    <svg width="16" height="16" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2" {...gi} /><path d="M3 10h18M8 3v4M16 3v4" {...gi} /></svg>
  );
  const paletteCommands: PaletteCommand[] = [
    { id: "new-note", label: t("common.newnote"), icon: <svg width="16" height="16" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" {...gi} /></svg>, run: () => newNote() },
    { id: "new-drawing", label: t("notes.newTab.createDrawing"), icon: <svg width="16" height="16" viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" {...gi} /></svg>, run: () => newDrawing() },
    { id: "daily", label: t("commands.actions.openTodayNote.label"), icon: calendarGlyph, run: () => void openToday() },
    // myne#177: the weekly and monthly siblings, palette-only like daily and
    // reusing daily's calendar glyph rather than inventing two more icons.
    { id: "weekly", label: t("commands.actions.openThisWeekNote.label"), icon: calendarGlyph, run: () => void openPeriod("weekly") },
    { id: "monthly", label: t("commands.actions.openThisMonthNote.label"), icon: calendarGlyph, run: () => void openPeriod("monthly") },
    { id: "templates", label: t("templates.manager.listLabel"), icon: <svg width="16" height="16" viewBox="0 0 24 24"><rect x="8" y="4" width="11" height="14" rx="2" {...gi} /><path d="M5 8v10a2 2 0 002 2h8" {...gi} /></svg>, run: () => setTab("templates") },
    { id: "files", label: t("attachments.library.title"), icon: <svg width="16" height="16" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" {...gi} /><path d="M21 15l-5-5L5 21" {...gi} /></svg>, run: () => setTab("files") },
    { id: "graph", label: t("editor.chrome.barItems.graph"), icon: <svg width="16" height="16" viewBox="0 0 24 24"><circle cx="6" cy="17" r="2.4" {...gi} /><circle cx="18" cy="14" r="2.4" {...gi} /><circle cx="13" cy="6" r="2.4" {...gi} /><path d="M8.3 15.6l3-7M8.4 16.2l7-1.6" {...gi} /></svg>, run: () => setTab("graph") },
    { id: "tags", label: t("editor.chrome.bottomBar.browseTags"), icon: <svg width="16" height="16" viewBox="0 0 24 24"><path d="M4 4h7l9 9-7 7-9-9z" {...gi} /><circle cx="8" cy="8" r="1.1" fill="currentColor" /></svg>, run: () => setTagBrowserOpen(true) },
    { id: "archive", label: t("notes.archive.title"), icon: <svg width="16" height="16" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="5" rx="1" {...gi} /><path d="M5 9v10a1 1 0 001 1h12a1 1 0 001-1V9M9 13h6" {...gi} /></svg>, run: () => { setListView("archive"); setActiveTag(null); setActiveViewId(null); } },
    { id: "trash", label: t("notes.list.trash"), icon: <svg width="16" height="16" viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13" {...gi} /></svg>, run: () => { setListView("trash"); setActiveTag(null); setActiveViewId(null); } },
    { id: "settings", label: t("editor.chrome.barItems.settings"), icon: <svg width="16" height="16" viewBox="0 0 24 24"><path d="M4 7h11M19 7h1M4 17h1M9 17h11" {...gi} /><circle cx="17" cy="7" r="2.4" {...gi} /><circle cx="7" cy="17" r="2.4" {...gi} /></svg>, run: () => setSettingsOpen(true) },
    { id: "lock", label: t("commands.actions.lockVault.label"), icon: <svg width="16" height="16" viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="9.5" rx="2" {...gi} /><path d="M8 10.5V8a4 4 0 018 0v2.5" {...gi} /></svg>, run: () => onLock() },
  ];

  // ── List pane (the former `view === "list"` early-return branch) ────────────
  // A render helper, not a component: it stays inside EditorFlow's scope (no
  // prop threading), and its derivations only run when a layout actually shows
  // the list - the compact editor screen skips it entirely, so typing there
  // never pays for the tree/filter/sort recomputation. `chrome` strips the
  // AppHeader / TabBar on expanded, where the sidebar absorbs both.
  // ── Home surface inputs ────────────────────────────────────────────────────
  // `favNotes` is built inside the list-pane render helper because the strip
  // owns it there; Home needs the same set one level up, so it is derived here
  // rather than threaded out of a renderer.
  const homeFavouriteNotes = prefs.favorites
    .map((id) => workingNotes.find((n) => n.id === id))
    .filter((n): n is NoteEntry => n != null);
  const homeTasks = useVaultTasks().tasks;
  // A count of the folders this vault REGISTERS, which is the same set the
  // sidebar shows; deriving it from note bodies would need every body loaded.
  const homeFolderCount = prefs.deliberate_folders.length;

  const renderNotesPane = (chrome: { header: boolean; tabBar: boolean }) => {
    const viewActive = listView === "notes" && activeView != null;
    const searchNeedle = searchQuery.trim().toLowerCase();
    // The plain live-notes view renders the whole folder HIERARCHY (an inline
    // expand/collapse tree). A tag/view/trash/archive filter - or an active inline
    // search - renders a flat list instead.
    const treeMode = listView === "notes" && !activeTag && !viewActive && searchNeedle === "";
    // Beeper-style favorites strip: the starred live notes, in the user's saved
    // favorites order. Shown only in the plain notes view (no search/tag/view);
    // when shown they are pulled OUT of the tree below (they live in the strip,
    // not doubled as list rows), so the tree builds from a fav-excluded folderOf.
    const favNotes = prefs.favorites
      .map((id) => workingNotes.find((n) => n.id === id))
      .filter((n): n is NoteEntry => n != null);
    const favStripVisible = treeMode && favNotes.length > 0;
    // The tree hides folder-archived notes (they live under the Archive view) and,
    // when the strip is shown, the favourites (they live in the strip).
    const treeFolderOf =
      favStripVisible || folderArchivedOf.size > 0
        ? new Map(
            [...folderOf].filter(
              ([id]) => !folderArchivedOf.has(id) && !(favStripVisible && favSet.has(id)),
            ),
          )
        : folderOf;
    // MYND-596: folders and notes interleave in ONE display-ordered list PER
    // container (shared `orderedChildren`) - a note can now sit above a folder,
    // the same list desktop renders from the same synced `item_order`. The tree
    // is derived once from the fav/archive-filtered map and walked recursively.
    const tree = deriveTree(
      treeFolderOf,
      prefs.deliberate_folders,
      prefs.archived_folders,
    );
    // The tree renders the manual `item_order` interleave and nothing else, which
    // is the desktop's own model: the arrangement IS the order, and a row moves by
    // being dragged. An A→Z / Z→A override used to sit on top of this, chosen from a
    // toolbar button and a sheet; it was the one place either client offered a sort
    // the other did not, and it described a mode the user then had to remember they
    // were in (owner, 2026-11-10).
    const orderChildren = (containerPath: string | null): Child[] =>
      orderedChildren(tree, containerPath, prefs.item_order, orderCache);
    // Tree emptiness (no notes in the tree map + no VISIBLE deliberate empty
    // folder) is cheaper than materializing the whole flattened tree just to ask
    // its length. The deliberate set is archive-filtered for the same reason the
    // tree is: an archived empty folder renders nothing, so counting it would
    // report a non-empty tree with no rows in it.
    const treeEmpty =
      treeFolderOf.size === 0 &&
      filterVisibleDeliberate(prefs.deliberate_folders, archivedKeys).length === 0;

    const archiveDrillKey = archiveFolder !== null ? folderKey(archiveFolder) : "";
    const filtered =
      listView === "trash"
        ? trashedNotes
        : listView === "archive"
          ? archiveFolder !== null
            // Drilled into an archived folder: every note in its subtree (browse).
            ? notes.filter(
                (n) =>
                  archiveNoteFolderOf.has(n.id) &&
                  folderKey(archiveNoteFolderOf.get(n.id) ?? null).startsWith(archiveDrillKey),
              )
            // Archive root: individually-archived notes NOT already under an
            // archived folder (those are represented by their folder row).
            : archivedNotes.filter(
                (n) => !isNoteFolderArchived(archiveNoteFolderOf.get(n.id) ?? null, archivedKeys),
              )
          : viewActive
            ? [] // flat list bypassed for a view - MobileViewRenderHost renders it
            : activeTag
              ? workingNotes.filter((n) => (tagIndex.byTag.get(activeTag) ?? []).includes(n.id))
              : workingNotes;
    // Inline search - matches the note title or its decrypted body, on-device.
    const searched =
      searchNeedle === ""
        ? filtered
        : filtered.filter(
            (n) =>
              n.title.toLowerCase().includes(searchNeedle) ||
              (bodies.get(n.id) ?? "").toLowerCase().includes(searchNeedle),
          );
    const sorted = searched;
    // Flat filtered list floats favourites to the top (trash/archive use plain order).
    const orderedNotes =
      listView === "notes"
        ? [...sorted.filter((n) => favSet.has(n.id)), ...sorted.filter((n) => !favSet.has(n.id))]
        : sorted;
    // Archive root (MYND-470) shows folder rows above the loose notes; it is only
    // "empty" when it has neither. Drill-in + drilled-in note rows drop the
    // per-note unarchive action (folder-archived notes restore via the folder).
    const archiveRoot = listView === "archive" && archiveFolder === null;
    const archiveHasFolders = archiveRoot && archivedFolders.length > 0;
    const inArchiveFolder = listView === "archive" && archiveFolder !== null;
    const folderLabel = (path: string) => (path.endsWith("/") ? path.slice(0, -1) : path);
    // Keyed by FOLDED identity, not display path (MYND-561/562): the same key
    // desktop's expand set and mobile's decorations use, so a case-variant of a
    // folder name can't split one folder into two expand entries.
    const toggleFolder = (key: string) => toggleFolderExpanded(key);
    // Row subtitle = last-edited relative time (desktop-parity), or "" when the
    // timestamp pref is off / no `updated:` stamp exists.
    const showTs = prefs.show_note_timestamps !== false;
    const subtitleFor = (id: string): string => {
      const d = updatedById.get(id);
      return showTs && d ? formatRelativeTime(d) : "";
    };

    // A vertical tree rail at a given ancestor level.
    const railAt = (i: number) => (
      <div key={`r${i}`} style={{ position: "absolute", insetInlineStart: 20 + i * 18 + 6, top: 0, bottom: 0, width: 1, background: "var(--line-2)" }} />
    );
    // Recursive folder-tree render with per-subtree STICKY headers. Each folder
    // header pins while ITS OWN subtree scrolls under it and un-pins once the
    // subtree is scrolled past (a sticky element is constrained to its wrapper),
    // so nested folders stack + release correctly - the flat sticky list left
    // deep headers stuck in the wrong places.
    const renderTree = (current: string | null, depth: number): ReactNode[] => {
      const out: ReactNode[] = [];
      // ONE walk over the interleaved children - a FolderTreeRow for a folder
      // (recursing when expanded), a NoteRow for a note, in the returned order.
      for (const child of orderChildren(current)) {
        if (child.kind === "folder") {
          const f = child.node;
          const isCollapsed = !expandedFolders.has(f.key);
          out.push(
            <div key={`f:${f.path}`}>
              <div style={{ position: "sticky", top: depth * 44, zIndex: 30 - depth, background: "var(--bg-1)" }}>
                {Array.from({ length: depth }, (_, i) => railAt(i))}
                <FolderTreeRow
                  name={f.name}
                  count={subtreeCount(f)}
                  collapsed={isCollapsed}
                  indentPx={20 + depth * 18}
                  // Decorations key by the folded folder identity (MYND-562), not
                  // the display path - so they match desktop across case-variants.
                  icon={prefs.folder_icons[f.key]}
                  color={prefs.item_colors[f.key]}
                  onToggle={() => toggleFolder(f.key)}
                  onHold={() => setFolderActions({ path: f.path, name: f.name })}
                  reorderKey={f.path}
                  drag={dragFor(f.path, current)}
                  dragging={dragRowKey === f.path}
                />
              </div>
              {!isCollapsed && (
                <div style={{ position: "relative" }}>
                  {railAt(depth)}
                  {renderTree(f.path, depth + 1)}
                </div>
              )}
            </div>,
          );
        } else {
          const n = notes.find((x) => x.id === child.id);
          if (!n) continue;
          out.push(
            <NoteRow
              key={n.id}
              entry={n}
              last={false}
              divider={false}
              indent={depth * 18 + 12}
              subtitle={subtitleFor(n.id)}
              color={prefs.item_colors[n.id]}
              onOpen={() => void openFromList(n.id)}
              selected={isRegular && editing?.id === n.id}
              onHold={() => setRowActions(n)}
              favorited={favSet.has(n.id)}
              onToggleFavorite={() => toggleFavorite(n.id)}
              reorderKey={n.id}
              drag={dragFor(n.id, current)}
              dragging={dragRowKey === n.id}
            />,
          );
        }
      }
      return out;
    };
    const filterActive = activeTag != null || activeView != null;
    const viewTitle = listView === "trash" ? t("notes.list.trash") : listView === "archive" ? t("notes.archive.title") : t("notes.list.notesHeading");
    return (
      <>
        {/* Fixed header - sits OUTSIDE the animated pane so it stays put while
            the tab content slides between pages. */}
        {chrome.header && tab !== "templates" && tab !== "home" && (
          <AppHeader
            label={vaultDisplayLabel(prefs.label)}
            icon={prefs.icon}
            onSwitcher={() => setSwitcherOpen(true)}
            onPalette={() => setPaletteOpen(true)}
            onSettings={() => setSettingsOpen(true)}
          />
        )}
        {/* Ornament role (myne#394): the tab pane is the page a note is read and
            written on, so it is the SURFACE role - the same call the desktop
            makes in `src/screens/Editor.tsx`. Boxes (callouts, quotes) already
            carry their role from the shared `editor/` decorations, which this
            client mounts; this is the half that is mobile's own. */}
        <div
          ref={tabPaneRef}
          {...ornamentRole("surface")}
          {...edgeSwipeBack}
          style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
        >
        {tab === "notes" && (
          <>
            <div
              style={{
                flex: "none",
                // On the regular size classes the AppHeader is not rendered (the
                // rail absorbs it), so this row IS the top of the page and owes
                // the status bar its clearance. Without it the title drew under
                // the clock on an iPad (owner, 2026-11-27 round 3).
                // Longhands, not a shorthand built from a variable: a shorthand
                // with one non-length part is dropped whole, which is what glued
                // this title and the tile row to the bezel.
                paddingTop: chrome.header ? 8 : LIST_TOP,
                paddingInline: 20,
              }}
            >
              {listView !== "notes" && sizeClass !== "expanded" && (
                <button
                  onClick={() => setListView("notes")}
                  data-testid="notes.list-back"
                  // A real target, not the glyph (issue #970 item 21): this was
                  // `padding: 0` around an 18px chevron, so the way out of
                  // Archive on a phone was a 18px square in the one corner a
                  // thumb cannot reach. 44 is the published minimum, and the
                  // negative insets keep the chevron where it was drawn.
                  style={{ display: "flex", alignItems: "center", gap: 3, border: "none", background: "transparent", color: "var(--accent)", fontSize: 15, fontWeight: 600, cursor: "pointer", padding: 0, marginBottom: 8, minHeight: 44, marginLeft: -6, paddingLeft: 6, paddingRight: 10 }}
                >
                  <Icon name="chevron-left" size={18} color="var(--accent)" strokeWidth={2} flip /> {t("notes.list.notesHeading")}
                </button>
              )}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <h1 style={{ margin: 0, fontSize: 32, fontWeight: 700, letterSpacing: "-0.025em", color: "var(--fg-display)" }}>
                  {viewTitle}
                </h1>
                <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
                  {/* Sync status lives in Settings → Sync (MYND-481); the general
                      UI no longer shows a sync glyph. Critical errors/conflicts
                      still surface via <SyncBanners /> below. */}
                  {listView === "notes" && (
                    <button
                      onClick={() => openFolderPrompt({ mode: "new" })}
                      aria-label={t("common.newfolder")}
                      data-testid="notes.new-folder"
                      style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, border: "1px solid var(--line-2)", borderRadius: 10, background: "transparent", color: "var(--fg-2)", cursor: "pointer" }}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
                        <path d="M12 11v5M9.5 13.5h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                      </svg>
                    </button>
                  )}
                  {listView === "notes" && (
                    <button
                      onClick={() => void newNote()}
                      data-testid="notes.new-note"
                      aria-label={t("common.newnote")}
                      style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 6, height: 36, border: "none", borderRadius: 10, background: "var(--accent)", color: "var(--accent-on)", padding: "0 14px", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
                    >
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" /></svg>
                      {t("common.newnote")}
                    </button>
                  )}
                </div>
              </div>

              {/* The create/browse tiles (owner, 2026-11-27 round 2: "bunlar
                  iPad'de 5'li, iPhone'da 6'lı olmalı"). Home leads, Files closes
                  the row on a phone; on the regular size classes Files is
                  dropped because the rail already carries it, which is what
                  makes the row exactly 5 there and exactly 6 on a phone. Each
                  tile stays hideable from Settings → Appearance. */}
              {listView === "notes" && (
                <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                  <ActionPill onClick={() => setTab("home")} label={t("notes.home.title")} testid="notes.home-tile">
                    <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinejoin="round" />
                  </ActionPill>
                  {!hiddenHomeTiles.has("new-drawing") && (
                    <ActionPill onClick={newDrawing} label={t("notes.newTab.createDrawing")} testid="notes.new-drawing-tile">
                      <path d="M12 20h9" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" />
                      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinejoin="round" />
                    </ActionPill>
                  )}
                  {!hiddenHomeTiles.has("templates") && (
                    <ActionPill onClick={() => setTab("templates")} label={t("templates.manager.listLabel")}>
                      <rect x="8" y="4" width="11" height="14" rx="2" stroke="currentColor" strokeWidth="1.7" fill="none" />
                      <path d="M5 8v10a2 2 0 002 2h8" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                    </ActionPill>
                  )}
                  {!hiddenHomeTiles.has("open-today") && (
                    <ActionPill onClick={() => void openToday()} label={t("editor.nav.openToday")}>
                      <rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.7" />
                      <path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                    </ActionPill>
                  )}
                  {!hiddenHomeTiles.has("views") && (
                    <ActionPill onClick={() => setViewsOpen(true)} label={t("editor.chrome.barItems.views")}>
                      <path d="M12 2 2 7l10 5 10-5-10-5z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                      <path d="M2 12l10 5 10-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M2 17l10 5 10-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                    </ActionPill>
                  )}
                  {!isRegular && (
                    <ActionPill onClick={() => setTab("files")} label={t("settings.shell.panels.files")} testid="notes.files-tile">
                      <path d="M3.5 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.7.9l.9 1.4a2 2 0 0 0 1.7.9H19a2 2 0 0 1 2 2v6.8a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                    </ActionPill>
                  )}
                </div>
              )}

              {/* Inline search + icon-only Filter / Sort. Search filters THIS
                  page's notes on-device (the command palette lives on the bottom
                  bar); Filter + Sort each open their own modal sheet. */}
              {listView === "notes" && (
                <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "stretch" }}>
                  <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 8, height: 38, border: "1px solid var(--line-2)", borderRadius: 10, background: "var(--bg-2)", padding: "0 12px" }}>
                    <Icon name="search" size={16} color="var(--fg-3)" strokeWidth={1.7} />
                    <input
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder={t("editor.list.searchPlaceholder")}
                      style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", color: "var(--fg-1)", fontSize: 14 }}
                    />
                    {searchQuery !== "" && (
                      <button onClick={() => setSearchQuery("")} aria-label={t("common.clearsearch")} style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", display: "flex", flexShrink: 0 }}>
                        <svg width="15" height="15" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="var(--fg-3)" strokeWidth="1.8" strokeLinecap="round" /></svg>
                      </button>
                    )}
                  </div>
                  <button
                    onClick={() => setFilterOpen(true)}
                    aria-label={t("editor.filterSheet.title")}
                    style={{ flexShrink: 0, width: 44, display: "flex", alignItems: "center", justifyContent: "center", height: 38, border: "1px solid var(--line-2)", borderRadius: 10, background: filterActive ? "var(--accent-soft)" : "var(--bg-2)", color: filterActive ? "var(--accent)" : "var(--fg-2)", cursor: "pointer" }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                      <path d="M3 5h18l-7 8v6l-4-2v-6z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
              )}
            </div>


            {/* Non-blocking, dismissable sync banners above the note list
                (reconcile + integrity-alert), driven by the shared hook. The
                "Verify devices" CTA wires to the devices surface with F3-T13. */}
            <div style={{ flex: "none", padding: "8px 20px 0" }}>
              <SyncBanners onOpenConflicts={() => setConflictsOpen(true)} />
              {/* #47: the BK-05 quiet notice. The save succeeded and only the
                  undo point is missing, so it sits with the other non-blocking
                  banners rather than interrupting. */}
              <SnapshotFailedBanner />
            </div>

            {activeView && (
              <div style={{ flex: "none", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 20px 0" }}>
                <span style={{ fontSize: 13, color: "var(--fg-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {t("editor.list.viewNoteCount", { count: viewNoteCount, name: activeView.name })}
                </span>
                <div style={{ display: "flex", gap: 14, flexShrink: 0 }}>
                  <button onClick={() => setViewEditor({ initial: activeView })} style={{ border: "none", background: "transparent", color: "var(--accent)", fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0 }}>
                    {t("common.edit")}
                  </button>
                  <button onClick={() => setActiveViewId(null)} style={{ border: "none", background: "transparent", color: "var(--fg-3)", fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0 }}>
                    {t("common.clear")}
                  </button>
                </div>
              </div>
            )}

            {listView === "notes" && !activeView && activeTag && (
              <div style={{ flex: "none", padding: "12px 20px 0" }}>
                <button
                  onClick={() => setActiveTag(null)}
                  style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid var(--accent)", borderRadius: 999, background: "var(--accent-soft)", color: "var(--accent)", fontSize: 13, fontWeight: 600, fontFamily: "var(--font-sans)", padding: "5px 12px", cursor: "pointer" }}
                >
                  #{tagIndex.tags.find((t) => foldSegment(t.tag) === activeTag)?.tag ?? activeTag}
                  <svg width="12" height="12" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
                </button>
              </div>
            )}

            {listError && (
              <div style={{ padding: "12px 20px 0" }}>
                <Banner kind="danger">{listError}</Banner>
              </div>
            )}

            {loading ? (
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Spinner />
              </div>
            ) : viewActive ? (
              // A saved view renders its own grouped/typed surface (cards / table
              // / list) in place of the flat note list - desktop parity. The host
              // owns its empty state (`view.empty`).
              activeView && viewResult ? (
                <MobileViewRenderHost
                  def={activeView}
                  result={viewResult}
                  onOpen={(id) => void openFromList(id)}
                />
              ) : (
                <div style={{ flex: 1 }} />
              )
            ) : (treeMode ? treeEmpty && !favStripVisible : orderedNotes.length === 0 && !archiveHasFolders && !inArchiveFolder) && !listError ? (
              // Centred in the pane rather than hugging its top: the state is
              // what the pane IS while there is nothing in it, so it holds the
              // middle the list will fill. No wash (`field={false}`) and no
              // `fill`: on a 316pt tablet pane the accent gradient read as a
              // glowing box and a filled state stretched a two-line message
              // down the whole column (owner, 2026-11-27 round 4).
              // **The app's one zero state, not a fourth one** (myne-md/myne#970
              // items 4 and 25). This block used to be its own layout: a bold
              // sentence, a grey line, no glyph, no wash, and a centred column
              // whose only chrome was the empty pane around it. The desktop had
              // already replaced its version with `<EmptyState>` and the phone
              // kept the old shape, so Archive on a phone read as an unfinished
              // list while the same state on a computer read as a destination.
              //
              // `fill` makes the state BE the surface, and `frame={false}` drops
              // the card's border and fill: the list area is already a panel, and
              // a rounded box drawn inside it is a dialog nobody can dismiss.
              //
              // `fill` is OFF (owner, 2026-11-27): on a 316pt tablet list pane a
              // filled zero state stretched a two-line message down the whole
              // column and read as a broken layout ("çok extended ve garip").
              // Centred and compact, it reads as the collection at rest.
              //
              // `firstRun` is the honest variant for all three views. An empty
              // Archive is not an error and not a filtered result; it is the
              // collection at rest.
              <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", paddingBottom: "var(--space-6)" }}>
              <EmptyState
                variant="firstRun"
                size="md"
                frame={false}
                field={false}
                glyph={
                  <Icon
                    name={listView === "trash" ? "trash" : listView === "archive" ? "archive" : "file-text"}
                    size={22}
                    color="var(--fg-3)"
                    strokeWidth={1.5}
                  />
                }
                title={
                  listView === "trash"
                    ? t("editor.list.trashEmpty")
                    : listView === "archive"
                      ? t("editor.list.archiveEmpty")
                      : t("editor.list.noNotesYet")
                }
                testId="editor.list-empty"
              />
              </div>
            ) : treeMode ? (
              <ScreenScroll style={{ marginTop: 4 }} ref={treeScrollRef}>
                {favStripVisible && <FavoritesStrip notes={favNotes} onOpen={(id) => void openFromList(id)} onHold={setRowActions} />}
                {renderTree(null, 0)}
              </ScreenScroll>
            ) : (
              <ScreenScroll style={{ marginTop: 8 }}>
                {/* Archive drill-in: back to the archive root (MYND-470). */}
                {inArchiveFolder && (
                  <button
                    type="button"
                    onClick={() => setArchiveFolder(null)}
                    data-testid="archive.folder-back"
                    style={{ display: "flex", alignItems: "center", gap: 6, border: "none", background: "transparent", color: "var(--accent)", fontSize: 15, fontWeight: 600, cursor: "pointer", padding: "8px 20px 12px" }}
                  >
                    <Icon name="chevron-left" size={18} color="var(--accent)" strokeWidth={2} flip />
                    {folderLabel(archiveFolder!)}
                  </button>
                )}
                {/* Archive root: the archived-folder rows above the loose notes. */}
                {archiveRoot &&
                  archivedFolders.map((path) => {
                    const armed = confirmArchiveFolder === path;
                    const subtreeCount = armed
                      ? collectSubtreeNoteIds(archiveNoteFolderOf, folderKey(path)).length
                      : 0;
                    return (
                      <div
                        key={`arch-folder:${path}`}
                        data-testid="archive.folder-row"
                        data-folder-path={path}
                        style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 20px", borderTop: "1px solid var(--line-1)" }}
                      >
                        <button
                          type="button"
                          onClick={() => setArchiveFolder(path)}
                          data-testid="archive.folder-open"
                          style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 10, border: "none", background: "transparent", cursor: "pointer", textAlign: "start", padding: 0 }}
                        >
                          <Icon name="folder" size={17} color="var(--fg-2)" strokeWidth={1.7} />
                          <span style={{ fontSize: 16, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {folderLabel(path)}
                          </span>
                        </button>
                        {armed ? (
                          <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                            <span style={{ fontSize: 13, color: "var(--fg-3)" }}>
                              {t("notes.archive.folderDeleteConfirm", { count: subtreeCount })}
                            </span>
                            <button onClick={() => void deleteArchivedFolderToTrash(path)} data-testid="archive.folder-delete-confirm" data-folder-path={path} style={{ border: "none", background: "transparent", color: "var(--danger)", fontSize: 14, fontWeight: 600, cursor: "pointer", padding: "6px 8px" }}>
                              {t("common.movetotrash")}
                            </button>
                            <button onClick={() => setConfirmArchiveFolder(null)} style={{ border: "none", background: "transparent", color: "var(--accent)", fontSize: 14, fontWeight: 600, cursor: "pointer", padding: "6px 8px" }}>
                              {t("common.cancel")}
                            </button>
                          </div>
                        ) : (
                          <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                            <button onClick={() => void restoreArchivedFolder(path)} data-testid="archive.folder-restore" data-folder-path={path} style={{ border: "none", background: "transparent", color: "var(--accent)", fontSize: 14, fontWeight: 600, cursor: "pointer", padding: "6px 8px" }}>
                              {t("notes.archive.restore")}
                            </button>
                            <button onClick={() => setConfirmArchiveFolder(path)} data-testid="archive.folder-delete" data-folder-path={path} style={{ border: "none", background: "transparent", color: "var(--danger)", fontSize: 14, fontWeight: 600, cursor: "pointer", padding: "6px 8px" }}>
                              {t("notes.archive.delete")}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                {orderedNotes.map((n, i) => (
                  <NoteRow
                    key={n.id}
                    entry={n}
                    last={i === orderedNotes.length - 1}
                    subtitle={listView === "notes" ? subtitleFor(n.id) : undefined}
                    color={prefs.item_colors[n.id]}
                    onOpen={() => void openFromList(n.id)}
            selected={isRegular && editing?.id === n.id}
                    onHold={listView === "notes" ? () => setRowActions(n) : undefined}
                    favorited={listView === "notes" && favSet.has(n.id)}
                    onToggleFavorite={listView === "notes" ? () => toggleFavorite(n.id) : undefined}
                    actions={
                      // Notes tab + drilled-into an archived folder: no per-row
                      // action (folder-archived notes restore via the folder row).
                      listView === "notes" || inArchiveFolder ? undefined : (
                        <div
                              // NOT a control (myne#728, task 16): an event
                              // SHIELD around the row's buttons, so a tap on
                              // one of them does not also open the note. It
                              // has no behaviour of its own to announce.
                              role="presentation"
                              style={{ display: "flex", gap: 4, flexShrink: 0 }}
                              onClick={(e) => e.stopPropagation()}
                            >
                          {listView === "trash" ? (
                            <>
                              <button onClick={() => void organizeRow(restoreNote, n.id)} style={{ border: "none", background: "transparent", color: "var(--accent)", fontSize: 14, fontWeight: 600, cursor: "pointer", padding: "6px 8px" }}>
                                {t("notes.trash.restore")}
                              </button>
                              <button onClick={() => setPurgeId(n.id)} style={{ border: "none", background: "transparent", color: "var(--danger)", fontSize: 14, fontWeight: 600, cursor: "pointer", padding: "6px 8px" }}>
                                {t("notes.trash.delete")}
                              </button>
                            </>
                          ) : (
                            <button onClick={() => void organizeRow(unarchiveNote, n.id)} style={{ border: "none", background: "transparent", color: "var(--accent)", fontSize: 14, fontWeight: 600, cursor: "pointer", padding: "6px 8px" }}>
                              {t("editor.list.unarchive")}
                            </button>
                          )}
                        </div>
                      )
                    }
                  />
                ))}
              </ScreenScroll>
            )}
          </>
        )}

        {tab === "graph" && (
          <GraphTab
            // Same rule as the list header: the AppHeader clears the status bar
            // on compact/medium, and on expanded this row is the top of the page.
            topInset={chrome.header ? 8 : LIST_TOP}
            model={graphModel}
            onOpen={(id) => void openFromList(id)}
            tags={graphTags.tags}
            members={graphTags.members}
          />
        )}
        {/* The AI destination (myne-md/myne#457). The scope is the open note
            when there is one and the whole vault otherwise, which is the
            default `design-notes/ai/0515` names; task 11 makes it something
            the user sets and shows what it costs before the run starts. */}
        {/* Gated on the pref as well as the tab. Turning the device opt-in off
            drops the fifth bar column and the sidebar row, and without this the
            body kept rendering underneath them: a destination navigation no
            longer offers, with a Send that fires a request the host refuses. */}
        {tab === "chat" && prefs.ai_enabled && (
          <AiChatFlow
            // The review lists note ids; these resolve them into what a person
            // reads. Passed in rather than looked up inside the flow, so the
            // flow keeps no second copy of the note table.
            titleOf={(id) => deriveTitleSnippet(bodies.get(id) ?? "").title}
            bodyOf={(id) => bodies.get(id) ?? null}
            // A note named in an answer opens on press, the desktop's rule.
            // The flow resolves nothing itself: the names arrive already
            // projected, and the press is the screen's own `openNote`, so a
            // mention lands wherever any other "open this note" lands.
            mentionTargets={mentionTargets}
            onOpenNote={(id) => void openNote(id)}
            // An applied edit rewrote notes behind this screen, so they are
            // re-read one at a time rather than through `refreshAll`, which
            // re-decrypts the whole vault.
            //
            // **And the OPEN EDITOR'S buffer with them, which `refreshOne`
            // does not touch.** On the regular size class the AI tab does not
            // close the editor, so `editing` and `editorText` survive holding
            // PRE-apply bytes; `editorUnchanged(id)` then reads true, and the
            // next keystroke saves that stale buffer over the change the user
            // just approved. `src/AGENTS.md` states this as a rule ("the pane's
            // next autosave writes that stale buffer back over the change"), the
            // desktop screen discharges it with `reloadOpenNote`, and this file
            // already carries the same pattern for `SnapshotsSheet.onRestored`.
            // What is lost is an approved edit, and the run's own snapshot
            // restores the text from BEFORE the apply, so nothing recovers it.
            onNotesWritten={(ids) => {
              for (const id of ids) void refreshOne(id);
              const open = editing?.id;
              if (open != null && ids.includes(open) && HAS_TAURI) {
                void noteRead(open)
                  .then((text) => {
                    // The baseline moves with the buffer. Setting only the text
                    // would leave `editorUnchanged` comparing against the old
                    // bytes, so the very next save would write it back.
                    loadedTextRef.current = { id: open, text };
                    sessionMirrorRef.current = { id: open, text };
                    setEditorText(text);
                  })
                  .catch(() => {
                    // A failed re-read must not leave a baseline claiming the
                    // stale buffer is current. Dropping it makes the next save
                    // a real write rather than a silent no-op.
                    if (loadedTextRef.current?.id === open) loadedTextRef.current = null;
                  });
              }
            }}
            // One rule, shared with desktop. `editing.id` is null for a note
            // that has never been saved, and a run over an id the vault does
            // not hold is not a narrower scope, it is a broken one.
            grant={defaultGrantFor(editing?.id ?? lastNoteId)}
          />
        )}
        {tab === "files" && (
          <AttachmentsSheet
            variant="page"
            topInset={sizeClass === "expanded"}
            onClose={() => setTab("notes")}
            // Saving a transcript from the Files tab creates a note and opens
            // it, so the action lands somewhere the user can see. `openFromList`
            // flushes the in-progress buffer first (the autosave is a debounce, so
            // the last keystrokes may still be pending), so
            // the switch cannot discard typed text.
            onSavedNote={(id) => {
              setTab("notes");
              void openFromList(id);
            }}
          />
        )}
        {/* MYND-620 task 3: the vault-wide Tasks destination. Same shape as the
            Files destination above - one component serving both a full-screen
            destination and an editor sheet. */}
        {tab === "calendar" && (
          <CalendarSurface
            pageTop={chrome.header ? 8 : LIST_TOP}
            onClose={() => setTab("notes")}
          />
        )}
        {tab === "home" && (
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", paddingTop: LIST_TOP }}>
            <HomeSurfaceMobile
              notes={notes}
              tasks={homeTasks}
              favouriteNotes={homeFavouriteNotes}
              views={orderedViews}
              folderCount={homeFolderCount}
              onOpenNote={(id) => void openFromList(id)}
              onNewNote={() => void newNote()}
              onNewDrawing={() => void newDrawing()}
              onOpenToday={() => void openToday()}
              onOpenTasks={() => setTab("tasks")}
              onOpenViews={() => setViewsOpen(true)}
              onOpenView={(v) => { setTab("notes"); setActiveViewId(v.id); }}
              onOpenAllNotes={() => setTab("notes")}
            />
          </div>
        )}
        {tab === "tasks" && (
          <TaskSurface
            scope={{ kind: "vault" }}
            // The AppHeader (vault switcher + search + gear) already clears the
            // status bar on the compact and medium layouts; only the expanded
            // layout, where the rail replaces that header, needs the surface to
            // pay for the inset itself.
            insideHeader={sizeClass !== "expanded"}
            compactWidth={!isRegular}
            tagsOf={tagsOfNote}
            view={vaultTaskView}
            onViewChange={setVaultTaskView}
            onOpen={(task) => {
              setTab("notes");
              void openNote(task.noteId);
            }}
            testIdPrefix="tasks.vault"
          />
        )}
        {/* The note-scoped tab. Expanded-only in practice: the phone reaches
            this list through the editor sheet (task 4), and the sidebar that
            offers this row does not render below the expanded size class. */}
        {tab === "note-tasks" && editing?.id && (
          <TaskSurface
            scope={{ kind: "note", noteId: editing.id }}
            insideHeader={sizeClass !== "expanded"}
            compactWidth={!isRegular}
            view={noteTaskView}
            onViewChange={setNoteTaskView}
            testIdPrefix="tasks.note-tab"
          />
        )}
        {tab === "templates" && (
          <TemplatesSheet
            variant="page"
            // The "‹ Notes" row is a phone affordance, not a tablet one (owner,
            // 2026-11-27: "'< Notes' yazan şeyler bence gerekli değil iPad'de ve
            // iOS'ta"). On the regular size classes the ribbon/sidebar already
            // names every destination one tap away, so a back link inside the
            // page repeats it and costs a row of vertical space. Compact keeps
            // it: there the list is the only way back.
            {...(isRegular ? {} : { onBack: () => setTab("notes") })}
            templates={templateNotes}
            onClose={() => setTab("notes")}
            onEdit={(id) => {
              setTab("notes");
              void openFromList(id);
            }}
            onUse={(id) => {
              setTab("notes");
              void (async () => {
                try {
                  const nid = await createNoteFromTemplate(id, "", currentFolder, new Date());
                  await refreshOne(nid);
                  void openFromList(nid);
                } catch {
                  /* browser-dev / create failed */
                }
              })();
            }}
            onNew={() => {
              setTab("notes");
              void (async () => {
                try {
                  const nid = await createTemplate("", currentFolder);
                  await refreshOne(nid);
                  void openFromList(nid);
                } catch {
                  /* browser-dev / create failed */
                }
              })();
            }}
            onUnmark={(id) =>
              void (async () => {
                try {
                  // Persist the open buffer first when this IS the open note.
                  // `unmarkTemplate` is read-patch-write against disk, so
                  // without this it reads bytes the user has since typed past
                  // and writes over them (the desktop half of this rule is
                  // `src/notes/flushBeforeFrontmatterWrite.ts`, myne-md/myne#520;
                  // this client has no flush registry to put it inside, so the
                  // caller carries it, and `docs/dev/twin-inventory.md` records
                  // the asymmetry). The Templates tab is a separate tab from the
                  // editor, so an unsaved buffer while browsing it is the
                  // ordinary state rather than an exotic one.
                  if (id === editing?.id && !editorUnchanged(id)) {
                    if (HAS_TAURI) await editorSave(id, editorText);
                    loadedTextRef.current = { id, text: editorText };
                  }
                  if (HAS_TAURI) await unmarkTemplate(id);
                  await refreshOne(id);
                } catch {
                  /* no-op */
                }
              })()
            }
            onDelete={(id) =>
              void (async () => {
                try {
                  // Templates are synced `.myn` notes - route the delete so it
                  // propagates as a tombstone under sync (not a bare local unlink).
                  // The tombstone is a REWRITE, so the row is re-read (and then
                  // filtered out as tombstoned) rather than dropped.
                  if (HAS_TAURI) await deleteNoteRouted(id);
                  await refreshOne(id);
                } catch {
                  /* no-op */
                }
              })()
            }
          />
        )}
        </div>

        {chrome.tabBar && (
          <TabBar
            active={tab}
            ai={prefs.ai_enabled}
            onNotes={() => { setTab("notes"); setPanesRevealed(true); }}
            onTasks={() => setTab("tasks")}
            onGraph={() => setTab("graph")}
            onAttachments={() => setTab("files")}
            onCalendar={() => setTab("calendar")}
            onChat={() => setTab("chat")}
          />
        )}
      </>
    );
  };

  // ── List overlays (sheets opened from the list surfaces). Rendered at the
  // layout level so they cover the whole window on every size class. ──────────
  const renderListOverlays = () => (
    <>
        {switcherOpen && (
          <VaultSwitcher
            vaults={vaults}
            activeId={vaultId}
            onSelect={(id) => {
              setSwitcherOpen(false);
              if (id !== vaultId) onSwitchVault(id);
            }}
            onCreate={() => {
              setSwitcherOpen(false);
              onCreateVault();
            }}
            onJoin={() => {
              setSwitcherOpen(false);
              onJoinAccount();
            }}
            onClose={() => setSwitcherOpen(false)}
          />
        )}

        {aiOnboardingOpen && (
          // Above the Settings sheet, which is what offers it (the AI row), so
          // `--z-overlay` rather than `--z-modal`: this IS a surface opened from
          // inside a modal, which is the level the ladder names for that. At the
          // sheet's own `--z-modal` the panel behind it painted over its buttons and
          // swallowed the clicks, because the panel mounts later in the tree than
          // this fragment does.
          <div
            data-testid="editor.ai-onboarding"
            style={{ position: "absolute", inset: 0, zIndex: "var(--z-overlay)" }}
          >
            <AiOnboardingSheet
              onClose={() => setAiOnboardingOpen(false)}
              // The AI panel is ALREADY open behind this sheet — the row that
              // offered the explainer set it — so the provider button only needs to
              // get out of the way. Reopening Settings here would remount the panel
              // underneath and lose the reader's place.
              onOpenProviderSetup={() => setAiOnboardingOpen(false)}
            />
          </div>
        )}

        {conflictsOpen && (
          <Sheet
            onClose={() => setConflictsOpen(false)}
            style={{ maxHeight: "82%", display: "flex", flexDirection: "column", overflow: "hidden" }}
          >
            <h2 style={{ margin: "0 0 14px", fontSize: 20, fontWeight: 700, color: "var(--fg-display)" }}>
              {t("sync.panel.conflicts.label")}
            </h2>
            <div style={{ overflowY: "auto", minHeight: 0 }}>
              <ConflictsSheet />
            </div>
          </Sheet>
        )}

        {viewEditor && (
          <ViewEditorSheet
            initial={viewEditor.initial}
            tags={tagIndex.tags.map((t) => t.tag)}
            folders={allFolderPaths}
            propertyKeys={viewPropertyKeys}
            viewOrder={prefs.view_order}
            onClose={() => setViewEditor(null)}
            onSaved={() => {
              /* prefs nonce bump re-reads views; an edited active view re-runs. */
            }}
          />
        )}

        {filterOpen && (
          <FilterSheet
            onClose={() => setFilterOpen(false)}
            listView={listView}
            onPickStatus={(v) => {
              setListView(v);
              setActiveTag(null);
              setActiveViewId(null);
            }}
            archivedCount={archivedNotes.length}
            trashedCount={trashedNotes.length}
            views={orderedViews}
            activeViewId={activeViewId}
            onPickView={(id) => {
              setActiveViewId(id);
              setActiveTag(null);
              setListView("notes");
            }}
            tagCount={tagIndex.tags.length}
            onOpenTags={() => setTagBrowserOpen(true)}
          />
        )}

        {viewsOpen && (
          <ViewsSheet
            views={orderedViews}
            activeViewId={activeViewId}
            onPick={(vid) => {
              setActiveViewId(vid);
              setActiveTag(null);
              setListView("notes");
            }}
            onEdit={(v) => setViewEditor({ initial: v })}
            onNew={() => setViewEditor({ initial: null })}
            onClose={() => setViewsOpen(false)}
          />
        )}

        {paletteOpen && (
          <CommandPalette
            commands={paletteCommands}
            notes={liveNotes}
            bodies={bodies}
            onOpenNote={(id) => void openFromList(id)}
            onClose={() => setPaletteOpen(false)}
          />
        )}

        {tagBrowserOpen && (
          <TagBrowserSheet
            onClose={() => setTagBrowserOpen(false)}
            tags={tagIndex.tags}
            byTag={tagIndex.byTag}
            liveIds={new Set(liveNotes.map((n) => n.id))}
            titleById={new Map(notes.map((n) => [n.id, n.title]))}
            viewOrder={prefs.view_order}
            onOpenNote={(id) => void openFromList(id)}
            onSavedView={(id) => {
              // No bump here: `TagBrowserSheet` awaits `upsertSavedView` +
              // `setViewOrder` before calling this, and both bump inside
              // `writePref`. A third bump is a third `prefs_read` + decrypt per
              // mounted `usePrefs` for one saved view. `ViewEditorSheet`, the
              // other saved-view writer, already relies on the chokepoint alone.
              setTagBrowserOpen(false);
              setActiveViewId(id);
              setActiveTag(null);
              setListView("notes");
            }}
          />
        )}

        {rowActions && (
          <NoteRowActionsSheet
            title={rowActions.title || t("common.untitled")}
            favorited={favSet.has(rowActions.id)}
            onClose={() => setRowActions(null)}
            onOpen={() => {
              const id = rowActions.id;
              setRowActions(null);
              void openFromList(id);
            }}
            onToggleFavorite={() => {
              toggleFavorite(rowActions.id);
              setRowActions(null);
            }}
            onMove={() => {
              setMoveInput(folderOf.get(rowActions.id) ?? "");
              setMoveTarget(rowActions.id);
              setRowActions(null);
            }}
            onColor={() => {
              const id = rowActions.id;
              setRowActions(null);
              setDecoTarget({ kind: "note", id });
            }}
            onArchive={() => {
              const id = rowActions.id;
              setRowActions(null);
              void organizeRow(archiveNote, id);
            }}
            onTrash={() => {
              const id = rowActions.id;
              setRowActions(null);
              void organizeRow(trashNote, id);
            }}
          />
        )}

        {/* Folder long-press actions (MYND-480). */}
        {folderActions && (
          <FolderActionsSheet
            name={folderActions.name}
            onClose={() => setFolderActions(null)}
            onNewNote={() => newNoteInFolder(folderActions.path)}
            onNewDrawing={() => newDrawingInFolder(folderActions.path)}
            onNewSubfolder={() => openFolderPrompt({ mode: "subfolder", parent: folderActions.path })}
            onRename={() => openFolderPrompt({ mode: "rename", path: folderActions.path })}
            onDecorate={() => openFolderDecoration(folderActions.path)}
            onArchive={() => void archiveFolderFromMenu(folderActions.path)}
            onTrash={() => requestFolderTrash(folderActions.path, folderActions.name)}
          />
        )}

        {/* Color-label + folder-icon picker (MYND-516). The decoration key is the
            folded folder identity (MYND-562) or the note UUID - resolved ONCE so a
            consumer can't mis-key it. */}
        {decoTarget &&
          (() => {
            const decoKey =
              decoTarget.kind === "note"
                ? decoTarget.id
                : folderKey(decoTarget.path);
            return (
              <DecorationSheet
                color={prefs.item_colors[decoKey] ?? null}
                onSelectColor={(slot) => assignItemColor(decoKey, slot)}
                icon={
                  decoTarget.kind === "folder"
                    ? {
                        value: prefs.folder_icons[decoKey] ?? null,
                        onSelect: (name) => assignFolderIcon(decoKey, name),
                      }
                    : undefined
                }
                onClose={() => setDecoTarget(null)}
              />
            );
          })()}

        {/* New folder / New subfolder / Rename name prompt (MYND-473 / MYND-480). */}
        {folderPrompt && (
          <Sheet onClose={() => setFolderPrompt(null)}>
            {() => (
              <>
                <div style={SHEET_TITLE}>
                  {folderPrompt.mode === "rename"
                    ? t("common.rename")
                    : folderPrompt.mode === "subfolder"
                      ? t("notes.list.newSubfolder")
                      : t("common.newfolder")}
                </div>
                <input
                  ref={folderPromptInputRef}
                  data-testid="notes.folder-prompt-input"
                  value={folderPromptInput}
                  onChange={(e) => setFolderPromptInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void submitFolderPrompt(); }}
                  placeholder={
                    folderPrompt.mode === "subfolder"
                      ? t("notes.list.newFolderInPlaceholder", { path: folderPrompt.parent.replace(/\/$/, "") })
                      : t("common.newfolder")
                  }
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  style={{ marginTop: 14, width: "100%", height: 48, border: "1px solid var(--line-2)", borderRadius: 8, background: "var(--bg-1)", padding: "0 14px", fontFamily: "var(--font-sans)", fontSize: 16, color: "var(--fg-1)", outline: "none", boxSizing: "border-box" }}
                />
                <div style={{ marginTop: 16 }}>
                  <Button
                    variant="primary"
                    data-testid="notes.folder-prompt-submit"
                    onClick={() => void submitFolderPrompt()}
                  >
                    {folderPrompt.mode === "rename" ? t("common.rename") : t("common.newfolder")}
                  </Button>
                </div>
              </>
            )}
          </Sheet>
        )}
    </>
  );

  // ── Editor pane (the former editor-view return). Same render-helper pattern
  // as the list pane: called by the compact editor screen and by the regular
  // detail pane; its derivations only run when an editor is actually shown. ───
  // The note's own measure, per layout.
  //
  // Regular keeps the WS-01 column: 620px of text plus 56px gutters a side,
  // centered in the detail pane. Compact keeps the phone's 18/22.
  //
  // The folded band sits between them on purpose: it keeps the tablet's 620px
  // measure (664 - 2x22) but with the PHONE's gutter, because at 626pt the
  // tablet's 56pt gutters would spend 112 of the 626 points the band exists to
  // give back, leaving the note 514 wide, narrower than the same phone's own
  // editor once folded. 664 is the measure plus two phone gutters, so the cap
  // and the gutter meet at 700 where `medium` takes over.
  const proseStyle =
    isRegular
      ? { width: "100%", maxWidth: 732, margin: "0 auto", minHeight: "100%", color: "var(--fg-1)", padding: "34px 56px" }
      : sizeClass === "compactWide"
        ? { width: "100%", maxWidth: 664, margin: "0 auto", minHeight: "100%", color: "var(--fg-1)", padding: "34px 22px" }
        : { width: "100%", minHeight: "100%", color: "var(--fg-1)", padding: "18px 22px" };

  const renderEditorPane = () => {
    const headerTitle = deriveTitleSnippet(editorText).title || (editing?.id ? "Untitled" : "New note");
    const isExisting = editing?.id != null;
    // Reading-mode wikilink tap → resolve title to a note and open it (saving the
    // current note first via openRelated).
    const openWikilinkTarget = (target: string) => {
      const id = notes.find((n) => foldSegment(n.title) === foldSegment(target))?.id;
      if (id) void openRelated(id);
    };

    return (
      <>
      <EditorTopBar
        onBack={!isRegular ? openList : undefined}
        onToggleList={isRegular ? () => setPanesRevealed((r) => !r) : undefined}
        onContext={() => setRightPanel(true)}
        onMore={isExisting ? () => setMoreOpen(true) : undefined}
        peers={awarenessPeers.length}
        onPresence={() => setPresenceOpen(true)}
        folder={readNoteFolder(editorText)}
        busy={editorBusy}
      />

      <input
        ref={attachInputRef}
        type="file"
        accept={ATTACHMENT_ACCEPT}
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void attachFile(f);
          e.target.value = "";
        }}
      />

      {/* Photo to note (myne-md/myne#926). Deliberately WITHOUT `capture`:
          `capture` removes the library option, and the OS file picker already
          offers "Take Photo" beside "Photo Library" for an `image/*` input. So
          one input reaches both sources, and Myne never opens a camera stream
          (the camera app produces the bytes). That is the security property
          that made this the right shape. */}
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        data-testid="editor.photo-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void attachPhoto(f);
          e.target.value = "";
        }}
      />

      {editorError && (
        <div style={{ padding: "var(--space-3) var(--space-4) 0" }}>
          <Banner kind="danger">{editorError}</Banner>
        </div>
      )}
      {editorNotice && (
        <div style={{ padding: "var(--space-3) var(--space-4) 0" }}>
          <Banner kind="info" testID="editor.live-notice">{editorNotice}</Banner>
        </div>
      )}

      {isDrawing ? (
        // Drawing note (SF2) - the shared hardened Excalidraw canvas replaces
        // CodeMirror. The scene loads from the body and re-serializes on change
        // into editorText, which saveNote persists (same path as a text note).
        <div
          style={{ flex: 1, minHeight: 0, display: "flex", background: "var(--bg-1)" }}
          data-testid="drawing.pane"
        >
          <DrawingCanvasLazy
            key={editing?.id ?? "drawing"}
            initialSceneJson={extractSceneJson(editorText) ?? undefined}
            onSceneChange={(json) => setEditorText((prev) => writeSceneJson(prev, json))}
            // #179: hide Excalidraw's bottom-bar hamburger (its items move to the
            // ⋯ menu below) + capture the API to drive them. undo/redo stays.
            mobileChrome
            onApi={(api) => {
              drawingApiRef.current = api;
            }}
          />
        </div>
      ) : readingMode ? (
        <MarkdownView
          text={editorText}
          onOpenWikilink={openWikilinkTarget}
          fontFamily={prefs.editor_font_family === "sans" ? "var(--font-sans)" : "var(--font-mono)"}
          fontSize={EDITOR_TEXT_PX[prefs.editor_text_size ?? "md"] ?? 16}
        />
      ) : (
        // Shared live-preview editor (@myne/editor): raw-on-edit CodeMirror with
        // tables / KaTeX / syntax highlighting / frontmatter-as-properties, plus
        // its slash menu + keymaps. Its floating selection toolbar is DELIBERATELY
        // OFF here (`selectionToolbar={false}`, MYND-559) and the above-keyboard
        // FormatBar below is DELIBERATELY KEPT: both offer the same commands, and
        // a thumb-reachable bar pinned over the keyboard beats a toolbar floating
        // on top of the selection the user is trying to see. (Desktop keeps the
        // floating one - the flag defaults true.) Typography is applied via the
        // canonical `typographyStyle(prefs)` CSS custom properties
        // (`--editor-text-size` / `--editor-font-family` / `--editor-line-spacing`)
        // that the shared CM theme reads (MYND-483) - direct `fontSize`/etc. on
        // the wrapper are OVERRIDDEN by CM's own `var(--editor-*)` rules, so a
        // change never reached the editor. `maxWidth` stays off (full-width phone).
        <div
          // `.m-scroll` rather than the four declarations it is (mobile.css):
          // flex/min-height/overflow-y/overflow-x/-webkit-overflow-scrolling.
          // The editor pane used to hand-roll three of them and leave the fourth
          // out, and the missing one was `overflow-x`. CSS resolves `visible`
          // to `auto` on one axis when the other is not `visible`, so the pane
          // was a horizontal scroll container in its own right, outside
          // `.cm-scroller` (myne-md/myne#630). Wearing the class means the next
          // thing that class learns reaches the app's busiest scroll surface.
          ref={editorScrollRef}
          className="m-scroll"
          style={{
            background: "var(--bg-1)",
            ...typographyStyle(prefs),
            maxWidth: undefined,
          }}
        >
          <CMEditor
            value={editorText}
            onChange={setEditorText}
            onReady={(view) => {
              editorViewRef.current = view;
              setEditorView(view);
              // A fold remounted this view: put the reader back where they were.
              // `applyCaret` refuses a snapshot from another note, so opening a
              // different note across the transition inherits nothing.
              if (!view) return;
              // The snapshot is NOT consumed here. A development mount happens
              // twice (StrictMode), and the first view is discarded a tick later:
              // consuming on the first one restored the caret into a view nobody
              // saw. It stays armed until the caret moves somewhere else, which
              // is what `handleCursorChange` below watches for.
              const pending = pendingCaretRef.current;
              if (!pending) return;
              applyCaret(view, pending, liveNoteIdRef.current, editorScrollRef.current);
              // One frame later the scroller has its real height, and replaying
              // the same offset is idempotent rather than a second restore.
              if (typeof requestAnimationFrame === "function") {
                requestAnimationFrame(() => {
                  if (editorViewRef.current === view) {
                    applyCaret(view, pending, liveNoteIdRef.current, editorScrollRef.current);
                  }
                });
              }
            }}
            // Live presence (`collab-presence-ui`, myne-md/myne#849 review): this
            // device's caret/selection is reported so PEERS render its cursor. The
            // desktop pane has had this from the start; without it the phone
            // publishes its join frame and never moves, so a peer's roster row for
            // it carries no position and jumping to the phone does nothing.
            onCursorChange={handleCursorChange}
            // myne-md/myne#520: the note the cover banner's controls act on.
            // Mobile shows one note at a time, so this client cannot hit the
            // split defect that motivated the field, but the seam is shared
            // and a host that left it unset would hand the editor `null` and
            // put this flow back on the guess it is meant to replace.
            noteId={editing?.id ?? null}
            // The editor body's accessible name (myne-md/myne#728, review).
            // The prop is optional with an "Untitled note" fallback, so
            // omitting it compiled and rendered and left EVERY note on this
            // client announcing as untitled to VoiceOver and TalkBack. The
            // desktop passes it from two call sites in `PaneView`; mobile
            // renders the same shared surface and was the one host that did
            // not. Nothing would have found it: no mobile test asserts the
            // name and the roster's screen-reader item covers desktop only.
            noteTitle={editorTitle}
            // Live-collaboration presence (myne-md/myne#849): the peers editing THIS
            // note, drawn by the shared engine's awareness decoration field. A peer
            // on another note is absent from the push rather than filtered by the
            // engine. `undefined` (no note on screen) means this host is not driving
            // awareness at this moment, which the engine reads as "push nothing".
            awareness={awarenessPush}
            // The roster's jump target (task 8). One-shot: the editor applies a
            // reveal once per `nonce` and only for the note it holds, and nothing
            // re-arms it, so no follow mode exists.
            revealLine={revealLine}
            // MYND-559: the FormatBar (driven by the `onReady` view above) is
            // mobile's single formatting surface - suppress the engine's floating
            // selection toolbar so a word-select doesn't raise a second one.
            selectionToolbar={false}
            // #213: resolve wikilinks + recognize `![[Drawing]]` embeds. Mobile is
            // an open-full-screen host - the embed shows a thumbnail that opens the
            // drawing on its own screen (drawingIo has openNote, no inline canvas).
            noteSet={resolverNoteSet}
            // myne-md/myne#452: the vault-wide `[[##` and `[[^^` picker sets.
            // `wikilinkPickerExtension` composes both extensions unconditionally,
            // so an absent prop here reads to the user as "this vault has none"
            // rather than as "not wired".
            vaultHeadings={vaultHeadings}
            vaultBlockAnchors={vaultBlockAnchors}
            drawingIo={drawingIo}
            // myne-md/myne#880: the sheet wrote `editor_line_numbers` and
            // nothing on this client read it, so the toggle confirmed a choice
            // the editor never applied. The shared `<CMEditor>` already accepts
            // the prop and desktop threads it from `PaneView`; this call site
            // simply omitted it. `=== true` rather than a truthy read, because
            // the pref is `boolean | null` (unset reads as `null`) and the
            // prop's own default is `false`: desktop compares the same way, so
            // an unset pref means off on both clients.
            lineNumbers={prefs.editor_line_numbers === true}
            viewMode={rawMode ? "source" : "live"}
            // Regular: the WS-01 prose measure - a 620px column (+ 56px gutters)
            // centered in the detail pane. Compact keeps the phone's 18/22.
            style={proseStyle}
          />
        </div>
      )}

      {isDrawing ? null : readingMode ? (
        // Reading mode hides the FormatBar (nothing to format) - but it must not
        // be a one-way trap: a headingless note has an empty outline, so the
        // outline "Jump" can't get you out. A pinned Edit control always can.
        <ReadingBar onEdit={() => setReadingMode(false)} />
      ) : (
        <FormatBar
          view={editorView}
          attaching={attaching}
          rawMode={rawMode}
          onToggleRaw={() => setRawMode((r) => !r)}
          onAttach={() => attachInputRef.current?.click()}
          onPhotoToNote={() => photoInputRef.current?.click()}
          onLibrary={() => setManageAttachments(true)}
          onRecord={() => setRecordOpen(true)}
          // MYND-555: the user's device-local bar layout. Both default to `[]`
          // (canonical order, nothing hidden), and they ride the `usePrefs` nonce,
          // so a change in Settings reorders the live bar without a remount.
          order={prefs.editor_toolbar_order}
          hidden={prefs.editor_toolbar_hidden}
        />
      )}

      {/* Off-screen print surface - `window.print()` (the PDF button) isolates
          this via @media print (mobile.css). Frontmatter stripped; attachment
          embeds render inline via the attachment:// scheme. */}
      <div id="myne-print">
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: "0 0 16px" }}>{headerTitle}</h1>
        <MarkdownView text={bodyAfterFrontmatter(editorText)} onOpenWikilink={() => {}} fontFamily="var(--font-sans)" fontSize={15} />
      </div>
      </>
    );
  };

  // ── Editor overlays (sheets/panels opened from the editor surface). Rendered
  // at the layout level; on regular they only mount while a note is open. ─────
  const renderEditorOverlays = () => {
    const backlinkNotes = (editing?.id ? (noteGraph.backlinks.get(editing.id) ?? []) : [])
      .map((bid) => notes.find((n) => n.id === bid))
      .filter((n): n is NoteEntry => n != null);
    return (
      <>
      {recordOpen && (
        <RecordingSheet onRecorded={attachFile} onClose={() => setRecordOpen(false)} />
      )}

      {rightPanel && (
        <NoteContextPanel
          backlinks={backlinkNotes}
          unlinked={unlinkedMentions}
          outline={outline}
          onOpen={(id) => {
            setRightPanel(false);
            void openRelated(id);
          }}
          onJump={() => {
            // Leave reading mode into the live editor; jumping to a specific
            // char offset now needs the CMEditor engine (scroll-anchor), a
            // follow-up - for now the outline jump just opens the editor.
            setRightPanel(false);
            setReadingMode(false);
          }}
          onClose={() => setRightPanel(false)}
        />
      )}

      {coverPicker !== null && (coverPicker.noteId ?? editing?.id) != null && (
        <CoverPickerSheet
          hasCover={coverPicker.hasCover}
          onClose={() => setCoverPicker(null)}
          onPick={(choice) => void applyNoteCover(choice, coverPicker.noteId)}
          onRemove={() => void applyNoteCover(null, coverPicker.noteId)}
        />
      )}

      {moreOpen && (
        <NoteActionsSheet
          stat={(() => {
            const s = countWords(editorText);
            return s.words === 0 ? t("editor.noteMenu.emptyNote") : t("editor.noteMenu.wordCount", { count: s.words, minutes: s.readingMinutes });
          })()}
          copied={copied}
          busy={editorBusy}
          onClose={() => setMoreOpen(false)}
          // #179: for a drawing note the ⋯ menu carries the canvas actions moved
          // out of Excalidraw's hidden mobile hamburger.
          drawing={isDrawing ? drawingActions : undefined}
          onCopy={() => void copyNote()}
          onMove={() => {
            if (editing?.id == null) return;
            setMoreOpen(false);
            setMoveInput(readNoteFolder(editorText) ?? "");
            setMoveTarget(editing.id);
          }}
          onTasks={() => {
            setMoreOpen(false);
            setNoteTasksOpen(true);
          }}
          onHistory={() => {
            setMoreOpen(false);
            setHistoryOpen(true);
          }}
          onExport={() => {
            setMoreOpen(false);
            void exportNotePdf();
          }}
          onArchive={() => {
            setMoreOpen(false);
            void organizeCurrent(archiveNote, t("editor.flow.archiveFailed"));
          }}
          onTrash={() => {
            setMoreOpen(false);
            void organizeCurrent(trashNote, t("editor.flow.trashFailed"));
          }}
        />
      )}

      {photoNote && (
        <PhotoNoteSheet
          attachmentId={photoNote.id}
          filename={photoNote.filename}
          previewUrl={photoNote.previewUrl}
          // The pref AS THE IMPORT READ IT (`import_mobile.rs` reads the same
          // value and writes or skips the cache entry), frozen into the draft.
          // Reading it live would let a switch flipped in Settings re-probe a
          // cache that was never written and report "no text" about a page
          // nothing read.
          ocrEnabled={photoNote.ocrEnabled}
          onCommit={commitPhotoNote}
          onCancel={cancelPhotoNote}
          onOpenOcrSetting={() => {
            // The draft stays open under the settings sheet rather than being
            // thrown away: turning the switch on here affects the NEXT import
            // (this photo's cache was already skipped), and the user can still
            // add this one without text when they come back.
            setSettingsPanel("data");
            setSettingsOpen(true);
          }}
        />
      )}

      {manageAttachments && (
        <AttachmentsSheet
          onClose={() => setManageAttachments(false)}
          onInsert={(id, filename) => {
            insertIntoEditor(emitAttachmentEmbed(id, filename));
            setManageAttachments(false);
          }}
          onInsertText={(text) => {
            // A finished audio transcript inserts its TEXT into the open note
            // (MYND-563) - distinct from onInsert, which embeds an attachment ref.
            insertIntoEditor(text);
            setManageAttachments(false);
          }}
          onSavedNote={(id) => {
            // Saving a transcript from the in-editor sheet hands back the new
            // note. `openFromList` rather than `openNote`: the editor may hold
            // unsaved typing, and autosave is a debounce, so switching buffers
            // without flushing first silently discards it.
            setManageAttachments(false);
            void openFromList(id);
          }}
        />
      )}

      {noteTasksOpen && editing?.id && (
        <Sheet onClose={() => setNoteTasksOpen(false)} padded={false}>
          {() => (
            <TaskSurface
              scope={{ kind: "note", noteId: editing.id as string }}
              view={noteTaskView}
              onViewChange={setNoteTaskView}
              onOpen={() => setNoteTasksOpen(false)}
              testIdPrefix="tasks.note"
            />
          )}
        </Sheet>
      )}

      {historyOpen && editing?.id && (
        <SnapshotsSheet
          noteId={editing.id}
          // The note's own name under the sheet's title, the same subtitle the
          // desktop panel renders: the history belongs to a NOTE, and a sheet
          // opened from the ⋯ menu should say which one.
          noteTitle={deriveTitleSnippet(editorText).title || null}
          onClose={() => setHistoryOpen(false)}
          onRestored={() => {
            // The live note was overwritten on disk - re-read it into the editor.
            if (HAS_TAURI && editing?.id) void noteRead(editing.id).then(setEditorText).catch(() => {});
          }}
        />
      )}

      {presenceOpen && editing?.id && (
        <PresenceSheet
          noteId={editing.id}
          // Jump is one-shot: dispatch the peer's caret offset and let the editor's
          // own listener reveal that line (task 8). No follow mode exists on either
          // client.
          onJump={(peer) => requestPresenceJump(editing.id, peer)}
          onClose={() => setPresenceOpen(false)}
        />
      )}
      </>
    );
  };

  // ── Shared overlays - the purge + move confirm sheets. Staged from BOTH the
  // list (trash-row Delete / long-press Move) and the editor ⋯ menu; they
  // previously rendered only in the editor view, which left the list-staged
  // flows without their confirm sheet - rendering them in every layout fixes
  // that. ─────────────────────────────────────────────────────────────────────
  const renderSharedOverlays = () => (
    <>
      {/* Settings lives HERE rather than with the list overlays (myne-md/myne#926
          review): the compact phone branch renders the editor pane and the
          shared overlays but NOT the list overlays, so a settings sheet mounted
          from the list branch never opened while a note was on screen. The photo
          sheet's "reading is off" state offers exactly that route, and it was a
          dead button on the one client the feature ships on. */}
      {settingsOpen && (
        <SettingsSheet
          vaultId={vaultId}
          initialPanel={settingsPanel}
          onClose={() => {
            setSettingsOpen(false);
            setSettingsPanel(undefined);
          }}
          onLock={onLock}
          onDeleteVaultSuccess={onDeleteVaultSuccess}
          onShowApprovalCode={onShowApprovalCode}
          // The sync row's identity repair (myne-md/myne#1029). The sheet closes
          // first for the same reason the approval code's does: a sheet left
          // mounted under a full-screen overlay is how a phone ends up with a
          // settings panel over the screen it just opened.
          onUnlockIdentity={() => {
            setSettingsOpen(false);
            setSettingsPanel(undefined);
            setIdentityDoorOpen(true);
          }}
          // Offered over the AI panel, once per device (see the sheet's state above).
          onAiOnboarding={() => setAiOnboardingOpen(true)}
        />
      )}
      {/* The identity repair, over the editor (myne-md/myne#1029). Above the
          Settings sheet's own layer (`--z-modal` over the sheet's 40), because the
          sheet closes as this opens and an unlucky frame must not show both. */}
      {identityDoorOpen && (
        <div
          data-testid="editor.identity-door"
          style={{ position: "absolute", inset: 0, zIndex: "var(--z-modal)" }}
        >
          <IdentityFlow
            onCancel={() => setIdentityDoorOpen(false)}
            // Nothing is installed from this mount, so its landing is the exit.
            onAccepted={() => setIdentityDoorOpen(false)}
            // Present ⇒ this mount IS the repair door: the flow lands on the phrase
            // grid and calls this once the phrase is accepted instead of landing on
            // its home.
            //
            // What the command guarantees, and what it does not: `sync_person_unlock`
            // mints this device's signing key and then runs the binding claim, which
            // is BEST-EFFORT (`claim_own_binding_best_effort` logs its outcome and
            // returns). A store that cannot hold a key still leaves the row
            // unsettled, so this close is not a promise that sync now works; the
            // panel's own polled status is the answer, and that is the surface the
            // reader has to trust (myne-md/myne#1029 review).
            onUnlocked={() => setIdentityDoorOpen(false)}
          />
        </div>
      )}
      {/* SF5 share-import confirmation toast (§9.20, SYNC-18) - self-contained,
          listens for the drain result; renders in every layout branch. */}
      {/* MYND-640: tapping the toast opens the library the share landed in.
          Without it the only signal a share arrived was a sentence that
          disappeared after a few seconds, pointing at a place the user had no
          reason to open. */}
      <ShareImportToast onOpenLibrary={() => setTab("files")} />
      {/* Folder delete confirmation (myne-md/myne#628). Copy is the desktop
          modal's, key for key, so the two clients promise the same thing about
          where the notes go. Danger button first, matching the purge sheet
          below and the desktop button row. */}
      {folderTrash !== null && (
        <Sheet onClose={() => setFolderTrash(null)}>
          {(close) => (
            <>
              <div style={SHEET_TITLE}>{t("notes.list.deleteFolderTitle")}</div>
              {/* Two tones, the same split the desktop twin uses. The count is
                  the decision the user is making, so it carries full ink; the
                  reassurance about Trash is the quieter body tone, which is
                  where `DeleteConfirmModal` puts the identical string. */}
              <div data-testid="notes.folder-delete-body" style={SHEET_LEAD}>
                {t("notes.list.deleteFolderBody", {
                  name: folderTrash.name,
                  count: folderTrash.noteCount,
                })}
              </div>
              <div style={{ ...SHEET_BODY, marginTop: 4 }}>
                {t("notes.list.deleteFolderWarning")}
              </div>
              <div style={SHEET_ACTIONS}>
                <Button
                  variant="danger"
                  data-testid="notes.folder-delete-confirm"
                  onClick={() => void trashFolderFromMenu(folderTrash.path)}
                >
                  {t("notes.list.deleteFolderConfirm")}
                </Button>
                {/* `secondary`, not `ghost`: this Cancel sits under a filled
                    `--danger` button, and a borderless label is a weak way out
                    of a sheet that moves a whole subtree to the Trash. The
                    hand-rolled button it replaced carried a border too. */}
                <Button
                  variant="secondary"
                  data-testid="notes.folder-delete-cancel"
                  onClick={close}
                >
                  {t("common.prompt.cancel")}
                </Button>
              </div>
            </>
          )}
        </Sheet>
      )}
      {purgeId != null && (
        <Sheet onClose={() => setPurgeId(null)}>
          {(close) => (
            <>
          <div style={SHEET_TITLE}>{t("notes.trash.purgeConfirmTitle")}</div>
          <div style={SHEET_BODY}>{t("editor.purge.body")}</div>
          <div style={SHEET_ACTIONS}>
            <Button variant="danger" onClick={() => void confirmPurge()}>
              {t("notes.trash.purgeConfirmCta")}
            </Button>
            {/* `secondary` for the same reason as the folder-delete sheet: this
                one is the permanent purge, so the way out reads as a button. */}
            <Button variant="secondary" onClick={close}>
              {t("common.prompt.cancel")}
            </Button>
          </div>
            </>
          )}
        </Sheet>
      )}

      {moveTarget != null && (
        <Sheet onClose={() => setMoveTarget(null)}>
          {(close) => (
            <>
              <div style={SHEET_TITLE}>{t("editor.move.title")}</div>
              <div style={SHEET_BODY}>{t("editor.move.body")}</div>
              <input
                value={moveInput}
                onChange={(e) => setMoveInput(e.target.value)}
                placeholder={t("editor.move.placeholder")}
                autoFocus
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                style={{ marginTop: 14, width: "100%", height: 48, border: "1px solid var(--line-2)", borderRadius: 8, background: "var(--bg-1)", padding: "0 14px", fontFamily: "var(--font-mono)", fontSize: 16, color: "var(--fg-1)", outline: "none", boxSizing: "border-box" }}
              />
              {/* 16 rather than the shared 18: the input above already carries
                  its own top margin, so the usual gap reads as a wider one. */}
              <div style={{ ...SHEET_ACTIONS, marginTop: 16 }}>
                <Button variant="primary" onClick={() => void confirmMove()}>
                  {t("editor.move.confirm")}
                </Button>
                <Button variant="ghost" onClick={close}>
                  {t("common.prompt.cancel")}
                </Button>
              </div>
            </>
          )}
        </Sheet>
      )}
    </>
  );

  // A fold remounts the editor, so the caret and the scroll offset are captured
  // HERE, during the render that already knows the size class changed: by the
  // time an effect runs, the old CodeMirror view is gone and its offsets with
  // it. The undo history is not captured and cannot be; see `caretRestore.ts`.
  if (lastSizeClassRef.current !== sizeClass) {
    lastSizeClassRef.current = sizeClass;
    const previousView = editorViewRef.current;
    pendingCaretRef.current = previousView
      ? snapshotCaret(previousView, liveNoteIdRef.current, editorScrollRef.current)
      : null;
  }

  // ── Layout switch ────────────────────────────────────────────────────────────
  // One column (compact and the folded band): the existing full-screen list ⇄
  // editor swap (unchanged phone behavior, push/pop animation included). The
  // band differs only in the note's measure; it is not a two-pane layout, so
  // `isRegular` is false there and nothing below this block applies to it.
  // medium: list + detail side by side, the phone's AppHeader + TabBar scoped
  // to the list column. expanded: the WS-01 three-pane - sidebar + list +
  // detail; the sidebar absorbs the AppHeader/TabBar destinations, so neither
  // renders. Graph / Files / Templates span the full content width on regular
  // (a graph squeezed into a 316px column is useless).
  if (sizeClass === "compact") {
    if (view === "list") {
      return (
        <Screen ref={screenRef}>
          {renderNotesPane({ header: true, tabBar: true })}
          {renderListOverlays()}
          {renderSharedOverlays()}
        </Screen>
      );
    }
    return (
      <Screen ref={screenRef}>
        {renderEditorPane()}
        {renderEditorOverlays()}
        {renderSharedOverlays()}
      </Screen>
    );
  }

  // The folded band (600 to 700pt on a phone-class screen): ONE column, the note
  // at its own measure, and the list as an overlay drawer rather than a screen
  // swap. `view === "list"` still owns the intent, so the note's back chevron and
  // the swipe-back keep working: they save and raise the list over the note
  // instead of replacing it. With no note open there is nothing to overlay, so
  // the list is the screen.
  if (sizeClass === "compactWide") {
    const drawerOpen = view === "list" && editing != null;
    return (
      <Screen ref={screenRef}>
        <div
          // The note keeps its geometry while the drawer is up; it is taken out
          // of the accessibility and focus order rather than unmounted.
          inert={drawerOpen || undefined}
          style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
        >
          {editing ? renderEditorPane() : renderNotesPane({ header: true, tabBar: true })}
        </div>
        {drawerOpen && (
          <ListDrawer
            label={t("notes.list.treeLabel")}
            onClose={() => setView("editor")}
            returnFocusTo={editorViewRef.current?.contentDOM ?? null}
          >
            {renderNotesPane({ header: true, tabBar: false })}
          </ListDrawer>
        )}
        {renderListOverlays()}
        {renderEditorOverlays()}
        {renderSharedOverlays()}
      </Screen>
    );
  }

  return (
    <Screen>
      <div data-testid="workspace.split" style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {sizeClass === "expanded" && (
          <div
            // display:flex so the rail STRETCHES to full height (its flex:1 nav
            // pushes the footer to the bottom, where its edge lines up with the
            // editor FormatBar).
            style={{ width: panesCollapsed ? 0 : 64, flex: "none", minHeight: 0, display: "flex", overflow: "hidden", transition: "width var(--duration-slow) var(--ease-standard)" }}
          >
          {/* The rail, not the 248px sidebar (owner, 2026-11-27: three panels on
              a portrait iPad read as "çok rahatsız edici bir look"). Everyone
              the labelled pane listed is still one tap away, and the width it
              gives back belongs to the list and the note. */}
          <NavRibbon
            label={vaultDisplayLabel(prefs.label)}
            icon={prefs.icon}
            tab={tab}
            listView={listView}
            hasNote={editing?.id !== undefined}
            aiEnabled={prefs.ai_enabled === true}
            onHome={() => setTab("home")}
            onAllNotes={() => { setTab("notes"); setListView("notes"); setActiveTag(null); setActiveViewId(null); }}
            onTasks={() => setTab("tasks")}
            {...(editing?.id === undefined ? {} : { onNoteTasks: () => setTab("note-tasks") })}
            onGraph={() => setTab("graph")}
            onCalendar={() => setTab("calendar")}
            onFiles={() => setTab("files")}
            onTemplates={() => setTab("templates")}
            {...(prefs.ai_enabled ? { onChat: () => setTab("chat") } : {})}
            onViews={() => setViewsOpen(true)}
            onTags={() => setTagBrowserOpen(true)}
            onArchive={() => { setTab("notes"); setListView("archive"); setActiveTag(null); setActiveViewId(null); }}
            onTrash={() => { setTab("notes"); setListView("trash"); setActiveTag(null); setActiveViewId(null); }}
            onSearch={() => setPaletteOpen(true)}
            onSwitcher={() => setSwitcherOpen(true)}
            onSettings={() => setSettingsOpen(true)}
          />
          </div>
        )}
        {tab === "notes" ? (
          <>
            {/* Always mounted so the collapse ANIMATES its width (0 ⇄ pane) rather
                than snapping; `data-collapsed` is the state hook for tests. */}
            <div
              data-testid="workspace.list-pane"
              data-collapsed={panesCollapsed || undefined}
              style={{
                width: panesCollapsed ? 0 : sizeClass === "expanded" ? 316 : 340,
                flex: "none",
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                borderInlineEnd: panesCollapsed ? "none" : "1px solid var(--line-1)",
                overflow: "hidden",
                transition: "width var(--duration-slow) var(--ease-standard)",
              }}
            >
              {renderNotesPane({ header: sizeClass === "medium", tabBar: sizeClass === "medium" })}
            </div>
            <div data-testid="workspace.detail-pane" style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
              {editing ? renderEditorPane() : <EmptyDetail onNew={() => void newNote()} />}
            </div>
          </>
        ) : (
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
            {renderNotesPane({ header: sizeClass === "medium", tabBar: sizeClass === "medium" })}
          </div>
        )}
      </div>
      {/* Medium (vertical tablet): a focused note collapses the file tree but the
          main nav stays as a full-width bottom bar (the phone TabBar). */}
      {sizeClass === "medium" && panesCollapsed && (
        <TabBar
          active={tab}
          ai={prefs.ai_enabled}
          onNotes={() => { setTab("notes"); setPanesRevealed(true); }}
          onTasks={() => setTab("tasks")}
          onGraph={() => setTab("graph")}
          onAttachments={() => setTab("files")}
          onCalendar={() => setTab("calendar")}
          onChat={() => setTab("chat")}
        />
      )}
      {renderListOverlays()}
      {editing != null && renderEditorOverlays()}
      {renderSharedOverlays()}
    </Screen>
  );
}

/** Heading outline of a note body. Skips fenced code blocks so a `#` inside a
 *  ``` fence isn't mistaken for a heading. */
// Reuse the shared dialect's canonical heading model (single-parser rule) rather
// than a second regex scan - it is fence-aware AND drops frontmatter pseudo-
// headings, which the old hand-scan surfaced. `from` is the heading line's byte
// offset, our OutlineItem `index`.
function deriveOutline(text: string): OutlineItem[] {
  return headingSections(text).map((h) => ({ level: h.level, text: h.text, index: h.from }));
}
