// The home surface's widget registry (myne-md/myne#1074).
//
// ── One registry, and it is the only place a widget is declared ─────────────
// The catalogue is the list below; the renderers live in `cardBodies`. A kind
// that is not here cannot be in an arrangement, and a kind that IS in an
// arrangement but not here renders as an inert row rather than disappearing (the
// codec keeps an unknown id on purpose — see `protocol::home_layout`).
//
// ── A widget never owns its data ────────────────────────────────────────────
// Every renderer calls the module that already answers its question
// (`recentNoteIds`, the task index, the calendar range, the attachment catalog,
// the chats roster). A widget with its own query is a second answer to a question
// the app already answers, and the two drift the first time only one is touched.
//
// ── A widget is not a plugin ────────────────────────────────────────────────
// The set is CLOSED. `PRODUCT.md` keeps any plugin API out of the product, so
// this catalogue is the vocabulary: adding a widget is a code change with a
// renderer, not a manifest a third party ships. The `options` member makes a
// widget configurable; it does not make it authorable.
//
// ── Width is a quarter of the surface ──────────────────────────────────────
// The desktop grid is 12 columns and a stored `span` of 1..=4 means a quarter,
// half, three quarters or the full width. That keeps the wire format unchanged
// (`MAX_HOME_CARD_SPAN = 4`), which matters: a wider span would be a row an older
// client silently DROPS, and a card that vanishes on an older build is worse than
// a coarse width step.

import type { IconName } from "../../lib/icons";
import type { HomeCard } from "../../lib/prefs";

/** The groups the add-widget picker sorts by. */
export type HomeCardGroup = "capture" | "navigate" | "time" | "state" | "files" | "ai";

/** What a widget is, as far as the surface is concerned. */
export interface HomeCardSpec {
  /** The wire token an arrangement stores. Stable forever. */
  kind: string;
  /** The widget's title, in the app's voice. */
  labelKey: string;
  /** One line for the picker: what this shows, not what it is called. */
  descriptionKey: string;
  /** The glyph in the header, the picker row and the empty tile. */
  icon: IconName;
  /** Which group of the picker it belongs to. */
  group: HomeCardGroup;
  /** The width it takes when added, in quarter steps (1..=4). */
  defaultSpan: number;
  /** The narrowest it may be resized to. Defaults to 1. */
  minSpan?: number;
  /**
   * Hidden (and strippable) when the AI opt-in is off. A widget that needs a
   * provider must not be offered to a vault that has none: the AI gate is a
   * consent gate, not a preference.
   */
  requiresAi?: boolean;
  /** The options a freshly added card carries. */
  defaultOptions?: Readonly<Record<string, string>>;
}

/** The groups, in the order the picker lists them. */
export const HOME_CARD_GROUPS: readonly HomeCardGroup[] = [
  "capture",
  "navigate",
  "time",
  "files",
  "state",
  "ai",
];

export const HOME_GROUP_LABEL_KEY: Readonly<Record<HomeCardGroup, string>> = {
  capture: "notes.home.groups.capture",
  navigate: "notes.home.groups.navigate",
  time: "notes.home.groups.time",
  state: "notes.home.groups.state",
  files: "notes.home.groups.files",
  ai: "notes.home.groups.ai",
};

/**
 * Every widget kind this build can draw.
 *
 * Ordered by group, then by how often a person reaches for it, and the order here
 * is the order the picker offers: what you write, where you go, what is due, what
 * is on disk, what the vault knows about itself, and the one surface that needs
 * consent.
 */
export const HOME_CARD_SPECS: readonly HomeCardSpec[] = [
  // ── Capture: the top of the surface, and the reason it exists ────────────
  {
    kind: "start-chat",
    labelKey: "notes.home.cards.startChat",
    descriptionKey: "notes.home.cards.startChatHint",
    icon: "message-square",
    group: "capture",
    defaultSpan: 4,
    minSpan: 2,
  },
  {
    kind: "quick-capture",
    labelKey: "notes.home.cards.quickCapture",
    descriptionKey: "notes.home.cards.quickCaptureHint",
    icon: "pencil",
    group: "capture",
    // Two quarters: a field and its button in one quarter is a field with no room
    // to show what you typed.
    defaultSpan: 2,
  },
  {
    kind: "markdown",
    labelKey: "notes.home.cards.markdown",
    descriptionKey: "notes.home.cards.markdownHint",
    icon: "quote",
    group: "capture",
    defaultSpan: 2,
  },
  {
    kind: "templates",
    labelKey: "notes.home.cards.templates",
    descriptionKey: "notes.home.cards.templatesHint",
    icon: "copy",
    group: "capture",
    defaultSpan: 1,
  },

  // ── Navigate: what you were doing, and what you keep reaching for ────────
  {
    kind: "recent-notes",
    labelKey: "notes.home.cards.recentNotes",
    descriptionKey: "notes.home.cards.recentNotesHint",
    icon: "file-text",
    group: "navigate",
    defaultSpan: 2,
  },
  {
    kind: "favorites",
    labelKey: "notes.home.cards.favorites",
    descriptionKey: "notes.home.cards.favoritesHint",
    icon: "hash",
    group: "navigate",
    defaultSpan: 1,
  },
  {
    kind: "saved-views",
    labelKey: "notes.home.cards.savedViews",
    descriptionKey: "notes.home.cards.savedViewsHint",
    icon: "layout-grid",
    group: "navigate",
    defaultSpan: 1,
  },
  {
    kind: "folders",
    labelKey: "notes.home.cards.referenceSets",
    descriptionKey: "notes.home.cards.referenceSetsHint",
    icon: "folder",
    group: "navigate",
    defaultSpan: 1,
  },
  {
    kind: "graph",
    labelKey: "notes.home.cards.graph",
    descriptionKey: "notes.home.cards.graphHint",
    icon: "share-2",
    group: "navigate",
    defaultSpan: 2,
    minSpan: 2,
  },

  // ── Time: what is due ────────────────────────────────────────────────────
  {
    kind: "todays-tasks",
    labelKey: "notes.home.cards.todaysTasks",
    descriptionKey: "notes.home.cards.todaysTasksHint",
    icon: "list-todo",
    group: "time",
    defaultSpan: 2,
  },
  {
    kind: "calendar-agenda",
    labelKey: "notes.home.cards.calendarAgenda",
    descriptionKey: "notes.home.cards.calendarAgendaHint",
    icon: "calendar",
    group: "time",
    defaultSpan: 2,
  },

  // ── Files: previews, not filenames ───────────────────────────────────────
  {
    kind: "files-preview",
    labelKey: "notes.home.cards.recentFiles",
    descriptionKey: "notes.home.cards.recentFilesHint",
    icon: "paperclip",
    group: "files",
    defaultSpan: 2,
    minSpan: 2,
  },
  {
    kind: "unused-files",
    labelKey: "notes.home.cards.unusedFiles",
    descriptionKey: "notes.home.cards.unusedFilesHint",
    icon: "archive",
    group: "files",
    defaultSpan: 1,
  },

  // ── State: what the vault knows about itself ─────────────────────────────
  {
    kind: "writing-stats",
    labelKey: "notes.home.cards.writingStats",
    descriptionKey: "notes.home.cards.writingStatsHint",
    icon: "columns-2",
    group: "state",
    defaultSpan: 1,
  },
  {
    kind: "storage",
    labelKey: "notes.home.cards.storage",
    descriptionKey: "notes.home.cards.storageHint",
    icon: "hard-drive",
    group: "state",
    defaultSpan: 1,
  },
  {
    kind: "sync-status",
    labelKey: "notes.home.cards.syncStatus",
    descriptionKey: "notes.home.cards.syncStatusHint",
    icon: "refresh-cw",
    group: "state",
    defaultSpan: 1,
  },

  // ── AI: behind the consent gate ──────────────────────────────────────────
  {
    kind: "agent-prompt",
    labelKey: "notes.home.cards.agentPrompt",
    descriptionKey: "notes.home.cards.agentPromptHint",
    icon: "bot",
    group: "ai",
    defaultSpan: 2,
    requiresAi: true,
  },
];

const BY_KIND = new Map(HOME_CARD_SPECS.map((spec) => [spec.kind, spec]));

/** The spec for a kind, or `undefined` for a kind this build does not know. */
export function homeCardSpec(kind: string): HomeCardSpec | undefined {
  return BY_KIND.get(kind);
}

/** A widget's narrowest width, honouring `minSpan`. */
export function minSpanOf(kind: string): number {
  return homeCardSpec(kind)?.minSpan ?? 1;
}

/**
 * The default surface: what a vault that has never arranged one gets.
 *
 * **Written nowhere until the first edit.** `prefs.home_cards === null` means this
 * list, and it is resolved at render rather than persisted, so a vault that never
 * touched its home is byte-identical to one written before the surface existed.
 *
 * The order is the argument: capture first (the chat bar is the top of the page),
 * then what you were doing, then what is due, then the vault's own numbers. Graphs
 * and files earn their place lower because they are looked at, not worked in.
 */
export const DEFAULT_HOME_CARDS: readonly HomeCard[] = [
  { id: "start-chat", kind: "start-chat", span: 4, options: {} },
  { id: "recent-notes", kind: "recent-notes", span: 2, options: {} },
  { id: "todays-tasks", kind: "todays-tasks", span: 2, options: {} },
  { id: "quick-capture", kind: "quick-capture", span: 2, options: {} },
  { id: "calendar-agenda", kind: "calendar-agenda", span: 2, options: {} },
  { id: "files-preview", kind: "files-preview", span: 2, options: {} },
  { id: "favorites", kind: "favorites", span: 1, options: {} },
  { id: "saved-views", kind: "saved-views", span: 1, options: {} },
  { id: "writing-stats", kind: "writing-stats", span: 1, options: {} },
  { id: "markdown", kind: "markdown", span: 2, options: { markdown: "" } },
];

/**
 * The arrangement to draw: the stored one, or the default when there is none.
 *
 * A widget that needs the AI opt-in is filtered OUT here rather than in the
 * renderer: a gated card left in the list would occupy a grid cell with nothing
 * in it, which reads as a broken widget instead of an absent one. The stored row
 * is untouched, so turning the opt-in back on brings the card back.
 */
export function resolveHomeCards(
  stored: readonly HomeCard[] | null,
  aiEnabled: boolean,
): readonly HomeCard[] {
  const cards = stored ?? DEFAULT_HOME_CARDS;
  if (aiEnabled) return cards;
  return cards.filter((card) => homeCardSpec(card.kind)?.requiresAi !== true);
}

/**
 * A fresh id for a card of this kind.
 *
 * Two cards of one kind are a legitimate arrangement (a second recent-notes card
 * scoped elsewhere, a second markdown block), so the id cannot be the kind alone:
 * `kind` identifies the renderer and `id` identifies the card, which is exactly
 * the distinction the codec's comment draws.
 */
function freshId(kind: string, taken: readonly HomeCard[]): string {
  const used = new Set(taken.map((card) => card.id));
  if (!used.has(kind)) return kind;
  for (let n = 2; ; n += 1) {
    const candidate = `${kind}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** A card as the picker would add it. */
export function newHomeCard(kind: string, taken: readonly HomeCard[]): HomeCard {
  const spec = homeCardSpec(kind);
  return {
    id: freshId(kind, taken),
    kind,
    span: spec?.defaultSpan ?? 1,
    options: { ...(spec?.defaultOptions ?? {}) },
  };
}
