// `<DiffView>` — the one renderer for a `@myne/dialect` diff (MYND-334).
//
// The line-and-word diff itself is computed in the shared core (`dialect/src/
// diff.ts`); this component only paints it. It was pulled out of
// `<SnapshotsPanel>`, which had the `<pre>` inline, so the snapshot preview and
// the conflict compare surface render the same diff the same way instead of
// growing two lookalikes.
//
// Two modes over the same line/segment input: `unified` (one column, `+`/`−`
// gutter markers) for the snapshot preview, and `split` (two aligned columns)
// for the conflict compare surface, where "which side is this?" is the whole
// question and a gutter marker is a worse answer than a column.
//
// Word-level segments are what keep a one-word edit from reading as a whole
// replaced line: on a refined line the unchanged words stay muted and only the
// moved run is marked. Presentational and pure — no IPC, no i18n (it renders
// note text, not copy), no diff computation of its own.
//
// Colour discipline (DESIGN.md "The One Accent Rule"): additions carry the sole
// accent, removals are a neutral recess plus a strikethrough. A removed line is
// not an error, so brick-danger — reserved for phrase mismatch, sync error and
// irreversible-warning copy — stays out of this surface.

import { Fragment, type CSSProperties } from "react";
import type { DiffLine, DiffSegment } from "../../dialect";

/** Layout of the rendered diff: one annotated column, or two aligned ones. */
export type DiffViewMode = "unified" | "split";

const VIEW_STYLE: CSSProperties = {
  flex: 1,
  overflow: "auto",
  margin: 0,
  padding: "var(--space-3) var(--space-5)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const LINE_BASE: CSSProperties = { display: "block" };
const LINE_SAME_STYLE: CSSProperties = { ...LINE_BASE, color: "var(--fg-2)" };
const LINE_ADD_STYLE: CSSProperties = { ...LINE_BASE, color: "var(--accent)" };
const LINE_DEL_STYLE: CSSProperties = {
  ...LINE_BASE,
  color: "var(--fg-3)",
  textDecoration: "line-through",
};

// A refined line carries the emphasis on its segments, so the line itself drops
// to context colour and gives up the whole-line strikethrough.
const LINE_REFINED_STYLE: CSSProperties = { ...LINE_BASE, color: "var(--fg-3)" };

const SEGMENT_STYLE: Record<DiffSegment["type"], CSSProperties | undefined> = {
  same: undefined,
  add: {
    color: "var(--accent)",
    background: "var(--accent-soft)",
    borderRadius: 2,
  },
  del: {
    color: "var(--fg-2)",
    background: "var(--paper-3)",
    borderRadius: 2,
    textDecoration: "line-through",
  },
};

const MARKER: Record<DiffLine["type"], string> = {
  same: "  ",
  add: "+ ",
  del: "− ",
};

export type DiffViewProps = {
  /** Diff to paint, from `diffWithSegments` (or `lineDiff` for line-only). */
  diff: DiffLine[];
  mode?: DiffViewMode;
  /** Merged over the base style — the host owns sizing, not this component. */
  style?: CSSProperties;
  /** Accessible name for the scroll region, when the host has one to give. */
  label?: string;
  /** `split` only: heading over the old (left) column. Copy comes from the
   *  host — this component renders note text, never strings of its own. */
  leftLabel?: string;
  /** `split` only: heading over the new (right) column. */
  rightLabel?: string;
};

export function DiffView({
  diff,
  mode = "unified",
  style,
  label,
  leftLabel,
  rightLabel,
}: DiffViewProps) {
  if (mode === "split") {
    return (
      <SplitDiff
        diff={diff}
        style={style}
        label={label}
        leftLabel={leftLabel}
        rightLabel={rightLabel}
      />
    );
  }
  return (
    <pre
      style={style ? { ...VIEW_STYLE, ...style } : VIEW_STYLE}
      data-testid="diff.view"
      data-mode={mode}
      aria-label={label}
    >
      {diff.map((line, idx) => (
        <DiffLineRow key={idx} line={line} index={idx} />
      ))}
    </pre>
  );
}

function DiffLineRow({ line, index }: { line: DiffLine; index: number }) {
  // `same` lines have no `segments` property at all; add/del lines have it only
  // when the word pass refined them (it skips empty, over-cap and unpaired
  // lines, and the whole coarse fallback), so both checks are load-bearing.
  const segments = "segments" in line ? line.segments : undefined;
  const refined = segments !== undefined;

  return (
    <span
      style={
        refined
          ? LINE_REFINED_STYLE
          : line.type === "add"
            ? LINE_ADD_STYLE
            : line.type === "del"
              ? LINE_DEL_STYLE
              : LINE_SAME_STYLE
      }
      data-testid="diff.line"
      data-type={line.type}
      data-index={index}
    >
      <span aria-hidden="true">{MARKER[line.type]}</span>
      {segments === undefined ? line.text : <Segments segments={segments} />}
    </span>
  );
}

function Segments({ segments }: { segments: DiffSegment[] }) {
  return (
    <>
      {segments.map((seg, i) => (
        <span
          key={i}
          style={SEGMENT_STYLE[seg.type]}
          data-testid="diff.segment"
          data-type={seg.type}
        >
          {seg.text}
        </span>
      ))}
    </>
  );
}

// --- split mode --------------------------------------------------------------

const SPLIT_ROOT_STYLE: CSSProperties = {
  flex: 1,
  overflow: "auto",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  lineHeight: 1.5,
};

const SPLIT_GRID_STYLE: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  alignItems: "stretch",
};

const COLUMN_LABEL_STYLE: CSSProperties = {
  position: "sticky",
  top: 0,
  padding: "var(--space-2) var(--space-3)",
  background: "var(--bg-2)",
  borderBottom: "1px solid var(--line-1)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--text-sm)",
  color: "var(--fg-3)",
};

const CELL_BASE: CSSProperties = {
  padding: "0 var(--space-3)",
  // An empty line still has to hold its row open, or the two columns drift out
  // of alignment exactly where a blank line was added.
  minHeight: "1.5em",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const RIGHT_EDGE: CSSProperties = { borderLeft: "1px solid var(--line-1)" };

const CELL_SAME_STYLE: CSSProperties = { ...CELL_BASE, color: "var(--fg-2)" };
const CELL_ADD_STYLE: CSSProperties = {
  ...CELL_BASE,
  color: "var(--accent)",
  background: "var(--accent-soft)",
};
const CELL_DEL_STYLE: CSSProperties = {
  ...CELL_BASE,
  color: "var(--fg-2)",
  background: "var(--paper-3)",
  textDecoration: "line-through",
};
// Refined cells hand the emphasis to their segments, same as unified mode.
const CELL_REFINED_STYLE: CSSProperties = { ...CELL_BASE, color: "var(--fg-3)" };
// The other side has no counterpart line here — a neutral gap, not a change.
const CELL_EMPTY_STYLE: CSSProperties = { ...CELL_BASE, background: "var(--paper-2)" };

type SplitRow = { left: DiffLine | null; right: DiffLine | null };

/**
 * Fold the one-column diff into aligned rows. `same` lines occupy both sides of
 * their row; within a run of dels immediately followed by a run of adds the
 * k-th del faces the k-th add — the same pairing the word pass used to compute
 * their segments, so a refined pair always lands side by side. The surplus on
 * either side faces an empty cell.
 */
function toSplitRows(diff: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < diff.length) {
    const line = diff[i];
    if (line.type === "same") {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }
    let delEnd = i;
    while (delEnd < diff.length && diff[delEnd].type === "del") delEnd++;
    let addEnd = delEnd;
    while (addEnd < diff.length && diff[addEnd].type === "add") addEnd++;

    const dels = diff.slice(i, delEnd);
    const adds = diff.slice(delEnd, addEnd);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    }
    i = addEnd;
  }
  return rows;
}

function SplitDiff({
  diff,
  style,
  label,
  leftLabel,
  rightLabel,
}: Omit<DiffViewProps, "mode">) {
  const rows = toSplitRows(diff);
  const labelled = leftLabel !== undefined || rightLabel !== undefined;
  return (
    <div
      style={style ? { ...SPLIT_ROOT_STYLE, ...style } : SPLIT_ROOT_STYLE}
      data-testid="diff.view"
      data-mode="split"
      aria-label={label}
    >
      <div style={SPLIT_GRID_STYLE} data-testid="diff.split">
        {labelled && (
          <>
            <div style={COLUMN_LABEL_STYLE} data-testid="diff.column-label" data-side="left">
              {leftLabel}
            </div>
            <div
              style={{ ...COLUMN_LABEL_STYLE, ...RIGHT_EDGE }}
              data-testid="diff.column-label"
              data-side="right"
            >
              {rightLabel}
            </div>
          </>
        )}
        {rows.map((row, idx) => (
          <Fragment key={idx}>
            <SplitCell line={row.left} index={idx} side="left" />
            <SplitCell line={row.right} index={idx} side="right" />
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function SplitCell({
  line,
  index,
  side,
}: {
  line: DiffLine | null;
  index: number;
  side: "left" | "right";
}) {
  const segments = line !== null && "segments" in line ? line.segments : undefined;
  const base =
    line === null
      ? CELL_EMPTY_STYLE
      : segments !== undefined
        ? CELL_REFINED_STYLE
        : line.type === "add"
          ? CELL_ADD_STYLE
          : line.type === "del"
            ? CELL_DEL_STYLE
            : CELL_SAME_STYLE;

  return (
    <div
      style={side === "right" ? { ...base, ...RIGHT_EDGE } : base}
      data-testid="diff.line"
      data-type={line === null ? "empty" : line.type}
      data-side={side}
      data-index={index}
    >
      {line === null ? null : segments === undefined ? line.text : <Segments segments={segments} />}
    </div>
  );
}
