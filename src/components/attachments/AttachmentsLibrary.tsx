// Attachments library surface (MYND-170 / MYND-164) — a full-pane center-pane
// view (SYNC-9: an in-editor view toggle; the shell + sidebars persist; NOT a
// modal, NOT a new Stage). Browse / search / sort / filter the vault's
// attachments, preview thumbnails (hover-preview → shared lightbox), see
// "used in N notes", and act via a per-item ⋮ menu: preview, rename, delete.
//
// This is a LIBRARY page, not a note-action surface: it has no
// insert-into-note action (there is no focused editor while it's open — the
// `emitAttachmentEmbed` insert path stays available in the editor itself).
//
// Mounted by `Editor.tsx` when the center view is "attachments". Lives
// inside `<SidebarStateProvider>` so it can read the note-title cache + the
// `open` action (jump-to-note target).
//
// Design canon: monochrome + iron-blue accent, 1px hairlines, no card
// shadows, Inter UI / JetBrains Mono for ids, sentence-case, no emoji.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  attachmentCleanUnused,
  attachmentDelete,
  attachmentImport,
  attachmentRename,
  attachmentUnusedList,
  catalogList,
  type CatalogEntry,
  type CleanResult,
} from "../../lib/attachments";
import { attachmentUrl } from "../../notes/attachmentRef";
import { startTranscription } from "../../lib/transcribe";
import { usePrefs } from "../../hooks/usePrefs";
import { showAttachmentToast } from "../../editor/attachments/toast";
import { AttachmentSyncProgress } from "./AttachmentSyncProgress";
import { referencingNotes } from "../../notes/attachmentRefs";
import { useSelectedNote, type NoteId } from "../../notes/sidebarState";
import { showAttachmentLightbox } from "../../editor/attachments/lightbox";
import { exportAttachment } from "../../editor/attachments/fileCardActions";
import { Icon } from "../primitives/Icon";
import { Button } from "../primitives/Button";
import { Select, type SelectOption } from "../primitives/Select";
import { AttachmentThumbnail } from "./AttachmentThumbnail";
import { UsedInNotesPopover } from "./UsedInNotesPopover";
import { DeleteAttachmentDialog } from "./DeleteAttachmentDialog";
import { CleanUnusedAttachmentsDialog } from "./CleanUnusedAttachmentsDialog";
import {
  formatBytes,
  formatCreatedAt,
  kindOf,
  typeLabel,
  type AttachmentKind,
} from "./format";

type ViewMode = "grid" | "list";
type SortKey = "created-desc" | "created-asc" | "name-asc" | "name-desc";
type TypeFilter = "all" | AttachmentKind;

// Label keys (NOT resolved labels) — resolved with `t()` at render time inside
// the component so a language switch updates the option text. Keeping the
// `value`/`labelKey` pairs at module scope (only the i18n KEY, never the
// resolved string) avoids freezing the boot language.
const TYPE_FILTER_OPTION_KEYS: readonly { value: TypeFilter; labelKey: string }[] = [
  { value: "all", labelKey: "attachments.library.typeFilter.all" },
  { value: "image", labelKey: "attachments.library.typeFilter.image" },
  { value: "pdf", labelKey: "attachments.library.typeFilter.pdf" },
  { value: "audio", labelKey: "attachments.library.typeFilter.audio" },
  { value: "other", labelKey: "attachments.library.typeFilter.other" },
];

const SORT_OPTION_KEYS: readonly { value: SortKey; labelKey: string }[] = [
  { value: "created-desc", labelKey: "attachments.library.sort.createdDesc" },
  { value: "created-asc", labelKey: "attachments.library.sort.createdAsc" },
  { value: "name-asc", labelKey: "attachments.library.sort.nameAsc" },
  { value: "name-desc", labelKey: "attachments.library.sort.nameDesc" },
];

interface AttachmentsLibraryProps {
  /**
   * Return to the editor view. The library is a SCREEN, not a modal — there
   * is no × affordance; the user leaves by selecting a note in the sidebar
   * (which resets the center view). This callback survives only for the
   * jump-to-note path (clicking a "used in N notes" entry), which opens the
   * note AND swaps the center pane back to the editor.
   */
  onClose: () => void;
}

// ---- layout tokens --------------------------------------------------------

// Responsive top bar: a single flex row that WRAPS to a second line at narrow
// center widths (right Backlinks sidebar open) so nothing slides off-screen
// behind the sidebar. `minWidth: 0` lets the search field shrink instead of
// pushing the trailing controls out of the pane. Height is `auto` (min 48) so
// a wrapped second row grows the bar rather than clipping it.
const TOOLBAR_STYLE: CSSProperties = {
  minHeight: 48,
  flexShrink: 0,
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  rowGap: "var(--space-2)",
  gap: "var(--space-2)",
  padding: "var(--space-2) var(--space-4)",
  borderBottom: "1px solid var(--line-1)",
};

const TITLE_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 14,
  fontWeight: 600,
  color: "var(--fg-1)",
  marginRight: "var(--space-2)",
  flexShrink: 0,
};

// The search field is the ONLY flexible element — it grows to fill the row and
// shrinks (down to `minWidth`) when the sidebar narrows the pane, keeping the
// filter / sort / toggle / import controls fully visible.
const SEARCH_WRAP_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  flex: "1 1 160px",
  minWidth: 120,
  maxWidth: 320,
  height: 30,
  padding: "0 var(--space-3)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  color: "var(--fg-3)",
};

// Trailing control cluster (filter + sort + view toggle + import). It does NOT
// shrink and wraps to the next line as a unit when the row runs out of width.
// Fix 5 (MYND-164): no `marginLeft: auto` push — at narrow widths that shoved
// the wrapped cluster to the far right of line 2, leaving a lopsided gap under
// the search. Left-aligning it instead keeps the two lines sharing the same
// left edge. The flexible search field still grows to fill line 1, so at full
// width the cluster sits flush right; only the *wrapped* case changes.
const CONTROLS_GROUP_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  flexShrink: 0,
};

// Bordered view-toggle button — matches the sort `<select>` + Import button
// chrome (same border token, radius, height) so the top-bar controls read as
// one consistent set instead of a bare icon (Fix 3 / MYND-164).
const VIEW_TOGGLE_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 30,
  height: 30,
  flexShrink: 0,
  color: "var(--fg-2)",
  background: "var(--bg-1)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  cursor: "pointer",
};

const SEARCH_INPUT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: 0,
  outline: "none",
  // Opt out of BOTH focus rings on the input itself: the native WKWebView ring
  // (appearance:none) AND the app's global `input:focus-visible { box-shadow:
  // var(--ring) }` rule (tokens.css) — that global box-shadow was the second,
  // inner ring. The WRAPPER owns the single focus ring now.
  WebkitAppearance: "none",
  appearance: "none",
  boxShadow: "none",
  background: "transparent",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  color: "var(--fg-1)",
};

const SCROLL_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  padding: "var(--space-4)",
};

const GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
  gap: "var(--space-4)",
};

const CENTER_MESSAGE_STYLE: CSSProperties = {
  height: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "var(--space-3)",
  color: "var(--fg-3)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  textAlign: "center",
};

// ---- main component -------------------------------------------------------

// Transient bottom-center toast for the "nothing to clean" / scan-error
// feedback (auto-dismissed after 2.5 s, matching Toast.tsx).
const CLEAN_NOTICE_STYLE: CSSProperties = {
  position: "absolute",
  bottom: "var(--space-5)",
  left: "50%",
  transform: "translateX(-50%)",
  padding: "var(--space-2) var(--space-4)",
  borderRadius: 8,
  background: "var(--paper-2)",
  border: "1px solid var(--line-1)",
  boxShadow: "var(--shadow-2, 0 4px 16px rgba(0,0,0,0.18))",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  color: "var(--fg-1)",
  zIndex: 10,
};

export function AttachmentsLibrary({ onClose }: AttachmentsLibraryProps) {
  const { t } = useTranslation();
  const ctx = useSelectedNote();
  // AI opt-in gate for the per-item Transcribe action (voice-to-text MYND-552,
  // SYNC-V9). Gated on `ai_enabled` ALONE — a library attachment has no single
  // folder, so the `ai_excluded_folders` gate does NOT apply (transcribing the
  // media bytes is an explicit per-attachment user action, not ambient reading).
  const { prefs } = usePrefs();
  const aiEnabled = prefs.ai_enabled;
  // Resolve the option labels at render time (reactive to language switch).
  const typeFilterOptions: readonly SelectOption<TypeFilter>[] = useMemo(
    () => TYPE_FILTER_OPTION_KEYS.map((o) => ({ value: o.value, label: t(o.labelKey) })),
    [t],
  );
  const sortOptions: readonly SelectOption<SortKey>[] = useMemo(
    () => SORT_OPTION_KEYS.map((o) => ({ value: o.value, label: t(o.labelKey) })),
    [t],
  );
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [view, setView] = useState<ViewMode>("grid");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("created-desc");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  // Fix (MYND-164 dogfooding): the focus ring belongs on the WHOLE search bar,
  // not the inner <input> (which would look like a box-in-a-box). Inline styles
  // can't use `:focus-within`, so we track focus in React and light up the
  // bordered wrapper, matching `Input.tsx`'s accent border + ring treatment.
  const [searchFocused, setSearchFocused] = useState(false);
  // Fix 6 (MYND-164): a single shared "which attachment's used-in-notes popover
  // is open" — lifted out of each tile so opening one closes any other (only
  // one popover open at a time across the whole library).
  const [openPopoverId, setOpenPopoverId] = useState<string | null>(null);
  // Single-open ⋮ action menu — opening one row's menu closes any other.
  const [openActionMenuId, setOpenActionMenuId] = useState<string | null>(null);

  // Delete flow: the target entry + its (already-fetched) referencing notes.
  const [deleteTarget, setDeleteTarget] = useState<{
    entry: CatalogEntry;
    noteIds: string[];
  } | null>(null);

  // Clean-unused flow (MYND-171): the fetched unused set drives the review
  // dialog; `checkingUnused` gates the CTA during the authoritative scan;
  // `cleanNotice` is the transient "nothing to clean" / error feedback.
  const [cleanupTarget, setCleanupTarget] = useState<CatalogEntry[] | null>(null);
  const [checkingUnused, setCheckingUnused] = useState(false);
  const [cleanNotice, setCleanNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await catalogList();
      setEntries(rows);
      setLoadError(false);
    } catch {
      setEntries([]);
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Derived, filtered + sorted view of the catalog.
  const visible = useMemo(() => {
    const rows = entries ?? [];
    const q = query.trim().toLowerCase();
    const filtered = rows.filter((e) => {
      if (typeFilter !== "all" && kindOf(e.content_type) !== typeFilter) {
        return false;
      }
      if (q !== "" && !e.filename.toLowerCase().includes(q)) return false;
      return true;
    });
    const sorted = [...filtered].sort((a, b) => {
      switch (sort) {
        case "created-desc":
          return b.created_at - a.created_at;
        case "created-asc":
          return a.created_at - b.created_at;
        case "name-asc":
          return a.filename.localeCompare(b.filename);
        case "name-desc":
          return b.filename.localeCompare(a.filename);
      }
    });
    return sorted;
  }, [entries, query, sort, typeFilter]);

  // ---- actions -----------------------------------------------------------

  const handleImport = useCallback(async () => {
    setImporting(true);
    try {
      const picked = await openFileDialog({
        multiple: false,
        directory: false,
        title: t("attachments.library.importDialogTitle"),
        filters: [
          {
            name: t("attachments.library.supportedFilesFilter"),
            extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg", "pdf"],
          },
        ],
      });
      if (typeof picked === "string") {
        await attachmentImport({ kind: "path", path: picked });
        await refresh();
      }
    } catch (err) {
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn("[AttachmentsLibrary] import failed:", err);
      }
    } finally {
      setImporting(false);
    }
  }, [refresh, t]);

  const handlePreview = useCallback((entry: CatalogEntry) => {
    // PDF → scrollable multi-page reader; image/SVG → image lightbox (MYND-164).
    showAttachmentLightbox({
      url: attachmentUrl(entry.id),
      alt: entry.filename,
      kind: kindOf(entry.content_type) === "pdf" ? "pdf" : "image",
      id: entry.id,
    });
  }, []);

  // Export (Save As) — the shared host-side action, available for every type
  // (the library counterpart of the editor file-card / lightbox Export; MYND-173).
  const handleExport = useCallback((entry: CatalogEntry) => {
    void exportAttachment(entry.id, entry.filename);
  }, []);

  // Transcribe (voice-to-text MYND-552, SYNC-V9) — routes through the SAME
  // shared helper the in-note widget uses (no divergent call path). Fire-and-
  // forget with transient feedback: the transcript lands in the searchable MYE1
  // cache backend-side; the library has no editor to insert into. A no-model
  // rejection points at the model picker (mirrors the widget's hint).
  const handleTranscribe = useCallback(
    (entry: CatalogEntry) => {
      showAttachmentToast(t("attachments.library.transcribeStarted"));
      const run = startTranscription(entry.id);
      run.done
        .then(() => showAttachmentToast(t("attachments.library.transcribeDone")))
        .catch((err: unknown) => {
          const notReady =
            err !== null && typeof err === "object" && "kind" in err &&
            (err as { kind: unknown }).kind === "not_ready";
          showAttachmentToast(
            notReady
              ? t("attachments.library.transcribeNoModel")
              : t("attachments.library.transcribeFailed"),
          );
        });
    },
    [t],
  );

  const handleRenameCommit = useCallback(
    async (id: string, filename: string) => {
      const trimmed = filename.trim();
      setRenamingId(null);
      if (trimmed === "") return;
      const prev = entries?.find((e) => e.id === id);
      if (prev !== undefined && prev.filename === trimmed) return;
      // Optimistic: update the local row, roll back on failure.
      setEntries((rows) =>
        (rows ?? []).map((e) => (e.id === id ? { ...e, filename: trimmed } : e)),
      );
      try {
        await attachmentRename(id, trimmed);
      } catch {
        await refresh(); // reconcile to disk truth
      }
    },
    [entries, refresh],
  );

  const openDeleteDialog = useCallback(async (entry: CatalogEntry) => {
    const noteIds = await referencingNotes(entry.id);
    setDeleteTarget({ entry, noteIds });
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (deleteTarget === null) return;
    await attachmentDelete(deleteTarget.entry.id);
    setEntries((rows) =>
      (rows ?? []).filter((e) => e.id !== deleteTarget.entry.id),
    );
  }, [deleteTarget]);

  // Clean unused: run the authoritative scan; open the review dialog when
  // there's something to clean, else surface a transient "nothing to clean"
  // notice. A scan failure (e.g. an unreadable note → NoteScanFailed) surfaces
  // a notice rather than opening a (possibly unsafe) list.
  const handleCleanUnused = useCallback(async () => {
    setCheckingUnused(true);
    setCleanNotice(null);
    try {
      const unused = await attachmentUnusedList();
      if (unused.length === 0) {
        setCleanNotice(t("attachments.library.noUnusedNotice"));
      } else {
        setCleanupTarget(unused);
      }
    } catch {
      setCleanNotice(t("attachments.library.checkUnusedFailedNotice"));
    } finally {
      setCheckingUnused(false);
    }
  }, [t]);

  const handleCleanConfirm = useCallback(
    async (ids: string[]): Promise<CleanResult> => {
      const result = await attachmentCleanUnused(ids);
      await refresh(); // reconcile the library to disk truth
      return result;
    },
    [refresh],
  );

  // Auto-dismiss the transient clean-up notice (2.5 s, matching Toast).
  useEffect(() => {
    if (cleanNotice === null) return;
    const timer = setTimeout(() => setCleanNotice(null), 2500);
    return () => clearTimeout(timer);
  }, [cleanNotice]);

  const handleJump = useCallback(
    (id: NoteId) => {
      void ctx.open(id).catch(() => {});
      onClose(); // jumping to a note returns to the editor view
    },
    [ctx, onClose],
  );

  // ---- render ------------------------------------------------------------

  const isLoading = entries === null;
  const isEmpty = !isLoading && (entries?.length ?? 0) === 0;
  const isNoMatch = !isLoading && !isEmpty && visible.length === 0;

  // Shared per-item wiring — keeps the grid tile + the list row from drifting.
  const itemProps = (entry: CatalogEntry): ItemActionProps => ({
    entry,
    renaming: renamingId === entry.id,
    cache: ctx.cache,
    popoverOpen: openPopoverId === entry.id,
    onTogglePopover: () =>
      setOpenPopoverId((cur) => (cur === entry.id ? null : entry.id)),
    onClosePopover: () => setOpenPopoverId(null),
    onStartRename: () => setRenamingId(entry.id),
    onRenameCommit: (name) => void handleRenameCommit(entry.id, name),
    onRenameCancel: () => setRenamingId(null),
    onPreview: () => handlePreview(entry),
    onExport: () => handleExport(entry),
    onDelete: () => void openDeleteDialog(entry),
    onJump: handleJump,
    // Transcribe is an audio-only, `ai_enabled`-gated action (SYNC-V9).
    transcribable: kindOf(entry.content_type) === "audio",
    aiEnabled,
    onTranscribe: () => handleTranscribe(entry),
    // Only image/PDF open the shared lightbox preview. Audio plays inline in
    // its own tile (its own play button), and a generic ("other") file has no
    // inline preview — same fallback as the editor file-card; Preview hidden.
    previewable:
      kindOf(entry.content_type) === "image" || kindOf(entry.content_type) === "pdf",
    actionMenuOpen: openActionMenuId === entry.id,
    onToggleActionMenu: () =>
      setOpenActionMenuId((cur) => (cur === entry.id ? null : entry.id)),
    onCloseActionMenu: () => setOpenActionMenuId(null),
  });

  return (
    <main
      style={{
        flex: 1,
        minWidth: 0,
        // Allow this flex-column item to shrink below its content height so the
        // SCROLL_STYLE child (overflowY: auto) actually scrolls instead of the
        // grid overflowing the pane (flexbox min-height:auto trap).
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-1)",
        // Anchor the transient clean-up notice (absolute, bottom-center).
        position: "relative",
      }}
    >
      <div style={TOOLBAR_STYLE}>
        <span style={TITLE_STYLE}>{t("attachments.library.title")}</span>
        <div
          style={
            searchFocused
              ? {
                  ...SEARCH_WRAP_STYLE,
                  borderColor: "var(--accent)",
                  // A single focus indicator: the accent border + an adjacent
                  // soft halo (NO bg-1 offset gap, which read as a second ring
                  // next to the border → the "double border").
                  boxShadow:
                    "0 0 0 3px var(--accent-soft, rgba(44, 74, 122, 0.22))",
                }
              : SEARCH_WRAP_STYLE
          }
        >
          <Icon name="search" size={14} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            placeholder={t("attachments.library.searchPlaceholder")}
            aria-label={t("attachments.library.searchAriaLabel")}
            style={SEARCH_INPUT_STYLE}
          />
        </div>
        <div style={CONTROLS_GROUP_STYLE}>
          <Select
            value={typeFilter}
            options={typeFilterOptions}
            onChange={setTypeFilter}
            aria-label={t("attachments.library.filterAriaLabel")}
          />
          <Select
            value={sort}
            options={sortOptions}
            onChange={setSort}
            aria-label={t("attachments.library.sortAriaLabel")}
          />
          <ViewToggleButton view={view} onToggle={() => setView((v) => (v === "grid" ? "list" : "grid"))} />
          <Button
            variant="secondary"
            icon="trash-2"
            onClick={() => void handleCleanUnused()}
            disabled={checkingUnused || importing}
            data-testid="attachments.clean-unused-cta"
            title={t("attachments.library.cleanUnusedTitle")}
          >
            {checkingUnused
              ? t("attachments.library.checking")
              : t("attachments.library.cleanUnused")}
          </Button>
          <Button
            variant="secondary"
            icon="download"
            onClick={() => void handleImport()}
            disabled={importing}
          >
            {importing ? t("attachments.library.importing") : t("attachments.library.import")}
          </Button>
        </div>
      </div>

      {/* In-flight attachment transfers (MYND-423). Hidden entirely while idle
          (the common case); the MYND-424 sync engine becomes the registry's
          writer when it lands. */}
      <AttachmentSyncProgress hideWhenEmpty />

      <div style={SCROLL_STYLE}>
        {isLoading ? (
          <div style={CENTER_MESSAGE_STYLE}>{t("attachments.library.decrypting")}</div>
        ) : isEmpty ? (
          <EmptyState
            loadError={loadError}
            importing={importing}
            onImport={() => void handleImport()}
          />
        ) : isNoMatch ? (
          <div style={CENTER_MESSAGE_STYLE}>{t("attachments.library.noMatch")}</div>
        ) : view === "grid" ? (
          <div style={GRID_STYLE}>
            {visible.map((entry) => (
              <AttachmentTile key={entry.id} {...itemProps(entry)} />
            ))}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <ListHeader />
            {visible.map((entry) => (
              <AttachmentListRow key={entry.id} {...itemProps(entry)} />
            ))}
          </div>
        )}
      </div>

      {deleteTarget !== null && (
        <DeleteAttachmentDialog
          attachment={deleteTarget.entry}
          referencingNoteIds={deleteTarget.noteIds}
          cache={ctx.cache}
          onConfirm={handleDeleteConfirm}
          onClose={() => setDeleteTarget(null)}
        />
      )}

      {cleanupTarget !== null && (
        <CleanUnusedAttachmentsDialog
          attachments={cleanupTarget}
          onConfirm={handleCleanConfirm}
          onClose={() => setCleanupTarget(null)}
        />
      )}

      {cleanNotice !== null && (
        <div
          role="status"
          data-testid="attachments.clean-notice"
          style={CLEAN_NOTICE_STYLE}
        >
          {cleanNotice}
        </div>
      )}
    </main>
  );
}

// ---- bordered view-toggle button ------------------------------------------

/**
 * Grid/list view toggle styled to match its bordered neighbours (the sort
 * `<select>` + the Import button) — Fix 3 (MYND-164). Hover deepens the
 * background like the secondary Button. Shows the icon for the view it would
 * switch TO (grid icon while in list, list icon while in grid).
 */
function ViewToggleButton({
  view,
  onToggle,
}: {
  view: ViewMode;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const label =
    view === "grid"
      ? t("attachments.library.listView")
      : t("attachments.library.gridView");
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      title={label}
      style={VIEW_TOGGLE_STYLE}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--paper-2)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "var(--bg-1)";
      }}
    >
      <Icon name={view === "grid" ? "list" : "layout-grid"} size={16} />
    </button>
  );
}

// ---- empty state ----------------------------------------------------------

function EmptyState({
  loadError,
  importing,
  onImport,
}: {
  loadError: boolean;
  importing: boolean;
  onImport: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div style={CENTER_MESSAGE_STYLE}>
      <Icon name="paperclip" size={28} />
      <div style={{ fontSize: 14, color: "var(--fg-2)" }}>
        {loadError
          ? t("attachments.library.emptyLoadError")
          : t("attachments.library.emptyNoAttachments")}
      </div>
      <div>{t("attachments.library.emptyImportHint")}</div>
      <Button
        variant="secondary"
        icon="download"
        onClick={onImport}
        disabled={importing}
      >
        {importing
          ? t("attachments.library.importing")
          : t("attachments.library.importFile")}
      </Button>
    </div>
  );
}

// ---- shared row/tile sub-pieces ------------------------------------------

interface ItemActionProps {
  entry: CatalogEntry;
  renaming: boolean;
  cache: ReadonlyMap<NoteId, import("../../notes/loadNoteBatch").TitleRecord>;
  /** Whether THIS item's used-in-notes popover is the one open (Fix 6). */
  popoverOpen: boolean;
  /** Toggle this item's used-in-notes popover (closing any other). */
  onTogglePopover: () => void;
  /** Force-close the used-in-notes popover (outside-click / Esc / scroll). */
  onClosePopover: () => void;
  onStartRename: () => void;
  onRenameCommit: (name: string) => void;
  onRenameCancel: () => void;
  /** Open the shared lightbox preview of this attachment (Fix 2/4). */
  onPreview: () => void;
  /** Export (Save As) this attachment's decrypted bytes (MYND-173). */
  onExport: () => void;
  onDelete: () => void;
  onJump: (id: NoteId) => void;
  /** Whether this attachment can be previewed inline (image/PDF). A generic
   *  (octet-stream) file cannot — the ⋮ menu omits Preview for it (MYND-173). */
  previewable: boolean;
  /** Whether this attachment is audio → the ⋮ menu shows Transcribe (MYND-552). */
  transcribable: boolean;
  /** Whether AI is enabled (SYNC-V9 gate for Transcribe — `ai_enabled` alone). */
  aiEnabled: boolean;
  /** Start transcribing this attachment (audio only). */
  onTranscribe: () => void;
  /** Whether THIS row's ⋮ action menu is the one open (single-open). */
  actionMenuOpen: boolean;
  /** Toggle this row's ⋮ action menu (closing any other). */
  onToggleActionMenu: () => void;
  /** Force-close this row's ⋮ action menu (outside-click / Esc / select). */
  onCloseActionMenu: () => void;
}

/** Inline editable filename — Enter commits, Esc cancels, blur commits. */
function RenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      type="text"
      defaultValue={initial}
      data-testid="attachments.rename-input"
      style={{
        width: "100%",
        fontFamily: "var(--font-sans)",
        fontSize: 13,
        color: "var(--fg-1)",
        background: "var(--paper-1, var(--bg-1))",
        border: "1px solid var(--accent)",
        borderRadius: 3,
        padding: "2px 5px",
        outline: "none",
      }}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit((e.target as HTMLInputElement).value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={(e) => onCommit(e.target.value)}
    />
  );
}

/**
 * The "used in N notes" trigger + its popover. The popover's OPEN state is
 * owned by the library (Fix 6) and threaded down via `open` / `onToggle` /
 * `onClose`, so opening one tile's popover closes any other. The referencing
 * note-ids are still fetched locally per-tile (cheap reconcile query) — only
 * the open/closed flag is lifted.
 */
function UsedInNotes({
  attachmentId,
  cache,
  open,
  onToggle,
  onClose,
  onJump,
}: {
  attachmentId: string;
  cache: ReadonlyMap<NoteId, import("../../notes/loadNoteBatch").TitleRecord>;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onJump: (id: NoteId) => void;
}) {
  const { t } = useTranslation();
  const [noteIds, setNoteIds] = useState<string[] | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    void referencingNotes(attachmentId).then((ids) => {
      if (!cancelled) setNoteIds(ids);
    });
    return () => {
      cancelled = true;
    };
  }, [attachmentId]);

  const n = noteIds?.length ?? 0;
  return (
    <div style={{ position: "relative" }}>
      <button
        ref={buttonRef}
        type="button"
        data-testid="attachments.used-in-notes-trigger"
        data-id={attachmentId}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        style={{
          background: "transparent",
          border: 0,
          padding: 0,
          cursor: n > 0 ? "pointer" : "default",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          color: n > 0 ? "var(--accent)" : "var(--fg-3)",
          textDecoration: n > 0 ? "underline" : "none",
        }}
        disabled={noteIds === null}
      >
        {noteIds === null
          ? t("attachments.library.usedInLoading")
          : t("attachments.library.usedInCount", { count: n })}
      </button>
      {open && noteIds !== null && (
        <UsedInNotesPopover
          noteIds={noteIds}
          cache={cache}
          onJump={onJump}
          onClose={onClose}
          anchorRef={buttonRef}
        />
      )}
    </div>
  );
}

// ---- per-item ⋮ action menu -----------------------------------------------

const MENU_STYLE: CSSProperties = {
  position: "fixed",
  zIndex: 60,
  minWidth: 160,
  background: "var(--bg-1)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  boxShadow: "var(--shadow-2, 0 4px 16px rgba(0,0,0,0.18))",
  padding: "var(--space-1) 0",
};

const MENU_ITEM_STYLE: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "var(--space-2) var(--space-3)",
  background: "transparent",
  border: 0,
  cursor: "pointer",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  color: "var(--fg-1)",
  whiteSpace: "nowrap",
};

interface ItemMenuEntry {
  id: string;
  label: string;
  destructive?: boolean;
  /** Disabled-not-hidden (MYND-552 Transcribe when AI is off): the row shows its
   *  real label, muted + non-activating. */
  disabled?: boolean;
  onSelect: () => void;
}

/**
 * Portal-rendered dropdown anchored under the ⋮ trigger. Like the used-in-notes
 * popover (Fix 2), it renders to `document.body` so the tile's `overflow:
 * hidden` + the grid's scroll container don't clip it. Closes on outside-click
 * / Esc / scroll / resize.
 */
function AttachmentActionMenu({
  items,
  onClose,
  anchorRef,
}: {
  items: readonly ItemMenuEntry[];
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null,
  );

  // Anchor below the trigger, right-aligned to it (clamped into the viewport).
  // Space-aware: flip above the trigger when there isn't room below (estimated
  // from the item count, since the menu isn't measured until after this pass).
  useLayoutEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = 160;
    const left = Math.min(r.right - width, window.innerWidth - width - 8);
    const estHeight = items.length * 34 + 8;
    const openUp = r.bottom + estHeight + 8 > window.innerHeight;
    const top = openUp ? Math.max(8, r.top - estHeight - 4) : r.bottom + 4;
    setCoords({ top, left: Math.max(8, left) });
  }, [anchorRef, items.length]);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        ref.current &&
        !ref.current.contains(t) &&
        anchorRef.current &&
        !anchorRef.current.contains(t)
      ) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    const onReflow = () => onClose();
    const tid = setTimeout(
      () => document.addEventListener("click", onDocClick),
      0,
    );
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      clearTimeout(tid);
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [onClose, anchorRef]);

  if (coords === null) return null;

  return createPortal(
    <div
      ref={ref}
      style={{ ...MENU_STYLE, top: coords.top, left: coords.left }}
      role="menu"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          aria-disabled={item.disabled}
          data-testid={`attachments.action-${item.id}`}
          style={{
            ...MENU_ITEM_STYLE,
            color: item.disabled
              ? "var(--fg-3)"
              : item.destructive
                ? "var(--danger)"
                : "var(--fg-1)",
            cursor: item.disabled ? "default" : "pointer",
            opacity: item.disabled ? 0.6 : 1,
          }}
          onMouseEnter={(e) => {
            if (!item.disabled) e.currentTarget.style.background = "var(--paper-2)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
          onClick={() => {
            if (item.disabled) return;
            item.onSelect();
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

const MENU_TRIGGER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 24,
  height: 24,
  padding: 0,
  color: "var(--fg-3)",
  background: "transparent",
  border: 0,
  borderRadius: "var(--radius-1)",
  cursor: "pointer",
};

/**
 * The ⋮ button + its dropdown. Items: (Preview ·) Export · Rename · Delete —
 * Preview is omitted for a non-`previewable` (generic / octet-stream) file,
 * which has no inline rendering. The open state is OWNED BY THE LIBRARY and
 * threaded via `open`/`onToggle`/`onClose`, so opening one row's menu closes
 * any other (single-open — the `UsedInNotes` popover pattern).
 */
function ItemMenu({
  open,
  onToggle,
  onClose,
  previewable,
  onPreview,
  onExport,
  onStartRename,
  onDelete,
  transcribable,
  aiEnabled,
  onTranscribe,
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  previewable: boolean;
  onPreview: () => void;
  onExport: () => void;
  onStartRename: () => void;
  onDelete: () => void;
  transcribable: boolean;
  aiEnabled: boolean;
  onTranscribe: () => void;
}) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const items: ItemMenuEntry[] = [
    ...(previewable
      ? [
          {
            id: "preview",
            label: t("attachments.library.menuPreview"),
            onSelect: onPreview,
          },
        ]
      : []),
    // Transcribe — audio only (SYNC-V9), gated on `ai_enabled` ALONE (no
    // folder-exclusion gate). HIDDEN when local AI is off (MYND-270 product
    // tweak: no dangling affordance when the subsystem is off), not disabled.
    ...(transcribable && aiEnabled
      ? [
          {
            id: "transcribe",
            label: t("attachments.library.menuTranscribe"),
            onSelect: onTranscribe,
          },
        ]
      : []),
    { id: "export", label: t("attachments.library.menuExport"), onSelect: onExport },
    { id: "rename", label: t("attachments.library.menuRename"), onSelect: onStartRename },
    {
      id: "delete",
      label: t("attachments.library.menuDelete"),
      destructive: true,
      onSelect: onDelete,
    },
  ];
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={t("attachments.library.actionsAriaLabel")}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t("attachments.library.actionsTitle")}
        data-testid="attachments.actions-trigger"
        style={MENU_TRIGGER_STYLE}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--paper-3)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "transparent";
        }}
      >
        <Icon name="more-vertical" size={16} />
      </button>
      {open && (
        <AttachmentActionMenu
          items={items}
          anchorRef={triggerRef}
          onClose={onClose}
        />
      )}
    </>
  );
}

// ---- hover-preview overlay -------------------------------------------------

const THUMB_HOVER_WRAP_STYLE: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
};

/**
 * Thumbnail that opens the shared lightbox on CLICK (MYND-164 revised): clicking
 * the image/PDF thumbnail opens the same overlay the editor uses — raster + SVG
 * open the image lightbox, PDF opens the scrollable multi-page reader — with no
 * separate hover-revealed expand button. The tile thumbnail itself stays the
 * first-page render. Non-previewable kinds (audio, generic files) stay
 * non-interactive (audio's own play button already stops propagation).
 * Keyboard-accessible (Enter / Space); the ⋮ menu keeps an explicit Preview item.
 */
function ThumbnailWithPreview({
  entry,
  size,
  onPreview,
}: {
  entry: CatalogEntry;
  size: number;
  onPreview: () => void;
}) {
  const { t } = useTranslation();
  const kind = kindOf(entry.content_type);
  const previewable = kind === "image" || kind === "pdf";
  return (
    <div
      style={{ ...THUMB_HOVER_WRAP_STYLE, cursor: previewable ? "pointer" : "default" }}
      data-testid={previewable ? "attachments.tile-preview-target" : undefined}
      role={previewable ? "button" : undefined}
      tabIndex={previewable ? 0 : undefined}
      aria-label={previewable ? t("attachments.library.previewAttachment") : undefined}
      onClick={previewable ? () => onPreview() : undefined}
      onKeyDown={
        previewable
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onPreview();
              }
            }
          : undefined
      }
    >
      <AttachmentThumbnail
        id={entry.id}
        contentType={entry.content_type}
        filename={entry.filename}
        size={size}
      />
    </div>
  );
}

// ---- grid tile ------------------------------------------------------------

const TILE_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  overflow: "hidden",
  background: "var(--bg-1)",
};

const THUMB_BOX_STYLE: CSSProperties = {
  aspectRatio: "4 / 3",
  width: "100%",
  borderBottom: "1px solid var(--line-1)",
  overflow: "hidden",
  background: "var(--paper-2)",
};

const TILE_META_STYLE: CSSProperties = {
  padding: "var(--space-2) var(--space-3)",
  display: "flex",
  flexDirection: "column",
  gap: 4,
  minWidth: 0,
};

const FILENAME_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  fontWeight: 500,
  color: "var(--fg-1)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const SUBTEXT_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--fg-3)",
};

const TILE_FOOTER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-2)",
  marginTop: 2,
};

function AttachmentTile({
  entry,
  renaming,
  cache,
  popoverOpen,
  onTogglePopover,
  onClosePopover,
  onStartRename,
  onRenameCommit,
  onRenameCancel,
  onPreview,
  onExport,
  onDelete,
  onJump,
  previewable,
  transcribable,
  aiEnabled,
  onTranscribe,
  actionMenuOpen,
  onToggleActionMenu,
  onCloseActionMenu,
}: ItemActionProps) {
  return (
    <div style={TILE_STYLE} data-testid="attachments.tile" data-id={entry.id}>
      <div style={THUMB_BOX_STYLE}>
        <ThumbnailWithPreview
          entry={entry}
          size={160}
          onPreview={onPreview}
        />
      </div>
      <div style={TILE_META_STYLE}>
        {renaming ? (
          <RenameInput
            initial={entry.filename}
            onCommit={onRenameCommit}
            onCancel={onRenameCancel}
          />
        ) : (
          <div
            style={{ ...FILENAME_STYLE, cursor: "text" }}
            title={entry.filename}
            onDoubleClick={onStartRename}
          >
            {entry.filename}
          </div>
        )}
        <span style={SUBTEXT_STYLE}>
          {typeLabel(entry.content_type)} · {formatBytes(entry.size)} ·{" "}
          {formatCreatedAt(entry.created_at)}
        </span>
        <div style={TILE_FOOTER_STYLE}>
          <UsedInNotes
            attachmentId={entry.id}
            cache={cache}
            open={popoverOpen}
            onToggle={onTogglePopover}
            onClose={onClosePopover}
            onJump={onJump}
          />
          <ItemMenu
            open={actionMenuOpen}
            onToggle={onToggleActionMenu}
            onClose={onCloseActionMenu}
            previewable={previewable}
            onPreview={onPreview}
            onExport={onExport}
            onStartRename={onStartRename}
            onDelete={onDelete}
            transcribable={transcribable}
            aiEnabled={aiEnabled}
            onTranscribe={onTranscribe}
          />
        </div>
      </div>
    </div>
  );
}

// ---- list row -------------------------------------------------------------

const LIST_ROW_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "32px 2fr 64px 80px 1fr 1.4fr auto",
  alignItems: "center",
  gap: "var(--space-3)",
  padding: "var(--space-2) var(--space-2)",
  borderBottom: "1px solid var(--line-1)",
  minWidth: 0,
};

const LIST_HEADER_STYLE: CSSProperties = {
  ...LIST_ROW_STYLE,
  padding: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--fg-3)",
};

function ListHeader() {
  const { t } = useTranslation();
  return (
    <div style={LIST_HEADER_STYLE}>
      <span />
      <span>{t("attachments.library.colName")}</span>
      <span>{t("attachments.library.colType")}</span>
      <span>{t("attachments.library.colSize")}</span>
      <span>{t("attachments.library.colCreated")}</span>
      <span>{t("attachments.library.colUsedIn")}</span>
      <span />
    </div>
  );
}

function AttachmentListRow({
  entry,
  renaming,
  cache,
  popoverOpen,
  onTogglePopover,
  onClosePopover,
  onStartRename,
  onRenameCommit,
  onRenameCancel,
  onPreview,
  onExport,
  onDelete,
  onJump,
  previewable,
  transcribable,
  aiEnabled,
  onTranscribe,
  actionMenuOpen,
  onToggleActionMenu,
  onCloseActionMenu,
}: ItemActionProps) {
  return (
    <div style={LIST_ROW_STYLE} data-testid="attachments.tile" data-id={entry.id}>
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 3,
          overflow: "hidden",
          border: "1px solid var(--line-1)",
        }}
      >
        <ThumbnailWithPreview
          entry={entry}
          size={28}
          onPreview={onPreview}
        />
      </div>
      {renaming ? (
        <RenameInput
          initial={entry.filename}
          onCommit={onRenameCommit}
          onCancel={onRenameCancel}
        />
      ) : (
        <div
          style={{ ...FILENAME_STYLE, cursor: "text" }}
          title={entry.filename}
          onDoubleClick={onStartRename}
        >
          {entry.filename}
        </div>
      )}
      <span style={SUBTEXT_STYLE}>{typeLabel(entry.content_type)}</span>
      <span style={SUBTEXT_STYLE}>{formatBytes(entry.size)}</span>
      <span style={SUBTEXT_STYLE}>{formatCreatedAt(entry.created_at)}</span>
      <UsedInNotes
        attachmentId={entry.id}
        cache={cache}
        open={popoverOpen}
        onToggle={onTogglePopover}
        onClose={onClosePopover}
        onJump={onJump}
      />
      <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end" }}>
        <ItemMenu
          open={actionMenuOpen}
          onToggle={onToggleActionMenu}
          onClose={onCloseActionMenu}
          previewable={previewable}
          onPreview={onPreview}
          onExport={onExport}
          onStartRename={onStartRename}
          onDelete={onDelete}
          transcribable={transcribable}
          aiEnabled={aiEnabled}
          onTranscribe={onTranscribe}
        />
      </div>
    </div>
  );
}
