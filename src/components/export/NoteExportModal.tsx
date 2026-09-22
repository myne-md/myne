// Pre-flight "Include attachments" mini-modal for the per-note markdown
// export flow (MYND-116 task 3). Shown ONLY when the note's body
// references attachments; the flow (`src/notes/exportFlow.ts`) asks the
// question through the Editor's `confirmAttachments` hook and this modal
// renders it. Cancel (button / Esc / backdrop) is a free exit — nothing
// invoked, nothing written.
//
// Penpot canon: page "4 — Desktop UI Kit", section
// `section------export — include-attachments mini-modal (MYND-116)`,
// card 7ce0774a-2624-8032-8008-28b2d74f8b33. Anatomy implemented to the
// frame: 420px card (radius 10 = --radius-3, --paper surface, --line-2
// border); 16px title; the one plain 13px egress sentence (NO banner, no
// icon — load-bearing copy, rendered verbatim); a recessed sub-panel
// (--paper-2, --line-1 border, radius 6 = --radius-2) carrying the
// checkbox + 11px placement sub-label; right-aligned 36px Cancel /
// "Export…" footer. The modal is deliberately thin: all decision logic
// lives in the flow — this component only renders the question and
// reports the answer.
//
// The anatomy style constants are exported for the export siblings
// (`NotePdfExportNotice.tsx`, MYND-255; `VaultExportModal.tsx`, MYND-211,
// which widens the card to 480) — one modal skin, three surfaces.

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useOverlayInert } from "../../hooks/useOverlayInert";
import { Button } from "../primitives/Button";
import { IconButton } from "../primitives/IconButton";
import {
  EXPORT_ATTACHMENTS_PLACEMENT_SUBLABEL,
  EXPORT_PLAIN_MARKDOWN_SENTENCE,
} from "../../lib/load-bearing-copy";

interface NoteExportModalProps {
  open: boolean;
  /** Number of attachments the note references (> 0 when open). */
  attachmentCount: number;
  /** Free exit — fired by the Cancel button, Esc, and backdrop click. */
  onCancel: () => void;
  /** "Export…" — carries the toggle's state. */
  onConfirm: (includeAttachments: boolean) => void;
  /**
   * Copy the note's markdown to the clipboard instead of writing a file
   * (MYND-643). Icon-only, beside Export: the common case is getting the text
   * into another app, and going through a save dialog and then opening the file
   * is a long way round for that.
   *
   * Same TB3 posture as Export — deliberate, user-initiated plaintext egress —
   * but a DIFFERENT surface, not a shortcut for the same one: the clipboard is
   * readable by any local app and the user does not choose where it lands.
   * `docs/threat-model.md` §5's export exception already covers user-initiated
   * plaintext egress, so no spec change; it earns the mention because "copy" is
   * easy to read as cosmetic.
   *
   * Ignores the include-attachments toggle: a clipboard holds text, so there is
   * nowhere for attachment bytes to go. The caller's toast says what landed.
   */
  onCopy: () => void;
}

export const BACKDROP_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

export const CARD_STYLE: CSSProperties = {
  width: 420,
  maxWidth: "calc(100vw - var(--space-7))",
  background: "var(--paper)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-3)",
  boxShadow: "var(--shadow-3)",
  padding: "var(--space-5)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-4)",
  fontFamily: "var(--font-sans)",
};

export const TITLE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-md)",
  fontWeight: "var(--weight-semibold)",
  color: "var(--fg-1)",
};

export const SENTENCE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  lineHeight: 1.5,
  color: "var(--fg-2)",
};

export const SUB_PANEL_STYLE: CSSProperties = {
  background: "var(--paper-2)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  padding: "var(--space-3) var(--space-4)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-1)",
};

const TOGGLE_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
  cursor: "pointer",
};

const SUB_LABEL_STYLE: CSSProperties = {
  margin: 0,
  fontSize: "var(--text-xs)",
  lineHeight: 1.5,
  color: "var(--fg-3)",
  // Indent under the checkbox (13px box + gap) so the sub-label aligns
  // with the toggle's label text, as in the Penpot frame.
  paddingInlineStart: "calc(13px + var(--space-2))",
};

export const FOOTER_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--space-2)",
};

export function NoteExportModal({
  open,
  attachmentCount,
  onCancel,
  onConfirm,
  onCopy,
}: NoteExportModalProps) {
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

  // Opt-in default (the backend command is the "opt-in attachments-
  // included export"): the toggle starts OFF on every open.
  const [include, setInclude] = useState(false);
  useEffect(() => {
    if (open) setInclude(false);
  }, [open]);

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
      ref={backdropRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="note-export-title"
      style={BACKDROP_STYLE}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div ref={dialogRef} style={CARD_STYLE} data-testid="export.modal">
        <h2 id="note-export-title" style={TITLE_STYLE}>
          {t("export.note.modal.title")}
        </h2>
        <p style={SENTENCE_STYLE}>{EXPORT_PLAIN_MARKDOWN_SENTENCE}</p>
        <div style={SUB_PANEL_STYLE}>
          <label style={TOGGLE_ROW_STYLE}>
            <input
              type="checkbox"
              checked={include}
              onChange={(e) => setInclude(e.target.checked)}
              style={{ margin: 0, accentColor: "var(--accent)" }}
              data-testid="export.include-attachments-toggle"
            />
            <span>
              {t("export.note.modal.includeAttachments", {
                count: attachmentCount,
              })}
            </span>
          </label>
          <p style={SUB_LABEL_STYLE}>{EXPORT_ATTACHMENTS_PLACEMENT_SUBLABEL}</p>
        </div>
        <div style={FOOTER_STYLE}>
          <Button
            variant="secondary"
            style={{ height: 36 }}
            onClick={onCancel}
            data-testid="export.cancel"
          >
            {t("export.note.modal.cancel")}
          </Button>
          {/* Icon-only (MYND-643): the label would compete with Export for the
              eye while doing less, and the tooltip carries the meaning. */}
          <IconButton
            icon="copy"
            label={t("export.note.modal.copyLabel")}
            onClick={onCopy}
            testId="export.copy"
          />
          <Button
            variant="primary"
            style={{ height: 36 }}
            onClick={() => onConfirm(include)}
            data-testid="export.confirm"
          >
            {t("export.note.modal.export")}
          </Button>
        </div>
      </div>
    </div>
  );
}
