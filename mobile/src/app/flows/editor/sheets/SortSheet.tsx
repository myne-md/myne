import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Sheet } from "../../../../components";
import { tappable } from "../../../a11y/tappable";

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
      {...tappable({ onActivate: onClick, pressed: on })}
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
            <button onClick={close} style={{ width: 60, textAlign: "end", border: "none", background: "transparent", color: "var(--accent)", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>{t("editor.sheet.done")}</button>
          </div>
          <div style={{ overflowY: "auto", minHeight: 0 }}>
            {/* No "Manual" mode on the list (owner, 2026-11-08). Ordering IS the
                tree's press-and-hold drag now, so a row offering "manual order"
                beside two alphabetical ones described a mode the user never has
                to choose, the arrangement is simply what is on screen. What the
                sheet keeps is the two overrides, plus the way back to the
                arrangement when one of them is on: without that third row a user
                who picked A→Z would have no visible path back to the order they
                had dragged into place, which is the state this sheet exists to
                control. */}
            <div style={{ marginTop: 8, border: "1px solid var(--line-1)", borderRadius: 10, overflow: "hidden", background: "var(--bg-1)" }}>
              {row(t("editor.sortSheet.titleAsc"), mode === "az", () => { onPick("az"); close(); }, true)}
              {row(t("editor.sortSheet.titleDesc"), mode === "za", () => { onPick("za"); close(); })}
              {mode !== "none" &&
                row(t("editor.sortSheet.arrangement"), false, () => { onPick("none"); close(); })}
            </div>
          </div>
        </>
      )}
    </Sheet>
  );
}
