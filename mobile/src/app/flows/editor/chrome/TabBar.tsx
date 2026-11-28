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
  | "home"
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
        // A docked surface, not a floating card (owner, 2026-11-27): flush to
        // the left/right/bottom edges with only the TOP corners rounded, the
        // shape iOS uses for a persistent bottom bar. The hairline top border
        // went with the inset card: the rounded edge is the separator now, and
        // a straight line under a rounded edge is what made the old bar read as
        // a rectangle pasted onto the screen.
        // The docked shape keeps its rounded top edge, but it must still READ as
        // a surface above the content (owner, 2026-11-27 round 2: "ikonlar güzel
        // olmuş ama ayrım hiç yok şimdi de üst taraf ve bottom bar ile"): a
        // hairline that follows the rounded corners is what separates a bar from
        // the page, and `--bg-2` lifts it one step off the content.
        borderTop: "none",
        boxShadow: "inset 0 1px 0 var(--line-1)",
        borderRadius: "var(--m-radius-sheet) var(--m-radius-sheet) 0 0",
        background: "var(--bg-2)",
        // The bar is TOP-LEVEL NAVIGATION and no destination may cover it. The
        // calendar draws itself as a full-screen surface at `--z-dropdown` (it has to
        // cover the list, the header and the editor), so on a phone opening the
        // calendar used to hide the only way back except its own ✕ — owner,
        // 2026-11-10: "takvimi açınca geri gidemiyorum, bottom bar yok oluyor".
        // One step above that surface, and still far below a modal or a sheet, which
        // is what those levels are for.
        position: "relative",
        zIndex: "calc(var(--z-dropdown) + 1)",
        // Height matched to the editor FormatBar (~52px + safe-area) so the two
        // bottom bars line up on the tablet split — was taller via an 8px top +
        // 30px floor.
        padding: "6px 0 calc(6px + env(safe-area-inset-bottom, 0px))",
      }}
    >
      <button data-testid="workspace.tab-notes" onClick={onNotes} aria-label={t("notes.list.notesHeading")} style={tab}>
        {/* One stroke idea per glyph, 24-grid, no interior detail smaller than a
            touch pixel: the owner's note was that the bar's icons read as
            low-quality because each one carried three or four features
            ("ikonların kompleks olmasından"). Notes is a sheet with a fold. */}
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M6 3.5h9.5L19 7v13a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1-1.5z" stroke={col(active === "notes")} strokeWidth="1.7" strokeLinejoin="round" />
          <path d="M8.5 11h7M8.5 15h4.5" stroke={col(active === "notes")} strokeWidth="1.7" strokeLinecap="round" />
        </svg>
        <span style={label(active === "notes")}>{t("notes.list.notesHeading")}</span>
      </button>
      {/* MYND-620: Tasks sits second, directly after Notes. Putting it in the
          bar at all is the information-architecture decision — it says tasks are
          alongside notes in the product's mobile identity — and it is hard to
          reverse, because top-level navigation is something users learn. */}
      <button data-testid="workspace.tab-tasks" onClick={onTasks} aria-label={t("common.tasks")} style={tab}>
        {/* A single check in a rounded box. The previous glyph was a checkbox
            PLUS four list lines, which at 24px is a smudge. */}
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3.5" y="3.5" width="17" height="17" rx="4" stroke={col(active === "tasks")} strokeWidth="1.7" />
          <path d="M8 12.3l2.7 2.7L16 9.5" stroke={col(active === "tasks")} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span style={label(active === "tasks")}>{t("common.tasks")}</span>
      </button>
      <button data-testid="workspace.tab-graph" onClick={onGraph} aria-label={t("editor.chrome.barItems.graph")} style={tab}>
        {/* Three nodes joined by two edges, balanced around the centre so the
            glyph reads at a glance. Radii are equal: unequal circles were what
            made the old one look accidental. */}
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="6" cy="7" r="2.6" stroke={col(active === "graph")} strokeWidth="1.7" />
          <circle cx="18" cy="10" r="2.6" stroke={col(active === "graph")} strokeWidth="1.7" />
          <circle cx="9" cy="18" r="2.6" stroke={col(active === "graph")} strokeWidth="1.7" />
          <path d="M8.3 8.4l7.4 1.2M7.2 9.4l1.4 6.2" stroke={col(active === "graph")} strokeWidth="1.7" strokeLinecap="round" />
        </svg>
        <span style={label(active === "graph")}>{t("editor.chrome.barItems.graph")}</span>
      </button>
      <button data-testid="workspace.tab-files" onClick={onAttachments} aria-label={t("attachments.library.title")} style={tab}>
        {/* A folder, not a picture. The old glyph was the image/picture icon,
            so the column labelled "Files" showed a photo placeholder and read
            as a photo library. Attachments are files; the folder says so. */}
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M3.5 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.7.9l.9 1.4a2 2 0 0 0 1.7.9H19a2 2 0 0 1 2 2v6.8a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z" stroke={col(active === "files")} strokeWidth="1.7" strokeLinejoin="round" />
        </svg>
        <span style={label(active === "files")}>{t("settings.shell.panels.files")}</span>
      </button>
      {/* The calendar was reachable only from the expanded-width sidebar, so on a
          phone the surface existed with no door to it (owner, 2026-11-10). It sits
          after Files and before the optional Chat: appending keeps every column
          users already learned where it was, and reordering top-level navigation is
          the one change a user cannot be told about. */}
      <button data-testid="workspace.tab-calendar" onClick={onCalendar} aria-label={t("calendar.title")} style={tab}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3.5" y="5" width="17" height="15.5" rx="3" stroke={col(active === "calendar")} strokeWidth="1.7" />
          <path d="M3.5 9.8h17M8 3.2v3.6M16 3.2v3.6" stroke={col(active === "calendar")} strokeWidth="1.7" strokeLinecap="round" />
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
