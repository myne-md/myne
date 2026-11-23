// The home cards, one story per card (myne-md/myne#1074, task 16).
//
// **A story per card, not per surface.** The plan asks for one, and the reason is
// the empty state: a card's whole design is what it says when it has nothing, and
// that is exactly what a screenshot of the full surface cannot isolate.
//
// Every story installs a `prefs_read` handler rather than trusting the fake host's
// default, because `usePrefs` falls back to its defaults on a failed read and a
// card that renders "empty" for the wrong reason is a vacuous fixture.

import { WorkspaceProvider } from "@app/notes/workspaceContext";
import { SidebarStateProvider } from "@app/notes/sidebarState";
import { DEFAULT_PREFS } from "@app/hooks/usePrefs";
import {
  AgentPromptCard,
  CalendarAgendaCard,
  FavoritesCard,
  GraphCard,
  QuickCaptureCard,
  RecentFilesCard,
  RecentNotesCard,
  ReferenceSetsCard,
  SavedViewsCard,
  TodaysTasksCard,
  WritingStatsCard,
} from "@app/notes/home/cardBodies";
import type { StoryDescriptor } from "../types";

/** The providers a card body needs, and nothing else. */
function Card({ children }: { children: React.ReactNode }) {
  return (
    <SidebarStateProvider>
      <WorkspaceProvider>
        <div
          style={{
            width: 360,
            padding: "var(--space-3)",
            border: "1px solid var(--line-1)",
            borderRadius: "var(--radius-2)",
            background: "var(--bg-1)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2)",
            fontSize: "var(--text-sm)",
            color: "var(--fg-1)",
          }}
        >
          {children}
        </div>
      </WorkspaceProvider>
    </SidebarStateProvider>
  );
}

const EMPTY = {
  description: "An empty vault, so every card shows its real empty state.",
  handlers: {
    "plugin:prefs|prefs_read": () => ({
      ...DEFAULT_PREFS,
      favorites: [],
      saved_views: [],
      home_cards: null,
    }),
  },
};

/** One entry per card, in the registry's order. */
const CARDS: readonly { id: string; name: string; body: () => React.ReactElement }[] = [
  { id: "recent-notes", name: "RecentNotes", body: RecentNotesCard },
  { id: "favorites", name: "Favorites", body: FavoritesCard },
  { id: "todays-tasks", name: "TodaysTasks", body: TodaysTasksCard },
  { id: "calendar-agenda", name: "CalendarAgenda", body: CalendarAgendaCard },
  { id: "recent-files", name: "RecentFiles", body: RecentFilesCard },
  { id: "reference-sets", name: "ReferenceSets", body: ReferenceSetsCard },
  { id: "saved-views", name: "SavedViews", body: SavedViewsCard },
  { id: "writing-stats", name: "WritingStats", body: WritingStatsCard },
  { id: "quick-capture", name: "QuickCapture", body: QuickCaptureCard },
  { id: "agent-prompt", name: "AgentPrompt", body: AgentPromptCard },
  { id: "graph", name: "Graph", body: GraphCard },
];

export const HOME_CARD_STORIES: StoryDescriptor[] = CARDS.map((card) => ({
  id: `home/cards/${card.id}`,
  group: "components",
  surface: "cardBodies",
  state: card.id,
  fixture: EMPTY,
  description: `The ${card.name} card on an empty vault, which is the state its design is really about.`,
  tags: ["home", "card", card.id, "empty"],
  render: () => (
    <Card>
      <card.body />
    </Card>
  ),
}));
