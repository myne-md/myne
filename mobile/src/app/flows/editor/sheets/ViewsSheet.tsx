import { useTranslation } from "react-i18next";
import { Sheet } from "../../../../components";
import type { SavedView } from "../../../../lib/prefs";

/** The Views sheet — browse the saved views, activate one (tap), edit it, or
 *  create a new one. Reached from the "Views" tile under the Notes heading. */
export function ViewsSheet({
  views,
  activeViewId,
  onPick,
  onEdit,
  onNew,
  onClose,
}: {
  views: SavedView[];
  activeViewId: string | null;
  onPick: (id: string) => void;
  onEdit: (v: SavedView) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const typeLabel: Record<string, string> = { table: t("editor.slash.table"), cards: t("editor.viewsSheet.typeCards"), list: t("editor.viewsSheet.typeList") };
  return (
    <Sheet onClose={onClose} style={{ maxHeight: "82%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {(close) => (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flex: "none", paddingBottom: 4 }}>
            <span style={{ width: 60 }} />
            <span style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)" }}>{t("editor.chrome.barItems.views")}</span>
            <button onClick={close} style={{ width: 60, textAlign: "right", border: "none", background: "transparent", color: "var(--accent)", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>{t("editor.sheet.done")}</button>
          </div>
          <div style={{ overflowY: "auto", minHeight: 0 }}>
            <button
              onClick={() => { onNew(); close(); }}
              style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", marginTop: 8, padding: "13px 14px", border: "1px solid var(--line-1)", borderRadius: 10, background: "var(--bg-1)", color: "var(--accent)", fontFamily: "var(--font-sans)", fontSize: 16, fontWeight: 600, cursor: "pointer" }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
              {t("notes.views.newView")}
            </button>

            {views.length === 0 ? (
              <p style={{ margin: "16px 4px 8px", fontSize: 14, lineHeight: 1.5, color: "var(--fg-3)" }}>
                {t("editor.viewsSheet.emptyState")}
              </p>
            ) : (
              <div style={{ marginTop: 12, border: "1px solid var(--line-1)", borderRadius: 10, overflow: "hidden", background: "var(--bg-1)" }}>
                {views.map((v, i) => {
                  const active = activeViewId === v.id;
                  return (
                    <div
                      key={v.id}
                      onClick={() => { onPick(v.id); close(); }}
                      style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", borderTop: i === 0 ? undefined : "1px solid var(--line-1)", cursor: "pointer" }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 16, fontWeight: active ? 600 : 400, color: active ? "var(--accent)" : "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v.name}</div>
                        <div style={{ fontSize: 12, color: "var(--fg-3)", marginTop: 2 }}>{typeLabel[v.view_type] ?? v.view_type}</div>
                      </div>
                      {active && <svg width="16" height="16" viewBox="0 0 24 24" style={{ flexShrink: 0 }}><path d="M5 12l5 5L20 6" fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                      <button
                        onClick={(e) => { e.stopPropagation(); onEdit(v); close(); }}
                        aria-label={t("editor.viewsSheet.editView")}
                        style={{ flexShrink: 0, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "transparent", cursor: "pointer" }}
                      >
                        <svg width="17" height="17" viewBox="0 0 24 24" fill="none"><path d="M4 20l4-1 10-10-3-3L5 16l-1 4zM14 6l3 3" stroke="var(--fg-3)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </Sheet>
  );
}
