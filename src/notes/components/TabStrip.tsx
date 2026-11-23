// `<TabStrip>` — per-pane editor tab strip (MYND-166, Task 3).
//
// Visual canon: Penpot frame `screen------editor-tabs--strip-states
// (MYND-166 · A)` on page `4 — Desktop UI Kit`. Tokens per
// `colors_and_type.css`:
//  - strip surface = --paper-2, bottom hairline = --line-1, height 38
//    (matches the editor's prior title-row height so the layout is stable).
//  - active tab = --bg-1 (paper) fill + 2px --accent top indicator + NO
//    bottom hairline (reads "flush into the editor below"); ink --fg-1.
//  - inactive tab = --fg-2 ink on the strip surface; hover = --paper-3.
//  - leading file-text icon, or a dirty dot when the tab has unsaved
//    edits; trailing × close (on hover / active); a `+` new-tab control
//    and a `…` overflow menu listing all open tabs.
//
// Overflow is handled two ways at once: the tab row scrolls horizontally
// (`overflow-x: auto`) AND the `…` menu lists every open tab for direct
// switching when the strip is too narrow to show them all.

import {
  dragRegionProps,
  TITLE_BAR_CONTROL_HEIGHT,
  TITLE_BAR_CONTROL_TOP,
  TITLE_BAR_RIGHT_EDGE,
} from "../../screens/titlebar";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import { labelColorVar } from "../decorations";
import { Icon } from "../../components/primitives/Icon";
import {
  HOVER_TRANSITION,
} from "../../components/primitives/hoverSurface";
import { interactiveSurface } from "../../components/primitives/interactiveSurface";
import type { IconName } from "../../lib/icons";
import { TAB_DRAG_MIME, readTabDrag, writeTabDrag } from "../tabDrag";
import { shouldDetachOnDrop } from "../detachDrop";
import { useRovingFocus } from "@myne/editor/host/lib/roving-focus";
import { has } from "../../platform/capabilities";
import { getCurrentWindow } from "../../platform/window";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { ornamentRole } from "@myne/ornaments";
import { MIN_TARGET } from "../../components/primitives/targetSize";
import { useTitleReveal } from "./useTitleReveal";
import { centreScrollLeft, prefersReducedMotion } from "./tabTitleReveal";

/** Strip height (px) — also the editor body's top inset, so the drop overlay
 *  starts below the strip and leaves the tabs interactive during a drag. */
export const STRIP_HEIGHT = 38;


/** Base strip layout. Per-pane: each pane owns its own strip atop its editor
 *  body. A `--line-1` bottom hairline runs the strip width — the editor's top
 *  edge — and the ACTIVE tab BREAKS it: the tab's own side hairlines run down
 *  into the gap, so the tab reads as one continuous surface with the note body
 *  beneath it rather than as a card resting on a closed lid (myne-md/myne#773).
 *
 *  This file used to say, in this comment, that the line does not break under
 *  the tab and that not breaking it was the Obsidian look. It is the opposite:
 *  Obsidian breaks it, and the reason is legibility rather than taste — an
 *  unbroken rule under the active tab draws a closed box around the tab, and a
 *  closed box says "this is a chip", not "this is the thing you are looking
 *  at". The gap is what makes a tab strip read as tabs.
 *
 *  A small top inset gives the tabs breathing room. Fixed height; fills the
 *  pane width. `paddingLeft`/`paddingRight` are overridden per-instance to
 *  clear the corner window controls (insets). */
const STRIP_BASE_PADDING_LEFT = 6;
/** Top inset that gives the tabs breathing room. Named rather than inlined
 *  because the strip's own buttons offset against it to land on the title-bar
 *  row's line (see {@link TITLE_BAR_CONTROL_TOP}). */
const STRIP_PADDING_TOP = 5;
const stripStyle: CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  flexShrink: 0,
  gap: 2,
  paddingInlineStart: STRIP_BASE_PADDING_LEFT,
  paddingTop: STRIP_PADDING_TOP,
  height: STRIP_HEIGHT,
  background: "var(--paper-2)",
  borderBottom: "1px solid var(--line-1)",
  position: "relative",
};

/**
 * Whether a horizontally scrolling row has content off either edge.
 *
 * **A local hook rather than `useScrollEdges`** (myne-md/myne#913): that one is
 * vertical by contract (`top`/`bottom`, and a mask whose gradient runs down the
 * block axis), and the strip needs the inline axis. Generalising it would touch
 * five adopters whose measurement is not the same question. The measurement
 * here is three integers read on scroll, the same shape the vertical one uses.
 */
function useStripOverflow<T extends HTMLElement>(): {
  ref: (node: T | null) => void;
  left: boolean;
  right: boolean;
} {
  const [edges, setEdges] = useState({ left: false, right: false });
  const nodeRef = useRef<T | null>(null);
  const measure = useCallback(() => {
    const el = nodeRef.current;
    if (el === null) return;
    const next = {
      left: el.scrollLeft > 1,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
    };
    setEdges((prev) =>
      prev.left === next.left && prev.right === next.right ? prev : next,
    );
  }, []);
  const ref = useCallback(
    (node: T | null) => {
      nodeRef.current = node;
      if (node === null) return;
      node.addEventListener("scroll", measure, { passive: true });
      // Feature-detected, the `useScrollEdges` discipline: jsdom has no
      // `ResizeObserver`, and an unguarded construction there takes the screen
      // down during render. The fade is a nicety; the strip is not.
      const ro =
        typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
      ro?.observe(node);
      measure();
      return () => {
        node.removeEventListener("scroll", measure);
        ro?.disconnect();
      };
    },
    [measure],
  );
  return { ref, ...edges };
}

const scrollAreaStyle: CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  gap: 2,
  // Content-sized: doesn't grow (the draggable filler eats the slack), but
  // shrinks + scrolls once the tabs can't fit even after ellipsizing.
  flex: "0 1 auto",
  minWidth: 0,
  overflowX: "auto",
  overflowY: "hidden",
  // One pixel of room BELOW the tabs, inside this box's clip. The active tab
  // hangs 1px past its row to paint over the strip's bottom rule (see the tab
  // style), and `overflow-x: auto` forces `overflow-y` to clip as well — so
  // without this the hang was cut off at this element's padding edge and the
  // rule ran straight under the active tab. Padding extends the clip region;
  // the equal negative margin keeps the strip's own height unchanged.
  paddingBottom: "var(--hairline)",
  marginBottom: "calc(var(--hairline) * -1)",
};

/** Height of the small strip buttons (+ / overflow). Matched to the floated
 *  title-bar controls they sit beside, rather than centred in the strip, which
 *  is what put them two pixels low. */
const STRIP_BUTTON_HEIGHT = TITLE_BAR_CONTROL_HEIGHT;

const TITLE_MAX = 160;
/** The narrowest a tab may get before the row scrolls instead (myne-md/myne#913).
 *  Sized from the label: a 16px icon, the 6px gap, the close control's hit area,
 *  and roughly a dozen characters of the title. Below this a tab stops naming
 *  anything, which is what the strip looked like before the row could scroll. */
const TAB_MIN_WIDTH = 132;

/**
 * Stable DOM id for a tab element (myne#728). The pane body carries
 * `role="tabpanel"` and names itself after the ACTIVE tab through
 * `aria-labelledby`, so the tab and the panel must agree on one id without
 * either owning the other. Scoped by pane, because the same note can be open
 * in two panes at once and an id is document-unique.
 *
 * `paneId` is a uuid and a tab handle is an `itemKey` (`note:<uuid>` and
 * friends), so both are already id-safe; the colon is legal in an HTML5 id and
 * is only kept out of CSS selectors, which nothing here uses.
 */
export function tabDomId(paneId: string, tabId: string): string {
  return `tab-${paneId}-${tabId}`;
}

export type TabStripProps = {
  /** The pane this strip belongs to (carried in drag payloads). */
  paneId: string;
  /** Opaque per-tab handles (workspace `itemKey`s, MYND-274) — a note or a
   *  view tab; this component treats them as strings and never parses them. */
  tabs: readonly string[];
  activeTab: string | null;
  /** Display title for a tab handle; `null` → rendered as italic "Untitled". */
  titleOf: (id: string) => string | null;
  /** Colour-label slot for a tab, or `undefined` for an uncoloured item
   *  (MYND-627). Tints the tab's icon, matching how the sidebar shows the same
   *  colour — a note you marked stays recognisable once it is open, which was
   *  the point of colouring it. */
  colorOf?: (id: string) => string | undefined;
  /** Leading icon for a tab handle (note vs view, MYND-274). Default file-text. */
  iconOf?: (id: string) => IconName;
  /** Whether a tab handle is PINNED (tab-modes / MYND-320): a pinned tab shows a
   *  pin affordance, hides its × close, and offers Unpin in its right-click
   *  menu. Absent ⇒ no tab pinned. */
  isPinned?: (id: string) => boolean;
  /** Toggle a tab's pinned state — wired from the tab right-click menu
   *  (tab-modes / MYND-320). Absent ⇒ the Pin/Unpin item is not offered. */
  onTogglePin?: (id: string) => void;
  /** Render the tabs as a STACKED deck (horizontally-scrolling, partially-
   *  overlapping) instead of the normal strip (tab-modes / MYND-319). */
  stacked?: boolean;
  /** Whether the ACTIVE tab currently has unsaved edits (drives its dot). */
  activeDirty?: boolean;
  /** A transient empty "New tab" is open (the chooser). Renders an active
   *  pseudo-tab after the real tabs; the real tabs render inactive. */
  pendingNewTab?: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: () => void;
  /** Close the transient "New tab" (return to the previously-active tab). */
  onCloseNewTab?: () => void;
  /** Drop handler — `fromPaneId` is the drag source (`null` when the drag
   *  came from the sidebar), `toIndex` the insert slot in THIS strip.
   *  Reorder (same pane), move (cross pane), or open (sidebar-origin). */
  onMoveTab: (fromPaneId: string | null, tabId: string, toIndex: number) => void;
  /** Extra left padding (px) when this strip sits at the window's top-left
   *  corner with no left sidebar — clears the traffic lights + left toggle. */
  insetLeft?: number;
  /** Extra right padding (px) when this strip sits at the window's top-right
   *  corner with no right sidebar — clears the right sidebar toggle. */
  insetRight?: number;
  /** DOM id of the `role="tabpanel"` this strip's tabs control (myne#728).
   *  Optional because the strip renders standalone in tests and in the
   *  title-bar-alignment harness, where there is no panel to point at and a
   *  dangling `aria-controls` would name an element that does not exist. */
  panelId?: string;
  /** Drag a tab OUT of the window to pop the note into its own OS window
   *  (myne#678 / #681, SYNC-6). The workspace owns the MOVE (spawn the pop-out
   *  and close this tab); the strip only reports the gesture. A dragged tab is
   *  by definition a live main-window tab, so this is always a fresh spawn.
   *  Absent off desktop, where the strip never fires it (`has("detachedWindows")`). */
  onDetachNote?: (noteId: string) => void;
};

export function TabStrip({
  paneId,
  tabs,
  activeTab,
  titleOf,
  colorOf,
  iconOf,
  isPinned,
  onTogglePin,
  stacked = false,
  activeDirty = false,
  pendingNewTab = false,
  onActivate,
  onClose,
  onNewTab,
  onCloseNewTab,
  onMoveTab,
  insetLeft = 0,
  insetRight = 0,
  onDetachNote,
  panelId,
}: TabStripProps) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  // Right-click tab context menu (tab-modes / MYND-320): { tab key, click pos }.
  const [tabMenu, setTabMenu] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );

  // Drag landing indicator (myne-md/myne#908 item 5). The strip had a drop
  // handler and no visible target, so a wrong drop could only be discovered by
  // its result. `dropLeft` is the seam, measured against the strip so it can be
  // drawn absolutely; `null` means "not dragging over this strip".
  const stripRef = useRef<HTMLDivElement | null>(null);
  // **The row scrolls, and says so** (myne-md/myne#913). The tabs used to shrink
  // until the titles were unreadable and then scroll with no signal that anything
  // was off-screen; the mask fades whichever edge still has content beyond it,
  // and nothing when the row fits. That is the browser convention, and the reason
  // it is a convention is that it is the only affordance a scrollbar-less row
  // has.
  const stripOverflow = useStripOverflow<HTMLDivElement>();
  // The same node, for the centring below. `stripOverflow` measures edges; this
  // one scrolls, and keeping them separate means neither hook grows a second job.
  const scrollRowRef = useRef<HTMLDivElement | null>(null);
  const [dropLeft, setDropLeft] = useState<number | null>(null);
  /**
   * **The active tab is centred whenever it changes** (myne-md/myne#913, on the
   * report that the strip left the open note half off-screen after a switch).
   *
   * Every navigation lands here: opening a note, a pane switch, a restored
   * session, the agent tab. Centring rather than `scrollIntoView({inline:
   * "nearest"})` because "nearest" is satisfied by a tab already visible at the
   * very edge, which is exactly the case that reads as "where did my note go".
   * Clamped by the browser at both ends, so the first and last tabs do not
   * scroll past their own edge into blank space.
   */
  useEffect(() => {
    const row = scrollRowRef.current;
    if (row === null || activeTab === null) return;
    const tab = Array.from(
      row.querySelectorAll<HTMLElement>('[role="tab"][data-tab-id]'),
    ).find((el) => el.getAttribute("data-tab-id") === activeTab);
    if (tab === undefined) return;
    // jsdom has no layout and no `scrollTo`; a real host has both.
    if (typeof row.scrollTo !== "function") return;
    row.scrollTo({
      left: centreScrollLeft(tab.offsetLeft, tab.offsetWidth, row.clientWidth),
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [activeTab, tabs.join("\u0000")]);
  // Pre-drag rects for the FLIP pass. Captured on dragstart because by the time
  // the drop lands, the old layout is gone.
  const flipRectsRef = useRef<Map<string, DOMRect> | null>(null);
  const tabsKey = tabs.join("\u0000");
  const prevTabsKeyRef = useRef(tabsKey);

  // The strip is one Tab stop (myne#728): arrow keys move between tabs and
  // activate them (automatic activation, the WAI-ARIA tablist convention), so a
  // pane with a dozen open notes costs one stop instead of a dozen. Focus is
  // moved by the primitive; the active tab follows it.
  const activeIndex = activeTab === null ? -1 : tabs.indexOf(activeTab);
  const roving = useRovingFocus({
    count: tabs.length,
    activeIndex,
    orientation: "horizontal",
    itemSelector: '[role="tab"][data-tab-id]',
    // Arrows move focus; Enter/Space activates (`handleTabKeyDown`), so no
    // `onActiveIndexChange`: under manual activation the hook never calls it.
    manualActivation: true,
  });

  /** Snapshot the tab rects for the FLIP pass. Called on dragstart, because by
   *  the time the order changes the old layout is gone. Without this the FLIP
   *  block below had nothing to measure from and was dead code (a review caught
   *  it): the ref it reads was only ever written as `null`. */
  const captureDragRects = () => {
    const strip = stripRef.current;
    if (strip === null) return;
    const map = new Map<string, DOMRect>();
    for (const el of Array.from(
      strip.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"][data-tab-id]'),
    )) {
      const id = el.getAttribute("data-tab-id");
      if (id !== null) map.set(id, el.getBoundingClientRect());
    }
    flipRectsRef.current = map;
  };

  /** Where the seam sits, in strip coordinates: the midpoint rule the drop
   *  handler already uses, so the line and the landing agree by construction. */
  const seamLeftFor = (clientX: number): number | null => {
    const strip = stripRef.current;
    if (strip === null) return null;
    const stripRect = strip.getBoundingClientRect();
    const els = Array.from(
      strip.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"][data-tab-id]'),
    );
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (clientX < r.left + r.width / 2) return r.left - stripRect.left;
    }
    const last = els[els.length - 1];
    return last === undefined
      ? null
      : last.getBoundingClientRect().right - stripRect.left;
  };

  const handleDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(TAB_DRAG_MIME)) return;
    e.preventDefault();
    setDropLeft(seamLeftFor(e.clientX));
  };

  const handleDragLeave = (e: ReactDragEvent<HTMLDivElement>) => {
    // `relatedTarget` inside the strip is a move between its own children, not
    // a leave: clearing then would blink the seam on every tab crossed.
    const next = e.relatedTarget as Node | null;
    if (next !== null && e.currentTarget.contains(next)) return;
    setDropLeft(null);
  };

  // FLIP: after the order changes, move each tab from where it WAS to where it
  // now is. Reduced motion skips the animation and leaves the final layout,
  // which is the same end state without movement.
  useEffect(() => {
    if (prevTabsKeyRef.current === tabsKey) return;
    prevTabsKeyRef.current = tabsKey;
    const before = flipRectsRef.current;
    flipRectsRef.current = null;
    const strip = stripRef.current;
    if (before === null || strip === null || prefersReducedMotion()) return;
    const els = Array.from(
      strip.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"][data-tab-id]'),
    );
    for (const el of els) {
      const id = el.getAttribute("data-tab-id");
      const was = id === null ? undefined : before.get(id);
      if (was === undefined) continue;
      const now = el.getBoundingClientRect();
      const dx = was.left - now.left;
      if (Math.abs(dx) < 1 || typeof el.animate !== "function") continue;
      el.animate(
        [{ transform: `translateX(${dx}px)` }, { transform: "translateX(0)" }],
        { duration: 150, easing: "ease-out" },
      );
    }
  }, [tabsKey]);

  const handleDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setDropLeft(null);
    const parsed = readTabDrag(e.dataTransfer);
    if (parsed === null) return;
    const tabEls = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"][data-tab-id]'),
    );
    let toIndex = tabEls.length;
    for (let i = 0; i < tabEls.length; i++) {
      const r = tabEls[i]!.getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) {
        toIndex = i;
        break;
      }
    }
    // Same-pane rightward move: the source is removed before re-insert, so
    // shift the target left by one to land where the cursor points.
    if (parsed.fromPaneId === paneId) {
      const orig = tabEls.findIndex(
        (el) => el.getAttribute("data-tab-id") === parsed.tabId,
      );
      if (orig >= 0 && orig < toIndex) toIndex -= 1;
    }
    onMoveTab(parsed.fromPaneId, parsed.tabId, toIndex);
  };

  // **The cleanup the overflow hook returns must survive the wrapper** (review
  // round seven). An inline arrow ref changed identity on every render, so React
  // called it with `null` and then with the node each time; the hook returns
  // early on `null` before any teardown, and a NEW `ResizeObserver` was built for
  // the live node while the previous one stayed attached: an unbounded leak of
  // observers and listeners for the life of the session, on a component rendered
  // per pane and re-rendered on every save-status and cursor change. A stable
  // callback that RETURNS the cleanup is what lets React call it.
  const attachRow = useCallback(
    (node: HTMLDivElement | null) => {
      // Three refs on one node: the roving-focus hook owns the tablist, the
      // overflow measurement reads its edges, and the centring scrolls it.
      (roving.containerRef as { current: HTMLDivElement | null }).current = node;
      scrollRowRef.current = node;
      return stripOverflow.ref(node);
    },
    [roving.containerRef, stripOverflow.ref],
  );

  return (
    <div
      // The tab strip is CHROME for ornament purposes (myne#394). Ornament here
      // is paint only, so a themed strip's tab hit areas are exactly where an
      // unthemed one's were — the property task 14 measures.
      {...ornamentRole("chrome")}
      // The key here is this element's own padding, which is the leading gap between
      // the back/forward cluster and the first tab: a drag starts only from a node
      // carrying the attribute, so tabs and the `+` are unaffected
      // (myne-md/myne#1108). Unconditional, like the trailing filler.
      {...dragRegionProps()}
      style={{
        ...stripStyle,
        paddingInlineStart: STRIP_BASE_PADDING_LEFT + insetLeft,
        // Never flush against the edge. `insetRight` clears the floated
        // right-side controls when the right sidebar is collapsed (and already
        // includes their edge offset); when it is 0 the strip's own caret is the
        // last control on the row, and it takes the same edge offset the
        // right-sidebar toggle uses so the two land on one line.
        paddingInlineEnd: insetRight > 0 ? insetRight : TITLE_BAR_RIGHT_EDGE,
        // The insets clear the floated window controls (traffic lights /
        // sidebar toggles / back-forward nav) when a side has no sidebar, so
        // they flip with the sidebar's collapsed state. Transition them on the
        // SAME curve as the sidebar's width collapse (SidebarPane) so the tab
        // strip glides in sync instead of snapping the first tab across the
        // floated controls for a frame. Reduced-motion zeroes this globally.
        transition:
          "padding-left var(--duration-base) var(--ease-standard), padding-right var(--duration-base) var(--ease-standard)",
      }}
      ref={stripRef}
      data-editor-chrome
      data-testid="editor.tab-strip"
      data-pane-id={paneId}
      data-stacked={stacked}
      // Whole strip is a drop target (reorder / move / open) — dropping in the
      // empty trailing space appends, dropping among the tabs inserts.
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dropLeft === null ? null : (
        <span
          aria-hidden="true"
          data-testid="editor.tab-drop-seam"
          style={{
            position: "absolute",
            top: 6,
            bottom: 6,
            left: dropLeft,
            width: 2,
            background: "var(--accent)",
            borderRadius: "var(--radius-1, 4px)",
            pointerEvents: "none",
          }}
        />
      )}
      <div
        // The row IS the tablist, and it holds ONLY tabs (the open notes plus
        // the transient new-tab chip). The `+` and `…` controls live outside
        // it: a tablist may own nothing but tabs, and a focusable sibling
        // button is what axe's `aria-required-children` reported here
        // (myne#728).
        role="tablist"
        aria-label={t("notes.tabStrip.openNotes")}
        ref={attachRow}
        onKeyDown={roving.onKeyDown}
        // The fade is a MASK, not a gradient overlay, for the reason
        // `useScrollEdges` gives: an overlay has to be painted in the strip's own
        // colour, which is wrong the moment a theme changes it and wrong over a
        // hovered tab. The gradient lives in `src/styles/tokens.css` with the
        // vertical one, so its stops stay unreachable to a theme.
        className="myne-tabstrip-fade"
        data-fade-left={stripOverflow.left ? "true" : "false"}
        data-fade-right={stripOverflow.right ? "true" : "false"}
        style={
          stacked
            ? // Stacked deck (tab-modes / MYND-319): tabs overlap (negative
              // gap) and the row scrolls horizontally. Functional layout —
              // visual polish deferred to a later slice.
              { ...scrollAreaStyle, gap: 0, paddingInlineStart: 14 }
            : scrollAreaStyle
        }
        data-testid={stacked ? "editor.tab-deck" : undefined}
      >
        {tabs.map((id, i) => (
          <Tab
            key={id}
            id={id}
            paneId={paneId}
            title={titleOf(id)}
            colorSlot={colorOf?.(id)}
            icon={iconOf?.(id) ?? "file-text"}
            active={id === activeTab}
            dirty={id === activeTab && activeDirty}
            pinned={isPinned?.(id) ?? false}
            stacked={stacked}
            stackIndex={i}
            tabIndex={roving.tabIndexFor(i)}
            panelId={panelId}
            onActivate={onActivate}
            onClose={onClose}
            onContextMenu={
              onTogglePin
                ? (x, y) => setTabMenu({ id, x, y })
                : undefined
            }
            onDetachNote={onDetachNote}
            onDragStartSnapshot={captureDragRects}
          />
        ))}
        {pendingNewTab && <NewTabChip onClose={onCloseNewTab} />}
      </div>

      {/* Outside the tablist on purpose (myne#728): a tablist owns only tabs.
          The row is content-sized (`flex: 0 1 auto`) with a draggable filler
          after it, so the + still reads as trailing the tabs. */}
      <StripButton label={t("notes.tabStrip.newTab")} onClick={onNewTab}>
        <Icon name="plus" size={14} />
      </StripButton>

      {/* The empty trailing expanse doubles as the window-drag handle (the
          strip sits on the OS title-bar row for a top pane), Obsidian-style. */}
      <div {...dragRegionProps()} style={{ flex: "1 1 auto", minWidth: 16 }} />

      {tabs.length > 0 && (
        <StripButton
          label={t("notes.tabStrip.openNotes")}
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
        >
          {/* Caret that flips 180° when the tab list is open (animated). */}
          <span
            style={{
              display: "flex",
              transform: menuOpen ? "rotate(180deg)" : "rotate(0deg)",
              transition: "transform var(--duration-base) var(--ease-standard)",
            }}
          >
            <Icon name="chevron-down" size={14} />
          </span>
        </StripButton>
      )}

      {menuOpen && tabs.length > 0 && (
        <OverflowMenu
          tabs={tabs}
          activeTab={activeTab}
          titleOf={titleOf}
          onPick={(id) => {
            setMenuOpen(false);
            onActivate(id);
          }}
          onClose={() => setMenuOpen(false)}
        />
      )}

      {/* Tab right-click context menu (tab-modes / MYND-320): Pin / Unpin
          (reuses the shared ContextMenu, like the sidebar + card menus). */}
      {tabMenu !== null && onTogglePin && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          items={tabMenuItems(
            tabMenu.id,
            isPinned?.(tabMenu.id) ?? false,
            onTogglePin,
            tabs.indexOf(tabMenu.id),
            tabs.length,
            (toIndex) => onMoveTab(paneId, tabMenu.id, toIndex),
            onClose,
          )}
          onClose={() => setTabMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * The tab right-click menu's items: the Pin/Unpin toggle (tab-modes /
 * MYND-320) and the non-drag reorder (myne-md/myne#728, task 12; WCAG 2.5.7).
 *
 * Reordering a tab was a DRAG and nothing else, which means a user who cannot
 * drag could not do it at all. The menu is the alternative, and it is reachable
 * from the keyboard because the strip's tabs are focusable (the roving tabindex
 * from task 3) and Shift+F10 / the context-menu key open this menu on the
 * focused one.
 *
 * `index` is the tab's current slot and `move` takes the target slot in
 * POST-REMOVAL terms, which is the same contract the drop handler uses: it
 * removes the tab before re-inserting, so a rightward move of one place is
 * `index + 1` rather than `index + 2`. Getting that wrong moves the tab two
 * places to the right and looks like a different bug entirely.
 *
 * An end tab is offered only the direction it can go, rather than a disabled
 * row: there is nothing to explain about why the first tab cannot move left.
 */
function tabMenuItems(
  id: string,
  pinned: boolean,
  onTogglePin: (id: string) => void,
  index: number,
  count: number,
  move: (toIndex: number) => void,
  close: (id: string) => void,
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      id: pinned ? "tab.unpin" : "tab.pin",
      label: pinned ? i18n.t("notes.tabStrip.unpin") : i18n.t("notes.tabStrip.pin"),
      onSelect: () => onTogglePin(id),
    },
  ];
  if (index > 0) {
    items.push({
      id: "tab.move-left",
      label: i18n.t("notes.tabStrip.moveLeft"),
      onSelect: () => move(index - 1),
    });
  }
  if (index >= 0 && index < count - 1) {
    items.push({
      id: "tab.move-right",
      label: i18n.t("notes.tabStrip.moveRight"),
      onSelect: () => move(index + 1),
    });
  }
  // Close. This menu is one of the THREE keyboard paths the per-tab x's
  // demotion to an `aria-hidden` mouse affordance rests on, and for one
  // review round it was not one: the comment at the x, the axe baseline
  // deletion's header and `design-notes/ui/0599` all named "the tab's
  // context menu" while this function built Pin, Move left and Move right
  // and nothing else. A justification for removing an accessible control
  // that names a path which does not exist is worse than no justification,
  // because it reads as checked. Absent for a PINNED tab, which is the same
  // rule the x itself follows (`!pinned`): unpin first, deliberately.
  if (!pinned) {
    items.push({
      id: "tab.close",
      label: i18n.t("common.closetab"),
      onSelect: () => close(id),
    });
  }
  return items;
}

function tabLabel(title: string | null): { text: string; italic: boolean } {
  if (title === null || title.trim() === "") {
    return { text: i18n.t("common.untitled"), italic: true };
  }
  return { text: title, italic: false };
}

type TabProps = {
  id: string;
  paneId: string;
  title: string | null;
  icon: IconName;
  /** Colour-label slot; tints the icon (MYND-627). */
  colorSlot?: string;
  active: boolean;
  dirty: boolean;
  /** Pinned (tab-modes / MYND-320): pin affordance shown, × close-guarded. */
  pinned: boolean;
  /** Whether the pane is in stacked-deck layout (tab-modes / MYND-319). */
  stacked: boolean;
  /** Position in the strip — drives the stacked overlap offset. */
  stackIndex: number;
  /** Roving tabindex from the strip's primitive (myne#728): 0 for the active
   *  tab, -1 for the rest, so the whole strip is one Tab stop. */
  tabIndex: 0 | -1;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  /** DOM id of the pane's `role="tabpanel"`, when the strip has one. */
  panelId?: string;
  /** Right-click (tab-modes / MYND-320): open the Pin/Unpin menu at the cursor. */
  onContextMenu?: (x: number, y: number) => void;
  /** Drag this tab OUT of the window to pop its note out (myne#678/#681, SYNC-6);
   *  the workspace opens the pop-out and closes this tab. Absent off desktop. */
  onDetachNote?: (noteId: string) => void;
  /** Snapshot every tab's rect BEFORE the drag moves anything, so the strip can
   *  run its FLIP pass once the order changes (myne-md/myne#908 item 5). */
  onDragStartSnapshot?: () => void;
};

function Tab({
  id,
  paneId,
  title,
  icon,
  colorSlot,
  active,
  dirty,
  pinned,
  stacked,
  stackIndex,
  tabIndex,
  panelId,
  onActivate,
  onClose,
  onContextMenu,
  onDetachNote,
  onDragStartSnapshot,
}: TabProps) {
  const { t } = useTranslation();
  const [hovering, setHovering] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  // True while the focus about to arrive came from the pointer. A click focuses
  // the tab too, and the reveal is meant for a reader who is LOOKING at a title,
  // not for the tab they just selected.
  const pointerFocusRef = useRef(false);
  const { text, italic } = tabLabel(title);
  // In-place reveal (myne-md/myne#908 item 6), shared with the sidebar rows.
  // HOVER ONLY, plus a keyboard focus that the pointer did not cause: clicking a
  // tab focuses it, and an active tab that keeps scrolling its own title is
  // exactly the "tiring" case this avoids.
  const revealed = hovering || keyboardFocus;
  const { boxRef: labelBoxRef, textRef: labelTextRef } = useTitleReveal(revealed, text);
  // A pinned tab is close-protected — its × is hidden (unpin to close).
  const showClose = !pinned && (hovering || active);

  const handleDragStart = (e: ReactDragEvent<HTMLDivElement>) => {
    // BEFORE anything moves: the FLIP pass needs the geometry the drop will
    // destroy.
    onDragStartSnapshot?.();
    writeTabDrag(e.dataTransfer, { tabId: id, fromPaneId: paneId });
    e.dataTransfer.effectAllowed = "move";
    // A translucent ghost of the tab under the pointer (myne-md/myne#908 item
    // 5): the browser's default drag image is a snapshot at full opacity, which
    // reads as "the tab is still there". The clone goes off-screen only long
    // enough for the platform to take it, then is removed. `setDragImage` is
    // absent in jsdom, which is why this is guarded rather than assumed.
    if (typeof e.dataTransfer.setDragImage !== "function") return;
    // A built ghost, NOT a clone of the tab. The clone carried the tab's flex
    // rules into a fixed-position box, where `flex: 1 1 auto` had no row to
    // shrink against and it grew to a strip-wide rectangle (measured in the
    // app: a translucent band across the pane instead of a small tab). Its own
    // explicit width and height is the only shape that stays predictable.
    const rect = e.currentTarget.getBoundingClientRect();
    const ghost = document.createElement("div");
    ghost.textContent = text;
    ghost.style.cssText = [
      "position:fixed",
      "top:-10000px",
      "left:-10000px",
      `width:${rect.width}px`,
      `height:${rect.height}px`,
      "display:flex",
      "align-items:center",
      "box-sizing:border-box",
      "padding:0 10px",
      "overflow:hidden",
      "white-space:nowrap",
      "text-overflow:ellipsis",
      "background:var(--bg-2)",
      "border:1px solid var(--line-1)",
      "border-radius:var(--radius-1, 4px)",
      "font-family:var(--font-sans)",
      "font-size:var(--text-xs)",
      "color:var(--fg-2)",
      "opacity:0.85",
      "pointer-events:none",
    ].join(";");
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, rect.width / 2, rect.height / 2);
    setTimeout(() => ghost.remove(), 0);
  };

  // Drag-tab-out (myne#173): a tab dropped OUTSIDE the window (no valid drop
  // target AND the pointer past the window bounds) detaches its note into its
  // own OS window. Desktop-only. The detach DECISION is unit-tested in
  // `src/notes/detachDrop.ts`; the drop-outside GESTURE is E2E/manual (headless
  // drag-and-drop cannot leave the window). Views never detach, only notes.
  const handleDragEnd = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!has("detachedWindows")) return;
    if (e.dataTransfer.dropEffect !== "none") return;
    if (!id.startsWith("note:")) return;
    const noteId = id.slice("note:".length);
    const pointer =
      e.screenX !== 0 || e.screenY !== 0 ? { x: e.screenX, y: e.screenY } : null;
    void (async () => {
      const win = getCurrentWindow();
      const [pos, size, scale] = await Promise.all([
        win.outerPosition(),
        win.outerSize(),
        win.scaleFactor(),
      ]);
      const bounds = {
        x: pos.x / scale,
        y: pos.y / scale,
        width: size.width / scale,
        height: size.height / scale,
      };
      if (shouldDetachOnDrop("none", pointer, bounds)) {
        // MOVE, not copy (SYNC-6): the workspace opens the pop-out AND closes
        // this tab, so the note is never a live tab and a live pop-out at once.
        onDetachNote?.(noteId);
      }
    })().catch(() => {});
  };

  // Obsidian-style tabs: the active tab is a rounded-top card with a top/side
  // hairline, and it BREAKS the strip's bottom line — it hangs 1px past the
  // strip's content box and paints that last pixel in its own fill, so the rule
  // stops at one side hairline and resumes at the other. That is what joins the
  // tab to the note body under it. Inactive tabs recede —
  // transparent, dimmed `--fg-3`, lower opacity, no border. Tabs shrink
  // (ellipsizing their title) as the pane narrows, then the row scrolls once
  // they hit their content floor.
  const style: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: "100%",
    padding: "0 6px 0 10px",
    maxWidth: TITLE_MAX + 56,
    // **Every tab stays readable, and the row scrolls instead** (myne-md/myne#913,
    // two reports in a row: first the active tab squeezed to "Ag", then the
    // inactive ones squeezing to an icon). Shrinking is what produced both: a
    // strip that ellipsizes to fit can always be made to fit, and the titles are
    // the only thing that pays. The floor is a readable label (icon + a dozen
    // characters + the close control) and the ceiling is the title cap, so a tab
    // is sized by its own name and an overflowing strip scrolls with the fade at
    // the edge saying so.
    //
    // `max-content` for the active tab rather than a measured width: the browser
    // already knows the label's width and a measurement here would have to be
    // redone on every rename.
    minWidth: active ? "max-content" : TAB_MIN_WIDTH,
    flexShrink: stacked ? 0 : 0,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8,
    // In a stacked deck every card carries a full hairline (the cards overlap,
    // so a transparent border would let the underlying card bleed through);
    // in the normal strip only the active tab is bordered.
    borderTop:
      active || stacked ? "1px solid var(--line-1)" : "1px solid transparent",
    borderInlineStart:
      active || stacked ? "1px solid var(--line-1)" : "1px solid transparent",
    borderInlineEnd:
      active || stacked ? "1px solid var(--line-1)" : "1px solid transparent",
    // The gap in the strip's rule. `marginBottom: -1` hangs the tab one pixel
    // past the strip's content box — which is exactly where the strip paints
    // its `border-bottom` — and the bottom border repaints that pixel in the
    // tab's own fill. A child paints after its parent's background AND border,
    // so no z-index is needed; the order is the cascade's, not ours.
    //
    // Only the ACTIVE tab does this. An inactive tab is transparent, so a
    // transparent bottom border there would erase nothing and a filled one
    // would punch a hole in the rule under a tab that is not open.
    //
    // The overhang is a HEIGHT, not a negative margin. The app sets
    // `box-sizing: border-box` globally (`src/styles/tokens.css`), so
    // `height: 100%` already contains the tab's own bottom border, and that
    // border landed one pixel ABOVE the strip's rule. A negative bottom margin
    // does not move a flex item with an explicit height, so the earlier
    // `marginBottom: -1` never reached the rule at all. The tab is one pixel
    // taller instead, and the scrolling row leaves room for that pixel inside
    // its clip (`scrollAreaStyle`). Measured, not reasoned: a probe page with
    // these exact styles under border-box showed the rule through the tab in
    // WebKit until both halves were in.
    ...(active
      ? { height: "calc(100% + 1px)", borderBottom: "1px solid var(--bg-1)" }
      : null),
    background: active
      ? "var(--bg-1)"
      : stacked
        ? "var(--bg-2)"
        : hovering
          ? "var(--paper-3)"
          : "transparent",
    color: active ? "var(--fg-1)" : stacked ? "var(--fg-2)" : "var(--fg-3)",
    // Stacked cards OVERLAP, so a sub-1 opacity would let the card beneath bleed
    // through (the muddy look). Keep stacked cards fully opaque and convey depth
    // with z-order + a left-edge shadow instead.
    opacity: stacked || active || hovering ? 1 : 0.72,
    cursor: "pointer",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
    // Stacked deck (tab-modes / MYND-319): cards partially overlap and each casts
    // a soft shadow onto the card behind it, so the row reads as a front-to-back
    // deck; the active/hovered card lifts above the rest. Functional layout.
    ...(stacked
      ? {
          marginInlineStart: stackIndex === 0 ? 0 : -16,
          zIndex: active ? 200 : hovering ? 100 : stackIndex + 1,
          position: "relative",
          boxShadow:
            stackIndex === 0
              ? "none"
              : active
                ? "-5px 0 9px rgba(0, 0, 0, 0.24)"
                : "-3px 0 6px rgba(0, 0, 0, 0.13)",
        }
      : {}),
  };

  // Middle-click closes the tab (browser-tab idiom) — but a pinned tab is
  // close-protected (unpin first), so middle-click is inert on it.
  const handleAux = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.button === 1) {
      e.preventDefault();
      if (!pinned) onClose(id);
    }
  };

  // Keyboard close for the focused tab (myne#728). The × is a mouse affordance
  // and is deliberately not a Tab stop (see the button below); Delete/Backspace
  // on the tab is the per-tab keyboard path, and `pane.close-tab` (Mod-W) is the
  // global one.
  const handleTabKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((e.key === "Delete" || e.key === "Backspace") && !pinned) {
      e.preventDefault();
      onClose(id);
      return;
    }
    // MANUAL activation (myne#728, review). The strip's arrows move focus
    // only; this is what selects. Automatic activation would re-point the
    // editor body and persist workspace state once per tab passed over, so
    // arrowing from the first tab to the eighth did that seven times on the
    // way. The tablist pattern sanctions manual activation exactly where
    // switching is expensive.
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onActivate(id);
    }
  };

  return (
    <div
      role="tab"
      id={tabDomId(paneId, id)}
      aria-selected={active}
      aria-controls={active ? panelId : undefined}
      tabIndex={tabIndex}
      data-testid="editor.tab"
      data-tab-id={id}
      data-active={active}
      data-pinned={pinned}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      style={style}
      onClick={() => onActivate(id)}
      onAuxClick={handleAux}
      onKeyDown={(e) => {
        // Keyboard focus from here on is a reader navigating, not a click that
        // happens to focus the tab.
        pointerFocusRef.current = false;
        handleTabKeyDown(e);
      }}
      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              onContextMenu(e.clientX, e.clientY);
            }
          : undefined
      }
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onMouseDown={() => {
        pointerFocusRef.current = true;
      }}
      onFocus={() => setKeyboardFocus(!pointerFocusRef.current)}
      onBlur={() => {
        pointerFocusRef.current = false;
        setKeyboardFocus(false);
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "flex",
          width: 14,
          flexShrink: 0,
          justifyContent: "center",
          color: dirty ? "var(--accent)" : "var(--fg-3)",
        }}
      >
        {dirty ? (
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "var(--radius-pill)",
              background: "var(--accent)",
            }}
          />
        ) : (
          <Icon
            name={icon}
            size={13}
            style={colorSlot ? { color: labelColorVar(colorSlot) } : undefined}
          />
        )}
      </span>
      <span
        ref={labelBoxRef}
        data-testid="editor.tab-label"
        style={{
          flex: "1 1 auto",
          minWidth: 0,
          maxWidth: TITLE_MAX,
          overflow: "hidden",
          // The ellipsis stays for the resting state and is dropped only while
          // the reveal runs: it is painted by this box, so leaving it on would
          // re-truncate the text as it moves. Removing it outright deleted every
          // truncation mark in the strip (myne-md/myne#908, third pass).
          textOverflow: revealed ? "clip" : "ellipsis",
          whiteSpace: "nowrap",
          fontStyle: italic ? "italic" : "normal",
          color: italic ? "var(--fg-3)" : undefined,
        }}
      >
        {/* Isolate the user-authored tab title's direction (RTL/bidi). */}
        <bdi
          ref={labelTextRef}
          // `inline` at rest for the same reason as the sidebar rows: an
          // inline-block is an atomic box and swallows the parent's ellipsis.
          style={{
            display: revealed ? "inline-block" : "inline",
            willChange: revealed ? "transform" : undefined,
          }}
        >
          {text}
        </bdi>
      </span>
      {pinned ? (
        // Pinned: a static pin glyph stands in for the × — the tab is
        // close-protected (unpin via the right-click menu to close it).
        <span
          aria-label={t("notes.tabStrip.pinned")}
          title={t("notes.tabStrip.pinnedTitle")}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 18,
            height: 18,
            flexShrink: 0,
            color: "var(--fg-3)",
          }}
        >
          <Icon name="pin" size={12} />
        </span>
      ) : (
        // The × is a MOUSE affordance, deliberately outside the accessibility
        // tree (myne#728). axe rejects both shapes that keep it interactive:
        // nested in the `role="tab"` widget it trips `nested-interactive`, and
        // lifted out of the tab but still inside the tablist it trips
        // `aria-required-children`. There is no DOM shape that keeps a focusable
        // per-tab close control out of both, so it becomes decoration and the
        // keyboard paths carry the capability: `pane.close-tab` (Mod-W),
        // Delete/Backspace on the focused tab (`handleTabKeyDown`), and the
        // tab's context menu.
        <span
          aria-hidden="true"
          data-testid="editor.tab-close"
          // The tooltip a mouse user had before this became a span, restored
          // (myne#728, review). A `title` on an `aria-hidden` element is
          // exactly a mouse affordance and adds nothing to the accessibility
          // tree, which is the point: the control is declared mouse-only, so
          // losing its mouse label was the one regression the demotion should
          // not have caused. It also re-uses `notes.tabStrip.closeTab`, which
          // the demotion had otherwise orphaned across all 31 catalogs.
          title={t("notes.tabStrip.closeTab", { title: text })}
          onClick={(e) => {
            e.stopPropagation();
            onClose(id);
          }}
          {...interactiveSurface()}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            // 2.5.8's 24px floor (myne#728, task 11). It is out of the
            // accessibility tree, so axe's `target-size` never matches it,
            // but the criterion is about POINTER targets and a mouse user is
            // exactly who this control is for. The background is transparent
            // and the glyph stays 12px, so the box grows and nothing is drawn
            // differently.
            ...MIN_TARGET,
            padding: 0,
            border: 0,
            borderRadius: "var(--radius-1)",
            background: "transparent",
            color: "var(--fg-3)",
            cursor: "pointer",
            visibility: showClose ? "visible" : "hidden",
            transition: HOVER_TRANSITION,
          }}
        >
          <Icon name="x" size={12} />
        </span>
      )}
    </div>
  );
}

/** The transient empty "New tab" pseudo-tab (active while its chooser is
 *  open). Carries the same active-tab look as a real tab. */
function NewTabChip({ onClose }: { onClose?: () => void }) {
  const { t } = useTranslation();
  return (
    <div
      role="tab"
      aria-selected
      title={t("notes.tabStrip.newTab")}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        // The active tab's covering pixel (see the tab style above): the chip
        // IS the selected tab while a new tab is pending, so it owes the same
        // one-pixel overhang or the strip's rule shows through it.
        height: "calc(100% + 1px)",
        borderBottom: "1px solid var(--bg-1)",
        padding: "0 6px 0 10px",
        borderTopLeftRadius: 8,
        borderTopRightRadius: 8,
        borderTop: "1px solid var(--line-1)",
        borderInlineStart: "1px solid var(--line-1)",
        borderInlineEnd: "1px solid var(--line-1)",
        background: "var(--bg-1)",
        color: "var(--fg-2)",
        flexShrink: 0,
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-sm)",
      }}
    >
      <Icon name="file-text" size={13} />
      <span style={{ fontStyle: "italic", color: "var(--fg-3)" }}>
        {t("notes.tabStrip.newTab")}
      </span>
      {onClose && (
        // The same mouse affordance the real tabs' close became, and for the
        // same reason (myne#728). This one was missed in the first pass: it
        // is a focusable `<button>` inside a `role="tab"`, which is exactly
        // the `nested-interactive` shape the per-tab x was demoted to a span
        // to remove, and deleting the axe baseline in the same change would
        // have made the remaining instance read as fixed. It is invisible to
        // the real-render gate too, because the chip renders only while a new
        // tab is pending and no axe scenario opens one.
        //
        // The keyboard path out of the chooser is Escape, which
        // `onCloseNewTab` is wired to, plus the ordinary tab commands.
        <span
          aria-hidden="true"
          title={t("notes.tabStrip.closeNewTab")}
          data-testid="editor.new-tab-close"
          onClick={onClose}
          {...interactiveSurface()}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            ...MIN_TARGET,
            padding: 0,
            border: 0,
            borderRadius: "var(--radius-1)",
            background: "transparent",
            color: "var(--fg-3)",
            cursor: "pointer",
            transition: HOVER_TRANSITION,
          }}
        >
          <Icon name="x" size={12} />
        </span>
      )}
    </div>
  );
}

function StripButton({
  label,
  onClick,
  children,
  ...rest
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      data-testid="editor.tab-strip-button"
      {...interactiveSurface()}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        // Pinned to the row's own line rather than centred in the strip. The
        // strip's content box starts below its top padding, so centring here
        // lands the button below the floated controls beside it.
        alignSelf: "flex-start",
        marginTop: TITLE_BAR_CONTROL_TOP - STRIP_PADDING_TOP,
        width: 28,
        height: STRIP_BUTTON_HEIGHT,
        flexShrink: 0,
        border: 0,
        // Was a literal 8, off the radius scale entirely, which read as a
        // rounder square than the "…" and the sidebar toggle next to it.
        borderRadius: "var(--radius-1)",
        background: "transparent",
        color: "var(--fg-3)",
        cursor: "pointer",
        transition: HOVER_TRANSITION,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

function OverflowMenu({
  tabs,
  activeTab,
  titleOf,
  onPick,
  onClose,
}: {
  tabs: readonly string[];
  activeTab: string | null;
  titleOf: (id: string) => string | null;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <>
      {/* click-away backdrop */}
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, zIndex: 10 }}
        aria-hidden="true"
      />
      <ul
        role="menu"
        style={{
          position: "absolute",
          top: STRIP_HEIGHT,
          insetInlineEnd: 0,
          zIndex: 11,
          margin: 0,
          padding: "var(--space-1)",
          listStyle: "none",
          minWidth: 200,
          // Cap the width so a long tab title (e.g. a clipped web page's full
          // headline) can't stretch the menu across the window. The items
          // already ellipsis-truncate — but only once their box is bounded, so
          // this maxWidth is what actually makes the truncation take effect.
          maxWidth: 320,
          maxHeight: 320,
          overflowY: "auto",
          background: "var(--bg-1)",
          border: "1px solid var(--line-1)",
          borderRadius: "var(--radius-2)",
          boxShadow: "var(--shadow-2, 0 6px 20px rgba(0,0,0,0.12))",
        }}
      >
        {tabs.map((id) => {
          const { text, italic } = tabLabel(titleOf(id));
          return (
            <li key={id} role="none">
              <button
                type="button"
                role="menuitem"
                title={text}
                onClick={() => onPick(id)}
                {...interactiveSurface({
                  restBg:
                    id === activeTab ? "var(--accent-soft)" : "transparent",
                  hoverBg:
                    id === activeTab ? "var(--accent-soft)" : "var(--bg-3)",
                })}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "start",
                  padding: "6px 8px",
                  border: 0,
                  borderRadius: "var(--radius-1)",
                  background:
                    id === activeTab ? "var(--accent-soft)" : "transparent",
                  color: italic ? "var(--fg-3)" : "var(--fg-1)",
                  fontFamily: "var(--font-sans)",
                  fontSize: "var(--text-sm)",
                  fontStyle: italic ? "italic" : "normal",
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  transition: HOVER_TRANSITION,
                }}
              >
                <bdi>{text}</bdi>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
