// `<ColorSwatchPicker>` — a row of colour swatches a user picks one of.
//
// Extracted when the calendar's colour map needed the picker the graph's
// colour-group rules already had (myne-md/myne#1037). The two call sites store
// the same thing (a bare `--group-*` token NAME) and drew the same control, so a
// second copy would be the "two pickers disagree about what the first colour
// means" failure the palette list itself was extracted to prevent.
//
// **It paints with `var(--<token>)`, never with a literal.** The caller passes
// token names, and a name the theme does not define falls back to the neutral
// surface rather than painting nothing, so a theme that drops a token degrades
// instead of leaving an invisible control.
//
// **The selection ring goes on the PAINT, not the hit box** — a ring around the
// larger invisible target floats unattached from the dot it marks. That is the
// colour-group editor's own finding, kept here so both surfaces read identically.
//
// Accessibility: a `radiogroup`-shaped control would need arrow-key roving; the
// buttons carry `aria-pressed` instead, which is what a toggle-shaped swatch row
// is (a user may click the selected one again and nothing changes). The label is
// the swatch's own colour name, so the control is reachable and announced as
// "Olive, pressed" rather than as an unlabelled dot.

import { type CSSProperties } from "react";
import { colorGroupVar } from "../../notes/graphColorGroups";
import { Tooltip } from "./Tooltip";

export interface ColorSwatchPickerProps {
  /** The palette, in display order. Each `key` is a design-token name. */
  palette: ReadonlyArray<{ key: string; label: string }>;
  /** The selected token name, or `null` when nothing is chosen yet. */
  value: string | null;
  /** Called with the chosen token name. */
  onChange: (key: string) => void;
  /** `data-testid` on every swatch, so a scenario can count and click them. */
  testId?: string;
}

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-1)",
  flexWrap: "wrap",
};

// The hit box is deliberately larger than the paint: a 24px target is the
// smallest the tree accepts for a pointer, and the dot inside it stays 12px so
// eight swatches read as one control rather than as eight buttons.
const HIT_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: "var(--target-min)",
  height: "var(--target-min)",
  padding: 0,
  border: "none",
  background: "transparent",
  cursor: "pointer",
  borderRadius: "var(--radius-pill)",
};

function paintStyle(key: string, selected: boolean): CSSProperties {
  return {
    width: "var(--space-3)",
    height: "var(--space-3)",
    borderRadius: "var(--radius-pill)",
    // One expression, from the module that owns "a stored token name becomes a CSS
    // value with a fallback": a second copy here had a different fallback token and no
    // shape check, so a token a theme drops painted two colours in two places.
    background: colorGroupVar(key),
    boxShadow: selected ? "0 0 0 2px var(--accent)" : "none",
  };
}

export function ColorSwatchPicker({
  palette,
  value,
  onChange,
  testId,
}: ColorSwatchPickerProps) {
  return (
    <div style={ROW_STYLE} role="group">
      {palette.map((entry) => {
        const selected = entry.key === value;
        return (
          <Tooltip key={entry.key} label={entry.label}>
            <button
              type="button"
              aria-label={entry.label}
              aria-pressed={selected}
              data-testid={testId}
              data-color-key={entry.key}
              onClick={() => onChange(entry.key)}
              style={HIT_STYLE}
            >
              <span style={paintStyle(entry.key, selected)} />
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
