// Right-panel tab vocabulary + active-tab self-heal (right-panel tabs).
//
// The right sidebar is a multi-tab panel modeled on the bottom bar: multiple
// non-closable tabs, drag-reorderable, individually hideable via right-click,
// with ONE active tab at a time. This module is the closed tab vocabulary (the
// single source for the restore checklist) plus the active-tab resolver. The
// order/reorder/hide math is REUSED directly from `barItemsOrder.ts`
// (`resolveBarOrder` / `reorderByDrop` / `canMoveBarItem` / `moveBarItem`) — no
// fork. Persisted via `setRightPanelActiveTab` / `setRightPanelHiddenTabs` /
// `setRightPanelTabOrder` (src/lib/prefs.ts).

import type { IconName } from "../lib/icons";

/** One right-panel tab: its stable id, its i18n label key, and its strip icon. */
export interface RightPanelTab {
  readonly id: string;
  readonly labelKey: string;
  readonly icon: IconName;
  /**
   * Whether the tab DESCRIBES the focused note, and so cannot be shown without
   * one (myne-md/myne#656 review): backlinks are this note's links, the outline is
   * its headings, its tasks are its work. The pane's MOUNT GATE reads this, which
   * is why the fact lives on the roster rather than in the gate: a hard-coded
   * `focusedTab.kind === "note"` there also unmounted the two note-FREE tabs
   * (`ai-chat`, `who-is-here`), and `agent-hub`'s ah3 plus the palette's
   * "Open AI Chat" on a graph tab both measured what that costs.
   */
  readonly needsNote: boolean;
}

/**
 * The closed tab vocabulary — the single source of truth for the strip-wide
 * right-click restore checklist (and the order resolver's canonical set). Adding
 * a tab means appending it here AND to {@link RIGHT_PANEL_DEFAULT_ORDER}.
 */
export const RIGHT_PANEL_TABS: readonly RightPanelTab[] = [
  {
    id: "backlinks",
    labelKey: "editor.chrome.rightPanel.tabs.backlinks",
    icon: "link",
    needsNote: true,
  },
  {
    id: "unlinked",
    labelKey: "editor.chrome.rightPanel.tabs.unlinked",
    icon: "hash",
    needsNote: true,
  },
  {
    id: "outline",
    labelKey: "editor.chrome.rightPanel.tabs.outline",
    icon: "list",
    needsNote: true,
  },
  // This note's tasks (MYND-616) — which is exactly what the right panel is
  // for: backlinks are this note's links, the outline is this note's headings,
  // and tasks are this note's work. A hideable, reorderable tab like any other.
  {
    id: "tasks",
    labelKey: "editor.chrome.rightPanel.tabs.tasks",
    icon: "list-todo",
    needsNote: true,
  },
  // AI Chat — the canonical render target the local-ai sibling outputs (summary,
  // Q&A, tag/link suggestions) mount into (local-ai epic, ai-ux-surface MYND-408,
  // SYNC-15). Always present in the vocabulary; the "AI off" / "thinking" chrome
  // and the ai_enabled gating are the AI Chat body's concern (task 5), not the
  // strip's — a hideable tab like any other.
  //
  // `needsNote: false`, and that is load-bearing (`decisions/ai/0634`): the panel
  // is one conversation with no list and no history chrome, asked in passing, and
  // its `openNoteId` is legitimately null on a graph or agent tab. It is not a
  // description of the note the way the three above are.
  {
    id: "ai-chat",
    labelKey: "editor.chrome.rightPanel.tabs.aiChat",
    icon: "message-square",
    needsNote: false,
  },
  // "Who's here", the live-presence roster (live-collab, `collab-presence-ui`).
  // A hideable, reorderable tab like any other; its body is `WhoIsHereTab`, which
  // takes NO note and lists the vault's peers, so it needs none either.
  {
    id: "who-is-here",
    labelKey: "editor.chrome.rightPanel.tabs.whoIsHere",
    icon: "users",
    needsNote: false,
  },
];

/**
 * Canonical default display order — matches the pre-feature render intent
 * (Backlinks first). A known id absent from a user's stored order falls back to
 * its position here (see `resolveBarOrder`). Must list every id in
 * {@link RIGHT_PANEL_TABS}.
 */
export const RIGHT_PANEL_DEFAULT_ORDER: readonly string[] = [
  "backlinks",
  "unlinked",
  "outline",
  "tasks",
  "ai-chat",
  "who-is-here",
];

/** Label-key lookup for a tab id (used by the strip + the context menus). */
export function rightPanelTabLabelKey(id: string): string | null {
  return RIGHT_PANEL_TABS.find((t) => t.id === id)?.labelKey ?? null;
}

/**
 * Resolve the EFFECTIVE active tab from the stored pointer, the resolved tab
 * order, and the hidden set. Self-healing (the `active_workspace` precedent):
 * - if `stored` is a known, visible tab → keep it;
 * - else fall back to the FIRST visible tab in `order`;
 * - else (every tab hidden) → `null` (the panel shows its all-hidden empty state).
 *
 * Healed-on-read: a stored pointer to a now-hidden/unknown tab is NOT rewritten
 * to disk; it is simply reinterpreted each render (the tolerant-`resolveBarOrder`
 * philosophy). `order` should already be a permutation of the canonical set
 * (pass `resolveBarOrder(stored, RIGHT_PANEL_DEFAULT_ORDER)`).
 */
export function resolveActiveTab(
  stored: string | null,
  order: readonly string[],
  hidden: readonly string[],
): string | null {
  const hiddenSet = new Set(hidden);
  const visible = order.filter((id) => !hiddenSet.has(id));
  if (visible.length === 0) return null;
  if (stored !== null && visible.includes(stored)) return stored;
  return visible[0]!;
}

/**
 * Whether this right-panel tab needs the focused note to describe.
 *
 * An UNKNOWN id answers `true` (needs one), which is the safe direction: a tab
 * this roster does not know is not a reason to mount a panel over a graph.
 */
export function rightPanelTabNeedsNote(id: string): boolean {
  return RIGHT_PANEL_TABS.find((t) => t.id === id)?.needsNote ?? true;
}

/**
 * The `hidden` set the panel actually renders against: `ai-chat` is folded in when
 * AI is off (myne-md/myne#225), so BOTH the strip and the active-tab resolution
 * treat it as absent — else the active pointer could land on a now-hidden
 * `ai-chat` and show its body with no tab.
 *
 * Exported because the panel's MOUNT GATE needs the same answer as its body: one
 * of these tabs needs no note, and the gate decides whether there is a panel for
 * it to render in at all.
 */
export function rightPanelEffectiveHidden(
  hidden: readonly string[],
  aiEnabled: boolean,
): readonly string[] {
  return aiEnabled ? hidden : [...new Set([...hidden, "ai-chat"])];
}

/**
 * The tab that will actually render, from a STORED pointer, an order and a hidden
 * set: the fold above plus {@link resolveActiveTab}, in one call.
 *
 * Both the pane's mount gate and `RightSidebar`'s body go through here, so they
 * cannot disagree about which tab is active — the disagreement this exists to
 * prevent is a panel that mounts showing one tab while the gate judged another.
 */
export function resolveVisibleRightPanelTab(opts: {
  stored: string | null;
  order: readonly string[];
  hidden: readonly string[];
  aiEnabled: boolean;
}): string | null {
  return resolveActiveTab(
    opts.stored,
    opts.order,
    rightPanelEffectiveHidden(opts.hidden, opts.aiEnabled),
  );
}
