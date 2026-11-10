import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";

/** The workspace tab vocabulary, declared ONCE and imported by every consumer.
 *
 *  Wider than this bar's own columns on purpose: `search`, `note-tasks` and
 *  `templates` are reachable from the sidebar, the palette or a note, never
 *  from a bar button. What makes it one type is that they are all values of
 *  `EditorFlow`'s single `tab` state.
 *
 *  It is a shared type rather than four inline unions because myne-md/myne#457
 *  added `chat` and the four copies did not fail together. Three accepted the
 *  new member silently (they only widened) and the fourth, `TAB_ORDER`, failed
 *  with `TS7053` on an unrelated line, which is the reader's only clue that a
 *  page transition was about to slide the wrong way. Now the next addition
 *  fails at every site that has to answer for it.
 */
export type WorkspaceTab =
  | "notes"
  | "tasks"
  | "note-tasks"
  | "search"
  | "graph"
  | "files"
  | "templates"
  | "chat"
  | "calendar";

/** Bottom tab bar. Notes/Search/Graph switch the list-view tab; Settings opens
 *  the sheet. Active tab is accent-tinted. Bottom padding clears the home
 *  indicator via the safe-area inset (falls back to 30px in the gallery).
 *
 *  **Chat is the one conditional column** (myne-md/myne#457). It renders only
 *  when `ai` is true, and with it false the bar is exactly the four columns it
 *  was, no reserved gap. That is a deliberate divergence from desktop, where
 *  `rightPanelTabs.ts` keeps `ai-chat` in the vocabulary unconditionally and
 *  lets the tab BODY carry the off state: desktop's is a hideable, reorderable
 *  strip with room to spare, and this is top-level navigation with a hard
 *  column budget on a phone. A permanently-present fifth column would spend a
 *  fifth of the bar on a feature the user has turned off. */
export function TabBar({
  active,
  ai,
  onNotes,
  onTasks,
  onGraph,
  onAttachments,
  onCalendar,
  onChat,
}: {
  active: WorkspaceTab;
  /** `ai_enabled`. Required rather than defaulted, so a new call site cannot
   *  quietly render a four-tab bar while the other renders five. */
  ai: boolean;
  onNotes: () => void;
  onTasks: () => void;
  onGraph: () => void;
  onAttachments: () => void;
  onCalendar: () => void;
  onChat: () => void;
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
    // A flex item defaults to `min-width: auto`, which refuses to shrink below
    // its longest word. Without this the widest label decides the column
    // widths and the bar stops being five equal columns.
    minWidth: 0,
  };
  // The label is CONTAINED rather than measured. At five columns each gets a
  // fifth of the width instead of a quarter, and the labels are translated:
  // `fi` renders "Muistiinpanot" (13 characters) and `tr` renders "Yapay Zeka"
  // for this very tab, both of which are marginal at 10px on a 390px phone and
  // overflow outright on a narrower one. Measuring a font metric per locale is
  // not a thing this file can do, and asserting it in a test would pin one
  // engine's metrics; ellipsis makes the worst case a truncated word next to an
  // icon rather than text crossing into the neighbouring column.
  const label = (on: boolean): CSSProperties => ({
    fontSize: 10,
    fontWeight: on ? 600 : 500,
    color: col(on),
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  });
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
      <button data-testid="workspace.tab-notes" onClick={onNotes} aria-label={t("notes.list.notesHeading")} style={tab}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <rect x="5" y="3" width="14" height="18" rx="2.5" stroke={col(active === "notes")} strokeWidth="1.8" />
          <path d="M9 8h6M9 12h6M9 16h3" stroke={col(active === "notes")} strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span style={label(active === "notes")}>{t("notes.list.notesHeading")}</span>
      </button>
      {/* MYND-620: Tasks sits second, directly after Notes. Putting it in the
          bar at all is the information-architecture decision — it says tasks are
          alongside notes in the product's mobile identity — and it is hard to
          reverse, because top-level navigation is something users learn. */}
      <button data-testid="workspace.tab-tasks" onClick={onTasks} aria-label={t("common.tasks")} style={tab}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <rect x="4" y="4" width="6" height="6" rx="1.6" stroke={col(active === "tasks")} strokeWidth="1.8" />
          <path d="M5.4 7l1.3 1.3L9 5.8" stroke={col(active === "tasks")} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M13 6.5h7M13 12h7M13 17.5h7M5 12h5M5 17.5h5" stroke={col(active === "tasks")} strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span style={label(active === "tasks")}>{t("common.tasks")}</span>
      </button>
      <button data-testid="workspace.tab-graph" onClick={onGraph} aria-label={t("editor.chrome.barItems.graph")} style={tab}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <circle cx="6" cy="17" r="2.6" stroke={col(active === "graph")} strokeWidth="1.8" />
          <circle cx="18" cy="14" r="2.6" stroke={col(active === "graph")} strokeWidth="1.8" />
          <circle cx="13" cy="6" r="2.6" stroke={col(active === "graph")} strokeWidth="1.8" />
          <path d="M8.3 15.6l3-7M8.4 16.2l7-1.6" stroke={col(active === "graph")} strokeWidth="1.6" />
        </svg>
        <span style={label(active === "graph")}>{t("editor.chrome.barItems.graph")}</span>
      </button>
      <button data-testid="workspace.tab-files" onClick={onAttachments} aria-label={t("attachments.library.title")} style={tab}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <rect x="3" y="3" width="18" height="18" rx="2.5" stroke={col(active === "files")} strokeWidth="1.8" />
          <circle cx="8.5" cy="8.5" r="1.8" fill={col(active === "files")} />
          <path d="M21 15l-5-5L5 21" stroke={col(active === "files")} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span style={label(active === "files")}>{t("settings.shell.panels.files")}</span>
      </button>
      {/* The calendar was reachable only from the expanded-width sidebar, so on a
          phone the surface existed with no door to it (owner, 2026-11-10). It sits
          after Files and before the optional Chat: appending keeps every column
          users already learned where it was, and reordering top-level navigation is
          the one change a user cannot be told about. */}
      <button data-testid="workspace.tab-calendar" onClick={onCalendar} aria-label={t("calendar.title")} style={tab}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" stroke={col(active === "calendar")} strokeWidth="1.8" />
          <path d="M3.5 9.5h17M8 3v4M16 3v4" stroke={col(active === "calendar")} strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span style={label(active === "calendar")}>{t("calendar.title")}</span>
      </button>
      {/* Last, deliberately: it is the newest destination and the only optional
          one, so appending keeps every existing column where users learned it.
          Reordering top-level navigation is the one change a user cannot be
          told about. */}
      {ai && (
        <button data-testid="workspace.tab-chat" onClick={onChat} aria-label={t("settings.shell.panels.ai")} style={tab}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M20.5 12.2c0 4-3.8 7.2-8.5 7.2a10 10 0 01-2.6-.34L4.5 20.5l1.2-3.4A6.9 6.9 0 013.5 12.2c0-4 3.8-7.2 8.5-7.2s8.5 3.2 8.5 7.2z" stroke={col(active === "chat")} strokeWidth="1.8" strokeLinejoin="round" />
            <path d="M9 11.5h6M9 14.5h3.5" stroke={col(active === "chat")} strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <span style={label(active === "chat")}>{t("settings.shell.panels.ai")}</span>
        </button>
      )}
    </div>
  );
}
