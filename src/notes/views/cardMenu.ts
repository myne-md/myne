// The card context-menu item set (MYND-275, Saved Views #5, task 8). A pure
// builder so the CLOSED, non-mutating item set is unit-testable: a saved view
// is a read-only projection, so the card menu must NEVER carry delete / move /
// trash / rename — deletion stays at the note's own location (the sidebar).
//
// The four items, in order: Open · Open in new tab · Reveal in folder · Copy
// link. Navigation reuses the workspace open seam (task 7); reveal selects the
// note in the sidebar; copy-link writes a `[[title]]` wikilink. The host wires
// the handlers + renders these via the shared `ContextMenu`.

import type { ContextMenuItem } from "../components/ContextMenu";
import i18n from "../../i18n";

/** Handlers the host binds (workspace open seam + sidebar select + clipboard). */
export type CardMenuHandlers = {
  readonly open: () => void;
  readonly openInNewTab: () => void;
  readonly revealInFolder: () => void;
  readonly copyLink: () => void;
};

/** The exact set of menu item ids — the closed allow-list (no mutating verb). */
export const CARD_MENU_ITEM_IDS = [
  "open",
  "open-in-new-tab",
  "reveal-in-folder",
  "copy-link",
] as const;

/**
 * Build the card context-menu items. Exactly {@link CARD_MENU_ITEM_IDS}, in
 * order, each non-destructive. No delete / move / trash / rename item exists —
 * the set is closed by construction.
 */
export function buildCardMenuItems(h: CardMenuHandlers): ContextMenuItem[] {
  return [
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
}
