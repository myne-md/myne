import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon, VaultMark, LIST_TOP } from "../../../components";

/** Expanded-only workspace sidebar (the WS-01 iPad three-pane reference:
 *  sidebar 248 / list 316 / editor flex — `src/ipad/index.tsx`). It absorbs the
 *  phone's AppHeader + TabBar destinations, so neither renders on expanded:
 *  vault switcher on top, search (opens the command palette), the tab
 *  destinations + list slices as nav items, and a sync + settings footer.
 *  Purely presentational — every row calls back into EditorFlow's existing
 *  setters, so it adds no new state or navigation machinery. */

const gi = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function NavItem({
  icon,
  label,
  active = false,
  testid,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  testid: string;
  onClick: () => void;
}) {
  return (
    <button
      data-testid={testid}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        width: "100%",
        padding: "8px 10px",
        border: "none",
        borderRadius: 6,
        background: active ? "var(--accent-soft)" : "transparent",
        color: active ? "var(--accent)" : "var(--fg-2)",
        fontFamily: "var(--font-sans)",
        fontSize: 14,
        fontWeight: active ? 600 : 400,
        textAlign: "start",
        cursor: "pointer",
      }}
    >
      {icon}
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
    </button>
  );
}

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{ marginTop: 14, padding: "6px 10px", fontSize: 11, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: "var(--fg-3)" }}>
      {children}
    </div>
  );
}

export function SidebarPane({
  label,
  icon,
  tab,
  listView,
  onAllNotes,
  onTasks,
  onNoteTasks,
  onGraph,
  onFiles,
  onTemplates,
  onViews,
  onTags,
  onArchive,
  onTrash,
  onSearch,
  onSwitcher,
  onSettings,
}: {
  label: string;
  icon: string | null;
  tab: "notes" | "tasks" | "note-tasks" | "search" | "graph" | "files" | "templates";
  listView: "notes" | "archive" | "trash";
  onAllNotes: () => void;
  onTasks: () => void;
  /** Omitted when no note is open — a note-scoped tab with no note is a row
   *  that cannot do anything. */
  onNoteTasks?: () => void;
  onGraph: () => void;
  onFiles: () => void;
  onTemplates: () => void;
  onViews: () => void;
  onTags: () => void;
  onArchive: () => void;
  onTrash: () => void;
  onSearch: () => void;
  onSwitcher: () => void;
  onSettings: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="workspace.sidebar"
      style={{
        width: 248,
        flex: "none",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        borderInlineEnd: "1px solid var(--line-1)",
        background: "var(--bg-2)",
        padding: `${LIST_TOP} 12px 0`,
      }}
    >
      {/* Vault switcher — same affordance as the phone AppHeader's left button. */}
      <button
        data-testid="sidebar.vault-switcher"
        onClick={onSwitcher}
        style={{ display: "flex", alignItems: "center", gap: 7, border: "none", background: "transparent", padding: "4px 10px 10px", cursor: "pointer", minWidth: 0 }}
      >
        <VaultMark icon={icon} size={22} radius={4} testId="sidebar.vault-mark" />
        <span style={{ fontSize: 15, fontWeight: 600, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
          <path d="M2 4l4 4 4-4" stroke="var(--fg-3)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <div style={{ marginTop: 12, flex: 1, minHeight: 0, overflowY: "auto" }}>
        <NavItem
          testid="sidebar.nav-notes"
          label={t("editor.nav.allNotes")}
          active={tab === "notes" && listView === "notes"}
          onClick={onAllNotes}
          icon={<svg width="17" height="17" viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2.5" {...gi} /><path d="M9 8h6M9 12h6M9 16h3" {...gi} /></svg>}
        />
        {/* Search — a plain nav button under All Notes that opens the full command
            palette (SC-01), not an inline search field. */}
        <NavItem
          testid="sidebar.search"
          label={t("notes.filterBuilder.type.search")}
          onClick={onSearch}
          icon={<svg width="17" height="17" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" {...gi} /><path d="M21 21l-4.3-4.3" {...gi} /></svg>}
        />
        {/* MYND-620 task 5: BOTH scopes as sidebar tabs. On a larger screen the
            sidebar can show tasks BESIDE a note rather than instead of it,
            which is the whole reason the expanded layout exists — so the
            note-scoped list is a tab here rather than the phone's sheet. */}
        <NavItem
          testid="sidebar.nav-tasks"
          label={t("tasks.title")}
          active={tab === "tasks"}
          onClick={onTasks}
          icon={<svg width="17" height="17" viewBox="0 0 24 24"><rect x="4" y="4" width="6" height="6" rx="1.6" {...gi} /><path d="M5.4 7l1.3 1.3L9 5.8" {...gi} /><path d="M13 6.5h7M13 12h7M13 17.5h7M5 12h5M5 17.5h5" {...gi} /></svg>}
        />
        {onNoteTasks !== undefined && (
          <NavItem
            testid="sidebar.nav-note-tasks"
            label={t("tasks.noteTitle")}
            active={tab === "note-tasks"}
            onClick={onNoteTasks}
            icon={<svg width="17" height="17" viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2.5" {...gi} /><path d="M9 9h6M9 13h4" {...gi} /><path d="M8.6 17.2l1 1 2-2.2" {...gi} /></svg>}
          />
        )}
        <NavItem
          testid="sidebar.nav-graph"
          label={t("editor.chrome.barItems.graph")}
          active={tab === "graph"}
          onClick={onGraph}
          icon={<svg width="17" height="17" viewBox="0 0 24 24"><circle cx="6" cy="17" r="2.4" {...gi} /><circle cx="18" cy="14" r="2.4" {...gi} /><circle cx="13" cy="6" r="2.4" {...gi} /><path d="M8.3 15.6l3-7M8.4 16.2l7-1.6" {...gi} /></svg>}
        />
        <NavItem
          testid="sidebar.nav-files"
          label={t("settings.shell.panels.files")}
          active={tab === "files"}
          onClick={onFiles}
          icon={<svg width="17" height="17" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" {...gi} /><path d="M21 15l-5-5L5 21" {...gi} /></svg>}
        />
        <NavItem
          testid="sidebar.nav-templates"
          label={t("templates.manager.listLabel")}
          active={tab === "templates"}
          onClick={onTemplates}
          icon={<svg width="17" height="17" viewBox="0 0 24 24"><rect x="8" y="4" width="11" height="14" rx="2" {...gi} /><path d="M5 8v10a2 2 0 002 2h8" {...gi} /></svg>}
        />

        <GroupLabel>{t("editor.sidebar.browse")}</GroupLabel>
        <NavItem
          testid="sidebar.nav-views"
          label={t("editor.chrome.barItems.views")}
          onClick={onViews}
          icon={<svg width="17" height="17" viewBox="0 0 24 24"><path d="M12 2 2 7l10 5 10-5-10-5z" {...gi} /><path d="M2 12l10 5 10-5" {...gi} /><path d="M2 17l10 5 10-5" {...gi} /></svg>}
        />
        <NavItem
          testid="sidebar.nav-tags"
          label={t("editor.chrome.barItems.tags")}
          onClick={onTags}
          icon={<svg width="17" height="17" viewBox="0 0 24 24"><path d="M4 4h7l9 9-7 7-9-9z" {...gi} /><circle cx="8" cy="8" r="1.1" fill="currentColor" /></svg>}
        />
        <NavItem
          testid="sidebar.nav-archive"
          label={t("notes.archive.title")}
          active={tab === "notes" && listView === "archive"}
          onClick={onArchive}
          icon={<svg width="17" height="17" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="5" rx="1" {...gi} /><path d="M5 9v10a1 1 0 001 1h12a1 1 0 001-1V9M9 13h6" {...gi} /></svg>}
        />
        <NavItem
          testid="sidebar.nav-trash"
          label={t("notes.list.trash")}
          active={tab === "notes" && listView === "trash"}
          onClick={onTrash}
          icon={<svg width="17" height="17" viewBox="0 0 24 24"><path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13" {...gi} /></svg>}
        />
      </div>

      {/* Footer — settings (the phone puts this in the header). Sync status moved
          out of the general UI into Settings → Sync (MYND-481). */}
      <div
        data-testid="sidebar.footer"
        style={{ flex: "none", borderTop: "1px solid var(--line-1)", paddingTop: 8, paddingBottom: "calc(8px + env(safe-area-inset-bottom, 0px))" }}
      >
        <NavItem
          testid="sidebar.settings"
          label={t("editor.chrome.barItems.settings")}
          onClick={onSettings}
          icon={<Icon name="settings" size={17} color="var(--fg-2)" strokeWidth={1.7} />}
        />
      </div>
    </div>
  );
}
