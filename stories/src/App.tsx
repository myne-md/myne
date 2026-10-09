// The workbench shell: navbar, rail, stage, inspector (myne-md/myne#832 task 2,
// myne-md/myne#845).
//
// Four regions. The navbar carries the mark, the wordmark and the version, with
// search in its centre. The rail lists one row per surface with its states
// grouped beneath, reachable with the arrow keys. The stage frames the story.
// The inspector docks at the bottom with Controls, Actions, Accessibility and
// Interactions.
//
// Its own chrome obeys the design system it displays: tokens for every value and
// the shared primitives for controls. A catalogue that broke the rules it exists
// to show would be the one place the rules stop applying.

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Input } from "@app/components/primitives/Input";
import { Button } from "@app/components/primitives/Button";
import { MyneMark } from "@app/components/primitives/MyneMark";
import { Select } from "@app/components/primitives/Select";
import { Icon } from "@app/components/primitives/Icon";
import { IconButton } from "@app/components/primitives/IconButton";
import type { IconName } from "@app/lib/icons";
import { flattenTree, storyById, storyTree, STORIES, GROUP_ORDER } from "./registry";
import type { TreeNode } from "./registry";
import { resolveFixture } from "../fixtures";
import { setStoryFixture } from "./host/internals";
import { StoryErrorBoundary } from "./ErrorBoundary";
import { searchStories } from "./search";
import { entryName } from "./naming";
import { clearActions, useActionLog } from "./actions";
import { failingContrast, focusOrder, roleNames, targetSizeFindings } from "./a11y";
import { a11yLevelOf } from "./a11y-level";
import { axeAvailable, runAxe, type AxeReport } from "./axe";
import type { A11yLevel } from "./types";
import { forceState, clearForcedState } from "./interactions";
import { SOURCE_MAP } from "./source-map";
import type { StoryDescriptor } from "./types";
import type { StoryGroup } from "./types";

const RAIL_WIDTH_PX = 300;
const INSPECTOR_HEIGHT_PX = 260;

/** The four inspector tabs. */
type Tab = "controls" | "actions" | "accessibility" | "interactions";

/** A glyph per group, so the rail reads as sections rather than a flat list. */
const GROUP_ICON: Record<string, IconName> = {
  documentation: "book-open",
  foundations: "palette",
  primitives: "layout-grid",
  components: "layout-grid",
  screens: "columns-2",
  settings: "settings",
};

/** A glyph per surface family, so an entry is recognisable at a glance. */
function entryIcon(group: string): IconName {  return GROUP_ICON[group] ?? "file-text";
}

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "controls", label: "Controls" },
  { id: "actions", label: "Actions" },
  { id: "accessibility", label: "Accessibility" },
  { id: "interactions", label: "Interactions" },
];

/** The built-in palettes the switcher offers (myne-md/myne#845). */
const THEMES = ["light", "dark", "amoled"] as const;

type Theme = (typeof THEMES)[number];

/** The pseudo-states the Interactions tab can force. */
const FORCED_STATES = ["hover", "focus-visible", "active"] as const;
type ForcedState = (typeof FORCED_STATES)[number];

const NAV_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-4)",
  padding: "0 var(--space-4)",
  height: "56px",
  flex: "0 0 auto",
  borderBlockEnd: "1px solid var(--line-2)",
  background: "var(--bg-2)",
};

const VERSION_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
};

const SEARCH_WRAP_STYLE: CSSProperties = {
  flex: "1 1 auto",
  maxWidth: "520px",
  margin: "0 auto",
  // The suggestion panel is anchored to this box, so it sits directly under the
  // input rather than floating somewhere in the viewport.
  position: "relative",
};

/** The suggestion panel: a listbox under the search input. */
const SEARCH_RESULTS_STYLE: CSSProperties = {
  position: "absolute",
  insetInline: 0,
  insetBlockStart: "calc(100% + var(--space-1))",
  zIndex: "var(--z-dropdown)",
  maxHeight: "60vh",
  overflowY: "auto",
  padding: "var(--space-1)",
  background: "var(--bg-1)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  boxShadow: "var(--shadow-2)",
};

const SEARCH_RESULT_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: "var(--space-2)",
  padding: "var(--space-2) var(--space-3)",
  borderRadius: "var(--radius-1)",
  cursor: "pointer",
  fontSize: "var(--text-sm)",
};

const SEARCH_RESULT_GROUP_STYLE: CSSProperties = {
  marginInlineStart: "auto",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  textTransform: "uppercase",
  letterSpacing: "var(--tracking-caps)",
};

const SEARCH_EMPTY_STYLE: CSSProperties = {
  padding: "var(--space-3)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
};

const RAIL_STYLE: CSSProperties = {
  width: RAIL_WIDTH_PX,
  flex: `0 0 ${RAIL_WIDTH_PX}px`,
  borderInlineEnd: "1px solid var(--line-2)",
  overflowY: "auto",
  padding: "var(--space-3)",
  background: "var(--bg-2)",
};

const GROUP_TITLE_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  margin: "var(--space-4) 0 var(--space-1)",
  paddingInlineStart: "var(--space-2)",
  fontSize: "var(--text-xs)",
  fontWeight: "var(--weight-semibold)",
  letterSpacing: "var(--tracking-caps)",
  textTransform: "uppercase",
  color: "var(--fg-3)",
};

const SURFACE_TITLE_STYLE: CSSProperties = {
  padding: "var(--space-2) var(--space-3) 0",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
};

const STAGE_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "auto",
  background: "var(--bg-1)",
  // Make the stage the containing block for `position: fixed` descendants, so a
  // modal story's backdrop is confined to the stage box.
  transform: "translateZ(0)",
};

const STORY_ID_STYLE: CSSProperties = {
  padding: "var(--space-3) var(--space-4)",
  borderBlockEnd: "1px solid var(--line-2)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
};

const INSPECTOR_STYLE: CSSProperties = {
  height: INSPECTOR_HEIGHT_PX,
  flex: `0 0 ${INSPECTOR_HEIGHT_PX}px`,
  borderBlockStart: "1px solid var(--line-2)",
  background: "var(--bg-2)",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};

/** Collapsed: the tab row stays (so you can still switch), the body goes. */
const INSPECTOR_COLLAPSED_STYLE: CSSProperties = {
  flex: "0 0 auto",
  borderBlockStart: "1px solid var(--line-2)",
  background: "var(--bg-2)",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};

const TAB_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-1)",
  padding: "var(--space-2) var(--space-3)",
  borderBlockEnd: "1px solid var(--line-1)",
};

const TAB_BODY_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minHeight: 0,
  overflow: "auto",
  padding: "var(--space-3)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-2)",
};

const REF_STYLE: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  padding: "var(--space-2) var(--space-3) 0",
};

/**
 * Where the surface is declared, as a button that opens the source
 * (myne-md/myne#845).
 *
 * An inline text link under a header reads as metadata; this is an action, and
 * it looks like one. The path moved to the tooltip, and the URL is pinned to the
 * branch the catalogue was built from so it resolves to the tree the reader is
 * looking at.
 */
function SourceReference({ story }: { story: StoryDescriptor }) {
  const ref = SOURCE_MAP[story.surface];
  if (ref === undefined) return null;
  const url = `https://github.com/myne-md/myne/blob/${__STORIES_BRANCH__}/${ref.file}#L${ref.line}`;
  return (
    <span style={{ marginInlineStart: "var(--space-3)" }} title={`${ref.file}:${ref.line}`}>
      <Button
        variant="secondary"
        icon="code"
        onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
        data-testid="stories.source"
      >
        Show on GitHub
      </Button>
    </span>
  );
}

/**
 * The GitHub issue URL for the story on screen, pre-filled through the issue
 * form's own field ids.
 *
 * The form is `.github/ISSUE_TEMPLATE/design-system.yml`, and GitHub prefills a
 * form field when a query parameter matches the field's `id`. That is why
 * `catalogue-context` is spelled identically here and in the template: the two
 * are one contract, and a rename on either side silently drops the context.
 *
 * The context block is the point. A report that arrives naming the story, the
 * theme and the URL is reproducible; one that says "the padding is wrong
 * somewhere" is a conversation (myne-md/myne#845).
 */
function issueUrl(story: StoryDescriptor | undefined, theme: Theme): string {
  const where =
    story === undefined
      ? "the catalogue"
      : `${entryName(story.surface, story.title)} (${story.state})`;
  const context = [
    story === undefined ? "No story was open." : `Story: ${story.id}`,
    story === undefined ? "" : `Surface: ${story.surface}`,
    story === undefined ? "" : `State: ${story.state}`,
    story === undefined ? "" : `Group: ${story.group}`,
    `Theme: ${theme}`,
    `Catalogue: ${__APP_VERSION__} (${__STORIES_BRANCH__})`,
    `URL: ${window.location.href}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");

  const params = new URLSearchParams({
    template: "design-system.yml",
    title: `[Design system] ${where}`,
    "catalogue-context": context,
  });
  return `https://github.com/myne-md/myne/issues/new?${params.toString()}`;
}

/**
 * One rail row, and its subtree (myne-md/myne#847).
 *
 * A surface with exactly one story and no subcomponents renders as a SINGLE
 * row, the surface's own. That is Storybook's hoisting, and it is here for a
 * measured reason rather than a taste one: 195 surfaces against 224 stories
 * means a pure "parent node plus leaves" tree is 419 rows where the rail has
 * 195 today, so a state leaf has to replace its parent's row rather than sit
 * under it. A surface with several states keeps a non-clickable parent row and
 * one leaf per state, which is what makes the states findable by browsing.
 */
function TreeRow({
  node,
  depth,
  selectedId,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}): ReactNode {
  const indent = `calc(var(--space-3) * ${depth})`;
  const sole = node.stories.length === 1 && node.children.length === 0;

  if (sole) {
    const story = node.stories[0];
    return (
      <Button
        type="button"
        variant={story.id === selectedId ? "primary" : "ghost"}
        style={{
          width: "100%",
          justifyContent: "flex-start",
          gap: "var(--space-2)",
          paddingInlineStart: `calc(var(--space-2) + ${indent})`,
        }}
        onClick={() => onSelect(story.id)}
        data-testid={`stories.item.${node.surface}`}
      >
        <Icon name={entryIcon(node.group)} size={14} />
        {node.name}
      </Button>
    );
  }

  return (
    <div>
      <div
        style={{ ...GROUP_TITLE_STYLE, paddingInlineStart: `calc(var(--space-2) + ${indent})` }}
        data-testid={`stories.surface.${node.surface}`}
      >
        <Icon name={entryIcon(node.group)} size={12} />
        {node.name}
      </div>
      {node.stories.map((story) => (
        <Button
          key={story.id}
          type="button"
          variant={story.id === selectedId ? "primary" : "ghost"}
          style={{
            width: "100%",
            justifyContent: "flex-start",
            gap: "var(--space-2)",
            paddingInlineStart: `calc(var(--space-5) + ${indent})`,
          }}
          onClick={() => onSelect(story.id)}
          data-testid={`stories.item.${node.surface}.${story.state}`}
        >
          {story.state}
        </Button>
      ))}
      {node.children.map((child) => (
        <TreeRow
          key={child.surface}
          node={child}
          depth={depth + 1}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

/**
 * Installs a story's fixture before its render.
 *
 * Called from the two places that can change the selection (a click, a hash
 * change) and once before the first render, NOT from a render body: React runs
 * child effects before parent effects, so a parent `useEffect` would install the
 * fixture too late.
 */
function activate(story: StoryDescriptor | undefined): void {
  if (story) setStoryFixture(resolveFixture(story.fixture));
  clearActions();
}

function readHashId(): string | undefined {
  return window.location.hash.replace(/^#/, "") || undefined;
}

/** Renders one story, framed and isolated. */
function StoryStage({
  story,
  theme,
}: {
  story: StoryDescriptor;
  theme: Theme;
}) {
  const fullBleed = story.fullBleed === true;
  return (
    <div style={STAGE_STYLE} data-testid="stories.stage" data-story-id={story.id}>
      <div style={STORY_ID_STYLE} data-testid="stories.story-id">
        {story.id}
        <SourceReference story={story} />
      </div>
      <div
        style={{
          width: story.viewport ?? "100%",
          padding: fullBleed ? undefined : "var(--space-6)",
        }}
        data-testid="stories.story"
        data-fullbleed={fullBleed ? "true" : undefined}
      >
        <StoryErrorBoundary id={story.id}>
          {story.unreachable ? (
            <div data-testid="stories.unreachable" style={{ maxWidth: "var(--content-max-w)" }}>
              <p style={{ color: "var(--fg-1)", marginBlockEnd: "var(--space-2)" }}>
                This state is not reachable from the catalogue.
              </p>
              <p style={{ color: "var(--fg-2)" }}>{story.unreachable.what}</p>
              <p style={{ color: "var(--fg-3)" }}>{story.unreachable.why}</p>
            </div>
          ) : (
            story.render()
          )}
        </StoryErrorBoundary>
      </div>
      {/* The active theme is named on the stage so a screenshot is unambiguous
          and so the Accessibility tab's contrast verdict has a subject. */}
      <div style={{ ...REF_STYLE, paddingBottom: "var(--space-3)" }} data-testid="stories.theme">
        theme: {theme}
      </div>
    </div>
  );
}

/** The Controls tab: switch between the current surface's states in place. */
function ControlsTab({ story, onSelect }: { story: StoryDescriptor; onSelect: (id: string) => void }) {
  const siblings = STORIES.filter((candidate) => candidate.surface === story.surface);
  if (siblings.length <= 1) {
    return <div>This surface has a single state ({story.state}).</div>;
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
      {siblings.map((sibling) => (
        <Button
          key={sibling.id}
          variant={sibling.id === story.id ? "primary" : "secondary"}
          onClick={() => onSelect(sibling.id)}
          data-testid={`stories.control.${sibling.state}`}
        >
          {sibling.state}
        </Button>
      ))}
    </div>
  );
}

/** The Actions tab: what fired when the story was interacted with. */
function ActionsTab() {
  const events = useActionLog();
  if (events.length === 0) {
    return <div>Nothing has fired yet. Interact with the story above.</div>;
  }
  return (
    <ol style={{ margin: 0, paddingInlineStart: "var(--space-4)" }}>
      {events.map((event) => (
        <li key={event.id}>
          {event.name}
          {event.args.length > 0 ? `(${event.args.map(describeArg).join(", ")})` : "()"}
        </li>
      ))}
    </ol>
  );
}

function describeArg(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return "[object]";
    }
  }
  return String(value);
}

/** The facts the Accessibility tab shows for one story in one theme. */
interface A11yFacts {
  roles: ReturnType<typeof roleNames>;
  order: string[];
  targets: string[];
  contrast: string[];
}

/** Which axe bucket the panel is showing. */
type AxeBucket = "violations" | "passes" | "incomplete";

/**
 * The Accessibility tab: axe-core's three buckets, plus per-story facts.
 *
 * The shape follows the research (myne-md/myne#845): axe's own
 * Violations / Passes / Incomplete split, because axe finds only about 57% of
 * WCAG issues and `incomplete` is it saying a human must look. A panel showing
 * only failures overstates its own coverage.
 *
 * Measured AFTER the commit and keyed on the STORY as well as the theme. Two bugs
 * lived in the first version: it measured during render (reading the story being
 * replaced) and its memo depended on `theme` alone (so selecting a different
 * component kept the previous component's facts).
 */
function AccessibilityTab({
  storyId,
  theme,
  level,
  reason,
}: {
  storyId: string;
  theme: Theme;
  level: A11yLevel;
  reason?: string;
}) {
  const [facts, setFacts] = useState<A11yFacts | null>(null);
  const [report, setReport] = useState<AxeReport | null>(null);
  const [bucket, setBucket] = useState<AxeBucket>("violations");

  useEffect(() => {
    const root = document.querySelector('[data-testid="stories.story"]');
    if (!root) {
      setFacts(null);
      setReport(null);
      return;
    }
    setFacts({
      roles: roleNames(root),
      order: focusOrder(root),
      targets: targetSizeFindings(root),
      contrast: failingContrast(root),
    });

    // axe is async and touches the whole subtree, so it is guarded against a
    // story switch landing mid-run: a late report is dropped rather than shown
    // against the wrong component.
    let cancelled = false;
    void runAxe(root)
      .then((next) => {
        if (!cancelled) setReport(next);
      })
      .catch((error: unknown) => {
        // Visible rather than silent: a rejected axe run used to leave the panel
        // stuck on "running axe" with no error anywhere (myne-md/myne#845).
        console.error("[stories] axe failed", error);
        if (!cancelled) setReport(null);
      });
    return () => {
      cancelled = true;
    };
  }, [storyId, theme]);

  if (!facts) return <div>No story is mounted.</div>;

  const shown = report === null ? [] : report[bucket];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-4)" }} role="tablist">
        {(["violations", "passes", "incomplete"] as const).map((candidate) => {
          const count = report === null ? null : report[candidate].length;
          const active = candidate === bucket;
          return (
            <Button
              key={candidate}
              variant="ghost"
              role="tab"
              aria-selected={active}
              onClick={() => setBucket(candidate)}
              style={{
                borderBlockEnd: active ? "2px solid var(--accent)" : "2px solid transparent",
                borderRadius: 0,
                color: active ? "var(--fg-1)" : "var(--fg-3)",
              }}
              data-testid={`stories.axe.${candidate}`}
            >
              {candidate} {count === null ? "" : count}
            </Button>
          );
        })}
        <div style={{ ...REF_STYLE, marginInlineStart: "auto" }}>
          {report === null ? (axeAvailable ? "running axe" : "axe-core did not load") : `axe-core ${report.version}`}, against the {theme} theme
        </div>
      </div>

      {/* The DECLARED level, so the tab shows whether this story is a gate or a
          note. The gate itself is `tests/stories/a11yLevels.test.tsx`; without
          this line the vocabulary the feature introduces would be visible only
          in a test file (myne-md/myne#845). */}
      <div style={REF_STYLE}>
        Declared level: <strong>{level}</strong>
        {level === "off"
          ? ` (${reason ?? "NO REASON RECORDED, which the gate rejects"})`
          : level === "todo"
            ? ", recorded debt, does not fail the build"
            : ", axe must find nothing and a violation fails the build"}
      </div>
      {level === "off" && (
        <div style={REF_STYLE}>
          axe is not run for this story, so the buckets below are empty by
          declaration rather than by measurement.
        </div>
      )}

      {report === null ? (
        <div>Running axe-core on this story.</div>
      ) : shown.length === 0 ? (
        <div>Nothing in this bucket.</div>
      ) : (
        <ul style={{ margin: 0, paddingInlineStart: "var(--space-4)" }}>
          {shown.slice(0, 12).map((rule) => (
            <li key={rule.id}>
              <span style={{ color: "var(--fg-1)" }}>{rule.id}</span>
              {rule.impact === null ? "" : ` [${rule.impact}]`}. {rule.help}
              {rule.nodes > 1 ? ` (${rule.nodes} elements)` : ""}
            </li>
          ))}
        </ul>
      )}

      <div>
        {report === null ? "" : `axe did not apply ${report.inapplicable} rule(s) here.`}
      </div>

      <section>
        <div style={SURFACE_TITLE_STYLE}>Roles and names</div>
        {facts.roles.length === 0 ? (
          <div>No element with an explicit role.</div>
        ) : (
          <ul style={{ margin: 0, paddingInlineStart: "var(--space-4)" }}>
            {facts.roles.map((entry, index) => (
              <li key={index}>
                {entry.role}: {entry.name || "(no accessible name)"}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <div style={SURFACE_TITLE_STYLE}>Keyboard order</div>
        <div>{facts.order.length} focusable element(s)</div>
      </section>
      <section>
        <div style={SURFACE_TITLE_STYLE}>Target sizes</div>
        {facts.targets.length === 0 ? (
          <div>Every pointer target meets the floor.</div>
        ) : (
          <ul style={{ margin: 0, paddingInlineStart: "var(--space-4)" }}>
            {facts.targets.slice(0, 8).map((entry, index) => (
              <li key={index}>{entry}</li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <div style={SURFACE_TITLE_STYLE}>Contrast</div>
        {facts.contrast.length === 0 ? (
          <div>No text below the WCAG AA threshold in this theme.</div>
        ) : (
          <ul style={{ margin: 0, paddingInlineStart: "var(--space-4)" }}>
            {facts.contrast.slice(0, 8).map((entry, index) => (
              <li key={index}>{entry}</li>
            ))}
          </ul>
        )}
      </section>
      <div style={SURFACE_TITLE_STYLE}>
        The a11y suites (tests/a11y, the axe lane) remain the gate; this is a view.
      </div>
    </div>
  );
}

/** The Interactions tab: force a pseudo-state on the rendered story. */
function InteractionsTab({
  forced,
  onChange,
}: {
  forced: ForcedState | null;
  onChange: (next: ForcedState | null) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <div>
        A static mount cannot reach a pseudo-class. Forcing one mirrors the matching
        rules onto everything that would match, so the states are visible.
      </div>
      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        {FORCED_STATES.map((state) => (
          <Button
            key={state}
            variant={forced === state ? "primary" : "secondary"}
            onClick={() => onChange(forced === state ? null : state)}
            data-testid={`stories.force.${state}`}
          >
            {state}
          </Button>
        ))}
      </div>
      {forced !== null && (
        <div data-testid="stories.forcing">
          Forcing :{forced}. This is not the real state; it is the style it would take.
        </div>
      )}
    </div>
  );
}

export function App() {
  const [selectedId, setSelectedId] = useState<string | undefined>(() => {
    const story = storyById(readHashId());
    activate(story);
    return story?.id;
  });
  const [query, setQuery] = useState("");
  // The suggestion panel under the search input. Search no longer filters the
  // rail (it answered a different question than "where am I in the tree"): it
  // proposes, and picking a proposal navigates (myne-md/myne#845).
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchIndex, setSearchIndex] = useState(0);
  // The rail's own narrowing control, which is what search used to do.
  const [groupFilter, setGroupFilter] = useState<StoryGroup | "all">("all");
  const [tab, setTab] = useState<Tab>("controls");
  const [theme, setTheme] = useState<Theme>("light");
  const [forced, setForced] = useState<ForcedState | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);

  // Hash is the URL contract: a story link is copy-pasteable and restores on
  // reload.
  useEffect(() => {
    const onHash = () => {
      const story = storyById(readHashId());
      activate(story);
      setSelectedId(story?.id);
      setForced(null);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Theme is applied to the document element, the same mechanism the clients use.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Forcing a state mirrors the matching rules; clearing removes them.
  useEffect(() => {
    if (forced === null) clearForcedState();
    else forceState(forced);
    return () => clearForcedState();
  }, [forced, selectedId]);

  // A modal story's focus trap inerts everything outside the modal, including
  // this rail. The rail is catalogue chrome, not app content, so it opts out and
  // keeps opting out: the trap re-applies `inert` on every modal re-render.
  const railRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const restore = () => {
      if (rail.hasAttribute("inert")) rail.removeAttribute("inert");
      if (rail.getAttribute("aria-hidden") === "true") rail.removeAttribute("aria-hidden");
    };
    restore();
    const observer = new MutationObserver(restore);
    observer.observe(rail, { attributes: true, attributeFilter: ["inert", "aria-hidden"] });
    return () => observer.disconnect();
  }, []);

  const selected = storyById(selectedId);

  const select = (id: string) => {
    activate(storyById(id));
    window.location.hash = id;
    setSelectedId(id);
    setForced(null);
  };

  // The rail: a TREE, narrowed by the filter and never by the search. Search
  // proposes destinations; the filter changes what the tree shows. Conflating
  // the two is why a query used to replace the whole rail with a flat list and
  // lose the reader's place in the hierarchy (myne-md/myne#847).
  const tree = useMemo(() => {
    const full = storyTree();
    if (groupFilter === "all") return full;
    return { ...full, groups: full.groups.filter((entry) => entry.group === groupFilter) };
  }, [groupFilter]);

  // Ranked proposals for the search panel. Capped, because a panel that scrolls
  // past a dozen entries is a worse answer than the rail itself.
  const results = useMemo(() => searchStories(STORIES, query).slice(0, 12), [query]);
  const searching = query.trim().length > 0;

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchIndex(0);
  };

  /** Pick a proposal: navigate, clear the query, close the panel. */
  const acceptResult = (id: string) => {
    select(id);
    setQuery("");
    closeSearch();
  };

  const onSearchKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      closeSearch();
      return;
    }
    if (results.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      // The arrow keys belong to the panel while it is open, not to the rail:
      // otherwise typing and arrowing fight over the same key.
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setSearchIndex((index) => (index + step + results.length) % results.length);
      setSearchOpen(true);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const hit = results[searchIndex] ?? results[0];
      if (hit !== undefined) acceptResult(hit.id);
    }
  };

  // Every story is a row now, so the arrow keys walk stories rather than
  // surfaces. The order comes from the tree builder, so the keyboard and the eye
  // cannot disagree about what "next" means.
  const railIds = useMemo(() => flattenTree(tree), [tree]);

  // Arrow keys move through the rail (the user asked for keyboard navigation).
  const onRailKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (selected === undefined) return;
    const index = railIds.indexOf(selected.id);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === "ArrowDown" ? index + 1 : index - 1;
    const clamped = Math.max(0, Math.min(railIds.length - 1, next));
    select(railIds[clamped]);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", fontFamily: "var(--font-sans)" }}>
      <header style={NAV_STYLE} data-testid="stories.navbar">
        <Button
          variant="ghost"
          onClick={() => select("documentation/welcome/introduction")}
          title="Go to the Welcome page"
          data-testid="stories.wordmark"
          style={{ justifyContent: "flex-start" }}
        >
          <MyneMark size={20} />
          Myne
          <span style={VERSION_STYLE} data-testid="stories.version">
            {__APP_VERSION__}
          </span>
        </Button>
        <div style={SEARCH_WRAP_STYLE}>
          <Input
            type="search"
            placeholder="Search stories by name, state or intent"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSearchIndex(0);
              setSearchOpen(e.target.value.trim().length > 0);
            }}
            onFocus={() => setSearchOpen(searching)}
            onKeyDown={onSearchKeyDown}
            // A combobox, because the panel below IS the listbox for this field.
            // `aria-activedescendant` names the highlighted row rather than
            // moving focus into the panel, so the caret stays in the input while
            // the arrow keys walk the proposals.
            role="combobox"
            aria-expanded={searchOpen && results.length > 0}
            aria-controls="stories-search-results"
            aria-autocomplete="list"
            aria-activedescendant={
              searchOpen && results[searchIndex] !== undefined
                ? `stories-search-result-${results[searchIndex].id}`
                : undefined
            }
            aria-label="Search stories"
            data-testid="stories.search"
          />
          {searchOpen && searching && (
            <div
              id="stories-search-results"
              role="listbox"
              aria-label="Search results"
              style={SEARCH_RESULTS_STYLE}
              data-testid="stories.search-results"
            >
              {results.length === 0 ? (
                <div style={SEARCH_EMPTY_STYLE}>Nothing matches that.</div>
              ) : (
                results.map((hit, index) => (
                  <div
                    key={hit.id}
                    id={`stories-search-result-${hit.id}`}
                    role="option"
                    aria-selected={index === searchIndex}
                    onMouseEnter={() => setSearchIndex(index)}
                    // `onMouseDown`, not `onClick`: the input's blur would close
                    // the panel before a click could land on it.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      acceptResult(hit.id);
                    }}
                    style={{
                      ...SEARCH_RESULT_STYLE,
                      background: index === searchIndex ? "var(--accent-soft)" : "transparent",
                    }}
                    data-testid={`stories.search-result.${hit.id}`}
                  >
                    <span style={{ color: "var(--fg-1)" }}>
                      {entryName(hit.surface, hit.title)}
                    </span>
                    <span style={{ color: "var(--fg-3)" }}>{hit.state}</span>
                    <span style={{ ...SEARCH_RESULT_GROUP_STYLE }}>{hit.group}</span>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        <div
          style={{ display: "flex", alignItems: "center" }}
          data-testid="stories.filter"
        >
          <Select
            value={groupFilter}
            onChange={(next) => setGroupFilter(next)}
            aria-label="Filter the rail by group"
            icon="layout-grid"
            options={[
              { value: "all", label: "All groups" },
              ...GROUP_ORDER.map((group) => ({
                value: group,
                label: group[0].toUpperCase() + group.slice(1),
              })),
            ]}
          />
        </div>
        <div
          style={{ display: "flex", alignItems: "center" }}
          data-testid="stories.theme-switcher"
        >
          <Select
            value={theme}
            onChange={(next) => setTheme(next)}
            aria-label="Theme"
            icon="sun"
            options={THEMES.map((candidate) => ({
              value: candidate,
              label: candidate[0].toUpperCase() + candidate.slice(1),
            }))}
          />
        </div>

        {/* Report what you are looking at. The URL carries the story, the theme
            and the page URL into the repo's issue form, so a finding arrives
            reproducible rather than as a description of a memory. */}
        <Button
          variant="secondary"
          icon="message-square"
          title="File an issue about this story"
          onClick={() => window.open(issueUrl(selected, theme), "_blank", "noopener,noreferrer")}
          data-testid="stories.file-issue"
        >
          File issue
        </Button>
      </header>

      <div style={{ display: "flex", flex: "1 1 auto", minHeight: 0 }}>
        <nav
          ref={railRef}
          style={RAIL_STYLE}
          aria-label="Stories"
          data-testid="stories.rail"
          onKeyDown={onRailKeyDown}
        >
          {tree.groups.map((entry) => (
            <div key={entry.group}>
              <div style={GROUP_TITLE_STYLE}>
                <Icon name={entryIcon(entry.group)} size={12} />
                {entry.group}
              </div>
              {entry.nodes.map((node) => (
                <TreeRow
                  key={node.surface}
                  node={node}
                  depth={0}
                  selectedId={selected?.id}
                  onSelect={select}
                />
              ))}
            </div>
          ))}
        </nav>

        {/* The stage and the inspector share one column, so the inspector sits
            under the content rather than running beneath the rail. */}
        <div
          style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minWidth: 0 }}
        >
          {selected ? <StoryStage key={selected.id} story={selected} theme={theme} /> : null}

          <section
            style={panelOpen ? INSPECTOR_STYLE : INSPECTOR_COLLAPSED_STYLE}
            aria-label="Inspector"
            data-testid="stories.inspector"
          >
        <div style={TAB_ROW_STYLE} role="tablist">
          {TABS.map((entry) => {
            const active = entry.id === tab;
            return (
              <Button
                key={entry.id}
                variant="ghost"
                onClick={() => setTab(entry.id)}
                role="tab"
                aria-selected={active}
                style={{
                  borderBlockEnd: active ? "2px solid var(--accent)" : "2px solid transparent",
                  borderRadius: 0,
                  color: active ? "var(--fg-1)" : "var(--fg-3)",
                  fontWeight: active ? "var(--weight-semibold)" : "var(--weight-medium)",
                }}
                data-testid={`stories.tab.${entry.id}`}
              >
                {entry.label}
              </Button>
            );
          })}
          <div style={{ ...REF_STYLE, marginInlineStart: "auto" }}>
            {selected?.description}
          </div>
          <IconButton
            icon={panelOpen ? "chevron-down" : "chevron-up"}
            label={panelOpen ? "Hide panel" : "Show panel"}
            onClick={() => setPanelOpen(!panelOpen)}
            testId="stories.panel-toggle"
          />
        </div>
        {panelOpen && (
          <div style={TAB_BODY_STYLE} role="tabpanel" data-testid="stories.tabpanel">
            {tab === "controls" && selected && (
              <ControlsTab story={selected} onSelect={select} />
            )}
            {tab === "actions" && <ActionsTab />}
            {tab === "accessibility" && (
              <AccessibilityTab
                storyId={selected?.id ?? ""}
                theme={theme}
                level={a11yLevelOf(selected ?? {})}
                reason={selected?.a11yReason}
              />
            )}
            {tab === "interactions" && (
              <InteractionsTab forced={forced} onChange={setForced} />
            )}
          </div>
        )}
          </section>
        </div>
      </div>
    </div>
  );
}
