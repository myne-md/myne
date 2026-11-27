// An in-place multi-select: the chosen values sit as chips at the top of a bordered
// box, and the options scroll under them inside the same box. No popover, no second
// dropdown (mcp external access rework, myne-md/myne#1052).
//
// # Why this is not `SearchableSelect`
//
// That one opens an anchored panel over the page: right for a compact trigger, wrong
// for a scope the person is composing while reading three other fields, because the
// panel covers the lines they are deciding about and closes on an outside click. Here
// the list is part of the form, so the choice and its options stay on screen together.
//
// # What it owes accessibility
//
// The listbox carries `aria-multiselectable`, every option `aria-selected`, and the
// chips are buttons whose own text is their accessible name, so removing a value does
// not depend on the `x` glyph. The search field is a real input, first in tab order.

import { useId, useMemo, useState } from "react";
import type { CSSProperties } from "react";

import { Button } from "./Button";
import { Icon } from "./Icon";
import { Input } from "./Input";
import { ScrollArea } from "./ScrollArea";

interface MultiSelectOption {
  readonly value: string;
  readonly label: string;
}

interface MultiSelectBoxProps {
  readonly options: readonly MultiSelectOption[];
  readonly selected: readonly string[];
  readonly onChange: (next: string[]) => void;
  /** Accessible name for the group and for each chip's remove control. */
  readonly label: string;
  readonly searchPlaceholder?: string;
  readonly emptyText: string;
  readonly testId?: string;
  readonly disabled?: boolean;
  /** Start folded. The box then shows one row (label, count, chevron) and the
   *  options appear when it is opened, inside the same rectangle. */
  readonly collapsible?: boolean;
  /** Summary shown on the folded row when nothing is chosen yet. */
  readonly emptySummary?: string;
  /** Pixel ceiling for the scrolling list. The step-3 modal is tall, so it can
   *  spend more of the dialog on the tree than a settings row would. */
  readonly maxListHeight?: number;
}

const BOX_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-2)",
  padding: "var(--space-2)",
  background: "var(--paper)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-2)",
};

const CHIPS_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "var(--space-1)",
};

const CHIP_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--space-1)",
  padding: "0 var(--space-2)",
  minHeight: "var(--space-5)",
  fontSize: "var(--text-sm)",
};

const LIST_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
};

/** The folded row, and the header of the opened box: same control in both states,
 *  so the rectangle feels like it expanded rather than swapped. */
const FOLDED_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  justifyContent: "flex-start",
  width: "100%",
  padding: "var(--space-2) var(--space-3)",
  fontSize: "var(--text-sm)",
};

export function MultiSelectBox({
  options,
  selected,
  onChange,
  label,
  searchPlaceholder,
  emptyText,
  testId,
  disabled = false,
  collapsible = false,
  emptySummary,
  maxListHeight = 180,
}: MultiSelectBoxProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(!collapsible);
  const [hovered, setHovered] = useState<string | null>(null);
  const searchId = useId();

  const chosen = useMemo(
    () => selected.map((value) => options.find((option) => option.value === value) ?? { value, label: value }),
    [options, selected],
  );
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return options;
    return options.filter((option) => option.label.toLowerCase().includes(needle));
  }, [options, query]);

  const toggle = (value: string) => {
    onChange(selected.includes(value) ? selected.filter((entry) => entry !== value) : [...selected, value]);
  };

  if (collapsible && !open) {
    return (
      <Button
        variant="ghost"
        aria-expanded={false}
        onClick={() => setOpen(true)}
        style={FOLDED_STYLE}
        disabled={disabled}
        data-testid={testId === undefined ? undefined : `${testId}-toggle`}
      >
        <Icon name="chevron-right" size={14} />
        <span style={{ fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"] }}>
          {label}
        </span>
        <span style={{ color: "var(--fg-3)", fontSize: "var(--text-xs)" }}>
          {chosen.length === 0 ? (emptySummary ?? "") : String(chosen.length)}
        </span>
      </Button>
    );
  }

  return (
    <div style={BOX_STYLE} role="group" aria-label={label} data-testid={testId}>
      {collapsible && (
        <Button
          variant="ghost"
          aria-expanded
          onClick={() => setOpen(false)}
          style={FOLDED_STYLE}
          data-testid={testId === undefined ? undefined : `${testId}-toggle`}
        >
          <Icon name="chevron-down" size={14} />
          <span style={{ fontWeight: "var(--weight-medium)" as CSSProperties["fontWeight"] }}>
            {label}
          </span>
          <span style={{ color: "var(--fg-3)", fontSize: "var(--text-xs)" }}>
            {chosen.length === 0 ? (emptySummary ?? "") : String(chosen.length)}
          </span>
        </Button>
      )}
      {chosen.length > 0 && (
        <div style={CHIPS_STYLE} data-testid={testId === undefined ? undefined : `${testId}-chips`}>
          {chosen.map((option) => (
            <Button
              key={option.value}
              variant="secondary"
              style={CHIP_STYLE}
              disabled={disabled}
              onClick={() => toggle(option.value)}
              data-testid={testId === undefined ? undefined : `${testId}-chip`}
            >
              {option.label}
              <Icon name="circle-x" size={12} />
            </Button>
          ))}
        </div>
      )}

      <Input
        id={searchId}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={searchPlaceholder ?? label}
        aria-label={label}
        disabled={disabled}
        data-testid={testId === undefined ? undefined : `${testId}-search`}
      />

      <ScrollArea style={{ ...LIST_STYLE, maxHeight: `${maxListHeight}px` }}>
        <div
          role="listbox"
          aria-multiselectable="true"
          aria-label={label}
          style={{ padding: "var(--space-1) 0" }}
        >
          {shown.length === 0 && (
            <p
              style={{ margin: 0, padding: "var(--space-2)", color: "var(--fg-3)", fontSize: "var(--text-sm)" }}
              data-testid={testId === undefined ? undefined : `${testId}-empty`}
            >
              {emptyText}
            </p>
          )}
          {shown.map((option) => {
            const isSelected = selected.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                className="myne-select-option"
                data-active={isSelected ? "true" : "false"}
                data-selected={isSelected ? "true" : "false"}
                data-highlighted={hovered === option.value ? "true" : "false"}
                disabled={disabled}
                onMouseEnter={() => setHovered(option.value)}
                onMouseLeave={() => setHovered((current) => (current === option.value ? null : current))}
                onClick={() => toggle(option.value)}
                data-testid={testId === undefined ? undefined : `${testId}-option`}
                data-value={option.value}
              >
                <span className="myne-select-option__check" aria-hidden="true">
                  {isSelected && <Icon name="check" size={14} />}
                </span>
                <span className="myne-select-option__label">{option.label}</span>
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
