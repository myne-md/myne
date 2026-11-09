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
import { Button } from "../../components/primitives/Button";
import { IconButton } from "../../components/primitives/IconButton";
import { useWorkspace } from "../workspaceContext";
import { BACKDROP_STYLE, DeleteConfirmModal } from "./DeleteConfirmModal";
import { PanelEmptyState } from "./PanelEmptyState";
import {
  AGE_STYLE,
  COUNT_STYLE,
  HEADER_LEFT_STYLE,
  HEADER_RIGHT_STYLE,
  HEADER_STYLE,
  HEADER_TITLE_STYLE,
  LIST_STYLE,
  PANEL_STYLE,
  ROW_ACTIONS_STYLE,
  ROW_STYLE,
  ROW_TITLE_STYLE,
  STATUS_LINE_STYLE,
} from "./notePanelStyles";
import { formatRelativeTime } from "./relativeTime";

/**
 * Whether the activation that opened a purge left its key DOWN, which is what
 * `DeleteConfirmModal` asks about through `openedByKey`.
 *
 * Only ENTER can. A `<button>` activates on Enter's KEYDOWN and on Space's
 * KEYUP, so a Space-opened dialog is opened by a key that is already up and has
 * nothing to release. `detail === 0` alone cannot tell the two apart, and
 * claiming "a key opened this" for a Space press shut that guard with no key
 * left to open it: Enter then refused until an Enter keyup, which the user's
 * first Enter cannot produce because the keyup follows the keydown it refuses.
 * That is myne-md/myne#683's symptom on the other irreversible dialog, found by
 * the review of the branch that fixed it there.
 */
export function purgeOpenedByHeldEnter(
  detail: number,
  lastActivationKey: string | null,
): boolean {
  return detail === 0 && lastActivationKey === "Enter";
}

/**
 * A staged purge, plus how it was asked for. `viaKey` says the activating key
 * may still be down (see `purgeOpenedByHeldEnter`) and it reaches
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
  // The key of the most recent keydown on a purge opener. Read by
  // `purgeOpenedByHeldEnter` on the click that follows it, which is the only
  // place the Enter/Space difference is visible.
  const lastActivationKey = useRef<string | null>(null);
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
              <Button
                variant="ghost"
                style={{ color: "var(--danger)" }}
                data-testid="trash.empty"
                onKeyDown={(e) => {
                  lastActivationKey.current = e.key;
                }}
                onClick={(e) =>
                  setConfirm({
                    kind: "empty",
                    ids: records.map((r) => r.noteUuid),
                    viaKey: purgeOpenedByHeldEnter(
                      e.detail,
                      lastActivationKey.current,
                    ),
                  })
                }
              >
                {t("common.emptytrash")}
              </Button>
            )}
            <IconButton
              icon="x"
              label={t("common.close")}
              tooltip
              testId="trash.close"
              onClick={onClose}
            />
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
                  title={r.title ?? t("common.untitled")}
                >
                  {r.title === null || r.title.trim() === ""
                    ? t("common.untitled")
                    : r.title}
                </span>
                <span style={AGE_STYLE}>
                  {r.trashed !== null
                    ? formatRelativeTime(new Date(r.trashed))
                    : ""}
                </span>
                <div style={ROW_ACTIONS_STYLE}>
                  <IconButton
                    icon="rotate-ccw"
                    label={t("notes.trash.restore")}
                    tooltip
                    testId="trash.restore"
                    onClick={() => restore(r.noteUuid)}
                  />
                  <Button
                    variant="ghost"
                    style={{ color: "var(--danger)", padding: "var(--space-1)" }}
                    data-testid="trash.delete"
                    aria-label={t("notes.trash.delete")}
                    onKeyDown={(e) => {
                      lastActivationKey.current = e.key;
                    }}
                    onClick={(e) =>
                      setConfirm({
                        kind: "single",
                        id: r.noteUuid,
                        title: r.title,
                        viaKey: purgeOpenedByHeldEnter(
                          e.detail,
                          lastActivationKey.current,
                        ),
                      })
                    }
                  >
                    <Icon name="trash-2" size={16} />
                  </Button>
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
          confirmLabel={t("common.emptytrash")}
          openedByKey={confirm.viaKey}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void confirmPurge()}
        />
      )}
    </div>
  );
}
