import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Sheet } from "../../../../components";

/** The Sort sheet — the note-list order picker. Same modal treatment as the
 *  Filter sheet, reached from the icon-only Sort button in the toolbar. */
export function SortSheet({
  mode,
  onPick,
  onClose,
}: {
  mode: "none" | "az" | "za";
  onPick: (m: "none" | "az" | "za") => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const row = (content: ReactNode, on: boolean, onClick: () => void, first = false): ReactNode => (
    <div
      onClick={onClick}
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "12px 14px", borderTop: first ? undefined : "1px solid var(--line-1)", cursor: "pointer", color: on ? "var(--accent)" : "var(--fg-1)", fontWeight: on ? 600 : 400, fontSize: 16 }}
    >
      {content}
      {on && <svg width="16" height="16" viewBox="0 0 24 24" style={{ flexShrink: 0 }}><path d="M5 12l5 5L20 6" fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
    </div>
  );
  return (
    <Sheet onClose={onClose} style={{ maxHeight: "82%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {(close) => (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flex: "none", paddingBottom: 4 }}>
            <span style={{ width: 60 }} />
            <span style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)" }}>{t("editor.sortSheet.title")}</span>
            <button onClick={close} style={{ width: 60, textAlign: "right", border: "none", background: "transparent", color: "var(--accent)", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>{t("editor.sheet.done")}</button>
          </div>
          <div style={{ overflowY: "auto", minHeight: 0 }}>
            <div style={{ marginTop: 8, border: "1px solid var(--line-1)", borderRadius: 10, overflow: "hidden", background: "var(--bg-1)" }}>
              {row(t("editor.sortSheet.manual"), mode === "none", () => { onPick("none"); close(); }, true)}
              {row(t("editor.sortSheet.titleAsc"), mode === "az", () => { onPick("az"); close(); })}
              {row(t("editor.sortSheet.titleDesc"), mode === "za", () => { onPick("za"); close(); })}
            </div>
          </div>
        </>
      )}
    </Sheet>
  );
}
