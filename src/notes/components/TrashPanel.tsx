// `<TrashPanel>` — the vault trash view (MYND-133). A modal overlay (reusing
// the `<DeleteConfirmModal>` / `<SettingsModal>` backdrop envelope) listing
// soft-deleted notes with their relative trashed-age. Per row: Restore
// (reversible, no confirm) + Delete permanently (scary confirm). Footer:
// Empty trash (count-aware scary confirm). Empty state when nothing is trashed.
//
// Trash state is the value-strict `trashed:` marker (`trashedRecords` selector);
// Restore = `restoreWithRollback`, single purge = `deleteWithRollback`, empty =
// `emptyTrashWithSync` (best-effort; partial failure reports a remaining count).

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
import {
  trashedRecords,
  useSelectedNote,
  type NoteId,
} from "../sidebarState";
import { Icon } from "../../components/primitives/Icon";
import { useWorkspace } from "../workspaceContext";
import { BACKDROP_STYLE, DeleteConfirmModal } from "./DeleteConfirmModal";
import { PanelEmptyState } from "./PanelEmptyState";
import {
  AGE_STYLE,
  COUNT_STYLE,
  HEADER_CLOSE_STYLE,
  HEADER_LEFT_STYLE,
  HEADER_RIGHT_STYLE,
  HEADER_STYLE,
  HEADER_TITLE_STYLE,
  LIST_STYLE,
  PANEL_STYLE,
  ROW_ACTIONS_STYLE,
  ROW_BTN_STYLE,
  ROW_ICON_BTN_STYLE,
  ROW_STYLE,
  ROW_TITLE_STYLE,
  STATUS_LINE_STYLE,
} from "./notePanelStyles";
import { formatRelativeTime } from "./relativeTime";
import {
  hoverSurface,
  HOVER_TRANSITION,
} from "../../components/primitives/hoverSurface";

// Trash-only "Empty trash" action, now in the header cluster (#226
// follow-up: the footer row is gone, close is a header ✕). Danger-tinted so the
// irreversible bulk purge is distinct from restore.
const EMPTY_TRASH_BTN_STYLE: CSSProperties = {
  ...ROW_BTN_STYLE,
  color: "var(--danger)",
  borderColor: "color-mix(in srgb, var(--danger) 40%, transparent)",
  transition: HOVER_TRANSITION,
};

/**
 * A staged purge, plus how it was asked for. `viaKey` is the activating event's
 * own answer (`detail === 0` is keyboard activation) and it reaches
 * `DeleteConfirmModal` as `openedByKey`: both of these are the cryptographic
 * erase of `design-notes/storage/0105`, so a key that is still held from
 * opening the dialog must not be able to answer it.
 */
type Confirm =
  | { kind: "single"; id: NoteId; title: string | null; viaKey: boolean }
  | { kind: "empty"; ids: NoteId[]; viaKey: boolean }
  | null;

export type TrashPanelProps = {
  open: boolean;
  onClose: () => void;
};

export function TrashPanel({ open, onClose }: TrashPanelProps) {
  const { t } = useTranslation();
  const ctx = useSelectedNote();
  const ws = useWorkspace();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [status, setStatus] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // The rest of the page goes INERT while this is open (myne-md/myne#728).
  // The focus trap above contains Tab; it does not stop a screen reader's
  // virtual cursor reading the page behind, and `aria-modal` is an assertion
  // some assistive technology ignores. Registered on the BACKDROP, which is
  // the whole overlay: registering the card would inert the backdrop it is in.
  const backdropRef = useRef<HTMLDivElement>(null);
  useOverlayInert(backdropRef, open);
  // Trap + restore focus while open (MYND-93).
  useFocusTrap(dialogRef, { enabled: open });


  const records = useMemo(() => trashedRecords(ctx.cache), [ctx.cache]);

  // Esc closes the panel (when no confirm is layered on top).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && confirm === null) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, confirm, onClose]);

  // Clear the partial-failure status whenever the panel reopens.
  useEffect(() => {
    if (open) setStatus(null);
  }, [open]);

  const handleBackdrop = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  const restore = useCallback(
    (id: NoteId) => {
      void ctx.restoreWithRollback(id).catch(() => {
        setStatus(t("notes.trash.restoreError"));
      });
    },
    [ctx, t],
  );

  const confirmPurge = useCallback(async () => {
    if (confirm === null) return;
    if (confirm.kind === "single") {
      const id = confirm.id;
      setConfirm(null);
      try {
        await ctx.deleteWithRollback(id);
        // Permanently deleting a note that is open must close its tabs, or the
        // pane keeps showing an editable buffer for a note that no longer
        // exists (myne-md/myne#819). Only on SUCCESS: a failed delete rolled
        // back and the note still exists, so its tab must stay.
        ws.closeNoteEverywhere(id);
      } catch {
        setStatus(t("notes.trash.deleteError"));
      }
      return;
    }
    // empty trash — best-effort bulk purge with a remaining count on failure.
    // Re-derive the kill list from the CURRENT trashed set at confirm time (not
    // the snapshot taken when the modal opened): a note restored while the
    // confirm was up — e.g. via the undo toast, which floats above the modal —
    // must NOT be purged (MYND-133; PR-review F1, "no note loss").
    setConfirm(null);
    const ids = trashedRecords(ctx.cache).map((r) => r.noteUuid);
    const result = await ctx.emptyTrashWithSync(ids);
    // Close the tabs of the notes that WERE purged, so none stays editable
    // after its blob is gone (myne-md/myne#819). A failed purge rolled back and
    // the note still exists, so its tab stays.
    for (const id of result.purged) ws.closeNoteEverywhere(id);
    if (result.failed.length > 0) {
      setStatus(
        t("notes.trash.emptyPartialFailure", { count: result.failed.length }),
      );
    }
  }, [confirm, ctx, t, ws]);

  if (!open) return null;

  const count = records.length;

  return (
    <div
      ref={backdropRef}
      style={{
        ...BACKDROP_STYLE,
        animation: "settings-backdrop-in var(--duration-fast) var(--ease-standard)",
      }}
      onClick={handleBackdrop}
      role="presentation"
    >
      <div
        ref={dialogRef}
        style={PANEL_STYLE}
        role="dialog"
        aria-modal="true"
        data-testid="trash.panel"
        aria-labelledby="trash-panel-title"
      >
        <div style={HEADER_STYLE}>
          <div style={HEADER_LEFT_STYLE}>
            <h2 id="trash-panel-title" style={HEADER_TITLE_STYLE}>
              {t("notes.trash.title")}
            </h2>
            {count > 0 && (
              <span style={COUNT_STYLE}>{t("notes.trash.count", { count })}</span>
            )}
          </div>
          <div style={HEADER_RIGHT_STYLE}>
            {count > 0 && (
              <button
                type="button"
                {...hoverSurface({
                  restBg: "var(--paper-2)",
                  hoverBg: "var(--paper-3)",
                })}
                style={EMPTY_TRASH_BTN_STYLE}
                data-testid="trash.empty"
                onClick={(e) =>
                  setConfirm({
                    kind: "empty",
                    ids: records.map((r) => r.noteUuid),
                    viaKey: e.detail === 0,
                  })
                }
              >
                {t("notes.trash.empty")}
              </button>
            )}
            <button
              type="button"
              style={HEADER_CLOSE_STYLE}
              data-panel-action="close"
              data-testid="trash.close"
              title={t("notes.trash.close")}
              aria-label={t("notes.trash.close")}
              onClick={onClose}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>
        {status !== null && <div style={STATUS_LINE_STYLE}>{status}</div>}

        {count === 0 ? (
          <PanelEmptyState
            icon="trash-2"
            title={t("notes.trash.emptyTitle")}
            body={t("notes.trash.emptyBody")}
            testId="trash.empty-state"
          />
        ) : (
          <div style={LIST_STYLE}>
            {records.map((r) => (
              <div key={r.noteUuid} style={ROW_STYLE}>
                <span
                  style={ROW_TITLE_STYLE}
                  title={r.title ?? t("notes.trash.untitled")}
                >
                  {r.title === null || r.title.trim() === ""
                    ? t("notes.trash.untitled")
                    : r.title}
                </span>
                <span style={AGE_STYLE}>
                  {r.trashed !== null
                    ? formatRelativeTime(new Date(r.trashed))
                    : ""}
                </span>
                <div style={ROW_ACTIONS_STYLE}>
                  <button
                    type="button"
                    style={ROW_ICON_BTN_STYLE}
                    data-panel-action="restore"
                    data-testid="trash.restore"
                    data-note-id={r.noteUuid}
                    title={t("notes.trash.restore")}
                    aria-label={t("notes.trash.restore")}
                    onClick={() => restore(r.noteUuid)}
                  >
                    <Icon name="rotate-ccw" size={16} />
                  </button>
                  <button
                    type="button"
                    style={ROW_ICON_BTN_STYLE}
                    data-panel-action="delete"
                    data-testid="trash.delete"
                    data-note-id={r.noteUuid}
                    title={t("notes.trash.delete")}
                    aria-label={t("notes.trash.delete")}
                    onClick={(e) =>
                      setConfirm({
                        kind: "single",
                        id: r.noteUuid,
                        title: r.title,
                        viaKey: e.detail === 0,
                      })
                    }
                  >
                    <Icon name="trash-2" size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

      </div>

      {confirm !== null && confirm.kind === "single" && (
        <DeleteConfirmModal
          noteTitle={confirm.title}
          title={t("notes.trash.purgeConfirmTitle")}
          confirmLabel={t("notes.trash.purgeConfirmCta")}
          openedByKey={confirm.viaKey}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void confirmPurge()}
        />
      )}
      {confirm !== null && confirm.kind === "empty" && (
        <DeleteConfirmModal
          title={t("notes.trash.emptyConfirmTitle")}
          body={t("notes.trash.emptyConfirmBody", {
            count: confirm.ids.length,
          })}
          confirmLabel={t("notes.trash.emptyConfirmCta")}
          openedByKey={confirm.viaKey}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void confirmPurge()}
        />
      )}
    </div>
  );
}
