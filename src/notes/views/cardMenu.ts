// The card context-menu item set (MYND-275, Saved Views #5, task 8).
//
// A pure builder so the item set is unit-testable. Two shapes, and the
// difference is the whole design:
//
// - **The read-only set** (default): Open · Open in new tab · Reveal in folder ·
//   Copy link. A saved view is a projection over notes, so a card menu may never
//   carry a mutating verb on its own authority — deleting and moving stay at the
//   note's own location in the sidebar.
// - **The lifecycle set** (myne-md/myne#922 task 8): those four plus Archive and
//   Move to trash, offered ONLY when the host passes the two handlers. Those
//   write the reserved markers (`archived`, `trashed`), which no manifest can
//   address in either direction, so the board cannot hide a note from its own
//   vault: the HOST is deciding, and the renderer is only the door.
//
// The two items are labelled for what they do rather than collapsed into one
// "Delete": they leave the note in different places, and the trash one is
// recoverable in a different place from the archive one.

import type { ContextMenuItem } from "../components/ContextMenu";
import i18n from "../../i18n";

/** Handlers the host binds (workspace open seam + sidebar select + clipboard). */
export type CardMenuHandlers = {
  readonly open: () => void;
  readonly openInNewTab: () => void;
  readonly revealInFolder: () => void;
  readonly copyLink: () => void;
};

/**
 * The host-owned lifecycle actions. Both absent → the read-only set, which is
 * what a surface with no note lifecycle (the cards gallery, a read-only host,
 * mobile) offers.
 */
export type CardMenuLifecycle = {
  readonly archive: () => void;
  readonly trash: () => void;
};

/** The exact set of menu item ids the read-only shape carries — the closed
 *  allow-list for a projection. */
export const CARD_MENU_ITEM_IDS = [
  "open",
  "open-in-new-tab",
  "reveal-in-folder",
  "copy-link",
] as const;

/** The two ids a host that offers a note lifecycle adds, in order. */
export const CARD_MENU_LIFECYCLE_ITEM_IDS = ["archive", "trash"] as const;

/**
 * Build the card context-menu items: the read-only four in order, then the two
 * lifecycle items when the host supplies them. Every item is either navigation
 * or a host-owned reserved-marker write; nothing here writes a note.
 */
export function buildCardMenuItems(
  h: CardMenuHandlers,
  lifecycle?: CardMenuLifecycle,
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    { id: "open", label: i18n.t("notes.cardMenu.open"), group: "open", onSelect: h.open },
    {
      id: "open-in-new-tab",
      label: i18n.t("notes.cardMenu.openInNewTab"),
      group: "open",
      onSelect: h.openInNewTab,
    },
    {
      id: "reveal-in-folder",
      label: i18n.t("notes.cardMenu.revealInFolder"),
      group: "navigate",
      onSelect: h.revealInFolder,
    },
    { id: "copy-link", label: i18n.t("notes.cardMenu.copyLink"), group: "utility", onSelect: h.copyLink },
  ];
  if (lifecycle !== undefined) {
    items.push(
      {
        id: "archive",
        label: i18n.t("notes.cardMenu.archive"),
        group: "lifecycle",
        onSelect: lifecycle.archive,
      },
      {
        id: "trash",
        label: i18n.t("notes.cardMenu.trash"),
        group: "lifecycle",
        destructive: true,
        onSelect: lifecycle.trash,
      },
    );
  }
  return items;
}
