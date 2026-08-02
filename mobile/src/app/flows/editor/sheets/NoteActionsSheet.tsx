import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Sheet } from "../../../../components";

/** Note-actions sheet (the ⋯ menu): Copy / Move / History / Export / Archive /
 *  Trash. Ported off the old right-panel footer so the panel matches the desktop
 *  tabbed convention (context only). */
/** #179: the drawing-canvas actions relocated from Excalidraw's (now-hidden)
 *  mobile menu. Present only for a `kind: drawing` note. */
export type DrawingMenuActions = {
  onReset: () => void;
  onToggleTheme: () => void;
  onSetBackground: (color: string) => void;
};

/** Canvas-background swatches offered in the ⋯ menu (a compact stand-in for
 *  Excalidraw's picker): follow-theme (transparent) + light/dark + two tints. */
const CANVAS_BG_SWATCHES = ["transparent", "#ffffff", "#1e1e1e", "#f5faff", "#fffce8"];

export function NoteActionsSheet({
  stat,
  copied,
  busy,
  onClose,
  onCopy,
  onMove,
  onHistory,
  onTasks,
  onExport,
  onArchive,
  onTrash,
  drawing,
}: {
  stat: string;
  copied: boolean;
  busy: boolean;
  onClose: () => void;
  onCopy: () => void;
  onMove: () => void;
  onHistory: () => void;
  /** Open this note's tasks (MYND-620 task 4). */
  onTasks: () => void;
  onExport: () => void;
  onArchive: () => void;
  onTrash: () => void;
  /** #179: drawing-canvas actions, present only for a drawing note. */
  drawing?: DrawingMenuActions;
}) {
  const { t } = useTranslation();
  // Rows split into logical groups (produce / organize / destructive) by a
  // heavier group separator — the mobile twin of the desktop ContextMenu `group`
  // dividers. `groupTop` drops a row's top hairline when a separator precedes it.
  const row = (text: string, onClick: () => void, opts?: { danger?: boolean; groupTop?: boolean; testId?: string }): ReactNode => (
    <button
      onClick={onClick}
      disabled={busy}
      data-testid={opts?.testId}
      style={{ display: "flex", alignItems: "center", width: "100%", border: "none", borderTop: opts?.groupTop ? "none" : "1px solid var(--line-1)", background: "transparent", padding: "15px 18px", cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1, fontFamily: "var(--font-sans)", fontSize: 16, color: opts?.danger ? "var(--danger)" : "var(--fg-1)" }}
    >
      {text}
    </button>
  );
  const sep: ReactNode = <div aria-hidden style={{ height: 1, background: "var(--line-2)", margin: "7px 0" }} />;
  return (
    <Sheet onClose={onClose} padded={false}>
      {() => (
        <>
          <div style={{ padding: "0 18px 12px", fontSize: 13, color: "var(--fg-3)" }}>{stat}</div>
          {row(copied ? t("editor.noteMenu.copied") : t("editor.noteMenu.copyToClipboard"), onCopy)}
          {row(t("tasks.title"), onTasks, { testId: "editor.note-menu-tasks" })}
          {row(t("editor.noteMenu.versionHistory"), onHistory)}
          {row(t("export.pdf.title"), onExport)}
          {drawing && (
            <>
              {sep}
              {row(t("editor.drawingMenu.toggleTheme"), () => { drawing.onToggleTheme(); onClose(); }, { groupTop: true, testId: "editor.drawing-menu-theme" })}
              {row(t("editor.drawingMenu.reset"), () => { drawing.onReset(); onClose(); }, { danger: true, testId: "editor.drawing-menu-reset" })}
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 18px 15px", flexWrap: "wrap" }} data-testid="editor.drawing-menu-bg">
                <span style={{ fontSize: 16, color: "var(--fg-1)", fontFamily: "var(--font-sans)" }}>{t("editor.drawingMenu.background")}</span>
                {CANVAS_BG_SWATCHES.map((c) => (
                  <button
                    key={c}
                    aria-label={c}
                    onClick={() => { drawing.onSetBackground(c); onClose(); }}
                    disabled={busy}
                    style={{
                      width: 28, height: 28, borderRadius: "50%", border: "1px solid var(--line-2)",
                      cursor: busy ? "default" : "pointer", padding: 0, flexShrink: 0,
                      background: c === "transparent"
                        ? "repeating-conic-gradient(var(--line-2) 0% 25%, var(--bg-1) 0% 50%) 50% / 12px 12px"
                        : c,
                    }}
                  />
                ))}
              </div>
            </>
          )}
          {sep}
          {row(t("editor.noteMenu.moveToFolder"), onMove, { groupTop: true })}
          {row(t("notes.archive.title"), onArchive)}
          {sep}
          {row(t("editor.noteMenu.moveToTrash"), onTrash, { danger: true, groupTop: true })}
        </>
      )}
    </Sheet>
  );
}
