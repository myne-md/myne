// The home surface (myne-md/myne#1074).
//
// Three states, which are the three the plan verifies the surface against: the
// arrangement a vault that has never been arranged gets, one a person arranged
// (with a wide card), and one carrying a card kind this build cannot draw — the
// case the codec keeps on purpose, so the surface has to show it rather than drop
// it.
//
// Every story installs a `prefs_read` handler rather than relying on the fake
// host's default: `usePrefs` falls back to `DEFAULT_PREFS` on a failed read, and a
// story that renders the default while claiming to show an arrangement is the
// vacuous-fixture trap the repo's testing notes describe.

import { WorkspaceProvider } from "@app/notes/workspaceContext";
import { SidebarStateProvider } from "@app/notes/sidebarState";
import { DEFAULT_PREFS } from "@app/hooks/usePrefs";
import { HomeSurface } from "@app/notes/home/HomeSurface";
import type { StoryDescriptor } from "../types";
/** The catalogue's plain centred frame, local because it is four lines and the
 *  two copies in `notes.tsx` and `settings.tsx` are already local for the same
 *  reason: a shared frame would be a third file to keep in step with a wrapper. */
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        padding: "var(--space-4)",
        background: "var(--bg-1)",
      }}
    >
      {children}
    </div>
  );
}

const EMPTY_PREFS = {
  ...DEFAULT_PREFS,
  favorites: [],
  saved_views: [],
};

function prefsFixture(homeCards: unknown, openOnStart = false) {
  return {
    // Two spaces on purpose: a four-space `description:` reads to
    // `check-story-catalogue` as a story annotation with no `state:` to own it.
  description: "An empty vault whose home surface carries this arrangement.",
    handlers: {
      "plugin:prefs|prefs_read": () => ({
        ...EMPTY_PREFS,
        home_cards: homeCards,
        home_open_on_start: openOnStart,
      }),
    },
  };
}

/** The surface, in the providers it needs. */
function Home({ openOnStart = false }: { openOnStart?: boolean }) {
  return (
    <SidebarStateProvider>
      <WorkspaceProvider>
        <Frame>
          <div style={{ width: "100%", display: "flex", flexDirection: "column" }}>
            {/* `usePrefs` reads the story host's fixture, so the switch value the
                card shows comes from the same place the arrangement does. */}
            <HomeSurface key={openOnStart ? "on" : "off"} />
          </div>
        </Frame>
      </WorkspaceProvider>
    </SidebarStateProvider>
  );
}

export const HOME_STORIES: StoryDescriptor[] = [
  {
    id: "home/default",
    group: "screens",
    surface: "HomeSurface",
    state: "default",
    fixture: prefsFixture(null),
    description:
      "The home surface on a vault that has never been arranged: the default eleven cards, each with a real empty state.",
    tags: ["home", "surface", "cards", "empty"],
    render: () => <Home />,
  },
  {
    id: "home/arranged",
    group: "screens",
    surface: "HomeSurface",
    state: "arranged",
    fixture: prefsFixture([
      { id: "recent-notes", kind: "recent-notes", span: 2 },
      { id: "todays-tasks", kind: "todays-tasks", span: 1 },
      { id: "calendar-agenda", kind: "calendar-agenda", span: 1 },
      { id: "recent-files", kind: "recent-files", span: 1 },
    ]),
    description:
      "An arrangement a person made: four cards, one of them spanning both columns, in their own order.",
    tags: ["home", "surface", "cards", "arranged", "span"],
    render: () => <Home />,
  },
  {
    id: "home/unknown-card",
    group: "screens",
    surface: "HomeSurface",
    state: "unknown-card",
    fixture: prefsFixture([
      { id: "recent-notes", kind: "recent-notes", span: 1 },
      { id: "future", kind: "future-kind", span: 1 },
    ]),
    description:
      "A card written by a newer build. It is kept in place and drawn as inert, because the codec preserves an unknown id rather than dropping it.",
    tags: ["home", "surface", "cards", "forward-compatibility"],
    render: () => <Home />,
  },
  {
    id: "home/open-on-start",
    group: "screens",
    surface: "HomeSurface",
    state: "open-on-start",
    fixture: prefsFixture(null, true),
    description:
      "The same surface with the device-local open-on-start switch on, as the settings row renders it.",
    tags: ["home", "surface", "preference", "start"],
    render: () => <Home openOnStart />,
  },
];
