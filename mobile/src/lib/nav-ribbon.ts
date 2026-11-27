// Sidebar customization (owner, 2026-11-27: "iPad'de bu sidebar aynı bizim left
// ribbon gibi customizable olması lazım").
//
// DEVICE-LOCAL, like the home tiles (`lib/home-tiles.ts`): which destinations a
// person keeps in their rail is a layout preference of THIS device's screen, not
// a property of the vault, so it lives in `localStorage` and never enters the
// synced prefs.
//
// The read/repair/write/publish shape is `lib/layout-store.ts` — the same store
// the home screen's cards use, so a repair rule cannot exist on one surface and
// not the other.

import { createLayoutStore } from "./layout-store";

export type RibbonItemId =
  | "search"
  | "tasks"
  | "note-tasks"
  | "graph"
  | "calendar"
  | "files"
  | "templates"
  | "views"
  | "tags"
  | "archive"
  | "trash"
  | "chat";

/** Canonical order. `home`, `all-notes` and `settings` are NOT in the list: they
 *  are the rail's fixed head and foot, so the rail can never be emptied into a
 *  bare strip with no way back to the notes list or to Settings. */
export const RIBBON_ORDER: readonly RibbonItemId[] = [
  "search",
  "tasks",
  "note-tasks",
  "graph",
  "calendar",
  "files",
  "templates",
  "views",
  "tags",
  "archive",
  "trash",
  "chat",
];

export const ribbonLayout = createLayoutStore<RibbonItemId>("myne.ribbon-layout", RIBBON_ORDER);
