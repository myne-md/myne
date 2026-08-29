// `<NoteActionsMenu>` — the editor-chrome "…" (more) menu (Obsidian-style).
//
// A single "…" button in the editor's top-right chrome (beside the right-
// sidebar toggle) that drops a menu of note-scoped actions — Rename, Move to
// folder, Duplicate, Version history, Export, Move to trash. Every item is fed
// a handler by the mounting host (`Editor.tsx`'s `CommandPaletteHost`), which
// wires them to the SAME `CommandContext` handlers the command palette uses —
// so there is no second IPC path here, only a second surface onto the existing
// one.
//
// The component owns only presentation + dismissal: the anchored dropdown
// (modeled on `WorkspaceSwitcherControl`), Esc / outside-click close (the
// `ContextMenu` discipline), and keyboard menu navigation. Token-only inline
// styling, no Tailwind (src/CLAUDE.md).

import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Icon } from "../../components/primitives/Icon";
import type { IconName } from "../../lib/icons";
import {
  hoverSurface,
  HOVER_TRANSITION,
} from "../../components/primitives/hoverSurface";

/** One row of the menu: an actionable item or a section divider. */
export type NoteActionMenuItem =
  | { kind: "divider" }
  | {
      kind: "action";
      /** Stable discriminator surfaced as `data-action` (E2E + React key). */
      action: string;
      label: string;
      /** Optional leading glyph. */
      icon?: IconName;
      /** Destructive styling (red) — e.g. Move to trash. */
      destructive?: boolean;
      /**
       * When present, the row opens a SUBMENU of these instead of acting, and
       * its own `onSelect` is never called (pass a no-op).
       *
       * A flat list of choices, deliberately: no icons, no dividers, no further
       * nesting. The one caller is "Export…", where the children are format
       * names and anything richer would be a second menu pretending to be a
       * submenu. The sidebar's `ContextMenu` grew the same affordance in the
       * same change; the two are separate implementations because the two
       * menus are separate components (an anchored dropdown against a menu
       * placed at a click), and what they DO share is the list of formats
       * (`notes/noteExportMenu.ts`).
       */
      children?: { action: string; label: string; onSelect: () => void }[];
      onSelect: () => void;
    };

// The "…" button matches the neighbouring `TitleBarToggle` (same footprint +
// hover ramp) so the top-right cluster reads as one control group.
const BUTTON_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 30,
  height: 26,
  flexShrink: 0,
  border: 0,
  borderRadius: "var(--radius-1)",
  background: "transparent",
  color: "var(--fg-3)",
  cursor: "pointer",
  transition: HOVER_TRANSITION,
};

const MENU_STYLE: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 4px)",
  insetInlineEnd: 0,
  minWidth: 208,
  background: "var(--paper)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  boxShadow: "0 4px 12px rgba(0, 0, 0, 0.12)",
  padding: "var(--space-1)",
  zIndex: 60,
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
};

// A submenu opens toward the inline START, because this dropdown is pinned to
// the inline END of the editor's top-right chrome and there is no room on that
// side. Written with logical properties so an RTL locale, where the whole
// cluster mirrors, gets the opposite side for free.
const SUBMENU_STYLE: CSSProperties = {
  // The same surface as the menu it hangs off, restated only where it differs.
  // Spelling the shared half out again would put the panel's shadow, border and
  // radius in two places in one file, so a retune of one would silently leave a
  // submenu that no longer matches the menu above it.
  ...MENU_STYLE,
  // Level with its parent ROW rather than with the menu, so the eye stays on
  // the row it came from. The `-4` cancels the menu's own `--space-1` padding.
  top: -4,
  insetInlineEnd: "calc(100% + 4px)",
  minWidth: 160,
  zIndex: 61,
};

const ITEM_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  width: "100%",
  textAlign: "start",
  padding: "6px 10px",
  background: "transparent",
  border: 0,
  borderRadius: 4,
  cursor: "pointer",
  color: "var(--fg-1)",
  fontFamily: "inherit",
  fontSize: "inherit",
  transition: HOVER_TRANSITION,
};

const DIVIDER_STYLE: CSSProperties = {
  height: 1,
  background: "var(--line-1)",
  margin: "4px 6px",
  border: 0,
};

export function NoteActionsMenu({
  label,
  items,
}: {
  /** aria-label + tooltip for the "…" button. */
  label: string;
  items: NoteActionMenuItem[];
}) {
  const [open, setOpen] = useState(false);
  // The open submenu's parent `action`. Driven by hovering ANY row (a parent
  // opens its own, a plain row closes whatever was open) rather than by a
  // leave handler, because leaving the parent row is how the pointer reaches
  // the submenu in the first place.
  const [submenuFor, setSubmenuFor] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Esc + outside-click dismissal, and focus the first item on open so the
  // `role="menu"` is keyboard-operable from the start (ContextMenu discipline).
  /**
   * Focus the first row on open, so the `role="menu"` is keyboard-operable from
   * the start, and drop any submenu on close so reopening the "…" does not
   * paint one before the pointer went near the parent row.
   *
   * Its OWN effect, keyed on `open` alone. The dismissal effect below has to
   * re-subscribe whenever `submenuFor` moves, or its Escape handler reads a
   * stale value; folding this into it would then re-run this focus call on
   * every submenu open and close, yanking focus back to the first row in the
   * middle of the user's navigation.
   */
  useEffect(() => {
    if (!open) {
      setSubmenuFor(null);
      return;
    }
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // One level per press, which is the contract `ContextMenu` states and
      // this menu used to contradict: a submenu is the innermost thing open, so
      // the first Escape leaves it and the second leaves the menu.
      //
      // Focus follows the dismissal in both directions, because the element it
      // was on is the one being unmounted. Without the restore it lands on
      // `<body>`, and the arrow-key handler is an `onKeyDown` on this menu's
      // own div, so the whole menu goes keyboard-dead while still on screen.
      if (submenuFor !== null) {
        const parent = ref.current?.querySelector<HTMLButtonElement>(
          `[data-action="${submenuFor}"]`,
        );
        setSubmenuFor(null);
        parent?.focus();
        return;
      }
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, submenuFor]);

  return (
    <div
      ref={ref}
      data-editor-chrome
      style={{ position: "relative", display: "flex", alignItems: "center" }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        data-testid="editor.note-actions-menu"
        {...hoverSurface()}
        style={BUTTON_STYLE}
      >
        <Icon name="more-horizontal" size={16} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          onKeyDown={(e) => {
            const node = ref.current;
            if (node === null) return;
            const its = Array.from(
              node.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
            );
            if (its.length === 0) return;
            // Either horizontal arrow leaves an open submenu and puts focus
            // back on its parent row. Both, rather than one: the submenu opens
            // on the inline-start side, which swaps under RTL, so a single
            // direction would be the wrong one for half the locales. Nothing
            // inside a submenu row uses the horizontal axis, so neither key has
            // another job here. Entering is ArrowDown, since the submenu is
            // rendered inline and the cycle below walks into it in reading
            // order.
            if (
              (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
              submenuFor !== null
            ) {
              const parent = node.querySelector<HTMLButtonElement>(
                `[data-action="${submenuFor}"]`,
              );
              if (parent !== null && parent !== document.activeElement) {
                e.preventDefault();
                setSubmenuFor(null);
                parent.focus();
                return;
              }
            }
            const cur = its.findIndex((el) => el === document.activeElement);
            let next: number;
            if (e.key === "ArrowDown") next = cur < 0 ? 0 : (cur + 1) % its.length;
            else if (e.key === "ArrowUp")
              next = cur < 0 ? its.length - 1 : (cur - 1 + its.length) % its.length;
            else if (e.key === "Home") next = 0;
            else if (e.key === "End") next = its.length - 1;
            else return;
            e.preventDefault();
            its[next]?.focus();
          }}
          style={MENU_STYLE}
        >
          {items.map((item, i) => {
            if (item.kind === "divider") {
              return (
                <div key={`divider-${i}`} role="separator" style={DIVIDER_STYLE} />
              );
            }
            // Built once per row so the row's own `onMouseEnter` can CALL it.
            // Spreading `hoverSurface()` after a hand-written `onMouseEnter`
            // silently replaces that handler, which is how the submenu stopped
            // opening on hover while every other symptom looked fine.
            const hover = hoverSurface({
              hoverBg: item.destructive ? "var(--warning-soft)" : "var(--paper-3)",
            });
            const row = (
                <button
                  type="button"
                  role="menuitem"
                  aria-haspopup={item.children === undefined ? undefined : "menu"}
                  aria-expanded={
                    item.children === undefined
                      ? undefined
                      : submenuFor === item.action
                  }
                  data-testid="editor.note-actions-menu-item"
                  data-action={item.action}
                  // Hover only, deliberately NOT focus. Opening the menu focuses
                  // its first row so the `role="menu"` is keyboard-operable from
                  // the start, so a focus-driven submenu springs open unbidden
                  // whenever the parent row happens to be first, which is
                  // exactly what "Export…" is in some of these menus. Keyboard
                  // users open it with Enter, through the click handler below.
                  onMouseEnter={(e) => {
                    hover.onMouseEnter?.(e);
                    setSubmenuFor(
                      item.children === undefined ? null : item.action,
                    );
                  }}
                  onMouseLeave={hover.onMouseLeave}
                  onClick={() => {
                    // A parent row opens its children rather than acting, and
                    // the hover/focus handlers have already done it. This is
                    // the click-without-hover path (touch, or a click straight
                    // after a keyboard move).
                    if (item.children !== undefined) {
                      setSubmenuFor(item.action);
                      return;
                    }
                    item.onSelect();
                    setOpen(false);
                  }}
                  style={{
                    ...ITEM_STYLE,
                    color: item.destructive ? "var(--warning)" : "var(--fg-1)",
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 16,
                      flexShrink: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      color: item.destructive ? "var(--warning)" : "var(--fg-3)",
                    }}
                  >
                    {item.icon !== undefined ? (
                      <Icon name={item.icon} size={14} />
                    ) : null}
                  </span>
                  <span
                    style={{
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      ...(item.children === undefined ? null : { flex: 1 }),
                    }}
                  >
                    {item.label}
                  </span>
                  {item.children !== undefined && (
                    // Points the way the submenu opens. `chevron-left` is in
                    // `Icon`'s directional set, so it flips with the panel in
                    // RTL, which is exactly when `insetInlineEnd` moves the
                    // submenu to the other side.
                    <span
                      aria-hidden="true"
                      style={{ display: "flex", color: "var(--fg-3)" }}
                    >
                      <Icon name="chevron-left" size={12} />
                    </span>
                  )}
                </button>
            );
            return (
              <Fragment key={item.action}>
                {item.children === undefined ? (
                  row
                ) : (
                  // The positioning wrapper exists only for a parent row, and
                  // carries `role="none"`. Both halves matter to the same rule:
                  // an unroled generic element between a `role="menu"` and its
                  // `role="menuitem"` children breaks `aria-required-children`,
                  // and this div used to render around EVERY row, so the
                  // violation covered the whole menu rather than one row of it.
                  <div role="none" style={{ position: "relative" }}>
                    {row}
                    {submenuFor === item.action && (
                  // Rendered inline right after its parent row, so the menu's
                  // own arrow-key cycle walks into it in reading order and this
                  // needs no keyboard code of its own. (The sidebar's
                  // `ContextMenu` DOES need some, because its submenu is a
                  // nested copy of itself carrying a second key handler.)
                  <div role="menu" aria-label={item.label} style={SUBMENU_STYLE}>
                    {item.children.map((child) => (
                      <button
                        key={child.action}
                        type="button"
                        role="menuitem"
                        data-testid="editor.note-actions-menu-item"
                        data-action={child.action}
                        onClick={() => {
                          child.onSelect();
                          setOpen(false);
                        }}
                        {...hoverSurface({ hoverBg: "var(--paper-3)" })}
                        style={{ ...ITEM_STYLE, color: "var(--fg-1)" }}
                      >
                        <span
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {child.label}
                        </span>
                      </button>
                    ))}
                      </div>
                    )}
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      )}
    </div>
  );
}
