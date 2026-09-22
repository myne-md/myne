// The three-region keyboard model (myne-md/myne#728).
//
// A keyboard-first user could not leave the editor body: Tab indents (and must
// keep indenting), so there was no key that moved focus out of the note into
// the chrome. The answer is a region model rather than a Tab-order change. The
// window is three regions - the notes sidebar, the editor pane, the right panel
// - each one a single Tab stop with roving navigation inside it (the sibling
// primitive `@myne/editor/host/lib/roving-focus`), and one remembered key (F6)
// cycles between them. Each region is also directly bindable, so a user who
// wants three chords instead of one cycle can have them.
//
// A region is declared in the DOM, not registered in a store: a
// `data-region="<id>"` attribute on the region's root element is the whole
// contract. That matters because the regions are rendered by three different
// components (two `SidebarPane`s and the centre column), and any of them can be
// absent (collapsed sidebar, a non-note tab with no right panel at all). A
// store would have to be told; an attribute is simply not there.
//
// This module deliberately touches no React and no Tauri: it is a DOM rule plus
// a pure cycle rule, so the cycle is unit-testable without rendering anything.

import { focusableWithin } from "@myne/editor/host/lib/focusable";

export type RegionId = "sidebar" | "editor" | "right-panel";

/** Attribute that marks a region root. Written by the shell, read only here. */
export const REGION_ATTR = "data-region";

/**
 * Cycle order, which is also visual order in a left-to-right layout. RTL
 * mirrors the layout but not this: F6 cycling is "sidebar, then the note, then
 * the panel" as a reading of the app's structure, and a user who has learned
 * the order does not want it to depend on their locale.
 */
export const REGION_IDS: readonly RegionId[] = ["sidebar", "editor", "right-panel"];

/**
 * Where focus should land when a region is ENTERED, most-preferred first, as
 * selectors resolved inside the region root. An empty list means "the first
 * focusable element", which is the right answer for a panel whose top control
 * is its point.
 *
 * The editor is the one region where it is not: the first focusable element in
 * the pane is a tab in the tab strip, and a user who asked for the editor asked
 * for the text. `.cm-content` is CodeMirror's editable surface and the same
 * element `focusKindOf` classifies as `cm-editor`, so the two agree on what the
 * editor IS.
 */
const REGION_ENTRY_SELECTORS: Record<RegionId, readonly string[]> = {
  sidebar: [],
  editor: [".cm-content"],
  "right-panel": [],
};

function activeDocument(doc?: Document): Document | null {
  if (doc !== undefined) return doc;
  return typeof document === "undefined" ? null : document;
}

/** The region root element for `id`, or `null` when that region is not rendered. */
export function regionRoot(id: RegionId, doc?: Document): HTMLElement | null {
  const d = activeDocument(doc);
  if (d === null) return null;
  return d.querySelector<HTMLElement>(`[${REGION_ATTR}="${id}"]`);
}

/**
 * Whether `el` sits inside an `inert` subtree. A collapsed sidebar keeps its
 * content mounted at width 0 with `inert` on the inner wrapper (that is what
 * makes the collapse animate), so its buttons still match the focusable
 * selector and cannot actually be focused. Entering such a region would move
 * focus nowhere and leave the user stranded with no ring.
 */
function inInertSubtree(el: HTMLElement): boolean {
  return el.closest("[inert]") !== null;
}

/**
 * The element focus should land on when entering `root`, or `null` when the
 * region holds nothing reachable.
 */
export function regionEntryTarget(root: HTMLElement, id: RegionId): HTMLElement | null {
  if (inInertSubtree(root)) return null;
  for (const selector of REGION_ENTRY_SELECTORS[id]) {
    const preferred = root.querySelector<HTMLElement>(selector);
    if (preferred !== null && !inInertSubtree(preferred)) return preferred;
  }
  return focusableWithin(root).find((el) => !inInertSubtree(el)) ?? null;
}

/** The regions currently rendered AND enterable, in cycle order. */
export function reachableRegions(doc?: Document): RegionId[] {
  return REGION_IDS.filter((id) => {
    const root = regionRoot(id, doc);
    return root !== null && regionEntryTarget(root, id) !== null;
  });
}

/** The region containing `el`, or `null` when it is outside all of them. */
export function regionOf(el: Element | null): RegionId | null {
  const root = el?.closest<HTMLElement>(`[${REGION_ATTR}]`) ?? null;
  const id = root?.getAttribute(REGION_ATTR) ?? null;
  return REGION_IDS.includes(id as RegionId) ? (id as RegionId) : null;
}

/** The region holding focus right now, or `null`. */
export function currentRegion(doc?: Document): RegionId | null {
  const d = activeDocument(doc);
  return d === null ? null : regionOf(d.activeElement);
}

/**
 * The pure cycle rule: the region after `from` among `reachable`, wrapping.
 *
 * Kept free of the DOM so the wrap, the "focus is nowhere" case and the
 * "the current region has since disappeared" case are all testable without
 * rendering a shell. `from` absent from `reachable` lands on the first one
 * rather than returning null, because that is exactly the collapsed-sidebar
 * case: the user was in a region that no longer accepts focus, and doing
 * nothing would be indistinguishable from a broken key.
 */
export function nextRegionId(
  from: RegionId | null,
  reachable: readonly RegionId[],
  forward = true,
): RegionId | null {
  if (reachable.length === 0) return null;
  const here = from === null ? -1 : reachable.indexOf(from);
  if (here === -1) return reachable[0] ?? null;
  const step = forward ? 1 : -1;
  return reachable[(here + step + reachable.length) % reachable.length] ?? null;
}

/**
 * Move focus into `id`. Returns whether focus actually moved, so a caller can
 * tell "region not rendered" from "done" instead of guessing.
 */
export function focusRegion(id: RegionId, doc?: Document): boolean {
  const root = regionRoot(id, doc);
  if (root === null) return false;
  const target = regionEntryTarget(root, id);
  if (target === null) return false;
  target.focus();
  return true;
}

/** Move focus to the next (or previous) reachable region. Returns the region entered. */
export function cycleRegion(forward = true, doc?: Document): RegionId | null {
  const next = nextRegionId(currentRegion(doc), reachableRegions(doc), forward);
  if (next === null) return null;
  return focusRegion(next, doc) ? next : null;
}

/**
 * The one call shape the app uses for both dispatch paths (the F6 keybind and
 * the command-palette rows).
 *
 * The deferral is not decoration. A palette row runs while the palette is still
 * mounted: `close()` is a state update, so the modal's focus trap tears down on
 * React's commit, AFTER the handler returns, and its teardown restores focus to
 * whatever was focused before the palette opened. A synchronous focus move from
 * inside the handler is therefore undone a moment later, silently. Deferring
 * past the current task puts the move after the restore. Nothing competes for
 * focus on the keybind path, so routing it the same way costs nothing and
 * leaves exactly one code path to reason about.
 */
export function enterRegion(id: RegionId | "next" | "previous"): void {
  setTimeout(() => {
    if (id === "next") cycleRegion(true);
    else if (id === "previous") cycleRegion(false);
    else focusRegion(id);
  }, 0);
}
