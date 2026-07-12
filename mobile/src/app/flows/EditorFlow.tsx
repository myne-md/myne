import { type CSSProperties, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CMEditor } from "@myne/editor/CMEditor";
import { editorCommands } from "@myne/editor/toolbar/commands";
import { REVEAL_ATTACHMENT_EVENT } from "@myne/editor/attachments/fileCardActions";
import { headingSections } from "@myne/dialect";
import { undo, redo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { Screen, ScreenScroll, Icon, MyneMark, Banner, Spinner, Sheet, SidePanel, LIST_TOP, SyncStatusGlyph, SyncBanners, SyncStatusDetail, ConflictsSheet } from "../../components";
import { listen } from "@tauri-apps/api/event";
import { noteList, noteRead, noteCreate, noteUpdate, deleteNoteRouted } from "../../lib/notes";
import type { NoteListError } from "../../lib/notes";
import { useConflictMaterializer } from "../../lib/use-conflict-materializer";
import { listVaults, orderByLastUnlock } from "../../lib/vault-list";
import { HAS_TAURI } from "../../lib/app-window";
import { effectiveMobileAutoLockSecs } from "../../lib/auto-lock";
import { consumePendingCapture, CAPTURE_EVENT } from "../../lib/deep-link";
import { ioBanner } from "../../lib/io-banner";
import { usePrefs } from "../../lib/use-prefs";
import { setFavorites, upsertSavedView, setViewOrder } from "../../lib/prefs";
import { bumpPrefsNonce } from "../../lib/prefsNonce";
import type { NoteGraph } from "../../lib/wikilinks";
import { searchNotes } from "../../lib/search-notes";
import { buildTagIndex } from "../../lib/tags";
import { publishEditorTagTree } from "../../lib/editor-tag-bridge";
import { maybeSeedTestData } from "../../lib/seed";
import { countWords } from "../../lib/word-count";
import {
  readNoteFlags,
  isLiveNote,
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
import { folderChildren, notesDirectlyIn, notesInSubtree } from "../../lib/folders";
import { resolveTodayNote, createNoteFromTemplate, createBlankNamedNote } from "../../lib/daily";
import { normalizeFolderPath, ancestorPaths, foldSegment } from "../../dialect/folderPath";
import { buildInitialPlaintext, readUpdatedFromFmBody } from "../../dialect/surgery";
import { formatRelativeTime } from "../../lib/relative-time";
import { evaluateFilter } from "../../lib/query-engine";
import type { SavedView } from "../../lib/prefs";
import { ViewEditorSheet } from "./ViewEditorSheet";
import { importFile, ATTACHMENT_ACCEPT } from "../../lib/attachments";
import { emitAttachmentEmbed } from "../../lib/attachmentRef";
import { AttachmentsSheet } from "./AttachmentsSheet";
import { SnapshotsSheet } from "./SnapshotsSheet";
import { TemplatesSheet } from "./TemplatesSheet";
import { unmarkTemplate, createTemplate } from "../../lib/templates";
import { deriveTitleSnippet } from "../../lib/note-title";
import { searchIndexReplace, noteSearch } from "../../lib/search";
import { vaultIndicesApply, vaultIndicesAllEdges, type WikilinkEdge } from "../../lib/vault-indices";
import { extractRecord } from "../../lib/indices-extract";
import { buildGraphFromEdges, clientEdges } from "../../lib/backend-graph";
import { WikiGraph } from "../../components/WikiGraph";
import { MarkdownView } from "../../components/MarkdownView";
import type { VaultSummary } from "../../types/vault-summary";
import type { EditorFlowProps } from "./types";
import { SettingsSheet, applyStoredTheme } from "./SettingsSheet";

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

interface NoteEntry {
  id: string;
  title: string;
  snippet: string;
}

type Editing = { id: string | null };

/** A flattened row of the inline folder hierarchy — folders and their notes
 *  interleaved with a `depth` for indentation. Collapsed folders omit their
 *  subtree. This replaces the old drill-down/breadcrumb navigation. */
type TreeRow =
  | { kind: "folder"; path: string; name: string; depth: number; count: number; collapsed: boolean }
  | { kind: "note"; id: string; depth: number };

/** Walk the virtual folder tree from `current` (null = root) into a flat row
 *  list: child folders (each optionally expanding its subtree) then the notes
 *  sitting directly at this level. `sortNotes` orders the note ids per level. */
function buildFolderTree(
  folderOf: Map<string, string | null>,
  collapsed: Set<string>,
  sortNotes: (ids: string[]) => string[],
  current: string | null = null,
  depth = 0,
): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const f of folderChildren(folderOf, current)) {
    const isCollapsed = collapsed.has(f.path);
    rows.push({ kind: "folder", path: f.path, name: f.name, depth, count: f.count, collapsed: isCollapsed });
    if (!isCollapsed) rows.push(...buildFolderTree(folderOf, collapsed, sortNotes, f.path, depth + 1));
  }
  for (const id of sortNotes(notesDirectlyIn(folderOf, current))) {
    rows.push({ kind: "note", id, depth });
  }
  return rows;
}

/** Status-bar clearance for a top action bar: the real OS safe-area inset on
 *  device (viewport-fit=cover), or a floor tall enough to clear the iPhone
 *  Dynamic Island where env() under-reports. Kept identical to `LIST_TOP` so the
 *  editor header, list header, and side-panel headers all line up. */
const EDITOR_TOP = LIST_TOP;

/** Left-to-right tab position — drives the slide direction of the page
 *  transition: moving to a higher-indexed tab enters from the right, a
 *  lower-indexed tab from the left (an iOS push/pop feel across the tab row). */
const TAB_ORDER: Record<"notes" | "search" | "graph" | "files" | "templates", number> = {
  notes: 0,
  search: 1,
  graph: 2,
  files: 3,
  templates: 4,
};

/** Editor typography presets (mirror the desktop `editor-typography` prefs), so
 *  the Appearance settings tangibly change the note editor. */
const EDITOR_TEXT_PX: Record<string, number> = { sm: 14, md: 16, lg: 18, xl: 20 };
const EDITOR_LINE_HEIGHT: Record<string, number> = { tight: 1.5, normal: 1.75, relaxed: 2 };

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


export function EditorFlow({ vaultId, onLock, onCreateVault, onSwitchVault, onDeleteVaultSuccess }: EditorFlowProps) {
  const [view, setView] = useState<"list" | "editor">("list");
  const [tab, setTab] = useState<"notes" | "search" | "graph" | "files" | "templates">("notes");

  // Slide the incoming tab page in from the side its tab sits on (Notes ← … →
  // Templates). Same Web-Animations technique as the Settings drawer; the first
  // paint and editor round-trips (tab unchanged) don't animate.
  const tabPaneRef = useRef<HTMLDivElement>(null);
  const prevTabRef = useRef(tab);
  useLayoutEffect(() => {
    const prev = prevTabRef.current;
    prevTabRef.current = tab;
    if (tab === prev) return;
    const el = tabPaneRef.current;
    if (!el || typeof el.animate !== "function") return;
    const forward = TAB_ORDER[tab] >= TAB_ORDER[prev];
    el.animate(
      [
        { opacity: 0, transform: `translateX(${forward ? "20px" : "-20px"})` },
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
    const el = screenRef.current;
    if (!el || typeof el.animate !== "function") return;
    const push = view === "editor"; // list → editor is "deeper"
    el.animate(
      [
        { opacity: 0, transform: `translateX(${push ? "34px" : "-34px"})` },
        { opacity: 1, transform: "translateX(0)" },
      ],
      // `backwards` fill = no flash of the fully-opaque incoming screen before
      // the slide starts (the "flash when coming back to the list" bug).
      { duration: 340, easing: "cubic-bezier(0.22, 0.61, 0.36, 1)", fill: "backwards" },
    );
  }, [view]);

  const { prefs } = usePrefs();
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
  // Attachment insert: the editor textarea + hidden file input, and a busy flag
  // while the picked file is encrypted (MYA1) on the host.
  const attachInputRef = useRef<HTMLInputElement>(null);
  const [attaching, setAttaching] = useState(false);
  // The live CMEditor view, handed over via <CMEditor onReady>. Drives the
  // above-keyboard FormatBar through the shared @myne/editor commands.
  const [editorView, setEditorView] = useState<EditorView | null>(null);
  const [manageAttachments, setManageAttachments] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Editor side panels (mobile stand-in for the desktop side sheets): left =
  // note explorer (jump to another note), right = note context + actions.
  const [leftPanel, setLeftPanel] = useState(false);
  const [rightPanel, setRightPanel] = useState(false);
  // Note actions overflow (⋯): Copy / Move / History / Export / Archive / Trash.
  const [moreOpen, setMoreOpen] = useState(false);
  // Backend vault-indices edge dump (null until the first sweep; drives the
  // Turkish-correct graph + backlinks). Falls back to the client graph in dev.
  const [backendEdges, setBackendEdges] = useState<[string, WikilinkEdge[]][] | null>(null);
  // Permanent-delete confirm target: a note id being purged from Trash, or null.
  const [purgeId, setPurgeId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  // SY-08 sync status detail sheet (MYND-461 T6), opened from the header glyph.
  const [syncDetailOpen, setSyncDetailOpen] = useState(false);
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
  // Current folder for NEW-note placement (root by default; the tree no longer
  // drills, so this stays null unless a future "new note in folder" sets it).
  const [currentFolder, setCurrentFolder] = useState<string | null>(null);
  // Collapsed folder paths in the inline hierarchy (empty = all expanded, so the
  // whole tree is visible by default). The list is a tree, not a drill-down.
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
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
  // Active saved view (its id) filtering the notes list, or null. Mutually
  // exclusive with the folder drill-down + tag filter.
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  // The view-editor sheet: `{ initial }` open (null initial = create), or null.
  const [viewEditor, setViewEditor] = useState<{ initial: SavedView | null } | null>(null);


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
  const trashedNotes = useMemo(() => notes.filter((n) => noteFlags.get(n.id)?.trashed != null), [notes, noteFlags]);
  const archivedNotes = useMemo(
    () => notes.filter((n) => noteFlags.get(n.id)?.archived != null && noteFlags.get(n.id)?.trashed == null),
    [notes, noteFlags],
  );
  // Template notes (`template: true`) — excluded from the live list; managed via
  // the Templates sheet + instantiated by the daily-note engine.
  const templateNotes = useMemo(
    () =>
      notes
        .filter((n) => noteFlags.get(n.id)?.template === true)
        .map((n) => ({ id: n.id, title: deriveTitleSnippet(bodies.get(n.id) ?? "").title })),
    [notes, noteFlags, bodies],
  );

  // Folder path per live note (from `folder:` frontmatter) — the drill-down tree.
  const folderOf = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const n of liveNotes) m.set(n.id, readNoteFolder(bodies.get(n.id) ?? ""));
    return m;
  }, [liveNotes, bodies]);

  // The wikilink graph over the LIVE notes — feeds both the Graph tab and the
  // in-editor "Linked from" backlinks.
  const noteGraph = useMemo(
    () => buildGraphFromEdges(liveNotes, backendEdges ?? clientEdges(liveNotes, bodies)),
    [backendEdges, liveNotes, bodies],
  );
  // The `#tag` index over the LIVE notes — drives the notes-list tag filter.
  const tagIndex = useMemo(() => buildTagIndex(liveNotes, bodies), [liveNotes, bodies]);

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
  // Live note ids matching the active view's filter (query engine over the same
  // resolvers the tag/folder chips use). Null when no view is active.
  const viewMatchIds = useMemo(() => {
    if (!activeView) return null;
    return evaluateFilter(activeView.filters, {
      liveIds: new Set(liveNotes.map((n) => n.id)),
      tagMembers: (tag) => tagIndex.byTag.get(tag) ?? [],
      folderMembers: (path) => notesInSubtree(folderOf, path),
      searchMembers: (query) => searchNotes(query, liveNotes, bodies).map((h) => h.id),
    });
  }, [activeView, liveNotes, tagIndex, folderOf, bodies]);

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
            liveNotes.map((n) =>
              vaultIndicesApply(extractRecord(n.id, n.title, folderOf.get(n.id) ?? null, bodies.get(n.id) ?? "")),
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
  }, [liveNotes, bodies, folderOf]);

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
          : "Couldn't load your notes.",
      );
    } finally {
      setLoading(false);
    }
  }, [loadEntries]);

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

  // Auto-lock: re-lock the vault after `auto_lock_seconds` of inactivity (any
  // touch / key / pointer resets the countdown). Idle re-lock is what makes the
  // quick-unlock PIN fast-path actually appear on the next unlock.
  useEffect(() => {
    if (!HAS_TAURI) return;
    // A6 envelope: the effective timeout is always in [30, 3600] — a sentinel/
    // replayed "off" (0) can no longer disable the idle lock (matches desktop's
    // always-on `effective_auto_lock_secs`). No disable path.
    const secs = effectiveMobileAutoLockSecs(prefs.auto_lock_seconds);
    let timer = 0;
    const reset = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => onLock(), secs * 1000);
    };
    const events: (keyof WindowEventMap)[] = ["touchstart", "keydown", "pointerdown", "mousedown"];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      window.clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
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
        setVaults([
          { id: vaultId ?? "dev-personal", status: { kind: "Exists" }, label: "Personal", last_unlock: Date.now() },
          { id: "dev-work", status: { kind: "Exists" }, label: "Work", last_unlock: Date.now() - 86_400_000 },
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

  // Widget deep-link capture (ios-widgets `myne://capture`): open a fresh note.
  // Cold launch on a locked device latches the intent in `deep-link.ts` and it
  // is consumed HERE once the editor mounts post-unlock; a tap while the app is
  // already open fires CAPTURE_EVENT below. Voice mode has no transcription
  // engine yet, so it opens the ordinary text editor — same as plain capture.
  useEffect(() => {
    if (consumePendingCapture() !== null) newNote();
  }, [newNote]);
  useEffect(() => {
    const onCapture = () => newNote();
    window.addEventListener(CAPTURE_EVENT, onCapture);
    return () => window.removeEventListener(CAPTURE_EVENT, onCapture);
  }, [newNote]);

  const openNote = useCallback(
    async (id: string) => {
      setEditorError(null);
      let text = "";
      try {
        text = HAS_TAURI ? await noteRead(id) : devStore().get(id) ?? "";
      } catch {
        setEditorError("Couldn't open this note.");
      }
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
    setEditorBusy(true);
    setEditorError(null);
    try {
      const stamped = stampUpdated(editorText);
      if (editing.id === null) {
        if (HAS_TAURI) await noteCreate(stamped);
        else devStore().set(crypto.randomUUID(), stamped);
      } else if (HAS_TAURI) {
        await noteUpdate(editing.id, stamped);
      } else {
        devStore().set(editing.id, stamped);
      }
      await refresh();
      exitEditor();
    } catch {
      setEditorError("Couldn't save this note.");
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
    if (editing?.id != null) {
      try {
        const stamped = stampUpdated(editorText);
        if (HAS_TAURI) await noteUpdate(editing.id, stamped);
        else devStore().set(editing.id, stamped);
        await refresh();
      } catch {
        // Best-effort save; still navigate so the backlink isn't a dead tap.
      }
    }
    await openNote(id);
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
      if (editing?.id === id) {
        if (HAS_TAURI) await noteUpdate(id, editorText);
        else devStore().set(id, editorText);
      }
      await moveNoteToFolder(id, dest);
      await refresh();
      setMoveTarget(null);
      setCurrentFolder(dest);
      if (editing?.id === id) exitEditor();
    } catch {
      setMoveTarget(null);
      setEditorError("Couldn't move this note.");
    }
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
        void openNote(res.id);
        return;
      }
      const id =
        prefs.daily_template != null
          ? await createNoteFromTemplate(prefs.daily_template, res.dateTitle, res.folder, new Date())
          : await createBlankNamedNote(res.dateTitle, res.folder);
      await refresh();
      void openNote(id);
    } catch (e) {
      // Never let the daily-note path crash the app — surface a message instead.
      console.error("[today] failed:", e);
      if (HAS_TAURI) setListError("Couldn't open today's note.");
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

  /** Import a picked file into the vault (MYA1) and insert its form-C embed. */
  async function attachFile(file: File) {
    if (!HAS_TAURI) {
      setEditorError("Attachments need the app (not the browser preview).");
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
          ? "That file is too large (max 64 MB)."
          : kind === "UnsupportedType"
            ? "Only images and PDFs can be attached."
            : "Couldn't attach that file.",
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

  // ── List view ───────────────────────────────────────────────────────────────
  if (view === "list") {
    const viewActive = listView === "notes" && viewMatchIds != null;
    const searchNeedle = searchQuery.trim().toLowerCase();
    // The plain live-notes view renders the whole folder HIERARCHY (an inline
    // expand/collapse tree). A tag/view/trash/archive filter — or an active inline
    // search — renders a flat list instead.
    const treeMode = listView === "notes" && !activeTag && !viewActive && searchNeedle === "";
    const titleOf = new Map(notes.map((n) => [n.id, n.title]));
    // Order note ids within one tree level: favourites first, then by sort mode.
    const sortIds = (ids: string[]): string[] => {
      const byTitle = (a: string, b: string) =>
        (titleOf.get(a) ?? "").localeCompare(titleOf.get(b) ?? "");
      const base = sortMode === "az" ? [...ids].sort(byTitle) : sortMode === "za" ? [...ids].sort((a, b) => byTitle(b, a)) : ids;
      return [...base.filter((id) => favSet.has(id)), ...base.filter((id) => !favSet.has(id))];
    };
    const treeRows = treeMode ? buildFolderTree(folderOf, collapsedFolders, sortIds) : [];

    const filtered =
      listView === "trash"
        ? trashedNotes
        : listView === "archive"
          ? archivedNotes
          : viewActive
            ? liveNotes.filter((n) => viewMatchIds!.has(n.id))
            : activeTag
              ? liveNotes.filter((n) => (tagIndex.byTag.get(activeTag) ?? []).includes(n.id))
              : liveNotes;
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
    const toggleFolder = (path: string) =>
      setCollapsedFolders((prev) => {
        const next = new Set(prev);
        next.has(path) ? next.delete(path) : next.add(path);
        return next;
      });
    // Row subtitle = last-edited relative time (desktop-parity), or "" when the
    // timestamp pref is off / no `updated:` stamp exists.
    const showTs = prefs.show_note_timestamps !== false;
    const subtitleFor = (id: string): string => {
      const d = updatedById.get(id);
      return showTs && d ? formatRelativeTime(d) : "";
    };

    // A vertical tree rail at a given ancestor level.
    const railAt = (i: number) => (
      <div key={`r${i}`} style={{ position: "absolute", left: 20 + i * 18 + 6, top: 0, bottom: 0, width: 1, background: "var(--line-2)" }} />
    );
    // Recursive folder-tree render with per-subtree STICKY headers. Each folder
    // header pins while ITS OWN subtree scrolls under it and un-pins once the
    // subtree is scrolled past (a sticky element is constrained to its wrapper),
    // so nested folders stack + release correctly — the flat sticky list left
    // deep headers stuck in the wrong places.
    const renderTree = (current: string | null, depth: number): ReactNode[] => {
      const out: ReactNode[] = [];
      for (const f of folderChildren(folderOf, current)) {
        const isCollapsed = collapsedFolders.has(f.path);
        out.push(
          <div key={`f:${f.path}`}>
            <div style={{ position: "sticky", top: depth * 44, zIndex: 30 - depth, background: "var(--bg-1)" }}>
              {Array.from({ length: depth }, (_, i) => railAt(i))}
              <div
                onClick={() => toggleFolder(f.path)}
                style={{ position: "relative", display: "flex", alignItems: "center", gap: 8, padding: "11px 20px", paddingLeft: 20 + depth * 18, cursor: "pointer" }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" style={{ flexShrink: 0, transform: isCollapsed ? "rotate(0deg)" : "rotate(90deg)", transition: "transform 140ms ease" }}>
                  <path d="M8 5l8 7-8 7" fill="none" stroke="var(--fg-3)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <svg width="18" height="18" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" fill="none" stroke="var(--fg-2)" strokeWidth="1.6" strokeLinejoin="round" />
                </svg>
                <div style={{ flex: 1, minWidth: 0, fontSize: 16, fontWeight: 600, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</div>
                <span style={{ width: 30, textAlign: "center", fontSize: 13, color: "var(--fg-3)", flexShrink: 0 }}>{f.count}</span>
              </div>
            </div>
            {!isCollapsed && (
              <div style={{ position: "relative" }}>
                {railAt(depth)}
                {renderTree(f.path, depth + 1)}
              </div>
            )}
          </div>,
        );
      }
      for (const nid of sortIds(notesDirectlyIn(folderOf, current))) {
        const n = notes.find((x) => x.id === nid);
        if (!n) continue;
        out.push(
          <NoteRow
            key={n.id}
            entry={n}
            last={false}
            divider={false}
            indent={depth * 18 + 12}
            subtitle={subtitleFor(n.id)}
            onOpen={() => void openNote(n.id)}
            favorited={favSet.has(n.id)}
            onToggleFavorite={() => toggleFavorite(n.id)}
          />,
        );
      }
      return out;
    };
    const filterActive = activeTag != null || activeView != null;
    // Command-palette registry (mobile subset of the desktop action list).
    const gi = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
    const paletteCommands: PaletteCommand[] = [
      { id: "new-note", label: "New note", icon: <svg width="16" height="16" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" {...gi} /></svg>, run: () => newNote() },
      { id: "daily", label: "Daily note", icon: <svg width="16" height="16" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2" {...gi} /><path d="M3 10h18M8 3v4M16 3v4" {...gi} /></svg>, run: () => void openToday() },
      { id: "templates", label: "Templates", icon: <svg width="16" height="16" viewBox="0 0 24 24"><rect x="8" y="4" width="11" height="14" rx="2" {...gi} /><path d="M5 8v10a2 2 0 002 2h8" {...gi} /></svg>, run: () => setTab("templates") },
      { id: "files", label: "Attachments", icon: <svg width="16" height="16" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" {...gi} /><path d="M21 15l-5-5L5 21" {...gi} /></svg>, run: () => setTab("files") },
      { id: "graph", label: "Graph", icon: <svg width="16" height="16" viewBox="0 0 24 24"><circle cx="6" cy="17" r="2.4" {...gi} /><circle cx="18" cy="14" r="2.4" {...gi} /><circle cx="13" cy="6" r="2.4" {...gi} /><path d="M8.3 15.6l3-7M8.4 16.2l7-1.6" {...gi} /></svg>, run: () => setTab("graph") },
      { id: "tags", label: "Browse tags", icon: <svg width="16" height="16" viewBox="0 0 24 24"><path d="M4 4h7l9 9-7 7-9-9z" {...gi} /><circle cx="8" cy="8" r="1.1" fill="currentColor" /></svg>, run: () => setTagBrowserOpen(true) },
      { id: "archive", label: "Archive", icon: <svg width="16" height="16" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="5" rx="1" {...gi} /><path d="M5 9v10a1 1 0 001 1h12a1 1 0 001-1V9M9 13h6" {...gi} /></svg>, run: () => { setListView("archive"); setActiveTag(null); setActiveViewId(null); } },
      { id: "trash", label: "Trash", icon: <svg width="16" height="16" viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13" {...gi} /></svg>, run: () => { setListView("trash"); setActiveTag(null); setActiveViewId(null); } },
      { id: "settings", label: "Settings", icon: <svg width="16" height="16" viewBox="0 0 24 24"><path d="M4 7h11M19 7h1M4 17h1M9 17h11" {...gi} /><circle cx="17" cy="7" r="2.4" {...gi} /><circle cx="7" cy="17" r="2.4" {...gi} /></svg>, run: () => setSettingsOpen(true) },
      { id: "lock", label: "Lock vault", icon: <svg width="16" height="16" viewBox="0 0 24 24"><rect x="5" y="10.5" width="14" height="9.5" rx="2" {...gi} /><path d="M8 10.5V8a4 4 0 018 0v2.5" {...gi} /></svg>, run: () => onLock() },
    ];
    const viewTitle = listView === "trash" ? "Trash" : listView === "archive" ? "Archive" : "Notes";
    return (
      <Screen ref={screenRef}>
        {/* Fixed header — sits OUTSIDE the animated pane so it stays put while
            the tab content slides between pages. */}
        {tab !== "templates" && (
          <AppHeader
            label={prefs.label ?? "Personal"}
            onSwitcher={() => setSwitcherOpen(true)}
            onPalette={() => setPaletteOpen(true)}
            onSettings={() => setSettingsOpen(true)}
          />
        )}
        <div ref={tabPaneRef} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {tab === "notes" && (
          <>
            <div style={{ flex: "none", padding: "8px 20px 0" }}>
              {listView !== "notes" && (
                <button
                  onClick={() => setListView("notes")}
                  style={{ display: "flex", alignItems: "center", gap: 3, border: "none", background: "transparent", color: "var(--accent)", fontSize: 15, fontWeight: 600, cursor: "pointer", padding: 0, marginBottom: 8 }}
                >
                  <Icon name="chevron-left" size={18} color="var(--accent)" strokeWidth={2} /> Notes
                </button>
              )}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <h1 style={{ margin: 0, fontSize: 32, fontWeight: 700, letterSpacing: "-0.025em", color: "var(--fg-display)" }}>
                  {viewTitle}
                </h1>
                <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
                  {/* Glanceable sync-status glyph (SY-01, MYND-461); tap → SY-08
                      status detail sheet (task 6). */}
                  <SyncStatusGlyph onOpenDetail={() => setSyncDetailOpen(true)} />
                  {listView === "notes" && (
                    <button
                      onClick={newNote}
                      aria-label="New note"
                      style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 6, height: 36, border: "none", borderRadius: 10, background: "var(--accent)", color: "var(--accent-on)", padding: "0 14px", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
                    >
                      <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" /></svg>
                      New note
                    </button>
                  )}
                </div>
              </div>

              {/* Secondary create/browse tiles — Template / Daily note / Views. */}
              {listView === "notes" && (
                <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
                  <ActionPill onClick={() => setTab("templates")} label="Templates">
                    <rect x="8" y="4" width="11" height="14" rx="2" stroke="currentColor" strokeWidth="1.7" fill="none" />
                    <path d="M5 8v10a2 2 0 002 2h8" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </ActionPill>
                  <ActionPill onClick={() => void openToday()} label="Open today">
                    <rect x="3" y="5" width="18" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.7" />
                    <path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                  </ActionPill>
                  <ActionPill onClick={() => setViewsOpen(true)} label="Views">
                    <path d="M12 2 2 7l10 5 10-5-10-5z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
                    <path d="M2 12l10 5 10-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="M2 17l10 5 10-5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                  </ActionPill>
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
                      placeholder="Search notes"
                      style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", color: "var(--fg-1)", fontSize: 14 }}
                    />
                    {searchQuery !== "" && (
                      <button onClick={() => setSearchQuery("")} aria-label="Clear search" style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", display: "flex", flexShrink: 0 }}>
                        <svg width="15" height="15" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="var(--fg-3)" strokeWidth="1.8" strokeLinecap="round" /></svg>
                      </button>
                    )}
                  </div>
                  <button
                    onClick={() => setFilterOpen(true)}
                    aria-label="Filter"
                    style={{ flexShrink: 0, width: 44, display: "flex", alignItems: "center", justifyContent: "center", height: 38, border: "1px solid var(--line-2)", borderRadius: 10, background: filterActive ? "var(--accent-soft)" : "var(--bg-2)", color: filterActive ? "var(--accent)" : "var(--fg-2)", cursor: "pointer" }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                      <path d="M3 5h18l-7 8v6l-4-2v-6z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <button
                    onClick={() => setSortOpen(true)}
                    aria-label="Sort"
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
            </div>

            {activeView && (
              <div style={{ flex: "none", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 20px 0" }}>
                <span style={{ fontSize: 13, color: "var(--fg-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {filtered.length} {filtered.length === 1 ? "note" : "notes"} in “{activeView.name}”
                </span>
                <div style={{ display: "flex", gap: 14, flexShrink: 0 }}>
                  <button onClick={() => setViewEditor({ initial: activeView })} style={{ border: "none", background: "transparent", color: "var(--accent)", fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0 }}>
                    Edit
                  </button>
                  <button onClick={() => setActiveViewId(null)} style={{ border: "none", background: "transparent", color: "var(--fg-3)", fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0 }}>
                    Clear
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
            ) : (treeMode ? treeRows.length === 0 : orderedNotes.length === 0) && !listError ? (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 40px", textAlign: "center" }}>
                <div style={{ fontSize: 18, fontWeight: 600, color: "var(--fg-1)" }}>
                  {listView === "trash" ? "Trash is empty" : listView === "archive" ? "No archived notes" : viewActive ? "No matching notes" : "No notes yet"}
                </div>
                {listView === "notes" && viewActive ? (
                  <div style={{ marginTop: 8, fontSize: 14, lineHeight: 1.55, color: "var(--fg-3)" }}>
                    Nothing matches “{activeView!.name}”. Edit the view or clear it to see all notes.
                  </div>
                ) : listView === "notes" ? (
                  <div style={{ marginTop: 8, fontSize: 14, lineHeight: 1.55, color: "var(--fg-3)" }}>
                    Tap “New note” to write your first note. Everything is encrypted on this device before it is stored.
                  </div>
                ) : null}
              </div>
            ) : treeMode ? (
              <ScreenScroll style={{ marginTop: 4 }}>
                {renderTree(null, 0)}
              </ScreenScroll>
            ) : (
              <ScreenScroll style={{ marginTop: 8 }}>
                {orderedNotes.map((n, i) => (
                  <NoteRow
                    key={n.id}
                    entry={n}
                    last={i === orderedNotes.length - 1}
                    subtitle={listView === "notes" ? subtitleFor(n.id) : undefined}
                    onOpen={() => void openNote(n.id)}
                    favorited={listView === "notes" && favSet.has(n.id)}
                    onToggleFavorite={listView === "notes" ? () => toggleFavorite(n.id) : undefined}
                    actions={
                      listView === "notes" ? undefined : (
                        <div style={{ display: "flex", gap: 4, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                          {listView === "trash" ? (
                            <>
                              <button onClick={() => void organizeRow(restoreNote, n.id)} style={{ border: "none", background: "transparent", color: "var(--accent)", fontSize: 14, fontWeight: 600, cursor: "pointer", padding: "6px 8px" }}>
                                Restore
                              </button>
                              <button onClick={() => setPurgeId(n.id)} style={{ border: "none", background: "transparent", color: "var(--danger)", fontSize: 14, fontWeight: 600, cursor: "pointer", padding: "6px 8px" }}>
                                Delete
                              </button>
                            </>
                          ) : (
                            <button onClick={() => void organizeRow(unarchiveNote, n.id)} style={{ border: "none", background: "transparent", color: "var(--accent)", fontSize: 14, fontWeight: 600, cursor: "pointer", padding: "6px 8px" }}>
                              Unarchive
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

        {tab === "graph" && <GraphTab graph={noteGraph} onOpen={(id) => void openNote(id)} />}
        {tab === "files" && <AttachmentsSheet variant="page" onClose={() => setTab("notes")} />}
        {tab === "templates" && (
          <TemplatesSheet
            variant="page"
            onBack={() => setTab("notes")}
            templates={templateNotes}
            onClose={() => setTab("notes")}
            onEdit={(id) => {
              setTab("notes");
              void openNote(id);
            }}
            onUse={(id) => {
              setTab("notes");
              void (async () => {
                try {
                  const nid = await createNoteFromTemplate(id, "", currentFolder, new Date());
                  await refresh();
                  void openNote(nid);
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
                  void openNote(nid);
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

        <TabBar
          active={tab}
          onNotes={() => setTab("notes")}
          onGraph={() => setTab("graph")}
          onAttachments={() => setTab("files")}
        />

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

        {syncDetailOpen && (
          <Sheet onClose={() => setSyncDetailOpen(false)}>
            <h2 style={{ margin: "0 0 14px", fontSize: 20, fontWeight: 700, color: "var(--fg-display)" }}>
              Sync status
            </h2>
            <SyncStatusDetail />
          </Sheet>
        )}

        {conflictsOpen && (
          <Sheet
            onClose={() => setConflictsOpen(false)}
            style={{ maxHeight: "82%", display: "flex", flexDirection: "column", overflow: "hidden" }}
          >
            <h2 style={{ margin: "0 0 14px", fontSize: 20, fontWeight: 700, color: "var(--fg-display)" }}>
              Conflicts
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
            onOpenNote={(id) => void openNote(id)}
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
            onOpenNote={(id) => void openNote(id)}
            onSavedView={(id) => {
              setTagBrowserOpen(false);
              bumpPrefsNonce();
              setActiveViewId(id);
              setActiveTag(null);
              setListView("notes");
            }}
          />
        )}
      </Screen>
    );
  }

  // ── Editor view ─────────────────────────────────────────────────────────────
  const headerTitle = deriveTitleSnippet(editorText).title || (editing?.id ? "Untitled" : "New note");
  const isExisting = editing?.id != null;
  const backlinkNotes = (editing?.id ? (noteGraph.backlinks.get(editing.id) ?? []) : [])
    .map((bid) => notes.find((n) => n.id === bid))
    .filter((n): n is NoteEntry => n != null);
  // Unlinked mentions — live notes whose BODY contains this note's title as
  // plain text but that don't already wiki-link it (excludes the backlinks +
  // self). The right-panel `#` tab (distinct from the Tag Browser). Guarded on a
  // ≥3-char title to avoid trivial-substring noise.
  const unlinkedMentions = (() => {
    if (editing?.id == null) return [] as NoteEntry[];
    const t = foldSegment(headerTitle.trim());
    if (t.length < 3) return [];
    const linked = new Set(noteGraph.backlinks.get(editing.id) ?? []);
    return liveNotes.filter(
      (n) => n.id !== editing.id && !linked.has(n.id) && foldSegment(bodyAfterFrontmatter(bodies.get(n.id) ?? "")).includes(t),
    );
  })();

  // Reading-mode wikilink tap → resolve title to a note and open it (saving the
  // current note first via openRelated).
  const openWikilinkTarget = (target: string) => {
    const id = notes.find((n) => foldSegment(n.title) === foldSegment(target))?.id;
    if (id) void openRelated(id);
  };

  return (
    <Screen ref={screenRef}>
      <EditorTopBar
        onBack={() => void saveNote()}
        onExplorer={() => setLeftPanel(true)}
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

      {readingMode ? (
        <MarkdownView
          text={editorText}
          onOpenWikilink={openWikilinkTarget}
          fontFamily={prefs.editor_font_family === "sans" ? "var(--font-sans)" : "var(--font-mono)"}
          fontSize={EDITOR_TEXT_PX[prefs.editor_text_size ?? "md"] ?? 16}
        />
      ) : (
        // Shared live-preview editor (@myne/editor): raw-on-edit CodeMirror with
        // tables / KaTeX / syntax highlighting / frontmatter-as-properties, plus
        // its own in-editor selection toolbar + slash menu + keymaps — so mobile
        // no longer needs a separate FormatBar. Typography (font/size/spacing)
        // is applied on the wrapper like the desktop `typographyStyle` wrapper;
        // the engine also reads prefs via the injected EditorHost.
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: "auto",
            WebkitOverflowScrolling: "touch",
            background: "var(--bg-1)",
            fontFamily: prefs.editor_font_family === "sans" ? "var(--font-sans)" : "var(--font-mono)",
            fontSize: EDITOR_TEXT_PX[prefs.editor_text_size ?? "md"] ?? 16,
            lineHeight: EDITOR_LINE_HEIGHT[prefs.editor_line_spacing ?? "normal"] ?? 1.75,
          }}
        >
          <CMEditor
            value={editorText}
            onChange={setEditorText}
            onReady={setEditorView}
            viewMode={rawMode ? "source" : "live"}
            style={{ width: "100%", minHeight: "100%", color: "var(--fg-1)", padding: "18px 22px" }}
          />
        </div>
      )}

      {readingMode ? (
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
        />
      )}

      {leftPanel && (
        <ExplorerPanel
          notes={liveNotes}
          folderOf={folderOf}
          currentId={editing?.id ?? null}
          onOpen={(id) => {
            setLeftPanel(false);
            void openRelated(id);
          }}
          onClose={() => setLeftPanel(false)}
        />
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
            return s.words === 0 ? "Empty note" : `${s.words} ${s.words === 1 ? "word" : "words"} · ${s.readingMinutes} min read`;
          })()}
          copied={copied}
          busy={editorBusy}
          onClose={() => setMoreOpen(false)}
          onCopy={() => void copyNote()}
          onMove={() => {
            if (editing?.id == null) return;
            setMoreOpen(false);
            setMoveInput(readNoteFolder(editorText) ?? "");
            setMoveTarget(editing.id);
          }}
          onHistory={() => {
            setMoreOpen(false);
            setHistoryOpen(true);
          }}
          onExport={() => {
            setMoreOpen(false);
            window.print();
          }}
          onArchive={() => {
            setMoreOpen(false);
            void organizeCurrent(archiveNote, "Couldn't archive this note.");
          }}
          onTrash={() => {
            setMoreOpen(false);
            void organizeCurrent(trashNote, "Couldn't move this note to Trash.");
          }}
        />
      )}

      {purgeId != null && (
        <Sheet onClose={() => setPurgeId(null)}>
          {(close) => (
            <>
          <div style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)", textAlign: "center" }}>Delete permanently?</div>
          <div style={{ marginTop: 8, fontSize: 14, lineHeight: 1.5, color: "var(--fg-3)", textAlign: "center" }}>
            This removes the note from this device for good. This cannot be undone.
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
              Delete permanently
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
              Cancel
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
              <div style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)", textAlign: "center" }}>Move to folder</div>
              <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.5, color: "var(--fg-3)", textAlign: "center" }}>
                Type a folder path (e.g. Projects/Myne). Leave blank for the vault root.
              </div>
              <input
                value={moveInput}
                onChange={(e) => setMoveInput(e.target.value)}
                placeholder="Projects/Myne"
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
                  Move
                </button>
                <button
                  onClick={close}
                  style={{ width: "100%", height: 50, border: "1px solid var(--line-2)", borderRadius: 8, background: "transparent", color: "var(--fg-1)", fontFamily: "var(--font-sans)", fontSize: 16, fontWeight: 500, cursor: "pointer" }}
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </Sheet>
      )}

      {manageAttachments && (
        <AttachmentsSheet
          onClose={() => setManageAttachments(false)}
          onInsert={(id, filename) => {
            insertIntoEditor(emitAttachmentEmbed(id, filename));
            setManageAttachments(false);
          }}
        />
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

      {/* Off-screen print surface — `window.print()` (the PDF button) isolates
          this via @media print (mobile.css). Frontmatter stripped; attachment
          embeds render inline via the attachment:// scheme. */}
      <div id="myne-print">
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: "0 0 16px" }}>{headerTitle}</h1>
        <MarkdownView text={bodyAfterFrontmatter(editorText)} onOpenWikilink={() => {}} fontFamily="var(--font-sans)" fontSize={15} />
      </div>
    </Screen>
  );
}

// ── Editor chrome (Obsidian/Notion-style page, not a modal) ─────────────────

interface OutlineItem {
  level: number;
  text: string;
  /** Char offset of the heading line start, for caret jump. */
  index: number;
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

const chromeBtn: CSSProperties = {
  width: 38,
  height: 38,
  borderRadius: 9,
  border: "none",
  background: "transparent",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  flex: "none",
};

/** Minimal editor top bar (the "it's a page, not a modal" chrome). Back
 *  autosaves and returns to the list; the title lives inline as the note's first
 *  line, so the bar only carries the two panel toggles + the read/edit switch. */
function EditorTopBar({
  onBack,
  onExplorer,
  onContext,
  onMore,
  folder,
  busy,
}: {
  onBack: () => void;
  onExplorer: () => void;
  onContext: () => void;
  /** Note-actions ⋯ menu. Omitted for a brand-new (unsaved) note. */
  onMore?: () => void;
  folder: string | null;
  busy: boolean;
}) {
  return (
    <div
      style={{
        flex: "none",
        padding: `${EDITOR_TOP} 8px 8px`,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 6,
        borderBottom: "1px solid var(--line-1)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 2, flex: "none" }}>
        <button onClick={onBack} disabled={busy} aria-label="Back to notes" style={{ ...chromeBtn, opacity: busy ? 0.5 : 1 }}>
          <Icon name="chevron-left" size={22} color="var(--accent)" strokeWidth={2} />
        </button>
        <button onClick={onExplorer} aria-label="Open explorer" style={chromeBtn}>
          <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
            <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="var(--fg-2)" strokeWidth="1.7" />
            <rect x="3.5" y="4.5" width="6" height="15" rx="2.5" fill="var(--fg-2)" opacity="0.85" />
          </svg>
        </button>
      </div>

      <div style={{ flex: 1, minWidth: 0, textAlign: "center", fontSize: 12, color: "var(--fg-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)" }}>
        {folder ? folder.replace(/\/$/, "").replace(/\//g, " / ") : ""}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 2, flex: "none" }}>
        <button onClick={onContext} aria-label="Note details" style={chromeBtn}>
          <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
            <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="var(--fg-2)" strokeWidth="1.7" />
            <rect x="14.5" y="4.5" width="6" height="15" rx="2.5" fill="var(--fg-2)" opacity="0.85" />
          </svg>
        </button>
        {onMore && (
          <button onClick={onMore} aria-label="Note actions" style={chromeBtn}>
            <svg width="21" height="21" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6" fill="var(--fg-2)" /><circle cx="12" cy="12" r="1.6" fill="var(--fg-2)" /><circle cx="19" cy="12" r="1.6" fill="var(--fg-2)" /></svg>
          </button>
        )}
      </div>
    </div>
  );
}

/** Note-actions sheet (the ⋯ menu): Copy / Move / History / Export / Archive /
 *  Trash. Ported off the old right-panel footer so the panel matches the desktop
 *  tabbed convention (context only). */
function NoteActionsSheet({
  stat,
  copied,
  busy,
  onClose,
  onCopy,
  onMove,
  onHistory,
  onExport,
  onArchive,
  onTrash,
}: {
  stat: string;
  copied: boolean;
  busy: boolean;
  onClose: () => void;
  onCopy: () => void;
  onMove: () => void;
  onHistory: () => void;
  onExport: () => void;
  onArchive: () => void;
  onTrash: () => void;
}) {
  const row = (text: string, onClick: () => void, first = false, danger = false): ReactNode => (
    <button
      onClick={onClick}
      disabled={busy}
      style={{ display: "flex", alignItems: "center", width: "100%", border: "none", background: "transparent", padding: "14px 14px", borderTop: first ? undefined : "1px solid var(--line-1)", cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1, fontFamily: "var(--font-sans)", fontSize: 16, color: danger ? "var(--danger)" : "var(--fg-1)" }}
    >
      {text}
    </button>
  );
  return (
    <Sheet onClose={onClose} padded={false}>
      {() => (
        <>
          <div style={{ padding: "2px 16px 10px", fontSize: 13, color: "var(--fg-3)" }}>{stat}</div>
          <div style={{ border: "1px solid var(--line-1)", borderRadius: 12, overflow: "hidden", background: "var(--bg-1)", margin: "0 6px" }}>
            {row(copied ? "Copied ✓" : "Copy to clipboard", onCopy, true)}
            {row("Move to folder…", onMove)}
            {row("Version history", onHistory)}
            {row("Export as PDF", onExport)}
            {row("Archive", onArchive)}
            {row("Move to Trash", onTrash, false, true)}
          </div>
        </>
      )}
    </Sheet>
  );
}

/** Slim bottom bar shown in reading mode — the guaranteed way back to editing
 *  (the FormatBar is hidden while reading, and the outline "Jump" only works for
 *  a note that actually has headings). */
function ReadingBar({ onEdit }: { onEdit: () => void }) {
  return (
    <div
      style={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderTop: "1px solid var(--line-1)",
        background: "var(--bg-2)",
        padding: "6px 6px",
        paddingBottom: "calc(6px + env(safe-area-inset-bottom, 0px))",
      }}
    >
      <button
        onClick={onEdit}
        aria-label="Edit note"
        style={{ display: "flex", alignItems: "center", gap: 8, height: 40, padding: "0 18px", borderRadius: 9, border: "none", background: "transparent", cursor: "pointer", color: "var(--accent)", fontFamily: "var(--font-sans)", fontSize: 15, fontWeight: 600 }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 20l4-1L18.5 8.5a2 2 0 0 0-3-3L5 16l-1 4zM14 6l3 3" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
        Edit
      </button>
    </div>
  );
}

/** Minimal structural pointer-event shape for the tap/scroll discrimination. */
type PressEvt = { preventDefault: () => void; clientX: number; clientY: number };

/** Markdown formatting bar that rides above the keyboard (mobile's answer to the
 *  desktop selection toolbar — mirrors Obsidian's accessory bar). Every action
 *  runs a SHARED `@myne/editor` command against the live CMEditor view, so the
 *  formatting logic is identical to desktop and lives in exactly one place.
 *  Horizontally scrollable action row + a pinned keyboard-dismiss button. */
function FormatBar({
  view,
  attaching,
  rawMode,
  onToggleRaw,
  onAttach,
  onLibrary,
}: {
  view: EditorView | null;
  attaching: boolean;
  rawMode: boolean;
  onToggleRaw: () => void;
  onAttach: () => void;
  onLibrary: () => void;
}) {
  // Fire on a genuine TAP only — never while the row is being scrolled. On
  // pointerdown we preventDefault (keeps the editor's focus + selection, so
  // formatting applies to the current selection) and record the start; the action
  // runs on pointerup ONLY if the pointer barely moved since (a tap, not a
  // horizontal scroll drag over the buttons).
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  const onPress = (e: PressEvt) => {
    e.preventDefault();
    pressRef.current = { x: e.clientX, y: e.clientY };
  };
  const isTap = (e: PressEvt): boolean => {
    const d = pressRef.current;
    pressRef.current = null;
    return d != null && Math.abs(e.clientX - d.x) <= 10 && Math.abs(e.clientY - d.y) <= 10;
  };
  // The press is recorded in ONE shared ref, so if the finger leaves the pressed
  // button (drifting onto a neighbor, or the row being flick-scrolled) we must
  // drop it — otherwise releasing over a different button would fire that button.
  const cancel = () => { pressRef.current = null; };
  const run = (fn: (v: EditorView) => void) => ({
    onPointerDown: onPress,
    onPointerUp: (e: PressEvt) => { if (isTap(e) && view) fn(view); },
    onPointerLeave: cancel,
    onPointerCancel: cancel,
  });
  const tap = (cb: () => void) => ({
    onPointerDown: onPress,
    onPointerUp: (e: PressEvt) => { if (isTap(e)) cb(); },
    onPointerLeave: cancel,
    onPointerCancel: cancel,
  });
  const fbtn: CSSProperties = {
    minWidth: 40,
    height: 40,
    padding: "0 8px",
    borderRadius: 9,
    border: "none",
    background: "transparent",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    flex: "none",
    color: "var(--fg-2)",
    fontSize: 16,
  };
  const st = { stroke: "var(--fg-2)", strokeWidth: 1.7, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  return (
    <div
      style={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        borderTop: "1px solid var(--line-1)",
        background: "var(--bg-2)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 1, overflowX: "auto", padding: "6px 6px", scrollbarWidth: "none", touchAction: "pan-x" }}>
        <button {...run((v) => { undo(v); v.focus(); })} aria-label="Undo" style={fbtn}>
          <svg width="20" height="20" viewBox="0 0 24 24"><path d="M7 7L3 11l4 4" {...st} /><path d="M3 11h11a6 6 0 0 1 0 12h-2" {...st} /></svg>
        </button>
        <button {...run((v) => { redo(v); v.focus(); })} aria-label="Redo" style={fbtn}>
          <svg width="20" height="20" viewBox="0 0 24 24"><path d="M17 7l4 4-4 4" {...st} /><path d="M21 11H10a6 6 0 0 0 0 12h2" {...st} /></svg>
        </button>
        <div style={{ width: 1, height: 22, background: "var(--line-2)", margin: "0 5px", flex: "none" }} />
        <button {...run(editorCommands.heading1)} aria-label="Heading 1" style={{ ...fbtn, fontWeight: 700 }}>H1</button>
        <button {...run(editorCommands.heading2)} aria-label="Heading 2" style={{ ...fbtn, fontWeight: 700, fontSize: 14 }}>H2</button>
        <button {...run(editorCommands.bold)} aria-label="Bold" style={{ ...fbtn, fontWeight: 800 }}>B</button>
        <button {...run(editorCommands.italic)} aria-label="Italic" style={{ ...fbtn, fontStyle: "italic", fontWeight: 600 }}>I</button>
        <button {...run(editorCommands.bulletList)} aria-label="Bullet list" style={fbtn}>
          <svg width="20" height="20" viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11" {...st} /><circle cx="4.5" cy="6" r="1.3" fill="var(--fg-2)" /><circle cx="4.5" cy="12" r="1.3" fill="var(--fg-2)" /><circle cx="4.5" cy="18" r="1.3" fill="var(--fg-2)" /></svg>
        </button>
        <button {...run(editorCommands.checklist)} aria-label="Checklist" style={fbtn}>
          <svg width="20" height="20" viewBox="0 0 24 24"><rect x="3" y="4" width="7" height="7" rx="1.5" {...st} /><path d="M4.6 7.5l1.5 1.5 2.3-2.6" {...st} /><path d="M13 7.5h8M13 16.5h8" {...st} /><rect x="3" y="13" width="7" height="7" rx="1.5" {...st} /></svg>
        </button>
        <button {...run(editorCommands.quote)} aria-label="Quote" style={fbtn}>
          <svg width="20" height="20" viewBox="0 0 24 24"><path d="M5 5v14M9 8h11M9 12h11M9 16h7" {...st} /></svg>
        </button>
        <button {...run(editorCommands.code)} aria-label="Code" style={fbtn}>
          <svg width="20" height="20" viewBox="0 0 24 24"><path d="M9 8l-4 4 4 4M15 8l4 4-4 4" {...st} /></svg>
        </button>
        <button {...run(editorCommands.wikilink)} aria-label="Wiki link" style={{ ...fbtn, fontWeight: 700, fontSize: 15 }}>[[</button>
        <button {...run(editorCommands.link)} aria-label="Link" style={fbtn}>
          <svg width="20" height="20" viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6L11 7" {...st} /><path d="M14 10a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6L13 17" {...st} /></svg>
        </button>
        <button {...tap(onAttach)} disabled={attaching} aria-label="Attach new file" style={{ ...fbtn, opacity: attaching ? 0.5 : 1 }}>
          {attaching ? <Spinner size={18} /> : (
            <svg width="20" height="20" viewBox="0 0 24 24"><path d="M21 12.5 12.5 21a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.6 18.4a1.7 1.7 0 0 1-2.4-2.4l7.6-7.6" {...st} /></svg>
          )}
        </button>
        <button {...tap(onLibrary)} aria-label="Insert from library" style={fbtn}>
          <svg width="20" height="20" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2" {...st} /><circle cx="8.5" cy="9.5" r="1.5" fill="var(--fg-2)" /><path d="M20 15l-4.5-4.5L5 20" {...st} /></svg>
        </button>
      </div>
      <button {...tap(onToggleRaw)} aria-label={rawMode ? "Show live preview" : "Show raw markdown"} style={{ ...fbtn, borderLeft: "1px solid var(--line-1)", borderRadius: 0, width: 44 }}>
        {rawMode ? (
          // Raw/source mode → pen (you're editing the raw markdown).
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M4 20l4-1L18.5 8.5a2 2 0 0 0-3-3L5 16l-1 4zM14 6l3 3" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
        ) : (
          // Live/preview mode → eye (you're viewing the rendered content).
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" stroke="var(--fg-2)" strokeWidth="1.7" /><circle cx="12" cy="12" r="2.7" stroke="var(--fg-2)" strokeWidth="1.7" /></svg>
        )}
      </button>
      <button {...run((v) => v.contentDOM.blur())} aria-label="Hide keyboard" style={{ ...fbtn, borderLeft: "1px solid var(--line-1)", borderRadius: 0, width: 48 }}>
        <svg width="22" height="22" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="11" rx="2" stroke="var(--fg-2)" strokeWidth="1.6" fill="none" /><path d="M7 7.5h.01M11 7.5h.01M15 7.5h.01M7 11h.01M11 11h.01M15 11h.01M9 20l3 -3 3 3" stroke="var(--fg-2)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" /></svg>
      </button>
    </div>
  );
}

/** Left side sheet — a note explorer (folders + notes) to jump anywhere without
 *  leaving the editor. Its own folder-drill + filter state. */
function ExplorerPanel({
  notes,
  folderOf,
  currentId,
  onOpen,
  onClose,
}: {
  notes: NoteEntry[];
  folderOf: Map<string, string | null>;
  currentId: string | null;
  onOpen: (id: string) => void;
  onClose: () => void;
}) {
  // Its own collapse state (empty = all expanded → the whole tree is visible).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const titleOf = useMemo(() => new Map(notes.map((n) => [n.id, n.title])), [notes]);
  const sortIds = (ids: string[]) => [...ids].sort((a, b) => (titleOf.get(a) ?? "").localeCompare(titleOf.get(b) ?? ""));
  const treeRows = query ? [] : buildFolderTree(folderOf, collapsed, sortIds);
  const flatMatches = query ? notes.filter((n) => n.title.toLowerCase().includes(query)) : [];
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const nx = new Set(prev);
      nx.has(path) ? nx.delete(path) : nx.add(path);
      return nx;
    });

  // A note row — title only, NO icon (per the batch-4 spec); highlights the
  // current note. `indent` matches the main-list tree geometry.
  const noteRow = (id: string, indent: number): ReactNode => {
    const on = id === currentId;
    return (
      <button
        key={id}
        onClick={() => onOpen(id)}
        style={{ display: "flex", alignItems: "center", width: "100%", border: "none", background: on ? "var(--accent-soft)" : "transparent", padding: "10px 16px", paddingLeft: 20 + indent, cursor: "pointer", textAlign: "left", fontFamily: "var(--font-sans)" }}
      >
        <span style={{ flex: 1, minWidth: 0, fontSize: 16, color: on ? "var(--accent)" : "var(--fg-1)", fontWeight: on ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {titleOf.get(id) || "Untitled note"}
        </span>
      </button>
    );
  };
  const empty = (text: string): ReactNode => (
    <div style={{ textAlign: "center", padding: "28px 16px", color: "var(--fg-3)", fontSize: 14 }}>{text}</div>
  );

  return (
    <SidePanel side="left" title="Explorer" onClose={onClose} padBody={false}>
      <div style={{ padding: "8px 16px 6px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, height: 38, border: "1px solid var(--line-2)", borderRadius: 9, background: "var(--bg-2)", padding: "0 11px" }}>
          <Icon name="search" size={16} color="var(--fg-3)" strokeWidth={1.7} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter notes"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontFamily: "var(--font-sans)", fontSize: 15, color: "var(--fg-1)" }}
          />
        </div>
      </div>

      {query ? (
        flatMatches.length === 0 ? empty("No notes match.") : flatMatches.map((n) => noteRow(n.id, 0))
      ) : treeRows.length === 0 ? (
        empty("No notes yet.")
      ) : (
        treeRows.map((row) => {
          const rails = [];
          for (let i = 0; i < row.depth; i++) {
            rails.push(<div key={i} style={{ position: "absolute", left: 20 + i * 18 + 6, top: 0, bottom: 0, width: 1, background: "var(--line-2)" }} />);
          }
          if (row.kind === "folder") {
            return (
              <div key={`f:${row.path}`} style={{ position: "relative" }}>
                {rails}
                <div
                  onClick={() => toggle(row.path)}
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", paddingLeft: 20 + row.depth * 18, cursor: "pointer" }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" style={{ flexShrink: 0, transform: row.collapsed ? "rotate(0deg)" : "rotate(90deg)", transition: "transform 140ms ease" }}>
                    <path d="M8 5l8 7-8 7" fill="none" stroke="var(--fg-3)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  <svg width="18" height="18" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
                    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" fill="none" stroke="var(--fg-2)" strokeWidth="1.6" strokeLinejoin="round" />
                  </svg>
                  <div style={{ flex: 1, minWidth: 0, fontSize: 16, fontWeight: 600, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.name}</div>
                  <span style={{ minWidth: 22, textAlign: "right", fontSize: 13, color: "var(--fg-3)", flexShrink: 0 }}>{row.count}</span>
                </div>
              </div>
            );
          }
          return (
            <div key={row.id} style={{ position: "relative" }}>
              {rails}
              {noteRow(row.id, row.depth * 18 + 12)}
            </div>
          );
        })
      )}
    </SidePanel>
  );
}

type ContextTab = "backlinks" | "unlinked" | "outline";

/** Right side panel — the note's CONTEXT, ported to the desktop tabbed
 *  convention: Backlinks (🔗) / Unlinked mentions (#) / Outline (☰), with a
 *  collapse button. No AI-chat tab; note actions live in the ⋯ menu instead. */
function NoteContextPanel({
  backlinks,
  unlinked,
  outline,
  onOpen,
  onJump,
  onClose,
}: {
  backlinks: NoteEntry[];
  unlinked: NoteEntry[];
  outline: OutlineItem[];
  onOpen: (id: string) => void;
  onJump: (charIndex: number) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<ContextTab>("backlinks");
  // SECTION_HEADING_STYLE (desktop sharedStyles.ts) — "LINKED FROM 0" look.
  const heading: CSSProperties = { fontSize: 11, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: 8 };
  const linkRow: CSSProperties = { display: "flex", alignItems: "center", gap: 8, width: "100%", border: "none", background: "transparent", padding: "9px 4px", borderRadius: 8, cursor: "pointer", textAlign: "left", fontSize: 15, color: "var(--fg-1)", fontFamily: "var(--font-sans)" };
  const empty = (text: string): ReactNode => <div style={{ fontSize: 13, color: "var(--fg-3)", marginTop: 4 }}>{text}</div>;
  const noteRow = (n: NoteEntry): ReactNode => (
    <button key={n.id} onClick={() => onOpen(n.id)} style={linkRow}>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.title}</span>
    </button>
  );

  const tabBtn = (id: ContextTab, aria: string, icon: ReactNode): ReactNode => {
    const on = tab === id;
    return (
      <button
        onClick={() => setTab(id)}
        aria-label={aria}
        style={{ width: 40, height: 34, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "transparent", borderBottom: on ? "2px solid var(--accent)" : "2px solid transparent", marginBottom: -1, color: on ? "var(--fg-1)" : "var(--fg-3)", cursor: "pointer" }}
      >
        {icon}
      </button>
    );
  };

  const header = (close: () => void): ReactNode => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "0 10px", minHeight: 40, borderBottom: "1px solid var(--line-1)" }}>
      <div style={{ display: "flex", gap: 2 }}>
        {tabBtn("backlinks", "Backlinks", <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M10 14a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6L11 7" /><path d="M14 10a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6L13 17" /></svg>)}
        {tabBtn("unlinked", "Unlinked mentions", <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M9 4L7 20M17 4l-2 16M5 9h15M4 15h15" /></svg>)}
        {tabBtn("outline", "Outline", <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" /></svg>)}
      </div>
      <button onClick={close} aria-label="Collapse panel" style={{ width: 32, height: 32, borderRadius: 8, border: "none", background: "transparent", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
          <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="var(--fg-2)" strokeWidth="1.7" />
          <rect x="14.5" y="4.5" width="6" height="15" rx="2.5" fill="var(--fg-2)" opacity="0.85" />
        </svg>
      </button>
    </div>
  );

  return (
    <SidePanel side="right" header={header} onClose={onClose} padBody={false}>
      <div style={{ padding: "16px 18px" }}>
        {tab === "backlinks" && (
          <>
            <div style={heading}>Linked from {backlinks.length}</div>
            {backlinks.length === 0 ? empty("No backlinks yet.") : backlinks.map(noteRow)}
          </>
        )}
        {tab === "unlinked" && (
          <>
            <div style={heading}>Unlinked mentions {unlinked.length}</div>
            {unlinked.length === 0 ? empty("No unlinked mentions.") : unlinked.map(noteRow)}
          </>
        )}
        {tab === "outline" && (
          <>
            <div style={heading}>Outline</div>
            {outline.length === 0
              ? empty("No headings")
              : outline.map((h, i) => (
                  <button key={i} onClick={() => onJump(h.index)} style={{ ...linkRow, paddingLeft: 4 + (h.level - 1) * 14, color: h.level === 1 ? "var(--fg-1)" : "var(--fg-2)", fontWeight: h.level === 1 ? 600 : 400 }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.text}</span>
                  </button>
                ))}
          </>
        )}
      </div>
    </SidePanel>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

/** On-device encryption / sync status — the top-right chip of every tab header.
 *  Mobile has no server sync yet, so it reports the honest local state. */
function SyncStatus() {
  return (
    <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 999, background: "var(--bg-2)", border: "1px solid var(--line-1)" }}>
      <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--success)" }} />
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--fg-2)" }}>Encrypted</span>
    </div>
  );
}

/** Consistent top bar shared by the Notes / Search / Graph / Files tabs: vault
 *  switcher on the left; encryption status + Settings gear pinned to the right.
 *  Stays fixed while the tab content below it animates between pages. */
function AppHeader({ label, onSwitcher, onPalette, onSettings }: { label: string; onSwitcher: () => void; onPalette: () => void; onSettings: () => void }) {
  return (
    <div style={{ flex: "none", padding: `${LIST_TOP} 14px 6px 20px`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
      <button
        onClick={onSwitcher}
        style={{ display: "flex", alignItems: "center", gap: 6, border: "none", background: "transparent", padding: 0, cursor: "pointer", minWidth: 0 }}
      >
        <MyneMark size={22} radius={4} />
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
          <path d="M2 4l4 4 4-4" stroke="var(--fg-3)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
        <SyncStatus />
        <button
          onClick={onPalette}
          aria-label="Command palette"
          style={{ width: 36, height: 36, borderRadius: 8, border: "none", background: "transparent", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
        >
          <Icon name="search" size={21} color="var(--fg-2)" strokeWidth={1.7} />
        </button>
        <button
          onClick={onSettings}
          aria-label="Settings"
          style={{ width: 36, height: 36, borderRadius: 8, border: "none", background: "transparent", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}
        >
          <Icon name="settings" size={21} color="var(--fg-2)" strokeWidth={1.7} />
        </button>
      </div>
    </div>
  );
}

/** A create-action tile (New note / Template / Daily note / New view) in the
 *  dashed "+ View" style — icon over label so four fit across a phone row.
 *  `children` are the inline SVG shapes for the glyph. */
function ActionPill({ onClick, label, children }: { onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        border: "1px solid var(--line-1)",
        borderRadius: 12,
        background: "transparent",
        color: "var(--fg-2)",
        fontSize: 12,
        fontWeight: 600,
        fontFamily: "var(--font-sans)",
        padding: "12px 4px",
        cursor: "pointer",
      }}
    >
      <svg width="19" height="19" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>{children}</svg>
      <span style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
    </button>
  );
}

/** The Filter sheet — the single home for the note-list scopes that would
 *  otherwise be scattered: status (live / Archive / Trash), saved Views, and
 *  Tags. Reached from the Filter button in the search·filter·sort toolbar. */
/** The Views sheet — browse the saved views, activate one (tap), edit it, or
 *  create a new one. Reached from the "Views" tile under the Notes heading. */
function ViewsSheet({
  views,
  activeViewId,
  onPick,
  onEdit,
  onNew,
  onClose,
}: {
  views: SavedView[];
  activeViewId: string | null;
  onPick: (id: string) => void;
  onEdit: (v: SavedView) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const typeLabel: Record<string, string> = { table: "Table", cards: "Cards", list: "List" };
  return (
    <Sheet onClose={onClose} style={{ maxHeight: "82%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {(close) => (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flex: "none", paddingBottom: 4 }}>
            <span style={{ width: 60 }} />
            <span style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)" }}>Views</span>
            <button onClick={close} style={{ width: 60, textAlign: "right", border: "none", background: "transparent", color: "var(--accent)", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Done</button>
          </div>
          <div style={{ overflowY: "auto", minHeight: 0 }}>
            <button
              onClick={() => { onNew(); close(); }}
              style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", marginTop: 8, padding: "13px 14px", border: "1px solid var(--line-1)", borderRadius: 10, background: "var(--bg-1)", color: "var(--accent)", fontFamily: "var(--font-sans)", fontSize: 16, fontWeight: 600, cursor: "pointer" }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
              New view
            </button>

            {views.length === 0 ? (
              <p style={{ margin: "16px 4px 8px", fontSize: 14, lineHeight: 1.5, color: "var(--fg-3)" }}>
                No saved views yet. Create one to filter your notes by tag, folder, or text.
              </p>
            ) : (
              <div style={{ marginTop: 12, border: "1px solid var(--line-1)", borderRadius: 10, overflow: "hidden", background: "var(--bg-1)" }}>
                {views.map((v, i) => {
                  const active = activeViewId === v.id;
                  return (
                    <div
                      key={v.id}
                      onClick={() => { onPick(v.id); close(); }}
                      style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderTop: i === 0 ? undefined : "1px solid var(--line-1)", cursor: "pointer" }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 16, fontWeight: active ? 600 : 400, color: active ? "var(--accent)" : "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.name}</div>
                        <div style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 2 }}>{typeLabel[v.view_type] ?? v.view_type}</div>
                      </div>
                      {active && <svg width="16" height="16" viewBox="0 0 24 24" style={{ flexShrink: 0 }}><path d="M5 12l5 5L20 6" fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                      <button
                        onClick={(e) => { e.stopPropagation(); onEdit(v); close(); }}
                        aria-label="Edit view"
                        style={{ flexShrink: 0, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "transparent", cursor: "pointer" }}
                      >
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M4 20l4-1 10-10-3-3L5 16l-1 4zM14 6l3 3" stroke="var(--fg-3)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </Sheet>
  );
}

/** The Sort sheet — the note-list order picker. Same modal treatment as the
 *  Filter sheet, reached from the icon-only Sort button in the toolbar. */
function SortSheet({
  mode,
  onPick,
  onClose,
}: {
  mode: "none" | "az" | "za";
  onPick: (m: "none" | "az" | "za") => void;
  onClose: () => void;
}) {
  const row = (content: ReactNode, on: boolean, onClick: () => void, first = false): ReactNode => (
    <div
      onClick={onClick}
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "12px 14px", borderTop: first ? undefined : "1px solid var(--line-1)", cursor: "pointer", color: on ? "var(--accent)" : "var(--fg-1)", fontWeight: on ? 600 : 400, fontSize: 16 }}
    >
      {content}
      {on && <svg width="16" height="16" viewBox="0 0 24 24" style={{ flexShrink: 0 }}><path d="M5 12l5 5L20 6" fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
    </div>
  );
  return (
    <Sheet onClose={onClose} style={{ maxHeight: "82%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {(close) => (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flex: "none", paddingBottom: 4 }}>
            <span style={{ width: 60 }} />
            <span style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)" }}>Sort</span>
            <button onClick={close} style={{ width: 60, textAlign: "right", border: "none", background: "transparent", color: "var(--accent)", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Done</button>
          </div>
          <div style={{ overflowY: "auto", minHeight: 0 }}>
            <div style={{ marginTop: 8, border: "1px solid var(--line-1)", borderRadius: 10, overflow: "hidden", background: "var(--bg-1)" }}>
              {row("Manual order", mode === "none", () => { onPick("none"); close(); }, true)}
              {row("Title · A → Z", mode === "az", () => { onPick("az"); close(); })}
              {row("Title · Z → A", mode === "za", () => { onPick("za"); close(); })}
            </div>
          </div>
        </>
      )}
    </Sheet>
  );
}

function FilterSheet({
  onClose,
  listView,
  onPickStatus,
  archivedCount,
  trashedCount,
  views,
  activeViewId,
  onPickView,
  tagCount,
  onOpenTags,
}: {
  onClose: () => void;
  listView: "notes" | "archive" | "trash";
  onPickStatus: (v: "notes" | "archive" | "trash") => void;
  archivedCount: number;
  trashedCount: number;
  views: SavedView[];
  activeViewId: string | null;
  onPickView: (id: string) => void;
  tagCount: number;
  onOpenTags: () => void;
}) {
  const label: CSSProperties = { fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--fg-3)", padding: "16px 4px 8px" };
  const row = (content: ReactNode, on: boolean, onClick: () => void, first = false): ReactNode => (
    <div
      onClick={onClick}
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "12px 14px", borderTop: first ? undefined : "1px solid var(--line-1)", cursor: "pointer", color: on ? "var(--accent)" : "var(--fg-1)", fontWeight: on ? 600 : 400, fontSize: 16 }}
    >
      {content}
      {on && <svg width="16" height="16" viewBox="0 0 24 24" style={{ flexShrink: 0 }}><path d="M5 12l5 5L20 6" fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
    </div>
  );
  const group = (children: ReactNode): ReactNode => (
    <div style={{ border: "1px solid var(--line-1)", borderRadius: 10, overflow: "hidden", background: "var(--bg-1)" }}>{children}</div>
  );
  return (
    <Sheet onClose={onClose} style={{ maxHeight: "82%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {(close) => (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flex: "none", paddingBottom: 4 }}>
            <span style={{ width: 60 }} />
            <span style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)" }}>Filter</span>
            <button onClick={close} style={{ width: 60, textAlign: "right", border: "none", background: "transparent", color: "var(--accent)", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Done</button>
          </div>
          <div style={{ overflowY: "auto", minHeight: 0 }}>
            <div style={label}>Status</div>
            {group(
              <>
                {row("All notes", listView === "notes", () => { onPickStatus("notes"); close(); }, true)}
                {row(<span>Archive{archivedCount > 0 ? <span style={{ color: "var(--fg-3)", fontWeight: 400 }}> · {archivedCount}</span> : ""}</span>, listView === "archive", () => { onPickStatus("archive"); close(); })}
                {row(<span>Trash{trashedCount > 0 ? <span style={{ color: "var(--fg-3)", fontWeight: 400 }}> · {trashedCount}</span> : ""}</span>, listView === "trash", () => { onPickStatus("trash"); close(); })}
              </>,
            )}

            {views.length > 0 && (
              <>
                <div style={label}>Views</div>
                {group(views.map((v, i) => row(v.name, activeViewId === v.id, () => { onPickView(v.id); close(); }, i === 0)))}
              </>
            )}

            {tagCount > 0 && (
              <>
                <div style={label}>Tags</div>
                {group(
                  <div onClick={() => { onOpenTags(); close(); }} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "12px 14px", cursor: "pointer", fontSize: 16, color: "var(--fg-1)" }}>
                    <span>Browse tags…<span style={{ color: "var(--fg-3)", fontWeight: 400 }}> · {tagCount}</span></span>
                    <svg width="8" height="13" viewBox="0 0 8 14" style={{ flex: "none" }}><path d="M1 1l6 6-6 6" stroke="var(--line-2)" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </div>,
                )}
              </>
            )}
            <div style={{ height: 8 }} />
          </div>
        </>
      )}
    </Sheet>
  );
}

/** Tag Browser (mobile port of the desktop bottom-bar TagBrowser, Image #26):
 *  multi-select tag chips + an All/Any match mode, a live matching-notes list,
 *  and Save-as-view / Clear. Distinct from the right-panel Unlinked-mentions
 *  tab — same `#` glyph, different feature. Filtering is a client-side set
 *  algebra over `byTag` (AND = intersection, OR = union), gated to live ids. */
function TagBrowserSheet({
  onClose,
  tags,
  byTag,
  liveIds,
  titleById,
  viewOrder,
  onOpenNote,
  onSavedView,
}: {
  onClose: () => void;
  tags: { tag: string; count: number }[];
  byTag: Map<string, string[]>;
  liveIds: Set<string>;
  titleById: Map<string, string>;
  viewOrder: string[];
  onOpenNote: (id: string) => void;
  onSavedView: (id: string) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"all" | "any">("all");
  const [q, setQ] = useState("");
  const [savingName, setSavingName] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);

  const displayByKey = useMemo(() => new Map(tags.map((t) => [foldSegment(t.tag), t.tag])), [tags]);
  const needle = foldSegment(q.trim());
  const shownTags = needle ? tags.filter((t) => foldSegment(t.tag).includes(needle)) : tags;

  const matchIds = useMemo(() => {
    const keys = [...selected];
    if (keys.length === 0) return [];
    let acc: Set<string> | null = null;
    for (const k of keys) {
      const ids = new Set((byTag.get(k) ?? []).filter((id) => liveIds.has(id)));
      if (acc === null) acc = ids;
      else if (mode === "all") {
        const nx = new Set<string>();
        for (const id of acc) if (ids.has(id)) nx.add(id);
        acc = nx;
      } else {
        for (const id of ids) acc.add(id);
      }
    }
    return [...(acc ?? new Set<string>())];
  }, [selected, mode, byTag, liveIds]);

  const toggle = (k: string) =>
    setSelected((prev) => {
      const nx = new Set(prev);
      nx.has(k) ? nx.delete(k) : nx.add(k);
      return nx;
    });

  async function saveView() {
    const name = (savingName ?? "").trim();
    if (name === "" || selected.size === 0) return;
    setSaveBusy(true);
    const children = [...selected].map((k) => ({ kind: "hasTag" as const, tag: displayByKey.get(k) ?? k }));
    const view: SavedView = {
      id: crypto.randomUUID(),
      name,
      view_type: "list",
      filters: mode === "all" ? { kind: "and", children } : { kind: "or", children },
    };
    try {
      if (HAS_TAURI) {
        await upsertSavedView(view);
        await setViewOrder([...viewOrder, view.id]);
      }
      onSavedView(view.id);
    } catch {
      setSaveBusy(false);
    }
  }

  const modeBtn = (m: "all" | "any", txt: string): ReactNode => (
    <button
      onClick={() => setMode(m)}
      style={{ flex: 1, padding: "6px 0", borderRadius: 6, border: "none", background: mode === m ? "var(--bg-1)" : "transparent", color: mode === m ? "var(--fg-1)" : "var(--fg-3)", fontSize: 13, fontWeight: mode === m ? 600 : 500, fontFamily: "var(--font-sans)", cursor: "pointer" }}
    >
      {txt}
    </button>
  );

  return (
    <Sheet onClose={onClose} style={{ maxHeight: "86%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {(close) => (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flex: "none", paddingBottom: 8 }}>
            <span style={{ width: 60 }} />
            <span style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)" }}>Tags</span>
            <button onClick={close} style={{ width: 60, textAlign: "right", border: "none", background: "transparent", color: "var(--accent)", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Done</button>
          </div>

          {/* Search + All/Any toggle */}
          <div style={{ flex: "none", display: "flex", gap: 8, alignItems: "center" }}>
            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, height: 40, border: "1px solid var(--line-2)", borderRadius: 9, background: "var(--bg-2)", padding: "0 11px" }}>
              <Icon name="search" size={16} color="var(--fg-3)" strokeWidth={1.7} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search tags…"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontFamily: "var(--font-sans)", fontSize: 15, color: "var(--fg-1)" }}
              />
            </div>
            <div style={{ flex: "none", display: "flex", gap: 3, background: "var(--bg-2)", border: "1px solid var(--line-2)", borderRadius: 8, padding: 3, width: 110 }}>
              {modeBtn("all", "All")}
              {modeBtn("any", "Any")}
            </div>
          </div>

          {/* Tag chips — tap to toggle into the filter */}
          <div style={{ flex: "none", display: "flex", flexWrap: "wrap", gap: 8, padding: "12px 0" }}>
            {shownTags.map((t) => {
              const k = foldSegment(t.tag);
              const on = selected.has(k);
              return (
                <button
                  key={k}
                  onClick={() => toggle(k)}
                  style={{ display: "inline-flex", alignItems: "center", gap: 5, border: `1px solid ${on ? "var(--accent)" : "var(--line-2)"}`, borderRadius: 999, background: on ? "var(--accent-soft)" : "var(--bg-2)", color: on ? "var(--accent)" : "var(--fg-2)", fontSize: 13, fontFamily: "var(--font-sans)", padding: "5px 12px", cursor: "pointer" }}
                >
                  #{t.tag}
                  {t.count > 1 && <span style={{ opacity: 0.6 }}>{t.count}</span>}
                </button>
              );
            })}
            {shownTags.length === 0 && <span style={{ fontSize: 14, color: "var(--fg-3)", padding: "4px 2px" }}>No tags match.</span>}
          </div>

          {/* Results: NOTES count + Save-as-view / Clear, then the matching notes */}
          {selected.size > 0 && (
            <>
              <div style={{ flex: "none", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, borderTop: "1px solid var(--line-1)", paddingTop: 10 }}>
                <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--fg-3)" }}>Notes · {matchIds.length}</span>
                <div style={{ display: "flex", gap: 16, flexShrink: 0 }}>
                  {matchIds.length > 0 && (
                    <button onClick={() => setSavingName("")} style={{ border: "none", background: "transparent", color: "var(--accent)", fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0 }}>Save as view</button>
                  )}
                  <button onClick={() => setSelected(new Set())} style={{ border: "none", background: "transparent", color: "var(--fg-3)", fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0 }}>Clear</button>
                </div>
              </div>

              {savingName !== null && (
                <div style={{ flex: "none", display: "flex", gap: 8, marginTop: 10 }}>
                  <input
                    value={savingName}
                    onChange={(e) => setSavingName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void saveView()}
                    placeholder="View name"
                    autoFocus
                    autoCapitalize="none"
                    autoCorrect="off"
                    style={{ flex: 1, minWidth: 0, height: 40, border: "1px solid var(--line-2)", borderRadius: 9, background: "var(--bg-1)", padding: "0 12px", fontFamily: "var(--font-sans)", fontSize: 15, color: "var(--fg-1)", outline: "none", boxSizing: "border-box" }}
                  />
                  <button
                    onClick={() => void saveView()}
                    disabled={saveBusy || savingName.trim() === ""}
                    style={{ flex: "none", height: 40, padding: "0 16px", border: "none", borderRadius: 9, background: "var(--accent)", color: "var(--accent-on)", fontFamily: "var(--font-sans)", fontSize: 14, fontWeight: 600, cursor: "pointer", opacity: saveBusy || savingName.trim() === "" ? 0.5 : 1 }}
                  >
                    Save
                  </button>
                </div>
              )}

              <div style={{ overflowY: "auto", minHeight: 0, marginTop: 8 }}>
                {matchIds.map((id) => (
                  <button
                    key={id}
                    onClick={() => { close(); onOpenNote(id); }}
                    style={{ display: "block", width: "100%", textAlign: "left", border: "none", borderTop: "1px solid var(--line-1)", background: "transparent", padding: "12px 4px", fontFamily: "var(--font-sans)", fontSize: 16, color: "var(--fg-1)", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {titleById.get(id) || "Untitled note"}
                  </button>
                ))}
                <div style={{ height: "calc(8px + env(safe-area-inset-bottom, 0px))" }} />
              </div>
            </>
          )}
        </>
      )}
    </Sheet>
  );
}

interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
}

/** Command palette (mobile port of the desktop `CommandPalette`) — a top-anchored
 *  modal opened ONLY from the bottom bar's Search button (the list toolbar's
 *  search is a plain inline filter). Animates in on mount. A COMMANDS section
 *  (substring-filtered over the registry) sits above a NOTES section (backend
 *  MYS1 BM25 search, client fallback in browser-dev), debounced 120ms. */
function CommandPalette({
  commands,
  notes,
  bodies,
  onOpenNote,
  onClose,
}: {
  commands: PaletteCommand[];
  notes: NoteEntry[];
  bodies: Map<string, string>;
  onOpenNote: (id: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const query = q.trim();
  const needle = query.toLowerCase();
  const cmdMatches = query ? commands.filter((c) => c.label.toLowerCase().includes(needle)) : commands;
  const snippetOf = useMemo(() => new Map(notes.map((n) => [n.id, n.snippet])), [notes]);
  const [noteResults, setNoteResults] = useState<NoteEntry[]>([]);
  useEffect(() => {
    if (query === "") {
      setNoteResults([]);
      return;
    }
    let cancelled = false;
    const t = window.setTimeout(() => {
      if (!HAS_TAURI) {
        setNoteResults(searchNotes(q, notes, bodies));
        return;
      }
      void noteSearch(query)
        .then((hits) => {
          if (cancelled) return;
          setNoteResults(hits.map((h) => ({ id: h.note_id, title: h.title || "Untitled note", snippet: snippetOf.get(h.note_id) ?? "" })));
        })
        .catch(() => {
          if (!cancelled) setNoteResults(searchNotes(q, notes, bodies));
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [q, query, notes, bodies, snippetOf]);

  const sectionLabel: CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--fg-3)", padding: "12px 16px 4px" };
  const rowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 11, width: "100%", border: "none", background: "transparent", padding: "10px 16px", cursor: "pointer", textAlign: "left", fontFamily: "var(--font-sans)" };
  const first = cmdMatches[0] ?? null;

  // Enter animation: mount closed, flip open on the next frame so the transition
  // runs (scrim fades, panel slides down + fades from the top).
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  // Exit animation: reverse the enter, THEN unmount. Every dismiss path routes
  // through this instead of `onClose` directly.
  const closingRef = useRef(false);
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setShown(false);
    window.setTimeout(onClose, 240);
  }, [onClose]);

  // Focus the search field once open (after the enter anim commits).
  const paletteInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (shown) paletteInputRef.current?.focus();
  }, [shown]);

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 60, display: "flex", flexDirection: "column" }}>
      <div onClick={requestClose} style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.42)", opacity: shown ? 1 : 0, transition: "opacity 200ms ease" }} />
      <div
        style={{
          position: "relative",
          margin: "max(64px, calc(env(safe-area-inset-top) + 20px)) 12px 0",
          display: "flex",
          flexDirection: "column",
          maxHeight: "72%",
          background: "var(--bg-1)",
          border: "1px solid var(--line-2)",
          borderRadius: 16,
          boxShadow: "var(--shadow-3)",
          overflow: "hidden",
          transformOrigin: "top center",
          opacity: shown ? 1 : 0,
          transform: shown ? "translateY(0) scale(1)" : "translateY(-14px) scale(0.98)",
          transition: "transform 240ms cubic-bezier(0.32, 0.72, 0, 1), opacity 200ms ease",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "12px 14px", borderBottom: "1px solid var(--line-1)", flex: "none" }}>
          <Icon name="search" size={18} color="var(--fg-3)" strokeWidth={1.7} />
          <input
            ref={paletteInputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (first) { requestClose(); first.run(); }
                else if (noteResults[0]) { requestClose(); onOpenNote(noteResults[0].id); }
              } else if (e.key === "Escape") requestClose();
            }}
            placeholder="Search notes or run a command…"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontFamily: "var(--font-sans)", fontSize: 16, color: "var(--fg-1)" }}
          />
        </div>
        <div style={{ overflowY: "auto", minHeight: 0 }}>
          {cmdMatches.length > 0 && (
            <>
              <div style={sectionLabel}>Commands</div>
              {cmdMatches.map((c) => (
                <button key={c.id} onClick={() => { requestClose(); c.run(); }} style={rowStyle}>
                  <span style={{ flex: "none", display: "flex", color: "var(--fg-2)" }}>{c.icon}</span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 15, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.label}</span>
                  {c.hint && <span style={{ flex: "none", fontSize: 12, color: "var(--fg-3)" }}>{c.hint}</span>}
                </button>
              ))}
            </>
          )}
          {noteResults.length > 0 && (
            <>
              <div style={sectionLabel}>Notes</div>
              {noteResults.map((n) => (
                <button key={n.id} onClick={() => { requestClose(); onOpenNote(n.id); }} style={rowStyle}>
                  <span style={{ flex: "none", display: "flex" }}>
                    <svg width="16" height="16" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="none" stroke="var(--fg-3)" strokeWidth="1.6" strokeLinejoin="round" /></svg>
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: 15, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.title}</span>
                    {n.snippet && <span style={{ display: "block", fontSize: 12, color: "var(--fg-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.snippet}</span>}
                  </span>
                </button>
              ))}
            </>
          )}
          {query !== "" && cmdMatches.length === 0 && noteResults.length === 0 && (
            <div style={{ padding: "24px 16px", textAlign: "center", fontSize: 14, color: "var(--fg-3)" }}>No commands or notes match.</div>
          )}
          <div style={{ height: "calc(8px + env(safe-area-inset-bottom, 0px))" }} />
        </div>
      </div>
    </div>
  );
}

/** Graph tab — a real wikilink graph over the loaded notes (mobile counterpart
 *  to the desktop vault-indices link layer; see lib/wikilinks.ts). */
function GraphTab({ graph, onOpen }: { graph: NoteGraph; onOpen: (id: string) => void }) {
  const linked = graph.nodes.filter((n) => n.degree > 0).length;
  const links = graph.edges.length;
  return (
    <>
      <div style={{ flex: "none", padding: "8px 20px 0", display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <h1 style={{ margin: 0, fontSize: 32, fontWeight: 700, letterSpacing: "-0.025em", color: "var(--fg-display)" }}>Graph</h1>
        {linked > 0 && (
          <span style={{ flexShrink: 0, fontSize: 13, color: "var(--fg-3)" }}>
            {linked} linked {linked === 1 ? "note" : "notes"} · {links} {links === 1 ? "link" : "links"}
          </span>
        )}
      </div>
      <WikiGraph graph={graph} onOpen={onOpen} />
    </>
  );
}

/** A chronological note row (mirror notes/05 ChronoRow geometry). */
const STAR_PATH = "M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 18.4 6.2 21.4l1.1-6.5L2.6 9.8l6.5-.9z";

function NoteRow({
  entry,
  last,
  onOpen,
  favorited = false,
  onToggleFavorite,
  actions,
  indent = 0,
  subtitle,
  divider = true,
}: {
  entry: NoteEntry;
  last: boolean;
  onOpen: () => void;
  favorited?: boolean;
  onToggleFavorite?: () => void;
  actions?: ReactNode;
  /** Extra left padding (px) for the folder-tree hierarchy. */
  indent?: number;
  /** Overrides the second line. `undefined` → fall back to the body snippet
   *  (search results); a string (incl. "") → show it verbatim (the list's
   *  last-edited relative time). */
  subtitle?: string;
  /** Draw the top/last hairline. Off in the tree view (a tree-line separates). */
  divider?: boolean;
}) {
  const sub = subtitle !== undefined ? subtitle : entry.snippet;
  return (
    <div
      onClick={onOpen}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "11px 20px",
        paddingLeft: 20 + indent,
        borderTop: divider ? "1px solid var(--line-1)" : undefined,
        borderBottom: divider && last ? "1px solid var(--line-1)" : undefined,
        cursor: "pointer",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.title}</div>
        {sub && (
          <div
            style={{
              marginTop: 2,
              fontSize: 13,
              color: "var(--fg-3)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {sub}
          </div>
        )}
      </div>
      {actions ? actions : onToggleFavorite && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleFavorite();
          }}
          aria-label={favorited ? "Remove from favorites" : "Add to favorites"}
          style={{ border: "none", background: "transparent", padding: 0, width: 30, height: 30, cursor: "pointer", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <svg width="17" height="17" viewBox="0 0 24 24">
            <path
              d={STAR_PATH}
              fill={favorited ? "var(--accent)" : "none"}
              stroke={favorited ? "var(--accent)" : "var(--line-3)"}
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

/** Bottom tab bar. Notes/Search/Graph switch the list-view tab; Settings opens
 *  the sheet. Active tab is accent-tinted. Bottom padding clears the home
 *  indicator via the safe-area inset (falls back to 30px in the gallery). */
function TabBar({
  active,
  onNotes,
  onGraph,
  onAttachments,
}: {
  active: "notes" | "search" | "graph" | "files" | "templates";
  onNotes: () => void;
  onGraph: () => void;
  onAttachments: () => void;
}) {
  const col = (on: boolean) => (on ? "var(--accent)" : "var(--fg-3)");
  const tab: CSSProperties = {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 3,
    border: "none",
    background: "transparent",
    cursor: "pointer",
    padding: 0,
  };
  const label = (on: boolean): CSSProperties => ({ fontSize: 10, fontWeight: on ? 600 : 500, color: col(on) });
  return (
    <div
      style={{
        flex: "none",
        display: "flex",
        borderTop: "1px solid var(--line-1)",
        background: "var(--bg-1)",
        padding: "8px 0 max(30px, env(safe-area-inset-bottom))",
      }}
    >
      <button onClick={onNotes} aria-label="Notes" style={tab}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <rect x="5" y="3" width="14" height="18" rx="2.5" stroke={col(active === "notes")} strokeWidth="1.8" />
          <path d="M9 8h6M9 12h6M9 16h3" stroke={col(active === "notes")} strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span style={label(active === "notes")}>Notes</span>
      </button>
      <button onClick={onGraph} aria-label="Graph" style={tab}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="6" cy="17" r="2.6" stroke={col(active === "graph")} strokeWidth="1.8" />
          <circle cx="18" cy="14" r="2.6" stroke={col(active === "graph")} strokeWidth="1.8" />
          <circle cx="13" cy="6" r="2.6" stroke={col(active === "graph")} strokeWidth="1.8" />
          <path d="M8.3 15.6l3-7M8.4 16.2l7-1.6" stroke={col(active === "graph")} strokeWidth="1.6" />
        </svg>
        <span style={label(active === "graph")}>Graph</span>
      </button>
      <button onClick={onAttachments} aria-label="Attachments" style={tab}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <rect x="3" y="3" width="18" height="18" rx="2.5" stroke={col(active === "files")} strokeWidth="1.8" />
          <circle cx="8.5" cy="8.5" r="1.8" fill={col(active === "files")} />
          <path d="M21 15l-5-5L5 21" stroke={col(active === "files")} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span style={label(active === "files")}>Files</span>
      </button>
    </div>
  );
}

/** Vault switcher sheet (the "Personal ▾" chevron's target). */
function VaultSwitcher({
  vaults,
  activeId,
  onSelect,
  onCreate,
  onClose,
}: {
  vaults: VaultSummary[];
  activeId?: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet onClose={onClose}>
      {(close) => (
        <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 2px 12px" }}>
        <div style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)" }}>Vaults</div>
        <button
          onClick={close}
          style={{ border: "none", background: "transparent", color: "var(--accent)", fontSize: 15, fontWeight: 600, cursor: "pointer", padding: 0 }}
        >
          Done
        </button>
      </div>
      <div style={{ border: "1px solid var(--line-1)", borderRadius: 10, overflow: "hidden", background: "var(--bg-1)" }}>
        {vaults.map((v, i) => {
          const active = v.id === activeId;
          return (
            <div
              key={v.id}
              onClick={() => onSelect(v.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "13px 14px",
                borderTop: i === 0 ? undefined : "1px solid var(--line-1)",
                cursor: "pointer",
              }}
            >
              <MyneMark size={22} radius={4} />
              <span style={{ flex: 1, fontSize: 16, color: "var(--fg-1)" }}>{v.label ?? "Vault"}</span>
              {active && <Icon name="check" size={18} color="var(--accent)" strokeWidth={2} />}
            </div>
          );
        })}
      </div>
      <button
        onClick={onCreate}
        style={{
          marginTop: 12,
          width: "100%",
          height: 48,
          border: "1px solid var(--line-2)",
          borderRadius: 10,
          background: "transparent",
          color: "var(--accent)",
          fontFamily: "var(--font-sans)",
          fontSize: 15,
          fontWeight: 600,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
        }}
      >
        <Icon name="plus" size={18} color="var(--accent)" strokeWidth={2} />
        Create new vault
      </button>
        </>
      )}
    </Sheet>
  );
}
