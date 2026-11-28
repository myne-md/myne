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
import { HOME_CARD_DEFS } from "@app/notes/home/cardBodies";
import { HOME_CARD_SPECS } from "@app/notes/home/homeCards";
import type { HomeCard } from "@app/lib/prefs";
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

/**
 * One story per widget, derived from the registry rather than listed again.
 *
 * A hand-kept list here is a second catalogue: it went stale the moment the
 * registry grew, and a widget with no story is a widget whose empty state nobody
 * ever looked at.
 */
export const HOME_CARD_STORIES: StoryDescriptor[] = HOME_CARD_SPECS.flatMap((spec) => {
  const def = HOME_CARD_DEFS[spec.kind];
  if (def === undefined) return [];
  const card: HomeCard = { id: spec.kind, kind: spec.kind, span: spec.defaultSpan, options: {} };
  return [
    {
      id: `home/cards/${spec.kind}`,
      group: "components",
      surface: "cardBodies",
      state: spec.kind,
      fixture: EMPTY,
      // The registry holds keys, not copy: the story catalogue has no i18n runtime,
      // so the kind is the honest name it can print.
      description: `${spec.kind} on an empty vault, which is the state its design is really about.`,
      tags: ["home", "widget", spec.kind, "empty"],
      render: () => (
        <Card>
          <def.Body card={card} />
        </Card>
      ),
    } satisfies StoryDescriptor,
  ];
});
