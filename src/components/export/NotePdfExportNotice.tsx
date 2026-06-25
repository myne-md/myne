// Pre-export exclusion notice for the per-note PDF export flow
// (MYND-255 task 5). Shown ONLY when the HTML projection excluded
// attachments (PDF / other non-image embeds); the flow
// (`src/notes/exportFlow.ts::runNotePdfExportFlow`) asks through the
// Editor's `confirmPdfExclusions` hook and this notice renders it.
// Cancel (button / Esc / backdrop) is a free exit — nothing invoked,
// nothing written.
//
// Same anatomy as the markdown pre-flight modal (`NoteExportModal.tsx`,
// whose exported style constants this reuses — one modal skin): 420px
// card, 16px title, the two plain 13px load-bearing sentences (the
// egress sentence + the exclusion sentence, rendered VERBATIM from
// `load-bearing-copy.ts`), a recessed sub-panel listing the excluded
// filenames, right-aligned 36px Cancel / "Continue…" footer. There is
// deliberately NO toggle — exclusions aren't optional (product decision:
// embedded PDFs are never carried into the generated PDF).

import { useEffect, useRef, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { Button } from "../primitives/Button";
import {
  EXPORT_PDF_EXCLUSION_SENTENCE,
  EXPORT_PDF_PLAIN_SENTENCE,
} from "../../lib/load-bearing-copy";
import type { ExcludedAttachment } from "../../dialect/html/emitNoteHtml";
import {
  BACKDROP_STYLE,
  CARD_STYLE,
  FOOTER_STYLE,
  SENTENCE_STYLE,
  SUB_PANEL_STYLE,
  TITLE_STYLE,
} from "./NoteExportModal";

interface NotePdfExportNoticeProps {
  open: boolean;
  /** The attachments the projection excluded (non-empty when open). */
  excludedAttachments: readonly ExcludedAttachment[];
  /** Free exit — fired by the Cancel button, Esc, and backdrop click. */
  onCancel: () => void;
  /** "Continue…" — proceed to the save dialog. */
  onConfirm: () => void;
}

const FILE_ROW_STYLE: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.6,
  color: "var(--fg-3)",
  fontFamily: "var(--font-mono)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export function NotePdfExportNotice({
  open,
  excludedAttachments,
  onCancel,
  onConfirm,
}: NotePdfExportNoticeProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  // Trap + restore focus while open (MYND-93).
  useFocusTrap(dialogRef, { enabled: open });
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="note-pdf-export-title"
      style={BACKDROP_STYLE}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div ref={dialogRef} style={CARD_STYLE} data-testid="export.pdf-notice">
        <h2 id="note-pdf-export-title" style={TITLE_STYLE}>
          {t("export.pdf.title")}
        </h2>
        <p style={SENTENCE_STYLE}>{EXPORT_PDF_PLAIN_SENTENCE}</p>
        <p style={SENTENCE_STYLE}>{EXPORT_PDF_EXCLUSION_SENTENCE}</p>
        <div style={SUB_PANEL_STYLE}>
          {excludedAttachments.map((att) => (
            <p key={att.id} style={FILE_ROW_STYLE}>
              {att.filename}
            </p>
          ))}
        </div>
        <div style={FOOTER_STYLE}>
          <Button
            variant="secondary"
            style={{ height: 36 }}
            onClick={onCancel}
            data-testid="export.pdf-cancel"
          >
            {t("export.pdf.cancel")}
          </Button>
          <Button
            variant="primary"
            style={{ height: 36 }}
            onClick={onConfirm}
            data-testid="export.pdf-confirm"
          >
            {t("export.pdf.continue")}
          </Button>
        </div>
      </div>
    </div>
  );
}
