import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon, LIST_TOP, VaultMark } from "../../../../components";
import { RIBBON_ORDER, ribbonLayout, type RibbonItemId } from "../../../../lib/nav-ribbon";
import { LayoutCustomizeSheet, type CustomizeRow } from "./LayoutCustomizeSheet";
import type { WorkspaceTab } from "./TabBar";

/** The expanded-size-class navigation rail (myne-md/myne, 2026-11-27 polish
 *  round).
 *
 *  **Why a rail rather than the 248px labelled sidebar.** On a portrait iPad the
 *  old arrangement was sidebar 248 + list 316 + editor, which the owner read as
 *  "3 column layout olunca çok rahatsız edici bir look" — three panels where two
 *  belong on a screen that narrow. The desktop client already answers this with
 *  a narrow icon rail beside its sidebar, so the rail is the desktop-like shape:
 *  it keeps every destination one tap away and hands ~180px back to the list and
 *  the note.
 *
 *  **Customizable, like the desktop ribbon** (owner: "kişiye göre çok
 *  customizable olması lazım"). Order and visibility live in device-local
 *  storage (`lib/nav-ribbon.ts`), never in synced prefs, and the gear-tail
 *  `RibbonCustomizeSheet` is where they are edited.
 *
 *  Every icon carries an `aria-label` and a `title`: an icon-only rail is only
 *  usable if the name is announced and hoverable, which is the same reason the
 *  notes header's action tiles became icon-only with a name. */

const gi = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

interface RibbonItem {
  id: RibbonItemId;
  labelKey: string;
  icon: ReactNode;
  /** The tab this destination selects, for the active state. */
  tab?: WorkspaceTab;
  /** Or the list slice, for the two that are `tab: notes` variants. */
  listView?: "notes" | "archive" | "trash";
}

const ITEMS: Record<RibbonItemId, RibbonItem> = {
  search: {
    id: "search",
    labelKey: "notes.filterBuilder.type.search",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="7" {...gi} />
        <path d="M21 21l-4.3-4.3" {...gi} />
      </svg>
    ),
  },
  tasks: {
    id: "tasks",
    labelKey: "common.tasks",
    tab: "tasks",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3.5" y="3.5" width="17" height="17" rx="4" {...gi} />
        <path d="M8 12.3l2.7 2.7L16 9.5" {...gi} />
      </svg>
    ),
  },
  "note-tasks": {
    id: "note-tasks",
    labelKey: "tasks.noteTitle",
    tab: "note-tasks",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 3.5h9.5L19 7v13a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1-1.5z" {...gi} />
        <path d="M8.5 12.6l1.3 1.3 2.7-2.7" {...gi} />
        <path d="M14.5 13h1.5" {...gi} />
      </svg>
    ),
  },
  graph: {
    id: "graph",
    labelKey: "editor.chrome.barItems.graph",
    tab: "graph",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="6" cy="7" r="2.6" {...gi} />
        <circle cx="18" cy="10" r="2.6" {...gi} />
        <circle cx="9" cy="18" r="2.6" {...gi} />
        <path d="M8.3 8.4l7.4 1.2M7.2 9.4l1.4 6.2" {...gi} />
      </svg>
    ),
  },
  calendar: {
    id: "calendar",
    labelKey: "calendar.title",
    tab: "calendar",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3.5" y="5" width="17" height="15.5" rx="3" {...gi} />
        <path d="M3.5 9.8h17M8 3.2v3.6M16 3.2v3.6" {...gi} />
      </svg>
    ),
  },
  files: {
    id: "files",
    labelKey: "settings.shell.panels.files",
    tab: "files",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3.5 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.7.9l.9 1.4a2 2 0 0 0 1.7.9H19a2 2 0 0 1 2 2v6.8a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z" {...gi} />
      </svg>
    ),
  },
  templates: {
    id: "templates",
    labelKey: "templates.manager.listLabel",
    tab: "templates",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="8" y="4" width="11" height="14" rx="2" {...gi} />
        <path d="M5 8v10a2 2 0 002 2h8" {...gi} />
      </svg>
    ),
  },
  views: {
    id: "views",
    labelKey: "editor.chrome.barItems.views",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 2 2 7l10 5 10-5-10-5z" {...gi} />
        <path d="M2 12l10 5 10-5" {...gi} />
        <path d="M2 17l10 5 10-5" {...gi} />
      </svg>
    ),
  },
  tags: {
    id: "tags",
    labelKey: "editor.chrome.barItems.tags",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 4h7l9 9-7 7-9-9z" {...gi} />
        <circle cx="8" cy="8" r="1.1" fill="currentColor" />
      </svg>
    ),
  },
  archive: {
    id: "archive",
    labelKey: "notes.archive.title",
    tab: "notes",
    listView: "archive",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="4" width="18" height="5" rx="1.5" {...gi} />
        <path d="M5 9v10a1 1 0 001 1h12a1 1 0 001-1V9M9 13h6" {...gi} />
      </svg>
    ),
  },
  trash: {
    id: "trash",
    labelKey: "notes.list.trash",
    tab: "notes",
    listView: "trash",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2" {...gi} />
        <path d="M19 7l-1 13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 7" {...gi} />
        <path d="M10 11v6M14 11v6" {...gi} />
      </svg>
    ),
  },
  chat: {
    id: "chat",
    labelKey: "settings.shell.panels.ai",
    tab: "chat",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20.5 12.2c0 4-3.8 7.2-8.5 7.2a10 10 0 01-2.6-.34L4.5 20.5l1.2-3.4A6.9 6.9 0 013.5 12.2c0-4 3.8-7.2 8.5-7.2s8.5 3.2 8.5 7.2z" {...gi} />
        <path d="M9 11.5h6M9 14.5h3.5" {...gi} />
      </svg>
    ),
  },
};

/** One 40×40 rail button. */
function RailButton({
  label,
  active = false,
  testid,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  testid: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      title={label}
      onClick={onClick}
      style={{
        width: 40,
        height: 40,
        flex: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "none",
        borderRadius: 10,
        background: active ? "var(--accent-soft)" : "transparent",
        color: active ? "var(--accent)" : "var(--fg-2)",
        cursor: "pointer",
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

export function NavRibbon({
  label,
  icon,
  tab,
  listView,
  hasNote,
  aiEnabled,
  onHome,
  onAllNotes,
  onTasks,
  onNoteTasks,
  onGraph,
  onCalendar,
  onFiles,
  onTemplates,
  onChat,
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
  tab: WorkspaceTab;
  listView: "notes" | "archive" | "trash";
  hasNote: boolean;
  aiEnabled: boolean;
  onHome: () => void;
  onAllNotes: () => void;
  onTasks: () => void;
  onNoteTasks?: () => void;
  onGraph: () => void;
  onCalendar: () => void;
  onFiles: () => void;
  onTemplates: () => void;
  onChat?: () => void;
  onViews: () => void;
  onTags: () => void;
  onArchive: () => void;
  onTrash: () => void;
  onSearch: () => void;
  onSwitcher: () => void;
  onSettings: () => void;
}) {
  const { t } = useTranslation();
  const layout = ribbonLayout.useLayout();
  const [customizeOpen, setCustomizeOpen] = useState(false);

  const run = (id: RibbonItemId) => {
    switch (id) {
      case "search":
        return onSearch();
      case "tasks":
        return onTasks();
      case "note-tasks":
        return onNoteTasks?.();
      case "graph":
        return onGraph();
      case "calendar":
        return onCalendar();
      case "files":
        return onFiles();
      case "templates":
        return onTemplates();
      case "views":
        return onViews();
      case "tags":
        return onTags();
      case "archive":
        return onArchive();
      case "trash":
        return onTrash();
      case "chat":
        return onChat?.();
    }
  };

  // A destination with no handler right now (note-scoped tasks with no note, AI
  // while `ai_enabled` is off) is NOT rendered rather than rendered dead — the
  // same call `SidebarPane` makes by taking the handler as optional.
  const available = (id: RibbonItemId): boolean => {
    if (id === "note-tasks") return hasNote && onNoteTasks !== undefined;
    if (id === "chat") return aiEnabled && onChat !== undefined;
    return true;
  };

  const visible = layout.order.filter((id) => available(id) && !layout.hidden.includes(id));

  return (
    <>
      <div
        data-testid="workspace.ribbon"
        style={{
          width: 64,
          flex: "none",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 4,
          minHeight: 0,
          borderInlineEnd: "1px solid var(--line-1)",
          background: "var(--bg-2)",
          // The SAME clearance the list's title uses, so the rail's vault mark and
          // the page title sit on one line (owner, 2026-11-27 round 3: "soldaki
          // vault selector ile eşitlenmeli").
          paddingTop: LIST_TOP,
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 10px)",
        }}
      >
        <button
          type="button"
          data-testid="ribbon.vault-switcher"
          onClick={onSwitcher}
          aria-label={label}
          title={label}
          style={{
            border: "none",
            background: "transparent",
            padding: 0,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            // Matches the list header's line box (a 32pt title), so the mark and
            // the page title sit on one horizontal line.
            height: 38,
            marginBottom: 6,
          }}
        >
          <VaultMark icon={icon} size={26} radius={5} testId="ribbon.vault-mark" />
        </button>

        <RailButton label={t("notes.home.title")} testid="ribbon.nav-home" active={tab === "home"} onClick={onHome}>
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z" {...gi} />
          </svg>
        </RailButton>

        <RailButton label={t("common.allnotes")} testid="ribbon.nav-notes" active={tab === "notes" && listView === "notes"} onClick={onAllNotes}>
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 3.5h9.5L19 7v13a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20V5a1.5 1.5 0 0 1 1-1.5z" {...gi} />
            <path d="M8.5 11h7M8.5 15h4.5" {...gi} />
          </svg>
        </RailButton>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
          {visible.map((id) => {
            const item = ITEMS[id];
            const active =
              (item.tab !== undefined && item.tab === tab && item.listView === undefined) ||
              (item.listView !== undefined && tab === "notes" && listView === item.listView);
            return (
              <RailButton key={id} label={t(item.labelKey)} testid={`ribbon.nav-${id}`} active={active} onClick={() => run(id)}>
                {item.icon}
              </RailButton>
            );
          })}
        </div>

        <RailButton
          label={t("editor.sidebar.customize")}
          testid="ribbon.customize"
          onClick={() => setCustomizeOpen(true)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" {...gi} />
            <circle cx="16" cy="6" r="2" {...gi} />
            <circle cx="10" cy="12" r="2" {...gi} />
            <circle cx="18" cy="18" r="2" {...gi} />
          </svg>
        </RailButton>
        <RailButton label={t("editor.chrome.barItems.settings")} testid="ribbon.settings" onClick={onSettings}>
          <Icon name="settings" size={20} color="var(--fg-2)" strokeWidth={1.7} />
        </RailButton>
      </div>

      {customizeOpen && (
        <LayoutCustomizeSheet
          title={t("editor.sidebar.customize")}
          rows={layout.order.map((id): CustomizeRow => {
            const item = ITEMS[id];
            const supported = available(id) && (id === "chat" ? aiEnabled : id === "note-tasks" ? hasNote : true);
            return {
              id,
              label: t(item.labelKey),
              icon: item.icon,
              supported,
              shown: supported && !layout.hidden.includes(id),
            };
          })}
          onToggle={(id, shown) => ribbonLayout.setHidden(id as RibbonItemId, shown)}
          onMove={(id, delta) => ribbonLayout.move(id as RibbonItemId, delta)}
          onReset={() => ribbonLayout.reset()}
          onClose={() => setCustomizeOpen(false)}
        />
      )}
    </>
  );
}

/** Canonical order, exported for tests that assert the rail cannot lose a
 *  destination the vocabulary defines. */
export const RIBBON_ITEM_IDS = RIBBON_ORDER;
