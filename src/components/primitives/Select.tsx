// Generic, accessible, token-styled custom dropdown (MYND-164 Fix 1).
//
// Replaces the OS-native `<select>`, whose system popup (e.g. the macOS menu)
// does not match the app's monochrome + iron-blue chrome. The trigger matches
// the former `SELECT_STYLE` (1px var(--line-2), var(--radius-2), 30px height,
// var(--bg-1)) plus a chevron; the menu is rendered through a PORTAL to
// document.body with `position: fixed`, anchored to the trigger rect — the same
// approach as the attachments ⋮ menu + UsedInNotesPopover — so it escapes the
// top bar's wrap container and the surface scroll clipping.
//
// Appearance lives in `@myne/client-core`'s `components.css` under
// `.myne-select-*` (myne-md/myne#773), shared with `SearchableSelect` — the two
// had independent copies of the same trigger, menu box and option row, which is
// how they drifted into different hover behaviour for the same visual control.
// What stays here is the part a stylesheet cannot do: the portal's measured
// anchor rect, and the active-descendant index the arrow keys move.
//
// Keyboard: open on Enter / Space / ↓; ↑/↓ move the active option; Enter
// selects; Esc closes. Closes on outside-click, on an ANCESTOR/window scroll,
// and on resize (a fixed menu would desync from the trigger) — but never on the
// menu's own list scrolling, see `onReflow`. role="listbox" / role="option"
// + aria-selected for assistive tech. Generic over the option value type.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { placeMenu, type MenuPlacement } from "./menuPlacement";
import { Icon } from "./Icon";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

// Module-level single-open coordination (MYND-164 dogfooding). The primitive is
// app-general, so any number of Selects on a page coordinate: at most one menu
// is open at a time. Each open Select registers its own close callback here;
// opening a new one first closes whichever (if any) was already open. On close /
// unmount the Select unregisters itself.
let activeClose: (() => void) | null = null;

function registerOpen(close: () => void): void {
  if (activeClose !== null && activeClose !== close) {
    const prev = activeClose;
    activeClose = null; // avoid re-entrant unregister churn from prev's setState
    prev();
  }
  activeClose = close;
}

function unregister(close: () => void): void {
  if (activeClose === close) activeClose = null;
}

interface SelectProps<T extends string> {
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  /** Accessible label for the trigger (the surface has no visible <label>). */
  "aria-label"?: string;
  /** Optional style overrides merged onto the trigger button. */
  style?: CSSProperties;
  /** Optional `data-testid` on the trigger button (E2E observability). */
  testId?: string;
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  "aria-label": ariaLabel,
  style,
  testId,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<
    (MenuPlacement & { left: number; minWidth: number }) | null
  >(null);

  const selectedIndex = options.findIndex((o) => o.value === value);
  const current = selectedIndex >= 0 ? options[selectedIndex] : options[0];

  const close = useCallback(() => setOpen(false), []);

  const openMenu = useCallback(() => {
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    // Close any other open Select before opening this one (single-open).
    registerOpen(close);
    setOpen(true);
  }, [selectedIndex, close]);

  // Unregister from the single-open coordinator whenever this Select is no
  // longer open (closed by any path) or unmounts.
  useEffect(() => {
    if (!open) {
      unregister(close);
      return;
    }
    return () => unregister(close);
  }, [open, close]);

  const choose = useCallback(
    (index: number) => {
      const opt = options[index];
      if (opt !== undefined) onChange(opt.value);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [options, onChange],
  );

  // Anchor the menu to the trigger, left-aligned, at least as wide as it —
  // and on whichever side there is room for it. `placeMenu` owns the vertical
  // half: this control sits near the bottom of the window often enough
  // (the AI composer's two dropdowns are a few pixels above the status bar)
  // that "always downward" put most of the menu past the fold, with no scroll
  // to reach it because a fixed portal does not extend the page.
  useLayoutEffect(() => {
    if (!open) return;
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const minWidth = Math.max(160, r.width);
    const left = Math.min(r.left, window.innerWidth - minWidth - 8);
    setCoords({
      // 280 is this variant's `max-height` in `components.css`. Passed rather
      // than read: an inline `max-height` overrides the sheet, so the number
      // has to be known here or the menu grows to whatever room exists.
      ...placeMenu(r, window.innerHeight, { cap: 280 }),
      left: Math.max(8, left),
      minWidth,
    });
  }, [open]);

  // Outside-click / Esc handled at the trigger; scroll/resize close the menu
  // (a fixed-position menu would otherwise drift away from the trigger).
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        menuRef.current &&
        !menuRef.current.contains(t) &&
        triggerRef.current &&
        !triggerRef.current.contains(t)
      ) {
        close();
      }
    };
    const onReflow = (e?: Event) => {
      // The scroll listener below is capture-phase, so it ALSO fires when the
      // menu's own option list scrolls past `MENU_STYLE.maxHeight` — and
      // closing on that makes a long list literally un-scrollable: the wheel
      // dismisses the menu it is trying to move. Ignore a scroll originating
      // inside the menu; an ancestor/window scroll is the one that drifts the
      // fixed menu away from its trigger and still warrants a close, and a
      // resize always does. Same fix as SearchableSelect.tsx, which had it
      // first — this primitive never got it, so every Select in the app with
      // more options than fit was affected.
      if (
        e?.type === "scroll" &&
        e.target instanceof Node &&
        menuRef.current?.contains(e.target)
      ) {
        return;
      }
      close();
    };
    // CAPTURE phase: a container that stops click propagation (e.g. the Settings
    // modal content, which stops bubbling to keep backdrop-close from firing)
    // would otherwise swallow a bubble-phase document listener, so clicking
    // elsewhere in the modal never closed the menu. Capture fires top-down before
    // any bubble-phase stopPropagation can run.
    const tid = setTimeout(
      () => document.addEventListener("click", onDocClick, true),
      0,
    );
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      clearTimeout(tid);
      document.removeEventListener("click", onDocClick, true);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open, close]);

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      triggerRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(activeIndex);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        data-testid={testId}
        className="myne-select-trigger"
        style={style}
        onClick={(e) => {
          e.stopPropagation();
          if (open) close();
          else openMenu();
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <span style={{ flex: 1, minWidth: 0 }}>{current?.label ?? ""}</span>
        <Icon name="chevron-down" size={14} />
      </button>
      {open &&
        coords !== null &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label={ariaLabel}
            className="myne-select-menu"
            // Which way it opened, for a scenario and for anyone reading the
            // DOM: the coordinates alone do not say, since `top` and `bottom`
            // are both plausible numbers.
            data-side={coords.side}
            // The measured values, and only those: the menu is a fixed portal
            // anchored to the trigger's rect, which no stylesheet knows. The
            // height is measured too — the stylesheet's `max-height` is the
            // cap, and the room on the chosen side is the value, or flipping
            // would only move the overflow to the other edge.
            style={{
              ...(coords.top === undefined ? {} : { top: coords.top }),
              ...(coords.bottom === undefined ? {} : { bottom: coords.bottom }),
              maxHeight: coords.maxHeight,
              left: coords.left,
              minWidth: coords.minWidth,
            }}
          >
            {options.map((opt, index) => {
              const selected = opt.value === value;
              const active = index === activeIndex;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-testid={testId ? `${testId}-option` : undefined}
                  data-value={opt.value}
                  className="myne-select-option"
                  // The ACTIVE DESCENDANT, not a hover: arrow keys move it, and
                  // the pointer syncs it below so the keyboard and the mouse
                  // share one highlight rather than lighting two rows. NOT
                  // `data-active`, which is the app-wide E2E contract for "the
                  // selected one".
                  data-highlighted={active ? "true" : "false"}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={(e) => {
                    e.stopPropagation();
                    choose(index);
                  }}
                >
                  <span className="myne-select-option__check">
                    {selected && <Icon name="check" size={14} />}
                  </span>
                  <span className="myne-select-option__label">{opt.label}</span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
