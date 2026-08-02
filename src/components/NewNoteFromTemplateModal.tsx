// New-note-from-template flow — modal mounted from `Editor.tsx`, opened by the
// sidebar new-note caret and the "New note from template…" palette action
// (MYND-190). Two steps (SYNC-10, prompt-first):
//   1. pick    — choose one of the user's templates (the `template: true` filter);
//   2. name    — name the note upfront (fills `{{title}}` and becomes `title:`),
//                then render + create + open.
// Zero-templates degrade (story 3): when the vault has no templates, the flow
// offers only a "Blank note" choice that runs the existing instant-blank path —
// it never dead-ends on an empty list.
//
// This is the DELIBERATE template path; the instant-blank new-note path (bare
// Cmd+N + the five instant-create surfaces) is untouched and always available.
// Dismiss (Esc / backdrop) is a no-op — nothing is created or mutated. Shell
// chrome comes from the shared `ModalShell` primitive.
//
// Design canon: Penpot page "4 — Desktop UI Kit", `new-note-from-template`.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Icon } from "./primitives/Icon";
import { Button } from "./primitives/Button";
import { ModalShell } from "./primitives/ModalShell";
import { hoverSurface, HOVER_TRANSITION } from "./primitives/hoverSurface";
import { listTemplates, type NoteId, type TitleRecord } from "../notes";

interface NewNoteFromTemplateModalProps {
  open: boolean;
  onClose: () => void;
  /** Run the existing instant-blank path (zero-templates degrade). */
  onBlankNote: () => void;
  /** Instantiate `templateId` named `name`, then open the created note. */
  onCreateFromTemplate: (templateId: NoteId, name: string) => void;
  /** Open the template-management surface (the visible path to authoring
   *  templates — a picker footer entry + the zero-templates create nudge). */
  onManageTemplates?: () => void;
}

const LIST_STYLE: CSSProperties = {
  maxHeight: 360,
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
  width: "100%",
  height: 40,
  padding: "0 var(--space-2)",
  background: "transparent",
  border: 0,
  borderRadius: "var(--radius-1)",
  cursor: "pointer",
  textAlign: "left",
  color: "var(--fg-1)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-base)",
  transition: HOVER_TRANSITION,
};

const FOOTER_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  padding: "var(--space-2) var(--space-3) var(--space-3)",
  borderTop: "1px solid var(--line-1)",
};

const ROW_NAME_STYLE: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const NAME_STEP_STYLE: CSSProperties = {
  padding: "var(--space-5)",
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
};

const LABEL_STYLE: CSSProperties = {
  fontSize: "var(--text-sm)",
  color: "var(--fg-2)",
};

const INPUT_STYLE: CSSProperties = {
  width: "100%",
  height: 36,
  padding: "0 var(--space-3)",
  background: "var(--bg-1)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-1)",
  color: "var(--fg-1)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-base)",
  boxSizing: "border-box",
};

const ACTIONS_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "var(--space-2)",
};

const HINT_STYLE: CSSProperties = {
  padding: "var(--space-4) var(--space-5) 0",
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
};

const LOADING_STYLE: CSSProperties = {
  padding: "var(--space-6)",
  textAlign: "center",
  color: "var(--fg-3)",
  fontSize: "var(--text-sm)",
};

function displayName(rec: TitleRecord, t: TFunction): string {
  return rec.title?.trim() || t("notes.newFromTemplate.untitledTemplate");
}

type Step =
  | { kind: "pick" }
  | { kind: "name"; templateId: NoteId; templateName: string };

export function NewNoteFromTemplateModal({
  open,
  onClose,
  onBlankNote,
  onCreateFromTemplate,
  onManageTemplates,
}: NewNoteFromTemplateModalProps) {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<TitleRecord[] | null>(null);
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Load templates + reset to the pick step every time the flow opens.
  useEffect(() => {
    if (!open) return;
    setStep({ kind: "pick" });
    setName("");
    setTemplates(null);
    void listTemplates()
      .then((recs) => setTemplates(recs))
      .catch(() => setTemplates([]));
  }, [open]);

  // Autofocus the name input when entering the name step.
  useEffect(() => {
    if (step.kind === "name") {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [step]);

  const pickTemplate = useCallback(
    (rec: TitleRecord) => {
      setName("");
      setStep({
        kind: "name",
        templateId: rec.noteUuid as NoteId,
        templateName: displayName(rec, t),
      });
    },
    [t],
  );

  const confirmName = useCallback(() => {
    if (step.kind !== "name") return;
    const trimmed = name.trim();
    if (trimmed === "") return; // empty name is not a valid entry
    onCreateFromTemplate(step.templateId, trimmed);
    onClose();
  }, [step, name, onCreateFromTemplate, onClose]);

  const chooseBlank = useCallback(() => {
    onBlankNote();
    onClose();
  }, [onBlankNote, onClose]);

  return (
    <ModalShell
      open={open}
      title={
        step.kind === "name"
          ? t("notes.newFromTemplate.nameStepTitle")
          : t("notes.newFromTemplate.pickStepTitle")
      }
      onClose={onClose}
      labelId="new-from-template-title"
      width={480}
    >
      {templates === null ? (
        <div style={LOADING_STYLE}>{t("notes.newFromTemplate.loading")}</div>
      ) : step.kind === "name" ? (
        <div style={NAME_STEP_STYLE}>
          <label htmlFor="new-from-template-name" style={LABEL_STYLE}>
            {t("notes.newFromTemplate.nameLabel", {
              templateName: step.templateName,
            })}
          </label>
          <input
            id="new-from-template-name"
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                confirmName();
              }
            }}
            placeholder={t("notes.newFromTemplate.namePlaceholder")}
            style={INPUT_STYLE}
          />
          <div style={ACTIONS_STYLE}>
            <Button variant="ghost" onClick={() => setStep({ kind: "pick" })}>
              {t("notes.newFromTemplate.back")}
            </Button>
            <Button
              variant="primary"
              onClick={confirmName}
              disabled={name.trim() === ""}
            >
              {t("notes.newFromTemplate.createNote")}
            </Button>
          </div>
        </div>
      ) : templates.length === 0 ? (
        // Zero-templates degrade — offer the blank path, and (when the manager
        // is reachable) nudge toward authoring a first template instead of
        // dead-ending on an empty list.
        <>
          <p style={HINT_STYLE}>{t("notes.newFromTemplate.emptyState")}</p>
          <div
            style={{
              display: "flex",
              gap: "var(--space-2)",
              padding: "var(--space-4) var(--space-5) var(--space-5)",
            }}
          >
            {onManageTemplates !== undefined && (
              <Button
                variant="primary"
                icon="layout-grid"
                onClick={() => {
                  onManageTemplates();
                  onClose();
                }}
                data-testid="new-from-template.create-first"
              >
                {t("notes.newFromTemplate.createFirstTemplate")}
              </Button>
            )}
            <Button
              variant="secondary"
              icon="file-plus"
              onClick={chooseBlank}
              data-testid="new-from-template.blank-note"
            >
              {t("notes.newFromTemplate.blankNote")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <div
            role="list"
            aria-label={t("notes.newFromTemplate.listLabel")}
            style={LIST_STYLE}
            data-testid="new-from-template.list"
          >
            {templates.map((rec) => {
              const templateName = displayName(rec, t);
              return (
                <button
                  key={rec.noteUuid}
                  type="button"
                  role="listitem"
                  style={ROW_STYLE}
                  {...hoverSurface()}
                  onClick={() => pickTemplate(rec)}
                  data-testid="new-from-template.row"
                >
                  <Icon
                    name="file-text"
                    size={16}
                    style={{ color: "var(--fg-3)" }}
                  />
                  <span style={ROW_NAME_STYLE}>{templateName}</span>
                </button>
              );
            })}
          </div>
          {onManageTemplates !== undefined && (
            <div style={FOOTER_STYLE}>
              <Button
                variant="ghost"
                icon="layout-grid"
                onClick={() => {
                  onManageTemplates();
                  onClose();
                }}
                data-testid="new-from-template.manage"
              >
                {t("notes.newFromTemplate.manageTemplates")}
              </Button>
            </div>
          )}
        </>
      )}
    </ModalShell>
  );
}
