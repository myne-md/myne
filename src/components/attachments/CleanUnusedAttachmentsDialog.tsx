// Review-and-confirm dialog for "Clean unused attachments" (MYND-171). Lists
// every attachment referenced by zero live notes — the kill-list — with a
// thumbnail, filename, and size, plus the total space to be reclaimed, so the
// user sees exactly what will be erased (including freshly-imported-but-not-
// yet-inserted files) and can back out. Nothing is deleted until Confirm.
//
// Erase is irreversible cryptographic erase (no trash tier) — the confirm
// step IS the safety, so the action uses the `--danger` token (Button
// variant="danger"), mirroring DeleteAttachmentDialog. On confirm the dialog
// switches to a one-line summary (removed N · freed X) before closing.

import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { ModalShell } from "../primitives/ModalShell";
import { Button } from "../primitives/Button";
import { AttachmentThumbnail } from "./AttachmentThumbnail";
import { useWarmAttachmentRefs } from "./useWarmAttachmentRefs";
import { formatBytes } from "./format";
import type { CatalogEntry, CleanResult } from "../../lib/attachments";

interface CleanUnusedAttachmentsDialogProps {
  /** The unused set (zero live references), already fetched by the caller. */
  attachments: readonly CatalogEntry[];
  /** Perform the erase; resolves with the summary, rejects on IPC failure. */
  onConfirm: (ids: string[]) => Promise<CleanResult>;
  onClose: () => void;
}

const BODY_STYLE: CSSProperties = {
  padding: "var(--space-4) var(--space-5)",
  fontFamily: "var(--font-sans)",
  fontSize: 14,
  color: "var(--fg-1)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
};

const LIST_STYLE: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
  maxHeight: 280,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-3)",
};

const THUMB_BOX_STYLE: CSSProperties = {
  width: 40,
  height: 40,
  flex: "0 0 auto",
  borderRadius: 6,
  overflow: "hidden",
  border: "1px solid var(--line-1)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--bg-1)",
};

const NAME_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  color: "var(--fg-1)",
  wordBreak: "break-all",
  flex: "1 1 auto",
};

const SIZE_STYLE: CSSProperties = {
  fontSize: 12,
  color: "var(--fg-3)",
  flex: "0 0 auto",
};

const FOOTER_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--space-2)",
  padding: "var(--space-3) var(--space-5) var(--space-4)",
};

const ERROR_STYLE: CSSProperties = {
  fontSize: 13,
  color: "var(--danger)",
};

export function CleanUnusedAttachmentsDialog({
  attachments,
  onConfirm,
  onClose,
}: CleanUnusedAttachmentsDialogProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  // #263: these thumbnails exist SO THE USER SEES what is about to be erased,
  // before an irreversible cryptographic erase — and on web they were blank
  // boxes, because only the library warmed its ids.
  //
  // Deliberately NOT windowed (myne#388): a placeholder here is worse than a
  // decrypt, because the whole point of the thumbnail is that the user sees the
  // thing before it is erased. The set is NOT "independently scanned and already
  // bounded" as this comment used to claim — the unused list returns every
  // unused row, and a vault of imported-but-never-embedded attachments has an
  // unused set equal to its catalog. `MAX_WARMED_IDS` is what bounds it.
  const { warmKey } = useWarmAttachmentRefs(attachments.map((a) => a.id));
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CleanResult | null>(null);

  const totalBytes = attachments.reduce((sum, a) => sum + a.size, 0);
  const n = attachments.length;

  const handleConfirm = () => {
    setBusy(true);
    setError(null);
    void onConfirm(attachments.map((a) => a.id))
      .then((r) => {
        setResult(r);
        setBusy(false);
      })
      .catch((e: unknown) => {
        setBusy(false);
        // The corpus can go incomplete BETWEEN the list and the confirm — a
        // browser tab that lost storage, a desktop that fell behind. The core
        // re-checks at the destructive step (task 89), and the message has to
        // match: "couldn't clean up" would send the user to retry something that
        // is refusing on purpose.
        const kind = (e as { kind?: string } | null)?.kind;
        setError(
          kind === "CorpusIncomplete"
            ? t("attachments.cleanUnused.corpusIncomplete")
            : t("attachments.cleanUnused.error"),
        );
      });
  };

  // ---- done phase: one-line summary, then Close ----
  if (result !== null) {
    return (
      <ModalShell
        open
        title={t("attachments.cleanUnused.completeTitle")}
        onClose={onClose}
        labelId="clean-unused-title"
        width={460}
        closeLabel={t("attachments.cleanUnused.close")}
      >
        <div style={BODY_STYLE} data-testid="clean-unused.summary">
          <div>
            {t("attachments.cleanUnused.summaryRemoved", { count: result.deleted })}
            {result.bytes_reclaimed > 0
              ? t("attachments.cleanUnused.summaryFreed", {
                  size: formatBytes(result.bytes_reclaimed),
                })
              : ""}
            {result.skipped > 0
              ? t("attachments.cleanUnused.summarySkipped", { count: result.skipped })
              : ""}
            {t("attachments.cleanUnused.summaryPeriod")}
          </div>
        </div>
        <div style={FOOTER_STYLE}>
          <Button
            variant="secondary"
            onClick={onClose}
            data-testid="clean-unused.close"
          >
            {t("attachments.cleanUnused.close")}
          </Button>
        </div>
      </ModalShell>
    );
  }

  // ---- review phase: the kill-list + Confirm / Cancel ----
  return (
    <ModalShell
      open
      title={t("attachments.cleanUnused.title")}
      onClose={busy ? () => {} : onClose}
      labelId="clean-unused-title"
      width={460}
      closeLabel={t("attachments.cleanUnused.cancel")}
    >
      <div style={BODY_STYLE}>
        <div>{t("attachments.cleanUnused.intro", { count: n })}</div>
        <ul style={LIST_STYLE}>
          {attachments.map((a) => (
            <li
              key={warmKey(a.id)}
              style={ROW_STYLE}
              data-testid="clean-unused.row"
            >
              <div style={THUMB_BOX_STYLE}>
                <AttachmentThumbnail
                  id={a.id}
                  contentType={a.content_type}
                  filename={a.filename}
                  size={40}
                />
              </div>
              <span style={NAME_STYLE}>{a.filename}</span>
              <span style={SIZE_STYLE}>{formatBytes(a.size)}</span>
            </li>
          ))}
        </ul>
        <div style={{ color: "var(--fg-3)", fontSize: 13 }}>
          {t("attachments.cleanUnused.willBeReclaimed", {
            size: formatBytes(totalBytes),
          })}
        </div>
        {error !== null && <div style={ERROR_STYLE}>{error}</div>}
      </div>
      <div style={FOOTER_STYLE}>
        <Button
          variant="ghost"
          onClick={onClose}
          disabled={busy}
          data-testid="clean-unused.cancel"
        >
          {t("attachments.cleanUnused.cancel")}
        </Button>
        <Button
          variant="danger"
          onClick={handleConfirm}
          disabled={busy}
          data-testid="clean-unused.confirm"
        >
          {busy
            ? t("attachments.cleanUnused.cleaning")
            : t("attachments.cleanUnused.deleteCta", { count: n })}
        </Button>
      </div>
    </ModalShell>
  );
}
