// SPDX-License-Identifier: AGPL-3.0
// The 24-cell recovery-phrase ENTRY grid, shared by every surface that takes a
// phrase: device enrolment, vault recovery, vault import, whole-vault migration,
// the B2B member-vault unlock, the person-identity unlock and the invite wizard.
//
// # One primitive, because the alternative was seven
//
// Seven surfaces each carried their own copy of this grid, and three of them
// cited the web phrase guard by name as the reason they could not share one
// (`MyneVaultSetup.tsx`, `web/vite.config.ts`, `recovery-flow.md` §3.2): that
// guard grepped the built artefact for one `data-testid` per phrase path, so a
// shared testid would have made two surfaces indistinguishable in the bundle.
// The guard and the rule behind it are gone (`decisions.md` 2026-10-18, entry
// 0704), so the copies collapse here.
//
// # The anatomy, and which of the two shapes it took
//
// It is the enrolment grid's: the cell number sits OUTSIDE the input, the track
// is `minmax(0, 1fr)` rather than `1fr` (myne-md/myne#764 — a `1fr` track is
// `minmax(auto, 1fr)`, and that `auto` floor is a text input's intrinsic width,
// which pushed the fourth column off the right edge of every surface that
// mounted the grid), and each cell carries `data-index` and its own
// `aria-label`.
//
// Three behaviours were ADDED while the copies were collapsed, because one of
// the two shapes had each of them and neither had all three:
//
//   - `dir="ltr"` on the grid. The ORDER of the words is part of the secret and
//     `recovery-flow.md` §2.4 commits to never showing them again, so a grid laid
//     out right-to-left under an RTL locale hands the user a transcription whose
//     wrongness is undiscoverable: BIP-39's checksum misses a permutation, so the
//     phrase simply fails to open the vault, months later, with nothing to
//     compare against. The DISPLAY grid has carried this since myne-md/myne#468;
//     the entry grid did not.
//   - A visible focus ring on the focused cell. `PhraseEntryStep` drew one and
//     the enrolment grid did not (`outline: "none"` with nothing behind it), so
//     collapsing onto either shape alone would have lost it for one surface or
//     the other.
//   - `columns`, so the narrower mobile sheets can ask for 2 or 3.
//
// # What stays in the caller
//
// State, normalisation, submission, and paste-to-distribute's cell arithmetic.
// This module renders cells and reports events. `recovery-flow.md` §3.2's
// no-per-cell-validity rule is enforced structurally rather than by discipline:
// there is nowhere in this file to put a verdict about a cell's contents.

import { useState, type ChangeEvent, type ClipboardEvent, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

// The one definition lives in `lib/bip39-normalize.ts`, next to the
// normalization the count is paired with. Re-exported here rather than
// redeclared, because a re-export is the same binding and cannot drift, while
// the five hand-written copies this replaces could and did.
export { PHRASE_CELL_COUNT } from "../lib/phrase-cells";

const FIELD: CSSProperties = { display: "flex", flexDirection: "column", gap: "var(--space-2)" };
const LABEL: CSSProperties = { fontSize: "var(--text-sm)", color: "var(--fg-2)" };
const HINT: CSSProperties = { fontSize: "var(--text-xs)", color: "var(--fg-3)", margin: 0 };
const CELL_WRAP: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-1)",
  minWidth: 0,
  border: "1px solid transparent",
  borderRadius: "var(--radius-1)",
};
const CELL_WRAP_FOCUSED: CSSProperties = {
  ...CELL_WRAP,
  border: "1px solid var(--accent)",
};
const CELL_NUMBER: CSSProperties = {
  fontSize: "var(--text-xs)",
  color: "var(--fg-3)",
  width: "1.4em",
  textAlign: "end",
  fontFamily: "var(--font-mono)",
};
const CELL_INPUT: CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "var(--bg-1)",
  color: "var(--fg-1)",
  border: "1px solid var(--line-1)",
  borderRadius: "var(--radius-1)",
  padding: "var(--space-1) var(--space-2)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  outline: "none",
};

export interface PhraseEntryGridProps {
  /** Prefix for the generated cell ids, so two grids on one page do not collide. */
  baseId: string;
  /** The words, already split. How many there are is the caller's business. */
  cells: readonly string[];
  onCellChange: (index: number) => (e: ChangeEvent<HTMLInputElement>) => void;
  onCellPaste: (index: number) => (e: ClipboardEvent<HTMLInputElement>) => void;
  /** Words per row. 4 on the desktop card; a mobile sheet asks for 2 or 3. */
  columns?: number;
  /** How many cells to render. 24 unless a caller says otherwise. */
  cellCount?: number;
  /** Heading above the grid. Omitted when a caller supplies its own. */
  label?: string;
  /** Line under the heading. Omitted when a caller supplies its own. */
  hint?: string;
  disabled?: boolean;
  /** Exact grid testid. Defaults to the enrolment grid's. */
  gridTestId?: string;
  /** Per-cell testid. Defaults to the enrolment grid's. */
  cellTestId?: (index: number) => string;
  /** Per-cell accessible name. Defaults to the enrolment grid's wording. */
  cellAriaLabel?: (index: number) => string;
}

/**
 * The grid only, and it is DOM-shape rather than logic: the caller owns `cells`,
 * normalisation and submission, so the two clients can feed it from a reducer, a
 * `useState` and a form respectively without this module learning about any of
 * them.
 *
 * No per-cell validity styling, exactly as `recovery-flow.md` §3.2 requires of
 * every phrase grid: a green/red hint would leak one bit of BIP-39 membership
 * per word to anyone looking at the screen. The only state this file draws is
 * FOCUS, which is a property of the caret rather than of the word.
 */
export function PhraseEntryGrid({
  baseId,
  cells,
  onCellChange,
  onCellPaste,
  columns = 4,
  cellCount = 24,
  label,
  hint,
  disabled = false,
  gridTestId = "sync.enroll.phrase-grid",
  cellTestId = () => "sync.enroll.phrase-cell",
  cellAriaLabel,
}: PhraseEntryGridProps) {
  const { t } = useTranslation();
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const labelId = `${baseId}-label`;
  const hintId = `${baseId}-hint`;
  const ariaFor = cellAriaLabel ?? ((i: number) => t("sync.enroll.wordAria", { number: i + 1 }));

  return (
    <div style={FIELD}>
      {label !== undefined && (
        <span id={labelId} style={LABEL}>
          {label}
        </span>
      )}
      {hint !== undefined && (
        <p id={hintId} style={HINT}>
          {hint}
        </p>
      )}
      <div
        dir="ltr"
        style={{
          display: "grid",
          // `minmax(0, 1fr)` and not `1fr`, for the reason the header records.
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gap: "var(--space-2)",
        }}
        data-testid={gridTestId}
        aria-labelledby={label !== undefined ? labelId : undefined}
      >
        {Array.from({ length: cellCount }, (_, i) => {
          const inputId = `${baseId}-cell-${i}`;
          const focused = focusedIndex === i;
          return (
            <label key={i} htmlFor={inputId} style={focused ? CELL_WRAP_FOCUSED : CELL_WRAP}>
              <span style={CELL_NUMBER}>{i + 1}</span>
              {/* A raw `<input>` rather than the `<Input>` primitive, deliberately,
                  and this comment is what `check-primitive-adoption.mjs` asks for at
                  such a call site: the cell is not a labelled field, it is one of 24
                  boxes in a grid where the primitive's own label slot, padding,
                  radius and focus ring would all have to be overridden away. The
                  same reasoning `PhraseGrid`'s reveal button carries for its raw
                  `<button>`. */}
              <input
                id={inputId}
                type="text"
                value={cells[i] ?? ""}
                onChange={onCellChange(i)}
                onPaste={onCellPaste(i)}
                onFocus={() => setFocusedIndex(i)}
                onBlur={() => setFocusedIndex((cur) => (cur === i ? null : cur))}
                disabled={disabled}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                inputMode="text"
                style={CELL_INPUT}
                aria-label={ariaFor(i)}
                aria-describedby={hint !== undefined ? hintId : undefined}
                data-testid={cellTestId(i)}
                data-index={i + 1}
              />
            </label>
          );
        })}
      </div>
    </div>
  );
}
