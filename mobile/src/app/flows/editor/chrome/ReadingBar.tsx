/** Slim bottom bar shown in reading mode — the guaranteed way back to editing
 *  (the FormatBar is hidden while reading, and the outline "Jump" only works for
 *  a note that actually has headings). */
export function ReadingBar({ onEdit }: { onEdit: () => void }) {
  return (
    <div
      style={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderTop: "1px solid var(--line-1)",
        background: "var(--bg-2)",
        padding: "6px 6px",
        paddingBottom: "calc(6px + env(safe-area-inset-bottom, 0px))",
      }}
    >
      <button
        onClick={onEdit}
        aria-label="Edit note"
        style={{ display: "flex", alignItems: "center", gap: 8, height: 40, padding: "0 18px", borderRadius: 9, border: "none", background: "transparent", cursor: "pointer", color: "var(--accent)", fontFamily: "var(--font-sans)", fontSize: 15, fontWeight: 600 }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M4 20l4-1L18.5 8.5a2 2 0 0 0-3-3L5 16l-1 4zM14 6l3 3" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
        Edit
      </button>
    </div>
  );
}
