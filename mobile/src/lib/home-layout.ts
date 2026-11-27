// Home's card layout (owner, 2026-11-27 round 2: "desktop'daki home olayını
// buraya da getirebiliriz belki bir tab olarak").
//
// Device-local, like the rail: which cards a person keeps on their own home
// screen is a layout opinion about this screen, not a property of the vault, so
// it never enters synced prefs. The store itself is `lib/layout-store.ts`.

import { createLayoutStore } from "./layout-store";

export type HomeCardId =
  | "quick-capture"
  | "recent"
  | "tasks"
  | "coming-up"
  | "favourites"
  | "views"
  | "writing";

export const HOME_CARD_ORDER: readonly HomeCardId[] = [
  "quick-capture",
  "recent",
  "tasks",
  "coming-up",
  "favourites",
  "views",
  "writing",
];

export const homeLayout = createLayoutStore<HomeCardId>("myne.home-layout", HOME_CARD_ORDER);
