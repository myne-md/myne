import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Sheet } from "../../../../components";

/** Note-actions sheet (the ⋯ menu): Copy / Move / History / Export / Archive /
 *  Trash. Ported off the old right-panel footer so the panel matches the desktop
 *  tabbed convention (context only). */
export function NoteActionsSheet({
  stat,
  copied,
  busy,
  onClose,
  onCopy,
  onMove,
  onHistory,
  onExport,
  onArchive,
  onTrash,
}: {
  stat: string;
  copied: boolean;
  busy: boolean;
  onClose: () => void;
  onCopy: () => void;
  onMove: () => void;
  onHistory: () => void;
  onExport: () => void;
  onArchive: () => void;
  onTrash: () => void;
}) {
  const { t } = useTranslation();
  // Flush rows in the Sheet (already the single rounded container) — hairline
  // dividers only, no inner bordered box (avoids the box-in-a-box look).
  const row = (text: string, onClick: () => void, danger = false): ReactNode => (
    <button
      onClick={onClick}
      disabled={busy}
      style={{ display: "flex", alignItems: "center", width: "100%", border: "none", borderTop: "1px solid var(--line-1)", background: "transparent", padding: "15px 18px", cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1, fontFamily: "var(--font-sans)", fontSize: 16, color: danger ? "var(--danger)" : "var(--fg-1)" }}
    >
      {text}
    </button>
  );
  return (
    <Sheet onClose={onClose} padded={false}>
      {() => (
        <>
          <div style={{ padding: "0 18px 12px", fontSize: 13, color: "var(--fg-3)" }}>{stat}</div>
          {row(copied ? t("editor.noteMenu.copied") : t("editor.noteMenu.copyToClipboard"), onCopy)}
          {row(t("editor.noteMenu.moveToFolder"), onMove)}
          {row(t("editor.noteMenu.versionHistory"), onHistory)}
          {row(t("editor.noteMenu.exportPdf"), onExport)}
          {row(t("editor.nav.archive"), onArchive)}
          {row(t("editor.noteMenu.moveToTrash"), onTrash, true)}
        </>
      )}
    </Sheet>
  );
}
