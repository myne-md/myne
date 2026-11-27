import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../../components";
import { HOME_CARD_ORDER, homeLayout, type HomeCardId } from "../../../lib/home-layout";
import { LayoutCustomizeSheet, type CustomizeRow } from "./chrome/LayoutCustomizeSheet";
import type { VaultTask } from "../../../lib/tasks";
import { taskDescription } from "@myne/dialect/taskFieldWriter";
import type { SavedView } from "../../../lib/prefs";
import type { NoteEntry } from "./types";

/** The phone/tablet home surface (owner, 2026-11-27 round 2).
 *
 *  The desktop's Home is a grid of cards you arrange in a separate editing mode.
 *  On one column that editing mode is a second screen for something you do twice
 *  a year, so the phone's version is the SAME idea in the shape a hand can hold:
 *  a vertical stack of cards, each one a door, and one "Customize" sheet that
 *  reorders and hides them in place (`lib/home-layout.ts`, device-local).
 *
 *  **Why every card carries real data.** The owner's reading of the desktop
 *  surface was "customize edilemez, çok restricted" — a screen of empty
 *  placeholders teaches nothing. Each card here is fed by data this client
 *  already has: the note list, the vault task index, starred notes, saved views.
 *  A card with nothing to say says so in one line and offers the action that
 *  fixes it, rather than pretending the feature is missing. */

export interface HomeSurfaceProps {
  notes: readonly NoteEntry[];
  tasks: readonly VaultTask[];
  favouriteNotes: readonly NoteEntry[];
  views: readonly SavedView[];
  folderCount: number;
  onOpenNote: (id: string) => void;
  onNewNote: () => void;
  onNewDrawing: () => void;
  onOpenToday: () => void;
  onOpenTasks: () => void;
  onOpenViews: () => void;
  onOpenView: (view: SavedView) => void;
  onOpenAllNotes: () => void;
}

function HomeCardShell({ title, icon, children, action }: { title: string; icon: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section
      style={{
        border: "1px solid var(--line-1)",
        borderRadius: 16,
        background: "var(--bg-2)",
        padding: "14px 16px 16px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ display: "flex", color: "var(--fg-3)", flex: "none" }}>{icon}</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, letterSpacing: "0.02em", color: "var(--fg-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}
        </span>
        {action}
      </div>
      {children}
    </section>
  );
}

const rowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  width: "100%",
  border: "none",
  background: "transparent",
  color: "var(--fg-1)",
  fontFamily: "var(--font-sans)",
  fontSize: 15,
  textAlign: "start" as const,
  padding: "7px 0",
  cursor: "pointer",
  minWidth: 0,
};

const emptyLine = { fontSize: 14, color: "var(--fg-3)", lineHeight: 1.5, margin: 0 };

const gi = { fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export function HomeSurfaceMobile({
  notes,
  tasks,
  favouriteNotes,
  views,
  folderCount,
  onOpenNote,
  onNewNote,
  onNewDrawing,
  onOpenToday,
  onOpenTasks,
  onOpenViews,
  onOpenView,
  onOpenAllNotes,
}: HomeSurfaceProps) {
  const { t } = useTranslation();
  const layout = homeLayout.useLayout();
  const [customize, setCustomize] = useState(false);

  const recent = notes.slice(0, 4);
  const openTasks = tasks.filter((task) => !task.completed);
  const dueSoon = openTasks.filter((task) => task.due != null).slice(0, 4);

  const cards: Record<HomeCardId, { title: string; icon: ReactNode; body: ReactNode }> = {
    "quick-capture": {
      title: t("notes.home.cards.quickCapture"),
      icon: (
        <svg width="17" height="17" viewBox="0 0 24 24"><path d="M12 20h9" {...gi} /><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" {...gi} /></svg>
      ),
      body: (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={onNewNote}
            style={{ display: "flex", alignItems: "center", gap: 6, height: 40, border: "none", borderRadius: 10, background: "var(--accent)", color: "var(--accent-on)", padding: "0 14px", fontSize: 15, fontWeight: 600, cursor: "pointer" }}
          >
            <Icon name="plus" size={16} color="var(--accent-on)" strokeWidth={2.2} />
            {t("common.newnote")}
          </button>
          <button
            type="button"
            onClick={onNewDrawing}
            style={{ display: "flex", alignItems: "center", gap: 6, height: 40, border: "1px solid var(--line-2)", borderRadius: 10, background: "transparent", color: "var(--fg-2)", padding: "0 12px", fontSize: 15, fontWeight: 600, cursor: "pointer" }}
          >
            {t("notes.newTab.createDrawing")}
          </button>
          <button
            type="button"
            onClick={onOpenToday}
            style={{ display: "flex", alignItems: "center", gap: 6, height: 40, border: "1px solid var(--line-2)", borderRadius: 10, background: "transparent", color: "var(--fg-2)", padding: "0 12px", fontSize: 15, fontWeight: 600, cursor: "pointer" }}
          >
            {t("editor.nav.openToday")}
          </button>
        </div>
      ),
    },
    recent: {
      title: t("notes.home.cards.recentNotes"),
      icon: <Icon name="file-text" size={17} color="var(--fg-3)" strokeWidth={1.7} />,
      body:
        recent.length === 0 ? (
          <p style={emptyLine}>{t("notes.home.cards.recentEmpty")}</p>
        ) : (
          <div>
            {recent.map((note) => (
              <button key={note.id} type="button" onClick={() => onOpenNote(note.id)} style={rowStyle}>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {note.title || t("common.untitled")}
                </span>
                <Icon name="chevron-right" size={15} color="var(--line-3)" strokeWidth={2} flip />
              </button>
            ))}
          </div>
        ),
    },
    tasks: {
      title: t("notes.home.cards.todaysTasks"),
      icon: <Icon name="check" size={17} color="var(--fg-3)" strokeWidth={2} />,
      body: openTasks.length === 0 ? (
        <p style={emptyLine}>{t("notes.home.cards.tasksEmpty")}</p>
      ) : (
        <div>
          {openTasks.slice(0, 4).map((task) => (
            <button key={`${task.noteId}-${task.lineIndex}`} type="button" onClick={onOpenTasks} style={rowStyle}>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {task.lineIndex === null ? (task.noteTitle ?? "") : taskDescription(task.rawLine)}
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={onOpenTasks}
            style={{ ...rowStyle, color: "var(--accent)", fontSize: 14, fontWeight: 600, paddingTop: 4 }}
          >
            {t("notes.home.cards.openTaskList")}
          </button>
        </div>
      ),
    },
    "coming-up": {
      title: t("notes.home.cards.comingUp"),
      icon: <Icon name="clock" size={17} color="var(--fg-3)" strokeWidth={1.7} />,
      body:
        dueSoon.length === 0 ? (
          <p style={emptyLine}>{t("notes.home.cards.comingUpEmpty")}</p>
        ) : (
          <div>
            {dueSoon.map((task) => (
              <button key={`${task.noteId}-${task.lineIndex}`} type="button" onClick={onOpenTasks} style={rowStyle}>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.lineIndex === null ? (task.noteTitle ?? "") : taskDescription(task.rawLine)}</span>
                <span style={{ flex: "none", fontSize: 12, color: "var(--fg-3)" }}>{task.due}</span>
              </button>
            ))}
          </div>
        ),
    },
    favourites: {
      title: t("notes.home.cards.favourites"),
      icon: <Icon name="star" size={17} color="var(--fg-3)" strokeWidth={1.7} />,
      body:
        favouriteNotes.length === 0 ? (
          <p style={emptyLine}>{t("notes.home.cards.favouritesEmpty")}</p>
        ) : (
          <div>
            {favouriteNotes.slice(0, 4).map((note) => (
              <button key={note.id} type="button" onClick={() => onOpenNote(note.id)} style={rowStyle}>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {note.title || t("common.untitled")}
                </span>
              </button>
            ))}
          </div>
        ),
    },
    views: {
      title: t("notes.home.cards.savedViews"),
      icon: <Icon name="columns-2" size={17} color="var(--fg-3)" strokeWidth={1.7} />,
      body:
        views.length === 0 ? (
          <p style={emptyLine}>{t("notes.home.cards.viewsEmpty")}</p>
        ) : (
          <div>
            {views.slice(0, 4).map((view) => (
              <button key={view.name} type="button" onClick={() => onOpenView(view)} style={rowStyle}>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{view.name}</span>
              </button>
            ))}
            <button type="button" onClick={onOpenViews} style={{ ...rowStyle, color: "var(--accent)", fontSize: 14, fontWeight: 600, paddingTop: 4 }}>
              {t("notes.home.cards.manageViews")}
            </button>
          </div>
        ),
    },
    writing: {
      title: t("notes.home.cards.writing"),
      icon: <Icon name="edit" size={17} color="var(--fg-3)" strokeWidth={1.7} />,
      body: (
        <div style={{ display: "flex", gap: 18 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, color: "var(--fg-1)" }}>{notes.length}</div>
            <div style={{ fontSize: 12, color: "var(--fg-3)" }}>{t("notes.home.cards.noteCount")}</div>
          </div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, color: "var(--fg-1)" }}>{folderCount}</div>
            <div style={{ fontSize: 12, color: "var(--fg-3)" }}>{t("notes.home.cards.folderCount")}</div>
          </div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, color: "var(--fg-1)" }}>{openTasks.length}</div>
            <div style={{ fontSize: 12, color: "var(--fg-3)" }}>{t("notes.home.cards.openTaskCount")}</div>
          </div>
        </div>
      ),
    },
  };

  const visibleCards = layout.order.filter((id) => !layout.hidden.includes(id));

  return (
    // The column caps its width on a tablet: a card 900pt wide with one sentence
    // in it reads as a layout that lost its content, and the desktop's own home
    // has the same measure discipline.
    <div data-testid="home.surface-mobile" style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", width: "100%", maxWidth: 720, margin: "0 auto" }}>
      <div style={{ flex: "none", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "0 20px 10px" }}>
        <h1 style={{ margin: 0, fontSize: 32, fontWeight: 700, letterSpacing: "-0.025em", color: "var(--fg-display)" }}>
          {t("notes.home.title")}
        </h1>
        <button
          type="button"
          onClick={() => setCustomize(true)}
          data-testid="home.customize"
          style={{ border: "none", background: "transparent", color: "var(--accent)", fontSize: 15, fontWeight: 600, cursor: "pointer", padding: 0, flex: "none" }}
        >
          {t("notes.home.arrange")}
        </button>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          // The last card must clear the docked tab bar, which sits OVER this
          // scroll area (`z-index: --z-dropdown + 1`): without the bottom inset
          // the final card scrolled under it and could not be reached.
          padding: "0 20px calc(24px + env(safe-area-inset-bottom, 0px))",
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        {visibleCards.map((id) => (
          <HomeCardShell key={id} title={cards[id].title} icon={cards[id].icon}>
            {cards[id].body}
          </HomeCardShell>
        ))}
        {notes.length === 0 && (
          <button type="button" onClick={onOpenAllNotes} style={{ ...rowStyle, color: "var(--accent)", justifyContent: "center", minHeight: 44 }}>
            {t("common.allnotes")}
          </button>
        )}
      </div>

      {customize && (
        <LayoutCustomizeSheet
          title={t("notes.home.arrange")}
          rows={HOME_CARD_ORDER.map(
            (id): CustomizeRow => ({
              id,
              label: cards[id].title,
              icon: cards[id].icon,
              supported: true,
              shown: !layout.hidden.includes(id),
            }),
          )}
          onToggle={(id, shown) => homeLayout.setHidden(id as HomeCardId, shown)}
          onMove={(id, delta) => homeLayout.move(id as HomeCardId, delta)}
          onReset={() => homeLayout.reset()}
          onClose={() => setCustomize(false)}
        />
      )}
    </div>
  );
}
