import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CMEditor } from "@myne/editor/CMEditor";
import { typographyStyle } from "@myne/editor/typography";
import { REVEAL_ATTACHMENT_EVENT } from "@myne/editor/attachments/fileCardActions";
import { installTaskChipEditor } from "@myne/editor/decorations/task-chip-listener";
import { headingSections } from "@myne/dialect";
import type { EditorView } from "@codemirror/view";
import { emit, listen } from "@tauri-apps/api/event";
import { documentDir, join } from "@tauri-apps/api/path";
import {
  Screen,
  ScreenScroll,
  Icon,
  Banner,
  Spinner,
  Sheet,
  SnapshotFailedBanner,
  SyncBanners,
  ConflictsSheet,
} from "../../components";
import { noteList, noteRead, noteCreate, noteUpdate, deleteNoteRouted } from "../../lib/notes";
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
import { listVaults, orderByLastUnlock } from "../../lib/vault-list";
import { HAS_TAURI } from "../../lib/app-window";
import { effectiveMobileAutoLockSecs } from "../../lib/auto-lock";
import { consumePendingCapture, CAPTURE_EVENT, type CaptureMode } from "../../lib/deep-link";
import { drainPendingCaptures, sealStagedCaptures } from "../../lib/captures";
import { drainPendingShares } from "../../lib/shareImport";
import { ShareImportToast } from "./ShareImportToast";
import { ioBanner } from "../../lib/io-banner";
import { usePrefs } from "../../lib/use-prefs";
import { vaultDisplayLabel } from "../../lib/vault-label";
import { useSwipeBack } from "../../lib/use-swipe-back";
import { isRtl } from "../../lib/util";
import { setFavorites, setArchivedFolders, setDeliberateFolders, setFolderIcons, setItemColors, setItemOrder, PREFS_SYNC_APPLIED_EVENT } from "../../lib/prefs";
import { bumpPrefsNonce } from "../../lib/prefsNonce";
import { useHiddenHomeTiles } from "../../lib/home-tiles";
import { searchNotes } from "../../lib/search-notes";
import { buildTagIndex } from "../../lib/tags";
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
  trashNote,
  restoreNote,
  archiveNote,
  unarchiveNote,
  type NoteFlags,
} from "../../lib/note-organize";
import { deriveTree, subtreeCount, orderedChildren, childOrderIndex, reorderChildOrder, notesInSubtree } from "../../lib/folders";
import type { Child, OrderedNoteRecord } from "@myne/editor/host/notes/itemOrder";
import { toggleFolderExpanded, useExpandedFolders } from "../../lib/folder-expand-store";
import { ensureWorkspaceHydrated, flushWorkspaceNow } from "../../lib/workspace-persist";
import { resolveTodayNote, createNoteFromTemplate, createBlankNamedNote } from "../../lib/daily";
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
import { importFile, ATTACHMENT_ACCEPT } from "../../lib/attachments";
import { emitAttachmentEmbed } from "../../lib/attachmentRef";
import { AttachmentsSheet } from "./AttachmentsSheet";
import { RecordingSheet } from "./RecordingSheet";
import { VOICE_RECORD_EVENT } from "../../lib/voice-record-bridge";
import { SnapshotsSheet } from "./SnapshotsSheet";
import { TemplatesSheet } from "./TemplatesSheet";
import { unmarkTemplate, createTemplate } from "../../lib/templates";
import { deriveTitleSnippet } from "../../lib/note-title";
import { searchIndexReplace } from "../../lib/search";
import { vaultIndicesApply, vaultIndicesAllEdges, vaultIndicesPropertyValues, vaultIndicesPropertyKeys, type WikilinkEdge } from "../../lib/vault-indices";
import { extractRecord } from "../../lib/indices-extract";
import { buildNoteGraphAndModel, clientEdges } from "../../lib/backend-graph";
import { MarkdownView } from "../../components/MarkdownView";
import type { VaultSummary } from "../../types/vault-summary";
import type { EditorFlowProps } from "./types";
import { SettingsSheet, applyStoredTheme } from "./SettingsSheet";
import { useSizeClass } from "../../platform/SizeClassContext";
import { EmptyDetail } from "./editor/EmptyDetail";
import { SidebarPane } from "./editor/SidebarPane";
import { AppHeader } from "./editor/chrome/AppHeader";
import { ActionPill } from "./editor/chrome/ActionPill";
import { EditorTopBar } from "./editor/chrome/EditorTopBar";
import { FavoritesStrip } from "./editor/chrome/FavoritesStrip";
import { FormatBar } from "./editor/chrome/FormatBar";
import { GraphTab } from "./editor/chrome/GraphTab";
import { NoteRow } from "./editor/chrome/NoteRow";
import { FolderTreeRow } from "./editor/chrome/FolderTreeRow";
import { ReadingBar } from "./editor/chrome/ReadingBar";
import { TabBar } from "./editor/chrome/TabBar";
import { TaskSurface } from "../../components/TaskSurface";
import { EMPTY_SCOPE, type TaskScope } from "@myne/task-scope";
import { takeReminderLanding } from "../../lib/reminderLanding";
import { vaultTasks } from "../../lib/tasks";
import { NoteContextPanel } from "./editor/panels/NoteContextPanel";
import { CommandPalette } from "./editor/sheets/CommandPalette";
import { FilterSheet } from "./editor/sheets/FilterSheet";
import { NoteActionsSheet } from "./editor/sheets/NoteActionsSheet";
import { NoteRowActionsSheet } from "./editor/sheets/NoteRowActionsSheet";
import { FolderActionsSheet } from "./editor/sheets/FolderActionsSheet";
import { DecorationSheet } from "./editor/sheets/DecorationSheet";
import { SortSheet } from "./editor/sheets/SortSheet";
import { TagBrowserSheet } from "./editor/sheets/TagBrowserSheet";
import { VaultSwitcher } from "./editor/sheets/VaultSwitcher";
import { ViewsSheet } from "./editor/sheets/ViewsSheet";
import type { NoteEntry, OutlineItem, PaletteCommand } from "./editor/types";

/**
 * Editor flow — the wired main surface after unlock. Mirrors the static
 * `notes/05·06` list + `notes/07` reading + `workspace/08` editor +
 * `workspace/11 · Settings` screens, but driven by the real `notes` plugin.
 *
 * View machine: `list` ⇄ `editor`. Mount → `noteList()` then `noteRead()` per
 * id to derive a (title, snippet) for each row. `+` opens a blank editor;
 * tapping a row opens it on that note's plaintext (plain <textarea>, the mobile
 * port of the desktop B4.5 stub — no CodeMirror). Save → `noteCreate` /
 * `noteUpdate`; delete → `noteDelete`. The gear (Settings tab) opens the
 * <SettingsSheet>; the "Personal ▾" bar opens a vault switcher.
 *
 * Note plaintext is held in component-local state for the controlled textarea
 * and wiped on every exit path + on unmount (best-effort; the load-bearing
 * zeroize is Rust-side per `src-tauri/CLAUDE.md`).
 */

type Editing = { id: string | null };

/** Left-to-right tab position — drives the slide direction of the page
 *  transition: moving to a higher-indexed tab enters from the right, a
 *  lower-indexed tab from the left (an iOS push/pop feel across the tab row). */
const TAB_ORDER: Record<"notes" | "tasks" | "note-tasks" | "search" | "graph" | "files" | "templates", number> = {
  notes: 0,
  // MYND-620: `tasks` is placed between notes and graph rather than appended,
  // because this record is what decides the push/pop slide direction — a tab
  // that sits second in the bar and last in this record slides in from the
  // wrong side.
  tasks: 1,
  "note-tasks": 2,
  search: 3,
  graph: 4,
  files: 5,
  templates: 6,
};

/** Editor typography presets (mirror the desktop `editor-typography` prefs), so
 *  the Appearance settings tangibly change the note editor. */
// Reading-view (MarkdownView) base font px — matches the shared editor-typography
// TEXT_SIZE presets so reading mode + the live editor + desktop stay consistent
// (MYND-483). The live editor itself uses `typographyStyle` CSS vars, not this.
const EDITOR_TEXT_PX: Record<string, number> = { sm: 13, md: 14, lg: 16, xl: 18 };

const DEV_SEED: string[] = [
  "# Threat model v2\n\nWe assume a powerful network adversary that can observe all traffic and compromise the relay. The vault key never leaves the device.",
  "# Weekly review — 2026-06-15\n\nShipped the sync conflict resolver. Next: mobile share sheet and editor polish.",
  "# Reading — Seeing Like a State\n\nLegibility as the central drive of the modern state. Chapter 1 notes.",
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


export function EditorFlow({ vaultId, onLock, onCreateVault, onJoinAccount, onSwitchVault, onDeleteVaultSuccess }: EditorFlowProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<"list" | "editor">("list");
  const [tab, setTab] = useState<"notes" | "tasks" | "note-tasks" | "search" | "graph" | "files" | "templates">("notes");
  // Layout axis (SizeClassContext): compact = the phone's full-screen list ⇄
  // editor swap; medium/expanded ("regular") = persistent multi-pane split.
  // `view` stays the compact navigation intent; `editing` drives the detail
  // pane on regular (the invariant `view === "editor" ⟺ editing != null`
  // already holds on compact).
  const { sizeClass } = useSizeClass();
  const isRegular = sizeClass !== "compact";

  // Slide the incoming tab page in from the side its tab sits on (Notes ← … →
  // Templates). Same Web-Animations technique as the Settings drawer; the first
  // paint and editor round-trips (tab unchanged) don't animate.
  const tabPaneRef = useRef<HTMLDivElement>(null);
  const prevTabRef = useRef(tab);
  useLayoutEffect(() => {
    const prev = prevTabRef.current;
    prevTabRef.current = tab;
    if (tab === prev) return;
    // Regular layouts don't page-flip — the prev ref still updates above so a
    // later rotation back to compact can't replay a stale slide.
    if (sizeClass !== "compact") return;
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
      { duration: 260, easing: "cubic-bezier(0.22, 0.61, 0.36, 1)", fill: "backwards" },
    );
  }, [tab]);

  // Push/pop the whole screen when moving between the note LIST and the EDITOR
  // (iOS nav feel — opening a note pushes in from the right, back pops from the
  // left). Both branches render `<Screen>` in the same slot, so React reuses the
  // element and `screenRef` stays valid across the swap. First paint doesn't run.
  const screenRef = useRef<HTMLDivElement>(null);
  const prevViewRef = useRef(view);
  useLayoutEffect(() => {
    const prev = prevViewRef.current;
    prevViewRef.current = view;
    if (view === prev) return;
    // The push/pop is compact-only: on regular both panes are persistent (no
    // screen swap). Updating the prev ref unconditionally above prevents a
    // stale animation when rotating back to compact.
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
      { duration: 340, easing: "cubic-bezier(0.22, 0.61, 0.36, 1)", fill: "backwards" },
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
    if (changed && HAS_TAURI) void setItemColors(next).then(bumpPrefsNonce).catch(bumpPrefsNonce);
  }, [prefs.item_colors]);
  useEffect(() => {
    const { next, changed } = foldDecorationKeys(prefs.folder_icons);
    if (changed && HAS_TAURI) void setFolderIcons(next).then(bumpPrefsNonce).catch(bumpPrefsNonce);
  }, [prefs.folder_icons]);

  const [notes, setNotes] = useState<NoteEntry[]>([]);
  // Raw note bodies (id → text), kept so the Graph tab can compute the wikilink
  // graph without a second read — the list load already decrypts every note.
  const [bodies, setBodies] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [editing, setEditing] = useState<Editing | null>(null);
  const [readingMode, setReadingMode] = useState(false);
  // Raw (source) vs live-preview inside the editor — toggled from the FormatBar.
  const [rawMode, setRawMode] = useState(false);
  const [editorText, setEditorText] = useState("");
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  // Drawing dispatch (SF2): a value-strict `kind: drawing` body routes the editor
  // pane to the shared Excalidraw canvas instead of CMEditor (parity w/ PaneView).
  const isDrawing = useMemo(() => isDrawingBody(editorText), [editorText]);

  // Regular size classes: focusing a note collapses the left panes (sidebar +
  // note list) so the editor gets the full width — the EditorTopBar toggle reveals
  // them, and the next note open auto-collapses again (the effect below). On
  // medium the main nav (TabBar) stays as a full-width bottom bar while collapsed.
  const [panesRevealed, setPanesRevealed] = useState(false);
  // Collapse only for an EXISTING focused note (`editing.id` set) — a brand-new
  // note keeps the list on screen (you're still placing it; matches the tablet
  // flow-logic UX), so `editing?.id` not `editing`.
  const panesCollapsed = isRegular && tab === "notes" && editing?.id != null && !panesRevealed;
  useEffect(() => {
    setPanesRevealed(false);
  }, [editing?.id]);

  // No-op-write guard: the open note's RAW buffer text as of its last
  // successful read or write, keyed by id so a stale in-flight write can never
  // stamp another note's baseline. Every save path checks it and skips the
  // disk write when the buffer is untouched — a rewrite of identical content
  // would burn a fresh nonce and bump `updated:`, which sync reads as a
  // phantom edit (conflict bait on every open+background). `updated:` is
  // stamped at write time, so the baseline deliberately stores the PRE-stamp
  // buffer and every comparison is raw-vs-raw.
  const loadedTextRef = useRef<{ id: string; text: string } | null>(null);
  /** True when the note's buffer is byte-identical to its last read/written
   *  body — i.e. persisting now would be a pure no-op rewrite. */
  const editorUnchanged = (id: string) =>
    loadedTextRef.current?.id === id && loadedTextRef.current.text === editorText;

  // Flush the open note to disk when the app is BACKGROUNDED / hidden. Mobile
  // otherwise persists only on an explicit exit (back / swipe-back / switching
  // notes) — but a drawing has no such exit on tablet (you just draw and leave),
  // so an edit was lost to an app suspend/kill before it ever hit disk (and thus
  // never synced). This closes that window: best-effort + detached; the foreground
  // sync loop pushes it on resume. `flushRef` reads the latest state so the
  // listeners register once. A brand-new note is create-flushed at most once
  // (guarded) to avoid duplicate blobs across repeated backgrounding.
  const newNoteFlushedRef = useRef(false);
  useEffect(() => {
    newNoteFlushedRef.current = false;
  }, [editing?.id]);
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    if (!HAS_TAURI || !editing) return;
    if (editing.id != null) {
      const id = editing.id;
      const raw = editorText;
      // Untouched since load / last write → nothing to persist. Updating the
      // baseline BEFORE the write resolves also collapses the visibilitychange
      // + pagehide double-fire into a single write.
      if (editorUnchanged(id)) return;
      loadedTextRef.current = { id, text: raw };
      void noteUpdate(id, stampUpdated(raw)).catch(() => {
        // Failed write: drop the baseline so a later flush/save retries.
        if (loadedTextRef.current?.id === id) loadedTextRef.current = null;
      });
    } else if (editorText.trim() !== "" && !newNoteFlushedRef.current) {
      newNoteFlushedRef.current = true;
      void noteCreate(stampUpdated(editorText)).catch(() => {
        newNoteFlushedRef.current = false;
      });
    }
  };
  useEffect(() => {
    // ONE listener pair for the whole app-background moment. Everything that must
    // reach disk before an OS kill hangs off it: the open note's body, and the
    // sidebar folder-expand set (MYND-561 — `vault.workspace`'s only other write
    // seam is `lockVault()`). Both are best-effort and independent; neither can
    // block the other, and a second registration for the same event would just be
    // two ways to get the same moment wrong.
    const flushAll = () => {
      flushRef.current();
      void flushWorkspaceNow();
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
  }, []);

  // Compact-only left-edge swipe-back: same semantics as the top-bar chevron
  // (autosave + return to the list), same busy guard. `saveNote` is a hoisted
  // function declaration, so referencing it here is fine.
  useSwipeBack(
    screenRef,
    () => {
      if (!editorBusy) void saveNote();
    },
    sizeClass === "compact" && view === "editor",
  );
  // Attachment insert: the editor textarea + hidden file input, and a busy flag
  // while the picked file is encrypted (MYA1) on the host.
  const attachInputRef = useRef<HTMLInputElement>(null);
  const [attaching, setAttaching] = useState(false);
  // The live CMEditor view, handed over via <CMEditor onReady>. Drives the
  // above-keyboard FormatBar through the shared @myne/editor commands.
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const [manageAttachments, setManageAttachments] = useState(false);
  // Voice-note recording sheet open (mic button / widget voice capture / the
  // shared editor's `/record` slash all raise this).
  const [recordOpen, setRecordOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Editor side panel (mobile stand-in for the desktop side sheet): note
  // context + actions, sliding in from the right.
  const [rightPanel, setRightPanel] = useState(false);
  // Note actions overflow (⋯): Copy / Move / History / Export / Archive / Trash.
  const [moreOpen, setMoreOpen] = useState(false);
  // MYND-620 task 4: the phone's answer to the desktop's note-scoped side panel.
  // There is no permanently-visible panel beside an editor on a phone, so the
  // same information arrives as a sheet on request — the established mechanism
  // that attachments, snapshots, templates, settings and the view editor all
  // already use.
  const [noteTasksOpen, setNoteTasksOpen] = useState(false);
  // Long-press action sheet target: the list-row note whose actions are open.
  const [rowActions, setRowActions] = useState<NoteEntry | null>(null);
  // Backend vault-indices edge dump (null until the first sweep; drives the
  // Turkish-correct graph + backlinks). Falls back to the client graph in dev.
  const [backendEdges, setBackendEdges] = useState<[string, WikilinkEdge[]][] | null>(null);
  // Permanent-delete confirm target: a note id being purged from Trash, or null.
  const [purgeId, setPurgeId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  // SY-08 sync status detail sheet (MYND-461 T6), opened from the header glyph.
  // Conflicts sheet (MYND-461 T8), opened from the conflicts count banner.
  const [conflictsOpen, setConflictsOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [vaults, setVaults] = useState<VaultSummary[]>([]);
  // Active `#tag` filter on the notes list (folded/lowercase key), or null.
  const [activeTag, setActiveTag] = useState<string | null>(null);
  // Notes-list sort: backend order ("none") / title A–Z / Z–A.
  const [sortMode, setSortMode] = useState<"none" | "az" | "za">("none");
  // Which slice of the notes tab is shown: live notes / archive / trash.
  const [listView, setListView] = useState<"notes" | "archive" | "trash">("notes");
  // MYND-620 task 3: the Tasks destination's folder/tag narrowing. Owned here so
  // it survives leaving and re-entering the destination — a scope that silently
  // reset on every visit would be a control that does not hold.
  const [taskScope, setTaskScope] = useState<TaskScope>(EMPTY_SCOPE);

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
      // identifier still names one, and to the Tasks list when it does not —
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
  // Folder path armed for the inline "Move N notes to Trash?" confirm (null = none).
  const [confirmArchiveFolder, setConfirmArchiveFolder] = useState<string | null>(null);
  // Current folder for NEW-note placement (root by default; the tree no longer
  // drills, so this stays null unless a future "new note in folder" sets it).
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  // OPEN folders in the inline hierarchy, keyed by folded folder identity
  // (MYND-561). Owned by a module store — not `useState` — and persisted into the
  // `vault.workspace` container so the set survives a restart; see
  // `lib/folder-expand-store.ts` for why the store owns it and
  // `lib/workspace-persist.ts` for the encoding + write cadence. Polarity is
  // desktop's (present = expanded, empty = all collapsed), so a cold vault opens
  // collapsed on both clients. The list is a tree, not a drill-down.
  const expandedFolders = useExpandedFolders();
  // Filter sheet (the single home for Tags / Views / Archive / Trash).
  const [filterOpen, setFilterOpen] = useState(false);
  // Sort sheet — the sort-order picker (same modal treatment as Filter).
  const [sortOpen, setSortOpen] = useState(false);
  // Views sheet — browse/activate saved views + create a new one.
  const [viewsOpen, setViewsOpen] = useState(false);
  // Inline note-list search (filters THIS page's list; NOT the command palette).
  const [searchQuery, setSearchQuery] = useState("");
  // Command palette — opened from the header button (left of Settings).
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Tag Browser (multi-select tag filter → matching notes; desktop bottom-bar port).
  const [tagBrowserOpen, setTagBrowserOpen] = useState(false);
  // Editor "Move to folder": the note id being moved + the folder-path input.
  const [moveTarget, setMoveTarget] = useState<string | null>(null);
  const [moveInput, setMoveInput] = useState("");
  // Folder create + long-press actions (MYND-473 / MYND-480).
  const [folderActions, setFolderActions] = useState<{ path: string; name: string } | null>(null);
  const [folderPrompt, setFolderPrompt] = useState<
    | { mode: "new" }
    | { mode: "subfolder"; parent: string }
    | { mode: "rename"; path: string }
    | null
  >(null);
  const [folderPromptInput, setFolderPromptInput] = useState("");
  // Color / folder-icon picker target (MYND-516) — a note (color only) or a
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
  // The store is the single owner, so this is a plain replace with disk truth —
  // no mount-order ref, and a toggle that beats it just gets overwritten (same
  // outcome as a cold start).
  //
  // The WRITE side rides the app-background listener above (and `lockVault()`).
  // Per-toggle writes are deliberately NOT a seam: `vault.workspace`'s mtime is
  // visible to an adversary with filesystem access even though its contents are
  // sealed, and desktop keeps that mtime from becoming an activity log by writing
  // on graceful exit only (design grill 2026-06-01 Q1). Backgrounding is the
  // mobile equivalent — an OS kill of a backgrounded app is the normal way a
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


  // Managed frontmatter flags per note (trashed/archived/template/…) — the
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
  const liveNotes = useMemo(() => notes.filter((n) => isLiveNote(noteFlags.get(n.id)!)), [notes, noteFlags]);
  // The note-set every RESOLVER surface runs against (graph, backlinks, the
  // vault-indices sweep) — desktop's `resolverCache` rule, verbatim
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
        // drift from desktop's again. Archived notes stay resolvable — archive
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
  // #46: `isTrashedNote` excludes TOMBSTONES (`deleted:`). Without that clause
  // "Delete permanently" was a visible no-op — the tombstone it writes left the
  // row rendered, so the note looked like it was still in the trash.
  const trashedNotes = useMemo(
    () => notes.filter((n) => isTrashedNote(noteFlags.get(n.id) ?? {})),
    [notes, noteFlags],
  );
  const archivedNotes = useMemo(
    () => notes.filter((n) => isArchivedNote(noteFlags.get(n.id) ?? {})),
    [notes, noteFlags],
  );
  // Template notes (`template: true`) — excluded from the live list; managed via
  // the Templates sheet + instantiated by the daily-note engine.
  const templateNotes = useMemo(
    () =>
      notes
        .filter((n) => isListedTemplate(noteFlags.get(n.id) ?? {}))
        .map((n) => ({ id: n.id, title: deriveTitleSnippet(bodies.get(n.id) ?? "").title })),
    [notes, noteFlags, bodies],
  );

  // Folder path per live note (from `folder:` frontmatter) — the drill-down tree.
  const folderOf = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const n of liveNotes) m.set(n.id, readNoteFolder(bodies.get(n.id) ?? ""));
    return m;
  }, [liveNotes, bodies]);

  // The interleave cache (MYND-596): note id → `updatedAt`, the recency key the
  // shared `orderContainerChildren` reads for unlisted notes. A superset (all
  // notes) is fine — the ranker only touches the ids a container actually holds.
  const orderCache = useMemo<Map<string, OrderedNoteRecord>>(
    () => new Map(notes.map((n) => [n.id, { updatedAt: updatedById.get(n.id) ?? null }])),
    [notes, updatedById],
  );
  // The FULL folder tree (fav/archive-unfiltered) — the reorder handlers resolve
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
  // (folder-archive never rewrites notes), so it sits in `liveNotes` — split those
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
  // The note→folder map with folder-archived notes removed — the map every
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
  // Folder of each note shown by the Archive view — folder-archived LIVE notes
  // plus note-flag `archived:` notes — so the root can drop notes already under a
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
  // The `#tag` index over the LIVE notes — drives the notes-list tag filter.
  const tagIndex = useMemo(() => buildTagIndex(liveNotes, bodies), [liveNotes, bodies]);
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
  // id not yet ordered — e.g. a view authored on another client).
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
  // (`runView`) over the same resolvers the tag/folder chips use — so a saved
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

  // Favorites (prefs.favorites — an ordered list of note UUIDs). Favorited notes
  // sort to the top of the notes list; a star toggle lives on each row.
  const favSet = useMemo(() => new Set(prefs.favorites), [prefs.favorites]);
  const toggleFavorite = useCallback(
    (id: string) => {
      const cur = prefs.favorites;
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      if (HAS_TAURI) void setFavorites(next).then(bumpPrefsNonce).catch(bumpPrefsNonce);
    },
    [prefs.favorites],
  );

  // Move-up/move-down reorder (MYND-596). Offered only in the plain notes tree —
  // where `item_order` is the active ordering — and, for notes, never for a
  // favorited one (it lives in the strip, ordered by `favorites`, not
  // `item_order`). Each nudge rewrites the acted row's container sequence and
  // persists via the whole-map `set_item_order`, then bumps the prefs nonce (the
  // favorites-writer chokepoint) so the re-read reflects the new order.
  const reorderableTree =
    listView === "notes" && !activeTag && activeViewId == null && searchQuery.trim() === "";
  const persistItemOrder = (next: Record<string, string[]> | null) => {
    if (next && HAS_TAURI) void setItemOrder(next).then(bumpPrefsNonce).catch(bumpPrefsNonce);
  };
  const noteReorder = (id: string) => {
    if (!reorderableTree || favSet.has(id)) return undefined;
    const containerPath = folderOf.get(id) ?? null;
    const { index, count } = childOrderIndex({
      tree: fullTree, itemOrder: prefs.item_order, cache: orderCache, containerPath, rowKey: id,
    });
    if (index < 0) return undefined;
    const nudge = (delta: -1 | 1) =>
      persistItemOrder(reorderChildOrder({
        tree: fullTree, itemOrder: prefs.item_order, cache: orderCache, containerPath, rowKey: id, delta,
      }));
    return { id, canUp: index > 0, canDown: index < count - 1, onUp: () => nudge(-1), onDown: () => nudge(1) };
  };
  const folderReorder = (path: string) => {
    if (!reorderableTree) return undefined;
    // The folder's container is its PARENT (null for a top-level folder).
    const anc = ancestorPaths(path);
    const containerPath = anc.length >= 2 ? anc[anc.length - 2]! : null;
    const { index, count } = childOrderIndex({
      tree: fullTree, itemOrder: prefs.item_order, cache: orderCache, containerPath, rowKey: path,
    });
    if (index < 0) return undefined;
    const nudge = (delta: -1 | 1) =>
      persistItemOrder(reorderChildOrder({
        tree: fullTree, itemOrder: prefs.item_order, cache: orderCache, containerPath, rowKey: path, delta,
      }));
    return { key: folderKey(path), canUp: index > 0, canDown: index < count - 1, onUp: () => nudge(-1), onDown: () => nudge(1) };
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
  // entering compact must land on a concrete screen — the editor when a note is
  // open, the list otherwise. Regular layouts ignore `view`, but every setView
  // call still fires (navigation intent) so the view-keyed default-view-mode
  // effect above keeps working on all size classes. Deps intentionally narrow:
  // this reconciles ONLY when the size class itself flips.
  useEffect(() => {
    if (sizeClass === "compact") setView(editing ? "editor" : "list");
  }, [sizeClass]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stop filtering when the active view is deleted elsewhere (prefs refresh).
  useEffect(() => {
    if (activeViewId != null && !orderedViews.some((v) => v.id === activeViewId)) {
      setActiveViewId(null);
    }
  }, [activeViewId, orderedViews]);

  // Keep the backend MYS1 search index synced with the live corpus (the WebView
  // already holds every note's plaintext). Debounced bulk atomic replace so a
  // burst of edits rebuilds the index once, not per save.
  useEffect(() => {
    if (!HAS_TAURI) return;
    const docs = liveNotes.map((n) => ({ id: n.id, title: n.title, body: bodies.get(n.id) ?? "" }));
    const t = window.setTimeout(() => void searchIndexReplace(docs).catch(() => {}), 400);
    return () => window.clearTimeout(t);
  }, [liveNotes, bodies]);

  // Feed the backend vault-indices (MYI1) — extract each note's links/tags
  // TS-side, apply (in parallel), then read the Turkish-correctly-folded edge
  // dump back to drive the graph + backlinks. Debounced; falls back to the
  // client graph on any failure.
  useEffect(() => {
    if (!HAS_TAURI) {
      setBackendEdges(null);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          await Promise.all(
            resolverNotes.map((n) =>
              vaultIndicesApply(
                extractRecord(n.noteUuid, n.title ?? "", n.folder, bodies.get(n.noteUuid) ?? ""),
              ),
            ),
          );
          const edges = await vaultIndicesAllEdges();
          if (!cancelled) setBackendEdges(edges);
        } catch {
          if (!cancelled) setBackendEdges(null);
        }
      })();
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [resolverNotes, bodies]);

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

  const refresh = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const { entries, texts } = await loadEntries();
      setNotes(entries);
      setBodies(texts);
    } catch (raw) {
      const e = raw as NoteListError;
      console.error("[notes] load failed:", raw);
      setListError(
        e && typeof e === "object" && e.kind === "Io"
          ? ioBanner(e.detail.io_error_kind)
          : t("editor.flow.loadFailed"),
      );
    } finally {
      setLoading(false);
    }
  }, [loadEntries]);

  // #213: the resolver note-set fed to the shared editor so `![[Drawing]]` embeds
  // (and wikilink chips generally) resolve — mobile did not wire this before, so
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

  // #213: the inline-drawing-embed IO seam. Mobile is an OPEN-FULL-SCREEN host —
  // tapping a drawing embed opens the drawing's own screen (reusing the existing
  // full-screen canvas) rather than a cramped inline canvas, and there is no
  // inline rename (no ref-rewriting rename on mobile). `saveScene`/`renameDrawing`
  // are deliberately omitted; the shared widget hides the inline canvas + makes the
  // title static accordingly. Live deps read through a ref so the seam stays stable.
  const drawingLiveRef = useRef({ editorText, notes, bodies, openRelated, refresh });
  drawingLiveRef.current = { editorText, notes, bodies, openRelated, refresh };
  const drawingIo = useMemo<DrawingEmbedIo>(
    () => ({
      readScene: async (id) => extractSceneJson(await noteRead(id)),
      createSibling: async () => {
        const live = drawingLiveRef.current;
        const folder = readNoteFolder(live.editorText) || null;
        const title = nextMobileDrawingTitle(live.notes, live.bodies);
        await noteCreate(
          new TextDecoder().decode(buildDrawingNoteBytes(title, folder)),
        );
        // Reload so the new drawing enters the resolver note-set and the just-
        // inserted `![[Drawing N]]` resolves to it.
        await live.refresh();
        return title;
      },
      openNote: (id) => void drawingLiveRef.current.openRelated(id),
    }),
    [],
  );

  // #179: the whole-note drawing's Excalidraw API — its mobile-menu items (Theme /
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
  useEffect(() => {
    applyStoredTheme();
    void (async () => {
      if (HAS_TAURI) await maybeSeedTestData();
      await refresh();
    })();
  }, [refresh]);

  // SYNC-37: the foreground sync loop (and manual `sync_now`) emit `sync://changed`
  // after a pull writes incoming notes to disk — reload the list + bodies so notes
  // synced from another device actually appear without a manual refresh. Ported
  // from the desktop `Editor.tsx` listener.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const handle = await listen("sync://changed", () => {
          if (!cancelled) void refresh();
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
  }, [refresh]);

  // MYND-478: the sync loop merges remote `vault.prefs` changes onto disk and
  // emits `PREFS_SYNC_APPLIED_EVENT` (never for this device's own IPC writes).
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
  useConflictMaterializer(refresh);

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
  // seam. This is the SAME implementation the desktop installs — without it the
  // chips render and do nothing, which is exactly the state the mobile editor
  // shipped in (the decoration is cross-client; only desktop had listened).
  useEffect(() => installTaskChipEditor(), []);

  // Auto-lock: re-lock the vault after `auto_lock_seconds` of inactivity (any
  // touch / key / pointer resets the countdown). Idle re-lock is what makes the
  // quick-unlock PIN fast-path actually appear on the next unlock.
  useEffect(() => {
    if (!HAS_TAURI) return;
    // A6 envelope: the effective timeout is always in [30, 3600] — a sentinel/
    // replayed "off" (0) can no longer disable the idle lock (matches desktop's
    // always-on `effective_auto_lock_secs`). No disable path.
    const secs = effectiveMobileAutoLockSecs(prefs.auto_lock_seconds);
    // #53: compare TIMESTAMPS, do not count down.
    //
    // This was a `setTimeout` the countdown restarted on every touch. A phone
    // suspends timers the moment the app leaves the foreground, so time spent
    // backgrounded — which is most of the time a phone is unattended, and
    // exactly the A6 "lost or stolen device" case auto-lock is for — never
    // counted toward the deadline. A vault locked 30 seconds after the user
    // came back rather than 30 seconds after they left.
    //
    // Same shape as the shared web timer (`src/hooks/useIdleAutoLock.ts`),
    // including the load-bearing half: the deadline is re-evaluated when the
    // app becomes visible again, which is the first moment the elapsed time is
    // observable at all.
    let lastActivity = Date.now();
    let fired = false;
    const evaluate = () => {
      if (fired) return;
      if (Date.now() - lastActivity >= secs * 1000) {
        fired = true;
        onLock();
      }
    };
    const markActive = () => {
      // After firing, activity does not un-lock: the vault is locked and the
      // unlock screen owns what happens next.
      if (fired) return;
      lastActivity = Date.now();
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") evaluate();
    };
    const events: (keyof WindowEventMap)[] = ["touchstart", "keydown", "pointerdown", "mousedown"];
    events.forEach((e) => window.addEventListener(e, markActive, { passive: true }));
    document.addEventListener("visibilitychange", onVisibility);
    // A coarse tick: the deadline is a timestamp comparison, so the interval
    // only decides how promptly a FOREGROUND idle is noticed — the suspended
    // case is handled by the visibility check above.
    const timer = window.setInterval(evaluate, 5000);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      events.forEach((e) => window.removeEventListener(e, markActive));
    };
  }, [prefs.auto_lock_seconds, onLock]);

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
          { id: vaultId ?? "dev-personal", status: { kind: "Exists" }, label: "Personal", icon: "book", last_unlock: Date.now() },
          { id: "dev-work", status: { kind: "Exists" }, label: "Work", icon: null, last_unlock: Date.now() - 86_400_000 },
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

  const newNote = useCallback(() => {
    // Create in the folder you're currently viewing (root → empty body).
    setEditorText(buildInitialPlaintext(normalizeFolderPath(currentFolder)));
    setEditing({ id: null });
    setEditorError(null);
    setReadingMode(false);
    setView("editor");
  }, [currentFolder]);

  const newDrawing = useCallback(() => {
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
  // sheet in its ready state — the user taps Stop when done (safer than
  // auto-arming the mic on a cold launch).
  const startCapture = useCallback((mode: CaptureMode) => {
    newNote();
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
  // path (password / PIN / biometric / reload-probe), so draining here turns any
  // queued watch-dictated captures into notes right after unlock.
  // `drainPendingCaptures` self-serialises (StrictMode-safe) and is a no-op when
  // the queue is empty; refresh the list if it created any so they appear.
  useEffect(() => {
    const runDrain = () => {
      // Share-import drain (§9.20, SYNC-4/6): decrypt + import any files shared
      // via the OS share sheet into the attachment library, host-side. A sibling
      // of the capture drain — independent (it refreshes the library, not the
      // notes list) and self-serialising; its SF5 toast is rendered by
      // <ShareImportToast/>.
      void drainPendingShares();
      void (async () => {
        // Seal any just-staged watch captures first, then drain the queue into
        // notes (both no-op when empty / the host is absent).
        await sealStagedCaptures();
        const created = await drainPendingCaptures();
        if (created > 0) await loadEntries();
      })();
    };
    runDrain(); // on mount — every unlock path lands here
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
  }, [loadEntries]);
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
      let text: string;
      try {
        text = HAS_TAURI ? await noteRead(id) : devStore().get(id) ?? "";
      } catch {
        // A failed read must NOT bind the editor: committing an empty buffer
        // under the note's id would hand every later flush/save that id with a
        // blank body — overwriting the real note (silent data loss). Stay on
        // the list and surface the failure there instead.
        setListError(t("editor.flow.openFailed"));
        return;
      }
      loadedTextRef.current = { id, text };
      setEditorText(text);
      setEditing({ id });
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
      if (editing.id === null) {
        if (HAS_TAURI) await noteCreate(stamped);
        else devStore().set(crypto.randomUUID(), stamped);
      } else {
        if (HAS_TAURI) await noteUpdate(editing.id, stamped);
        else devStore().set(editing.id, stamped);
        loadedTextRef.current = { id: editing.id, text: editorText };
      }
      await refresh();
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
      await refresh();
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
        if (HAS_TAURI) await noteUpdate(editing.id, stamped);
        else devStore().set(editing.id, stamped);
        loadedTextRef.current = { id: editing.id, text: editorText };
        await refresh();
      } catch {
        // Best-effort save; still navigate so the backlink isn't a dead tap.
      }
    }
    await openNote(id);
  }

  /** Open a note from any LIST surface (rows, favorites, graph, palette, tag
   *  browser, templates). On compact the list is only reachable with no editor
   *  open (`exitEditor` precedes it), so this reduces to `openNote`. On regular
   *  the editor pane stays mounted next to the list: persist the in-progress
   *  note first — an existing note through `openRelated`'s save-then-open, a
   *  brand-new non-empty note by creating it — so a row tap never silently
   *  discards typed text. */
  async function openFromList(id: string) {
    if (isRegular && editing != null && editing.id === null && editorText.trim() !== "") {
      try {
        const stamped = stampUpdated(editorText);
        if (HAS_TAURI) await noteCreate(stamped);
        else devStore().set(crypto.randomUUID(), stamped);
        await refresh();
      } catch {
        // Best-effort persist; still navigate so the tap isn't dead.
      }
    }
    await openRelated(id);
  }

  /** Move the open note to Trash / Archive (soft, reversible), then exit. */
  async function organizeCurrent(fn: (id: string) => Promise<void>, failMsg: string) {
    if (editing?.id == null) return;
    try {
      await fn(editing.id);
      await refresh();
      exitEditor();
    } catch {
      setEditorError(failMsg);
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
        if (HAS_TAURI) await noteUpdate(id, editorText);
        else devStore().set(id, editorText);
        loadedTextRef.current = { id, text: editorText };
      }
      await moveNoteToFolder(id, dest);
      await refresh();
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
  function newNoteInFolder(path: string) {
    setFolderActions(null);
    setEditorText(buildInitialPlaintext(normalizeFolderPath(path)));
    setEditing({ id: null });
    setEditorError(null);
    setReadingMode(false);
    setView("editor");
  }

  /** New drawing note directly in `path` (folder long-press → "New drawing").
   *  Mirrors `newDrawing` but seeds the drawing note's `folder:` (MYND-515). */
  function newDrawingInFolder(path: string) {
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
  // sites); folder_icons by that folded key only — byte-identical to the keys
  // desktop writes, so a desktop-assigned decoration round-trips across case-
  // variants. bumpPrefsNonce after a successful write so `usePrefs` re-reads
  // disk truth and the row re-renders — the favorites-writer chokepoint.
  function assignItemColor(key: string, slot: string | null) {
    const next = { ...prefs.item_colors };
    if (slot === null) delete next[key];
    else next[key] = slot;
    if (HAS_TAURI) void setItemColors(next).then(bumpPrefsNonce).catch(bumpPrefsNonce);
  }
  function assignFolderIcon(path: string, name: string | null) {
    const next = { ...prefs.folder_icons };
    if (name === null) delete next[path];
    else next[path] = name;
    if (HAS_TAURI) void setFolderIcons(next).then(bumpPrefsNonce).catch(bumpPrefsNonce);
  }
  /** Open the color/icon picker for a folder (color + icon), closing the folder
   *  action sheet first — the `openFolderPrompt` close-then-open idiom. */
  function openFolderDecoration(path: string) {
    setFolderActions(null);
    setDecoTarget({ kind: "folder", path });
  }

  /** Re-root every LIVE note (+ the deliberate/archived folder sets) under
   *  `oldPath` to the matching path under `newPath` — the mobile folder rename/
   *  move primitive. Paths come from the tree (derived from the notes' own
   *  `folder:`), so a case-exact prefix match is reliable. */
  async function reRootFolderSubtree(oldPath: string, newPath: string) {
    if (folderKey(oldPath) === folderKey(newPath)) return;
    for (const [id, folder] of folderOf) {
      if (folder != null && folder.startsWith(oldPath)) {
        const dest = normalizeFolderPath(newPath + folder.slice(oldPath.length));
        await moveNoteToFolder(id, dest);
      }
    }
    const reroot = (arr: readonly string[]) =>
      arr.map((f) => (f.startsWith(oldPath) ? normalizeFolderPath(newPath + f.slice(oldPath.length)) ?? f : f));
    if (HAS_TAURI) {
      await setDeliberateFolders(reroot(prefs.deliberate_folders));
      if (prefs.archived_folders.some((f) => f.startsWith(oldPath))) {
        await setArchivedFolders(reroot(prefs.archived_folders));
      }
      // Decorations follow the folder (MYND-562): re-root item_colors +
      // folder_icons by folded prefix, exactly as desktop does on rename —
      // else the color/icon strands under the old folded key.
      const colors = rewriteFolderPrefix(prefs.item_colors, oldPath, newPath);
      if (colors.changed) await setItemColors(colors.next);
      const icons = rewriteFolderPrefix(prefs.folder_icons, oldPath, newPath);
      if (icons.changed) await setFolderIcons(icons.next);
      bumpPrefsNonce();
    }
    await refresh();
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
        await setDeliberateFolders([...prefs.deliberate_folders, path]).then(bumpPrefsNonce).catch(bumpPrefsNonce);
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
      await setArchivedFolders([...prefs.archived_folders, canonical]).then(bumpPrefsNonce).catch(bumpPrefsNonce);
    }
  }

  /** Move a folder's whole subtree to Trash (folder long-press → Delete folder). */
  async function trashFolderFromMenu(path: string) {
    setFolderActions(null);
    const ids = notesInSubtree(folderOf, path);
    try {
      for (const id of ids) await trashNote(id);
      if (HAS_TAURI) {
        const key = folderKey(path);
        await setDeliberateFolders(prefs.deliberate_folders.filter((f) => !folderKey(f).startsWith(key)));
        bumpPrefsNonce();
      }
    } catch {
      setEditorError(t("editor.flow.trashFailed"));
    }
    await refresh();
  }

  /** Row action in the trash/archive views (restore / unarchive / purge). */
  async function organizeRow(fn: (id: string) => Promise<void>, id: string) {
    try {
      await fn(id);
    } catch {
      /* best-effort */
    }
    await refresh();
  }

  /** Restore an archived folder (MYND-470): drop it (and any nested archived
   *  descendant) from `archived_folders` so its subtree returns to the live tree.
   *  Prefs-only — no note bodies change. */
  async function restoreArchivedFolder(path: string) {
    const next = removeFolderFromArchive(prefs.archived_folders, path);
    if (HAS_TAURI) await setArchivedFolders(next).then(bumpPrefsNonce).catch(bumpPrefsNonce);
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
      if (HAS_TAURI) await setArchivedFolders(next).then(bumpPrefsNonce).catch(bumpPrefsNonce);
    } catch {
      setEditorError(t("editor.flow.trashFailed"));
    }
    setConfirmArchiveFolder(null);
    if (archiveFolder !== null && folderKey(archiveFolder).startsWith(folderKey(path))) {
      setArchiveFolder(null);
    }
    await refresh();
  }

  async function purgeNote(id: string) {
    // Route through deleteNoteRouted so a purge under sync writes a propagating
    // `deleted:` tombstone (not a bare local unlink that resurrects on next pull).
    if (HAS_TAURI) await deleteNoteRouted(id);
    else devStore().delete(id);
  }

  /** Open (or create) today's daily note per the daily-notes prefs. */
  async function openToday() {
    try {
      const candidates = liveNotes.map((n) => ({ id: n.id, title: n.title, folder: folderOf.get(n.id) ?? null }));
      const res = resolveTodayNote(new Date(), prefs.daily_date_format, prefs.daily_folder, candidates);
      if (res.kind === "open") {
        void openFromList(res.id);
        return;
      }
      const id =
        prefs.daily_template != null
          ? await createNoteFromTemplate(prefs.daily_template, res.dateTitle, res.folder, new Date())
          : await createBlankNamedNote(res.dateTitle, res.folder);
      await refresh();
      void openFromList(id);
    } catch (e) {
      // Never let the daily-note path crash the app — surface a message instead.
      console.error("[today] failed:", e);
      if (HAS_TAURI) setListError(t("editor.flow.openTodayFailed"));
    }
  }

  /** Copy the current note's Markdown to the clipboard (WebView clipboard API —
   *  no native plugin). Transient "Copied" feedback via the button label. */
  async function copyNote() {
    try {
      await navigator.clipboard.writeText(editorText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — no-op */
    }
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
      // it (MYND-475). Sanitize the title to a bare basename first — a title with
      // `/`, `\`, or a leading `..` must not let join() escape Documents.
      const safe = title.replace(/[/\\]/g, "_").replace(/^\.+/, "").trim() || "note";
      const path = await join(await documentDir(), `${safe}.pdf`);
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
      const kind = (e as { kind?: string })?.kind;
      setEditorError(
        kind === "Oversize"
          ? t("editor.flow.attachTooLarge")
          : kind === "UnsupportedType"
            ? t("editor.flow.attachUnsupported")
            : t("editor.flow.attachFailed"),
      );
    } finally {
      setAttaching(false);
    }
  }

  // Heading outline of the note body (skips fenced code so `# in code` isn't a
  // heading). Each entry keeps the char offset so tapping jumps the caret there.
  // MUST stay above the `view === "list"` early return — a hook called only in
  // the editor branch renders "more hooks than the previous render" and crashes
  // the whole flow to a blank screen on the first list→editor transition.
  const outline = useMemo(() => deriveOutline(editorText), [editorText]);

  // Unlinked mentions — live notes whose BODY contains this note's title as
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
  const paletteCommands: PaletteCommand[] = [
    { id: "new-note", label: t("notes.list.newNote"), icon: <svg width="16" height="16" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" {...gi} /></svg>, run: () => newNote() },
    { id: "new-drawing", label: t("notes.newTab.createDrawing"), icon: <svg width="16" height="16" viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" {...gi} /></svg>, run: () => newDrawing() },
    { id: "daily", label: t("editor.nav.dailyNote"), icon: <svg width="16" height="16" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2" {...gi} /><path d="M3 10h18M8 3v4M16 3v4" {...gi} /></svg>, run: () => void openToday() },
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
  // the list — the compact editor screen skips it entirely, so typing there
  // never pays for the tree/filter/sort recomputation. `chrome` strips the
  // AppHeader / TabBar on expanded, where the sidebar absorbs both.
  const renderNotesPane = (chrome: { header: boolean; tabBar: boolean }) => {
    const viewActive = listView === "notes" && activeView != null;
    const searchNeedle = searchQuery.trim().toLowerCase();
    // The plain live-notes view renders the whole folder HIERARCHY (an inline
    // expand/collapse tree). A tag/view/trash/archive filter — or an active inline
    // search — renders a flat list instead.
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
    const titleOf = new Map(notes.map((n) => [n.id, n.title]));
    // MYND-596: folders and notes interleave in ONE display-ordered list PER
    // container (shared `orderedChildren`) — a note can now sit above a folder,
    // the same list desktop renders from the same synced `item_order`. The tree
    // is derived once from the fav/archive-filtered map and walked recursively.
    const tree = deriveTree(
      treeFolderOf,
      prefs.deliberate_folders,
      prefs.archived_folders,
    );
    const childName = (c: Child): string =>
      c.kind === "folder" ? c.node.name : (titleOf.get(c.id) ?? "");
    // A→Z / Z→A is an explicit override on top of the manual interleave: it
    // reorders the whole child list (folders AND notes) by display name, since
    // notes are no longer a separately-sorted group. "none" keeps the manual
    // `item_order` interleave (folders/notes unlisted → name / recency).
    const orderChildren = (containerPath: string | null): Child[] => {
      const children = orderedChildren(tree, containerPath, prefs.item_order, orderCache);
      if (sortMode === "none") return children;
      const dir = sortMode === "az" ? 1 : -1;
      return [...children].sort((a, b) => dir * childName(a).localeCompare(childName(b)));
    };
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
            ? [] // flat list bypassed for a view — MobileViewRenderHost renders it
            : activeTag
              ? workingNotes.filter((n) => (tagIndex.byTag.get(activeTag) ?? []).includes(n.id))
              : workingNotes;
    // Inline search — matches the note title or its decrypted body, on-device.
    const searched =
      searchNeedle === ""
        ? filtered
        : filtered.filter(
            (n) =>
              n.title.toLowerCase().includes(searchNeedle) ||
              (bodies.get(n.id) ?? "").toLowerCase().includes(searchNeedle),
          );
    const sorted =
      sortMode === "az"
        ? [...searched].sort((a, b) => a.title.localeCompare(b.title))
        : sortMode === "za"
          ? [...searched].sort((a, b) => b.title.localeCompare(a.title))
          : searched;
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
    // so nested folders stack + release correctly — the flat sticky list left
    // deep headers stuck in the wrong places.
    const renderTree = (current: string | null, depth: number): ReactNode[] => {
      const out: ReactNode[] = [];
      // ONE walk over the interleaved children — a FolderTreeRow for a folder
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
                  // the display path — so they match desktop across case-variants.
                  icon={prefs.folder_icons[f.key]}
                  color={prefs.item_colors[f.key]}
                  onToggle={() => toggleFolder(f.key)}
                  onHold={() => setFolderActions({ path: f.path, name: f.name })}
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
        {/* Fixed header — sits OUTSIDE the animated pane so it stays put while
            the tab content slides between pages. */}
        {chrome.header && tab !== "templates" && (
          <AppHeader
            label={vaultDisplayLabel(prefs.label)}
            icon={prefs.icon}
            onSwitcher={() => setSwitcherOpen(true)}
            onPalette={() => setPaletteOpen(true)}
            onSettings={() => setSettingsOpen(true)}
          />
        )}
        <div ref={tabPaneRef} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {tab === "notes" && (
          <>
            <div style={{ flex: "none", padding: "8px 20px 0" }}>
              {listView !== "notes" && sizeClass !== "expanded" && (
                <button
                  onClick={() => setListView("notes")}
                  style={{ display: "flex", alignItems: "center", gap: 3, border: "none", background: "transparent", color: "var(--accent)", fontSize: 15, fontWeight: 600, cursor: "pointer", padding: 0, marginBottom: 8 }}
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
                      aria-label={t("notes.list.newFolder")}
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
                      onClick={newNote}
                      data-testid="notes.new-note"
                      aria-label={t("notes.list.newNote")}
                      style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 6, height: 36, border: "none", borderRadius: 10, background: "var(--accent)", color: "var(--accent-on)", padding: "0 14px", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
                    >
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" /></svg>
                      {t("notes.list.newNote")}
                    </button>
                  )}
                </div>
              </div>

              {/* Secondary create/browse tiles — New drawing / Template / Daily
                  note / Views. Each is hideable from Settings → Appearance: the
                  original three via MYND-479, New drawing (MYND-515) folded into
                  the same mechanism by MYND-538. */}
              {listView === "notes" && (
                <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
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
                      <button onClick={() => setSearchQuery("")} aria-label={t("editor.list.clearSearch")} style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", display: "flex", flexShrink: 0 }}>
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
                  <button
                    onClick={() => setSortOpen(true)}
                    aria-label={t("editor.sortSheet.title")}
                    style={{ flexShrink: 0, width: 44, display: "flex", alignItems: "center", justifyContent: "center", height: 38, border: "1px solid var(--line-2)", borderRadius: 10, background: sortMode !== "none" ? "var(--accent-soft)" : "var(--bg-2)", color: sortMode !== "none" ? "var(--accent)" : "var(--fg-2)", cursor: "pointer" }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                      <path d="M8 20V4M8 4 5 7M8 4l3 3M16 4v16M16 20l-3-3M16 20l3-3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
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
                    {t("editor.list.edit")}
                  </button>
                  <button onClick={() => setActiveViewId(null)} style={{ border: "none", background: "transparent", color: "var(--fg-3)", fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0 }}>
                    {t("notes.tagBrowser.clear")}
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
              // / list) in place of the flat note list — desktop parity. The host
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
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 40px", textAlign: "center" }}>
                <div style={{ fontSize: 18, fontWeight: 600, color: "var(--fg-1)" }}>
                  {listView === "trash" ? t("editor.list.trashEmpty") : listView === "archive" ? t("editor.list.archiveEmpty") : t("editor.list.noNotesYet")}
                </div>
                {/* A view renders its own `view.empty` via MobileViewRenderHost
                    above, so this generic empty-state is only the flat-list case. */}
                {listView === "notes" ? (
                  <div style={{ marginTop: 8, fontSize: 14, lineHeight: 1.55, color: "var(--fg-3)" }}>
                    {t("editor.list.emptyBody")}
                  </div>
                ) : null}
              </div>
            ) : treeMode ? (
              <ScreenScroll style={{ marginTop: 4 }}>
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
                              {t("notes.archive.folderDeleteConfirmCta")}
                            </button>
                            <button onClick={() => setConfirmArchiveFolder(null)} style={{ border: "none", background: "transparent", color: "var(--accent)", fontSize: 14, fontWeight: 600, cursor: "pointer", padding: "6px 8px" }}>
                              {t("notes.archive.cancel")}
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
                        <div style={{ display: "flex", gap: 4, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
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

        {tab === "graph" && <GraphTab model={graphModel} onOpen={(id) => void openFromList(id)} />}
        {tab === "files" && <AttachmentsSheet variant="page" onClose={() => setTab("notes")} />}
        {/* MYND-620 task 3: the vault-wide Tasks destination. Same shape as the
            Files destination above — one component serving both a full-screen
            destination and an editor sheet. */}
        {tab === "tasks" && (
          <TaskSurface
            scope={{ kind: "vault" }}
            taskScope={taskScope}
            onScopeChange={setTaskScope}
            tagsOf={tagsOfNote}
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
            testIdPrefix="tasks.note-tab"
          />
        )}
        {tab === "templates" && (
          <TemplatesSheet
            variant="page"
            onBack={() => setTab("notes")}
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
                  await refresh();
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
                  await refresh();
                  void openFromList(nid);
                } catch {
                  /* browser-dev / create failed */
                }
              })();
            }}
            onUnmark={(id) =>
              void (async () => {
                try {
                  if (HAS_TAURI) await unmarkTemplate(id);
                  await refresh();
                } catch {
                  /* no-op */
                }
              })()
            }
            onDelete={(id) =>
              void (async () => {
                try {
                  // Templates are synced `.myn` notes — route the delete so it
                  // propagates as a tombstone under sync (not a bare local unlink).
                  if (HAS_TAURI) await deleteNoteRouted(id);
                  await refresh();
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
            onNotes={() => { setTab("notes"); setPanesRevealed(true); }}
            onTasks={() => setTab("tasks")}
            onGraph={() => setTab("graph")}
            onAttachments={() => setTab("files")}
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

        {settingsOpen && (
          <SettingsSheet
            vaultId={vaultId}
            onClose={() => setSettingsOpen(false)}
            onLock={onLock}
            onDeleteVaultSuccess={onDeleteVaultSuccess}
          />
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

        {sortOpen && (
          <SortSheet
            mode={sortMode}
            onPick={setSortMode}
            onClose={() => setSortOpen(false)}
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
              setTagBrowserOpen(false);
              bumpPrefsNonce();
              setActiveViewId(id);
              setActiveTag(null);
              setListView("notes");
            }}
          />
        )}

        {rowActions && (
          <NoteRowActionsSheet
            title={rowActions.title || t("notes.row.untitled")}
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
            reorder={noteReorder(rowActions.id)}
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
            onTrash={() => void trashFolderFromMenu(folderActions.path)}
            reorder={folderReorder(folderActions.path)}
          />
        )}

        {/* Color-label + folder-icon picker (MYND-516). The decoration key is the
            folded folder identity (MYND-562) or the note UUID — resolved ONCE so a
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
                <div style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)", textAlign: "center" }}>
                  {folderPrompt.mode === "rename"
                    ? t("attachments.library.menuRename")
                    : folderPrompt.mode === "subfolder"
                      ? t("notes.list.newSubfolder")
                      : t("notes.list.newFolder")}
                </div>
                <input
                  data-testid="notes.folder-prompt-input"
                  value={folderPromptInput}
                  onChange={(e) => setFolderPromptInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void submitFolderPrompt(); }}
                  placeholder={
                    folderPrompt.mode === "subfolder"
                      ? t("notes.list.newFolderInPlaceholder", { path: folderPrompt.parent.replace(/\/$/, "") })
                      : t("notes.list.newFolderPlaceholder")
                  }
                  autoFocus
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  style={{ marginTop: 14, width: "100%", height: 48, border: "1px solid var(--line-2)", borderRadius: 8, background: "var(--bg-1)", padding: "0 14px", fontFamily: "var(--font-sans)", fontSize: 16, color: "var(--fg-1)", outline: "none", boxSizing: "border-box" }}
                />
                <div style={{ marginTop: 16 }}>
                  <button
                    data-testid="notes.folder-prompt-submit"
                    onClick={() => void submitFolderPrompt()}
                    style={{ width: "100%", height: 50, border: "none", borderRadius: 8, background: "var(--accent)", color: "var(--accent-on)", fontFamily: "var(--font-sans)", fontSize: 16, fontWeight: 600, cursor: "pointer" }}
                  >
                    {folderPrompt.mode === "rename" ? t("attachments.library.menuRename") : t("notes.list.newFolder")}
                  </button>
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
        onBack={sizeClass === "compact" ? () => void saveNote() : undefined}
        onToggleList={isRegular ? () => setPanesRevealed((r) => !r) : undefined}
        onContext={() => setRightPanel(true)}
        onMore={isExisting ? () => setMoreOpen(true) : undefined}
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

      {editorError && (
        <div style={{ padding: "12px 16px 0" }}>
          <Banner kind="danger">{editorError}</Banner>
        </div>
      )}

      {isDrawing ? (
        // Drawing note (SF2) — the shared hardened Excalidraw canvas replaces
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
        // floating one — the flag defaults true.) Typography is applied via the
        // canonical `typographyStyle(prefs)` CSS custom properties
        // (`--editor-text-size` / `--editor-font-family` / `--editor-line-spacing`)
        // that the shared CM theme reads (MYND-483) — direct `fontSize`/etc. on
        // the wrapper are OVERRIDDEN by CM's own `var(--editor-*)` rules, so a
        // change never reached the editor. `maxWidth` stays off (full-width phone).
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            WebkitOverflowScrolling: "touch",
            background: "var(--bg-1)",
            ...typographyStyle(prefs),
            maxWidth: undefined,
          }}
        >
          <CMEditor
            value={editorText}
            onChange={setEditorText}
            onReady={setEditorView}
            // MYND-559: the FormatBar (driven by the `onReady` view above) is
            // mobile's single formatting surface — suppress the engine's floating
            // selection toolbar so a word-select doesn't raise a second one.
            selectionToolbar={false}
            // #213: resolve wikilinks + recognize `![[Drawing]]` embeds. Mobile is
            // an open-full-screen host — the embed shows a thumbnail that opens the
            // drawing on its own screen (drawingIo has openNote, no inline canvas).
            noteSet={resolverNoteSet}
            drawingIo={drawingIo}
            viewMode={rawMode ? "source" : "live"}
            // Regular: the WS-01 prose measure — a 620px column (+ 56px gutters)
            // centered in the detail pane. Compact keeps the phone's 18/22.
            style={
              isRegular
                ? { width: "100%", maxWidth: 732, margin: "0 auto", minHeight: "100%", color: "var(--fg-1)", padding: "34px 56px" }
                : { width: "100%", minHeight: "100%", color: "var(--fg-1)", padding: "18px 22px" }
            }
          />
        </div>
      )}

      {isDrawing ? null : readingMode ? (
        // Reading mode hides the FormatBar (nothing to format) — but it must not
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
          onLibrary={() => setManageAttachments(true)}
          onRecord={() => setRecordOpen(true)}
          // MYND-555: the user's device-local bar layout. Both default to `[]`
          // (canonical order, nothing hidden), and they ride the `usePrefs` nonce,
          // so a change in Settings reorders the live bar without a remount.
          order={prefs.editor_toolbar_order}
          hidden={prefs.editor_toolbar_hidden}
        />
      )}

      {/* Off-screen print surface — `window.print()` (the PDF button) isolates
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
            // follow-up — for now the outline jump just opens the editor.
            setRightPanel(false);
            setReadingMode(false);
          }}
          onClose={() => setRightPanel(false)}
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

      {manageAttachments && (
        <AttachmentsSheet
          onClose={() => setManageAttachments(false)}
          onInsert={(id, filename) => {
            insertIntoEditor(emitAttachmentEmbed(id, filename));
            setManageAttachments(false);
          }}
          onInsertText={(text) => {
            // A finished audio transcript inserts its TEXT into the open note
            // (MYND-563) — distinct from onInsert, which embeds an attachment ref.
            insertIntoEditor(text);
            setManageAttachments(false);
          }}
        />
      )}

      {noteTasksOpen && editing?.id && (
        <Sheet onClose={() => setNoteTasksOpen(false)} padded={false}>
          {() => (
            <TaskSurface
              scope={{ kind: "note", noteId: editing.id as string }}
              onOpen={() => setNoteTasksOpen(false)}
              testIdPrefix="tasks.note"
            />
          )}
        </Sheet>
      )}

      {historyOpen && editing?.id && (
        <SnapshotsSheet
          noteId={editing.id}
          onClose={() => setHistoryOpen(false)}
          onRestored={() => {
            // The live note was overwritten on disk — re-read it into the editor.
            if (HAS_TAURI && editing?.id) void noteRead(editing.id).then(setEditorText).catch(() => {});
          }}
        />
      )}
      </>
    );
  };

  // ── Shared overlays — the purge + move confirm sheets. Staged from BOTH the
  // list (trash-row Delete / long-press Move) and the editor ⋯ menu; they
  // previously rendered only in the editor view, which left the list-staged
  // flows without their confirm sheet — rendering them in every layout fixes
  // that. ─────────────────────────────────────────────────────────────────────
  const renderSharedOverlays = () => (
    <>
      {/* SF5 share-import confirmation toast (§9.20, SYNC-18) — self-contained,
          listens for the drain result; renders in every layout branch. */}
      {/* MYND-640: tapping the toast opens the library the share landed in.
          Without it the only signal a share arrived was a sentence that
          disappeared after a few seconds, pointing at a place the user had no
          reason to open. */}
      <ShareImportToast onOpenLibrary={() => setTab("files")} />
      {purgeId != null && (
        <Sheet onClose={() => setPurgeId(null)}>
          {(close) => (
            <>
          <div style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)", textAlign: "center" }}>{t("notes.trash.purgeConfirmTitle")}</div>
          <div style={{ marginTop: 8, fontSize: 14, lineHeight: 1.5, color: "var(--fg-3)", textAlign: "center" }}>
            {t("editor.purge.body")}
          </div>
          <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 10 }}>
            <button
              onClick={() => void confirmPurge()}
              style={{
                width: "100%",
                height: 50,
                border: "none",
                borderRadius: 8,
                background: "var(--danger)",
                color: "#fff",
                fontFamily: "var(--font-sans)",
                fontSize: 16,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t("notes.trash.purgeConfirmCta")}
            </button>
            <button
              onClick={close}
              style={{
                width: "100%",
                height: 50,
                border: "1px solid var(--line-2)",
                borderRadius: 8,
                background: "transparent",
                color: "var(--fg-1)",
                fontFamily: "var(--font-sans)",
                fontSize: 16,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              {t("common.prompt.cancel")}
            </button>
          </div>
            </>
          )}
        </Sheet>
      )}

      {moveTarget != null && (
        <Sheet onClose={() => setMoveTarget(null)}>
          {(close) => (
            <>
              <div style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)", textAlign: "center" }}>{t("editor.move.title")}</div>
              <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)", textAlign: "center" }}>
                {t("editor.move.body")}
              </div>
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
              <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
                <button
                  onClick={() => void confirmMove()}
                  style={{ width: "100%", height: 50, border: "none", borderRadius: 8, background: "var(--accent)", color: "var(--accent-on)", fontFamily: "var(--font-sans)", fontSize: 16, fontWeight: 600, cursor: "pointer" }}
                >
                  {t("editor.move.confirm")}
                </button>
                <button
                  onClick={close}
                  style={{ width: "100%", height: 50, border: "1px solid var(--line-2)", borderRadius: 8, background: "transparent", color: "var(--fg-1)", fontFamily: "var(--font-sans)", fontSize: 16, fontWeight: 500, cursor: "pointer" }}
                >
                  {t("common.prompt.cancel")}
                </button>
              </div>
            </>
          )}
        </Sheet>
      )}
    </>
  );

  // ── Layout switch ────────────────────────────────────────────────────────────
  // compact: the existing full-screen list ⇄ editor swap (unchanged phone
  // behavior, push/pop animation included). medium: list + detail side by side,
  // the phone's AppHeader + TabBar scoped to the list column. expanded: the
  // WS-01 three-pane — sidebar + list + detail; the sidebar absorbs the
  // AppHeader/TabBar destinations, so neither renders. Graph / Files /
  // Templates span the full content width on regular (a graph squeezed into a
  // 316px column is useless).
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

  return (
    <Screen>
      <div data-testid="workspace.split" style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {sizeClass === "expanded" && (
          <div
            // display:flex so the SidebarPane STRETCHES to full height (its
            // flex:1 nav pushes the settings footer to the bottom, where its
            // divider lines up with the editor FormatBar). Without it the block
            // wrapper let the sidebar shrink to ~60% content height.
            style={{ width: panesCollapsed ? 0 : 248, flex: "none", minHeight: 0, display: "flex", overflow: "hidden", transition: "width 220ms cubic-bezier(0.4, 0, 0.2, 1)" }}
          >
          <SidebarPane
            label={vaultDisplayLabel(prefs.label)}
            icon={prefs.icon}
            tab={tab}
            listView={listView}
            onAllNotes={() => { setTab("notes"); setListView("notes"); setActiveTag(null); setActiveViewId(null); }}
            onTasks={() => setTab("tasks")}
            {...(editing?.id === undefined ? {} : { onNoteTasks: () => setTab("note-tasks") })}
            onGraph={() => setTab("graph")}
            onFiles={() => setTab("files")}
            onTemplates={() => setTab("templates")}
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
                transition: "width 220ms cubic-bezier(0.4, 0, 0.2, 1)",
              }}
            >
              {renderNotesPane({ header: sizeClass === "medium", tabBar: sizeClass === "medium" })}
            </div>
            <div data-testid="workspace.detail-pane" style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}>
              {editing ? renderEditorPane() : <EmptyDetail onNew={newNote} />}
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
          onNotes={() => { setTab("notes"); setPanesRevealed(true); }}
          onTasks={() => setTab("tasks")}
          onGraph={() => setTab("graph")}
          onAttachments={() => setTab("files")}
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
// than a second regex scan — it is fence-aware AND drops frontmatter pseudo-
// headings, which the old hand-scan surfaced. `from` is the heading line's byte
// offset, our OutlineItem `index`.
function deriveOutline(text: string): OutlineItem[] {
  return headingSections(text).map((h) => ({ level: h.level, text: h.text, index: h.from }));
}
