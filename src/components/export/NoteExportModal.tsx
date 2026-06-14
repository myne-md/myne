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

import { useEffect, useState, type CSSProperties } from "react";
import { Button } from "../primitives/Button";
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
  fontSize: 16,
  fontWeight: 600,
  color: "var(--fg-1)",
};

export const SENTENCE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: 13,
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
  fontSize: 13,
  color: "var(--fg-1)",
  cursor: "pointer",
};

const SUB_LABEL_STYLE: CSSProperties = {
  margin: 0,
  fontSize: 11,
  lineHeight: 1.5,
  color: "var(--fg-3)",
  // Indent under the checkbox (13px box + gap) so the sub-label aligns
  // with the toggle's label text, as in the Penpot frame.
  paddingLeft: "calc(13px + var(--space-2))",
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
}: NoteExportModalProps) {
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
      role="dialog"
      aria-modal="true"
      aria-labelledby="note-export-title"
      style={BACKDROP_STYLE}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div style={CARD_STYLE} data-testid="export.modal">
        <h2 id="note-export-title" style={TITLE_STYLE}>
          Export as Markdown
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
              Include {attachmentCount} attachment
              {attachmentCount === 1 ? "" : "s"}
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
            Cancel
          </Button>
          <Button
            variant="primary"
            style={{ height: 36 }}
            onClick={() => onConfirm(include)}
            data-testid="export.confirm"
          >
            Export…
          </Button>
        </div>
      </div>
    </div>
  );
}
