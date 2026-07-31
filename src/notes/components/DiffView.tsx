// `<DiffView>` — the one renderer for a `@myne/dialect` diff (MYND-334).
//
// The line-and-word diff itself is computed in the shared core (`dialect/src/
// diff.ts`); this component only paints it. It was pulled out of
// `<SnapshotsPanel>`, which had the `<pre>` inline, so the snapshot preview and
// the conflict compare surface render the same diff the same way instead of
// growing two lookalikes.
//
// `unified` is the only mode today (one column, `+`/`−` gutter markers); the
// conflict surface adds `split` on top of the same line/segment input.
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

import type { CSSProperties } from "react";
import type { DiffLine, DiffSegment } from "../../dialect";

/** Layout of the rendered diff. `split` arrives with the conflict surface. */
export type DiffViewMode = "unified";

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
};

export function DiffView({ diff, mode = "unified", style, label }: DiffViewProps) {
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
      {segments === undefined
        ? line.text
        : segments.map((seg, i) => (
            <span
              key={i}
              style={SEGMENT_STYLE[seg.type]}
              data-testid="diff.segment"
              data-type={seg.type}
            >
              {seg.text}
            </span>
          ))}
    </span>
  );
}
