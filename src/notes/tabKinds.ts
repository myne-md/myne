// The tab-kind registry (myne-md/myne#773, epic #772 lane 0d).
//
// ── The failure this closes ─────────────────────────────────────────────────
// Adding a tab kind used to cost an edit at roughly seven sites, none of which
// referenced each other: the `WorkspaceItem` union and its sentinel id in
// `workspaceState.ts`; `parseItemKey`'s prefix arm in the same file;
// `parseItem`'s `o.kind` arm in `lib/workspace-persist.ts`; the `titleOf` and
// `iconOf` switches in `PaneView.tsx`; the command that opens it; and the
// ribbon entry that pins it. Miss one and nothing fails to compile — the tab
// simply renders with no icon, or with a raw id for a label, or survives a
// reload as a dropped tab, depending on which arm was forgotten.
//
// The union stays in `workspaceState.ts` and is still the TYPE authority: a
// discriminated union is what makes `it.kind === "tasks"` narrow to the variant
// carrying `taskView`, and no runtime table can do that. What moves here is the
// BEHAVIOURAL metadata those switches were each restating — the sentinel, the
// glyph, the label key — so a new kind declares itself once and the sites read
// it. `SINGLETON_TAB_KINDS` is derived rather than listed, which is the half
// that stops the registry from becoming an eighth place to forget.
//
// ── What a singleton kind is ────────────────────────────────────────────────
// A kind with exactly one instance per workspace (the graph, the task list)
// pins a FIXED sentinel id. That is what makes "open the graph" idempotent: the
// global duplicate-forbid invariant then turns a second open into a reveal of
// the first rather than a second tab. A per-entity kind (`note`, `view`) has no
// sentinel because its id IS the entity.
//
// ── The forward-compatibility contract ──────────────────────────────────────
// This registry does NOT decide what a reader accepts. `parseItem` drops an
// unknown `kind` rather than erroring, so an older client reading a newer
// `vault.workspace` (MYW1) keeps its other tabs instead of losing the whole
// workspace. Adding a kind here is what makes a NEWER client understand it; the
// older client's graceful degradation is a property of that parser and is
// pinned by its own test.

import type { IconName } from "../lib/icons";
import type { WorkspaceItem } from "./workspaceState";
// ── The singleton sentinels live HERE, not in `workspaceState` ──────────────
// They were declared in `workspaceState` and imported, which made the registry
// and the state module circular: `workspaceState` imports `TAB_KIND_TAGS` and
// `canonicalTabId` from here, and this file imported the sentinels from there.
// At module-init time the sentinels were still `undefined` when `TAB_KINDS` was
// built, so every `singletonId` was `undefined`, `isSingletonTabKind` was false
// for all of them, and `canonicalTabId("graph", "junk")` returned `"junk"`
// instead of the sentinel — a stored `graph:junk` handle resolved to a
// nonexistent tab. TypeScript cannot see it (the binding is live, just unset),
// no guard checked it, and the registry's own tests passed because they called
// `canonicalTabId` directly with a sentinel that was by then set.
//
// Declaring the constants in the registry and re-exporting them from
// `workspaceState` keeps the public names where they were while removing the
// cycle: this module now owns its own values.
//
// ALL of them, not the three the cycle was first noticed through. The
// attachment library and the template library were declared in `workspaceState`
// and were live bindings into the same cycle; leaving two behind would have
// meant a registry whose singleton ids were correct for three kinds and
// `undefined` for two, which is the original defect wearing a smaller mask.

/** The whole-vault graph: exactly one per workspace, so its id is a fixed
 *  sentinel and the global duplicate-forbid invariant makes "open graph"
 *  idempotent — a reveal, never a second tab. */
export const GRAPH_TAB_ID = "graph";

/** The vault-wide task list. Same singleton rule. */
export const TASKS_TAB_ID = "tasks";

/** The attachment library (myne-md/myne#773, epic #772). It used to be a
 *  `CenterView` — a SECOND, parallel centre-pane swap mechanism that replaced
 *  the whole pane tree and bypassed the tab model entirely. That is why the
 *  left ribbon could not know it was open, why it could not be split beside a
 *  note, and why closing it had to route through a bespoke `onClose`. */
export const ATTACHMENTS_TAB_ID = "attachments";

/** The note-template library (myne-md/myne#779). One library per vault, so
 *  opening it twice reveals the first. It was a MODAL, which
 *  `design-notes/ui/0633` classifies as the wrong shape for it: you browse a
 *  template library, rename in it and delete from it, and none of that is a
 *  question the app is asking you. */
export const TEMPLATES_TAB_ID = "templates";

/** The agent hub (myne-md/myne#771). One hub per vault; the per-tab
 *  `agentView` decides whether it shows the hub list or a focused run. */
export const AGENT_TAB_ID = "agent";

/** The calendar (myne-md/myne#1037). One calendar per vault, like the graph and
 *  the task list: an event is a note, and a vault has one schedule, so opening
 *  the calendar twice reveals the first tab rather than splitting the same
 *  month across two panes. */
export const CALENDAR_TAB_ID = "calendar";

/** The home surface (myne-md/myne#1074). One per workspace: it is the place you
 *  start from, and a second copy of it in the same pane tree would be two
 *  answers to "where am I" rather than a second view of anything. */
export const HOME_TAB_ID = "home";

export type TabKind = WorkspaceItem["kind"];

export interface TabKindSpec {
  kind: TabKind;
  /**
   * The fixed id of a singleton kind, or `undefined` for a per-entity kind
   * whose id is the entity's own. Presence of this field is what MAKES a kind a
   * singleton — see {@link isSingletonTabKind}, which derives from it rather
   * than from a second list that could disagree.
   */
  singletonId?: string;
  /** The tab-strip glyph. */
  icon: IconName;
  /**
   * i18n key for the tab's label. A singleton has a fixed label; a per-entity
   * kind resolves its own title from the entity (a note's title, a view's name)
   * and carries no key.
   */
  labelKey?: string;
  /**
   * Whether this surface is SHOWING A NOTE, so note-scoped chrome applies.
   *
   * Two consumers, and they turned out to be asking one question:
   *   - the top-right floats (backlinks, outline, the "…" menu), which all act
   *     on the open note;
   *   - the notes sidebar's selected-row highlight, which claims "this note is
   *     what you are looking at".
   *
   * Both compared against the literal `"note"` in their own file. Declaring it
   * once means a new kind has to ANSWER, where a literal silently gives it
   * `note`'s answer by omission — and the failures are a backlinks panel over a
   * surface with no note behind it, and a sidebar row claiming to be active
   * while you look at the graph. The second one shipped: the highlight rule
   * asked whether the attachment library owned the center pane, so it was
   * correct for the library and wrong for the graph and the task list
   * (myne-md/myne#773).
   */
  showsFocusedNote: boolean;
  /** Whether this tab asks for the WHOLE surface, so both sidebars close on
   *  entry. Declared here rather than as a condition in the Editor, which is the
   *  shape that produced the seven-site problem this registry exists to remove. */
  ownsWholeSurface?: boolean;
  /**
   * The registry command that opens this kind, when one exists.
   *
   * This is what lets the left ribbon show which of its entries is the surface
   * you are LOOKING at (myne-md/myne#773). Before it, the rail had no active
   * state at all: pressing Attachments and pressing Graph left the rail
   * identical, so the one column that is always visible could not tell you
   * where you were. Declaring the link here rather than as a lookup table in
   * the component means a new kind wires its own rail state.
   *
   * `note` and `view` have none: they are opened by picking an entity, not by
   * running a command, so no single rail entry corresponds to them.
   */
  openCommandId?: string;
}

export const TAB_KINDS: readonly TabKindSpec[] = [
  { kind: "note", icon: "file-text", showsFocusedNote: true },
  { kind: "view", icon: "layout-grid", showsFocusedNote: false },
  {
    kind: "graph",
    singletonId: GRAPH_TAB_ID,
    icon: "share-2",
    labelKey: "notes.pane.graphTab",
    showsFocusedNote: false,
    openCommandId: "graph.show",
  },
  {
    kind: "attachments",
    singletonId: ATTACHMENTS_TAB_ID,
    icon: "paperclip",
    labelKey: "attachments.library.title",
    showsFocusedNote: false,
    openCommandId: "attachments.open",
  },
  {
    kind: "templates",
    singletonId: TEMPLATES_TAB_ID,
    icon: "file-text",
    labelKey: "templates.manager.title",
    showsFocusedNote: false,
    openCommandId: "templates.manage",
  },
  {
    kind: "tasks",
    singletonId: TASKS_TAB_ID,
    icon: "list-todo",
    labelKey: "notes.pane.tasksTab",
    showsFocusedNote: false,
    openCommandId: "tasks.show",
  },
  {
    kind: "calendar",
    singletonId: CALENDAR_TAB_ID,
    icon: "calendar",
    labelKey: "notes.pane.calendarTab",
    // The calendar shows events, not the focused note, so the note floats
    // (backlinks, outline, the "..." menu) stay off it: an event note opened from
    // a cell is an ordinary note tab.
    showsFocusedNote: false,
    // A month grid reads neither sidebar.
    ownsWholeSurface: true,
    openCommandId: "calendar.show",
  },
  {
    kind: "home",
    singletonId: HOME_TAB_ID,
    icon: "house",
    labelKey: "notes.pane.homeTab",
    // The cards act on the vault, not on one note, so the note floats stay off
    // it. It does NOT own the whole surface: home beside a note is the shape it
    // is for, which is why it is not declared `ownsWholeSurface`.
    showsFocusedNote: false,
    openCommandId: "home.show",
  },
  {
    kind: "agent",
    singletonId: AGENT_TAB_ID,
    // `message-square`, the same plain speech bubble the right-panel AI tab
    // uses. NOT a sparkle/wand glyph (PRODUCT.md bans hype AI framing, and the
    // icons file carries that note beside both entries).
    icon: "message-square",
    labelKey: "notes.pane.agentTab",
    // The note floats (backlinks / outline / the "…" menu) act on an OPEN NOTE,
    // and the agent tab is vault-general, so it does not carry them. The field
    // was `hasNoteFloats` when this entry was written against the lane-0
    // commit; it is `showsFocusedNote` now, which says the same thing from the
    // reader's side rather than the float's.
    showsFocusedNote: false,
    // The first whole-surface tab: its own conversation rail (myne-md/myne#913).
    ownsWholeSurface: true,
    // The rail's "you are here" state reads this, so the agent's ribbon entry
    // lights up while its tab is the focused one — the reason the field exists.
    openCommandId: "ai.open-agent-vault",
  },
];

const BY_KIND: ReadonlyMap<TabKind, TabKindSpec> = new Map(
  TAB_KINDS.map((s) => [s.kind, s]),
);

/** The spec for a kind. Total over `TabKind`, so callers need no fallback. */
export function tabKindSpec(kind: TabKind): TabKindSpec {
  const spec = BY_KIND.get(kind);
  // Unreachable while `TAB_KINDS` covers the union — and the exhaustiveness
  // test in `tests/notes/tabKinds.test.ts` is what keeps that true, since
  // TypeScript cannot check a runtime array against a union.
  if (spec === undefined) throw new Error(`unregistered tab kind: ${kind}`);
  return spec;
}

/** Whether a kind is a workspace singleton (derived from `singletonId`). */
export function isSingletonTabKind(kind: TabKind): boolean {
  return tabKindSpec(kind).singletonId !== undefined;
}

/** Whether the focused tab asks for the whole surface; absent reads as `false`. */
export function tabOwnsWholeSurface(kind: TabKind | null | undefined): boolean {
  return kind === null || kind === undefined
    ? false
    : tabKindSpec(kind).ownsWholeSurface === true;
}

/** The id type a given kind's variant declares (a literal for a singleton). */
type TabIdOf<K extends TabKind> = Extract<WorkspaceItem, { kind: K }>["id"];

/**
 * Normalize a persisted/parsed id for its kind: a singleton's id is ALWAYS its
 * sentinel, whatever a stored descriptor claimed, so a workspace written by a
 * build that used a different id still resolves to the one canonical tab.
 *
 * Generic in the kind so the return NARROWS the way the union does — `graph`
 * yields `"graph"`, not `string`. Without that every caller assembling a
 * `WorkspaceItem` needs its own cast, and a cast per call site is a cast
 * nobody reads. There is exactly one here instead, and it is sound by
 * construction: `singletonId` is the variant's own sentinel, and the
 * exhaustiveness test asserts every singleton declares one.
 */
export function canonicalTabId<K extends TabKind>(kind: K, id: string): TabIdOf<K> {
  return (tabKindSpec(kind).singletonId ?? id) as TabIdOf<K>;
}

/** Every registered kind's string tag — the `parseItemKey` prefix vocabulary. */
export const TAB_KIND_TAGS: readonly TabKind[] = TAB_KINDS.map((s) => s.kind);

/**
 * The registry command that opens `kind`, or `undefined` when opening it is not
 * a command (a note, a saved view — you pick an entity, not a surface).
 *
 * The inverse direction the left ribbon needs: given the focused tab's kind,
 * which rail entry should read as current?
 */
export function openCommandForKind(kind: TabKind): string | undefined {
  return tabKindSpec(kind).openCommandId;
}
