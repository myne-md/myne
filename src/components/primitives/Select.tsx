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
// Keyboard: open on Enter / Space / ↓; ↑/↓ move the active option; Enter
// selects; Esc closes. Closes on outside-click and on any scroll / resize
// (a fixed menu would desync from the trigger). role="listbox" / role="option"
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

const TRIGGER_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-1)",
  height: 30,
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  color: "var(--fg-2)",
  background: "var(--bg-1)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  padding: "0 var(--space-2)",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const MENU_STYLE: CSSProperties = {
  position: "fixed",
  // Above modal surfaces (ModalShell / SettingsModal use z-index 1000): a Select
  // opened INSIDE the Settings modal must render its menu over the modal, not
  // behind it — at z-index 60 the options were covered by the modal backdrop and
  // could not be clicked (the menu is a body-level fixed portal).
  zIndex: 1100,
  minWidth: 160,
  background: "var(--bg-1)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  boxShadow: "var(--shadow-2, 0 4px 16px rgba(0,0,0,0.18))",
  padding: "var(--space-1) 0",
  maxHeight: 280,
  overflowY: "auto",
};

const OPTION_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  width: "100%",
  textAlign: "left",
  padding: "var(--space-2) var(--space-3)",
  background: "transparent",
  border: 0,
  cursor: "pointer",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  color: "var(--fg-1)",
  whiteSpace: "nowrap",
};

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
  const [coords, setCoords] = useState<{
    top: number;
    left: number;
    minWidth: number;
  } | null>(null);

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

  // Anchor the menu below the trigger, left-aligned, at least as wide as it.
  useLayoutEffect(() => {
    if (!open) return;
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const minWidth = Math.max(160, r.width);
    const left = Math.min(r.left, window.innerWidth - minWidth - 8);
    setCoords({ top: r.bottom + 4, left: Math.max(8, left), minWidth });
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
    const onReflow = () => close();
    const tid = setTimeout(
      () => document.addEventListener("click", onDocClick),
      0,
    );
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      clearTimeout(tid);
      document.removeEventListener("click", onDocClick);
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
        style={{ ...TRIGGER_STYLE, ...style }}
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
            style={{
              ...MENU_STYLE,
              top: coords.top,
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
                  style={{
                    ...OPTION_STYLE,
                    background: active ? "var(--paper-2)" : "transparent",
                  }}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={(e) => {
                    e.stopPropagation();
                    choose(index);
                  }}
                >
                  <span
                    style={{
                      width: 16,
                      display: "inline-flex",
                      flexShrink: 0,
                      color: "var(--accent)",
                    }}
                  >
                    {selected && <Icon name="check" size={14} />}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>{opt.label}</span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
