// `<SnapshotsPanel>` — the file-recovery surface for encrypted per-note
// snapshots (MYND-97). A modal overlay (reusing the `<DeleteConfirmModal>`
// backdrop envelope, like `<TrashPanel>`) scoped to ONE note: a left list of the
// note's snapshots (newest-first, with relative age + size), a right pane that
// previews the selected snapshot as a diff (shared `<DiffView>` over the
// `@myne/dialect` core, word-level within a changed line), and a confirmed
// Restore. The diff's basis is the user's choice (MYND-334): the current note
// (the default, and the original behaviour) or the snapshot immediately older
// than the selected one, which answers "what did this snapshot itself change?".
//
// Copy discipline (SYNC-4): the term is "snapshot", never "backup"/"export";
// encryption is shown typographically ("Encrypted · 12s ago"), not with a
// green-badge cliché; nothing overclaims beyond the threat-model §7 guarantee.
// Restore routes through the backend `snapshot_restore`, which captures the
// current note as an undo point first (SYNC-5) — the confirm copy says so.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useOverlayInert } from "../../hooks/useOverlayInert";
import i18n from "../../i18n";
import type { NoteId } from "../sidebarState";
import { noteRead } from "../readNote";
import {
  snapshotList,
  snapshotPreview,
  snapshotRestore,
} from "../snapshots";
import type { SnapshotError, SnapshotMeta } from "../../types/snapshot-error";
import { Select, type SelectOption } from "../../components/primitives/Select";
import { BACKDROP_STYLE } from "./DeleteConfirmModal";
import { changedLineCount, diffWithSegments, type DiffLine } from "../../dialect";
import { DiffView } from "./DiffView";
import { formatRelativeTime } from "./relativeTime";
import {
  hoverSurface,
  HOVER_TRANSITION,
} from "../../components/primitives/hoverSurface";

const PANEL_STYLE: CSSProperties = {
  width: 720,
  maxWidth: "92vw",
  height: "70vh",
  display: "flex",
  flexDirection: "column",
  background: "var(--paper)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-3)",
  boxShadow: "var(--shadow-3)",
  fontFamily: "var(--font-sans)",
  overflow: "hidden",
};

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  padding: "var(--space-4) var(--space-5)",
  borderBottom: "1px solid var(--line-1)",
};

const HEADER_TITLE_STYLE: CSSProperties = {
  fontSize: 15,
  fontWeight: "var(--weight-semibold)",
  color: "var(--fg-1)",
  margin: 0,
};

const SUBTITLE_STYLE: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-3)",
  maxWidth: 360,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const BODY_STYLE: CSSProperties = {
  display: "flex",
  flex: 1,
  minHeight: 0,
};

const LIST_STYLE: CSSProperties = {
  width: 240,
  flexShrink: 0,
  overflowY: "auto",
  borderInlineEnd: "1px solid var(--line-1)",
  padding: "var(--space-2) 0",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  padding: "var(--space-2) var(--space-5)",
  cursor: "pointer",
  border: "none",
  background: "transparent",
  width: "100%",
  textAlign: "start",
  fontFamily: "var(--font-sans)",
  transition: HOVER_TRANSITION,
};

const ROW_SELECTED_STYLE: CSSProperties = {
  ...ROW_STYLE,
  background: "var(--accent-soft)",
};

const ROW_AGE_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
};

const ROW_META_STYLE: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
};

const DETAIL_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
};

// Wraps: the basis selector, the change count and Restore do not all fit on one
// line at the panel's 480px detail width, and a second row reads better than
// three shrunken controls.
const DETAIL_BAR_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: "var(--space-3)",
  padding: "var(--space-3) var(--space-5)",
  borderBottom: "1px solid var(--line-1)",
};

const DETAIL_GROUP_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  minWidth: 0,
};

const COMPARE_SELECT_STYLE: CSSProperties = { height: 26, fontSize: "var(--text-xs)" };

// The preview region; `<DiffView>` is the scrolling child inside it.
const PREVIEW_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
};

const EMPTY_STATE_STYLE: CSSProperties = {
  margin: "auto",
  padding: "var(--space-7) var(--space-5)",
  textAlign: "center",
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
  maxWidth: 360,
};

const PLACEHOLDER_STYLE: CSSProperties = {
  margin: "auto",
  padding: "var(--space-7)",
  textAlign: "center",
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
};

const FOOTER_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
  padding: "var(--space-3) var(--space-5)",
  borderTop: "1px solid var(--line-1)",
};

const STATUS_STYLE: CSSProperties = { fontSize: 12, color: "var(--warning)" };

const BTN_STYLE: CSSProperties = {
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  fontWeight: "var(--weight-medium)",
  padding: "4px 10px",
  borderRadius: 5,
  cursor: "pointer",
  border: "1px solid var(--line-2)",
  background: "var(--paper-2)",
  color: "var(--fg-1)",
  flexShrink: 0,
  transition: HOVER_TRANSITION,
};

const RESTORE_BTN_STYLE: CSSProperties = {
  ...BTN_STYLE,
  borderColor: "var(--accent)",
  color: "var(--accent)",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Honest, non-overclaiming copy for a rejected snapshot command. */
function formatSnapshotError(err: unknown): string {
  const kind = (err as Partial<SnapshotError>)?.kind;
  switch (kind) {
    case "VaultNotUnlocked":
      return i18n.t("notes.snapshots.errorVaultLocked");
    case "SnapshotNotFound":
      return i18n.t("notes.snapshots.errorNotFound");
    case "CannotDecrypt":
      return i18n.t("notes.snapshots.errorCannotDecrypt");
    case "Io":
      return i18n.t("notes.snapshots.errorIo");
    case "NotesDirNotADirectory":
      return i18n.t("notes.snapshots.errorStorageAccess");
    case "InvalidNoteId":
    case "InvalidSnapshotId":
    case "JoinFailure":
    default:
      return i18n.t("notes.snapshots.errorGeneric");
  }
}

/**
 * What the selected snapshot is diffed against. `current` is the default and
 * the pre-MYND-334 behaviour (snapshot → live note); `previous` diffs the
 * snapshot immediately older than the selected one → the selected one, so the
 * change the snapshot itself introduced is what shows.
 */
type CompareBasis = "current" | "previous";

export type SnapshotsPanelProps = {
  open: boolean;
  onClose: () => void;
  /** The note whose snapshots are shown. When null, the panel renders nothing. */
  noteId: NoteId | null;
  /** Current note title, for the header subtitle (display only). */
  noteTitle: string | null;
  /**
   * Called after a successful restore so the host can re-read the open note's
   * editor body from disk (restore overwrites the `.myn` out-of-band of the
   * editor's autosave). Without this the open buffer stays stale until the user
   * reselects the note.
   */
  onRestored?: () => void;
};

export function SnapshotsPanel({
  open,
  onClose,
  noteId,
  noteTitle,
  onRestored,
}: SnapshotsPanelProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  // Trap + restore focus while open (MYND-93).
  useFocusTrap(dialogRef, { enabled: open });
  // The rest of the page goes INERT while this is open (myne-md/myne#728).
  // The focus trap above contains Tab; it does not stop a screen reader's
  // virtual cursor reading the page behind, and `aria-modal` is an assertion
  // some assistive technology ignores. Registered on the BACKDROP, which is
  // the whole overlay: registering the card would inert the backdrop it is in.
  const backdropRef = useRef<HTMLDivElement>(null);
  useOverlayInert(backdropRef, open);

  const [snaps, setSnaps] = useState<SnapshotMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [current, setCurrent] = useState<string>("");
  const [detailError, setDetailError] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [compareAgainst, setCompareAgainst] = useState<CompareBasis>("current");
  // The older snapshot's decrypted body — only fetched in `previous` mode.
  const [basis, setBasis] = useState<string | null>(null);
  const [basisError, setBasisError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    if (noteId === null) return;
    setLoading(true);
    setListError(null);
    try {
      const list = await snapshotList(noteId);
      setSnaps(list);
    } catch (err) {
      setSnaps([]);
      setListError(formatSnapshotError(err));
    } finally {
      setLoading(false);
    }
  }, [noteId]);

  // Load the snapshot list on open / note change; reset transient state.
  useEffect(() => {
    if (!open) return;
    setSelected(null);
    setPreview(null);
    setDetailError(null);
    setStatus(null);
    setCompareAgainst("current");
    void loadList();
  }, [open, loadList]);

  // Esc closes the panel (when no confirm is layered on top).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && confirmRestore === null) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, confirmRestore, onClose]);

  const selectSnapshot = useCallback(
    async (uuid: string) => {
      if (noteId === null) return;
      setSelected(uuid);
      setPreview(null);
      setDetailError(null);
      try {
        const [body, cur] = await Promise.all([
          snapshotPreview(noteId, uuid),
          noteRead(noteId).catch(() => ""),
        ]);
        setPreview(body);
        setCurrent(cur);
      } catch (err) {
        setDetailError(formatSnapshotError(err));
      }
    },
    [noteId],
  );

  const doRestore = useCallback(async () => {
    if (noteId === null || confirmRestore === null) return;
    const uuid = confirmRestore;
    setConfirmRestore(null);
    try {
      await snapshotRestore(noteId, uuid);
      // Re-read the open note's editor body from disk — restore overwrote the
      // `.myn` via the backend, so the editor's buffer is otherwise stale.
      onRestored?.();
      setStatus(t("notes.snapshots.restoredStatus"));
      setSelected(null);
      setPreview(null);
      await loadList();
    } catch (err) {
      setStatus(formatSnapshotError(err));
    }
  }, [noteId, confirmRestore, loadList, onRestored, t]);

  const handleBackdrop = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  // The list is newest-first, so the snapshot "before" the selected one — the
  // one it was taken after — is the NEXT entry, not the previous one. The
  // oldest snapshot has none, and that is a state the surface has to say out
  // loud rather than render as an empty diff.
  const previousUuid: string | null = useMemo(() => {
    if (selected === null) return null;
    const idx = snaps.findIndex((s) => s.snapshot_uuid === selected);
    if (idx < 0) return null;
    return snaps[idx + 1]?.snapshot_uuid ?? null;
  }, [snaps, selected]);

  // Decrypt the older snapshot on demand — `current` mode never pays for it.
  useEffect(() => {
    setBasis(null);
    setBasisError(null);
    if (compareAgainst !== "previous" || noteId === null || previousUuid === null) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const body = await snapshotPreview(noteId, previousUuid);
        if (!cancelled) setBasis(body);
      } catch (err) {
        if (!cancelled) setBasisError(formatSnapshotError(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compareAgainst, noteId, previousUuid]);

  const diff: DiffLine[] | null = useMemo(() => {
    if (preview === null) return null;
    if (compareAgainst === "previous") {
      return basis === null ? null : diffWithSegments(basis, preview);
    }
    return diffWithSegments(preview, current);
  }, [preview, current, compareAgainst, basis]);

  const compareOptions: readonly SelectOption<CompareBasis>[] = useMemo(
    () => [
      { value: "current", label: t("notes.snapshots.compareCurrent") },
      { value: "previous", label: t("notes.snapshots.comparePrevious") },
    ],
    [t],
  );

  if (!open || noteId === null) return null;

  const count = snaps.length;

  return (
    <div
      ref={backdropRef}
      style={BACKDROP_STYLE}
      onClick={handleBackdrop}
      role="presentation"
    >
      <div
        ref={dialogRef}
        style={PANEL_STYLE}
        role="dialog"
        aria-modal="true"
        data-testid="snapshots.panel"
        aria-labelledby="snapshots-panel-title"
      >
        <div style={HEADER_STYLE}>
          <h2 id="snapshots-panel-title" style={HEADER_TITLE_STYLE}>
            {t("notes.snapshots.title")}
          </h2>
          <span
            style={SUBTITLE_STYLE}
            title={noteTitle ?? t("notes.snapshots.untitled")}
          >
            {noteTitle && noteTitle.trim() !== ""
              ? noteTitle
              : t("notes.snapshots.untitled")}
          </span>
        </div>

        {count === 0 && !loading ? (
          <div style={EMPTY_STATE_STYLE}>
            {listError ?? t("notes.snapshots.emptyState")}
          </div>
        ) : (
          <div style={BODY_STYLE}>
            <div style={LIST_STYLE} aria-label={t("notes.snapshots.listLabel")}>
              {loading && snaps.length === 0 ? (
                <div style={{ ...ROW_META_STYLE, padding: "var(--space-3) var(--space-5)" }}>
                  {t("notes.snapshots.loading")}
                </div>
              ) : (
                snaps.map((s, idx) => {
                  const isSel = s.snapshot_uuid === selected;
                  return (
                    <button
                      key={s.snapshot_uuid}
                      type="button"
                      {...hoverSurface({
                        restBg: isSel ? "var(--accent-soft)" : "transparent",
                        hoverBg: isSel ? "var(--accent-soft)" : "var(--bg-3)",
                      })}
                      style={isSel ? ROW_SELECTED_STYLE : ROW_STYLE}
                      aria-pressed={isSel}
                      data-testid="snapshots.row"
                      data-snapshot-id={s.snapshot_uuid}
                      data-index={idx}
                      onClick={() => void selectSnapshot(s.snapshot_uuid)}
                    >
                      <span style={ROW_AGE_STYLE}>
                        {formatRelativeTime(new Date(s.captured_at_ms)) ||
                          t("notes.snapshots.justNow")}
                      </span>
                      <span style={ROW_META_STYLE}>
                        {t("notes.snapshots.encryptedSize", {
                          size: formatBytes(s.size_bytes),
                        })}
                      </span>
                    </button>
                  );
                })
              )}
            </div>

            <div style={DETAIL_STYLE}>
              {selected === null ? (
                <div style={PLACEHOLDER_STYLE}>
                  {t("notes.snapshots.selectPlaceholder")}
                </div>
              ) : detailError !== null ? (
                <div style={PLACEHOLDER_STYLE}>{detailError}</div>
              ) : preview === null ? (
                <div style={PLACEHOLDER_STYLE}>
                  {t("notes.snapshots.decrypting")}
                </div>
              ) : (
                <>
                  <div style={DETAIL_BAR_STYLE}>
                    <div style={DETAIL_GROUP_STYLE}>
                      <span style={ROW_META_STYLE}>
                        {t("notes.snapshots.compareAgainstLabel")}
                      </span>
                      <Select
                        value={compareAgainst}
                        options={compareOptions}
                        onChange={setCompareAgainst}
                        aria-label={t("notes.snapshots.compareAgainstLabel")}
                        testId="snapshots.compare-against"
                        style={COMPARE_SELECT_STYLE}
                      />
                    </div>
                    <div style={DETAIL_GROUP_STYLE}>
                      <span style={ROW_META_STYLE}>
                        {diff
                          ? t(
                              compareAgainst === "previous"
                                ? "notes.snapshots.changeCountPrev"
                                : "notes.snapshots.changeCount",
                              { count: changedLineCount(diff) },
                            )
                          : ""}
                      </span>
                      <button
                        type="button"
                        {...hoverSurface({
                          restBg: "var(--paper-2)",
                          hoverBg: "var(--paper-3)",
                        })}
                        style={RESTORE_BTN_STYLE}
                        data-testid="snapshots.restore"
                        data-snapshot-id={selected}
                        onClick={() => setConfirmRestore(selected)}
                      >
                        {t("notes.snapshots.restoreCta")}
                      </button>
                    </div>
                  </div>
                  <div
                    style={PREVIEW_STYLE}
                    data-testid="snapshots.preview"
                    data-compare-against={compareAgainst}
                  >
                    {compareAgainst === "previous" && previousUuid === null ? (
                      <div
                        style={PLACEHOLDER_STYLE}
                        data-testid="snapshots.no-previous"
                      >
                        {t("notes.snapshots.noPrevious")}
                      </div>
                    ) : basisError !== null ? (
                      <div style={PLACEHOLDER_STYLE}>{basisError}</div>
                    ) : diff === null ? (
                      <div style={PLACEHOLDER_STYLE}>
                        {t("notes.snapshots.decrypting")}
                      </div>
                    ) : (
                      <DiffView diff={diff} mode="unified" />
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        <div style={FOOTER_STYLE}>
          {status !== null && <span style={STATUS_STYLE}>{status}</span>}
          <button
            type="button"
            {...hoverSurface({
              restBg: "var(--paper-2)",
              hoverBg: "var(--paper-3)",
            })}
            style={{ ...BTN_STYLE, marginInlineStart: "auto" }}
            onClick={onClose}
          >
            {t("notes.snapshots.close")}
          </button>
        </div>
      </div>

      {confirmRestore !== null && (
        <RestoreConfirm
          onCancel={() => setConfirmRestore(null)}
          onConfirm={() => void doRestore()}
        />
      )}
    </div>
  );
}

// Restore confirmation — a lightweight modal that does NOT reuse
// `<DeleteConfirmModal>` because that hardcodes "This cannot be undone.", which
// is wrong for restore: the backend captures the current note as an undo point
// first (SYNC-5), so restore IS reversible. Cancel is default-focused; Esc
// cancels.
const CONFIRM_CARD_STYLE: CSSProperties = {
  width: 380,
  maxWidth: "90vw",
  background: "var(--paper)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-3)",
  boxShadow: "var(--shadow-3)",
  padding: "var(--space-5)",
  fontFamily: "var(--font-sans)",
};

const CONFIRM_TITLE_STYLE: CSSProperties = {
  fontSize: 15,
  fontWeight: "var(--weight-semibold)",
  color: "var(--fg-1)",
  margin: "0 0 var(--space-2)",
};

const CONFIRM_BODY_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
  margin: "0 0 var(--space-5)",
  lineHeight: 1.5,
};

const CONFIRM_ROW_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--space-3)",
};

function RestoreConfirm({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  // The confirm is a SECOND overlay stacked on the panel's own backdrop, and
  // the owner's contract is "whatever is on top owns the page" (myne-md/myne#728,
  // review). Without this, the panel content behind the confirm stayed
  // reachable by a virtual cursor and a click, because the panel's own
  // registration was the only one on the stack.
  const backdropRef = useRef<HTMLDivElement>(null);
  useOverlayInert(backdropRef, true);

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      ref={backdropRef}
      style={BACKDROP_STYLE}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      role="presentation"
    >
      <div
        style={CONFIRM_CARD_STYLE}
        role="dialog"
        aria-modal="true"
        data-testid="snapshots.restore-confirm"
        aria-labelledby="restore-confirm-title"
      >
        <h2 id="restore-confirm-title" style={CONFIRM_TITLE_STYLE}>
          {t("notes.snapshots.confirmTitle")}
        </h2>
        <p style={CONFIRM_BODY_STYLE}>{t("notes.snapshots.confirmBody")}</p>
        <div style={CONFIRM_ROW_STYLE}>
          <button
            ref={cancelRef}
            type="button"
            {...hoverSurface({
              restBg: "var(--paper-2)",
              hoverBg: "var(--paper-3)",
            })}
            style={BTN_STYLE}
            data-testid="snapshots.restore-cancel"
            onClick={onCancel}
          >
            {t("notes.snapshots.cancel")}
          </button>
          <button
            type="button"
            {...hoverSurface({
              restBg: "var(--paper-2)",
              hoverBg: "var(--paper-3)",
            })}
            style={RESTORE_BTN_STYLE}
            data-testid="snapshots.restore-confirm-cta"
            onClick={onConfirm}
          >
            {t("notes.snapshots.restore")}
          </button>
        </div>
      </div>
    </div>
  );
}
