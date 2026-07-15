import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Icon, LIST_TOP } from "../../../../components";

/** Status-bar clearance for a top action bar: the real OS safe-area inset on
 *  device (viewport-fit=cover), or a floor tall enough to clear the iPhone
 *  Dynamic Island where env() under-reports. Kept identical to `LIST_TOP` so the
 *  editor header, list header, and side-panel headers all line up. */
const EDITOR_TOP = LIST_TOP;

const chromeBtn: CSSProperties = {
  width: 38,
  height: 38,
  borderRadius: 9,
  border: "none",
  background: "transparent",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  flex: "none",
};

/** Minimal editor top bar (the "it's a page, not a modal" chrome). Back
 *  autosaves and returns to the list; the title lives inline as the note's first
 *  line, so the bar only carries the context-panel toggle + the ⋯ actions menu.
 *  `onBack` is omitted on the regular (multi-pane) size classes — the list stays
 *  on screen, so there is nothing to go "back" to; saves happen on selection
 *  change / archive / lock instead. */
export function EditorTopBar({
  onBack,
  onToggleList,
  onContext,
  onMore,
  folder,
  busy,
}: {
  /** Back chevron (autosave + return to the list). Compact-only. */
  onBack?: () => void;
  /** Reveal/hide the note list + sidebar. Regular size classes only — a focused
   *  note collapses the left panes; this toggle brings them back. */
  onToggleList?: () => void;
  onContext: () => void;
  /** Note-actions ⋯ menu. Omitted for a brand-new (unsaved) note. */
  onMore?: () => void;
  folder: string | null;
  busy: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="editor.top-bar"
      style={{
        flex: "none",
        padding: `${EDITOR_TOP} 8px 8px`,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 6,
        borderBottom: "1px solid var(--line-1)",
      }}
    >
      {onBack && (
        <button onClick={onBack} disabled={busy} data-testid="editor.back" aria-label={t("editor.topBar.backToNotes")} style={{ ...chromeBtn, opacity: busy ? 0.5 : 1 }}>
          <Icon name="chevron-left" size={22} color="var(--accent)" strokeWidth={2} />
        </button>
      )}
      {onToggleList && (
        <button onClick={onToggleList} data-testid="editor.toggle-list" aria-label={t("notes.list.notesHeading")} style={chromeBtn}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <rect x="3" y="4.5" width="18" height="15" rx="2" stroke="var(--fg-2)" strokeWidth="1.7" />
            <path d="M9 4.5v15" stroke="var(--fg-2)" strokeWidth="1.7" />
          </svg>
        </button>
      )}

      <div style={{ flex: 1, minWidth: 0, textAlign: "center", fontSize: 12, color: "var(--fg-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)" }}>
        {folder ? folder.replace(/\/$/, "").replace(/\//g, " / ") : ""}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 2, flex: "none" }}>
        <button onClick={onContext} aria-label={t("editor.topBar.noteDetails")} style={chromeBtn}>
          <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
            <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="var(--fg-2)" strokeWidth="1.7" />
            <rect x="14.5" y="4.5" width="6" height="15" rx="2.5" fill="var(--fg-2)" opacity="0.85" />
          </svg>
        </button>
        {onMore && (
          <button onClick={onMore} aria-label={t("editor.topBar.noteActions")} style={chromeBtn}>
            <svg width="21" height="21" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6" fill="var(--fg-2)" /><circle cx="12" cy="12" r="1.6" fill="var(--fg-2)" /><circle cx="19" cy="12" r="1.6" fill="var(--fg-2)" /></svg>
          </button>
        )}
      </div>
    </div>
  );
}
