// Delete-with-warning dialog (MYND-170). Lists the notes that reference the
// attachment (SYNC-6 amended — exact note list, not just a count) so the
// user doesn't remove something in use by accident. On confirm, calls
// `attachmentDelete`. Deleting a referenced attachment leaves a tombstone in
// those notes (the editor sub-feature owns the tombstone render, SYNC-7).
//
// The confirm button uses the `--danger` token (via Button variant="danger")
// — deleting a referenced file is a harder action than the shipped
// soft-trash, per the design note in the library frames (`--danger`, not
// `--warning`).

import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "../primitives/ModalShell";
import { Button } from "../primitives/Button";
import type { CatalogEntry } from "../../lib/attachments";
import type { NoteId } from "../../notes/sidebarState";
import type { TitleRecord } from "../../notes/loadNoteBatch";

interface DeleteAttachmentDialogProps {
  attachment: CatalogEntry;
  /** Note-ids referencing the attachment (already fetched by the caller). */
  referencingNoteIds: readonly string[];
  cache: ReadonlyMap<NoteId, TitleRecord>;
  /** Perform the delete; resolves on success, rejects on IPC failure. */
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

const BODY_STYLE: CSSProperties = {
  padding: "var(--space-4) var(--space-5)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-base)",
  color: "var(--fg-1)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
};

const NAME_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
  wordBreak: "break-all",
};

const NOTE_LIST_STYLE: CSSProperties = {
  margin: 0,
  paddingInlineStart: "var(--space-5)",
  maxHeight: 160,
  overflowY: "auto",
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const FOOTER_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--space-2)",
  padding: "var(--space-3) var(--space-5) var(--space-4)",
};

const ERROR_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--danger)",
};

export function DeleteAttachmentDialog({
  attachment,
  referencingNoteIds,
  cache,
  onConfirm,
  onClose,
}: DeleteAttachmentDialogProps) {
  const { t } = useTranslation();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = referencingNoteIds.length;

  const handleConfirm = () => {
    setDeleting(true);
    setError(null);
    void onConfirm()
      .then(() => onClose())
      .catch(() => {
        setDeleting(false);
        setError(t("attachments.deleteDialog.error"));
      });
  };

  return (
    <ModalShell
      open
      title={t("attachments.deleteDialog.title")}
      onClose={deleting ? () => {} : onClose}
      labelId="delete-attachment-title"
      width={460}
      closeLabel={t("attachments.deleteDialog.cancel")}
    >
      <div style={BODY_STYLE}>
        <div>{t("attachments.deleteDialog.confirmPrompt")}</div>
        <div style={NAME_STYLE}>{attachment.filename}</div>
        {n > 0 ? (
          <>
            <div>
              {t("attachments.deleteDialog.stillUsed", { count: n })}
            </div>
            <ul style={NOTE_LIST_STYLE}>
              {referencingNoteIds.map((id) => {
                const title = cache.get(id as NoteId)?.title ?? null;
                const label =
                  title === null || title.trim() === ""
                    ? t("attachments.deleteDialog.untitled")
                    : title;
                return <li key={id}>{label}</li>;
              })}
            </ul>
          </>
        ) : (
          <div style={{ color: "var(--fg-3)", fontSize: "var(--text-sm)" }}>
            {t("attachments.deleteDialog.notUsed")}
          </div>
        )}
        {error !== null && <div style={ERROR_STYLE}>{error}</div>}
      </div>
      <div style={FOOTER_STYLE}>
        <Button
          variant="ghost"
          onClick={onClose}
          disabled={deleting}
          data-testid="delete-attachment.cancel"
        >
          {t("attachments.deleteDialog.cancel")}
        </Button>
        <Button
          variant="danger"
          onClick={handleConfirm}
          disabled={deleting}
          data-testid="delete-attachment.confirm"
        >
          {deleting ? t("attachments.deleteDialog.deleting") : t("attachments.deleteDialog.delete")}
        </Button>
      </div>
    </ModalShell>
  );
}
