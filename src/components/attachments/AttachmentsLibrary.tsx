// Attachments library surface (MYND-170 / MYND-164) — a full-pane TAB body
// (SYNC-9 shipped it as an in-editor view toggle; myne-md/myne#773 made it a
// tab. The shell + sidebars persist; NOT a modal, NOT a new Stage). Browse / search / sort / filter the vault's
// attachments, preview thumbnails (hover-preview → shared lightbox), see
// "used in N notes", and act via a per-item ⋮ menu: preview, rename, delete.
//
// This is a LIBRARY page, not a note-action surface: it has no
// insert-into-note action (there is no focused editor while it's open — the
// `emitAttachmentEmbed` insert path stays available in the editor itself).
//
// Rendered by `PaneView` as the body of an `attachments` TAB (myne-md/myne#773).
// It used to be a `CenterView` — a second, parallel center-pane swap that
// replaced the whole pane tree — which is why the left ribbon could not know it
// was open and why it could not sit beside a note in a split. Lives inside
// `<SidebarStateProvider>` so it can read the note-title cache + the `open`
// action (jump-to-note target).
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
import { open as openFileDialog } from "../../platform/dialog";
import {
  attachmentCleanUnused,
  attachmentDelete,
  attachmentImport,
  attachmentReadExtractedText,
  attachmentRename,
  attachmentUnusedList,
  catalogList,
  type AttachmentExtractedText,
  type CatalogEntry,
  type CleanResult,
} from "../../lib/attachments";
import { attachmentUrl } from "../../notes/attachmentRef";
import { useWarmAttachmentRefs } from "./useWarmAttachmentRefs";
import {
  startTranscription,
  type TranscribeError,
  type TranscribeErrorKind,
} from "../../lib/transcribe";
import { usePrefs } from "../../hooks/usePrefs";
import { showAttachmentToast } from "../../editor/attachments/toast";
import { AttachmentSyncProgress } from "./AttachmentSyncProgress";
import { referencingNotes } from "../../notes/attachmentRefs";
import { useSelectedNote, type NoteId } from "../../notes/sidebarState";
import { showAttachmentLightbox } from "../../editor/attachments/lightbox";
import { exportAttachment } from "../../editor/attachments/fileCardActions";
import { Icon } from "../primitives/Icon";
import { Button } from "../primitives/Button";
import { EmptyState } from "../primitives/EmptyState";
import { Skeleton } from "../primitives/Skeleton";
import { VISUALLY_HIDDEN as visuallyHidden } from "../primitives/visuallyHidden";
import { Tooltip } from "../primitives/Tooltip";
import { Select, type SelectOption } from "../primitives/Select";
import { HOVER_TRANSITION } from "../primitives/hoverSurface";
import { interactiveSurface, type InteractiveSurfaceHandlers } from "../primitives/interactiveSurface";
import type { IconName } from "../../lib/icons";
import { AttachmentThumbnail } from "./AttachmentThumbnail";
import { UsedInNotesPopover } from "./UsedInNotesPopover";
import { DeleteAttachmentDialog } from "./DeleteAttachmentDialog";
import { CleanUnusedAttachmentsDialog } from "./CleanUnusedAttachmentsDialog";
import { TranscriptionModal } from "./TranscriptionModal";
import { MIN_TARGET } from "../primitives/targetSize";
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

// Toast i18n KEY per transcription-failure cause (MYND-591, myne-md/myne#649).
// One product fact has one string: both surfaces share the editor cause family
// (`editor.attachment.widget.transcribe.cause.*`), resolved with `t()` at usage
// time (never a frozen resolved string). `"failed"` and any unrecognized kind
// fall back to the generic failure toast at the call site.
const TRANSCRIBE_TOAST_KEY: Readonly<
  Record<Exclude<TranscribeErrorKind, "failed">, string>
> = {
  feature_off: "editor.attachment.widget.transcribe.cause.featureOff",
  vault_locked: "editor.attachment.widget.transcribe.cause.vaultLocked",
  no_model: "editor.attachment.widget.transcribe.cause.noModel",
  model_load_failed: "editor.attachment.widget.transcribe.cause.modelLoadFailed",
  too_long: "editor.attachment.widget.transcribe.cause.tooLong",
};

interface AttachmentsLibraryProps {
  /**
   * Return to the editor view. The library is a SCREEN, not a modal — there
   * is no × affordance; the user leaves by selecting another tab, or by
   * jumping to a note from a "used in N notes" entry — which opens the note in
   * this pane and therefore replaces this tab with it.
   *
   * There is no `onClose` any more (myne-md/myne#773). It existed because the
   * library was a `CenterView` — a parallel center-pane swap outside the tab
   * model — so jumping to a note had to ALSO tell the shell to swap back. As a
   * tab, opening the note in the focused pane is the whole operation.
   */
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
  justifyContent: "space-between",
  rowGap: "var(--space-2)",
  gap: "var(--space-2)",
  padding: "var(--space-2) var(--space-4)",
  borderBottom: "1px solid var(--line-1)",
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

// Left control cluster (search + type filter + sort + view toggle). The search
// field is the flexible member, so the cluster grows to fill the row and the
// whole cluster wraps as a unit when the pane narrows.
const LEFT_CLUSTER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  flex: "1 1 320px",
  minWidth: 0,
};

// Right control cluster (clean unused + import). It does NOT shrink and wraps to
// the next line as a unit when the row runs out of width.
const RIGHT_CLUSTER_STYLE: CSSProperties = {
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
  transition:
    "background var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard)",
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
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
};

// The in-field clear (×) button — appears only while the query is non-empty.
const SEARCH_CLEAR_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  ...MIN_TARGET,
  padding: 0,
  border: 0,
  borderRadius: "var(--radius-1)",
  background: "transparent",
  color: "var(--fg-3)",
  cursor: "pointer",
  transition: HOVER_TRANSITION,
};

const SCROLL_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  // NO top padding: it left a band above the list's `position: sticky` header
  // through which rows scrolled (visible bleed). The header now sticks flush at
  // the scroll top; grid keeps its top breathing room via GRID_STYLE below.
  padding: "0 var(--space-4) var(--space-4)",
  // WCAG 2.2 SC 2.4.11, focus not obscured (myne-md/myne#728, task 14).
  //
  // `LIST_HEADER_STYLE` is `position: sticky; top: 0` with an opaque
  // background, and the rows under it carry `tabIndex={0}` on their preview
  // target. Tabbing to a row just above the fold scrolls it to the scroll
  // top, which is exactly where the header is: the focused control ends up
  // ENTIRELY behind it, ring and all, and the user is tabbing blind.
  //
  // `scroll-padding-top` on the SCROLLER is the mechanism for this, and it is
  // the reason it beats a `scroll-margin` on each row: the browser applies it
  // to focus-driven scrolling and to `scrollIntoView` alike, so it covers
  // paths this code does not own. `--space-6` is 32px, which clears the
  // header's box (two `--space-2` paddings around one `--text-xs` line, plus
  // its hairline) with a little slack rather than tracking it exactly; a
  // clearance that has to be kept equal to a computed height is a clearance
  // that goes stale the first time the type scale moves.
  scrollPaddingTop: "var(--space-6)",
};

const GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
  gap: "var(--space-4)",
  paddingTop: "var(--space-4)",
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
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  zIndex: 10,
};

export function AttachmentsLibrary(_props: AttachmentsLibraryProps) {
  const { t } = useTranslation();
  const ctx = useSelectedNote();
  // AI opt-in gate for the per-item Transcribe action (voice-to-text MYND-552,
  // SYNC-V9). Gated on `transcription_enabled` (MYND-592) — its own switch, not
  // the AI beta opt-in. The `ai_excluded_folders` rule never applied here either:
  // a library attachment has no single folder, and transcribing the media bytes
  // is an explicit per-attachment user action rather than ambient reading.
  const { prefs } = usePrefs();
  const transcriptionEnabled = prefs.transcription_enabled;
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
  /** Bumped once the visible entries' render URLs are resolvable, so the
   *  thumbnails re-render against the warmed answers (see the effect below). */
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
  // Lets the search-box clear (×) button return focus to the input after wiping
  // the query, so the user can keep typing without re-clicking the field.
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Fix 6 (MYND-164): a single shared "which attachment's used-in-notes popover
  // is open" — lifted out of each tile so opening one closes any other (only
  // one popover open at a time across the whole library).
  const [openPopoverId, setOpenPopoverId] = useState<string | null>(null);
  // Single-open ⋮ action menu — opening one row's menu closes any other.
  const [openActionMenuId, setOpenActionMenuId] = useState<string | null>(null);
  // Cursor point when the menu was opened via right-click (else null → anchor to
  // the ⋮ button). Reset whenever the ⋮ button is used or the menu closes.
  const [actionMenuAt, setActionMenuAt] = useState<{ x: number; y: number } | null>(
    null,
  );

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

  // "View transcription" (voice-to-text MYND-552): lazy cache of the per-audio-
  // attachment MYE1 read, keyed by id — `null` = probed, no Ok transcript; a
  // value = the transcript is present + ready to view. Probed when an audio
  // row's ⋮ menu opens (lighter than decrypting every audio blob on mount).
  // `probedRef` dedupes in-flight probes (idempotent reads, but no need to
  // repeat one). The modal shows the cached transcript text read-only.
  const [transcriptById, setTranscriptById] = useState<
    ReadonlyMap<string, AttachmentExtractedText | null>
  >(new Map());
  const probedTranscriptRef = useRef<Set<string>>(new Set());
  const [transcriptModal, setTranscriptModal] = useState<{
    filename: string;
    text: string;
  } | null>(null);

  // Probe an audio attachment's transcript cache on demand (⋮-menu open). No-op
  // for non-audio, and deduped so one open doesn't re-decrypt. A transient error
  // records `null` (no affordance) but clears the dedupe so a later open retries.
  const probeTranscript = useCallback((entry: CatalogEntry) => {
    if (kindOf(entry.content_type) !== "audio") return;
    if (probedTranscriptRef.current.has(entry.id)) return;
    probedTranscriptRef.current.add(entry.id);
    attachmentReadExtractedText(entry.id)
      .then((res) => {
        setTranscriptById((m) => new Map(m).set(entry.id, res));
      })
      .catch(() => {
        probedTranscriptRef.current.delete(entry.id);
        setTranscriptById((m) => new Map(m).set(entry.id, null));
      });
  }, []);

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

  // MYND-629: files dropped onto the pane import the same way the button's
  // file dialog does — same `attachmentImport` IPC, same refresh — so a drop
  // and a pick cannot diverge in what they accept or produce. Only the source
  // of the bytes differs: a drop hands us the bytes directly (no filesystem
  // path crosses IPC), a pick hands us a path the backend reads.
  const [dropping, setDropping] = useState(false);

  const handleDropFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setImporting(true);
      try {
        for (const file of files) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          await attachmentImport({
            kind: "bytes",
            bytes: Array.from(bytes),
            filename: file.name || null,
          });
        }
        await refresh();
      } catch (err) {
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[AttachmentsLibrary] drop import failed:", err);
        }
      } finally {
        setImporting(false);
      }
    },
    [refresh],
  );

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
  // cache backend-side; the library has no editor to insert into. Each cause
  // (MYND-591) surfaces its own truthful toast; anything else → generic failure.
  const handleTranscribe = useCallback(
    (entry: CatalogEntry) => {
      showAttachmentToast(t("attachments.library.transcribeStarted"));
      const run = startTranscription(entry.id);
      run.done
        .then(() => {
          // A fresh transcript now exists — invalidate the lazy probe so the
          // next ⋮-menu open re-reads it and offers "View transcription".
          probedTranscriptRef.current.delete(entry.id);
          setTranscriptById((m) => {
            const next = new Map(m);
            next.delete(entry.id);
            return next;
          });
          showAttachmentToast(t("attachments.library.transcribeDone"), "success");
        })
        .catch((err: unknown) => {
          const kind = (err as TranscribeError | null)?.kind ?? "failed";
          // `"failed"` is spelled out rather than reached through a `??`
          // fallback, so `TRANSCRIBE_TOAST_KEY` can be typed over the rest of
          // the union and a new cause fails to compile here. The fallback form
          // typechecked with a missing row and rendered the generic copy for a
          // cause the backend had named (myne#510).
          //
          // Why this stays an object literal while `CAUSE_BY_TAG` in
          // `src/lib/transcribe.ts` became a `Map` in the same change: the two
          // solve different problems and the asymmetry is deliberate. That one
          // looks up a STRING the backend sent, so `constructor` or `toString`
          // would walk `Object.prototype` and resolve to a truthy function; a
          // `Map` is the fix and costs nothing there. This one is indexed by a
          // value from a CLOSED union that the compiler checks, and being an
          // object literal is what makes a missing row a compile error. A `Map`
          // here would trade that compile-time exhaustiveness for a runtime
          // guard against an input this site cannot receive.
          const toastKey =
            kind === "failed" ? "attachments.library.transcribeFailed" : TRANSCRIBE_TOAST_KEY[kind];
          showAttachmentToast(t(toastKey), "error");
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

  const openDeleteDialog = useCallback(
    async (entry: CatalogEntry) => {
      // Warn only about notes the user actually sees — a conflict copy that
      // embeds the attachment is not a separate note to the user (#212).
      const noteIds = (await referencingNotes(entry.id)).filter((id) =>
        isLiveReferencingNote(ctx.cache, id),
      );
      setDeleteTarget({ entry, noteIds });
    },
    [ctx.cache],
  );

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
    } catch (e) {
      // `CorpusIncomplete` gets its own sentence (phase3-web-client task 89).
      // It is not a failure — the scan refused because it would have been
      // computed over a fraction of the corpus — and the remedy is to wait,
      // which "couldn't check" does not communicate. Collapsing it into the
      // generic notice would leave the user re-clicking a button that will keep
      // refusing for exactly as long as the sync takes.
      const kind = (e as { kind?: string } | null)?.kind;
      setCleanNotice(
        kind === "CorpusIncomplete"
          ? t("attachments.library.corpusIncompleteNotice")
          : t("attachments.library.checkUnusedFailedNotice"),
      );
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
      // Opening the note in the focused pane REPLACES this tab with it, which
      // is what "jump to the note" means. No second call is needed.
      void ctx.open(id).catch(() => {});
    },
    [ctx],
  );

  // ---- render ------------------------------------------------------------

  // Make every listed attachment's render URL resolvable before the thumbnails
  // ask for it.
  //
  // On desktop this is a no-op: `attachment://<id>` is a pure function of the
  // id and the Rust handler decrypts per request. A browser has no custom
  // protocol — it mints a `blob:` URL from bytes the Worker decrypted — and
  // `resolveRef` is called during render, where it cannot do IO. So an id
  // nobody warmed resolves to the pending placeholder, which is why the web
  // library painted a grid of blank tiles while the same files rendered fine
  // once something else had warmed them.
  //
  // The editor already warms the ids the OPEN NOTE embeds
  // (`editor/src/attachments/catalog.ts`); nothing warmed the ids the LIBRARY
  // lists, and this surface is precisely the one that lists all of them.
  //
  // Lifted into `useWarmAttachmentRefs` (#263) so the OTHER thumbnail surfaces
  // get the same treatment: the cover picker and the clean-unused dialog both
  // rendered blank boxes on web because only this one warmed.
  //
  // `windowed`, and this is the surface that made it necessary (myne#388). The
  // comment here used to claim the warm was "scoped to what is actually on
  // screen after filtering, not the whole catalog" — but `visible` is a filter
  // plus a sort over the whole catalog, and both filters are inert at their
  // defaults, so on first open it IS the entire catalog. Opening the library
  // decrypted every attachment in the vault and pinned each for the session.
  // The hook now warms what an IntersectionObserver reports on screen,
  // `MAX_WARMED_IDS` backstops it, and the byte ceiling lives in the Worker.
  const { warmKey, observeItem } = useWarmAttachmentRefs(
    visible.map((e) => e.id),
    { windowed: true },
  );

  const isLoading = entries === null;
  const isEmpty = !isLoading && (entries?.length ?? 0) === 0;
  const isNoMatch = !isLoading && !isEmpty && visible.length === 0;

  // Shared per-item wiring — keeps the grid tile + the list row from drifting.
  const itemProps = (entry: CatalogEntry): ItemActionProps => ({
    entry,
    itemRef: observeItem(entry.id),
    renaming: renamingId === entry.id,
    cache: ctx.cache,
    popoverOpen: openPopoverId === entry.id,
    // Opening a used-in popover closes any open ⋮ menu (single overlay at a time).
    onTogglePopover: () => {
      setOpenActionMenuId(null);
      setOpenPopoverId((cur) => (cur === entry.id ? null : entry.id));
    },
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
    transcriptionEnabled,
    onTranscribe: () => handleTranscribe(entry),
    // "View transcription" (MYND-552) — shown when the lazy probe found an Ok
    // audio transcript in the device-local MYE1 cache. NOT ai_enabled-gated:
    // reading an already-produced transcript needs no engine (and works in the
    // auditable AI-free build), so this appears even when Transcribe is hidden.
    hasTranscript:
      transcriptById.get(entry.id)?.source_format === "audio",
    onViewTranscription: () => {
      const res = transcriptById.get(entry.id);
      if (res) setTranscriptModal({ filename: entry.filename, text: res.text });
    },
    // Only image/PDF open the shared lightbox preview. Audio plays inline in
    // its own tile (its own play button), and a generic ("other") file has no
    // inline preview — same fallback as the editor file-card; Preview hidden.
    previewable:
      kindOf(entry.content_type) === "image" || kindOf(entry.content_type) === "pdf",
    actionMenuOpen: openActionMenuId === entry.id,
    // Opening a ⋮ menu closes any open used-in popover (single overlay at a time).
    onToggleActionMenu: () => {
      setOpenPopoverId(null);
      setActionMenuAt(null); // ⋮-anchored, not cursor-anchored
      // Probe the transcript cache when OPENING (not closing) this row's menu.
      if (openActionMenuId !== entry.id) probeTranscript(entry);
      setOpenActionMenuId((cur) => (cur === entry.id ? null : entry.id));
    },
    onOpenActionMenu: (at) => {
      setOpenPopoverId(null);
      setActionMenuAt(at);
      probeTranscript(entry);
      setOpenActionMenuId(entry.id);
    },
    actionMenuAt: openActionMenuId === entry.id ? actionMenuAt : null,
    onCloseActionMenu: () => setOpenActionMenuId(null),
  });

  return (
    // A `<section>`, not a `<main>` (myne-md/myne#728, task 9). The library
    // renders INSIDE the editor's centre column, which is the route's one
    // `main` landmark; a nested second one makes "jump to main" ambiguous and
    // trips axe's `landmark-unique`. Nothing else about the element changes:
    // `main` and `section` are both generic flow containers here, and the
    // region it lives in already carries the name.
    <section
      onDragOver={(e) => {
        // Only claim the drop when the OS is actually offering files; an
        // in-app note drag must keep falling through to the sidebar.
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDropping(false);
        void handleDropFiles(Array.from(e.dataTransfer.files));
      }}
      data-testid="attachments.library"
      data-dropping={dropping ? "true" : undefined}
      style={{
        flex: 1,
        minWidth: 0,
        // Drop affordance (MYND-629): an inset accent ring while files hover,
        // so the pane visibly claims the drop instead of silently accepting it.
        outline: dropping ? "2px dashed var(--accent)" : undefined,
        outlineOffset: dropping ? "-6px" : undefined,
        // Allow this flex-column item to shrink below its content height so the
        // SCROLL_STYLE child (overflowY: auto) actually scrolls instead of the
        // grid overflowing the pane (flexbox min-height:auto trap).
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-1)",
        // Anchor the transient clean-up notice (absolute, bottom-center).
        position: "relative",
        // Entry animation (MYND-170 polish): a subtle fade + rise so the pane
        // settles in rather than snapping open. Zeroed under reduced-motion by
        // the global rule in tokens.css.
        animation: "attachments-in var(--duration-base) var(--ease-out)",
      }}
    >
      {/* The "Attachments" title lives in the pane's top clearance/tab-strip row
          (rendered by Editor.tsx), so the toolbar is the library's first row. */}
      <div style={TOOLBAR_STYLE}>
        <div style={LEFT_CLUSTER_STYLE}>
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
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              placeholder={t("attachments.library.searchPlaceholder")}
              aria-label={t("attachments.library.searchAriaLabel")}
              style={SEARCH_INPUT_STYLE}
            />
            {query !== "" && (
              <Tooltip label={t("attachments.library.clearSearchAriaLabel")}>
                <button
                  type="button"
                  aria-label={t("attachments.library.clearSearchAriaLabel")}
                  data-testid="attachments.search-clear"
                  onClick={() => {
                    setQuery("");
                    searchInputRef.current?.focus();
                  }}
                  {...interactiveSurface()}
                  style={SEARCH_CLEAR_STYLE}
                >
                  <Icon name="x" size={14} />
                </button>
              </Tooltip>
            )}
          </div>
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
        </div>
        <div style={RIGHT_CLUSTER_STYLE}>
          <ToolbarActionButton
            icon="trash-2"
            label={
              checkingUnused
                ? t("attachments.library.checking")
                : t("attachments.library.cleanUnused")
            }
            onClick={() => void handleCleanUnused()}
            disabled={checkingUnused || importing}
            hoverColor="var(--danger)"
            testId="attachments.clean-unused-cta"
            title={t("attachments.library.cleanUnusedTitle")}
          />
          <ToolbarActionButton
            icon="download"
            label={t("attachments.library.import")}
            onClick={() => void handleImport()}
            disabled={importing}
            hoverColor="var(--accent)"
            spinning={importing}
          />
        </div>
      </div>

      {/* In-flight attachment transfers (MYND-423). Hidden entirely while idle
          (the common case); the MYND-424 sync engine becomes the registry's
          writer when it lands. */}
      <AttachmentSyncProgress hideWhenEmpty />

      <div
        style={
          // A flex column only while a zero state is showing, so it can FILL
          // the tab rather than sit as a card at the top of it with the rest
          // of the tab empty below.
          isEmpty || isNoMatch
            ? { ...SCROLL_STYLE, display: "flex", flexDirection: "column" }
            : SCROLL_STYLE
        }
      >
        {isLoading ? (
          // The library's layout is KNOWN before its contents are — a grid of
          // uniform tiles, or a list of uniform rows — so it draws itself and
          // the attachments arrive into it (myne-md/myne#778). It used to show
          // the word "Decrypting…" centred in an empty pane, which told the
          // user the wait was happening and nothing about what was coming, then
          // shoved the page around when it landed.
          //
          // The word stays, in a live region, because the skeleton is
          // `aria-hidden` and a screen-reader user would otherwise be told
          // nothing at all.
          <div data-testid="attachments.loading">
            <span style={visuallyHidden} role="status" aria-live="polite">
              {t("attachments.library.decrypting")}
            </span>
            <div
              style={
                view === "grid"
                  ? GRID_STYLE
                  : { display: "flex", flexDirection: "column", gap: "var(--space-1)" }
              }
              aria-hidden="true"
            >
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton
                  key={i}
                  style={
                    view === "grid"
                      ? { height: 132, borderRadius: "var(--radius-2)" }
                      : { height: 44, borderRadius: "var(--radius-2)" }
                  }
                />
              ))}
            </div>
          </div>
        ) : isEmpty ? (
          <LibraryEmpty
            mode="empty"
            loadError={loadError}
            importing={importing}
            onImport={() => void handleImport()}
            onRetry={() => void refresh()}
          />
        ) : isNoMatch ? (
          <LibraryEmpty
            mode="no-results"
            query={query}
            onClearSearch={() => {
              setQuery("");
              setTypeFilter("all");
            }}
          />
        ) : view === "grid" ? (
          <div style={GRID_STYLE}>
            {visible.map((entry) => (
              /* The key changes on THIS tile's own cold→warm transition, so the
                 <img> is recreated against the resolved URL rather than left
                 holding the pending placeholder it first rendered with — and a
                 scroll that warms a neighbour does not remount this one. */
              <AttachmentTile key={warmKey(entry.id)} {...itemProps(entry)} />
            ))}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            <ListHeader />
            {visible.map((entry) => (
              /* Keyed the same way as the grid tile. This row used to be keyed
                 on the id alone, so on web a PDF row's first-page render — read
                 once in an `[id]`-keyed effect — never re-ran after the warm and
                 the row kept the generic file icon. */
              <AttachmentListRow key={warmKey(entry.id)} {...itemProps(entry)} />
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

      <TranscriptionModal
        open={transcriptModal !== null}
        filename={transcriptModal?.filename ?? ""}
        text={transcriptModal?.text ?? ""}
        onClose={() => setTranscriptModal(null)}
      />
    </section>
  );
}

// ---- bordered view-toggle button ------------------------------------------

/**
 * Grid/list view toggle styled to match its bordered neighbours (the sort
 * `<select>` + the Import button) — Fix 3 (MYND-164). Hover deepens the
 * background like the secondary Button. Shows the icon for the view it would
 * switch TO (grid icon while in list, list icon while in grid).
 */
/** The grid/list view toggle: hover deepens BOTH the fill and the border so the
 *  hover reads on a near-black surface (`--bg-1` to `--bg-3` alone was
 *  imperceptible), and a press confirms the click. The fill half is
 *  `interactiveSurface`; the border change chains onto its handlers rather than
 *  spreading around them. */
function viewToggleSurface(): InteractiveSurfaceHandlers {
  const surface = interactiveSurface({
    restBg: "var(--bg-1)",
    hoverBg: "var(--bg-3)",
  });
  return {
    ...surface,
    onMouseEnter: (e) => {
      surface.onMouseEnter?.(e);
      e.currentTarget.style.borderColor = "var(--line-3)";
    },
    onMouseLeave: (e) => {
      surface.onMouseLeave?.(e);
      e.currentTarget.style.borderColor = "var(--line-2)";
    },
  };
}

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
      {...viewToggleSurface()}
    >
      <Icon name={view === "grid" ? "list" : "layout-grid"} size={16} />
    </button>
  );
}

// ---- right-cluster action button ------------------------------------------

// Matches the bordered chrome of the left-cluster controls (same border token,
// radius, height) so the whole toolbar reads as one set. On hover it deepens its
// background AND tints its text + icon to `hoverColor` — Clean unused → danger,
// Import → accent. We roll our own button rather than reuse `Button` here because
// the per-control hover TINT and the spinner-swap icon are both outside that
// primitive's surface (its hover only deepens the background, and its `icon` prop
// can't animate).
const TOOLBAR_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  height: 30,
  padding: "0 var(--space-3)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)",
  color: "var(--fg-1)",
  background: "var(--bg-1)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  cursor: "pointer",
  whiteSpace: "nowrap",
  transition:
    "background var(--duration-fast) var(--ease-standard), color var(--duration-fast) var(--ease-standard)",
};

/** A right-cluster toolbar action: hover deepens the fill and tints the glyph
 *  (`hoverColor`, e.g. `--danger` for Import), and a press confirms the click.
 *  `disabled` drops both halves, which is what the hand-written version's early
 *  return did. */
function toolbarActionSurface(
  disabled: boolean,
  hoverColor: string,
): InteractiveSurfaceHandlers {
  const surface = interactiveSurface({
    restBg: "var(--bg-1)",
    hoverBg: "var(--bg-3)",
    disabled,
  });
  return {
    ...surface,
    onMouseEnter: (e) => {
      surface.onMouseEnter?.(e);
      e.currentTarget.style.color = hoverColor;
    },
    onMouseLeave: (e) => {
      surface.onMouseLeave?.(e);
      e.currentTarget.style.color = "var(--fg-1)";
    },
  };
}

function ToolbarActionButton({
  icon,
  label,
  onClick,
  disabled = false,
  hoverColor,
  spinning = false,
  testId,
  title,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Text + icon colour on hover (e.g. `var(--danger)` / `var(--accent)`). */
  hoverColor: string;
  /** Swap the icon for a spinning `loader-circle` (Import in-flight). */
  spinning?: boolean;
  testId?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      title={title}
      style={{
        ...TOOLBAR_BUTTON_STYLE,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
      {...toolbarActionSurface(disabled === true, hoverColor)}
    >
      {spinning ? (
        // The rotation comes from the shared `.myne-spinner` class, which the
        // reduced-motion block already names, so a frozen spinner cannot happen
        // here; the span keeps `data-motion="essential"` as well because it is
        // the same statement and costs nothing.
        <span
          data-motion="essential"
          className="myne-spinner"
          style={{ display: "inline-flex" }}
        >
          <Icon name="loader-circle" size={14} />
        </span>
      ) : (
        <Icon name={icon} size={14} />
      )}
      {label}
    </button>
  );
}

// ---- empty state ----------------------------------------------------------

// THREE distinct zero states, on the shared `<EmptyState>` since
// myne-md/myne#776:
//
//   • firstRun — the catalog itself is empty. Import is the way out.
//   • filtered — the catalog has items but the query / type filter matches
//                nothing. The query is ECHOED BACK and clearing it is the way
//                out. This is the state that was a dead end everywhere else in
//                the app: "no results" with no sight of what was searched and
//                nothing to press.
//   • error    — the catalog could not be read. Previously this shared the
//                firstRun branch, so a failure to DECRYPT the catalog rendered
//                as "No attachments yet" beside an Import button: the one
//                sentence guaranteed to be wrong, offering the one action that
//                cannot help.
type LibraryEmptyProps =
  | {
      mode: "empty";
      loadError: boolean;
      importing: boolean;
      onImport: () => void;
      onRetry: () => void;
    }
  | {
      mode: "no-results";
      query: string;
      onClearSearch: () => void;
    };

function LibraryEmpty(props: LibraryEmptyProps) {
  const { t } = useTranslation();

  if (props.mode === "no-results") {
    return (
      <EmptyState
        variant="filtered"
        icon="search"
        title={t("attachments.library.emptyNoResultsTitle")}
        body={
          props.query.trim() === ""
            ? t("attachments.library.emptyFilteredBody")
            : t("attachments.library.emptyFilteredBodyQuery")
        }
        query={props.query.trim() === "" ? undefined : props.query}
        testId="attachments.empty-no-results"
        fill
        action={
          <Button
            variant="secondary"
            icon="x"
            onClick={props.onClearSearch}
            data-testid="attachments.empty-clear-search"
          >
            {t("attachments.library.emptyClearSearch")}
          </Button>
        }
      />
    );
  }

  if (props.loadError) {
    return (
      <EmptyState
        variant="error"
        icon="circle-alert"
        title={t("attachments.library.emptyLoadError")}
        body={t("attachments.library.emptyLoadErrorBody")}
        testId="attachments.empty-load-error"
        fill
        action={
          <Button variant="secondary" icon="refresh-cw" onClick={props.onRetry}>
            {t("attachments.library.emptyRetry")}
          </Button>
        }
      />
    );
  }

  return (
    <EmptyState
      variant="firstRun"
      icon="paperclip"
      title={t("attachments.library.emptyNoAttachments")}
      body={t("attachments.library.emptyImportHint")}
      testId="attachments.empty-no-attachments"
        fill
      action={
        <Button
          variant="primary"
          icon="download"
          onClick={props.onImport}
          disabled={props.importing}
        >
          {props.importing
            ? t("attachments.library.importing")
            : t("attachments.library.importFile")}
        </Button>
      }
    />
  );
}

// ---- shared row/tile sub-pieces ------------------------------------------

interface ItemActionProps {
  entry: CatalogEntry;
  /** Ref callback from `useWarmAttachmentRefs`, so the surface learns when this
   *  item is on screen. Both views render thumbnails, so both must report it or
   *  the one that does not goes back to painting placeholders forever. */
  itemRef: (el: Element | null) => void;
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
  transcriptionEnabled: boolean;
  /** Start transcribing this attachment (audio only). */
  onTranscribe: () => void;
  /** Whether an Ok audio transcript exists in the MYE1 cache (probed on menu
   *  open) → the ⋮ menu shows "View transcription". NOT ai_enabled-gated. */
  hasTranscript: boolean;
  /** Open the read-only transcription modal for this attachment (MYND-552). */
  onViewTranscription: () => void;
  /** Whether THIS row's ⋮ action menu is the one open (single-open). */
  actionMenuOpen: boolean;
  /** Toggle this row's ⋮ action menu (closing any other). */
  onToggleActionMenu: () => void;
  /** Force-OPEN this row's ⋮ action menu at the given viewport point — bound to
   *  right-click on the tile/row so a context-click gives the same actions at the
   *  cursor instead of the native OS menu. */
  onOpenActionMenu: (at: { x: number; y: number }) => void;
  /** When the menu was opened via right-click, the cursor point to render it at;
   *  `null` = opened via the ⋮ button (anchor to the button instead). */
  actionMenuAt: { x: number; y: number } | null;
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
        fontSize: "var(--text-sm)",
        color: "var(--fg-1)",
        background: "var(--paper-1, var(--bg-1))",
        border: "1px solid var(--accent)",
        borderRadius: "var(--radius-1)",
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
/** A referencing-note id counts toward "used in N notes" (and the delete
 *  warning's list) only if it is a note the user actually sees. Excludes
 *  conflict copies — which otherwise list the same note title once per copy
 *  (#212) — plus trashed / deleted / archived / template records, matching
 *  `liveCache`'s per-record predicate. An id absent from the title cache is
 *  dropped as unknown. */
function isLiveReferencingNote(
  cache: ReadonlyMap<NoteId, import("../../notes/loadNoteBatch").TitleRecord>,
  id: string,
): boolean {
  const r = cache.get(id as NoteId);
  return (
    r !== undefined &&
    r.conflict !== true &&
    r.trashed == null &&
    r.deleted == null &&
    r.archived == null &&
    r.template !== true
  );
}

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

  // Count/list only the notes the user actually sees: conflict copies otherwise
  // show the same note title once per copy (#212). Loading (null) is preserved.
  const liveNoteIds =
    noteIds === null
      ? null
      : noteIds.filter((id) => isLiveReferencingNote(cache, id));
  const n = liveNoteIds?.length ?? 0;
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
        {...interactiveSurface({ disabled: n === 0 })}
        style={{
          background: "transparent",
          border: 0,
          padding: 0,
          cursor: n > 0 ? "pointer" : "default",
          fontFamily: "var(--font-sans)",
          fontSize: 12,
          color: n > 0 ? "var(--accent)" : "var(--fg-3)",
          textDecoration: n > 0 ? "underline" : "none",
          transition: HOVER_TRANSITION,
        }}
        disabled={noteIds === null}
      >
        {noteIds === null
          ? t("attachments.library.usedInLoading")
          : t("attachments.library.usedInCount", { count: n })}
      </button>
      {open && liveNoteIds !== null && (
        <UsedInNotesPopover
          noteIds={liveNoteIds}
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
  textAlign: "start",
  padding: "var(--space-2) var(--space-3)",
  background: "transparent",
  border: 0,
  cursor: "pointer",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
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
  at = null,
}: {
  items: readonly ItemMenuEntry[];
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  /** Cursor point to open at (right-click); `null` → anchor under the ⋮ button. */
  at?: { x: number; y: number } | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null,
  );

  // Position at the cursor when opened via right-click; otherwise anchor below
  // the ⋮ trigger, right-aligned to it. Either way clamp into the viewport and
  // flip up when there isn't room below (estimated from the item count).
  useLayoutEffect(() => {
    const width = 160;
    const estHeight = items.length * 34 + 8;
    if (at !== null) {
      const openUp = at.y + estHeight + 8 > window.innerHeight;
      const top = openUp ? Math.max(8, at.y - estHeight) : at.y;
      const left = Math.min(at.x, window.innerWidth - width - 8);
      setCoords({ top, left: Math.max(8, left) });
      return;
    }
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.min(r.right - width, window.innerWidth - width - 8);
    const openUp = r.bottom + estHeight + 8 > window.innerHeight;
    const top = openUp ? Math.max(8, r.top - estHeight - 4) : r.bottom + 4;
    setCoords({ top, left: Math.max(8, left) });
  }, [anchorRef, items.length, at]);

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
          // hoverSurface deepens only the background; the Delete item keeps its
          // `--danger` text colour set below.
          {...interactiveSurface({ disabled: item.disabled })}
          style={{
            ...MENU_ITEM_STYLE,
            color: item.disabled
              ? "var(--fg-3)"
              : item.destructive
                ? "var(--danger)"
                : "var(--fg-1)",
            cursor: item.disabled ? "default" : "pointer",
            opacity: item.disabled ? 0.6 : 1,
            transition: HOVER_TRANSITION,
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
  at,
  onToggle,
  onClose,
  previewable,
  onPreview,
  onExport,
  onStartRename,
  onDelete,
  transcribable,
  transcriptionEnabled,
  onTranscribe,
  hasTranscript,
  onViewTranscription,
}: {
  open: boolean;
  /** Cursor point to open at (right-click) or `null` to anchor to the ⋮ button. */
  at: { x: number; y: number } | null;
  onToggle: () => void;
  onClose: () => void;
  previewable: boolean;
  onPreview: () => void;
  onExport: () => void;
  onStartRename: () => void;
  onDelete: () => void;
  transcribable: boolean;
  transcriptionEnabled: boolean;
  onTranscribe: () => void;
  hasTranscript: boolean;
  onViewTranscription: () => void;
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
    // "View transcription" — audio only, shown once the lazy probe found an Ok
    // transcript in the device-local MYE1 cache. Deliberately NOT gated on
    // `transcription_enabled`: reading an already-produced transcript needs no
    // engine, so it stays available even with speech-to-text off (and in the
    // auditable AI-free build). Listed above Transcribe as the primary action.
    ...(transcribable && hasTranscript
      ? [
          {
            id: "view-transcription",
            label: t("attachments.library.menuViewTranscription"),
            onSelect: onViewTranscription,
          },
        ]
      : []),
    // Transcribe — audio only (SYNC-V9), gated on `transcription_enabled`
    // (MYND-592). HIDDEN when the feature is off (MYND-270 product tweak: no
    // dangling affordance when the subsystem is off), not disabled — the same
    // affordance policy the in-note widget uses, so the two surfaces agree.
    // Kept even when a transcript exists, so the user can re-run it.
    ...(transcribable && transcriptionEnabled
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
        {...interactiveSurface({ hoverBg: "var(--paper-3)", disabled: open })}
      >
        <Icon name="more-vertical" size={16} />
      </button>
      {open && (
        <AttachmentActionMenu
          items={items}
          anchorRef={triggerRef}
          at={at}
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
      {...interactiveSurface({ disabled: !previewable })}
      style={{
        ...THUMB_HOVER_WRAP_STYLE,
        cursor: previewable ? "pointer" : "default",
        transition: HOVER_TRANSITION,
      }}
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
  transition: "border-color var(--duration-fast) var(--ease-standard)",
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
  gap: "var(--space-1)",
  minWidth: 0,
};

const FILENAME_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  fontWeight: "var(--weight-medium)",
  color: "var(--fg-1)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const SUBTEXT_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
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
  itemRef,
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
  transcriptionEnabled,
  onTranscribe,
  hasTranscript,
  onViewTranscription,
  actionMenuOpen,
  onToggleActionMenu,
  onOpenActionMenu,
  actionMenuAt,
  onCloseActionMenu,
}: ItemActionProps) {
  return (
    <div
      ref={itemRef}
      style={TILE_STYLE}
      data-testid="attachments.tile"
      data-id={entry.id}
      // Right-click anywhere on the card opens the same ⋮ actions AT THE CURSOR
      // (instead of the native OS reload/inspect menu).
      onContextMenu={(e) => {
        e.preventDefault();
        onOpenActionMenu({ x: e.clientX, y: e.clientY });
      }}
      // Accent border on hover — the card lifts toward the pointer without a
      // shadow (design canon: hairlines, no card shadows).
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--accent)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--line-1)";
      }}
    >
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
            at={actionMenuAt}
            onToggle={onToggleActionMenu}
            onClose={onCloseActionMenu}
            previewable={previewable}
            onPreview={onPreview}
            onExport={onExport}
            onStartRename={onStartRename}
            onDelete={onDelete}
            transcribable={transcribable}
            transcriptionEnabled={transcriptionEnabled}
            onTranscribe={onTranscribe}
            hasTranscript={hasTranscript}
            onViewTranscription={onViewTranscription}
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
  transition: HOVER_TRANSITION,
};

const LIST_HEADER_STYLE: CSSProperties = {
  ...LIST_ROW_STYLE,
  padding: "var(--space-2)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--fg-3)",
  // Stay put while the list scrolls: the surface background + the inherited
  // bottom hairline keep rows from showing through, and a z-index above the rows
  // (portalled menus/popovers sit far higher) keeps it on top.
  position: "sticky",
  top: 0,
  zIndex: 1,
  background: "var(--bg-1)",
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
  itemRef,
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
  transcriptionEnabled,
  onTranscribe,
  hasTranscript,
  onViewTranscription,
  actionMenuOpen,
  onToggleActionMenu,
  onOpenActionMenu,
  actionMenuAt,
  onCloseActionMenu,
}: ItemActionProps) {
  return (
    <div
      ref={itemRef}
      style={LIST_ROW_STYLE}
      data-testid="attachments.tile"
      data-id={entry.id}
      // Right-click anywhere on the row opens the same ⋮ actions AT THE CURSOR
      // (not the native OS menu).
      onContextMenu={(e) => {
        e.preventDefault();
        onOpenActionMenu({ x: e.clientX, y: e.clientY });
      }}
      {...interactiveSurface()}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: "var(--radius-1)",
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
          at={actionMenuAt}
          onToggle={onToggleActionMenu}
          onClose={onCloseActionMenu}
          previewable={previewable}
          onPreview={onPreview}
          onExport={onExport}
          onStartRename={onStartRename}
          onDelete={onDelete}
          transcribable={transcribable}
          transcriptionEnabled={transcriptionEnabled}
          onTranscribe={onTranscribe}
          hasTranscript={hasTranscript}
          onViewTranscription={onViewTranscription}
        />
      </div>
    </div>
  );
}
