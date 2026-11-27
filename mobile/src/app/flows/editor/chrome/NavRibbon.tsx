import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon, Sheet, VaultMark } from "../../../../components";
import {
  RIBBON_ORDER,
  moveRibbonItem,
  resetRibbonLayout,
  setRibbonItemHidden,
  useRibbonLayout,
  type RibbonItemId,
} from "../../../../lib/nav-ribbon";
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
  const layout = useRibbonLayout();
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
          paddingTop: "calc(env(safe-area-inset-top, 0px) + 10px)",
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 10px)",
        }}
      >
        <button
          type="button"
          data-testid="ribbon.vault-switcher"
          onClick={onSwitcher}
          aria-label={label}
          title={label}
          style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", display: "flex", marginBottom: 10 }}
        >
          <VaultMark icon={icon} size={26} radius={5} testId="ribbon.vault-mark" />
        </button>

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
        <Sheet onClose={() => setCustomizeOpen(false)}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "4px 0 12px" }}>
            <span style={{ fontSize: 17, fontWeight: 600, color: "var(--fg-1)" }}>{t("editor.sidebar.customize")}</span>
            <button
              type="button"
              onClick={() => resetRibbonLayout()}
              style={{ border: "none", background: "transparent", color: "var(--accent)", fontSize: 14, fontWeight: 600, cursor: "pointer", padding: 0 }}
            >
              {t("common.reset")}
            </button>
          </div>
          <div style={{ maxHeight: "50vh", overflowY: "auto" }}>
            {layout.order.map((id) => {
              const item = ITEMS[id];
              const supported = id === "chat" ? aiEnabled : id === "note-tasks" ? hasNote : true;
              const shown = !layout.hidden.includes(id) && supported && available(id);
              return (
                <div
                  key={id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    minHeight: 48,
                    borderBottom: "1px solid var(--line-1)",
                    opacity: supported ? 1 : 0.5,
                  }}
                >
                  <span style={{ display: "flex", color: "var(--fg-2)", flex: "none" }}>{item.icon}</span>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 15, color: "var(--fg-1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {t(item.labelKey)}
                  </span>
                  {/* Reorder: two 40px targets, disabled rather than hidden at the
                      ends so the row's geometry does not shift while moving. */}
                  <button
                    type="button"
                    aria-label={t("editor.sidebar.moveUp")}
                    disabled={layout.order[0] === id}
                    onClick={() => moveRibbonItem(id, -1)}
                    style={{ width: 40, height: 40, border: "none", background: "transparent", color: "var(--fg-2)", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
                  >
                    <Icon name="chevron-up" size={18} color="var(--fg-2)" strokeWidth={2} />
                  </button>
                  <button
                    type="button"
                    aria-label={t("editor.sidebar.moveDown")}
                    disabled={layout.order[layout.order.length - 1] === id}
                    onClick={() => moveRibbonItem(id, 1)}
                    style={{ width: 40, height: 40, border: "none", background: "transparent", color: "var(--fg-2)", cursor: "pointer", padding: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
                  >
                    <Icon name="chevron-down" size={18} color="var(--fg-2)" strokeWidth={2} />
                  </button>
                  {/* Show/hide as a real switch, so the state is announced. */}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={shown}
                    aria-label={t(item.labelKey)}
                    disabled={!supported}
                    onClick={() => setRibbonItemHidden(id, shown)}
                    style={{
                      width: 46,
                      height: 28,
                      flex: "none",
                      borderRadius: 999,
                      border: "none",
                      background: shown ? "var(--accent)" : "var(--line-2)",
                      cursor: supported ? "pointer" : "default",
                      position: "relative",
                      padding: 0,
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        position: "absolute",
                        top: 3,
                        insetInlineStart: shown ? 21 : 3,
                        width: 22,
                        height: 22,
                        borderRadius: 999,
                        background: "#fff",
                        transition: "inset-inline-start var(--duration-base) var(--ease-standard)",
                      }}
                    />
                  </button>
                </div>
              );
            })}
          </div>
        </Sheet>
      )}
    </>
  );
}

/** Canonical order, exported for tests that assert the rail cannot lose a
 *  destination the vocabulary defines. */
export const RIBBON_ITEM_IDS = RIBBON_ORDER;
