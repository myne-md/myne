// Template-management surface — modal overlay mounted from `Editor.tsx` when
// the "Manage templates…" command-palette action fires (MYND-189). NOT a Stage
// variant, NOT a 6th Settings panel, NOT a sidebar surface — an Editor-local
// boolean → conditionally-rendered modal, the desktop modal carve-out
// (`decisions.md` 2026-05-08). Shell chrome (backdrop / Esc / dialog / header)
// comes from the shared `ModalShell` primitive.
//
// Lists the user's templates (the `template: true` filter, SYNC-9 `listTemplates`)
// and exposes exactly the SYNC-9 row operations:
//   - New              → createTemplate, open the fresh marked note in the editor
//   - Edit (row click) → open the existing template in the normal note editor
//   - Remove           → convertTemplateToNote (non-destructive demotion)
//   - Delete           → deleteTemplate (normal note soft-trash, recoverable)
// "Remove from templates" and "Delete" are kept visually + verbally distinct so
// demotion is never mistaken for destruction.
//
// Design canon: Penpot page "4 — Desktop UI Kit", `screen------templates--manage`.
// Visual treatment: inline style + CSS-variable design tokens only; reuses
// ModalShell / Button / Icon primitives; sentence case; one iron-blue accent;
// honors prefers-reduced-motion via no motion (parity with SettingsModal).

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Icon } from "./primitives/Icon";
import { Button } from "./primitives/Button";
import { ModalShell } from "./primitives/ModalShell";
import {
  createTemplate,
  convertTemplateToNote,
  deleteTemplate,
  listTemplates,
  type NoteId,
  type TitleRecord,
} from "../notes";

interface TemplatesManagerProps {
  open: boolean;
  onClose: () => void;
  /** Open a template in the normal note editor (selects it + closes the surface). */
  onOpenNote: (id: NoteId) => void;
}

/** Default name for a brand-new template (renamed later via the editor). */
const NEW_TEMPLATE_NAME = "Untitled template";

const TOOLBAR_STYLE: CSSProperties = {
  padding: "var(--space-3) var(--space-5)",
  borderBottom: "1px solid var(--line-1)",
  flex: "0 0 auto",
  display: "flex",
  justifyContent: "flex-start",
};

const LIST_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  padding: "var(--space-2) var(--space-3)",
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  padding: "0 var(--space-2)",
  height: 40,
  borderRadius: "var(--radius-1)",
};

const ROW_OPEN_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  background: "transparent",
  border: 0,
  padding: "0 var(--space-1)",
  height: 36,
  textAlign: "left",
  cursor: "pointer",
  color: "var(--fg-1)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-base)",
  borderRadius: "var(--radius-1)",
};

const ROW_NAME_STYLE: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const REMOVE_BUTTON_STYLE: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "var(--fg-3)",
  cursor: "pointer",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  padding: "4px 8px",
  borderRadius: "var(--radius-1)",
  whiteSpace: "nowrap",
};

const DELETE_BUTTON_STYLE: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "var(--danger)",
  cursor: "pointer",
  padding: 6,
  display: "inline-flex",
  alignItems: "center",
  borderRadius: "var(--radius-1)",
};

const EMPTY_STYLE: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: "var(--space-3)",
  padding: "var(--space-6)",
  textAlign: "center",
  color: "var(--fg-3)",
};

const EMPTY_TITLE_STYLE: CSSProperties = {
  fontSize: "var(--text-base)",
  fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"],
  color: "var(--fg-2)",
  margin: 0,
};

const EMPTY_BODY_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
  margin: 0,
  maxWidth: 320,
  lineHeight: 1.5,
};

const LOADING_STYLE: CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "var(--fg-3)",
  fontSize: "var(--text-sm)",
};

function displayName(rec: TitleRecord): string {
  return rec.title?.trim() || NEW_TEMPLATE_NAME;
}

export function TemplatesManager({
  open,
  onClose,
  onOpenNote,
}: TemplatesManagerProps) {
  // `null` = loading; `[]` = loaded-but-empty (first-run empty state).
  const [templates, setTemplates] = useState<TitleRecord[] | null>(null);

  const refresh = useCallback(() => {
    setTemplates(null);
    void listTemplates()
      .then((recs) => setTemplates(recs))
      .catch(() => setTemplates([]));
  }, []);

  // Load (and reload) whenever the surface opens.
  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  // Re-fetch authoritative state after a row mutation, success or failure
  // (the modal is the single source of truth; cheap at modal scale).
  const afterMutation = useCallback(
    (p: Promise<unknown>) => {
      void p.finally(refresh);
    },
    [refresh],
  );

  const handleNew = useCallback(() => {
    void createTemplate(NEW_TEMPLATE_NAME, "")
      .then((id) => {
        onOpenNote(id as NoteId);
        onClose();
      })
      .catch(() => {
        // Surface stays open on failure; the list is unchanged.
      });
  }, [onOpenNote, onClose]);

  return (
    <ModalShell
      open={open}
      title="Note templates"
      onClose={onClose}
      labelId="templates-modal-title"
      width={560}
      height={560}
      closeLabel="Close templates"
    >
      <div style={TOOLBAR_STYLE}>
        <Button variant="primary" icon="file-plus" onClick={handleNew}>
          New template
        </Button>
      </div>

      {templates === null ? (
        <div style={LOADING_STYLE}>Loading…</div>
      ) : templates.length === 0 ? (
        <div style={EMPTY_STYLE}>
          <Icon name="file-text" size={28} style={{ color: "var(--fg-3)" }} />
          <p style={EMPTY_TITLE_STYLE}>No templates yet</p>
          <p style={EMPTY_BODY_STYLE}>
            Create a template to reuse a note skeleton — a meeting note, a daily
            log, a reading note. Pick one when you make a new note.
          </p>
        </div>
      ) : (
        <div role="list" aria-label="Templates" style={LIST_STYLE}>
          {templates.map((rec) => {
            const id = rec.noteUuid as NoteId;
            const name = displayName(rec);
            return (
              <div key={id} role="listitem" style={ROW_STYLE}>
                <button
                  type="button"
                  onClick={() => {
                    onOpenNote(id);
                    onClose();
                  }}
                  style={ROW_OPEN_STYLE}
                  aria-label={`Edit template ${name}`}
                >
                  <Icon
                    name="file-text"
                    size={16}
                    style={{ color: "var(--fg-3)" }}
                  />
                  <span style={ROW_NAME_STYLE}>{name}</span>
                </button>
                <button
                  type="button"
                  onClick={() => afterMutation(convertTemplateToNote(id))}
                  style={REMOVE_BUTTON_STYLE}
                  aria-label={`Remove ${name} from templates (keeps the note)`}
                >
                  Remove from templates
                </button>
                <button
                  type="button"
                  onClick={() => afterMutation(deleteTemplate(id))}
                  style={DELETE_BUTTON_STYLE}
                  aria-label={`Delete template ${name} (move to Trash)`}
                >
                  <Icon name="trash-2" size={16} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </ModalShell>
  );
}
