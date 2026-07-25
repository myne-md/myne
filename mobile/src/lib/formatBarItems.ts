// FormatBar customization vocabulary + resolver (MYND-555) — the mobile analog of
// desktop's `src/notes/toolbarItems.ts` (MYND-336).
//
// The above-keyboard format bar becomes user-configurable: reorder + show/hide
// over a FROZEN command vocabulary. No custom/arbitrary buttons — that would be a
// plugin/scripting surface, out for v1, exactly as on desktop.
//
// ## What is customizable, and what deliberately is not
//
// Only FORMAT COMMANDS are in the vocabulary. The bar's remaining buttons —
// attach, insert-from-library, record, the raw/live toggle, and hide-keyboard —
// are chrome, not formatting, and stay pinned at fixed positions. Two reasons,
// and the second is the load-bearing one:
//   1. They are not `editorCommands`; they open host UI.
//   2. Hiding `raw-toggle` or `hide-keyboard` would strand the user — those are
//      the only exits from source mode and from the keyboard. A customization
//      surface must not be able to remove its own escape hatches.
//
// ## Ids are governed on-disk data
//
// The moment a vault persists a layout these ids are a vocabulary in
// `vault.prefs` (like keymap command ids), so renaming or removing one is a
// migration event (decisions.md + glossary), never a silent edit. Ids match
// desktop's for every command both bars share (`bold`, `italic`, `code`, `link`,
// `bulletList`, `checklist`, `quote`, `wikilink`), so the two clients agree
// wherever they can. Mobile-only ids (`undo`, `redo`, `heading1`, `heading2`)
// have no desktop counterpart — desktop's `heading` is a dropdown cluster, which
// does not fit a one-row keyboard bar.
//
// The field pair (`editor_toolbar_order` / `editor_toolbar_hidden`) is
// DEVICE-LOCAL in the sync merge policy (`sync-protocol.md` §10.2.1), so a
// mobile layout never propagates to desktop and vice versa — a toolbar layout is
// a function of the screen it is laid out on. The one path that can carry foreign
// ids in is a backup restore, which is why {@link resolveFormatBarOrder} drops
// unknown ids instead of trusting the stored list.

/** One customizable format action: its stable persisted id + its i18n label key. */
export interface FormatBarItem {
  readonly id: string;
  readonly labelKey: string;
}

/**
 * The frozen vocabulary — every format command a user MAY place on the bar, in
 * canonical order. Adding a command means appending it here AND giving it a
 * renderer in `FormatBar`; a vocabulary entry with no renderer is a bug the
 * `formatBarItems` unit test catches.
 */
export const FORMAT_BAR_ITEMS: readonly FormatBarItem[] = [
  { id: "undo", labelKey: "notes.list.undo" },
  { id: "redo", labelKey: "editor.formatBar.redo" },
  { id: "heading1", labelKey: "editor.slash.heading1" },
  { id: "heading2", labelKey: "editor.slash.heading2" },
  { id: "bold", labelKey: "editor.toolbar.customize.bold" },
  { id: "italic", labelKey: "editor.toolbar.customize.italic" },
  { id: "bulletList", labelKey: "editor.toolbar.customize.bulletList" },
  { id: "checklist", labelKey: "editor.toolbar.customize.checklist" },
  { id: "quote", labelKey: "editor.toolbar.customize.quote" },
  { id: "code", labelKey: "editor.toolbar.customize.code" },
  { id: "wikilink", labelKey: "editor.toolbar.customize.wikilink" },
  { id: "link", labelKey: "editor.toolbar.customize.link" },
];

/** Canonical default order — every id in {@link FORMAT_BAR_ITEMS}, in bar order. */
export const FORMAT_BAR_DEFAULT_ORDER: readonly string[] = FORMAT_BAR_ITEMS.map((i) => i.id);

/** id → i18n label key, hoisted to module scope. Both consumers (the bar and the
 *  Settings panel) label by id, and the bar re-renders on every keystroke, so a
 *  linear scan of the vocabulary per button per render is pure waste. */
const LABEL_KEY_BY_ID: ReadonlyMap<string, string> = new Map(
  FORMAT_BAR_ITEMS.map((i) => [i.id, i.labelKey]),
);

/** The i18n key for `id`, or `null` when the id is not in the vocabulary (a
 *  foreign id from a restored backup). Callers fall back to showing the raw id —
 *  it is only reachable for something that should not be rendered anyway. */
export function formatBarLabelKey(id: string): string | null {
  return LABEL_KEY_BY_ID.get(id) ?? null;
}

/**
 * Resolve the persisted order against the canonical vocabulary.
 *
 * Stored ids come first in their stored order (deduplicated, and any id NOT in
 * the vocabulary dropped), then every canonical id the stored list omitted, in
 * canonical order. That makes the function total and forward/backward safe: a
 * stored list from an older build silently gains the new buttons at the end, and
 * a list carrying a desktop-only id (`strike`, `highlight`) or a removed one —
 * both reachable via a backup restore — loses it rather than rendering a hole.
 *
 * Deliberately a local reimplementation of desktop's 20-line
 * `resolveBarOrder(stored, canonical)` rather than an alias into the desktop app
 * source. The `vite.config.ts` alias list is curated: a module is shared when a
 * VALUE crosses the client boundary (`@myne/decorations` — synced prefs maps).
 * This value is device-local by classification, so nothing crosses and an alias
 * would buy a no-contract dependency on desktop internals for pure arithmetic.
 */
export function resolveFormatBarOrder(
  stored: readonly string[],
  canonical: readonly string[] = FORMAT_BAR_DEFAULT_ORDER,
): string[] {
  const known = new Set(canonical);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of stored) {
    if (known.has(id) && !seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  for (const id of canonical) {
    if (!seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  return out;
}

/**
 * The ids the bar actually renders: the resolved order minus the hidden set.
 *
 * An unknown id in `hidden` is inert (it can hide nothing), which is what makes a
 * desktop-authored hidden set harmless after a restore. Hiding EVERY item is
 * allowed and yields an empty format region — the pinned chrome (attach /
 * library / record / raw-toggle / hide-keyboard) is outside this vocabulary, so
 * the bar itself never disappears and the user can always reach Settings to
 * restore. That is the whole reason chrome is not customizable.
 */
export function visibleFormatBarIds(
  order: readonly string[],
  hidden: readonly string[],
): string[] {
  const hide = new Set(hidden);
  return resolveFormatBarOrder(order).filter((id) => !hide.has(id));
}
