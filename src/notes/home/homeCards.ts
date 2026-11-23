// The home surface's card registry (myne-md/myne#1074).
//
// **One entry per kind, and the registry is the only place a card is declared.**
// The plan's eleven cards are eleven entries here plus a renderer in
// `HomeSurface`; a card that is not in this list cannot be in an arrangement, and
// a card in an arrangement that is not in this list renders as an inert row
// rather than disappearing (the codec keeps an unknown id on purpose — see
// `protocol::home_layout`).
//
// **A card never owns its data.** Each renderer calls the module that already
// answers its question (`recentNotes`, the task index, the calendar range, the
// attachment catalog). A card with its own query is a second answer to a question
// the app already answers, and the two drift the first time only one is touched.

import type { IconName } from "../../lib/icons";
import type { HomeCard } from "../../lib/prefs";

/** What a card needs to know to draw itself. */
export interface HomeCardSpec {
  /** The default arrangement's id for this kind. Stable: an arrangement stores it. */
  id: string;
  /** What to draw. */
  kind: string;
  /** The card's title. */
  labelKey: string;
  /** The glyph in the card's header and in the arrangement list. */
  icon: IconName;
  /** The width this card takes when it is added, in columns. */
  defaultSpan: number;
}

/**
 * Every card kind this build can draw.
 *
 * The order here is the order the "add a card" list offers, grouped the way the
 * grill grouped them: what you were doing, what is due, what you keep reaching
 * for, and the one decorative card last.
 */
export const HOME_CARD_SPECS: readonly HomeCardSpec[] = [
  // What you were doing.
  { id: "recent-notes", kind: "recent-notes", labelKey: "notes.home.cards.recentNotes", icon: "file-text", defaultSpan: 2 },
  { id: "quick-capture", kind: "quick-capture", labelKey: "notes.home.cards.quickCapture", icon: "pencil", defaultSpan: 1 },
  // What is due.
  { id: "todays-tasks", kind: "todays-tasks", labelKey: "notes.home.cards.todaysTasks", icon: "list-todo", defaultSpan: 1 },
  { id: "calendar-agenda", kind: "calendar-agenda", labelKey: "notes.home.cards.calendarAgenda", icon: "calendar", defaultSpan: 1 },
  // What you keep reaching for.
  { id: "favorites", kind: "favorites", labelKey: "notes.home.cards.favorites", icon: "hash", defaultSpan: 1 },
  { id: "reference-sets", kind: "reference-sets", labelKey: "notes.home.cards.referenceSets", icon: "paperclip", defaultSpan: 1 },
  { id: "saved-views", kind: "saved-views", labelKey: "notes.home.cards.savedViews", icon: "layout-grid", defaultSpan: 1 },
  { id: "recent-files", kind: "recent-files", labelKey: "notes.home.cards.recentFiles", icon: "folder", defaultSpan: 1 },
  // What you made.
  { id: "writing-stats", kind: "writing-stats", labelKey: "notes.home.cards.writingStats", icon: "columns-2", defaultSpan: 1 },
  { id: "agent-prompt", kind: "agent-prompt", labelKey: "notes.home.cards.agentPrompt", icon: "message-square", defaultSpan: 2 },
  // Decoration, and it says so: the graph card is a small picture of the vault,
  // not a working surface (the plan records it as decoration rather than as a
  // card with a job).
  { id: "graph", kind: "graph", labelKey: "notes.home.cards.graph", icon: "share-2", defaultSpan: 1 },
];

const BY_KIND = new Map(HOME_CARD_SPECS.map((spec) => [spec.kind, spec]));

/** The spec for a kind, or `undefined` for a kind this build does not know. */
export function homeCardSpec(kind: string): HomeCardSpec | undefined {
  return BY_KIND.get(kind);
}

/**
 * The arrangement a vault that has never been arranged gets.
 *
 * **Written nowhere until the first edit.** `prefs.home_cards === null` means
 * this list, and it is resolved at render rather than persisted, so a vault that
 * never touched its home is byte-identical to one written before the surface
 * existed.
 */
export const DEFAULT_HOME_CARDS: readonly HomeCard[] = HOME_CARD_SPECS.map((spec) => ({
  id: spec.id,
  kind: spec.kind,
  span: spec.defaultSpan,
}));

/** The arrangement to draw: the stored one, or the default when there is none. */
export function resolveHomeCards(stored: readonly HomeCard[] | null): readonly HomeCard[] {
  return stored ?? DEFAULT_HOME_CARDS;
}

/**
 * A card as the arrangement list shows it.
 *
 * A kind this build does not know keeps its stored row and reads as inert: the
 * codec preserved it, so the surface must show that something is there rather
 * than silently dropping the row on the next save.
 */
export function homeCardLabelKey(kind: string): string {
  return homeCardSpec(kind)?.labelKey ?? "notes.home.cards.unknown";
}
