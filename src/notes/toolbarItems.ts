// Editor-toolbar customization vocabulary + resolver (MYND-336). The floating
// selection toolbar (and the slash menu) become user-configurable: reorder +
// show/hide over a FROZEN command vocabulary — NO custom/arbitrary buttons (that
// would be a plugin/scripting surface, out for v1). The order/hidden math is
// REUSED from `barItemsOrder.ts` (`resolveBarOrder`), exactly like the
// right-panel tabs (`rightPanelTabs.ts`) — no fork. The resolved id list is what
// the editor's toolbar plugin renders; persistence is `vault.prefs` (SYNC-3).
//
// Item ids are a governed on-disk vocabulary the moment a vault persists a
// layout (like keymap command ids) — renaming/removing one is a migration event
// (decisions.md + glossary), never a silent edit.

import { resolveBarOrder } from "./barItemsOrder";

/** One toolbar-eligible command: its stable id + its i18n label key. The id
 *  matches the editor's `EditorCommandId` (or a toolbar-group id like `heading`
 *  / `highlight` for the dropdown clusters). */
export interface ToolbarItem {
  readonly id: string;
  readonly labelKey: string;
}

/**
 * The frozen toolbar vocabulary — every command a user MAY place on the floating
 * toolbar. The default-shown subset is {@link EDITOR_TOOLBAR_DEFAULT_HIDDEN}'s
 * complement; the rest are hidden-but-addable. Adding a command means appending
 * it here AND to {@link EDITOR_TOOLBAR_DEFAULT_ORDER}.
 */
export const EDITOR_TOOLBAR_ITEMS: readonly ToolbarItem[] = [
  { id: "bold", labelKey: "editor.toolbar.customize.bold" },
  { id: "italic", labelKey: "editor.toolbar.customize.italic" },
  { id: "strike", labelKey: "editor.toolbar.customize.strike" },
  { id: "code", labelKey: "editor.toolbar.customize.code" },
  { id: "highlight", labelKey: "editor.toolbar.customize.highlight" },
  { id: "link", labelKey: "editor.toolbar.customize.link" },
  { id: "heading", labelKey: "editor.toolbar.customize.heading" },
  { id: "bulletList", labelKey: "editor.toolbar.customize.bulletList" },
  { id: "numberedList", labelKey: "editor.toolbar.customize.numberedList" },
  { id: "checklist", labelKey: "editor.toolbar.customize.checklist" },
  { id: "quote", labelKey: "editor.toolbar.customize.quote" },
  { id: "wikilink", labelKey: "editor.toolbar.customize.wikilink" },
];

/** Canonical default display order — must list every id in {@link EDITOR_TOOLBAR_ITEMS}. */
export const EDITOR_TOOLBAR_DEFAULT_ORDER: readonly string[] = [
  "bold",
  "italic",
  "strike",
  "code",
  "highlight",
  "link",
  "heading",
  "bulletList",
  "numberedList",
  "checklist",
  "quote",
  "wikilink",
];

/** Ids HIDDEN by default, so an un-customized toolbar shows today's set
 *  (bold/italic/strike/code/highlight/heading/link). The rest are addable. */
export const EDITOR_TOOLBAR_DEFAULT_HIDDEN: readonly string[] = [
  "bulletList",
  "numberedList",
  "checklist",
  "quote",
  "wikilink",
];

/** Label-key lookup for a toolbar item id (the Settings customization list). */
export function toolbarItemLabelKey(id: string): string | null {
  return EDITOR_TOOLBAR_ITEMS.find((item) => item.id === id)?.labelKey ?? null;
}

/**
 * Resolve the toolbar's EFFECTIVE rendered id list from the stored order + the
 * hidden set. Self-healing (the `resolveBarOrder` contract): a stored order is
 * completed against the canonical order (unknown ids dropped, new ids appended
 * in canonical position), then hidden ids are removed. An empty stored order
 * falls back to the canonical order.
 */
export function resolveToolbarOrder(
  storedOrder: readonly string[],
  hidden: readonly string[],
): string[] {
  const hiddenSet = new Set(hidden);
  return resolveBarOrder(storedOrder, EDITOR_TOOLBAR_DEFAULT_ORDER).filter(
    (id) => !hiddenSet.has(id),
  );
}
