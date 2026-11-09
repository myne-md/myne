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
import { useTranslation } from "react-i18next";
import { Icon } from "./primitives/Icon";
import { Button } from "./primitives/Button";
import { Input } from "./primitives/Input";
import { HOVER_TRANSITION } from "./primitives/hoverSurface";
import { useWorkspaceOptional } from "../notes/workspaceContext";
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
  /**
   * Close the surface. As a tab this is "open a note and replace me", which the
   * `onOpenNote` path already does — so it survives only for the callers that
   * had one, and a tab body can pass a no-op.
   */
  onClose: () => void;
  /** Open a template in the normal note editor (selects it + closes the surface). */
  onOpenNote: (id: NoteId) => void;
}

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
  textAlign: "start",
  cursor: "pointer",
  color: "var(--fg-1)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-base)",
  borderRadius: "var(--radius-1)",
  transition: HOVER_TRANSITION,
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
  transition: HOVER_TRANSITION,
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

/** Inline create/open failure line (myne-md/myne#824) — non-blocking, above the list. */
const ERROR_STYLE: CSSProperties = {
  margin: 0,
  padding: "var(--space-2) var(--space-5)",
  color: "var(--danger)",
  fontSize: "var(--text-sm)",
  flex: "0 0 auto",
};

function displayName(rec: TitleRecord, fallback: string): string {
  return rec.title?.trim() || fallback;
}

export function TemplatesManager({
  open,
  onClose,
  onOpenNote,
}: TemplatesManagerProps) {
  const { t } = useTranslation();
  // Optional: the manager is always mounted inside `WorkspaceProvider` in the
  // app, but its unit test renders it bare, so a missing provider must degrade
  // to "no panes to close" rather than throw.
  const ws = useWorkspaceOptional();
  /** Default name for a brand-new template (renamed later via the editor). */
  const newTemplateName = t("templates.manager.newTemplateName");
  // `null` = loading; `[]` = loaded-but-empty (first-run empty state).
  const [templates, setTemplates] = useState<TitleRecord[] | null>(null);
  // The inline "name your template" step (myne-md/myne#820): creating a
  // template asks for a name rather than silently minting "Untitled template".
  const [naming, setNaming] = useState(false);
  const [draftName, setDraftName] = useState("");
  // In-flight guard: Enter key auto-repeat or a double-click would otherwise
  // fire `createTemplate` several times and mint duplicate templates
  // (myne-md/myne#824).
  const [creating, setCreating] = useState(false);
  // Create/open failure is surfaced inline rather than swallowed (myne-md/myne#824).
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setTemplates(null);
    void listTemplates()
      .then((recs) => setTemplates(recs))
      .catch(() => setTemplates([]));
  }, []);

  // Load (and reload) whenever the surface opens, and clear the transient
  // naming/error state so reopening starts on the list (myne-md/myne#824).
  useEffect(() => {
    if (open) refresh();
    else {
      setNaming(false);
      setDraftName("");
      setCreating(false);
      setError(null);
    }
  }, [open, refresh]);

  // Re-fetch authoritative state after a row mutation, success or failure
  // (the modal is the single source of truth; cheap at modal scale).
  const afterMutation = useCallback(
    (p: Promise<unknown>) => {
      void p.finally(refresh);
    },
    [refresh],
  );

  // Delete a template: soft-trash it, then close any pane tab holding it
  // (myne-md/myne#819). A template is an ordinary note and the row-open button
  // above opens it into a pane, so a resident tab would let the next autosave
  // write the pre-trash buffer back and return it from the trash. Only on
  // SUCCESS: a failed delete left the note alone, so its tab stays.
  const handleDelete = useCallback(
    (id: NoteId) => {
      void deleteTemplate(id)
        .then(() => {
          ws?.closeNoteEverywhere(id);
        })
        .catch(() => {
          /* refresh() below re-reads the authoritative list */
        })
        .finally(refresh);
    },
    [refresh, ws],
  );

  const handleNew = useCallback(() => {
    if (creating) return; // re-entry guard (Enter key-repeat / double-click)
    const name = draftName.trim() || newTemplateName;
    setCreating(true);
    setError(null);
    void createTemplate(name, "")
      .then((id) => {
        setNaming(false);
        setDraftName("");
        onOpenNote(id as NoteId);
        onClose();
      })
      .catch(() => {
        // Surface stays open on failure; show why (myne-md/myne#824).
        setError(t("templates.manager.createFailed"));
      })
      .finally(() => setCreating(false));
  }, [onOpenNote, onClose, newTemplateName, draftName, creating, t]);

  return (
    // A TAB body, not a modal (myne-md/myne#779, docs/decisions/ui/0633). A
    // template library is something you browse, rename in and delete from —
    // none of which is a question the app is asking, which is the test that
    // decides the shape. The title and the close affordance come from the tab
    // strip now, so neither is rendered here.
    <div
      data-testid="templates.pane"
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
      }}
    >
      <div style={TOOLBAR_STYLE}>
        {!naming ? (
          <Button
            variant="primary"
            icon="file-plus"
            onClick={() => {
              setDraftName(newTemplateName);
              setNaming(true);
            }}
            data-testid="templates.new"
          >
            {t("templates.manager.newTemplate")}
          </Button>
        ) : (
          <div
            style={{
              display: "flex",
              gap: "var(--space-2)",
              alignItems: "center",
              flex: 1,
            }}
          >
            <Input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  // preventDefault stops a native form-ish default and pairs
                  // with the re-entry guard so held Enter cannot mint dupes.
                  e.preventDefault();
                  handleNew();
                }
                if (e.key === "Escape") {
                  // Cancel naming WITHOUT closing the modal (myne-md/myne#824):
                  // stop the event before ModalShell's window-level Escape
                  // handler sees it.
                  e.stopPropagation();
                  if (!creating) setNaming(false);
                }
              }}
              aria-label={t("templates.manager.nameLabel")}
              autoFocus
              data-testid="templates.new-name"
              style={{ flex: 1 }}
            />
            <Button
              variant="primary"
              onClick={handleNew}
              disabled={creating}
              data-testid="templates.new-create"
            >
              {t("templates.manager.create")}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                if (!creating) setNaming(false);
              }}
              data-testid="templates.new-cancel"
            >
              {t("common.cancel")}
            </Button>
          </div>
        )}
      </div>
      {error !== null && (
        <p role="alert" style={ERROR_STYLE} data-testid="templates.error">
          {error}
        </p>
      )}

      {templates === null ? (
        <div style={LOADING_STYLE}>{t("common.loading")}</div>
      ) : templates.length === 0 ? (
        <div style={EMPTY_STYLE}>
          <Icon name="file-text" size={28} style={{ color: "var(--fg-3)" }} />
          <p style={EMPTY_TITLE_STYLE}>{t("templates.manager.emptyTitle")}</p>
          <p style={EMPTY_BODY_STYLE}>{t("templates.manager.emptyBody")}</p>
        </div>
      ) : (
        <div
          role="list"
          aria-label={t("templates.manager.listLabel")}
          style={LIST_STYLE}
          data-testid="templates.list"
        >
          {templates.map((rec) => {
            const id = rec.noteUuid as NoteId;
            const name = displayName(rec, newTemplateName);
            return (
              <div key={id} role="listitem" style={ROW_STYLE} data-testid="templates.row">
                <Button
                  variant="ghost"
                  onClick={() => {
                    onOpenNote(id);
                    onClose();
                  }}
                  style={ROW_OPEN_STYLE}
                  aria-label={t("templates.manager.editTemplateLabel", { name })}
                  data-testid="templates.row-open"
                >
                  <Icon
                    name="file-text"
                    size={16}
                    style={{ color: "var(--fg-3)" }}
                  />
                  <span style={ROW_NAME_STYLE}>{name}</span>
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => afterMutation(convertTemplateToNote(id))}
                  style={REMOVE_BUTTON_STYLE}
                  aria-label={t("templates.manager.removeRowLabel", { name })}
                  data-testid="templates.row-remove"
                >
                  {t("templates.manager.removeFromTemplates")}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => handleDelete(id)}
                  style={{ color: "var(--danger)", padding: "var(--space-1)" }}
                  aria-label={t("templates.manager.deleteRowLabel", { name })}
                  data-testid="templates.row-delete"
                >
                  <Icon name="trash-2" size={16} />
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
