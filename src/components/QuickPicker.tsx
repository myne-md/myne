// A lightweight searchable single-select modal — the target-picker sub-flow for
// command-palette actions that need a choice (MYND palette-gap #31 Apply custom
// theme, #32 Move note to folder). Mirrors the CommandPalette shell (portal +
// focus trap + arrow/Enter/Esc list nav + backdrop dismiss) at a fraction of the
// surface: no sections, no async search, just a static filtered option list.

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../hooks/useFocusTrap";
import { useOverlayInert } from "../hooks/useOverlayInert";

/** One selectable option: a stable `id`, a `label`, and an optional muted
 *  `sublabel` (e.g. a theme's swatch summary). */
export type QuickPickItem = {
  id: string;
  label: string;
  sublabel?: string;
};

export type QuickPickerProps = {
  open: boolean;
  title: string;
  placeholder: string;
  items: readonly QuickPickItem[];
  emptyText: string;
  /** A selection was made. Does NOT auto-close — the parent closes the picker
   *  (and decides what happens next). */
  onPick: (id: string) => void;
  /** Cancel (Esc / backdrop). Distinct from `onPick` so the parent can treat a
   *  cancel as "pop back one level" (e.g. reopen the command palette). */
  onClose: () => void;
};

const BACKDROP_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "var(--scrim)",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "center",
  paddingTop: "12vh",
  zIndex: 1600, // above the command palette (1500) — it opens this
};

const MODAL_STYLE: CSSProperties = {
  width: 460,
  maxHeight: "56vh",
  background: "var(--paper, #faf8f3)",
  border: "1px solid var(--line-2)",
  borderRadius: "var(--radius-3, 8px)",
  boxShadow: "var(--shadow-3, 0 16px 48px rgba(0,0,0,0.18))",
  display: "flex",
  flexDirection: "column",
  fontFamily: "var(--font-sans)",
  overflow: "hidden",
};

const INPUT_STYLE: CSSProperties = {
  width: "100%",
  appearance: "none",
  WebkitAppearance: "none",
  border: 0,
  borderBottom: "1px solid var(--line-1, #e3e2dd)",
  background: "transparent",
  outline: "none",
  boxShadow: "none",
  fontFamily: "var(--font-sans)",
  fontSize: 15,
  color: "var(--fg-1)",
  padding: "14px 16px",
};

const LIST_STYLE: CSSProperties = { flex: 1, overflowY: "auto", padding: 6 };

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  padding: "8px 10px",
  borderRadius: "var(--radius-1, 3px)",
  cursor: "pointer",
  fontSize: "var(--text-sm)",
  color: "var(--fg-1)",
};
// accent-soft (not --paper-2) so the active row stays visible on AMOLED, where
// --paper-2 collapses to the modal background — same fix as the CommandPalette.
const ROW_SELECTED_STYLE: CSSProperties = { ...ROW_STYLE, background: "var(--accent-soft)" };

const LABEL_STYLE: CSSProperties = {
  flex: 1,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const SUBLABEL_STYLE: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  flexShrink: 0,
};
const EMPTY_STYLE: CSSProperties = {
  padding: "20px 16px",
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
  textAlign: "center",
};

export function QuickPicker({
  open,
  title,
  placeholder,
  items,
  emptyText,
  onPick,
  onClose,
}: QuickPickerProps) {
  // Combobox ids (myne-md/myne#728, task 5). `useId` rather than a module
  // constant, because unlike the command palette this component is generic and
  // two of them can be mounted at once; two listboxes sharing one DOM id would
  // make every `aria-controls` point at whichever rendered first.
  //
  // The pairing also removes an axe finding rather than suppressing one: a
  // `role="listbox"` a `role="combobox"` references through `aria-controls` is
  // a combobox popup, which `scrollable-region-focusable` deliberately does not
  // match (axe-core `scrollableRegionFocusableMatches`).
  const idBase = useId();
  const listId = `${idBase}-list`;
  const optionId = (index: number): string => `${idBase}-option-${index}`;
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  // The rest of the page goes INERT while this is open (myne-md/myne#728).
  // The focus trap above contains Tab; it does not stop a screen reader's
  // virtual cursor reading the page behind, and `aria-modal` is an assertion
  // some assistive technology ignores. Registered on the BACKDROP, which is
  // the whole overlay: registering the card would inert the backdrop it is in.
  const backdropRef = useRef<HTMLDivElement>(null);
  useOverlayInert(backdropRef, open);
  useFocusTrap(modalRef, { enabled: open, initialFocusRef: inputRef });

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return items;
    return items.filter(
      (it) =>
        it.label.toLowerCase().includes(q) ||
        (it.sublabel?.toLowerCase().includes(q) ?? false),
    );
  }, [items, query]);

  // Keep the selection in range as the filter narrows.
  useEffect(() => {
    if (selectedIndex >= filtered.length) {
      setSelectedIndex(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, selectedIndex]);

  // Keep the keyboard-selected row scrolled into view (guarded — jsdom has no
  // scrollIntoView).
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (el !== null && el !== undefined && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex, filtered.length]);

  if (!open) return null;

  // A pick calls `onPick` only — the parent closes the picker. `onClose` is
  // reserved for a CANCEL (Esc / backdrop), which the parent treats as "pop back
  // to the command palette" (stacked navigation).
  const commit = (i: number): void => {
    const it = filtered[i];
    if (it !== undefined) {
      onPick(it.id);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => (filtered.length === 0 ? 0 : (i + 1) % filtered.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) =>
        filtered.length === 0 ? 0 : (i - 1 + filtered.length) % filtered.length,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(selectedIndex);
    }
  };

  return createPortal(
    <div
      ref={backdropRef}
      style={BACKDROP_STYLE}
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={modalRef}
        style={MODAL_STYLE}
        role="dialog"
        aria-label={title}
        data-testid="quick-picker.dialog"
      >
        <input
          ref={inputRef}
          style={INPUT_STYLE}
          type="text"
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={onKeyDown}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label={title}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={filtered.length > 0}
          aria-controls={filtered.length > 0 ? listId : undefined}
          // Named only while the index still points at a rendered row. A
          // clamp here would be fiction: in the one frame where the list has
          // shrunk and the clamping effect below has not run yet, NO row
          // carries `aria-selected`, so naming the last one would claim a
          // highlight that is not on screen. Absent is the truthful answer,
          // and it keeps "the named row is the selected row" an invariant
          // rather than an almost.
          aria-activedescendant={
            selectedIndex < filtered.length ? optionId(selectedIndex) : undefined
          }
          data-testid="quick-picker.input"
        />
        <div
          id={listId}
          style={LIST_STYLE}
          role="listbox"
          // Named (myne#728, task 4). The picker's `title` is its subject
          // ("Move to folder", "Switch workspace"), which is exactly the right
          // name for the list of choices under it; the dialog's own name does
          // not carry down.
          aria-label={title}
          ref={listRef}
        >
          {filtered.length === 0 ? null : (
            filtered.map((it, i) => (
              <div
                key={it.id}
                id={optionId(i)}
                role="option"
                aria-selected={i === selectedIndex}
                style={i === selectedIndex ? ROW_SELECTED_STYLE : ROW_STYLE}
                data-testid="quick-picker.option"
                data-value={it.id}
                data-selected={i === selectedIndex ? "true" : "false"}
                onMouseEnter={() => setSelectedIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(it.id);
                }}
              >
                <span style={LABEL_STYLE}>{it.label}</span>
                {it.sublabel !== undefined && <span style={SUBLABEL_STYLE}>{it.sublabel}</span>}
              </div>
            ))
          )}
        </div>
        {filtered.length === 0 && (
          // Announced (myne#728), and OUTSIDE the listbox on purpose: a
          // `role="listbox"` may own only `option` and `group` children, so a
          // `role="status"` child of it is an `aria-required-children`
          // violation. Same placement and same reason as the command
          // palette's. The empty listbox stays mounted so the combobox's
          // `aria-controls` still resolves.
          <div style={EMPTY_STYLE} role="status">
            {emptyText}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
