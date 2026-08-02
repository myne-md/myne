// Note-template management (mobile) — list template notes, author a new one,
// use one (instantiate a note from it), edit, un-mark (convert back to an
// ordinary note), or delete. Templates are notes with a `template: true` flag
// (see `lib/templates.ts`); the daily-note engine already instantiates them.
//
// Renders either as a floating `Sheet` (`variant="sheet"`) or as a full
// bottom-tab page reached from the header (`variant="page"`, with a back chevron).

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Sheet, Icon, LIST_TOP } from "../../components";

export interface TemplateItem {
  id: string;
  title: string;
}

export function TemplatesSheet({
  templates,
  onUse,
  onEdit,
  onUnmark,
  onDelete,
  onNew,
  onClose,
  onBack,
  variant = "sheet",
}: {
  templates: TemplateItem[];
  onUse: (id: string) => void;
  onEdit: (id: string) => void;
  onUnmark: (id: string) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
  /** Page-variant back target (returns to the Notes tab). */
  onBack?: () => void;
  variant?: "sheet" | "page";
}) {
  const { t } = useTranslation();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const listInner =
    templates.length === 0 ? (
      <div style={{ textAlign: "center", padding: "30px 20px", color: "var(--fg-3)", fontSize: 14, lineHeight: 1.55 }}>
        {t("templates.emptyBefore")}<span style={{ color: "var(--accent)", fontWeight: 600 }}>{t("templates.newAction")}</span>{t("templates.emptyAfter")}
      </div>
    ) : (
      templates.map((tpl) => (
        <div key={tpl.id} style={{ borderTop: "1px solid var(--line-1)", padding: "10px 4px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0, fontSize: 16, fontWeight: 600, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {tpl.title || t("templates.manager.newTemplateName")}
            </div>
            <button onClick={() => onUse(tpl.id)} style={btn("var(--accent)")}>{t("templates.use")}</button>
            <button onClick={() => onEdit(tpl.id)} style={btn("var(--fg-2)")}>{t("templates.edit")}</button>
          </div>
          {confirmDelete === tpl.id ? (
            <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 12, justifyContent: "flex-end" }}>
              <span style={{ fontSize: 13, color: "var(--fg-3)", marginInlineEnd: "auto" }}>{t("templates.deleteConfirm")}</span>
              <button onClick={() => { setConfirmDelete(null); onDelete(tpl.id); }} style={btn("var(--danger)")}>{t("attachments.deleteDialog.delete")}</button>
              <button onClick={() => setConfirmDelete(null)} style={btn("var(--fg-3)")}>{t("common.prompt.cancel")}</button>
            </div>
          ) : (
            <div style={{ marginTop: 4, display: "flex", gap: 14, justifyContent: "flex-end" }}>
              <button onClick={() => onUnmark(tpl.id)} style={btn("var(--fg-3)")}>{t("templates.convertToNote")}</button>
              <button onClick={() => setConfirmDelete(tpl.id)} style={btn("var(--danger)")}>{t("attachments.deleteDialog.delete")}</button>
            </div>
          )}
        </div>
      ))
    );

  const newAction = (
    <button onClick={onNew} style={{ border: "none", background: "transparent", color: "var(--accent)", fontSize: 14, fontWeight: 600, cursor: "pointer", padding: 0 }}>
      {t("templates.newAction")}
    </button>
  );

  if (variant === "page") {
    return (
      <>
        <div style={{ flex: "none", padding: `${LIST_TOP} 20px 0` }}>
          {onBack && (
            <button
              onClick={onBack}
              style={{ display: "flex", alignItems: "center", gap: 3, border: "none", background: "transparent", color: "var(--accent)", fontSize: 15, fontWeight: 600, cursor: "pointer", padding: 0 }}
            >
              <Icon name="chevron-left" size={18} color="var(--accent)" strokeWidth={2} flip /> {t("commandPalette.sectionNotes")}
            </button>
          )}
          <div style={{ marginTop: onBack ? 14 : 0, display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
            <h1 style={{ margin: 0, fontSize: 32, fontWeight: 700, letterSpacing: "-0.025em", color: "var(--fg-display)" }}>{t("templates.manager.listLabel")}</h1>
            {newAction}
          </div>
        </div>
        <div style={{ overflowY: "auto", flex: 1, minHeight: 0, padding: "12px 20px 0" }}>{listInner}</div>
      </>
    );
  }

  return (
    <Sheet onClose={onClose} style={{ maxHeight: "82%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flex: "none" }}>
        <span style={{ width: 72 }} />
        <span style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)" }}>{t("templates.manager.listLabel")}</span>
        <span style={{ width: 72, textAlign: "end" }}>{newAction}</span>
      </div>

      <div style={{ marginTop: 12, overflowY: "auto", flex: 1, minHeight: 0 }}>{listInner}</div>
    </Sheet>
  );
}

function btn(color: string): React.CSSProperties {
  return { border: "none", background: "transparent", color, fontSize: 13, fontWeight: 600, cursor: "pointer", padding: "6px 4px" };
}
