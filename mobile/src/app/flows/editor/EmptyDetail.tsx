import { MyneMark } from "../../../components";

/** Detail-pane placeholder on the regular (multi-pane) size classes when no
 *  note is selected — the compact layout never renders it (the editor is a
 *  full-screen push there, so a note is always open when the editor shows). */
export function EmptyDetail({ onNew }: { onNew: () => void }) {
  return (
    <div
      data-testid="workspace.empty-detail"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        padding: "0 40px",
        textAlign: "center",
      }}
    >
      <MyneMark size={40} radius={9} />
      <div style={{ fontSize: 16, fontWeight: 600, color: "var(--fg-2)" }}>Select a note</div>
      <div style={{ fontSize: 14, lineHeight: 1.55, color: "var(--fg-3)", maxWidth: 300 }}>
        Choose a note from the list, or start a new one.
      </div>
      <button
        data-testid="workspace.empty-detail-new"
        onClick={onNew}
        style={{
          marginTop: 4,
          display: "flex",
          alignItems: "center",
          gap: 6,
          height: 38,
          border: "none",
          borderRadius: 10,
          background: "var(--accent)",
          color: "var(--accent-on)",
          padding: "0 16px",
          fontSize: 14,
          fontWeight: 600,
          fontFamily: "var(--font-sans)",
          cursor: "pointer",
        }}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
        </svg>
        New note
      </button>
    </div>
  );
}
