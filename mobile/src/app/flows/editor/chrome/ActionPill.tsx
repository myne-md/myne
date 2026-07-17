import type { ReactNode } from "react";

/** A create-action tile (New note / Template / Daily note / New view) in the
 *  dashed "+ View" style — icon over label so four fit across a phone row.
 *  `children` are the inline SVG shapes for the glyph. */
export function ActionPill({ onClick, label, children, testid }: { onClick: () => void; label: string; children: ReactNode; testid?: string }) {
  return (
    <button
      onClick={onClick}
      data-testid={testid}
      style={{
        flex: 1,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        border: "1px solid var(--line-1)",
        borderRadius: 12,
        background: "transparent",
        color: "var(--fg-2)",
        fontSize: 12,
        fontWeight: 600,
        fontFamily: "var(--font-sans)",
        padding: "12px 4px",
        cursor: "pointer",
      }}
    >
      <svg width="19" height="19" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>{children}</svg>
      <span style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
    </button>
  );
}
