// A lightweight searchable single-select modal — the target-picker sub-flow for
// command-palette actions that need a choice (MYND palette-gap #31 Apply custom
// theme, #32 Move note to folder). Mirrors the CommandPalette shell (portal +
// focus trap + arrow/Enter/Esc list nav + backdrop dismiss) at a fraction of the
// surface: no sections, no async search, just a static filtered option list.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../hooks/useFocusTrap";

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
  onPick: (id: string) => void;
  onClose: () => void;
};

const BACKDROP_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.32)",
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
  gap: 8,
  padding: "8px 10px",
  borderRadius: "var(--radius-1, 3px)",
  cursor: "pointer",
  fontSize: 13,
  color: "var(--fg-1)",
};
const ROW_SELECTED_STYLE: CSSProperties = { ...ROW_STYLE, background: "var(--paper-2)" };

const LABEL_STYLE: CSSProperties = {
  flex: 1,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const SUBLABEL_STYLE: CSSProperties = {
  fontSize: 11,
  color: "var(--fg-3)",
  flexShrink: 0,
};
const EMPTY_STYLE: CSSProperties = {
  padding: "20px 16px",
  fontSize: 13,
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
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
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

  if (!open) return null;

  const commit = (i: number): void => {
    const it = filtered[i];
    if (it !== undefined) {
      onPick(it.id);
      onClose();
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
      style={BACKDROP_STYLE}
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={modalRef} style={MODAL_STYLE} role="dialog" aria-label={title}>
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
          data-testid="quick-picker.input"
        />
        <div style={LIST_STYLE} role="listbox">
          {filtered.length === 0 ? (
            <div style={EMPTY_STYLE}>{emptyText}</div>
          ) : (
            filtered.map((it, i) => (
              <div
                key={it.id}
                role="option"
                aria-selected={i === selectedIndex}
                style={i === selectedIndex ? ROW_SELECTED_STYLE : ROW_STYLE}
                data-testid="quick-picker.option"
                onMouseEnter={() => setSelectedIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(it.id);
                  onClose();
                }}
              >
                <span style={LABEL_STYLE}>{it.label}</span>
                {it.sublabel !== undefined && <span style={SUBLABEL_STYLE}>{it.sublabel}</span>}
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
