import type { CSSProperties } from "react";
import { ornamentRole } from "@myne/ornaments";
import { useTranslation } from "react-i18next";
import { Icon, LIST_TOP } from "../../../../components";
import { tappable } from "../../../a11y/tappable";

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
  peers,
  onPresence,
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
  /** How many OTHER people are editing this note right now (myne-md/myne#849).
   *  Zero or absent means the affordance is OMITTED rather than shown disabled
   *  (`decisions.md` 2026-07-26: an offer the platform cannot honour is not
   *  rendered), so being alone is the normal state and costs no chrome. */
  peers?: number;
  /** Open the presence roster. Required for the chip to appear at all. */
  onPresence?: () => void;
  folder: string | null;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const presence = peers !== undefined && peers > 0 && onPresence !== undefined;
  return (
    <div
      data-testid="editor.top-bar"
      // Ornament role (myne#394): a bar is CHROME, so the active theme decides
      // what bars wear. Declared here rather than in a stylesheet because this
      // element is where the bar exists.
      {...ornamentRole("chrome")}
      style={{
        flex: "none",
        paddingTop: EDITOR_TOP,
        paddingInline: 8,
        paddingBottom: 8,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 6,
        borderBottom: "1px solid var(--line-1)",
      }}
    >
      {onBack && (
        <button onClick={onBack} disabled={busy} data-testid="editor.back" aria-label={t("editor.topBar.backToNotes")} style={{ ...chromeBtn, opacity: busy ? 0.5 : 1 }}>
          <Icon name="chevron-left" size={22} color="var(--accent)" strokeWidth={2} flip />
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
        {presence && (
          // Who is here (myne-md/myne#849 task 6): the mobile entry point to the
          // presence roster. A count chip rather than an icon, because the useful
          // fact on a phone is "two other people are in this note", and the chip
          // appears only while that is true. `tappable` rather than one more raw
          // button: this file already carries the primitive-adoption ratchet's
          // count and a new raw element would grow it.
          <span
            {...tappable({ onActivate: onPresence, label: t("editor.chrome.presence.showList", { count: peers }) })}
            data-testid="editor.presence-chip"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-1)",
              // The touch floor, from the sheet the canon says to use rather than
              // a per-component literal. `check-token-adoption.mjs` cannot see a
              // height literal (its counted families are colour and
              // radius/padding/gap/margin/font-size/weight), so nothing else would
              // have caught this.
              // In BOTH axes: a one-digit count is about 33px wide, and a touch
              // target is a square floor rather than a height (myne-md/myne#849
              // review, D6).
              minHeight: "var(--m-touch)",
              minWidth: "var(--m-touch)",
              justifyContent: "center",
              padding: "0 var(--space-2)",
              // The small radius: `DESIGN.md` reserves the pill for status pills
              // and inline editor chips, and this is a chip outside the editor.
              borderRadius: "var(--radius-1)",
              background: "var(--bg-2)",
              color: "var(--fg-2)",
              fontSize: "var(--text-xs)",
              fontWeight: "var(--weight-semibold)",
              cursor: "pointer",
              flex: "none",
            }}
          >
            <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "var(--radius-pill)", background: "var(--accent)" }} />
            {peers}
          </span>
        )}
        <button onClick={onContext} aria-label={t("editor.topBar.noteDetails")} style={chromeBtn}>
          <svg width="21" height="21" viewBox="0 0 24 24" fill="none">
            <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" stroke="var(--fg-2)" strokeWidth="1.7" />
            <rect x="14.5" y="4.5" width="6" height="15" rx="2.5" fill="var(--fg-2)" opacity="0.85" />
          </svg>
        </button>
        {onMore && (
          <button onClick={onMore} data-testid="editor.more" aria-label={t("editor.topBar.noteActions")} style={chromeBtn}>
            <svg width="21" height="21" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6" fill="var(--fg-2)" /><circle cx="12" cy="12" r="1.6" fill="var(--fg-2)" /><circle cx="19" cy="12" r="1.6" fill="var(--fg-2)" /></svg>
          </button>
        )}
      </div>
    </div>
  );
}
