// Generic, accessible, token-styled searchable dropdown — single- OR
// multi-select.
//
// The searchable sibling of `Select.tsx` (the plain single-select dropdown):
// same portal-to-body + fixed-position anchoring, same single-open coordination,
// same outside-click / scroll / resize close discipline. Adds a search `<input>`
// that filters the option list live, and supports a multi-select set via the
// `multiple` prop. Selection is ALWAYS an array on the wire (0..1 for single,
// 0..n for multi) so one API serves both modes.
//
// Single mode: choosing an option replaces the selection and closes the menu.
// Multi mode: options TOGGLE and the menu stays open across toggles. Either way
// the trigger summarises the current selection (the joined option labels, or
// `placeholder` when empty).
//
// Keyboard: open on Enter / Space / ↓ (focus lands on the search box); type to
// filter; ↑/↓ move the active option; Enter chooses/toggles it; Esc closes (and
// refocuses the trigger). role="listbox" (+ aria-multiselectable in multi mode),
// role="option" + aria-selected for assistive tech. Generic over the value type.
//
// Observability (src/CLAUDE.md "Test observability"): pass `testId` and the
// primitive derives `${testId}` (trigger), `${testId}-menu`, `${testId}-search`,
// and `${testId}-option` (each carrying `data-value` + `data-active`), so E2E
// can drive and read the control without the checkbox `checked` property a
// native picker would expose.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";
import type { SelectOption } from "./Select";

// Module-level single-open coordination — at most one SearchableSelect is open
// at a time (a plain Select and a SearchableSelect can coexist open, which is
// fine — they never overlap in a single panel today).
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

interface SearchableSelectProps<T extends string> {
  options: readonly SelectOption<T>[];
  /** The currently-selected values (0..1 for single, 0..n for multi). */
  selected: readonly T[];
  /** Called with the full next selection whenever it changes. */
  onChange: (next: T[]) => void;
  /** Toggle a set instead of replacing a single value. Default false. */
  multiple?: boolean;
  disabled?: boolean;
  /** Accessible label for the trigger (the surface has no visible <label>). */
  "aria-label"?: string;
  /** Trigger text when nothing is selected. */
  placeholder?: string;
  /** Search box placeholder. */
  searchPlaceholder?: string;
  /** Shown inside the menu when the filter matches no option. */
  emptyText?: string;
  /** Testid for the trigger; the menu / search / options derive from it. */
  testId?: string;
}

const TRIGGER_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-1)",
  minHeight: 30,
  maxWidth: 320,
  fontFamily: "var(--font-sans)",
  fontSize: 12,
  color: "var(--fg-2)",
  background: "var(--bg-1)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-2)",
  padding: "0 var(--space-2)",
  cursor: "pointer",
  textAlign: "start",
  transition: "border-color var(--duration-fast) var(--ease-standard)",
};

const MENU_STYLE: CSSProperties = {
  position: "fixed",
  // Above the modal layer (ModalShell / SettingsModal sit at z-index 1000) —
  // these controls live inside the Settings modal, so the portaled menu must
  // clear that overlay rather than render behind it.
  zIndex: 1100,
  minWidth: 220,
  background: "var(--bg-1)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
  boxShadow: "var(--shadow-2, 0 4px 16px rgba(0,0,0,0.18))",
  paddingBottom: "var(--space-1)",
  display: "flex",
  flexDirection: "column",
  maxHeight: 320,
};

const SEARCH_ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  padding: "var(--space-2) var(--space-3)",
  borderBottom: "1px solid var(--line-1)",
  color: "var(--fg-3)",
};

const SEARCH_INPUT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  border: 0,
  outline: "none",
  background: "transparent",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  color: "var(--fg-1)",
};

const LIST_STYLE: CSSProperties = {
  overflowY: "auto",
  padding: "var(--space-1) 0",
};

const OPTION_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  width: "100%",
  textAlign: "start",
  padding: "var(--space-2) var(--space-3)",
  background: "transparent",
  border: 0,
  cursor: "pointer",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  color: "var(--fg-1)",
  whiteSpace: "nowrap",
};

const EMPTY_STYLE: CSSProperties = {
  padding: "var(--space-2) var(--space-3)",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  color: "var(--fg-3)",
};

export function SearchableSelect<T extends string>({
  options,
  selected,
  onChange,
  multiple = false,
  disabled = false,
  "aria-label": ariaLabel,
  placeholder: placeholderProp,
  searchPlaceholder: searchPlaceholderProp,
  emptyText: emptyTextProp,
  testId,
}: SearchableSelectProps<T>) {
  const { t } = useTranslation();
  const placeholder =
    placeholderProp ?? t("primitives.searchableSelect.placeholder");
  const searchPlaceholder =
    searchPlaceholderProp ?? t("primitives.searchableSelect.searchPlaceholder");
  const emptyText = emptyTextProp ?? t("primitives.searchableSelect.emptyText");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [coords, setCoords] = useState<{
    top: number;
    right: number;
    minWidth: number;
  } | null>(null);

  const selectedSet = useMemo(() => new Set<T>(selected), [selected]);

  // The trigger summary: the selected options' labels (in the options' order),
  // or empty when nothing is selected (→ the placeholder renders).
  const summary = useMemo(() => {
    const labels = options
      .filter((o) => selectedSet.has(o.value))
      .map((o) => o.label);
    return labels.join(", ");
  }, [options, selectedSet]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
    );
  }, [options, query]);

  const close = useCallback(() => setOpen(false), []);

  const openMenu = useCallback(() => {
    if (disabled) return;
    setQuery("");
    setActiveIndex(0);
    registerOpen(close);
    setOpen(true);
  }, [disabled, close]);

  // Unregister from the single-open coordinator whenever closed / unmounted.
  useEffect(() => {
    if (!open) {
      unregister(close);
      return;
    }
    return () => unregister(close);
  }, [open, close]);

  // Move focus into the search box so typing filters immediately.
  //
  // Gated on `coords`, not on `open` alone: the menu is only portaled once the
  // anchoring `useLayoutEffect` below has measured the trigger, which happens
  // AFTER the render that flipped `open`. On that first render `searchRef` is
  // still null and a focus keyed to `[open]` silently no-ops — so the very
  // first open of any of these controls left focus wherever it was and typing
  // went nowhere. It looked like it worked because `coords` is never cleared
  // on close: every subsequent open re-rendered the portal immediately with
  // the stale measurement, and only the first one was broken.
  useEffect(() => {
    if (open && coords !== null) searchRef.current?.focus();
  }, [open, coords]);

  // Keep the active row in range as the filter narrows the list.
  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const choose = useCallback(
    (value: T) => {
      if (multiple) {
        // Toggle within the set; preserve the options' order. Menu stays open.
        const next = options
          .map((o) => o.value)
          .filter((v) => (v === value ? !selectedSet.has(v) : selectedSet.has(v)));
        onChange(next);
      } else {
        // Replace + close (the standard single-select gesture).
        onChange([value]);
        close();
        triggerRef.current?.focus();
      }
    },
    [multiple, options, selectedSet, onChange, close],
  );

  // Anchor the menu below the trigger, RIGHT-aligned to it (opens leftward) so it
  // never spills past the right edge — the trigger usually sits on the right of a
  // settings row / modal, where a left-aligned menu leaked off-screen.
  useLayoutEffect(() => {
    if (!open) return;
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const minWidth = Math.max(220, r.width);
    const right = Math.max(8, window.innerWidth - r.right);
    setCoords({ top: r.bottom + 4, right, minWidth });
  }, [open]);

  // Outside-click closes; scroll/resize close (a fixed menu would drift).
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
      // The scroll listener is capture-phase, so it also fires when the menu's
      // OWN option list scrolls — ignore that (closing on it makes a long list
      // un-scrollable). Only an ancestor/window scroll drifts the fixed menu and
      // warrants a close; resize always closes.
      if (
        e?.type === "scroll" &&
        e.target instanceof Node &&
        menuRef.current?.contains(e.target)
      ) {
        return;
      }
      close();
    };
    // CAPTURE phase — see Select.tsx: a bubble-phase document listener is
    // swallowed by a modal that stops click propagation, so clicking elsewhere
    // in the Settings modal never closed the menu.
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

  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      triggerRef.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = filtered[activeIndex];
      if (opt !== undefined) choose(opt.value);
    }
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (open) return; // the search box owns keys while open
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      openMenu();
    }
  };

  const menuTestId = testId ? `${testId}-menu` : undefined;
  const searchTestId = testId ? `${testId}-search` : undefined;
  const optionTestId = testId ? `${testId}-option` : undefined;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        data-testid={testId}
        style={{
          ...TRIGGER_STYLE,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.5 : 1,
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (open) close();
          else openMenu();
        }}
        onMouseEnter={
          disabled
            ? undefined
            : (e) => {
                e.currentTarget.style.borderColor = "var(--line-3)";
              }
        }
        onMouseLeave={
          disabled
            ? undefined
            : (e) => {
                e.currentTarget.style.borderColor = "var(--line-2)";
              }
        }
        onKeyDown={onTriggerKeyDown}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            padding: "5px 0",
            color: summary === "" ? "var(--fg-3)" : "var(--fg-1)",
          }}
        >
          {summary === "" ? placeholder : summary}
        </span>
        <Icon name="chevron-down" size={14} />
      </button>
      {open &&
        coords !== null &&
        createPortal(
          <div
            ref={menuRef}
            data-testid={menuTestId}
            // The menu is portaled out of whatever opened it, so a dialog's
            // focus trap sees the search box below as "outside" and pulls
            // focus back the moment it lands — leaving the box untypable.
            // This marks the surface as belonging to its opener.
            data-focus-trap-portal=""
            style={{
              ...MENU_STYLE,
              top: coords.top,
              right: coords.right,
              minWidth: coords.minWidth,
              maxWidth: "min(360px, calc(100vw - 16px))",
            }}
          >
            <div style={SEARCH_ROW_STYLE}>
              <Icon name="search" size={14} />
              <input
                ref={searchRef}
                type="text"
                value={query}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                data-testid={searchTestId}
                style={SEARCH_INPUT_STYLE}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onSearchKeyDown}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
            <div
              role="listbox"
              aria-multiselectable={multiple ? "true" : undefined}
              aria-label={ariaLabel}
              style={LIST_STYLE}
            >
              {filtered.length === 0 ? (
                <p style={EMPTY_STYLE}>{emptyText}</p>
              ) : (
                filtered.map((opt, index) => {
                  const isSelected = selectedSet.has(opt.value);
                  const active = index === activeIndex;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      data-testid={optionTestId}
                      data-value={opt.value}
                      data-active={isSelected}
                      style={{
                        ...OPTION_STYLE,
                        background: active ? "var(--bg-3)" : "transparent",
                      }}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={(e) => {
                        e.stopPropagation();
                        choose(opt.value);
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
                        {isSelected && <Icon name="check" size={14} />}
                      </span>
                      <span style={{ flex: 1, minWidth: 0 }}>{opt.label}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
