import { useTranslation } from "react-i18next";
import { Sheet } from "../../../../components";
import { ActionRow, ActionRowSeparator } from "./ActionRow";

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
  return (
    <Sheet onClose={onClose} padded={false}>
      {() => (
        <>
          <div style={{ padding: "0 18px 12px", fontSize: 13, color: "var(--fg-3)" }}>{stat}</div>
          <ActionRow
            icon="copy"
            label={copied ? t("editor.noteMenu.copied") : t("editor.noteMenu.copyToClipboard")}
            onClick={onCopy}
            disabled={busy}
          />
          <ActionRow
            icon="check"
            label={t("common.tasks")}
            onClick={onTasks}
            disabled={busy}
            testId="editor.note-menu-tasks"
          />
          {/* `rotate-ccw` is the glyph the desktop gives version history
              (`src/screens/Editor.tsx`, action "version-history"). */}
          <ActionRow
            icon="rotate-ccw"
            label={t("common.versionhistory")}
            onClick={onHistory}
            disabled={busy}
          />
          <ActionRow icon="download" label={t("export.pdf.title")} onClick={onExport} disabled={busy} />
          {drawing && (
            <>
              <ActionRowSeparator />
              <ActionRow
                icon="eye"
                label={t("editor.drawingMenu.toggleTheme")}
                onClick={() => { drawing.onToggleTheme(); onClose(); }}
                groupTop
                disabled={busy}
                testId="editor.drawing-menu-theme"
              />
              <ActionRow
                icon="rotate-ccw"
                label={t("editor.drawingMenu.reset")}
                onClick={() => { drawing.onReset(); onClose(); }}
                danger
                disabled={busy}
                testId="editor.drawing-menu-reset"
              />
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
          <ActionRowSeparator />
          <ActionRow
            icon="folder"
            label={t("editor.noteMenu.moveToFolder")}
            onClick={onMove}
            groupTop
            disabled={busy}
          />
          <ActionRow icon="archive" label={t("notes.archive.title")} onClick={onArchive} disabled={busy} />
          <ActionRowSeparator />
          <ActionRow
            icon="trash"
            label={t("common.movetotrash")}
            onClick={onTrash}
            danger
            groupTop
            disabled={busy}
          />
        </>
      )}
    </Sheet>
  );
}
