// The catalogue shell: a grouped, searchable list of every registered story on
// the left, the selected story rendered on the right (myne-md/myne#832 task 2).
//
// Its own chrome obeys the design system it displays: tokens for every value
// and the shared primitives for controls. A catalogue that broke the rules it
// exists to show would be the one place the rules stop applying.

import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { Input } from "@app/components/primitives/Input";
import { Button } from "@app/components/primitives/Button";
import { storiesByGroup, storyById, STORIES } from "./registry";
import { resolveFixture } from "../fixtures";
import { setStoryFixture } from "./host/internals";
import type { StoryDescriptor } from "./types";

/** One value for the rail width, so it is named once rather than twice. */
const RAIL_WIDTH_PX = 320;

const RAIL_STYLE: CSSProperties = {
  width: RAIL_WIDTH_PX,
  flex: `0 0 ${RAIL_WIDTH_PX}px`,
  borderInlineEnd: "1px solid var(--line-2)",
  overflowY: "auto",
  padding: "var(--space-3)",
  background: "var(--bg-2)",
};

const GROUP_TITLE_STYLE: CSSProperties = {
  margin: "var(--space-4) 0 var(--space-1)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "var(--tracking-caps)",
  textTransform: "uppercase",
  color: "var(--fg-3)",
};

const STAGE_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "auto",
  background: "var(--bg-1)",
};

/**
 * Installs a story's fixture before its render.
 *
 * Called from the two places that can change the selection (a click, a hash
 * change) and once before the first render, NOT from `StoryStage`'s render body.
 * React runs child effects before parent effects, so a parent `useEffect` would
 * install the fixture too late; the event handlers are early enough and do not
 * mutate a module global during a render React might discard.
 */
function activate(story: StoryDescriptor | undefined): void {
  if (story) setStoryFixture(resolveFixture(story.fixture));
}

function readHashId(): string | undefined {
  return window.location.hash.replace(/^#/, "") || undefined;
}

/** Renders one story. Its fixture is installed before this runs (see `activate`). */
function StoryStage({ story }: { story: StoryDescriptor }) {
  return (
    <div style={STAGE_STYLE} data-testid="stories.stage" data-story-id={story.id}>
      <div
        style={{
          padding: "var(--space-3) var(--space-4)",
          borderBlockEnd: "1px solid var(--line-2)",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: "var(--fg-3)",
        }}
        data-testid="stories.story-id"
      >
        {story.id}
      </div>
      <div style={{ width: story.viewport ?? "100%" }} data-testid="stories.story">
        {story.render()}
      </div>
    </div>
  );
}

export function App() {
  const [selectedId, setSelectedId] = useState<string | undefined>(() => {
    // Before the first render: pick the story the URL names (or the first one)
    // and install its fixture, so the first mount already sees the right data.
    const story = storyById(readHashId());
    activate(story);
    return story?.id;
  });
  const [query, setQuery] = useState("");

  // Hash is the URL contract: a story link is copy-pasteable and restores on
  // reload.
  useEffect(() => {
    const onHash = () => {
      const story = storyById(readHashId());
      activate(story);
      setSelectedId(story?.id);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return storiesByGroup();
    return [
      { group: "matches", stories: STORIES.filter((s) => s.id.toLowerCase().includes(q)) },
    ];
  }, [query]);

  const selected = storyById(selectedId);

  const select = (id: string) => {
    activate(storyById(id));
    window.location.hash = id;
    setSelectedId(id);
  };

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "var(--font-sans)" }}>
      <nav style={RAIL_STYLE} aria-label="Stories" data-testid="stories.rail">
        <Input
          type="search"
          placeholder="Search stories"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search stories"
          data-testid="stories.search"
        />
        {groups.map(({ group, stories }) => (
          <div key={group}>
            <div style={GROUP_TITLE_STYLE}>{group}</div>
            {stories.map((story) => (
              <Button
                key={story.id}
                type="button"
                variant={story.id === selected?.id ? "primary" : "ghost"}
                style={{ width: "100%", justifyContent: "flex-start" }}
                onClick={() => select(story.id)}
                data-testid={`stories.item.${story.id}`}
              >
                {story.surface} · {story.state}
              </Button>
            ))}
          </div>
        ))}
      </nav>
      {selected ? <StoryStage key={selected.id} story={selected} /> : null}
    </div>
  );
}
