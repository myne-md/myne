import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

/** Bottom tab bar. Notes/Search/Graph switch the list-view tab; Settings opens
 *  the sheet. Active tab is accent-tinted. Bottom padding clears the home
 *  indicator via the safe-area inset (falls back to 30px in the gallery). */
export function TabBar({
  active,
  onNotes,
  onGraph,
  onAttachments,
}: {
  active: "notes" | "search" | "graph" | "files" | "templates";
  onNotes: () => void;
  onGraph: () => void;
  onAttachments: () => void;
}) {
  const { t } = useTranslation();
  const col = (on: boolean) => (on ? "var(--accent)" : "var(--fg-3)");
  const tab: CSSProperties = {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 3,
    border: "none",
    background: "transparent",
    cursor: "pointer",
    padding: 0,
  };
  const label = (on: boolean): CSSProperties => ({ fontSize: 10, fontWeight: on ? 600 : 500, color: col(on) });
  return (
    <div
      data-testid="workspace.tab-bar"
      style={{
        flex: "none",
        display: "flex",
        borderTop: "1px solid var(--line-1)",
        background: "var(--bg-1)",
        // Height matched to the editor FormatBar (~52px + safe-area) so the two
        // bottom bars line up on the tablet split — was taller via an 8px top +
        // 30px floor.
        padding: "6px 0 calc(6px + env(safe-area-inset-bottom, 0px))",
      }}
    >
      <button onClick={onNotes} aria-label={t("notes.list.notesHeading")} style={tab}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <rect x="5" y="3" width="14" height="18" rx="2.5" stroke={col(active === "notes")} strokeWidth="1.8" />
          <path d="M9 8h6M9 12h6M9 16h3" stroke={col(active === "notes")} strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span style={label(active === "notes")}>{t("notes.list.notesHeading")}</span>
      </button>
      <button onClick={onGraph} aria-label={t("editor.chrome.barItems.graph")} style={tab}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="6" cy="17" r="2.6" stroke={col(active === "graph")} strokeWidth="1.8" />
          <circle cx="18" cy="14" r="2.6" stroke={col(active === "graph")} strokeWidth="1.8" />
          <circle cx="13" cy="6" r="2.6" stroke={col(active === "graph")} strokeWidth="1.8" />
          <path d="M8.3 15.6l3-7M8.4 16.2l7-1.6" stroke={col(active === "graph")} strokeWidth="1.6" />
        </svg>
        <span style={label(active === "graph")}>{t("editor.chrome.barItems.graph")}</span>
      </button>
      <button onClick={onAttachments} aria-label={t("attachments.library.title")} style={tab}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <rect x="3" y="3" width="18" height="18" rx="2.5" stroke={col(active === "files")} strokeWidth="1.8" />
          <circle cx="8.5" cy="8.5" r="1.8" fill={col(active === "files")} />
          <path d="M21 15l-5-5L5 21" stroke={col(active === "files")} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span style={label(active === "files")}>{t("settings.shell.panels.files")}</span>
      </button>
    </div>
  );
}
