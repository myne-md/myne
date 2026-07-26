import { useRef } from "react";
import type { PressEvt } from "../types";
import { FolderGlyph } from "../decorations/FolderGlyph";
import { ColorDot } from "../decorations/ColorDot";

/** A folder header row in the inline notes tree (MYND-480): tap toggles the
 *  subtree; a ~480ms long-press (that doesn't drift into a scroll) opens the
 *  folder action sheet — the same hold gesture as `NoteRow`. Renders a
 *  desktop-assigned custom icon (`icon`) in place of the default folder glyph
 *  and a trailing color dot (`color`) when set (MYND-516). */
export function FolderTreeRow({
  name,
  count,
  collapsed,
  indentPx,
  icon,
  color,
  onToggle,
  onHold,
}: {
  name: string;
  count: number;
  collapsed: boolean;
  indentPx: number;
  /** Custom folder icon glyph name (`prefs.folder_icons[path]`), else default. */
  icon?: string;
  /** Color-label slot (`prefs.item_colors[path]`) → a trailing dot, else none. */
  color?: string;
  onToggle: () => void;
  onHold: () => void;
}) {
  const holdTimer = useRef<number | null>(null);
  const holdAt = useRef<{ x: number; y: number } | null>(null);
  const held = useRef(false);
  const clearHold = () => {
    if (holdTimer.current != null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
    holdAt.current = null;
  };
  const startHold = (e: PressEvt) => {
    held.current = false;
    holdAt.current = { x: e.clientX, y: e.clientY };
    holdTimer.current = window.setTimeout(() => {
      held.current = true;
      holdTimer.current = null;
      onHold();
    }, 480);
  };
  const moveHold = (e: PressEvt) => {
    const s = holdAt.current;
    if (s && (Math.abs(e.clientX - s.x) > 10 || Math.abs(e.clientY - s.y) > 10)) clearHold();
  };
  return (
    <div
      data-testid="notes.folder-row"
      data-folder-path={name}
      // Expose the fold state so a flow spec can assert a RESTORED expand set
      // after a remount (MYND-561) — the chevron's rotation is a CSS transform,
      // which Playwright can't read as state.
      data-collapsed={collapsed ? "true" : "false"}
      onClick={() => {
        if (held.current) { held.current = false; return; } // consumed by the long-press
        onToggle();
      }}
      onPointerDown={startHold}
      onPointerMove={moveHold}
      onPointerUp={clearHold}
      onPointerLeave={clearHold}
      onPointerCancel={clearHold}
      onContextMenu={(e) => e.preventDefault()}
      style={{ position: "relative", display: "flex", alignItems: "center", gap: 8, padding: "11px 20px", paddingLeft: indentPx, cursor: "pointer" }}
    >
      <svg width="12" height="12" viewBox="0 0 24 24" style={{ flexShrink: 0, transform: collapsed ? "rotate(0deg)" : "rotate(90deg)", transition: "transform 140ms ease" }}>
        <path d="M8 5l8 7-8 7" fill="none" stroke="var(--fg-3)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {icon ? (
        <span data-testid="notes.folder-glyph" data-icon-name={icon} style={{ display: "flex", flexShrink: 0, color: "var(--fg-2)" }}>
          <FolderGlyph name={icon} size={18} />
        </span>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" fill="none" stroke="var(--fg-2)" strokeWidth="1.6" strokeLinejoin="round" />
        </svg>
      )}
      <ColorDot slot={color} />
      <div style={{ flex: 1, minWidth: 0, fontSize: 16, fontWeight: 600, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
      <span style={{ width: 30, textAlign: "center", fontSize: 13, color: "var(--fg-3)", flexShrink: 0 }}>{count}</span>
    </div>
  );
}
