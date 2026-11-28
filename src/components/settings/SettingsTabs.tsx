// The in-panel topic tab strip (myne-md/myne#885, requirement 6).
//
// The Settings modal was already tabbed once: the left rail is a `role="tablist"`
// of panels. What was missing is the second level, so a panel that is five
// concerns deep (the AI panel is 1795 lines and four group headings) still
// presented as one long scroll. This is that second level.
//
// GEOMETRY, which is the requester's own constraint turned into code. The strip
// is the content column's first row, above the scrolling pane rather than inside
// it, so it stays put while the panel scrolls and reads as chrome. Its height is
// pinned to `--space-7`, the SAME token `SettingsSearch`'s row pins, so the two
// rows are one line and their bottom hairlines are one continuous rule rather
// than two edges that happen to be near each other. That is measured rather than
// assumed: the first version derived the strip's height from its own padding and
// the search row derived its own from its content, which came out five pixels
// apart in the real WebView (`e2e/settings-tabs.e2e.ts` reads both rects, and
// that run is why both rows now name the same token). The strip's own
// bottom hairline is therefore the same line the search row already draws, and
// the strip introduces no second band and no second rule.
//
// KEYBOARD. `role="tablist"` with roving `tabindex` (one Tab stop for the whole
// strip, not one per topic), Left/Right moving within it, Home/End to the ends,
// and each tab wired to its own `role="tabpanel"` through `aria-controls` /
// `aria-labelledby`. **It deliberately does not touch Up/Down**: `SettingsModal`
// cycles the rail with those on `window`, and a strip that consumed them would
// silently break the navigation that already works (the PRD's story 29). The
// handler returns without calling `preventDefault` for any other key, so those
// events reach the shell unchanged.
//
// PERSISTENCE. Which topic a user was reading is a SURFACE fact, not a vault fact,
// so it is remembered for the session in a module-scope map rather than written to
// `vault.prefs` - a pref is a synced blob, and syncing "which sub-tab I had open"
// onto the phone is not a feature. The store is module scope for a second reason:
// the modal unmounts on close (`if (!open) return null`), so component state could
// not survive the close the E2E scenario asserts.
//
// A panel with fewer than two topics renders NO strip. That is the mechanism that
// keeps every short panel a single screen without a second, hand-maintained list
// of which panels are short; `settingsTopics.ts` carries the roster.

import {
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import { Button } from "../primitives/Button";
import { SettingsSectionCounter } from "./SettingsSection";
import { panelLabelKey } from "./search/searchSettings";
import type { PanelId } from "../SettingsModal";
import {
  livePanelTopics,
  type SettingsTopicId,
  type SettingsTopicMeta,
} from "./settingsTopics";

/** The active topic per panel, for the session. See the header. */
const activeTopicByPanel = new Map<string, string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify(): void {
  // Copied: a listener that unsubscribes while being notified (an unmounting
  // strip) would otherwise mutate the set mid-iteration.
  for (const listener of [...listeners]) listener();
}

/**
 * Select `topicId` in `panelId`, for every mounted strip.
 *
 * The settings search calls this BEFORE arming its scroll (task 5), which is the
 * whole reason the store is module scope rather than component state: the shell
 * has to reach a control inside a panel it does not render the inside of.
 */
export function setActiveSettingsTopic(panelId: string, topicId: string): void {
  if (activeTopicByPanel.get(panelId) === topicId) return;
  activeTopicByPanel.set(panelId, topicId);
  notify();
}

/** Forget every remembered topic. Test-only: the session memory is the feature. */
export function resetSettingsTopics(): void {
  activeTopicByPanel.clear();
  notify();
}

function activeTopicOf(
  panelId: string,
  topics: readonly SettingsTopicMeta[],
): string {
  // `?? first`: an unremembered panel starts on its first topic, and a remembered
  // id that the roster no longer carries falls back the same way rather than
  // rendering no body at all.
  const remembered = activeTopicByPanel.get(panelId);
  const first = topics[0]?.id ?? "";
  if (remembered === undefined) return first;
  return topics.some((topic) => topic.id === remembered) ? remembered : first;
}

/** The active topic id for `panelId`. Re-renders the caller when it changes. */
export function useActiveSettingsTopic(
  panelId: string,
  topics: readonly SettingsTopicMeta[],
): string {
  return useSyncExternalStore(subscribe, () => activeTopicOf(panelId, topics));
}

/** The tab button's id, and the tabpanel's `aria-labelledby` target. */
export function topicTabId(panelId: string, topicId: string): string {
  return `settings-${panelId}-topic-tab-${topicId}`;
}

/** The tabpanel's id, and its tab's `aria-controls` target. */
export function topicPanelId(panelId: string, topicId: string): string {
  return `settings-${panelId}-topic-panel-${topicId}`;
}

const BAND_STYLE: CSSProperties = {
  // The positioning context for the sliding underline.
  position: "relative",
  flex: "0 0 auto",
  display: "flex",
  // `stretch`, so every tab is the band's full height and its underline sits ON
  // the band's bottom hairline rather than floating above it (the right panel's
  // tab strip in `Editor.tsx` is built the same way).
  alignItems: "stretch",
  gap: "var(--space-4)",
  // The SAME height as `SettingsSearch`'s row, from the same token, so the
  // strip's bottom hairline and the search row's land on one line (see that
  // file's `ROW_STYLE` and the header above). The inline padding is the content
  // column's own, so the first tab lines up with the panel content below it.
  height: "var(--space-7)",
  padding: "0 var(--space-6)",
  borderBottom: "1px solid var(--line-1)",
  background: "var(--bg-2)",
  overflowX: "auto",
  // An unpaired `overflow-x` computes `overflow-y` to `auto`, which put a
  // scrollbar over the tabs (2026-11-27); `TabStrip` pairs them for this reason.
  overflowY: "hidden",
};

// Inline tabs, not boxed ones (myne-md/myne#885): a label and an underline, the
// idiom the editor's right-panel strip already uses, so the app has one answer
// to "which tab is this". The underline is the accent, and it is ONE element
// that slides (see `INDICATOR_STYLE`) rather than a border per tab, so a topic
// change moves the mark instead of blinking it off one tab and on another.
// `borderRadius: 0` because a rounded corner under an underline is a box again,
// and the inline `background` overrides the ghost variant's hover fill on
// purpose: hover answers with ink (below). Idle tabs are `--fg-3`, a step dimmer
// than the active `--fg-1` with `--fg-2` between them, so the three states are
// three distinct inks.
const TAB_BASE_STYLE: CSSProperties = {
  whiteSpace: "nowrap",
  background: "transparent",
  borderRadius: 0,
  border: "none",
  paddingInline: 0,
  transition: "color var(--duration-fast) var(--ease-standard)",
};

const TAB_ACTIVE_STYLE: CSSProperties = {
  ...TAB_BASE_STYLE,
  color: "var(--fg-1)",
};

const TAB_IDLE_STYLE: CSSProperties = {
  ...TAB_BASE_STYLE,
  color: "var(--fg-3)",
};

// The sliding underline. A fixed 100px bar positioned with `transform` alone
// (translate to the tab's left edge, scale to its width), because the motion
// canon animates transform rather than `left`/`width`, which lay out and paint
// every frame (`scripts/check-motion-canon.mjs`). It sits on the band's bottom
// hairline (`bottom: -1px` lays it over the 1px border). The global
// reduced-motion rule zeroes the transition, so the bar then jumps, which is the
// behaviour that rule asks for.
const INDICATOR_BASE_WIDTH = 100;
const INDICATOR_STYLE: CSSProperties = {
  position: "absolute",
  left: 0,
  bottom: -1,
  width: INDICATOR_BASE_WIDTH,
  height: 2,
  background: "var(--accent)",
  transformOrigin: "left",
  pointerEvents: "none",
};

/**
 * The topic strip for one panel.
 *
 * `topics` is DATA rather than children, so the roster can also be read by the
 * settings search (`settingsTopics.ts` is where both readers get it). Renders
 * nothing for a panel with fewer than two topics - a strip over a single topic is
 * a control that cannot change anything.
 */
export function SettingsTabs({
  panelId,
  topics,
}: {
  panelId: PanelId;
  topics: readonly SettingsTopicMeta[];
}) {
  const { t } = useTranslation();
  const active = useActiveSettingsTopic(panelId, topics);
  // One ref per tab, so the arrow keys can move FOCUS with the selection (roving
  // tabindex: a tab that is selected but not focused leaves the strip's single Tab
  // stop behind the user).
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Where the underline sits, measured off the active tab. `animate` stays false
  // for the first placement, so opening a panel puts the bar under its tab
  // instead of sliding it in from the strip's left edge.
  const [indicator, setIndicator] = useState<{ x: number; w: number; animate: boolean } | null>(
    null,
  );
  const activeIdx = topics.findIndex((topic) => topic.id === active);
  useLayoutEffect(() => {
    const place = () => {
      const el = tabRefs.current[activeIdx < 0 ? 0 : activeIdx];
      if (el == null) return;
      const next = { x: el.offsetLeft, w: el.offsetWidth };
      setIndicator((prev) =>
        prev !== null && prev.x === next.x && prev.w === next.w
          ? prev
          : { ...next, animate: prev !== null },
      );
    };
    place();
    // A label that changes width (a locale switch, a font load) or a resized
    // dialog moves the tab without changing the selection.
    const strip = tabRefs.current[0]?.parentElement;
    if (strip == null || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(place);
    ro.observe(strip);
    for (const el of tabRefs.current) if (el != null) ro.observe(el);
    return () => ro.disconnect();
  }, [activeIdx, panelId, topics.map((topic) => topic.id).join("|")]);

  if (topics.length < 2) return null;

  const activeIndex = Math.max(
    0,
    topics.findIndex((topic) => topic.id === active),
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // The step is relative to the tab that was PRESSED, falling back to the
    // active one when the key arrives on the strip itself. The two are the same
    // tab in every real interaction (arrowing selects and focuses, and clicking
    // focuses), and taking the pressed tab is the standard behaviour rather than
    // an assumption that focus and selection never drift.
    const pressed = tabRefs.current.findIndex((el) => el !== null && el === e.target);
    const from = pressed === -1 ? activeIndex : pressed;
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    let nextIndex = -1;
    if (step !== 0) {
      nextIndex = (from + step + topics.length) % topics.length;
    } else if (e.key === "Home") {
      nextIndex = 0;
    } else if (e.key === "End") {
      nextIndex = topics.length - 1;
    } else {
      // Up/Down (and everything else) belong to the shell: `SettingsModal` cycles
      // the rail with them on `window`, and `preventDefault` here would break it.
      return;
    }
    const next = topics[nextIndex];
    if (next === undefined) return;
    e.preventDefault();
    setActiveSettingsTopic(panelId, next.id);
    tabRefs.current[nextIndex]?.focus();
  };

  return (
    <div
      role="tablist"
      // The strip is named by the panel it splits, which is the one string that
      // already exists for this meaning (`settings.shell.panels.*`).
      aria-label={t(panelLabelKey(panelId))}
      data-testid={`settings.${panelId}-tabs`}
      onKeyDown={onKeyDown}
      style={BAND_STYLE}
    >
      {topics.map((topic, index) => {
        const isActive = topic.id === active;
        return (
          <Button
            key={topic.id}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            variant="ghost"
            role="tab"
            id={topicTabId(panelId, topic.id)}
            aria-selected={isActive}
            aria-controls={topicPanelId(panelId, topic.id)}
            tabIndex={isActive ? 0 : -1}
            data-testid={`settings.${panelId}-tab-${topic.id}`}
            onClick={() => setActiveSettingsTopic(panelId, topic.id)}
            onMouseEnter={(e) => {
              if (!isActive) e.currentTarget.style.color = "var(--fg-2)";
            }}
            onMouseLeave={(e) => {
              if (!isActive) e.currentTarget.style.color = "var(--fg-3)";
            }}
            style={isActive ? TAB_ACTIVE_STYLE : TAB_IDLE_STYLE}
          >
            {t(topic.labelKey)}
          </Button>
        );
      })}
      <span
        aria-hidden="true"
        data-testid={`settings.${panelId}-tab-indicator`}
        style={{
          ...INDICATOR_STYLE,
          opacity: indicator === null ? 0 : 1,
          transform:
            indicator === null
              ? undefined
              : `translateX(${indicator.x}px) scaleX(${indicator.w / INDICATOR_BASE_WIDTH})`,
          transition:
            indicator?.animate === true
              ? "transform var(--duration-base) var(--ease-standard)"
              : undefined,
        }}
      />
    </div>
  );
}

/**
 * One topic's body, and its `role="tabpanel"`.
 *
 * **Renders nothing while its topic is not active**, and that is deliberate rather
 * than an optimisation: a hidden-but-mounted body would put every control of every
 * topic in the document at once, which is the second way for a settings search hit
 * to land somewhere the user cannot see (the first is the scroll target being
 * absent, which task 5's topic selection fixes). The AI panel also runs IPC on
 * mount, so mounting five topics to show one is real work for no screen.
 *
 * The roster comes from `settingsTopics.ts` rather than from a prop, so the panel
 * writes one line per topic instead of restating the roster at every call site.
 */
export function SettingsTopicPanel({
  panelId,
  topicId,
  children,
}: {
  panelId: PanelId;
  topicId: SettingsTopicId;
  children: ReactNode;
}) {
  const topics = livePanelTopics(panelId);
  const active = useActiveSettingsTopic(panelId, topics);
  if (active !== topicId) return null;
  return (
    <div
      role="tabpanel"
      id={topicPanelId(panelId, topicId)}
      aria-labelledby={topicTabId(panelId, topicId)}
      data-testid={`settings.${panelId}-topic-${topicId}`}
      // The panel root spaces its children with `PANEL_ROOT_STYLE`'s gap; this
      // wrapper is transparent to layout for the same reason, minus the
      // `alignSelf` that positions the root inside the modal's column.
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-5)",
        // The topic body settles in rather than cutting (myne-md/myne#885 visual
        // pass). Only the active body is mounted, so a topic change remounts it
        // and the entrance replays; the keyframes live beside the modal's own in
        // `src/styles/tokens.css`, under the same reduced-motion rule.
        animation: "settings-topic-in var(--duration-base) var(--ease-out)",
      }}
    >
      <SettingsSectionCounter>{children}</SettingsSectionCounter>
    </div>
  );
}
