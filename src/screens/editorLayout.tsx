// Editor three-pane layout state — sidebar widths + collapse flags (MYND-137).
//
// Single source of truth for the resizable/collapsible sidebars, held at
// the three-pane seam (consumed by `Editor.tsx`'s `EditorChrome`). Loads
// the persisted layout from the encrypted `vault.prefs` blob on mount
// (after vault unlock — `Editor` mounts iff the slot is Unlocked), clamps
// every read into range (so a tampered/absent value falls back sanely),
// and debounce-persists user changes back. The width-clamp math lives in
// the pure `layoutClamp.ts` module; this hook owns the React + IO wiring.
//
// StrictMode discipline (React 19 double-render):
//   - the load effect is one-shot guarded by `hydratedRef`;
//   - the persist effect only writes after a real user change
//     (`dirtyRef`) and debounces, so the load echo never re-writes and a
//     double-invoked effect clears+resets the same timer (no double write).

import { useCallback, useEffect, useRef, useState } from "react";
import { prefsRead, setEditorLayout, type EditorLayout } from "../lib/prefs";
import {
  clampSidebarWidth,
  clampSidebarWidthForLayout,
  DEFAULT_LEFT_WIDTH,
  DEFAULT_RIGHT_WIDTH,
  LEFT_BOUNDS,
  RIGHT_BOUNDS,
} from "./layoutClamp";

export interface EditorLayoutState {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

export interface EditorLayoutController extends EditorLayoutState {
  /** Set the left sidebar width from a raw (drag/keyboard) value. The
   *  value is clamped into range and, when `containerWidth` is given,
   *  bounded so the center pane keeps its minimum. */
  setLeftWidth: (raw: number, containerWidth?: number) => void;
  /** Set the right sidebar width — symmetric to {@link setLeftWidth}. */
  setRightWidth: (raw: number, containerWidth?: number) => void;
  /** Collapse/expand the left sidebar (independent of the right). Expand
   *  restores the last non-collapsed width (it is never zeroed). */
  toggleLeftCollapsed: () => void;
  /** Collapse/expand the right sidebar (independent of the left). */
  toggleRightCollapsed: () => void;
  /**
   * Whether the persisted layout has been read yet (myne-md/myne#913).
   *
   * **A caller that changes the layout on its own must wait for this.** The
   * initial read REPLACES the whole state when it lands, so anything set before
   * it is silently undone: a collapse written during the first render came back
   * expanded the moment `vault.prefs` answered, and the surface that asked for
   * it had no way to tell. Exposed rather than assumed, because "it is
   * hydrated by now" is exactly the assumption that failed.
   */
  hydrated: boolean;
}

/**
 * Whether entering the agent tab should close the left sidebar (myne-md/myne#913).
 *
 * Pure so the four cases can be asserted without mounting the Editor, which is
 * the largest component in the tree. The cases are the whole rule:
 *
 *  - the agent tab is showing and the workspace is a SINGLE pane: close it. The
 *    agent has its own conversation rail, and two rails side by side ask the
 *    user to pick something twice.
 *  - a SPLIT workspace: leave it. There the note tree is the other pane's
 *    context, and closing it hides the selection being worked from.
 *  - the layout has not hydrated: do nothing. The persisted read REPLACES the
 *    state, so a collapse written before it lands is undone silently.
 *  - already collapsed, or already handled for this entry: do nothing, which is
 *    what lets the user reopen the sidebar without being fought.
 */
export function shouldCollapseForAgentTab(input: {
  agentTabFocused: boolean;
  paneCount: number;
  hydrated: boolean;
  leftCollapsed: boolean;
  handledForEntry: boolean;
}): boolean {
  if (!input.agentTabFocused || input.paneCount !== 1) return false;
  if (!input.hydrated) return false;
  return !input.leftCollapsed && !input.handledForEntry;
}

/** Debounce window for persisting layout changes to `vault.prefs`. Long
 *  enough that a continuous drag coalesces into one write on settle. */
const PERSIST_DEBOUNCE_MS = 400;

const DEFAULT_STATE: EditorLayoutState = {
  leftWidth: DEFAULT_LEFT_WIDTH,
  rightWidth: DEFAULT_RIGHT_WIDTH,
  leftCollapsed: false,
  rightCollapsed: false,
};

export function useEditorLayout(): EditorLayoutController {
  const [state, setState] = useState<EditorLayoutState>(DEFAULT_STATE);
  // Mirror of `hydratedRef` as STATE, because the ref alone cannot wake a
  // consumer's effect. See `EditorLayoutController.hydrated`.
  const [hydrated, setHydrated] = useState(false);

  // `hydratedRef` flips true once the initial prefs read resolves (or
  // fails). `dirtyRef` flips true on the first real user change, gating
  // the persist effect so the load echo never re-writes — keeping an
  // uncustomized vault's `vault.prefs` free of `editor_layout` (the
  // omit-when-unset byte-identity invariant of protocol §9.5.2).
  const hydratedRef = useRef(false);
  const dirtyRef = useRef(false);

  // ---- load (one-shot, StrictMode-guarded) ----
  useEffect(() => {
    if (hydratedRef.current) return;
    let cancelled = false;
    void (async () => {
      try {
        const prefs = await prefsRead();
        const layout = prefs.editor_layout;
        if (!cancelled && layout) {
          setState({
            leftWidth: clampSidebarWidth(layout.left_width, LEFT_BOUNDS, DEFAULT_LEFT_WIDTH),
            rightWidth: clampSidebarWidth(layout.right_width, RIGHT_BOUNDS, DEFAULT_RIGHT_WIDTH),
            leftCollapsed: layout.left_collapsed === true,
            rightCollapsed: layout.right_collapsed === true,
          });
        }
      } catch (err) {
        // Absent / locked / decode-fail collapses to defaults on the Rust
        // side; any thrown error here just leaves the default state.
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[editorLayout] prefs load failed; using defaults:", err);
        }
      } finally {
        if (!cancelled) {
          hydratedRef.current = true;
          setHydrated(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- persist (debounced, only after a real user change) ----
  useEffect(() => {
    if (!hydratedRef.current || !dirtyRef.current) return;
    const payload: EditorLayout = {
      left_width: state.leftWidth,
      right_width: state.rightWidth,
      left_collapsed: state.leftCollapsed,
      right_collapsed: state.rightCollapsed,
    };
    const handle = setTimeout(() => {
      void setEditorLayout(payload).catch((err) => {
        // Disk-write failure: in-memory state stays the source of truth
        // until the next successful write. Non-fatal.
        if (import.meta.env.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[editorLayout] persist failed:", err);
        }
      });
    }, PERSIST_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [state]);

  const setLeftWidth = useCallback((raw: number, containerWidth?: number) => {
    dirtyRef.current = true;
    setState((prev) => ({
      ...prev,
      leftWidth: clampSidebarWidthForLayout(
        raw,
        LEFT_BOUNDS,
        DEFAULT_LEFT_WIDTH,
        containerWidth ?? NaN,
        prev.rightCollapsed ? 0 : prev.rightWidth,
      ),
    }));
  }, []);

  const setRightWidth = useCallback((raw: number, containerWidth?: number) => {
    dirtyRef.current = true;
    setState((prev) => ({
      ...prev,
      rightWidth: clampSidebarWidthForLayout(
        raw,
        RIGHT_BOUNDS,
        DEFAULT_RIGHT_WIDTH,
        containerWidth ?? NaN,
        prev.leftCollapsed ? 0 : prev.leftWidth,
      ),
    }));
  }, []);

  const toggleLeftCollapsed = useCallback(() => {
    dirtyRef.current = true;
    setState((prev) => ({ ...prev, leftCollapsed: !prev.leftCollapsed }));
  }, []);

  const toggleRightCollapsed = useCallback(() => {
    dirtyRef.current = true;
    setState((prev) => ({ ...prev, rightCollapsed: !prev.rightCollapsed }));
  }, []);

  return {
    ...state,
    hydrated,
    setLeftWidth,
    setRightWidth,
    toggleLeftCollapsed,
    toggleRightCollapsed,
  };
}
