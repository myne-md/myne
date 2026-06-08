// Center-pane view-swap mechanism (MYND-170, SYNC-9).
//
// A reusable in-editor view toggle: the app shell (sidebars, bottom bar,
// command palette) persists while the CENTER pane swaps between the note
// editor and a full-pane surface (today: the attachments library; the
// graph view inherits this same mechanism later). NOT a modal, NOT a new
// Stage — the Editor stays mounted, only the center region changes.
//
// A tiny React context so the left-sidebar nav entry + the command palette
// can request a view without prop-drilling through the whole Editor tree.
// `Editor.tsx` provides it (Editor-local `useState`) and the `<CenterPane>`
// reads `view` to decide what to render.

import { createContext, useContext } from "react";

/** The set of center-pane views. Extend (e.g. `"graph"`) as surfaces land. */
export type CenterView = "editor" | "attachments";

export interface CenterViewContextValue {
  view: CenterView;
  /** Switch the center pane to `view` (idempotent). */
  setView: (view: CenterView) => void;
}

const CenterViewContext = createContext<CenterViewContextValue | null>(null);

export const CenterViewProvider = CenterViewContext.Provider;

/**
 * Read the center-view controls. Returns a no-op fallback when used outside
 * a provider (e.g. an isolated component test) so consumers never crash.
 */
export function useCenterView(): CenterViewContextValue {
  const ctx = useContext(CenterViewContext);
  if (ctx === null) {
    return { view: "editor", setView: () => {} };
  }
  return ctx;
}
