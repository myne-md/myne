import type { CSSProperties, ReactNode } from "react";
import { Sheet } from "../../../../components";
import type { SavedView } from "../../../../lib/prefs";

/** The Filter sheet — the single home for the note-list scopes that would
 *  otherwise be scattered: status (live / Archive / Trash), saved Views, and
 *  Tags. Reached from the Filter button in the search·filter·sort toolbar. */
export function FilterSheet({
  onClose,
  listView,
  onPickStatus,
  archivedCount,
  trashedCount,
  views,
  activeViewId,
  onPickView,
  tagCount,
  onOpenTags,
}: {
  onClose: () => void;
  listView: "notes" | "archive" | "trash";
  onPickStatus: (v: "notes" | "archive" | "trash") => void;
  archivedCount: number;
  trashedCount: number;
  views: SavedView[];
  activeViewId: string | null;
  onPickView: (id: string) => void;
  tagCount: number;
  onOpenTags: () => void;
}) {
  const label: CSSProperties = { fontSize: 12, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--fg-3)", padding: "16px 4px 8px" };
  const row = (content: ReactNode, on: boolean, onClick: () => void, first = false): ReactNode => (
    <div
      onClick={onClick}
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "12px 14px", borderTop: first ? undefined : "1px solid var(--line-1)", cursor: "pointer", color: on ? "var(--accent)" : "var(--fg-1)", fontWeight: on ? 600 : 400, fontSize: 16 }}
    >
      {content}
      {on && <svg width="16" height="16" viewBox="0 0 24 24" style={{ flexShrink: 0 }}><path d="M5 12l5 5L20 6" fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
    </div>
  );
  const group = (children: ReactNode): ReactNode => (
    <div style={{ border: "1px solid var(--line-1)", borderRadius: 10, overflow: "hidden", background: "var(--bg-1)" }}>{children}</div>
  );
  return (
    <Sheet onClose={onClose} style={{ maxHeight: "82%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {(close) => (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flex: "none", paddingBottom: 4 }}>
            <span style={{ width: 60 }} />
            <span style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)" }}>Filter</span>
            <button onClick={close} style={{ width: 60, textAlign: "right", border: "none", background: "transparent", color: "var(--accent)", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Done</button>
          </div>
          <div style={{ overflowY: "auto", minHeight: 0 }}>
            <div style={label}>Status</div>
            {group(
              <>
                {row("All notes", listView === "notes", () => { onPickStatus("notes"); close(); }, true)}
                {row(<span>Archive{archivedCount > 0 ? <span style={{ color: "var(--fg-3)", fontWeight: 400 }}> · {archivedCount}</span> : ""}</span>, listView === "archive", () => { onPickStatus("archive"); close(); })}
                {row(<span>Trash{trashedCount > 0 ? <span style={{ color: "var(--fg-3)", fontWeight: 400 }}> · {trashedCount}</span> : ""}</span>, listView === "trash", () => { onPickStatus("trash"); close(); })}
              </>,
            )}

            {views.length > 0 && (
              <>
                <div style={label}>Views</div>
                {group(views.map((v, i) => row(v.name, activeViewId === v.id, () => { onPickView(v.id); close(); }, i === 0)))}
              </>
            )}

            {tagCount > 0 && (
              <>
                <div style={label}>Tags</div>
                {group(
                  <div onClick={() => { onOpenTags(); close(); }} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "12px 14px", cursor: "pointer", fontSize: 16, color: "var(--fg-1)" }}>
                    <span>Browse tags…<span style={{ color: "var(--fg-3)", fontWeight: 400 }}> · {tagCount}</span></span>
                    <svg width="8" height="13" viewBox="0 0 8 14" style={{ flex: "none" }}><path d="M1 1l6 6-6 6" stroke="var(--line-2)" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  </div>,
                )}
              </>
            )}
            <div style={{ height: 8 }} />
          </div>
        </>
      )}
    </Sheet>
  );
}
