// The arranged list, handed to the widgets that edit it (myne-md/myne#1074).
//
// The surface owns the array; a widget that writes its own text (the markdown
// block) or asks to be removed asks HERE, so there is exactly one writer and one
// place where "replace the whole array" happens.

import { createContext, useContext } from "react";
import type { HomeCard } from "../../lib/prefs";

export interface HomeLayoutApi {
  /** The arrangement as drawn, after the AI gate and before any narrowing. */
  cards: readonly HomeCard[];
  /**
   * Apply an operation to the arrangement and persist it.
   *
   * Takes a function rather than a new array so two edits in one tick compose
   * instead of overwriting each other, which is what a drag followed immediately
   * by a resize does.
   */
  patch: (operation: (cards: readonly HomeCard[]) => HomeCard[]) => void;
  /** Merge options into one card. The widget-facing shorthand for a self-edit. */
  setOptions: (id: string, options: Readonly<Record<string, string>>) => void;
}

const NO_LAYOUT: HomeLayoutApi = {
  cards: [],
  patch: () => {},
  setOptions: () => {},
};

export const HomeLayoutContext = createContext<HomeLayoutApi>(NO_LAYOUT);

/** The arrangement, for a widget body or a card header. */
export function useHomeLayout(): HomeLayoutApi {
  return useContext(HomeLayoutContext);
}
