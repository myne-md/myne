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
import { ATTACHMENTS_TAB_ID, GRAPH_TAB_ID, TASKS_TAB_ID } from "./workspaceState";

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
    kind: "tasks",
    singletonId: TASKS_TAB_ID,
    icon: "list-todo",
    labelKey: "notes.pane.tasksTab",
    showsFocusedNote: false,
    openCommandId: "tasks.show",
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
