import { type CSSProperties, type ReactNode, useState } from "react";
import { SidePanel } from "../../../../components";
import type { NoteEntry, OutlineItem } from "../types";

type ContextTab = "backlinks" | "unlinked" | "outline";

/** Right side panel — the note's CONTEXT, ported to the desktop tabbed
 *  convention: Backlinks (🔗) / Unlinked mentions (#) / Outline (☰), with a
 *  collapse button. No AI-chat tab; note actions live in the ⋯ menu instead. */
export function NoteContextPanel({
  backlinks,
  unlinked,
  outline,
  onOpen,
  onJump,
  onClose,
}: {
  backlinks: NoteEntry[];
  unlinked: NoteEntry[];
  outline: OutlineItem[];
  onOpen: (id: string) => void;
  onJump: (charIndex: number) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<ContextTab>("backlinks");
  // SECTION_HEADING_STYLE (desktop sharedStyles.ts) — "LINKED FROM 0" look.
  const heading: CSSProperties = { fontSize: 11, color: "var(--fg-3)", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: 8 };
  const linkRow: CSSProperties = { display: "flex", alignItems: "center", gap: 8, width: "100%", border: "none", background: "transparent", padding: "9px 4px", borderRadius: 8, cursor: "pointer", textAlign: "left", fontSize: 15, color: "var(--fg-1)", fontFamily: "var(--font-sans)" };
  const empty = (text: string): ReactNode => <div style={{ fontSize: 13, color: "var(--fg-3)", marginTop: 4 }}>{text}</div>;
  const noteRow = (n: NoteEntry): ReactNode => (
    <button key={n.id} onClick={() => onOpen(n.id)} style={linkRow}>
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.title}</span>
    </button>
  );

  const tabBtn = (id: ContextTab, aria: string, icon: ReactNode): ReactNode => {
    const on = tab === id;
    return (
      <button
        onClick={() => setTab(id)}
        aria-label={aria}
        style={{ width: 40, height: 34, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "transparent", borderBottom: on ? "2px solid var(--accent)" : "2px solid transparent", marginBottom: -1, color: on ? "var(--fg-1)" : "var(--fg-3)", cursor: "pointer" }}
      >
        {icon}
      </button>
    );
  };

  const header = (close: () => void): ReactNode => (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "0 10px", minHeight: 40, borderBottom: "1px solid var(--line-1)" }}>
      <div style={{ display: "flex", gap: 2 }}>
        {tabBtn("backlinks", "Backlinks", <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M10 14a4 4 0 0 0 5.6 0l3-3a4 4 0 0 0-5.6-5.6L11 7" /><path d="M14 10a4 4 0 0 0-5.6 0l-3 3a4 4 0 0 0 5.6 5.6L13 17" /></svg>)}
        {tabBtn("unlinked", "Unlinked mentions", <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M9 4L7 20M17 4l-2 16M5 9h15M4 15h15" /></svg>)}
        {tabBtn("outline", "Outline", <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" /></svg>)}
      </div>
      <button onClick={close} aria-label="Collapse panel" style={{ width: 32, height: 32, borderRadius: 8, border: "none", background: "transparent", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none">
          <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="var(--fg-2)" strokeWidth="1.7" />
          <rect x="14.5" y="4.5" width="6" height="15" rx="2.5" fill="var(--fg-2)" opacity="0.85" />
        </svg>
      </button>
    </div>
  );

  return (
    <SidePanel header={header} onClose={onClose} padBody={false}>
      <div style={{ padding: "16px 18px" }}>
        {tab === "backlinks" && (
          <>
            <div style={heading}>Linked from {backlinks.length}</div>
            {backlinks.length === 0 ? empty("No backlinks yet.") : backlinks.map(noteRow)}
          </>
        )}
        {tab === "unlinked" && (
          <>
            <div style={heading}>Unlinked mentions {unlinked.length}</div>
            {unlinked.length === 0 ? empty("No unlinked mentions.") : unlinked.map(noteRow)}
          </>
        )}
        {tab === "outline" && (
          <>
            <div style={heading}>Outline</div>
            {outline.length === 0
              ? empty("No headings")
              : outline.map((h, i) => (
                  <button key={i} onClick={() => onJump(h.index)} style={{ ...linkRow, paddingLeft: 4 + (h.level - 1) * 14, color: h.level === 1 ? "var(--fg-1)" : "var(--fg-2)", fontWeight: h.level === 1 ? 600 : 400 }}>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{h.text}</span>
                  </button>
                ))}
          </>
        )}
      </div>
    </SidePanel>
  );
}
